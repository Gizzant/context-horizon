export const TURN1_PLAN_PREFIX =
  'You are working in a read-only planning turn. Inspect the repository, read test/task_visible.test.mjs and the relevant source files, diagnose all gaps and edge cases for the task below, and produce a concise, concrete implementation plan listing exact files, functions, and changes needed. Do not edit files in this turn.';

export const TURN2_IMPLEMENT_PROMPT =
  'Now implement your plan cleanly, satisfy every task requirement and constraint, preserve all existing baseline tests, and run `npm test` to verify all visible tests pass.';

export const RETRY_PROMPT_HEADER = 'The task is not complete. These tests fail:';

export const TASKS = Object.freeze([
  {
    task_id: 'T01',
    is_spare: false,
    difficulty: 'easy',
    title: 'Fix graduated tier boundary, sorting, rounding, and zero/negative units in tierEngine.mjs',
    target_files: ['src/tierEngine.mjs'],
    constraints: [
      'Do not add dependencies or devDependencies to package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Fix `computeGraduatedCharge(units, tiers)` in `src/tierEngine.mjs`:',
      '1. Validate `tiers`: must be a non-empty array; every tier must have finite `unitRateCents >= 0` and either `upTo === null || upTo === Infinity` (at most one unbounded tier, sorted last) or a positive finite integer `upTo > 0`; duplicate finite `upTo` or invalid values must throw `LedgerError(ERROR_CODES.ERR_INVALID_TIERS)`.',
      '2. Sort tiers ascending by `upTo` (`null`/`Infinity` last) without mutating the caller `tiers` array.',
      '3. Validate `units`: if `!Number.isFinite(units) || units < 0`, throw `LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS)`.',
      '4. If `units === 0`, return `{ totalCents: 0, breakdown: [] }`.',
      '5. For `units > 0`, compute marginal units `bandUnits = Math.min(units, cap) - prevUpTo` (no `+1` double-counting), include only tiers with `bandUnits > 0` in `breakdown`, and compute `subtotalCents = Math.round(bandUnits * tier.unitRateCents)`.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T02',
    is_spare: false,
    difficulty: 'easy',
    title: 'Fix IdempotencyGuard TTL boundary, expiry-before-conflict check, and FIFO eviction',
    target_files: ['src/idempotencyGuard.mjs'],
    constraints: [
      'Do not modify src/errors.mjs or src/frozenWire.mjs',
      'Do not add new files under src/'
    ],
    spec: [
      'Fix `IdempotencyGuard` in `src/idempotencyGuard.mjs`:',
      '1. Constructor must validate `Number.isFinite(ttlMs) && ttlMs > 0` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_TTL)`) and `Number.isInteger(maxEntries) && maxEntries >= 1` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)`).',
      '2. Validate `checkAndRecord(key, payloadHash, nowMs)`: non-empty string `key` and `payloadHash` and finite `nowMs` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_EVENT)`).',
      '3. Expiry is inclusive (`nowMs >= entry.expiresAtMs` is expired; `nowMs < entry.expiresAtMs` is active). Check expiration BEFORE checking `payloadHash` mismatch so expired keys can be re-recorded with a new `payloadHash` as `status: "accepted"`.',
      '4. Enforce `maxEntries` with strict FIFO insertion-order eviction: prune expired entries at `nowMs` first, then if inserting a new key at capacity, evict the oldest-inserted entry. Duplicate hits must NOT refresh insertion order.',
      '5. `pruneExpired(nowMs)` validates finite `nowMs`, removes entries with `nowMs >= entry.expiresAtMs`, and returns the integer count removed.',
      'Constraints: (1) Do not modify `src/errors.mjs` or `src/frozenWire.mjs`. (2) Do not create any new files under `src/`.'
    ].join('\n')
  },
  {
    task_id: 'T03',
    is_spare: false,
    difficulty: 'easy',
    title: 'Fix creditPool.mjs expiry-window filtering, tie-break sorting, and non-mutation',
    target_files: ['src/creditPool.mjs'],
    constraints: [
      'No .toFixed() calls in src/creditPool.mjs',
      'Do not modify src/frozenWire.mjs'
    ],
    spec: [
      'Fix `applyCredits(chargeCents, grants, asOfMs)` and `summarizePoolBalance(grants, asOfMs)` in `src/creditPool.mjs`:',
      '1. Validate `Number.isFinite(chargeCents) && chargeCents >= 0` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT)`), finite `asOfMs`, and array `grants`.',
      '2. Never mutate the input `grants` array or any grant object inside it. Return `updatedGrants` as cloned objects in original array order with decremented `remainingCents`.',
      '3. A grant is eligible iff `grant.remainingCents > 0 && grant.effectiveFromMs <= asOfMs && asOfMs < grant.expiresAtMs`.',
      '4. Consume eligible grants ordered by `expiresAtMs` ascending, breaking ties by `grantId` ascending UTF-16 code-unit order (`a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0`).',
      '5. When `chargeCents === 0`, return `{ appliedCents: 0, remainingChargeCents: 0, allocations: [], updatedGrants }` cleanly.',
      '6. Fix `summarizePoolBalance(grants, asOfMs)` to sum and count only active eligible grants at `asOfMs`.',
      'Constraints: (1) Do not use `.toFixed()` in `src/creditPool.mjs`. (2) Do not modify `src/frozenWire.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T04',
    is_spare: false,
    difficulty: 'medium',
    title: 'Add minimumCommitCents true-up, true-up credit eligibility, and post-credit taxBps',
    target_files: ['src/tierEngine.mjs', 'src/creditPool.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Do not add dependencies to package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Extend `buildInvoice` in `src/invoiceBuilder.mjs` (and fix multi-tier graduated pricing in `src/tierEngine.mjs` plus active-window / non-mutating `applyCredits` in `src/creditPool.mjs`):',
      '1. Support optional `minimumCommitCents = 0`, `creditsEligibleForTrueUp = true`, and `taxBps = 0` on `buildInvoice`. Validate finite `minimumCommitCents >= 0` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT)`) and integer/finite `0 <= taxBps <= MAX_BPS` (else throw `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)`).',
      '2. If `minimumCommitCents > usageSubtotalCents`, compute `trueUpCents = minimumCommitCents - usageSubtotalCents` and append line item `{ metric: "COMMIT_TRUE_UP", units: 1, amountCents: trueUpCents }`; otherwise `trueUpCents = 0`. Let `preCreditSubtotalCents = usageSubtotalCents + trueUpCents`.',
      '3. If `creditsEligibleForTrueUp === true`, credits may apply up to `preCreditSubtotalCents`; if `false`, credits cap at `usageSubtotalCents`.',
      '4. Compute `netAfterCreditsCents = preCreditSubtotalCents - appliedCreditsCents` and `taxCents = Math.round((netAfterCreditsCents * taxBps) / 10000)`.',
      '5. Set `totalDueCents = netAfterCreditsCents + taxCents`, pass `totalDueCents` to `encodeFrozenWireDigest`, and include `{ trueUpCents, preCreditSubtotalCents, netAfterCreditsCents, taxCents }` on the returned invoice.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T05',
    is_spare: false,
    difficulty: 'medium',
    title: 'Add IN / NOT IN filter operator in queryDsl.mjs and event grouping in invoiceBuilder.mjs',
    target_files: ['src/queryDsl.mjs', 'src/tierEngine.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero eval() or new Function() in src/',
      'Do not modify src/frozenWire.mjs'
    ],
    spec: [
      'Implement `IN (...)` filtering and grouped event invoicing across `src/queryDsl.mjs`, `src/tierEngine.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. In `src/queryDsl.mjs`: add `field IN (lit1, lit2, ...)` and `NOT field IN (...)`, fixing operator precedence to `()` > `NOT` > `AND` > `OR`. Empty `IN ()` or trailing commas must throw `LedgerError(ERROR_CODES.ERR_DSL_SYNTAX)`. Literals support strings, numbers, booleans, and `null`.',
      '2. In `src/invoiceBuilder.mjs`: when `events` is passed to `buildInvoice`, support optional `metricTiers`, `filterExpr`, and `groupByTag`. Count non-matching events as `excludedEventCount` (default `0`).',
      '3. Sum matching event `units` by `(metric, groupValue)` where `groupValue = event.tags?.[groupByTag] ?? "untagged"` when `groupByTag` is set (else one row per `metric`). Price pooled `units` with `computeGraduatedCharge(totalUnits, metricTiers[metric])` (ensure multi-tier boundaries in `tierEngine.mjs` are accurate).',
      '4. Sort `lineItems` by `metric` ascending (code-unit), and when `groupByTag` is set, by `groupValue` ascending with `"untagged"` ALWAYS sorted LAST. Include `groupValue` on each line item when `groupByTag` is set.',
      'Constraints: (1) No `eval()` or `new Function()` anywhere under `src/`. (2) Do not modify `src/frozenWire.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T06',
    is_spare: false,
    difficulty: 'medium',
    title: 'Implement SettlementRegistry and invoice void credit reversal across errors, creditPool, invoiceBuilder',
    target_files: ['src/errors.mjs', 'src/creditPool.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Preserve all existing ERROR_CODES keys and values in src/errors.mjs',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Implement stateful invoice settlement and void reversals across `src/errors.mjs`, `src/creditPool.mjs`, and `src/invoiceBuilder.mjs`:',
      '1. Add `ERR_UNKNOWN_INVOICE: "ERR_UNKNOWN_INVOICE"` and `ERR_ALREADY_VOIDED: "ERR_ALREADY_VOIDED"` to `ERROR_CODES` in `src/errors.mjs` without altering existing codes.',
      '2. Implement `createSettlementRegistry(initialGrants = [])` (cloning input grants so caller objects are never mutated), `settleInvoice(registry, invoiceParams)` (using active grants at `asOfMs` ordered by `expiresAtMs ASC, grantId ASC`, debiting consumed cents inside registry state, recording the finalized invoice), `voidInvoiceSettlement(registry, invoiceId, voidedAtMs)`, and `getRegistrySnapshot(registry, asOfMs = 0)` returning `{ invoices, grants, poolBalance }` where `invoices` is an array of stored invoice objects (`status: "FINALIZED"` or `"VOIDED"`).',
      '3. `voidInvoiceSettlement`: throw `ERR_UNKNOWN_INVOICE` if missing and `ERR_ALREADY_VOIDED` if already `VOIDED`. Otherwise mark the invoice `VOIDED`, restore each credit allocation to its grant in registry state, and return `{ invoiceId, status: "VOIDED", voidedAtMs, netDeltaCents, restoredActiveCents, restoredExpiredCents, reversalWireDigest }` where `netDeltaCents` is `invoice.totalDueCents === 0 ? 0 : -invoice.totalDueCents` (normalized `0`, never `-0`), splitting restored cents between grants with `voidedAtMs < grant.expiresAtMs` (`restoredActiveCents`) vs `voidedAtMs >= grant.expiresAtMs` (`restoredExpiredCents`). Restored expired grants must NOT be usable by subsequent `settleInvoice` calls.',
      '4. `reversalWireDigest` uses `encodeFrozenWireDigest({ ...invoice, status: "VOIDED" })`.',
      'Constraints: (1) Keep all existing `ERROR_CODES` unchanged. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T07',
    is_spare: false,
    difficulty: 'hard',
    title: 'Fix IANA DST spring-forward/fall-back/30m billing windows and buildDailyWindowInvoices',
    target_files: ['src/clock.mjs', 'src/invoiceBuilder.mjs'],
    constraints: [
      'Zero external dependencies (Node built-in Date/Intl only)',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Fix DST-aware billing windows in `src/clock.mjs` and add `buildDailyWindowInvoices` in `src/invoiceBuilder.mjs`:',
      '1. In `src/clock.mjs`: for any local calendar date `(Y, M, D)` in IANA `timeZone` and `anchorHourLocal` (`0..23`), define canonical anchor `anchorUtcMs(Y, M, D)` as:',
      '   - Unique occurrence if `(Y, M, D, anchorHourLocal:00:00)` exists once;',
      '   - Spring-forward gap (local hour skipped): exact first valid UTC instant at or after the transition (e.g. `2026-03-08 02:00` in `America/New_York` resolves to `03:00 EDT` = `2026-03-08T07:00:00.000Z`);',
      '   - Fall-back fold (local hour occurs twice): the FIRST (pre-transition) occurrence (e.g. `2026-11-01 01:00` in `America/New_York` resolves to `01:00 EDT` = `2026-11-01T05:00:00.000Z`).',
      '2. Each local day `d` spans `[anchorUtcMs(d), anchorUtcMs(d + 1 day))`. `getBillingWindowBounds(utcMs, timeZone, anchorHourLocal)` returns `{ startUtcMs, endUtcMs, localDate, timeZone }` containing `utcMs`, where `localDate` is `YYYY-MM-DD` of `d`. `enumerateDailyWindows(startUtcMs, endUtcMs, timeZone, anchorHourLocal)` returns contiguous windows (`windows[i].endUtcMs === windows[i+1].startUtcMs`) intersecting `[startUtcMs, endUtcMs)`, or `[]` when `startUtcMs === endUtcMs`. Must handle 30-min DST (`Australia/Lord_Howe`) and Southern Hemisphere (`Pacific/Auckland`).',
      '3. In `src/invoiceBuilder.mjs`: implement `buildDailyWindowInvoices({ accountId, currency = "USD", timeZone = "UTC", anchorHourLocal = 0, rangeStartUtcMs, rangeEndUtcMs, events = [], metricTiers = {}, grants = [] })` emitting one invoice per enumerated window (`invoiceId: `${accountId}:${w.localDate}``, `asOfMs: w.startUtcMs`), bucketing events with `rangeStartUtcMs <= evt.timestampMs < rangeEndUtcMs` into `[w.startUtcMs, w.endUtcMs)`, sorting `usageRows` by `metric` ascending, and carrying remaining active credit balances chronologically across windows without mutating input `grants`.',
      'Constraints: (1) Zero external dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T08',
    is_spare: false,
    difficulty: 'hard',
    title: 'Fix queryDsl escaping/precedence/nulls and BatchIngestor async concurrency + rollback',
    target_files: ['src/queryDsl.mjs', 'src/batchIngestor.mjs'],
    constraints: [
      'Zero eval() or new Function() in src/',
      'Do not modify src/frozenWire.mjs or src/errors.mjs'
    ],
    spec: [
      'Fix coupled defects in `src/queryDsl.mjs` and `src/batchIngestor.mjs`:',
      '1. In `src/queryDsl.mjs`:',
      '   - Fix string literal scanning and unescaping (`\\\\`, `\\"`, `\\n`, `\\t`) so `"C:\\\\temp\\\\"` ends cleanly as `C:\\temp\\` and dangling escapes or unterminated strings throw `LedgerError(ERROR_CODES.ERR_DSL_SYNTAX)`.',
      '   - Enforce strict precedence `()` > `NOT` > `AND` > `OR`.',
      '   - Fix null/undefined/missing-field comparison semantics: missing nested paths evaluate as `undefined`; `==` and `!=` treat `null` and `undefined` as equal (`missing == null` is `true`, `missing != "x"` is `true`), while `<, <=, >, >=` MUST return `false` whenever either side is `null`, `undefined`, or `NaN`.',
      '2. In `src/batchIngestor.mjs`:',
      '   - Serialize all `flush()` and `ingest()`-triggered flushes via an internal async queue/mutex so `sinkFn` never runs concurrently, mid-flight `ingest()` calls are never dropped or double-delivered, and events remain strictly ordered.',
      '   - If `sinkFn(batch)` rejects, restore the failed `batch` to the FRONT of the buffer (ahead of any newly ingested items that arrived while awaiting `sinkFn`), leave `committedWatermarkSeq` and `totalCommitted` unchanged, and rethrow the error so a retry `flush()` delivers all events in exact sequence order.',
      'Constraints: (1) Zero `eval()` or `new Function()` under `src/`. (2) Do not modify `src/frozenWire.mjs` or `src/errors.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'S01',
    is_spare: true,
    difficulty: 'easy',
    title: 'SPARE: Implement exportInvoiceCsv with RFC-4180 quoting and CSV formula-injection neutralization',
    target_files: ['src/invoiceBuilder.mjs'],
    constraints: [
      'Zero dependencies in package.json',
      'Do not modify src/frozenWire.mjs'
    ],
    spec: [
      'Add `exportInvoiceCsv(invoice)` to `src/invoiceBuilder.mjs`:',
      '1. Emit header `invoiceId,accountId,currency,metric,units,amountCents,totalDueCents` followed by one line per `lineItem` in `invoice.lineItems` (LF-delimited).',
      '2. Neutralize spreadsheet formula injection on string fields (`invoiceId`, `accountId`, `currency`, `metric`) by prefixing a single quote `\'` when the string starts with `=`, `+`, `-`, `@`, `\\t`, or `\\r`. Keep numeric columns (`units`, `amountCents`, `totalDueCents`) unprefixed integers.',
      '3. Apply RFC-4180 CSV quoting (wrap in `"..."` and double internal `"` when a cell contains `,`, `"`, `\\n`, or `\\r`).',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'S02',
    is_spare: true,
    difficulty: 'hard',
    title: 'SPARE: Atomic transactional batch ingestion with duplicate coalescing and full rollback',
    target_files: ['src/idempotencyGuard.mjs', 'src/batchIngestor.mjs'],
    constraints: [
      'Zero dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/errors.mjs'
    ],
    spec: [
      'Implement atomic transactional batch ingestion across `src/idempotencyGuard.mjs` and `src/batchIngestor.mjs`:',
      '1. Add `snapshot()` / `restore(snap)` on `IdempotencyGuard` (fixing inclusive expiry/conflict precedence as needed) and `BatchIngestor` (preserving buffer, watermark, and committed counts).',
      '2. Implement `ingestTransactionalBatch(guard, ingestor, events, nowMs)` in `src/batchIngestor.mjs` where each element of `events` has shape `{ key, payloadHash, seq, metric, units }`:',
      '   - Coalesce identical `(key, payloadHash)` duplicates within the batch so only the first is queued into `ingestor`.',
      '   - If any event is invalid (`ERR_INVALID_EVENT`) or has an idempotency conflict (either against `guard` prior state OR against an earlier event in the same batch) or triggers a failing sink flush, roll back BOTH `guard` and `ingestor` atomically and rethrow.',
      'Constraints: (1) Zero dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/errors.mjs`.'
    ].join('\n')
  }
]);

export function buildTurn1Prompt(task) {
  return `${TURN1_PLAN_PREFIX}\n\n## Task ${task.task_id}: ${task.title}\n\n${task.spec}`;
}
