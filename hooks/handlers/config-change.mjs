/**
 * @file hooks/handlers/config-change.mjs
 * Tier 2 Command Hook handler for Claude Code `ConfigChange` (`#1 MID_SESSION_CACHE_BUST`).
 *
 * Guards warm prompt-cache prefixes (`cachedTokens > 25,000`, `ttlSeconds > 0`) against
 * mid-session settings/plugin/MCP mutations that trigger full uncached prefix rewrites:
 *   - `/effort` / `effortLevel` on Anthropic models without unified effort-invariant caching
 *   - `fastMode` toggle on warm prefix
 *   - `mcpServers` / `enabledPlugins` / `plugins` / `tools` (`tools_changed` prefix bust)
 *   - Mid-session `model` downshift (`Opus -> Sonnet`), queuing `pendingDownshiftModel`
 *     until `PostCompact` so the downshift executes at $0 cold-cache penalty.
 */

import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import {
  computeTotalPromptTokens,
  isKnownCatalogModel,
  normalizeModelId,
  resolveEffectiveRates
} from '../../src/core-isomorphic/config/catalogLoader.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import {
  CacheGravityRouter,
  FLIGHT_MODES,
  getEffortMutationCacheCapability,
  isSilentOrOffMode,
  normalizeFlightMode
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { recordInterventionSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';

export const WARM_CACHE_CONFIG_GUARD_FLOOR_TOKENS = 25_000;

const CACHE_BUSTING_KEY_PATTERNS = [
  { regex: /^(?:effort|effortLevel|reasoningEffort|thinkingBudget)$/i, kind: 'effort' },
  { regex: /^(?:fastMode|fast_mode)$/i, kind: 'fastMode' },
  { regex: /^(?:mcpServers|mcp_servers|enabledPlugins|plugins|tools)$/i, kind: 'tools_changed' },
  { regex: /^(?:model|defaultModel)$/i, kind: 'model' }
];

function classifyConfigMutation(event = {}) {
  const rawKey = String(
    event.setting_key || event.settingKey || event.key || event.source || ''
  ).trim();
  for (const entry of CACHE_BUSTING_KEY_PATTERNS) {
    if (entry.regex.test(rawKey)) {
      return { busting: true, kind: entry.kind, key: rawKey };
    }
  }
  const sourceStr = String(event.source || '').toLowerCase();
  if (sourceStr.includes('plugin') || sourceStr.includes('mcp')) {
    return { busting: true, kind: 'tools_changed', key: rawKey || sourceStr };
  }
  return { busting: false, kind: null, key: rawKey };
}

function isOpusToSonnetDownshift(oldModel = '', newModel = '') {
  const prev = normalizeModelId(oldModel);
  const next = normalizeModelId(newModel);
  return prev.includes('opus') && next.includes('sonnet');
}

/**
 * Evaluates a Claude Code `ConfigChange` hook payload against warm-cache gravity.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 */
export function runConfigChangeHook(event = {}, options = {}) {
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions) || {};

  const effectiveMode = normalizeFlightMode(
    event.mode || options.mode || liveState.flightMode || horizonConfig.flightMode || 'COACH'
  );
  const detOverride = resolveDetectorOverride('DET-09', horizonConfig);

  if (isSilentOrOffMode(effectiveMode) || detOverride === 'off') {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: { triggered: false, decision: 'allow', reason: null }
    };
  }

  const classification = classifyConfigMutation(event);
  if (!classification.busting) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: { triggered: false, decision: 'allow', reason: null }
    };
  }

  if (
    event.old_value !== undefined &&
    event.new_value !== undefined &&
    JSON.stringify(event.old_value) === JSON.stringify(event.new_value)
  ) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: { triggered: false, decision: 'allow', reason: 'Unchanged config value.' }
    };
  }

  const cachedTokens = Math.max(
    0,
    Number(
      event.cached_tokens ??
        event.cachedTokens ??
        liveState?.contextWindow?.cachedTokens ??
        liveState?.contextWindow?.cacheReadTokens ??
        0
    )
  );
  const ttlSeconds = Number(
    event.ttl_remaining_seconds ??
      event.ttlRemainingSeconds ??
      liveState?.promptCache?.ttlSeconds ??
      300
  );
  const cacheWarm =
    ttlSeconds > 0 &&
    Boolean(event.cache_warm ?? event.cacheWarm ?? liveState?.promptCache?.warm ?? cachedTokens > 0);
  const floorTokens = Number(
    options.warmCacheFloorTokens ?? WARM_CACHE_CONFIG_GUARD_FLOOR_TOKENS
  );

  if (!cacheWarm || cachedTokens < floorTokens) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: {
        triggered: false,
        decision: 'allow',
        cachedTokens,
        reason: 'Cache cold or below warm-prefix guard floor.'
      }
    };
  }

  const currentModel = String(
    event.old_model ||
      (classification.kind === 'model' ? event.old_value : null) ||
      event.model ||
      liveState.modelId ||
      'claude-opus-5-5'
  );

  // Gemini thinking-level changes preserve implicit cache; only Anthropic/Claude effort changes bust cached history
  if (classification.kind === 'effort' && /gemini/i.test(currentModel)) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: {
        triggered: false,
        decision: 'allow',
        reason: 'Gemini thinking-level adjustments preserve implicit prefix cache.'
      }
    };
  }

  // Item 1.2: Unknown model -> explicit unknownModel state (zero $ figures, no price-based hold, one-line advisory)
  if (!isKnownCatalogModel(currentModel, cwdOptions)) {
    const effortClause =
      classification.kind === 'effort' ? ' (effort cache behavior unverified for this model)' : '';
    const msg = `[Highbeam DET-09 Advisory] Prices are unknown for ${currentModel}${effortClause}; skipping price-based guard.`;
    const stdoutJson = {
      systemMessage: msg,
      hookSpecificOutput: {
        hookEventName: 'ConfigChange',
        additionalContext: msg
      }
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(stdoutJson),
      stdoutJson,
      stderr: '',
      verdict: {
        detectorId: 'DET-09',
        triggered: false,
        kind: classification.kind,
        key: classification.key,
        decision: 'allow',
        advisory: true,
        unknownModel: true,
        cachedTokens,
        avoidedRewritePenaltyUSD: null,
        effortCacheCapability:
          classification.kind === 'effort'
            ? getEffortMutationCacheCapability(currentModel, cwdOptions)
            : null,
        reason: msg
      }
    };
  }

  // Item 3: DET-09 effort capability matrix (stay silent on measured cache-preserving models like Sonnet 5.5 / Opus 5.5)
  const normalizedCurrentModel = normalizeModelId(currentModel);
  const effortCap =
    classification.kind === 'effort'
      ? getEffortMutationCacheCapability(normalizedCurrentModel, cwdOptions)
      : null;

  if (effortCap && effortCap.invalidatesCache === 'no') {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict: {
        detectorId: 'DET-09',
        triggered: false,
        kind: classification.kind,
        key: classification.key,
        decision: 'allow',
        advisory: false,
        cachedTokens,
        avoidedRewritePenaltyUSD: 0,
        effortCacheCapability: effortCap,
        reason: null
      }
    };
  }

  const totalPromptTokens = Math.max(
    cachedTokens,
    computeTotalPromptTokens(liveState.contextWindow || { cacheReadTokens: cachedTokens })
  );
  const ttlTier = liveState?.promptCache?.ttlTier === '1h' ? '1h' : '5m';
  const rates = resolveEffectiveRates(normalizedCurrentModel, totalPromptTokens, cwdOptions);
  const writeRate = ttlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;
  const avoidedRewritePenaltyUSD = Number(
    Math.max(0, (cachedTokens / 1_000_000) * (writeRate - rates.readPer1M)).toFixed(6)
  );

  const router = new CacheGravityRouter({ mode: effectiveMode, ...cwdOptions });
  const priorSnap = readBreakerStateSnapshot(sessionId, cwdOptions) || {};
  if (Array.isArray(priorSnap.queuedMutations)) {
    router.mutationQueue.items = [...priorSnap.queuedMutations];
  }

  let nextPendingDownshift = priorSnap.pendingDownshiftModel || null;
  let nextPendingDownshiftRecord = priorSnap.pending_downshift || null;
  const newValStr =
    typeof event.new_value === 'string'
      ? event.new_value
      : JSON.stringify(event.new_value ?? '');

  if (classification.kind === 'model' && isOpusToSonnetDownshift(normalizedCurrentModel, newValStr)) {
    nextPendingDownshift = normalizeModelId(newValStr);
    nextPendingDownshiftRecord = {
      fromModel: normalizedCurrentModel,
      toModel: nextPendingDownshift,
      recordedAt: new Date().toISOString()
    };
  }

  router.mutationQueue.enqueue({
    type: classification.kind,
    key: classification.key,
    value: event.new_value,
    cachedTokens,
    avoidedRewritePenaltyUSD,
    reason: `Deferred ${classification.kind} change (${classification.key}) until PostCompact`
  });

  if (options.persistState !== false && Boolean(event.cwd || options.cwd || options.breakerStatePath)) {
    writeBreakerStateSnapshot(
      sessionId,
      {
        ...priorSnap,
        updatedAt: Date.now(),
        pendingDownshiftModel: nextPendingDownshift,
        pending_downshift: nextPendingDownshiftRecord,
        queuedMutations: router.mutationQueue.toJSON()
      },
      cwdOptions
    );
  }

  const shouldBlock = effectiveMode === FLIGHT_MODES.AUTO_PILOT || detOverride === 'block';
  const downshiftHint = nextPendingDownshift
    ? ` Queued pending_downshift -> ${nextPendingDownshift} for next compaction.`
    : ' Wait for /compact or spawn an isolated subagent instead.';
  const effortLabel =
    effortCap?.invalidatesCache === 'unknown'
      ? ' (unverified for this model)'
      : effortCap?.provenance
        ? ` (${effortCap.provenance})`
        : '';
  const message =
    `[Highbeam Quota Shield — Warm-Cache Config Bust (${classification.kind})${effortLabel}] ` +
    `Changing "${classification.key}" while ${cachedTokens.toLocaleString()} tokens are warm on ${normalizedCurrentModel} ` +
    `invalidates the prompt cache prefix (+$${avoidedRewritePenaltyUSD.toFixed(4)} cold rewrite tax).` +
    downshiftHint;

  if (
    shouldBlock &&
    avoidedRewritePenaltyUSD > 0 &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
    recordInterventionSavings(
      {
        sessionId,
        category: 'DET_09_CONFIG_CACHE_SHIELD',
        modelId: normalizedCurrentModel,
        savedTokens: cachedTokens,
        savedUSD: avoidedRewritePenaltyUSD,
        dedupeId: `${classification.kind}:${classification.key}:${cachedTokens}`,
        detail: `Held warm-prefix ${classification.kind} mutation (${cachedTokens.toLocaleString()} tok)`
      },
      cwdOptions
    );
  }

  const verdict = {
    detectorId: 'DET-09',
    triggered: true,
    kind: classification.kind,
    key: classification.key,
    decision: shouldBlock ? 'block' : 'allow',
    advisory: !shouldBlock,
    cachedTokens,
    avoidedRewritePenaltyUSD,
    effortCacheCapability: effortCap,
    pendingDownshiftModel: nextPendingDownshift,
    pending_downshift: nextPendingDownshiftRecord,
    reason: message
  };

  if (shouldBlock) {
    const stdoutJson = {
      decision: 'block',
      reason: message
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
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'ConfigChange',
      additionalContext: message
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

export async function executeConfigChangeCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runConfigChangeHook;
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
    exitDiagnosticZero(err?.message || String(err), 'ConfigChange', ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executeConfigChangeCli().catch((err) => {
    exitDiagnosticZero(err?.message || String(err), 'ConfigChange');
  });
}
