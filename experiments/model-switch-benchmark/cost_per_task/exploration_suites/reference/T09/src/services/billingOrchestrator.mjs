import { INVOICE_STATUS, MAX_BPS } from '../constants.mjs';
import { encodeFrozenWireDigest } from '../frozenWire.mjs';
import { applyStackedDiscounts } from '../policies/discountStackingPolicy.mjs';
import { convertCurrencyCents, DEFAULT_USD_RATES } from '../policies/fxConversionPolicy.mjs';

function roundHalfAwayFromZero(val) {
  if (!Number.isFinite(val)) return 0;
  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);
}

/**
 * Cross-border invoice computation pipeline.
 * Refer to docs/runbooks/TAX_AND_FX_RUNBOOK.md for B2B reverse-charge and FX order rules.
 */
export function computeCrossBorderInvoice({
  invoiceId,
  accountId,
  grossCents = 0,
  currency = 'USD',
  billingCurrency = currency,
  discounts = [],
  customerCountry = 'US',
  taxExemptReverseCharge = false,
  vatId = null,
  usdRates = DEFAULT_USD_RATES,
  taxRateBps = 0,
  asOfMs = 0
} = {}) {
  const discRes = applyStackedDiscounts(grossCents, discounts);
  const fxRes = convertCurrencyCents({
    amountCents: discRes.discountedCents,
    fromCurrency: currency,
    toCurrency: billingCurrency,
    usdRates
  });
  const normalizedCountry = String(customerCountry || 'US').trim().toUpperCase();
  const hasValidVat = typeof vatId === 'string' && vatId.trim().length > 0;
  const reverseChargeApplied = Boolean(taxExemptReverseCharge) && hasValidVat && normalizedCountry !== 'US';
  const taxCents = reverseChargeApplied
    ? 0
    : roundHalfAwayFromZero((fxRes.convertedCents * Math.max(0, Number(taxRateBps || 0))) / MAX_BPS);
  const totalDueCents = fxRes.convertedCents + taxCents;
  const wireDigest = encodeFrozenWireDigest({
    invoiceId,
    accountId,
    currency: fxRes.toCurrency,
    totalDueCents,
    status: INVOICE_STATUS.FINALIZED
  });
  return {
    invoiceId,
    accountId,
    asOfMs,
    currency: fxRes.toCurrency,
    grossCents: discRes.grossCents,
    discountedSourceCents: discRes.discountedCents,
    convertedSubtotalCents: fxRes.convertedCents,
    taxCents,
    reverseChargeApplied,
    customerCountry: normalizedCountry,
    vatId,
    taxExemptReverseCharge,
    totalDueCents,
    appliedDiscountCodes: discRes.appliedCodes,
    wireDigest
  };
}
