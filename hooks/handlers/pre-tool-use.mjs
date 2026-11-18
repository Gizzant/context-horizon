/**
 * @file hooks/handlers/pre-tool-use.mjs
 * Thin Tier-2 Command Hook Fast-Shell for `PreToolUse`
 * (`Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 *
 * Imports only `node:module`, `./hookIo.mjs`, and `../../src/hooks/fast_hook_ipc.mjs` so
 * warm daemon IPC and safe bounded-read spawns avoid loading the full ESM engine graph on Windows.
 */

import { createRequire } from 'node:module';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitHardBlockStderr,
  exitWithStdoutJson
} from './hookIo.mjs';
import {
  tryFastDaemonRpc,
  canFastAllowBoundedRead,
  tryTier1PreToolFastPath
} from '../../src/hooks/fast_hook_ipc.mjs';

const requireFromHere = createRequire(import.meta.url);
let _coreMod = null;
function getCoreSync() {
  if (!_coreMod) _coreMod = requireFromHere('./pre-tool-use-core.mjs');
  return _coreMod;
}

/**
 * Synchronous programmatic wrapper delegating to `pre-tool-use-core.mjs`.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 */
export function runPreToolUseHook(event = {}, options = {}) {
  const fast = tryTier1PreToolFastPath(event, options);
  if (fast) return fast;
  return getCoreSync().runPreToolUseHook(event, options);
}

/**
 * Reports an internal PreToolUse fault. By default the tool call is ALLOWED (fail-open, exit 0 with a
 * stderr diagnostic): a bug, crash or stalled stdin inside Highbeam must never stop someone's work.
 * Deliberate guard verdicts (exit 2 from the detectors) are unaffected and still block.
 * Set `HIGHBEAM_PRETOOL_FAIL_MODE=closed` to restore the strict behavior (internal faults block too).
 */
function exitOnInternalFault(err, ioOverride = {}) {
  const msg = err?.message || String(err);
  const strict =
    String(globalThis.process?.env?.HIGHBEAM_PRETOOL_FAIL_MODE || '').toLowerCase() === 'closed';
  if (strict) {
    exitHardBlockStderr(`[Highbeam Fail-Closed] ${msg}`, 'PreToolUse', ioOverride);
    return;
  }
  exitDiagnosticZero(`internal error, tool call allowed (fail-open): ${msg}`, 'PreToolUse', ioOverride);
}

/**
 * CLI runner for `PreToolUse`.
 * Guard verdicts (`exitCode === 2`) block via `exitHardBlockStderr`; any other internal fault
 * fails OPEN (see `exitOnInternalFault`).
 *
 * @param {object} [cliOptions={}]
 */
export async function executePreToolUseCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    const hasCustomOptions = Boolean(cliOptions.runHook || cliOptions.hookOptions);

    if (cliOptions.runHook) {
      const res = cliOptions.runHook(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });
      if (res.exitCode === 2) {
        exitHardBlockStderr(res.stderr, 'PreToolUse', ioOverride);
      } else if (res.stdout) {
        exitWithStdoutJson(res.stdout, ioOverride);
      } else {
        exitPassThrough(ioOverride.exitFn);
      }
      return;
    }

    if (!hasCustomOptions) {
      if (tryTier1PreToolFastPath(payload)) {
        exitPassThrough(ioOverride.exitFn);
        return;
      }

      const ipcRes = await tryFastDaemonRpc(
        'hook.claude.preToolUse',
        { event: payload },
        { ipcPath: cliOptions.ipcPath }
      );
      if (ipcRes && ipcRes.fullVerdict === true) {
        if (ipcRes.exitCode === 2) {
          exitHardBlockStderr(ipcRes.stderr, 'PreToolUse', ioOverride);
        } else if (ipcRes.stdout) {
          exitWithStdoutJson(ipcRes.stdout, ioOverride);
        } else {
          exitPassThrough(ioOverride.exitFn);
        }
        return;
      }

      if (canFastAllowBoundedRead(payload, { platform: 'claude', cwd: payload?.cwd })) {
        exitPassThrough(ioOverride.exitFn);
        return;
      }
    }

    const { runPreToolUseHook: runCore } = await import('./pre-tool-use-core.mjs');
    const res = runCore(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });

    if (res.exitCode === 2) {
      exitHardBlockStderr(res.stderr, 'PreToolUse', ioOverride);
    } else if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitOnInternalFault(err, ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePreToolUseCli().catch((err) => {
    exitOnInternalFault(err);
  });
}
