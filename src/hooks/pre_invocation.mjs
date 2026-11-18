#!/usr/bin/env node
/**
 * @file src/hooks/pre_invocation.mjs
 * Thin Fast-Shell Entrypoint for Google Antigravity `PreInvocation` and `PreToolUse` hooks.
 *
 * Imports only `node:module` and `./fast_hook_ipc.mjs` on startup so warm daemon IPC
 * and bounded workspace reads execute in ~55-58ms on Windows before lazily loading
 * `pre_invocation_core.mjs`.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tryFastDaemonRpc,
  canFastAllowBoundedRead,
  readStdinFast
} from './fast_hook_ipc.mjs';
import { normalizeAntigravityToolPayload } from './antigravity_payload.mjs';

const requireFromHere = createRequire(import.meta.url);
let _routerMod = null;
function getRouterModSync() {
  if (!_routerMod) _routerMod = requireFromHere('../core/task_quota_router.mjs');
  return _routerMod;
}

export function classifyTaskComplexity(...args) {
  return getRouterModSync().classifyTaskComplexity(...args);
}

export function evaluateTaskAndQuotaRoute(...args) {
  return getRouterModSync().evaluateTaskAndQuotaRoute(...args);
}

export class CacheGravityScorer {
  constructor(...args) {
    const { CacheGravityScorer: Impl } = getRouterModSync();
    return new Impl(...args);
  }
}

export class TaskMdDirectiveWatcher {
  constructor(...args) {
    const { TaskMdDirectiveWatcher: Impl } = getRouterModSync();
    return new Impl(...args);
  }
}

export class ModelSelectorActuator {
  constructor(...args) {
    const { ModelSelectorActuator: Impl } = getRouterModSync();
    return new Impl(...args);
  }
}

export async function handlePreToolUse(inputData = {}) {
  const { handlePreToolUse: impl } = await import('./pre_invocation_core.mjs');
  return impl(inputData);
}

export async function handlePreInvocation(inputData = {}) {
  const { handlePreInvocation: impl } = await import('./pre_invocation_core.mjs');
  return impl(inputData);
}

/**
 * Sanitizes internal hook return payloads into strict Antigravity protojson-compatible
 * CLI stdout objects (no unknown fields like flightMode, active_model_id, swarmTtlBadges).
 */
export function toProtoSafePreHookOutput(output, { isPreToolUse = false } = {}) {
  const out = output && typeof output === 'object' ? output : {};
  if (isPreToolUse) {
    const rawDecision = String(out.decision || '').toLowerCase();
    let decision = 'allow';
    if (
      rawDecision === 'deny' ||
      rawDecision === 'block' ||
      out.blocked === true ||
      out.terminationBehavior === 'terminate'
    ) {
      decision = 'deny';
    } else if (rawDecision === 'ask') {
      decision = 'ask';
    }
    const reasonText =
      out.reason || out.errorMessage?.userMessage || out.userMessage || out.systemMessage || out.ephemeralMessage;
    if (decision !== 'allow' && reasonText) {
      return { decision, reason: String(reasonText) };
    }
    return { decision };
  }

  if (out.terminationBehavior === 'terminate') {
    const userMessage = String(
      out.errorMessage?.userMessage ||
        out.userMessage ||
        out.reason ||
        out.systemMessage ||
        'Halted by Highbeam Flightcheck'
    );
    // Documented Antigravity PreInvocation stop: https://antigravity.google/docs/hooks
    return {
      injectSteps: [{ errorMessage: { userMessage } }],
      terminationBehavior: 'terminate'
    };
  }
  const advisory = out.ephemeralMessage || out.systemMessage;
  if (typeof advisory === 'string' && advisory.trim().length > 0) {
    return { ephemeralMessage: advisory };
  }
  return {};
}

/**
 * Opt-in hook trace for diagnosing whether Antigravity fires this hook and what it gets back.
 * Off unless `~/.ctxtop/hook_trace.on` exists. Writes `~/.ctxtop/hook_trace.jsonl`
 * (event, tool, first 160 chars of the command, our reply, route). Never throws.
 */
let traceWriteError = null;

function traceHookCall(input, reply, route) {
  try {
    const dir = path.join(os.homedir(), '.ctxtop');
    if (!fs.existsSync(path.join(dir, 'hook_trace.on'))) return;
    const ti = (input && (input.tool_input || input.toolInput || input.arguments)) || {};
    const cmd = typeof ti === 'object' ? ti.command || ti.CommandLine || ti.cmd || '' : String(ti);
    fs.appendFileSync(
      path.join(dir, 'hook_trace.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        script: 'pre_invocation',
        argvEvent: process.argv.find((a) => a.startsWith('--event=')) || null,
        inputKeys: input && typeof input === 'object' ? Object.keys(input).slice(0, 40) : [],
        toolCallKeys: input?.toolCall && typeof input.toolCall === 'object' ? Object.keys(input.toolCall) : null,
        hookEvent: input?.hook_event_name || input?.event || null,
        tool: input?.tool_name || input?.toolName || null,
        command: String(cmd || '').slice(0, 160),
        route,
        reply
      }) + '\n'
    );
  } catch (err) {
    // Tracing must never affect the hook: note the failure on the reply route and carry on.
    traceWriteError = String(err?.code || err?.message || err).slice(0, 80);
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('pre_invocation.mjs') || process.argv[1].endsWith('pre_invocation.js'));
const isPreToolUseCli = process.argv.includes('--event=PreToolUse');

if (isMain) {
  let detectedPreToolUse = isPreToolUseCli;
  let tracedInput = null;
  let route = 'core';
  readStdinFast({ maxTimeoutMs: 250, settleMs: 2 })
    .then(async (input) => {
      const safeInput = normalizeAntigravityToolPayload(input && typeof input === 'object' ? input : {});
      tracedInput = safeInput;
      if (isPreToolUseCli && !safeInput.hook_event_name) {
        safeInput.hook_event_name = 'PreToolUse';
      }
      if (
        safeInput.hook_event_name === 'PreToolUse' ||
        safeInput.event === 'PreToolUse' ||
        safeInput.tool_name ||
        safeInput.toolName
      ) {
        detectedPreToolUse = true;
      }

      const ipcRes = await tryFastDaemonRpc('hook.antigravity.preInvocation', {
        input: safeInput,
        isPreToolUse: detectedPreToolUse
      });
      if (ipcRes && ipcRes.fullVerdict === true && ipcRes.safeOut) {
        route = 'daemon';
        return { _fastSafeOut: ipcRes.safeOut };
      }

      if (detectedPreToolUse && canFastAllowBoundedRead(safeInput, { platform: 'antigravity' })) {
        route = 'fast-allow-read';
        return { _fastSafeOut: { decision: 'allow' } };
      }

      const { handlePreInvocation: runCore } = await import('./pre_invocation_core.mjs');
      return runCore(safeInput);
    })
    .then((output) => {
      const safeOut =
        output && output._fastSafeOut
          ? output._fastSafeOut
          : toProtoSafePreHookOutput(output, { isPreToolUse: detectedPreToolUse });
      traceHookCall(tracedInput, safeOut, route);
      console.log(JSON.stringify(safeOut));
      process.exit(0);
    })
    .catch((err) => {
      const fallback = detectedPreToolUse ? { decision: 'allow' } : {};
      traceHookCall(tracedInput, fallback, `error-fail-open: ${String(err?.message || err).slice(0, 200)}`);
      console.log(JSON.stringify(fallback));
      process.exit(0);
    });
}
