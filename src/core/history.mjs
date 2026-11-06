import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-session snapshot history powering the turn-to-turn token delta
 * ("+4.2k since last turn · from read_file foo.html").
 *
 * Snapshots are keyed by user-turn count: repeated polls within the same user
 * turn overwrite the latest snapshot, so the delta always compares the live
 * state against the end of the previous user turn.
 */

export const HISTORY_MAX_SNAPSHOTS = 50;
/** A drop larger than this fraction of the previous total is reported as a compaction. */
export const COMPACTION_DROP_RATIO = 0.2;

export function historyDir(cacheDir) {
  return path.join(cacheDir, 'history');
}

function historyFile(cacheDir, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(historyDir(cacheDir), `${safe}.json`);
}

export function loadHistory(cacheDir, sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(historyFile(cacheDir, sessionId), 'utf8'));
    return { snapshots: Array.isArray(data.snapshots) ? data.snapshots : [], flags: data.flags || {} };
  } catch {
    return { snapshots: [], flags: {} };
  }
}

export function saveHistory(cacheDir, sessionId, history) {
  const file = historyFile(cacheDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history), 'utf8');
  fs.renameSync(tmp, file);
}

const isUserTurn = s => s && (s.type === 'USER_INPUT');

export function countUserTurns(steps) {
  return (steps || []).reduce((n, s) => n + (isUserTurn(s) ? 1 : 0), 0);
}

/** Same per-step estimate the classifier uses (before provider rescaling). */
export function estimateStepTokens(step) {
  if (!step) return 0;
  if (step.inputTokens > 0 && step.outputTokens > 0) {
    return Math.max(step.outputTokens, Math.round((step.untruncatedLength || 0) / 4));
  }
  return step.outputTokens || Math.round((step.untruncatedLength || 0) / 4) || 0;
}

export function describeStep(step) {
  const call = (step?.toolCalls || [])[0];
  if (call) {
    const a = call.args || {};
    if (a.CommandLine) {
      const cmd = String(a.CommandLine).trim().split(/\s+/)[0].split(/[\\/]/).pop();
      return `${call.name || 'run_command'} ${cmd.slice(0, 40)}`;
    }
    const target = a.Path || a.path || a.AbsolutePath || a.TargetFile || a.query || '';
    const short = String(target).split(/[\\/]/).filter(Boolean).pop() || String(target);
    return `${call.name || 'tool'}${short ? ' ' + short.slice(0, 60) : ''}`;
  }
  if (isUserTurn(step)) return 'your message';
  return String(step?.type || 'model output').toLowerCase().replace(/_/g, ' ');
}

export function buildSnapshot(state, steps) {
  return {
    userTurn: countUserTurns(steps),
    stepCount: (steps || []).length,
    total: state?.window?.totalActiveTokens || 0,
    byCategory: { ...(state?.breakdown || {}) },
    ts: Date.now()
  };
}

export function hasCompactionMarker(steps = [], startIndex = 0) {
  for (let i = Math.max(0, startIndex); i < steps.length; i++) {
    const s = steps[i];
    if (!s) continue;
    const content = String(s.content || '');
    if (
      s.type === 'CHECKPOINT' ||
      content.includes('<CONTEXT_SUMMARY>') ||
      content.includes('[Context Compacted]')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Computes the delta between two snapshots. `topSource` is the largest raw step
 * added since `prev.stepCount`. Distinguishes Undo/Rewind rollbacks from Compaction.
 */
export function computeDelta(prev, curr, steps = []) {
  if (!prev || !curr) return null;
  const tokens = curr.total - prev.total;
  const byCategory = {};
  const keys = new Set([...Object.keys(prev.byCategory || {}), ...Object.keys(curr.byCategory || {})]);
  for (const k of keys) {
    const d = (curr.byCategory?.[k] || 0) - (prev.byCategory?.[k] || 0);
    if (d !== 0) byCategory[k] = d;
  }
  let topSource = null;
  const parentSteps = (steps || []).filter(s => !s?.agentId || s.agentId === 'parent');
  for (let i = Math.max(0, prev.stepCount || 0); i < parentSteps.length; i++) {
    const t = estimateStepTokens(parentSteps[i]);
    if (t > 0 && (!topSource || t > topSource.tokens)) {
      topSource = { label: describeStep(parentSteps[i]), tokens: t, stepIndex: i };
    }
  }
  const stepRegressed = curr.stepCount < prev.stepCount;
  const markerFound = hasCompactionMarker(parentSteps, Math.max(0, curr.stepCount - 3));
  const rewound = stepRegressed && !markerFound;
  const compacted = !rewound && prev.total > 0 && (tokens < -COMPACTION_DROP_RATIO * prev.total || (stepRegressed && markerFound));
  return { tokens, byCategory, topSource, compacted, rewound, sinceUserTurn: prev.userTurn };
}

/**
 * Records the snapshot for the current user turn and returns
 * `{ delta, history }`. Never throws; history I/O failures yield `delta: null`.
 */
export function recordAndDelta(cacheDir, sessionId, state, steps) {
  try {
    const parentSteps = (steps || []).filter(s => !s?.agentId || s.agentId === 'parent');
    const history = loadHistory(cacheDir, sessionId);
    const snap = buildSnapshot(state, parentSteps);
    const snaps = history.snapshots;
    const last = snaps[snaps.length - 1];

    // Detect Undo/Rewind rollback vs full replacement
    let rewindFromSnap = null;
    if (last && (snap.stepCount < last.stepCount || snap.userTurn < last.userTurn)) {
      const isCompact = hasCompactionMarker(parentSteps, Math.max(0, snap.stepCount - 3));
      if (!isCompact) {
        rewindFromSnap = last;
        while (snaps.length > 0 && (snaps[snaps.length - 1].userTurn > snap.userTurn || snaps[snaps.length - 1].stepCount > snap.stepCount)) {
          snaps.pop();
        }
      }
    }

    const latest = snaps[snaps.length - 1];
    if (latest && latest.userTurn === snap.userTurn) snaps[snaps.length - 1] = snap;
    else snaps.push(snap);
    if (snaps.length > HISTORY_MAX_SNAPSHOTS) snaps.splice(0, snaps.length - HISTORY_MAX_SNAPSHOTS);

    let prev = rewindFromSnap;
    if (!prev) {
      for (let i = snaps.length - 1; i >= 0; i--) {
        if (snaps[i].userTurn < snap.userTurn) { prev = snaps[i]; break; }
      }
    }
    const delta = computeDelta(prev, snap, parentSteps);
    saveHistory(cacheDir, sessionId, history);
    return { delta, history };
  } catch {
    return { delta: null, history: null };
  }
}

/**
 * One-time compact reminder per crossing of `state.window.reminderAt`.
 * Returns true exactly once per crossing; the flag re-arms after a compaction
 * (delta.compacted) or when usage falls back below the reminder line.
 */
export function shouldFireReminder(cacheDir, sessionId, state, delta) {
  try {
    const total = state?.window?.totalActiveTokens || 0;
    const reminderAt = state?.window?.reminderAt;
    if (!reminderAt) return false;
    const history = loadHistory(cacheDir, sessionId);
    const fired = Boolean(history.flags.reminderFired);
    let fire = false;
    if (delta?.compacted || total < reminderAt) {
      if (!fired) return false;
      history.flags.reminderFired = false;
    } else if (!fired) {
      history.flags.reminderFired = true;
      history.flags.reminderFiredAt = Date.now();
      fire = true;
    } else {
      return false;
    }
    saveHistory(cacheDir, sessionId, history);
    return fire;
  } catch {
    return false;
  }
}
