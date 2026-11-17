import { INVOICE_STATUS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits, restoreGrantAllocations, summarizePoolBalance } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';

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

export function createSettlementRegistry(initialGrants = []) {
  return {
    grants: initialGrants.map((g) => ({ ...g })),
    invoices: new Map()
  };
}

export function settleInvoice(registry, invoiceParams = {}) {
  const invoice = buildInvoice({
    ...invoiceParams,
    grants: registry.grants
  });
  const afterCredits = applyCredits(invoice.usageSubtotalCents, registry.grants, invoiceParams.asOfMs ?? 0);
  registry.grants = afterCredits.updatedGrants;
  const stored = structuredClone(invoice);
  registry.invoices.set(stored.invoiceId, stored);
  return structuredClone(stored);
}

export function voidInvoiceSettlement(registry, invoiceId, voidedAtMs) {
  const invoice = registry.invoices.get(invoiceId);
  if (!invoice) {
    throw new LedgerError(ERROR_CODES.ERR_UNKNOWN_INVOICE, `Unknown invoice: ${invoiceId}`);
  }
  if (invoice.status === INVOICE_STATUS.VOIDED) {
    throw new LedgerError(ERROR_CODES.ERR_ALREADY_VOIDED, `Invoice already voided: ${invoiceId}`);
  }
  invoice.status = INVOICE_STATUS.VOIDED;
  invoice.voidedAtMs = voidedAtMs;

  const { restoredActiveCents, restoredExpiredCents } = restoreGrantAllocations(
    registry.grants,
    invoice.creditAllocations || [],
    voidedAtMs
  );
  const reversalWireDigest = encodeFrozenWireDigest({
    invoiceId: invoice.invoiceId,
    accountId: invoice.accountId,
    currency: invoice.currency,
    totalDueCents: invoice.totalDueCents,
    status: INVOICE_STATUS.VOIDED
  });

  return {
    invoiceId: invoice.invoiceId,
    status: INVOICE_STATUS.VOIDED,
    voidedAtMs,
    netDeltaCents: invoice.totalDueCents === 0 ? 0 : -invoice.totalDueCents,
    restoredActiveCents,
    restoredExpiredCents,
    reversalWireDigest
  };
}

export function getRegistrySnapshot(registry, asOfMs = 0) {
  return {
    invoices: [...registry.invoices.values()].map((i) => structuredClone(i)),
    grants: registry.grants.map((g) => ({ ...g })),
    poolBalance: summarizePoolBalance(registry.grants, asOfMs)
  };
}
