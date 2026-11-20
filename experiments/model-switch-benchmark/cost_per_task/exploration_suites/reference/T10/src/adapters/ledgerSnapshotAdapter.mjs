/**
 * Normalizes and canonically orders ledger snapshot entries for deterministic reconciliation.
 */
export function buildCanonicalLedgerRows(entries = []) {
  if (!Array.isArray(entries)) return [];
  return [...entries].sort((a, b) => {
    const tDiff = Number(a?.postedAtMs || 0) - Number(b?.postedAtMs || 0);
    if (tDiff !== 0) return tDiff;
    const invA = String(a?.invoiceId || '');
    const invB = String(b?.invoiceId || '');
    if (invA !== invB) return invA < invB ? -1 : 1;
    const idA = String(a?.entryId || '');
    const idB = String(b?.entryId || '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}
