import test from 'node:test';
import assert from 'node:assert/strict';
import { createClosedPeriodLedger } from '../src/invoiceBuilder.mjs';

test('H06 visible: retroactive subtraction in month 1 waterfalls freed expiring credit into month 2', () => {
  const janEnd = Date.UTC(2026, 1, 1, 0, 0, 0);
  const febStart = janEnd;
  const febEnd = Date.UTC(2026, 2, 1, 0, 0, 0);
  const ledger = createClosedPeriodLedger({
    accountId: 'acct-retro',
    timeZone: 'UTC',
    anchorHourLocal: 0,
    grants: [{ grantId: 'g1', remainingCents: 500, effectiveFromMs: 0, expiresAtMs: Date.UTC(2026, 3, 1) }],
    metricTiers: { api: [{ upTo: null, unitRateCents: 10 }] }
  });

  const jan = ledger.closePeriod({
    periodKey: '2026-01',
    year: 2026,
    month: 1,
    anchorDay: 1,
    events: [{ metric: 'api', units: 50, timestampMs: Date.UTC(2026, 0, 15) }] // 500c -> 500c credit, 0 due
  });
  const feb = ledger.closePeriod({
    periodKey: '2026-02',
    year: 2026,
    month: 2,
    anchorDay: 1,
    events: [{ metric: 'api', units: 30, timestampMs: febStart + 1000 }] // 300c -> 0 credit left, 300 due
  });
  assert.equal(feb.totalDueCents, 300);

  const res = ledger.applyRetroactiveAmendment({
    amendmentId: 'am-1',
    targetPeriodKey: '2026-01',
    op: 'SUBTRACT',
    events: [{ metric: 'api', units: 20 }] // Jan drops 500->300, freeing 200c credit for Feb!
  });
  assert.equal(res.memos.length, 2);
  assert.equal(res.memos[0].type, 'REALLOCATION_MEMO');
  assert.equal(res.memos[0].deltaCreditsCents, -200);
  assert.equal(res.memos[1].type, 'CREDIT_MEMO');
  assert.equal(res.memos[1].deltaDueCents, -200);
  // Original closed invoice digest untouched
  assert.equal(ledger.getEffectiveLedgerSummary().closedInvoices[0].wireDigest, jan.wireDigest);
  assert.ok(febEnd > febStart);
});
