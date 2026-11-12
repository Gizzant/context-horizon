import fs from 'node:fs';
import path from 'node:path';
import { getDatabaseSyncClass } from '../engine-node/db/probe.mjs';

/**
 * Pure-JS JSONL/JSON fallback database adapter for Node 20 LTS runtimes (where built-in
 * `node:sqlite` is absent) or when `CTXTOP_FORCE_NO_SQLITE=1` is set.
 * Supports `.exec()`, `.prepare().run()/.get()/.all()`, and `.close()` for plugin-owned
 * Horizon databases (`tool_logs_fts5.db`, `episodic_memory.db`, `instincts.db`, etc.).
 */
export class JsonlFallbackDatabaseSync {
  constructor(dbPath = ':memory:', options = {}) {
    this.dbPath = dbPath;
    this.readOnly = Boolean(options.readOnly || options.readonly);
    this.isMemory = !dbPath || dbPath === ':memory:' || String(dbPath).startsWith('file:');
    this.tables = {};
    this._load();
  }

  _load() {
    if (this.isMemory || !fs.existsSync(this.dbPath)) return;
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf8').trim();
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.tables === 'object') {
          this.tables = parsed.tables;
        }
      }
    } catch {
      // Binary SQLite file or unreadable file in read-only fallback mode -> empty in-memory view
    }
  }

  _flush() {
    if (this.isMemory || this.readOnly) return;
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      fs.writeFileSync(this.dbPath, JSON.stringify({ fallbackFormat: 'json-v1', tables: this.tables }), 'utf8');
    } catch {}
  }

  exec(sql = '') {
    const createMatches = String(sql || '').matchAll(
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi
    );
    let mutated = false;
    for (const m of createMatches) {
      const tbl = m[1];
      if (tbl && !Array.isArray(this.tables[tbl])) {
        this.tables[tbl] = [];
        mutated = true;
      }
    }
    if (mutated) this._flush();
  }

  prepare(sql = '') {
    const self = this;
    const normSql = String(sql || '').replace(/\s+/g, ' ').trim();

    return {
      run(...args) {
        if (self.readOnly) {
          throw new Error('attempt to write a readonly database');
        }
        const insMatch = normSql.match(
          /^INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+([A-Za-z0-9_]+)\s*(?:\(([^)]+)\))?\s*VALUES\s*\(([^)]+)\)/i
        );
        if (insMatch) {
          const table = insMatch[1];
          const cols = insMatch[2]
            ? insMatch[2].split(',').map((c) => c.trim())
            : ['session_id', 'turn_id', 'command', 'exit_code', 'raw_output', 'created_at'];
          if (!Array.isArray(self.tables[table])) self.tables[table] = [];
          const row = {};
          cols.forEach((c, idx) => {
            row[c] = args[idx] ?? null;
          });
          const pkCol = cols[0];
          if (/OR\s+REPLACE/i.test(normSql) && pkCol) {
            self.tables[table] = self.tables[table].filter((r) => r[pkCol] !== row[pkCol]);
          }
          self.tables[table].push(row);
          self._flush();
          return { changes: 1, lastInsertRowid: self.tables[table].length };
        }

        const delMatch = normSql.match(
          /^DELETE\s+FROM\s+([A-Za-z0-9_]+)(?:\s+WHERE\s+([A-Za-z0-9_]+)\s*=\s*\?)?/i
        );
        if (delMatch) {
          const table = delMatch[1];
          const whereCol = delMatch[2];
          if (Array.isArray(self.tables[table])) {
            const before = self.tables[table].length;
            self.tables[table] = whereCol
              ? self.tables[table].filter((r) => r[whereCol] !== args[0])
              : [];
            self._flush();
            return { changes: before - self.tables[table].length };
          }
          return { changes: 0 };
        }

        self._flush();
        return { changes: 1 };
      },

      get(...args) {
        if (/^PRAGMA\s+journal_mode/i.test(normSql)) {
          return { journal_mode: 'wal' };
        }
        if (/^PRAGMA\s+wal_checkpoint/i.test(normSql)) {
          return { busy: 0, log: 0, checkpointed: 0 };
        }
        const rows = this.all(...args);
        return rows[0] ?? undefined;
      },

      all(...args) {
        if (/^PRAGMA\s+journal_mode/i.test(normSql)) {
          return [{ journal_mode: 'wal' }];
        }
        if (/^PRAGMA\s+wal_checkpoint/i.test(normSql)) {
          return [{ busy: 0, log: 0, checkpointed: 0 }];
        }
        const fromMatch = normSql.match(/\bFROM\s+([A-Za-z0-9_]+)/i);
        if (!fromMatch) return [];
        const table = fromMatch[1];
        const sourceRows = Array.isArray(self.tables[table]) ? [...self.tables[table]] : [];

        let filtered = sourceRows;
        let argIdx = 0;

        if (/\bWHERE\b/i.test(normSql)) {
          const eqMatches = [...normSql.matchAll(/\b([A-Za-z0-9_]+)\s*=\s*\?/g)];
          for (const m of eqMatches) {
            const col = m[1];
            const val = args[argIdx++];
            filtered = filtered.filter((r) => String(r[col] ?? '') === String(val ?? ''));
          }
          if (/\bMATCH\s+\?/i.test(normSql)) {
            const matchVal = String(args[argIdx++] || '');
            const terms = matchVal
              .replace(/\b(OR|AND)\b/gi, ' ')
              .replace(/[^A-Za-z0-9_.\s-]/g, ' ')
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean);
            if (terms.length > 0) {
              filtered = filtered.filter((r) => {
                const hay = Object.values(r).join(' ').toLowerCase();
                return terms.some((t) => hay.includes(t));
              });
            }
          }
        }

        if (/SELECT\s+count\(\*\)\s+as\s+count/i.test(normSql)) {
          const totalBytes = filtered.reduce(
            (sum, r) => sum + Buffer.byteLength(String(r.raw_output || r.rawOutput || ''), 'utf8'),
            0
          );
          return [{ count: filtered.length, totalBytes }];
        }

        if (/\bLIMIT\s+\?/i.test(normSql) && argIdx < args.length) {
          const lim = Math.max(1, Number(args[argIdx++]) || 10);
          filtered = filtered.slice(0, lim);
        }

        return filtered.map((r) => ({
          ...r,
          ...(r.session_id !== undefined && r.sessionId === undefined ? { sessionId: r.session_id } : {}),
          ...(r.workspace_path !== undefined && r.workspacePath === undefined ? { workspacePath: r.workspace_path } : {}),
          ...(r.modified_files !== undefined && r.modifiedFiles === undefined ? { modifiedFiles: r.modified_files } : {}),
          ...(r.turn_id !== undefined && r.turnId === undefined ? { turnId: r.turn_id } : {}),
          ...(r.exit_code !== undefined && r.exitCode === undefined ? { exitCode: r.exit_code } : {}),
          ...(r.raw_output !== undefined && r.rawOutput === undefined ? { rawOutput: r.raw_output } : {}),
          ...(r.created_at !== undefined && r.createdAt === undefined ? { createdAt: r.created_at } : {}),
          rank: r.rank ?? 0.0
        }));
      }
    };
  }

  close() {
    this._flush();
  }
}

export function resolveDatabaseSync(overrideCtor = null) {
  if (overrideCtor) return overrideCtor;
  const Ctor = getDatabaseSyncClass();
  if (Ctor) return Ctor;
  return JsonlFallbackDatabaseSync;
}

/**
 * Returns true when `dbPath` points to a host-owned Antigravity or Cursor SQLite database
 * (`conversations/*.db`, `conversation_summaries.db`, or `state.vscdb`), which MUST NEVER
 * be opened in read-write mode (`AGENTS.md` Invariant 4).
 */
export function isHostProtectedSqlitePath(dbPath = '') {
  let norm = String(dbPath || '').replace(/\\/g, '/').toLowerCase().trim();
  if (!norm) return false;
  norm = norm.replace(/\?.*$/, '');
  norm = norm.replace(/^file:\/{0,3}/, '/');
  const base = path.posix.basename(norm);
  if (base === 'state.vscdb' || base.startsWith('state.vscdb.')) return true;
  if (base === 'conversation_summaries.db' || base.startsWith('conversation_summaries.db.')) return true;
  const isSqliteExt = /\.(db|sqlite|sqlite3|db3)(\.|$)/i.test(base);
  if (norm.includes('/conversations/') && isSqliteExt) return true;
  return false;
}

/**
 * Opens a plugin-owned Horizon SQLite database with strict WAL + `busy_timeout = 3000`
 * (or `{ readOnly: true, readonly: true }` for read-only queries).
 * Falls back cleanly to `JsonlFallbackDatabaseSync` on Node 20 LTS when `node:sqlite` is absent.
 */
export function openLocalHorizonDb(dbPath, { readOnly = false, readonly = false, busyTimeoutMs = 3000, DatabaseSync = null } = {}) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new TypeError('openLocalHorizonDb requires a non-empty dbPath string');
  }
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file:');
  const resolvedPath = isMemory ? dbPath : path.resolve(dbPath);
  const isReadOnly = readOnly === true || readonly === true;

  if (!isReadOnly && isHostProtectedSqlitePath(resolvedPath)) {
    throw new Error(
      `[Zero-Trust SQLite Guard] Refusing read-write open on protected host database: ${resolvedPath}`
    );
  }

  const DbCtor = resolveDatabaseSync(DatabaseSync);
  const timeoutVal = Math.max(100, Number(busyTimeoutMs) || 3000);

  if (isReadOnly) {
    const db = new DbCtor(resolvedPath, { readOnly: true, readonly: true });
    try {
      if (typeof db.exec === 'function') {
        db.exec(`PRAGMA busy_timeout = ${timeoutVal};`);
      }
    } catch {
      // Read-only handles on locked/immutable files may reject pragma mutations; ignore safely.
    }
    return db;
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new DbCtor(resolvedPath);
  try {
    if (typeof db.exec === 'function') {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = ${timeoutVal};
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
 * Strictly opens host Antigravity / IDE SQLite databases with `{ readOnly: true, readonly: true }`.
 */
export function openHostReadOnlyDb(dbPath, options = {}) {
  return openLocalHorizonDb(dbPath, { ...options, readOnly: true, readonly: true });
}

export default {
  JsonlFallbackDatabaseSync,
  isHostProtectedSqlitePath,
  openLocalHorizonDb,
  openHostReadOnlyDb
};
