/**
 * @file src/utils/modelSwitchTelemetry.mjs
 * Local-only privacy-sanitized telemetry counters for `PreModelSwitch` ("ask" / "deny" / "allow")
 * vs `PostModelSwitch` events, plus sanitized hook stdin captures (`cache_ttl`, `prompt_cache_warm`).
 *
 * Privacy Invariant:
 * - Zero file paths, zero OS usernames, zero repository directory names, and zero raw session IDs
 *   are persisted. Session identifiers are one-way SHA-256 hashed (`sess_<12hex>`).
 */

import { fs, path, os, crypto, readJsonSafe, writeJsonAtomic } from './nodeIo.mjs';

export const MODEL_SWITCH_TELEMETRY_SCHEMA_VERSION = 1;
const MAX_RECENT_CAPTURES = 50;
const MAX_PENDING_ASKS = 64;

const SAFE_TOKEN_RX = /^[a-z0-9._:/-]{1,64}$/i;
const PATH_LIKE_RX = /([\\/]{1,2}[a-z0-9_.-]+|[a-z]:[\\/]|users[\\/]|home[\\/])/i;

function sanitizeShortToken(value, maxLen = 64) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  if (PATH_LIKE_RX.test(trimmed)) return null;
  if (!SAFE_TOKEN_RX.test(trimmed)) return null;
  return trimmed;
}

function sanitizeFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Hash an arbitrary session identifier into a non-reversible 12-hex tag (`sess_<12hex>`).
 * @param {string|null|undefined} sessionId
 * @returns {string|null}
 */
export function hashSessionIdentifier(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const digest = crypto.createHash('sha256').update(sessionId.trim()).digest('hex').slice(0, 12);
  return `sess_${digest}`;
}

/**
 * Resolve the local telemetry JSON path under `~/.attention-horizon/cache/`.
 * @param {object} [options={}]
 * @returns {string}
 */
export function resolveModelSwitchTelemetryPath(options = {}) {
  if (typeof options.telemetryPath === 'string' && options.telemetryPath.trim()) {
    return options.telemetryPath.trim();
  }
  const envPath = globalThis.process?.env?.AH_MODEL_SWITCH_TELEMETRY_PATH;
  if (typeof envPath === 'string' && envPath.trim()) {
    return envPath.trim();
  }
  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, '.attention-horizon', 'cache', 'model_switch_telemetry.json');
}

/**
 * Produce a strictly allowlisted, path-free, username-free summary of a
 * `PreModelSwitch` or `PostModelSwitch` stdin payload.
 *
 * @param {object} [rawEvent={}]
 * @param {'PreModelSwitch'|'PostModelSwitch'} [hookEventName='PreModelSwitch']
 * @returns {object}
 */
export function sanitizeModelSwitchStdin(rawEvent = {}, hookEventName = 'PreModelSwitch') {
  const ev = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
  const sessionHash = hashSessionIdentifier(ev.session_id || ev.sessionId || null);

  const rawWarm =
    ev.prompt_cache_warm !== undefined
      ? ev.prompt_cache_warm
      : ev.cache_warm !== undefined
        ? ev.cache_warm
        : ev.promptCacheWarm;
  const promptCacheWarm =
    rawWarm === undefined || rawWarm === null ? null : Boolean(rawWarm);

  const rawTtl = ev.cache_ttl ?? ev.cacheTtl ?? ev.cache_ttl_tier ?? ev.cacheTtlTier ?? null;
  const cacheTtl = sanitizeShortToken(rawTtl ? String(rawTtl) : null, 16);

  const rawSource = ev.source ?? ev.trigger ?? null;
  const source = sanitizeShortToken(rawSource ? String(rawSource) : null, 32) || 'unknown';

  const fromModel = sanitizeShortToken(
    ev.from_model ?? ev.fromModel ?? ev.current_model ?? ev.currentModel ?? null,
    64
  );
  const toModel = sanitizeShortToken(
    ev.to_model ?? ev.toModel ?? ev.target_model ?? ev.targetModel ?? ev.requested_model ?? null,
    64
  );
  const requestedModel = sanitizeShortToken(ev.requested_model ?? ev.requestedModel ?? null, 64);

  const observedKeys = Object.keys(ev)
    .filter((k) => /^[a-z0-9_]{1,48}$/i.test(k))
    .sort();

  return {
    hookEventName: hookEventName === 'PostModelSwitch' ? 'PostModelSwitch' : 'PreModelSwitch',
    recordedAtIso: new Date().toISOString(),
    sessionHash,
    source,
    fromModel,
    toModel,
    requestedModel,
    cacheTtl,
    promptCacheWarm,
    contextTokens: sanitizeFiniteNumber(ev.context_tokens ?? ev.contextTokens),
    cachedTokens: sanitizeFiniteNumber(
      ev.cached_tokens ?? ev.cachedTokens ?? ev.cache_read_input_tokens
    ),
    estimatedCacheWriteUsd: sanitizeFiniteNumber(
      ev.estimated_cache_write_usd ?? ev.estimatedCacheWriteUsd
    ),
    hasPricingPayload: Boolean(ev.pricing && typeof ev.pricing === 'object'),
    observedKeys
  };
}

function createEmptyTelemetryState() {
  return {
    schemaVersion: MODEL_SWITCH_TELEMETRY_SCHEMA_VERSION,
    updatedAtIso: null,
    counts: {
      preModelSwitchTotal: 0,
      preModelSwitchAsk: 0,
      preModelSwitchDeny: 0,
      preModelSwitchAllow: 0,
      postModelSwitchTotal: 0,
      postModelSwitchFromAsk: 0
    },
    metrics: {
      askAcceptanceRate: null,
      rawPostToAskRatio: null,
      pendingOrDeclinedAsks: 0,
      sourceBreakdown: {}
    },
    pendingAsks: [],
    recentSanitizedCaptures: []
  };
}

function normalizeTelemetryState(raw) {
  const base = createEmptyTelemetryState();
  if (!raw || typeof raw !== 'object') return base;
  const counts = {
    preModelSwitchTotal: Math.max(0, Number(raw.counts?.preModelSwitchTotal || 0)),
    preModelSwitchAsk: Math.max(0, Number(raw.counts?.preModelSwitchAsk || 0)),
    preModelSwitchDeny: Math.max(0, Number(raw.counts?.preModelSwitchDeny || 0)),
    preModelSwitchAllow: Math.max(0, Number(raw.counts?.preModelSwitchAllow || 0)),
    postModelSwitchTotal: Math.max(0, Number(raw.counts?.postModelSwitchTotal || 0)),
    postModelSwitchFromAsk: Math.max(0, Number(raw.counts?.postModelSwitchFromAsk || 0))
  };
  const sourceBreakdown =
    raw.metrics?.sourceBreakdown && typeof raw.metrics.sourceBreakdown === 'object'
      ? { ...raw.metrics.sourceBreakdown }
      : {};
  const pendingAsks = Array.isArray(raw.pendingAsks)
    ? raw.pendingAsks.slice(-MAX_PENDING_ASKS)
    : [];
  const recentSanitizedCaptures = Array.isArray(raw.recentSanitizedCaptures)
    ? raw.recentSanitizedCaptures.slice(-MAX_RECENT_CAPTURES)
    : [];
  return recomputeTelemetryMetrics({
    schemaVersion: MODEL_SWITCH_TELEMETRY_SCHEMA_VERSION,
    updatedAtIso: typeof raw.updatedAtIso === 'string' ? raw.updatedAtIso : null,
    counts,
    metrics: {
      askAcceptanceRate: null,
      rawPostToAskRatio: null,
      pendingOrDeclinedAsks: 0,
      sourceBreakdown
    },
    pendingAsks,
    recentSanitizedCaptures
  });
}

function recomputeTelemetryMetrics(state) {
  const { counts } = state;
  const askCount = counts.preModelSwitchAsk;
  const matchedPost = Math.min(askCount, counts.postModelSwitchFromAsk);
  counts.postModelSwitchFromAsk = matchedPost;

  state.metrics.askAcceptanceRate =
    askCount > 0 ? Number((matchedPost / askCount).toFixed(4)) : null;
  state.metrics.rawPostToAskRatio =
    askCount > 0 ? Number((counts.postModelSwitchTotal / askCount).toFixed(4)) : null;
  state.metrics.pendingOrDeclinedAsks = Math.max(0, askCount - matchedPost);
  return state;
}

function writeTelemetryStateAtomic(targetPath, state) {
  const dir = path.dirname(targetPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(targetPath, state);
}

/**
 * Read persisted local-only `PreModelSwitch` vs `PostModelSwitch` telemetry.
 * @param {object} [options={}]
 */
export function readModelSwitchTelemetry(options = {}) {
  const targetPath = resolveModelSwitchTelemetryPath(options);
  const raw = readJsonSafe(targetPath, null);
  return {
    telemetryPath: targetPath,
    exists: Boolean(raw),
    state: normalizeTelemetryState(raw)
  };
}

/**
 * Record a sanitized `PreModelSwitch` decision and stdin capture locally.
 * @param {object} [rawEvent={}]
 * @param {string} [decision='allow']
 * @param {object} [options={}]
 */
export function recordPreModelSwitchEvent(rawEvent = {}, decision = 'allow', options = {}) {
  const targetPath = resolveModelSwitchTelemetryPath(options);
  const state = normalizeTelemetryState(readJsonSafe(targetPath, null));
  const capture = sanitizeModelSwitchStdin(rawEvent, 'PreModelSwitch');
  const normDecision = String(decision || 'allow').toLowerCase();

  state.counts.preModelSwitchTotal += 1;
  if (normDecision === 'ask') {
    state.counts.preModelSwitchAsk += 1;
    state.pendingAsks.push({
      sessionHash: capture.sessionHash,
      toModel: capture.toModel,
      source: capture.source,
      recordedAtIso: capture.recordedAtIso
    });
    if (state.pendingAsks.length > MAX_PENDING_ASKS) {
      state.pendingAsks = state.pendingAsks.slice(-MAX_PENDING_ASKS);
    }
  } else if (normDecision === 'deny') {
    state.counts.preModelSwitchDeny += 1;
  } else {
    state.counts.preModelSwitchAllow += 1;
  }

  const sourceKey = capture.source || 'unknown';
  state.metrics.sourceBreakdown[sourceKey] =
    (Number(state.metrics.sourceBreakdown[sourceKey]) || 0) + 1;

  state.recentSanitizedCaptures.push({
    ...capture,
    decision: normDecision
  });
  if (state.recentSanitizedCaptures.length > MAX_RECENT_CAPTURES) {
    state.recentSanitizedCaptures = state.recentSanitizedCaptures.slice(-MAX_RECENT_CAPTURES);
  }

  state.updatedAtIso = capture.recordedAtIso;
  recomputeTelemetryMetrics(state);
  writeTelemetryStateAtomic(targetPath, state);
  return { telemetryPath: targetPath, state, capture };
}

/**
 * Record a sanitized `PostModelSwitch` completion event and reconcile against pending asks.
 * @param {object} [rawEvent={}]
 * @param {object} [options={}]
 */
export function recordPostModelSwitchEvent(rawEvent = {}, options = {}) {
  const targetPath = resolveModelSwitchTelemetryPath(options);
  const state = normalizeTelemetryState(readJsonSafe(targetPath, null));
  const capture = sanitizeModelSwitchStdin(rawEvent, 'PostModelSwitch');

  state.counts.postModelSwitchTotal += 1;

  // Match the earliest pending `"ask"` for the same hashed session + target model
  const matchIdx = state.pendingAsks.findIndex((pending) => {
    const sameSession =
      pending.sessionHash === null ||
      capture.sessionHash === null ||
      pending.sessionHash === capture.sessionHash;
    const sameTarget =
      pending.toModel === null || capture.toModel === null || pending.toModel === capture.toModel;
    return sameSession && sameTarget;
  });
  const matchedPendingAsk = matchIdx >= 0;
  if (matchedPendingAsk) {
    state.pendingAsks.splice(matchIdx, 1);
    state.counts.postModelSwitchFromAsk += 1;
  }

  state.recentSanitizedCaptures.push({
    ...capture,
    matchedPendingAsk
  });
  if (state.recentSanitizedCaptures.length > MAX_RECENT_CAPTURES) {
    state.recentSanitizedCaptures = state.recentSanitizedCaptures.slice(-MAX_RECENT_CAPTURES);
  }

  state.updatedAtIso = capture.recordedAtIso;
  recomputeTelemetryMetrics(state);
  writeTelemetryStateAtomic(targetPath, state);
  return { telemetryPath: targetPath, state, capture, matchedPendingAsk };
}
