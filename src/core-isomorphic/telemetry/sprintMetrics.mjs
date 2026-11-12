/**
 * @file src/telemetry/sprintMetrics.mjs
 * Sprint 1 "Metrics Wedge" for Claude Code (parity with Antigravity `src/core/sprint_metrics.mjs`):
 *
 *   1. Prefix-Cache Retention Index (0–100%) — incremental, per distinct API request.
 *   2. Thinking vs. Generation Drift + DET-21 Scratchpad Loop Detector
 *      (Claude Code DET-21 ⇄ Antigravity DET-30 `thinking-drift-loop`).
 *
 * Pure ESM, zero `node:*` imports (Mod-safe). Only measured usage is scored: an
 * unmeasured session reports `retentionIndexPct: null` (rendered "—"), never a fabricated 100%.
 */

export const RETENTION_CONSTANTS = Object.freeze({
  DEFAULT_TTL_SECONDS: 300,
  BUST_RETAINED_RATIO: 0.5,
  GRADE_A_PCT: 90,
  GRADE_B_PCT: 70,
  SERIES_MAX: 40
});

export const DRIFT_THRESHOLDS = Object.freeze({
  MIN_THINKING_TOKENS: 4000,
  LOOP_RATIO: 12,
  ELEVATED_RATIO: 4,
  CUMULATIVE_THINKING_TOKENS: 10000,
  CONSECUTIVE_TURNS_CRITICAL: 2,
  ROLLING_WINDOW: 3,
  HISTORY: 10
});

export const THINKING_DRIFT_DETECTOR_ID = 'DET-30';
export const THINKING_DRIFT_DEPRECATED_ALIAS = 'DET-21';
export const THINKING_DRIFT_GA_DETECTOR_ID = 'DET-30';
export const THINKING_DRIFT_SLUG = 'thinking-drift-loop';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round2(v) {
  return Number((Number(v) || 0).toFixed(2));
}

function round6(v) {
  return Number((Number(v) || 0).toFixed(6));
}

export function createInitialPrefixRetention() {
  return {
    measured: false,
    retentionIndexPct: null,
    grade: 'n/a',
    eligiblePrefixTokens: 0,
    retainedPrefixTokens: 0,
    leakedPrefixTokens: 0,
    measuredTurns: 0,
    bustCount: 0,
    ttlExpiredTurns: 0,
    bustCauses: {},
    lastBust: null,
    retainedDiscountSavingsUSD: 0,
    leakedColdPrefillUSD: 0,
    hasCacheTelemetry: false,
    unmeasuredReason: 'insufficient_turns',
    series: [],
    streams: {}
  };
}

export function createInitialThinkingDrift() {
  return {
    measured: false,
    turns: [],
    current: null,
    lastTtftMs: null,
    avgTtftMs: null,
    lastDriftRatio: null,
    rollingDriftRatio: null,
    driftState: 'n/a',
    loop: { detectorId: THINKING_DRIFT_DETECTOR_ID, triggered: false, severity: 'none', consecutiveLoopTurns: 0, message: '' }
  };
}

/**
 * Applies one distinct API request's prompt-side usage to the retention ledger.
 *
 * @param {object} retention - prior ledger (mutated copy returned)
 * @param {object} req
 * @param {string} req.streamKey - 'main' or subagent id
 * @param {string} req.modelId
 * @param {number} req.uncachedInputTokens
 * @param {number} req.cacheReadTokens
 * @param {number} req.cacheWriteTokens
 * @param {number} req.nowMs
 * @param {number} [req.ttlSeconds=300]
 * @param {number} req.inputPer1M
 * @param {number} req.readPer1M
 */
export function applyPrefixRetentionRequest(retention, req = {}) {
  const r = retention && typeof retention === 'object' ? retention : createInitialPrefixRetention();
  if (!r.streams || typeof r.streams !== 'object') r.streams = {};
  if (!r.bustCauses || typeof r.bustCauses !== 'object') r.bustCauses = {};

  const total = num(req.uncachedInputTokens) + num(req.cacheReadTokens) + num(req.cacheWriteTokens);
  if (total <= 0) return r;
  if (num(req.cacheReadTokens) > 0 || num(req.cacheWriteTokens) > 0) r.hasCacheTelemetry = true;
  if (!Array.isArray(r.series)) r.series = [];
  const pushSeries = (pt) => {
    r.series.push(pt);
    if (r.series.length > RETENTION_CONSTANTS.SERIES_MAX) r.series = r.series.slice(-RETENTION_CONSTANTS.SERIES_MAX);
  };

  const key = String(req.streamKey || 'main');
  const prev = r.streams[key] || null;
  r.streams[key] = { promptTotal: total, atMs: num(req.nowMs), modelId: req.modelId || null };
  if (!prev) return r;

  const ttlSec = num(req.ttlSeconds) || RETENTION_CONSTANTS.DEFAULT_TTL_SECONDS;
  const gapSec = prev.atMs > 0 && num(req.nowMs) >= prev.atMs ? (num(req.nowMs) - prev.atMs) / 1000 : null;
  if (gapSec !== null && gapSec > ttlSec) {
    r.ttlExpiredTurns += 1;
    pushSeries({ eligible: 0, retained: 0, pct: null, bust: false, cause: null, ttlExpired: true, atMs: num(req.nowMs) });
    return r;
  }

  const eligible = Math.min(prev.promptTotal, total);
  if (eligible <= 0) return r;
  const retained = Math.min(num(req.cacheReadTokens), eligible);
  const leaked = eligible - retained;
  const discountPerToken = Math.max(0, num(req.inputPer1M) - num(req.readPer1M)) / 1_000_000;

  r.measuredTurns += 1;
  r.eligiblePrefixTokens += eligible;
  r.retainedPrefixTokens += retained;
  r.leakedPrefixTokens = r.eligiblePrefixTokens - r.retainedPrefixTokens;
  r.retainedDiscountSavingsUSD = round6(num(r.retainedDiscountSavingsUSD) + retained * discountPerToken);
  r.leakedColdPrefillUSD = round6(num(r.leakedColdPrefillUSD) + leaked * discountPerToken);

  const isBust = retained / eligible < RETENTION_CONSTANTS.BUST_RETAINED_RATIO;
  pushSeries({
    eligible,
    retained,
    pct: Math.round((100 * retained) / eligible),
    bust: isBust,
    cause: isBust ? (prev.modelId && req.modelId && prev.modelId !== req.modelId ? 'model_switch' : 'prefix_drift') : null,
    ttlExpired: false,
    savedUSD: round6(retained * discountPerToken),
    atMs: num(req.nowMs)
  });
  if (isBust) {
    const cause = prev.modelId && req.modelId && prev.modelId !== req.modelId ? 'model_switch' : 'prefix_drift';
    r.bustCount += 1;
    r.bustCauses[cause] = (r.bustCauses[cause] || 0) + 1;
    r.lastBust = { cause, leakedTokens: leaked, leakedUSD: round6(leaked * discountPerToken), atMs: num(req.nowMs) };
  }

  // Honesty gate: zero cache reads/writes across every request => harness exposes no cache
  // telemetry; report "unmeasured", never "0% retained / N busts".
  r.measured = r.measuredTurns > 0 && r.hasCacheTelemetry === true;
  r.unmeasuredReason = r.measured ? null : (r.measuredTurns > 0 ? 'no_cache_telemetry' : 'insufficient_turns');
  r.retentionIndexPct = r.measured
    ? Math.max(0, Math.min(100, Math.round((100 * r.retainedPrefixTokens) / r.eligiblePrefixTokens)))
    : null;
  r.grade = !r.measured
    ? 'n/a'
    : r.retentionIndexPct >= RETENTION_CONSTANTS.GRADE_A_PCT
      ? 'A'
      : r.retentionIndexPct >= RETENTION_CONSTANTS.GRADE_B_PCT ? 'B' : 'C';
  return r;
}

export function formatRetentionCompact(r = {}) {
  if (!r || !r.measured || r.retentionIndexPct === null || r.retentionIndexPct === undefined) return 'Ret —';
  return `Ret ${r.retentionIndexPct}%`;
}

export function formatRetentionLabel(r = {}) {
  if (r && r.unmeasuredReason === 'no_cache_telemetry') return 'Retention — (no cache telemetry reported)';
  if (!r || !r.measured || r.retentionIndexPct === null || r.retentionIndexPct === undefined) {
    return 'Retain — (no multi-turn usage yet)';
  }
  const parts = [`Retain ${r.retentionIndexPct}%`, `Saved $${round2(r.retainedDiscountSavingsUSD).toFixed(2)}`];
  if (num(r.leakedColdPrefillUSD) > 0.005) parts.push(`Leaked $${round2(r.leakedColdPrefillUSD).toFixed(2)}`);
  if (num(r.bustCount) > 0) parts.push(`${r.bustCount} bust${r.bustCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function classifyTurnDrift(t = {}) {
  const thinking = num(t.thinkingTokens);
  const ratio = thinking / Math.max(1, num(t.visibleOutputTokens));
  if (thinking >= DRIFT_THRESHOLDS.MIN_THINKING_TOKENS && ratio >= DRIFT_THRESHOLDS.LOOP_RATIO && num(t.mutatingCalls) === 0) {
    return 'loop_suspect';
  }
  if (thinking > 0 && ratio >= DRIFT_THRESHOLDS.ELEVATED_RATIO) return 'elevated';
  return 'nominal';
}

export function evaluateThinkingDriftLoop(turnRecords = []) {
  const records = Array.isArray(turnRecords) ? turnRecords : [];
  let consecutive = 0;
  let runThinking = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (num(rec.mutatingCalls) > 0) break;
    runThinking += num(rec.thinkingTokens);
    if (classifyTurnDrift(rec) === 'loop_suspect') consecutive += 1;
    else break;
  }
  const last = records[records.length - 1] || null;
  let severity = 'none';
  if (consecutive >= DRIFT_THRESHOLDS.CONSECUTIVE_TURNS_CRITICAL ||
      (consecutive >= 1 && runThinking >= DRIFT_THRESHOLDS.CUMULATIVE_THINKING_TOKENS)) {
    severity = 'critical';
  } else if (consecutive === 1) {
    severity = 'warn';
  }
  const triggered = severity !== 'none';
  const ratio = last ? round2(num(last.thinkingTokens) / Math.max(1, num(last.visibleOutputTokens))) : 0;
  return {
    detectorId: THINKING_DRIFT_DETECTOR_ID,
    deprecatedAlias: THINKING_DRIFT_DEPRECATED_ALIAS,
    gaDetectorId: THINKING_DRIFT_GA_DETECTOR_ID,
    slug: THINKING_DRIFT_SLUG,
    triggered,
    severity,
    consecutiveLoopTurns: consecutive,
    trailingThinkingTokens: runThinking,
    message: triggered
      ? `${THINKING_DRIFT_DETECTOR_ID} Scratchpad Loop: ${ratio}x reasoning-to-output over ${consecutive} turn(s) with 0 edits. Give a concrete target file + acceptance test, or lower /effort.`
      : ''
  };
}

/**
 * Applies one main-agent usage delta to the drift tracker.
 *
 * @param {object} drift
 * @param {object} ev
 * @param {'turn.step'|'turn.complete'} ev.eventType
 * @param {number} ev.thinkingTokens - delta thinking tokens (reported, never estimated)
 * @param {number} ev.outputTokens - delta visible output tokens
 * @param {number} ev.nowMs
 * @param {number|null} [ev.turnStartedAtMs]
 * @param {number|null} [ev.ttftMs] - explicit TTFT from the host, if provided
 * @param {number} [ev.turnMutations] - workspace edits observed in this turn so far
 */
export function applyThinkingDriftEvent(drift, ev = {}) {
  const d = drift && typeof drift === 'object' ? drift : createInitialThinkingDrift();
  if (!Array.isArray(d.turns)) d.turns = [];

  if (!d.current) {
    d.current = {
      startTs: num(ev.turnStartedAtMs) || null,
      ttftMs: null,
      thinkingTokens: 0,
      visibleOutputTokens: 0,
      mutatingCalls: 0
    };
  }
  const cur = d.current;
  if (!cur.startTs && num(ev.turnStartedAtMs)) cur.startTs = num(ev.turnStartedAtMs);
  if (cur.ttftMs === null) {
    if (num(ev.ttftMs) > 0) cur.ttftMs = num(ev.ttftMs);
    else if (cur.startTs && num(ev.nowMs) >= cur.startTs && (num(ev.outputTokens) > 0 || num(ev.thinkingTokens) > 0)) {
      cur.ttftMs = num(ev.nowMs) - cur.startTs;
    }
  }
  cur.thinkingTokens += num(ev.thinkingTokens);
  cur.visibleOutputTokens += num(ev.outputTokens);
  cur.mutatingCalls = Math.max(cur.mutatingCalls, num(ev.turnMutations));

  const snapshot = (t) => ({
    ttftMs: t.ttftMs,
    thinkingTokens: t.thinkingTokens,
    visibleOutputTokens: t.visibleOutputTokens,
    mutatingCalls: t.mutatingCalls,
    driftRatio: round2(t.thinkingTokens / Math.max(1, t.visibleOutputTokens)),
    driftState: classifyTurnDrift(t)
  });

  const live = snapshot(cur);
  if (ev.eventType === 'turn.complete') {
    if (live.thinkingTokens > 0 || live.visibleOutputTokens > 0 || live.ttftMs !== null) {
      d.turns.push(live);
      d.turns = d.turns.slice(-DRIFT_THRESHOLDS.HISTORY);
    }
    d.current = null;
  }

  // Evaluate over completed turns plus the in-flight turn (catches loops mid-turn).
  const series = ev.eventType === 'turn.complete' ? d.turns : [...d.turns, live];
  const scored = series.filter((t) => t.thinkingTokens > 0 || t.visibleOutputTokens > 0);
  const last = scored[scored.length - 1] || null;
  const rolling = scored.slice(-DRIFT_THRESHOLDS.ROLLING_WINDOW);
  const ttfts = series.map((t) => t.ttftMs).filter((v) => typeof v === 'number');

  d.measured = scored.some((t) => t.thinkingTokens > 0);
  d.loop = evaluateThinkingDriftLoop(scored);
  d.lastTtftMs = ttfts.length ? ttfts[ttfts.length - 1] : null;
  d.avgTtftMs = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;
  d.lastDriftRatio = d.measured && last ? last.driftRatio : null;
  d.rollingDriftRatio = d.measured
    ? round2(rolling.reduce((a, t) => a + t.thinkingTokens, 0) / Math.max(1, rolling.reduce((a, t) => a + t.visibleOutputTokens, 0)))
    : null;
  d.driftState = !d.measured
    ? 'n/a'
    : d.loop.triggered ? 'loop_detected' : (last && last.driftState === 'elevated' ? 'elevated' : 'nominal');
  return d;
}

export function formatTtft(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function formatDriftCompact(d = {}) {
  if (!d || !d.measured || d.lastDriftRatio === null || d.lastDriftRatio === undefined) return 'Think —';
  if (d.driftState === 'loop_detected') return `!LOOP ${d.lastDriftRatio}x`;
  return `Think ${d.lastDriftRatio}x`;
}

export function formatDriftLabel(d = {}) {
  return `${formatDriftCompact(d)} · TTFT ${formatTtft(d?.lastTtftMs)}`;
}
