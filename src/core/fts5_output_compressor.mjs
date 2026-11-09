import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';
import { SQLITE_OPEN_READONLY_OPTIONS } from './parser.mjs';

/**
 * Phase 1: Fail-Open CLI Output Compressor & Local SQLite FTS5 Index (`fts5_output_compressor.mjs`)
 *
 * When `pytest`, `jest`, `vitest`, `cargo test`, `tsc`, or `node --test` produces >80 lines
 * of output, archives the complete raw stdout/stderr into `~/.gemini/antigravity/agy-horizon/tool_logs_fts5.db`:
 *   CREATE VIRTUAL TABLE IF NOT EXISTS tool_logs USING fts5(session_id, turn_id, command, exit_code, raw_output, created_at)
 * and returns a deterministic <=25-line structured summary containing only the exit code,
 * failing test names, exact file:line assertion tracebacks, and an FTS5 query handle:
 *   `agy-log-search <turn_id> "<keyword>"`
 *
 * Strictly FAIL-OPEN: if any exception occurs during SQLite indexing or parsing, returns
 * the raw output untouched so builds and test workflows never break.
 */

export const FTS5_COMPRESSOR_CONSTANTS = Object.freeze({
  MIN_LINES_TO_COMPRESS: 80,
  MAX_SUMMARY_LINES: 25,
  TARGET_COMMAND_REGEX: /\b(pytest|jest|vitest|cargo\s+test|tsc|node\s+--test|npm\s+test)\b/i
});

export function getDefaultToolLogsDbPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'tool_logs_fts5.db');
}

export function isCompressibleCliCommand(command = '') {
  return FTS5_COMPRESSOR_CONSTANTS.TARGET_COMMAND_REGEX.test(String(command || ''));
}

/**
 * Extracts failing test names and exact `file:line` assertion tracebacks from raw CLI output
 * and formats a deterministic <= 25-line summary.
 */
export function buildDeterministicSummary(rawOutput = '', {
  command = 'pytest',
  exitCode = 1,
  turnId = 'turn-1',
  maxLines = FTS5_COMPRESSOR_CONSTANTS.MAX_SUMMARY_LINES
} = {}) {
  const lines = String(rawOutput || '').split(/\r?\n/);
  const failingTests = [];
  const fileLineTraces = [];
  const assertionLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Match pytest / jest / vitest / cargo / node --test failing test headers
    if (
      /^(FAILED|FAIL|✖)\s+/.test(line) ||
      /^_{3,}\s+.+\s+_{3,}$/.test(line) ||
      /^test\s+[\w:./-]+\s+\.\.\.\s+FAILED/i.test(line)
    ) {
      const cleaned = line.replace(/^_{3,}\s*|\s*_{3,}$/g, '').trim();
      if (cleaned && !failingTests.includes(cleaned) && failingTests.length < 6) {
        failingTests.push(cleaned.slice(0, 120));
      }
    }

    // Match exact file:line or TypeScript file(line,col) tracebacks
    if (
      /\b[A-Za-z0-9_./\\-]+\.(?:py|ts|tsx|js|mjs|rs|go):\d+(?::\d+)?\b/.test(line) ||
      /\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx)\(\d+,\d+\):\s*error\s+TS\d+/i.test(line)
    ) {
      if (!fileLineTraces.includes(line) && fileLineTraces.length < 8) {
        fileLineTraces.push(line.slice(0, 140));
      }
    }

    // Match E   AssertionError / assert / expect() failure lines
    if (/^(E\s+|AssertionError:|Error:|Expected\b|Received\b|assert\s+)/.test(line)) {
      if (!assertionLines.includes(line) && assertionLines.length < 5) {
        assertionLines.push(line.slice(0, 140));
      }
    }
  }

  const out = [];
  out.push(`[FTS5 Compressed CLI Output] cmd="${command}" exit_code=${exitCode} raw_lines=${lines.length}`);
  out.push(`Failing Tests (${failingTests.length}):`);
  if (failingTests.length > 0) {
    for (const ft of failingTests.slice(0, 6)) {
      out.push(`  - ${ft}`);
    }
  } else {
    out.push(`  - (No structured test header matched; see tracebacks below)`);
  }

  out.push(`File:Line Tracebacks & Assertions:`);
  const combinedTraces = [...fileLineTraces, ...assertionLines].slice(0, 10);
  if (combinedTraces.length > 0) {
    for (const tr of combinedTraces) {
      out.push(`  ${tr}`);
    }
  } else {
    for (const tailLine of lines.slice(-6)) {
      if (tailLine.trim()) out.push(`  ${tailLine.trim().slice(0, 140)}`);
    }
  }

  out.push(`FTS5 Query Handle: agy-log-search ${turnId} "<keyword>"`);

  // Strictly enforce <= maxLines (25 lines)
  const bounded = out.slice(0, maxLines - 1);
  if (bounded[bounded.length - 1] !== `FTS5 Query Handle: agy-log-search ${turnId} "<keyword>"`) {
    bounded.push(`FTS5 Query Handle: agy-log-search ${turnId} "<keyword>"`);
  }
  return bounded.slice(0, maxLines).join('\n');
}

/**
 * Compresses CLI output > 80 lines into `tool_logs_fts5.db` and returns a 25-line summary.
 * Fails open (returns rawOutput) if any exception is thrown.
 */
export async function compressCliOutputFts5({
  sessionId = 'default-session',
  turnId = 'turn-1',
  command = 'pytest',
  exitCode = 1,
  rawOutput = '',
  dbPath = null,
  homeDir = getHomeDir(),
  DatabaseSync = null,
  forceCompress = false
} = {}) {
  const rawStr = String(rawOutput || '');
  const rawLines = rawStr.split(/\r?\n/);
  const rawTokens = Math.ceil(rawStr.length / 4);

  if (!forceCompress && (rawLines.length <= FTS5_COMPRESSOR_CONSTANTS.MIN_LINES_TO_COMPRESS || !isCompressibleCliCommand(command))) {
    return {
      compressed: false,
      failOpen: false,
      output: rawStr,
      lineCount: rawLines.length,
      rawTokens,
      compressedTokens: rawTokens,
      tokensSaved: 0,
      reductionPct: 0,
      turnId,
      queryHandle: null
    };
  }

  let db = null;
  try {
    const resolvedDbPath = dbPath || getDefaultToolLogsDbPath(homeDir);
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
    const DbCtor = DatabaseSync || (await import('node:sqlite')).DatabaseSync;
    db = new DbCtor(resolvedDbPath);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tool_logs USING fts5(
        session_id,
        turn_id,
        command,
        exit_code,
        raw_output,
        created_at
      );
    `);

    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO tool_logs (session_id, turn_id, command, exit_code, raw_output, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(sessionId),
      String(turnId),
      String(command),
      String(exitCode),
      rawStr,
      createdAt
    );

    const summary = buildDeterministicSummary(rawStr, {
      command,
      exitCode,
      turnId,
      maxLines: FTS5_COMPRESSOR_CONSTANTS.MAX_SUMMARY_LINES
    });
    const summaryLines = summary.split(/\r?\n/);
    const compressedTokens = Math.ceil(summary.length / 4);
    const tokensSaved = Math.max(0, rawTokens - compressedTokens);
    const reductionPct = rawTokens > 0
      ? Number(((tokensSaved / rawTokens) * 100).toFixed(1))
      : 0;

    return {
      compressed: true,
      failOpen: false,
      dbPath: resolvedDbPath,
      output: summary,
      lineCount: summaryLines.length,
      rawLineCount: rawLines.length,
      rawTokens,
      compressedTokens,
      tokensSaved,
      reductionPct,
      turnId: String(turnId),
      queryHandle: `agy-log-search ${turnId} "<keyword>"`
    };
  } catch (err) {
    // Strictly fail open so builds never break
    return {
      compressed: false,
      failOpen: true,
      error: String(err?.message || err),
      output: rawStr,
      lineCount: rawLines.length,
      rawTokens,
      compressedTokens: rawTokens,
      tokensSaved: 0,
      reductionPct: 0,
      turnId: String(turnId),
      queryHandle: null
    };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

/**
 * Searches archived raw CLI output inside `tool_logs_fts5.db` (`agy-log-search <turn_id> "<keyword>"`).
 */
export async function searchToolLogsFts5(dbPath, {
  turnId = '',
  keyword = '',
  limit = 10,
  DatabaseSync = null
} = {}) {
  const resolvedDbPath = dbPath || getDefaultToolLogsDbPath();
  if (!fs.existsSync(resolvedDbPath)) {
    return { hits: [], matchedLines: [] };
  }

  let db = null;
  try {
    const DbCtor = DatabaseSync || (await import('node:sqlite')).DatabaseSync;
    db = new DbCtor(resolvedDbPath, SQLITE_OPEN_READONLY_OPTIONS);

    const cleanKeyword = String(keyword || '')
      .replace(/[^A-Za-z0-9_./:-]/g, ' ')
      .trim();

    let rows = [];
    if (cleanKeyword) {
      const ftsToken = cleanKeyword.split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' AND ');
      rows = db.prepare(`
        SELECT session_id AS sessionId, turn_id AS turnId, command, exit_code AS exitCode, raw_output AS rawOutput, created_at AS createdAt
        FROM tool_logs
        WHERE tool_logs MATCH ?
        LIMIT ?
      `).all(ftsToken, Math.max(1, limit));
    } else {
      rows = db.prepare(`
        SELECT session_id AS sessionId, turn_id AS turnId, command, exit_code AS exitCode, raw_output AS rawOutput, created_at AS createdAt
        FROM tool_logs
        LIMIT ?
      `).all(Math.max(1, limit));
    }

    if (turnId) {
      rows = rows.filter(r => String(r.turnId) === String(turnId));
    }

    const matchedLines = [];
    const kwLower = String(keyword || '').toLowerCase();
    for (const r of rows) {
      const lines = String(r.rawOutput || '').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!kwLower || lines[i].toLowerCase().includes(kwLower)) {
          matchedLines.push({
            turnId: r.turnId,
            lineNumber: i + 1,
            text: lines[i]
          });
          if (matchedLines.length >= 25) break;
        }
      }
    }

    return { hits: rows, matchedLines };
  } catch {
    return { hits: [], matchedLines: [] };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}
