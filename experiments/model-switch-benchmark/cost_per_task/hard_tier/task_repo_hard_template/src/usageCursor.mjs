import { ERROR_CODES, LedgerError } from './errors.mjs';

/**
 * Tracks committed sequence numbers.
 * Naive baseline implementation assumes strictly in-order monotonic commits.
 */
export class UsageCursor {
  #highestCommittedSeq;

  constructor() {
    this.#highestCommittedSeq = 0;
  }

  /**
   * Marks `seqs` as committed.
   *
   * @param {number[]} seqs
   */
  markCommitted(seqs = []) {
    for (const seq of seqs) {
      if (!Number.isInteger(seq) || seq < 1) {
        throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Sequence must be positive integer');
      }
      if (seq > this.#highestCommittedSeq) {
        this.#highestCommittedSeq = seq;
      }
    }
    return this.getWatermarks();
  }

  getWatermarks() {
    return {
      highestCommittedSeq: this.#highestCommittedSeq,
      contiguousWatermarkSeq: this.#highestCommittedSeq
    };
  }
}
