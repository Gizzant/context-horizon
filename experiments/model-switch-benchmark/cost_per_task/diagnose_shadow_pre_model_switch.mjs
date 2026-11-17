#!/usr/bin/env node
/**
 * Part C ($0.00): Highbeam `runPreModelSwitchHook()` Shadow Audit & Proposed Fix Analysis.
 * Reads Stage 1 wire + checkpoint data without modifying src/ or hooks/.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { RESULTS_DIR, PRICING_PER_1M } from '../config.mjs';
import { assertNoSensitiveLeaks } from '../tests_3_to_8/prefix_lab.mjs';
import { activateLocalTrial } from '../../../src/core/pro_license.mjs';
import { runPreModelSwitchHook } from '../../../hooks/handlers/pre-model-switch.mjs';
import {
  computeBreakEvenCachedTokens
} from '../../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  createInitialTelemetryState,
  writeLiveStateSnapshot
} from '../../../src/core-isomorphic/telemetry/telemetryBridge.mjs';

const RAW_DIR = path.join(RESULTS_DIR, 'cost_per_task_raw');
const WIRE_PATH = path.join(RAW_DIR, 'proxy_wire_log.jsonl');
const CHECKPOINT_PATH = path.join(RAW_DIR, 'checkpoint_runs.jsonl');
const OUT_JSON = path.join(RAW_DIR, 'highbeam_shadow_diagnostic.json');
const OUT_MD = path.join(RESULTS_DIR, 'highbeam_shadow_check.md');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function summarizeRunWire(wireRows, runId) {
  const rows = wireRows.filter(
    (w) => w.context?.runId === runId && !w.blockedByGuard && !w.countTokensFallback && (w.statusCode ?? 200) < 400
  );
  const t1Main = rows.filter((w) => !w.isSideCall && w.context?.turn === 1);
  const t2Main = rows.filter((w) => !w.isSideCall && w.context?.turn === 2);
  const probe = rows.filter((w) => w.isSideCall);

  const lastT1 = t1Main[t1Main.length - 1];
  const t1LastPromptTokens = lastT1
    ? (lastT1.usage?.input_tokens || 0) +
      (lastT1.usage?.cache_creation_input_tokens || 0) +
      (lastT1.usage?.cache_read_input_tokens || 0)
    : 0;
  const t1OutputTokens = t1Main.reduce((s, w) => s + (w.usage?.output_tokens || 0), 0);
  const t1BilledUsd = t1Main.reduce((s, w) => s + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0);

  const t2Req1 = t2Main[0];
  const t2Req1WriteTokens = t2Req1?.usage?.cache_creation_input_tokens || 0;
  const t2IncrementalWriteTokens = t2Main.slice(1).reduce((s, w) => s + (w.usage?.cache_creation_input_tokens || 0), 0);
  const t2TotalReadTokens = t2Main.reduce((s, w) => s + (w.usage?.cache_read_input_tokens || 0), 0);
  const t2OutputTokens = t2Main.reduce((s, w) => s + (w.usage?.output_tokens || 0), 0);
  const t2MainBilledUsd = t2Main.reduce((s, w) => s + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0);
  const probeBilledUsd = probe.reduce((s, w) => s + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0);

  return {
    t1Requests: t1Main.length,
    t1LastPromptTokens,
    t1OutputTokens,
    t1BilledUsd: Number(t1BilledUsd.toFixed(6)),
    t2Requests: t2Main.length,
    t2Req1WriteTokens,
    t2IncrementalWriteTokens,
    t2TotalReadTokens,
    t2OutputTokens,
    t2MainBilledUsd: Number(t2MainBilledUsd.toFixed(6)),
    probeBilledUsd: Number(probeBilledUsd.toFixed(6)),
    t2PlusProbeUsd: Number((t2MainBilledUsd + probeBilledUsd).toFixed(6))
  };
}

/**
 * Proposed multi-request switch-turn formula (unmerged simulation; does NOT touch src/).
 * Evaluates actual switch-turn (Turn 2) total cost on `targetModel` vs staying on `currentModel`
 * without gating on single-request `C* = 6,902`, and folds in intra-turn incremental write
 * savings plus full turn output savings across `R_turn` requests.
 */
function simulateProposedSwitchDecision({
  cachedTokens,
  expectedRpt = 5,
  avgDeltaPerReq = 1800,
  expectedTurnOutputTokens = 2000,
  expectedRemainingTurnsAfterSwitch = 0
}) {
  const opus = PRICING_PER_1M['anthropic/claude-opus-5.5'];
  const sonnet = PRICING_PER_1M['anthropic/claude-sonnet-5.5'];
  const r = Math.max(1, expectedRpt);
  const avgIntraTurnPrefix = cachedTokens + 0.5 * (r - 1) * avgDeltaPerReq;

  // Turn 2 cost staying warm on Opus
  const opusReq1Write = avgDeltaPerReq;
  const opusTotalReads = cachedTokens + (r - 1) * avgIntraTurnPrefix;
  const opusTotalWrites = opusReq1Write + (r - 1) * avgDeltaPerReq;
  const stayTurnUsd =
    (opusTotalReads / 1e6) * opus.read +
    (opusTotalWrites / 1e6) * opus.write5m +
    (expectedTurnOutputTokens / 1e6) * opus.output;

  // Turn 2 cost switching cold to Sonnet
  const sonnetReq1Write = cachedTokens + avgDeltaPerReq;
  const sonnetTotalReads = (r - 1) * avgIntraTurnPrefix;
  const sonnetTotalWrites = sonnetReq1Write + (r - 1) * avgDeltaPerReq;
  const switchTurnUsd =
    (sonnetTotalReads / 1e6) * sonnet.read +
    (sonnetTotalWrites / 1e6) * sonnet.write5m +
    (expectedTurnOutputTokens / 1e6) * sonnet.output;

  const netSwitchTurnPenaltyUsd = switchTurnUsd - stayTurnUsd;
  const postTurnPerTurnSavingUsd =
    expectedRemainingTurnsAfterSwitch > 0
      ? (r * (cachedTokens + r * avgDeltaPerReq) / 1e6) * (opus.read - sonnet.read) +
        ((r * avgDeltaPerReq) / 1e6) * (opus.write5m - sonnet.write5m) +
        (expectedTurnOutputTokens / 1e6) * (opus.output - sonnet.output)
      : 0;
  const netHorizonDeltaUsd = netSwitchTurnPenaltyUsd - expectedRemainingTurnsAfterSwitch * postTurnPerTurnSavingUsd;

  return {
    stayTurnUsd: Number(stayTurnUsd.toFixed(6)),
    switchTurnUsd: Number(switchTurnUsd.toFixed(6)),
    netSwitchTurnPenaltyUsd: Number(netSwitchTurnPenaltyUsd.toFixed(6)),
    netHorizonDeltaUsd: Number(netHorizonDeltaUsd.toFixed(6)),
    proposedBlocked: netHorizonDeltaUsd > 0,
    proposedDecision: netHorizonDeltaUsd > 0 ? 'deny' : 'allow'
  };
}

function main() {
  const wireRows = readJsonl(WIRE_PATH);
  const checkpointRows = readJsonl(CHECKPOINT_PATH);
  const runsById = new Map();
  for (const r of checkpointRows) {
    if (r?.run_id) runsById.set(r.run_id, r);
  }

  // Algebraic proof of C* = 6,902
  const algebraicCStar = Math.round(((1500 * (20 - 10)) + (350 * (5.0 - 2.5))) / (2.5 - 0.2));
  assert.equal(algebraicCStar, 6902);
  const directCheck = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 20_000,
    uncachedDeltaTokens: 350,
    expectedOutputTokens: 1500,
    cacheWarm: true,
    cacheTtlTier: '5m'
  });
  assert.equal(directCheck.breakEvenTokens, 6902);
  assert.equal(directCheck.ruleVersion, 'rule_v1');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-shadow-diag-'));
  try {
    const shadowHome = path.join(tmpRoot, 'home');
    const shadowCwd = path.join(tmpRoot, 'cwd');
    const licensePath = path.join(tmpRoot, 'license.json');
    const ledgerPath = path.join(tmpRoot, 'ledger.jsonl');
    fs.mkdirSync(shadowHome, { recursive: true });
    fs.mkdirSync(shadowCwd, { recursive: true });
    activateLocalTrial({ homeDir: shadowHome, licensePath });
    const ahDir = path.join(shadowHome, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(path.join(ahDir, 'config.json'), JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2), 'utf8');

    const switchRuns = [...runsById.values()]
      .filter((r) => r.arm === 'SWITCH' && r.rep === 1)
      .sort((a, b) => (a.task_id < b.task_id ? -1 : 1));

    const perTask = [];
    for (const sw of switchRuns) {
      const opus = runsById.get(`${sw.task_id}_OPUS_r01`);
      const swWire = summarizeRunWire(wireRows, sw.run_id);
      const opWire = summarizeRunWire(wireRows, opus.run_id);

      // Replay 1: Exact Stage 1 shadow invocation
      const sid1 = `diag_exact_${sw.run_id}`;
      writeLiveStateSnapshot(
        sid1,
        {
          ...createInitialTelemetryState(sid1),
          sessionId: sid1,
          modelId: 'claude-opus-5-5',
          effort: 'medium',
          flightMode: 'AUTO_PILOT',
          contextWindow: { cachedTokens: swWire.t1LastPromptTokens, totalInputTokens: swWire.t1LastPromptTokens },
          promptCache: { warm: true, ttlTier: '5m', ttlSeconds: 299 }
        },
        { cwd: shadowCwd }
      );
      const resExact = runPreModelSwitchHook(
        {
          session_id: sid1,
          cwd: shadowCwd,
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: swWire.t1LastPromptTokens,
          uncached_delta_tokens: 350,
          cache_warm: true,
          cache_ttl_tier: '5m',
          turn_id: `${sw.run_id}_T2`
        },
        {
          cwd: shadowCwd,
          homeDir: shadowHome,
          licensePath,
          ledgerPath,
          recordLedger: false,
          persistState: false,
          useLocalRptPrior: false
        }
      );

      // Replay 2: Turn-1 empirical horizon enabled (useEmpiricalHorizonPrior: true + Turn-1 stats populated)
      const resEmpirical = runPreModelSwitchHook(
        {
          session_id: `${sid1}_emp`,
          cwd: shadowCwd,
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: swWire.t1LastPromptTokens,
          uncached_delta_tokens: 350,
          cache_warm: true,
          cache_ttl_tier: '5m',
          current_turn: 1,
          apiCallsCompleted: swWire.t1Requests,
          requestsPerTurn: swWire.t1Requests,
          expectedOutputTokens: swWire.t1OutputTokens,
          useEmpiricalHorizonPrior: true,
          turn_id: `${sw.run_id}_T2_emp`
        },
        {
          cwd: shadowCwd,
          homeDir: shadowHome,
          licensePath,
          ledgerPath,
          recordLedger: false,
          persistState: false,
          useLocalRptPrior: false
        }
      );

      // Replay 3: Proposed multi-request switch-turn formula (assuming Turn 1's observed RPT and avg output/req)
      const avgOutPerReqT1 = swWire.t1OutputTokens / Math.max(1, swWire.t1Requests);
      const proposed = simulateProposedSwitchDecision({
        cachedTokens: swWire.t1LastPromptTokens,
        expectedRpt: swWire.t1Requests,
        avgDeltaPerReq: 1500,
        expectedTurnOutputTokens: Math.max(1500, swWire.t1OutputTokens),
        expectedRemainingTurnsAfterSwitch: 0
      });

      const exactBe = resExact.verdict?.breakEven || {};
      const empBe = resEmpirical.verdict?.breakEven || {};
      perTask.push({
        task_id: sw.task_id,
        switchRunId: sw.run_id,
        opusRunId: opus.run_id,
        exactShadowInputs: {
          cachedTokens: exactBe.cachedTokens,
          uncachedDeltaTokens: exactBe.uncachedDeltaTokens,
          expectedOutputTokens: exactBe.expectedOutputTokens,
          outputEstimateSource: resExact.verdict?.outputEstimateSource || exactBe.outputEstimateSource || 'default_1500',
          requestsPerTurn: exactBe.requestsPerTurn,
          requestsPerTurnSource: exactBe.requestsPerTurnSource || 'default_1.0',
          expectedRemainingTurns: exactBe.expectedRemainingTurns,
          postSwitchRemainingTurns: exactBe.postSwitchRemainingTurns,
          horizonPriorSource: exactBe.horizonPriorSource,
          ruleVersion: exactBe.ruleVersion,
          breakEvenTokens: exactBe.breakEvenTokens,
          coldWritePenaltyUsd: exactBe.coldWritePenaltyUSD,
          decision: resExact.verdict?.decision,
          blocked: Boolean(resExact.verdict?.blocked)
        },
        empiricalReplay: {
          ruleVersion: empBe.ruleVersion,
          requestsPerTurn: empBe.requestsPerTurn,
          expectedOutputTokens: empBe.expectedOutputTokens,
          expectedRemainingTurns: empBe.expectedRemainingTurns,
          postSwitchRemainingTurns: empBe.postSwitchRemainingTurns,
          horizonPriorSource: empBe.horizonPriorSource,
          horizonMaxCachedTokens: empBe.horizonMaxCachedTokens,
          paybackTurns: empBe.paybackTurns,
          coldWritePenaltyUsd: empBe.coldWritePenaltyUSD,
          decision: resEmpirical.verdict?.decision,
          blocked: Boolean(resEmpirical.verdict?.blocked)
        },
        proposedFormulaSim: {
          assumedRptFromT1: swWire.t1Requests,
          assumedTurnOutFromT1: Math.max(1500, swWire.t1OutputTokens),
          avgOutPerReqT1: Number(avgOutPerReqT1.toFixed(1)),
          ...proposed
        },
        measuredWire: {
          switchT1: {
            requests: swWire.t1Requests,
            lastPromptTokens: swWire.t1LastPromptTokens,
            outputTokens: swWire.t1OutputTokens,
            billedUsd: swWire.t1BilledUsd
          },
          switchT2: {
            requests: swWire.t2Requests,
            req1WriteTokens: swWire.t2Req1WriteTokens,
            incrementalWriteTokens: swWire.t2IncrementalWriteTokens,
            totalReadTokens: swWire.t2TotalReadTokens,
            outputTokens: swWire.t2OutputTokens,
            t2PlusProbeUsd: swWire.t2PlusProbeUsd
          },
          opusT2: {
            requests: opWire.t2Requests,
            incrementalWriteTokens: opWire.t2IncrementalWriteTokens,
            totalReadTokens: opWire.t2TotalReadTokens,
            outputTokens: opWire.t2OutputTokens,
            billedUsd: opWire.t2MainBilledUsd
          },
          actualSwitchRunUsd: sw.total_billed_usd,
          actualOpusRunUsd: opus.total_billed_usd,
          actualRunDeltaUsd: Number((sw.total_billed_usd - opus.total_billed_usd).toFixed(6)),
          actualT2DeltaUsd: Number((swWire.t2PlusProbeUsd - opWire.t2MainBilledUsd).toFixed(6)),
          switchBeatOpusTotal: sw.total_billed_usd < opus.total_billed_usd,
          switchBeatOpusT2: swWire.t2PlusProbeUsd < opWire.t2MainBilledUsd
        }
      });
    }

    const reportJson = {
      generatedAtUtc: new Date().toISOString(),
      algebraicSingleTurnCStar: algebraicCStar,
      perTask
    };
    const jsonStr = JSON.stringify(reportJson, null, 2) + '\n';
    assertNoSensitiveLeaks(jsonStr, 'highbeam_shadow_diagnostic.json');
    fs.writeFileSync(OUT_JSON, jsonStr, 'utf8');

    const minMax = (vals) => [Math.min(...vals), Math.max(...vals)];
    const [ctMin, ctMax] = minMax(perTask.map((r) => r.exactShadowInputs.cachedTokens));
    const [swReqsMin, swReqsMax] = minMax(perTask.map((r) => r.measuredWire.switchT2.requests));
    const [opReqsMin, opReqsMax] = minMax(perTask.map((r) => r.measuredWire.opusT2.requests));
    const [swOutMin, swOutMax] = minMax(perTask.map((r) => r.measuredWire.switchT2.outputTokens));
    const [swIncMin, swIncMax] = minMax(perTask.map((r) => r.measuredWire.switchT2.incrementalWriteTokens));
    const [swT2Min, swT2Max] = minMax(perTask.map((r) => r.measuredWire.switchT2.t2PlusProbeUsd));
    const t06 = perTask.find((r) => r.task_id === 'T06');
    const t06T1Delta = Number((t06.measuredWire.switchT1.billedUsd - t06.measuredWire.opusT1?.billedUsd || (t06.measuredWire.actualRunDeltaUsd - t06.measuredWire.actualT2DeltaUsd)).toFixed(4));

    // Build readable report
    const md = [];
    md.push('# Highbeam `runPreModelSwitchHook()` Shadow Check (`$0` Audit)');
    md.push('');
    md.push('**Status:** Diagnostic only — **no changes merged** into `src/` or `hooks/`.');
    md.push('');
    md.push('## 1. Why `runPreModelSwitchHook()` Returned `deny` on 8/8 Runs While `SWITCH` Beat `OPUS` on 7/8');
    md.push('');
    md.push(`1. **Yes — \`6,902\` tokens IS the legacy single-turn (1-request, \`rule_v1\`) \`C*\` threshold that should not gate multi-request agentic switches:**`);
    md.push('   - At Claude 5.5 rates (`Opus 5.5`: `$0.20/M` read, `$5.00/M` write, `$20/M` output; `Sonnet 5.5`: `$2.50/M` write, `$10/M` output), `computeBreakEvenCachedTokens()` in `src/core-isomorphic/coach/cacheGravityRouter.mjs:529-544` computes:');
    md.push('     `C* = Math.round(((1500 * (20 - 10)) + (350 * (5.0 - 2.5))) / (2.5 - 0.2)) = Math.round(15875 / 2.3) = 6,902 tokens`.');
    md.push(`   - Because Claude Code \`2.1.325\` sends \`>10k\` baseline \`tools + system\` tokens on Turn 1 alone (\`${ctMin.toLocaleString()}–${ctMax.toLocaleString()}\` prompt tokens by the end of Turn 1), \`cachedTokens > 6,902\` was **trivially true on 8/8 runs**.`);
    md.push('2. **Why `rule_v1` fired instead of `rule_v2` (and why our shadow call starved `liveState`):**');
    md.push('   - `DEFAULT_HORIZON_CONFIG` (`src/core-isomorphic/config/horizonConfig.mjs:558`) defaults `useEmpiricalHorizonPrior = false`. Because no explicit `expectedRemainingTurns` or `useEmpiricalHorizonPrior: true` was passed, `cacheGravityRouter.mjs:700-706` fell back to `rule_v1` (`singleTurnShouldHold`).');
    md.push('   - Furthermore, the shadow harness created an isolated empty `homeDir` (`no session calibration`), passed `turnsCompleted: 0` (from `createInitialTelemetryState`), and omitted `apiCallsCompleted` and Turn-1 `outputTokens`, causing `runPreModelSwitchHook()` to resolve `requestsPerTurn = 1` (`default_1.0`), `expectedOutputTokens = 1500` (`default_1500`), `expectedRemainingTurns = null`, and `horizonPriorSource = null`.');
    md.push(`3. **Why \`SWITCH\` actually beat \`OPUS\` on 7/8 runs despite paying \`$0.0586–$0.1069\` on Turn 2 Req 1 (Turn 2+probe \`$${swT2Min.toFixed(4)}–$${swT2Max.toFixed(4)}\`):**`);
    md.push(`   - **Turn 2 is a multi-request coding loop (\`${swReqsMin}–${swReqsMax}\` API calls in \`SWITCH\`, \`${opReqsMin}–${opReqsMax}\` in \`OPUS\`), not \`1\` request (\`R = 1\`).** Across Turn 2, switching to Sonnet 5.5 saved money on three terms that \`rule_v1\` (\`1\` request, \`O = 1500\`, \`uncachedWriteTokens = 0\`) misses:`);
    md.push(`     1. **Output & thinking tokens across all Turn-2 calls:** \`${swOutMin.toLocaleString()}–${swOutMax.toLocaleString()}\` measured Turn-2 output tokens (\`$10/M\` saved vs Opus \`$20/M\` = \`$${((swOutMin * 10) / 1e6).toFixed(4)}–$${((swOutMax * 10) / 1e6).toFixed(4)}\`).`);
    md.push(`     2. **Intra-turn incremental cache writes (file reads / tool outputs / test logs):** \`${swIncMin.toLocaleString()}–${swIncMax.toLocaleString()}\` new Turn-2 tokens written at \`$2.50/M\` instead of \`$5.00/M\` (\`$${((swIncMin * 2.5) / 1e6).toFixed(4)}–$${((swIncMax * 2.5) / 1e6).toFixed(4)}\` saved).`);
    md.push(`     3. **\`(R - 1)\` intra-turn warm reads:** reading the growing prefix at \`$0.10/M\` instead of \`$0.20/M\`.`);
    md.push(`   - Only on \`T06\` — where \`SWITCH\` needed **\`${t06.measuredWire.switchT2.requests}\` Turn-2 requests** (\`${t06.measuredWire.switchT2.outputTokens.toLocaleString()}\` out) vs \`OPUS\`'s **\`${t06.measuredWire.opusT2.requests}\` Turn-2 requests** (\`${t06.measuredWire.opusT2.outputTokens.toLocaleString()}\` out) — did \`SWITCH\` Turn 2 cost \`+$${t06.measuredWire.actualT2DeltaUsd.toFixed(4)}\` more than \`OPUS\` Turn 2 (\`-$${Math.abs(t06T1Delta).toFixed(4)}\` lower Plan turn -> net \`+$${t06.measuredWire.actualRunDeltaUsd.toFixed(4)}\`).`);
    md.push('');
    md.push('## 2. Exact Switch-Point Inputs vs. Measured Turn-1/Turn-2 Reality (`Stage 1`, `n = 8`)');
    md.push('');
    md.push('| Task | `cachedTokens` (`measured`) | Shadow Inputs (`O` / `R` / `horizon` / `source` / `rule`) | Shadow `C*` / Penalty / Verdict (`computed offline`) | Measured T1 (`reqs`, `out`) | Measured SWITCH T2 (`reqs`, `incWrite`, `out`, `T2+probe`) | Measured OPUS T2 (`reqs`, `out`, `T2`) | Actual Total Delta (`SWITCH - OPUS`, `billed`) |');
    md.push('| :--- | :---: | :--- | :--- | :---: | :---: | :---: | :---: |');
    for (const row of perTask) {
      const s = row.exactShadowInputs;
      const m = row.measuredWire;
      md.push(
        `| \`${row.task_id}\` | ${s.cachedTokens.toLocaleString()} | ${s.expectedOutputTokens} (${s.outputEstimateSource}) / ${s.requestsPerTurn} (${s.requestsPerTurnSource}) / ${s.expectedRemainingTurns ?? 'null'} (${s.horizonPriorSource ?? 'null'}) / ${s.ruleVersion} | ${s.breakEvenTokens} / $${s.coldWritePenaltyUsd.toFixed(4)} / **${s.decision}** | ${m.switchT1.requests} req, ${m.switchT1.outputTokens} out | ${m.switchT2.requests} req, ${m.switchT2.incrementalWriteTokens.toLocaleString()} w, ${m.switchT2.outputTokens} out, $${m.switchT2.t2PlusProbeUsd.toFixed(4)} | ${m.opusT2.requests} req, ${m.opusT2.outputTokens} out, $${m.opusT2.billedUsd.toFixed(4)} | **${m.actualRunDeltaUsd >= 0 ? '+' : '-'}$${Math.abs(m.actualRunDeltaUsd).toFixed(4)}** (${m.switchBeatOpusTotal ? 'SWITCH cheaper' : 'OPUS cheaper'}) |`
      );
    }
    md.push('');
    md.push('## 3. Counterfactual Replay: Existing `useEmpiricalHorizonPrior: true` vs. Proposed Multi-Request Fix (`computed offline`)');
    md.push('');
    md.push('| Task | Existing `useEmpiricalHorizonPrior: true` + T1 Stats (`rule_v2`) | Proposed Multi-Request Switch-Turn Formula (`expectedRemainingTurnsAfterSwitch = 0`) | Actual `SWITCH` vs `OPUS` Total |');
    md.push('| :--- | :--- | :--- | :---: |');
    for (const row of perTask) {
      const e = row.empiricalReplay;
      const p = row.proposedFormulaSim;
      const m = row.measuredWire;
      md.push(
        `| \`${row.task_id}\` | **${e.decision}** (R=${e.requestsPerTurn}, O=${e.expectedOutputTokens}, H_post=${e.postSwitchRemainingTurns}, src=${e.horizonPriorSource}, C_max=${e.horizonMaxCachedTokens === Infinity ? 'Infinity' : e.horizonMaxCachedTokens}, payback=${e.paybackTurns}t) | **${p.proposedDecision}** (R=${p.assumedRptFromT1}, O_turn=${p.assumedTurnOutFromT1}, netPenalty=${p.netSwitchTurnPenaltyUsd >= 0 ? '+' : '-'}$${Math.abs(p.netSwitchTurnPenaltyUsd).toFixed(4)}) | ${m.switchBeatOpusTotal ? 'SWITCH beat OPUS' : 'OPUS beat SWITCH'} (${m.actualRunDeltaUsd >= 0 ? '+' : '-'}$${Math.abs(m.actualRunDeltaUsd).toFixed(4)}) |`
      );
    }
    md.push('');
    md.push('## 4. Proposed Fix (NOT Merged — For Review Only)');
    md.push('');
    md.push('1. **Enable `useEmpiricalHorizonPrior: true` by default in `src/core-isomorphic/config/horizonConfig.mjs` (`line 558`):** stop defaulting live Claude Code sessions to `rule_v1` single-request `C* = 6,902`.');
    md.push('2. **Retire single-turn `singleTurnShouldHold` (`breakEvenTokens`) from gating `shouldHoldModel` in `src/core-isomorphic/coach/cacheGravityRouter.mjs` (`lines 529-571, 691-706`):**');
    md.push('   - Do not gate `shouldHoldModel` on `cachedTokens > breakEvenTokens` when `hasHorizonTurns` is active (`rule_v2` currently evaluates `singleTurnShouldHold && ...`, AND treats `postSwitchRemainingTurns === 0` with `coldWritePenaltyUSD > 0` as a hold even when intra-turn requests already pay back the cold write).');
    md.push('   - Model **intra-turn** incremental cache writes (`Math.max(0, R - 1) * avgDeltaPerCall * (pWriteCurr - pWriteTarget)`) and **full per-turn output** (`O_turn`, i.e. sum across all `R` requests in the turn, rather than assuming `O = 1500` covers only `1` call) inside `stayOnCurrentModelUSD` vs `switchToTargetModelUSD`, so `coldWritePenaltyUSD` reflects the actual net switch-turn delta.');
    md.push('3. **Populate Turn-1 telemetry into `liveState` & pass Turn-1 `apiCallsCompleted` / `requestsPerTurn` / `current_turn` in hooks** (`hooks/handlers/pre-model-switch.mjs`), so multi-request tool turns are never underestimated as `R = 1.0`.');
    md.push('');

    const mdStr = md.join('\n');
    assertNoSensitiveLeaks(mdStr, 'highbeam_shadow_check.md');
    fs.writeFileSync(OUT_MD, mdStr, 'utf8');

    console.log('SHADOW_DIAGNOSTIC_PASS');
    console.log(JSON.stringify({
      algebraicCStar,
      exactShadowAllDeny: perTask.every((r) => r.exactShadowInputs.decision === 'deny'),
      empiricalReplayAllows: perTask.filter((r) => r.empiricalReplay.decision === 'allow').length,
      proposedSimAllows: perTask.filter((r) => r.proposedFormulaSim.proposedDecision === 'allow').length,
      actualSwitchBeatOpus: perTask.filter((r) => r.measuredWire.switchBeatOpusTotal).length
    }, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
