import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStackedDiscounts } from '../src/policies/discountStackingPolicy.mjs';
import { convertCurrencyCents } from '../src/policies/fxConversionPolicy.mjs';
import { computeCrossBorderInvoice } from '../src/services/billingOrchestrator.mjs';

test('T09 visible: PERCENT discounts apply before FIXED_CENTS and floor at 0', () => {
  // 10000 - 20% = 8000; 8000 - 1500 = 6500
  const res = applyStackedDiscounts(10_000, [
    { type: 'FIXED_CENTS', value: 1500, code: 'FLAT15' },
    { type: 'PERCENT', value: 20, code: 'PCT20' }
  ]);
  assert.equal(res.discountedCents, 6500);
  assert.equal(res.totalDiscountCents, 3500);

  const floored = applyStackedDiscounts(1000, [
    { type: 'FIXED_CENTS', value: 5000, code: 'BIG50' }
  ]);
  assert.equal(floored.discountedCents, 0);
});

test('T09 visible: triangulated FX conversion and B2B reverse-charge zero tax', () => {
  // 10000 EUR * 1.10 / 1.25 = 8800 GBP exact
  const fx = convertCurrencyCents({
    amountCents: 10_000,
    fromCurrency: 'EUR',
    toCurrency: 'GBP',
    usdRates: { USD: 1, EUR: 1.1, GBP: 1.25 }
  });
  assert.equal(fx.convertedCents, 8800);

  const inv = computeCrossBorderInvoice({
    invoiceId: 'INV-901',
    accountId: 'acct-eu',
    grossCents: 10_000,
    currency: 'EUR',
    billingCurrency: 'GBP',
    discounts: [{ type: 'PERCENT', value: 10, code: 'EU10' }],
    customerCountry: 'DE',
    taxExemptReverseCharge: true,
    vatId: 'DE123456789',
    usdRates: { USD: 1, EUR: 1.1, GBP: 1.25 },
    taxRateBps: 1900
  });
  // 10000 - 10% = 9000 EUR -> 9000 * 1.1 / 1.25 = 7920 GBP, tax = 0
  assert.equal(inv.convertedSubtotalCents, 7920);
  assert.equal(inv.taxCents, 0);
  assert.equal(inv.reverseChargeApplied, true);
  assert.equal(inv.totalDueCents, 7920);
});
