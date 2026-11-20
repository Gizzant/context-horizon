import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeCreditMemos } from './src/adapters/creditMemoAdapter.mjs';
import { buildCanonicalLedgerRows } from './src/adapters/ledgerSnapshotAdapter.mjs';
import { reconcileSettlementBatch } from './src/services/settlementReconciler.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_ERRORS = 'ffdcf392b978388c8fec1e3f9561e39270f5a12a1218704b8ded5ca488df4a42';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T10 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(
    process.execPath,
    ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))],
    { cwd: REPO_DIR, encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T10 hidden: canonical ledger rows sort numerically (90 < 1000) with invoiceId/entryId tie-break', () => {
  const rows = buildCanonicalLedgerRows([
    { entryId: 'E3', invoiceId: 'INV-B', postedAtMs: 1000 },
    { entryId: 'E2', invoiceId: 'INV-A', postedAtMs: 1000 },
    { entryId: 'E1', invoiceId: 'INV-A', postedAtMs: 90 },
    { entryId: 'E0', invoiceId: 'INV-A', postedAtMs: 1000 }
  ]);
  assert.deepEqual(
    rows.map((r) => r.entryId),
    ['E1', 'E0', 'E2', 'E3']
  );
});

test('T10 hidden: DEBIT_MEMO adds positive delta while REFUND subtracts, and DRIFT > tolerance fails', () => {
  const memos = normalizeCreditMemos(
    [
      { memoId: 'D1', invoiceId: 'I1', kind: 'DEBIT_MEMO', amountCents: 300 },
      { memoId: 'R1', invoiceId: 'I1', kind: 'REFUND', amountCents: 1000 },
      { memoId: 'C_EXP', invoiceId: 'I1', kind: 'CREDIT_NOTE', amountCents: 500, expiresAtMs: 100 }
    ],
    150
  );
  assert.equal(memos.length, 2);
  assert.equal(memos.find((m) => m.memoId === 'D1').signedDeltaCents, 300);
  assert.equal(memos.find((m) => m.memoId === 'R1').signedDeltaCents, -1000);

  const driftRes = reconcileSettlementBatch({
    ledgerEntries: [
      { entryId: 'L1', invoiceId: 'I1', amountCents: 10_000, currency: 'EUR', postedAtMs: 50 },
      { entryId: 'L2', invoiceId: 'I2', amountCents: 5000, currency: 'USD', postedAtMs: 60 }
    ],
    creditMemos: [{ memoId: 'R1', invoiceId: 'I1', kind: 'REFUND', amountCents: 1000, currency: 'USD' }],
    // I1 expected USD: 10000*1.1 = 11000 - 1000 = 10000 USD; payout 9998 (-2c -> DRIFT)
    payoutRecords: [
      { invoiceId: 'I1', amountCents: 9998, currency: 'USD' },
      { invoiceId: 'I2', amountCents: 5001, currency: 'USD' } // +1c within tolerance
    ],
    usdRates: { USD: 1, EUR: 1.1, GBP: 1.25 },
    asOfMs: 100,
    toleranceCents: 1
  });
  assert.equal(driftRes.reconciled, false);
  assert.equal(driftRes.invoiceStatuses.I1, 'DRIFT');
  assert.equal(driftRes.invoiceStatuses.I2, 'MATCHED');
  assert.equal(driftRes.discrepancies.length, 1);
  assert.equal(driftRes.discrepancies[0].varianceUsdCents, -2);
});

test('[CONSTRAINT-1] zero dependencies added in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
  assert.equal(fs.existsSync(path.join(REPO_DIR, 'node_modules')), false);
});

test('[CONSTRAINT-2] frozenWire.mjs and errors.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/errors.mjs'), SHA_ERRORS);
});
