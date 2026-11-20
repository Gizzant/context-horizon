import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';
import { openLocalHorizonDb } from './sqlite_client.mjs';
import { SavedQuotaReceiptLedger, SAVINGS_EVENT_TYPES } from './coach/saved_quota_ledger.mjs';

/**
 * Phase 1: Fail-Open CLI Output Compressor & Local SQLite FTS5 Index (`fts5_output_compressor.mjs`)
 *
 * When a supported CLI/PowerShell command produces >40 lines or >=4,096 bytes of output
 * (`pytest`, `jest`, `vitest`, `cargo`, `tsc`, `node`, `python`, `Select-String`,
 * `Get-ChildItem`, `@'` heredocs, `powershell`/`pwsh`, `npm/pnpm/pip install`, `git`, `gh`, `docker`, `kubectl`),
 * archives the complete raw stdout/stderr into `~/.gemini/antigravity/agy-horizon/tool_logs_fts5.db`:
 *   CREATE VIRTUAL TABLE IF NOT EXISTS tool_logs USING fts5(session_id, turn_id, command, exit_code, raw_output, created_at)
 * and returns a deterministic <=25-line structured summary containing only the exit code,
 * failing test names, diagnostics or grouped search hits, and an FTS5 query handle:
 *   `agy-log-search <turn_id> "<keyword>"`
 *
 * Strictly FAIL-OPEN: if any exception occurs during SQLite indexing or parsing, returns
 * the raw output untouched so builds and test workflows never break.
 */

export const FTS5_COMPRESSOR_CONSTANTS = Object.freeze({
  MIN_LINES_TO_COMPRESS: 40,
  MIN_BYTES_TO_COMPRESS: 4096,
  MAX_SUMMARY_LINES: 25,
  TARGET_COMMAND_REGEX: /(?:(?:^|[\s;|&])@['"]|\b(?:pytest|jest|vitest|cargo\s+(?:test|clippy|check|build)|tsc|go\s+test|eslint|biome|ruff|next\s+build|vite\s+build|docker\s+(?:build|logs)|kubectl\s+(?:logs|get|describe)|gh\s+(?:pr|run|api|issue|release|workflow)|git\s+(?:diff|log|show|status|grep|ls-files|blame|branch|tag|stash|reflog|cherry-pick)|(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|build|typecheck)|install|ci|add|update|audit|outdated|pack|publish)|(?:pip3?|uv|poetry)\s+(?:install|sync|audit|list|show)|node(?:\.exe)?|python3?(?:\.exe)?|select-string|get-childitem|gci|get-content|write-output|powershell|pwsh|rg|ripgrep|grep|find|fd|tree|curl|wget|aws|gcloud|terraform)\b)/i
});

export function getDefaultToolLogsDbPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'tool_logs_fts5.db');
}

export function isCompressibleCliCommand(command = '') {
  return FTS5_COMPRESSOR_CONSTANTS.TARGET_COMMAND_REGEX.test(String(command || ''));
}

const POWERSHELL_HEREDOC_OR_SEARCH_RE =
  /(?:(?:^|[\s;|&])@['"]|\b(?:select-string|get-childitem|gci)\b)/i;
const BOUNDED_PIPE_FILTER_RE =
  /\|\s*(?:head|tail|sed|awk|cut|wc|grep|egrep|fgrep|rg|ripgrep)\b/i;
const INLINE_SCRIPT_OR_HEREDOC_RE =
  /\b(?:node(?:\.exe)?\s+(?:-[ep]\b|--eval\b|--print\b)|python3?(?:\.exe)?\s+(?:-c\b|-\s*<<|<<))|\bcat\s*>\s*\S+[\s\S]*<</i;
const FILE_INSPECTION_SEGMENT_RE =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:\/[\w./-]+)?\/)?(?:cat|head|tail|sed|awk|cut|wc|nl|tac|rev|less|more|bat|stat|file(?=\s+\S)|ls|dir|tree|grep|egrep|fgrep|rg|ripgrep|get-content)(?=\s|$)(?![.\w-])/i;
const GIT_INSPECTION_CMD_RE = /\bgit\s+(?:diff|show|status|blame|log)\b/i;
const NOISY_PRIMARY_RUNNER_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:test|install|ci|run|build|lint|typecheck)|node\s+--test|pytest|jest|vitest|cargo|go\s+test|tsc|eslint|biome|ruff|next\s+build|vite\s+build|docker|kubectl|diag_check)\b/i;

/**
 * Determines whether a live `PostToolUse` shell command should allow FTS5 compression
 * and/or >4K artifact offloading. Protects explicit file-inspection, bounded pipeline,
 * standalone git inspection, and inline inspection commands from lossy re-read loops.
 *
 * @param {string} [command='']
 * @returns {{ allowFts5: boolean, allowOffload: boolean, reason: string }}
 */
export function classifyShellPostToolPolicy(command = '') {
  const cmd = String(command || '').trim();
  if (!cmd) {
    return { allowFts5: false, allowOffload: true, reason: 'empty_command' };
  }
  if (BOUNDED_PIPE_FILTER_RE.test(cmd)) {
    return { allowFts5: false, allowOffload: false, reason: 'explicitly_bounded_shell_output' };
  }
  const segments = cmd.split(/(?:&&|\|\||;|\||\r?\n)/);
  const hasInspectionSegment = segments.some((seg) => FILE_INSPECTION_SEGMENT_RE.test(seg));
  if (POWERSHELL_HEREDOC_OR_SEARCH_RE.test(cmd) && !hasInspectionSegment) {
    return { allowFts5: true, allowOffload: true, reason: 'eligible_powershell_cli' };
  }
  if (INLINE_SCRIPT_OR_HEREDOC_RE.test(cmd)) {
    return { allowFts5: false, allowOffload: false, reason: 'inline_script_or_heredoc' };
  }
  if (hasInspectionSegment) {
    return { allowFts5: false, allowOffload: false, reason: 'file_inspection_shell_command' };
  }
  if (GIT_INSPECTION_CMD_RE.test(cmd) && !NOISY_PRIMARY_RUNNER_RE.test(cmd)) {
    return { allowFts5: false, allowOffload: false, reason: 'git_inspection_command' };
  }
  return { allowFts5: true, allowOffload: true, reason: 'eligible_cli_output' };
}

export function classifyCliCommandFamily(command = '') {
  const cmd = String(command || '').toLowerCase();
  if (/\bgit\s+(diff|log|show|status)\b/.test(cmd)) return 'git';
  if (/\b(docker|kubectl)\b/.test(cmd) || /\bgh\s+(pr|run)\b/.test(cmd)) return 'infra';
  if (/\b(eslint|biome|ruff|tsc|cargo\s+(clippy|check|build)|next\s+build|vite\s+build)\b/.test(cmd)) {
    return 'lint_build';
  }
  if (
    /\b(pytest|jest|vitest|cargo\s+test|node\s+--test|(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|build|typecheck))|go\s+test)\b/.test(
      cmd
    )
  ) {
    return 'test';
  }
  if (
    /\b(select-string|get-childitem|gci|rg|ripgrep|grep|find|fd|tree)\b/.test(cmd) ||
    /\bgit\s+(grep|ls-files)\b/.test(cmd)
  ) {
    return 'search_list';
  }
  if (/\bgh\b/.test(cmd) && !/\bgh\s+(api|issue|release|workflow)\b/.test(cmd)) return 'infra';
  return 'generic_cli';
}

function pushUniqueBounded(arr, item, maxLen, sliceLen = 140) {
  const cleaned = String(item || '').trim().slice(0, sliceLen);
  if (!cleaned || arr.includes(cleaned) || arr.length >= maxLen) return;
  arr.push(cleaned);
}

/**
 * Extracts failing test names, diagnostics, git hunks, or infra errors from raw CLI output
 * and formats a deterministic <= 25-line summary with exact FTS5 query handle.
 */
export function buildDeterministicSummary(rawOutput = '', {
  command = 'pytest',
  exitCode = 1,
  turnId = 'turn-1',
  maxLines = FTS5_COMPRESSOR_CONSTANTS.MAX_SUMMARY_LINES
} = {}) {
  const lines = String(rawOutput || '').split(/\r?\n/);
  const family = classifyCliCommandFamily(command);
  const queryHandleLine = `FTS5 Query Handle: agy-log-search ${turnId} "<keyword>"`;

  if (family === 'git') {
    const fileHeaders = [];
    const hunksOrMeta = [];
    const conflictsOrErrors = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^(diff --git |\+\+\+ [ab]\/|--- [ab]\/|commit [0-9a-f]{7,})/.test(line)) {
        pushUniqueBounded(fileHeaders, line, 10);
      } else if (/^\s*(M|A|D|R\d*|C\d*|UU|\?\?)\s+\S+/.test(rawLine)) {
        pushUniqueBounded(fileHeaders, line, 10);
      } else if (/^@@\s+.*\s+@@/.test(line) || /^(\d+\s+files?\s+changed|[\w./-]+\s+\|\s+\d+)/.test(line)) {
        pushUniqueBounded(hunksOrMeta, line, 8);
      } else if (/^(<{7}|={7}|>{7}|error:|fatal:)/i.test(line)) {
        pushUniqueBounded(conflictsOrErrors, line, 4);
      }
    }
    const out = [
      `[FTS5 Compressed CLI Output] cmd="${command}" exit_code=${exitCode} raw_lines=${lines.length}`,
      `Git Files & Hunks (${fileHeaders.length} files, ${hunksOrMeta.length} hunks):`
    ];
    for (const f of fileHeaders) out.push(`  ${f}`);
    for (const h of hunksOrMeta) out.push(`  ${h}`);
    for (const c of conflictsOrErrors) out.push(`  ${c}`);
    if (out.length <= 2) {
      for (const tailLine of lines.slice(-6)) {
        if (tailLine.trim()) out.push(`  ${tailLine.trim().slice(0, 140)}`);
      }
    }
    const bounded = out.slice(0, Math.max(1, maxLines - 1));
    bounded.push(queryHandleLine);
    return bounded.slice(0, maxLines).join('\n');
  }

  if (family === 'infra') {
    const errors = [];
    const stages = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/\b(ERROR|FATAL|panic:|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|FAILED|fail)\b/i.test(line) || /^[✗✖X]\s+/.test(line)) {
        pushUniqueBounded(errors, line, 12);
      } else if (/^(#\d+\s+(?:DONE|ERROR)|Step\s+\d+\/\d+|NAME\s+READY|Successfully\s+(?:built|tagged))/i.test(line)) {
        pushUniqueBounded(stages, line, 6);
      }
    }
    const out = [
      `[FTS5 Compressed CLI Output] cmd="${command}" exit_code=${exitCode} raw_lines=${lines.length}`,
      `Infra & Deploy Diagnostics (${errors.length} error(s), ${stages.length} stage(s)):`
    ];
    for (const e of errors) out.push(`  ${e}`);
    for (const s of stages) out.push(`  ${s}`);
    if (errors.length === 0 && stages.length === 0) {
      for (const tailLine of lines.slice(-6)) {
        if (tailLine.trim()) out.push(`  ${tailLine.trim().slice(0, 140)}`);
      }
    }
    const bounded = out.slice(0, Math.max(1, maxLines - 1));
    bounded.push(queryHandleLine);
    return bounded.slice(0, maxLines).join('\n');
  }

  if (family === 'search_list') {
    const groups = new Map();
    const samples = [];
    const errors = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/\b(ERROR|FATAL|Exception|AccessDenied|UnauthorizedAccess)\b/i.test(line)) {
        pushUniqueBounded(errors, line, 4, 140);
        continue;
      }
      const grepMatch = line.match(/^((?:[A-Za-z]:)?[./\\\w-]+?\.[a-zA-Z0-9]{1,8}):(\d+):(.*)$/);
      if (grepMatch) {
        const key = grepMatch[1];
        if (!groups.has(key)) groups.set(key, { count: 0, first: `L${grepMatch[2]}: ${grepMatch[3].trim()}` });
        groups.get(key).count += 1;
      } else {
        pushUniqueBounded(samples, line, 12, 140);
      }
    }
    const rawBytes = Buffer.byteLength(String(rawOutput || ''), 'utf8');
    const out = [
      `[FTS5 Compressed CLI Output] cmd="${String(command).slice(0, 80)}" exit_code=${exitCode} raw_lines=${lines.length} raw_bytes=${rawBytes}`,
      `Search/List Summary (${groups.size} matched file(s), ${samples.length} other line(s)):`
    ];
    for (const e of errors) out.push(`  ! ${e}`);
    let shown = 0;
    for (const [fileKey, info] of groups.entries()) {
      shown += 1;
      if (shown > 10) {
        out.push(`  ... +${groups.size - 10} more matched files indexed`);
        break;
      }
      out.push(`  ${fileKey} (${info.count}): ${info.first}`.slice(0, 140));
    }
    if (groups.size === 0) {
      for (const s of samples.slice(0, 10)) out.push(`  ${s}`);
      if (lines.length > 10) out.push(`  ... +${lines.length - 10} more lines indexed`);
    }
    const bounded = out.slice(0, Math.max(1, maxLines - 1));
    bounded.push(queryHandleLine);
    return bounded.slice(0, maxLines).join('\n');
  }

  if (family === 'generic_cli') {
    const errors = [];
    const nonEmpty = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (
        /\b(ERROR|FATAL|WARN|WARNING|Exception|AssertionError|TypeError|ReferenceError|SyntaxError|ERR!|FAILED|fail)\b/i.test(line) ||
        /^(?:ℹ\s*(?:tests|suites|pass|fail)\b|#\s*(?:tests|suites|pass|fail)\b)/i.test(line)
      ) {
        pushUniqueBounded(errors, line, 10, 240);
      }
      nonEmpty.push(line);
    }
    const rawBytes = Buffer.byteLength(String(rawOutput || ''), 'utf8');
    const out = [
      `[FTS5 Compressed CLI Output] cmd="${String(command).slice(0, 80)}" exit_code=${exitCode} raw_lines=${lines.length} raw_bytes=${rawBytes}`,
      `Diagnostics & Head/Tail Preview (${errors.length} error/warn line(s)):`
    ];
    for (const e of errors) out.push(`  ${e}`);
    for (const h of nonEmpty.slice(0, 5)) pushUniqueBounded(out, `  ${h}`, maxLines - 1, 140);
    if (nonEmpty.length > 5) {
      for (const t of nonEmpty.slice(-5)) pushUniqueBounded(out, `  ${t}`, maxLines - 1, 140);
    }
    const bounded = out.slice(0, Math.max(1, maxLines - 1));
    bounded.push(queryHandleLine);
    return bounded.slice(0, maxLines).join('\n');
  }

  const failingTests = [];
  const fileLineTraces = [];
  const assertionLines = [];
  const summaryLines = [];
  const warningLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (
      /^(FAILED|FAIL|✖|✗|--- FAIL:)\s+/.test(line) ||
      /^_{3,}\s+.+\s+_{3,}$/.test(line) ||
      /^test\s+[\w:./-]+\s+\.\.\.\s+FAILED/i.test(line) ||
      /^FAIL\t\S+/.test(line)
    ) {
      const cleaned = line.replace(/^_{3,}\s*|\s*_{3,}$/g, '').trim();
      pushUniqueBounded(failingTests, cleaned, 6, 120);
    }

    if (
      /^(?:ℹ\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|#\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|ok)\b|Tests?:|Test Suites?:|Test Files?:|Ran\s+\d+\s+tests?|test result:|===+\s+\d+\s+(?:passed|failed)|\d+\s+(?:passed|passing|failed|failing)\b|PASS(?:\s+\S+)?$|ok\s+\S+\s+[\d.]+s)/i.test(
        line
      )
    ) {
      pushUniqueBounded(summaryLines, line, 8, 200);
    }

    if (/\b(?:WARN|WARNING)\b[:\s]/i.test(line)) {
      pushUniqueBounded(warningLines, line, 4, 240);
    }

    if (
      /\b[A-Za-z0-9_./\\-]+\.(?:py|ts|tsx|js|mjs|cjs|rs|go|java|cpp|c):\d+(?::\d+)?\b/.test(line) ||
      /\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx)\(\d+,\d+\):\s*error\s+TS\d+/i.test(line) ||
      /^\d+:\d+\s+(?:error|warning)\s+/i.test(line) ||
      /\berror\[E\d+\]:/i.test(line) ||
      (family === 'lint_build' && /^[A-Za-z0-9_./\\-]+\.(?:py|ts|tsx|js|mjs|cjs|rs|go|jsx)$/.test(line))
    ) {
      pushUniqueBounded(fileLineTraces, line, 9, 140);
    }

    if (/^(E\s+|AssertionError:|Error:|Expected\b|Received\b|assert\s+|error\s+)/i.test(line)) {
      pushUniqueBounded(assertionLines, line, 5, 140);
    }
  }

  const out = [];
  out.push(`[FTS5 Compressed CLI Output] cmd="${command}" exit_code=${exitCode} raw_lines=${lines.length}`);
  if (failingTests.length === 0 && Number(exitCode) === 0) {
    out.push('Result: PASS (0 failing tests)');
    if (warningLines.length > 0) {
      out.push(`Warnings (${warningLines.length}):`);
      for (const w of warningLines) out.push(`  ${w}`);
    }
    out.push('Test Summary:');
    if (summaryLines.length > 0) {
      for (const s of summaryLines) out.push(`  ${s}`);
    } else if (fileLineTraces.length > 0) {
      for (const tr of fileLineTraces.slice(0, 8)) out.push(`  ${tr}`);
    } else {
      for (const tailLine of lines.slice(-6)) {
        if (tailLine.trim()) out.push(`  ${tailLine.trim().slice(0, 140)}`);
      }
    }
  } else {
    out.push(`Failing Tests (${failingTests.length}):`);
    if (failingTests.length > 0) {
      for (const ft of failingTests.slice(0, 6)) {
        out.push(`  - ${ft}`);
      }
    } else {
      out.push(`  - (No structured test header matched; see tracebacks below)`);
    }

    out.push(`File:Line Tracebacks & Assertions:`);
    const combinedTraces = [...fileLineTraces, ...assertionLines].slice(0, summaryLines.length > 0 ? 8 : 10);
    if (combinedTraces.length > 0) {
      for (const tr of combinedTraces) {
        out.push(`  ${tr}`);
      }
    } else {
      for (const tailLine of lines.slice(-6)) {
        if (tailLine.trim()) out.push(`  ${tailLine.trim().slice(0, 140)}`);
      }
    }
    if (warningLines.length > 0) {
      out.push(`Warnings (${warningLines.length}):`);
      for (const w of warningLines.slice(0, 2)) out.push(`  ${w}`);
    }
    if (summaryLines.length > 0) {
      out.push('Test Summary:');
      for (const s of summaryLines.slice(0, 4)) out.push(`  ${s}`);
    }
  }

  const bounded = out.slice(0, Math.max(1, maxLines - 1));
  bounded.push(queryHandleLine);
  return bounded.slice(0, maxLines).join('\n');
}

/**
 * Compresses CLI output (>40 lines OR >=4,096 bytes) into `tool_logs_fts5.db` and returns
 * a <=25-line summary synchronously so both `PostToolUse` hooks and async wrappers share one engine.
 * Fails open (returns rawOutput) if any exception is thrown.
 */
export function compressCliOutputFts5Sync({
  sessionId = 'default-session',
  turnId = 'turn-1',
  command = 'pytest',
  exitCode = 1,
  rawOutput = '',
  dbPath = null,
  homeDir = getHomeDir(),
  DatabaseSync = null,
  forceCompress = false,
  recordLedger = true,
  minBytes = 0,
  minTokensSaved = 0
} = {}) {
  const rawStr = String(rawOutput || '');
  const rawLines = rawStr.split(/\r?\n/);
  const rawBytes = Buffer.byteLength(rawStr, 'utf8');
  const rawTokens = Math.ceil(rawStr.length / 4);
  const meetsMinBytes = minBytes <= 0 || rawBytes >= Number(minBytes);
  const meetsSizeThreshold =
    meetsMinBytes &&
    (rawLines.length > FTS5_COMPRESSOR_CONSTANTS.MIN_LINES_TO_COMPRESS ||
      rawBytes >= FTS5_COMPRESSOR_CONSTANTS.MIN_BYTES_TO_COMPRESS);

  if (!forceCompress && (!meetsSizeThreshold || !isCompressibleCliCommand(command))) {
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
    db = openLocalHorizonDb(resolvedDbPath, { readOnly: false, DatabaseSync });

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
    if (!forceCompress && summary.length >= rawStr.length) {
      return {
        compressed: false,
        failOpen: false,
        dbPath: resolvedDbPath,
        output: rawStr,
        lineCount: rawLines.length,
        rawTokens,
        compressedTokens: rawTokens,
        tokensSaved: 0,
        reductionPct: 0,
        turnId: String(turnId),
        queryHandle: null
      };
    }
    const summaryLines = summary.split(/\r?\n/);
    const compressedTokens = Math.ceil(summary.length / 4);
    const tokensSaved = Math.max(0, rawTokens - compressedTokens);
    if (!forceCompress && minTokensSaved > 0 && tokensSaved < Number(minTokensSaved)) {
      return {
        compressed: false,
        failOpen: false,
        dbPath: resolvedDbPath,
        output: rawStr,
        lineCount: rawLines.length,
        rawTokens,
        compressedTokens: rawTokens,
        tokensSaved: 0,
        reductionPct: 0,
        turnId: String(turnId),
        queryHandle: null
      };
    }
    const reductionPct = rawTokens > 0
      ? Number(((tokensSaved / rawTokens) * 100).toFixed(1))
      : 0;

    if (recordLedger && tokensSaved > 0 && !DatabaseSync) {
      try {
        const ledgerDbPath = path.join(path.dirname(resolvedDbPath), 'saved_quota_ledger.sqlite');
        const ledger = new SavedQuotaReceiptLedger({ homeDir, dbPath: ledgerDbPath });
        ledger.recordSaving({
          sessionId: String(sessionId),
          eventType: SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED,
          tokensSaved,
          rawBytesSaved: Math.max(0, rawBytes - Buffer.byteLength(summary, 'utf8')),
          dedupeKey: `fts5:${sessionId}:${turnId}:${command}`,
          detail: `FTS5 compressed "${String(command).slice(0, 60)}" (${rawLines.length} -> ${summaryLines.length} lines)`
        });
      } catch (err) {
        void err;
      }
    }

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
    try {
      if (db) db.close();
    } catch (closeErr) {
      void closeErr;
    }
  }
}

/**
 * Async wrapper for `compressCliOutputFts5Sync`.
 */
export async function compressCliOutputFts5(options = {}) {
  return compressCliOutputFts5Sync(options);
}

/**
 * Searches archived raw CLI output inside `tool_logs_fts5.db` (`agy-log-search <turn_id> "<keyword>"`).
 */
export async function searchToolLogsFts5(dbPath, {
  turnId = '',
  keyword = '',
  limit = 10,
  homeDir = getHomeDir(),
  DatabaseSync = null
} = {}) {
  const resolvedDbPath = dbPath || getDefaultToolLogsDbPath(homeDir);
  if (!fs.existsSync(resolvedDbPath)) {
    return { hits: [], matchedLines: [] };
  }

  let db = null;
  try {
    db = openLocalHorizonDb(resolvedDbPath, { readOnly: true, DatabaseSync });

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
            text: lines[i],
            source: 'tool_logs'
          });
          if (matchedLines.length >= 25) break;
        }
      }
      if (matchedLines.length >= 25) break;
    }

    return { hits: rows, matchedLines };
  } catch (err) {
    void err;
    return { hits: [], matchedLines: [] };
  } finally {
    try {
      if (db) db.close();
    } catch (closeErr) {
      void closeErr;
    }
  }
}

/**
 * Searches BOTH `tool_logs_fts5.db` and workspace `.ctxtop/cache/artifacts_fts5.db` (plus JSONL fallback)
 * in strictly read-only mode.
 */
export async function searchOffloadedContextFts5({
  turnId = '',
  keyword = '',
  cwd = process.cwd(),
  homeDir = getHomeDir(),
  dbPath = null,
  limit = 10,
  DatabaseSync = null
} = {}) {
  const toolLogsRes = await searchToolLogsFts5(dbPath, {
    turnId,
    keyword,
    limit,
    homeDir,
    DatabaseSync
  });

  const artifactHits = [];
  const artifactLines = [];
  const cacheDir = path.join(path.resolve(cwd), '.ctxtop', 'cache');
  const artifactsDbPath = path.join(cacheDir, 'artifacts_fts5.db');
  const cleanKeyword = String(keyword || '').replace(/[^A-Za-z0-9_./:-]/g, ' ').trim();
  const kwLower = String(keyword || '').toLowerCase();

  if (fs.existsSync(artifactsDbPath)) {
    let artDb = null;
    try {
      artDb = openLocalHorizonDb(artifactsDbPath, { readOnly: true, DatabaseSync });
      const rows = cleanKeyword
        ? artDb.prepare('SELECT id, tool, content, filePath FROM artifacts WHERE artifacts MATCH ? LIMIT ?')
            .all(cleanKeyword.split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(' AND '), Math.max(1, limit))
        : artDb.prepare('SELECT id, tool, content, filePath FROM artifacts LIMIT ?').all(Math.max(1, limit));
      for (const r of rows) {
        if (turnId && String(r.id) !== String(turnId)) continue;
        artifactHits.push(r);
        const lines = String(r.content || '').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!kwLower || lines[i].toLowerCase().includes(kwLower)) {
            artifactLines.push({
              turnId: r.id,
              lineNumber: i + 1,
              text: lines[i],
              source: 'artifacts',
              tool: r.tool,
              filePath: r.filePath
            });
            if (artifactLines.length >= 25) break;
          }
        }
        if (artifactLines.length >= 25) break;
      }
    } catch (artErr) {
      void artErr;
    } finally {
      try {
        if (artDb) artDb.close();
      } catch (closeErr) {
        void closeErr;
      }
    }
  } else {
    const jsonlPath = path.join(cacheDir, 'artifacts_index.jsonl');
    if (fs.existsSync(jsonlPath)) {
      try {
        const rows = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean);
        for (const rawLine of rows) {
          const rec = JSON.parse(rawLine);
          if (turnId && String(rec.id) !== String(turnId)) continue;
          if (!kwLower || String(rec.snippet || '').toLowerCase().includes(kwLower)) {
            artifactHits.push(rec);
            artifactLines.push({
              turnId: rec.id,
              lineNumber: 1,
              text: String(rec.snippet || '').slice(0, 140),
              source: 'artifacts_jsonl',
              tool: rec.tool
            });
          }
          if (artifactLines.length >= limit) break;
        }
      } catch (jsonlErr) {
        void jsonlErr;
      }
    }
  }

  const combinedMatchedLines = [...toolLogsRes.matchedLines, ...artifactLines].slice(0, Math.max(1, Math.min(50, limit * 5)));
  return {
    ok: true,
    toolLogHits: toolLogsRes.hits.length,
    artifactHits: artifactHits.length,
    totalHits: toolLogsRes.hits.length + artifactHits.length,
    hits: [...toolLogsRes.hits, ...artifactHits],
    matchedLines: combinedMatchedLines
  };
}

/**
 * Returns read-only counts of indexed tool logs and offloaded artifacts.
 */
export function getOffloadIndexStats({ cwd = process.cwd(), homeDir = getHomeDir(), dbPath = null, DatabaseSync = null } = {}) {
  const resolvedDbPath = dbPath || getDefaultToolLogsDbPath(homeDir);
  const stats = {
    indexedToolLogs: 0,
    indexedArtifacts: 0,
    dbExists: fs.existsSync(resolvedDbPath),
    dbPath: resolvedDbPath
  };

  if (stats.dbExists) {
    const toolStats = getFts5CompressionStats(resolvedDbPath, { DatabaseSync, homeDir });
    stats.indexedToolLogs = Number(toolStats.logCount || 0);
  }

  const cacheDir = path.join(path.resolve(cwd), '.ctxtop', 'cache');
  const artifactsDbPath = path.join(cacheDir, 'artifacts_fts5.db');
  if (fs.existsSync(artifactsDbPath)) {
    let artDb = null;
    try {
      artDb = openLocalHorizonDb(artifactsDbPath, { readOnly: true, DatabaseSync });
      const row = artDb.prepare('SELECT count(*) as count FROM artifacts').get();
      stats.indexedArtifacts = Number(row?.count || 0);
    } catch (err) {
      void err;
    } finally {
      try {
        if (artDb) artDb.close();
      } catch (closeErr) {
        void closeErr;
      }
    }
  } else {
    const jsonlPath = path.join(cacheDir, 'artifacts_index.jsonl');
    if (fs.existsSync(jsonlPath)) {
      try {
        stats.indexedArtifacts = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean).length;
      } catch (err) {
        void err;
      }
    }
  }

  return stats;
}

/**
 * Measures the total tokens saved across all FTS5 compressed tool logs.
 * Opens the tool_logs SQLite database strictly read-only and queries row counts and token savings.
 */
export function getFts5CompressionStats(dbPath = null, { DatabaseSync = null, homeDir = getHomeDir() } = {}) {
  const resolvedDbPath = dbPath || getDefaultToolLogsDbPath(homeDir);
  if (!fs.existsSync(resolvedDbPath)) {
    return {
      active: true,
      logCount: 0,
      savedTokens: 0,
      formattedSavedK: '0.0k'
    };
  }

  let db = null;
  try {
    db = openLocalHorizonDb(resolvedDbPath, { readOnly: true, DatabaseSync });
    // Approximate saved tokens by measuring raw output length vs summary length (saving ~75-90% of raw output)
    const row = db.prepare(`
      SELECT count(*) as count, coalesce(sum(length(raw_output)), 0) as totalBytes
      FROM tool_logs
    `).get();

    const count = Number(row?.count || 0);
    const totalBytes = Number(row?.totalBytes || 0);
    // Raw tokens ~ bytes / 4. Summary is capped at 25 lines (~1200 bytes / 300 tokens) per log.
    const rawTokensEst = Math.ceil(totalBytes / 4);
    const summaryTokensEst = count * 300;
    const savedTokens = Math.max(0, rawTokensEst - summaryTokensEst);
    const formattedSavedK = `${(savedTokens / 1000).toFixed(1)}k`;

    return {
      active: true,
      logCount: count,
      savedTokens,
      formattedSavedK
    };
  } catch (err) {
    void err;
    return {
      active: true,
      logCount: 0,
      savedTokens: 0,
      formattedSavedK: '0.0k'
    };
  } finally {
    try {
      if (db) db.close();
    } catch (closeErr) {
      void closeErr;
    }
  }
}
