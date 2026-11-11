/**
 * @file src/core/sprint_metrics.mjs
 * Sprint 1 "Metrics Wedge" — pure, zero-dependency telemetry derivations:
 *
 *   1. Prefix-Cache Retention Index (0–100%)
 *      Of the prompt prefix that *should* have been served from a warm KV cache
 *      (prior turn in the same session::agent stream, inside the active TTL),
 *      how much actually was? Reports $ retained (discount captured) vs. $ leaked
 *      (cold re-prefill paid because the prefix was busted).
 *
 *   2. Thinking vs. Generation Drift + DET-30 Scratchpad Loop Detector
 *      Per user turn: reasoning tokens / visible emission tokens, TTFT, and
 *      whether the agent is burning reasoning budget without mutating anything.
 *
 * Integrity rule: only *measured* usage is scored. Turns with no recorded token
 * usage, or thinking tokens that were estimated rather than reported, never
 * contribute — the index returns `null` (rendered as "—") instead of a fabricated 100%.
 */

export const RETENTION_CONSTANTS = Object.freeze({
  DEFAULT_TTL_SECONDS: 300,
  BUST_RETAINED_RATIO: 0.5,   // a turn retaining <50% of its eligible prefix counts as a prefix bust
  GRADE_A_PCT: 90,
  GRADE_B_PCT: 70
});

export const DRIFT_THRESHOLDS = Object.freeze({
  MIN_THINKING_TOKENS: 4000,
  LOOP_RATIO: 12,
  ELEVATED_RATIO: 4,
  CUMULATIVE_THINKING_TOKENS: 10000,
  CONSECUTIVE_TURNS_CRITICAL: 2,
  ROLLING_WINDOW: 3
});

export const THINKING_DRIFT_DETECTOR_ID = 'DET-30';
export const THINKING_DRIFT_SLUG = 'thinking-drift-loop';

const MUTATING_TOOL_RE = /write|edit|replace|create|patch|apply|delete|move|rename|run_command|bash|exec|shell|test/i;

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

function promptTotal(t) {
  return num(t.inputTokens) + num(t.cacheReadTokens) + num(t.cacheCreationTokens);
}

function classifyBustCause(turn, prev) {
  if (prev && turn.modelId && prev.modelId && turn.modelId !== prev.modelId) return 'model_switch';
  if (turn.explicitMutation) return 'prefix_mutation';
  return 'prefix_drift';
}

/**
 * Computes the Prefix-Cache Retention Index from per-turn usage records.
 *
 * @param {Array<object>} turns - records with { agent_id?, session_id?, modelId?, inputTokens,
 *   cacheReadTokens, cacheCreationTokens, timestampMs?, ttlSeconds?, explicitMutation?,
 *   rates?: { input, cachedRead } } (USD per 1M tokens)
 * @param {object} [options]
 * @param {{input:number, cachedRead:number}} [options.defaultRates]
 * @returns {{
 *   measured: boolean, retentionIndexPct: number|null, grade: 'A'|'B'|'C'|'n/a',
 *   eligiblePrefixTokens: number, retainedPrefixTokens: number, leakedPrefixTokens: number,
 *   measuredTurns: number, bustCount: number, ttlExpiredTurns: number,
 *   bustCauses: Record<string, number>, lastBust: object|null,
 *   retainedDiscountSavingsUSD: number, leakedColdPrefillUSD: number, label: string
 * }}
 */
export function computePrefixRetentionIndex(turns = [], options = {}) {
  const defaultRates = options.defaultRates || null;
  const prevByStream = new Map();
  let eligible = 0;
  let retained = 0;
  let measuredTurns = 0;
  let bustCount = 0;
  let ttlExpiredTurns = 0;
  let savingsUSD = 0;
  let leakedUSD = 0;
  const bustCauses = {};
  let lastBust = null;

  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || typeof turn !== 'object') continue;
    const total = promptTotal(turn);
    if (total <= 0) continue; // unmeasured (inferred / no usage) — never scored
    const streamKey = `${turn.session_id || turn.sessionId || 'default'}::${turn.agent_id || turn.agentId || 'primary'}`;
    const prev = prevByStream.get(streamKey) || null;
    prevByStream.set(streamKey, turn);
    if (!prev) continue; // first measured turn in stream is a mandatory cold prefill

    const ttlSec = num(prev.ttlSeconds) || RETENTION_CONSTANTS.DEFAULT_TTL_SECONDS;
    const prevTs = num(prev.timestampMs);
    const currTs = num(turn.timestampMs);
    const gapSec = prevTs > 0 && currTs >= prevTs ? (currTs - prevTs) / 1000 : null;
    if (gapSec !== null && gapSec > ttlSec) {
      ttlExpiredTurns += 1; // idle expiry is a TTL problem, not a prefix-structure bust
      continue;
    }

    const turnEligible = Math.min(promptTotal(prev), total);
    if (turnEligible <= 0) continue;
    const turnRetained = Math.min(num(turn.cacheReadTokens), turnEligible);
    const turnLeaked = turnEligible - turnRetained;
    measuredTurns += 1;
    eligible += turnEligible;
    retained += turnRetained;

    const rates = turn.rates || defaultRates || {};
    const discountPerToken = Math.max(0, num(rates.input) - num(rates.cachedRead)) / 1_000_000;
    savingsUSD += turnRetained * discountPerToken;
    leakedUSD += turnLeaked * discountPerToken;

    if (turnRetained / turnEligible < RETENTION_CONSTANTS.BUST_RETAINED_RATIO) {
      bustCount += 1;
      const cause = classifyBustCause(turn, prev);
      bustCauses[cause] = (bustCauses[cause] || 0) + 1;
      lastBust = {
        cause,
        stepIndex: turn.stepIndex ?? null,
        leakedTokens: turnLeaked,
        leakedUSD: round6(turnLeaked * discountPerToken)
      };
    }
  }

  const measured = measuredTurns > 0;
  const retentionIndexPct = measured
    ? Math.max(0, Math.min(100, Math.round((100 * retained) / eligible)))
    : null;
  const grade = !measured
    ? 'n/a'
    : retentionIndexPct >= RETENTION_CONSTANTS.GRADE_A_PCT
      ? 'A'
      : retentionIndexPct >= RETENTION_CONSTANTS.GRADE_B_PCT ? 'B' : 'C';

  const result = {
    measured,
    retentionIndexPct,
    grade,
    eligiblePrefixTokens: eligible,
    retainedPrefixTokens: retained,
    leakedPrefixTokens: eligible - retained,
    measuredTurns,
    bustCount,
    ttlExpiredTurns,
    bustCauses,
    lastBust,
    retainedDiscountSavingsUSD: round6(savingsUSD),
    leakedColdPrefillUSD: round6(leakedUSD)
  };
  result.label = formatRetentionLabel(result);
  return result;
}

/**
 * Compact single-line label: "Retain 97% · Saved $1.42 · Leaked $0.08" or "Retain — (no multi-turn usage yet)".
 */
export function formatRetentionLabel(r = {}) {
  if (!r || !r.measured || r.retentionIndexPct === null) return 'Retain — (no multi-turn usage yet)';
  const parts = [`Retain ${r.retentionIndexPct}%`, `Saved $${round2(r.retainedDiscountSavingsUSD).toFixed(2)}`];
  if (num(r.leakedColdPrefillUSD) > 0.005) parts.push(`Leaked $${round2(r.leakedColdPrefillUSD).toFixed(2)}`);
  if (r.bustCount > 0) parts.push(`${r.bustCount} bust${r.bustCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function stepTs(s) {
  if (!s) return 0;
  if (typeof s.timestampMs === 'number' && s.timestampMs > 0) return s.timestampMs;
  const parsed = s.createdAt ? Date.parse(s.createdAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function countMutatingCalls(step) {
  const calls = Array.isArray(step?.toolCalls) ? step.toolCalls : (Array.isArray(step?.tool_calls) ? step.tool_calls : []);
  let n = 0;
  for (const c of calls) {
    if (MUTATING_TOOL_RE.test(String(c?.name || c?.toolName || ''))) n += 1;
  }
  return n;
}

/**
 * Classifies a single turn's drift.
 * @param {{thinkingTokens:number, visibleOutputTokens:number, mutatingCalls:number}} t
 * @returns {'nominal'|'elevated'|'loop_suspect'}
 */
export function classifyTurnDrift(t = {}) {
  const thinking = num(t.thinkingTokens);
  const ratio = thinking / Math.max(1, num(t.visibleOutputTokens));
  if (thinking >= DRIFT_THRESHOLDS.MIN_THINKING_TOKENS && ratio >= DRIFT_THRESHOLDS.LOOP_RATIO && num(t.mutatingCalls) === 0) {
    return 'loop_suspect';
  }
  if (thinking > 0 && ratio >= DRIFT_THRESHOLDS.ELEVATED_RATIO) return 'elevated';
  return 'nominal';
}

/**
 * Evaluates DET-30 across a chronological list of per-turn drift records.
 * WARN on one loop-suspect turn; CRITICAL on ≥2 consecutive loop-suspect turns,
 * or ≥10k cumulative thinking tokens across the trailing run with zero mutations.
 */
export function evaluateThinkingDriftLoop(turnRecords = []) {
  const records = Array.isArray(turnRecords) ? turnRecords : [];
  let consecutive = 0;
  let runThinking = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (num(r.mutatingCalls) > 0) break;
    runThinking += num(r.thinkingTokens);
    if (classifyTurnDrift(r) === 'loop_suspect') consecutive += 1;
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
    slug: THINKING_DRIFT_SLUG,
    triggered,
    severity,
    consecutiveLoopTurns: consecutive,
    trailingThinkingTokens: runThinking,
    message: triggered
      ? `${severity === 'critical' ? '🚨' : '⚠️'} ${THINKING_DRIFT_DETECTOR_ID} Scratchpad Loop: ${ratio}x reasoning-to-output over ${consecutive} turn(s) with 0 edits. Inject a concrete constraint (target file + acceptance test) or step effort down.`
      : ''
  };
}

/**
 * Computes Thinking vs. Generation Drift from raw chronological steps
 * (USER_INPUT / PLANNER_RESPONSE / tool steps). Only *reported* thinking tokens count;
 * steps flagged `thinkingEstimated` are excluded from the ratio.
 *
 * @param {Array<object>} steps
 * @returns {{
 *   measured: boolean, turns: Array<object>, lastTtftMs: number|null, avgTtftMs: number|null,
 *   lastDriftRatio: number|null, rollingDriftRatio: number|null,
 *   driftState: 'nominal'|'elevated'|'loop_detected'|'n/a', loop: object, label: string
 * }}
 */
export function computeThinkingDrift(steps = []) {
  const turns = [];
  let current = null;
  const flush = () => {
    if (current && (current.thinkingTokens > 0 || current.visibleOutputTokens > 0 || current.ttftMs !== null)) {
      turns.push(current);
    }
  };

  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'USER_INPUT') {
      flush();
      current = {
        userStepIndex: s.stepIndex ?? null,
        startTs: stepTs(s),
        ttftMs: null,
        thinkingTokens: 0,
        visibleOutputTokens: 0,
        mutatingCalls: 0
      };
      continue;
    }
    if (!current) {
      current = { userStepIndex: null, startTs: 0, ttftMs: null, thinkingTokens: 0, visibleOutputTokens: 0, mutatingCalls: 0 };
    }
    if (s.type === 'PLANNER_RESPONSE' || s.type === 'ASSISTANT' || s.role === 'assistant') {
      const ts = stepTs(s);
      if (current.ttftMs === null && current.startTs > 0 && ts >= current.startTs) {
        current.ttftMs = ts - current.startTs;
      }
      if (!s.thinkingEstimated) current.thinkingTokens += num(s.thinkingTokens);
      current.visibleOutputTokens += num(s.outputTokens);
    }
    current.mutatingCalls += countMutatingCalls(s);
  }
  flush();

  for (const t of turns) {
    t.driftRatio = round2(t.thinkingTokens / Math.max(1, t.visibleOutputTokens));
    t.driftState = classifyTurnDrift(t);
  }

  const withThinking = turns.filter((t) => t.thinkingTokens > 0 || t.visibleOutputTokens > 0);
  const ttfts = turns.map((t) => t.ttftMs).filter((v) => typeof v === 'number');
  const last = withThinking[withThinking.length - 1] || null;
  const rolling = withThinking.slice(-DRIFT_THRESHOLDS.ROLLING_WINDOW);
  const rollThinking = rolling.reduce((a, t) => a + t.thinkingTokens, 0);
  const rollVisible = rolling.reduce((a, t) => a + t.visibleOutputTokens, 0);
  const measured = withThinking.some((t) => t.thinkingTokens > 0);
  const loop = evaluateThinkingDriftLoop(withThinking);

  let driftState = 'n/a';
  if (measured) {
    driftState = loop.triggered ? 'loop_detected' : (last && last.driftState === 'elevated' ? 'elevated' : 'nominal');
  }

  const result = {
    measured,
    turns: turns.slice(-20),
    lastTtftMs: ttfts.length ? ttfts[ttfts.length - 1] : null,
    avgTtftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
    lastDriftRatio: measured && last ? last.driftRatio : null,
    rollingDriftRatio: measured ? round2(rollThinking / Math.max(1, rollVisible)) : null,
    driftState,
    loop
  };
  result.label = formatDriftLabel(result);
  return result;
}

export function formatTtft(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * "Think 1.8x · TTFT 1.1s" | "LOOP 16.4x · TTFT 9.2s" | "Think — · TTFT 1.1s"
 */
export function formatDriftLabel(d = {}) {
  const ttft = `TTFT ${formatTtft(d.lastTtftMs)}`;
  if (!d.measured || d.lastDriftRatio === null) return `Think — · ${ttft}`;
  if (d.driftState === 'loop_detected') return `LOOP ${d.lastDriftRatio}x · ${ttft}`;
  return `Think ${d.lastDriftRatio}x · ${ttft}`;
}
