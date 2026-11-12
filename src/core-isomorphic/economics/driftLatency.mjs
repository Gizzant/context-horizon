/**
 * @file src/core-isomorphic/economics/driftLatency.mjs
 * Feature 17: Time-To-First-Token (TTFT) & Thinking vs. Generation Drift Detection.
 *
 * Implements:
 *   - TTFT latency tracking in milliseconds (null / "—" on <= 0 or clock skew)
 *   - Latency spike detection (> 5x baseline)
 *   - Thinking vs. generation token drift ratio (reported tokens only, non-estimated)
 *   - Scratchpad loop detection: canonical DET-30 (preserving DET-21 alias)
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

export const THINKING_DRIFT_DETECTOR_ID = 'DET-30';
export const LEGACY_THINKING_DRIFT_ALIAS = 'DET-21';

export const DRIFT_THRESHOLDS = Object.freeze({
  MIN_THINKING_TOKENS: 4000,
  LOOP_RATIO: 12.0,
  ELEVATED_RATIO: 4.0,
  CUMULATIVE_THINKING_TOKENS: 10000,
  CONSECUTIVE_TURNS_CRITICAL: 2,
  ROLLING_WINDOW: 3,
  SPIKE_MULTIPLIER: 5.0
});

export const DRIFT_STATES = Object.freeze({
  NOMINAL: 'nominal',
  ELEVATED: 'elevated',
  LOOP_SUSPECT: 'loop_suspect'
});

/**
 * Creates an empty initial thinking drift accumulator.
 * @returns {object}
 */
export function createInitialThinkingDrift() {
  return {
    measured: false,
    turns: [],
    lastTtftMs: null,
    avgTtftMs: null,
    lastDriftRatio: null,
    rollingDriftRatio: null,
    cumulativeThinkingTokens: 0,
    cumulativeOutputTokens: 0,
    consecutiveLoopTurns: 0,
    loop: {
      triggered: false,
      severity: 'nominal',
      gaDetectorId: THINKING_DRIFT_DETECTOR_ID,
      aliasDetectorId: LEGACY_THINKING_DRIFT_ALIAS,
      consecutiveLoopTurns: 0,
      cumulativeThinkingTokens: 0,
      message: ''
    }
  };
}

/**
 * Formats millisecond TTFT into a human-readable high data-ink string.
 * Clamps <= 0 or invalid numbers to '—' (never fabricated 0ms).
 *
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatTtft(ms) {
  if (ms == null || typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  const rounded = Math.round(ms);
  if (rounded < 1000) {
    return `${rounded}ms`;
  }
  if (rounded < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const mins = Math.floor(rounded / 60000);
  const remSec = Math.round((rounded % 60000) / 1000);
  return `${mins}m${remSec}s`;
}

/**
 * Classifies a turn's thinking drift into 'nominal' | 'elevated' | 'loop_suspect'.
 *
 * @param {object} turn
 * @param {number} [turn.thinkingTokens=0]
 * @param {number} [turn.visibleOutputTokens=0]
 * @param {number} [turn.outputTokens=0]
 * @param {number} [turn.mutatingCalls=0]
 * @returns {'nominal' | 'elevated' | 'loop_suspect'}
 */
export function classifyTurnDrift(turn = {}) {
  const thinking = Math.max(0, Number(turn.thinkingTokens ?? 0));
  const output = Math.max(0, Number(turn.visibleOutputTokens ?? turn.outputTokens ?? 0));
  const mutating = Math.max(0, Number(turn.mutatingCalls ?? 0));

  const ratio = thinking / Math.max(1, output);

  if (thinking >= DRIFT_THRESHOLDS.MIN_THINKING_TOKENS &&
      ratio >= DRIFT_THRESHOLDS.LOOP_RATIO &&
      mutating === 0) {
    return DRIFT_STATES.LOOP_SUSPECT;
  }

  if (thinking > 0 && ratio >= DRIFT_THRESHOLDS.ELEVATED_RATIO) {
    return DRIFT_STATES.ELEVATED;
  }

  return DRIFT_STATES.NOMINAL;
}

/**
 * Evaluates a sequence of turn records for DET-30 (alias DET-21) scratchpad loop conditions.
 *
 * @param {Array<object>} [turnRecords=[]]
 * @returns {{
 *   triggered: boolean,
 *   severity: 'nominal' | 'warn' | 'critical',
 *   gaDetectorId: 'DET-30',
 *   aliasDetectorId: 'DET-21',
 *   consecutiveLoopTurns: number,
 *   cumulativeThinkingTokens: number,
 *   message: string
 * }}
 */
export function evaluateThinkingDriftLoop(turnRecords = []) {
  if (!Array.isArray(turnRecords) || turnRecords.length === 0) {
    return {
      triggered: false,
      severity: 'nominal',
      gaDetectorId: THINKING_DRIFT_DETECTOR_ID,
      aliasDetectorId: LEGACY_THINKING_DRIFT_ALIAS,
      consecutiveLoopTurns: 0,
      cumulativeThinkingTokens: 0,
      message: ''
    };
  }

  let consecutiveLoop = 0;
  let nonMutatingThinking = 0;
  let lastSuspectRatio = 0;

  for (let i = 0; i < turnRecords.length; i++) {
    const turn = turnRecords[i];
    const mutating = Math.max(0, Number(turn.mutatingCalls ?? 0));
    const thinking = Math.max(0, Number(turn.thinkingTokens ?? 0));
    const output = Math.max(0, Number(turn.visibleOutputTokens ?? turn.outputTokens ?? 0));
    const state = classifyTurnDrift(turn);

    if (mutating > 0) {
      consecutiveLoop = 0;
      nonMutatingThinking = 0;
    } else {
      nonMutatingThinking += thinking;
      if (state === DRIFT_STATES.LOOP_SUSPECT) {
        consecutiveLoop += 1;
        lastSuspectRatio = Math.round(thinking / Math.max(1, output));
      } else {
        consecutiveLoop = 0;
      }
    }
  }

  const isCritical =
    consecutiveLoop >= DRIFT_THRESHOLDS.CONSECUTIVE_TURNS_CRITICAL ||
    (consecutiveLoop >= 1 && nonMutatingThinking >= DRIFT_THRESHOLDS.CUMULATIVE_THINKING_TOKENS);

  const isWarn = consecutiveLoop === 1 && !isCritical;
  const triggered = isCritical || isWarn;
  const severity = isCritical ? 'critical' : isWarn ? 'warn' : 'nominal';

  const message = triggered
    ? `🚨 DET-30 (DET-21) Scratchpad Loop: ${lastSuspectRatio}x reasoning-to-output over ${consecutiveLoop} turn(s) with 0 edits. Inject a concrete constraint (target file + acceptance test) or step effort down.`
    : '';

  return {
    triggered,
    severity,
    gaDetectorId: THINKING_DRIFT_DETECTOR_ID,
    aliasDetectorId: LEGACY_THINKING_DRIFT_ALIAS,
    consecutiveLoopTurns: consecutiveLoop,
    cumulativeThinkingTokens: nonMutatingThinking,
    message
  };
}

/**
 * Applies a turn event to the thinking drift accumulator.
 *
 * @param {object} drift Current drift state
 * @param {object} ev Event data
 * @param {string} [ev.eventType]
 * @param {number} [ev.turnStartedAtMs]
 * @param {number} [ev.nowMs]
 * @param {number} [ev.ttftMs]
 * @param {number} [ev.thinkingTokens=0]
 * @param {number} [ev.outputTokens=0]
 * @param {number} [ev.mutatingCalls=0]
 * @param {boolean} [ev.thinkingEstimated=false]
 * @returns {object} Updated drift state
 */
export function applyThinkingDriftEvent(drift, ev = {}) {
  const current = drift ? { ...drift, turns: [...drift.turns] } : createInitialThinkingDrift();

  // TTFT calculation: measured from turnStartedAtMs to nowMs
  let ttft = null;
  if (typeof ev.ttftMs === 'number' && ev.ttftMs > 0) {
    ttft = Math.round(ev.ttftMs);
  } else if (
    typeof ev.turnStartedAtMs === 'number' &&
    typeof ev.nowMs === 'number' &&
    ev.nowMs > ev.turnStartedAtMs
  ) {
    ttft = Math.round(ev.nowMs - ev.turnStartedAtMs);
  }

  const thinking = Math.max(0, Number(ev.thinkingTokens ?? 0));
  const output = Math.max(0, Number(ev.outputTokens ?? ev.visibleOutputTokens ?? 0));
  const mutating = Math.max(0, Number(ev.mutatingCalls ?? 0));
  const isEstimated = Boolean(ev.thinkingEstimated);

  // Compute drift ratio only if thinking tokens are reported and non-estimated
  let ratio = null;
  if (!isEstimated && (thinking > 0 || output > 0)) {
    ratio = parseFloat((thinking / Math.max(1, output)).toFixed(1));
  }

  const turnRecord = {
    turnIndex: current.turns.length,
    ttftMs: ttft,
    thinkingTokens: thinking,
    outputTokens: output,
    visibleOutputTokens: output,
    mutatingCalls: mutating,
    driftRatio: ratio,
    driftState: classifyTurnDrift({ thinkingTokens: thinking, visibleOutputTokens: output, mutatingCalls: mutating }),
    thinkingEstimated: isEstimated,
    timestamp: typeof ev.nowMs === 'number' ? ev.nowMs : Date.now()
  };

  current.turns.push(turnRecord);
  current.measured = current.turns.length > 0;

  if (ttft !== null) {
    current.lastTtftMs = ttft;
    const measuredTtfts = current.turns
      .map(t => t.ttftMs)
      .filter(t => typeof t === 'number' && t > 0);
    if (measuredTtfts.length > 0) {
      const sum = measuredTtfts.reduce((acc, v) => acc + v, 0);
      current.avgTtftMs = Math.round(sum / measuredTtfts.length);
    }
  }

  if (ratio !== null) {
    current.lastDriftRatio = ratio;
  }

  if (!isEstimated) {
    current.cumulativeThinkingTokens += thinking;
    current.cumulativeOutputTokens += output;
  }

  // Rolling drift across trailing window
  const trailing = current.turns.slice(-DRIFT_THRESHOLDS.ROLLING_WINDOW);
  const trailingThinking = trailing.reduce((acc, t) => acc + (t.thinkingEstimated ? 0 : t.thinkingTokens), 0);
  const trailingOutput = trailing.reduce((acc, t) => acc + (t.thinkingEstimated ? 0 : t.outputTokens), 0);
  if (trailingThinking > 0 || trailingOutput > 0) {
    current.rollingDriftRatio = parseFloat((trailingThinking / Math.max(1, trailingOutput)).toFixed(1));
  }

  // Evaluate loop detector
  current.loop = evaluateThinkingDriftLoop(current.turns);
  current.consecutiveLoopTurns = current.loop.consecutiveLoopTurns;

  return current;
}

/**
 * Checks whether a TTFT observation constitutes a sudden spike against baseline.
 *
 * @param {number} ttftMs
 * @param {number} baselineAvgMs
 * @returns {boolean}
 */
export function isTtftSpike(ttftMs, baselineAvgMs) {
  if (typeof ttftMs !== 'number' || typeof baselineAvgMs !== 'number' || baselineAvgMs <= 0) {
    return false;
  }
  return ttftMs > baselineAvgMs * DRIFT_THRESHOLDS.SPIKE_MULTIPLIER;
}

/**
 * Returns a compact 1-line summary of thinking drift for CLI statuslines.
 * @param {object} drift
 * @returns {string}
 */
export function formatDriftCompact(drift) {
  if (!drift?.measured) return 'TTFT: — | Drift: —';
  const ttftStr = formatTtft(drift.lastTtftMs);
  const ratioStr = drift.lastDriftRatio != null ? `${drift.lastDriftRatio}x` : '—';
  if (drift.loop?.triggered) {
    return `TTFT: ${ttftStr} | 🚨 DET-30 Loop (${ratioStr})`;
  }
  return `TTFT: ${ttftStr} | Drift: ${ratioStr}`;
}

/**
 * Formats an informative drift label for reports.
 * @param {object} drift
 * @returns {string}
 */
export function formatDriftLabel(drift) {
  if (!drift?.measured) return 'Thinking drift unmeasured';
  const ttftStr = drift.avgTtftMs != null ? formatTtft(drift.avgTtftMs) : '—';
  const rollingStr = drift.rollingDriftRatio != null ? `${drift.rollingDriftRatio}x` : '—';
  return `Avg TTFT ${ttftStr} · Rolling Drift ${rollingStr}`;
}
