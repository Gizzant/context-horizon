/**
 * @file src/coach/ttlWatchdog.mjs
 * 5-Minute Anthropic KV-Cache TTL Cliff Watchdog, Zero-Token `StateBaton` T-10s Pre-Snapshotter,
 * and Inter-Turn Pause Distribution Analyzer (>= 3.1% 5m-to-60m pause ratio -> 1h tier recommendation).
 *
 * Strictly zero outbound network sockets: never sends synthetic un-credentialed HTTPS pings.
 */

import {
  normalizeModelId,
  computeTotalPromptTokens,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';
import { FLIGHT_MODES, normalizeFlightMode, isSilentOrOffMode } from './cacheGravityRouter.mjs';

export const DEFAULT_MIN_CACHED_TOKENS_FOR_WATCHDOG = 25000;
export const DEFAULT_AMBER_THRESHOLD_SECONDS = 45;
export const DEFAULT_KEEP_ALIVE_THRESHOLD_SECONDS = 15;
export const DEFAULT_SNAPSHOT_THRESHOLD_SECONDS = 10;
export const ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD = 0.031; // 3.1% (~1 in 30 turns)
export const FIVE_MINUTES_SECONDS = 300;
export const SIXTY_MINUTES_SECONDS = 3600;

/**
 * Formats remaining seconds into compact `4m12s` or `42s` display format.
 * @param {number} remainingSeconds
 * @returns {string}
 */
export function formatRemainingTtl(remainingSeconds = 0) {
  const sec = Math.max(0, Math.floor(Number(remainingSeconds || 0)));
  if (sec <= 0) return '0s';
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins === 0) return `${remSec}s`;
  return `${mins}m${String(remSec).padStart(2, '0')}s`;
}

/**
 * Builds a lightweight zero-token `StateBaton` pre-snapshot at T-10s before cache expiry.
 * @param {object} context
 * @returns {object}
 */
export function buildPreExpiryStateBaton(context = {}) {
  return {
    schemaVersion: '2026.11.1',
    trigger: 'TTL_T_MINUS_10S_PRE_SNAPSHOT',
    createdAt: context.nowMs || Date.now(),
    sessionId: context.sessionId || 'default',
    modelId: normalizeModelId(context.modelId || 'claude-opus-5-5'),
    cachedTokensAtSnapshot: Math.max(0, Number(context.cachedTokens || 0)),
    remainingSeconds: Math.max(0, Number(context.remainingSeconds || 0)),
    activeGoal: context.activeGoal || 'Preserve active implementation state across 5m KV-cache TTL boundary',
    workingSetFiles: Array.isArray(context.workingSetFiles) ? [...context.workingSetFiles] : [],
    verifiedInvariants: Array.isArray(context.verifiedInvariants) ? [...context.verifiedInvariants] : [],
    deadEndsAndFailures: Array.isArray(context.deadEndsAndFailures) ? [...context.deadEndsAndFailures] : [],
    queuedCacheMutations: Array.isArray(context.queuedCacheMutations) ? [...context.queuedCacheMutations] : []
  };
}

/**
 * Evaluates inter-turn pause durations (in seconds) and advises upgrading the session
 * cache tier to `1h` when `>= 3.1%` of pauses fall in the un-pinged 5-to-60 minute window.
 *
 * @param {Array<number>} pauseDurationsSeconds - Array of inter-turn pause durations in seconds
 * @param {number} [thresholdRatio=0.031]
 * @returns {{
 *   totalIntervals: number,
 *   fiveToSixtyMinCount: number,
 *   fiveToSixtyMinRatio: number,
 *   fiveToSixtyMinPct: number,
 *   thresholdRatio: number,
 *   recommend1hTierUpgrade: boolean,
 *   advisoryMessage: string | null
 * }}
 */
export function evaluatePauseDistribution(
  pauseDurationsSeconds = [],
  thresholdRatio = ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD
) {
  const validPauses = Array.isArray(pauseDurationsSeconds)
    ? pauseDurationsSeconds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 0)
    : [];

  const totalIntervals = validPauses.length;
  if (totalIntervals === 0) {
    return {
      totalIntervals: 0,
      fiveToSixtyMinCount: 0,
      fiveToSixtyMinRatio: 0,
      fiveToSixtyMinPct: 0,
      thresholdRatio,
      recommend1hTierUpgrade: false,
      advisoryMessage: null
    };
  }

  const fiveToSixtyMinCount = validPauses.filter(
    (sec) => sec > FIVE_MINUTES_SECONDS && sec <= SIXTY_MINUTES_SECONDS
  ).length;

  const fiveToSixtyMinRatio = Number((fiveToSixtyMinCount / totalIntervals).toFixed(4));
  const fiveToSixtyMinPct = Number((fiveToSixtyMinRatio * 100).toFixed(2));
  const recommend1hTierUpgrade = fiveToSixtyMinRatio >= thresholdRatio;

  const advisoryMessage = recommend1hTierUpgrade
    ? `Inter-turn pause telemetry: ${fiveToSixtyMinPct}% of turns (${fiveToSixtyMinCount}/${totalIntervals}) ` +
      `followed a 5-to-60 minute pause (>= ${(thresholdRatio * 100).toFixed(1)}% break-even threshold). ` +
      `Upgrade session prompt cache tier from 5m (1.25x) to 1h (2.0x) to prevent recurring cold prefix rewrites.`
    : null;

  return {
    totalIntervals,
    fiveToSixtyMinCount,
    fiveToSixtyMinRatio,
    fiveToSixtyMinPct,
    thresholdRatio,
    recommend1hTierUpgrade,
    advisoryMessage
  };
}

/**
 * 5-Minute TTL Cliff Watchdog.
 * Tracks `prompt_cache.expires_at` on a 1-second tick, pulses amber countdown alerts at `<= 45s`,
 * takes zero-token `StateBaton` pre-snapshots at `T-10s` in `AUTO_PILOT` mode, and tracks
 * inter-turn pause distribution (`>= 3.1%` -> recommend `1h` cache tier).
 */
export class TtlWatchdog {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.options = options;
    this.mode = normalizeFlightMode(options.mode || FLIGHT_MODES.COACH);
    this.minCachedTokens = Number(
      options.minCachedTokens ?? DEFAULT_MIN_CACHED_TOKENS_FOR_WATCHDOG
    );
    this.amberThresholdSeconds = Number(
      options.amberThresholdSeconds ?? DEFAULT_AMBER_THRESHOLD_SECONDS
    );
    this.keepAliveThresholdSeconds = Number(
      options.keepAliveThresholdSeconds ?? DEFAULT_KEEP_ALIVE_THRESHOLD_SECONDS
    );
    this.snapshotThresholdSeconds = Number(
      options.snapshotThresholdSeconds ?? DEFAULT_SNAPSHOT_THRESHOLD_SECONDS
    );
    this.pauseRatioThreshold = Number(
      options.pauseRatioThreshold ?? ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD
    );

    this.lastTurnTimestampMs = options.lastTurnTimestampMs ?? null;
    this.pauseDurationsSeconds = Array.isArray(options.pauseDurationsSeconds)
      ? [...options.pauseDurationsSeconds]
      : [];
    this.lastFileChangedAtMs = options.lastFileChangedAtMs ?? null;
    this.workingSetFiles = new Set(options.workingSetFiles || []);
    this.lastSnapshotExpiryCycle = null;
    this.lastKeepAliveExpiryCycle = null;
    this.latestSnapshot = null;
    this.onSnapshotCallback = typeof options.onSnapshot === 'function' ? options.onSnapshot : null;
    this.onKeepAliveCallback =
      typeof options.onKeepAlive === 'function' ? options.onKeepAlive : null;
    this.enableLocalKeepAlive = Boolean(options.enableLocalKeepAlive);
  }

  /**
   * Sets Flight Computer mode (`OFF | COACH | AUTO_PILOT`).
   * @param {string} mode
   */
  setMode(mode) {
    this.mode = normalizeFlightMode(mode);
    return this.mode;
  }

  /**
   * Records a workspace `FileChanged` event so the watchdog knows active edits are in progress.
   * @param {string} [filePath]
   * @param {number} [nowMs=Date.now()]
   */
  recordFileChanged(filePath = '', nowMs = Date.now()) {
    this.lastFileChangedAtMs = nowMs;
    if (filePath) {
      this.workingSetFiles.add(String(filePath));
    }
  }

  /**
   * Clears the recent workspace edit flag (e.g. after commit, test pass, or compaction).
   */
  clearRecentEdits() {
    this.lastFileChangedAtMs = null;
    this.workingSetFiles.clear();
  }

  /**
   * Records a turn timestamp and updates inter-turn pause distribution telemetry.
   * @param {number} [nowMs=Date.now()]
   * @returns {object} Pause distribution summary
   */
  recordTurnTimestamp(nowMs = Date.now()) {
    if (this.lastTurnTimestampMs !== null && nowMs >= this.lastTurnTimestampMs) {
      const pauseSec = (nowMs - this.lastTurnTimestampMs) / 1000;
      this.pauseDurationsSeconds.push(Number(pauseSec.toFixed(2)));
    }
    this.lastTurnTimestampMs = nowMs;
    return this.getPauseDistribution();
  }

  /**
   * Directly records an inter-turn pause duration in seconds.
   * @param {number} pauseSeconds
   * @returns {object} Pause distribution summary
   */
  recordPauseDurationSeconds(pauseSeconds) {
    const sec = Number(pauseSeconds);
    if (Number.isFinite(sec) && sec >= 0) {
      this.pauseDurationsSeconds.push(sec);
    }
    return this.getPauseDistribution();
  }

  /**
   * Evaluates current inter-turn pause distribution against the 3.1% 1h-tier threshold.
   */
  getPauseDistribution() {
    return evaluatePauseDistribution(this.pauseDurationsSeconds, this.pauseRatioThreshold);
  }

  /**
   * Evaluates a 1-second watchdog tick against the active prompt cache expiration deadline.
   *
   * @param {object} [tickState={}]
   * @param {boolean} [tickState.cacheWarm=false]
   * @param {number} [tickState.cachedTokens=0]
   * @param {number|string|null} [tickState.expiresAt=null] - Epoch ms or ISO timestamp
   * @param {number} [tickState.remainingSeconds] - Optional explicit remaining seconds
   * @param {string} [tickState.modelId='claude-opus-5-5']
   * @param {boolean} [tickState.hasRecentWorkspaceEdits] - Defaults to true if FileChanged recorded
   * @param {string} [tickState.mode] - Optional mode override (`OFF | COACH | AUTO_PILOT`)
   * @param {number} [tickState.nowMs=Date.now()]
   */
  evaluateTick(tickState = {}) {
    const nowMs = tickState.nowMs ?? Date.now();
    const activeMode = tickState.mode ? normalizeFlightMode(tickState.mode) : this.mode;
    const modelId = normalizeModelId(tickState.modelId || 'claude-opus-5-5');
    const cachedTokens = Math.max(0, Number(tickState.cachedTokens ?? 0));

    const force5mDrop =
      Boolean(tickState.aiCreditOveragesActive) ||
      Boolean(tickState.isSubagent) ||
      String(tickState.billingMode || '').toLowerCase() === 'api';
    const effectiveTtlSeconds =
      tickState.planDefaultTtlSeconds != null
        ? (force5mDrop ? FIVE_MINUTES_SECONDS : Math.max(60, Number(tickState.planDefaultTtlSeconds)))
        : ((tickState.cacheTtlTier || tickState.ttlTier || this.options?.cacheTtlTier) === '1h'
            ? (force5mDrop ? FIVE_MINUTES_SECONDS : SIXTY_MINUTES_SECONDS)
            : FIVE_MINUTES_SECONDS);
    const ttlDroppedTo5m =
      (tickState.planDefaultTtlSeconds != null && Number(tickState.planDefaultTtlSeconds) > FIVE_MINUTES_SECONDS && effectiveTtlSeconds === FIVE_MINUTES_SECONDS) ||
      (((tickState.cacheTtlTier || tickState.ttlTier || this.options?.cacheTtlTier) === '1h') && force5mDrop);

    let expiresAtMs = null;
    if (typeof tickState.expiresAt === 'number' && Number.isFinite(tickState.expiresAt)) {
      expiresAtMs = tickState.expiresAt < 1e11 ? tickState.expiresAt * 1000 : tickState.expiresAt;
    } else if (typeof tickState.expiresAt === 'string' && tickState.expiresAt.trim()) {
      const parsed = Date.parse(tickState.expiresAt);
      if (!Number.isNaN(parsed)) expiresAtMs = parsed;
    }

    let remainingSeconds = 0;
    if (typeof tickState.remainingSeconds === 'number' && Number.isFinite(tickState.remainingSeconds)) {
      remainingSeconds = Math.max(0, Math.ceil(tickState.remainingSeconds));
      if (expiresAtMs === null) {
        expiresAtMs = nowMs + remainingSeconds * 1000;
      }
    } else if (expiresAtMs !== null) {
      remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
    } else if (typeof tickState.elapsedSeconds === 'number' && Number.isFinite(tickState.elapsedSeconds)) {
      remainingSeconds = Math.max(0, Math.ceil(effectiveTtlSeconds - Math.max(0, tickState.elapsedSeconds)));
      expiresAtMs = nowMs + remainingSeconds * 1000;
    }

    const cacheExpired =
      typeof tickState.elapsedSeconds === 'number'
        ? tickState.elapsedSeconds > effectiveTtlSeconds
        : remainingSeconds <= 0 && cachedTokens > 0 && tickState.cacheWarm === false;

    const cacheWarm =
      tickState.cacheWarm !== undefined
        ? Boolean(tickState.cacheWarm) && !cacheExpired
        : cachedTokens > 0 && !cacheExpired;

    const hasRecentWorkspaceEdits =
      tickState.hasRecentWorkspaceEdits !== undefined
        ? Boolean(tickState.hasRecentWorkspaceEdits)
        : this.lastFileChangedAtMs !== null;

    const tier = effectiveTtlSeconds >= SIXTY_MINUTES_SECONDS ? '1h' : '5m';
    const totalPromptTokens = Math.max(cachedTokens, computeTotalPromptTokens(tickState));
    const rates = resolveEffectiveRates(
      tickState.modelId || 'claude-opus-5-5',
      totalPromptTokens,
      this.options
    );
    const writeRate = tier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;
    // Cost of losing the warm cache and rewriting it at writeRate (1.25x 5m / 2.0x 1h) instead of reading at readPer1M
    const expiryPenaltyUSD = Number(
      ((cachedTokens / 1_000_000) * (writeRate - rates.readPer1M)).toFixed(6)
    );

    const formattedRemaining = formatRemainingTtl(remainingSeconds);
    const pauseDistribution = this.getPauseDistribution();

    const suppressed = isSilentOrOffMode(activeMode);
    const meetsWatchdogCriteria =
      !suppressed &&
      cacheWarm &&
      cachedTokens >= this.minCachedTokens &&
      remainingSeconds > 0 &&
      remainingSeconds <= this.amberThresholdSeconds &&
      hasRecentWorkspaceEdits;

    if (!meetsWatchdogCriteria) {
      let statusReason = 'IDLE';
      if (suppressed) {
        statusReason = 'MODE_SILENT';
      } else if (!cacheWarm || remainingSeconds <= 0) {
        statusReason = 'CACHE_COLD_OR_EXPIRED';
      } else if (cachedTokens < this.minCachedTokens) {
        statusReason = 'BELOW_MIN_CACHED_TOKENS';
      } else if (!hasRecentWorkspaceEdits) {
        statusReason = 'IDLE_NO_EDITS';
      } else if (remainingSeconds > this.amberThresholdSeconds) {
        statusReason = 'TTL_HEALTHY';
      }

      return {
        detectorId: 'DET-10',
        mode: activeMode,
        statusReason,
        effectiveTtlSeconds,
        ttlDroppedTo5m,
        cacheExpired,
        cacheWarm: cacheWarm && remainingSeconds > 0,
        cachedTokens,
        remainingSeconds,
        formattedRemaining,
        amberAlertActive: false,
        alertLevel: (remainingSeconds === 0 && cacheWarm) || cacheExpired ? 'EXPIRED' : 'NONE',
        expiryPenaltyUSD,
        availableActions: [],
        preSnapshotTriggered: false,
        stateBatonSnapshot: null,
        bannerText: null,
        pauseDistribution
      };
    }

    // Amber alert is active (remainingSeconds <= 45)
    let alertLevel = 'AMBER';
    let preSnapshotTriggered = false;
    let keepAliveTriggered = false;
    let stateBatonSnapshot = null;
    const availableActions =
      activeMode === FLIGHT_MODES.COACH
        ? ['KEEP_ALIVE_PROMPT', 'SNAPSHOT_STATE_BATON']
        : ['AUTO_SNAPSHOT_STATE_BATON', 'LOCAL_CLI_KEEP_ALIVE'];

    const cycleKey = expiresAtMs ? Math.round(expiresAtMs / 1000) : 'active_cycle';

    if (
      activeMode === FLIGHT_MODES.AUTO_PILOT &&
      (this.enableLocalKeepAlive || tickState.optInLocalKeepAlive === true) &&
      remainingSeconds <= this.keepAliveThresholdSeconds &&
      this.lastKeepAliveExpiryCycle !== cycleKey
    ) {
      this.lastKeepAliveExpiryCycle = cycleKey;
      keepAliveTriggered = true;
      if (this.onKeepAliveCallback) {
        this.onKeepAliveCallback({
          sessionId: tickState.sessionId || 'default',
          modelId,
          cachedTokens,
          remainingSeconds,
          expiryPenaltyUSD
        });
      }
    }

    if (
      remainingSeconds <= this.snapshotThresholdSeconds &&
      (activeMode === FLIGHT_MODES.AUTO_PILOT || tickState.optInAutoSnapshot === true)
    ) {
      alertLevel = 'CRITICAL_SNAPSHOT';
      if (this.lastSnapshotExpiryCycle !== cycleKey) {
        this.lastSnapshotExpiryCycle = cycleKey;
        preSnapshotTriggered = true;
        stateBatonSnapshot = buildPreExpiryStateBaton({
          nowMs,
          sessionId: tickState.sessionId || 'default',
          modelId,
          cachedTokens,
          remainingSeconds,
          activeGoal: tickState.activeGoal,
          workingSetFiles:
            tickState.workingSetFiles || Array.from(this.workingSetFiles),
          verifiedInvariants: tickState.verifiedInvariants,
          deadEndsAndFailures: tickState.deadEndsAndFailures,
          queuedCacheMutations: tickState.queuedCacheMutations
        });
        this.latestSnapshot = stateBatonSnapshot;
        if (this.onSnapshotCallback) {
          this.onSnapshotCallback(stateBatonSnapshot);
        }
      } else {
        stateBatonSnapshot = this.latestSnapshot;
      }
    }

    const bannerText = preSnapshotTriggered
      ? `amber TTL cliff (${formattedRemaining}): zero-token StateBaton pre-snapshot saved at T-${remainingSeconds}s (protects ${(cachedTokens / 1000).toFixed(1)}k cache / $${expiryPenaltyUSD.toFixed(2)} rewrite).`
      : `amber TTL warning (${formattedRemaining}): ${(cachedTokens / 1000).toFixed(1)}k warm cache on ${rates.shortLabel} expires soon (+$${expiryPenaltyUSD.toFixed(2)} rewrite penalty).`;

    return {
      detectorId: 'DET-10',
      mode: activeMode,
      statusReason: preSnapshotTriggered ? 'PRE_SNAPSHOT_SAVED' : 'AMBER_WARNING',
      effectiveTtlSeconds,
      ttlDroppedTo5m,
      cacheExpired,
      cacheWarm: true,
      cachedTokens,
      remainingSeconds,
      formattedRemaining,
      amberAlertActive: true,
      alertLevel,
      expiryPenaltyUSD,
      availableActions,
      keepAliveTriggered,
      preSnapshotTriggered,
      stateBatonSnapshot,
      bannerText,
      pauseDistribution
    };
  }
}

export default {
  DEFAULT_MIN_CACHED_TOKENS_FOR_WATCHDOG,
  DEFAULT_AMBER_THRESHOLD_SECONDS,
  DEFAULT_SNAPSHOT_THRESHOLD_SECONDS,
  ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD,
  formatRemainingTtl,
  buildPreExpiryStateBaton,
  evaluatePauseDistribution,
  TtlWatchdog
};
