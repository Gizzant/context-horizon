import { ERROR_CODES, LedgerError } from './errors.mjs';

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
