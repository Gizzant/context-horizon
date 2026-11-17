import { ERROR_CODES, LedgerError } from './errors.mjs';
import { roundHalfToEvenBigInt } from './fxConverter.mjs';

function normalizeTiers(tiers, requireMicrosCompatible = false) {
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

    let unitRateMicros = 0;
    let unitRateCents = 0;
    if (tier.unitRateMicros !== undefined) {
      if (!Number.isSafeInteger(tier.unitRateMicros) || tier.unitRateMicros < 0) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'unitRateMicros must be non-negative integer');
      }
      unitRateMicros = tier.unitRateMicros;
      unitRateCents = tier.unitRateMicros / 1_000_000;
    } else if (Number.isFinite(tier.unitRateCents) && tier.unitRateCents >= 0) {
      unitRateCents = tier.unitRateCents;
      unitRateMicros = Math.round(tier.unitRateCents * 1_000_000);
    } else if (requireMicrosCompatible || true) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tier must specify non-negative rate');
    }

    return { cap, unitRateCents, unitRateMicros };
  });

  normalized.sort((a, b) => a.cap - b.cap);
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i].cap === normalized[i - 1].cap) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'duplicate tier boundaries are invalid');
    }
  }
  return normalized;
}

/**
 * Computes graduated (marginal/tiered) usage charges.
 */
export function computeGraduatedCharge(units, tiers) {
  const sortedTiers = normalizeTiers(tiers);
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

/**
 * Computes graduated charge in micro-cents summing exact BigInt micros across tiers
 * and applying a single final half-to-even rounding to minor units.
 */
export function computeMicroTierCharge(units, tiers) {
  const sortedTiers = normalizeTiers(tiers, true);
  if (!Number.isInteger(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be non-negative integer');
  }
  if (units === 0) {
    return { totalCents: 0, breakdown: [] };
  }

  let prevUpTo = 0;
  let totalMicros = 0n;
  const breakdown = [];

  for (let i = 0; i < sortedTiers.length; i += 1) {
    const tier = sortedTiers[i];
    if (units <= prevUpTo) break;
    const bounded = Math.min(units, tier.cap);
    const bandUnits = Math.max(0, bounded - prevUpTo);
    const bandMicros = BigInt(bandUnits) * BigInt(tier.unitRateMicros);
    totalMicros += bandMicros;
    breakdown.push({
      tierIndex: i,
      upTo: tier.cap === Infinity ? null : tier.cap,
      units: bandUnits,
      unitRateMicros: tier.unitRateMicros,
      subtotalMicros: Number(bandMicros)
    });
    if (tier.cap === Infinity) break;
    prevUpTo = tier.cap;
  }

  const totalCents = Number(roundHalfToEvenBigInt(totalMicros, 1_000_000n));
  return { totalCents, breakdown };
}

/**
 * Computes volume (all-units-at-matched-tier-rate) usage charges.
 */
export function computeVolumeCharge(units, tiers) {
  const sortedTiers = normalizeTiers(tiers);
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
