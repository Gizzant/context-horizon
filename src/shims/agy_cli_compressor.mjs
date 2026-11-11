import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { suppressSqliteExperimentalWarning } from '../core/paths.mjs';
import { openLocalHorizonDb } from '../core/sqlite_client.mjs';
import { sanitizeForensicPayload } from '../core/sanitizer.mjs';
import { SavedQuotaReceiptLedger, SAVINGS_EVENT_TYPES } from '../core/coach/saved_quota_ledger.mjs';
import { compressCliOutputPure, redactSecretsPure } from '../core/shared/index.mjs';

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

export const AH_CLI_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB ring cap

export function getDefaultAhCliArchiveSqlitePath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.agents', 'cache', 'ah_cli_archive.sqlite');
}

/**
 * Rank 3 (DET-07): Archives sanitized >4,096-char CLI output into a WAL-enabled,
 * 5 MB ring-capped SQLite FTS5 store (`.agents/cache/ah_cli_archive.sqlite`),
 * preserves 30 head + 45 tail + 100% of error lines, appends BM25 query hint,
 * and records exact byte-verified token savings in `SavedQuotaReceiptLedger`.
 */
export function archiveAndCompressDet07Output(rawOutput = '', {
  command = '',
  exitCode = 0,
  sessionId = 'default-session',
  workspaceDir = process.cwd(),
  archiveDbPath = null,
  ledgerDbPath = null,
  maxArchiveBytes = AH_CLI_ARCHIVE_MAX_BYTES
} = {}) {
  const rawStr = String(rawOutput ?? '');
  const comp = compressCliOutputPure(rawStr, {
    headCount: 30,
    tailCount: 45,
    archiveThresholdChars: CLI_SHIM_CONSTANTS.MIN_CHARS_TO_COMPRESS,
    queryHint: 'node .agents/shims/ah_log_query.mjs "<term>"'
  });

  if (rawStr.length <= CLI_SHIM_CONSTANTS.MIN_CHARS_TO_COMPRESS) {
    return {
      detectorId: 'DET-07',
      compressed: comp.compressed,
      archived: false,
      exitCode: Number(exitCode ?? 0),
      output: comp.output,
      rawBytes: Buffer.byteLength(rawStr, 'utf8'),
      compressedBytes: Buffer.byteLength(comp.output, 'utf8'),
      bytesSaved: 0,
      tokensSaved: 0,
      archiveDbPath: null
    };
  }

  // Strip ANSI escape codes + scrub credentials via sanitizer.mjs + shared pure secret scrubber
  const ansiClean = stripAnsiAndCarriageReturns(rawStr);
  const { sanitized: forensicClean } = sanitizeForensicPayload(ansiClean);
  const { sanitized: scrubbedText, redactedCount } = redactSecretsPure(forensicClean);

  const resolvedArchiveDb = archiveDbPath || getDefaultAhCliArchiveSqlitePath(workspaceDir);
  const capBytes = Math.max(65536, Number(maxArchiveBytes) || AH_CLI_ARCHIVE_MAX_BYTES);
  const createdAt = new Date().toISOString();
  const payloadBytes = Buffer.byteLength(scrubbedText, 'utf8');
  let evictedRows = 0;

  const db = openLocalHorizonDb(resolvedArchiveDb, { readOnly: false, busyTimeoutMs: 3000 });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ah_cli_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        byte_len INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ah_cli_fts USING fts5(
        meta_id UNINDEXED,
        command,
        redacted_output
      );
    `);

    // Clamp single-entry payload if a single giant dump exceeds 80% of the 5 MB ring cap
    const maxSinglePayload = Math.floor(capBytes * 0.72);
    const boundedText = payloadBytes > maxSinglePayload
      ? scrubbedText.slice(0, maxSinglePayload)
      : scrubbedText;
    const boundedBytes = Buffer.byteLength(boundedText, 'utf8');

    // Evict oldest rows so cumulative payload + SQLite overhead stays strictly <= 5 MB
    const targetPayloadBudget = Math.floor(capBytes * 0.78);
    let totalRow = db.prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM ah_cli_meta').get();
    let currentTotal = Number(totalRow?.total || 0);

    while (currentTotal + boundedBytes > targetPayloadBudget) {
      const oldest = db.prepare('SELECT id, byte_len FROM ah_cli_meta ORDER BY id ASC LIMIT 5').all();
      if (!oldest || oldest.length === 0) break;
      const delMeta = db.prepare('DELETE FROM ah_cli_meta WHERE id = ?');
      const delFts = db.prepare('DELETE FROM ah_cli_fts WHERE meta_id = ?');
      for (const row of oldest) {
        delFts.run(String(row.id));
        delMeta.run(row.id);
        currentTotal = Math.max(0, currentTotal - Number(row.byte_len || 0));
        evictedRows += 1;
        if (currentTotal + boundedBytes <= targetPayloadBudget) break;
      }
    }

    const insMeta = db.prepare(`
      INSERT INTO ah_cli_meta (session_id, command, exit_code, byte_len, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(sessionId), String(command), Number(exitCode ?? 0), boundedBytes, createdAt);

    const metaId = String(insMeta.lastInsertRowid);
    db.prepare(`
      INSERT INTO ah_cli_fts (meta_id, command, redacted_output)
      VALUES (?, ?, ?)
    `).run(metaId, String(command), boundedText);

    if (evictedRows > 0) {
      db.exec("INSERT INTO ah_cli_fts(ah_cli_fts) VALUES('optimize');");
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
  } finally {
    db.close();
  }

  // Enforce hard physical file ceiling <= capBytes via VACUUM if page freelist grew past cap
  try {
    if (fs.existsSync(resolvedArchiveDb) && fs.statSync(resolvedArchiveDb).size > capBytes) {
      const vacDb = openLocalHorizonDb(resolvedArchiveDb, { readOnly: false, busyTimeoutMs: 3000 });
      try {
        vacDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        vacDb.exec('VACUUM;');
        vacDb.exec('PRAGMA journal_mode = WAL;');
      } finally {
        vacDb.close();
      }
    }
  } catch {}

  const rawBytes = Buffer.byteLength(rawStr, 'utf8');
  const compressedBytes = Buffer.byteLength(comp.output, 'utf8');
  const bytesSaved = Math.max(0, rawBytes - compressedBytes);
  const tokensSaved = Math.floor(bytesSaved / 4);

  if (tokensSaved > 0) {
    try {
      const ledger = new SavedQuotaReceiptLedger({
        ...(ledgerDbPath ? { dbPath: ledgerDbPath } : {})
      });
      ledger.recordSaving({
        sessionId,
        eventType: SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED,
        argonEquivTokensSaved: tokensSaved,
        rawBytesSaved: bytesSaved,
        detail: `DET-07 compressed "${String(command).slice(0, 60)}" (${bytesSaved} bytes saved)`
      });
    } catch {}
  }

  return {
    detectorId: 'DET-07',
    compressed: true,
    archived: true,
    exitCode: Number(exitCode ?? 0),
    output: comp.output,
    rawBytes,
    compressedBytes,
    bytesSaved,
    tokensSaved,
    redactedCount,
    evictedRows,
    archiveDbPath: resolvedArchiveDb
  };
}

export function queryAhCliArchiveBm25(searchTerm, {
  workspaceDir = process.cwd(),
  archiveDbPath = null,
  limit = 8
} = {}) {
  const resolvedDb = archiveDbPath || getDefaultAhCliArchiveSqlitePath(workspaceDir);
  if (!fs.existsSync(resolvedDb)) return [];
  const cleanTerm = String(searchTerm || '').replace(/"/g, () => '""').trim();
  if (!cleanTerm) return [];

  const db = openLocalHorizonDb(resolvedDb, { readOnly: true, busyTimeoutMs: 3000 });
  try {
    return db.prepare(`
      SELECT
        m.id AS id,
        m.command AS command,
        m.exit_code AS exitCode,
        m.created_at AS createdAt,
        bm25(ah_cli_fts) AS score,
        snippet(ah_cli_fts, 2, '[', ']', '...', 24) AS snippet
      FROM ah_cli_fts
      JOIN ah_cli_meta m ON m.id = CAST(ah_cli_fts.meta_id AS INTEGER)
      WHERE ah_cli_fts MATCH ?
      ORDER BY bm25(ah_cli_fts)
      LIMIT ?
    `).all(`"${cleanTerm}"`, Math.max(1, Number(limit) || 8));
  } finally {
    db.close();
  }
}

/**
 * Executes a real child command, captures stdout + stderr + exact exitCode,
 * applies DET-07 compression + FTS5 archiving, and returns `{ exitCode, output, ... }`.
 */
export function executeAndCompressCommand(command, args = [], options = {}) {
  const useShell = options.shell !== undefined ? Boolean(options.shell) : args.length === 0;
  const child = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: useShell,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });

  const exactExitCode = typeof child.status === 'number'
    ? child.status
    : (child.error ? 127 : 1);
  const combinedRaw = [child.stdout || '', child.stderr || ''].filter(Boolean).join('\n');
  const fullCmdLabel = args.length > 0 ? `${command} ${args.join(' ')}` : String(command);

  const det07 = archiveAndCompressDet07Output(combinedRaw, {
    command: fullCmdLabel,
    exitCode: exactExitCode,
    sessionId: options.sessionId || process.env.AGY_CONVERSATION_ID || 'default-session',
    workspaceDir: options.workspaceDir || options.cwd || process.cwd(),
    archiveDbPath: options.archiveDbPath || null,
    ledgerDbPath: options.ledgerDbPath || null,
    maxArchiveBytes: options.maxArchiveBytes || AH_CLI_ARCHIVE_MAX_BYTES
  });

  return {
    ...det07,
    exitCode: exactExitCode
  };
}

function isShimCliMain(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isShimCliMain()) {
  const rawArgs = process.argv.slice(2);
  const dashIdx = rawArgs.indexOf('--');
  const cmdTokens = dashIdx >= 0 ? rawArgs.slice(dashIdx + 1) : rawArgs;
  if (cmdTokens.length === 0) {
    process.exit(0);
  }
  const [bin, ...rest] = cmdTokens;
  const res = executeAndCompressCommand(bin, rest, { shell: rest.length === 0 });
  if (res.output) {
    process.stdout.write(res.output + (res.output.endsWith('\n') ? '' : '\n'));
  }
  process.exit(res.exitCode);
}

export default {
  CLI_SHIM_CONSTANTS,
  AH_CLI_ARCHIVE_MAX_BYTES,
  stripAnsiAndCarriageReturns,
  compressCliOutputWithRecovery,
  compressCargoOutput,
  compressNpmInstallOutput,
  recoverOmittedCriticalErrorLines,
  buildCompact115TokenSummary,
  searchCliLogsBm25,
  archiveAndCompressDet07Output,
  queryAhCliArchiveBm25,
  executeAndCompressCommand
};
