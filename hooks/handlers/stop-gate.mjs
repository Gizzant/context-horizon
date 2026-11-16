/**
 * @file hooks/handlers/stop-gate.mjs
 * Tier 2 Command Hook handler for `Stop` (`DET-14` Premature Completion Stop Gate
 * and `DET-15` Batched Stop-Phase Formatter — `ISS-034`, `ISS-035`).
 */

import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { isSilentOrOffMode } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { evaluateSmartCompactSuggestion } from '../../src/core-isomorphic/coach/smartCompactAdvisor.mjs';
import { computeActiveToolsetHash } from '../../src/core-isomorphic/coach/resumeToolsetAuditor.mjs';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { updateSessionCalibrationOnStop } from '../../src/utils/sessionCalibration.mjs';
import {
  evaluateDet14PrematureStopGate,
  evaluateDet15BatchedStopFormatter,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { runBucketBStopPass } from '../../src/core/bucket_b_runtime.mjs';
import { handleClaudeRslHook } from '../../src/hooks/claude_rsl_hook.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';

/**
 * Evaluates a `Stop` hook event for `DET-14` and `DET-15`.
 * Loads `flightMode` from `.attention-horizon.json` and persisted breaker state across CLI spawns (`ISS-038`).
 * Never emits invalid `hookSpecificOutput.permissionDecision` on `Stop` (`ISS-034`):
 * - Blocking (`AUTO_PILOT` & `!stop_hook_active`): returns `exitCode: 0` with `{ decision: 'block', reason }`
 * - Advisory (`COACH` or formatted-files note): returns `exitCode: 0` with `{ systemMessage: reasons }`
 *
 * @param {object} event
 * @param {object} [options={}]
 */
export function runStopGateHook(event = {}, options = {}) {
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const effectiveMode = options.mode || event.mode || horizonConfig?.flightMode || 'COACH';
  const stopHookActive = Boolean(event.stop_hook_active ?? event.stopHookActive);
  const isSessionEnd =
    String(options.phase || event.phase || '').toLowerCase() === 'end' ||
    event.hook_event_name === 'SessionEnd';

  const shouldPersistState =
    options.persistState !== false &&
    Boolean(event.cwd || options.cwd || options.breakerStatePath || options.persistState);

  const breakerSnap = shouldPersistState
    ? readBreakerStateSnapshot(sessionId, cwdOptions)
    : null;

  const rawBgTasks =
    event.active_background_tasks ??
    event.activeBackgroundTasks ??
    event.backgroundTasks ??
    breakerSnap?.activeBackgroundTasks ??
    [];
  const activeBackgroundTasks = Array.isArray(rawBgTasks)
    ? rawBgTasks
        .filter(Boolean)
        .map((t) => (typeof t === 'string' ? t : String(t?.id || t?.command || 'bg_task')))
    : [];
  const bgDrainWarning =
    activeBackgroundTasks.length > 0 && !isSilentOrOffMode(effectiveMode)
      ? `[Highbeam Quota Shield — Orphan Background Drain (#10)] ${activeBackgroundTasks.length} active background task(s) still running (${activeBackgroundTasks.slice(0, 3).join(', ')}). Terminate orphan daemons/watchers to prevent idle token & CPU drain.`
      : null;

  if (isSessionEnd) {
    if (shouldPersistState) {
      const liveEnd = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
      const endContextTokens = Number(
        event.context_tokens ??
          event.contextTokens ??
          event.cached_tokens ??
          event.cachedTokens ??
          liveEnd?.contextWindow?.cachedTokens ??
          breakerSnap?.lastContextTokens ??
          0
      );
      const endModelId = String(
        event.model || event.modelId || liveEnd?.modelId || breakerSnap?.lastModelId || 'claude-sonnet-5-5'
      );
      const toolsetHash = computeActiveToolsetHash(event, cwdOptions);
      writeBreakerStateSnapshot(
        sessionId,
        {
          ...(breakerSnap || {}),
          updatedAt: Date.now(),
          ...(activeBackgroundTasks.length === 0 ? { activeBackgroundTasks: [] } : {}),
          pending_downshift: null,
          pendingDownshiftModel: null,
          justCompacted: false,
          lastToolsetHash: toolsetHash,
          lastContextTokens: endContextTokens,
          lastModelId: endModelId
        },
        cwdOptions
      );
      if (!stopHookActive && Boolean(event.cwd || options.cwd) && options.enableRsl !== false) {
        try {
          handleClaudeRslHook(event, { ...cwdOptions, event: 'SessionEnd' });
        } catch {
          // Fail open for RSL post-mortem
        }
      }
    }
    if (bgDrainWarning) {
      const stdoutJson = { systemMessage: bgDrainWarning };
      return {
        exitCode: 0,
        stdout: JSON.stringify(stdoutJson),
        stdoutJson,
        stderr: '',
        activeBackgroundTasks,
        bgDrainWarning
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      activeBackgroundTasks,
      bgDrainWarning: null
    };
  }

  const hasDirectOutput =
    event.output_tokens !== undefined ||
    event.outputTokens !== undefined ||
    event.usage?.output_tokens !== undefined;
  const shouldPersistCalibration =
    options.persistCalibration !== false &&
    Boolean(
      event.transcript_path ||
        event.transcriptPath ||
        options.calibrationPath ||
        (hasDirectOutput && (options.homeDir || event.cwd || options.cwd))
    );
  const sessionCalibration = shouldPersistCalibration
    ? updateSessionCalibrationOnStop(event, cwdOptions)
    : null;

  if (stopHookActive) {
    if (shouldPersistState && breakerSnap) {
      writeBreakerStateSnapshot(
        sessionId,
        {
          ...breakerSnap,
          updatedAt: Date.now(),
          modifiedFilesInTurn: [],
          editedFiles: [],
          pendingFormatFiles: [],
          turnFileDiffs: [],
          codeEditedSinceLastTest: false
        },
        cwdOptions
      );
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionCalibration,
      det14: {
        detectorId: 'DET-14',
        triggered: false,
        stopHookActive: true,
        decision: 'allow',
        advisory: false,
        reason: null
      },
      det15: {
        detectorId: 'DET-15',
        triggered: false,
        filesToFormat: [],
        batchCommand: null
      }
    };
  }

  const editedFiles = Array.isArray(event.editedFiles)
    ? event.editedFiles
    : Array.isArray(breakerSnap?.modifiedFilesInTurn)
      ? breakerSnap.modifiedFilesInTurn
      : [];

  const codeEditedSinceLastTest =
    event.codeEditedSinceLastTest !== undefined
      ? Boolean(event.codeEditedSinceLastTest)
      : breakerSnap?.codeEditedSinceLastTest !== undefined
        ? Boolean(breakerSnap.codeEditedSinceLastTest)
        : editedFiles.length > 0;

  const modifiedFilesForFormat =
    event.modifiedFiles ||
    event.editedFiles ||
    breakerSnap?.pendingFormatFiles ||
    breakerSnap?.modifiedFilesInTurn ||
    [];

  let det14 = evaluateDet14PrematureStopGate({
    stopHookActive,
    codeEditedSinceLastTest,
    editedFiles,
    mode: effectiveMode
  });

  const det14Override = resolveDetectorOverride('DET-14', horizonConfig);
  if (!stopHookActive) {
    if (det14Override === 'off') {
      det14 = {
        detectorId: 'DET-14',
        triggered: false,
        stopHookActive: false,
        decision: 'allow',
        advisory: false,
        overriddenByConfig: 'off',
        reason: null
      };
    } else if (det14Override === 'warn' && det14.decision === 'block') {
      det14 = {
        ...det14,
        decision: 'allow',
        advisory: true,
        overriddenByConfig: 'warn'
      };
    } else if (det14Override === 'block' && codeEditedSinceLastTest) {
      const fileSummary = editedFiles.slice(0, 4).join(', ') || 'workspace source files';
      det14 = {
        detectorId: 'DET-14',
        triggered: true,
        stopHookActive: false,
        decision: 'block',
        advisory: false,
        overriddenByConfig: 'block',
        reason:
          det14.reason ||
          `[DET-14 Premature Stop Gate] Modified ${fileSummary} without running verification tests.`
      };
    }
  }

  const det15Override = resolveDetectorOverride('DET-15', horizonConfig);
  const suppressDet15 =
    det15Override === 'off' ||
    (isSilentOrOffMode(effectiveMode) && det15Override !== 'warn' && det15Override !== 'block');

  const det15 = suppressDet15
    ? { detectorId: 'DET-15', triggered: false, filesToFormat: [], batchCommand: null }
    : evaluateDet15BatchedStopFormatter({
        modifiedFiles: modifiedFilesForFormat
      });

  let stopPass = null;
  if (
    !isSessionEnd &&
    !stopHookActive &&
    det14.decision !== 'block' &&
    String(effectiveMode).toUpperCase() !== 'OFF' &&
    options.bucketBShadow !== false &&
    event.bucketBShadow !== false
  ) {
    const turnFileDiffs = Array.isArray(event.fileDiffs)
      ? event.fileDiffs
      : Array.isArray(breakerSnap?.turnFileDiffs)
        ? breakerSnap.turnFileDiffs
        : [];
    const lastUserPrompt = String(
      event.lastUserPrompt ?? event.prompt ?? breakerSnap?.lastUserPrompt ?? ''
    );
    if (turnFileDiffs.length > 0) {
      try {
        stopPass = runBucketBStopPass({
          platform: 'claude',
          sessionId,
          cwd: event.cwd || options.cwd || '',
          hasExplicitCwd: Boolean(event.cwd || options.cwd),
          fileDiffs: turnFileDiffs,
          lastUserPrompt,
          options: { ...options, mode: effectiveMode, horizonConfig }
        });
      } catch (_stopPassErr) {
        stopPass = null;
      }
    }
  }

  const liveForStop =
    shouldPersistState ||
    event.smartCompactBoundarySuggest !== undefined ||
    options.smartCompactBoundarySuggest !== undefined ||
    horizonConfig?.thresholds?.smartCompactBoundarySuggest
      ? (options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions))
      : null;
  const currentContextTokens = Number(
    event.context_tokens ??
      event.contextTokens ??
      event.cached_tokens ??
      event.cachedTokens ??
      liveForStop?.contextWindow?.cachedTokens ??
      breakerSnap?.lastContextTokens ??
      0
  );
  const currentModelId = String(
    event.model ||
      event.modelId ||
      liveForStop?.modelId ||
      breakerSnap?.lastModelId ||
      'claude-sonnet-5-5'
  );
  const effectiveTurnsSinceLastCompact =
    event.turns_since_last_compact ??
    event.turnsSinceLastCompact ??
    breakerSnap?.turnsSinceLastCompact ??
    null;
  const boundaryReached = Boolean(
    event.boundary_detected ?? event.boundaryDetected ?? breakerSnap?.turnBoundaryReached
  );
  const midDebugActive = Boolean(
    event.mid_debug ??
      event.midDebug ??
      breakerSnap?.turnMidDebug ??
      breakerSnap?.taskBoundaryState?.openFailure
  );
  const smartCompactSuggestion =
    det14.decision === 'block' ||
    stopPass?.decision === 'block' ||
    isSilentOrOffMode(effectiveMode) ||
    stopHookActive
      ? { shouldSuggest: false, suppressedReason: 'blocked_or_silent', detectorStatus: 'unverified', message: null }
      : evaluateSmartCompactSuggestion(
          {
            enabled:
              event.smartCompactBoundarySuggest ??
              options.smartCompactBoundarySuggest ??
              horizonConfig?.thresholds?.smartCompactBoundarySuggest ??
              false,
            detectorState: midDebugActive
              ? 'mid_debug'
              : boundaryReached
                ? 'task_boundary'
                : (event.detectorState || 'other'),
            boundaryDetected: boundaryReached,
            openFailure: Boolean(breakerSnap?.taskBoundaryState?.openFailure),
            consecutiveFailures: Number(breakerSnap?.consecutiveFailures || 0),
            turnsSinceLastCompact: effectiveTurnsSinceLastCompact,
            modelId: currentModelId,
            preCompactTokens: currentContextTokens,
            cacheTtlTier: liveForStop?.promptCache?.ttlTier === '1h' ? '1h' : '5m',
            expectedRemainingRequests:
              event.expected_remaining_requests ?? event.expectedRemainingRequests,
            expectedRemainingTurns:
              event.expected_remaining_turns ??
              event.expectedRemainingTurns ??
              horizonConfig?.expectedRemainingTurns,
            turnsCompleted: sessionCalibration?.turnsCompleted ?? liveForStop?.turnsCompleted ?? 0,
            apiCallsCompleted: sessionCalibration?.apiCallsCompleted,
            requestsPerTurn:
              event.requests_per_turn ??
              event.requestsPerTurn ??
              sessionCalibration?.requestsPerTurn,
            contextGrowthPerTurn: sessionCalibration?.rollingMedianPromptGrowthTokens,
            contextCeiling: liveForStop?.contextWindow?.contextCeiling
          },
          { ...cwdOptions, horizonConfig }
        );

  if (shouldPersistState && det14.decision !== 'block') {
    const nextTurnsSinceCompact =
      typeof breakerSnap?.turnsSinceLastCompact === 'number' &&
      Number.isFinite(breakerSnap.turnsSinceLastCompact)
        ? breakerSnap.turnsSinceLastCompact + 1
        : null;
    const toolsetHash =
      event.cwd || cwdOptions.cwd || event.tools || event.mcp_servers || options.cliArgs || event.cliArgs
        ? computeActiveToolsetHash(event, cwdOptions)
        : (breakerSnap?.lastToolsetHash || null);
    writeBreakerStateSnapshot(
      sessionId,
      {
        ...(breakerSnap || {}),
        updatedAt: Date.now(),
        modifiedFilesInTurn: [],
        editedFiles: [],
        pendingFormatFiles: [],
        turnFileDiffs: [],
        codeEditedSinceLastTest: false,
        justCompacted: false,
        turnBoundaryReached: false,
        turnMidDebug: false,
        ...(nextTurnsSinceCompact !== null ? { turnsSinceLastCompact: nextTurnsSinceCompact } : {}),
        ...(toolsetHash ? { lastToolsetHash: toolsetHash } : {}),
        lastContextTokens: currentContextTokens,
        lastModelId: currentModelId
      },
      cwdOptions
    );
    if (!stopHookActive && Boolean(event.cwd || options.cwd) && options.enableRsl !== false) {
      try {
        handleClaudeRslHook(event, { ...cwdOptions, event: 'Stop' });
      } catch {
        // Fail open for RSL post-mortem
      }
    }
  }

  if (det14.decision === 'block') {
    const locSuffix = breakerSnap?.lastFailingLocation
      ? ` (last failing location: ${breakerSnap.lastFailingLocation})`
      : '';
    const stdoutJson = {
      decision: 'block',
      reason: `${det14.reason}${locSuffix}`
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(stdoutJson),
      stdoutJson,
      stderr: '',
      sessionCalibration,
      det14,
      det15,
      smartCompactSuggestion,
      activeBackgroundTasks
    };
  }

  if (stopPass?.triggered && stopPass.decision === 'block') {
    const stdoutJson = {
      decision: 'block',
      reason: stopPass.reason
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(stdoutJson),
      stdoutJson,
      stderr: '',
      sessionCalibration,
      det14,
      det15,
      smartCompactSuggestion,
      overengineeringGate: stopPass,
      activeBackgroundTasks
    };
  }

  if (det14.advisory || det15.triggered || bgDrainWarning || stopPass?.triggered || smartCompactSuggestion.shouldSuggest) {
    const reasons = [
      det14.advisory ? det14.reason : null,
      det15.batchCommand ? `Batch format: ${det15.batchCommand}` : null,
      bgDrainWarning,
      stopPass?.triggered ? stopPass.reason : null,
      smartCompactSuggestion.shouldSuggest ? smartCompactSuggestion.message : null
    ]
      .filter(Boolean)
      .join(' | ');
    const stdoutJson = {
      systemMessage: reasons
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(stdoutJson),
      stdoutJson,
      stderr: '',
      sessionCalibration,
      det14,
      det15,
      smartCompactSuggestion,
      ...(stopPass ? { overengineeringGate: stopPass } : {}),
      activeBackgroundTasks
    };
  }

  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    sessionCalibration,
    det14,
    det15,
    smartCompactSuggestion,
    ...(stopPass ? { overengineeringGate: stopPass } : {}),
    activeBackgroundTasks
  };
}

/**
 * CLI runner for `Stop` and `SessionEnd` (`--phase=end`) (`ISS-035`).
 * Non-blocking lifecycle hook on uncaught internal error: logs diagnostic to stderr and exits `0`.
 *
 * @param {object} [cliOptions={}]
 */
export async function executeStopGateCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runStopGateHook;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const argv = cliOptions.argv || globalThis.process?.argv || [];
    const phaseArg = argv.find((a) => String(a).startsWith('--phase='));
    const explicitPhase = phaseArg ? String(phaseArg).split('=')[1] : undefined;
    const payload = await readPayload(cliOptions.timeoutMs);
    const res = runHook(payload, {
      persistState: true,
      ...(cliOptions.hookOptions || {}),
      ...(explicitPhase ? { phase: explicitPhase } : {})
    });
    if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitDiagnosticZero(err?.message || String(err), 'StopGate', ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executeStopGateCli().catch((err) => {
    exitDiagnosticZero(err?.message || String(err), 'StopGate');
  });
}
