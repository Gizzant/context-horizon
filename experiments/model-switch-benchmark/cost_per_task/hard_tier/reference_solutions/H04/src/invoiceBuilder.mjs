import { INVOICE_STATUS, MAX_BPS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import {
  CURRENCY_MINOR_EXPONENTS,
  convertMinorUnitsExact,
  roundHalfToEvenBigInt
} from './fxConverter.mjs';
import { computeGraduatedCharge, computeMicroTierCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
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
 * Hamilton (Largest Remainder) allocation across non-negative weights.
 * Ties on remainder break by largest weight DESC, then lowest index ASC.
 *
 * @param {number} totalDeltaMinor
 * @param {number[]} weights
 * @returns {number[]}
 */
export function allocateByLargestRemainder(totalDeltaMinor, weights) {
  if (!Number.isSafeInteger(totalDeltaMinor) || totalDeltaMinor < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'totalDeltaMinor must be non-negative integer');
  }
  if (!Array.isArray(weights)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'weights must be an array');
  }
  const weightBigs = weights.map((w) => {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'All weights must be non-negative integers');
    }
    return BigInt(w);
  });

  const totalWeight = weightBigs.reduce((sum, w) => sum + w, 0n);
  if (totalWeight === 0n) {
    if (totalDeltaMinor === 0) {
      return weights.map(() => 0);
    }
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Cannot allocate positive amount when weight sum is 0');
  }

  const totalBig = BigInt(totalDeltaMinor);
  const shares = weightBigs.map((w, idx) => {
    const product = totalBig * w;
    return {
      idx,
      weight: w,
      floorVal: Number(product / totalWeight),
      rem: product % totalWeight
    };
  });

  const allocations = shares.map((s) => s.floorVal);
  const floorSum = allocations.reduce((s, v) => s + v, 0);
  const leftover = totalDeltaMinor - floorSum;

  const ranked = [...shares].sort((a, b) => {
    if (a.rem !== b.rem) return b.rem > a.rem ? 1 : -1;
    if (a.weight !== b.weight) return b.weight > a.weight ? 1 : -1;
    return a.idx - b.idx;
  });

  for (let i = 0; i < leftover; i += 1) {
    allocations[ranked[i].idx] += 1;
  }
  return allocations;
}

/**
 * Builds a multi-currency invoice with FX triangulation, micro-rate tiering,
 * banker's rounding, and Largest-Remainder discount/tax allocation.
 */
export function buildMultiCurrencyInvoice({
  invoiceId,
  accountId,
  targetCurrency = 'USD',
  usageRows = [],
  quotes = [],
  asOfMs = 0,
  maxQuoteAgeMs = Infinity,
  discountBps = 0,
  taxBps = 0,
  grants = []
} = {}) {
  if (CURRENCY_MINOR_EXPONENTS[targetCurrency] === undefined) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Unsupported targetCurrency: ${targetCurrency}`);
  }
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > MAX_BPS) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'discountBps must be 0..10000');
  }
  if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > MAX_BPS) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'taxBps must be 0..10000');
  }
  if (!Array.isArray(usageRows) || !Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'usageRows and grants must be arrays');
  }

  const lineItems = [];
  let usageSubtotalMinor = 0;

  for (const row of usageRows) {
    const charge = computeMicroTierCharge(row.units, row.tiers);
    const fromCurrency = row.rowCurrency ?? row.currency ?? targetCurrency;
    const amountMinor = convertMinorUnitsExact({
      amountMinor: charge.totalCents,
      fromCurrency,
      toCurrency: targetCurrency,
      quotes,
      asOfMs,
      maxQuoteAgeMs
    });
    usageSubtotalMinor += amountMinor;
    lineItems.push({
      metric: row.metric,
      units: row.units,
      fromCurrency,
      originalAmountMinor: charge.totalCents,
      amountMinor,
      discountMinor: 0,
      taxMinor: 0
    });
  }

  const discountMinor = Number(
    roundHalfToEvenBigInt(BigInt(usageSubtotalMinor) * BigInt(discountBps), BigInt(MAX_BPS))
  );
  const discountShares = allocateByLargestRemainder(
    discountMinor,
    lineItems.map((l) => l.amountMinor)
  );
  for (let i = 0; i < lineItems.length; i += 1) {
    lineItems[i].discountMinor = discountShares[i];
  }

  const afterDiscountMinor = usageSubtotalMinor - discountMinor;
  const creditResult = applyCredits(afterDiscountMinor, grants, asOfMs);
  const appliedCreditsMinor = creditResult.appliedCents;
  const netAfterCreditsMinor = afterDiscountMinor - appliedCreditsMinor;

  const taxMinor = Number(
    roundHalfToEvenBigInt(BigInt(netAfterCreditsMinor) * BigInt(taxBps), BigInt(MAX_BPS))
  );
  const taxShares = allocateByLargestRemainder(
    taxMinor,
    lineItems.map((l) => l.amountMinor - l.discountMinor)
  );
  for (let i = 0; i < lineItems.length; i += 1) {
    lineItems[i].taxMinor = taxShares[i];
  }

  const totalDueMinor = netAfterCreditsMinor + taxMinor;
  const status = INVOICE_STATUS.FINALIZED;
  const wireDigest = encodeFrozenWireDigest({
    invoiceId,
    accountId,
    currency: targetCurrency,
    totalDueCents: totalDueMinor,
    status
  });

  return {
    invoiceId,
    accountId,
    currency: targetCurrency,
    status,
    lineItems,
    usageSubtotalMinor,
    discountMinor,
    appliedCreditsMinor,
    creditAllocations: creditResult.allocations,
    netAfterCreditsMinor,
    taxMinor,
    totalDueMinor,
    wireDigest
  };
}
