import { ERROR_CODES, LedgerError } from '../errors.mjs';

/**
 * Aggregates metered usage events inside `[periodStartMs, periodEndMs)` with `eventId` dedupe.
 * Refer to docs/runbooks/ENTITLEMENT_OVERAGE_RUNBOOK.md.
 */
export function aggregateMeteredUsage(events = [], {
  accountId,
  metric,
  periodStartMs,
  periodEndMs
} = {}) {
  const list = Array.isArray(events) ? events : [];
  let usedUnits = 0;
  let countedEvents = 0;
  const seenEventIds = new Set();

  for (const ev of list) {
    if (!ev) continue;
    if (accountId && ev.accountId !== accountId) continue;
    if (metric && ev.metric !== metric) continue;
    const units = Number(ev.units);
    if (!Number.isFinite(units) || units < 0) {
      throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'Usage event units must be >= 0');
    }
    const ts = Number(ev.timestampMs);
    if (ts >= periodStartMs && ts < periodEndMs) {
      const eventId = ev.eventId !== undefined && ev.eventId !== null ? String(ev.eventId).trim() : '';
      if (eventId) {
        if (seenEventIds.has(eventId)) continue;
        seenEventIds.add(eventId);
      }
      usedUnits += Math.trunc(units);
      countedEvents += 1;
    }
  }
  return { usedUnits, dedupedEventCount: countedEvents };
}
