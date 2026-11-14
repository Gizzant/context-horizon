import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __constantsDirname = path.dirname(fileURLToPath(import.meta.url));
const __srcCatalogCandidate = path.resolve(__constantsDirname, '../config/modelCatalog.json');
const __rootCatalogCandidate = path.resolve(__constantsDirname, '../../config/modelCatalog.json');
export const DEFAULT_MODEL_CATALOG_PATH = fs.existsSync(__srcCatalogCandidate)
  ? __srcCatalogCandidate
  : __rootCatalogCandidate;

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
  LEAN_SESSION_TOKENS: 25000,           // <25k lean session floor for cold cache escalation
  CACHE_TTL_EXPIRED_SECONDS: 0
});

export const SURFACE_TAGS = Object.freeze({
  'antigravity': '[App]',
  'antigravity-ide': '[IDE]',
  'antigravity-cli': '[CLI]',
  'claude-code': '[Claude]',
  'claude': '[Claude]',
  'cursor': '[Cursor]',
  'app': '[App]',
  'ide': '[IDE]',
  'cli': '[CLI]'
});

export const PREFIX_LOCK_WARNING_TEXT =
  'Active warm cache (>50k tokens). Switching models (within or across families) triggers a full uncached cache rebuild; on Claude, changing reasoning effort also re-bills cached chat history (Gemini thinking-level changes keep the cache).';

export const CORTEX_CLAMPED_CEILING_LABEL =
  '256k Host Cap (1M model)';

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
 * Resolves a human-readable surface badge ('[App]' | '[IDE]' | '[CLI]' | '[Claude]' | '[Cursor]') from a store name or path.
 */
export function resolveSurfaceTag(surfaceOrPath = 'antigravity') {
  const s = String(surfaceOrPath || '').toLowerCase().trim();
  if (s.includes('claude') || s === '[claude]') return '[Claude]';
  if (s.includes('cursor') || s.endsWith('.vscdb') || s === '[cursor]') return '[Cursor]';
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

export const CARBON_RATE_CLIFF_UTC = '2026-12-01T00:00:00Z';
export const CARBON_RATE_CLIFF_MS = Date.parse(CARBON_RATE_CLIFF_UTC);
export const LEGACY_MODEL_SUNSET_UTC = '2026-11-18T00:00:00Z';
export const LEGACY_MODEL_SUNSET_MS = Date.parse(LEGACY_MODEL_SUNSET_UTC);
export const SHARED_1M_CONTEXT_POOL_TOKENS = 1048576; // 1,048,576 unified context ceiling

export const ANTIGRAVITY_ENUM_ALIASES = Object.freeze({
  'm427': 'gemini-4-carbon',
  'm437': 'gemini-4-carbon',
  'm438': 'gemini-4-carbon',
  'm670': 'gemini-4-carbon-cyber-permissive'
});

export const PLAN_TIER_RANK = Object.freeze({
  free: 0,
  pro: 1,
  ultra: 2,
  enterprise: 3
});

export const CARBON_RATE_SCHEDULES = Object.freeze([
  Object.freeze({
    id: 'carbon-introductory-pre-2026-12-01',
    window: 'introductory',
    effective_from_utc: null,
    effective_until_utc: '2026-11-30T23:59:59Z',
    standard: Object.freeze({
      input_per_1m: 2.00,
      output_per_1m: 10.00,
      write_5m_per_1m: 2.00,
      write_1h_per_1m: 2.00,
      cached_read_per_1m: 0.10
    }),
    priority: Object.freeze({
      input_per_1m: 3.60,
      output_per_1m: 18.00,
      write_5m_per_1m: 3.60,
      write_1h_per_1m: 3.60,
      cached_read_per_1m: 0.10
    })
  }),
  Object.freeze({
    id: 'carbon-standard-from-2026-12-01',
    window: 'post_introductory',
    effective_from_utc: CARBON_RATE_CLIFF_UTC,
    effective_until_utc: null,
    standard: Object.freeze({
      input_per_1m: 4.00,
      output_per_1m: 20.00,
      write_5m_per_1m: 4.00,
      write_1h_per_1m: 4.00,
      cached_read_per_1m: 0.20
    }),
    priority: Object.freeze({
      input_per_1m: 7.20,
      output_per_1m: 36.00,
      write_5m_per_1m: 7.20,
      write_1h_per_1m: 7.20,
      cached_read_per_1m: 0.20
    })
  })
]);

export const FLASH_RATE_CLIFF_UTC = '2027-01-01T00:00:00Z';
export const FLASH_RATE_CLIFF_MS = Date.parse(FLASH_RATE_CLIFF_UTC);

export const FLASH_RATE_SCHEDULES = Object.freeze([
  Object.freeze({
    id: 'flash-introductory-pre-2027-01-01',
    window: 'introductory',
    effective_from_utc: null,
    effective_until_utc: '2026-12-31T23:59:59Z',
    standard: Object.freeze({
      input_per_1m: 0.75,
      output_per_1m: 3.75,
      write_5m_per_1m: 0.75,
      write_1h_per_1m: 0.75,
      cached_read_per_1m: 0.075
    }),
    priority: Object.freeze({
      input_per_1m: 1.35,
      output_per_1m: 6.75,
      write_5m_per_1m: 1.35,
      write_1h_per_1m: 1.35,
      cached_read_per_1m: 0.075
    })
  }),
  Object.freeze({
    id: 'flash-standard-from-2027-01-01',
    window: 'post_introductory',
    effective_from_utc: FLASH_RATE_CLIFF_UTC,
    effective_until_utc: null,
    standard: Object.freeze({
      input_per_1m: 1.50,
      output_per_1m: 7.50,
      write_5m_per_1m: 1.50,
      write_1h_per_1m: 1.50,
      cached_read_per_1m: 0.15
    }),
    priority: Object.freeze({
      input_per_1m: 2.70,
      output_per_1m: 13.50,
      write_5m_per_1m: 2.70,
      write_1h_per_1m: 2.70,
      cached_read_per_1m: 0.15
    })
  })
]);

/**
 * Frozen Schema Gate Definitions for Shared Core (`ModelDescriptor`, `RateSchedule`, `AgentCacheKey`, `SwarmAgentState`).
 */
export const CORE_SCHEMAS = Object.freeze({
  ModelDescriptor: Object.freeze({
    required: ['id', 'family', 'label', 'supported_efforts', 'caching_mode', 'supports_explicit_cache', 'antigravity_min_tier', 'shared_pool_ceiling'],
    properties: {
      id: 'string',
      aliases: 'array',
      family: 'string',
      label: 'string',
      supported_efforts: 'array',
      caching_mode: 'string',
      supports_explicit_cache: 'boolean',
      antigravity_min_tier: 'string',
      shared_pool_ceiling: 'number',
      deprecated_after: 'string|null',
      rate_schedules: 'array'
    }
  }),
  RateSchedule: Object.freeze({
    required: ['standard', 'priority'],
    properties: {
      effective_from_utc: 'string|null',
      effective_until_utc: 'string|null',
      standard: 'object',
      priority: 'object'
    }
  }),
  AgentCacheKey: Object.freeze({
    pattern: /^[^:]+::[^:]+::[^:]+$/,
    delimiter: '::',
    defaultAgentId: 'primary'
  }),
  SwarmAgentState: Object.freeze({
    required: ['agent_id', 'model_id', 'status', 'last_active_timestamp', 'warm_prefix_tokens'],
    validStatuses: Object.freeze(['active', 'idle_zero_token', 'terminated']),
    defaultCacheTtlMs: 300000,
    defaultColdWakeThresholdTokens: 100000
  })
});

function buildAnthropicSchedule({ input, output, write5m, write1h, cachedRead }) {
  const tier = Object.freeze({
    input_per_1m: input,
    output_per_1m: output,
    write_5m_per_1m: write5m,
    write_1h_per_1m: write1h,
    cached_read_per_1m: cachedRead
  });
  return Object.freeze([
    Object.freeze({
      effective_from_utc: null,
      effective_until_utc: null,
      standard: tier,
      priority: tier
    })
  ]);
}

export const MODEL_REGISTRY = Object.freeze({
  'gemini-4-carbon': Object.freeze({
    id: 'gemini-4-carbon',
    aliases: Object.freeze([
      'gemini-4-carbon-high',
      'gemini-4-carbon-medium',
      'gemini-4-carbon-med',
      'gemini-4-carbon-low',
      'M427',
      'M437',
      'M438'
    ]),
    family: 'carbon',
    label: 'Gemini 4 Carbon',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    supported_effort_tiers: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'implicit_only',
    supports_explicit_cache: false,
    antigravity_min_tier: 'ultra',
    shared_pool_ceiling: SHARED_1M_CONTEXT_POOL_TOKENS,
    shared_context_pool_tokens: SHARED_1M_CONTEXT_POOL_TOKENS,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: CARBON_RATE_SCHEDULES
  }),
  'gemini-4-carbon-cyber-permissive': Object.freeze({
    id: 'gemini-4-carbon-cyber-permissive',
    aliases: Object.freeze(['M670']),
    family: 'carbon',
    label: 'Gemini 4 Carbon (Cyber Permissive)',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    supported_effort_tiers: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'implicit_only',
    supports_explicit_cache: false,
    antigravity_min_tier: 'ultra',
    shared_pool_ceiling: SHARED_1M_CONTEXT_POOL_TOKENS,
    shared_context_pool_tokens: SHARED_1M_CONTEXT_POOL_TOKENS,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: CARBON_RATE_SCHEDULES
  }),
  'gemini-4-argon': Object.freeze({
    id: 'gemini-4-argon',
    aliases: Object.freeze([
      'gemini-4-argon-high',
      'gemini-4-argon-medium',
      'gemini-4-argon-med',
      'gemini-4-argon-low'
    ]),
    family: 'argon',
    label: 'Gemini 4 Argon',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    supported_effort_tiers: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'implicit_only',
    supports_explicit_cache: false,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: SHARED_1M_CONTEXT_POOL_TOKENS,
    shared_context_pool_tokens: SHARED_1M_CONTEXT_POOL_TOKENS,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: CARBON_RATE_SCHEDULES
  }),
  'gemini-3.8-flash': Object.freeze({
    id: 'gemini-3.8-flash',
    aliases: Object.freeze([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-med',
      'gemini-3.8-flash-low'
    ]),
    family: 'flash',
    label: 'Gemini 3.8 Flash',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'implicit_only',
    supports_explicit_cache: false,
    antigravity_min_tier: 'free',
    shared_pool_ceiling: 256000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: FLASH_RATE_SCHEDULES
  }),
  'claude-haiku-5-5': Object.freeze({
    id: 'claude-haiku-5-5',
    aliases: Object.freeze(['claude-haiku-5.5', 'haiku-5-5', 'haiku-5.5']),
    family: 'haiku',
    label: 'Claude Haiku 5.5',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 1000000,
    max_output_tokens: null,
    deprecated_after: null,
    prompt_cliff_tokens: 100000,
    rate_schedules: Object.freeze([
      Object.freeze({
        effective_from_utc: null,
        effective_until_utc: null,
        standard: Object.freeze({
          input_per_1m: 0.10,
          output_per_1m: 0.50,
          write_5m_per_1m: 0.125,
          write_1h_per_1m: 0.20,
          cached_read_per_1m: 0.01
        }),
        cliff_over_100k: Object.freeze({
          input_per_1m: 0.50,
          output_per_1m: 2.50,
          write_5m_per_1m: 0.625,
          write_1h_per_1m: 1.00,
          cached_read_per_1m: 0.05
        }),
        priority: Object.freeze({
          input_per_1m: 0.10,
          output_per_1m: 0.50,
          write_5m_per_1m: 0.125,
          write_1h_per_1m: 0.20,
          cached_read_per_1m: 0.01
        })
      })
    ])
  }),
  'claude-sonnet-5-5': Object.freeze({
    id: 'claude-sonnet-5-5',
    aliases: Object.freeze(['claude-sonnet-5.5', 'sonnet-5-5', 'sonnet-5.5']),
    family: 'sonnet',
    label: 'Claude Sonnet 5.5',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 1000000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 2.00, output: 10.00, write5m: 2.50, write1h: 4.00, cachedRead: 0.10 })
  }),
  'claude-opus-5-5': Object.freeze({
    id: 'claude-opus-5-5',
    aliases: Object.freeze(['claude-opus-5.5', 'opus-5-5', 'opus-5.5']),
    family: 'opus',
    label: 'Claude Opus 5.5',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 1000000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 4.00, output: 20.00, write5m: 5.00, write1h: 8.00, cachedRead: 0.20 })
  }),
  'claude-fable-5-2': Object.freeze({
    id: 'claude-fable-5-2',
    aliases: Object.freeze(['claude-fable-5.2', 'fable-5-2', 'fable-5.2']),
    family: 'fable',
    label: 'Claude Fable 5.2',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'ultra',
    shared_pool_ceiling: 1000000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 8.00, output: 40.00, write5m: 10.00, write1h: 16.00, cachedRead: 0.20 })
  }),
  'claude-fable-5-1': Object.freeze({
    id: 'claude-fable-5-1',
    aliases: Object.freeze(['claude-fable-5.1', 'fable-5-1', 'fable-5.1']),
    family: 'fable',
    label: 'Claude Fable 5.1',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'ultra',
    shared_pool_ceiling: 1000000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 10.00, output: 50.00, write5m: 12.50, write1h: 20.00, cachedRead: 0.25 })
  }),
  'claude-sonnet-4-6': Object.freeze({
    id: 'claude-sonnet-4-6',
    aliases: Object.freeze(['claude-sonnet-4.6', 'sonnet-4-6', 'sonnet-4.6']),
    family: 'sonnet',
    label: 'Claude Sonnet 4.6',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 200000,
    max_output_tokens: null,
    deprecated_after: LEGACY_MODEL_SUNSET_UTC,
    rate_schedules: buildAnthropicSchedule({ input: 3.00, output: 15.00, write5m: 3.75, write1h: 6.00, cachedRead: 0.30 })
  }),
  'claude-sonnet-4-5': Object.freeze({
    id: 'claude-sonnet-4-5',
    aliases: Object.freeze(['claude-sonnet-4.5', 'sonnet-4-5', 'sonnet-4.5']),
    family: 'sonnet',
    label: 'Claude Sonnet 4.5',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 200000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 3.00, output: 15.00, write5m: 3.75, write1h: 6.00, cachedRead: 0.30 })
  }),
  'claude-opus-4-6': Object.freeze({
    id: 'claude-opus-4-6',
    aliases: Object.freeze(['claude-opus-4.6', 'claude-opus-4-6-thinking', 'opus-4-6', 'opus-4.6']),
    family: 'opus',
    label: 'Claude Opus 4.6',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 200000,
    max_output_tokens: null,
    deprecated_after: LEGACY_MODEL_SUNSET_UTC,
    rate_schedules: buildAnthropicSchedule({ input: 5.00, output: 25.00, write5m: 6.25, write1h: 10.00, cachedRead: 0.50 })
  }),
  'claude-opus-4-5': Object.freeze({
    id: 'claude-opus-4-5',
    aliases: Object.freeze(['claude-opus-4.5', 'opus-4-5', 'opus-4.5']),
    family: 'opus',
    label: 'Claude Opus 4.5',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 200000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 5.00, output: 25.00, write5m: 6.25, write1h: 10.00, cachedRead: 0.50 })
  }),
  'claude-haiku-4-5': Object.freeze({
    id: 'claude-haiku-4-5',
    aliases: Object.freeze(['claude-haiku-4.5', 'haiku-4-5', 'haiku-4.5']),
    family: 'haiku',
    label: 'Claude Haiku 4.5',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'explicit_and_implicit',
    supports_explicit_cache: true,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 200000,
    max_output_tokens: null,
    deprecated_after: null,
    rate_schedules: buildAnthropicSchedule({ input: 1.00, output: 5.00, write5m: 1.25, write1h: 2.00, cachedRead: 0.10 })
  }),
  'gpt-oss-120b': Object.freeze({
    id: 'gpt-oss-120b',
    aliases: Object.freeze(['gpt-oss']),
    family: 'gpt-oss',
    label: 'GPT-OSS 120B',
    supported_efforts: Object.freeze(['low', 'medium', 'high']),
    caching_mode: 'implicit_only',
    supports_explicit_cache: false,
    antigravity_min_tier: 'pro',
    shared_pool_ceiling: 128000,
    max_output_tokens: null,
    deprecated_after: LEGACY_MODEL_SUNSET_UTC,
    rate_schedules: Object.freeze([
      Object.freeze({
        effective_from_utc: null,
        effective_until_utc: null,
        standard: Object.freeze({
          input_per_1m: 1.00,
          output_per_1m: 3.00,
          write_5m_per_1m: 1.00,
          write_1h_per_1m: 1.00,
          cached_read_per_1m: 0.10
        }),
        priority: Object.freeze({
          input_per_1m: 1.00,
          output_per_1m: 3.00,
          write_5m_per_1m: 1.00,
          write_1h_per_1m: 1.00,
          cached_read_per_1m: 0.10
        })
      })
    ])
  })
});

export const MODEL_PRICING_PER_MILLION = {
  'claude-haiku-5-5': 0.10,
  'claude-haiku-5.5': 0.10,
  'haiku-5-5': 0.10,
  'haiku-5.5': 0.10,
  'claude-sonnet-5-5': 2.00,
  'claude-sonnet-5.5': 2.00,
  'sonnet-5-5': 2.00,
  'sonnet-5.5': 2.00,
  'claude-opus-5-5': 4.00,
  'claude-opus-5.5': 4.00,
  'opus-5-5': 4.00,
  'opus-5.5': 4.00,
  'claude-fable-5-2': 8.00,
  'claude-fable-5.2': 8.00,
  'claude-fable-5-1': 10.00,
  'claude-fable-5.1': 10.00,
  'claude-opus-4-6': 5.00,
  'claude-opus-4.6': 5.00,
  'claude-opus-4-6-thinking': 5.00,
  'claude-opus-4-5': 5.00,
  'claude-opus-4.5': 5.00,
  'claude-opus-4-1': 15.00,
  'claude-sonnet-4-6': 3.00,
  'claude-sonnet-4.6': 3.00,
  'claude-sonnet-4-5': 3.00,
  'claude-sonnet-4.5': 3.00,
  'claude-haiku-4-5': 1.00,
  'claude-haiku-4.5': 1.00,
  'claude-3-5-sonnet': 3.00,
  'gemini-2.5-pro': 1.25,
  'gemini-3.8-flash': 0.75,
  'gemini-3.8-flash-high': 0.75,
  'gemini-3.8-flash-medium': 0.75,
  'gemini-3.8-flash-med': 0.75,
  'gemini-3.8-flash-low': 0.75,
  'gemini-2.0-flash': 0.75,
  'gemini-4-argon': 2.00,
  'gemini-4-argon-high': 2.00,
  'gemini-4-argon-medium': 2.00,
  'gemini-4-argon-med': 2.00,
  'gemini-4-argon-low': 2.00,
  'gemini-4-carbon': 2.00,
  'gemini-4-carbon-high': 2.00,
  'gemini-4-carbon-medium': 2.00,
  'gemini-4-carbon-med': 2.00,
  'gemini-4-carbon-low': 2.00,
  'gemini-4-carbon-cyber-permissive': 2.00,
  'm427': 2.00,
  'm437': 2.00,
  'm438': 2.00,
  'm670': 2.00,
  'gemini-1.5-pro': 1.25,
  'gemini-3.1-pro': 1.25,
  'gemini-pro': 1.25,
  'gpt-oss-120b': 1.00,
  'default': 0.75
};

export const MODEL_CEILINGS = Object.freeze({
  'claude-haiku-5-5': 1000000,
  'claude-haiku-5.5': 1000000,
  'haiku-5-5': 1000000,
  'haiku-5.5': 1000000,
  'claude-sonnet-5-5': 1000000,
  'claude-sonnet-5.5': 1000000,
  'sonnet-5-5': 1000000,
  'sonnet-5.5': 1000000,
  'claude-opus-5-5': 1000000,
  'claude-opus-5.5': 1000000,
  'opus-5-5': 1000000,
  'opus-5.5': 1000000,
  'claude-fable-5-2': 1000000,
  'claude-fable-5.2': 1000000,
  'claude-fable-5-1': 1000000,
  'claude-fable-5.1': 1000000,
  'claude-opus-4-6': 200000,
  'claude-opus-4.6': 200000,
  'claude-opus-4-6-thinking': 200000,
  'claude-opus-4-5': 200000,
  'claude-opus-4.5': 200000,
  'claude-opus-4-1': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4.6': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4.5': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4.5': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-sonnet': 1000000,
  'gemini-2.5-pro': 1000000,
  'gemini-3.8-flash': 256000,
  'gemini-3.8-flash-high': 256000,
  'gemini-3.8-flash-medium': 256000,
  'gemini-3.8-flash-med': 256000,
  'gemini-3.8-flash-low': 256000,
  'gemini-4-argon': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-argon-high': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-argon-medium': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-argon-med': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-argon-low': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-carbon': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-carbon-high': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-carbon-medium': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-carbon-med': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-carbon-low': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gemini-4-carbon-cyber-permissive': SHARED_1M_CONTEXT_POOL_TOKENS,
  'm427': SHARED_1M_CONTEXT_POOL_TOKENS,
  'm437': SHARED_1M_CONTEXT_POOL_TOKENS,
  'm438': SHARED_1M_CONTEXT_POOL_TOKENS,
  'm670': SHARED_1M_CONTEXT_POOL_TOKENS,
  'gpt-oss-120b': 128000,
  'gemini-1.5-pro-1m': 1000000,
  'gemini-2.5-pro-1m': 1000000,
  'default': 256000
});

let cachedModelCatalog = null;
let cachedModelCatalogPath = null;

/**
 * Loads the canonical JSON model catalog (`config/modelCatalog.json`), falling back cleanly
 * to the frozen in-memory `MODEL_REGISTRY` if the file is unavailable.
 */
export function loadModelCatalog(catalogPath = DEFAULT_MODEL_CATALOG_PATH, { forceReload = false } = {}) {
  const resolved = path.resolve(catalogPath || DEFAULT_MODEL_CATALOG_PATH);
  if (!forceReload && cachedModelCatalog && cachedModelCatalogPath === resolved) {
    return cachedModelCatalog;
  }
  try {
    if (fs.existsSync(resolved)) {
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
        cachedModelCatalog = parsed;
        cachedModelCatalogPath = resolved;
        return cachedModelCatalog;
      }
    }
  } catch {
    // Graceful fallback to built-in registry
  }
  return {
    schema_version: '2.0.0',
    shared_1m_context_pool_tokens: SHARED_1M_CONTEXT_POOL_TOKENS,
    legacy_model_sunset_utc: LEGACY_MODEL_SUNSET_UTC,
    models: MODEL_REGISTRY
  };
}

function readCustomCeilingsFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rawMap =
      (parsed.ceilings && typeof parsed.ceilings === 'object' && !Array.isArray(parsed.ceilings) ? parsed.ceilings : null) ||
      (parsed.model_ceilings && typeof parsed.model_ceilings === 'object' && !Array.isArray(parsed.model_ceilings) ? parsed.model_ceilings : null) ||
      (parsed.modelCeilings && typeof parsed.modelCeilings === 'object' && !Array.isArray(parsed.modelCeilings) ? parsed.modelCeilings : null) ||
      parsed;
    const out = {};
    for (const [k, v] of Object.entries(rawMap)) {
      const num = typeof v === 'string' ? Number(v.replace(/[_,\s]/g, '')) : Number(v);
      if (k && Number.isFinite(num) && num >= 4096) {
        const normKey = normalizeModelId(k);
        const rounded = Math.round(num);
        if (normKey) out[normKey] = rounded;
        out[String(k).trim().toLowerCase()] = rounded;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Loads and merges user and workspace `customCeilings.json` overrides from lowest to highest priority:
 *  1. `~/.attention-horizon/customCeilings.json`
 *  2. `~/.gemini/attention-horizon/customCeilings.json`
 *  3. `<cwd>/.attention-horizon/customCeilings.json`
 *  4. `<cwd>/.agents/horizon/customCeilings.json`
 */
export function loadCustomCeilings({ cwd = null, homeDir = null, customPaths = null } = {}) {
  const effectiveHome = homeDir || process.env.ATTENTION_HORIZON_HOME_DIR || os.homedir();
  const effectiveCwd = cwd || process.cwd();
  const candidatePaths = Array.isArray(customPaths) && customPaths.length > 0
    ? customPaths
    : [
        effectiveHome ? path.join(effectiveHome, '.attention-horizon', 'customCeilings.json') : null,
        effectiveHome ? path.join(effectiveHome, '.gemini', 'attention-horizon', 'customCeilings.json') : null,
        effectiveCwd ? path.join(effectiveCwd, '.attention-horizon', 'customCeilings.json') : null,
        effectiveCwd ? path.join(effectiveCwd, '.agents', 'horizon', 'customCeilings.json') : null
      ].filter(Boolean);

  const merged = {};
  for (const p of candidatePaths) {
    const fileMap = readCustomCeilingsFile(p);
    if (fileMap) {
      Object.assign(merged, fileMap);
    }
  }
  return merged;
}

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
 * Normalizes a human-readable or raw model identifier into a canonical lookup key.
 * "Claude Opus 5.5 (Medium)" -> "claude-opus-5.5"; "gemini-4-argon" -> "gemini-4-argon";
 * Antigravity enum aliases ("M427", "M437", "M438") -> "gemini-4-carbon", "M670" -> "gemini-4-carbon-cyber-permissive".
 */
export function normalizeModelId(modelId = '') {
  let s = String(modelId ?? '').trim().toLowerCase();
  // Strip trailing "(Medium)" / "(High, Thinking)" style suffixes (possibly repeated).
  while (/\s*\([^()]*\)\s*$/.test(s)) {
    s = s.replace(/\s*\([^()]*\)\s*$/, '');
  }
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (Object.prototype.hasOwnProperty.call(ANTIGRAVITY_ENUM_ALIASES, s)) {
    return ANTIGRAVITY_ENUM_ALIASES[s];
  }
  return s;
}

export const normalizeModelKey = normalizeModelId;

function stripEffortSuffix(modelKey = '') {
  return String(modelKey || '').replace(/-(high|medium|med|low)$/i, '');
}

/**
 * Resolves a canonical ModelDescriptor from MODEL_REGISTRY for any model ID or alias.
 */
export function resolveModelDescriptor(modelId = 'gemini-4-argon') {
  const raw = String(modelId ?? '').trim().toLowerCase();
  const norm = normalizeModelId(modelId);
  const stripped = stripEffortSuffix(norm);
  const hyphenated = stripped.replace(/\.(\d+)/g, '-$1');

  if (MODEL_REGISTRY[norm]) return MODEL_REGISTRY[norm];
  if (MODEL_REGISTRY[stripped]) return MODEL_REGISTRY[stripped];
  if (MODEL_REGISTRY[hyphenated]) return MODEL_REGISTRY[hyphenated];

  if (ANTIGRAVITY_ENUM_ALIASES[raw] && MODEL_REGISTRY[ANTIGRAVITY_ENUM_ALIASES[raw]]) {
    return MODEL_REGISTRY[ANTIGRAVITY_ENUM_ALIASES[raw]];
  }
  if (ANTIGRAVITY_ENUM_ALIASES[stripped] && MODEL_REGISTRY[ANTIGRAVITY_ENUM_ALIASES[stripped]]) {
    return MODEL_REGISTRY[ANTIGRAVITY_ENUM_ALIASES[stripped]];
  }

  for (const desc of Object.values(MODEL_REGISTRY)) {
    if (
      desc.aliases &&
      desc.aliases.some((a) => {
        const al = a.toLowerCase();
        return al === raw || al === norm || al === stripped || al === hyphenated;
      })
    ) {
      return desc;
    }
  }

  if (hyphenated.includes('carbon-cyber-permissive')) return MODEL_REGISTRY['gemini-4-carbon-cyber-permissive'];
  if (hyphenated.includes('carbon')) return MODEL_REGISTRY['gemini-4-carbon'];
  if (hyphenated.includes('argon')) return MODEL_REGISTRY['gemini-4-argon'];
  if (hyphenated.includes('3-8-flash') || hyphenated.includes('flash')) return MODEL_REGISTRY['gemini-3.8-flash'];
  if (hyphenated.includes('fable-5-2')) return MODEL_REGISTRY['claude-fable-5-2'];
  if (hyphenated.includes('fable-5-1')) return MODEL_REGISTRY['claude-fable-5-1'];
  if (hyphenated.includes('haiku-5-5')) return MODEL_REGISTRY['claude-haiku-5-5'];
  if (hyphenated.includes('sonnet-5-5')) return MODEL_REGISTRY['claude-sonnet-5-5'];
  if (hyphenated.includes('opus-5-5')) return MODEL_REGISTRY['claude-opus-5-5'];
  if (hyphenated.includes('sonnet-4-6')) return MODEL_REGISTRY['claude-sonnet-4-6'];
  if (hyphenated.includes('sonnet-4-5')) return MODEL_REGISTRY['claude-sonnet-4-5'];
  if (hyphenated.includes('opus-4-6')) return MODEL_REGISTRY['claude-opus-4-6'];
  if (hyphenated.includes('opus-4-5')) return MODEL_REGISTRY['claude-opus-4-5'];
  if (hyphenated.includes('haiku-4-5')) return MODEL_REGISTRY['claude-haiku-4-5'];
  if (hyphenated.includes('gpt-oss')) return MODEL_REGISTRY['gpt-oss-120b'];
  return null;
}

/**
 * Validates a ModelDescriptor object against the frozen schema gate.
 */
export function validateModelDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return { valid: false, error: 'Descriptor must be an object' };
  for (const reqKey of CORE_SCHEMAS.ModelDescriptor.required) {
    if (descriptor[reqKey] === undefined) {
      return { valid: false, error: `Missing required field: ${reqKey}` };
    }
  }
  if (!Array.isArray(descriptor.supported_efforts) || descriptor.supported_efforts.length === 0) {
    return { valid: false, error: 'supported_efforts must be a non-empty array' };
  }
  if (typeof descriptor.supports_explicit_cache !== 'boolean') {
    return { valid: false, error: 'supports_explicit_cache must be boolean' };
  }
  return { valid: true, error: null };
}

/**
 * Formats a composite AgentCacheKey: `${session_id}::${agent_id}::${model_id}`.
 * Defaults `agent_id` to `"primary"` when absent in single-agent payloads.
 */
export function formatAgentCacheKey(sessionId = 'default_session', agentId = 'primary', modelId = 'gemini-4-argon') {
  const sId = String(sessionId || 'default_session').trim() || 'default_session';
  const aId = String(agentId || 'primary').trim() || 'primary';
  const mId = normalizeModelId(modelId || 'gemini-4-argon') || 'gemini-4-argon';
  return `${sId}::${aId}::${mId}`;
}

/**
 * Formats a composite AgentStreamKey: `${session_id}::${agent_id}` for per-agent thrash/bust scoping.
 */
export function formatAgentStreamKey(sessionId = 'default_session', agentId = 'primary') {
  const sId = String(sessionId || 'default_session').trim() || 'default_session';
  const aId = String(agentId || 'primary').trim() || 'primary';
  return `${sId}::${aId}`;
}

/**
 * Parses a composite AgentCacheKey `${session_id}::${agent_id}::${model_id}`.
 */
export function parseAgentCacheKey(compositeKey = '') {
  const parts = String(compositeKey || '').split('::');
  if (parts.length < 3) {
    const res = {
      session_id: parts[0] || 'default_session',
      agent_id: parts[1] || 'primary',
      model_id: normalizeModelId(parts[2] || 'gemini-4-argon')
    };
    Object.defineProperty(res, 'valid', { value: false, enumerable: false });
    return res;
  }
  const res = {
    session_id: parts[0],
    agent_id: parts[1] || 'primary',
    model_id: normalizeModelId(parts.slice(2).join('::'))
  };
  Object.defineProperty(res, 'valid', { value: true, enumerable: false });
  return res;
}

/**
 * Creates and validates a SwarmAgentState record.
 */
export function createSwarmAgentState(raw = {}) {
  const agent_id = String(raw.agent_id || raw.agentId || 'primary').trim() || 'primary';
  const model_id = normalizeModelId(raw.model_id || raw.modelId || raw.model || 'gemini-4-carbon') || 'gemini-4-carbon';
  const statusRaw = String(raw.status || 'active').toLowerCase().trim();
  const status = CORE_SCHEMAS.SwarmAgentState.validStatuses.includes(statusRaw)
    ? statusRaw
    : 'active';
  const last_active_timestamp = Number.isFinite(Number(raw.last_active_timestamp ?? raw.lastActiveTimestamp))
    ? Number(raw.last_active_timestamp ?? raw.lastActiveTimestamp)
    : Date.now();
  const warm_prefix_tokens = Math.max(0, Number(raw.warm_prefix_tokens ?? raw.warmPrefixTokens ?? raw.cachedTokens ?? 0));
  const cache_ttl_ms = Number(raw.cache_ttl_ms ?? raw.cacheTtlMs ?? CORE_SCHEMAS.SwarmAgentState.defaultCacheTtlMs);
  return {
    agent_id,
    model_id,
    status,
    last_active_timestamp,
    warm_prefix_tokens,
    cache_ttl_ms,
    role: raw.role || null
  };
}

export function validateSwarmAgentState(state = {}) {
  if (!state || typeof state !== 'object') return { valid: false, error: 'SwarmAgentState must be an object' };
  for (const k of CORE_SCHEMAS.SwarmAgentState.required) {
    if (state[k] === undefined || state[k] === null) {
      return { valid: false, error: `Missing required field: ${k}` };
    }
  }
  if (!CORE_SCHEMAS.SwarmAgentState.validStatuses.includes(state.status)) {
    return { valid: false, error: `Invalid status: ${state.status}` };
  }
  return { valid: true, error: null };
}

function parseTimestampUtcMs(eventTimestampUtc) {
  if (typeof eventTimestampUtc === 'number' && Number.isFinite(eventTimestampUtc)) {
    return eventTimestampUtc;
  }
  if (eventTimestampUtc instanceof Date) {
    return eventTimestampUtc.getTime();
  }
  if (typeof eventTimestampUtc === 'string' && eventTimestampUtc.trim()) {
    const parsed = Date.parse(eventTimestampUtc.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isTimestampWithinSchedule(tsMs, sched) {
  if (!sched || typeof sched !== 'object') return false;
  if (sched.effective_from_utc) {
    const fromMs = Date.parse(sched.effective_from_utc);
    if (Number.isFinite(fromMs) && tsMs < fromMs) return false;
  }
  if (sched.effective_until_utc) {
    const untilStr = String(sched.effective_until_utc).trim();
    const untilMs = Date.parse(untilStr);
    if (Number.isFinite(untilMs)) {
      // Exclusive when specified at 00:00:00Z midnight boundary; inclusive through .999Z when 23:59:59Z
      if (untilStr.endsWith('00:00:00Z')) {
        if (tsMs >= untilMs) return false;
      } else if (tsMs > untilMs + 999) {
        return false;
      }
    }
  }
  return true;
}

function extractPromptEnvelopeTokens(contextOptions) {
  if (typeof contextOptions === 'number' && Number.isFinite(contextOptions)) {
    return Math.max(0, contextOptions);
  }
  if (!contextOptions || typeof contextOptions !== 'object') return 0;
  if (Number.isFinite(Number(contextOptions.totalPromptTokens)) && Number(contextOptions.totalPromptTokens) > 0) {
    return Math.max(0, Number(contextOptions.totalPromptTokens));
  }
  const fresh = Math.max(0, Number(
    contextOptions.freshInputTokens ??
    contextOptions.uncachedInputTokens ??
    contextOptions.inputTokens ??
    contextOptions.input_tokens ??
    0
  ));
  const read = Math.max(0, Number(
    contextOptions.cacheReadInputTokens ??
    contextOptions.cacheReadTokens ??
    contextOptions.cache_read_input_tokens ??
    contextOptions.cachedTokens ??
    0
  ));
  const write = Math.max(0, Number(
    contextOptions.cacheCreationInputTokens ??
    contextOptions.cacheCreationTokens ??
    contextOptions.cache_creation_input_tokens ??
    ((Number(contextOptions.write5mTokens || 0) + Number(contextOptions.write1hTokens || 0)) || 0)
  ));
  return fresh + read + write;
}

function formatRateCardResult({
  modelId,
  serviceTier,
  windowName,
  effectiveFromUtc = null,
  effectiveUntilUtc = null,
  input,
  output,
  write5m,
  write1h,
  cachedRead,
  cliffTriggered = false
}) {
  const w5m = Number.isFinite(write5m) ? write5m : input;
  const w1h = Number.isFinite(write1h) ? write1h : input;
  return {
    modelId,
    serviceTier,
    window: windowName,
    pricingWindow: windowName,
    cliffTriggered,
    effectiveFromUtc,
    effectiveUntilUtc,
    input,
    output,
    write5m: w5m,
    write1h: w1h,
    cachedRead,
    input_per_1m: input,
    output_per_1m: output,
    write_5m_per_1m: w5m,
    write_1h_per_1m: w1h,
    cached_read_per_1m: cachedRead,
    inputPer1M: input,
    outputPer1M: output,
    write5mPer1M: w5m,
    write1hPer1M: w1h,
    cachedReadPer1M: cachedRead,
    inputPerMillionUsd: input,
    outputPerMillionUsd: output,
    write5mPerMillionUsd: w5m,
    write1hPerMillionUsd: w1h,
    cachedReadPerMillionUsd: cachedRead
  };
}

/**
 * Date-Gated & Multi-Rate Pricing Resolver (`resolveModelRates(modelId, eventTimestampUtc, serviceTier, contextOptions)`).
 * Evaluates `effective_from_utc` / `effective_until_utc` across every model in `MODEL_REGISTRY`,
 * plus prompt-cliff tiers (e.g. `claude-haiku-5-5` > 100,000 prompt tokens 5x cliff).
 */
export function resolveModelRates(modelId = 'gemini-4-carbon', eventTimestampUtc = null, serviceTier = 'standard', contextOptions = null) {
  let effectiveTsArg = eventTimestampUtc;
  let effectiveTierArg = serviceTier;
  let effectiveCtx = contextOptions;

  if (eventTimestampUtc && typeof eventTimestampUtc === 'object' && !(eventTimestampUtc instanceof Date)) {
    effectiveCtx = eventTimestampUtc;
    effectiveTsArg = eventTimestampUtc.eventTimestampUtc ?? eventTimestampUtc.timestamp ?? null;
    effectiveTierArg = eventTimestampUtc.serviceTier || serviceTier || 'standard';
  }

  const tsMs = parseTimestampUtcMs(effectiveTsArg);
  const tierKey = String(effectiveTierArg || 'standard').toLowerCase().trim() === 'priority' ? 'priority' : 'standard';
  const desc = resolveModelDescriptor(modelId);

  if (desc && Array.isArray(desc.rate_schedules) && desc.rate_schedules.length > 0) {
    const matchedSched =
      desc.rate_schedules.find((s) => isTimestampWithinSchedule(tsMs, s)) ||
      desc.rate_schedules[desc.rate_schedules.length - 1];

    const promptEnvelope = extractPromptEnvelopeTokens(effectiveCtx);
    const cliffTriggered = Boolean(
      desc.prompt_cliff_tokens &&
      promptEnvelope > desc.prompt_cliff_tokens &&
      matchedSched.cliff_over_100k
    );
    const rates = cliffTriggered
      ? matchedSched.cliff_over_100k
      : (matchedSched[tierKey] || matchedSched.standard);

    let windowName = 'standard';
    if (cliffTriggered) {
      windowName = 'cliff_over_100k';
    } else if (matchedSched.window) {
      windowName = matchedSched.window;
    } else if (desc.rate_schedules.length > 1) {
      windowName = matchedSched.effective_from_utc ? 'post_introductory' : 'introductory';
    }

    return formatRateCardResult({
      modelId: desc.id,
      serviceTier: tierKey,
      windowName,
      effectiveFromUtc: matchedSched.effective_from_utc,
      effectiveUntilUtc: matchedSched.effective_until_utc,
      input: rates.input_per_1m,
      output: rates.output_per_1m,
      write5m: rates.write_5m_per_1m ?? rates.input_per_1m,
      write1h: rates.write_1h_per_1m ?? rates.input_per_1m,
      cachedRead: rates.cached_read_per_1m,
      cliffTriggered
    });
  }

  const norm = normalizeModelId(modelId);
  const fallbackInput = MODEL_PRICING_PER_MILLION[norm] ?? MODEL_PRICING_PER_MILLION.default ?? 0.75;
  const fallbackOutput = fallbackInput * 5;
  const fallbackCached = Number((fallbackInput * 0.1).toFixed(4));
  return formatRateCardResult({
    modelId: norm || 'default',
    serviceTier: tierKey,
    windowName: 'standard',
    input: fallbackInput,
    output: fallbackOutput,
    write5m: fallbackInput,
    write1h: fallbackInput,
    cachedRead: fallbackCached
  });
}

/**
 * Computes exact USD cost for a turn payload using `resolveModelRates`.
 * Always sums `(output_tokens + thinking_tokens)` against `output_per_1m`
 * and evaluates multi-rate cache writes (`write5m`, `write1h`) and prompt-cliff tiers.
 */
export function calculateModelCost(payload = {}, options = {}) {
  const modelId = options.modelId || payload.modelId || payload.model_id || payload.model || 'gemini-4-carbon';
  const eventTimestampUtc = options.eventTimestampUtc ?? payload.eventTimestampUtc ?? payload.timestamp ?? payload.createdAt ?? null;
  const serviceTier = options.serviceTier || payload.serviceTier || payload.service_tier || 'standard';

  const rawInputTokens = Math.max(0, Number(payload.input_tokens ?? payload.inputTokens ?? payload.uncachedInputTokens ?? 0));
  const outputTokens = Math.max(0, Number(payload.output_tokens ?? payload.outputTokens ?? 0));
  const thinkingTokens = Math.max(0, Number(payload.thinking_tokens ?? payload.thinkingTokens ?? 0));
  const cachedReadTokens = Math.max(
    0,
    Number(
      payload.cached_input_tokens ??
      payload.cached_read_tokens ??
      payload.cache_read_input_tokens ??
      payload.cacheReadTokens ??
      payload.cachedTokens ??
      0
    )
  );
  const inputTokens =
    payload.cached_input_tokens !== undefined &&
    payload.uncached_input_tokens === undefined &&
    payload.uncachedInputTokens === undefined &&
    rawInputTokens >= cachedReadTokens
      ? rawInputTokens - cachedReadTokens
      : rawInputTokens;

  let write5mTokens = Math.max(
    0,
    Number(
      payload.cache_creation_ephemeral_5m_input_tokens ??
      payload.cache_creation?.ephemeral_5m_input_tokens ??
      payload.write5mTokens ??
      0
    )
  );
  let write1hTokens = Math.max(
    0,
    Number(
      payload.cache_creation_ephemeral_1h_input_tokens ??
      payload.cache_creation?.ephemeral_1h_input_tokens ??
      payload.write1hTokens ??
      0
    )
  );
  const flatCacheCreationTokens = Math.max(
    0,
    Number(payload.cache_creation_input_tokens ?? payload.cacheCreationTokens ?? payload.cacheCreationInputTokens ?? 0)
  );
  if (write5mTokens + write1hTokens === 0 && flatCacheCreationTokens > 0) {
    const ttlHint = String(options.cacheTtl || payload.cacheTtl || payload.cache_ttl || '5m').toLowerCase();
    if (ttlHint === '1h' || ttlHint === '3600' || ttlHint === '3600s') {
      write1hTokens = flatCacheCreationTokens;
    } else {
      write5mTokens = flatCacheCreationTokens;
    }
  }

  const totalPromptTokens = inputTokens + cachedReadTokens + write5mTokens + write1hTokens;
  const rates = resolveModelRates(modelId, eventTimestampUtc, serviceTier, { totalPromptTokens });

  const billedOutputTokens = outputTokens + thinkingTokens;
  const inputCostUsd = (inputTokens / 1_000_000) * rates.input_per_1m;
  const outputCostUsd = (billedOutputTokens / 1_000_000) * rates.output_per_1m;
  const write5mCostUsd = (write5mTokens / 1_000_000) * rates.write_5m_per_1m;
  const write1hCostUsd = (write1hTokens / 1_000_000) * rates.write_1h_per_1m;
  const cachedReadCostUsd = (cachedReadTokens / 1_000_000) * rates.cached_read_per_1m;
  const totalCostUsd = Number((inputCostUsd + outputCostUsd + write5mCostUsd + write1hCostUsd + cachedReadCostUsd).toFixed(6));

  return {
    modelId: rates.modelId,
    serviceTier: rates.serviceTier,
    pricingWindow: rates.pricingWindow,
    cliffTriggered: rates.cliffTriggered,
    rates,
    inputTokens,
    outputTokens,
    thinkingTokens,
    billedOutputTokens,
    write5mTokens,
    write1hTokens,
    cachedReadTokens,
    totalPromptTokens,
    inputCostUsd: Number(inputCostUsd.toFixed(6)),
    outputCostUsd: Number(outputCostUsd.toFixed(6)),
    write5mCostUsd: Number(write5mCostUsd.toFixed(6)),
    write1hCostUsd: Number(write1hCostUsd.toFixed(6)),
    cachedReadCostUsd: Number(cachedReadCostUsd.toFixed(6)),
    totalCostUsd
  };
}

/**
 * Checks whether a model ID is deprecated at the given timestamp (`deprecated_after: "2026-11-18T00:00:00Z"`).
 */
export function isModelDeprecated(modelId = '', eventTimestampUtc = null) {
  const desc = resolveModelDescriptor(modelId);
  if (!desc || !desc.deprecated_after) return false;
  const tsMs = parseTimestampUtcMs(eventTimestampUtc);
  const sunsetMs = Date.parse(desc.deprecated_after);
  return Number.isFinite(sunsetMs) && tsMs >= sunsetMs;
}

/**
 * Returns a migration notice if a session is pinned to a retired model ID on or after its sunset date.
 */
export function getDeprecatedModelMigrationNotice(modelId = '', eventTimestampUtc = null, userTier = 'pro') {
  if (!isModelDeprecated(modelId, eventTimestampUtc)) return null;
  const desc = resolveModelDescriptor(modelId);
  const replacement = isPlanTierEligible(userTier, 'ultra') ? 'gemini-4-carbon' : 'gemini-4-argon';
  const noticeText = `Model "${desc.label}" (${desc.id}) was retired on ${desc.deprecated_after}. Migrate session to ${replacement} to restore active support and implicit caching.`;
  return {
    deprecated: true,
    modelId: desc.id,
    deprecatedAfterUtc: desc.deprecated_after,
    recommendedReplacement: replacement,
    notice: noticeText,
    includes(substr) {
      return noticeText.includes(substr);
    },
    toString() {
      return noticeText;
    }
  };
}

/**
 * Checks whether a user's Antigravity plan tier satisfies a model's `antigravity_min_tier`.
 * Supports both `isPlanTierEligible(userTier, requiredMinTier)` and `isPlanTierEligible(modelId, userTier)`.
 */
export function isPlanTierEligible(firstArg = 'pro', secondArg = 'free') {
  const fKey = String(firstArg || 'pro').toLowerCase().trim();
  const sKey = String(secondArg || 'free').toLowerCase().trim();
  if (!Object.prototype.hasOwnProperty.call(PLAN_TIER_RANK, fKey)) {
    const desc = resolveModelDescriptor(fKey);
    if (desc) {
      const reqRank = PLAN_TIER_RANK[desc.antigravity_min_tier] ?? PLAN_TIER_RANK.free;
      const usrRank = PLAN_TIER_RANK[sKey] ?? PLAN_TIER_RANK.pro;
      return usrRank >= reqRank;
    }
  }
  const uRank = PLAN_TIER_RANK[fKey] ?? PLAN_TIER_RANK.pro;
  const rRank = PLAN_TIER_RANK[sKey] ?? PLAN_TIER_RANK.free;
  return uRank >= rRank;
}

/**
 * Phase 2.1: Unified 1,048,576-Token Context Pool Calculator for `gemini-4-carbon` and `gemini-4-argon`.
 *
 * `pool_used = input_tokens + thinking_tokens + output_tokens`
 * `remaining_decode_headroom = 1_048_576 - input_tokens`
 */
export function computeUnifiedContextPool(usage = {}, modelId = 'gemini-4-carbon') {
  const desc = resolveModelDescriptor(modelId);
  const norm = normalizeModelId(modelId);
  const isUnified1M = Boolean(
    (desc && (desc.family === 'carbon' || desc.family === 'argon')) ||
    norm.includes('carbon') ||
    norm.includes('argon')
  );
  const ceiling = isUnified1M
    ? SHARED_1M_CONTEXT_POOL_TOKENS
    : (desc?.shared_pool_ceiling || MODEL_CEILINGS[norm] || MODEL_CEILINGS.default);

  const input_tokens = Math.max(0, Number(usage.input_tokens ?? usage.inputTokens ?? usage.totalInputTokens ?? 0));
  const thinking_tokens = Math.max(0, Number(usage.thinking_tokens ?? usage.thinkingTokens ?? 0));
  const output_tokens = Math.max(0, Number(usage.output_tokens ?? usage.outputTokens ?? 0));

  const pool_used = input_tokens + thinking_tokens + output_tokens;
  const remaining_decode_headroom = Math.max(0, ceiling - input_tokens);
  const remaining_pool_tokens = Math.max(0, ceiling - pool_used);
  const utilization_ratio = ceiling > 0 ? pool_used / ceiling : 0;
  const utilization_pct = Number((utilization_ratio * 100).toFixed(2));

  return {
    modelId: desc?.id || norm,
    ceiling,
    pool_ceiling: ceiling,
    ceilingTokens: ceiling,
    input_tokens,
    thinking_tokens,
    output_tokens,
    pool_used,
    poolUsedTokens: pool_used,
    remaining_decode_headroom,
    remainingDecodeHeadroom: remaining_decode_headroom,
    remaining_pool_tokens,
    utilization_ratio: Number(utilization_ratio.toFixed(6)),
    utilization_pct,
    utilizationPct: utilization_pct,
    is_overflow: pool_used > ceiling,
    isOverflow: pool_used > ceiling
  };
}

/**
 * Phase 2.2: Carbon High-Effort Verbosity Detector.
 *
 * Tracks `(thinking_tokens + output_tokens) / input_tokens` and absolute reasoning spend per turn.
 * When `gemini-4-carbon` runs at `high` effort across >= 2 consecutive routine turns
 * (single-file edits, simple shell checks, no error recovery) and exceeds the configured
 * reasoning-token budget, emits an actionable prescription to step down via `/effort medium`
 * or delegate routine edits to `gemini-3.8-flash`.
 */
export function evaluateCarbonVerbosityGuardrail(turns = [], options = {}) {
  const reasoningTokenBudget = Number(options.reasoningTokenBudget ?? options.reasoning_token_budget ?? 16000);
  const ratioThreshold = Number(options.ratioThreshold ?? 0.25);
  const eventTimestampUtc = options.eventTimestampUtc ?? null;
  const serviceTier = options.serviceTier || 'standard';

  let consecutiveRoutineHighTurns = 0;
  const turnEvaluations = [];

  for (const turn of (Array.isArray(turns) ? turns : [])) {
    const modelId = turn.modelId || turn.model_id || turn.model || options.modelId || 'gemini-4-carbon';
    const desc = resolveModelDescriptor(modelId);
    const isCarbon = Boolean(desc?.family === 'carbon' || normalizeModelId(modelId).includes('carbon'));
    const effort = String(turn.effort || turn.reasoningEffort || options.effort || 'high').toLowerCase().trim();
    const isHighEffort = effort === 'high' || effort === 'max';

    const inputTokens = Math.max(1, Number(turn.input_tokens ?? turn.inputTokens ?? 1));
    const thinkingTokens = Math.max(0, Number(turn.thinking_tokens ?? turn.thinkingTokens ?? 0));
    const outputTokens = Math.max(0, Number(turn.output_tokens ?? turn.outputTokens ?? 0));
    const reasoningTokens = thinkingTokens + outputTokens;
    const reasoningToInputRatio = Number((reasoningTokens / inputTokens).toFixed(4));

    const hasError = Boolean(
      turn.errorRecovery ||
      turn.hasError ||
      turn.status === 'ERROR' ||
      (typeof turn.exitCode === 'number' && turn.exitCode !== 0)
    );
    const editedFilesCount = Number(
      turn.editedFilesCount ??
      (Array.isArray(turn.editedFiles) ? turn.editedFiles.length : (turn.multiFileEdit ? 2 : 1))
    );
    const isRoutine = Boolean(
      turn.isRoutine !== undefined
        ? turn.isRoutine
        : (!hasError && editedFilesCount <= 1)
    );

    const cost = calculateModelCost(
      { input_tokens: 0, output_tokens: outputTokens, thinking_tokens: thinkingTokens },
      { modelId, eventTimestampUtc: turn.timestamp || turn.createdAt || eventTimestampUtc, serviceTier }
    );

    const exceedsBudget = reasoningTokens > reasoningTokenBudget || reasoningToInputRatio >= ratioThreshold;
    if (isCarbon && isHighEffort && isRoutine && exceedsBudget) {
      consecutiveRoutineHighTurns++;
    } else {
      consecutiveRoutineHighTurns = 0;
    }

    turnEvaluations.push({
      modelId: desc?.id || normalizeModelId(modelId),
      effort,
      isCarbon,
      isHighEffort,
      isRoutine,
      inputTokens,
      thinkingTokens,
      outputTokens,
      reasoningTokens,
      reasoningToInputRatio,
      reasoningSpendUsd: cost.outputCostUsd,
      exceedsBudget,
      consecutiveRoutineHighTurns
    });
  }

  const latest = turnEvaluations[turnEvaluations.length - 1] || null;
  const triggered = consecutiveRoutineHighTurns >= 2;

  return {
    triggered,
    consecutiveRoutineHighTurns,
    reasoningTokenBudget,
    latestTurn: latest,
    turnEvaluations,
    recommendedAction: triggered ? '/effort medium' : null,
    delegateModel: triggered ? 'gemini-3.8-flash' : null,
    prescription: triggered
      ? `Gemini 4 Carbon ran at HIGH effort across ${consecutiveRoutineHighTurns} consecutive routine turns (${latest.reasoningTokens.toLocaleString('en-US')} decode tokens, ratio ${latest.reasoningToInputRatio}x, $${latest.reasoningSpendUsd.toFixed(4)} reasoning spend). Step down via /effort medium or delegate routine edits to gemini-3.8-flash.`
      : ''
  };
}


/**
 * Resolves ceiling with explicit source origin tracking ('patched_cli' | 'host' | 'custom' | 'config' | 'family' | 'hint' | 'legacy_default' | 'fallback').
 */
export function resolveModelCeilingDetailed(
  modelId = 'default',
  stdinContextWindow = null,
  { useLegacyDefault = false, config = null, cliSettings = null, cwd = null, homeDir = null, customCeilings = null } = {}
) {
  const key = normalizeModelId(modelId);
  const strippedKey = stripEffortSuffix(key);

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

  // 0b. User & workspace customCeilings.json overrides (merged ahead of config & built-in defaults)
  const customMap =
    (customCeilings && typeof customCeilings === 'object' ? customCeilings : null) ||
    (config?.customCeilings && typeof config.customCeilings === 'object' ? config.customCeilings : null) ||
    loadCustomCeilings({ cwd: cwd || config?.cwd || null, homeDir: homeDir || config?.homeDir || null });

  if (customMap && Object.keys(customMap).length > 0) {
    if (Object.prototype.hasOwnProperty.call(customMap, key)) {
      const val = Number(customMap[key]);
      if (val >= 4096) return buildCeilingDescriptor(val, 'custom', key);
    }
    if (strippedKey && Object.prototype.hasOwnProperty.call(customMap, strippedKey)) {
      const val = Number(customMap[strippedKey]);
      if (val >= 4096) return buildCeilingDescriptor(val, 'custom', key);
    }
    const customFamilyKeys = Object.keys(customMap).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
    for (const candidate of customFamilyKeys) {
      if (key.startsWith(candidate) || key.includes(candidate)) {
        const val = Number(customMap[candidate]);
        if (val >= 4096) return buildCeilingDescriptor(val, 'custom', key);
      }
    }
    if (key === 'default' && Object.prototype.hasOwnProperty.call(customMap, 'default')) {
      const val = Number(customMap.default);
      if (val >= 4096) return buildCeilingDescriptor(val, 'custom', key);
    }
  }

  // 1. Exact match in config.model_ceilings (non-'default' explicit model keys)
  if (key !== 'default' && config?.model_ceilings && Object.prototype.hasOwnProperty.call(config.model_ceilings, key)) {
    const val = Number(config.model_ceilings[key]);
    if (val >= 20000) return buildCeilingDescriptor(val, 'config', key);
  }

  // 2. Exact match in built-in table or canonical catalog/registry
  if (key !== 'default' && Object.prototype.hasOwnProperty.call(MODEL_CEILINGS, key)) {
    return buildCeilingDescriptor(MODEL_CEILINGS[key], 'config', key);
  }
  const catalog = loadModelCatalog();
  if (catalog?.models?.[key]?.shared_pool_ceiling >= 20000) {
    return buildCeilingDescriptor(Number(catalog.models[key].shared_pool_ceiling), 'config', key);
  }

  // 3. Prefix / mergedCeilings lookup BEFORE generic family fallbacks
  const mergedCeilings = { ...MODEL_CEILINGS, ...(config?.model_ceilings || {}), ...(customMap || {}) };
  const familyKeys = Object.keys(mergedCeilings).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
  for (const candidate of familyKeys) {
    if (key.startsWith(candidate) || key.includes(candidate)) {
      return buildCeilingDescriptor(mergedCeilings[candidate], 'family', key);
    }
  }

  const desc = resolveModelDescriptor(key);
  if (desc && Number(desc.shared_pool_ceiling) >= 20000) {
    return buildCeilingDescriptor(Number(desc.shared_pool_ceiling), 'family', key);
  }

  // 4. Size hints in model name
  if (/\b900k\b|900_000/.test(key)) return buildCeilingDescriptor(900000, 'patched_cli', key);
  if (/\b512k\b|512_000/.test(key)) return buildCeilingDescriptor(512000, 'patched_cli', key);
  if (/\b1m\b|1000k|1_000_000/.test(key)) return buildCeilingDescriptor(1000000, 'hint', key);
  if (/\b200k\b/.test(key)) return buildCeilingDescriptor(200000, 'hint', key);
  if (/\b256k\b/.test(key)) return buildCeilingDescriptor(256000, 'hint', key);

  // 5. Residual legacy Claude 3.5 / 4.x family -> 200,000 ceiling
  if (key.includes('claude-sonnet-4') || key.includes('claude-opus-4') || key.includes('claude-haiku-4') || key.includes('claude-3-5-sonnet') || key.includes('claude-3.5-sonnet')) {
    return buildCeilingDescriptor(200000, 'family', key);
  }

  if (useLegacyDefault) {
    return buildCeilingDescriptor(HORIZON_WINDOW.MAX_TOKENS, 'legacy_default', key);
  }

  const fallback =
    (customMap && Number(customMap.default) >= 4096 ? Number(customMap.default) : null) ||
    (config?.model_ceilings && config.model_ceilings.default) ||
    MODEL_CEILINGS.default;
  return buildCeilingDescriptor(fallback, 'fallback', key);
}

/**
 * Resolves the native context window ceiling for a given model or host telemetry payload.
 * Preserves 200,000 when useLegacyDefault is true and no explicit ceiling is supplied.
 */
export function resolveModelCeiling(
  modelId = 'default',
  stdinContextWindow = null,
  { useLegacyDefault = false, config = null, cliSettings = null, cwd = null, homeDir = null, customCeilings = null } = {}
) {
  return resolveModelCeilingDetailed(modelId, stdinContextWindow, {
    useLegacyDefault,
    config,
    cliSettings,
    cwd,
    homeDir,
    customCeilings
  }).ceilingTokens;
}

/**
 * Resolves pricing per million tokens with date-gated `MODEL_REGISTRY` schedule evaluation
 * (defaulting timestamp to `Date.now()`) and family fallback.
 */
export function resolvePricePerM(modelId = 'default', config = null) {
  const key = normalizeModelId(modelId);
  const hasTemporalOrCliffContext = Boolean(
    config?.eventTimestampUtc ||
    config?.timestamp ||
    config?.serviceTier ||
    config?.totalPromptTokens ||
    config?.freshInputTokens ||
    config?.cacheReadInputTokens ||
    config?.cacheCreationInputTokens
  );
  const customMap = config?.model_pricing_per_1m_input || null;
  const hasExplicitCustomOverride = Boolean(
    customMap &&
    Object.prototype.hasOwnProperty.call(customMap, key) &&
    Number.isFinite(Number(customMap[key])) &&
    Number(customMap[key]) !== MODEL_PRICING_PER_MILLION[key] &&
    !hasTemporalOrCliffContext
  );

  if (hasExplicitCustomOverride) {
    return Number(customMap[key]);
  }

  const desc = key && key !== 'default' ? resolveModelDescriptor(key) : null;
  if (desc) {
    const ts = config?.eventTimestampUtc ?? config?.timestamp ?? Date.now();
    const tier = config?.serviceTier || 'standard';
    return resolveModelRates(key, ts, tier, config).input_per_1m;
  }

  const pricingMap = { ...MODEL_PRICING_PER_MILLION, ...(customMap || {}) };

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
