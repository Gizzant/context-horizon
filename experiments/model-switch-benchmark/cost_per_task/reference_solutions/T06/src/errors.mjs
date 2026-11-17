export const ERROR_CODES = Object.freeze({
  ERR_NEGATIVE_UNITS: 'ERR_NEGATIVE_UNITS',
  ERR_INVALID_TIERS: 'ERR_INVALID_TIERS',
  ERR_INVALID_AMOUNT: 'ERR_INVALID_AMOUNT',
  ERR_IDEMPOTENCY_CONFLICT: 'ERR_IDEMPOTENCY_CONFLICT',
  ERR_INVALID_TTL: 'ERR_INVALID_TTL',
  ERR_INVALID_CONFIG: 'ERR_INVALID_CONFIG',
  ERR_DSL_SYNTAX: 'ERR_DSL_SYNTAX',
  ERR_INVALID_TIMEZONE: 'ERR_INVALID_TIMEZONE',
  ERR_SINK_FAILURE: 'ERR_SINK_FAILURE',
  ERR_INVALID_EVENT: 'ERR_INVALID_EVENT',
  ERR_UNKNOWN_INVOICE: 'ERR_UNKNOWN_INVOICE',
  ERR_ALREADY_VOIDED: 'ERR_ALREADY_VOIDED'
});

export class LedgerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
