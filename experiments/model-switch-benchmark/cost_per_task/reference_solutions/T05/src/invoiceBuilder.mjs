import { INVOICE_STATUS } from './constants.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';
import { compileFilter } from './queryDsl.mjs';

function compareCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds an invoice from usage rows or filtered/grouped events and credit grants.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildInvoice({
  invoiceId,
  accountId,
  currency = 'USD',
  usageRows = [],
  events = undefined,
  metricTiers = {},
  filterExpr = undefined,
  groupByTag = undefined,
  grants = [],
  asOfMs = 0
} = {}) {
  const lineItems = [];
  let usageSubtotalCents = 0;
  let excludedEventCount = 0;

  if (Array.isArray(events)) {
    const predicate = filterExpr ? compileFilter(filterExpr) : () => true;
    const grouped = new Map();

    for (const evt of events) {
      if (!predicate(evt)) {
        excludedEventCount += 1;
        continue;
      }
      const groupValue = groupByTag ? (evt.tags?.[groupByTag] ?? 'untagged') : '';
      const key = `${evt.metric}\u0000${groupValue}`;
      const existing = grouped.get(key) || { metric: evt.metric, groupValue, units: 0 };
      existing.units += Number(evt.units || 0);
      grouped.set(key, existing);
    }

    const sortedEntries = [...grouped.values()].sort((a, b) => {
      const mCmp = compareCodeUnit(a.metric, b.metric);
      if (mCmp !== 0) return mCmp;
      if (groupByTag) {
        if (a.groupValue === 'untagged' && b.groupValue !== 'untagged') return 1;
        if (b.groupValue === 'untagged' && a.groupValue !== 'untagged') return -1;
        return compareCodeUnit(a.groupValue, b.groupValue);
      }
      return 0;
    });

    for (const entry of sortedEntries) {
      const tiers = metricTiers[entry.metric] || [{ upTo: null, unitRateCents: 0 }];
      const { totalCents } = computeGraduatedCharge(entry.units, tiers);
      usageSubtotalCents += totalCents;
      const item = {
        metric: entry.metric,
        units: entry.units,
        amountCents: totalCents
      };
      if (groupByTag) item.groupValue = entry.groupValue;
      lineItems.push(item);
    }
  } else {
    for (const row of usageRows) {
      const { totalCents } = computeGraduatedCharge(row.units, row.tiers);
      usageSubtotalCents += totalCents;
      lineItems.push({
        metric: row.metric,
        units: row.units,
        amountCents: totalCents
      });
    }
  }

  const creditResult = applyCredits(usageSubtotalCents, grants, asOfMs);
  const totalDueCents = creditResult.remainingChargeCents;
  const status = INVOICE_STATUS.FINALIZED;
  const wireDigest = encodeFrozenWireDigest({
    invoiceId,
    accountId,
    currency,
    totalDueCents,
    status
  });

  return {
    invoiceId,
    accountId,
    currency,
    status,
    lineItems,
    excludedEventCount,
    usageSubtotalCents,
    appliedCreditsCents: creditResult.appliedCents,
    creditAllocations: creditResult.allocations,
    totalDueCents,
    wireDigest
  };
}
