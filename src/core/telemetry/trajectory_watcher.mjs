import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

/**
 * Phase 1.1: Undo / Rewind Step Rollback Detector (`src/core/telemetry/trajectory_watcher.mjs`)
 *
 * Strictly read-only telemetry observer with zero disk or network side effects.
 * Tracks `stepCount` across `.pb` / JSONL conversation updates.
 * When `currentStepCount < previousStepCount` (user clicked Undo/Rewind in Antigravity chat):
 *  - Emits `TRAJECTORY_REWIND` with `{ sessionId, droppedSteps, newStepCount, previousStepCount }`
 *  - Immediately recomputes the 40-cell Flamegraph and context fill on the remaining steps
 *  - Notifies bound `HysteresisLock` and `circuit_breakers.mjs` instances to purge
 *    oscillation hashes and retry counters recorded during the rewound turns.
 */

export const FLAMEGRAPH_CELL_COUNT = 40;
export const DEFAULT_CONTEXT_CEILING_TOKENS = 256000;

/**
 * Pure <1ms 40-Cell Flamegraph and Context Fill recomputation for a step array.
 */
export function computeFlamegraphAndContextFill(steps = [], options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const ceilingTokens = Math.max(1, Number(options.ceilingTokens || DEFAULT_CONTEXT_CEILING_TOKENS));
  const tokensPerCell = Math.ceil(ceilingTokens / FLAMEGRAPH_CELL_COUNT);

  let totalTokens = Number(options.baselineOverheadTokens || 0);
  const stepTokenSlices = [];

  for (let i = 0; i < list.length; i++) {
    const step = list[i] || {};
    const stepTokens = Number(
      step.tokens ??
      step.totalTokens ??
      step.outputTokens ??
      step.inputTokens ??
      (typeof step.content === 'string' ? Math.ceil(step.content.length / 4) : 500)
    );
    const bounded = Math.max(0, stepTokens);
    totalTokens += bounded;
    stepTokenSlices.push({
      stepIndex: i,
      tokens: bounded,
      type: step.type || step.role || 'STEP'
    });
  }

  const cells = Array.from({ length: FLAMEGRAPH_CELL_COUNT }, (_, idx) => ({
    cellIndex: idx,
    capacityTokens: tokensPerCell,
    filledTokens: 0,
    fillRatio: 0,
    status: 'FREE',
    stepIndices: []
  }));

  let cursorTokens = Number(options.baselineOverheadTokens || 0);
  if (cursorTokens > 0) {
    let remainingBase = cursorTokens;
    for (let c = 0; c < FLAMEGRAPH_CELL_COUNT && remainingBase > 0; c++) {
      const alloc = Math.min(tokensPerCell, remainingBase);
      cells[c].filledTokens += alloc;
      cells[c].status = 'SYSTEM_PREFIX';
      remainingBase -= alloc;
    }
  }

  for (const slice of stepTokenSlices) {
    let rem = slice.tokens;
    for (let c = 0; c < FLAMEGRAPH_CELL_COUNT && rem > 0; c++) {
      const space = Math.max(0, tokensPerCell - cells[c].filledTokens);
      if (space <= 0) continue;
      const alloc = Math.min(space, rem);
      cells[c].filledTokens += alloc;
      cells[c].stepIndices.push(slice.stepIndex);
      if (cells[c].status === 'FREE') {
        cells[c].status = 'ACTIVE';
      }
      rem -= alloc;
    }
  }

  let populatedCells = 0;
  for (const cell of cells) {
    cell.fillRatio = Number((cell.filledTokens / tokensPerCell).toFixed(3));
    if (cell.filledTokens > 0) populatedCells++;
  }

  return {
    totalTokens,
    ceilingTokens,
    fillPct: Number(Math.min(100, (totalTokens / ceilingTokens) * 100).toFixed(2)),
    populatedCells,
    tokensPerCell,
    cells
  };
}

export class TrajectoryWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionStepCounts = new Map(); // sessionId -> number
    this.sessionStepsCache = new Map(); // sessionId -> Array
    this.sessionFlamegraphs = new Map(); // sessionId -> Flamegraph state
    this.hysteresisLocks = new Set();
    this.circuitBreakers = new Set();
    this.recomputeCallback = typeof options.onRecomputeFlamegraph === 'function'
      ? options.onRecomputeFlamegraph
      : null;

    if (options.hysteresisLock) {
      this.registerHysteresisLock(options.hysteresisLock);
    }
    if (options.circuitBreaker) {
      this.registerCircuitBreaker(options.circuitBreaker);
    }
  }

  registerHysteresisLock(lockInstance) {
    if (lockInstance && typeof lockInstance === 'object') {
      this.hysteresisLocks.add(lockInstance);
    }
    return this;
  }

  registerCircuitBreaker(breakerInstance) {
    if (breakerInstance && typeof breakerInstance === 'object') {
      this.circuitBreakers.add(breakerInstance);
    }
    return this;
  }

  /**
   * Observes a `.pb` or JSONL trajectory update for a given session.
   * Detects Undo / Rewind step rollbacks in <2ms and triggers synchronous state recovery.
   *
   * @param {object} update
   * @param {string} [update.sessionId='default']
   * @param {number} [update.stepCount]
   * @param {Array}  [update.steps]
   * @param {object} [update.options]
   */
  observeTrajectoryUpdate(update = {}) {
    const startMs = performance.now();
    const sessionId = String(update.sessionId || 'default');
    const steps = Array.isArray(update.steps) ? update.steps : null;
    const currentStepCount = Number.isFinite(update.stepCount)
      ? Math.max(0, Number(update.stepCount))
      : (steps ? steps.length : 0);

    const previousStepCount = this.sessionStepCounts.has(sessionId)
      ? this.sessionStepCounts.get(sessionId)
      : currentStepCount;

    const effectiveSteps = steps
      ? steps.slice(0, currentStepCount)
      : (this.sessionStepsCache.get(sessionId) || []).slice(0, currentStepCount);

    this.sessionStepCounts.set(sessionId, currentStepCount);
    if (steps || effectiveSteps.length > 0) {
      this.sessionStepsCache.set(sessionId, effectiveSteps);
    }

    let rewindDetected = false;
    let rewindPayload = null;

    if (currentStepCount < previousStepCount) {
      rewindDetected = true;
      const droppedSteps = previousStepCount - currentStepCount;
      const flamegraph = computeFlamegraphAndContextFill(effectiveSteps, update.options || {});
      this.sessionFlamegraphs.set(sessionId, flamegraph);

      if (this.recomputeCallback) {
        try {
          this.recomputeCallback({
            sessionId,
            newStepCount: currentStepCount,
            droppedSteps,
            steps: effectiveSteps,
            flamegraph
          });
        } catch {}
      }

      // Notify all registered HysteresisLock instances
      for (const lock of this.hysteresisLocks) {
        if (typeof lock.onTrajectoryRewind === 'function') {
          lock.onTrajectoryRewind({ sessionId, droppedSteps, newStepCount: currentStepCount });
        } else if (typeof lock.unlock === 'function') {
          lock.unlock('TRAJECTORY_REWIND');
        }
      }

      // Notify all registered CircuitBreaker instances to purge oscillation hashes & retry counters
      for (const breaker of this.circuitBreakers) {
        if (typeof breaker.purgeRewoundTurns === 'function') {
          breaker.purgeRewoundTurns(currentStepCount, sessionId);
        } else if (typeof breaker.onTrajectoryRewind === 'function') {
          breaker.onTrajectoryRewind({ sessionId, droppedSteps, newStepCount: currentStepCount });
        }
      }

      rewindPayload = {
        sessionId,
        previousStepCount,
        newStepCount: currentStepCount,
        droppedSteps,
        flamegraph,
        elapsedMs: Number((performance.now() - startMs).toFixed(3))
      };

      this.emit('TRAJECTORY_REWIND', rewindPayload);
    } else {
      const flamegraph = computeFlamegraphAndContextFill(effectiveSteps, update.options || {});
      this.sessionFlamegraphs.set(sessionId, flamegraph);
    }

    return {
      sessionId,
      previousStepCount,
      currentStepCount,
      rewindDetected,
      droppedSteps: rewindDetected ? previousStepCount - currentStepCount : 0,
      flamegraph: this.sessionFlamegraphs.get(sessionId),
      rewindPayload,
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };
  }

  getSessionState(sessionId = 'default') {
    const id = String(sessionId || 'default');
    return {
      sessionId: id,
      stepCount: this.sessionStepCounts.get(id) ?? 0,
      flamegraph: this.sessionFlamegraphs.get(id) ?? null
    };
  }
}

export default TrajectoryWatcher;
