/**
 * @file hooks/handlers/hookIpcClient.mjs
 * Warm Micro-IPC Hook Dispatcher with Standalone Fallback (Features 29 & 30).
 *
 * Forwards PreToolUse and PostToolUse hook events to the warm Horizon Daemon IPC
 * socket/pipe (<0.8ms SLA), automatically and silently falling back to standalone
 * CLI evaluation within 15ms if the daemon is offline.
 * Strictly 0 npm dependencies (uses only standard node:* built-ins).
 */

import { MicroIpcClient } from '../../src/engine-node/ipc/client.mjs';
import { runPreToolUseHook } from './pre-tool-use.mjs';
import { runPostToolUseHook } from './post-tool-use.mjs';

let sharedClient = null;

/**
 * Returns or creates the shared MicroIpcClient instance for hook handlers.
 *
 * @param {object} [options]
 * @returns {MicroIpcClient}
 */
export function getHookIpcClient(options = {}) {
  if (!sharedClient || options.ipcPath) {
    sharedClient = new MicroIpcClient({
      connectTimeoutMs: options.connectTimeoutMs ?? 15,
      requestTimeoutMs: options.requestTimeoutMs ?? 500,
      ...options
    });
  }
  return sharedClient;
}

/**
 * Dispatches a PreToolUse hook invocation over warm Micro-IPC with fallback to local execution.
 *
 * @param {object} payload
 * @param {object} [options]
 * @returns {Promise<{ source: 'ipc' | 'fallback', result: object, fallbackReason?: string }>}
 */
export async function dispatchPreToolUseWithFallback(payload, options = {}) {
  const client = getHookIpcClient(options);
  return client.callWithFallback(
    'hook.preToolUse',
    payload,
    async (p) => runPreToolUseHook(p, options),
    {
      connectTimeoutMs: options.connectTimeoutMs ?? 15,
      requestTimeoutMs: options.requestTimeoutMs ?? 600000
    }
  );
}

/**
 * Dispatches a PostToolUse hook invocation over warm Micro-IPC with fallback to local execution.
 *
 * @param {object} payload
 * @param {object} [options]
 * @returns {Promise<{ source: 'ipc' | 'fallback', result: object, fallbackReason?: string }>}
 */
export async function dispatchPostToolUseWithFallback(payload, options = {}) {
  const client = getHookIpcClient(options);
  return client.callWithFallback(
    'hook.postToolUse',
    payload,
    async (p) => runPostToolUseHook(p, options),
    { connectTimeoutMs: options.connectTimeoutMs ?? 15 }
  );
}

/**
 * Closes and resets the shared MicroIpcClient instance.
 *
 * @returns {Promise<void>}
 */
export async function closeHookIpcClient() {
  if (sharedClient) {
    const client = sharedClient;
    sharedClient = null;
    await client.close();
  }
}

