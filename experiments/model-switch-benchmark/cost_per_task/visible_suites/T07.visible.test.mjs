import test from 'node:test';
import assert from 'node:assert/strict';
import { getBillingWindowBounds, enumerateDailyWindows } from '../src/clock.mjs';

test('T07 visible: New York spring-forward day has 23h window and contiguous enumeration', () => {
  const springDay = getBillingWindowBounds(Date.UTC(2026, 2, 8, 12, 0, 0), 'America/New_York', 0);
  assert.equal(springDay.localDate, '2026-03-08');
  assert.equal(springDay.startUtcMs, Date.UTC(2026, 2, 8, 5, 0, 0));
  assert.equal(springDay.endUtcMs, Date.UTC(2026, 2, 9, 4, 0, 0));
  assert.equal(springDay.endUtcMs - springDay.startUtcMs, 23 * 3_600_000);

  const windows = enumerateDailyWindows(
    Date.UTC(2026, 2, 7, 10, 0, 0),
    Date.UTC(2026, 2, 10, 10, 0, 0),
    'America/New_York',
    0
  );
  assert.equal(windows.length, 4);
  for (let i = 0; i < windows.length - 1; i += 1) {
    assert.equal(windows[i].endUtcMs, windows[i + 1].startUtcMs);
  }
});
