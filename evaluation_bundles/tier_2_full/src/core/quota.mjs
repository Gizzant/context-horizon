import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { getHomeDir } from './paths.mjs';
import { EFFORT_PROFILES } from './constants.mjs';

/**
 * Rank #1 & Phase 2 (Layer 2): Dual-Pool Quota (5-Hour Sprint vs. 7-Day Weekly Marathon),
 * Live Model Pool Reset Timers, AI Credit Overage Guardrails, Prefix Bust Detection &
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
  const s = String(modelId || '').toLowerCase().trim();
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

/**
 * Extracts port and CSRF token from command lines matching agy --hub or language_server.
 */
export function extractHubProcessInfo(commandLine = '') {
  if (!commandLine || typeof commandLine !== 'string') return null;
  const isAgyHub = /\bagy(?:\.exe)?\b.*--hub\b/i.test(commandLine) || /\blanguage_server(?:\.exe)?\b/i.test(commandLine);
  if (!isAgyHub) return null;

  let port = null;
  const portMatch = commandLine.match(/(?:--port|-port)[\s=]+(\d+)/i);
  if (portMatch) {
    port = parseInt(portMatch[1], 10);
  }

  let csrfToken = null;
  const csrfMatch = commandLine.match(/(?:--csrf[-_]token)[\s=]+([a-zA-Z0-9_-]+)/i);
  if (csrfMatch) {
    csrfToken = csrfMatch[1];
  }

  return {
    port,
    csrfToken,
    commandLine
  };
}

/**
 * Discovers running local Antigravity hub / language_server processes.
 */
export async function discoverLocalAntigravityHub() {
  if (process.env.ANTIGRAVITY_LANGUAGE_SERVER_PORT) {
    return {
      port: Number(process.env.ANTIGRAVITY_LANGUAGE_SERVER_PORT),
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN || null
    };
  }

  try {
    const { execFile } = await import('node:child_process');
    const execSafe = (cmd, args, timeoutMs = 2000) => new Promise((resolve) => {
      try {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
          resolve(String(stdout || ''));
        });
      } catch {
        resolve('');
      }
    });

    if (process.platform === 'win32') {
      const psScript = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "agy.*--hub|language_server" } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      const out = await execSafe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], 2000);
      if (out) {
        const parsed = JSON.parse(out);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          const info = extractHubProcessInfo(item?.CommandLine);
          if (info && info.port) return info;
        }
      }
    } else {
      const out = await execSafe('ps', ['-eo', 'pid,args'], 2000);
      for (const line of out.split(/\r?\n/)) {
        if (/agy.*--hub|language_server/i.test(line)) {
          const info = extractHubProcessInfo(line);
          if (info && info.port) return info;
        }
      }
    }
  } catch {}

  return null;
}

function makeJsonPostRequest({ protocol = 'http', host, port, path, headers = {}, timeoutMs = 200 }) {
  const lib = protocol === 'https' ? https : http;
  return new Promise((resolve) => {
    const opts = {
      hostname: host,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers
      },
      timeout: timeoutMs
    };
    if (protocol === 'https') {
      opts.rejectUnauthorized = false;
    }
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}');
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write('{}');
    req.end();
  });
}

/**
 * Queries the local Antigravity language_server / agy --hub gRPC-JSON endpoint on 127.0.0.1
 * (GetUserStatus / GetUsageLimits) with plain HTTP probing first, CSRF headers, and safe HTTPS fallback.
 */
export async function queryLocalLanguageServerStatus({
  port = Number(process.env.ANTIGRAVITY_LANGUAGE_SERVER_PORT || 0),
  host = '127.0.0.1',
  endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus',
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || null,
  timeoutMs = 200
} = {}) {
  let resolvedPort = port;
  let resolvedCsrf = csrfToken;

  if ((!resolvedPort || resolvedPort <= 0) && typeof discoverLocalAntigravityHub === 'function') {
    const discovered = await discoverLocalAntigravityHub();
    if (discovered?.port) {
      resolvedPort = discovered.port;
      if (!resolvedCsrf && discovered.csrfToken) {
        resolvedCsrf = discovered.csrfToken;
      }
    }
  }

  if (!resolvedPort || resolvedPort <= 0) return null;

  const headers = {};
  if (resolvedCsrf) {
    headers['x-codeium-csrf-token'] = resolvedCsrf;
  }

  // Probe plain HTTP first (v2.6.0+ agy --hub default)
  const httpRes = await makeJsonPostRequest({
    protocol: 'http',
    host,
    port: resolvedPort,
    path: endpoint,
    headers,
    timeoutMs
  });
  if (httpRes && typeof httpRes === 'object' && Object.keys(httpRes).length > 0) {
    return httpRes;
  }

  // Fallback to HTTPS with rejectUnauthorized: false
  const httpsRes = await makeJsonPostRequest({
    protocol: 'https',
    host,
    port: resolvedPort,
    path: endpoint,
    headers,
    timeoutMs
  });
  if (httpsRes && typeof httpsRes === 'object' && Object.keys(httpsRes).length > 0) {
    return httpsRes;
  }

  return httpRes || httpsRes || null;
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
      sessionInputTokens += rawInput;
      sessionCacheReadTokens += rawCacheRead;
      sessionCacheCreationTokens += rawCacheCreate;
      // Detect mid-run prefix bust: explicit input tokens > 0 with cache_read_tokens == 0 within < 300s of previous turn
      if (i > 0 && rawCacheRead === 0 && rawInput > 0 && gapSec !== null && gapSec < QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
        stepPrefixBustDetected = true;
        stepPrefixBustDeltaSec = Math.round(gapSec);
      } else if (rawCacheRead > 0) {
        stepPrefixBustDetected = false;
      }
    } else if (s.type === 'PLANNER_RESPONSE' && i > 0) {
      // Infer prefix cache read vs write when JSONL lacks explicit usage counters
      const effectiveGapSec = gapSec !== null ? gapSec : 30;
      if (effectiveGapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
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

  // Reconcile with host-reported quota buckets / GetUserStatus if present
  if (stdinQuota && typeof stdinQuota === 'object') {
    if (typeof stdinQuota.remaining_fraction === 'number') {
      sprintUsedPct = parseFloat(Math.max(0, Math.min(100, (1 - stdinQuota.remaining_fraction) * 100)).toFixed(1));
    }
    const weeklyFrac = stdinQuota.buckets?.weekly?.remaining_fraction ?? stdinQuota.weekly_remaining_fraction;
    if (typeof weeklyFrac === 'number') {
      weeklyUsedPct = parseFloat(Math.max(0, Math.min(100, (1 - weeklyFrac) * 100)).toFixed(1));
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
  const prefixBustLabel = prefixBustDetected ? OVERAGE_ALERT_MESSAGES.PREFIX_BUST_LABEL : '';

  // Next-turn High-effort quota burn projection at current context depth
  const effectiveActive = Math.max(totalActiveTokens, 10000);
  const nextTurnInputCost = (isCacheCold || prefixBustDetected)
    ? effectiveActive * QUOTA_CONSTANTS.UNCACHED_INPUT_WEIGHT
    : effectiveActive * QUOTA_CONSTANTS.CACHE_READ_WEIGHT;
  const nextTurnHighThinkingCost = (EFFORT_PROFILES.HIGH.thinkingReserve + 4000) * QUOTA_CONSTANTS.OUTPUT_THINKING_WEIGHT;
  const nextTurnHighUnits = nextTurnInputCost + nextTurnHighThinkingCost;
  const nextTurnHighSprintPct = parseFloat(((nextTurnHighUnits / QUOTA_CONSTANTS.DEFAULT_SPRINT_POOL_UNITS) * 100).toFixed(2));
  const nextTurnHighWeeklyPct = parseFloat(((nextTurnHighUnits / QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS) * 100).toFixed(2));

  const weeklyLockoutRisk = weeklyUsedPct >= 80 || (weeklyUsedPct >= 60 && weeklyUsedPct > sprintUsedPct * 1.2);

  // AI Credit Overage Guardrail & Vision Bug Alert when 7d usage reaches 100%
  let overageAlert = {
    state: 'NONE',
    severity: 'none',
    message: ''
  };
  if (weeklyUsedPct >= 100) {
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
      poolCountdownLabel: `${modelPoolName}: Resets in ${sprintResetLabel}`
    },
    weekly7d: {
      usedUnits: weeklyUnitsUsed,
      poolUnits: QUOTA_CONSTANTS.DEFAULT_WEEKLY_POOL_UNITS,
      usedPct: weeklyUsedPct,
      remainingPct: parseFloat((100 - weeklyUsedPct).toFixed(1)),
      sprintToWeeklyMultiplier: QUOTA_CONSTANTS.WEEKLY_TO_SPRINT_RATIO,
      lockoutRisk: weeklyLockoutRisk,
      resetInSeconds: weeklyResetInSec,
      resetLabel: weeklyResetLabel,
      poolCountdownLabel: `7d Usage: ${weeklyUsedPct}% (Resets in ${weeklyResetLabel})`,
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
      prefixBustLabel
    },
    forecast: {
      nextTurnHighSprintPct,
      nextTurnHighWeeklyPct,
      summary: `Next High-effort turn costs ~${nextTurnHighSprintPct}% of 5h Sprint (${isCacheCold || prefixBustDetected ? 'cold cache rebuild' : 'warm prefix cache'})`
    }
  };
}
