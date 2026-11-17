import { ERROR_CODES, LedgerError } from './errors.mjs';

function isGrantActive(grant, asOfMs) {
  return Boolean(
    grant &&
    Number.isFinite(grant.remainingCents) &&
    grant.remainingCents > 0 &&
    Number.isFinite(grant.effectiveFromMs) &&
    Number.isFinite(grant.expiresAtMs) &&
    grant.effectiveFromMs <= asOfMs &&
    asOfMs < grant.expiresAtMs
  );
}

export function applyCredits(chargeCents, grants = [], asOfMs = 0) {
  if (!Number.isFinite(chargeCents) || chargeCents < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'chargeCents must be finite and >= 0');
  }
  if (!Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be an array');
  }
  if (!Number.isFinite(asOfMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'asOfMs must be finite');
  }

  const updatedGrants = grants.map((g) => (g && typeof g === 'object' ? { ...g } : g));
  const eligible = updatedGrants
    .filter((g) => isGrantActive(g, asOfMs))
    .sort((a, b) => {
      if (a.expiresAtMs !== b.expiresAtMs) return a.expiresAtMs - b.expiresAtMs;
      const idA = String(a.grantId ?? '');
      const idB = String(b.grantId ?? '');
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });

  let remaining = chargeCents;
  let appliedCents = 0;
  const allocations = [];

  for (const grant of eligible) {
    if (remaining <= 0) break;
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
    updatedGrants
  };
}

export function summarizePoolBalance(grants = [], asOfMs = 0) {
  if (!Array.isArray(grants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'grants must be an array');
  }
  if (!Number.isFinite(asOfMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'asOfMs must be finite');
  }
  let availableCents = 0;
  let activeCount = 0;
  for (const g of grants) {
    if (isGrantActive(g, asOfMs)) {
      availableCents += g.remainingCents;
      activeCount += 1;
    }
  }
  return { availableCents, activeCount, asOfMs };
}
