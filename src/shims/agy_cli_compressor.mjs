import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { suppressSqliteExperimentalWarning } from '../core/paths.mjs';
import { openLocalHorizonDb } from '../core/sqlite_client.mjs';

suppressSqliteExperimentalWarning();

/**
 * Phase 3.2 / Ring 1 Hardening: CLI Output Compressor with Critical Error-Line Recovery
 * (`src/shims/agy_cli_compressor.mjs`)
 *
 * - Pre-Threshold ANSI & Spinner Stripping: Strips ANSI CSI/OSC escape codes and collapses
 *   carriage-return `\r` overwrites before threshold check and FTS5 SQLite storage.
 * - Expands Command Matchers: Dedicated noise profiles for `cargo` (`cargo test|check|clippy`)
 *   and `npm` / `pnpm` / `yarn` (`install|ci|add`).
 * - Intercepts noisy CLI stdout (`> 4096` chars).
 * - Archives sanitized, full unredacted output into `.agents/cache/cli_logs.sqlite` (SQLite FTS5).
 * - Critical Error-Line Recovery Backstop: Diffs the compressed summary against raw stdout.
 *   Any line matching `/(Error|Exception|FAIL|error\[E\d+\]|panic:|ERR!|ERESOLVE|AssertionError|SyntaxError)/i`
 *   omitted by summarization is forcibly recovered and appended under:
 *   `[horizon-cli-shim: N critical error line(s) preserved]`
 */

export const CLI_SHIM_CONSTANTS = Object.freeze({
  MIN_CHARS_TO_COMPRESS: 4096,
  TARGET_CLI_REGEX:
    /\b(pytest|npm\s+(?:test|run\s+test|install|add|i|ci|build|update)|pnpm\s+(?:test|run\s+test|install|add|i|ci|build|update)|yarn(?:\s+(?:test|run\s+test|install|add|build|check))?|cargo\s+(?:test|check|clippy|build|run)|tsc|git\s+log|jest|vitest|node\s+--test)\b/i,
  CRITICAL_ERROR_LINE_REGEX:
    /(Error|Exception|FAIL|error\[E\d+\]|panic:|ERR!|ERESOLVE|AssertionError|SyntaxError)/i
});

export function getDefaultCliLogsSqlitePath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.agents', 'cache', 'cli_logs.sqlite');
}

export function isTargetNoisyCliCommand(command = '') {
  return CLI_SHIM_CONSTANTS.TARGET_CLI_REGEX.test(String(command || ''));
}

/**
 * Strips all ANSI CSI/OSC escape codes and collapses `\r` carriage-return progress-bar overwrites.
 */
export function stripAnsiAndCarriageReturns(rawText = '') {
  if (!rawText) return '';
  // 1. Strip ANSI CSI/OSC and color/control escape sequences
  const strippedAnsi = String(rawText).replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g,
    ''
  );

  // 2. Collapse \r carriage-return progress-bar overwrites per line
  const lines = strippedAnsi.split(/\r?\n/);
  const collapsedLines = lines.map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r').filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  });

  return collapsedLines.join('\n');
}

/**
 * Builds the compact ~115-token structural summary (header, head/tail framing, and FTS5 BM25 pointer).
 */
export function buildCompact115TokenSummary(rawStdout = '', {
  command = 'npm test',
  exitCode = 1,
  logId = 'log-1',
  dbPath = '.agents/cache/cli_logs.sqlite'
} = {}) {
  const lines = String(rawStdout || '').split(/\r?\n/);
  const headLines = lines.slice(0, 3).map((l) => l.trim()).filter(Boolean);
  const tailLines = lines.slice(-3).map((l) => l.trim()).filter(Boolean);

  const summaryLines = [
    `[horizon-cli-compressor] cmd="${command}" exit=${exitCode} chars=${rawStdout.length} lines=${lines.length}`,
    `[archive] ${dbPath} (id="${logId}" • FTS5 BM25 query: SELECT snippet(cli_logs, 4, '[', ']', '...', 16) FROM cli_logs WHERE cli_logs MATCH '<term>' ORDER BY bm25(cli_logs))`,
    `--- Head (${headLines.length} lines) ---`,
    ...headLines.map((l) => `  ${l.slice(0, 120)}`),
    `--- Tail (${tailLines.length} lines) ---`,
    ...tailLines.map((l) => `  ${l.slice(0, 120)}`)
  ];

  return summaryLines.join('\n');
}

/**
 * Specialized noise profile for cargo commands (cargo test, cargo check, cargo clippy).
 * Collapses Downloading, Compiling, Checking, and passing tests while retaining error[E\d+],
 * failure sections, file/line spans, and panic traces.
 */
export function compressCargoOutput(cleanStdout = '', {
  command = 'cargo test',
  exitCode = 0,
  logId = 'log-1',
  dbPath = '.agents/cache/cli_logs.sqlite'
} = {}) {
  const lines = String(cleanStdout || '').split(/\r?\n/);
  let compilingCount = 0;
  let downloadingCount = 0;
  let checkingCount = 0;
  let passedTestsCount = 0;
  const diagnosticLines = [];
  let inFailuresSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\s*(Downloading|Downloaded)\s+/i.test(trimmed)) {
      downloadingCount++;
      continue;
    }
    if (/^\s*Compiling\s+/i.test(trimmed)) {
      compilingCount++;
      continue;
    }
    if (/^\s*Checking\s+/i.test(trimmed)) {
      checkingCount++;
      continue;
    }
    if (/^test\s+.*?\.\.\.\s+ok$/i.test(trimmed)) {
      passedTestsCount++;
      continue;
    }

    if (/^failures:$/i.test(trimmed)) {
      inFailuresSection = true;
      diagnosticLines.push(line);
      continue;
    }

    if (inFailuresSection) {
      if (/^test result:/i.test(trimmed)) {
        inFailuresSection = false;
        diagnosticLines.push(line);
      } else {
        diagnosticLines.push(line);
      }
      continue;
    }

    if (
      /error\[E\d+\]:/i.test(trimmed) ||
      /-->\s+\S+:\d+:\d+/i.test(trimmed) ||
      /panicked at/i.test(trimmed) ||
      /^test result:/i.test(trimmed)
    ) {
      diagnosticLines.push(line);
      let nextIdx = i + 1;
      while (nextIdx < lines.length && /^\s{4,}/.test(lines[nextIdx]) && nextIdx <= i + 3) {
        diagnosticLines.push(lines[nextIdx]);
        nextIdx++;
      }
      i = nextIdx - 1;
    }
  }

  const summaryLines = [
    `[horizon-cli-compressor:cargo] cmd="${command}" exit=${exitCode} compiled=${compilingCount} downloaded=${downloadingCount} passed_tests=${passedTestsCount}`,
    `[archive] ${dbPath} (id="${logId}" • FTS5 BM25 query: SELECT snippet(cli_logs, 4, '[', ']', '...', 16) FROM cli_logs WHERE cli_logs MATCH '<term>' ORDER BY bm25(cli_logs))`,
    ...(diagnosticLines.length > 0
      ? [`--- Diagnostics (${diagnosticLines.length} lines) ---`, ...diagnosticLines.slice(0, 40)]
      : ['--- No compiler/test failures recorded ---'])
  ];

  return summaryLines.join('\n');
}

/**
 * Specialized noise profile for npm / pnpm / yarn package install commands.
 * Strips progress spinners, funding notices, and verbose dependency trees while retaining
 * the exit summary and ERR! / ERESOLVE conflict blocks.
 */
export function compressNpmInstallOutput(cleanStdout = '', {
  command = 'npm install',
  exitCode = 0,
  logId = 'log-1',
  dbPath = '.agents/cache/cli_logs.sqlite'
} = {}) {
  const lines = String(cleanStdout || '').split(/\r?\n/);
  const preservedLines = [];
  let packageSummary = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/i.test(trimmed)) continue;
    if (/\bpackages? (?:are )?looking for funding\b/i.test(trimmed)) continue;
    if (/\brun `npm fund`\b/i.test(trimmed)) continue;
    if (/\brun `npm audit`\b/i.test(trimmed)) continue;
    if (/^[+`|\\├└]--/.test(trimmed)) continue;

    if (
      /\b(?:added|removed|changed|audited)\s+\d+\s+packages?\b/i.test(trimmed) ||
      /^up to date\b/i.test(trimmed)
    ) {
      packageSummary = trimmed;
      continue;
    }

    if (
      /\b(?:npm\s+ERR!|ERR!|ERESOLVE|warn\s+deprecated|error\[E\d+\])\b/i.test(trimmed) ||
      CLI_SHIM_CONSTANTS.CRITICAL_ERROR_LINE_REGEX.test(trimmed)
    ) {
      preservedLines.push(line);
    }
  }

  const summaryLines = [
    `[horizon-cli-compressor:npm] cmd="${command}" exit=${exitCode} summary="${packageSummary || 'install completed'}"`,
    `[archive] ${dbPath} (id="${logId}" • FTS5 BM25 query: SELECT snippet(cli_logs, 4, '[', ']', '...', 16) FROM cli_logs WHERE cli_logs MATCH '<term>' ORDER BY bm25(cli_logs))`,
    ...(preservedLines.length > 0
      ? [`--- Retained Messages (${preservedLines.length} lines) ---`, ...preservedLines.slice(0, 30)]
      : [])
  ];

  return summaryLines.join('\n');
}

/**
 * Diffs a compressed summary against clean stdout and recovers 100% of omitted lines matching
 * `/(Error|Exception|FAIL|error\[E\d+\]|panic:|ERR!|ERESOLVE|AssertionError|SyntaxError)/i`.
 */
export function recoverOmittedCriticalErrorLines(cleanStdout = '', compressedSummary = '') {
  const rawLines = String(cleanStdout || '').split(/\r?\n/);
  const summaryText = String(compressedSummary || '');
  const omittedCriticalLines = [];
  const seen = new Set();

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (!CLI_SHIM_CONSTANTS.CRITICAL_ERROR_LINE_REGEX.test(trimmed)) {
      continue;
    }

    if (!summaryText.includes(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      omittedCriticalLines.push(trimmed);
    }
  }

  if (omittedCriticalLines.length === 0) {
    return {
      output: summaryText,
      recoveredCount: 0,
      recoveredLines: []
    };
  }

  const recoveryBlock = [
    `[horizon-cli-shim: ${omittedCriticalLines.length} critical error line(s) preserved]`,
    ...omittedCriticalLines
  ].join('\n');

  return {
    output: `${summaryText}\n${recoveryBlock}`,
    recoveredCount: omittedCriticalLines.length,
    recoveredLines: omittedCriticalLines
  };
}

/**
 * Compresses noisy CLI output (`> 4096` chars), indexes the unredacted stdout into
 * `.agents/cache/cli_logs.sqlite` using FTS5 BM25, and applies the Critical Error-Line Recovery Backstop.
 */
export async function compressCliOutputWithRecovery({
  command = 'pytest',
  rawStdout = '',
  stdout = undefined,
  exitCode = 1,
  sessionId = 'default-session',
  turnId = 'turn-1',
  workspaceDir = process.cwd(),
  dbPath = null,
  DatabaseSync = null,
  summaryOverride = null,
  forceCompress = false
} = {}) {
  const startMs = performance.now();
  const rawSource = String(rawStdout || stdout || '');

  // 1. Pre-Threshold ANSI & Spinner Stripping
  const cleanText = stripAnsiAndCarriageReturns(rawSource);
  const charCount = cleanText.length;
  const rawTokens = Math.ceil(charCount / 4);

  const shouldCompress =
    forceCompress ||
    (charCount > CLI_SHIM_CONSTANTS.MIN_CHARS_TO_COMPRESS && isTargetNoisyCliCommand(command));

  if (!shouldCompress) {
    return {
      compressed: false,
      charCount,
      rawTokens,
      compressedTokens: rawTokens,
      tokensSaved: 0,
      recoveredCount: 0,
      recoveredLines: [],
      output: cleanText,
      dbPath: null,
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };
  }

  const resolvedDbPath = dbPath || getDefaultCliLogsSqlitePath(workspaceDir);
  const logId = `${sessionId}:${turnId}:${Date.now()}`;
  let archivedInSqlite = false;

  // 2. Archive sanitized clean output into SQLite FTS5 (WAL + busy_timeout=5000)
  try {
    const db = openLocalHorizonDb(resolvedDbPath, { readOnly: false, DatabaseSync });
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS cli_logs USING fts5(
          log_id,
          session_id,
          turn_id,
          command,
          raw_output,
          created_at
        );
      `);
      db.prepare(`
        INSERT INTO cli_logs (log_id, session_id, turn_id, command, raw_output, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        String(logId),
        String(sessionId),
        String(turnId),
        String(command),
        cleanText,
        new Date().toISOString()
      );
      archivedInSqlite = true;
    } finally {
      db.close();
    }
  } catch {
    archivedInSqlite = false;
  }

  // 3. Choose appropriate compressor profile
  let baseSummary = '';
  if (summaryOverride !== null) {
    baseSummary = String(summaryOverride);
  } else if (/cargo\s+(?:test|check|clippy|build|run)/i.test(command)) {
    baseSummary = compressCargoOutput(cleanText, {
      command,
      exitCode,
      logId,
      dbPath: resolvedDbPath
    });
  } else if (/(?:npm|pnpm|yarn)\s+(?:install|add|i|ci|build|update)/i.test(command)) {
    baseSummary = compressNpmInstallOutput(cleanText, {
      command,
      exitCode,
      logId,
      dbPath: resolvedDbPath
    });
  } else {
    baseSummary = buildCompact115TokenSummary(cleanText, {
      command,
      exitCode,
      logId,
      dbPath: resolvedDbPath
    });
  }

  // 4. Critical Error-Line Recovery Backstop
  const recovery = recoverOmittedCriticalErrorLines(cleanText, baseSummary);
  const compressedTokens = Math.ceil(recovery.output.length / 4);
  const tokensSaved = Math.max(0, rawTokens - compressedTokens);

  return {
    compressed: true,
    archivedInSqlite,
    logId,
    dbPath: resolvedDbPath,
    charCount,
    rawTokens,
    compressedTokens,
    tokensSaved,
    recoveredCount: recovery.recoveredCount,
    recoveredLines: recovery.recoveredLines,
    output: recovery.output,
    elapsedMs: Number((performance.now() - startMs).toFixed(3))
  };
}

/**
 * Queries `.agents/cache/cli_logs.sqlite` using SQLite FTS5 BM25 ranking.
 */
export async function searchCliLogsBm25(queryText, {
  workspaceDir = process.cwd(),
  dbPath = null,
  limit = 5,
  DatabaseSync = null
} = {}) {
  const resolvedDbPath = dbPath || getDefaultCliLogsSqlitePath(workspaceDir);
  if (!fs.existsSync(resolvedDbPath)) return [];

  const db = openLocalHorizonDb(resolvedDbPath, { readOnly: true, DatabaseSync });
  try {
    const safeQuery = String(queryText || '').replace(/"/g, '""').trim();
    if (!safeQuery) return [];
    const stmt = db.prepare(`
      SELECT
        log_id AS logId,
        session_id AS sessionId,
        turn_id AS turnId,
        command,
        bm25(cli_logs) AS bm25Score,
        snippet(cli_logs, 4, '[', ']', '...', 24) AS snippet
      FROM cli_logs
      WHERE cli_logs MATCH ?
      ORDER BY bm25(cli_logs)
      LIMIT ?
    `);
    return stmt.all(`"${safeQuery}"`, Number(limit || 5));
  } finally {
    db.close();
  }
}

export default {
  CLI_SHIM_CONSTANTS,
  stripAnsiAndCarriageReturns,
  compressCliOutputWithRecovery,
  compressCargoOutput,
  compressNpmInstallOutput,
  recoverOmittedCriticalErrorLines,
  buildCompact115TokenSummary,
  searchCliLogsBm25
};
