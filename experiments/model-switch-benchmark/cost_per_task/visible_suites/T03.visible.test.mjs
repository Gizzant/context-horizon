import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCredits } from '../src/creditPool.mjs';

test('T03 visible: consumes earliest-expiring active grants without mutating inputs', () => {
  const grants = [
    { grantId: 'g-late', remainingCents: 500, effectiveFromMs: 0, expiresAtMs: 90_000 },
    { grantId: 'g-expired', remainingCents: 500, effectiveFromMs: 0, expiresAtMs: 5_000 },
    { grantId: 'g-soon', remainingCents: 300, effectiveFromMs: 1_000, expiresAtMs: 20_000 }
  ];
  const snapshotBefore = JSON.stringify(grants);
  const res = applyCredits(450, grants, 10_000);

  assert.equal(res.appliedCents, 450);
  assert.equal(res.remainingChargeCents, 0);
  assert.deepEqual(res.allocations, [
    { grantId: 'g-soon', appliedCents: 300 },
    { grantId: 'g-late', appliedCents: 150 }
  ]);
  assert.equal(JSON.stringify(grants), snapshotBefore);
});
