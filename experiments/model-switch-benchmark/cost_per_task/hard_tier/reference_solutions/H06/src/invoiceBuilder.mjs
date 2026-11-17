import { DEFAULT_TIME_ZONE, INVOICE_STATUS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import { getMonthlyCycleBounds } from './clock.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { compileFilter } from './queryDsl.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';

/**
 * Builds an invoice from usage rows and credit grants.
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
 * Creates a closed-period billing ledger supporting retroactive amendments
 * with chronological credit re-waterfalling and immutable original wire digests.
 */
export function createClosedPeriodLedger({
  accountId,
  currency = 'USD',
  timeZone = DEFAULT_TIME_ZONE,
  anchorHourLocal = 0,
  grants = [],
  metricTiers = {}
} = {}) {
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'accountId must be non-empty string');
  }
  if (!Array.isArray(grants) || !metricTiers || typeof metricTiers !== 'object') {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be array and metricTiers object');
  }

  const initialGrants = structuredClone(grants);
  const tiersByMetric = structuredClone(metricTiers);
  let periods = [];
  const memos = [];
  let amendmentSeq = 0;
  let remainingGrants = structuredClone(initialGrants);

  function simulatePeriods(trialPeriods) {
    let pool = structuredClone(initialGrants);
    const snapshots = [];

    for (const p of trialPeriods) {
      const metricTotals = new Map();
      for (const evt of p.rawEvents) {
        metricTotals.set(evt.metric, (metricTotals.get(evt.metric) || 0) + evt.units);
      }
      for (const adj of p.adjustments) {
        metricTotals.set(adj.metric, (metricTotals.get(adj.metric) || 0) + adj.units);
      }
      for (const [, netUnits] of metricTotals.entries()) {
        if (netUnits < 0) {
          throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'Amended metric units cannot be negative');
        }
      }

      const sortedMetrics = Array.from(metricTotals.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const lineItems = [];
      let usageSubtotalCents = 0;
      for (const metric of sortedMetrics) {
        const netUnits = metricTotals.get(metric);
        const { totalCents } = computeGraduatedCharge(netUnits, tiersByMetric[metric]);
        usageSubtotalCents += totalCents;
        lineItems.push({ metric, units: netUnits, amountCents: totalCents });
      }

      const creditResult = applyCredits(usageSubtotalCents, pool, p.cycle.endUtcMs);
      pool = creditResult.updatedGrants;
      snapshots.push({
        periodKey: p.periodKey,
        lineItems,
        effectiveUsageSubtotalCents: usageSubtotalCents,
        effectiveAppliedCreditsCents: creditResult.appliedCents,
        creditAllocations: creditResult.allocations,
        effectiveTotalDueCents: creditResult.remainingChargeCents
      });
    }

    return { snapshots, remainingGrants: pool };
  }

  function closePeriod({ periodKey, year, month, anchorDay, invoiceId = `inv-${periodKey}`, events = [] } = {}) {
    if (typeof periodKey !== 'string' || periodKey.length === 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'periodKey must be non-empty string');
    }
    if (periods.some((p) => p.periodKey === periodKey)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Duplicate periodKey: ${periodKey}`);
    }
    if (!Array.isArray(events)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'events must be an array');
    }

    const cycle = getMonthlyCycleBounds({ year, month, anchorDay, timeZone, anchorHourLocal });
    const prev = periods[periods.length - 1];
    if (prev && cycle.startUtcMs < prev.cycle.endUtcMs) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Periods must be closed in chronological order');
    }

    const rawEvents = [];
    for (const evt of events) {
      if (!evt || typeof evt !== 'object' || typeof evt.metric !== 'string' || !Number.isFinite(evt.units) || evt.units < 0) {
        throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'Invalid event units');
      }
      if (!Number.isFinite(evt.timestampMs)) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Event must include finite timestampMs');
      }
      if (evt.timestampMs >= cycle.startUtcMs && evt.timestampMs < cycle.endUtcMs) {
        rawEvents.push(structuredClone(evt));
      }
    }

    const metricTotals = new Map();
    for (const evt of rawEvents) {
      metricTotals.set(evt.metric, (metricTotals.get(evt.metric) || 0) + evt.units);
    }
    const sortedMetrics = Array.from(metricTotals.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lineItems = [];
    let usageSubtotalCents = 0;
    for (const metric of sortedMetrics) {
      const units = metricTotals.get(metric);
      const { totalCents } = computeGraduatedCharge(units, tiersByMetric[metric]);
      usageSubtotalCents += totalCents;
      lineItems.push({ metric, units, amountCents: totalCents });
    }

    const creditResult = applyCredits(usageSubtotalCents, remainingGrants, cycle.endUtcMs);
    const totalDueCents = creditResult.remainingChargeCents;
    const status = INVOICE_STATUS.FINALIZED;
    const wireDigest = encodeFrozenWireDigest({
      invoiceId,
      accountId,
      currency,
      totalDueCents,
      status
    });

    const originalInvoice = {
      periodKey,
      invoiceId,
      accountId,
      currency,
      status,
      cycle,
      lineItems,
      usageSubtotalCents,
      appliedCreditsCents: creditResult.appliedCents,
      creditAllocations: creditResult.allocations,
      totalDueCents,
      wireDigest
    };

    periods.push({
      periodKey,
      cycle,
      originalInvoice,
      rawEvents,
      adjustments: [],
      effectiveUsageSubtotalCents: usageSubtotalCents,
      effectiveAppliedCreditsCents: creditResult.appliedCents,
      effectiveTotalDueCents: totalDueCents
    });
    remainingGrants = creditResult.updatedGrants;

    return structuredClone(originalInvoice);
  }

  function applyRetroactiveAmendment({ amendmentId, targetPeriodKey, op, events = [], filterExpr = null } = {}) {
    if (typeof amendmentId !== 'string' || amendmentId.length === 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'amendmentId must be non-empty string');
    }
    const targetIdx = periods.findIndex((p) => p.periodKey === targetPeriodKey);
    if (targetIdx === -1) {
      throw new LedgerError(ERROR_CODES.ERR_UNKNOWN_INVOICE, `Unknown closed period: ${targetPeriodKey}`);
    }
    if (!['ADD', 'SUBTRACT', 'VOID_MATCHING'].includes(op)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Invalid amendment op: ${op}`);
    }

    const trialPeriods = structuredClone(periods);
    const targetPeriod = trialPeriods[targetIdx];

    if (op === 'ADD') {
      if (!Array.isArray(events)) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'ADD events must be an array');
      }
      for (const evt of events) {
        if (!evt || typeof evt.metric !== 'string' || !Number.isFinite(evt.units) || evt.units < 0) {
          throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'ADD event units must be >= 0');
        }
        targetPeriod.rawEvents.push(structuredClone(evt));
      }
    } else if (op === 'SUBTRACT') {
      if (!Array.isArray(events)) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'SUBTRACT events must be an array');
      }
      for (const evt of events) {
        if (!evt || typeof evt.metric !== 'string' || !Number.isFinite(evt.units) || evt.units < 0) {
          throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'SUBTRACT event units must be >= 0');
        }
        targetPeriod.adjustments.push({ metric: evt.metric, units: -evt.units });
      }
    } else {
      const pred = compileFilter(filterExpr);
      targetPeriod.rawEvents = targetPeriod.rawEvents.filter((evt) => !pred(evt));
    }

    const sim = simulatePeriods(trialPeriods);
    const nextSeq = amendmentSeq + 1;
    const emittedMemos = [];

    for (let i = targetIdx; i < trialPeriods.length; i += 1) {
      const prevPeriod = periods[i];
      const nextSnap = sim.snapshots[i];
      const deltaDueCents = (nextSnap.effectiveTotalDueCents - prevPeriod.effectiveTotalDueCents) || 0;
      const deltaCreditsCents = (nextSnap.effectiveAppliedCreditsCents - prevPeriod.effectiveAppliedCreditsCents) || 0;

      if (deltaDueCents !== 0 || deltaCreditsCents !== 0) {
        const type =
          deltaDueCents < 0 ? 'CREDIT_MEMO' : deltaDueCents > 0 ? 'DEBIT_MEMO' : 'REALLOCATION_MEMO';
        const memoId = `${prevPeriod.originalInvoice.invoiceId}:amend:${nextSeq}`;
        const memoWireDigest = encodeFrozenWireDigest({
          invoiceId: memoId,
          accountId,
          currency,
          totalDueCents: deltaDueCents,
          status: INVOICE_STATUS.FINALIZED
        });
        emittedMemos.push({
          memoId,
          amendmentId,
          periodKey: prevPeriod.periodKey,
          type,
          deltaDueCents,
          deltaCreditsCents,
          effectiveTotalDueCents: nextSnap.effectiveTotalDueCents,
          effectiveAppliedCreditsCents: nextSnap.effectiveAppliedCreditsCents,
          memoWireDigest
        });
      }

      trialPeriods[i].effectiveUsageSubtotalCents = nextSnap.effectiveUsageSubtotalCents;
      trialPeriods[i].effectiveAppliedCreditsCents = nextSnap.effectiveAppliedCreditsCents;
      trialPeriods[i].effectiveTotalDueCents = nextSnap.effectiveTotalDueCents;
    }

    periods = trialPeriods;
    remainingGrants = sim.remainingGrants;
    amendmentSeq = nextSeq;
    memos.push(...emittedMemos);

    return structuredClone({
      amendmentId,
      amendmentSeq,
      memos: emittedMemos
    });
  }

  function getEffectiveLedgerSummary() {
    const effectiveByPeriod = {};
    for (const p of periods) {
      effectiveByPeriod[p.periodKey] = {
        effectiveUsageSubtotalCents: p.effectiveUsageSubtotalCents,
        effectiveAppliedCreditsCents: p.effectiveAppliedCreditsCents,
        effectiveTotalDueCents: p.effectiveTotalDueCents
      };
    }
    return structuredClone({
      closedInvoices: periods.map((p) => p.originalInvoice),
      memos,
      effectiveByPeriod,
      remainingGrants
    });
  }

  return {
    closePeriod,
    applyRetroactiveAmendment,
    getEffectiveLedgerSummary
  };
}
