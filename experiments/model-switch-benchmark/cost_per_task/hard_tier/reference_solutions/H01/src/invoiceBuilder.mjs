import { DEFAULT_TIME_ZONE, INVOICE_STATUS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import { getMonthlyCycleBounds } from './clock.mjs';
import {
  computeGraduatedCharge,
  computeProratedGraduatedCharge,
  roundHalfToEvenBigInt
} from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';

/**
 * Builds an invoice from usage rows and credit grants.
 *
 * @param {object} params
 * @returns {object}
 */
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

/**
 * Builds a DST-aware, sub-period prorated monthly cycle invoice.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildProratedCycleInvoice({
  invoiceId,
  accountId,
  currency = 'USD',
  year,
  month,
  anchorDay,
  timeZone = DEFAULT_TIME_ZONE,
  anchorHourLocal = 0,
  planChanges = [],
  events = [],
  grants = []
} = {}) {
  if (!Array.isArray(planChanges) || planChanges.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'planChanges must be a non-empty array');
  }
  if (!Array.isArray(events) || !Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'events and grants must be arrays');
  }

  const cycle = getMonthlyCycleBounds({ year, month, anchorDay, timeZone, anchorHourLocal });
  const cycleMs = cycle.endUtcMs - cycle.startUtcMs;

  let prevTs = -Infinity;
  for (const change of planChanges) {
    if (
      !change ||
      typeof change !== 'object' ||
      !Number.isFinite(change.effectiveAtUtcMs) ||
      typeof change.planId !== 'string' ||
      change.planId.length === 0 ||
      !Number.isInteger(change.monthlyFeeCents) ||
      change.monthlyFeeCents < 0 ||
      !change.metricTiers ||
      typeof change.metricTiers !== 'object'
    ) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid planChange entry');
    }
    if (change.effectiveAtUtcMs < cycle.startUtcMs || change.effectiveAtUtcMs > cycle.endUtcMs) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'planChange effectiveAtUtcMs outside cycle bounds');
    }
    if (change.effectiveAtUtcMs < prevTs) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'planChanges must be sorted ascending by effectiveAtUtcMs');
    }
    prevTs = change.effectiveAtUtcMs;
  }

  if (planChanges[0].effectiveAtUtcMs !== cycle.startUtcMs) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'First planChange must start at cycle.startUtcMs');
  }

  // Collapse identical timestamps by keeping the last change at each timestamp.
  const effectiveChanges = [];
  for (const change of planChanges) {
    const last = effectiveChanges[effectiveChanges.length - 1];
    if (last && last.effectiveAtUtcMs === change.effectiveAtUtcMs) {
      effectiveChanges[effectiveChanges.length - 1] = change;
    } else {
      effectiveChanges.push(change);
    }
  }

  const segments = [];
  const lineItems = [];
  let usageSubtotalCents = 0;

  for (let i = 0; i < effectiveChanges.length; i += 1) {
    const change = effectiveChanges[i];
    const segStart = change.effectiveAtUtcMs;
    const segEnd = i + 1 < effectiveChanges.length ? effectiveChanges[i + 1].effectiveAtUtcMs : cycle.endUtcMs;
    if (segStart === segEnd) {
      continue;
    }

    const segmentIndex = segments.length;
    const segMs = segEnd - segStart;
    const proratedFeeCents = Number(
      roundHalfToEvenBigInt(BigInt(change.monthlyFeeCents) * BigInt(segMs), BigInt(cycleMs))
    );

    usageSubtotalCents += proratedFeeCents;
    lineItems.push({
      metric: `PLAN_FEE:${change.planId}`,
      units: 1,
      amountCents: proratedFeeCents,
      segmentIndex
    });

    const metricTotals = new Map();
    for (const evt of events) {
      if (!evt || typeof evt !== 'object') {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Invalid usage event');
      }
      if (evt.timestampMs >= segStart && evt.timestampMs < segEnd) {
        if (typeof evt.metric !== 'string' || !Number.isFinite(evt.units) || evt.units < 0) {
          throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'Event units must be >= 0');
        }
        metricTotals.set(evt.metric, (metricTotals.get(evt.metric) || 0) + evt.units);
      }
    }

    const sortedMetrics = Array.from(metricTotals.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const metric of sortedMetrics) {
      const totalUnits = metricTotals.get(metric);
      const tiers = change.metricTiers[metric];
      const charge = computeProratedGraduatedCharge(totalUnits, tiers, segMs, cycleMs);
      usageSubtotalCents += charge.totalCents;
      lineItems.push({
        metric,
        units: totalUnits,
        amountCents: charge.totalCents,
        segmentIndex
      });
    }

    segments.push({
      segmentIndex,
      planId: change.planId,
      startUtcMs: segStart,
      endUtcMs: segEnd,
      durationMs: segMs,
      proratedFeeCents
    });
  }

  const creditResult = applyCredits(usageSubtotalCents, grants, cycle.endUtcMs);
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
    cycle,
    segments,
    lineItems,
    usageSubtotalCents,
    appliedCreditsCents: creditResult.appliedCents,
    creditAllocations: creditResult.allocations,
    totalDueCents,
    wireDigest
  };
}
