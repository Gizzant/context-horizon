import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getHomeDir } from './paths.mjs';
import { EFFORT_PROFILES, normalizeModelId } from './constants.mjs';
import { parseSettingsChanges } from './parser.mjs';

/**
 * Dual-Pool Quota Estimator (5-Hour Sprint / 7-Day Weekly),
 * Pool Reset Countdown Formatter, Prefix Bust Detector &
 * Cache-Read Telemetry Engine.
 */

export const QUOTA_CONSTANTS = Object.freeze({
  SPRINT_WINDOW_MS: 5 * 60 * 60 * 1000,       // 5 hours
  WEEKLY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,  // 7 days
  DEFAULT_SPRINT_POOL_UNITS: 5000000,         // ~5M weighted token units per 5h window
  WEEKLY_TO_SPRINT_RATIO: 2.8,                // 2.33x to 3.5x empirical Pro ratio
  DEFAULT_WEEKLY_POOL_UNITS: 14000000,        // 2.8 * 5M
  CACHE_TTL_SECONDS: 300,                     // 5-minute prompt prefix cache TTL
  TTL_PULSE_THRESHOLD_SECONDS: 45,            // T-45s visual expiration pulse threshold
  CACHE_READ_WEIGHT: 0.10,
  UNCACHED_INPUT_WEIGHT: 1.00,
  OUTPUT_THINKING_WEIGHT: 3.00
});

export const OVERAGE_ALERT_MESSAGES = Object.freeze({
  LOCKOUT_ALERT: '7d Quota Exhausted. Enable AI Credit Overages in Settings > Models to prevent session lockout.',
  OVERAGES_ACTIVE_VISION_WARN: 'Overages Active. Do NOT attach images or screenshots (known upstream HTTP 400 Bad Request bug on overage calls).',
  PREFIX_BUST_LABEL: '⚠️ Prefix Bust (system_message / config drift)'
});

/**
 * Formats a reset countdown in seconds into "3h 12m" (<24h) or "4d 18h" (>=24h).
 */
export function formatResetCountdown(resetSeconds) {
  const sec = Math.max(0, Math.round(Number(resetSeconds || 0)));
  if (sec <= 0) return '0m';
  const totalMinutes = Math.max(1, Math.floor(sec / 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  if (days >= 1) {
    const remHours = Math.floor((totalMinutes % (60 * 24)) / 60);
    return `${days}d ${remHours}h`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours >= 1) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Maps a raw model ID to a human-readable Antigravity quota pool name.
 */
export function resolveModelPoolDisplayName(modelId = 'gemini-3.8-flash') {
  const s = normalizeModelId(modelId);
  if (s.includes('gemini-4-argon') || s.includes('argon')) return 'Gemini 4 Argon';
  if (s.includes('gemini-3.8-flash') || s.includes('3.8-flash')) return 'Gemini 3.8 Flash';
  if (s.includes('gemini-3.1-pro') || s.includes('3.1-pro')) return 'Gemini 3.1 Pro';
  if (s.includes('claude-opus-5') || s.includes('opus-5')) return 'Claude Opus 5.5';
  if (s.includes('claude-sonnet-5') || s.includes('sonnet-5')) return 'Claude Sonnet 5.5';
  if (s.includes('claude-opus-4') || s.includes('opus-4')) return 'Claude Opus 4.6';
  if (s.includes('claude-3-5-sonnet') || s.includes('sonnet')) return 'Claude Sonnet';
  if (s.includes('flash')) return 'Gemini Flash';
  return 'Gemini 4 Argon';
}

function getLedgerPath(cacheDir = null) {
  const dir = cacheDir || path.join(getHomeDir(), '.gemini', 'antigravity', 'cache', 'agy-horizon');
  return path.join(dir, 'quota_ledger.json');
}

export function loadQuotaLedger(cacheDir = null) {
  const file = getLedgerPath(cacheDir);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.sessions === 'object') return parsed;
    }
  } catch {}
  return { schemaRev: 1, sessions: {} };
}

export function saveQuotaLedger(ledger, cacheDir = null) {
  try {
    const file = getLedgerPath(cacheDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger), 'utf8');
    fs.renameSync(tmp, file);
  } catch {}
}

/**
 * Detects whether a step or its immediately preceding step contained an explicit
 * prefix-invalidating event (<USER_SETTINGS_CHANGE>, <system_message>, model/effort
 * switch, or an edit to AGENTS.md / .agents/rules/ / mcp_config.json).
 */
export function hasExplicitPrefixMutation(step = {}, prevStep = null) {
  // Only genuine user/system turns can carry a settings change or system message.
  // Tool output, code views, and planner text that merely *mention* the tags are ignored.
  const isUserOrSystemStep = (st) => {
    const t = String(st?.type || '').toUpperCase();
    return t === 'USER_INPUT' || t.startsWith('SYSTEM');
  };
  const checkText = (st) => {
    if (!isUserOrSystemStep(st)) return false;
    const txt = String(st?.content || '');
    return /<USER_SETTINGS_CHANGE>|<system_message>/i.test(txt);
  };
  const checkToolEdit = (st) => {
    for (const c of (st?.toolCalls || [])) {
      if (!/write|edit|replace|create/i.test(String(c?.name || ''))) continue;
      const p = String(c?.args?.Path || c?.args?.path || c?.args?.TargetFile || c?.args?.AbsolutePath || '');
      if (/(^|[\\/])(AGENTS\.md|mcp_config\.json)$|[\\/]\.agents[\\/]rules[\\/]/i.test(p)) {
        return true;
      }
    }
    return false;
  };
  if (checkText(step) || checkToolEdit(step)) return true;
  if (prevStep && (checkText(prevStep) || checkToolEdit(prevStep))) return true;
  if (prevStep?.model && step?.model && prevStep.model !== step.model) return true;
  if (prevStep?.effort && step?.effort && prevStep.effort !== step.effort) return true;
  return false;
}

/**
 * attributes a prefix bust to a model switch when the busting step (or the step
 * just before it) is a USER_INPUT carrying a `Model Selection` settings change, or when
 * consecutive steps carry different model ids.
 */
export function detectModelSwitchCause(step = {}, prevStep = null) {
  for (const st of [step, prevStep]) {
    if (!st || String(st.type || '').toUpperCase() !== 'USER_INPUT') continue;
    const changes = parseSettingsChanges(String(st.content || '')).filter(c => /model selection/i.test(c.setting));
    if (changes.length > 0) {
      const last = changes[changes.length - 1];
      return { cause: 'model_switch', from: last.from, to: last.to };
    }
  }
  if (prevStep?.model && step?.model && prevStep.model !== step.model) {
    return { cause: 'model_switch', from: prevStep.model, to: step.model };
  }
  return null;
}

/**
 * Human-readable label for a model id ("claude-opus-5.5" -> "Claude Opus 5.5").
 * Already-readable labels ("Claude Opus 5.5 (Medium)") are returned without the effort suffix.
 */
export function humanizeModelLabel(model = '') {
  const raw = String(model || '').trim();
  if (!raw) return '';
  const noEffort = raw.replace(/\s*\([^()]*\)\s*$/, '');
  if (/[A-Z ]/.test(noEffort)) return noEffort;
  return noEffort.split('-').map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/**
 * Maps a raw model ID to a concise human-readable short name.
 * e.g. "gemini-4-argon" -> "Argon", "gemini-3.8-flash" -> "Flash".
 */
export function resolveModelShortName(modelId = '') {
  const s = normalizeModelId(String(modelId || ''));
  if (s.includes('argon')) return 'Argon';
  if (s.includes('3.8-flash') || s.includes('flash')) return 'Flash';
  if (s.includes('3.1-pro') || s.includes('pro')) return 'Pro';
  if (s.includes('opus-5') || s.includes('opus')) return 'Opus 5.5';
  if (s.includes('sonnet-5') || s.includes('sonnet')) return 'Sonnet 5.5';
  const human = humanizeModelLabel(modelId);
  return human ? human.split(' ').pop() : 'Model';
}

/**
 * Formats a token count into a compact string ("140k", "3.7k").
 */
export function formatK(num) {
  const n = Number(num || 0);
  if (n <= 0) return '0k';
  if (n < 1000) return `${Math.round(n)}`;
  const k = n / 1000;
  return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
}

/**
 * Prefix Bust label. A known model-switch cause gets a plain-language amber label; an unknown
 * cause keeps the legacy label.
 */
export function formatPrefixBustLabel(cause = null) {
  if (cause && cause.cause === 'auto_router_thrash') {
    return cause.badgeText || `\u26A0\uFE0F Router Thrash: ${cause.switchCount} model hops`;
  }
  if (cause && cause.cause === 'model_switch' && cause.to) {
    return `Last turn: cache miss (model switch \u2192 ${humanizeModelLabel(cause.to)})`;
  }
  if (cause && cause.cause === 'warm_pool_busted') {
    return cause.reason === 'RULE_FILE_DRIFT'
      ? '\u26A0\uFE0F Prefix Bust (system_message / config drift)'
      : '\u26A0\uFE0F Prefix Bust (history mutation)';
  }
  return OVERAGE_ALERT_MESSAGES.PREFIX_BUST_LABEL;
}

/**
 * Pure, deterministic tracker for per-model KV cache pools.
 * On every turn, tracks Map<modelId, ModelCacheState> and evaluates warm standby
 * caches and underlying prefix mutations on warm-pool misses.
 */
export function trackModelCachePools(turns = [], { nowMs = Date.now(), prefixDiff = null } = {}) {
  const modelCachePools = new Map();
  let standbyCache = null;
  let lastSwitchEvent = null;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const prevTurn = i > 0 ? turns[i - 1] : null;
    const mId = normalizeModelId(turn.modelId || turn.model || 'gemini-4-argon');
    const shortName = resolveModelShortName(turn.modelRaw || turn.model || mId);
    const displayName = resolveModelPoolDisplayName(mId);
    const ts = turn.timestampMs || (turn.createdAt ? Date.parse(turn.createdAt) : nowMs);
    const ttlWindow = Number(turn.ttlSeconds || QUOTA_CONSTANTS.CACHE_TTL_SECONDS);

    const prevMId = prevTurn ? normalizeModelId(prevTurn.modelId || prevTurn.model || 'gemini-4-argon') : null;
    const isModelSwitch = Boolean(prevTurn && prevMId && prevMId !== mId);

    // Update remaining TTL for all existing pools up to this turn
    for (const pool of modelCachePools.values()) {
      const elapsedSec = Math.max(0, Math.floor((ts - pool.lastSeenTimestampMs) / 1000));
      pool.remainingTtl = Math.max(0, pool.ttlSecondsAtLastTurn - elapsedSec);
      pool.isWarm = pool.remainingTtl > 0 && pool.lastCachedTokens > 0;
    }

    if (isModelSwitch) {
      const modelA = modelCachePools.get(prevMId);
      const modelB = modelCachePools.get(mId);

      // Check if Model A still has remainingTtl > 30 and lastCachedTokens > 20000
      if (modelA && modelA.remainingTtl > 30 && modelA.lastCachedTokens > 20000) {
        standbyCache = {
          modelName: modelA.shortName,
          remainingTtl: modelA.remainingTtl,
          cachedTokens: modelA.lastCachedTokens
        };
      } else {
        standbyCache = null;
      }

      // Check if Model B already had a warm entry in modelCachePools that unexpectedly missed
      let warmPoolBustedReason = null;
      if (modelB && modelB.remainingTtl > 0 && Number(turn.cacheReadTokens || 0) === 0) {
        const isRuleDrift = Boolean(turn.explicitMutation || prefixDiff?.mutated);
        warmPoolBustedReason = isRuleDrift ? 'RULE_FILE_DRIFT' : 'HISTORY_MUTATION';
      }

      lastSwitchEvent = {
        fromModelId: prevMId,
        toModelId: mId,
        fromShortName: resolveModelShortName(prevTurn.modelRaw || prevTurn.model || prevMId),
        toShortName: shortName,
        toDisplayName: displayName,
        turnIndex: turn.stepIndex ?? i,
        timestampMs: ts,
        warmPoolBustedReason,
        standbyCache: standbyCache ? { ...standbyCache } : null
      };
    }

    const cachedTokens = turn.cacheReadTokens > 0
      ? turn.cacheReadTokens
      : (turn.cacheCreationTokens > 0 ? turn.cacheCreationTokens : (turn.cachedTokens || 0));

    const existing = modelCachePools.get(mId);
    modelCachePools.set(mId, {
      modelId: mId,
      shortName,
      displayName,
      lastSeenTurnId: turn.stepIndex ?? i,
      lastSeenTimestampMs: ts,
      lastCachedTokens: cachedTokens > 0 ? cachedTokens : (existing?.lastCachedTokens || 0),
      lastPrefixHash: turn.prefixHash || existing?.lastPrefixHash || '',
      ttlSecondsAtLastTurn: ttlWindow,
      remainingTtl: ttlWindow,
      isWarm: cachedTokens > 0
    });
  }

  // Final evaluation of remaining TTL against nowMs
  for (const pool of modelCachePools.values()) {
    const elapsedSec = Math.max(0, Math.floor((nowMs - pool.lastSeenTimestampMs) / 1000));
    pool.remainingTtl = Math.max(0, pool.ttlSecondsAtLastTurn - elapsedSec);
    pool.isWarm = pool.remainingTtl > 0 && pool.lastCachedTokens > 0;
  }

  if (standbyCache && lastSwitchEvent) {
    const modelA = modelCachePools.get(lastSwitchEvent.fromModelId);
    if (modelA) {
      standbyCache.remainingTtl = modelA.remainingTtl;
      if (standbyCache.remainingTtl <= 0) {
        standbyCache = null;
      }
    }
  }

  return {
    modelCachePools,
    standbyCache,
    lastSwitchEvent
  };
}

/**
 * Pure sliding-window (last 5 turns) Auto-Router Thrash and Model Switch detector.
 */
export function detectRouterThrash(recentTurns = [], isAutoMode = false, {
  totalTokens = 0,
  reclaimableTokens = 0,
  standbyCache = null,
  lastSwitchEvent = null
} = {}) {
  if (!Array.isArray(recentTurns) || recentTurns.length === 0) {
    return {
      detected: false,
      state: 'HEALTHY',
      severity: 'none',
      isAutoMode,
      windowTurns: 0,
      switchCount: 0,
      thrashUncachedTokens: 0,
      modelSequenceString: '',
      modelsInvolved: [],
      badgeText: '',
      tooltip: '',
      standbyNote: '',
      preSwitchCompactionAdvice: ''
    };
  }

  const windowTurns = recentTurns.slice(-5);
  let switchCount = 0;
  let thrashUncachedTokens = 0;

  for (let i = 1; i < windowTurns.length; i++) {
    const curr = windowTurns[i];
    const prev = windowTurns[i - 1];
    const currM = normalizeModelId(curr.modelId || curr.model || 'gemini-4-argon');
    const prevM = normalizeModelId(prev.modelId || prev.model || 'gemini-4-argon');
    if (currM !== prevM) {
      switchCount++;
      const uncached = Number(curr.inputTokens || 0) || Number(curr.uncachedInputTokens || 0) || Math.max(0, Number(curr.totalTokens || 0) - Number(curr.cacheReadTokens || 0));
      thrashUncachedTokens += uncached;
    }
  }

  if (thrashUncachedTokens === 0 && switchCount > 0 && totalTokens > 0) {
    thrashUncachedTokens = totalTokens * switchCount;
  }

  const seqShort = [];
  for (const t of windowTurns) {
    const sName = resolveModelShortName(t.modelRaw || t.model || t.modelId);
    if (seqShort.length === 0 || seqShort[seqShort.length - 1] !== sName) {
      seqShort.push(sName);
    }
  }
  const modelSequenceString = seqShort.join(' \u2192 ');
  const modelsInvolved = [...new Set(seqShort)];

  const lastTurn = windowTurns[windowTurns.length - 1];
  const prevTurn = windowTurns.length > 1 ? windowTurns[windowTurns.length - 2] : null;
  const isCurrentTurnSwitch = Boolean(
    lastTurn && prevTurn &&
    normalizeModelId(lastTurn.modelId || lastTurn.model || '') !== normalizeModelId(prevTurn.modelId || prevTurn.model || '')
  );
  const currentShortName = lastTurn ? resolveModelShortName(lastTurn.modelRaw || lastTurn.model || lastTurn.modelId) : 'Model';
  const currentDisplayName = lastTurn ? resolveModelPoolDisplayName(lastTurn.modelId || lastTurn.model) : 'Model';

  const totalPrompt = Number(lastTurn?.cacheReadTokens || 0) + Number(lastTurn?.cacheCreationTokens || 0) + Number(lastTurn?.inputTokens || 0);
  const cacheHitPct = totalPrompt > 0 ? (Number(lastTurn?.cacheReadTokens || 0) / totalPrompt) * 100 : 0;

  // Case A: Router Thrashing (2+ switches in 5 turns in [Auto] mode)
  if (switchCount >= 2 && isAutoMode) {
    const badgeText = `\u26A0\uFE0F Router Thrash: ${switchCount} model hops (${formatK(thrashUncachedTokens)} uncached)`;
    const tooltip = `Auto-routing is bouncing between models (${modelSequenceString}), paying full uncached prefill cost on every hop. Pin a single model or run /compact.`;
    return {
      detected: true,
      state: 'AUTO_ROUTER_THRASH',
      severity: 'warn',
      isAutoMode,
      windowTurns: windowTurns.length,
      switchCount,
      thrashUncachedTokens,
      modelSequenceString,
      modelsInvolved,
      currentShortName,
      currentDisplayName,
      badgeText,
      tooltip,
      standbyNote: standbyCache ? `(${standbyCache.modelName} cache still warm: ${standbyCache.remainingTtl}s left)` : '',
      preSwitchCompactionAdvice: ''
    };
  }

  // Case B: Single Model Switch / Cold Start
  const lastTurnMissedCache = Number(lastTurn?.cacheReadTokens || 0) === 0;
  const isLastTurnSwitchEvent = Boolean(
    lastSwitchEvent && lastTurn && (lastTurn.stepIndex ?? (recentTurns.length - 1)) === lastSwitchEvent.turnIndex
  );
  if ((isCurrentTurnSwitch || isLastTurnSwitchEvent) && lastTurnMissedCache) {
    const severity = (isAutoMode && totalTokens >= 100000) ? 'warn' : 'info';
    const badgeText = `Last turn: cache miss (model switch \u2192 ${currentShortName})`;
    const standbyNote = standbyCache ? `(${standbyCache.modelName} cache still warm: ${standbyCache.remainingTtl}s left)` : '';
    const tooltip = standbyCache
      ? `Last turn missed prompt cache due to model switch \u2192 ${currentDisplayName}. (${standbyCache.modelName} cache still warm: ${standbyCache.remainingTtl}s left)`
      : `Last turn missed prompt cache due to model switch \u2192 ${currentDisplayName}.`;

    let preSwitchCompactionAdvice = '';
    if (reclaimableTokens >= 40000) {
      preSwitchCompactionAdvice = `Switching to ${currentShortName} forced a full ${formatK(totalTokens)} uncached rebuild (including ${formatK(reclaimableTokens)} of reclaimable waste). Tip: Run /compact before switching models so the incoming model only warms up active signal.`;
    }

    return {
      detected: false,
      state: 'MODEL_SWITCH_COLD_START',
      severity,
      isAutoMode,
      windowTurns: windowTurns.length,
      switchCount,
      thrashUncachedTokens,
      modelSequenceString,
      modelsInvolved,
      currentShortName,
      currentDisplayName,
      badgeText,
      tooltip,
      standbyNote,
      preSwitchCompactionAdvice
    };
  }

  // Case C: One-Turn Decay to Healthy
  // When session stays on the same model and achieves cacheHit > 50% (or positive cacheReadTokens)
  if (!isCurrentTurnSwitch && (cacheHitPct > 50 || Number(lastTurn?.cacheReadTokens || 0) > 0)) {
    return {
      detected: false,
      state: 'HEALTHY',
      severity: 'none',
      isAutoMode,
      windowTurns: windowTurns.length,
      switchCount: 0,
      thrashUncachedTokens: 0,
      modelSequenceString,
      modelsInvolved,
      currentShortName,
      currentDisplayName,
      badgeText: '',
      tooltip: '',
      standbyNote: '',
      preSwitchCompactionAdvice: ''
    };
  }

  return {
    detected: false,
    state: 'HEALTHY',
    severity: 'none',
    isAutoMode,
    windowTurns: windowTurns.length,
    switchCount,
    thrashUncachedTokens,
    modelSequenceString,
    modelsInvolved,
    currentShortName,
    currentDisplayName,
    badgeText: '',
    tooltip: '',
    standbyNote: '',
    preSwitchCompactionAdvice: ''
  };
}

/**
 * Computes session and rolling 5h/7d dual-pool quota & cache telemetry.
 */
export function computeQuotaAndCacheTelemetry(steps = [], {
  sessionId = 'unknown',
  modelId = 'gemini-4-argon',
  totalActiveTokens = 0,
  activeEffortProfile = EFFORT_PROFILES.STANDARD,
  stdinQuota = null,
  genMetadata = null,
  aiCreditOveragesEnabled = undefined,
  cacheDir = null,
  reclaimableTokens = 0,
  sludgeTokens = 0,
  isAutoMode = undefined,
  nowMs = Date.now()
} = {}) {
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  let sessionCacheReadTokens = 0;
  let sessionCacheCreationTokens = 0;
  let sessionThinkingTokens = 0;
  let latestStepTimestampMs = 0;
  let cumContextEst = 0;
  let stepPrefixBustDetected = false;
  let stepPrefixBustDeltaSec = null;
  let stepPrefixBustCause = null;
  let lastTurnCacheRead = 0;
  let lastTurnCacheCreation = 0;
  const turns = [];
  let runningModel = modelId || 'gemini-4-argon';
  let runningModelRaw = modelId || 'gemini-4-argon';

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const stepTok = s.outputTokens || Math.round((s.untruncatedLength || 0) / 4) || 0;
    cumContextEst += stepTok;

    const changes = s.content ? parseSettingsChanges(s.content).filter(c => /model selection/i.test(c.setting)) : [];
    if (changes.length > 0) {
      runningModelRaw = changes[changes.length - 1].to;
      runningModel = normalizeModelId(runningModelRaw);
    } else if (s.turnMetadata?.model) {
      runningModelRaw = s.turnMetadata.model;
      runningModel = normalizeModelId(runningModelRaw);
    } else if (s.model) {
      runningModelRaw = s.model;
      runningModel = normalizeModelId(runningModelRaw);
    }

    const rawInput = Number(s.inputTokens || 0);
    const rawOutput = Number(s.outputTokens || stepTok);
    const rawCacheRead = Number(s.cacheReadTokens || 0);
    const rawCacheCreate = Number(s.cacheCreationTokens || 0);
    const rawThinking = Number(
      s.thinkingTokens ||
      (s.type === 'PLANNER_RESPONSE' && activeEffortProfile?.tier === 'HIGH' ? 4000 : 0)
    );

    const prevTs = i > 0 && steps[i - 1]?.createdAt ? Date.parse(steps[i - 1].createdAt) : 0;
    const currTs = s.createdAt ? Date.parse(s.createdAt) : 0;
    const gapSec = (prevTs > 0 && currTs >= prevTs) ? (currTs - prevTs) / 1000 : null;

    if (rawCacheRead > 0 || rawCacheCreate > 0 || rawInput > 0) {
      const hadPriorCacheHit = sessionCacheReadTokens > 0 || sessionCacheCreationTokens > 0;
      const explicitMutation = i > 0 && hasExplicitPrefixMutation(s, steps[i - 1]);
      sessionInputTokens += rawInput;
      sessionCacheReadTokens += rawCacheRead;
      sessionCacheCreationTokens += rawCacheCreate;
      lastTurnCacheRead = rawCacheRead;
      lastTurnCacheCreation = rawCacheCreate;
      // Detect mid-run prefix bust: require prior warm cache hit or explicit prefix mutation when cache_read_tokens == 0 within < 300s
      if (
        i > 0 &&
        rawCacheRead === 0 &&
        rawInput > 0 &&
        (hadPriorCacheHit || explicitMutation) &&
        gapSec !== null &&
        gapSec < QUOTA_CONSTANTS.CACHE_TTL_SECONDS
      ) {
        stepPrefixBustDetected = true;
        stepPrefixBustDeltaSec = Math.round(gapSec);
        stepPrefixBustCause = detectModelSwitchCause(s, steps[i - 1]);
      } else if (rawCacheRead > 0) {
        stepPrefixBustDetected = false;
        stepPrefixBustCause = null;
      }
    } else if (s.type === 'PLANNER_RESPONSE' && i > 0 && gapSec !== null) {
      // Only infer prefix cache read when real step timestamps exist and prove <300s turnaround
      if (gapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
        sessionCacheReadTokens += Math.max(0, cumContextEst - stepTok);
        sessionCacheCreationTokens += stepTok;
        lastTurnCacheRead = Math.max(0, cumContextEst - stepTok);
        lastTurnCacheCreation = stepTok;
      } else {
        sessionInputTokens += cumContextEst;
        lastTurnCacheRead = 0;
        lastTurnCacheCreation = 0;
      }
    }

    if (rawCacheRead > 0 || rawCacheCreate > 0 || rawInput > 0 || s.type === 'USER_INPUT' || s.type === 'PLANNER_RESPONSE') {
      turns.push({
        stepIndex: s.stepIndex ?? i,
        modelId: runningModel,
        modelRaw: runningModelRaw,
        inputTokens: rawInput,
        cacheReadTokens: rawCacheRead,
        cacheCreationTokens: rawCacheCreate,
        outputTokens: rawOutput,
        timestampMs: currTs || nowMs,
        createdAt: s.createdAt,
        explicitMutation: i > 0 && hasExplicitPrefixMutation(s, steps[i - 1])
      });
    }

    sessionOutputTokens += rawOutput;
    sessionThinkingTokens += rawThinking;

    if (s.createdAt) {
      const ts = Date.parse(s.createdAt);
      if (Number.isFinite(ts) && ts > latestStepTimestampMs) {
        latestStepTimestampMs = ts;
      }
    }
  }

  const totalPromptTokens = sessionCacheReadTokens + sessionCacheCreationTokens + sessionInputTokens;
  const cacheHitRatePct = totalPromptTokens > 0
    ? Math.min(100, Math.round((sessionCacheReadTokens / totalPromptTokens) * 100))
    : 0;

  const weightedUnits = Math.round(
    (sessionCacheReadTokens * QUOTA_CONSTANTS.CACHE_READ_WEIGHT) +
    ((sessionInputTokens + sessionCacheCreationTokens) * QUOTA_CONSTANTS.UNCACHED_INPUT_WEIGHT) +
    ((sessionOutputTokens + sessionThinkingTokens) * QUOTA_CONSTANTS.OUTPUT_THINKING_WEIGHT)
  );

  // Update rolling 7-day ledger
  const ledger = loadQuotaLedger(cacheDir);
  const cutoff7d = nowMs - QUOTA_CONSTANTS.WEEKLY_WINDOW_MS;
  const cutoff5h = nowMs - QUOTA_CONSTANTS.SPRINT_WINDOW_MS;

  for (const [sid, entry] of Object.entries(ledger.sessions)) {
    if (!entry || (entry.updatedAtMs || 0) < cutoff7d) {
      delete ledger.sessions[sid];
    }
  }

  if (sessionId && sessionId !== 'unknown') {
    const prev = ledger.sessions[sessionId];
    const unchanged = Boolean(
      prev &&
      prev.weightedUnits === weightedUnits &&
      prev.cacheReadTokens === sessionCacheReadTokens &&
      prev.inputTokens === sessionInputTokens &&
      prev.outputTokens === sessionOutputTokens &&
      prev.thinkingTokens === sessionThinkingTokens
    );
    ledger.sessions[sessionId] = {
      updatedAtMs: latestStepTimestampMs || nowMs,
      weightedUnits,
      cacheReadTokens: sessionCacheReadTokens,
      inputTokens: sessionInputTokens,
      outputTokens: sessionOutputTokens,
      thinkingTokens: sessionThinkingTokens
    };
    if (!unchanged) {
      saveQuotaLedger(ledger, cacheDir);
    }
  }

  let sprintUnitsUsed = 0;
  let weeklyUnitsUsed = 0;
  let oldest5hTs = nowMs;
  let oldest7dTs = nowMs;
  for (const entry of Object.values(ledger.sessions)) {
    const ts = entry.updatedAtMs || 0;
    const units = Number(entry.weightedUnits || 0);
    if (ts >= cutoff7d) {
      weeklyUnitsUsed += units;
      if (ts < oldest7dTs) oldest7dTs = ts;
    }
    if (ts >= cutoff5h) {
      sprintUnitsUsed += units;
      if (ts < oldest5hTs) oldest5hTs = ts;
    }
  }

  if (sprintUnitsUsed === 0 && weightedUnits > 0) sprintUnitsUsed = weightedUnits;
  if (weeklyUnitsUsed === 0 && weightedUnits > 0) weeklyUnitsUsed = weightedUnits;

  let sprintUsedPct = parseFloat(Math.min(100, (sprintUnitsUsed / QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS) * 100).toFixed(1));
  let weeklyUsedPct = parseFloat(Math.min(100, (weeklyUnitsUsed / QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS) * 100).toFixed(1));

  // Default rolling reset timers (seconds remaining in active 5h sprint and 7d weekly windows)
  let sprintResetInSec = Math.max(60, Math.round(((oldest5hTs + QUOTA_CONSTANTS.SPRINT_WINDOW_MS) - nowMs) / 1000));
  let weeklyResetInSec = Math.max(300, Math.round(((oldest7dTs + QUOTA_CONSTANTS.WEEKLY_WINDOW_MS) - nowMs) / 1000));
  let aiCreditsBalance = null;
  // Per-metric provenance: 'host' only when the host actually supplied a numeric fraction;
  // otherwise the value is a local estimate from transcript token counts.
  let sprintSource = 'estimate';
  let weeklySource = 'estimate';

  // Reconcile with host-reported quota buckets (stdin) if present
  if (stdinQuota && typeof stdinQuota === 'object') {
    if (typeof stdinQuota.remaining_fraction === 'number') {
      sprintUsedPct = parseFloat(Math.max(0, Math.min(100, (1 - stdinQuota.remaining_fraction) * 100)).toFixed(1));
      sprintSource = 'host';
    }
    const weeklyFrac = stdinQuota.buckets?.weekly?.remaining_fraction ?? stdinQuota.weekly_remaining_fraction;
    if (typeof weeklyFrac === 'number') {
      weeklyUsedPct = parseFloat(Math.max(0, Math.min(100, (1 - weeklyFrac) * 100)).toFixed(1));
      weeklySource = 'host';
    }
    if (typeof stdinQuota.reset_in_seconds === 'number' && stdinQuota.reset_in_seconds > 0) {
      sprintResetInSec = Math.round(stdinQuota.reset_in_seconds);
    } else if (typeof stdinQuota.buckets?.sprint?.reset_in_seconds === 'number') {
      sprintResetInSec = Math.round(stdinQuota.buckets.sprint.reset_in_seconds);
    }
    const hostWeeklyReset = stdinQuota.weekly_reset_in_seconds ?? stdinQuota.buckets?.weekly?.reset_in_seconds;
    if (typeof hostWeeklyReset === 'number' && hostWeeklyReset > 0) {
      weeklyResetInSec = Math.round(hostWeeklyReset);
    }
    const rawCredits = stdinQuota.ai_credits ?? stdinQuota.remaining_ai_credits ?? stdinQuota.aiCredits ?? stdinQuota.userStatus?.aiCredits;
    if (typeof rawCredits === 'number' && Number.isFinite(rawCredits)) {
      aiCreditsBalance = Math.max(0, Math.round(rawCredits));
    }
  }

  const overagesEnabled = Boolean(
    aiCreditOveragesEnabled !== undefined
      ? aiCreditOveragesEnabled
      : (stdinQuota?.enable_ai_credit_overages ?? stdinQuota?.aiCreditOveragesEnabled ?? false)
  );

  const subagentSteps = steps.filter(s => s && (s.isSidechain || (s.agentId && s.agentId !== 'parent')));
  const dualTtl = computeDualTtlState(steps, { nowMs, subagentSteps });
  const prefixDiff = computePrefixMutationDiff(steps);

  const hasMultipleModelsInSteps = new Set(turns.map(t => t.modelId)).size > 1;
  const turnsToUse = (!hasMultipleModelsInSteps && Array.isArray(genMetadata?.recentTurns) && genMetadata.recentTurns.length > 0)
    ? genMetadata.recentTurns.map((r, idx) => ({
        stepIndex: r.stepIndex ?? idx,
        modelId: normalizeModelId(r.model || runningModel),
        modelRaw: r.model || runningModelRaw,
        inputTokens: Number(r.inputTokens || 0),
        cacheReadTokens: Number(r.cacheReadTokens || 0),
        cacheCreationTokens: 0,
        outputTokens: Number(r.outputTokens || 0),
        timestampMs: r.createdAt ? Date.parse(r.createdAt) : nowMs,
        createdAt: r.createdAt
      }))
    : turns;

  const effectiveIsAuto = Boolean(
    isAutoMode ??
    (activeEffortProfile?.tier === 'STANDARD' || activeEffortProfile?.shortLabel === 'Auto')
  );
  const poolsResult = trackModelCachePools(turnsToUse, { nowMs, prefixDiff });
  const thrashResult = detectRouterThrash(turnsToUse, effectiveIsAuto, {
    totalTokens: totalActiveTokens,
    reclaimableTokens: reclaimableTokens || sludgeTokens || 0,
    standbyCache: poolsResult.standbyCache,
    lastSwitchEvent: poolsResult.lastSwitchEvent
  });

  if (thrashResult.state === 'AUTO_ROUTER_THRASH') {
    stepPrefixBustDetected = true;
    stepPrefixBustCause = {
      cause: 'auto_router_thrash',
      switchCount: thrashResult.switchCount,
      models: thrashResult.modelsInvolved,
      badgeText: thrashResult.badgeText,
      tooltip: thrashResult.tooltip
    };
  } else if (thrashResult.state === 'MODEL_SWITCH_COLD_START' && !stepPrefixBustCause) {
    stepPrefixBustDetected = true;
    stepPrefixBustCause = {
      cause: 'model_switch',
      to: thrashResult.currentDisplayName || thrashResult.currentShortName
    };
  } else if (poolsResult.lastSwitchEvent?.warmPoolBustedReason && !stepPrefixBustCause) {
    stepPrefixBustDetected = true;
    stepPrefixBustCause = {
      cause: 'warm_pool_busted',
      reason: poolsResult.lastSwitchEvent.warmPoolBustedReason
    };
  }

  // Prefix cache TTL state & Prefix Bust vs Natural Expiration
  const idleSeconds = latestStepTimestampMs > 0
    ? Math.max(0, Math.round((nowMs - latestStepTimestampMs) / 1000))
    : 0;
  const cacheTtlRemainingSec = latestStepTimestampMs > 0
    ? Math.max(0, QUOTA_CONSTANTS.CACHE_TTL_SECONDS - idleSeconds)
    : QUOTA_CONSTANTS.CACHE_TTL_SECONDS;
  const isCacheCold = latestStepTimestampMs > 0 && cacheTtlRemainingSec === 0;
  const cacheBreakRisk = !isCacheCold && cacheTtlRemainingSec > 0 && cacheTtlRemainingSec <= 60;
  const ttlExpirationPulse = !isCacheCold && cacheTtlRemainingSec > 0 && cacheTtlRemainingSec <= QUOTA_CONSTANTS.TTL_PULSE_THRESHOLD_SECONDS;

  const lastTurnPrefixBust = Boolean(
    genMetadata?.prefixBustDetected ||
    stepPrefixBustDetected ||
    (stdinQuota?.prefix_bust === true)
  );
  const prefixBustDetected = Boolean(
    lastTurnPrefixBust &&
    !isCacheCold &&
    cacheTtlRemainingSec > 0 &&
    idleSeconds < QUOTA_CONSTANTS.CACHE_TTL_SECONDS
  );
  const prefixBustDeltaSec = genMetadata?.prefixBustDeltaSec ?? stepPrefixBustDeltaSec ?? null;
  const prefixBustCause = prefixBustDetected
    ? (genMetadata?.prefixBustCause || stepPrefixBustCause || null)
    : null;
  const prefixBustLabel = prefixBustDetected
    ? (thrashResult.state === 'AUTO_ROUTER_THRASH' ? thrashResult.badgeText : formatPrefixBustLabel(prefixBustCause))
    : '';
  // a turn that read OR wrote the prefix cache (including a busting turn, which writes a
  // fresh prefix) leaves the next turn likely warm while the TTL is still running.
  const nextTurnLikelyWarm = Boolean(
    cacheTtlRemainingSec > 0 &&
    !isCacheCold &&
    (lastTurnCacheRead > 0 || lastTurnCacheCreation > 0 || prefixBustDetected)
  );

  // Next-turn High-effort quota burn projection at current context depth
  const effectiveActive = Math.max(totalActiveTokens, 10000);
  const nextTurnInputCost = (isCacheCold || prefixBustDetected)
    ? effectiveActive * QUOTA_CONSTANTS.UNCACHED_INPUT_WEIGHT
    : effectiveActive * QUOTA_CONSTANTS.CACHE_READ_WEIGHT;
  const nextTurnHighThinkingCost = (EFFORT_PROFILES.HIGH.thinkingReserve + 4000) * QUOTA_CONSTANTS.OUTPUT_THINKING_WEIGHT;
  const nextTurnHighUnits = nextTurnInputCost + nextTurnHighThinkingCost;
  const nextTurnHighSprintPct = parseFloat(((nextTurnHighUnits / QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS) * 100).toFixed(2));
  const nextTurnHighWeeklyPct = parseFloat(((nextTurnHighUnits / QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS) * 100).toFixed(2));

  // Estimates never drive lockout risk or overage alerts (they are a local guess, not host quota).
  const weeklyLockoutRisk = weeklySource !== 'estimate' &&
    (weeklyUsedPct >= 80 || (weeklyUsedPct >= 60 && weeklyUsedPct > sprintUsedPct * 1.2));

  // AI Credit Overage Guardrail & Vision Bug Alert when host-reported 7d usage reaches 100%
  let overageAlert = {
    state: 'NONE',
    severity: 'none',
    message: ''
  };
  if (weeklySource !== 'estimate' && weeklyUsedPct >= 100) {
    if (!overagesEnabled) {
      overageAlert = {
        state: 'LOCKOUT_ALERT',
        severity: 'danger',
        message: OVERAGE_ALERT_MESSAGES.LOCKOUT_ALERT
      };
    } else {
      overageAlert = {
        state: 'OVERAGES_ACTIVE_VISION_WARN',
        severity: 'warn',
        message: OVERAGE_ALERT_MESSAGES.OVERAGES_ACTIVE_VISION_WARN
      };
    }
  }

  const modelPoolName = resolveModelPoolDisplayName(modelId);
  const sprintResetLabel = formatResetCountdown(sprintResetInSec);
  const weeklyResetLabel = formatResetCountdown(weeklyResetInSec);
  const formattedAiCredits = aiCreditsBalance !== null ? aiCreditsBalance.toLocaleString('en-US') : null;

  const effectiveTtlSec = dualTtl.mainTtlTier === '1h' ? dualTtl.mainTtlRemainingSec : cacheTtlRemainingSec;
  const hadWarmCache = sessionCacheReadTokens > 0 || sessionCacheCreationTokens > 0;
  const costGate = evaluateColdSessionCostGate({
    ttlRemainingSec: effectiveTtlSec,
    totalActiveTokens,
    modelId,
    isCacheCold: isCacheCold || effectiveTtlSec <= 0,
    hadWarmCache
  });

  return {
    sprint5h: {
      usedUnits: sprintUnitsUsed,
      poolUnits: QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS,
      usedPct: sprintUsedPct,
      remainingPct: parseFloat((100 - sprintUsedPct).toFixed(1)),
      resetInSeconds: sprintResetInSec,
      resetLabel: sprintResetLabel,
      modelPoolName,
      source: sprintSource,
      poolCountdownLabel: `${modelPoolName} resets in ${sprintResetLabel}`
    },
    weekly7d: {
      usedUnits: weeklyUnitsUsed,
      poolUnits: QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS,
      usedPct: weeklyUsedPct,
      remainingPct: parseFloat((100 - weeklyUsedPct).toFixed(1)),
      sprintToWeeklyMultiplier: QUOTA_CONSTANTS.WEEKLY_TO_SPRINT_RATIO,
      lockoutRisk: weeklyLockoutRisk,
      source: weeklySource,
      resetInSeconds: weeklyResetInSec,
      resetLabel: weeklyResetLabel,
      poolCountdownLabel: `7d resets in ${weeklyResetLabel}`,
      aiCreditOveragesEnabled: overagesEnabled
    },
    aiCredits: {
      balance: aiCreditsBalance,
      formatted: formattedAiCredits,
      label: formattedAiCredits !== null ? `\u2726 AI Credits: ${formattedAiCredits}` : null,
      overagesEnabled
    },
    overageAlert,
    cache: {
      hitRatePct: cacheHitRatePct,
      cacheReadTokens: sessionCacheReadTokens,
      cacheCreationTokens: sessionCacheCreationTokens,
      uncachedInputTokens: sessionInputTokens,
      thinkingTokens: sessionThinkingTokens,
      idleSeconds,
      ttlRemainingSec: cacheTtlRemainingSec,
      isCacheCold,
      cacheBreakRisk,
      ttlExpirationPulse,
      lastTurnPrefixBust,
      prefixBustDetected,
      prefixBustDeltaSec,
      prefixBustCause,
      prefixBustLabel,
      lastTurnCacheReadTokens: lastTurnCacheRead,
      lastTurnCacheCreationTokens: lastTurnCacheCreation,
      nextTurnLikelyWarm,
      dualTtl,
      prefixDiff,
      costGate,
      modelPools: Array.from(poolsResult.modelCachePools.values()),
      standbyCache: poolsResult.standbyCache,
      routerThrash: thrashResult,
      preSwitchCompactionAdvice: thrashResult.preSwitchCompactionAdvice || ''
    },
    forecast: {
      nextTurnHighSprintPct,
      nextTurnHighWeeklyPct,
      summary: `Next High-effort turn costs ~${nextTurnHighSprintPct}% of 5h Sprint (${isCacheCold || prefixBustDetected ? 'cold cache rebuild' : 'warm prefix cache'})`
    }
  };
}

function formatSecondsCompact(sec) {
  const s = Math.max(0, Math.round(Number(sec || 0)));
  if (s <= 0) return '0s';
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  return `${s}s`;
}

/**
 * Computes live dual-TTL countdown timers (main-thread 1h vs 5m + active subagent 5m)
 * and fires an immediate Overage TTL Cliff Alert when a session shifts from 1h to 5m
 * ephemeral cache creation tokens.
 */
export function computeDualTtlState(steps = [], { nowMs = Date.now(), subagentSteps = [] } = {}) {
  let ephemeral1hTokens = 0;
  let ephemeral5mTokens = 0;
  let saw1hEarlier = false;
  let overageTtlCliffDetected = false;
  let overageTtlCliffStepIndex = null;
  let mainTtlTier = '5m';
  let latestMainTs = 0;
  let latestSubagentTs = 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const modelUsage = s.costState?.modelUsage || s['cost-state']?.modelUsage || s.modelUsage || {};
    let turn1h = Number(
      s.cacheCreationEphemeral1hInputTokens ??
      s.usage?.cache_creation_ephemeral_1h_input_tokens ??
      modelUsage.cacheCreationEphemeral1hInputTokens ??
      0
    );
    let turn5m = Number(
      s.cacheCreationEphemeral5mInputTokens ??
      s.usage?.cache_creation_ephemeral_5m_input_tokens ??
      modelUsage.cacheCreationEphemeral5mInputTokens ??
      0
    );

    if (turn1h === 0 && turn5m === 0) {
      for (const val of Object.values(modelUsage)) {
        if (val && typeof val === 'object') {
          turn1h += Number(val.cacheCreationEphemeral1hInputTokens || 0);
          turn5m += Number(val.cacheCreationEphemeral5mInputTokens || 0);
        }
      }
    }

    if (turn1h > 0) {
      ephemeral1hTokens += turn1h;
      saw1hEarlier = true;
      mainTtlTier = '1h';
    }
    if (turn5m > 0) {
      ephemeral5mTokens += turn5m;
      if (saw1hEarlier && turn1h === 0) {
        overageTtlCliffDetected = true;
        overageTtlCliffStepIndex = s.stepIndex ?? i;
      }
      if (turn1h === 0) {
        mainTtlTier = '5m';
      }
    }

    const ts = s.createdAt ? Date.parse(s.createdAt) : (s.timestamp ? Date.parse(s.timestamp) : 0);
    const isSub = Boolean(s.isSidechain || (s.agentId && s.agentId !== 'parent'));
    if (Number.isFinite(ts) && ts > 0) {
      if (isSub) {
        if (ts > latestSubagentTs) latestSubagentTs = ts;
      } else if (ts > latestMainTs) {
        latestMainTs = ts;
      }
    }
  }

  for (const sub of (subagentSteps || [])) {
    const ts = sub?.createdAt ? Date.parse(sub.createdAt) : (sub?.timestamp ? Date.parse(sub.timestamp) : 0);
    if (Number.isFinite(ts) && ts > latestSubagentTs) {
      latestSubagentTs = ts;
    }
  }

  const mainTtlMaxSec = mainTtlTier === '1h' ? 3600 : 300;
  const mainIdleSec = latestMainTs > 0 ? Math.max(0, Math.round((nowMs - latestMainTs) / 1000)) : 0;
  const mainTtlRemainingSec = latestMainTs > 0
    ? Math.max(0, mainTtlMaxSec - mainIdleSec)
    : mainTtlMaxSec;

  let subagentTtlRemainingSec = null;
  if (latestSubagentTs > 0) {
    const subIdleSec = Math.max(0, Math.round((nowMs - latestSubagentTs) / 1000));
    subagentTtlRemainingSec = Math.max(0, 300 - subIdleSec);
  }

  const overageTtlCliffMessage = overageTtlCliffDetected
    ? `⚠️ Overage TTL Cliff Alert: Session shifted from 1h to 5m ephemeral cache TTL at Turn #${overageTtlCliffStepIndex} (12.5x–20x rewrite risk on >5m pauses).`
    : '';

  return {
    mainTtlTier,
    mainTtlMaxSec,
    mainTtlRemainingSec,
    mainTtlFormatted: `${formatSecondsCompact(mainTtlRemainingSec)} (${mainTtlTier})`,
    subagentTtlRemainingSec,
    subagentTtlFormatted: subagentTtlRemainingSec !== null ? `${formatSecondsCompact(subagentTtlRemainingSec)} (5m subagent)` : null,
    ephemeral1hTokens,
    ephemeral5mTokens,
    overageTtlCliffDetected,
    overageTtlCliffStepIndex,
    overageTtlCliffMessage
  };
}

function sha256Short(str) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex').slice(0, 12);
}

function firstDiffByteOffset(a = '', b = '') {
  const s1 = String(a || '');
  const s2 = String(b || '');
  const minLen = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLen; i++) {
    if (s1.charCodeAt(i) !== s2.charCodeAt(i)) {
      return Buffer.byteLength(s1.slice(0, i), 'utf8');
    }
  }
  return Buffer.byteLength(s1.slice(0, minLen), 'utf8');
}

/**
 * Computes rolling hashes across consecutive turns over `api-request-shape` (`shapeHash`),
 * `attachment` deltas (`mcp_instructions_delta`, `deferred_tools_delta`), and message arrays
 * to pinpoint the exact block and byte/token offset that mutated during an unexpected cache miss.
 */
export function computePrefixMutationDiff(steps = []) {
  if (!Array.isArray(steps) || steps.length < 2) {
    return {
      mutated: false,
      turnIndex: null,
      mutatedComponent: null,
      blockIndex: null,
      byteOffset: 0,
      tokenOffset: 0,
      prevHash: null,
      currHash: null,
      prevShapeHash: null,
      currShapeHash: null,
      summary: ''
    };
  }

  for (let i = steps.length - 1; i >= 1; i--) {
    const curr = steps[i] || {};
    const prev = steps[i - 1] || {};

    const prevShape = prev.shapeHash || prev['api-request-shape']?.shapeHash || null;
    const currShape = curr.shapeHash || curr['api-request-shape']?.shapeHash || null;
    const prevMcp = String(prev.mcpInstructions || prev.mcp_instructions_delta || prev.attachment?.mcp_instructions_delta || '');
    const currMcp = String(curr.mcpInstructions || curr.mcp_instructions_delta || curr.attachment?.mcp_instructions_delta || '');
    const prevDef = String(prev.deferredTools || prev.deferred_tools_delta || prev.attachment?.deferred_tools_delta || '');
    const currDef = String(curr.deferredTools || curr.deferred_tools_delta || curr.attachment?.deferred_tools_delta || '');

    if ((prevMcp || currMcp) && prevMcp !== currMcp) {
      const byteOffset = firstDiffByteOffset(prevMcp, currMcp);
      const tokenOffset = Math.ceil(byteOffset / 4);
      const pHash = sha256Short(prevMcp);
      const cHash = sha256Short(currMcp);
      return {
        mutated: true,
        turnIndex: curr.stepIndex ?? i,
        mutatedComponent: 'MCP_INSTRUCTIONS',
        blockIndex: 0,
        byteOffset,
        tokenOffset,
        prevHash: pHash,
        currHash: cHash,
        prevShapeHash: prevShape || pHash,
        currShapeHash: currShape || cHash,
        summary: `Prefix mutated at Turn #${curr.stepIndex ?? i} in MCP_INSTRUCTIONS (block #0, byte +${byteOffset}, ~token +${tokenOffset})`
      };
    }

    if ((prevDef || currDef) && prevDef !== currDef) {
      const byteOffset = firstDiffByteOffset(prevDef, currDef);
      const tokenOffset = Math.ceil(byteOffset / 4);
      const pHash = sha256Short(prevDef);
      const cHash = sha256Short(currDef);
      return {
        mutated: true,
        turnIndex: curr.stepIndex ?? i,
        mutatedComponent: 'DEFERRED_TOOLS',
        blockIndex: 1,
        byteOffset,
        tokenOffset,
        prevHash: pHash,
        currHash: cHash,
        prevShapeHash: prevShape || pHash,
        currShapeHash: currShape || cHash,
        summary: `Prefix mutated at Turn #${curr.stepIndex ?? i} in DEFERRED_TOOLS (block #1, byte +${byteOffset}, ~token +${tokenOffset})`
      };
    }

    if (prevShape && currShape && prevShape !== currShape) {
      const prevBody = String(prev.content || '');
      const currBody = String(curr.content || '');
      const byteOffset = firstDiffByteOffset(prevBody, currBody);
      const tokenOffset = Math.ceil(byteOffset / 4);
      return {
        mutated: true,
        turnIndex: curr.stepIndex ?? i,
        mutatedComponent: 'SYSTEM_SHAPE',
        blockIndex: 0,
        byteOffset,
        tokenOffset,
        prevHash: prevShape,
        currHash: currShape,
        prevShapeHash: prevShape,
        currShapeHash: currShape,
        summary: `Prefix shapeHash mutated at Turn #${curr.stepIndex ?? i} (${prevShape.slice(0, 8)} -> ${currShape.slice(0, 8)}, byte +${byteOffset}, ~token +${tokenOffset})`
      };
    }

    const prevBlocks = Array.isArray(prev.prefixBlocks || prev.messageRequestContext) ? (prev.prefixBlocks || prev.messageRequestContext) : null;
    const currBlocks = Array.isArray(curr.prefixBlocks || curr.messageRequestContext) ? (curr.prefixBlocks || curr.messageRequestContext) : null;
    if (prevBlocks && currBlocks) {
      let runningBytes = 0;
      const minBlocks = Math.min(prevBlocks.length, currBlocks.length);
      for (let bIdx = 0; bIdx < minBlocks; bIdx++) {
        const pb = typeof prevBlocks[bIdx] === 'string' ? prevBlocks[bIdx] : JSON.stringify(prevBlocks[bIdx]);
        const cb = typeof currBlocks[bIdx] === 'string' ? currBlocks[bIdx] : JSON.stringify(currBlocks[bIdx]);
        if (pb !== cb) {
          const innerByte = firstDiffByteOffset(pb, cb);
          const byteOffset = runningBytes + innerByte;
          const tokenOffset = Math.ceil(byteOffset / 4);
          const pHash = sha256Short(pb);
          const cHash = sha256Short(cb);
          return {
            mutated: true,
            turnIndex: curr.stepIndex ?? i,
            mutatedComponent: 'MESSAGE_PREFIX',
            blockIndex: bIdx,
            byteOffset,
            tokenOffset,
            prevHash: pHash,
            currHash: cHash,
            prevShapeHash: pHash,
            currShapeHash: cHash,
            summary: `Prefix message block #${bIdx} mutated at Turn #${curr.stepIndex ?? i} (byte +${byteOffset}, ~token +${tokenOffset})`
          };
        }
        runningBytes += Buffer.byteLength(pb, 'utf8');
      }
    }
  }

  return {
    mutated: false,
    turnIndex: null,
    mutatedComponent: null,
    blockIndex: null,
    byteOffset: 0,
    tokenOffset: 0,
    prevHash: null,
    currHash: null,
    prevShapeHash: null,
    currShapeHash: null,
    summary: ''
  };
}

/**
 * Cold-Session Cost Gate & Optional Keepwarm Controller.
 * At `TTL <= 120s` on contexts >50k tokens, compares warm compaction cost vs cold rewrite.
 * When expired (`TTL === 0s`), renders a Cold Session Cost Gate banner with exact dollar/quota penalty.
 */
export function evaluateColdSessionCostGate({
  ttlRemainingSec = 300,
  totalActiveTokens = 0,
  modelId = 'gemini-4-argon',
  pricePerMillionUsd = 3.0,
  isCacheCold = false,
  hadWarmCache = true
} = {}) {
  const activeTok = Math.max(0, Number(totalActiveTokens) || 0);
  const ttlSec = Math.max(0, Math.round(Number(ttlRemainingSec ?? 300)));
  const price = Number(pricePerMillionUsd) > 0 ? Number(pricePerMillionUsd) : 3.0;

  // Warm cache read (0.1x) + compact summary vs Cold 5m/1h cache write (1.25x - 2.0x = 12.5x - 20x warm read)
  const warmCompactionCostUsd = parseFloat(Math.max(0.01, (activeTok / 1_000_000) * price * 0.125).toFixed(2));
  const coldRewriteCostUsd = parseFloat(Math.max(0.05, (activeTok / 1_000_000) * price * 3.125).toFixed(2));
  const costMultiplier = parseFloat((coldRewriteCostUsd / Math.max(0.01, warmCompactionCostUsd)).toFixed(1));
  const quotaPenaltyUnits = Math.round(activeTok * (QUOTA_CONSTANTS.UNCACHED_INPUT_WEIGHT - QUOTA_CONSTANTS.CACHE_READ_WEIGHT));

  if (activeTok <= 50000 || !hadWarmCache) {
    return {
      state: 'NOMINAL',
      ttlRemainingSec: ttlSec,
      warmCompactionCostUsd,
      coldRewriteCostUsd,
      costMultiplier,
      quotaPenaltyUnits,
      bannerMessage: ''
    };
  }

  if (isCacheCold || ttlSec === 0) {
    return {
      state: 'COLD_COST_GATE',
      ttlRemainingSec: 0,
      warmCompactionCostUsd,
      coldRewriteCostUsd,
      costMultiplier,
      quotaPenaltyUnits,
      bannerMessage: `🛑 Cold Session Cost Gate: Prefix cache expired (0s TTL). Sending next message cold costs ~$${coldRewriteCostUsd.toFixed(2)} (+${Math.round(quotaPenaltyUnits / 1000)}k quota units, ${costMultiplier}x warm rate) vs $0.00 1-Click Handoff Distillation (.handoff.md).`
    };
  }

  if (ttlSec <= 120) {
    return {
      state: 'KEEPWARM_WARNING',
      ttlRemainingSec: ttlSec,
      warmCompactionCostUsd,
      coldRewriteCostUsd,
      costMultiplier,
      quotaPenaltyUnits,
      bannerMessage: `⏱️ Cache Expiring (${ttlSec}s left): Warm compaction now costs ~$${warmCompactionCostUsd.toFixed(2)} vs ~$${coldRewriteCostUsd.toFixed(2)} cold rewrite after TTL expires.`
    };
  }

  return {
    state: 'NOMINAL',
    ttlRemainingSec: ttlSec,
    warmCompactionCostUsd,
    coldRewriteCostUsd,
    costMultiplier,
    quotaPenaltyUnits,
    bannerMessage: ''
  };
}

