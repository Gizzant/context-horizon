import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInvoice } from './src/invoiceBuilder.mjs';
import { encodeFrozenWireDigest } from './src/frozenWire.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T04 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T04 hidden: creditsEligibleForTrueUp=true offsets trueUp, multi-tier usage, and expired grants ignored', () => {
  const tiers = [
    { upTo: 100, unitRateCents: 10 },
    { upTo: null, unitRateCents: 5 }
  ];
  const grants = [
    { grantId: 'g-exp', remainingCents: 9999, effectiveFromMs: 0, expiresAtMs: 500 },
    { grantId: 'g-ok', remainingCents: 1800, effectiveFromMs: 0, expiresAtMs: 5000 }
  ];
  const grantsBefore = JSON.stringify(grants);

  // 150 units -> 100*10 + 50*5 = 1250 cents (catches tierEngine boundary bug if present!)
  const inv = buildInvoice({
    invoiceId: 'inv-t04-h1',
    accountId: 'acct-h1',
    usageRows: [{ metric: 'tokens', units: 150, tiers }],
    grants,
    asOfMs: 1000,
    minimumCommitCents: 2000,
    creditsEligibleForTrueUp: true,
    taxBps: 500 // 5.00%
  });

  assert.equal(inv.usageSubtotalCents, 1250);
  assert.equal(inv.trueUpCents, 750);
  assert.equal(inv.preCreditSubtotalCents, 2000);
  assert.equal(inv.appliedCreditsCents, 1800);
  assert.equal(inv.netAfterCreditsCents, 200);
  assert.equal(inv.taxCents, 10);
  assert.equal(inv.totalDueCents, 210);
  assert.equal(inv.lineItems.some((l) => l.metric === 'COMMIT_TRUE_UP' && l.amountCents === 750), true);
  assert.equal(JSON.stringify(grants), grantsBefore);
  assert.equal(
    inv.wireDigest,
    encodeFrozenWireDigest({
      invoiceId: 'inv-t04-h1',
      accountId: 'acct-h1',
      currency: 'USD',
      totalDueCents: 210,
      status: 'FINALIZED'
    })
  );
});

test('T04 hidden: usage exceeding minimumCommit emits no COMMIT_TRUE_UP and invalid config throws', () => {
  const inv = buildInvoice({
    invoiceId: 'inv-t04-h2',
    accountId: 'acct-h2',
    usageRows: [{ metric: 'calls', units: 120, tiers: [{ upTo: 100, unitRateCents: 10 }, { upTo: null, unitRateCents: 5 }] }],
    minimumCommitCents: 500,
    taxBps: 0
  });
  assert.equal(inv.usageSubtotalCents, 1100);
  assert.equal(inv.trueUpCents, 0);
  assert.equal(inv.lineItems.some((l) => l.metric === 'COMMIT_TRUE_UP'), false);
  assert.equal(inv.totalDueCents, 1100);

  assert.throws(
    () => buildInvoice({ invoiceId: 'x', accountId: 'a', taxBps: 10001 }),
    (err) => err.code === ERROR_CODES.ERR_INVALID_CONFIG || err.code === ERROR_CODES.ERR_INVALID_AMOUNT
  );
  assert.throws(
    () => buildInvoice({ invoiceId: 'x', accountId: 'a', minimumCommitCents: -10 }),
    (err) => err.code === ERROR_CODES.ERR_INVALID_CONFIG || err.code === ERROR_CODES.ERR_INVALID_AMOUNT
  );
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
