import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COACH_MODES,
  COST_MULTIPLIER_MATRIX,
  CacheGravityScorer,
  HysteresisLock,
  TurnBoundaryActuationQueue,
  TaskQuotaRouter
} from '../src/core/coach/task_quota_router.mjs';
import { TrajectoryWatcher } from '../src/core/telemetry/trajectory_watcher.mjs';
import { CircuitBreakers } from '../src/core/coach/circuit_breakers.mjs';
import { AgBridgeService } from '../src/core/ag_bridge.mjs';

test('Phase 2: Cost Multiplier Matrix and CacheGravityScorer break-even math & tooltip', () => {
  assert.deepEqual(COST_MULTIPLIER_MATRIX['gemini-3.8-flash'], { low: 1.0, med: 1.5, medium: 1.5, high: 2.2 });
  assert.deepEqual(COST_MULTIPLIER_MATRIX['gemini-4-argon'], { low: 3.0, med: 5.5, medium: 5.5, high: 9.25 });
  assert.deepEqual(COST_MULTIPLIER_MATRIX['claude-sonnet-4.6'], { low: 3.5, med: 5.0, medium: 5.0, high: 7.5 });

  const scorer = new CacheGravityScorer();
  // T_cached = 68,400, TTL = 220s (3m 40s), T_out = 8,070 ->
  // Warm Argon-Low = 68400 * 0.05 * 3.0 + 8070 * 3.0 = 10260 + 24210 = 34470
  // Cold Flash-Low = 68400 * 1.00 * 1.0 + 8070 * 1.0 = 76470
  // \Delta_{cost} = 34470 - 76470 = -42000 (+42k equiv burn penalty to switch cold)
  const res = scorer.computeBreakEvenDelta({
    currentModel: 'gemini-4-argon',
    targetModel: 'gemini-3.8-flash',
    targetEffort: 'low',
    cachedTokens: 68400,
    ttlRemainingSeconds: 220,
    expectedOutputTokens: 8070
  });

  assert.equal(res.warmCurrentLowCost, 34470);
  assert.equal(res.coldTargetSwitchCost, 76470);
  assert.equal(res.deltaCost, -42000);
  assert.equal(res.coldSwitchPenaltyTokens, 42000);
  assert.equal(res.hasWarmCacheGravity, true);
  assert.equal(res.blockCrossModelSwitch, true);
  assert.equal(res.recommendedModel, 'gemini-4-argon');
  assert.equal(res.recommendedEffort, 'low');
  assert.equal(
    res.tooltip,
    'Warm Cache: 68.4k tokens (TTL 3m 40s) • Cold Flash switch costs +42k equiv burn vs Argon-Low'
  );
});

test('Phase 2: TurnBoundaryActuationQueue queues AUTO_PILOT actuations while tools execute and dispatches on IDLE / WAITING_FOR_USER', async () => {
  const dispatched = [];
  const agBridge = new AgBridgeService({
    rpcTransport: {
      sendChatCommand: async (sessionId, payload) => {
        dispatched.push({ sessionId, payload });
        return { ok: true };
      }
    }
  });

  const router = new TaskQuotaRouter({
    mode: COACH_MODES.AUTO_PILOT,
    activeModel: 'gemini-4-argon',
    activeEffort: 'high',
    languageServerState: 'EXECUTING_TOOLS',
    agBridge
  });

  // Evaluate while tools are executing -> MUST queue and NOT fire RPC mid-stream
  const midStreamRes = await router.evaluateTurn({
    sessionId: 'sess-boundary',
    currentModel: 'gemini-4-argon',
    currentEffort: 'high',
    targetModel: 'gemini-3.8-flash',
    targetEffort: 'low',
    cachedTokens: 68400,
    ttlRemainingSeconds: 220
  });

  assert.equal(midStreamRes.actuated, false);
  assert.equal(midStreamRes.queued, true);
  assert.equal(dispatched.length, 0, 'Must never dispatch SET_MODEL_AND_EFFORT while EXECUTING_TOOLS');

  // Transition Language Server to WAITING_FOR_USER -> flushes queue immediately
  const flushRes = await router.turnBoundaryQueue.setLanguageServerState('WAITING_FOR_USER');
  assert.equal(flushRes.flushed, true);
  assert.equal(flushRes.flushedCount, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].payload.type, 'SET_MODEL_AND_EFFORT');
  assert.equal(dispatched[0].payload.model, 'gemini-4-argon');
  assert.equal(dispatched[0].payload.effort, 'low');
});

test('Phase 1 & 2: HysteresisLock sticky escalation across task.md transitions and TRAJECTORY_REWIND rollback resets', async () => {
  const hysteresisLock = new HysteresisLock();
  const circuitBreakers = new CircuitBreakers({ hysteresisLock });
  const trajectoryWatcher = new TrajectoryWatcher({
    hysteresisLock,
    circuitBreaker: circuitBreakers
  });

  const router = new TaskQuotaRouter({
    mode: COACH_MODES.COACH,
    hysteresisLock
  });

  // 1. Trigger DET-01 Retry Churn (>= 2 failing tool calls) at turns 0..3
  trajectoryWatcher.observeTrajectoryUpdate({
    sessionId: 'sess-rewind',
    stepCount: 4,
    steps: [
      { type: 'USER_INPUT', tokens: 1200 },
      { type: 'TOOL', tokens: 2400 },
      { type: 'TOOL', tokens: 2400 },
      { type: 'TOOL', tokens: 2400 }
    ]
  });

  circuitBreakers.recordTurn({
    turnIndex: 2,
    activeTaskMdStepId: 'Implement CacheGravityScorer',
    toolName: 'run_command',
    args: { CommandLine: 'npm test' },
    exitCode: 1
  });
  const cbTrip = circuitBreakers.recordTurn({
    turnIndex: 3,
    activeTaskMdStepId: 'Implement CacheGravityScorer',
    toolName: 'run_command',
    args: { CommandLine: 'npm test' },
    exitCode: 1
  });

  assert.equal(cbTrip.hasTripped, true);
  assert.equal(cbTrip.triggered[0].detectorId, 'DET-01');
  assert.equal(hysteresisLock.isLocked(), true);

  // 2. Attempt downshift while active step is still [/] -> blocked by HysteresisLock
  const blockedEval = await router.evaluateTurn({
    currentModel: 'gemini-4-argon',
    currentEffort: 'high',
    targetModel: 'gemini-3.8-flash',
    targetEffort: 'low',
    activeTaskMdStepId: 'Implement CacheGravityScorer'
  });
  assert.equal(blockedEval.blockedByHysteresis, true);
  assert.equal(blockedEval.recommendedModel, 'gemini-4-argon');
  assert.equal(blockedEval.recommendedEffort, 'high');

  //Still locked if task.md step is still [/]
  hysteresisLock.onTaskMdUpdate('- [/] Implement CacheGravityScorer\n');
  assert.equal(hysteresisLock.isLocked(), true);

  // 3. Unlocks when task.md step transitions from [/] to [x]
  const unlockStepRes = hysteresisLock.onTaskMdUpdate('- [x] Implement CacheGravityScorer\n');
  assert.equal(unlockStepRes.unlocked, true);
  assert.equal(hysteresisLock.isLocked(), false);

  // 4. Re-engage via DET-02 AST Edit Oscillation at turn 4, then test TRAJECTORY_REWIND rollback
  circuitBreakers.recordTurn({
    turnIndex: 1,
    activeTaskMdStepId: 'Refactor router',
    filePath: 'src/router.mjs',
    newContent: 'export const v = 1;'
  });
  circuitBreakers.recordTurn({
    turnIndex: 2,
    activeTaskMdStepId: 'Refactor router',
    filePath: 'src/router.mjs',
    newContent: 'export const v = 2;'
  });
  const oscTrip = circuitBreakers.recordTurn({
    turnIndex: 3,
    activeTaskMdStepId: 'Refactor router',
    filePath: 'src/router.mjs',
    newContent: 'export const v = 1;' // Matches T-2 state!
  });

  assert.equal(oscTrip.hasTripped, true);
  const det02Alert = oscTrip.triggered.find((t) => t.detectorId === 'DET-02');
  assert.ok(det02Alert, 'DET-02 must trigger when SHA-256 matches T-2 state');
  assert.ok(det02Alert.promptPill.prompt.includes('3-Stage Stepwise Refinement'));
  assert.equal(hysteresisLock.isLocked(), true);

  // User clicks Undo / Rewind in Antigravity chat (stepCount drops from 4 -> 1)
  let rewindEvent = null;
  trajectoryWatcher.once('TRAJECTORY_REWIND', (ev) => { rewindEvent = ev; });

  const obsRes = trajectoryWatcher.observeTrajectoryUpdate({
    sessionId: 'sess-rewind',
    stepCount: 1,
    steps: [{ type: 'USER_INPUT', tokens: 1200 }]
  });

  assert.equal(obsRes.rewindDetected, true);
  assert.equal(obsRes.droppedSteps, 3);
  assert.ok(rewindEvent);
  assert.equal(rewindEvent.newStepCount, 1);
  assert.equal(rewindEvent.droppedSteps, 3);
  assert.equal(rewindEvent.flamegraph.totalTokens, 1200);

  // HysteresisLock and CircuitBreakers must be unlocked and purged of turns >= 1
  assert.equal(hysteresisLock.isLocked(), false);
  assert.equal(hysteresisLock.lastUnlockReason, 'TRAJECTORY_REWIND');
  assert.equal(circuitBreakers.activeAlerts.length, 0);
});

test('Phase 2: AgBridgeService gates CDP actuation behind enableExperimentalCdpActuation and blocks when chat input has focus', async () => {
  const cdpCalls = [];
  const bridge = new AgBridgeService({
    cdpTransport: {
      sendChatCommand: async (sid, payload) => {
        cdpCalls.push({ sid, payload });
        return { ok: true };
      }
    }
  });

  // 1. Default: experimental CDP actuation is disabled for SET_MODEL_AND_EFFORT
  const blockedDefault = await bridge.sendChatCommand('s1', {
    type: 'SET_MODEL_AND_EFFORT',
    model: 'gemini-4-argon',
    effort: 'low'
  });
  assert.equal(blockedDefault.ok, false);
  assert.equal(blockedDefault.cdpBlockedReason, 'EXPERIMENTAL_CDP_DISABLED');
  assert.equal(cdpCalls.length, 0);

  // 2. Enable experimental CDP, but chatInputFocused = true -> still blocked!
  bridge.setExperimentalCdpActuation(true);
  bridge.setChatInputFocus(true);
  const blockedFocus = await bridge.sendChatCommand('s1', {
    type: 'SET_MODEL_AND_EFFORT',
    model: 'gemini-4-argon',
    effort: 'low'
  });
  assert.equal(blockedFocus.ok, false);
  assert.equal(blockedFocus.cdpBlockedReason, 'CHAT_INPUT_FOCUSED');
  assert.equal(cdpCalls.length, 0);

  // 3. Unfocus chat input with experimental CDP enabled -> succeeds
  bridge.setChatInputFocus(false);
  const allowed = await bridge.sendChatCommand('s1', {
    type: 'SET_MODEL_AND_EFFORT',
    model: 'gemini-4-argon',
    effort: 'low'
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.transportUsed, 'cdp');
  assert.equal(cdpCalls.length, 1);
});
