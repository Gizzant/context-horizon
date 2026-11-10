import { EventEmitter } from 'node:events';
import { SESSION_RISK_THRESHOLDS } from '../constants.mjs';

/**
 * Phase 1.3: 300s Implicit Cache TTL Watchdog (`src/core/telemetry/cache_ttl_watchdog.mjs`)
 *
 * Strictly read-only telemetry clock with zero side effects.
 * Tracks elapsed idle time since the last completed Language Server turn when `cachedTokens >= 50000`:
 *  - Emits `TTL_WARNING_PULSE` at `T-45s` (`255s` elapsed)
 *  - Emits `TTL_PRE_SNAPSHOT` at `T-10s` (`290s` elapsed) so `handoff_hydrator.mjs` can pre-stage a disk bundle
 *  - Emits `TTL_EXPIRED_COLD_RISK` at `T-0s` (`300s` elapsed)
 */

export const CACHE_TTL_WATCHDOG_CONSTANTS = Object.freeze({
  TTL_WINDOW_SECONDS: 300,
  WARM_CACHE_MIN_TOKENS: SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS,
  WARNING_PULSE_ELAPSED_SEC: 255, // T-45s
  PRE_SNAPSHOT_ELAPSED_SEC: 290,  // T-10s
  EXPIRED_ELAPSED_SEC: 300        // T-0s
});

export function formatTtlCountdown(ttlRemainingSeconds = 0) {
  const rem = Math.max(0, Math.floor(Number(ttlRemainingSeconds) || 0));
  const mins = Math.floor(rem / 60);
  const secs = rem % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

export class CacheTtlWatchdog extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ttlWindowSeconds = Number(options.ttlWindowSeconds || CACHE_TTL_WATCHDOG_CONSTANTS.TTL_WINDOW_SECONDS);
    this.warmCacheMinTokens = Number(options.warmCacheMinTokens || CACHE_TTL_WATCHDOG_CONSTANTS.WARM_CACHE_MIN_TOKENS);
    this.sessionId = String(options.sessionId || 'default');
    this.cachedTokens = Math.max(0, Number(options.cachedTokens || 0));
    this.lastCompletedTurnTimestampMs = Number(options.lastCompletedTurnTimestampMs || Date.now());
    this.emittedFlags = {
      warningPulse: false,
      preSnapshot: false,
      expiredColdRisk: false
    };
    this._intervalHandle = null;

    if (typeof options.onPreSnapshot === 'function') {
      this.on('TTL_PRE_SNAPSHOT', options.onPreSnapshot);
    }
  }

  /**
   * Resets the 300s countdown clock when a Language Server turn completes.
   */
  recordTurnCompleted({ sessionId = this.sessionId, cachedTokens = this.cachedTokens, timestampMs = Date.now() } = {}) {
    this.sessionId = String(sessionId || this.sessionId);
    this.cachedTokens = Math.max(0, Number(cachedTokens || 0));
    this.lastCompletedTurnTimestampMs = Number(timestampMs || Date.now());
    this.emittedFlags = {
      warningPulse: false,
      preSnapshot: false,
      expiredColdRisk: false
    };
    return this.getStatus(0);
  }

  /**
   * Evaluates a specific `elapsedSeconds` value (or computes it from `nowMs`) and emits threshold events.
   */
  evaluateElapsed(elapsedSecondsInput = null, overrides = {}) {
    if (overrides.cachedTokens !== undefined) {
      this.cachedTokens = Math.max(0, Number(overrides.cachedTokens || 0));
    }
    if (overrides.sessionId !== undefined) {
      this.sessionId = String(overrides.sessionId);
    }

    const elapsedSeconds = elapsedSecondsInput !== null && elapsedSecondsInput !== undefined
      ? Math.max(0, Number(elapsedSecondsInput))
      : Math.max(0, (Number(overrides.nowMs || Date.now()) - this.lastCompletedTurnTimestampMs) / 1000);

    const ttlRemainingSeconds = Math.max(0, Number((this.ttlWindowSeconds - elapsedSeconds).toFixed(1)));
    const isArmed = this.cachedTokens >= this.warmCacheMinTokens;
    const eventsEmitted = [];

    if (isArmed) {
      if (elapsedSeconds >= CACHE_TTL_WATCHDOG_CONSTANTS.WARNING_PULSE_ELAPSED_SEC && !this.emittedFlags.warningPulse) {
        this.emittedFlags.warningPulse = true;
        const payload = {
          event: 'TTL_WARNING_PULSE',
          sessionId: this.sessionId,
          cachedTokens: this.cachedTokens,
          elapsedSeconds: Math.round(elapsedSeconds),
          ttlRemainingSeconds: Math.max(0, this.ttlWindowSeconds - Math.round(elapsedSeconds)),
          formattedCountdown: formatTtlCountdown(this.ttlWindowSeconds - elapsedSeconds)
        };
        eventsEmitted.push('TTL_WARNING_PULSE');
        this.emit('TTL_WARNING_PULSE', payload);
      }

      if (elapsedSeconds >= CACHE_TTL_WATCHDOG_CONSTANTS.PRE_SNAPSHOT_ELAPSED_SEC && !this.emittedFlags.preSnapshot) {
        this.emittedFlags.preSnapshot = true;
        const payload = {
          event: 'TTL_PRE_SNAPSHOT',
          sessionId: this.sessionId,
          cachedTokens: this.cachedTokens,
          elapsedSeconds: Math.round(elapsedSeconds),
          ttlRemainingSeconds: Math.max(0, this.ttlWindowSeconds - Math.round(elapsedSeconds)),
          formattedCountdown: formatTtlCountdown(this.ttlWindowSeconds - elapsedSeconds)
        };
        eventsEmitted.push('TTL_PRE_SNAPSHOT');
        this.emit('TTL_PRE_SNAPSHOT', payload);
      }

      if (elapsedSeconds >= CACHE_TTL_WATCHDOG_CONSTANTS.EXPIRED_ELAPSED_SEC && !this.emittedFlags.expiredColdRisk) {
        this.emittedFlags.expiredColdRisk = true;
        const payload = {
          event: 'TTL_EXPIRED_COLD_RISK',
          sessionId: this.sessionId,
          cachedTokens: this.cachedTokens,
          elapsedSeconds: Math.round(elapsedSeconds),
          ttlRemainingSeconds: 0,
          formattedCountdown: '0m 00s'
        };
        eventsEmitted.push('TTL_EXPIRED_COLD_RISK');
        this.emit('TTL_EXPIRED_COLD_RISK', payload);
      }
    }

    return {
      sessionId: this.sessionId,
      isArmed,
      cachedTokens: this.cachedTokens,
      elapsedSeconds: Math.round(elapsedSeconds),
      ttlRemainingSeconds: Math.round(ttlRemainingSeconds),
      formattedCountdown: formatTtlCountdown(ttlRemainingSeconds),
      state: !isArmed
        ? 'BELOW_WARM_THRESHOLD'
        : (elapsedSeconds >= CACHE_TTL_WATCHDOG_CONSTANTS.EXPIRED_ELAPSED_SEC
          ? 'TTL_EXPIRED_COLD_RISK'
          : (elapsedSeconds >= CACHE_TTL_WATCHDOG_CONSTANTS.PRE_SNAPSHOT_ELAPSED_SEC
            ? 'TTL_PRE_SNAPSHOT'
            : (elapsedSeconds >= CACHE_TTL_WATCHDOG_CONSTANTS.WARNING_PULSE_ELAPSED_SEC
              ? 'TTL_WARNING_PULSE'
              : 'WARM_ACTIVE'))),
      eventsEmitted
    };
  }

  getStatus(elapsedSecondsInput = null) {
    return this.evaluateElapsed(elapsedSecondsInput);
  }

  startPolling(intervalMs = 1000) {
    this.stopPolling();
    this._intervalHandle = setInterval(() => {
      this.evaluateElapsed();
    }, intervalMs);
    if (this._intervalHandle && typeof this._intervalHandle.unref === 'function') {
      this._intervalHandle.unref();
    }
    return this;
  }

  stopPolling() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }
}

export default CacheTtlWatchdog;
