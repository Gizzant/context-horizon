import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGraduatedCharge } from '../src/tierEngine.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('T01 visible: graduated charge across multiple tiers without boundary double-count', () => {
  const tiers = [
    { upTo: 100, unitRateCents: 10 },
    { upTo: 500, unitRateCents: 5 },
    { upTo: null, unitRateCents: 2 }
  ];
  const res150 = computeGraduatedCharge(150, tiers);
  assert.equal(res150.totalCents, 1250);
  assert.deepEqual(res150.breakdown.map((b) => b.units), [100, 50]);

  const resExact = computeGraduatedCharge(100, tiers);
  assert.equal(resExact.totalCents, 1000);
  assert.equal(resExact.breakdown.length, 1);
});

test('T01 visible: zero units returns empty breakdown and negative throws', () => {
  const tiers = [{ upTo: 100, unitRateCents: 10 }];
  const res0 = computeGraduatedCharge(0, tiers);
  assert.deepEqual(res0, { totalCents: 0, breakdown: [] });

  assert.throws(
    () => computeGraduatedCharge(-5, tiers),
    (err) => err.code === ERROR_CODES.ERR_NEGATIVE_UNITS
  );
});
