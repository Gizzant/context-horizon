/**
 * @file src/config/catalogLoader.mjs
 * Unified Anthropic Model Catalog loader, rate card resolver, Haiku 5.5 100k 5x cliff calculator,
 * and customCeilings.json override merger.
 */

import {
  path,
  getCwd,
  getHomeDir,
  getNodeIo,
  fileUrlToPathPure,
  readJsonSafe
} from '../utils/runtime.mjs';

export const BUILTIN_CATALOG = {
  schemaVersion: '2026.11.15',
  catalogVersion: '2026-11-15',
  source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models, 2026-11-15) & Claude Code 2.1.325 bakedCatalog',
  dateRead: '2026-11-15',
  defaultModel: 'claude-sonnet-5-5',
  cacheWriteMultipliers: {
    '5m': 1.25,
    '1h': 2.0
  },
  effortExpectedOutputTokens: {
    low: 800,
    medium: 1500,
    high: 3500,
    max: 6000
  },
  models: {
    'claude-fable-5-2': {
      id: 'claude-fable-5-2',
      label: 'Claude Fable 5.2',
      shortLabel: 'Fable 5.2',
      family: 'fable',
      generation: '5.2',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 8.0, output: 40.0, write5m: 10.0, write1h: 16.0, read: 0.2 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.025 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-fable-5-1': {
      id: 'claude-fable-5-1',
      label: 'Claude Fable 5.1',
      shortLabel: 'Fable 5.1',
      family: 'fable',
      generation: '5.1',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 10.0, output: 50.0, write5m: 12.5, write1h: 20.0, read: 0.25 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.025 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-fable-5': {
      id: 'claude-fable-5',
      label: 'Claude Fable 5',
      shortLabel: 'Fable 5',
      family: 'fable',
      generation: '5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 10.0, output: 50.0, write5m: 12.5, write1h: 20.0, read: 1.0 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models) & Claude Code 2.1.325 bakedCatalog (tier_10_50)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-5-5': {
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      shortLabel: 'Opus 5.5',
      family: 'opus',
      generation: '5.5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 4.0, output: 20.0, write5m: 5.0, write1h: 8.0, read: 0.2 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.05 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-sonnet-5-5': {
      id: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5',
      shortLabel: 'Sonnet 5.5',
      family: 'sonnet',
      generation: '5.5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 2.0, output: 10.0, write5m: 2.5, write1h: 4.0, read: 0.1 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.05 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-haiku-5-5': {
      id: 'claude-haiku-5-5',
      label: 'Claude Haiku 5.5',
      shortLabel: 'Haiku 5.5',
      family: 'haiku',
      generation: '5.5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 90000,
      ratesPer1M: { input: 0.1, output: 0.5, write5m: 0.125, write1h: 0.2, read: 0.01 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models) & Claude Code 2.1.325 bakedCatalog (haiku_55)',
      dateRead: '2026-11-15',
      pricingCliff: {
        thresholdTokens: 100000,
        preCliffWarningTokens: 90000,
        multiplier: 5.0,
        ratesPer1MAboveCliff: {
          input: 0.5,
          output: 2.5,
          write5m: 0.625,
          write1h: 1.0,
          read: 0.05
        }
      }
    },
    'claude-opus-5': {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      shortLabel: 'Opus 5',
      family: 'opus',
      generation: '5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 5.0, output: 25.0, write5m: 6.25, write1h: 10.0, read: 0.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-sonnet-5': {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      shortLabel: 'Sonnet 5',
      family: 'sonnet',
      generation: '5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 2.0, output: 10.0, write5m: 2.5, write1h: 4.0, read: 0.2 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-4-8': {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      shortLabel: 'Opus 4.8',
      family: 'opus',
      generation: '4.8',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 5.0, output: 25.0, write5m: 6.25, write1h: 10.0, read: 0.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-4-7': {
      id: 'claude-opus-4-7',
      label: 'Claude Opus 4.7',
      shortLabel: 'Opus 4.7',
      family: 'opus',
      generation: '4.7',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 5.0, output: 25.0, write5m: 6.25, write1h: 10.0, read: 0.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-4-6': {
      id: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      shortLabel: 'Opus 4.6',
      family: 'opus',
      generation: '4.6',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 5.0, output: 25.0, write5m: 6.25, write1h: 10.0, read: 0.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-4-5': {
      id: 'claude-opus-4-5',
      label: 'Claude Opus 4.5',
      shortLabel: 'Opus 4.5',
      family: 'opus',
      generation: '4.5',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 5.0, output: 25.0, write5m: 6.25, write1h: 10.0, read: 0.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-4-1': {
      id: 'claude-opus-4-1',
      label: 'Claude Opus 4.1',
      shortLabel: 'Opus 4.1',
      family: 'opus',
      generation: '4.1',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 15.0, output: 75.0, write5m: 18.75, write1h: 30.0, read: 1.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-opus-4-0': {
      id: 'claude-opus-4-0',
      label: 'Claude Opus 4',
      shortLabel: 'Opus 4',
      family: 'opus',
      generation: '4.0',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 15.0, output: 75.0, write5m: 18.75, write1h: 30.0, read: 1.5 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_15_75) & OpenRouter /api/v1/models (anthropic/claude-opus-4)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-sonnet-4-6': {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      shortLabel: 'Sonnet 4.6',
      family: 'sonnet',
      generation: '4.6',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 3.0, output: 15.0, write5m: 3.75, write1h: 6.0, read: 0.3 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-sonnet-4-5': {
      id: 'claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      shortLabel: 'Sonnet 4.5',
      family: 'sonnet',
      generation: '4.5',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 3.0, output: 15.0, write5m: 3.75, write1h: 6.0, read: 0.3 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-sonnet-4-0': {
      id: 'claude-sonnet-4-0',
      label: 'Claude Sonnet 4',
      shortLabel: 'Sonnet 4',
      family: 'sonnet',
      generation: '4.0',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 3.0, output: 15.0, write5m: 3.75, write1h: 6.0, read: 0.3 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_3_15) & OpenRouter /api/v1/models (anthropic/claude-sonnet-4)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-haiku-4-5': {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      shortLabel: 'Haiku 4.5',
      family: 'haiku',
      generation: '4.5',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 1.0, output: 5.0, write5m: 1.25, write1h: 2.0, read: 0.1 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'phase0_capabilities_and_cost_gate.md (OpenRouter /api/v1/models)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-3-7-sonnet': {
      id: 'claude-3-7-sonnet',
      label: 'Claude Sonnet 3.7',
      shortLabel: 'Sonnet 3.7',
      family: 'sonnet',
      generation: '3.7',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 3.0, output: 15.0, write5m: 3.75, write1h: 6.0, read: 0.3 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_3_15) & OpenRouter /api/v1/models (anthropic/claude-3.7-sonnet)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-3-5-sonnet': {
      id: 'claude-3-5-sonnet',
      label: 'Claude Sonnet 3.5',
      shortLabel: 'Sonnet 3.5',
      family: 'sonnet',
      generation: '3.5',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 3.0, output: 15.0, write5m: 3.75, write1h: 6.0, read: 0.3 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_3_15) & OpenRouter /api/v1/models',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-3-5-haiku': {
      id: 'claude-3-5-haiku',
      label: 'Claude Haiku 3.5',
      shortLabel: 'Haiku 3.5',
      family: 'haiku',
      generation: '3.5',
      contextCeiling: 200000,
      operationalSoftCeiling: 160000,
      ratesPer1M: { input: 0.8, output: 4.0, write5m: 1.0, write1h: 1.6, read: 0.08 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'Claude Code 2.1.325 bakedCatalog (haiku_35) & OpenRouter /api/v1/models (anthropic/claude-3.5-haiku)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-mythos-5': {
      id: 'claude-mythos-5',
      label: 'Claude Mythos 5',
      shortLabel: 'Mythos 5',
      family: 'mythos',
      generation: '5',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 10.0, output: 50.0, write5m: 12.5, write1h: 20.0, read: 1.0 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.1 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_10_50; OpenRouter price unverified)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-mythos-5-1': {
      id: 'claude-mythos-5-1',
      label: 'Claude Mythos 5.1',
      shortLabel: 'Mythos 5.1',
      family: 'mythos',
      generation: '5.1',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 10.0, output: 50.0, write5m: 12.5, write1h: 20.0, read: 0.25 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.025 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_10_50_cache_read_0_25; OpenRouter price unverified)',
      dateRead: '2026-11-15',
      pricingCliff: null
    },
    'claude-mythos-5-2': {
      id: 'claude-mythos-5-2',
      label: 'Claude Mythos 5.2',
      shortLabel: 'Mythos 5.2',
      family: 'mythos',
      generation: '5.2',
      contextCeiling: 1000000,
      operationalSoftCeiling: 180000,
      ratesPer1M: { input: 8.0, output: 40.0, write5m: 10.0, write1h: 16.0, read: 0.2 },
      multipliers: { write5m: 1.25, write1h: 2.0, read: 0.025 },
      source: 'Claude Code 2.1.325 bakedCatalog (tier_8_40_cache_read_0_20; OpenRouter price unverified)',
      dateRead: '2026-11-15',
      pricingCliff: null
    }
  }
};

/**
 * Resolves the directory containing this module when Tier-2 Node I/O is active.
 * @param {object} [options={}]
 * @returns {string | null}
 */
function getModuleDir(options = {}) {
  if (!getNodeIo(options)) return null;
  try {
    const filePath = fileUrlToPathPure(import.meta.url, options);
    return filePath ? path.dirname(filePath) : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Detects whether a raw model identifier or options flag requests a 1,000,000-token
 * extended context window (`[1m]`, `-1m`, `_1m`, or `options.extendedContext1M === true`).
 *
 * @param {string} [rawModelId='']
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function hasExtended1MHint(rawModelId = '', options = {}) {
  if (options?.extendedContext1M === true) return true;
  const raw = String(rawModelId || '').toLowerCase().trim();
  return /\[1m\]|(?:^|[-_:\s])1m(?:$|[-_:\s\]])/.test(raw);
}

export const UNKNOWN_MODEL_ID = 'unknown';

/**
 * Formats a concise, zero-USD advisory for models absent from the price catalog (Item 1.2).
 *
 * @param {string} [rawModelId='']
 * @returns {string}
 */
export function formatUnknownModelAdvisory(rawModelId = '') {
  const displayId = String(rawModelId || '').trim() || UNKNOWN_MODEL_ID;
  return `Prices for model "${displayId}" are unknown (not in price catalog); dollar figures and price-based holds are disabled.`;
}

const SHORT_MODEL_ALIASES = Object.freeze({
  opus: 'claude-opus-5-5',
  best: 'claude-opus-5-5',
  opusplan: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-2',
  mythos: 'claude-mythos-5-2',
  'claude-opus-4': 'claude-opus-4-0',
  'claude-sonnet-4': 'claude-sonnet-4-0',
  'claude-3-5-sonnet-v2': 'claude-3-5-sonnet'
});

/**
 * Canonicalizes a raw model identifier syntax (provider prefixes, `[1m]`, dates, version dots)
 * without guessing unknown model families or falling back to a default model.
 *
 * @param {string} [rawModelId='']
 * @returns {string}
 */
function canonicalizeModelToken(rawModelId = '') {
  let s = String(rawModelId || '')
    .toLowerCase()
    .trim()
    .replace(/\[[12]m\]/gi, '')
    .replace(/[-_:\s]+1m$/g, '')
    .replace(/\s+/g, '-');

  if (!s) return '';

  // Strip provider prefixes (e.g. openrouter/anthropic/, anthropic/, us.anthropic.)
  const slashIdx = s.lastIndexOf('/');
  if (slashIdx !== -1) {
    const providerPart = s.slice(0, slashIdx);
    const tail = s.slice(slashIdx + 1);
    if (providerPart === 'anthropic' || providerPart.endsWith('/anthropic')) {
      s = tail;
    } else {
      // Non-Anthropic provider prefix (e.g. google/gemini-2.5-pro, openai/gpt-5) stays intact
      return s.replace(/\./g, '-');
    }
  }

  const bedrockMatch = s.match(/^(?:[a-z-]+\.)?anthropic\.(claude-.*)$/);
  if (bedrockMatch) {
    s = bedrockMatch[1];
  }

  s = s.replace(/\./g, '-');
  // Strip Bedrock version tag (-v1:0 / -v2), date trailer (-20251001 / @20251001), or tier tag (:batch is NOT stripped as base rate)
  s = s
    .replace(/-v\d+(?::\d+)?$/i, '')
    .replace(/[@-]\d{8}$/i, '')
    .replace(/-(?:thinking|fast|latest)$/i, '');

  // Handle alternate ordering like claude-4-6-sonnet -> claude-sonnet-4-6 (4.x+ only; 3.x is claude-3-x-family)
  const altOrder = s.match(/^claude-([4-9]\d*-\d+)-(opus|sonnet|haiku|fable|mythos)$/);
  if (altOrder) {
    s = `claude-${altOrder[2]}-${altOrder[1]}`;
  }
  const threeXOrder = s.match(/^claude-(haiku|sonnet)-(3-[57])$/);
  if (threeXOrder) {
    s = `claude-${threeXOrder[2]}-${threeXOrder[1]}`;
  }

  if (Object.prototype.hasOwnProperty.call(SHORT_MODEL_ALIASES, s)) {
    return SHORT_MODEL_ALIASES[s];
  }
  if (/^(?:opus|sonnet|haiku|fable)-/.test(s) && !s.startsWith('claude-')) {
    return `claude-${s}`;
  }

  return s;
}

/**
 * Checks whether a raw model identifier resolves to a known Anthropic catalog model
 * (or an explicit custom rate card in `customCeilings.json`), returning `false` for
 * unrecognized model IDs (including uncatalogued Claude or third-party slugs).
 *
 * @param {string} [rawModelId='']
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isKnownCatalogModel(rawModelId = '', options = {}) {
  const raw = String(rawModelId || '').trim();
  if (!raw || raw.toLowerCase() === UNKNOWN_MODEL_ID) return false;

  const cleaned = canonicalizeModelToken(raw);
  if (!cleaned) return false;

  const catalog = options.catalog || loadModelCatalog(options);
  if (catalog?.models && Object.prototype.hasOwnProperty.call(catalog.models, cleaned)) {
    return true;
  }

  const customCeilings = options.customCeilings !== undefined ? options.customCeilings : loadCustomCeilings(options);
  if (customCeilings && typeof customCeilings === 'object') {
    const sourceMap =
      customCeilings.models && typeof customCeilings.models === 'object'
        ? customCeilings.models
        : customCeilings.ceilings && typeof customCeilings.ceilings === 'object'
          ? customCeilings.ceilings
          : customCeilings;
    for (const [key, val] of Object.entries(sourceMap)) {
      if (
        (key === raw || canonicalizeModelToken(key) === cleaned) &&
        val &&
        typeof val === 'object' &&
        val.ratesPer1M &&
        typeof val.ratesPer1M === 'object'
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Normalizes a raw Anthropic model string or official Claude Code alias to its canonical catalog ID.
 * Returns `BUILTIN_CATALOG.defaultModel` (`'claude-sonnet-5-5'`) only when `rawModelId` is empty/omitted;
 * returns `'unknown'` (`UNKNOWN_MODEL_ID`) for any unrecognized non-empty model identifier.
 *
 * @param {string} [rawModelId='']
 * @param {object} [options={}]
 * @returns {string}
 */
export function normalizeModelId(rawModelId = '', options = {}) {
  const raw = String(rawModelId || '').trim();
  if (!raw) return BUILTIN_CATALOG.defaultModel;

  const cleaned = canonicalizeModelToken(raw);
  if (!cleaned) return BUILTIN_CATALOG.defaultModel;

  const catalog = options.catalog || BUILTIN_CATALOG;
  if (catalog?.models && Object.prototype.hasOwnProperty.call(catalog.models, cleaned)) {
    return cleaned;
  }

  if (options.customCeilings && isKnownCatalogModel(raw, options)) {
    return cleaned;
  }

  return UNKNOWN_MODEL_ID;
}

/**
 * Discovers and reads customCeilings.json from options or standard workspace/user paths.
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function loadCustomCeilings(options = {}) {
  if (options.customCeilings && typeof options.customCeilings === 'object') {
    return options.customCeilings;
  }

  if (!getNodeIo(options)) return null;

  const candidatePaths = [];
  if (typeof options.customCeilingsPath === 'string' && options.customCeilingsPath.trim()) {
    candidatePaths.push(options.customCeilingsPath.trim());
  }

  const cwd = options.cwd || getCwd(options);
  if (cwd && cwd !== '.') {
    candidatePaths.push(path.join(cwd, '.claude', 'attention-horizon', 'customCeilings.json'));
    candidatePaths.push(path.join(cwd, 'customCeilings.json'));
    candidatePaths.push(path.join(cwd, '.claude', 'customCeilings.json'));
  }

  const modDir = getModuleDir(options);
  if (modDir) {
    candidatePaths.push(path.join(modDir, 'customCeilings.json'));
  }

  const homeDir = getHomeDir(options);
  if (homeDir) {
    candidatePaths.push(path.join(homeDir, '.claude', 'attention-horizon', 'customCeilings.json'));
    candidatePaths.push(path.join(homeDir, '.claude', 'customCeilings.json'));
  }

  for (const candidate of candidatePaths) {
    const parsed = readJsonSafe(candidate, null, options);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  }

  return null;
}

/**
 * Resolves an explicit user ceiling override (in tokens) for `modelId` from `customCeilings.json`
 * or `options.customCeilings`, returning `null` when no custom ceiling override applies (`ISS-005`).
 *
 * @param {string} [modelId='']
 * @param {object} [options={}]
 * @returns {number | null}
 */
export function resolveCustomCeilingForModel(modelId = '', options = {}) {
  const customCeilings = loadCustomCeilings(options);
  if (!customCeilings || typeof customCeilings !== 'object') {
    return null;
  }

  const sourceMap =
    customCeilings.models && typeof customCeilings.models === 'object'
      ? customCeilings.models
      : customCeilings.ceilings && typeof customCeilings.ceilings === 'object'
        ? customCeilings.ceilings
        : customCeilings;

  const extractCeilingNumber = (val) => {
    if (typeof val === 'number' && val > 0) return val;
    if (val && typeof val === 'object') {
      if (typeof val.contextCeiling === 'number' && val.contextCeiling > 0) {
        return val.contextCeiling;
      }
      if (typeof val.ceiling === 'number' && val.ceiling > 0) {
        return val.ceiling;
      }
    }
    return null;
  };

  const normId = normalizeModelId(modelId, options);
  const cleanedRaw = canonicalizeModelToken(modelId);
  if (modelId && Object.prototype.hasOwnProperty.call(sourceMap, modelId)) {
    const direct = extractCeilingNumber(sourceMap[modelId]);
    if (direct !== null) return direct;
  }

  for (const [rawKey, overrideVal] of Object.entries(sourceMap)) {
    if (rawKey === '*' || rawKey === 'schemaVersion') continue;
    const keyMatched =
      (cleanedRaw && (rawKey === cleanedRaw || canonicalizeModelToken(rawKey) === cleanedRaw)) ||
      (normId !== UNKNOWN_MODEL_ID && (rawKey === normId || normalizeModelId(rawKey, options) === normId));
    if (keyMatched) {
      const matched = extractCeilingNumber(overrideVal);
      if (matched !== null) return matched;
    }
  }

  if (Object.prototype.hasOwnProperty.call(sourceMap, '*')) {
    return extractCeilingNumber(sourceMap['*']);
  }

  return null;
}

/**
 * Applies custom ceiling overrides to a cloned catalog object.
 * @param {object} catalog
 * @param {object | null} customCeilings
 * @returns {object}
 */
function applyCeilingOverrides(catalog, customCeilings) {
  if (!customCeilings || typeof customCeilings !== 'object') {
    return catalog;
  }

  const sourceMap =
    customCeilings.models && typeof customCeilings.models === 'object'
      ? customCeilings.models
      : customCeilings.ceilings && typeof customCeilings.ceilings === 'object'
        ? customCeilings.ceilings
        : customCeilings;

  // Global wildcard override if present
  if (typeof sourceMap['*'] === 'number' && sourceMap['*'] > 0) {
    for (const modelSpec of Object.values(catalog.models)) {
      modelSpec.contextCeiling = sourceMap['*'];
    }
  } else if (sourceMap['*'] && typeof sourceMap['*'] === 'object') {
    for (const modelSpec of Object.values(catalog.models)) {
      if (typeof sourceMap['*'].contextCeiling === 'number') {
        modelSpec.contextCeiling = sourceMap['*'].contextCeiling;
      }
      if (typeof sourceMap['*'].operationalSoftCeiling === 'number') {
        modelSpec.operationalSoftCeiling = sourceMap['*'].operationalSoftCeiling;
      }
    }
  }

  for (const [rawKey, overrideVal] of Object.entries(sourceMap)) {
    if (rawKey === '*' || rawKey === 'schemaVersion') continue;
    const cleanedKey = canonicalizeModelToken(rawKey);
    const normId = catalog.models[rawKey]
      ? rawKey
      : catalog.models[cleanedKey]
        ? cleanedKey
        : normalizeModelId(rawKey, { catalog });
    let target = normId !== UNKNOWN_MODEL_ID ? catalog.models[normId] : null;
    if (!target && overrideVal && typeof overrideVal === 'object' && overrideVal.ratesPer1M) {
      const customId = cleanedKey || rawKey;
      target = {
        id: customId,
        label: overrideVal.label || customId,
        shortLabel: overrideVal.shortLabel || overrideVal.label || customId,
        family: overrideVal.family || 'custom',
        generation: overrideVal.generation || null,
        contextCeiling: Number(overrideVal.contextCeiling || overrideVal.ceiling || 200000),
        operationalSoftCeiling: Number(overrideVal.operationalSoftCeiling || 160000),
        ratesPer1M: { ...overrideVal.ratesPer1M },
        multipliers: overrideVal.multipliers || { write5m: 1.25, write1h: 2.0, read: 0.1 },
        source: overrideVal.source || 'customCeilings.json',
        dateRead: overrideVal.dateRead || null,
        pricingCliff: overrideVal.pricingCliff || null
      };
      catalog.models[customId] = target;
      continue;
    }
    if (!target) continue;

    if (typeof overrideVal === 'number' && overrideVal > 0) {
      target.contextCeiling = overrideVal;
    } else if (overrideVal && typeof overrideVal === 'object') {
      if (typeof overrideVal.contextCeiling === 'number' && overrideVal.contextCeiling > 0) {
        target.contextCeiling = overrideVal.contextCeiling;
      }
      if (typeof overrideVal.ceiling === 'number' && overrideVal.ceiling > 0) {
        target.contextCeiling = overrideVal.ceiling;
      }
      if (typeof overrideVal.operationalSoftCeiling === 'number' && overrideVal.operationalSoftCeiling > 0) {
        target.operationalSoftCeiling = overrideVal.operationalSoftCeiling;
      }
      if (overrideVal.ratesPer1M && typeof overrideVal.ratesPer1M === 'object') {
        target.ratesPer1M = { ...target.ratesPer1M, ...overrideVal.ratesPer1M };
      }
    }
  }

  return catalog;
}

/**
 * Loads the unified Anthropic Model Catalog and merges any user `customCeilings.json` overrides.
 * @param {object} [options={}]
 * @returns {object}
 */
export function loadModelCatalog(options = {}) {
  let baseCatalog = BUILTIN_CATALOG;
  const modDir = getModuleDir(options);
  if (modDir) {
    const jsonPath = path.join(modDir, 'anthropicModelCatalog.json');
    const diskCatalog = readJsonSafe(jsonPath, null, options);
    if (diskCatalog && diskCatalog.models) {
      baseCatalog = diskCatalog;
    }
  }

  const cloned = JSON.parse(JSON.stringify(baseCatalog));
  const customCeilings = loadCustomCeilings(options);
  return applyCeilingOverrides(cloned, customCeilings);
}

/**
 * Retrieves the model specification for a given model ID.
 * Empty/omitted `modelId` uses `catalog.defaultModel` (`claude-sonnet-5-5`).
 * Any non-empty unrecognized model ID returns an explicit `{ id: 'unknown', unknownModel: true, ratesPer1M: null }`
 * state rather than silently falling back to `claude-sonnet-5-5` (Item 1.2).
 * Honors `[1m]` / `-1m` / `options.extendedContext1M` 1M context windows on Claude 4.x models (`ISS-002`).
 *
 * @param {string} [modelId='']
 * @param {object} [options={}]
 * @returns {object}
 */
export function getModelSpec(modelId = '', options = {}) {
  const catalog = options.catalog || loadModelCatalog(options);
  const rawTrimmed = String(modelId || '').trim();
  if (!rawTrimmed) {
    const fallbackSpec =
      catalog.models[catalog.defaultModel] || BUILTIN_CATALOG.models['claude-sonnet-5-5'];
    if (
      hasExtended1MHint(modelId, options) &&
      resolveCustomCeilingForModel(fallbackSpec.id, options) === null &&
      fallbackSpec.contextCeiling < 1000000
    ) {
      return {
        ...fallbackSpec,
        contextCeiling: 1000000,
        operationalSoftCeiling: 800000,
        unknownModel: false
      };
    }
    return { ...fallbackSpec, unknownModel: false };
  }

  const cleaned = canonicalizeModelToken(rawTrimmed);
  const normId = normalizeModelId(rawTrimmed, { ...options, catalog });
  const directCustomSpec =
    catalog.models[cleaned] ||
    (normId !== UNKNOWN_MODEL_ID ? catalog.models[normId] : null);

  if (!directCustomSpec || normId === UNKNOWN_MODEL_ID) {
    const customCeiling = resolveCustomCeilingForModel(rawTrimmed, options);
    const defaultCeiling = hasExtended1MHint(rawTrimmed, options) ? 1000000 : 200000;
    const contextCeiling = Number(customCeiling || defaultCeiling);
    return {
      id: UNKNOWN_MODEL_ID,
      rawModelId: rawTrimmed,
      unknownModel: true,
      label: `Unknown Model (${rawTrimmed})`,
      shortLabel: 'Unknown Model',
      family: 'unknown',
      generation: null,
      contextCeiling,
      operationalSoftCeiling: Math.round(contextCeiling * 0.8),
      ratesPer1M: null,
      multipliers: null,
      source: null,
      dateRead: null,
      pricingCliff: null,
      advisory: formatUnknownModelAdvisory(rawTrimmed)
    };
  }

  if (
    (normId === 'claude-opus-4-6' ||
      normId === 'claude-sonnet-4-6' ||
      normId === 'claude-opus-4-5' ||
      normId === 'claude-sonnet-4-5') &&
    hasExtended1MHint(modelId, options) &&
    resolveCustomCeilingForModel(modelId, options) === null
  ) {
    return {
      ...directCustomSpec,
      contextCeiling: 1000000,
      operationalSoftCeiling: 800000,
      unknownModel: false
    };
  }

  return { ...directCustomSpec, unknownModel: false };
}

/**
 * Extracts normalized prompt & output token counts across all flat, camelCase, snake_case,
 * and nested Anthropic `cache_creation.ephemeral_*` usage formats without double-counting (`ISS-003`, `ISS-004`).
 *
 * @param {object} [usage={}]
 * @returns {{
 *   uncachedInputTokens: number,
 *   cacheReadTokens: number,
 *   write5mTokens: number,
 *   write1hTokens: number,
 *   remainingGenericWriteTokens: number,
 *   effectiveWrite5mTokens: number,
 *   effectiveWrite1hTokens: number,
 *   totalCacheWriteTokens: number,
 *   outputTokens: number,
 *   thinkingTokens: number
 * }}
 */
export function extractNormalizedTokenBreakdown(usage = {}) {
  if (!usage || typeof usage !== 'object') {
    return {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      write5mTokens: 0,
      write1hTokens: 0,
      remainingGenericWriteTokens: 0,
      effectiveWrite5mTokens: 0,
      effectiveWrite1hTokens: 0,
      totalCacheWriteTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0
    };
  }

  const uncachedInputTokens = Math.max(
    0,
    Number(
      usage.uncachedInputTokens ??
        usage.freshInputTokens ??
        usage.inputTokens ??
        usage.input_tokens ??
        0
    )
  );
  const cacheReadTokens = Math.max(
    0,
    Number(
      usage.cacheReadTokens ??
        usage.cacheReadInputTokens ??
        usage.cache_read_input_tokens ??
        0
    )
  );

  const nestedCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object'
      ? usage.cache_creation
      : null;

  const write5mTokens = Math.max(
    0,
    Number(
      usage.cacheWrite5mTokens ??
        usage.cache_write_5m_tokens ??
        nestedCreation?.ephemeral_5m_input_tokens ??
        0
    )
  );
  const write1hTokens = Math.max(
    0,
    Number(
      usage.cacheWrite1hTokens ??
        usage.cache_write_1h_tokens ??
        nestedCreation?.ephemeral_1h_input_tokens ??
        0
    )
  );
  const genericWriteTokens = Math.max(
    0,
    Number(
      usage.cacheWriteTokens ??
        usage.cacheCreationInputTokens ??
        usage.cache_creation_input_tokens ??
        usage.lastWriteTokens ??
        0
    )
  );

  const remainingGenericWriteTokens = Math.max(
    0,
    genericWriteTokens - (write5mTokens + write1hTokens)
  );

  const defaultTier =
    usage.cacheTtlTier === '1h' || usage.ttlTier === '1h' ? '1h' : '5m';
  const effectiveWrite5mTokens =
    write5mTokens + (defaultTier === '5m' ? remainingGenericWriteTokens : 0);
  const effectiveWrite1hTokens =
    write1hTokens + (defaultTier === '1h' ? remainingGenericWriteTokens : 0);
  const totalCacheWriteTokens = effectiveWrite5mTokens + effectiveWrite1hTokens;

  const outputTokens = Math.max(
    0,
    Number(usage.outputTokens ?? usage.output_tokens ?? usage.lastOutputTokens ?? 0)
  );
  const thinkingTokens = Math.max(
    0,
    Number(
      usage.thinkingTokens ??
        usage.thinking_tokens ??
        usage.reasoning_tokens ??
        nestedCreation?.thinking_tokens ??
        usage.lastThinkingTokens ??
        0
    )
  );

  return {
    uncachedInputTokens,
    cacheReadTokens,
    write5mTokens,
    write1hTokens,
    remainingGenericWriteTokens,
    effectiveWrite5mTokens,
    effectiveWrite1hTokens,
    totalCacheWriteTokens,
    outputTokens,
    thinkingTokens
  };
}

/**
 * Computes the exact single-turn total prompt token envelope
 * (`uncachedInputTokens + cacheReadTokens + write5mTokens + write1hTokens + remainingGenericWriteTokens`),
 * honoring an optional explicit single-turn `usage.turnPromptTokens` override while never inflating
 * a single turn with multi-turn cumulative sums (`ISS-003`, `ISS-004`).
 *
 * @param {object} [usage={}]
 * @returns {number}
 */
export function computeTotalPromptTokens(usage = {}) {
  if (!usage || typeof usage !== 'object') return 0;

  if (usage.turnPromptTokens !== undefined && usage.turnPromptTokens !== null) {
    const breakdown = extractNormalizedTokenBreakdown(usage);
    const splitSum =
      breakdown.uncachedInputTokens +
      breakdown.cacheReadTokens +
      breakdown.totalCacheWriteTokens;
    return Math.max(splitSum, Math.max(0, Number(usage.turnPromptTokens)));
  }

  const breakdown = extractNormalizedTokenBreakdown(usage);
  const hasExplicitCacheRead =
    usage.cacheReadTokens !== undefined ||
    usage.cacheReadInputTokens !== undefined ||
    usage.cache_read_input_tokens !== undefined;
  const unattributedCached = !hasExplicitCacheRead
    ? Math.max(
        0,
        Number(usage.cachedTokens ?? usage.cached_tokens ?? 0) - breakdown.totalCacheWriteTokens
      )
    : 0;

  const computedPromptTokens =
    breakdown.uncachedInputTokens +
    breakdown.cacheReadTokens +
    breakdown.totalCacheWriteTokens +
    unattributedCached;

  const hasExplicitUncached =
    usage.uncachedInputTokens !== undefined ||
    usage.freshInputTokens !== undefined ||
    usage.inputTokens !== undefined ||
    usage.input_tokens !== undefined;

  if (hasExplicitUncached && (hasExplicitCacheRead || breakdown.totalCacheWriteTokens > 0)) {
    return computedPromptTokens;
  }

  const explicitSingleTurnTotal = Math.max(
    0,
    Number(
      usage.totalPromptTokens ?? usage.totalInputTokens ?? usage.total_input_tokens ?? 0
    )
  );

  return Math.max(computedPromptTokens, explicitSingleTurnTotal);
}

/**
 * Resolves the effective USD per 1M token rate card for a model at a given prompt token volume.
 * Enforces the Claude Haiku 5.5 100,000-token 5x price cliff across all token categories.
 *
 * @param {string} [modelId='claude-sonnet-5-5']
 * @param {number} [totalPromptTokens=0]
 * @param {object} [options={}]
 * @returns {{
 *   modelId: string,
 *   label: string,
 *   shortLabel: string,
 *   family: string,
 *   contextCeiling: number,
 *   operationalSoftCeiling: number,
 *   inputPer1M: number,
 *   outputPer1M: number,
 *   write5mPer1M: number,
 *   write1hPer1M: number,
 *   readPer1M: number,
 *   multipliers: { write5m: number, write1h: number, read: number },
 *   cliffTriggered: boolean,
 *   preCliffWarningTriggered: boolean,
 *   cliffThresholdTokens: number | null,
 *   cliffMultiplier: number
 * }}
 */
export function resolveEffectiveRates(modelId = 'claude-sonnet-5-5', totalPromptTokens = 0, options = {}) {
  const spec = getModelSpec(modelId, options);
  const promptTokens = Math.max(0, Number(totalPromptTokens || 0));

  if (spec.unknownModel) {
    return {
      modelId: UNKNOWN_MODEL_ID,
      rawModelId: spec.rawModelId || String(modelId || '').trim(),
      unknownModel: true,
      label: spec.label,
      shortLabel: spec.shortLabel || 'Unknown Model',
      family: 'unknown',
      contextCeiling: spec.contextCeiling,
      operationalSoftCeiling: spec.operationalSoftCeiling,
      inputPer1M: null,
      outputPer1M: null,
      write5mPer1M: null,
      write1hPer1M: null,
      readPer1M: null,
      multipliers: null,
      source: null,
      dateRead: null,
      cliffTriggered: false,
      preCliffWarningTriggered: false,
      cliffThresholdTokens: null,
      cliffMultiplier: 1.0,
      advisory: spec.advisory || formatUnknownModelAdvisory(modelId)
    };
  }

  const cliff = spec.pricingCliff || null;
  const cliffTriggered = Boolean(cliff && promptTokens > cliff.thresholdTokens);
  const preCliffWarningTriggered = Boolean(
    cliff && promptTokens >= (cliff.preCliffWarningTokens || cliff.thresholdTokens * 0.9)
  );

  const activeRates = cliffTriggered && cliff.ratesPer1MAboveCliff
    ? cliff.ratesPer1MAboveCliff
    : spec.ratesPer1M;

  return {
    modelId: spec.id,
    unknownModel: false,
    label: spec.label,
    shortLabel: spec.shortLabel || spec.label,
    family: spec.family,
    contextCeiling: spec.contextCeiling,
    operationalSoftCeiling: spec.operationalSoftCeiling,
    inputPer1M: activeRates.input,
    outputPer1M: activeRates.output,
    write5mPer1M: activeRates.write5m,
    write1hPer1M: activeRates.write1h,
    readPer1M: activeRates.read,
    multipliers: { ...spec.multipliers },
    source: spec.source || null,
    dateRead: spec.dateRead || null,
    cliffTriggered,
    preCliffWarningTriggered,
    cliffThresholdTokens: cliff ? cliff.thresholdTokens : null,
    cliffMultiplier: cliffTriggered ? cliff.multiplier : 1.0
  };
}

/**
 * Computes exact USD turn cost and uncached equivalent baseline for a single turn.
 *
 * @param {object} [usage={}]
 * @param {string} [usage.model='claude-sonnet-5-5']
 * @param {number} [usage.inputTokens=0] - Uncached input tokens
 * @param {number} [usage.outputTokens=0] - Output tokens
 * @param {number} [usage.thinkingTokens=0] - Extended thinking tokens (billed at output rate)
 * @param {number} [usage.cacheWriteTokens=0] - Cache write tokens (uses cacheTtlTier if 5m/1h not split)
 * @param {number} [usage.cacheWrite5mTokens=0] - Explicit 5-minute cache write tokens
 * @param {number} [usage.cacheWrite1hTokens=0] - Explicit 1-hour cache write tokens
 * @param {number} [usage.cacheReadTokens=0] - Cache read tokens
 * @param {number} [usage.turnPromptTokens] - Optional explicit single-turn prompt size for cliff evaluation
 * @param {number} [usage.totalPromptTokens] - Optional explicit single-turn prompt size for cliff evaluation
 * @param {'5m'|'1h'} [usage.cacheTtlTier='5m'] - Default TTL tier when cacheWriteTokens is unsplit
 * @param {object} [options={}]
 */
export function calculateTurnCostUSD(usage = {}, options = {}) {
  const breakdown = extractNormalizedTokenBreakdown(usage);
  const uncachedInput = breakdown.uncachedInputTokens;
  const outputTokens = breakdown.outputTokens;
  const thinkingTokens = breakdown.thinkingTokens;
  const cacheReadTokens = breakdown.cacheReadTokens;
  const write5mTokens = breakdown.effectiveWrite5mTokens;
  const write1hTokens = breakdown.effectiveWrite1hTokens;
  const totalCacheWriteTokens = breakdown.totalCacheWriteTokens;
  const totalPromptTokens = computeTotalPromptTokens(usage);

  const rawModel = usage.model || usage.modelId || 'claude-sonnet-5-5';
  const rates = resolveEffectiveRates(rawModel, totalPromptTokens, options);

  if (rates.unknownModel) {
    return {
      modelId: UNKNOWN_MODEL_ID,
      rawModelId: rates.rawModelId || String(rawModel),
      unknownModel: true,
      advisory: rates.advisory,
      rates,
      tokens: {
        uncachedInput,
        cacheWrite5m: write5mTokens,
        cacheWrite1h: write1hTokens,
        totalCacheWrite: totalCacheWriteTokens,
        cacheRead: cacheReadTokens,
        totalPrompt: totalPromptTokens,
        output: outputTokens,
        thinking: thinkingTokens,
        totalOutput: outputTokens + thinkingTokens
      },
      costsUSD: {
        uncachedInput: null,
        write5m: null,
        write1h: null,
        cacheRead: null,
        output: null,
        actualCacheSpendUSD: null,
        uncachedCacheEquivalentUSD: null,
        totalActualSpendUSD: null,
        totalUncachedEquivalentUSD: null,
        netCacheSavingsUSD: null
      },
      cliffTriggered: false,
      preCliffWarningTriggered: false
    };
  }

  const inputCostUSD = (uncachedInput / 1_000_000) * rates.inputPer1M;
  const write5mCostUSD = (write5mTokens / 1_000_000) * rates.write5mPer1M;
  const write1hCostUSD = (write1hTokens / 1_000_000) * rates.write1hPer1M;
  const readCostUSD = (cacheReadTokens / 1_000_000) * rates.readPer1M;
  const outputCostUSD = ((outputTokens + thinkingTokens) / 1_000_000) * rates.outputPer1M;

  const actualCacheSpendUSD = write5mCostUSD + write1hCostUSD + readCostUSD;
  const uncachedCacheEquivalentUSD = ((totalCacheWriteTokens + cacheReadTokens) / 1_000_000) * rates.inputPer1M;

  const totalActualSpendUSD = inputCostUSD + actualCacheSpendUSD + outputCostUSD;
  const totalUncachedEquivalentUSD = inputCostUSD + uncachedCacheEquivalentUSD + outputCostUSD;
  const netCacheSavingsUSD = totalUncachedEquivalentUSD - totalActualSpendUSD;

  return {
    modelId: rates.modelId,
    unknownModel: false,
    rates,
    tokens: {
      uncachedInput,
      cacheWrite5m: write5mTokens,
      cacheWrite1h: write1hTokens,
      totalCacheWrite: totalCacheWriteTokens,
      cacheRead: cacheReadTokens,
      totalPrompt: totalPromptTokens,
      output: outputTokens,
      thinking: thinkingTokens,
      totalOutput: outputTokens + thinkingTokens
    },
    costsUSD: {
      uncachedInput: Number(inputCostUSD.toFixed(6)),
      write5m: Number(write5mCostUSD.toFixed(6)),
      write1h: Number(write1hCostUSD.toFixed(6)),
      cacheRead: Number(readCostUSD.toFixed(6)),
      output: Number(outputCostUSD.toFixed(6)),
      actualCacheSpendUSD: Number(actualCacheSpendUSD.toFixed(6)),
      uncachedCacheEquivalentUSD: Number(uncachedCacheEquivalentUSD.toFixed(6)),
      totalActualSpendUSD: Number(totalActualSpendUSD.toFixed(6)),
      totalUncachedEquivalentUSD: Number(totalUncachedEquivalentUSD.toFixed(6)),
      netCacheSavingsUSD: Number(netCacheSavingsUSD.toFixed(6))
    },
    cliffTriggered: rates.cliffTriggered,
    preCliffWarningTriggered: rates.preCliffWarningTriggered
  };
}

export default {
  BUILTIN_CATALOG,
  UNKNOWN_MODEL_ID,
  formatUnknownModelAdvisory,
  hasExtended1MHint,
  isKnownCatalogModel,
  normalizeModelId,
  loadCustomCeilings,
  resolveCustomCeilingForModel,
  loadModelCatalog,
  getModelSpec,
  extractNormalizedTokenBreakdown,
  computeTotalPromptTokens,
  resolveEffectiveRates,
  calculateTurnCostUSD
};
