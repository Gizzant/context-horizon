/**
 * @file src/engine-node/db/sqlite_wrapper.mjs
 * Read-only wrapper around node:sqlite DatabaseSync.
 *
 * Strictly enforces { readOnly: true } invariant and rejects any mutating SQL.
 */

import path from 'node:path';
import { getDatabaseSyncClass } from './probe.mjs';

const MUTATION_SQL_RE = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX)\b/i;

export class SqliteDatabaseSyncWrapper {
  /**
   * @param {string} dbPath
   * @param {object} options
   * @param {boolean} options.readOnly - Must strictly be true
   * @param {Function} [options.DatabaseSync] - Optional constructor override
   */
  constructor(dbPath, options = {}) {
    if (!options || options.readOnly !== true) {
      throw new Error('[Zero-Trust SQLite Guard] SqliteDatabaseSyncWrapper strictly requires { readOnly: true }');
    }
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('SqliteDatabaseSyncWrapper requires a non-empty dbPath string');
    }

    this.dbPath = (dbPath === ':memory:' || dbPath.startsWith('file:')) ? dbPath : path.resolve(dbPath);
    this.readOnly = true;
    this.isOpen = true;

    const DbCtor = options.DatabaseSync || getDatabaseSyncClass(options);
    if (!DbCtor) {
      throw new Error('DatabaseSync constructor is unavailable in this runtime');
    }

    this.db = new DbCtor(this.dbPath, { readOnly: true, readonly: true });
    try {
      if (typeof this.db.exec === 'function') {
        this.db.exec('PRAGMA busy_timeout = 3000;');
      }
    } catch {
      // Ignore pragma rejection on immutable/locked handles
    }
  }

  _assertNotMutating(sql) {
    if (!sql || typeof sql !== 'string') return;
    const stripped = sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--.*$/gm, ' ')
      .trim();

    const statements = stripped.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      if (MUTATION_SQL_RE.test(stmt)) {
        throw new Error(`[Zero-Trust SQLite Guard] Mutation query not permitted on read-only database: ${sql}`);
      }
      if (/^\s*WITH\b/i.test(stmt) && /\b(DELETE|INSERT|UPDATE|DROP|ALTER|REPLACE)\b/i.test(stmt)) {
        throw new Error(`[Zero-Trust SQLite Guard] Mutation query not permitted on read-only database: ${sql}`);
      }
    }
  }

  get(sql, params = []) {
    if (!this.isOpen) throw new Error('Database handle is closed');
    this._assertNotMutating(sql);
    const stmt = this.db.prepare(sql);
    if (Array.isArray(params)) return stmt.get(...params);
    if (params !== undefined && params !== null) return stmt.get(params);
    return stmt.get();
  }

  all(sql, params = []) {
    if (!this.isOpen) throw new Error('Database handle is closed');
    this._assertNotMutating(sql);
    const stmt = this.db.prepare(sql);
    if (Array.isArray(params)) return stmt.all(...params);
    if (params !== undefined && params !== null) return stmt.all(params);
    return stmt.all();
  }

  searchFts(query, limit = 10, { table = null } = {}) {
    if (!this.isOpen) throw new Error('Database handle is closed');
    if (!query || typeof query !== 'string') return [];

    let targetTable = table;
    if (!targetTable) {
      try {
        const tables = this.all("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'");
        if (tables.length > 0) targetTable = tables[0].name;
      } catch {
        // Fall back to null
      }
    }

    if (!targetTable) return [];

    try {
      const sanitized = query.replace(/['"*]/g, ' ').trim();
      if (!sanitized) return [];
      const sql = `SELECT *, snippet(${targetTable}, -1, '[', ']', '...', 16) AS snippet, bm25(${targetTable}) AS score ` +
                  `FROM ${targetTable} WHERE ${targetTable} MATCH ? ORDER BY score LIMIT ?`;
      return this.all(sql, [sanitized, limit]);
    } catch {
      return [];
    }
  }

  close() {
    if (this.isOpen) {
      this.isOpen = false;
      try {
        if (typeof this.db.close === 'function') this.db.close();
      } catch {
        // Safe close
      }
    }
  }
}

export default SqliteDatabaseSyncWrapper;
