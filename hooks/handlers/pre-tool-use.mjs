/**
 * @file hooks/handlers/pre-tool-use.mjs
 * Tier 2 Command Hook handler for `PreToolUse`
 * (`Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 */

import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { computeTotalPromptTokens } from '../../src/core-isomorphic/config/catalogLoader.mjs';
import { loadHorizonConfig } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { recordInterventionSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  CircuitBreakerEngine,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitHardBlockStderr,
  exitWithStdoutJson
} from './hookIo.mjs';
import { dispatchPreToolUseWithFallback } from './hookIpcClient.mjs';

/**
 * Evaluates a `PreToolUse` hook payload and returns the contract response.
 * Persists stateful breaker counters atomically across separate CLI hook spawns (`ISS-038`).
 *
 * @param {object} event
 * @param {object} [options={}]
 */
export function runPreToolUseHook(event = {}, options = {}) {
  const toolName = String(event.tool_name || event.toolName || '');
  const tier1Active = Boolean(
    options.tier1ModActive ||
    event.tier1ModActive ||
    globalThis.process?.env?.AH_TIER1_MOD_ACTIVE === '1'
  );
  if (tier1Active && /^(Grep|Glob)$/i.test(toolName)) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      fastPath: 'tier1_mod_active',
      verdict: { triggered: false, decision: 'allow', reason: 'Handled in-process by Tier 1 Mod' }
    };
  }
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
  const configHasDiskSource = Boolean(
    horizonConfig?.sources?.projectLoaded || horizonConfig?.sources?.globalLoaded
  );
  const effectiveMode =
    event.mode ||
    options.mode ||
    options.telemetryState?.flightMode ||
    (configHasDiskSource
      ? horizonConfig.flightMode
      : liveState?.flightMode || horizonConfig?.flightMode || 'COACH');

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

  const eventUsage = event.usage || event.context_window?.current_usage || null;
  const computedEventPromptTokens = Math.max(
    computeTotalPromptTokens(event),
    eventUsage ? computeTotalPromptTokens(eventUsage) : 0
  );
  const enrichedEvent = {
    ...event,
    ...(computedEventPromptTokens > 0 && event.totalPromptTokens === undefined
      ? { totalPromptTokens: computedEventPromptTokens }
      : {}),
    mode: event.mode || effectiveMode
  };

  const verdict = engine.evaluatePreToolUse(enrichedEvent, {
    ...liveState,
    flightMode: effectiveMode
  });

  if (shouldPersistState) {
    writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
  }
  if (!verdict.triggered) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict
    };
  }

  const detId = String(verdict.detectorId || '');
  const isQuotaSavingGuard =
    /^(DET-04|DET-06|DET-09|DET-10|DET-11|DET-12|DET-13|DET-14|DET-20)$/.test(detId);
  if (
    isQuotaSavingGuard &&
    (verdict.decision === 'deny' || verdict.decision === 'ask' || verdict.decision === 'defer') &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
    const isPrefixFence = detId === 'DET-09';
    const isBoundedRead = detId === 'DET-11';
    const estimatedSavedTokens = Math.max(
      0,
      Number(
        verdict.savedTokens ||
          verdict.estimatedTokensSaved ||
          (isPrefixFence ? liveState?.contextWindow?.cachedTokens || 25000 : 4000)
      )
    );
    recordInterventionSavings(
      {
        sessionId,
        category: isPrefixFence
          ? 'DET_09_PREFIX_FENCE'
          : isBoundedRead
            ? 'BOUNDED_READ_ENFORCED'
            : 'LOOP_TURN_PREVENTED',
        modelId: liveState?.modelId || 'claude-sonnet-5-5',
        savedTokens: estimatedSavedTokens,
        savedUSD: Math.max(0, Number(verdict.avoidedPenaltyUSD || 0)),
        dedupeId:
          event.tool_use_id ||
          event.toolUseId ||
          event.turn_id ||
          event.turnId ||
          `${detId}:${event.tool_name || event.toolName || 'tool'}`,
        detail: `${detId} intervention (${verdict.decision}): ${String(verdict.reason || '').slice(0, 120)}`
      },
      cwdOptions
    );
  }

  if (verdict.decision === 'ask' || verdict.decision === 'defer') {
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision === 'defer' ? 'defer' : 'ask',
        permissionDecisionReason: verdict.reason
      }
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(out),
      stderr: '',
      verdict
    };
  }

  if (verdict.decision === 'deny') {
    if (options.useJsonDecision) {
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(out),
        stderr: '',
        verdict
      };
    }
    return {
      exitCode: 2,
      stdout: '',
      stderr: verdict.reason,
      verdict
    };
  }

  // ISS-034: Coach advisory on 'allow' uses additionalContext so Claude sees the message!
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: verdict.reason
    }
  };
  return {
    exitCode: 0,
    stdout: JSON.stringify(out),
    stderr: '',
    verdict
  };
}

/**
 * Fail-closed CLI runner for `PreToolUse` (`ISS-035`).
 * Any uncaught error exits `2` via `exitHardBlockStderr` so security/billing guards never fail open.
 *
 * @param {object} [cliOptions={}]
 */
export async function executePreToolUseCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    let res;
    if (cliOptions.runHook) {
      res = cliOptions.runHook(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });
    } else {
      const dispatch = await dispatchPreToolUseWithFallback(payload, {
        persistState: true,
        ...(cliOptions.hookOptions || {})
      });
      if (dispatch.source === 'ipc') {
        const ipcRes = dispatch.result;
        if (ipcRes?.decision === 'deny' || ipcRes?.decision === 'block') {
          res = {
            exitCode: 2,
            stderr: ipcRes.reason || ipcRes.hookSpecificOutput?.permissionDecisionReason || '[Attention Horizon] Tool execution denied'
          };
        } else {
          res = runPreToolUseHook(payload, {
            persistState: true,
            ...(cliOptions.hookOptions || {})
          });
        }
      } else {
        res = dispatch.result;
      }
    }

    if (res.exitCode === 2) {
      exitHardBlockStderr(res.stderr, 'PreToolUse', ioOverride);
    } else if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitHardBlockStderr(
      `[Attention Horizon Fail-Closed] ${err?.message || String(err)}`,
      'PreToolUse',
      ioOverride
    );
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePreToolUseCli().catch((err) => {
    exitHardBlockStderr(
      `[Attention Horizon Fail-Closed] ${err?.message || String(err)}`,
      'PreToolUse'
    );
  });
}
