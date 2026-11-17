/**
 * @file src/coach/cacheGravityRouter.mjs
 * Anthropic KV-Cache Flight Computer (`CacheGravityScorer`), `PostCompactMutationQueue`,
 * and `HysteresisLock` for Claude Code Highbeam.
 *
 * Implements the algebraic cross-model break-even equation:
 *   C* = [ O * (P_out,curr - P_out,target) ] / [ P_write,target - P_read,curr ]
 *   with all rates and thresholds derived dynamically from the price catalog at runtime.
 */

import {
  BUILTIN_CATALOG,
  isKnownCatalogModel,
  normalizeModelId,
  computeTotalPromptTokens,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';

export const DEFAULT_FALLBACK_INITIAL_PREFIX_TOKENS = 9000;
export const DEFAULT_REQUESTS_PER_TURN = 1.0;

/**
 * Per-model `DET-09` capability matrix for mid-session `effort` changes with provenance:
 *   - `claude-sonnet-4-6`: invalidates whole prefix (`EF1_46`: 0% cache read, +38.7% cost) -> `yes`
 *   - `claude-opus-4-6`: invalidates whole prefix (earlier article experiment) -> `yes`
 *   - `claude-sonnet-5-5`: keeps cache (`r2_effort.csv` & R2 rerun, n = 3: 99.3% cache read, thinking 1.47-1.57x) -> `no`
 *   - `claude-opus-5-5`: keeps cache (`currency_55.csv` `effort_only_55`: 26,130 vs 26,126 read; behaviour unverified) -> `no`
 *   - All other models: `unknown` (warn as before, labelled `"unverified for this model"`).
 */
export const MODEL_EFFORT_CACHE_CAPABILITIES = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({
    modelId: 'claude-sonnet-4-6',
    invalidatesCache: 'yes',
    invalidationScope: 'whole_prefix',
    status: 'measured',
    provenance: 'EF1_46 (Sonnet 4.6: 0% cache read, +38.7% cost)'
  }),
  'claude-opus-4-6': Object.freeze({
    modelId: 'claude-opus-4-6',
    invalidatesCache: 'yes',
    invalidationScope: 'whole_prefix',
    status: 'measured',
    provenance: 'earlier article experiment (Opus 4.6 effort-only invalidation)'
  }),
  'claude-sonnet-5-5': Object.freeze({
    modelId: 'claude-sonnet-5-5',
    invalidatesCache: 'no',
    invalidationScope: 'none',
    status: 'measured, n = 3 with behaviour change',
    provenance:
      'r2_effort.csv & R2 behavioural rerun (Sonnet 5.5, n = 3: cache kept 99.3%, thinking 1.47-1.57x control)'
  }),
  'claude-opus-5-5': Object.freeze({
    modelId: 'claude-opus-5-5',
    invalidatesCache: 'no',
    invalidationScope: 'none',
    status: 'measured for cache only; behaviour unverified',
    provenance:
      'currency_55.csv effort_only_55 (Opus 5.5: cache kept 26,130 vs 26,126 control; behaviour unverified)'
  })
});

/**
 * Resolves `DET-09` mid-session `effort` cache-invalidation capability for a model.
 * @param {string} [modelId='']
 * @param {object} [options={}]
 */
export function getEffortMutationCacheCapability(modelId = '', options = {}) {
  const known = isKnownCatalogModel(modelId, options);
  const normalized = known ? normalizeModelId(modelId, options) : 'unknown';
  const entry = known ? MODEL_EFFORT_CACHE_CAPABILITIES[normalized] : null;
  if (entry) {
    return entry;
  }
  return {
    modelId: known ? normalized : String(modelId || 'unknown'),
    invalidatesCache: 'unknown',
    invalidationScope: 'unknown',
    status: 'unverified for this model',
    label: 'unverified for this model',
    provenance: 'unverified for this model (not in EF1_46, R2, or currency_55)'
  };
}

/**
 * Placeholder empirical survival prior derived from 496 Antigravity IDE workstation sessions
 * (376 single-prompt/subagent, 120 interactive) measured in API requests (`api_requests`),
 * NOT native Claude Code session logs. Converted to turns using the session's `requestsPerTurn`.
 */
export const EMPIRICAL_SESSION_API_CALL_PRIOR = Object.freeze({
  isPlaceholderPrior: true,
  provenance: 'placeholder_antigravity_ide_workstation_logs_not_claude_code',
  unit: 'api_requests',
  note: 'Placeholder distribution derived from 496 Antigravity IDE workstation planner runs (376 subagent/single-prompt, 120 interactive) in API requests, NOT Claude Code telemetry; convert to turns via observed requestsPerTurn.',
  sampleCount: 496,
  interactiveSampleCount: 120,
  unconditionalMedian: 62,
  unconditionalP25: 35,
  unconditionalP75: 96,
  survivalBuckets: Object.freeze([
    { label: '0-3_requests', maxTurn: 3, remainingMedian: 59 },
    { label: '4-6_requests', maxTurn: 6, remainingMedian: 57 },
    { label: '7-12_requests', maxTurn: 12, remainingMedian: 54 },
    { label: '13-24_requests', maxTurn: 24, remainingMedian: 47 },
    { label: '25+_requests', maxTurn: Infinity, remainingMedian: 34 }
  ])
});

/**
 * Resolves a finite positive API-requests-per-turn ratio from session observations,
 * falling back cleanly to `DEFAULT_REQUESTS_PER_TURN` (1.0).
 */
export function resolveRequestsPerTurn(context = {}, options = {}) {
  const explicitRpt = Number(context.requestsPerTurn ?? options.requestsPerTurn);
  if (Number.isFinite(explicitRpt) && explicitRpt > 0) {
    return {
      requestsPerTurn: Number(explicitRpt.toFixed(4)),
      source: 'observed_requests_per_turn'
    };
  }
  const turns = Math.max(0, Number(context.turnsCompleted ?? context.currentTurn ?? 0));
  const calls = Number(context.apiCallsCompleted ?? options.apiCallsCompleted);
  if (turns > 0 && Number.isFinite(calls) && calls > 0) {
    return {
      requestsPerTurn: Number((calls / turns).toFixed(4)),
      source: 'derived_api_calls_per_turn'
    };
  }
  return {
    requestsPerTurn: DEFAULT_REQUESTS_PER_TURN,
    source: 'default_1.0'
  };
}

/**
 * Estimates expected remaining **turns** for a running session (`C1e` / `rule_v2`) by combining:
 * 1. Conditional survival remaining **API requests** from local Claude Code transcripts (`>= 5` sessions)
 *    or the labeled placeholder 496-session Antigravity prior, converted via `requestsPerTurn`.
 * 2. Context-ceiling compaction bound (using dynamic `contextCeiling`, observed Turn-0/1 prefix,
 *    and observed growth per API request -> converted to turns).
 *
 * Returns `expectedRemainingTurns = min(empiricalResidualTurns, turnsUntilCompact)`.
 *
 * @param {object} [context={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function estimateEmpiricalRemainingTurns(context = {}, options = {}) {
  const turnsCompleted = Math.max(0, Number(context.turnsCompleted ?? context.currentTurn ?? 0));
  const cachedTokens = Math.max(0, Number(context.cachedTokens ?? 0));
  const contextCeiling = Math.max(10_000, Number(context.contextCeiling || 200_000));
  const autoCompactLimitTokens = Math.max(
    10_000,
    Number(context.autoCompactLimitTokens || Math.round(contextCeiling * 0.8))
  );
  const rptInfo = resolveRequestsPerTurn(context, options);
  const requestsPerTurn = rptInfo.requestsPerTurn;
  const rawApiCalls = Number(context.apiCallsCompleted ?? options.apiCallsCompleted);
  const apiCallsCompleted =
    Number.isFinite(rawApiCalls) && rawApiCalls >= 0
      ? rawApiCalls
      : Math.round(turnsCompleted * requestsPerTurn);

  let empiricalResidualRequests;
  let priorBucket = '25+_requests';
  let source = 'placeholder_antigravity_496_prior';
  let isPlaceholderPrior = true;
  let priorProvenance = EMPIRICAL_SESSION_API_CALL_PRIOR.provenance;
  const hist = options.historicalSessionApiCalls;
  if (Array.isArray(hist) && hist.length >= 5) {
    source = 'local_transcripts';
    isPlaceholderPrior = false;
    priorProvenance = 'local_claude_code_transcripts';
    const survivors = hist
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > apiCallsCompleted)
      .map((n) => n - apiCallsCompleted)
      .sort((a, b) => a - b);
    if (survivors.length > 0) {
      empiricalResidualRequests = survivors[Math.floor((survivors.length - 1) / 2)];
      priorBucket = `local_survivors_${survivors.length}`;
    } else {
      const sorted = hist
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      empiricalResidualRequests = sorted.length > 0
        ? Math.max(1, sorted[Math.floor((sorted.length - 1) * 0.25)])
        : 10;
      priorBucket = 'local_p25_fallback';
    }
  } else {
    const bucket = EMPIRICAL_SESSION_API_CALL_PRIOR.survivalBuckets.find(
      (b) => apiCallsCompleted <= b.maxTurn
    );
    empiricalResidualRequests = bucket ? bucket.remainingMedian : 34;
    priorBucket = bucket ? bucket.label : '25+_requests';
  }

  const baselinePrefix =
    Number(context.initialPrefixTokens) > 0
      ? Number(context.initialPrefixTokens)
      : turnsCompleted === 0 && cachedTokens > 0
        ? cachedTokens
        : DEFAULT_FALLBACK_INITIAL_PREFIX_TOKENS;
  const explicitGrowthPerTurn = Number(context.contextGrowthPerTurn);
  const observedGrowthPerRequest =
    Number.isFinite(explicitGrowthPerTurn) && explicitGrowthPerTurn > 0 && requestsPerTurn > 0
      ? explicitGrowthPerTurn / requestsPerTurn
      : apiCallsCompleted > 0 && cachedTokens > baselinePrefix
        ? (cachedTokens - baselinePrefix) / apiCallsCompleted
        : 600;
  const avgDeltaTokensPerCall = Math.min(12_000, Math.max(300, observedGrowthPerRequest));
  const callsUntilCompact =
    cachedTokens >= autoCompactLimitTokens
      ? 1
      : Math.max(1, Math.floor((autoCompactLimitTokens - cachedTokens) / avgDeltaTokensPerCall));

  const expectedRemainingRequests = Math.min(empiricalResidualRequests, callsUntilCompact);
  const expectedRemainingTurns = Number(
    (expectedRemainingRequests / requestsPerTurn).toFixed(2)
  );
  // Prior residual requests are counted before the switch turn executes; 1 turn is consumed by the switch itself.
  const postSwitchRemainingTurns = Number(Math.max(0, expectedRemainingTurns - 1).toFixed(2));

  return {
    expectedRemainingTurns,
    postSwitchRemainingTurns,
    expectedRemainingRequests,
    empiricalResidual: expectedRemainingRequests,
    empiricalResidualRequests,
    callsUntilCompact,
    requestsPerTurn,
    requestsPerTurnSource: rptInfo.source,
    horizonUnit: 'turns',
    priorNativeUnit: EMPIRICAL_SESSION_API_CALL_PRIOR.unit,
    priorBucket,
    isPlaceholderPrior,
    priorProvenance,
    initialPrefixTokensUsed: baselinePrefix,
    contextCeilingUsed: contextCeiling,
    autoCompactLimitTokensUsed: autoCompactLimitTokens,
    source
  };
}

export const FLIGHT_MODES = Object.freeze({
  OFF: 'OFF',
  SILENT: 'SILENT',
  COACH: 'COACH',
  AUTO_PILOT: 'AUTO_PILOT'
});

export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1500;
export const DEFAULT_DET09_OUTPUT_DELTA_TOKENS = 800;

const PREFIX_INSTRUCTION_FILE_REGEX =
  /(?:^|\/)(?:CLAUDE(?:\.local)?\.md|AGENTS\.md|\.mcp\.json)$|(?:^|\/)\.claude\/(?:CLAUDE\.md|rules\/.+\.md)$/i;

/**
 * Checks whether a workspace file path is a top-level prompt-prefix instruction or MCP config file
 * whose mid-session modification invalidates the Anthropic KV-cache prefix (`DET-09`).
 *
 * @param {string} [filePath='']
 * @returns {boolean}
 */
export function isPrefixInstructionFile(filePath = '') {
  const norm = String(filePath || '').trim().replace(/\\/g, '/');
  if (!norm) return false;
  return PREFIX_INSTRUCTION_FILE_REGEX.test(norm);
}
export const DEFAULT_ADVISORY_COOLDOWN_TURNS = 3;

/**
 * Maps an active model to its natural one-tier downshift peer for cross-model break-even C* (`ISS-006`).
 * Break-even thresholds are computed dynamically from `anthropicModelCatalog.json` rates at runtime.
 *   - claude-fable-5-2 / claude-fable-5-1 -> claude-opus-5-5
 *   - claude-opus-5-5 -> claude-sonnet-5-5
 *   - claude-opus-4-6 / claude-opus-4-5 -> claude-sonnet-4-6
 *   - claude-sonnet-5-5 -> claude-haiku-5-5
 *   - claude-sonnet-4-6 / claude-sonnet-4-5 -> claude-haiku-4-5
 *   - claude-haiku-4-5 -> claude-haiku-5-5
 *
 * @param {string} [modelId='claude-opus-5-5']
 * @returns {string}
 */
export function resolveNaturalDownshiftPeer(modelId = 'claude-opus-5-5') {
  const norm = normalizeModelId(modelId);
  switch (norm) {
    case 'claude-mythos-5-2':
    case 'claude-mythos-5-1':
    case 'claude-mythos-5':
    case 'claude-fable-5-2':
    case 'claude-fable-5-1':
    case 'claude-fable-5':
      return 'claude-opus-5-5';
    case 'claude-opus-5-5':
      return 'claude-sonnet-5-5';
    case 'claude-opus-5':
      return 'claude-sonnet-5';
    case 'claude-opus-4-8':
    case 'claude-opus-4-7':
    case 'claude-opus-4-6':
    case 'claude-opus-4-5':
    case 'claude-opus-4-1':
    case 'claude-opus-4-0':
      return 'claude-sonnet-4-6';
    case 'claude-sonnet-5-5':
    case 'claude-sonnet-5':
      return 'claude-haiku-5-5';
    case 'claude-sonnet-4-6':
    case 'claude-sonnet-4-5':
    case 'claude-sonnet-4-0':
      return 'claude-haiku-4-5';
    case 'claude-3-7-sonnet':
    case 'claude-3-5-sonnet':
    case 'claude-3-5-haiku':
      return 'claude-3-5-haiku';
    case 'claude-haiku-4-5':
    case 'claude-haiku-5-5':
      return 'claude-haiku-5-5';
    default:
      return 'claude-sonnet-5-5';
  }
}

/**
 * Normalizes any flight mode string into `'OFF' | 'SILENT' | 'COACH' | 'AUTO_PILOT'`.
 * @param {string} [rawMode='COACH']
 * @returns {'OFF'|'SILENT'|'COACH'|'AUTO_PILOT'}
 */
export function normalizeFlightMode(rawMode = 'COACH') {
  const cleaned = String(rawMode || 'COACH')
    .toUpperCase()
    .trim()
    .replace(/[-\s]+/g, '_');
  if (cleaned === 'OFF' || cleaned === 'DISABLED') return FLIGHT_MODES.OFF;
  if (cleaned === 'SILENT' || cleaned === 'QUIET' || cleaned === 'MUTE') {
    return FLIGHT_MODES.SILENT;
  }
  if (cleaned === 'AUTO_PILOT' || cleaned === 'AUTOPILOT' || cleaned === 'AUTO') {
    return FLIGHT_MODES.AUTO_PILOT;
  }
  return FLIGHT_MODES.COACH;
}

/**
 * Checks whether a flight mode suppresses non-security coach advisories (`OFF` or `SILENT`).
 * @param {string} [mode='COACH']
 * @returns {boolean}
 */
export function isSilentOrOffMode(mode = 'COACH') {
  const norm = normalizeFlightMode(mode);
  return norm === FLIGHT_MODES.OFF || norm === FLIGHT_MODES.SILENT;
}

/**
 * Computes the exact cross-model break-even cached token threshold `C*` and USD turn costs.
 *
 * Equation:
 *   C* = (O * (P_out,curr - P_out,target)) / (P_write5m,target - P_read,curr)
 *
 * When `cachedTokens > C*` on a warm cache, switching from `currentModel` to `targetModel`
 * costs MORE in cold `1.25x` prefix rewrite than it saves on output tokens.
 *
 * @param {object} [params={}]
 * @param {string} [params.currentModel='claude-opus-5-5']
 * @param {string} [params.targetModel='claude-sonnet-5-5']
 * @param {number} [params.expectedOutputTokens=1500]
 * @param {number} [params.cachedTokens=0]
 * @param {number} [params.uncachedDeltaTokens=0]
 * @param {boolean} [params.cacheWarm=true]
 * @param {'5m'|'1h'} [params.cacheTtlTier='5m']
 * @param {object} [options={}]
 */
export function computeBreakEvenCachedTokens(params = {}, options = {}) {
  const rawCurrentModel = params.currentModel ?? 'claude-opus-5-5';
  const rawTargetModel = params.targetModel ?? 'claude-sonnet-5-5';
  const expectedOutputTokens = Math.max(
    0,
    Number(params.expectedOutputTokens ?? DEFAULT_EXPECTED_OUTPUT_TOKENS)
  );
  const cachedTokens = Math.max(0, Number(params.cachedTokens ?? 0));
  const uncachedDeltaTokens = Math.max(0, Number(params.uncachedDeltaTokens ?? 0));
  const uncachedWriteTokens = Math.max(0, Number(params.uncachedWriteTokens ?? 0));
  const request1UncachedTokens = uncachedDeltaTokens + uncachedWriteTokens;
  const cacheWarm = params.cacheWarm !== undefined ? Boolean(params.cacheWarm) : cachedTokens > 0;
  const ttlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';

  const totalPromptTokens = Math.max(
    cachedTokens + request1UncachedTokens,
    computeTotalPromptTokens(params)
  );

  const currentKnown =
    params.currentModel !== undefined ? isKnownCatalogModel(rawCurrentModel, options) : true;
  const targetKnown =
    params.targetModel !== undefined ? isKnownCatalogModel(rawTargetModel, options) : true;

  if (!currentKnown || !targetKnown) {
    const unknownModelIds = [];
    if (!currentKnown) unknownModelIds.push(String(rawCurrentModel));
    if (!targetKnown && String(rawTargetModel) !== String(rawCurrentModel)) {
      unknownModelIds.push(String(rawTargetModel));
    }
    const rawRemaining = params.expectedRemainingTurns ?? options.expectedRemainingTurns;
    const hasExplicitRemaining =
      rawRemaining !== undefined &&
      rawRemaining !== null &&
      Number.isFinite(Number(rawRemaining));
    const useEmpirical = Boolean(
      params.useEmpiricalHorizonPrior ?? options.useEmpiricalHorizonPrior
    );
    return {
      unknownModel: true,
      unknownModelIds,
      currentModel: String(rawCurrentModel || ''),
      targetModel: String(rawTargetModel || ''),
      expectedOutputTokens,
      cachedTokens,
      uncachedDeltaTokens,
      uncachedWriteTokens,
      totalPromptTokens,
      cacheWarm,
      cacheTtlTier: ttlTier,
      writeMultiplierLabel: ttlTier === '1h' ? '2.0x' : '1.25x',
      isCapabilityUpshift: false,
      breakEvenTokens: null,
      rates: null,
      stayOnCurrentModelUSD: null,
      switchToTargetModelUSD: null,
      coldWritePenaltyUSD: null,
      perTurnPostSwitchSavingUSD: null,
      averagePostSwitchSavingUSD: null,
      paybackTurns: null,
      paybackWarmRequests: null,
      switchTurnWarmReads: 0,
      totalWarmReadsToPayback: null,
      asymptoticWarmRequestRatio: null,
      contextGrowthPerTurn: Math.max(0, Number(params.contextGrowthPerTurn ?? 0)),
      expectedRemainingTurns: hasExplicitRemaining ? Math.max(0, Number(rawRemaining)) : null,
      postSwitchRemainingTurns: hasExplicitRemaining ? Math.max(0, Number(rawRemaining)) : null,
      horizonMaxCachedTokens: null,
      horizonNetSavingsUSD: null,
      horizonPriorSource: null,
      ruleVersion: hasExplicitRemaining || useEmpirical ? 'rule_v2' : 'rule_v1',
      shouldHold: false,
      shouldHoldModel: false
    };
  }

  const currentModel = normalizeModelId(rawCurrentModel);
  const targetModel = normalizeModelId(rawTargetModel);
  const currRates = resolveEffectiveRates(rawCurrentModel, totalPromptTokens, options);
  const targetRates = resolveEffectiveRates(rawTargetModel, totalPromptTokens, options);

  const pOutCurr = currRates.outputPer1M;
  const pOutTarget = targetRates.outputPer1M;
  const pReadCurr = currRates.readPer1M;
  const pWriteCurr = ttlTier === '1h' ? currRates.write1hPer1M : currRates.write5mPer1M;
  const pWriteTarget = ttlTier === '1h' ? targetRates.write1hPer1M : targetRates.write5mPer1M;

  const isCapabilityUpshift = pOutCurr <= pOutTarget;

  // Resolve requests/turn and post-switch turn horizon BEFORE cost math so multi-request turns scale read savings cleanly.
  const observedContextCeilingRaw = Number(
    params.contextCeiling ?? params.contextWindowSize ?? options.contextCeiling
  );
  const resolvedContextCeiling =
    Number.isFinite(observedContextCeilingRaw) && observedContextCeilingRaw >= 10_000
      ? Math.round(observedContextCeilingRaw)
      : currRates.contextCeiling;
  const rptInfo = resolveRequestsPerTurn(params, options);

  const rawRemainingTurns = params.expectedRemainingTurns ?? options.expectedRemainingTurns;
  const hasExplicitRemaining =
    rawRemainingTurns !== undefined &&
    rawRemainingTurns !== null &&
    Number.isFinite(Number(rawRemainingTurns));
  const useEmpiricalHorizonPrior = Boolean(
    params.useEmpiricalHorizonPrior ?? options.useEmpiricalHorizonPrior
  );
  let expectedRemainingTurns = null;
  let postSwitchRemainingTurns = null;
  let expectedRemainingRequests = null;
  let horizonPriorSource = null;
  let priorBucket = null;
  let priorNativeUnit = null;
  let requestsPerTurnUsed = rptInfo.requestsPerTurn;
  let isPlaceholderPrior = false;
  let priorProvenance = null;
  let initialPrefixTokensUsed =
    Number(params.initialPrefixTokens) > 0 ? Number(params.initialPrefixTokens) : null;
  if (hasExplicitRemaining) {
    expectedRemainingTurns = Math.max(0, Number(rawRemainingTurns));
    const explicitIncludesSwitchTurn = Boolean(params.horizonIncludesSwitchTurn);
    postSwitchRemainingTurns = explicitIncludesSwitchTurn
      ? Number(Math.max(0, expectedRemainingTurns - 1).toFixed(2))
      : expectedRemainingTurns;
    horizonPriorSource = 'explicit';
    priorBucket = 'explicit_turns';
    priorNativeUnit = 'turns';
  } else if (useEmpiricalHorizonPrior) {
    const prior = estimateEmpiricalRemainingTurns(
      {
        turnsCompleted: params.turnsCompleted ?? params.currentTurn ?? 0,
        apiCallsCompleted: params.apiCallsCompleted,
        requestsPerTurn: params.requestsPerTurn,
        contextGrowthPerTurn: params.contextGrowthPerTurn,
        cachedTokens,
        contextCeiling: resolvedContextCeiling,
        autoCompactLimitTokens: params.autoCompactLimitTokens,
        initialPrefixTokens: params.initialPrefixTokens
      },
      options
    );
    expectedRemainingTurns = prior.expectedRemainingTurns;
    postSwitchRemainingTurns = prior.postSwitchRemainingTurns;
    expectedRemainingRequests = prior.expectedRemainingRequests;
    horizonPriorSource = prior.source;
    priorBucket = prior.priorBucket;
    priorNativeUnit = prior.priorNativeUnit;
    requestsPerTurnUsed = prior.requestsPerTurn;
    isPlaceholderPrior = prior.isPlaceholderPrior;
    priorProvenance = prior.priorProvenance;
    initialPrefixTokensUsed = prior.initialPrefixTokensUsed;
  }

  let breakEvenTokens = 0;
  if (currentModel === targetModel || isCapabilityUpshift) {
    breakEvenTokens = 0;
  } else {
    const numeratorUSD =
      (expectedOutputTokens / 1_000_000) * (pOutCurr - pOutTarget) +
      (request1UncachedTokens / 1_000_000) * (pWriteCurr - pWriteTarget);
    const denominator = pWriteTarget - pReadCurr;
    if (numeratorUSD <= 0) {
      breakEvenTokens = 0;
    } else if (denominator <= 0) {
      breakEvenTokens = Infinity;
    } else {
      breakEvenTokens = Math.round((numeratorUSD * 1_000_000) / denominator);
    }
  }

  // Exact USD switch-turn cost: request 1 pays cache write on cold target (and uncachedWriteTokens even on stay); requests 2..R read at warm rate.
  const effectiveRpt = currentModel === targetModel ? 1 : Math.max(1, requestsPerTurnUsed);
  const extraWarmReadsOnSwitchTurn = Math.max(0, effectiveRpt - 1);
  const combinedReq1Tokens = cachedTokens + request1UncachedTokens;
  const stayPrefixCostUSD = cacheWarm
    ? (cachedTokens / 1_000_000) * pReadCurr +
      (request1UncachedTokens / 1_000_000) * pWriteCurr +
      extraWarmReadsOnSwitchTurn * (combinedReq1Tokens / 1_000_000) * pReadCurr
    : (combinedReq1Tokens / 1_000_000) * pWriteCurr +
      extraWarmReadsOnSwitchTurn * (combinedReq1Tokens / 1_000_000) * pReadCurr;
  const stayOutputCostUSD = (expectedOutputTokens / 1_000_000) * pOutCurr;
  const stayOnCurrentModelUSD = stayPrefixCostUSD + stayOutputCostUSD;

  // Switching to a different model invalidates the isolated per-model cache on Request 1, forcing a cold write
  const switchPrefixCostUSD =
    currentModel === targetModel && cacheWarm
      ? stayPrefixCostUSD
      : (combinedReq1Tokens / 1_000_000) * pWriteTarget +
        extraWarmReadsOnSwitchTurn * (combinedReq1Tokens / 1_000_000) * targetRates.readPer1M;
  const switchOutputCostUSD = (expectedOutputTokens / 1_000_000) * pOutTarget;
  const switchToTargetModelUSD = switchPrefixCostUSD + switchOutputCostUSD;

  const coldWritePenaltyUSD = Number(
    (switchToTargetModelUSD - stayOnCurrentModelUSD).toFixed(6)
  );

  // Horizon-aware payback (`C1e` / `rule_v2`, opt-in via `expectedRemainingTurns` or `useEmpiricalHorizonPrior`):
  //   perTurnPostSwitchSavingUSD = R * ((C + cw_1)/1M) * (P_read,curr - P_read,target)
  //                              + (Delta_post/1M) * (P_write,curr - P_write,target)
  //                              + (O/1M) * (P_out,curr - P_out,target)
  //   paybackTurns = coldWritePenaltyUSD / perTurnPostSwitchSavingUSD
  // When `expectedRemainingTurns` is unset (`undefined`/`null`), `shouldHoldModel` preserves `rule_v1`.
  const postSwitchDeltaTokens = Math.max(
    0,
    Number(params.postSwitchDeltaTokens ?? uncachedDeltaTokens)
  );
  const contextGrowthPerTurn = Math.max(0, Number(params.contextGrowthPerTurn ?? 0));
  const effectivePostSwitchDeltaTokens =
    contextGrowthPerTurn > 0 && params.postSwitchDeltaTokens === undefined
      ? contextGrowthPerTurn
      : postSwitchDeltaTokens;

  const rawPerTurnPostSwitchSavingUSD =
    currentModel === targetModel || isCapabilityUpshift
      ? 0
      : effectiveRpt *
          (combinedReq1Tokens / 1_000_000) *
          (pReadCurr - targetRates.readPer1M) +
        (effectivePostSwitchDeltaTokens / 1_000_000) * (pWriteCurr - pWriteTarget) +
        (expectedOutputTokens / 1_000_000) * (pOutCurr - pOutTarget);
  const perTurnPostSwitchSavingUSD = Number(
    Math.max(0, rawPerTurnPostSwitchSavingUSD).toFixed(6)
  );

  const growthCoeffA =
    currentModel === targetModel || isCapabilityUpshift || contextGrowthPerTurn <= 0
      ? 0
      : 0.5 *
        effectiveRpt *
        (contextGrowthPerTurn / 1_000_000) *
        (pReadCurr - targetRates.readPer1M);

  const hasHorizonTurns = postSwitchRemainingTurns !== null;
  const averagePostSwitchSavingUSD =
    hasHorizonTurns && postSwitchRemainingTurns > 1 && growthCoeffA !== 0
      ? Number(
          Math.max(
            0,
            rawPerTurnPostSwitchSavingUSD + (postSwitchRemainingTurns - 1) * growthCoeffA
          ).toFixed(6)
        )
      : perTurnPostSwitchSavingUSD;

  let paybackTurns;
  if (coldWritePenaltyUSD <= 0) {
    paybackTurns = 0;
  } else if (growthCoeffA > 0) {
    const s0 = Math.max(0, rawPerTurnPostSwitchSavingUSD);
    const bCoeff = s0 - growthCoeffA;
    const disc = bCoeff * bCoeff + 4 * growthCoeffA * coldWritePenaltyUSD;
    paybackTurns =
      disc >= 0
        ? Number(((-bCoeff + Math.sqrt(disc)) / (2 * growthCoeffA)).toFixed(4))
        : Infinity;
  } else {
    paybackTurns =
      perTurnPostSwitchSavingUSD > 0
        ? Number((coldWritePenaltyUSD / perTurnPostSwitchSavingUSD).toFixed(4))
        : Infinity;
  }

  const paybackWarmRequests =
    coldWritePenaltyUSD <= 0
      ? 0
      : Number.isFinite(paybackTurns)
        ? Number((paybackTurns * effectiveRpt).toFixed(2))
        : Infinity;
  const switchTurnWarmReads = extraWarmReadsOnSwitchTurn;
  const totalWarmReadsToPayback =
    coldWritePenaltyUSD <= 0
      ? 0
      : Number.isFinite(paybackWarmRequests)
        ? Number((switchTurnWarmReads + paybackWarmRequests).toFixed(2))
        : Infinity;
  const warmReadSpread = pReadCurr - targetRates.readPer1M;
  const asymptoticWarmRequestRatio =
    currentModel === targetModel || isCapabilityUpshift || warmReadSpread <= 0
      ? null
      : Number(((pWriteTarget - pReadCurr) / warmReadSpread).toFixed(2));

  // Exact horizon-aware break-even context C_max for post-switch turns H_post and requests/turn R:
  //   C_max = (O * (P_out,A - P_out,B) * (H_post + 1)) / ((P_write,B - P_read,A) - ((H_post + 1) * R - 1) * (P_read,A - P_read,B))
  let horizonMaxCachedTokens = null;
  if (hasHorizonTurns) {
    if (currentModel === targetModel || isCapabilityUpshift) {
      horizonMaxCachedTokens = 0;
    } else {
      const warmReadDiffPer1M = pReadCurr - targetRates.readPer1M;
      const postSwitchWarmReadsTotal = (postSwitchRemainingTurns + 1) * effectiveRpt - 1;
      const cMaxDen = (pWriteTarget - pReadCurr) - postSwitchWarmReadsTotal * warmReadDiffPer1M;
      const cMaxNumUSD =
        (expectedOutputTokens / 1_000_000) *
        (pOutCurr - pOutTarget) *
        (postSwitchRemainingTurns + 1);
      if (cMaxDen <= 0) {
        horizonMaxCachedTokens = Infinity;
      } else if (cMaxNumUSD <= 0) {
        horizonMaxCachedTokens = 0;
      } else {
        horizonMaxCachedTokens = Math.round((cMaxNumUSD * 1_000_000) / cMaxDen);
      }
    }
  }

  const horizonNetSavingsUSD = hasHorizonTurns
    ? Number(
        (
          postSwitchRemainingTurns *
            (Math.max(0, rawPerTurnPostSwitchSavingUSD) +
              (postSwitchRemainingTurns > 1 ? (postSwitchRemainingTurns - 1) * growthCoeffA : 0)) -
          coldWritePenaltyUSD
        ).toFixed(6)
      )
    : null;

  const singleTurnShouldHold = Boolean(
    currentModel !== targetModel &&
      !isCapabilityUpshift &&
      cacheWarm &&
      coldWritePenaltyUSD > 0 &&
      cachedTokens > breakEvenTokens
  );

  // Never hold/deny on capability upshifts, coldWritePenaltyUSD <= 0, or unbounded horizon limit C_max = Infinity
  const shouldHoldModel = hasHorizonTurns
    ? Boolean(
        singleTurnShouldHold &&
          horizonMaxCachedTokens !== Infinity &&
          postSwitchRemainingTurns < paybackTurns
      )
    : singleTurnShouldHold;

  return {
    unknownModel: false,
    unknownModelIds: [],
    currentModel,
    targetModel,
    expectedOutputTokens,
    cachedTokens,
    uncachedDeltaTokens,
    uncachedWriteTokens,
    totalPromptTokens,
    cacheWarm,
    cacheTtlTier: ttlTier,
    writeMultiplierLabel: ttlTier === '1h' ? '2.0x' : '1.25x',
    isCapabilityUpshift,
    breakEvenTokens,
    horizonMaxCachedTokens,
    rates: {
      currentOutputPer1M: pOutCurr,
      targetOutputPer1M: pOutTarget,
      currentReadPer1M: pReadCurr,
      targetReadPer1M: targetRates.readPer1M,
      currentWritePer1M: pWriteCurr,
      targetWritePer1M: pWriteTarget
    },
    stayOnCurrentModelUSD: Number(stayOnCurrentModelUSD.toFixed(6)),
    switchToTargetModelUSD: Number(switchToTargetModelUSD.toFixed(6)),
    coldWritePenaltyUSD,
    perTurnPostSwitchSavingUSD,
    averagePostSwitchSavingUSD,
    paybackTurns,
    paybackWarmRequests,
    switchTurnWarmReads,
    totalWarmReadsToPayback,
    asymptoticWarmRequestRatio,
    contextGrowthPerTurn,
    expectedRemainingTurns,
    postSwitchRemainingTurns,
    expectedRemainingRequests,
    horizonUnit: 'turns',
    priorNativeUnit,
    priorBucket,
    requestsPerTurn: requestsPerTurnUsed,
    isPlaceholderPrior,
    priorProvenance,
    contextCeilingUsed: resolvedContextCeiling,
    initialPrefixTokensUsed,
    horizonNetSavingsUSD,
    horizonPriorSource,
    ruleVersion: hasHorizonTurns ? 'rule_v2' : 'rule_v1',
    shouldHold: shouldHoldModel,
    shouldHoldModel
  };
}

/**
 * Queue for deferring top-level `effort`, `thinking`, `system_prompt`, or `mcp_tools`
 * mutations until immediately after context compaction (`PostCompact`), avoiding mid-session
 * full-prefix cache invalidation (`DET-09`).
 */
export class PostCompactMutationQueue {
  /**
   * @param {Array<object>} [initialItems=[]]
   */
  constructor(initialItems = []) {
    this.items = Array.isArray(initialItems) ? [...initialItems] : [];
  }

  /**
   * Enqueues or updates a deferred mutation keyed by `(type, key)`.
   * @param {object} mutation
   * @param {'effort'|'thinking'|'speed'|'system_prompt'|'mcp_tools'|'model'} mutation.type
   * @param {string} [mutation.key]
   * @param {any} mutation.value
   * @param {string} [mutation.reason]
   * @param {number} [mutation.avoidedRewritePenaltyUSD]
   * @param {number} [mutation.cachedTokens]
   * @param {number} [mutation.savedTokens]
   * @returns {object} Enqueued entry
   */
  enqueue(mutation = {}) {
    const type = String(mutation.type || 'effort');
    const key = String(mutation.key || type);
    const entry = {
      type,
      key,
      value: mutation.value,
      reason: mutation.reason || 'Deferred to PostCompact to preserve warm Anthropic prompt cache prefix',
      avoidedRewritePenaltyUSD: Number(mutation.avoidedRewritePenaltyUSD || 0),
      cachedTokens: Math.max(0, Number(mutation.cachedTokens || 0)),
      savedTokens: Math.max(0, Number(mutation.savedTokens || 0)),
      enqueuedAt: mutation.enqueuedAt || Date.now()
    };

    const existingIdx = this.items.findIndex((item) => item.type === type && item.key === key);
    if (existingIdx >= 0) {
      this.items[existingIdx] = entry;
    } else {
      this.items.push(entry);
    }
    return entry;
  }

  /**
   * Returns a shallow copy of all pending mutations without removing them.
   * @returns {Array<object>}
   */
  peekAll() {
    return [...this.items];
  }

  /**
   * Returns the number of queued mutations.
   * @returns {number}
   */
  size() {
    return this.items.length;
  }

  /**
   * Checks whether any mutations are waiting for compaction.
   * @returns {boolean}
   */
  hasPending() {
    return this.items.length > 0;
  }

  /**
   * Flushes and returns all queued mutations on `PostCompact` so they apply at zero extra rewrite cost.
   * @param {object} [context={}]
   * @returns {{ flushedCount: number, appliedMutations: Array<object>, totalAvoidedPenaltyUSD: number, flushedAt: number }}
   */
  flush(context = {}) {
    const appliedMutations = [...this.items];
    this.items = [];
    const totalAvoidedPenaltyUSD = Number(
      appliedMutations
        .reduce((acc, item) => acc + Number(item.avoidedRewritePenaltyUSD || 0), 0)
        .toFixed(6)
    );
    return {
      flushedCount: appliedMutations.length,
      appliedMutations,
      totalAvoidedPenaltyUSD,
      flushedAt: context.nowMs || Date.now()
    };
  }

  /**
   * Clears the queue.
   */
  clear() {
    this.items = [];
  }

  /**
   * Serializes queue for `$.store` or `StateBaton`.
   * @returns {Array<object>}
   */
  toJSON() {
    return [...this.items];
  }

  /**
   * Restores a `PostCompactMutationQueue` from serialized array.
   * @param {Array<object>} data
   * @returns {PostCompactMutationQueue}
   */
  static fromJSON(data) {
    return new PostCompactMutationQueue(Array.isArray(data) ? data : []);
  }
}

/**
 * Hysteresis Lock ensuring loop-triggered escalations (`DET-04` consecutive failures or `DET-05`
 * edit thrashing) stay pinned until active task completion or rewind/branch reset.
 */
export class HysteresisLock {
  constructor(initialState = {}) {
    this.locked = Boolean(initialState.locked);
    this.pinnedModel = initialState.pinnedModel || null;
    this.pinnedEffort = initialState.pinnedEffort || null;
    this.reason = initialState.reason || null;
    this.lockedAtTurn = initialState.lockedAtTurn ?? null;
  }

  /**
   * Pins model/effort due to a loop or thrashing escalation.
   * @param {object} params
   */
  engage({ model, effort = 'high', reason = 'Loop escalation lock', turn = 0 } = {}) {
    this.locked = true;
    this.pinnedModel = model ? normalizeModelId(model) : this.pinnedModel;
    this.pinnedEffort = effort;
    this.reason = reason;
    this.lockedAtTurn = turn;
    return this.getStatus();
  }

  /**
   * Releases the lock when the active task completes cleanly.
   */
  completeActiveTask() {
    this.locked = false;
    this.pinnedModel = null;
    this.pinnedEffort = null;
    this.reason = null;
    this.lockedAtTurn = null;
    return this.getStatus();
  }

  /**
   * Releases the lock on conversation rewind or git branch reset.
   */
  resetOnRewindOrBranch() {
    return this.completeActiveTask();
  }

  /**
   * Returns current lock status.
   */
  getStatus() {
    return {
      locked: this.locked,
      pinnedModel: this.pinnedModel,
      pinnedEffort: this.pinnedEffort,
      reason: this.reason,
      lockedAtTurn: this.lockedAtTurn
    };
  }
}

/**
 * Anthropic Cache GravityScorer & Flight Computer Router.
 * Supports `OFF | COACH | AUTO_PILOT` modes, 3-turn advisory cooldown,
 * `PreModelSwitch` (`DET-08`) break-even protection, `PostCompactMutationQueue` (`DET-09`),
 * and `Explore`/`Task` Haiku 5.5 subagent leaf delegation.
 */
export class CacheGravityRouter {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.options = options;
    this.mode = normalizeFlightMode(options.mode || FLIGHT_MODES.COACH);
    this.cooldownTurns = Number(options.cooldownTurns ?? DEFAULT_ADVISORY_COOLDOWN_TURNS);
    this.lastAdvisoryTurn = null;
    this.mutationQueue =
      options.mutationQueue instanceof PostCompactMutationQueue
        ? options.mutationQueue
        : new PostCompactMutationQueue(options.queuedMutations || []);
    this.hysteresisLock =
      options.hysteresisLock instanceof HysteresisLock
        ? options.hysteresisLock
        : new HysteresisLock(options.hysteresisState || {});
  }

  /**
   * Updates the Flight Computer operating mode (`OFF | COACH | AUTO_PILOT`).
   * @param {string} mode
   * @returns {'OFF'|'COACH'|'AUTO_PILOT'}
   */
  setMode(mode) {
    this.mode = normalizeFlightMode(mode);
    return this.mode;
  }

  /**
   * Checks whether a non-crisis advisory nudge is currently in its 3-turn cooldown window.
   * Unconditional prefix-loss blocks and Haiku 100k cliff crises are exempt from cooldown.
   *
   * @param {number} currentTurn
   * @param {boolean} [isUnconditionalCrisis=false]
   * @returns {boolean}
   */
  isCooldownActive(currentTurn = 0, isUnconditionalCrisis = false) {
    if (isUnconditionalCrisis) return false;
    if (this.lastAdvisoryTurn === null) return false;
    return currentTurn - this.lastAdvisoryTurn < this.cooldownTurns;
  }

  /**
   * Evaluates a proposed cross-model switch (`PreModelSwitch` / `DET-08`).
   * When `prompt_cache.warm === true` and `cachedTokens > C*`, blocks main-thread downgrades
   * and recommends offloading routine exploration to an isolated `claude-haiku-5-5` subagent.
   *
   * @param {object} [request={}]
   * @param {string} [request.currentModel='claude-opus-5-5']
   * @param {string} [request.targetModel='claude-sonnet-5-5']
   * @param {number} [request.cachedTokens=0]
   * @param {number} [request.uncachedDeltaTokens=0]
   * @param {number} [request.expectedOutputTokens=1500]
   * @param {boolean} [request.cacheWarm=true]
   * @param {'5m'|'1h'} [request.cacheTtlTier='5m']
   * @param {number} [request.currentTurn=0]
   */
  evaluateModelSwitch(request = {}) {
    const breakEven = computeBreakEvenCachedTokens(request, this.options);
    const currentTurn = Number(request.currentTurn ?? 0);

    // Check HysteresisLock first
    if (
      this.hysteresisLock.locked &&
      this.hysteresisLock.pinnedModel &&
      breakEven.targetModel !== this.hysteresisLock.pinnedModel
    ) {
      const suppressed = isSilentOrOffMode(this.mode);
      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: suppressed ? 'allow' : 'deny',
        blocked: !suppressed,
        hysteresisLocked: true,
        breakEven,
        recommendedModel: this.hysteresisLock.pinnedModel,
        subagentDelegation: null,
        reason: `HysteresisLock active (${this.hysteresisLock.reason}): model pinned to ${this.hysteresisLock.pinnedModel} until active task completes.`
      };
    }

    if (isSilentOrOffMode(this.mode)) {
      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: 'allow',
        blocked: false,
        hysteresisLocked: false,
        breakEven,
        recommendedModel: breakEven.targetModel,
        subagentDelegation: null,
        reason: null
      };
    }

    if (breakEven.unknownModel) {
      const unknownList = breakEven.unknownModelIds.join(', ');
      const warning = `[Highbeam DET-08 Advisory] Prices are unknown for ${unknownList}; passing model switch through without price-based hold.`;
      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: 'allow',
        blocked: false,
        advisory: true,
        unknownModel: true,
        warning,
        hysteresisLocked: false,
        breakEven,
        recommendedModel: breakEven.targetModel,
        subagentDelegation: null,
        reason: warning
      };
    }

    const rawMinPenalty =
      request.minSwitchPenaltyUSD ?? this.options.minSwitchPenaltyUSD;
    const minSwitchPenaltyUSD =
      rawMinPenalty !== undefined && rawMinPenalty !== null && Number.isFinite(Number(rawMinPenalty))
        ? Math.max(0, Number(rawMinPenalty))
        : 0.02;
    const rawNotablePenalty =
      request.notableAllowPenaltyUSD ?? this.options.notableAllowPenaltyUSD;
    const notableAllowPenaltyUSD =
      rawNotablePenalty !== undefined &&
      rawNotablePenalty !== null &&
      Number.isFinite(Number(rawNotablePenalty))
        ? Math.max(0, Number(rawNotablePenalty))
        : minSwitchPenaltyUSD;
    const belowMinSwitchPenaltyUSD = Boolean(
      breakEven.shouldHoldModel && breakEven.coldWritePenaltyUSD < minSwitchPenaltyUSD
    );

    if (breakEven.shouldHoldModel && !belowMinSwitchPenaltyUSD) {
      // Unconditional prefix-loss protection: exempt from 3-turn advisory cooldown
      const writeMultLabel = breakEven.cacheTtlTier === '1h' ? '2.0x' : '1.25x';
      const subagentDelegation = {
        agentType: 'Explore',
        model: 'claude-haiku-5-5',
        maxContextTokens: 2000,
        turnCap: 12,
        tokenCap: 40000,
        reason: `Delegate routine file search/exploration to an isolated Explore/Task subagent on claude-haiku-5-5 (<2k context) while keeping main-thread ${breakEven.currentModel} cache warm.`
      };

      const paybackDetail =
        Number.isFinite(breakEven.paybackWarmRequests) && breakEven.paybackWarmRequests > 0
          ? `; payback ~${breakEven.paybackWarmRequests.toFixed(1)} post-switch warm requests (~${breakEven.paybackTurns.toFixed(1)} turns) at +$${breakEven.perTurnPostSwitchSavingUSD.toFixed(4)}/turn post-switch saving`
          : '';
      const horizonDetail =
        breakEven.postSwitchRemainingTurns !== null
          ? `; estimated post-switch horizon ~${breakEven.postSwitchRemainingTurns} turns`
          : '';
      const thresholdClause =
        breakEven.postSwitchRemainingTurns !== null &&
        Number.isFinite(breakEven.horizonMaxCachedTokens)
          ? `exceeds horizon break-even C_max = ${breakEven.horizonMaxCachedTokens.toLocaleString()} tokens and `
          : '';
      const reasonText =
        `[DET-08 Warm KV-Cache Hold] Switching from ${breakEven.currentModel} to ${breakEven.targetModel} ` +
        `with ${breakEven.cachedTokens.toLocaleString()} warm cached tokens ${thresholdClause}incurs a ` +
        `+$${breakEven.coldWritePenaltyUSD.toFixed(4)} cold ${writeMultLabel} prefix rewrite penalty` +
        `${paybackDetail}${horizonDetail}. ` +
        `Keep main thread on ${breakEven.currentModel} or confirm if this session will run past payback ` +
        `(in headless -p/SDK, override via "DET-08": "warn" in .attention-horizon/config.json or pass expectedRemainingTurns).`;

      // In COACH mode (default), remain 100% advisory and non-blocking unless strictBlock is explicitly set
      if (this.mode === FLIGHT_MODES.COACH && !request.strictBlock && !this.options.strictBlock) {
        return {
          detectorId: 'DET-08',
          mode: this.mode,
          decision: 'allow',
          blocked: false,
          advisory: true,
          belowMinSwitchPenaltyUSD: false,
          minSwitchPenaltyUSD,
          notableAllowPenaltyUSD,
          notableAllowNote: null,
          hysteresisLocked: false,
          breakEven,
          recommendedModel: breakEven.currentModel,
          subagentDelegation,
          reason: reasonText
        };
      }

      // In AUTO_PILOT mode, actively gate the destructive model switch ('ask' or 'deny')
      const autoDecision =
        request.autoPilotDecision || this.options.autoPilotDecision || 'deny';

      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: autoDecision,
        blocked: true,
        advisory: false,
        belowMinSwitchPenaltyUSD: false,
        minSwitchPenaltyUSD,
        notableAllowPenaltyUSD,
        notableAllowNote: null,
        hysteresisLocked: false,
        breakEven,
        recommendedModel: breakEven.currentModel,
        subagentDelegation,
        reason: reasonText
      };
    }

    // Advisory evaluation when cache is cold, below C*, suppressed below minSwitchPenaltyUSD, or capability upshift
    const cooldownSuppressed = this.isCooldownActive(currentTurn, false);
    if (!cooldownSuppressed && this.mode === FLIGHT_MODES.COACH) {
      this.lastAdvisoryTurn = currentTurn;
    }

    const isNotablePenalty = Boolean(
      !belowMinSwitchPenaltyUSD &&
        breakEven.currentModel !== breakEven.targetModel &&
        !breakEven.isCapabilityUpshift &&
        breakEven.cacheWarm &&
        breakEven.coldWritePenaltyUSD > 0 &&
        breakEven.coldWritePenaltyUSD >= notableAllowPenaltyUSD
    );

    const rawTurnsForDisplay =
      request.turnsCompleted ?? request.currentTurn ?? breakEven.turnsCompleted;
    const netDollarDisplaySuppressed = Boolean(
      request.suppressNetDollarDisplay ??
        (rawTurnsForDisplay !== undefined &&
          rawTurnsForDisplay !== null &&
          Number.isFinite(Number(rawTurnsForDisplay)) &&
          Number(rawTurnsForDisplay) < 5)
    );

    let notableAllowNote = null;
    if (isNotablePenalty) {
      const paybackFragment =
        Number.isFinite(breakEven.paybackWarmRequests) && breakEven.paybackWarmRequests > 0
          ? `, pays back in ~${breakEven.paybackWarmRequests.toFixed(1)} post-switch warm requests (~${breakEven.paybackTurns.toFixed(1)} turns)`
          : '';
      const cMaxFragment =
        breakEven.postSwitchRemainingTurns !== null && breakEven.horizonMaxCachedTokens !== null
          ? breakEven.horizonMaxCachedTokens === Infinity
            ? '; horizon limit C_max = unbounded'
            : `; horizon limit C_max = ${breakEven.horizonMaxCachedTokens.toLocaleString()} tokens`
          : '';
      const horizonFragment =
        breakEven.postSwitchRemainingTurns !== null && Number.isFinite(breakEven.horizonNetSavingsUSD)
          ? netDollarDisplaySuppressed
            ? ` (post-switch horizon ~${breakEven.postSwitchRemainingTurns} turns, <5 observed turns: net USD omitted${cMaxFragment})`
            : ` (post-switch horizon ~${breakEven.postSwitchRemainingTurns} turns, net ${breakEven.horizonNetSavingsUSD >= 0 ? '+$' : '-$'}${Math.abs(breakEven.horizonNetSavingsUSD).toFixed(4)}${cMaxFragment})`
          : '';
      const displayedPerTurnSaving =
        breakEven.contextGrowthPerTurn > 0 &&
        breakEven.postSwitchRemainingTurns !== null &&
        breakEven.postSwitchRemainingTurns > 1
          ? breakEven.averagePostSwitchSavingUSD
          : breakEven.perTurnPostSwitchSavingUSD;
      notableAllowNote =
        `[Highbeam] Allowing ${breakEven.currentModel} -> ${breakEven.targetModel}: ` +
        `+$${breakEven.coldWritePenaltyUSD.toFixed(4)} cold ${breakEven.writeMultiplierLabel} cache rewrite penalty, ` +
        `saves ~$${displayedPerTurnSaving.toFixed(4)}/turn${paybackFragment}${horizonFragment}.`;
    }

    const allowReason = belowMinSwitchPenaltyUSD
      ? `Model switch to ${breakEven.targetModel} permitted silently (cold write penalty +$${breakEven.coldWritePenaltyUSD.toFixed(4)} < minSwitchPenaltyUSD $${minSwitchPenaltyUSD.toFixed(4)}).`
      : breakEven.isCapabilityUpshift && breakEven.currentModel !== breakEven.targetModel
        ? `Capability upshift from ${breakEven.currentModel} to ${breakEven.targetModel} permitted without warm-cache hold.`
        : breakEven.postSwitchRemainingTurns !== null &&
            (breakEven.horizonMaxCachedTokens === Infinity ||
              (breakEven.cachedTokens > breakEven.breakEvenTokens &&
                breakEven.postSwitchRemainingTurns >= breakEven.paybackTurns))
          ? `Model switch to ${breakEven.targetModel} permitted under horizon payback (${breakEven.postSwitchRemainingTurns} post-switch turns >= ~${breakEven.paybackWarmRequests} warm requests (~${breakEven.paybackTurns} turns); horizon limit ${breakEven.horizonMaxCachedTokens === Infinity ? 'C_max = unbounded' : `C_max = ${breakEven.horizonMaxCachedTokens.toLocaleString()} tokens`}${netDollarDisplaySuppressed ? '' : `; projected net saving ${breakEven.horizonNetSavingsUSD >= 0 ? '+$' : '-$'}${Math.abs(breakEven.horizonNetSavingsUSD).toFixed(4)}`}).`
          : `Model switch to ${breakEven.targetModel} immediate switch-turn output credit offsets cold rewrite (cached ${breakEven.cachedTokens.toLocaleString()} <= ${breakEven.breakEvenTokens.toLocaleString()} tokens).`;

    return {
      detectorId: 'DET-08',
      mode: this.mode,
      decision: 'allow',
      blocked: false,
      advisory: false,
      belowMinSwitchPenaltyUSD,
      minSwitchPenaltyUSD,
      notableAllowPenaltyUSD,
      notableAllowNote,
      netDollarDisplaySuppressed,
      cooldownSuppressed,
      hysteresisLocked: false,
      breakEven,
      recommendedModel: breakEven.targetModel,
      subagentDelegation: null,
      reason: allowReason
    };
  }

  /**
   * Evaluates a mid-session top-level `effort`, `thinking`, `system_prompt`, or `mcp_tools`
   * mutation (`DET-09`). Because Claude Code does not expose a native `/effort` pre-hook,
   * this acts as an advisory/post-hoc warning or host-mediated `PostCompactMutationQueue` entry
   * rather than an interactive `/effort` TUI blocker.
   *
   * @param {object} [mutationRequest={}]
   * @param {'effort'|'thinking'|'speed'|'system_prompt'|'mcp_tools'} [mutationRequest.type='effort']
   * @param {string} [mutationRequest.key]
   * @param {any} mutationRequest.value
   * @param {string} [mutationRequest.currentModel='claude-opus-5-5']
   * @param {number} [mutationRequest.cachedTokens=0]
   * @param {boolean} [mutationRequest.cacheWarm=true]
   * @param {'5m'|'1h'} [mutationRequest.cacheTtlTier='5m']
   */
  interceptTopLevelMutation(mutationRequest = {}) {
    const explicitModel = mutationRequest.currentModel ?? mutationRequest.modelId;
    const targetFilePath = String(
      mutationRequest.filePath || mutationRequest.file_path || mutationRequest.path || ''
    ).trim();

    if (
      targetFilePath &&
      (!mutationRequest.type || mutationRequest.type === 'file_edit') &&
      !isPrefixInstructionFile(targetFilePath)
    ) {
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        avoidedRewritePenaltyUSD: 0,
        queueSize: this.mutationQueue.size(),
        reason: null
      };
    }

    const mutationType =
      mutationRequest.type || (targetFilePath ? 'system_prompt' : 'effort');

    if (explicitModel !== undefined && !isKnownCatalogModel(explicitModel, this.options)) {
      const effortCap = mutationType === 'effort'
        ? getEffortMutationCacheCapability(explicitModel, this.options)
        : null;
      if (isSilentOrOffMode(this.mode)) {
        return {
          detectorId: 'DET-09',
          triggered: false,
          queued: false,
          decision: 'allow',
          unknownModel: true,
          effortCacheCapability: effortCap,
          avoidedRewritePenaltyUSD: null,
          queueSize: this.mutationQueue.size(),
          reason: null
        };
      }
      const effortClause =
        mutationType === 'effort' ? ' (effort cache behavior unverified for this model)' : '';
      const warning = `[Highbeam DET-09 Advisory] Prices are unknown for ${String(explicitModel)}${effortClause}; passing mutation through without price-based hold.`;
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        advisory: true,
        unknownModel: true,
        effortCacheCapability: effortCap,
        warning,
        avoidedRewritePenaltyUSD: null,
        queueSize: this.mutationQueue.size(),
        reason: warning
      };
    }

    const rawModel = explicitModel || 'claude-opus-5-5';
    const modelId = normalizeModelId(rawModel);
    const effortCap =
      mutationType === 'effort' ? getEffortMutationCacheCapability(modelId, this.options) : null;

    if (effortCap && effortCap.invalidatesCache === 'no') {
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        advisory: false,
        effortCacheCapability: effortCap,
        avoidedRewritePenaltyUSD: 0,
        queueSize: this.mutationQueue.size(),
        reason: null
      };
    }

    const cachedTokens = Math.max(0, Number(mutationRequest.cachedTokens ?? 0));
    const hasTtlField =
      mutationRequest.ttlRemainingSeconds !== undefined &&
      mutationRequest.ttlRemainingSeconds !== null;
    const ttlRemainingSeconds = hasTtlField ? Number(mutationRequest.ttlRemainingSeconds) : null;
    const ttlExpired = hasTtlField && ttlRemainingSeconds <= 0;

    const cacheWarm = ttlExpired
      ? false
      : mutationRequest.cacheWarm !== undefined
        ? Boolean(mutationRequest.cacheWarm)
        : cachedTokens > 0;

    const ttlTier = mutationRequest.cacheTtlTier === '1h' ? '1h' : '5m';
    const totalPromptTokens = Math.max(cachedTokens, computeTotalPromptTokens(mutationRequest));
    const rates = resolveEffectiveRates(rawModel, totalPromptTokens, this.options);
    const writeRate = ttlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;

    if (isSilentOrOffMode(this.mode) || !cacheWarm || cachedTokens === 0) {
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        effortCacheCapability: effortCap,
        avoidedRewritePenaltyUSD: 0,
        queueSize: this.mutationQueue.size(),
        reason: 'Cache is cold or router is OFF/SILENT; top-level mutation may apply immediately.'
      };
    }

    const avoidedRewritePenaltyUSD = Number(
      ((cachedTokens / 1_000_000) * (writeRate - rates.readPer1M)).toFixed(6)
    );

    const enableDet09Threshold = Boolean(
      mutationRequest.enableDet09Threshold ?? this.options.enableDet09Threshold ?? false
    );
    const det09BreakEven = computeDet09BreakEvenTokens(
      {
        ...mutationRequest,
        currentModel: rawModel,
        cachedTokens,
        cacheTtlTier: ttlTier,
        totalPromptTokens
      },
      this.options
    );

    if (enableDet09Threshold && cachedTokens <= det09BreakEven.breakEvenTokens) {
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        belowBreakEvenThreshold: true,
        effortCacheCapability: effortCap,
        breakEvenTokens: det09BreakEven.breakEvenTokens,
        avoidedRewritePenaltyUSD,
        queueSize: this.mutationQueue.size(),
        reason:
          `Top-level mutation within DET-09 break-even threshold ` +
          `(cached ${cachedTokens.toLocaleString()} <= C*_mut ${det09BreakEven.breakEvenTokens.toLocaleString()} tokens).`
      };
    }

    const effortLabel =
      effortCap?.invalidatesCache === 'unknown'
        ? ' (unverified for this model)'
        : effortCap?.provenance
          ? ` (${effortCap.provenance})`
          : '';
    const entry = this.mutationQueue.enqueue({
      type: mutationType,
      key: mutationRequest.key || targetFilePath || mutationType,
      value: mutationRequest.value,
      cachedTokens,
      avoidedRewritePenaltyUSD,
      reason:
        `[DET-09 Top-Level Mutation Deferred] Mutating top-level ${mutationType}${effortLabel} ` +
        `while ${cachedTokens.toLocaleString()} tokens are warm on ${modelId} would invalidate the ` +
        `Anthropic prompt cache prefix (+$${avoidedRewritePenaltyUSD.toFixed(4)} rewrite spike). ` +
        `Queued in PostCompactMutationQueue to apply after next compaction.`
    });

    return {
      detectorId: 'DET-09',
      triggered: true,
      queued: true,
      decision: 'defer',
      effortCacheCapability: effortCap,
      entry,
      breakEvenTokens: enableDet09Threshold ? det09BreakEven.breakEvenTokens : 0,
      avoidedRewritePenaltyUSD,
      queueSize: this.mutationQueue.size(),
      reason: entry.reason
    };
  }
}

/**
 * Computes the `DET-09` warm-prefix mutation break-even threshold `C*_mut` (`C1d`):
 *   C*_mut = (Delta_O * P_out) / (P_write - P_read)
 * Below `C*_mut`, the one-time cold prefix rewrite penalty `(C / 1M) * (P_write - P_read)`
 * is smaller than the per-turn output-equivalent cost of deferring the mutation.
 *
 * @param {object} [params={}]
 * @param {object} [options={}]
 */
export function computeDet09BreakEvenTokens(params = {}, options = {}) {
  const explicitMin = params.det09MinCachedTokens ?? options.det09MinCachedTokens;
  const rawModel = params.currentModel || params.modelId || 'claude-opus-5-5';
  const ttlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';
  const totalPromptTokens = Math.max(
    Number(params.cachedTokens ?? 0),
    computeTotalPromptTokens(params)
  );
  const rates = resolveEffectiveRates(rawModel, totalPromptTokens, options);
  if (rates.unknownModel) {
    return {
      unknownModel: true,
      breakEvenTokens: null,
      outputDeltaTokens: null,
      writeRatePer1M: null,
      readRatePer1M: null,
      outputRatePer1M: null
    };
  }
  const writeRate = ttlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;
  const denominator = writeRate - rates.readPer1M;

  if (explicitMin !== undefined && explicitMin !== null && Number.isFinite(Number(explicitMin))) {
    return {
      breakEvenTokens: Math.max(0, Math.round(Number(explicitMin))),
      outputDeltaTokens: null,
      writeRatePer1M: writeRate,
      readRatePer1M: rates.readPer1M,
      outputRatePer1M: rates.outputPer1M
    };
  }

  const effortTable = BUILTIN_CATALOG.effortExpectedOutputTokens || {};
  const currEff = String(params.currentEffort || '').toLowerCase().trim();
  const nextEff = String(params.value || '').toLowerCase().trim();
  let outputDeltaTokens = Number(
    params.det09OutputDeltaTokens ?? options.det09OutputDeltaTokens ?? NaN
  );
  if (!Number.isFinite(outputDeltaTokens) || outputDeltaTokens < 0) {
    if (
      effortTable[currEff] !== undefined &&
      effortTable[nextEff] !== undefined &&
      effortTable[currEff] !== effortTable[nextEff]
    ) {
      outputDeltaTokens = Math.abs(effortTable[nextEff] - effortTable[currEff]);
    } else {
      outputDeltaTokens = DEFAULT_DET09_OUTPUT_DELTA_TOKENS;
    }
  }

  const breakEvenTokens =
    denominator <= 0
      ? Infinity
      : Math.max(0, Math.round((outputDeltaTokens * rates.outputPer1M) / denominator));

  return {
    breakEvenTokens,
    outputDeltaTokens,
    writeRatePer1M: writeRate,
    readRatePer1M: rates.readPer1M,
    outputRatePer1M: rates.outputPer1M
  };
}

/**
 * Convenience functional wrapper for `DET-09` Warm-Prefix Mutation Fence (`PostCompactMutationQueue`).
 *
 * @param {object} [mutationRequest={}]
 * @param {object} [options={}]
 */
export function evaluateDet09PrefixMutationFence(mutationRequest = {}, options = {}) {
  const router = new CacheGravityRouter(options);
  return router.interceptTopLevelMutation(mutationRequest);
}

/**
 * Convenience functional wrapper for `DET-08` `PreModelSwitch` evaluation.
 * @param {object} [request={}]
 * @param {object} [options={}]
 */
export function evaluatePreModelSwitch(request = {}, options = {}) {
  const router = new CacheGravityRouter(options);
  return router.evaluateModelSwitch(request);
}

export default {
  FLIGHT_MODES,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  DEFAULT_DET09_OUTPUT_DELTA_TOKENS,
  DEFAULT_ADVISORY_COOLDOWN_TURNS,
  MODEL_EFFORT_CACHE_CAPABILITIES,
  getEffortMutationCacheCapability,
  EMPIRICAL_SESSION_API_CALL_PRIOR,
  estimateEmpiricalRemainingTurns,
  normalizeFlightMode,
  isSilentOrOffMode,
  isPrefixInstructionFile,
  resolveNaturalDownshiftPeer,
  computeBreakEvenCachedTokens,
  computeDet09BreakEvenTokens,
  evaluatePreModelSwitch,
  evaluateDet09PrefixMutationFence,
  PostCompactMutationQueue,
  HysteresisLock,
  CacheGravityRouter
};
