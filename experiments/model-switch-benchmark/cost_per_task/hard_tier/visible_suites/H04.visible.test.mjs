import test from 'node:test';
import assert from 'node:assert/strict';
import { convertMinorUnitsExact } from '../src/fxConverter.mjs';
import { buildMultiCurrencyInvoice } from '../src/invoiceBuilder.mjs';

test('H04 visible: USD pivot triangulation and penny-exact Largest-Remainder tax allocation', () => {
  const quotes = [
    { from: 'EUR', to: 'USD', rateNum: 110, rateDen: 100, quoteTimestampMs: 1000 },
    { from: 'USD', to: 'JPY', rateNum: 150, rateDen: 1, quoteTimestampMs: 1000 }
  ];
  // 1000 EUR cents = 10 EUR -> 11 USD -> 1650 JPY
  assert.equal(
    convertMinorUnitsExact({ amountMinor: 1000, fromCurrency: 'EUR', toCurrency: 'JPY', quotes, asOfMs: 2000 }),
    1650
  );

  const inv = buildMultiCurrencyInvoice({
    invoiceId: 'inv-h04-v',
    accountId: 'acct-fx',
    targetCurrency: 'USD',
    usageRows: [
      { metric: 'm1', units: 1, tiers: [{ upTo: null, unitRateMicros: 10_000_000 }] },
      { metric: 'm2', units: 1, tiers: [{ upTo: null, unitRateMicros: 10_000_000 }] },
      { metric: 'm3', units: 1, tiers: [{ upTo: null, unitRateMicros: 10_000_000 }] }
    ],
    taxBps: 500 // 5% of 30 = 1.5 -> banker's round = 2 cents, split across 3 identical 10c lines!
  });
  assert.equal(inv.taxMinor, 2);
  assert.equal(inv.lineItems.reduce((s, l) => s + l.taxMinor, 0), 2);
  assert.equal(inv.totalDueMinor, 32);
});
