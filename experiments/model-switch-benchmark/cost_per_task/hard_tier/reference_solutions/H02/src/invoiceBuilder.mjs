import { INVOICE_STATUS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

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
 * Formats `${invoiceId}|${totalDueCents}|${memo}` in NFC within `maxBytes` UTF-8 bytes
 * without ever splitting a Unicode grapheme cluster.
 *
 * @param {{ invoiceId?: string, totalDueCents?: number, memo?: string }} invoice
 * @param {number} maxBytes
 * @returns {string}
 */
export function formatBoundedAuditEntry(invoice, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 16) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxBytes must be an integer >= 16');
  }

  const id = String(invoice?.invoiceId ?? '').normalize('NFC');
  const total = Math.trunc(Number(invoice?.totalDueCents || 0));
  const prefix = `${id}|${total}|`;
  const memo = String(invoice?.memo ?? '').normalize('NFC');
  const full = prefix + memo;

  if (Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return full;
  }

  const ellipsis = '…';
  if (Buffer.byteLength(`${prefix}${ellipsis}`, 'utf8') <= maxBytes) {
    let keptMemo = '';
    for (const { segment } of GRAPHEME_SEGMENTER.segment(memo)) {
      const candidate = `${prefix}${keptMemo}${segment}${ellipsis}`;
      if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
        keptMemo += segment;
      } else {
        break;
      }
    }
    return `${prefix}${keptMemo}${ellipsis}`;
  }

  let keptFull = '';
  for (const { segment } of GRAPHEME_SEGMENTER.segment(full)) {
    const candidate = `${keptFull}${segment}${ellipsis}`;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      keptFull += segment;
    } else {
      break;
    }
  }
  return `${keptFull}${ellipsis}`;
}
