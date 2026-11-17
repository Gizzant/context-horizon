import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice } from '../src/invoiceBuilder.mjs';
import { encodeFrozenWireDigest } from '../src/frozenWire.mjs';

test('buildInvoice computes subtotal, credits, totalDue, and frozen wire digest', () => {
  const tiers = [
    { upTo: 100, unitRateCents: 10 },
    { upTo: null, unitRateCents: 5 }
  ];
  const inv = buildInvoice({
    invoiceId: 'inv-100',
    accountId: 'acct-alpha',
    currency: 'USD',
    usageRows: [{ metric: 'api_calls', units: 60, tiers }],
    grants: [{ grantId: 'g1', remainingCents: 200, effectiveFromMs: 0, expiresAtMs: 99_999 }],
    asOfMs: 5000
  });
  assert.equal(inv.usageSubtotalCents, 600);
  assert.equal(inv.appliedCreditsCents, 200);
  assert.equal(inv.totalDueCents, 400);
  assert.equal(
    inv.wireDigest,
    encodeFrozenWireDigest({
      invoiceId: 'inv-100',
      accountId: 'acct-alpha',
      currency: 'USD',
      totalDueCents: 400,
      status: 'FINALIZED'
    })
  );
});
