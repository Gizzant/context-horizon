import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getMonthlyCycleBounds, getBillingWindowBounds } from './src/clock.mjs';
import { roundHalfToEvenBigInt, computeProratedGraduatedCharge } from './src/tierEngine.mjs';
import { buildProratedCycleInvoice } from './src/invoiceBuilder.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('H01 hidden: baseline and visible suite pass', () => {
  const files = fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x));
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('H01 hidden: leap year, DST gap/fold, and Australia/Lord_Howe 30m monthly cycle bounds', () => {
  // Leap year Feb 2024 anchorDay=31 -> Feb 29 to Mar 31
  const leap = getMonthlyCycleBounds({ year: 2024, month: 2, anchorDay: 31, timeZone: 'UTC', anchorHourLocal: 0 });
  assert.equal(leap.startLocalDate, '2024-02-29');
  assert.equal(leap.endLocalDate, '2024-03-31');

  // Spring-forward missing hour 02:00 in NY on 2026-03-08 -> 07:00Z
  const nySpring = getMonthlyCycleBounds({ year: 2026, month: 3, anchorDay: 8, timeZone: 'America/New_York', anchorHourLocal: 2 });
  assert.equal(nySpring.startUtcMs, Date.UTC(2026, 2, 8, 7, 0, 0));

  // Fall-back fold 01:00 in NY on 2026-11-01 -> first 01:00 EDT = 05:00Z
  const nyFall = getMonthlyCycleBounds({ year: 2026, month: 11, anchorDay: 1, timeZone: 'America/New_York', anchorHourLocal: 1 });
  assert.equal(nyFall.startUtcMs, Date.UTC(2026, 10, 1, 5, 0, 0));

  // Australia/Lord_Howe spring day 23.5h
  const lh = getBillingWindowBounds(Date.UTC(2026, 9, 4, 10, 0, 0), 'Australia/Lord_Howe', 0);
  assert.equal(lh.endUtcMs - lh.startUtcMs, 23.5 * 3_600_000);
});

test('H01 hidden: BigInt half-to-even rounding and zero-width band collapsing', () => {
  assert.equal(roundHalfToEvenBigInt(5n, 2n), 2n); // 2.5 -> 2 (even)
  assert.equal(roundHalfToEvenBigInt(7n, 2n), 4n); // 3.5 -> 4 (even)
  assert.equal(roundHalfToEvenBigInt(1n, 2n), 0n); // 0.5 -> 0 (even)
  assert.equal(roundHalfToEvenBigInt(3n, 2n), 2n); // 1.5 -> 2 (even)

  // Scale cap 1 by 1/2 -> 0 (collapses finite cap), unbounded stays valid
  const charge = computeProratedGraduatedCharge(5, [{ upTo: 1, unitRateCents: 10 }, { upTo: null, unitRateCents: 4 }], 1, 2);
  assert.equal(charge.totalCents, 20);
});

test('H01 hidden: same-timestamp plan changes collapse 0ms segment, immutable grants, and validation errors', () => {
  const cycle = getMonthlyCycleBounds({ year: 2026, month: 1, anchorDay: 1, timeZone: 'UTC', anchorHourLocal: 0 });
  const grants = [
    { grantId: 'g-exp', remainingCents: 5000, effectiveFromMs: 0, expiresAtMs: cycle.endUtcMs }, // expired at end!
    { grantId: 'g-ok', remainingCents: 300, effectiveFromMs: 0, expiresAtMs: cycle.endUtcMs + 1000 }
  ];
  const before = JSON.stringify(grants);

  const inv = buildProratedCycleInvoice({
    invoiceId: 'inv-h01-h',
    accountId: 'acct-z',
    year: 2026,
    month: 1,
    anchorDay: 1,
    planChanges: [
      { effectiveAtUtcMs: cycle.startUtcMs, planId: 'temp', monthlyFeeCents: 9999, metricTiers: { api: [{ upTo: null, unitRateCents: 99 }] } },
      { effectiveAtUtcMs: cycle.startUtcMs, planId: 'actual', monthlyFeeCents: 1000, metricTiers: { api: [{ upTo: null, unitRateCents: 10 }] } }
    ],
    events: [{ metric: 'api', units: 20, timestampMs: cycle.startUtcMs + 1000 }],
    grants
  });
  assert.equal(inv.segments.length, 1);
  assert.equal(inv.segments[0].planId, 'actual');
  assert.equal(inv.usageSubtotalCents, 1200);
  assert.equal(inv.appliedCreditsCents, 300);
  assert.equal(inv.totalDueCents, 900);
  assert.equal(JSON.stringify(grants), before);

  assert.throws(
    () => buildProratedCycleInvoice({
      invoiceId: 'bad',
      accountId: 'a',
      year: 2026,
      month: 1,
      anchorDay: 1,
      planChanges: [{ effectiveAtUtcMs: cycle.startUtcMs + 10, planId: 'p', monthlyFeeCents: 100, metricTiers: {} }]
    }),
    (err) => err.code === ERROR_CODES.ERR_INVALID_CONFIG
  );
});

test('[CONSTRAINT-1] zero dependencies in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
