/**
 * @file src/core-isomorphic/control/coachLatches.mjs
 * Control Latching in COACH Mode (Feature 27).
 *
 * Enforces hard user /control commands (/pause, /step, /abort, /rewind) while
 * keeping autonomous detector findings advisory in COACH mode and blocking in AUTO_PILOT mode.
 * Pure ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

import { normalizeFlightMode as normalizeGravityFlightMode } from '../coach/cacheGravityRouter.mjs';
import { CONTROL_STATES, evaluateToolBoundaryLatch } from './controlStateMachine.mjs';

/**
 * Normalizes user or configuration flight mode string.
 * Defaults unrecognized or missing values safely to COACH.
 *
 * @param {string} [rawMode]
 * @returns {'COACH' | 'AUTO_PILOT' | 'SILENT' | 'OFF'}
 */
export function normalizeFlightMode(rawMode) {
  if (typeof normalizeGravityFlightMode === 'function') {
    const norm = normalizeGravityFlightMode(rawMode);
    if (norm) return norm;
  }
  if (!rawMode || typeof rawMode !== 'string') return 'COACH';
  const clean = rawMode.trim().toUpperCase();
  if (['COACH', 'AUTO_PILOT', 'SILENT', 'OFF'].includes(clean)) return clean;
  return 'COACH';
}

/**
 * Evaluates the composite control latch decision combining user control state,
 * active flight mode, and autonomous detector verdicts.
 *
 * @param {object} params
 * @param {object} [params.controlState] - Runtime control state from .ctl or IPC
 * @param {string} [params.flightMode='COACH'] - Flight mode (COACH, AUTO_PILOT, SILENT, OFF)
 * @param {object} [params.detectorVerdict=null] - Autonomous detector outcome { triggered, detectorId, reason }
 * @param {boolean} [params.isSecurityRing0=false] - Whether verdict is an unbypassable Ring-0 guard
 * @returns {object} Decision object
 */
export function evaluateCoachLatch({
  controlState = null,
  flightMode = 'COACH',
  detectorVerdict = null,
  isSecurityRing0 = false
} = {}) {
  const mode = normalizeFlightMode(flightMode);

  // Priority 1: User Control State takes strict precedence
  if (controlState && controlState.state && controlState.state !== CONTROL_STATES.RUNNING) {
    const userLatch = evaluateToolBoundaryLatch(controlState);
    if (userLatch.decision !== 'allow') {
      return {
        ...userLatch,
        flightMode: mode,
        userCommand: true
      };
    }
  }

  // Priority 2: Security Ring-0 guards always hard block regardless of flight mode
  if (isSecurityRing0 || detectorVerdict?.isSecurityRing0) {
    return {
      decision: 'deny',
      flightMode: mode,
      blocked: true,
      detectorId: detectorVerdict?.detectorId || 'RING_0_SECURITY',
      reason: detectorVerdict?.reason || 'Security Ring-0 invariant violation'
    };
  }

  // Priority 3: Autonomous Detector Findings
  if (detectorVerdict && detectorVerdict.triggered) {
    if (mode === 'COACH') {
      // In COACH mode, autonomous detector findings emit advisory warnings without blocking
      return {
        decision: 'allow',
        flightMode: 'COACH',
        advisory: true,
        detectorId: detectorVerdict.detectorId,
        systemMessage: detectorVerdict.reason || `[${detectorVerdict.detectorId}] Advisory warning: proceed with caution`
      };
    }

    if (mode === 'AUTO_PILOT') {
      // In AUTO_PILOT mode, autonomous triggers enforce hard blocking
      return {
        decision: 'block',
        flightMode: 'AUTO_PILOT',
        blocked: true,
        detectorId: detectorVerdict.detectorId,
        reason: detectorVerdict.reason || `[${detectorVerdict.detectorId}] Autonomous execution blocked`
      };
    }

    if (mode === 'SILENT' || mode === 'OFF') {
      return {
        decision: 'allow',
        flightMode: mode
      };
    }
  }

  return {
    decision: 'allow',
    flightMode: mode
  };
}

/**
 * Renders the COACH status pill for HUD and statusline display.
 *
 * @param {object} [options]
 * @returns {string} e.g. '[COACH]' or '[COACH · DET-09 ACTIVE]'
 */
export function renderCoachPill(options = {}) {
  const mode = normalizeFlightMode(options.flightMode);
  const breaker = options.breakerVerdict || options.detectorVerdict;

  if (breaker && breaker.triggered && breaker.detectorId) {
    return `[${mode} · ${breaker.detectorId} ACTIVE]`;
  }

  return `[${mode}]`;
}
