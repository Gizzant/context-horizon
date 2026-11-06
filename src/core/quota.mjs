import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';
import { EFFORT_PROFILES } from './constants.mjs';

/**
 * Rank #1: Dual-Pool Quota (5-Hour Sprint vs. 7-Day Weekly Marathon) &
 * Cache-Read Telemetry Engine.
 *
 * Models Antigravity Pro/Ultra dual-pool quota mechanics:
 * - 5-hour rolling Sprint window baseline: 5,000,000 weighted token units
 *   (where cached reads count at 0.10x, uncached inputs at 1.0x, and output/thinking at 3.0x).
 * - 7-day rolling Weekly Marathon window: 2.8x the 5-hour Sprint pool (14,000,000 weighted units).
 * - Prefix Cache TTL: 300 seconds (5 minutes) since the latest model response.
 */

export const QUOTA_CONSTANTS = Object.freeze({
  SPRINT_WINDOW_MS: 5 * 60 * 60 * 1000,       // 5 hours
  WEEKLY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,  // 7 days
  DEFAULT_SPRINT_POOL_UNITS: 5000000,         // ~5M weighted token units per 5h window
  WEEKLY_TO_SPRINT_RATIO: 2.8,                // 2.33x to 3.5x empirical Pro ratio
  DEFAULT_WEEKLY_POOL_UNITS: 14000000,        // 2.8 * 5M
  CACHE_TTL_SECONDS: 300,                     // 5-minute prompt prefix cache TTL
  CACHE_READ_WEIGHT: 0.10,
  UNCACHED_INPUT_WEIGHT: 1.00,
  OUTPUT_THINKING_WEIGHT: 3.00
});

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
 * Computes session and rolling 5h/7d dual-pool quota & cache telemetry.
 */
export function computeQuotaAndCacheTelemetry(steps = [], {
  sessionId = 'unknown',
  totalActiveTokens = 0,
  activeEffortProfile = EFFORT_PROFILES.STANDARD,
  stdinQuota = null,
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

    if (rawCacheRead > 0 || rawCacheCreate > 0 || rawInput > 0) {
      sessionInputTokens += rawInput;
      sessionCacheReadTokens += rawCacheRead;
      sessionCacheCreationTokens += rawCacheCreate;
    } else if (s.type === 'PLANNER_RESPONSE' && i > 0) {
      // Infer prefix cache read vs write when JSONL lacks explicit usage counters
      const prevTs = steps[i - 1]?.createdAt ? Date.parse(steps[i - 1].createdAt) : 0;
      const currTs = s.createdAt ? Date.parse(s.createdAt) : 0;
      const gapSec = (prevTs > 0 && currTs > prevTs) ? (currTs - prevTs) / 1000 : 30;
      if (gapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
        sessionCacheReadTokens += Math.max(0, cumContextEst - stepTok);
        sessionCacheCreationTokens += stepTok;
      } else {
        sessionInputTokens += cumContextEst;
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
  for (const entry of Object.values(ledger.sessions)) {
    const ts = entry.updatedAtMs || 0;
    const units = Number(entry.weightedUnits || 0);
    if (ts >= cutoff7d) weeklyUnitsUsed += units;
    if (ts >= cutoff5h) sprintUnitsUsed += units;
  }

  if (sprintUnitsUsed === 0 && weightedUnits > 0) sprintUnitsUsed = weightedUnits;
  if (weeklyUnitsUsed === 0 && weightedUnits > 0) weeklyUnitsUsed = weightedUnits;

  let sprintUsedPct = parseFloat(Math.min(100, (sprintUnitsUsed / QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS) * 100).toFixed(1));
  let weeklyUsedPct = parseFloat(Math.min(100, (weeklyUnitsUsed / QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS) * 100).toFixed(1));

  // Reconcile with host-reported quota buckets if present
  if (stdinQuota && typeof stdinQuota === 'object') {
    if (typeof stdinQuota.remaining_fraction === 'number') {
      sprintUsedPct = parseFloat(Math.max(0, Math.min(100, (1 - stdinQuota.remaining_fraction) * 100)).toFixed(1));
    }
    const weeklyFrac = stdinQuota.buckets?.weekly?.remaining_fraction ?? stdinQuota.weekly_remaining_fraction;
    if (typeof weeklyFrac === 'number') {
      weeklyUsedPct = parseFloat(Math.max(0, Math.min(100, (1 - weeklyFrac) * 100)).toFixed(1));
    }
  }

  // Prefix cache TTL state
  const idleSeconds = latestStepTimestampMs > 0
    ? Math.max(0, Math.round((nowMs - latestStepTimestampMs) / 1000))
    : 0;
  const cacheTtlRemainingSec = latestStepTimestampMs > 0
    ? Math.max(0, QUOTA_CONSTANTS.CACHE_TTL_SECONDS - idleSeconds)
    : QUOTA_CONSTANTS.CACHE_TTL_SECONDS;
  const isCacheCold = latestStepTimestampMs > 0 && cacheTtlRemainingSec === 0;
  const cacheBreakRisk = !isCacheCold && cacheTtlRemainingSec > 0 && cacheTtlRemainingSec <= 60;

  // Next-turn High-effort quota burn projection at current context depth
  const effectiveActive = Math.max(totalActiveTokens, 10000);
  const nextTurnInputCost = isCacheCold
    ? effectiveActive * QUOTA_CONSTANTS.UNCACHED_INPUT_WEIGHT
    : effectiveActive * QUOTA_CONSTANTS.CACHE_READ_WEIGHT;
  const nextTurnHighThinkingCost = (EFFORT_PROFILES.HIGH.thinkingReserve + 4000) * QUOTA_CONSTANTS.OUTPUT_THINKING_WEIGHT;
  const nextTurnHighUnits = nextTurnInputCost + nextTurnHighThinkingCost;
  const nextTurnHighSprintPct = parseFloat(((nextTurnHighUnits / QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS) * 100).toFixed(2));
  const nextTurnHighWeeklyPct = parseFloat(((nextTurnHighUnits / QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS) * 100).toFixed(2));

  const weeklyLockoutRisk = weeklyUsedPct >= 80 || (weeklyUsedPct >= 60 && weeklyUsedPct > sprintUsedPct * 1.2);

  return {
    sprint5h: {
      usedUnits: sprintUnitsUsed,
      poolUnits: QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS,
      usedPct: sprintUsedPct,
      remainingPct: parseFloat((100 - sprintUsedPct).toFixed(1))
    },
    weekly7d: {
      usedUnits: weeklyUnitsUsed,
      poolUnits: QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS,
      usedPct: weeklyUsedPct,
      remainingPct: parseFloat((100 - weeklyUsedPct).toFixed(1)),
      sprintToWeeklyMultiplier: QUOTA_CONSTANTS.WEEKLY_TO_SPRINT_RATIO,
      lockoutRisk: weeklyLockoutRisk
    },
    cache: {
      hitRatePct: cacheHitRatePct,
      cacheReadTokens: sessionCacheReadTokens,
      cacheCreationTokens: sessionCacheCreationTokens,
      uncachedInputTokens: sessionInputTokens,
      thinkingTokens: sessionThinkingTokens,
      idleSeconds,
      ttlRemainingSec: cacheTtlRemainingSec,
      isCacheCold,
      cacheBreakRisk
    },
    forecast: {
      nextTurnHighSprintPct,
      nextTurnHighWeeklyPct,
      summary: `Next High-effort turn costs ~${nextTurnHighSprintPct}% of 5h Sprint (${isCacheCold ? 'cold cache rebuild' : 'warm prefix cache'})`
    }
  };
}
