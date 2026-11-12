/**
 * @file src/core-isomorphic/economics/cliffBreaker.mjs
 * Feature 20: Haiku 100k 5x Cliff Breaker (DET-12).
 *
 * Implements:
 *   - Total prompt token envelope monitoring for Haiku models
 *   - Exemption of all non-Haiku models (Sonnet, Opus, Gemini, etc.)
 *   - 4-Tier trigger matrix:
 *       < 90k: allow (nominal)
 *       90k - 98k: advisory (advise_compact)
 *       98k - 100k: warn / deny (hard circuit breaker trip)
 *       >= 100k: halt / deny (emergency halt for 5x cost cliff)
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

import { computeTotalPromptTokens } from '../config/catalogLoader.mjs';

export const HAIKU_CLIFF_DETECTOR_ID = 'DET-12';

export const HAIKU_CLIFF_THRESHOLDS = Object.freeze({
  ADVISORY_TOKENS: 90000,
  BREAKER_TOKENS: 98000,
  CLIFF_TOKENS: 100000,
  PRICE_MULTIPLIER: 5.0
});

/**
 * Checks whether a given model string corresponds to an Anthropic Claude Haiku model.
 * @param {string} [modelId='']
 * @returns {boolean}
 */
export function isHaikuModel(modelId = '') {
  return String(modelId || '').toLowerCase().includes('haiku');
}

/**
 * Evaluates prompt token volume against the Haiku 100k 5x price cliff.
 *
 * @param {string} [modelId='']
 * @param {number} [promptTokens=0]
 * @returns {{
 *   triggered: boolean,
 *   threshold: number,
 *   action: 'allow' | 'advisory' | 'warn' | 'halt',
 *   reason: string
 * }}
 */
export function checkHaiku100kCliffBreaker(modelId = '', promptTokens = 0) {
  const isHaiku = isHaikuModel(modelId);
  const threshold = HAIKU_CLIFF_THRESHOLDS.BREAKER_TOKENS;
  const tokens = Math.max(0, Number(promptTokens) || 0);

  if (!isHaiku) {
    return {
      triggered: false,
      threshold,
      action: 'allow',
      reason: 'Non-Haiku model; 100k cliff check exempt'
    };
  }

  if (tokens >= HAIKU_CLIFF_THRESHOLDS.CLIFF_TOKENS) {
    return {
      triggered: true,
      threshold,
      action: 'halt',
      reason: `Prompt tokens (${tokens.toLocaleString()}) exceeded 100k 5x cost cliff`
    };
  }

  if (tokens >= threshold) {
    return {
      triggered: true,
      threshold,
      action: 'warn',
      reason: `Prompt tokens (${tokens.toLocaleString()}) reached Haiku cliff breaker threshold (${threshold})`
    };
  }

  if (tokens >= HAIKU_CLIFF_THRESHOLDS.ADVISORY_TOKENS) {
    return {
      triggered: false,
      threshold,
      action: 'advisory',
      reason: `Prompt tokens (${tokens.toLocaleString()}) approaching 90k advisory boundary`
    };
  }

  return {
    triggered: false,
    threshold,
    action: 'allow',
    reason: `Prompt tokens (${tokens.toLocaleString()}) within safe boundary`
  };
}

/**
 * Evaluates DET-12 Haiku Pre-Cliff Breaker conforming to canonical detector schema.
 *
 * @param {object} [params={}]
 * @param {string} [params.modelId='']
 * @param {number} [params.totalInputTokens]
 * @param {number} [params.promptTokens]
 * @returns {{
 *   detectorId: 'DET-12',
 *   triggered: boolean,
 *   decision: 'allow' | 'advise_compact' | 'deny',
 *   advisory: boolean,
 *   modelId: string,
 *   totalInputTokens: number,
 *   cliffThresholdTokens: 100000,
 *   reason: string
 * }}
 */
export function evaluateDet12HaikuPreCliffBreaker(params = {}) {
  const safeParams = (params && typeof params === 'object') ? params : {};
  const modelId = String(safeParams.modelId || '');

  // Extract candidate token volume, prioritizing totalInputTokens, then promptTokens, then computeTotalPromptTokens
  let candidate = safeParams.totalInputTokens;
  if (candidate === undefined || candidate === null || Number.isNaN(Number(candidate))) {
    candidate = safeParams.promptTokens;
  }
  if (candidate === undefined || candidate === null || Number.isNaN(Number(candidate))) {
    candidate = computeTotalPromptTokens(safeParams);
  }

  const totalTokens = Math.max(0, Number(candidate) || 0);

  const isHaiku = isHaikuModel(modelId);
  if (!isHaiku || totalTokens < HAIKU_CLIFF_THRESHOLDS.ADVISORY_TOKENS) {
    return {
      detectorId: HAIKU_CLIFF_DETECTOR_ID,
      triggered: false,
      decision: 'allow',
      advisory: false,
      modelId,
      totalInputTokens: totalTokens,
      cliffThresholdTokens: HAIKU_CLIFF_THRESHOLDS.CLIFF_TOKENS,
      reason: isHaiku
        ? `Haiku prompt size (${totalTokens.toLocaleString()}) is within safe volume (<90k).`
        : `Non-Haiku model (${modelId || 'unspecified'}); exempt from DET-12 100k cliff breaker.`
    };
  }

  const isHardDeny = totalTokens >= HAIKU_CLIFF_THRESHOLDS.BREAKER_TOKENS;
  return {
    detectorId: HAIKU_CLIFF_DETECTOR_ID,
    triggered: true,
    decision: isHardDeny ? 'deny' : 'advise_compact',
    advisory: !isHardDeny,
    modelId,
    totalInputTokens: totalTokens,
    cliffThresholdTokens: HAIKU_CLIFF_THRESHOLDS.CLIFF_TOKENS,
    reason: isHardDeny
      ? `[DET-12 Haiku Cliff Breaker] Prompt volume (${totalTokens.toLocaleString()} tokens) reached or exceeded 98k buffer. Tripping circuit breaker before 100k 5x price jump.`
      : `[DET-12 Haiku 90k Pre-Cliff Breaker] Prompt volume (${totalTokens.toLocaleString()} tokens) approaching 100k 5x cost cliff. Compact now to avoid 5x billing penalty.`
  };
}

/**
 * Convenience wrapper returning unified breaker decision.
 * @param {string} modelId
 * @param {number} promptTokens
 * @returns {object}
 */
export function evaluateHaikuCliffBreaker(modelId, promptTokens) {
  return checkHaiku100kCliffBreaker(modelId, promptTokens);
}
