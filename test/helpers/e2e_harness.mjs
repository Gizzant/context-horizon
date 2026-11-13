/**
 * @file test/helpers/e2e_harness.mjs
 * End-to-End Test Harness for Highbeam v4.0 (`ctxtop`)
 * 
 * Pure ESM module with ZERO runtime and ZERO dev external dependencies.
 * Built strictly on Node.js native modules:
 *   node:assert/strict, node:fs, node:path, node:os, node:net, node:crypto, node:url
 * 
 * Exports 10 production-grade sub-harnesses:
 *  1. Runtime Probing & Dynamic Fallback (`detectRuntimeEnv`, `isSqliteAvailable`, etc.)
 *  2. Ephemeral Sandbox Workspace Manager (`createTempWorkspace`, `createIsolatedTestSandbox`, etc.)
 *  3. USTF v1 Trajectory Builder & Validator (`createMockUSTFTrajectory`, `validateUSTFv1`, etc.)
 *  4. Multi-Host Session Transcript Generators (`createAntigravityJsonl`, `createClaudeCodeJsonl`, etc.)
 *  5. Mock Database Fixture & Dual-Mode Store (`createMockDatabaseFixture`, `getMockDatabaseClient`, etc.)
 *  6. Micro-IPC Hook Bridge Harness (`startMockIpcServer`, `sendIpcMessage`, `simulateCliFallback`, etc.)
 *  7. Control Plane Latch Simulator (`writeControlLatch`, `readControlLatch`)
 *  8. Token Economics & Math Verifiers (`calculateBreakEvenCStar`, `verifyRetentionRadarDiff`, etc.)
 *  9. Zero-Dependency AST & Mod Law Compliance Gate (`checkModLaws`, `checkZeroRuntimeDeps`, etc.)
 * 10. UI & Invariant Assertions (`assertPlainTextCompact`, `assertActiveSourceProtected`, etc.)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 1. Runtime Environment & Dynamic Probing
// ============================================================================

/**
 * Probes the active Node.js execution environment and host OS.
 * @returns {{
 *   nodeVersion: string,
 *   major: number,
 *   minor: number,
 *   isNode20: boolean,
 *   isNode22Plus: boolean,
 *   platform: NodeJS.Platform,
 *   isWindows: boolean
 * }}
 */
export function detectRuntimeEnv() {
  const version = process.versions.node;
  const parts = version.split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const isNode20 = major === 20;
  const isNode22Plus = major > 22 || (major === 22 && minor >= 5);

  return {
    nodeVersion: version,
    major,
    minor,
    isNode20,
    isNode22Plus,
    platform: process.platform,
    isWindows: process.platform === 'win32'
  };
}

let _cachedSqliteAvailable = undefined;

/**
 * Dynamically probes if native `node:sqlite` is available in this runtime
 * without causing syntax errors or top-level crash on Node 20 LTS.
 * @returns {Promise<boolean>}
 */
export async function isSqliteAvailable() {
  if (_cachedSqliteAvailable !== undefined) {
    return _cachedSqliteAvailable;
  }
  try {
    const mod = await import('node:sqlite');
    _cachedSqliteAvailable = Boolean(mod.DatabaseSync || mod.default?.DatabaseSync);
  } catch {
    _cachedSqliteAvailable = false;
  }
  return _cachedSqliteAvailable;
}

/**
 * Resets the cached SQLite availability probe result (useful for test isolation).
 */
export function resetSqliteProbeCache() {
  _cachedSqliteAvailable = undefined;
}

// ============================================================================
// 2. Ephemeral Sandbox Workspace Manager
// ============================================================================

/**
 * Robustly deletes a directory tree on Windows and POSIX, retrying on transient
 * file locking delays (EBUSY / EPERM).
 * @param {string} dir
 */
/**
 * Robustly deletes a directory tree on Windows and POSIX, retrying on transient
 * file locking delays (EBUSY / EPERM) and proactively stripping Windows read-only attributes.
 * @param {string} dir
 */
export function cleanupTempWorkspace(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      if (process.platform === 'win32' && attempt > 0) {
        // Proactively clear read-only file attributes that git can set on object files
        try {
          const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
          for (const entry of entries) {
            try {
              const fullPath = path.join(entry.parentPath || dir, entry.name);
              fs.chmodSync(fullPath, 0o666);
            } catch {}
          }
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (err) {
      if (attempt === 11) {
        // Last attempt failed; ignore to prevent failing tests on benign Windows temp locks
      } else {
        // Synchronous backoff with progressive delay
        const delay = 30 + attempt * 20;
        const start = Date.now();
        while (Date.now() - start < delay) {}
      }
    }
  }
}

/**
 * Creates an isolated temporary directory tree for hermetic test execution.
 * @param {object} [options]
 * @param {string} [options.prefix='ctxtop-e2e-']
 * @param {Record<string, string>} [options.files] Initial files to write { 'path/to/file': 'content' }
 * @returns {{
 *   root: string,
 *   wsDir: string,
 *   homeDir: string,
 *   runtimeDir: string,
 *   writeFile: (relPath: string, content: string) => string,
 *   readFile: (relPath: string) => string,
 *   exists: (relPath: string) => boolean,
 *   cleanup: () => void
 * }}
 */
export function createTempWorkspace(options = {}) {
  const prefix = options.prefix || 'ctxtop-e2e-';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wsDir = path.join(root, 'workspace');
  const homeDir = path.join(root, 'home');
  const runtimeDir = path.join(homeDir, '.ctxtop', 'runtime');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const writeFile = (relPath, content) => {
    const fullPath = path.join(wsDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
  };

  const readFile = (relPath) => {
    return fs.readFileSync(path.join(wsDir, relPath), 'utf8');
  };

  const exists = (relPath) => {
    return fs.existsSync(path.join(wsDir, relPath));
  };

  if (options.files) {
    for (const [relPath, content] of Object.entries(options.files)) {
      writeFile(relPath, content);
    }
  }

  const cleanup = () => cleanupTempWorkspace(root);

  return {
    root,
    wsDir,
    homeDir,
    runtimeDir,
    writeFile,
    readFile,
    exists,
    cleanup
  };
}

/**
 * Extended sandbox creator supporting mock Antigravity and Claude directories.
 * @param {object} [options]
 * @param {boolean} [options.withAntigravityDir=false]
 * @param {boolean} [options.withClaudeDir=false]
 * @param {boolean} [options.withWorktree=false]
 */
export function createIsolatedTestSandbox(options = {}) {
  const ws = createTempWorkspace({ prefix: 'ctxtop-sandbox-' });
  const tmpDir = ws.root;
  const homeDir = ws.homeDir;
  const workspaceDir = ws.wsDir;
  const runtimeDir = ws.runtimeDir;

  if (options.withAntigravityDir) {
    const agPluginDir = path.join(workspaceDir, '.antigravity-plugin');
    fs.mkdirSync(agPluginDir, { recursive: true });
  }

  if (options.withClaudeDir) {
    const ccPluginDir = path.join(workspaceDir, '.claude-plugin');
    fs.mkdirSync(ccPluginDir, { recursive: true });
  }

  if (options.withWorktree) {
    const gitDir = path.join(workspaceDir, '.git', 'worktrees', 'worker-1');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'gitdir'), `${workspaceDir}/.git/worktrees/worker-1\n`, 'utf8');
  }

  return {
    tmpDir,
    homeDir,
    workspaceDir,
    runtimeDir,
    cleanup: ws.cleanup
  };
}

// ============================================================================
// 3. USTF v1 Trajectory Builder & Validator
// ============================================================================

/**
 * Creates a mock USTF v1 tool span.
 * @param {object} [options]
 */
export function createMockToolSpan(options = {}) {
  const startMs = options.startMs || Date.now() - 500;
  const durationMs = options.durationMs !== undefined ? options.durationMs : 450;
  const endMs = options.endMs || (startMs + durationMs);

  return {
    toolCallId: options.toolCallId || `tool-${crypto.randomUUID().slice(0, 8)}`,
    toolName: options.toolName || 'read_file',
    startMs,
    endMs,
    durationMs,
    status: options.status || 'ok',
    inputSize: options.inputSize !== undefined ? options.inputSize : 120,
    outputSize: options.outputSize !== undefined ? options.outputSize : 1540,
    isOffloaded: options.isOffloaded || false
  };
}

/**
 * Creates a mock USTF v1 turn object.
 * @param {object} [options]
 */
export function createMockUSTFTurn(options = {}) {
  const turnIndex = options.turnIndex !== undefined ? options.turnIndex : 0;
  const traceId = options.traceId || crypto.randomUUID();
  const sessionId = options.sessionId || 'session-default';
  const agentId = options.agentId || 'agent-main';
  const streamKey = options.streamKey || `${sessionId}::${agentId}`;
  const timestamp = options.timestamp || Date.now();

  const usage = {
    uncached: options.usage?.uncached ?? 1200,
    cacheWrite5m: options.usage?.cacheWrite5m ?? 600,
    cacheWrite1h: options.usage?.cacheWrite1h ?? 0,
    cacheRead: options.usage?.cacheRead ?? 18500,
    thinking: options.usage?.thinking ?? 240,
    output: options.usage?.output ?? 420
  };

  const toolSpans = options.toolSpans || [createMockToolSpan()];

  return {
    turnIndex,
    traceId,
    streamKey,
    parentStepUuid: options.parentStepUuid !== undefined ? options.parentStepUuid : null,
    modelId: options.modelId || 'claude-3-7-sonnet-20250219',
    timestamp,
    usage,
    ttftMs: options.ttftMs !== undefined ? options.ttftMs : 340,
    prefixHash64: options.prefixHash64 || '0123456789abcdef',
    toolSpans,
    worktree: options.worktree || null,
    costUsd: options.costUsd !== undefined ? options.costUsd : 0.0142,
    userPrompt: options.userPrompt || 'Test prompt query',
    assistantResponse: options.assistantResponse || 'Test assistant response'
  };
}

/**
 * Creates a complete mock USTF v1 trajectory with aggregated metrics.
 * @param {object} [options]
 */
export function createMockUSTFTrajectory(options = {}) {
  const sessionId = options.sessionId || `session-${crypto.randomUUID().slice(0, 8)}`;
  const harness = options.harness || 'antigravity';
  const createdAt = options.createdAt || (Date.now() - 120000);
  const turnsCount = options.turnsCount || 1;

  const turns = [];
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCostUsd = 0;
  let totalTtft = 0;

  for (let i = 0; i < turnsCount; i++) {
    const isThinkingDrift = options.withThinkingDrift && i === turnsCount - 1;
    const isOffloaded = options.withOffloadedTools && i === turnsCount - 1;

    const turn = createMockUSTFTurn({
      turnIndex: i,
      sessionId,
      agentId: options.withSwarm ? `agent-${i % 3}` : 'agent-main',
      modelId: options.modelId || 'claude-3-7-sonnet-20250219',
      timestamp: createdAt + (i * 10000),
      usage: {
        uncached: options.cacheState === 'cold' ? 12000 : 1200,
        cacheWrite5m: 500,
        cacheWrite1h: 0,
        cacheRead: options.cacheState === 'bust' ? 0 : 25000,
        thinking: isThinkingDrift ? 8000 : 200,
        output: isThinkingDrift ? 100 : 400
      },
      ttftMs: 320 + (i * 15),
      toolSpans: [
        createMockToolSpan({
          toolName: isOffloaded ? 'bash' : 'read_file',
          outputSize: isOffloaded ? 48000 : 800,
          isOffloaded: Boolean(isOffloaded)
        })
      ],
      worktree: options.worktreeDirty
        ? { branch: 'feat/test', commitSha: 'a1b2c3d4', dirty: true }
        : null
    });

    turns.push(turn);
    const pTokens = turn.usage.uncached + turn.usage.cacheWrite5m + turn.usage.cacheWrite1h + turn.usage.cacheRead;
    const oTokens = turn.usage.output + turn.usage.thinking;
    totalPromptTokens += pTokens;
    totalOutputTokens += oTokens;
    totalCacheRead += turn.usage.cacheRead;
    totalCostUsd += (turn.costUsd || 0);
    totalTtft += turn.ttftMs;
  }

  const cacheHitRatePct = totalPromptTokens > 0
    ? parseFloat(((totalCacheRead / totalPromptTokens) * 100).toFixed(2))
    : 0;

  return {
    version: '1.0.0',
    sessionId,
    harness,
    createdAt,
    updatedAt: Date.now(),
    summary: options.summary || 'E2E Test Universal Session Trajectory',
    worktree: options.worktree || null,
    turns,
    metrics: {
      totalTurns: turns.length,
      totalPromptTokens,
      totalOutputTokens,
      totalCostUsd: parseFloat(totalCostUsd.toFixed(4)),
      cacheHitRatePct,
      avgTtftMs: turns.length > 0 ? Math.round(totalTtft / turns.length) : 0
    }
  };
}

/**
 * Validates a candidate trajectory against strict USTF v1 specification.
 * @param {unknown} trajectory
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateUSTFv1(trajectory) {
  const errors = [];
  if (!trajectory || typeof trajectory !== 'object') {
    return { valid: false, errors: ['Trajectory must be an object'] };
  }

  if (trajectory.version !== '1.0.0') {
    errors.push(`version must be '1.0.0', got '${trajectory.version}'`);
  }

  if (typeof trajectory.sessionId !== 'string' || !trajectory.sessionId.trim()) {
    errors.push('sessionId must be a non-empty string');
  }

  if (!['antigravity', 'claude-code', 'cursor'].includes(trajectory.harness)) {
    errors.push(`Invalid harness: '${trajectory.harness}'`);
  }

  if (typeof trajectory.createdAt !== 'number' || !Number.isFinite(trajectory.createdAt) || trajectory.createdAt <= 0) {
    errors.push('createdAt must be a positive timestamp');
  }

  if (!Array.isArray(trajectory.turns)) {
    errors.push('turns must be an array');
  } else {
    for (let idx = 0; idx < trajectory.turns.length; idx++) {
      const turn = trajectory.turns[idx];
      if (!turn || typeof turn !== 'object') {
        errors.push(`Turn at index ${idx} must be an object`);
        continue;
      }
      if (typeof turn.turnIndex !== 'number' || !Number.isInteger(turn.turnIndex) || turn.turnIndex < 0) {
        errors.push(`Turn ${idx}: turnIndex must be a non-negative integer`);
      }
      if (typeof turn.traceId !== 'string' || !turn.traceId) {
        errors.push(`Turn ${idx}: traceId must be a non-empty string`);
      }
      if (typeof turn.streamKey !== 'string' || !turn.streamKey) {
        errors.push(`Turn ${idx}: streamKey must be a non-empty string`);
      }
      if (!turn.usage || typeof turn.usage !== 'object') {
        errors.push(`Turn ${idx}: usage object required`);
      } else {
        const requiredUsageKeys = ['uncached', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'thinking', 'output'];
        for (const k of requiredUsageKeys) {
          if (typeof turn.usage[k] !== 'number' || !Number.isFinite(turn.usage[k]) || turn.usage[k] < 0) {
            errors.push(`Turn ${idx}: usage.${k} must be a non-negative number`);
          }
        }
      }
      if (typeof turn.ttftMs !== 'number' || !Number.isFinite(turn.ttftMs) || turn.ttftMs < 0) {
        errors.push(`Turn ${idx}: ttftMs must be a non-negative number`);
      }
      if (typeof turn.prefixHash64 !== 'string' || !/^[0-9a-fA-F]{16}$/.test(turn.prefixHash64)) {
        errors.push(`Turn ${idx}: prefixHash64 must be a 16-character hex string`);
      }
      if (!Array.isArray(turn.toolSpans)) {
        errors.push(`Turn ${idx}: toolSpans must be an array`);
      } else {
        for (let sIdx = 0; sIdx < turn.toolSpans.length; sIdx++) {
          const span = turn.toolSpans[sIdx];
          if (!span || typeof span !== 'object') {
            errors.push(`Turn ${idx} Span ${sIdx}: span must be an object`);
            continue;
          }
          if (typeof span.toolCallId !== 'string' || !span.toolCallId) {
            errors.push(`Turn ${idx} Span ${sIdx}: toolCallId must be non-empty`);
          }
          if (!['ok', 'error', 'denied', 'offloaded'].includes(span.status)) {
            errors.push(`Turn ${idx} Span ${sIdx}: invalid status '${span.status}'`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Serializes a USTF v1 trajectory object into formatted JSON.
 * @param {object} trajectory
 * @returns {string}
 */
export function serializeUSTFv1(trajectory) {
  const check = validateUSTFv1(trajectory);
  if (!check.valid) {
    throw new Error(`Cannot serialize invalid USTF v1 trajectory: ${check.errors.join('; ')}`);
  }
  return JSON.stringify(trajectory, null, 2);
}

/**
 * Deserializes and validates a USTF v1 JSON string.
 * @param {string} jsonString
 * @returns {object}
 */
export function deserializeUSTFv1(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Malformed JSON string: ${err.message}`);
  }
  const check = validateUSTFv1(parsed);
  if (!check.valid) {
    throw new Error(`Deserialized object failed USTF v1 schema: ${check.errors.join('; ')}`);
  }
  return parsed;
}

// ============================================================================
// 4. Multi-Host Session Transcript Generators
// ============================================================================

/**
 * Creates a mock Antigravity transcript JSONL file.
 * @param {string} targetDir
 * @param {Array<object>} [turns=[]]
 * @returns {string} File path
 */
export function createAntigravityJsonl(targetDir, turns = []) {
  const logsDir = path.join(targetDir, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript_full.jsonl');

  const defaultTurns = turns.length > 0 ? turns : [
    {
      step_id: 'step-0',
      step_type: 'USER_INPUT',
      status: 'OK',
      timestamp: Date.now() - 5000,
      content: 'Implement feature X'
    },
    {
      step_id: 'step-1',
      step_type: 'MODEL_RESPONSE',
      status: 'OK',
      timestamp: Date.now() - 2000,
      usage: { prompt_tokens: 1500, completion_tokens: 350 },
      content: 'Understood. Editing files now.'
    }
  ];

  const lines = defaultTurns.map(t => JSON.stringify(t)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
  return filePath;
}

/**
 * Creates a mock Claude Code transcript JSONL file representing a DAG session.
 * @param {string} targetDir
 * @param {Array<object>} [events=[]]
 * @returns {string} File path
 */
export function createClaudeCodeJsonl(targetDir, events = []) {
  const filePath = path.join(targetDir, 'claude_session.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const defaultEvents = events.length > 0 ? events : [
    {
      uuid: 'node-root',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'Run tests' },
      timestamp: Date.now() - 4000
    },
    {
      uuid: 'node-child-1',
      parentUuid: 'node-root',
      type: 'assistant',
      message: { role: 'assistant', content: 'Running test runner...' },
      usage: { input_tokens: 2400, cache_read_input_tokens: 18000, output_tokens: 280 },
      timestamp: Date.now() - 1000
    }
  ];

  const lines = defaultEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
  return filePath;
}

/**
 * Creates a mock session database and accompanying files.
 * @param {string} dbDir
 * @param {object} [options]
 */
export async function createMockSessionDatabase(dbDir, options = {}) {
  fs.mkdirSync(dbDir, { recursive: true });
  const sessionId = options.sessionId || crypto.randomUUID();
  const dbPath = path.join(dbDir, `${sessionId}.db`);
  const transcriptJsonlPath = createAntigravityJsonl(dbDir);
  let pbtxtPath = undefined;

  if (options.withPbtxt) {
    const annotDir = path.join(dbDir, 'annotations');
    fs.mkdirSync(annotDir, { recursive: true });
    pbtxtPath = path.join(annotDir, `${sessionId}.pbtxt`);
    fs.writeFileSync(pbtxtPath, `session_id: "${sessionId}"\nstatus: ACTIVE\n`, 'utf8');
  }

  if (await isSqliteAvailable()) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS steps (
        idx INTEGER PRIMARY KEY,
        step_type TEXT,
        status TEXT,
        has_subtrajectory INTEGER,
        metadata TEXT,
        step_payload BLOB
      );
    `);
    const stmt = db.prepare('INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata) VALUES (?, ?, ?, ?, ?)');
    const count = options.stepsCount || 3;
    for (let i = 0; i < count; i++) {
      stmt.run(i, i === 0 ? 'USER_INPUT' : 'MODEL_TURN', 'OK', options.withSubtrajectories ? 1 : 0, JSON.stringify({ turn: i }));
    }
    db.close();
  }

  return {
    dbPath,
    pbtxtPath,
    transcriptJsonlPath,
    cleanup: () => cleanupTempWorkspace(dbDir)
  };
}

// ============================================================================
// 5. Mock Database Fixture & Dual-Mode Store (SQLite + JSONL Fallback)
// ============================================================================

/**
 * Helper to compare values loosely or strictly with SQLite type affinity behavior.
 */
function _valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'string' && !isNaN(Number(b))) {
    return a === Number(b);
  }
  if (typeof b === 'number' && typeof a === 'string' && !isNaN(Number(a))) {
    return Number(a) === b;
  }
  return String(a) === String(b);
}

/**
 * Extracts column value from either direct properties or nested fixture __values.
 */
function _getColValue(record, col) {
  if (!record || typeof record !== 'object') return undefined;
  if (record[col] !== undefined) return record[col];
  if (record.__values && record.__values[col] !== undefined) return record.__values[col];
  return undefined;
}

/**
 * Executes a SELECT SQL query against an in-memory array of JSONL records.
 * Supports: WHERE (equality, comparison, LIKE, IN, IS NULL), ORDER BY, LIMIT, and SELECT projections.
 */
export function executeJsonlQuery(records, sql, params = []) {
  const clean = sql.trim().replace(/;$/, '');
  if (/^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|VACUUM|PRAGMA\s+writable_schema)/i.test(clean)) {
    throw new Error('SQLITE_READONLY: attempt to write a readonly database');
  }

  const paramList = Array.isArray(params) ? [...params] : (params !== undefined ? [params] : []);
  let pIdx = 0;

  // 1. Extract LIMIT from end
  let limit = null;
  let limitIsParam = false;
  let withoutLimit = clean;
  const limitMatch = clean.match(/\s+LIMIT\s+(\d+|\?)(?:\s+OFFSET\s+(\d+|\?))?\s*$/i);
  if (limitMatch) {
    const rawLimit = limitMatch[1];
    if (rawLimit === '?') {
      limitIsParam = true;
    } else {
      limit = Number(rawLimit);
    }
    withoutLimit = clean.slice(0, limitMatch.index).trim();
  }

  // 2. Extract ORDER BY
  let orderBy = null;
  let withoutOrder = withoutLimit;
  const orderMatch = withoutLimit.match(/\s+ORDER\s+BY\s+([a-zA-Z0-9_,\s]+(?:ASC|DESC)?)\s*$/i);
  if (orderMatch) {
    orderBy = orderMatch[1].trim();
    withoutOrder = withoutLimit.slice(0, orderMatch.index).trim();
  }

  // 3. Extract WHERE
  let where = null;
  let withoutWhere = withoutOrder;
  const whereMatch = withoutOrder.match(/\s+WHERE\s+([\s\S]+)$/i);
  if (whereMatch) {
    where = whereMatch[1].trim();
    withoutWhere = withoutOrder.slice(0, whereMatch.index).trim();
  }

  // 4. Extract SELECT ... FROM <table>
  const selectMatch = withoutWhere.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_`"'.]+)/i);
  let table = null;
  let columns = '*';
  if (selectMatch) {
    columns = selectMatch[1].trim();
    table = selectMatch[2].trim().replace(/[`"']/g, '');
  }

  // Filter by table if records contain fixture table metadata
  let filtered = records;
  if (table && records.some(r => r && r.__table !== undefined)) {
    filtered = filtered.filter(r => r && (!r.__table || r.__table === table));
  }

  // Filter by WHERE conditions
  if (where) {
    const conditions = where.split(/\s+AND\s+/i);
    const compiledConditions = conditions.map(cond => {
      const trimmed = cond.trim();

      // IS NULL / IS NOT NULL
      const isNullMatch = trimmed.match(/^([a-zA-Z0-9_`"'.]+)\s+IS\s+(NOT\s+)?NULL$/i);
      if (isNullMatch) {
        const col = isNullMatch[1].replace(/[`"']/g, '');
        const isNot = Boolean(isNullMatch[2]);
        return (r) => {
          const val = _getColValue(r, col);
          return isNot ? (val !== null && val !== undefined) : (val === null || val === undefined);
        };
      }

      // LIKE
      const likeMatch = trimmed.match(/^([a-zA-Z0-9_`"'.]+)\s+LIKE\s+(.+)$/i);
      if (likeMatch) {
        const col = likeMatch[1].replace(/[`"']/g, '');
        const right = likeMatch[2].trim();
        const pattern = right === '?' ? paramList[pIdx++] : right.replace(/^['"]|['"]$/g, '');
        const regex = new RegExp('^' + String(pattern).replace(/[%_]/g, m => m === '%' ? '.*' : '.') + '$', 'i');
        return (r) => regex.test(String(_getColValue(r, col) ?? ''));
      }

      // IN (...)
      const inMatch = trimmed.match(/^([a-zA-Z0-9_`"'.]+)\s+IN\s*\(([^)]+)\)$/i);
      if (inMatch) {
        const col = inMatch[1].replace(/[`"']/g, '');
        const rawItems = inMatch[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        return (r) => {
          const val = _getColValue(r, col);
          return rawItems.some(item => _valuesEqual(val, item));
        };
      }

      // Comparison operators (=, !=, <>, >, >=, <, <=)
      const opMatch = trimmed.match(/^([a-zA-Z0-9_`"'.]+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/);
      if (opMatch) {
        const col = opMatch[1].replace(/[`"']/g, '');
        const op = opMatch[2];
        const right = opMatch[3].trim();
        let targetVal;
        if (right === '?') {
          targetVal = paramList[pIdx++];
        } else if (/^['"].*['"]$/.test(right)) {
          targetVal = right.slice(1, -1);
        } else if (!isNaN(Number(right))) {
          targetVal = Number(right);
        } else {
          targetVal = right;
        }

        return (r) => {
          const val = _getColValue(r, col);
          if (op === '=') return _valuesEqual(val, targetVal);
          if (op === '!=' || op === '<>') return !_valuesEqual(val, targetVal);
          if (op === '>') return val > targetVal;
          if (op === '>=') return val >= targetVal;
          if (op === '<') return val < targetVal;
          if (op === '<=') return val <= targetVal;
          return true;
        };
      }

      return () => true;
    });

    filtered = filtered.filter(r => compiledConditions.every(fn => fn(r)));
  }

  // Resolve parameterized LIMIT if present
  if (limitIsParam) {
    limit = Number(paramList[pIdx++]);
  }

  // Apply ORDER BY
  if (orderBy) {
    const parts = orderBy.trim().split(/\s+/);
    const col = parts[0].replace(/[`"']/g, '');
    const dir = (parts[1] || 'ASC').toUpperCase();
    filtered = [...filtered].sort((a, b) => {
      const valA = _getColValue(a, col);
      const valB = _getColValue(b, col);
      if (valA === valB) return 0;
      if (valA == null) return dir === 'DESC' ? 1 : -1;
      if (valB == null) return dir === 'DESC' ? -1 : 1;
      if (valA < valB) return dir === 'DESC' ? 1 : -1;
      return dir === 'DESC' ? -1 : 1;
    });
  }

  // Apply LIMIT
  if (limit !== null && !isNaN(limit)) {
    filtered = filtered.slice(0, limit);
  }

  // Apply SELECT projections
  if (columns === '*') {
    return filtered;
  }

  const countMatch = columns.match(/^COUNT\s*\(\s*\*\s*\)(?:\s+AS\s+([a-zA-Z0-9_]+))?$/i);
  if (countMatch) {
    const alias = countMatch[1] || 'count(*)';
    return [{ [alias]: filtered.length }];
  }

  const colList = columns.split(',').map(c => {
    const aliasMatch = c.trim().match(/^([a-zA-Z0-9_`"'.]+)(?:\s+AS\s+([a-zA-Z0-9_`"']+))?$/i);
    if (aliasMatch) {
      const rawCol = aliasMatch[1].replace(/[`"']/g, '');
      const alias = (aliasMatch[2] || rawCol).replace(/[`"']/g, '');
      return { rawCol, alias };
    }
    return { rawCol: c.trim(), alias: c.trim() };
  });

  return filtered.map(r => {
    const projected = {};
    for (const { rawCol, alias } of colList) {
      projected[alias] = _getColValue(r, rawCol);
    }
    return projected;
  });
}

/**
 * Pure JSONL Fallback Database Wrapper implementing the identical query API.
 * Guarantees zero write operations (`readOnly: true` invariant).
 */
export class JsonlDatabaseFallbackWrapper {
  /**
   * @param {string} jsonlPath
   * @param {object} options
   */
  constructor(jsonlPath, options = {}) {
    assert.equal(options.readOnly, true, 'Zero-Trust: Database must be opened strictly read-only');
    this.path = jsonlPath;
    this.readOnly = true;
  }

  _load() {
    if (!fs.existsSync(this.path)) return [];
    const content = fs.readFileSync(this.path, 'utf8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // Skip malformed/truncated lines gracefully
        }
      })
      .filter(Boolean);
  }

  all(sqlOrFilter, params = []) {
    const records = this._load();
    if (!sqlOrFilter) return records;
    if (typeof sqlOrFilter === 'function') {
      return records.filter(sqlOrFilter);
    }
    if (typeof sqlOrFilter === 'string') {
      return executeJsonlQuery(records, sqlOrFilter, params);
    }
    return records;
  }

  get(sqlOrFilter, params = []) {
    const records = this._load();
    if (!sqlOrFilter) return records[0] || null;
    if (typeof sqlOrFilter === 'function') {
      return records.find(sqlOrFilter) || null;
    }
    if (typeof sqlOrFilter === 'string') {
      const results = executeJsonlQuery(records, sqlOrFilter, params);
      return results[0] || null;
    }
    return records[0] || null;
  }

  searchFts(query = '', limit = 10) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const records = this._load();
    const matches = [];

    for (const record of records) {
      const text = JSON.stringify(record).toLowerCase();
      if (tokens.every(token => text.includes(token))) {
        matches.push(record);
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  exec() {
    throw new Error('SQLITE_READONLY: attempt to write a readonly database');
  }

  run() {
    throw new Error('SQLITE_READONLY: attempt to write a readonly database');
  }

  close() {
    // No-op for file-based JSONL store
  }
}

/**
 * Creates dual SQLite and JSONL database fixtures.
 * @param {string} targetBase
 * @param {object} [fixtureData]
 */
export async function createMockDatabaseFixture(targetBase, { tables = {}, records = [] } = {}) {
  const dbPath = targetBase.endsWith('.db') ? targetBase : `${targetBase}.db`;
  const jsonlPath = targetBase.endsWith('.jsonl') ? targetBase : `${targetBase}.jsonl`;

  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  const jsonlContent = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, jsonlContent, 'utf8');

  if (await isSqliteAvailable()) {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    for (const [table, schema] of Object.entries(tables)) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${schema});`);
    }
    for (const rec of records) {
      if (rec.__table && rec.__values) {
        const cols = Object.keys(rec.__values).join(', ');
        const placeholders = Object.keys(rec.__values).map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO ${rec.__table} (${cols}) VALUES (${placeholders})`);
        stmt.run(...Object.values(rec.__values));
      }
    }
    db.close();
  }

  return { dbPath, jsonlPath };
}

/**
 * Returns a dual-mode database client. If `forceFallback: true` is passed or
 * `node:sqlite` is unavailable, activates the pure JSONL store.
 * @param {object} options
 */
export async function getMockDatabaseClient({ dbPath, jsonlPath, forceFallback = false, readOnly = true }) {
  assert.equal(readOnly, true, 'Zero-Trust: Database must be opened strictly read-only');

  const sqliteOk = await isSqliteAvailable();
  if (sqliteOk && !forceFallback && dbPath && fs.existsSync(dbPath)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      type: 'sqlite',
      get: (sqlOrFn, params = []) => {
        if (typeof sqlOrFn === 'function') {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
          for (const { name } of tables) {
            const rows = db.prepare(`SELECT * FROM ${name}`).all();
            const match = rows.find(sqlOrFn);
            if (match) return match;
          }
          return null;
        }
        return db.prepare(sqlOrFn).get(...(Array.isArray(params) ? params : [params]));
      },
      all: (sqlOrFn, params = []) => {
        if (typeof sqlOrFn === 'function') {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
          const matches = [];
          for (const { name } of tables) {
            const rows = db.prepare(`SELECT * FROM ${name}`).all();
            matches.push(...rows.filter(sqlOrFn));
          }
          return matches;
        }
        if (!sqlOrFn) {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
          const allRows = [];
          for (const { name } of tables) {
            allRows.push(...db.prepare(`SELECT * FROM ${name}`).all());
          }
          return allRows;
        }
        return db.prepare(sqlOrFn).all(...(Array.isArray(params) ? params : [params]));
      },
      searchFts: (query = '', limit = 10) => {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const matches = [];
        for (const { name } of tables) {
          try {
            const rows = db.prepare(`SELECT * FROM ${name}`).all();
            for (const row of rows) {
              const text = JSON.stringify(row).toLowerCase();
              if (tokens.every(t => text.includes(t))) {
                matches.push(row);
                if (matches.length >= limit) return matches;
              }
            }
          } catch {}
        }
        return matches;
      },
      exec: () => db.exec('INSERT INTO fail VALUES (1)'), // for testing read-only assertion
      close: () => db.close()
    };
  }

  const fallbackPath = jsonlPath || (dbPath ? dbPath.replace(/\.db$/, '.jsonl') : '');
  const wrapper = new JsonlDatabaseFallbackWrapper(fallbackPath, { readOnly: true });
  return {
    type: 'jsonl',
    wrapper,
    get: (sqlOrFn, params = []) => wrapper.get(sqlOrFn, params),
    all: (sqlOrFn, params = []) => wrapper.all(sqlOrFn, params),
    searchFts: (q, limit) => wrapper.searchFts(q, limit),
    exec: () => wrapper.exec(),
    close: () => wrapper.close()
  };
}

/**
 * Asserts that a SQLite database connection or file strictly enforces read-only access.
 * @param {string | object} dbOrPath
 */
export async function assertSqliteReadOnlyEnforced(dbOrPath) {
  if (typeof dbOrPath === 'string') {
    if (await isSqliteAvailable()) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbOrPath, { readOnly: true });
      assert.throws(
        () => db.exec('CREATE TABLE IF NOT EXISTS test_readonly_violation (id INT)'),
        /readonly|read-only/i,
        'Database must reject write operation when opened read-only'
      );
      db.close();
    }
  } else if (dbOrPath && typeof dbOrPath.exec === 'function') {
    assert.throws(
      () => dbOrPath.exec('INSERT INTO fail VALUES (1)'),
      /readonly|read-only/i,
      'Database must reject write operations'
    );
  }
}

/**
 * Asserts that attempting to open a protected host DB in read-write mode is rejected.
 * @param {(p: string, opts: any) => any} openFn
 * @param {string} hostDbPath
 */
export function assertHostDbWriteRejected(openFn, hostDbPath) {
  assert.throws(
    () => openFn(hostDbPath, { readOnly: false }),
    /Zero-Trust SQLite Guard|read-only|readonly/i,
    'Must refuse read-write open on protected host database'
  );
}

// ============================================================================
// 6. Micro-IPC Hook Bridge Harness
// ============================================================================

/**
 * Returns an OS-appropriate IPC socket / pipe address.
 * @param {string} [name='test']
 * @returns {string}
 */
export function getPlatformPipePath(name = 'test') {
  const nonce = crypto.randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ctxtop-${name}-${nonce}`;
  }
  return path.join(os.tmpdir(), `ctxtop-${name}-${nonce}.sock`);
}

/**
 * Starts a mock IPC server simulating the Highbeam daemon.
 * @param {object} [options]
 * @returns {Promise<{
 *   pipePath: string,
 *   server: net.Server,
 *   getRequests: () => Array<{ raw: string, parsed: any, receivedAtMs: number }>,
 *   setDelayMs: (ms: number) => void,
 *   setResponseHandler: (fn: (req: any) => any) => void,
 *   close: () => Promise<void>
 * }>}
 */
export function startMockIpcServer(options = {}) {
  const pipePath = options.pipePath || getPlatformPipePath(options.pipeName || 'server');
  const requests = [];
  let delayMs = options.initialDelayMs || 0;
  let responseHandler = options.responseHandler || ((req) => ({
    jsonrpc: '2.0',
    id: req?.id ?? 1,
    result: { decision: 'allow', reason: 'Mock IPC default allow' }
  }));

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep remainder

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed = null;
          try {
            parsed = JSON.parse(line);
          } catch {}

          requests.push({
            raw: line,
            parsed,
            receivedAtMs: Date.now()
          });

          const respond = () => {
            if (socket.destroyed) return;
            try {
              const res = responseHandler(parsed);
              socket.write(JSON.stringify(res) + '\n');
            } catch (err) {
              socket.write(JSON.stringify({
                jsonrpc: '2.0',
                id: parsed?.id ?? null,
                error: { code: -32603, message: err.message }
              }) + '\n');
            }
          };

          if (delayMs > 0) {
            setTimeout(respond, delayMs);
          } else {
            respond();
          }
        }
      });
    });

    server.listen(pipePath, () => {
      resolve({
        pipePath,
        server,
        getRequests: () => requests,
        setDelayMs: (ms) => { delayMs = ms; },
        setResponseHandler: (fn) => { responseHandler = fn; },
        close: () => stopIpcServer(server, pipePath)
      });
    });

    server.on('error', reject);
  });
}

/**
 * Sends a single JSON-RPC message over IPC and awaits response.
 * @param {string} pipePath
 * @param {object} message
 * @param {object} [options]
 * @returns {Promise<any>}
 */
export function sendIpcMessage(pipePath, message, options = {}) {
  const timeoutMs = options.timeoutMs || 1000;

  return new Promise((resolve, reject) => {
    let timer = null;
    let buffer = '';

    const client = net.connect(pipePath, () => {
      client.write(JSON.stringify(message) + '\n');
    });

    timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`IPC request timed out after ${timeoutMs}ms on ${pipePath}`));
    }, timeoutMs);

    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        clearTimeout(timer);
        client.end();
        const line = buffer.slice(0, newlineIndex).trim();
        try {
          const res = JSON.parse(line);
          resolve(res);
        } catch (err) {
          reject(new Error(`Malformed IPC response: ${err.message}`));
        }
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Stops an active mock IPC server and cleans up POSIX socket files.
 * @param {net.Server} server
 * @param {string} pipePath
 * @returns {Promise<void>}
 */
export function stopIpcServer(server, pipePath) {
  return new Promise((resolve) => {
    server.close(() => {
      if (process.platform !== 'win32' && pipePath && fs.existsSync(pipePath)) {
        try {
          fs.unlinkSync(pipePath);
        } catch {}
      }
      resolve();
    });
  });
}

/**
 * Simulates client connection with automatic fallback to standalone CLI logic
 * if the IPC daemon is offline or exceeds 15ms threshold.
 * @template T
 * @param {string} pipePath
 * @param {() => Promise<T> | T} cliFallbackFn
 * @param {object} [options]
 * @returns {Promise<{ result: any, fallbackTriggered: boolean, latencyMs: number }>}
 */
export async function simulateCliFallback(pipePath, cliFallbackFn, options = {}) {
  const timeoutMs = options.timeoutMs || 15; // 15ms SLA threshold
  const t0 = Date.now();

  try {
    const res = await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: 1, method: 'ping' }, { timeoutMs });
    const latencyMs = Date.now() - t0;
    return {
      result: res,
      fallbackTriggered: false,
      latencyMs
    };
  } catch {
    const fallbackResult = await cliFallbackFn();
    const latencyMs = Date.now() - t0;
    return {
      result: fallbackResult,
      fallbackTriggered: true,
      latencyMs
    };
  }
}

// ============================================================================
// 7. Control Plane Latch Simulator
// ============================================================================

/**
 * Writes execution control state to `~/.ctxtop/runtime/<sessionId>.ctl`.
 * @param {string} runtimeDir
 * @param {string} sessionId
 * @param {'RUNNING' | 'PAUSED' | 'STEP' | 'ABORTED'} [state='RUNNING']
 * @param {string} [reason='']
 * @returns {string} File path written
 */
export function writeControlLatch(runtimeDir, sessionId, state = 'RUNNING', reason = '') {
  const validStates = ['RUNNING', 'PAUSED', 'STEP', 'ABORTED'];
  assert.ok(validStates.includes(state), `Invalid control state: ${state}`);

  fs.mkdirSync(runtimeDir, { recursive: true });
  const ctlPath = path.join(runtimeDir, `${sessionId}.ctl`);
  const payload = {
    state,
    reason,
    updatedAt: Date.now()
  };

  fs.writeFileSync(ctlPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return ctlPath;
}

/**
 * Reads execution control state from `~/.ctxtop/runtime/<sessionId>.ctl`.
 * Returns default RUNNING state if file does not exist.
 * @param {string} runtimeDir
 * @param {string} sessionId
 * @returns {{ state: 'RUNNING' | 'PAUSED' | 'STEP' | 'ABORTED', reason: string, updatedAt: number }}
 */
export function readControlLatch(runtimeDir, sessionId) {
  const ctlPath = path.join(runtimeDir, `${sessionId}.ctl`);
  if (!fs.existsSync(ctlPath)) {
    return { state: 'RUNNING', reason: 'default', updatedAt: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(ctlPath, 'utf8'));
  } catch {
    return { state: 'RUNNING', reason: 'corrupted_fallback', updatedAt: Date.now() };
  }
}

// ============================================================================
// 8. Token Economics & Math Verifiers
// ============================================================================

/**
 * Canonical Anthropic rate cards per 1M tokens for break-even C* calculations.
 * Rates: { output, read, write5m }
 */
export const MODEL_BREAK_EVEN_RATES = Object.freeze({
  'claude-opus-5-5': { output: 20.0, read: 0.2, write5m: 5.0 },
  'claude-sonnet-5-5': { output: 10.0, read: 0.1, write5m: 2.5 },
  'claude-opus-4-6': { output: 25.0, read: 0.5, write5m: 6.25 },
  'claude-sonnet-4-6': { output: 15.0, read: 0.3, write5m: 3.75 },
  'claude-haiku-5-5': { output: 0.5, read: 0.01, write5m: 0.125 },
});

/**
 * Exact algebraic break-even token equation:
 *   C* = [ O * (P_out,curr - P_out,target) ] / [ P_write5m,target - P_read,curr ]
 *
 * Evaluates the token threshold above which switching models costs more in cold
 * cache prefix rewrite than it saves on output tokens.
 *
 * Defaults:
 *   - Current Model: Opus 5.5 ($20/1M out, $0.20/1M read)
 *   - Target Model: Sonnet 5.5 ($10/1M out, $2.50/1M 5m write)
 *   - Expected Output Tokens: 1,500
 *   - Yields: C* = 6,522 tokens dynamically evaluated
 *
 * @param {object|number} [optionsOrOutputTokens={}] Configuration object or expected output tokens
 * @param {object} [maybeRatesCurr] Current model rates { output, read }
 * @param {object} [maybeRatesTarget] Target model rates { output, write5m }
 * @returns {number} Exact break-even prefix tokens C* (integer, 0 for upshifts, Infinity if write <= read)
 */
export function calculateBreakEvenCStar(optionsOrOutputTokens = {}, maybeRatesCurr, maybeRatesTarget) {
  let expectedOutputTokens = 1500;
  let pOutCurr = 20.0;
  let pOutTarget = 10.0;
  let pWrite5mTarget = 2.5;
  let pReadCurr = 0.2;

  if (typeof optionsOrOutputTokens === 'number') {
    expectedOutputTokens = Math.max(0, optionsOrOutputTokens);
    if (maybeRatesCurr && typeof maybeRatesCurr === 'object') {
      pOutCurr = Number(maybeRatesCurr.output ?? maybeRatesCurr.outputPer1M ?? maybeRatesCurr.pOut ?? pOutCurr);
      pReadCurr = Number(maybeRatesCurr.read ?? maybeRatesCurr.readPer1M ?? maybeRatesCurr.pRead ?? pReadCurr);
    }
    if (maybeRatesTarget && typeof maybeRatesTarget === 'object') {
      pOutTarget = Number(maybeRatesTarget.output ?? maybeRatesTarget.outputPer1M ?? maybeRatesTarget.pOut ?? pOutTarget);
      pWrite5mTarget = Number(
        maybeRatesTarget.write5m ??
        maybeRatesTarget.write5mPer1M ??
        maybeRatesTarget.write ??
        maybeRatesTarget.pWrite5m ??
        pWrite5mTarget
      );
    }
  } else if (typeof optionsOrOutputTokens === 'object' && optionsOrOutputTokens !== null) {
    const opts = optionsOrOutputTokens;
    if (opts.expectedOutputTokens !== undefined || opts.O !== undefined) {
      expectedOutputTokens = Math.max(0, Number(opts.expectedOutputTokens ?? opts.O));
    }

    if (opts.currentModel && MODEL_BREAK_EVEN_RATES[opts.currentModel]) {
      const m = MODEL_BREAK_EVEN_RATES[opts.currentModel];
      pOutCurr = m.output;
      pReadCurr = m.read;
    }
    if (opts.targetModel && MODEL_BREAK_EVEN_RATES[opts.targetModel]) {
      const m = MODEL_BREAK_EVEN_RATES[opts.targetModel];
      pOutTarget = m.output;
      pWrite5mTarget = m.write5m;
    }

    const rc = opts.ratesCurr || opts.currentRates;
    if (rc && typeof rc === 'object') {
      pOutCurr = Number(rc.output ?? rc.outputPer1M ?? rc.pOut ?? pOutCurr);
      pReadCurr = Number(rc.read ?? rc.readPer1M ?? rc.pRead ?? pReadCurr);
    }
    const rt = opts.ratesTarget || opts.targetRates;
    if (rt && typeof rt === 'object') {
      pOutTarget = Number(rt.output ?? rt.outputPer1M ?? rt.pOut ?? pOutTarget);
      pWrite5mTarget = Number(
        rt.write5m ??
        rt.write5mPer1M ??
        rt.write ??
        rt.pWrite5m ??
        pWrite5mTarget
      );
    }

    if (opts.pOutCurr !== undefined) pOutCurr = Number(opts.pOutCurr);
    if (opts.pOutTarget !== undefined) pOutTarget = Number(opts.pOutTarget);
    if (opts.pWrite5mTarget !== undefined) pWrite5mTarget = Number(opts.pWrite5mTarget);
    if (opts.pReadCurr !== undefined) pReadCurr = Number(opts.pReadCurr);
  }

  const numerator = expectedOutputTokens * (pOutCurr - pOutTarget);
  const denominator = pWrite5mTarget - pReadCurr;

  if (pOutCurr <= pOutTarget || numerator <= 0) {
    return 0;
  }
  if (denominator <= 0) {
    return Infinity;
  }

  return Math.round(numerator / denominator);
}

/**
 * Verifies byte-offset mutation diffing and 95% prefix cache retention radar.
 * @param {string} [originalText='']
 * @param {string} [mutatedText='']
 * @returns {{
 *   firstDiffOffset: number,
 *   prefixMatchBytes: number,
 *   retentionPct: number,
 *   is95PctRetained: boolean,
 *   grade: 'A' | 'B' | 'C'
 * }}
 */
export function verifyRetentionRadarDiff(originalText = '', mutatedText = '') {
  const bufOrig = Buffer.from(String(originalText ?? ''), 'utf8');
  const bufMut = Buffer.from(String(mutatedText ?? ''), 'utf8');

  let firstDiffOffset = -1;
  const minLen = Math.min(bufOrig.length, bufMut.length);
  let i = 0;
  const chunkSize = 4096;
  while (i + chunkSize <= minLen) {
    if (!bufOrig.subarray(i, i + chunkSize).equals(bufMut.subarray(i, i + chunkSize))) {
      break;
    }
    i += chunkSize;
  }

  for (; i < minLen; i++) {
    if (bufOrig[i] !== bufMut[i]) {
      firstDiffOffset = i;
      break;
    }
  }

  if (firstDiffOffset === -1 && bufOrig.length !== bufMut.length) {
    firstDiffOffset = minLen;
  }

  const prefixMatchBytes = firstDiffOffset === -1 ? bufOrig.length : firstDiffOffset;
  const retentionPct = bufOrig.length === 0
    ? 100
    : parseFloat(((prefixMatchBytes / bufOrig.length) * 100).toFixed(2));

  let grade = 'C';
  if (retentionPct >= 95.0) {
    grade = 'A';
  } else if (retentionPct >= 80.0) {
    grade = 'B';
  }

  return {
    firstDiffOffset,
    prefixMatchBytes,
    retentionPct,
    is95PctRetained: retentionPct >= 95.0,
    grade
  };
}

/**
 * DET-12 Haiku 100k Cliff Breaker sensor.
 * Evaluates prompt token volume against the 100k 5x cost cliff, triggering at >= 98,000 tokens.
 * @param {string} modelId
 * @param {number} promptTokens
 * @returns {{
 *   triggered: boolean,
 *   threshold: number,
 *   action: 'halt' | 'warn' | 'advisory' | 'allow',
 *   reason: string
 * }}
 */
export function checkHaiku100kCliffBreaker(modelId = '', promptTokens = 0) {
  const isHaiku = String(modelId).toLowerCase().includes('haiku');
  const threshold = 98000;

  if (!isHaiku) {
    return {
      triggered: false,
      threshold,
      action: 'allow',
      reason: 'Non-Haiku model; 100k cliff check exempt'
    };
  }

  if (promptTokens >= 100000) {
    return {
      triggered: true,
      threshold,
      action: 'halt',
      reason: `Prompt tokens (${promptTokens}) exceeded 100k 5x cost cliff`
    };
  }

  if (promptTokens >= threshold) {
    return {
      triggered: true,
      threshold,
      action: 'warn',
      reason: `Prompt tokens (${promptTokens}) reached Haiku cliff breaker threshold (${threshold})`
    };
  }

  if (promptTokens >= 90000) {
    return {
      triggered: false,
      threshold,
      action: 'advisory',
      reason: `Prompt tokens (${promptTokens}) approaching 90k advisory boundary`
    };
  }

  return {
    triggered: false,
    threshold,
    action: 'allow',
    reason: `Prompt tokens (${promptTokens}) within safe boundary`
  };
}

/**
 * Formats seconds into MM:SS.
 * @param {number} sec
 * @returns {string}
 */
function formatMmSs(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
}

/**
 * Calculates live Dual-TTL countdown for 5-minute cache TTL and 1-hour billing TTL.
 * @param {number} lastTurnTimestamp
 * @param {number} [now=Date.now()]
 * @param {number} [cacheTtlMs=300000] 5 minutes
 * @param {number} [billingTtlMs=3600000] 1 hour
 * @param {object} [options={}] Optional flags (e.g. { rolling: boolean })
 */
export function calculateDualTtlCountdown(
  lastTurnTimestamp,
  now = Date.now(),
  cacheTtlMs = 300000,
  billingTtlMs = 3600000,
  options = {}
) {
  const elapsedMs = Math.max(0, now - lastTurnTimestamp);
  const cacheRemainingMs = Math.max(0, cacheTtlMs - elapsedMs);

  const isRolling = Boolean(options.rolling);
  const billingRemainingMs = isRolling
    ? (elapsedMs >= billingTtlMs && elapsedMs % billingTtlMs === 0 ? 0 : Math.max(0, billingTtlMs - (elapsedMs % billingTtlMs)))
    : Math.max(0, billingTtlMs - elapsedMs);

  const cacheTtlSec = Math.floor(cacheRemainingMs / 1000);
  const billingTtlSec = Math.floor(billingRemainingMs / 1000);

  return {
    cacheTtlSec,
    billingTtlSec,
    formattedCacheTtl: formatMmSs(cacheTtlSec),
    formattedBillingTtl: formatMmSs(billingTtlSec),
    isCacheExpired: cacheRemainingMs === 0,
    isBillingExpired: elapsedMs >= billingTtlMs
  };
}

/**
 * Partitions session token events into rolling 5-hour billing blocks.
 * @param {Array<{ timestamp: number, costUsd?: number, tokens?: number, subagentId?: string }>} [usageEvents=[]]
 * @param {number} [blockDurationMs=18000000] 5 hours = 5 * 3600 * 1000
 */
export function partitionBillingBlocks(usageEvents = [], blockDurationMs = 5 * 3600 * 1000) {
  if (usageEvents.length === 0) return [];

  const sorted = [...usageEvents].sort((a, b) => a.timestamp - b.timestamp);
  const startTimestamp = sorted[0].timestamp;
  const blocksMap = new Map();

  for (const event of sorted) {
    const blockIndex = Math.floor((event.timestamp - startTimestamp) / blockDurationMs);
    if (!blocksMap.has(blockIndex)) {
      blocksMap.set(blockIndex, {
        blockIndex,
        startTime: startTimestamp + (blockIndex * blockDurationMs),
        endTime: startTimestamp + ((blockIndex + 1) * blockDurationMs),
        totalCostUsd: 0,
        totalTokens: 0,
        eventCount: 0,
        subagentSpend: {}
      });
    }

    const block = blocksMap.get(blockIndex);
    const cost = event.costUsd || 0;
    const tokens = event.tokens || 0;
    const agent = event.subagentId || 'main';

    block.totalCostUsd = parseFloat((block.totalCostUsd + cost).toFixed(4));
    block.totalTokens += tokens;
    block.eventCount += 1;
    block.subagentSpend[agent] = parseFloat(((block.subagentSpend[agent] || 0) + cost).toFixed(4));
  }

  return Array.from(blocksMap.values()).map(b => {
    const durationHours = blockDurationMs / 3600000;
    const burnRateUsdPerHour = parseFloat((b.totalCostUsd / durationHours).toFixed(4));
    const tokensPerMin = Math.round(b.totalTokens / (durationHours * 60));
    return {
      ...b,
      burnRateUsdPerHour,
      tokensPerMin
    };
  });
}

// ============================================================================
// 9. Zero-Dependency AST & Mod Law Compliance Gate
// ============================================================================

/**
 * Checks source code against the 11 static compliance checks for Claude Mod Laws 1–5.
 * @param {string} sourceCode
 * @returns {{ valid: boolean, violations: string[] }}
 */
export function checkModLaws(sourceCode = '') {
  const violations = [];

  // 1. Mod Law 1: Zero node:* imports
  const nodeImportRe = /import\s+.*?\s+from\s+['"]node:[^'"]+['"]/g;
  if (nodeImportRe.test(sourceCode)) {
    violations.push('Check 1 (Mod Law 1): Forbidden static import from node:*');
  }

  // 2. Mod Law 1: No assignment to $
  const dollarAssignRe = /(?:^|[\s;{}])\$\s*=\s*[^=]/g;
  if (dollarAssignRe.test(sourceCode)) {
    violations.push('Check 2 (Mod Law 1): Forbidden assignment to $ identifier');
  }

  // 3. Mod Law 1: No destructuring of $
  const dollarDestructRe = /\{\s*\$\s*\}\s*=/g;
  if (dollarDestructRe.test(sourceCode)) {
    violations.push('Check 3 (Mod Law 1): Forbidden destructuring capture of $');
  }

  // 4. Mod Law 1: No object shorthand { $ }
  const dollarShorthandRe = /\{\s*\$\s*[,}]/g;
  if (dollarShorthandRe.test(sourceCode)) {
    violations.push('Check 4 (Mod Law 1): Forbidden object shorthand { $ }');
  }

  // 5. Mod Law 2: Balanced call scanner (matching parens and braces)
  let parens = 0;
  let braces = 0;
  for (let i = 0; i < sourceCode.length; i++) {
    const c = sourceCode[i];
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    if (parens < 0 || braces < 0) break;
  }
  if (parens !== 0 || braces !== 0) {
    violations.push('Check 5 (Mod Law 2): Unbalanced call scanner parens or braces detected');
  }

  // 6. Mod Law 3: String literal event names in on(...)
  const dynamicOnEventRe = /\.on\s*\(\s*([`"']?)(.*?)\1\s*,/g;
  let onMatch;
  while ((onMatch = dynamicOnEventRe.exec(sourceCode)) !== null) {
    const quote = onMatch[1];
    const eventName = onMatch[2];
    if (!quote || quote === '`' && eventName.includes('${')) {
      violations.push('Check 6 (Mod Law 3): Dynamic or template string event name in on() registration');
    }
  }

  // 7. Mod Law 4: Static ESM imports only, no dynamic imports inside isomorphic code
  const dynamicImportRe = /\bimport\s*\(/g;
  if (dynamicImportRe.test(sourceCode)) {
    violations.push('Check 7 (Mod Law 4): Forbidden dynamic import() inside isomorphic code');
  }

  // 8. Mod Law 5: Fail-closed .catch() handlers on async hook promises
  if (sourceCode.includes('async function') && !sourceCode.includes('.catch(') && !sourceCode.includes('try {')) {
    violations.push('Check 8 (Mod Law 5): Missing fail-closed error handling (.catch or try/catch) in async hook');
  }

  // 9. Mod Law 5: Zero unhandled throw statements in lifecycle hooks
  const unhandledThrowRe = /(?:^|\n)\s*throw\s+new?\s+Error/g;
  if (unhandledThrowRe.test(sourceCode)) {
    violations.push('Check 9 (Mod Law 5): Unhandled throw statement in lifecycle hook');
  }

  // 10. Mod Law 1: No process.cwd() or process.exit() in isomorphic core
  if (/\bprocess\.(cwd|exit)\s*\(/.test(sourceCode)) {
    violations.push('Check 10 (Mod Law 1): Forbidden access to process built-ins in isomorphic core');
  }

  // 11. Mod Law 1: Zero global mutable state assignments
  if (/\bglobalThis\.[a-zA-Z0-9_]+\s*=\s*/.test(sourceCode)) {
    violations.push('Check 11 (Mod Law 1): Forbidden assignment to globalThis');
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

/**
 * Validates that package.json defines exactly zero runtime dependencies.
 * @param {string} [packageJsonPath='package.json']
 * @returns {{ valid: boolean, dependencies: string[] }}
 */
export function checkZeroRuntimeDeps(packageJsonPath = 'package.json') {
  if (!fs.existsSync(packageJsonPath)) {
    return { valid: false, dependencies: ['package.json not found'] };
  }
  const content = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const deps = Object.keys(content.dependencies || {});
  return {
    valid: deps.length === 0,
    dependencies: deps
  };
}

/**
 * Asserts that code contains no outbound network egress calls.
 * @param {string} code
 */
export function assertNoOutboundEgress(code = '') {
  const forbiddenPatterns = [
    /\b(fetch|axios|undici|got)\s*\(/,
    /\bhttp\.request\s*\(/,
    /\bhttps\.request\s*\(/,
    /\bnew\s+WebSocket\s*\(/
  ];
  for (const p of forbiddenPatterns) {
    assert.ok(!p.test(code), `Forbidden outbound network egress call matching ${p}`);
  }
}

/**
 * Asserts that code contains no node:* builtin imports.
 * @param {string} code
 */
export function assertNoNodeBuiltinImports(code = '') {
  const forbiddenPatterns = [
    /\bimport\s+.*?['"]node:[^'"]+['"]/,
    /\brequire\s*\(\s*['"]node:[^'"]+['"]\s*\)/
  ];
  for (const p of forbiddenPatterns) {
    assert.ok(!p.test(code), `Forbidden node:* import in isomorphic core matching ${p}`);
  }
}

/**
 * Spies on network connections during a test function and traps non-loopback egress.
 * @template T
 * @param {() => Promise<T> | T} testFn
 * @param {object} [options]
 * @returns {Promise<{ result: T, violations: Array<{ target: string, stack: string }> }>}
 */
export async function withNetworkSpy(testFn, options = {}) {
  const violations = [];
  const originalConnect = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function (...args) {
    let target = '';
    if (typeof args[0] === 'object' && args[0] !== null) {
      if (args[0].path) {
        target = String(args[0].path);
      } else {
        target = `${args[0].host || args[0].hostname || 'localhost'}:${args[0].port || ''}`;
      }
    } else if (typeof args[0] === 'number') {
      const port = args[0];
      const host = typeof args[1] === 'string' ? args[1] : 'localhost';
      target = `${host}:${port}`;
    } else {
      target = String(args[0] || '');
    }

    const t = target.trim();
    const isLoopback =
      t.includes('127.0.0.1') ||
      t.includes('localhost') ||
      t.includes('\\\\.\\pipe\\') ||
      t.includes('//./pipe/') ||
      t.endsWith('.sock') ||
      t.includes('.sock') ||
      t.startsWith('/tmp/') ||
      t.startsWith('/private/tmp/') ||
      ((t.startsWith('/') || t.startsWith('./') || t.startsWith('../')) && t.includes('ctxtop-')) ||
      t.startsWith('127.') ||
      t.startsWith('0.0.0.0') ||
      t === '::1' ||
      t === '[::1]' ||
      t.startsWith('::1:') ||
      t.startsWith('[::1]:') ||
      t.includes('::ffff:127.0.0.1') ||
      t.includes('ip6-localhost') ||
      t.includes('ip6-loopback');

    if (!isLoopback) {
      violations.push({
        target,
        stack: new Error().stack || ''
      });
    }
    return originalConnect.apply(this, args);
  };

  try {
    const result = await testFn();
    return { result, violations };
  } finally {
    net.Socket.prototype.connect = originalConnect;
  }
}

// ============================================================================
// 10. UI & Invariant Assertions
// ============================================================================

function _extractElementById(html, targetId) {
  if (!html || typeof html !== 'string') return null;
  const idRegex = new RegExp(`<([a-zA-Z0-9]+)[^>]*id=["']${targetId}["'][^>]*>`, 'i');
  const match = idRegex.exec(html);
  if (!match) return null;
  const tagName = match[1].toLowerCase();
  const startIdx = match.index;
  let depth = 0;
  const tagRegex = new RegExp(`(</?${tagName}\\b[^>]*>)`, 'gi');
  tagRegex.lastIndex = startIdx;
  let m;
  while ((m = tagRegex.exec(html)) !== null) {
    if (m[1].startsWith('</')) {
      depth--;
      if (depth === 0) {
        return html.slice(startIdx, tagRegex.lastIndex);
      }
    } else if (!m[1].endsWith('/>')) {
      depth++;
    }
  }
  return html.slice(startIdx, startIdx + 2000);
}

function _stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Invariant 1: Asserts that #compactInstruction renders "/compact" instructions
 * alongside the 1-click Copy /compact button (#btnCompactPrimary) without legacy Ctrl+V guidance.
 * @param {string} htmlOrContent
 */
export function assertPlainTextCompact(htmlOrContent = '') {
  // 1. Forbidden legacy symbol
  assert.ok(
    !htmlOrContent.includes('copyCompactWithGuidance'),
    'Invariant 1 Violation: Must never render copyCompactWithGuidance function'
  );

  // 2. Locate #compactInstruction scope if present
  const compactEl = _extractElementById(htmlOrContent, 'compactInstruction');
  const compactAdvEl = _extractElementById(htmlOrContent, 'compactInstructionAdv');
  const actionRowCompactEl = _extractElementById(htmlOrContent, 'actionRowCompact');

  const scopedTarget = compactEl || compactAdvEl || actionRowCompactEl || htmlOrContent;

  // 3. Ctrl+V paste instruction check
  if (compactEl || compactAdvEl || actionRowCompactEl) {
    assert.ok(
      !scopedTarget.includes('Ctrl+V'),
      'Invariant 1 Violation: Must never instruct user to press Ctrl+V for /compact'
    );
    const compactCtrlVRegex = /(?:\/compact[^\n.<>]*Ctrl\+V|Ctrl\+V[^\n.<>]*\/compact)/i;
    assert.ok(
      !compactCtrlVRegex.test(htmlOrContent),
      'Invariant 1 Violation: Must never instruct user to press Ctrl+V for /compact'
    );
  } else {
    assert.ok(
      !htmlOrContent.includes('Ctrl+V'),
      'Invariant 1 Violation: Must never instruct user to press Ctrl+V'
    );
  }

  // 4. Plain text instruction validation: "Type /compact in the chat box and press Enter"
  const plainScopeText = _stripTags(scopedTarget);
  const plainFullText = _stripTags(htmlOrContent);
  const expectedInstruction = 'Type /compact in the chat box and press Enter';

  const hasInstruction = 
    scopedTarget.includes(expectedInstruction) ||
    plainScopeText.includes(expectedInstruction) ||
    htmlOrContent.includes(expectedInstruction) ||
    plainFullText.includes(expectedInstruction);

  assert.ok(
    hasInstruction,
    'Invariant 1: Must render instruction "Type /compact in the chat box and press Enter"'
  );
}

/**
 * Invariant 2: Asserts that active source files are never classified as ignorable.
 * @param {(p: string) => boolean} isIgnorablePathFn
 */
export function assertActiveSourceProtected(isIgnorablePathFn) {
  assert.equal(typeof isIgnorablePathFn, 'function', 'Path checker function required');

  // Active source files must NOT be ignorable (returns false)
  assert.equal(isIgnorablePathFn('src/core/router.mjs'), false, 'Active source router.mjs must not be ignorable');
  assert.equal(isIgnorablePathFn('src/webview/horizon_panel.html'), false, 'Active source horizon_panel.html must not be ignorable');
  assert.equal(isIgnorablePathFn('lib/index.js'), false, 'Active source index.js must not be ignorable');
  assert.equal(isIgnorablePathFn('main.py'), false, 'Active source main.py must not be ignorable');
  assert.equal(isIgnorablePathFn(''), false, 'Empty path must not be ignorable');

  // Windows backslash paths must behave identically
  assert.equal(isIgnorablePathFn('src\\core\\router.mjs'), false, 'Active source router.mjs (Windows path) must not be ignorable');
  assert.equal(isIgnorablePathFn('src\\webview\\horizon_panel.html'), false, 'Active source horizon_panel.html (Windows path) must not be ignorable');
  assert.equal(isIgnorablePathFn('lib\\index.js'), false, 'Active source index.js (Windows path) must not be ignorable');
  assert.equal(isIgnorablePathFn('main.py'), false, 'Active source main.py (Windows path) must not be ignorable');

  // Build artifacts, lockfiles, and logs MUST be ignorable (returns true)
  assert.equal(isIgnorablePathFn('package-lock.json'), true, 'package-lock.json should be ignorable');
  assert.equal(isIgnorablePathFn('yarn.lock'), true, 'yarn.lock should be ignorable');
  assert.equal(isIgnorablePathFn('build/output.log'), true, 'output.log should be ignorable');
  assert.equal(isIgnorablePathFn('dist/bundle.min.js'), true, 'minified bundle should be ignorable');

  // Build artifacts, lockfiles, and logs on Windows
  assert.equal(isIgnorablePathFn('build\\output.log'), true, 'output.log (Windows path) should be ignorable');
  assert.equal(isIgnorablePathFn('dist\\bundle.min.js'), true, 'minified bundle (Windows path) should be ignorable');
}

/**
 * Invariant 3: Verifies byte-for-byte SHA-256 parity between file pairs or plugin mirrors.
 * @param {object} [options]
 * @param {Array<[string, string]>} [options.filePairs] Array of [filePathA, filePathB] to compare
 * @returns {{ verifiedPairs: number, mismatches: string[] }}
 */
export function assertMirrorParity(options = {}) {
  const pairs = options.filePairs || [];
  const mismatches = [];

  for (const [fileA, fileB] of pairs) {
    if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) {
      mismatches.push(`Missing file in pair: ${fileA} or ${fileB}`);
      continue;
    }
    const hashA = crypto.createHash('sha256').update(fs.readFileSync(fileA)).digest('hex');
    const hashB = crypto.createHash('sha256').update(fs.readFileSync(fileB)).digest('hex');

    if (hashA !== hashB) {
      mismatches.push(`Hash mismatch between ${fileA} and ${fileB}: ${hashA} !== ${hashB}`);
    }
  }

  assert.equal(mismatches.length, 0, `Mirror parity violations: ${mismatches.join('; ')}`);
  return {
    verifiedPairs: pairs.length,
    mismatches
  };
}
