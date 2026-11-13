/**
 * @file src/engine-node/db/probe.mjs
 * Dynamic runtime probe for node:sqlite builtin module.
 *
 * Enables full read-only SQLite & FTS5 on Node >= 22.5, with automatic fallback
 * to JSONL parsing on Node 20 LTS with zero --no-warnings flags.
 */

let warningSuppressed = false;

/**
 * Suppresses experimental SQLite warning from process.emitWarning.
 * Allows Node >= 22.5 to load node:sqlite with 0 stderr noise and zero --no-warnings CLI flags.
 */
export function suppressSqliteWarning({ force = false } = {}) {
  if ((warningSuppressed && !force) || typeof process === 'undefined') return;
  warningSuppressed = true;
  if (typeof process.emitWarning === 'function') {
    const orig = process.emitWarning.bind(process);
    process.emitWarning = function (warning, ...args) {
      const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
      const type = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].type) || (warning && warning.name) || '';
      if ((type === 'ExperimentalWarning' && /SQLite/i.test(msg)) || /SQLite is an experimental feature/i.test(msg)) {
        return;
      }
      return orig(warning, ...args);
    };
  }
}

let probedModule = undefined;

function extractFtsTokens(rawQuery = '') {
  const cleaned = String(rawQuery || '')
    .replace(/\bNEAR\s*\([^)]*\)/gi, ' ')
    .replace(/[A-Za-z0-9_]+\s*:/g, ' ')
    .replace(/['"*()]/g, ' ')
    .trim();
  if (!cleaned) return { mode: 'EMPTY', include: [], exclude: [] };

  if (/\s+NOT\s+/i.test(cleaned)) {
    const [incPart, ...excParts] = cleaned.split(/\s+NOT\s+/i);
    const include = incPart.split(/\s+(?:AND\s+|OR\s+)?/i).map(t => t.trim().toLowerCase()).filter(Boolean);
    const exclude = excParts.join(' ').split(/\s+/).map(t => t.trim().toLowerCase()).filter(Boolean);
    return { mode: 'AND', include, exclude };
  }
  if (/\s+OR\s+/i.test(cleaned)) {
    const include = cleaned.split(/\s+OR\s+|\s+/i).map(t => t.trim().toLowerCase()).filter(t => t && t !== 'or' && t !== 'and');
    return { mode: 'OR', include, exclude: [] };
  }
  const include = cleaned.split(/\s+AND\s+|\s+/i).map(t => t.trim().toLowerCase()).filter(t => t && t !== 'and');
  return { mode: 'AND', include, exclude: [] };
}

function evaluateFtsMatch(haystack = '', rawQuery = '') {
  const text = String(haystack || '').toLowerCase();
  const { mode, include, exclude } = extractFtsTokens(rawQuery);
  if (mode === 'EMPTY' || include.length === 0) return 0;
  for (const ex of exclude) {
    if (text.includes(ex)) return 0;
  }
  if (mode === 'OR') {
    return include.some(tok => text.includes(tok)) ? 1 : 0;
  }
  return include.every(tok => text.includes(tok)) ? 1 : 0;
}

function evaluateFtsBm25(haystack = '', rawQuery = '') {
  const text = String(haystack || '').toLowerCase();
  const { include } = extractFtsTokens(rawQuery);
  if (include.length === 0) return 0.0;
  let score = 0;
  for (const tok of include) {
    let idx = 0;
    while ((idx = text.indexOf(tok, idx)) !== -1) {
      score += 1;
      idx += tok.length;
    }
  }
  return score > 0 ? -score : 0.0;
}

function evaluateFtsSnippet(haystack = '', rawQuery = '', openTag = '[', closeTag = ']', ellipsis = '...', maxTokens = 16) {
  const rawStr = String(haystack || '');
  const { include } = extractFtsTokens(rawQuery);
  const segments = rawStr.includes('\x1f') ? rawStr.split('\x1f') : [rawStr];
  let chosenSegment = segments[segments.length - 1] || '';
  if (include.length > 0) {
    for (const seg of segments) {
      const lowerSeg = seg.toLowerCase();
      if (include.some(tok => lowerSeg.includes(tok))) {
        chosenSegment = seg;
        break;
      }
    }
  }
  if (!chosenSegment || include.length === 0) return chosenSegment.slice(0, 120);
  let out = chosenSegment;
  for (const tok of include) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})`, 'gi');
    if (re.test(out)) {
      out = out.replace(re, `${openTag}$1${closeTag}`);
    }
  }
  const words = out.split(/\s+/);
  const limit = Math.max(4, Number(maxTokens) || 16);
  if (words.length > limit) {
    return `${words.slice(0, limit).join(' ')}${ellipsis}`;
  }
  return out;
}

function createFts5PolyfillClass(RawDatabaseSync) {
  const Fts5PolyfillDatabaseSync = class DatabaseSync extends RawDatabaseSync {
    constructor(...args) {
      super(...args);
      this._activeFtsQuery = '';
      this._ftsColsCache = new Map();
      try {
        if (typeof this.function === 'function') {
          this.function('__hz_fts_match', (haystack, q) => {
            this._activeFtsQuery = String(q ?? '');
            return evaluateFtsMatch(haystack, q);
          });
          this.function('__hz_fts_bm25', (haystack) => {
            return evaluateFtsBm25(haystack, this._activeFtsQuery);
          });
          this.function('__hz_fts_snippet', (haystack, openTag, closeTag, ellipsis, maxTok) => {
            return evaluateFtsSnippet(haystack, this._activeFtsQuery, openTag, closeTag, ellipsis, maxTok);
          });
        }
      } catch {
        // Ignore if custom functions cannot be registered
      }
    }

    _getTableColumns(tableName) {
      if (this._ftsColsCache.has(tableName)) return this._ftsColsCache.get(tableName);
      try {
        const rows = super.prepare(`PRAGMA table_info(${tableName})`).all();
        const cols = rows.map(r => r.name).filter(Boolean);
        if (cols.length > 0) {
          this._ftsColsCache.set(tableName, cols);
          return cols;
        }
      } catch {}
      return [];
    }

    _buildConcatExpr(tableName) {
      const cols = this._getTableColumns(tableName);
      if (cols.length === 0) return `''`;
      return `(${cols.map(c => `COALESCE(CAST(${tableName}.${c} AS TEXT), '')`).join(" || char(31) || ")})`;
    }

    exec(sql) {
      let rewritten = String(sql || '');
      // Strip FTS5 optimize command on polyfilled tables
      rewritten = rewritten.replace(
        /INSERT\s+INTO\s+([A-Za-z0-9_]+)\s*\(\s*\1\s*\)\s*VALUES\s*\(\s*'optimize'\s*\)\s*;?/gi,
        ''
      );
      // Rewrite CREATE VIRTUAL TABLE ... USING fts5(...) into standard SQLite table preserving /* fts5 */ marker
      rewritten = rewritten.replace(
        /CREATE\s+VIRTUAL\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s+USING\s+fts5\s*\(([\s\S]*?)\)/gi,
        (_, ifNotExists = '', tableName, rawCols) => {
          const cols = rawCols
            .split(',')
            .map(part => part.trim())
            .filter(part => part && !part.includes('='))
            .map(part => part.replace(/\bUNINDEXED\b/gi, '').trim().split(/\s+/)[0])
            .filter(Boolean);
          this._ftsColsCache.set(tableName, cols);
          const colDefs = cols.map(c => `${c} TEXT`).join(', ');
          return `CREATE TABLE ${ifNotExists}${tableName} (/* fts5 */ ${colDefs})`;
        }
      );
      if (!rewritten.trim()) return;
      return super.exec(rewritten);
    }

    prepare(sql) {
      let rewritten = String(sql || '');
      const hasFtsSyntax = /\bMATCH\s+\?|\bbm25\s*\(|\bsnippet\s*\(/i.test(rewritten);
      if (hasFtsSyntax) {
        rewritten = rewritten.replace(
          /snippet\s*\(\s*([A-Za-z0-9_]+)\s*,\s*(-?\d+)\s*,\s*('[^']*')\s*,\s*('[^']*')\s*,\s*('[^']*')\s*,\s*(\d+)\s*\)/gi,
          (_, tbl, colIdxStr, openTag, closeTag, ellipsis, maxTok) => {
            const colIdx = Number(colIdxStr);
            const cols = this._getTableColumns(tbl);
            const targetExpr = (colIdx >= 0 && cols[colIdx])
              ? `COALESCE(CAST(${tbl}.${cols[colIdx]} AS TEXT), '')`
              : this._buildConcatExpr(tbl);
            return `__hz_fts_snippet(${targetExpr}, ${openTag}, ${closeTag}, ${ellipsis}, ${maxTok})`;
          }
        );
        rewritten = rewritten.replace(
          /bm25\s*\(\s*([A-Za-z0-9_]+)\s*\)/gi,
          (_, tbl) => `__hz_fts_bm25(${this._buildConcatExpr(tbl)})`
        );
        rewritten = rewritten.replace(
          /([A-Za-z0-9_]+)\s+MATCH\s+\?/gi,
          (_, tbl) => `__hz_fts_match(${this._buildConcatExpr(tbl)}, ?)`
        );
      }

      const stmt = super.prepare(rewritten);
      if (!hasFtsSyntax) return stmt;

      const self = this;
      const origAll = stmt.all.bind(stmt);
      const origGet = stmt.get.bind(stmt);
      stmt.all = (...args) => {
        if (args.length > 0) self._activeFtsQuery = String(args[0] ?? '');
        return origAll(...args);
      };
      stmt.get = (...args) => {
        if (args.length > 0) self._activeFtsQuery = String(args[0] ?? '');
        return origGet(...args);
      };
      return stmt;
    }
  };
  Object.defineProperty(Fts5PolyfillDatabaseSync, 'name', { value: 'DatabaseSync' });
  return Fts5PolyfillDatabaseSync;
}

function ensureFts5CapableModule(mod) {
  if (!mod || typeof mod.DatabaseSync !== 'function') return mod;
  const RawDb = mod.DatabaseSync;
  let hasNativeFts5 = false;
  if (typeof process === 'undefined' || process.env?.CTXTOP_FORCE_FTS5_POLYFILL !== '1') {
    try {
      const mem = new RawDb(':memory:');
      mem.exec('CREATE VIRTUAL TABLE __fts5_probe USING fts5(c);');
      mem.close();
      hasNativeFts5 = true;
    } catch {
      hasNativeFts5 = false;
    }
  }
  if (hasNativeFts5) return mod;
  const PolyfilledDb = createFts5PolyfillClass(RawDb);
  return {
    ...mod,
    DatabaseSync: PolyfilledDb
  };
}

/**
 * Probes for built-in node:sqlite module via process.getBuiltinModule.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.forceFallback=false]
 * @param {Function|null} [options.getBuiltinModuleOverride=null]
 * @returns {object|null}
 */
export function probeSqliteBuiltin({ forceFallback = false, getBuiltinModuleOverride = null } = {}) {
  if (
    forceFallback ||
    (typeof process !== 'undefined' && process.env?.CTXTOP_FORCE_NO_SQLITE === '1')
  ) {
    return null;
  }
  if (probedModule !== undefined && !getBuiltinModuleOverride) return probedModule;

  suppressSqliteWarning();

  const getBuiltin = getBuiltinModuleOverride ||
    (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null);

  if (!getBuiltin) {
    if (!getBuiltinModuleOverride) probedModule = null;
    return null;
  }

  try {
    const rawMod = getBuiltin('node:sqlite');
    if (rawMod && typeof rawMod.DatabaseSync === 'function') {
      const mod = getBuiltinModuleOverride ? rawMod : ensureFts5CapableModule(rawMod);
      if (!getBuiltinModuleOverride) probedModule = mod;
      return mod;
    }
  } catch {
    // Fail-open: probe never throws
  }

  if (!getBuiltinModuleOverride) probedModule = null;
  return null;
}

/**
 * Returns true if built-in node:sqlite with DatabaseSync is available in this runtime.
 *
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isNodeSqliteAvailable(options = {}) {
  return Boolean(probeSqliteBuiltin(options));
}

/**
 * Returns the DatabaseSync constructor if available, or null.
 *
 * @param {object} [options={}]
 * @returns {Function|null}
 */
export function getDatabaseSyncClass(options = {}) {
  const mod = probeSqliteBuiltin(options);
  return mod?.DatabaseSync || null;
}

/**
 * Resets probe cache for testing environments.
 */
export function resetProbeCacheForTesting() {
  probedModule = undefined;
}

export default {
  suppressSqliteWarning,
  probeSqliteBuiltin,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  resetProbeCacheForTesting
};
