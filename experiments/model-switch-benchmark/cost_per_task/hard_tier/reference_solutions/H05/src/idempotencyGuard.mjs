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

  #evictIfFull() {
    while (this.#entries.size >= this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.#entries.delete(oldestKey);
    }
  }

  /**
   * Legacy record/check helper preserved for baseline idempotency behavior.
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
        if (existing.state === 'COMPENSATION_FAILED') {
          throw new LedgerError(ERROR_CODES.ERR_COMPENSATION_FAILED, `Key ${key} is in COMPENSATION_FAILED state`);
        }
        if (existing.payloadHash !== payloadHash) {
          throw new LedgerError(ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT, `Payload hash mismatch for key ${key}`);
        }
        if (existing.state === 'IN_FLIGHT') {
          throw new LedgerError(ERROR_CODES.ERR_IDEMPOTENCY_IN_FLIGHT, `Key ${key} is currently IN_FLIGHT`);
        }
        return {
          status: 'duplicate',
          key,
          expiresAtMs: existing.expiresAtMs,
          originalRecordedAtMs: existing.recordedAtMs
        };
      }
    }

    this.#evictIfFull();
    const entry = {
      state: 'SUCCEEDED',
      payloadHash,
      recordedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
      resultSnapshot: null,
      compensationInfo: null
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
   * Begins an IN_FLIGHT saga attempt or replays cached SUCCEEDED result.
   */
  beginInFlight(key, payloadHash, nowMs) {
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
        if (existing.state === 'COMPENSATION_FAILED') {
          throw new LedgerError(
            ERROR_CODES.ERR_COMPENSATION_FAILED,
            `Idempotency key ${key} requires manual reconciliation (COMPENSATION_FAILED)`,
            existing.compensationInfo || undefined
          );
        }
        if (existing.payloadHash !== payloadHash) {
          throw new LedgerError(ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT, `Payload hash mismatch for key ${key}`);
        }
        if (existing.state === 'IN_FLIGHT') {
          throw new LedgerError(ERROR_CODES.ERR_IDEMPOTENCY_IN_FLIGHT, `Request already in-flight for key ${key}`);
        }
        if (existing.state === 'SUCCEEDED') {
          return {
            status: 'replayed',
            cachedResult: structuredClone(existing.resultSnapshot)
          };
        }
      }
    }

    this.#evictIfFull();
    const entry = {
      state: 'IN_FLIGHT',
      payloadHash,
      recordedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
      resultSnapshot: null,
      compensationInfo: null
    };
    this.#entries.set(key, entry);
    return { status: 'started', expiresAtMs: entry.expiresAtMs };
  }

  markSucceeded(key, payloadHash, resultSnapshot, nowMs) {
    this.#entries.set(key, {
      state: 'SUCCEEDED',
      payloadHash,
      recordedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
      resultSnapshot: structuredClone(resultSnapshot),
      compensationInfo: null
    });
  }

  markFailedRelease(key, payloadHash) {
    const existing = this.#entries.get(key);
    if (existing && existing.payloadHash === payloadHash && existing.state === 'IN_FLIGHT') {
      this.#entries.delete(key);
    }
  }

  markCompensationFailed(key, payloadHash, info, nowMs) {
    this.#entries.set(key, {
      state: 'COMPENSATION_FAILED',
      payloadHash,
      recordedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
      resultSnapshot: null,
      compensationInfo: structuredClone(info)
    });
  }

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
