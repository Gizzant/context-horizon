import { ERROR_CODES, LedgerError } from './errors.mjs';

export class BatchIngestor {
  #maxBatchSize;
  #sinkFn;
  #buffer;
  #committedWatermarkSeq;
  #totalCommitted;
  #queue;

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
    this.#queue = Promise.resolve();
  }

  snapshot() {
    return {
      buffer: this.#buffer.map((e) => ({ ...e })),
      committedWatermarkSeq: this.#committedWatermarkSeq,
      totalCommitted: this.#totalCommitted
    };
  }

  restore(snap) {
    this.#buffer = snap.buffer.map((e) => ({ ...e }));
    this.#committedWatermarkSeq = snap.committedWatermarkSeq;
    this.#totalCommitted = snap.totalCommitted;
  }

  #enqueue(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #flushLocked() {
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

  async flush() {
    return this.#enqueue(() => this.#flushLocked());
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

export async function ingestTransactionalBatch(guard, ingestor, events, nowMs) {
  if (!Array.isArray(events)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'events must be an array');
  }
  const guardSnap = guard.snapshot();
  const ingestSnap = ingestor.snapshot();

  try {
    const toQueue = [];
    for (const evt of events) {
      if (!evt || !Number.isInteger(evt.seq) || typeof evt.metric !== 'string') {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Invalid event shape');
      }
      const res = guard.checkAndRecord(evt.key, evt.payloadHash, nowMs);
      if (res.status === 'accepted') {
        toQueue.push({ seq: evt.seq, metric: evt.metric, units: evt.units });
      }
    }
    for (const item of toQueue) {
      await ingestor.ingest(item);
    }
    return { acceptedCount: toQueue.length };
  } catch (err) {
    guard.restore(guardSnap);
    ingestor.restore(ingestSnap);
    throw err;
  }
}
