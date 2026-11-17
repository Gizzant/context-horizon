import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice } from '../src/invoiceBuilder.mjs';

test('T04 visible: minimum commit true-up ineligible for credits plus post-credit taxBps', () => {
  const tiers = [{ upTo: 100, unitRateCents: 10 }];
  const grants = [{ grantId: 'g1', remainingCents: 900, effectiveFromMs: 0, expiresAtMs: 50_000 }];

  const inv = buildInvoice({
    invoiceId: 'inv-t04',
    accountId: 'acct-1',
    usageRows: [{ metric: 'requests', units: 60, tiers }], // 600 cents
    grants,
    asOfMs: 1000,
    minimumCommitCents: 1000,
    creditsEligibleForTrueUp: false,
    taxBps: 800 // 8.00%
  });

  assert.equal(inv.usageSubtotalCents, 600);
  assert.equal(inv.trueUpCents, 400);
  assert.equal(inv.preCreditSubtotalCents, 1000);
  assert.equal(inv.appliedCreditsCents, 600); // capped at usageSubtotalCents
  assert.equal(inv.netAfterCreditsCents, 400);
  assert.equal(inv.taxCents, 32); // Math.round(400 * 800 / 10000)
  assert.equal(inv.totalDueCents, 432);
});
