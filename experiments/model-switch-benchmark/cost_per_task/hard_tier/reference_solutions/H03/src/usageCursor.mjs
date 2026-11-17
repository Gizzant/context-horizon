import { ERROR_CODES, LedgerError } from './errors.mjs';

/**
 * Tracks committed and skipped sequence numbers with out-of-order contiguous low-watermark computation.
 */
export class UsageCursor {
  #highestCommittedSeq;
  #contiguousWatermarkSeq;
  #committed;
  #skipped;

  constructor() {
    this.#highestCommittedSeq = 0;
    this.#contiguousWatermarkSeq = 0;
    this.#committed = new Set();
    this.#skipped = new Set();
  }

  #validateSeqs(seqs) {
    if (!Array.isArray(seqs)) {
      throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'seqs must be an array');
    }
    for (const seq of seqs) {
      if (!Number.isInteger(seq) || seq < 1) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Sequence must be positive integer >= 1');
      }
    }
  }

  #advanceWatermark() {
    while (
      this.#committed.has(this.#contiguousWatermarkSeq + 1) ||
      this.#skipped.has(this.#contiguousWatermarkSeq + 1)
    ) {
      this.#contiguousWatermarkSeq += 1;
    }
  }

  /**
   * Marks `seqs` as committed and advances watermarks.
   *
   * @param {number[]} seqs
   */
  markCommitted(seqs = []) {
    this.#validateSeqs(seqs);
    for (const seq of seqs) {
      this.#committed.add(seq);
      if (seq > this.#highestCommittedSeq) {
        this.#highestCommittedSeq = seq;
      }
    }
    this.#advanceWatermark();
    return this.getWatermarks();
  }

  /**
   * Marks `seqs` as skipped (e.g. dead-lettered) so contiguous watermark can advance past holes.
   *
   * @param {number[]} seqs
   */
  markSkipped(seqs = []) {
    this.#validateSeqs(seqs);
    for (const seq of seqs) {
      this.#skipped.add(seq);
    }
    this.#advanceWatermark();
    return this.getWatermarks();
  }

  getWatermarks() {
    return {
      highestCommittedSeq: this.#highestCommittedSeq,
      contiguousWatermarkSeq: this.#contiguousWatermarkSeq
    };
  }
}
