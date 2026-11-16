/**
 * @file hooks/handlers/post-model-switch.mjs
 * Standalone Node CLI handler for Claude Code `PostModelSwitch` (`DET-08` acceptance telemetry).
 *
 * Contract note (Claude Code 2.1.x):
 *   Any `stdout` emitted on `PostModelSwitch` with exit 0 is injected as model context on the
 *   next turn, so this handler MUST return empty `stdout` and `stderr` with exit code `0`.
 */

import { recordPostModelSwitchEvent } from '../../src/utils/modelSwitchTelemetry.mjs';
import {
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { isCliEntrypoint, readStdinJsonAsync, exitPassThrough } from './hookIo.mjs';

/**
 * Evaluate `PostModelSwitch` payload and update local acceptance telemetry.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {{ exitCode: number, stdout: string, stderr: string, telemetryRecorded: boolean }}
 */
export function runPostModelSwitchHook(event = {}, options = {}) {
  let telemetryRecorded = false;
  const shouldRecordTelemetry =
    options.recordSwitchTelemetry !== false &&
    Boolean(
      options.cliInvocation ||
        options.homeDir ||
        options.telemetryPath ||
        options.recordSwitchTelemetry ||
        globalThis.process?.env?.AH_MODEL_SWITCH_TELEMETRY_PATH
    );

  if (shouldRecordTelemetry) {
    try {
      recordPostModelSwitchEvent(event, {
        homeDir: options.homeDir,
        telemetryPath: options.telemetryPath
      });
      telemetryRecorded = true;
    } catch {
      // Fail-open: never block or inject stdout context on PostModelSwitch telemetry error
    }
  }

  // Item 4.4: Clear pending_downshift once the model switch actually executes
  const shouldPersistBreaker =
    options.persistState !== false &&
    Boolean(event.cwd || options.cwd || options.breakerStatePath || options.cliInvocation);
  if (shouldPersistBreaker) {
    try {
      const sessionId = event.session_id || event.sessionId || 'default';
      const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
      const snap = readBreakerStateSnapshot(sessionId, cwdOptions);
      if (snap && (snap.pending_downshift || snap.pendingDownshiftModel || snap.justCompacted)) {
        writeBreakerStateSnapshot(
          sessionId,
          {
            ...snap,
            updatedAt: Date.now(),
            pending_downshift: null,
            pendingDownshiftModel: null,
            justCompacted: false
          },
          cwdOptions
        );
      }
    } catch {
      // Fail-open on local state cleanup
    }
  }

  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    telemetryRecorded
  };
}

/**
 * Fail-open CLI runner for `PostModelSwitch`.
 * Always exits `0` with empty stdout/stderr so no extra context is injected.
 *
 * @param {object} [cliOptions={}]
 */
export async function executePostModelSwitchCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runPostModelSwitchHook;
  const ioOverride = cliOptions.ioOverride || {};
  const isRealCliRun =
    !cliOptions.ioOverride && !cliOptions.readPayload && !cliOptions.runHook;
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    runHook(payload, {
      cliInvocation: isRealCliRun,
      ...(cliOptions.hookOptions || {})
    });
  } catch {
    // Fail-open on stdin parse timeout or telemetry errors
  }
  exitPassThrough(ioOverride.exitFn);
}

if (isCliEntrypoint(import.meta.url)) {
  executePostModelSwitchCli().catch(() => {
    exitPassThrough();
  });
}
