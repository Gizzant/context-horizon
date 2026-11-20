import { ERROR_CODES, LedgerError } from '../errors.mjs';

export const DEFAULT_USD_RATES = Object.freeze({
  USD: 1,
  EUR: 1.1,
  GBP: 1.25
});

function roundHalfAwayFromZero(val) {
  if (!Number.isFinite(val)) return 0;
  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);
}

/**
 * Converts minor-unit cents from `fromCurrency` to `toCurrency` via USD triangulation.
 */
export function convertCurrencyCents({
  amountCents,
  fromCurrency = 'USD',
  toCurrency = 'USD',
  usdRates = DEFAULT_USD_RATES
} = {}) {
  const amt = Number(amountCents);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Invalid FX conversion amount');
  }
  const from = String(fromCurrency || 'USD').toUpperCase();
  const to = String(toCurrency || 'USD').toUpperCase();
  const fromRate = Number(usdRates?.[from]);
  const toRate = Number(usdRates?.[to]);
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Missing FX rate for ${from}->${to}`);
  }
  if (from === to) {
    return {
      convertedCents: Math.trunc(amt),
      fromCurrency: from,
      toCurrency: to,
      effectiveRate: 1
    };
  }
  const exactConverted = (amt * fromRate) / toRate;
  return {
    convertedCents: roundHalfAwayFromZero(exactConverted),
    fromCurrency: from,
    toCurrency: to,
    effectiveRate: Number((fromRate / toRate).toFixed(6))
  };
}
