/**
 * @file src/core-isomorphic/ui/brailleSparkline.mjs
 * Feature 23: ANSI Braille & Block Sparklines for Highbeam Terminal HUDs.
 *
 * Implements:
 *   - 2x-Resolution Unicode Braille Sparklines (`U+2800..U+28FF`)
 *     (2 columns per character x 4 vertical dot levels)
 *   - 8-Level Unicode Block Sparklines (`\u2581..\u2588`)
 *   - Responsive terminal width capping (40, 80, 110, 144 columns)
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

export const BLOCK_SPARK_GLYPHS = Object.freeze([
  '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'
]);

// Dot bit patterns for Braille characters (0x2800 offset)
// Left column (Dots 1, 2, 3, 7) levels 0..4
const BRAILLE_LEFT_BITS = [
  0,          // Level 0: no dots
  0x40,       // Level 1: Dot 7
  0x44,       // Level 2: Dots 3, 7
  0x46,       // Level 3: Dots 2, 3, 7
  0x47        // Level 4: Dots 1, 2, 3, 7
];

// Right column (Dots 4, 5, 6, 8) levels 0..4
const BRAILLE_RIGHT_BITS = [
  0,          // Level 0: no dots
  0x80,       // Level 1: Dot 8
  0xA0,       // Level 2: Dots 6, 8
  0xB0,       // Level 3: Dots 5, 6, 8
  0xB8        // Level 4: Dots 4, 5, 6, 8
];

/**
 * Renders an inline Unicode block sparkline from per-turn values.
 *
 * @param {Array<number>} turnDeltas
 * @param {number} [maxTurns=16]
 * @returns {string}
 */
export function buildTurnVelocitySparkline(turnDeltas = [], maxTurns = 16) {
  const arr = Array.isArray(turnDeltas)
    ? turnDeltas.map(n => Math.max(0, Number(n) || 0)).slice(-maxTurns)
    : [];
  if (arr.length === 0) return '';
  const peak = Math.max(...arr, 1);
  return arr.map(val => {
    if (val <= 0) return BLOCK_SPARK_GLYPHS[0];
    const idx = Math.min(
      BLOCK_SPARK_GLYPHS.length - 1,
      Math.max(0, Math.floor((val / peak) * (BLOCK_SPARK_GLYPHS.length - 1)))
    );
    return BLOCK_SPARK_GLYPHS[idx];
  }).join('');
}

/**
 * Alias for buildTurnVelocitySparkline conforming to renderer signature.
 *
 * @param {Array<number>} values
 * @param {object} [options={}]
 * @returns {string}
 */
export function renderBlockSparkline(values = [], options = {}) {
  const maxTurns = options.maxTurns || options.width || 16;
  return buildTurnVelocitySparkline(values, maxTurns);
}

/**
 * Builds a high-resolution Unicode Braille sparkline from an array of numbers.
 * Encodes 2 consecutive data points into each Braille glyph.
 *
 * @param {Array<number>} values Array of numerical data points
 * @param {object} [options={}]
 * @param {number} [options.maxChars] Maximum number of characters to emit
 * @param {number} [options.columns] Target terminal column width (40, 80, 110, 144)
 * @param {number} [options.min] Optional explicit minimum baseline
 * @param {number} [options.max] Optional explicit maximum peak
 * @returns {string}
 */
export function buildBrailleSparkline(values = [], options = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }

  const raw = values.map(v => (Number.isFinite(Number(v)) ? Number(v) : 0));
  const maxChars = options.maxChars || (options.columns ? Math.floor(options.columns / 4) : 16);
  const maxPoints = maxChars * 2;
  const sliced = raw.slice(-maxPoints);

  const min = options.min !== undefined ? Number(options.min) : Math.min(...sliced);
  const max = options.max !== undefined ? Number(options.max) : Math.max(...sliced);
  const range = Math.max(1e-6, max - min);

  // Map each value to a level 0..4
  const levels = sliced.map(v => {
    const norm = Math.max(0, Math.min(1, (v - min) / range));
    return Math.min(4, Math.max(0, Math.round(norm * 4)));
  });

  // If odd length, pad with initial baseline
  if (levels.length % 2 !== 0) {
    levels.unshift(0);
  }

  let result = '';
  for (let i = 0; i < levels.length; i += 2) {
    const leftLevel = levels[i];
    const rightLevel = levels[i + 1];
    const code = 0x2800 + ((BRAILLE_LEFT_BITS[leftLevel] || 0) | (BRAILLE_RIGHT_BITS[rightLevel] || 0));
    result += String.fromCharCode(code);
  }

  return result;
}

/**
 * Alias for buildBrailleSparkline.
 */
export function renderBrailleSparkline(values = [], options = {}) {
  return buildBrailleSparkline(values, options);
}

/**
 * Formats a sparkline summary line with min/max bounds.
 *
 * @param {Array<number>} values
 * @param {object} [options={}]
 * @returns {string}
 */
export function formatSparklineSummary(values = [], options = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    return '—';
  }
  const sparkline = buildBrailleSparkline(values, options);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return `${min} ${sparkline} ${max}`;
}
