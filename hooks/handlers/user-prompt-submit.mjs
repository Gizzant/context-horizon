/**
 * @file hooks/handlers/user-prompt-submit.mjs
 * Tier 2 Command Hook handler for `UserPromptSubmit` (`v4.1` Prompt Hygiene Governor:
 * Relay Breaker & Scope Brake).
 *
 * Output contract on Claude Code `UserPromptSubmit`:
 * - Allow / No-op: exit 0 with empty stdout
 * - Steer: exit 0 with `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`
 * - Block: exit 0 with `{"decision":"block","reason":"..."}`
 */

import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { loadHorizonConfig } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import {
  CircuitBreakerEngine,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { runBucketBPromptPass } from '../../src/core/bucket_b_runtime.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';

/**
 * Evaluates a `UserPromptSubmit` hook payload and returns the contract response.
 *
 * @param {object} event
 * @param {object} [options={}]
 */
export function runUserPromptSubmitHook(event = {}, options = {}) {
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
  const effectiveMode =
    event.mode ||
    options.mode ||
    liveState?.flightMode ||
    horizonConfig?.flightMode ||
    'COACH';

  const shouldPersistState =
    !options.engine &&
    options.persistState !== false &&
    Boolean(event.cwd || options.cwd || options.breakerStatePath || options.persistState);

  const priorSnapshot = shouldPersistState
    ? readBreakerStateSnapshot(sessionId, cwdOptions)
    : null;

  const engine =
    options.engine ||
    new CircuitBreakerEngine({
      ...cwdOptions,
      horizonConfig,
      mode: effectiveMode,
      initialState: priorSnapshot
    });

  const verdict = engine.evaluateUserPromptSubmit(
    {
      ...event,
      mode: effectiveMode
    },
    {
      ...liveState,
      flightMode: effectiveMode
    }
  );

  if (shouldPersistState) {
    writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
  }

  if (!verdict.triggered) {
    if (options.bucketBShadow !== false) {
      try {
        const promptText = String(event.prompt ?? event.user_input ?? event.message ?? '');
        const provenance = String(event.provenance || event.source || '');
        const isAutonomousOrSubagent = Boolean(
          event.isAutonomousTurn ||
            event.autonomous ||
            event.isSubagent ||
            event.agentId ||
            event.subagentId ||
            event.isScheduledTask ||
            event.isLoopIteration ||
            /^(?:scheduled|cron|loop|subagent|agent_callback|callback|auto|autonomous|background|system|hook|task_notification|wake)$/i.test(
              provenance
            )
        );
        const cachedDirtyFiles = Array.isArray(event.cachedDirtyFiles)
          ? event.cachedDirtyFiles
          : [
              ...Array.from(engine.modifiedFilesInTurn || []),
              ...(Array.isArray(engine.unverifiedEdits)
                ? engine.unverifiedEdits.map((e) => e?.filePath)
                : []),
              ...(Array.isArray(event.modifiedFiles) ? event.modifiedFiles : [])
            ];
        const hasExplicitCwd = Boolean(event.cwd || options.cwd);
        const promptAnchor = runBucketBPromptPass({
          platform: 'claude',
          sessionId,
          cwd: event.cwd || options.cwd || '',
          hasExplicitCwd,
          prompt: promptText,
          isAutonomousOrSubagent,
          cachedDirtyFiles,
          lastFailingLocation: event.lastFailingLocation ?? engine.lastFailingLocation ?? '',
          options: {
            ...options,
            bucketBStage: event.bucketBStage ?? options.bucketBStage,
            bucketBGammaStage: event.bucketBGammaStage ?? options.bucketBGammaStage,
            mode: effectiveMode,
            horizonConfig
          }
        });
        if (promptAnchor.triggered) {
          const anchorStdoutJson = {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: String(promptAnchor.reason || '').slice(0, 9500)
            }
          };
          return {
            exitCode: 0,
            stdout: JSON.stringify(anchorStdoutJson),
            stdoutJson: anchorStdoutJson,
            stderr: '',
            verdict: {
              triggered: true,
              detectorId: 'VAGUE_PROMPT_ANCHOR',
              subType: 'VAGUE_PROMPT_ANCHOR',
              decision: 'steer',
              anchorContext: promptAnchor.anchorContext,
              savedTokens: promptAnchor.savedTokens,
              reason: promptAnchor.reason
            }
          };
        }
      } catch (_bucketBPrmErr) {
        // Non-fatal Bucket B prompt anchor pass
      }
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict
    };
  }

  if (verdict.decision === 'block') {
    const stdoutJson = {
      decision: 'block',
      reason: verdict.reason
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(stdoutJson),
      stdoutJson,
      stderr: '',
      verdict
    };
  }

  const stdoutJson = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: String(verdict.reason || '').slice(0, 9500)
    }
  };
  return {
    exitCode: 0,
    stdout: JSON.stringify(stdoutJson),
    stdoutJson,
    stderr: '',
    verdict
  };
}

/**
 * CLI runner for `UserPromptSubmit`.
 * Non-blocking prompt hook: exits `0` on uncaught error so developer prompt input is never lost.
 *
 * @param {object} [cliOptions={}]
 */
export async function executeUserPromptSubmitCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runUserPromptSubmitHook;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    const res = runHook(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });
    if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitDiagnosticZero(err?.message || String(err), 'UserPromptSubmit', ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executeUserPromptSubmitCli().catch((err) => {
    exitDiagnosticZero(err?.message || String(err), 'UserPromptSubmit');
  });
}
