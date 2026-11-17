import { ERROR_CODES, LedgerError } from './errors.mjs';

export const CURRENCY_MINOR_EXPONENTS = Object.freeze({
  JPY: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  KWD: 3
});

/**
 * Naive baseline FX converter using floating-point arithmetic.
 *
 * @param {number} amountMinor
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {Array<{ from: string, to: string, rateNum: number, rateDen: number, quoteTimestampMs: number }>} quotes
 */
export function convertMinorUnits(amountMinor, fromCurrency, toCurrency, quotes = []) {
  if (!Number.isFinite(amountMinor)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'amountMinor must be finite');
  }
  if (fromCurrency === toCurrency) {
    return Math.round(amountMinor);
  }
  const direct = quotes.find((q) => q.from === fromCurrency && q.to === toCurrency);
  if (!direct) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Missing FX quote ${fromCurrency}->${toCurrency}`);
  }
  const fromExp = CURRENCY_MINOR_EXPONENTS[fromCurrency] ?? 2;
  const toExp = CURRENCY_MINOR_EXPONENTS[toCurrency] ?? 2;
  const scale = 10 ** (toExp - fromExp);
  return Math.round((amountMinor * direct.rateNum * scale) / direct.rateDen);
}
