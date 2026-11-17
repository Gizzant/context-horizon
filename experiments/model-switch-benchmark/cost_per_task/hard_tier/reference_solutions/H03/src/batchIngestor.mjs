import { ERROR_CODES, LedgerError } from './errors.mjs';
import { UsageCursor } from './usageCursor.mjs';
import { IdempotencyGuard } from './idempotencyGuard.mjs';

export class BatchIngestor {
  #maxBatchSize;
  #sinkFn;
  #buffer;
  #committedWatermarkSeq;
  #totalCommitted;
  #flushChain;

  /**
   * @param {{ maxBatchSize?: number, sinkFn: (batch: Array<object>) => Promise<void> }} options
   */
  constructor(options = {}) {
    if (typeof options.sinkFn !== 'function') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'sinkFn must be a function');
    }
    const maxBatchSize = options.maxBatchSize ?? 50;
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxBatchSize must be positive integer');
    }
    this.#maxBatchSize = maxBatchSize;
    this.#sinkFn = options.sinkFn;
    this.#buffer = [];
    this.#committedWatermarkSeq = 0;
    this.#totalCommitted = 0;
    this.#flushChain = Promise.resolve();
  }

  async ingest(event) {
    if (!event || !Number.isInteger(event.seq) || typeof event.metric !== 'string') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Event must have integer seq and string metric');
    }
    this.#buffer.push({ ...event });
    if (this.#buffer.length >= this.#maxBatchSize) {
      await this.flush();
    }
  }

  flush() {
    const run = this.#flushChain.then(async () => {
      if (this.#buffer.length === 0) return { flushedCount: 0 };
      const batch = this.#buffer.splice(0, this.#buffer.length);
      try {
        await this.#sinkFn(batch);
      } catch (err) {
        this.#buffer.unshift(...batch);
        throw err;
      }
      for (const item of batch) {
        if (item.seq > this.#committedWatermarkSeq) {
          this.#committedWatermarkSeq = item.seq;
        }
      }
      this.#totalCommitted += batch.length;
      return { flushedCount: batch.length };
    });
    this.#flushChain = run.catch(() => {});
    return run;
  }

  get pendingCount() {
    return this.#buffer.length;
  }

  get committedWatermarkSeq() {
    return this.#committedWatermarkSeq;
  }

  get totalCommitted() {
    return this.#totalCommitted;
  }
}

export class PartitionedBatchCoordinator {
  #maxBatchSize;
  #maxConcurrentFlushes;
  #maxRetries;
  #sinkFn;
  #onDeadLetter;
  #guard;
  #cursor;
  #partitions;
  #deadLetters;
  #committedCount;
  #deadLetterCount;
  #shuttingDown;
  #activeFlushes;
  #flushWaiters;

  /**
   * @param {object} options
   */
  constructor(options = {}) {
    const {
      maxBatchSize = 50,
      maxConcurrentFlushes = 4,
      maxRetries = 2,
      ttlMs = 60_000,
      maxIdempotencyEntries = 10_000,
      sinkFn,
      onDeadLetter = null
    } = options || {};

    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxBatchSize must be integer >= 1');
    }
    if (!Number.isInteger(maxConcurrentFlushes) || maxConcurrentFlushes < 1) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxConcurrentFlushes must be integer >= 1');
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxRetries must be integer >= 0');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'ttlMs must be > 0');
    }
    if (!Number.isInteger(maxIdempotencyEntries) || maxIdempotencyEntries < 1) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'maxIdempotencyEntries must be integer >= 1');
    }
    if (typeof sinkFn !== 'function') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'sinkFn must be a function');
    }
    if (onDeadLetter !== null && typeof onDeadLetter !== 'function') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'onDeadLetter must be null or a function');
    }

    this.#maxBatchSize = maxBatchSize;
    this.#maxConcurrentFlushes = maxConcurrentFlushes;
    this.#maxRetries = maxRetries;
    this.#sinkFn = sinkFn;
    this.#onDeadLetter = onDeadLetter;
    this.#guard = new IdempotencyGuard({ ttlMs, maxEntries: maxIdempotencyEntries });
    this.#cursor = new UsageCursor();
    this.#partitions = new Map();
    this.#deadLetters = [];
    this.#committedCount = 0;
    this.#deadLetterCount = 0;
    this.#shuttingDown = false;
    this.#activeFlushes = 0;
    this.#flushWaiters = [];
  }

  #getPartition(accountId) {
    let p = this.#partitions.get(accountId);
    if (!p) {
      p = { buffer: [], chain: Promise.resolve(), inFlight: false };
      this.#partitions.set(accountId, p);
    }
    return p;
  }

  async #acquireFlushSlot() {
    if (this.#activeFlushes < this.#maxConcurrentFlushes) {
      this.#activeFlushes += 1;
      return;
    }
    await new Promise((resolve) => this.#flushWaiters.push(resolve));
  }

  #releaseFlushSlot() {
    const next = this.#flushWaiters.shift();
    if (next) {
      next();
    } else {
      this.#activeFlushes -= 1;
    }
  }

  async #flushSingleBatch(accountId, batch) {
    await this.#acquireFlushSlot();
    let succeeded = false;
    let lastError = null;
    try {
      for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
        try {
          await this.#sinkFn(batch);
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
          if (err && err.retryable === false) {
            break;
          }
        }
      }
    } finally {
      this.#releaseFlushSlot();
    }

    const seqs = batch.map((e) => e.seq);
    if (succeeded) {
      this.#committedCount += batch.length;
      this.#cursor.markCommitted(seqs);
      return;
    }

    this.#deadLetters.push({ accountId, batch, error: lastError });
    this.#deadLetterCount += batch.length;
    if (this.#onDeadLetter) {
      await this.#onDeadLetter(batch, lastError);
    }
    this.#cursor.markSkipped(seqs);
  }

  /**
   * Validates, deduplicates, buffers, and flushes partitioned events.
   *
   * @param {object} event
   */
  async ingest(event) {
    if (this.#shuttingDown) {
      throw new LedgerError(ERROR_CODES.ERR_SHUTTING_DOWN, 'Coordinator is shutting down');
    }
    if (
      !event ||
      typeof event !== 'object' ||
      typeof event.accountId !== 'string' ||
      event.accountId.length === 0 ||
      typeof event.key !== 'string' ||
      event.key.length === 0 ||
      typeof event.payloadHash !== 'string' ||
      !Number.isInteger(event.seq) ||
      event.seq < 1 ||
      typeof event.metric !== 'string' ||
      event.metric.length === 0 ||
      !Number.isFinite(event.units) ||
      event.units < 0 ||
      !Number.isFinite(event.nowMs)
    ) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Invalid partitioned ingest event');
    }

    const idem = this.#guard.checkAndRecord(event.key, event.payloadHash, event.nowMs);
    if (idem.status === 'duplicate') {
      return { status: 'duplicate', seq: event.seq };
    }

    const partition = this.#getPartition(event.accountId);
    partition.buffer.push({ ...event });
    if (partition.buffer.length >= this.#maxBatchSize) {
      await this.flushPartition(event.accountId);
    }
    return { status: 'accepted', seq: event.seq };
  }

  /**
   * Flushes all buffered batches for `accountId` serially in FIFO order.
   *
   * @param {string} accountId
   */
  flushPartition(accountId) {
    const partition = this.#partitions.get(accountId);
    if (!partition) return Promise.resolve();

    const run = partition.chain.then(async () => {
      partition.inFlight = true;
      try {
        while (partition.buffer.length > 0) {
          const batch = partition.buffer.splice(0, this.#maxBatchSize);
          await this.#flushSingleBatch(accountId, batch);
        }
      } finally {
        partition.inFlight = false;
      }
    });
    partition.chain = run.catch(() => {});
    return run;
  }

  /**
   * Triggers flushes for all partitions and waits until empty/idle, or aborts via `signal`.
   *
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async drain({ signal } = {}) {
    if (signal?.aborted) {
      throw new LedgerError(ERROR_CODES.ERR_ABORTED, 'Drain aborted before starting');
    }

    const pending = [];
    for (const [accountId, partition] of this.#partitions.entries()) {
      if (partition.buffer.length > 0 || partition.inFlight) {
        pending.push(this.flushPartition(accountId));
      } else {
        pending.push(partition.chain);
      }
    }
    const allWork = Promise.all(pending);
    if (!signal) {
      await allWork;
      return;
    }

    let onAbort;
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => reject(new LedgerError(ERROR_CODES.ERR_ABORTED, 'Drain aborted via AbortSignal'));
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      await Promise.race([allWork, abortPromise]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Stops new ingestion, flushes all buffered events, and returns final counts & watermarks.
   */
  async shutdown() {
    this.#shuttingDown = true;
    await this.drain();
    return {
      committedCount: this.#committedCount,
      deadLetterCount: this.#deadLetterCount,
      watermarks: this.#cursor.getWatermarks()
    };
  }

  getDeadLetters() {
    return this.#deadLetters.map((d) => ({
      accountId: d.accountId,
      batch: d.batch.map((e) => ({ ...e })),
      error: d.error
    }));
  }

  getWatermarks() {
    return this.#cursor.getWatermarks();
  }
}
