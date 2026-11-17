import crypto from 'node:crypto';
import { ERROR_CODES, LedgerError } from './errors.mjs';

function canonicalizeValue(value, ancestors) {
  if (value === undefined) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'undefined is not valid in canonical payload');
  }
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Non-finite numbers are not valid in canonical payload');
    }
    const normalizedNum = Object.is(value, -0) ? 0 : value;
    return String(normalizedNum);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value.normalize('NFC'));
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, `Unsupported type ${typeof value} in canonical payload`);
  }

  if (ancestors.has(value)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Circular reference detected in canonical payload');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => canonicalizeValue(item, ancestors));
      return `[${items.join(',')}]`;
    }

    const seenNfc = new Set();
    const entries = [];
    for (const rawKey of Object.keys(value)) {
      const nfcKey = rawKey.normalize('NFC');
      if (seenNfc.has(nfcKey)) {
        throw new LedgerError(
          ERROR_CODES.ERR_CANONICAL_COLLISION,
          `Distinct keys normalize to identical NFC key: ${nfcKey}`
        );
      }
      seenNfc.add(nfcKey);
      const propVal = value[rawKey];
      if (propVal === undefined) continue;
      entries.push({ nfcKey, propVal });
    }

    entries.sort((a, b) => (a.nfcKey < b.nfcKey ? -1 : a.nfcKey > b.nfcKey ? 1 : 0));
    const serializedPairs = entries.map(
      (entry) => `${JSON.stringify(entry.nfcKey)}:${canonicalizeValue(entry.propVal, ancestors)}`
    );
    return `{${serializedPairs.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Computes deterministic NFC-canonical lowercase hex SHA-256 hash of `payload`.
 *
 * @param {any} payload
 * @returns {string}
 */
export function computeCanonicalPayloadHash(payload) {
  const canonicalJson = canonicalizeValue(payload, new Set());
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export class IdempotencyGuard {
  #ttlMs;
  #maxEntries;
  #entries;

  /**
   * @param {{ ttlMs?: number, maxEntries?: number }} [options]
   */
  constructor(options = {}) {
    const ttlMs = options.ttlMs ?? 60_000;
    const maxEntries = options.maxEntries ?? 1000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TTL, 'ttlMs must be finite and > 0');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxEntries must be integer >= 1');
    }
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#entries = new Map();
  }

  /**
   * Records or checks an idempotency key.
   *
   * @param {string} key
   * @param {string} payloadHash
   * @param {number} nowMs
   * @returns {{ status: 'accepted' | 'duplicate', key: string, expiresAtMs: number, originalRecordedAtMs: number }}
   */
  checkAndRecord(key, payloadHash, nowMs) {
    if (!key || typeof key !== 'string') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Idempotency key must be a non-empty string');
    }
    if (!Number.isFinite(nowMs)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'nowMs must be finite');
    }

    const existing = this.#entries.get(key);
    if (existing) {
      if (nowMs >= existing.expiresAtMs) {
        this.#entries.delete(key);
      } else {
        if (existing.payloadHash !== payloadHash) {
          throw new LedgerError(
            ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT,
            `Payload hash mismatch for key ${key}`
          );
        }
        return {
          status: 'duplicate',
          key,
          expiresAtMs: existing.expiresAtMs,
          originalRecordedAtMs: existing.recordedAtMs
        };
      }
    }

    if (this.#entries.size >= this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.#entries.delete(oldestKey);
      }
    }

    const entry = {
      payloadHash,
      recordedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs
    };
    this.#entries.set(key, entry);
    return {
      status: 'accepted',
      key,
      expiresAtMs: entry.expiresAtMs,
      originalRecordedAtMs: entry.recordedAtMs
    };
  }

  /**
   * Removes expired keys as of `nowMs` and returns count removed.
   *
   * @param {number} nowMs
   * @returns {number}
   */
  pruneExpired(nowMs) {
    if (!Number.isFinite(nowMs)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'nowMs must be finite');
    }
    let removed = 0;
    for (const [key, entry] of this.#entries.entries()) {
      if (nowMs >= entry.expiresAtMs) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.#entries.size;
  }
}
