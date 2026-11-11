import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgBridgeService } from '../ag_bridge.mjs';
import {
  MODEL_CATALOG,
  WARM_CACHE_GRAVITY_THRESHOLD_TOKENS,
  FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  EXPECTED_OUTPUT_TOKENS_BY_EFFORT,
  normalizeModelId,
  getModelFamily,
  isSameModelFamily,
  formatModelDisplayLabel,
  extractActiveTaskStep,
  inferLifecycleMode,
  classifyTaskComplexity,
  resolveReadDiscountFactor,
  computeClosedFormBreakEven,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
} from '../task_quota_router.mjs';

/**
 * Phase 2: Pre-Invocation Quota Router, Cache Gravity & Turn-Boundary Queue
 * (`src/core/coach/task_quota_router.mjs`)
 *
 * Enforces:
 *  - Invariant 2 (Hard Turn-Boundary Actuation): Queue `AUTO_PILOT` actuations in
 *    `TurnBoundaryActuationQueue` and dispatch ONLY when Language Server state is
 *    `IDLE`, `WAITING_FOR_USER`, or `WAITING_FOR_APPROVAL`.
 *  - Invariant 3 (Sticky Escalation / Hysteresis Lock): Lock elevated model/effort
 *    triggered by `DET-01` or `DET-02` until the active `task.md` step transitions
 *    from `[/]` to `[x]` OR `TRAJECTORY_REWIND` fires.
 *  - Invariant 4 (Zero-Token Determinism): <2ms local execution.
 */

export const COACH_MODES = Object.freeze({
  OFF: 'OFF',
  COACH: 'COACH',
  AUTO_PILOT: 'AUTO_PILOT'
});

export const SAFE_TURN_BOUNDARY_STATES = Object.freeze(new Set([
  'IDLE',
  'WAITING_FOR_USER',
  'WAITING_FOR_APPROVAL'
]));

export const COST_MULTIPLIER_MATRIX = Object.freeze({
  'gemini-3.8-flash': Object.freeze({ low: 1.0, med: 1.5, medium: 1.5, high: 2.2 }),
  'gemini-4-argon': Object.freeze({ low: 3.0, med: 5.5, medium: 5.5, high: 9.25 }),
  'gemini-4-carbon': Object.freeze({ low: 3.0, med: 5.5, medium: 5.5, high: 9.25 }),
  'gemini-4-carbon-cyber-permissive': Object.freeze({ low: 3.0, med: 5.5, medium: 5.5, high: 9.25 }),
  'claude-haiku-5-5': Object.freeze({ low: 0.5, med: 0.8, medium: 0.8, high: 1.2 }),
  'claude-haiku-5.5': Object.freeze({ low: 0.5, med: 0.8, medium: 0.8, high: 1.2 }),
  'claude-sonnet-5-5': Object.freeze({ low: 3.0, med: 4.5, medium: 4.5, high: 7.0 }),
  'claude-sonnet-5.5': Object.freeze({ low: 3.0, med: 4.5, medium: 4.5, high: 7.0 }),
  'claude-opus-5-5': Object.freeze({ low: 6.0, med: 9.0, medium: 9.0, high: 14.0 }),
  'claude-opus-5.5': Object.freeze({ low: 6.0, med: 9.0, medium: 9.0, high: 14.0 }),
  'claude-fable-5-2': Object.freeze({ low: 10.0, med: 15.0, medium: 15.0, high: 22.0 }),
  'claude-fable-5.2': Object.freeze({ low: 10.0, med: 15.0, medium: 15.0, high: 22.0 }),
  'claude-fable-5-1': Object.freeze({ low: 12.0, med: 18.0, medium: 18.0, high: 26.0 }),
  'claude-fable-5.1': Object.freeze({ low: 12.0, med: 18.0, medium: 18.0, high: 26.0 }),
  'claude-sonnet-4-6': Object.freeze({ low: 3.5, med: 5.0, medium: 5.0, high: 7.5 }),
  'claude-sonnet-4.6': Object.freeze({ low: 3.5, med: 5.0, medium: 5.0, high: 7.5 }),
  'claude-sonnet-4-5': Object.freeze({ low: 3.5, med: 5.0, medium: 5.0, high: 7.5 }),
  'claude-sonnet-4.5': Object.freeze({ low: 3.5, med: 5.0, medium: 5.0, high: 7.5 }),
  'claude-opus-4-6': Object.freeze({ low: 5.0, med: 8.5, medium: 8.5, high: 12.0 }),
  'claude-opus-4.6': Object.freeze({ low: 5.0, med: 8.5, medium: 8.5, high: 12.0 }),
  'claude-opus-4-5': Object.freeze({ low: 5.0, med: 8.5, medium: 8.5, high: 12.0 }),
  'claude-opus-4.5': Object.freeze({ low: 5.0, med: 8.5, medium: 8.5, high: 12.0 }),
  'claude-haiku-4-5': Object.freeze({ low: 1.2, med: 1.8, medium: 1.8, high: 2.5 }),
  'claude-haiku-4.5': Object.freeze({ low: 1.2, med: 1.8, medium: 1.8, high: 2.5 }),
  'gpt-oss-120b': Object.freeze({ low: 1.5, med: 2.5, medium: 2.5, high: 3.5 }),
  'local-gemma4-26b': Object.freeze({ low: 0.0, med: 0.0, medium: 0.0, high: 0.0 })
});

export function normalizeCoachMode(rawMode = 'COACH') {
  const upper = String(rawMode || 'COACH').toUpperCase().trim().replace(/[-\s]+/g, '_');
  if (upper === 'OFF' || upper === 'DISABLED') return COACH_MODES.OFF;
  if (upper === 'AUTO_PILOT' || upper === 'AUTOPILOT' || upper === 'AUTO') return COACH_MODES.AUTO_PILOT;
  return COACH_MODES.COACH;
}

export function normalizeEffortKey(rawEffort = 'high') {
  const lower = String(rawEffort || 'high').toLowerCase().trim();
  if (lower === 'low' || lower === 'min') return 'low';
  if (lower === 'med' || lower === 'medium') return 'med';
  return 'high';
}

export function getCostMultiplier(modelId = 'gemini-4-argon', effort = 'high') {
  const normModel = normalizeModelId(modelId);
  const effortKey = normalizeEffortKey(effort);
  const row = COST_MULTIPLIER_MATRIX[normModel] || COST_MULTIPLIER_MATRIX['gemini-4-argon'];
  return row[effortKey] ?? row.high;
}

export function getModelBaseWeight(modelId = 'gemini-4-argon') {
  const normModel = normalizeModelId(modelId);
  const row = COST_MULTIPLIER_MATRIX[normModel] || COST_MULTIPLIER_MATRIX['gemini-4-argon'];
  return row.low;
}

export function formatShortFamilyLabel(modelId = 'gemini-4-argon') {
  const family = getModelFamily(modelId);
  if (family === 'flash') return 'Flash';
  if (family === 'argon') return 'Argon';
  if (family === 'sonnet') return 'Sonnet';
  return family.charAt(0).toUpperCase() + family.slice(1);
}

export function formatTtlMinutesSeconds(ttlSeconds = 0) {
  const sec = Math.max(0, Math.floor(Number(ttlSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/**
 * Phase 2.2: `CacheGravityScorer`
 *
 * Computes the exact break-even token delta between keeping the current model family warm
 * at `low` effort versus switching to a different model family and paying a 100% cold prefill:
 *
 *   \Delta_{cost} = (T_{cached} * 0.05 * W_{M_{curr}} + T_{out} * E_{low})
 *                 - (T_{cached} * 1.00 * W_{M_{target}} + T_{out} * E_{target})
 *
 * Enforces the Cache-Gravity Invariant when `cachedTokens >= 60000` and `ttlRemainingSeconds > 0`.
 */
export class CacheGravityScorer {
  constructor(options = {}) {
    this.explicitWarmCacheThreshold =
      options.warmCacheThresholdTokens !== undefined && options.warmCacheThresholdTokens !== null
        ? Number(options.warmCacheThresholdTokens)
        : null;
    this.warmCacheThresholdTokens = Number(
      this.explicitWarmCacheThreshold ?? WARM_CACHE_GRAVITY_THRESHOLD_TOKENS
    );
  }

  computeBreakEven(params = {}) {
    return this.computeBreakEvenDelta(params);
  }

  /**
   * Computes exact closed-form break-even ($C^*$), break-even delta (\Delta_{cost}), and UI tooltip payload.
   */
  computeBreakEvenDelta({
    currentModel = 'gemini-4-argon',
    targetModel = 'gemini-3.8-flash',
    targetEffort = 'low',
    cachedTokens = 0,
    ttlRemainingSeconds = 0,
    cacheTtlSeconds = undefined,
    expectedOutputTokens = DEFAULT_EXPECTED_OUTPUT_TOKENS,
    uncachedDeltaTokens = 0,
    cacheTtlTier = '5m',
    readDiscountFactor = undefined,
    discountPct = undefined,
    cacheDiscount = undefined,
    pricingMode = 'auto',
    eventTimestampUtc = null
  } = {}) {
    const normCurrent = normalizeModelId(currentModel);
    const normTarget = normalizeModelId(targetModel);
    const normTargetEffort = normalizeEffortKey(targetEffort);
    const tCached = Math.max(0, Number(cachedTokens || 0));
    const ttlSec = Math.max(0, Number(ttlRemainingSeconds ?? cacheTtlSeconds ?? 0));
    const tOut = expectedOutputTokens !== null && expectedOutputTokens !== undefined
      ? Math.max(0, Number(expectedOutputTokens))
      : DEFAULT_EXPECTED_OUTPUT_TOKENS;

    const closedForm = computeClosedFormBreakEven({
      currentModel: normCurrent,
      targetModel: normTarget,
      targetEffort: normTargetEffort,
      cachedTokens: tCached,
      ttlRemainingSeconds: ttlSec,
      expectedOutputTokens: tOut,
      uncachedDeltaTokens,
      cacheTtlTier,
      readDiscountFactor,
      discountPct,
      cacheDiscount,
      pricingMode,
      eventTimestampUtc
    });

    const wCurr = getModelBaseWeight(normCurrent);
    const eLow = getCostMultiplier(normCurrent, 'low');
    const wTarget = getModelBaseWeight(normTarget);
    const eTarget = getCostMultiplier(normTarget, normTargetEffort);
    const readFactor = closedForm.readDiscountFactor;

    const warmCurrentLowCost = Number(((tCached * readFactor * wCurr) + (tOut * eLow)).toFixed(2));
    const coldTargetSwitchCost = Number(((tCached * 1.00 * wTarget) + (tOut * eTarget)).toFixed(2));

    // \Delta_{cost} = Warm(curr, low) - Cold(target, targetEffort)
    // Negative \Delta_{cost} means staying warm on currentModel-Low is cheaper than cold-switching to targetModel.
    const deltaCost = Number((warmCurrentLowCost - coldTargetSwitchCost).toFixed(2));
    const coldSwitchPenaltyTokens = Number((coldTargetSwitchCost - warmCurrentLowCost).toFixed(2));

    const hasWarmCacheGravity =
      ttlSec > 0 &&
      (this.explicitWarmCacheThreshold !== null
        ? tCached >= this.explicitWarmCacheThreshold
        : (closedForm.canHoldWarmPrefix && tCached > closedForm.breakEvenTokens));
    const crossFamily = !isSameModelFamily(normCurrent, normTarget);
    const blockCrossModelSwitch = hasWarmCacheGravity && crossFamily;

    const cachedK = (tCached / 1000).toFixed(1);
    const penaltyK = Math.round(Math.abs(coldSwitchPenaltyTokens) / 1000);
    const penaltySign = coldSwitchPenaltyTokens >= 0 ? '+' : '-';
    const targetShort = formatShortFamilyLabel(normTarget);
    const currShort = formatShortFamilyLabel(normCurrent);

    const tooltip = `Warm Cache: ${cachedK}k tokens (TTL ${formatTtlMinutesSeconds(ttlSec)}) • Cold ${targetShort} switch costs ${penaltySign}${penaltyK}k equiv burn vs ${currShort}-Low`;

    return {
      mode: closedForm.mode,
      currentModel: normCurrent,
      targetModel: normTarget,
      targetEffort: normTargetEffort,
      cachedTokens: tCached,
      ttlRemainingSeconds: ttlSec,
      expectedOutputTokens: tOut,
      readDiscountFactor: readFactor,
      breakEvenTokens: closedForm.breakEvenTokens,
      canHoldWarmPrefix: closedForm.canHoldWarmPrefix,
      denominator: closedForm.denominator,
      wCurr,
      eLow,
      wTarget,
      eTarget,
      warmCurrentLowCost,
      coldTargetSwitchCost,
      deltaCost,
      coldSwitchPenaltyTokens,
      hasWarmCacheGravity,
      blockCrossModelSwitch,
      recommendedAction: blockCrossModelSwitch
        ? 'DOWNSHIFT_EFFORT_SAME_MODEL_OR_SPAWN_FLASH_SUBAGENT'
        : (crossFamily ? 'SWITCH_MODEL_FAMILY' : 'MODULATE_EFFORT_SAME_MODEL'),
      recommendedModel: blockCrossModelSwitch ? normCurrent : normTarget,
      recommendedEffort: blockCrossModelSwitch ? 'low' : normTargetEffort,
      tooltip
    };
  }

  /**
   * Backward-compatible effective cost method used by existing Phase 5 callers.
   */
  computeEffectiveCost({
    candidateModel,
    candidateEffort,
    activeModel = 'gemini-4-argon',
    cachedTokens = 0,
    cacheTtlSeconds = 0,
    ttlRemainingSeconds = undefined,
    uncachedDeltaTokens = 2000,
    expectedOutputTokens = null
  } = {}) {
    const normCandidateModel = normalizeModelId(candidateModel);
    const normActiveModel = normalizeModelId(activeModel);
    const rawEffort = String(candidateEffort || 'high').toLowerCase();
    const effortKey = rawEffort === 'medium' ? 'medium' : normalizeEffortKey(rawEffort);
    const ttlSec = Math.max(0, Number(ttlRemainingSeconds ?? cacheTtlSeconds ?? 0));

    const multiplier = MODEL_CATALOG[normCandidateModel]?.multipliers?.[effortKey === 'med' ? 'medium' : effortKey]
      ?? getCostMultiplier(normCandidateModel, effortKey);
    const isCacheWarm = ttlSec > 0 && Number(cachedTokens) > 0;
    const sameModelIndicator = isCacheWarm && isSameModelFamily(normCandidateModel, normActiveModel) ? 1 : 0;

    const tCached = Math.max(0, Number(cachedTokens || 0));
    const tUncachedDelta = Math.max(0, Number(uncachedDeltaTokens || 0));
    const eOutput = expectedOutputTokens !== null && expectedOutputTokens !== undefined
      ? Number(expectedOutputTokens)
      : (EXPECTED_OUTPUT_TOKENS_BY_EFFORT[effortKey === 'med' ? 'medium' : effortKey] || DEFAULT_EXPECTED_OUTPUT_TOKENS);

    const readFactor = resolveReadDiscountFactor(normActiveModel, { totalPromptTokens: tCached });
    const cachedTerm = sameModelIndicator * (readFactor * tCached);
    const coldPrefillTerm = (1 - sameModelIndicator) * tCached;
    const effectiveTokens = cachedTerm + coldPrefillTerm + tUncachedDelta + eOutput;
    const effectiveQuotaCost = Number((multiplier * effectiveTokens).toFixed(2));

    return {
      model: normCandidateModel,
      effort: effortKey === 'med' ? 'medium' : effortKey,
      multiplier,
      sameModelIndicator,
      isCacheWarm,
      cachedTokens: tCached,
      uncachedDeltaTokens: tUncachedDelta,
      expectedOutputTokens: eOutput,
      readDiscountFactor: readFactor,
      cachedTerm: Number(cachedTerm.toFixed(2)),
      coldPrefillTerm: Number(coldPrefillTerm.toFixed(2)),
      effectiveTokens: Number(effectiveTokens.toFixed(2)),
      effectiveQuotaCost
    };
  }

  /**
   * Evaluates candidate routes and enforces dynamic Closed-Form Cache-Gravity Invariant.
   */
  evaluateCandidates(context = {}) {
    const activeModel = normalizeModelId(context.activeModel || 'gemini-4-argon');
    const activeEffort = String(context.activeEffort || 'high').toLowerCase();
    const cachedTokens = Math.max(0, Number(context.cachedTokens || 0));
    const ttlSec = Math.max(0, Number(context.ttlRemainingSeconds ?? context.cacheTtlSeconds ?? 0));
    const uncachedDeltaTokens = Math.max(0, Number(context.uncachedDeltaTokens ?? 2000));
    const complexityTier = String(context.complexityTier || 'LOW').toUpperCase();
    const confidence = Number(context.confidence ?? 0.90);

    const defaultDownshiftPeer = activeModel === 'claude-opus-5-5'
      ? 'claude-sonnet-5-5'
      : (activeModel === 'claude-opus-4-6'
        ? 'claude-sonnet-4-6'
        : (activeModel === 'claude-opus-4-5'
          ? 'claude-sonnet-4-5'
          : (activeModel.startsWith('claude-fable') ? 'claude-opus-5-5' : 'gemini-3.8-flash')));

    const breakEven = this.computeBreakEvenDelta({
      currentModel: activeModel,
      targetModel: context.targetModel || defaultDownshiftPeer,
      targetEffort: 'low',
      cachedTokens,
      ttlRemainingSeconds: ttlSec,
      expectedOutputTokens: context.expectedOutputTokens ?? DEFAULT_EXPECTED_OUTPUT_TOKENS
    });

    const hasWarmCacheGravity = breakEven.hasWarmCacheGravity;

    const baselineCost = this.computeEffectiveCost({
      candidateModel: activeModel,
      candidateEffort: activeEffort,
      activeModel,
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      uncachedDeltaTokens
    });

    const sameModelLowCost = this.computeEffectiveCost({
      candidateModel: activeModel,
      candidateEffort: 'low',
      activeModel,
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      uncachedDeltaTokens
    });

    const coldSwitchToFlashCost = this.computeEffectiveCost({
      candidateModel: 'gemini-3.8-flash',
      candidateEffort: 'low',
      activeModel,
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      uncachedDeltaTokens
    });

    let primaryRecommendation = null;
    let subagentOffloadOption = null;
    let localOffloadOption = null;
    let policyApplied = 'COLD_OR_LOW_CACHE_OPTIMAL';

    if (hasWarmCacheGravity && activeModel !== 'gemini-3.8-flash') {
      const targetSameModelEffort = complexityTier === 'HIGH' ? 'high' : 'low';
      const targetCostObj = targetSameModelEffort === 'low' ? sameModelLowCost : baselineCost;
      const multiplierSavingsPct = baselineCost.multiplier > 0
        ? Math.max(0, Math.round(((baselineCost.multiplier - targetCostObj.multiplier) / baselineCost.multiplier) * 100))
        : 0;
      const effectiveSavingsPct = baselineCost.effectiveQuotaCost > 0
        ? Math.max(0, Math.round(((baselineCost.effectiveQuotaCost - targetCostObj.effectiveQuotaCost) / baselineCost.effectiveQuotaCost) * 100))
        : 0;

      primaryRecommendation = {
        action: 'MODULATE_EFFORT_SAME_MODEL',
        model: activeModel,
        effort: targetSameModelEffort,
        multiplier: targetCostObj.multiplier,
        effectiveQuotaCost: targetCostObj.effectiveQuotaCost,
        preservesWarmCache: true,
        coldPrefillPenaltyAvoidedTokens: cachedTokens,
        multiplierSavingsPct,
        effectiveSavingsPct,
        tooltip: breakEven.tooltip,
        label: `Drop to ${formatModelDisplayLabel(activeModel)} • ${targetSameModelEffort.toUpperCase()} (Keep ${(cachedTokens / 1000).toFixed(1)}k Cache, Save ${Math.max(multiplierSavingsPct, effectiveSavingsPct)}%)`
      };
      policyApplied = 'RULE_A_MODULATE_SAME_MODEL_EFFORT';

      if (complexityTier === 'LOW' && confidence >= FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD) {
        subagentOffloadOption = {
          action: 'SPAWN_FLASH_SUBAGENT',
          model: 'gemini-3.8-flash',
          effort: 'low',
          multiplier: 1.0,
          contextBudgetTokens: 2000,
          preservesMainSessionCache: true,
          label: '⚡ Offload to Flash-Low Subagent (<2k ctx)'
        };
        localOffloadOption = {
          action: 'OFFLOAD_LOCAL_LITERT',
          model: 'local-gemma4-26b',
          effort: 'low',
          multiplier: 0.0,
          effectiveQuotaCost: 0,
          preservesMainSessionCache: true,
          label: '⚡ Offload to Local LiteRT Gemma 4 26B (0.0x quota)'
        };
        policyApplied = 'RULE_A_AND_B_WARM_CACHE_WITH_SUBAGENT_OFFLOAD';
      }
    } else {
      const frontierDefault = activeModel.includes('carbon') ? activeModel : 'gemini-4-argon';
      let targetModel = activeModel;
      let targetEffort = activeEffort;
      if (complexityTier === 'LOW' && confidence >= FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD) {
        targetModel = 'gemini-3.8-flash';
        targetEffort = 'low';
      } else if (complexityTier === 'MEDIUM') {
        targetModel = ttlSec === 0 && cachedTokens >= this.warmCacheThresholdTokens
          ? 'gemini-3.8-flash'
          : frontierDefault;
        targetEffort = 'medium';
      } else {
        targetModel = frontierDefault;
        targetEffort = 'high';
      }

      const targetCostObj = this.computeEffectiveCost({
        candidateModel: targetModel,
        candidateEffort: targetEffort,
        activeModel,
        cachedTokens,
        cacheTtlSeconds: ttlSec,
        uncachedDeltaTokens
      });

      primaryRecommendation = {
        action: targetModel !== activeModel ? 'SWITCH_MODEL_FAMILY' : 'MODULATE_EFFORT_SAME_MODEL',
        model: targetModel,
        effort: targetEffort,
        multiplier: targetCostObj.multiplier,
        effectiveQuotaCost: targetCostObj.effectiveQuotaCost,
        preservesWarmCache: isSameModelFamily(targetModel, activeModel) && ttlSec > 0,
        coldPrefillPenaltyAvoidedTokens: 0,
        tooltip: breakEven.tooltip,
        label: `Switch to ${formatModelDisplayLabel(targetModel)} • ${targetEffort.toUpperCase()} (${targetCostObj.multiplier}x)`
      };
    }

    return {
      hasWarmCacheGravity,
      policyApplied,
      breakEven,
      tooltip: breakEven.tooltip,
      baseline: baselineCost,
      sameModelLowCost,
      coldSwitchToFlashCost,
      primaryRecommendation,
      subagentOffloadOption,
      localOffloadOption
    };
  }
}

/**
 * Phase 2.3a: `HysteresisLock` (Invariant 3 — Sticky Escalation)
 *
 * When `DET-01` or `DET-02` triggers a tier escalation, locks the elevated model/effort
 * for `activeTaskMdStepId`. Rejects downshift recommendations until:
 *  1. `TaskMdDirectiveWatcher` observes that step marked `[x]`, OR
 *  2. `TrajectoryWatcher` emits a `TRAJECTORY_REWIND` event.
 */
export class HysteresisLock {
  constructor() {
    this.locked = false;
    this.activeTaskMdStepId = null;
    this.lockedModel = null;
    this.lockedEffort = null;
    this.triggerDetectorId = null;
    this.reason = null;
    this.engagedAtTurn = null;
    this.lastUnlockReason = null;
  }

  engage({
    stepId = 'active-step',
    model = 'gemini-4-argon',
    effort = 'high',
    detectorId = 'DET-01',
    reason = 'Circuit breaker tier escalation',
    turnIndex = 0
  } = {}) {
    this.locked = true;
    this.activeTaskMdStepId = String(stepId || 'active-step');
    this.lockedModel = normalizeModelId(model);
    this.lockedEffort = normalizeEffortKey(effort);
    this.triggerDetectorId = String(detectorId || 'DET-01');
    this.reason = String(reason || '');
    this.engagedAtTurn = Number(turnIndex || 0);
    this.lastUnlockReason = null;
    return this.getStatus();
  }

  isLocked() {
    return Boolean(this.locked);
  }

  /**
   * Returns true if a proposed candidate (model, effort) is a downshift below the locked tier.
   */
  shouldBlockDownshift({ candidateModel, candidateEffort } = {}) {
    if (!this.locked) return false;
    const lockedMult = getCostMultiplier(this.lockedModel, this.lockedEffort);
    const candidateMult = getCostMultiplier(candidateModel || this.lockedModel, candidateEffort || 'low');
    return candidateMult < lockedMult;
  }

  /**
   * Evaluates `task.md` content or parsed directives and unlocks ONLY when `activeTaskMdStepId`
   * transitions from `[/]` to `[x]`.
   */
  onTaskMdUpdate(taskMdInput = '') {
    if (!this.locked) {
      return { unlocked: false, locked: false, reason: null };
    }

    if (typeof taskMdInput === 'string') {
      const lines = taskMdInput.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const completedMatch = line.match(/^\s*-\s*\[[xX]\]\s*(.+)$/);
        if (completedMatch) {
          const text = completedMatch[1].trim();
          const lineId = `line-${i + 1}`;
          if (
            this.activeTaskMdStepId === lineId ||
            text.includes(this.activeTaskMdStepId) ||
            this.activeTaskMdStepId.includes(text)
          ) {
            return this.unlock('TASK_MD_STEP_COMPLETED');
          }
        }
      }
    } else if (taskMdInput && typeof taskMdInput === 'object') {
      if (taskMdInput.completedStepId && taskMdInput.completedStepId === this.activeTaskMdStepId) {
        return this.unlock('TASK_MD_STEP_COMPLETED');
      }
      if (Array.isArray(taskMdInput.allDirectives)) {
        const match = taskMdInput.allDirectives.find((item) =>
          item.status === 'COMPLETED' &&
          (`line-${item.lineNumber}` === this.activeTaskMdStepId ||
            item.text.includes(this.activeTaskMdStepId) ||
            this.activeTaskMdStepId.includes(item.text))
        );
        if (match) {
          return this.unlock('TASK_MD_STEP_COMPLETED');
        }
      }
    }

    return { unlocked: false, locked: true, reason: null };
  }

  /**
   * Unlocks immediately when `TrajectoryWatcher` emits `TRAJECTORY_REWIND`.
   */
  onTrajectoryRewind(rewindPayload = {}) {
    if (!this.locked) {
      return { unlocked: false, locked: false, reason: 'ALREADY_UNLOCKED' };
    }
    return this.unlock('TRAJECTORY_REWIND', rewindPayload);
  }

  unlock(reason = 'MANUAL_RESET', metadata = null) {
    this.locked = false;
    this.lastUnlockReason = String(reason);
    const prevStep = this.activeTaskMdStepId;
    this.activeTaskMdStepId = null;
    return {
      unlocked: true,
      locked: false,
      previousStepId: prevStep,
      reason: this.lastUnlockReason,
      metadata
    };
  }

  getStatus() {
    return {
      locked: this.locked,
      activeTaskMdStepId: this.activeTaskMdStepId,
      lockedModel: this.lockedModel,
      lockedEffort: this.lockedEffort,
      triggerDetectorId: this.triggerDetectorId,
      reason: this.reason,
      lastUnlockReason: this.lastUnlockReason
    };
  }
}

/**
 * Phase 2.3b: `TurnBoundaryActuationQueue` (Invariant 2 — Hard Turn-Boundary Actuation)
 *
 * Never fires `SET_MODEL_AND_EFFORT` RPC/commands mid-stream while tools are executing.
 * Queues actuations while Language Server state is `STREAMING`, `EXECUTING_TOOLS`, or `BUSY`
 * and dispatches ONLY when state is `IDLE`, `WAITING_FOR_USER`, or `WAITING_FOR_APPROVAL`.
 */
export class TurnBoundaryActuationQueue {
  constructor(options = {}) {
    this.languageServerState = String(options.languageServerState || 'IDLE').toUpperCase();
    this.queue = [];
    this.dispatchedHistory = [];
    this.dispatcher = typeof options.dispatcher === 'function' ? options.dispatcher : null;
  }

  isTurnBoundarySafe(state = this.languageServerState) {
    return SAFE_TURN_BOUNDARY_STATES.has(String(state || '').toUpperCase());
  }

  /**
   * Enqueues an actuation request or dispatches it immediately if the Language Server
   * is currently at a safe turn boundary (`IDLE`, `WAITING_FOR_USER`, `WAITING_FOR_APPROVAL`).
   */
  async enqueueOrDispatch(actuationPayload, customDispatcher = null) {
    const dispatchFn = customDispatcher || this.dispatcher;
    const item = {
      id: `act-${Date.now()}-${this.queue.length + 1}`,
      payload: actuationPayload,
      enqueuedAtState: this.languageServerState,
      dispatchFn
    };

    if (!this.isTurnBoundarySafe(this.languageServerState)) {
      this.queue.push(item);
      return {
        queued: true,
        actuated: false,
        languageServerState: this.languageServerState,
        queueLength: this.queue.length,
        payload: actuationPayload
      };
    }

    let dispatchResult = null;
    if (typeof dispatchFn === 'function') {
      dispatchResult = await dispatchFn(actuationPayload);
    }

    const isBlocked = Boolean(
      dispatchResult &&
      (dispatchResult.ok === false || dispatchResult.allowed === false || dispatchResult.transportUsed === 'blocked_cdp')
    );
    const record = {
      queued: false,
      actuated: !isBlocked,
      method: isBlocked ? 'blocked_cdp' : (dispatchResult?.transportUsed || 'rpc'),
      ...(isBlocked
        ? { reason: dispatchResult.cdpBlockedReason || dispatchResult.reason || 'EXPERIMENTAL_CDP_DISABLED' }
        : {}),
      languageServerState: this.languageServerState,
      payload: actuationPayload,
      dispatchResult
    };
    this.dispatchedHistory.push(record);
    return record;
  }

  /**
   * Transitions the Language Server state and automatically flushes queued actuations
   * when entering `IDLE`, `WAITING_FOR_USER`, or `WAITING_FOR_APPROVAL`.
   */
  async setLanguageServerState(newState) {
    this.languageServerState = String(newState || 'IDLE').toUpperCase();
    if (this.isTurnBoundarySafe(this.languageServerState) && this.queue.length > 0) {
      return this.flush();
    }
    return {
      flushed: false,
      flushedCount: 0,
      languageServerState: this.languageServerState,
      remainingQueueLength: this.queue.length,
      results: []
    };
  }

  async flush() {
    if (!this.isTurnBoundarySafe(this.languageServerState)) {
      return {
        flushed: false,
        flushedCount: 0,
        languageServerState: this.languageServerState,
        remainingQueueLength: this.queue.length,
        results: []
      };
    }

    const pending = this.queue.splice(0, this.queue.length);
    const results = [];
    for (const item of pending) {
      let dispatchResult = null;
      if (typeof item.dispatchFn === 'function') {
        dispatchResult = await item.dispatchFn(item.payload);
      }
      const isBlocked = Boolean(
        dispatchResult &&
        (dispatchResult.ok === false || dispatchResult.allowed === false || dispatchResult.transportUsed === 'blocked_cdp')
      );
      const record = {
        queued: false,
        actuated: !isBlocked,
        method: isBlocked ? 'blocked_cdp' : (dispatchResult?.transportUsed || 'rpc'),
        ...(isBlocked
          ? { reason: dispatchResult.cdpBlockedReason || dispatchResult.reason || 'EXPERIMENTAL_CDP_DISABLED' }
          : {}),
        languageServerState: this.languageServerState,
        payload: item.payload,
        dispatchResult
      };
      this.dispatchedHistory.push(record);
      results.push(record);
    }

    return {
      flushed: results.length > 0,
      flushedCount: results.length,
      languageServerState: this.languageServerState,
      remainingQueueLength: this.queue.length,
      results
    };
  }

  clear() {
    this.queue = [];
  }
}

/**
 * Phase 2 Unified Flight Computer & Coach Router (`TaskQuotaRouter`)
 */
export class TaskQuotaRouter {
  constructor(options = {}) {
    this.mode = normalizeCoachMode(options.mode || COACH_MODES.COACH);
    this.activeModel = normalizeModelId(options.activeModel || 'gemini-4-argon');
    this.activeEffort = normalizeEffortKey(options.activeEffort || 'high');
    this.cacheGravityScorer = options.cacheGravityScorer || new CacheGravityScorer(options);
    this.hysteresisLock = options.hysteresisLock || new HysteresisLock();
    this.agBridge = options.agBridge || new AgBridgeService(options);
    this.turnBoundaryQueue = options.turnBoundaryQueue || new TurnBoundaryActuationQueue({
      languageServerState: options.languageServerState || 'IDLE',
      dispatcher: async (payload) => {
        const res = await this.agBridge.sendChatCommand(payload.sessionId || 'default', payload, options);
        if (res && res.ok !== false) {
          this.activeModel = payload.model;
          this.activeEffort = payload.effort;
        }
        return res;
      }
    });
  }

  setMode(mode) {
    this.mode = normalizeCoachMode(mode);
    return this.mode;
  }

  async evaluateTurn({
    sessionId = 'default',
    currentModel = this.activeModel,
    currentEffort = this.activeEffort,
    targetModel = 'gemini-3.8-flash',
    targetEffort = 'low',
    cachedTokens = 0,
    ttlRemainingSeconds = 0,
    expectedOutputTokens = DEFAULT_EXPECTED_OUTPUT_TOKENS,
    activeTaskMdStepId = 'step-1',
    det01Triggered = false,
    det02Triggered = false,
    languageServerState = null
  } = {}) {
    if (languageServerState) {
      await this.turnBoundaryQueue.setLanguageServerState(languageServerState);
    }

    // 1. Check DET-01 / DET-02 tier escalation -> engage HysteresisLock
    if (det01Triggered || det02Triggered) {
      const detectorId = det01Triggered ? 'DET-01' : 'DET-02';
      const normCurr = normalizeModelId(currentModel);
      const escalatedModel = normCurr.includes('carbon') ? normCurr : 'gemini-4-argon';
      this.hysteresisLock.engage({
        stepId: activeTaskMdStepId,
        model: escalatedModel,
        effort: 'high',
        detectorId,
        reason: `${detectorId} loop escalation`
      });
    }

    // 2. If HysteresisLock is engaged, block any downshift below locked tier
    if (
      this.hysteresisLock.isLocked() &&
      this.hysteresisLock.shouldBlockDownshift({ candidateModel: targetModel, candidateEffort: targetEffort })
    ) {
      return {
        mode: this.mode,
        blockedByHysteresis: true,
        hysteresisStatus: this.hysteresisLock.getStatus(),
        recommendedModel: this.hysteresisLock.lockedModel,
        recommendedEffort: this.hysteresisLock.lockedEffort,
        actuated: false,
        queued: false
      };
    }

    // 3. Evaluate CacheGravityScorer break-even math & 60k warm cache lock
    const breakEven = this.cacheGravityScorer.computeBreakEvenDelta({
      currentModel,
      targetModel,
      targetEffort,
      cachedTokens,
      ttlRemainingSeconds,
      expectedOutputTokens
    });

    const safeModel = breakEven.recommendedModel;
    const safeEffort = breakEven.recommendedEffort;

    if (this.mode === COACH_MODES.OFF) {
      return {
        mode: this.mode,
        blockedByHysteresis: false,
        breakEven,
        recommendedModel: safeModel,
        recommendedEffort: safeEffort,
        actuated: false,
        queued: false
      };
    }

    if (this.mode === COACH_MODES.COACH) {
      return {
        mode: this.mode,
        blockedByHysteresis: false,
        breakEven,
        recommendedModel: safeModel,
        recommendedEffort: safeEffort,
        tooltip: breakEven.tooltip,
        actuated: false,
        queued: false
      };
    }

    // 4. AUTO_PILOT mode: route through TurnBoundaryActuationQueue (Invariant 2)
    const commandPayload = {
      type: 'SET_MODEL_AND_EFFORT',
      sessionId,
      model: safeModel,
      effort: safeEffort,
      preserveWarmCache: breakEven.blockCrossModelSwitch
    };

    const queueRes = await this.turnBoundaryQueue.enqueueOrDispatch(commandPayload);

    return {
      mode: this.mode,
      blockedByHysteresis: false,
      breakEven,
      recommendedModel: safeModel,
      recommendedEffort: safeEffort,
      tooltip: breakEven.tooltip,
      actuated: queueRes.actuated,
      method: queueRes.method || (queueRes.queued ? 'queued_turn_boundary' : 'rpc'),
      ...(queueRes.reason ? { reason: queueRes.reason } : {}),
      queued: queueRes.queued,
      languageServerState: queueRes.languageServerState,
      queueResult: queueRes
    };
  }
}

export function evaluateCacheGravity(params = {}) {
  const scorer = new CacheGravityScorer(params);
  return scorer.computeBreakEvenDelta(params);
}

export {
  MODEL_CATALOG,
  WARM_CACHE_GRAVITY_THRESHOLD_TOKENS,
  FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  EXPECTED_OUTPUT_TOKENS_BY_EFFORT,
  normalizeModelId,
  getModelFamily,
  isSameModelFamily,
  formatModelDisplayLabel,
  extractActiveTaskStep,
  inferLifecycleMode,
  classifyTaskComplexity,
  computeClosedFormBreakEven,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
};

export default {
  COACH_MODES,
  COST_MULTIPLIER_MATRIX,
  SAFE_TURN_BOUNDARY_STATES,
  CacheGravityScorer,
  HysteresisLock,
  TurnBoundaryActuationQueue,
  TaskQuotaRouter,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute,
  evaluateCacheGravity,
  computeClosedFormBreakEven,
  getCostMultiplier,
  getModelBaseWeight,
  classifyTaskComplexity
};
