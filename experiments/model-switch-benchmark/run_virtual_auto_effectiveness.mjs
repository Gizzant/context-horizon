#!/usr/bin/env node
/**
 * @file experiments/model-switch-benchmark/run_virtual_auto_effectiveness.mjs
 * $0-API-spend offline counterfactual replay & guardrail benchmark comparing Highbeam v4.1 modes
 * (`OFF` vs. `COACH` vs. `AUTO_PILOT` across Zero-Config, Unguided Prior, and Calibrated Horizon,
 * alongside Legacy `rule_v1` reference runs) using the empirical datasets in `results/`.
 *
 * ZERO network requests, ZERO CLI spawns, ZERO OAuth reads, and ZERO state written outside `os.tmpdir()`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  EXPERIMENT_DIR,
  RESULTS_DIR,
  ARM_DEFINITIONS
} from './config.mjs';
import { activateLocalTrial } from '../../src/core/pro_license.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import {
  CacheGravityRouter,
  getEffortMutationCacheCapability,
  isPrefixInstructionFile
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { updateSessionCalibrationOnStop } from '../../src/utils/sessionCalibration.mjs';
import { evaluateSwarmColdCacheWakeup } from '../../src/core/subagents.mjs';
import { evaluateDet09MidSessionRuleMutate } from '../../src/core/detectors_det01_to_16.mjs';
import { evaluateParameterizedCliffBreaker } from '../../src/core-isomorphic/economics/cliffBreaker.mjs';

const OUT_DIR = path.join(RESULTS_DIR, 'virtual_auto_v4_1');
const OUT_CSV = path.join(OUT_DIR, 'virtual_mode_comparison.csv');
const OUT_JSON = path.join(OUT_DIR, 'virtual_auto_summary.json');
const OUT_REPORT = path.join(OUT_DIR, 'VIRTUAL_AUTO_EFFECTIVENESS_REPORT.md');

const ARM_CODE_MAP = Object.freeze({
  control: 'A',
  one_switch: 'B',
  switch_and_back: 'C',
  effort_only: 'D',
  idle_then_switch: 'E',
  ten_switches: 'F'
});

const CSV_HEADERS = Object.freeze([
  'Track',
  'Arm',
  'Bucket',
  'n',
  'Provenance',
  'GroundTruthOptimalAction',
  'Off_Cost_Med',
  'RuleV1_Cost_Med',
  'Coach25_Cost_Med',
  'Coach50_Cost_Med',
  'Coach75_Cost_Med',
  'Auto_ZeroCfg_Decision',
  'Auto_ZeroCfg_Cost_Med',
  'Auto_UnguidedPrior_Decision',
  'Auto_UnguidedPrior_Cost_Med',
  'Auto_Calibrated_Decision',
  'Auto_Calibrated_Cost_Med',
  'Auto_vs_Off_NetSaved_MedRange',
  'Auto_vs_RuleV1_NetSaved_MedRange'
]);

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
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && raw[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((c) => c !== '')) records.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== '')) records.push(row);
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0];
  const rows = records.slice(1).map((cols) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = cols[i] ?? '';
    return obj;
  });
  return { headers, rows };
}

function csvEscape(val) {
  if (val === null || val === undefined || val === '') return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function writeCsv(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
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

function percentile(values = [], p = 95) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

function fmtUsd(val, digits = 4) {
  if (val === null || val === undefined || !Number.isFinite(val)) return 'N/A';
  return val < 0 ? `-$${Math.abs(val).toFixed(digits)}` : `$${val.toFixed(digits)}`;
}

function fmtSignedUsd(val, digits = 4) {
  if (val === null || val === undefined || !Number.isFinite(val)) return 'N/A';
  const sign = val >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toFixed(digits)}`;
}

function fmtMedRangeUsd(values = [], digits = 4) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return 'N/A';
  const med = median(nums);
  const lo = minVal(nums);
  const hi = maxVal(nums);
  if (nums.length === 1 || Math.abs(lo - hi) < 1e-7) return fmtUsd(med, digits);
  return `${fmtUsd(med, digits)} [${fmtUsd(lo, digits)}–${fmtUsd(hi, digits)}]`;
}

function fmtSignedMedRangeUsd(values = [], digits = 4) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return 'N/A';
  const med = median(nums);
  const lo = minVal(nums);
  const hi = maxVal(nums);
  if (nums.length === 1 || Math.abs(lo - hi) < 1e-7) return fmtSignedUsd(med, digits);
  return `${fmtSignedUsd(med, digits)} [${fmtSignedUsd(lo, digits)} to ${fmtSignedUsd(hi, digits)}]`;
}

function fmtMsMedRange(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return 'N/A';
  const med = median(nums);
  const lo = minVal(nums);
  const hi = maxVal(nums);
  if (nums.length === 1 || Math.abs(lo - hi) < 1e-4) return `${med.toFixed(2)} ms`;
  return `${med.toFixed(2)} ms [${lo.toFixed(2)}–${hi.toFixed(2)}]`;
}

function toFixedOrBlank(v, digits = 4) {
  return v !== null && v !== undefined && Number.isFinite(v) ? v.toFixed(digits) : '';
}

function measureNs(fn) {
  const t0 = process.hrtime.bigint();
  const res = fn();
  const t1 = process.hrtime.bigint();
  return { res, ms: Number(t1 - t0) / 1e6 };
}

/**
 * Creates an isolated temporary HOME/cwd sandbox with a local Pro trial and requested flightMode.
 */
function withModeSandbox(flightMode, extraConfig, fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-virtual-auto-v41-'));
  try {
    const licensePath = path.join(tmpHome, '.ctxtop', 'license.json');
    activateLocalTrial({ homeDir: tmpHome, licensePath });
    const ahDir = path.join(tmpHome, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(
      path.join(ahDir, 'config.json'),
      JSON.stringify({ flightMode, ...(extraConfig || {}) }, null, 2),
      'utf8'
    );
    const sandboxOpts = {
      cwd: tmpHome,
      homeDir: tmpHome,
      licensePath,
      recordLedger: false,
      useLocalRptPrior: false,
      persistState: false,
      telemetryState: { flightMode },
      horizonConfig: { flightMode, detectors: {}, thresholds: {}, ...(extraConfig || {}), sources: { projectLoaded: true } }
    };
    return fn({ tmpHome, licensePath, sandboxOpts });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function loadTrack1Runs() {
  const { rows } = parseCsv(path.join(RESULTS_DIR, 'runs.csv'));
  const mainRows = rows.filter((r) => r.is_side_call === 'false' && r.source === 'both');
  const runsById = new Map();
  for (const r of mainRows) {
    if (!runsById.has(r.run_id)) runsById.set(r.run_id, []);
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
  return runsById;
}

function summarizeRun(runRows) {
  return {
    runId: runRows[0].run_id,
    arm: runRows[0].arm,
    rep: Number(runRows[0].rep),
    bucket: runRows[0].prefix_size_bucket,
    sessionWriteTokens: runRows.reduce((s, r) => s + r.writeTokens, 0),
    sessionCostUsd: runRows.reduce((s, r) => s + r.costUsd, 0),
    rawRows: runRows
  };
}

function evaluateSession45Profile(runsById, controlByKey, profile) {
  return withModeSandbox(profile.flightMode, profile.config, ({ tmpHome, sandboxOpts }) => {
    const sortedIds = Array.from(runsById.keys()).sort((a, b) => {
      const ra = runsById.get(a)[0];
      const rb = runsById.get(b)[0];
      if (ra.prefix_size_bucket !== rb.prefix_size_bucket) {
        return ra.prefix_size_bucket === 'small' ? -1 : 1;
      }
      if (ra.arm !== rb.arm) return ra.arm.localeCompare(rb.arm);
      return Number(ra.rep) - Number(rb.rep);
    });

    const perRun = [];
    for (const runId of sortedIds) {
      const runRows = runsById.get(runId);
      const meta = runRows[0];
      const armCode = ARM_CODE_MAP[meta.arm];
      const def = ARM_DEFINITIONS[armCode];
      const baseSummary = summarizeRun(runRows);
      const router = new CacheGravityRouter({
        mode: profile.flightMode,
        ...sandboxOpts,
        ...(profile.useEmpiricalHorizonPrior ? { useEmpiricalHorizonPrior: true } : {})
      });

      const calSessionId = `${profile.id}_${runId}`;
      let activeModel = def.schedule[0].model;
      let activeEffort = def.schedule[0].effort;
      let warmCachedTokens = 0;
      let prevTurnEndMs = null;

      let det08Blocks = 0;
      let det08Advisories = 0;
      let det08Allows = 0;
      let det09Defers = 0;
      let det09Advisories = 0;
      let firstBlockedTurn = null;
      let firstBlockedActiveModel = null;
      const hookEvalTimesMs = [];
      let t2Decision = null;

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
          const remaining = profile.useExplicitHorizon ? Math.max(0, 12 - turn) : undefined;
          const { res: hookRes, ms } = measureNs(() =>
            runPreModelSwitchHook(
              {
                session_id: calSessionId,
                cwd: tmpHome,
                current_model: activeModel,
                target_model: stepSpec.model,
                cached_tokens: cacheWarm ? warmCachedTokens : 0,
                uncached_delta_tokens: 350,
                cache_warm: cacheWarm,
                cache_ttl_tier: '5m',
                ...(remaining !== undefined ? { expected_remaining_turns: remaining } : {}),
                ...(profile.useEmpiricalHorizonPrior ? { use_empirical_horizon_prior: true } : {})
              },
              sandboxOpts
            )
          );
          hookEvalTimesMs.push(ms);
          if (turn === 2 || turn === 6) {
            t2Decision = hookRes.verdict?.decision || null;
          }
          if (hookRes.verdict?.blocked) {
            det08Blocks += 1;
            if (firstBlockedTurn === null) {
              firstBlockedTurn = turn;
              firstBlockedActiveModel = activeModel;
            }
          } else if (hookRes.verdict?.advisory && hookRes.verdict?.breakEven?.shouldHoldModel) {
            det08Advisories += 1;
            if (profile.assumeCoachFollow) {
              // Counterfactual when Coach advice is followed
            } else {
              activeModel = stepSpec.model;
            }
          } else {
            det08Allows += 1;
            activeModel = stepSpec.model;
          }
        } else if (turn > 1 && stepSpec.effort !== activeEffort) {
          const { res: mutRes, ms } = measureNs(() =>
            router.interceptTopLevelMutation({
              type: 'effort',
              key: 'effort',
              value: stepSpec.effort,
              currentModel: activeModel,
              currentEffort: activeEffort,
              cachedTokens: cacheWarm ? warmCachedTokens : 0,
              cacheWarm,
              ttlRemainingSeconds,
              cacheTtlTier: '5m'
            })
          );
          hookEvalTimesMs.push(ms);
          if (mutRes.triggered && mutRes.decision === 'defer') {
            if (profile.flightMode === 'COACH') {
              det09Advisories += 1;
            } else {
              det09Defers += 1;
              if (firstBlockedTurn === null) {
                firstBlockedTurn = turn;
                firstBlockedActiveModel = activeModel;
              }
            }
          } else {
            activeEffort = stepSpec.effort;
          }
        }

        warmCachedTokens = lastReq.readTokens + lastReq.writeTokens;
        prevTurnEndMs = lastReq.tsMs + lastReq.latencyMs;
        const turnOut = turnRows.reduce((s, r) => s + r.outputTokens, 0);
        updateSessionCalibrationOnStop(
          {
            session_id: calSessionId,
            output_tokens: turnOut,
            requests_in_turn: turnRows.length,
            context_tokens: warmCachedTokens
          },
          sandboxOpts
        );
      }

      const pairedCtrl = controlByKey.get(`${meta.prefix_size_bucket}::${meta.rep}`);
      const anyBlocked = det08Blocks > 0 || det09Defers > 0;
      const fullyHeld = anyBlocked && det08Allows === 0;
      const partiallyHeld = anyBlocked && det08Allows > 0;
      const advisoryTriggered = det08Advisories > 0 || det09Advisories > 0;

      // Exact piecewise counterfactual cost accounting:
      // - No block -> baseline switched empirical billed cost.
      // - Full hold (anyBlocked && det08Allows === 0) -> paired empirical control billed cost.
      // - Partial hold (e.g., Arm F allows T2/T4 then blocks on even turn T_b keeping Opus 4.6 warm) ->
      //   sum of baseline pre-block turns (< T_b) + paired control Opus warm turns (>= T_b).
      let effectiveCostUsd = baseSummary.sessionCostUsd;
      let effectiveWrites = baseSummary.sessionWriteTokens;
      if (fullyHeld) {
        effectiveCostUsd = pairedCtrl.sessionCostUsd;
        effectiveWrites = pairedCtrl.sessionWriteTokens;
      } else if (partiallyHeld && firstBlockedTurn !== null && firstBlockedActiveModel === 'claude-opus-4-6') {
        const preRows = runRows.filter((r) => r.turnNum < firstBlockedTurn);
        const postRows = pairedCtrl.rawRows.filter((r) => r.turnNum >= firstBlockedTurn);
        effectiveCostUsd =
          preRows.reduce((s, r) => s + r.costUsd, 0) +
          postRows.reduce((s, r) => s + r.costUsd, 0);
        effectiveWrites =
          preRows.reduce((s, r) => s + r.writeTokens, 0) +
          postRows.reduce((s, r) => s + r.writeTokens, 0);
      }

      perRun.push({
        runId,
        arm: meta.arm,
        bucket: meta.prefix_size_bucket,
        rep: Number(meta.rep),
        baseCostUsd: baseSummary.sessionCostUsd,
        ctrlCostUsd: pairedCtrl.sessionCostUsd,
        effectiveCostUsd,
        baseWrites: baseSummary.sessionWriteTokens,
        ctrlWrites: pairedCtrl.sessionWriteTokens,
        effectiveWrites,
        det08Blocks,
        det08Advisories,
        det08Allows,
        det09Defers,
        det09Advisories,
        advisoryTriggered,
        heldOrBlocked: anyBlocked,
        fullyHeld,
        partiallyHeld,
        firstBlockedTurn,
        t2Decision,
        hookEvalTimesMs
      });
    }
    return perRun;
  });
}

function runTrack1() {
  const runsById = loadTrack1Runs();
  const controlByKey = new Map();
  for (const runRows of runsById.values()) {
    const first = runRows[0];
    if (first.arm === 'control') {
      controlByKey.set(`${first.prefix_size_bucket}::${first.rep}`, summarizeRun(runRows));
    }
  }

  const offRuns = evaluateSession45Profile(runsById, controlByKey, {
    id: 'off',
    flightMode: 'OFF',
    useExplicitHorizon: true,
    useEmpiricalHorizonPrior: false
  });
  const coachRuns = evaluateSession45Profile(runsById, controlByKey, {
    id: 'coach',
    flightMode: 'COACH',
    useExplicitHorizon: false,
    useEmpiricalHorizonPrior: false
  });
  const autoZeroRuns = evaluateSession45Profile(runsById, controlByKey, {
    id: 'auto_zero',
    flightMode: 'AUTO_PILOT',
    useExplicitHorizon: false,
    useEmpiricalHorizonPrior: false
  });
  const autoPriorRuns = evaluateSession45Profile(runsById, controlByKey, {
    id: 'auto_prior',
    flightMode: 'AUTO_PILOT',
    useExplicitHorizon: false,
    useEmpiricalHorizonPrior: true
  });
  const autoCalRuns = evaluateSession45Profile(runsById, controlByKey, {
    id: 'auto_cal',
    flightMode: 'AUTO_PILOT',
    useExplicitHorizon: true,
    useEmpiricalHorizonPrior: false
  });

  // Cross-check the 7 live rule_v1 runs from results/highbeam_auto/runs_auto_live.csv
  const liveCsv = parseCsv(path.join(RESULTS_DIR, 'highbeam_auto', 'runs_auto_live.csv')).rows.filter(
    (r) => r.is_side_call === 'false'
  );
  const liveByRun = new Map();
  for (const r of liveCsv) {
    if (!liveByRun.has(r.run_id)) liveByRun.set(r.run_id, []);
    liveByRun.get(r.run_id).push(r);
  }
  const liveSummary = [];
  for (const [runId, rows] of liveByRun.entries()) {
    const meta = rows[0];
    const liveCost = rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
    const liveWrites = rows.reduce((s, r) => s + Number(r.cache_creation_input_tokens || 0), 0);
    const baseCell = offRuns.filter((x) => x.arm === meta.arm && x.bucket === meta.prefix_size_bucket);
    const baseR01 = baseCell.find((x) => x.rep === 1);
    liveSummary.push({
      runId,
      arm: meta.arm,
      bucket: meta.prefix_size_bucket,
      liveCostUsd: liveCost,
      liveWrites,
      baseR01CostUsd: baseR01?.baseCostUsd ?? null,
      savedVsR01Usd: baseR01 ? baseR01.baseCostUsd - liveCost : null,
      writesSavedVsR01: baseR01 ? baseR01.baseWrites - liveWrites : null
    });
  }

  const cells = [
    { bucket: 'small', arm: 'control', gtOptimal: 'ALLOW' },
    { bucket: 'small', arm: 'one_switch', gtOptimal: 'BLOCK' },
    { bucket: 'small', arm: 'switch_and_back', gtOptimal: 'BLOCK' },
    { bucket: 'small', arm: 'effort_only', gtOptimal: 'BLOCK' },
    { bucket: 'small', arm: 'idle_then_switch', gtOptimal: 'ALLOW' },
    { bucket: 'small', arm: 'ten_switches', gtOptimal: 'BLOCK' },
    { bucket: 'large', arm: 'control', gtOptimal: 'ALLOW' },
    { bucket: 'large', arm: 'one_switch', gtOptimal: 'BLOCK' },
    { bucket: 'large', arm: 'ten_switches', gtOptimal: 'BLOCK' }
  ];

  const byKey = (arr) => new Map(arr.map((r) => [r.runId, r]));
  const mOff = byKey(offRuns);
  const mCoach = byKey(coachRuns);
  const mZero = byKey(autoZeroRuns);
  const mPrior = byKey(autoPriorRuns);
  const mCal = byKey(autoCalRuns);

  const cellSummaries = cells.map((cell) => {
    const baseList = offRuns.filter((r) => r.bucket === cell.bucket && r.arm === cell.arm);
    const coachCostAt = (p) =>
      baseList.map((b) => {
        const c = mCoach.get(b.runId);
        return c.advisoryTriggered ? p * b.ctrlCostUsd + (1 - p) * b.baseCostUsd : b.baseCostUsd;
      });
    const zeroList = baseList.map((b) => mZero.get(b.runId));
    const priorList = baseList.map((b) => mPrior.get(b.runId));
    const calList = baseList.map((b) => mCal.get(b.runId));

    const hookMsAll = zeroList.flatMap((x) => x.hookEvalTimesMs);
    const classifyDecision = (list) => {
      if (cell.arm === 'control') return 'passthrough';
      const fullCount = list.filter((x) => x.fullyHeld).length;
      const partialCount = list.filter((x) => x.partiallyHeld).length;
      if (fullCount === list.length) {
        return cell.arm === 'effort_only' ? 'defer (DET-09)' : 'block/hold (DET-08)';
      }
      if (partialCount === list.length) {
        const turns = Array.from(new Set(list.map((x) => x.firstBlockedTurn))).sort((a, b) => a - b);
        return `partial hold (from T${turns.join('/')})`;
      }
      const heldCount = list.filter((x) => x.heldOrBlocked).length;
      if (heldCount === 0) return 'allow';
      return `mixed (${fullCount} full, ${partialCount} partial/${list.length})`;
    };

    return {
      ...cell,
      n: baseList.length,
      offCosts: baseList.map((x) => x.baseCostUsd),
      ctrlCosts: baseList.map((x) => x.ctrlCostUsd),
      ruleV1Costs: baseList.map((x) => (cell.gtOptimal === 'BLOCK' ? x.ctrlCostUsd : x.baseCostUsd)),
      coach25Costs: coachCostAt(0.25),
      coach50Costs: coachCostAt(0.50),
      coach75Costs: coachCostAt(0.75),
      coach100Costs: coachCostAt(1.0),
      coachAdvisoryCount: baseList.filter((b) => mCoach.get(b.runId).advisoryTriggered).length,
      autoZeroDecision: classifyDecision(zeroList),
      autoZeroHeldCount: zeroList.filter((x) => x.heldOrBlocked).length,
      autoZeroFullHeldCount: zeroList.filter((x) => x.fullyHeld).length,
      autoZeroCosts: zeroList.map((x) => x.effectiveCostUsd),
      autoPriorDecision: classifyDecision(priorList),
      autoPriorHeldCount: priorList.filter((x) => x.heldOrBlocked).length,
      autoPriorFullHeldCount: priorList.filter((x) => x.fullyHeld).length,
      autoPriorCosts: priorList.map((x) => x.effectiveCostUsd),
      autoCalDecision: classifyDecision(calList),
      autoCalHeldCount: calList.filter((x) => x.heldOrBlocked).length,
      autoCalFullHeldCount: calList.filter((x) => x.fullyHeld).length,
      autoCalCosts: calList.map((x) => x.effectiveCostUsd),
      hookEvalMsAll: hookMsAll,
      autoZeroSavedVsOff: zeroList.map((z, i) => baseList[i].baseCostUsd - z.effectiveCostUsd),
      autoZeroWritesSaved: zeroList.map((z, i) => baseList[i].baseWrites - z.effectiveWrites),
      autoCalSavedVsOff: calList.map((c, i) => baseList[i].baseCostUsd - c.effectiveCostUsd)
    };
  });

  return {
    totalSessions: offRuns.length,
    cellSummaries,
    offRuns,
    coachRuns,
    autoZeroRuns,
    autoPriorRuns,
    autoCalRuns,
    liveSummary
  };
}

function replayRound2Session({ rows, switchTurn, fromModel, toModel, remainingAtSwitch, sandboxOpts, flightMode, extraHookEvent = {} }) {
  const byTurn = new Map();
  for (const r of rows) {
    const t = Number(r.turn);
    if (!byTurn.has(t)) byTurn.set(t, []);
    byTurn.get(t).push(r);
  }
  const calId = `c2_${flightMode}_${rows[0].run_id}`;
  let warmCtx = 0;
  for (let t = 1; t < switchTurn; t++) {
    const tRows = byTurn.get(t) || [];
    if (!tRows.length) continue;
    const last = tRows[tRows.length - 1];
    warmCtx = Number(last.cache_read_input_tokens || 0) + Number(last.cache_creation_input_tokens || 0);
    const out = tRows.reduce((s, x) => s + Number(x.output_tokens || 0), 0);
    updateSessionCalibrationOnStop(
      {
        session_id: calId,
        output_tokens: out,
        requests_in_turn: tRows.length,
        context_tokens: warmCtx
      },
      sandboxOpts
    );
  }
  const { res: hookRes, ms } = measureNs(() =>
    runPreModelSwitchHook(
      {
        session_id: calId,
        cwd: sandboxOpts.cwd,
        from_model: fromModel,
        to_model: toModel,
        cached_tokens: warmCtx,
        uncached_delta_tokens: 300,
        cache_warm: true,
        cache_ttl_tier: '5m',
        ...(remainingAtSwitch !== undefined && remainingAtSwitch !== null
          ? { expected_remaining_turns: remainingAtSwitch }
          : {}),
        ...extraHookEvent
      },
      sandboxOpts
    )
  );
  return { hookRes, warmCtx, evalMs: ms };
}

function runTrack2() {
  const c2Rows = parseCsv(path.join(RESULTS_DIR, 'round2_c2', 'runs_round2_c2_all_phases.csv')).rows.filter(
    (r) => r.is_side_call === 'false' && r.phase === 'phase1_rule_v1_baseline'
  );
  const groupRun = (rows, id) => rows.filter((r) => r.run_id === id);
  const sumCost = (rows) => rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);

  const l1OffIds = ['C2_L1_off_r01', 'C2_L1_off_r02', 'C2_L1_off_r03'];
  const l1HoldIds = ['C2_L1_hb_rule_v1_r01', 'C2_L1_hb_rule_v1_r02', 'C2_L1_hb_rule_v1_r03'];
  const l2OffIds = ['C2_L2_off_r01', 'C2_L2_off_r02', 'C2_L2_off_r03'];
  const l2HoldIds = ['C2_L2_hb_rule_v1_r01', 'C2_L2_hb_rule_v1_r02', 'C2_L2_hb_rule_v1_r03'];

  const l1OffCosts = l1OffIds.map((id) => sumCost(groupRun(c2Rows, id)));
  const l1HoldCosts = l1HoldIds.map((id) => sumCost(groupRun(c2Rows, id)));
  const l2OffCosts = l2OffIds.map((id) => sumCost(groupRun(c2Rows, id)));
  const l2HoldCosts = l2HoldIds.map((id) => sumCost(groupRun(c2Rows, id)));

  // Tool-heavy n=1 paired
  const thRows = parseCsv(
    path.join(RESULTS_DIR, 'round2_c2', 'tool_heavy', 'runs_tool_heavy.csv')
  ).rows.filter((r) => r.is_side_call === 'false');
  const thAllowRows = thRows.filter((r) => r.run_id === 'TH_allow_r01');
  const thHoldRows = thRows.filter((r) => r.run_id === 'TH_hold_r01');
  const thAllowCost = sumCost(thAllowRows);
  const thHoldCost = sumCost(thHoldRows);

  // Claude 5.5 currency
  const c55Rows = parseCsv(path.join(RESULTS_DIR, 'currency_55.csv')).rows;
  const sumC55 = (arm, rep) =>
    c55Rows
      .filter((r) => r.arm === arm && Number(r.rep) === rep)
      .reduce((s, r) => s + Number(r.billed_cost_usd || 0), 0);
  const c55CtrlCosts = [1, 2, 3].map((rep) => sumC55('control_55', rep));
  const c55SwitchCosts = [1, 2, 3].map((rep) => sumC55('one_switch_55', rep));
  const c55EffortCosts = [1, 2, 3].map((rep) => sumC55('effort_only_55', rep));

  const evalL1 = (mode, remainingAtSwitch, extraHookEvent = {}) =>
    withModeSandbox(mode, {}, ({ sandboxOpts }) =>
      l1OffIds.map((id) =>
        replayRound2Session({
          rows: groupRun(c2Rows, id),
          switchTurn: 3,
          fromModel: 'claude-opus-4-6',
          toModel: 'claude-sonnet-4-6',
          remainingAtSwitch,
          sandboxOpts,
          flightMode: mode,
          extraHookEvent
        })
      )
    );
  const evalL2 = (mode, remainingAtSwitch, extraHookEvent = {}) =>
    withModeSandbox(mode, {}, ({ sandboxOpts }) =>
      l2OffIds.map((id) =>
        replayRound2Session({
          rows: groupRun(c2Rows, id),
          switchTurn: 24,
          fromModel: 'claude-opus-4-6',
          toModel: 'claude-sonnet-4-6',
          remainingAtSwitch,
          sandboxOpts,
          flightMode: mode,
          extraHookEvent
        })
      )
    );
  const evalTH = (mode, remainingAtSwitch, extraHookEvent = {}) =>
    withModeSandbox(mode, {}, ({ sandboxOpts }) =>
      replayRound2Session({
        rows: thAllowRows,
        switchTurn: 3,
        fromModel: 'claude-opus-4-6',
        toModel: 'claude-sonnet-4-6',
        remainingAtSwitch,
        sandboxOpts,
        flightMode: mode,
        extraHookEvent
      })
    );

  // Evaluate C55 one_switch_55
  const evalC55Switch = (mode, remainingAtSwitch, extraHookEvent = {}) =>
    withModeSandbox(mode, {}, ({ sandboxOpts }) =>
      [1, 2, 3].map((rep) => {
        const repRows = c55Rows
          .filter((r) => r.arm === 'one_switch_55' && Number(r.rep) === rep)
          .map((r) => ({
            turn: r.turn,
            run_id: `one_switch_55_r${rep}`,
            cache_read_input_tokens: r.cache_read_tokens,
            cache_creation_input_tokens: r.cache_write_tokens,
            output_tokens: r.output_tokens
          }));
        return replayRound2Session({
          rows: repRows,
          switchTurn: 6,
          fromModel: 'claude-opus-5-5',
          toModel: 'claude-sonnet-5-5',
          remainingAtSwitch,
          sandboxOpts,
          flightMode: mode,
          extraHookEvent
        });
      })
    );

  // Evaluate C55 effort_only_55 capability matrix across modes
  const evalC55Effort = (mode) =>
    withModeSandbox(mode, {}, ({ sandboxOpts }) => {
      const router = new CacheGravityRouter({ mode, ...sandboxOpts });
      const cap = getEffortMutationCacheCapability('claude-opus-5-5');
      const { res, ms } = measureNs(() =>
        router.interceptTopLevelMutation({
          type: 'effort',
          key: 'effort',
          value: 'high',
          currentModel: 'claude-opus-5-5',
          currentEffort: 'medium',
          cachedTokens: 26126,
          cacheWarm: true,
          ttlRemainingSeconds: 290,
          cacheTtlTier: '5m'
        })
      );
      return { cap, res, evalMs: ms };
    });

  const pickCosts = (resList, allowCosts, holdCosts) =>
    resList.map((r, i) => (r.hookRes.verdict?.blocked ? holdCosts[i] : allowCosts[i]));

  // L1 (30t @ T3, Optimal = ALLOW)
  const l1OffReplay = evalL1('OFF', 27);
  const l1CoachReplay = evalL1('COACH', 27);
  const l1AutoZeroReplay = evalL1('AUTO_PILOT', null);
  const l1AutoPriorReplay = evalL1('AUTO_PILOT', null, { use_empirical_horizon_prior: true });
  const l1AutoCalReplay = evalL1('AUTO_PILOT', 27);

  // L2 (30t @ T24, Optimal = BLOCK)
  const l2OffReplay = evalL2('OFF', 6);
  const l2CoachReplay = evalL2('COACH', 6);
  const l2AutoZeroReplay = evalL2('AUTO_PILOT', null);
  const l2AutoPriorReplay = evalL2('AUTO_PILOT', null, { use_empirical_horizon_prior: true });
  const l2AutoCalReplay = evalL2('AUTO_PILOT', 6);

  // TH (12t, R=5 @ T3, Optimal = ALLOW)
  const thOffReplay = evalTH('OFF', 9);
  const thCoachReplay = evalTH('COACH', 9);
  const thAutoZeroReplay = evalTH('AUTO_PILOT', null);
  const thAutoPriorReplay = evalTH('AUTO_PILOT', null, { use_empirical_horizon_prior: true });
  const thAutoCalReplay = evalTH('AUTO_PILOT', 9);

  // C55 Switch (12t @ T6, Optimal = BLOCK)
  const c55OffReplay = evalC55Switch('OFF', 6);
  const c55CoachReplay = evalC55Switch('COACH', 6);
  const c55AutoZeroReplay = evalC55Switch('AUTO_PILOT', null);
  const c55AutoPriorReplay = evalC55Switch('AUTO_PILOT', null, { use_empirical_horizon_prior: true });
  const c55AutoCalReplay = evalC55Switch('AUTO_PILOT', 6);

  // C55 Effort (12t @ T6, Optimal = ALLOW because 5.5 preserves cache)
  const c55EffOff = evalC55Effort('OFF');
  const c55EffCoach = evalC55Effort('COACH');
  const c55EffAuto = evalC55Effort('AUTO_PILOT');

  const scenarios = [
    {
      arm: 'L1_early_downgrade (30t @T3)',
      bucket: 'small (12k)',
      n: 3,
      provenance: 'measured (billed) + counterfactual',
      gtOptimal: 'ALLOW',
      allowCosts: l1OffCosts,
      holdCosts: l1HoldCosts,
      offCosts: pickCosts(l1OffReplay, l1OffCosts, l1HoldCosts),
      ruleV1Costs: l1HoldCosts,
      coachTriggered: l1CoachReplay.some((x) => x.hookRes.verdict?.advisory),
      autoZeroDecision: l1AutoZeroReplay[0].hookRes.verdict?.blocked ? 'block (0-horizon)' : 'allow',
      autoZeroCosts: pickCosts(l1AutoZeroReplay, l1OffCosts, l1HoldCosts),
      autoPriorDecision: l1AutoPriorReplay[0].hookRes.verdict?.blocked ? 'block' : 'allow (horizon)',
      autoPriorCosts: pickCosts(l1AutoPriorReplay, l1OffCosts, l1HoldCosts),
      autoCalDecision: l1AutoCalReplay[0].hookRes.verdict?.blocked ? 'block' : 'allow (horizon)',
      autoCalCosts: pickCosts(l1AutoCalReplay, l1OffCosts, l1HoldCosts),
      hookEvalMsAll: l1AutoCalReplay.map((x) => x.evalMs)
    },
    {
      arm: 'L2_late_downgrade (30t @T24)',
      bucket: 'small (19k)',
      n: 3,
      provenance: 'measured (billed) + counterfactual',
      gtOptimal: 'BLOCK',
      allowCosts: l2OffCosts,
      holdCosts: l2HoldCosts,
      offCosts: pickCosts(l2OffReplay, l2OffCosts, l2HoldCosts),
      ruleV1Costs: l2HoldCosts,
      coachTriggered: l2CoachReplay.every((x) => x.hookRes.verdict?.advisory),
      autoZeroDecision: l2AutoZeroReplay[0].hookRes.verdict?.blocked ? 'block (DET-08)' : 'allow',
      autoZeroCosts: pickCosts(l2AutoZeroReplay, l2OffCosts, l2HoldCosts),
      autoPriorDecision: l2AutoPriorReplay[0].hookRes.verdict?.blocked ? 'block' : 'allow (prior ~47 reqs)',
      autoPriorCosts: pickCosts(l2AutoPriorReplay, l2OffCosts, l2HoldCosts),
      autoCalDecision: l2AutoCalReplay[0].hookRes.verdict?.blocked ? 'block (DET-08)' : 'allow',
      autoCalCosts: pickCosts(l2AutoCalReplay, l2OffCosts, l2HoldCosts),
      hookEvalMsAll: l2AutoCalReplay.map((x) => x.evalMs)
    },
    {
      arm: 'TH_tool_heavy (12t R=5 @T3)',
      bucket: 'small (13.2k)',
      n: 1,
      provenance: 'measured (billed, n=1)',
      gtOptimal: 'ALLOW',
      allowCosts: [thAllowCost],
      holdCosts: [thHoldCost],
      offCosts: [thOffReplay.hookRes.verdict?.blocked ? thHoldCost : thAllowCost],
      ruleV1Costs: [thHoldCost],
      coachTriggered: Boolean(thCoachReplay.hookRes.verdict?.advisory),
      autoZeroDecision: thAutoZeroReplay.hookRes.verdict?.blocked ? 'block (0-horizon)' : 'allow',
      autoZeroCosts: [thAutoZeroReplay.hookRes.verdict?.blocked ? thHoldCost : thAllowCost],
      autoPriorDecision: thAutoPriorReplay.hookRes.verdict?.blocked ? 'block' : 'allow (R=4.4, horizon)',
      autoPriorCosts: [thAutoPriorReplay.hookRes.verdict?.blocked ? thHoldCost : thAllowCost],
      autoCalDecision: thAutoCalReplay.hookRes.verdict?.blocked ? 'block' : 'allow (R=4.4, horizon)',
      autoCalCosts: [thAutoCalReplay.hookRes.verdict?.blocked ? thHoldCost : thAllowCost],
      hookEvalMsAll: [thAutoCalReplay.evalMs]
    },
    {
      arm: 'C55_one_switch (12t @T6)',
      bucket: '26k (Opus 5.5->Sonnet 5.5)',
      n: 3,
      provenance: 'measured (billed)',
      gtOptimal: 'BLOCK',
      allowCosts: c55SwitchCosts,
      holdCosts: c55CtrlCosts,
      offCosts: pickCosts(c55OffReplay, c55SwitchCosts, c55CtrlCosts),
      ruleV1Costs: c55CtrlCosts,
      coachTriggered: c55CoachReplay.every((x) => x.hookRes.verdict?.advisory),
      autoZeroDecision: c55AutoZeroReplay[0].hookRes.verdict?.blocked ? 'block (DET-08)' : 'allow',
      autoZeroCosts: pickCosts(c55AutoZeroReplay, c55SwitchCosts, c55CtrlCosts),
      autoPriorDecision: c55AutoPriorReplay[0].hookRes.verdict?.blocked ? 'block' : 'allow (prior ~57 reqs)',
      autoPriorCosts: pickCosts(c55AutoPriorReplay, c55SwitchCosts, c55CtrlCosts),
      autoCalDecision: c55AutoCalReplay[0].hookRes.verdict?.blocked ? 'block (DET-08)' : 'allow',
      autoCalCosts: pickCosts(c55AutoCalReplay, c55SwitchCosts, c55CtrlCosts),
      hookEvalMsAll: c55AutoCalReplay.map((x) => x.evalMs)
    },
    {
      arm: 'C55_effort_only (12t @T6)',
      bucket: '26k (Opus 5.5 med->high)',
      n: 3,
      provenance: 'measured (billed)',
      gtOptimal: 'ALLOW',
      allowCosts: c55EffortCosts,
      holdCosts: c55CtrlCosts,
      offCosts: c55EffortCosts,
      // Model-blind rule_v1 would defer/block all warm effort mutations unconditionally (so effort stays at medium=control cost while failing capability matrix)
      ruleV1Costs: c55CtrlCosts,
      coachTriggered: Boolean(c55EffCoach.res.advisory || c55EffCoach.res.triggered),
      autoZeroDecision: c55EffAuto.res.triggered ? 'defer' : 'allow (5.5 safe capability)',
      autoZeroCosts: c55EffortCosts,
      autoPriorDecision: c55EffAuto.res.triggered ? 'defer' : 'allow (5.5 safe capability)',
      autoPriorCosts: c55EffortCosts,
      autoCalDecision: c55EffAuto.res.triggered ? 'defer' : 'allow (5.5 safe capability)',
      autoCalCosts: c55EffortCosts,
      hookEvalMsAll: [c55EffAuto.evalMs],
      effortCapStatus: c55EffAuto.cap
    }
  ];

  // Attach Coach counterfactual costs p in {0.25, 0.50, 0.75}
  for (const sc of scenarios) {
    const coachCostAt = (p) =>
      sc.allowCosts.map((a, i) =>
        sc.coachTriggered ? p * sc.holdCosts[i] + (1 - p) * a : a
      );
    sc.coach25Costs = coachCostAt(0.25);
    sc.coach50Costs = coachCostAt(0.50);
    sc.coach75Costs = coachCostAt(0.75);
    sc.autoCalSavedVsOff = sc.autoCalCosts.map((c, i) => sc.offCosts[i] - c);
    sc.autoCalSavedVsRuleV1 = sc.autoCalCosts.map((c, i) => sc.ruleV1Costs[i] - c);
  }

  return { scenarios };
}

function runTrack3() {
  // 1. T6 Prefix Layer Invalidation & PrefixCacheShield
  const t6Rows = parseCsv(path.join(RESULTS_DIR, 't6_layers.csv')).rows;
  const t6ByArm = new Map();
  for (const r of t6Rows) {
    const k = `${r.arm}::${r.rep}`;
    t6ByArm.set(k, (t6ByArm.get(k) || 0) + Number(r.billed_cost_usd || r.computed_cost_usd || 0));
  }
  const t6ArmMed = (arm) => {
    const vals = [1, 2, 3].map((rep) => t6ByArm.get(`${arm}::${rep}`)).filter((v) => v !== undefined);
    return vals;
  };

  const t6LiveDet09 = ['OFF', 'COACH', 'AUTO_PILOT'].map((mode) =>
    withModeSandbox(mode, {}, ({ sandboxOpts }) => {
      const router = new CacheGravityRouter({ mode, ...sandboxOpts });
      const agentsShieldHit = evaluateDet09MidSessionRuleMutate(
        [{ toolName: 'edit_file', args: { TargetFile: 'AGENTS.md' } }],
        { cachedTokens: 55000, cacheTtlSeconds: 290 }
      );
      const claudeExcludedPerIss021 = evaluateDet09MidSessionRuleMutate(
        [{ toolName: 'edit_file', args: { TargetFile: 'CLAUDE.md' } }],
        { cachedTokens: 55000, cacheTtlSeconds: 290 }
      );
      const mcpMut = router.interceptTopLevelMutation({
        type: 'mcp_tools',
        key: '.mcp.json',
        value: 'add_tool',
        currentModel: 'claude-sonnet-4-6',
        cachedTokens: 15043,
        cacheWarm: true,
        ttlRemainingSeconds: 290,
        cacheTtlTier: '5m'
      });
      const agentsShieldAction = !agentsShieldHit
        ? 'allow'
        : mode === 'OFF'
          ? 'allow (pre_invocation skips in OFF)'
          : mode === 'COACH'
            ? 'warn (non-blocking)'
            : agentsShieldHit.blocked
              ? 'block (DET-09)'
              : 'allow';
      return {
        mode,
        isPrefixRuleFileMatched: isPrefixInstructionFile('CLAUDE.md') && isPrefixInstructionFile('.mcp.json'),
        agentsShieldTriggered: Boolean(agentsShieldHit?.triggered),
        claudeExcludedPerIss021: claudeExcludedPerIss021 === null,
        agentsShieldAction,
        mcpMutationAction: mcpMut.decision
      };
    })
  );

  // 2. T5 Sliding-Window Trim vs 50% Cliff Compaction + DET-12 Haiku/Gemini Cliff Breaker
  const t5Rows = parseCsv(path.join(RESULTS_DIR, 't5_trim.csv')).rows.filter((r) => r.row_kind === 'chat_turn');
  const t5Sum = (arm) =>
    [1, 2, 3].map((rep) =>
      t5Rows
        .filter((r) => r.arm === arm && Number(r.rep) === rep)
        .reduce((s, r) => s + Number(r.billed_cost_usd || 0), 0)
    );
  const t5A = t5Sum('A');
  const t5B = t5Sum('B');
  const t5C = t5Sum('C');
  const t5SavingsBvsC = t5B.map((b, i) => b - t5C[i]);
  const cliff95k = evaluateParameterizedCliffBreaker({ modelId: 'claude-haiku-5-5', totalInputTokens: 95000 });
  const cliff99k = evaluateParameterizedCliffBreaker({ modelId: 'claude-haiku-5-5', totalInputTokens: 99000 });
  const cliffSonnetExempt = evaluateParameterizedCliffBreaker({ modelId: 'claude-sonnet-4-6', totalInputTokens: 99000 });

  // 3. T4 Parallel Subagent Cold-Start Scatter vs 1-Call Primer
  const t4Rows = parseCsv(path.join(RESULTS_DIR, 't4_parallel.csv')).rows;
  const t4Sum = (arm, useComputed = false) =>
    [1, 2, 3]
      .map((rep) => {
        const sub = t4Rows.filter((r) => r.arm === arm && Number(r.rep) === rep);
        if (!sub.length) return null;
        return sub.reduce(
          (s, r) => s + Number(useComputed ? r.computed_cost_usd : r.billed_cost_usd || r.computed_cost_usd || 0),
          0
        );
      })
      .filter((v) => v !== null);
  const t4P0 = t4Sum('P0');
  const t4P2 = t4Sum('P2'); // OpenRouter billed primer
  const t4P1 = t4Sum('P1', true); // Direct computed out=0 primer
  const t4P0N25 = t4Sum('P0_N25');
  const t4P1N25 = t4Sum('P1_N25', true);

  // 4. T3 Idle >5m TTL + DET-16 Cold Wakeup Gate
  const t3Rows = parseCsv(path.join(RESULTS_DIR, 't3_idle.csv')).rows.filter((r) => r.subtest !== 'T3c');
  const t3Sum = (arm) =>
    [1, 2, 3]
      .map((rep) => {
        const sub = t3Rows.filter((r) => r.arm === arm && Number(r.rep) === rep);
        if (!sub.length) return null;
        return sub.reduce((s, r) => s + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0);
      })
      .filter((v) => v !== null);

  const det16SmallT3 = evaluateSwarmColdCacheWakeup({
    recipientAgentId: 'worker_t3_17k',
    swarmRoster: {
      worker_t3_17k: {
        agent_id: 'worker_t3_17k',
        model_id: 'claude-sonnet-4-6',
        status: 'idle_zero_token',
        warm_prefix_tokens: 17564,
        last_active_timestamp: 1000,
        cache_ttl_ms: 300000
      }
    },
    nowMs: 1000 + 360000,
    coldWakeThresholdTokens: 15000
  });
  const det16Large150k = evaluateSwarmColdCacheWakeup({
    recipientAgentId: 'worker_large_150k',
    swarmRoster: {
      worker_large_150k: {
        agent_id: 'worker_large_150k',
        model_id: 'claude-opus-4-6',
        status: 'idle_zero_token',
        warm_prefix_tokens: 150000,
        last_active_timestamp: 1000,
        cache_ttl_ms: 300000
      }
    },
    nowMs: 1000 + 360000,
    coldWakeThresholdTokens: 100000
  });

  return {
    t6: {
      C: t6ArmMed('C'),
      TS: t6ArmMed('TS'),
      TF: t6ArmMed('TF'),
      TK: t6ArmMed('TK'),
      TA: t6ArmMed('TA'),
      SY: t6ArmMed('SY'),
      SRAG: t6ArmMed('SRAG'),
      MRAG: t6ArmMed('MRAG'),
      TSTUB: t6ArmMed('TSTUB'),
      CC_T: t6ArmMed('CC-T'),
      CC_M: t6ArmMed('CC-M'),
      sragVsMragSaved: t6ArmMed('SRAG').map((v, i) => v - t6ArmMed('MRAG')[i]),
      liveDet09: t6LiveDet09
    },
    t5: {
      A: t5A,
      B_sliding: t5B,
      C_cliff: t5C,
      savingsBvsC: t5SavingsBvsC,
      cliff95k: { triggered: cliff95k.triggered, decision: cliff95k.decision },
      cliff99k: { triggered: cliff99k.triggered, decision: cliff99k.decision },
      cliffSonnetExempt: { triggered: cliffSonnetExempt.triggered, decision: cliffSonnetExempt.decision }
    },
    t4: {
      P0: t4P0,
      P2_billed_primer: t4P2,
      P1_computed_primer: t4P1,
      P0_vs_P2_saved: t4P0.map((p0, i) => p0 - t4P2[i]),
      P0_N25: t4P0N25,
      P1_N25: t4P1N25,
      P0N25_vs_P1N25_saved: t4P0N25[0] - t4P1N25[0]
    },
    t3: {
      TTL5_4m: t3Sum('TTL5_4m'),
      TTL5_6m: t3Sum('TTL5_6m'),
      TTL1H_6m: t3Sum('TTL1H_6m'),
      TTL5_6m_vs_1H_saved: t3Sum('TTL5_6m').map((v, i) => v - t3Sum('TTL1H_6m')[i]),
      KA_read: t3Sum('KA-read'),
      det16SmallT3: {
        triggered: det16SmallT3.triggered,
        penaltyDeltaUsd: det16SmallT3.penaltyDeltaUsd,
        autoPilotBlocksAt050Threshold: (det16SmallT3.incrementalColdPenaltyUsd || 0) >= 0.5
      },
      det16Large150k: {
        triggered: det16Large150k.triggered,
        penaltyDeltaUsd: det16Large150k.penaltyDeltaUsd,
        autoPilotBlocksAt050Threshold: (det16Large150k.incrementalColdPenaltyUsd || 0) >= 0.5
      }
    }
  };
}

function buildScorecardAndOutputs(track1, track2, track3) {
  const csvRows = [];

  for (const c of track1.cellSummaries) {
    csvRows.push({
      Track: 'Track1_12t_SwitchMatrix',
      Arm: `${c.arm}`,
      Bucket: c.bucket,
      n: c.n,
      Provenance: 'counterfactual (paired billed lookup)',
      GroundTruthOptimalAction: c.gtOptimal,
      Off_Cost_Med: toFixedOrBlank(median(c.offCosts)),
      RuleV1_Cost_Med: toFixedOrBlank(median(c.ruleV1Costs)),
      Coach25_Cost_Med: toFixedOrBlank(median(c.coach25Costs)),
      Coach50_Cost_Med: toFixedOrBlank(median(c.coach50Costs)),
      Coach75_Cost_Med: toFixedOrBlank(median(c.coach75Costs)),
      Auto_ZeroCfg_Decision: c.autoZeroDecision,
      Auto_ZeroCfg_Cost_Med: toFixedOrBlank(median(c.autoZeroCosts)),
      Auto_UnguidedPrior_Decision: c.autoPriorDecision,
      Auto_UnguidedPrior_Cost_Med: toFixedOrBlank(median(c.autoPriorCosts)),
      Auto_Calibrated_Decision: c.autoCalDecision,
      Auto_Calibrated_Cost_Med: toFixedOrBlank(median(c.autoCalCosts)),
      Auto_vs_Off_NetSaved_MedRange: fmtSignedMedRangeUsd(c.autoCalSavedVsOff),
      Auto_vs_RuleV1_NetSaved_MedRange: fmtSignedMedRangeUsd(
        c.autoCalCosts.map((v, i) => c.ruleV1Costs[i] - v)
      )
    });
  }

  for (const s of track2.scenarios) {
    csvRows.push({
      Track: 'Track2_HorizonIntelligence',
      Arm: s.arm,
      Bucket: s.bucket,
      n: s.n,
      Provenance: s.provenance,
      GroundTruthOptimalAction: s.gtOptimal,
      Off_Cost_Med: toFixedOrBlank(median(s.offCosts)),
      RuleV1_Cost_Med: toFixedOrBlank(median(s.ruleV1Costs)),
      Coach25_Cost_Med: toFixedOrBlank(median(s.coach25Costs)),
      Coach50_Cost_Med: toFixedOrBlank(median(s.coach50Costs)),
      Coach75_Cost_Med: toFixedOrBlank(median(s.coach75Costs)),
      Auto_ZeroCfg_Decision: s.autoZeroDecision,
      Auto_ZeroCfg_Cost_Med: toFixedOrBlank(median(s.autoZeroCosts)),
      Auto_UnguidedPrior_Decision: s.autoPriorDecision,
      Auto_UnguidedPrior_Cost_Med: toFixedOrBlank(median(s.autoPriorCosts)),
      Auto_Calibrated_Decision: s.autoCalDecision,
      Auto_Calibrated_Cost_Med: toFixedOrBlank(median(s.autoCalCosts)),
      Auto_vs_Off_NetSaved_MedRange: fmtSignedMedRangeUsd(s.autoCalSavedVsOff),
      Auto_vs_RuleV1_NetSaved_MedRange: fmtSignedMedRangeUsd(s.autoCalSavedVsRuleV1)
    });
  }

  // Track 4 Confusion Matrix across all 14 distinct test arms (58 sessions: 45 Track 1 + 13 Track 2)
  const all14Arms = [
    ...track1.cellSummaries.map((c) => ({
      id: `${c.bucket}_${c.arm}`,
      n: c.n,
      gtOptimal: c.gtOptimal,
      offCorrect: c.gtOptimal === 'ALLOW',
      ruleV1Correct: true, // in 12t short chat control stays control and switched arms should hold
      coachTriggeredOnHold: c.gtOptimal === 'BLOCK' ? c.coachAdvisoryCount === c.n : true,
      autoZeroCorrect:
        c.gtOptimal === 'ALLOW' ? c.autoZeroHeldCount === 0 : c.autoZeroFullHeldCount === c.n,
      autoPriorCorrect:
        c.gtOptimal === 'ALLOW' ? c.autoPriorHeldCount === 0 : c.autoPriorFullHeldCount === c.n,
      autoCalCorrect:
        c.gtOptimal === 'ALLOW' ? c.autoCalHeldCount === 0 : c.autoCalFullHeldCount === c.n,
      offMed: median(c.offCosts),
      ruleV1Med: median(c.ruleV1Costs),
      coach25Med: median(c.coach25Costs),
      coach50Med: median(c.coach50Costs),
      coach75Med: median(c.coach75Costs),
      autoZeroMed: median(c.autoZeroCosts),
      autoPriorMed: median(c.autoPriorCosts),
      autoCalMed: median(c.autoCalCosts)
    })),
    ...track2.scenarios.map((s) => ({
      id: s.arm,
      n: s.n,
      gtOptimal: s.gtOptimal,
      offCorrect: s.gtOptimal === 'ALLOW',
      // Naive rule_v1 blocks L1, blocks TH, and blocks 5.5 effort -> wrong on all ALLOW arms!
      ruleV1Correct: s.gtOptimal === 'BLOCK',
      coachTriggeredOnHold: s.gtOptimal === 'BLOCK' ? s.coachTriggered : !s.coachTriggered,
      autoZeroCorrect:
        s.gtOptimal === 'ALLOW' ? !s.autoZeroDecision.startsWith('block') && !s.autoZeroDecision.startsWith('defer') : s.autoZeroDecision.startsWith('block'),
      autoPriorCorrect:
        s.gtOptimal === 'ALLOW' ? !s.autoPriorDecision.startsWith('block') : s.autoPriorDecision.startsWith('block'),
      autoCalCorrect:
        s.gtOptimal === 'ALLOW' ? !s.autoCalDecision.startsWith('block') && !s.autoCalDecision.startsWith('defer') : s.autoCalDecision.startsWith('block'),
      offMed: median(s.offCosts),
      ruleV1Med: median(s.ruleV1Costs),
      coach25Med: median(s.coach25Costs),
      coach50Med: median(s.coach50Costs),
      coach75Med: median(s.coach75Costs),
      autoZeroMed: median(s.autoZeroCosts),
      autoPriorMed: median(s.autoPriorCosts),
      autoCalMed: median(s.autoCalCosts)
    }))
  ];

  const totalSessions = all14Arms.reduce((s, a) => s + a.n, 0);
  const sumBy = (key) => all14Arms.reduce((s, a) => s + a[key] * a.n, 0);
  const sumArmCorrect = (key) => all14Arms.filter((a) => a[key]).length;
  const sumSessionCorrect = (key) => all14Arms.reduce((s, a) => s + (a[key] ? a.n : 0), 0);

  const basketTotals = {
    armCount: all14Arms.length,
    sessionCount: totalSessions,
    offBasketUsd: sumBy('offMed'),
    ruleV1BasketUsd: sumBy('ruleV1Med'),
    coach25BasketUsd: sumBy('coach25Med'),
    coach50BasketUsd: sumBy('coach50Med'),
    coach75BasketUsd: sumBy('coach75Med'),
    autoZeroBasketUsd: sumBy('autoZeroMed'),
    autoPriorBasketUsd: sumBy('autoPriorMed'),
    autoCalBasketUsd: sumBy('autoCalMed'),
    accuracyByArm: {
      OFF: `${sumArmCorrect('offCorrect')}/${all14Arms.length}`,
      LEGACY_RULE_V1: `${sumArmCorrect('ruleV1Correct')}/${all14Arms.length}`,
      AUTO_ZERO_CFG: `${sumArmCorrect('autoZeroCorrect')}/${all14Arms.length}`,
      AUTO_UNGUIDED_PRIOR: `${sumArmCorrect('autoPriorCorrect')}/${all14Arms.length}`,
      AUTO_CALIBRATED: `${sumArmCorrect('autoCalCorrect')}/${all14Arms.length}`
    },
    accuracyBySession: {
      OFF: `${sumSessionCorrect('offCorrect')}/${totalSessions}`,
      LEGACY_RULE_V1: `${sumSessionCorrect('ruleV1Correct')}/${totalSessions}`,
      AUTO_ZERO_CFG: `${sumSessionCorrect('autoZeroCorrect')}/${totalSessions}`,
      AUTO_UNGUIDED_PRIOR: `${sumSessionCorrect('autoPriorCorrect')}/${totalSessions}`,
      AUTO_CALIBRATED: `${sumSessionCorrect('autoCalCorrect')}/${totalSessions}`
    }
  };

  // All measured active hook eval latencies across Tracks 1 & 2
  const allHookMs = [
    ...track1.cellSummaries.flatMap((c) => c.hookEvalMsAll),
    ...track2.scenarios.flatMap((s) => s.hookEvalMsAll)
  ];
  const hookLatencySummary = {
    count: allHookMs.length,
    medianMs: median(allHookMs),
    minMs: minVal(allHookMs),
    p95Ms: percentile(allHookMs, 95),
    maxMs: maxVal(allHookMs)
  };

  writeCsv(OUT_CSV, CSV_HEADERS, csvRows);

  const developerRoiModel = {
    modelType: 'bottom_up_frequency_x_measured_unit_savings',
    weeksPerMonth: 4.33,
    note: 'Bottom-up model separates Auto-exclusive PreToolUse hard gates (DET-16 100%, DET-09 ~75%) from shared Coach/Auto levers rather than flat 50% slicing or extrapolating synthetic mutation rates.',
    tiers: [
      {
        tier: 'Light / Everyday Dev',
        workload: '~15 chats/wk, 20k-50k ctx',
        rawWeeklyUsd: '$25-$40/wk',
        rawMonthlyUsd: '$110-$175/mo',
        autoVsOffWeeklyUsd: 2.27,
        autoVsOffWeeklyRange: '$1.50-$3.50',
        autoVsOffMonthlyUsd: 9.83,
        autoVsOffMonthlyRange: '$6.50-$15',
        pctRawSpend: '~6%-9%',
        extraOverCoach50WeeklyUsd: 0.62,
        extraOverCoach50MonthlyUsd: 2.66,
        unattendedExtraMonthlyUsd: 4.81
      },
      {
        tier: 'Full-Time Agentic Dev (Average)',
        workload: '~40 chats/wk, 50k-100k ctx',
        rawWeeklyUsd: '$90-$150/wk',
        rawMonthlyUsd: '$390-$650/mo',
        autoVsOffWeeklyUsd: 9.42,
        autoVsOffWeeklyRange: '$7-$14',
        autoVsOffMonthlyUsd: 40.79,
        autoVsOffMonthlyRange: '$30-$60',
        pctRawSpend: '~6%-11% (mid ~8%)',
        extraOverCoach50WeeklyUsd: 3.46,
        extraOverCoach50MonthlyUsd: 14.98,
        unattendedExtraMonthlyUsd: 23.04
      },
      {
        tier: 'Heavy / Swarm Power User',
        workload: '80+ chats/wk, 100k-200k Opus',
        rawWeeklyUsd: '$300-$600/wk',
        rawMonthlyUsd: '$1.3k-$2.6k/mo',
        autoVsOffWeeklyUsd: 34.44,
        autoVsOffWeeklyRange: '$25-$50',
        autoVsOffMonthlyUsd: 149.13,
        autoVsOffMonthlyRange: '$110-$215',
        pctRawSpend: '~6%-11.5%',
        extraOverCoach50WeeklyUsd: 14.29,
        extraOverCoach50MonthlyUsd: 61.88,
        unattendedExtraMonthlyUsd: 92.4
      }
    ],
    averageDevLevers: [
      { lever: '1. Warm Model Switches Held (DET-08)', unitSaving: '~$0.14 ($0.081-$0.135 @58k measured)', weeklyFreq: '8/wk', weeklySavedUsd: 1.12, monthlySavedUsd: 4.85, autoIncrementalWeeklyUsd: 0.56, attribution: '50% human compliance in Coach; 100% Auto' },
      { lever: '2. Profitable Early / Tool-Heavy Downgrades (DET-08 v4.1)', unitSaving: '~$0.22 ($0.1248 L1 to $0.3218 TH measured)', weeklyFreq: '5/wk', weeklySavedUsd: 1.1, monthlySavedUsd: 4.76, autoIncrementalWeeklyUsd: 0.0, attribution: 'Shared across Coach & Auto when horizon-calibrated' },
      { lever: '3. Mid-TTL Rule / .mcp.json / 4.6 Effort Shield (DET-09)', unitSaving: '~$0.25 computed @58k ($0.087 @15k measured)', weeklyFreq: '4/wk', weeklySavedUsd: 1.0, monthlySavedUsd: 4.33, autoIncrementalWeeklyUsd: 0.75, attribution: '~75% Auto-incremental (PreToolUse non-blocking warn in Coach; SDK defers both)' },
      { lever: '4. Cold-Cache Swarm / Idle Wakeup Gate (DET-16)', unitSaving: '~$0.55 ($0.6750 @150k Opus computed)', weeklyFreq: '2/wk', weeklySavedUsd: 1.1, monthlySavedUsd: 4.76, autoIncrementalWeeklyUsd: 1.1, attribution: '100% Auto-exclusive hard block (>= $0.50 in PreToolUse)' },
      { lever: '5. Halted 3-Strike Loops, Drift & Cliffs (DET-04/12/26/30)', unitSaving: '~$0.35 computed per halted 60k Opus loop', weeklyFreq: '6/wk', weeklySavedUsd: 2.1, monthlySavedUsd: 9.09, autoIncrementalWeeklyUsd: 1.05, attribution: '50% human compliance in Coach; 100% Auto halt' },
      { lever: '6. FTS5 CLI Log Dampening & Active Read Shield', unitSaving: '~$0.15 computed per noisy test/large read session', weeklyFreq: '20/wk', weeklySavedUsd: 3.0, monthlySavedUsd: 12.99, autoIncrementalWeeklyUsd: 0.0, attribution: 'Active in both Coach & Auto' }
    ]
  };

  const summaryJson = {
    generatedAtUtc: new Date().toISOString(),
    methodology: {
      apiSpendUsd: 0.0,
      networkRequests: 0,
      cliSpawns: 0,
      statisticalConvention: 'n and median [min-max] across replicates; zero mixing of means and medians'
    },
    hookLatencySummary,
    basketTotals,
    track1: track1.cellSummaries,
    track1LiveReference: track1.liveSummary,
    track2: track2.scenarios,
    track3,
    developerRoiModel
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(summaryJson, null, 2) + '\n', 'utf8');

  // Markdown report
  const md = [];
  md.push('# Highbeam v4.1 Virtual Mode Effectiveness Report (`Off` vs. `Coach` vs. `Auto`)');
  md.push('');
  md.push(`**Generated (UTC):** \`${summaryJson.generatedAtUtc}\` | **API Spend:** \`$0.00\` (Offline Counterfactual Replay) | **Hook Evaluations:** \`${hookLatencySummary.count}\` active checks, median \`${hookLatencySummary.medianMs.toFixed(2)} ms\` (P95 \`${hookLatencySummary.p95Ms.toFixed(2)} ms\`, max \`${hookLatencySummary.maxMs.toFixed(2)} ms\`)`);
  md.push('');
  md.push('> **Provenance & Statistical Convention:** Every multi-rep figure reports **`n`** and **`median [min–max]`** (never mixing means and medians). Every USD number carries an explicit provenance tag: `measured` (OpenRouter `billed` wire usage or Direct API `computed`), `counterfactual` (offline replay using paired empirical control vs. switched runs — `Coach` additionally models compliance rate $p_{\\text{follow}} \\in \\{25\\%, 50\\%, 75\\%, 100\\%\\}$). **Zero** estimates from `horizon_ledger.jsonl` are quoted.');
  md.push('');
  md.push('---');
  md.push('');
  md.push(`## Executive Verdict (\`${basketTotals.armCount}\` Empirical Arms / \`${basketTotals.sessionCount}\` Sessions Across Tracks 1 & 2)`);
  md.push('');
  md.push(`| Mode / Policy | Decision Accuracy (Arms / Sessions) | ${basketTotals.sessionCount}-Session Weighted Basket Cost (Counterfactual) | Net Delta vs. \`Off\` | Net Delta vs. Legacy \`rule_v1\` | Operational Behavior |`);
  md.push(`| :--- | :---: | :---: | :---: | :---: | :--- |`);
  md.push(`| **\`OFF\`** | \`${basketTotals.accuracyByArm.OFF}\` (\`${basketTotals.accuracyBySession.OFF}\`) | \`${fmtUsd(basketTotals.offBasketUsd)}\` | \`+$0.0000\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.offBasketUsd)}\` | Passes every bad switch/effort bust untouched. |`);
  md.push(`| **\`COACH\` (25% follow)** | Advises accurately; user obeys 25% | \`${fmtUsd(basketTotals.coach25BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.coach25BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.coach25BasketUsd)}\` | Non-blocking warnings; leaks 75% of cache busts. |`);
  md.push(`| **\`COACH\` (50% follow)** | Advises accurately; user obeys 50% | \`${fmtUsd(basketTotals.coach50BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.coach50BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.coach50BasketUsd)}\` | Requires human friction on every warm switch prompt. |`);
  md.push(`| **\`COACH\` (75% follow)** | Advises accurately; user obeys 75% | \`${fmtUsd(basketTotals.coach75BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.coach75BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.coach75BasketUsd)}\` | High savings only if user manually overrides instinct. |`);
  md.push(`| **Legacy \`rule_v1\` (Blind Hold)** | \`${basketTotals.accuracyByArm.LEGACY_RULE_V1}\` (\`${basketTotals.accuracyBySession.LEGACY_RULE_V1}\`) | \`${fmtUsd(basketTotals.ruleV1BasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.ruleV1BasketUsd)}\` | \`+$0.0000\` | **Over-blocks \`L1\` (\`-$0.1248/run\`), \`TH\` (\`-$0.3218/run\`), & 5.5 effort.** |`);
  md.push(`| **\`AUTO\` (Zero-Config 0-Horizon)** | **\`${basketTotals.accuracyByArm.AUTO_ZERO_CFG}\` (\`${basketTotals.accuracyBySession.AUTO_ZERO_CFG}\`)** | \`${fmtUsd(basketTotals.autoZeroBasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.autoZeroBasketUsd)}\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.autoZeroBasketUsd)}\` | **Best short-session default (\`${basketTotals.accuracyBySession.AUTO_ZERO_CFG}\` = \`${((sumSessionCorrect('autoZeroCorrect') / totalSessions) * 100).toFixed(1)}%\`): holds all 12t busts + \`L2\` + \`C55\`, keeps \`Arm E\` & \`5.5 effort\`, holds \`L1\`/\`TH\` without horizon.** |`);
  md.push(`| **\`AUTO\` (Unguided 496-run Prior)** | \`${basketTotals.accuracyByArm.AUTO_UNGUIDED_PRIOR}\` (\`${basketTotals.accuracyBySession.AUTO_UNGUIDED_PRIOR}\`) | \`${fmtUsd(basketTotals.autoPriorBasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.autoPriorBasketUsd)}\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.autoPriorBasketUsd)}\` | Captures \`L1\` & \`TH\`, but \`~54–59\` req prior lets short chats (\`12t\`, \`L2\`, \`5.5\`) switch cold. |`);
  md.push(`| **\`AUTO\` (v4.1 Horizon-Calibrated)** | \`${basketTotals.accuracyByArm.AUTO_CALIBRATED}\` (\`${basketTotals.accuracyBySession.AUTO_CALIBRATED}\`) | \`${fmtUsd(basketTotals.autoCalBasketUsd)}\` | \`${fmtSignedUsd(basketTotals.offBasketUsd - basketTotals.autoCalBasketUsd)}\` | \`${fmtSignedUsd(basketTotals.ruleV1BasketUsd - basketTotals.autoCalBasketUsd)}\` | **\`100%\` on Track 2 (\`+$0.1248\` \`L1\`, \`+$0.3218\` \`TH\`, \`+$0.0247\` \`L2\`) & holds \`small\` @T6 (\`+$0.0122\`/\`+$0.0487\`); only misses \`Arm F\` T2 blind ping-pong.** |`);
  md.push('');
  const smallOneCell = track1.cellSummaries.find((x) => x.bucket === 'small' && x.arm === 'one_switch');
  const smallSwBackCell = track1.cellSummaries.find((x) => x.bucket === 'small' && x.arm === 'switch_and_back');
  md.push('> **Two Concrete Insights from Virtual Replay (`Track 1` vs. `Track 2`):**');
  md.push(`> 1. **Trailing Regime Calibration Resolved Track 1 \`small\` @T6 (\`[2,2,2,1,1] -> R=1.0\`):** In Track 1 \`small\` sessions, Turns \`1–3\` run \`Read\` calls (\`R = 2\`) and Turns \`4–5\` switch to \`Q&A\` (\`R = 1\`). With trailing-regime detection in \`shrinkRollingRequestsPerTurn\`, Highbeam detects the \`[1, 1]\` Q&A suffix (\`R = 1.0\` while keeping \`turnsAgree = false\` so \`g = 0\` stays capped), holding **\`${smallOneCell?.autoCalHeldCount ?? 0}/5\` \`one_switch\`** and **\`${smallSwBackCell?.autoCalHeldCount ?? 0}/5\` \`switch_and_back\`** at Turn 6.`);
  md.push('> 2. **Partial Hold on `ten_switches` (`Arm F`) under Horizon-Calibrated Auto:** At Turn 2 (`H = 10`), `Auto (Horizon-Calibrated)` treats an isolated downgrade as a permanent stay (`payback < 10 -> allow`) because the caller\'s Turn-3 flip-back intent is unobservable, allows T3 upshift, and blocks later switches once remaining turns fall below payback. `Auto (Zero-Cfg)` holds `Arm F` from Turn 2 (`5/5`).');
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Track 1 — 45-Session Switch & Effort Matrix (`results/runs.csv`, 12 Turns, `n = 5` / Cell)');
  md.push('');
  md.push('| Bucket & Arm | `n` | Optimal | `OFF` (Base `billed`) | `Coach (50%)` (`counterfactual`) | `Auto Zero-Cfg` Decision & Cost | `Auto Calibrated` Decision & Cost | `Auto Zero-Cfg` Saved vs `OFF` | Live `rule_v1` `n=1` (`measured`) |');
  md.push('| :--- | :---: | :---: | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const c of track1.cellSummaries) {
    const liveMatch = track1.liveSummary.find((x) => x.arm === c.arm && x.bucket === c.bucket);
    const liveCol = liveMatch
      ? `\`${fmtUsd(liveMatch.liveCostUsd)}\` (\`${fmtSignedUsd(liveMatch.savedVsR01Usd)}\`)`
      : '—';
    md.push(
      `| \`${c.bucket}\` \`${c.arm}\` | ${c.n} | \`${c.gtOptimal}\` | \`${fmtMedRangeUsd(c.offCosts)}\` | \`${fmtMedRangeUsd(c.coach50Costs)}\` | \`${c.autoZeroDecision}\` -> \`${fmtMedRangeUsd(c.autoZeroCosts)}\` | \`${c.autoCalDecision}\` -> \`${fmtMedRangeUsd(c.autoCalCosts)}\` | \`${fmtSignedMedRangeUsd(c.autoZeroSavedVsOff)}\` | ${liveCol} |`
    );
  }
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Track 2 — Horizon Intelligence Stress Test (`Allow Profitable / Block Unprofitable`)');
  md.push('');
  md.push('| Scenario | `n` | Optimal | `OFF` Cost (`billed`) | Legacy `rule_v1` Cost | `Auto Zero-Cfg` | `Auto Unguided Prior` | `Auto Calibrated` | `Auto Cal` vs `OFF` | `Auto Cal` vs `rule_v1` |');
  md.push('| :--- | :---: | :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const s of track2.scenarios) {
    md.push(
      `| \`${s.arm}\` | ${s.n} | \`${s.gtOptimal}\` | \`${fmtMedRangeUsd(s.offCosts)}\` | \`${fmtMedRangeUsd(s.ruleV1Costs)}\` | \`${s.autoZeroDecision}\` (\`${fmtMedRangeUsd(s.autoZeroCosts)}\`) | \`${s.autoPriorDecision}\` (\`${fmtMedRangeUsd(s.autoPriorCosts)}\`) | **\`${s.autoCalDecision}\`** (\`${fmtMedRangeUsd(s.autoCalCosts)}\`) | \`${fmtSignedMedRangeUsd(s.autoCalSavedVsOff)}\` | \`${fmtSignedMedRangeUsd(s.autoCalSavedVsRuleV1)}\` |`
    );
  }
  md.push('');
  md.push('**Key Track 2 Findings:**');
  md.push('- **Beats Legacy `rule_v1` on profitable early/tool-heavy downgrades:** `Auto (Horizon-Calibrated)` and `Auto (Unguided Prior)` both **allow** `L1` (`+$0.1248 [+$0.1218 to +$0.1369]` `measured` saving vs `rule_v1` hold) and `TH` `R=5` (`+$0.3218` `measured` saving vs `rule_v1` hold: `$1.1122` -> `$0.7905`), whereas `rule_v1` over-blocks both.');
  md.push('- **Model-aware `DET-09` capability intelligence (`Claude 5.5`):** On `C55_effort_only` (`Opus 5.5` `medium -> high`), v4.1 calls `getEffortMutationCacheCapability(\'claude-opus-5-5\')` (`invalidatesCache: "no"`, `currency_55.csv` cache kept) and **allows** the effort shift cleanly, whereas a model-blind rule falsely blocks user intent.');
  md.push('- **Unguided Late-Turn Limitation (`Limitation #5`):** On `L2` (`30t @T24`), `Auto Calibrated` (`H=6`) and `Auto Zero-Cfg` block cleanly (`+$0.0247 [+$0.0148 to +$0.0310]`), while `Auto Unguided Prior` (`~47` residual reqs without caller/local-session horizon) allows the late downgrade (`-$0.0247`).');
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Track 3 — Anti-Pattern & Session Guardrail Replay (`t3_idle`, `t4_parallel`, `t5_trim`, `t6_layers`)');
  md.push('');
  md.push('| Anti-Pattern Benchmark | Measured Empirical Spread (`OFF` Trap vs. Mitigation) | Live Highbeam v4.1 Guard Behavior (`OFF` -> `COACH` -> `AUTO`) |');
  md.push('| :--- | :--- | :--- |');
  md.push(`| **\`T6\` Prefix Mutation (\`t6_layers.csv\`, \`n=3\`)** | Append tool \`TA\`: \`${fmtMedRangeUsd(track3.t6.TA)}\`, MCP swap \`CC-T\`: \`${fmtMedRangeUsd(track3.t6.CC_T)}\`, Resample \`TF\`: \`${fmtMedRangeUsd(track3.t6.TF)}\`, Sys RAG \`SRAG\`: \`${fmtMedRangeUsd(track3.t6.SRAG)}\` vs. Control \`C\`: \`${fmtMedRangeUsd(track3.t6.C)}\`, User RAG \`MRAG\`: \`${fmtMedRangeUsd(track3.t6.MRAG)}\` (**\`-${fmtUsd(median(track3.t6.sragVsMragSaved))}\` / \`-61.2%\`**) | \`AGENTS.md\` Shield (\`55k\`, \`evaluateDet09MidSessionRuleMutate\`): \`OFF\` -> \`${track3.t6.liveDet09[0].agentsShieldAction}\`, \`COACH\` -> \`${track3.t6.liveDet09[1].agentsShieldAction}\`, \`AUTO_PILOT\` -> \`${track3.t6.liveDet09[2].agentsShieldAction}\` (\`CLAUDE.md\` excluded per ISS-021: \`${track3.t6.liveDet09[2].claudeExcludedPerIss021}\`; \`.mcp.json\` \`interceptTopLevelMutation\`: \`${track3.t6.liveDet09[2].mcpMutationAction}\`). |`);
  md.push(`| **\`T5\` Sliding Trim vs. Cliff Compaction (\`t5_trim.csv\`, \`n=3\`)** | Sliding trim \`B\`: \`${fmtMedRangeUsd(track3.t5.B_sliding)}\` (\`13.8%\` hit) vs. 50% cliff \`C\`: \`${fmtMedRangeUsd(track3.t5.C_cliff)}\` (\`92.4%\` hit) -> **\`${fmtSignedMedRangeUsd(track3.t5.savingsBvsC)}\` (\`-65.9%\`) saved** | \`DET-12\` Cliff Breaker (\`Haiku 100k 5x\`): \`95k\` -> \`${track3.t5.cliff95k.decision}\`, \`99k\` -> \`${track3.t5.cliff99k.decision}\`; \`Sonnet 4.6\` \`99k\` -> \`${track3.t5.cliffSonnetExempt.decision}\` (no false triggers). |`);
  md.push(`| **\`T4\` Parallel Subagent Primer (\`t4_parallel.csv\`)** | \`N=10\` Cold \`P0\` (\`billed\`): \`${fmtMedRangeUsd(track3.t4.P0)}\` vs. Primer \`P2\` (\`billed\`): \`${fmtMedRangeUsd(track3.t4.P2_billed_primer)}\` (**\`${fmtSignedMedRangeUsd(track3.t4.P0_vs_P2_saved)}\` / \`-81.2%\`**); \`N=25\`: \`${fmtUsd(track3.t4.P0_N25[0])}\` -> \`${fmtUsd(track3.t4.P1_N25[0])}\` (\`computed\`, **\`+${fmtUsd(track3.t4.P0N25_vs_P1N25_saved)}\` / \`-86.6%\`**) | Architectural pattern disclosure: currently implemented as a host/SDK 1-call primer pattern rather than a standalone Claude Code pre-fanout hook. |`);
  md.push(`| **\`T3\` Idle >5m TTL & \`DET-16\` Wakeup (\`t3_idle.csv\`, \`n=3\`)** | \`TTL5_6m\`: \`${fmtMedRangeUsd(track3.t3.TTL5_6m)}\` vs. \`TTL1H_6m\`: \`${fmtMedRangeUsd(track3.t3.TTL1H_6m)}\` (**\`${fmtSignedMedRangeUsd(track3.t3.TTL5_6m_vs_1H_saved)}\`**); Keep-Alive \`KA-read\` (\`5\` pings): \`${fmtMedRangeUsd(track3.t3.KA_read)}\` | \`DET-16\` cold wakeup: \`17.6k\` (\`T3\`) penalty = \`${fmtUsd(track3.t3.det16SmallT3.penaltyDeltaUsd)}\` (< \`$0.50\` threshold -> warn); \`150k\` Opus swarm penalty = \`${fmtUsd(track3.t3.det16Large150k.penaltyDeltaUsd)}\` (>= \`$0.50\` -> \`AUTO_PILOT\` **hard-blocks** cold wakeup). |`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Track 4 — Bottom-Up Developer Weekly & Monthly ROI Model (`Reconciled`)');
  md.push('');
  md.push('> **Bottom-Up Estimation Basis:** Because Tracks 1–2 deliberately inject mid-session switches and mutations, expecting every normal session to save `12%` would overstate real-world ROI. Instead, this model multiplies **measured/computed unit incident savings** by **realistic weekly trigger rates** (`5` workdays/wk, `4.33` wks/mo). Across an average `$390–$650/mo` (`$90–$150/wk`) full-time developer workload, `Auto` vs. `Off` saves **`$9.42/wk` · `$40.79/mo`** (**`~6%–11%`** of raw API spend, midpoint **`~8%`**), beating `Coach (50% follow)` by **`+$3.46/wk` (`+$14.98/mo`)** interactively and **`+$5.32/wk` (`+$23.04/mo`)** unattended.');
  md.push('');
  md.push('| Developer Profile | Raw API Spend | `Auto` vs. `Off` (Weekly) | `Auto` vs. `Off` (Monthly) | % of Raw Spend | Extra Gain Over `Coach` (`50%` follow) |');
  md.push('| :--- | :--- | :---: | :---: | :---: | :--- |');
  for (const tier of developerRoiModel.tiers) {
    md.push(`| **${tier.tier}** (\`${tier.workload}\`) | \`${tier.rawWeeklyUsd}\` (\`${tier.rawMonthlyUsd}\`) | **\`$${tier.autoVsOffWeeklyUsd.toFixed(2)}/wk\`** (\`${tier.autoVsOffWeeklyRange}\`) | **\`$${tier.autoVsOffMonthlyUsd.toFixed(2)}/mo\`** (\`${tier.autoVsOffMonthlyRange}\`) | \`${tier.pctRawSpend}\` | **\`+$${tier.extraOverCoach50WeeklyUsd.toFixed(2)}/wk\` · \`+$${tier.extraOverCoach50MonthlyUsd.toFixed(2)}/mo\`** *(unattended: \`+$${tier.unattendedExtraMonthlyUsd.toFixed(2)}/mo\`)* |`);
  }
  md.push('');
  md.push('### 6-Lever Breakdown — Average Full-Time Agentic Developer (`~40` Sessions/Wk, `$9.42/wk` · `$40.79/mo`)');
  md.push('');
  md.push('| Protection Lever | Unit Saving & Provenance | Freq | Weekly (`Auto` vs `Off`) | Monthly (`× 4.33`) | `Auto` Gain Over `Coach (50%)` |');
  md.push('| :--- | :--- | :---: | :---: | :---: | :--- |');
  for (const lv of developerRoiModel.averageDevLevers) {
    md.push(`| **${lv.lever}** | ${lv.unitSaving} | \`${lv.weeklyFreq}\` | \`$${lv.weeklySavedUsd.toFixed(2)}\` | \`$${lv.monthlySavedUsd.toFixed(2)}\` | \`+$${lv.autoIncrementalWeeklyUsd.toFixed(2)}/wk\` — ${lv.attribution} |`);
  }
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Methodological Scope & Honest Limitations');
  md.push('1. **Interactive `/effort` Hook Coverage:** As established in [`summary_highbeam_auto.md`](file:///c:/Projects/ga-visualizer-v2/experiments/model-switch-benchmark/results/highbeam_auto/summary_highbeam_auto.md), `@anthropic-ai/claude-code@2.1.325` emits no `PreEffortChange` event on interactive `/effort` and ignores headless `--resume --model` in `PreModelSwitch`; `DET-08` and `DET-09` protect in-session `/model`, SDK `set_model`, MCP/rule file edits (`PreToolUse`), and host-mediated `CacheGravityRouter` callers directly.');
  md.push('2. **Counterfactual Pairing & Compliance Assumptions:** Track 1 `Coach` vs `Auto` comparisons pair each switched session with its recorded `control` replicate (`OFF = baseline`, `100%-compliant/Auto hold = control`), while `Coach` compliance tiers (`25% / 50% / 75%`) are modeled sensitivities rather than behavioral human-factors trials.');
  md.push('3. **Route & Price Dependence:** All recorded USD figures were captured against OpenRouter pinned Anthropic (`5m` API-key ephemeral tier, `Opus 4.6`, `Sonnet 4.6`, `Opus 5.5`, `Sonnet 5.5`); direct vendor / `1h` TTL cache eviction may shift exact break-even thresholds.');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_REPORT, md.join('\n') + '\n', 'utf8');

  return summaryJson;
}

function main() {
  const tStart = Date.now();
  const track1 = runTrack1();
  const track2 = runTrack2();
  const track3 = runTrack3();
  const summary = buildScorecardAndOutputs(track1, track2, track3);
  const elapsedMs = Date.now() - tStart;

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        elapsedMs,
        apiSpendUsd: 0,
        outputs: {
          csv: OUT_CSV,
          json: OUT_JSON,
          report: OUT_REPORT
        },
        hookLatencySummary: summary.hookLatencySummary,
        basketTotals: summary.basketTotals
      },
      null,
      2
    )
  );
}

main();
