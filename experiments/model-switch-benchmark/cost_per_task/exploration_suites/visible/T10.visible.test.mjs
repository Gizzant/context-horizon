import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCreditMemos } from '../src/adapters/creditMemoAdapter.mjs';
import { buildCanonicalLedgerRows } from '../src/adapters/ledgerSnapshotAdapter.mjs';
import { reconcileSettlementBatch } from '../src/services/settlementReconciler.mjs';

test('T10 visible: credit memos exclude expired at <= asOfMs and apply negative REFUND', () => {
  const memos = normalizeCreditMemos(
    [
      { memoId: 'M1', invoiceId: 'I1', kind: 'REFUND', amountCents: 2000, expiresAtMs: 5000 },
      { memoId: 'M2', invoiceId: 'I1', kind: 'CREDIT_NOTE', amountCents: 500, expiresAtMs: 2000 }
    ],
    2000
  );
  assert.equal(memos.length, 1);
  assert.equal(memos[0].memoId, 'M1');
  assert.equal(memos[0].signedDeltaCents, -2000);
});

test('T10 visible: reconciler holds disputed invoices and respects 1c tolerance', () => {
  const raw = [
    { entryId: 'E2', invoiceId: 'I1', amountCents: 10_000, currency: 'USD', postedAtMs: 200 },
    { entryId: 'E1', invoiceId: 'I2', amountCents: 5000, currency: 'USD', postedAtMs: 50 }
  ];
  const before = JSON.stringify(raw);
  const sorted = buildCanonicalLedgerRows(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(sorted.map((x) => x.entryId), ['E1', 'E2']);

  const res = reconcileSettlementBatch({
    ledgerEntries: raw,
    creditMemos: [{ memoId: 'M1', invoiceId: 'I1', kind: 'REFUND', amountCents: 2000 }],
    payoutRecords: [{ invoiceId: 'I1', amountCents: 7999, currency: 'USD' }],
    disputedInvoiceIds: ['I2'],
    asOfMs: 100,
    toleranceCents: 1
  });
  assert.equal(res.reconciled, true);
  assert.equal(res.invoiceStatuses.I1, 'MATCHED');
  assert.equal(res.invoiceStatuses.I2, 'DISPUTE_HOLD');
  assert.equal(res.heldBackUsdCents, 5000);
});
