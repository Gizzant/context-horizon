/**
 * @file src/core-isomorphic/ustf/schema.mjs
 * Universal Session Trajectory Format (USTF v1) Schema & Validators.
 *
 * Cross-platform JSON schema representing agent sessions, turns, tool calls,
 * costs, and execution spans across Google Antigravity and Claude Code.
 *
 * Pure JS / ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

export const USTF_SCHEMA_VERSION = '1.0.0';
export const USTF_SCHEMA_URI = 'https://ctxtop.dev/schemas/ustf-v1.json';

/**
 * 9 Canonical USTF v1 event types.
 */
export const USTF_EVENT_TYPES = Object.freeze([
  'turn.start',
  'turn.step',
  'turn.complete',
  'tool.call',
  'tool.result',
  'model.switch',
  'compact.lifecycle',
  'subagent.lifecycle',
  'control.action'
]);

/**
 * Canonical USTF v1 hierarchical call-tree span kinds.
 */
export const USTF_SPAN_KINDS = Object.freeze([
  'turn',
  'agent',
  'tool',
  'hook',
  'llm'
]);

/**
 * Validates a USTF v1 usage accounting object.
 *
 * @param {object} usage
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateUstfUsage(usage) {
  const errors = [];
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { valid: false, errors: ['usage must be an object'] };
  }
  const numericFields = [
    'uncached',
    'cacheWrite5m',
    'cacheWrite1h',
    'cacheRead',
    'output',
    'thinking',
    'costUSD'
  ];
  for (const f of numericFields) {
    if (usage[f] !== undefined && typeof usage[f] !== 'number') {
      errors.push(`usage.${f} must be a number`);
    } else if (usage[f] < 0) {
      errors.push(`usage.${f} must be non-negative`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a USTF v1 execution span.
 *
 * @param {object} span
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateUstfSpan(span) {
  const errors = [];
  if (!span || typeof span !== 'object' || Array.isArray(span)) {
    return { valid: false, errors: ['span must be an object'] };
  }
  if (!span.spanId || typeof span.spanId !== 'string') {
    errors.push('spanId must be a non-empty string');
  }
  if (span.parentSpanId !== null && span.parentSpanId !== undefined && typeof span.parentSpanId !== 'string') {
    errors.push('parentSpanId must be string or null');
  }
  if (!span.kind || !USTF_SPAN_KINDS.includes(span.kind)) {
    errors.push(`kind must be one of: ${USTF_SPAN_KINDS.join(', ')}`);
  }
  if (!span.name || typeof span.name !== 'string') {
    errors.push('name must be a non-empty string');
  }
  if (typeof span.startTimeMs !== 'number' || span.startTimeMs < 0) {
    errors.push('startTimeMs must be a non-negative number');
  }
  if (span.durationMs !== undefined && span.durationMs !== null) {
    if (typeof span.durationMs !== 'number' || span.durationMs < 0) {
      errors.push('durationMs must be a non-negative number');
    }
  }
  if (span.status && !['ok', 'error', 'aborted'].includes(span.status)) {
    errors.push('status must be one of: ok, error, aborted');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a USTF v1 event.
 *
 * @param {object} event
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateUstfEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { valid: false, errors: ['event must be an object'] };
  }
  if (!event.eventId || typeof event.eventId !== 'string') {
    errors.push('eventId must be a non-empty string');
  }
  if (!event.type || !USTF_EVENT_TYPES.includes(event.type)) {
    errors.push(`type must be one of: ${USTF_EVENT_TYPES.join(', ')}`);
  }
  if (typeof event.timestampMs !== 'number' || event.timestampMs < 0) {
    errors.push('timestampMs must be a non-negative number');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a complete USTF v1 session trajectory.
 *
 * @param {object} trajectory
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateUstfTrajectory(trajectory) {
  const errors = [];
  if (!trajectory || typeof trajectory !== 'object' || Array.isArray(trajectory)) {
    return { valid: false, errors: ['trajectory must be an object'] };
  }

  if (trajectory.$schema && trajectory.$schema !== USTF_SCHEMA_URI) {
    errors.push(`$schema must be "${USTF_SCHEMA_URI}"`);
  }
  if (trajectory.version && trajectory.version !== USTF_SCHEMA_VERSION) {
    errors.push(`version must be "${USTF_SCHEMA_VERSION}"`);
  }
  if (!trajectory.sessionId || typeof trajectory.sessionId !== 'string') {
    errors.push('sessionId must be a non-empty string');
  }
  if (!trajectory.harness || !['antigravity', 'claude-code', 'cursor'].includes(trajectory.harness)) {
    errors.push('harness must be "antigravity", "claude-code", or "cursor"');
  }
  if (!Array.isArray(trajectory.events)) {
    errors.push('events must be an array');
  } else {
    for (let i = 0; i < trajectory.events.length; i++) {
      const evCheck = validateUstfEvent(trajectory.events[i]);
      if (!evCheck.valid) {
        errors.push(`events[${i}]: ${evCheck.errors.join('; ')}`);
      }
    }
  }

  if (trajectory.spans !== undefined) {
    if (!Array.isArray(trajectory.spans)) {
      errors.push('spans must be an array');
    } else {
      for (let i = 0; i < trajectory.spans.length; i++) {
        const spanCheck = validateUstfSpan(trajectory.spans[i]);
        if (!spanCheck.valid) {
          errors.push(`spans[${i}]: ${spanCheck.errors.join('; ')}`);
        }
      }
    }
  }

  if (trajectory.usage) {
    const usageCheck = validateUstfUsage(trajectory.usage);
    if (!usageCheck.valid) {
      errors.push(`usage: ${usageCheck.errors.join('; ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
