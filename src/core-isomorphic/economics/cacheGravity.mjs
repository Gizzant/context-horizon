/**
 * @file src/core-isomorphic/economics/cacheGravity.mjs
 * Feature 19: Algebraic C* Break-Even Cache Gravity Router.
 *
 * Implements the exact algebraic cross-model break-even equation:
 *   C* = [ O * (P_out,curr - P_out,target) + Delta_uncached * (P_write,curr - P_write,target) ]
 *        / [ P_write,target - P_read,curr ]
 *
 * Canonical test values at O = 1,500, Delta = 0:
 *   - Opus 5.5 -> Sonnet 5.5: C* = 6,522 tokens
 *   - Opus 4.6 -> Sonnet 4.6: C* = 4,615 tokens
 *
 * Boundary rules:
 *   - Capability upshift (P_out,curr <= P_out,target): C* = 0, shouldHold = false
 *   - Cheaper target write than current read (P_write,target <= P_read,curr): C* = Infinity
 *   - Identical models: C* = 0, shouldHold = false
 *   - Cold cache (cachedTokens = 0, cacheWarm = false): switch is cheaper if target is cheaper
 *   - Warm cache (cachedTokens > C*): shouldHold = true
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

import {
  normalizeModelId,
  computeTotalPromptTokens,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';

export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1500;

export const EXPECTED_OUTPUT_TOKENS_BY_EFFORT = Object.freeze({
  low: 800,
  medium: 1500,
  high: 3500,
  max: 6000
});

export const FLIGHT_MODES = Object.freeze({
  OFF: 'OFF',
  SILENT: 'SILENT',
  COACH: 'COACH',
  AUTO_PILOT: 'AUTO_PILOT'
});

export const MODEL_BREAK_EVEN_RATES = Object.freeze({
  'claude-opus-5-5': { output: 20.0, read: 0.2, write5m: 5.0, write1h: 8.0 },
  'claude-sonnet-5-5': { output: 10.0, read: 0.1, write5m: 2.5, write1h: 4.0 },
  'claude-opus-4-6': { output: 25.0, read: 0.5, write5m: 6.25, write1h: 10.0 },
  'claude-sonnet-4-6': { output: 15.0, read: 0.3, write5m: 3.75, write1h: 6.0 },
  'claude-haiku-5-5': { output: 0.5, read: 0.01, write5m: 0.125, write1h: 0.2 },
  'claude-haiku-4-5': { output: 5.0, read: 0.10, write5m: 1.25, write1h: 2.0 },
  'claude-fable-5-2': { output: 40.0, read: 0.20, write5m: 10.0, write1h: 16.0 },
  'claude-fable-5-1': { output: 50.0, read: 0.25, write5m: 12.5, write1h: 20.0 }
});

/**
 * Maps an active model to its natural one-tier downshift peer.
 * @param {string} [modelId='claude-opus-5-5']
 * @returns {string}
 */
export function resolveNaturalDownshiftPeer(modelId = 'claude-opus-5-5') {
  const norm = normalizeModelId(modelId);
  switch (norm) {
    case 'claude-fable-5-2':
    case 'claude-fable-5-1':
      return 'claude-opus-5-5';
    case 'claude-opus-5-5':
      return 'claude-sonnet-5-5';
    case 'claude-opus-4-6':
      return 'claude-sonnet-4-6';
    case 'claude-sonnet-5-5':
      return 'claude-haiku-5-5';
    case 'claude-sonnet-4-6':
      return 'claude-haiku-4-5';
    case 'claude-haiku-4-5':
    case 'claude-haiku-5-5':
      return 'claude-haiku-5-5';
    default:
      return 'claude-sonnet-5-5';
  }
}

/**
 * Closed-form break-even equation computation.
 *
 * @param {number} expectedOutputTokens O
 * @param {number} pOutCurr P_out,curr
 * @param {number} pOutTarget P_out,target
 * @param {number} pWriteTarget P_write,target
 * @param {number} pReadCurr P_read,curr
 * @param {number} [uncachedDeltaTokens=0] Delta_uncached
 * @param {number} [pWriteCurr=pWriteTarget] P_write,curr
 * @returns {number} C* (rounded integer, 0 for upshifts, Infinity if write <= read)
 */
export function computeClosedFormBreakEven(
  expectedOutputTokens,
  pOutCurr,
  pOutTarget,
  pWriteTarget,
  pReadCurr,
  uncachedDeltaTokens = 0,
  pWriteCurr = pWriteTarget
) {
  if (pOutCurr <= pOutTarget) {
    return 0; // Capability upshift
  }

  const numerator =
    expectedOutputTokens * (pOutCurr - pOutTarget) +
    uncachedDeltaTokens * (pWriteCurr - pWriteTarget);

  const denominator = pWriteTarget - pReadCurr;

  if (numerator <= 0) {
    return 0;
  }
  if (denominator <= 0) {
    return Infinity;
  }

  return Math.round(numerator / denominator);
}

/**
 * Calculates the exact algebraic break-even token count C*.
 * Supports invocation via options object or positional arguments.
 *
 * Canonical test values:
 *   - Opus 5.5 -> Sonnet 5.5 (default): C* = 6,522
 *   - Opus 4.6 -> Sonnet 4.6: C* = 4,615
 *
 * @param {object|number} [optionsOrOutputTokens={}]
 * @param {object} [maybeRatesCurr]
 * @param {object} [maybeRatesTarget]
 * @returns {number}
 */
export function calculateBreakEvenCStar(optionsOrOutputTokens = {}, maybeRatesCurr, maybeRatesTarget) {
  let expectedOutputTokens = DEFAULT_EXPECTED_OUTPUT_TOKENS;
  let pOutCurr = 20.0;
  let pOutTarget = 10.0;
  let pWrite5mTarget = 2.5;
  let pReadCurr = 0.2;
  let uncachedDeltaTokens = 0;
  let pWriteCurr = 5.0;

  if (typeof optionsOrOutputTokens === 'number') {
    expectedOutputTokens = Math.max(0, optionsOrOutputTokens);
    if (maybeRatesCurr && typeof maybeRatesCurr === 'object') {
      pOutCurr = Number(maybeRatesCurr.output ?? maybeRatesCurr.outputPer1M ?? maybeRatesCurr.pOut ?? pOutCurr);
      pReadCurr = Number(maybeRatesCurr.read ?? maybeRatesCurr.readPer1M ?? maybeRatesCurr.pRead ?? pReadCurr);
      pWriteCurr = Number(maybeRatesCurr.write5m ?? maybeRatesCurr.write5mPer1M ?? maybeRatesCurr.write ?? pWriteCurr);
    }
    if (maybeRatesTarget && typeof maybeRatesTarget === 'object') {
      pOutTarget = Number(maybeRatesTarget.output ?? maybeRatesTarget.outputPer1M ?? maybeRatesTarget.pOut ?? pOutTarget);
      pWrite5mTarget = Number(
        maybeRatesTarget.write5m ??
        maybeRatesTarget.write5mPer1M ??
        maybeRatesTarget.write ??
        maybeRatesTarget.pWrite5m ??
        pWrite5mTarget
      );
    }
  } else if (typeof optionsOrOutputTokens === 'object' && optionsOrOutputTokens !== null) {
    const opts = optionsOrOutputTokens;
    if (opts.expectedOutputTokens !== undefined || opts.O !== undefined) {
      const rawO = Number(opts.expectedOutputTokens ?? opts.O);
      expectedOutputTokens = Number.isFinite(rawO) ? Math.max(0, rawO) : DEFAULT_EXPECTED_OUTPUT_TOKENS;
    }
    if (opts.uncachedDeltaTokens !== undefined) {
      const rawDelta = Number(opts.uncachedDeltaTokens);
      uncachedDeltaTokens = Number.isFinite(rawDelta) ? Math.max(0, rawDelta) : 0;
    }

    const curModel = opts.currentModel ? normalizeModelId(opts.currentModel) : null;
    const tgtModel = opts.targetModel ? normalizeModelId(opts.targetModel) : null;

    if (curModel && MODEL_BREAK_EVEN_RATES[curModel]) {
      const m = MODEL_BREAK_EVEN_RATES[curModel];
      pOutCurr = m.output;
      pReadCurr = m.read;
      pWriteCurr = m.write5m;
    }
    if (tgtModel && MODEL_BREAK_EVEN_RATES[tgtModel]) {
      const m = MODEL_BREAK_EVEN_RATES[tgtModel];
      pOutTarget = m.output;
      pWrite5mTarget = m.write5m;
    }

    const rc = opts.ratesCurr || opts.currentRates;
    if (rc && typeof rc === 'object') {
      pOutCurr = Number(rc.output ?? rc.outputPer1M ?? rc.pOut ?? pOutCurr);
      pReadCurr = Number(rc.read ?? rc.readPer1M ?? rc.pRead ?? pReadCurr);
      pWriteCurr = Number(rc.write5m ?? rc.write5mPer1M ?? rc.write ?? pWriteCurr);
    }
    const rt = opts.ratesTarget || opts.targetRates;
    if (rt && typeof rt === 'object') {
      pOutTarget = Number(rt.output ?? rt.outputPer1M ?? rt.pOut ?? pOutTarget);
      pWrite5mTarget = Number(
        rt.write5m ??
        rt.write5mPer1M ??
        rt.write ??
        rt.pWrite5m ??
        pWrite5mTarget
      );
    }

    if (opts.pOutCurr !== undefined) pOutCurr = Number(opts.pOutCurr);
    if (opts.pOutTarget !== undefined) pOutTarget = Number(opts.pOutTarget);
    if (opts.pWrite5mTarget !== undefined) pWrite5mTarget = Number(opts.pWrite5mTarget);
    if (opts.pReadCurr !== undefined) pReadCurr = Number(opts.pReadCurr);
  }

  return computeClosedFormBreakEven(
    expectedOutputTokens,
    pOutCurr,
    pOutTarget,
    pWrite5mTarget,
    pReadCurr,
    uncachedDeltaTokens,
    pWriteCurr
  );
}

/**
 * Computes exact break-even token thresholds and USD turn costs for staying on current vs switching.
 *
 * @param {object} [params={}]
 * @param {string} [params.currentModel='claude-opus-5-5']
 * @param {string} [params.targetModel='claude-sonnet-5-5']
 * @param {number} [params.expectedOutputTokens=1500]
 * @param {number} [params.cachedTokens=0]
 * @param {number} [params.uncachedDeltaTokens=0]
 * @param {boolean} [params.cacheWarm]
 * @param {'5m'|'1h'} [params.cacheTtlTier='5m']
 * @param {object} [options={}]
 * @returns {object}
 */
export function computeBreakEvenCachedTokens(params = {}, options = {}) {
  const rawCurrentModel = params.currentModel || 'claude-opus-5-5';
  const rawTargetModel = params.targetModel || 'claude-sonnet-5-5';
  const currentModel = normalizeModelId(rawCurrentModel);
  const targetModel = normalizeModelId(rawTargetModel);
  const rawExpected = Number(params.expectedOutputTokens ?? DEFAULT_EXPECTED_OUTPUT_TOKENS);
  const expectedOutputTokens = Number.isFinite(rawExpected) ? Math.max(0, rawExpected) : DEFAULT_EXPECTED_OUTPUT_TOKENS;
  const rawCached = Number(params.cachedTokens ?? 0);
  const cachedTokens = Number.isFinite(rawCached) ? Math.max(0, rawCached) : 0;
  const rawUncached = Number(params.uncachedDeltaTokens ?? 0);
  const uncachedDeltaTokens = Number.isFinite(rawUncached) ? Math.max(0, rawUncached) : 0;
  const cacheWarm = params.cacheWarm !== undefined ? Boolean(params.cacheWarm) : cachedTokens > 0;
  const ttlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';

  const totalPromptTokens = Math.max(
    cachedTokens + uncachedDeltaTokens,
    computeTotalPromptTokens(params)
  );
  const currRates = resolveEffectiveRates(rawCurrentModel, totalPromptTokens, options);
  const targetRates = resolveEffectiveRates(rawTargetModel, totalPromptTokens, options);

  const pOutCurr = currRates.outputPer1M;
  const pOutTarget = targetRates.outputPer1M;
  const pReadCurr = currRates.readPer1M;
  const pWriteCurr = ttlTier === '1h' ? currRates.write1hPer1M : currRates.write5mPer1M;
  const pWriteTarget = ttlTier === '1h' ? targetRates.write1hPer1M : targetRates.write5mPer1M;

  const isCapabilityUpshift = pOutCurr <= pOutTarget;

  let breakEvenTokens = 0;
  if (currentModel === targetModel || isCapabilityUpshift) {
    breakEvenTokens = 0;
  } else {
    breakEvenTokens = computeClosedFormBreakEven(
      expectedOutputTokens,
      pOutCurr,
      pOutTarget,
      pWriteTarget,
      pReadCurr,
      uncachedDeltaTokens,
      pWriteCurr
    );
  }

  // Exact USD turn cost if staying on currentModel
  const stayPrefixCostUSD = cacheWarm
    ? (cachedTokens / 1_000_000) * pReadCurr + (uncachedDeltaTokens / 1_000_000) * pWriteCurr
    : ((cachedTokens + uncachedDeltaTokens) / 1_000_000) * pWriteCurr;
  const stayOutputCostUSD = (expectedOutputTokens / 1_000_000) * pOutCurr;
  const stayOnCurrentModelUSD = stayPrefixCostUSD + stayOutputCostUSD;

  // Switching to a different model invalidates isolated cache, forcing cold write
  const switchPrefixCostUSD =
    currentModel === targetModel && cacheWarm
      ? stayPrefixCostUSD
      : ((cachedTokens + uncachedDeltaTokens) / 1_000_000) * pWriteTarget;
  const switchOutputCostUSD = (expectedOutputTokens / 1_000_000) * pOutTarget;
  const switchToTargetModelUSD = switchPrefixCostUSD + switchOutputCostUSD;

  const coldWritePenaltyUSD = Number(
    (switchToTargetModelUSD - stayOnCurrentModelUSD).toFixed(6)
  );

  const shouldHoldModel = Boolean(
    currentModel !== targetModel &&
      !isCapabilityUpshift &&
      cacheWarm &&
      coldWritePenaltyUSD > 0 &&
      cachedTokens > breakEvenTokens
  );

  return {
    currentModel,
    targetModel,
    expectedOutputTokens,
    cachedTokens,
    uncachedDeltaTokens,
    totalPromptTokens,
    cacheWarm,
    cacheTtlTier: ttlTier,
    writeMultiplierLabel: ttlTier === '1h' ? '2.0x' : '1.25x',
    isCapabilityUpshift,
    breakEvenTokens,
    rates: {
      currentOutputPer1M: pOutCurr,
      targetOutputPer1M: pOutTarget,
      currentReadPer1M: pReadCurr,
      currentWritePer1M: pWriteCurr,
      targetWritePer1M: pWriteTarget
    },
    stayOnCurrentModelUSD,
    switchToTargetModelUSD,
    coldWritePenaltyUSD,
    shouldHold: shouldHoldModel,
    shouldHoldModel
  };
}

/**
 * Evaluates cache gravity recommendation for flight controller.
 *
 * @param {object} params
 * @param {object} [options={}]
 * @returns {object}
 */
export function evaluateCacheGravity(params = {}, options = {}) {
  const result = computeBreakEvenCachedTokens(params, options);
  const recommendation = result.shouldHoldModel ? 'STAY_ON_CURRENT' : 'SWITCH_TO_TARGET';
  return {
    ...result,
    recommendation,
    action: result.shouldHoldModel ? 'hold' : 'allow'
  };
}
