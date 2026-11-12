/**
 * @file test/challenger_m3_1_adversarial_stress.mjs
 * Milestone 3 Adversarial Stress Test Suite:
 * Empirical adversarial stress testing of Algebraic C* Router and Haiku Cliff Breaker (DET-12).
 *
 * Authored by: challenger_m3_1
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeClosedFormBreakEven,
  calculateBreakEvenCStar,
  computeBreakEvenCachedTokens,
  evaluateCacheGravity,
  resolveNaturalDownshiftPeer,
  MODEL_BREAK_EVEN_RATES,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  EXPECTED_OUTPUT_TOKENS_BY_EFFORT
} from '../src/core-isomorphic/economics/cacheGravity.mjs';

import {
  checkHaiku100kCliffBreaker,
  evaluateDet12HaikuPreCliffBreaker,
  evaluateHaikuCliffBreaker,
  isHaikuModel,
  HAIKU_CLIFF_THRESHOLDS,
  HAIKU_CLIFF_DETECTOR_ID
} from '../src/core-isomorphic/economics/cliffBreaker.mjs';

import {
  resolveEffectiveRates,
  computeTotalPromptTokens,
  extractNormalizedTokenBreakdown
} from '../src/core-isomorphic/config/catalogLoader.mjs';

// =========================================================================
// SECTION 1: cacheGravity.mjs Empirical Stress Testing
// =========================================================================

describe('Challenger M3-1: cacheGravity.mjs Empirical Stress Tests', () => {

  describe('1.1 Extreme Token Volumes', () => {
    it('handles cold cache (cachedTokens = 0): cacheWarm is false, coldWritePenalty < 0, shouldHold is false', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cachedTokens: 0,
        expectedOutputTokens: 1500
      });
      assert.equal(res.cacheWarm, false);
      assert.equal(res.breakEvenTokens, 6522);
      assert.equal(res.shouldHoldModel, false);
      assert.ok(res.coldWritePenaltyUSD < 0, 'Switching on cold cache saves output cost');
      assert.equal(res.stayOnCurrentModelUSD, 0.030); // 1500 * 20 / 1M
      assert.equal(res.switchToTargetModelUSD, 0.015); // 1500 * 10 / 1M
    });

    it('handles minimal cache (cachedTokens = 1): cachedTokens < C*, shouldHold is false', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cachedTokens: 1,
        expectedOutputTokens: 1500
      });
      assert.equal(res.cacheWarm, true);
      assert.equal(res.breakEvenTokens, 6522);
      assert.equal(res.shouldHoldModel, false);
      assert.ok(res.coldWritePenaltyUSD < 0, '1 cached token penalty does not outweigh $0.015 output savings');
    });

    it('handles massive cache volume (10,000,000 tokens): maintains double-precision arithmetic without overflow', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cachedTokens: 10_000_000,
        expectedOutputTokens: 1500
      });
      assert.equal(res.cacheWarm, true);
      assert.equal(res.breakEvenTokens, 6522);
      assert.equal(res.shouldHoldModel, true);
      // Stay: 10M * 0.20/1M = $2.00 prefix + $0.03 output = $2.03
      // Switch: 10M * 2.50/1M = $25.00 prefix + $0.015 output = $25.015
      // Cold penalty: 25.015 - 2.030 = +$22.985
      assert.equal(res.stayOnCurrentModelUSD, 2.03);
      assert.equal(res.switchToTargetModelUSD, 25.015);
      assert.equal(res.coldWritePenaltyUSD, 22.985);
    });

    it('handles negative token inputs by clamping cleanly to 0', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cachedTokens: -5000,
        uncachedDeltaTokens: -2000,
        expectedOutputTokens: -100
      });
      assert.equal(res.cachedTokens, 0);
      assert.equal(res.uncachedDeltaTokens, 0);
      assert.equal(res.expectedOutputTokens, 0);
      assert.equal(res.breakEvenTokens, 0);
      assert.equal(res.shouldHoldModel, false);
    });

    it('handles expectedOutputTokens = 0: C* = 0, holds on warm cache since output savings are zero', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        expectedOutputTokens: 0,
        cachedTokens: 1000
      });
      assert.equal(res.breakEvenTokens, 0);
      assert.ok(res.coldWritePenaltyUSD > 0, 'Without output savings, any warm cache switch costs money');
      assert.equal(res.shouldHoldModel, true);
    });

    it('scales C* linearly across all effort levels', () => {
      for (const [effort, tokens] of Object.entries(EXPECTED_OUTPUT_TOKENS_BY_EFFORT)) {
        const cStar = calculateBreakEvenCStar(tokens);
        const expected = Math.round((tokens * (20.0 - 10.0)) / (2.5 - 0.2));
        assert.equal(cStar, expected, `C* for effort ${effort} (${tokens} tokens) matches expected`);
      }
    });
  });

  describe('1.2 Capability Upshifts (Opus -> Fable, Sonnet -> Opus, Haiku -> Sonnet)', () => {
    it('Opus 5.5 -> Fable 5.2: C* = 0, isCapabilityUpshift = true, shouldHold = false (never holds on upgrade)', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-fable-5-2',
        cachedTokens: 50_000,
        expectedOutputTokens: 1500
      });
      assert.equal(res.isCapabilityUpshift, true);
      assert.equal(res.breakEvenTokens, 0);
      assert.equal(res.shouldHoldModel, false);
      const evalRes = evaluateCacheGravity({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-fable-5-2',
        cachedTokens: 50_000
      });
      assert.equal(evalRes.recommendation, 'SWITCH_TO_TARGET');
      assert.equal(evalRes.action, 'allow');
    });

    it('Sonnet 5.5 -> Opus 5.5: C* = 0, isCapabilityUpshift = true, shouldHold = false', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-sonnet-5-5',
        targetModel: 'claude-opus-5-5',
        cachedTokens: 200_000
      });
      assert.equal(res.isCapabilityUpshift, true);
      assert.equal(res.breakEvenTokens, 0);
      assert.equal(res.shouldHoldModel, false);
    });

    it('Haiku 5.5 -> Sonnet 5.5: C* = 0, isCapabilityUpshift = true, shouldHold = false', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-haiku-5-5',
        targetModel: 'claude-sonnet-5-5',
        cachedTokens: 100_000
      });
      assert.equal(res.isCapabilityUpshift, true);
      assert.equal(res.breakEvenTokens, 0);
      assert.equal(res.shouldHoldModel, false);
    });

    it('Sonnet 4.6 -> Opus 4.6: C* = 0, isCapabilityUpshift = true, shouldHold = false', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-sonnet-4-6',
        targetModel: 'claude-opus-4-6',
        cachedTokens: 80_000
      });
      assert.equal(res.isCapabilityUpshift, true);
      assert.equal(res.breakEvenTokens, 0);
      assert.equal(res.shouldHoldModel, false);
    });

    it('upshifts with massive cache (1,000,000 tokens) still never hold', () => {
      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-sonnet-5-5',
        targetModel: 'claude-opus-5-5',
        cachedTokens: 1_000_000
      });
      assert.equal(res.shouldHoldModel, false);
      assert.equal(res.breakEvenTokens, 0);
    });
  });

  describe('1.3 Inverted Rates / Infinite Denominator (P_write,target <= P_read,curr)', () => {
    it('returns Infinity when target write rate equals current read rate', () => {
      const cStar = computeClosedFormBreakEven(1500, 20.0, 10.0, 0.2, 0.2);
      assert.equal(cStar, Infinity);
    });

    it('returns Infinity when target write rate is cheaper than current read rate', () => {
      const cStar = computeClosedFormBreakEven(1500, 20.0, 10.0, 0.1, 0.2);
      assert.equal(cStar, Infinity);
    });

    it('permits switch (shouldHold = false) when target write rate is cheaper than current read rate', () => {
      // Direct calculateBreakEvenCStar with inverted rates
      const cStarDirect = calculateBreakEvenCStar({
        pOutCurr: 20,
        pOutTarget: 10,
        pWrite5mTarget: 0.4,
        pReadCurr: 0.5
      });
      assert.equal(cStarDirect, Infinity);

      // Synthetic catalog overriding rates on distinct catalog models
      const syntheticCatalog = {
        defaultModel: 'claude-sonnet-5-5',
        models: {
          'claude-opus-5-5': {
            id: 'claude-opus-5-5',
            label: 'Current Opus',
            ratesPer1M: { input: 10, output: 20, write5m: 5, write1h: 8, read: 0.5 },
            multipliers: { write5m: 1.25, write1h: 2, read: 0.05 }
          },
          'claude-sonnet-5-5': {
            id: 'claude-sonnet-5-5',
            label: 'Target Sonnet',
            ratesPer1M: { input: 2, output: 10, write5m: 0.4, write1h: 0.8, read: 0.05 },
            multipliers: { write5m: 1.25, write1h: 2, read: 0.05 }
          }
        }
      };

      const res = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cachedTokens: 100_000
      }, { catalog: syntheticCatalog });

      assert.equal(res.breakEvenTokens, Infinity);
      assert.ok(res.coldWritePenaltyUSD < 0, 'Cold write is cheaper than warm read');
      assert.equal(res.shouldHoldModel, false);
    });
  });

  describe('1.4 Large Uncached Delta (Delta = 100k, 500k tokens)', () => {
    it('calculates exact C* for Opus 5.5 -> Sonnet 5.5 with Delta = 100,000 tokens (C* = 115,217)', () => {
      const cStar = calculateBreakEvenCStar({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        uncachedDeltaTokens: 100_000,
        expectedOutputTokens: 1500
      });
      // Numerator = 1500 * (20 - 10) + 100,000 * (5.0 - 2.5) = 15,000 + 250,000 = 265,000
      // Denominator = 2.5 - 0.2 = 2.30
      // 265,000 / 2.30 = 115,217.39... -> 115,217
      assert.equal(cStar, 115217);

      // Verify boundary behavior in computeBreakEvenCachedTokens
      const below = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        uncachedDeltaTokens: 100_000,
        cachedTokens: 115216
      });
      assert.equal(below.shouldHoldModel, false);
      assert.ok(below.coldWritePenaltyUSD <= 0);

      const above = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        uncachedDeltaTokens: 100_000,
        cachedTokens: 115218
      });
      assert.equal(above.shouldHoldModel, true);
      assert.ok(above.coldWritePenaltyUSD > 0);
    });

    it('calculates exact C* for Opus 5.5 -> Sonnet 5.5 with Delta = 500,000 tokens (C* = 550,000)', () => {
      const cStar = calculateBreakEvenCStar({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        uncachedDeltaTokens: 500_000,
        expectedOutputTokens: 1500
      });
      // Numerator = 15,000 + 500,000 * (5.0 - 2.5) = 15,000 + 1,250,000 = 1,265,000
      // Denominator = 2.30
      // 1,265,000 / 2.30 = 550,000
      assert.equal(cStar, 550000);

      const below = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        uncachedDeltaTokens: 500_000,
        cachedTokens: 549999
      });
      assert.equal(below.shouldHoldModel, false);
      assert.ok(below.coldWritePenaltyUSD <= 0);

      const above = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        uncachedDeltaTokens: 500_000,
        cachedTokens: 550001
      });
      assert.equal(above.shouldHoldModel, true);
      assert.ok(above.coldWritePenaltyUSD > 0);
    });
  });

  describe('1.5 All Model Family Pairings in Catalog', () => {
    it('verifies canonical pairings across Claude 5.5, Claude 4.6, Gemini 4 Carbon/Argon, and Haiku', () => {
      // 1. Opus 5.5 -> Sonnet 5.5 (canonical)
      const p1 = computeBreakEvenCachedTokens({ currentModel: 'claude-opus-5-5', targetModel: 'claude-sonnet-5-5' });
      assert.equal(p1.breakEvenTokens, 6522);

      // 2. Opus 4.6 -> Sonnet 4.6 (canonical)
      const p2 = computeBreakEvenCachedTokens({ currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6' });
      assert.equal(p2.breakEvenTokens, 4615);

      // 3. Fable 5.2 -> Opus 5.5
      // Num = 1500 * (40 - 20) = 30,000; Denom = 5.0 - 0.2 = 4.8; 30,000 / 4.8 = 6,250
      const p3 = computeBreakEvenCachedTokens({ currentModel: 'claude-fable-5-2', targetModel: 'claude-opus-5-5' });
      assert.equal(p3.breakEvenTokens, 6250);

      // 4. Sonnet 5.5 -> Haiku 5.5
      // Num = 1500 * (10 - 0.5) = 14,250; Denom = 0.125 - 0.10 = 0.025; 14,250 / 0.025 = 570,000
      const p4 = computeBreakEvenCachedTokens({ currentModel: 'claude-sonnet-5-5', targetModel: 'claude-haiku-5-5' });
      assert.equal(p4.breakEvenTokens, 570000);

      // 5. Sonnet 4.6 -> Haiku 4.5
      // Num = 1500 * (15 - 5) = 15,000; Denom = 1.25 - 0.3 = 0.95; 15,000 / 0.95 = 15,789
      const p5 = computeBreakEvenCachedTokens({ currentModel: 'claude-sonnet-4-6', targetModel: 'claude-haiku-4-5' });
      assert.equal(p5.breakEvenTokens, 15789);

      // 6. Cross-generation: Opus 5.5 -> Sonnet 4.6
      // Num = 1500 * (20 - 15) = 7500; Denom = 3.75 - 0.2 = 3.55; 7500 / 3.55 = 2,113
      const p6 = computeBreakEvenCachedTokens({ currentModel: 'claude-opus-5-5', targetModel: 'claude-sonnet-4-6' });
      assert.equal(p6.breakEvenTokens, 2113);

      // 7. Cross-generation: Opus 4.6 -> Sonnet 5.5
      // Num = 1500 * (25 - 10) = 22,500; Denom = 2.5 - 0.5 = 2.0; 22,500 / 2.0 = 11,250
      const p7 = computeBreakEvenCachedTokens({ currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-5-5' });
      assert.equal(p7.breakEvenTokens, 11250);

      // 8. Gemini 4 Carbon and Argon pairings
      // In the absence of Anthropic rates, Carbon and Argon resolve gracefully to default
      const p8 = computeBreakEvenCachedTokens({ currentModel: 'gemini-4-carbon', targetModel: 'gemini-4-argon' });
      assert.equal(p8.isCapabilityUpshift, true);
      assert.equal(p8.breakEvenTokens, 0);
      assert.equal(p8.shouldHoldModel, false);

      // 9. Gemini with explicit rate cards
      const geminiCarbonRates = { output: 20.0, read: 0.20, write5m: 4.0 };
      const geminiArgonRates = { output: 10.0, read: 0.10, write5m: 2.0 };
      const cStarGemini = calculateBreakEvenCStar(1500, geminiCarbonRates, geminiArgonRates);
      // Num = 1500 * (20 - 10) = 15,000; Denom = 2.0 - 0.2 = 1.8; 15,000 / 1.8 = 8,333
      assert.equal(cStarGemini, 8333);
    });

    it('identical model pairings return C* = 0 and shouldHold = false across all models', () => {
      const models = [
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
        'claude-fable-5-2',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
        'gemini-4-carbon',
        'gemini-4-argon'
      ];
      for (const m of models) {
        const res = computeBreakEvenCachedTokens({ currentModel: m, targetModel: m, cachedTokens: 50000 });
        assert.equal(res.breakEvenTokens, 0);
        assert.equal(res.shouldHoldModel, false);
      }
    });

    it('1-hour cache TTL tier correctly adjusts write rate and C*', () => {
      const res5m = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cacheTtlTier: '5m'
      });
      const res1h = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-5-5',
        targetModel: 'claude-sonnet-5-5',
        cacheTtlTier: '1h'
      });

      assert.equal(res5m.breakEvenTokens, 6522);
      assert.equal(res5m.writeMultiplierLabel, '1.25x');

      // 1h write is 4.00, read is 0.20; denom = 3.80; 15,000 / 3.80 = 3,947
      assert.equal(res1h.breakEvenTokens, 3947);
      assert.equal(res1h.writeMultiplierLabel, '2.0x');
    });
  });
});

// =========================================================================
// SECTION 2: cliffBreaker.mjs & DET-12 Empirical Stress Testing
// =========================================================================

describe('Challenger M3-1: cliffBreaker.mjs & DET-12 Empirical Stress Tests', () => {

  describe('2.1 Boundary Tests at Exact Token Thresholds', () => {
    const boundaries = [
      {
        tokens: 89_999,
        expectedBreakerAction: 'allow',
        expectedBreakerTriggered: false,
        expectedDet12Decision: 'allow',
        expectedDet12Triggered: false,
        expectedDet12Advisory: false
      },
      {
        tokens: 90_000,
        expectedBreakerAction: 'advisory',
        expectedBreakerTriggered: false,
        expectedDet12Decision: 'advise_compact',
        expectedDet12Triggered: true,
        expectedDet12Advisory: true
      },
      {
        tokens: 97_999,
        expectedBreakerAction: 'advisory',
        expectedBreakerTriggered: false,
        expectedDet12Decision: 'advise_compact',
        expectedDet12Triggered: true,
        expectedDet12Advisory: true
      },
      {
        tokens: 98_000,
        expectedBreakerAction: 'warn',
        expectedBreakerTriggered: true,
        expectedDet12Decision: 'deny',
        expectedDet12Triggered: true,
        expectedDet12Advisory: false
      },
      {
        tokens: 99_999,
        expectedBreakerAction: 'warn',
        expectedBreakerTriggered: true,
        expectedDet12Decision: 'deny',
        expectedDet12Triggered: true,
        expectedDet12Advisory: false
      },
      {
        tokens: 100_000,
        expectedBreakerAction: 'halt',
        expectedBreakerTriggered: true,
        expectedDet12Decision: 'deny',
        expectedDet12Triggered: true,
        expectedDet12Advisory: false
      },
      {
        tokens: 100_001,
        expectedBreakerAction: 'halt',
        expectedBreakerTriggered: true,
        expectedDet12Decision: 'deny',
        expectedDet12Triggered: true,
        expectedDet12Advisory: false
      },
      {
        tokens: 150_000,
        expectedBreakerAction: 'halt',
        expectedBreakerTriggered: true,
        expectedDet12Decision: 'deny',
        expectedDet12Triggered: true,
        expectedDet12Advisory: false
      }
    ];

    for (const b of boundaries) {
      it(`verifies threshold T = ${b.tokens.toLocaleString()} on Haiku 5.5 and Haiku 4.5`, () => {
        for (const model of ['claude-haiku-5-5', 'claude-haiku-4-5', 'CLAUDE-HAIKU-5-5']) {
          const breaker = checkHaiku100kCliffBreaker(model, b.tokens);
          assert.equal(breaker.action, b.expectedBreakerAction, `breaker action at ${b.tokens} for ${model}`);
          assert.equal(breaker.triggered, b.expectedBreakerTriggered, `breaker triggered at ${b.tokens} for ${model}`);

          const det12 = evaluateDet12HaikuPreCliffBreaker({ modelId: model, promptTokens: b.tokens });
          assert.equal(det12.decision, b.expectedDet12Decision, `det12 decision at ${b.tokens} for ${model}`);
          assert.equal(det12.triggered, b.expectedDet12Triggered, `det12 triggered at ${b.tokens} for ${model}`);
          assert.equal(det12.advisory, b.expectedDet12Advisory, `det12 advisory at ${b.tokens} for ${model}`);
        }
      });
    }
  });

  describe('2.2 Non-Haiku Models at 150,000 Tokens (Strict Exemption)', () => {
    const nonHaikuModels = [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-fable-5-2',
      'claude-fable-5-1',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'gemini-4-carbon',
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gpt-oss-120b',
      'unknown-model'
    ];

    for (const model of nonHaikuModels) {
      it(`strictly exempts ${model} at 150,000 tokens from DET-12 circuit breaker`, () => {
        assert.equal(isHaikuModel(model), false);

        const breaker = checkHaiku100kCliffBreaker(model, 150_000);
        assert.equal(breaker.triggered, false);
        assert.equal(breaker.action, 'allow');

        const det12 = evaluateDet12HaikuPreCliffBreaker({ modelId: model, promptTokens: 150_000 });
        assert.equal(det12.triggered, false);
        assert.equal(det12.decision, 'allow');
        assert.equal(det12.advisory, false);
      });
    }
  });

  describe('2.3 Prompt Envelope Components (uncached + cacheRead + cacheWrite)', () => {
    it('accurately computes prompt envelope from flat token breakdown across thresholds', () => {
      // 89,999 split: uncached 10k + read 70k + write 9,999 -> allow
      const r1 = evaluateDet12HaikuPreCliffBreaker({
        modelId: 'claude-haiku-5-5',
        uncachedInputTokens: 10_000,
        cacheReadTokens: 70_000,
        cacheWriteTokens: 9_999
      });
      assert.equal(r1.totalInputTokens, 89999);
      assert.equal(r1.decision, 'allow');
      assert.equal(r1.triggered, false);

      // 90,000 split: uncached 10k + read 70k + write 10k -> advise_compact
      const r2 = evaluateDet12HaikuPreCliffBreaker({
        modelId: 'claude-haiku-5-5',
        uncachedInputTokens: 10_000,
        cacheReadTokens: 70_000,
        cacheWriteTokens: 10_000
      });
      assert.equal(r2.totalInputTokens, 90000);
      assert.equal(r2.decision, 'advise_compact');
      assert.equal(r2.triggered, true);
      assert.equal(r2.advisory, true);

      // 97,999 split: uncached 20k + read 50k + write5m 10k + write1h 17,999 -> advise_compact
      const r3 = evaluateDet12HaikuPreCliffBreaker({
        modelId: 'claude-haiku-5-5',
        uncachedInputTokens: 20_000,
        cacheReadTokens: 50_000,
        cacheWrite5mTokens: 10_000,
        cacheWrite1hTokens: 17_999
      });
      assert.equal(r3.totalInputTokens, 97999);
      assert.equal(r3.decision, 'advise_compact');
      assert.equal(r3.triggered, true);

      // 98,000 split: uncached 20k + read 50k + write5m 10k + write1h 18,000 -> deny
      const r4 = evaluateDet12HaikuPreCliffBreaker({
        modelId: 'claude-haiku-5-5',
        uncachedInputTokens: 20_000,
        cacheReadTokens: 50_000,
        cacheWrite5mTokens: 10_000,
        cacheWrite1hTokens: 18_000
      });
      assert.equal(r4.totalInputTokens, 98000);
      assert.equal(r4.decision, 'deny');
      assert.equal(r4.triggered, true);
      assert.equal(r4.advisory, false);

      // 100,000 split: uncached 40k + read 50k + write5m 10k -> deny (and breaker halts)
      const r5 = evaluateDet12HaikuPreCliffBreaker({
        modelId: 'claude-haiku-5-5',
        uncachedInputTokens: 40_000,
        cacheReadTokens: 50_000,
        cacheWrite5mTokens: 10_000
      });
      assert.equal(r5.totalInputTokens, 100000);
      assert.equal(r5.decision, 'deny');
      assert.equal(r5.triggered, true);

      const breaker5 = checkHaiku100kCliffBreaker('claude-haiku-5-5', r5.totalInputTokens);
      assert.equal(breaker5.action, 'halt');
    });

    it('extracts nested Anthropic cache_creation object without double-counting', () => {
      const usage = {
        input_tokens: 15_000,
        cache_read_input_tokens: 45_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 20_000,
          ephemeral_1h_input_tokens: 18_000
        }
      };
      const total = computeTotalPromptTokens(usage);
      // 15k + 45k + 20k + 18k = 98,000 tokens
      assert.equal(total, 98000);

      const det12 = evaluateDet12HaikuPreCliffBreaker({
        modelId: 'claude-haiku-5-5',
        ...usage
      });
      assert.equal(det12.totalInputTokens, 98000);
      assert.equal(det12.decision, 'deny');
    });

    it('verifies thinking tokens are never added to prompt envelope', () => {
      const usage = {
        modelId: 'claude-haiku-5-5',
        uncachedInputTokens: 50_000,
        cacheReadTokens: 35_000,
        outputTokens: 5_000,
        thinkingTokens: 25_000
      };
      // Prompt tokens: 50k + 35k = 85k (< 90k threshold)
      // Thinking tokens (25k) belong to output, NOT prompt envelope
      const det12 = evaluateDet12HaikuPreCliffBreaker(usage);
      assert.equal(det12.totalInputTokens, 85000);
      assert.equal(det12.decision, 'allow');
      assert.equal(det12.triggered, false);
    });
  });

  describe('2.4 Edge Cases & Discrepancy Mining', () => {
    it('handles negative prompt tokens by clamping to 0', () => {
      const breaker = checkHaiku100kCliffBreaker('claude-haiku-5-5', -5000);
      assert.equal(breaker.triggered, false);
      assert.equal(breaker.action, 'allow');

      const det12 = evaluateDet12HaikuPreCliffBreaker({ modelId: 'claude-haiku-5-5', promptTokens: -5000 });
      assert.equal(det12.triggered, false);
      assert.equal(det12.decision, 'allow');
      assert.equal(det12.totalInputTokens, 0);
    });

    it('handles empty or missing model string safely', () => {
      const breaker = checkHaiku100kCliffBreaker(null, 150000);
      assert.equal(breaker.triggered, false);
      assert.equal(breaker.action, 'allow');

      const det12 = evaluateDet12HaikuPreCliffBreaker({ promptTokens: 150000 });
      assert.equal(det12.triggered, false);
      assert.equal(det12.decision, 'allow');
    });

    it('verifies NaN input handling unified between checkHaiku100kCliffBreaker and evaluateDet12HaikuPreCliffBreaker', () => {
      // checkHaiku100kCliffBreaker safely coerces NaN to 0 -> allow
      const breaker = checkHaiku100kCliffBreaker('claude-haiku-5-5', NaN);
      assert.equal(breaker.triggered, false);
      assert.equal(breaker.action, 'allow');

      // evaluateDet12HaikuPreCliffBreaker safely coerces NaN to 0 -> allow
      const det12 = evaluateDet12HaikuPreCliffBreaker({ modelId: 'claude-haiku-5-5', promptTokens: NaN });
      assert.equal(det12.totalInputTokens, 0);
      assert.equal(det12.triggered, false);
      assert.equal(det12.decision, 'allow');
    });
  });
});
