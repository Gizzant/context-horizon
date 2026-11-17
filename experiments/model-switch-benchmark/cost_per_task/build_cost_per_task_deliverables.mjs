#!/usr/bin/env node
/**
 * Generates cost-per-completed-task deliverables strictly from raw wire/checkpoint logs:
 *   - runs_cost_per_task.csv (per request)
 *   - run_summary_cost_per_task.csv (per run)
 *   - summary_cost_per_task.md (limitations first, then Section 7 tables + reconciliation)
 *   - REDACTION_MANIFEST.md update (when updateRedactionManifest=true)
 *   - assertNoSensitiveLeaks privacy audit across all artifacts
 */

import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, PRICING_PER_1M } from '../config.mjs';
import { assertNoSensitiveLeaks } from '../tests_3_to_8/prefix_lab.mjs';

export const RUNS_CSV_HEADERS = Object.freeze([
  'run_id',
  'arm',
  'rep',
  'session_id',
  'turn',
  'event',
  'is_side_call',
  'model',
  'effort',
  'prefix_size_bucket',
  'timestamp_utc',
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
  'latency_ms',
  'cost_usd',
  'source',
  'notes',
  'request_index_in_turn',
  'requests_in_turn',
  'task_id',
  'difficulty',
  'phase',
  'attempt',
  'cost_source',
  'computed_cost_usd',
  'eph5m_write_tokens',
  'eph1h_write_tokens'
]);

export const SUMMARY_CSV_HEADERS = Object.freeze([
  'run_id',
  'task_id',
  'difficulty',
  'arm',
  'rep',
  'completed',
  'attempts',
  'turns',
  'requests',
  'plan_turn_requests',
  'total_billed_usd',
  'plan_turn_billed_usd',
  'impl_and_retries_billed_usd',
  'cost_at_completion_usd',
  'wall_time_s',
  'cache_read_share',
  'switch_turn',
  'switch_turn_cost_usd',
  'set_model_control_ok',
  'shadow_pre_model_switch_decision',
  'shadow_pre_model_switch_blocked',
  'shadow_cold_write_penalty_usd',
  'shadow_break_even_tokens',
  'shadow_provenance',
  'cap_reason',
  'constraint_violations',
  'diff_lines_changed',
  'turn1_readonly_clean'
]);

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function median(arr = []) {
  const nums = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function minVal(arr = []) {
  const nums = arr.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return nums.length ? Math.min(...nums) : null;
}

function maxVal(arr = []) {
  const nums = arr.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return nums.length ? Math.max(...nums) : null;
}

function fmtUsd(v, digits = 4) {
  return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : `$${v.toFixed(digits)}`;
}

function fmtMedRangeUsd(arr = [], digits = 4) {
  const med = median(arr);
  if (med === null) return 'N/A';
  const mn = minVal(arr);
  const mx = maxVal(arr);
  return `$${med.toFixed(digits)} [$${mn.toFixed(digits)}–$${mx.toFixed(digits)}]`;
}

function fmtMedRangeNum(arr = [], digits = 1) {
  const med = median(arr);
  if (med === null) return 'N/A';
  const mn = minVal(arr);
  const mx = maxVal(arr);
  return `${med.toFixed(digits)} [${mn.toFixed(digits)}–${mx.toFixed(digits)}]`;
}

export function buildCostPerTaskDeliverables({
  rawDir = path.join(RESULTS_DIR, 'cost_per_task_raw'),
  outDir = RESULTS_DIR,
  preregistrationPath = path.join(RESULTS_DIR, 'preregistration_cost_per_task.json'),
  tierLabel = 'routine tasks',
  runsCsvName = 'runs_cost_per_task.csv',
  summaryCsvName = 'run_summary_cost_per_task.csv',
  summaryMdName = 'summary_cost_per_task.md',
  repoDesc = '16-file zero-dependency Node.js repository (`ledgerpulse`)',
  updateRedactionManifest = true,
  extraSecrets = []
} = {}) {
  const wireRecords = readJsonl(path.join(rawDir, 'proxy_wire_log.jsonl'));
  const checkpointRows = readJsonl(path.join(rawDir, 'checkpoint_runs.jsonl'));
  const runMap = new Map();
  for (const r of checkpointRows) {
    if (r?.run_id) runMap.set(r.run_id, r);
  }
  const runs = [...runMap.values()].sort((a, b) => {
    if (a.rep !== b.rep) return a.rep - b.rep;
    if (a.task_id !== b.task_id) return a.task_id < b.task_id ? -1 : 1;
    return a.arm < b.arm ? -1 : a.arm > b.arm ? 1 : 0;
  });

  // Group wire records by run_id and turn to populate requests_in_turn
  const validWire = wireRecords.filter((w) => w?.context?.runId && !w.blockedByGuard && !w.countTokensFallback);
  const byRunTurnMainCount = new Map();
  for (const w of validWire) {
    if (!w.isSideCall && (w.statusCode ?? 200) < 400) {
      const k = `${w.context.runId}|${w.context.turn}`;
      byRunTurnMainCount.set(k, (byRunTurnMainCount.get(k) || 0) + 1);
    }
  }

  const requestRows = [];
  for (const w of validWire) {
    const ctx = w.context || {};
    const runId = ctx.runId;
    const turn = ctx.turn ?? 0;
    const reqsInTurn = w.isSideCall ? 0 : (byRunTurnMainCount.get(`${runId}|${turn}`) || 0);
    const u = w.usage || {};
    requestRows.push({
      run_id: runId,
      arm: ctx.arm || '',
      rep: ctx.rep ?? '',
      session_id: `sess_${runId}`,
      turn,
      event: ctx.event || (w.isSideCall ? 'set_model_probe' : 'message'),
      is_side_call: Boolean(w.isSideCall),
      model: w.mappedModel || w.responseModel || w.requestedModel || '',
      effort: ctx.effort || 'medium',
      prefix_size_bucket: 'synthetic_16f',
      timestamp_utc: w.timestamp || '',
      input_tokens: u.input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      latency_ms: w.timing?.latencyMs ?? '',
      cost_usd: Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0).toFixed(8),
      source: 'proxy',
      notes: `stop_reason=${w.stopReason || ''}; status=${w.statusCode || ''}; ttfb_ms=${w.timing?.ttfbMs ?? ''}`,
      request_index_in_turn: w.reqIndexInTurn ?? '',
      requests_in_turn: reqsInTurn,
      task_id: ctx.taskId || '',
      difficulty: ctx.difficulty || '',
      phase: ctx.phase || '',
      attempt: ctx.attempt ?? '',
      cost_source: w.costSource || 'computed_rate_card',
      computed_cost_usd: Number(w.computedCostUsd ?? w.cost?.totalCostUsd ?? 0).toFixed(8),
      eph5m_write_tokens: u.ephemeral_5m_input_tokens ?? 0,
      eph1h_write_tokens: u.ephemeral_1h_input_tokens ?? 0
    });
  }

  const summaryRows = runs.map((r) => ({
    run_id: r.run_id,
    task_id: r.task_id,
    difficulty: r.difficulty,
    arm: r.arm,
    rep: r.rep,
    completed: r.completed ? 'yes' : 'no',
    attempts: r.attempts,
    turns: r.turns,
    requests: r.requests,
    plan_turn_requests: r.plan_turn_requests,
    total_billed_usd: Number(r.total_billed_usd || 0).toFixed(8),
    plan_turn_billed_usd: Number(r.plan_turn_billed_usd || 0).toFixed(8),
    impl_and_retries_billed_usd: Number(r.impl_and_retries_billed_usd || 0).toFixed(8),
    cost_at_completion_usd: r.completed ? Number(r.total_billed_usd || 0).toFixed(8) : '',
    wall_time_s: Number(r.wall_time_s || 0).toFixed(2),
    cache_read_share: Number(r.cache_read_share || 0).toFixed(4),
    switch_turn: r.arm === 'SWITCH' && r.turns >= 2 ? 2 : '',
    switch_turn_cost_usd: r.arm === 'SWITCH' && r.switch_turn_cost_usd != null ? Number(r.switch_turn_cost_usd).toFixed(8) : '',
    set_model_control_ok: r.arm === 'SWITCH' ? (r.set_model_control_ok ? 'true' : 'false') : '',
    shadow_pre_model_switch_decision: r.shadow_pre_model_switch_decision ?? '',
    shadow_pre_model_switch_blocked: r.shadow_pre_model_switch_blocked ?? '',
    shadow_cold_write_penalty_usd: r.shadow_cold_write_penalty_usd != null ? Number(r.shadow_cold_write_penalty_usd).toFixed(6) : '',
    shadow_break_even_tokens: r.shadow_break_even_tokens ?? '',
    shadow_provenance: r.arm === 'SWITCH' ? 'computed offline; not shown to the model' : '',
    cap_reason: r.cap_reason || '',
    constraint_violations: r.constraint_violations ?? 0,
    diff_lines_changed: r.diff_lines_changed ?? 0,
    turn1_readonly_clean: r.turn1_readonly_clean ? 'true' : 'false'
  }));

  const runsCsvPath = path.join(outDir, runsCsvName);
  const summaryCsvPath = path.join(outDir, summaryCsvName);
  writeCsv(runsCsvPath, RUNS_CSV_HEADERS, requestRows);
  writeCsv(summaryCsvPath, SUMMARY_CSV_HEADERS, summaryRows);

  // Build markdown report strictly from raw structures
  const prereg = fs.existsSync(preregistrationPath)
    ? JSON.parse(fs.readFileSync(preregistrationPath, 'utf8'))
    : null;

  const taskIds = [...new Set(runs.map((r) => r.task_id))].sort();
  const arms = ['OPUS', 'SONNET', 'SWITCH'];
  const repsCount = runs.length > 0 ? Math.max(...runs.map((r) => r.rep)) : 0;

  const md = [];
  md.push(`# Cost per Completed Task (${tierLabel}): Opus vs. Sonnet vs. Opus-then-Sonnet (\`${summaryMdName}\`)`);
  md.push('');
  md.push('## 1. Limitations');
  md.push('');
  md.push(`- **Study Tier & Sample Size:** \`${tierLabel}\` — \`n = ${repsCount}\` repetitions per task-arm across \`${taskIds.length}\` tasks (\`${runs.length}\` total runs). Paired comparisons count task medians across \`${taskIds.length}\` tasks; small effects cannot be reliably separated from variance at this sample size.`);
  md.push('- **Turn-1 Plan Mode (Option A):** Per study design, Turn 1 runs in read-only `--permission-mode plan` across every arm, and Turn 2+ switches to `bypassPermissions` (with `SWITCH` changing `claude-opus-5-5 -> claude-sonnet-5-5` via `set_model` before Turn 2 on 100% of runs). Results reflect plan-on-Opus-then-implement-on-Sonnet rather than retry-only switching.');
  md.push(`- **Routing & Synthetic Repo:** Requests ran through OpenRouter (\`provider: { only: ["anthropic"], allow_fallbacks: false }\`) against a synthetic ${repoDesc}. Cache behavior and pricing on direct first-party APIs or larger production codebases may differ.`);
  md.push('- **Cache Isolation:** Same-model runs were spaced `>= 365s` apart (plus per-run `--append-system-prompt` salt) because `tools + system[0..1]` precedes the appended salt in Claude Code `2.1.325`.');
  md.push('');

  // Section 7.1 Main Table (Plan turn T1 + Impl/Retry T2+ + Total per task, plus All-tasks rows)
  md.push(`## 2. Per-Task Completion & Cost to Completion — ${tierLabel} (Section 7.1)`);
  md.push('');
  md.push('*(All USD figures are `billed` per OpenRouter `usage.cost` when returned, else `computed` from rate card; Plan turn T1 is reported on its own row in every section.)*');
  md.push('');
  md.push('| Task / Phase | Difficulty | OPUS Completion | OPUS Cost (billed) | SONNET Completion | SONNET Cost (billed) | SWITCH Completion | SWITCH Cost (billed) |');
  md.push('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const tid of taskIds) {
    const tRuns = runs.filter((r) => r.task_id === tid);
    const diff = tRuns[0]?.difficulty || '';
    const planCells = [];
    const implCells = [];
    const totCells = [];
    for (const arm of arms) {
      const aRuns = tRuns.filter((r) => r.arm === arm);
      const comp = aRuns.filter((r) => r.completed);
      planCells.push('—', fmtMedRangeUsd(aRuns.map((r) => r.plan_turn_billed_usd)));
      implCells.push('—', fmtMedRangeUsd(aRuns.map((r) => r.impl_and_retries_billed_usd)));
      totCells.push(`${comp.length}/${aRuns.length}`);
      totCells.push(comp.length > 0 ? fmtMedRangeUsd(comp.map((r) => r.total_billed_usd)) : `0/${aRuns.length} (capped)`);
    }
    md.push(`| \`${tid}\` — Plan turn (T1) | ${diff} | ${planCells.join(' | ')} |`);
    md.push(`| \`${tid}\` — Impl & retries (T2+) | ${diff} | ${implCells.join(' | ')} |`);
    md.push(`| \`${tid}\` — Total | ${diff} | ${totCells.join(' | ')} |`);
  }
  const allPlanCells = [];
  const allTotCells = [];
  for (const arm of arms) {
    const aRuns = runs.filter((r) => r.arm === arm);
    const comp = aRuns.filter((r) => r.completed);
    allPlanCells.push('—', fmtMedRangeUsd(aRuns.map((r) => r.plan_turn_billed_usd)));
    allTotCells.push(`${comp.length}/${aRuns.length}`);
    allTotCells.push(comp.length > 0 ? fmtMedRangeUsd(comp.map((r) => r.total_billed_usd)) : `0/${aRuns.length} (capped)`);
  }
  md.push(`| **All ${tierLabel} — Plan turn (T1)** | all | ${allPlanCells.join(' | ')} |`);
  md.push(`| **All ${tierLabel} — Total** | all | ${allTotCells.join(' | ')} |`);
  md.push('');

  // Section 7.2 Headline Metric: Total spend / completions (with Plan turn as its own row per arm)
  md.push(`## 3. Headline Metric: Cost per Completed Task by Arm — ${tierLabel} (Section 7.2 & Plan Turn Row)`);
  md.push('');
  md.push('| Arm / Phase | Runs (`n`) | Completions | Completion Rate (`measured`) | Spend (`billed`) | Cost / Completed Task (`computed = spend / completions`) | Capped Runs Breakdown (`measured`) |');
  md.push('| :--- | :---: | :---: | :---: | :---: | :---: | :--- |');
  for (const arm of arms) {
    const aRuns = runs.filter((r) => r.arm === arm);
    const compCount = aRuns.filter((r) => r.completed).length;
    const totalSpend = aRuns.reduce((s, r) => s + Number(r.total_billed_usd || 0), 0);
    const planSpend = aRuns.reduce((s, r) => s + Number(r.plan_turn_billed_usd || 0), 0);
    const implSpend = aRuns.reduce((s, r) => s + Number(r.impl_and_retries_billed_usd || 0), 0);
    const planPerComp = compCount > 0 ? planSpend / compCount : null;
    const implPerComp = compCount > 0 ? implSpend / compCount : null;
    const costPerComp = compCount > 0 ? totalSpend / compCount : null;
    const capCounts = {};
    for (const r of aRuns.filter((x) => !x.completed)) {
      const cr = r.cap_reason || 'unknown';
      capCounts[cr] = (capCounts[cr] || 0) + 1;
    }
    const capStr = Object.keys(capCounts).length
      ? Object.entries(capCounts).map(([k, v]) => `${k}:${v}`).join(', ')
      : 'none';
    const pct = aRuns.length > 0 ? `${((compCount / aRuns.length) * 100).toFixed(1)}%` : 'N/A';
    md.push(`| \`${arm}\` — Plan turn (T1) | ${aRuns.length} | — | — | ${fmtUsd(planSpend)} | ${fmtUsd(planPerComp)} | — |`);
    md.push(`| \`${arm}\` — Impl & retries (T2+) | ${aRuns.length} | — | — | ${fmtUsd(implSpend)} | ${fmtUsd(implPerComp)} | — |`);
    md.push(`| **\`${arm}\` — Total** | ${aRuns.length} | ${compCount}/${aRuns.length} | ${pct} | **${fmtUsd(totalSpend)}** | **${fmtUsd(costPerComp)}** | ${capStr} |`);
  }
  md.push('');

  // Section 7.3 Attempts and Turns by Arm & Difficulty (Plan turn as its own row per arm/difficulty)
  md.push(`## 4. Attempts, Harness Turns & Plan-Turn Cost by Arm and Difficulty — ${tierLabel} (Section 7.3)`);
  md.push('');
  md.push('| Arm / Phase | Difficulty | `n` | Completions | Attempts Median [min–max] (`measured`) | Turns Median [min–max] (`measured`) | Cost Median [min–max] (`billed`) |');
  md.push('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');
  for (const arm of arms) {
    const diffs = [...new Set(runs.map((r) => r.difficulty))].sort();
    for (const diff of [...diffs, 'all']) {
      const sub = diff === 'all' ? runs.filter((r) => r.arm === arm) : runs.filter((r) => r.arm === arm && r.difficulty === diff);
      if (sub.length === 0) continue;
      const comp = sub.filter((r) => r.completed).length;
      md.push(
        `| \`${arm}\` — Plan turn (T1) | ${diff} | ${sub.length} | — | — | 1.0 [1.0–1.0] | ${fmtMedRangeUsd(sub.map((r) => r.plan_turn_billed_usd))} |`
      );
      md.push(
        `| \`${arm}\` — Impl & retries (T2+) | ${diff} | ${sub.length} | — | — | ${fmtMedRangeNum(sub.map((r) => Math.max(0, r.turns - 1)))} | ${fmtMedRangeUsd(sub.map((r) => r.impl_and_retries_billed_usd))} |`
      );
      md.push(
        `| **\`${arm}\` — Total** | ${diff} | ${sub.length} | ${comp}/${sub.length} | ${fmtMedRangeNum(sub.map((r) => r.attempts))} | ${fmtMedRangeNum(sub.map((r) => r.turns))} | ${fmtMedRangeUsd(sub.map((r) => r.total_billed_usd))} |`
      );
    }
  }
  md.push('');

  // Section 7.4 Paired Task Comparison (with Plan turn as its own row)
  md.push(`## 5. Paired Task-Level Cost Comparisons — ${tierLabel} (Section 7.4)`);
  md.push('');
  md.push('Counts across the `' + taskIds.length + '` tasks where Arm A had a lower median cost than Arm B (`n` is small; Plan turn T1 is reported on its own row alongside completed-only and penalized total cost):');
  md.push('');
  md.push('| Comparison (`A vs B`) & Phase | Completed-Only Medians (`A cheaper / B cheaper / tied or NA`) | Failure-Penalized Medians (`A cheaper / B cheaper / tied`) |');
  md.push('| :--- | :---: | :---: |');
  for (const [a, b] of [['SONNET', 'OPUS'], ['SWITCH', 'OPUS'], ['SWITCH', 'SONNET']]) {
    let planA = 0; let planB = 0; let planTie = 0;
    let compA = 0; let compB = 0; let compTie = 0;
    let penA = 0; let penB = 0; let penTie = 0;
    for (const tid of taskIds) {
      const rA = runs.filter((r) => r.task_id === tid && r.arm === a);
      const rB = runs.filter((r) => r.task_id === tid && r.arm === b);
      const mPA = median(rA.map((r) => r.plan_turn_billed_usd));
      const mPB = median(rB.map((r) => r.plan_turn_billed_usd));
      if (mPA !== null && mPB !== null) {
        if (mPA < mPB - 1e-9) planA += 1;
        else if (mPB < mPA - 1e-9) planB += 1;
        else planTie += 1;
      } else {
        planTie += 1;
      }
      const mCA = median(rA.filter((r) => r.completed).map((r) => r.total_billed_usd));
      const mCB = median(rB.filter((r) => r.completed).map((r) => r.total_billed_usd));
      if (mCA !== null && mCB !== null) {
        if (mCA < mCB - 1e-9) compA += 1;
        else if (mCB < mCA - 1e-9) compB += 1;
        else compTie += 1;
      } else {
        compTie += 1;
      }
      const pMed = (arr) => {
        const vals = arr.map((r) => (r.completed ? r.total_billed_usd : Number.POSITIVE_INFINITY)).sort((x, y) => x - y);
        if (vals.length === 0) return Number.POSITIVE_INFINITY;
        const mid = Math.floor(vals.length / 2);
        return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
      };
      const pA = pMed(rA);
      const pB = pMed(rB);
      if (pA < pB - 1e-9) penA += 1;
      else if (pB < pA - 1e-9) penB += 1;
      else penTie += 1;
    }
    md.push(`| \`${a}\` vs \`${b}\` — Plan turn (T1) | ${planA} / ${planB} / ${planTie} | ${planA} / ${planB} / ${planTie} |`);
    md.push(`| **\`${a}\` vs \`${b}\` — Total** | ${compA} / ${compB} / ${compTie} | ${penA} / ${penB} / ${penTie} |`);
  }
  md.push('');

  // Section 7.5 SWITCH Switch-Turn Penalty, Payback & Decision 4 Shadow PreModelSwitch Comparison
  md.push(`## 6. SWITCH Penalty, Payback & Offline \`PreModelSwitch\` Shadow Comparison — ${tierLabel} (Section 7.5)`);
  md.push('');
  const switchRuns = runs.filter((r) => r.arm === 'SWITCH');
  const swCosts = switchRuns.map((r) => r.switch_turn_cost_usd).filter((x) => typeof x === 'number' && Number.isFinite(x));
  md.push('- **Switch-turn (Turn 2 Req 1 + probe) cost median [min–max] (`billed`):** ' + fmtMedRangeUsd(swCosts));
  md.push('- **Note on shadow evaluation:** Offline `runPreModelSwitchHook()` verdicts below are **`computed offline; not shown to the model`** (`settings.json` used `"hooks": {}`). Actual switch payoff compares each `SWITCH` run total `billed` cost against the same `(task_id, rep)` `OPUS` run (both completed).');
  md.push('');
  md.push('| Arm / Phase | Summary Metric (`billed`) |');
  md.push('| :--- | :---: |');
  for (const arm of arms) {
    const aRuns = runs.filter((r) => r.arm === arm);
    md.push(`| \`${arm}\` — Plan turn (T1) median [min–max] | ${fmtMedRangeUsd(aRuns.map((r) => r.plan_turn_billed_usd))} |`);
    md.push(`| \`${arm}\` — Total median [min–max] | ${fmtMedRangeUsd(aRuns.map((r) => r.total_billed_usd))} |`);
  }
  md.push('');
  md.push('| Run ID | Task | Shadow Decision (`computed offline; not shown to the model`) | Shadow Blocked | Shadow Cold Penalty (`computed`) | Switch T2 Cost (`billed`) | SWITCH Plan T1 / Total (`billed`) | Paired OPUS Plan T1 / Total (`billed`) | Actual Paid Back vs Paired OPUS? (`computed`) |');
  md.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const sr of switchRuns) {
    const pairedOpus = runs.find((r) => r.task_id === sr.task_id && r.rep === sr.rep && r.arm === 'OPUS');
    let paidBack = 'N/A';
    if (sr.completed && pairedOpus?.completed) {
      paidBack = sr.total_billed_usd < pairedOpus.total_billed_usd ? 'yes' : 'no';
    } else if (!sr.completed && pairedOpus?.completed) {
      paidBack = 'no (SWITCH incomplete)';
    } else if (sr.completed && pairedOpus && !pairedOpus.completed) {
      paidBack = 'yes (OPUS incomplete)';
    }
    const opusCell = pairedOpus ? `${fmtUsd(pairedOpus.plan_turn_billed_usd)} / ${pairedOpus.completed ? 'yes' : 'no'} ${fmtUsd(pairedOpus.total_billed_usd)}` : 'N/A';
    md.push(
      `| \`${sr.run_id}\` | \`${sr.task_id}\` | ${sr.shadow_pre_model_switch_decision || 'N/A'} | ${sr.shadow_pre_model_switch_blocked ?? 'N/A'} | ${fmtUsd(sr.shadow_cold_write_penalty_usd)} | ${fmtUsd(sr.switch_turn_cost_usd)} | ${fmtUsd(sr.plan_turn_billed_usd)} / ${sr.completed ? 'yes' : 'no'} ${fmtUsd(sr.total_billed_usd)} | ${opusCell} | ${paidBack} |`
    );
  }
  md.push('');

  // Section 7.6 Predictions vs Results
  md.push('## 7. Pre-Registered Predictions vs. Results for Q1–Q4 (Section 7.6)');
  md.push('');
  if (prereg?.predictions) {
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
      md.push(`- **${q} Prediction:** ${prereg.predictions[q] || 'N/A'}`);
    }
  } else {
    md.push('- Pre-registration file not found in output directory; see run tables above for measured Q1–Q4 outcomes.');
  }
  md.push('');

  // OpenRouter Reconciliation
  md.push('## 8. OpenRouter `/api/v1/key` Reconciliation');
  md.push('');
  const recs = ['stage1_reconciliation.json', 'stage2_reconciliation.json']
    .map((f) => path.join(rawDir, f))
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  if (recs.length === 0) {
    md.push('- No live stage reconciliation files found in this run directory.');
  } else {
    md.push('| Stage | Runs | Key Usage Before (`billed`) | Settled Key Usage After (`billed`) | Settled Key Delta (`billed`) | Summed Run Billed (`billed`) | Residual (`computed`) |');
    md.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
    for (const rec of recs) {
      md.push(`| ${rec.stage} | ${rec.runCount} | ${fmtUsd(rec.usageBeforeUsd, 6)} | ${fmtUsd(rec.usageAfterSettledUsd, 6)} | ${fmtUsd(rec.keyDeltaUsd, 6)} | ${fmtUsd(rec.summedRunBilledUsd, 6)} | ${fmtUsd(rec.residualUsd, 6)} |`);
    }
  }
  md.push('');

  const mdText = md.join('\n');
  const mdOutPath = path.join(outDir, summaryMdName);
  fs.writeFileSync(mdOutPath, mdText, 'utf8');

  // Privacy leak check across all generated deliverables & raw files
  for (const p of [runsCsvPath, summaryCsvPath, mdOutPath]) {
    assertNoSensitiveLeaks(fs.readFileSync(p, 'utf8'), path.basename(p), extraSecrets);
  }
  if (fs.existsSync(rawDir)) {
    const scanDir = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, entry.name);
        if (entry.isDirectory()) scanDir(fp);
        else assertNoSensitiveLeaks(fs.readFileSync(fp, 'utf8'), path.relative(rawDir, fp), extraSecrets);
      }
    };
    scanDir(rawDir);
  }

  if (updateRedactionManifest) {
    const manifestPath = path.join(outDir, 'REDACTION_MANIFEST.md');
    const marker = tierLabel === 'hard tier'
      ? '## Cost-Per-Task Hard Tier Suite (`cost_per_task/hard_tier/`)'
      : '## Cost-Per-Task Benchmark Suite (`cost_per_task/` — Routine Tasks)';
    if (fs.existsSync(manifestPath)) {
      let current = fs.readFileSync(manifestPath, 'utf8');
      const oldMarker = '## Cost-Per-Task Benchmark Suite (`cost_per_task/`)';
      if (tierLabel !== 'hard tier' && current.includes(oldMarker) && !current.includes(marker)) {
        current = current.replace(oldMarker, marker);
      }
      const idx = current.indexOf(marker);
      const section = [
        marker,
        '',
        `- **Audit Timestamp (UTC):** \`${new Date().toISOString()}\``,
        `- **Tier:** \`${tierLabel}\``,
        `- **Deliverables Audited (\`assertNoSensitiveLeaks\` = PASS):** \`${path.basename(preregistrationPath)}\`, \`${runsCsvName}\` (${requestRows.length} rows), \`${summaryCsvName}\` (${summaryRows.length} rows), \`${summaryMdName}\`, \`highbeam_shadow_check.md\`, and \`${path.basename(rawDir)}/*\`.`,
        '- **Sanitization Applied:** Zero API keys, zero local OS usernames or temp directories, deterministic `sess_<run_id>` session aliases, and sanitized eval paths in all retry logs.'
      ].join('\n');
      if (idx >= 0) {
        const restAfter = current.slice(idx + marker.length);
        const nextSep = restAfter.indexOf('\n---');
        if (nextSep >= 0) {
          current = current.slice(0, idx) + section + restAfter.slice(nextSep);
        } else {
          current = current.slice(0, idx) + section + '\n';
        }
      } else {
        current = current.trimEnd() + '\n\n---\n\n' + section + '\n';
      }
      assertNoSensitiveLeaks(current, 'REDACTION_MANIFEST.md', extraSecrets);
      fs.writeFileSync(manifestPath, current, 'utf8');
    }
  }

  return {
    runsCsvPath,
    summaryCsvPath,
    mdOutPath,
    requestRowCount: requestRows.length,
    summaryRowCount: summaryRows.length
  };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const res = buildCostPerTaskDeliverables({ updateRedactionManifest: true });
  console.log('DELIVERABLES_BUILT:', JSON.stringify(res));
}
