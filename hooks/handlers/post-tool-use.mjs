/**
 * @file hooks/handlers/post-tool-use.mjs
 * Thin Tier-2 Command Hook Fast-Shell for `PostToolUse`
 * (`Bash|PowerShell|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 */

import { createRequire } from 'node:module';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';
import {
  tryFastDaemonRpc,
  tryTier1PostToolFastPath
} from '../../src/hooks/fast_hook_ipc.mjs';

const requireFromHere = createRequire(import.meta.url);
let _coreMod = null;
function getCoreSync() {
  if (!_coreMod) _coreMod = requireFromHere('./post-tool-use-core.mjs');
  return _coreMod;
}

/**
 * Synchronous programmatic wrapper delegating to `post-tool-use-core.mjs`.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 */
export function runPostToolUseHook(event = {}, options = {}) {
  const fast = tryTier1PostToolFastPath(event, options);
  if (fast) return fast;
  return getCoreSync().runPostToolUseHook(event, options);
}

/**
 * CLI runner for `PostToolUse` (`ISS-035`).
 * Non-blocking post hook: logs diagnostic to stderr and exits `0` on uncaught error.
 *
 * @param {object} [cliOptions={}]
 */
export async function executePostToolUseCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    const hasCustomOptions = Boolean(cliOptions.runHook || cliOptions.hookOptions);

    if (cliOptions.runHook) {
      const res = cliOptions.runHook(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });
      if (res.stdout) {
        exitWithStdoutJson(res.stdout, ioOverride);
      } else {
        exitPassThrough(ioOverride.exitFn);
      }
      return;
    }

    if (!hasCustomOptions) {
      if (tryTier1PostToolFastPath(payload)) {
        exitPassThrough(ioOverride.exitFn);
        return;
      }

      const ipcRes = await tryFastDaemonRpc(
        'hook.claude.postToolUse',
        { event: payload },
        { ipcPath: cliOptions.ipcPath }
      );
      if (ipcRes && ipcRes.fullVerdict === true) {
        if (ipcRes.stdout) {
          exitWithStdoutJson(ipcRes.stdout, ioOverride);
        } else {
          exitPassThrough(ioOverride.exitFn);
        }
        return;
      }
    }

    const { runPostToolUseHook: runCore } = await import('./post-tool-use-core.mjs');
    const res = runCore(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });
    if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitDiagnosticZero(err?.message || String(err), 'PostToolUse', ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePostToolUseCli().catch((err) => {
    exitDiagnosticZero(err?.message || String(err), 'PostToolUse');
  });
}
