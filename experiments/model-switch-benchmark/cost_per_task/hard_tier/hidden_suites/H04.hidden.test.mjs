import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convertMinorUnitsExact } from './src/fxConverter.mjs';
import { computeMicroTierCharge } from './src/tierEngine.mjs';
import { allocateByLargestRemainder, buildMultiCurrencyInvoice } from './src/invoiceBuilder.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('H04 hidden: baseline and visible suite pass', () => {
  const files = fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x));
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('H04 hidden: BigInt exact reciprocal, KWD(3)<->JPY(0) triangulation, and stale vs unavailable errors', () => {
  const quotes = [
    { from: 'USD', to: 'KWD', rateNum: 307, rateDen: 1000, quoteTimestampMs: 5000 }, // 1 USD = 0.307 KWD
    { from: 'USD', to: 'JPY', rateNum: 150, rateDen: 1, quoteTimestampMs: 5000 }
  ];
  // 1535 KWD fils (= 1.535 KWD = 5 USD) -> 750 JPY (exact BigInt reciprocal * USD->JPY!)
  assert.equal(
    convertMinorUnitsExact({
      amountMinor: 1535,
      fromCurrency: 'KWD',
      toCurrency: 'JPY',
      quotes,
      asOfMs: 6000,
      maxQuoteAgeMs: 2000
    }),
    750
  );

  // Stale quote throws ERR_FX_QUOTE_STALE; missing route throws ERR_FX_RATE_UNAVAILABLE
  assert.throws(
    () => convertMinorUnitsExact({ amountMinor: 100, fromCurrency: 'USD', toCurrency: 'KWD', quotes, asOfMs: 9000, maxQuoteAgeMs: 1000 }),
    (err) => err.code === ERROR_CODES.ERR_FX_QUOTE_STALE
  );
  assert.throws(
    () => convertMinorUnitsExact({ amountMinor: 100, fromCurrency: 'EUR', toCurrency: 'GBP', quotes, asOfMs: 6000 }),
    (err) => err.code === ERROR_CODES.ERR_FX_RATE_UNAVAILABLE
  );
});

test('H04 hidden: micro-rate single final banker round and Hamilton tie-break by weight DESC then index ASC', () => {
  // Band 1: 3 * 500_000 = 1_500_000 micros; Band 2: 2 * 500_000 = 1_000_000 micros -> sum 2_500_000 micros = 2.5 -> rounds to 2 (even!)
  const micro = computeMicroTierCharge(5, [
    { upTo: 3, unitRateMicros: 500_000 },
    { upTo: null, unitRateMicros: 500_000 }
  ]);
  assert.equal(micro.totalCents, 2);

  // Equal fractional remainders (0.5 vs 0.5) break by larger weight first, then index ASC!
  assert.deepEqual(allocateByLargestRemainder(2, [10, 30]), [0, 2]);
  assert.deepEqual(allocateByLargestRemainder(4, [10, 30, 30]), [0, 2, 2]);
  assert.deepEqual(allocateByLargestRemainder(4, [20, 30, 30]), [1, 2, 1]);
});

test('H04 hidden: multi-currency invoice end-to-end zero penny drift', () => {
  const quotes = [{ from: 'EUR', to: 'USD', rateNum: 108, rateDen: 100, quoteTimestampMs: 1000 }];
  const grants = [{ grantId: 'g1', remainingCents: 100, effectiveFromMs: 0, expiresAtMs: 50_000 }];
  const inv = buildMultiCurrencyInvoice({
    invoiceId: 'inv-h04-h',
    accountId: 'acct-mc',
    targetCurrency: 'USD',
    usageRows: [
      { metric: 'eu_api', units: 100, tiers: [{ upTo: null, unitRateMicros: 1_500_000 }], rowCurrency: 'EUR' }, // 150 EURc -> 162 USDc
      { metric: 'us_api', units: 75, tiers: [{ upTo: null, unitRateMicros: 1_000_000 }], rowCurrency: 'USD' } // 75 USDc
    ],
    quotes,
    asOfMs: 2000,
    discountBps: 1000, // 10% of 237 = 23.7 -> 24c
    taxBps: 725, // 7.25% of (237 - 24 - 100 = 113) = 8.1925 -> 8c
    grants
  });
  assert.equal(inv.usageSubtotalMinor, 237);
  assert.equal(inv.discountMinor, 24);
  assert.equal(inv.lineItems.reduce((s, l) => s + l.discountMinor, 0), 24);
  assert.equal(inv.appliedCreditsMinor, 100);
  assert.equal(inv.taxMinor, 8);
  assert.equal(inv.lineItems.reduce((s, l) => s + l.taxMinor, 0), 8);
  assert.equal(inv.totalDueMinor, 121);
});

test('[CONSTRAINT-1] zero dependencies in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
