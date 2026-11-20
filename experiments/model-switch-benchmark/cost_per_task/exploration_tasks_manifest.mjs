/**
 * Longer Multi-File Exploration Tasks (T09..T11) + 24-file Realistic Domain Overlay
 *
 * Designed specifically for Idea #4 (Haiku Read-Only Scout benchmark):
 *   - 16 frozen template files + 24 overlaid files = 40 files (~145 KB total)
 *   - Target implementation files are NOT named in task prompts; the agent must
 *     locate policies, adapters, services, and runbooks across src/ and docs/runbooks/.
 *   - T01..T08 and task_repo_template/ remain 100% untouched.
 */

import fs from 'node:fs';
import path from 'node:path';

export const EXPLORATION_TASKS = Object.freeze([
  {
    task_id: 'T09',
    is_spare: false,
    is_exploration: true,
    difficulty: 'hard',
    title: 'Fix cross-border billing pipeline: discount stacking, FX triangulation, and reverse-charge tax',
    constraints: [
      'Zero external dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Customer billing reports show incorrect totals on cross-border multi-currency invoices that use coupons or B2B VAT reverse charge.',
      'Explore the billing policies, FX conversion logic, billing service orchestrator, and relevant engineering runbooks in this repository (do NOT modify `src/frozenWire.mjs` or `src/constants.mjs`), then fix all coupled defects so the cross-border billing pipeline matches documented policy:',
      '1. Stacked discounts (`applyStackedDiscounts`): enforce documented application order (`PERCENT` coupons before `FIXED_CENTS` coupons), validate negative/non-finite gross amounts with `LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT)`, round each step half-away-from-zero, and floor the resulting subtotal at `0` (never negative).',
      '2. FX conversion (`convertCurrencyCents`): preserve exact amount on same-currency conversions, validate supported positive `usdRates` (throwing `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)` on missing/invalid currency rates), and perform triangulated cross-currency conversion without premature intermediate integer rounding (single half-away-from-zero round at the end).',
      '3. Cross-border invoice orchestration (`computeCrossBorderInvoice`): calculate tax AFTER discounts and FX conversion (on `convertedSubtotalCents`), honor B2B reverse-charge zero-tax when `taxExemptReverseCharge === true`, a non-empty `vatId` is provided, and `customerCountry` is non-US (`reverseChargeApplied: true`, `taxCents: 0`), and emit the `LP-WIRE-V1` `wireDigest` for `billingCurrency` and `totalDueCents`.',
      'Constraints: (1) Zero external dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T10',
    is_spare: false,
    is_exploration: true,
    difficulty: 'hard',
    title: 'Fix settlement reconciliation drift, credit memo sign/expiry, and canonical ledger ordering',
    constraints: [
      'Zero external dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/errors.mjs'
    ],
    spec: [
      'End-of-day settlement reconciliation is flagging false variances when batches contain refunds, expired credits, disputed invoices, or EUR/GBP payouts.',
      'Explore the settlement adapters, reconciliation service, and reconciliation runbooks across this repository (do NOT modify `src/frozenWire.mjs` or `src/errors.mjs`), then fix all coupled defects:',
      '1. Credit memo normalization (`normalizeCreditMemos`): treat `expiresAtMs <= asOfMs` as expired (excluded, matching inclusive expiry semantics) and map `REFUND` / `CREDIT_NOTE` adjustments as negative deltas (`-magnitude`) vs `DEBIT_MEMO` (`+magnitude`) instead of adding refunds upward.',
      '2. Canonical ledger snapshot rows (`buildCanonicalLedgerRows`): return a new sorted array without mutating caller input, ordered numerically by `postedAtMs ASC`, then `invoiceId ASC`, then `entryId ASC`.',
      '3. Batch settlement reconciler (`reconcileSettlementBatch`): isolate invoices listed in `disputedInvoiceIds` with status `DISPUTE_HOLD` (tracked in `heldBackUsdCents`, never flagged as `DRIFT` discrepancies), apply continuous USD FX triangulation for multi-currency payouts, and allow `Math.abs(varianceUsdCents) <= toleranceCents` (default `1` cent) as `MATCHED` while surfacing mismatches above tolerance in `discrepancies`.',
      'Constraints: (1) Zero external dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/errors.mjs`.'
    ].join('\n')
  },
  {
    task_id: 'T11',
    is_spare: false,
    is_exploration: true,
    difficulty: 'hard',
    title: 'Fix mid-cycle proration, usage meter boundary/dedupe, and SOFT_GRACE entitlement overage',
    constraints: [
      'Zero external dependencies in package.json',
      'Do not modify src/frozenWire.mjs or src/constants.mjs'
    ],
    spec: [
      'Tenants joining mid-month during 28-day and 31-day billing cycles report overcharged prorated fees, dropped events at exact period start timestamps, duplicate retry billing, and premature hard blocks on SOFT_GRACE plans.',
      'Explore the proration policies, usage metering adapters, entitlement router, and entitlement runbooks across this repository (do NOT modify `src/frozenWire.mjs` or `src/constants.mjs`), then fix all coupled defects:',
      '1. Mid-cycle proration (`computeProratedAllowanceAndFee`): calculate the active overlap inside `[periodStartMs, periodEndMs)` divided by the actual `(periodEndMs - periodStartMs)` duration (never hardcode a 30-day denominator or round intermediate daily rates), and apply a single half-away-from-zero round for `proratedFeeCents` and `proratedUnits`.',
      '2. Metered usage aggregation (`aggregateMeteredUsage`): enforce the half-open window `[periodStartMs, periodEndMs)` (`periodStartMs` inclusive, `periodEndMs` exclusive), validate non-negative `units` (`ERR_NEGATIVE_UNITS`), and deduplicate retried records sharing the same non-empty `eventId`.',
      '3. Entitlement overage evaluation (`evaluateSubscriptionEntitlement`): apply `effectiveAllowance = policyMode === "SOFT_GRACE" ? proratedUnits + graceBufferUnits : proratedUnits`, include `effectiveAllowance` in the returned summary, set `allowed: usedUnits <= effectiveAllowance` and `status` (`WITHIN_ALLOWANCE` | `GRACE_ALLOWED` | `OVER_LIMIT`), and compute `overageUnits = Math.max(0, usedUnits - effectiveAllowance)` and `overageFeeCents`.',
      'Constraints: (1) Zero external dependencies in package.json. (2) Do not modify `src/frozenWire.mjs` or `src/constants.mjs`.'
    ].join('\n')
  }
]);

export function buildExplorationPadLines(prefix, count = 95) {
  return Array.from({ length: count }, (_, idx) => {
    const n = idx + 1;
    return `export function ${prefix}Helper_${String(n).padStart(2, '0')}(amountCents = 0, bps = 0) { const v = Math.trunc(Number(amountCents) || 0); return Math.max(0, v + Math.trunc((v * (Number(bps) || 0)) / 10_000) + (${n} % 3)); }`;
  }).join('\n');
}

function padLines(prefix, count = 95) {
  return buildExplorationPadLines(prefix, count);
}

function padRunbookSections(title, code, count = 85) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    if (i % 15 === 1) {
      rows.push(`\n### Control Check ${code}-${String(i).padStart(3, '0')}\n`);
    }
    rows.push(`- [${code}-${String(i).padStart(3, '0')}] Audit checkpoint: verify deterministic integer cent invariants, FX/tax boundary logging, and non-mutating snapshot handoffs across settlement services.`);
  }
  return rows.join('\n');
}

function buildOverlayFiles() {
  const files = {};

  // ---- POLICIES (6 files) ----
  files['src/policies/discountStackingPolicy.mjs'] = [
    "import { ERROR_CODES, LedgerError } from '../errors.mjs';",
    '',
    'function roundHalfAwayFromZero(val) {',
    '  if (!Number.isFinite(val)) return 0;',
    '  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);',
    '}',
    '',
    '/**',
    ' * Stacks percentage and fixed-cent coupons onto a gross invoice subtotal.',
    ' * Refer to docs/runbooks/TAX_AND_FX_RUNBOOK.md for canonical stacking order and floor policy.',
    ' */',
    'export function applyStackedDiscounts(grossCents, discounts = []) {',
    '  // DEFECT: does not validate non-finite / negative grossCents cleanly,',
    '  // applies FIXED_CENTS before PERCENT, and forgets to floor at 0.',
    '  let running = Math.trunc(Number(grossCents || 0));',
    '  const list = Array.isArray(discounts) ? discounts : [];',
    '  const appliedCodes = [];',
    '  const fixed = list.filter((d) => d && String(d.type).toUpperCase() === \'FIXED_CENTS\');',
    '  const pct = list.filter((d) => d && String(d.type).toUpperCase() === \'PERCENT\');',
    '',
    '  for (const d of fixed) {',
    '    const amt = roundHalfAwayFromZero(Number(d.value || 0));',
    '    if (amt > 0) {',
    '      running -= amt;',
    '      if (d.code) appliedCodes.push(String(d.code));',
    '    }',
    '  }',
    '  for (const d of pct) {',
    '    const rate = Number(d.value || 0);',
    '    if (rate > 0) {',
    '      running -= roundHalfAwayFromZero((running * rate) / 100);',
    '      if (d.code) appliedCodes.push(String(d.code));',
    '    }',
    '  }',
    '  return {',
    '    grossCents: Math.trunc(Number(grossCents || 0)),',
    '    discountedCents: running,',
    '    totalDiscountCents: Math.trunc(Number(grossCents || 0)) - running,',
    '    appliedCodes,',
    '    errCode: ERROR_CODES.ERR_INVALID_AMOUNT,',
    '    LedgerErrorRef: LedgerError',
    '  };',
    '}',
    '',
    '// Standard coupon schedule reference helpers',
    padLines('discountSchedule', 92)
  ].join('\n');

  files['src/policies/fxConversionPolicy.mjs'] = [
    "import { ERROR_CODES, LedgerError } from '../errors.mjs';",
    '',
    'export const DEFAULT_USD_RATES = Object.freeze({',
    '  USD: 1,',
    '  EUR: 1.1,',
    '  GBP: 1.25',
    '});',
    '',
    'function roundHalfAwayFromZero(val) {',
    '  if (!Number.isFinite(val)) return 0;',
    '  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);',
    '}',
    '',
    '/**',
    ' * Converts minor-unit cents from `fromCurrency` to `toCurrency` via USD triangulation.',
    ' */',
    'export function convertCurrencyCents({',
    '  amountCents,',
    "  fromCurrency = 'USD',",
    "  toCurrency = 'USD',",
    '  usdRates = DEFAULT_USD_RATES',
    '} = {}) {',
    '  const amt = Number(amountCents);',
    '  if (!Number.isFinite(amt) || amt < 0) {',
    "    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Invalid FX conversion amount');",
    '  }',
    '  const from = String(fromCurrency || \'USD\').toUpperCase();',
    '  const to = String(toCurrency || \'USD\').toUpperCase();',
    '  const fromRate = Number(usdRates?.[from]);',
    '  const toRate = Number(usdRates?.[to]);',
    '  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {',
    "    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, `Missing FX rate for ${from}->${to}`);",
    '  }',
    '  if (from === to) {',
    '    return {',
    '      convertedCents: Math.trunc(amt),',
    '      fromCurrency: from,',
    '      toCurrency: to,',
    '      effectiveRate: 1',
    '    };',
    '  }',
    '  // DEFECT: prematurely rounds intermediate USD cents before converting to target currency',
    '  // and truncates final result instead of half-away-from-zero.',
    '  const intermediateUsdCents = Math.round(amt * fromRate);',
    '  const convertedCents = Math.trunc(intermediateUsdCents / toRate);',
    '  return {',
    '    convertedCents,',
    '    fromCurrency: from,',
    '    toCurrency: to,',
    '    effectiveRate: Number((fromRate / toRate).toFixed(6))',
    '  };',
    '}',
    '',
    '// Triangulated FX corridor reference helpers',
    padLines('fxCorridor', 90)
  ].join('\n');

  files['src/policies/prorationPolicy.mjs'] = [
    "import { ERROR_CODES, LedgerError } from '../errors.mjs';",
    '',
    'const LEGACY_THIRTY_DAY_MS = 30 * 86_400_000;',
    '',
    'function roundHalfAwayFromZero(val) {',
    '  if (!Number.isFinite(val)) return 0;',
    '  return val >= 0 ? Math.floor(val + 0.5) : -Math.floor(Math.abs(val) + 0.5);',
    '}',
    '',
    '/**',
    ' * Computes mid-cycle prorated subscription fee and included entitlement units.',
    ' */',
    'export function computeProratedAllowanceAndFee({',
    '  annualOrMonthlyFeeCents = 0,',
    '  includedUnits = 0,',
    '  planStartMs,',
    '  planEndMs,',
    '  periodStartMs,',
    '  periodEndMs',
    '} = {}) {',
    '  const fee = Number(annualOrMonthlyFeeCents);',
    '  const units = Number(includedUnits);',
    '  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(units) || units < 0) {',
    "    throw new LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT, 'Invalid proration fee or units');",
    '  }',
    '  if (!(periodEndMs > periodStartMs)) {',
    "    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid billing period bounds');",
    '  }',
    '  const overlapStart = Math.max(Number(planStartMs ?? periodStartMs), Number(periodStartMs));',
    '  const overlapEnd = Math.min(Number(planEndMs ?? periodEndMs), Number(periodEndMs));',
    '  const activeMs = Math.max(0, overlapEnd - overlapStart);',
    '  if (activeMs <= 0) {',
    '    return { ratio: 0, proratedFeeCents: 0, proratedUnits: 0 };',
    '  }',
    '  // DEFECT: hardcodes 30-day denominator and rounds intermediate daily rate',
    '  const activeDays = activeMs / 86_400_000;',
    '  const dailyFee = Math.round(fee / 30);',
    '  const dailyUnits = Math.round(units / 30);',
    '  const ratio = Number((activeMs / LEGACY_THIRTY_DAY_MS).toFixed(6));',
    '  return {',
    '    ratio,',
    '    proratedFeeCents: roundHalfAwayFromZero(dailyFee * activeDays),',
    '    proratedUnits: roundHalfAwayFromZero(dailyUnits * activeDays)',
    '  };',
    '}',
    '',
    '// Mid-cycle proration schedule utilities',
    padLines('prorationAnchor', 92)
  ].join('\n');

  files['src/policies/taxNexusPolicy.mjs'] = [
    "import { MAX_BPS } from '../constants.mjs';",
    '',
    'export const US_NEXUS_RATE_BPS = Object.freeze({',
    '  CA: 825,',
    '  NY: 887,',
    '  TX: 625,',
    '  WA: 650,',
    '  MA: 625',
    '});',
    '',
    'export function resolveDomesticNexusRateBps(stateCode = \'\') {',
    '  const key = String(stateCode || \'\').trim().toUpperCase();',
    '  return US_NEXUS_RATE_BPS[key] || 0;',
    '}',
    '',
    'export function estimateDomesticTaxCents(subtotalCents, stateCode) {',
    '  const bps = resolveDomesticNexusRateBps(stateCode);',
    '  return Math.round((Math.max(0, Number(subtotalCents || 0)) * bps) / MAX_BPS);',
    '}',
    '',
    padLines('taxNexusRule', 95)
  ].join('\n');

  files['src/policies/dunningPolicy.mjs'] = [
    'export const DUNNING_RETRY_DAYS = Object.freeze([1, 3, 7, 14]);',
    '',
    'export function evaluateDunningStage(pastDueDays = 0) {',
    '  const d = Math.max(0, Number(pastDueDays) || 0);',
    "  if (d >= 21) return { stage: 'SUSPEND', notifyCustomer: true };",
    "  if (d >= 7) return { stage: 'FINAL_WARNING', notifyCustomer: true };",
    "  if (d >= 1) return { stage: 'SOFT_RETRY', notifyCustomer: false };",
    "  return { stage: 'CURRENT', notifyCustomer: false };",
    '}',
    '',
    padLines('dunningBackoff', 95)
  ].join('\n');

  files['src/policies/retentionPolicy.mjs'] = [
    'export const DEFAULT_RETENTION_DAYS = Object.freeze({',
    '  RAW_EVENTS: 90,',
    '  INVOICE_SNAPSHOTS: 2555,',
    '  AUDIT_TRAIL: 2555',
    '});',
    '',
    'export function isRecordExpired(createdAtMs, asOfMs, retentionDays = DEFAULT_RETENTION_DAYS.RAW_EVENTS) {',
    '  const ttlMs = Math.max(1, Number(retentionDays || 1)) * 86_400_000;',
    '  return Number(asOfMs) >= Number(createdAtMs) + ttlMs;',
    '}',
    '',
    padLines('retentionWindow', 95)
  ].join('\n');

  // ---- ADAPTERS (6 files) ----
  files['src/adapters/creditMemoAdapter.mjs'] = [
    "import { ERROR_CODES, LedgerError } from '../errors.mjs';",
    '',
    '/**',
    ' * Normalizes credit/refund/debit memos into signed adjustment entries against gross settlement.',
    ' * Refer to docs/runbooks/SETTLEMENT_RECONCILIATION_RUNBOOK.md.',
    ' */',
    'export function normalizeCreditMemos(memos = [], asOfMs = 0) {',
    '  if (!Array.isArray(memos)) {',
    "    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'memos must be an array');",
    '  }',
    '  const normalized = [];',
    '  for (const m of memos) {',
    '    if (!m || !m.invoiceId) continue;',
    '    const mag = Math.abs(Math.trunc(Number(m.amountCents || 0)));',
    "    const kind = String(m.kind || 'CREDIT_NOTE').toUpperCase();",
    '    // DEFECT: does not filter expired memos (`expiresAtMs <= asOfMs`),',
    '    // and adds REFUND upward instead of subtracting.',
    '    let signedDeltaCents = mag;',
    "    if (kind === 'CREDIT_NOTE') signedDeltaCents = -mag;",
    '    normalized.push({',
    '      memoId: String(m.memoId || \'\'),',
    '      invoiceId: String(m.invoiceId),',
    '      kind,',
    "      currency: String(m.currency || 'USD').toUpperCase(),",
    '      signedDeltaCents,',
    '      issuedAtMs: Number(m.issuedAtMs || 0),',
    '      expiresAtMs: m.expiresAtMs ?? null,',
    '      asOfMsChecked: asOfMs',
    '    });',
    '  }',
    '  return normalized;',
    '}',
    '',
    padLines('creditMemoNorm', 92)
  ].join('\n');

  files['src/adapters/ledgerSnapshotAdapter.mjs'] = [
    '/**',
    ' * Normalizes and canonically orders ledger snapshot entries for deterministic reconciliation.',
    ' */',
    'export function buildCanonicalLedgerRows(entries = []) {',
    '  if (!Array.isArray(entries)) return [];',
    '  // DEFECT: mutates caller array in-place and sorts lexicographically by raw toString / amount',
    '  return entries.sort((a, b) => String(a?.postedAtMs).localeCompare(String(b?.postedAtMs)));',
    '}',
    '',
    padLines('ledgerSnapshotMap', 95)
  ].join('\n');

  files['src/adapters/usageMeterAdapter.mjs'] = [
    "import { ERROR_CODES, LedgerError } from '../errors.mjs';",
    '',
    '/**',
    ' * Aggregates metered usage events inside `[periodStartMs, periodEndMs)` with `eventId` dedupe.',
    ' * Refer to docs/runbooks/ENTITLEMENT_OVERAGE_RUNBOOK.md.',
    ' */',
    'export function aggregateMeteredUsage(events = [], {',
    '  accountId,',
    '  metric,',
    '  periodStartMs,',
    '  periodEndMs',
    '} = {}) {',
    '  const list = Array.isArray(events) ? events : [];',
    '  let usedUnits = 0;',
    '  let countedEvents = 0;',
    '  for (const ev of list) {',
    '    if (!ev) continue;',
    '    if (accountId && ev.accountId !== accountId) continue;',
    '    if (metric && ev.metric !== metric) continue;',
    '    const units = Number(ev.units);',
    '    if (!Number.isFinite(units) || units < 0) {',
    "      throw new LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS, 'Usage event units must be >= 0');",
    '    }',
    '    const ts = Number(ev.timestampMs);',
    '    // DEFECT: excludes events timestamped at exact `periodStartMs`, and does not dedupe `eventId`.',
    '    if (ts > periodStartMs && ts < periodEndMs) {',
    '      usedUnits += Math.trunc(units);',
    '      countedEvents += 1;',
    '    }',
    '  }',
    '  return { usedUnits, dedupedEventCount: countedEvents };',
    '}',
    '',
    padLines('usageMeterBatch', 92)
  ].join('\n');

  files['src/adapters/stripeExportAdapter.mjs'] = [
    "import { encodeFrozenWireDigest } from '../frozenWire.mjs';",
    '',
    'export function formatStripeJournalRow(invoice = {}) {',
    '  return {',
    "    id: String(invoice.invoiceId || ''),",
    "    currency: String(invoice.currency || 'USD').toLowerCase(),",
    '    amount_due: Math.trunc(Number(invoice.totalDueCents || 0)),',
    '    wire_digest: encodeFrozenWireDigest(invoice)',
    '  };',
    '}',
    '',
    padLines('stripeExport', 95)
  ].join('\n');

  files['src/adapters/erpJournalAdapter.mjs'] = [
    'export function mapInvoiceToErpEntries(invoice = {}) {',
    '  const amt = Math.trunc(Number(invoice.totalDueCents || 0));',
    '  return [',
    "    { account: '1200-AR', debitCents: amt, creditCents: 0, ref: invoice.invoiceId },",
    "    { account: '4000-REV', debitCents: 0, creditCents: amt, ref: invoice.invoiceId }",
    '  ];',
    '}',
    '',
    padLines('erpJournal', 95)
  ].join('\n');

  files['src/adapters/taxProviderAdapter.mjs'] = [
    'export function normalizeExternalTaxQuote(quote = {}) {',
    '  const taxableCents = Math.max(0, Math.trunc(Number(quote.taxableCents || 0)));',
    '  const rateBps = Math.max(0, Math.trunc(Number(quote.rateBps || 0)));',
    '  return {',
    '    provider: String(quote.provider || \'INTERNAL\'),',
    '    taxableCents,',
    '    rateBps,',
    '    taxCents: Math.round((taxableCents * rateBps) / 10_000)',
    '  };',
    '}',
    '',
    padLines('taxQuoteNorm', 95)
  ].join('\n');

  // ---- SERVICES (6 files) ----
  files['src/services/billingOrchestrator.mjs'] = [
    "import { INVOICE_STATUS, MAX_BPS } from '../constants.mjs';",
    "import { encodeFrozenWireDigest } from '../frozenWire.mjs';",
    "import { applyStackedDiscounts } from '../policies/discountStackingPolicy.mjs';",
    "import { convertCurrencyCents, DEFAULT_USD_RATES } from '../policies/fxConversionPolicy.mjs';",
    '',
    '/**',
    ' * Cross-border invoice computation pipeline.',
    ' * Refer to docs/runbooks/TAX_AND_FX_RUNBOOK.md for B2B reverse-charge and FX order rules.',
    ' */',
    'export function computeCrossBorderInvoice({',
    '  invoiceId,',
    '  accountId,',
    '  grossCents = 0,',
    "  currency = 'USD',",
    '  billingCurrency = currency,',
    '  discounts = [],',
    "  customerCountry = 'US',",
    '  taxExemptReverseCharge = false,',
    '  vatId = null,',
    '  usdRates = DEFAULT_USD_RATES,',
    '  taxRateBps = 0,',
    '  asOfMs = 0',
    '} = {}) {',
    '  const discRes = applyStackedDiscounts(grossCents, discounts);',
    '  const fxRes = convertCurrencyCents({',
    '    amountCents: discRes.discountedCents,',
    '    fromCurrency: currency,',
    '    toCurrency: billingCurrency,',
    '    usdRates',
    '  });',
    '  // DEFECT: charges tax on unconverted grossCents and ignores reverse-charge VAT exemption',
    '  const taxCents = Math.round((Math.trunc(Number(grossCents || 0)) * Number(taxRateBps || 0)) / MAX_BPS);',
    '  const reverseChargeApplied = false;',
    '  const totalDueCents = fxRes.convertedCents + taxCents;',
    '  const wireDigest = encodeFrozenWireDigest({',
    '    invoiceId,',
    '    accountId,',
    '    currency: fxRes.toCurrency,',
    '    totalDueCents,',
    '    status: INVOICE_STATUS.FINALIZED',
    '  });',
    '  return {',
    '    invoiceId,',
    '    accountId,',
    '    asOfMs,',
    '    currency: fxRes.toCurrency,',
    '    grossCents: discRes.grossCents,',
    '    discountedSourceCents: discRes.discountedCents,',
    '    convertedSubtotalCents: fxRes.convertedCents,',
    '    taxCents,',
    '    reverseChargeApplied,',
    '    customerCountry,',
    '    vatId,',
    '    taxExemptReverseCharge,',
    '    totalDueCents,',
    '    appliedDiscountCodes: discRes.appliedCodes,',
    '    wireDigest',
    '  };',
    '}',
    '',
    padLines('billingPipeline', 90)
  ].join('\n');

  files['src/services/settlementReconciler.mjs'] = [
    "import { normalizeCreditMemos } from '../adapters/creditMemoAdapter.mjs';",
    "import { buildCanonicalLedgerRows } from '../adapters/ledgerSnapshotAdapter.mjs';",
    "import { convertCurrencyCents, DEFAULT_USD_RATES } from '../policies/fxConversionPolicy.mjs';",
    '',
    '/**',
    ' * Reconciles settled merchant payouts against canonical ledger rows and credit memos.',
    ' * Refer to docs/runbooks/SETTLEMENT_RECONCILIATION_RUNBOOK.md.',
    ' */',
    'export function reconcileSettlementBatch({',
    '  ledgerEntries = [],',
    '  payoutRecords = [],',
    '  creditMemos = [],',
    '  disputedInvoiceIds = [],',
    '  usdRates = DEFAULT_USD_RATES,',
    '  asOfMs = 0,',
    '  toleranceCents = 1',
    '} = {}) {',
    '  const rows = buildCanonicalLedgerRows(ledgerEntries);',
    '  const memos = normalizeCreditMemos(creditMemos, asOfMs);',
    '  const byInvoice = new Map();',
    '',
    '  const ensure = (id) => {',
    '    if (!byInvoice.has(id)) {',
    '      byInvoice.set(id, { expectedUsdCents: 0, payoutUsdCents: 0, disputed: false });',
    '    }',
    '    return byInvoice.get(id);',
    '  };',
    '  for (const r of rows) {',
    '    if (!r?.invoiceId) continue;',
    '    const rec = ensure(String(r.invoiceId));',
    '    const conv = convertCurrencyCents({',
    '      amountCents: Number(r.amountCents || 0),',
    "      fromCurrency: r.currency || 'USD',",
    "      toCurrency: 'USD',",
    '      usdRates',
    '    });',
    '    rec.expectedUsdCents += conv.convertedCents;',
    '  }',
    '  for (const m of memos) {',
    '    const rec = ensure(String(m.invoiceId));',
    '    rec.expectedUsdCents += m.signedDeltaCents;',
    '  }',
    '  for (const p of payoutRecords) {',
    '    if (!p?.invoiceId) continue;',
    '    const rec = ensure(String(p.invoiceId));',
    '    const conv = convertCurrencyCents({',
    '      amountCents: Number(p.amountCents || 0),',
    "      fromCurrency: p.currency || 'USD',",
    "      toCurrency: 'USD',",
    '      usdRates',
    '    });',
    '    rec.payoutUsdCents += conv.convertedCents;',
    '  }',
    '',
    '  // DEFECT: ignores disputedInvoiceIds holdbacks and ignores toleranceCents rounding margin',
    '  const invoiceStatuses = {};',
    '  const discrepancies = [];',
    '  let expectedNetUsdCents = 0;',
    '  let actualPayoutUsdCents = 0;',
    '  for (const [invoiceId, rec] of byInvoice.entries()) {',
    '    expectedNetUsdCents += rec.expectedUsdCents;',
    '    actualPayoutUsdCents += rec.payoutUsdCents;',
    '    const variance = rec.payoutUsdCents - rec.expectedUsdCents;',
    '    if (variance !== 0) {',
    "      invoiceStatuses[invoiceId] = 'DRIFT';",
    '      discrepancies.push({ invoiceId, expectedUsdCents: rec.expectedUsdCents, actualUsdCents: rec.payoutUsdCents, varianceUsdCents: variance });',
    '    } else {',
    "      invoiceStatuses[invoiceId] = 'MATCHED';",
    '    }',
    '  }',
    '  return {',
    '    reconciled: discrepancies.length === 0,',
    '    toleranceCents,',
    '    disputedCount: Array.isArray(disputedInvoiceIds) ? disputedInvoiceIds.length : 0,',
    '    expectedNetUsdCents,',
    '    actualPayoutUsdCents,',
    '    heldBackUsdCents: 0,',
    '    totalVarianceUsdCents: actualPayoutUsdCents - expectedNetUsdCents,',
    '    invoiceStatuses,',
    '    discrepancies',
    '  };',
    '}',
    '',
    padLines('settlementBatch', 85)
  ].join('\n');

  files['src/services/entitlementRouter.mjs'] = [
    "import { computeProratedAllowanceAndFee } from '../policies/prorationPolicy.mjs';",
    "import { aggregateMeteredUsage } from '../adapters/usageMeterAdapter.mjs';",
    '',
    '/**',
    ' * Evaluates subscription entitlement, prorated fee/allowance, and SOFT_GRACE vs HARD_CAP overage.',
    ' * Refer to docs/runbooks/ENTITLEMENT_OVERAGE_RUNBOOK.md.',
    ' */',
    'export function evaluateSubscriptionEntitlement({',
    '  accountId,',
    '  metric,',
    '  baseFeeCents = 0,',
    '  includedUnits = 0,',
    '  graceBufferUnits = 0,',
    '  overageUnitRateCents = 0,',
    "  policyMode = 'HARD_CAP',",
    '  periodStartMs,',
    '  periodEndMs,',
    '  planStartMs = periodStartMs,',
    '  planEndMs = periodEndMs,',
    '  usageEvents = []',
    '} = {}) {',
    '  const proration = computeProratedAllowanceAndFee({',
    '    annualOrMonthlyFeeCents: baseFeeCents,',
    '    includedUnits,',
    '    planStartMs,',
    '    planEndMs,',
    '    periodStartMs,',
    '    periodEndMs',
    '  });',
    '  const usage = aggregateMeteredUsage(usageEvents, {',
    '    accountId,',
    '    metric,',
    '    periodStartMs,',
    '    periodEndMs',
    '  });',
    '  // DEFECT: ignores graceBufferUnits in SOFT_GRACE mode and omits effectiveAllowance',
    '  const overageUnits = Math.max(0, usage.usedUnits - proration.proratedUnits);',
    '  const overageFeeCents = overageUnits * Math.max(0, Math.trunc(Number(overageUnitRateCents || 0)));',
    '  const allowed = usage.usedUnits <= proration.proratedUnits;',
    "  const status = allowed ? 'WITHIN_ALLOWANCE' : 'OVER_LIMIT';",
    '  return {',
    '    accountId,',
    '    metric,',
    '    policyMode,',
    '    graceBufferUnits,',
    '    proratedFeeCents: proration.proratedFeeCents,',
    '    proratedUnits: proration.proratedUnits,',
    '    usedUnits: usage.usedUnits,',
    '    dedupedEventCount: usage.dedupedEventCount,',
    '    overageUnits,',
    '    overageFeeCents,',
    '    totalChargeCents: proration.proratedFeeCents + overageFeeCents,',
    '    allowed,',
    '    status',
    '  };',
    '}',
    '',
    padLines('entitlementGate', 88)
  ].join('\n');

  files['src/services/webhookDispatcher.mjs'] = [
    'export function buildWebhookEnvelope(eventType, payload = {}, timestampMs = 0) {',
    '  return {',
    '    eventType: String(eventType || \'invoice.updated\'),',
    '    timestampMs: Number(timestampMs || 0),',
    '    payload',
    '  };',
    '}',
    '',
    padLines('webhookDispatch', 95)
  ].join('\n');

  files['src/services/auditTrailService.mjs'] = [
    'export function createAuditEntry(actor, action, targetId, atMs = 0) {',
    "  return { actor: String(actor || 'system'), action: String(action || 'noop'), targetId: String(targetId || ''), atMs: Number(atMs || 0) };",
    '}',
    '',
    padLines('auditTrail', 95)
  ].join('\n');

  files['src/services/subscriptionLifecycle.mjs'] = [
    'export function canTransitionSubscription(fromState, toState) {',
    '  const allowed = {',
    "    TRIAL: ['ACTIVE', 'CANCELED'],",
    "    ACTIVE: ['PAST_DUE', 'CANCELED'],",
    "    PAST_DUE: ['ACTIVE', 'CANCELED'],",
    '    CANCELED: []',
    '  };',
    '  return (allowed[fromState] || []).includes(toState);',
    '}',
    '',
    padLines('subLifecycle', 95)
  ].join('\n');

  // ---- RUNBOOKS (6 files) ----
  files['docs/runbooks/TAX_AND_FX_RUNBOOK.md'] = [
    '# Cross-Border Tax, Discount Stacking & FX Triangulation Runbook',
    '',
    '## 1. Coupon & Discount Stacking Policy (`applyStackedDiscounts`)',
    '- Reject negative or non-finite `grossCents` with `LedgerError(ERROR_CODES.ERR_INVALID_AMOUNT)`.',
    '- **Canonical Order:** Apply all `PERCENT` discounts first in list order (each reducing the running subtotal via half-away-from-zero rounding on `(running * value) / 100`), THEN apply `FIXED_CENTS` coupons.',
    '- **Floor:** Never let `discountedCents` drop below `0` (`Math.max(0, running)`). `totalDiscountCents = grossCents - discountedCents`.',
    '',
    '## 2. FX Conversion Policy (`convertCurrencyCents`)',
    '- Same-currency conversion (`fromCurrency === toCurrency`) MUST bypass triangulation and return `Math.trunc(amountCents)` with `effectiveRate: 1`.',
    '- Missing or `<= 0` rates in `usdRates` MUST throw `LedgerError(ERROR_CODES.ERR_INVALID_CONFIG)`.',
    '- Cross-currency conversion triangulates via USD in floating/exact arithmetic `(amountCents * fromRate) / toRate` and rounds **once** at the end using half-away-from-zero.',
    '',
    '## 3. B2B Reverse Charge & Tax Calculation (`computeCrossBorderInvoice`)',
    '- Tax ALWAYS applies to `convertedSubtotalCents` (post-discount, post-FX), NEVER unconverted `grossCents`.',
    '- When `taxExemptReverseCharge === true`, `vatId` is a non-empty trimmed string, and `customerCountry` is non-US (`String(customerCountry).toUpperCase() !== "US"`): set `taxCents = 0`, `reverseChargeApplied = true`.',
    '- Emit `wireDigest` via `encodeFrozenWireDigest({ invoiceId, accountId, currency: billingCurrency, totalDueCents, status: INVOICE_STATUS.FINALIZED })`.',
    padRunbookSections('Tax and FX', 'TFX', 80)
  ].join('\n');

  files['docs/runbooks/SETTLEMENT_RECONCILIATION_RUNBOOK.md'] = [
    '# Settlement Reconciliation & Credit Memo Runbook',
    '',
    '## 1. Credit Memo Normalization (`normalizeCreditMemos`)',
    '- **Inclusive Expiry:** A memo with `expiresAtMs !== null && expiresAtMs !== undefined && asOfMs >= expiresAtMs` is expired and MUST be omitted.',
    '- **Adjustment Signs:** `REFUND` and `CREDIT_NOTE` reduce expected net collectibles (`-Math.abs(amountCents)`). `DEBIT_MEMO` increases expected net collectibles (`+Math.abs(amountCents)`).',
    '',
    '## 2. Canonical Ledger Snapshot Ordering (`buildCanonicalLedgerRows`)',
    '- Never mutate the caller array.',
    '- Sort canonically by numeric `postedAtMs ASC`, tie-break `invoiceId ASC`, then `entryId ASC`.',
    '',
    '## 3. Reconciliation & Dispute Holdbacks (`reconcileSettlementBatch`)',
    '- Normalize non-USD ledger rows, credit memos, and payouts to USD cents via `convertCurrencyCents`.',
    '- Any `invoiceId` in `disputedInvoiceIds` gets status `DISPUTE_HOLD`, adds `expectedUsdCents` to `heldBackUsdCents`, and MUST NOT appear in `discrepancies` or `expectedNetUsdCents` mismatch checks.',
    '- Non-disputed invoices with `Math.abs(payoutUsdCents - expectedUsdCents) <= toleranceCents` (default `1` cent) get status `MATCHED`; larger variances get status `DRIFT` and push to `discrepancies`.',
    padRunbookSections('Settlement Reconciliation', 'REC', 80)
  ].join('\n');

  files['docs/runbooks/ENTITLEMENT_OVERAGE_RUNBOOK.md'] = [
    '# Mid-Cycle Proration, Metering & SOFT_GRACE Entitlement Runbook',
    '',
    '## 1. Exact Period Proration (`computeProratedAllowanceAndFee`)',
    '- Compute overlap within `[periodStartMs, periodEndMs)` using `[Math.max(planStartMs, periodStartMs), Math.min(planEndMs, periodEndMs))`.',
    '- Ratio MUST divide by actual `(periodEndMs - periodStartMs)` duration (supports 28/29/30/31-day months). Never hardcode `30` days or round intermediate daily rates.',
    '- Apply one final half-away-from-zero round to `(fee * activeMs) / totalPeriodMs` and `(includedUnits * activeMs) / totalPeriodMs`.',
    '',
    '## 2. Usage Meter Boundaries & Idempotent Dedupe (`aggregateMeteredUsage`)',
    '- Billing window is half-open `[periodStartMs, periodEndMs)`: `periodStartMs` is INCLUSIVE (`>=`), `periodEndMs` is EXCLUSIVE (`<`).',
    '- Reject negative/non-finite event `units` with `LedgerError(ERROR_CODES.ERR_NEGATIVE_UNITS)`.',
    '- Deduplicate retried usage events sharing the same non-empty `eventId` (count only first occurrence).',
    '',
    '## 3. Entitlement & Grace Buffer (`evaluateSubscriptionEntitlement`)',
    '- `effectiveAllowance = policyMode === "SOFT_GRACE" ? proratedUnits + Math.max(0, Math.trunc(graceBufferUnits)) : proratedUnits`.',
    '- Always expose `effectiveAllowance` in the return object.',
    '- `allowed = usedUnits <= effectiveAllowance`.',
    '- `status`: `"WITHIN_ALLOWANCE"` when `usedUnits <= proratedUnits`; `"GRACE_ALLOWED"` when `policyMode === "SOFT_GRACE" && usedUnits <= effectiveAllowance`; otherwise `"OVER_LIMIT"`.',
    '- `overageUnits = Math.max(0, usedUnits - effectiveAllowance)` and `overageFeeCents = overageUnits * overageUnitRateCents`.',
    padRunbookSections('Entitlement & Overage', 'ENT', 80)
  ].join('\n');

  files['docs/runbooks/WEBHOOK_OPS_RUNBOOK.md'] = [
    '# Webhook Delivery & Replay Operations Runbook',
    '- Retry schedule follows exponential jitter capped at 24h.',
    '- Dead-letter queues preserve original idempotency keys and signature timestamps.',
    padRunbookSections('Webhook Ops', 'WHK', 85)
  ].join('\n');

  files['docs/runbooks/MIGRATION_RUNBOOK.md'] = [
    '# Schema & Wire Digest Migration Runbook',
    '- `LP-WIRE-V1` digest format in `src/frozenWire.mjs` is frozen across all minor releases.',
    '- Always run dual-read verification before retiring legacy adapter projections.',
    padRunbookSections('Migration Ops', 'MIG', 85)
  ].join('\n');

  files['docs/runbooks/INCIDENT_TRIAGE_RUNBOOK.md'] = [
    '# Billing Incident Triage & Escalation Runbook',
    '- First verify tax, FX, and settlement discrepancy counts against canonical runbooks before issuing credit memos.',
    '- Confirm proration window bounds and idempotent usage ingestion logs for tenant overage tickets.',
    padRunbookSections('Incident Triage', 'INC', 85)
  ].join('\n');

  return files;
}

export function applyExplorationOverlay(repoDir, task = null) {
  void task;
  const files = buildOverlayFiles();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content + '\n', 'utf8');
  }
  return Object.keys(files).sort();
}
