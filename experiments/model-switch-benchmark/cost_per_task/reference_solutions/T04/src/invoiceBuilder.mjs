import { INVOICE_STATUS, MAX_BPS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';

/**
 * Builds an invoice from usage rows, credit grants, optional minimum commitment, and tax.
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
  asOfMs = 0,
  minimumCommitCents = 0,
  creditsEligibleForTrueUp = true,
  taxBps = 0
} = {}) {
  if (typeof minimumCommitCents !== 'number' || !Number.isFinite(minimumCommitCents) || minimumCommitCents < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'minimumCommitCents must be >= 0');
  }
  if (typeof taxBps !== 'number' || !Number.isFinite(taxBps) || !Number.isInteger(taxBps) || taxBps < 0 || taxBps > MAX_BPS) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `taxBps must be an integer between 0 and ${MAX_BPS}`);
  }

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

  const trueUpCents = minimumCommitCents > usageSubtotalCents ? minimumCommitCents - usageSubtotalCents : 0;
  if (trueUpCents > 0) {
    lineItems.push({
      metric: 'COMMIT_TRUE_UP',
      units: 1,
      amountCents: trueUpCents
    });
  }

  const preCreditSubtotalCents = usageSubtotalCents + trueUpCents;
  const creditTargetCents = creditsEligibleForTrueUp ? preCreditSubtotalCents : usageSubtotalCents;
  const creditResult = applyCredits(creditTargetCents, grants, asOfMs);
  const netAfterCreditsCents = preCreditSubtotalCents - creditResult.appliedCents;
  const taxCents = Math.round((netAfterCreditsCents * taxBps) / MAX_BPS);
  const totalDueCents = netAfterCreditsCents + taxCents;
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
    trueUpCents,
    preCreditSubtotalCents,
    appliedCreditsCents: creditResult.appliedCents,
    creditAllocations: creditResult.allocations,
    netAfterCreditsCents,
    taxCents,
    totalDueCents,
    wireDigest
  };
}
