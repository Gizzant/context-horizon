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
 * Appends a verified savings receipt entry to `horizon_ledger.jsonl`.
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
      'TOOL_OUTPUT_COMPRESSED'
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
    rawCategories: Object.freeze(['SUBAGENT_ISOLATED', 'TASK_SUBAGENT_ISOLATED'])
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

export function recordSavingsReceipt(receipt = {}, options = {}) {
  const filePath = getLedgerFilePath(options);
  const entry = {
    timestamp: receipt.timestamp || options.nowMs || Date.now(),
    sessionId: String(receipt.sessionId || 'default'),
    category: String(receipt.category || 'CACHE_READ_DISCOUNT'),
    modelId: String(receipt.modelId || 'claude-sonnet-5-5'),
    savedTokens: Math.max(0, Math.round(Number(receipt.savedTokens || 0))),
    savedUSD: Math.max(0, Number(Number(receipt.savedUSD || 0).toFixed(6))),
    detail: String(receipt.detail || ''),
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
      modelId,
      savedTokens,
      savedUSD,
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
 * @param {object} [options={}]
 * @returns {{
 *   totalSavedTokens: number,
 *   totalSavedUSD: number,
 *   entryCount: number,
 *   byCategory: Record<string, { savedTokens: number, savedUSD: number, count: number }>,
 *   entries: Array<object>
 * }}
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

  for (const entry of filtered) {
    const tokens = Math.max(0, Number(entry.savedTokens || 0));
    const usd = Math.max(0, Number(entry.savedUSD || 0));
    totalSavedTokens += tokens;
    totalSavedUSD += usd;

    const cat = entry.category || 'OTHER';
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
  }

  let sessionSavedTokens = 0;
  let sessionSavedUSD = 0;
  let sessionEntryCount = 0;
  let workspace30dSavedTokens = 0;
  let workspace30dSavedUSD = 0;
  let workspace30dEntryCount = 0;

  for (const entry of allEntries) {
    const tokens = Math.max(0, Number(entry.savedTokens || 0));
    const usd = Math.max(0, Number(entry.savedUSD || 0));
    const ts = Number(entry.timestamp || nowMs);
    const bucketId = normalizeSavingsBucketId(entry.category || 'OTHER');

    if (!options.sessionId || entry.sessionId === targetSessionId) {
      if (entry.sessionId === targetSessionId || !options.activeSessionId) {
        sessionSavedTokens += tokens;
        sessionSavedUSD += usd;
        sessionEntryCount += 1;
        if (categories[bucketId]) {
          categories[bucketId].sessionSavedTokens += tokens;
          categories[bucketId].sessionSavedUSD = Number(
            (categories[bucketId].sessionSavedUSD + usd).toFixed(6)
          );
        }
      }
    }

    if (ts >= cutoff30d) {
      workspace30dSavedTokens += tokens;
      workspace30dSavedUSD += usd;
      workspace30dEntryCount += 1;
    }
  }

  workspace30dSavedTokens = Math.max(workspace30dSavedTokens, sessionSavedTokens, totalSavedTokens);
  workspace30dSavedUSD = Math.max(workspace30dSavedUSD, sessionSavedUSD, totalSavedUSD);

  const categoryList = Object.values(categories);
  let topDriver = {
    id: 'cacheReadDiscount',
    label: SAVINGS_BUCKETS.cacheReadDiscount.label,
    shortLabel: SAVINGS_BUCKETS.cacheReadDiscount.shortLabel,
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
    entryCount: filtered.length,
    sessionSavedTokens: Math.round(sessionSavedTokens),
    sessionSavedUSD: Number(sessionSavedUSD.toFixed(6)),
    sessionEntryCount,
    workspace30dSavedTokens: Math.round(workspace30dSavedTokens),
    workspace30dSavedUSD: Number(workspace30dSavedUSD.toFixed(6)),
    workspace30dEntryCount,
    measuredPromptHygiene,
    byCategory,
    categories,
    categoryList,
    topDriver,
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
  SAVINGS_BUCKETS,
  normalizeSavingsBucketId,
  getLedgerFilePath,
  readLedgerEntries,
  recordSavingsReceipt,
  recordTurnCacheSavings,
  recordInterventionSavings,
  getSavedQuotaReceiptSummary,
  SavedQuotaReceiptLedger
};
