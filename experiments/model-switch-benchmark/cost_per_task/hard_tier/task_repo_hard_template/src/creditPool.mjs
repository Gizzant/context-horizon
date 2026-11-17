import { ERROR_CODES, LedgerError } from './errors.mjs';

/**
 * Applies available credit grants to a positive charge amount in cents.
 *
 * @param {number} chargeCents
 * @param {Array<{ grantId: string, remainingCents: number, effectiveFromMs: number, expiresAtMs: number }>} grants
 * @param {number} asOfMs
 * @returns {{ appliedCents: number, remainingChargeCents: number, allocations: Array<{ grantId: string, appliedCents: number }>, updatedGrants: Array<object> }}
 */
export function applyCredits(chargeCents, grants = [], asOfMs = 0) {
  if (!Number.isFinite(chargeCents)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'chargeCents must be finite');
  }
  if (!Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be an array');
  }

  let remaining = chargeCents;
  let appliedCents = 0;
  const allocations = [];

  for (const grant of grants) {
    if (remaining <= 0) break;
    if (!grant || grant.remainingCents <= 0) continue;
    const take = Math.min(remaining, grant.remainingCents);
    grant.remainingCents -= take;
    remaining -= take;
    appliedCents += take;
    allocations.push({ grantId: grant.grantId, appliedCents: take });
  }

  return {
    appliedCents,
    remainingChargeCents: remaining,
    allocations,
    updatedGrants: grants
  };
}

/**
 * Summarizes total remaining cents across credit grants.
 *
 * @param {Array<{ remainingCents: number, effectiveFromMs: number, expiresAtMs: number }>} grants
 * @param {number} asOfMs
 */
export function summarizePoolBalance(grants = [], asOfMs = 0) {
  let availableCents = 0;
  let activeCount = 0;
  for (const g of grants) {
    if (g && g.remainingCents > 0) {
      availableCents += g.remainingCents;
      activeCount += 1;
    }
  }
  return { availableCents, activeCount, asOfMs };
}
