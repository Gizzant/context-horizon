/**
 * @file src/ui/modViews.mjs
 * Multi-Surface UI Renderers for Claude Code Highbeam:
 *   1. `AbovePrompt` Band: 1-line 40-Cell Horizon Bar + active Coach Pill (`OFF | COACH | AUTO_PILOT`)
 *   2. Docked `Pane` (`/horizon`): Strict 5-Box Simple View vertical hierarchy (zero promotional text)
 *   3. `Spinner` Suffix: Compact live status (`· Cache 95% (4m12s) · Saved $1.84`)
 *   4. Terminal `statusLine`: Responsive ANSI single-line bar adapting to 80 / 110 / 144 columns
 */

import {
  computeHorizonGrid,
  extractHorizonTokens,
  isNoColorEnabled
} from './horizonGrid.mjs';
import { resolveEffectiveRates } from '../config/catalogLoader.mjs';
import {
  computeBreakEvenCachedTokens,
  resolveNaturalDownshiftPeer
} from '../coach/cacheGravityRouter.mjs';
import { formatRemainingTtl } from '../coach/ttlWatchdog.mjs';
import { SAVINGS_BUCKETS, getSavedQuotaReceiptSummary } from '../coach/savedQuotaLedger.mjs';
import {
  formatRetentionCompact,
  formatRetentionLabel,
  formatDriftCompact,
  formatDriftLabel
} from '../telemetry/sprintMetrics.mjs';
import { computeSwarmSummary, formatSwarmCompact } from '../telemetry/swarmTopology.mjs';

const ANSI_ESCAPE_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Formats seconds into `MM:SS` digital clock notation (e.g. `04:12`, `00:38`).
 * @param {number} seconds
 * @returns {string}
 */
export function formatTtlClock(seconds = 0) {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * Strips ANSI escape sequences to measure exact visible terminal column width.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text = '') {
  return String(text || '').replace(ANSI_ESCAPE_REGEX, '');
}

/**
 * Truncates an ANSI-styled string to at most `maxCols` visible columns while stepping over
 * `\x1b\[[0-9;]*m` (and CSI) sequences without counting them toward visible width (`ISS-050`).
 * Appends `\x1b[0m` when truncation cuts off while color styling is active.
 *
 * @param {string} ansiStr
 * @param {number} [maxCols=80]
 * @returns {string}
 */
export function truncateAnsiVisible(ansiStr = '', maxCols = 80) {
  const str = String(ansiStr || '');
  const limit = Math.max(0, Math.floor(Number(maxCols ?? 80)));
  if (limit === 0) return '';
  if (stripAnsi(str).length <= limit) return str;

  const csiHeadRegex = /^\x1b\[[0-?]*[ -/]*[@-~]/;
  let out = '';
  let visible = 0;
  let idx = 0;
  let colorActive = false;

  while (idx < str.length && visible < limit) {
    if (str.charCodeAt(idx) === 0x1b) {
      const match = csiHeadRegex.exec(str.slice(idx));
      if (match) {
        const seq = match[0];
        out += seq;
        if (seq === '\x1b[0m' || seq === '\x1b[m') {
          colorActive = false;
        } else if (seq.endsWith('m')) {
          colorActive = true;
        }
        idx += seq.length;
        continue;
      }
    }
    const cp = str.codePointAt(idx);
    const step = cp > 0xffff ? 2 : 1;
    out += str.slice(idx, idx + step);
    visible += 1;
    idx += step;
  }

  if (colorActive && !out.endsWith('\x1b[0m')) {
    out += '\x1b[0m';
  }
  return out;
}

/**
 * Clamps a plain-text line to at most `maxCols` visible columns.
 * @param {string} text
 * @param {number} maxCols
 * @returns {string}
 */
function clampPlainLine(text = '', maxCols = 80) {
  const str = String(text || '');
  if (str.length <= maxCols) return str;
  if (maxCols <= 1) return str.slice(0, maxCols);
  return `${str.slice(0, maxCols - 1)}…`;
}

/**
 * Formats a scale tick label (`0k`, `50k`, `100k`, `200k`, `500k`, `1M`).
 * @param {number} tokens
 * @returns {string}
 */
function formatScaleTickLabel(tokens = 0) {
  const n = Math.max(0, Math.round(Number(tokens || 0)));
  if (n === 0) return '0k';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${Number(m.toFixed(2))}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return Number.isInteger(k) ? `${k}k` : `${Number(k.toFixed(1))}k`;
  }
  return String(n);
}

/**
 * Builds a Tufte scale-tick ruler row (`0k ··· midpoint ··· ceiling`) aligned to `barSpan` columns (`ISS-050`).
 * @param {number} ceilingTokens
 * @param {number} [barSpan=42]
 * @returns {string}
 */
export function buildScaleTickRuler(ceilingTokens = 200000, barSpan = 42) {
  const left = '0k';
  const mid = formatScaleTickLabel(Math.round(ceilingTokens / 2));
  const right = formatScaleTickLabel(ceilingTokens);
  const minPlain = `${left} · ${mid} · ${right}`;
  if (barSpan <= minPlain.length) {
    return minPlain;
  }
  const totalDots = Math.max(2, barSpan - left.length - mid.length - right.length - 4);
  const leftDots = Math.max(1, Math.floor(totalDots / 2));
  const rightDots = Math.max(1, totalDots - leftDots);
  return `${left} ${'·'.repeat(leftDots)} ${mid} ${'·'.repeat(rightDots)} ${right}`;
}

/**
 * Formats token counts compactly (e.g. `0`, `950`, `45.0k`, `90.0k`, `210.0k`, `1.0M`).
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokensCompact(tokens = 0) {
  const n = Math.max(0, Number(tokens || 0));
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(2).replace(/\.00$/, '')}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
  }
  return String(Math.round(n));
}

/**
 * Formats seconds into compact `XmYs` (e.g. `4m12s`, `38s`, `0s`).
 * @param {number} seconds
 * @returns {string}
 */
export function formatDurationCompact(seconds = 0) {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  if (mins > 0) {
    return `${mins}m${String(rem).padStart(2, '0')}s`;
  }
  return `${rem}s`;
}

/**
 * Formats USD amount (`$0.00`, `$1.84`).
 * @param {number} usd
 * @returns {string}
 */
export function formatUsd(usd = 0) {
  const val = Math.max(0, Number(usd || 0));
  return `$${val.toFixed(2)}`;
}

/**
 * Computes live cache hit percentage, remaining TTL seconds, and total saved USD/tokens
 * from telemetry state, optional TTL tick, and optional ledger summary.
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 */
export function deriveSurfaceMetrics(state = {}, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const cw = state.contextWindow || {};
  const pc = state.promptCache || {};
  const roi = state.cacheRoi || {};
  const cumulative = state.cumulative || {};
  const extracted = extractHorizonTokens(state);

  const totalInputTokens = Math.max(
    0,
    Number(
      cw.totalInputTokens ??
        state.totalInputTokens ??
        state.totalTokens ??
        extracted.totalInputTokens ??
        0
    )
  );
  const warmPrefixTokens = Math.max(
    0,
    Number(
      cw.warmPrefixTokens ??
        cw.cachedTokens ??
        state.cachedTokens ??
        state.cacheReadTokens ??
        extracted.cachedHistoryTokens ??
        0
    )
  );
  const cacheWriteTokens = Math.max(
    0,
    Number(
      cw.cacheWriteTokens ??
        cw.lastWriteTokens ??
        state.cacheWriteTokens ??
        state.lastWriteTokens ??
        0
    )
  );
  const hasExplicitCacheRead =
    cw.cacheReadTokens !== undefined || state.cacheReadTokens !== undefined;
  const cacheReadTokens = hasExplicitCacheRead
    ? Math.max(0, Number(cw.cacheReadTokens ?? state.cacheReadTokens ?? 0))
    : Math.max(0, warmPrefixTokens - cacheWriteTokens);

  const cachedTokens = warmPrefixTokens;

  // ISS-006: Check typeof roi.cacheHitRatio === 'number' (including 0, NEVER > 0!) when ROI was evaluated,
  // and fall back to cacheReadTokens / totalInputTokens so Turn-1 cold writes render Cache 0%
  const hasEvaluatedRoi =
    typeof roi.cacheHitRatio === 'number' &&
    (state.lastSource !== 'init' || roi.cacheHitRatio > 0 || Number(roi.actualCacheSpendUSD || 0) > 0);
  const hitRatio = hasEvaluatedRoi
    ? roi.cacheHitRatio
    : totalInputTokens > 0
      ? cacheReadTokens / totalInputTokens
      : 0;
  const cacheHitPct = Math.max(0, Math.min(100, Math.round(hitRatio * 100)));

  let parsedExpiresAtMs = null;
  if (typeof pc.expiresAt === 'number' && Number.isFinite(pc.expiresAt)) {
    parsedExpiresAtMs = pc.expiresAt < 1e11 ? pc.expiresAt * 1000 : pc.expiresAt;
  } else if (typeof pc.expiresAt === 'string' && pc.expiresAt.trim()) {
    const parsed = Date.parse(pc.expiresAt);
    if (!Number.isNaN(parsed)) parsedExpiresAtMs = parsed;
  }

  const explicitTtlOpt =
    options.ttlRemainingSeconds ??
    options.ttlRemainingSec ??
    state.ttlRemainingSeconds ??
    state.ttlRemainingSec ??
    pc.ttlRemainingSec;

  const hasExplicitTtlField =
    typeof explicitTtlOpt === 'number' ||
    (options.ttlTick && typeof options.ttlTick.remainingSeconds === 'number') ||
    parsedExpiresAtMs !== null ||
    typeof pc.ttlSeconds === 'number' ||
    typeof state.ttlSeconds === 'number';

  const hasExplicitWarm = typeof pc.warm === 'boolean' || typeof state.cacheWarm === 'boolean';
  const explicitWarmVal = typeof pc.warm === 'boolean' ? pc.warm : Boolean(state.cacheWarm);

  let remainingSeconds = 0;
  if (typeof explicitTtlOpt === 'number') {
    remainingSeconds = Math.max(0, Math.floor(explicitTtlOpt));
  } else if (options.ttlTick && typeof options.ttlTick.remainingSeconds === 'number') {
    remainingSeconds = Math.max(0, Math.floor(options.ttlTick.remainingSeconds));
  } else if (parsedExpiresAtMs !== null) {
    remainingSeconds = Math.max(0, Math.floor((parsedExpiresAtMs - nowMs) / 1000));
  } else if (typeof pc.ttlSeconds === 'number') {
    remainingSeconds = Math.max(0, Math.floor(pc.ttlSeconds));
  } else if (typeof state.ttlSeconds === 'number') {
    remainingSeconds = Math.max(0, Math.floor(state.ttlSeconds));
  } else if (!hasExplicitTtlField && hasExplicitWarm && explicitWarmVal) {
    remainingSeconds = pc.ttlTier === '1h' ? 3600 : 300;
  }

  // ISS-027: Never allow cacheWarm = true when remainingSeconds <= 0!
  const cacheWarm = hasExplicitWarm
    ? Boolean(explicitWarmVal && remainingSeconds > 0)
    : Boolean(warmPrefixTokens > 0 && remainingSeconds > 0);
  if (!cacheWarm) {
    remainingSeconds = 0;
  }

  const amberAlert = Boolean(
    cacheWarm &&
      (options.ttlTick?.amberAlertActive ||
        (remainingSeconds > 0 && remainingSeconds <= 45 && cachedTokens >= 25000))
  );

  const ledgerSummary =
    options.ledgerSummary ||
    (options.includeDiskLedger !== false
      ? getSavedQuotaReceiptSummary({
          ...options,
          activeSessionId: state.sessionId || options.sessionId || 'default'
        })
      : null);

  const ledgerTokens = Math.max(0, Number(ledgerSummary?.totalSavedTokens || 0));
  const ledgerUSD = Math.max(0, Number(ledgerSummary?.totalSavedUSD || 0));
  const sessionNetSavingsUSD = Math.max(
    0,
    Number(cumulative.netCacheSavingsUSD ?? roi.netCacheSavingsUSD ?? 0)
  );
  const liveSessionCacheReadTokens = Math.max(
    0,
    Math.round(Number(cumulative.cacheReadTokens ?? state.savedTokensTotal ?? 0))
  );

  // Subagent isolated tokens from Task/Agent workers in state.subagents
  let liveSubagentIsolatedTokens = 0;
  if (state.subagents && typeof state.subagents === 'object') {
    for (const worker of Object.values(state.subagents)) {
      liveSubagentIsolatedTokens += Math.max(0, Math.round(Number(worker?.totalTokens || 0)));
    }
  }
  const activeRatesForSub = resolveEffectiveRates(
    state.rawModelId || state.modelId || state.model || 'claude-sonnet-5-5',
    totalInputTokens,
    options
  );
  const liveSubagentIsolatedUSD = Number(
    ((liveSubagentIsolatedTokens / 1_000_000) * Number(activeRatesForSub.inputPer1M || 3)).toFixed(6)
  );

  // Use explicit options.savedUSD / options.savedTokens if passed, else max of ledger + session
  const savedUSD =
    typeof options.savedUSD === 'number'
      ? Math.max(0, options.savedUSD)
      : Number(Math.max(ledgerUSD, sessionNetSavingsUSD).toFixed(2));
  const savedTokens =
    typeof options.savedTokens === 'number'
      ? Math.max(0, Math.round(options.savedTokens))
      : Math.max(ledgerTokens, liveSessionCacheReadTokens);

  const rawSessionTokens = Math.max(
    Number(ledgerSummary?.sessionSavedTokens || 0),
    liveSessionCacheReadTokens + liveSubagentIsolatedTokens,
    typeof options.savedTokens === 'number' ? Math.max(0, Math.round(options.savedTokens)) : 0
  );
  const rawSessionUSD = Math.max(
    Number(ledgerSummary?.sessionSavedUSD || 0),
    sessionNetSavingsUSD + liveSubagentIsolatedUSD,
    typeof options.savedUSD === 'number' ? Math.max(0, options.savedUSD) : 0
  );
  const sessionSavedTokens = Math.max(0, Math.round(options.sessionSavedTokens ?? rawSessionTokens));
  const sessionSavedUSD = Number(
    Math.max(0, Number(options.sessionSavedUSD ?? rawSessionUSD)).toFixed(2)
  );
  const workspace30dSavedTokens = Math.max(
    sessionSavedTokens,
    savedTokens,
    Math.round(Number(options.workspace30dSavedTokens ?? ledgerSummary?.workspace30dSavedTokens ?? 0))
  );
  const workspace30dSavedUSD = Number(
    Math.max(
      sessionSavedUSD,
      savedUSD,
      Number(options.workspace30dSavedUSD ?? ledgerSummary?.workspace30dSavedUSD ?? 0)
    ).toFixed(2)
  );

  // Build 5-category savings breakdown combining ledger + live session telemetry
  const baseCats = ledgerSummary?.categories || {};
  const savingsCategories = {
    cacheReadDiscount: {
      id: 'cacheReadDiscount',
      label: SAVINGS_BUCKETS.cacheReadDiscount.label,
      shortLabel: SAVINGS_BUCKETS.cacheReadDiscount.shortLabel,
      savedTokens: Math.max(
        Number(baseCats.cacheReadDiscount?.savedTokens || 0),
        liveSessionCacheReadTokens
      ),
      savedUSD: Number(
        Math.max(
          Number(baseCats.cacheReadDiscount?.savedUSD || 0),
          sessionNetSavingsUSD
        ).toFixed(4)
      ),
      count: Math.max(
        Number(baseCats.cacheReadDiscount?.count || 0),
        liveSessionCacheReadTokens > 0 ? Math.max(1, Number(state.turnsCompleted || 1)) : 0
      )
    },
    prefixBustAvoided: {
      id: 'prefixBustAvoided',
      label: SAVINGS_BUCKETS.prefixBustAvoided.label,
      shortLabel: SAVINGS_BUCKETS.prefixBustAvoided.shortLabel,
      savedTokens: Math.max(0, Number(baseCats.prefixBustAvoided?.savedTokens || 0)),
      savedUSD: Number(Math.max(0, Number(baseCats.prefixBustAvoided?.savedUSD || 0)).toFixed(4)),
      count: Math.max(0, Number(baseCats.prefixBustAvoided?.count || 0))
    },
    toolOutputCompressed: {
      id: 'toolOutputCompressed',
      label: SAVINGS_BUCKETS.toolOutputCompressed.label,
      shortLabel: SAVINGS_BUCKETS.toolOutputCompressed.shortLabel,
      savedTokens: Math.max(0, Number(baseCats.toolOutputCompressed?.savedTokens || 0)),
      savedUSD: Number(Math.max(0, Number(baseCats.toolOutputCompressed?.savedUSD || 0)).toFixed(4)),
      count: Math.max(0, Number(baseCats.toolOutputCompressed?.count || 0))
    },
    loopAndReadGuarded: {
      id: 'loopAndReadGuarded',
      label: SAVINGS_BUCKETS.loopAndReadGuarded.label,
      shortLabel: SAVINGS_BUCKETS.loopAndReadGuarded.shortLabel,
      savedTokens: Math.max(0, Number(baseCats.loopAndReadGuarded?.savedTokens || 0)),
      savedUSD: Number(Math.max(0, Number(baseCats.loopAndReadGuarded?.savedUSD || 0)).toFixed(4)),
      count: Math.max(0, Number(baseCats.loopAndReadGuarded?.count || 0))
    },
    subagentIsolated: {
      id: 'subagentIsolated',
      label: SAVINGS_BUCKETS.subagentIsolated.label,
      shortLabel: SAVINGS_BUCKETS.subagentIsolated.shortLabel,
      savedTokens: Math.max(
        Number(baseCats.subagentIsolated?.savedTokens || 0),
        liveSubagentIsolatedTokens
      ),
      savedUSD: Number(
        Math.max(
          Number(baseCats.subagentIsolated?.savedUSD || 0),
          liveSubagentIsolatedUSD
        ).toFixed(4)
      ),
      count: Math.max(
        Number(baseCats.subagentIsolated?.count || 0),
        liveSubagentIsolatedTokens > 0 ? Object.keys(state.subagents || {}).length : 0
      )
    }
  };

  let topSavingsDriver = savingsCategories.cacheReadDiscount;
  for (const bucket of Object.values(savingsCategories)) {
    if (
      bucket.savedTokens > topSavingsDriver.savedTokens ||
      (bucket.savedTokens === topSavingsDriver.savedTokens &&
        bucket.savedUSD > topSavingsDriver.savedUSD)
    ) {
      topSavingsDriver = bucket;
    }
  }

  const flightMode = String(
    options.flightMode || state.flightMode || 'COACH'
  ).toUpperCase();

  const ttlTier = pc.ttlTier === '1h' ? '1h' : '5m';
  let breakEvenReadsPerWrite = 0.263;
  if (typeof roi.breakEvenReadsPerWrite === 'number' && roi.breakEvenReadsPerWrite > 0 && state.lastSource !== 'init') {
    breakEvenReadsPerWrite = roi.breakEvenReadsPerWrite;
  } else {
    const activeRates = resolveEffectiveRates(
      state.rawModelId || state.modelId || state.model || 'claude-sonnet-5-5',
      totalInputTokens,
      options
    );
    const mWrite =
      ttlTier === '1h' ? activeRates.multipliers.write1h : activeRates.multipliers.write5m;
    const mRead = activeRates.multipliers.read;
    breakEvenReadsPerWrite = Number(((mWrite - 1) / (1 - mRead)).toFixed(3));
  }
  const sessionFiveMinRoiTarget = Number(roi.sessionFiveMinRoiTarget || 1.39);

  const hasEvaluatedRwRatio =
    typeof roi.readsPerWriteRatio === 'number' &&
    (state.lastSource !== 'init' || roi.readsPerWriteRatio > 0 || Number(roi.actualCacheSpendUSD || 0) > 0);
  const derivedRwRatio = hasEvaluatedRwRatio
    ? roi.readsPerWriteRatio
    : cacheWriteTokens > 0
      ? cacheReadTokens / cacheWriteTokens
      : cacheReadTokens > 0
        ? Infinity
        : 0;
  const readsPerWriteRatio = Math.max(0, Number(derivedRwRatio || 0));
  const negativeCacheRoi =
    typeof roi.negativeCacheRoi === 'boolean' && state.lastSource !== 'init'
      ? roi.negativeCacheRoi
      : cacheWriteTokens > 0 && readsPerWriteRatio < breakEvenReadsPerWrite;

  return {
    totalInputTokens,
    cachedTokens,
    cacheReadTokens,
    cacheWriteTokens,
    warmPrefixTokens,
    cacheHitPct,
    cacheWarm,
    remainingSeconds,
    ttlCompact: cacheWarm ? formatDurationCompact(remainingSeconds) : 'COLD',
    ttlClock: cacheWarm ? formatTtlClock(remainingSeconds) : '00:00',
    ttlTier,
    amberAlert,
    savedUSD,
    savedTokens,
    sessionSavedTokens,
    sessionSavedUSD,
    workspace30dSavedTokens,
    workspace30dSavedUSD,
    savingsCategories,
    topSavingsDriver,
    flightMode: ['OFF', 'COACH', 'AUTO_PILOT'].includes(flightMode) ? flightMode : 'COACH',
    negativeCacheRoi,
    readsPerWriteRatio,
    breakEvenReadsPerWrite,
    sessionFiveMinRoiTarget
  };
}

/**
 * Checks whether a path is a lockfile, log, build artifact, or scratch file eligible
 * for a `.claudeignore` recommendation (never active source code files).
 *
 * @param {string} [filePath='']
 * @returns {boolean}
 */
export function isIgnorableClaudePath(filePath = '') {
  const s = String(filePath || '').trim();
  if (!s) return false;
  return /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|\.(?:log|tmp|bak|min\.js|min\.css|map|bundle\.js)$|(?:^|[\\/])(?:dist|build|coverage|\.next|out|node_modules|\.claude[\\/]cache)[\\/])/i.test(
    s
  );
}

/**
 * Derives plain-English Claude Code status verdict and prioritized action cards
 * for Simple View (Rank 1 & Rank 3) and Advanced View.
 *
 * @param {object} [state={}]
 * @param {object} grid
 * @param {object} metrics
 * @param {object} [options={}]
 */
export function deriveClaudeCodeVerdictAndActions(state = {}, grid, metrics, options = {}) {
  const actions = [];
  let verdict = {
    severity: 'healthy',
    badge: 'HEALTHY',
    headline: metrics.cacheWarm
      ? `Healthy — Prompt Cache Warm (${metrics.ttlCompact})`
      : 'Ready — Cold Prompt Prefix',
    detail: metrics.cacheWarm
      ? `${metrics.cacheHitPct}% of prompt reading at 0.10x cached rates (${metrics.ttlTier} TTL)`
      : 'Next turn establishes the 5m warm prompt cache prefix'
  };

  const reclaimEstimate = Math.max(
    grid.tokens.D,
    Math.round(grid.totalInputTokens * 0.35)
  );

  if (options.breakerVerdict?.triggered) {
    const breakerId =
      options.breakerVerdict.detectorId || options.breakerVerdict.ruleId || 'BREAKER';
    const reasonText =
      options.breakerVerdict.reason || 'Circuit breaker triggered on active tool or model call';
    verdict = {
      severity: 'critical',
      badge: 'CRITICAL',
      headline: `${breakerId} Active — Guard Intervention`,
      detail: reasonText
    };
    actions.push({
      id: breakerId.toLowerCase(),
      severity: 'critical',
      title: `Resolve ${breakerId} guard before continuing`,
      instruction: reasonText,
      commandHint: `npx ah-claude config set ${breakerId} warn`,
      reclaimTokens: 0
    });
  }

  if (state.thinkingDrift?.loop?.triggered) {
    const ratio = state.thinkingDrift.lastDriftRatio ?? 'high';
    if (verdict.severity !== 'critical') {
      verdict = {
        severity: 'critical',
        badge: 'CRITICAL',
        headline: `Critical — Scratchpad Loop Detected (${ratio}x)`,
        detail:
          state.thinkingDrift.loop.message ||
          `DET-21: Thinking tokens exceeded ${ratio}x output tokens with zero file edits`
      };
    }
    actions.push({
      id: 'det-21-loop',
      severity: 'critical',
      title: `Break ${ratio}x thinking loop`,
      instruction:
        'Add a concrete target file path and test constraint to your next prompt, or lower /effort.',
      commandHint: '/effort medium',
      reclaimTokens: Math.max(0, Number(state.contextWindow?.lastThinkingTokens || 4000))
    });
  }

  if (state.cliffTriggered) {
    if (verdict.severity !== 'critical') {
      verdict = {
        severity: 'critical',
        badge: 'CRITICAL',
        headline: 'Critical — Haiku 5.5 100k 5x Pricing Cliff Exceeded',
        detail: 'Total prompt exceeded 100,000 tokens ($0.10 -> $0.50/1M input step-up)'
      };
    }
    actions.push({
      id: 'det-12-cliff',
      severity: 'critical',
      title: 'Exit Haiku 100k 5x pricing cliff now',
      instruction: `Type /compact in the chat box and press Enter to drop below 100k tokens (reclaims ~${formatTokensCompact(reclaimEstimate)}).`,
      commandHint: 'Type /compact in the chat box and press Enter',
      reclaimTokens: reclaimEstimate
    });
  } else if (state.preCliffWarningTriggered) {
    if (verdict.severity === 'healthy') {
      verdict = {
        severity: 'warn',
        badge: 'ACTION NEEDED',
        headline: 'Approaching Haiku 100k 5x Pricing Cliff (>= 90k)',
        detail: 'Compact before 100,000 tokens to avoid the 5x Haiku rate step-up'
      };
    }
    actions.push({
      id: 'det-12-precliff',
      severity: 'warn',
      title: 'Compact before crossing 100k Haiku cliff',
      instruction: `Type /compact in the chat box and press Enter to reclaim ~${formatTokensCompact(reclaimEstimate)} before 100k.`,
      commandHint: 'Type /compact in the chat box and press Enter',
      reclaimTokens: reclaimEstimate
    });
  }

  if (metrics.amberAlert) {
    if (verdict.severity === 'healthy') {
      verdict = {
        severity: 'warn',
        badge: 'CACHE EXPIRING',
        headline: `5m Prompt Cache Expiring in ${metrics.ttlCompact}`,
        detail: `${formatTokensCompact(metrics.cachedTokens)} warm prefix will go cold in ${metrics.ttlClock}`
      };
    }
    actions.push({
      id: 'det-10-ttl',
      severity: 'warn',
      title: `Send next prompt within ${metrics.ttlCompact} or hold prefix edits`,
      instruction:
        'Keep coding to refresh the 5m TTL at 0.10x read cost, and hold CLAUDE.md or .mcp.json edits until PostCompact.',
      commandHint: '/handoff',
      reclaimTokens: metrics.cachedTokens
    });
  }

  if (grid.tokens.D >= 25000 || grid.utilizationPct >= 75) {
    if (verdict.severity === 'healthy') {
      verdict = {
        severity: 'warn',
        badge: 'ACTION NEEDED',
        headline:
          metrics.cacheWarm && metrics.remainingSeconds > 60
            ? `Stale Tool Debt High (${formatTokensCompact(grid.tokens.D)}) — Compact After Cache Window`
            : `Context ${grid.utilizationPct}% Full — Compact Recommended`,
        detail: `${formatTokensCompact(grid.tokens.D)} in middle-window distractors [D]`
      };
    }
    if (metrics.cacheWarm && metrics.remainingSeconds > 60) {
      actions.push({
        id: 'compact-cache-gated',
        severity: 'warn',
        title: `Wait ${metrics.ttlCompact} for warm cache, then compact (~${formatTokensCompact(reclaimEstimate)} reclaimable)`,
        instruction: `Finish your current step while ${formatTokensCompact(metrics.cachedTokens)} is warm (${metrics.ttlCompact} left), then: Type /compact in the chat box and press Enter`,
        commandHint: 'Type /compact in the chat box and press Enter',
        reclaimTokens: reclaimEstimate
      });
    } else {
      actions.push({
        id: 'compact-now',
        severity: 'warn',
        title: `Compact context now (~${formatTokensCompact(reclaimEstimate)} reclaimable)`,
        instruction: 'Type /compact in the chat box and press Enter',
        commandHint: 'Type /compact in the chat box and press Enter',
        reclaimTokens: reclaimEstimate
      });
    }
  }

  if (metrics.negativeCacheRoi) {
    if (verdict.severity === 'healthy') {
      verdict = {
        severity: 'warn',
        badge: 'CACHE ROI WARN',
        headline: 'Cache Write Surcharge Exceeds Read Discount',
        detail: `Reads/Write ${metrics.readsPerWriteRatio.toFixed(2)} < ${metrics.breakEvenReadsPerWrite} break-even`
      };
    }
    actions.push({
      id: 'negative-roi',
      severity: 'warn',
      title: 'Hold CLAUDE.md, .claude/rules/, and .mcp.json mutations',
      instruction: `Keep prefix static for at least 2 turns so 0.10x cache reads amortize the 1.25x write surcharge.`,
      commandHint: 'Hold prefix edits until /compact',
      reclaimTokens: metrics.cacheWriteTokens
    });
  }

  if (actions.length === 0) {
    actions.push({
      id: 'keep-coding',
      severity: 'healthy',
      title: metrics.cacheWarm
        ? `Keep coding — warm prefix active (${metrics.ttlCompact} remaining)`
        : 'Keep coding — context headroom is clean',
      instruction: metrics.cacheWarm
        ? `Hold model switches and CLAUDE.md edits while ${formatTokensCompact(metrics.cachedTokens)} is reading at 0.10x.`
        : 'No compaction or intervention needed right now.',
      commandHint: '',
      reclaimTokens: 0
    });
  }

  const priorityAction = actions[0];
  const secondaryActions = actions.slice(1);

  return {
    verdict,
    priorityAction,
    secondaryActions,
    overflowActionCount: secondaryActions.length
  };
}

/**
 * 1. Renders the `AbovePrompt` 1-line Band with the 40-Cell Horizon Bar and active Coach Pill.
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 * @returns {{
 *   line: string,
 *   plainLine: string,
 *   grid: object,
 *   metrics: object,
 *   coachPill: string
 * }}
 */
export function renderAbovePromptBand(state = {}, options = {}) {
  const maxCols = Math.max(40, Number(options.maxCols || globalThis.process?.stdout?.columns || 80));
  const useAnsi = Boolean(options.ansi) && !isNoColorEnabled(options);
  const grid = computeHorizonGrid(state, options);
  const metrics = deriveSurfaceMetrics(state, options);

  let coachAction = 'HOLD WARM PREFIX';
  if (options.breakerVerdict?.triggered) {
    const breakerId =
      options.breakerVerdict.detectorId || options.breakerVerdict.ruleId || 'BREAKER';
    coachAction = `${breakerId} ACTIVE`;
  } else if (state.thinkingDrift?.loop?.triggered) {
    coachAction = `THINK LOOP ${state.thinkingDrift.lastDriftRatio ?? ''}x`;
  } else if (state.cliffTriggered) {
    coachAction = 'HAIKU 100K CLIFF (5X)';
  } else if (state.preCliffWarningTriggered) {
    coachAction = 'HAIKU 90K PRE-CLIFF';
  } else if (metrics.amberAlert) {
    coachAction = `TTL EXPIRING ${metrics.ttlCompact}`;
  } else if (!metrics.cacheWarm) {
    coachAction = 'COLD PREFIX';
  }

  const coachPill = `[${metrics.flightMode} · ${coachAction}]`;
  const tokenBadge = `${formatTokensCompact(grid.totalInputTokens)}/${grid.zoomTier.id}`;
  const ttlBadge = metrics.cacheWarm ? `TTL ${metrics.ttlCompact}` : 'TTL COLD';

  const suffixWithPct = ` ${tokenBadge} (${grid.utilizationPct}%) · ${ttlBadge} · ${coachPill}`;
  const suffixCompact = ` ${tokenBadge} · ${ttlBadge} · ${coachPill}`;

  let plainCandidate = `AH ${grid.bracketedBar}${suffixWithPct}`;
  let ansiCandidate = `AH ${grid.ansiCodeBar}${suffixWithPct}`;

  if (plainCandidate.length > maxCols) {
    const availWithPct = maxCols - 3 - suffixWithPct.length - 2;
    const availCompact = maxCols - 3 - suffixCompact.length - 2;
    if (availWithPct >= 12) {
      const dynCells = Math.min(40, availWithPct);
      const barGrid = computeHorizonGrid(state, { ...options, cellCount: dynCells });
      plainCandidate = `AH ${barGrid.bracketedBar}${suffixWithPct}`;
      ansiCandidate = `AH ${barGrid.ansiCodeBar}${suffixWithPct}`;
    } else if (availCompact >= 8) {
      const dynCells = Math.min(40, availCompact);
      const barGrid = computeHorizonGrid(state, { ...options, cellCount: dynCells });
      plainCandidate = `AH ${barGrid.bracketedBar}${suffixCompact}`;
      ansiCandidate = `AH ${barGrid.ansiCodeBar}${suffixCompact}`;
    } else {
      const barGrid = computeHorizonGrid(state, { ...options, cellCount: 8 });
      plainCandidate = `AH ${barGrid.bracketedBar}${suffixCompact}`;
      ansiCandidate = `AH ${barGrid.ansiCodeBar}${suffixCompact}`;
    }
  }

  if (plainCandidate.length > maxCols) {
    plainCandidate = plainCandidate.slice(0, maxCols);
    ansiCandidate = truncateAnsiVisible(ansiCandidate, maxCols);
  }

  const plainLine = plainCandidate;
  const line = useAnsi ? ansiCandidate : plainLine;

  return {
    line,
    plainLine,
    grid,
    metrics,
    coachPill
  };
}

/**
 * 2. Renders the `Spinner` suffix appended during active turns (`· Cache 95% (4m12s) · Saved $1.84`).
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 * @returns {{
 *   suffix: string,
 *   cacheHitPct: number,
 *   ttlText: string,
 *   savedUSDText: string
 * }}
 */
export function renderSpinnerSuffix(state = {}, options = {}) {
  const metrics = deriveSurfaceMetrics(state, options);
  const ttlText = metrics.cacheWarm ? metrics.ttlCompact : 'cold';
  const savedUSDText = formatUsd(metrics.savedUSD);
  let suffix = `· Cache ${metrics.cacheHitPct}% (${ttlText}) · Saved ${savedUSDText}`;
  if (state.prefixRetention?.measured) suffix += ` · ${formatRetentionCompact(state.prefixRetention)}`;
  if (state.thinkingDrift?.loop?.triggered) suffix += ` · ${formatDriftCompact(state.thinkingDrift)}`;

  return {
    suffix,
    cacheHitPct: metrics.cacheHitPct,
    ttlText,
    savedUSDText
  };
}

/**
 * Builds the ranked list of Top Context Offenders for Box 4 of the Simple View Pane.
 *
 * @param {object} state
 * @param {object} grid
 * @param {object} [options={}]
 * @returns {Array<{ name: string, tokens: number, category: string, pct: number }>}
 */
function buildTopContextOffenders(state = {}, grid, options = {}) {
  if (Array.isArray(options.offenders) && options.offenders.length > 0) {
    return options.offenders.slice(0, 4).map((item) => {
      const name = String(item.name || 'Context Item');
      return {
        name,
        tokens: Math.max(0, Number(item.tokens || 0)),
        category: String(item.category || 'C'),
        ignorable: isIgnorableClaudePath(name),
        pct:
          grid.totalInputTokens > 0
            ? Number(((Number(item.tokens || 0) / grid.totalInputTokens) * 100).toFixed(1))
            : 0
      };
    });
  }

  const entries = [
    {
      name: 'Middle-Window Distractor / Stale Tool Output',
      tokens: grid.tokens.D,
      category: '[D]',
      ignorable: false
    },
    {
      name: 'System Prompt & MCP Tool Schemas',
      tokens: grid.tokens.S,
      category: '[S]',
      ignorable: false
    },
    {
      name: 'Fresh 1.25x Cache Write Delta',
      tokens: grid.tokens.W,
      category: '[W]',
      ignorable: false
    },
    {
      name: 'Warm Cached Conversation Prefix',
      tokens: grid.tokens.C,
      category: '[C]',
      ignorable: false
    }
  ].filter((e) => e.tokens > 0);

  entries.sort((a, b) => b.tokens - a.tokens);

  if (entries.length === 0) {
    return [
      {
        name: 'No active context offenders recorded',
        tokens: 0,
        category: '[.]',
        ignorable: false,
        pct: 0
      }
    ];
  }

  return entries.slice(0, 4).map((e) => ({
    ...e,
    pct:
      grid.totalInputTokens > 0
        ? Number(((e.tokens / grid.totalInputTokens) * 100).toFixed(1))
        : 0
  }));
}

/**
 * 3. Renders the Docked `Pane` (`id: 'attention-horizon'`) with both the 4-Rank Glanceable Simple View
 * (`ranks` / `simpleText`) and the 5-Box vertical hierarchy (`boxes`, zero promotional banner text):
 *   - Rank 1: Status Verdict & Flight Header (`Healthy` / `Action Needed` / `Critical`)
 *   - Rank 2: 40-Cell Horizon Bar, 3-Stat Row & 5m/1h Prompt Cache Shield
 *   - Rank 3: Single Priority Next Action (+ overflow count for `/horizon advanced`)
 *   - Rank 4: Elevated "Tokens & USD Saved" Card (`This Session` + `30d Workspace` + Top Driver)
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 */
export function renderSimpleViewPane(state = {}, options = {}) {
  const maxCols = Math.max(40, Number(options.maxCols || globalThis.process?.stdout?.columns || 80));
  const grid = computeHorizonGrid(state, options);
  const paneCellCount = maxCols >= 49 ? 40 : Math.max(8, maxCols - 9);
  const paneGrid =
    paneCellCount === 40 ? grid : computeHorizonGrid(state, { ...options, cellCount: paneCellCount });
  const scaleRuler = buildScaleTickRuler(
    grid.zoomTier.ceilingTokens,
    paneGrid.bracketedBar.length
  );
  const metrics = deriveSurfaceMetrics(state, options);
  const peerModel = resolveNaturalDownshiftPeer(grid.modelId);
  const breakEven = computeBreakEvenCachedTokens(
    {
      currentModel: grid.modelId,
      targetModel: peerModel,
      expectedOutputTokens: 1500,
      cacheTtlTier: metrics.ttlTier
    },
    options
  );
  const { verdict, priorityAction, secondaryActions, overflowActionCount } =
    deriveClaudeCodeVerdictAndActions(state, grid, metrics, options);

  const headroomTokens = Math.max(0, grid.zoomTier.ceilingTokens - grid.totalInputTokens);

  // 4-Rank Glanceable Simple View (`ranks`)
  const rank1Lines = [
    `[Rank 1] ${verdict.badge}: ${verdict.headline}`,
    `Model: ${state.modelLabel || grid.modelId} · Mode: ${metrics.flightMode} · ${verdict.detail}`
  ];
  const rank2Lines = [
    `[Rank 2] Context Capacity & Prompt Cache Shield (${grid.zoomTier.label})`,
    `Grid : ${paneGrid.bracketedBar}`,
    `Scale: ${scaleRuler}`,
    `Stats: Used ${formatTokensCompact(grid.totalInputTokens)}/${grid.zoomTier.id} (${grid.utilizationPct}%) | Stale Debt [D] ${formatTokensCompact(grid.tokens.D)} | Free ${formatTokensCompact(headroomTokens)}`,
    `Cache: ${metrics.cacheWarm ? 'WARM' : 'COLD'} (${metrics.ttlTier}) · TTL ${metrics.ttlClock} (${metrics.ttlCompact}) · Hit ${metrics.cacheHitPct}%`
  ];
  const overflowNote =
    overflowActionCount > 0 ? ` (+${overflowActionCount} more in /horizon advanced)` : '';
  const rank3Lines = [
    `[Rank 3] Next Action${overflowNote}`,
    `Action: ${priorityAction.title}`,
    `Guide : ${priorityAction.instruction}`
  ];
  const rank4Lines = [
    `[Rank 4] Verified Tokens & USD Saved`,
    `Saved : +${formatTokensCompact(metrics.sessionSavedTokens)} (${formatUsd(metrics.sessionSavedUSD)}) this session · +${formatTokensCompact(metrics.workspace30dSavedTokens)} (${formatUsd(metrics.workspace30dSavedUSD)}) 30d`,
    `Driver: ${metrics.topSavingsDriver.shortLabel} (+${formatTokensCompact(metrics.topSavingsDriver.savedTokens)})`
  ];

  const rawRanks = [
    {
      rankNumber: 1,
      id: 'status-verdict-header',
      title: 'Status Verdict & Flight Header',
      lines: rank1Lines
    },
    {
      rankNumber: 2,
      id: 'capacity-cache-shield',
      title: 'Context Capacity & Prompt Cache Shield',
      lines: rank2Lines
    },
    {
      rankNumber: 3,
      id: 'priority-next-action',
      title: 'Priority Next Action',
      lines: rank3Lines
    },
    {
      rankNumber: 4,
      id: 'tokens-usd-saved',
      title: 'Verified Tokens & USD Saved',
      lines: rank4Lines
    }
  ];

  const ranks = rawRanks.map((r) => {
    const clampedLines = r.lines.map((l) => clampPlainLine(l, maxCols));
    return {
      ...r,
      lines: clampedLines,
      text: clampedLines.join('\n')
    };
  });

  // Box 1: Capacity & Horizon Bar + Tufte Scale-Tick Ruler
  const box1Lines = [
    `[Box 1] Capacity & Horizon Bar · ${grid.zoomTier.label}`,
    `Model: ${state.modelLabel || grid.modelId} | Tokens: ${formatTokensCompact(grid.totalInputTokens)} / ${grid.zoomTier.id} (${grid.utilizationPct}%)`,
    `Grid : ${paneGrid.bracketedBar}`,
    `Scale: ${scaleRuler}`,
    `Cells: [S] ${grid.cellCounts.S} (${formatTokensCompact(grid.tokens.S)}) | [C] ${grid.cellCounts.C} (${formatTokensCompact(grid.tokens.C)}) | [D] ${grid.cellCounts.D} (${formatTokensCompact(grid.tokens.D)}) | [W] ${grid.cellCounts.W} (${formatTokensCompact(grid.tokens.W)})`
  ];

  // Box 2: Cache Hold & 5m TTL Countdown
  const roiLabel = metrics.negativeCacheRoi
    ? `NEGATIVE ROI (Reads/Write ${metrics.readsPerWriteRatio.toFixed(2)} < ${metrics.breakEvenReadsPerWrite})`
    : `POSITIVE ROI (Hit ${metrics.cacheHitPct}% | R/W ${metrics.readsPerWriteRatio.toFixed(2)} >= ${metrics.breakEvenReadsPerWrite})`;
  const ttlAlertText = metrics.amberAlert ? ' [AMBER TTL ALERT <= 45s]' : '';
  const box2Lines = [
    `[Box 2] Cache Hold & 5m TTL Countdown`,
    `State: ${metrics.cacheWarm ? 'WARM' : 'COLD'} (${metrics.ttlTier} tier) | Countdown: ${metrics.ttlClock} (${metrics.ttlCompact})${ttlAlertText}`,
    `Break-Even Gravity C*: ${breakEven.breakEvenTokens.toLocaleString('en-US')} cached tokens`,
    `Cache ROI: ${roiLabel}`,
    `Prefix Retention: ${formatRetentionLabel(state.prefixRetention)}`,
    `Thinking Drift: ${formatDriftLabel(state.thinkingDrift)}`
  ];

  // Sprint 2.1: Swarm & Worktrees block (progressive disclosure: only when subagents seen)
  const swarmSummary = computeSwarmSummary(state, { nowMs: options.nowMs || Date.now() });
  if (swarmSummary.active) {
    box2Lines.push(`Swarm & Worktrees: ${swarmSummary.label}`);
    for (const w of swarmSummary.workers.slice(0, 4)) {
      const loc = w.branch || w.worktree ? ` @${w.branch || w.worktree}` : '';
      box2Lines.push(`  · ${w.agentId} ${w.state}${w.state === 'waiting' ? ' ($0)' : ''} · ${formatTokensCompact(w.totalTokens)} · ${w.turns}t${loc}`);
    }
    if (swarmSummary.workers.length > 4) box2Lines.push(`  · +${swarmSummary.workers.length - 4} more`);
  }

  // Box 3: Active Coach / Circuit Breaker Slot
  const activeBreakerId =
    options.breakerVerdict?.detectorId || options.breakerVerdict?.ruleId || 'BREAKER';
  const activeBreaker = options.breakerVerdict?.triggered
    ? options.breakerVerdict.reason
      ? `${activeBreakerId} ACTIVE — ${options.breakerVerdict.reason}`
      : `${activeBreakerId} ACTIVE`
    : state.thinkingDrift?.loop?.triggered
      ? state.thinkingDrift.loop.message
      : state.cliffTriggered
      ? 'DET-12: Haiku 5.5 100k 5x pricing cliff exceeded'
      : state.preCliffWarningTriggered
        ? 'DET-12: Haiku 5.5 90k pre-cliff compaction recommended'
        : metrics.amberAlert
          ? 'DET-10: 5m KV-cache TTL <= 45s; hold mutations or flush State Baton'
          : 'All DET-01..32 circuit breakers nominal';
  const singleBox3Status = `Flight Mode: ${metrics.flightMode} | Status: ${activeBreaker}`;
  const box3Lines =
    singleBox3Status.length <= maxCols
      ? [
          `[Box 3] Active Coach / Circuit Breaker Slot`,
          singleBox3Status,
          `Action: ${priorityAction.title}`
        ]
      : [
          `[Box 3] Active Coach / Circuit Breaker Slot`,
          `Flight Mode: ${metrics.flightMode}`,
          `Status: ${activeBreaker}`,
          `Action: ${priorityAction.title}`
        ];

  // Box 4: Top Context Offenders
  const offenders = buildTopContextOffenders(state, grid, options);
  const offenderLines = offenders.map((o, idx) => {
    const prefix = `  ${idx + 1}. ${o.category} `;
    const suffix = `: ${formatTokensCompact(o.tokens)} (${o.pct}%)`;
    const maxNameLen = Math.max(6, maxCols - prefix.length - suffix.length);
    const safeName =
      o.name.length > maxNameLen ? `${o.name.slice(0, maxNameLen - 1)}…` : o.name;
    return `${prefix}${safeName}${suffix}`;
  });
  const box4Lines = [`[Box 4] Top Context Offenders`, ...offenderLines];

  // Box 5: Deterministic Saved-Quota Receipt in USD & Tokens
  const box5Lines = [
    `[Box 5] Deterministic Saved-Quota Receipt`,
    `Verified Savings: ${formatUsd(metrics.savedUSD)} USD | ${metrics.savedTokens.toLocaleString('en-US')} tokens preserved`,
    `Session: +${formatTokensCompact(metrics.sessionSavedTokens)} (${formatUsd(metrics.sessionSavedUSD)}) | 30d: +${formatTokensCompact(metrics.workspace30dSavedTokens)} (${formatUsd(metrics.workspace30dSavedUSD)})`
  ];

  const rawBoxes = [
    {
      boxNumber: 1,
      id: 'capacity-horizon-bar',
      title: 'Capacity & Horizon Bar',
      lines: box1Lines
    },
    {
      boxNumber: 2,
      id: 'cache-hold-ttl-countdown',
      title: 'Cache Hold & 5m TTL Countdown',
      lines: box2Lines
    },
    {
      boxNumber: 3,
      id: 'active-coach-circuit-breaker',
      title: 'Active Coach / Circuit Breaker Slot',
      lines: box3Lines
    },
    {
      boxNumber: 4,
      id: 'top-context-offenders',
      title: 'Top Context Offenders',
      lines: box4Lines
    },
    {
      boxNumber: 5,
      id: 'saved-quota-receipt',
      title: 'Deterministic Saved-Quota Receipt',
      lines: box5Lines
    }
  ];

  const boxes = rawBoxes.map((b) => {
    const clampedLines = b.lines.map((l) => clampPlainLine(l, maxCols));
    return {
      ...b,
      lines: clampedLines,
      text: clampedLines.join('\n')
    };
  });

  const divider = '─'.repeat(Math.min(76, maxCols));
  const simpleText = ranks.map((r) => r.text).join(`\n${divider}\n`);
  const boxText = boxes.map((b) => b.text).join(`\n${divider}\n`);
  const useRankMode = options.viewMode === 'SIMPLE_4_RANK' || options.layout === '4-rank';

  return {
    paneId: 'attention-horizon',
    title: 'Highbeam',
    viewMode: useRankMode ? 'SIMPLE_4_RANK' : 'SIMPLE_5_BOX',
    ranks,
    simpleText,
    boxes,
    text: useRankMode ? simpleText : boxText,
    verdict,
    priorityAction,
    secondaryActions,
    overflowActionCount,
    grid,
    metrics
  };
}

/**
 * Renders the pure 4-Rank Glanceable Simple View HUD (`viewMode: 'SIMPLE_4_RANK'`).
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 */
export function renderSimpleHudPane(state = {}, options = {}) {
  return renderSimpleViewPane(state, { ...options, viewMode: 'SIMPLE_4_RANK' });
}

/**
 * Renders the 5-Section Advanced View Workbench for Claude Code (`/horizon advanced` / `npx ah-claude receipt --advanced`):
 *   Section 1: Verified 5-Category Savings & Anthropic Cache ROI (`C*` & `0.263`/`1.053` R/W)
 *   Section 2: 40-Cell `[S]/[C]/[D]/[W]` Context Anatomy & Top Context Offenders
 *   Section 3: Circuit Breakers (`DET-01..21`), Thinking Drift & Prefix Retention
 *   Section 4: Subagent Swarm (`Task`/`Agent`), Worktrees & `DET-20` Scope Locks
 *   Section 5: `PreCompact` State Baton (`HANDOFF_LATEST.md`) & Session Forensics
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 */
export function renderAdvancedViewPane(state = {}, options = {}) {
  const maxCols = Math.max(40, Number(options.maxCols || globalThis.process?.stdout?.columns || 80));
  const simple = renderSimpleViewPane(state, options);
  const { grid, metrics } = simple;
  const peerModel = resolveNaturalDownshiftPeer(grid.modelId);
  const breakEven = computeBreakEvenCachedTokens(
    {
      currentModel: grid.modelId,
      targetModel: peerModel,
      expectedOutputTokens: 1500,
      cacheTtlTier: metrics.ttlTier
    },
    options
  );
  const offenders = buildTopContextOffenders(state, grid, options);
  const swarmSummary = computeSwarmSummary(state, { nowMs: options.nowMs || Date.now() });

  // Section 1: 5-Category Savings Breakdown & Anthropic Cache ROI
  const catOrder = [
    metrics.savingsCategories.cacheReadDiscount,
    metrics.savingsCategories.prefixBustAvoided,
    metrics.savingsCategories.toolOutputCompressed,
    metrics.savingsCategories.loopAndReadGuarded,
    metrics.savingsCategories.subagentIsolated
  ];
  const sec1Lines = [
    `[Section 1] Verified 5-Category Savings & Anthropic Cache ROI`,
    `Headline: +${formatTokensCompact(metrics.sessionSavedTokens)} (${formatUsd(metrics.sessionSavedUSD)}) session · +${formatTokensCompact(metrics.workspace30dSavedTokens)} (${formatUsd(metrics.workspace30dSavedUSD)}) 30d`,
    ...catOrder.map(
      (c, idx) =>
        `  ${idx + 1}. ${c.shortLabel}: +${formatTokensCompact(c.savedTokens)} (${formatUsd(c.savedUSD)}) [${c.count}x]`
    ),
    `Break-Even Gravity C*: ${breakEven.breakEvenTokens.toLocaleString('en-US')} cached tok (${grid.modelId} -> ${peerModel})`,
    `Reads/Write Ratio: ${metrics.readsPerWriteRatio.toFixed(2)} (target >= ${metrics.breakEvenReadsPerWrite} for ${metrics.ttlTier} TTL)`
  ];

  // Section 2: 40-Cell [S]/[C]/[D]/[W] Anatomy & Top Context Offenders
  const sec2Lines = [
    `[Section 2] 40-Cell Context Anatomy & Top Context Offenders`,
    `[S] System & MCP Schemas : ${grid.cellCounts.S} cells (${formatTokensCompact(grid.tokens.S)})`,
    `[C] Warm Cached Prefix   : ${grid.cellCounts.C} cells (${formatTokensCompact(grid.tokens.C)})`,
    `[D] Stale Tool Debt      : ${grid.cellCounts.D} cells (${formatTokensCompact(grid.tokens.D)})`,
    `[W] Fresh 1.25x Write    : ${grid.cellCounts.W} cells (${formatTokensCompact(grid.tokens.W)})`,
    ...offenders.map(
      (o, idx) =>
        `  Offender ${idx + 1}: ${o.category} ${o.name} — ${formatTokensCompact(o.tokens)} (${o.pct}%)${o.ignorable ? ' [.claudeignore candidate]' : ''}`
    )
  ];

  // Section 3: Circuit Breakers (DET-01..32), Thinking Drift & Prefix Retention
  const activeBreakerId =
    options.breakerVerdict?.detectorId || options.breakerVerdict?.ruleId || null;
  const sec3Lines = [
    `[Section 3] Circuit Breakers (DET-01..32), Thinking Drift & Retention`,
    `Flight Mode: ${metrics.flightMode} | Active Trigger: ${activeBreakerId ? `${activeBreakerId} (${options.breakerVerdict?.reason || 'active'})` : 'None (32 guards nominal)'}`,
    `Prefix Retention: ${formatRetentionLabel(state.prefixRetention)}`,
    `Thinking Drift (DET-30): ${formatDriftLabel(state.thinkingDrift)}`,
    `Haiku 100k 5x Cliff (DET-12): ${state.cliffTriggered ? 'EXCEEDED (5x step-up)' : state.preCliffWarningTriggered ? 'PRE-CLIFF WARNING (>= 90k)' : 'Nominal'}`
  ];

  // Section 4: Subagent Swarm (Task/Agent), Worktrees & DET-20 Scope Locks
  const sec4Lines = [
    `[Section 4] Subagent Swarm (Task/Agent), Worktrees & Scope Locks`,
    `Topology: ${swarmSummary.active ? swarmSummary.label : 'Solo main agent (0 active Task/Agent subagents)'}`
  ];
  if (swarmSummary.active) {
    for (const w of swarmSummary.workers.slice(0, 6)) {
      const loc = w.branch || w.worktree ? ` @${w.branch || w.worktree}` : '';
      sec4Lines.push(
        `  · ${w.agentId} [${w.state}${w.state === 'waiting' ? ' $0' : ''}] ${formatTokensCompact(w.totalTokens)} (${w.turns}t)${loc}`
      );
    }
  }

  // Section 5: PreCompact State Baton & Session Forensics
  const sec5Lines = [
    `[Section 5] PreCompact State Baton & Claude Code Forensics`,
    `Session ID: ${state.sessionId || 'default'} | Completed Turns: ${Number(state.turnsCompleted || 0)}`,
    `Zoom Tier : ${grid.zoomTier.label} (${grid.zoomTier.tokensPerCell.toLocaleString('en-US')} tok/cell)`,
    `State Baton: Auto-flushed on PreCompact to .claude/cache/HANDOFF_LATEST.md`,
    `CLI Tools : npx ctxtop statusline | npx ctxtop radar | npx ctxtop inspect | npx ctxtop doctor`
  ];

  const rawSections = [
    {
      sectionNumber: 1,
      id: 'savings-and-cache-roi',
      title: 'Verified 5-Category Savings & Anthropic Cache ROI',
      lines: sec1Lines
    },
    {
      sectionNumber: 2,
      id: 'context-anatomy-offenders',
      title: '40-Cell Context Anatomy & Top Context Offenders',
      lines: sec2Lines
    },
    {
      sectionNumber: 3,
      id: 'circuit-breakers-drift',
      title: 'Circuit Breakers (DET-01..21), Thinking Drift & Retention',
      lines: sec3Lines
    },
    {
      sectionNumber: 4,
      id: 'subagent-swarm-worktrees',
      title: 'Subagent Swarm (Task/Agent), Worktrees & Scope Locks',
      lines: sec4Lines
    },
    {
      sectionNumber: 5,
      id: 'state-baton-forensics',
      title: 'PreCompact State Baton & Claude Code Forensics',
      lines: sec5Lines
    }
  ];

  const sections = rawSections.map((s) => {
    const clampedLines = s.lines.map((l) => clampPlainLine(l, maxCols));
    return {
      ...s,
      lines: clampedLines,
      text: clampedLines.join('\n')
    };
  });

  const divider = '─'.repeat(Math.min(76, maxCols));
  const text = sections.map((s) => s.text).join(`\n${divider}\n`);

  return {
    paneId: 'attention-horizon',
    title: 'Highbeam (Advanced View)',
    viewMode: 'ADVANCED_5_SECTION',
    sections,
    boxes: simple.boxes,
    ranks: simple.ranks,
    text,
    verdict: simple.verdict,
    priorityAction: simple.priorityAction,
    grid,
    metrics
  };
}

/**
 * 4. Renders a single-line terminal `statusLine` adapting cleanly to terminal column width
 * (`80`, `110`, `144`, or arbitrary column count).
 *
 * Guaranteed invariant: `stripAnsi(result.line).length <= columns`.
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 * @param {number} [options.columns=110]
 * @param {boolean} [options.ansi=true]
 * @returns {{
 *   line: string,
 *   plainLine: string,
 *   visibleLength: number,
 *   columns: number,
 *   layoutTier: 'compact-80'|'standard-110'|'wide-144',
 *   grid: object,
 *   metrics: object
 * }}
 */
export function renderStatusLine(state = {}, options = {}) {
  const columns = Math.max(
    40,
    Number(options.columns || options.maxCols || globalThis.process?.stdout?.columns || 110)
  );
  const useAnsi = options.ansi !== false && !isNoColorEnabled(options);
  const metrics = deriveSurfaceMetrics(state, options);

  let layoutTier = 'standard-110';
  let candidateBarWidths = [24, 20, 16, 12];
  if (columns < 96) {
    layoutTier = 'compact-80';
    candidateBarWidths = [20, 16, 14, 12];
  } else if (columns >= 132) {
    layoutTier = 'wide-144';
    candidateBarWidths = [40, 24, 20, 16, 12];
  }

  const breakerId =
    options.breakerVerdict?.detectorId || options.breakerVerdict?.ruleId || '';
  const shortMode =
    metrics.flightMode === 'AUTO_PILOT' ? 'AUTO' : metrics.flightMode;
  const fullCoachPill =
    options.breakerVerdict?.triggered && breakerId
      ? `[${shortMode}·${breakerId}]`
      : layoutTier === 'wide-144'
        ? `[${metrics.flightMode}]`
        : metrics.flightMode;
  const compactCoachPill =
    options.breakerVerdict?.triggered && breakerId ? breakerId : shortMode;

  const pillVariants =
    fullCoachPill === compactCoachPill ? [fullCoachPill] : [fullCoachPill, compactCoachPill];

  let chosenGrid = null;
  let plainCandidate = '';
  let ansiCandidate = '';
  let matchedFit = false;

  for (const pill of pillVariants) {
    for (const barWidth of candidateBarWidths) {
      const g = computeHorizonGrid(state, { ...options, cellCount: barWidth });
      const tokStr = `${formatTokensCompact(g.totalInputTokens)}/${g.zoomTier.id}`;
      const ttlStr = metrics.cacheWarm ? metrics.ttlCompact : 'COLD';
      const savedStr = formatUsd(metrics.savedUSD);
      const loopStr = state.thinkingDrift?.loop?.triggered ? ` ${formatDriftCompact(state.thinkingDrift)}` : '';
      const retStr = state.prefixRetention?.measured ? ` · ${formatRetentionCompact(state.prefixRetention)}` : '';
      const swarmTok = layoutTier === 'wide-144' ? formatSwarmCompact(computeSwarmSummary(state, { nowMs: options.nowMs || Date.now() })) : '';
      const swarmStr = swarmTok ? ` · ${swarmTok}` : '';

      let p = '';
      let a = '';
      if (layoutTier === 'compact-80') {
        p = `AH ${g.bracketedBar} ${tokStr} C:${metrics.cacheHitPct}% ${ttlStr} ${pill}${loopStr} ${savedStr}`;
        a = `AH ${g.ansiCodeBar} ${tokStr} C:${metrics.cacheHitPct}% ${ttlStr} ${pill}${loopStr} ${savedStr}`;
      } else {
        const shortModel = g.modelId.replace(/^claude-/, '');
        p = `AH ${g.bracketedBar} ${shortModel} ${tokStr} (${g.utilizationPct}%) · Cache ${metrics.cacheHitPct}% (${ttlStr})${retStr} · ${pill}${loopStr} · Saved ${savedStr}${swarmStr}`;
        a = `AH ${g.ansiCodeBar} ${shortModel} ${tokStr} (${g.utilizationPct}%) · Cache ${metrics.cacheHitPct}% (${ttlStr})${retStr} · ${pill}${loopStr} · Saved ${savedStr}${swarmStr}`;
      }

      chosenGrid = g;
      plainCandidate = p;
      ansiCandidate = a;

      if (p.length <= columns) {
        matchedFit = true;
        break;
      }
    }
    if (matchedFit) break;
  }

  // Enforce strict column ceiling via ANSI-preserving truncation (never stripping ANSI colors!)
  if (plainCandidate.length > columns) {
    plainCandidate = plainCandidate.slice(0, columns);
    ansiCandidate = truncateAnsiVisible(ansiCandidate, columns);
  }

  const finalLine = useAnsi ? ansiCandidate : plainCandidate;
  const visibleLength = stripAnsi(finalLine).length;

  return {
    line: finalLine,
    plainLine: stripAnsi(finalLine),
    visibleLength,
    columns,
    layoutTier,
    grid: chosenGrid,
    metrics
  };
}

export default {
  stripAnsi,
  truncateAnsiVisible,
  buildScaleTickRuler,
  formatTokensCompact,
  formatDurationCompact,
  formatUsd,
  isIgnorableClaudePath,
  deriveClaudeCodeVerdictAndActions,
  deriveSurfaceMetrics,
  renderAbovePromptBand,
  renderSpinnerSuffix,
  renderSimpleViewPane,
  renderSimpleHudPane,
  renderAdvancedViewPane,
  renderStatusLine
};
