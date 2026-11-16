/**
 * @file hooks/handlers/pre-model-switch.mjs
 * Tier 2 Command Hook handler for `PreModelSwitch` (`DET-08` Warm KV-Cache Cross-Model Switch Guard).
 */

import { fs, path, os, readJsonSafe, writeJsonAtomic } from '../../src/utils/nodeIo.mjs';
import {
  DEFAULT_RPT_SHRINKAGE_PRIOR,
  isRealHumanUserTranscriptEntry,
  readSessionCalibration,
  shrinkRollingOutputEstimate,
  shrinkRollingRequestsPerTurn,
  computeRollingMedianFloat
} from '../../src/utils/sessionCalibration.mjs';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import {
  computeTotalPromptTokens,
  isKnownCatalogModel,
  normalizeModelId
} from '../../src/core-isomorphic/config/catalogLoader.mjs';
import {
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { CacheGravityRouter } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { recordInterventionSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { requireProFeature } from '../../src/core/pro_license.mjs';
import { recordShadowAutoMiss } from '../../src/core/shadow_auto_ledger.mjs';
import { recordPreModelSwitchEvent } from '../../src/utils/modelSwitchTelemetry.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitHardBlockStderr,
  exitWithStdoutJson
} from './hookIo.mjs';

const PRIOR_CACHE_TTL_MS = 3_600_000;

export const MIN_LOCAL_RPT_PRIOR_SESSIONS = 3;

function isExcludedBenchmarkTranscript(filePath = '', content = '') {
  const normPath = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (
    normPath.includes('model-switch-benchmark') ||
    normPath.includes('smart-compact') ||
    normPath.includes('e2e_harness') ||
    normPath.includes('ctxtop-model-switch')
  ) {
    return true;
  }
  if (typeof content === 'string' && content.includes('Benchmark-Run-Salt:')) {
    return true;
  }
  return false;
}

/**
 * Samples recent local Claude Code session assistant-turn counts and requests/turn (read-only,
 * bounded to 50 files, deduplicated by `message.id`, 1h disk cache under
 * `~/.attention-horizon/cache/ah_session_prior.json`).
 * Excludes the current session (`excludeSessionId` / `excludeTranscriptPath`) and benchmark/harness
 * transcripts (`excludeBenchmarkSessions !== false`), requiring `>= 3` qualifying sessions for
 * `medianRequestsPerTurn`.
 *
 * @param {object} [options={}]
 * @returns {{ apiCounts: number[], medianRequestsPerTurn: number | null, sessionCount: number } | null}
 */
export function loadLocalClaudeSessionPriors(options = {}) {
  if (Array.isArray(options.historicalSessionApiCalls)) {
    return {
      apiCounts: options.historicalSessionApiCalls,
      medianRequestsPerTurn:
        Number.isFinite(Number(options.historicalSessionRequestsPerTurn))
          ? Number(options.historicalSessionRequestsPerTurn)
          : null,
      sessionCount: options.historicalSessionApiCalls.length
    };
  }
  const home =
    options.homeDir ||
    globalThis.process?.env?.HOME ||
    globalThis.process?.env?.USERPROFILE ||
    os.homedir();
  const cachePath = path.join(home, '.attention-horizon', 'cache', 'ah_session_prior.json');
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const excludeSessionId =
    options.excludeSessionId && options.excludeSessionId !== 'default'
      ? String(options.excludeSessionId).trim()
      : null;
  const excludeTranscriptPathNorm = options.excludeTranscriptPath
    ? path.resolve(String(options.excludeTranscriptPath)).replace(/\\/g, '/').toLowerCase()
    : null;
  const excludeBenchmarks = options.excludeBenchmarkSessions !== false;

  const cached = readJsonSafe(cachePath, null, options);
  if (
    cached &&
    Array.isArray(cached.sessions) &&
    Number.isFinite(cached.sampledAtMs) &&
    nowMs - cached.sampledAtMs < PRIOR_CACHE_TTL_MS
  ) {
    const filtered = cached.sessions.filter((s) => {
      if (excludeSessionId && s.sessionId === excludeSessionId) return false;
      if (excludeTranscriptPathNorm && s.normPath === excludeTranscriptPathNorm) return false;
      if (excludeBenchmarks && s.isBenchmark) return false;
      return true;
    });
    if (filtered.length >= 1) {
      const apiCounts = filtered.map((s) => s.assistantTurns);
      const rpts = filtered.map((s) => s.rpt).filter((r) => Number.isFinite(r) && r >= 1);
      return {
        apiCounts,
        medianRequestsPerTurn:
          rpts.length >= MIN_LOCAL_RPT_PRIOR_SESSIONS
            ? computeRollingMedianFloat(rpts, rpts.length)
            : null,
        sessionCount: apiCounts.length
      };
    }
    return null;
  }

  try {
    const ccProjects = path.join(home, '.claude', 'projects');
    if (!fs.existsSync(ccProjects)) return null;

    const jsonlFiles = [];
    const queue = [ccProjects];
    while (queue.length > 0 && jsonlFiles.length < 150) {
      const dir = queue.shift();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'subagents') queue.push(full);
        } else if (entry.name.endsWith('.jsonl')) {
          const st = fs.statSync(full);
          if (st.size >= 512 && st.size <= 5_000_000) {
            jsonlFiles.push({ path: full, mtimeMs: st.mtimeMs });
          }
        }
      }
    }
    jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const allSessions = [];
    for (const item of jsonlFiles.slice(0, 50)) {
      let fd = null;
      try {
        const normPath = path.resolve(item.path).replace(/\\/g, '/').toLowerCase();
        const fileSessionId = path.basename(item.path, '.jsonl');
        fd = fs.openSync(item.path, 'r');
        const txt = fs.readFileSync(fd, 'utf8');
        const isBenchmark = isExcludedBenchmarkTranscript(item.path, txt);
        const assistantMsgIds = new Set();
        let humanTurnCount = 0;
        let idx = 0;
        for (const line of txt.split(/\r?\n/)) {
          idx += 1;
          if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
          try {
            const obj = JSON.parse(line);
            if (isRealHumanUserTranscriptEntry(obj)) {
              humanTurnCount += 1;
            } else if (obj?.type === 'assistant') {
              assistantMsgIds.add(obj?.message?.id || `line_${idx}`);
            }
          } catch {
            if (line.includes('"type":"assistant"')) assistantMsgIds.add(`raw_${idx}`);
          }
        }
        const assistantTurns = assistantMsgIds.size;
        if (assistantTurns >= 2) {
          const rpt =
            humanTurnCount >= 1
              ? Math.max(1, Number((assistantTurns / humanTurnCount).toFixed(4)))
              : null;
          allSessions.push({
            sessionId: fileSessionId,
            normPath,
            isBenchmark,
            assistantTurns,
            rpt
          });
        }
      } catch {
        // Ignore unreadable session file
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close failure
          }
        }
      }
    }
    const filtered = allSessions.filter((s) => {
      if (excludeSessionId && s.sessionId === excludeSessionId) return false;
      if (excludeTranscriptPathNorm && s.normPath === excludeTranscriptPathNorm) return false;
      if (excludeBenchmarks && s.isBenchmark) return false;
      return true;
    });
    const apiCounts = filtered.map((s) => s.assistantTurns);
    const sessionRpts = filtered.map((s) => s.rpt).filter((r) => Number.isFinite(r) && r >= 1);
    const medianRequestsPerTurn =
      sessionRpts.length >= MIN_LOCAL_RPT_PRIOR_SESSIONS
        ? computeRollingMedianFloat(sessionRpts, sessionRpts.length)
        : null;
    if (allSessions.length >= 1) {
      writeJsonAtomic(
        cachePath,
        {
          sampledAtMs: nowMs,
          sessions: allSessions,
          apiCounts,
          medianRequestsPerTurn,
          sessionCount: apiCounts.length
        },
        options
      );
    }
    if (apiCounts.length >= 1) {
      return { apiCounts, medianRequestsPerTurn, sessionCount: apiCounts.length };
    }
  } catch {
    // Fallback to built-in 496-session prior
  }
  return null;
}

/**
 * Backward-compatible accessor returning `apiCounts` once >= 5 local sessions exist
 * (or any explicit `options.historicalSessionApiCalls` override).
 * @param {object} [options={}]
 * @returns {number[] | null}
 */
export function loadLocalClaudeSessionApiCalls(options = {}) {
  if (Array.isArray(options.historicalSessionApiCalls)) {
    return options.historicalSessionApiCalls;
  }
  const priors = loadLocalClaudeSessionPriors(options);
  return Array.isArray(priors?.apiCounts) && priors.apiCounts.length >= 5 ? priors.apiCounts : null;
}

/**
 * Evaluates a `PreModelSwitch` event against `CacheGravityRouter` break-even threshold `C*`.
 * @param {object} event
 * @param {object} [options={}]
 */
export function runPreModelSwitchHook(event = {}, options = {}) {
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const det08Override = resolveDetectorOverride('DET-08', horizonConfig);

  if (det08Override === 'off') {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: {
        detectorId: null,
        triggered: false,
        decision: 'allow',
        blocked: false,
        overriddenByConfig: 'off',
        suppressedDetectorId: 'DET-08',
        reason: null
      }
    };
  }

  const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
  const configHasDiskSource = Boolean(
    horizonConfig?.sources?.projectLoaded || horizonConfig?.sources?.globalLoaded
  );
  const rawEffectiveMode =
    event.mode ||
    options.mode ||
    options.telemetryState?.flightMode ||
    (configHasDiskSource
      ? horizonConfig.flightMode
      : liveState?.flightMode || horizonConfig?.flightMode || 'COACH');
  const proAutoPilot =
    rawEffectiveMode === 'AUTO_PILOT' ? requireProFeature('auto_pilot_locks', options) : { allowed: true };
  const effectiveMode =
    rawEffectiveMode === 'AUTO_PILOT' && !proAutoPilot.allowed ? 'COACH' : rawEffectiveMode;

  const rawRemainingTurns =
    event.expected_remaining_turns ??
    event.expectedRemainingTurns ??
    options.expectedRemainingTurns ??
    horizonConfig?.expectedRemainingTurns;
  const useEmpiricalHorizonPrior = Boolean(
    event.use_empirical_horizon_prior ??
      event.useEmpiricalHorizonPrior ??
      options.useEmpiricalHorizonPrior ??
      horizonConfig?.useEmpiricalHorizonPrior
  );
  const sessionCal =
    options.useSessionCalibration === false
      ? null
      : readSessionCalibration(sessionId, event, cwdOptions);
  const turnsCompleted = Number(
    event.current_turn ??
      event.currentTurn ??
      (sessionCal?.turnsCompleted > 0 ? sessionCal.turnsCompleted : undefined) ??
      liveState?.turnsCompleted ??
      0
  );
  const localPriorsOptions = {
    ...cwdOptions,
    excludeSessionId: sessionId,
    excludeTranscriptPath:
      event.transcript_path || event.transcriptPath || sessionCal?.transcriptPath || null
  };
  const localPriors =
    options.useLocalRptPrior !== false &&
    (options.homeDir ||
      options.cliInvocation ||
      options.useLocalRptPrior === true ||
      useEmpiricalHorizonPrior ||
      Boolean(sessionCal))
      ? loadLocalClaudeSessionPriors(localPriorsOptions)
      : null;
  const localSurvivalApiCalls =
    localPriors && Array.isArray(localPriors.apiCounts) && localPriors.apiCounts.length >= 5
      ? localPriors.apiCounts
      : null;
  const historicalSessionApiCalls =
    useEmpiricalHorizonPrior && (rawRemainingTurns === undefined || rawRemainingTurns === null)
      ? (localSurvivalApiCalls ?? loadLocalClaudeSessionApiCalls(localPriorsOptions))
      : options.historicalSessionApiCalls;

  const router =
    options.router ||
    new CacheGravityRouter({
      ...cwdOptions,
      ...(historicalSessionApiCalls ? { historicalSessionApiCalls } : {}),
      mode: effectiveMode,
      strictBlock:
        det08Override === 'block' ? true : (event.strictBlock ?? options.strictBlock)
    });

  const shouldPersistBreaker =
    options.persistState !== false &&
    Boolean(
      options.persistState === true ||
        options.cliInvocation ||
        options.breakerStatePath ||
        event.persistState ||
        event.cwd
    );
  const breakerSnap = shouldPersistBreaker
    ? readBreakerStateSnapshot(sessionId, cwdOptions)
    : null;
  const justCompacted = Boolean(
    event.just_compacted ?? event.justCompacted ?? breakerSnap?.justCompacted
  );

  const currentModel =
    event.current_model ||
    event.currentModel ||
    event.from_model ||
    event.fromModel ||
    liveState.modelId ||
    'claude-opus-5-5';
  const targetModel =
    event.target_model ||
    event.targetModel ||
    event.to_model ||
    event.toModel ||
    event.requested_model ||
    event.requestedModel ||
    event.model ||
    'claude-sonnet-5-5';
  const explicitCachedTokens =
    event.cached_tokens ??
    event.cachedTokens ??
    event.context_tokens ??
    event.contextTokens;
  const cachedTokens = Number(
    explicitCachedTokens ??
      (justCompacted
        ? (liveState.contextWindow?.cacheReadTokens ?? liveState.contextWindow?.cachedTokens ?? 0)
        : (liveState.contextWindow?.cachedTokens ?? 0))
  );
  const explicitUncachedWrite =
    event.uncached_write_tokens ?? event.uncachedWriteTokens;
  const uncachedWriteTokens = Math.max(
    0,
    Number(
      explicitUncachedWrite ??
        (justCompacted ? (liveState.contextWindow?.cacheCreationTokens ?? 0) : 0)
    )
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rawExpiresAt = liveState?.promptCache?.expiresAt;
  const liveCacheExpired =
    rawExpiresAt !== null &&
    rawExpiresAt !== undefined &&
    Number.isFinite(Number(rawExpiresAt)) &&
    Number(rawExpiresAt) > 0 &&
    nowMs >= Number(rawExpiresAt);
  const explicitCacheWarm =
    event.cache_warm ??
    event.cacheWarm ??
    event.prompt_cache_warm ??
    event.promptCacheWarm;
  const cacheWarm =
    explicitCacheWarm !== undefined
      ? Boolean(explicitCacheWarm)
      : liveCacheExpired
        ? false
        : justCompacted && cachedTokens === 0
          ? false
          : Boolean(liveState.promptCache?.warm);

  const uncachedDeltaTokens = Number(
    event.uncached_delta_tokens ?? event.uncachedDeltaTokens ?? 0
  );
  const rawTier =
    event.cache_ttl_tier ??
    event.cacheTtlTier ??
    event.cache_ttl ??
    event.cacheTtl ??
    event.prompt_cache?.ttl ??
    liveState.promptCache?.ttlTier ??
    '5m';
  const cacheTtlTier =
    rawTier === '1h' || rawTier === '3600s' || Number(rawTier) > 300 ? '1h' : '5m';
  const usageSource =
    event.usage || event.context_window?.current_usage || liveState.contextWindow || {};
  const totalPromptTokens = Math.max(
    cachedTokens + uncachedDeltaTokens + uncachedWriteTokens,
    computeTotalPromptTokens(event),
    computeTotalPromptTokens(usageSource)
  );

  const isNativePreModelSwitch = Boolean(
    event.hook_event_name === 'PreModelSwitch' ||
      event.from_model !== undefined ||
      event.to_model !== undefined ||
      event.fromModel !== undefined ||
      event.toModel !== undefined ||
      options.nativeHook === true
  );
  const resolvedAutoPilotDecision =
    det08Override === 'block'
      ? 'deny'
      : (event.autoPilotDecision ??
          options.autoPilotDecision ??
          horizonConfig?.autoPilotDecision ??
          (isNativePreModelSwitch ? 'ask' : 'deny'));

  const apiCallsCompletedRaw =
    event.api_calls_completed ??
    event.apiCallsCompleted ??
    sessionCal?.apiCallsCompleted;
  const apiCallsCompleted =
    apiCallsCompletedRaw !== undefined &&
    apiCallsCompletedRaw !== null &&
    Number.isFinite(Number(apiCallsCompletedRaw))
      ? Math.max(0, Number(apiCallsCompletedRaw))
      : undefined;
  const explicitRptRaw =
    event.requests_per_turn ?? event.requestsPerTurn ?? options.requestsPerTurn;
  const rptShrinkageMinTurns = Number(
    options.rptShrinkageMinTurns ?? horizonConfig?.thresholds?.rptShrinkageMinTurns ?? 5
  );
  const rptShrinkagePriorDefault = Number(
    options.rptShrinkagePrior ??
      horizonConfig?.thresholds?.rptShrinkagePrior ??
      DEFAULT_RPT_SHRINKAGE_PRIOR
  );
  let requestsPerTurn;
  let rptEstimateSource = `placeholder_rpt_prior_${rptShrinkagePriorDefault}`;
  let rptSampleSize = 0;
  let rawRollingMedianRequestsPerTurn = sessionCal?.rollingMedianRequestsPerTurn ?? null;
  let rawCumulativeRequestsPerTurn = sessionCal?.requestsPerTurn ?? null;
  let rptShrinkageWeight = 0;
  let rptPriorUsed = rptShrinkagePriorDefault;
  let isPlaceholderRptPrior = true;
  let rptTurnsAgree = false;
  let rptEffectiveMinTrustedTurns = rptShrinkageMinTurns;

  if (
    explicitRptRaw !== undefined &&
    explicitRptRaw !== null &&
    Number.isFinite(Number(explicitRptRaw)) &&
    Number(explicitRptRaw) > 0
  ) {
    requestsPerTurn = Number(explicitRptRaw);
    rptEstimateSource = 'explicit';
    rptSampleSize = Number(sessionCal?.rptSampleSize ?? sessionCal?.turnsCompleted ?? 0);
    rptShrinkageWeight = 1;
    rptPriorUsed = null;
    isPlaceholderRptPrior = false;
    rptTurnsAgree = false;
    rptEffectiveMinTrustedTurns = rptShrinkageMinTurns;
  } else if (sessionCal) {
    const localMedianRpt =
      options.historicalSessionRequestsPerTurn ?? localPriors?.medianRequestsPerTurn ?? null;
    const hasLocalRptPrior =
      options.useLocalRptPrior !== false &&
      Number.isFinite(Number(localMedianRpt)) &&
      Number(localMedianRpt) >= 1;
    const rawRollingRpt =
      sessionCal.rollingMedianRequestsPerTurn ?? sessionCal.requestsPerTurn ?? null;
    const sampleTurns = Number(
      sessionCal.rptSampleSize ??
        (Array.isArray(sessionCal.recentTurnRequestCounts)
          ? sessionCal.recentTurnRequestCounts.length
          : sessionCal.turnsCompleted || 0)
    );
    const shrunkRpt = shrinkRollingRequestsPerTurn(rawRollingRpt, sampleTurns, {
      minTrustedTurns: rptShrinkageMinTurns,
      priorRequestsPerTurn: hasLocalRptPrior ? localMedianRpt : rptShrinkagePriorDefault,
      priorSource: hasLocalRptPrior ? 'local_transcripts' : 'placeholder',
      recentTurnRequestCounts: sessionCal.recentTurnRequestCounts
    });
    requestsPerTurn = shrunkRpt.expectedRequestsPerTurn;
    rptEstimateSource = shrunkRpt.source;
    rptSampleSize = shrunkRpt.sampleSize;
    rawRollingMedianRequestsPerTurn = shrunkRpt.rawRollingMedianRequestsPerTurn;
    rptShrinkageWeight = shrunkRpt.shrinkageWeight;
    rptPriorUsed = shrunkRpt.priorRequestsPerTurn;
    isPlaceholderRptPrior = shrunkRpt.isPlaceholderShrinkagePrior;
    rptTurnsAgree = shrunkRpt.turnsAgree;
    rptEffectiveMinTrustedTurns = shrunkRpt.effectiveMinTrustedTurns;
  } else if (
    options.useLocalRptPrior !== false &&
    Number.isFinite(Number(options.historicalSessionRequestsPerTurn ?? localPriors?.medianRequestsPerTurn)) &&
    Number(options.historicalSessionRequestsPerTurn ?? localPriors?.medianRequestsPerTurn) >= 1
  ) {
    requestsPerTurn = Number(
      Number(options.historicalSessionRequestsPerTurn ?? localPriors?.medianRequestsPerTurn).toFixed(4)
    );
    rptEstimateSource = 'local_transcript_rpt_prior';
    rptPriorUsed = requestsPerTurn;
    isPlaceholderRptPrior = false;
  }

  const explicitGrowthRaw =
    event.context_growth_per_turn ?? event.contextGrowthPerTurn ?? options.contextGrowthPerTurn;
  const allowObservedGrowth =
    (event.useObservedPromptGrowth ?? options.useObservedPromptGrowth) !== false;
  let contextGrowthPerTurn = 0;
  let promptGrowthEstimateSource = 'default_0';
  let promptGrowthSampleSize = Number(sessionCal?.promptGrowthSampleSize ?? 0);
  const hasRecentRptHistory =
    Array.isArray(sessionCal?.recentTurnRequestCounts) &&
    sessionCal.recentTurnRequestCounts.length >= 2;
  const growthRegimeTrusted =
    turnsCompleted >= 5 &&
    promptGrowthSampleSize >= 4 &&
    (!hasRecentRptHistory || Boolean(rptTurnsAgree));
  if (
    explicitGrowthRaw !== undefined &&
    explicitGrowthRaw !== null &&
    Number.isFinite(Number(explicitGrowthRaw)) &&
    Number(explicitGrowthRaw) >= 0
  ) {
    contextGrowthPerTurn = Math.max(0, Math.round(Number(explicitGrowthRaw)));
    promptGrowthEstimateSource = 'explicit';
  } else if (
    allowObservedGrowth &&
    sessionCal?.rollingMedianPromptGrowthTokens !== null &&
    sessionCal?.rollingMedianPromptGrowthTokens !== undefined &&
    Number.isFinite(Number(sessionCal.rollingMedianPromptGrowthTokens)) &&
    Number(sessionCal.rollingMedianPromptGrowthTokens) >= 0
  ) {
    if (growthRegimeTrusted) {
      contextGrowthPerTurn = Math.max(
        0,
        Math.round(Number(sessionCal.rollingMedianPromptGrowthTokens))
      );
      promptGrowthEstimateSource = 'stop_hook_rolling_growth_median';
    } else {
      contextGrowthPerTurn = 0;
      promptGrowthEstimateSource =
        turnsCompleted < 5
          ? 'capped_early_session_no_extrapolation'
          : 'capped_unstable_regime_no_extrapolation';
    }
  }
  const contextCeilingRaw =
    event.context_ceiling ??
    event.contextCeiling ??
    event.context_window_size ??
    event.contextWindowSize ??
    event.context_window?.context_window_size ??
    options.contextCeiling ??
    liveState?.contextWindow?.contextCeiling;
  const contextCeiling =
    contextCeilingRaw !== undefined &&
    contextCeilingRaw !== null &&
    Number.isFinite(Number(contextCeilingRaw)) &&
    Number(contextCeilingRaw) >= 10_000
      ? Math.round(Number(contextCeilingRaw))
      : undefined;

  const shrinkageMinTurns = Number(
    options.outputShrinkageMinTurns ?? horizonConfig?.thresholds?.outputShrinkageMinTurns ?? 5
  );
  const shrinkagePriorTokens = Number(
    options.outputShrinkagePriorTokens ?? horizonConfig?.thresholds?.outputShrinkagePriorTokens ?? 500
  );

  let resolvedExpectedOutputTokens =
    event.expectedOutputTokens ?? event.expected_output_tokens ?? options.expectedOutputTokens;
  let outputEstimateSource =
    resolvedExpectedOutputTokens !== undefined ? 'explicit' : 'default_1500';
  let outputSampleSize = 0;
  let rawRollingMedianOutputTokens = null;
  let shrinkageWeight = resolvedExpectedOutputTokens !== undefined ? 1 : 0;
  const allowObservedOutput =
    (event.useObservedOutputTokens ?? options.useObservedOutputTokens) !== false;
  if (resolvedExpectedOutputTokens === undefined && allowObservedOutput) {
    const turnsDone = Number(liveState?.turnsCompleted || 0);
    const cumOut =
      Number(liveState?.cumulative?.outputTokens || 0) +
      Number(liveState?.cumulative?.thinkingTokens || 0);
    const lastOut =
      Number(liveState?.contextWindow?.lastOutputTokens || 0) +
      Number(liveState?.contextWindow?.lastThinkingTokens || 0);
    if (Number(sessionCal?.rollingMedianOutputTokens) > 0) {
      const calSampleSize = Math.max(
        1,
        Number(
          sessionCal.outputSampleSize ??
            (Array.isArray(sessionCal.recentTurnOutputs)
              ? sessionCal.recentTurnOutputs.length
              : sessionCal.turnsCompleted || 0)
        )
      );
      const shrunk = shrinkRollingOutputEstimate(
        sessionCal.rollingMedianOutputTokens,
        calSampleSize,
        { minTrustedTurns: shrinkageMinTurns, priorTokens: shrinkagePriorTokens }
      );
      resolvedExpectedOutputTokens = shrunk.expectedOutputTokens;
      outputEstimateSource = shrunk.source;
      outputSampleSize = shrunk.sampleSize;
      rawRollingMedianOutputTokens = shrunk.rawRollingMedianOutputTokens;
      shrinkageWeight = shrunk.shrinkageWeight;
    } else if (Number(liveState?.rollingMedianOutputTokens) > 0) {
      const liveSampleSize = Math.max(1, turnsDone);
      const shrunk = shrinkRollingOutputEstimate(
        liveState.rollingMedianOutputTokens,
        liveSampleSize,
        { minTrustedTurns: shrinkageMinTurns, priorTokens: shrinkagePriorTokens }
      );
      resolvedExpectedOutputTokens = shrunk.expectedOutputTokens;
      outputEstimateSource =
        shrunk.shrinkageWeight < 1 ? 'live_state_shrunk_median' : 'live_state_rolling_median';
      outputSampleSize = shrunk.sampleSize;
      rawRollingMedianOutputTokens = shrunk.rawRollingMedianOutputTokens;
      shrinkageWeight = shrunk.shrinkageWeight;
    } else if (turnsDone > 0 && cumOut > 0) {
      const shrunk = shrinkRollingOutputEstimate(Math.round(cumOut / turnsDone), turnsDone, {
        minTrustedTurns: shrinkageMinTurns,
        priorTokens: shrinkagePriorTokens
      });
      resolvedExpectedOutputTokens = shrunk.expectedOutputTokens;
      outputEstimateSource =
        shrunk.shrinkageWeight < 1 ? 'live_state_shrunk_mean' : 'live_state_mean';
      outputSampleSize = shrunk.sampleSize;
      rawRollingMedianOutputTokens = shrunk.rawRollingMedianOutputTokens;
      shrinkageWeight = shrunk.shrinkageWeight;
    } else if (lastOut > 0) {
      const shrunk = shrinkRollingOutputEstimate(lastOut, 1, {
        minTrustedTurns: shrinkageMinTurns,
        priorTokens: shrinkagePriorTokens
      });
      resolvedExpectedOutputTokens = shrunk.expectedOutputTokens;
      outputEstimateSource = 'live_state_shrunk_last';
      outputSampleSize = 1;
      rawRollingMedianOutputTokens = shrunk.rawRollingMedianOutputTokens;
      shrinkageWeight = shrunk.shrinkageWeight;
    }
  }

  let verdict = router.evaluateModelSwitch({
    currentModel,
    targetModel,
    cachedTokens,
    uncachedDeltaTokens,
    uncachedWriteTokens,
    justCompacted,
    totalPromptTokens,
    cacheWarm,
    cacheTtlTier,
    turnsCompleted,
    ...(apiCallsCompleted !== undefined ? { apiCallsCompleted } : {}),
    ...(requestsPerTurn !== undefined ? { requestsPerTurn } : {}),
    ...(contextGrowthPerTurn > 0 ? { contextGrowthPerTurn } : {}),
    ...(contextCeiling !== undefined ? { contextCeiling } : {}),
    initialPrefixTokens: sessionCal?.initialPrefixTokens,
    expectedOutputTokens: resolvedExpectedOutputTokens ?? 1500,
    ...(event.minSwitchPenaltyUSD !== undefined ||
    event.min_switch_penalty_usd !== undefined ||
    options.minSwitchPenaltyUSD !== undefined ||
    horizonConfig?.thresholds?.minSwitchPenaltyUSD !== undefined
      ? {
          minSwitchPenaltyUSD:
            event.minSwitchPenaltyUSD ??
            event.min_switch_penalty_usd ??
            options.minSwitchPenaltyUSD ??
            horizonConfig?.thresholds?.minSwitchPenaltyUSD
        }
      : {}),
    ...(event.notableAllowPenaltyUSD !== undefined ||
    event.notable_allow_penalty_usd !== undefined ||
    options.notableAllowPenaltyUSD !== undefined ||
    horizonConfig?.thresholds?.notableAllowPenaltyUSD !== undefined
      ? {
          notableAllowPenaltyUSD:
            event.notableAllowPenaltyUSD ??
            event.notable_allow_penalty_usd ??
            options.notableAllowPenaltyUSD ??
            horizonConfig?.thresholds?.notableAllowPenaltyUSD
        }
      : {}),
    ...(rawRemainingTurns !== undefined && rawRemainingTurns !== null
      ? { expectedRemainingTurns: Number(rawRemainingTurns) }
      : useEmpiricalHorizonPrior
        ? { useEmpiricalHorizonPrior: true }
        : {}),
    strictBlock:
      det08Override === 'block' ? true : (event.strictBlock ?? options.strictBlock),
    autoPilotDecision: resolvedAutoPilotDecision
  });

  if (det08Override === 'warn' && verdict.blocked) {
    verdict = {
      ...verdict,
      decision: 'allow',
      blocked: false,
      advisory: true,
      overriddenByConfig: 'warn'
    };
  } else if (det08Override === 'block' && verdict.breakEven?.shouldHoldModel && !verdict.blocked) {
    verdict = {
      ...verdict,
      decision: 'deny',
      blocked: true,
      advisory: false,
      overriddenByConfig: 'block'
    };
  }

  const isHeldDownshift = Boolean(
    (verdict.blocked || verdict.advisory) &&
      verdict.breakEven?.shouldHoldModel &&
      !verdict.belowMinSwitchPenaltyUSD &&
      !verdict.breakEven?.isCapabilityUpshift &&
      !verdict.breakEven?.unknownModel &&
      verdict.breakEven?.currentModel &&
      verdict.breakEven?.targetModel &&
      verdict.breakEven.currentModel !== verdict.breakEven.targetModel
  );
  const recordedPendingDownshift = isHeldDownshift
    ? {
        fromModel: verdict.breakEven.currentModel,
        toModel: verdict.breakEven.targetModel,
        recordedAt: new Date(nowMs).toISOString()
      }
    : null;

  const shadowAutoEval =
    effectiveMode !== 'AUTO_PILOT' &&
    det08Override !== 'off' &&
    cacheWarm &&
    cachedTokens > 0 &&
    effectiveMode === 'OFF'
      ? new CacheGravityRouter({
          ...cwdOptions,
          ...(historicalSessionApiCalls ? { historicalSessionApiCalls } : {}),
          mode: 'AUTO_PILOT'
        }).evaluateModelSwitch({
          currentModel,
          targetModel,
          cachedTokens,
          uncachedDeltaTokens,
          uncachedWriteTokens,
          justCompacted,
          totalPromptTokens,
          cacheWarm,
          cacheTtlTier,
          turnsCompleted,
          ...(apiCallsCompleted !== undefined ? { apiCallsCompleted } : {}),
          ...(requestsPerTurn !== undefined ? { requestsPerTurn } : {}),
          ...(contextGrowthPerTurn > 0 ? { contextGrowthPerTurn } : {}),
          ...(contextCeiling !== undefined ? { contextCeiling } : {}),
          initialPrefixTokens: sessionCal?.initialPrefixTokens,
          expectedOutputTokens: resolvedExpectedOutputTokens ?? 1500,
          ...(rawRemainingTurns !== undefined && rawRemainingTurns !== null
            ? { expectedRemainingTurns: Number(rawRemainingTurns) }
            : useEmpiricalHorizonPrior
              ? { useEmpiricalHorizonPrior: true }
              : {}),
          autoPilotDecision: resolvedAutoPilotDecision
        })
      : null;

  const effectiveShadowVerdict = shadowAutoEval || verdict;
  const shadowAutoWouldHold = Boolean(
    effectiveMode !== 'AUTO_PILOT' &&
      (effectiveShadowVerdict.advisory ||
        effectiveShadowVerdict.blocked ||
        effectiveShadowVerdict.decision === 'ask') &&
      effectiveShadowVerdict.breakEven?.shouldHoldModel &&
      !effectiveShadowVerdict.belowMinSwitchPenaltyUSD &&
      !effectiveShadowVerdict.breakEven?.isCapabilityUpshift &&
      !effectiveShadowVerdict.breakEven?.unknownModel
  );
  const rawShadowNetUsd = Number(
    effectiveShadowVerdict.netExpectedSavingsUSD ??
      effectiveShadowVerdict.breakEven?.horizonNetSavingsUSD ??
      NaN
  );
  const shadowPenaltyUsd = Number(
    effectiveShadowVerdict.switchPenaltyUSD ??
      effectiveShadowVerdict.breakEven?.coldWritePenaltyUSD ??
      0
  );
  const shadowMissedUsd = Number(
    Math.max(
      0,
      Number.isFinite(rawShadowNetUsd) && rawShadowNetUsd < 0 ? -rawShadowNetUsd : shadowPenaltyUsd
    ).toFixed(4)
  );
  const pendingShadowSwitchMiss = shadowAutoWouldHold
    ? {
        ts: nowMs,
        currentModel,
        targetModel,
        wastedTokens: cachedTokens,
        missedUsd: shadowMissedUsd,
        effectiveMode,
        turnKey: String(
          event.turn_id || event.turnId || `${currentModel}->${targetModel}:${cachedTokens}`
        ),
        detectorId: 'DET-08'
      }
    : null;

  if (shadowAutoWouldHold && options.recordShadowImmediate === true) {
    recordShadowAutoMiss(
      {
        sessionId,
        workspacePath: event.cwd || options.cwd || '',
        harness: 'claude-code',
        effectiveMode,
        category: 'WARM_SWITCH_BUST',
        detectorId: 'DET-08',
        turnKey: pendingShadowSwitchMiss.turnKey,
        wastedTokens: cachedTokens,
        missedUsd: shadowMissedUsd,
        avoidedPrompts: 1,
        detail: `Model switch ${currentModel} -> ${targetModel} on warm cache`
      },
      {
        ...cwdOptions,
        ...(event.shadowLedgerPath ? { shadowLedgerPath: event.shadowLedgerPath } : {})
      }
    );
  }

  if (shouldPersistBreaker) {
    if (recordedPendingDownshift || pendingShadowSwitchMiss) {
      writeBreakerStateSnapshot(
        sessionId,
        {
          ...(breakerSnap || {}),
          updatedAt: nowMs,
          ...(recordedPendingDownshift
            ? {
                pending_downshift: recordedPendingDownshift,
                pendingDownshiftModel: recordedPendingDownshift.toModel
              }
            : {}),
          ...(pendingShadowSwitchMiss ? { pendingShadowSwitchMiss } : {}),
          lastModelId: verdict.breakEven?.currentModel || currentModel,
          lastContextTokens: cachedTokens
        },
        cwdOptions
      );
    } else if (
      !verdict.blocked &&
      !verdict.advisory &&
      breakerSnap &&
      (breakerSnap.pending_downshift ||
        breakerSnap.pendingDownshiftModel ||
        breakerSnap.justCompacted ||
        breakerSnap.pendingShadowSwitchMiss)
    ) {
      writeBreakerStateSnapshot(
        sessionId,
        {
          ...breakerSnap,
          updatedAt: nowMs,
          pending_downshift: null,
          pendingDownshiftModel: null,
          pendingShadowSwitchMiss: null,
          justCompacted: false
        },
        cwdOptions
      );
    }
  }

  verdict = {
    ...verdict,
    ...(recordedPendingDownshift ? { pending_downshift: recordedPendingDownshift } : {}),
    turnsCompletedUsed: turnsCompleted,
    apiCallsCompletedUsed: apiCallsCompleted ?? null,
    requestsPerTurnUsed: verdict.breakEven?.requestsPerTurn ?? requestsPerTurn ?? 1,
    rptEstimateSource,
    rptSampleSize,
    rawRollingMedianRequestsPerTurn,
    rawCumulativeRequestsPerTurn,
    rptShrinkageWeight,
    rptPriorUsed,
    isPlaceholderRptPrior,
    rptTurnsAgree,
    rptEffectiveMinTrustedTurns,
    contextGrowthPerTurnUsed: verdict.breakEven?.contextGrowthPerTurn ?? contextGrowthPerTurn ?? 0,
    promptGrowthEstimateSource,
    promptGrowthSampleSize,
    outputEstimateSource,
    outputSampleSize,
    rawRollingMedianOutputTokens,
    shrinkageWeight
  };

  const interceptionLogPath =
    options.interceptionLogPath || globalThis.process?.env?.AH_INTERCEPTION_LOG_PATH;
  if (typeof interceptionLogPath === 'string' && interceptionLogPath.trim()) {
    try {
      const logTarget = interceptionLogPath.trim();
      const logDir = path.dirname(logTarget);
      if (logDir && logDir !== '.' && !fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(
        logTarget,
        `${JSON.stringify({
          timestampMs: nowMs,
          sessionId,
          fromModel: currentModel,
          toModel: targetModel,
          turnsCompletedUsed: turnsCompleted,
          apiCallsCompleted: apiCallsCompleted ?? null,
          requestsPerTurn: verdict.breakEven?.requestsPerTurn ?? requestsPerTurn ?? null,
          rptEstimateSource,
          rptSampleSize,
          rawRollingMedianRequestsPerTurn,
          rawCumulativeRequestsPerTurn,
          rptShrinkageWeight,
          rptPriorUsed,
          isPlaceholderRptPrior,
          rptTurnsAgree,
          rptEffectiveMinTrustedTurns,
          contextGrowthPerTurn: verdict.breakEven?.contextGrowthPerTurn ?? contextGrowthPerTurn ?? 0,
          promptGrowthEstimateSource,
          promptGrowthSampleSize,
          outputEstimateSource,
          outputSampleSize,
          rawRollingMedianOutputTokens,
          shrinkageWeight,
          expectedOutputTokens: verdict.breakEven?.expectedOutputTokens ?? null,
          cachedTokens,
          breakEvenTokens: verdict.breakEven?.breakEvenTokens ?? null,
          horizonMaxCachedTokens:
            verdict.breakEven?.horizonMaxCachedTokens === Infinity
              ? 'Infinity'
              : (verdict.breakEven?.horizonMaxCachedTokens ?? null),
          coldWritePenaltyUSD: verdict.breakEven?.coldWritePenaltyUSD ?? null,
          perTurnPostSwitchSavingUSD: verdict.breakEven?.perTurnPostSwitchSavingUSD ?? null,
          averagePostSwitchSavingUSD: verdict.breakEven?.averagePostSwitchSavingUSD ?? null,
          horizonNetSavingsUSD: verdict.breakEven?.horizonNetSavingsUSD ?? null,
          paybackTurns: verdict.breakEven?.paybackTurns ?? null,
          paybackWarmRequests: verdict.breakEven?.paybackWarmRequests ?? null,
          expectedRemainingTurns: verdict.breakEven?.expectedRemainingTurns ?? null,
          postSwitchRemainingTurns: verdict.breakEven?.postSwitchRemainingTurns ?? null,
          expectedRemainingRequests: verdict.breakEven?.expectedRemainingRequests ?? null,
          horizonUnit: verdict.breakEven?.horizonUnit ?? 'turns',
          priorNativeUnit: verdict.breakEven?.priorNativeUnit ?? null,
          priorBucket: verdict.breakEven?.priorBucket ?? null,
          isPlaceholderPrior: Boolean(verdict.breakEven?.isPlaceholderPrior),
          horizonPriorSource: verdict.breakEven?.horizonPriorSource ?? null,
          contextCeilingUsed: verdict.breakEven?.contextCeilingUsed ?? null,
          initialPrefixTokensUsed: verdict.breakEven?.initialPrefixTokensUsed ?? null,
          belowMinSwitchPenaltyUSD: Boolean(verdict.belowMinSwitchPenaltyUSD),
          minSwitchPenaltyUSD: verdict.minSwitchPenaltyUSD ?? null,
          notableAllowNote: verdict.notableAllowNote ?? null,
          ruleVersion: verdict.breakEven?.ruleVersion ?? null,
          decision: verdict.decision,
          reason: verdict.reason ?? null
        })}\n`,
        'utf8'
      );
    } catch {
      // Never fail PreModelSwitch hook on diagnostic log write
    }
  }

  const shouldRecordSwitchTelemetry =
    options.recordSwitchTelemetry !== false &&
    Boolean(
      options.cliInvocation ||
        options.homeDir ||
        options.telemetryPath ||
        options.recordSwitchTelemetry ||
        globalThis.process?.env?.AH_MODEL_SWITCH_TELEMETRY_PATH
    );
  if (shouldRecordSwitchTelemetry) {
    try {
      recordPreModelSwitchEvent(event, verdict.decision, {
        homeDir: options.homeDir,
        telemetryPath: options.telemetryPath
      });
    } catch {
      // Never fail PreModelSwitch hook on local acceptance telemetry error
    }
  }

  const avoidedPenaltyUSD = Math.max(
    0,
    Number(verdict.breakEven?.coldWritePenaltyUSD ?? 0)
  );

  if (
    (verdict.blocked || verdict.decision === 'ask') &&
    cachedTokens > 0 &&
    avoidedPenaltyUSD > 0 &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
    recordInterventionSavings(
      {
        sessionId,
        category: 'DET_08_MODEL_SWITCH_HOLD',
        modelId: currentModel,
        savedTokens: cachedTokens,
        savedUSD: avoidedPenaltyUSD,
        dedupeId: event.turn_id || event.turnId || `${currentModel}->${targetModel}:${cachedTokens}`,
        detail: `DET-08 held warm prefix (${cachedTokens.toLocaleString()} tok) on ${currentModel} vs ${targetModel}`
      },
      cwdOptions
    );
  }

  if (!verdict.blocked) {
    if (verdict.advisory && verdict.reason) {
      const hookSpecificOutput = {
        hookEventName: 'PreModelSwitch',
        permissionDecision: 'allow',
        additionalContext: verdict.reason
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput }),
        stderr: '',
        verdict
      };
    }
    if (verdict.notableAllowNote) {
      const hookSpecificOutput = {
        hookEventName: 'PreModelSwitch',
        permissionDecision: 'allow',
        permissionDecisionReason: verdict.notableAllowNote
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          systemMessage: verdict.notableAllowNote,
          hookSpecificOutput
        }),
        stderr: '',
        verdict
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict
    };
  }

  if (options.useJsonDecision || verdict.decision === 'ask') {
    const hookSpecificOutput = {
      hookEventName: 'PreModelSwitch',
      permissionDecision: verdict.decision === 'ask' ? 'ask' : 'deny',
      permissionDecisionReason: verdict.reason
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify({ hookSpecificOutput }),
      stderr: '',
      verdict
    };
  }

  return {
    exitCode: 2,
    stdout: '',
    stderr: verdict.reason,
    verdict
  };
}

/**
 * Fail-closed CLI runner for `PreModelSwitch` (`ISS-035`).
 * Any uncaught error exits `2` via `exitHardBlockStderr`.
 *
 * @param {object} [cliOptions={}]
 */
export async function executePreModelSwitchCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runPreModelSwitchHook;
  const ioOverride = cliOptions.ioOverride || {};
  const isRealCliRun =
    !cliOptions.ioOverride && !cliOptions.readPayload && !cliOptions.runHook;
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    const res = runHook(payload, {
      cliInvocation: isRealCliRun,
      ...(cliOptions.hookOptions || {})
    });
    if (res.exitCode === 2) {
      exitHardBlockStderr(res.stderr, 'PreModelSwitch', ioOverride);
    } else if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitHardBlockStderr(
      `[Highbeam Fail-Closed] ${err?.message || String(err)}`,
      'PreModelSwitch',
      ioOverride
    );
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePreModelSwitchCli().catch((err) => {
    exitHardBlockStderr(
      `[Highbeam Fail-Closed] ${err?.message || String(err)}`,
      'PreModelSwitch'
    );
  });
}
