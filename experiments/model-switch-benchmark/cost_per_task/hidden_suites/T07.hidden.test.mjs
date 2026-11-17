import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBillingWindowBounds, enumerateDailyWindows } from './src/clock.mjs';
import { buildDailyWindowInvoices } from './src/invoiceBuilder.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T07 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T07 hidden: New York fall-back 25h window and repeated anchorHourLocal=1 fold', () => {
  // 2026-11-01 01:00 EDT is 05:00Z; 01:00 EST is 06:00Z. First occurrence wins!
  const fallDay = getBillingWindowBounds(Date.UTC(2026, 10, 1, 12, 0, 0), 'America/New_York', 0);
  assert.equal(fallDay.localDate, '2026-11-01');
  assert.equal(fallDay.startUtcMs, Date.UTC(2026, 10, 1, 4, 0, 0));
  assert.equal(fallDay.endUtcMs, Date.UTC(2026, 10, 2, 5, 0, 0));
  assert.equal(fallDay.endUtcMs - fallDay.startUtcMs, 25 * 3_600_000);

  // Anchor at 01:00 local on 2026-11-01 -> first 01:00 EDT = 05:00Z
  const beforeFold = getBillingWindowBounds(Date.UTC(2026, 10, 1, 4, 59, 59), 'America/New_York', 1);
  assert.equal(beforeFold.localDate, '2026-10-31');
  assert.equal(beforeFold.endUtcMs, Date.UTC(2026, 10, 1, 5, 0, 0));

  const atFirstOneAm = getBillingWindowBounds(Date.UTC(2026, 10, 1, 5, 30, 0), 'America/New_York', 1);
  assert.equal(atFirstOneAm.localDate, '2026-11-01');
  assert.equal(atFirstOneAm.startUtcMs, Date.UTC(2026, 10, 1, 5, 0, 0));
  assert.equal(atFirstOneAm.endUtcMs, Date.UTC(2026, 10, 2, 6, 0, 0));
});

test('T07 hidden: spring-forward missing anchorHourLocal=2 resolves to first valid instant (03:00 EDT)', () => {
  // On 2026-03-08 in America/New_York, 02:00 jumps to 03:00 EDT (07:00Z).
  const beforeGap = getBillingWindowBounds(Date.UTC(2026, 2, 8, 6, 59, 0), 'America/New_York', 2);
  assert.equal(beforeGap.localDate, '2026-03-07');
  assert.equal(beforeGap.endUtcMs, Date.UTC(2026, 2, 8, 7, 0, 0));

  const inNewDay = getBillingWindowBounds(Date.UTC(2026, 2, 8, 7, 0, 0), 'America/New_York', 2);
  assert.equal(inNewDay.localDate, '2026-03-08');
  assert.equal(inNewDay.startUtcMs, Date.UTC(2026, 2, 8, 7, 0, 0));
  assert.equal(inNewDay.endUtcMs, Date.UTC(2026, 2, 9, 6, 0, 0));
});

test('T07 hidden: 30-minute DST (Australia/Lord_Howe) and Southern Hemisphere (Pacific/Auckland)', () => {
  // Australia/Lord_Howe springs forward +30m on 2026-10-04 -> 23.5h day
  const lhSpring = getBillingWindowBounds(Date.UTC(2026, 9, 4, 10, 0, 0), 'Australia/Lord_Howe', 0);
  assert.equal(lhSpring.localDate, '2026-10-04');
  assert.equal(lhSpring.endUtcMs - lhSpring.startUtcMs, 23.5 * 3_600_000);

  // Pacific/Auckland springs forward on 2026-09-27 -> 23h day
  const nzSpring = getBillingWindowBounds(Date.UTC(2026, 8, 27, 6, 0, 0), 'Pacific/Auckland', 0);
  assert.equal(nzSpring.localDate, '2026-09-27');
  assert.equal(nzSpring.endUtcMs - nzSpring.startUtcMs, 23 * 3_600_000);

  const windows = enumerateDailyWindows(
    Date.UTC(2026, 9, 3, 0, 0, 0),
    Date.UTC(2026, 9, 6, 0, 0, 0),
    'Australia/Lord_Howe',
    0
  );
  assert.ok(windows.length >= 3);
  for (let i = 0; i < windows.length - 1; i += 1) {
    assert.equal(windows[i].endUtcMs, windows[i + 1].startUtcMs);
  }
});

test('T07 hidden: buildDailyWindowInvoices buckets DST boundaries and carries credits sequentially without mutating grants', () => {
  const grants = [
    { grantId: 'g1', remainingCents: 250, effectiveFromMs: 0, expiresAtMs: Date.UTC(2026, 3, 1) }
  ];
  const frozenGrants = JSON.stringify(grants);
  const metricTiers = {
    api: [{ upTo: 100, unitRateCents: 10 }, { upTo: null, unitRateCents: 5 }]
  };
  const invs = buildDailyWindowInvoices({
    accountId: 'acct-dst',
    timeZone: 'America/New_York',
    anchorHourLocal: 0,
    rangeStartUtcMs: Date.UTC(2026, 2, 8, 5, 0, 0), // start of 2026-03-08 NY
    rangeEndUtcMs: Date.UTC(2026, 2, 10, 4, 0, 0), // end of 2026-03-09 NY
    events: [
      { metric: 'api', units: 20, timestampMs: Date.UTC(2026, 2, 9, 3, 59, 0) }, // still 2026-03-08 NY! (23:59 EDT)
      { metric: 'api', units: 15, timestampMs: Date.UTC(2026, 2, 9, 4, 0, 0) } // 2026-03-09 NY! (00:00 EDT)
    ],
    metricTiers,
    grants
  });
  assert.equal(invs.length, 2);
  assert.equal(invs[0].invoiceId, 'acct-dst:2026-03-08');
  assert.equal(invs[0].usageSubtotalCents, 200);
  assert.equal(invs[0].appliedCreditsCents, 200);
  assert.equal(invs[0].totalDueCents, 0);

  assert.equal(invs[1].invoiceId, 'acct-dst:2026-03-09');
  assert.equal(invs[1].usageSubtotalCents, 150);
  assert.equal(invs[1].appliedCreditsCents, 50);
  assert.equal(invs[1].totalDueCents, 100);
  assert.equal(JSON.stringify(grants), frozenGrants);
});

test('[CONSTRAINT-1] zero dependencies added in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
