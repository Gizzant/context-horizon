import { ERROR_CODES, LedgerError } from './errors.mjs';

function normalizeAndValidateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tiers must be a non-empty array');
  }
  const normalized = tiers.map((tier) => {
    if (!tier || typeof tier !== 'object') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tier must be an object');
    }
    const isUnbounded = tier.upTo === null || tier.upTo === undefined || tier.upTo === Infinity;
    const cap = isUnbounded ? Infinity : tier.upTo;
    if (cap !== Infinity && (!Number.isFinite(cap) || cap <= 0)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'finite tier upTo must be > 0');
    }
    if (!Number.isFinite(tier.unitRateCents) || tier.unitRateCents < 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'unitRateCents must be >= 0');
    }
    return { cap, unitRateCents: tier.unitRateCents };
  });

  normalized.sort((a, b) => a.cap - b.cap);
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i].cap === normalized[i - 1].cap) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'duplicate tier boundaries are invalid');
    }
  }
  return normalized;
}

export function computeGraduatedCharge(units, tiers) {
  const sortedTiers = normalizeAndValidateTiers(tiers);
  if (!Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be >= 0');
  }
  if (units === 0) {
    return { totalCents: 0, breakdown: [] };
  }

  let prevUpTo = 0;
  let totalCents = 0;
  const breakdown = [];

  for (let i = 0; i < sortedTiers.length; i += 1) {
    const tier = sortedTiers[i];
    if (units <= prevUpTo) break;
    const bounded = Math.min(units, tier.cap);
    const bandUnits = Math.max(0, bounded - prevUpTo);
    const subtotalCents = Math.round(bandUnits * tier.unitRateCents);
    totalCents += subtotalCents;
    breakdown.push({
      tierIndex: i,
      upTo: tier.cap === Infinity ? null : tier.cap,
      units: bandUnits,
      unitRateCents: tier.unitRateCents,
      subtotalCents
    });
    if (tier.cap === Infinity) break;
    prevUpTo = tier.cap;
  }

  return { totalCents, breakdown };
}

export function computeVolumeCharge(units, tiers) {
  const sortedTiers = normalizeAndValidateTiers(tiers);
  if (!Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be >= 0');
  }
  if (units === 0) {
    return { totalCents: 0, matchedTierIndex: 0, unitRateCents: sortedTiers[0].unitRateCents };
  }

  for (let i = 0; i < sortedTiers.length; i += 1) {
    if (units <= sortedTiers[i].cap) {
      return {
        totalCents: Math.round(units * sortedTiers[i].unitRateCents),
        matchedTierIndex: i,
        unitRateCents: sortedTiers[i].unitRateCents
      };
    }
  }
  const lastIdx = sortedTiers.length - 1;
  return {
    totalCents: Math.round(units * sortedTiers[lastIdx].unitRateCents),
    matchedTierIndex: lastIdx,
    unitRateCents: sortedTiers[lastIdx].unitRateCents
  };
}
