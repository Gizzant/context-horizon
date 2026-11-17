import { ERROR_CODES, LedgerError } from './errors.mjs';

export class BatchIngestor {
  #maxBatchSize;
  #sinkFn;
  #buffer;
  #committedWatermarkSeq;
  #totalCommitted;

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
  }

  /**
   * Buffers one event and triggers a flush if `maxBatchSize` is reached.
   *
   * @param {{ seq: number, metric: string, units: number }} event
   */
  async ingest(event) {
    if (!event || !Number.isInteger(event.seq) || typeof event.metric !== 'string') {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Event must have integer seq and string metric');
    }
    this.#buffer.push({ ...event });
    if (this.#buffer.length >= this.#maxBatchSize) {
      await this.flush();
    }
  }

  /**
   * Flushes all buffered events through `sinkFn`.
   */
  async flush() {
    if (this.#buffer.length === 0) return { flushedCount: 0 };
    const batch = this.#buffer.splice(0, this.#buffer.length);
    await this.#sinkFn(batch);
    for (const item of batch) {
      if (item.seq > this.#committedWatermarkSeq) {
        this.#committedWatermarkSeq = item.seq;
      }
    }
    this.#totalCommitted += batch.length;
    return { flushedCount: batch.length };
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
