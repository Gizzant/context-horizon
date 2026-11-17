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

import fs from 'node:fs';
import path from 'node:path';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { loadHorizonConfig } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { resolveEffectiveAutoFlightMode } from '../../src/core/pro_license.mjs';
import {
  evaluateShardedSpecDrift,
  evaluateTurn1ContractGate
} from '../../src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs';
import {
  CircuitBreakerEngine,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  extractEventEffortObservation,
  applyTurnEffortObservation
} from '../../src/core-isomorphic/coach/effortShiftDetector.mjs';
import { atomicWriteFileSync } from '../../src/core/atomic_io.mjs';
import { scorePromptSufficiency } from '../../src/core/prompt_rubric.mjs';
import { sanitizeRslSessionId } from '../../src/core/rsl_triage.mjs';
import { runBucketBPromptPass } from '../../src/core/bucket_b_runtime.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';

function getPromptStatePath(cwd, sessionId) {
  return path.join(
    path.resolve(cwd),
    '.agents',
    'telemetry',
    `prompt_state.${sanitizeRslSessionId(sessionId)}.json`
  );
}

function readPromptStateSnapshot(cwd, sessionId, event = {}) {
  const fallback = {
    initialGoal: String(event.initialGoal || ''),
    specShards: Array.isArray(event.specShards) ? event.specShards : [],
    turnCount: Number(event.turnNumber ? Number(event.turnNumber) - 1 : 0),
    lastAlertTurn: Number(event.lastShardedSpecAlertTurn || 0),
    turn1ContractInjected: Boolean(event.turn1ContractInjected),
    lastConsumedEffortAdvisoryId: null,
    lastObservedEffort: null
  };
  if (!cwd) return fallback;
  const statePath = getPromptStatePath(cwd, sessionId);
  if (!fs.existsSync(statePath)) return fallback;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    parsed = err ? null : null;
  }
  return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
}

function writePromptStateSnapshot(cwd, sessionId, nextState) {
  if (!cwd) return;
  const statePath = getPromptStatePath(cwd, sessionId);
  let writeOk = false;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    atomicWriteFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    writeOk = true;
  } catch (err) {
    writeOk = Boolean(err && false);
  }
  return writeOk;
}

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
  const rawMode =
    event.mode ||
    options.mode ||
    liveState?.flightMode ||
    horizonConfig?.flightMode ||
    'COACH';
  const effectiveMode = resolveEffectiveAutoFlightMode(rawMode, {
    licensePath: options.licensePath || event.licensePath,
    homeDir: options.homeDir || event.homeDir,
    nowMs: options.nowMs,
    strict: Boolean(options.strict ?? event.strict)
  }).effectiveFlightMode;

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
    const resolvedCwd = event.cwd || options.cwd || '';
    const promptText = String(event.prompt ?? event.user_input ?? event.message ?? '');
    if (options.bucketBShadow !== false) {
      try {
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
        const hasExplicitCwd = Boolean(resolvedCwd);
        const promptAnchor = runBucketBPromptPass({
          platform: 'claude',
          sessionId,
          cwd: resolvedCwd,
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
      } catch (err) {
        if (options.onDiagnostic) options.onDiagnostic(err);
      }
    }

    if (promptText.trim().length > 0 && effectiveMode !== 'SILENT' && effectiveMode !== 'OFF') {
      const promptState = readPromptStateSnapshot(shouldPersistState ? resolvedCwd : '', sessionId, event);
      const nextTurnNumber = Number(event.turnNumber ?? (Number(promptState.turnCount || 0) + 1));
      const shardedEval = evaluateShardedSpecDrift({
        prompt: promptText,
        provenance: String(event.provenance || event.source || 'user'),
        isAutonomousTurn: Boolean(event.isAutonomousTurn || event.autonomous),
        isSubagent: Boolean(event.isSubagent || event.agentId || event.subagentId),
        isScheduledTask: Boolean(event.isScheduledTask),
        isLoopIteration: Boolean(event.isLoopIteration),
        priorShards: Array.isArray(event.specShards) ? event.specShards : (promptState.specShards || []),
        initialGoal: event.initialGoal ?? promptState.initialGoal ?? '',
        totalTokens: Number(
          event.totalTokens ?? event.totalInputTokens ?? liveState?.totalTokens ?? liveState?.contextTokens ?? 0
        ),
        turnNumber: nextTurnNumber,
        lastAlertTurn: Number(event.lastShardedSpecAlertTurn ?? promptState.lastAlertTurn ?? 0),
        overrideMode: horizonConfig?.detectors?.['sharded-spec-drift'] || 'default',
        flightMode: effectiveMode,
        detectorId: 'DET-14'
      });

      const activeSet = Array.isArray(liveState?.activeSetPaths) ? liveState.activeSetPaths : [];
      const hasActiveSetMatch = activeSet.some((p) => {
        const base = path.basename(String(p || ''));
        return base && promptText.includes(base);
      });
      const canRunTurn1Gate =
        !shardedEval.triggered &&
        Boolean(resolvedCwd || event.enablePromptContractGate) &&
        (horizonConfig?.detectors?.['turn1-contract-gate'] || 'default') !== 'off';
      const contractEval = canRunTurn1Gate
        ? evaluateTurn1ContractGate({
            prompt: promptText,
            provenance: String(event.provenance || event.source || 'user'),
            isAutonomousTurn: Boolean(event.isAutonomousTurn || event.autonomous),
            isSubagent: Boolean(event.isSubagent || event.agentId || event.subagentId),
            isScheduledTask: Boolean(event.isScheduledTask),
            isLoopIteration: Boolean(event.isLoopIteration),
            inPlanMode: Boolean(event.permission_mode === 'plan' || event.inPlanMode),
            turnNumber: nextTurnNumber,
            invocationNum: Number(event.invocationNum ?? 1),
            alreadyInjected: Boolean(promptState.turn1ContractInjected),
            hasActiveSetMatch,
            sufficiency: scorePromptSufficiency(promptText, { activeSetPaths: activeSet }),
            overrideMode: horizonConfig?.detectors?.['turn1-contract-gate'] || 'default',
            flightMode: effectiveMode,
            detectorId: 'DET-14'
          })
        : { triggered: false };

      if (shouldPersistState && resolvedCwd) {
        writePromptStateSnapshot(resolvedCwd, sessionId, {
          ...promptState,
          initialGoal: shardedEval.initialGoal,
          specShards: shardedEval.specShards,
          turnCount: nextTurnNumber,
          lastAlertTurn: shardedEval.lastAlertTurn,
          turn1ContractInjected: Boolean(promptState.turn1ContractInjected || contractEval.triggered)
        });
      }

      const activeSteer = shardedEval.triggered
        ? {
            subType: shardedEval.subType,
            reason: shardedEval.steerContext,
            extra: { shardCount: shardedEval.shardCount }
          }
        : contractEval.triggered
          ? {
              subType: contractEval.subType,
              reason: contractEval.contractDirective,
              extra: {}
            }
          : null;

      if (activeSteer) {
        const steerStdoutJson = {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: String(activeSteer.reason || '').slice(0, 9500)
          }
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(steerStdoutJson),
          stdoutJson: steerStdoutJson,
          stderr: '',
          verdict: {
            triggered: true,
            detectorId: 'DET-14',
            subType: activeSteer.subType,
            decision: 'steer',
            ...activeSteer.extra,
            reason: activeSteer.reason
          }
        };
      }
    }

    if (effectiveMode !== 'SILENT' && effectiveMode !== 'OFF') {
      const effortPromptState = readPromptStateSnapshot(
        shouldPersistState ? resolvedCwd : '',
        sessionId,
        event
      );
      const eventEffortObs = extractEventEffortObservation(event);
      const baselineEffort =
        effortPromptState.lastObservedEffort ||
        liveState?.effortTracking?.currentEffort ||
        null;
      let activeEffortAdvisory = null;
      let nextObservedEffort = baselineEffort;

      if (eventEffortObs.effortLevel) {
        if (baselineEffort && eventEffortObs.effortLevel !== baselineEffort) {
          const boundaryEval = applyTurnEffortObservation(
            {
              ...(liveState?.effortTracking || {}),
              currentEffort: baselineEffort,
              pendingAdvisory: null
            },
            {
              modelId: event.model || liveState?.rawModelId || liveState?.modelId,
              rawModelId: event.model || liveState?.rawModelId || liveState?.modelId,
              observedEffort: eventEffortObs.effortLevel,
              observedThinkingBudget: eventEffortObs.thinkingBudget,
              turnIndex: Math.max(1, Number(effortPromptState.turnCount || liveState?.turnsCompleted || 1)),
              priorTurnsCompleted: Number(liveState?.turnsCompleted || effortPromptState.turnCount || 0),
              priorModelId: liveState?.rawModelId || liveState?.modelId || null,
              priorWarmPrefixTokens: Number(
                liveState?.contextWindow?.warmPrefixTokens || liveState?.contextWindow?.cachedTokens || 0
              ),
              priorCacheWarm: Boolean(liveState?.promptCache?.warm),
              evaluateThinkingSpike: false,
              ttlTier: liveState?.promptCache?.ttlTier === '1h' ? '1h' : '5m'
            },
            cwdOptions
          );
          activeEffortAdvisory = boundaryEval.pendingAdvisory || null;
        }
        nextObservedEffort = eventEffortObs.effortLevel;
      }

      if (!activeEffortAdvisory && liveState?.effortTracking?.pendingAdvisory) {
        activeEffortAdvisory = liveState.effortTracking.pendingAdvisory;
      }

      if (
        activeEffortAdvisory &&
        activeEffortAdvisory.advisoryId &&
        activeEffortAdvisory.advisoryId !== effortPromptState.lastConsumedEffortAdvisoryId
      ) {
        if (shouldPersistState && resolvedCwd) {
          writePromptStateSnapshot(resolvedCwd, sessionId, {
            ...effortPromptState,
            lastConsumedEffortAdvisoryId: activeEffortAdvisory.advisoryId,
            lastObservedEffort: nextObservedEffort
          });
        }
        const effortStdoutJson = {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: String(activeEffortAdvisory.message || '').slice(0, 9500)
          }
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(effortStdoutJson),
          stdoutJson: effortStdoutJson,
          stderr: '',
          verdict: {
            triggered: true,
            detectorId: activeEffortAdvisory.detectorId,
            subType: activeEffortAdvisory.subType,
            decision: 'steer',
            advisoryId: activeEffortAdvisory.advisoryId,
            reason: activeEffortAdvisory.message
          }
        };
      }

      if (
        shouldPersistState &&
        resolvedCwd &&
        nextObservedEffort &&
        nextObservedEffort !== effortPromptState.lastObservedEffort
      ) {
        writePromptStateSnapshot(resolvedCwd, sessionId, {
          ...effortPromptState,
          lastObservedEffort: nextObservedEffort
        });
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
