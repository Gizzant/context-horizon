#!/usr/bin/env node
/**
 * @file src/hooks/claude_rsl_hook.mjs
 * Claude Code Lifecycle Hook Adapter for Highbeam RSL (`SessionStart`, `PreToolUse`,
 * `PostToolUse`, `Stop`, `SessionEnd`).
 *
 * Works both standalone (via `.claude/settings.json` top-level `"hooks"`) and in-process
 * inside canonical `hooks/handlers/*.mjs` handlers (<30ms, 0 LLM tokens).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../core/atomic_io.mjs';
import {
  resolveWorkspaceRoot,
  sanitizeRslSessionId,
  snapshotTestSuiteBaseline,
  recordStepOutcome,
  buildContrastiveDigest
} from '../core/rsl_triage.mjs';
import { distillContrastiveDigest } from '../core/rsl_distiller.mjs';
import {
  getRslLedgerPath,
  ingestDistilledHeuristics,
  evaluatePromotedPreToolGuards,
  RSL_PKG_ROOT
} from '../core/rsl_ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const CLAUDE_RSL_CMD_RE = /src[\\/]hooks[\\/]claude_rsl_hook\.mjs/i;

function parseCliFlags(argv = []) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--event=')) out.event = arg.slice('--event='.length).trim();
    else if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length).trim();
  }
  return out;
}

function readStdinJsonQuick(maxTimeoutMs = 150) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    let raw = '';
    let settled = false;
    let settleTimer = null;

    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        process.stdin.pause();
      } catch {
        // Ignore
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

    const maxTimer = setTimeout(() => done(tryParse()), maxTimeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
      if (settleTimer) clearTimeout(settleTimer);
      if (raw.trim().endsWith('}')) {
        settleTimer = setTimeout(() => {
          try {
            done(JSON.parse(raw));
          } catch {
            // Wait for end or timeout
          }
        }, 2);
      }
    });
    process.stdin.on('end', () => done(tryParse()));
    process.stdin.on('error', () => done({}));
  });
}

function resolveClaudeEvent(payload = {}, options = {}) {
  const explicit = options.event || payload.hook_event_name || payload.hookEventName;
  if (explicit) return String(explicit).trim();
  if ('stop_hook_active' in payload || 'stopHookActive' in payload) return 'Stop';
  if (payload.tool_name || payload.toolName) {
    return 'tool_response' in payload || 'toolResponse' in payload ? 'PostToolUse' : 'PreToolUse';
  }
  return 'SessionStart';
}

/**
 * Programmatic handler for Claude Code RSL hook events.
 * @param {object} [payload={}]
 * @param {object} [options={}]
 */
export function handleClaudeRslHook(payload = {}, options = {}) {
  const event = resolveClaudeEvent(payload, options);
  const stopHookActive = Boolean(payload.stop_hook_active ?? payload.stopHookActive);

  if ((event === 'Stop' || event === 'SessionEnd') && stopHookActive) {
    return {
      exitCode: 0,
      stdoutJson: {},
      event,
      skippedReason: 'stop_hook_active'
    };
  }

  const workspaceRoot = resolveWorkspaceRoot(payload, options);
  const sessionId = sanitizeRslSessionId(
    payload.session_id || payload.sessionId || payload.conversationId || options.sessionId || 'default'
  );

  if (event === 'SessionStart') {
    const snapshot = snapshotTestSuiteBaseline(workspaceRoot, sessionId, options);
    return {
      exitCode: 0,
      stdoutJson: {},
      event,
      snapshot
    };
  }

  if (event === 'PreToolUse') {
    const verdict = evaluatePromotedPreToolGuards(workspaceRoot, 'claude', payload);
    if (verdict.decision === 'deny') {
      return {
        exitCode: 0,
        stdoutJson: {
          permissionDecision: 'deny',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason
          }
        },
        event,
        verdict
      };
    }
    return {
      exitCode: 0,
      stdoutJson: {},
      event,
      verdict
    };
  }

  if (event === 'PostToolUse') {
    const recorded = recordStepOutcome(payload, { ...options, platform: 'claude' });
    return {
      exitCode: 0,
      stdoutJson: {},
      event,
      recorded
    };
  }

  if (event === 'Stop' || event === 'SessionEnd') {
    const digest = buildContrastiveDigest(payload, { ...options, platform: 'claude' });
    const hasLedger = fs.existsSync(getRslLedgerPath(workspaceRoot));
    let distillation = null;
    let ledgerResult = null;

    if (digest.tainted) {
      ledgerResult = ingestDistilledHeuristics(workspaceRoot, {}, digest, options);
    } else if (digest.triggered || hasLedger) {
      distillation = digest.triggered
        ? distillContrastiveDigest(digest, { mode: options.mode || 'local' })
        : { is_valid_learning: false, mode: 'local', heuristics: [] };
      ledgerResult = ingestDistilledHeuristics(workspaceRoot, distillation, digest, options);
    }

    return {
      exitCode: 0,
      stdoutJson: {},
      event,
      digest,
      distillation,
      ledgerResult
    };
  }

  return {
    exitCode: 0,
    stdoutJson: {},
    event
  };
}

/**
 * Registers or removes standalone RSL lifecycle hooks in `<workspaceRoot>/.claude/settings.json`
 * under top-level `"hooks"`, never setting `"disableAllHooks": true`.
 *
 * @param {string} workspaceRoot
 * @param {object} [options={}]
 */
export function syncClaudeWorkspaceRslHooks(workspaceRoot, options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const settingsPath = path.join(baseRoot, '.claude', 'settings.json');
  const pkgRoot = String(options.pkgRoot || RSL_PKG_ROOT).replace(/\\/g, '/').replace(/\/+$/, '');
  const hookScript = `${pkgRoot}/src/hooks/claude_rsl_hook.mjs`;

  let doc = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = { ...parsed };
    } catch {
      doc = {};
    }
  }

  const prevHooks = doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)
    ? { ...doc.hooks }
    : {};

  const stripExisting = (entries) => {
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => {
      const cmds = [
        entry?.command,
        ...(Array.isArray(entry?.hooks) ? entry.hooks.map((h) => h?.command) : [])
      ].map((c) => String(c || ''));
      return !cmds.some((c) => CLAUDE_RSL_CMD_RE.test(c) && !c.includes('--event=PreToolUse'));
    });
  };

  if (options.remove) {
    for (const ev of ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd']) {
      if (Array.isArray(prevHooks[ev])) {
        const remaining = stripExisting(prevHooks[ev]);
        if (remaining.length > 0) prevHooks[ev] = remaining;
        else delete prevHooks[ev];
      }
    }
  } else {
    const mergeEvent = (evName, matcher, flagEvent) => {
      const cleaned = stripExisting(prevHooks[evName]);
      cleaned.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: `node "${hookScript}" --event=${flagEvent}` }]
      });
      prevHooks[evName] = cleaned;
    };
    mergeEvent('SessionStart', 'startup|resume|clear|compact|fork', 'SessionStart');
    mergeEvent('PostToolUse', 'Bash|PowerShell|Edit|MultiEdit|Write|Read|Grep|Glob', 'PostToolUse');
    mergeEvent('Stop', null, 'Stop');
    mergeEvent('SessionEnd', null, 'SessionEnd');
  }

  doc.hooks = prevHooks;
  if (doc.disableAllHooks === true) {
    delete doc.disableAllHooks;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  atomicWriteFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { settingsPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const flags = parseCliFlags(process.argv.slice(2));
  readStdinJsonQuick()
    .then((payload) => {
      const res = handleClaudeRslHook(payload, flags);
      process.stdout.write(`${JSON.stringify(res.stdoutJson ?? {})}\n`);
      process.exit(0);
    })
    .catch(() => {
      process.stdout.write('{}\n');
      process.exit(0);
    });
}
