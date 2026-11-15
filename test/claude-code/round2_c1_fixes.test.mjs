import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runPreModelSwitchHook,
  loadLocalClaudeSessionApiCalls,
  loadLocalClaudeSessionPriors
} from '../../hooks/handlers/pre-model-switch.mjs';
import { runPostModelSwitchHook } from '../../hooks/handlers/post-model-switch.mjs';
import { runStopGateHook } from '../../hooks/handlers/stop-gate.mjs';
import { installAttentionHorizon } from '../../bin/ctxtop.mjs';
import {
  shrinkRollingOutputEstimate,
  shrinkRollingRequestsPerTurn,
  isRealHumanUserTranscriptEntry,
  DEFAULT_RPT_SHRINKAGE_PRIOR,
  OUTPUT_SHRINKAGE_PRIOR_METADATA,
  RPT_SHRINKAGE_PRIOR_METADATA
} from '../../src/utils/sessionCalibration.mjs';
import { readModelSwitchTelemetry } from '../../src/utils/modelSwitchTelemetry.mjs';
import {
  CacheGravityRouter,
  DEFAULT_FALLBACK_INITIAL_PREFIX_TOKENS,
  EMPIRICAL_SESSION_API_CALL_PRIOR,
  estimateEmpiricalRemainingTurns,
  computeBreakEvenCachedTokens,
  computeDet09BreakEvenTokens
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  createInitialTelemetryState,
  ingestModTurnEvent,
  ingestStatusLinePayload
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import {
  isKnownCatalogModel,
  normalizeModelId,
  resolveEffectiveRates
} from '../../src/core-isomorphic/config/catalogLoader.mjs';
import { inspectClaudeBinaryCapabilities } from '../../src/diagnostics/claudeHookCapabilities.mjs';
import { runCompactLifecycleHook } from '../../hooks/handlers/compact-lifecycle.mjs';
import { runDoctorDiagnostics } from '../../src/diagnostics/doctorEngine.mjs';

test('C1a & Ask Default: native PreModelSwitch records exact coldWritePenaltyUSD, defaults to ask in AUTO_PILOT, and includes cost + payback turns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1a-ledger-'));
  const ledgerPath = path.join(tmpDir, 'horizon_ledger.jsonl');
  try {
    const res = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'sess-c1a',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 14840,
        uncached_delta_tokens: 350,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        mode: 'AUTO_PILOT'
      },
      {
        cwd: tmpDir,
        ledgerPath,
        bypassLicense: true
      }
    );

    assert.equal(res.exitCode, 0);
    assert.equal(res.verdict.decision, 'ask');
    assert.equal(res.verdict.blocked, true);
    assert.equal(res.verdict.breakEven.coldWritePenaltyUSD, 0.032355);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreModelSwitch');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /\+\$0\.0324/);
    assert.match(
      parsed.hookSpecificOutput.permissionDecisionReason,
      /payback ~\d+\.\d+ post-switch warm requests \(~\d+\.\d+ turns\)/
    );
    assert.match(
      parsed.hookSpecificOutput.permissionDecisionReason,
      /"DET-08": "warn".*expectedRemainingTurns/
    );

    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.category, 'DET_08_MODEL_SWITCH_HOLD');
    assert.equal(entry.savedTokens, 14840);
    assert.equal(entry.savedUSD, 0.032355);

    // Explicit autoPilotDecision='deny' still exits 2 on stderr
    const resDeny = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'sess-c1a-deny',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 14840,
        uncached_delta_tokens: 350,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        mode: 'AUTO_PILOT'
      },
      {
        cwd: tmpDir,
        recordLedger: false,
        autoPilotDecision: 'deny',
        bypassLicense: true
      }
    );
    assert.equal(resDeny.exitCode, 2);
    assert.equal(resDeny.verdict.decision, 'deny');
    assert.match(resDeny.stderr, /payback ~\d+\.\d+ post-switch warm requests \(~\d+\.\d+ turns\)/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C1b: runPreModelSwitchHook treats expired promptCache.expiresAt as cold even when warm=true', () => {
  const baseNow = 1_700_000_000_000;
  const staleState = createInitialTelemetryState('sess-c1b', 'claude-opus-4-6');
  staleState.flightMode = 'AUTO_PILOT';
  staleState.contextWindow.cachedTokens = 25000;
  staleState.promptCache.warm = true;
  staleState.promptCache.ttlTier = '5m';
  staleState.promptCache.ttlSeconds = 300;
  staleState.promptCache.expiresAt = baseNow - 120_000;

  const resExpired = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'sess-c1b',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6'
    },
    {
      telemetryState: staleState,
      nowMs: baseNow,
      recordLedger: false,
      bypassLicense: true
    }
  );

  assert.equal(resExpired.exitCode, 0);
  assert.equal(resExpired.verdict.blocked, false);
  assert.equal(resExpired.verdict.decision, 'allow');
  assert.equal(resExpired.verdict.breakEven.cacheWarm, false);

  const resWarm = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'sess-c1b',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6'
    },
    {
      telemetryState: staleState,
      nowMs: baseNow - 180_000,
      recordLedger: false,
      bypassLicense: true
    }
  );
  assert.equal(resWarm.exitCode, 0);
  assert.equal(resWarm.verdict.blocked, true);
  assert.equal(resWarm.verdict.decision, 'ask');
});

test('C1c: ingestModTurnEvent and ingestStatusLinePayload promote ttlTier to 1h when ephemeral_1h_input_tokens > 0', () => {
  const nowMs = 1_700_000_000_000;
  const state0 = createInitialTelemetryState('sess-c1c', 'claude-opus-4-6');
  assert.equal(state0.promptCache.ttlTier, '5m');

  const state1 = ingestModTurnEvent(
    state0,
    {
      type: 'turn.complete',
      turnId: 't1',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 12000,
        cache_read_input_tokens: 0,
        output_tokens: 200,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 12000
        }
      }
    },
    { nowMs }
  );

  assert.equal(state1.promptCache.ttlTier, '1h');
  assert.equal(state1.promptCache.ttlSeconds, 3600);
  assert.equal(state1.promptCache.expiresAt, nowMs + 3_600_000);

  const stateSl0 = createInitialTelemetryState('sess-c1c-sl', 'claude-opus-4-6');
  const stateSl1 = ingestStatusLinePayload(
    stateSl0,
    {
      session_id: 'sess-c1c-sl',
      model: { id: 'claude-opus-4-6' },
      context_window: {
        current_usage: {
          input_tokens: 50,
          cache_creation_input_tokens: 9000,
          cache_creation: { ephemeral_1h_input_tokens: 9000, ephemeral_5m_input_tokens: 0 },
          output_tokens: 100
        }
      }
    },
    { nowMs }
  );
  assert.equal(stateSl1.promptCache.ttlTier, '1h');
  assert.equal(stateSl1.promptCache.ttlSeconds, 3600);
  assert.equal(stateSl1.promptCache.expiresAt, nowMs + 3_600_000);
});

test('C1d: DET-09 preserves unconditional defer by default and enforces C*_mut behind enableDet09Threshold', () => {
  const routerDefault = new CacheGravityRouter({ mode: 'AUTO_PILOT' });
  const rDefault = routerDefault.interceptTopLevelMutation({
    type: 'effort',
    value: 'high',
    currentModel: 'claude-opus-4-6',
    cachedTokens: 2000,
    cacheWarm: true
  });
  assert.equal(rDefault.decision, 'defer');
  assert.equal(rDefault.queued, true);

  const cStar = computeDet09BreakEvenTokens({
    currentModel: 'claude-opus-4-6',
    cacheTtlTier: '5m'
  });
  assert.equal(cStar.breakEvenTokens, 3478);

  const routerFlag = new CacheGravityRouter({ mode: 'AUTO_PILOT', enableDet09Threshold: true });
  const rBelow = routerFlag.interceptTopLevelMutation({
    type: 'effort',
    value: 'high',
    currentModel: 'claude-opus-4-6',
    cachedTokens: 3000,
    cacheWarm: true
  });
  assert.equal(rBelow.decision, 'allow');
  assert.equal(rBelow.queued, false);
  assert.equal(rBelow.belowBreakEvenThreshold, true);
  assert.equal(rBelow.breakEvenTokens, 3478);

  const rAbove = routerFlag.interceptTopLevelMutation({
    type: 'effort',
    value: 'high',
    currentModel: 'claude-opus-4-6',
    cachedTokens: 14840,
    cacheWarm: true
  });
  assert.equal(rAbove.decision, 'defer');
  assert.equal(rAbove.queued, true);
});

test('Offline S1 boundary: Opus 4.6 -> Sonnet 4.6 C* = 4,615 (delta=0) and 4,885 (delta=350) threshold precision', () => {
  for (const [tokens, delta, expectedCStar, expectHold] of [
    [3450, 0, 4615, false],
    [4615, 0, 4615, false],
    [4616, 0, 4615, true],
    [3450, 350, 4885, false],
    [4885, 350, 4885, false],
    [4886, 350, 4885, true],
    [5550, 350, 4885, true]
  ]) {
    const res = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: `sess-s1-${tokens}-${delta}`,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: tokens,
        uncached_delta_tokens: delta,
        prompt_cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      { recordLedger: false, bypassLicense: true, minSwitchPenaltyUSD: 0 }
    );
    assert.equal(res.verdict.breakEven.breakEvenTokens, expectedCStar);
    assert.equal(res.verdict.blocked, expectHold, `tokens=${tokens}, delta=${delta}`);
    assert.equal(res.verdict.decision, expectHold ? 'ask' : 'allow');
  }
});

test('C1e & Empirical Horizon Prior: rule_v1 default preserved, explicit expectedRemainingTurns and 496-session prior supported', () => {
  const v1 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 9500,
    uncachedDeltaTokens: 350,
    expectedOutputTokens: 220,
    cacheWarm: true
  });
  assert.equal(v1.ruleVersion, 'rule_v1');
  assert.equal(v1.shouldHoldModel, true);

  const v2L1 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 9500,
    uncachedDeltaTokens: 350,
    expectedOutputTokens: 220,
    expectedRemainingTurns: 27,
    cacheWarm: true
  });
  assert.equal(v2L1.ruleVersion, 'rule_v2');
  assert.equal(v2L1.shouldHoldModel, false);
  assert.ok(v2L1.horizonNetSavingsUSD > 0);

  const v2L2 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 16500,
    uncachedDeltaTokens: 350,
    expectedOutputTokens: 220,
    expectedRemainingTurns: 6,
    cacheWarm: true
  });
  assert.equal(v2L2.ruleVersion, 'rule_v2');
  assert.equal(v2L2.shouldHoldModel, true);
  assert.ok(v2L2.horizonNetSavingsUSD < 0);

  assert.equal(EMPIRICAL_SESSION_API_CALL_PRIOR.sampleCount, 496);
  assert.equal(EMPIRICAL_SESSION_API_CALL_PRIOR.isPlaceholderPrior, true);
  assert.equal(EMPIRICAL_SESSION_API_CALL_PRIOR.unit, 'api_requests');
  const priorT3 = estimateEmpiricalRemainingTurns({ turnsCompleted: 3, cachedTokens: 14000 });
  assert.equal(priorT3.expectedRemainingTurns, 59);
  assert.equal(priorT3.source, 'placeholder_antigravity_496_prior');
  assert.equal(priorT3.horizonUnit, 'turns');
  assert.equal(priorT3.priorNativeUnit, 'api_requests');

  const priorT24 = estimateEmpiricalRemainingTurns({ turnsCompleted: 24, cachedTokens: 20700 });
  assert.equal(priorT24.expectedRemainingTurns, 47);

  const priorNearCompact = estimateEmpiricalRemainingTurns({
    turnsCompleted: 24,
    cachedTokens: 158000,
    contextCeiling: 200000
  });
  assert.ok(priorNearCompact.expectedRemainingTurns <= 5);
});

test('C1g: unrecognized non-Anthropic model slugs pass through with a warning instead of defaulting to claude-sonnet-5-5', () => {
  assert.equal(isKnownCatalogModel('google/gemini-2.5-pro'), false);
  assert.equal(isKnownCatalogModel('gemini-2.5-flash'), false);
  assert.equal(isKnownCatalogModel('openai/gpt-5'), false);
  assert.equal(isKnownCatalogModel('anthropic/claude-opus-4.6'), true);
  assert.equal(isKnownCatalogModel('claude-sonnet-4-6[1m]'), true);
  // normalizeModelId preserves backwards-compatible fallback for explicit legacy callers
  assert.equal(normalizeModelId('google/gemini-2.5-pro'), 'claude-sonnet-5-5');
  const rates = resolveEffectiveRates('google/gemini-2.5-pro', 20000);
  assert.equal(rates.modelId, 'claude-sonnet-5-5');

  for (const [fromModel, toModel] of [
    ['google/gemini-2.5-pro', 'claude-sonnet-4-6'],
    ['claude-opus-4-6', 'google/gemini-2.5-pro'],
    ['google/gemini-2.5-pro', 'google/gemini-2.5-flash'],
    ['openai/gpt-5', 'claude-haiku-4-5']
  ]) {
    const res = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        from_model: fromModel,
        to_model: toModel,
        context_tokens: 50000,
        prompt_cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      { recordLedger: false, bypassLicense: true }
    );
    assert.equal(res.exitCode, 0);
    assert.equal(res.verdict.decision, 'allow');
    assert.equal(res.verdict.blocked, false);
    assert.equal(res.verdict.unknownModel, true);
    assert.match(res.verdict.warning, /Unrecognized non-Anthropic model/);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(parsed.hookSpecificOutput.additionalContext, /Unrecognized non-Anthropic model/);
  }

  const router = new CacheGravityRouter({ mode: 'AUTO_PILOT' });
  const det09 = router.interceptTopLevelMutation({
    type: 'effort',
    value: 'high',
    currentModel: 'google/gemini-2.5-pro',
    cachedTokens: 30000,
    cacheWarm: true
  });
  assert.equal(det09.decision, 'allow');
  assert.equal(det09.queued, false);
  assert.equal(det09.unknownModel, true);
  assert.match(det09.warning, /Unrecognized non-Anthropic model/);
});

test('Startup feature-check: inspectClaudeBinaryCapabilities detects valid vs missing PreModelSwitch contracts and warns on SessionStart', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cap-check-'));
  try {
    const validBin = path.join(tmpDir, 'claude-valid.js');
    fs.writeFileSync(
      validBin,
      'const Ec=["PreModelSwitch","PostModelSwitch"]; const h={from_model:1,to_model:1,prompt_cache_warm:1,context_tokens:1}; if(y.permissionBehavior==="ask"||msg==="blocked_by_hook"){}',
      'utf8'
    );
    const validCap = inspectClaudeBinaryCapabilities({
      cwd: tmpDir,
      claudeBinPath: validBin,
      claudeVersion: '2.1.325',
      bypassCache: true
    });
    assert.equal(validCap.found, true);
    assert.equal(validCap.preModelSwitchSupported, true);
    assert.equal(validCap.preEffortChangeSupported, false);
    assert.equal(validCap.supportsAskDecision, true);
    assert.equal(validCap.contractValid, true);
    assert.equal(validCap.warning, null);

    // Second call hits disk cache
    const cachedCap = inspectClaudeBinaryCapabilities({
      cwd: tmpDir,
      claudeBinPath: validBin
    });
    assert.equal(cachedCap.cached, true);
    assert.equal(cachedCap.contractValid, true);

    // Broken contract missing PreModelSwitch emits warning + runtime diagnostic + SessionStart context
    const missingBin = path.join(tmpDir, 'claude-missing.js');
    fs.writeFileSync(missingBin, 'const Ec=["PreToolUse","PostToolUse"];', 'utf8');
    const missingCap = inspectClaudeBinaryCapabilities({
      cwd: tmpDir,
      claudeBinPath: missingBin,
      claudeVersion: '2.2.0',
      bypassCache: true
    });
    assert.equal(missingCap.found, true);
    assert.equal(missingCap.preModelSwitchSupported, false);
    assert.equal(missingCap.contractValid, false);
    assert.match(missingCap.warning, /PreModelSwitch hook contract/);

    const sessionRes = runCompactLifecycleHook(
      { hook_event_name: 'SessionStart', cwd: tmpDir },
      { claudeBinPath: missingBin, claudeVersion: '2.2.0', bypassCache: true }
    );
    assert.equal(sessionRes.exitCode, 0);
    assert.equal(sessionRes.result.claudeCapabilities.contractValid, false);
    assert.match(sessionRes.stdout, /PreModelSwitch hook contract/);

    const doc = runDoctorDiagnostics({
      cwd: tmpDir,
      claudeBinPath: validBin,
      claudeVersion: '2.1.325',
      bypassCache: true
    });
    assert.equal(doc.checks.length, 7);
    assert.equal(doc.claudeCapabilities.contractValid, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Stop-hook calibration feeds turnsCompleted and rolling median output into PreModelSwitch router without writing .claude/cache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-cal-pre-switch-'));
  try {
    const txPath = path.join(tmpDir, 'cal_test_23.jsonl');
    const lines = [];
    for (let t = 1; t <= 23; t += 1) {
      lines.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: `Turn ${t} synthetic prompt` }
        })
      );
      const usageBase =
        t === 1
          ? { input_tokens: 3, cache_creation_input_tokens: 10197, cache_read_input_tokens: 0 }
          : { input_tokens: 3, cache_creation_input_tokens: 300, cache_read_input_tokens: 10197 };
      for (const outTok of [1, 80, 151]) {
        lines.push(
          JSON.stringify({
            type: 'assistant',
            message: {
              id: `msg_cal_turn_${t}`,
              role: 'assistant',
              usage: { ...usageBase, output_tokens: outTok }
            }
          })
        );
      }
    }
    fs.writeFileSync(txPath, `${lines.join('\n')}\n`, 'utf8');

    const stopRes = runStopGateHook(
      { session_id: 'cal_test_23', transcript_path: txPath, cwd: tmpDir },
      { cwd: tmpDir, homeDir: tmpDir, persistState: false }
    );
    assert.ok(stopRes.sessionCalibration);
    assert.equal(stopRes.sessionCalibration.turnsCompleted, 23);
    assert.equal(stopRes.sessionCalibration.apiCallsCompleted, 23);
    assert.equal(stopRes.sessionCalibration.rollingMedianOutputTokens, 151);
    assert.equal(stopRes.sessionCalibration.initialPrefixTokens, 10200);

    const calFile = path.join(tmpDir, '.attention-horizon', 'cache', 'sessions', 'cal_cal_test_23.json');
    assert.equal(fs.existsSync(calFile), true);
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'cache')), false);

    const commonEvent = {
      hook_event_name: 'PreModelSwitch',
      session_id: 'cal_test_23',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6',
      context_tokens: 19131,
      prompt_cache_warm: true,
      mode: 'AUTO_PILOT'
    };
    const commonOpts = { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true };

    const askRes = runPreModelSwitchHook({ ...commonEvent, expected_remaining_turns: 6 }, commonOpts);
    assert.equal(askRes.verdict.turnsCompletedUsed, 23);
    assert.equal(askRes.verdict.breakEven.expectedOutputTokens, 151);
    assert.equal(askRes.verdict.outputEstimateSource, 'stop_hook_rolling_median');
    assert.ok(askRes.verdict.breakEven.paybackTurns > 10);
    assert.equal(askRes.verdict.decision, 'ask');

    const allowRes = runPreModelSwitchHook({ ...commonEvent, expected_remaining_turns: 12 }, commonOpts);
    assert.equal(allowRes.verdict.decision, 'allow');

    const unguidedRes = runPreModelSwitchHook(
      { ...commonEvent, use_empirical_horizon_prior: true },
      commonOpts
    );
    assert.equal(unguidedRes.verdict.turnsCompletedUsed, 23);
    assert.equal(unguidedRes.verdict.breakEven.expectedRemainingTurns, 47);
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'cache')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadLocalClaudeSessionApiCalls deduplicates by message.id and caches under home .attention-horizon/cache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-prior-dedup-'));
  try {
    const projDir = path.join(tmpDir, '.claude', 'projects', 'projA');
    fs.mkdirSync(projDir, { recursive: true });
    for (let f = 1; f <= 5; f += 1) {
      const lines = [];
      for (let m = 1; m <= 4; m += 1) {
        lines.push(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: `Prompt ${f}-${m} ` + 'x'.repeat(80) }
          })
        );
        for (const outTok of [1, 45, 90]) {
          lines.push(
            JSON.stringify({
              type: 'assistant',
              message: {
                id: `msg_p${f}_${m}`,
                role: 'assistant',
                usage: { input_tokens: 100, output_tokens: outTok }
              }
            })
          );
        }
      }
      const fp = path.join(projDir, `sess_${f}.jsonl`);
      fs.writeFileSync(fp, `${lines.join('\n')}\n`, 'utf8');
      assert.ok(fs.statSync(fp).size >= 512);
    }

    const counts = loadLocalClaudeSessionApiCalls({ homeDir: tmpDir, cwd: tmpDir });
    assert.deepEqual(counts, [4, 4, 4, 4, 4]);
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.attention-horizon', 'cache', 'ah_session_prior.json')),
      true
    );
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'cache')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5-turn shrinkage blends early rolling output medians toward 500 prior and releases at >= 5 turns', () => {
  const early = shrinkRollingOutputEstimate(200, 2);
  assert.equal(early.sampleSize, 2);
  assert.equal(early.shrinkageWeight, 0.4);
  assert.equal(early.expectedOutputTokens, 380);
  assert.equal(early.source, 'stop_hook_shrunk_median');

  const mature = shrinkRollingOutputEstimate(200, 5);
  assert.equal(mature.sampleSize, 5);
  assert.equal(mature.shrinkageWeight, 1);
  assert.equal(mature.expectedOutputTokens, 200);
  assert.equal(mature.source, 'stop_hook_rolling_median');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-cal-'));
  try {
    const txPath = path.join(tmpDir, 'sess_2turns.jsonl');
    const lines = [];
    for (let t = 1; t <= 2; t += 1) {
      lines.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: `Prompt ${t} ` + 'x'.repeat(60) }
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg_shrink_${t}`,
            role: 'assistant',
            usage: {
              input_tokens: 3,
              cache_creation_input_tokens: t === 1 ? 10200 : 300,
              cache_read_input_tokens: t === 1 ? 0 : 10200,
              output_tokens: 200
            }
          }
        })
      );
    }
    fs.writeFileSync(txPath, `${lines.join('\n')}\n`, 'utf8');

    const stopRes = runStopGateHook(
      { session_id: 'cal_shrink_2', transcript_path: txPath, cwd: tmpDir },
      { cwd: tmpDir, homeDir: tmpDir, persistState: false }
    );
    assert.equal(stopRes.sessionCalibration.outputSampleSize, 2);
    assert.equal(stopRes.sessionCalibration.requestsPerTurn, 1);

    const hookRes = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'cal_shrink_2',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 11970,
        prompt_cache_warm: true,
        mode: 'AUTO_PILOT',
        expected_remaining_turns: 25
      },
      { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true }
    );
    assert.equal(hookRes.verdict.outputSampleSize, 2);
    assert.equal(hookRes.verdict.shrinkageWeight, 0.4);
    assert.equal(hookRes.verdict.rawRollingMedianOutputTokens, 200);
    assert.equal(hookRes.verdict.breakEven.expectedOutputTokens, 380);
    assert.equal(hookRes.verdict.outputEstimateSource, 'stop_hook_shrunk_median');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('minSwitchPenaltyUSD suppresses tiny holds silently and notable allow emits one-line cost + payback note', () => {
  const belowRes = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'min-penalty-below',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6',
      context_tokens: 6000,
      uncached_delta_tokens: 0,
      prompt_cache_warm: true,
      mode: 'AUTO_PILOT'
    },
    { recordLedger: false, bypassLicense: true }
  );
  assert.ok(belowRes.verdict.breakEven.coldWritePenaltyUSD < 0.02);
  assert.equal(belowRes.verdict.belowMinSwitchPenaltyUSD, true);
  assert.equal(belowRes.verdict.decision, 'allow');
  assert.equal(belowRes.verdict.blocked, false);
  assert.equal(belowRes.stdout, '');

  const notableRes = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'notable-allow-note',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6',
      context_tokens: 15000,
      uncached_delta_tokens: 0,
      prompt_cache_warm: true,
      mode: 'AUTO_PILOT',
      expected_remaining_turns: 25
    },
    { recordLedger: false, bypassLicense: true }
  );
  assert.equal(notableRes.verdict.decision, 'allow');
  assert.equal(notableRes.verdict.blocked, false);
  assert.ok(notableRes.verdict.breakEven.coldWritePenaltyUSD >= 0.02);
  assert.match(notableRes.verdict.notableAllowNote, /Allowing claude-opus-4-6 -> claude-sonnet-4-6/);
  assert.match(
    notableRes.verdict.notableAllowNote,
    /pays back in ~\d+\.\d+ post-switch warm requests \(~\d+\.\d+ turns\)/
  );

  const parsedOut = JSON.parse(notableRes.stdout);
  assert.equal(parsedOut.systemMessage, notableRes.verdict.notableAllowNote);
  assert.equal(parsedOut.hookSpecificOutput.hookEventName, 'PreModelSwitch');
  assert.equal(parsedOut.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(parsedOut.hookSpecificOutput.permissionDecisionReason, notableRes.verdict.notableAllowNote);
});

test('api_requests prior converts to turns via requestsPerTurn and dynamic ceiling/prefix replace hardcoded constants', () => {
  assert.equal(DEFAULT_FALLBACK_INITIAL_PREFIX_TOKENS, 9000);

  const multiCallPrior = estimateEmpiricalRemainingTurns({
    turnsCompleted: 4,
    apiCallsCompleted: 12,
    cachedTokens: 15000
  });
  assert.equal(multiCallPrior.requestsPerTurn, 3);
  assert.equal(multiCallPrior.priorBucket, '7-12_requests');
  assert.equal(multiCallPrior.expectedRemainingRequests, 54);
  assert.equal(multiCallPrior.expectedRemainingTurns, 18);
  assert.equal(multiCallPrior.horizonUnit, 'turns');
  assert.equal(multiCallPrior.priorNativeUnit, 'api_requests');

  const turn0Prefix = estimateEmpiricalRemainingTurns({
    turnsCompleted: 0,
    cachedTokens: 12500
  });
  assert.equal(turn0Prefix.initialPrefixTokensUsed, 12500);

  const dynamicCeilingRes = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'dyn-ceiling-1m',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6',
      context_tokens: 25000,
      context_window: { context_window_size: 1_000_000 },
      prompt_cache_warm: true,
      mode: 'AUTO_PILOT',
      use_empirical_horizon_prior: true
    },
    { recordLedger: false, bypassLicense: true }
  );
  assert.equal(dynamicCeilingRes.verdict.breakEven.contextCeilingUsed, 1_000_000);
});

test('Item 2: DET-08 uses horizon-aware C_max (always allows when cMaxDen <= 0) instead of single-turn C*', () => {
  // Exact formula check at H = 6 (explicit post-switch turns), O = 400, R = 1, 5m Opus 4.6 -> Sonnet 4.6:
  //   C_max = 400 * 10 * (6 + 1) / ((3.75 - 0.50) - 6 * (0.50 - 0.30)) = 28000 / 2.05 = 13659
  const holdCase = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 18_927,
    uncachedDeltaTokens: 0,
    expectedOutputTokens: 400,
    cacheWarm: true,
    cacheTtlTier: '5m',
    expectedRemainingTurns: 6,
    requestsPerTurn: 1
  });
  assert.equal(holdCase.horizonMaxCachedTokens, 13_659);
  assert.equal(holdCase.shouldHold, true);

  const holdHook = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'sess-cmax-hold',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6',
      context_tokens: 18_927,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      expected_output_tokens: 400,
      expected_remaining_turns: 6,
      requests_per_turn: 1,
      mode: 'AUTO_PILOT'
    },
    { recordLedger: false, bypassLicense: true, useSessionCalibration: false }
  );
  assert.equal(holdHook.verdict.decision, 'ask');
  assert.ok(holdHook.verdict.reason.includes('C_max = 13,659 tokens'));
  assert.ok(!holdHook.verdict.reason.includes('C*'));

  // Denominator <= 0 case: H = 17, R = 1 => (3.75 - 0.50) - 17 * 0.20 = -0.15 <= 0 => C_max = Infinity (always allow)
  const allowDenLeZero = runPreModelSwitchHook(
    {
      hook_event_name: 'PreModelSwitch',
      session_id: 'sess-cmax-inf',
      from_model: 'claude-opus-4-6',
      to_model: 'claude-sonnet-4-6',
      context_tokens: 120_000,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      expected_output_tokens: 150,
      expected_remaining_turns: 17,
      requests_per_turn: 1,
      mode: 'AUTO_PILOT'
    },
    { recordLedger: false, bypassLicense: true, useSessionCalibration: false }
  );
  assert.equal(allowDenLeZero.verdict.breakEven.horizonMaxCachedTokens, Infinity);
  assert.equal(allowDenLeZero.verdict.decision, 'allow');
  assert.ok(allowDenLeZero.verdict.notableAllowNote.includes('C_max = unbounded'));
});

test('Item 3: requestsPerTurn scales warm cache read terms (payback drops 11.32 -> 2.19 -> 0.66 turns at C=50k, O=400, 5m)', () => {
  const base = {
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 50_000,
    uncachedDeltaTokens: 0,
    expectedOutputTokens: 400,
    cacheWarm: true,
    cacheTtlTier: '5m'
  };

  const r1 = computeBreakEvenCachedTokens({ ...base, requestsPerTurn: 1 });
  assert.equal(r1.coldWritePenaltyUSD, 0.1585);
  assert.equal(r1.perTurnPostSwitchSavingUSD, 0.014);
  assert.equal(r1.paybackTurns, 11.3214);

  const r5 = computeBreakEvenCachedTokens({ ...base, requestsPerTurn: 5 });
  assert.equal(r5.coldWritePenaltyUSD, 0.1185);
  assert.equal(r5.perTurnPostSwitchSavingUSD, 0.054);
  assert.equal(r5.paybackTurns, 2.1944);

  const r10 = computeBreakEvenCachedTokens({ ...base, requestsPerTurn: 10 });
  assert.equal(r10.coldWritePenaltyUSD, 0.0685);
  assert.equal(r10.perTurnPostSwitchSavingUSD, 0.104);
  assert.equal(r10.paybackTurns, 0.6587);
});

test('Item 4: placeholder shrinkage metadata and H vs H-1 postSwitchRemainingTurns semantics', () => {
  assert.equal(OUTPUT_SHRINKAGE_PRIOR_METADATA.isPlaceholderPrior, true);
  assert.match(OUTPUT_SHRINKAGE_PRIOR_METADATA.provenance, /placeholder/);
  assert.equal(OUTPUT_SHRINKAGE_PRIOR_METADATA.effectivePseudoCountExampleAtN2, 3);

  const shrunk = shrinkRollingOutputEstimate(200, 2);
  assert.equal(shrunk.isPlaceholderShrinkagePrior, true);
  assert.equal(shrunk.effectiveSmoothingK, 3);
  assert.equal(shrunk.expectedOutputTokens, 380);

  // Empirical 4-6_requests bucket value = 57; at rpt = 2 -> 28.5 total turns before switch turn, 27.5 post-switch turns
  const prior = estimateEmpiricalRemainingTurns({
    turnsCompleted: 2,
    apiCallsCompleted: 4,
    requestsPerTurn: 2,
    cachedTokens: 12_000
  });
  assert.equal(prior.empiricalResidualRequests, 57);
  assert.equal(prior.expectedRemainingTurns, 28.5);
  assert.equal(prior.postSwitchRemainingTurns, 27.5);
});

test('Item 8: privacy-sanitized PreModelSwitch ask vs PostModelSwitch telemetry tracks 0.5 acceptance rate with empty Post stdout', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-telemetry-'));
  try {
    const fakePath = path.join(tmpHome, 'private-user-dir', 'transcript.jsonl');
    const pre1 = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'raw-secret-uuid-1234',
        cwd: tmpHome,
        transcript_path: fakePath,
        source: 'picker',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 18_927,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_output_tokens: 400,
        expected_remaining_turns: 6,
        requests_per_turn: 1,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, recordLedger: false, bypassLicense: true, useSessionCalibration: false }
    );
    assert.equal(pre1.verdict.decision, 'ask');

    // Accepted switch -> PostModelSwitch fires with empty stdout/stderr
    const post1 = runPostModelSwitchHook(
      {
        hook_event_name: 'PostModelSwitch',
        session_id: 'raw-secret-uuid-1234',
        cwd: tmpHome,
        transcript_path: fakePath,
        source: 'picker',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 18_927,
        prompt_cache_warm: true,
        cache_ttl: '5m'
      },
      { homeDir: tmpHome }
    );
    assert.equal(post1.exitCode, 0);
    assert.equal(post1.stdout, '');
    assert.equal(post1.stderr, '');
    assert.equal(post1.telemetryRecorded, true);

    // Second ask that user declines (no PostModelSwitch): 1h cold write to Sonnet 4.6 on H=6 exceeds payback
    const pre2 = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'raw-secret-uuid-1234',
        cwd: tmpHome,
        transcript_path: fakePath,
        source: 'command',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 25_000,
        prompt_cache_warm: true,
        cache_ttl: '1h',
        expected_output_tokens: 400,
        expected_remaining_turns: 6,
        requests_per_turn: 1,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, recordLedger: false, bypassLicense: true, useSessionCalibration: false }
    );
    assert.equal(pre2.verdict.decision, 'ask');

    const { telemetryPath, state } = readModelSwitchTelemetry({ homeDir: tmpHome });
    assert.equal(state.counts.preModelSwitchAsk, 2);
    assert.equal(state.counts.postModelSwitchTotal, 1);
    assert.equal(state.counts.postModelSwitchFromAsk, 1);
    assert.equal(state.metrics.askAcceptanceRate, 0.5);

    // Verify strict privacy sanitization (no paths, usernames, or raw session IDs)
    const rawTelemetryText = fs.readFileSync(telemetryPath, 'utf8');
    assert.ok(!rawTelemetryText.includes('private-user-dir'), 'Must not persist file paths');
    assert.ok(!rawTelemetryText.includes(tmpHome), 'Must not persist home/cwd paths');
    assert.ok(!rawTelemetryText.includes('raw-secret-uuid-1234'), 'Must not persist raw session ID');
    assert.ok(rawTelemetryText.includes('sess_'), 'Must hash session ID into sess_<hex>');
    assert.ok(rawTelemetryText.includes('"cacheTtl": "1h"'));
    assert.ok(rawTelemetryText.includes('"promptCacheWarm": true'));

    const doc = runDoctorDiagnostics({
      cwd: tmpHome,
      homeDir: tmpHome,
      skipClaudeBinaryProbe: true
    });
    assert.equal(doc.modelSwitchTelemetry.state.metrics.askAcceptanceRate, 0.5);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Follow-up Item 1: R estimator (prior 2.0, agreement reduction, >=3 local tx override) & Stop-hook prompt growth g (<5 turns capped)', () => {
  assert.equal(DEFAULT_RPT_SHRINKAGE_PRIOR, 2.0);
  assert.equal(RPT_SHRINKAGE_PRIOR_METADATA.isPlaceholderPrior, true);
  assert.match(RPT_SHRINKAGE_PRIOR_METADATA.provenance, /placeholder/);
  assert.equal(RPT_SHRINKAGE_PRIOR_METADATA.priorRequestsPerTurn, 2.0);
  assert.equal(RPT_SHRINKAGE_PRIOR_METADATA.agreementReducedMinTurns, 2.5);
  assert.equal(RPT_SHRINKAGE_PRIOR_METADATA.localTranscriptOverrideMinSessions, 3);

  // Synthetic slash-command / local-command entries must not dilute human turn count
  assert.equal(isRealHumanUserTranscriptEntry({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>...</local-command-caveat>' } }), false);
  assert.equal(isRealHumanUserTranscriptEntry({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }), false);
  assert.equal(isRealHumanUserTranscriptEntry({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to sonnet</local-command-stdout>' } }), false);
  assert.equal(isRealHumanUserTranscriptEntry({ type: 'user', message: { role: 'user', content: 'Inspect src/core-isomorphic/coach/cacheGravityRouter.mjs' } }), true);

  // Without agreement ([1, 5]), early n=2 retains minTrustedTurns=5 (w=0.4): 0.4*5 + 0.6*2 = 3.2
  const shrunkDisagree = shrinkRollingRequestsPerTurn(5, 2, { recentTurnRequestCounts: [1, 5] });
  assert.equal(shrunkDisagree.turnsAgree, false);
  assert.equal(shrunkDisagree.effectiveMinTrustedTurns, 5);
  assert.equal(shrunkDisagree.shrinkageWeight, 0.4);
  assert.equal(shrunkDisagree.expectedRequestsPerTurn, 3.2);
  assert.equal(shrunkDisagree.source, 'stop_hook_shrunk_rpt_median');
  assert.equal(shrunkDisagree.isPlaceholderShrinkagePrior, true);

  // When >=2 trailing turns agree ([5, 5]), minTrustedTurns halves to 2.5 (w=0.8): 0.8*5 + 0.2*2 = 4.4
  const shrunkAgree = shrinkRollingRequestsPerTurn(5, 2, { recentTurnRequestCounts: [5, 5] });
  assert.equal(shrunkAgree.turnsAgree, true);
  assert.equal(shrunkAgree.effectiveMinTrustedTurns, 2.5);
  assert.equal(shrunkAgree.shrinkageWeight, 0.8);
  assert.equal(shrunkAgree.expectedRequestsPerTurn, 4.4);
  assert.equal(shrunkAgree.source, 'stop_hook_agreed_shrunk_rpt_median');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-shrinkage-eval-'));
  try {
    // 1. Simulate L1 @ T3 (2 prior tool turns with R = 2 each + synthetic command entries)
    const txL1 = path.join(tmpDir, 'l1_t2.jsonl');
    const l1Lines = [];
    for (let t = 1; t <= 2; t += 1) {
      const baseCtx = 4000 + (t - 1) * 1000;
      l1Lines.push(
        JSON.stringify({ type: 'user', message: { role: 'user', content: `Turn ${t}` } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg_l1_${t}_a`,
            role: 'assistant',
            usage: { input_tokens: 3, cache_creation_input_tokens: 400, cache_read_input_tokens: baseCtx, output_tokens: 150 }
          }
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${t}`, content: 'ok' }] }
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg_l1_${t}_b`,
            role: 'assistant',
            usage: { input_tokens: 3, cache_creation_input_tokens: 400, cache_read_input_tokens: baseCtx + 400, output_tokens: 120 }
          }
        })
      );
    }
    l1Lines.push(
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>switched</local-command-stdout>' } })
    );
    fs.writeFileSync(txL1, `${l1Lines.join('\n')}\n`, 'utf8');
    const stopL1 = runStopGateHook(
      { session_id: 'l1_rpt', transcript_path: txL1, cwd: tmpDir },
      { cwd: tmpDir, homeDir: tmpDir, persistState: false }
    );
    assert.deepEqual(stopL1.sessionCalibration.recentTurnRequestCounts, [2, 2]);
    assert.equal(stopL1.sessionCalibration.rollingMedianRequestsPerTurn, 2);
    assert.ok(stopL1.sessionCalibration.rollingMedianPromptGrowthTokens > 0);

    const hookL1 = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'l1_rpt',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 11_952,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 27,
        mode: 'AUTO_PILOT'
      },
      { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true }
    );
    assert.equal(hookL1.verdict.requestsPerTurnUsed, 2);
    assert.equal(hookL1.verdict.rptTurnsAgree, true);
    assert.equal(hookL1.verdict.rptEstimateSource, 'stop_hook_agreed_shrunk_rpt_median');
    assert.equal(hookL1.verdict.isPlaceholderRptPrior, true);
    assert.equal(hookL1.verdict.promptGrowthEstimateSource, 'capped_early_session_no_extrapolation');
    assert.equal(hookL1.verdict.contextGrowthPerTurnUsed, 0);
    assert.equal(hookL1.verdict.netDollarDisplaySuppressed, true);
    assert.doesNotMatch(hookL1.verdict.notableAllowNote || '', /net [+-]\$/);
    assert.equal(hookL1.verdict.decision, 'allow');

    // 1b. Simulate Tool-Heavy T3 (2 agreeing R=5 turns + ~2,500 tok/turn Stop-hook growth)
    const txTh = path.join(tmpDir, 'th_t2.jsonl');
    const thLines = [];
    for (let t = 1; t <= 2; t += 1) {
      thLines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `TH turn ${t}` } }));
      for (let k = 1; k <= 5; k += 1) {
        const ctxBase = 8000 + (t - 1) * 2500 + (k - 1) * 500;
        thLines.push(
          JSON.stringify({
            type: 'assistant',
            message: {
              id: `msg_th_${t}_${k}`,
              role: 'assistant',
              usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: ctxBase, output_tokens: 110 }
            }
          })
        );
        if (k < 5) {
          thLines.push(
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_th_${t}_${k}`, content: 'ok' }] }
            })
          );
        }
      }
    }
    fs.writeFileSync(txTh, `${thLines.join('\n')}\n`, 'utf8');
    const stopTh = runStopGateHook(
      { session_id: 'th_rpt', transcript_path: txTh, cwd: tmpDir },
      { cwd: tmpDir, homeDir: tmpDir, persistState: false }
    );
    assert.deepEqual(stopTh.sessionCalibration.recentTurnRequestCounts, [5, 5]);
    assert.equal(stopTh.sessionCalibration.rollingMedianRequestsPerTurn, 5);
    // Turn 1: 10,613 - 8,503 = 2,110; Turn 2: 13,113 - 10,613 = 2,500 -> median (2110 + 2500) / 2 = 2,305
    assert.equal(stopTh.sessionCalibration.rollingMedianPromptGrowthTokens, 2305);

    const hookTh = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'th_rpt',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 13_216,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 9,
        mode: 'AUTO_PILOT'
      },
      { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true }
    );
    assert.equal(hookTh.verdict.requestsPerTurnUsed, 4.4);
    assert.equal(hookTh.verdict.rptTurnsAgree, true);
    assert.equal(hookTh.verdict.rptEffectiveMinTrustedTurns, 2.5);
    // Item 1: With < 5 observed turns (turnsCompleted = 2), growth extrapolation is capped (g = 0)
    // and net dollar display is suppressed in notableAllowNote (showing payback in warm requests/turns only)
    assert.equal(hookTh.verdict.contextGrowthPerTurnUsed, 0);
    assert.equal(hookTh.verdict.promptGrowthEstimateSource, 'capped_early_session_no_extrapolation');
    assert.equal(hookTh.verdict.netDollarDisplaySuppressed, true);
    assert.match(hookTh.verdict.notableAllowNote, /pays back in ~\d+\.\d+ post-switch warm requests \(~\d+\.\d+ turns\)/);
    assert.ok(hookTh.verdict.notableAllowNote.includes('<5 observed turns: net USD omitted'));
    assert.ok(!hookTh.verdict.notableAllowNote.includes('net +$'));
    assert.equal(hookTh.verdict.decision, 'allow');

    // Explicit context_growth_per_turn override still works when caller passes it directly
    const hookThExplicitGrowth = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'th_rpt',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 13_216,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 9,
        context_growth_per_turn: 2305,
        mode: 'AUTO_PILOT'
      },
      { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true }
    );
    assert.equal(hookThExplicitGrowth.verdict.contextGrowthPerTurnUsed, 2305);
    assert.ok(
      hookThExplicitGrowth.verdict.breakEven.averagePostSwitchSavingUSD >
        hookThExplicitGrowth.verdict.breakEven.perTurnPostSwitchSavingUSD
    );
    assert.ok(
      hookThExplicitGrowth.verdict.breakEven.horizonNetSavingsUSD >
        hookTh.verdict.breakEven.horizonNetSavingsUSD
    );

    // 2. Simulate L2 @ T24 (T1-T3 R=2, T4-T23 R=1 -> cumulative 26/23 = 1.1304, rolling 10-turn median = 1.0!)
    const txL2 = path.join(tmpDir, 'l2_t23.jsonl');
    const l2Lines = [];
    for (let t = 1; t <= 23; t += 1) {
      const ctx = 15000 + t * 260;
      l2Lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `Turn ${t}` } }));
      l2Lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg_l2_${t}_a`,
            role: 'assistant',
            usage: { input_tokens: 3, cache_creation_input_tokens: 260, cache_read_input_tokens: ctx, output_tokens: 150 }
          }
        })
      );
      if (t <= 3) {
        l2Lines.push(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu2_${t}`, content: 'ok' }] }
          }),
          JSON.stringify({
            type: 'assistant',
            message: {
              id: `msg_l2_${t}_b`,
              role: 'assistant',
              usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: ctx + 260, output_tokens: 150 }
            }
          })
        );
      }
    }
    fs.writeFileSync(txL2, `${l2Lines.join('\n')}\n`, 'utf8');
    const stopL2 = runStopGateHook(
      { session_id: 'l2_rpt', transcript_path: txL2, cwd: tmpDir },
      { cwd: tmpDir, homeDir: tmpDir, persistState: false }
    );
    assert.equal(stopL2.sessionCalibration.rollingMedianRequestsPerTurn, 1);
    assert.equal(stopL2.sessionCalibration.rptSampleSize, 10);
    assert.equal(stopL2.sessionCalibration.rollingMedianPromptGrowthTokens, 260);

    const hookL2 = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'l2_rpt',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 19_154,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 6,
        mode: 'AUTO_PILOT'
      },
      { cwd: tmpDir, homeDir: tmpDir, recordLedger: false, bypassLicense: true }
    );
    assert.equal(hookL2.verdict.requestsPerTurnUsed, 1);
    assert.equal(hookL2.verdict.rptEstimateSource, 'stop_hook_rolling_rpt_median');
    assert.equal(hookL2.verdict.contextGrowthPerTurnUsed, 260);
    assert.ok(hookL2.verdict.breakEven.horizonNetSavingsUSD < -0.02);
    assert.equal(hookL2.verdict.decision, 'ask');
    assert.ok(!hookL2.verdict.reason.includes('C*'));

    // 3. Local R prior requires >= 3 qualifying sessions, excludes the current session, and excludes benchmark/harness sessions
    const projDir = path.join(tmpDir, '.claude', 'projects', 'projRpt');
    fs.mkdirSync(projDir, { recursive: true });
    const makeSessionLines = (tag, rpt, extraText = '') => {
      const lines = [];
      for (let t = 1; t <= 2; t += 1) {
        lines.push(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: `Prompt ${tag}-${t} ${extraText} ` + 'x'.repeat(80) }
          })
        );
        for (let k = 1; k <= rpt; k += 1) {
          lines.push(
            JSON.stringify({
              type: 'assistant',
              message: {
                id: `msg_loc_${tag}_${t}_${k}`,
                role: 'assistant',
                usage: { input_tokens: 50, output_tokens: 40 }
              }
            })
          );
        }
      }
      return `${lines.join('\n')}\n`;
    };

    // Write 2 valid sessions (R=3) + 1 current session (l1_rpt, R=9) + 1 benchmark session (Benchmark-Run-Salt:, R=9)
    fs.writeFileSync(path.join(projDir, 'sess_rpt_1.jsonl'), makeSessionLines('s1', 3), 'utf8');
    fs.writeFileSync(path.join(projDir, 'sess_rpt_2.jsonl'), makeSessionLines('s2', 3), 'utf8');
    fs.writeFileSync(path.join(projDir, 'l1_rpt.jsonl'), makeSessionLines('self', 9), 'utf8');
    fs.writeFileSync(
      path.join(projDir, 'sess_bench.jsonl'),
      makeSessionLines('bench', 9, 'Benchmark-Run-Salt: TH_allow_1234'),
      'utf8'
    );

    // With only 2 qualifying sessions (after excluding self and benchmark), medianRequestsPerTurn is null (< 3 sessions)
    const priorsUnder3 = loadLocalClaudeSessionPriors({
      homeDir: tmpDir,
      cwd: tmpDir,
      excludeSessionId: 'l1_rpt',
      nowMs: 1000
    });
    assert.equal(priorsUnder3.sessionCount, 2);
    assert.equal(priorsUnder3.medianRequestsPerTurn, null);

    // Add a 3rd qualifying session (R=3) -> now >= 3 sessions, so medianRequestsPerTurn = 3
    fs.writeFileSync(path.join(projDir, 'sess_rpt_3.jsonl'), makeSessionLines('s3', 3), 'utf8');
    const priorsAt3 = loadLocalClaudeSessionPriors({
      homeDir: tmpDir,
      cwd: tmpDir,
      excludeSessionId: 'l1_rpt',
      nowMs: 5_000_000
    });
    assert.equal(priorsAt3.sessionCount, 3);
    assert.equal(priorsAt3.medianRequestsPerTurn, 3);
    // Survival quantile gate remains >= 5 sessions
    assert.equal(
      loadLocalClaudeSessionApiCalls({
        homeDir: tmpDir,
        cwd: tmpDir,
        excludeSessionId: 'l1_rpt',
        nowMs: 5_000_000
      }),
      null
    );

    const localRptHook = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'l1_rpt',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 11_952,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 27,
        mode: 'AUTO_PILOT'
      },
      { cwd: tmpDir, homeDir: tmpDir, nowMs: 5_000_000, recordLedger: false, bypassLicense: true }
    );
    assert.equal(localRptHook.verdict.isPlaceholderRptPrior, false);
    assert.equal(localRptHook.verdict.rptPriorUsed, 3);
    // L1 has agreed R=[2,2] (w=0.8) and local prior 3 (weight 0.2) => 0.8*2 + 0.2*3 = 2.2
    assert.equal(localRptHook.verdict.requestsPerTurnUsed, 2.2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Follow-up Item 4 & 6: warm-request payback (a/b less output credit) across R=1,5,10 and PostModelSwitch capability guard', () => {
  const base5m = {
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 50_000,
    expectedOutputTokens: 400,
    cacheWarm: true,
    cacheTtlTier: '5m'
  };
  const r1 = computeBreakEvenCachedTokens({ ...base5m, requestsPerTurn: 1 });
  const r5 = computeBreakEvenCachedTokens({ ...base5m, requestsPerTurn: 5 });
  const r10 = computeBreakEvenCachedTokens({ ...base5m, requestsPerTurn: 10 });
  assert.equal(r1.asymptoticWarmRequestRatio, 16.25);
  assert.equal(r1.paybackWarmRequests, 11.32);
  assert.equal(r5.paybackWarmRequests, 10.97);
  assert.equal(r5.totalWarmReadsToPayback, 14.97);
  assert.equal(r10.paybackWarmRequests, 6.59);
  assert.equal(r10.totalWarmReadsToPayback, 15.59);

  // Context growth parameterization reduces to identical static values when g = 0
  const withGrowth = computeBreakEvenCachedTokens({
    ...base5m,
    requestsPerTurn: 1,
    expectedRemainingTurns: 27,
    contextGrowthPerTurn: 279
  });
  assert.ok(withGrowth.horizonNetSavingsUSD > r1.paybackTurns * 0);
  assert.equal(withGrowth.contextGrowthPerTurn, 279);

  // Item 6: installAttentionHorizon omits PostModelSwitch when resolved binary lacks PostModelSwitch
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legacy-bin-'));
  try {
    const legacyBin = path.join(tmpBinDir, 'claude_legacy.js');
    fs.writeFileSync(
      legacyBin,
      '// Mock older Claude bundle with PreModelSwitch only\nconst events = ["PreModelSwitch", "from_model", "to_model", "prompt_cache_warm", "permissionBehavior===\\"ask\\""];\n',
      'utf8'
    );
    const legacySettingsPath = path.join(tmpBinDir, 'legacy_settings.json');
    const legacyInstall = installAttentionHorizon({
      settingsPath: legacySettingsPath,
      cwd: tmpBinDir,
      claudeBinPath: legacyBin,
      dryRun: true
    });
    assert.deepEqual(legacyInstall.omittedUnsupportedHooks, ['PostModelSwitch']);
    assert.ok(legacyInstall.settings.hooks.PreModelSwitch);
    assert.equal(legacyInstall.settings.hooks.PostModelSwitch, undefined);

    const modernBin = path.join(tmpBinDir, 'claude_modern.js');
    fs.writeFileSync(
      modernBin,
      '// Mock 2.1.325 bundle\nconst events = ["PreModelSwitch", "PostModelSwitch", "from_model", "to_model", "prompt_cache_warm", "permissionBehavior===\\"ask\\""];\n',
      'utf8'
    );
    const modernInstall = installAttentionHorizon({
      settingsPath: legacySettingsPath,
      cwd: tmpBinDir,
      claudeBinPath: modernBin,
      dryRun: true
    });
    assert.deepEqual(modernInstall.omittedUnsupportedHooks, []);
    assert.ok(modernInstall.settings.hooks.PostModelSwitch);
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true });
  }
});

