#!/usr/bin/env node
/**
 * @file hooks/post_tool_use.mjs
 * Thin Fast-Shell for root `hooks.json` `PostToolUse`.
 */

import {
  tryFastDaemonRpc,
  readStdinFast
} from '../src/hooks/fast_hook_ipc.mjs';

readStdinFast({ maxTimeoutMs: 250, settleMs: 2 })
  .then(async (input) => {
    const ipcRes = await tryFastDaemonRpc('hook.antigravity.strictPostToolUse', { input });
    if (ipcRes && ipcRes.fullVerdict === true) {
      return {};
    }

    if (input?.workspacePaths?.[0] || input?.cwd) {
      try {
        const { handleAntigravityRslHook } = await import('../src/hooks/antigravity_rsl_hook.mjs');
        handleAntigravityRslHook(input, { event: 'PostToolUse' });
      } catch {
        // Fail open for RSL step telemetry
      }
    }
    const { runStrictPostToolUse } = await import('../src/hooks/portfolio_runtime.mjs');
    await runStrictPostToolUse(input);
    return {};
  })
  .then(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
