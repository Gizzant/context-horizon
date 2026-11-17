#!/usr/bin/env node
/**
 * @file src/hooks/post_invocation.mjs
 * Thin Fast-Shell Entrypoint for Google Antigravity `PostInvocation`, `PostToolUse`, and `Stop` hooks.
 */

import {
  tryFastDaemonRpc,
  readStdinFast
} from './fast_hook_ipc.mjs';

export async function readStdinSafe({ maxTimeoutMs = 1000, settleMs = 50 } = {}) {
  return readStdinFast({ maxTimeoutMs, settleMs });
}

export async function handlePostToolUse(inputData = {}) {
  const { handlePostToolUse: impl } = await import('./post_invocation_core.mjs');
  return impl(inputData);
}

export async function handlePostInvocation(inputData = {}) {
  const { handlePostInvocation: impl } = await import('./post_invocation_core.mjs');
  return impl(inputData);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('post_invocation.mjs') || process.argv[1].endsWith('post_invocation.js'));

if (isMain) {
  readStdinFast({ maxTimeoutMs: 250, settleMs: 2 })
    .then(async (input) => {
      const safeInput = input && typeof input === 'object' ? input : {};
      const ipcRes = await tryFastDaemonRpc('hook.antigravity.postInvocation', {
        input: safeInput
      });
      if (ipcRes && ipcRes.fullVerdict === true) {
        return {};
      }
      const { handlePostInvocation: runCore } = await import('./post_invocation_core.mjs');
      return runCore(safeInput);
    })
    .then(() => {
      console.log('{}');
      process.exit(0);
    })
    .catch(() => {
      console.log('{}');
      process.exit(0);
    });
}
