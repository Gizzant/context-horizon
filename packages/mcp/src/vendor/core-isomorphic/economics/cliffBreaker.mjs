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

export const GEMINI_PRO_200K_CLIFF_THRESHOLDS = Object.freeze({
  ADVISORY_TOKENS: 180000,
  BREAKER_TOKENS: 196000,
  CLIFF_TOKENS: 200000,
  INPUT_MULTIPLIER: 2.0,
  OUTPUT_MULTIPLIER: 1.5,
  PRICE_MULTIPLIER: 2.0
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
 * Checks whether a given model string corresponds to Gemini 3.1 Pro or Gemini 2.5 Pro
 * (subject to the 200,000-token 2x input / 1.5x output pricing cliff).
 * @param {string} [modelId='']
 * @returns {boolean}
 */
export function isGeminiPro200kCliffModel(modelId = '') {
  const lower = String(modelId || '').toLowerCase().trim();
  return /gemini[-_.\s]*(?:3[._-]1|2[._-]5)[-_.\s]*pro\b/.test(lower);
}

/**
 * Resolves parameterized pricing cliff metadata for models with stepped prompt pricing
 * (Claude Haiku 5.5 at 100K 5x, Gemini 3.1/2.5 Pro at 200K 2x input / 1.5x output).
 * Returns `null` for models without a prompt pricing cliff (Sonnet, Opus, Fable, Gemini 4, Flash).
 *
 * @param {string} [modelId='']
 * @returns {{
 *   family: 'haiku' | 'gemini-pro',
 *   advisoryTokens: number,
 *   breakerTokens: number,
 *   cliffTokens: number,
 *   inputMultiplier: number,
 *   outputMultiplier: number,
 *   priceMultiplier: number,
 *   label: string
 * } | null}
 */
export function resolveModelCliffSpec(modelId = '') {
  if (isHaikuModel(modelId)) {
    return {
      family: 'haiku',
      advisoryTokens: HAIKU_CLIFF_THRESHOLDS.ADVISORY_TOKENS,
      breakerTokens: HAIKU_CLIFF_THRESHOLDS.BREAKER_TOKENS,
      cliffTokens: HAIKU_CLIFF_THRESHOLDS.CLIFF_TOKENS,
      inputMultiplier: HAIKU_CLIFF_THRESHOLDS.PRICE_MULTIPLIER,
      outputMultiplier: HAIKU_CLIFF_THRESHOLDS.PRICE_MULTIPLIER,
      priceMultiplier: HAIKU_CLIFF_THRESHOLDS.PRICE_MULTIPLIER,
      label: 'Haiku 100k 5x cost cliff'
    };
  }
  if (isGeminiPro200kCliffModel(modelId)) {
    return {
      family: 'gemini-pro',
      advisoryTokens: GEMINI_PRO_200K_CLIFF_THRESHOLDS.ADVISORY_TOKENS,
      breakerTokens: GEMINI_PRO_200K_CLIFF_THRESHOLDS.BREAKER_TOKENS,
      cliffTokens: GEMINI_PRO_200K_CLIFF_THRESHOLDS.CLIFF_TOKENS,
      inputMultiplier: GEMINI_PRO_200K_CLIFF_THRESHOLDS.INPUT_MULTIPLIER,
      outputMultiplier: GEMINI_PRO_200K_CLIFF_THRESHOLDS.OUTPUT_MULTIPLIER,
      priceMultiplier: GEMINI_PRO_200K_CLIFF_THRESHOLDS.PRICE_MULTIPLIER,
      label: 'Gemini Pro 200k 2x input / 1.5x output cliff'
    };
  }
  return null;
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
  const projectedDelta = Math.max(0, Number(safeParams.projectedDeltaTokens) || 0);
  const effectiveTokens = totalTokens + projectedDelta;

  const cliffSpec = resolveModelCliffSpec(modelId);
  if (!cliffSpec || effectiveTokens < cliffSpec.advisoryTokens) {
    return {
      detectorId: HAIKU_CLIFF_DETECTOR_ID,
      triggered: false,
      decision: 'allow',
      advisory: false,
      modelId,
      totalInputTokens: effectiveTokens,
      cliffThresholdTokens: cliffSpec ? cliffSpec.cliffTokens : HAIKU_CLIFF_THRESHOLDS.CLIFF_TOKENS,
      reason: cliffSpec
        ? `${cliffSpec.family === 'haiku' ? 'Haiku' : 'Gemini Pro'} prompt size (${effectiveTokens.toLocaleString()}) is within safe volume (<${Math.round(cliffSpec.advisoryTokens / 1000)}k).`
        : `Non-cliff model (${modelId || 'unspecified'}); exempt from DET-12 pricing cliff breaker.`
    };
  }

  const isHardDeny = effectiveTokens >= cliffSpec.breakerTokens;
  const breakerLabelK = Math.round(cliffSpec.breakerTokens / 1000);
  const advisoryLabelK = Math.round(cliffSpec.advisoryTokens / 1000);
  const cliffLabelK = Math.round(cliffSpec.cliffTokens / 1000);
  const multDesc =
    cliffSpec.family === 'haiku'
      ? '5x price jump'
      : '2x input / 1.5x output price jump';

  const familyTag = cliffSpec.family === 'haiku' ? 'Haiku' : 'Gemini Pro';

  return {
    detectorId: HAIKU_CLIFF_DETECTOR_ID,
    triggered: true,
    decision: isHardDeny ? 'deny' : 'advise_compact',
    advisory: !isHardDeny,
    modelId,
    totalInputTokens: effectiveTokens,
    cliffThresholdTokens: cliffSpec.cliffTokens,
    cliffSpec,
    reason: isHardDeny
      ? `[DET-12 ${familyTag} Cliff Breaker] Prompt volume (${effectiveTokens.toLocaleString()} tokens) reached or exceeded ${breakerLabelK}k buffer. Tripping circuit breaker before ${cliffLabelK}k ${multDesc}.`
      : `[DET-12 ${familyTag} ${advisoryLabelK}k Pre-Cliff Breaker] Prompt volume (${effectiveTokens.toLocaleString()} tokens) approaching ${cliffLabelK}k ${multDesc}. Compact now to avoid stepped billing penalty.`
  };
}

/**
 * Parameterized cross-provider pricing cliff breaker (`Haiku 5.5` 100K 5x + `Gemini 3.1/2.5 Pro` 200K 2x/1.5x).
 * @param {object} [params={}]
 */
export function evaluateParameterizedCliffBreaker(params = {}) {
  return evaluateDet12HaikuPreCliffBreaker(params);
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
