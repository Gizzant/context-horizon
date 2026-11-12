/**
 * @file src/telemetry/scopeLockRegistry.mjs
 * Concurrent Multi-Agent File-Scope Lockfile Registry (`.claude/locks/active_scopes.json`)
 * and 5-Hour / Spend-Limit Quota Hard Brake (`DET-20`).
 *
 * Includes full dotfile support (`.github/*`, `.claude/*`, `.env.example`).
 */

import { path, getCwd, writeJsonAtomic, readJsonSafe } from '../utils/runtime.mjs';

export const DEFAULT_SCOPE_LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Normalizes a file path or glob pattern to POSIX forward slashes for consistent scope matching.
 * Preserves leading dotfiles (e.g. `.github/workflows/ci.yml`, `.claude/settings.json`, `.env.example`).
 *
 * @param {string} rawPath
 * @param {string} [cwd='']
 * @returns {string}
 */
export function normalizeScopePath(rawPath = '', cwd = '') {
  let cleaned = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!cleaned) return '';

  if (cwd) {
    const normCwd = String(cwd).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (normCwd && cleaned.toLowerCase().startsWith(normCwd.toLowerCase() + '/')) {
      cleaned = cleaned.slice(normCwd.length + 1);
    }
  }

  cleaned = cleaned.replace(/^(\.\/)+/, '').replace(/\/+/g, '/');
  return cleaned;
}

/**
 * Converts a scope glob pattern (supporting dotfiles like `.github/*`, `.claude/**`, `.env*`)
 * into a RegExp that explicitly matches leading dots in path segments.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToDotfileRegex(pattern = '') {
  const norm = normalizeScopePath(pattern);
  if (!norm) return /^$/;

  // If pattern is a directory prefix ending with `/`, match everything inside it
  if (norm.endsWith('/')) {
    const escapedDir = norm.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escapedDir}.+$`, 'i');
  }

  let regexStr = '^';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        // `**` matches across directory boundaries including dotfiles
        regexStr += '.*';
        i += 1;
        if (norm[i + 1] === '/') {
          i += 1;
        }
      } else {
        // Single `*` matches any characters within a segment, INCLUDING leading `.`
        regexStr += '[^/]*';
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

/**
 * Checks whether a target file path matches a scope pattern (including dotfiles).
 * Also matches if the pattern is `dir/*` and the target is nested inside `dir/...`.
 *
 * @param {string} targetFilePath
 * @param {string} scopePattern
 * @param {string} [cwd='']
 * @returns {boolean}
 */
export function matchesScopePattern(targetFilePath, scopePattern, cwd = '') {
  const normTarget = normalizeScopePath(targetFilePath, cwd);
  const normPattern = normalizeScopePath(scopePattern, cwd);
  if (!normTarget || !normPattern) return false;

  if (normTarget.toLowerCase() === normPattern.toLowerCase()) {
    return true;
  }

  // If scopePattern ends with `/*`, also match nested paths under that directory (e.g. `.github/*` matches `.github/workflows/ci.yml`)
  if (normPattern.endsWith('/*') && !normPattern.endsWith('/**')) {
    const prefix = normPattern.slice(0, -1).toLowerCase(); // includes trailing `/`
    if (normTarget.toLowerCase().startsWith(prefix)) {
      return true;
    }
  }

  const rx = globToDotfileRegex(normPattern);
  return rx.test(normTarget);
}

/**
 * Resolves the lockfile path `.claude/locks/active_scopes.json`.
 * @param {object} [options={}]
 * @returns {string}
 */
export function getScopeLocksPath(options = {}) {
  if (options.locksFilePath) return options.locksFilePath;
  const cwd = getCwd(options);
  return path.join(cwd, '.claude', 'locks', 'active_scopes.json');
}

/**
 * Normalizes a lock or Antigravity `leases[]` record (`{ agent_id, session_id, files_locked, expires_at }`
 * or `{ trajectoryId, agentRole, claimedPaths, acquiredAtIso, expiresAtMs }`)
 * into the canonical `{ ownerId, scopes, acquiredAt, expiresAt }` shape (`ISS-020`, `ISS-055`).
 *
 * @param {object} entry
 * @param {string} [source='local']
 * @returns {object | null}
 */
function normalizeScopeLockEntry(entry, source = 'local') {
  if (!entry || typeof entry !== 'object') return null;
  const ownerId = String(
    entry.ownerId ||
      entry.agent_id ||
      entry.trajectoryId ||
      entry.session_id ||
      entry.sessionId ||
      entry.agentRole ||
      ''
  ).trim();

  const rawScopes = Array.isArray(entry.scopes)
    ? entry.scopes
    : Array.isArray(entry.files_locked)
      ? entry.files_locked
      : Array.isArray(entry.claimedPaths)
        ? entry.claimedPaths
        : [];
  const scopes = rawScopes.map((s) => String(s || '').trim()).filter(Boolean);
  if (!ownerId || scopes.length === 0) return null;

  const acquiredIsoRaw = String(
    entry.acquired_at ||
      entry.acquiredAtIso ||
      (typeof entry.acquiredAt === 'string' ? entry.acquiredAt : '') ||
      ''
  ).trim();
  const parsedAcquiredIso = acquiredIsoRaw ? Date.parse(acquiredIsoRaw) : NaN;
  const acquiredAt =
    typeof entry.acquiredAt === 'number' && Number.isFinite(entry.acquiredAt)
      ? entry.acquiredAt
      : typeof entry.acquiredAtMs === 'number' && Number.isFinite(entry.acquiredAtMs)
        ? entry.acquiredAtMs
        : Number.isFinite(parsedAcquiredIso)
          ? parsedAcquiredIso
          : 0;

  const expiresIsoRaw = String(
    entry.expires_at ||
      entry.expiresAtIso ||
      (typeof entry.expiresAt === 'string' ? entry.expiresAt : '') ||
      ''
  ).trim();
  const parsedExpiresIso = expiresIsoRaw ? Date.parse(expiresIsoRaw) : NaN;
  const expiresAt =
    typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
      ? entry.expiresAt
      : typeof entry.expiresAtMs === 'number' && Number.isFinite(entry.expiresAtMs)
        ? entry.expiresAtMs
        : Number.isFinite(parsedExpiresIso)
          ? parsedExpiresIso
          : 0;

  const normalized = {
    ownerId,
    scopes,
    acquiredAt,
    expiresAt
  };
  if (entry.agentRole) {
    normalized.agentRole = String(entry.agentRole);
  }
  if (source === 'cross_harness') {
    normalized.source = 'cross_harness';
  }
  return normalized;
}

/**
 * Formats a normalized lock entry with both Claude Code (`ownerId`, `scopes`, `expiresAt`)
 * and Antigravity (`agent_id`, `session_id`, `trajectoryId`, `files_locked`, `claimedPaths`,
 * `acquired_at`, `expires_at`, `ttl_ms`) fields for bidirectional cross-harness parity (`ISS-055`).
 *
 * @param {object} lock
 * @param {number} [fallbackTtlMs=DEFAULT_SCOPE_LOCK_TTL_MS]
 * @returns {object}
 */
function buildCrossCompatibleLockRecord(lock, fallbackTtlMs = DEFAULT_SCOPE_LOCK_TTL_MS) {
  const acquiredAt = Number(lock.acquiredAt || Date.now());
  const expiresAt = Number(lock.expiresAt || acquiredAt + fallbackTtlMs);
  const ttlMs = Math.max(0, expiresAt - acquiredAt) || fallbackTtlMs;
  const acquiredIso = new Date(acquiredAt).toISOString();
  const expiresIso = new Date(expiresAt).toISOString();
  return {
    ownerId: lock.ownerId,
    agent_id: lock.ownerId,
    session_id: lock.ownerId,
    trajectoryId: lock.ownerId,
    scopes: [...lock.scopes],
    files_locked: [...lock.scopes],
    claimedPaths: [...lock.scopes],
    acquiredAt,
    acquiredAtMs: acquiredAt,
    acquired_at: acquiredIso,
    acquiredAtIso: acquiredIso,
    expiresAt,
    expiresAtMs: expiresAt,
    expires_at: expiresIso,
    expiresAtIso: expiresIso,
    ttl_ms: ttlMs
  };
}

/**
 * Reads and prunes expired scope locks from `.claude/locks/active_scopes.json`
 * (and cross-harness `.agents/locks/active_scopes.json` `locks[]` + `leases[]` when present in `cwd`).
 * @param {object} [options={}]
 * @returns {{ schemaVersion: string, locks: Array<object> }}
 */
export function readActiveScopeLocks(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const filePath = getScopeLocksPath(options);
  const raw = readJsonSafe(filePath, { schemaVersion: '2026.11.1', locks: [] }, options);
  const locks = [];
  const seenKeys = new Set();

  const pushUnique = (entry, source) => {
    const norm = normalizeScopeLockEntry(entry, source);
    if (!norm) return;
    const dedupKey = `${source}::${norm.ownerId}::${norm.scopes.join('|')}`;
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);
    locks.push(norm);
  };

  if (Array.isArray(raw?.locks)) {
    for (const item of raw.locks) {
      pushUnique(item, 'local');
    }
  }
  if (Array.isArray(raw?.leases)) {
    for (const lease of raw.leases) {
      pushUnique(lease, 'local');
    }
  }

  const resolvedCwd = options.cwd || getCwd(options);
  if (!options.locksFilePath && resolvedCwd && resolvedCwd !== '.') {
    const crossHarnessPath = path.join(resolvedCwd, '.agents', 'locks', 'active_scopes.json');
    const crossRaw = readJsonSafe(crossHarnessPath, null, options);
    if (Array.isArray(crossRaw?.locks)) {
      for (const item of crossRaw.locks) {
        pushUnique(item, 'cross_harness');
      }
    }
    if (Array.isArray(crossRaw?.leases)) {
      for (const lease of crossRaw.leases) {
        pushUnique(lease, 'cross_harness');
      }
    }
  }

  const validLocks = locks.filter((lock) => !lock.expiresAt || lock.expiresAt > nowMs);
  return {
    version: 1,
    schemaVersion: '2026.11.1',
    locks: validLocks
  };
}

/**
 * Acquires a file-scope lock for `(ownerId)` if no conflicting lock exists.
 *
 * @param {object} params
 * @param {string} params.ownerId - Unique owner identifier (`sessionId` or `sessionId:agentId`)
 * @param {Array<string>} params.scopes - File paths or globs (including dotfiles)
 * @param {number} [params.ttlMs=900000]
 * @param {object} [options={}]
 */
export function acquireScopeLock(params = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const cwd = options.cwd || globalThis.process?.cwd?.() || '';
  const ownerId = String(params.ownerId || 'default').trim();
  const requestedScopes = Array.isArray(params.scopes)
    ? params.scopes.map((s) => normalizeScopePath(s, cwd)).filter(Boolean)
    : [];
  const ttlMs = Number(params.ttlMs ?? DEFAULT_SCOPE_LOCK_TTL_MS);

  const state = readActiveScopeLocks({ ...options, nowMs });

  // Check if any requested scope collides with another owner's active lock
  for (const existing of state.locks) {
    if (existing.ownerId === ownerId) continue;
    for (const existingScope of existing.scopes || []) {
      for (const reqScope of requestedScopes) {
        if (
          matchesScopePattern(reqScope, existingScope, cwd) ||
          matchesScopePattern(existingScope, reqScope, cwd)
        ) {
          return {
            acquired: false,
            conflict: {
              ownerId: existing.ownerId,
              conflictingScope: existingScope,
              requestedScope: reqScope,
              expiresAt: existing.expiresAt
            }
          };
        }
      }
    }
  }

  const existingOtherLocks = state.locks.filter(
    (l) => l.ownerId !== ownerId && l.source !== 'cross_harness'
  );
  const lockRecord = buildCrossCompatibleLockRecord(
    {
      ownerId,
      scopes: requestedScopes,
      acquiredAt: nowMs,
      expiresAt: nowMs + ttlMs
    },
    ttlMs
  );
  const serializedLocks = [
    ...existingOtherLocks.map((l) => buildCrossCompatibleLockRecord(l, ttlMs)),
    lockRecord
  ];

  const filePath = getScopeLocksPath(options);
  writeJsonAtomic(
    filePath,
    {
      version: 1,
      schemaVersion: '2026.11.1',
      updatedAt: nowMs,
      locks: serializedLocks,
      leases: serializedLocks
    },
    options
  );

  return {
    acquired: true,
    lock: lockRecord,
    conflict: null
  };
}

/**
 * Releases all scope locks held by `ownerId`.
 * @param {string} ownerId
 * @param {object} [options={}]
 */
export function releaseScopeLock(ownerId, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const state = readActiveScopeLocks({ ...options, nowMs });
  const nextLocks = state.locks
    .filter((l) => l.ownerId !== ownerId && l.source !== 'cross_harness')
    .map((l) => buildCrossCompatibleLockRecord(l));
  const filePath = getScopeLocksPath(options);
  writeJsonAtomic(
    filePath,
    {
      version: 1,
      schemaVersion: '2026.11.1',
      updatedAt: nowMs,
      locks: nextLocks,
      leases: nextLocks
    },
    options
  );
  return { released: true, remainingLocks: nextLocks.length };
}

/**
 * Checks whether editing/writing `targetFilePath` by `ownerId` conflicts with an active scope lock,
 * or whether a 5-hour / spend-limit quota hard brake is active (`DET-20`).
 *
 * @param {object} params
 * @param {string} [params.targetFilePath='']
 * @param {string} [params.ownerId='default']
 * @param {object} [params.rateLimits={}]
 * @param {object} [options={}]
 */
export function evaluateScopeAndQuotaBrake(params = {}, options = {}) {
  const nowMs = options.nowMs ?? params.nowMs ?? Date.now();
  const cwd = options.cwd || globalThis.process?.cwd?.() || '';
  const ownerId = String(
    params.ownerId ||
      params.agentId ||
      params.agent_id ||
      params.sessionId ||
      params.session_id ||
      'default'
  ).trim();
  const targetFilePath = normalizeScopePath(
    params.targetFilePath || params.filePath || params.file_path || params.path || '',
    cwd
  );
  const rateLimits = params.rateLimits || {};

  // 1. Check 5-Hour / Spend-Limit Quota Hard Brake
  const fiveHour = rateLimits.fiveHour || rateLimits.five_hour || null;
  const spendLimit = rateLimits.spendLimit || rateLimits.spend_limit || null;

  if (fiveHour) {
    const remPct =
      typeof fiveHour.remaining_pct === 'number'
        ? fiveHour.remaining_pct
        : typeof fiveHour.limit === 'number' && fiveHour.limit > 0
          ? ((fiveHour.limit - Number(fiveHour.used || 0)) / fiveHour.limit) * 100
          : 100;
    if (remPct <= 0) {
      return {
        detectorId: 'DET-20',
        triggered: true,
        decision: 'deny',
        subType: 'QUOTA_FIVE_HOUR_EXHAUSTED',
        reason: `[DET-20 Quota Hard Brake] 5-hour rate limit window is exhausted (0% remaining). Halting tool execution to prevent failed turn loops.`
      };
    }
  }

  if (spendLimit) {
    const remUsd =
      typeof spendLimit.remaining_usd === 'number'
        ? spendLimit.remaining_usd
        : typeof spendLimit.limit_usd === 'number'
          ? spendLimit.limit_usd - Number(spendLimit.spent_usd || 0)
          : Infinity;
    if (remUsd <= 0) {
      return {
        detectorId: 'DET-20',
        triggered: true,
        decision: 'deny',
        subType: 'QUOTA_SPEND_LIMIT_EXHAUSTED',
        reason: `[DET-20 Quota Hard Brake] Session USD spend limit reached ($0.00 remaining). Halting tool execution.`
      };
    }
  }

  // 2. Check Concurrent Multi-Agent Scope Lockfile
  if (targetFilePath) {
    const isRead = Boolean(params.isRead || /^(read|read_file|view_file)$/i.test(String(params.toolName || '')));
    const state = readActiveScopeLocks({ ...options, nowMs });
    for (const lock of state.locks) {
      if (lock.ownerId === ownerId) continue;
      for (const scopePattern of lock.scopes || []) {
        if (matchesScopePattern(targetFilePath, scopePattern, cwd)) {
          if (isRead) {
            return {
              detectorId: 'DET-20',
              triggered: true,
              decision: 'allow',
              advisory: true,
              subType: 'SUBAGENT_DUPLICATE_READ_DIGEST',
              conflictingOwner: lock.ownerId,
              conflictingScope: scopePattern,
              targetFilePath,
              additionalContext: `[DET-20 Subagent Duplicate Read] File "${targetFilePath}" was already read/claimed by active subagent "${lock.ownerId}". Request parent StateBaton file digest instead of reading full cold file.`,
              reason: `[DET-20 Subagent Duplicate Read] File "${targetFilePath}" was already read/claimed by active subagent "${lock.ownerId}". Request parent StateBaton file digest instead of reading full cold file.`
            };
          }
          return {
            detectorId: 'DET-20',
            triggered: true,
            decision: 'deny',
            subType: 'SCOPE_LOCK_CONFLICT',
            conflictingOwner: lock.ownerId,
            conflictingScope: scopePattern,
            targetFilePath,
            reason:
              `[DET-20 Concurrent Scope Lock] File "${targetFilePath}" is locked by active agent "${lock.ownerId}" ` +
              `(scope "${scopePattern}"). Coordinate via StateBaton or wait for lock release.`
          };
        }
      }
    }
  }

  return {
    detectorId: 'DET-20',
    triggered: false,
    decision: 'allow',
    subType: null,
    reason: null
  };
}

export default {
  DEFAULT_SCOPE_LOCK_TTL_MS,
  normalizeScopePath,
  globToDotfileRegex,
  matchesScopePattern,
  getScopeLocksPath,
  readActiveScopeLocks,
  acquireScopeLock,
  releaseScopeLock,
  evaluateScopeAndQuotaBrake
};
