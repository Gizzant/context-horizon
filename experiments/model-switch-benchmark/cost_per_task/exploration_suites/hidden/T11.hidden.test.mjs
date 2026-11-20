import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeProratedAllowanceAndFee } from './src/policies/prorationPolicy.mjs';
import { aggregateMeteredUsage } from './src/adapters/usageMeterAdapter.mjs';
import { evaluateSubscriptionEntitlement } from './src/services/entitlementRouter.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T11 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(
    process.execPath,
    ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))],
    { cwd: REPO_DIR, encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T11 hidden: 28-day month single-round proration & negative usage rejection', () => {
  const febStart = Date.UTC(2026, 1, 1);
  const febEnd = Date.UTC(2026, 2, 1); // 28 days
  const midStart = Date.UTC(2026, 1, 15); // 14 days = 1/2
  const pro = computeProratedAllowanceAndFee({
    annualOrMonthlyFeeCents: 1001, // 1001 * 0.5 = 500.5 -> half-away = 501
    includedUnits: 55, // 55 * 0.5 = 27.5 -> half-away = 28
    planStartMs: midStart,
    planEndMs: febEnd,
    periodStartMs: febStart,
    periodEndMs: febEnd
  });
  assert.equal(pro.proratedFeeCents, 501);
  assert.equal(pro.proratedUnits, 28);

  assert.throws(
    () =>
      aggregateMeteredUsage([{ eventId: 'bad', accountId: 'A1', metric: 'api', units: -3, timestampMs: febStart }], {
        accountId: 'A1',
        metric: 'api',
        periodStartMs: febStart,
        periodEndMs: febEnd
      }),
    (err) => err.code === ERROR_CODES.ERR_NEGATIVE_UNITS
  );
});

test('T11 hidden: HARD_CAP vs SOFT_GRACE overage fee & OVER_LIMIT threshold', () => {
  const pStart = Date.UTC(2026, 2, 1);
  const pEnd = Date.UTC(2026, 3, 1); // 31 days

  const hard = evaluateSubscriptionEntitlement({
    accountId: 'A2',
    metric: 'tokens',
    baseFeeCents: 3100,
    includedUnits: 1000,
    graceBufferUnits: 200,
    overageUnitRateCents: 3,
    policyMode: 'HARD_CAP',
    periodStartMs: pStart,
    periodEndMs: pEnd,
    usageEvents: [
      { eventId: 'x1', accountId: 'A2', metric: 'tokens', units: 600, timestampMs: pStart },
      { eventId: 'x2', accountId: 'A2', metric: 'tokens', units: 500, timestampMs: pStart + 1000 },
      { eventId: 'x2', accountId: 'A2', metric: 'tokens', units: 500, timestampMs: pStart + 2000 }
    ]
  });
  assert.equal(hard.effectiveAllowance, 1000);
  assert.equal(hard.usedUnits, 1100);
  assert.equal(hard.allowed, false);
  assert.equal(hard.status, 'OVER_LIMIT');
  assert.equal(hard.overageUnits, 100);
  assert.equal(hard.overageFeeCents, 300);
  assert.equal(hard.totalChargeCents, 3400);

  const softOver = evaluateSubscriptionEntitlement({
    accountId: 'A2',
    metric: 'tokens',
    baseFeeCents: 3100,
    includedUnits: 1000,
    graceBufferUnits: 150,
    overageUnitRateCents: 4,
    policyMode: 'SOFT_GRACE',
    periodStartMs: pStart,
    periodEndMs: pEnd,
    usageEvents: [{ eventId: 'y1', accountId: 'A2', metric: 'tokens', units: 1200, timestampMs: pStart }]
  });
  assert.equal(softOver.effectiveAllowance, 1150);
  assert.equal(softOver.allowed, false);
  assert.equal(softOver.status, 'OVER_LIMIT');
  assert.equal(softOver.overageUnits, 50);
  assert.equal(softOver.overageFeeCents, 200);
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
