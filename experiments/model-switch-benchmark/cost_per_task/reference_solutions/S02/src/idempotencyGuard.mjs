import { ERROR_CODES, LedgerError } from './errors.mjs';

export class IdempotencyGuard {
  #ttlMs;
  #maxEntries;
  #entries;

  constructor(options = {}) {
    const ttlMs = options.ttlMs ?? 60_000;
    const maxEntries = options.maxEntries ?? 1000;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_TTL, 'ttlMs must be > 0');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxEntries must be >= 1');
    }
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#entries = new Map();
  }

  snapshot() {
    return [...this.#entries.entries()].map(([k, v]) => [k, { ...v }]);
  }

  restore(snap) {
    this.#entries = new Map(snap.map(([k, v]) => [k, { ...v }]));
  }

  checkAndRecord(key, payloadHash, nowMs) {
    if (!key || typeof key !== 'string' || !payloadHash || typeof payloadHash !== 'string' || !Number.isFinite(nowMs)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Invalid idempotency record args');
    }
    const existing = this.#entries.get(key);
    if (existing) {
      if (nowMs < existing.expiresAtMs) {
        if (existing.payloadHash !== payloadHash) {
          throw new LedgerError(ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT, `Payload hash mismatch for key ${key}`);
        }
        return {
          status: 'duplicate',
          key,
          expiresAtMs: existing.expiresAtMs,
          originalRecordedAtMs: existing.recordedAtMs
        };
      }
      this.#entries.delete(key);
    }
    this.pruneExpired(nowMs);
    while (this.#entries.size >= this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    const entry = { payloadHash, recordedAtMs: nowMs, expiresAtMs: nowMs + this.#ttlMs };
    this.#entries.set(key, entry);
    return {
      status: 'accepted',
      key,
      expiresAtMs: entry.expiresAtMs,
      originalRecordedAtMs: entry.recordedAtMs
    };
  }

  pruneExpired(nowMs) {
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
