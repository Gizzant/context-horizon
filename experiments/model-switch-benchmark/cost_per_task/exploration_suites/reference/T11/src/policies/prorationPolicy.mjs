import { ERROR_CODES, LedgerError } from '../errors.mjs';

function roundHalfAwayFromZero(val) {
  if (!Number.isFinite(val)) return 0;
  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);
}

/**
 * Computes mid-cycle prorated subscription fee and included entitlement units.
 */
export function computeProratedAllowanceAndFee({
  annualOrMonthlyFeeCents = 0,
  includedUnits = 0,
  planStartMs,
  planEndMs,
  periodStartMs,
  periodEndMs
} = {}) {
  const fee = Number(annualOrMonthlyFeeCents);
  const units = Number(includedUnits);
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(units) || units < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Invalid proration fee or units');
  }
  if (!(periodEndMs > periodStartMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid billing period bounds');
  }
  const totalPeriodMs = Number(periodEndMs) - Number(periodStartMs);
  const overlapStart = Math.max(Number(planStartMs ?? periodStartMs), Number(periodStartMs));
  const overlapEnd = Math.min(Number(planEndMs ?? periodEndMs), Number(periodEndMs));
  const activeMs = Math.max(0, overlapEnd - overlapStart);
  if (activeMs <= 0) {
    return { ratio: 0, proratedFeeCents: 0, proratedUnits: 0 };
  }
  const exactRatio = activeMs / totalPeriodMs;
  return {
    ratio: Number(exactRatio.toFixed(6)),
    proratedFeeCents: roundHalfAwayFromZero((fee * activeMs) / totalPeriodMs),
    proratedUnits: roundHalfAwayFromZero((units * activeMs) / totalPeriodMs)
  };
}
