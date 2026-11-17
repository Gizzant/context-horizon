// Regression tests for the multi-request model-switch fix (cost-per-task study, Claude Code 2.1.325).
// Evidence: experiments/model-switch-benchmark/results/highbeam_shadow_check.md,
// run_summary_cost_per_task.csv and run_summary_cost_per_task_hard.csv
// (SWITCH beat OPUS on 39 of 42 paired runs; the old single-request gate denied 40 of 42).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBreakEvenCachedTokens } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import {
  DEFAULT_OUTPUT_SHRINKAGE_PRIOR_TOKENS,
  DEFAULT_RPT_SHRINKAGE_PRIOR,
  MIN_TRUSTED_OUTPUT_TURNS,
  MIN_TRUSTED_RPT_TURNS,
  updateSessionCalibrationOnStop
} from '../../src/utils/sessionCalibration.mjs';
import {
  createInitialTelemetryState,
  writeLiveStateSnapshot
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';

const PAIR = { currentModel: 'claude-opus-5-5', targetModel: 'claude-sonnet-5-5', cacheWarm: true };

test('R = 1 with no intra-turn growth: hold matches the old cachedTokens > breakEvenTokens rule', () => {
  for (const cachedTokens of [2_000, 6_000, 6_902, 8_000, 20_000, 80_000]) {
    for (const expectedOutputTokens of [0, 500, 1_500, 4_000]) {
      const v = computeBreakEvenCachedTokens({ ...PAIR, cachedTokens, expectedOutputTokens, requestsPerTurn: 1 });
      const oldRule = v.coldWritePenaltyUSD > 0 && cachedTokens > v.breakEvenTokens;
      assert.equal(v.shouldHoldModel, oldRule, `C=${cachedTokens} O=${expectedOutputTokens}`);
    }
  }
});

test('measured T01 switch point (Turn-1 telemetry: R = 5, O = 4,717) is allowed', () => {
  const v = computeBreakEvenCachedTokens({
    ...PAIR, cachedTokens: 19_460, requestsPerTurn: 5, expectedOutputTokens: 4_717, contextGrowthPerTurn: 9_575
  });
  assert.equal(v.shouldHoldModel, false);
  assert.ok(v.coldWritePenaltyUSD < 0, `penalty ${v.coldWritePenaltyUSD}`);
});

test('measured H06 switch point (R = 5, O = 13,797, ~40.7k context) is allowed', () => {
  const v = computeBreakEvenCachedTokens({
    ...PAIR, cachedTokens: 40_668, requestsPerTurn: 5, expectedOutputTokens: 13_797, contextGrowthPerTurn: 29_260
  });
  assert.equal(v.shouldHoldModel, false);
});

test('intra-turn cache writes make a downshift cheaper, never more expensive', () => {
  const base = { ...PAIR, cachedTokens: 25_000, requestsPerTurn: 6, expectedOutputTokens: 1_500 };
  let prev = Infinity;
  for (const d of [0, 1_000, 3_000, 6_000]) {
    const v = computeBreakEvenCachedTokens({ ...base, intraTurnDeltaTokensPerRequest: d });
    assert.ok(v.coldWritePenaltyUSD <= prev, `delta ${d}: ${v.coldWritePenaltyUSD} > ${prev}`);
    prev = v.coldWritePenaltyUSD;
  }
});

test('single-request defaults (R = 1, O = 1,500) still hold at ~18k context: inputs, not the gate, decide', () => {
  const v = computeBreakEvenCachedTokens({ ...PAIR, cachedTokens: 18_334, requestsPerTurn: 1, expectedOutputTokens: 1_500 });
  assert.equal(v.shouldHoldModel, true);
});

test('same-model and upshift requests never hold', () => {
  const same = computeBreakEvenCachedTokens({ ...PAIR, targetModel: 'claude-opus-5-5', cachedTokens: 50_000, requestsPerTurn: 5 });
  const up = computeBreakEvenCachedTokens({ ...PAIR, currentModel: 'claude-sonnet-5-5', targetModel: 'claude-opus-5-5', cachedTokens: 50_000 });
  assert.equal(same.shouldHoldModel, false);
  assert.equal(up.shouldHoldModel, false);
});

test('shrinkage prior defaults remain unchanged (R prior = 2.0, O prior = 500, minTrustedTurns = 5)', () => {
  assert.equal(DEFAULT_RPT_SHRINKAGE_PRIOR, 2.0);
  assert.equal(DEFAULT_OUTPUT_SHRINKAGE_PRIOR_TOKENS, 500);
  assert.equal(MIN_TRUSTED_OUTPUT_TURNS, 5);
  assert.equal(MIN_TRUSTED_RPT_TURNS, 5);
});

test('PreModelSwitch passes observed within-turn growth (lastPrompt - firstPrompt) / (R - 1) from Stop calibration and liveState while keeping cross-turn growth capped at < 5 turns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'det08-intraturn-obs-'));
  try {
    // 1. Stop-hook calibration source (`stop_hook_last_turn_delta`)
    // Turn 1: R = 5 requests, firstPrompt = 8,758, lastPrompt = 18,334 -> (18,334 - 8,758) / 4 = 2,394
    const txPath = path.join(tmpDir, 't1.jsonl');
    const prompts = [8758, 11000, 13500, 16000, 18334];
    const txLines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Diagnose and plan' } }),
      ...prompts.map((p, idx) =>
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg_t1_${idx + 1}`,
            role: 'assistant',
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: idx === 0 ? p - 2 : p - prompts[idx - 1],
              cache_read_input_tokens: idx === 0 ? 0 : prompts[idx - 1] - 2,
              output_tokens: 200
            }
          }
        })
      )
    ];
    fs.writeFileSync(txPath, `${txLines.join('\n')}\n`, 'utf8');
    const cal = updateSessionCalibrationOnStop(
      { session_id: 'sess-intra-cal', transcript_path: txPath },
      { homeDir: tmpDir }
    );
    assert.equal(cal.lastTurnRequests, 5);
    assert.equal(cal.lastTurnFirstPromptTokens, 8758);
    assert.equal(cal.lastTurnLastPromptTokens, 18334);
    assert.equal(cal.intraTurnDeltaTokensPerRequest, 2394);

    const resCal = runPreModelSwitchHook(
      {
        session_id: 'sess-intra-cal',
        cwd: tmpDir,
        transcript_path: txPath,
        current_model: 'claude-opus-5-5',
        target_model: 'claude-sonnet-5-5',
        cached_tokens: 19460,
        cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true }
    );
    assert.equal(resCal.verdict.intraTurnDeltaTokensPerRequestUsed, 2394);
    assert.equal(resCal.verdict.intraTurnDeltaSource, 'stop_hook_last_turn_delta');
    assert.equal(resCal.verdict.contextGrowthPerTurnUsed, 0);
    assert.equal(resCal.verdict.promptGrowthEstimateSource, 'capped_early_session_no_extrapolation');

    // 2. liveState source (`live_state_last_turn_delta`) without Stop calibration
    const liveSid = 'sess-intra-live';
    const state = createInitialTelemetryState(liveSid, 'claude-opus-5-5');
    writeLiveStateSnapshot(
      liveSid,
      {
        ...state,
        flightMode: 'AUTO_PILOT',
        turnsCompleted: 1,
        steps: 5,
        lastTurnFirstPromptTokens: 10000,
        lastTurnLastPromptTokens: 22000,
        lastTurnRequests: 5,
        contextWindow: {
          ...state.contextWindow,
          cachedTokens: 23000,
          lastOutputTokens: 1000
        },
        promptCache: { warm: true, ttlTier: '5m', ttlSeconds: 280 }
      },
      { cwd: tmpDir }
    );
    const resLive = runPreModelSwitchHook(
      {
        session_id: liveSid,
        cwd: tmpDir,
        current_model: 'claude-opus-5-5',
        target_model: 'claude-sonnet-5-5',
        cached_tokens: 23000,
        cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      {
        cwd: tmpDir,
        homeDir: tmpDir,
        useSessionCalibration: false,
        recordLedger: false,
        bypassLicense: true
      }
    );
    assert.equal(resLive.verdict.intraTurnDeltaTokensPerRequestUsed, 3000);
    assert.equal(resLive.verdict.intraTurnDeltaSource, 'live_state_last_turn_delta');
    assert.equal(resLive.verdict.contextGrowthPerTurnUsed, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PreModelSwitch returns advisory ("based mostly on defaults" + penalty) when hold rests mainly on priors, and blocks in AUTO_PILOT only when both inputs are mostly observed (all source labels)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'det08-source-labels-'));
  try {
    const assertAdvisoryOnDefaults = (res, label) => {
      assert.equal(res.exitCode, 0, `${label}: exitCode`);
      assert.equal(res.verdict.decision, 'allow', `${label}: decision`);
      assert.equal(res.verdict.blocked, false, `${label}: blocked`);
      assert.equal(res.verdict.advisory, true, `${label}: advisory`);
      assert.equal(res.verdict.basedMostlyOnDefaults, true, `${label}: basedMostlyOnDefaults`);
      const pen = `+$${res.verdict.breakEven.coldWritePenaltyUSD.toFixed(4)}`;
      assert.ok(res.verdict.reason.includes(pen), `${label}: reason missing penalty ${pen}`);
      assert.match(res.verdict.reason, /based mostly on defaults/, `${label}: reason phrase`);
      const stdoutObj = JSON.parse(res.stdout);
      assert.equal(stdoutObj.hookSpecificOutput.permissionDecision, 'allow', `${label}: permissionDecision`);
      assert.match(stdoutObj.hookSpecificOutput.additionalContext, /based mostly on defaults/);
    };

    const assertAutoPilotBlock = (res, label) => {
      assert.equal(res.verdict.blocked, true, `${label}: expected blocked=true`);
      assert.equal(res.verdict.advisory, false, `${label}: expected advisory=false`);
      assert.equal(res.verdict.basedMostlyOnDefaults, false, `${label}: basedMostlyOnDefaults`);
      assert.ok(
        res.verdict.decision === 'deny' || res.verdict.decision === 'ask',
        `${label}: expected deny/ask, got ${res.verdict.decision}`
      );
    };

    const baseOpts = {
      cwd: tmpDir,
      homeDir: tmpDir,
      recordLedger: false,
      persistState: false,
      bypassLicense: true
    };
    const baseEv = {
      current_model: 'claude-opus-5-5',
      target_model: 'claude-sonnet-5-5',
      cached_tokens: 60_000,
      cache_warm: true,
      mode: 'AUTO_PILOT'
    };

    // --- 1. Fallback source labels: `default_1.0` and `default_1500` ---
    const resBothDefault = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-both-default' },
      { ...baseOpts, useSessionCalibration: false }
    );
    assert.equal(resBothDefault.verdict.rptEstimateSource, 'default_1.0');
    assert.equal(resBothDefault.verdict.outputEstimateSource, 'default_1500');
    assertAdvisoryOnDefaults(resBothDefault, 'default_1.0 + default_1500');

    // Explicit RPT (`explicit`) + fallback `default_1500` -> advisory
    const resExplicitRptDefaultOut = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-exp-rpt-def-out', requests_per_turn: 1 },
      { ...baseOpts, useSessionCalibration: false }
    );
    assert.equal(resExplicitRptDefaultOut.verdict.rptEstimateSource, 'explicit');
    assert.equal(resExplicitRptDefaultOut.verdict.outputEstimateSource, 'default_1500');
    assertAdvisoryOnDefaults(resExplicitRptDefaultOut, 'explicit RPT + default_1500');

    // Fallback `default_1.0` + explicit output (`explicit`) -> advisory
    const resDefaultRptExplicitOut = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-def-rpt-exp-out', expected_output_tokens: 200 },
      { ...baseOpts, useSessionCalibration: false }
    );
    assert.equal(resDefaultRptExplicitOut.verdict.rptEstimateSource, 'default_1.0');
    assert.equal(resDefaultRptExplicitOut.verdict.outputEstimateSource, 'explicit');
    assertAdvisoryOnDefaults(resDefaultRptExplicitOut, 'default_1.0 + explicit O');

    // Both `explicit` -> blocks in AUTO_PILOT
    const resBothExplicit = runPreModelSwitchHook(
      {
        ...baseEv,
        session_id: 'src-both-explicit',
        requests_per_turn: 1,
        expected_output_tokens: 200
      },
      { ...baseOpts, useSessionCalibration: false }
    );
    assert.equal(resBothExplicit.verdict.rptEstimateSource, 'explicit');
    assert.equal(resBothExplicit.verdict.outputEstimateSource, 'explicit');
    assertAutoPilotBlock(resBothExplicit, 'explicit + explicit');

    // --- 2. Output source labels via `liveState` ---
    // 2a. `live_state_shrunk_last` (w = 0.2 < 0.5) -> advisory even with explicit RPT
    const stLast = createInitialTelemetryState('src-live-last', 'claude-opus-5-5');
    stLast.turnsCompleted = 0;
    stLast.contextWindow.lastOutputTokens = 300;
    const resLiveLast = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-live-last', requests_per_turn: 1 },
      { ...baseOpts, telemetryState: stLast, useSessionCalibration: false }
    );
    assert.equal(resLiveLast.verdict.outputEstimateSource, 'live_state_shrunk_last');
    assert.equal(resLiveLast.verdict.shrinkageWeight, 0.2);
    assertAdvisoryOnDefaults(resLiveLast, 'live_state_shrunk_last');

    // 2b. `live_state_shrunk_mean` at w = 0.4 (< 0.5) -> advisory; at w = 0.6 (>= 0.5) -> blocks
    const stMeanEarly = createInitialTelemetryState('src-live-mean-2', 'claude-opus-5-5');
    stMeanEarly.turnsCompleted = 2;
    stMeanEarly.cumulative.outputTokens = 400;
    const resLiveMeanEarly = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-live-mean-2', requests_per_turn: 1 },
      { ...baseOpts, telemetryState: stMeanEarly, useSessionCalibration: false }
    );
    assert.equal(resLiveMeanEarly.verdict.outputEstimateSource, 'live_state_shrunk_mean');
    assert.equal(resLiveMeanEarly.verdict.shrinkageWeight, 0.4);
    assertAdvisoryOnDefaults(resLiveMeanEarly, 'live_state_shrunk_mean (w=0.4)');

    const stMeanMostly = createInitialTelemetryState('src-live-mean-3', 'claude-opus-5-5');
    stMeanMostly.turnsCompleted = 3;
    stMeanMostly.cumulative.outputTokens = 600;
    const resLiveMeanMostly = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-live-mean-3', requests_per_turn: 1 },
      { ...baseOpts, telemetryState: stMeanMostly, useSessionCalibration: false }
    );
    assert.equal(resLiveMeanMostly.verdict.outputEstimateSource, 'live_state_shrunk_mean');
    assert.equal(resLiveMeanMostly.verdict.shrinkageWeight, 0.6);
    assertAutoPilotBlock(resLiveMeanMostly, 'live_state_shrunk_mean (w=0.6)');

    // 2c. `live_state_mean` (turnsDone = 5, w = 1.0) -> blocks
    const stMeanFull = createInitialTelemetryState('src-live-mean-5', 'claude-opus-5-5');
    stMeanFull.turnsCompleted = 5;
    stMeanFull.cumulative.outputTokens = 1000;
    const resLiveMeanFull = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-live-mean-5', requests_per_turn: 1 },
      { ...baseOpts, telemetryState: stMeanFull, useSessionCalibration: false }
    );
    assert.equal(resLiveMeanFull.verdict.outputEstimateSource, 'live_state_mean');
    assert.equal(resLiveMeanFull.verdict.shrinkageWeight, 1);
    assertAutoPilotBlock(resLiveMeanFull, 'live_state_mean (w=1.0)');

    // 2d. `live_state_shrunk_median` (w = 0.2 < 0.5 -> advisory; w = 0.6 >= 0.5 -> blocks) & `live_state_rolling_median` (w = 1.0 -> blocks)
    const stMedEarly = createInitialTelemetryState('src-live-med-1', 'claude-opus-5-5');
    stMedEarly.turnsCompleted = 1;
    stMedEarly.rollingMedianOutputTokens = 200;
    const resLiveMedEarly = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-live-med-1', requests_per_turn: 1 },
      { ...baseOpts, telemetryState: stMedEarly, useSessionCalibration: false }
    );
    assert.equal(resLiveMedEarly.verdict.outputEstimateSource, 'live_state_shrunk_median');
    assert.equal(resLiveMedEarly.verdict.shrinkageWeight, 0.2);
    assertAdvisoryOnDefaults(resLiveMedEarly, 'live_state_shrunk_median (w=0.2)');

    const stMedFull = createInitialTelemetryState('src-live-med-5', 'claude-opus-5-5');
    stMedFull.turnsCompleted = 5;
    stMedFull.rollingMedianOutputTokens = 200;
    const resLiveMedFull = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-live-med-5', requests_per_turn: 1 },
      { ...baseOpts, telemetryState: stMedFull, useSessionCalibration: false }
    );
    assert.equal(resLiveMedFull.verdict.outputEstimateSource, 'live_state_rolling_median');
    assert.equal(resLiveMedFull.verdict.shrinkageWeight, 1);
    assertAutoPilotBlock(resLiveMedFull, 'live_state_rolling_median (w=1.0)');

    // --- 3. RPT & Output source labels via Stop calibration (`sessionCal`) and `local_transcript_rpt_prior` ---
    // 3a. `local_transcript_rpt_prior` (no sessionCal, historicalSessionRequestsPerTurn = 1.5 -> w = 0 < 0.5) -> advisory
    const resLocalPriorOnly = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-local-prior', expected_output_tokens: 200 },
      {
        ...baseOpts,
        useSessionCalibration: false,
        useLocalRptPrior: true,
        historicalSessionRequestsPerTurn: 1.5
      }
    );
    assert.equal(resLocalPriorOnly.verdict.rptEstimateSource, 'local_transcript_rpt_prior');
    assert.equal(resLocalPriorOnly.verdict.isPlaceholderRptPrior, false);
    assert.equal(resLocalPriorOnly.verdict.rptShrinkageWeight, 0);
    assertAdvisoryOnDefaults(resLocalPriorOnly, 'local_transcript_rpt_prior (w=0)');

    // Helper to write calibration JSON directly for specific turn counts / request counts
    const writeCal = (sid, data) => {
      const calDir = path.join(tmpDir, '.attention-horizon', 'cache', 'sessions');
      fs.mkdirSync(calDir, { recursive: true });
      fs.writeFileSync(path.join(calDir, `cal_${sid}.json`), JSON.stringify({ sessionId: sid, ...data }), 'utf8');
    };

    // 3b. `placeholder_rpt_prior_2` (`sessionCal` with 0 RPT samples) -> advisory
    writeCal('src-cal-0', {
      turnsCompleted: 0,
      apiCallsCompleted: 0,
      rptSampleSize: 0,
      recentTurnRequestCounts: [],
      rollingMedianRequestsPerTurn: null,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 5
    });
    const resPlaceholderPrior2 = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-0' },
      baseOpts
    );
    assert.equal(resPlaceholderPrior2.verdict.rptEstimateSource, 'placeholder_rpt_prior_2.0');
    assert.equal(resPlaceholderPrior2.verdict.outputEstimateSource, 'stop_hook_rolling_median');
    assertAdvisoryOnDefaults(resPlaceholderPrior2, 'placeholder_rpt_prior_2.0');

    // 3c. `stop_hook_shrunk_rpt_median` + `stop_hook_shrunk_median` at n = 1 (w = 0.2 < 0.5) -> advisory
    writeCal('src-cal-1', {
      turnsCompleted: 1,
      apiCallsCompleted: 2,
      rptSampleSize: 1,
      recentTurnRequestCounts: [2],
      rollingMedianRequestsPerTurn: 2,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 1
    });
    const resCal1 = runPreModelSwitchHook({ ...baseEv, session_id: 'src-cal-1' }, baseOpts);
    assert.equal(resCal1.verdict.rptEstimateSource, 'stop_hook_shrunk_rpt_median');
    assert.equal(resCal1.verdict.outputEstimateSource, 'stop_hook_shrunk_median');
    assertAdvisoryOnDefaults(resCal1, 'stop_hook_shrunk_rpt_median + stop_hook_shrunk_median (n=1)');

    // 3d. `stop_hook_shrunk_rpt_median` at n = 3 (w = 0.6 >= 0.5, disagreeing [1, 3, 1]):
    //     - Without local prior (`isPlaceholderRptPrior = true`) -> advisory
    //     - With local prior (`isPlaceholderRptPrior = false`) -> blocks!
    writeCal('src-cal-3-disagree', {
      turnsCompleted: 3,
      apiCallsCompleted: 5,
      rptSampleSize: 3,
      recentTurnRequestCounts: [1, 3, 1],
      rollingMedianRequestsPerTurn: 1,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 3
    });
    const resCal3Placeholder = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-3-disagree' },
      baseOpts
    );
    assert.equal(resCal3Placeholder.verdict.rptEstimateSource, 'stop_hook_shrunk_rpt_median');
    assert.equal(resCal3Placeholder.verdict.rptShrinkageWeight, 0.6);
    assert.equal(resCal3Placeholder.verdict.isPlaceholderRptPrior, true);
    assertAdvisoryOnDefaults(resCal3Placeholder, 'stop_hook_shrunk_rpt_median (w=0.6, placeholder prior)');

    const resCal3LocalPrior = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-3-disagree' },
      { ...baseOpts, useLocalRptPrior: true, historicalSessionRequestsPerTurn: 1.5 }
    );
    assert.equal(resCal3LocalPrior.verdict.rptEstimateSource, 'stop_hook_shrunk_rpt_median');
    assert.equal(resCal3LocalPrior.verdict.rptShrinkageWeight, 0.6);
    assert.equal(resCal3LocalPrior.verdict.isPlaceholderRptPrior, false);
    assert.equal(resCal3LocalPrior.verdict.outputEstimateSource, 'stop_hook_shrunk_median');
    assert.equal(resCal3LocalPrior.verdict.shrinkageWeight, 0.6);
    assertAutoPilotBlock(resCal3LocalPrior, 'stop_hook_shrunk_rpt_median (w=0.6, local prior) + stop_hook_shrunk_median (w=0.6)');

    // 3e. `stop_hook_agreed_shrunk_rpt_median` at n = 2 agreeing [1, 1] (w = 0.8 >= 0.5):
    //     - Without local prior (`isPlaceholderRptPrior = true`) -> advisory
    //     - With local prior (`isPlaceholderRptPrior = false`) and explicit O -> blocks!
    writeCal('src-cal-2-agree', {
      turnsCompleted: 2,
      apiCallsCompleted: 2,
      rptSampleSize: 2,
      recentTurnRequestCounts: [1, 1],
      rollingMedianRequestsPerTurn: 1,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 5
    });
    const resAgreePlaceholder = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-2-agree' },
      baseOpts
    );
    assert.equal(resAgreePlaceholder.verdict.rptEstimateSource, 'stop_hook_agreed_shrunk_rpt_median');
    assert.equal(resAgreePlaceholder.verdict.rptShrinkageWeight, 0.8);
    assert.equal(resAgreePlaceholder.verdict.isPlaceholderRptPrior, true);
    assertAdvisoryOnDefaults(resAgreePlaceholder, 'stop_hook_agreed_shrunk_rpt_median (placeholder prior)');

    const resAgreeLocal = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-2-agree' },
      { ...baseOpts, useLocalRptPrior: true, historicalSessionRequestsPerTurn: 1.2 }
    );
    assert.equal(resAgreeLocal.verdict.rptEstimateSource, 'stop_hook_agreed_shrunk_rpt_median');
    assert.equal(resAgreeLocal.verdict.isPlaceholderRptPrior, false);
    assertAutoPilotBlock(resAgreeLocal, 'stop_hook_agreed_shrunk_rpt_median (local prior)');

    // 3f. `stop_hook_trailing_regime_shrunk_rpt` ([1, 1, 1, 2, 2], step-up trailing regime, w = 0.8):
    //     - Placeholder prior -> advisory; local prior -> blocks
    writeCal('src-cal-trail-up', {
      turnsCompleted: 5,
      apiCallsCompleted: 7,
      rptSampleSize: 5,
      recentTurnRequestCounts: [1, 1, 1, 2, 2],
      rollingMedianRequestsPerTurn: 1,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 5
    });
    const resTrailUpPlaceholder = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-trail-up' },
      baseOpts
    );
    assert.equal(resTrailUpPlaceholder.verdict.rptEstimateSource, 'stop_hook_trailing_regime_shrunk_rpt');
    assert.equal(resTrailUpPlaceholder.verdict.isPlaceholderRptPrior, true);
    assertAdvisoryOnDefaults(resTrailUpPlaceholder, 'stop_hook_trailing_regime_shrunk_rpt (placeholder prior)');

    const resTrailUpLocal = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-trail-up' },
      { ...baseOpts, useLocalRptPrior: true, historicalSessionRequestsPerTurn: 1.5 }
    );
    assert.equal(resTrailUpLocal.verdict.rptEstimateSource, 'stop_hook_trailing_regime_shrunk_rpt');
    assert.equal(resTrailUpLocal.verdict.isPlaceholderRptPrior, false);
    assertAutoPilotBlock(resTrailUpLocal, 'stop_hook_trailing_regime_shrunk_rpt (local prior)');

    // 3g. `stop_hook_rolling_rpt_median` + `stop_hook_rolling_median` (n = 5, w = 1.0) -> blocks
    writeCal('src-cal-5-full', {
      turnsCompleted: 5,
      apiCallsCompleted: 5,
      rptSampleSize: 5,
      recentTurnRequestCounts: [1, 1, 1, 1, 1],
      rollingMedianRequestsPerTurn: 1,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 5
    });
    const resFull5 = runPreModelSwitchHook({ ...baseEv, session_id: 'src-cal-5-full' }, baseOpts);
    assert.equal(resFull5.verdict.rptEstimateSource, 'stop_hook_rolling_rpt_median');
    assert.equal(resFull5.verdict.outputEstimateSource, 'stop_hook_rolling_median');
    assert.equal(resFull5.verdict.isPlaceholderRptPrior, false);
    assertAutoPilotBlock(resFull5, 'stop_hook_rolling_rpt_median + stop_hook_rolling_median');

    // 3h. `stop_hook_trailing_regime_rpt` ([2, 2, 2, 1, 1], step-down trailing regime, w = 1.0) -> blocks
    writeCal('src-cal-trail-down', {
      turnsCompleted: 5,
      apiCallsCompleted: 8,
      rptSampleSize: 5,
      recentTurnRequestCounts: [2, 2, 2, 1, 1],
      rollingMedianRequestsPerTurn: 2,
      rollingMedianOutputTokens: 200,
      outputSampleSize: 5
    });
    const resTrailDown = runPreModelSwitchHook(
      { ...baseEv, session_id: 'src-cal-trail-down' },
      baseOpts
    );
    assert.equal(resTrailDown.verdict.rptEstimateSource, 'stop_hook_trailing_regime_rpt');
    assert.equal(resTrailDown.verdict.isPlaceholderRptPrior, false);
    assertAutoPilotBlock(resTrailDown, 'stop_hook_trailing_regime_rpt');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
