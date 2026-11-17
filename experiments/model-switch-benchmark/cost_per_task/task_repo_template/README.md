# LedgerPulse

Zero-dependency Node.js ESM metering, credit allocation, windowing, and invoice settlement engine.

## Conventions
- All monetary amounts are represented as **integer cents** (`number` safe integers).
- All timestamps are **UTC epoch milliseconds** (`number` finite integers).
- Inputs (`tiers`, `grants`, `events`, `lineItems`) must never be mutated by engine functions.
- `src/frozenWire.mjs` implements the legacy `LP-WIRE-V1` digest wire contract and must stay compatible.

## Modules (`src/`)
- `constants.mjs`: Frozen currencies, invoice statuses, and protocol constants.
- `errors.mjs`: `LedgerError` and canonical error codes.
- `frozenWire.mjs`: Legacy wire digest encoder (`encodeFrozenWireDigest`).
- `clock.mjs`: IANA timezone billing window boundary & enumeration helpers.
- `tierEngine.mjs`: Graduated and volume pricing calculators.
- `creditPool.mjs`: Promotional / prepaid credit grant allocation & pool summaries.
- `idempotencyGuard.mjs`: Bounded-capacity TTL idempotency store.
- `queryDsl.mjs`: Safe, eval-free boolean event filter tokenizer, parser, and compiler.
- `batchIngestor.mjs`: Buffered async event ingestor with sequence watermarks.
- `invoiceBuilder.mjs`: End-to-end usage metering, credit application, and invoice builder.
