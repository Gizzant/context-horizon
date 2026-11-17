import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter } from '../src/queryDsl.mjs';
import { getBillingWindowBounds, enumerateDailyWindows } from '../src/clock.mjs';

test('queryDsl compiles basic comparisons and AND', () => {
  const pred = compileFilter('status == "ok" AND count >= 10');
  assert.equal(pred({ status: 'ok', count: 12 }), true);
  assert.equal(pred({ status: 'ok', count: 5 }), false);
  assert.equal(pred({ status: 'err', count: 12 }), false);
});

test('clock computes UTC and winter New York windows', () => {
  const utcWin = getBillingWindowBounds(Date.UTC(2026, 0, 15, 14, 30, 0), 'UTC', 0);
  assert.equal(utcWin.localDate, '2026-01-15');
  assert.equal(utcWin.startUtcMs, Date.UTC(2026, 0, 15, 0, 0, 0));
  assert.equal(utcWin.endUtcMs, Date.UTC(2026, 0, 16, 0, 0, 0));

  const nyWin = getBillingWindowBounds(Date.UTC(2026, 0, 15, 15, 0, 0), 'America/New_York', 0);
  assert.equal(nyWin.localDate, '2026-01-15');
  assert.equal(nyWin.startUtcMs, Date.UTC(2026, 0, 15, 5, 0, 0));

  const list = enumerateDailyWindows(Date.UTC(2026, 0, 15, 0, 0, 0), Date.UTC(2026, 0, 17, 0, 0, 0), 'UTC', 0);
  assert.equal(list.length, 2);
});
