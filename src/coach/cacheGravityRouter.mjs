/**
 * @file src/coach/cacheGravityRouter.mjs
 * Backward-compatibility Coach adapter re-exporting cache gravity router and flight computer.
 */

export * from '../core-isomorphic/coach/cacheGravityRouter.mjs';
export {
  calculateBreakEvenCStar,
  computeClosedFormBreakEven,
  evaluateCacheGravity,
  MODEL_BREAK_EVEN_RATES
} from '../core-isomorphic/economics/cacheGravity.mjs';
