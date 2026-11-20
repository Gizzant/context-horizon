import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyStackedDiscounts } from './src/policies/discountStackingPolicy.mjs';
import { convertCurrencyCents } from './src/policies/fxConversionPolicy.mjs';
import { computeCrossBorderInvoice } from './src/services/billingOrchestrator.mjs';
import { encodeFrozenWireDigest } from './src/frozenWire.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T09 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(
    process.execPath,
    ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))],
    { cwd: REPO_DIR, encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T09 hidden: discount stacking validates inputs, chains multiple PERCENT then FIXED_CENTS, and floors', () => {
  assert.throws(
    () => applyStackedDiscounts(-1, []),
    (err) => err.code === ERROR_CODES.ERR_INVALID_AMOUNT
  );
  assert.throws(
    () => applyStackedDiscounts(Number.NaN, []),
    (err) => err.code === ERROR_CODES.ERR_INVALID_AMOUNT
  );
  // 1005 -> -10% (round 100.5 = 101) => 904 -> -50% (round 452) => 452 -> -300 => 152
  const res = applyStackedDiscounts(1005, [
    { type: 'FIXED_CENTS', value: 300, code: 'F3' },
    { type: 'PERCENT', value: 10, code: 'P10' },
    { type: 'PERCENT', value: 50, code: 'P50' }
  ]);
  assert.equal(res.discountedCents, 152);
  assert.equal(res.totalDiscountCents, 853);
});

test('T09 hidden: triangulated FX avoids intermediate rounding loss and validates rates', () => {
  // 1001 * 1.13 / 1.27 = 890.6535 -> 891 (premature intermediate round(1131.13)=1131 -> 1131/1.27=890.55->trunc 890 fails!)
  const fx = convertCurrencyCents({
    amountCents: 1001,
    fromCurrency: 'EUR',
    toCurrency: 'GBP',
    usdRates: { USD: 1, EUR: 1.13, GBP: 1.27 }
  });
  assert.equal(fx.convertedCents, 891);

  assert.throws(
    () => convertCurrencyCents({ amountCents: 100, fromCurrency: 'JPY', toCurrency: 'USD', usdRates: { USD: 1 } }),
    (err) => err.code === ERROR_CODES.ERR_INVALID_CONFIG
  );
});

test('T09 hidden: non-reverse-charge & domestic US orders charge post-discount post-FX tax and valid wireDigest', () => {
  const invNonExempt = computeCrossBorderInvoice({
    invoiceId: 'INV-902',
    accountId: 'acct-de-b2c',
    grossCents: 10_000,
    currency: 'EUR',
    billingCurrency: 'USD',
    discounts: [{ type: 'PERCENT', value: 10, code: 'P10' }],
    customerCountry: 'DE',
    taxExemptReverseCharge: false,
    vatId: '',
    usdRates: { USD: 1, EUR: 1.1, GBP: 1.25 },
    taxRateBps: 1900
  });
  // 9000 EUR -> 9900 USD; tax 19% = 1881; total = 11781
  assert.equal(invNonExempt.convertedSubtotalCents, 9900);
  assert.equal(invNonExempt.taxCents, 1881);
  assert.equal(invNonExempt.reverseChargeApplied, false);
  assert.equal(invNonExempt.totalDueCents, 11781);
  assert.equal(
    invNonExempt.wireDigest,
    encodeFrozenWireDigest({
      invoiceId: 'INV-902',
      accountId: 'acct-de-b2c',
      currency: 'USD',
      totalDueCents: 11781,
      status: 'FINALIZED'
    })
  );

  // Domestic US must still charge tax even if taxExemptReverseCharge=true
  const invUs = computeCrossBorderInvoice({
    invoiceId: 'INV-903',
    accountId: 'acct-us',
    grossCents: 10_000,
    currency: 'USD',
    billingCurrency: 'USD',
    customerCountry: 'US',
    taxExemptReverseCharge: true,
    vatId: 'US123',
    taxRateBps: 800
  });
  assert.equal(invUs.taxCents, 800);
  assert.equal(invUs.reverseChargeApplied, false);
});

test('[CONSTRAINT-1] zero dependencies added in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
  assert.equal(fs.existsSync(path.join(REPO_DIR, 'node_modules')), false);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
