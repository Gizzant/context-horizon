#!/usr/bin/env node
/**
 * @file src/hooks/antigravity_rsl_hook.mjs
 * Google Antigravity Lifecycle Hook Adapter for Highbeam RSL (`SessionStart`, `PreToolUse`,
 * `PostToolUse`, `Stop`). Runs synchronously in <30ms with 0 LLM tokens by default.
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
  buildContrastiveDigest,
  RSL_ANTIGRAVITY_POST_TOOL_MATCHER,
  isMutatingOrExecRslTool,
  isDuplicateRslStepEvent
} from '../core/rsl_triage.mjs';
import { distillContrastiveDigest } from '../core/rsl_distiller.mjs';
import {
  getRslLedgerPath,
  ingestDistilledHeuristics,
  evaluatePromotedPreToolGuards,
  RSL_PKG_ROOT
} from '../core/rsl_ledger.mjs';

const __filename = fileURLToPath(import.meta.url);

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

function resolveAntigravityEvent(payload = {}, options = {}) {
  const explicit = options.event || payload.hookEventName || payload.hook_event_name;
  if (explicit) return String(explicit).trim();
  if ('fullyIdle' in payload || 'terminationReason' in payload || 'executionNum' in payload) {
    return 'Stop';
  }
  if (payload.toolCall || payload.tool_name) {
    return 'error' in payload ? 'PostToolUse' : 'PreToolUse';
  }
  return 'SessionStart';
}

/**
 * Programmatic handler for Antigravity RSL hook events.
 * @param {object} [payload={}]
 * @param {object} [options={}]
 */
export function handleAntigravityRslHook(payload = {}, options = {}) {
  const event = resolveAntigravityEvent(payload, options);
  const workspaceRoot = resolveWorkspaceRoot(payload, options);
  const sessionId = sanitizeRslSessionId(
    payload.conversationId || payload.session_id || payload.sessionId || options.sessionId || 'default'
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
    const verdict = evaluatePromotedPreToolGuards(workspaceRoot, 'antigravity', payload);
    const stdoutJson = verdict.decision === 'deny'
      ? { decision: 'deny', reason: verdict.reason }
      : { decision: 'allow' };
    return {
      exitCode: 0,
      stdoutJson,
      event,
      verdict
    };
  }

  if (event === 'PostToolUse') {
    const toolName = String(
      payload?.toolCall?.name || payload?.tool_name || payload?.toolName || ''
    ).trim();
    if (toolName && !isMutatingOrExecRslTool(toolName)) {
      return {
        exitCode: 0,
        stdoutJson: {},
        event,
        skippedReason: 'read_only_tool'
      };
    }
    if (isDuplicateRslStepEvent(payload, { ...options, platform: 'antigravity' })) {
      return {
        exitCode: 0,
        stdoutJson: {},
        event,
        deduplicated: true
      };
    }
    const recorded = recordStepOutcome(payload, { ...options, platform: 'antigravity' });
    return {
      exitCode: 0,
      stdoutJson: {},
      event,
      recorded
    };
  }

  if (event === 'Stop') {
    if (payload.fullyIdle === false) {
      return {
        exitCode: 0,
        stdoutJson: { decision: 'allow' },
        event,
        skippedReason: 'fullyIdle_false'
      };
    }

    const digest = buildContrastiveDigest(payload, { ...options, platform: 'antigravity' });
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
      stdoutJson: { decision: 'allow' },
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
 * Registers or removes the `"ctxtop-rsl-postmortem"` hook group in `<workspaceRoot>/.agents/hooks.json`.
 * @param {string} workspaceRoot
 * @param {object} [options={}]
 */
export function syncAntigravityWorkspaceRslHooks(workspaceRoot, options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const hooksPath = path.join(baseRoot, '.agents', 'hooks.json');
  const pkgRoot = String(options.pkgRoot || RSL_PKG_ROOT).replace(/\\/g, '/').replace(/\/+$/, '');
  const hookScript = `${pkgRoot}/src/hooks/antigravity_rsl_hook.mjs`;
  const enabled = options.enabled !== false;

  let doc = {};
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = { ...parsed };
    } catch {
      doc = {};
    }
  }

  if (options.remove) {
    delete doc['ctxtop-rsl-postmortem'];
  } else {
    doc['ctxtop-rsl-postmortem'] = {
      enabled,
      SessionStart: [
        { type: 'command', command: `node "${hookScript}" --event=SessionStart`, timeout: 5 }
      ],
      PostToolUse: [
        {
          matcher: RSL_ANTIGRAVITY_POST_TOOL_MATCHER,
          hooks: [
            { type: 'command', command: `node "${hookScript}" --event=PostToolUse`, timeout: 5 }
          ]
        }
      ],
      Stop: [
        { type: 'command', command: `node "${hookScript}" --event=Stop`, timeout: 15 }
      ]
    };
  }

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  atomicWriteFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { hooksPath, enabled };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const flags = parseCliFlags(process.argv.slice(2));
  readStdinJsonQuick()
    .then((payload) => {
      const res = handleAntigravityRslHook(payload, flags);
      process.stdout.write(`${JSON.stringify(res.stdoutJson ?? {})}\n`);
      process.exit(0);
    })
    .catch(() => {
      process.stdout.write('{"decision":"allow"}\n');
      process.exit(0);
    });
}
