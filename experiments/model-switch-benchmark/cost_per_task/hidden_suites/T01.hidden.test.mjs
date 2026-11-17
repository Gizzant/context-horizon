import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeGraduatedCharge, computeVolumeCharge } from './src/tierEngine.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T01 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T01 hidden: unsorted tiers do not mutate input and sort properly', () => {
  const tiers = [
    { upTo: null, unitRateCents: 2 },
    { upTo: 300, unitRateCents: 5 },
    { upTo: 100, unitRateCents: 10 }
  ];
  const before = JSON.stringify(tiers);
  const res = computeGraduatedCharge(350, tiers);
  assert.equal(res.totalCents, 100 * 10 + 200 * 5 + 50 * 2);
  assert.deepEqual(res.breakdown.map((b) => b.units), [100, 200, 50]);
  assert.equal(JSON.stringify(tiers), before);
});

test('T01 hidden: fractional rates round half-away-from-zero per band', () => {
  const tiers = [
    { upTo: 3, unitRateCents: 2.5 }, // 3 * 2.5 = 7.5 -> 8
    { upTo: null, unitRateCents: 1.5 } // 1 * 1.5 = 1.5 -> 2
  ];
  const res = computeGraduatedCharge(4, tiers);
  assert.equal(res.breakdown[0].subtotalCents, 8);
  assert.equal(res.breakdown[1].subtotalCents, 2);
  assert.equal(res.totalCents, 10);
});

test('T01 hidden: invalid tier schedules and invalid units throw typed LedgerError', () => {
  assert.throws(
    () => computeGraduatedCharge(10, [
      { upTo: 100, unitRateCents: 5 },
      { upTo: 100, unitRateCents: 3 }
    ]),
    (err) => err.code === ERROR_CODES.ERR_INVALID_TIERS
  );
  assert.throws(
    () => computeGraduatedCharge(10, [
      { upTo: null, unitRateCents: 5 },
      { upTo: Infinity, unitRateCents: 2 }
    ]),
    (err) => err.code === ERROR_CODES.ERR_INVALID_TIERS
  );
  assert.throws(
    () => computeGraduatedCharge(Number.NaN, [{ upTo: 100, unitRateCents: 5 }]),
    (err) => err.code === ERROR_CODES.ERR_NEGATIVE_UNITS
  );
  assert.equal(computeVolumeCharge(150, [{ upTo: 100, unitRateCents: 10 }, { upTo: null, unitRateCents: 6 }]).totalCents, 900);
});

test('[CONSTRAINT-1] zero dependencies added in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
  assert.equal(fs.existsSync(path.join(REPO_DIR, 'node_modules')), false);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
