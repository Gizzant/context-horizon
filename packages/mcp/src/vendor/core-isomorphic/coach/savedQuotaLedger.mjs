/**
 * @file src/coach/savedQuotaLedger.mjs
 * Append-only `.jsonl` Saved-Quota Receipt Ledger (`horizon_ledger.jsonl`).
 *
 * Strict Invariant:
 * - Initialized strictly at `0` tokens and `$0.00` USD (never uses the legacy `142,400` fallback bug).
 * - Zero `node:sqlite` dependency; works across all Node >= 20 environments.
 */

import {
  path,
  getCwd,
  getHomeDir,
  readTextSafe,
  appendJsonlSafe,
  recordRuntimeDiagnostic
} from '../utils/runtime.mjs';
import { calculateTurnCostUSD } from '../config/catalogLoader.mjs';

/**
 * Resolves the ledger file path (`options.ledgerPath`, or `.claude/cache/horizon_ledger.jsonl`
 * when `options.cwd` is provided, or `~/.claude/plugins/store/horizon_ledger.jsonl`).
 *
 * @param {object} [options={}]
 * @returns {string}
 */
export function getLedgerFilePath(options = {}) {
  if (typeof options.ledgerPath === 'string' && options.ledgerPath.trim()) {
    return options.ledgerPath.trim();
  }
  if (options.cwd) {
    return path.join(options.cwd, '.claude', 'cache', 'horizon_ledger.jsonl');
  }
  const home = getHomeDir(options);
  if (home) {
    return path.join(home, '.claude', 'plugins', 'store', 'horizon_ledger.jsonl');
  }
  const fallbackCwd = getCwd(options);
  return path.join(fallbackCwd, '.claude', 'cache', 'horizon_ledger.jsonl');
}

/**
 * Reads all valid JSONL entries from the ledger file.
 * Returns an empty array if the file does not exist (strictly 0 fallback).
 *
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function readLedgerEntries(options = {}) {
  const filePath = getLedgerFilePath(options);
  const raw = readTextSafe(filePath, null, options);
  if (!raw) {
    return [];
  }
  try {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const entries = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
          entries.push(parsed);
        }
      } catch (err) {
        recordRuntimeDiagnostic('savedQuotaLedger', 'readLedgerEntries.parseLine', err, options);
      }
    }
    return entries;
  } catch (err) {
    recordRuntimeDiagnostic('savedQuotaLedger', 'readLedgerEntries', err, options);
    return [];
  }
}

/**
 * Appends a estimated savings receipt entry to `horizon_ledger.jsonl`.
 *
 * @param {object} receipt
 * @param {string} [receipt.sessionId='default']
 * @param {string} [receipt.category='CACHE_READ_DISCOUNT']
 * @param {number} [receipt.savedTokens=0]
 * @param {number} [receipt.savedUSD=0]
 * @param {string} [receipt.modelId='claude-sonnet-5-5']
 * @param {string} [receipt.detail='']
 * @param {object} [options={}]
 * @returns {{ ok: boolean, entry: object, filePath: string }}
 */
const recordedTurnSavingsKeys = new Set();
const recordedInterventionKeys = new Set();

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Orthogonal 3-bucket ledger taxonomy separating real-time avoided writes,
 * ex-post realized prompt-bill savings, and platform KV-cache discounts.
 */
export const LEDGER_BUCKETS = Object.freeze({
  AVOIDED_WRITE: 'avoided_write',
  REALIZED_PROMPT_BILL: 'realized_prompt_bill',
  PLATFORM_CACHE_DISCOUNT: 'platform_cache_discount'
});

const VALID_LEDGER_BUCKETS = new Set(Object.values(LEDGER_BUCKETS));

/**
 * Canonical 5-category Claude Code savings taxonomy for Simple View (Rank 4) and Advanced View (Section 1).
 */
export const SAVINGS_BUCKETS = Object.freeze({
  cacheReadDiscount: Object.freeze({
    id: 'cacheReadDiscount',
    label: 'Prompt Cache Read Discounts (0.10x)',
    shortLabel: 'Cache Read Discounts',
    rawCategories: Object.freeze(['CACHE_READ_DISCOUNT', 'CACHE_HIT_PRESERVED'])
  }),
  prefixBustAvoided: Object.freeze({
    id: 'prefixBustAvoided',
    label: 'Warm-Prefix & Cross-Model Busts Avoided (C*)',
    shortLabel: 'Prefix Busts Avoided',
    rawCategories: Object.freeze([
      'COLD_PREFILL_AVOIDED',
      'MODEL_SWITCH_DEFERRED',
      'PREFIX_MUTATION_DEFERRED',
      'POST_COMPACT_MUTATION_RELEASE',
      'COMPACT_STATE_BATON',
      'DET_08_MODEL_SWITCH_HOLD',
      'DET_09_PREFIX_FENCE'
    ])
  }),
  toolOutputCompressed: Object.freeze({
    id: 'toolOutputCompressed',
    label: 'Lossless PostToolUse Sanitizer & >4k Offloads',
    shortLabel: 'Tool Output Sanitized',
    rawCategories: Object.freeze([
      'LOSSLESS_POST_SANITIZER',
      'ARTIFACT_OFFLOAD_4K',
      'TOOL_OUTPUT_COMPRESSED',
      'CLI_FTS5_COMPRESSED',
      'BUCKET_B_POST_SHIELD'
    ])
  }),
  loopAndReadGuarded: Object.freeze({
    id: 'loopAndReadGuarded',
    label: 'Loop, Bounded-Read & Quota Interventions',
    shortLabel: 'Loop & Read Guards',
    rawCategories: Object.freeze([
      'LOOP_TURN_PREVENTED',
      'BOUNDED_READ_ENFORCED',
      'TTL_EXPIRY_HOLD',
      'SCOPE_QUOTA_BRAKE',
      'DET_06_LOOP_BREAKER',
      'DET_10_TTL_HOLD',
      'DET_11_BOUNDED_READ',
      'DET_20_SCOPE_BRAKE',
      'PROMPT_HYGIENE_STEERED',
      'PROMPT_HYGIENE_BLOCKED',
      'SIGHTSEEING_TOOL_PREVENTED'
    ])
  }),
  subagentIsolated: Object.freeze({
    id: 'subagentIsolated',
    label: 'Task / Agent Subagent Context Isolation',
    shortLabel: 'Subagent Isolation',
    rawCategories: Object.freeze([
      'SUBAGENT_ISOLATED',
      'TASK_SUBAGENT_ISOLATED',
      'SUBAGENT_HANDOFF_CONDENSED'
    ])
  })
});

/**
 * Maps a raw ledger category string into one of the 5 canonical Claude Code savings buckets.
 *
 * @param {string} [rawCategory='']
 * @returns {'cacheReadDiscount'|'prefixBustAvoided'|'toolOutputCompressed'|'loopAndReadGuarded'|'subagentIsolated'}
 */
export function normalizeSavingsBucketId(rawCategory = '') {
  const upper = String(rawCategory || '').trim().toUpperCase();
  for (const [bucketId, spec] of Object.entries(SAVINGS_BUCKETS)) {
    if (spec.rawCategories.includes(upper) || bucketId.toUpperCase() === upper) {
      return bucketId;
    }
  }
  if (upper.includes('CACHE')) return 'cacheReadDiscount';
  if (upper.includes('PREFIX') || upper.includes('MODEL') || upper.includes('DET_08') || upper.includes('DET_09')) {
    return 'prefixBustAvoided';
  }
  if (upper.includes('SANITIZ') || upper.includes('OFFLOAD') || upper.includes('COMPRESS')) {
    return 'toolOutputCompressed';
  }
  if (upper.includes('SUBAGENT') || upper.includes('TASK')) {
    return 'subagentIsolated';
  }
  return 'loopAndReadGuarded';
}

/**
 * Classifies a ledger entry or category name into one of the 3 orthogonal ledger buckets:
 * `'avoided_write'`, `'realized_prompt_bill'`, or `'platform_cache_discount'`.
 *
 * @param {object|string} [entryOrCategory='']
 * @returns {'avoided_write'|'realized_prompt_bill'|'platform_cache_discount'}
 */
export function classifyLedgerBucket(entryOrCategory = '') {
  if (entryOrCategory && typeof entryOrCategory === 'object') {
    const explicit = String(entryOrCategory.ledgerBucket || '').trim();
    if (VALID_LEDGER_BUCKETS.has(explicit)) {
      return explicit;
    }
    return classifyLedgerBucket(entryOrCategory.category || '');
  }
  const upper = String(entryOrCategory || '').trim().toUpperCase();
  if (upper === 'REALIZED_PROMPT_BILL_SAVINGS' || upper.includes('REALIZED_PROMPT_BILL')) {
    return LEDGER_BUCKETS.REALIZED_PROMPT_BILL;
  }
  if (normalizeSavingsBucketId(upper) === 'cacheReadDiscount') {
    return LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT;
  }
  return LEDGER_BUCKETS.AVOIDED_WRITE;
}

export function recordSavingsReceipt(receipt = {}, options = {}) {
  const filePath = getLedgerFilePath(options);
  const category = String(receipt.category || 'CACHE_READ_DISCOUNT');
  const ledgerBucket = classifyLedgerBucket({
    ledgerBucket: receipt.ledgerBucket,
    category
  });
  const isRealizedBucket = ledgerBucket === LEDGER_BUCKETS.REALIZED_PROMPT_BILL;
  const rawTokens = Number(receipt.savedTokens || 0);
  const rawUsd = Number(receipt.savedUSD || 0);
  const savedTokens = isRealizedBucket
    ? (Number.isFinite(rawTokens) ? Math.round(rawTokens) : 0)
    : Math.max(0, Math.round(Number.isFinite(rawTokens) ? rawTokens : 0));
  const savedUSD = isRealizedBucket
    ? (Number.isFinite(rawUsd) ? Number(rawUsd.toFixed(6)) : 0)
    : Math.max(0, Number((Number.isFinite(rawUsd) ? rawUsd : 0).toFixed(6)));
  const hasWriteRate =
    typeof receipt.writeRateUSD === 'number' &&
    Number.isFinite(receipt.writeRateUSD) &&
    receipt.writeRateUSD >= 0;

  const entry = {
    timestamp: receipt.timestamp || options.nowMs || Date.now(),
    sessionId: String(receipt.sessionId || 'default'),
    category,
    ledgerBucket,
    modelId: String(receipt.modelId || 'claude-sonnet-5-5'),
    savedTokens,
    savedUSD,
    detail: String(receipt.detail || ''),
    ...(hasWriteRate ? { writeRateUSD: Number(receipt.writeRateUSD.toFixed(6)) } : {}),
    ...(receipt.exPost && typeof receipt.exPost === 'object' ? { exPost: receipt.exPost } : {}),
    ...(receipt.turnId ? { turnId: String(receipt.turnId) } : {})
  };

  const ok = appendJsonlSafe(filePath, entry, options);
  return { ok, entry, filePath };
}

/**
 * Records a deduplicated intervention savings receipt (e.g. `DET-08` model switch hold,
 * `DET-09` warm-prefix file mutation fence, `DET-06`/`10`/`11`/`20` guard, or `SUBAGENT_ISOLATED`).
 *
 * @param {object} [params={}]
 * @param {string} [params.sessionId='default']
 * @param {string} [params.category='COLD_PREFILL_AVOIDED']
 * @param {string} [params.modelId='claude-sonnet-5-5']
 * @param {number} [params.savedTokens=0]
 * @param {number} [params.savedUSD=0]
 * @param {string} [params.detail='']
 * @param {string} [params.dedupeId]
 * @param {object} [options={}]
 */
export function recordInterventionSavings(params = {}, options = {}) {
  const sessionId = String(params.sessionId || options.sessionId || 'default');
  const category = String(params.category || 'COLD_PREFILL_AVOIDED');
  const modelId = String(params.modelId || 'claude-sonnet-5-5');
  const savedTokens = Math.max(0, Math.round(Number(params.savedTokens || 0)));
  let savedUSD = Math.max(0, Number(params.savedUSD || 0));

  if (savedTokens <= 0 && savedUSD <= 0) {
    return { recorded: false, deduplicated: false, receipt: null };
  }

  if (savedUSD <= 0 && savedTokens > 0) {
    const turnCost = calculateTurnCostUSD(
      {
        model: modelId,
        inputTokens: savedTokens
      },
      options
    );
    savedUSD = Math.max(0, Number(turnCost.costsUSD.totalActualSpendUSD || 0));
  }

  const dedupeToken = params.dedupeId || params.turnId || '';
  const dedupeKey = dedupeToken
    ? `${getLedgerFilePath(options)}::${sessionId}::${category}::${dedupeToken}`
    : null;
  if (dedupeKey) {
    if (recordedInterventionKeys.has(dedupeKey)) {
      return { recorded: false, deduplicated: true, receipt: null };
    }
    recordedInterventionKeys.add(dedupeKey);
  }

  const res = recordSavingsReceipt(
    {
      sessionId,
      turnId: dedupeToken || undefined,
      category,
      ledgerBucket: LEDGER_BUCKETS.AVOIDED_WRITE,
      modelId,
      savedTokens,
      savedUSD,
      ...(typeof params.writeRateUSD === 'number' && Number.isFinite(params.writeRateUSD)
        ? { writeRateUSD: params.writeRateUSD }
        : {}),
      detail: String(params.detail || '')
    },
    options
  );

  return {
    recorded: res.ok,
    deduplicated: false,
    receipt: res.entry
  };
}

/**
 * Computes ex-post realized prompt-bill savings from paired baseline vs. actual
 * wire/transcript totals, checking optional `±25%` prediction accuracy.
 *
 * @param {object} [params={}]
 * @returns {object}
 */
export function computeExPostRealizedSavings(params = {}) {
  const baselinePromptBillTokens = Math.round(Number(params.baselinePromptBillTokens || 0));
  const actualPromptBillTokens = Math.round(Number(params.actualPromptBillTokens || 0));
  const baselineCostUSD = Number(Number(params.baselineCostUSD || 0).toFixed(6));
  const actualCostUSD = Number(Number(params.actualCostUSD || 0).toFixed(6));
  const realizedPromptBillTokens = baselinePromptBillTokens - actualPromptBillTokens;
  const realizedCostUSD = Number((baselineCostUSD - actualCostUSD).toFixed(6));
  const avoidedWriteTokens = Math.max(0, Math.round(Number(params.avoidedWriteTokens || 0)));
  const tolerancePct = Math.max(0, Number(params.tolerancePct ?? 25));

  const hasEstTok =
    params.estimatedRealizedTokens !== null &&
    params.estimatedRealizedTokens !== undefined &&
    Number.isFinite(Number(params.estimatedRealizedTokens));
  const estimatedRealizedTokens = hasEstTok ? Math.round(Number(params.estimatedRealizedTokens)) : null;

  let tokenErrorPct = null;
  let withinTokenTolerance = null;
  if (hasEstTok && realizedPromptBillTokens !== 0) {
    tokenErrorPct = Number(
      ((Math.abs(estimatedRealizedTokens - realizedPromptBillTokens) / Math.abs(realizedPromptBillTokens)) * 100).toFixed(2)
    );
    withinTokenTolerance = tokenErrorPct <= tolerancePct;
  }

  const hasEstUsd =
    params.estimatedRealizedUSD !== null &&
    params.estimatedRealizedUSD !== undefined &&
    Number.isFinite(Number(params.estimatedRealizedUSD));
  const estimatedRealizedUSD = hasEstUsd ? Number(Number(params.estimatedRealizedUSD).toFixed(6)) : null;

  let usdErrorPct = null;
  let withinUsdTolerance = null;
  if (hasEstUsd && realizedCostUSD !== 0) {
    usdErrorPct = Number(
      ((Math.abs(estimatedRealizedUSD - realizedCostUSD) / Math.abs(realizedCostUSD)) * 100).toFixed(2)
    );
    withinUsdTolerance = usdErrorPct <= tolerancePct;
  }

  return {
    bucket: LEDGER_BUCKETS.REALIZED_PROMPT_BILL,
    provenance: 'ex_post_realized_prompt_bill',
    baselinePromptBillTokens,
    actualPromptBillTokens,
    realizedPromptBillTokens,
    baselineCostUSD,
    actualCostUSD,
    realizedCostUSD,
    avoidedWriteTokens,
    estimatedRealizedTokens,
    estimatedRealizedUSD,
    tolerancePct,
    tokenErrorPct,
    withinTokenTolerance,
    usdErrorPct,
    withinUsdTolerance
  };
}

/**
 * Records an ex-post realized prompt-bill delta receipt (signed; supports negative
 * regressions such as high-output retries) in the `realized_prompt_bill` bucket.
 *
 * @param {object} [params={}]
 * @param {object} [options={}]
 */
export function recordRealizedPromptBillSavings(params = {}, options = {}) {
  const sessionId = String(params.sessionId || options.sessionId || 'default');
  const modelId = String(params.modelId || 'claude-sonnet-5-5');
  const exPost = computeExPostRealizedSavings({
    baselinePromptBillTokens:
      params.baselinePromptBillTokens ?? params.realizedPromptBillTokens ?? params.savedTokens ?? 0,
    actualPromptBillTokens: params.actualPromptBillTokens ?? 0,
    baselineCostUSD: params.baselineCostUSD ?? params.realizedCostUSD ?? params.savedUSD ?? 0,
    actualCostUSD: params.actualCostUSD ?? 0,
    avoidedWriteTokens: params.avoidedWriteTokens ?? 0,
    estimatedRealizedTokens: params.estimatedRealizedTokens ?? null,
    estimatedRealizedUSD: params.estimatedRealizedUSD ?? null,
    tolerancePct: params.tolerancePct ?? 25
  });

  const dedupeToken = params.dedupeId || params.turnId || '';
  const dedupeKey = dedupeToken
    ? `${getLedgerFilePath(options)}::${sessionId}::REALIZED_PROMPT_BILL_SAVINGS::${dedupeToken}`
    : null;
  if (dedupeKey) {
    if (recordedInterventionKeys.has(dedupeKey)) {
      return { recorded: false, deduplicated: true, exPost, receipt: null };
    }
    recordedInterventionKeys.add(dedupeKey);
  }

  const signTok = exPost.realizedPromptBillTokens >= 0 ? '+' : '';
  const res = recordSavingsReceipt(
    {
      sessionId,
      turnId: dedupeToken || undefined,
      category: 'REALIZED_PROMPT_BILL_SAVINGS',
      ledgerBucket: LEDGER_BUCKETS.REALIZED_PROMPT_BILL,
      modelId,
      savedTokens: exPost.realizedPromptBillTokens,
      savedUSD: exPost.realizedCostUSD,
      exPost,
      detail: String(
        params.detail ||
          `Ex-post realized prompt-bill delta (${signTok}${exPost.realizedPromptBillTokens} tok, $${exPost.realizedCostUSD.toFixed(4)})`
      )
    },
    options
  );

  return {
    recorded: res.ok,
    deduplicated: false,
    exPost,
    receipt: res.entry
  };
}

/**
 * Computes exact cache read USD & token savings for a turn via `calculateTurnCostUSD`
 * (honoring the Haiku 5.5 `$0.10/$0.50` base and `100,000` total-prompt `5x` cliff)
 * and records a verified receipt if `netCacheSavingsUSD > 0`.
 * Deduplicates by `turnId` per session when provided (`ISS-027`).
 *
 * @param {object} [usage={}]
 * @param {object} [options={}]
 */
export function recordTurnCacheSavings(usage = {}, options = {}) {
  const sessionId = String(usage.sessionId || options.sessionId || 'default');
  const turnId =
    usage.turnId ||
    usage.turn_id ||
    usage.messageId ||
    usage.message_id ||
    usage.message?.id ||
    options.turnId ||
    null;

  const dedupeKey = turnId ? `${getLedgerFilePath(options)}::${sessionId}::${turnId}` : null;
  if (dedupeKey) {
    if (recordedTurnSavingsKeys.has(dedupeKey)) {
      const turnCost = calculateTurnCostUSD(usage, options);
      return {
        recorded: false,
        deduplicated: true,
        turnCost,
        receipt: null
      };
    }
    const existing = readLedgerEntries(options);
    if (existing.some((e) => e.sessionId === sessionId && e.turnId === String(turnId))) {
      recordedTurnSavingsKeys.add(dedupeKey);
      const turnCost = calculateTurnCostUSD(usage, options);
      return {
        recorded: false,
        deduplicated: true,
        turnCost,
        receipt: null
      };
    }
  }

  const turnCost = calculateTurnCostUSD(usage, options);
  const savedUSD = Math.max(0, Number(turnCost.costsUSD.netCacheSavingsUSD || 0));
  const savedTokens = Math.max(0, Number(turnCost.tokens.cacheRead || 0));

  if (savedUSD <= 0 && savedTokens <= 0) {
    return {
      recorded: false,
      turnCost,
      receipt: null
    };
  }

  const receipt = recordSavingsReceipt(
    {
      sessionId,
      turnId,
      category: 'CACHE_READ_DISCOUNT',
      ledgerBucket: LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT,
      modelId: turnCost.modelId,
      savedTokens,
      savedUSD,
      detail: `Warm cache read (${savedTokens.toLocaleString()} tok, total prompt ${turnCost.tokens.totalPrompt.toLocaleString()} tok)`
    },
    options
  );

  if (dedupeKey) {
    recordedTurnSavingsKeys.add(dedupeKey);
  }

  return {
    recorded: receipt.ok,
    turnCost,
    receipt: receipt.entry
  };
}

/**
 * Computes the deterministic Saved-Quota Receipt summary across all recorded entries
 * (or filtered by `options.sessionId`). Always starts strictly at `0`.
 *
 * Exposes the 3 orthogonal ledger buckets (`buckets.avoidedWrites`,
 * `buckets.realizedPromptBill`, `buckets.platformCacheDiscount`) while keeping legacy
 * top-level fields compatible and excluding `realized_prompt_bill` entries from
 * legacy totals so ex-post reconciliation never double-counts real-time avoided writes.
 *
 * @param {object} [options={}]
 * @returns {object}
 */
export function getSavedQuotaReceiptSummary(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const cutoff30d = nowMs - THIRTY_DAYS_MS;
  const allEntries = readLedgerEntries(options);
  const filtered = options.sessionId
    ? allEntries.filter((e) => e.sessionId === options.sessionId)
    : allEntries;

  const targetSessionId =
    options.sessionId ||
    options.activeSessionId ||
    (allEntries.length > 0 ? allEntries[allEntries.length - 1].sessionId : 'default');

  let totalSavedTokens = 0;
  let totalSavedUSD = 0;
  let legacyEntryCount = 0;
  const byCategory = {};

  const categories = {};
  for (const [bucketId, spec] of Object.entries(SAVINGS_BUCKETS)) {
    categories[bucketId] = {
      id: bucketId,
      label: spec.label,
      shortLabel: spec.shortLabel,
      savedTokens: 0,
      savedUSD: 0,
      sessionSavedTokens: 0,
      sessionSavedUSD: 0,
      count: 0
    };
  }

  const buckets = {
    avoidedWrites: {
      id: LEDGER_BUCKETS.AVOIDED_WRITE,
      label: 'Real-Time Avoided Writes (Highbeam Hooks & Guards)',
      provenance: 'realtime_avoided_write',
      tokens: 0,
      usd: 0,
      writeRateUSD: 0,
      sessionTokens: 0,
      sessionUSD: 0,
      workspace30dTokens: 0,
      workspace30dUSD: 0,
      count: 0,
      byCategory: {}
    },
    realizedPromptBill: {
      id: LEDGER_BUCKETS.REALIZED_PROMPT_BILL,
      label: 'Ex-Post Realized Prompt-Bill Savings',
      provenance: 'ex_post_realized_prompt_bill',
      tokens: 0,
      usd: 0,
      sessionTokens: 0,
      sessionUSD: 0,
      workspace30dTokens: 0,
      workspace30dUSD: 0,
      count: 0,
      withinToleranceCount: 0,
      checkedToleranceCount: 0
    },
    platformCacheDiscount: {
      id: LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT,
      label: 'Platform KV-Cache Read Discount (Native Provider)',
      provenance: 'platform_kv_cache_discount',
      tokens: 0,
      usd: 0,
      sessionTokens: 0,
      sessionUSD: 0,
      workspace30dTokens: 0,
      workspace30dUSD: 0,
      count: 0,
      byCategory: {}
    }
  };

  for (const entry of filtered) {
    const ledgerBucket = classifyLedgerBucket(entry);
    const cat = entry.category || 'OTHER';

    if (ledgerBucket === LEDGER_BUCKETS.REALIZED_PROMPT_BILL) {
      const signedTokens = Number.isFinite(Number(entry.savedTokens))
        ? Math.round(Number(entry.savedTokens))
        : 0;
      const signedUsd = Number.isFinite(Number(entry.savedUSD)) ? Number(entry.savedUSD) : 0;
      buckets.realizedPromptBill.tokens += signedTokens;
      buckets.realizedPromptBill.usd = Number((buckets.realizedPromptBill.usd + signedUsd).toFixed(6));
      buckets.realizedPromptBill.count += 1;

      if (entry.exPost && typeof entry.exPost === 'object') {
        const hasUsdTol =
          entry.exPost.withinUsdTolerance !== null &&
          entry.exPost.withinUsdTolerance !== undefined;
        const hasTokTol =
          entry.exPost.withinTokenTolerance !== null &&
          entry.exPost.withinTokenTolerance !== undefined;
        if (hasUsdTol) {
          buckets.realizedPromptBill.checkedToleranceCount += 1;
          if (entry.exPost.withinUsdTolerance) buckets.realizedPromptBill.withinToleranceCount += 1;
        } else if (hasTokTol) {
          buckets.realizedPromptBill.checkedToleranceCount += 1;
          if (entry.exPost.withinTokenTolerance) buckets.realizedPromptBill.withinToleranceCount += 1;
        }
      }
      continue;
    }

    const tokens = Math.max(0, Number(entry.savedTokens || 0));
    const usd = Math.max(0, Number(entry.savedUSD || 0));
    totalSavedTokens += tokens;
    totalSavedUSD += usd;
    legacyEntryCount += 1;

    if (!byCategory[cat]) {
      byCategory[cat] = { savedTokens: 0, savedUSD: 0, count: 0 };
    }
    byCategory[cat].savedTokens += tokens;
    byCategory[cat].savedUSD = Number((byCategory[cat].savedUSD + usd).toFixed(6));
    byCategory[cat].count += 1;

    const bucketId = normalizeSavingsBucketId(cat);
    const bucket = categories[bucketId];
    if (bucket) {
      bucket.savedTokens += tokens;
      bucket.savedUSD = Number((bucket.savedUSD + usd).toFixed(6));
      bucket.count += 1;
    }

    if (ledgerBucket === LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT) {
      buckets.platformCacheDiscount.tokens += tokens;
      buckets.platformCacheDiscount.usd = Number((buckets.platformCacheDiscount.usd + usd).toFixed(6));
      buckets.platformCacheDiscount.count += 1;
      if (!buckets.platformCacheDiscount.byCategory[cat]) {
        buckets.platformCacheDiscount.byCategory[cat] = { savedTokens: 0, savedUSD: 0, count: 0 };
      }
      buckets.platformCacheDiscount.byCategory[cat].savedTokens += tokens;
      buckets.platformCacheDiscount.byCategory[cat].savedUSD = Number(
        (buckets.platformCacheDiscount.byCategory[cat].savedUSD + usd).toFixed(6)
      );
      buckets.platformCacheDiscount.byCategory[cat].count += 1;
    } else {
      const writeUsd =
        typeof entry.writeRateUSD === 'number' && Number.isFinite(entry.writeRateUSD) && entry.writeRateUSD >= 0
          ? Number(entry.writeRateUSD)
          : usd;
      buckets.avoidedWrites.tokens += tokens;
      buckets.avoidedWrites.usd = Number((buckets.avoidedWrites.usd + usd).toFixed(6));
      buckets.avoidedWrites.writeRateUSD = Number((buckets.avoidedWrites.writeRateUSD + writeUsd).toFixed(6));
      buckets.avoidedWrites.count += 1;
      if (!buckets.avoidedWrites.byCategory[cat]) {
        buckets.avoidedWrites.byCategory[cat] = { savedTokens: 0, savedUSD: 0, count: 0 };
      }
      buckets.avoidedWrites.byCategory[cat].savedTokens += tokens;
      buckets.avoidedWrites.byCategory[cat].savedUSD = Number(
        (buckets.avoidedWrites.byCategory[cat].savedUSD + usd).toFixed(6)
      );
      buckets.avoidedWrites.byCategory[cat].count += 1;
    }
  }

  let sessionSavedTokens = 0;
  let sessionSavedUSD = 0;
  let sessionEntryCount = 0;
  let workspace30dSavedTokens = 0;
  let workspace30dSavedUSD = 0;
  let workspace30dEntryCount = 0;

  for (const entry of allEntries) {
    const ledgerBucket = classifyLedgerBucket(entry);
    const ts = Number(entry.timestamp || nowMs);
    const isTargetSession =
      (!options.sessionId || entry.sessionId === targetSessionId) &&
      (entry.sessionId === targetSessionId || !options.activeSessionId);

    if (ledgerBucket === LEDGER_BUCKETS.REALIZED_PROMPT_BILL) {
      const signedTokens = Number.isFinite(Number(entry.savedTokens))
        ? Math.round(Number(entry.savedTokens))
        : 0;
      const signedUsd = Number.isFinite(Number(entry.savedUSD)) ? Number(entry.savedUSD) : 0;
      if (isTargetSession) {
        buckets.realizedPromptBill.sessionTokens += signedTokens;
        buckets.realizedPromptBill.sessionUSD = Number(
          (buckets.realizedPromptBill.sessionUSD + signedUsd).toFixed(6)
        );
      }
      if (ts >= cutoff30d) {
        buckets.realizedPromptBill.workspace30dTokens += signedTokens;
        buckets.realizedPromptBill.workspace30dUSD = Number(
          (buckets.realizedPromptBill.workspace30dUSD + signedUsd).toFixed(6)
        );
      }
      continue;
    }

    const tokens = Math.max(0, Number(entry.savedTokens || 0));
    const usd = Math.max(0, Number(entry.savedUSD || 0));
    const bucketId = normalizeSavingsBucketId(entry.category || 'OTHER');

    if (isTargetSession) {
      sessionSavedTokens += tokens;
      sessionSavedUSD += usd;
      sessionEntryCount += 1;
      if (categories[bucketId]) {
        categories[bucketId].sessionSavedTokens += tokens;
        categories[bucketId].sessionSavedUSD = Number(
          (categories[bucketId].sessionSavedUSD + usd).toFixed(6)
        );
      }
      if (ledgerBucket === LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT) {
        buckets.platformCacheDiscount.sessionTokens += tokens;
        buckets.platformCacheDiscount.sessionUSD = Number(
          (buckets.platformCacheDiscount.sessionUSD + usd).toFixed(6)
        );
      } else {
        buckets.avoidedWrites.sessionTokens += tokens;
        buckets.avoidedWrites.sessionUSD = Number(
          (buckets.avoidedWrites.sessionUSD + usd).toFixed(6)
        );
      }
    }

    if (ts >= cutoff30d) {
      workspace30dSavedTokens += tokens;
      workspace30dSavedUSD += usd;
      workspace30dEntryCount += 1;
      if (ledgerBucket === LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT) {
        buckets.platformCacheDiscount.workspace30dTokens += tokens;
        buckets.platformCacheDiscount.workspace30dUSD = Number(
          (buckets.platformCacheDiscount.workspace30dUSD + usd).toFixed(6)
        );
      } else {
        buckets.avoidedWrites.workspace30dTokens += tokens;
        buckets.avoidedWrites.workspace30dUSD = Number(
          (buckets.avoidedWrites.workspace30dUSD + usd).toFixed(6)
        );
      }
    }
  }

  workspace30dSavedTokens = Math.max(workspace30dSavedTokens, sessionSavedTokens, totalSavedTokens);
  workspace30dSavedUSD = Math.max(workspace30dSavedUSD, sessionSavedUSD, totalSavedUSD);
  buckets.avoidedWrites.workspace30dTokens = Math.max(
    buckets.avoidedWrites.workspace30dTokens,
    buckets.avoidedWrites.sessionTokens,
    buckets.avoidedWrites.tokens
  );
  buckets.avoidedWrites.workspace30dUSD = Number(
    Math.max(
      buckets.avoidedWrites.workspace30dUSD,
      buckets.avoidedWrites.sessionUSD,
      buckets.avoidedWrites.usd
    ).toFixed(6)
  );
  buckets.platformCacheDiscount.workspace30dTokens = Math.max(
    buckets.platformCacheDiscount.workspace30dTokens,
    buckets.platformCacheDiscount.sessionTokens,
    buckets.platformCacheDiscount.tokens
  );
  buckets.platformCacheDiscount.workspace30dUSD = Number(
    Math.max(
      buckets.platformCacheDiscount.workspace30dUSD,
      buckets.platformCacheDiscount.sessionUSD,
      buckets.platformCacheDiscount.usd
    ).toFixed(6)
  );

  const categoryList = Object.values(categories);
  let topDriver = {
    id: 'cacheReadDiscount',
    label: SAVINGS_BUCKETS.cacheReadDiscount.label,
    shortLabel: SAVINGS_BUCKETS.cacheReadDiscount.shortLabel,
    savedTokens: 0,
    savedUSD: 0
  };
  let topHighbeamDriver = {
    id: 'loopAndReadGuarded',
    label: SAVINGS_BUCKETS.loopAndReadGuarded.label,
    shortLabel: SAVINGS_BUCKETS.loopAndReadGuarded.shortLabel,
    savedTokens: 0,
    savedUSD: 0
  };
  for (const bucket of categoryList) {
    if (
      bucket.savedTokens > topDriver.savedTokens ||
      (bucket.savedTokens === topDriver.savedTokens && bucket.savedUSD > topDriver.savedUSD)
    ) {
      topDriver = {
        id: bucket.id,
        label: bucket.label,
        shortLabel: bucket.shortLabel,
        savedTokens: bucket.savedTokens,
        savedUSD: bucket.savedUSD
      };
    }
    if (
      bucket.id !== 'cacheReadDiscount' &&
      (bucket.savedTokens > topHighbeamDriver.savedTokens ||
        (bucket.savedTokens === topHighbeamDriver.savedTokens &&
          bucket.savedUSD > topHighbeamDriver.savedUSD))
    ) {
      topHighbeamDriver = {
        id: bucket.id,
        label: bucket.label,
        shortLabel: bucket.shortLabel,
        savedTokens: bucket.savedTokens,
        savedUSD: bucket.savedUSD
      };
    }
  }

  const measuredPromptHygiene = {
    steeredPrompts: Number(byCategory.PROMPT_HYGIENE_STEERED?.count || 0),
    blockedPrompts: Number(byCategory.PROMPT_HYGIENE_BLOCKED?.count || 0),
    sightseeingToolsPrevented: Number(byCategory.SIGHTSEEING_TOOL_PREVENTED?.count || 0),
    modeledEstimateTokensSaved:
      Number(byCategory.PROMPT_HYGIENE_STEERED?.savedTokens || 0) +
      Number(byCategory.PROMPT_HYGIENE_BLOCKED?.savedTokens || 0) +
      Number(byCategory.SIGHTSEEING_TOOL_PREVENTED?.savedTokens || 0),
    provenanceTag: '[modeled-estimate]'
  };

  return {
    totalSavedTokens: Math.round(totalSavedTokens),
    totalSavedUSD: Number(totalSavedUSD.toFixed(6)),
    entryCount: legacyEntryCount,
    sessionSavedTokens: Math.round(sessionSavedTokens),
    sessionSavedUSD: Number(sessionSavedUSD.toFixed(6)),
    sessionEntryCount,
    workspace30dSavedTokens: Math.round(workspace30dSavedTokens),
    workspace30dSavedUSD: Number(workspace30dSavedUSD.toFixed(6)),
    workspace30dEntryCount,
    buckets,
    highbeamAvoidedWriteTokens: Math.round(buckets.avoidedWrites.tokens),
    highbeamAvoidedWriteUSD: Number(buckets.avoidedWrites.usd.toFixed(6)),
    highbeamSessionAvoidedWriteTokens: Math.round(buckets.avoidedWrites.sessionTokens),
    highbeamSessionAvoidedWriteUSD: Number(buckets.avoidedWrites.sessionUSD.toFixed(6)),
    realizedPromptBillTokens: Math.round(buckets.realizedPromptBill.tokens),
    realizedPromptBillUSD: Number(buckets.realizedPromptBill.usd.toFixed(6)),
    realizedPromptBillEntryCount: buckets.realizedPromptBill.count,
    platformCacheDiscountTokens: Math.round(buckets.platformCacheDiscount.tokens),
    platformCacheDiscountUSD: Number(buckets.platformCacheDiscount.usd.toFixed(6)),
    measuredPromptHygiene,
    byCategory,
    categories,
    categoryList,
    topDriver,
    topHighbeamDriver,
    entries: filtered
  };
}

/**
 * Stateful SavedQuotaReceiptLedger class wrapper.
 */
export class SavedQuotaReceiptLedger {
  constructor(options = {}) {
    this.options = options;
  }

  record(receipt = {}) {
    return recordSavingsReceipt(receipt, this.options);
  }

  getSummary(filterOptions = {}) {
    return getSavedQuotaReceiptSummary({ ...this.options, ...filterOptions });
  }
}

export default {
  LEDGER_BUCKETS,
  SAVINGS_BUCKETS,
  normalizeSavingsBucketId,
  classifyLedgerBucket,
  getLedgerFilePath,
  readLedgerEntries,
  recordSavingsReceipt,
  recordTurnCacheSavings,
  recordInterventionSavings,
  computeExPostRealizedSavings,
  recordRealizedPromptBillSavings,
  getSavedQuotaReceiptSummary,
  SavedQuotaReceiptLedger
};
