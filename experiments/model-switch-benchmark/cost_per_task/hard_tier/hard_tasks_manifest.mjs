import {
  TURN1_PLAN_PREFIX,
  TURN2_IMPLEMENT_PROMPT,
  RETRY_PROMPT_HEADER
} from '../tasks_manifest.mjs';

export { TURN1_PLAN_PREFIX, TURN2_IMPLEMENT_PROMPT, RETRY_PROMPT_HEADER };

export const HARD_TASKS = Object.freeze([
  {
    task_id: 'H01',
    is_spare: false,
    difficulty: 'hard',
    title: 'DST-safe monthly anchor clamping, BigInt banker proration, and sub-period plan-change invoicing',
    target_files: ['src/clock.mjs', 'src/tierEngine.mjs', 'src/creditPool.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero dependencies or devDependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement DST-aware monthly anchor cycle bounds and exact BigInt banker-rounded sub-period proration across `src/clock.mjs`, `src/tierEngine.mjs`, `src/creditPool.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. **`src/clock.mjs` (`getMonthlyCycleBounds` + DST-safe `getBillingWindowBounds`/`enumerateDailyWindows`):**',
      '   - Resolve local wall clock `(Y, M, D, anchorHourLocal, 0, 0)` in IANA `timeZone` using built-in `Intl`/`Date` only: unique wall times map directly; spring-forward missing hours resolve to the exact first valid post-transition UTC instant; fall-back repeated hours resolve to the FIRST (pre-transition) UTC occurrence. Handle 30-min DST (`Australia/Lord_Howe`) and Southern Hemisphere (`Pacific/Auckland`).',
      '   - Export `getMonthlyCycleBounds({ year, month, anchorDay, timeZone = "UTC", anchorHourLocal = 0 })` where `month` is `1..12` and `anchorDay` is `1..31` (invalid args throw `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)` or `ERR_INVALID_TIMEZONE`). Clamp `startDay = Math.min(anchorDay, daysInMonth(year, month))` and `endDay = Math.min(anchorDay, daysInMonth(nextYear, nextMonth))` from the original `anchorDay` (so `anchorDay=31` clamps Feb 28/29 -> Mar 31 without drifting).',
      '   - Return `{ startUtcMs, endUtcMs, startLocalDate, endLocalDate, timeZone }` with `YYYY-MM-DD` dates.',
      '2. **`src/tierEngine.mjs` (`roundHalfToEvenBigInt` + `computeProratedGraduatedCharge`):**',
      '   - Fix `computeGraduatedCharge` boundary/sorting/zero/negative rules (`ERR_NEGATIVE_UNITS`, `ERR_INVALID_TIERS`, non-mutation, `units === 0 -> { totalCents: 0, breakdown: [] }`).',
      '   - Export `roundHalfToEvenBigInt(numBig, denBig)` for `numBig >= 0n, denBig > 0n` (rounds ties `2n * rem === denBig` to the even integer quotient).',
      '   - Export `computeProratedGraduatedCharge(units, tiers, numMs, denMs)` validating integer `numMs >= 0`, `denMs > 0` (`ERR_INVALID_CONFIG`): scale each finite `tier.upTo` to `Number(roundHalfToEvenBigInt(BigInt(tier.upTo) * BigInt(numMs), BigInt(denMs)))`, keeping `null`/`Infinity` unbounded; collapse duplicate finite caps after scaling (keep the higher tier or skip 0-width bands cleanly), and price `units` via `computeGraduatedCharge`.',
      '3. **`src/creditPool.mjs` (`applyCredits`):**',
      '   - Fix `applyCredits(chargeCents, grants, asOfMs)` and `summarizePoolBalance`: filter `remainingCents > 0 && effectiveFromMs <= asOfMs && asOfMs < expiresAtMs`, sort by `expiresAtMs ASC, grantId ASC`, never mutate caller inputs.',
      '4. **`src/invoiceBuilder.mjs` (`buildProratedCycleInvoice`):**',
      '   - Export `buildProratedCycleInvoice({ invoiceId, accountId, currency = "USD", year, month, anchorDay, timeZone = "UTC", anchorHourLocal = 0, planChanges = [], events = [], grants = [] })`.',
      '   - Validate non-empty `planChanges` sorted ascending by `effectiveAtUtcMs` with first entry `effectiveAtUtcMs === cycle.startUtcMs` and all entries in `[cycle.startUtcMs, cycle.endUtcMs]` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)`).',
      '   - Split `[cycle.startUtcMs, cycle.endUtcMs)` into segments; collapse zero-duration segments (`segStart === segEnd`, keeping the last change at an identical timestamp). For each non-empty segment: compute `segMs = segEnd - segStart`, `cycleMs = cycle.endUtcMs - cycle.startUtcMs`, `proratedFeeCents = Number(roundHalfToEvenBigInt(BigInt(seg.monthlyFeeCents) * BigInt(segMs), BigInt(cycleMs)))`, bucket events with `segStart <= evt.timestampMs < segEnd` sorted by `metric` ascending, and price each metric with `computeProratedGraduatedCharge(totalUnits, seg.metricTiers[metric], segMs, cycleMs)`.',
      '   - Emit segment fee line items `{ metric: \`PLAN_FEE:\${seg.planId}\`, units: 1, amountCents: proratedFeeCents, segmentIndex }` followed by segment metric line items `{ metric, units, amountCents, segmentIndex }`. Sum into `usageSubtotalCents`, apply credits at `asOfMs = cycle.endUtcMs` (without mutating `grants`), and return `{ invoiceId, accountId, currency, status: "FINALIZED", cycle, segments, lineItems, usageSubtotalCents, appliedCreditsCents, creditAllocations, totalDueCents, wireDigest }`.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'H02',
    is_spare: false,
    difficulty: 'hard',
    title: 'Unicode NFC escapes/matching in queryDsl, NFC collision-safe SHA-256 canonicalizer, and grapheme UTF-8 bounded audit formatter',
    target_files: ['src/errors.mjs', 'src/queryDsl.mjs', 'src/idempotencyGuard.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero external dependencies and zero eval()/new Function() under src/',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement full Unicode NFC semantics, canonical hashing with NFC-collision rejection, and UTF-8 byte/grapheme-bounded formatting across `src/errors.mjs`, `src/queryDsl.mjs`, `src/idempotencyGuard.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. **`src/errors.mjs`:** Add `ERR_CANONICAL_COLLISION: "ERR_CANONICAL_COLLISION"` to `ERROR_CODES` preserving all existing error codes.',
      '2. **`src/queryDsl.mjs`:**',
      '   - Fix string escapes (`\\\\`, `\\"`, `\\n`, `\\t`) and add `\\uXXXX` (4 hex digits) and `\\u{XXXXXX}` (1–6 hex digits) Unicode escapes. Reject invalid hex, codepoints `> 0x10FFFF`, or lone surrogate codepoints `0xD800..0xDFFF` with `LedgerError(ERROR_CODES.ERR_DSL_SYNTAX)`.',
      '   - Support `==`, `!=`, `IN (...)`, `NOT`, `AND`, `OR` (`()` > `NOT` > `AND` > `OR`), null/missing safety, and add case-insensitive `~=` operator. Normalize string values on both sides with `.normalize("NFC")` for `==`, `!=`, `IN (...)`, and compare `.normalize("NFC").toLowerCase()` for `~=`.',
      '3. **`src/idempotencyGuard.mjs` (`computeCanonicalPayloadHash` + fixed `IdempotencyGuard`):**',
      '   - Export `computeCanonicalPayloadHash(payload)`: reject `undefined` (at top level or inside arrays), `NaN`, `Infinity`, `-Infinity`, `BigInt`, functions, symbols, and circular object/array references anywhere in `payload` with `LedgerError(ERROR_CODES.ERR_INVALID_EVENT)`. Omit object properties whose value is `undefined`. Normalize `-0` to `0`, strings to `NFC`, and object keys to `NFC`.',
      '   - If two distinct raw keys on the same object normalize to the exact same `NFC` string (e.g. `"cafe\\u0301"` and `"caf\\u00e9"`), throw `LedgerError(ERROR_CODES.ERR_CANONICAL_COLLISION)`. Sort object keys ascending by UTF-16 code unit, serialize deterministic JSON, and return lowercase hex SHA-256 (`node:crypto`).',
      '   - Also fix `IdempotencyGuard` (`ttlMs > 0`, `maxEntries >= 1`, `nowMs >= expiresAtMs` inclusive expiry checked before conflict, FIFO eviction).',
      '4. **`src/invoiceBuilder.mjs` (`formatBoundedAuditEntry`):**',
      '   - Export `formatBoundedAuditEntry(invoice, maxBytes)`: validate integer `maxBytes >= 16` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)`).',
      '   - Normalize `invoiceId` and `memo` (`String(invoice.memo ?? "").normalize("NFC")`) and build `prefix = \`\${id}|\${Math.trunc(Number(invoice.totalDueCents || 0))}|\``. Full string is `prefix + memo`. If `Buffer.byteLength(full, "utf8") <= maxBytes`, return `full`.',
      '   - Otherwise iterate grapheme clusters (`new Intl.Segmenter("en", { granularity: "grapheme" })`): if `Buffer.byteLength(prefix + "…", "utf8") <= maxBytes`, keep as many whole grapheme clusters from `memo` as fit alongside `prefix + "…"` (`U+2026`, 3 UTF-8 bytes) so `Buffer.byteLength(result, "utf8") <= maxBytes` and zero grapheme clusters are ever split; otherwise truncate `full` itself on grapheme boundaries + `"…"` within `maxBytes`.',
      'Constraints: (1) Zero external dependencies and zero `eval()`/`new Function()` in `src/`. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'H03',
    is_spare: false,
    difficulty: 'hard',
    title: 'Partitioned async batch coordinator with contiguous low-watermark cursor, bounded retry/DLQ, AbortSignal drain, and graceful shutdown',
    target_files: ['src/errors.mjs', 'src/usageCursor.mjs', 'src/idempotencyGuard.mjs', 'src/batchIngestor.mjs'],
    constraints: [
      'Zero dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement partitioned async event ingestion with out-of-order contiguous watermark tracking, bounded retry/DLQ, `AbortSignal` drain, and graceful shutdown across `src/errors.mjs`, `src/usageCursor.mjs`, `src/idempotencyGuard.mjs`, and `src/batchIngestor.mjs`:',
      '1. **`src/errors.mjs`:** Add `ERR_ABORTED: "ERR_ABORTED"` and `ERR_SHUTTING_DOWN: "ERR_SHUTTING_DOWN"` to `ERROR_CODES` preserving all existing codes.',
      '2. **`src/usageCursor.mjs` (`UsageCursor`):**',
      '   - Support out-of-order `markCommitted(seqs)` and `markSkipped(seqs)` (each element positive integer `>= 1`, else `ERR_INVALID_EVENT`).',
      '   - `getWatermarks()` returns `{ highestCommittedSeq, contiguousWatermarkSeq }`, where `highestCommittedSeq` is max committed seq (`0` initially) and `contiguousWatermarkSeq` is the largest integer `k >= 0` such that EVERY seq `1..k` is either committed or skipped.',
      '3. **`src/idempotencyGuard.mjs`:** Fix `IdempotencyGuard` (`ttlMs > 0`, `maxEntries >= 1`, `nowMs >= expiresAtMs` checked before conflict, FIFO eviction).',
      '4. **`src/batchIngestor.mjs` (`PartitionedBatchCoordinator` + fixed `BatchIngestor`):**',
      '   - Keep `BatchIngestor` fixed (serialized mutex + failed-batch front restoration).',
      '   - Export `PartitionedBatchCoordinator({ maxBatchSize = 50, maxConcurrentFlushes = 4, maxRetries = 2, ttlMs = 60_000, maxIdempotencyEntries = 10_000, sinkFn, onDeadLetter = null })` (validate positive integer bounds & function `sinkFn` with `ERR_INVALID_CONFIG`).',
      '   - `ingest(event)` expects `{ accountId, key, payloadHash, seq, metric, units, nowMs }`: if `shutdown()` has been called, throw `LedgerError(ERROR_CODES.ERR_SHUTTING_DOWN)`. Validate fields (`ERR_INVALID_EVENT`), check idempotency (`guard.checkAndRecord(key, payloadHash, nowMs)` — if `duplicate`, return `{ status: "duplicate", seq }` without buffering; if `accepted`, enqueue in `accountId` partition FIFO buffer and if partition buffer reaches `maxBatchSize`, trigger and await partition flush).',
      '   - Per-account flushes MUST run serially (FIFO within each `accountId`); flushes across distinct accounts MAY run concurrently up to `<= maxConcurrentFlushes` active `sinkFn` invocations globally.',
      '   - Retry & DLQ: if `sinkFn(batch)` rejects with `err?.retryable === false`, move directly to DLQ without retrying; otherwise retry up to `maxRetries` extra times (`1 + maxRetries` total attempts). On terminal failure, push `{ accountId, batch, error }` to internal dead-letter list, `await onDeadLetter(batch, error)` if provided, call `cursor.markSkipped(batch.map(e => e.seq))`, and resolve without losing other partitions or wedging `contiguousWatermarkSeq`. On success, call `cursor.markCommitted(batch.map(e => e.seq))`.',
      '   - `flushPartition(accountId)` flushes that account\'s buffer cleanly. `drain({ signal } = {})` triggers flushes for all partitions with buffered (`< maxBatchSize`) events AND waits for all active & queued partition flushes to finish; if `signal?.aborted` or `signal` aborts while draining, reject immediately with `LedgerError(ERROR_CODES.ERR_ABORTED)` without dropping or corrupting in-flight/buffered batches. `shutdown()` rejects future `ingest()` with `ERR_SHUTTING_DOWN`, flushes all buffered events via `drain()`, and returns `{ committedCount, deadLetterCount, watermarks }` where `committedCount` and `deadLetterCount` are event counts (not batch counts). Export `getDeadLetters()` and `getWatermarks()`.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'H04',
    is_spare: false,
    difficulty: 'hard',
    title: 'Exact BigInt FX triangulation & staleness, micro-rate tiering, banker rounding, and Largest-Remainder tax/discount allocation',
    target_files: ['src/errors.mjs', 'src/fxConverter.mjs', 'src/tierEngine.mjs', 'src/creditPool.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement exact BigInt multi-currency FX triangulation, micro-rate pricing, and penny-exact Hamilton (Largest Remainder) invoice allocation across `src/errors.mjs`, `src/fxConverter.mjs`, `src/tierEngine.mjs`, `src/creditPool.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. **`src/errors.mjs`:** Add `ERR_FX_RATE_UNAVAILABLE: "ERR_FX_RATE_UNAVAILABLE"` and `ERR_FX_QUOTE_STALE: "ERR_FX_QUOTE_STALE"` to `ERROR_CODES` preserving all existing codes.',
      '2. **`src/fxConverter.mjs` (`roundHalfToEvenBigInt` + `convertMinorUnitsExact`):**',
      '   - Export `roundHalfToEvenBigInt(numBig, denBig)` (works for both negative and non-negative `numBig`, `denBig > 0n`: rounds half ties `2n * absRem === denBig` to the nearest even integer).',
      '   - Export `convertMinorUnitsExact({ amountMinor, fromCurrency, toCurrency, quotes = [], asOfMs = 0, maxQuoteAgeMs = Infinity })`: validate safe integer `amountMinor` (`ERR_INVALID_AMOUNT`) and known `CURRENCY_MINOR_EXPONENTS` (`ERR_INVALID_CONFIG`). If `fromCurrency === toCurrency`, return `amountMinor`.',
      '   - A quote `{ from, to, rateNum, rateDen, quoteTimestampMs }` is valid if positive integer `rateNum, rateDen` (`ERR_INVALID_CONFIG` if `<= 0` or non-integer) and fresh iff `quoteTimestampMs <= asOfMs && (asOfMs - quoteTimestampMs) <= maxQuoteAgeMs`.',
      '   - Route selection (prefer fresh routes in priority order: (1) direct `from->to` newest timestamp, (2) reciprocal inverse `to->from` using `rateDen/rateNum` newest timestamp, (3) 1-hop `USD` pivot combining fresh `from->USD` and `USD->to` [each direct or reciprocal], picking max `min(ts1, ts2)`). If any path exists structurally in `quotes` (direct, inverse, or 1-hop `USD` pivot) yet no fresh path exists, throw `ERR_FX_QUOTE_STALE`; if no structural route exists at all, throw `ERR_FX_RATE_UNAVAILABLE`.',
      '   - Compute `amountMinor * pathRateNum * 10^toExp / (pathRateDen * 10^fromExp)` in exact `BigInt` before a SINGLE final `roundHalfToEvenBigInt` (zero intermediate rounding!).',
      '3. **`src/tierEngine.mjs` (`computeMicroTierCharge` + fixed `computeGraduatedCharge`):**',
      '   - Export `computeMicroTierCharge(units, tiers)`: validates `units >= 0` integer (`ERR_NEGATIVE_UNITS`) and sorted valid tiers. Uses `BigInt(tier.unitRateMicros ?? Math.round(tier.unitRateCents * 1_000_000))` per unit across all tiers, summing `totalMicros` in `BigInt` and rounding ONCE at the end via `Number(roundHalfToEvenBigInt(totalMicros, 1_000_000n))`.',
      '4. **`src/creditPool.mjs`:** Fix `applyCredits` (window inclusivity, `expiresAtMs ASC, grantId ASC`, non-mutation).',
      '5. **`src/invoiceBuilder.mjs` (`allocateByLargestRemainder` + `buildMultiCurrencyInvoice`):**',
      '   - Export `allocateByLargestRemainder(totalDeltaMinor, weights)`: allocate non-negative integer `totalDeltaMinor` proportionally across `weights` (`weights.every(w => w >= 0)`). If `sum(weights) === 0`, return all `0`s (when `totalDeltaMinor === 0`, else throw `ERR_INVALID_AMOUNT`). Otherwise floor each `Math.floor` (`BigInt` division `total * w / W`), distribute remaining `1`-minor-unit increments to items sorted by `remainder DESC`, breaking ties by `weight DESC`, then `index ASC` so `sum(allocations) === totalDeltaMinor` always holds.',
      '   - Export `buildMultiCurrencyInvoice({ invoiceId, accountId, targetCurrency = "USD", usageRows = [], quotes = [], asOfMs = 0, maxQuoteAgeMs = Infinity, discountBps = 0, taxBps = 0, grants = [] })`: validate `0 <= discountBps <= 10000` & `0 <= taxBps <= 10000` (`ERR_INVALID_CONFIG`), price each row via `computeMicroTierCharge`, convert each row amount from `fromCurrency = row.rowCurrency ?? row.currency ?? targetCurrency` to `targetCurrency` via `convertMinorUnitsExact`, sum `usageSubtotalMinor`, compute `discountMinor` (BigInt banker\'s rounding of `usageSubtotalMinor * discountBps / 10000`) and allocate across rows (`line.discountMinor`), apply active `grants` at `asOfMs` up to `usageSubtotalMinor - discountMinor`, compute `netAfterCreditsMinor = usageSubtotalMinor - discountMinor - appliedCreditsMinor`, compute `taxMinor` (BigInt banker\'s rounding of `netAfterCreditsMinor * taxBps / 10000`) and allocate across rows with weights `line.amountMinor - line.discountMinor` (`line.taxMinor`), and return `{ invoiceId, accountId, currency: targetCurrency, status: "FINALIZED", lineItems, usageSubtotalMinor, discountMinor, appliedCreditsMinor, creditAllocations, netAfterCreditsMinor, taxMinor, totalDueMinor, wireDigest }`.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'H05',
    is_spare: false,
    difficulty: 'hard',
    title: 'Multi-stage async payment settlement saga with IN_FLIGHT/COMPENSATION_FAILED idempotency and reverse-order compensation',
    target_files: ['src/errors.mjs', 'src/idempotencyGuard.mjs', 'src/tierEngine.mjs', 'src/creditPool.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement an async multi-stage payment settlement saga with strict idempotency state transitions and reverse-order compensation across `src/errors.mjs`, `src/idempotencyGuard.mjs`, `src/tierEngine.mjs`, `src/creditPool.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. **`src/errors.mjs`:** Add `ERR_IDEMPOTENCY_IN_FLIGHT: "ERR_IDEMPOTENCY_IN_FLIGHT"`, `ERR_COMPENSATION_FAILED: "ERR_COMPENSATION_FAILED"`, `ERR_UNKNOWN_INVOICE: "ERR_UNKNOWN_INVOICE"`, and `ERR_ALREADY_VOIDED: "ERR_ALREADY_VOIDED"` to `ERROR_CODES` preserving all existing codes.',
      '2. **`src/idempotencyGuard.mjs` (Saga State Machine):**',
      '   - Extend `IdempotencyGuard` with `beginInFlight(key, payloadHash, nowMs)`, `markSucceeded(key, payloadHash, resultSnapshot, nowMs)`, `markFailedRelease(key, payloadHash)`, and `markCompensationFailed(key, payloadHash, info, nowMs)`.',
      '   - If an active (`nowMs < expiresAtMs`) entry is `IN_FLIGHT`: same `payloadHash` throws `LedgerError(ERROR_CODES.ERR_IDEMPOTENCY_IN_FLIGHT)`; different `payloadHash` throws `ERR_IDEMPOTENCY_CONFLICT`.',
      '   - If active `SUCCEEDED`: same `payloadHash` returns `{ status: "replayed", cachedResult: structuredClone(resultSnapshot) }`; different `payloadHash` throws `ERR_IDEMPOTENCY_CONFLICT`.',
      '   - If active `COMPENSATION_FAILED`: throws `LedgerError(ERROR_CODES.ERR_COMPENSATION_FAILED)` to block unsafe retries.',
      '   - Expired entries (`nowMs >= expiresAtMs`) are cleared cleanly before starting. `markFailedRelease` removes an `IN_FLIGHT` entry if `payloadHash` matches so transient failures are safely retryable.',
      '3. **`src/creditPool.mjs`, `src/tierEngine.mjs`, and `createSettlementRegistry`:** Fix `computeGraduatedCharge` and active non-mutating `applyCredits`; export `createSettlementRegistry(initialGrants = [])` from `src/invoiceBuilder.mjs` returning `{ grants, invoices: [], unreconciledGatewayCents: 0 }` with cloned grant objects whose `.remainingCents` update in place as credits are reserved or restored.',
      '4. **`src/invoiceBuilder.mjs` (`executeSettlementSaga`):**',
      '   - Export `async executeSettlementSaga(ctx, request)` where `ctx = { registry, guard, gateway, ledgerStore }` and `request = { idempotencyKey, invoiceId, accountId, currency = "USD", usageRows = [], asOfMs = 0 }`.',
      '   - Compute deterministic `payloadHash` via SHA-256 over canonical `{ invoiceId, accountId, currency, usageRows, asOfMs }` (using sorted keys).',
      '   - Step A: `guard.beginInFlight(idempotencyKey, payloadHash, asOfMs)` — if `replayed`, immediately return `{ ...cachedResult, replayed: true }` with ZERO credit mutations and ZERO gateway/ledger calls.',
      '   - Step B: Build invoice charges (`computeGraduatedCharge` with accurate multi-tier pricing) and reserve active credits from `registry.grants` (`applyCredits` at `asOfMs`, updating reserved grant `.remainingCents` in place). Let `remainingGatewayCents = invoice.totalDueCents`.',
      '   - Step C: If `remainingGatewayCents === 0`, skip `gateway.authorize` and `gateway.capture` (`authId = null`, `captureId = null`). Otherwise call `await gateway.authorize({ amountCents: remainingGatewayCents, currency, invoiceId, accountId })` returning `{ authId }`, then `await gateway.capture({ authId, amountCents: remainingGatewayCents, currency, invoiceId })` returning `{ captureId }`:',
      '     - If `authorize` throws: restore reserved credits, call `guard.markFailedRelease`, attach `err.compensationSteps = ["restore_credits"]`, and rethrow.',
      '     - If `capture` throws: `await gateway.release(authId)`, then restore credits, call `guard.markFailedRelease`, attach `err.compensationSteps = ["release_auth", "restore_credits"]`, and rethrow.',
      '   - Step D: Call `await ledgerStore.append(invoiceRecord)`. If `ledgerStore.append` throws:',
      '     - If `captureId` exists, call `await gateway.refund({ captureId, amountCents: remainingGatewayCents, invoiceId })`. If `refund` succeeds: restore credits, `guard.markFailedRelease`, attach `err.compensationSteps = ["refund_capture", "restore_credits"]`, and rethrow `err`.',
      '     - If `refund` ALSO throws (`compErr`): do **NOT** restore credits (prevent double-spend), add `remainingGatewayCents` to `registry.unreconciledGatewayCents`, call `guard.markCompensationFailed(...)`, and throw `new LedgerError(ERROR_CODES.ERR_COMPENSATION_FAILED, "Refund compensation failed", { primaryError: err, compensationError: compErr, captureId, compensationSteps: ["refund_capture_failed"] })`.',
      '     - If `captureId` was `null`: restore credits, `guard.markFailedRelease`, attach `err.compensationSteps = ["restore_credits"]`, and rethrow `err`.',
      '   - Step E: Persist finalized invoice in `registry.invoices`, call `guard.markSucceeded(...)`, and return `{ ...finalizedInvoice, replayed: false, authId, captureId }`.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'H06',
    is_spare: false,
    difficulty: 'hard',
    title: 'Retroactive closed-period billing amendments with multi-window credit re-waterfalling and immutable digest memos',
    target_files: ['src/errors.mjs', 'src/clock.mjs', 'src/tierEngine.mjs', 'src/creditPool.mjs', 'src/queryDsl.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero dependencies in package.json and zero eval()/new Function() under src/',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement a closed-period billing ledger supporting retroactive amendments and multi-window credit re-waterfalling across `src/errors.mjs`, `src/clock.mjs`, `src/tierEngine.mjs`, `src/creditPool.mjs`, `src/queryDsl.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. Ensure `clock.mjs` (`getMonthlyCycleBounds` / DST-safe windows), `tierEngine.mjs` (accurate multi-tier `computeGraduatedCharge`), `creditPool.mjs` (immutable active-window `applyCredits` ordered `expiresAtMs ASC, grantId ASC`), `queryDsl.mjs` (`IN` / `NOT` / `AND` / `OR` precedence + escaping), and `errors.mjs` (`ERR_UNKNOWN_INVOICE`, `ERR_INVALID_CONFIG`) are all sound.',
      '2. In `src/invoiceBuilder.mjs`, export `createClosedPeriodLedger({ accountId, currency = "USD", timeZone = "UTC", anchorHourLocal = 0, grants = [], metricTiers = {} })` (deep-cloning `grants` and `metricTiers` on construction so caller inputs are never mutated) with methods:',
      '   - `closePeriod({ periodKey, year, month, anchorDay, invoiceId = `inv-${periodKey}`, events = [] })`: computes `[startUtcMs, endUtcMs)` via `getMonthlyCycleBounds({ year, month, anchorDay, timeZone, anchorHourLocal })` (`ERR_INVALID_CONFIG` on duplicate `periodKey` or non-chronological `startUtcMs`), aggregates `events` inside `[startUtcMs, endUtcMs)` by `metric` (sorted ascending), prices with `computeGraduatedCharge` using `metricTiers[metric]`, applies active credits at `asOfMs = endUtcMs`, stores the immutable closed invoice (`wireDigest` NEVER mutated afterward!), advances remaining credits to the next period, and returns a cloned copy of the closed invoice.',
      '   - `applyRetroactiveAmendment({ amendmentId, targetPeriodKey, op, events = [], filterExpr = null })`:',
      '     - Validate `targetPeriodKey` is a closed period (`ERR_UNKNOWN_INVOICE` if missing) and `op` is `"ADD" | "SUBTRACT" | "VOID_MATCHING"` (`ERR_INVALID_CONFIG` otherwise).',
      '     - Update a trial copy of `targetPeriodKey`\'s event list: `"ADD"` appends `events` directly to `targetPeriodKey` (even when `timestampMs` is omitted); `"SUBTRACT"` applies direct unit subtractions (`{ metric, units }` with `units >= 0`, even when `timestampMs` is omitted) to `targetPeriodKey`; `"VOID_MATCHING"` uses `compileFilter(filterExpr)` to drop matching events in `targetPeriodKey`.',
      '     - Re-simulate EVERY closed period chronologically from the earliest period (or from `targetPeriodKey` using exact pre-target remaining credits) through the latest closed period:',
      '       - If any metric\'s net summed units in `targetPeriodKey` drops `< 0`, throw `LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS)` and leave ALL ledger state completely unchanged!',
      '       - Otherwise recompute each period\'s `effectiveUsageSubtotalCents`, `effectiveAppliedCreditsCents`, and `effectiveTotalDueCents` using active credits at `period.endUtcMs`.',
      '       - For each period `[targetPeriodKey .. latestClosedPeriod]` whose `effectiveTotalDueCents !== prevEffectiveTotalDueCents` OR `effectiveAppliedCreditsCents !== prevEffectiveAppliedCreditsCents`, emit an amendment memo `{ memoId: \`\${origInv.invoiceId}:amend:\${amendmentSeq}\`, amendmentId, periodKey, type, deltaDueCents, deltaCreditsCents, effectiveTotalDueCents, effectiveAppliedCreditsCents, memoWireDigest }` where `type` is `"CREDIT_MEMO"` if `deltaDueCents < 0`, `"DEBIT_MEMO"` if `deltaDueCents > 0`, or `"REALLOCATION_MEMO"` if `deltaDueCents === 0`, and `memoWireDigest = encodeFrozenWireDigest({ invoiceId: memoId, accountId, currency, totalDueCents: deltaDueCents, status: "FINALIZED" })`. (Normalize any `-0` deltas to `0`.)',
      '     - Return `{ amendmentId, amendmentSeq, memos }` while keeping every original closed invoice\'s `totalDueCents` and `wireDigest` untouched!',
      '   - `getEffectiveLedgerSummary()`: returns `{ closedInvoices, memos, effectiveByPeriod, remainingGrants }` (deep-cloned).',
      'Constraints: (1) Zero dependencies in package.json and zero `eval()`/`new Function()` under `src/`. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  }
]);

export function buildHardTurn1Prompt(task) {
  return `${TURN1_PLAN_PREFIX}\n\n## Task ${task.task_id}: ${task.title}\n\n${task.spec}`;
}
