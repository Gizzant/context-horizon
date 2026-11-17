/**
 * @file src/engine-node/db/jsonl_fallback.mjs
 * Pure-JS JSONL transcript reader and query emulator for Node 20 LTS environments.
 *
 * Provides equivalent get(), all(), and searchFts() interface for session transcripts,
 * strictly enforcing the { readOnly: true } invariant and rejecting mutation queries.
 */

import fs from 'node:fs';
import path from 'node:path';

const MUTATION_SQL_RE = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX)\b/i;

export class JsonlDatabaseFallbackWrapper {
  /**
   * @param {string} dbPath
   * @param {object} options
   * @param {boolean} options.readOnly - Must strictly be true
   * @param {Array<object>} [options.records] - Direct pre-loaded records
   */
  constructor(dbPath, options = {}) {
    if (!options || options.readOnly !== true) {
      throw new Error('[Zero-Trust SQLite Guard] JsonlDatabaseFallbackWrapper strictly requires { readOnly: true }');
    }
    this.dbPath = dbPath;
    this.readOnly = true;
    this.isOpen = true;
    this.records = [];
    this._loadRecords(options);
  }

  _loadRecords(options = {}) {
    if (options.records && Array.isArray(options.records)) {
      this.records = [...options.records];
      return;
    }
    if (!this.dbPath || typeof this.dbPath !== 'string') return;

    try {
      const targetPath = path.resolve(this.dbPath);
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.isFile() && targetPath.endsWith('.jsonl')) {
          this._parseJsonlFile(targetPath);
          return;
        }

        const sessionDir = stat.isDirectory() ? targetPath : path.dirname(targetPath);
        const cand1 = path.join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
        if (fs.existsSync(cand1)) {
          this._parseJsonlFile(cand1);
          return;
        }
        const cand2 = path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(cand2)) {
          this._parseJsonlFile(cand2);
          return;
        }
        const cand3 = path.join(sessionDir, 'transcript.jsonl');
        if (fs.existsSync(cand3)) {
          this._parseJsonlFile(cand3);
          return;
        }
      }
    } catch {
      // Graceful fail-open on path lookup
    }
  }

  _parseJsonlFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed !== null && parsed !== undefined) this.records.push(parsed);
        } catch {
          // Ignore malformed individual JSONL line
        }
      }
    } catch {
      // File read error caught gracefully
    }
  }

  _assertNotMutating(sql) {
    if (MUTATION_SQL_RE.test(sql)) {
      throw new Error(`[Zero-Trust SQLite Guard] Mutation query not permitted on read-only database: ${sql}`);
    }
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  all(sql, params = []) {
    if (!this.isOpen) throw new Error('Database handle is closed');
    this._assertNotMutating(sql);

    // Handle SELECT COUNT(*)
    if (/SELECT\s+COUNT\(\*\)\s+(?:AS\s+(\w+))?/i.test(sql)) {
      const match = sql.match(/SELECT\s+COUNT\(\*\)\s+(?:AS\s+(\w+))?/i);
      const alias = match ? match[1] || 'cnt' : 'cnt';
      return [{ [alias]: this.records.length }];
    }

    let filtered = this.records;

    // Handle WHERE column = ? or literal
    const whereMatch = sql.match(/WHERE\s+([a-zA-Z0-9_]+)\s*=\s*(?:\?|'([^']*)'|(\d+))/i);
    if (whereMatch) {
      const col = whereMatch[1];
      const expectedVal = whereMatch[2] !== undefined
        ? whereMatch[2]
        : whereMatch[3] !== undefined
          ? Number(whereMatch[3])
          : (Array.isArray(params) ? params[0] : params);

      filtered = filtered.filter(r => r && (r[col] === expectedVal || String(r[col]) === String(expectedVal)));
    }

    // Handle LIMIT N
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      const lim = parseInt(limitMatch[1], 10);
      filtered = filtered.slice(0, lim);
    }

    return filtered;
  }

  searchFts(query, limit = 10) {
    if (!this.isOpen) throw new Error('Database handle is closed');
    if (!query || typeof query !== 'string') return [];

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const results = [];
    for (const r of this.records) {
      if (!r) continue;
      const text = typeof r === 'string'
        ? r
        : Object.values(r).map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))).join(' ');
      const lower = text.toLowerCase();
      let score = 0;
      let firstIdx = -1;

      for (const term of terms) {
        let idx = 0;
        let count = 0;
        while ((idx = lower.indexOf(term, idx)) !== -1) {
          count++;
          if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
          idx += term.length;
        }
        if (count > 0) {
          score += count * (term.length / Math.max(1, lower.length) + 1);
        }
      }

      if (score > 0) {
        const start = Math.max(0, firstIdx - 20);
        const end = Math.min(text.length, firstIdx + 60);
        const snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
        results.push({ ...r, snippet, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  close() {
    this.isOpen = false;
    this.records = [];
  }
}

export default JsonlDatabaseFallbackWrapper;
