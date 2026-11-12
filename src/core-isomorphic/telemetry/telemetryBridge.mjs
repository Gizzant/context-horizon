/**
 * @file src/telemetry/telemetryBridge.mjs
 * Dual-Source Telemetry Engine for Claude Code Attention Horizon.
 * Ingests live token/cache telemetry from:
 *   1. In-process Mod `turn.step` / `turn.complete` (`result.usage` + `e.agentId`)
 *   2. CLI `statusLine` stdin JSON (`context_window`, `prompt_cache`, `rate_limits`)
 * Never sums raw JSONL `usage.input_tokens` placeholders.
 * Computes exact USD Cache ROI and persists atomic bridge snapshots to
 * `.claude/cache/ah_live_state_<sessionId>.json`.
 */

import { path, getCwd, writeJsonAtomic, readJsonSafe } from '../utils/runtime.mjs';
import {
  normalizeModelId,
  resolveCustomCeilingForModel,
  extractNormalizedTokenBreakdown,
  computeTotalPromptTokens,
  resolveEffectiveRates,
  calculateTurnCostUSD
} from '../config/catalogLoader.mjs';
import { exportOtelTelemetry } from './otelExporter.mjs';
import { applySubagentLifecycle } from './swarmTopology.mjs';
import {
  createInitialPrefixRetention,
  createInitialThinkingDrift,
  applyPrefixRetentionRequest,
  applyThinkingDriftEvent
} from './sprintMetrics.mjs';

export const SESSION_FIVE_MIN_ROI_TARGET = 1.39;

/**
 * Computes dynamic single-write USD break-even read/write ratio `(mWrite - 1) / (1 - mRead)`
 * from model rate multipliers, weighting 5m and 1h writes when both are present (`ISS-006`).
 *
 * @param {object} rates
 * @param {number} [write5mTokens=0]
 * @param {number} [write1hTokens=0]
 * @param {'5m'|'1h'} [ttlTier='5m']
 * @returns {number}
 */
function computeBreakEvenRatioFromRates(
  rates,
  write5mTokens = 0,
  write1hTokens = 0,
  ttlTier = '5m'
) {
  const mults = rates?.multipliers || { write5m: 1.25, write1h: 2.0, read: 0.05 };
  const w5 = Math.max(0, Number(write5mTokens || 0));
  const w1 = Math.max(0, Number(write1hTokens || 0));
  const totalW = w5 + w1;
  const mWrite =
    totalW > 0
      ? (w5 * mults.write5m + w1 * mults.write1h) / totalW
      : ttlTier === '1h'
        ? mults.write1h
        : mults.write5m;
  const mRead = Number(mults.read ?? 0.05);
  const denom = 1 - mRead;
  if (denom <= 0) return Infinity;
  return Number((Math.max(0, mWrite - 1) / denom).toFixed(3));
}

/**
 * Sanitizes a session ID for safe filesystem paths.
 * @param {string} [sessionId='default']
 * @returns {string}
 */
export function sanitizeSessionId(sessionId = 'default') {
  const cleaned = String(sessionId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'default';
}

/**
 * Resolves the atomic bridge file path `.claude/cache/ah_live_state_<sessionId>.json`.
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {string}
 */
export function getLiveStateBridgePath(sessionId = 'default', options = {}) {
  const cwd = getCwd(options);
  const safeId = sanitizeSessionId(sessionId);
  return path.join(cwd, '.claude', 'cache', `ah_live_state_${safeId}.json`);
}

/**
 * Computes exact USD Cache ROI and break-even read/write ratio for a model and token distribution.
 * Flags Negative Cache ROI strictly when `ActualCacheSpendUSD > UncachedEquivalentUSD`
 * (i.e. `reads / write < (M_write - 1) / (1 - M_read)`, which is `0.263` for 5m Opus/Sonnet 5.5
 * and `1.053` for 1h writes).
 *
 * @param {object} [params={}]
 * @param {string} [params.model='claude-sonnet-5-5']
 * @param {number} [params.cacheWriteTokens=0]
 * @param {number} [params.cacheWrite5mTokens=0]
 * @param {number} [params.cacheWrite1hTokens=0]
 * @param {number} [params.cacheReadTokens=0]
 * @param {number} [params.uncachedInputTokens=0]
 * @param {number} [params.outputTokens=0]
 * @param {number} [params.thinkingTokens=0]
 * @param {number} [params.totalPromptTokens]
 * @param {'5m'|'1h'} [params.cacheTtlTier='5m']
 * @param {object} [options={}]
 */
export function computeCacheRoi(params = {}, options = {}) {
  const ttlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';
  const turnCalc = calculateTurnCostUSD(
    {
      ...params,
      model: params.model || 'claude-sonnet-5-5',
      inputTokens:
        params.uncachedInputTokens ?? params.freshInputTokens ?? params.inputTokens ?? params.input_tokens ?? 0,
      outputTokens: params.outputTokens ?? params.output_tokens ?? 0,
      thinkingTokens: params.thinkingTokens ?? params.thinking_tokens ?? 0,
      cacheWriteTokens:
        params.cacheWriteTokens ?? params.cacheCreationInputTokens ?? params.cache_creation_input_tokens ?? 0,
      cacheWrite5mTokens: params.cacheWrite5mTokens ?? params.cache_write_5m_tokens ?? 0,
      cacheWrite1hTokens: params.cacheWrite1hTokens ?? params.cache_write_1h_tokens ?? 0,
      cacheReadTokens:
        params.cacheReadTokens ?? params.cacheReadInputTokens ?? params.cache_read_input_tokens ?? 0,
      totalPromptTokens: params.totalPromptTokens,
      cacheTtlTier: ttlTier
    },
    options
  );

  const rates = turnCalc.rates;
  const { cacheWrite5m, cacheWrite1h, totalCacheWrite, cacheRead, uncachedInput, totalPrompt } =
    turnCalc.tokens;
  const {
    actualCacheSpendUSD,
    uncachedCacheEquivalentUSD,
    totalActualSpendUSD,
    totalUncachedEquivalentUSD,
    netCacheSavingsUSD
  } = turnCalc.costsUSD;

  const breakEvenReadsPerWrite = computeBreakEvenRatioFromRates(
    rates,
    cacheWrite5m,
    cacheWrite1h,
    ttlTier
  );

  const readsPerWriteRatio =
    totalCacheWrite > 0
      ? Number((cacheRead / totalCacheWrite).toFixed(4))
      : cacheRead > 0
        ? Infinity
        : 0;

  const negativeCacheRoi = Boolean(
    totalCacheWrite > 0 && actualCacheSpendUSD > uncachedCacheEquivalentUSD + 1e-9
  );

  const cacheHitRatio =
    totalPrompt > 0 ? Number((cacheRead / totalPrompt).toFixed(4)) : 0;

  return {
    modelId: rates.modelId,
    cacheTtlTier: ttlTier,
    actualCacheSpendUSD,
    actualSpendUSD: actualCacheSpendUSD,
    uncachedEquivalentUSD: uncachedCacheEquivalentUSD,
    uncachedBaselineUSD: uncachedCacheEquivalentUSD,
    totalActualSpendUSD,
    totalUncachedEquivalentUSD,
    netCacheSavingsUSD,
    negativeCacheRoi,
    readsPerWriteRatio,
    breakEvenReadsPerWrite,
    sessionFiveMinRoiTarget: SESSION_FIVE_MIN_ROI_TARGET,
    cacheHitRatio,
    cliffTriggered: rates.cliffTriggered,
    preCliffWarningTriggered: rates.preCliffWarningTriggered,
    tokens: {
      uncachedInput,
      cacheWrite: totalCacheWrite,
      cacheRead,
      totalPrompt
    }
  };
}

/**
 * Computes session-wide Cache ROI directly from accumulated per-turn USD spend in `state.cumulative`,
 * never retroactively re-pricing multi-turn cumulative token sums against single-turn 5x cliffs (`ISS-003`).
 *
 * @param {object} state
 * @param {object} currentRates
 * @returns {object}
 */
function buildCumulativeCacheRoi(state, currentRates) {
  const ttlTier = state.promptCache?.ttlTier === '1h' ? '1h' : '5m';
  const cum = state.cumulative || {};
  const write5m = Math.max(0, Number(cum.cacheWrite5mTokens || 0));
  const write1h = Math.max(0, Number(cum.cacheWrite1hTokens || 0));
  const totalCacheWrite = write5m + write1h;
  const cacheRead = Math.max(0, Number(cum.cacheReadTokens || 0));
  const uncachedInput = Math.max(0, Number(cum.uncachedInputTokens || 0));
  const totalPrompt = uncachedInput + totalCacheWrite + cacheRead;

  const actualCacheSpendUSD = Number((cum.actualCacheSpendUSD || 0).toFixed(6));
  const uncachedEquivalentUSD = Number(
    (cum.uncachedEquivalentUSD ?? cum.uncachedBaselineUSD ?? 0).toFixed(6)
  );
  const totalActualSpendUSD = Number((cum.totalActualSpendUSD || 0).toFixed(6));
  const totalUncachedEquivalentUSD = Number((cum.totalUncachedEquivalentUSD || 0).toFixed(6));
  const netCacheSavingsUSD = Number((uncachedEquivalentUSD - actualCacheSpendUSD).toFixed(6));

  const breakEvenReadsPerWrite = computeBreakEvenRatioFromRates(
    currentRates,
    write5m,
    write1h,
    ttlTier
  );
  const readsPerWriteRatio =
    totalCacheWrite > 0
      ? Number((cacheRead / totalCacheWrite).toFixed(4))
      : cacheRead > 0
        ? Infinity
        : 0;
  const negativeCacheRoi = Boolean(
    totalCacheWrite > 0 && actualCacheSpendUSD > uncachedEquivalentUSD + 1e-9
  );
  const cacheHitRatio =
    totalPrompt > 0 ? Number((cacheRead / totalPrompt).toFixed(4)) : 0;

  return {
    modelId: currentRates.modelId,
    cacheTtlTier: ttlTier,
    actualCacheSpendUSD,
    actualSpendUSD: actualCacheSpendUSD,
    uncachedEquivalentUSD,
    uncachedBaselineUSD: uncachedEquivalentUSD,
    totalActualSpendUSD,
    totalUncachedEquivalentUSD,
    netCacheSavingsUSD,
    negativeCacheRoi,
    readsPerWriteRatio,
    breakEvenReadsPerWrite,
    sessionFiveMinRoiTarget: SESSION_FIVE_MIN_ROI_TARGET,
    cacheHitRatio,
    cliffTriggered: Boolean(currentRates.cliffTriggered),
    preCliffWarningTriggered: Boolean(currentRates.preCliffWarningTriggered),
    tokens: {
      uncachedInput,
      cacheWrite: totalCacheWrite,
      cacheRead,
      totalPrompt
    }
  };
}

/**
 * Adds a single turn's (or positive step delta's) priced token & USD breakdown into `state.cumulative`.
 * @param {object} cumulative
 * @param {object} turnCost
 */
function addTurnCostToCumulative(cumulative, turnCost) {
  const { uncachedInput, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking } =
    turnCost.tokens;
  const {
    actualCacheSpendUSD,
    uncachedCacheEquivalentUSD,
    totalActualSpendUSD,
    totalUncachedEquivalentUSD
  } = turnCost.costsUSD;

  cumulative.uncachedInputTokens += uncachedInput;
  cumulative.cacheWrite5mTokens += cacheWrite5m;
  cumulative.cacheWrite1hTokens += cacheWrite1h;
  cumulative.cacheReadTokens += cacheRead;
  cumulative.outputTokens += output;
  cumulative.thinkingTokens += thinking;
  cumulative.actualCacheSpendUSD = Number(
    (cumulative.actualCacheSpendUSD + actualCacheSpendUSD).toFixed(6)
  );
  cumulative.uncachedEquivalentUSD = Number(
    (cumulative.uncachedEquivalentUSD + uncachedCacheEquivalentUSD).toFixed(6)
  );
  cumulative.uncachedBaselineUSD = cumulative.uncachedEquivalentUSD;
  cumulative.totalActualSpendUSD = Number(
    (cumulative.totalActualSpendUSD + totalActualSpendUSD).toFixed(6)
  );
  cumulative.totalUncachedEquivalentUSD = Number(
    (cumulative.totalUncachedEquivalentUSD + totalUncachedEquivalentUSD).toFixed(6)
  );
  cumulative.netCacheSavingsUSD = Number(
    (cumulative.uncachedEquivalentUSD - cumulative.actualCacheSpendUSD).toFixed(6)
  );
}

/**
 * Creates a clean initial session telemetry state object.
 * @param {string} [sessionId='default']
 * @param {string} [model='claude-sonnet-5-5']
 * @returns {object}
 */
export function createInitialTelemetryState(sessionId = 'default', model = 'claude-sonnet-5-5') {
  const normModel = normalizeModelId(model);
  const rates = resolveEffectiveRates(model, 0);
  const initialBreakEven = computeBreakEvenRatioFromRates(rates, 0, 0, '5m');
  return {
    schemaVersion: '2026.11.1',
    sessionId: sanitizeSessionId(sessionId),
    modelId: normModel,
    rawModelId: String(model || normModel),
    modelLabel: rates.label,
    contextCeiling: rates.contextCeiling,
    steps: 0,
    turnsCompleted: 0,
    lastUpdatedAt: Date.now(),
    lastSource: 'init',
    lastAgentId: null,
    contextWindow: {
      totalInputTokens: 0,
      uncachedInputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmPrefixTokens: 0,
      lastWriteTokens: 0,
      lastOutputTokens: 0,
      lastThinkingTokens: 0,
      systemAndMcpTokens: 0,
      distractorTokens: 0,
      customCeiling: null,
      contextCeiling: rates.contextCeiling
    },
    cumulative: {
      uncachedInputTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      actualCacheSpendUSD: 0,
      uncachedEquivalentUSD: 0,
      uncachedBaselineUSD: 0,
      totalActualSpendUSD: 0,
      totalUncachedEquivalentUSD: 0,
      netCacheSavingsUSD: 0
    },
    promptCache: {
      warm: false,
      ttlTier: '5m',
      ttlSeconds: 300,
      expiresAt: null,
      lastMissCause: null
    },
    cacheRoi: {
      actualCacheSpendUSD: 0,
      actualSpendUSD: 0,
      uncachedEquivalentUSD: 0,
      uncachedBaselineUSD: 0,
      netCacheSavingsUSD: 0,
      negativeCacheRoi: false,
      readsPerWriteRatio: 0,
      breakEvenReadsPerWrite: initialBreakEven,
      sessionFiveMinRoiTarget: SESSION_FIVE_MIN_ROI_TARGET,
      cacheHitRatio: 0
    },
    rateLimits: {
      fiveHour: null,
      sevenDay: null,
      spendLimit: null
    },
    subagents: {},
    inFlightTurn: null,
    subagentInFlightTurns: {},
    lastCompletedTurnId: null,
    lastStatusTurnId: null,
    lastReportedStatusCostUSD: null,
    lastStatusLineEnvelopeSig: null,
    cliffTriggered: false,
    preCliffWarningTriggered: false,
    prefixRetention: createInitialPrefixRetention(),
    thinkingDrift: createInitialThinkingDrift(),
    lastTurn: null
  };
}

/**
 * Normalizes a TTL value from `statusLine` or Mod payload into `{ ttlTier: '5m'|'1h', ttlSeconds: number }`.
 * Explicit `0` / `'0s'` / negative values return `ttlSeconds: 0` (`ISS-027`).
 * @param {string|number|undefined} rawTtl
 * @returns {{ ttlTier: '5m'|'1h', ttlSeconds: number }}
 */
function parseTtlInfo(rawTtl) {
  if (rawTtl === 0 || rawTtl === '0' || rawTtl === '0s' || (typeof rawTtl === 'number' && rawTtl <= 0)) {
    return { ttlTier: '5m', ttlSeconds: 0 };
  }
  if (typeof rawTtl === 'string') {
    const trimmed = rawTtl.trim().toLowerCase();
    if (trimmed === '1h') return { ttlTier: '1h', ttlSeconds: 3600 };
    if (trimmed === '5m') return { ttlTier: '5m', ttlSeconds: 300 };
    const secMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)s?$/);
    if (secMatch) {
      const parsedSec = Number(secMatch[1]);
      if (parsedSec <= 0) return { ttlTier: '5m', ttlSeconds: 0 };
      if (parsedSec > 300) return { ttlTier: '1h', ttlSeconds: parsedSec };
      return { ttlTier: '5m', ttlSeconds: parsedSec };
    }
  }
  if (Number(rawTtl) > 300) {
    return {
      ttlTier: '1h',
      ttlSeconds: typeof rawTtl === 'number' ? rawTtl : 3600
    };
  }
  return {
    ttlTier: '5m',
    ttlSeconds: typeof rawTtl === 'number' && rawTtl > 0 ? rawTtl : 300
  };
}

/**
 * Normalizes `expires_at` (ISO string or epoch ms/seconds) to epoch milliseconds.
 * @param {string|number|null|undefined} rawExpiresAt
 * @param {number} fallbackNowMs
 * @param {number} ttlSeconds
 * @param {boolean} isWarm
 * @returns {number | null}
 */
function normalizeExpiresAtMs(rawExpiresAt, fallbackNowMs, ttlSeconds, isWarm) {
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    return rawExpiresAt < 1e11 ? rawExpiresAt * 1000 : rawExpiresAt;
  }
  if (typeof rawExpiresAt === 'string' && rawExpiresAt.trim()) {
    const parsed = Date.parse(rawExpiresAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (isWarm && ttlSeconds > 0) {
    return fallbackNowMs + ttlSeconds * 1000;
  }
  return null;
}

/**
 * Computes strictly non-negative token delta between two token breakdown snapshots (`ISS-027`).
 * @param {object} current
 * @param {object} baseline
 */
function computePositiveTokenDelta(current, baseline) {
  if (!baseline) return { ...current };
  return {
    uncachedInputTokens: Math.max(
      0,
      current.uncachedInputTokens - (baseline.uncachedInputTokens || 0)
    ),
    effectiveWrite5mTokens: Math.max(
      0,
      current.effectiveWrite5mTokens - (baseline.effectiveWrite5mTokens || 0)
    ),
    effectiveWrite1hTokens: Math.max(
      0,
      current.effectiveWrite1hTokens - (baseline.effectiveWrite1hTokens || 0)
    ),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - (baseline.cacheReadTokens || 0)),
    outputTokens: Math.max(0, current.outputTokens - (baseline.outputTokens || 0)),
    thinkingTokens: Math.max(0, current.thinkingTokens - (baseline.thinkingTokens || 0))
  };
}

function hasAnyPositiveTokens(delta) {
  return (
    delta.uncachedInputTokens +
      delta.effectiveWrite5mTokens +
      delta.effectiveWrite1hTokens +
      delta.cacheReadTokens +
      delta.outputTokens +
      delta.thinkingTokens >
    0
  );
}

/**
 * Ingests a Mod `turn.step` or `turn.complete` event into the session telemetry state.
 * Deduplicates `turn.step` + `turn.complete` per turn so `state.cumulative` commits 1x,
 * and isolates subagent turns from overwriting the main `state.contextWindow` (`ISS-027`).
 *
 * @param {object} currentState
 * @param {object} event
 * @param {object} [options={}]
 * @returns {object} Updated state
 */
export function ingestModTurnEvent(currentState, event = {}, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const sessionId = event.sessionId || event.session_id || currentState?.sessionId || 'default';
  const rawEventModel = event.model || event.result?.model || null;
  const fallbackModel = currentState?.rawModelId || currentState?.modelId || 'claude-sonnet-5-5';
  const state = currentState
    ? JSON.parse(JSON.stringify(currentState))
    : createInitialTelemetryState(sessionId, rawEventModel || fallbackModel);

  state.sessionId = sanitizeSessionId(sessionId);
  state.lastUpdatedAt = nowMs;
  state.lastSource = event.type === 'turn.complete' ? 'mod.turn.complete' : 'mod.turn.step';
  if (!state.subagentInFlightTurns || typeof state.subagentInFlightTurns !== 'object') {
    state.subagentInFlightTurns = {};
  }

  const subagentId =
    event.subagentId ||
    event.subagent_id ||
    (event.agentId && event.agentId !== 'main' ? event.agentId : null) ||
    (event.agent_id && event.agent_id !== 'main' ? event.agent_id : null) ||
    null;
  const isSubagent = Boolean(
    event.isSubagent || subagentId || event.parentSessionId || event.parent_session_id
  );
  const agentKey = isSubagent
    ? subagentId || String(event.parentSessionId || event.parent_session_id || 'subagent')
    : null;
  state.lastAgentId = agentKey;

  const turnId = event.turnId || event.turn_id || event.result?.turn_id || null;
  const messageId =
    event.messageId ||
    event.message_id ||
    event.message?.id ||
    event.result?.id ||
    event.result?.message?.id ||
    null;

  if (!isSubagent && event.type === 'turn.complete' && turnId && state.lastCompletedTurnId === turnId) {
    return state;
  }

  const effectiveTurnModelRaw = isSubagent
    ? rawEventModel || fallbackModel
    : rawEventModel || fallbackModel;

  if (!isSubagent && rawEventModel) {
    state.rawModelId = String(rawEventModel);
    state.modelId = normalizeModelId(rawEventModel);
  }

  const usage = event.result?.usage || event.usage || null;
  if (!usage) {
    if (event.type === 'turn.complete') {
      if (!isSubagent) {
        state.turnsCompleted += 1;
        state.inFlightTurn = null;
        if (turnId) state.lastCompletedTurnId = turnId;
      } else if (agentKey) {
        delete state.subagentInFlightTurns[agentKey];
        if (state.subagents && state.subagents[agentKey]) {
          applySubagentLifecycle(state.subagents[agentKey], event, { nowMs, eventType: 'turn.complete' });
        }
      }
    }
    return state;
  }

  const ttlTier = state.promptCache?.ttlTier === '1h' ? '1h' : '5m';
  const breakdown = extractNormalizedTokenBreakdown({ ...usage, cacheTtlTier: ttlTier });
  const uncachedInput = breakdown.uncachedInputTokens;
  const write5mTokens = breakdown.effectiveWrite5mTokens;
  const write1hTokens = breakdown.effectiveWrite1hTokens;
  const totalWriteTokens = breakdown.totalCacheWriteTokens;
  const cacheReadTokens = breakdown.cacheReadTokens;
  const outputTokens = breakdown.outputTokens;
  const thinkingTokens = breakdown.thinkingTokens;
  const totalPromptTokens = uncachedInput + totalWriteTokens + cacheReadTokens;

  // Determine in-flight turn tracker (main vs isolated subagent) to prevent 2x double-counting
  const activeTracker = isSubagent
    ? state.subagentInFlightTurns[agentKey] || null
    : state.inFlightTurn || null;

  const sameTurn =
    activeTracker &&
    (!turnId || !activeTracker.turnId || turnId === activeTracker.turnId);

  let deltaBreakdown = breakdown;
  if (event.type === 'turn.complete') {
    if (sameTurn) {
      const compareBaseline =
        messageId && activeTracker.lastMessageId && messageId === activeTracker.lastMessageId
          ? activeTracker.lastStepTokens
          : activeTracker.committedTokens;
      deltaBreakdown = computePositiveTokenDelta(breakdown, compareBaseline);
    }
    if (isSubagent) {
      delete state.subagentInFlightTurns[agentKey];
    } else {
      state.inFlightTurn = null;
      if (turnId) state.lastCompletedTurnId = turnId;
    }
  } else {
    // turn.step
    state.steps += 1;
    let updatedTracker;
    if (sameTurn) {
      if (messageId && activeTracker.lastMessageId && messageId === activeTracker.lastMessageId) {
        // Streaming chunk update for the same message.id
        deltaBreakdown = computePositiveTokenDelta(breakdown, activeTracker.lastStepTokens);
        updatedTracker = {
          turnId: turnId || activeTracker.turnId || null,
          lastMessageId: messageId,
          lastStepTokens: { ...breakdown },
          committedTokens: {
            uncachedInputTokens:
              activeTracker.committedTokens.uncachedInputTokens + deltaBreakdown.uncachedInputTokens,
            effectiveWrite5mTokens:
              activeTracker.committedTokens.effectiveWrite5mTokens +
              deltaBreakdown.effectiveWrite5mTokens,
            effectiveWrite1hTokens:
              activeTracker.committedTokens.effectiveWrite1hTokens +
              deltaBreakdown.effectiveWrite1hTokens,
            cacheReadTokens:
              activeTracker.committedTokens.cacheReadTokens + deltaBreakdown.cacheReadTokens,
            outputTokens: activeTracker.committedTokens.outputTokens + deltaBreakdown.outputTokens,
            thinkingTokens:
              activeTracker.committedTokens.thinkingTokens + deltaBreakdown.thinkingTokens
          }
        };
      } else {
        // Distinct step within the same open turn
        deltaBreakdown = { ...breakdown };
        updatedTracker = {
          turnId: turnId || activeTracker.turnId || null,
          lastMessageId: messageId || activeTracker.lastMessageId || null,
          lastStepTokens: { ...breakdown },
          committedTokens: {
            uncachedInputTokens:
              activeTracker.committedTokens.uncachedInputTokens + breakdown.uncachedInputTokens,
            effectiveWrite5mTokens:
              activeTracker.committedTokens.effectiveWrite5mTokens + breakdown.effectiveWrite5mTokens,
            effectiveWrite1hTokens:
              activeTracker.committedTokens.effectiveWrite1hTokens + breakdown.effectiveWrite1hTokens,
            cacheReadTokens:
              activeTracker.committedTokens.cacheReadTokens + breakdown.cacheReadTokens,
            outputTokens: activeTracker.committedTokens.outputTokens + breakdown.outputTokens,
            thinkingTokens: activeTracker.committedTokens.thinkingTokens + breakdown.thinkingTokens
          }
        };
      }
    } else {
      deltaBreakdown = { ...breakdown };
      updatedTracker = {
        turnId: turnId || null,
        lastMessageId: messageId || null,
        lastStepTokens: { ...breakdown },
        committedTokens: { ...breakdown }
      };
    }

    if (isSubagent) {
      state.subagentInFlightTurns[agentKey] = updatedTracker;
    } else {
      state.inFlightTurn = updatedTracker;
    }
  }

  // Subagent attribution (`ISS-027`: never overwrite main contextWindow, even if main is 0!)
  if (isSubagent && agentKey) {
    const existingSub = state.subagents[agentKey] || {
      agentId: agentKey,
      turns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      lastActiveAt: nowMs
    };
    const deltaSubPrompt =
      deltaBreakdown.uncachedInputTokens +
      deltaBreakdown.effectiveWrite5mTokens +
      deltaBreakdown.effectiveWrite1hTokens +
      deltaBreakdown.cacheReadTokens;
    const deltaSubOut = deltaBreakdown.outputTokens + deltaBreakdown.thinkingTokens;
    if (!sameTurn || event.type !== 'turn.complete') {
      existingSub.turns += 1;
    }
    existingSub.totalInputTokens += deltaSubPrompt;
    existingSub.totalOutputTokens += deltaSubOut;
    existingSub.totalTokens = existingSub.totalInputTokens + existingSub.totalOutputTokens;
    existingSub.lastActiveAt = nowMs;
    applySubagentLifecycle(existingSub, event, { nowMs, eventType: event.type });
    state.subagents[agentKey] = existingSub;
  }

  // Full single-turn cost snapshot for `lastTurn` and main window metadata
  const fullTurnCost = calculateTurnCostUSD(
    {
      model: effectiveTurnModelRaw,
      inputTokens: uncachedInput,
      outputTokens,
      thinkingTokens,
      cacheWrite5mTokens: write5mTokens,
      cacheWrite1hTokens: write1hTokens,
      cacheReadTokens,
      turnPromptTokens: totalPromptTokens,
      cacheTtlTier: ttlTier
    },
    options
  );

  // Delta cost committed to `state.cumulative` (priced at this turn's `totalPromptTokens` cliff tier)
  if (hasAnyPositiveTokens(deltaBreakdown)) {
    const deltaTurnCost = calculateTurnCostUSD(
      {
        model: effectiveTurnModelRaw,
        inputTokens: deltaBreakdown.uncachedInputTokens,
        outputTokens: deltaBreakdown.outputTokens,
        thinkingTokens: deltaBreakdown.thinkingTokens,
        cacheWrite5mTokens: deltaBreakdown.effectiveWrite5mTokens,
        cacheWrite1hTokens: deltaBreakdown.effectiveWrite1hTokens,
        cacheReadTokens: deltaBreakdown.cacheReadTokens,
        turnPromptTokens: totalPromptTokens,
        cacheTtlTier: ttlTier
      },
      options
    );
    addTurnCostToCumulative(state.cumulative, deltaTurnCost);
  }

  if (event.type === 'turn.complete' && !isSubagent) {
    state.turnsCompleted += 1;
    if (!sameTurn) {
      state.steps += 1;
    }
  }

  if (!isSubagent) {
    const customCeiling = resolveCustomCeilingForModel(effectiveTurnModelRaw, options);
    const resolvedCeiling = Number(customCeiling || fullTurnCost.rates.contextCeiling);
    state.modelLabel = fullTurnCost.rates.label;
    state.contextCeiling = resolvedCeiling;
    state.cliffTriggered = fullTurnCost.cliffTriggered;
    state.preCliffWarningTriggered = fullTurnCost.preCliffWarningTriggered;

    state.contextWindow.totalInputTokens = totalPromptTokens;
    state.contextWindow.uncachedInputTokens = uncachedInput;
    state.contextWindow.cacheReadTokens = cacheReadTokens;
    state.contextWindow.cacheWriteTokens = totalWriteTokens;
    state.contextWindow.warmPrefixTokens = cacheReadTokens + totalWriteTokens;
    state.contextWindow.cachedTokens = cacheReadTokens + totalWriteTokens;
    state.contextWindow.lastWriteTokens = totalWriteTokens;
    state.contextWindow.lastOutputTokens = outputTokens;
    state.contextWindow.lastThinkingTokens = thinkingTokens;
    state.contextWindow.customCeiling = customCeiling || null;
    state.contextWindow.contextCeiling = resolvedCeiling;

    const isWarm = cacheReadTokens > 0 || totalWriteTokens > 0;
    if (isWarm) {
      state.promptCache.warm = true;
      const ttlSeconds = state.promptCache.ttlTier === '1h' ? 3600 : 300;
      state.promptCache.ttlSeconds = ttlSeconds;
      state.promptCache.expiresAt = nowMs + ttlSeconds * 1000;
    }
  }

  const activeMainRates = resolveEffectiveRates(
    state.rawModelId || state.modelId,
    state.contextWindow.totalInputTokens,
    options
  );
  state.cacheRoi = buildCumulativeCacheRoi(state, activeMainRates);
  state.lastTurn = fullTurnCost;

  // Sprint 1 Metrics Wedge. Retention is scored once per distinct API request (prompt-side
  // usage is final on the first chunk of a message); streaming re-sends of the same
  // message.id and turn.complete re-reports of an already-tracked turn are skipped.
  const isNewRequest =
    event.type === 'turn.complete'
      ? !sameTurn
      : !(sameTurn && messageId && activeTracker.lastMessageId && messageId === activeTracker.lastMessageId);
  if (isNewRequest) {
    state.prefixRetention = applyPrefixRetentionRequest(state.prefixRetention, {
      streamKey: isSubagent ? agentKey || 'subagent' : 'main',
      modelId: normalizeModelId(effectiveTurnModelRaw),
      uncachedInputTokens: uncachedInput,
      cacheReadTokens,
      cacheWriteTokens: totalWriteTokens,
      nowMs,
      ttlSeconds: ttlTier === '1h' ? 3600 : 300,
      inputPer1M: fullTurnCost.rates.inputPer1M,
      readPer1M: fullTurnCost.rates.readPer1M
    });
  }
  if (!isSubagent) {
    state.thinkingDrift = applyThinkingDriftEvent(state.thinkingDrift, {
      eventType: event.type === 'turn.complete' ? 'turn.complete' : 'turn.step',
      thinkingTokens: deltaBreakdown.thinkingTokens,
      outputTokens: deltaBreakdown.outputTokens,
      nowMs,
      turnStartedAtMs: normalizeEventTimestampMs(
        event.turnStartedAt ?? event.turn_started_at ?? event.result?.started_at ?? null
      ),
      ttftMs: Number(event.ttftMs ?? event.ttft_ms ?? event.result?.ttft_ms ?? 0) || null,
      turnMutations: Number(event.turnMutations ?? 0) || 0
    });
  }

  exportOtelTelemetry(state, options);

  return state;
}

/**
 * Normalizes an ISO string or epoch (s/ms) timestamp to epoch milliseconds, or `null`.
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
function normalizeEventTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e11 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Ingests a `statusLine` stdin JSON payload into the session telemetry state.
 * Honors `customCeilings.json` ahead of `context_window_size` (`ISS-005`), tracks Turn-1 cold
 * `cacheReadTokens` separately from `cacheWriteTokens` (`ISS-006`), increments `state.steps`
 * on distinct turn envelopes (`ISS-003`), and prevents `WARM | 00:00 (0s)` (`ISS-027`).
 *
 * @param {object} currentState
 * @param {object} statusPayload
 * @param {object} [options={}]
 * @returns {object} Updated state
 */
export function ingestStatusLinePayload(currentState, statusPayload = {}, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const sessionId =
    statusPayload.session_id ||
    statusPayload.sessionId ||
    currentState?.sessionId ||
    'default';
  const rawPayloadModel =
    statusPayload.model?.id ||
    (typeof statusPayload.model === 'string' ? statusPayload.model : null);
  const rawModel =
    rawPayloadModel ||
    currentState?.rawModelId ||
    currentState?.modelId ||
    'claude-sonnet-5-5';

  const prevSource = currentState?.lastSource || 'init';
  const state = currentState
    ? JSON.parse(JSON.stringify(currentState))
    : createInitialTelemetryState(sessionId, rawModel);

  state.sessionId = sanitizeSessionId(sessionId);
  state.rawModelId = String(rawModel);
  state.modelId = normalizeModelId(rawModel);
  state.lastUpdatedAt = nowMs;
  state.lastSource = 'statusLine';

  const cw = statusPayload.context_window || {};
  const currentUsage = cw.current_usage || {};
  const pc = statusPayload.prompt_cache || {};
  const rl = statusPayload.rate_limits || {};

  const ttlInfo = parseTtlInfo(pc.ttl ?? state.promptCache.ttlTier);
  state.promptCache.ttlTier = ttlInfo.ttlTier;

  const hasCurrentUsage =
    Boolean(currentUsage && typeof currentUsage === 'object') &&
    (currentUsage.input_tokens !== undefined ||
      currentUsage.inputTokens !== undefined ||
      currentUsage.uncachedInputTokens !== undefined ||
      currentUsage.freshInputTokens !== undefined ||
      currentUsage.cache_read_input_tokens !== undefined ||
      currentUsage.cacheReadTokens !== undefined ||
      currentUsage.cacheReadInputTokens !== undefined ||
      currentUsage.cache_creation_input_tokens !== undefined ||
      currentUsage.cacheWriteTokens !== undefined ||
      currentUsage.cacheWrite5mTokens !== undefined ||
      currentUsage.cacheWrite1hTokens !== undefined ||
      currentUsage.cache_creation !== undefined);

  const breakdown = extractNormalizedTokenBreakdown({
    ...currentUsage,
    cacheTtlTier: state.promptCache.ttlTier
  });
  const uncachedInput = breakdown.uncachedInputTokens;
  const write5mTokens = breakdown.effectiveWrite5mTokens;
  const write1hTokens = breakdown.effectiveWrite1hTokens;
  const cacheWrite = breakdown.totalCacheWriteTokens;
  const cacheRead = breakdown.cacheReadTokens;
  const outputTokens = breakdown.outputTokens;
  const thinkingTokens = breakdown.thinkingTokens;

  const singleTurnUsagePrompt = uncachedInput + cacheWrite + cacheRead;
  const reportedTotalInput = Math.max(
    0,
    Number(cw.total_input_tokens ?? singleTurnUsagePrompt)
  );
  // Single-turn prompt token count for cliff check (never inflated by multi-turn cumulative sums)
  const turnCliffPromptTokens = hasCurrentUsage ? singleTurnUsagePrompt : reportedTotalInput;

  const customCeiling = resolveCustomCeilingForModel(rawModel, options);
  const rates = resolveEffectiveRates(rawModel, turnCliffPromptTokens, options);
  state.modelLabel = statusPayload.model?.display_name || rates.label;
  state.contextCeiling = Number(customCeiling || cw.context_window_size || rates.contextCeiling);
  state.cliffTriggered = rates.cliffTriggered;
  state.preCliffWarningTriggered = rates.preCliffWarningTriggered;

  state.contextWindow.totalInputTokens = reportedTotalInput;
  state.contextWindow.customCeiling = customCeiling || null;
  state.contextWindow.contextCeiling = state.contextCeiling;
  if (hasCurrentUsage) {
    state.contextWindow.uncachedInputTokens = uncachedInput;
    state.contextWindow.cacheReadTokens = cacheRead;
    state.contextWindow.cacheWriteTokens = cacheWrite;
    state.contextWindow.warmPrefixTokens = cacheRead + cacheWrite;
    state.contextWindow.cachedTokens = cacheRead + cacheWrite;
    state.contextWindow.lastWriteTokens = cacheWrite;
    state.contextWindow.lastOutputTokens = outputTokens;
    state.contextWindow.lastThinkingTokens = thinkingTokens;
  }

  if (typeof cw.system_tokens === 'number' || typeof cw.mcp_tokens === 'number') {
    state.contextWindow.systemAndMcpTokens =
      Math.max(0, Number(cw.system_tokens || 0)) + Math.max(0, Number(cw.mcp_tokens || 0));
  }
  if (typeof cw.distractor_tokens === 'number') {
    state.contextWindow.distractorTokens = Math.max(0, Number(cw.distractor_tokens || 0));
  }

  const parsedExpiresAt = normalizeExpiresAtMs(pc.expires_at, nowMs, ttlInfo.ttlSeconds, false);
  const explicitlyExpired =
    (pc.ttl !== undefined && ttlInfo.ttlSeconds <= 0) ||
    (parsedExpiresAt !== null && parsedExpiresAt <= nowMs);
  const rawWarm =
    typeof pc.warm === 'boolean' ? pc.warm : state.contextWindow.cachedTokens > 0;
  const isWarm = explicitlyExpired ? false : Boolean(rawWarm && ttlInfo.ttlSeconds > 0);
  state.promptCache.warm = isWarm;
  state.promptCache.ttlSeconds = isWarm ? ttlInfo.ttlSeconds : explicitlyExpired ? 0 : ttlInfo.ttlSeconds;
  state.promptCache.expiresAt = isWarm
    ? parsedExpiresAt ?? nowMs + ttlInfo.ttlSeconds * 1000
    : null;

  if (pc.last_miss_cause !== undefined) {
    state.promptCache.lastMissCause = pc.last_miss_cause;
  }

  if (rl.five_hour) state.rateLimits.fiveHour = { ...rl.five_hour };
  if (rl.seven_day) state.rateLimits.sevenDay = { ...rl.seven_day };
  if (rl.spend_limit) state.rateLimits.spendLimit = { ...rl.spend_limit };

  // Detect distinct turn envelope / cost delta on standalone statusLine ticks (`ISS-003`)
  const statusTurnId =
    statusPayload.turn_id ||
    statusPayload.turnId ||
    cw.turn_id ||
    currentUsage.message_id ||
    currentUsage.id ||
    null;
  const rawReportedCost = statusPayload.cost?.total_cost_usd;
  const hasReportedCost = typeof rawReportedCost === 'number' && Number.isFinite(rawReportedCost);
  const costChanged =
    hasReportedCost &&
    (state.lastReportedStatusCostUSD === null ||
      Math.abs(rawReportedCost - state.lastReportedStatusCostUSD) > 1e-9);
  const envelopeSig = `${state.modelId}:${uncachedInput}:${write5mTokens}:${write1hTokens}:${cacheRead}:${outputTokens}:${thinkingTokens}`;

  const alreadyCommittedByMod =
    prevSource.startsWith('mod.turn') &&
    state.lastTurn?.tokens &&
    state.lastTurn.tokens.uncachedInput === uncachedInput &&
    state.lastTurn.tokens.totalCacheWrite === cacheWrite &&
    state.lastTurn.tokens.cacheRead === cacheRead &&
    state.lastTurn.tokens.output === outputTokens;

  const isDuplicateStatusEnvelope =
    (statusTurnId && state.lastStatusTurnId === statusTurnId) ||
    (hasReportedCost && !costChanged && state.lastStatusLineEnvelopeSig === envelopeSig);

  if (hasCurrentUsage && !alreadyCommittedByMod && !isDuplicateStatusEnvelope) {
    const turnCost = calculateTurnCostUSD(
      {
        model: rawModel,
        inputTokens: uncachedInput,
        outputTokens,
        thinkingTokens,
        cacheWrite5mTokens: write5mTokens,
        cacheWrite1hTokens: write1hTokens,
        cacheReadTokens: cacheRead,
        turnPromptTokens: turnCliffPromptTokens,
        cacheTtlTier: state.promptCache.ttlTier
      },
      options
    );
    addTurnCostToCumulative(state.cumulative, turnCost);
    state.steps += 1;
    state.lastTurn = turnCost;
    state.lastStatusLineEnvelopeSig = envelopeSig;
    if (statusTurnId) state.lastStatusTurnId = statusTurnId;
    if (hasReportedCost) state.lastReportedStatusCostUSD = rawReportedCost;
  } else if (!hasCurrentUsage && costChanged && rawReportedCost > (state.lastReportedStatusCostUSD || 0)) {
    state.steps += 1;
    state.lastReportedStatusCostUSD = rawReportedCost;
  }

  if (
    state.steps > 0 ||
    state.cumulative.cacheWrite5mTokens +
      state.cumulative.cacheWrite1hTokens +
      state.cumulative.cacheReadTokens >
      0
  ) {
    state.cacheRoi = buildCumulativeCacheRoi(state, rates);
  }

  return state;
}

/**
 * Atomically writes the telemetry state snapshot to `.claude/cache/ah_live_state_<sessionId>.json`
 * and updates `.claude/cache/ah_live_state.json`.
 *
 * @param {string} sessionId
 * @param {object} state
 * @param {object} [options={}]
 * @returns {{ ok: boolean, sessionPath: string }}
 */
export function writeLiveStateSnapshot(sessionId, state, options = {}) {
  const safeId = sanitizeSessionId(sessionId || state?.sessionId || 'default');
  const sessionPath = getLiveStateBridgePath(safeId, options);
  const okSession = writeJsonAtomic(sessionPath, state, options);

  const cwd = getCwd(options);
  const defaultPath = path.join(cwd, '.claude', 'cache', 'ah_live_state.json');
  writeJsonAtomic(defaultPath, state, options);

  return { ok: okSession, sessionPath };
}

/**
 * Reads the live telemetry state snapshot from `.claude/cache/ah_live_state_<sessionId>.json`.
 * Falls back to `.claude/cache/ah_live_state.json` or a clean initial state.
 *
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {object}
 */
export function readLiveStateSnapshot(sessionId = 'default', options = {}) {
  const safeId = sanitizeSessionId(sessionId);
  const sessionPath = getLiveStateBridgePath(safeId, options);
  const fromSession = readJsonSafe(sessionPath, null, options);
  if (fromSession && typeof fromSession === 'object') {
    return fromSession;
  }

  const cwd = getCwd(options);
  const defaultPath = path.join(cwd, '.claude', 'cache', 'ah_live_state.json');
  const fromDefault = readJsonSafe(defaultPath, null, options);
  if (fromDefault && typeof fromDefault === 'object') {
    return fromDefault;
  }

  return createInitialTelemetryState(safeId, options.defaultModel || 'claude-sonnet-5-5');
}

/**
 * Stateful Dual-Source Telemetry Bridge controller.
 */
export class TelemetryBridge {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.options = options;
    this.sessionId = sanitizeSessionId(options.sessionId || 'default');
    this.state =
      options.initialState ||
      createInitialTelemetryState(this.sessionId, options.defaultModel || 'claude-sonnet-5-5');
  }

  /**
   * Processes a Mod `turn.step` or `turn.complete` event and optionally persists to disk.
   * @param {object} event
   * @param {object} [callOptions={}]
   * @returns {object}
   */
  handleModEvent(event = {}, callOptions = {}) {
    const mergedOpts = { ...this.options, ...callOptions };
    this.state = ingestModTurnEvent(this.state, event, mergedOpts);
    this.sessionId = this.state.sessionId;
    if (mergedOpts.persist !== false) {
      writeLiveStateSnapshot(this.sessionId, this.state, mergedOpts);
    }
    return this.state;
  }

  /**
   * Processes a `statusLine` JSON payload and optionally persists to disk.
   * @param {object} statusPayload
   * @param {object} [callOptions={}]
   * @returns {object}
   */
  handleStatusLine(statusPayload = {}, callOptions = {}) {
    const mergedOpts = { ...this.options, ...callOptions };
    this.state = ingestStatusLinePayload(this.state, statusPayload, mergedOpts);
    this.sessionId = this.state.sessionId;
    if (mergedOpts.persist !== false) {
      writeLiveStateSnapshot(this.sessionId, this.state, mergedOpts);
    }
    return this.state;
  }

  /**
   * Returns current session state.
   * @returns {object}
   */
  getState() {
    return this.state;
  }
}

export default {
  sanitizeSessionId,
  getLiveStateBridgePath,
  computeCacheRoi,
  createInitialTelemetryState,
  ingestModTurnEvent,
  ingestStatusLinePayload,
  writeLiveStateSnapshot,
  readLiveStateSnapshot,
  TelemetryBridge
};
