import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createSettlementRegistry,
  settleInvoice,
  voidInvoiceSettlement,
  getRegistrySnapshot
} from './src/invoiceBuilder.mjs';
import { encodeFrozenWireDigest } from './src/frozenWire.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T06 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T06 hidden: void after partial grant expiry splits active vs expired and prevents expired reuse', () => {
  const grants = [
    { grantId: 'g-short', remainingCents: 300, effectiveFromMs: 0, expiresAtMs: 5_000 },
    { grantId: 'g-long', remainingCents: 500, effectiveFromMs: 0, expiresAtMs: 50_000 }
  ];
  const frozenBefore = JSON.stringify(grants);
  const reg = createSettlementRegistry(grants);
  const tiers = [{ upTo: 200, unitRateCents: 10 }];

  const inv1 = settleInvoice(reg, {
    invoiceId: 'inv-h1',
    accountId: 'acct-h',
    usageRows: [{ metric: 'api', units: 70, tiers }], // 700c -> 300 from g-short + 400 from g-long
    asOfMs: 1_000
  });
  assert.equal(inv1.appliedCreditsCents, 700);
  assert.equal(inv1.totalDueCents, 0);

  // Void at 5_000: g-short is expired (voidedAtMs >= expiresAtMs), g-long is active
  const voidRes = voidInvoiceSettlement(reg, 'inv-h1', 5_000);
  assert.equal(voidRes.restoredExpiredCents, 300);
  assert.equal(voidRes.restoredActiveCents, 400);
  assert.equal(voidRes.netDeltaCents, 0);
  assert.equal(
    voidRes.reversalWireDigest,
    encodeFrozenWireDigest({
      invoiceId: 'inv-h1',
      accountId: 'acct-h',
      currency: 'USD',
      totalDueCents: 0,
      status: 'VOIDED'
    })
  );

  // Subsequent settlement at 6_000 can ONLY use g-long (500c), NOT restored g-short
  const inv2 = settleInvoice(reg, {
    invoiceId: 'inv-h2',
    accountId: 'acct-h',
    usageRows: [{ metric: 'api', units: 70, tiers }],
    asOfMs: 6_000
  });
  assert.equal(inv2.appliedCreditsCents, 500);
  assert.equal(inv2.totalDueCents, 200);
  assert.equal(JSON.stringify(grants), frozenBefore);

  const snap = getRegistrySnapshot(reg, 6_000);
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'inv-h1').status, 'VOIDED');
});

test('T06 hidden: repeat void, unknown invoice, and non-zero netDeltaCents', () => {
  const reg = createSettlementRegistry([{ grantId: 'g1', remainingCents: 100, effectiveFromMs: 0, expiresAtMs: 50_000 }]);
  settleInvoice(reg, {
    invoiceId: 'inv-paid',
    accountId: 'acct-z',
    usageRows: [{ metric: 'api', units: 25, tiers: [{ upTo: null, unitRateCents: 10 }] }], // 250 - 100 = 150
    asOfMs: 1_000
  });
  const v = voidInvoiceSettlement(reg, 'inv-paid', 2_000);
  assert.equal(v.netDeltaCents, -150);

  assert.throws(
    () => voidInvoiceSettlement(reg, 'inv-paid', 3_000),
    (err) => err.code === ERROR_CODES.ERR_ALREADY_VOIDED
  );
  assert.throws(
    () => voidInvoiceSettlement(reg, 'inv-missing', 3_000),
    (err) => err.code === ERROR_CODES.ERR_UNKNOWN_INVOICE
  );
});

test('[CONSTRAINT-1] pre-existing error codes preserved in errors.mjs', () => {
  for (const k of [
    'ERR_NEGATIVE_UNITS',
    'ERR_INVALID_TIERS',
    'ERR_INVALID_AMOUNT',
    'ERR_IDEMPOTENCY_CONFLICT',
    'ERR_INVALID_TTL',
    'ERR_INVALID_CONFIG',
    'ERR_DSL_SYNTAX',
    'ERR_INVALID_TIMEZONE',
    'ERR_SINK_FAILURE',
    'ERR_INVALID_EVENT'
  ]) {
    assert.equal(ERROR_CODES[k], k);
  }
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
