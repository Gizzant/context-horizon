import { INVOICE_STATUS, DEFAULT_TIME_ZONE } from './constants.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';
import { enumerateDailyWindows } from './clock.mjs';

export function buildInvoice({
  invoiceId,
  accountId,
  currency = 'USD',
  usageRows = [],
  grants = [],
  asOfMs = 0
} = {}) {
  const lineItems = [];
  let usageSubtotalCents = 0;

  for (const row of usageRows) {
    const { totalCents } = computeGraduatedCharge(row.units, row.tiers);
    usageSubtotalCents += totalCents;
    lineItems.push({
      metric: row.metric,
      units: row.units,
      amountCents: totalCents
    });
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
    usageSubtotalCents,
    appliedCreditsCents: creditResult.appliedCents,
    creditAllocations: creditResult.allocations,
    totalDueCents,
    wireDigest
  };
}

export function buildDailyWindowInvoices({
  accountId,
  currency = 'USD',
  timeZone = DEFAULT_TIME_ZONE,
  anchorHourLocal = 0,
  rangeStartUtcMs,
  rangeEndUtcMs,
  events = [],
  metricTiers = {},
  grants = []
} = {}) {
  const windows = enumerateDailyWindows(rangeStartUtcMs, rangeEndUtcMs, timeZone, anchorHourLocal);
  let rollingGrants = grants.map((g) => ({ ...g }));
  const invoices = [];

  for (const win of windows) {
    const byMetric = new Map();
    for (const evt of events) {
      if (evt.timestampMs < rangeStartUtcMs || evt.timestampMs >= rangeEndUtcMs) continue;
      if (evt.timestampMs >= win.startUtcMs && evt.timestampMs < win.endUtcMs) {
        byMetric.set(evt.metric, (byMetric.get(evt.metric) || 0) + Number(evt.units || 0));
      }
    }
    const usageRows = [...byMetric.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((metric) => ({
        metric,
        units: byMetric.get(metric),
        tiers: metricTiers[metric] || [{ upTo: null, unitRateCents: 0 }]
      }));

    const inv = buildInvoice({
      invoiceId: `${accountId}:${win.localDate}`,
      accountId,
      currency,
      usageRows,
      grants: rollingGrants,
      asOfMs: win.startUtcMs
    });
    rollingGrants = applyCredits(inv.usageSubtotalCents, rollingGrants, win.startUtcMs).updatedGrants;
    invoices.push({ ...inv, window: win });
  }

  return invoices;
}
