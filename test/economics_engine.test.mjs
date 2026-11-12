/**
 * @file test/economics_engine.test.mjs
 * Comprehensive unit and integration test suite for Attention Horizon v4.0 Economics Engine.
 *
 * Covers:
 *   - Feature 17: TTFT & Thinking Drift Detection (`driftLatency.mjs`)
 *   - Feature 18: 95% Prefix-Cache Retention Radar (`retentionRadar.mjs`)
 *   - Feature 19: Algebraic C* Break-Even Cache Gravity Router (`cacheGravity.mjs`)
 *   - Feature 20: Haiku 100k 5x Cliff Breaker (`cliffBreaker.mjs` / DET-12)
 *   - Feature 21: 1s Live Dual-TTL Countdown (`dualTtl.mjs`)
 *   - Feature 22: 5-Hour Rolling Billing Blocks (`billingBlocks.mjs`)
 *
 * Verifies Mod Laws 1–5 compliance, exact mathematical values, and boundary corner cases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  // Feature 17
  createInitialThinkingDrift,
  applyThinkingDriftEvent,
  classifyTurnDrift,
  evaluateThinkingDriftLoop,
  formatTtft,
  isTtftSpike,
  formatDriftCompact,
  formatDriftLabel,
  DRIFT_THRESHOLDS,
  THINKING_DRIFT_DETECTOR_ID,
  LEGACY_THINKING_DRIFT_ALIAS,

  // Feature 18
  verifyRetentionRadarDiff,
  findPrefixMutationOffset,
  classifyBustCause,
  computePrefixRetention,
  RetentionRadar,
  PREFIX_RETENTION_THRESHOLDS,

  // Feature 19
  calculateBreakEvenCStar,
  computeClosedFormBreakEven,
  computeBreakEvenCachedTokens,
  evaluateCacheGravity,
  resolveNaturalDownshiftPeer,
  MODEL_BREAK_EVEN_RATES,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,

  // Feature 20
  checkHaiku100kCliffBreaker,
  evaluateDet12HaikuPreCliffBreaker,
  evaluateHaikuCliffBreaker,
  isHaikuModel,
  HAIKU_CLIFF_THRESHOLDS,
  HAIKU_CLIFF_DETECTOR_ID,

  // Feature 21
  calculateDualTtlCountdown,
  formatMmSs,
  formatRemainingTtl,
  evaluatePauseDistribution,
  DualTtlTracker,
  DUAL_TTL_CONSTANTS,

  // Feature 22
  partitionBillingBlocks,
  attributeSubagentCosts,
  computeBillingBlockSummary,
  RollingBillingBlockTracker,
  BILLING_BLOCK_CONSTANTS
} from '../src/core-isomorphic/economics/index.mjs';

// ============================================================================
// Feature 17: TTFT & Thinking Drift Detection
// ============================================================================
describe('Economics Engine: Feature 17 — TTFT & Thinking Drift Detection', () => {
  it('computes exact TTFT in milliseconds and formats properly', () => {
    let drift = createInitialThinkingDrift();
    assert.equal(drift.measured, false);
    assert.equal(drift.lastTtftMs, null);

    drift = applyThinkingDriftEvent(drift, {
      turnStartedAtMs: 10000,
      nowMs: 10450,
      thinkingTokens: 100,
      outputTokens: 50
    });

    assert.equal(drift.measured, true);
    assert.equal(drift.lastTtftMs, 450);
    assert.equal(formatTtft(450), '450ms');
    assert.equal(formatTtft(1500), '1.5s');
    assert.equal(formatTtft(65000), '1m5s');
  });

  it('handles clock skew and zero/negative TTFT by returning null and "—"', () => {
    assert.equal(formatTtft(0), '—');
    assert.equal(formatTtft(-50), '—');
    assert.equal(formatTtft(null), '—');
    assert.equal(formatTtft(undefined), '—');

    let drift = createInitialThinkingDrift();
    drift = applyThinkingDriftEvent(drift, {
      turnStartedAtMs: 5000,
      nowMs: 4000, // clock skew backwards
      thinkingTokens: 200,
      outputTokens: 100
    });

    assert.equal(drift.lastTtftMs, null);
    assert.equal(formatTtft(drift.lastTtftMs), '—');
  });

  it('computes rolling average TTFT and flags sudden spikes > 5x baseline', () => {
    let drift = createInitialThinkingDrift();
    const ttfts = [200, 300, 400];
    for (let i = 0; i < ttfts.length; i++) {
      drift = applyThinkingDriftEvent(drift, {
        ttftMs: ttfts[i],
        thinkingTokens: 1000,
        outputTokens: 500,
        nowMs: 1000 + i * 1000
      });
    }

    assert.equal(drift.avgTtftMs, 300);
    assert.equal(isTtftSpike(2000, drift.avgTtftMs), true); // 2000 > 1500
    assert.equal(isTtftSpike(1200, drift.avgTtftMs), false);
  });

  it('calculates thinking-to-output ratio accurately, excluding estimated tokens', () => {
    let drift = createInitialThinkingDrift();
    drift = applyThinkingDriftEvent(drift, {
      thinkingTokens: 4800,
      outputTokens: 400,
      thinkingEstimated: false
    });

    assert.equal(drift.lastDriftRatio, 12.0);
    assert.equal(classifyTurnDrift({ thinkingTokens: 4800, visibleOutputTokens: 400, mutatingCalls: 0 }), 'loop_suspect');

    // Turn with estimated thinking should be excluded from drift accumulation
    const prevRatio = drift.lastDriftRatio;
    drift = applyThinkingDriftEvent(drift, {
      thinkingTokens: 9999,
      outputTokens: 100,
      thinkingEstimated: true
    });
    assert.equal(drift.lastDriftRatio, prevRatio);
  });

  it('triggers canonical DET-30 (DET-21 alias) scratchpad loop alert on loop suspect turns', () => {
    const turns = [
      { thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 0 },
      { thinkingTokens: 6000, visibleOutputTokens: 150, mutatingCalls: 0 }
    ];

    const result = evaluateThinkingDriftLoop(turns);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
    assert.equal(result.gaDetectorId, THINKING_DRIFT_DETECTOR_ID);
    assert.equal(result.aliasDetectorId, LEGACY_THINKING_DRIFT_ALIAS);
    assert.match(result.message, /DET-30/);

    // Mutating tool edit breaks the loop streak
    const turnsWithEdit = [
      { thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 0 },
      { thinkingTokens: 500, visibleOutputTokens: 500, mutatingCalls: 1 }
    ];
    const broken = evaluateThinkingDriftLoop(turnsWithEdit);
    assert.equal(broken.triggered, false);
    assert.equal(broken.consecutiveLoopTurns, 0);
  });

  it('formats compact and informative drift labels for statusline', () => {
    let drift = createInitialThinkingDrift();
    assert.equal(formatDriftCompact(drift), 'TTFT: — | Drift: —');
    assert.equal(formatDriftLabel(drift), 'Thinking drift unmeasured');

    drift = applyThinkingDriftEvent(drift, {
      ttftMs: 350,
      thinkingTokens: 2000,
      outputTokens: 500
    });
    assert.equal(formatDriftCompact(drift), 'TTFT: 350ms | Drift: 4x');
  });
});

// ============================================================================
// Feature 18: 95% Prefix-Cache Retention Radar
// ============================================================================
describe('Economics Engine: Feature 18 — 95% Prefix-Cache Retention Radar', () => {
  it('performs isomorphic byte-offset mutation diffing via TextEncoder / Uint8Array', () => {
    const orig = 'System Prompt: Alpha Beta Gamma Delta';
    const mutated = 'System Prompt: Alpha [MUTATED] Gamma Delta';

    const diff = verifyRetentionRadarDiff(orig, mutated);
    assert.equal(diff.firstDiffOffset, 21);
    assert.equal(diff.prefixMatchBytes, 21);
    assert.ok(diff.retentionPct < 95);
    assert.equal(diff.is95PctRetained, false);
  });

  it('handles multi-byte UTF-8 characters cleanly without crashing or byte misalignment', () => {
    const orig = 'Role: 🤖 AI Assistant with UTF-8 runes 🚀';
    const mutated = 'Role: 🤖 AI Assistant with UTF-8 runes 🛸';

    const diff = verifyRetentionRadarDiff(orig, mutated);
    assert.ok(diff.firstDiffOffset > 0);
    assert.ok(diff.retentionPct > 80);
  });

  it('grades prefix retention into Grade A (>=95%), Grade B (80-95%), Grade C (<80%)', () => {
    const base = 'Z'.repeat(100);

    const gradeA = verifyRetentionRadarDiff(base, 'Z'.repeat(97) + 'A'.repeat(3));
    assert.equal(gradeA.grade, 'A');
    assert.equal(gradeA.is95PctRetained, true);

    const gradeB = verifyRetentionRadarDiff(base, 'Z'.repeat(85) + 'A'.repeat(15));
    assert.equal(gradeB.grade, 'B');
    assert.equal(gradeB.is95PctRetained, false);

    const gradeC = verifyRetentionRadarDiff(base, 'Z'.repeat(50) + 'A'.repeat(50));
    assert.equal(gradeC.grade, 'C');
    assert.equal(gradeC.is95PctRetained, false);
  });

  it('handles edge cases: empty strings, identical strings, and prefix truncation', () => {
    const emptyDiff = verifyRetentionRadarDiff('', '');
    assert.equal(emptyDiff.firstDiffOffset, -1);
    assert.equal(emptyDiff.retentionPct, 100);
    assert.equal(emptyDiff.grade, 'A');

    const identicalDiff = verifyRetentionRadarDiff('Hello World', 'Hello World');
    assert.equal(identicalDiff.firstDiffOffset, -1);
    assert.equal(identicalDiff.retentionPct, 100);
    assert.equal(identicalDiff.is95PctRetained, true);

    const truncDiff = verifyRetentionRadarDiff('Hello World Long', 'Hello World');
    assert.equal(truncDiff.firstDiffOffset, 11);
    assert.ok(truncDiff.retentionPct < 100);
  });

  it('findPrefixMutationOffset reports line, column, and contextual snippet', () => {
    const prev = 'line 1\nline 2\nline 3: alpha';
    const curr = 'line 1\nline 2\nline 3: beta';

    const detailed = findPrefixMutationOffset(prev, curr);
    assert.equal(detailed.line, 3);
    assert.ok(detailed.column > 1);
    assert.ok(detailed.snippet.includes('line 3:'));
  });

  it('computes multi-turn retention index and dollar discount accounting', () => {
    const turns = [
      { eligibleTokens: 10000, retainedTokens: 9800 },
      { eligibleTokens: 10000, retainedTokens: 9600 },
      { eligibleTokens: 10000, retainedTokens: 4000, bustCause: 'system_prompt_mutation' }
    ];

    const result = computePrefixRetention(turns, { inputPricePer1M: 3.0, readPricePer1M: 0.3 });
    assert.equal(result.measuredTurns, 3);
    assert.equal(result.bustCount, 1);
    assert.ok(result.retainedDiscountSavingsUSD > 0);
    assert.ok(result.leakedColdPrefillUSD > 0);
    assert.equal(result.grade, 'B');
  });

  it('stateful RetentionRadar tracks rolling prompt sequence', () => {
    const radar = new RetentionRadar();
    radar.recordTurn('Prefix v1: Hello World');
    const diff2 = radar.recordTurn('Prefix v1: Hello World Modified');

    assert.equal(diff2.firstDiffOffset, 22);
    assert.equal(radar.getState().measuredTurns, 2);
  });
});

// ============================================================================
// Feature 19: Algebraic C* Break-Even Cache Gravity Router
// ============================================================================
describe('Economics Engine: Feature 19 — Algebraic C* Break-Even Cache Gravity Router', () => {
  it('computes exact canonical break-even C* = 6,522 tokens for Opus 5.5 -> Sonnet 5.5 at O = 1,500', () => {
    const cStar = calculateBreakEvenCStar();
    assert.equal(cStar, 6522);

    const closed = computeClosedFormBreakEven(1500, 20.0, 10.0, 2.5, 0.20);
    assert.equal(closed, 6522);
  });

  it('computes exact canonical break-even C* = 4,615 tokens for Opus 4.6 -> Sonnet 4.6 at O = 1,500', () => {
    const cStar = calculateBreakEvenCStar({
      currentModel: 'claude-opus-4-6',
      targetModel: 'claude-sonnet-4-6'
    });
    assert.equal(cStar, 4615);

    const closed = computeClosedFormBreakEven(1500, 25.0, 15.0, 3.75, 0.50);
    assert.equal(closed, 4615);
  });

  it('handles non-zero uncached delta tokens in the numerator', () => {
    // Opus 5.5 -> Sonnet 5.5 with Delta = 20,000, O = 1,500
    // Numerator = 1,500 * (20 - 10) + 20,000 * (5.0 - 2.5) = 15,000 + 50,000 = 65,000
    // Denominator = 2.5 - 0.2 = 2.3
    // C* = round(65,000 / 2.3) = 28,261
    const cStar = calculateBreakEvenCStar({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      uncachedDeltaTokens: 20000
    });
    assert.equal(cStar, 28261);
  });

  it('enforces capability upshift rule: C* = 0 and shouldHold = false when upgrading models', () => {
    const result = computeBreakEvenCachedTokens({
      currentModel: 'claude-sonnet-5-5',
      targetModel: 'claude-opus-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 50000
    });

    assert.equal(result.isCapabilityUpshift, true);
    assert.equal(result.breakEvenTokens, 0);
    assert.equal(result.shouldHold, false);
    assert.equal(result.shouldHoldModel, false);
  });

  it('returns Infinity when target write rate is cheaper than or equal to current read rate', () => {
    const cStar = computeClosedFormBreakEven(1500, 20.0, 10.0, 0.20, 0.20);
    assert.equal(cStar, Infinity);
  });

  it('returns 0 when current and target models are identical', () => {
    const result = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-opus-5-5',
      cachedTokens: 20000
    });

    assert.equal(result.breakEvenTokens, 0);
    assert.equal(result.shouldHold, false);
  });

  it('advises switch when cache is cold (cachedTokens = 0) and target is cheaper', () => {
    const result = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 0,
      cacheWarm: false
    });

    assert.ok(result.switchToTargetModelUSD < result.stayOnCurrentModelUSD);
    assert.equal(result.shouldHold, false);
  });

  it('blocks/advises against model switch when warm cache makes current model cheaper (cachedTokens > C*)', () => {
    const result = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 30000, // > 6522
      cacheWarm: true
    });

    assert.ok(result.stayOnCurrentModelUSD < result.switchToTargetModelUSD);
    assert.equal(result.shouldHold, true);
    assert.ok(result.coldWritePenaltyUSD > 0);
  });

  it('correctly maps natural downshift peer models', () => {
    assert.equal(resolveNaturalDownshiftPeer('claude-fable-5-2'), 'claude-opus-5-5');
    assert.equal(resolveNaturalDownshiftPeer('claude-opus-5-5'), 'claude-sonnet-5-5');
    assert.equal(resolveNaturalDownshiftPeer('claude-opus-4-6'), 'claude-sonnet-4-6');
    assert.equal(resolveNaturalDownshiftPeer('claude-sonnet-5-5'), 'claude-haiku-5-5');
    assert.equal(resolveNaturalDownshiftPeer('claude-haiku-5-5'), 'claude-haiku-5-5');
  });
});

// ============================================================================
// Feature 20: Haiku 100k 5x Cliff Breaker
// ============================================================================
describe('Economics Engine: Feature 20 — Haiku 100k 5x Cliff Breaker (DET-12)', () => {
  it('passes safe prompt volume (< 90k) on Haiku models', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 75000);
    assert.equal(check.triggered, false);
    assert.equal(check.action, 'allow');
    assert.match(check.reason, /safe boundary/i);
  });

  it('emits advisory compaction warning between 90,000 and 97,999 tokens', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 92500);
    assert.equal(check.triggered, false);
    assert.equal(check.action, 'advisory');
    assert.match(check.reason, /approaching 90k advisory boundary/i);

    const det12 = evaluateDet12HaikuPreCliffBreaker({
      modelId: 'claude-haiku-5-5',
      totalInputTokens: 92500
    });
    assert.equal(det12.triggered, true);
    assert.equal(det12.decision, 'advise_compact');
    assert.equal(det12.advisory, true);
  });

  it('trips hard circuit breaker at >= 98,000 tokens before 100k cliff', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 98200);
    assert.equal(check.triggered, true);
    assert.equal(check.action, 'warn');

    const det12 = evaluateDet12HaikuPreCliffBreaker({
      modelId: 'claude-haiku-5-5',
      totalInputTokens: 98200
    });
    assert.equal(det12.triggered, true);
    assert.equal(det12.decision, 'deny');
    assert.equal(det12.advisory, false);
  });

  it('emits emergency halt when prompt tokens reach or exceed 100,000 tokens', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 100500);
    assert.equal(check.triggered, true);
    assert.equal(check.action, 'halt');
    assert.match(check.reason, /exceeded 100k 5x cost cliff/);
  });

  it('strictly exempts non-Haiku models (Sonnet, Opus, Gemini)', () => {
    const sonnet = checkHaiku100kCliffBreaker('claude-sonnet-5-5', 250000);
    assert.equal(sonnet.triggered, false);
    assert.equal(sonnet.action, 'allow');
    assert.match(sonnet.reason, /Non-Haiku model/);

    const opus = evaluateDet12HaikuPreCliffBreaker({
      modelId: 'claude-opus-5-5',
      totalInputTokens: 150000
    });
    assert.equal(opus.triggered, false);
    assert.equal(opus.decision, 'allow');
  });
});

// ============================================================================
// Feature 21: 1s Live Dual-TTL Countdown
// ============================================================================
describe('Economics Engine: Feature 21 — 1s Live Dual-TTL Countdown', () => {
  it('tracks 5m (300s) prompt cache countdown and 1h (3600s) billing countdown', () => {
    const t0 = 1000000;
    const now = t0 + 60000; // 60s elapsed
    const res = calculateDualTtlCountdown(t0, now);

    assert.equal(res.cacheTtlSec, 240);
    assert.equal(res.billingTtlSec, 3540);
    assert.equal(res.formattedCacheTtl, '04:00');
    assert.equal(res.formattedBillingTtl, '59:00');
    assert.equal(res.isCacheExpired, false);
    assert.equal(res.isBillingExpired, false);
  });

  it('formats digital countdown in MM:SS and compact human notation', () => {
    assert.equal(formatMmSs(125), '02:05');
    assert.equal(formatMmSs(0), '00:00');
    assert.equal(formatMmSs(-10), '00:00');

    assert.equal(formatRemainingTtl(252), '4m12s');
    assert.equal(formatRemainingTtl(42), '42s');
    assert.equal(formatRemainingTtl(0), '0s');
  });

  it('resets cache TTL to full 300s upon turn event', () => {
    const now = 2000000;
    const res = calculateDualTtlCountdown(now, now);
    assert.equal(res.cacheTtlSec, 300);
    assert.equal(res.formattedCacheTtl, '05:00');
  });

  it('clamps expired cache countdown cleanly at 00:00 without negative rollover', () => {
    const t0 = 1000000;
    const now = t0 + 500000; // 500s elapsed (> 300s)
    const res = calculateDualTtlCountdown(t0, now);

    assert.equal(res.cacheTtlSec, 0);
    assert.equal(res.formattedCacheTtl, '00:00');
    assert.equal(res.isCacheExpired, true);
  });

  it('handles rolling 1-hour billing block countdown modulo arithmetic', () => {
    const start = 1000000;
    const now = start + 4500000; // 1 hour 15 min elapsed
    const res = calculateDualTtlCountdown(start, now, 300000, 3600000, { rolling: true });

    assert.equal(res.billingTtlSec, 2700); // 45m remaining in second block
    assert.equal(res.formattedBillingTtl, '45:00');
    assert.equal(res.isBillingExpired, true);
  });

  it('evaluates inter-turn pause distribution and recommends 1h tier upgrade at >= 3.1%', () => {
    // 35 pauses total, 2 in 5m-60m range -> 2/35 = 5.7% (>= 3.1%)
    const pauses = [60, 120, 400, 50, 1000, ...Array(30).fill(30)];
    const analysis = evaluatePauseDistribution(pauses);

    assert.equal(analysis.totalIntervals, 35);
    assert.equal(analysis.fiveToSixtyMinCount, 2);
    assert.equal(analysis.recommend1hTierUpgrade, true);
    assert.ok(analysis.advisoryMessage.includes('Upgrade session prompt cache tier'));

    // Few long pauses (< 3.1%)
    const shortPauses = Array(100).fill(30);
    const shortAnalysis = evaluatePauseDistribution(shortPauses);
    assert.equal(shortAnalysis.recommend1hTierUpgrade, false);
    assert.equal(shortAnalysis.advisoryMessage, null);
  });

  it('stateful DualTtlTracker tracks active session clocks', () => {
    const tracker = new DualTtlTracker({ rolling: true });
    tracker.recordTurn(1000000);
    const countdown = tracker.getCountdown(1000000 + 30000);
    assert.equal(countdown.cacheTtlSec, 270);
  });
});

// ============================================================================
// Feature 22: 5-Hour Rolling Billing Blocks
// ============================================================================
describe('Economics Engine: Feature 22 — 5-Hour Rolling Billing Blocks', () => {
  it('partitions continuous usage events into rolling 5-hour blocks (18,000,000 ms)', () => {
    const t0 = 1000000;
    const fiveHoursMs = 5 * 3600 * 1000;
    const events = [
      { timestamp: t0 + 100, costUsd: 1.0, tokens: 10000, subagentId: 'coord' },
      { timestamp: t0 + fiveHoursMs + 200, costUsd: 2.0, tokens: 20000, subagentId: 'worker-1' },
      { timestamp: t0 + 2 * fiveHoursMs + 300, costUsd: 3.0, tokens: 30000, subagentId: 'worker-2' }
    ];

    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].blockIndex, 0);
    assert.equal(blocks[1].blockIndex, 1);
    assert.equal(blocks[2].blockIndex, 2);
  });

  it('computes spend velocity ($/hour) and token velocity (tokens/min) per block', () => {
    const t0 = 1000000;
    const hour = 3600 * 1000;
    const events = [
      { timestamp: t0, costUsd: 5.0, tokens: 150000, subagentId: 'main' },
      { timestamp: t0 + hour, costUsd: 10.0, tokens: 150000, subagentId: 'main' }
    ];

    const [block] = partitionBillingBlocks(events);
    assert.equal(block.totalCostUsd, 15.0);
    assert.equal(block.totalTokens, 300000);
    assert.equal(block.burnRateUsdPerHour, 3.0); // 15.0 / 5h
    assert.equal(block.tokensPerMin, 1000);       // 300,000 / 300 min
  });

  it('attributes costs per subagent correctly, defaulting missing IDs to "main"', () => {
    const events = [
      { timestamp: 1000, costUsd: 4.0, tokens: 50000, subagentId: 'explorer' },
      { timestamp: 2000, costUsd: 2.5, tokens: 25000, subagentId: 'worker' },
      { timestamp: 3000, costUsd: 1.5, tokens: 10000 } // missing subagentId
    ];

    const [block] = partitionBillingBlocks(events);
    assert.equal(block.subagentSpend['explorer'], 4.0);
    assert.equal(block.subagentSpend['worker'], 2.5);
    assert.equal(block.subagentSpend['main'], 1.5);

    const attribution = attributeSubagentCosts(events);
    assert.equal(attribution['explorer'].costUsd, 4.0);
    assert.equal(attribution['explorer'].pct, 50.0);
    assert.equal(attribution['main'].costUsd, 1.5);
  });

  it('handles empty events gracefully returning []', () => {
    assert.deepEqual(partitionBillingBlocks([]), []);
    assert.deepEqual(attributeSubagentCosts([]), {});
    const summary = computeBillingBlockSummary([]);
    assert.equal(summary.blockCount, 0);
    assert.equal(summary.cumulativeCostUsd, 0);
  });

  it('RollingBillingBlockTracker records usage events dynamically', () => {
    const tracker = new RollingBillingBlockTracker();
    tracker.recordEvent({ costUsd: 2.0, tokens: 50000, subagentId: 'agent-1' });
    tracker.recordEvent({ costUsd: 3.0, tokens: 70000, subagentId: 'agent-2' });

    const blocks = tracker.getBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].totalCostUsd, 5.0);

    const summary = tracker.getSummary();
    assert.equal(summary.cumulativeCostUsd, 5.0);
    assert.equal(summary.cumulativeTokens, 120000);
  });
});
