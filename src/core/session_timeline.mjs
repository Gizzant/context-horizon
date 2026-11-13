/**
 * @file src/core/session_timeline.mjs
 * Pure, deterministic Session Timeline builder for the Simple View "Flight Recorder".
 *
 * Turns parsed transcript steps + classifier output into a per-turn picture of the
 * conversation with GOOD / BAD / NEUTRAL practice markers, a cumulative-context line,
 * baseline event markers (compact, checkpoint, model switch, cache-expired gap) and KPIs.
 *
 * Invariants: zero `node:*` imports, zero network, zero filesystem access, no model-generated text.
 * Every reason string is a deterministic template.
 */

export const TIMELINE_DEFAULTS = Object.freeze({
  WINDOW_TURNS: 39,
  CACHE_TTL_SEC: 300,
  COLD_CLIFF_MIN_PREFIX_TOKENS: 50000,
  SPIKE_TOKENS: 8000,
  BURN_WINDOW_TURNS: 5,
  MIN_TURNS_FOR_PROJECTION: 3,
  CACHED_READ_DISCOUNT: 0.95,
  INPUT_PRICE_PER_1M: 2.0
});

/** Practice taxonomy (kind decides bar color; text is the deterministic tooltip fragment). */
export const TIMELINE_TAGS = Object.freeze({
  DUPLICATE_READ: { kind: 'bad', text: (n) => `Re-read a file in full${n > 1 ? ` ${n}\u00D7` : ''}` },
  DEAD_ERROR: { kind: 'bad', text: (n) => `Error output left in context${n > 1 ? ` (${n} steps)` : ''}` },
  SPIKE: { kind: 'bad', text: () => 'Single-step output spike' },
  COMPACT_WHILE_WARM: { kind: 'bad', text: () => 'Compacted while cache was warm (lost the 95% discount)' },
  MODEL_SWITCH_WARM: { kind: 'bad', text: () => 'Model/effort switched while cache was warm' },
  COLD_CLIFF: { kind: 'bad', text: () => 'Resumed after cache expired with a large prefix' },
  LINE_RANGE_READ: { kind: 'good', text: () => 'Read a line range instead of the full file' },
  CHECKPOINT_SAVED: { kind: 'good', text: () => 'Saved a task.md checkpoint' },
  COMPACT_WHILE_COLD: { kind: 'good', text: () => 'Compacted while cache was cold' },
  SUBAGENT_DELEGATED: { kind: 'good', text: () => 'Delegated heavy work to a subagent' },
  AUTO_FIX_FIRED: { kind: 'good', text: (n) => `Horizon auto-fix fired${n > 1 ? ` ${n}\u00D7` : ''}` }
});

const MARKER_LABELS = Object.freeze({
  COMPACT: 'Compacted',
  CHECKPOINT: 'task.md checkpoint',
  MODEL_SWITCH: 'Model/effort switch',
  COLD_GAP: 'Cache expired after idle gap'
});

function fmtK(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  return `${(v / 1000).toFixed(1)}k`;
}

function isUserStep(s) {
  return Boolean(s && (s.source === 'USER_EXPLICIT' || s.type === 'USER_INPUT' || s.role === 'user'));
}

function stepCalls(s) {
  if (!s) return [];
  if (Array.isArray(s.toolCalls)) return s.toolCalls;
  if (Array.isArray(s.tool_calls)) return s.tool_calls;
  return [];
}

function callName(c) {
  return String(c?.name || c?.tool || '').toLowerCase();
}

function callArgs(c) {
  return c?.args || c?.parameters || c?.Arguments || c?.input || {};
}

function callPath(c) {
  const a = callArgs(c);
  return String(
    a.Path || a.path || a.TargetFile || a.Target || a.target || a.AbsolutePath || a.file_path || a.filePath || ''
  );
}

const READ_TOOL_RE = /^(view_file|read_file|read)$/;
const OUTLINE_TOOL_RE = /^(view_file_outline|view_code_item)$/;
const WRITE_TOOL_RE = /^(write_to_file|write_file|edit_file|replace_file_content|multi_replace_file_content|write|edit|multiedit)$/;
const SUBAGENT_TOOL_RE = /^(invoke_subagent|task|agent)$/;
const CHECKPOINT_PATH_RE = /(^|[\\/])(task|handoff[^\\/]*)\.md$/i;

function isLineRangeRead(c) {
  const n = callName(c);
  if (OUTLINE_TOOL_RE.test(n)) return true;
  if (!READ_TOOL_RE.test(n)) return false;
  const a = callArgs(c);
  return [a.StartLine, a.EndLine, a.start_line, a.end_line, a.offset, a.limit, a.startLine, a.endLine]
    .some((v) => v !== undefined && v !== null && v !== '');
}

function tsMs(s) {
  const raw = s?.createdAt || s?.timestamp || null;
  if (!raw) return NaN;
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : NaN;
}

function finalizeTurn(t) {
  const kinds = t.tags.map((k) => TIMELINE_TAGS[k]?.kind);
  t.practice = kinds.includes('bad') ? 'bad' : (kinds.includes('good') ? 'good' : 'neutral');
  const wanted = t.practice === 'neutral' ? [] : t.tags.filter((k) => TIMELINE_TAGS[k]?.kind === t.practice);
  const texts = wanted.slice(0, 2).map((k) => TIMELINE_TAGS[k].text(t.tagCounts[k] || 1));
  const head = `${fmtK(t.tokensAdded)} added`;
  t.reason = texts.length > 0 ? `${head} \u00B7 ${texts.join(' \u00B7 ')}` : head;
}

function addTag(t, tag, count = 1) {
  if (!TIMELINE_TAGS[tag]) return;
  if (!t.tags.includes(tag)) t.tags.push(tag);
  t.tagCounts[tag] = (t.tagCounts[tag] || 0) + count;
}

/**
 * Builds the Session Timeline contract.
 *
 * @param {object} input
 * @param {Array<object>} input.steps Parsed transcript steps (raw).
 * @param {Array<{stepIndex:number,category:string,tokens:number,target?:string}>} input.classifiedSteps
 * @param {Array<object>} [input.effortTransitions]
 * @param {number} [input.safeLimit]
 * @param {number} [input.totalActiveTokens]
 * @param {(step:object)=>boolean} [input.isCompactionStep]
 * @param {object} [input.options]
 */
export function buildSessionTimeline(input = {}) {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const classified = new Map();
  for (const c of Array.isArray(input.classifiedSteps) ? input.classifiedSteps : []) {
    if (c && Number.isFinite(c.stepIndex)) classified.set(c.stepIndex, c);
  }
  const o = { ...TIMELINE_DEFAULTS, ...(input.options || {}) };
  const ttl = Math.max(1, Number(o.CACHE_TTL_SEC) || TIMELINE_DEFAULTS.CACHE_TTL_SEC);
  const safeLimit = Math.max(0, Number(input.safeLimit) || 0);
  const isCompaction = typeof input.isCompactionStep === 'function' ? input.isCompactionStep : () => false;

  const turns = [];
  const markers = [];
  const stepTurn = new Array(steps.length).fill(0);
  const stepGap = new Array(steps.length).fill(null);
  const coldCliffs = [];
  let baseline = 0;
  let running = 0;
  let prevMs = NaN;
  let hasTimestamps = false;
  let cur = null;

  const openTurn = (idx) => {
    cur = {
      turn: turns.length + 1,
      firstStep: idx,
      lastStep: idx,
      hasUser: false,
      tokensAdded: 0,
      cumulative: 0,
      startedAt: null,
      endedAt: null,
      cache: 'unknown',
      tags: [],
      tagCounts: {},
      practice: 'neutral',
      reason: ''
    };
    turns.push(cur);
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const user = isUserStep(step);
    if (!cur || (user && cur.hasUser)) openTurn(i);
    if (user) cur.hasUser = true;
    cur.lastStep = i;
    stepTurn[i] = turns.length - 1;

    const ms = tsMs(step);
    let gap = null;
    if (Number.isFinite(ms)) {
      hasTimestamps = true;
      if (Number.isFinite(prevMs)) gap = Math.max(0, (ms - prevMs) / 1000);
      prevMs = ms;
      const iso = new Date(ms).toISOString();
      if (!cur.startedAt) cur.startedAt = iso;
      cur.endedAt = iso;
    }
    stepGap[i] = gap;
    if (i === cur.firstStep || (cur.cache === 'unknown' && gap !== null)) {
      if (gap !== null) cur.cache = gap < ttl ? 'warm' : 'cold';
    }

    const cl = classified.get(i);
    const tokens = Math.max(0, Number(cl?.tokens) || 0);
    const cat = String(cl?.category || '');
    if (cat === 'ANCHOR') {
      baseline += tokens;
    } else {
      cur.tokensAdded += tokens;
      running += tokens;
    }

    // Cold-cliff: resume after idle gap > TTL with a large prefix already in context.
    const prefixBefore = baseline + running - (cat === 'ANCHOR' ? 0 : tokens);
    if (gap !== null && gap > ttl && prefixBefore >= o.COLD_CLIFF_MIN_PREFIX_TOKENS && !cur.tags.includes('COLD_CLIFF')) {
      addTag(cur, 'COLD_CLIFF');
      coldCliffs.push({ turn: cur.turn, prefixTokens: prefixBefore, gapSec: Math.round(gap) });
      markers.push({ turn: cur.turn, kind: 'COLD_GAP', label: `${MARKER_LABELS.COLD_GAP} (${Math.round(gap / 60)}m)` });
    }

    if (cat === 'STALE_DUPLICATE' && !String(cl?.target || '').startsWith('Older chat history')) {
      addTag(cur, 'DUPLICATE_READ');
    }
    if (cat === 'DEAD_ERROR') addTag(cur, 'DEAD_ERROR');
    if (i > 0 && cat !== 'ANCHOR' && cat !== '' && tokens >= o.SPIKE_TOKENS) addTag(cur, 'SPIKE');

    for (const call of stepCalls(step)) {
      const n = callName(call);
      if (isLineRangeRead(call)) addTag(cur, 'LINE_RANGE_READ');
      if (SUBAGENT_TOOL_RE.test(n)) addTag(cur, 'SUBAGENT_DELEGATED');
      if (WRITE_TOOL_RE.test(n) && CHECKPOINT_PATH_RE.test(callPath(call))) {
        addTag(cur, 'CHECKPOINT_SAVED');
        markers.push({ turn: cur.turn, kind: 'CHECKPOINT', label: MARKER_LABELS.CHECKPOINT });
      }
    }

    if (i > 0 && isCompaction(step)) {
      if (gap === null) {
        markers.push({ turn: cur.turn, kind: 'COMPACT', label: `${MARKER_LABELS.COMPACT} (cache state unknown)`, approx: true });
      } else if (gap < ttl) {
        addTag(cur, 'COMPACT_WHILE_WARM');
        markers.push({ turn: cur.turn, kind: 'COMPACT', label: `${MARKER_LABELS.COMPACT} while warm` });
      } else {
        addTag(cur, 'COMPACT_WHILE_COLD');
        markers.push({ turn: cur.turn, kind: 'COMPACT', label: `${MARKER_LABELS.COMPACT} while cold` });
      }
    }
    cur.cumulative = baseline + running;
  }

  for (const tr of Array.isArray(input.effortTransitions) ? input.effortTransitions : []) {
    const idx = Number(tr?.stepNumber ?? tr?.turnIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx >= steps.length) continue;
    if (tr.fromLabel && tr.toLabel && tr.fromLabel === tr.toLabel) continue;
    const t = turns[stepTurn[idx]];
    if (!t) continue;
    const gap = stepGap[idx];
    const label = tr.toLabel ? `${MARKER_LABELS.MODEL_SWITCH} \u2192 ${tr.toLabel}` : MARKER_LABELS.MODEL_SWITCH;
    if (gap !== null && gap < ttl) addTag(t, 'MODEL_SWITCH_WARM');
    markers.push({ turn: t.turn, kind: 'MODEL_SWITCH', label });
  }

  for (const t of turns) finalizeTurn(t);

  // Reconcile cumulative with the classifier's authoritative total (compaction can shrink context).
  const total = Math.max(0, Number(input.totalActiveTokens) || 0);
  const lastCum = turns.length ? turns[turns.length - 1].cumulative : 0;
  let cumulativeScaled = false;
  if (total > 0 && lastCum > total * 1.02) {
    const k = total / lastCum;
    for (const t of turns) t.cumulative = Math.round(t.cumulative * k);
    cumulativeScaled = true;
  }

  const windowTurns = Math.max(1, Number(o.WINDOW_TURNS) || TIMELINE_DEFAULTS.WINDOW_TURNS);
  const earlierCount = Math.max(0, turns.length - windowTurns);
  const earlierTurns = turns.slice(0, earlierCount);
  const kept = turns.slice(earlierCount);
  const earlier = {
    turns: earlierCount,
    tokens: earlierTurns.reduce((s, t) => s + t.tokensAdded, 0),
    bad: earlierTurns.filter((t) => t.practice === 'bad').length,
    good: earlierTurns.filter((t) => t.practice === 'good').length
  };
  const firstKeptTurn = kept.length ? kept[0].turn : 1;
  const keptMarkers = markers.filter((m) => m.turn >= firstKeptTurn);

  const lossPerToken = (Number(o.INPUT_PRICE_PER_1M) / 1_000_000) * Number(o.CACHED_READ_DISCOUNT);
  const coldRestartLossUsd = Number(
    coldCliffs.reduce((s, c) => s + c.prefixTokens * lossPerToken, 0).toFixed(4)
  );

  const recent = turns.filter((t) => t.tokensAdded > 0).slice(-o.BURN_WINDOW_TURNS);
  const burnRateTokens = recent.length >= 1
    ? Math.round(recent.reduce((s, t) => s + t.tokensAdded, 0) / recent.length)
    : 0;
  const effectiveTotal = total > 0 ? total : lastCum;
  const overLimit = safeLimit > 0 && effectiveTotal > safeLimit;
  let turnsLeft = null;
  if (turns.length >= o.MIN_TURNS_FOR_PROJECTION && safeLimit > 0 && burnRateTokens > 0) {
    turnsLeft = overLimit ? 0 : Math.floor((safeLimit - effectiveTotal) / burnRateTokens);
  }

  return {
    version: 1,
    hasTimestamps,
    cacheTtlSec: ttl,
    safeLimit,
    totalTurns: turns.length,
    cumulativeScaled,
    earlier,
    turns: kept.map((t) => ({
      turn: t.turn,
      tokensAdded: t.tokensAdded,
      cumulative: t.cumulative,
      practice: t.practice,
      tags: [...t.tags],
      tagCounts: { ...t.tagCounts },
      reason: t.reason,
      cache: t.cache,
      startedAt: t.startedAt,
      endedAt: t.endedAt
    })),
    markers: keptMarkers,
    coldCliffs,
    kpis: {
      burnRateTokens,
      turnsLeft,
      overLimit,
      coldRestartLossUsd,
      goodCount: turns.filter((t) => t.practice === 'good').length,
      badCount: turns.filter((t) => t.practice === 'bad').length
    }
  };
}

/**
 * Attaches verified ledger auto-fix events to their turns (adds AUTO_FIX_FIRED and updates reasons).
 * Mutates `timeline` and each item's `turn`; returns `timeline`.
 */
export function applyAutoFixToTimeline(timeline, items = []) {
  if (!timeline || !Array.isArray(timeline.turns)) return timeline;
  // Idempotent: clear previous auto-fix tags so repeated daemon ticks never double-count.
  for (const t of timeline.turns) {
    t.tags = t.tags.filter((k) => k !== 'AUTO_FIX_FIRED');
    delete t.tagCounts.AUTO_FIX_FIRED;
  }
  for (const it of Array.isArray(items) ? items : []) {
    const ms = Date.parse(String(it?.at || ''));
    if (!Number.isFinite(ms)) continue;
    let target = null;
    for (const t of timeline.turns) {
      const startMs = Date.parse(String(t.startedAt || ''));
      if (Number.isFinite(startMs) && startMs <= ms) target = t;
    }
    if (!target) continue;
    it.turn = target.turn;
    if (!target.tags.includes('AUTO_FIX_FIRED')) target.tags.push('AUTO_FIX_FIRED');
    target.tagCounts.AUTO_FIX_FIRED = (target.tagCounts.AUTO_FIX_FIRED || 0) + 1;
  }
  for (const t of timeline.turns) finalizeTurn(t);
  timeline.kpis = {
    ...(timeline.kpis || {}),
    goodCount: timeline.turns.filter((t) => t.practice === 'good').length + (timeline.earlier?.good || 0),
    badCount: timeline.turns.filter((t) => t.practice === 'bad').length + (timeline.earlier?.bad || 0)
  };
  return timeline;
}

export default buildSessionTimeline;
