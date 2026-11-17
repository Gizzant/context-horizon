import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSettlementRegistry,
  settleInvoice,
  voidInvoiceSettlement
} from '../src/invoiceBuilder.mjs';

test('T06 visible: settle invoice, void before grant expiry, and reuse restored credits', () => {
  const grants = [{ grantId: 'g1', remainingCents: 500, effectiveFromMs: 0, expiresAtMs: 50_000 }];
  const reg = createSettlementRegistry(grants);
  const tiers = [{ upTo: 100, unitRateCents: 10 }];

  const inv1 = settleInvoice(reg, {
    invoiceId: 'inv-1',
    accountId: 'acct-1',
    usageRows: [{ metric: 'api', units: 40, tiers }],
    asOfMs: 1000
  });
  assert.equal(inv1.appliedCreditsCents, 400);
  assert.equal(inv1.totalDueCents, 0);

  const voidRes = voidInvoiceSettlement(reg, 'inv-1', 2000);
  assert.equal(voidRes.status, 'VOIDED');
  assert.equal(voidRes.restoredActiveCents, 400);
  assert.equal(voidRes.restoredExpiredCents, 0);
  assert.equal(voidRes.netDeltaCents, 0);

  const inv2 = settleInvoice(reg, {
    invoiceId: 'inv-2',
    accountId: 'acct-1',
    usageRows: [{ metric: 'api', units: 30, tiers }],
    asOfMs: 3000
  });
  assert.equal(inv2.appliedCreditsCents, 300);
});
