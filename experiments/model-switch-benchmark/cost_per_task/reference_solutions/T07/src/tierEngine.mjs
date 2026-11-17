import { ERROR_CODES, LedgerError } from './errors.mjs';

function normalizeAndSortTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tiers must be a non-empty array');
  }
  let unboundedCount = 0;
  const seenCaps = new Set();
  const cloned = tiers.map((t, idx) => {
    if (!t || typeof t !== 'object') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, `Invalid tier at index ${idx}`);
    }
    const rate = t.unitRateCents;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, `Invalid unitRateCents at index ${idx}`);
    }
    const isUnbounded = t.upTo === null || t.upTo === undefined || t.upTo === Infinity;
    if (isUnbounded) {
      unboundedCount += 1;
      if (unboundedCount > 1) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'At most one unbounded tier is allowed');
      }
      return { upTo: Infinity, unitRateCents: rate };
    }
    if (typeof t.upTo !== 'number' || !Number.isInteger(t.upTo) || t.upTo <= 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, `Invalid finite upTo at index ${idx}`);
    }
    if (seenCaps.has(t.upTo)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, `Duplicate tier upTo: ${t.upTo}`);
    }
    seenCaps.add(t.upTo);
    return { upTo: t.upTo, unitRateCents: rate };
  });

  cloned.sort((a, b) => a.upTo - b.upTo);
  return cloned;
}

/**
 * Computes graduated (marginal/tiered) usage charges.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 */
export function computeGraduatedCharge(units, tiers) {
  const sorted = normalizeAndSortTiers(tiers);
  if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be a finite number >= 0');
  }
  if (units === 0) {
    return { totalCents: 0, breakdown: [] };
  }

  let prevUpTo = 0;
  let totalCents = 0;
  const breakdown = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const tier = sorted[i];
    if (units <= prevUpTo) break;
    const bounded = Math.min(units, tier.upTo);
    const bandUnits = bounded - prevUpTo;
    if (bandUnits <= 0) continue;
    const subtotalCents = Math.round(bandUnits * tier.unitRateCents);
    totalCents += subtotalCents;
    breakdown.push({
      tierIndex: i,
      upTo: tier.upTo === Infinity ? null : tier.upTo,
      units: bandUnits,
      unitRateCents: tier.unitRateCents,
      subtotalCents
    });
    if (tier.upTo === Infinity) break;
    prevUpTo = tier.upTo;
  }

  return { totalCents, breakdown };
}

/**
 * Computes volume (all-units-at-matched-tier-rate) usage charges.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 */
export function computeVolumeCharge(units, tiers) {
  const sorted = normalizeAndSortTiers(tiers);
  if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be >= 0');
  }
  if (units === 0) {
    return { totalCents: 0, matchedTierIndex: 0, unitRateCents: sorted[0].unitRateCents };
  }

  for (let i = 0; i < sorted.length; i += 1) {
    if (units <= sorted[i].upTo) {
      return {
        totalCents: Math.round(units * sorted[i].unitRateCents),
        matchedTierIndex: i,
        unitRateCents: sorted[i].unitRateCents
      };
    }
  }
  const lastIdx = sorted.length - 1;
  return {
    totalCents: Math.round(units * sorted[lastIdx].unitRateCents),
    matchedTierIndex: lastIdx,
    unitRateCents: sorted[lastIdx].unitRateCents
  };
}
