/**
 * @file hooks/register.js
 * In-process Mod entrypoint for Attention Horizon (attention-horizon-claude).
 * Compliant with Claude Code Mod static analyzer rules:
 * - Direct literal on('...') calls
 * - No destructuring or variable assignment of $ or $.namespace
 * - Never pass $ or $.* to any function (imported or module-local)
 * - Pure ES modules, strictly relative imports, zero node:* or process.getBuiltinModule
 * - Explicit .catch(...) fail-closed handlers resolving { decision: 'deny' } on tool.call guards
 */

import {
  createInitialTelemetryState,
  ingestModTurnEvent,
  writeLiveStateSnapshot
} from '../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { loadHorizonConfig } from '../src/core-isomorphic/config/horizonConfig.mjs';
import { normalizeFlightMode } from '../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { TtlWatchdog } from '../src/core-isomorphic/coach/ttlWatchdog.mjs';
import { CircuitBreakerEngine } from '../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  handlePreCompactBatonFlush,
  handleSessionStartHydration,
  handlePostCompactFlush
} from '../src/core-isomorphic/coach/stateBatonHydrator.mjs';
import {
  renderAbovePromptBand,
  renderSimpleViewPane,
  renderAdvancedViewPane,
  renderSpinnerSuffix
} from '../src/core-isomorphic/ui/modViews.mjs';
import { recordRuntimeDiagnostic } from '../src/core-isomorphic/utils/runtime.mjs';
import { evaluateToolBoundaryLatch, CONTROL_STATES } from '../src/core-isomorphic/control/index.mjs';

const bootHorizonConfig = loadHorizonConfig();
const ttlWatchdog = new TtlWatchdog({ mode: bootHorizonConfig.flightMode || 'COACH' });
const breakerEngine = new CircuitBreakerEngine({
  mode: bootHorizonConfig.flightMode || 'COACH',
  horizonConfig: bootHorizonConfig
});

let stopWatchdogClock = null;

/**
 * Disposes any active `$.clock.every(1000)` interval handle so headless / completed
 * sessions exit cleanly without dangling timers (`ISS-036`).
 */
function clearWatchdogClock() {
  const handle = stopWatchdogClock;
  stopWatchdogClock = null;
  if (!handle) return;
  try {
    if (typeof handle === 'function') {
      handle();
    } else if (typeof handle.cancel === 'function') {
      handle.cancel();
    } else if (typeof handle.dispose === 'function') {
      handle.dispose();
    } else if (typeof handle.stop === 'function') {
      handle.stop();
    }
  } catch (err) {
    recordRuntimeDiagnostic('hooks/register.js', 'clearWatchdogClock', err);
  }
}

/**
 * Detects non-interactive / headless print mode (`claude -p`) from a plain event payload.
 * @param {object} event
 * @returns {boolean}
 */
function isHeadlessEvent(event) {
  return Boolean(
    event?.headless ||
      event?.printMode ||
      event?.nonInteractive ||
      event?.isHeadless ||
      globalThis.process?.env?.CLAUDE_HEADLESS === '1'
  );
}

/**
 * Resolves the active flight mode from event overrides, `.attention-horizon.json` (when `cwd`
 * is present), or persisted store state, synchronizing `breakerEngine` and `ttlWatchdog` (`ISS-038`).
 *
 * @param {object} event
 * @param {string | undefined | null} storedMode
 * @returns {string}
 */
function resolveActiveModFlightMode(event, storedMode) {
  if (event?.mode) {
    const explicitMode = normalizeFlightMode(event.mode);
    breakerEngine.setMode(explicitMode);
    ttlWatchdog.setMode(explicitMode);
    return explicitMode;
  }
  if (typeof event?.cwd === 'string' && event.cwd.trim()) {
    const cfg = breakerEngine.refreshConfig({ cwd: event.cwd });
    const cfgMode = normalizeFlightMode(cfg?.flightMode || 'COACH');
    ttlWatchdog.setMode(cfgMode);
    return cfgMode;
  }
  if (storedMode) {
    const normStored = normalizeFlightMode(storedMode);
    breakerEngine.setMode(normStored);
    ttlWatchdog.setMode(normStored);
    return normStored;
  }
  return breakerEngine.mode || 'COACH';
}

/**
 * Extracts a target workspace file path from a tool or file-change event.
 * @param {object} event
 * @returns {string}
 */
function extractModEventFilePath(event) {
  const input = event?.tool_input || event?.toolInput || {};
  return String(
    input.file_path ||
      input.notebook_path ||
      input.filePath ||
      input.path ||
      event?.filePath ||
      event?.file_path ||
      event?.path ||
      ''
  );
}

/**
 * Checks whether a `tool.call` event mutates a workspace file (`Edit|MultiEdit|Write|NotebookEdit`).
 * @param {object} event
 * @returns {boolean}
 */
function isWorkspaceEditToolEvent(event) {
  const name = String(event?.tool_name || event?.toolName || '').toLowerCase();
  return (
    name === 'edit' ||
    name === 'multiedit' ||
    name === 'write' ||
    name === 'notebookedit'
  );
}

/**
 * Checks whether a `tool.call` event commits or verifies workspace changes (`git commit` or test runner),
 * clearing the pending-edits flag.
 * @param {object} event
 * @returns {boolean}
 */
function shouldClearRecentEditsOnToolEvent(event) {
  const name = String(event?.tool_name || event?.toolName || '').toLowerCase();
  if (
    name !== 'bash' &&
    name !== 'powershell' &&
    name !== 'pwsh' &&
    name !== 'cmd' &&
    name !== 'sh'
  ) {
    return false;
  }
  const input = event?.tool_input || event?.toolInput || {};
  const cmd = String(input.command || input.cmd || event?.command || '');
  return (
    /\bgit\s+commit\b/i.test(cmd) ||
    /\b(?:npm\s+test|npm\s+run\s+test|pnpm\s+test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|node\s+--test)\b/i.test(
      cmd
    )
  );
}

/**
 * Main Mod registration function.
 * @param {Function} on - Claude Code event registration callback
 */
export default function register(on) {
  clearWatchdogClock();
  ttlWatchdog.clearRecentEdits();
  breakerEngine.hydrateStateSnapshot({
    consecutiveFailures: 0,
    lastFailedToolKey: '',
    sequentialSearchCount: 0,
    fileHashHistory: {},
    modifiedFilesInTurn: [],
    pendingFormatFiles: [],
    codeEditedSinceLastTest: false,
    subagentTurns: {},
    subagentTokens: {},
    pendingBatchEdits: 0
  });

  on('file.changed', async (event, $) => {
    try {
      const changedPath = extractModEventFilePath(event);
      ttlWatchdog.recordFileChanged(changedPath, Date.now());
      $.store.set('ah_recent_file_changed', true);
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'file.changed',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('tool.call', (event, $, next) => {
    return Promise.resolve()
      .then(async () => {
        const storedControl = $.store.get('ah_control_state');
        if (storedControl) {
          const latch = evaluateToolBoundaryLatch(storedControl);
          if (latch.decision === 'deny') {
            $.store.set('ah_last_breaker_verdict', { triggered: true, detectorId: 'CONTROL_ABORT', reason: latch.reason });
            $.ui.invalidate('ui.render');
            return {
              decision: 'deny',
              reason: latch.reason || 'Session aborted by user'
            };
          }
          if (latch.decision === 'allow' && latch.consumeStep) {
            $.store.set('ah_control_state', { ...storedControl, state: CONTROL_STATES.PAUSED, stepRemaining: 0, updatedAt: Date.now() });
          }
        }

        const storedMode = $.store.get('ah_flight_mode');
        const activeMode = resolveActiveModFlightMode(event, storedMode);
        $.store.set('ah_flight_mode', activeMode);

        const telemetry =
          $.store.get('ah_session_telemetry') || createInitialTelemetryState('default');
        const verdict = breakerEngine.evaluatePreToolUse(
          { ...event, mode: event?.mode || activeMode },
          telemetry
        );

        if (verdict.triggered && verdict.decision === 'deny') {
          $.store.set('ah_last_breaker_verdict', verdict);
          $.ui.invalidate('ui.render');
          return {
            decision: 'deny',
            reason: verdict.reason || 'Blocked by Attention Horizon circuit breaker'
          };
        }

        if (verdict.triggered && (verdict.decision === 'ask' || verdict.decision === 'defer')) {
          $.store.set('ah_last_breaker_verdict', verdict);
          $.ui.invalidate('ui.render');
          return {
            decision: verdict.decision === 'defer' ? 'defer' : 'ask',
            reason: verdict.reason || 'Confirmation required by Attention Horizon'
          };
        }

        if (isWorkspaceEditToolEvent(event)) {
          ttlWatchdog.recordFileChanged(extractModEventFilePath(event), Date.now());
          $.store.set('ah_recent_file_changed', true);
          $.store.set('ah_turn_mutations', (Number($.store.get('ah_turn_mutations')) || 0) + 1);
        } else if (shouldClearRecentEditsOnToolEvent(event)) {
          ttlWatchdog.clearRecentEdits();
          $.store.set('ah_recent_file_changed', false);
          $.store.set('ah_turn_mutations', (Number($.store.get('ah_turn_mutations')) || 0) + 1);
        }

        if (verdict.triggered) {
          $.store.set('ah_last_breaker_verdict', verdict);
          $.ui.invalidate('ui.render');
          const downstream = typeof next === 'function' ? await next(event) : undefined;
          return downstream ?? { additionalContext: verdict.reason };
        }

        if (typeof next === 'function') {
          return await next(event);
        }
        return undefined;
      })
      .catch((err) => {
        // ISS-031: Fail CLOSED on any uncaught or timed-out guard error (never re-throw!)
        recordRuntimeDiagnostic(
          'hooks/register.js',
          'tool.call',
          err,
          event?.cwd ? { cwd: event.cwd } : {}
        );
        return {
          decision: 'deny',
          reason: `[Attention Horizon Fail-Closed] ${err?.message || String(err)}`
        };
      });
  });

  on('turn.step', async (event, $) => {
    try {
      const storedMode = $.store.get('ah_flight_mode');
      const activeMode = resolveActiveModFlightMode(event, storedMode);
      $.store.set('ah_flight_mode', activeMode);

      if (event?.fileChanged || event?.hasRecentWorkspaceEdits || isWorkspaceEditToolEvent(event)) {
        ttlWatchdog.recordFileChanged(extractModEventFilePath(event), Date.now());
        $.store.set('ah_recent_file_changed', true);
      }

      const current =
        $.store.get('ah_session_telemetry') || createInitialTelemetryState('default');
      const updated = ingestModTurnEvent(current, {
        ...event,
        flightMode: event?.flightMode || event?.mode || activeMode,
        turnMutations: Number($.store.get('ah_turn_mutations')) || 0,
        type: 'turn.step'
      });
      $.store.set('ah_session_telemetry', updated);
      writeLiveStateSnapshot(
        updated.sessionId || 'default',
        updated,
        event?.cwd ? { cwd: event.cwd } : {}
      );

      if (
        !isHeadlessEvent(event) &&
        updated.promptCache?.warm &&
        !$.store.get('ah_watchdog_clock_started')
      ) {
        $.store.set('ah_watchdog_clock_started', true);
        stopWatchdogClock = $.clock.every(1000, () => {
          try {
            const state = $.store.get('ah_session_telemetry');
            if (!state || !state.promptCache?.warm) {
              clearWatchdogClock();
              $.store.set('ah_watchdog_clock_started', false);
              return;
            }
            const tick = ttlWatchdog.evaluateTick({
              sessionId: state.sessionId,
              modelId: state.modelId,
              cacheWarm: state.promptCache.warm,
              ttlTier: state.promptCache.ttlTier,
              cachedTokens: state.contextWindow?.cachedTokens || 0,
              totalPromptTokens: state.contextWindow?.totalInputTokens || 0,
              expiresAt: state.promptCache.expiresAt,
              hasRecentWorkspaceEdits: Boolean($.store.get('ah_recent_file_changed')),
              mode: $.store.get('ah_flight_mode') || 'COACH'
            });
            $.store.set('ah_ttl_tick', tick);
            if (tick.preSnapshotTriggered && tick.stateBatonSnapshot) {
              $.store.set('ah_state_baton', tick.stateBatonSnapshot);
            }
            if (tick.amberAlertActive) {
              $.ui.invalidate('ui.render');
            }
            if (tick.remainingSeconds <= 0) {
              clearWatchdogClock();
              $.store.set('ah_watchdog_clock_started', false);
            }
          } catch (err) {
            recordRuntimeDiagnostic(
              'hooks/register.js',
              'turn.step.watchdogTick',
              err,
              event?.cwd ? { cwd: event.cwd } : {}
            );
          }
        });
      }
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'turn.step',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('turn.complete', async (event, $) => {
    try {
      const turnId =
        event?.turnId ||
        event?.turn_id ||
        event?.result?.turn_id ||
        event?.result?.id ||
        event?.message?.id ||
        null;
      if (turnId && $.store.get('ah_last_completed_turn_id') === turnId) {
        return;
      }
      if (turnId) {
        $.store.set('ah_last_completed_turn_id', turnId);
      }

      const storedMode = $.store.get('ah_flight_mode');
      const activeMode = resolveActiveModFlightMode(event, storedMode);
      $.store.set('ah_flight_mode', activeMode);

      ttlWatchdog.recordTurnTimestamp(Date.now());
      const current =
        $.store.get('ah_session_telemetry') || createInitialTelemetryState('default');
      const updated = ingestModTurnEvent(current, {
        ...event,
        flightMode: event?.flightMode || event?.mode || activeMode,
        turnMutations: Number($.store.get('ah_turn_mutations')) || 0,
        type: 'turn.complete'
      });
      $.store.set('ah_turn_mutations', 0);
      $.store.set('ah_session_telemetry', updated);
      writeLiveStateSnapshot(
        updated.sessionId || 'default',
        updated,
        event?.cwd ? { cwd: event.cwd } : {}
      );

      if (isHeadlessEvent(event)) {
        clearWatchdogClock();
        $.store.set('ah_watchdog_clock_started', false);
      } else if (updated.promptCache?.warm && !$.store.get('ah_watchdog_clock_started')) {
        $.store.set('ah_watchdog_clock_started', true);
        stopWatchdogClock = $.clock.every(1000, () => {
          try {
            const state = $.store.get('ah_session_telemetry');
            if (!state || !state.promptCache?.warm) {
              clearWatchdogClock();
              $.store.set('ah_watchdog_clock_started', false);
              return;
            }
            const tick = ttlWatchdog.evaluateTick({
              sessionId: state.sessionId,
              modelId: state.modelId,
              cacheWarm: state.promptCache.warm,
              ttlTier: state.promptCache.ttlTier,
              cachedTokens: state.contextWindow?.cachedTokens || 0,
              totalPromptTokens: state.contextWindow?.totalInputTokens || 0,
              expiresAt: state.promptCache.expiresAt,
              hasRecentWorkspaceEdits: Boolean($.store.get('ah_recent_file_changed')),
              mode: $.store.get('ah_flight_mode') || 'COACH'
            });
            $.store.set('ah_ttl_tick', tick);
            if (tick.preSnapshotTriggered && tick.stateBatonSnapshot) {
              $.store.set('ah_state_baton', tick.stateBatonSnapshot);
            }
            if (tick.amberAlertActive) {
              $.ui.invalidate('ui.render');
            }
            if (tick.remainingSeconds <= 0) {
              clearWatchdogClock();
              $.store.set('ah_watchdog_clock_started', false);
            }
          } catch (err) {
            recordRuntimeDiagnostic(
              'hooks/register.js',
              'turn.complete.watchdogTick',
              err,
              event?.cwd ? { cwd: event.cwd } : {}
            );
          }
        });
      }

      $.ui.invalidate('ui.render');
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'turn.complete',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('classic.PreCompact', async (event, $) => {
    try {
      const flushRes = handlePreCompactBatonFlush(
        event,
        event?.cwd ? { cwd: event.cwd } : {}
      );
      $.store.set('ah_state_baton', flushRes.baton);
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'classic.PreCompact',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('classic.SessionStart', async (event, $) => {
    try {
      const storedMode = $.store.get('ah_flight_mode');
      const activeMode = resolveActiveModFlightMode(event, storedMode);
      $.store.set('ah_flight_mode', activeMode);

      const hydrated = handleSessionStartHydration(
        event,
        event?.cwd ? { cwd: event.cwd } : {}
      );
      if (hydrated.hydrated && hydrated.baton) {
        $.store.set('ah_state_baton', hydrated.baton);
      }
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'classic.SessionStart',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('classic.PostCompact', async (event, $) => {
    try {
      const postRes = handlePostCompactFlush(event, {
        ...(event?.cwd ? { cwd: event.cwd } : {}),
        mutationQueue: breakerEngine.router.mutationQueue
      });
      ttlWatchdog.clearRecentEdits();
      $.store.set('ah_recent_file_changed', false);
      $.store.set('ah_last_post_compact', postRes);
      $.ui.invalidate('ui.render');
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'classic.PostCompact',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('classic.Stop', async (event, $) => {
    try {
      clearWatchdogClock();
      $.store.set('ah_watchdog_clock_started', false);
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'classic.Stop',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('command.horizon', async (event, $) => {
    try {
      const rawArgs = String(event?.args || event?.subcommand || event?.viewMode || '').toLowerCase();
      if (rawArgs.includes('advanced')) {
        $.store.set('ah_pane_view_mode', 'advanced');
      } else if (rawArgs.includes('simple')) {
        $.store.set('ah_pane_view_mode', 'simple');
      }
      $.ui.open({
        id: 'attention-horizon',
        title: 'Attention Horizon',
        closeOnEscape: true
      });
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'command.horizon',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
    }
  });

  on('ui.render', async (event, $, next) => {
    try {
      const component = event?.component || event?.surface || 'AbovePrompt';

      if (component === 'Pane' && event?.id !== 'attention-horizon') {
        return typeof next === 'function' ? await next(event) : undefined;
      }

      const telemetry =
        $.store.get('ah_session_telemetry') || createInitialTelemetryState('default');
      const renderOptions = {
        nowMs: event?.nowMs,
        maxCols: event?.maxCols || event?.columns,
        noColor: event?.noColor,
        forceColor: event?.forceColor,
        ansi: event?.ansi,
        flightMode: $.store.get('ah_flight_mode') || 'COACH',
        ttlTick: $.store.get('ah_ttl_tick') || null,
        breakerVerdict: $.store.get('ah_last_breaker_verdict') || null
      };

      if (component === 'Pane' && event?.id === 'attention-horizon') {
        const requestedMode = String(
          event?.viewMode || $.store.get('ah_pane_view_mode') || 'simple'
        ).toLowerCase();
        const pane =
          requestedMode === 'advanced'
            ? renderAdvancedViewPane(telemetry, renderOptions)
            : requestedMode === '4-rank' || requestedMode === 'ranks'
              ? renderSimpleViewPane(telemetry, { ...renderOptions, viewMode: 'SIMPLE_4_RANK' })
              : renderSimpleViewPane(telemetry, renderOptions);
        return {
          ...pane,
          content: pane.text
        };
      }

      if (component === 'Spinner') {
        const downstream = typeof next === 'function' ? await next(event) : '';
        const spinner = renderSpinnerSuffix(telemetry, renderOptions);
        const baseText =
          typeof downstream === 'string'
            ? downstream
            : typeof downstream?.text === 'string'
              ? downstream.text
              : '';
        return {
          ...(typeof downstream === 'object' && downstream ? downstream : {}),
          text: baseText ? `${baseText} ${spinner.suffix}` : spinner.suffix,
          suffix: spinner.suffix
        };
      }

      // Default surface: AbovePrompt 1-line band while chaining await next(event)
      const downstream = typeof next === 'function' ? await next(event) : null;
      const band = renderAbovePromptBand(telemetry, renderOptions);
      if (typeof downstream === 'string' && downstream.length > 0) {
        return `${band.line}\n${downstream}`;
      }
      const downstreamLine =
        typeof downstream === 'object' &&
        downstream &&
        typeof downstream.line === 'string' &&
        downstream.line.length > 0
          ? downstream.line
          : '';
      return {
        ...(typeof downstream === 'object' && downstream ? downstream : {}),
        line: downstreamLine ? `${band.line}\n${downstreamLine}` : band.line,
        band
      };
    } catch (err) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        'ui.render',
        err,
        event?.cwd ? { cwd: event.cwd } : {}
      );
      if (typeof next === 'function') {
        return await next(event);
      }
      return undefined;
    }
  });
}
