/**
 * @file src/core-isomorphic/economics/billingBlocks.mjs
 * Feature 22: 5-Hour Rolling Billing Blocks & Subagent Cost Attribution.
 *
 * Implements:
 *   - 18,000,000 ms (5-hour) rolling billing window partitioning
 *   - Velocity metrics: burn rate in USD/hour and tokens/min per block
 *   - Per-subagent spend and token attribution
 *   - Cumulative session cost calculation across active rolling blocks
 *   - Clean empty-array handling returning `[]`
 *   - Resilient input validation: filters null/undefined events and sanitizes non-numeric costs/tokens
 *
 * Adheres strictly to Claude Mod Laws 1–5: pure ESM, zero `node:*` imports, zero Node globals.
 */

export const BILLING_BLOCK_CONSTANTS = Object.freeze({
  BLOCK_DURATION_MS: 5 * 3600 * 1000, // 18,000,000 ms (5 hours)
  BLOCK_DURATION_HOURS: 5.0,
  TOKENS_PER_MIN_DIVISOR: 300 // 5 hours * 60 minutes
});

/**
 * Partitions continuous session token usage events into rolling 5-hour billing blocks.
 *
 * @param {Array<{ timestamp: number, costUsd?: number, tokens?: number, subagentId?: string }>} [usageEvents=[]]
 * @param {number} [blockDurationMs=18000000] Block window in ms (default 5 hours)
 * @returns {Array<{
 *   blockIndex: number,
 *   startTime: number,
 *   endTime: number,
 *   totalCostUsd: number,
 *   totalTokens: number,
 *   eventCount: number,
 *   subagentSpend: Record<string, number>,
 *   burnRateUsdPerHour: number,
 *   tokensPerMin: number
 * }>}
 */
export function partitionBillingBlocks(
  usageEvents = [],
  blockDurationMs = BILLING_BLOCK_CONSTANTS.BLOCK_DURATION_MS
) {
  if (!Array.isArray(usageEvents) || usageEvents.length === 0) {
    return [];
  }

  // Filter usageEvents to keep only valid non-null object entries
  const validEvents = usageEvents.filter(ev => ev && typeof ev === 'object');
  if (validEvents.length === 0) {
    return [];
  }

  const duration = Number(blockDurationMs) > 0
    ? Number(blockDurationMs)
    : BILLING_BLOCK_CONSTANTS.BLOCK_DURATION_MS;

  const sorted = [...validEvents].sort((a, b) => {
    const tsA = Number(a.timestamp) || 0;
    const tsB = Number(b.timestamp) || 0;
    return tsA - tsB;
  });

  const startTimestamp = Number(sorted[0].timestamp) || 0;
  const blocksMap = new Map();

  for (const event of sorted) {
    const rawTs = Number(event.timestamp);
    const ts = Number.isFinite(rawTs) ? rawTs : startTimestamp;
    const blockIndex = Math.max(0, Math.floor((ts - startTimestamp) / duration));

    if (!blocksMap.has(blockIndex)) {
      blocksMap.set(blockIndex, {
        blockIndex,
        startTime: startTimestamp + (blockIndex * duration),
        endTime: startTimestamp + ((blockIndex + 1) * duration),
        totalCostUsd: 0,
        totalTokens: 0,
        eventCount: 0,
        subagentSpend: {}
      });
    }

    const block = blocksMap.get(blockIndex);
    const cost = Math.max(0, Number(event.costUsd) || 0);
    const tokens = Math.max(0, Number(event.tokens) || 0);
    const agent = String(event.subagentId || 'main');

    block.totalCostUsd = parseFloat((block.totalCostUsd + cost).toFixed(4));
    block.totalTokens += tokens;
    block.eventCount += 1;
    block.subagentSpend[agent] = parseFloat(((block.subagentSpend[agent] || 0) + cost).toFixed(4));
  }

  const durationHours = duration / 3600000;
  const durationMins = durationHours * 60;

  return Array.from(blocksMap.values()).map(b => {
    const burnRateUsdPerHour = durationHours > 0
      ? parseFloat((b.totalCostUsd / durationHours).toFixed(4))
      : 0;
    const tokensPerMin = durationMins > 0
      ? Math.round(b.totalTokens / durationMins)
      : 0;
    return {
      ...b,
      burnRateUsdPerHour,
      tokensPerMin
    };
  });
}

/**
 * Attributes total spend and token consumption across subagent IDs.
 *
 * @param {Array<{ timestamp?: number, costUsd?: number, tokens?: number, subagentId?: string }>} [usageEvents=[]]
 * @returns {Record<string, { costUsd: number, tokens: number, pct: number }>}
 */
export function attributeSubagentCosts(usageEvents = []) {
  if (!Array.isArray(usageEvents) || usageEvents.length === 0) {
    return {};
  }

  const validEvents = usageEvents.filter(ev => ev && typeof ev === 'object');
  if (validEvents.length === 0) {
    return {};
  }

  const result = {};
  let totalCost = 0;

  for (const ev of validEvents) {
    const agent = String(ev.subagentId || 'main');
    const cost = Math.max(0, Number(ev.costUsd) || 0);
    const tokens = Math.max(0, Number(ev.tokens) || 0);

    if (!result[agent]) {
      result[agent] = { costUsd: 0, tokens: 0, pct: 0 };
    }
    result[agent].costUsd = parseFloat((result[agent].costUsd + cost).toFixed(4));
    result[agent].tokens += tokens;
    totalCost += cost;
  }

  for (const agent of Object.keys(result)) {
    result[agent].pct = totalCost > 0
      ? parseFloat(((result[agent].costUsd / totalCost) * 100).toFixed(1))
      : 0;
  }

  return result;
}

/**
 * Computes aggregate summary metrics across multiple billing blocks.
 *
 * @param {Array<object>} blocks
 * @returns {{
 *   blockCount: number,
 *   cumulativeCostUsd: number,
 *   cumulativeTokens: number,
 *   maxBurnRateUsdPerHour: number,
 *   avgTokensPerMin: number
 * }}
 */
export function computeBillingBlockSummary(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return {
      blockCount: 0,
      cumulativeCostUsd: 0,
      cumulativeTokens: 0,
      maxBurnRateUsdPerHour: 0,
      avgTokensPerMin: 0
    };
  }

  const validBlocks = blocks.filter(b => b && typeof b === 'object');
  if (validBlocks.length === 0) {
    return {
      blockCount: 0,
      cumulativeCostUsd: 0,
      cumulativeTokens: 0,
      maxBurnRateUsdPerHour: 0,
      avgTokensPerMin: 0
    };
  }

  let totalCost = 0;
  let totalTokens = 0;
  let maxBurn = 0;
  let sumTokPerMin = 0;

  for (const b of validBlocks) {
    const cost = Math.max(0, Number(b.totalCostUsd) || 0);
    const tokens = Math.max(0, Number(b.totalTokens) || 0);
    const burn = Math.max(0, Number(b.burnRateUsdPerHour) || 0);
    const tokPerMin = Math.max(0, Number(b.tokensPerMin) || 0);

    totalCost += cost;
    totalTokens += tokens;
    if (burn > maxBurn) {
      maxBurn = burn;
    }
    sumTokPerMin += tokPerMin;
  }

  return {
    blockCount: validBlocks.length,
    cumulativeCostUsd: parseFloat(totalCost.toFixed(4)),
    cumulativeTokens: totalTokens,
    maxBurnRateUsdPerHour: parseFloat(maxBurn.toFixed(4)),
    avgTokensPerMin: Math.round(sumTokPerMin / validBlocks.length)
  };
}

/**
 * Stateful RollingBillingBlockTracker.
 */
export class RollingBillingBlockTracker {
  constructor(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    this.blockDurationMs = Number(opts.blockDurationMs) > 0
      ? Number(opts.blockDurationMs)
      : BILLING_BLOCK_CONSTANTS.BLOCK_DURATION_MS;
    this.events = [];
  }

  recordEvent(event = {}) {
    if (!event || typeof event !== 'object') {
      return;
    }
    const rawTs = Number(event.timestamp);
    this.events.push({
      timestamp: Number.isFinite(rawTs) ? rawTs : Date.now(),
      costUsd: Math.max(0, Number(event.costUsd) || 0),
      tokens: Math.max(0, Number(event.tokens) || 0),
      subagentId: String(event.subagentId || 'main')
    });
  }

  getBlocks() {
    return partitionBillingBlocks(this.events, this.blockDurationMs);
  }

  getSummary() {
    return computeBillingBlockSummary(this.getBlocks());
  }

  getSubagentAttribution() {
    return attributeSubagentCosts(this.events);
  }
}
