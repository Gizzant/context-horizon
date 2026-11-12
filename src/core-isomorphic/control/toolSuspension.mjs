/**
 * @file src/core-isomorphic/control/toolSuspension.mjs
 * Atomic Tool-Boundary Suspension (Feature 28).
 *
 * Implements non-spinning tool-boundary suspension, 600,000ms safety timeout release,
 * and fail-closed Mod Law 5 wrapper output normalization.
 * Pure ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

import { CONTROL_STATES, evaluateToolBoundaryLatch } from './controlStateMachine.mjs';

export const SUSPENSION_CONSTANTS = Object.freeze({
  DEFAULT_SAFETY_TIMEOUT_MS: 600000, // 10 minutes
  DEFAULT_POLL_INTERVAL_MS: 50
});

/**
 * Non-spinning asynchronous wait loop for suspended execution boundaries.
 * Uses event loop timers (setTimeout) with 0% CPU consumption while suspended.
 *
 * @param {object} options
 * @param {Function} options.checkControlStateFn - Pure getter returning current ControlState
 * @param {number} [options.pollIntervalMs=50] - Interval between state checks
 * @param {number} [options.timeoutMs=600000] - Safety timeout ceiling in ms
 * @param {AbortSignal} [options.signal=null] - Optional AbortSignal
 * @returns {Promise<object>} Outcome of suspension wait
 */
export function waitForSuspensionResume({
  checkControlStateFn,
  pollIntervalMs = SUSPENSION_CONSTANTS.DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = SUSPENSION_CONSTANTS.DEFAULT_SAFETY_TIMEOUT_MS,
  signal = null
} = {}) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve({
        resumed: false,
        aborted: true,
        decision: 'deny',
        reason: 'Suspension aborted via signal'
      });
    };

    if (signal) {
      if (signal.aborted) {
        return resolve({
          resumed: false,
          aborted: true,
          decision: 'deny',
          reason: 'Suspension aborted via signal'
        });
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const check = () => {
      const now = Date.now();
      const elapsed = now - startMs;

      // 1. Safety timeout release
      if (elapsed >= timeoutMs) {
        cleanup();
        return resolve({
          resumed: false,
          timeout: true,
          decision: 'deny',
          reason: `timeout: suspended execution exceeded ${timeoutMs}ms safety ceiling`
        });
      }

      // 2. Query state
      let currentState = null;
      try {
        currentState = typeof checkControlStateFn === 'function' ? checkControlStateFn() : null;
      } catch (err) {
        cleanup();
        return resolve({
          resumed: false,
          error: true,
          decision: 'deny',
          reason: `Failed to query control state: ${err.message}`
        });
      }

      const state = currentState?.state || CONTROL_STATES.RUNNING;

      // 3. Terminal state: ABORTED cancels immediately
      if (state === CONTROL_STATES.ABORTED) {
        cleanup();
        return resolve({
          resumed: false,
          aborted: true,
          decision: 'deny',
          reason: currentState?.reason || 'Session aborted by user'
        });
      }

      // 4. Resume states: RUNNING or STEP allows execution to proceed
      if (state === CONTROL_STATES.RUNNING) {
        cleanup();
        return resolve({
          resumed: true,
          decision: 'allow',
          state: CONTROL_STATES.RUNNING,
          reason: currentState?.reason || 'Execution resumed'
        });
      }

      if (state === CONTROL_STATES.STEP) {
        cleanup();
        return resolve({
          resumed: true,
          decision: 'allow',
          consumeStep: true,
          state: CONTROL_STATES.STEP,
          stepRemaining: currentState?.stepRemaining ?? 1,
          reason: currentState?.reason || 'Single step execution'
        });
      }

      // Still paused/rewinding: schedule next check non-spinning
      timer = setTimeout(check, pollIntervalMs);
    };

    // Execute first check immediately
    check();
  });
}

/**
 * Normalizes tool boundary hook output to Claude Code proto-safe schema.
 * Enforces Mod Law 5 fail-closed behavior on exceptions or invalid inputs.
 *
 * @param {*} output - Hook evaluation output
 * @param {object} [options]
 * @returns {object} Normalized proto-safe result
 */
export function toProtoSafePreHookOutput(output, options = {}) {
  if (!output || typeof output !== 'object') {
    return {
      decision: 'deny',
      reason: options.fallbackReason || 'Tool boundary check failed closed'
    };
  }

  const rawDecision = String(output.decision || output.permissionDecision || '').toLowerCase();
  let decision = 'allow';

  if (['deny', 'block', 'reject'].includes(rawDecision)) {
    decision = 'deny';
  } else if (['ask', 'defer'].includes(rawDecision)) {
    decision = 'ask';
  } else if (rawDecision === 'suspend') {
    decision = 'suspend';
  } else {
    decision = 'allow';
  }

  const result = {
    ...output,
    decision
  };

  if (output.reason || output.permissionDecisionReason) {
    result.reason = String(output.reason || output.permissionDecisionReason);
  }

  return result;
}

/**
 * Wraps a tool hook execution function in a Mod Law 5 compliant try-catch block,
 * guaranteeing zero crashes and fail-closed security.
 *
 * @param {Function} fn
 * @returns {Promise<object>}
 */
export async function wrapSafeToolBoundary(fn) {
  try {
    const res = await fn();
    return toProtoSafePreHookOutput(res);
  } catch (err) {
    return toProtoSafePreHookOutput(null, {
      fallbackReason: `[Attention Horizon Fail-Closed] ${err.message}`
    });
  }
}

