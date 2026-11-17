import { ERROR_CODES, LedgerError } from './errors.mjs';

function isGrantEligible(grant, asOfMs) {
  return Boolean(
    grant &&
      grant.remainingCents > 0 &&
      grant.effectiveFromMs <= asOfMs &&
      asOfMs < grant.expiresAtMs
  );
}

/**
 * Applies available credit grants without mutating inputs.
 *
 * @param {number} chargeCents
 * @param {Array<{ grantId: string, remainingCents: number, effectiveFromMs: number, expiresAtMs: number }>} grants
 * @param {number} asOfMs
 */
export function applyCredits(chargeCents, grants = [], asOfMs = 0) {
  if (typeof chargeCents !== 'number' || !Number.isFinite(chargeCents) || chargeCents < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'chargeCents must be a finite number >= 0');
  }
  if (typeof asOfMs !== 'number' || !Number.isFinite(asOfMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'asOfMs must be finite');
  }
  if (!Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be an array');
  }

  const updatedGrants = grants.map((g) => ({ ...g }));
  if (chargeCents === 0) {
    return {
      appliedCents: 0,
      remainingChargeCents: 0,
      allocations: [],
      updatedGrants
    };
  }

  const eligible = updatedGrants
    .filter((g) => isGrantEligible(g, asOfMs))
    .sort((a, b) => {
      if (a.expiresAtMs !== b.expiresAtMs) return a.expiresAtMs - b.expiresAtMs;
      return a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0;
    });

  let remaining = chargeCents;
  let appliedCents = 0;
  const allocations = [];

  for (const grant of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, grant.remainingCents);
    if (take <= 0) continue;
    grant.remainingCents -= take;
    remaining -= take;
    appliedCents += take;
    allocations.push({ grantId: grant.grantId, appliedCents: take });
  }

  return {
    appliedCents,
    remainingChargeCents: remaining,
    allocations,
    updatedGrants
  };
}

/**
 * Summarizes total remaining cents across active eligible grants at `asOfMs`.
 *
 * @param {Array<{ remainingCents: number, effectiveFromMs: number, expiresAtMs: number }>} grants
 * @param {number} asOfMs
 */
export function summarizePoolBalance(grants = [], asOfMs = 0) {
  if (!Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be an array');
  }
  if (typeof asOfMs !== 'number' || !Number.isFinite(asOfMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'asOfMs must be finite');
  }
  let availableCents = 0;
  let activeCount = 0;
  for (const g of grants) {
    if (isGrantEligible(g, asOfMs)) {
      availableCents += g.remainingCents;
      activeCount += 1;
    }
  }
  return { availableCents, activeCount, asOfMs };
}
