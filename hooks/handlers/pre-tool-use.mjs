/**
 * @file hooks/handlers/pre-tool-use.mjs
 * Tier 2 Command Hook handler for `PreToolUse`
 * (`Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { computeTotalPromptTokens } from '../../src/core-isomorphic/config/catalogLoader.mjs';
import { loadHorizonConfig } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { recordInterventionSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { requireProFeature } from '../../src/core/pro_license.mjs';
import { foldCodeToSignatureStub, computeCompactLineDiff } from '../../src/core/pruner.mjs';
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
import {
  runAirlockPreToolBridge,
  recordAirlockWatchdogTimeout
} from '../../src/core/airlock/hookBridge.mjs';
import { armFailClosedWatchdog } from './hookIo.mjs';

export function runPreToolUseHook(event = {}, options = {}) {
  const toolName = String(event.tool_name || event.toolName || '');
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);

  const airlockRes = runAirlockPreToolBridge(event, cwdOptions, { ...options, horizonConfig });
  if (airlockRes?.blocked) {
    return {
      exitCode: airlockRes.exitCode,
      stdout: airlockRes.stdout,
      stderr: airlockRes.stderr,
      verdict: airlockRes.verdict,
      airlock: airlockRes.airlock
    };
  }

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
      verdict: { triggered: false, decision: 'allow', reason: 'Handled in-process by Tier 1 Mod' },
      ...(airlockRes?.airlock ? { airlock: airlockRes.airlock } : {})
    };
  }
  const sessionId = event.session_id || event.sessionId || 'default';
  const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
  const configHasDiskSource = Boolean(
    horizonConfig?.sources?.projectLoaded || horizonConfig?.sources?.globalLoaded
  );
  const rawEffectiveMode =
    event.mode ||
    options.mode ||
    options.telemetryState?.flightMode ||
    (configHasDiskSource
      ? horizonConfig.flightMode
      : liveState?.flightMode || horizonConfig?.flightMode || 'COACH');
  const proAutoPilot =
    rawEffectiveMode === 'AUTO_PILOT' ? requireProFeature('auto_pilot_locks', options) : { allowed: true };
  const effectiveMode =
    rawEffectiveMode === 'AUTO_PILOT' && !proAutoPilot.allowed ? 'COACH' : rawEffectiveMode;

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

  // Playbook Step 4 & VC Gap 4: Post-Edit Unified Delta Diff + 3rd-Read AST Signature Stub Interception
  const isReadTool = /^(Read|read_file)$/i.test(toolName);
  const tIn = event.tool_input || event.toolInput || event.args || {};
  const hasLineBounds =
    tIn.StartLine !== undefined ||
    tIn.EndLine !== undefined ||
    tIn.offset !== undefined ||
    tIn.limit !== undefined;
  const rawReadPath = String(tIn.file_path || tIn.Path || tIn.path || '').trim();

  if (isReadTool && !hasLineBounds && rawReadPath) {
    try {
      const baseCwd = event.cwd || options.cwd || '';
      const absReadPath = path.isAbsolute(rawReadPath)
        ? rawReadPath
        : path.resolve(baseCwd || process.cwd(), rawReadPath);
      if (fs.existsSync(absReadPath) && fs.statSync(absReadPath).isFile()) {
        const st = fs.statSync(absReadPath);
        if (st.size > 256 && st.size <= 256 * 1024) {
          const rawSrc = fs.readFileSync(absReadPath, 'utf8');
          const normKey = absReadPath.replace(/\\/g, '/').toLowerCase();
          let prevSrc = typeof event.priorContentSnapshot === 'string' ? event.priorContentSnapshot : null;
          let snapFilePath = '';
          let snapMap = {};

          if (baseCwd && shouldPersistState) {
            const safeSid = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
            const cacheDir = path.join(baseCwd, '.claude', 'cache');
            snapFilePath = path.join(cacheDir, `read_snapshots_${safeSid}.json`);
            if (fs.existsSync(snapFilePath)) {
              try {
                snapMap = JSON.parse(fs.readFileSync(snapFilePath, 'utf8')) || {};
                if (prevSrc === null && typeof snapMap[normKey] === 'string') {
                  prevSrc = snapMap[normKey];
                }
              } catch (_e) {
                snapMap = {};
              }
            }
          }

          if (prevSrc !== null && prevSrc !== rawSrc) {
            const delta = computeCompactLineDiff(prevSrc, rawSrc, path.basename(absReadPath));
            if (delta.wasDiffed) {
              verdict.triggered = true;
              verdict.detectorId = verdict.detectorId || 'DET-06';
              verdict.decision = verdict.decision || 'allow';
              verdict.deltaDiffStub = delta.diffText;
              verdict.savedTokens = Math.max(Number(verdict.savedTokens || 0), delta.savedTokens);
              verdict.reason = `[GUARD-4 Post-Edit Delta Read] File modified since last read; returning unified delta diff (+${delta.savedTokens} tokens saved):\n${delta.diffText}`;
            }
          } else if (verdict.detectorId === 'DET-06' || Number(event.priorUnclippedReads || 0) >= 2) {
            const folded = foldCodeToSignatureStub(rawSrc, rawReadPath);
            if (folded.wasFolded) {
              const stubSavedTok = Math.max(250, Math.round(folded.savedChars / 4));
              verdict.triggered = true;
              verdict.detectorId = verdict.detectorId || 'DET-06';
              verdict.decision = verdict.decision || 'allow';
              verdict.astSignatureStub = folded.condensed;
              verdict.savedTokens = Math.max(Number(verdict.savedTokens || 0), stubSavedTok);
              verdict.reason = `${verdict.reason ? verdict.reason + '\n\n' : '[GUARD-4 Repeat-Read Surgeon] Full-file re-read intercepted; returning AST signature stub (+' + stubSavedTok + ' tokens saved):\n'}${folded.condensed}`;
            }
          }

          if (snapFilePath && rawSrc.length <= 128 * 1024) {
            try {
              fs.mkdirSync(path.dirname(snapFilePath), { recursive: true });
              const keys = Object.keys(snapMap);
              if (!snapMap[normKey] && keys.length >= 12) {
                delete snapMap[keys[0]];
              }
              snapMap[normKey] = rawSrc;
              fs.writeFileSync(snapFilePath, JSON.stringify(snapMap), 'utf8');
            } catch (_writeErr) {
              void _writeErr;
            }
          }
        }
      }
    } catch (_stubErr) {
      void _stubErr;
    }
  }

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
    (verdict.decision === 'deny' || verdict.decision === 'ask' || verdict.decision === 'defer' || Boolean(verdict.astSignatureStub) || Boolean(verdict.deltaDiffStub)) &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
    const isPrefixFence = detId === 'DET-09';
    const isBoundedRead = detId === 'DET-11' || Boolean(verdict.astSignatureStub) || Boolean(verdict.deltaDiffStub);
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
      additionalContext: verdict.reason,
      ...(verdict.astSignatureStub ? { astSignatureStub: verdict.astSignatureStub, savedTokens: verdict.savedTokens } : {}),
      ...(verdict.deltaDiffStub ? { deltaDiffStub: verdict.deltaDiffStub, savedTokens: verdict.savedTokens } : {})
    }
  };
  return {
    exitCode: 0,
    stdout: JSON.stringify(out),
    stderr: '',
    verdict,
    ...(verdict.astSignatureStub ? { decision: 'allow', astSignatureStub: verdict.astSignatureStub, savedTokens: verdict.savedTokens } : {}),
    ...(verdict.deltaDiffStub ? { decision: 'allow', deltaDiffStub: verdict.deltaDiffStub, savedTokens: verdict.savedTokens } : {})
  };
}

/**
 * Fail-closed CLI runner for `PreToolUse` (`ISS-035`).
 * Any uncaught error exits `2` via `exitHardBlockStderr` so security/billing guards never fail open.
 *
 * @param {object} [cliOptions={}]
 */
async function runPreToolUseWithWatchdog(cliOptions = {}) {
  const watchdogMs = Number(cliOptions.watchdogTimeoutMs) || Number(process.env.AH_AIRLOCK_WATCHDOG_MS) || 3500;
  let capturedPayload = null;
  const hookOpts = cliOptions.hookOptions || {};
  const watchdog = armFailClosedWatchdog({
    timeoutMs: watchdogMs,
    hookEventName: 'PreToolUse',
    ioOverride: cliOptions.ioOverride || {},
    onTimeout: () => {
      const ev = capturedPayload || {};
      const cwdOpts = ev.cwd && !hookOpts.cwd ? { ...hookOpts, cwd: ev.cwd } : hookOpts;
      recordAirlockWatchdogTimeout('PreToolUse', ev, cwdOpts, hookOpts);
    }
  });
  try {
    return await executePreToolUseCli({
      ...cliOptions,
      __airlockWatchdogArmed: true,
      readPayload: async (timeoutMs) => {
        const readFn = cliOptions.readPayload || readStdinJsonAsync;
        capturedPayload = await readFn(timeoutMs);
        return capturedPayload;
      }
    });
  } finally {
    watchdog.disarm();
  }
}

export async function executePreToolUseCli(cliOptions = {}) {
  if (!cliOptions.__airlockWatchdogArmed) {
    return await runPreToolUseWithWatchdog(cliOptions);
  }
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
            stderr: ipcRes.reason || ipcRes.hookSpecificOutput?.permissionDecisionReason || '[Highbeam] Tool execution denied'
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
      `[Highbeam Fail-Closed] ${err?.message || String(err)}`,
      'PreToolUse',
      ioOverride
    );
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePreToolUseCli().catch((err) => {
    exitHardBlockStderr(
      `[Highbeam Fail-Closed] ${err?.message || String(err)}`,
      'PreToolUse'
    );
  });
}
