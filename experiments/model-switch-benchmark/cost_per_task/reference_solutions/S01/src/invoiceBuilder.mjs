import { INVOICE_STATUS } from './constants.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
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

function escapeCsvCell(val, isNumeric = false) {
  let s = String(val ?? '');
  if (!isNumeric && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportInvoiceCsv(invoice = {}) {
  const header = 'invoiceId,accountId,currency,metric,units,amountCents,totalDueCents';
  const rows = [header];
  for (const item of invoice.lineItems || []) {
    rows.push([
      escapeCsvCell(invoice.invoiceId, false),
      escapeCsvCell(invoice.accountId, false),
      escapeCsvCell(invoice.currency || 'USD', false),
      escapeCsvCell(item.metric, false),
      escapeCsvCell(Math.trunc(Number(item.units || 0)), true),
      escapeCsvCell(Math.trunc(Number(item.amountCents || 0)), true),
      escapeCsvCell(Math.trunc(Number(invoice.totalDueCents || 0)), true)
    ].join(','));
  }
  return rows.join('\n') + '\n';
}
