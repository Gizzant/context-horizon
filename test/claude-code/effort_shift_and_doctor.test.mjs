import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatPreEffortChangeCapability,
  inspectClaudeBinaryCapabilities
} from '../../src/diagnostics/claudeHookCapabilities.mjs';
import { runCli } from '../../bin/ctxtop.mjs';
import {
  createInitialEffortTrackingState,
  extractEventEffortObservation,
  applyTurnEffortObservation
} from '../../src/core-isomorphic/coach/effortShiftDetector.mjs';
import {
  createInitialTelemetryState,
  ingestModTurnEvent,
  ingestStatusLinePayload
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { runUserPromptSubmitHook } from '../../hooks/handlers/user-prompt-submit.mjs';

test('Option 1: inspectClaudeBinaryCapabilities keeps boolean API contract while ctxtop doctor clarifies PreEffortChange', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-effort-doc-'));
  try {
    const validBin = path.join(tmpDir, 'claude-2.1.325.js');
    fs.writeFileSync(
      validBin,
      'const Ec=["PreModelSwitch","PostModelSwitch"]; const h={from_model:1,to_model:1,prompt_cache_warm:1,context_tokens:1}; if(y.permissionBehavior==="ask"||msg==="blocked_by_hook"){}',
      'utf8'
    );

    const cap = inspectClaudeBinaryCapabilities({
      cwd: tmpDir,
      claudeBinPath: validBin,
      claudeVersion: '2.1.325',
      bypassCache: true
    });
    assert.equal(cap.found, true);
    assert.equal(cap.preEffortChangeSupported, false);
    assert.equal(
      cap.preEffortChangeSummary,
      'n/a (ConfigChange + turn-boundary active; 5.5+ cache-safe)'
    );
    assert.equal(formatPreEffortChangeCapability({ preEffortChangeSupported: true }), 'true');

    const cachedCap = inspectClaudeBinaryCapabilities({
      cwd: tmpDir,
      claudeBinPath: validBin
    });
    assert.equal(cachedCap.cached, true);
    assert.equal(cachedCap.preEffortChangeSupported, false);
    assert.equal(
      cachedCap.preEffortChangeSummary,
      'n/a (ConfigChange + turn-boundary active; 5.5+ cache-safe)'
    );

    const docRes = runCli(['doctor'], {
      cwd: tmpDir,
      claudeBinPath: validBin,
      claudeVersion: '2.1.325',
      bypassCache: true
    });
    assert.equal(docRes.exitCode, 0);
    assert.ok(
      docRes.output.includes('PreEffortChange=n/a (ConfigChange + turn-boundary active; 5.5+ cache-safe)'),
      `Expected clarified PreEffortChange output, got:\n${docRes.output}`
    );
    assert.ok(!docRes.output.includes('PreEffortChange=false'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Option 2A: DET-09 attributes 4.6 warm prefix rewrites on explicit effort shifts and inferred cache resets', () => {
  // Explicit /effort shift on legacy 4.6
  let state = createInitialTelemetryState('sess-effort-46-exp', 'claude-sonnet-4-6');
  state = ingestModTurnEvent(state, {
    type: 'turn.complete',
    turnId: 't1',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 80000,
      cache_read_input_tokens: 0,
      output_tokens: 300,
      thinking_tokens: 400
    }
  });
  assert.equal(state.effortTracking.currentEffort, 'medium');
  assert.equal(state.effortTracking.pendingAdvisory, null);

  state = ingestModTurnEvent(state, {
    type: 'turn.complete',
    turnId: 't2',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 80500,
      cache_read_input_tokens: 0,
      output_tokens: 350,
      thinking_tokens: 1800
    }
  });
  assert.equal(state.effortTracking.shiftCount, 1);
  assert.equal(state.effortTracking.pendingAdvisory?.detectorId, 'DET-09');
  assert.equal(state.effortTracking.pendingAdvisory?.subType, 'POST_EFFORT_CACHE_REWRITE');
  assert.equal(state.effortTracking.pendingAdvisory?.cachePreserved, false);
  assert.ok((state.effortTracking.pendingAdvisory?.rewritePenaltyUSD || 0) > 0.25);
  assert.match(state.effortTracking.pendingAdvisory?.message || '', /medium -> high/);

  // Inferred whole-prefix rewrite without explicit effort payload
  let inferredState = createInitialTelemetryState('sess-effort-46-inf', 'claude-sonnet-4-6');
  inferredState = ingestModTurnEvent(inferredState, {
    type: 'turn.complete',
    turnId: 't1',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 80000,
      cache_read_input_tokens: 0,
      output_tokens: 300
    }
  });
  inferredState = ingestModTurnEvent(inferredState, {
    type: 'turn.complete',
    turnId: 't2',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 82000,
      cache_read_input_tokens: 0,
      output_tokens: 310
    }
  });
  assert.equal(inferredState.effortTracking.pendingAdvisory?.detectorId, 'DET-09');
  assert.equal(inferredState.effortTracking.pendingAdvisory?.subType, 'POST_EFFORT_CACHE_REWRITE');
  assert.equal(inferredState.effortTracking.pendingAdvisory?.inferredFromRewrite, true);
  assert.ok((inferredState.effortTracking.pendingAdvisory?.rewritePenaltyUSD || 0) > 0.25);
});

test('Option 2B: 5.5+ models preserve KV cache cleanly on single shift and trigger DET-21 routine spike with 3-turn cooldown', () => {
  let state = createInitialTelemetryState('sess-effort-55', 'claude-sonnet-5-5');
  state = ingestStatusLinePayload(state, {
    session_id: 'sess-effort-55',
    turn_id: 'st-1',
    model: { id: 'claude-sonnet-5-5', effort: 'medium' },
    prompt_cache: { warm: true, ttl: '5m' },
    context_window: {
      current_usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 0,
        output_tokens: 600,
        thinking_tokens: 500
      }
    }
  });

  // Single high-effort shift on 5.5+ stays silent while recording cache preservation
  state = ingestStatusLinePayload(state, {
    session_id: 'sess-effort-55',
    turn_id: 'st-2',
    model: { id: 'claude-sonnet-5-5', effort: 'high' },
    turnMutations: 0,
    prompt_cache: { warm: true, ttl: '5m' },
    context_window: {
      current_usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100000,
        output_tokens: 400,
        thinking_tokens: 6500
      }
    }
  });
  assert.equal(state.effortTracking.lastCacheSafeShift?.preservedTokens, 100000);
  assert.equal(state.effortTracking.highEffortRoutineStreak, 1);
  assert.equal(state.effortTracking.pendingAdvisory, null);

  // Second consecutive routine thinking spike triggers DET-21
  state = ingestStatusLinePayload(state, {
    session_id: 'sess-effort-55',
    turn_id: 'st-3',
    model: { id: 'claude-sonnet-5-5', effort: 'high' },
    turnMutations: 0,
    prompt_cache: { warm: true, ttl: '5m' },
    context_window: {
      current_usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100000,
        output_tokens: 400,
        thinking_tokens: 6500
      }
    }
  });
  assert.equal(state.effortTracking.highEffortRoutineStreak, 2);
  assert.equal(state.effortTracking.pendingAdvisory?.detectorId, 'DET-21');
  assert.equal(state.effortTracking.pendingAdvisory?.subType, 'HIGH_EFFORT_ROUTINE_SPIKE');
  assert.equal(state.effortTracking.pendingAdvisory?.cachePreserved, true);
  assert.equal(state.effortTracking.pendingAdvisory?.rewritePenaltyUSD, 0);

  // Cooldown suppresses duplicate advisory on immediate turn 4
  state.effortTracking.pendingAdvisory = null;
  state = ingestStatusLinePayload(state, {
    session_id: 'sess-effort-55',
    turn_id: 'st-4',
    model: { id: 'claude-sonnet-5-5', effort: 'high' },
    turnMutations: 0,
    prompt_cache: { warm: true, ttl: '5m' },
    context_window: {
      current_usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100000,
        output_tokens: 400,
        thinking_tokens: 6500
      }
    }
  });
  assert.equal(state.effortTracking.highEffortRoutineStreak, 3);
  assert.equal(state.effortTracking.pendingAdvisory, null);
});

test('Option 2C: unverified model emits zero-dollar advisory and UserPromptSubmit consumes advisories once', () => {
  const obs = extractEventEffortObservation({ reasoningEffort: 'XHigh', thinking_budget: '12000' });
  assert.deepEqual(obs, { effortLevel: 'max', thinkingBudget: 12000 });

  let unverified = createInitialEffortTrackingState();
  unverified = applyTurnEffortObservation(unverified, {
    modelId: 'unknown-custom-model',
    rawModelId: 'unknown-custom-model',
    observedEffort: 'medium',
    turnIndex: 1,
    priorWarmPrefixTokens: 60000,
    priorCacheWarm: true,
    hasTurnUsage: false
  });
  unverified = applyTurnEffortObservation(unverified, {
    modelId: 'unknown-custom-model',
    rawModelId: 'unknown-custom-model',
    observedEffort: 'high',
    turnIndex: 2,
    priorWarmPrefixTokens: 60000,
    priorCacheWarm: true,
    hasTurnUsage: false
  });
  assert.equal(unverified.pendingAdvisory?.subType, 'POST_EFFORT_UNVERIFIED');
  assert.equal(unverified.pendingAdvisory?.rewritePenaltyUSD, null);
  assert.ok(!(unverified.pendingAdvisory?.message || '').includes('$'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-effort-ups-'));
  try {
    const liveWithAdvisory = {
      ...createInitialTelemetryState('ups-eff-1', 'claude-sonnet-5-5'),
      flightMode: 'COACH',
      turnsCompleted: 4,
      contextWindow: { warmPrefixTokens: 90000, cachedTokens: 90000 },
      promptCache: { warm: true, ttlTier: '5m' },
      effortTracking: {
        ...createInitialEffortTrackingState(),
        currentEffort: 'high',
        pendingAdvisory: {
          advisoryId: 'spk-4-2',
          detectorId: 'DET-21',
          subType: 'HIGH_EFFORT_ROUTINE_SPIKE',
          message: '[Highbeam DET-21] Consider /effort medium on routine turns.'
        }
      }
    };

    const first = runUserPromptSubmitHook(
      {
        cwd: tmpDir,
        session_id: 'ups-eff-1',
        prompt: 'Inspect the config loader and summarize the exported helpers in detail.',
        turnNumber: 4
      },
      { telemetryState: liveWithAdvisory, persistState: true, bucketBShadow: false }
    );
    assert.equal(first.verdict.triggered, true);
    assert.equal(first.verdict.detectorId, 'DET-21');
    assert.equal(first.verdict.decision, 'steer');

    const second = runUserPromptSubmitHook(
      {
        cwd: tmpDir,
        session_id: 'ups-eff-1',
        prompt: 'Inspect the config loader and summarize its rate card structure in detail.',
        turnNumber: 5
      },
      { telemetryState: liveWithAdvisory, persistState: true, bucketBShadow: false }
    );
    assert.equal(second.verdict.triggered, false);
    assert.equal(second.stdout, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
