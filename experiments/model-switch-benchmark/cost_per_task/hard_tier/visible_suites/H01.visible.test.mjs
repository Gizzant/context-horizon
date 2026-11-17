import test from 'node:test';
import assert from 'node:assert/strict';
import { getMonthlyCycleBounds } from '../src/clock.mjs';
import { buildProratedCycleInvoice } from '../src/invoiceBuilder.mjs';

test('H01 visible: anchorDay=31 clamps Feb/Mar without drift and prorates mid-cycle plan change', () => {
  const feb = getMonthlyCycleBounds({ year: 2026, month: 2, anchorDay: 31, timeZone: 'UTC', anchorHourLocal: 0 });
  assert.equal(feb.startLocalDate, '2026-02-28');
  assert.equal(feb.endLocalDate, '2026-03-31');

  const cycle = getMonthlyCycleBounds({ year: 2026, month: 4, anchorDay: 1, timeZone: 'UTC', anchorHourLocal: 0 });
  const midUtc = cycle.startUtcMs + (cycle.endUtcMs - cycle.startUtcMs) / 2;
  const inv = buildProratedCycleInvoice({
    invoiceId: 'inv-h01-v',
    accountId: 'acct-1',
    year: 2026,
    month: 4,
    anchorDay: 1,
    timeZone: 'UTC',
    planChanges: [
      { effectiveAtUtcMs: cycle.startUtcMs, planId: 'starter', monthlyFeeCents: 1000, metricTiers: { api: [{ upTo: 100, unitRateCents: 10 }, { upTo: null, unitRateCents: 5 }] } },
      { effectiveAtUtcMs: midUtc, planId: 'pro', monthlyFeeCents: 3000, metricTiers: { api: [{ upTo: 100, unitRateCents: 8 }, { upTo: null, unitRateCents: 4 }] } }
    ],
    events: [
      { metric: 'api', units: 60, timestampMs: cycle.startUtcMs + 1000 }, // starter half-month upTo=50: 50*10 + 10*5 = 550
      { metric: 'api', units: 60, timestampMs: midUtc + 1000 } // pro half-month upTo=50: 50*8 + 10*4 = 440
    ]
  });
  assert.equal(inv.usageSubtotalCents, 500 + 550 + 1500 + 440);
  assert.equal(inv.totalDueCents, 2990);
});
