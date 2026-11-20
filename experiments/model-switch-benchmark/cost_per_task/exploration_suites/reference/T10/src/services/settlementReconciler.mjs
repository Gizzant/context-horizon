import { normalizeCreditMemos } from '../adapters/creditMemoAdapter.mjs';
import { buildCanonicalLedgerRows } from '../adapters/ledgerSnapshotAdapter.mjs';
import { convertCurrencyCents, DEFAULT_USD_RATES } from '../policies/fxConversionPolicy.mjs';

function roundHalfAwayFromZero(val) {
  if (!Number.isFinite(val)) return 0;
  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);
}

function toUsdCents(amountCents, fromCurrency, usdRates) {
  const from = String(fromCurrency || 'USD').toUpperCase();
  if (from === 'USD') return Math.trunc(Number(amountCents || 0));
  const rate = Number(usdRates?.[from] ?? DEFAULT_USD_RATES[from]);
  if (!Number.isFinite(rate) || rate <= 0) {
    return convertCurrencyCents({ amountCents, fromCurrency: from, toCurrency: 'USD', usdRates }).convertedCents;
  }
  return roundHalfAwayFromZero(Number(amountCents) * rate);
}

/**
 * Reconciles settled merchant payouts against canonical ledger rows and credit memos.
 * Refer to docs/runbooks/SETTLEMENT_RECONCILIATION_RUNBOOK.md.
 */
export function reconcileSettlementBatch({
  ledgerEntries = [],
  payoutRecords = [],
  creditMemos = [],
  disputedInvoiceIds = [],
  usdRates = DEFAULT_USD_RATES,
  asOfMs = 0,
  toleranceCents = 1
} = {}) {
  const rows = buildCanonicalLedgerRows(ledgerEntries);
  const memos = normalizeCreditMemos(creditMemos, asOfMs);
  const disputedSet = new Set((Array.isArray(disputedInvoiceIds) ? disputedInvoiceIds : []).map((x) => String(x)));
  const tol = Math.max(0, Math.trunc(Number(toleranceCents ?? 1)));
  const byInvoice = new Map();

  const ensure = (id) => {
    if (!byInvoice.has(id)) {
      byInvoice.set(id, { expectedUsdCents: 0, payoutUsdCents: 0, disputed: disputedSet.has(id) });
    }
    return byInvoice.get(id);
  };
  for (const r of rows) {
    if (!r?.invoiceId) continue;
    const rec = ensure(String(r.invoiceId));
    rec.expectedUsdCents += toUsdCents(Number(r.amountCents || 0), r.currency || 'USD', usdRates);
  }
  for (const m of memos) {
    const rec = ensure(String(m.invoiceId));
    const usdMag = toUsdCents(Math.abs(m.signedDeltaCents), m.currency || 'USD', usdRates);
    rec.expectedUsdCents += m.signedDeltaCents < 0 ? -usdMag : usdMag;
  }
  for (const p of payoutRecords) {
    if (!p?.invoiceId) continue;
    const rec = ensure(String(p.invoiceId));
    rec.payoutUsdCents += toUsdCents(Number(p.amountCents || 0), p.currency || 'USD', usdRates);
  }

  const invoiceStatuses = {};
  const discrepancies = [];
  let expectedNetUsdCents = 0;
  let actualPayoutUsdCents = 0;
  let heldBackUsdCents = 0;
  for (const [invoiceId, rec] of byInvoice.entries()) {
    if (rec.disputed) {
      invoiceStatuses[invoiceId] = 'DISPUTE_HOLD';
      heldBackUsdCents += rec.expectedUsdCents;
      continue;
    }
    expectedNetUsdCents += rec.expectedUsdCents;
    actualPayoutUsdCents += rec.payoutUsdCents;
    const variance = rec.payoutUsdCents - rec.expectedUsdCents;
    if (Math.abs(variance) > tol) {
      invoiceStatuses[invoiceId] = 'DRIFT';
      discrepancies.push({
        invoiceId,
        expectedUsdCents: rec.expectedUsdCents,
        actualUsdCents: rec.payoutUsdCents,
        varianceUsdCents: variance
      });
    } else {
      invoiceStatuses[invoiceId] = 'MATCHED';
    }
  }
  return {
    reconciled: discrepancies.length === 0,
    toleranceCents: tol,
    disputedCount: disputedSet.size,
    expectedNetUsdCents,
    actualPayoutUsdCents,
    heldBackUsdCents,
    totalVarianceUsdCents: actualPayoutUsdCents - expectedNetUsdCents,
    invoiceStatuses,
    discrepancies
  };
}
