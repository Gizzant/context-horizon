import test from 'node:test';
import assert from 'node:assert/strict';
import { computeProratedAllowanceAndFee } from '../src/policies/prorationPolicy.mjs';
import { aggregateMeteredUsage } from '../src/adapters/usageMeterAdapter.mjs';
import { evaluateSubscriptionEntitlement } from '../src/services/entitlementRouter.mjs';

test('T11 visible: actual 31-day month proration and inclusive boundary with eventId dedupe', () => {
  const janStart = Date.UTC(2026, 0, 1);
  const janEnd = Date.UTC(2026, 1, 1); // 31 days
  const midStart = Date.UTC(2026, 0, 16); // remaining 16 days (16..31)
  const pro = computeProratedAllowanceAndFee({
    annualOrMonthlyFeeCents: 3100,
    includedUnits: 310,
    planStartMs: midStart,
    planEndMs: janEnd,
    periodStartMs: janStart,
    periodEndMs: janEnd
  });
  assert.equal(pro.proratedFeeCents, 1600);
  assert.equal(pro.proratedUnits, 160);

  const usage = aggregateMeteredUsage(
    [
      { eventId: 'ev1', accountId: 'A1', metric: 'api', units: 50, timestampMs: janStart },
      { eventId: 'ev1', accountId: 'A1', metric: 'api', units: 50, timestampMs: janStart + 10 },
      { eventId: 'ev2', accountId: 'A1', metric: 'api', units: 20, timestampMs: janEnd }
    ],
    { accountId: 'A1', metric: 'api', periodStartMs: janStart, periodEndMs: janEnd }
  );
  assert.equal(usage.usedUnits, 50);
  assert.equal(usage.dedupedEventCount, 1);
});

test('T11 visible: SOFT_GRACE exposes effectiveAllowance and absorbs grace buffer', () => {
  const pStart = Date.UTC(2026, 1, 1);
  const pEnd = Date.UTC(2026, 2, 1); // 28 days
  const res = evaluateSubscriptionEntitlement({
    accountId: 'A1',
    metric: 'api',
    baseFeeCents: 2800,
    includedUnits: 1000,
    graceBufferUnits: 150,
    overageUnitRateCents: 5,
    policyMode: 'SOFT_GRACE',
    periodStartMs: pStart,
    periodEndMs: pEnd,
    usageEvents: [{ eventId: 'e1', accountId: 'A1', metric: 'api', units: 1120, timestampMs: pStart }]
  });
  assert.equal(res.effectiveAllowance, 1150);
  assert.equal(res.allowed, true);
  assert.equal(res.status, 'GRACE_ALLOWED');
  assert.equal(res.overageUnits, 0);
});
