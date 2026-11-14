/**
 * @file hooks/handlers/hookIo.mjs
 * Shared stdin JSON reader, `realpathSync` CLI entrypoint resolver, and Claude Code hook
 * exit/JSON contract emitter (`ISS-032`, `ISS-034`, `ISS-035`).
 *
 * Contract:
 * - Pass-through: exit `0` with empty stdout.
 * - Hard block (`exit 2`): write concise diagnostic to `stderr` and exit `2` with EMPTY stdout.
 * - Structured decision (`exit 0` JSON): write valid top-level or `hookSpecificOutput` JSON to `stdout` and exit `0`.
 * - Non-blocking lifecycle error: write diagnostic to `stderr` and exit `0`.
 * - Never register veto exit-2 logic on `WorktreeCreate` or `PermissionRequest`.
 */

import { fs, path, fileURLToPath } from '../../src/utils/nodeIo.mjs';

/**
 * Checks whether the current module is being executed directly as the CLI entrypoint,
 * normalizing symlinks (`npx`, `.bin/*`, junctions) via `fs.realpathSync` (`ISS-032`, `ISS-035`).
 *
 * @param {string} importMetaUrl
 * @param {string} [argv1=globalThis.process?.argv?.[1]]
 * @returns {boolean}
 */
export function isCliEntrypoint(importMetaUrl, argv1 = globalThis.process?.argv?.[1]) {
  if (!importMetaUrl || !argv1) return false;
  try {
    const modulePath = fileURLToPath(importMetaUrl);
    const targetPath = path.resolve(String(argv1));
    try {
      return fs.realpathSync(modulePath) === fs.realpathSync(targetPath);
    } catch {
      return path.normalize(modulePath) === path.normalize(targetPath);
    }
  } catch {
    return false;
  }
}

/**
 * Reads all stdin synchronously (fd 0) when piped, returning `{}` immediately on TTY or empty stdin.
 * Throws a `SyntaxError` on non-empty malformed JSON unless `options.allowMalformed` is `true` (`ISS-061`).
 *
 * @param {{ allowMalformed?: boolean }} [options={}]
 * @returns {object}
 */
export function readStdinJson(options = {}) {
  if (!fs || globalThis.process?.stdin?.isTTY) return {};
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').trim();
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (options?.allowMalformed) return {};
      throw new SyntaxError('Stdin JSON payload must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (options?.allowMalformed) return {};
    throw err;
  }
}

/**
 * Reads piped stdin JSON asynchronously with a bounded timeout (`ISS-035`, `ISS-061`).
 * Resolves `{}` cleanly without hanging if stdin is a TTY or empty/stalled without bytes,
 * and rejects with `SyntaxError` when non-empty stdin is malformed non-object JSON
 * (unless `options.allowMalformed === true`) so guard hooks fail CLOSED (`exit 2`)
 * while advisory hooks fail SAFE (`exit 0`).
 *
 * @param {number} [timeoutMs=2000]
 * @param {any} [stdinStream=globalThis.process?.stdin]
 * @param {{ allowMalformed?: boolean }} [options={}]
 * @returns {Promise<object>}
 */
export function readStdinJsonAsync(
  timeoutMs = 2000,
  stdinStream = globalThis.process?.stdin,
  options = {}
) {
  return new Promise((resolve, reject) => {
    if (!stdinStream || stdinStream.isTTY) {
      resolve({});
      return;
    }

    let raw = '';
    let settled = false;

    const cleanupStream = () => {
      clearTimeout(timer);
      try {
        stdinStream.removeListener('data', onData);
        stdinStream.removeListener('end', onEnd);
        stdinStream.removeListener('error', onError);
        if (typeof stdinStream.pause === 'function') stdinStream.pause();
        if (typeof stdinStream.unref === 'function') stdinStream.unref();
      } catch {
        // Ignore stream cleanup errors
      }
    };

    const finishResolve = (parsedValue) => {
      if (settled) return;
      settled = true;
      cleanupStream();
      resolve(parsedValue);
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanupStream();
      reject(err);
    };

    const settleFromRaw = () => {
      const trimmed = raw.trim();
      if (!trimmed) {
        finishResolve({});
        return;
      }
      try {
        const obj = JSON.parse(trimmed);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          if (options?.allowMalformed) {
            finishResolve({});
            return;
          }
          finishReject(new SyntaxError('Malformed stdin JSON payload: expected JSON object'));
          return;
        }
        finishResolve(obj);
      } catch (err) {
        if (options?.allowMalformed) {
          finishResolve({});
          return;
        }
        finishReject(
          new SyntaxError(`Malformed stdin JSON payload: ${err?.message || String(err)}`)
        );
      }
    };

    const onData = (chunk) => {
      raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    };
    const onEnd = () => settleFromRaw();
    const onError = () => finishResolve({});

    const timer = setTimeout(() => {
      settleFromRaw();
    }, Math.max(10, Number(timeoutMs) || 2000));

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    try {
      if (typeof stdinStream.setEncoding === 'function') {
        stdinStream.setEncoding('utf8');
      }
      stdinStream.on('data', onData);
      stdinStream.on('end', onEnd);
      stdinStream.on('error', onError);
      if (typeof stdinStream.resume === 'function') {
        stdinStream.resume();
      }
    } catch {
      finishResolve({});
    }
  });
}

/**
 * Exits `0` silently with empty stdout (pass-through).
 *
 * @param {Function} [exitFn=globalThis.process?.exit]
 */
export function exitPassThrough(exitFn = globalThis.process?.exit) {
  exitFn?.(0);
}

/**
 * Writes a non-blocking diagnostic message to `stderr` and exits `0` (`ISS-035`).
 *
 * @param {string} reason
 * @param {string} [hookEventName='Hook']
 * @param {{ stderrWrite?: Function, exitFn?: Function }} [ioOverride={}]
 */
export function exitDiagnosticZero(reason, hookEventName = 'Hook', ioOverride = {}) {
  const writeStderr =
    ioOverride.stderrWrite ||
    ioOverride.writeStderr ||
    ((s) => globalThis.process?.stderr?.write?.(s));
  const exitFn = ioOverride.exitFn || globalThis.process?.exit;
  const msg = String(reason || 'Unexpected hook diagnostic').trim();
  writeStderr(`[Highbeam ${hookEventName} Diagnostic] ${msg}\n`);
  exitFn?.(0);
}

/**
 * Exits `2` with concise diagnostic on `stderr` and strictly empty `stdout`.
 * Never used on `WorktreeCreate` or `PermissionRequest`.
 *
 * @param {string} reason
 * @param {string} [hookEventName='PreToolUse']
 * @param {{ stderrWrite?: Function, writeStderr?: Function, exitFn?: Function }} [ioOverride={}]
 */
export function exitHardBlockStderr(reason, hookEventName = 'PreToolUse', ioOverride = {}) {
  const writeStderr =
    ioOverride.stderrWrite ||
    ioOverride.writeStderr ||
    ((s) => globalThis.process?.stderr?.write?.(s));
  const exitFn = ioOverride.exitFn || globalThis.process?.exit;

  if (hookEventName === 'WorktreeCreate' || hookEventName === 'PermissionRequest') {
    exitPassThrough(exitFn);
    return;
  }
  const msg = String(reason || 'Blocked by Highbeam circuit breaker').trim();
  writeStderr(`${msg}\n`);
  exitFn?.(2);
}

/**
 * Emits a serialized JSON string or object to `stdout` and exits `0`.
 *
 * @param {string | object} payload
 * @param {{ stdoutWrite?: Function, writeStdout?: Function, exitFn?: Function }} [ioOverride={}]
 */
export function exitWithStdoutJson(payload, ioOverride = {}) {
  const writeStdout =
    ioOverride.stdoutWrite ||
    ioOverride.writeStdout ||
    ((s) => globalThis.process?.stdout?.write?.(s));
  const exitFn = ioOverride.exitFn || globalThis.process?.exit;
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  writeStdout(`${serialized}\n`);
  exitFn?.(0);
}

/**
 * Emits a structured `{ hookSpecificOutput }` JSON object to `stdout` and exits `0`.
 *
 * @param {object} hookSpecificOutput
 * @param {{ stdoutWrite?: Function, exitFn?: Function }} [ioOverride={}]
 */
export function exitWithHookSpecificOutput(hookSpecificOutput, ioOverride = {}) {
  exitWithStdoutJson({ hookSpecificOutput }, ioOverride);
}

/**
 * Arms a self-timeout fail-closed watchdog below host hook kill deadline (`FM-8`).
 * When triggered before `disarm()`, invokes `onTimeout()` and exits `2` via stderr.
 *
 * @param {object} [options={}]
 */
export function armFailClosedWatchdog(options = {}) {
  const timeoutMs = Math.max(50, Math.min(4500, Number(options.timeoutMs) || 3500));
  const hookEventName = options.hookEventName || 'PreToolUse';
  const ioOverride = options.ioOverride || {};
  const exitFn = ioOverride.exitFn || globalThis.process?.exit;
  const stderrWrite =
    ioOverride.stderrWrite ||
    ioOverride.writeStderr ||
    ((s) => globalThis.process?.stderr?.write?.(s));
  let settled = false;
  let timedOut = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    timedOut = true;
    try {
      if (typeof options.onTimeout === 'function') {
        options.onTimeout({ timeoutMs, hookEventName });
      }
    } catch {
      // ignore timeout callback failure and still fail closed
    }
    const msg = String(
      options.reason ||
        `[Hook Watchdog] ${hookEventName} exceeded ${timeoutMs}ms internal deadline; failing closed (exit 2).`
    ).trim();
    if (hookEventName === 'WorktreeCreate' || hookEventName === 'PermissionRequest') {
      exitFn?.(0);
      return;
    }
    stderrWrite?.(`${msg}\n`);
    exitFn?.(2);
  }, timeoutMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    timeoutMs,
    isTimedOut: () => timedOut,
    disarm: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    }
  };
}
