import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './paths.mjs';

/**
 * Cross-session "repeat offender" tracking: files that get re-read in many
 * sessions are good `.antigravityignore` / line-range candidates.
 *
 * Storage: `<cacheDir>/offenders.jsonl`, one line per session:
 *   {"sid":"...","ts":1730000000000,"files":[{"path":"C:/x/a.js","reads":3}]}
 * Upserts are idempotent per sid; old lines are pruned on every write.
 */

export const OFFENDER_RETENTION = { maxSessions: 20, maxDays: 14 };
export const CHRONIC_MIN_SESSIONS = 3;

export function offendersFile(cacheDir) {
  return path.join(cacheDir, 'offenders.jsonl');
}

export function readSessions(cacheDir) {
  try {
    return fs.readFileSync(offendersFile(cacheDir), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.sid && Array.isArray(e.files));
  } catch {
    return [];
  }
}

export function pruneSessions(entries, { maxSessions, maxDays } = OFFENDER_RETENTION, now = Date.now()) {
  const cutoff = now - maxDays * 86400000;
  return entries
    .filter(e => (e.ts || 0) >= cutoff)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, maxSessions);
}

function sameFiles(a, b) {
  if (!a || a.length !== b.length) return false;
  return a.every((f, i) => f.path === b[i].path && f.reads === b[i].reads);
}

/**
 * Upserts this session's duplicate-read list. `duplicateFiles` items are
 * `{ path, occurrences }` (classifier `brainSignals.duplicateReads.topFiles`).
 * Skips the disk write when nothing changed. Returns the pruned entry list.
 */
export function recordSession(cacheDir, sessionId, duplicateFiles = [], opts = OFFENDER_RETENTION, now = Date.now()) {
  const files = (duplicateFiles || [])
    .filter(f => f && f.path && (f.occurrences || 0) >= 2)
    .map(f => ({ path: String(f.path), reads: f.occurrences }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const entries = readSessions(cacheDir);
  const existing = entries.find(e => e.sid === sessionId);
  if (existing && sameFiles(existing.files, files)) return pruneSessions(entries, opts, now);
  if (!existing && files.length === 0) return pruneSessions(entries, opts, now);

  const next = pruneSessions([
    ...entries.filter(e => e.sid !== sessionId),
    { sid: sessionId, ts: now, files }
  ], opts, now);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = offendersFile(cacheDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {}
  return next;
}

/** Aggregates entries into `[{ path, sessions, totalReads, windowSessions }]`, most chronic first. */
export function aggregate(entries, opts = OFFENDER_RETENTION, now = Date.now()) {
  const kept = pruneSessions(entries, opts, now);
  const map = new Map();
  for (const e of kept) {
    for (const f of e.files) {
      const key = canonicalizePath(f.path);
      const agg = map.get(key) || { path: f.path, key, sessions: 0, totalReads: 0 };
      agg.sessions += 1;
      agg.totalReads += f.reads || 0;
      map.set(key, agg);
    }
  }
  return [...map.values()]
    .map(a => ({ ...a, windowSessions: kept.length }))
    .sort((a, b) => b.sessions - a.sessions || b.totalReads - a.totalReads);
}

/** Records the current session and returns the top-N chronic re-read list for `state.chronicReads`. */
export function updateChronicReads(cacheDir, sessionId, duplicateFiles, limit = 10) {
  try {
    const entries = recordSession(cacheDir, sessionId, duplicateFiles);
    return aggregate(entries).slice(0, limit);
  } catch {
    return [];
  }
}
