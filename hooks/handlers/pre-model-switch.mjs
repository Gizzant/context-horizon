/**
 * @file hooks/handlers/pre-model-switch.mjs
 * Tier 2 Command Hook handler for `PreModelSwitch` (`DET-08` Warm KV-Cache Cross-Model Switch Guard).
 */

import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { computeTotalPromptTokens } from '../../src/core-isomorphic/config/catalogLoader.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { CacheGravityRouter } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { recordInterventionSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { requireProFeature } from '../../src/core/pro_license.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitHardBlockStderr,
  exitWithStdoutJson
} from './hookIo.mjs';

/**
 * Evaluates a `PreModelSwitch` event against `CacheGravityRouter` break-even threshold `C*`.
 * @param {object} event
 * @param {object} [options={}]
 */
export function runPreModelSwitchHook(event = {}, options = {}) {
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const det08Override = resolveDetectorOverride('DET-08', horizonConfig);

  if (det08Override === 'off') {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: {
        detectorId: null,
        triggered: false,
        decision: 'allow',
        blocked: false,
        overriddenByConfig: 'off',
        suppressedDetectorId: 'DET-08',
        reason: null
      }
    };
  }

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

  const router =
    options.router ||
    new CacheGravityRouter({
      ...cwdOptions,
      mode: effectiveMode,
      strictBlock:
        det08Override === 'block' ? true : (event.strictBlock ?? options.strictBlock)
    });

  const currentModel =
    event.current_model || event.currentModel || liveState.modelId || 'claude-opus-5-5';
  const targetModel =
    event.target_model || event.targetModel || event.model || 'claude-sonnet-5-5';
  const cachedTokens = Number(
    event.cached_tokens ??
      event.cachedTokens ??
      liveState.contextWindow?.cachedTokens ??
      0
  );
  const cacheWarm =
    event.cache_warm !== undefined
      ? Boolean(event.cache_warm)
      : event.cacheWarm !== undefined
        ? Boolean(event.cacheWarm)
        : Boolean(liveState.promptCache?.warm);

  const uncachedDeltaTokens = Number(
    event.uncached_delta_tokens ?? event.uncachedDeltaTokens ?? 0
  );
  const rawTier =
    event.cache_ttl_tier ??
    event.cacheTtlTier ??
    event.prompt_cache?.ttl ??
    liveState.promptCache?.ttlTier ??
    '5m';
  const cacheTtlTier =
    rawTier === '1h' || rawTier === '3600s' || Number(rawTier) > 300 ? '1h' : '5m';
  const usageSource =
    event.usage || event.context_window?.current_usage || liveState.contextWindow || {};
  const totalPromptTokens = Math.max(
    cachedTokens + uncachedDeltaTokens,
    computeTotalPromptTokens(event),
    computeTotalPromptTokens(usageSource)
  );

  let verdict = router.evaluateModelSwitch({
    currentModel,
    targetModel,
    cachedTokens,
    uncachedDeltaTokens,
    totalPromptTokens,
    cacheWarm,
    cacheTtlTier,
    expectedOutputTokens: event.expectedOutputTokens ?? 1500,
    strictBlock:
      det08Override === 'block' ? true : (event.strictBlock ?? options.strictBlock),
    autoPilotDecision: event.autoPilotDecision ?? options.autoPilotDecision
  });

  if (det08Override === 'warn' && verdict.blocked) {
    verdict = {
      ...verdict,
      decision: 'allow',
      blocked: false,
      advisory: true,
      overriddenByConfig: 'warn'
    };
  } else if (det08Override === 'block' && verdict.breakEven?.shouldHoldModel && !verdict.blocked) {
    verdict = {
      ...verdict,
      decision: 'deny',
      blocked: true,
      advisory: false,
      overriddenByConfig: 'block'
    };
  }

  if (
    (verdict.blocked || verdict.decision === 'ask') &&
    cachedTokens > 0 &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
    const avoidedPenaltyUSD = Math.max(
      0,
      Number(
        verdict.breakEven?.netSwitchSavingsUSD < 0
          ? Math.abs(verdict.breakEven.netSwitchSavingsUSD)
          : verdict.breakEven?.coldTargetTurnUSD || 0
      )
    );
    recordInterventionSavings(
      {
        sessionId,
        category: 'DET_08_MODEL_SWITCH_HOLD',
        modelId: currentModel,
        savedTokens: cachedTokens,
        savedUSD: avoidedPenaltyUSD,
        dedupeId: event.turn_id || event.turnId || `${currentModel}->${targetModel}:${cachedTokens}`,
        detail: `DET-08 held warm prefix (${cachedTokens.toLocaleString()} tok) on ${currentModel} vs ${targetModel}`
      },
      cwdOptions
    );
  }

  if (!verdict.blocked) {
    if (verdict.advisory && verdict.reason) {
      const hookSpecificOutput = {
        hookEventName: 'PreModelSwitch',
        permissionDecision: 'allow',
        additionalContext: verdict.reason
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput }),
        stderr: '',
        verdict
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict
    };
  }

  if (options.useJsonDecision || verdict.decision === 'ask') {
    const hookSpecificOutput = {
      hookEventName: 'PreModelSwitch',
      permissionDecision: verdict.decision === 'ask' ? 'ask' : 'deny',
      permissionDecisionReason: verdict.reason
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify({ hookSpecificOutput }),
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

/**
 * Fail-closed CLI runner for `PreModelSwitch` (`ISS-035`).
 * Any uncaught error exits `2` via `exitHardBlockStderr`.
 *
 * @param {object} [cliOptions={}]
 */
export async function executePreModelSwitchCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runPreModelSwitchHook;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    const res = runHook(payload, cliOptions.hookOptions);
    if (res.exitCode === 2) {
      exitHardBlockStderr(res.stderr, 'PreModelSwitch', ioOverride);
    } else if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitHardBlockStderr(
      `[Highbeam Fail-Closed] ${err?.message || String(err)}`,
      'PreModelSwitch',
      ioOverride
    );
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePreModelSwitchCli().catch((err) => {
    exitHardBlockStderr(
      `[Highbeam Fail-Closed] ${err?.message || String(err)}`,
      'PreModelSwitch'
    );
  });
}
