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
 * Applies available credit grants without mutating caller inputs.
 */
export function applyCredits(chargeCents, grants = [], asOfMs = 0) {
  if (typeof chargeCents !== 'number' || !Number.isFinite(chargeCents) || chargeCents < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'chargeCents must be >= 0');
  }
  if (typeof asOfMs !== 'number' || !Number.isFinite(asOfMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'asOfMs must be finite');
  }
  if (!Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be an array');
  }

  const updatedGrants = grants.map((g) => ({ ...g }));
  if (chargeCents === 0) {
    return { appliedCents: 0, remainingChargeCents: 0, allocations: [], updatedGrants };
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

  return { appliedCents, remainingChargeCents: remaining, allocations, updatedGrants };
}

export function summarizePoolBalance(grants = [], asOfMs = 0) {
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

export function restoreGrantAllocations(grants = [], allocations = [], asOfMs = 0) {
  const byId = new Map(grants.map((g) => [g.grantId, g]));
  let restoredActiveCents = 0;
  let restoredExpiredCents = 0;
  for (const alloc of allocations) {
    const grant = byId.get(alloc.grantId);
    if (!grant) continue;
    grant.remainingCents += alloc.appliedCents;
    if (asOfMs < grant.expiresAtMs) {
      restoredActiveCents += alloc.appliedCents;
    } else {
      restoredExpiredCents += alloc.appliedCents;
    }
  }
  return { restoredActiveCents, restoredExpiredCents };
}
