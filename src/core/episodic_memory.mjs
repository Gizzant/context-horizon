import fs from 'node:fs';
import path from 'node:path';
import { SQLITE_OPEN_READONLY_OPTIONS } from './parser.mjs';

/**
 * SQLite FTS5 Episodic Memory Bridge & `[▶ RESUME HERE]` Context Synthesizer.
 *
 * Maintains a local zero-network SQLite FTS5 index (`~/.gemini/flightcheck/episodic_memory.db`)
 * storing compact session summaries, architectural decisions, modified files, and resolved errors,
 * and synthesizes a `<1,000 token` (`<=4,000 chars`) `[▶ RESUME HERE]` context pack.
 */

export async function upsertEpisodicMemory(dbPath, record = {}, { DatabaseSync } = {}) {
  if (!dbPath) {
    return { success: false, error: 'dbPath is required' };
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const DbCtor = DatabaseSync || (await import('node:sqlite')).DatabaseSync;
  const db = new DbCtor(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodic_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_path TEXT,
        title TEXT,
        summary TEXT,
        decisions TEXT,
        modified_files TEXT,
        updated_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
        session_id UNINDEXED,
        workspace_path,
        title,
        summary,
        decisions,
        modified_files
      );
    `);

    const sessionId = String(record.sessionId || `sess-${Date.now()}`);
    const workspacePath = String(record.workspacePath || '');
    const title = String(record.title || 'Session');
    const summary = String(record.summary || '');
    const decisions = Array.isArray(record.decisions) ? record.decisions.join('\n') : String(record.decisions || '');
    const modifiedFiles = Array.isArray(record.modifiedFiles) ? record.modifiedFiles.join(', ') : String(record.modifiedFiles || '');
    const updatedAt = record.updatedAt || new Date().toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO episodic_sessions (session_id, workspace_path, title, summary, decisions, modified_files, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, workspacePath, title, summary, decisions, modifiedFiles, updatedAt);

    db.prepare('DELETE FROM episodic_fts WHERE session_id = ?').run(sessionId);
    db.prepare(`
      INSERT INTO episodic_fts (session_id, workspace_path, title, summary, decisions, modified_files)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, workspacePath, title, summary, decisions, modifiedFiles);

    return { success: true, sessionId };
  } finally {
    try { db.close(); } catch {}
  }
}

export async function queryEpisodicMemoryBm25(dbPath, { query = '', workspacePath = '', limit = 8, DatabaseSync } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { hits: [] };
  }
  const DbCtor = DatabaseSync || (await import('node:sqlite')).DatabaseSync;
  const db = new DbCtor(dbPath, SQLITE_OPEN_READONLY_OPTIONS);
  try {
    const cleanQuery = String(query || '')
      .replace(/[^A-Za-z0-9_\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(' OR ');

    let rows = [];
    if (cleanQuery) {
      rows = db.prepare(`
        SELECT session_id AS sessionId, workspace_path AS workspacePath, title, summary, decisions, modified_files AS modifiedFiles, bm25(episodic_fts) AS rank
        FROM episodic_fts
        WHERE episodic_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `).all(cleanQuery, Math.max(1, limit));
    } else {
      rows = db.prepare(`
        SELECT session_id AS sessionId, workspace_path AS workspacePath, title, summary, decisions, modified_files AS modifiedFiles, 0.0 AS rank
        FROM episodic_sessions
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(Math.max(1, limit));
    }

    if (workspacePath) {
      const normWs = workspacePath.toLowerCase().replace(/\\/g, '/');
      const filtered = rows.filter(r => String(r.workspacePath || '').toLowerCase().replace(/\\/g, '/').includes(normWs));
      if (filtered.length > 0) rows = filtered;
    }

    return { hits: rows };
  } catch {
    return { hits: [] };
  } finally {
    try { db.close(); } catch {}
  }
}

export async function synthesizeResumeHerePack(dbPath, { workspacePath = '', query = '', maxChars = 4000, DatabaseSync } = {}) {
  const { hits } = await queryEpisodicMemoryBm25(dbPath, { query, workspacePath, limit: 5, DatabaseSync });
  const lines = [
    `# [▶ RESUME HERE] Episodic Context Pack`,
    `- **Workspace**: \`${workspacePath || 'active'}\``,
    `- **Matched Prior Sessions**: ${hits.length}`,
    ``
  ];

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    lines.push(`## ${i + 1}. ${h.title} (\`${h.sessionId}\`)`);
    if (h.summary) lines.push(`- **Summary**: ${String(h.summary).slice(0, 300)}`);
    if (h.decisions) lines.push(`- **Decisions**: ${String(h.decisions).slice(0, 260)}`);
    if (h.modifiedFiles) lines.push(`- **Files**: \`${String(h.modifiedFiles).slice(0, 240)}\``);
    lines.push('');
  }

  const rawMarkdown = lines.join('\n').slice(0, maxChars);
  const estimatedTokens = Math.ceil(rawMarkdown.length / 4);
  return {
    header: '[▶ RESUME HERE]',
    hitCount: hits.length,
    estimatedTokens,
    withinTokenBudget: estimatedTokens <= 1000,
    markdown: rawMarkdown
  };
}
