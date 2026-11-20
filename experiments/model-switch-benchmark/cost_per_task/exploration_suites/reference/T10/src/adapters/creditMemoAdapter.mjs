import { ERROR_CODES, LedgerError } from '../errors.mjs';

/**
 * Normalizes credit/refund/debit memos into signed adjustment entries against gross settlement.
 * Refer to docs/runbooks/SETTLEMENT_RECONCILIATION_RUNBOOK.md.
 */
export function normalizeCreditMemos(memos = [], asOfMs = 0) {
  if (!Array.isArray(memos)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'memos must be an array');
  }
  const normalized = [];
  for (const m of memos) {
    if (!m || !m.invoiceId) continue;
    if (m.expiresAtMs !== null && m.expiresAtMs !== undefined && Number(asOfMs) >= Number(m.expiresAtMs)) {
      continue;
    }
    const mag = Math.abs(Math.trunc(Number(m.amountCents || 0)));
    const kind = String(m.kind || 'CREDIT_NOTE').toUpperCase();
    const signedDeltaCents = kind === 'DEBIT_MEMO' ? mag : -mag;
    normalized.push({
      memoId: String(m.memoId || ''),
      invoiceId: String(m.invoiceId),
      kind,
      currency: String(m.currency || 'USD').toUpperCase(),
      signedDeltaCents,
      issuedAtMs: Number(m.issuedAtMs || 0),
      expiresAtMs: m.expiresAtMs ?? null,
      asOfMsChecked: asOfMs
    });
  }
  return normalized;
}
