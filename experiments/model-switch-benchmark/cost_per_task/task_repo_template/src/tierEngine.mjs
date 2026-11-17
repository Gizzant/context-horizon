import { ERROR_CODES, LedgerError } from './errors.mjs';

/**
 * Computes graduated (marginal/tiered) usage charges.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 * @returns {{ totalCents: number, breakdown: Array<{ tierIndex: number, upTo: number | null, units: number, unitRateCents: number, subtotalCents: number }> }}
 */
export function computeGraduatedCharge(units, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tiers must be a non-empty array');
  }
  if (!Number.isFinite(units) || units < 0) {
    return { totalCents: 0, breakdown: [] };
  }

  let prevUpTo = 0;
  let totalCents = 0;
  const breakdown = [];

  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    const cap = tier.upTo === null || tier.upTo === undefined || tier.upTo === Infinity ? Infinity : tier.upTo;
    if (units <= prevUpTo && i > 0) break;

    const bounded = Math.min(units, cap);
    const bandUnits = Math.max(0, bounded - prevUpTo + (prevUpTo > 0 ? 1 : 0));
    const subtotalCents = Math.floor(bandUnits * tier.unitRateCents);
    totalCents += subtotalCents;
    breakdown.push({
      tierIndex: i,
      upTo: cap === Infinity ? null : cap,
      units: bandUnits,
      unitRateCents: tier.unitRateCents,
      subtotalCents
    });
    if (cap === Infinity) break;
    prevUpTo = cap;
  }

  return { totalCents, breakdown };
}

/**
 * Computes volume (all-units-at-matched-tier-rate) usage charges.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 * @returns {{ totalCents: number, matchedTierIndex: number, unitRateCents: number }}
 */
export function computeVolumeCharge(units, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tiers must be a non-empty array');
  }
  if (!Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be >= 0');
  }
  if (units === 0) {
    return { totalCents: 0, matchedTierIndex: 0, unitRateCents: tiers[0].unitRateCents };
  }

  for (let i = 0; i < tiers.length; i += 1) {
    const cap = tiers[i].upTo === null || tiers[i].upTo === undefined ? Infinity : tiers[i].upTo;
    if (units <= cap) {
      return {
        totalCents: Math.round(units * tiers[i].unitRateCents),
        matchedTierIndex: i,
        unitRateCents: tiers[i].unitRateCents
      };
    }
  }
  const lastIdx = tiers.length - 1;
  return {
    totalCents: Math.round(units * tiers[lastIdx].unitRateCents),
    matchedTierIndex: lastIdx,
    unitRateCents: tiers[lastIdx].unitRateCents
  };
}
