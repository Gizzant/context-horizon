# Source File: src/core/classifier.mjs

```javascript
import fs from 'node:fs';
import path from 'node:path';
import {
  HORIZON_WINDOW,
  SESSION_RISK_THRESHOLDS,
  PREFIX_LOCK_WARNING_TEXT,
  CORTEX_CLAMPED_CEILING_LABEL,
  WATERMARK_TOOLTIPS,
  STRANDED_SIGNAL_WARNING_TEXT,
  ATTENTION_TROUGH_CONFIG,
  CATEGORIES,
  MODEL_PRICING_PER_MILLION,
  EFFORT_PROFILES,
  resolveEffortProfile,
  resolveModelCeiling,
  resolveModelCeilingDetailed,
  resolvePricePerM,
  resolveSurfaceTag,
  scaleEffortProfileForCeiling
} from './constants.mjs';
import { loadFlightcheckConfig } from './config.mjs';
import { loadCliSurfaceSettings } from './settings.mjs';
import { canonicalizePath } from './paths.mjs';
import { extractEffortTimeline } from './parser.mjs';
import { computeQuotaAndCacheTelemetry } from './quota.mjs';
import { inspectSubagentTree } from './subagents.mjs';
import { computePlanChurn, gradeProofQuality, detectContextRot, fingerprintErrorLoop } from './session_forensics.mjs';
import { auditHandoff } from './handoff_audit.mjs';
import {
  synthesizeParameterizedCompact,
  evaluateCompactionCacheAdvisory,
  synthesizeBatonPassHandoffCommand,
  isInternalTelemetryPath
} from './prompt_rubric.mjs';
import { auditMcpPrefixBloat } from './baseline.mjs';
import {
  CORTEX_STEP_TYPE_CHECKPOINT,
  MEMORY_MD_TRUNCATION_THRESHOLD_LINES,
  isCompactionCheckpointStep,
  evaluateSmartFileReReads,
  wrapNoisyCommandWithDampener,
  registerCliDampeningHook,
  computeAttentionZoneInsertionIndex,
  auditRuleFileAttentionAndLineLimit,
  promoteRuleWithAttentionZone
} from './layer5_hygiene.mjs';

export {
  CORTEX_STEP_TYPE_CHECKPOINT,
  MEMORY_MD_TRUNCATION_THRESHOLD_LINES,
  STRANDED_SIGNAL_WARNING_TEXT,
  ATTENTION_TROUGH_CONFIG,
  isCompactionCheckpointStep,
  evaluateSmartFileReReads,
  wrapNoisyCommandWithDampener,
  registerCliDampeningHook,
  computeAttentionZoneInsertionIndex,
  auditRuleFileAttentionAndLineLimit,
  promoteRuleWithAttentionZone,
  auditMcpPrefixBloat
};

/**
 * Phase 6 (Layer 6): Parabolic U-Shaped Attention Curve & Low-Attention Trough Model.
 *
 * Models transformer attention across N populated cells using a parabolic curve with gamma ~= 0.6:
 * - Literal algebraic expression from specification:
 *     A_spec(i) = 1.0 - 4.0 * gamma * ((i / N) - 0.5)^2
 * - U-shaped recall weight (1.0 at Primacy/Recency edges, minimum 1.0 - gamma at midpoint 0.5):
 *     A_u(i) = (1.0 - gamma) + 4.0 * gamma * ((i / N) - 0.5)^2
 * - Shades the middle 30% to 70% band (or Cells 7..15) as the Low-Attention Trough.
 */
export function calculateParabolicAttentionCurve(cellIndex, activeCellCount, gamma = ATTENTION_TROUGH_CONFIG.GAMMA) {
  if (activeCellCount <= 1) {
    return {
      cellIndex,
      activeCellCount,
      gamma,
      normalizedPosition: 0,
      uShapedWeight: 1.0,
      specFormulaValue: 1.0,
      inTrough: false,
      zone: 'PRIMACY'
    };
  }
  const N = Math.max(1, activeCellCount - 1);
  const clampedIdx = Math.max(0, Math.min(N, cellIndex));
  const ratio = clampedIdx / N;
  const distFromCenterSq = Math.pow(ratio - 0.5, 2);
  const specFormulaValue = parseFloat((1.0 - 4.0 * gamma * distFromCenterSq).toFixed(3));
  const uShapedWeight = parseFloat(Math.min(1.0, Math.max(0.20, (1.0 - gamma) + 4.0 * gamma * distFromCenterSq)).toFixed(2));

  const inRatioTrough = activeCellCount >= 7 &&
    ratio >= ATTENTION_TROUGH_CONFIG.TROUGH_START_RATIO &&
    ratio <= ATTENTION_TROUGH_CONFIG.TROUGH_END_RATIO;
  const inCanonicalCellTrough = activeCellCount >= 7 && cellIndex >= 6 && cellIndex <= 15 && cellIndex < activeCellCount;
  const inTrough = inRatioTrough || inCanonicalCellTrough;

  let zone = 'LOW_ATTENTION_TROUGH';
  if (!inTrough) {
    zone = ratio < 0.5 ? 'PRIMACY' : 'RECENCY';
  }

  return {
    cellIndex,
    activeCellCount,
    gamma,
    normalizedPosition: parseFloat(ratio.toFixed(3)),
    uShapedWeight,
    specFormulaValue,
    inTrough,
    zone
  };
}

/**
 * Calculates U-Shaped Attention Recall Curve weight A(i) for cell i in [0..activeCellCount-1]
 */
export function calculateAttentionWeight(cellIndex, activeCellCount, gamma = ATTENTION_TROUGH_CONFIG.GAMMA) {
  return calculateParabolicAttentionCurve(cellIndex, activeCellCount, gamma).uShapedWeight;
}

/**
 * Phase 1 (Layer 1): Evaluates Composite Operational Session Risk & Prefix-Lock Protection.
 *
 * Rules:
 * - RED: Context >= 179k (safe horizon breached) OR 7d lockout risk active without AI Credit overages enabled.
 * - AMBER: Cache TTL == 0s (cold cache window expired) OR context > 50k with pending checklist item OR task.md is >= 1 turn stale.
 * - GREEN: Total tokens < 179k AND Cache TTL > 0s AND task.md is in sync (0 turns behind).
 * - Prefix-Lock Protection Warning: Active when a session holds > 50k cached tokens with TTL > 0s.
 */
export function evaluateCompositeSessionRisk({
  totalActiveTokens = 0,
  safeHorizonTokens = SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS,
  cacheTtlRemainingSec = 300,
  cacheReadTokens = 0,
  cacheHitRatePct = 0,
  taskMdTurnsBehind = 0,
  hasPendingTaskItems = false,
  weekly7dUsedPct = 0,
  weekly7dLockoutRisk = false,
  aiCreditOveragesEnabled = false,
  prefixBustDetected = false
} = {}) {
  const safeHorizon = Number(safeHorizonTokens) > 0
    ? Number(safeHorizonTokens)
    : SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS;

  const isSafeHorizonBreached = totalActiveTokens >= safeHorizon || totalActiveTokens >= SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS;
  const is7dLockoutWithoutOverages = (weekly7dUsedPct >= 100 || Boolean(weekly7dLockoutRisk)) && !aiCreditOveragesEnabled;
  const isCacheExpired = Number(cacheTtlRemainingSec) <= 0;
  const isCascadeArmedWithPendingTask = totalActiveTokens > SESSION_RISK_THRESHOLDS.CASCADE_SYNC_WATERMARK_TOKENS && Boolean(hasPendingTaskItems);
  const isTaskMdStale = Number(taskMdTurnsBehind) >= 1;

  const reasons = [];
  let band = 'GREEN';

  if (isSafeHorizonBreached || is7dLockoutWithoutOverages) {
    band = 'RED';
    if (isSafeHorizonBreached) {
      reasons.push(`Safe horizon breached (${Math.round(totalActiveTokens / 1000)}k >= ${Math.round(Math.min(safeHorizon, SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS) / 1000)}k tokens)`);
    }
    if (is7dLockoutWithoutOverages) {
      reasons.push('7d quota lockout risk active without AI Credit overages enabled');
    }
  } else if (isCacheExpired || isCascadeArmedWithPendingTask || isTaskMdStale) {
    band = 'AMBER';
    if (isCacheExpired) {
      reasons.push('Cache TTL == 0s (cold cache window expired)');
    }
    if (isCascadeArmedWithPendingTask) {
      reasons.push('Context > 50k with pending task.md checklist item (Cascade sync armed)');
    }
    if (isTaskMdStale) {
      reasons.push(`task.md is ${taskMdTurnsBehind} turn${taskMdTurnsBehind === 1 ? '' : 's'} stale`);
    }
  } else {
    band = 'GREEN';
    reasons.push('Healthy (<179k tokens, warm KV cache TTL > 0s, task.md in sync)');
  }

  const effectiveCachedTokens = Math.max(
    Number(cacheReadTokens || 0),
    cacheHitRatePct > 0 ? Math.round(totalActiveTokens * (cacheHitRatePct / 100)) : 0,
    !isCacheExpired ? totalActiveTokens : 0
  );
  // Hotfix: the Warm badge requires real cache-read evidence, not merely TTL > 0s.
  const isCacheTrulyWarm = computeIsCacheTrulyWarm({
    ttlRemainingSec: cacheTtlRemainingSec,
    cacheReadTokens,
    hitRatePct: cacheHitRatePct,
    prefixBustDetected
  });
  const prefixLockWarning = isCacheTrulyWarm && effectiveCachedTokens > SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS;

  return {
    band,
    isCacheTrulyWarm,
    dotClass: band === 'RED' ? 'dot danger' : (band === 'AMBER' ? 'dot warn' : 'dot'),
    reasons,
    summary: reasons.join(' · '),
    prefixLockWarning,
    prefixLockCachedTokens: prefixLockWarning ? effectiveCachedTokens : 0,
    prefixLockTooltip: prefixLockWarning ? PREFIX_LOCK_WARNING_TEXT : ''
  };
}

/**
 * Hotfix: strict cache warmth predicate. TTL > 0s alone is NOT proof of a warm cache —
 * a session with 0 cache-read tokens or a 0% hit rate is cold regardless of the TTL clock.
 */
export function computeIsCacheTrulyWarm(cache = {}) {
  return Boolean(
    Number(cache?.ttlRemainingSec) > 0 &&
    Number(cache?.cacheReadTokens) > 0 &&
    Number(cache?.hitRatePct) > 0 &&
    !cache?.prefixBustDetected
  );
}

/**
 * Hotfix: Tenth-of-a-Kilotoken Mathematical Parity.
 * Derives the reclaimable display value from the rounded total and active values so that
 * Active Signal + Reclaimable always equals the headline total to exactly 0.1k.
 * If `anchorReclaimTenths` is supplied (sum of rounded reclaim rows), Reclaimable is pinned to it
 * and Active absorbs the rounding remainder so rows, badge and card stay identical.
 */
export function computeDisplayTenthsParity(totalTokens = 0, activeSignalTokens = 0, anchorReclaimTenths = null) {
  const displayTotalTenths = Math.round(Math.max(0, Number(totalTokens) || 0) / 100);
  const hasAnchor = anchorReclaimTenths !== null && Number.isFinite(Number(anchorReclaimTenths)) && Number(anchorReclaimTenths) >= 0;
  const displayActiveTenths = hasAnchor
    ? displayTotalTenths - Math.min(displayTotalTenths, Math.round(Number(anchorReclaimTenths)))
    : Math.min(displayTotalTenths, Math.round(Math.max(0, Number(activeSignalTokens) || 0) / 100));
  const displayReclaimableTenths = Math.max(0, displayTotalTenths - displayActiveTenths);
  return {
    displayTotalTenths,
    displayActiveTenths,
    displayReclaimableTenths,
    totalK: displayTotalTenths / 10,
    activeK: displayActiveTenths / 10,
    reclaimableK: displayReclaimableTenths / 10
  };
}

/**
 * Phase 3 (Layer 3): Evaluates State-Conditional Bar Coloring for the older history segment.
 * - Muted Slate/Teal ('Cached History — 95% Discounted') while TTL > 0s and totalActiveTokens <= 179k.
 * - Amber ('Reclaimable Cold Bloat') ONLY when TTL == 0s OR totalActiveTokens > 179k.
 */
export function evaluateHistoryBarState({
  totalActiveTokens = 0,
  safeHorizonTokens = SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS,
  cacheTtlRemainingSec = 300,
  isCacheTrulyWarm
} = {}) {
  const safeHorizon = Number(safeHorizonTokens) > 0
    ? Number(safeHorizonTokens)
    : SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS;
  // When strict warmth evidence is supplied, a 0% hit / 0 cache-read session is COLD_BLOAT even if TTL > 0s.
  const isNotTrulyWarm = isCacheTrulyWarm === false;
  const isColdOrOverHorizon = isNotTrulyWarm || Number(cacheTtlRemainingSec) <= 0 || Number(totalActiveTokens) > safeHorizon;

  if (isColdOrOverHorizon) {
    return {
      state: 'COLD_BLOAT',
      domState: 'cold-bloat',
      label: 'Reclaimable Cold Bloat',
      colorHex: '#f59e0b'
    };
  }

  return {
    state: 'CACHED_WARM',
    domState: 'cached-warm',
    label: 'Cached History \u2014 95% Discounted',
    colorHex: '#0d9488'
  };
}

/**
 * Phase 3 (Layer 3): Computes Dual-Watermark + Hard Ceiling visual markers for the context bar.
 */
export function computeWatermarks(maxTokens = 256000, safeLimit = 179000) {
  const denom = Math.max(1, Number(maxTokens) || 256000);
  const cascadeTokens = SESSION_RISK_THRESHOLDS.CASCADE_SYNC_WATERMARK_TOKENS;
  const attentionHorizonTokens = Math.round(denom * 0.70);
  return {
    cascadeSync: {
      tokens: cascadeTokens,
      pct: parseFloat(Math.min(100, (cascadeTokens / denom) * 100).toFixed(1)),
      label: 'Cascade Sync Armed',
      tooltip: WATERMARK_TOOLTIPS.CASCADE_SYNC_ARMED
    },
    attentionHorizon: {
      tokens: attentionHorizonTokens,
      safeLimitTokens: safeLimit,
      pct: parseFloat(Math.min(100, (attentionHorizonTokens / denom) * 100).toFixed(1)),
      label: 'Attention Horizon (Safe Limit)',
      tooltip: WATERMARK_TOOLTIPS.ATTENTION_HORIZON
    },
    hardCeiling: {
      tokens: denom,
      pct: 100,
      label: `${Math.round(denom / 1000)}k Hard Assembly Limit`,
      source: 'cortex/utils.GetCheckpointConfig',
      tooltip: WATERMARK_TOOLTIPS.CORTEX_HARD_CLAMP
    }
  };
}

/**
 * Classifies an array of parsed steps into a full 40-cell HorizonStatePayload
 */
export function classifyHorizon(rawSteps, options = {}) {
  const {
    sessionId = 'unknown',
    storeSource = 'antigravity',
    logTierUsed = 1,
    logFilePath = '',
    canonicalWorkspace = '',
    projectId = '',
    kiBleedMap = new Map(),
    modelId = 'gemini-3.8-flash',
    stdinContextWindow = null,
    stdinQuota = null,
    maxTokensOverride = null,
    useNativeCeiling = false,
    cacheDir = null,
    safeLimitTokens = undefined,
    reminderAtPct = 85
  } = options;

  let lastCheckpointIdx = -1;
  for (let i = rawSteps.length - 1; i >= 0; i--) {
    if (rawSteps[i] && isCompactionCheckpointStep(rawSteps[i])) {
      lastCheckpointIdx = i;
      break;
    }
  }
  const steps = lastCheckpointIdx >= 0 ? rawSteps.slice(lastCheckpointIdx) : rawSteps;
  const fullReReadEval = evaluateSmartFileReReads(rawSteps);
  const smartReReads = lastCheckpointIdx >= 0 ? evaluateSmartFileReReads(steps) : fullReReadEval;

  const activeConfig = options.config || loadFlightcheckConfig();
  const cliSettings = options.cliSettings || (
    options.cliSettingsPath || storeSource === 'antigravity-cli' || String(logFilePath).includes('antigravity-cli')
      ? loadCliSurfaceSettings(options.cliSettingsPath)
      : null
  );
  const ceilingDetails = resolveModelCeilingDetailed(modelId, stdinContextWindow, {
    useLegacyDefault: !useNativeCeiling,
    config: activeConfig,
    cliSettings
  });
  const resolvedMaxTokens = Number(maxTokensOverride) >= 20000
    ? Number(maxTokensOverride)
    : ceilingDetails.ceilingTokens;

  const parsedEffort = extractEffortTimeline(rawSteps);
  const rawEffortProfile = options.activeEffortProfile
    ? { ...options.activeEffortProfile }
    : (options.turnMetadata ? resolveEffortProfile(options.turnMetadata) : parsedEffort.activeEffortProfile);
  const activeEffortProfile = scaleEffortProfileForCeiling(rawEffortProfile, resolvedMaxTokens);
  const rawTransitions = Array.isArray(options.effortTransitions)
    ? options.effortTransitions
    : parsedEffort.effortHistory;

  const defaultSafeLimit = activeEffortProfile?.safeLimit || HORIZON_WINDOW.AMPUTATION_THRESHOLD_TOKENS;
  const safeLimit = Number(safeLimitTokens) > 0 ? Number(safeLimitTokens) : defaultSafeLimit;
  if (activeEffortProfile && activeEffortProfile.safeLimit !== safeLimit) {
    activeEffortProfile.safeLimit = safeLimit;
    if (activeEffortProfile.tier === 'STANDARD') {
      activeEffortProfile.limitReason = `${Math.round(safeLimit / 1000)}k recall ceiling`;
    }
  }
  const reminderAt = Math.round(safeLimit * (Number(reminderAtPct) > 0 ? Number(reminderAtPct) : 85) / 100);

  // Track file operations for stale duplicate detection & semantic reference pinning
  const latestFileTouchStep = new Map();
  const fileTouchCounts = new Map();
  const activeBackgroundDaemons = [];
  const activeWindowStart = Math.max(0, steps.length - HORIZON_WINDOW.ACTIVE_SET_STEP_WINDOW);
  const activeReferenceTokens = new Set();

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const calls = step.toolCalls || [];
    if (idx >= activeWindowStart) {
      const recentText = `${step.content || ''} ${JSON.stringify(calls)}`.toLowerCase();
      const identMatches = recentText.match(/[a-z0-9_.-]{4,64}/g) || [];
      for (const tok of identMatches) activeReferenceTokens.add(tok);
    }
    for (const call of calls) {
      const name = (call.name || '').toLowerCase();
      const args = call.args || {};
      const targetFile = args.Path || args.path || args.Target || args.target;
      if (targetFile && typeof targetFile === 'string' && !isInternalTelemetryPath(targetFile)) {
        const canon = canonicalizePath(targetFile);
        latestFileTouchStep.set(canon, idx);
        fileTouchCounts.set(canon, (fileTouchCounts.get(canon) || 0) + 1);
      }

      if (name === 'run_command') {
        if (args.IsDaemon === true) {
          activeBackgroundDaemons.push({
            taskId: args.TaskId || `step-${idx}`,
            command: args.CommandLine || '',
            stepIndex: idx
          });
        }
      } else if (name === 'manage_task') {
        if (args.Action === 'kill' && args.TaskId) {
          const dIdx = activeBackgroundDaemons.findIndex(d => d.taskId === args.TaskId);
          if (dIdx !== -1) activeBackgroundDaemons.splice(dIdx, 1);
        }
      }
    }
  }

  // Classify each step into categories & tokens
  const totalTurns = steps.length;
  let totalActiveTokens = 0;
  const classifiedSteps = [];

  const categoryTotals = {
    [CATEGORIES.ANCHOR]: 0,
    [CATEGORIES.MEMORY_KI]: 0,
    [CATEGORIES.FOREIGN_BLEED]: 0,
    [CATEGORIES.STALE_DUPLICATE]: 0,
    [CATEGORIES.DEAD_ERROR]: 0,
    [CATEGORIES.ACTIVE_WORKING_SET]: 0,
    [CATEGORIES.FREE_HEADROOM]: 0
  };

  const offenderMap = new Map();
  let rawLiveTokens = 0;

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const estFromLength = Number(step.untruncatedLength) > 0 ? Math.round(step.untruncatedLength / 4) : 0;
    let tokens = step.inputTokens > 0 && step.outputTokens > 0
      ? Math.max(step.outputTokens, estFromLength)
      : (step.outputTokens || estFromLength || 1000);

    if (step.stepIndex === 0 && step.inputTokens > 0) {
      tokens = step.inputTokens;
    }

    let category = CATEGORIES.ACTIVE_WORKING_SET;
    let target = '';

    const contentStr = String(step.content || '');
    const calls = step.toolCalls || [];
    const isError = step.status === 'ERROR' || step.exitCode === 1 || contentStr.includes('Traceback (most recent call last)');

    // 1. Anchor detection
    if (
      step.stepIndex === 0 ||
      isCompactionCheckpointStep(step) ||
      step.type === 'SYSTEM_PROMPT' ||
      contentStr.includes('rules/') ||
      contentStr.includes('task.md') ||
      contentStr.includes('implementation_plan.md')
    ) {
      category = CATEGORIES.ANCHOR;
      target = 'System & Project Anchors';
    }
    // 2. Knowledge Memory & Bleed detection
    else if (
      contentStr.includes('knowledge://') ||
      calls.some(c => (c.name || '').includes('knowledge') || (c.args?.Uri || '').includes('knowledge'))
    ) {
      let isBleed = false;
      for (const [kiName, info] of kiBleedMap.entries()) {
        if (contentStr.includes(kiName) || calls.some(c => JSON.stringify(c).includes(kiName))) {
          if (info.isBleed) isBleed = true;
        }
      }
      category = isBleed ? CATEGORIES.FOREIGN_BLEED : CATEGORIES.MEMORY_KI;
      target = isBleed ? 'Foreign Bleed Knowledge' : 'Project Knowledge Item';
    }
    // 3. Dead Error detection
    else if (isError) {
      category = CATEGORIES.DEAD_ERROR;
      const cmdCall = calls.find(c => (c.name || '').toLowerCase() === 'run_command');
      target = cmdCall?.args?.CommandLine ? `Command: ${cmdCall.args.CommandLine}` : 'Resolved Stack Trace';
      const off = offenderMap.get(target) || { category, target, occurrences: 0, wastedTokens: 0, stepIndices: [] };
      off.occurrences += 1;
      off.wastedTokens += tokens;
      off.stepIndices.push(idx);
      offenderMap.set(target, off);
    }
    // 4. Smart File Re-Read Classifier (Phase 5 Layer 5) & Semantic Reference Pinning (T2.2)
    else {
      let isStale = false;
      let stepFileBasename = '';
      for (const call of calls) {
        const args = call.args || {};
        const targetFile = args.Path || args.path || args.Target || args.target || args.TargetFile || args.AbsolutePath;
        if (targetFile) {
          stepFileBasename = path.basename(String(targetFile)).toLowerCase();
          break;
        }
      }
      if (smartReReads.wasteTargetByStep.has(idx)) {
        isStale = true;
        target = smartReReads.wasteTargetByStep.get(idx);
      }

      let semanticallyPinned = false;
      if (!isStale && idx < totalTurns - HORIZON_WINDOW.STALE_STEP_THRESHOLD) {
        // Check if this older turn defines a file or schema/type symbol still referenced in the active window
        const declMatch = contentStr.match(/\b(?:interface|type|class|struct|CREATE\s+TABLE|schema)\s+([A-Za-z0-9_]{4,64})/i);
        const declaredSymbol = declMatch ? declMatch[1].toLowerCase() : '';
        if (
          (stepFileBasename && activeReferenceTokens.has(stepFileBasename)) ||
          (declaredSymbol && activeReferenceTokens.has(declaredSymbol))
        ) {
          semanticallyPinned = true;
          isStale = false;
          target = stepFileBasename ? `Pinned Reference (${stepFileBasename})` : `Pinned Schema (${declaredSymbol})`;
        } else {
          isStale = true;
          target = 'Older chat history (>25 turns ago)';
        }
      }

      if (isStale) {
        category = CATEGORIES.STALE_DUPLICATE;
        const off = offenderMap.get(target || 'Stale Read') || { category, target: target || 'Stale Read', occurrences: 0, wastedTokens: 0, stepIndices: [] };
        off.occurrences += 1;
        off.wastedTokens += tokens;
        off.stepIndices.push(idx);
        offenderMap.set(target || 'Stale Read', off);
      } else {
        category = CATEGORIES.ACTIVE_WORKING_SET;
        if (!semanticallyPinned) target = 'Active Coding & Context';
      }
    }

    categoryTotals[category] += tokens;
    totalActiveTokens += tokens;
    // Live session work = pinned task/plan state + recent active turns; the rest of the useful set is workspace baseline
    const isRuleAnchor = step.stepIndex === 0 || step.type === 'SYSTEM_PROMPT' || contentStr.includes('rules/');
    if (category === CATEGORIES.ACTIVE_WORKING_SET || (category === CATEGORIES.ANCHOR && !isRuleAnchor)) rawLiveTokens += tokens;

    classifiedSteps.push({
      stepIndex: idx,
      category,
      tokens,
      target,
      semanticallyPinned: target.startsWith('Pinned '),
      rawContent: contentStr
    });
  }

  const rawTotalTokens = Math.max(1, totalActiveTokens);
  // Reconcile total active tokens with stdin context window if provided
  if (stdinContextWindow && stdinContextWindow.total_input_tokens > 0) {
    const scale = stdinContextWindow.total_input_tokens / Math.max(1, totalActiveTokens);
    totalActiveTokens = stdinContextWindow.total_input_tokens;
    for (const cat of Object.keys(categoryTotals)) {
      categoryTotals[cat] = 0;
    }
    for (const s of classifiedSteps) {
      s.tokens = Math.round(s.tokens * scale);
      categoryTotals[s.category] = (categoryTotals[s.category] || 0) + s.tokens;
    }
    const scaledSum = Object.values(categoryTotals).reduce((acc, v) => acc + v, 0);
    const residual = totalActiveTokens - scaledSum;
    if (residual !== 0 && classifiedSteps.length > 0) {
      let maxStep = classifiedSteps[0];
      for (const s of classifiedSteps) {
        if (s.tokens > maxStep.tokens) maxStep = s;
      }
      maxStep.tokens = Math.max(0, maxStep.tokens + residual);
      categoryTotals[maxStep.category] = Math.max(0, (categoryTotals[maxStep.category] || 0) + residual);
    }
    for (const off of offenderMap.values()) {
      off.wastedTokens = off.stepIndices.reduce((sum, sIdx) => sum + (classifiedSteps[sIdx]?.tokens || 0), 0);
    }
  }

  // If session crosses 200k tokens on legacy default, auto-promote ceiling to 256k (or 1M) so 40 cells never overflow
  const effectiveMaxTokens = (totalActiveTokens > resolvedMaxTokens && resolvedMaxTokens === 200000)
    ? (totalActiveTokens > 256000 ? 1000000 : 256000)
    : resolvedMaxTokens;
  const effectiveCellSize = Math.max(
    Math.round(effectiveMaxTokens / HORIZON_WINDOW.TOTAL_CELLS),
    Math.ceil(totalActiveTokens / HORIZON_WINDOW.TOTAL_CELLS) || HORIZON_WINDOW.CELL_SIZE_TOKENS
  );

  const freeHeadroom = Math.max(0, effectiveMaxTokens - totalActiveTokens);
  categoryTotals[CATEGORIES.FREE_HEADROOM] = freeHeadroom;

  // Build the 40 cells chronologically (Turn 0 on left -> Current Turn on right)
  const cells = [];
  const activeCellsCount = Math.min(HORIZON_WINDOW.TOTAL_CELLS, Math.ceil(totalActiveTokens / effectiveCellSize));

  let currentStepIdx = 0;
  let stepTokenOffset = 0;

  for (let cellIdx = 0; cellIdx < HORIZON_WINDOW.TOTAL_CELLS; cellIdx++) {
    const cellStartToken = cellIdx * effectiveCellSize;
    const cellEndToken = (cellIdx + 1) * effectiveCellSize;

    if (cellStartToken >= totalActiveTokens) {
      cells.push({
        index: cellIdx,
        tokenRange: [cellStartToken, cellEndToken],
        turnRange: [-1, -1],
        dominantCategory: CATEGORIES.FREE_HEADROOM,
        isAmputationZone: false,
        isCrisisCell: false,
        attentionWeight: 0.20,
        attentionZone: 'FREE_HEADROOM',
        inAttentionTrough: false,
        isStrandedSignal: false,
        strandedWarning: '',
        turnsDetail: [],
        fractures: [],
        hasFracture: false,
        tokensByCategory: { [CATEGORIES.FREE_HEADROOM]: effectiveCellSize },
        topTarget: 'Free Token Headroom'
      });
      continue;
    }

    const bucketCategories = {};
    let bucketTokensRemaining = Math.min(effectiveCellSize, totalActiveTokens - cellStartToken);
    let cellTurns = [];
    const cellTurnsDetailMap = new Map();
    let dominantCat = CATEGORIES.ACTIVE_WORKING_SET;
    let maxCatTokens = -1;
    let topTarget = '';

    while (bucketTokensRemaining > 0 && currentStepIdx < classifiedSteps.length) {
      const step = classifiedSteps[currentStepIdx];
      const rawStep = steps[step.stepIndex] || {};
      const stepRemainingTokens = step.tokens - stepTokenOffset;
      const consume = Math.min(bucketTokensRemaining, stepRemainingTokens);

      bucketCategories[step.category] = (bucketCategories[step.category] || 0) + consume;
      if (bucketCategories[step.category] > maxCatTokens) {
        maxCatTokens = bucketCategories[step.category];
        dominantCat = step.category;
        topTarget = step.target;
      }

      cellTurns.push(step.stepIndex);
      if (!cellTurnsDetailMap.has(step.stepIndex)) {
        const rawCalls = rawStep.toolCalls || rawStep.tool_calls || [];
        const toolCallLabels = rawCalls.map(c => {
          const nm = c.name || c.tool || 'tool';
          const arg = c.args?.Path || c.args?.path || c.args?.CommandLine || c.args?.ServerName || '';
          return arg ? `${nm}(${String(arg).slice(0, 60)})` : nm;
        });
        cellTurnsDetailMap.set(step.stepIndex, {
          stepIndex: step.stepIndex,
          category: step.category,
          tokens: consume,
          target: step.target || 'Turn',
          toolCalls: toolCallLabels
        });
      } else {
        cellTurnsDetailMap.get(step.stepIndex).tokens += consume;
      }

      bucketTokensRemaining -= consume;
      stepTokenOffset += consume;

      if (stepTokenOffset >= step.tokens) {
        currentStepIdx++;
        stepTokenOffset = 0;
      }
    }

    const isAmputationZone = totalActiveTokens > safeLimit && cellIdx < HORIZON_WINDOW.AMPUTATION_CELL_COUNT;
    const parabolic = calculateParabolicAttentionCurve(cellIdx, Math.max(1, activeCellsCount));
    const attentionWeight = parabolic.uShapedWeight;
    const meetsTokenFloor = totalActiveTokens >= 44800 && activeCellsCount >= 7;
    const inTrough = meetsTokenFloor && parabolic.inTrough;
    const hasActiveOrRuleBuffer =
      dominantCat === CATEGORIES.ACTIVE_WORKING_SET ||
      dominantCat === CATEGORIES.ANCHOR ||
      (bucketCategories[CATEGORIES.ACTIVE_WORKING_SET] || 0) > 0 ||
      (bucketCategories[CATEGORIES.ANCHOR] || 0) > 0;
    const isStrandedSignal = inTrough && hasActiveOrRuleBuffer;

    cells.push({
      index: cellIdx,
      tokenRange: [cellStartToken, cellEndToken],
      turnRange: [cellTurns[0] ?? 0, cellTurns[cellTurns.length - 1] ?? 0],
      dominantCategory: dominantCat,
      isAmputationZone,
      isCrisisCell: false,
      attentionWeight,
      attentionZone: parabolic.zone,
      inAttentionTrough: inTrough,
      parabolicAttention: parabolic,
      isStrandedSignal,
      strandedWarning: isStrandedSignal ? STRANDED_SIGNAL_WARNING_TEXT : '',
      turnsDetail: Array.from(cellTurnsDetailMap.values()),
      fractures: [],
      hasFracture: false,
      tokensByCategory: bucketCategories,
      topTarget
    });
  }

  // Map effort transitions to their corresponding 5k-token block indices (0..39)
  const effortTransitions = rawTransitions.map(tr => {
    const tIdx = tr.turnIndex ?? tr.stepNumber ?? 0;
    const stepNum = tr.stepNumber ?? tr.turnIndex ?? 0;
    let matchedBlock = -1;
    for (const c of cells) {
      if (c.turnRange && c.turnRange[0] >= 0 && tIdx >= c.turnRange[0] && tIdx <= c.turnRange[1]) {
        matchedBlock = c.index;
        break;
      }
    }
    if (matchedBlock < 0 && typeof tr.blockIndex === 'number' && tr.blockIndex >= 0) {
      matchedBlock = Math.min(39, tr.blockIndex);
    }
    if (matchedBlock < 0) {
      matchedBlock = Math.min(39, Math.max(0, Math.floor((tIdx / Math.max(1, totalTurns)) * Math.max(1, activeCellsCount))));
    }
    const enriched = {
      ...tr,
      turnIndex: tIdx,
      stepNumber: stepNum,
      blockIndex: matchedBlock
    };
    if (cells[matchedBlock]) {
      cells[matchedBlock].effortTransitions = cells[matchedBlock].effortTransitions || [];
      cells[matchedBlock].effortTransitions.push(enriched);
    }
    return enriched;
  });

  // Prefix Amputation Bracket & Crisis evaluation
  // Truncation Zone is Cells 0..7 (earliest 40k tokens) when total tokens > safe limit (default 140k)
  const inAmputationZone = totalActiveTokens > safeLimit;

  // Crisis condition specifically requires:
  // 1. Total tokens nearing 200k limit (> 180,000) OR
  // 2. Active background daemon in cells 0..7 OR
  // 3. Uncompleted task/plan checkpoint in cells 0..7
  const earlySteps = classifiedSteps.filter(s => s.stepIndex <= 7);
  const uncompletedPlanInZone = earlySteps.some(s => s.rawContent.includes('- [ ]'));
  const daemonsAtRisk = activeBackgroundDaemons.filter(d => d.stepIndex <= 7);
  const extremeTokenLimit = totalActiveTokens >= 180000;

  const amputationCrisis = inAmputationZone && (daemonsAtRisk.length > 0 || uncompletedPlanInZone || extremeTokenLimit);

  if (amputationCrisis) {
    for (let c = 0; c < Math.min(HORIZON_WINDOW.AMPUTATION_CELL_COUNT, cells.length); c++) {
      cells[c].isCrisisCell = true;
    }
  }

  // Metrics computation
  const signalTokens = categoryTotals[CATEGORIES.ANCHOR] + categoryTotals[CATEGORIES.ACTIVE_WORKING_SET];
  const signalPurityPct = Math.round((signalTokens / Math.max(1, totalActiveTokens)) * 100);

  const pricePerM = resolvePricePerM(modelId, activeConfig);
  const sludgeTokens = categoryTotals[CATEGORIES.STALE_DUPLICATE] + categoryTotals[CATEGORIES.DEAD_ERROR] + categoryTotals[CATEGORIES.FOREIGN_BLEED];
  const sludgeTaxPerTurnUsd = parseFloat(((sludgeTokens / 1000000) * pricePerM).toFixed(4));
  const totalTurnCostUsd = parseFloat(((totalActiveTokens / 1000000) * pricePerM).toFixed(4));

  // Health band
  let healthBand = 'OPTIMAL_FOCUS';
  if (amputationCrisis) healthBand = 'AMPUTATION_CRISIS';
  else if (signalPurityPct < 40) healthBand = 'CRITICAL_SLUDGE';
  else if (signalPurityPct < 75) healthBand = 'VISIBLE_CLUTTER';

  // Format Top Offenders Ledger
  const offenders = Array.from(offenderMap.values())
    .sort((a, b) => b.wastedTokens - a.wastedTokens)
    .slice(0, 5)
    .map((off, rank) => {
      const avgStep = off.stepIndices.reduce((acc, v) => acc + v, 0) / (off.stepIndices.length || 1);
      const estCell = Math.min(39, Math.floor((avgStep / Math.max(1, totalTurns)) * activeCellsCount));
      const recallPct = Math.round(calculateAttentionWeight(estCell, activeCellsCount) * 100);
      const costUsd = parseFloat(((off.wastedTokens / 1000000) * pricePerM).toFixed(4));

      return {
        rank: rank + 1,
        target: off.target,
        category: off.category,
        occurrences: off.occurrences,
        stepIndices: off.stepIndices,
        wastedTokens: off.wastedTokens,
        sludgeCostPerTurnUsd: costUsd,
        attentionRecallPct: recallPct,
        remediation: off.category === CATEGORIES.DEAD_ERROR
          ? 'Prune resolved stack traces via /compact'
          : 'Deduplicate file reads via /compact'
      };
    });

  // Plain-Language Token-Based Diagnostics (Zero $ references)
  const reclaimK = Math.round(sludgeTokens / 1000);
  let whatsHappening = '';
  let theSludgeTax = '';
  let actionPlan = '';
  let recommendedCommand = '/fast';

  if (amputationCrisis) {
    whatsHappening = `Prefix truncation alert! Total memory (> ${Math.round(reminderAt / 1000)}k tokens) or early task checkpoints are inside the ${Math.round(safeLimit / 1000)}k+ truncation zone.`;
    theSludgeTax = `${reclaimK}k reclaimable noise tokens (${100 - signalPurityPct}% of active context) are pushing your earliest rules toward truncation.`;
    actionPlan = `Save progress to task.md and start a fresh chat or run /clear now.`;
    recommendedCommand = '/clear';
  } else if (signalPurityPct < 40 || inAmputationZone) {
    whatsHappening = `High context dilution: ${(100 - signalPurityPct)}% of active memory (${reclaimK}k tokens) consists of outdated turns and repeated file reads.`;
    theSludgeTax = `${reclaimK}k tokens can be reclaimed immediately via /compact. Middle-window recall has dropped to ~24%.`;
    actionPlan = `Run /compact to compress older history and drop duplicate file snapshots while keeping active rules intact.`;
    recommendedCommand = '/compact';
  } else if (signalPurityPct < 75) {
    whatsHappening = `Moderate context clutter (${reclaimK}k reclaimable tokens). Working set is healthy, but duplicate file reads are accumulating.`;
    theSludgeTax = `${reclaimK}k tokens of outdated history can be freed.`;
    actionPlan = `Run /compact when you finish the current step to reclaim ${reclaimK}k tokens.`;
    recommendedCommand = '/compact';
  } else {
    whatsHappening = `High-efficiency session. Memory is clean and focused on active workspace files with plenty of safe headroom.`;
    theSludgeTax = `Minimal noise (${reclaimK}k tokens). Signal purity is optimal at ${signalPurityPct}%.`;
    actionPlan = `Memory is clean. Continue working normally.`;
    recommendedCommand = '/fast';
  }

  // Compute actionable Brain Signals from transcript forensics
  const allOffenders = Array.from(offenderMap.values());
  const dupFileOffenders = allOffenders
    .filter(o => o.category === CATEGORIES.STALE_DUPLICATE && o.target !== 'Older chat history (>25 turns ago)')
    .sort((a, b) => b.wastedTokens - a.wastedTokens);
  const oldHistOffender = allOffenders.find(o => o.target === 'Older chat history (>25 turns ago)');
  const errorOffenders = allOffenders.filter(o => o.category === CATEGORIES.DEAD_ERROR);

  const blowupSteps = classifiedSteps
    .filter(s => s.tokens >= 8000 && s.stepIndex > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map(s => {
      const call = (steps[s.stepIndex]?.toolCalls || [])[0];
      const args = call?.args || {};
      const filePath = args.Path || args.path || args.AbsolutePath || null;
      const command = args.CommandLine || null;
      return {
        stepIndex: s.stepIndex,
        tokens: s.tokens,
        category: s.category,
        target: s.target || `Step ${s.stepIndex}`,
        payload: {
          kind: command ? 'command' : (filePath ? 'file' : 'other'),
          tool: call?.name || null,
          detail: String(command || filePath || call?.name || 'Model/tool output').slice(0, 300),
          path: filePath
        }
      };
    });

  const recentSteps = steps.slice(-10);
  const recentErrors = recentSteps.filter(s => s.status === 'ERROR' || s.exitCode === 1).length;

  let correctionCount = 0;
  const userCorrectionTexts = [];
  for (const s of steps) {
    if (s.source === 'USER_EXPLICIT' || s.type === 'USER_INPUT') {
      const rawTxt = String(s.content || '').trim();
      const lower = rawTxt.toLowerCase();
      if (/\b(no[, ]|don't|do not|instead|wrong|looks the same|shouldn't|broken|still not)\b/.test(lower)) {
        correctionCount++;
        if (rawTxt) userCorrectionTexts.push(rawTxt.slice(0, 100));
      }
    }
  }

  // task.md freshness: user turns since the last tool call that wrote task.md
  const isUserTurn = x => x.source === 'USER_EXPLICIT' || x.type === 'USER_INPUT';
  const isTaskWrite = x => (x.toolCalls || []).some(c =>
    /write|edit|replace|create/i.test(c.name || '') &&
    /task\.md/i.test(String(c.args?.Path || c.args?.path || c.args?.TargetFile || c.args?.AbsolutePath || '')));
  let lastTaskWrite = -1;
  steps.forEach((x, i) => { if (isTaskWrite(x)) lastTaskWrite = i; });
  const taskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;

  const pinnedStepsCount = classifiedSteps.filter(s => s.semanticallyPinned).length;

  // Session Forensics (plan churn, proof quality, context rot, error loop)
  const planChurn = computePlanChurn(steps, options.config || {});
  const proofQuality = gradeProofQuality(steps);
  const contextRot = detectContextRot(steps, {
    totalActiveTokens,
    correctionCount,
    lateStageTaskChurn: planChurn.lateStageTaskChurn,
    signalPurityPct
  }, options.config || {});
  const errorLoop = fingerprintErrorLoop(steps);

  let brainDir = options.brainDir || null;
  if (!brainDir && logFilePath) {
    try {
      const parent2 = path.resolve(path.dirname(logFilePath), '..', '..');
      if (path.basename(path.dirname(parent2)) === 'brain' || path.basename(parent2).length > 20) {
        brainDir = parent2;
      }
    } catch {}
  }
  const handoff = auditHandoff(brainDir || canonicalWorkspace, {
    planChurn,
    errorLoop,
    deadErrors: { isErrorLoop: recentErrors >= 3 || errorLoop.loop },
    activeSignal: { taskMdTurnsBehind: taskTurnsBehind }
  }, {
    workspacePath: canonicalWorkspace,
    gitPorcelainOutput: options.gitPorcelainOutput
  });

  const mcpAudit = auditMcpPrefixBloat({
    workspaceDir: canonicalWorkspace,
    homeDir: options.homeDir,
    steps
  });
  const rulePromotion = auditRuleFileAttentionAndLineLimit(canonicalWorkspace);

  const brainSignals = {
    activeSignal: {
      liveSessionTokens: Math.round((rawLiveTokens / rawTotalTokens) * totalActiveTokens),
      taskMdSaved: lastTaskWrite >= 0,
      taskMdTurnsBehind: taskTurnsBehind,
      semanticallyPinnedTurns: pinnedStepsCount
    },
    duplicateReads: {
      fileCount: dupFileOffenders.length,
      reclaimableTokens: dupFileOffenders.reduce((sum, o) => sum + o.wastedTokens, 0),
      topFiles: dupFileOffenders.slice(0, 5).map(o => ({
        path: o.target,
        occurrences: o.occurrences,
        wastedTokens: o.wastedTokens
      })),
      exemptedReReads: fullReReadEval.exemptedReReads
    },
    oldHistory: {
      turnCount: oldHistOffender ? oldHistOffender.occurrences : 0,
      reclaimableTokens: oldHistOffender ? oldHistOffender.wastedTokens : 0
    },
    deadErrors: {
      errorCount: errorOffenders.reduce((sum, o) => sum + o.occurrences, 0),
      reclaimableTokens: categoryTotals[CATEGORIES.DEAD_ERROR] || 0,
      isErrorLoop: recentErrors >= 3 || errorLoop.loop,
      topErrors: errorOffenders.slice(0, 3).map(o => ({
        target: o.target,
        occurrences: o.occurrences,
        wastedTokens: o.wastedTokens
      }))
    },
    blowupSteps,
    userCorrections: correctionCount,
    userCorrectionTexts,
    activeDaemons: activeBackgroundDaemons,
    planChurn,
    proofQuality,
    contextRot,
    errorLoop,
    handoff,
    mcpAudit,
    rulePromotion
  };

  const aiCreditOveragesEnabled = Boolean(
    options.aiCreditOveragesEnabled ??
    stdinQuota?.enable_ai_credit_overages ??
    stdinQuota?.aiCreditOveragesEnabled ??
    false
  );

  // Compute Dual-Pool Quota & Cache-Read Telemetry (T2.1 + Phase 2 Layer 2)
  const quota = computeQuotaAndCacheTelemetry(steps, {
    sessionId,
    modelId,
    totalActiveTokens,
    activeEffortProfile,
    stdinQuota,
    genMetadata: options.genMetadata || null,
    aiCreditOveragesEnabled,
    cacheDir
  });

  // Detect pending checklist items in task.md (or recent task writes) for Cascade >50k checkpointer arming
  let hasPendingTaskItems = false;
  if (options.hasPendingTaskItems !== undefined) {
    hasPendingTaskItems = Boolean(options.hasPendingTaskItems);
  } else if (handoff?.targetFile && fs.existsSync(handoff.targetFile)) {
    try {
      const taskText = fs.readFileSync(handoff.targetFile, 'utf8');
      hasPendingTaskItems = /^[-*]\s*\[ \]/m.test(taskText);
    } catch {}
  } else if (lastTaskWrite >= 0) {
    hasPendingTaskItems = steps.slice(lastTaskWrite).some(s => String(s.content || '').includes('- [ ]'));
  }
  brainSignals.activeSignal.hasPendingTaskItems = hasPendingTaskItems;

  const sessionRisk = evaluateCompositeSessionRisk({
    totalActiveTokens,
    safeHorizonTokens: Math.min(safeLimit, SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS),
    cacheTtlRemainingSec: quota.cache?.ttlRemainingSec ?? 300,
    cacheReadTokens: quota.cache?.cacheReadTokens ?? 0,
    cacheHitRatePct: quota.cache?.hitRatePct ?? 0,
    taskMdTurnsBehind: taskTurnsBehind,
    hasPendingTaskItems,
    weekly7dUsedPct: quota.weekly7d?.usedPct ?? 0,
    weekly7dLockoutRisk: Boolean(quota.weekly7d?.lockoutRisk),
    aiCreditOveragesEnabled,
    prefixBustDetected: Boolean(quota.cache?.prefixBustDetected)
  });
  const surfaceTag = resolveSurfaceTag(storeSource || logFilePath);
  const watermarks = computeWatermarks(effectiveMaxTokens, safeLimit);
  const historyBarState = evaluateHistoryBarState({
    totalActiveTokens,
    safeHorizonTokens: SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS,
    cacheTtlRemainingSec: quota.cache?.ttlRemainingSec ?? 300,
    isCacheTrulyWarm: sessionRisk.isCacheTrulyWarm
  });

  // Phase 4 (Layer 4): Parameterized /compact synthesizer, Cache-Aware Advisory & Baton Pass (/handoff)
  const activeFileCandidates = Array.from(latestFileTouchStep.keys()).filter(p => !isInternalTelemetryPath(p));
  const fallbackDupFiles = dupFileOffenders.map(o => o.target).filter(p => !isInternalTelemetryPath(p));
  const cleanActiveFiles = activeFileCandidates.length > 0 ? activeFileCandidates : fallbackDupFiles;
  const parameterizedCommand = synthesizeParameterizedCompact({
    activeFiles: cleanActiveFiles,
    userCorrections: userCorrectionTexts,
    steps,
    workspaceRoot: canonicalWorkspace
  });
  const cacheAdvisory = evaluateCompactionCacheAdvisory({
    cacheTtlRemainingSec: quota.cache?.ttlRemainingSec ?? 300,
    totalActiveTokens,
    safeHorizonTokens: SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS,
    isCacheTrulyWarm: sessionRisk.isCacheTrulyWarm
  });
  const batonPass = synthesizeBatonPassHandoffCommand({
    activeFiles: cleanActiveFiles
  });
  const compaction = {
    parameterizedCommand,
    cacheAdvisory,
    batonPass,
    preCompactionWarning: Boolean(handoff?.preCompactionWarning),
    preCompactionWarningMessage: handoff?.preCompactionWarningMessage || ''
  };

  // Compute Multi-Agent (invoke_subagent) Context Tree & Handoff Compression (T2.3)
  const subagents = inspectSubagentTree(steps, { cacheDir });
  for (const inv of subagents.invocations) {
    for (const c of cells) {
      if (c.turnRange && c.turnRange[0] >= 0 && inv.stepIndex >= c.turnRange[0] && inv.stepIndex <= c.turnRange[1]) {
        c.subagents = c.subagents || [];
        c.subagents.push(inv);
        break;
      }
    }
  }

  // Phase 6 (Layer 6): Session Fracture Markers (⚡) & Stranded Signal Summary
  const fractures = [];
  const mapStepToCellIndex = (stepIdx) => {
    for (const c of cells) {
      if (c.turnRange && c.turnRange[0] >= 0 && stepIdx >= c.turnRange[0] && stepIdx <= c.turnRange[1]) {
        return c.index;
      }
    }
    return Math.min(39, Math.max(0, Math.floor((stepIdx / Math.max(1, totalTurns)) * Math.max(1, activeCellsCount))));
  };

  if (lastCheckpointIdx >= 0) {
    fractures.push({
      type: 'COMPACTION',
      glyph: '\u26A1',
      stepIndex: 0,
      rawStepIndex: lastCheckpointIdx,
      cellIndex: 0,
      label: `Compaction Checkpoint (step_type == ${CORTEX_STEP_TYPE_CHECKPOINT}) at Turn #${lastCheckpointIdx}`
    });
  }
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (i > 0 && isCompactionCheckpointStep(st)) {
      const cIdx = mapStepToCellIndex(i);
      fractures.push({
        type: 'COMPACTION',
        glyph: '\u26A1',
        stepIndex: i,
        cellIndex: cIdx,
        label: `Compaction Checkpoint (step_type == ${CORTEX_STEP_TYPE_CHECKPOINT}) at Turn #${i}`
      });
    }
    if (i > 0) {
      const prev = steps[i - 1];
      const currCache = Number(st?.cacheReadTokens || 0);
      const prevCache = Number(prev?.cacheReadTokens || 0);
      const currInput = Number(st?.inputTokens || st?.outputTokens || 0);
      let deltaSec = 60;
      if (st?.createdAt && prev?.createdAt) {
        const dMs = Date.parse(st.createdAt) - Date.parse(prev.createdAt);
        if (Number.isFinite(dMs) && dMs >= 0) deltaSec = dMs / 1000;
      }
      if (currCache === 0 && prevCache > 0 && currInput > 0 && deltaSec < 300) {
        const cIdx = mapStepToCellIndex(i);
        fractures.push({
          type: 'PREFIX_BUST',
          glyph: '\u26A1',
          stepIndex: i,
          cellIndex: cIdx,
          deltaSec: Math.round(deltaSec),
          label: `Mid-run Prefix Bust (cache_read_tokens == 0 at \u0394t = ${Math.round(deltaSec)}s < 300s) at Turn #${i}`
        });
      }
    }
  }
  if (quota.cache?.prefixBustDetected && !fractures.some(f => f.type === 'PREFIX_BUST')) {
    const lastActiveCellIdx = Math.max(0, activeCellsCount - 1);
    fractures.push({
      type: 'PREFIX_BUST',
      glyph: '\u26A1',
      stepIndex: Math.max(0, totalTurns - 1),
      cellIndex: lastActiveCellIdx,
      deltaSec: quota.cache?.prefixBustDeltaSec ?? 0,
      label: quota.cache?.prefixBustLabel || '\u26A0\uFE0F Prefix Bust (system_message / config drift)'
    });
  }

  for (const frac of fractures) {
    const targetCell = cells[frac.cellIndex];
    if (targetCell) {
      targetCell.fractures = targetCell.fractures || [];
      targetCell.fractures.push(frac);
      targetCell.hasFracture = true;
    }
  }

  const troughCells = cells.filter(c => c.inAttentionTrough);
  const strandedSignals = cells
    .filter(c => c.isStrandedSignal)
    .map(c => ({
      cellIndex: c.index,
      cellNumber: c.index + 1,
      dominantCategory: c.dominantCategory,
      topTarget: c.topTarget,
      attentionWeight: c.attentionWeight,
      turnRange: c.turnRange,
      warning: STRANDED_SIGNAL_WARNING_TEXT
    }));

  const attentionHeatmap = {
    gamma: ATTENTION_TROUGH_CONFIG.GAMMA,
    activeCellsCount,
    troughStartRatio: ATTENTION_TROUGH_CONFIG.TROUGH_START_RATIO,
    troughEndRatio: ATTENTION_TROUGH_CONFIG.TROUGH_END_RATIO,
    troughCellIndices: troughCells.map(c => c.index),
    strandedSignalCount: strandedSignals.length,
    strandedSignals,
    strandedWarningText: STRANDED_SIGNAL_WARNING_TEXT,
    fractureCount: fractures.length,
    fractures
  };

  return {
    schemaVersion: '1.1.0',
    sessionId,
    storeSource,
    surfaceTag,
    brainDir: brainDir || null,
    logTierUsed,
    logFilePath,
    workspace: {
      canonicalPath: canonicalWorkspace,
      projectId
    },
    model: {
      id: modelId,
      inputPricePerMillionUsd: pricePerM,
      nativeCeilingTokens: ceilingDetails.ceilingTokens,
      ceilingSource: ceilingDetails.source,
      isClamped1MModel: Boolean(ceilingDetails.isClamped1MModel),
      clampedLabel: ceilingDetails.clampedLabel || '',
      patchedTier: ceilingDetails.patchedTier || null
    },
    parseHealth: options.parseHealth || rawSteps.health || {
      totalLines: rawSteps.length,
      parsedLines: rawSteps.length,
      malformedLines: 0,
      unknownShapeLines: 0,
      confidence: 'HIGH'
    },
    confidence: (options.parseHealth || rawSteps.health)?.confidence || 'HIGH',
    window: {
      maxTokens: effectiveMaxTokens,
      cellSizeTokens: effectiveCellSize,
      totalCells: HORIZON_WINDOW.TOTAL_CELLS,
      totalActiveTokens,
      usedPercentage: parseFloat(((totalActiveTokens / effectiveMaxTokens) * 100).toFixed(1)),
      exceeds200kTokens: totalActiveTokens >= 200000,
      turnCount: totalTurns,
      safeLimit,
      safeHeadroomTokens: Math.max(0, safeLimit - totalActiveTokens),
      reminderAt,
      watermarks,
      historyBarState
    },
    breakdown: categoryTotals,
    metrics: {
      signalPurityPct,
      sludgeTokens,
      sludgeTaxPerTurnUsd,
      totalTurnCostUsd,
      healthBand,
      displayParity: computeDisplayTenthsParity(totalActiveTokens, Math.max(0, totalActiveTokens - sludgeTokens))
    },
    amputation: {
      inAmputationZone,
      bracketCells: [0, HORIZON_WINDOW.AMPUTATION_CELL_COUNT - 1],
      truncationRiskTokens: inAmputationZone ? HORIZON_WINDOW.AMPUTATION_CELL_COUNT * effectiveCellSize : 0,
      amputationCrisis,
      anchorsAtRisk: Array.from(new Set(earlySteps.filter(s => s.category === CATEGORIES.ANCHOR).map(s => s.target))),
      activeDaemonsAtRisk: daemonsAtRisk
    },
    cells,
    attentionHeatmap,
    offenders,
    brainSignals,
    quota,
    sessionRisk,
    compaction,
    subagents,
    activeEffortProfile,
    effortTransitions,
    effortHistory: effortTransitions,
    diagnostics: {
      whatsHappening,
      theSludgeTax,
      actionPlan,
      recommendedCommand
    },
    updatedAt: new Date().toISOString()
  };
}
```
