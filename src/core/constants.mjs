export const HORIZON_WINDOW = {
  MAX_TOKENS: 200000,
  TOTAL_CELLS: 40,
  CELL_SIZE_TOKENS: 5000,
  AMPUTATION_THRESHOLD_TOKENS: 140000,
  AMPUTATION_CELL_COUNT: 8, // Earliest 20% = Cells 0..7 (40,000 tokens)
  STALE_STEP_THRESHOLD: 25,
  ACTIVE_SET_STEP_WINDOW: 8
};

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
  'gemini-pro': 1.25,
  'claude-3-5-sonnet': 3.00,
  'default': 0.75
};

export const MODEL_CEILINGS = Object.freeze({
  'gemini-3.8-flash': 256000,
  'gemini-4-argon': 256000,
  'gemini-4-argon-high': 256000,
  'gemini-4-argon-medium': 256000,
  'claude-opus-5.5': 256000,
  'claude-3-5-sonnet': 256000,
  'gemini-1.5-pro-1m': 1000000,
  'gemini-2.5-pro-1m': 1000000,
  'default': 256000
});

/**
 * Resolves the native context window ceiling for a given model or host telemetry payload.
 * Preserves 200,000 when useLegacyDefault is true and no explicit ceiling is supplied.
 */
export function resolveModelCeiling(modelId = 'default', stdinContextWindow = null, { useLegacyDefault = false } = {}) {
  const explicitMax = Number(
    stdinContextWindow?.max_tokens ||
    stdinContextWindow?.maxTokens ||
    stdinContextWindow?.context_window_limit ||
    0
  );
  if (explicitMax >= 20000) return explicitMax;

  const key = String(modelId || '').toLowerCase().trim();
  if (/\b1m\b|1000k|1_000_000/.test(key)) return 1000000;
  if (/\b200k\b/.test(key)) return 200000;
  if (/\b256k\b/.test(key)) return 256000;

  if (useLegacyDefault) return HORIZON_WINDOW.MAX_TOKENS;
  return MODEL_CEILINGS[key] || MODEL_CEILINGS.default;
}

/**
 * Scales an effort profile's safeLimit and thinkingReserve proportionally when maxTokens
 * differs from the 200,000 baseline (e.g. 256,000 -> 120k Fast / 147k High / 180k Auto).
 */
export function scaleEffortProfileForCeiling(profile, maxTokens = HORIZON_WINDOW.MAX_TOKENS) {
  const base = profile || EFFORT_PROFILES.STANDARD;
  if (!maxTokens || maxTokens === HORIZON_WINDOW.MAX_TOKENS) {
    return { ...base, maxTokens: HORIZON_WINDOW.MAX_TOKENS };
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
