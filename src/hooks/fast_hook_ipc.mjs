/**
 * @file src/hooks/fast_hook_ipc.mjs
 * Thin stdin reader, conservative bounded-read fast-path preflight, and re-export facade
 * for the Engine-Node fast IPC client (`../engine-node/ipc/fast_client.mjs`).
 *
 * Keeps `src/hooks/` free of direct `node:net` socket imports while preserving minimal
 * cold-start startup overhead for Windows Tier-2 hook entrypoints.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isRealHostHomeEnv,
  resolveFastIpcPipePath,
  tryFastDaemonRpc
} from '../engine-node/ipc/fast_client.mjs';

export { isRealHostHomeEnv, resolveFastIpcPipePath, tryFastDaemonRpc };

const BOUNDED_READ_TOOL_RE = /^(?:default_api:)?(?:Read|read_file|view_file)$/i;
const SENSITIVE_SEGMENT_RE =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.git|\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|id_rsa(?:\..*)?|id_dsa(?:\..*)?|id_ecdsa(?:\..*)?|id_ed25519(?:\..*)?|oauth_creds\.json|credentials\.json|[^\\/]*(?:secret|credential|token)[^\\/]*|GEMINI\.md|CLAUDE\.md|AGENTS\.md)(?:[\\/]|$)/i;
const BINARY_OR_MULTIMODAL_EXT_RE =
  /\.(?:pem|key|pfx|p12|kdbx|keystore|jks|crt|cer|der|ipynb|pdf|png|jpe?g|gif|webp|bmp|ico|mp4|mov|wav|mp3|zip|tar|gz|7z|sqlite3?|db|vscdb)$/i;
const TRAVERSAL_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const FORBIDDEN_AIRLOCK_RE = /(?:^|[\\/])packages[\\/]airlock(?:[\\/]|$)/i;

/**
 * Conservative fast-path check for explicitly bounded workspace source file reads.
 * Returns `false` whenever any active guard, lock, config override, session state,
 * sensitive/multimodal/external path, or unbounded read could require evaluation.
 *
 * @param {object} [payload={}]
 * @param {{ platform?: 'claude' | 'antigravity', cwd?: string, homeDir?: string }} [ctx={}]
 * @returns {boolean}
 */
export function canFastAllowBoundedRead(
  payload = {},
  { platform = 'claude', cwd = '', homeDir = '' } = {}
) {
  if (!payload || typeof payload !== 'object') return false;

  if (
    payload.thinkingTokens ||
    payload.shieldForceActive ||
    payload.shieldConfig ||
    payload.priorUnclippedReads ||
    payload.priorContentSnapshot ||
    String(payload.mode || payload.flightMode || '').toUpperCase() === 'AUTO_PILOT'
  ) {
    return false;
  }

  const toolName = String(payload.tool_name || payload.toolName || payload.toolCall?.name || '');
  if (!BOUNDED_READ_TOOL_RE.test(toolName)) return false;

  const tIn = payload.tool_input || payload.toolInput || payload.args || payload.toolArgs || payload.toolCall?.args || {};
  if (!tIn || typeof tIn !== 'object') return false;

  const hasBounds =
    (tIn.StartLine !== undefined && tIn.StartLine !== null) ||
    (tIn.start_line !== undefined && tIn.start_line !== null) ||
    (tIn.EndLine !== undefined && tIn.EndLine !== null) ||
    (tIn.end_line !== undefined && tIn.end_line !== null) ||
    (tIn.offset !== undefined && tIn.offset !== null) ||
    (tIn.limit !== undefined && tIn.limit !== null);
  if (!hasBounds) return false;

  const limitNum = Number(tIn.limit);
  const startNum = Number(tIn.StartLine ?? tIn.start_line);
  const endNum = Number(tIn.EndLine ?? tIn.end_line);
  if (
    (Number.isFinite(limitNum) && limitNum > 150) ||
    (Number.isFinite(startNum) && Number.isFinite(endNum) && endNum - startNum + 1 > 150)
  ) {
    return false;
  }

  const rawPath = String(
    tIn.file_path || tIn.Path || tIn.AbsolutePath || tIn.path || tIn.TargetFile || ''
  ).trim();
  if (!rawPath || rawPath.includes('\0') || TRAVERSAL_SEGMENT_RE.test(rawPath)) {
    return false;
  }
  if (
    SENSITIVE_SEGMENT_RE.test(rawPath) ||
    BINARY_OR_MULTIMODAL_EXT_RE.test(rawPath) ||
    FORBIDDEN_AIRLOCK_RE.test(rawPath)
  ) {
    return false;
  }

  const rawCwd =
    cwd ||
    payload.cwd ||
    (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) ||
    payload.workspacePath ||
    process.cwd();
  const baseCwd = path.resolve(String(rawCwd || process.cwd()));

  if (path.isAbsolute(rawPath)) {
    const resolvedTarget = path.resolve(rawPath);
    const rel = path.relative(baseCwd, resolvedTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }
    if (
      SENSITIVE_SEGMENT_RE.test(rel) ||
      BINARY_OR_MULTIMODAL_EXT_RE.test(rel) ||
      FORBIDDEN_AIRLOCK_RE.test(rel)
    ) {
      return false;
    }
  }

  const effHome = homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
  const sessionId = String(payload.session_id || payload.sessionId || payload.conversationId || 'default');
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (effHome && fs.existsSync(path.join(effHome, '.ctxtop', 'runtime', `${sessionId}.ctl`))) {
    return false;
  }
  if (fs.existsSync(path.join(baseCwd, '.claude', 'locks', 'active_scopes.json'))) {
    return false;
  }
  if (fs.existsSync(path.join(baseCwd, '.agents', 'locks', 'active_scopes.json'))) {
    return false;
  }
  if (fs.existsSync(path.join(baseCwd, '.agents', 'telemetry', 'rsl_ledger.json'))) {
    return false;
  }

  if (platform === 'claude') {
    if (fs.existsSync(path.join(baseCwd, '.claude', 'horizon-state', `${safeSid}.json`))) {
      return false;
    }
    if (fs.existsSync(path.join(baseCwd, '.claude', 'cache', `read_snapshots_${safeSid}.json`))) {
      return false;
    }
    if (effHome && fs.existsSync(path.join(effHome, '.claude', 'horizon-state', `${safeSid}.json`))) {
      return false;
    }
    if (fs.existsSync(path.join(baseCwd, '.attention-horizon.json'))) {
      return false;
    }
  }

  return true;
}

/**
 * Fast, zero-dependency stdin JSON reader for hook entrypoints.
 *
 * @param {{ maxTimeoutMs?: number, settleMs?: number }} [options={}]
 * @returns {Promise<object>}
 */
export function readStdinFast({ maxTimeoutMs = 250, settleMs = 2 } = {}) {
  if (process.stdin.isTTY || process.stdin.readableEnded) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    let settleTimer = null;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        process.stdin.pause();
      } catch {
        // Ignore pause errors
      }
      resolve(val);
    };

    const tryParse = () => {
      try {
        const trimmed = raw.trim();
        return trimmed ? JSON.parse(trimmed) : {};
      } catch {
        return {};
      }
    };

    const maxTimer = setTimeout(() => finish(tryParse()), maxTimeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
      if (settleTimer) clearTimeout(settleTimer);
      if (raw.trim().endsWith('}')) {
        settleTimer = setTimeout(() => {
          try {
            finish(JSON.parse(raw));
          } catch {
            // Wait for end or timeout if JSON spans multiple chunks
          }
        }, settleMs);
      }
    });
    process.stdin.on('end', () => finish(tryParse()));
    process.stdin.on('error', () => finish({}));
  });
}

function extractFastPostToolText(event = {}) {
  const resp = event.tool_response ?? event.tool_output ?? event.toolOutput ?? event.output;
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const parts = [resp.stdout, resp.stderr, resp.output, resp.content, resp.error]
      .filter((x) => typeof x === 'string' && x.length > 0);
    if (parts.length > 0) return parts.join('\n');
    return '';
  }
  return resp !== undefined && resp !== null ? String(resp) : '';
}

function didFastToolExecutionFail(event = {}) {
  if (
    event.is_error === true ||
    event.isError === true ||
    event.succeeded === false ||
    Boolean(event.tool_error || event.error) ||
    (typeof event.exit_code === 'number' && event.exit_code !== 0) ||
    (typeof event.exitCode === 'number' && event.exitCode !== 0)
  ) {
    return true;
  }
  const resp = event.tool_response;
  if (resp && typeof resp === 'object') {
    if (
      resp.is_error === true ||
      resp.isError === true ||
      resp.succeeded === false ||
      resp.status === 'error' ||
      resp.status === 'failed' ||
      Boolean(resp.error) ||
      (typeof resp.exit_code === 'number' && resp.exit_code !== 0) ||
      (typeof resp.exitCode === 'number' && resp.exitCode !== 0) ||
      (typeof resp.returncode === 'number' && resp.returncode !== 0)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Pure in-memory Tier-1-active fast-path for Claude Code `PreToolUse` (`Grep`/`Glob`)
 * so fast-path calls avoid synchronously loading `pre-tool-use-core.mjs`.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function tryTier1PreToolFastPath(event = {}, options = {}) {
  const toolName = String(event?.tool_name || event?.toolName || '');
  const tier1Active = Boolean(
    options?.tier1ModActive ||
    event?.tier1ModActive ||
    globalThis.process?.env?.AH_TIER1_MOD_ACTIVE === '1'
  );
  if (tier1Active && /^(Grep|Glob)$/i.test(toolName)) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      fastPath: 'tier1_mod_active',
      verdict: { triggered: false, decision: 'allow', reason: 'Handled in-process by Tier 1 Mod' }
    };
  }
  return null;
}

/**
 * Pure in-memory Tier-1-active fast-path for Claude Code `PostToolUse` (`Grep`/`Glob`
 * under 16,000 chars and non-error) so fast-path calls avoid loading `post-tool-use-core.mjs`.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function tryTier1PostToolFastPath(event = {}, options = {}) {
  const toolName = String(event?.tool_name || event?.toolName || 'Bash');
  const tier1Active = Boolean(
    options?.tier1ModActive ||
    event?.tier1ModActive ||
    globalThis.process?.env?.AH_TIER1_MOD_ACTIVE === '1'
  );
  if (
    tier1Active &&
    /^(Grep|Glob)$/i.test(toolName) &&
    extractFastPostToolText(event).length < 16000 &&
    !didFastToolExecutionFail(event)
  ) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      fastPath: 'tier1_mod_active',
      sanitized: { modified: false, offloaded: false }
    };
  }
  return null;
}
