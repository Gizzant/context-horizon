/**
 * @file src/core-isomorphic/coach/smartCompactAdvisor.mjs
 * Task-boundary `/compact` suggestion advisor (`Item 5`, enabled by default with H4 ROI gate).
 *
 * Evidence & Provenance (`summary_smart_compact.md` & `organic_h7_boundary_audit.json`):
 *   - H4 (`C1` vs `C0`, computed): Compacting saved `-$0.5814` to `-$0.6036` over `21` requests
 *     at `~139k` context (`C1_v2_r01`, `C1_v2_r02`), while costing `+$0.1307` to `+$0.1431` over
 *     `12` requests at `~42k–50k` context (`C1_r01`–`C1_r03`, `C1mem_r02`).
 *   - Compaction latency (live): synchronous `103.9s–126.0s` (`~2-minute`) pause (`C1`, `6` runs).
 *   - H7 (`evaluateTaskBoundaryTurn`, `organic_h7_boundary_audit.json`, $0 offline replay across
 *     `59` organic multi-task sessions / `762` turns): `79.55%` (`70/88`) raw causal precision,
 *     `95.89%` (`70/73`) non-terminal precision, `100.00%` (`70/70`) recall, and `100.00%` (`3/3`)
 *     precision when gated by positive H4 compaction ROI -> detector status is **verified**.
 */

import {
  isKnownCatalogModel,
  normalizeModelId,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';
import {
  estimateEmpiricalRemainingTurns,
  resolveRequestsPerTurn
} from './cacheGravityRouter.mjs';

export const TEST_CMD_REGEX =
  /\b(?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|tsc(?:\s|$)|npx\s+tsc)\b/i;

const EDIT_TOOL_REGEX =
  /^(?:Write|Edit|MultiEdit|NotebookEdit|Replace|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i;

export const DEFAULT_POST_COMPACT_COOLDOWN_TURNS = 4;
export const DEFAULT_IDLE_PRE_COMPACT_MIN_TOKENS = 60_000;
export const DEFAULT_IDLE_PRE_COMPACT_TARGET_TOKENS = 24_000;
export const DEFAULT_COLD_RESUME_BATON_TOKENS = 300;
export const IDLE_TTL_MS_5M = 300_000;
export const IDLE_TTL_MS_1H = 3_600_000;

const NON_CODE_DOC_OR_ARTIFACT_RE =
  /(?:(?:^|[\\/])(?:task\.md|walkthrough\.md|implementation_plan\.md|CHANGELOG\.md|README\.md)$|\.gemini[\\/]antigravity[\\/]brain[\\/])/i;

/**
 * Returns true if the target path is a markdown planning/doc artifact rather than workspace source/config code.
 *
 * @param {string} [filePath='']
 * @returns {boolean}
 */
export function isNonCodeDocOrArtifactPath(filePath = '') {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  return NON_CODE_DOC_OR_ARTIFACT_RE.test(normalized);
}

/**
 * Updates `openFailure` and `editsSinceBoundary` state across tool executions,
 * reproducing and refining `evaluateSessionBoundaryDetector` (verified across
 * 59 organic coding sessions / 762 turns in `organic_h7_boundary_audit.json`).
 *
 * @param {object} [toolEvent={}]
 * @param {object} [priorState={}]
 * @returns {object}
 */
export function evaluateTaskBoundaryTurn(toolEvent = {}, priorState = {}) {
  let openFailure = Boolean(priorState.openFailure);
  let editsSinceBoundary = Math.max(0, Number(priorState.editsSinceBoundary || 0));
  const lastBoundarySuggestedTurn = priorState.lastBoundarySuggestedTurn ?? null;

  const toolName = String(toolEvent.toolName || toolEvent.tool_name || '');
  const command = String(toolEvent.command || toolEvent.cmd || '');
  const filePath = String(toolEvent.filePath || toolEvent.path || toolEvent.targetFile || '');
  const rawFileEdited = Boolean(toolEvent.fileEdited) || EDIT_TOOL_REGEX.test(toolName);
  const fileEdited = rawFileEdited && !isNonCodeDocOrArtifactPath(filePath);
  const isTestCmd = Boolean(command && TEST_CMD_REGEX.test(command));

  if (fileEdited) {
    editsSinceBoundary += 1;
  }

  let boundaryDetected = false;
  let detectorState = openFailure ? 'mid_debug' : 'other';

  if (isTestCmd) {
    const failed =
      toolEvent.failed !== undefined
        ? Boolean(toolEvent.failed)
        : toolEvent.succeeded !== undefined
          ? !Boolean(toolEvent.succeeded)
          : typeof toolEvent.exitCode === 'number'
            ? toolEvent.exitCode !== 0
            : false;
    const succeeded =
      toolEvent.succeeded !== undefined
        ? Boolean(toolEvent.succeeded)
        : typeof toolEvent.exitCode === 'number'
          ? toolEvent.exitCode === 0
          : !failed;

    if (failed) {
      openFailure = true;
      detectorState = 'mid_debug';
    } else if (succeeded && (openFailure || editsSinceBoundary > 0)) {
      boundaryDetected = true;
      detectorState = 'task_boundary';
      openFailure = false;
      editsSinceBoundary = 0;
    } else {
      detectorState = 'other';
    }
  }

  return {
    boundaryDetected,
    detectorState,
    openFailure,
    editsSinceBoundary,
    lastBoundarySuggestedTurn,
    detectorStatus: 'verified'
  };
}

/**
 * Estimates counterfactual H4 compaction net USD saving over expected remaining requests,
 * using runtime catalog prices and the DET-08 horizon logic.
 *
 * @param {object} [params={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function computeCompactionHorizonNetSaving(params = {}, options = {}) {
  const rawModel = params.modelId || params.currentModel || 'claude-sonnet-5-5';
  const preCompactTokens = Math.max(
    0,
    Number(params.preCompactTokens ?? params.cachedTokens ?? params.contextTokens ?? 0)
  );

  if (!isKnownCatalogModel(rawModel, options)) {
    return {
      unknownModel: true,
      modelId: String(rawModel || ''),
      preCompactTokens,
      remainingRequestsUsed: null,
      horizonSource: null,
      isPlaceholderPrior: false,
      netSavingUSD: null,
      positive: false
    };
  }

  const modelId = normalizeModelId(rawModel, options);
  const rates = resolveEffectiveRates(modelId, preCompactTokens, options);
  const writeRatePer1M = params.cacheTtlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;

  let remainingRequestsUsed;
  let horizonSource;
  let isPlaceholderPrior = false;
  if (
    params.expectedRemainingRequests !== undefined &&
    params.expectedRemainingRequests !== null &&
    Number.isFinite(Number(params.expectedRemainingRequests))
  ) {
    remainingRequestsUsed = Math.max(0, Number(params.expectedRemainingRequests));
    horizonSource = 'explicit_requests';
  } else if (
    params.expectedRemainingTurns !== undefined &&
    params.expectedRemainingTurns !== null &&
    Number.isFinite(Number(params.expectedRemainingTurns))
  ) {
    const rpt = resolveRequestsPerTurn(params, options).requestsPerTurn;
    remainingRequestsUsed = Math.max(0, Number(params.expectedRemainingTurns)) * rpt;
    horizonSource = 'explicit_turns';
  } else {
    const prior = estimateEmpiricalRemainingTurns(
      {
        turnsCompleted: params.turnsCompleted ?? 0,
        apiCallsCompleted: params.apiCallsCompleted,
        requestsPerTurn: params.requestsPerTurn,
        contextGrowthPerTurn: params.contextGrowthPerTurn,
        cachedTokens: preCompactTokens,
        contextCeiling: params.contextCeiling,
        autoCompactLimitTokens: params.autoCompactLimitTokens,
        initialPrefixTokens: params.initialPrefixTokens
      },
      options
    );
    remainingRequestsUsed = Math.max(0, Number(prior.expectedRemainingRequests || 0));
    horizonSource = prior.source;
    isPlaceholderPrior = Boolean(prior.isPlaceholderPrior);
  }

  // H4 structural split: warm tools/system[0..1] survives read-side; compacted summary + tail rewrites once.
  const postCompactWarmTokens =
    params.postCompactWarmTokens !== undefined
      ? Math.max(0, Math.min(preCompactTokens, Number(params.postCompactWarmTokens)))
      : Math.min(preCompactTokens, 8_000);
  const postCompactColdWriteTokens =
    params.postCompactColdWriteTokens !== undefined
      ? Math.max(0, Math.min(preCompactTokens, Number(params.postCompactColdWriteTokens)))
      : Math.min(Math.max(0, preCompactTokens - postCompactWarmTokens), 8_000);
  const estimatedCompactOutputTokens = Math.max(
    0,
    Number(params.estimatedCompactOutputTokens ?? 7_000)
  );

  const postCompactTotalTokens = postCompactWarmTokens + postCompactColdWriteTokens;
  const reducedContextTokens = Math.max(0, preCompactTokens - postCompactTotalTokens);

  const compactCallCostUSD =
    (preCompactTokens / 1_000_000) * rates.readPer1M +
    (estimatedCompactOutputTokens / 1_000_000) * rates.outputPer1M;
  const firstPostTurnColdSurchargeUSD =
    (postCompactColdWriteTokens / 1_000_000) * Math.max(0, writeRatePer1M - rates.readPer1M);
  const perRequestReadSavingUSD = (reducedContextTokens / 1_000_000) * rates.readPer1M;
  const grossReadSavingUSD = remainingRequestsUsed * perRequestReadSavingUSD;
  const netSavingUSD = Number(
    (grossReadSavingUSD - compactCallCostUSD - firstPostTurnColdSurchargeUSD).toFixed(6)
  );

  return {
    unknownModel: false,
    modelId,
    preCompactTokens,
    postCompactWarmTokens,
    postCompactColdWriteTokens,
    estimatedCompactOutputTokens,
    remainingRequestsUsed: Number(remainingRequestsUsed.toFixed(2)),
    horizonSource,
    isPlaceholderPrior,
    compactCallCostUSD: Number(compactCallCostUSD.toFixed(6)),
    firstPostTurnColdSurchargeUSD: Number(firstPostTurnColdSurchargeUSD.toFixed(6)),
    perRequestReadSavingUSD: Number(perRequestReadSavingUSD.toFixed(6)),
    grossReadSavingUSD: Number(grossReadSavingUSD.toFixed(6)),
    netSavingUSD,
    positive: netSavingUSD > 0
  };
}

/**
 * Evaluates whether a non-blocking task-boundary `/compact` suggestion should be shown (`Item 5`).
 * Enabled by default (`smartCompactBoundarySuggest: true`) with positive H4 ROI gate. Never triggers `/compact`.
 *
 * @param {object} [params={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function evaluateSmartCompactSuggestion(params = {}, options = {}) {
  const enabled = Boolean(
    params.enabled ??
      options.smartCompactBoundarySuggest ??
      options.horizonConfig?.thresholds?.smartCompactBoundarySuggest ??
      options.horizonConfig?.smartCompactBoundarySuggest ??
      true
  );

  if (!enabled) {
    return {
      shouldSuggest: false,
      suppressedReason: 'disabled',
      detectorStatus: 'verified',
      message: null
    };
  }

  const turnsSinceLastCompact =
    params.turnsSinceLastCompact !== undefined && params.turnsSinceLastCompact !== null
      ? Number(params.turnsSinceLastCompact)
      : null;
  if (
    turnsSinceLastCompact !== null &&
    Number.isFinite(turnsSinceLastCompact) &&
    turnsSinceLastCompact < DEFAULT_POST_COMPACT_COOLDOWN_TURNS
  ) {
    return {
      shouldSuggest: false,
      suppressedReason: 'post_compact_cooldown',
      detectorStatus: 'verified',
      message: null
    };
  }

  const detectorState = String(params.detectorState || 'other');
  if (
    detectorState === 'mid_debug' ||
    Boolean(params.openFailure) ||
    Number(params.consecutiveFailures || 0) > 0
  ) {
    return {
      shouldSuggest: false,
      suppressedReason: 'mid_debug',
      detectorStatus: 'verified',
      message: null
    };
  }

  if (Number(params.editsSinceBoundary || 0) > 0) {
    return {
      shouldSuggest: false,
      suppressedReason: 'unverified_edits',
      detectorStatus: 'verified',
      message: null
    };
  }

  if (!params.boundaryDetected && detectorState !== 'task_boundary') {
    return {
      shouldSuggest: false,
      suppressedReason: 'no_task_boundary',
      detectorStatus: 'verified',
      message: null
    };
  }

  const netSaving = computeCompactionHorizonNetSaving(params, options);
  if (netSaving.unknownModel || !netSaving.positive) {
    return {
      shouldSuggest: false,
      suppressedReason: netSaving.unknownModel ? 'unknown_model' : 'non_positive_net_saving',
      detectorStatus: 'verified',
      netSaving,
      message: null
    };
  }

  const message =
    `[Highbeam] Task boundary reached (verified detector): running /compact saves ` +
    `~$${netSaving.netSavingUSD.toFixed(2)} over ~${netSaving.remainingRequestsUsed} remaining requests, ` +
    `with a ~2-minute synchronous pause (H4/H7).`;

  return {
    shouldSuggest: true,
    suppressedReason: null,
    detectorStatus: 'verified',
    netSaving,
    message
  };
}

/**
 * OPT-4A: Evaluates whether a session resuming after an expired KV cache TTL (`>5m` or `>1h`)
 * at high context (`>=60k` tokens default) should flush a `<300`-tok StateBaton (`/handoff`)
 * and run `/clear` rather than paying full uncached input rates for `/compact` (aligned with `DET-17`).
 *
 * @param {object} [params={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function evaluateIdleTtlPreCompactGate(params = {}, options = {}) {
  const enabled = Boolean(
    params.enabled ??
      options.idlePreCompactGate ??
      options.horizonConfig?.thresholds?.idlePreCompactGate ??
      true
  );
  if (!enabled) {
    return {
      shouldSuggest: false,
      suppressedReason: 'disabled',
      message: null
    };
  }

  const promptStr = String(params.promptText || '');
  if (/^\s*\/(?:clear|handoff)\b/i.test(promptStr)) {
    return {
      shouldSuggest: false,
      suppressedReason: 'already_resetting',
      message: null
    };
  }
  const coldCompactRedirect = /^\s*\/compact\b/i.test(promptStr);

  const turnsSinceLastCompact =
    params.turnsSinceLastCompact !== undefined && params.turnsSinceLastCompact !== null
      ? Number(params.turnsSinceLastCompact)
      : null;
  if (
    turnsSinceLastCompact !== null &&
    Number.isFinite(turnsSinceLastCompact) &&
    turnsSinceLastCompact < DEFAULT_POST_COMPACT_COOLDOWN_TURNS
  ) {
    return {
      shouldSuggest: false,
      suppressedReason: 'post_compact_cooldown',
      message: null
    };
  }

  const cacheTtlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';
  const ttlMs = cacheTtlTier === '1h' ? IDLE_TTL_MS_1H : IDLE_TTL_MS_5M;
  const idleGapMs = Math.max(0, Number(params.idleGapMs || 0));
  if (!(idleGapMs > ttlMs)) {
    return {
      shouldSuggest: false,
      suppressedReason: 'cache_still_warm',
      idleGapMs,
      ttlMs,
      message: null
    };
  }

  const minContextTokens = Math.max(
    1_000,
    Number(params.minContextTokens ?? DEFAULT_IDLE_PRE_COMPACT_MIN_TOKENS)
  );
  const contextTokens = Math.max(0, Number(params.contextTokens ?? params.cachedTokens ?? 0));
  if (contextTokens < minContextTokens) {
    return {
      shouldSuggest: false,
      suppressedReason: 'below_min_context',
      idleGapMs,
      ttlMs,
      contextTokens,
      message: null
    };
  }

  const rawModel = params.modelId || params.currentModel || 'claude-sonnet-5-5';
  if (!isKnownCatalogModel(rawModel, options)) {
    return {
      shouldSuggest: false,
      suppressedReason: 'unknown_model',
      idleGapMs,
      ttlMs,
      contextTokens,
      message: null
    };
  }

  const modelId = normalizeModelId(rawModel, options);
  const rates = resolveEffectiveRates(modelId, contextTokens, options);
  const writeRatePer1M = Number(
    (cacheTtlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M) ?? rates.inputPer1M ?? 3.0
  );
  const targetTokens = Math.max(
    100,
    Math.min(
      contextTokens,
      Number(params.postClearBatonTokens ?? params.postCompactTargetTokens ?? DEFAULT_COLD_RESUME_BATON_TOKENS)
    )
  );
  const coldTokensAvoided = Math.max(0, contextTokens - targetTokens);
  const immediateColdRewriteSavingUSD = Number(
    ((coldTokensAvoided / 1_000_000) * writeRatePer1M).toFixed(6)
  );
  const idleMinutes = Math.max(1, Math.round(idleGapMs / 60_000));

  const message =
    `[Highbeam Idle-TTL Cold-Resume] Cache expired after ${idleMinutes}m idle at ~${Math.round(contextTokens / 1000)}k tok (0 cache-bust penalty). ` +
    `Avoid /compact (pays full uncached input rates and is deferred by DET-17); flush a <300-tok StateBaton (/handoff) and run /clear before resuming to avoid ~${Math.round(coldTokensAvoided / 1000)}k cold rewrite (~$${immediateColdRewriteSavingUSD.toFixed(2)} immediate saving).`;

  return {
    shouldSuggest: true,
    suppressedReason: null,
    recommendedAction: 'STATE_BATON_CLEAR',
    recommendedCommand: '/handoff + /clear',
    det17Aligned: true,
    coldCompactRedirect,
    targetTokens,
    idleGapMs,
    ttlMs,
    cacheTtlTier,
    contextTokens,
    coldTokensAvoided,
    immediateColdRewriteSavingUSD,
    modelId,
    message
  };
}

export default {
  TEST_CMD_REGEX,
  DEFAULT_POST_COMPACT_COOLDOWN_TURNS,
  DEFAULT_IDLE_PRE_COMPACT_MIN_TOKENS,
  DEFAULT_IDLE_PRE_COMPACT_TARGET_TOKENS,
  DEFAULT_COLD_RESUME_BATON_TOKENS,
  IDLE_TTL_MS_5M,
  IDLE_TTL_MS_1H,
  isNonCodeDocOrArtifactPath,
  evaluateTaskBoundaryTurn,
  computeCompactionHorizonNetSaving,
  evaluateSmartCompactSuggestion,
  evaluateIdleTtlPreCompactGate
};
