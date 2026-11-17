import { ERROR_CODES, LedgerError } from './errors.mjs';

function normalizeAndValidateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'tiers must be a non-empty array');
  }
  const normalized = tiers.map((tier) => {
    if (!tier || typeof tier !== 'object') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TIERS, 'each tier must be an object');
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

/**
 * Exact non-negative BigInt half-to-even rounding of `numBig / denBig`.
 *
 * @param {bigint} numBig
 * @param {bigint} denBig
 * @returns {bigint}
 */
export function roundHalfToEvenBigInt(numBig, denBig) {
  if (typeof numBig !== 'bigint' || typeof denBig !== 'bigint' || numBig < 0n || denBig <= 0n) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'roundHalfToEvenBigInt requires numBig >= 0n and denBig > 0n');
  }
  const quotient = numBig / denBig;
  const remainder = numBig % denBig;
  const twiceRem = remainder * 2n;
  if (twiceRem > denBig) return quotient + 1n;
  if (twiceRem < denBig) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Computes graduated (marginal/tiered) usage charges.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 * @returns {{ totalCents: number, breakdown: Array<{ tierIndex: number, upTo: number | null, units: number, unitRateCents: number, subtotalCents: number }> }}
 */
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
    const subtotalCents = bandUnits * tier.unitRateCents;
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
 * Computes graduated charge with tier boundaries prorated by `numMs / denMs` via BigInt half-to-even rounding.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 * @param {number} numMs
 * @param {number} denMs
 */
export function computeProratedGraduatedCharge(units, tiers, numMs, denMs) {
  const sortedTiers = normalizeAndValidateTiers(tiers);
  if (!Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'units must be >= 0');
  }
  if (!Number.isInteger(numMs) || numMs < 0 || !Number.isInteger(denMs) || denMs <= 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'numMs must be integer >= 0 and denMs integer > 0');
  }

  const numBig = BigInt(numMs);
  const denBig = BigInt(denMs);

  const scaledTiers = [];
  let prevFiniteCap = 0;
  let seenUnbounded = false;

  for (const tier of sortedTiers) {
    if (tier.cap === Infinity) {
      if (!seenUnbounded) {
        scaledTiers.push({ upTo: null, unitRateCents: tier.unitRateCents });
        seenUnbounded = true;
      }
      continue;
    }
    const scaledCap = Number(roundHalfToEvenBigInt(BigInt(Math.round(tier.cap)) * numBig, denBig));
    // Drop 0-width bands (scaledCap <= 0 or duplicate collapsed cap).
    if (scaledCap <= prevFiniteCap) {
      continue;
    }
    scaledTiers.push({ upTo: scaledCap, unitRateCents: tier.unitRateCents });
    prevFiniteCap = scaledCap;
  }

  if (scaledTiers.length === 0) {
    return { totalCents: 0, breakdown: [] };
  }
  return computeGraduatedCharge(units, scaledTiers);
}

/**
 * Computes volume (all-units-at-matched-tier-rate) usage charges.
 *
 * @param {number} units
 * @param {Array<{ upTo: number | null, unitRateCents: number }>} tiers
 * @returns {{ totalCents: number, matchedTierIndex: number, unitRateCents: number }}
 */
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
