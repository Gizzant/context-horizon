/**
 * @file src/core-isomorphic/coach/effortShiftDetector.mjs
 * Passive Turn-Boundary Effort-Shift Detector (`PostEffortChange` equivalent).
 *
 * Pure zero-I/O module (safe for in-process Claude Code Mod runtime in `hooks/register.js`):
 * - Tracks mid-session `/effort` shifts when Claude Code lacks `PreEffortChange`.
 * - Attributes prefix rewrite penalties (`DET-09`) on cache-invalidating `4.6` models
 *   (both explicit effort changes and inferred whole-prefix rewrites).
 * - Preserves zero-noise silence on cache-safe `5.5+` models for single high-effort turns,
 *   while flagging consecutive routine-turn thinking spikes (`DET-21`) with a 3-turn cooldown.
 */

import {
  isKnownCatalogModel,
  normalizeModelId,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';
import { getEffortMutationCacheCapability } from './cacheGravityRouter.mjs';

export const WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS = 50000;
export const ROUTINE_THINKING_SPIKE_MIN_TOKENS = 4000;
export const ROUTINE_THINKING_TO_OUTPUT_RATIO = 4;
export const EFFORT_ADVISORY_COOLDOWN_TURNS = 3;

const EFFORT_ALIASES = Object.freeze({
  low: 'low',
  medium: 'medium',
  med: 'medium',
  normal: 'medium',
  high: 'high',
  max: 'max',
  xhigh: 'max'
});

/**
 * Normalizes a raw effort string (`low | med | medium | normal | high | max | xhigh`)
 * to canonical values (`low | medium | high | max`), or `null` if absent/unrecognized.
 *
 * @param {unknown} raw
 * @returns {'low'|'medium'|'high'|'max'|null}
 */
export function normalizeEffortLevel(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  return EFFORT_ALIASES[cleaned] || null;
}

/**
 * Extracts normalized `{ effortLevel, thinkingBudget }` from Mod, `statusLine`,
 * or `UserPromptSubmit` event payloads.
 *
 * @param {object} [payload={}]
 * @returns {{ effortLevel: 'low'|'medium'|'high'|'max'|null, thinkingBudget: number|null }}
 */
export function extractEventEffortObservation(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return { effortLevel: null, thinkingBudget: null };
  }

  const rawEffortCandidates = [
    payload.effort,
    payload.effortLevel,
    payload.effort_level,
    payload.reasoningEffort,
    payload.reasoning_effort,
    payload.model?.effort,
    payload.config?.effortLevel,
    payload.settings?.effortLevel,
    payload.result?.effort
  ];

  let effortLevel = null;
  for (const candidate of rawEffortCandidates) {
    const normalized = normalizeEffortLevel(candidate);
    if (normalized) {
      effortLevel = normalized;
      break;
    }
  }

  const rawBudget =
    payload.thinkingBudget ??
    payload.thinking_budget ??
    payload.thinking?.budget_tokens ??
    null;
  let thinkingBudget = null;
  if (rawBudget !== null && rawBudget !== undefined && rawBudget !== '') {
    const parsedBudget = Number(rawBudget);
    if (Number.isFinite(parsedBudget) && parsedBudget >= 0) {
      thinkingBudget = parsedBudget;
    }
  }

  return { effortLevel, thinkingBudget };
}

/**
 * Creates a clean initial effort-tracking state object for session telemetry.
 *
 * @returns {{
 *   currentEffort: string|null,
 *   previousEffort: string|null,
 *   currentThinkingBudget: number|null,
 *   shiftCount: number,
 *   highEffortRoutineStreak: number,
 *   lastShiftTurn: number|null,
 *   lastAdvisoryTurn: number|null,
 *   pendingAdvisory: object|null
 * }}
 */
export function createInitialEffortTrackingState() {
  return {
    currentEffort: null,
    previousEffort: null,
    currentThinkingBudget: null,
    shiftCount: 0,
    highEffortRoutineStreak: 0,
    lastShiftTurn: null,
    lastAdvisoryTurn: null,
    pendingAdvisory: null
  };
}

/**
 * Updates turn-boundary effort tracking and evaluates `DET-09` rewrite attribution
 * or `DET-21` routine-turn high-effort thinking spike advisories.
 *
 * @param {object|null|undefined} prevTracking
 * @param {object} [observation={}]
 * @param {object} [options={}]
 * @returns {object} Updated effort tracking snapshot
 */
export function applyTurnEffortObservation(prevTracking, observation = {}, options = {}) {
  const tracking = {
    ...createInitialEffortTrackingState(),
    ...(prevTracking && typeof prevTracking === 'object' ? prevTracking : {})
  };

  const modelId = observation.modelId || observation.rawModelId || 'claude-sonnet-5-5';
  const rawModelId = observation.rawModelId || modelId;
  const normObserved = normalizeEffortLevel(observation.observedEffort);
  const observedThinkingBudget =
    observation.observedThinkingBudget !== undefined && observation.observedThinkingBudget !== null
      ? Number(observation.observedThinkingBudget)
      : null;
  if (Number.isFinite(observedThinkingBudget) && observedThinkingBudget >= 0) {
    tracking.currentThinkingBudget = observedThinkingBudget;
  }

  const turnIndex = Math.max(1, Number(observation.turnIndex ?? 1) || 1);
  const priorTurnsCompleted = Math.max(0, Number(observation.priorTurnsCompleted ?? 0) || 0);
  const priorModelId = observation.priorModelId || null;
  const priorWarmPrefixTokens = Math.max(0, Number(observation.priorWarmPrefixTokens || 0));
  const priorCacheWarm = Boolean(observation.priorCacheWarm);
  const cacheReadTokens = Math.max(0, Number(observation.cacheReadTokens || 0));
  const cacheWriteTokens = Math.max(0, Number(observation.cacheWriteTokens || 0));
  const outputTokens = Math.max(0, Number(observation.outputTokens || 0));
  const thinkingTokens = Math.max(0, Number(observation.thinkingTokens || 0));
  const turnMutations = Number(observation.turnMutations ?? 0) || 0;
  const ttlTier = observation.ttlTier === '1h' ? '1h' : '5m';

  let explicitShift = false;
  if (normObserved) {
    if (tracking.currentEffort === null) {
      if (priorTurnsCompleted >= 1 && options.treatFirstObservationAfterStartAsShift === true) {
        explicitShift = true;
      } else {
        tracking.currentEffort = normObserved;
      }
    } else if (normObserved !== tracking.currentEffort) {
      explicitShift = true;
    }
  }

  const knownModel = isKnownCatalogModel(rawModelId, options);
  const normalizedModel = knownModel
    ? normalizeModelId(rawModelId, options)
    : String(rawModelId || 'unknown');
  const effortCap = getEffortMutationCacheCapability(rawModelId, options);

  const normalizedPriorModel =
    priorModelId && isKnownCatalogModel(priorModelId, options)
      ? normalizeModelId(priorModelId, options)
      : priorModelId
        ? String(priorModelId)
        : null;

  const inferredLegacy46Rewrite = Boolean(
    !explicitShift &&
      effortCap.invalidatesCache === 'yes' &&
      priorCacheWarm === true &&
      priorWarmPrefixTokens >= WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS &&
      normalizedPriorModel &&
      normalizedPriorModel === normalizedModel &&
      cacheReadTokens === 0 &&
      cacheWriteTokens >= WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS * 0.8
  );

  if (explicitShift || inferredLegacy46Rewrite) {
    const fromEffort = tracking.currentEffort;
    const toEffort = normObserved || tracking.currentEffort;
    tracking.shiftCount += 1;
    tracking.previousEffort = fromEffort;
    tracking.currentEffort = toEffort;
    tracking.lastShiftTurn = turnIndex;

    if (!knownModel || effortCap.invalidatesCache === 'unknown') {
      if (priorWarmPrefixTokens >= WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS) {
        tracking.pendingAdvisory = {
          advisoryId: `eff-${turnIndex}-${tracking.shiftCount}`,
          detectorId: 'DET-09',
          subType: 'POST_EFFORT_UNVERIFIED',
          modelId: String(rawModelId),
          fromEffort,
          toEffort,
          cachePreserved: null,
          rewritePenaltyUSD: null,
          message: `[Highbeam DET-09] Interactive /effort shift (${fromEffort || 'prior'} -> ${toEffort || 'new'}) detected over ${(priorWarmPrefixTokens / 1000).toFixed(1)}k warm tokens on ${rawModelId} (effort cache behavior unverified; prices/impact unverified).`
        };
      }
    } else if (effortCap.invalidatesCache === 'yes') {
      if (priorWarmPrefixTokens >= WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS) {
        const warmTokens = Math.max(priorWarmPrefixTokens, inferredLegacy46Rewrite ? cacheWriteTokens : 0);
        const rates = resolveEffectiveRates(
          rawModelId,
          Math.max(priorWarmPrefixTokens, cacheWriteTokens),
          options
        );
        const writeRate = ttlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;
        const rewritePenaltyUSD = Number(
          Math.max(0, (warmTokens / 1_000_000) * (writeRate - rates.readPer1M)).toFixed(6)
        );
        tracking.pendingAdvisory = {
          advisoryId: `eff-${turnIndex}-${tracking.shiftCount}`,
          detectorId: 'DET-09',
          subType: 'POST_EFFORT_CACHE_REWRITE',
          modelId: normalizedModel,
          fromEffort,
          toEffort,
          cachePreserved: false,
          inferredFromRewrite: Boolean(inferredLegacy46Rewrite && !explicitShift),
          rewritePenaltyUSD,
          message: `[Highbeam DET-09] Mid-session /effort shift${explicitShift ? ` (${fromEffort} -> ${toEffort})` : ''} rewrote ${(warmTokens / 1000).toFixed(1)}k warm prefix tokens (+$${rewritePenaltyUSD.toFixed(2)} USD) on ${rates.label}. Batch /effort changes with /compact or upgrade to 5.5+ (99.3% cache-safe).`
        };
      }
    } else if (
      (toEffort === 'high' || toEffort === 'max') &&
      priorWarmPrefixTokens >= WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS
    ) {
      tracking.lastCacheSafeShift = {
        turnIndex,
        fromEffort,
        toEffort,
        preservedTokens: priorWarmPrefixTokens
      };
    }
  }

  const hasUsageObservation =
    observation.evaluateThinkingSpike !== false &&
    (thinkingTokens > 0 || outputTokens > 0 || observation.hasTurnUsage === true);

  const highEffortOrThinkingSpike =
    tracking.currentEffort === 'high' ||
    tracking.currentEffort === 'max' ||
    thinkingTokens >= ROUTINE_THINKING_SPIKE_MIN_TOKENS * 1.5;

  if (hasUsageObservation) {
    if (highEffortOrThinkingSpike) {
      const isRoutineSpike =
        turnMutations <= 1 &&
        thinkingTokens >= ROUTINE_THINKING_SPIKE_MIN_TOKENS &&
        thinkingTokens >= ROUTINE_THINKING_TO_OUTPUT_RATIO * Math.max(1, outputTokens);

      if (isRoutineSpike) {
        tracking.highEffortRoutineStreak += 1;
      } else {
        tracking.highEffortRoutineStreak = 0;
      }

      if (
        tracking.highEffortRoutineStreak >= 2 &&
        (tracking.lastAdvisoryTurn === null ||
          turnIndex - tracking.lastAdvisoryTurn >= EFFORT_ADVISORY_COOLDOWN_TURNS)
      ) {
        tracking.lastAdvisoryTurn = turnIndex;
        tracking.pendingAdvisory = {
          advisoryId: `spk-${turnIndex}-${tracking.highEffortRoutineStreak}`,
          detectorId: 'DET-21',
          subType: 'HIGH_EFFORT_ROUTINE_SPIKE',
          modelId: normalizedModel,
          fromEffort: tracking.previousEffort,
          toEffort: tracking.currentEffort || 'high',
          cachePreserved: effortCap.invalidatesCache === 'no',
          rewritePenaltyUSD: 0,
          message: `[Highbeam DET-21] ${tracking.highEffortRoutineStreak} consecutive routine turns burned ${(thinkingTokens / 1000).toFixed(1)}k thinking tokens vs ${outputTokens} output tokens at /effort ${tracking.currentEffort || 'high'}. Consider '/effort medium' for routine reads/edits (KV cache remains preserved on 5.5+).`
        };
      }
    } else {
      tracking.highEffortRoutineStreak = 0;
    }
  }

  return tracking;
}

export default {
  WARM_EFFORT_ATTRIBUTION_FLOOR_TOKENS,
  ROUTINE_THINKING_SPIKE_MIN_TOKENS,
  ROUTINE_THINKING_TO_OUTPUT_RATIO,
  EFFORT_ADVISORY_COOLDOWN_TURNS,
  normalizeEffortLevel,
  extractEventEffortObservation,
  createInitialEffortTrackingState,
  applyTurnEffortObservation
};
