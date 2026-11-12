/**
 * @file test/challenger_m4_1_extended_stress.mjs
 * Milestone 4 Iteration 3 Extended Adversarial Stress Suite (Features 24–28).
 *
 * Additional edge-case mining, stress testing, and boundary validation:
 * - Feature 24: Call-Tree & Flamegraphs (sparse turns, undefined durations, deep cyclic graphs, 1000 spans)
 * - Feature 25: Swarm & Worktree (porcelain edge cases, unicode paths, quota brakes, scope globs)
 * - Feature 26: Control State Machine (FSM exhaustiveness, ABORTED terminality, prototype pollution safety)
 * - Feature 27: COACH Mode Latches (Priority hierarchy, Ring-0 invariants across all modes, HUD pill)
 * - Feature 28: Atomic Tool-Boundary Suspension (pre-aborted signals, throw inside getter, spread order verification)
 *
 * Authored by: challenger_m4_it3_1 (Milestone 4 Challenger 1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSpan,
  endSpan,
  closeUnclosedSpans,
  buildCallTree,
  computeCriticalPath,
  renderCallTree,
  buildFlamegraphData
} from '../src/core-isomorphic/control/callTree.mjs';

import {
  parseWorktreePorcelain,
  computeSwarmSummary,
  formatSwarmCompact,
  toCostRadarTopology,
  SWARM_LIFECYCLE_CONSTANTS,
  evaluateScopeAndQuotaBrake,
  matchesScopePattern
} from '../src/core-isomorphic/control/swarmWorktree.mjs';

import {
  CONTROL_STATES,
  createInitialControlState,
  transitionControlState,
  parseControlFile,
  serializeControlFile,
  evaluateToolBoundaryLatch
} from '../src/core-isomorphic/control/controlStateMachine.mjs';

import {
  normalizeFlightMode,
  evaluateCoachLatch,
  renderCoachPill
} from '../src/core-isomorphic/control/coachLatches.mjs';

import {
  SUSPENSION_CONSTANTS,
  waitForSuspensionResume,
  toProtoSafePreHookOutput,
  wrapSafeToolBoundary
} from '../src/core-isomorphic/control/toolSuspension.mjs';

// =========================================================================
// SECTION 1: Feature 24 — Call-Tree, Critical Path & Flamegraph Edge Cases
// =========================================================================
describe('Milestone 4 Extended Stress: Call-Tree & Spans (Feature 24)', () => {
  it('1.1 Sparse turns, missing spans, and null objects in renderCallTree', () => {
    // Empty objects and null inputs
    assert.equal(renderCallTree({}), 'span [0ms]\n');
    assert.equal(renderCallTree(null), '');
    assert.equal(renderCallTree(undefined), '');
    assert.equal(renderCallTree([]), '');

    // Sparse trajectory: undefined/null entries in turns array
    const sparseTrajectory = {
      sessionId: 'session-sparse-edge',
      host: 'antigravity',
      turns: [
        null,
        undefined,
        {
          turnIndex: 3,
          durationMs: 120,
          toolSpans: [
            null,
            { toolName: 'read_file', durationMs: 45, status: 'ok' },
            undefined,
            { name: 'run_command', durationMs: 70, status: 'error' }
          ]
        },
        {
          // missing turnIndex and durationMs
          toolSpans: [
            { toolName: 'write_file' } // missing durationMs and status
          ]
        }
      ]
    };

    const rendered = renderCallTree(sparseTrajectory);
    assert.ok(typeof rendered === 'string');
    assert.ok(rendered.includes('Session: session-sparse-edge [antigravity]'));
    assert.ok(rendered.includes('Turn 3 [120ms]'));
    assert.ok(rendered.includes('read_file [45ms] (ok)'));
    assert.ok(rendered.includes('run_command [70ms] (error)'));
    assert.ok(rendered.includes('Turn 4 [0ms]'));
    assert.ok(rendered.includes('write_file [0ms] (ok)'));
  });

  it('1.2 Undefined durations, future start times, and zero duration spans in closeUnclosedSpans', () => {
    const defaultEnd = 2000;
    const spans = [
      // 1. Span with undefined durationMs and endTimeMs
      { spanId: 's1', startTimeMs: 1500 },
      // 2. Span with durationMs already set to 0 (must NOT be overwritten)
      { spanId: 's2', startTimeMs: 1000, durationMs: 0, endTimeMs: 1000 },
      // 3. Span where startTimeMs is in the future (> defaultEndTime)
      { spanId: 's3', startTimeMs: 2500 },
      // 4. Corrupted elements in array (null, undefined, string, number)
      null,
      undefined,
      'not a span',
      42,
      // 5. Span missing startTimeMs entirely
      { spanId: 's5' }
    ];

    const result = closeUnclosedSpans(spans, { endTimeMs: defaultEnd, status: 'ok' });

    // s1 was open: duration should be 2000 - 1500 = 500
    assert.equal(result[0].durationMs, 500);
    assert.equal(result[0].endTimeMs, 2000);

    // s2 was already closed with 0ms: must remain 0
    assert.equal(result[1].durationMs, 0);
    assert.equal(result[1].endTimeMs, 1000);

    // s3 started at 2500 (future): fallbackEnd is max(2500, 2000) = 2500, duration = 0
    assert.equal(result[2].durationMs, 0);
    assert.equal(result[2].endTimeMs, 2500);

    // Corrupted elements preserved safely
    assert.equal(result[3], null);
    assert.equal(result[4], undefined);
    assert.equal(result[5], 'not a span');

    // Non-array input returns empty array safely
    assert.deepEqual(closeUnclosedSpans(null), []);
    assert.deepEqual(closeUnclosedSpans(undefined), []);
    assert.deepEqual(closeUnclosedSpans({}), []);
  });

  it('1.3 Complex 3-node cycle and detached orphan nodes in buildCallTree', () => {
    // Cyclic triangle: A -> B -> C -> A
    const spanA = { spanId: 'c-A', parentSpanId: 'c-C', name: 'A', startTimeMs: 100 };
    const spanB = { spanId: 'c-B', parentSpanId: 'c-A', name: 'B', startTimeMs: 110 };
    const spanC = { spanId: 'c-C', parentSpanId: 'c-B', name: 'C', startTimeMs: 120 };

    // Valid independent root with children
    const root = { spanId: 'root-valid', parentSpanId: null, name: 'Root', startTimeMs: 50 };
    const child = { spanId: 'child-valid', parentSpanId: 'root-valid', name: 'Child', startTimeMs: 60 };

    // Orphan node with non-existent parent
    const orphan = { spanId: 'orphan-1', parentSpanId: 'ghost-parent-999', name: 'GhostChild', startTimeMs: 80 };

    const tree = buildCallTree([spanA, spanB, spanC, root, child, orphan]);

    // Roots must contain root-valid and orphan (since ghost-parent-999 is not in spanMap, orphan becomes a root)
    // The cyclic triangle (A, B, C) has all parents present in spanMap, but none has null or missing parent,
    // so none of them qualify as roots.
    const rootIds = tree.map(r => r.spanId);
    assert.ok(rootIds.includes('root-valid'));
    assert.ok(rootIds.includes('orphan-1'));
    assert.ok(!rootIds.includes('c-A'));
    assert.ok(!rootIds.includes('c-B'));
    assert.ok(!rootIds.includes('c-C'));

    // Validate root-valid has child
    const rootNode = tree.find(r => r.spanId === 'root-valid');
    assert.equal(rootNode.children.length, 1);
    assert.equal(rootNode.children[0].spanId, 'child-valid');
  });

  it('1.4 Scale stress: 1,000 spans buildCallTree and computeCriticalPath', () => {
    const spans = [];
    const spanCount = 1000;
    const baseTime = 1000000;

    // Create a 1,000-span hierarchy with multiple branches
    for (let i = 0; i < spanCount; i++) {
      const parentId = i === 0 ? null : (i % 5 === 0 ? `span-${Math.floor(i / 5)}` : `span-${i - 1}`);
      spans.push(createSpan({
        spanId: `span-${i}`,
        parentSpanId: parentId,
        name: `tool_op_${i % 10}`,
        startTimeMs: baseTime + i * 2,
        durationMs: 5
      }));
    }

    // Measure buildCallTree
    const t0 = performance.now();
    const tree = buildCallTree(spans);
    const elapsedTree = performance.now() - t0;

    assert.ok(tree.length >= 1);
    assert.ok(elapsedTree < 30, `buildCallTree for 1000 spans took ${elapsedTree.toFixed(2)}ms (target <30ms)`);

    // Measure computeCriticalPath
    const t1 = performance.now();
    const cp = computeCriticalPath(spans);
    const elapsedCp = performance.now() - t1;

    assert.ok(typeof cp === 'number');
    assert.ok(cp > 0);
    assert.ok(elapsedCp < 150, `computeCriticalPath for 1000 spans took ${elapsedCp.toFixed(2)}ms (target <150ms)`);
  });

  it('1.5 Flamegraph generation with simultaneous timestamps and duplicate frames', () => {
    const spans = [
      createSpan({ spanId: 's1', name: 'op_A', startTimeMs: 1000, durationMs: 50, endTimeMs: 1050 }),
      createSpan({ spanId: 's2', name: 'op_B', startTimeMs: 1050, durationMs: 50, endTimeMs: 1100 }),
      createSpan({ spanId: 's3', name: 'op_A', startTimeMs: 1050, durationMs: 20, endTimeMs: 1070 }) // op_A again at same time op_B opens and op_1 closes
    ];

    const flame = buildFlamegraphData(spans, { name: 'Simultaneous Flame' });
    assert.equal(flame.shared.frames.length, 2, 'Duplicate frame names op_A and op_B deduplicated');
    assert.equal(flame.profiles[0].events.length, 6);

    // At t=1050: op_A closes (type 'C'), op_B opens ('O'), op_A opens ('O'). Close must sort before Open.
    const eventsAt1050 = flame.profiles[0].events.filter(e => e.at === 1050);
    assert.equal(eventsAt1050.length, 3);
    assert.equal(eventsAt1050[0].type, 'C', 'Close event must sort before Open event at same timestamp');
  });
});

// =========================================================================
// SECTION 2: Feature 25 — Swarm & Worktree Observability Edge Cases
// =========================================================================
describe('Milestone 4 Extended Stress: Swarm & Worktree (Feature 25)', () => {
  it('2.1 Porcelain parsing with extreme paths: trailing slashes, UNC paths, and unicode emojis', () => {
    const raw = `
worktree \\\\server\\share\\repo\\\\
HEAD a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
branch refs/heads/main

worktree C:/MockWorkspace/subagent_1/🧪_test_repo///
HEAD 1111222233334444555566667777888899990000
branch refs/heads/feature/emoji-🚀

worktree /home/user/code/bare.git
bare

worktree /home/user/code/locked-worktree
HEAD feed0000feed0000feed0000feed0000feed0000
branch refs/heads/hotfix
locked
`;

    const entries = parseWorktreePorcelain(raw);
    assert.equal(entries.length, 4);

    // UNC path with trailing slashes
    assert.equal(entries[0].name, 'repo');
    assert.equal(entries[0].branch, 'main');
    assert.equal(entries[0].isMain, true);

    // Unicode path with multiple trailing slashes
    assert.equal(entries[1].name, '🧪_test_repo');
    assert.equal(entries[1].branch, 'feature/emoji-🚀');
    assert.equal(entries[1].isMain, false);

    // Bare repo
    assert.equal(entries[2].bare, true);
    assert.equal(entries[2].name, 'bare.git');

    // Locked without reason text (locked line is just "locked")
    assert.equal(entries[3].locked, true);
    assert.equal(entries[3].name, 'locked-worktree');

    // Null/undefined/empty string returns []
    assert.deepEqual(parseWorktreePorcelain(null), []);
    assert.deepEqual(parseWorktreePorcelain(''), []);
    assert.deepEqual(parseWorktreePorcelain(123), []);
  });

  it('2.2 Swarm summary with 100 workers: verifies 24-worker cap and state aggregation', () => {
    const now = Date.now();
    const subagents = {};

    for (let i = 0; i < 100; i++) {
      subagents[`worker-${i}`] = {
        agentId: `worker-${i}`,
        turns: i,
        totalTokens: i * 100,
        lastActiveAt: now - (i * 1000)
      };
    }

    const summary = computeSwarmSummary({ subagents }, { nowMs: now });
    assert.equal(summary.active, true);
    assert.equal(summary.workers.length, SWARM_LIFECYCLE_CONSTANTS.MAX_WORKERS);
    assert.equal(summary.workers.length, 24);

    // State counts reflect the capped visible roster of 24 workers
    const countSum = summary.counts.working + summary.counts.waiting + summary.counts.completed;
    assert.equal(countSum, SWARM_LIFECYCLE_CONSTANTS.MAX_WORKERS);
    assert.equal(summary.counts.total, SWARM_LIFECYCLE_CONSTANTS.MAX_WORKERS);
  });

  it('2.3 DET-20 Quota hard brake boundary conditions', () => {
    // 1. Missing or empty rate limits object -> no trigger
    assert.equal(evaluateScopeAndQuotaBrake({}).triggered, false);
    assert.equal(evaluateScopeAndQuotaBrake().triggered, false);

    // 2. 5-Hour limit exact boundary: remaining_pct = 0 -> triggers
    const brakeZero = evaluateScopeAndQuotaBrake({
      rateLimits: { fiveHour: { remaining_pct: 0 } }
    });
    assert.equal(brakeZero.triggered, true);
    assert.equal(brakeZero.decision, 'deny');

    // 3. 5-Hour limit positive: remaining_pct = 0.1 -> does NOT trigger
    const brakeSmall = evaluateScopeAndQuotaBrake({
      rateLimits: { fiveHour: { remaining_pct: 0.1 } }
    });
    assert.equal(brakeSmall.triggered, false);

    // 4. Spend limit exact match: spent == limit -> triggers
    const brakeSpendExact = evaluateScopeAndQuotaBrake({
      rateLimits: { spendLimit: { limit_usd: 100, spent_usd: 100 } }
    });
    assert.equal(brakeSpendExact.triggered, true);

    // 5. Spend limit under: spent < limit -> does NOT trigger
    const brakeSpendUnder = evaluateScopeAndQuotaBrake({
      rateLimits: { spendLimit: { limit_usd: 100, spent_usd: 99.99 } }
    });
    assert.equal(brakeSpendUnder.triggered, false);
  });
});

// =========================================================================
// SECTION 3: Feature 26 — Control State Machine Exhaustiveness & Corrupted Inputs
// =========================================================================
describe('Milestone 4 Extended Stress: Control State Machine (Feature 26)', () => {
  it('3.1 FSM transition completeness across all 5 states', () => {
    let state = createInitialControlState('fsm-full-cycle');
    assert.equal(state.state, CONTROL_STATES.RUNNING);

    // RUNNING -> PAUSED
    state = transitionControlState(state, 'pause', 'testing pause');
    assert.equal(state.state, CONTROL_STATES.PAUSED);

    // PAUSED -> STEP
    state = transitionControlState(state, 'step', 'testing step');
    assert.equal(state.state, CONTROL_STATES.STEP);
    assert.equal(state.stepRemaining, 1);
    assert.equal(state.stepCount, 1);

    // STEP -> PAUSED (consume_step)
    state = transitionControlState(state, 'consume_step');
    assert.equal(state.state, CONTROL_STATES.PAUSED);
    assert.equal(state.stepRemaining, 0);

    // PAUSED -> REWIND
    state = transitionControlState(state, 'rewind', 'testing rewind', { target: 5 });
    assert.equal(state.state, CONTROL_STATES.REWIND);
    assert.equal(state.rewindTarget, 5);

    // REWIND -> RUNNING
    state = transitionControlState(state, 'run');
    assert.equal(state.state, CONTROL_STATES.RUNNING);

    // RUNNING -> ABORTED
    state = transitionControlState(state, 'abort', 'fatal halt');
    assert.equal(state.state, CONTROL_STATES.ABORTED);

    // Terminal invariant: once ABORTED, state CANNOT change under any action
    const actions = ['pause', 'resume', 'run', 'step', 'consume_step', 'rewind', 'abort'];
    for (const act of actions) {
      const next = transitionControlState(state, act);
      assert.equal(next.state, CONTROL_STATES.ABORTED);
      assert.equal(next.reason, 'fatal halt');
    }
  });

  it('3.2 Malicious prototype pollution and corrupt JSON in parseControlFile', () => {
    // Attempt prototype pollution via JSON
    const maliciousJson = '{"sessionId": "pwn", "state": "PAUSED", "__proto__": {"polluted": true}}';
    const parsed = parseControlFile(maliciousJson);
    assert.equal(parsed.state, CONTROL_STATES.PAUSED);
    assert.equal({}.polluted, undefined, 'Prototype must not be polluted');

    // Deeply malformed JSON inputs
    assert.equal(parseControlFile('{').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('NaN').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('\x00\x01\x02').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('{"state": null}').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('{"state": 123}').reason, 'corrupted_fallback');
  });

  it('3.3 evaluateToolBoundaryLatch exhaustiveness across all states', () => {
    assert.equal(evaluateToolBoundaryLatch(null).decision, 'allow');
    assert.equal(evaluateToolBoundaryLatch({ state: CONTROL_STATES.RUNNING }).decision, 'allow');
    assert.equal(evaluateToolBoundaryLatch({ state: CONTROL_STATES.PAUSED }).decision, 'suspend');
    assert.equal(evaluateToolBoundaryLatch({ state: CONTROL_STATES.REWIND }).decision, 'suspend');
    assert.equal(evaluateToolBoundaryLatch({ state: CONTROL_STATES.ABORTED }).decision, 'deny');

    const stepLatch = evaluateToolBoundaryLatch({ state: CONTROL_STATES.STEP, stepRemaining: 1 });
    assert.equal(stepLatch.decision, 'allow');
    assert.equal(stepLatch.consumeStep, true);
    assert.equal(stepLatch.stepRemaining, 1);
  });
});

// =========================================================================
// SECTION 4: Feature 27 — COACH Mode Latches & Ring-0 Hierarchy
// =========================================================================
describe('Milestone 4 Extended Stress: COACH Mode Latches (Feature 27)', () => {
  it('4.1 Priority 1 user state strictly overrides Priority 2 and Priority 3', () => {
    // When user has PAUSED, even if detector alerts are firing, user pause produces 'suspend'
    const res = evaluateCoachLatch({
      controlState: { state: CONTROL_STATES.PAUSED, reason: 'inspecting' },
      flightMode: 'AUTO_PILOT',
      detectorVerdict: { triggered: true, detectorId: 'DET-30', reason: 'Loop' }
    });
    assert.equal(res.decision, 'suspend');
    assert.equal(res.userCommand, true);

    // When user has ABORTED, user abort produces 'deny'
    const abortRes = evaluateCoachLatch({
      controlState: { state: CONTROL_STATES.ABORTED, reason: 'manual halt' },
      flightMode: 'COACH',
      detectorVerdict: { triggered: true, detectorId: 'DET-30' }
    });
    assert.equal(abortRes.decision, 'deny');
    assert.equal(abortRes.userCommand, true);
  });

  it('4.2 Ring-0 security hard blocks regardless of flight mode or detector triggering', () => {
    // Mode OFF: normally ignores detector findings, but Ring-0 MUST block
    const offRing0 = evaluateCoachLatch({
      controlState: { state: CONTROL_STATES.RUNNING },
      flightMode: 'OFF',
      isSecurityRing0: true
    });
    assert.equal(offRing0.decision, 'deny');
    assert.equal(offRing0.blocked, true);

    // Mode SILENT: normally ignores detector findings, but detectorVerdict.isSecurityRing0 MUST block
    const silentRing0 = evaluateCoachLatch({
      controlState: { state: CONTROL_STATES.RUNNING },
      flightMode: 'SILENT',
      detectorVerdict: { isSecurityRing0: true, detectorId: 'RING_0_SANDBOX', reason: 'Sandbox escape attempt' }
    });
    assert.equal(silentRing0.decision, 'deny');
    assert.equal(silentRing0.blocked, true);
    assert.equal(silentRing0.detectorId, 'RING_0_SANDBOX');
  });

  it('4.3 HUD Coach pill formatting edge cases', () => {
    // Malformed objects
    assert.equal(renderCoachPill({ flightMode: null }), '[COACH]');
    assert.equal(renderCoachPill({ flightMode: '  off  ' }), '[OFF]');
    assert.equal(renderCoachPill({ flightMode: 'auto_pilot' }), '[AUTO_PILOT]');

    // Detector verdict without triggered=true
    assert.equal(
      renderCoachPill({
        flightMode: 'COACH',
        detectorVerdict: { triggered: false, detectorId: 'DET-12' }
      }),
      '[COACH]'
    );
  });
});

// =========================================================================
// SECTION 5: Feature 28 — Tool Boundary Suspension & Spread Order Defect Guard
// =========================================================================
describe('Milestone 4 Extended Stress: Tool Suspension & Mod Law 5 (Feature 28)', () => {
  it('5.1 Pre-aborted signal resolves immediately without waiting', async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted before call

    const t0 = performance.now();
    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => ({ state: CONTROL_STATES.PAUSED }),
      pollIntervalMs: 50,
      timeoutMs: 5000,
      signal: controller.signal
    });
    const elapsed = performance.now() - t0;

    assert.ok(elapsed < 15, `Pre-aborted signal should resolve instantly, took ${elapsed.toFixed(2)}ms`);
    assert.equal(outcome.resumed, false);
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.decision, 'deny');
  });

  it('5.2 Throw inside checkControlStateFn resolves fail-closed deny without crashing', async () => {
    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => {
        throw new Error('Disk read fault while reading .ctl file');
      },
      pollIntervalMs: 10,
      timeoutMs: 1000
    });

    assert.equal(outcome.resumed, false);
    assert.equal(outcome.error, true);
    assert.equal(outcome.decision, 'deny');
    assert.ok(outcome.reason.includes('Disk read fault'));
  });

  it('5.3 Transition from PAUSED to STEP in waitForSuspensionResume returns allow with consumeStep', async () => {
    let currentState = { state: CONTROL_STATES.PAUSED };

    setTimeout(() => {
      currentState = { state: CONTROL_STATES.STEP, stepRemaining: 1, reason: 'Single stepping' };
    }, 20);

    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => currentState,
      pollIntervalMs: 5,
      timeoutMs: 1000
    });

    assert.equal(outcome.resumed, true);
    assert.equal(outcome.decision, 'allow');
    assert.equal(outcome.consumeStep, true);
    assert.equal(outcome.state, CONTROL_STATES.STEP);
    assert.equal(outcome.reason, 'Single stepping');
  });

  it('5.4 SPREAD ORDER DEFECT GUARD: toProtoSafePreHookOutput strictly overrides decision', () => {
    // If someone returns an object where decision is 'block' or 'reject',
    // toProtoSafePreHookOutput must return an object where decision is 'deny'.
    // Spread order { ...output, decision } guarantees this.
    const trickyOutputs = [
      { decision: 'block', reason: 'blocked by policy' },
      { decision: 'reject', reason: 'rejected by admin' },
      { decision: 'deny', reason: 'denied' },
      { permissionDecision: 'deny', reason: 'denied via permission' }
    ];

    for (const tricky of trickyOutputs) {
      const normalized = toProtoSafePreHookOutput(tricky);
      assert.equal(
        normalized.decision,
        'deny',
        `Decision "${tricky.decision || tricky.permissionDecision}" must normalize to "deny"`
      );
      assert.equal(normalized.reason, tricky.reason);
    }

    // Ask/defer normalization
    assert.equal(toProtoSafePreHookOutput({ decision: 'ask' }).decision, 'ask');
    assert.equal(toProtoSafePreHookOutput({ decision: 'defer' }).decision, 'ask');

    // Suspend normalization
    assert.equal(toProtoSafePreHookOutput({ decision: 'suspend' }).decision, 'suspend');

    // Unknown decision normalizes to allow
    assert.equal(toProtoSafePreHookOutput({ decision: 'custom_ok' }).decision, 'allow');
  });

  it('5.5 wrapSafeToolBoundary Mod Law 5 crash resistance on throwing functions', async () => {
    // 1. Synchronous throw
    const syncThrowRes = await wrapSafeToolBoundary(() => {
      throw new Error('Synchronous crash');
    });
    assert.equal(syncThrowRes.decision, 'deny');
    assert.ok(syncThrowRes.reason.includes('Fail-Closed'));
    assert.ok(syncThrowRes.reason.includes('Synchronous crash'));

    // 2. Asynchronous rejection
    const asyncRejectRes = await wrapSafeToolBoundary(async () => {
      await Promise.resolve();
      throw new TypeError('Asynchronous rejection');
    });
    assert.equal(asyncRejectRes.decision, 'deny');
    assert.ok(asyncRejectRes.reason.includes('Fail-Closed'));
    assert.ok(asyncRejectRes.reason.includes('Asynchronous rejection'));

    // 3. Normal return with 'block' decision
    const normalBlock = await wrapSafeToolBoundary(async () => ({
      decision: 'block',
      reason: 'security block'
    }));
    assert.equal(normalBlock.decision, 'deny');
    assert.equal(normalBlock.reason, 'security block');
  });
});
