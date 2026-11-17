import { DEFAULT_TIME_ZONE } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';

function extractLocalParts(utcMs, timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_TIMEZONE, `Invalid timeZone: ${String(timeZone)}`);
  }
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

function localPartsToAsUtcMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function getOffsetMs(utcMs, timeZone) {
  const p = extractLocalParts(utcMs, timeZone);
  return localPartsToAsUtcMs(p) - Math.floor(utcMs / 1000) * 1000;
}

function formatLocalDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves a local wall-clock instant `(year, month, day, hour, minute, second)` in `timeZone`.
 * - Unique times resolve directly.
 * - Folded (ambiguous fall-back) times resolve to the FIRST (pre-transition) UTC occurrence.
 * - Missing (spring-forward gap) times resolve to the exact first valid post-transition UTC instant.
 */
export function resolveLocalWallTimeUtcMs(year, month, day, hour = 0, minute = 0, second = 0, timeZone = DEFAULT_TIME_ZONE) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(targetAsUtc)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid calendar wall-clock inputs');
  }

  // Probe surrounding instants so folded transitions expose both pre- and post-transition offsets.
  const probes = [
    targetAsUtc - 86_400_000,
    targetAsUtc - 43_200_000,
    targetAsUtc - 14_400_000,
    targetAsUtc,
    targetAsUtc + 14_400_000,
    targetAsUtc + 43_200_000,
    targetAsUtc + 86_400_000
  ];

  const seenCandidates = new Set();
  const exactMatches = [];

  for (const probe of probes) {
    const off1 = getOffsetMs(probe, timeZone);
    const c1 = targetAsUtc - off1;
    if (!seenCandidates.has(c1)) {
      seenCandidates.add(c1);
      if (localPartsToAsUtcMs(extractLocalParts(c1, timeZone)) === targetAsUtc) {
        exactMatches.push(c1);
      }
      const off2 = getOffsetMs(c1, timeZone);
      const c2 = targetAsUtc - off2;
      if (!seenCandidates.has(c2)) {
        seenCandidates.add(c2);
        if (localPartsToAsUtcMs(extractLocalParts(c2, timeZone)) === targetAsUtc) {
          exactMatches.push(c2);
        }
      }
    }
  }

  if (exactMatches.length > 0) {
    exactMatches.sort((a, b) => a - b);
    return exactMatches[0];
  }

  // No exact match => wall clock fell inside a spring-forward gap.
  // Binary search on 1-second grid within +/-18h for the first instant whose local time >= targetAsUtc.
  let loSec = Math.floor((targetAsUtc - 18 * 3_600_000) / 1000);
  let hiSec = Math.ceil((targetAsUtc + 18 * 3_600_000) / 1000);
  while (loSec < hiSec) {
    const midSec = loSec + Math.floor((hiSec - loSec) / 2);
    const localMs = localPartsToAsUtcMs(extractLocalParts(midSec * 1000, timeZone));
    if (localMs >= targetAsUtc) {
      hiSec = midSec;
    } else {
      loSec = midSec + 1;
    }
  }
  return loSec * 1000;
}

/**
 * Returns the daily billing window [startUtcMs, endUtcMs) containing `utcMs`
 * for the given IANA `timeZone` and local day anchor hour (`0..23`).
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
  const todayStart = resolveLocalWallTimeUtcMs(parts.year, parts.month, parts.day, anchorHourLocal, 0, 0, timeZone);

  let startUtcMs;
  let endUtcMs;
  if (utcMs < todayStart) {
    endUtcMs = todayStart;
    const prevDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
    startUtcMs = resolveLocalWallTimeUtcMs(
      prevDate.getUTCFullYear(),
      prevDate.getUTCMonth() + 1,
      prevDate.getUTCDate(),
      anchorHourLocal,
      0,
      0,
      timeZone
    );
  } else {
    startUtcMs = todayStart;
    const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    endUtcMs = resolveLocalWallTimeUtcMs(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      anchorHourLocal,
      0,
      0,
      timeZone
    );
  }

  const startParts = extractLocalParts(startUtcMs, timeZone);
  const localDate = formatLocalDate(startParts.year, startParts.month, startParts.day);
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
    cursor = getBillingWindowBounds(cursor.endUtcMs, timeZone, anchorHourLocal);
  }
  return windows;
}

/**
 * Computes monthly anchor-clamped cycle bounds [startUtcMs, endUtcMs) in `timeZone`.
 *
 * @param {object} params
 * @returns {{ startUtcMs: number, endUtcMs: number, startLocalDate: string, endLocalDate: string, timeZone: string }}
 */
export function getMonthlyCycleBounds({
  year,
  month,
  anchorDay,
  timeZone = DEFAULT_TIME_ZONE,
  anchorHourLocal = 0
} = {}) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'year must be integer and month must be 1..12');
  }
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'anchorDay must be integer 1..31');
  }
  if (!Number.isInteger(anchorHourLocal) || anchorHourLocal < 0 || anchorHourLocal > 23) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'anchorHourLocal must be integer 0..23');
  }

  const startDay = Math.min(anchorDay, daysInMonth(year, month));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endDay = Math.min(anchorDay, daysInMonth(nextYear, nextMonth));

  const startUtcMs = resolveLocalWallTimeUtcMs(year, month, startDay, anchorHourLocal, 0, 0, timeZone);
  const endUtcMs = resolveLocalWallTimeUtcMs(nextYear, nextMonth, endDay, anchorHourLocal, 0, 0, timeZone);

  return {
    startUtcMs,
    endUtcMs,
    startLocalDate: formatLocalDate(year, month, startDay),
    endLocalDate: formatLocalDate(nextYear, nextMonth, endDay),
    timeZone
  };
}
