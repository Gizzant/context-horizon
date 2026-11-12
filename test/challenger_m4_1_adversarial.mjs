/**
 * @file test/challenger_m4_1_adversarial.mjs
 * Milestone 4 Adversarial Stress Test Suite:
 * Empirical adversarial stress testing of Call-Tree Spans & USTF v1 (Feature 24),
 * Swarm Roster Concurrency & DET-20 Scope Collisions (Feature 25),
 * Control State Machine Race Conditions & Hard Invariants (Feature 26),
 * COACH Mode vs AUTO_PILOT Trigger Matrix (Feature 27), and
 * Atomic Tool-Boundary Suspension (Feature 28).
 *
 * Authored by: challenger_m4_it1_1 (Role: Milestone 4 Challenger 1)
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
  validateUstfSpan,
  validateUstfEvent,
  validateUstfTrajectory,
  USTF_SPAN_KINDS
} from '../src/core-isomorphic/ustf/schema.mjs';

import {
  parseWorktreePorcelain,
  extractAgentLocation,
  applySubagentLifecycle,
  computeSwarmSummary,
  formatSwarmCompact,
  toCostRadarTopology,
  SWARM_LIFECYCLE_CONSTANTS,
  acquireScopeLock,
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

// Verify barrel export completeness
import * as ControlBarrel from '../src/core-isomorphic/control/index.mjs';

// =========================================================================
// SECTION 0: Control Barrel Completeness Invariant
// =========================================================================
describe('Milestone 4: Barrel Export Completeness & Mod Safety', () => {
  it('0.1 All Milestone 4 core control APIs are exported from unified barrel', () => {
    const requiredExports = [
      'createSpan', 'endSpan', 'closeUnclosedSpans', 'buildCallTree',
      'computeCriticalPath', 'renderCallTree', 'buildFlamegraphData',
      'parseWorktreePorcelain', 'extractAgentLocation', 'applySubagentLifecycle',
      'computeSwarmSummary', 'formatSwarmCompact', 'toCostRadarTopology',
      'SWARM_LIFECYCLE_CONSTANTS', 'acquireScopeLock', 'evaluateScopeAndQuotaBrake',
      'matchesScopePattern', 'CONTROL_STATES', 'createInitialControlState',
      'transitionControlState', 'parseControlFile', 'serializeControlFile',
      'evaluateToolBoundaryLatch', 'evaluateCoachLatch', 'renderCoachPill',
      'SUSPENSION_CONSTANTS', 'waitForSuspensionResume', 'toProtoSafePreHookOutput',
      'wrapSafeToolBoundary'
    ];

    for (const name of requiredExports) {
      assert.ok(
        name in ControlBarrel,
        `Expected export "${name}" to be present in src/core-isomorphic/control/index.mjs`
      );
    }
  });
});

// =========================================================================
// SECTION 1: Call-Tree & USTF v1 Deep Recursion & Anomalous Lifecycle (Feature 24)
// =========================================================================
describe('Milestone 4 Adversarial Suite 1: Call-Tree & USTF v1 Spans', () => {
  it('1.1 Deep Recursion (100 levels): builds tree, renders ASCII, computes critical path & flamegraph', () => {
    const depth = 100;
    const spans = [];
    let prevId = null;

    for (let i = 0; i < depth; i++) {
      const id = `span-deep-${i}`;
      spans.push(createSpan({
        spanId: id,
        parentSpanId: prevId,
        kind: 'tool',
        name: `nested_op_level_${i}`,
        startTimeMs: 1000 + i * 10,
        durationMs: 10,
        status: 'ok'
      }));
      prevId = id;
    }

    // 1. USTF v1 conformance for all 100 spans
    for (const s of spans) {
      const check = validateUstfSpan(s);
      assert.equal(check.valid, true, `Span ${s.spanId} failed USTF validation: ${check.errors?.join(', ')}`);
    }

    // 2. Tree assembly
    const tree = buildCallTree(spans);
    assert.equal(tree.length, 1, 'Root tree must have exactly 1 root');

    // Walk depth to confirm 100 levels
    let current = tree[0];
    let measuredDepth = 1;
    while (current.children && current.children.length > 0) {
      assert.equal(current.children.length, 1);
      current = current.children[0];
      measuredDepth++;
    }
    assert.equal(measuredDepth, depth, `Expected tree depth to be ${depth}, got ${measuredDepth}`);

    // 3. ASCII rendering without stack overflow
    const rendered = renderCallTree(tree);
    assert.ok(rendered.length > 0);
    assert.ok(rendered.includes('nested_op_level_0'));
    assert.ok(rendered.includes(`nested_op_level_${depth - 1}`));

    // 4. Critical path computation across sequential chain
    const criticalPath = computeCriticalPath(spans);
    assert.equal(criticalPath, depth * 10, 'Sequential critical path must equal sum of durations');

    // 5. Flamegraph data construction
    const flame = buildFlamegraphData(spans);
    assert.equal(flame.shared.frames.length, depth);
    assert.equal(flame.profiles[0].events.length, depth * 2);
    assert.equal(flame.profiles[0].startValue, 1000);
    assert.equal(flame.profiles[0].endValue, 1000 + depth * 10);
  });

  it('1.2 Extreme Deep Recursion (300 levels): iterative DFS prevents RangeError call stack overflow', () => {
    const depth = 300;
    const spans = [];
    let prevId = null;

    for (let i = 0; i < depth; i++) {
      const id = `span-xdeep-${i}`;
      spans.push({
        spanId: id,
        parentSpanId: prevId,
        kind: 'tool',
        name: `func_${i}`,
        startTimeMs: i * 5,
        durationMs: 5,
        status: 'ok'
      });
      prevId = id;
    }

    // Must not throw RangeError: Maximum call stack size exceeded
    const tree = buildCallTree(spans);
    assert.equal(tree.length, 1);

    const rendered = renderCallTree(tree);
    assert.ok(rendered.includes('func_0'));
    assert.ok(rendered.includes(`func_${depth - 1}`));
  });

  it('1.3 Out-of-order span closures: child spans ending before/after parent handled accurately', () => {
    const parent = createSpan({
      spanId: 'span-p',
      parentSpanId: null,
      kind: 'agent',
      name: 'parent_agent',
      startTimeMs: 1000
    });

    const childEarly = createSpan({
      spanId: 'span-c1',
      parentSpanId: 'span-p',
      kind: 'tool',
      name: 'child_early_exit',
      startTimeMs: 1010
    });

    const childLate = createSpan({
      spanId: 'span-c2',
      parentSpanId: 'span-p',
      kind: 'tool',
      name: 'child_late_running',
      startTimeMs: 1020
    });

    // Child 1 closes early (at t=1030) before parent or child 2
    endSpan(childEarly, { endTimeMs: 1030, status: 'ok' });
    assert.equal(childEarly.durationMs, 20);

    // Parent closes at t=1080
    endSpan(parent, { endTimeMs: 1080, status: 'ok' });
    assert.equal(parent.durationMs, 80);

    // Child 2 closes LATE at t=1120 (after parent already closed)
    endSpan(childLate, { endTimeMs: 1120, status: 'ok' });
    assert.equal(childLate.durationMs, 100);

    // USTF conformance of out-of-order spans
    assert.equal(validateUstfSpan(parent).valid, true);
    assert.equal(validateUstfSpan(childEarly).valid, true);
    assert.equal(validateUstfSpan(childLate).valid, true);

    // Tree assembly handles out-of-order closures cleanly
    const tree = buildCallTree([childLate, parent, childEarly]); // Reverse input order
    assert.equal(tree.length, 1);
    assert.equal(tree[0].spanId, 'span-p');
    assert.equal(tree[0].children.length, 2);
  });

  it('1.4 Auto-closure of unclosed spans on turn completion with closeUnclosedSpans', () => {
    const spans = [
      createSpan({ spanId: 's1', name: 'tool_1', startTimeMs: 1000, durationMs: 50, endTimeMs: 1050 }),
      createSpan({ spanId: 's2', name: 'tool_2', startTimeMs: 1060 }), // unclosed (durationMs = null)
      createSpan({ spanId: 's3', name: 'tool_3', startTimeMs: 1070 }), // unclosed (durationMs = null)
      createSpan({ spanId: 's4', name: 'tool_4', startTimeMs: 1100, durationMs: 20, endTimeMs: 1120 })
    ];

    assert.equal(spans[1].durationMs, null);
    assert.equal(spans[2].durationMs, null);

    const closed = closeUnclosedSpans(spans, { endTimeMs: 1200, status: 'ok' });

    assert.equal(closed[0].durationMs, 50, 'Already-closed span duration preserved');
    assert.equal(closed[1].durationMs, 140, 's2 auto-closed duration calculated: 1200 - 1060');
    assert.equal(closed[1].endTimeMs, 1200);
    assert.equal(closed[2].durationMs, 130, 's3 auto-closed duration calculated: 1200 - 1070');
    assert.equal(closed[2].endTimeMs, 1200);
    assert.equal(closed[3].durationMs, 20, 'Already-closed span duration preserved');

    // Idempotent: running closeUnclosedSpans again does not corrupt durations
    const reclosed = closeUnclosedSpans(closed, { endTimeMs: 1500 });
    assert.equal(reclosed[1].durationMs, 140);
  });

  it('1.5 Zero, sub-millisecond, and negative durations: clamped safely and validated', () => {
    // 1. Zero duration span
    const zeroSpan = createSpan({
      spanId: 's-zero',
      kind: 'tool',
      name: 'instant_check',
      startTimeMs: 1000,
      durationMs: 0
    });
    assert.equal(zeroSpan.durationMs, 0);
    assert.equal(validateUstfSpan(zeroSpan).valid, true);

    // 2. Sub-millisecond duration
    const subMsSpan = createSpan({
      spanId: 's-subms',
      kind: 'hook',
      name: 'micro_ipc_ping',
      startTimeMs: 1000,
      durationMs: 0.08
    });
    assert.equal(subMsSpan.durationMs, 0.08);
    assert.equal(validateUstfSpan(subMsSpan).valid, true);

    // 3. Negative duration in endSpan is clamped to 0
    const spanNeg = createSpan({ spanId: 's-neg', startTimeMs: 2000 });
    endSpan(spanNeg, { durationMs: -50 });
    assert.equal(spanNeg.durationMs, 0, 'endSpan must clamp negative duration to 0');

    // 4. Inverted timestamps (endTime < startTime) clamped to 0
    const spanInvert = createSpan({ spanId: 's-inv', startTimeMs: 2000 });
    endSpan(spanInvert, { endTimeMs: 1900 });
    assert.equal(spanInvert.durationMs, 0, 'endSpan must clamp duration to 0 when end < start');

    // 5. Negative duration in raw span is flagged by USTF validator
    const rawNegativeSpan = {
      spanId: 's-raw-neg',
      kind: 'tool',
      name: 'bad_span',
      startTimeMs: 1000,
      durationMs: -15
    };
    const negCheck = validateUstfSpan(rawNegativeSpan);
    assert.equal(negCheck.valid, false);
    assert.ok(negCheck.errors.some(e => e.includes('non-negative')));
  });

  it('1.6 Corrupted timestamp inputs & computeCriticalPath robustness', () => {
    // Empty inputs
    assert.equal(computeCriticalPath([]), 0);
    assert.equal(computeCriticalPath(null), 0);
    assert.equal(computeCriticalPath(undefined), 0);

    // Corrupted span entries
    const messySpans = [
      null,
      undefined,
      'not a span',
      { spanId: 's-nan', startTimeMs: NaN, durationMs: 10 },
      { spanId: 's-neg-start', startTimeMs: -50, durationMs: 20 },
      { spanId: 's-ok', startTimeMs: 1000, durationMs: 30 }
    ];

    // Must not crash and must compute a finite number
    const cp = computeCriticalPath(messySpans);
    assert.equal(typeof cp, 'number');
    assert.ok(Number.isFinite(cp));

    // Flamegraph with empty spans
    const emptyFlame = buildFlamegraphData([]);
    assert.deepEqual(emptyFlame.shared.frames, []);
    assert.deepEqual(emptyFlame.profiles, []);
  });

  it('1.7 Cyclical span references: buildCallTree avoids cycles and infinite loops', () => {
    // Span A lists B as parent, Span B lists A as parent
    const spanA = { spanId: 'cycle-A', parentSpanId: 'cycle-B', name: 'A', startTimeMs: 1000, durationMs: 10 };
    const spanB = { spanId: 'cycle-B', parentSpanId: 'cycle-A', name: 'B', startTimeMs: 1010, durationMs: 10 };

    const roots = buildCallTree([spanA, spanB]);
    // Neither A nor B has null or missing parent, so neither is a root
    assert.deepEqual(roots, [], 'Cyclic components without an external root must yield empty roots');

    // Self-cycle (A -> A)
    const selfCycle = { spanId: 'self-1', parentSpanId: 'self-1', name: 'self', startTimeMs: 1000, durationMs: 5 };
    const selfRoots = buildCallTree([selfCycle]);
    assert.deepEqual(selfRoots, []);
  });

  it('1.8 USTF v1 span schema negative validation matrix', () => {
    // Missing spanId
    assert.equal(validateUstfSpan({ kind: 'tool', name: 'op', startTimeMs: 100 }).valid, false);

    // Invalid kind
    assert.equal(validateUstfSpan({ spanId: 's', kind: 'database_query', name: 'op', startTimeMs: 100 }).valid, false);

    // Non-string name
    assert.equal(validateUstfSpan({ spanId: 's', kind: 'tool', name: 12345, startTimeMs: 100 }).valid, false);

    // Negative startTimeMs
    assert.equal(validateUstfSpan({ spanId: 's', kind: 'tool', name: 'op', startTimeMs: -1 }).valid, false);

    // Invalid status
    assert.equal(validateUstfSpan({ spanId: 's', kind: 'tool', name: 'op', startTimeMs: 100, status: 'crashed' }).valid, false);

    // Valid statuses: 'ok', 'error', 'aborted'
    for (const status of ['ok', 'error', 'aborted']) {
      assert.equal(validateUstfSpan({ spanId: 's', kind: 'tool', name: 'op', startTimeMs: 100, status }).valid, true);
    }
  });

  it('1.9 Defect Resolved: renderCallTree safely handles sparse/null turns without TypeError', () => {
    // Verified: does not throw on null turn
    const out1 = renderCallTree({ sessionId: 's1', turns: [null] });
    assert.ok(typeof out1 === 'string');
    assert.ok(out1.includes('Session: s1'));

    // Verified: does not throw on null toolSpan
    const out2 = renderCallTree({ sessionId: 's1', turns: [{ toolSpans: [null] }] });
    assert.ok(typeof out2 === 'string');
    assert.ok(out2.includes('Session: s1'));
  });

  it('1.10 Defect Resolved: closeUnclosedSpans handles undefined durationMs / endTimeMs', () => {
    // Verified: raw span with undefined durationMs is correctly auto-closed
    const rawSpan = { spanId: 's-undef', startTimeMs: 1000 };
    closeUnclosedSpans([rawSpan], { endTimeMs: 1500 });
    assert.equal(rawSpan.durationMs, 500, 'closeUnclosedSpans auto-closed undefined durationMs: 1500 - 1000');
    assert.equal(rawSpan.endTimeMs, 1500);
  });
});

// =========================================================================
// SECTION 2: Swarm Roster Concurrency, Stalls, Dead Workers & DET-20 (Feature 25)
// =========================================================================
describe('Milestone 4 Adversarial Suite 2: Swarm Roster & DET-20 Scope Locks', () => {
  it('2.1 High Concurrency Swarm Tracking: 64 concurrent subagents processed < 10ms with accurate sorting', () => {
    const subagents = {};
    const now = Date.now();

    for (let i = 0; i < 64; i++) {
      subagents[`worker-${i}`] = {
        agentId: `worker-${i}`,
        turns: i + 1,
        totalTokens: (i + 1) * 750,
        lastActiveAt: now - (i * 500), // all active within last 32 seconds
        model: i % 2 === 0 ? 'claude-3-7-sonnet' : 'claude-3-5-haiku',
        worktree: `C:/Projects/wt-${i % 4}`,
        branch: `feature-${i % 4}`
      };
    }

    const t0 = performance.now();
    const summary = computeSwarmSummary({ subagents }, { nowMs: now });
    const elapsed = performance.now() - t0;

    assert.ok(elapsed < 10, `Swarm summary of 64 workers took ${elapsed.toFixed(2)}ms (target <10ms)`);
    assert.equal(summary.active, true);
    assert.equal(summary.counts.total, SWARM_LIFECYCLE_CONSTANTS.MAX_WORKERS, 'Must cap visible workers at 24');

    // Verify sort order: sorted by totalTokens descending among same lifecycle
    for (let j = 1; j < summary.workers.length; j++) {
      const prev = summary.workers[j - 1];
      const curr = summary.workers[j];
      if (prev.state === curr.state) {
        assert.ok(
          prev.totalTokens >= curr.totalTokens,
          `Expected descending tokens: ${prev.totalTokens} >= ${curr.totalTokens}`
        );
      }
    }
  });

  it('2.2 Stalled workers (>60s inactivity) transition to waiting with exact idleSec', () => {
    const now = Date.now();
    const subagents = {
      'worker-active': {
        agentId: 'worker-active',
        lastActiveAt: now - 5000, // 5s ago
        turns: 10,
        totalTokens: 2000
      },
      'worker-stalled-65s': {
        agentId: 'worker-stalled-65s',
        lastActiveAt: now - 65000, // 65s ago (>30s window)
        turns: 4,
        totalTokens: 1500
      },
      'worker-stalled-120s': {
        agentId: 'worker-stalled-120s',
        lastActiveAt: now - 120000, // 120s ago
        turns: 2,
        totalTokens: 500
      }
    };

    const summary = computeSwarmSummary({ subagents }, { nowMs: now });

    assert.equal(summary.counts.working, 1);
    assert.equal(summary.counts.waiting, 2);

    const w65 = summary.workers.find(w => w.agentId === 'worker-stalled-65s');
    assert.equal(w65.state, 'waiting');
    assert.equal(w65.idleSec, 65);

    const w120 = summary.workers.find(w => w.agentId === 'worker-stalled-120s');
    assert.equal(w120.state, 'waiting');
    assert.equal(w120.idleSec, 120);

    // In-flight turn override: if turn is in-flight, worker remains 'working' despite inactive timestamp
    const summaryInFlight = computeSwarmSummary({
      subagents,
      subagentInFlightTurns: { 'worker-stalled-65s': true }
    }, { nowMs: now });

    const w65InFlight = summaryInFlight.workers.find(w => w.agentId === 'worker-stalled-65s');
    assert.equal(w65InFlight.state, 'working', 'In-flight turn must force working state');
  });

  it('2.3 Dead workers (SIGKILL / >1h inactive) and topology mapping', () => {
    const now = Date.now();
    const subagents = {
      'worker-live': {
        agentId: 'worker-live',
        lastActiveAt: now - 1000,
        turns: 5,
        totalTokens: 3000
      },
      'worker-dead-1h': {
        agentId: 'worker-dead-1h',
        lastActiveAt: now - 3600000, // 1 hour ago
        turns: 1,
        totalTokens: 200
      },
      'worker-completed': {
        agentId: 'worker-completed',
        lastActiveAt: now - 10000,
        completedAt: now - 10000,
        turns: 3,
        totalTokens: 1000
      }
    };

    const summary = computeSwarmSummary({ subagents }, { nowMs: now });
    assert.equal(summary.counts.working, 1);
    assert.equal(summary.counts.waiting, 1);
    assert.equal(summary.counts.completed, 1);

    // Cost radar topology mapping
    const topology = toCostRadarTopology(summary);
    assert.ok(topology);
    assert.equal(topology.workers.length, 3);

    const topLive = topology.workers.find(w => w.name === 'worker-live');
    assert.equal(topLive.state, 'working');
    assert.equal(topLive.parked, false);

    const topDead = topology.workers.find(w => w.name === 'worker-dead-1h');
    assert.equal(topDead.state, 'waiting');
    assert.equal(topDead.parked, true);

    const topDone = topology.workers.find(w => w.name === 'worker-completed');
    assert.equal(topDone.state, 'killed', 'Completed workers mapped to killed in cost radar');

    // Compact token
    assert.equal(formatSwarmCompact(summary), 'Swarm 2W'); // 1 working + 1 waiting = 2 live
  });

  it('2.4 DET-20 Scope Collisions and 5-Hour / Spend Quota Hard Brakes', () => {
    // 1. Quota 5-Hour Exhausted Brake
    const brake5h = evaluateScopeAndQuotaBrake({
      rateLimits: {
        fiveHour: { remaining_pct: 0, limit: 100, used: 100 }
      }
    });
    assert.equal(brake5h.triggered, true);
    assert.equal(brake5h.detectorId, 'DET-20');
    assert.equal(brake5h.decision, 'deny');
    assert.equal(brake5h.subType, 'QUOTA_FIVE_HOUR_EXHAUSTED');

    // 2. Spend Limit Exhausted Brake
    const brakeSpend = evaluateScopeAndQuotaBrake({
      rateLimits: {
        spendLimit: { limit_usd: 50, spent_usd: 50 }
      }
    });
    assert.equal(brakeSpend.triggered, true);
    assert.equal(brakeSpend.detectorId, 'DET-20');
    assert.equal(brakeSpend.decision, 'deny');
    assert.equal(brakeSpend.subType, 'QUOTA_SPEND_LIMIT_EXHAUSTED');

    // 3. Dotfile Scope Matching
    assert.equal(matchesScopePattern('.github/workflows/ci.yml', '.github/*'), true);
    assert.equal(matchesScopePattern('.claude/settings.json', '.claude/**'), true);
    assert.equal(matchesScopePattern('src/core/callTree.mjs', 'src/**'), true);
    assert.equal(matchesScopePattern('test/foo.test.mjs', 'src/**'), false);
  });

  it('2.5 Porcelain worktree parsing: spaces, unicode, bare repos, and locked worktrees', () => {
    const rawPorcelain = `
worktree C:\\Projects\\ga visualizer v2\\main_repo
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/main

worktree C:/Worktrees/projeto_núcleo_⚡/sub-agent-1
HEAD abcdef1234567890abcdef1234567890abcdef12
branch refs/heads/feature/unicode-support

worktree /tmp/isolated-worktree
HEAD feedbeeffeedbeeffeedbeeffeedbeeffeedbeef
detached

worktree C:\\Locked\\wt-locked
HEAD 9876543210fedcba9876543210fedcba98765432
branch refs/heads/fix-bug
locked Maintenance in progress

worktree C:\\BareRepo
bare
`;

    const entries = parseWorktreePorcelain(rawPorcelain);
    assert.equal(entries.length, 5);

    // 1. Main repo with spaces
    assert.equal(entries[0].name, 'main_repo');
    assert.equal(entries[0].branch, 'main');
    assert.equal(entries[0].isMain, true);

    // 2. Unicode and forward slashes
    assert.equal(entries[1].name, 'sub-agent-1');
    assert.equal(entries[1].branch, 'feature/unicode-support');
    assert.ok(entries[1].worktree.includes('projeto_núcleo_⚡'));
    assert.equal(entries[1].isMain, false);

    // 3. Detached HEAD
    assert.equal(entries[2].name, 'isolated-worktree');
    assert.equal(entries[2].detached, true);
    assert.equal(entries[2].branch, null);

    // 4. Locked worktree with reason
    assert.equal(entries[3].name, 'wt-locked');
    assert.equal(entries[3].locked, 'Maintenance in progress');

    // 5. Bare repository
    assert.equal(entries[4].name, 'BareRepo');
    assert.equal(entries[4].bare, true);
  });
});

// =========================================================================
// SECTION 3: Control State Machine Race Conditions & Hard Invariants (Feature 26)
// =========================================================================
describe('Milestone 4 Adversarial Suite 3: Control State Machine Race Conditions', () => {
  it('3.1 Rapid-fire transitions (100 transitions in 50ms): thread-safe and deterministic', () => {
    let state = createInitialControlState('session-rapid');
    assert.equal(state.state, CONTROL_STATES.RUNNING);

    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const action = i % 4 === 0 ? 'pause' : (i % 4 === 1 ? 'step' : (i % 4 === 2 ? 'consume_step' : 'resume'));
      state = transitionControlState(state, action, `Transition ${i}`);
    }
    const elapsed = performance.now() - t0;

    assert.ok(elapsed < 50, `100 transitions took ${elapsed.toFixed(2)}ms (target <50ms)`);
    assert.equal(state.state, CONTROL_STATES.RUNNING);
    assert.equal(state.reason, 'Transition 99');
    assert.equal(state.stepCount, 25, 'Expected exactly 25 step transitions');
  });

  it('3.2 Corrupted, empty, and adversarial .ctl file parsing safely falls back without throwing', () => {
    // 1. Empty string
    const emptyRes = parseControlFile('', 'test-sess');
    assert.equal(emptyRes.state, CONTROL_STATES.RUNNING);
    assert.equal(emptyRes.reason, 'missing_fallback');

    // 2. Whitespace only
    const wsRes = parseControlFile('   \n\r\t  ', 'test-sess');
    assert.equal(wsRes.state, CONTROL_STATES.RUNNING);
    assert.equal(wsRes.reason, 'missing_fallback');

    // 3. Syntax error JSON
    const synRes = parseControlFile('{ "state": "PAU...', 'test-sess');
    assert.equal(synRes.state, CONTROL_STATES.RUNNING);
    assert.equal(synRes.reason, 'corrupted_fallback');

    // 4. JSON non-object primitives
    assert.equal(parseControlFile('"just a string"').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('12345').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('true').reason, 'corrupted_fallback');
    assert.equal(parseControlFile('[1, 2, 3]').reason, 'corrupted_fallback');

    // 5. Unknown state string
    const unkRes = parseControlFile(JSON.stringify({ state: 'SUPER_STOPPED' }));
    assert.equal(unkRes.state, CONTROL_STATES.RUNNING);
    assert.equal(unkRes.reason, 'corrupted_fallback');

    // 6. Non-string inputs (null, undefined, numbers)
    assert.equal(parseControlFile(null).reason, 'missing_fallback');
    assert.equal(parseControlFile(undefined).reason, 'missing_fallback');
    assert.equal(parseControlFile(42).reason, 'missing_fallback');
  });

  it('3.3 Irreversible ABORTED terminal state enforcement', () => {
    let state = createInitialControlState('session-abort-term');
    state = transitionControlState(state, 'abort', 'Critical user cancellation');
    assert.equal(state.state, CONTROL_STATES.ABORTED);
    assert.equal(state.reason, 'Critical user cancellation');

    // Attempt all transitions: ALL MUST BE REJECTED
    const attemptedTransitions = ['resume', 'run', 'pause', 'step', 'consume_step', 'rewind'];
    for (const action of attemptedTransitions) {
      const next = transitionControlState(state, action, `Attempt ${action}`);
      assert.equal(next.state, CONTROL_STATES.ABORTED, `Action "${action}" must NOT exit ABORTED state`);
      assert.equal(next.reason, 'Critical user cancellation', 'Original abort reason preserved');
    }

    // Tool boundary latch evaluation strictly denies
    const latch = evaluateToolBoundaryLatch(state);
    assert.equal(latch.decision, 'deny');
    assert.ok(latch.reason.includes('cancellation'));
  });

  it('3.4 Single-step execution latch consumption lifecycle', () => {
    let state = createInitialControlState('session-step');

    // 1. Transition to STEP
    state = transitionControlState(state, 'step', 'Debug single step');
    assert.equal(state.state, CONTROL_STATES.STEP);
    assert.equal(state.stepRemaining, 1);
    assert.equal(state.stepCount, 1);

    // 2. Evaluate latch: allows exactly one invocation with consumeStep flag
    const stepLatch = evaluateToolBoundaryLatch(state);
    assert.equal(stepLatch.decision, 'allow');
    assert.equal(stepLatch.consumeStep, true);
    assert.equal(stepLatch.stepRemaining, 1);

    // 3. Consume step: transitions immediately back to PAUSED
    state = transitionControlState(state, 'consume_step');
    assert.equal(state.state, CONTROL_STATES.PAUSED);
    assert.equal(state.stepRemaining, 0);

    // 4. Subsequent tool calls now suspend
    const pausedLatch = evaluateToolBoundaryLatch(state);
    assert.equal(pausedLatch.decision, 'suspend');

    // 5. Subsequent step increments stepCount
    state = transitionControlState(state, 'step');
    assert.equal(state.stepCount, 2);
    assert.equal(state.state, CONTROL_STATES.STEP);
  });

  it('3.5 Serialization and deserialization roundtrip fidelity', () => {
    const original = {
      sessionId: 'sess-roundtrip-42',
      state: CONTROL_STATES.PAUSED,
      stepCount: 7,
      stepRemaining: 0,
      rewindTarget: 3,
      reason: 'Human paused mid-execution',
      updatedAt: 1731369600000
    };

    const serialized = serializeControlFile(original);
    assert.ok(serialized.endsWith('\n'), 'Serialized control file must end with newline');

    const parsed = parseControlFile(serialized);
    assert.deepEqual(parsed, original);
  });
});

// =========================================================================
// SECTION 4: COACH Mode vs AUTO_PILOT Mode Trigger Matrix (Feature 27)
// =========================================================================
describe('Milestone 4 Adversarial Suite 4: COACH Mode vs AUTO_PILOT Trigger Matrix', () => {
  it('4.1 User control state strictly overrides autonomous detector alerts in all modes', () => {
    const detectorAlert = {
      triggered: true,
      detectorId: 'DET-30',
      reason: 'Infinite scratchpad loop detected'
    };

    // Case A: User has PAUSED execution
    const pausedState = {
      state: CONTROL_STATES.PAUSED,
      reason: 'User inspecting memory'
    };

    // In COACH mode: user pause takes precedence -> suspend
    const coachPaused = evaluateCoachLatch({
      controlState: pausedState,
      flightMode: 'COACH',
      detectorVerdict: detectorAlert
    });
    assert.equal(coachPaused.decision, 'suspend');
    assert.equal(coachPaused.userCommand, true);
    assert.equal(coachPaused.reason, 'User inspecting memory');

    // In AUTO_PILOT mode: user pause ALSO takes precedence -> suspend
    const autoPaused = evaluateCoachLatch({
      controlState: pausedState,
      flightMode: 'AUTO_PILOT',
      detectorVerdict: detectorAlert
    });
    assert.equal(autoPaused.decision, 'suspend');
    assert.equal(autoPaused.userCommand, true);

    // Case B: User has ABORTED execution
    const abortedState = {
      state: CONTROL_STATES.ABORTED,
      reason: 'Manual kill'
    };
    const coachAborted = evaluateCoachLatch({
      controlState: abortedState,
      flightMode: 'COACH',
      detectorVerdict: detectorAlert
    });
    assert.equal(coachAborted.decision, 'deny');
    assert.equal(coachAborted.userCommand, true);
  });

  it('4.2 Security Ring-0 invariant hard blocks across all flight modes even when running', () => {
    const runningState = { state: CONTROL_STATES.RUNNING };

    // Ring-0 via parameter flag
    for (const mode of ['COACH', 'AUTO_PILOT', 'SILENT', 'OFF']) {
      const decision = evaluateCoachLatch({
        controlState: runningState,
        flightMode: mode,
        isSecurityRing0: true
      });
      assert.equal(decision.decision, 'deny', `Ring-0 must deny in mode ${mode}`);
      assert.equal(decision.blocked, true);
    }

    // Ring-0 via detector verdict
    const ring0Verdict = {
      triggered: true,
      detectorId: 'RING_0_AIRLOCK',
      isSecurityRing0: true,
      reason: 'PII leak prevented'
    };
    const ring0Res = evaluateCoachLatch({
      controlState: runningState,
      flightMode: 'COACH',
      detectorVerdict: ring0Verdict
    });
    assert.equal(ring0Res.decision, 'deny');
    assert.equal(ring0Res.blocked, true);
    assert.equal(ring0Res.detectorId, 'RING_0_AIRLOCK');
  });

  it('4.3 Complete Flight Mode Trigger Matrix for Autonomous Detector Findings', () => {
    const alert = {
      triggered: true,
      detectorId: 'DET-12',
      reason: '[DET-12] Haiku split prompt token cliff threshold exceeded (>=98k)'
    };
    const running = { state: CONTROL_STATES.RUNNING };

    // 1. COACH mode: non-blocking advisory warning
    const coachRes = evaluateCoachLatch({ controlState: running, flightMode: 'COACH', detectorVerdict: alert });
    assert.equal(coachRes.decision, 'allow');
    assert.equal(coachRes.flightMode, 'COACH');
    assert.equal(coachRes.advisory, true);
    assert.equal(coachRes.detectorId, 'DET-12');
    assert.ok(coachRes.systemMessage.includes('DET-12'));

    // 2. AUTO_PILOT mode: hard block
    const autoRes = evaluateCoachLatch({ controlState: running, flightMode: 'AUTO_PILOT', detectorVerdict: alert });
    assert.equal(autoRes.decision, 'block');
    assert.equal(autoRes.flightMode, 'AUTO_PILOT');
    assert.equal(autoRes.blocked, true);
    assert.equal(autoRes.detectorId, 'DET-12');

    // 3. SILENT mode: allow without advisory warning
    const silentRes = evaluateCoachLatch({ controlState: running, flightMode: 'SILENT', detectorVerdict: alert });
    assert.equal(silentRes.decision, 'allow');
    assert.equal(silentRes.advisory, undefined);

    // 4. OFF mode: allow without advisory warning
    const offRes = evaluateCoachLatch({ controlState: running, flightMode: 'OFF', detectorVerdict: alert });
    assert.equal(offRes.decision, 'allow');
  });

  it('4.4 Normalization of arbitrary, unknown, and malformed flight mode strings', () => {
    assert.equal(normalizeFlightMode('CUSTOM_UNRECOGNIZED'), 'COACH');
    assert.equal(normalizeFlightMode(''), 'COACH');
    assert.equal(normalizeFlightMode('   '), 'COACH');
    assert.equal(normalizeFlightMode(null), 'COACH');
    assert.equal(normalizeFlightMode(undefined), 'COACH');
    assert.equal(normalizeFlightMode(123), 'COACH');
    assert.equal(normalizeFlightMode({}), 'COACH');

    // Valid modes case-insensitively trimmed
    assert.equal(normalizeFlightMode('coach'), 'COACH');
    assert.equal(normalizeFlightMode('  auto_pilot  '), 'AUTO_PILOT');
    assert.equal(normalizeFlightMode('silent'), 'SILENT');
    assert.equal(normalizeFlightMode('off'), 'OFF');
  });

  it('4.5 HUD coach pill formatting across modes and active detector breakers', () => {
    // Normal idle states
    assert.equal(renderCoachPill({ flightMode: 'COACH' }), '[COACH]');
    assert.equal(renderCoachPill({ flightMode: 'AUTO_PILOT' }), '[AUTO_PILOT]');
    assert.equal(renderCoachPill({ flightMode: 'SILENT' }), '[SILENT]');

    // Active breaker / detector alert
    assert.equal(
      renderCoachPill({
        flightMode: 'COACH',
        breakerVerdict: { triggered: true, detectorId: 'DET-09' }
      }),
      '[COACH · DET-09 ACTIVE]'
    );

    // Detector verdict alias
    assert.equal(
      renderCoachPill({
        flightMode: 'COACH',
        detectorVerdict: { triggered: true, detectorId: 'DET-30' }
      }),
      '[COACH · DET-30 ACTIVE]'
    );

    // Untriggered breaker
    assert.equal(
      renderCoachPill({
        flightMode: 'COACH',
        breakerVerdict: { triggered: false, detectorId: 'DET-09' }
      }),
      '[COACH]'
    );

    // Unknown mode string defaults safely to COACH in HUD pill
    assert.equal(
      renderCoachPill({
        flightMode: 'UNRECOGNIZED_MODE',
        breakerVerdict: { triggered: true, detectorId: 'DET-20' }
      }),
      '[COACH · DET-20 ACTIVE]'
    );
  });
});

// =========================================================================
// SECTION 5: Atomic Tool-Boundary Suspension (Feature 28)
// =========================================================================
describe('Milestone 4 Adversarial Suite 5: Atomic Tool-Boundary Suspension', () => {
  it('5.1 Asynchronous non-spinning resume: PAUSED -> RUNNING transitions cleanly', async () => {
    let currentState = { state: CONTROL_STATES.PAUSED, reason: 'Waiting for inspect' };

    // Schedule external resume after 25ms
    setTimeout(() => {
      currentState = { state: CONTROL_STATES.RUNNING, reason: 'User clicked resume' };
    }, 25);

    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => currentState,
      pollIntervalMs: 5,
      timeoutMs: 1000
    });

    assert.equal(outcome.resumed, true);
    assert.equal(outcome.decision, 'allow');
    assert.equal(outcome.state, CONTROL_STATES.RUNNING);
  });

  it('5.2 Asynchronous abort: PAUSED -> ABORTED terminates suspension immediately', async () => {
    let currentState = { state: CONTROL_STATES.PAUSED, reason: 'Waiting' };

    // Schedule external abort after 20ms
    setTimeout(() => {
      currentState = { state: CONTROL_STATES.ABORTED, reason: 'User aborted mid-suspension' };
    }, 20);

    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => currentState,
      pollIntervalMs: 5,
      timeoutMs: 1000
    });

    assert.equal(outcome.resumed, false);
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.reason, 'User aborted mid-suspension');
  });

  it('5.3 AbortSignal cancels suspension immediately', async () => {
    const controller = new AbortController();
    const currentState = { state: CONTROL_STATES.PAUSED };

    // Trigger abort after 15ms
    setTimeout(() => controller.abort(), 15);

    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => currentState,
      pollIntervalMs: 5,
      timeoutMs: 1000,
      signal: controller.signal
    });

    assert.equal(outcome.resumed, false);
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.decision, 'deny');
  });

  it('5.4 Safety ceiling timeout release terminates suspension with deny', async () => {
    const currentState = { state: CONTROL_STATES.PAUSED };

    const outcome = await waitForSuspensionResume({
      checkControlStateFn: () => currentState,
      pollIntervalMs: 5,
      timeoutMs: 30 // 30ms ceiling for test
    });

    assert.equal(outcome.resumed, false);
    assert.equal(outcome.timeout, true);
    assert.equal(outcome.decision, 'deny');
    assert.ok(outcome.reason.includes('timeout'));
  });

  it('5.5 Mod Law 5 fail-closed wrapping: exceptions in tool boundary guarantee deny', async () => {
    // Normalizer handles null/undefined
    assert.equal(toProtoSafePreHookOutput(null).decision, 'deny');
    assert.equal(toProtoSafePreHookOutput(undefined).decision, 'deny');

    // Safe wrapper catches thrown error and returns fail-closed deny
    const wrappedError = await wrapSafeToolBoundary(async () => {
      throw new Error('Explosive hook failure');
    });

    assert.equal(wrappedError.decision, 'deny');
    assert.ok(wrappedError.reason.includes('Fail-Closed'));
    assert.ok(wrappedError.reason.includes('Explosive hook failure'));
  });

  it('5.6 Defect Resolved: toProtoSafePreHookOutput normalizes block and reject to deny', () => {
    // Verified: line 168 ({ ...output, decision }) normalizes block to deny
    const blockOutput = { decision: 'block', reason: 'prohibited tool' };
    const normalizedBlock = toProtoSafePreHookOutput(blockOutput);
    assert.equal(
      normalizedBlock.decision,
      'deny',
      'Normalized decision must be deny when output decision is block'
    );
    assert.equal(normalizedBlock.reason, 'prohibited tool');

    const rejectOutput = { decision: 'reject', reason: 'rejected tool' };
    const normalizedReject = toProtoSafePreHookOutput(rejectOutput);
    assert.equal(
      normalizedReject.decision,
      'deny',
      'Normalized decision must be deny when output decision is reject'
    );
    assert.equal(normalizedReject.reason, 'rejected tool');
  });
});
