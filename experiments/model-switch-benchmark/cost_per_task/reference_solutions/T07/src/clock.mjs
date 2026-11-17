import { DEFAULT_TIME_ZONE } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';

const formatCache = new Map();

function getFormatter(timeZone) {
  let fmt = formatCache.get(timeZone);
  if (!fmt) {
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
    formatCache.set(timeZone, fmt);
  }
  return fmt;
}

function extractLocalParts(utcMs, timeZone) {
  const fmt = getFormatter(timeZone);
  const parts = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

function localWallAsUtcMs(utcMs, timeZone) {
  const p = extractLocalParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function getOffsetMs(utcMs, timeZone) {
  const secFloor = Math.floor(utcMs / 1000) * 1000;
  return localWallAsUtcMs(secFloor, timeZone) - secFloor;
}

function formatYmd(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Resolves `(year, month, day, anchorHourLocal:00:00)` in `timeZone` to UTC ms:
 * - Unique local wall time -> exact UTC ms
 * - Fall-back fold -> first (pre-transition) UTC ms
 * - Spring-forward gap -> first valid post-transition UTC ms
 */
function resolveLocalAnchorUtcMs(year, month, day, anchorHourLocal, timeZone) {
  const targetWallMs = Date.UTC(year, month - 1, day, anchorHourLocal, 0, 0);
  const offEarly = getOffsetMs(targetWallMs - 16 * 3_600_000, timeZone);
  const offLate = getOffsetMs(targetWallMs + 16 * 3_600_000, timeZone);
  const candEarly = targetWallMs - offEarly;
  const candLate = targetWallMs - offLate;
  const sortedCands = [candEarly, candLate].sort((a, b) => a - b);

  for (const cand of sortedCands) {
    if (localWallAsUtcMs(cand, timeZone) === targetWallMs) {
      return cand;
    }
  }

  // Spring-forward gap: binary search (1s resolution) for smallest t with localWallAsUtcMs(t) >= targetWallMs
  let lo = Math.min(candEarly, candLate) - 4 * 3_600_000;
  let hi = Math.max(candEarly, candLate) + 4 * 3_600_000;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (localWallAsUtcMs(mid, timeZone) >= targetWallMs) {
      hi = mid;
    } else {
      lo = mid + 1000;
    }
  }
  return lo;
}

/**
 * Returns the billing window [startUtcMs, endUtcMs) containing `utcMs`.
 *
 * @param {number} utcMs
 * @param {string} [timeZone='UTC']
 * @param {number} [anchorHourLocal=0]
 */
export function getBillingWindowBounds(utcMs, timeZone = DEFAULT_TIME_ZONE, anchorHourLocal = 0) {
  if (!Number.isFinite(utcMs)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'utcMs must be finite');
  }
  if (!Number.isInteger(anchorHourLocal) || anchorHourLocal < 0 || anchorHourLocal > 23) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'anchorHourLocal must be integer 0..23');
  }
  const p = extractLocalParts(utcMs, timeZone);
  const aPrev = resolveLocalAnchorUtcMs(p.year, p.month, p.day - 1, anchorHourLocal, timeZone);
  const aCurr = resolveLocalAnchorUtcMs(p.year, p.month, p.day, anchorHourLocal, timeZone);
  const aNext = resolveLocalAnchorUtcMs(p.year, p.month, p.day + 1, anchorHourLocal, timeZone);

  if (utcMs < aCurr) {
    return {
      startUtcMs: aPrev,
      endUtcMs: aCurr,
      localDate: formatYmd(p.year, p.month, p.day - 1),
      timeZone
    };
  }
  if (utcMs < aNext) {
    return {
      startUtcMs: aCurr,
      endUtcMs: aNext,
      localDate: formatYmd(p.year, p.month, p.day),
      timeZone
    };
  }
  const aNext2 = resolveLocalAnchorUtcMs(p.year, p.month, p.day + 2, anchorHourLocal, timeZone);
  return {
    startUtcMs: aNext,
    endUtcMs: aNext2,
    localDate: formatYmd(p.year, p.month, p.day + 1),
    timeZone
  };
}

/**
 * Enumerates contiguous daily billing windows covering [startUtcMs, endUtcMs).
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
  let win = getBillingWindowBounds(startUtcMs, timeZone, anchorHourLocal);
  while (win.startUtcMs < endUtcMs) {
    windows.push(win);
    win = getBillingWindowBounds(win.endUtcMs, timeZone, anchorHourLocal);
  }
  return windows;
}
