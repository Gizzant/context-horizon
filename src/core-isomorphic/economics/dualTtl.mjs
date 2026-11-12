/**
 * @file src/core-isomorphic/economics/dualTtl.mjs
 * Feature 21: 1s Live Dual-TTL Countdown & Pause Distribution Analyzer.
 *
 * Implements:
 *   - 5-Minute (300s) Ephemeral Prompt Cache TTL Countdown
 *   - 1-Hour (3,600s) Rolling Billing Block TTL Countdown
 *   - Sub-second accuracy clamped cleanly at "00:00" without negative rollover
 *   - Inter-turn pause distribution analyzer (recommends 1h tier upgrade when >= 3.1% pauses are 5m-60m)
 *   - Amber warning at <= 45s, Keep-alive at <= 15s, T-10s StateBaton pre-snapshot
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

export const DUAL_TTL_CONSTANTS = Object.freeze({
  CACHE_TTL_MS: 300000,          // 5 minutes
  BILLING_TTL_MS: 3600000,       // 1 hour
  CACHE_TTL_SEC: 300,
  BILLING_TTL_SEC: 3600,
  AMBER_ALERT_SEC: 45,
  KEEP_ALIVE_SEC: 15,
  SNAPSHOT_SEC: 10,
  ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD: 0.031 // 3.1%
});

/**
 * Formats seconds into digital countdown clock notation "MM:SS".
 * Clamps negative or non-finite values to "00:00".
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatMmSs(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
}

/**
 * Formats remaining seconds into compact human-readable display e.g. "4m12s" or "42s".
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
 * Calculates live Dual-TTL countdown for 5-minute cache TTL and 1-hour billing TTL.
 *
 * @param {number} lastTurnTimestamp Epoch ms when last turn/cache event finished
 * @param {number} [now=Date.now()] Current epoch ms
 * @param {number} [cacheTtlMs=300000] Ephemeral cache window (default 300,000ms = 5m)
 * @param {number} [billingTtlMs=3600000] Billing block TTL (default 3,600,000ms = 1h)
 * @param {object} [options={}] Optional configuration (e.g. { rolling: boolean })
 * @returns {{
 *   cacheTtlSec: number,
 *   billingTtlSec: number,
 *   formattedCacheTtl: string,
 *   formattedBillingTtl: string,
 *   isCacheExpired: boolean,
 *   isBillingExpired: boolean
 * }}
 */
export function calculateDualTtlCountdown(
  lastTurnTimestamp,
  now = Date.now(),
  cacheTtlMs = DUAL_TTL_CONSTANTS.CACHE_TTL_MS,
  billingTtlMs = DUAL_TTL_CONSTANTS.BILLING_TTL_MS,
  options = {}
) {
  const elapsedMs = Math.max(0, now - lastTurnTimestamp);
  const cacheRemainingMs = Math.max(0, cacheTtlMs - elapsedMs);

  const isRolling = Boolean(options.rolling);
  const billingRemainingMs = isRolling
    ? (elapsedMs >= billingTtlMs && elapsedMs % billingTtlMs === 0
        ? 0
        : Math.max(0, billingTtlMs - (elapsedMs % billingTtlMs)))
    : Math.max(0, billingTtlMs - elapsedMs);

  const cacheTtlSec = Math.floor(cacheRemainingMs / 1000);
  const billingTtlSec = Math.floor(billingRemainingMs / 1000);

  return {
    cacheTtlSec,
    billingTtlSec,
    formattedCacheTtl: formatMmSs(cacheTtlSec),
    formattedBillingTtl: formatMmSs(billingTtlSec),
    isCacheExpired: cacheRemainingMs === 0,
    isBillingExpired: elapsedMs >= billingTtlMs
  };
}

/**
 * Evaluates inter-turn pause durations (in seconds) and advises upgrading the session
 * prompt cache tier to 1h when >= 3.1% of pauses fall between 5m and 60m.
 *
 * @param {Array<number>} pauseDurationsSeconds
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
  thresholdRatio = DUAL_TTL_CONSTANTS.ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD
) {
  const validPauses = Array.isArray(pauseDurationsSeconds)
    ? pauseDurationsSeconds.map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0)
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
    sec => sec > DUAL_TTL_CONSTANTS.CACHE_TTL_SEC && sec <= DUAL_TTL_CONSTANTS.BILLING_TTL_SEC
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
 * Stateful Dual-TTL countdown tracker.
 */
export class DualTtlTracker {
  constructor(options = {}) {
    this.cacheTtlMs = options.cacheTtlMs || DUAL_TTL_CONSTANTS.CACHE_TTL_MS;
    this.billingTtlMs = options.billingTtlMs || DUAL_TTL_CONSTANTS.BILLING_TTL_MS;
    this.rolling = Boolean(options.rolling);
    this.lastTurnTimestamp = Date.now();
    this.pauseDurationsSeconds = [];
  }

  recordTurn(now = Date.now()) {
    if (this.lastTurnTimestamp > 0) {
      const pauseSec = Math.max(0, Math.floor((now - this.lastTurnTimestamp) / 1000));
      this.pauseDurationsSeconds.push(pauseSec);
    }
    this.lastTurnTimestamp = now;
  }

  getCountdown(now = Date.now()) {
    return calculateDualTtlCountdown(
      this.lastTurnTimestamp,
      now,
      this.cacheTtlMs,
      this.billingTtlMs,
      { rolling: this.rolling }
    );
  }

  getPauseAnalysis() {
    return evaluatePauseDistribution(this.pauseDurationsSeconds);
  }
}

export { TtlWatchdog } from '../coach/ttlWatchdog.mjs';
