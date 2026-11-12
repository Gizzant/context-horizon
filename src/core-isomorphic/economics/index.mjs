/**
 * @file src/core-isomorphic/economics/index.mjs
 * Unified Token Economics, Latency Telemetry, and Cache Retention Radar Module.
 *
 * Consolidates:
 *   - Feature 17: TTFT & Thinking Drift Detection (`driftLatency.mjs`)
 *   - Feature 18: 95% Prefix-Cache Retention Radar (`retentionRadar.mjs`)
 *   - Feature 19: Algebraic C* Break-Even Router (`cacheGravity.mjs`)
 *   - Feature 20: Haiku 100k 5x Cliff Breaker (`cliffBreaker.mjs`)
 *   - Feature 21: 1s Live Dual-TTL Countdown (`dualTtl.mjs`)
 *   - Feature 22: 5-Hour Rolling Billing Blocks (`billingBlocks.mjs`)
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

export * from './driftLatency.mjs';
export * from './retentionRadar.mjs';
export * from './cacheGravity.mjs';
export * from './cliffBreaker.mjs';
export * from './dualTtl.mjs';
export * from './billingBlocks.mjs';

// Coach & Ledger backward-compatible exports (without duplicate export conflicts)
export {
  PostCompactMutationQueue,
  HysteresisLock,
  CacheGravityRouter,
  isPrefixInstructionFile,
  normalizeFlightMode,
  isSilentOrOffMode,
  DEFAULT_ADVISORY_COOLDOWN_TURNS,
  evaluatePreModelSwitch,
  evaluateDet09PrefixMutationFence
} from '../coach/cacheGravityRouter.mjs';

export {
  buildPreExpiryStateBaton,
  DEFAULT_MIN_CACHED_TOKENS_FOR_WATCHDOG,
  DEFAULT_AMBER_THRESHOLD_SECONDS,
  DEFAULT_KEEP_ALIVE_THRESHOLD_SECONDS,
  DEFAULT_SNAPSHOT_THRESHOLD_SECONDS,
  ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD,
  FIVE_MINUTES_SECONDS,
  SIXTY_MINUTES_SECONDS
} from '../coach/ttlWatchdog.mjs';

export * from '../coach/savedQuotaLedger.mjs';
