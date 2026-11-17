import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IdempotencyGuard } from './src/idempotencyGuard.mjs';
import { createSettlementRegistry, executeSettlementSaga } from './src/invoiceBuilder.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('H05 hidden: baseline and visible suite pass', () => {
  const files = fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x));
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('H05 hidden: concurrent IN_FLIGHT conflict, 100% credit-covered skip gateway, and capture rollback', async () => {
  const reg = createSettlementRegistry([{ grantId: 'g1', remainingCents: 600, effectiveFromMs: 0, expiresAtMs: 50_000 }]);
  const guard = new IdempotencyGuard({ ttlMs: 10_000, maxEntries: 10 });
  const calls = [];
  const gateway = {
    authorize: async () => { calls.push('auth'); return { authId: 'a1' }; },
    capture: async () => { calls.push('cap'); throw new Error('capture failed'); },
    release: async (arg) => { calls.push(`release:${arg.authId || arg}`); },
    refund: async () => { calls.push('refund'); }
  };
  const ledgerStore = {
    append: async () => {
      calls.push('append');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  // 100% credit-covered skips gateway completely; second concurrent call hits ERR_IDEMPOTENCY_IN_FLIGHT!
  const reqFull = {
    idempotencyKey: 'k-full',
    invoiceId: 'inv-full',
    accountId: 'a',
    usageRows: [{ metric: 'm', units: 50, tiers: [{ upTo: null, unitRateCents: 10 }] }], // 500 <= 600
    asOfMs: 100
  };
  const p1 = executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, reqFull);
  const p2 = executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, reqFull);
  const [res1, res2] = await Promise.allSettled([p1, p2]);
  assert.equal(res1.status, 'fulfilled');
  assert.equal(res2.status, 'rejected');
  assert.equal(res2.reason.code, ERROR_CODES.ERR_IDEMPOTENCY_IN_FLIGHT);
  assert.deepEqual(calls, ['append']);
  assert.equal(reg.grants[0].remainingCents, 100);

  // Capture failure releases auth + restores credits + frees key for retry
  const reqFailCap = {
    idempotencyKey: 'k-cap',
    invoiceId: 'inv-cap',
    accountId: 'a',
    usageRows: [{ metric: 'm', units: 30, tiers: [{ upTo: null, unitRateCents: 10 }] }], // 300 - 100 = 200 due
    asOfMs: 200
  };
  await assert.rejects(
    () => executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, reqFailCap),
    (err) => err.message === 'capture failed' && Array.isArray(err.compensationSteps) && err.compensationSteps[0] === 'release_auth'
  );
  assert.equal(reg.grants[0].remainingCents, 100);
});

test('H05 hidden: ledger failure with refund success vs refund failure (COMPENSATION_FAILED blocks double spend)', async () => {
  const reg = createSettlementRegistry([{ grantId: 'g1', remainingCents: 100, effectiveFromMs: 0, expiresAtMs: 50_000 }]);
  const guard = new IdempotencyGuard({ ttlMs: 10_000, maxEntries: 10 });
  const steps = [];
  let failRefund = false;
  const gateway = {
    authorize: async () => { steps.push('auth'); return { authId: 'a9' }; },
    capture: async () => { steps.push('cap'); return { captureId: 'c9' }; },
    release: async () => { steps.push('release'); },
    refund: async () => {
      steps.push('refund');
      if (failRefund) throw new Error('gateway timeout during refund');
    }
  };
  const ledgerStore = { append: async () => { steps.push('append'); throw new Error('db constraint'); } };

  const req = {
    idempotencyKey: 'k-ref',
    invoiceId: 'inv-ref',
    accountId: 'a',
    usageRows: [{ metric: 'm', units: 30, tiers: [{ upTo: null, unitRateCents: 10 }] }],
    asOfMs: 100
  };

  // Ledger fails, refund succeeds -> credits restored, key released
  await assert.rejects(
    () => executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, req),
    (err) => err.message === 'db constraint' && err.compensationSteps[0] === 'refund_capture'
  );
  assert.equal(reg.grants[0].remainingCents, 100);

  // Now refund ALSO fails -> ERR_COMPENSATION_FAILED, credits NOT restored, unreconciledGatewayCents=200, retry blocked!
  failRefund = true;
  await assert.rejects(
    () => executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, req),
    (err) => err.code === ERROR_CODES.ERR_COMPENSATION_FAILED && err.details?.captureId === 'c9'
  );
  assert.equal(reg.grants[0].remainingCents, 0);
  assert.equal(reg.unreconciledGatewayCents, 200);
  await assert.rejects(
    () => executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, req),
    (err) => err.code === ERROR_CODES.ERR_COMPENSATION_FAILED
  );
});

test('[CONSTRAINT-1] zero dependencies in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
