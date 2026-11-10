import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from '../paths.mjs';

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
  DEFAULT_TTL_SECONDS: 300,
  LOCK_FILE_NAME: 'active_scopes.json',
  DETECTOR_ID: 'DET-20',
  VERSION: 1
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
 * Returns the path to `.agents/locks/active_scopes.json`.
 */
export function getLockFilePath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.agents', 'locks', SCOPE_LOCK_CONSTANTS.LOCK_FILE_NAME);
}

/**
 * Normalizes relative file paths for cross-platform comparison.
 */
export function normalizeClaimedPath(filePath = '') {
  return String(filePath || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

/**
 * Loads the active scope registry, automatically pruning expired or dead-PID leases.
 */
export function loadRegistry(workspaceDir = process.cwd()) {
  const lockFile = getLockFilePath(workspaceDir);
  if (!fs.existsSync(lockFile)) {
    return { version: SCOPE_LOCK_CONSTANTS.VERSION, leases: [] };
  }

  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    const validLeases = [];

    for (const lease of Array.isArray(data.leases) ? data.leases : []) {
      const isExpired = typeof lease.expiresAtMs === 'number' && now > lease.expiresAtMs;
      const pidAlive = typeof lease.pid === 'number' ? isPidAlive(lease.pid) : true;

      if (!isExpired && pidAlive) {
        validLeases.push(lease);
      }
    }

    return {
      version: data.version || SCOPE_LOCK_CONSTANTS.VERSION,
      leases: validLeases
    };
  } catch {
    return { version: SCOPE_LOCK_CONSTANTS.VERSION, leases: [] };
  }
}

/**
 * Saves the registry atomically and Windows-safely using a temp file rename.
 */
export function saveRegistry(workspaceDir = process.cwd(), registry = { version: 1, leases: [] }) {
  const lockFile = getLockFilePath(workspaceDir);
  const locksDir = path.dirname(lockFile);
  fs.mkdirSync(locksDir, { recursive: true });

  const tempFile = path.join(
    locksDir,
    `${SCOPE_LOCK_CONSTANTS.LOCK_FILE_NAME}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`
  );

  const payload = JSON.stringify(registry, null, 2);
  fs.writeFileSync(tempFile, payload, 'utf8');

  // Atomic rename with Windows retry fallback
  try {
    fs.renameSync(tempFile, lockFile);
  } catch {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
      fs.renameSync(tempFile, lockFile);
    } catch {
      // Fallback direct write
      fs.writeFileSync(lockFile, payload, 'utf8');
      try {
        fs.unlinkSync(tempFile);
      } catch {}
    }
  }

  return true;
}

/**
 * Checks for file-scope collisions across other active leases.
 */
export function detectScopeCollision(currentTrajectoryId, claimedPaths = [], activeLeases = []) {
  const normalizedCurrent = new Set(claimedPaths.map(normalizeClaimedPath).filter(Boolean));
  if (normalizedCurrent.size === 0) return null;

  for (const lease of activeLeases) {
    if (lease.trajectoryId === currentTrajectoryId) continue;
    const leasePaths = (lease.claimedPaths || []).map(normalizeClaimedPath);
    const overlapping = leasePaths.filter((p) => normalizedCurrent.has(p));

    if (overlapping.length > 0) {
      return {
        trajectoryId: lease.trajectoryId,
        pid: lease.pid,
        tool: lease.tool || 'antigravity',
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
      } catch {}
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

    // Upsert current lease
    const updatedLeases = registry.leases.filter((l) => l.trajectoryId !== trajectoryId);
    const newLease = {
      trajectoryId,
      pid: this.pid,
      tool: this.tool,
      claimedPaths: normClaimed,
      updatedAtIso: new Date(now).toISOString(),
      expiresAtMs
    };
    updatedLeases.push(newLease);

    saveRegistry(this.workspaceDir, {
      version: SCOPE_LOCK_CONSTANTS.VERSION,
      leases: updatedLeases
    });

    return {
      ok: true,
      collisionDetected: false,
      lease: newLease,
      activeLeaseCount: updatedLeases.length
    };
  }

  /**
   * Releases a trajectory lease.
   */
  releaseLease(trajectoryId) {
    const registry = loadRegistry(this.workspaceDir);
    const updatedLeases = registry.leases.filter((l) => l.trajectoryId !== trajectoryId);
    saveRegistry(this.workspaceDir, {
      version: SCOPE_LOCK_CONSTANTS.VERSION,
      leases: updatedLeases
    });
    return { ok: true, remainingCount: updatedLeases.length };
  }

  /**
   * Returns all active non-expired leases for the workspace.
   */
  getActiveLeases() {
    return loadRegistry(this.workspaceDir).leases;
  }
}

export default ScopeLockRegistry;
