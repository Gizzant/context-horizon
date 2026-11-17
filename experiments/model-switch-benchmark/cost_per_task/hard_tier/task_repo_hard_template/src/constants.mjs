export const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP']);

export const INVOICE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  FINALIZED: 'FINALIZED',
  VOIDED: 'VOIDED'
});

export const ROUNDING_MODES = Object.freeze({
  HALF_AWAY_FROM_ZERO: 'HALF_AWAY_FROM_ZERO',
  FLOOR: 'FLOOR'
});

export const MAX_BPS = 10_000;
export const WIRE_SCHEMA_VERSION = 'LP-WIRE-V1';
export const DEFAULT_TIME_ZONE = 'UTC';
