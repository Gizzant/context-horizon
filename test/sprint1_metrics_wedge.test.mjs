import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePrefixRetentionIndex,
  computeThinkingDrift,
  evaluateThinkingDriftLoop,
  classifyTurnDrift,
  formatRetentionLabel,
  formatTtft,
  THINKING_DRIFT_DETECTOR_ID
} from '../src/core/sprint_metrics.mjs';
import { computeQuotaAndCacheTelemetry } from '../src/core/quota.mjs';
import { EXTENDED_DETECTOR_IDS, ANTIGRAVITY_DETECTOR_SLUGS, CLAUDE_CODE_DETECTOR_TRANSLATION } from '../src/core/horizon_config.mjs';

const CARBON = { input: 2.0, cachedRead: 0.10 }; // Gemini 4 Carbon pre-cliff: 95% cached discount

function turn(ts, { input = 0, read = 0, create = 0, model = 'gemini-4-carbon', agent = 'primary', ttl = 300, mutation = false } = {}) {
  return {
    session_id: 's1', agent_id: agent, modelId: model,
    inputTokens: input, cacheReadTokens: read, cacheCreationTokens: create,
    timestampMs: 1_794_000_000_000 + ts, ttlSeconds: ttl, explicitMutation: mutation, rates: CARBON
  };
}

test('Sprint 1.1: retention index returns null (not 100%) when no measured multi-turn usage exists', () => {
  const r = computePrefixRetentionIndex([]);
  assert.equal(r.measured, false);
  assert.equal(r.retentionIndexPct, null);
  assert.equal(r.grade, 'n/a');
  assert.match(formatRetentionLabel(r), /Retain —/);
  const single = computePrefixRetentionIndex([turn(1000, { input: 50000 })]);
  assert.equal(single.retentionIndexPct, null, 'first turn is a mandatory cold prefill, never scored');
  const unmeasured = computePrefixRetentionIndex([turn(1000), turn(2000)]);
  assert.equal(unmeasured.measured, false, 'zero-usage (inferred) turns are never scored');
});

test('Sprint 1.1: fully warm Carbon session scores 100% and books the 95% discount', () => {
  const r = computePrefixRetentionIndex([
    turn(0, { input: 100000 }),
    turn(30_000, { input: 2000, read: 100000 }),
    turn(60_000, { input: 2000, read: 102000 })
  ]);
  assert.equal(r.retentionIndexPct, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.bustCount, 0);
  // 202k retained tokens * ($2.00 - $0.10)/1M = $0.3838
  assert.equal(r.retainedDiscountSavingsUSD, 0.3838);
  assert.equal(r.leakedColdPrefillUSD, 0);
});

test('Sprint 1.1: model switch inside TTL is a prefix bust with leaked $ and cause attribution', () => {
  const r = computePrefixRetentionIndex([
    turn(0, { input: 100000 }),
    turn(30_000, { input: 2000, read: 100000 }),
    turn(60_000, { input: 102000, read: 0, model: 'claude-opus-5-5' })
  ]);
  assert.equal(r.bustCount, 1);
  assert.deepEqual(r.bustCauses, { model_switch: 1 });
  assert.equal(r.retentionIndexPct, 50); // 100k retained / 200k eligible
  assert.equal(r.grade, 'C');
  assert.ok(r.leakedColdPrefillUSD > 0.18);
  assert.match(r.label, /Leaked \$/);
});

test('Sprint 1.1: idle TTL expiry is excluded from the index (TTL problem, not prefix structure)', () => {
  const r = computePrefixRetentionIndex([
    turn(0, { input: 100000 }),
    turn(600_000, { input: 100000 }) // 10 min gap > 300s TTL
  ]);
  assert.equal(r.ttlExpiredTurns, 1);
  assert.equal(r.measured, false);
});

test('Sprint 1.1: subagent streams are scored independently', () => {
  const r = computePrefixRetentionIndex([
    turn(0, { input: 80000 }),
    turn(1000, { input: 20000, agent: 'worker-1' }),
    turn(20_000, { input: 1000, read: 80000 }),
    turn(21_000, { input: 500, read: 20000, agent: 'worker-1' })
  ]);
  assert.equal(r.measuredTurns, 2);
  assert.equal(r.retentionIndexPct, 100);
});

test('Sprint 1.2: drift classification + DET-30 WARN vs CRITICAL thresholds', () => {
  assert.equal(classifyTurnDrift({ thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 0 }), 'loop_suspect');
  assert.equal(classifyTurnDrift({ thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 1 }), 'elevated');
  assert.equal(classifyTurnDrift({ thinkingTokens: 3000, visibleOutputTokens: 100, mutatingCalls: 0 }), 'elevated');
  assert.equal(classifyTurnDrift({ thinkingTokens: 800, visibleOutputTokens: 900, mutatingCalls: 0 }), 'nominal');

  const loopTurn = { thinkingTokens: 6000, visibleOutputTokens: 300, mutatingCalls: 0 };
  const warn = evaluateThinkingDriftLoop([loopTurn]);
  assert.equal(warn.detectorId, THINKING_DRIFT_DETECTOR_ID);
  assert.equal(warn.severity, 'warn');
  const crit = evaluateThinkingDriftLoop([loopTurn, loopTurn]);
  assert.equal(crit.severity, 'critical');
  const cumulative = evaluateThinkingDriftLoop([{ thinkingTokens: 11000, visibleOutputTokens: 400, mutatingCalls: 0 }]);
  assert.equal(cumulative.severity, 'critical');
  const recovered = evaluateThinkingDriftLoop([loopTurn, { thinkingTokens: 2000, visibleOutputTokens: 1500, mutatingCalls: 2 }]);
  assert.equal(recovered.triggered, false, 'an edit turn resets the loop');
});

test('Sprint 1.2: computeThinkingDrift derives TTFT + ratio from raw steps and ignores estimated thinking', () => {
  const steps = [
    { type: 'USER_INPUT', createdAt: '2026-11-10T10:00:00.000Z' },
    { type: 'PLANNER_RESPONSE', createdAt: '2026-11-10T10:00:01.200Z', thinkingTokens: 6000, outputTokens: 300 },
    { type: 'USER_INPUT', createdAt: '2026-11-10T10:01:00.000Z' },
    { type: 'PLANNER_RESPONSE', createdAt: '2026-11-10T10:01:02.500Z', thinkingTokens: 7000, outputTokens: 400 }
  ];
  const d = computeThinkingDrift(steps);
  assert.equal(d.measured, true);
  assert.equal(d.lastTtftMs, 2500);
  assert.equal(d.avgTtftMs, 1850);
  assert.equal(d.lastDriftRatio, 17.5);
  assert.equal(d.driftState, 'loop_detected');
  assert.equal(d.loop.severity, 'critical');
  assert.match(d.label, /^LOOP 17\.5x · TTFT 2\.5s$/);

  const withEdit = computeThinkingDrift([
    ...steps.slice(0, 2),
    { type: 'PLANNER_RESPONSE', createdAt: '2026-11-10T10:00:03Z', toolCalls: [{ name: 'write_file' }] }
  ]);
  assert.equal(withEdit.loop.triggered, false);

  const estimated = computeThinkingDrift([
    { type: 'USER_INPUT', createdAt: '2026-11-10T10:00:00Z' },
    { type: 'PLANNER_RESPONSE', createdAt: '2026-11-10T10:00:01Z', thinkingTokens: 9000, thinkingEstimated: true, outputTokens: 10 }
  ]);
  assert.equal(estimated.measured, false);
  assert.equal(estimated.driftState, 'n/a');
  assert.equal(formatTtft(950), '950ms');
});

test('Sprint 1 integration: computeQuotaAndCacheTelemetry exposes prefixRetention + thinkingDrift', () => {
  const steps = [
    { type: 'USER_INPUT', createdAt: '2026-11-10T10:00:00Z' },
    { type: 'PLANNER_RESPONSE', createdAt: '2026-11-10T10:00:02Z', inputTokens: 90000, outputTokens: 500, thinkingTokens: 800 },
    { type: 'USER_INPUT', createdAt: '2026-11-10T10:00:40Z' },
    { type: 'PLANNER_RESPONSE', createdAt: '2026-11-10T10:00:41Z', inputTokens: 1500, cacheReadTokens: 90000, outputTokens: 600, thinkingTokens: 900 }
  ];
  const q = computeQuotaAndCacheTelemetry(steps, {
    sessionId: 'unknown',
    modelId: 'gemini-4-carbon',
    nowMs: Date.parse('2026-11-10T10:01:00Z')
  });
  assert.ok(q.cache.prefixRetention, 'cache.prefixRetention present');
  assert.equal(q.cache.prefixRetention.retentionIndexPct, 100);
  assert.ok(q.cache.prefixRetention.retainedDiscountSavingsUSD > 0);
  assert.ok(q.thinkingDrift, 'thinkingDrift present');
  assert.equal(q.thinkingDrift.lastTtftMs, 1000);
  assert.equal(q.thinkingDrift.driftState, 'nominal');
});

test('Sprint 1: DET-30 registered in Antigravity config and translated from Claude Code DET-21', () => {
  assert.ok(EXTENDED_DETECTOR_IDS.includes('DET-30'));
  assert.equal(ANTIGRAVITY_DETECTOR_SLUGS['DET-30'], 'thinking-drift-loop');
  assert.deepEqual(CLAUDE_CODE_DETECTOR_TRANSLATION['DET-21'].gaIds, ['DET-30']);
});
