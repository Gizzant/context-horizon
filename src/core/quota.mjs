import fs from 'node:fs';
import path from 'node:path';
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
 * Phase 2: attributes a prefix bust to a model switch when the busting step (or the step
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
 * Prefix Bust label. A known model-switch cause gets a plain-language amber label; an unknown
 * cause keeps the legacy label.
 */
export function formatPrefixBustLabel(cause = null) {
  if (cause && cause.cause === 'model_switch' && cause.to) {
    return `Last turn: cache miss (model switch \u2192 ${humanizeModelLabel(cause.to)})`;
  }
  return OVERAGE_ALERT_MESSAGES.PREFIX_BUST_LABEL;
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

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const stepTok = s.outputTokens || Math.round((s.untruncatedLength || 0) / 4) || 0;
    cumContextEst += stepTok;

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
      const hadPriorCacheHit = sessionCacheReadTokens > 0;
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
    } else if (s.type === 'PLANNER_RESPONSE' && i > 0) {
      // Infer prefix cache read vs write when JSONL lacks explicit usage counters
      const effectiveGapSec = gapSec !== null ? gapSec : 30;
      if (effectiveGapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
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
    : (steps.length > 1 ? 88 : 0);

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
    ledger.sessions[sessionId] = {
      updatedAtMs: latestStepTimestampMs || nowMs,
      weightedUnits,
      cacheReadTokens: sessionCacheReadTokens,
      inputTokens: sessionInputTokens,
      outputTokens: sessionOutputTokens,
      thinkingTokens: sessionThinkingTokens
    };
    saveQuotaLedger(ledger, cacheDir);
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
  const prefixBustLabel = prefixBustDetected ? formatPrefixBustLabel(prefixBustCause) : '';
  // Phase 2: a turn that read OR wrote the prefix cache (including a busting turn, which writes a
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
      nextTurnLikelyWarm
    },
    forecast: {
      nextTurnHighSprintPct,
      nextTurnHighWeeklyPct,
      summary: `Next High-effort turn costs ~${nextTurnHighSprintPct}% of 5h Sprint (${isCacheCold || prefixBustDetected ? 'cold cache rebuild' : 'warm prefix cache'})`
    }
  };
}
