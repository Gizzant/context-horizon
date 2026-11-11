import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cachedDatabaseSync = null;
function resolveDatabaseSync(overrideCtor = null) {
  if (overrideCtor) return overrideCtor;
  if (cachedDatabaseSync) return cachedDatabaseSync;
  const mod = require('node:sqlite');
  if (!mod || !mod.DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is unavailable in this Node.js runtime');
  }
  cachedDatabaseSync = mod.DatabaseSync;
  return cachedDatabaseSync;
}

/**
 * Returns true when `dbPath` points to a host-owned Antigravity or Cursor SQLite database
 * (`conversations/*.db`, `conversation_summaries.db`, or `state.vscdb`), which MUST NEVER
 * be opened in read-write mode (`AGENTS.md` Invariant 4).
 */
export function isHostProtectedSqlitePath(dbPath = '') {
  const norm = String(dbPath || '').replace(/\\/g, '/').toLowerCase().trim();
  if (!norm) return false;
  const base = path.posix.basename(norm);
  if (base === 'state.vscdb' || base.startsWith('state.vscdb.')) return true;
  if (base === 'conversation_summaries.db' || base.startsWith('conversation_summaries.db.')) return true;
  if (norm.includes('/conversations/') && (base.endsWith('.db') || base.includes('.db.'))) return true;
  return false;
}

/**
 * Opens a plugin-owned Horizon SQLite database with strict WAL + `busy_timeout = 5000`
 * (or `{ readOnly: true }` for read-only queries).
 */
export function openLocalHorizonDb(dbPath, { readOnly = false, DatabaseSync = null } = {}) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new TypeError('openLocalHorizonDb requires a non-empty dbPath string');
  }
  const resolvedPath = path.resolve(dbPath);
  const DbCtor = resolveDatabaseSync(DatabaseSync);

  if (readOnly === true) {
    const db = new DbCtor(resolvedPath, { readOnly: true });
    try {
      if (typeof db.exec === 'function') {
        db.exec('PRAGMA busy_timeout = 5000;');
      }
    } catch {
      // Read-only handles on locked/immutable files may reject pragma mutations; ignore safely.
    }
    return db;
  }

  if (isHostProtectedSqlitePath(resolvedPath)) {
    throw new Error(
      `[Zero-Trust SQLite Guard] Refusing read-write open on protected host database: ${resolvedPath}`
    );
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new DbCtor(resolvedPath);
  try {
    if (typeof db.exec === 'function') {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
      `);
    }
    return db;
  } catch (err) {
    try {
      if (typeof db.close === 'function') db.close();
    } catch {}
    throw err;
  }
}

/**
 * Strictly opens host Antigravity / IDE SQLite databases with `{ readOnly: true }`.
 */
export function openHostReadOnlyDb(dbPath, options = {}) {
  return openLocalHorizonDb(dbPath, { ...options, readOnly: true });
}

export default {
  isHostProtectedSqlitePath,
  openLocalHorizonDb,
  openHostReadOnlyDb
};
