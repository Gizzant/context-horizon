import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyCredits, summarizePoolBalance } from './src/creditPool.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T03 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T03 hidden: boundary inclusivity, grantId tie-breaking, and original order in updatedGrants', () => {
  const grants = [
    { grantId: 'g-b', remainingCents: 200, effectiveFromMs: 1000, expiresAtMs: 5000 },
    { grantId: 'g-exp-exact', remainingCents: 900, effectiveFromMs: 0, expiresAtMs: 1000 },
    { grantId: 'g-a', remainingCents: 150, effectiveFromMs: 1000, expiresAtMs: 5000 },
    { grantId: 'g-future', remainingCents: 900, effectiveFromMs: 1001, expiresAtMs: 9000 }
  ];
  const frozenBefore = JSON.stringify(grants);
  const res = applyCredits(250, grants, 1000);
  assert.equal(res.appliedCents, 250);
  assert.equal(res.remainingChargeCents, 0);
  assert.deepEqual(res.allocations, [
    { grantId: 'g-a', appliedCents: 150 },
    { grantId: 'g-b', appliedCents: 100 }
  ]);
  assert.equal(JSON.stringify(grants), frozenBefore);
  assert.deepEqual(res.updatedGrants.map((g) => [g.grantId, g.remainingCents]), [
    ['g-b', 100],
    ['g-exp-exact', 900],
    ['g-a', 0],
    ['g-future', 900]
  ]);
});

test('T03 hidden: zero charge, negative charge error, and summarizePoolBalance filtering', () => {
  const grants = [
    { grantId: 'g1', remainingCents: 100, effectiveFromMs: 0, expiresAtMs: 500 },
    { grantId: 'g2', remainingCents: 300, effectiveFromMs: 400, expiresAtMs: 1000 },
    { grantId: 'g3', remainingCents: 200, effectiveFromMs: 600, expiresAtMs: 1000 }
  ];
  const z = applyCredits(0, grants, 500);
  assert.equal(z.appliedCents, 0);
  assert.equal(z.remainingChargeCents, 0);
  assert.deepEqual(z.allocations, []);

  assert.throws(
    () => applyCredits(-1, grants, 500),
    (err) => err.code === ERROR_CODES.ERR_INVALID_AMOUNT
  );

  const summary = summarizePoolBalance(grants, 500);
  assert.equal(summary.availableCents, 300);
  assert.equal(summary.activeCount, 1);
});

test('[CONSTRAINT-1] no .toFixed() in creditPool.mjs', () => {
  const src = fs.readFileSync(path.join(REPO_DIR, 'src/creditPool.mjs'), 'utf8');
  assert.equal(/\.toFixed\s*\(/.test(src), false);
});

test('[CONSTRAINT-2] frozenWire.mjs remains unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
});
