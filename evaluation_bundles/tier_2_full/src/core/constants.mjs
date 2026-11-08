export const HORIZON_WINDOW = {
  MAX_TOKENS: 200000,
  TOTAL_CELLS: 40,
  CELL_SIZE_TOKENS: 5000,
  AMPUTATION_THRESHOLD_TOKENS: 140000,
  AMPUTATION_CELL_COUNT: 8, // Earliest 20% = Cells 0..7 (40,000 tokens)
  STALE_STEP_THRESHOLD: 25,
  ACTIVE_SET_STEP_WINDOW: 8
};

export const SESSION_RISK_THRESHOLDS = Object.freeze({
  SAFE_HORIZON_TOKENS: 179000,          // 70% of 256k Cortex hard clamp
  CASCADE_SYNC_WATERMARK_TOKENS: 50000, // 50k Cascade checkpointer arming threshold
  WARM_CACHE_LOCK_TOKENS: 50000,        // >50k cached tokens triggers prefix-lock warning
  CACHE_TTL_EXPIRED_SECONDS: 0
});

export const SURFACE_TAGS = Object.freeze({
  'antigravity': '[App]',
  'antigravity-ide': '[IDE]',
  'antigravity-cli': '[CLI]',
  'app': '[App]',
  'ide': '[IDE]',
  'cli': '[CLI]'
});

export const PREFIX_LOCK_WARNING_TEXT =
  'Active warm cache (>50k tokens). Changing reasoning effort or switching models rewrites the system prefix and triggers a 100% uncached KV cache rebuild.';

export const CORTEX_CLAMPED_CEILING_LABEL =
  '256k Clamped (1M Model Capped by Cortex 0x3E800)';

export const PATCHED_CLI_CEILING_TIERS = Object.freeze([512000, 900000]);

export const WATERMARK_TOOLTIPS = Object.freeze({
  CASCADE_SYNC_ARMED:
    '50k Cascade Sync Armed: Crossing 50k arms the automatic checkpointer. Completing a task.md item or switching subagents will trigger synchronous auto-compaction.',
  ATTENTION_HORIZON:
    'Attention Horizon (Safe Limit): Practical recall threshold (70% of ceiling, 179k on 256k).',
  CORTEX_HARD_CLAMP:
    'Hard assembly limit (cortex/utils.GetCheckpointConfig).'
});

export const STRANDED_SIGNAL_WARNING_TEXT =
  'Stranded in Low-Attention Trough. Risk of recall decay during multi-file reasoning. Re-reference in active prompt or anchor to task.md.';

export const ATTENTION_TROUGH_CONFIG = Object.freeze({
  GAMMA: 0.6,
  TROUGH_START_RATIO: 0.30,
  TROUGH_END_RATIO: 0.70,
  CANONICAL_TROUGH_START_CELL: 6, // 0-indexed (Cell #7 in 1-indexed UI, or Cell index 7..15)
  CANONICAL_TROUGH_END_CELL: 15
});

/**
 * Resolves a human-readable surface badge ('[App]' | '[IDE]' | '[CLI]') from a store name or path.
 */
export function resolveSurfaceTag(surfaceOrPath = 'antigravity') {
  const s = String(surfaceOrPath || '').toLowerCase().trim();
  if (s.includes('antigravity-cli') || s === 'cli' || s === '[cli]') return '[CLI]';
  if (s.includes('antigravity-ide') || s === 'ide' || s === '[ide]') return '[IDE]';
  return '[App]';
}

export const CATEGORIES = {
  ANCHOR: 'ANCHOR',
  MEMORY_KI: 'MEMORY_KI',
  FOREIGN_BLEED: 'FOREIGN_BLEED',
  STALE_DUPLICATE: 'STALE_DUPLICATE',
  DEAD_ERROR: 'DEAD_ERROR',
  ACTIVE_WORKING_SET: 'ACTIVE_WORKING_SET',
  FREE_HEADROOM: 'FREE_HEADROOM'
};

export const CATEGORY_METADATA = {
  ANCHOR: {
    label: 'Anchors (Rules & Plan)',
    ansi256: 51,
    ansiCode: '\x1b[38;5;51m',
    hex: '#00d7ff',
    symbol: '█',
    priority: 1
  },
  MEMORY_KI: {
    label: 'Knowledge Memory',
    ansi256: 135,
    ansiCode: '\x1b[38;5;135m',
    hex: '#af5fff',
    symbol: '▓',
    priority: 2
  },
  FOREIGN_BLEED: {
    label: 'Foreign KI Bleed',
    ansi256: 198,
    ansiCode: '\x1b[38;5;198m',
    hex: '#ff0087',
    symbol: '▓',
    priority: 2
  },
  STALE_DUPLICATE: {
    label: 'Stale / Duplicate Reads',
    ansi256: 214,
    ansiCode: '\x1b[38;5;214m',
    hex: '#ffaf00',
    symbol: '▒',
    priority: 3
  },
  DEAD_ERROR: {
    label: 'Resolved Dead Errors',
    ansi256: 196,
    ansiCode: '\x1b[38;5;196m',
    hex: '#ff0000',
    symbol: '▓',
    priority: 4
  },
  ACTIVE_WORKING_SET: {
    label: 'Active Working Set',
    ansi256: 46,
    ansiCode: '\x1b[38;5;46m',
    hex: '#00ff00',
    symbol: '█',
    priority: 5
  },
  FREE_HEADROOM: {
    label: 'Free Headroom',
    ansi256: 238,
    ansiCode: '\x1b[38;5;238m',
    hex: '#334155',
    symbol: '░',
    priority: 6
  }
};

export const MODEL_PRICING_PER_MILLION = {
  'gemini-3.8-flash': 0.75,
  'gemini-2.0-flash': 0.75,
  'gemini-4-argon': 1.25,
  'gemini-4-argon-high': 1.25,
  'claude-opus-5.5': 3.00,
  'gemini-1.5-pro': 1.25,
  'gemini-3.1-pro': 1.25,
  'gemini-pro': 1.25,
  'claude-3-5-sonnet': 3.00,
  'claude-opus-4-6-thinking': 5.00,
  'default': 0.75
};

export const MODEL_CEILINGS = Object.freeze({
  'gemini-3.8-flash': 256000,
  'gemini-4-argon': 256000,
  'gemini-4-argon-high': 256000,
  'gemini-4-argon-medium': 256000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4.6': 200000,
  'claude-opus-4-6': 200000,
  'claude-opus-4.6': 200000,
  'claude-opus-4-6-thinking': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-sonnet': 200000,
  'claude-opus-5.5': 256000,
  'gemini-1.5-pro-1m': 1000000,
  'gemini-2.5-pro-1m': 1000000,
  'default': 256000
});

/**
 * Extracts a whitelisted patched CLI ceiling (512,000 or 900,000) from CLI settings or overrides.
 */
export function resolvePatchedCliCeiling(cliSettings = null) {
  if (!cliSettings || typeof cliSettings !== 'object') return null;
  const rawCandidate =
    cliSettings.contextWindow ??
    cliSettings.context_window ??
    cliSettings.context_window_limit ??
    cliSettings.maxContextTokens ??
    cliSettings.max_tokens ??
    cliSettings.maxTokens ??
    cliSettings.cortexCheckpointLimit ??
    cliSettings.patchedCeilingTokens ??
    null;
  if (rawCandidate === null || rawCandidate === undefined) return null;
  if (typeof rawCandidate === 'string') {
    const lower = rawCandidate.toLowerCase().trim();
    if (lower === '512k' || lower === '512000' || lower === '512_000') return 512000;
    if (lower === '900k' || lower === '900000' || lower === '900_000') return 900000;
  }
  const num = Number(rawCandidate);
  if (PATCHED_CLI_CEILING_TIERS.includes(num)) return num;
  return null;
}

function buildCeilingDescriptor(ceilingTokens, source, modelKey = '') {
  const isArgon1M = modelKey.includes('argon') || modelKey.includes('gemini-4');
  const isClamped1MModel = isArgon1M && ceilingTokens === 256000;
  const patchedTier = PATCHED_CLI_CEILING_TIERS.includes(ceilingTokens)
    ? `${Math.round(ceilingTokens / 1000)}k`
    : null;
  return {
    ceilingTokens,
    source,
    isClamped1MModel,
    clampedLabel: isClamped1MModel ? CORTEX_CLAMPED_CEILING_LABEL : '',
    patchedTier
  };
}

/**
 * Resolves ceiling with explicit source origin tracking ('patched_cli' | 'host' | 'config' | 'family' | 'hint' | 'legacy_default' | 'fallback').
 */
export function resolveModelCeilingDetailed(modelId = 'default', stdinContextWindow = null, { useLegacyDefault = false, config = null, cliSettings = null } = {}) {
  const key = String(modelId || '').toLowerCase().trim();

  // 0. Patched CLI binary override (~/.gemini/antigravity-cli/settings.json or config.cliSettings)
  const patchedCliTokens = resolvePatchedCliCeiling(cliSettings || config?.cliSettings || stdinContextWindow?.cliSettings);
  if (patchedCliTokens) {
    return buildCeilingDescriptor(patchedCliTokens, 'patched_cli', key);
  }

  const explicitMax = Number(
    stdinContextWindow?.max_tokens ||
    stdinContextWindow?.maxTokens ||
    stdinContextWindow?.context_window_limit ||
    0
  );
  if (explicitMax >= 20000) {
    const src = PATCHED_CLI_CEILING_TIERS.includes(explicitMax) ? 'patched_cli' : 'host';
    return buildCeilingDescriptor(explicitMax, src, key);
  }

  // 1. Exact match in config.model_ceilings
  if (config?.model_ceilings && Object.prototype.hasOwnProperty.call(config.model_ceilings, key)) {
    const val = Number(config.model_ceilings[key]);
    if (val >= 20000) return buildCeilingDescriptor(val, 'config', key);
  }

  // 2. Exact match in built-in table
  if (Object.prototype.hasOwnProperty.call(MODEL_CEILINGS, key)) {
    return buildCeilingDescriptor(MODEL_CEILINGS[key], 'config', key);
  }

  // 3. Size hints in model name
  if (/\b900k\b|900_000/.test(key)) return buildCeilingDescriptor(900000, 'patched_cli', key);
  if (/\b512k\b|512_000/.test(key)) return buildCeilingDescriptor(512000, 'patched_cli', key);
  if (/\b1m\b|1000k|1_000_000/.test(key)) return buildCeilingDescriptor(1000000, 'hint', key);
  if (/\b200k\b/.test(key)) return buildCeilingDescriptor(200000, 'hint', key);
  if (/\b256k\b/.test(key)) return buildCeilingDescriptor(256000, 'hint', key);

  // 3b. Claude Sonnet / Opus 4.6 family -> 200,000 ceiling
  if (key.includes('claude-sonnet') || key.includes('claude-opus-4-6') || key.includes('claude-opus-4.6') || key.includes('claude-3-5-sonnet') || key.includes('claude-3.5-sonnet')) {
    return buildCeilingDescriptor(200000, 'family', key);
  }

  // 4. Prefix family matching against config and built-in keys
  const mergedCeilings = { ...MODEL_CEILINGS, ...(config?.model_ceilings || {}) };
  const familyKeys = Object.keys(mergedCeilings).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
  for (const candidate of familyKeys) {
    if (key.startsWith(candidate) || key.includes(candidate)) {
      return buildCeilingDescriptor(mergedCeilings[candidate], 'family', key);
    }
  }

  if (useLegacyDefault) {
    return buildCeilingDescriptor(HORIZON_WINDOW.MAX_TOKENS, 'legacy_default', key);
  }

  const fallback = (config?.model_ceilings && config.model_ceilings.default) || MODEL_CEILINGS.default;
  return buildCeilingDescriptor(fallback, 'fallback', key);
}

/**
 * Resolves the native context window ceiling for a given model or host telemetry payload.
 * Preserves 200,000 when useLegacyDefault is true and no explicit ceiling is supplied.
 */
export function resolveModelCeiling(modelId = 'default', stdinContextWindow = null, { useLegacyDefault = false, config = null, cliSettings = null } = {}) {
  return resolveModelCeilingDetailed(modelId, stdinContextWindow, { useLegacyDefault, config, cliSettings }).ceilingTokens;
}

/**
 * Resolves pricing per million tokens with family fallback.
 */
export function resolvePricePerM(modelId = 'default', config = null) {
  const key = String(modelId || '').toLowerCase().trim();
  const pricingMap = { ...MODEL_PRICING_PER_MILLION, ...(config?.model_pricing_per_1m_input || {}) };

  if (Object.prototype.hasOwnProperty.call(pricingMap, key)) {
    return pricingMap[key];
  }

  const familyKeys = Object.keys(pricingMap).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
  for (const candidate of familyKeys) {
    if (key.startsWith(candidate) || key.includes(candidate)) {
      return pricingMap[candidate];
    }
  }

  return pricingMap.default || 0.75;
}

/**
 * Scales an effort profile's safeLimit and thinkingReserve proportionally when maxTokens
 * differs from the 200,000 baseline (e.g. 256,000 -> 120k Fast / 147k High / 180k Auto).
 */
export function scaleEffortProfileForCeiling(profile, maxTokens = HORIZON_WINDOW.MAX_TOKENS) {
  const raw = profile || EFFORT_PROFILES.STANDARD;
  const canonicalTier = raw.tier && EFFORT_PROFILES[raw.tier] ? EFFORT_PROFILES[raw.tier] : null;
  // Prevent double-scaling if an already-scaled profile (with maxTokens set) is passed in again
  const base = (raw.maxTokens && canonicalTier) ? { ...canonicalTier, ...raw, safeLimit: canonicalTier.safeLimit, thinkingReserve: canonicalTier.thinkingReserve } : raw;
  if (!maxTokens || maxTokens === HORIZON_WINDOW.MAX_TOKENS) {
    return {
      ...base,
      maxTokens: HORIZON_WINDOW.MAX_TOKENS,
      limitReason: base.tier === 'HIGH'
        ? `${Math.round(base.thinkingReserve / 1000)}k reserved for deep reasoning`
        : (base.tier === 'STANDARD'
          ? `${Math.round(base.safeLimit / 1000)}k recall ceiling`
          : base.limitReason)
    };
  }
  if (raw.maxTokens === maxTokens && typeof raw.safeLimit === 'number' && !canonicalTier) {
    return { ...raw };
  }
  const ratio = maxTokens / HORIZON_WINDOW.MAX_TOKENS;
  const scaledSafe = Math.round((base.safeLimit * ratio) / 1000) * 1000;
  const scaledReserve = Math.round((base.thinkingReserve * ratio) / 1000) * 1000;
  return {
    ...base,
    safeLimit: scaledSafe,
    thinkingReserve: scaledReserve,
    maxTokens,
    limitReason: base.tier === 'HIGH'
      ? `${Math.round(scaledReserve / 1000)}k reserved for deep reasoning`
      : (base.tier === 'STANDARD'
        ? `${Math.round(scaledSafe / 1000)}k recall ceiling`
        : base.limitReason)
  };
}

export const EFFORT_PROFILES = Object.freeze({
  HIGH: Object.freeze({
    tier: 'HIGH',
    safeLimit: 115000,
    thinkingReserve: 25000,
    label: 'High Effort',
    shortLabel: 'High',
    limitReason: '25k reserved for deep reasoning'
  }),
  STANDARD: Object.freeze({
    tier: 'STANDARD',
    safeLimit: 140000,
    thinkingReserve: 0,
    label: 'Standard / Auto',
    shortLabel: 'Auto',
    limitReason: '140k recall ceiling'
  }),
  FAST: Object.freeze({
    tier: 'FAST',
    safeLimit: 95000,
    thinkingReserve: 0,
    label: 'Fast / Low Effort',
    shortLabel: 'Fast',
    limitReason: 'Earlier middle-window dilution on fast tiers'
  })
});

/**
 * Inspects a turn's model/effort metadata (or string) and resolves the active effort profile.
 * Falls back to STANDARD (140k) when Auto or unspecified.
 */
export function resolveEffortProfile(turnMetadata) {
  if (!turnMetadata) return { ...EFFORT_PROFILES.STANDARD };

  let effortStr = '';
  let modelStr = '';

  if (typeof turnMetadata === 'string') {
    const paren = turnMetadata.match(/\(([^)]+)\)/);
    if (paren) {
      effortStr = paren[1].trim();
      modelStr = turnMetadata.replace(paren[0], '').trim();
    } else {
      effortStr = turnMetadata.trim();
      modelStr = turnMetadata.trim();
    }
  } else if (typeof turnMetadata === 'object') {
    const rawTier = turnMetadata.tier || turnMetadata.effortTier || '';
    const rawEffort = turnMetadata.effort || turnMetadata.reasoningEffort || turnMetadata.reasoning_effort || '';
    const rawModel = typeof turnMetadata.model === 'string'
      ? turnMetadata.model
      : (turnMetadata.model?.id || turnMetadata.modelId || turnMetadata.model_id || turnMetadata.modelName || turnMetadata.rawLabel || '');
    const paren = String(rawModel).match(/\(([^)]+)\)/);
    effortStr = String(rawTier || rawEffort || (paren ? paren[1] : '')).trim();
    modelStr = String(rawModel).trim();
  }

  if (effortStr) {
    if (/\b(high|max|thinking|deep)\b/i.test(effortStr)) {
      return { ...EFFORT_PROFILES.HIGH };
    }
    if (/\b(low|fast|lite)\b/i.test(effortStr)) {
      return { ...EFFORT_PROFILES.FAST };
    }
    if (/\b(medium|standard|normal|auto|default|none)\b/i.test(effortStr)) {
      return { ...EFFORT_PROFILES.STANDARD };
    }
  }

  const combined = `${effortStr} ${modelStr}`.trim();
  if (/\b(high|max|thinking|deep)\b|-high\b/i.test(combined)) {
    return { ...EFFORT_PROFILES.HIGH };
  }
  if (/\b(low|fast|flash|lite)\b/i.test(combined)) {
    return { ...EFFORT_PROFILES.FAST };
  }

  return { ...EFFORT_PROFILES.STANDARD };
}
