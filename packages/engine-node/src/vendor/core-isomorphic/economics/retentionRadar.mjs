/**
 * @file src/core-isomorphic/economics/retentionRadar.mjs
 * Feature 18: 95% Prefix-Cache Retention Radar with Byte-Offset Diffing.
 *
 * Implements:
 *   - Isomorphic byte-offset mutation diffing via standard `new TextEncoder().encode()` (Uint8Array)
 *   - Prefix retention percentage calculation
 *   - 95% discount threshold alert & letter grading (Grade A >= 95%, Grade B 80-95%, Grade C < 80%)
 *   - Cache bust cause classification (role_prefix_mutation, rule_mutation, etc.)
 *   - Financial accounting: retained discount savings vs leaked cold prefill costs
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

export const PREFIX_RETENTION_THRESHOLDS = Object.freeze({
  DISCOUNT_THRESHOLD_PCT: 95.0,
  DIFF_GRADE_A_PCT: 95.0,
  DIFF_GRADE_B_PCT: 80.0,
  INDEX_GRADE_A_PCT: 90.0,
  INDEX_GRADE_B_PCT: 70.0,
  GRADE_A_PCT: 95.0,
  GRADE_B_PCT: 80.0,
  BUST_RATIO: 0.50
});

const DEFAULT_INPUT_PRICE_PER_1M = 3.00;
const DEFAULT_READ_PRICE_PER_1M = 0.30;

/**
 * Compares two prompt strings byte-by-byte using standard isomorphic TextEncoder.
 * Pinpoints the exact first byte offset where the prompts diverge.
 *
 * @param {string} [originalText='']
 * @param {string} [mutatedText='']
 * @returns {{
 *   firstDiffOffset: number,
 *   prefixMatchBytes: number,
 *   retentionPct: number,
 *   is95PctRetained: boolean,
 *   grade: 'A' | 'B' | 'C'
 * }}
 */
export function verifyRetentionRadarDiff(originalText = '', mutatedText = '') {
  const encoder = new TextEncoder();
  const bufOrig = encoder.encode(String(originalText ?? ''));
  const bufMut = encoder.encode(String(mutatedText ?? ''));

  let firstDiffOffset = -1;
  const minLen = Math.min(bufOrig.length, bufMut.length);

  // Fast 32-bit chunking comparison
  const u32Len = Math.floor(minLen / 4);
  const u1 = new Uint32Array(bufOrig.buffer, bufOrig.byteOffset, Math.floor(bufOrig.byteLength / 4));
  const u2 = new Uint32Array(bufMut.buffer, bufMut.byteOffset, Math.floor(bufMut.byteLength / 4));

  let chunkIdx = 0;
  while (chunkIdx < u32Len && u1[chunkIdx] === u2[chunkIdx]) {
    chunkIdx++;
  }

  for (let i = chunkIdx * 4; i < minLen; i++) {
    if (bufOrig[i] !== bufMut[i]) {
      firstDiffOffset = i;
      break;
    }
  }

  if (firstDiffOffset === -1 && bufOrig.length !== bufMut.length) {
    firstDiffOffset = minLen;
  }

  const prefixMatchBytes = firstDiffOffset === -1 ? bufOrig.length : firstDiffOffset;
  const retentionPct = bufOrig.length === 0
    ? 100
    : parseFloat(((prefixMatchBytes / bufOrig.length) * 100).toFixed(2));

  let grade = 'C';
  if (retentionPct >= PREFIX_RETENTION_THRESHOLDS.GRADE_A_PCT) {
    grade = 'A';
  } else if (retentionPct >= PREFIX_RETENTION_THRESHOLDS.GRADE_B_PCT) {
    grade = 'B';
  }

  return {
    firstDiffOffset,
    prefixMatchBytes,
    retentionPct,
    is95PctRetained: retentionPct >= PREFIX_RETENTION_THRESHOLDS.DISCOUNT_THRESHOLD_PCT,
    grade
  };
}

/**
 * Finds the first mutation offset between two texts, including line and column numbers
 * and a 40-character contextual snippet.
 *
 * @param {string} prevText
 * @param {string} currText
 * @returns {{
 *   firstDiffOffset: number,
 *   line: number,
 *   column: number,
 *   snippet: string,
 *   retentionPct: number,
 *   is95PctRetained: boolean,
 *   grade: 'A' | 'B' | 'C'
 * }}
 */
export function findPrefixMutationOffset(prevText = '', currText = '') {
  const diff = verifyRetentionRadarDiff(prevText, currText);
  const offset = diff.firstDiffOffset;

  if (offset === -1) {
    return {
      ...diff,
      line: 1,
      column: 1,
      snippet: ''
    };
  }

  const text = String(currText ?? '');
  const bufCurr = new TextEncoder().encode(text);

  // Safely convert UTF-8 byte offset to UTF-16 code unit index.
  // Clamp safeOffset within bounds and step backward past any UTF-8 continuation bytes (0x80..0xBF)
  // so TextDecoder never decodes a truncated multibyte sequence or emits \uFFFD.
  let safeOffset = Math.max(0, Math.min(offset, bufCurr.length));
  while (safeOffset > 0 && (bufCurr[safeOffset] & 0xC0) === 0x80) {
    safeOffset--;
  }

  const charOffset = new TextDecoder().decode(bufCurr.subarray(0, safeOffset)).length;
  const textBefore = text.slice(0, charOffset);
  const lines = textBefore.split('\n');
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;

  const start = Math.max(0, charOffset - 15);
  const end = Math.min(text.length, charOffset + 25);
  const snippet = text.slice(start, end);

  return {
    ...diff,
    line,
    column,
    snippet
  };
}

/**
 * Classifies the likely cause of a prefix cache bust based on diff offset and text contents.
 *
 * @param {number} firstDiffOffset
 * @param {string} [mutatedText='']
 * @returns {string}
 */
export function classifyBustCause(firstDiffOffset, mutatedText = '') {
  if (firstDiffOffset < 0) return 'none';
  if (firstDiffOffset < 60) return 'role_prefix_mutation';
  const prefix = String(mutatedText).slice(0, firstDiffOffset + 100);
  if (/rule|instruction|guideline|invariant/i.test(prefix)) {
    return 'rule_mutation';
  }
  if (/tool|function|schema|mcp/i.test(prefix)) {
    return 'tools_changed';
  }
  if (/system\s+prompt/i.test(prefix)) {
    return 'system_prompt_mutation';
  }
  return 'prefix_drift';
}

/**
 * Creates an empty initial prefix retention accumulator.
 * @returns {object}
 */
export function createInitialPrefixRetention() {
  return {
    measured: false,
    measuredTurns: 0,
    bustCount: 0,
    ttlExpiredTurns: 0,
    retentionIndexPct: 100,
    grade: 'A',
    series: [],
    retainedDiscountSavingsUSD: 0,
    leakedColdPrefillUSD: 0,
    lastDiff: null
  };
}

/**
 * Computes multi-turn prefix retention metrics and dollar savings across turns.
 *
 * @param {Array<object>} turns
 * @param {object} [options={}]
 * @param {number} [options.inputPricePer1M]
 * @param {number} [options.readPricePer1M]
 * @returns {object}
 */
export function computePrefixRetention(turns = [], options = {}) {
  const rawInputPrice = Number(options.inputPricePer1M ?? DEFAULT_INPUT_PRICE_PER_1M);
  const rawReadPrice = Number(options.readPricePer1M ?? DEFAULT_READ_PRICE_PER_1M);
  const inputPrice = Number.isFinite(rawInputPrice) ? rawInputPrice : DEFAULT_INPUT_PRICE_PER_1M;
  const readPrice = Number.isFinite(rawReadPrice) ? rawReadPrice : DEFAULT_READ_PRICE_PER_1M;
  const savingsPer1M = Math.max(0, inputPrice - readPrice);

  if (!Array.isArray(turns) || turns.length === 0) {
    return createInitialPrefixRetention();
  }

  let totalRetainedTokens = 0;
  let totalEligibleTokens = 0;
  let totalLeakedTokens = 0;
  let bustCount = 0;
  let ttlExpiredTurns = 0;
  const series = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.ttlExpired) {
      ttlExpiredTurns += 1;
      series.push({ pct: null, bust: false, cause: 'ttl_expired', ttlExpired: true });
      continue;
    }

    const rawEligible = Number(t.eligibleTokens ?? t.previousPrefixTokens ?? 0);
    const rawRetained = Number(t.retainedTokens ?? t.cacheReadTokens ?? 0);
    const eligible = Number.isFinite(rawEligible) ? Math.max(0, rawEligible) : 0;
    const retained = Number.isFinite(rawRetained) ? Math.max(0, rawRetained) : 0;
    const leaked = Math.max(0, eligible - retained);

    totalEligibleTokens += eligible;
    totalRetainedTokens += retained;
    totalLeakedTokens += leaked;

    const pct = eligible === 0 ? 100 : parseFloat(((retained / eligible) * 100).toFixed(1));
    const isBust = eligible > 0 && (retained / eligible) < PREFIX_RETENTION_THRESHOLDS.BUST_RATIO;
    if (isBust) bustCount += 1;

    series.push({
      turnIndex: i + 1,
      pct,
      bust: isBust,
      cause: t.bustCause || (isBust ? 'prefix_drift' : 'none'),
      ttlExpired: false,
      savedUSD: parseFloat(((retained * savingsPer1M) / 1_000_000).toFixed(4)),
      leakedUSD: parseFloat(((leaked * savingsPer1M) / 1_000_000).toFixed(4))
    });
  }

  const retentionIndexPct = totalEligibleTokens === 0
    ? 100
    : parseFloat(((totalRetainedTokens / totalEligibleTokens) * 100).toFixed(1));

  let grade = 'C';
  if (retentionIndexPct >= PREFIX_RETENTION_THRESHOLDS.INDEX_GRADE_A_PCT) {
    grade = 'A';
  } else if (retentionIndexPct >= PREFIX_RETENTION_THRESHOLDS.INDEX_GRADE_B_PCT) {
    grade = 'B';
  }

  const retainedDiscountSavingsUSD = parseFloat(((totalRetainedTokens * savingsPer1M) / 1_000_000).toFixed(4));
  const leakedColdPrefillUSD = parseFloat(((totalLeakedTokens * savingsPer1M) / 1_000_000).toFixed(4));

  return {
    measured: series.length > 0,
    measuredTurns: series.length,
    bustCount,
    ttlExpiredTurns,
    retentionIndexPct,
    grade,
    series,
    retainedDiscountSavingsUSD,
    leakedColdPrefillUSD,
    lastDiff: null
  };
}

/**
 * Stateful RetentionRadar tracker for rolling turns.
 */
export class RetentionRadar {
  constructor(options = {}) {
    this.options = options;
    this.state = createInitialPrefixRetention();
    this.lastPrompt = '';
  }

  /**
   * Records a turn's prompt and updates the radar state.
   * @param {string} promptText
   * @param {object} [metadata={}]
   * @returns {object} Diff result
   */
  recordTurn(promptText = '', metadata = {}) {
    const isFirstTurn = this.lastPrompt === '';
    const diff = verifyRetentionRadarDiff(this.lastPrompt, promptText);
    this.state.lastDiff = diff;
    this.state.measured = true;
    this.state.measuredTurns += 1;

    const isBust = diff.retentionPct < 50;
    if (isBust) this.state.bustCount += 1;

    const cause = isFirstTurn || diff.retentionPct >= PREFIX_RETENTION_THRESHOLDS.DISCOUNT_THRESHOLD_PCT
      ? 'none'
      : classifyBustCause(diff.firstDiffOffset, promptText);

    this.state.series.push({
      turnIndex: this.state.measuredTurns,
      pct: diff.retentionPct,
      bust: isBust,
      cause,
      ttlExpired: Boolean(metadata.ttlExpired)
    });

    this.lastPrompt = promptText;
    return diff;
  }

  getState() {
    return this.state;
  }
}

/**
 * Returns a compact 1-line retention summary for statuslines.
 * @param {object} retention
 * @returns {string}
 */
export function formatRetentionCompact(retention) {
  if (!retention?.measured) return 'Cache: —';
  const pct = retention.retentionIndexPct ?? 100;
  const grade = retention.grade ?? 'A';
  return `Cache: ${pct}% [${grade}]`;
}

/**
 * Formats a detailed retention label for reports.
 * @param {object} retention
 * @returns {string}
 */
export function formatRetentionLabel(retention) {
  if (!retention?.measured) return 'Prefix retention unmeasured';
  return `${retention.retentionIndexPct}% retained (${retention.grade}) · ${retention.bustCount} busts`;
}
