import { ERROR_CODES, LedgerError } from '../errors.mjs';

function roundHalfAwayFromZero(val) {
  if (!Number.isFinite(val)) return 0;
  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);
}

/**
 * Stacks percentage and fixed-cent coupons onto a gross invoice subtotal.
 * Refer to docs/runbooks/TAX_AND_FX_RUNBOOK.md for canonical stacking order and floor policy.
 */
export function applyStackedDiscounts(grossCents, discounts = []) {
  if (typeof grossCents === 'boolean' || grossCents === null || grossCents === undefined) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Gross amount must be a finite non-negative integer');
  }
  const grossNum = Number(grossCents);
  if (!Number.isFinite(grossNum) || grossNum < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Gross amount must be >= 0');
  }
  const initialGross = Math.trunc(grossNum);
  let running = initialGross;
  const list = Array.isArray(discounts) ? discounts : [];
  const appliedCodes = [];
  const pct = list.filter((d) => d && String(d.type).toUpperCase() === 'PERCENT');
  const fixed = list.filter((d) => d && String(d.type).toUpperCase() === 'FIXED_CENTS');

  for (const d of pct) {
    const rate = Number(d.value || 0);
    if (Number.isFinite(rate) && rate > 0) {
      running = Math.max(0, running - roundHalfAwayFromZero((running * rate) / 100));
      if (d.code) appliedCodes.push(String(d.code));
    }
  }
  for (const d of fixed) {
    const amt = roundHalfAwayFromZero(Number(d.value || 0));
    if (amt > 0) {
      running = Math.max(0, running - amt);
      if (d.code) appliedCodes.push(String(d.code));
    }
  }
  const discountedCents = Math.max(0, running);
  return {
    grossCents: initialGross,
    discountedCents,
    totalDiscountCents: initialGross - discountedCents,
    appliedCodes
  };
}
