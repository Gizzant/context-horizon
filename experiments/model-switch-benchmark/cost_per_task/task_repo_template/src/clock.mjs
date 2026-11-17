import { DEFAULT_TIME_ZONE } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';

const DAY_MS = 86_400_000;

function extractLocalParts(utcMs, timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (err) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIMEZONE, `Invalid timeZone: ${timeZone}`, { cause: err.message });
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') {
      parts[p.type] = Number(p.value);
    }
  }
  return parts;
}

function getOffsetMs(utcMs, timeZone) {
  const p = extractLocalParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Returns the billing window [startUtcMs, endUtcMs) containing `utcMs`
 * for the given IANA `timeZone` and local day anchor hour (`0..23`).
 *
 * NOTE: Naive implementation assumes fixed 24h offset from `utcMs`.
 *
 * @param {number} utcMs
 * @param {string} [timeZone='UTC']
 * @param {number} [anchorHourLocal=0]
 * @returns {{ startUtcMs: number, endUtcMs: number, localDate: string, timeZone: string }}
 */
export function getBillingWindowBounds(utcMs, timeZone = DEFAULT_TIME_ZONE, anchorHourLocal = 0) {
  if (!Number.isFinite(utcMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'utcMs must be finite');
  }
  if (!Number.isInteger(anchorHourLocal) || anchorHourLocal < 0 || anchorHourLocal > 23) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'anchorHourLocal must be integer 0..23');
  }
  const parts = extractLocalParts(utcMs, timeZone);
  const offsetMs = getOffsetMs(utcMs, timeZone);
  const anchorWallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, anchorHourLocal, 0, 0);
  let startUtcMs = anchorWallAsUtc - offsetMs;
  if (utcMs < startUtcMs) {
    startUtcMs -= DAY_MS;
  }
  const endUtcMs = startUtcMs + DAY_MS;
  const startParts = extractLocalParts(startUtcMs, timeZone);
  const localDate = `${String(startParts.year).padStart(4, '0')}-${String(startParts.month).padStart(2, '0')}-${String(startParts.day).padStart(2, '0')}`;
  return {
    startUtcMs,
    endUtcMs,
    localDate,
    timeZone
  };
}

/**
 * Enumerates daily billing windows covering [startUtcMs, endUtcMs).
 *
 * @param {number} startUtcMs
 * @param {number} endUtcMs
 * @param {string} [timeZone='UTC']
 * @param {number} [anchorHourLocal=0]
 */
export function enumerateDailyWindows(startUtcMs, endUtcMs, timeZone = DEFAULT_TIME_ZONE, anchorHourLocal = 0) {
  if (!Number.isFinite(startUtcMs) || !Number.isFinite(endUtcMs) || endUtcMs < startUtcMs) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid window range');
  }
  if (startUtcMs === endUtcMs) return [];
  const windows = [];
  let cursor = getBillingWindowBounds(startUtcMs, timeZone, anchorHourLocal);
  while (cursor.startUtcMs < endUtcMs) {
    windows.push(cursor);
    cursor = {
      ...getBillingWindowBounds(cursor.endUtcMs, timeZone, anchorHourLocal),
      startUtcMs: cursor.endUtcMs,
      endUtcMs: cursor.endUtcMs + DAY_MS
    };
  }
  return windows;
}
