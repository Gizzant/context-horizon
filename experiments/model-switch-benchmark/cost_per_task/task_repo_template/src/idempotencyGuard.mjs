import { ERROR_CODES, LedgerError } from './errors.mjs';

export class IdempotencyGuard {
  #ttlMs;
  #maxEntries;
  #entries;

  /**
   * @param {{ ttlMs?: number, maxEntries?: number }} [options]
   */
  constructor(options = {}) {
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 1000;
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
      if (existing.payloadHash !== payloadHash) {
        throw new LedgerError(
          ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT,
          `Payload hash mismatch for key ${key}`
        );
      }
      if (nowMs <= existing.expiresAtMs) {
        return {
          status: 'duplicate',
          key,
          expiresAtMs: existing.expiresAtMs,
          originalRecordedAtMs: existing.recordedAtMs
        };
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
    let removed = 0;
    for (const [key, entry] of this.#entries.entries()) {
      if (nowMs > entry.expiresAtMs) {
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
