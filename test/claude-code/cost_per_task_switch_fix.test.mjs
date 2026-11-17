// Regression tests for the multi-request model-switch fix (cost-per-task study, Claude Code 2.1.325).
// Evidence: experiments/model-switch-benchmark/results/highbeam_shadow_check.md,
// run_summary_cost_per_task.csv and run_summary_cost_per_task_hard.csv
// (SWITCH beat OPUS on 39 of 42 paired runs; the old single-request gate denied 40 of 42).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBreakEvenCachedTokens } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';

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
