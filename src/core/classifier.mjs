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
  scaleEffortProfileForCeiling,
  computeUnifiedContextPool,
  evaluateCarbonVerbosityGuardrail,
  getDeprecatedModelMigrationNotice
} from './constants.mjs';
import { loadFlightcheckConfig } from './config.mjs';
import { loadCliSurfaceSettings } from './settings.mjs';
import { canonicalizePath, isIgnorablePath } from './paths.mjs';
import { extractEffortTimeline } from './parser.mjs';
import { computeQuotaAndCacheTelemetry, humanizeModelLabel } from './quota.mjs';
import { inspectSubagentTree } from './subagents.mjs';
import { computeSwarmTopology } from './swarm_topology.mjs';
import { loadRegistry as loadSwarmScopeRegistry } from './telemetry/scope_lock_registry.mjs';
import { computePlanChurn, gradeProofQuality, detectContextRot, fingerprintErrorLoop } from './session_forensics.mjs';
import { auditHandoff } from './handoff_audit.mjs';
import {
  synthesizeParameterizedCompact,
  evaluateCompactionCacheAdvisory,
  synthesizeBatonPassHandoffCommand,
  isInternalTelemetryPath,
  isCompactionRelevant
} from './prompt_rubric.mjs';
import { auditMcpPrefixBloat } from './baseline.mjs';
import { buildActionQueue, formatActionQueueAnsi } from './action_queue.mjs';
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
  auditMcpPrefixBloat,
  buildActionQueue,
  formatActionQueueAnsi
};

/**
 * Parabolic U-Shaped Attention Curve & Low-Attention Trough Model.
 *
 * Models positional recall decay across N populated cells (gamma = 0.6):
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
  const inCanonicalCellTrough = activeCellCount >= 23 &&
    cellIndex >= ATTENTION_TROUGH_CONFIG.CANONICAL_TROUGH_START_CELL &&
    cellIndex <= ATTENTION_TROUGH_CONFIG.CANONICAL_TROUGH_END_CELL &&
    ratio <= ATTENTION_TROUGH_CONFIG.TROUGH_END_RATIO;
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
 * Locked v2.0 UI Law 3: Zero-Click Passive Workload Tag.
 * Passively classifies session state from tool-call ratios without manual dropdowns or buttons,
 * and adjusts warning thresholds automatically.
 */
export function classifyWorkloadMode(steps = []) {
  let readCalls = 0;
  let editCalls = 0;
  let subagentCalls = 0;
  let totalCalls = 0;
  let subagentSteps = 0;
  const editedFiles = new Set();

  for (const s of (Array.isArray(steps) ? steps : [])) {
    if (!s || typeof s !== 'object') continue;
    if (s.isSidechain || (s.agentId && s.agentId !== 'parent') || s.hasSubtrajectory) {
      subagentSteps++;
    }
    const calls = Array.isArray(s.toolCalls) ? s.toolCalls : (Array.isArray(s.tool_calls) ? s.tool_calls : []);
    if (calls.length === 0 && s.toolName) {
      calls.push({ name: s.toolName, args: s.targetPath ? { Path: s.targetPath } : {} });
    }
    for (const c of calls) {
      const name = String(c?.name || c?.tool || '').toLowerCase();
      if (!name) continue;
      totalCalls++;
      if (name.includes('subagent') || name === 'agent' || name === 'task') {
        subagentCalls++;
      } else if (/write|edit|replace|create|patch/i.test(name)) {
        editCalls++;
        const f = c?.args?.Path || c?.args?.path || c?.args?.TargetFile || c?.args?.AbsolutePath || s.targetPath;
        if (f) editedFiles.add(String(f).toLowerCase());
      } else if (/read|view|grep|find|search|glob|list/i.test(name)) {
        readCalls++;
      }
    }
  }

  const readRatio = totalCalls > 0 ? parseFloat((readCalls / totalCalls).toFixed(2)) : 1.0;
  const editRatio = totalCalls > 0 ? parseFloat((editCalls / totalCalls).toFixed(2)) : 0.0;
  const subagentStepRatio = steps.length > 0 ? subagentSteps / steps.length : 0;

  if (subagentCalls >= 2 || (subagentCalls >= 1 && subagentSteps >= 2) || subagentStepRatio >= 0.20) {
    return {
      modeId: 'SUBAGENT_SWARM',
      tag: '[Mode: Subagent Swarm]',
      readRatio,
      editRatio,
      subagentCount: Math.max(subagentCalls, subagentSteps > 0 ? 1 : 0),
      safeLimitMultiplier: 1.05,
      reReadTolerance: 2,
      thresholds: { safeLimitDeltaTokens: 10000, duplicateReadTolerance: 2 }
    };
  }

  if (editCalls >= 2 && (editRatio >= 0.25 || editedFiles.size >= 3)) {
    return {
      modeId: 'MULTI_FILE_REFACTOR',
      tag: '[Mode: Multi-File Refactor]',
      readRatio,
      editRatio,
      subagentCount: subagentCalls,
      safeLimitMultiplier: 0.95,
      reReadTolerance: 3,
      thresholds: { safeLimitDeltaTokens: -10000, duplicateReadTolerance: 3 }
    };
  }

  return {
    modeId: 'READ_HEAVY_AUDIT',
    tag: '[Mode: Read-Heavy Audit]',
    readRatio,
    editRatio,
    subagentCount: subagentCalls,
    safeLimitMultiplier: 1.0,
    reReadTolerance: 2,
    thresholds: { safeLimitDeltaTokens: 0, duplicateReadTolerance: 2 }
  };
}

/**
 * Locked v2.0 UI Law 2: Hero 40-Cell Flamegraph + Top 3-5 Riskiest Cells.
 * Ranks the top 3-5 riskiest cells with exact file paths, token weights, attention recall %,
 * and a 1-click `[Re-Anchor / Prune]` action when critical specs (`task.md`) drift into the trough.
 */
export function rankRiskiestCells(cells = [], { totalActiveTokens = 0, safeLimit = 140000, cellSizeTokens = 6400 } = {}) {
  if (!Array.isArray(cells) || cells.length === 0) return [];
  const scored = [];

  for (const c of cells) {
    if (!c || c.dominantCategory === CATEGORIES.FREE_HEADROOM) continue;
    const catMap = c.tokensByCategory || {};
    const cellTokens = Object.values(catMap).reduce((s, v) => s + Number(v || 0), 0) || Number(c.totalTokens) || cellSizeTokens;
    if (cellTokens <= 0) continue;

    const target = String(c.topTarget || c.primaryPath || `Cell #${(c.index ?? 0) + 1}`);
    const isCriticalSpec = /task\.md|implementation_plan\.md|agents\.md|context\.md|state\.md/i.test(target);
    const inTrough = typeof c.inAttentionTrough === 'boolean'
      ? c.inAttentionTrough
      : Boolean(totalActiveTokens >= 44800 && (cells?.length || 0) >= 23 && c.index >= 6 && c.index <= 15);
    const isStrandedSpec = (Boolean(c.isStrandedSignal) || inTrough) && (isCriticalSpec || c.dominantCategory === CATEGORIES.ANCHOR || c.dominantCategory === CATEGORIES.ACTIVE_WORKING_SET);
    const wasteTokens = (catMap[CATEGORIES.STALE_DUPLICATE] || 0) + (catMap[CATEGORIES.DEAD_ERROR] || 0) + (catMap[CATEGORIES.FOREIGN_BLEED] || 0);
    const isAmputation = Boolean(c.isAmputationZone || (totalActiveTokens > safeLimit && c.index < 8));
    const recallPct = Math.round((Number(c.attentionWeight) || 0.4) * 100);

    let riskScore = 0;
    let riskReason = 'HIGH_SLUDGE_DENSITY';
    let actionType = 'PRUNE';

    if (isStrandedSpec && isCriticalSpec) {
      riskScore = 100000 + cellTokens + (100 - recallPct) * 500;
      riskReason = 'TROUGH_STRANDED_SPEC';
      actionType = 'REANCHOR';
    } else if (isStrandedSpec) {
      riskScore = 70000 + cellTokens + (100 - recallPct) * 300;
      riskReason = 'TROUGH_STRANDED_SPEC';
      actionType = 'REANCHOR';
    } else if (isAmputation) {
      riskScore = 50000 + cellTokens;
      riskReason = 'AMPUTATION_ZONE';
      actionType = isCriticalSpec ? 'REANCHOR' : 'PRUNE';
    } else if (wasteTokens > 0 || String(c.dominantCategory).includes('STALE') || String(c.dominantCategory).includes('ERROR')) {
      riskScore = 20000 + (wasteTokens || cellTokens);
      riskReason = 'HIGH_SLUDGE_DENSITY';
      actionType = 'PRUNE';
    } else if (inTrough && recallPct < 60) {
      riskScore = 10000 + cellTokens * (1 - (Number(c.attentionWeight) || 0.5));
      riskReason = 'LOW_ATTENTION_TROUGH';
      actionType = 'REANCHOR';
    } else {
      // Cell is clean with 0 waste tokens and healthy recall; do not flag as risky
      continue;
    }

    scored.push({
      cellIndex: c.index ?? 0,
      cellNumber: (c.index ?? 0) + 1,
      filePath: target,
      tokenWeight: cellTokens,
      wasteTokens,
      attentionRecallPct: recallPct,
      inTrough,
      riskScore,
      riskReason,
      actionType,
      actionLabel: '[Re-Anchor / Prune]',
      specificActionLabel: actionType === 'REANCHOR' ? '[Re-Anchor Cell to Handoff]' : '[Prune Stale Tool Outputs]'
    });
  }

  return scored
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5)
    .map(({ riskScore, ...rest }) => rest);
}

/**
 * Evaluates Composite Operational Session Risk & Prefix-Lock Protection.
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
  taskMdExists = true,
  sessionHasWorkspaceEdits = true,
  hasPendingTaskItems = false,
  weekly7dUsedPct = 0,
  weekly7dLockoutRisk = false,
  weekly7dSource = undefined,
  aiCreditOveragesEnabled = false,
  prefixBustDetected = false
} = {}) {
  const safeHorizon = Number(safeHorizonTokens) > 0
    ? Number(safeHorizonTokens)
    : SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS;

  const isSafeHorizonBreached = totalActiveTokens >= safeHorizon || totalActiveTokens >= SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS;
  // Local quota estimates never escalate to RED; only host-sourced (or legacy unsourced) 7d values do.
  const is7dLockoutWithoutOverages = weekly7dSource !== 'estimate' &&
    (weekly7dUsedPct >= 100 || Boolean(weekly7dLockoutRisk)) && !aiCreditOveragesEnabled;
  const isCacheExpired = Number(cacheTtlRemainingSec) <= 0 &&
    totalActiveTokens >= SESSION_RISK_THRESHOLDS.LEAN_SESSION_TOKENS;
  const isCascadeArmedWithPendingTask = totalActiveTokens > SESSION_RISK_THRESHOLDS.CASCADE_SYNC_WATERMARK_TOKENS && Boolean(hasPendingTaskItems);
  const isTaskMdStale = Boolean(taskMdExists) && Boolean(sessionHasWorkspaceEdits) && Number(taskMdTurnsBehind) >= 1;

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
  // the Warm badge requires real cache-read evidence, not merely TTL > 0s.
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
 * strict cache warmth predicate. TTL > 0s alone is NOT proof of a warm cache —
 * a session with 0 cache-read tokens or a 0% hit rate is cold regardless of the TTL clock.
 */
export function computeIsCacheTrulyWarm(cache = {}) {
  if (!cache || cache.isCacheCold || cache.prefixBustDetected) return false;
  const readTok = Number(cache.cacheReadTokens ?? cache.cachedTokens ?? 0);
  const hasHitPct = cache.hitRatePct !== undefined && cache.hitRatePct !== null;
  const hitOk = hasHitPct ? Number(cache.hitRatePct) > 0 : readTok > 0;
  return Boolean(Number(cache.ttlRemainingSec) > 0 && readTok > 0 && hitOk);
}

/**
 * Tenth-of-a-Kilotoken Mathematical Parity.
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
 * Evaluates State-Conditional Bar Coloring for the older history segment.
 * - Muted Slate/Teal ('Cached History — 95% Discounted') while TTL > 0s and totalActiveTokens <= 179k.
 * - Amber ('Reclaimable Cold Bloat') ONLY when TTL == 0s OR totalActiveTokens > 179k.
 */
export function evaluateHistoryBarState({
  totalActiveTokens = 0,
  safeHorizonTokens = SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS,
  cacheTtlRemainingSec = 300,
  isCacheTrulyWarm,
  nextTurnLikelyWarm
} = {}) {
  const safeHorizon = Number(safeHorizonTokens) > 0
    ? Number(safeHorizonTokens)
    : SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS;
  // When strict warmth evidence is supplied, a 0% hit / 0 cache-read session is COLD_BLOAT even if TTL > 0s.
  const warmEvidence = typeof isCacheTrulyWarm === 'boolean' ? isCacheTrulyWarm : nextTurnLikelyWarm;
  const isNotTrulyWarm = warmEvidence === false;
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
    colorHex: '#8b5cf6'
  };
}

/**
 * Computes Dual-Watermark + Hard Ceiling visual markers for the context bar.
 */
export function computeWatermarks(maxTokens = null, safeLimit = 179000, modelId = 'default') {
  const dynamicDefault = resolveModelCeiling(modelId, null, { useLegacyDefault: false });
  const denom = Math.max(1, Number(maxTokens) || dynamicDefault);
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

const ANCHOR_FILE_TARGET_RE = /(^|[\\/])(rules[\\/]|task\.md$|implementation_plan\.md$|agents\.md$|gemini\.md$)/i;

function isPairedToolResultStep(step = {}, prev = null) {
  if (!step || !prev) return false;
  const prevCalls = Array.isArray(prev.toolCalls)
    ? prev.toolCalls
    : (Array.isArray(prev.tool_calls) ? prev.tool_calls : []);
  if (prevCalls.length === 0) return false;
  const curCalls = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
  if (curCalls.length > 0) return false;
  const curType = String(step.type || '').toUpperCase();
  const curSource = String(step.source || '').toUpperCase();
  if (
    curType === 'USER_INPUT' ||
    curSource === 'USER_EXPLICIT' ||
    curType === 'SYSTEM_PROMPT' ||
    isCompactionCheckpointStep(step)
  ) {
    return false;
  }
  const prevType = String(prev.type || '').toUpperCase();
  if (
    prevType === 'PLANNER_RESPONSE' &&
    (curType === 'GENERIC' || curType === 'TOOL_RESULT' || curSource === 'TOOL' || curSource === 'MODEL')
  ) {
    return true;
  }
  if (curType === 'TOOL_RESULT' || curSource === 'TOOL') return true;
  return false;
}

function getEffectiveStepCalls(steps = [], idx = 0) {
  const step = steps[idx] || {};
  const ownCalls = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
  if (ownCalls.length > 0) return { calls: ownCalls, isPairedResult: false };
  if (idx > 0 && isPairedToolResultStep(step, steps[idx - 1])) {
    const prevCalls = Array.isArray(steps[idx - 1].toolCalls)
      ? steps[idx - 1].toolCalls
      : (Array.isArray(steps[idx - 1].tool_calls) ? steps[idx - 1].tool_calls : []);
    return { calls: prevCalls, isPairedResult: true };
  }
  return { calls: [], isPairedResult: false };
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

  const parsedEffort = extractEffortTimeline(steps, { maxTokens: resolvedMaxTokens });
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
  const userTurns = steps.filter(x => x && (x.source === 'USER_EXPLICIT' || x.type === 'USER_INPUT' || x.role === 'user'));
  const userTurnCount = userTurns.length > 0 ? userTurns.length : (options.sidecar?.sessionMeta?.turnCount || totalTurns);
  const totalSteps = steps.length;
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
    const { calls, isPairedResult } = getEffectiveStepCalls(steps, idx);
    const isReadOnlyFileCall = calls.length > 0 && calls.every(c => /^(view_file|read_file|view_file_outline|view_code_item)$/i.test(String(c.name || c.tool || '')));
    const callFileTargets = calls
      .map(c => {
        const a = c?.args || c?.parameters || c?.Arguments || {};
        return a.Path || a.path || a.TargetFile || a.Target || a.target || a.AbsolutePath || '';
      })
      .filter(Boolean);
    const hasExplicitNonAnchorTarget = callFileTargets.length > 0 &&
      callFileTargets.every(t => !ANCHOR_FILE_TARGET_RE.test(String(t)));
    const isError = step.status === 'ERROR' ||
      (typeof step.exitCode === 'number' && step.exitCode !== 0) ||
      (!isReadOnlyFileCall && contentStr.includes('Traceback (most recent call last)'));

    const isBackgroundTaskEvent = Boolean(
      (step.type === 'SYSTEM_MESSAGE' || String(step.type).toLowerCase() === 'system_message') &&
      /Task id ["'][^"']+["'] finished/i.test(contentStr)
    );

    // 1. Anchor detection
    if (
      !isBackgroundTaskEvent && (
        step.stepIndex === 0 ||
        isCompactionCheckpointStep(step) ||
        step.type === 'SYSTEM_PROMPT' ||
        (!hasExplicitNonAnchorTarget && (
          contentStr.includes('rules/') ||
          contentStr.includes('task.md') ||
          contentStr.includes('implementation_plan.md')
        ))
      )
    ) {
      category = CATEGORIES.ANCHOR;
      target = 'System & Project Anchors';
    }
    // 2. Knowledge Memory & Bleed detection
    else if (
      contentStr.includes('knowledge://') ||
      calls.some(c => (c.name || c.tool || '').includes('knowledge') || (c.args?.Uri || '').includes('knowledge'))
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
      const cmdCall = calls.find(c => (c.name || c.tool || '').toLowerCase() === 'run_command');
      target = cmdCall?.args?.CommandLine ? `Command: ${cmdCall.args.CommandLine}` : 'Resolved Stack Trace';
      const off = offenderMap.get(target) || { category, target, occurrences: 0, wastedTokens: 0, stepIndices: [] };
      off.occurrences += 1;
      off.wastedTokens += tokens;
      off.stepIndices.push(idx);
      offenderMap.set(target, off);
    }
    // 4. Smart File Re-Read Classifier & Semantic Reference Pinning
    else {
      let isStale = false;
      let isPairedWasteResult = false;
      let stepFileBasename = '';
      for (const call of calls) {
        const args = call.args || call.parameters || call.Arguments || {};
        const targetFile = args.Path || args.path || args.Target || args.target || args.TargetFile || args.AbsolutePath;
        if (targetFile && !isInternalTelemetryPath(targetFile)) {
          stepFileBasename = path.basename(String(targetFile)).toLowerCase();
          break;
        }
      }
      if (smartReReads.wasteTargetByStep.has(idx)) {
        isStale = true;
        target = smartReReads.wasteTargetByStep.get(idx);
      } else if (isPairedResult && smartReReads.wasteTargetByStep.has(idx - 1)) {
        isStale = true;
        isPairedWasteResult = true;
        target = smartReReads.wasteTargetByStep.get(idx - 1);
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
        if (!isPairedWasteResult) {
          off.occurrences += 1;
        } else if (off.occurrences === 0) {
          off.occurrences = 1;
        }
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
    if (residual !== 0) {
      if (classifiedSteps.length > 0) {
        let maxStep = classifiedSteps[0];
        for (const s of classifiedSteps) {
          if (s.tokens > maxStep.tokens) maxStep = s;
        }
        maxStep.tokens = Math.max(0, maxStep.tokens + residual);
        categoryTotals[maxStep.category] = Math.max(0, (categoryTotals[maxStep.category] || 0) + residual);
      } else {
        categoryTotals[CATEGORIES.ANCHOR] = Math.max(0, (categoryTotals[CATEGORIES.ANCHOR] || 0) + residual);
      }
    }
    for (const off of offenderMap.values()) {
      off.wastedTokens = off.stepIndices.reduce((sum, sIdx) => sum + (classifiedSteps[sIdx]?.tokens || 0), 0);
    }
  }

  // If session crosses legacy default ceiling, dynamically promote ceiling to native model ceiling (256k / 1M / 1.048M) so 40 cells never overflow
  const nativeModelCeiling = resolveModelCeiling(modelId, null, {
    useLegacyDefault: false,
    config: activeConfig,
    cliSettings
  });
  const effectiveMaxTokens = (totalActiveTokens > resolvedMaxTokens && resolvedMaxTokens === 200000)
    ? (totalActiveTokens > 256000 ? Math.max(1000000, nativeModelCeiling) : 256000)
    : (totalActiveTokens > resolvedMaxTokens ? Math.max(resolvedMaxTokens, nativeModelCeiling) : resolvedMaxTokens);
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
        const { calls: rawCalls } = getEffectiveStepCalls(steps, step.stepIndex);
        const toolCallLabels = rawCalls.map(c => {
          const nm = c.name || c.tool || 'tool';
          const a = c.args || c.parameters || c.Arguments || {};
          const arg = a.Path || a.path || a.CommandLine || a.ServerName || '';
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

    const cellUsedTokens = Object.values(bucketCategories).reduce((s, v) => s + v, 0);
    if (cellUsedTokens < effectiveCellSize) {
      bucketCategories[CATEGORIES.FREE_HEADROOM] = (bucketCategories[CATEGORIES.FREE_HEADROOM] || 0) + (effectiveCellSize - cellUsedTokens);
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

  // Map effort transitions to their corresponding block indices (0..39)
  const tokensPerCell = Math.max(1, Math.round(effectiveMaxTokens / HORIZON_WINDOW.TOTAL_CELLS));
  const filledCellCount = Math.max(1, Math.min(HORIZON_WINDOW.TOTAL_CELLS, Math.ceil(totalActiveTokens / tokensPerCell)));
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
    if (matchedBlock >= filledCellCount) {
      matchedBlock = Math.min(39, Math.max(0, filledCellCount - 1));
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
  const signalTokens = categoryTotals[CATEGORIES.ANCHOR] + categoryTotals[CATEGORIES.ACTIVE_WORKING_SET] + (categoryTotals[CATEGORIES.MEMORY_KI] || 0);
  const signalPurityPct = Math.round((signalTokens / Math.max(1, totalActiveTokens)) * 100);

  const pricePerM = resolvePricePerM(modelId, activeConfig);
  const sludgeTokens = categoryTotals[CATEGORIES.STALE_DUPLICATE] + categoryTotals[CATEGORIES.DEAD_ERROR] + categoryTotals[CATEGORIES.FOREIGN_BLEED];
  const sludgeTaxPerTurnUsd = parseFloat(((sludgeTokens / 1000000) * pricePerM).toFixed(4));
  const totalTurnCostUsd = parseFloat(((totalActiveTokens / 1000000) * pricePerM).toFixed(4));

  // Health band (gated on compaction relevance so lean <50k sessions do not false-alarm)
  const compactionRelevant = isCompactionRelevant({
    totalActiveTokens,
    sludgeTokens,
    safeHorizonTokens: safeLimit
  });
  let healthBand = 'OPTIMAL_FOCUS';
  if (amputationCrisis) healthBand = 'AMPUTATION_CRISIS';
  else if (compactionRelevant && signalPurityPct < 40) healthBand = 'CRITICAL_SLUDGE';
  else if (compactionRelevant && signalPurityPct < 75) healthBand = 'VISIBLE_CLUTTER';

  // Format Top Offenders Ledger
  const offenders = Array.from(offenderMap.values())
    .sort((a, b) => b.wastedTokens - a.wastedTokens)
    .slice(0, 5)
    .map((off, rank) => {
      const avgStep = off.stepIndices.reduce((acc, v) => acc + v, 0) / (off.stepIndices.length || 1);
      const estCell = Math.min(39, Math.floor((avgStep / Math.max(1, totalTurns)) * activeCellsCount));
      const recallPct = Math.round(calculateAttentionWeight(estCell, activeCellsCount) * 100);
      const costUsd = parseFloat(((off.wastedTokens / 1000000) * pricePerM).toFixed(4));

      const wastedK = Math.max(0.1, parseFloat((off.wastedTokens / 1000).toFixed(1)));
      const supersededSteps = off.stepIndices.length > 1 ? off.stepIndices.slice(0, -1) : off.stepIndices;
      const stepListStr = supersededSteps.slice(0, 5).join(', ') + (supersededSteps.length > 5 ? '...' : '');
      let remediation = `Deduplicate file reads via /compact`;
      if (off.category === CATEGORIES.DEAD_ERROR) {
        remediation = `Collapse ${off.occurrences} resolved error trace(s) at step(s) [${off.stepIndices.slice(0, 5).join(', ')}] (~${wastedK}k tok) via Surgical Pruner or /compact`;
      } else if (off.target === 'Older chat history (>25 turns ago)') {
        remediation = `Compress ${off.occurrences} stale turns at steps [${stepListStr}] (~${wastedK}k tok) via /compact`;
      } else if (isIgnorablePath(off.target)) {
        remediation = `echo "${off.target}" >> .antigravityignore && prune ${ Math.max(1, off.occurrences - 1)} read(s) at step(s) [${stepListStr}] (~${wastedK}k tok)`;
      } else {
        remediation = `Fold ${Math.max(1, off.occurrences - 1)} superseded read(s) of ${off.target} at step(s) [${stepListStr}] (~${wastedK}k tok) via Surgical Pruner or use read_file { Path: "${off.target}", StartLine: 1, EndLine: 200 }`;
      }

      return {
        rank: rank + 1,
        target: off.target,
        category: off.category,
        occurrences: off.occurrences,
        stepIndices: off.stepIndices,
        wastedTokens: off.wastedTokens,
        sludgeCostPerTurnUsd: costUsd,
        attentionRecallPct: recallPct,
        remediation
      };
    });

  // Plain-Language Token-Based Diagnostics (Zero $ references)
  const reclaimK = Math.round(sludgeTokens / 1000);
  let whatsHappening = '';
  let theSludgeTax = '';
  let actionPlan = '';
  let recommendedCommand = 'Ready';

  if (amputationCrisis) {
    whatsHappening = `Prefix truncation alert! Total memory (> ${Math.round(reminderAt / 1000)}k tokens) or early task checkpoints are inside the ${Math.round(safeLimit / 1000)}k+ truncation zone.`;
    theSludgeTax = `${reclaimK}k reclaimable noise tokens (${100 - signalPurityPct}% of active context) are pushing your earliest rules toward truncation.`;
    actionPlan = `Save progress to task.md and start a fresh chat or run /clear now.`;
    recommendedCommand = '/clear';
  } else if (inAmputationZone || (compactionRelevant && signalPurityPct < 40)) {
    whatsHappening = `High context dilution: ${(100 - signalPurityPct)}% of active memory (${reclaimK}k tokens) consists of outdated turns and repeated file reads.`;
    theSludgeTax = `${reclaimK}k tokens can be reclaimed immediately via /compact. Middle-window recall has dropped to ~24%.`;
    actionPlan = `Run /compact to compress older history and drop duplicate file snapshots while keeping active rules intact.`;
    recommendedCommand = '/compact';
  } else if (compactionRelevant && (signalPurityPct < 75 || sludgeTokens >= 25000)) {
    whatsHappening = `Moderate context clutter (${reclaimK}k reclaimable tokens). Working set is healthy, but duplicate file reads are accumulating.`;
    theSludgeTax = `${reclaimK}k tokens of outdated history can be freed.`;
    actionPlan = `Run /compact when you finish the current step to reclaim ${reclaimK}k tokens.`;
    recommendedCommand = '/compact';
  } else {
    whatsHappening = `High-efficiency session. Memory is clean and focused on active workspace files with plenty of safe headroom.`;
    theSludgeTax = `Minimal noise (${reclaimK}k tokens). Signal purity is optimal at ${signalPurityPct}%.`;
    actionPlan = `Memory is clean. Continue working normally.`;
    recommendedCommand = 'Ready';
  }

  // Compute actionable Brain Signals from transcript forensics
  const allOffenders = Array.from(offenderMap.values());
  const dupFileOffenders = allOffenders
    .filter(o => o.category === CATEGORIES.STALE_DUPLICATE && o.target !== 'Older chat history (>25 turns ago)')
    .sort((a, b) => b.wastedTokens - a.wastedTokens);
  const oldHistOffender = allOffenders.find(o => o.target === 'Older chat history (>25 turns ago)');
  const errorOffenders = allOffenders.filter(o => o.category === CATEGORIES.DEAD_ERROR);

  const blowupSteps = classifiedSteps
    .filter(s => s.tokens >= 8000 && s.stepIndex > 0 && s.category !== CATEGORIES.ANCHOR && s.target !== 'System & Project Anchors')
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map(s => {
      const rawStep = steps[s.stepIndex] || {};
      const { calls: effCalls } = getEffectiveStepCalls(steps, s.stepIndex);
      const call = effCalls[0];
      const args = call?.args || call?.parameters || call?.Arguments || {};
      const toolName = String(call?.name || call?.tool || rawStep.toolName || '').toLowerCase();
      const filePath = args.Path || args.path || args.TargetFile || args.Target || args.target || args.AbsolutePath || args.file_path || rawStep.targetPath || null;
      const command = args.CommandLine || args.command || null;
      const isFileTool = Boolean(filePath) || /^(view_file|read_file|view_file_outline|view_code_item|replace_file_content|multi_replace_file_content|write_to_file|write_file|edit_file)$/.test(toolName);
      const isCmdTool = Boolean(command) || /^(run_command|bash|execute_command)$/.test(toolName);
      const userTurnNumber = Math.max(
        1,
        steps.slice(0, s.stepIndex + 1).filter(x => x && (x.source === 'USER_EXPLICIT' || x.type === 'USER_INPUT' || x.role === 'user')).length
      );
      return {
        stepIndex: s.stepIndex,
        userTurnNumber,
        tokens: s.tokens,
        category: s.category,
        target: s.target || `Step ${s.stepIndex}`,
        payload: {
          kind: isCmdTool ? 'command' : (isFileTool ? 'file' : 'other'),
          tool: call?.name || null,
          detail: String(command || filePath || call?.name || 'Model/tool output').slice(0, 300),
          path: filePath
        }
      };
    });

  const recentSteps = steps.slice(-10);
  const recentErrors = recentSteps.filter(s => s.status === 'ERROR' || (typeof s.exitCode === 'number' && s.exitCode !== 0)).length;

  let correctionCount = 0;
  const userCorrectionTexts = [];
  for (const s of steps) {
    if (s.source === 'USER_EXPLICIT' || s.type === 'USER_INPUT') {
      const rawTxt = String(s.content || '').trim();
      const strippedHostTxt = rawTxt
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .replace(/<\/?USER_REQUEST>/gi, '')
        .trim();
      const cleanTxt = strippedHostTxt;
      const lower = cleanTxt.toLowerCase();
      if (cleanTxt && /\b(no[, ]|don't|do not|instead|wrong|looks the same|shouldn't|broken|still not)\b/.test(lower)) {
        correctionCount++;
        userCorrectionTexts.push(cleanTxt.slice(0, 100));
      }
    }
  }

  // task.md freshness: user turns since the last tool call that wrote task.md
  const isUserTurn = x => x.source === 'USER_EXPLICIT' || x.type === 'USER_INPUT';
  const isTaskWrite = x => (x.toolCalls || []).some(c =>
    /write|edit|replace|create/i.test(c.name || '') &&
    /task\.md/i.test(String(c.args?.Path || c.args?.path || c.args?.TargetFile || c.args?.AbsolutePath || '')));
  let lastTaskWrite = -1;
  let lastTaskWritePath = null;
  steps.forEach((x, i) => {
    if (!isTaskWrite(x)) return;
    lastTaskWrite = i;
    for (const c of (x.toolCalls || [])) {
      const p = String(c.args?.Path || c.args?.path || c.args?.TargetFile || c.args?.AbsolutePath || '');
      if (/task\.md/i.test(p)) lastTaskWritePath = p;
    }
  });
  const isWorkspaceFileWrite = x => (x.toolCalls || []).some(c => {
    if (!/write|edit|replace|create/i.test(c.name || '')) return false;
    const p = String(c.args?.Path || c.args?.path || c.args?.TargetFile || c.args?.AbsolutePath || '');
    return Boolean(p) && !isInternalTelemetryPath(p);
  });
  const sessionHasWorkspaceEdits = steps.some(isWorkspaceFileWrite);
  const rawTaskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;
  const taskTurnsBehind = (lastTaskWrite >= 0 || sessionHasWorkspaceEdits)
    ? rawTaskTurnsBehind
    : 0;
  // the set of workspace files this session wrote/edited (for session-scoped git drift).
  const sessionWrittenPaths = new Set();
  for (const x of steps) {
    for (const c of (x.toolCalls || [])) {
      if (!/write|edit|replace|create/i.test(c?.name || '')) continue;
      const p = String(c?.args?.Path || c?.args?.path || c?.args?.TargetFile || c?.args?.AbsolutePath || '');
      if (p && !isInternalTelemetryPath(p)) sessionWrittenPaths.add(p);
    }
  }

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
    } catch (err) {
      if (process.env.HORIZON_DEBUG) console.error('[classifier] brainDir resolve failed:', err?.message || err);
    }
  }
  const handoff = auditHandoff(brainDir || canonicalWorkspace, {
    planChurn,
    errorLoop,
    deadErrors: { isErrorLoop: recentErrors >= 3 || errorLoop.loop },
    totalActiveTokens,
    sludgeTokens,
    sessionHasWorkspaceEdits,
    activeSignal: {
      taskMdTurnsBehind: taskTurnsBehind,
      taskMdPathHint: lastTaskWritePath,
      sessionHasWorkspaceEdits
    }
  }, {
    workspacePath: canonicalWorkspace,
    gitPorcelainOutput: options.gitPorcelainOutput,
    sessionWrittenPaths: Array.from(sessionWrittenPaths)
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
      sessionHasWorkspaceEdits,
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
    foreignBleed: {
      reclaimableTokens: categoryTotals[CATEGORIES.FOREIGN_BLEED] || 0
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

  // Compute Dual-Pool Quota & Cache-Read Telemetry
  const quota = computeQuotaAndCacheTelemetry(steps, {
    sessionId,
    modelId,
    totalActiveTokens,
    activeEffortProfile,
    stdinQuota,
    genMetadata: options.genMetadata || null,
    aiCreditOveragesEnabled,
    cacheDir,
    reclaimableTokens: sludgeTokens || 0,
    sludgeTokens: sludgeTokens || 0,
    isAutoMode: Boolean(activeEffortProfile?.tier === 'STANDARD' || activeEffortProfile?.shortLabel === 'Auto')
  });

  // Detect pending checklist items in task.md (or recent task writes) for Cascade >50k checkpointer arming
  let hasPendingTaskItems = false;
  if (options.hasPendingTaskItems !== undefined) {
    hasPendingTaskItems = Boolean(options.hasPendingTaskItems);
  } else if (handoff?.targetFile && fs.existsSync(handoff.targetFile)) {
    try {
      const taskText = fs.readFileSync(handoff.targetFile, 'utf8');
      hasPendingTaskItems = /^[-*]\s*\[ \]/m.test(taskText);
    } catch (err) {
      if (err?.code !== 'ENOENT' && process.env.HORIZON_DEBUG) console.error('[classifier] task.md read failed:', err?.message || err);
    }
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
    taskMdExists: Boolean(lastTaskWrite >= 0 || handoff?.artifacts?.taskMd?.exists),
    sessionHasWorkspaceEdits,
    hasPendingTaskItems,
    weekly7dUsedPct: quota.weekly7d?.usedPct ?? 0,
    weekly7dLockoutRisk: Boolean(quota.weekly7d?.lockoutRisk),
    weekly7dSource: quota.weekly7d?.source,
    aiCreditOveragesEnabled,
    prefixBustDetected: Boolean(quota.cache?.prefixBustDetected)
  });
  const surfaceTag = resolveSurfaceTag(storeSource || logFilePath);
  const watermarks = computeWatermarks(effectiveMaxTokens, safeLimit);
  const historyBarState = evaluateHistoryBarState({
    totalActiveTokens,
    safeHorizonTokens: SESSION_RISK_THRESHOLDS.SAFE_HORIZON_TOKENS,
    cacheTtlRemainingSec: quota.cache?.ttlRemainingSec ?? 300,
    isCacheTrulyWarm: sessionRisk.isCacheTrulyWarm,
    nextTurnLikelyWarm: typeof quota.cache?.nextTurnLikelyWarm === 'boolean' ? quota.cache.nextTurnLikelyWarm : undefined
  });

  // Parameterized /compact synthesizer, Cache-Aware Advisory & Baton Pass (/handoff)
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
    isCacheTrulyWarm: sessionRisk.isCacheTrulyWarm,
    nextTurnLikelyWarm: typeof quota.cache?.nextTurnLikelyWarm === 'boolean' ? quota.cache.nextTurnLikelyWarm : undefined,
    sludgeTokens
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

  // Compute Multi-Agent (invoke_subagent) Context Tree & Handoff Compression
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

  // Sprint 2.1: Subagent /swarm roster + git worktree topology + scope-lock overlaps
  let swarmTopology = null;
  try {
    let swarmLeases = [];
    if (canonicalWorkspace && options.probeSwarmLeases !== false) {
      try {
        const reg = loadSwarmScopeRegistry(canonicalWorkspace);
        swarmLeases = Array.isArray(reg?.leases) ? reg.leases : [];
      } catch (err) {
        if (process.env.HORIZON_DEBUG) console.error('[classifier] swarm lease load failed:', err?.message || err);
      }
    }
    swarmTopology = computeSwarmTopology(steps, {
      nowMs: typeof options.nowMs === 'number' ? options.nowMs : Date.now(),
      workspaceDir: canonicalWorkspace || null,
      worktrees: Array.isArray(options.worktrees) ? options.worktrees : null,
      leases: swarmLeases,
      probeGit: options.probeGit !== false
    });
  } catch (err) {
    if (process.env.HORIZON_DEBUG) console.error('[classifier] swarm topology failed:', err?.message || err);
    swarmTopology = null;
  }

  // Session Fracture Markers (⚡) & Stranded Signal Summary
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
      let deltaSec = null;
      if (st?.createdAt && prev?.createdAt) {
        const dMs = Date.parse(st.createdAt) - Date.parse(prev.createdAt);
        if (Number.isFinite(dMs) && dMs >= 0) deltaSec = dMs / 1000;
      }
      if (currCache === 0 && prevCache > 0 && currInput > 0 && deltaSec !== null && deltaSec < 300) {
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

  const workloadMode = classifyWorkloadMode(steps);
  const topRiskyCells = rankRiskiestCells(cells, {
    totalActiveTokens,
    safeLimit,
    cellSizeTokens: effectiveCellSize
  });
  const actionQueue = buildActionQueue({
    metrics: { totalInputTokens: totalActiveTokens, totalTurns: userTurnCount, totalSteps },
    brainSignals,
    quota,
    topRiskyCells,
    window: { totalActiveTokens, stepCount: totalSteps },
    turns: userTurnCount,
    stepCount: totalSteps,
    baseline: { mcpAudit },
    hostHealth: options.hostHealth || null
  });

  let lastUserPrompt = '';
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if (st && (st.source === 'USER_EXPLICIT' || st.type === 'USER_INPUT')) {
      const cleaned = String(st.content || '')
        .replace(/<\/?USER_REQUEST>/gi, '')
        .trim();
      if (cleaned) {
        lastUserPrompt = cleaned.slice(0, 8000);
        break;
      }
    }
  }

  const exportedSteps = steps.map((st, idx) => {
    const rawCalls = Array.isArray(st?.toolCalls)
      ? st.toolCalls
      : (Array.isArray(st?.tool_calls) ? st.tool_calls : []);
    return {
      stepIndex: Number.isFinite(st?.stepIndex) ? st.stepIndex : idx,
      type: st?.type || 'GENERIC',
      source: st?.source || 'MODEL',
      status: st?.status || 'DONE',
      exitCode: typeof st?.exitCode === 'number' ? st.exitCode : undefined,
      tokens: classifiedSteps[idx]?.tokens || 0,
      outputTokens: st?.outputTokens || 0,
      category: classifiedSteps[idx]?.category || CATEGORIES.ACTIVE_WORKING_SET,
      target: classifiedSteps[idx]?.target || '',
      toolCalls: rawCalls.map(c => ({
        name: c?.name || c?.tool || '',
        args: c?.args || c?.parameters || c?.Arguments || {}
      }))
    };
  });

  return {
    schemaVersion: '1.1.0',
    sessionId,
    storeSource,
    surfaceTag,
    workloadMode,
    lastUserPrompt,
    steps: exportedSteps,
    topRiskyCells,
    actionQueue,
    brainDir: brainDir || null,
    logTierUsed,
    logFilePath,
    workspace: {
      canonicalPath: canonicalWorkspace,
      projectId
    },
    model: {
      id: modelId,
      displayName: humanizeModelLabel(modelId),
      source: options.modelSource || null,
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
      turnCount: userTurnCount,
      stepCount: totalSteps,
      safeLimit,
      safeHeadroomTokens: Math.max(0, safeLimit - totalActiveTokens),
      reminderAt,
      watermarks,
      historyBarState,
      unifiedPool: computeUnifiedContextPool(
        {
          input_tokens: totalActiveTokens,
          thinking_tokens: options.thinkingTokens ?? 0,
          output_tokens: options.outputTokens ?? 0
        },
        modelId
      )
    },
    breakdown: categoryTotals,
    metrics: {
      signalPurityPct,
      sludgeTokens,
      sludgeTaxPerTurnUsd,
      totalTurnCostUsd,
      healthBand,
      totalTurns: userTurnCount,
      totalSteps,
      displayParity: computeDisplayTenthsParity(
        totalActiveTokens,
        Math.max(0, totalActiveTokens - sludgeTokens),
        Math.round((brainSignals.duplicateReads.reclaimableTokens || 0) / 100) +
          Math.round((brainSignals.oldHistory.reclaimableTokens || 0) / 100) +
          Math.round((brainSignals.deadErrors.reclaimableTokens || 0) / 100) +
          Math.round(((categoryTotals[CATEGORIES.FOREIGN_BLEED] || 0)) / 100)
      )
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
    swarmTopology,
    activeEffortProfile,
    effortTransitions,
    effortHistory: effortTransitions,
    diagnostics: {
      whatsHappening,
      theSludgeTax,
      actionPlan,
      recommendedCommand,
      migrationNotice: getDeprecatedModelMigrationNotice(modelId, options.eventTimestampUtc ?? null),
      carbonVerbosity: evaluateCarbonVerbosityGuardrail(steps, {
        modelId,
        activeEffort: activeEffortProfile?.effort || options.effort || 'high',
        eventTimestampUtc: options.eventTimestampUtc ?? null
      })
    },
    updatedAt: new Date().toISOString()
  };
}
