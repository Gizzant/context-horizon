import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from '../paths.mjs';
import { atomicWriteFileSync } from '../atomic_io.mjs';
import { recordHookDiagnostic } from '../hook_diagnostics.mjs';

/**
 * Phase 4 / Ring 1 Hardening: Advisory Workspace Scope Registry & DET-20 Collision Alert
 * (`src/core/telemetry/scope_lock_registry.mjs`)
 *
 * Maintains `.agents/locks/active_scopes.json` mapping active session/trajectory IDs
 * to claimed relative file paths (derived from active `task.md` targets and dirty `git status` paths).
 *
 * Invariants:
 *  - Atomic Windows-safe writes via temp file rename with EPERM fallback.
 *  - Automatic eviction of stale leases where `Date.now() > expiresAtMs` (300s TTL)
 *    or where the owning `pid` is no longer alive (`!isPidAlive(pid)`).
 *  - DET-20 Collision Alert: Triggers when the current trajectory attempts to claim or edit
 *    a file held by another live trajectory ID, warning of 2x merge conflict risk and
 *    providing a 1-click `git worktree` command snippet.
 */

export const SCOPE_LOCK_CONSTANTS = Object.freeze({
  DEFAULT_TTL_SECONDS: 900,
  DEFAULT_TTL_MS: 900_000,
  LOCK_FILE_NAME: 'active_scopes.json',
  DETECTOR_ID: 'DET-20',
  VERSION: 1,
  SCHEMA_VERSION: '2026.11.1'
});

/**
 * Determines whether a process with the given PID is currently alive on the host.
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Returns the path to `.agents/locks/active_scopes.json` (Antigravity's owned lockfile).
 */
export function getLockFilePath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.agents', 'locks', SCOPE_LOCK_CONSTANTS.LOCK_FILE_NAME);
}

/**
 * Returns the path to `.claude/locks/active_scopes.json` (Claude Code cross-harness lockfile, read-only).
 */
export function getClaudeLockFilePath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.claude', 'locks', SCOPE_LOCK_CONSTANTS.LOCK_FILE_NAME);
}

/**
 * Normalizes relative file paths or scope globs for cross-platform comparison.
 */
export function normalizeClaimedPath(filePath = '') {
  return String(filePath || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function compileScopeGlob(pattern) {
  const norm = normalizeClaimedPath(pattern);
  if (!norm) return null;
  if (norm.endsWith('/') && !norm.includes('*') && !norm.includes('?')) {
    const base = norm.slice(0, -1);
    const escapedBase = base.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedBase}(?:/.*)?$`, 'i');
  }
  let regexSrc = '^';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          regexSrc += '(?:.+/)?';
          i += 2;
        } else {
          regexSrc += '.*';
          i += 1;
        }
      } else {
        regexSrc += '[^/]*';
      }
    } else if (ch === '?') {
      regexSrc += '[^/]';
    } else {
      regexSrc += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexSrc += '$';
  return new RegExp(regexSrc, 'i');
}

/**
 * Returns true if two normalized paths or glob patterns overlap (exact match, directory prefix, or glob).
 */
export function scopesOverlap(scopeA, scopeB) {
  const a = normalizeClaimedPath(scopeA);
  const b = normalizeClaimedPath(scopeB);
  if (!a || !b) return false;
  if (a === b) return true;

  const aHasGlob = a.includes('*') || a.includes('?') || a.endsWith('/');
  const bHasGlob = b.includes('*') || b.includes('?') || b.endsWith('/');
  if (!aHasGlob && !bHasGlob) return false;

  if (aHasGlob) {
    const reA = compileScopeGlob(a);
    if (reA && reA.test(b)) return true;
  }
  if (bHasGlob) {
    const reB = compileScopeGlob(b);
    if (reB && reB.test(a)) return true;
  }
  if (aHasGlob && bHasGlob) {
    const prefixA = a.split(/[*?]/)[0].replace(/\/+$/, '');
    const prefixB = b.split(/[*?]/)[0].replace(/\/+$/, '');
    if (!prefixA || !prefixB) return true;
    if (prefixA === prefixB || prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes either an Antigravity `leases[]` item or a Claude Code `locks[]` item
 * into a unified cross-edition lease record.
 */
export function normalizeScopeLeaseEntry(rawEntry = {}, {
  source = 'local',
  defaultTool = 'antigravity',
  now = Date.now()
} = {}) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const trajectoryId = String(
    rawEntry.trajectoryId ||
    rawEntry.ownerId ||
    rawEntry.agent_id ||
    rawEntry.session_id ||
    ''
  ).trim();
  if (!trajectoryId) return null;

  const rawPaths = Array.isArray(rawEntry.claimedPaths)
    ? rawEntry.claimedPaths
    : (Array.isArray(rawEntry.scopes)
      ? rawEntry.scopes
      : (Array.isArray(rawEntry.files_locked) ? rawEntry.files_locked : []));
  const claimedPaths = Array.from(
    new Set(rawPaths.map((p) => String(p || '').trim()).filter(Boolean))
  );

  const parsedAcquired = typeof rawEntry.acquiredAt === 'number' && Number.isFinite(rawEntry.acquiredAt)
    ? rawEntry.acquiredAt
    : Date.parse(rawEntry.acquired_at || rawEntry.updatedAtIso || '');
  const acquiredAtMs = Number.isFinite(parsedAcquired) ? parsedAcquired : now;

  let expiresAtMs = null;
  if (typeof rawEntry.expiresAtMs === 'number' && Number.isFinite(rawEntry.expiresAtMs)) {
    expiresAtMs = rawEntry.expiresAtMs;
  } else if (typeof rawEntry.expiresAt === 'number' && Number.isFinite(rawEntry.expiresAt)) {
    expiresAtMs = rawEntry.expiresAt;
  } else if (typeof rawEntry.expiresAt === 'string' && rawEntry.expiresAt.trim()) {
    const parsedExp = Date.parse(rawEntry.expiresAt);
    if (Number.isFinite(parsedExp)) expiresAtMs = parsedExp;
  } else if (typeof rawEntry.expires_at === 'string' && rawEntry.expires_at.trim()) {
    const parsedExp = Date.parse(rawEntry.expires_at);
    if (Number.isFinite(parsedExp)) expiresAtMs = parsedExp;
  }
  if (!Number.isFinite(expiresAtMs)) {
    const ttlMs = Number(rawEntry.ttl_ms) > 0
      ? Number(rawEntry.ttl_ms)
      : SCOPE_LOCK_CONSTANTS.DEFAULT_TTL_MS;
    expiresAtMs = acquiredAtMs + ttlMs;
  }

  const ttlMs = Number(rawEntry.ttl_ms) > 0
    ? Number(rawEntry.ttl_ms)
    : Math.max(1000, expiresAtMs - acquiredAtMs);
  const pid = typeof rawEntry.pid === 'number' && Number.isFinite(rawEntry.pid) ? rawEntry.pid : undefined;
  const tool = String(rawEntry.tool || (source === 'cross_harness' ? 'claude-code' : defaultTool));

  return {
    trajectoryId,
    ownerId: rawEntry.ownerId || trajectoryId,
    agent_id: rawEntry.agent_id || trajectoryId,
    session_id: rawEntry.session_id || trajectoryId,
    ...(pid !== undefined ? { pid } : {}),
    tool,
    claimedPaths,
    files_locked: claimedPaths,
    scopes: claimedPaths,
    acquiredAt: acquiredAtMs,
    acquired_at: new Date(acquiredAtMs).toISOString(),
    updatedAtIso: rawEntry.updatedAtIso || new Date(acquiredAtMs).toISOString(),
    expiresAt: expiresAtMs,
    expiresAtMs,
    expires_at: new Date(expiresAtMs).toISOString(),
    ttl_ms: ttlMs,
    source
  };
}

function readLockFileEntriesSafe(lockFilePath, { source, defaultTool, now }) {
  if (!lockFilePath || !fs.existsSync(lockFilePath)) return [];
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8');
    const data = JSON.parse(raw);
    const combinedRaw = [
      ...(Array.isArray(data?.leases) ? data.leases : []),
      ...(Array.isArray(data?.locks) ? data.locks : [])
    ];
    const dedupedByOwner = new Map();
    for (const item of combinedRaw) {
      const normalized = normalizeScopeLeaseEntry(item, { source, defaultTool, now });
      if (!normalized) continue;
      const isExpired = typeof normalized.expiresAtMs === 'number' && now > normalized.expiresAtMs;
      const pidAlive = typeof normalized.pid === 'number' ? isPidAlive(normalized.pid) : true;
      if (!isExpired && pidAlive) {
        dedupedByOwner.set(normalized.trajectoryId, normalized);
      }
    }
    return Array.from(dedupedByOwner.values());
  } catch (err) {
    recordHookDiagnostic('scope_lock_registry', 'readLockFileEntriesSafe', err, {
      ignoreCodes: ['ENOENT'],
      persist: false
    });
    return [];
  }
}

/**
 * Loads the active scope registry from BOTH `.agents/locks/active_scopes.json` (local)
 * and `.claude/locks/active_scopes.json` (read-only cross-harness visibility),
 * automatically pruning expired or dead-PID leases.
 */
export function loadRegistry(workspaceDir = process.cwd(), options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const includeCrossHarness = options.includeCrossHarness !== false;

  const localEntries = readLockFileEntriesSafe(getLockFilePath(workspaceDir), {
    source: 'local',
    defaultTool: 'antigravity',
    now
  });
  const crossEntries = includeCrossHarness
    ? readLockFileEntriesSafe(getClaudeLockFilePath(workspaceDir), {
        source: 'cross_harness',
        defaultTool: 'claude-code',
        now
      })
    : [];

  const mergedByKey = new Map();
  for (const entry of localEntries) {
    mergedByKey.set(`local::${entry.trajectoryId}`, entry);
  }
  for (const entry of crossEntries) {
    if (!localEntries.some((l) => l.trajectoryId === entry.trajectoryId)) {
      mergedByKey.set(`cross::${entry.trajectoryId}`, entry);
    }
  }

  const validLeases = Array.from(mergedByKey.values());
  const locks = validLeases.map((l) => ({
    ownerId: l.ownerId || l.trajectoryId,
    ...(l.pid !== undefined ? { pid: l.pid } : {}),
    tool: l.tool,
    scopes: l.scopes || l.claimedPaths,
    acquiredAt: l.acquiredAt,
    expiresAt: l.expiresAtMs,
    source: l.source
  }));

  return {
    version: SCOPE_LOCK_CONSTANTS.VERSION,
    schemaVersion: SCOPE_LOCK_CONSTANTS.SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    leases: validLeases,
    locks
  };
}

export const loadScopeLockRegistry = loadRegistry;

/**
 * Saves Antigravity's local registry atomically to `.agents/locks/active_scopes.json`
 * (emitting both `leases[]` and `locks[]` for cross-edition interoperability while never
 * modifying `.claude/locks/active_scopes.json`).
 */
export function saveRegistry(workspaceDir = process.cwd(), registry = { version: 1, leases: [] }) {
  const now = Date.now();
  const lockFile = getLockFilePath(workspaceDir);
  const rawItems = Array.isArray(registry?.leases)
    ? registry.leases
    : (Array.isArray(registry?.locks) ? registry.locks : []);

  const localLeases = [];
  const seenOwners = new Set();
  for (const item of rawItems) {
    if (item?.source === 'cross_harness') continue;
    const norm = normalizeScopeLeaseEntry(item, { source: 'local', defaultTool: 'antigravity', now });
    if (!norm || seenOwners.has(norm.trajectoryId)) continue;
    seenOwners.add(norm.trajectoryId);
    localLeases.push(norm);
  }

  const locks = localLeases.map((l) => ({
    ownerId: l.ownerId || l.trajectoryId,
    ...(l.pid !== undefined ? { pid: l.pid } : {}),
    tool: l.tool,
    scopes: l.claimedPaths,
    acquiredAt: l.acquiredAt,
    expiresAt: l.expiresAtMs
  }));

  const payload = JSON.stringify({
    version: registry?.version || SCOPE_LOCK_CONSTANTS.VERSION,
    schemaVersion: SCOPE_LOCK_CONSTANTS.SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    leases: localLeases,
    locks
  }, null, 2);
  atomicWriteFileSync(lockFile, payload, { encoding: 'utf8' });
  return true;
}

/**
 * Checks for file-scope collisions (exact path, directory prefix, or glob) across other active leases/locks.
 */
export function detectScopeCollision(currentTrajectoryId, claimedPaths = [], activeLeases = [], options = {}) {
  const normalizedCurrent = Array.from(
    new Set((Array.isArray(claimedPaths) ? claimedPaths : []).map(normalizeClaimedPath).filter(Boolean))
  );
  if (normalizedCurrent.length === 0) return null;

  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();

  for (const lease of Array.isArray(activeLeases) ? activeLeases : []) {
    if (!lease || typeof lease !== 'object') continue;
    const ownerId = lease.trajectoryId || lease.ownerId || lease.agent_id || lease.session_id;
    if (!ownerId || ownerId === currentTrajectoryId) continue;

    let expMs = null;
    if (typeof lease.expiresAtMs === 'number' && Number.isFinite(lease.expiresAtMs)) {
      expMs = lease.expiresAtMs;
    } else if (typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt)) {
      expMs = lease.expiresAt;
    } else if (typeof lease.expiresAt === 'string' && lease.expiresAt.trim()) {
      const parsed = Date.parse(lease.expiresAt);
      if (Number.isFinite(parsed)) expMs = parsed;
    } else if (typeof lease.expires_at === 'string' && lease.expires_at.trim()) {
      const parsed = Date.parse(lease.expires_at);
      if (Number.isFinite(parsed)) expMs = parsed;
    }
    if (Number.isFinite(expMs) && now > expMs) continue;

    const rawLeasePaths = lease.claimedPaths || lease.scopes || lease.files_locked || [];
    const leasePaths = rawLeasePaths.map(normalizeClaimedPath).filter(Boolean);
    const overlapping = normalizedCurrent.filter((cp) =>
      leasePaths.some((lp) => scopesOverlap(cp, lp))
    );

    if (overlapping.length > 0) {
      return {
        trajectoryId: ownerId,
        ownerId,
        pid: lease.pid,
        tool: lease.tool || 'antigravity',
        source: lease.source || 'local',
        overlappingPaths: overlapping
      };
    }
  }

  return null;
}

/**
 * Derives file paths touched or claimed in the current session from task.md and git status.
 */
export function deriveSessionClaimedPaths({
  workspaceDir = process.cwd(),
  taskMdContent = null,
  gitStatusOutput = null
} = {}) {
  const paths = new Set();

  // 1. From task.md
  let resolvedTask = taskMdContent;
  if (resolvedTask === null) {
    const taskPath = path.join(workspaceDir, 'task.md');
    if (fs.existsSync(taskPath)) {
      try {
        resolvedTask = fs.readFileSync(taskPath, 'utf8');
      } catch (err) {
        recordHookDiagnostic('scope_lock_registry', 'deriveSessionClaimedPaths_readTaskMd', err, {
          ignoreCodes: ['ENOENT'],
          persist: false
        });
      }
    }
  }

  if (resolvedTask) {
    const taskLines = String(resolvedTask).split(/\r?\n/);
    const hasChecklistItems = taskLines.some((l) => /^\s*[-*+]\s*\[[ xX\/]\]/.test(l));
    const validFilePathRe = /([\\/]|^\.[a-zA-Z0-9_-]+|\.(mjs|cjs|js|ts|tsx|jsx|json|jsonl|md|html|css|scss|py|go|rs|java|rb|sh|ps1|yml|yaml|toml|sql|sqlite|db|proto|xml|txt|env|lock|gitignore|eslintrc|prettierrc)$)/i;
    const versionOrMetricRe = /^v?\d+(\.\d+)+[a-zA-Z0-9_-]*$/i;

    for (const line of taskLines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      // Ignore completed checklist items (- [x] or - [X])
      if (/^[-*+]\s*\[[xX]\]/.test(trimmedLine)) continue;
      // When task.md uses checklist items, only claim paths from active/pending items (- [ ] or - [/])
      if (hasChecklistItems && !/^[-*+]\s*\[[ \/]\]/.test(trimmedLine)) continue;

      const matches = trimmedLine.match(/`([^`]+)`/g) || [];
      for (const m of matches) {
        const clean = m
          .replace(/`/g, '')
          .trim()
          .replace(/:\d+(?:-\d+)?$/, '');
        if (!clean || clean.includes(' ')) continue;
        if (/^(https?:|file:|node:)/i.test(clean)) continue;
        if (versionOrMetricRe.test(clean)) continue;
        if (validFilePathRe.test(clean)) {
          paths.add(clean.replace(/\\/g, '/'));
        }
      }
    }
  }

  // 2. From git status output
  if (gitStatusOutput) {
    const lines = String(gitStatusOutput).split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Porcelain format: " M path", "?? path", or "R  old -> new"
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        let filePath = parts.slice(1).join(' ').trim();
        if (filePath.includes(' -> ')) {
          filePath = filePath.split(' -> ').pop().trim();
        }
        const norm = filePath.replace(/\\/g, '/');
        if (
          norm &&
          norm !== '.' &&
          norm !== '..' &&
          !/^\.agents\/(scope-locks\.json|cache(\/|$))/i.test(norm)
        ) {
          paths.add(norm);
        }
      }
    }
  }

  return Array.from(paths).sort();
}

/**
 * ScopeLockRegistry class providing lease acquisition, renewal, release, and DET-20 collision alerts.
 */
export class ScopeLockRegistry {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.pid = options.pid || process.pid;
    this.tool = options.tool || 'antigravity';
  }

  /**
   * Acquires or renews a scope lease for a trajectory.
   * If an active lease owned by another trajectory claims any of the same paths, triggers DET-20.
   */
  acquireOrRenewLease({
    trajectoryId = 'default-trajectory',
    claimedPaths = [],
    ttlSeconds = SCOPE_LOCK_CONSTANTS.DEFAULT_TTL_SECONDS
  } = {}) {
    const registry = loadRegistry(this.workspaceDir);
    const normClaimed = Array.isArray(claimedPaths) ? claimedPaths.filter(Boolean) : [];

    // Check for collision with another live trajectory
    const collision = detectScopeCollision(trajectoryId, normClaimed, registry.leases);
    if (collision) {
      const worktreeBranch = `feature-parallel-${String(trajectoryId).slice(0, 8)}`;
      const worktreeCmd = `git worktree add ../${path.basename(this.workspaceDir)}-worktree-${String(trajectoryId).slice(0, 8)} -b ${worktreeBranch}`;

      return {
        ok: false,
        collisionDetected: true,
        detectorId: SCOPE_LOCK_CONSTANTS.DETECTOR_ID,
        conflictingTrajectoryId: collision.trajectoryId,
        conflictingPid: collision.pid,
        conflictingTool: collision.tool,
        overlappingPaths: collision.overlappingPaths,
        worktreeCommand: worktreeCmd,
        warning: `[HORIZON DET-20] Concurrent file-scope collision: file(s) [${collision.overlappingPaths.join(', ')}] are currently leased by trajectory "${collision.trajectoryId}" (PID ${collision.pid}). Run in isolated worktree to prevent merge conflicts.`,
        activeLeases: registry.leases
      };
    }

    const now = Date.now();
    const expiresAtMs = now + ttlSeconds * 1000;

    // Upsert current local lease (preserving read-only visibility of cross-harness locks without copying them)
    const crossHarnessCount = registry.leases.filter((l) => l.source === 'cross_harness').length;
    const updatedLocalLeases = registry.leases.filter(
      (l) => l.source !== 'cross_harness' && l.trajectoryId !== trajectoryId
    );
    const newLease = normalizeScopeLeaseEntry({
      trajectoryId,
      ownerId: trajectoryId,
      agent_id: trajectoryId,
      session_id: trajectoryId,
      pid: this.pid,
      tool: this.tool,
      claimedPaths: normClaimed,
      acquiredAt: now,
      updatedAtIso: new Date(now).toISOString(),
      expiresAtMs,
      ttl_ms: ttlSeconds * 1000
    }, { source: 'local', defaultTool: this.tool, now });
    updatedLocalLeases.push(newLease);

    saveRegistry(this.workspaceDir, {
      version: SCOPE_LOCK_CONSTANTS.VERSION,
      leases: updatedLocalLeases
    });

    return {
      ok: true,
      collisionDetected: false,
      lease: newLease,
      activeLeaseCount: updatedLocalLeases.length + crossHarnessCount
    };
  }

  /**
   * Releases a trajectory lease.
   */
  releaseLease(trajectoryId) {
    const registry = loadRegistry(this.workspaceDir);
    const crossHarnessCount = registry.leases.filter((l) => l.source === 'cross_harness').length;
    const updatedLocalLeases = registry.leases.filter(
      (l) => l.source !== 'cross_harness' && l.trajectoryId !== trajectoryId
    );
    saveRegistry(this.workspaceDir, {
      version: SCOPE_LOCK_CONSTANTS.VERSION,
      leases: updatedLocalLeases
    });
    return { ok: true, remainingCount: updatedLocalLeases.length + crossHarnessCount };
  }

  /**
   * Returns all active non-expired leases for the workspace.
   */
  getActiveLeases() {
    return loadRegistry(this.workspaceDir).leases;
  }
}

export default ScopeLockRegistry;
