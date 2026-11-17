/**
 * @file src/core-isomorphic/control/controlStateMachine.mjs
 * Interactive Runtime Control State Machine (Feature 26).
 *
 * Implements deterministic 5-state execution control (RUNNING, PAUSED, STEP, ABORTED, REWIND),
 * transition rules, and .ctl serialization/parsing with safe corrupted fallbacks.
 * Pure ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

export const CONTROL_STATES = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STEP: 'STEP',
  ABORTED: 'ABORTED',
  REWIND: 'REWIND'
});

/**
 * Creates an initial runtime control state object.
 *
 * @param {string} [sessionId='default']
 * @returns {object}
 */
export function createInitialControlState(sessionId = 'default') {
  return {
    sessionId: String(sessionId),
    state: CONTROL_STATES.RUNNING,
    stepCount: 0,
    stepRemaining: 0,
    rewindTarget: null,
    reason: '',
    updatedAt: Date.now()
  };
}

/**
 * Transitions control state deterministically according to FSM rules.
 * ABORTED is terminal and irreversible.
 *
 * @param {object} currentState
 * @param {string} action - 'pause' | 'resume' | 'run' | 'step' | 'abort' | 'rewind' | 'consume_step'
 * @param {string} [reason='']
 * @param {object} [options={}]
 * @returns {object} Next state
 */
export function transitionControlState(currentState, action, reason = '', options = {}) {
  const base = currentState && typeof currentState === 'object'
    ? currentState
    : createInitialControlState(options.sessionId || 'default');
  const current = base.state || CONTROL_STATES.RUNNING;
  const now = Date.now();

  // Terminal state: once ABORTED, no transitions allowed
  if (current === CONTROL_STATES.ABORTED) {
    return base;
  }

  const normalizedAction = String(action || '').toLowerCase();

  switch (normalizedAction) {
    case 'pause':
      return {
        ...base,
        state: CONTROL_STATES.PAUSED,
        reason: reason || base.reason || '',
        updatedAt: now,
        stepRemaining: 0
      };

    case 'resume':
    case 'run':
      return {
        ...base,
        state: CONTROL_STATES.RUNNING,
        reason: reason || '',
        updatedAt: now,
        stepRemaining: 0
      };

    case 'step':
      return {
        ...base,
        state: CONTROL_STATES.STEP,
        reason: reason || '',
        updatedAt: now,
        stepRemaining: 1,
        stepCount: (Number(base.stepCount) || 0) + 1
      };

    case 'consume_step':
      return {
        ...base,
        state: CONTROL_STATES.PAUSED,
        reason: reason || 'Step consumed',
        updatedAt: now,
        stepRemaining: 0
      };

    case 'abort':
      return {
        ...base,
        state: CONTROL_STATES.ABORTED,
        reason: reason || 'Aborted by user',
        updatedAt: now
      };

    case 'rewind':
      return {
        ...base,
        state: CONTROL_STATES.REWIND,
        reason: reason || 'Rewind requested',
        rewindTarget: options.target ?? null,
        updatedAt: now
      };

    default:
      return base;
  }
}

/**
 * Parses control file string representation (~/.ctxtop/runtime/<sessionId>.ctl).
 * Safely defaults to RUNNING with 'corrupted_fallback' on syntax errors or corruption.
 *
 * @param {string} jsonString
 * @param {string} [fallbackSessionId='default']
 * @returns {object} ControlState
 */
export function parseControlFile(jsonString, fallbackSessionId = 'default') {
  if (!jsonString || typeof jsonString !== 'string' || !jsonString.trim()) {
    return {
      ...createInitialControlState(fallbackSessionId),
      reason: 'missing_fallback'
    };
  }

  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...createInitialControlState(fallbackSessionId),
        reason: 'corrupted_fallback'
      };
    }

    if (!parsed.state || !Object.values(CONTROL_STATES).includes(parsed.state)) {
      return {
        ...createInitialControlState(fallbackSessionId),
        reason: 'corrupted_fallback'
      };
    }

    return {
      sessionId: String(parsed.sessionId || fallbackSessionId),
      state: parsed.state,
      stepCount: Number(parsed.stepCount) || 0,
      stepRemaining: Number(parsed.stepRemaining) || 0,
      rewindTarget: parsed.rewindTarget ?? null,
      reason: String(parsed.reason || ''),
      updatedAt: Number(parsed.updatedAt) || Date.now()
    };
  } catch (_err) {
    return {
      ...createInitialControlState(fallbackSessionId),
      reason: 'corrupted_fallback'
    };
  }
}

/**
 * Serializes control state to JSON string with trailing newline.
 *
 * @param {object} state
 * @returns {string}
 */
export function serializeControlFile(state) {
  if (!state || typeof state !== 'object') {
    return JSON.stringify(createInitialControlState(), null, 2) + '\n';
  }
  return JSON.stringify(state, null, 2) + '\n';
}

/**
 * Evaluates tool boundary latch synchronously.
 *
 * @param {object} controlState
 * @returns {{ decision: 'allow' | 'suspend' | 'deny', reason?: string, consumeStep?: boolean, stepRemaining?: number }}
 */
export function evaluateToolBoundaryLatch(controlState) {
  if (!controlState) return { decision: 'allow' };

  if (controlState.state === CONTROL_STATES.ABORTED) {
    return { decision: 'deny', reason: controlState.reason || 'Session aborted by user' };
  }
  if (controlState.state === CONTROL_STATES.PAUSED) {
    return { decision: 'suspend', reason: controlState.reason || 'Execution paused by user' };
  }
  if (controlState.state === CONTROL_STATES.REWIND) {
    return { decision: 'suspend', reason: controlState.reason || 'Session rewinding' };
  }
  if (controlState.state === CONTROL_STATES.STEP) {
    return { decision: 'allow', consumeStep: true, stepRemaining: controlState.stepRemaining ?? 1 };
  }
  return { decision: 'allow' };
}
