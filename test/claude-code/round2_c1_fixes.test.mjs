import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import {
  CacheGravityRouter,
  computeBreakEvenCachedTokens,
  computeDet09BreakEvenTokens
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  createInitialTelemetryState,
  ingestModTurnEvent,
  ingestStatusLinePayload
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import {
  normalizeModelId,
  resolveEffectiveRates
} from '../../src/core-isomorphic/config/catalogLoader.mjs';

test('C1a: runPreModelSwitchHook records exact coldWritePenaltyUSD instead of $5.00/M fallback', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1a-ledger-'));
  const ledgerPath = path.join(tmpDir, 'horizon_ledger.jsonl');
  try {
    const res = runPreModelSwitchHook(
      {
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

    assert.equal(res.exitCode, 2);
    assert.equal(res.verdict.blocked, true);
    assert.equal(res.verdict.breakEven.coldWritePenaltyUSD, 0.032355);

    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.category, 'DET_08_MODEL_SWITCH_HOLD');
    assert.equal(entry.savedTokens, 14840);
    assert.equal(entry.savedUSD, 0.032355);
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
  staleState.promptCache.expiresAt = baseNow - 120_000; // expired 2m ago

  const resExpired = runPreModelSwitchHook(
    {
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

  // Contrast: before expiry (nowMs < expiresAt), same state holds
  const resWarm = runPreModelSwitchHook(
    {
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
  assert.equal(resWarm.exitCode, 2);
  assert.equal(resWarm.verdict.blocked, true);
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

test('C1e: DET-08 preserves rule_v1 by default and honors expectedRemainingTurns payback in rule_v2', () => {
  // Default rule_v1 holds at Turn 3 (cachedTokens=9500 > C*):
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
  assert.ok(v1.paybackTurns > 5 && v1.paybackTurns < 6);

  // rule_v2 on L1 (27 post-switch turns left >= payback ~5.51): ALLOWS
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

  // rule_v2 on L2 (6 post-switch turns left < payback ~7.84 at C=16500): HOLDS
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
});

test('C1g: non-Anthropic model slugs silently fall back to claude-sonnet-5-5 in catalogLoader', () => {
  assert.equal(normalizeModelId('google/gemini-2.5-pro'), 'claude-sonnet-5-5');
  const rates = resolveEffectiveRates('google/gemini-2.5-pro', 20000);
  assert.equal(rates.modelId, 'claude-sonnet-5-5');
  assert.equal(rates.inputPer1M, 2.0);
  assert.equal(rates.outputPer1M, 10.0);
});
