import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import {
  CacheGravityRouter,
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
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /payback ~\d+\.\d+ turns/);

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
    assert.match(resDeny.stderr, /payback ~\d+\.\d+ turns/);
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
      { recordLedger: false, bypassLicense: true }
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
  const priorT3 = estimateEmpiricalRemainingTurns({ turnsCompleted: 3, cachedTokens: 14000 });
  assert.equal(priorT3.expectedRemainingTurns, 59);
  assert.equal(priorT3.source, 'empirical_496_session_prior');

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
