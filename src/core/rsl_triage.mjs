/**
 * @file src/core/rsl_triage.mjs
 * Dual-Platform Stage 1 Zero-Token Contrastive Triage & Anti-Reward-Hacking Gate.
 *
 * Supports both Google Antigravity (`SessionStart`, `PostToolUse`, `Stop`, `transcriptPath`,
 * `artifactDirectoryPath`) and Claude Code (`session_id`, `cwd`, `transcript_path`, `PostToolUse`,
 * `Stop`, `SessionEnd`) with <30ms synchronous latency and 0 LLM tokens.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { RSL_CONSTANTS } from './constants.mjs';

const TEST_FILE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs)$/i;
const EXCLUDED_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.agents',
  '.claude',
  'evaluation_bundles',
  'dist',
  'build',
  'out',
  '.next',
  'coverage'
]);

const GIT_MINING_RE = /\bgit\s+(?:fsck|cat-file|reflog|verify-pack)\b/i;
const TEST_CMD_RE = /(?:npm\s+(?:run\s+)?test|node\s+--test|pytest|vitest|jest|cargo\s+test|go\s+test|unittest|mocha|playwright)/i;
const USER_AUTHORIZED_TEST_REMOVAL_RE = /\b(?:delete|remove|drop|prune|disable|skip)\s+(?:the\s+|these\s+|old\s+|obsolete\s+)?tests?\b/i;
const USER_CORRECTION_RE = /\b(?:do\s+not|don'?t|never|instead\s+of|stop\s+using|wrong|should\s+be|always\s+use|avoid|rejected)\b/i;
const CONVERSATIONAL_NON_DIRECTIVE_RE = /\b(?:i\s+(?:don'?t|do\s+not)\s+(?:see|know|have|think|understand|want\s+to\s+wait)|don'?t\s+worry)\b/i;
const SLASH_COMMAND_ONLY_RE = /^\/(?:plan|browser|compact|handoff|horizon|grill-me|boost|teamwork|learn|evolve|schedule)\b/i;
const STRONG_DIRECTIVE_CORRECTION_RE = /\b(?:never\s+(?:use|run|modify|edit|read|write|commit|push|skip)|do\s+not\s+(?:use|run|modify|edit|read|write|touch)|instead\s+of|always\s+use|stop\s+using|must\s+(?:never|not|always))\b/i;

export const RSL_ANTIGRAVITY_POST_TOOL_MATCHER =
  'run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content';
export const RSL_CLAUDE_POST_TOOL_MATCHER =
  'Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit';

const RSL_MUTATING_OR_EXEC_TOOL_RE =
  /^(?:run_command|execute_bash|bash|powershell|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|edit|multiedit|multi_edit|write|notebookedit)$/i;

/**
 * Returns true only for shell/command or file-mutating tools needed for RSL contrastive recovery.
 * @param {string} [toolName='']
 * @returns {boolean}
 */
export function isMutatingOrExecRslTool(toolName = '') {
  const cleaned = String(toolName || '')
    .trim()
    .replace(/^default_api:/i, '');
  if (!cleaned) return false;
  return RSL_MUTATING_OR_EXEC_TOOL_RE.test(cleaned);
}

/**
 * Checks whether the final recorded step in `.agents/telemetry/<sessionId>.rsl_steps.jsonl`
 * matches this event's stepIdx, toolName, failed status, targetFile, and command.
 *
 * @param {object} [rawPayload={}]
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isDuplicateRslStepEvent(rawPayload = {}, options = {}) {
  try {
    const normalized = normalizeRslToolEvent(rawPayload, options);
    if (normalized.stepIdx === null || normalized.stepIdx < 0) return false;
    const stepsPath = path.join(
      normalized.workspaceRoot,
      '.agents',
      'telemetry',
      `${normalized.sessionId}.rsl_steps.jsonl`
    );
    if (!fs.existsSync(stepsPath)) return false;
    const tail = readFileBoundedReadOnly(stepsPath, 4096);
    const lines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return false;
    const last = JSON.parse(lines[lines.length - 1]);
    return Boolean(
      last &&
        last.stepIdx === normalized.stepIdx &&
        last.toolName === normalized.toolName &&
        last.failed === normalized.failed &&
        last.targetFile === normalized.targetFile &&
        last.command === normalized.command
    );
  } catch {
    return false;
  }
}

/**
 * Strips injected prompt wrappers (`<CONTEXT_SUMMARY>`, `<ADDITIONAL_METADATA>`, etc.)
 * and extracts only raw `<USER_REQUEST>` body text before directive classification.
 * @param {string} raw
 * @returns {string}
 */
export function extractCleanUserRequestText(raw = '') {
  let text = String(raw || '');
  const userReqMatches = [];
  text.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi, (_, inner) => {
    const cleanInner = String(inner || '').trim();
    if (cleanInner) userReqMatches.push(cleanInner);
    return '';
  });
  if (userReqMatches.length > 0) {
    return userReqMatches.join('\n').trim();
  }
  text = text
    .replace(/<(?:CONTEXT_SUMMARY|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|PLAN|system_context_prefix|user_rules|system-reminder)>[\s\S]*?<\/(?:CONTEXT_SUMMARY|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|PLAN|system_context_prefix|user_rules|system-reminder)>/gi, ' ')
    .replace(/<\/?(?:USER_REQUEST|ARTIFACT|TASK)\b[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * Filters out casual UI status observations or bare slash commands while preserving real coding directives.
 * @param {string} cleanText
 * @returns {boolean}
 */
export function isExplicitDirectiveCorrection(cleanText = '') {
  const txt = String(cleanText || '').trim();
  if (!txt || txt.length < 10) return false;
  if (!USER_CORRECTION_RE.test(txt)) return false;
  if (CONVERSATIONAL_NON_DIRECTIVE_RE.test(txt) && !STRONG_DIRECTIVE_CORRECTION_RE.test(txt)) {
    return false;
  }
  if (SLASH_COMMAND_ONLY_RE.test(txt) && !STRONG_DIRECTIVE_CORRECTION_RE.test(txt)) {
    return false;
  }
  return true;
}

/**
 * Returns true if a file path points outside the active workspace or inside ephemeral brain/temp storage.
 * @param {string} targetPath
 * @param {string} [workspaceRoot='']
 * @returns {boolean}
 */
export function isExternalOrEphemeralPath(targetPath = '', workspaceRoot = '') {
  const raw = String(targetPath || '').trim();
  if (!raw) return false;
  const norm = raw.replace(/\\/g, '/');
  if (
    raw.startsWith('~') ||
    raw.startsWith('..') ||
    /(?:^|\/)\.(?:gemini|claude\/cache|attention-horizon|agents\/telemetry)\//i.test(norm) ||
    /\/antigravity[^/]*\/brain\//i.test(norm)
  ) {
    return true;
  }
  if (workspaceRoot && (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw))) {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedTarget = path.resolve(raw);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return true;
    }
    return false;
  }
  if (/\/AppData\/Local\/Temp\//i.test(norm) || /^\/(?:tmp|var\/folders)\//i.test(norm)) {
    return true;
  }
  return false;
}

/**
 * Sanitizes a conversation/session identifier for telemetry filenames.
 * @param {string} [sessionId='default']
 * @returns {string}
 */
export function sanitizeRslSessionId(sessionId = 'default') {
  const safe = String(sessionId || 'default')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return safe || 'default';
}

/**
 * Resolves the workspace root from Antigravity, Claude Code, or CLI options.
 * @param {object} [payload={}]
 * @param {object} [options={}]
 * @returns {string}
 */
export function resolveWorkspaceRoot(payload = {}, options = {}) {
  const candidate =
    options.workspaceRoot ||
    options.cwd ||
    (Array.isArray(payload?.workspacePaths) && payload.workspacePaths[0]) ||
    payload?.workspaceRoot ||
    payload?.cwd ||
    process.cwd();
  return path.resolve(String(candidate || process.cwd()));
}

/**
 * Strictly excludes `packages/airlock/` and non-source directories from all workspace scans.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isExcludedFromRslScan(relPath = '') {
  const posix = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  if (!posix) return false;
  if (
    posix === 'packages/airlock' ||
    posix.startsWith('packages/airlock/') ||
    posix === '.github/workflows/airlock-schema-canary.yml' ||
    posix.startsWith('docs/HIGHBEAM_AIRLOCK_')
  ) {
    return true;
  }
  const parts = posix.split('/');
  return parts.some((part) => EXCLUDED_DIR_SEGMENTS.has(part));
}

function isWorkspaceTestFile(relPosix) {
  if (!TEST_FILE_EXT_RE.test(relPosix)) return false;
  return (
    /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs)$/i.test(relPosix) ||
    /(?:^|\/)(?:test|tests|__tests__)\/.+\.(?:[cm]?[jt]sx?|py|go|rs)$/i.test(relPosix) ||
    /_test\.(?:py|go)$/i.test(relPosix)
  );
}

/**
 * Computes SHA-256 + assertion/skip metrics for a single test file (opened strictly read-only `'r'`).
 * @param {string} filePath
 * @returns {{ sha256: string, lfSha256: string, assertionCount: number, skipCount: number, bytes: number } | null}
 */
export function computeTestFileMetrics(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, buf, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const rawBuf = offset === stat.size ? buf : buf.subarray(0, offset);
    const raw = rawBuf.toString('utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    const sha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
    const lfSha256 = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
    const assertionCount =
      (normalized.match(/\b(?:assert(?:\.[a-zA-Z0-9_]+)?\s*\(|expect\s*\(|should\.|assert_eq!\s*\()/g) || []).length +
      (normalized.match(/^\s*assert\s+\S+/gm) || []).length;
    const skipCount =
      (normalized.match(/(?:\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|(?:@?pytest\.mark\.skip(?:if)?|unittest\.skip)\b|#\[\s*ignore\b)/g) || []).length;
    return { sha256, lfSha256, assertionCount, skipCount, bytes: rawBuf.byteLength };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Snapshots SHA-256 hashes, assertion counts, and skip counts of workspace test files
 * into `.agents/telemetry/<sessionId>.test_hashes.json` (excluding `packages/airlock/`).
 *
 * @param {string} workspaceRoot
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 */
export function snapshotTestSuiteBaseline(workspaceRoot, sessionId = 'default', options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const safeSessionId = sanitizeRslSessionId(sessionId);
  const maxFiles = Math.max(1, Number(options.maxFiles || 400));
  const deadlineMs = Date.now() + Number(options.budgetMs || 22);
  const files = {};
  let scannedCount = 0;

  const walk = (dir, depth) => {
    if (depth > 6 || scannedCount >= maxFiles || Date.now() > deadlineMs) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scannedCount >= maxFiles || Date.now() > deadlineMs) break;
      const fullPath = path.join(dir, entry.name);
      const relPosix = path.relative(baseRoot, fullPath).replace(/\\/g, '/');
      if (isExcludedFromRslScan(relPosix)) continue;
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && isWorkspaceTestFile(relPosix)) {
        const metrics = computeTestFileMetrics(fullPath);
        if (metrics) {
          files[relPosix] = metrics;
          scannedCount += 1;
        }
      }
    }
  };

  walk(baseRoot, 0);
  const snapshotPath = path.join(baseRoot, '.agents', 'telemetry', `${safeSessionId}.test_hashes.json`);
  const payload = {
    schemaVersion: '2026.11.1',
    sessionId: safeSessionId,
    recordedAt: new Date().toISOString(),
    fileCount: scannedCount,
    files
  };

  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    atomicWriteFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // Non-fatal on read-only workspaces
  }

  return { snapshotPath, fileCount: scannedCount, files };
}

function extractTargetFileFromArgs(args, workspaceRoot) {
  if (!args || typeof args !== 'object') return '';
  const raw =
    args.file_path ||
    args.filePath ||
    args.TargetFile ||
    args.AbsolutePath ||
    args.Path ||
    args.path ||
    args.notebook_path ||
    args.targetFile ||
    '';
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed) && workspaceRoot) {
    const rel = path.relative(workspaceRoot, trimmed).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel;
    }
  }
  return trimmed.replace(/\\/g, '/');
}

function extractCommandFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const raw = args.CommandLine || args.command || args.cmd || args.script || '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function inspectClaudeToolResponseFailure(resp) {
  if (!resp) return { failed: false, errorText: '' };
  if (typeof resp === 'string') {
    const trimmed = resp.trim();
    const isErr = /\b(?:Error|ERR!|FAIL|Exception|Command failed|exit status [1-9]|exit code [1-9])\b/i.test(trimmed);
    return { failed: isErr, errorText: isErr ? trimmed.slice(0, 500) : '' };
  }
  if (typeof resp !== 'object') return { failed: false, errorText: '' };

  const exitVal = resp.exitCode ?? resp.exit_code ?? resp.returncode;
  const hasNonZeroExit = exitVal !== undefined && exitVal !== null && Number.isFinite(Number(exitVal)) && Number(exitVal) !== 0;
  const stderr = typeof resp.stderr === 'string' ? resp.stderr.trim() : '';
  const errStr = typeof resp.error === 'string' ? resp.error.trim() : (resp.error?.message ? String(resp.error.message) : '');
  const stdoutStr = typeof resp.stdout === 'string' ? resp.stdout.trim() : '';
  const hasStderrErr = Boolean(stderr) && (hasNonZeroExit || /\b(?:Error|ERR!|FAIL|Exception|SyntaxError|TypeError|ENOENT|exit code [1-9])\b/i.test(stderr));
  const failed = Boolean(
    resp.is_error === true ||
    resp.isError === true ||
    resp.succeeded === false ||
    resp.status === 'error' ||
    resp.status === 'failed' ||
    Boolean(errStr) ||
    hasNonZeroExit ||
    hasStderrErr
  );

  if (!failed) return { failed: false, errorText: '' };
  const detail = [errStr, stderr, hasNonZeroExit ? `exit ${exitVal}` : '', !errStr && !stderr ? stdoutStr : '']
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
  return { failed: true, errorText: detail || 'Tool execution failed' };
}

/**
 * Normalizes a `PostToolUse` payload from either Google Antigravity or Claude Code.
 *
 * @param {object} [rawPayload={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function normalizeRslToolEvent(rawPayload = {}, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(rawPayload, options);
  const isClaudeShape = Boolean(
    options.platform === 'claude' ||
    rawPayload.tool_name ||
    rawPayload.session_id ||
    rawPayload.transcript_path
  );
  const platform = options.platform || (isClaudeShape ? 'claude' : 'antigravity');
  const sessionId = sanitizeRslSessionId(
    rawPayload.conversationId || rawPayload.session_id || rawPayload.sessionId || options.sessionId || 'default'
  );
  const toolName = String(
    rawPayload.toolCall?.name || rawPayload.tool_name || rawPayload.toolName || ''
  ).trim();
  const args = rawPayload.toolCall?.args || rawPayload.tool_input || rawPayload.toolInput || {};
  const targetFile = extractTargetFileFromArgs(args, workspaceRoot);
  const command = extractCommandFromArgs(args);
  const stepIdx = Number.isFinite(Number(rawPayload.stepIdx ?? rawPayload.step_index))
    ? Number(rawPayload.stepIdx ?? rawPayload.step_index)
    : null;

  let failed = false;
  let errorText = '';

  if (typeof rawPayload.error === 'string' && rawPayload.error.trim().length > 0) {
    failed = true;
    errorText = rawPayload.error.trim().slice(0, 500);
  } else if (rawPayload.is_error === true || rawPayload.isError === true || rawPayload.succeeded === false) {
    failed = true;
    errorText = String(rawPayload.tool_error || rawPayload.error || 'Tool execution failed').slice(0, 500);
  } else if (
    (rawPayload.exit_code !== undefined && Number(rawPayload.exit_code) !== 0) ||
    (rawPayload.exitCode !== undefined && Number(rawPayload.exitCode) !== 0)
  ) {
    failed = true;
    errorText = `exit ${rawPayload.exit_code ?? rawPayload.exitCode}`;
  } else {
    const respCheck = inspectClaudeToolResponseFailure(rawPayload.tool_response ?? rawPayload.toolResponse);
    failed = respCheck.failed;
    errorText = respCheck.errorText;
  }

  const isTestRun = TEST_CMD_RE.test(command);
  const isTestPass = isTestRun && !failed;
  const isGitMining = GIT_MINING_RE.test(command);

  return {
    ts: Date.now(),
    platform,
    sessionId,
    workspaceRoot,
    stepIdx,
    toolName,
    targetFile,
    command: command.slice(0, 300),
    failed,
    errorText,
    isTestRun,
    isTestPass,
    isGitMining
  };
}

/**
 * Records a normalized `PostToolUse` step outcome to `.agents/telemetry/<sessionId>.rsl_steps.jsonl`.
 * Executes in <5ms synchronously.
 *
 * @param {object} [rawPayload={}]
 * @param {object} [options={}]
 */
export function recordStepOutcome(rawPayload = {}, options = {}) {
  const normalized = normalizeRslToolEvent(rawPayload, options);
  const stepsPath = path.join(
    normalized.workspaceRoot,
    '.agents',
    'telemetry',
    `${normalized.sessionId}.rsl_steps.jsonl`
  );
  try {
    fs.mkdirSync(path.dirname(stepsPath), { recursive: true });
    fs.appendFileSync(stepsPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  } catch {
    // Never throw from post-tool hook telemetry
  }
  return { ...normalized, stepsPath };
}

function readFileBoundedReadOnly(filePath, maxBytes = 512 * 1024) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const bytesToRead = Math.min(stat.size, maxBytes);
    const startOffset = Math.max(0, stat.size - bytesToRead);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const n = fs.readSync(fd, buf, offset, bytesToRead - offset, startOffset + offset);
      if (n === 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString('utf8');
    if (startOffset > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function readRecordedSteps(workspaceRoot, sessionId) {
  const safeId = sanitizeRslSessionId(sessionId);
  const stepsPath = path.join(workspaceRoot, '.agents', 'telemetry', `${safeId}.rsl_steps.jsonl`);
  if (!fs.existsSync(stepsPath)) return [];
  const raw = readFileBoundedReadOnly(stepsPath, 512 * 1024);
  const steps = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') steps.push(parsed);
    } catch {
      // Skip malformed line
    }
  }
  return steps;
}

function extractTextFromClaudeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return String(block.text || '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseTranscriptForRsl(transcriptPath, workspaceRoot, sessionId, platform) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { steps: [], userCorrections: [], prompts: [] };
  }
  const raw = readFileBoundedReadOnly(transcriptPath, 512 * 1024);
  if (!raw) return { steps: [], userCorrections: [], prompts: [] };

  const steps = [];
  const userCorrections = [];
  const prompts = [];
  const toolUseById = new Map();
  let syntheticIdx = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    // 1. Antigravity transcript entries
    if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      const cleanTxt = extractCleanUserRequestText(obj.content);
      if (cleanTxt) {
        prompts.push(cleanTxt);
        if (isExplicitDirectiveCorrection(cleanTxt)) {
          userCorrections.push({
            stepIdx: obj.step_index ?? syntheticIdx,
            text: cleanTxt.slice(0, 400)
          });
        }
      }
    }

    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        const idx = obj.step_index ?? syntheticIdx++;
        const ev = normalizeRslToolEvent(
          {
            conversationId: sessionId,
            workspacePaths: [workspaceRoot],
            toolCall: { name: tc.name, args: tc.args || tc.arguments || {} },
            stepIdx: idx,
            error: tc.error || obj.error || ''
          },
          { platform }
        );
        steps.push(ev);
      }
    }

    // 2. Claude Code JSONL transcript entries
    if (obj.type === 'user' || obj.role === 'user') {
      const msgContent = obj.message?.content ?? obj.content;
      const cleanText = extractCleanUserRequestText(extractTextFromClaudeContent(msgContent));
      if (cleanText) {
        prompts.push(cleanText);
        if (isExplicitDirectiveCorrection(cleanText)) {
          userCorrections.push({
            stepIdx: syntheticIdx,
            text: cleanText.slice(0, 400)
          });
        }
      }
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block?.type === 'tool_result') {
            const linked = toolUseById.get(block.tool_use_id) || {};
            const resultText = extractTextFromClaudeContent(block.content) || String(block.content || '');
            const inferredErr =
              Boolean(block.is_error) ||
              (block.is_error === undefined && /^(?:Error:|Exit code [1-9]|Command failed)/im.test(resultText));
            const ev = normalizeRslToolEvent(
              {
                session_id: sessionId,
                cwd: workspaceRoot,
                tool_name: linked.name || block.tool_name || 'Bash',
                tool_input: linked.input || {},
                stepIdx: syntheticIdx++,
                tool_response: {
                  is_error: inferredErr,
                  error: inferredErr ? resultText : '',
                  stderr: inferredErr ? resultText : '',
                  stdout: inferredErr ? '' : resultText
                }
              },
              { platform: 'claude' }
            );
            steps.push(ev);
          }
        }
      }
    }

    if (obj.type === 'assistant' || obj.role === 'assistant') {
      const msgContent = obj.message?.content ?? obj.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block?.type === 'tool_use') {
            toolUseById.set(block.id || `u_${syntheticIdx}`, {
              name: block.name,
              input: block.input || {}
            });
          }
        }
      }
    }

    // 3. Direct tool step records inside custom transcripts
    if ((obj.tool_name || obj.toolCall) && obj.type !== 'assistant' && obj.type !== 'user') {
      const ev = normalizeRslToolEvent(
        {
          ...obj,
          cwd: obj.cwd || workspaceRoot,
          session_id: obj.session_id || sessionId
        },
        { platform }
      );
      if (ev.stepIdx === null) ev.stepIdx = syntheticIdx++;
      steps.push(ev);
    }
  }

  return { steps, userCorrections, prompts };
}

function scanArtifactDirectoryForSupervision(artifactDirectoryPath) {
  if (!artifactDirectoryPath || !fs.existsSync(artifactDirectoryPath)) {
    return [];
  }
  const comments = [];
  let entries = [];
  try {
    entries = fs.readdirSync(artifactDirectoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries.slice(0, 30)) {
    if (!entry.isFile() || !/\.(?:md|json|txt)$/i.test(entry.name)) continue;
    const full = path.join(artifactDirectoryPath, entry.name);
    const content = readFileBoundedReadOnly(full, 128 * 1024);
    if (!content) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/✗\s*rejected|\[\s*rejected\s*\]|"status"\s*:\s*"rejected"/i.test(line)) {
        const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join(' ').trim();
        comments.push({
          file: entry.name,
          kind: 'rejected',
          lineNumber: i + 1,
          text: ctx.slice(0, 400)
        });
      } else if (line.includes('💬')) {
        comments.push({
          file: entry.name,
          kind: 'inline_comment',
          lineNumber: i + 1,
          text: line.replace(/\s+/g, ' ').trim().slice(0, 400)
        });
      }
    }
  }
  return comments.slice(0, 10);
}

/**
 * Runs EvilGenie & Coding-or-Cheating verification against the SessionStart test baseline.
 *
 * @param {string} workspaceRoot
 * @param {string} sessionId
 * @param {Array<object>} steps
 * @param {string} [promptText='']
 */
export function evaluateTestIntegrityGate(workspaceRoot, sessionId, steps = [], promptText = '') {
  const safeId = sanitizeRslSessionId(sessionId);
  const baselinePath = path.join(workspaceRoot, '.agents', 'telemetry', `${safeId}.test_hashes.json`);
  const taintDetails = [];
  const userAuthorizedRemoval = USER_AUTHORIZED_TEST_REMOVAL_RE.test(String(promptText || ''));

  for (const st of steps) {
    if (st?.isGitMining || GIT_MINING_RE.test(String(st?.command || ''))) {
      taintDetails.push(`git_object_mining: ${String(st?.command || '').slice(0, 120)}`);
    }
  }

  if (fs.existsSync(baselinePath)) {
    try {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      const files = baseline?.files || {};
      for (const [relPosix, prev] of Object.entries(files)) {
        if (isExcludedFromRslScan(relPosix)) continue;
        const abs = path.join(workspaceRoot, relPosix);
        if (!fs.existsSync(abs)) {
          if (!userAuthorizedRemoval) {
            taintDetails.push(`test_file_deleted: ${relPosix}`);
          }
          continue;
        }
        const curr = computeTestFileMetrics(abs);
        if (!curr) continue;
        if (curr.skipCount > Number(prev.skipCount || 0)) {
          taintDetails.push(`test_skip_added: ${relPosix} (${prev.skipCount} -> ${curr.skipCount})`);
        }
        if (curr.assertionCount < Number(prev.assertionCount || 0) && !userAuthorizedRemoval) {
          taintDetails.push(
            `test_assertions_removed: ${relPosix} (${prev.assertionCount} -> ${curr.assertionCount})`
          );
        }
      }
    } catch {
      // Corrupt baseline should fail open for integrity gate
    }
  }

  return {
    tainted: taintDetails.length > 0,
    status: taintDetails.length > 0 ? 'TAINTED_REWARD_HACK' : 'CLEAN',
    taintDetails
  };
}

function normalizeTerminationReason(rawStopPayload = {}) {
  const raw = String(
    rawStopPayload.terminationReason ?? rawStopPayload.termination_reason ?? ''
  ).trim();
  const upper = raw.toUpperCase();
  if (!raw || upper === 'NO_TOOL_CALL' || upper === 'MODEL_STOP' || upper === 'END_TURN') {
    return { raw: raw || 'NO_TOOL_CALL', cleanStop: true, canceled: false };
  }
  if (upper === 'USER_CANCELED' || upper === 'CANCELLED' || upper === 'CANCELED') {
    return { raw, cleanStop: false, canceled: true };
  }
  if (
    upper === 'TERMINAL_STEP_TYPE' ||
    upper === 'INJECTED_RESPONSE' ||
    upper === 'MAX_INVOCATIONS' ||
    upper === 'MAX_STEPS_EXCEEDED'
  ) {
    return { raw, cleanStop: upper === 'TERMINAL_STEP_TYPE' || upper === 'INJECTED_RESPONSE', canceled: false };
  }
  return { raw, cleanStop: upper !== 'ERROR', canceled: false };
}

function stepsMatchTarget(a, b) {
  if (!a || !b) return false;
  if (a.targetFile && b.targetFile && a.targetFile === b.targetFile) return true;
  if (a.toolName && b.toolName && a.toolName === b.toolName) return true;
  return false;
}

function extractContrastivePairsAndThrash(steps = [], cleanStop = true, workspaceRoot = '') {
  const pairs = [];
  const thrashLoops = [];
  const windowSize = RSL_CONSTANTS.CONTRASTIVE_WINDOW_STEPS;

  let consecutiveFails = 0;
  let thrashStartIdx = null;
  let thrashTarget = '';

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.failed) {
      if (consecutiveFails === 0 || (thrashTarget && (st.targetFile || st.toolName) === thrashTarget)) {
        if (consecutiveFails === 0) {
          thrashStartIdx = st.stepIdx ?? i;
          thrashTarget = st.targetFile || st.toolName;
        }
        consecutiveFails += 1;
      } else {
        consecutiveFails = 1;
        thrashStartIdx = st.stepIdx ?? i;
        thrashTarget = st.targetFile || st.toolName;
      }

      // Search 1..windowSize steps ahead for recovery on same tool/file
      const recoverySteps = [];
      let recoveredIdx = -1;
      let validatedByTest = false;

      for (let j = i + 1; j < steps.length && j <= i + windowSize; j++) {
        const cand = steps[j];
        if (cand.failed) break;
        if (cand.isTestPass) validatedByTest = true;
        if (stepsMatchTarget(st, cand) || cand.isTestPass || recoveredIdx === -1) {
          recoverySteps.push({
            stepIdx: cand.stepIdx ?? j,
            toolName: cand.toolName,
            targetFile: cand.targetFile,
            command: cand.command,
            isTestPass: Boolean(cand.isTestPass)
          });
          if (stepsMatchTarget(st, cand) && recoveredIdx === -1) {
            recoveredIdx = j;
          }
          if (cand.isTestPass && recoveredIdx !== -1) {
            break;
          }
          if (recoveredIdx !== -1) {
            const next = steps[j + 1];
            if (!next || next.failed || (!stepsMatchTarget(st, next) && !next.isTestPass)) {
              break;
            }
          }
        }
      }

      if (recoveredIdx !== -1 && (validatedByTest || cleanStop)) {
        const pairTarget = st.targetFile || steps[recoveredIdx].targetFile || '';
        if (isExternalOrEphemeralPath(pairTarget, workspaceRoot)) {
          continue;
        }
        pairs.push({
          failureStepIdx: st.stepIdx ?? i,
          recoveryStepIdx: steps[recoveredIdx].stepIdx ?? recoveredIdx,
          toolName: st.toolName,
          targetFile: pairTarget,
          command: st.command,
          errorText: st.errorText,
          recoveryAction: steps[recoveredIdx].command || steps[recoveredIdx].targetFile || steps[recoveredIdx].toolName,
          recoverySteps,
          validatedByTest
        });
      }
    } else {
      if (consecutiveFails >= 3) {
        thrashLoops.push({
          startStepIdx: thrashStartIdx,
          resolvedStepIdx: st.stepIdx ?? i,
          failureCount: consecutiveFails,
          target: thrashTarget,
          resolvedTool: st.toolName
        });
      }
      consecutiveFails = 0;
      thrashStartIdx = null;
      thrashTarget = '';
    }
  }

  return { pairs, thrashLoops };
}

/**
 * Builds a bounded contrastive post-mortem digest (~2k tokens) from step telemetry,
 * read-only transcripts, and Antigravity artifacts. Fast-exits in <10ms if 0 triggers occurred.
 *
 * @param {object} [rawStopPayload={}]
 * @param {object} [options={}]
 */
export function buildContrastiveDigest(rawStopPayload = {}, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(rawStopPayload, options);
  const platform =
    options.platform ||
    (rawStopPayload.session_id || rawStopPayload.transcript_path ? 'claude' : 'antigravity');
  const sessionId = sanitizeRslSessionId(
    rawStopPayload.conversationId || rawStopPayload.session_id || rawStopPayload.sessionId || options.sessionId || 'default'
  );
  const term = normalizeTerminationReason(rawStopPayload);
  const transcriptPath = rawStopPayload.transcriptPath || rawStopPayload.transcript_path || options.transcriptPath || '';
  const artifactDirectoryPath = rawStopPayload.artifactDirectoryPath || options.artifactDirectoryPath || '';

  const recordedSteps = readRecordedSteps(workspaceRoot, sessionId);
  const transcriptData = parseTranscriptForRsl(transcriptPath, workspaceRoot, sessionId, platform);
  const steps = recordedSteps.length > 0 ? recordedSteps : transcriptData.steps;

  const combinedPromptText = [
    String(rawStopPayload.lastUserInput || ''),
    ...transcriptData.prompts
  ]
    .filter(Boolean)
    .join('\n');

  const integrity = evaluateTestIntegrityGate(workspaceRoot, sessionId, steps, combinedPromptText);

  const touchedFiles = Array.from(
    new Set(steps.map((s) => s.targetFile).filter(Boolean))
  );
  const executedTools = Array.from(
    new Set(steps.map((s) => s.toolName).filter(Boolean))
  );
  const unresolvedErrors = steps
    .filter((s) => s.failed)
    .map((s) => ({
      stepIdx: s.stepIdx,
      toolName: s.toolName,
      targetFile: s.targetFile,
      errorText: s.errorText
    }));

  if (integrity.tainted) {
    return {
      schemaVersion: '2026.11.1',
      sessionId,
      platform,
      workspaceRoot,
      terminationReason: term.raw,
      triggered: false,
      tainted: true,
      status: 'TAINTED_REWARD_HACK',
      taintDetails: integrity.taintDetails,
      contrastivePairs: [],
      artifactComments: [],
      userCorrections: [],
      thrashLoops: [],
      touchedFiles,
      executedTools,
      unresolvedErrors
    };
  }

  const { pairs, thrashLoops } = extractContrastivePairsAndThrash(steps, term.cleanStop, workspaceRoot);
  const filteredPairs = pairs.filter((p) => !isExternalOrEphemeralPath(p.targetFile, workspaceRoot));
  const filteredThrash = thrashLoops.filter((l) => !isExternalOrEphemeralPath(l.target, workspaceRoot));
  const artifactComments = scanArtifactDirectoryForSupervision(artifactDirectoryPath);
  const userCorrections = transcriptData.userCorrections.slice(0, 8);

  const hasTriggers =
    !term.canceled &&
    (filteredPairs.length > 0 || artifactComments.length > 0 || userCorrections.length > 0 || filteredThrash.length > 0);

  if (!hasTriggers) {
    return {
      schemaVersion: '2026.11.1',
      sessionId,
      platform,
      workspaceRoot,
      terminationReason: term.raw,
      triggered: false,
      tainted: false,
      status: 'CLEAN_NO_TRIGGERS',
      taintDetails: [],
      contrastivePairs: [],
      artifactComments: [],
      userCorrections: [],
      thrashLoops: [],
      touchedFiles,
      executedTools,
      unresolvedErrors
    };
  }

  let digest = {
    schemaVersion: '2026.11.1',
    sessionId,
    platform,
    workspaceRoot,
    recordedAt: new Date().toISOString(),
    terminationReason: term.raw,
    triggered: true,
    tainted: false,
    status: 'READY',
    taintDetails: [],
    contrastivePairs: filteredPairs.slice(0, 6),
    artifactComments: artifactComments.slice(0, 6),
    userCorrections: userCorrections.slice(0, 6),
    thrashLoops: filteredThrash.slice(0, 4),
    touchedFiles: touchedFiles.slice(0, 20),
    executedTools: executedTools.slice(0, 15),
    unresolvedErrors: unresolvedErrors.slice(0, 10)
  };

  // Enforce ~2k token budget ceiling on persisted contrastive digest
  let serialized = JSON.stringify(digest, null, 2);
  if (serialized.length > RSL_CONSTANTS.MAX_DIGEST_CHARS) {
    digest = {
      ...digest,
      contrastivePairs: digest.contrastivePairs.slice(0, 3),
      artifactComments: digest.artifactComments.slice(0, 3),
      userCorrections: digest.userCorrections.slice(0, 3)
    };
    serialized = JSON.stringify(digest, null, 2);
  }

  const queueDir = path.join(workspaceRoot, '.agents', 'telemetry', 'rsl_queue');
  const digestPath = path.join(queueDir, `${sessionId}.digest.json`);
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    atomicWriteFileSync(digestPath, `${serialized}\n`);
  } catch {
    // Non-fatal
  }

  return {
    ...digest,
    digestPath
  };
}
