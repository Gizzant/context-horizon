import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir, getAntigravitySurfaces } from './paths.mjs';
import { SQLITE_OPEN_READONLY_OPTIONS } from './parser.mjs';

/**
 * Phase 0: Non-Blocking SQLite WAL Hygiene & Connection Manager
 *
 * 1. Monitors `.db-wal` size across `~/.gemini/antigravity/conversations/<GUID>.db`
 *    and `conversation_summaries.db` (alerting if `.db-wal` exceeds 30 MB).
 * 2. Preserves Zero-Trust `SQLITE_OPEN_READONLY_OPTIONS` (`{ readOnly: true }`) on host
 *    Antigravity session databases by default.
 * 3. Runs `PRAGMA wal_checkpoint(PASSIVE)` on a 5-second idle interval for Horizon's own
 *    SQLite databases (`tool_logs_fts5.db`, `instincts.db`, `episodic_memory.db`) or
 *    explicitly registered writable databases to prevent `.db-wal` bloat past 30 MB
 *    and B-tree page corruption.
 */

export const WAL_HYGIENE_CONSTANTS = Object.freeze({
  IDLE_CHECKPOINT_INTERVAL_MS: 5000,
  WAL_BLOAT_WARNING_BYTES: 30 * 1024 * 1024 // 30 MB
});

export function isHostAntigravitySessionDb(dbPath = '') {
  const norm = String(dbPath || '').replace(/\\/g, '/').toLowerCase();
  return (
    norm.includes('/conversations/') && norm.endsWith('.db') ||
    norm.endsWith('/conversation_summaries.db')
  );
}

/**
 * Inspects `.db`, `.db-wal`, and `.db-shm` file sizes and read-only SQLite header health.
 */
export async function inspectDatabaseWalHealth(dbPath, options = {}) {
  const resolved = path.resolve(String(dbPath || ''));
  const walPath = `${resolved}-wal`;
  const shmPath = `${resolved}-shm`;
  const maxWalBytes = Number.isFinite(options.maxWalBytes)
    ? options.maxWalBytes
    : WAL_HYGIENE_CONSTANTS.WAL_BLOAT_WARNING_BYTES;

  let dbSizeBytes = 0;
  let walSizeBytes = 0;
  let shmSizeBytes = 0;
  let exists = false;

  try {
    if (fs.existsSync(resolved)) {
      exists = true;
      dbSizeBytes = fs.statSync(resolved).size;
    }
    if (fs.existsSync(walPath)) {
      walSizeBytes = fs.statSync(walPath).size;
    }
    if (fs.existsSync(shmPath)) {
      shmSizeBytes = fs.statSync(shmPath).size;
    }
  } catch {}

  const bloatWarning = walSizeBytes > maxWalBytes;
  let journalMode = null;

  if (exists && options.probeReadOnlyPragma !== false) {
    let db = null;
    try {
      const DbCtor = options.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
      db = new DbCtor(resolved, SQLITE_OPEN_READONLY_OPTIONS);
      const row = db.prepare('PRAGMA journal_mode').get();
      journalMode = row?.journal_mode || null;
    } catch {
      journalMode = null;
    } finally {
      try { if (db) db.close(); } catch {}
    }
  }

  return {
    dbPath: resolved,
    walPath,
    exists,
    dbSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    walSizeMb: Number((walSizeBytes / (1024 * 1024)).toFixed(2)),
    bloatWarning,
    journalMode,
    readOnlyEnforced: true
  };
}

/**
 * Executes `PRAGMA wal_checkpoint(PASSIVE)` on a target SQLite database when idle.
 * By default, host Antigravity DBs (`conversations/*.db`, `conversation_summaries.db`)
 * are skipped in write mode unless `allowHostWriteOverride: true` is explicitly passed
 * in a controlled test environment.
 */
export async function runPassiveWalCheckpoint(dbPath, options = {}) {
  const resolved = path.resolve(String(dbPath || ''));
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      success: false,
      skipped: true,
      reason: 'DB_NOT_FOUND',
      dbPath: resolved
    };
  }

  const isHostDb = isHostAntigravitySessionDb(resolved);
  if (isHostDb && options.allowHostWriteOverride !== true) {
    const health = await inspectDatabaseWalHealth(resolved, options);
    return {
      success: true,
      skipped: true,
      reason: 'HOST_DB_READONLY_GUARD',
      dbPath: resolved,
      walSizeBytes: health.walSizeBytes,
      bloatWarning: health.bloatWarning
    };
  }

  let db = null;
  try {
    const DbCtor = options.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
    db = new DbCtor(resolved);
    const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() || {};
    return {
      success: true,
      skipped: false,
      dbPath: resolved,
      busy: Number(row.busy ?? 0),
      log: Number(row.log ?? 0),
      checkpointed: Number(row.checkpointed ?? 0),
      checkedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      dbPath: resolved,
      error: String(err?.message || err)
    };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

export class WalHygieneManager {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(100, options.intervalMs)
      : WAL_HYGIENE_CONSTANTS.IDLE_CHECKPOINT_INTERVAL_MS;
    this.DatabaseSync = options.DatabaseSync || null;
    this.allowHostWriteOverride = Boolean(options.allowHostWriteOverride);
    this.managedDbPaths = new Set(Array.isArray(options.dbPaths) ? options.dbPaths.map(p => path.resolve(p)) : []);
    this._timer = null;
    this._isBusy = false;
    this.lastRunSummary = null;

    // Register default Horizon-managed SQLite databases
    const horizonDir = path.join(this.homeDir, '.gemini', 'antigravity', 'agy-horizon');
    this.managedDbPaths.add(path.join(horizonDir, 'tool_logs_fts5.db'));
    this.managedDbPaths.add(path.join(horizonDir, 'instincts.db'));
    this.managedDbPaths.add(path.join(this.homeDir, '.gemini', 'flightcheck', 'episodic_memory.db'));
  }

  registerDatabase(dbPath) {
    if (dbPath && typeof dbPath === 'string') {
      this.managedDbPaths.add(path.resolve(dbPath));
    }
  }

  async runIdleSweep() {
    if (this._isBusy) return this.lastRunSummary;
    this._isBusy = true;
    try {
      const results = [];
      for (const dbPath of this.managedDbPaths) {
        if (!fs.existsSync(dbPath)) continue;
        const res = await runPassiveWalCheckpoint(dbPath, {
          DatabaseSync: this.DatabaseSync,
          allowHostWriteOverride: this.allowHostWriteOverride
        });
        results.push(res);
      }

      // Also inspect active Antigravity surface summaries & recent conversation DBs in strictly read-only mode
      const hostAlerts = [];
      for (const surface of getAntigravitySurfaces(this.homeDir)) {
        if (fs.existsSync(surface.summariesDbPath)) {
          const h = await inspectDatabaseWalHealth(surface.summariesDbPath, {
            DatabaseSync: this.DatabaseSync,
            probeReadOnlyPragma: false
          });
          if (h.bloatWarning) hostAlerts.push(h);
        }
      }

      this.lastRunSummary = {
        checkedAt: new Date().toISOString(),
        checkpointCount: results.filter(r => r.success && !r.skipped).length,
        results,
        hostBloatAlerts: hostAlerts
      };
      return this.lastRunSummary;
    } finally {
      this._isBusy = false;
    }
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.runIdleSweep().catch(() => {});
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
    return this;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

export default WalHygieneManager;
