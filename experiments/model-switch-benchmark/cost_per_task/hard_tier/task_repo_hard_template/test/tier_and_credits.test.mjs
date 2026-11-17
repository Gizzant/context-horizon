import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGraduatedCharge, computeVolumeCharge } from '../src/tierEngine.mjs';
import { applyCredits, summarizePoolBalance } from '../src/creditPool.mjs';
import { convertMinorUnits } from '../src/fxConverter.mjs';

test('graduated charge within first tier', () => {
  const tiers = [
    { upTo: 100, unitRateCents: 10 },
    { upTo: null, unitRateCents: 5 }
  ];
  const res = computeGraduatedCharge(50, tiers);
  assert.equal(res.totalCents, 500);
  assert.equal(res.breakdown.length, 1);
  assert.equal(res.breakdown[0].units, 50);
});

test('volume charge selects matching tier', () => {
  const tiers = [
    { upTo: 100, unitRateCents: 10 },
    { upTo: null, unitRateCents: 6 }
  ];
  const res = computeVolumeCharge(150, tiers);
  assert.equal(res.totalCents, 900);
  assert.equal(res.matchedTierIndex, 1);
});

test('applyCredits reduces charge from active grant', () => {
  const grants = [
    { grantId: 'g1', remainingCents: 800, effectiveFromMs: 0, expiresAtMs: 50_000 }
  ];
  const res = applyCredits(500, grants, 10_000);
  assert.equal(res.appliedCents, 500);
  assert.equal(res.remainingChargeCents, 0);
  assert.deepEqual(res.allocations, [{ grantId: 'g1', appliedCents: 500 }]);
});

test('summarizePoolBalance sums positive grants', () => {
  const grants = [
    { grantId: 'g1', remainingCents: 400, effectiveFromMs: 0, expiresAtMs: 50_000 },
    { grantId: 'g2', remainingCents: 0, effectiveFromMs: 0, expiresAtMs: 50_000 }
  ];
  const summary = summarizePoolBalance(grants, 10_000);
  assert.equal(summary.availableCents, 400);
  assert.equal(summary.activeCount, 1);
});

test('convertMinorUnits converts direct FX quote', () => {
  const quotes = [{ from: 'USD', to: 'EUR', rateNum: 92, rateDen: 100, quoteTimestampMs: 1000 }];
  assert.equal(convertMinorUnits(1000, 'USD', 'EUR', quotes), 920);
});
