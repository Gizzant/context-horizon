/**
 * @file src/engine-node/offloader/tool_offloader.mjs
 * Lossless PostToolUse >4k Artifact Offloader with FTS5 Indexing.
 *
 * Replaces oversized non-read tool dumps (>4k tokens) with error-preserving summaries
 * while STRICTLY preserving 100% of workspace read/edit operations (never offloaded!).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isNodeSqliteAvailable, getDatabaseSyncClass } from '../db/probe.mjs';

export const CRITICAL_ERROR_REGEX = /(Error|Exception|FAIL|error\[E\d+\]|panic:|ERR!|ERESOLVE|AssertionError|SyntaxError)/i;

const WORKSPACE_READ_TOOLS = /^(Read|read_file|view_file|View|Edit|edit_file|Write|write_file|write_to_file|replace_file_content|MultiEdit|NotebookEdit)$/i;

/**
 * Returns true when tool is a workspace read or edit tool that must NEVER be offloaded.
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function isWorkspaceReadTool(toolName = '') {
  let cleaned = String(toolName || '').trim();
  if (!cleaned) return false;
  cleaned = cleaned.replace(/^(?:default_api:|mcp__[a-zA-Z0-9_-]+__)/i, '');
  return WORKSPACE_READ_TOOLS.test(cleaned);
}

/**
 * Strips ANSI escape sequences from text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text = '') {
  return String(text || '').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Estimates token count from string length (roughly 4 chars per token).
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text = '') {
  const len = String(text || '').length;
  return Math.ceil(len / 4);
}

/**
 * Indexes an offloaded artifact into SQLite FTS5 table if available,
 * or appends to a JSONL fallback transcript.
 *
 * @param {object} record
 * @param {string} record.id
 * @param {string} record.tool
 * @param {string} record.content
 * @param {string} record.filePath
 * @param {object} [options={}]
 */
export function indexArtifactRecord(record, options = {}) {
  const ctxtopDir = options.ctxtopDir || path.resolve(process.cwd(), '.ctxtop');
  const cacheDir = path.join(ctxtopDir, 'cache');

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (_err) {
    // Directory creation failure handled
  }

  // 1. Try SQLite FTS5 index if node:sqlite available
  if (!options.forceJsonl && isNodeSqliteAvailable()) {
    try {
      const DatabaseSync = getDatabaseSyncClass();
      const ftsDbPath = path.join(cacheDir, 'artifacts_fts5.db');
      const db = new DatabaseSync(ftsDbPath);
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS artifacts USING fts5(id, tool, content, filePath);
        `);
        const stmt = db.prepare('INSERT INTO artifacts(id, tool, content, filePath) VALUES (?, ?, ?, ?)');
        stmt.run(record.id, record.tool, record.content, record.filePath);
        db.close();
        return;
      } catch (_err) {
        try { db.close(); } catch (_closeErr) { /* ignore */ }
      }
    } catch (_err) {
      // Fall through to JSONL fallback
    }
  }

  // 2. Fallback to JSONL append
  try {
    const jsonlPath = path.join(cacheDir, 'artifacts_index.jsonl');
    const line = JSON.stringify({
      id: record.id,
      tool: record.tool,
      filePath: record.filePath,
      timestamp: Date.now(),
      snippet: record.content.slice(0, 300)
    }) + '\n';
    fs.appendFileSync(jsonlPath, line, 'utf8');
  } catch (_err) {
    // Graceful fallback
  }
}

/**
 * Offloads tool result if eligible and exceeding token ceiling (>4k tokens),
 * strictly preserving workspace read tools.
 *
 * @param {string} toolName - Name of the tool invoked
 * @param {string} output - Tool stdout / string payload
 * @param {object} [options={}]
 * @param {number} [options.tokenThreshold=4000] - Token threshold for offloading
 * @param {string} [options.artifactDir] - Directory to persist full offloaded artifacts
 * @returns {{
 *   eligible: boolean,
 *   offloaded: boolean,
 *   output: string,
 *   sha256?: string,
 *   artifactPath?: string,
 *   originalTokens?: number,
 *   summaryTokens?: number,
 *   preservedErrorLines?: number
 * }}
 */
export function offloadToolResult(toolName, output, options = {}) {
  const rawOutput = String(output ?? '');

  // INVARIANT: Workspace read/edit operations are strictly NEVER offloaded!
  if (isWorkspaceReadTool(toolName)) {
    return {
      eligible: false,
      offloaded: false,
      output: rawOutput
    };
  }

  const tokenThreshold = options.tokenThreshold || 4000;
  const estimatedTokens = estimateTokens(rawOutput);

  // If payload does not exceed threshold, return untouched
  if (estimatedTokens <= tokenThreshold) {
    return {
      eligible: true,
      offloaded: false,
      output: rawOutput,
      originalTokens: estimatedTokens
    };
  }

  // Payload > 4k tokens: proceed to lossless offload
  const cleaned = stripAnsi(rawOutput);
  const sha256 = crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex');
  const shortId = sha256.slice(0, 12);

  const ctxtopDir = options.ctxtopDir || path.resolve(process.cwd(), '.ctxtop');
  const artifactDir = options.artifactDir || path.join(ctxtopDir, 'cache', 'artifacts');
  const artifactFile = `ah_${sha256}.txt`;
  const artifactPath = path.join(artifactDir, artifactFile);

  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(artifactPath, cleaned, 'utf8');
  } catch {
    // If writing artifact fails, return raw output fail-open
    return {
      eligible: true,
      offloaded: false,
      output: rawOutput,
      originalTokens: estimatedTokens
    };
  }

  // Index into FTS5
  indexArtifactRecord({
    id: `ah_${shortId}`,
    tool: toolName,
    content: cleaned,
    filePath: artifactPath
  }, options);

  // Extract head lines and 100% of critical error lines
  const allLines = cleaned.split(/\r?\n/);
  const headLines = allLines.slice(0, 3);
  const errorLines = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (CRITICAL_ERROR_REGEX.test(line)) {
      errorLines.push(`[L${i + 1}] ${line.trim()}`);
    }
  }

  // Build compact, error-preserving summary (strictly <= 25 lines)
  const summaryParts = [
    `[Artifact Offloaded: ah_${shortId} (${allLines.length} lines, ~${estimatedTokens} tokens)]`,
    `Artifact saved to: ${artifactPath}`,
    '--- Sample Output (Head) ---',
    ...headLines
  ];

  if (errorLines.length > 0) {
    summaryParts.push('--- Preserved Critical Errors ---');
    const cappedErrors = errorLines.slice(0, 12);
    summaryParts.push(...cappedErrors);
    if (errorLines.length > 12) {
      summaryParts.push(`... (+${errorLines.length - 12} additional error lines preserved in artifact)`);
    }
  }

  summaryParts.push('--- Inspection Pointer ---');
  summaryParts.push(`To query this artifact: ctxtop search "ah_${shortId}"`);

  const summaryText = summaryParts.join('\n');
  const summaryTokens = estimateTokens(summaryText);

  return {
    eligible: true,
    offloaded: true,
    output: summaryText,
    sha256,
    artifactPath,
    originalTokens: estimatedTokens,
    summaryTokens,
    preservedErrorLines: errorLines.length
  };
}

export default {
  isWorkspaceReadTool,
  stripAnsi,
  estimateTokens,
  indexArtifactRecord,
  offloadToolResult,
  CRITICAL_ERROR_REGEX
};
