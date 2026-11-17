import { ERROR_CODES, LedgerError } from './errors.mjs';

export const CURRENCY_MINOR_EXPONENTS = Object.freeze({
  JPY: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  KWD: 3
});

/**
 * Exact BigInt half-to-even rounding for both negative and non-negative `numBig` with `denBig > 0n`.
 *
 * @param {bigint} numBig
 * @param {bigint} denBig
 * @returns {bigint}
 */
export function roundHalfToEvenBigInt(numBig, denBig) {
  if (typeof numBig !== 'bigint' || typeof denBig !== 'bigint' || denBig <= 0n) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'roundHalfToEvenBigInt requires bigint numBig and denBig > 0n');
  }
  const neg = numBig < 0n;
  const absNum = neg ? -numBig : numBig;
  const q = absNum / denBig;
  const rem = absNum % denBig;
  const twiceRem = rem * 2n;
  let rounded = q;
  if (twiceRem > denBig) {
    rounded = q + 1n;
  } else if (twiceRem === denBig && q % 2n !== 0n) {
    rounded = q + 1n;
  }
  return neg ? -rounded : rounded;
}

/**
 * Naive baseline FX converter preserved for baseline unit test compatibility.
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

function validateQuotes(quotes) {
  if (!Array.isArray(quotes)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'quotes must be an array');
  }
  for (const q of quotes) {
    if (
      !q ||
      typeof q !== 'object' ||
      typeof q.from !== 'string' ||
      typeof q.to !== 'string' ||
      !Number.isInteger(q.rateNum) ||
      q.rateNum <= 0 ||
      !Number.isInteger(q.rateDen) ||
      q.rateDen <= 0 ||
      !Number.isFinite(q.quoteTimestampMs)
    ) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid FX quote entry');
    }
  }
}

function findBestLeg(quotes, from, to) {
  let bestDirect = null;
  for (const q of quotes) {
    if (q.from === from && q.to === to) {
      if (!bestDirect || q.quoteTimestampMs > bestDirect.quoteTimestampMs) {
        bestDirect = { rateNum: BigInt(q.rateNum), rateDen: BigInt(q.rateDen), quoteTimestampMs: q.quoteTimestampMs };
      }
    }
  }
  if (bestDirect) return bestDirect;

  let bestInverse = null;
  for (const q of quotes) {
    if (q.from === to && q.to === from) {
      if (!bestInverse || q.quoteTimestampMs > bestInverse.quoteTimestampMs) {
        bestInverse = { rateNum: BigInt(q.rateDen), rateDen: BigInt(q.rateNum), quoteTimestampMs: q.quoteTimestampMs };
      }
    }
  }
  return bestInverse;
}

function findBestRoute(quotes, fromCurrency, toCurrency) {
  // 1. Direct from -> to
  let bestDirect = null;
  for (const q of quotes) {
    if (q.from === fromCurrency && q.to === toCurrency) {
      if (!bestDirect || q.quoteTimestampMs > bestDirect.quoteTimestampMs) {
        bestDirect = { rateNum: BigInt(q.rateNum), rateDen: BigInt(q.rateDen), ts: q.quoteTimestampMs };
      }
    }
  }
  if (bestDirect) return bestDirect;

  // 2. Reciprocal inverse to -> from
  let bestInverse = null;
  for (const q of quotes) {
    if (q.from === toCurrency && q.to === fromCurrency) {
      if (!bestInverse || q.quoteTimestampMs > bestInverse.quoteTimestampMs) {
        bestInverse = { rateNum: BigInt(q.rateDen), rateDen: BigInt(q.rateNum), ts: q.quoteTimestampMs };
      }
    }
  }
  if (bestInverse) return bestInverse;

  // 3. 1-hop USD pivot
  if (fromCurrency !== 'USD' && toCurrency !== 'USD') {
    const leg1Candidates = [];
    const leg2Candidates = [];
    for (const q of quotes) {
      if (q.from === fromCurrency && q.to === 'USD') {
        leg1Candidates.push({ rateNum: BigInt(q.rateNum), rateDen: BigInt(q.rateDen), ts: q.quoteTimestampMs, inv: 0 });
      } else if (q.from === 'USD' && q.to === fromCurrency) {
        leg1Candidates.push({ rateNum: BigInt(q.rateDen), rateDen: BigInt(q.rateNum), ts: q.quoteTimestampMs, inv: 1 });
      }
      if (q.from === 'USD' && q.to === toCurrency) {
        leg2Candidates.push({ rateNum: BigInt(q.rateNum), rateDen: BigInt(q.rateDen), ts: q.quoteTimestampMs, inv: 0 });
      } else if (q.from === toCurrency && q.to === 'USD') {
        leg2Candidates.push({ rateNum: BigInt(q.rateDen), rateDen: BigInt(q.rateNum), ts: q.quoteTimestampMs, inv: 1 });
      }
    }
    let bestPivot = null;
    for (const l1 of leg1Candidates) {
      for (const l2 of leg2Candidates) {
        const minTs = Math.min(l1.ts, l2.ts);
        const invCount = l1.inv + l2.inv;
        if (
          !bestPivot ||
          minTs > bestPivot.ts ||
          (minTs === bestPivot.ts && invCount < bestPivot.invCount)
        ) {
          bestPivot = {
            rateNum: l1.rateNum * l2.rateNum,
            rateDen: l1.rateDen * l2.rateDen,
            ts: minTs,
            invCount
          };
        }
      }
    }
    if (bestPivot) return bestPivot;
  }

  return null;
}

/**
 * Exact BigInt FX conversion supporting direct, inverse, and 1-hop USD triangulation
 * with freshness validation and single final banker's rounding.
 */
export function convertMinorUnitsExact({
  amountMinor,
  fromCurrency,
  toCurrency,
  quotes = [],
  asOfMs = 0,
  maxQuoteAgeMs = Infinity
} = {}) {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'amountMinor must be a safe integer');
  }
  if (
    CURRENCY_MINOR_EXPONENTS[fromCurrency] === undefined ||
    CURRENCY_MINOR_EXPONENTS[toCurrency] === undefined
  ) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Unsupported currency pair ${fromCurrency}->${toCurrency}`);
  }
  if (!Number.isFinite(asOfMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'asOfMs must be finite');
  }
  if (maxQuoteAgeMs !== Infinity && (!Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs < 0)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxQuoteAgeMs must be >= 0 or Infinity');
  }
  validateQuotes(quotes);

  if (fromCurrency === toCurrency) {
    return amountMinor;
  }

  const freshQuotes = quotes.filter(
    (q) => q.quoteTimestampMs <= asOfMs && asOfMs - q.quoteTimestampMs <= maxQuoteAgeMs
  );
  const route = findBestRoute(freshQuotes, fromCurrency, toCurrency);
  if (!route) {
    const staleRoute = findBestRoute(quotes, fromCurrency, toCurrency);
    if (staleRoute) {
      throw new LedgerError(ERROR_CODES.ERR_FX_QUOTE_STALE, `All FX quotes stale for ${fromCurrency}->${toCurrency}`);
    }
    throw new LedgerError(ERROR_CODES.ERR_FX_RATE_UNAVAILABLE, `No FX route for ${fromCurrency}->${toCurrency}`);
  }

  const fromExp = CURRENCY_MINOR_EXPONENTS[fromCurrency];
  const toExp = CURRENCY_MINOR_EXPONENTS[toCurrency];
  const numBig = BigInt(amountMinor) * route.rateNum * (10n ** BigInt(toExp));
  const denBig = route.rateDen * (10n ** BigInt(fromExp));
  return Number(roundHalfToEvenBigInt(numBig, denBig));
}
