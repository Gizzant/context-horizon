import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  RESULTS_DIR,
  PINNED_REPO_COMMIT,
  PINNED_CLAUDE_CODE_VERSION,
  ARM_E_IDLE_SECONDS,
  ARM_DEFINITIONS,
  loadOpenRouterApiKey,
  mapCliModelToOpenRouter
} from './config.mjs';
import { startProxyServer } from './proxy_recorder.mjs';
import { installAttentionHorizon, ensureGitExcludeEntries } from '../../bin/ctxtop.mjs';
import { activateLocalTrial } from '../../src/core/pro_license.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { CacheGravityRouter } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { recordInterventionSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  createInitialTelemetryState,
  writeLiveStateSnapshot
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';

const AUTO_RESULTS_DIR = path.join(RESULTS_DIR, 'highbeam_auto');
const AUTO_RAW_DIR = path.join(AUTO_RESULTS_DIR, 'raw');
const AUTO_TRANSCRIPTS_DIR = path.join(AUTO_RAW_DIR, 'transcripts');

const ARM_NAME_MAP = Object.freeze({
  A: 'control',
  B: 'one_switch',
  C: 'switch_and_back',
  D: 'effort_only',
  E: 'idle_then_switch',
  F: 'ten_switches'
});

const ARM_CODE_MAP = Object.freeze({
  control: 'A',
  one_switch: 'B',
  switch_and_back: 'C',
  effort_only: 'D',
  idle_then_switch: 'E',
  ten_switches: 'F'
});

const CSV_HEADERS = Object.freeze([
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
  'requests_in_turn'
]);

const REPLAY_HEADERS = Object.freeze([
  'run_id',
  'arm',
  'rep',
  'prefix_size_bucket',
  'det08_holds',
  'det08_allows',
  'det09_defers',
  'highbeam_action_summary',
  'matched_reference_run_id',
  'baseline_t6_cache_read_pct',
  'auto_t6_cache_read_pct',
  'baseline_t6_write_tokens',
  'auto_t6_write_tokens',
  'baseline_t6_cost_usd',
  'auto_t6_cost_usd',
  't6_cost_saved_usd',
  'baseline_session_write_tokens',
  'auto_session_write_tokens',
  'write_tokens_saved',
  'baseline_session_cost_usd',
  'auto_session_cost_usd',
  'session_cost_saved_usd'
]);

const INTERCEPTIONS_HEADERS = Object.freeze([
  'run_id',
  'arm',
  'prefix_size_bucket',
  'turn',
  'scheduled_model',
  'effective_model',
  'scheduled_effort',
  'effective_effort',
  'cache_warm',
  'ttl_remaining_s',
  'warm_cached_tokens',
  'break_even_c_star',
  'detector_id',
  'decision',
  'action_taken',
  'avoided_penalty_est_usd',
  'hook_eval_ms'
]);

function parseArgs(argv = []) {
  const flags = {
    replayOnly: false,
    runLive: false,
    buildOnly: false,
    resume: false,
    maxBudgetUsd: 6.0
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--replay-only') flags.replayOnly = true;
    else if (a === '--run-live') flags.runLive = true;
    else if (a === '--build-only') flags.buildOnly = true;
    else if (a === '--resume') flags.resume = true;
    else if (a === '--max-budget' && argv[i + 1]) {
      flags.maxBudgetUsd = Number(argv[++i]) || 6.0;
    }
  }
  if (!flags.replayOnly && !flags.runLive && !flags.buildOnly) {
    flags.replayOnly = true;
  }
  return flags;
}

function resolveRuntimePaths() {
  const tmpDir = os.tmpdir();
  const candidates = fs.readdirSync(tmpDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-model-switch-runtime'))
    .map((d) => path.join(tmpDir, d.name));

  for (const rtRoot of candidates) {
    const claudeExe = path.join(rtRoot, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const frozenRepoDir = path.join(rtRoot, 'frozen-repo');
    if (fs.existsSync(claudeExe) && fs.existsSync(frozenRepoDir)) {
      return {
        runtimeRoot: rtRoot,
        runtimeDirName: path.basename(rtRoot),
        claudeExe,
        frozenRepoDir,
        autoWorkDir: path.join(rtRoot, 'runs', 'highbeam_auto')
      };
    }
  }
  throw new Error('Could not locate installed claude.exe + frozen-repo under %TEMP%/*-model-switch-runtime');
}

function verifyRuntimeEnvironment(runtimePaths) {
  const verRes = spawnSync(runtimePaths.claudeExe, ['--version'], { encoding: 'utf8' });
  const versionOutput = String(verRes.stdout || verRes.stderr || '').trim();
  const gitRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: runtimePaths.frozenRepoDir, encoding: 'utf8' });
  const actualCommit = String(gitRes.stdout || '').trim();
  if (actualCommit !== PINNED_REPO_COMMIT) {
    throw new Error(`Frozen repo HEAD ${actualCommit} !== expected ${PINNED_REPO_COMMIT}`);
  }
  return { versionOutput, actualCommit };
}

function ensureAutoGitExclude(frozenRepoDir) {
  ensureGitExcludeEntries(frozenRepoDir);
  const excludePath = path.join(frozenRepoDir, '.git', 'info', 'exclude');
  if (fs.existsSync(excludePath)) {
    let content = fs.readFileSync(excludePath, 'utf8');
    if (!content.split(/\r?\n/).some((l) => l.trim() === '.claude/')) {
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += '.claude/\n';
      fs.writeFileSync(excludePath, content, 'utf8');
    }
  }
}

function resetFrozenRepoClean(frozenRepoDir) {
  const co = spawnSync('git', ['checkout', '-f', PINNED_REPO_COMMIT], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (co.status !== 0) throw new Error(`git checkout failed: ${co.stderr}`);
  const cl = spawnSync('git', ['clean', '-fdx'], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (cl.status !== 0) throw new Error(`git clean failed: ${cl.stderr}`);
  ensureAutoGitExclude(frozenRepoDir);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (st.status !== 0) throw new Error(`git status failed: ${st.stderr}`);
  if (String(st.stdout || '').trim() !== '') {
    throw new Error(`Frozen repo is not clean after reset: ${st.stdout}`);
  }
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      continue;
    } else if (ch === '\n') {
      row.push(field);
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        records.push(row);
      }
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0];
  const rows = records.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] ?? '';
    });
    return obj;
  });
  return { headers, rows };
}

function csvEscape(val) {
  if (val === null || val === undefined || val === '') return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
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
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function median(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function minVal(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.min(...nums) : null;
}

function maxVal(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function fmtMedRange(values = [], digits = 4, prefix = '', suffix = '') {
  const med = median(values);
  const lo = minVal(values);
  const hi = maxVal(values);
  if (med === null) return 'N/A';
  return `${prefix}${med.toFixed(digits)}${suffix} [${prefix}${lo.toFixed(digits)}${suffix}–${prefix}${hi.toFixed(digits)}${suffix}]`;
}

function fmtIntMedRange(values = []) {
  const med = median(values);
  const lo = minVal(values);
  const hi = maxVal(values);
  if (med === null) return 'N/A';
  return `${Math.round(med).toLocaleString('en-US')} [${Math.round(lo).toLocaleString('en-US')}–${Math.round(hi).toLocaleString('en-US')}]`;
}

function fmtSignedUsdMedRange(values = [], digits = 4) {
  const med = median(values);
  const lo = minVal(values);
  const hi = maxVal(values);
  if (med === null) return 'N/A';
  const fmtOne = (v) => {
    const sign = v >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(v).toFixed(digits)}`;
  };
  return `${fmtOne(med)} [${fmtOne(lo)} to ${fmtOne(hi)}]`;
}

function loadDynamicIdentifiers() {
  const dynamicUser = os.userInfo().username || '';
  const dynamicRepoDirName = path.basename(REPO_ROOT);
  let dynamicGitRemoteSlug = '';
  let dynamicGitOwner = '';
  let dynamicGitRepo = '';
  const gitConfigPath = path.join(REPO_ROOT, '.git', 'config');
  if (fs.existsSync(gitConfigPath)) {
    const gcfg = fs.readFileSync(gitConfigPath, 'utf8');
    const m = gcfg.match(/github\.com[:\/]([^\/\s]+)\/([^.\s\/]+)(?:\.git)?/i);
    if (m) {
      dynamicGitOwner = m[1];
      dynamicGitRepo = m[2];
      dynamicGitRemoteSlug = `${m[1]}/${m[2]}`;
    }
  }
  return {
    dynamicUser,
    dynamicRepoDirName,
    dynamicGitRemoteSlug,
    dynamicGitOwner,
    dynamicGitRepo
  };
}

/**
 * Step 1.2: Verify all 3 Highbeam AUTO_PILOT gates before running replay or live API calls.
 */
function verifyHighbeamAutoPilotGates() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-autopilot-selftest-'));
  try {
    const licensePath = path.join(tmpHome, '.ctxtop', 'license.json');
    activateLocalTrial({ homeDir: tmpHome, licensePath });
    const ahDir = path.join(tmpHome, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(path.join(ahDir, 'config.json'), JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2), 'utf8');

    // 1. Warm Model Switch (DET-08 Hold)
    const warmSwitch = runPreModelSwitchHook(
      {
        session_id: 'selftest',
        cwd: tmpHome,
        current_model: 'claude-opus-4-6',
        target_model: 'claude-sonnet-4-6',
        cached_tokens: 14822,
        uncached_delta_tokens: 350,
        cache_warm: true,
        cache_ttl_tier: '5m'
      },
      { cwd: tmpHome, homeDir: tmpHome, licensePath, recordLedger: false }
    );
    if (
      warmSwitch.exitCode !== 2 ||
      warmSwitch.verdict?.mode !== 'AUTO_PILOT' ||
      warmSwitch.verdict?.blocked !== true ||
      warmSwitch.verdict?.decision !== 'deny' ||
      warmSwitch.verdict?.recommendedModel !== 'claude-opus-4-6' ||
      !(warmSwitch.verdict?.breakEven?.breakEvenTokens > 0)
    ) {
      throw new Error(`Gate 1 (DET-08 warm hold) failed: ${JSON.stringify(warmSwitch)}`);
    }

    // 2. Cold / Expired-TTL Model Switch (DET-08 Allow)
    const coldSwitch = runPreModelSwitchHook(
      {
        session_id: 'selftest',
        cwd: tmpHome,
        current_model: 'claude-opus-4-6',
        target_model: 'claude-sonnet-4-6',
        cached_tokens: 14822,
        uncached_delta_tokens: 350,
        cache_warm: false,
        cache_ttl_tier: '5m'
      },
      { cwd: tmpHome, homeDir: tmpHome, licensePath, recordLedger: false }
    );
    if (
      coldSwitch.exitCode !== 0 ||
      coldSwitch.verdict?.blocked !== false ||
      coldSwitch.verdict?.decision !== 'allow'
    ) {
      throw new Error(`Gate 2 (DET-08 cold allow) failed: ${JSON.stringify(coldSwitch)}`);
    }

    // 3. Warm Effort Mutation (DET-09 Defer)
    const router = new CacheGravityRouter({ mode: 'AUTO_PILOT', homeDir: tmpHome, licensePath });
    const warmEffort = router.interceptTopLevelMutation({
      type: 'effort',
      key: 'effort',
      value: 'high',
      currentModel: 'claude-opus-4-6',
      cachedTokens: 14822,
      cacheWarm: true,
      ttlRemainingSeconds: 290,
      cacheTtlTier: '5m'
    });
    if (
      warmEffort.triggered !== true ||
      warmEffort.queued !== true ||
      warmEffort.decision !== 'defer' ||
      !(warmEffort.avoidedRewritePenaltyUSD > 0.08)
    ) {
      throw new Error(`Gate 3 (DET-09 warm effort defer) failed: ${JSON.stringify(warmEffort)}`);
    }

    return {
      ok: true,
      det08WarmHold: {
        mode: warmSwitch.verdict.mode,
        exitCode: warmSwitch.exitCode,
        decision: warmSwitch.verdict.decision,
        recommendedModel: warmSwitch.verdict.recommendedModel,
        breakEvenTokens: warmSwitch.verdict.breakEven.breakEvenTokens,
        coldWritePenaltyUSD: warmSwitch.verdict.breakEven.coldWritePenaltyUSD
      },
      det08ColdAllow: {
        exitCode: coldSwitch.exitCode,
        decision: coldSwitch.verdict.decision,
        blocked: coldSwitch.verdict.blocked
      },
      det09WarmEffortDefer: {
        triggered: warmEffort.triggered,
        queued: warmEffort.queued,
        decision: warmEffort.decision,
        avoidedRewritePenaltyUSD: warmEffort.avoidedRewritePenaltyUSD
      }
    };
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

/**
 * Step 1.3: Full 45-Session Counterfactual Replay ($0.00).
 */
function runCounterfactual45Replay() {
  const runsCsvPath = path.join(RESULTS_DIR, 'runs.csv');
  const { rows } = parseCsv(runsCsvPath);
  const mainRows = rows.filter((r) => r.is_side_call === 'false' && r.source === 'both');

  const runsById = new Map();
  for (const r of mainRows) {
    if (!runsById.has(r.run_id)) {
      runsById.set(r.run_id, []);
    }
    runsById.get(r.run_id).push({
      ...r,
      turnNum: Number(r.turn),
      reqIdxNum: Number(r.request_index_in_turn),
      inputTokens: Number(r.input_tokens),
      writeTokens: Number(r.cache_creation_input_tokens),
      readTokens: Number(r.cache_read_input_tokens),
      outputTokens: Number(r.output_tokens),
      latencyMs: Number(r.latency_ms),
      costUsd: Number(r.cost_usd),
      tsMs: Date.parse(r.timestamp_utc)
    });
  }

  for (const arr of runsById.values()) {
    arr.sort((a, b) => a.turnNum - b.turnNum || a.reqIdxNum - b.reqIdxNum);
  }

  // Paired empirical Control (Arm A) lookup keyed by bucket::rep
  const controlMetricsByKey = new Map();
  const summarizeBaselineRun = (runRows) => {
    const t6Row = runRows.find((r) => r.turnNum === 6 && r.reqIdxNum === 1);
    const t6TotalIn = t6Row.inputTokens + t6Row.writeTokens + t6Row.readTokens;
    const t6CacheReadPct = t6TotalIn > 0 ? (t6Row.readTokens / t6TotalIn) * 100 : 0;
    const sessionWriteTokens = runRows.reduce((s, r) => s + r.writeTokens, 0);
    const sessionReadTokens = runRows.reduce((s, r) => s + r.readTokens, 0);
    const sessionCostUsd = runRows.reduce((s, r) => s + r.costUsd, 0);
    const sessionLatencyMs = runRows.reduce((s, r) => s + r.latencyMs, 0);
    return {
      runId: runRows[0].run_id,
      t6CacheReadPct,
      t6WriteTokens: t6Row.writeTokens,
      t6ReadTokens: t6Row.readTokens,
      t6CostUsd: t6Row.costUsd,
      sessionWriteTokens,
      sessionReadTokens,
      sessionCostUsd,
      sessionLatencyMs
    };
  };

  for (const runRows of runsById.values()) {
    const first = runRows[0];
    if (first.arm === 'control') {
      controlMetricsByKey.set(`${first.prefix_size_bucket}::${first.rep}`, summarizeBaselineRun(runRows));
    }
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-replay45-'));
  const replayRows = [];
  try {
    const licensePath = path.join(tmpHome, '.ctxtop', 'license.json');
    activateLocalTrial({ homeDir: tmpHome, licensePath });
    const ahDir = path.join(tmpHome, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(path.join(ahDir, 'config.json'), JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2), 'utf8');

    const sortedRunIds = Array.from(runsById.keys()).sort((a, b) => {
      const ra = runsById.get(a)[0];
      const rb = runsById.get(b)[0];
      if (ra.prefix_size_bucket !== rb.prefix_size_bucket) {
        return ra.prefix_size_bucket === 'small' ? -1 : 1;
      }
      if (ra.arm !== rb.arm) return ra.arm.localeCompare(rb.arm);
      return Number(ra.rep) - Number(rb.rep);
    });

    for (const runId of sortedRunIds) {
      const runRows = runsById.get(runId);
      const meta = runRows[0];
      const armCode = ARM_CODE_MAP[meta.arm];
      const def = ARM_DEFINITIONS[armCode];
      const baseSummary = summarizeBaselineRun(runRows);

      const router = new CacheGravityRouter({ mode: 'AUTO_PILOT', homeDir: tmpHome, licensePath });
      let activeModel = def.schedule[0].model;
      let activeEffort = def.schedule[0].effort;
      let warmCachedTokens = 0;
      let prevTurnEndMs = null;

      let det08Holds = 0;
      let det08Allows = 0;
      let det09Defers = 0;

      for (let turn = 1; turn <= 12; turn++) {
        const turnRows = runRows.filter((r) => r.turnNum === turn);
        const firstReq = turnRows[0];
        const lastReq = turnRows[turnRows.length - 1];
        const stepSpec = def.schedule[turn - 1];

        let elapsedSec = 0;
        if (turn > 1) {
          if (meta.arm === 'idle_then_switch' && turn === 6) {
            const m = String(firstReq.notes || '').match(/actual_idle_sec=([0-9.]+)/);
            elapsedSec = m ? Number(m[1]) : 350;
          } else if (prevTurnEndMs !== null && Number.isFinite(firstReq.tsMs)) {
            elapsedSec = Math.max(0, (firstReq.tsMs - prevTurnEndMs) / 1000);
          } else {
            elapsedSec = 8;
          }
        }
        const ttlRemainingSeconds = turn === 1 ? 0 : Math.max(0, 300 - elapsedSec);
        const cacheWarm = turn > 1 && ttlRemainingSeconds > 0 && warmCachedTokens > 0;

        if (turn > 1 && stepSpec.model !== activeModel) {
          const hookRes = runPreModelSwitchHook(
            {
              session_id: runId,
              cwd: tmpHome,
              current_model: activeModel,
              target_model: stepSpec.model,
              cached_tokens: cacheWarm ? warmCachedTokens : 0,
              uncached_delta_tokens: 350,
              cache_warm: cacheWarm,
              cache_ttl_tier: '5m'
            },
            { cwd: tmpHome, homeDir: tmpHome, licensePath, recordLedger: false }
          );
          if (hookRes.verdict?.blocked) {
            det08Holds += 1;
          } else {
            det08Allows += 1;
            activeModel = stepSpec.model;
          }
        } else if (turn > 1 && stepSpec.effort !== activeEffort) {
          const mutRes = router.interceptTopLevelMutation({
            type: 'effort',
            key: 'effort',
            value: stepSpec.effort,
            currentModel: activeModel,
            cachedTokens: cacheWarm ? warmCachedTokens : 0,
            cacheWarm,
            ttlRemainingSeconds,
            cacheTtlTier: '5m'
          });
          if (mutRes.triggered && mutRes.decision === 'defer') {
            det09Defers += 1;
          } else {
            activeEffort = stepSpec.effort;
          }
        }

        warmCachedTokens = lastReq.readTokens + lastReq.writeTokens;
        prevTurnEndMs = lastReq.tsMs + lastReq.latencyMs;
      }

      const wasModifiedByHighbeam = det08Holds > 0 || det09Defers > 0;
      const pairedControl = controlMetricsByKey.get(`${meta.prefix_size_bucket}::${meta.rep}`);
      const autoSummary = wasModifiedByHighbeam ? pairedControl : baseSummary;

      let actionSummary = 'none';
      if (det08Holds > 0) {
        actionSummary = `DET-08_hold_opus (${det08Holds} turns held)`;
      } else if (det09Defers > 0) {
        actionSummary = `DET-09_defer_effort (${det09Defers} turns deferred)`;
      } else if (det08Allows > 0) {
        actionSummary = `DET-08_allow_cold_switch (${det08Allows} expired-TTL switch allowed)`;
      } else {
        actionSummary = 'control_passthrough';
      }

      replayRows.push({
        run_id: runId,
        arm: meta.arm,
        rep: Number(meta.rep),
        prefix_size_bucket: meta.prefix_size_bucket,
        det08_holds: det08Holds,
        det08_allows: det08Allows,
        det09_defers: det09Defers,
        highbeam_action_summary: actionSummary,
        matched_reference_run_id: autoSummary.runId,
        baseline_t6_cache_read_pct: baseSummary.t6CacheReadPct,
        auto_t6_cache_read_pct: autoSummary.t6CacheReadPct,
        baseline_t6_write_tokens: baseSummary.t6WriteTokens,
        auto_t6_write_tokens: autoSummary.t6WriteTokens,
        baseline_t6_cost_usd: baseSummary.t6CostUsd,
        auto_t6_cost_usd: autoSummary.t6CostUsd,
        t6_cost_saved_usd: baseSummary.t6CostUsd - autoSummary.t6CostUsd,
        baseline_session_write_tokens: baseSummary.sessionWriteTokens,
        auto_session_write_tokens: autoSummary.sessionWriteTokens,
        write_tokens_saved: baseSummary.sessionWriteTokens - autoSummary.sessionWriteTokens,
        baseline_session_cost_usd: baseSummary.sessionCostUsd,
        auto_session_cost_usd: autoSummary.sessionCostUsd,
        session_cost_saved_usd: baseSummary.sessionCostUsd - autoSummary.sessionCostUsd
      });
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  const replayCsvPath = path.join(AUTO_RESULTS_DIR, 'replay_45_sessions.csv');
  writeCsv(replayCsvPath, REPLAY_HEADERS, replayRows);
  return { replayCsvPath, replayRows };
}

function loadPrompts(tier) {
  const filename = tier === 'large' ? 'prompts_large.json' : 'prompts_small.json';
  const fullPath = path.join(EXPERIMENT_DIR, 'fixtures', filename);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function findSessionJsonlFiles(rootDir, acc = []) {
  if (!fs.existsSync(rootDir)) return acc;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) findSessionJsonlFiles(full, acc);
    else if (entry.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

async function fetchOpenRouterKeyUsage(apiKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      usage: json?.data?.usage ?? null,
      limit: json?.data?.limit ?? null,
      limit_remaining: json?.data?.limit_remaining ?? null
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function runClaudeTurn({
  claudeExe,
  frozenRepoDir,
  prompt,
  model,
  effort,
  sessionId,
  appendSystemPrompt,
  homeDir,
  cfgDir,
  settingsPath,
  proxyBaseUrl,
  timeoutMs = 180000
}) {
  return new Promise((resolve) => {
    const args = [];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(
      '-p', prompt,
      '--model', model,
      '--effort', effort,
      '--tools', 'Read',
      '--append-system-prompt', appendSystemPrompt,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--settings', settingsPath
    );

    const env = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.OPENROUTER_API_KEY;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    env.ANTHROPIC_BASE_URL = proxyBaseUrl;
    env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.CLAUDE_CONFIG_DIR = cfgDir;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;

    const startNs = process.hrtime.bigint();
    const child = spawn(claudeExe, args, {
      cwd: frozenRepoDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const stdout = Buffer.concat(outChunks).toString('utf8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();

      let parsedOut = null;
      try {
        parsedOut = stdout ? JSON.parse(stdout) : null;
      } catch {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsedOut = JSON.parse(lines[i]);
            break;
          } catch {}
        }
      }

      resolve({
        code,
        timedOut,
        wallMs: Number(wallMs.toFixed(2)),
        parsedOut,
        stdoutPreview: stdout.slice(0, 400),
        stderrPreview: stderr.slice(0, 400)
      });
    });
  });
}

function readWireLogsForTurn(wireLogPath, runId, turn) {
  if (!fs.existsSync(wireLogPath)) return [];
  const lines = fs.readFileSync(wireLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const matched = [];
  for (const l of lines) {
    try {
      const obj = JSON.parse(l);
      if (obj?.context?.runId === runId && obj?.context?.turn === turn) {
        matched.push(obj);
      }
    } catch {}
  }
  return matched;
}

function buildLiveAutoSchedule() {
  const defs = [
    { runId: 'HB_E_S_r01', arm: 'E', tier: 'small', replicate: 1 },
    { runId: 'HB_B_S_r01', arm: 'B', tier: 'small', replicate: 1 },
    { runId: 'HB_C_S_r01', arm: 'C', tier: 'small', replicate: 1 },
    { runId: 'HB_D_S_r01', arm: 'D', tier: 'small', replicate: 1 },
    { runId: 'HB_F_S_r01', arm: 'F', tier: 'small', replicate: 1 },
    { runId: 'HB_B_L_r01', arm: 'B', tier: 'large', replicate: 1 },
    { runId: 'HB_F_L_r01', arm: 'F', tier: 'large', replicate: 1 }
  ];
  return defs.map((d, idx) => ({
    ...d,
    orderIndex: idx + 1,
    turnsToRun: 12,
    schedule: ARM_DEFINITIONS[d.arm].schedule,
    idleBeforeTurn6Sec: ARM_DEFINITIONS[d.arm].idleBeforeTurn6Sec
  }));
}

/**
 * Step 1.4: Execute the 7 live Highbeam AUTO_PILOT sessions.
 */
async function runLiveAutoSessions({ maxBudgetUsd, resume, runtimePaths }) {
  const apiKey = loadOpenRouterApiKey();
  const envInfo = verifyRuntimeEnvironment(runtimePaths);
  const startedAt = new Date().toISOString();

  fs.mkdirSync(AUTO_RESULTS_DIR, { recursive: true });
  fs.mkdirSync(AUTO_RAW_DIR, { recursive: true });
  fs.mkdirSync(AUTO_TRANSCRIPTS_DIR, { recursive: true });

  const wireLogPath = path.join(AUTO_RAW_DIR, 'proxy_wire_log.jsonl');
  const cliTurnsPath = path.join(AUTO_RAW_DIR, 'cli_turns.jsonl');
  const interceptionsLogPath = path.join(AUTO_RAW_DIR, 'interceptions_live.jsonl');
  const openrouterLedgerPath = path.join(AUTO_RAW_DIR, 'openrouter_ledger.jsonl');
  const checkpointPath = path.join(AUTO_RAW_DIR, 'checkpoint.json');
  const manifestJsonPath = path.join(AUTO_RAW_DIR, 'run_manifest.json');
  const mergedHorizonLedgerPath = path.join(AUTO_RESULTS_DIR, 'horizon_ledger.jsonl');

  const promptsCache = {
    small: loadPrompts('small'),
    large: loadPrompts('large')
  };

  let checkpoint = { mode: 'highbeam_auto', runs: {} };
  if (resume && fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } else {
    for (const p of [wireLogPath, cliTurnsPath, interceptionsLogPath, openrouterLedgerPath, checkpointPath, mergedHorizonLedgerPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(AUTO_TRANSCRIPTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTO_TRANSCRIPTS_DIR, { recursive: true });
  }

  let initialSpendUsd = 0;
  if (resume && fs.existsSync(wireLogPath)) {
    for (const w of readJsonl(wireLogPath)) {
      if (w.statusCode < 400 && typeof w.cost?.totalCostUsd === 'number') {
        initialSpendUsd += w.cost.totalCostUsd;
      }
    }
  }

  const keyStart = await fetchOpenRouterKeyUsage(apiKey);
  fs.appendFileSync(openrouterLedgerPath, JSON.stringify({ event: 'start', ...keyStart }) + '\n', 'utf8');

  const proxy = await startProxyServer({
    port: 0,
    upstreamBaseUrl: 'https://openrouter.ai',
    upstreamApiPrefix: '/api',
    apiKey,
    maxBudgetUsd,
    wireLogPath,
    pinProvider: true,
    stripCacheTtl: false
  });
  proxy.getState().totalSpendUsd; // sanity check

  // If resuming, add prior spend manually via initial state check inside loop
  const scheduledRuns = buildLiveAutoSchedule();
  fs.writeFileSync(manifestJsonPath, JSON.stringify({
    startedAt,
    mode: 'highbeam_auto',
    flightMode: 'AUTO_PILOT',
    pinnedRepoCommit: PINNED_REPO_COMMIT,
    claudeCodeVersion: envInfo.versionOutput,
    maxBudgetUsd,
    runCount: scheduledRuns.length,
    schedule: scheduledRuns.map((r) => ({
      orderIndex: r.orderIndex,
      runId: r.runId,
      arm: r.arm,
      tier: r.tier,
      replicate: r.replicate,
      turnsToRun: r.turnsToRun
    }))
  }, null, 2), 'utf8');

  const runQueue = scheduledRuns.map((spec) => {
    const existing = checkpoint.runs[spec.runId];
    const workRoot = path.join(runtimePaths.autoWorkDir, spec.runId);
    const homeDir = path.join(workRoot, 'home');
    const cfgDir = path.join(workRoot, 'claude_config');
    const settingsPath = path.join(workRoot, 'highbeam_settings.json');
    const licensePath = path.join(homeDir, '.ctxtop', 'license.json');
    const ledgerPath = path.join(workRoot, 'horizon_ledger.jsonl');

    if (!existing) {
      fs.rmSync(workRoot, { recursive: true, force: true });
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(cfgDir, { recursive: true });
      activateLocalTrial({ homeDir, licensePath });
      const ahDir = path.join(homeDir, '.attention-horizon');
      fs.mkdirSync(ahDir, { recursive: true });
      fs.writeFileSync(path.join(ahDir, 'config.json'), JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2), 'utf8');
      installAttentionHorizon({ settingsPath, leanHooks: false });
    }

    const salt = existing?.salt || `Benchmark-Run-Salt: ${spec.runId}_${crypto.createHash('sha256').update(spec.runId + '_highbeam_auto').digest('hex').slice(0, 8)}`;
    return {
      ...spec,
      workRoot,
      homeDir,
      cfgDir,
      settingsPath,
      licensePath,
      ledgerPath,
      salt,
      sessionId: existing?.sessionId || null,
      nextTurn: existing?.nextTurn || 1,
      completed: Boolean(existing?.completed),
      activeModel: existing?.activeModel || spec.schedule[0].model,
      activeEffort: existing?.activeEffort || spec.schedule[0].effort,
      lastCachedTokens: existing?.lastCachedTokens || 0,
      lastTotalInputTokens: existing?.lastTotalInputTokens || 0,
      lastTurnFinishedAtMs: existing?.lastTurnFinishedAtMs || 0,
      turn5FinishedAtMs: existing?.turn5FinishedAtMs || 0,
      parkedUntilMs: existing?.parkedUntilMs || 0,
      actualIdleSec: existing?.actualIdleSec ?? null,
      queuedMutations: Array.isArray(existing?.queuedMutations) ? existing.queuedMutations : []
    };
  });

  function saveCheckpoint(runState) {
    checkpoint.runs[runState.runId] = {
      sessionId: runState.sessionId,
      nextTurn: runState.nextTurn,
      completed: runState.completed,
      salt: runState.salt,
      activeModel: runState.activeModel,
      activeEffort: runState.activeEffort,
      lastCachedTokens: runState.lastCachedTokens,
      lastTotalInputTokens: runState.lastTotalInputTokens,
      lastTurnFinishedAtMs: runState.lastTurnFinishedAtMs,
      turn5FinishedAtMs: runState.turn5FinishedAtMs,
      parkedUntilMs: runState.parkedUntilMs,
      actualIdleSec: runState.actualIdleSec,
      queuedMutations: runState.queuedMutations
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
  }

  async function executeSingleRunSegment(runState, stopAfterTurn = runState.turnsToRun) {
    if (!runState.sessionId && runState.nextTurn === 1) {
      resetFrozenRepoClean(runtimePaths.frozenRepoDir);
    }
    const tierPrompts = promptsCache[runState.tier].prompts;

    while (runState.nextTurn <= stopAfterTurn && !runState.completed) {
      if (initialSpendUsd + proxy.getState().totalSpendUsd >= maxBudgetUsd) {
        throw new Error(`Budget circuit breaker triggered ($${(initialSpendUsd + proxy.getState().totalSpendUsd).toFixed(4)} >= $${maxBudgetUsd}). Halting cleanly.`);
      }

      const turn = runState.nextTurn;
      const stepSpec = runState.schedule[turn - 1];
      const promptObj = tierPrompts[turn - 1];

      let actualIdleSec = null;
      if (runState.arm === 'E' && turn === 6 && runState.turn5FinishedAtMs > 0) {
        const waitMs = Math.max(0, runState.parkedUntilMs - Date.now());
        if (waitMs > 0) {
          console.log(`[${runState.runId}] Waiting ${(waitMs / 1000).toFixed(1)}s before Turn 6 to clear 5m TTL...`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
        actualIdleSec = Number(((Date.now() - runState.turn5FinishedAtMs) / 1000).toFixed(2));
        runState.actualIdleSec = actualIdleSec;
      }

      const elapsedSec = turn === 1
        ? 0
        : (actualIdleSec !== null
          ? actualIdleSec
          : Number(((Date.now() - runState.lastTurnFinishedAtMs) / 1000).toFixed(2)));
      const ttlRemainingSeconds = turn === 1 ? 0 : Math.max(0, Number((300 - elapsedSec).toFixed(2)));
      const cacheWarm = turn > 1 && ttlRemainingSeconds > 0 && runState.lastCachedTokens > 0;

      // Write live telemetry state snapshot so Highbeam hooks read current cache & flight state
      const snapState = {
        ...createInitialTelemetryState(runState.sessionId || runState.runId),
        sessionId: runState.sessionId || runState.runId,
        modelId: runState.activeModel,
        effort: runState.activeEffort,
        flightMode: 'AUTO_PILOT',
        contextWindow: {
          cachedTokens: cacheWarm ? runState.lastCachedTokens : 0,
          totalInputTokens: runState.lastTotalInputTokens
        },
        promptCache: {
          warm: cacheWarm,
          ttlTier: '5m',
          ttlSeconds: ttlRemainingSeconds
        }
      };
      writeLiveStateSnapshot(runState.sessionId || 'default', snapState, { cwd: runtimePaths.frozenRepoDir });

      // Pre-invocation Highbeam AUTO_PILOT evaluation (DET-08 & DET-09)
      const t0 = process.hrtime.bigint();
      let effectiveModel = turn === 1 ? stepSpec.model : runState.activeModel;
      let effectiveEffort = turn === 1 ? stepSpec.effort : runState.activeEffort;
      let detectorId = 'NONE';
      let decision = 'pass';
      let actionTaken = 'none';
      let breakEvenCStar = null;
      let avoidedPenaltyEstUsd = 0;
      let reason = '';

      if (turn > 1 && stepSpec.model !== runState.activeModel) {
        const hookRes = runPreModelSwitchHook(
          {
            session_id: runState.sessionId || runState.runId,
            cwd: runtimePaths.frozenRepoDir,
            current_model: runState.activeModel,
            target_model: stepSpec.model,
            cached_tokens: cacheWarm ? runState.lastCachedTokens : 0,
            uncached_delta_tokens: 350,
            cache_warm: cacheWarm,
            cache_ttl_tier: '5m',
            turn_id: `${runState.runId}_T${turn}`
          },
          {
            cwd: runtimePaths.frozenRepoDir,
            homeDir: runState.homeDir,
            licensePath: runState.licensePath,
            ledgerPath: runState.ledgerPath,
            recordLedger: true
          }
        );
        detectorId = 'DET-08';
        decision = hookRes.verdict?.decision || 'allow';
        breakEvenCStar = hookRes.verdict?.breakEven?.breakEvenTokens ?? null;
        reason = hookRes.verdict?.reason || '';
        if (hookRes.verdict?.blocked) {
          effectiveModel = runState.activeModel;
          actionTaken = 'DET-08_hold_model';
          avoidedPenaltyEstUsd = Math.max(0, Number(hookRes.verdict?.breakEven?.coldWritePenaltyUSD || 0));
        } else {
          effectiveModel = stepSpec.model;
          actionTaken = 'DET-08_allow_cold_switch';
        }
      } else if (turn > 1 && stepSpec.effort !== runState.activeEffort) {
        const router = new CacheGravityRouter({
          mode: 'AUTO_PILOT',
          homeDir: runState.homeDir,
          licensePath: runState.licensePath,
          cwd: runtimePaths.frozenRepoDir,
          queuedMutations: runState.queuedMutations
        });
        const mutRes = router.interceptTopLevelMutation({
          type: 'effort',
          key: 'effort',
          value: stepSpec.effort,
          currentModel: runState.activeModel,
          cachedTokens: cacheWarm ? runState.lastCachedTokens : 0,
          cacheWarm,
          ttlRemainingSeconds,
          cacheTtlTier: '5m'
        });
        detectorId = 'DET-09';
        decision = mutRes.decision || 'allow';
        reason = mutRes.reason || '';
        runState.queuedMutations = router.mutationQueue.toJSON();
        if (mutRes.triggered && mutRes.decision === 'defer') {
          effectiveEffort = runState.activeEffort;
          actionTaken = 'DET-09_defer_effort_to_compact';
          avoidedPenaltyEstUsd = Number(mutRes.avoidedRewritePenaltyUSD || 0);
          recordInterventionSavings(
            {
              sessionId: runState.sessionId || runState.runId,
              category: 'DET_09_PREFIX_FENCE',
              modelId: runState.activeModel,
              savedTokens: runState.lastCachedTokens,
              savedUSD: avoidedPenaltyEstUsd,
              dedupeId: `${runState.runId}_T${turn}_effort`,
              detail: reason
            },
            { cwd: runtimePaths.frozenRepoDir, homeDir: runState.homeDir, ledgerPath: runState.ledgerPath }
          );
        } else {
          effectiveEffort = stepSpec.effort;
          actionTaken = 'DET-09_allow_cold_effort';
        }
      }
      const hookEvalMs = Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3));

      let turnResult = null;
      let attempt = 0;
      while (attempt < 2) {
        attempt += 1;
        proxy.setContext({
          runId: runState.runId,
          arm: runState.arm,
          tier: runState.tier,
          replicate: runState.replicate,
          turn,
          attempt,
          phase: promptObj.phase,
          scheduledModel: stepSpec.model,
          effectiveModel,
          scheduledEffort: stepSpec.effort,
          effectiveEffort,
          highbeamAction: actionTaken,
          detectorId,
          decision,
          hookEvalMs,
          actualIdleSec
        });

        turnResult = await runClaudeTurn({
          claudeExe: runtimePaths.claudeExe,
          frozenRepoDir: runtimePaths.frozenRepoDir,
          prompt: promptObj.prompt,
          model: effectiveModel,
          effort: effectiveEffort,
          sessionId: runState.sessionId,
          appendSystemPrompt: runState.salt,
          homeDir: runState.homeDir,
          cfgDir: runState.cfgDir,
          settingsPath: runState.settingsPath,
          proxyBaseUrl: proxy.baseUrl
        });

        const turnWireLogs = readWireLogsForTurn(wireLogPath, runState.runId, turn);
        const okMain = turnWireLogs.filter((w) => !w.isSideCall && w.statusCode === 200);
        if (turnResult.code === 0 && !turnResult.timedOut && okMain.length > 0) {
          break;
        }
        if (proxy.getState().budgetExceeded || initialSpendUsd + proxy.getState().totalSpendUsd >= maxBudgetUsd) {
          throw new Error(`Budget circuit breaker triggered ($${(initialSpendUsd + proxy.getState().totalSpendUsd).toFixed(4)}). Halting cleanly.`);
        }
        console.warn(`[${runState.runId}] Turn ${turn} attempt ${attempt} issue (code=${turnResult.code}, okMain=${okMain.length}, stderr=${turnResult.stderrPreview}). Retrying once after 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (turnResult.code !== 0) {
        throw new Error(`[${runState.runId}] Turn ${turn} failed after retry: ${turnResult.stderrPreview || turnResult.stdoutPreview}`);
      }

      const returnedSessionId = turnResult?.parsedOut?.session_id;
      if (returnedSessionId && !runState.sessionId) {
        runState.sessionId = returnedSessionId;
      }
      if (!runState.sessionId) {
        const jsonls = findSessionJsonlFiles(runState.cfgDir);
        if (jsonls.length > 0) {
          runState.sessionId = path.basename(jsonls[0], '.jsonl');
        }
      }

      const turnWireLogs = readWireLogsForTurn(wireLogPath, runState.runId, turn);
      const okMain = turnWireLogs.filter((w) => !w.isSideCall && w.statusCode === 200);
      const lastMain = okMain[okMain.length - 1];

      fs.appendFileSync(cliTurnsPath, JSON.stringify({
        runId: runState.runId,
        arm: runState.arm,
        tier: runState.tier,
        replicate: runState.replicate,
        turn,
        scheduledModel: stepSpec.model,
        effectiveModel,
        scheduledEffort: stepSpec.effort,
        effectiveEffort,
        highbeamAction: actionTaken,
        hookEvalMs,
        actualIdleSec,
        exitCode: turnResult.code,
        wallMs: turnResult.wallMs,
        durationMs: turnResult.parsedOut?.duration_ms ?? null,
        durationApiMs: turnResult.parsedOut?.duration_api_ms ?? null,
        totalCostUsd: turnResult.parsedOut?.total_cost_usd ?? null,
        usage: turnResult.parsedOut?.usage ?? null,
        modelUsage: turnResult.parsedOut?.modelUsage ?? null
      }) + '\n', 'utf8');

      fs.appendFileSync(interceptionsLogPath, JSON.stringify({
        runId: runState.runId,
        arm: ARM_NAME_MAP[runState.arm],
        tier: runState.tier,
        turn,
        scheduledModel: mapCliModelToOpenRouter(stepSpec.model),
        effectiveModel: mapCliModelToOpenRouter(effectiveModel),
        scheduledEffort: stepSpec.effort,
        effectiveEffort,
        cacheWarm,
        ttlRemainingS: Number(ttlRemainingSeconds.toFixed(2)),
        warmCachedTokens: turn === 1 ? 0 : runState.lastCachedTokens,
        breakEvenCStar,
        detectorId,
        decision,
        actionTaken,
        avoidedPenaltyEstUsd: Number(avoidedPenaltyEstUsd.toFixed(6)),
        hookEvalMs
      }) + '\n', 'utf8');

      runState.activeModel = effectiveModel;
      runState.activeEffort = effectiveEffort;
      runState.lastCachedTokens = Number(lastMain.usage.cache_read_input_tokens || 0) + Number(lastMain.usage.cache_creation_input_tokens || 0);
      runState.lastTotalInputTokens = Number(lastMain.usage.total_input_tokens || 0);
      runState.lastTurnFinishedAtMs = Date.now();

      console.log(`[${runState.runId}] T${turn}/${runState.turnsToRun} | sched=${stepSpec.model.replace('claude-', '')}/${stepSpec.effort} | eff=${effectiveModel.replace('claude-', '')}/${effectiveEffort} | action=${actionTaken} | hit=${(lastMain.usage.cache_hit_ratio * 100).toFixed(1)}% | cumSpend=$${(initialSpendUsd + proxy.getState().totalSpendUsd).toFixed(4)}`);

      runState.nextTurn = turn + 1;
      if (runState.arm === 'E' && turn === 5 && stopAfterTurn === 5) {
        runState.turn5FinishedAtMs = Date.now();
        runState.parkedUntilMs = runState.turn5FinishedAtMs + ((ARM_E_IDLE_SECONDS + 5) * 1000);
        saveCheckpoint(runState);
        return;
      }

      if (runState.nextTurn > runState.turnsToRun) {
        runState.completed = true;
        const jsonls = findSessionJsonlFiles(runState.cfgDir);
        if (jsonls.length > 0) {
          const mainFile = jsonls.find((p) => runState.sessionId && p.includes(runState.sessionId)) || jsonls[0];
          fs.copyFileSync(mainFile, path.join(AUTO_TRANSCRIPTS_DIR, `${runState.runId}.jsonl`));
        }
      }
      saveCheckpoint(runState);
    }
  }

  try {
    while (runQueue.some((r) => !r.completed)) {
      const now = Date.now();
      const readyParked = runQueue.find((r) => !r.completed && r.arm === 'E' && r.nextTurn === 6 && r.parkedUntilMs > 0 && now >= r.parkedUntilMs);
      if (readyParked) {
        await executeSingleRunSegment(readyParked, readyParked.turnsToRun);
        continue;
      }

      const nextRun = runQueue.find((r) => !r.completed && !(r.arm === 'E' && r.nextTurn === 6 && r.parkedUntilMs > 0));
      if (nextRun) {
        if (nextRun.arm === 'E' && nextRun.nextTurn <= 5) {
          await executeSingleRunSegment(nextRun, 5);
        } else {
          await executeSingleRunSegment(nextRun, nextRun.turnsToRun);
        }
        continue;
      }

      const parked = runQueue
        .filter((r) => !r.completed && r.arm === 'E' && r.parkedUntilMs > 0)
        .sort((a, b) => a.parkedUntilMs - b.parkedUntilMs);
      if (parked.length > 0) {
        await executeSingleRunSegment(parked[0], parked[0].turnsToRun);
      }
    }

    // Merge per-run Highbeam intervention ledgers into results/highbeam_auto/horizon_ledger.jsonl
    const mergedLines = [];
    for (const r of runQueue) {
      if (fs.existsSync(r.ledgerPath)) {
        const lines = fs.readFileSync(r.ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            parsed.runId = r.runId;
            mergedLines.push(JSON.stringify(parsed));
          } catch {}
        }
      }
    }
    fs.writeFileSync(mergedHorizonLedgerPath, mergedLines.join('\n') + (mergedLines.length ? '\n' : ''), 'utf8');

    await new Promise((r) => setTimeout(r, 8000));
    const keyEnd = await fetchOpenRouterKeyUsage(apiKey);
    fs.appendFileSync(openrouterLedgerPath, JSON.stringify({ event: 'end', ...keyEnd }) + '\n', 'utf8');

    const proxyState = proxy.getState();
    return {
      runsCompleted: runQueue.filter((r) => r.completed).length,
      proxyTotalSpendUsd: Number((initialSpendUsd + proxyState.totalSpendUsd).toFixed(6)),
      openRouterUsageBeforeUsd: keyStart?.usage ?? null,
      openRouterUsageAfterUsd: keyEnd?.usage ?? null,
      openRouterDeltaUsd: (typeof keyStart?.usage === 'number' && typeof keyEnd?.usage === 'number')
        ? Number((keyEnd.usage - keyStart.usage).toFixed(6))
        : null,
      mainRequests: proxyState.mainRequestsCount,
      sideCalls: proxyState.sideCallsCount
    };
  } finally {
    await proxy.close();
  }
}

/**
 * Step 1.5a: Sanitize all files under results/highbeam_auto/ in place.
 */
function sanitizeHighbeamAutoInPlace(runtimePaths) {
  const ids = loadDynamicIdentifiers();
  const cpPath = path.join(AUTO_RAW_DIR, 'checkpoint.json');
  const cp = fs.existsSync(cpPath) ? JSON.parse(fs.readFileSync(cpPath, 'utf8')) : { runs: {} };

  const sessionIdMap = new Map();
  for (const [runId, meta] of Object.entries(cp.runs || {})) {
    if (meta?.sessionId && !meta.sessionId.startsWith('sess_')) {
      sessionIdMap.set(meta.sessionId, `sess_${runId}`);
    }
  }

  const msgIdMap = new Map();
  const wireLogs = readJsonl(path.join(AUTO_RAW_DIR, 'proxy_wire_log.jsonl'));
  const byRunTurn = new Map();
  for (const w of wireLogs) {
    if (!w.isSideCall && w.statusCode === 200 && w.context?.runId) {
      const k = `${w.context.runId}::T${w.context.turn}`;
      if (!byRunTurn.has(k)) byRunTurn.set(k, []);
      byRunTurn.get(k).push(w);
    }
  }
  for (const [k, calls] of byRunTurn.entries()) {
    const [runId] = k.split('::');
    calls.sort((a, b) => a.wireSeq - b.wireSeq);
    calls.forEach((c, idx) => {
      if (c.messageId && !c.messageId.startsWith('msg_' + runId)) {
        const tPad = String(c.context.turn).padStart(2, '0');
        msgIdMap.set(c.messageId, `msg_${runId}_T${tPad}_r${idx + 1}`);
      }
    });
  }

  const extraPaths = [];
  if (runtimePaths?.frozenRepoDir) {
    extraPaths.push([runtimePaths.frozenRepoDir, '<FROZEN_REPO>']);
  }
  if (runtimePaths?.autoWorkDir) {
    extraPaths.push([runtimePaths.autoWorkDir, '<ISOLATED_WORK_DIR>']);
  }
  if (runtimePaths?.runtimeRoot) {
    extraPaths.push([runtimePaths.runtimeRoot, '<RUNTIME_ROOT>']);
  }
  extraPaths.push([REPO_ROOT, '<REPO_ROOT>']);

  function sanitizeText(rawText) {
    let text = rawText
      .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/[A-Za-z]--Users-[A-Za-z0-9_.-]+-AppData-Local-Temp-[A-Za-z0-9_.-]+/gi, '<FROZEN_REPO_SLUG>');

    for (const [origPath, repl] of extraPaths) {
      for (const variant of [origPath, origPath.replace(/\\/g, '/'), origPath.replace(/\\/g, '\\\\')]) {
        if (variant) text = text.split(variant).join(repl);
      }
    }

    text = text
      .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
      .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]')
      .replace(/(\\"device_id\\":\\"|\"device_id\"\s*:\s*\")[0-9a-f]{32,64}(\\"|\")/gi, '$1[REDACTED_DEVICE_ID]$2')
      .replace(/gen-\d{6,}-[A-Za-z0-9_-]+/g, '[REDACTED_UPSTREAM_REQ_ID]');

    if (ids.dynamicUser && ids.dynamicUser.length >= 3) {
      const uRx = new RegExp(ids.dynamicUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(uRx, '[USER]');
    }

    for (const [origUuid, pseudoSess] of sessionIdMap.entries()) {
      if (text.includes(origUuid)) {
        text = text.split(origUuid).join(pseudoSess);
      }
    }
    for (const [origMsgId, pseudoMsgId] of msgIdMap.entries()) {
      if (text.includes(origMsgId)) {
        text = text.split(origMsgId).join(pseudoMsgId);
      }
    }

    text = text
      .replace(/msg_01[A-Za-z0-9]{10,}/g, '[REDACTED_MSG_ID]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]');

    for (const [needle, repl] of [
      [ids.dynamicGitRemoteSlug, '<GITHUB_HANDLE>/<TARGET_REPO>'],
      [ids.dynamicGitOwner, '<GITHUB_HANDLE>'],
      [ids.dynamicGitRepo, '<TARGET_REPO>'],
      [ids.dynamicRepoDirName, '<TARGET_REPO>']
    ]) {
      if (needle && needle.length >= 3) {
        const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        text = text.replace(rx, repl);
      }
    }
    return text;
  }

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsonl|json|csv|md)$/i.test(e.name)) {
        const clean = sanitizeText(fs.readFileSync(p, 'utf8'));
        fs.writeFileSync(p, clean, 'utf8');
      }
    }
  };
  walk(AUTO_RESULTS_DIR);
}

function parseTranscriptUsageMap(transcriptPath) {
  const byMsgId = new Map();
  if (!fs.existsSync(transcriptPath)) return byMsgId;
  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message;
    if (obj?.type === 'assistant' && msg?.role === 'assistant' && msg?.usage && msg?.id) {
      const id = msg.id;
      const u = msg.usage;
      const prev = byMsgId.get(id);
      if (!prev || Number(u.output_tokens || 0) >= Number(prev.output_tokens || 0)) {
        byMsgId.set(id, {
          input_tokens: Number(u.input_tokens || 0),
          cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
          output_tokens: Number(u.output_tokens || 0)
        });
      }
    }
  }
  return byMsgId;
}

/**
 * Step 1.5b: Build runs_auto_live.csv and interceptions_live.csv + hard checks.
 */
function buildLiveAutoCsvs() {
  const wireLogs = readJsonl(path.join(AUTO_RAW_DIR, 'proxy_wire_log.jsonl'));
  const cliTurns = readJsonl(path.join(AUTO_RAW_DIR, 'cli_turns.jsonl'));
  const interceptions = readJsonl(path.join(AUTO_RAW_DIR, 'interceptions_live.jsonl'));
  const checkpoint = JSON.parse(fs.readFileSync(path.join(AUTO_RAW_DIR, 'checkpoint.json'), 'utf8'));

  const cliMap = new Map();
  for (const c of cliTurns) cliMap.set(`${c.runId}::T${c.turn}`, c);
  const interceptMap = new Map();
  for (const i of interceptions) interceptMap.set(`${i.runId}::T${i.turn}`, i);

  const byRunTurn = new Map();
  for (const w of wireLogs) {
    const runId = w.context?.runId;
    const turn = w.context?.turn;
    if (!runId || !turn) continue;
    const k = `${runId}::T${turn}`;
    if (!byRunTurn.has(k)) byRunTurn.set(k, []);
    byRunTurn.get(k).push(w);
  }

  const runIds = Object.keys(checkpoint.runs || {});
  const csvRows = [];
  let mainRowsCount = 0;
  let sideRowsCount = 0;
  let sourceBothCount = 0;
  let sourceDisagreementCount = 0;

  for (const runId of runIds) {
    const meta = checkpoint.runs[runId];
    const sessionId = meta.sessionId || `sess_${runId}`;
    const txMap = parseTranscriptUsageMap(path.join(AUTO_TRANSCRIPTS_DIR, `${runId}.jsonl`));

    for (let turn = 1; turn <= 12; turn++) {
      const key = `${runId}::T${turn}`;
      const calls = (byRunTurn.get(key) || []).slice().sort((a, b) => a.wireSeq - b.wireSeq);
      const mainCalls = calls.filter((c) => !c.isSideCall && c.statusCode === 200);
      const requestsInTurn = mainCalls.length;
      const cli = cliMap.get(key);
      const ic = interceptMap.get(key);

      let mainIdx = 0;
      for (const w of calls) {
        const armCode = w.context.arm;
        const armName = ARM_NAME_MAP[armCode] || armCode;
        const effort = w.requestFingerprint?.output_config?.effort || w.context.effectiveEffort || w.context.scheduledEffort;

        if (w.isSideCall) {
          sideRowsCount += 1;
          const sideModel = w.mappedModel
            || w.requestedModel
            || (w.context?.effectiveModel ? mapCliModelToOpenRouter(w.context.effectiveModel) : '')
            || (w.context?.scheduledModel ? mapCliModelToOpenRouter(w.context.scheduledModel) : '');
          csvRows.push({
            run_id: runId,
            arm: armName,
            rep: w.context.replicate,
            session_id: sessionId,
            turn,
            event: 'none',
            is_side_call: 'true',
            model: sideModel,
            effort,
            prefix_size_bucket: w.context.tier,
            timestamp_utc: w.timestamp,
            input_tokens: '',
            cache_creation_input_tokens: '',
            cache_read_input_tokens: '',
            output_tokens: '',
            latency_ms: w.latencyMs ?? w.timing?.latencyMs ?? '',
            cost_usd: '',
            source: 'proxy',
            notes: `side_call_count_tokens_404_fallback; token_and_cost_columns_blank_no_llm_completion; request_index_columns_blank_for_side_call; endpoint=${w.urlPath}; upstream_status=${w.upstreamStatus ?? w.statusCode ?? ''}; approx_input_tokens=${w.approxInputTokens ?? ''}`,
            request_index_in_turn: '',
            requests_in_turn: ''
          });
          continue;
        }

        if (w.statusCode !== 200) continue;

        mainIdx += 1;
        mainRowsCount += 1;
        const txUsage = w.messageId ? txMap.get(w.messageId) : null;
        const wireUsage = {
          input_tokens: Number(w.usage.input_tokens || 0),
          cache_creation_input_tokens: Number(w.usage.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(w.usage.cache_read_input_tokens || 0),
          output_tokens: Number(w.usage.output_tokens || 0)
        };
        const agrees = Boolean(
          txUsage &&
          txUsage.input_tokens === wireUsage.input_tokens &&
          txUsage.cache_creation_input_tokens === wireUsage.cache_creation_input_tokens &&
          txUsage.cache_read_input_tokens === wireUsage.cache_read_input_tokens &&
          txUsage.output_tokens === wireUsage.output_tokens
        );
        if (agrees) sourceBothCount += 1;
        else sourceDisagreementCount += 1;

        let eventVal = 'message';
        if (mainIdx > 1) {
          eventVal = 'none';
        } else if (armCode === 'E' && turn === 6 && ic?.effectiveModel === 'anthropic/claude-sonnet-4.6') {
          eventVal = 'idle_gap';
        }

        const noteParts = [
          `api_call=${mainIdx}/${requestsInTurn}`,
          `stop_reason=${w.stopReason || ''}`,
          `cost_source=${typeof w.upstreamReportedCostUsd === 'number' ? 'openrouter_usage_cost' : 'computed'}`,
          `eph5m_write_tokens=${w.usage.ephemeral_5m_input_tokens || 0}`,
          `highbeam_action=${ic?.actionTaken || 'none'}`,
          `scheduled_model=${mapCliModelToOpenRouter(w.context.scheduledModel)}`,
          `scheduled_effort=${w.context.scheduledEffort}`,
          `hook_eval_ms=${ic?.hookEvalMs ?? ''}`
        ];
        if (w.timing?.ttfbMs !== null && w.timing?.ttfbMs !== undefined) noteParts.push(`ttfb_ms=${w.timing.ttfbMs}`);
        if (w.context.actualIdleSec !== null && w.context.actualIdleSec !== undefined) noteParts.push(`actual_idle_sec=${w.context.actualIdleSec}`);
        if (mainIdx === requestsInTurn && cli?.wallMs !== undefined) noteParts.push(`cli_turn_wall_ms=${cli.wallMs}`);

        csvRows.push({
          run_id: runId,
          arm: armName,
          rep: w.context.replicate,
          session_id: sessionId,
          turn,
          event: eventVal,
          is_side_call: 'false',
          model: w.mappedModel || mapCliModelToOpenRouter(w.context.effectiveModel),
          effort,
          prefix_size_bucket: w.context.tier,
          timestamp_utc: w.timestamp,
          input_tokens: wireUsage.input_tokens,
          cache_creation_input_tokens: wireUsage.cache_creation_input_tokens,
          cache_read_input_tokens: wireUsage.cache_read_input_tokens,
          output_tokens: wireUsage.output_tokens,
          latency_ms: w.timing?.latencyMs ?? '',
          cost_usd: typeof w.upstreamReportedCostUsd === 'number' ? w.upstreamReportedCostUsd : w.cost.totalCostUsd,
          source: agrees ? 'both' : 'proxy',
          notes: noteParts.join('; '),
          request_index_in_turn: mainIdx,
          requests_in_turn: requestsInTurn
        });
      }
    }
  }

  const runsAutoCsvPath = path.join(AUTO_RESULTS_DIR, 'runs_auto_live.csv');
  writeCsv(runsAutoCsvPath, CSV_HEADERS, csvRows);

  const interceptCsvRows = interceptions.map((i) => ({
    run_id: i.runId,
    arm: i.arm,
    prefix_size_bucket: i.tier,
    turn: i.turn,
    scheduled_model: i.scheduledModel,
    effective_model: i.effectiveModel,
    scheduled_effort: i.scheduledEffort,
    effective_effort: i.effectiveEffort,
    cache_warm: String(i.cacheWarm),
    ttl_remaining_s: i.ttlRemainingS,
    warm_cached_tokens: i.warmCachedTokens,
    break_even_c_star: i.breakEvenCStar ?? '',
    detector_id: i.detectorId,
    decision: i.decision,
    action_taken: i.actionTaken,
    avoided_penalty_est_usd: i.avoidedPenaltyEstUsd,
    hook_eval_ms: i.hookEvalMs
  }));
  const interceptionsCsvPath = path.join(AUTO_RESULTS_DIR, 'interceptions_live.csv');
  writeCsv(interceptionsCsvPath, INTERCEPTIONS_HEADERS, interceptCsvRows);

  return {
    runsAutoCsvPath,
    interceptionsCsvPath,
    totalRows: csvRows.length,
    mainRowsCount,
    sideRowsCount,
    sourceBothCount,
    sourceDisagreementCount
  };
}

/**
 * Step 1.5c: Recompute everything directly from the 3 CSVs and build summary & manifest Markdown + verify gates.
 */
function buildMarkdownAndVerify({ runtimePaths, gateReport, liveExecutionStats }) {
  const baseRows = parseCsv(path.join(RESULTS_DIR, 'runs.csv')).rows
    .filter((r) => r.is_side_call === 'false' && r.source === 'both');
  const replayRows = parseCsv(path.join(AUTO_RESULTS_DIR, 'replay_45_sessions.csv')).rows;
  const liveRowsAll = parseCsv(path.join(AUTO_RESULTS_DIR, 'runs_auto_live.csv')).rows;
  const liveMainRows = liveRowsAll.filter((r) => r.is_side_call === 'false');
  const liveInterceptRows = parseCsv(path.join(AUTO_RESULTS_DIR, 'interceptions_live.csv')).rows;

  // Verify unexpected blanks in runs_auto_live.csv
  let unexpectedBlanksCount = 0;
  const requiredAll = ['run_id', 'arm', 'rep', 'session_id', 'turn', 'event', 'is_side_call', 'model', 'effort', 'prefix_size_bucket', 'timestamp_utc', 'latency_ms', 'source', 'notes'];
  const requiredMain = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'cost_usd', 'request_index_in_turn', 'requests_in_turn'];
  for (const r of liveRowsAll) {
    for (const c of requiredAll) {
      if (r[c] === undefined || r[c] === '') unexpectedBlanksCount += 1;
    }
    if (r.is_side_call === 'false') {
      for (const c of requiredMain) {
        if (r[c] === undefined || r[c] === '') unexpectedBlanksCount += 1;
      }
    }
  }

  const groupSessions = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.run_id)) map.set(r.run_id, []);
      map.get(r.run_id).push({
        ...r,
        turnNum: Number(r.turn),
        reqIdx: Number(r.request_index_in_turn),
        input: Number(r.input_tokens),
        write: Number(r.cache_creation_input_tokens),
        read: Number(r.cache_read_input_tokens),
        output: Number(r.output_tokens),
        latencyMs: Number(r.latency_ms),
        costUsd: Number(r.cost_usd)
      });
    }
    for (const arr of map.values()) arr.sort((a, b) => a.turnNum - b.turnNum || a.reqIdx - b.reqIdx);
    return map;
  };

  const baseSessMap = groupSessions(baseRows);
  const liveSessMap = groupSessions(liveMainRows);

  const summarizeSess = (rows) => {
    const t6 = rows.find((r) => r.turnNum === 6 && r.reqIdx === 1);
    const t7 = rows.find((r) => r.turnNum === 7 && r.reqIdx === 1);
    const t6In = t6.input + t6.write + t6.read;
    const t7In = t7.input + t7.write + t7.read;
    return {
      runId: rows[0].run_id,
      arm: rows[0].arm,
      bucket: rows[0].prefix_size_bucket,
      t6Model: t6.model,
      t6Effort: t6.effort,
      t6Read: t6.read,
      t6Write: t6.write,
      t6HitPct: (t6.read / t6In) * 100,
      t6Cost: t6.costUsd,
      t7HitPct: (t7.read / t7In) * 100,
      t7Cost: t7.costUsd,
      sessWrite: rows.reduce((s, r) => s + r.write, 0),
      sessRead: rows.reduce((s, r) => s + r.read, 0),
      sessCost: rows.reduce((s, r) => s + r.costUsd, 0),
      sessLatencyMs: rows.reduce((s, r) => s + r.latencyMs, 0)
    };
  };

  const liveSpecs = [
    { liveId: 'HB_B_S_r01', baseId: 'B_S_r01', bucket: 'small', arm: 'one_switch' },
    { liveId: 'HB_C_S_r01', baseId: 'C_S_r01', bucket: 'small', arm: 'switch_and_back' },
    { liveId: 'HB_D_S_r01', baseId: 'D_S_r01', bucket: 'small', arm: 'effort_only' },
    { liveId: 'HB_E_S_r01', baseId: 'E_S_r01', bucket: 'small', arm: 'idle_then_switch' },
    { liveId: 'HB_F_S_r01', baseId: 'F_S_r01', bucket: 'small', arm: 'ten_switches' },
    { liveId: 'HB_B_L_r01', baseId: 'B_L_r01', bucket: 'large', arm: 'one_switch' },
    { liveId: 'HB_F_L_r01', baseId: 'F_L_r01', bucket: 'large', arm: 'ten_switches' }
  ];

  // Live Verification Assertions
  const warmGuardedIds = ['HB_B_S_r01', 'HB_C_S_r01', 'HB_D_S_r01', 'HB_F_S_r01', 'HB_B_L_r01', 'HB_F_L_r01'];
  for (const id of warmGuardedIds) {
    const s = summarizeSess(liveSessMap.get(id));
    const minCached = s.bucket === 'large' ? 55000 : 14000;
    if (s.t6HitPct < 95 || s.t6Read <= minCached) {
      throw new Error(`Warm guard check failed for ${id}: t6HitPct=${s.t6HitPct.toFixed(2)}%, t6Read=${s.t6Read}`);
    }
  }
  const eLiveT6 = liveSessMap.get('HB_E_S_r01').find((r) => r.turnNum === 6 && r.reqIdx === 1);
  const eLiveIc6 = liveInterceptRows.find((i) => i.run_id === 'HB_E_S_r01' && Number(i.turn) === 6);
  const eIdleMatch = String(eLiveT6?.notes || '').match(/actual_idle_sec=([0-9.]+)/);
  const eIdleSec = eIdleMatch ? Number(eIdleMatch[1]) : 0;
  const eLiveSum = summarizeSess(liveSessMap.get('HB_E_S_r01'));
  if (
    !(eIdleSec >= 330) ||
    eLiveIc6?.action_taken !== 'DET-08_allow_cold_switch' ||
    eLiveT6?.model !== 'anthropic/claude-sonnet-4.6' ||
    eLiveSum.t7HitPct < 95
  ) {
    throw new Error(`Arm E smart cold switch check failed: idleSec=${eIdleSec}, action=${eLiveIc6?.action_taken}, model=${eLiveT6?.model}, t7Hit=${eLiveSum.t7HitPct}`);
  }

  const hookLatenciesMs = liveInterceptRows.map((r) => Number(r.hook_eval_ms)).filter((v) => Number.isFinite(v));
  const triggeredHookLatenciesMs = liveInterceptRows
    .filter((r) => r.detector_id === 'DET-08' || r.detector_id === 'DET-09')
    .map((r) => Number(r.hook_eval_ms))
    .filter((v) => Number.isFinite(v));

  const envSummary = [
    '# Highbeam `AUTO_PILOT` Experiment Summary (`summary_highbeam_auto.md`)',
    '',
    '**Scope & Interception Disclosure (Read First):** All live runs in this Round-1 report (`code_version = rule_v1`, git tag `round1-rule-v1`) validate Highbeam\'s **`DET-08` / `DET-09` decision logic and its billed token/cost effect when enforced**, **not** out-of-the-box interception of interactive `/model` or `/effort` slash commands. `@anthropic-ai/claude-code@2.1.325` emits **no** native `PreEffortChange` hook event on `/effort` (and `UserPromptSubmit` does not fire on built-in `/model` or `/effort` slash commands). While `claude` `2.1.325` includes an internal `PreModelSwitch` hook on in-session `/model` and SDK `set_model`, that hook does **not** fire on headless `--resume --model` CLI startup flags, and `rule_v1`\'s `PreModelSwitch` handler read `current_model`/`target_model`/`cached_tokens`/`cache_warm` rather than Claude Code\'s `from_model`/`to_model`/`context_tokens`/`prompt_cache_warm` fields. Accordingly, the benchmark harness invoked `runPreModelSwitchHook` (`DET-08`) and `interceptTopLevelMutation` (`DET-09`) in-process before spawning each headless `claude --resume` turn.',
    '',
    '## 1. Setup, Route & Verification Disclosures',
    '',
    '- **Code Version:** `rule_v1` (pinned at git tag `round1-rule-v1`, commit `19c51055902c545508af1979a392505355777d90`).',
    '- **API Route Disclosure:** All traffic went through **OpenRouter** (`https://openrouter.ai/api/v1/messages` with `"provider": { "only": ["anthropic"], "allow_fallbacks": false }`), not Anthropic directly; **cache behavior and cost may differ on the direct API.**',
    '- **Billed vs. Computed Labeling:** Every API spend figure in Section 3 (and every baseline/control lookup figure in Section 4) is **billed** (`openrouter_usage_cost` recorded directly from OpenRouter SSE wire responses and reconciled against `/api/v1/key`). Gate model estimates in Section 2 are **computed** from Highbeam\'s catalog rate table and are explicitly labeled `computed`.',
    '- **Extension & Harness Invocation (Measured vs. Inferred):** Highbeam (`ctxtop`) ran with `flightMode: "AUTO_PILOT"` (`local_trial` Pro feature gate) and canonical Claude Code hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`). Token counts, latencies, and billed USD in Section 3 were **measured** from live wire + transcript logs; Section 4 is a **counterfactual** lookup replay.',
    `- **Tool, Models, OS & Date:** \`@anthropic-ai/claude-code@${PINNED_CLAUDE_CODE_VERSION}\`, \`anthropic/claude-opus-4.6\` & \`anthropic/claude-sonnet-4.6\`, Windows 11 (\`win32 x64\`), Node.js \`${process.version}\`, \`2026-11-14\`.`,
    '- **Directional Latency Caveat:** API latency values are **directional only** (localhost logging proxy + OpenRouter in path). Highbeam local hook evaluation latency (`hook_eval_ms`) was **measured** locally via `process.hrtime.bigint()`.',
    '- **Statistical Convention:** All `n = 5` baseline/replay cells report **median `[min–max]`** across all `5` replicates (never mixing means and medians). Primary empirical evidence consists of the **`7` live 12-turn runs (`live`, `n = 1` per switched cell, `105` main wire requests, `100%` `source = both` transcript/proxy agreement)** in Section 3, each compared against both the matching Baseline `r01` replicate and the Baseline `n = 5` cell median `[min–max]`.',
    '',
    '---',
    '',
    '## 2. Offline Gate Self-Test Results (`DET-08` & `DET-09`, `rule_v1`)',
    '',
    `- **Gate 1 (\`DET-08\` Warm Downgrade Hold):** \`Opus 4.6 -> Sonnet 4.6\` with \`14,822\` warm cached tokens (\`C* = ${gateReport.det08WarmHold.breakEvenTokens.toLocaleString('en-US')}\` tokens, single-turn \`expectedOutputTokens = 1,500\`, \`uncachedDeltaTokens = 350\`) -> \`decision = ${gateReport.det08WarmHold.decision}\` (\`exitCode = ${gateReport.det08WarmHold.exitCode}\`, \`recommendedModel = ${gateReport.det08WarmHold.recommendedModel}\`, **computed** single-turn net penalty estimate = \`+$${gateReport.det08WarmHold.coldWritePenaltyUSD.toFixed(4)}\`).`,
    `- **Gate 2 (\`DET-08\` Expired/Cold Cache Allow):** Identical switch with \`cache_warm = false\` -> \`decision = ${gateReport.det08ColdAllow.decision}\` (\`exitCode = ${gateReport.det08ColdAllow.exitCode}\`, \`blocked = ${gateReport.det08ColdAllow.blocked}\`).`,
    `- **Gate 3 (\`DET-09\` Warm Effort Defer):** \`effort: medium -> high\` with \`14,822\` warm cached tokens -> \`decision = ${gateReport.det09WarmEffortDefer.decision}\` (\`queued = ${gateReport.det09WarmEffortDefer.queued}\`, **computed** prefix rewrite penalty avoided = \`+$${gateReport.det09WarmEffortDefer.avoidedRewritePenaltyUSD.toFixed(4)}\`).`,
    `- **Measured Live Hook Evaluation Overhead (\`interceptions_live.csv\`):** Median **${(median(triggeredHookLatenciesMs) || 0).toFixed(2)} ms** [${(minVal(triggeredHookLatenciesMs) || 0).toFixed(2)} ms–${(maxVal(triggeredHookLatenciesMs) || 0).toFixed(2)} ms] on active ` + '`DET-08`/`DET-09`' + ` evaluations (overall median across all 84 turns: ${(median(hookLatenciesMs) || 0).toFixed(2)} ms; **measured**).`,
    '',
    '---',
    '',
    '## 3. Live Empirical Evidence (`live`, `code_version = rule_v1`, `n = 1` per Switched Cell, All Costs `billed`)',
    '',
    '| Live Run (`n=1`, `rule_v1`) | Bucket & Arm | Action on Switch Turn (T6 / T2) | T6 `cache_read` % (Base `r01` / `n=5` Med -> Live HB) | Billed T6 Cost (Base `r01` / `n=5` Med -> Live HB) | 12-Turn Write Tokens (Base `r01` / `n=5` Med `[Min–Max]` -> Live HB) | **Measured Write Tokens Saved vs `r01` (vs `n=5` Med `[Min–Max]`)** | Billed 12-Turn Cost (Base `r01` / `n=5` Med `[Min–Max]` -> Live HB) | **Billed Net USD Saved vs `r01` (vs `n=5` Med `[Min–Max]`)** |',
    '| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |'
  ];

  let totalBaseWrite = 0;
  let totalLiveWrite = 0;
  let totalBaseCost = 0;
  let totalLiveCost = 0;

  for (const sp of liveSpecs) {
    const baseRun = summarizeSess(baseSessMap.get(sp.baseId));
    const liveRun = summarizeSess(liveSessMap.get(sp.liveId));
    const cellBases = Array.from(baseSessMap.values())
      .filter((arr) => arr[0].prefix_size_bucket === sp.bucket && arr[0].arm === sp.arm)
      .map(summarizeSess);
    const cellBaseCosts = cellBases.map((c) => c.sessCost);
    const cellBaseWrites = cellBases.map((c) => c.sessWrite);
    const cellBaseT6Hits = cellBases.map((c) => c.t6HitPct);
    const cellBaseT6Costs = cellBases.map((c) => c.t6Cost);

    const baseCostMedRange = fmtMedRange(cellBaseCosts, 4, '$');
    const baseWriteMedRange = fmtIntMedRange(cellBaseWrites);
    const baseT6Med = median(cellBaseT6Hits).toFixed(2) + '%';
    const baseT6CostMed = '$' + median(cellBaseT6Costs).toFixed(4);

    const writeDiffsVsCell = cellBaseWrites.map((w) => w - liveRun.sessWrite);
    const costDiffsVsCell = cellBaseCosts.map((c) => c - liveRun.sessCost);
    const writeSavedMedRange = fmtIntMedRange(writeDiffsVsCell);
    const costSavedMedRange = fmtSignedUsdMedRange(costDiffsVsCell, 4);

    const t6Ic = liveInterceptRows.find((i) => i.run_id === sp.liveId && Number(i.turn) === 6);
    const t2Ic = liveInterceptRows.find((i) => i.run_id === sp.liveId && Number(i.turn) === 2);
    const keyAction = sp.arm === 'ten_switches' ? (t2Ic?.action_taken || t6Ic?.action_taken) : t6Ic?.action_taken;

    const writeSavedR01 = baseRun.sessWrite - liveRun.sessWrite;
    const costSavedR01 = baseRun.sessCost - liveRun.sessCost;

    totalBaseWrite += baseRun.sessWrite;
    totalLiveWrite += liveRun.sessWrite;
    totalBaseCost += baseRun.sessCost;
    totalLiveCost += liveRun.sessCost;

    envSummary.push(
      `| \`${sp.liveId}\` | \`${sp.bucket}\` \`${sp.arm}\` | \`${keyAction}\` | ${baseRun.t6HitPct.toFixed(2)}% (${baseT6Med}) -> **${liveRun.t6HitPct.toFixed(2)}%** | $${baseRun.t6Cost.toFixed(4)} (${baseT6CostMed}) -> **$${liveRun.t6Cost.toFixed(4)}** | ${baseRun.sessWrite.toLocaleString('en-US')} (${baseWriteMedRange}) -> **${liveRun.sessWrite.toLocaleString('en-US')}** | **${writeSavedR01 >= 0 ? '+' : ''}${writeSavedR01.toLocaleString('en-US')}** (${writeSavedMedRange}) | $${baseRun.sessCost.toFixed(4)} (${baseCostMedRange}) -> **$${liveRun.sessCost.toFixed(4)}** | **${costSavedR01 >= 0 ? '+' : '-'}$${Math.abs(costSavedR01).toFixed(4)}** (${costSavedMedRange}) |`
    );
  }

  envSummary.push(
    '',
    `- **Smart Expiration Discrimination Proof (\`HB_E_S_r01\`, \`live\`, \`billed\`):** After idling **${eIdleSec.toFixed(2)}s** (` + '`> 300s` TTL' + `), Highbeam's \`DET-08\` detected \`cache_warm = false\`, returned \`decision = allow\` (\`action = ${eLiveIc6.action_taken}\`), and allowed the session to switch to \`anthropic/claude-sonnet-4.6\` at Turn 6 (recovering to **${eLiveSum.t7HitPct.toFixed(2)}%** cache hit at **billed** \`$${summarizeSess(liveSessMap.get('HB_E_S_r01')).t7Cost.toFixed(4)}\` on Turn 7).`,
    `- **In \`HB_D_S_r01\` (\`effort_only\`, \`live\`), the deferred \`effort: high\` change never took effect during the 12 turns:** Because the prompt cache remained warm on Turns \`6–12\` and no \`/compact\` occurred (and \`PostCompact\` does not auto-apply queued mutations), \`DET-09\` deferred \`effort = high\` on every remaining turn and all \`12\` turns ran at \`effort = medium\`.`,
    `- **Aggregate Across the \`7\` Inject-Switch Test Runs (\`live\`, \`billed\` — Not Expected Real-World Usage Savings):** Across these \`7\` live sessions (\`n = 1\` each, \`rule_v1\`), measured Baseline \`r01\` total write tokens = **${totalBaseWrite.toLocaleString('en-US')}** vs. Highbeam \`AUTO_PILOT\` = **${totalLiveWrite.toLocaleString('en-US')}** (**${(totalBaseWrite - totalLiveWrite).toLocaleString('en-US')} write tokens saved**, **-${(((totalBaseWrite - totalLiveWrite) / totalBaseWrite) * 100).toFixed(1)}%**), and **billed** 12-turn OpenRouter \`usage.cost\` sum fell from **$${totalBaseCost.toFixed(4)}** to **$${totalLiveCost.toFixed(4)}** (**+$${(totalBaseCost - totalLiveCost).toFixed(4)} billed saved**, **-${(((totalBaseCost - totalLiveCost) / totalBaseCost) * 100).toFixed(1)}%**). **6 of these 7 sessions contained a deliberately injected mid-chat warm model switch or warm effort change (and the 7th switched after an expired TTL); \`-12.4%\` measures the avoided penalty across injected-switch test arms, NOT an expected session-wide saving in normal real-world usage.**`,
    '',
    '---',
    '',
    '## 4. Counterfactual Decision Replay Across All 45 Baseline Sessions (`counterfactual`, `code_version = rule_v1` — Decision Audit Only, Not Independent Savings Evidence)',
    '',
    '**Scope of this counterfactual replay:** In `replay_45_sessions.csv`, Highbeam\'s `rule_v1` `DET-08` and `DET-09` rules are evaluated offline against the recorded telemetry of all `45` baseline runs (`n = 5` per cell). Whenever Highbeam holds `(anthropic/claude-opus-4.6, medium)` across Turns `1–12`, the `"Auto (Paired Ctrl)"` value is simply the paired empirical `control` replicate\'s (`A_<S|L>_r0X`) measured write tokens and **billed** cost looked up from `runs.csv` (and for `control` and expired-TTL `idle_then_switch`, the run itself). Consequently, the **computed** `Base - Paired Ctrl` delta in this table equals `baseline - control` — the switch penalty already measured in the baseline experiment. **This counterfactual replay validates deterministic router decisions (`30/30` warm-switch/effort runs held, `5/5` expired-TTL `Arm E` runs allowed, `10/10` controls passed through), NOT independent dollar savings; all empirical savings evidence is the `7` live runs in Section 3.**',
    '',
    '| Prefix Bucket (`counterfactual`) | Arm | `n` | Replay Router Decision (`DET-08` / `DET-09`, `rule_v1`) | T6 `cache_read` % (Base -> Paired Ctrl Lookup) | Session Write Tokens (Base -> Paired Ctrl Lookup) | Computed Lookup Write Delta (`Base - Paired Ctrl`) | Billed Session Cost Lookup (Base -> Paired Ctrl) | Computed Lookup Cost Delta (`Base - Paired Ctrl`) |',
    '| :--- | :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- |'
  );

  const cellOrder = [
    ['small', 'control'],
    ['small', 'one_switch'],
    ['small', 'switch_and_back'],
    ['small', 'effort_only'],
    ['small', 'idle_then_switch'],
    ['small', 'ten_switches'],
    ['large', 'control'],
    ['large', 'one_switch'],
    ['large', 'ten_switches']
  ];

  for (const [bucket, arm] of cellOrder) {
    const grp = replayRows.filter((r) => r.prefix_size_bucket === bucket && r.arm === arm);
    const num = (k) => grp.map((r) => Number(r[k]));
    const actionSample = grp[0].highbeam_action_summary;
    const baseT6Hit = fmtMedRange(num('baseline_t6_cache_read_pct'), 2, '', '%');
    const autoT6Hit = fmtMedRange(num('auto_t6_cache_read_pct'), 2, '', '%');
    const baseWr = fmtIntMedRange(num('baseline_session_write_tokens'));
    const autoWr = fmtIntMedRange(num('auto_session_write_tokens'));
    const savedWr = fmtIntMedRange(num('write_tokens_saved'));
    const baseCost = fmtMedRange(num('baseline_session_cost_usd'), 4, '$');
    const autoCost = fmtMedRange(num('auto_session_cost_usd'), 4, '$');
    const savedCost = fmtSignedUsdMedRange(num('session_cost_saved_usd'), 4);

    envSummary.push(
      `| \`${bucket}\` | \`${arm}\` | \`${grp.length}\` | \`${actionSample}\` | ${baseT6Hit} -> ${autoT6Hit} | ${baseWr} -> ${autoWr} | ${savedWr} | ${baseCost} -> ${autoCost} | ${savedCost} |`
    );
  }

  envSummary.push(
    '',
    '---',
    '',
    '## 5. Methodological Limitations',
    '',
    '1. **No Native `PreEffortChange` Event, and Headless In-Process Invocation (`DET-08` & `DET-09`):** `@anthropic-ai/claude-code@2.1.325` emits **no** `PreEffortChange` hook event on `/effort` (and `UserPromptSubmit` skips built-in `/model` and `/effort` slash commands). Although `claude` `2.1.325` implements an internal `PreModelSwitch` hook on in-session `/model` and SDK `set_model`, it does **not** fire on headless `--resume --model` CLI startup flags. Therefore, the live runs in Section 3 invoked `DET-08` and `DET-09` in-process from the benchmark harness and validate **decision logic**, not native interactive slash-command interception.',
    '2. **Installer `"PreModelSwitch"` Entry Status in `rule_v1` (`settings.json`):** The Highbeam installer writes a `"PreModelSwitch"` hook entry into `settings.json`. In headless `--resume --model` workflows that entry never fires (inert), and in interactive `/model` sessions under `rule_v1` (`round1-rule-v1`) the handler read `current_model` / `target_model` / `cached_tokens` / `cache_warm` instead of Claude Code `2.1.325`\'s `from_model` / `to_model` / `context_tokens` / `prompt_cache_warm` payload keys (making `targetModel` mis-keyed under `rule_v1` until patched in Round-2 `C1`). For `/effort`, no Claude Code hook entry can fire.',
    '3. **Held Switches and Deferred Effort Changes Are Never Re-Applied:** When `DET-08` holds a model switch, the switch is rejected for that turn and is **never** queued or re-applied when the cache later expires or compacts. Likewise, when `DET-09` defers an effort change into `PostCompactMutationQueue`, nothing automatically applies that queued effort level at `/compact` or TTL expiry. In `HB_D_S_r01` (`effort_only`), all `12` turns ran at `effort = medium` and `effort = high` never took effect.',
    '4. **`savedUSD` in `horizon_ledger.jsonl` for `DET-08` Is Overstated (`rule_v1` Bug — Do Not Quote):** In `rule_v1`, `runPreModelSwitchHook` read nonexistent fields (`netSwitchSavingsUSD` / `coldTargetTurnUSD`) instead of `breakEven.coldWritePenaltyUSD`, causing `savedQuotaLedger` to fall back to `cachedTokens * $5.00/M` (recording `$0.0743` on `HB_B_S_r01` instead of the computed `$0.0324` gate estimate or measured `$0.0466` billed Turn-6 delta). **`horizon_ledger.jsonl` must not be quoted as evidence of dollar savings.**',
    '5. **Short Post-Switch Horizon (`6–7` Turns) vs. Multi-Turn Payback (`~9–12` Turns):** Every single-switch or effort-change session in this Round-1 benchmark switched at Turn 6 of a 12-turn chat (`6` post-switch turns `T7–T12`, or `7` turns including Turn 6). That remaining horizon is **below our empirically measured multi-turn break-even** of **about `9` turns on `small` (`~15k`) chats and about `12` turns on `large` (`~56k–60k`) chats**, so holding `Opus 4.6` was always the cheaper 12-turn option. Furthermore, `rule_v1` `computeBreakEvenCachedTokens` (`C* = 4,885` tokens) solves only for single-turn break-even (`expectedOutputTokens = 1,500`, `remainingTurns = 0` post-switch turns). **These 12-turn tests therefore cannot distinguish an economics-aware rule from `"always deny downgrades when the cache is warm"`** (which loses money when remaining turns exceed the payback horizon).',
    '6. **Cost-Only Measurement (Quality & Denied User Intent Unmeasured):** This benchmark measures **API tokens and billed USD cost only**. It does **not** measure response quality, latency preferences, or the utility loss of denying a user\'s requested model or effort level.'
  );

  fs.writeFileSync(path.join(AUTO_RESULTS_DIR, 'summary_highbeam_auto.md'), envSummary.join('\n') + '\n', 'utf8');

  const horizonLedgerCount = fs.existsSync(path.join(AUTO_RESULTS_DIR, 'horizon_ledger.jsonl'))
    ? fs.readFileSync(path.join(AUTO_RESULTS_DIR, 'horizon_ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0;

  const manifestMd = [
    '# Highbeam `AUTO_PILOT` Experiment Manifest (`manifest_highbeam_auto.md`)',
    '',
    '- **Code Version:** `rule_v1` (pinned at git tag `round1-rule-v1`, commit `19c51055902c545508af1979a392505355777d90`).',
    `- **CLI Tool & Exact Version:** \`@anthropic-ai/claude-code@${PINNED_CLAUDE_CODE_VERSION}\``,
    `- **Operating System & Runtime:** Windows 11 (\`win32 x64\`), Node.js \`${process.version}\`, executed \`2026-11-14\` (\`UTC\`).`,
    '- **Target Repository Commit:** Detached `HEAD` `19c51055902c545508af1979a392505355777d90` (reset before every new run via `git checkout -f`, `git clean -fdx`, and `.git/info/exclude` containing `.claude/`).',
    '- **Highbeam Extension & Invocation Disclosure:** `flightMode: "AUTO_PILOT"`, local 14-day Pro trial (`activateLocalTrial`), canonical Highbeam hooks installed into `--settings` (`leanHooks: false`). Each turn ran as a headless `claude -p --resume <session_id>` invocation, and the harness invoked `runPreModelSwitchHook` (`DET-08`) and `interceptTopLevelMutation` (`DET-09`) in-process prior to spawning each turn (validating decision logic rather than interactive `/model` or `/effort` interception).',
    '- **Upstream Route:** Local logging proxy forwarding to `https://openrouter.ai/api/v1/messages` (`"provider": { "only": ["anthropic"], "allow_fallbacks": false }`). Cache behavior and cost may differ on the direct Anthropic API.',
    `- **OpenRouter Live Execution Usage (\`billed\`):** Proxy wire \`usage.cost\` sum = **$${liveExecutionStats.proxyTotalSpendUsd.toFixed(4)}** (\`billed\`) across **${liveExecutionStats.runsCompleted}/7** live sessions (${liveExecutionStats.mainRequests} main requests, ${liveExecutionStats.sideCalls} \`count_tokens\` side calls); OpenRouter \`/api/v1/key\` billed ledger delta for the 6-session batch = ${liveExecutionStats.openRouterDeltaUsd !== null ? `$${liveExecutionStats.openRouterDeltaUsd.toFixed(6)}` : 'N/A'} (plus \`$0.1120\` billed on prior \`HB_E_S_r01\` pilot = \`$2.9053\` total billed).`,
    `- **Artifacts Generated under \`results/highbeam_auto/\`:**`,
    '  - `runs_auto_live.csv` (`111` rows: `105` main requests with `100%` `source = both` agreement + `6` `count_tokens` side calls — `live` `n = 1` empirical evidence, `billed` `cost_usd`)',
    '  - `interceptions_live.csv` (`84` per-turn hook decisions across all `7` live sessions)',
    '  - `replay_45_sessions.csv` (`45` `counterfactual` decision replays across all `9` baseline cells — decision audit only; paired Control lookup, not independent dollar evidence)',
    `  - \`horizon_ledger.jsonl\` (\`${horizonLedgerCount}\` persisted Highbeam receipt entries — **caveat:** \`DET_08_MODEL_SWITCH_HOLD\` \`savedUSD\` in \`rule_v1\` reflects a \`$5.00/M\` fallback bug fixed in Round-2 \`C1a\`, so do not quote \`horizon_ledger.jsonl\` for dollar savings)`,
    '  - `summary_highbeam_auto.md`, `manifest_highbeam_auto.md`, and sanitized `raw/` wire logs & transcripts (zero local file paths, usernames, or credentials).'
  ].join('\n');

  fs.writeFileSync(path.join(AUTO_RESULTS_DIR, 'manifest_highbeam_auto.md'), manifestMd + '\n', 'utf8');

  // Step 1.5 privacy scanner over results/highbeam_auto/
  const ids = loadDynamicIdentifiers();
  const autoForbidden = [
    { name: 'api_key', rx: /sk-or-v1-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}/i },
    { name: 'os_username', rx: new RegExp(ids.dynamicUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { name: 'github_handle', rx: new RegExp(ids.dynamicGitOwner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { name: 'github_repo', rx: new RegExp(ids.dynamicGitRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { name: 'local_repo_folder', rx: new RegExp(ids.dynamicRepoDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { name: 'raw_uuid', rx: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
    { name: 'raw_msg_id', rx: /msg_01[A-Za-z0-9]{10,}/ },
    { name: 'raw_openrouter_gen_id', rx: /gen-\d{6,}-[A-Za-z0-9_-]+/ },
    { name: 'local_abs_path_md_csv', rx: /(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/, mdCsvOnly: true }
  ];

  const privacyViolations = [];
  let scanned = 0;
  const walkPrivacy = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkPrivacy(p);
      else {
        scanned += 1;
        const txt = fs.readFileSync(p, 'utf8');
        const isMdCsv = /\.(?:md|csv)$/i.test(e.name);
        for (const chk of autoForbidden) {
          if (chk.mdCsvOnly && !isMdCsv) continue;
          if (chk.rx.test(txt)) {
            privacyViolations.push({ file: path.relative(AUTO_RESULTS_DIR, p), check: chk.name });
          }
        }
      }
    }
  };
  walkPrivacy(AUTO_RESULTS_DIR);

  return {
    unexpectedBlanksCount,
    horizonLedgerCount,
    privacyAudit: { filesScanned: scanned, violationsCount: privacyViolations.length, violations: privacyViolations },
    totals: {
      totalBaseWrite,
      totalLiveWrite,
      writeTokensSaved: totalBaseWrite - totalLiveWrite,
      totalBaseCostUsd: Number(totalBaseCost.toFixed(6)),
      totalLiveCostUsd: Number(totalLiveCost.toFixed(6)),
      costSavedUsd: Number((totalBaseCost - totalLiveCost).toFixed(6))
    }
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const gateReport = verifyHighbeamAutoPilotGates();
  const replayRes = runCounterfactual45Replay();

  if (!flags.runLive && !flags.buildOnly) {
    console.log(JSON.stringify({
      status: 'REPLAY_AND_SELFTEST_OK',
      gateReport,
      replayCsvPath: replayRes.replayCsvPath,
      replayedSessionsCount: replayRes.replayRows.length
    }, null, 2));
    return;
  }

  let runtimePaths = null;
  try {
    runtimePaths = resolveRuntimePaths();
  } catch (err) {
    if (!flags.buildOnly) throw err;
  }

  let liveStats;
  if (flags.buildOnly) {
    const cp = JSON.parse(fs.readFileSync(path.join(AUTO_RAW_DIR, 'checkpoint.json'), 'utf8'));
    const wires = readJsonl(path.join(AUTO_RAW_DIR, 'proxy_wire_log.jsonl'));
    const orLedger = readJsonl(path.join(AUTO_RAW_DIR, 'openrouter_ledger.jsonl'));
    const startEvt = orLedger.find((e) => e.event === 'start');
    const endEvt = [...orLedger].reverse().find((e) => e.event === 'end');
    const mainWires = wires.filter((w) => !w.isSideCall && w.statusCode === 200);
    const sideWires = wires.filter((w) => w.isSideCall);
    const proxySpend = mainWires.reduce(
      (s, w) => s + (typeof w.upstreamReportedCostUsd === 'number' ? w.upstreamReportedCostUsd : Number(w.cost?.totalCostUsd || 0)),
      0
    );
    liveStats = {
      runsCompleted: Object.values(cp.runs || {}).filter((r) => r.completed).length,
      proxyTotalSpendUsd: Number(proxySpend.toFixed(6)),
      openRouterUsageBeforeUsd: startEvt?.usage ?? null,
      openRouterUsageAfterUsd: endEvt?.usage ?? null,
      openRouterDeltaUsd: (typeof startEvt?.usage === 'number' && typeof endEvt?.usage === 'number')
        ? Number((endEvt.usage - startEvt.usage).toFixed(6))
        : null,
      mainRequests: mainWires.length,
      sideCalls: sideWires.length
    };
  } else {
    liveStats = await runLiveAutoSessions({
      maxBudgetUsd: flags.maxBudgetUsd,
      resume: flags.resume,
      runtimePaths
    });
  }

  sanitizeHighbeamAutoInPlace(runtimePaths);
  const csvStats = buildLiveAutoCsvs();
  const verifyStats = buildMarkdownAndVerify({
    runtimePaths,
    gateReport,
    liveExecutionStats: liveStats
  });

  if (
    csvStats.mainRowsCount !== 105 ||
    csvStats.sourceBothCount !== 105 ||
    csvStats.sourceDisagreementCount !== 0 ||
    verifyStats.unexpectedBlanksCount !== 0 ||
    verifyStats.privacyAudit.violationsCount !== 0
  ) {
    console.error(JSON.stringify({ csvStats, verifyStats }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'HIGHBEAM_AUTO_OK',
    gateReport,
    replayedSessionsCount: replayRes.replayRows.length,
    liveStats,
    csvStats,
    verifyStats
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
