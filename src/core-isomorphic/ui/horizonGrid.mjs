/**
 * @file src/ui/horizonGrid.mjs
 * 40-Cell Non-Linear Dynamic Horizon Bar for Claude Code Highbeam.
 *
 * Maps active context window tokens onto a 40-cell grid with 3 dynamic zoom tiers:
 *   1. `100k` ceiling (`2,500` tokens/cell) when running `claude-haiku-5-5` at <= 100,000 tokens
 *   2. `200k` ceiling (`5,000` tokens/cell) standard operational horizon (<= 180,000 tokens)
 *   3. `1M` ceiling (`25,000` tokens/cell) auto-zoom when `total_input_tokens > 180,000`
 *
 * Token Categories & Canonical Palette:
 *   - `[S]` System & MCP Schema Overhead (`#1A73E8`)
 *   - `[C]` Warm Cached History (`#81C995`)
 *   - `[D]` Middle-Window Distractor / Stale Tool Debt (`#F538A0`)
 *   - `[W]` Fresh `1.25x` Cache Write Delta (`#FA903E`)
 *   - `[.]` Available Capacity (`#5F6368`)
 */

import {
  normalizeModelId,
  resolveCustomCeilingForModel
} from '../config/catalogLoader.mjs';

export const GRID_CELL_COUNT = 40;

export const CELL_CATEGORIES = Object.freeze({
  S: {
    code: 'S',
    tag: '[S]',
    label: 'System & MCP Schema Overhead',
    colorHex: '#1A73E8',
    ansiFg: '\x1b[38;2;26;115;232m',
    blockChar: '█'
  },
  C: {
    code: 'C',
    tag: '[C]',
    label: 'Warm Cached History',
    colorHex: '#81C995',
    ansiFg: '\x1b[38;2;129;201;149m',
    blockChar: '▓'
  },
  D: {
    code: 'D',
    tag: '[D]',
    label: 'Middle-Window Distractor / Stale Tool Debt',
    colorHex: '#F538A0',
    ansiFg: '\x1b[38;2;245;56;160m',
    blockChar: '▒'
  },
  W: {
    code: 'W',
    tag: '[W]',
    label: 'Fresh 1.25x Cache Write Delta',
    colorHex: '#FA903E',
    ansiFg: '\x1b[38;2;250;144;62m',
    blockChar: '█'
  },
  EMPTY: {
    code: '.',
    tag: '[.]',
    label: 'Available Horizon Capacity',
    colorHex: '#5F6368',
    ansiFg: '\x1b[90m',
    blockChar: '░'
  }
});

export const ZOOM_TIERS = Object.freeze({
  TIER_100K: {
    id: '100k',
    ceilingTokens: 100000,
    tokensPerCell: 2500,
    label: '100k Haiku Cliff Horizon (2.5k/cell)'
  },
  TIER_200K: {
    id: '200k',
    ceilingTokens: 200000,
    tokensPerCell: 5000,
    label: '200k Standard Operational Horizon (5k/cell)'
  },
  TIER_1M: {
    id: '1M',
    ceilingTokens: 1000000,
    tokensPerCell: 25000,
    label: '1M Extended Auto-Zoom Horizon (25k/cell)'
  }
});

const ANSI_RESET = '\x1b[0m';

/**
 * Checks whether ANSI escape codes must be suppressed (`ISS-050`).
 * Honors `options.noColor === true` or `'NO_COLOR' in (globalThis.process?.env || {})`
 * unless `options.forceColor === true`.
 *
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isNoColorEnabled(options = {}) {
  if (options?.noColor === true) return true;
  if (options?.forceColor === true) return false;
  return 'NO_COLOR' in (globalThis.process?.env || {});
}

/**
 * Formats a custom ceiling token count into a compact label ID (e.g. `400k`, `1.5M`, `128k`).
 * @param {number} tokens
 * @returns {string}
 */
function formatCompactCeilingId(tokens) {
  const n = Math.max(1, Math.round(Number(tokens || 0)));
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
 * Builds a custom zoom tier scaled directly to an explicit user ceiling override (`ISS-005`).
 * @param {number} ceilingTokens
 */
function buildCustomZoomTier(ceilingTokens) {
  const ceiling = Math.max(1, Math.round(Number(ceilingTokens)));
  const tokensPerCell = Math.max(1, Math.round(ceiling / GRID_CELL_COUNT));
  const id = formatCompactCeilingId(ceiling);
  const perCellLabel = formatCompactCeilingId(tokensPerCell);
  return {
    id,
    ceilingTokens: ceiling,
    tokensPerCell,
    isCustom: true,
    label: `${id} Custom Horizon (${perCellLabel}/cell)`
  };
}

/**
 * Resolves which dynamic zoom tier (or explicit custom ceiling override) applies to a model and token count.
 *
 * @param {string} [model='claude-sonnet-5-5']
 * @param {number} [totalInputTokens=0]
 * @param {object} [options={}]
 * @returns {{ id: string, ceilingTokens: number, tokensPerCell: number, label: string, isCustom?: boolean }}
 */
export function resolveHorizonZoomTier(
  model = 'claude-sonnet-5-5',
  totalInputTokens = 0,
  options = {}
) {
  const explicitOptCeiling = Number(options.customCeiling ?? options.contextCeiling ?? 0);
  if (Number.isFinite(explicitOptCeiling) && explicitOptCeiling > 0) {
    return buildCustomZoomTier(explicitOptCeiling);
  }

  const catalogOverride = resolveCustomCeilingForModel(model, options);
  if (catalogOverride !== null && catalogOverride > 0) {
    return buildCustomZoomTier(catalogOverride);
  }

  const normModel = normalizeModelId(model);
  const tokens = Math.max(0, Number(totalInputTokens || 0));

  if (tokens > 180000) {
    return ZOOM_TIERS.TIER_1M;
  }

  if (normModel === 'claude-haiku-5-5' && tokens <= 100000) {
    return ZOOM_TIERS.TIER_100K;
  }

  return ZOOM_TIERS.TIER_200K;
}

/**
 * Allocates integer cell counts for `[S]`, `[C]`, `[D]`, `[W]` summing to `occupiedCells`.
 * Ensures any non-zero token category with enough room gets at least 1 cell for visual fidelity.
 *
 * @param {{ S: number, C: number, D: number, W: number }} tokenBreakdown
 * @param {number} occupiedCells
 * @returns {{ S: number, C: number, D: number, W: number }}
 */
function allocateCategoryCells(tokenBreakdown, occupiedCells) {
  if (occupiedCells <= 0) {
    return { S: 0, C: 0, D: 0, W: 0 };
  }

  const keys = ['S', 'C', 'D', 'W'];
  const totalTokens = keys.reduce((acc, k) => acc + Math.max(0, tokenBreakdown[k] || 0), 0);
  if (totalTokens <= 0) {
    return { S: 0, C: occupiedCells, D: 0, W: 0 };
  }

  const rawCounts = {};
  const counts = { S: 0, C: 0, D: 0, W: 0 };
  const remainders = [];

  for (const key of keys) {
    const val = Math.max(0, tokenBreakdown[key] || 0);
    const exact = (val / totalTokens) * occupiedCells;
    rawCounts[key] = exact;
    counts[key] = Math.floor(exact);
    remainders.push({ key, rem: exact - counts[key], val });
  }

  let currentSum = keys.reduce((acc, k) => acc + counts[k], 0);
  remainders.sort((a, b) => b.rem - a.rem || b.val - a.val);

  for (const item of remainders) {
    if (currentSum >= occupiedCells) break;
    if (item.val > 0) {
      counts[item.key] += 1;
      currentSum += 1;
    }
  }

  // Guarantee at least 1 cell for non-trivial categories (>0 tokens) if occupiedCells >= number of active categories
  const activeKeys = keys.filter((k) => (tokenBreakdown[k] || 0) > 0);
  if (occupiedCells >= activeKeys.length) {
    for (const key of activeKeys) {
      if (counts[key] === 0) {
        // Borrow 1 cell from the largest category with count > 1
        let donor = null;
        let maxCount = 1;
        for (const candidate of activeKeys) {
          if (counts[candidate] > maxCount) {
            maxCount = counts[candidate];
            donor = candidate;
          }
        }
        if (donor) {
          counts[donor] -= 1;
          counts[key] += 1;
        }
      }
    }
  }

  return counts;
}

/**
 * Extracts normalized token breakdown from either a telemetry state object or direct options.
 *
 * @param {object} [input={}]
 * @returns {{
 *   modelId: string,
 *   totalInputTokens: number,
 *   systemTokens: number,
 *   cachedHistoryTokens: number,
 *   distractorTokens: number,
 *   writeDeltaTokens: number
 * }}
 */
export function extractHorizonTokens(input = {}) {
  const cw = input.contextWindow || input;
  const modelId = normalizeModelId(input.modelId || input.model || 'claude-sonnet-5-5');

  const rawSystem = Math.max(
    0,
    Number(cw.systemAndMcpTokens ?? input.systemAndMcpTokens ?? input.systemTokens ?? 0)
  );
  const rawDistractor = Math.max(
    0,
    Number(cw.distractorTokens ?? input.distractorTokens ?? 0)
  );
  const rawWrite = Math.max(
    0,
    Number(
      cw.lastWriteTokens ??
        input.writeDeltaTokens ??
        input.cacheWriteTokens ??
        input.cacheCreationTokens ??
        cw.cacheCreationTokens ??
        0
    ) + Number(cw.uncachedInputTokens ?? input.uncachedInputTokens ?? 0)
  );
  const rawCached = Math.max(
    0,
    Number(cw.cachedTokens ?? input.cachedTokens ?? input.cacheReadTokens ?? 0)
  );

  const explicitTotal = Number(
    cw.totalInputTokens ?? input.totalInputTokens ?? input.totalTokens ?? 0
  );
  const sumParts = rawSystem + rawDistractor + rawWrite + rawCached;
  const totalInputTokens = Math.max(0, explicitTotal > 0 ? explicitTotal : sumParts);

  if (totalInputTokens === 0) {
    return {
      modelId,
      totalInputTokens: 0,
      systemTokens: 0,
      cachedHistoryTokens: 0,
      distractorTokens: 0,
      writeDeltaTokens: 0
    };
  }

  // Clamp S, D, W so they never exceed totalInputTokens, and assign the remainder to C (Warm Cached History)
  const systemTokens = Math.min(totalInputTokens, rawSystem);
  const remainingAfterS = Math.max(0, totalInputTokens - systemTokens);
  const distractorTokens = Math.min(remainingAfterS, rawDistractor);
  const remainingAfterD = Math.max(0, remainingAfterS - distractorTokens);
  const writeDeltaTokens = Math.min(remainingAfterD, rawWrite);
  const cachedHistoryTokens = Math.max(0, remainingAfterD - writeDeltaTokens);

  return {
    modelId,
    totalInputTokens,
    systemTokens,
    cachedHistoryTokens,
    distractorTokens,
    writeDeltaTokens
  };
}

/**
 * Computes the 40-Cell Dynamic Horizon Grid and its ASCII/Unicode/ANSI representations.
 *
 * @param {object} [input={}]
 * @param {object} [options={}]
 * @param {number} [options.cellCount=40]
 * @returns {{
 *   cellCount: number,
 *   modelId: string,
 *   zoomTier: { id: '100k'|'200k'|'1M', ceilingTokens: number, tokensPerCell: number, label: string },
 *   totalInputTokens: number,
 *   utilizationPct: number,
 *   occupiedCells: number,
 *   emptyCells: number,
 *   tokens: { S: number, C: number, D: number, W: number },
 *   cellCounts: { S: number, C: number, D: number, W: number, empty: number },
 *   cells: Array<{ index: number, code: string, tag: string, colorHex: string, label: string }>,
 *   barChars: string,
 *   bracketedBar: string,
 *   unicodeBar: string,
 *   ansiBar: string,
 *   ansiCodeBar: string,
 *   legend: string
 * }}
 */
export function computeHorizonGrid(input = {}, options = {}) {
  const cellCount = Math.max(8, Number(options.cellCount || GRID_CELL_COUNT));
  const extracted = extractHorizonTokens(input);
  const rawModel = input.rawModelId || input.modelId || input.model || extracted.modelId;

  const explicitCustomProp = Number(
    options.customCeiling ??
      options.contextCeiling ??
      input.customCeiling ??
      input.contextWindow?.customCeiling ??
      0
  );
  const rawInputCeiling = Number(
    input.contextCeiling ?? input.contextWindow?.contextCeiling ?? 0
  );
  const isNonStandardInputCeiling =
    rawInputCeiling > 0 &&
    rawInputCeiling !== 200000 &&
    rawInputCeiling !== 1000000 &&
    !(extracted.modelId === 'claude-haiku-5-5' && rawInputCeiling === 100000);

  const zoomOptions =
    explicitCustomProp > 0
      ? { ...options, customCeiling: explicitCustomProp }
      : isNonStandardInputCeiling
        ? { ...options, customCeiling: rawInputCeiling }
        : options;

  const zoomTier = resolveHorizonZoomTier(rawModel, extracted.totalInputTokens, zoomOptions);

  // Scale tokensPerCell if a custom cellCount (e.g. 16 or 20 for narrow terminal) is requested
  const tokensPerCell =
    cellCount === GRID_CELL_COUNT
      ? zoomTier.tokensPerCell
      : Math.max(1, Math.round(zoomTier.ceilingTokens / cellCount));

  const rawOccupied =
    extracted.totalInputTokens > 0
      ? Math.ceil(extracted.totalInputTokens / tokensPerCell)
      : 0;
  const occupiedCells = Math.max(0, Math.min(cellCount, rawOccupied));
  const emptyCells = Math.max(0, cellCount - occupiedCells);

  const tokenBreakdown = {
    S: extracted.systemTokens,
    C: extracted.cachedHistoryTokens,
    D: extracted.distractorTokens,
    W: extracted.writeDeltaTokens
  };

  const allocated = allocateCategoryCells(tokenBreakdown, occupiedCells);
  const cellCounts = {
    S: allocated.S,
    C: allocated.C,
    D: allocated.D,
    W: allocated.W,
    empty: emptyCells
  };

  const cells = [];
  const orderedCodes = [
    ...Array(cellCounts.S).fill('S'),
    ...Array(cellCounts.C).fill('C'),
    ...Array(cellCounts.D).fill('D'),
    ...Array(cellCounts.W).fill('W'),
    ...Array(cellCounts.empty).fill('.')
  ];

  const noColor = isNoColorEnabled(options);
  let barChars = '';
  let unicodeBar = '';
  let ansiBar = '';
  let ansiCodeBar = '';

  for (let i = 0; i < cellCount; i++) {
    const code = orderedCodes[i] || '.';
    const meta = code === '.' ? CELL_CATEGORIES.EMPTY : CELL_CATEGORIES[code];
    cells.push({
      index: i,
      code: meta.code,
      tag: meta.tag,
      colorHex: meta.colorHex,
      label: meta.label
    });
    barChars += meta.code;
    unicodeBar += meta.blockChar;
    if (noColor) {
      ansiBar += meta.blockChar;
      ansiCodeBar += meta.code;
    } else {
      ansiBar += `${meta.ansiFg}${meta.blockChar}${ANSI_RESET}`;
      ansiCodeBar += `${meta.ansiFg}${meta.code}${ANSI_RESET}`;
    }
  }

  const utilizationPct = Number(
    Math.min(100, (extracted.totalInputTokens / zoomTier.ceilingTokens) * 100).toFixed(1)
  );

  const legend = '[S] Sys/MCP  [C] Warm Cache  [D] Distractor  [W] 1.25x Write';

  return {
    cellCount,
    modelId: extracted.modelId,
    zoomTier,
    totalInputTokens: extracted.totalInputTokens,
    utilizationPct,
    occupiedCells,
    emptyCells,
    tokens: tokenBreakdown,
    cellCounts,
    cells,
    barChars,
    bracketedBar: `[${barChars}]`,
    unicodeBar,
    ansiBar,
    ansiCodeBar: `[${ansiCodeBar}]`,
    legend
  };
}

export default {
  GRID_CELL_COUNT,
  CELL_CATEGORIES,
  ZOOM_TIERS,
  isNoColorEnabled,
  resolveHorizonZoomTier,
  extractHorizonTokens,
  computeHorizonGrid
};
