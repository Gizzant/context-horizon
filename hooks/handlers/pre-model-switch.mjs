/**
 * @file hooks/handlers/pre-model-switch.mjs
 * Tier 2 Command Hook handler for `PreModelSwitch` (`DET-08` Warm KV-Cache Cross-Model Switch Guard).
 */

import { fs, path, os, readJsonSafe, writeJsonAtomic } from '../../src/utils/nodeIo.mjs';
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

const PRIOR_CACHE_TTL_MS = 3_600_000;

/**
 * Samples recent local Claude Code session assistant-turn counts (read-only, bounded to 50 files,
 * 1h disk cache under `<cwd>/.claude/cache/ah_session_prior.json`) when `useEmpiricalHorizonPrior`
 * is active and explicit `historicalSessionApiCalls` were not passed.
 *
 * @param {object} [options={}]
 * @returns {number[] | null}
 */
function loadLocalClaudeSessionApiCalls(options = {}) {
  if (Array.isArray(options.historicalSessionApiCalls)) {
    return options.historicalSessionApiCalls;
  }
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const cachePath = path.join(cwd, '.claude', 'cache', 'ah_session_prior.json');
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const cached = readJsonSafe(cachePath, null, options);
  if (
    cached &&
    Array.isArray(cached.apiCounts) &&
    Number.isFinite(cached.sampledAtMs) &&
    nowMs - cached.sampledAtMs < PRIOR_CACHE_TTL_MS
  ) {
    return cached.apiCounts;
  }

  try {
    const home = options.homeDir || os.homedir();
    const ccProjects = path.join(home, '.claude', 'projects');
    if (!fs.existsSync(ccProjects)) return null;

    const jsonlFiles = [];
    const queue = [ccProjects];
    while (queue.length > 0 && jsonlFiles.length < 150) {
      const dir = queue.shift();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'subagents') queue.push(full);
        } else if (entry.name.endsWith('.jsonl')) {
          const st = fs.statSync(full);
          if (st.size >= 512 && st.size <= 5_000_000) {
            jsonlFiles.push({ path: full, mtimeMs: st.mtimeMs });
          }
        }
      }
    }
    jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const apiCounts = [];
    for (const item of jsonlFiles.slice(0, 50)) {
      let fd = null;
      try {
        fd = fs.openSync(item.path, 'r');
        const txt = fs.readFileSync(fd, 'utf8');
        let assistantTurns = 0;
        for (const line of txt.split(/\r?\n/)) {
          if (line.includes('"type":"assistant"')) assistantTurns += 1;
        }
        if (assistantTurns >= 2) apiCounts.push(assistantTurns);
      } catch {
        // Ignore unreadable session file
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close failure
          }
        }
      }
    }
    if (apiCounts.length >= 5) {
      writeJsonAtomic(cachePath, { sampledAtMs: nowMs, apiCounts }, options);
      return apiCounts;
    }
  } catch {
    // Fallback to built-in 496-session prior
  }
  return null;
}

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

  const rawRemainingTurns =
    event.expected_remaining_turns ??
    event.expectedRemainingTurns ??
    options.expectedRemainingTurns ??
    horizonConfig?.expectedRemainingTurns;
  const useEmpiricalHorizonPrior = Boolean(
    event.use_empirical_horizon_prior ??
      event.useEmpiricalHorizonPrior ??
      options.useEmpiricalHorizonPrior ??
      horizonConfig?.useEmpiricalHorizonPrior
  );
  const turnsCompleted = Number(
    event.current_turn ?? event.currentTurn ?? liveState?.turnsCompleted ?? 0
  );
  const historicalSessionApiCalls =
    useEmpiricalHorizonPrior && (rawRemainingTurns === undefined || rawRemainingTurns === null)
      ? loadLocalClaudeSessionApiCalls(cwdOptions)
      : options.historicalSessionApiCalls;

  const router =
    options.router ||
    new CacheGravityRouter({
      ...cwdOptions,
      ...(historicalSessionApiCalls ? { historicalSessionApiCalls } : {}),
      mode: effectiveMode,
      strictBlock:
        det08Override === 'block' ? true : (event.strictBlock ?? options.strictBlock)
    });

  const currentModel =
    event.current_model ||
    event.currentModel ||
    event.from_model ||
    event.fromModel ||
    liveState.modelId ||
    'claude-opus-5-5';
  const targetModel =
    event.target_model ||
    event.targetModel ||
    event.to_model ||
    event.toModel ||
    event.requested_model ||
    event.requestedModel ||
    event.model ||
    'claude-sonnet-5-5';
  const cachedTokens = Number(
    event.cached_tokens ??
      event.cachedTokens ??
      event.context_tokens ??
      event.contextTokens ??
      liveState.contextWindow?.cachedTokens ??
      0
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rawExpiresAt = liveState?.promptCache?.expiresAt;
  const liveCacheExpired =
    rawExpiresAt !== null &&
    rawExpiresAt !== undefined &&
    Number.isFinite(Number(rawExpiresAt)) &&
    Number(rawExpiresAt) > 0 &&
    nowMs >= Number(rawExpiresAt);
  const explicitCacheWarm =
    event.cache_warm ??
    event.cacheWarm ??
    event.prompt_cache_warm ??
    event.promptCacheWarm;
  const cacheWarm =
    explicitCacheWarm !== undefined
      ? Boolean(explicitCacheWarm)
      : liveCacheExpired
        ? false
        : Boolean(liveState.promptCache?.warm);

  const uncachedDeltaTokens = Number(
    event.uncached_delta_tokens ?? event.uncachedDeltaTokens ?? 0
  );
  const rawTier =
    event.cache_ttl_tier ??
    event.cacheTtlTier ??
    event.cache_ttl ??
    event.cacheTtl ??
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

  const isNativePreModelSwitch = Boolean(
    event.hook_event_name === 'PreModelSwitch' ||
      event.from_model !== undefined ||
      event.to_model !== undefined ||
      event.fromModel !== undefined ||
      event.toModel !== undefined ||
      options.nativeHook === true
  );
  const resolvedAutoPilotDecision =
    det08Override === 'block'
      ? 'deny'
      : (event.autoPilotDecision ??
          options.autoPilotDecision ??
          horizonConfig?.autoPilotDecision ??
          (isNativePreModelSwitch ? 'ask' : 'deny'));

  let resolvedExpectedOutputTokens = event.expectedOutputTokens ?? options.expectedOutputTokens;
  if (
    resolvedExpectedOutputTokens === undefined &&
    Boolean(event.useObservedOutputTokens ?? options.useObservedOutputTokens)
  ) {
    const turnsDone = Number(liveState?.turnsCompleted || 0);
    const cumOut =
      Number(liveState?.cumulative?.outputTokens || 0) +
      Number(liveState?.cumulative?.thinkingTokens || 0);
    const lastOut =
      Number(liveState?.contextWindow?.lastOutputTokens || 0) +
      Number(liveState?.contextWindow?.lastThinkingTokens || 0);
    if (turnsDone > 0 && cumOut > 0) {
      resolvedExpectedOutputTokens = Math.round(cumOut / turnsDone);
    } else if (lastOut > 0) {
      resolvedExpectedOutputTokens = lastOut;
    }
  }

  let verdict = router.evaluateModelSwitch({
    currentModel,
    targetModel,
    cachedTokens,
    uncachedDeltaTokens,
    totalPromptTokens,
    cacheWarm,
    cacheTtlTier,
    turnsCompleted,
    expectedOutputTokens: resolvedExpectedOutputTokens ?? 1500,
    ...(rawRemainingTurns !== undefined && rawRemainingTurns !== null
      ? { expectedRemainingTurns: Number(rawRemainingTurns) }
      : useEmpiricalHorizonPrior
        ? { useEmpiricalHorizonPrior: true }
        : {}),
    strictBlock:
      det08Override === 'block' ? true : (event.strictBlock ?? options.strictBlock),
    autoPilotDecision: resolvedAutoPilotDecision
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

  const avoidedPenaltyUSD = Math.max(
    0,
    Number(verdict.breakEven?.coldWritePenaltyUSD ?? 0)
  );

  if (
    (verdict.blocked || verdict.decision === 'ask') &&
    cachedTokens > 0 &&
    avoidedPenaltyUSD > 0 &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
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
