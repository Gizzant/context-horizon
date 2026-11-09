import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgBridgeService } from './ag_bridge.mjs';

/**
 * Upgraded Phase 5: Task Model & Multi-Tier Quota Router
 * ("Floor is the Guarantee" + CacheGravityScorer + TaskMdDirectiveWatcher + ModelSelectorActuator)
 *
 * Zero-trust local execution (<5ms classification, <2ms task.md directive parse,
 * zero external API or network calls).
 */

export const WARM_CACHE_GRAVITY_THRESHOLD_TOKENS = 60000;
export const FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD = 0.85;

export const MODEL_CATALOG = {
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    family: 'flash',
    label: 'Gemini 3.8 Flash',
    multipliers: { low: 1.0, medium: 1.0, high: 1.5 }
  },
  'gemini-3.8-pro': {
    id: 'gemini-3.8-pro',
    family: 'pro',
    label: 'Gemini 3.8 Pro',
    multipliers: { low: 2.0, medium: 3.5, high: 5.0 }
  },
  'gemini-4-argon': {
    id: 'gemini-4-argon',
    family: 'argon',
    label: 'Gemini 4 Argon',
    multipliers: { low: 3.0, medium: 6.0, high: 9.25 }
  },
  'claude-sonnet-4.6': {
    id: 'claude-sonnet-4.6',
    family: 'sonnet',
    label: 'Claude Sonnet 4.6',
    multipliers: { low: 3.0, medium: 5.0, high: 7.5 }
  },
  'local-gemma4-26b': {
    id: 'local-gemma4-26b',
    family: 'local',
    label: 'Local LiteRT Gemma 4 26B',
    multipliers: { low: 0.0, medium: 0.0, high: 0.0 }
  }
};

export const EXPECTED_OUTPUT_TOKENS_BY_EFFORT = {
  low: 1200,
  medium: 3500,
  high: 8500
};

const LOW_COMPLEXITY_PATTERNS = [
  /\bfix\s+typo\b/i,
  /\btypo\b/i,
  /\brename\b/i,
  /\bformat\b/i,
  /\badd\s+docstring\b/i,
  /\bdocstring\b/i,
  /\bwrite\s+fixture\b/i,
  /\btest\s+fixture\b/i,
  /\bupdate\s+readme\b/i,
  /\bupdate\s+comment\b/i,
  /\bbump\s+version\b/i,
  /\bfix\s+lint\b/i,
  /\bsort\s+imports\b/i,
  /\bexport\s+constant\b/i
];

const HIGH_COMPLEXITY_PATTERNS = [
  /\barchitect\b/i,
  /\barchitecture\b/i,
  /\brefactor\s+across\b/i,
  /\bmulti[-\s]?file\b/i,
  /\bdebug\s+race\s+condition\b/i,
  /\brace\s+condition\b/i,
  /\bstate\s+machine\b/i,
  /\bdeadlock\b/i,
  /\bconcurrency\b/i,
  /\bsecurity\s+audit\b/i,
  /\bschema\s+migration\b/i,
  /\bcross[-\s]?module\b/i,
  /\bdistributed\b/i,
  /\bconsensus\b/i,
  /\bredesign\b/i
];

const MEDIUM_COMPLEXITY_PATTERNS = [
  /\bimplement\b/i,
  /\badd\s+unit\s+test\b/i,
  /\bunit\s+test\b/i,
  /\bvalidation\b/i,
  /\bhandler\b/i,
  /\bendpoint\b/i,
  /\bcomponent\b/i,
  /\bparser\b/i,
  /\boptimize\b/i,
  /\bfix\s+bug\b/i
];

const AMBIGUOUS_PATTERNS = [
  /\bsomething\s+is\s+wrong\b/i,
  /\bnot\s+working\b/i,
  /\bweird\s+bug\b/i,
  /\bintermittent\b/i,
  /\bflaky\b/i,
  /\binvestigate\b/i,
  /\bwhy\s+does\b/i
];

export function normalizeModelId(rawModel = '') {
  const lower = String(rawModel || '').toLowerCase().trim();
  if (!lower) return 'gemini-4-argon';
  if (lower.includes('flash')) return 'gemini-3.8-flash';
  if (lower.includes('argon')) return 'gemini-4-argon';
  if (lower.includes('sonnet') || lower.includes('claude')) return 'claude-sonnet-4.6';
  if (lower.includes('gemma') || lower.includes('local') || lower.includes('ollama')) return 'local-gemma4-26b';
  if (lower.includes('pro')) return 'gemini-3.8-pro';
  return MODEL_CATALOG[lower] ? lower : 'gemini-4-argon';
}

export function normalizeEffortTier(rawEffort = '') {
  const lower = String(rawEffort || '').toLowerCase().trim();
  if (lower === 'low' || lower === 'min') return 'low';
  if (lower === 'medium' || lower === 'med') return 'medium';
  if (lower === 'high' || lower === 'max') return 'high';
  return 'high';
}

export function getModelFamily(modelId = '') {
  const norm = normalizeModelId(modelId);
  return MODEL_CATALOG[norm]?.family || norm;
}

export function isSameModelFamily(modelA, modelB) {
  return getModelFamily(modelA) === getModelFamily(modelB);
}

export function getQuotaMultiplier(modelId = 'gemini-4-argon', effort = 'high') {
  const normModel = normalizeModelId(modelId);
  const normEffort = normalizeEffortTier(effort);
  const entry = MODEL_CATALOG[normModel] || MODEL_CATALOG['gemini-4-argon'];
  return entry.multipliers[normEffort] ?? entry.multipliers.high;
}

export function formatModelDisplayLabel(modelId = 'gemini-4-argon') {
  const normModel = normalizeModelId(modelId);
  return MODEL_CATALOG[normModel]?.label || normModel;
}

/**
 * Extracts active `[/]` checklist item and its depth/tags from `task.md` content.
 */
export function extractActiveTaskStep(taskMdContent = '') {
  const lines = String(taskMdContent || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*)-\s*\[\/\]\s*(.+)$/);
    if (match) {
      const indentSpaces = match[1].length;
      const rawText = match[2].trim();
      const tagMatch = rawText.match(/\[([a-z0-9_.-]+):([a-z0-9_.-]+)\]/i);
      let subItemCount = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        const nextIndent = (nextLine.match(/^(\s*)/) || ['', ''])[1].length;
        if (nextLine.trim().startsWith('-') && nextIndent > indentSpaces) {
          subItemCount++;
        } else if (nextLine.trim().startsWith('-') && nextIndent <= indentSpaces) {
          break;
        } else if (nextLine.trim().startsWith('#')) {
          break;
        }
      }
      return {
        found: true,
        lineNumber: i + 1,
        indentDepth: Math.floor(indentSpaces / 2),
        subItemCount,
        rawText,
        directiveTag: tagMatch
          ? {
              raw: tagMatch[0],
              modelTag: tagMatch[1].toLowerCase(),
              effortTag: tagMatch[2].toLowerCase()
            }
          : null
      };
    }
  }
  return {
    found: false,
    lineNumber: null,
    indentDepth: 0,
    subItemCount: 0,
    rawText: '',
    directiveTag: null
  };
}

/**
 * Infers Agent Lifecycle Mode (`PLANNING` | `EXECUTION` | `VERIFICATION`)
 */
export function inferLifecycleMode(options = {}) {
  if (options.lifecycleMode) {
    const upper = String(options.lifecycleMode).toUpperCase();
    if (upper === 'PLANNING' || upper === 'EXECUTION' || upper === 'VERIFICATION') {
      return upper;
    }
  }
  const prompt = String(options.prompt || '');
  if (/^\/plan\b/i.test(prompt) || /\bimplementation_plan\.md\b/i.test(prompt) || /\bdesign\s+architecture\b/i.test(prompt)) {
    return 'PLANNING';
  }
  if (/\bwalkthrough\.md\b/i.test(prompt) || /\bverify_gate\b/i.test(prompt) || /\brun\s+(?:all\s+)?tests\b/i.test(prompt)) {
    return 'VERIFICATION';
  }
  return 'EXECUTION';
}

/**
 * Component 1 & 2: Zero-API-Call Pre-Invocation Task & Brain Classifier (<5ms)
 * + "Floor is the Guarantee" Asymmetric Safety Rule & Loop Escalation
 */
export function classifyTaskComplexity(options = {}) {
  const startMs = performance.now();
  const prompt = String(options.prompt || '').trim();
  const taskMdContent = String(options.taskMdContent || '');
  const lifecycleMode = inferLifecycleMode(options);

  const activeStep = extractActiveTaskStep(taskMdContent);
  const combinedText = `${prompt} ${activeStep.rawText}`.trim();

  // Count @file mentions
  const fileMentions = prompt.match(/@[\w./\\-]+/g) || [];
  const fileMentionCount = Math.max(fileMentions.length, Number(options.fileMentionCount || 0));
  const astFileCount = Number(options.astFileCount ?? fileMentionCount);
  const multiFileMutation = Boolean(options.multiFileMutation || astFileCount > 1 || fileMentionCount > 1);
  const cyclomaticComplexity = Number(options.cyclomaticComplexity || 1);

  // Live Retry / Oscillation Telemetry from Phase 1 (DET-01 / DET-02)
  const det01Count = Number(options.det01Count ?? options.retryChurnCount ?? 0);
  const det02Count = Number(options.det02Count ?? options.oscillationCount ?? 0);

  const activeModel = normalizeModelId(options.activeModel || 'gemini-4-argon');
  const activeEffort = normalizeEffortTier(options.activeEffort || 'high');

  const matchesLow = LOW_COMPLEXITY_PATTERNS.some((rx) => rx.test(combinedText));
  const matchesHigh = HIGH_COMPLEXITY_PATTERNS.some((rx) => rx.test(combinedText));
  const matchesMedium = MEDIUM_COMPLEXITY_PATTERNS.some((rx) => rx.test(combinedText));
  const matchesAmbiguous = AMBIGUOUS_PATTERNS.some((rx) => rx.test(combinedText));

  let complexityTier = 'MEDIUM';
  let confidence = 0.80;

  if (lifecycleMode === 'PLANNING' || matchesHigh || multiFileMutation || cyclomaticComplexity >= 15 || activeStep.subItemCount >= 4) {
    complexityTier = 'HIGH';
    confidence = matchesHigh || multiFileMutation || lifecycleMode === 'PLANNING' ? 0.92 : 0.86;
  } else if (matchesLow && !matchesHigh && !matchesMedium && !matchesAmbiguous && !multiFileMutation && cyclomaticComplexity < 8) {
    complexityTier = 'LOW';
    confidence = prompt.length > 0 && prompt.length <= 160 && astFileCount <= 1 ? 0.91 : 0.86;
  } else if (matchesAmbiguous) {
    complexityTier = 'MEDIUM';
    confidence = 0.68; // Ambiguous bug reports have <0.85 confidence -> Floor Guarantee promotes upward
  } else {
    complexityTier = 'MEDIUM';
    confidence = matchesMedium ? 0.88 : 0.78;
  }

  // Allow explicit confidence override for deterministic boundary tests if provided
  if (typeof options.confidenceOverride === 'number') {
    confidence = options.confidenceOverride;
  }

  // "Floor is the Guarantee" Asymmetric Safety Rule:
  // Recommend budget tier (Gemini 3.8 Flash — Low/Medium effort, 1.0x burn) ONLY when
  // complexityTier === 'LOW' && confidence >= 0.85 && !multiFileMutation.
  let recommendedModel = 'gemini-4-argon';
  let recommendedEffort = 'medium';
  let floorGuaranteeApplied = false;

  if (complexityTier === 'LOW' && confidence >= FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD && !multiFileMutation) {
    recommendedModel = 'gemini-3.8-flash';
    recommendedEffort = 'low';
  } else if (complexityTier === 'HIGH' || multiFileMutation) {
    recommendedModel = 'gemini-4-argon';
    recommendedEffort = 'high';
    if (complexityTier !== 'HIGH') {
      floorGuaranteeApplied = true;
    }
  } else {
    // Either MEDIUM complexity or LOW complexity with confidence < 0.85
    if (complexityTier === 'LOW' && confidence < FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD) {
      floorGuaranteeApplied = true;
    }
    recommendedModel = confidence < FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD ? 'gemini-4-argon' : 'gemini-4-argon';
    recommendedEffort = confidence < FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD ? 'high' : 'medium';
  }

  // Auto-Escalation on Loop Detection (DET-01 >= 2 consecutive failures or DET-02 oscillation >= 1)
  let loopEscalated = false;
  let escalationReason = null;
  const hasLoopSignal = det01Count >= 2 || det02Count >= 1;

  if (hasLoopSignal) {
    const isFlashLow = activeModel === 'gemini-3.8-flash' && activeEffort === 'low';
    const isArgonLow = activeModel === 'gemini-4-argon' && activeEffort === 'low';
    if (isFlashLow || isArgonLow || recommendedModel === 'gemini-3.8-flash') {
      loopEscalated = true;
      escalationReason = det01Count >= 2
        ? `DET-01 retry churn (${det01Count} consecutive failures)`
        : `DET-02 file-hash edit oscillation (${det02Count} flips)`;
      recommendedModel = 'gemini-4-argon';
      recommendedEffort = isArgonLow && det01Count >= 3 ? 'high' : 'medium';
      if (complexityTier === 'LOW') {
        complexityTier = 'MEDIUM';
      }
    }
  }

  const estimatedBurnMultiplier = getQuotaMultiplier(recommendedModel, recommendedEffort);
  const elapsedMs = Number((performance.now() - startMs).toFixed(3));

  return {
    complexityTier,
    confidence: Number(confidence.toFixed(2)),
    recommendedModel,
    recommendedEffort,
    estimatedBurnMultiplier,
    lifecycleMode,
    loopEscalated,
    escalationReason,
    floorGuaranteeApplied,
    signals: {
      fileMentionCount,
      astFileCount,
      multiFileMutation,
      cyclomaticComplexity,
      det01Count,
      det02Count,
      activeStepFound: activeStep.found,
      activeStepSubItems: activeStep.subItemCount,
      activeStepDirective: activeStep.directiveTag
    },
    elapsedMs
  };
}

/**
 * Component 3: `CacheGravityScorer` & Cache-Adjusted Quota Cost Equation
 *
 * C_effective(m, e) = M(m, e) * [
 *   I_same_model(m) * (0.05 * T_cached) +
 *   (1 - I_same_model(m)) * T_cached +
 *   T_uncached_delta +
 *   E_output(e)
 * ]
 */
export class CacheGravityScorer {
  constructor(options = {}) {
    this.warmCacheThresholdTokens = Number(
      options.warmCacheThresholdTokens ?? WARM_CACHE_GRAVITY_THRESHOLD_TOKENS
    );
  }

  /**
   * Computes exact Cache-Adjusted Effective Quota Cost for a single candidate (model, effort).
   */
  computeEffectiveCost({
    candidateModel,
    candidateEffort,
    activeModel = 'gemini-4-argon',
    cachedTokens = 0,
    cacheTtlSeconds = 0,
    uncachedDeltaTokens = 2000,
    expectedOutputTokens = null
  } = {}) {
    const normCandidateModel = normalizeModelId(candidateModel);
    const normCandidateEffort = normalizeEffortTier(candidateEffort);
    const normActiveModel = normalizeModelId(activeModel);

    const multiplier = getQuotaMultiplier(normCandidateModel, normCandidateEffort);
    const isCacheWarm = Number(cacheTtlSeconds) > 0 && Number(cachedTokens) > 0;
    const sameModelIndicator = isCacheWarm && isSameModelFamily(normCandidateModel, normActiveModel) ? 1 : 0;

    const tCached = Math.max(0, Number(cachedTokens || 0));
    const tUncachedDelta = Math.max(0, Number(uncachedDeltaTokens || 0));
    const eOutput = expectedOutputTokens !== null && expectedOutputTokens !== undefined
      ? Number(expectedOutputTokens)
      : (EXPECTED_OUTPUT_TOKENS_BY_EFFORT[normCandidateEffort] || 3500);

    const cachedTerm = sameModelIndicator * (0.05 * tCached);
    const coldPrefillTerm = (1 - sameModelIndicator) * tCached;
    const effectiveTokens = cachedTerm + coldPrefillTerm + tUncachedDelta + eOutput;
    const effectiveQuotaCost = Number((multiplier * effectiveTokens).toFixed(2));

    return {
      model: normCandidateModel,
      effort: normCandidateEffort,
      multiplier,
      sameModelIndicator,
      isCacheWarm,
      cachedTokens: tCached,
      uncachedDeltaTokens: tUncachedDelta,
      expectedOutputTokens: eOutput,
      cachedTerm: Number(cachedTerm.toFixed(2)),
      coldPrefillTerm: Number(coldPrefillTerm.toFixed(2)),
      effectiveTokens: Number(effectiveTokens.toFixed(2)),
      effectiveQuotaCost
    };
  }

  /**
   * Evaluates candidate (model, effort) pairs and applies Rule A (Modulate Effort Within Same Model)
   * and Rule B (Subagent / Local Offload for Routine Subtasks) when Cached History >= 60,000 and TTL > 0s.
   */
  evaluateCandidates(context = {}) {
    const activeModel = normalizeModelId(context.activeModel || 'gemini-4-argon');
    const activeEffort = normalizeEffortTier(context.activeEffort || 'high');
    const cachedTokens = Math.max(0, Number(context.cachedTokens || 0));
    const cacheTtlSeconds = Math.max(0, Number(context.cacheTtlSeconds || 0));
    const uncachedDeltaTokens = Math.max(0, Number(context.uncachedDeltaTokens ?? 2000));
    const complexityTier = String(context.complexityTier || 'LOW').toUpperCase();
    const confidence = Number(context.confidence ?? 0.90);

    const hasWarmCacheGravity =
      cachedTokens >= this.warmCacheThresholdTokens && cacheTtlSeconds > 0;

    const candidatePairs = [
      { model: activeModel, effort: 'low' },
      { model: activeModel, effort: 'medium' },
      { model: activeModel, effort: 'high' },
      { model: 'gemini-3.8-flash', effort: 'low' },
      { model: 'gemini-3.8-flash', effort: 'medium' },
      { model: 'gemini-4-argon', effort: 'low' },
      { model: 'gemini-4-argon', effort: 'medium' },
      { model: 'gemini-4-argon', effort: 'high' }
    ];

    const seen = new Set();
    const scoredCandidates = [];
    for (const pair of candidatePairs) {
      const key = `${pair.model}:${pair.effort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scoredCandidates.push(
        this.computeEffectiveCost({
          candidateModel: pair.model,
          candidateEffort: pair.effort,
          activeModel,
          cachedTokens,
          cacheTtlSeconds,
          uncachedDeltaTokens
        })
      );
    }

    scoredCandidates.sort((a, b) => a.effectiveQuotaCost - b.effectiveQuotaCost);

    const baselineCost = this.computeEffectiveCost({
      candidateModel: activeModel,
      candidateEffort: activeEffort,
      activeModel,
      cachedTokens,
      cacheTtlSeconds,
      uncachedDeltaTokens
    });

    const coldSwitchToFlashCost = this.computeEffectiveCost({
      candidateModel: 'gemini-3.8-flash',
      candidateEffort: 'low',
      activeModel,
      cachedTokens,
      cacheTtlSeconds,
      uncachedDeltaTokens
    });

    const sameModelLowCost = this.computeEffectiveCost({
      candidateModel: activeModel,
      candidateEffort: 'low',
      activeModel,
      cachedTokens,
      cacheTtlSeconds,
      uncachedDeltaTokens
    });

    const sameModelMediumCost = this.computeEffectiveCost({
      candidateModel: activeModel,
      candidateEffort: 'medium',
      activeModel,
      cachedTokens,
      cacheTtlSeconds,
      uncachedDeltaTokens
    });

    let primaryRecommendation = null;
    let subagentOffloadOption = null;
    let localOffloadOption = null;
    let policyApplied = 'COLD_OR_LOW_CACHE_OPTIMAL';

    if (hasWarmCacheGravity && activeModel !== 'gemini-3.8-flash') {
      // Rule A: Modulate Effort Within the Same Model First to preserve 95% KV cache discount
      const targetSameModelEffort = complexityTier === 'HIGH' ? 'high' : 'low';
      const targetCostObj = targetSameModelEffort === 'low' ? sameModelLowCost : (
        targetSameModelEffort === 'medium' ? sameModelMediumCost : baselineCost
      );
      const multiplierSavingsPct = baselineCost.multiplier > 0
        ? Math.round(((baselineCost.multiplier - targetCostObj.multiplier) / baselineCost.multiplier) * 100)
        : 0;
      const effectiveSavingsPct = baselineCost.effectiveQuotaCost > 0
        ? Math.round(((baselineCost.effectiveQuotaCost - targetCostObj.effectiveQuotaCost) / baselineCost.effectiveQuotaCost) * 100)
        : 0;

      primaryRecommendation = {
        action: 'MODULATE_EFFORT_SAME_MODEL',
        model: activeModel,
        effort: targetSameModelEffort,
        multiplier: targetCostObj.multiplier,
        effectiveQuotaCost: targetCostObj.effectiveQuotaCost,
        preservesWarmCache: true,
        coldPrefillPenaltyAvoidedTokens: cachedTokens,
        multiplierSavingsPct: Math.max(0, multiplierSavingsPct),
        effectiveSavingsPct: Math.max(0, effectiveSavingsPct),
        label: `Drop to ${formatModelDisplayLabel(activeModel)} • ${targetSameModelEffort.toUpperCase()} (Keep ${(cachedTokens / 1000).toFixed(1)}k Cache, Save ${Math.max(multiplierSavingsPct, effectiveSavingsPct)}%)`
      };
      policyApplied = 'RULE_A_MODULATE_SAME_MODEL_EFFORT';

      // Rule B: Subagent / Local Offload for Routine Subtasks when LOW complexity & confidence >= 0.85
      if (complexityTier === 'LOW' && confidence >= FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD) {
        const subagentCleanCost = this.computeEffectiveCost({
          candidateModel: 'gemini-3.8-flash',
          candidateEffort: 'low',
          activeModel: 'gemini-3.8-flash',
          cachedTokens: 0,
          cacheTtlSeconds: 0,
          uncachedDeltaTokens: Math.min(uncachedDeltaTokens, 1800)
        });
        subagentOffloadOption = {
          action: 'SPAWN_FLASH_SUBAGENT',
          model: 'gemini-3.8-flash',
          effort: 'low',
          multiplier: 1.0,
          contextBudgetTokens: 2000,
          effectiveQuotaCost: subagentCleanCost.effectiveQuotaCost,
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
      // Cache is cold (TTL == 0) or small (< 60k): safe to switch model family directly if complexity allows
      let targetModel = activeModel;
      let targetEffort = activeEffort;

      if (complexityTier === 'LOW' && confidence >= FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD) {
        targetModel = 'gemini-3.8-flash';
        targetEffort = 'low';
      } else if (complexityTier === 'MEDIUM') {
        targetModel = cacheTtlSeconds === 0 && cachedTokens >= this.warmCacheThresholdTokens
          ? 'gemini-3.8-flash'
          : 'gemini-4-argon';
        targetEffort = 'medium';
      } else {
        targetModel = 'gemini-4-argon';
        targetEffort = 'high';
      }

      const targetCostObj = this.computeEffectiveCost({
        candidateModel: targetModel,
        candidateEffort: targetEffort,
        activeModel,
        cachedTokens,
        cacheTtlSeconds,
        uncachedDeltaTokens
      });

      primaryRecommendation = {
        action: targetModel !== activeModel ? 'SWITCH_MODEL_FAMILY' : 'MODULATE_EFFORT_SAME_MODEL',
        model: targetModel,
        effort: targetEffort,
        multiplier: targetCostObj.multiplier,
        effectiveQuotaCost: targetCostObj.effectiveQuotaCost,
        preservesWarmCache: isSameModelFamily(targetModel, activeModel) && cacheTtlSeconds > 0,
        coldPrefillPenaltyAvoidedTokens: 0,
        multiplierSavingsPct: baselineCost.multiplier > 0
          ? Math.max(0, Math.round(((baselineCost.multiplier - targetCostObj.multiplier) / baselineCost.multiplier) * 100))
          : 0,
        effectiveSavingsPct: baselineCost.effectiveQuotaCost > 0
          ? Math.max(0, Math.round(((baselineCost.effectiveQuotaCost - targetCostObj.effectiveQuotaCost) / baselineCost.effectiveQuotaCost) * 100))
          : 0,
        label: `Switch to ${formatModelDisplayLabel(targetModel)} • ${targetEffort.toUpperCase()} (${targetCostObj.multiplier}x)`
      };
    }

    return {
      hasWarmCacheGravity,
      policyApplied,
      baseline: baselineCost,
      sameModelLowCost,
      coldSwitchToFlashCost,
      primaryRecommendation,
      subagentOffloadOption,
      localOffloadOption,
      scoredCandidates
    };
  }
}

/**
 * Component 4: `TaskMdDirectiveWatcher` — Brain-Driven Inline Routing Tags
 *
 * Parses and watches `~/.gemini/antigravity/brain/<GUID>/task.md` for inline `[model:effort]`
 * tags (`[argon:high]`, `[argon:medium]`, `[flash:low]`, `[local:gemma4]`) on checklist milestones.
 */
export class TaskMdDirectiveWatcher {
  constructor(options = {}) {
    this.cacheGravityScorer = options.cacheGravityScorer || new CacheGravityScorer(options);
    this.actuator = options.actuator || null;
    this.watchers = new Map();
    this.lastParsedDirective = null;
  }

  /**
   * Resolves a shorthand tag (`[argon:high]`, `[flash:low]`, `[local:gemma4]`) to canonical model & effort.
   */
  resolveTagToModelEffort(modelTag = '', effortTag = '') {
    const m = String(modelTag || '').toLowerCase();
    const e = String(effortTag || '').toLowerCase();

    let model = 'gemini-4-argon';
    let effort = 'high';

    if (m === 'local' || e.includes('gemma') || m.includes('gemma')) {
      model = 'local-gemma4-26b';
      effort = 'low';
    } else {
      model = normalizeModelId(m);
      effort = normalizeEffortTier(e);
    }

    return {
      model,
      effort,
      multiplier: getQuotaMultiplier(model, effort),
      rawTag: `[${modelTag}:${effortTag}]`
    };
  }

  /**
   * Parses `task.md` content in <2ms, extracts the active `[/]` step's `[model:effort]` directive,
   * and evaluates `CacheGravityScorer` to verify cache safety.
   */
  parseTaskMdDirectives(taskMdContent = '', sessionContext = {}) {
    const startMs = performance.now();
    const lines = String(taskMdContent || '').split(/\r?\n/);
    const allDirectives = [];
    let activeStep = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^\s*-\s*\[([ xX/])\]\s*(.+)$/);
      if (!match) continue;

      const statusChar = match[1];
      const text = match[2].trim();
      const tagMatch = text.match(/\[([a-z0-9_.-]+):([a-z0-9_.-]+)\]/i);

      const resolved = tagMatch
        ? this.resolveTagToModelEffort(tagMatch[1], tagMatch[2])
        : null;

      const item = {
        lineNumber: i + 1,
        status: statusChar === '/' ? 'IN_PROGRESS' : (statusChar.toLowerCase() === 'x' ? 'COMPLETED' : 'PENDING'),
        text,
        directive: resolved
      };

      allDirectives.push(item);
      if (statusChar === '/' && !activeStep) {
        activeStep = item;
      }
    }

    let gravityEvaluation = null;
    if (activeStep && activeStep.directive) {
      const target = activeStep.directive;
      const isLowRoutine = target.model === 'gemini-3.8-flash' || target.model === 'local-gemma4-26b';
      gravityEvaluation = this.cacheGravityScorer.evaluateCandidates({
        activeModel: sessionContext.activeModel || 'gemini-4-argon',
        activeEffort: sessionContext.activeEffort || 'high',
        cachedTokens: sessionContext.cachedTokens ?? 0,
        cacheTtlSeconds: sessionContext.cacheTtlSeconds ?? 0,
        uncachedDeltaTokens: sessionContext.uncachedDeltaTokens ?? 2000,
        complexityTier: isLowRoutine ? 'LOW' : (target.effort === 'high' ? 'HIGH' : 'MEDIUM'),
        confidence: 0.95
      });
    }

    const elapsedMs = Number((performance.now() - startMs).toFixed(3));
    const result = {
      foundActiveStep: Boolean(activeStep),
      activeStep,
      allDirectives,
      gravityEvaluation,
      elapsedMs
    };
    this.lastParsedDirective = result;
    return result;
  }

  /**
   * Annotates un-tagged checklist items in `task.md` during `PLANNING` mode with `[model:effort]` badges.
   */
  annotateTaskMdPlan(taskMdContent = '') {
    const lines = String(taskMdContent || '').split(/\r?\n/);
    const updated = lines.map((line) => {
      const match = line.match(/^(\s*-\s*\[[ xX/]\]\s*)(.+)$/);
      if (!match) return line;
      const prefix = match[1];
      const body = match[2];
      if (/\[[a-z0-9_.-]+:[a-z0-9_.-]+\]/i.test(body)) {
        return line; // Already tagged
      }
      const classification = classifyTaskComplexity({ prompt: body, lifecycleMode: 'EXECUTION' });
      let badge = '[argon:medium]';
      if (classification.complexityTier === 'HIGH') {
        badge = '[argon:high]';
      } else if (classification.complexityTier === 'LOW' && classification.confidence >= FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD) {
        badge = '[flash:low]';
      }
      return `${prefix}${badge} ${body}`;
    });
    return updated.join('\n');
  }

  /**
   * Attaches a fast file watcher to `taskMdPath` and invokes `onTransition` whenever the active `[/]` step changes.
   */
  watchTaskMdFile(taskMdPath, sessionContextProvider = () => ({}), onTransition = null) {
    const resolvedPath = path.resolve(taskMdPath);
    this.unwatchTaskMdFile(resolvedPath);

    const evaluateNow = () => {
      if (!fs.existsSync(resolvedPath)) return null;
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const ctx = typeof sessionContextProvider === 'function' ? sessionContextProvider() : sessionContextProvider;
      const parsed = this.parseTaskMdDirectives(content, ctx);
      if (this.actuator && parsed.activeStep?.directive) {
        this.actuator.handleDirectiveTransition(parsed, ctx);
      }
      if (typeof onTransition === 'function') {
        onTransition(parsed);
      }
      return parsed;
    };

    if (fs.existsSync(resolvedPath)) {
      const watcher = fs.watch(resolvedPath, { persistent: false }, () => {
        try { evaluateNow(); } catch {}
      });
      this.watchers.set(resolvedPath, watcher);
    }

    return {
      path: resolvedPath,
      evaluateNow,
      close: () => this.unwatchTaskMdFile(resolvedPath)
    };
  }

  unwatchTaskMdFile(taskMdPath) {
    const resolvedPath = path.resolve(taskMdPath);
    const existing = this.watchers.get(resolvedPath);
    if (existing) {
      try { existing.close(); } catch {}
      this.watchers.delete(resolvedPath);
    }
  }
}

/**
 * Component 5: `ModelSelectorActuator` — Live CDP OOPIF & RPC Model/Effort Control
 *
 * Supports 3-way router mode toggle (`off` | `coach` | `autopilot`) and uses `AgBridgeService`
 * to read and actuate the active model/effort dropdown state in the Antigravity chat panel.
 */
export class ModelSelectorActuator {
  constructor(options = {}) {
    this.agBridge = options.agBridge || new AgBridgeService(options);
    this.cacheGravityScorer = options.cacheGravityScorer || new CacheGravityScorer(options);
    this.mode = this.normalizeMode(options.mode || 'coach');
    this.activeModel = normalizeModelId(options.activeModel || 'gemini-4-argon');
    this.activeEffort = normalizeEffortTier(options.activeEffort || 'high');
    this.syncStatus = options.syncStatus || 'live synced';
    this.actuationHistory = [];
  }

  normalizeMode(mode = 'coach') {
    const lower = String(mode || '').toLowerCase().trim();
    if (lower === 'off' || lower === 'disabled') return 'off';
    if (lower === 'autopilot' || lower === 'auto-pilot' || lower === 'auto') return 'autopilot';
    return 'coach';
  }

  setMode(mode) {
    this.mode = this.normalizeMode(mode);
    return {
      ok: true,
      mode: this.mode
    };
  }

  /**
   * Reads live model & effort state via RPC or CDP OOPIF bridge, upgrading status from
   * `(model inferred)` to `(live synced)`.
   */
  async readLiveModelState(sessionId = 'default_session') {
    if (this.agBridge?.rpcTransport && typeof this.agBridge.rpcTransport.getModelState === 'function') {
      try {
        const res = await this.agBridge.rpcTransport.getModelState(sessionId);
        if (res && res.model) {
          this.activeModel = normalizeModelId(res.model);
          this.activeEffort = normalizeEffortTier(res.effort || this.activeEffort);
          this.syncStatus = 'live synced';
          return {
            ok: true,
            model: this.activeModel,
            effort: this.activeEffort,
            multiplier: getQuotaMultiplier(this.activeModel, this.activeEffort),
            syncStatus: 'live synced',
            transportUsed: 'rpc'
          };
        }
      } catch {}
    }

    if (this.agBridge?.cdpTransport && typeof this.agBridge.cdpTransport.getModelState === 'function') {
      try {
        const res = await this.agBridge.cdpTransport.getModelState(sessionId);
        if (res && res.model) {
          this.activeModel = normalizeModelId(res.model);
          this.activeEffort = normalizeEffortTier(res.effort || this.activeEffort);
          this.syncStatus = 'live synced';
          return {
            ok: true,
            model: this.activeModel,
            effort: this.activeEffort,
            multiplier: getQuotaMultiplier(this.activeModel, this.activeEffort),
            syncStatus: 'live synced',
            transportUsed: 'cdp'
          };
        }
      } catch {}
    }

    return {
      ok: true,
      model: this.activeModel,
      effort: this.activeEffort,
      multiplier: getQuotaMultiplier(this.activeModel, this.activeEffort),
      syncStatus: this.syncStatus,
      transportUsed: 'cached_state'
    };
  }

  /**
   * Evaluates and either recommends (Coach Mode) or actuates (Auto-Pilot Mode) model/effort changes
   * while enforcing CacheGravityScorer's warm-cache protection rule.
   */
  async evaluateAndActuate(request = {}) {
    const sessionId = String(request.sessionId || 'default_session');
    const currentModel = normalizeModelId(request.activeModel || this.activeModel);
    const currentEffort = normalizeEffortTier(request.activeEffort || this.activeEffort);
    const desiredModel = normalizeModelId(request.targetModel || currentModel);
    const desiredEffort = normalizeEffortTier(request.targetEffort || currentEffort);
    const cachedTokens = Math.max(0, Number(request.cachedTokens ?? 0));
    const cacheTtlSeconds = Math.max(0, Number(request.cacheTtlSeconds ?? 0));
    const isCleanBoundary = Boolean(request.isCleanBoundary || request.onHandoff);
    const directiveBadge = request.directiveBadge || `[${getModelFamily(desiredModel)}:${desiredEffort}]`;

    const gravity = this.cacheGravityScorer.evaluateCandidates({
      activeModel: currentModel,
      activeEffort: currentEffort,
      cachedTokens,
      cacheTtlSeconds,
      uncachedDeltaTokens: request.uncachedDeltaTokens ?? 2000,
      complexityTier: desiredModel === 'gemini-3.8-flash' ? 'LOW' : (desiredEffort === 'high' ? 'HIGH' : 'MEDIUM'),
      confidence: 0.95
    });

    // Determine cache-safe target for the main thread:
    // Never switch model family mid-session when Cached History >= 60k and TTL > 0s unless at a clean boundary.
    let safeMainThreadModel = desiredModel;
    let safeMainThreadEffort = desiredEffort;
    let preventedColdPrefill = false;

    if (
      gravity.hasWarmCacheGravity &&
      !isCleanBoundary &&
      !isSameModelFamily(desiredModel, currentModel)
    ) {
      safeMainThreadModel = currentModel;
      safeMainThreadEffort = desiredEffort; // Modulate effort within same model family (e.g. Argon-High -> Argon-Low)
      preventedColdPrefill = true;
    }

    const savingsPct = gravity.primaryRecommendation?.multiplierSavingsPct || 67;
    const coachPillText = preventedColdPrefill
      ? `💡 task.md step is ${directiveBadge} → [Switch to ${formatModelDisplayLabel(safeMainThreadModel)}-${safeMainThreadEffort.charAt(0).toUpperCase() + safeMainThreadEffort.slice(1)} (Save ${savingsPct}%)] or [Spawn Flash Subagent (1.0x)]`
      : `💡 task.md step is ${directiveBadge} → [Switch to ${formatModelDisplayLabel(safeMainThreadModel)} • ${safeMainThreadEffort.toUpperCase()} (${getQuotaMultiplier(safeMainThreadModel, safeMainThreadEffort)}x)]`;

    if (this.mode === 'off') {
      return {
        ok: true,
        mode: 'off',
        actuated: false,
        preventedColdPrefill,
        activeModel: currentModel,
        activeEffort: currentEffort,
        recommendedModel: safeMainThreadModel,
        recommendedEffort: safeMainThreadEffort,
        coachPillText: null,
        gravity
      };
    }

    if (this.mode === 'coach' && !request.forceActuate) {
      return {
        ok: true,
        mode: 'coach',
        actuated: false,
        preventedColdPrefill,
        activeModel: currentModel,
        activeEffort: currentEffort,
        recommendedModel: safeMainThreadModel,
        recommendedEffort: safeMainThreadEffort,
        subagentOffloadOption: gravity.subagentOffloadOption,
        coachPillText,
        gravity
      };
    }

    // Auto-Pilot Mode (or explicit 1-click forceActuate in Coach Mode)
    let transportUsed = 'state_sync';
    const commandPayload = {
      type: 'SET_MODEL_AND_EFFORT',
      model: safeMainThreadModel,
      effort: safeMainThreadEffort,
      preserveWarmCache: preventedColdPrefill
    };

    if (this.agBridge) {
      const dispatchRes = await this.agBridge.sendChatCommand(sessionId, commandPayload);
      transportUsed = dispatchRes.transportUsed || 'rpc';
    }

    this.activeModel = safeMainThreadModel;
    this.activeEffort = safeMainThreadEffort;
    this.syncStatus = 'live synced';

    const record = {
      ok: true,
      mode: this.mode,
      actuated: true,
      preventedColdPrefill,
      previousModel: currentModel,
      previousEffort: currentEffort,
      activeModel: this.activeModel,
      activeEffort: this.activeEffort,
      activeMultiplier: getQuotaMultiplier(this.activeModel, this.activeEffort),
      syncStatus: this.syncStatus,
      transportUsed,
      coachPillText,
      gravity
    };

    this.actuationHistory.push(record);
    return record;
  }

  /**
   * Invoked by TaskMdDirectiveWatcher when an active `[/]` step with `[model:effort]` is parsed.
   */
  async handleDirectiveTransition(parsedDirectiveResult, sessionContext = {}) {
    const directive = parsedDirectiveResult?.activeStep?.directive;
    if (!directive) return null;
    return this.evaluateAndActuate({
      sessionId: sessionContext.sessionId || 'default_session',
      activeModel: sessionContext.activeModel || this.activeModel,
      activeEffort: sessionContext.activeEffort || this.activeEffort,
      targetModel: directive.model,
      targetEffort: directive.effort,
      directiveBadge: directive.rawTag,
      cachedTokens: sessionContext.cachedTokens ?? 0,
      cacheTtlSeconds: sessionContext.cacheTtlSeconds ?? 0,
      isCleanBoundary: sessionContext.isCleanBoundary ?? false
    });
  }

  /**
   * Spawns a clean `<2k` context Flash-Low subagent session for Rule B offload via `AgBridgeService`.
   */
  async spawnFlashSubagentOffload(subtaskState = {}) {
    return this.agBridge.spawnCleanSession({
      ...subtaskState,
      recommendedModel: 'gemini-3.8-flash',
      recommendedEffort: 'low',
      contextBudgetTokens: 2000
    });
  }
}

/**
 * Unified Phase 5 Facade combining Task Classifier, CacheGravityScorer,
 * TaskMdDirectiveWatcher, and ModelSelectorActuator for PreInvocation & UI HUD.
 */
export function evaluateTaskAndQuotaRoute(options = {}) {
  const scorer = options.cacheGravityScorer || new CacheGravityScorer(options);
  const actuator = options.actuator || new ModelSelectorActuator({
    agBridge: options.agBridge,
    cacheGravityScorer: scorer,
    mode: options.routerMode || 'coach',
    activeModel: options.activeModel || 'gemini-4-argon',
    activeEffort: options.activeEffort || 'high'
  });
  const watcher = options.directiveWatcher || new TaskMdDirectiveWatcher({
    cacheGravityScorer: scorer,
    actuator
  });

  const classification = classifyTaskComplexity(options);
  const directiveState = options.taskMdContent
    ? watcher.parseTaskMdDirectives(options.taskMdContent, options)
    : { foundActiveStep: false, activeStep: null, allDirectives: [], elapsedMs: 0 };

  // If task.md has an explicit [model:effort] directive on the active [/] item and no loop escalation occurred,
  // merge its target into the gravity evaluation.
  const targetModel = (!classification.loopEscalated && directiveState.activeStep?.directive?.model)
    ? directiveState.activeStep.directive.model
    : classification.recommendedModel;
  const targetEffort = (!classification.loopEscalated && directiveState.activeStep?.directive?.effort)
    ? directiveState.activeStep.directive.effort
    : classification.recommendedEffort;

  const gravity = scorer.evaluateCandidates({
    activeModel: options.activeModel || 'gemini-4-argon',
    activeEffort: options.activeEffort || 'high',
    cachedTokens: options.cachedTokens ?? 0,
    cacheTtlSeconds: options.cacheTtlSeconds ?? 0,
    uncachedDeltaTokens: options.uncachedDeltaTokens ?? 2000,
    complexityTier: classification.complexityTier,
    confidence: classification.confidence
  });

  const activeModelNorm = normalizeModelId(options.activeModel || 'gemini-4-argon');
  const activeEffortNorm = normalizeEffortTier(options.activeEffort || 'high');
  const activeBurnMultiplier = getQuotaMultiplier(activeModelNorm, activeEffortNorm);

  const directiveBadge = directiveState.activeStep?.directive?.rawTag ||
    `[${getModelFamily(targetModel)}:${targetEffort}]`;

  const coachPillText = gravity.hasWarmCacheGravity && !isSameModelFamily(targetModel, activeModelNorm)
    ? `💡 Next task.md step is ${directiveBadge} → [Drop to ${formatModelDisplayLabel(activeModelNorm)}-${gravity.primaryRecommendation.effort.charAt(0).toUpperCase() + gravity.primaryRecommendation.effort.slice(1)} (Keep ${(Number(options.cachedTokens || 0) / 1000).toFixed(1)}k Cache)] | [Run in Flash Subagent]`
    : `💡 Recommended: ${formatModelDisplayLabel(gravity.primaryRecommendation.model)} • ${gravity.primaryRecommendation.effort.toUpperCase()} (${gravity.primaryRecommendation.multiplier}x burn)`;

  return {
    activeModel: activeModelNorm,
    activeModelLabel: formatModelDisplayLabel(activeModelNorm),
    activeEffort: activeEffortNorm,
    activeBurnMultiplier,
    syncStatus: actuator.syncStatus || 'live synced',
    routerMode: actuator.mode,
    classification,
    directiveState,
    gravity,
    coachPillText
  };
}

export default {
  MODEL_CATALOG,
  WARM_CACHE_GRAVITY_THRESHOLD_TOKENS,
  FLOOR_GUARANTEE_CONFIDENCE_THRESHOLD,
  classifyTaskComplexity,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
};
