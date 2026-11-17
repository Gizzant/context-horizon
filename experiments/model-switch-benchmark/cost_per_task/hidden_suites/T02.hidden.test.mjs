import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IdempotencyGuard } from './src/idempotencyGuard.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_ERRORS = 'ffdcf392b978388c8fec1e3f9561e39270f5a12a1218704b8ded5ca488df4a42';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T02 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T02 hidden: conflict at expiresAtMs - 1 vs fresh accept at expiresAtMs', () => {
  const guard = new IdempotencyGuard({ ttlMs: 1000, maxEntries: 5 });
  guard.checkAndRecord('k1', 'hash1', 500);
  assert.throws(
    () => guard.checkAndRecord('k1', 'hash2', 1499),
    (err) => err.code === ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT
  );
  const re = guard.checkAndRecord('k1', 'hash2', 1500);
  assert.equal(re.status, 'accepted');
  assert.equal(re.expiresAtMs, 2500);
});

test('T02 hidden: FIFO eviction ignores duplicate refreshes and prunes expired before evicting active', () => {
  const guard = new IdempotencyGuard({ ttlMs: 1000, maxEntries: 2 });
  guard.checkAndRecord('a', 'ha', 100);
  guard.checkAndRecord('b', 'hb', 200);
  // Duplicate check on 'a' must NOT make 'a' newer than 'b'
  assert.equal(guard.checkAndRecord('a', 'ha', 300).status, 'duplicate');
  // Inserting 'c' at 400 (both active) evicts 'a' (oldest inserted)
  guard.checkAndRecord('c', 'hc', 400);
  assert.equal(guard.size, 2);
  // 'a' was evicted so registering 'a' with new hash succeeds without conflict
  assert.equal(guard.checkAndRecord('a', 'ha-new', 450).status, 'accepted');
  // At 1250, 'b' (exp 1200) expired while 'c' (exp 1400) and 'a' (exp 1450) are active;
  // inserting 'd' prunes expired entries cleanly
  guard.checkAndRecord('d', 'hd', 1401);
  assert.equal(guard.size, 2);
  assert.equal(guard.checkAndRecord('a', 'ha-new', 1420).status, 'duplicate');
});

test('T02 hidden: constructor and argument validation', () => {
  assert.throws(() => new IdempotencyGuard({ ttlMs: -1 }), (e) => e.code === ERROR_CODES.ERR_INVALID_TTL);
  assert.throws(() => new IdempotencyGuard({ ttlMs: 1000, maxEntries: 0 }), (e) => e.code === ERROR_CODES.ERR_INVALID_CONFIG);
  const g = new IdempotencyGuard({ ttlMs: 1000, maxEntries: 2 });
  assert.throws(() => g.checkAndRecord('k', '', 100), (e) => e.code === ERROR_CODES.ERR_INVALID_EVENT);
});

test('[CONSTRAINT-1] errors.mjs and frozenWire.mjs remain unmodified', () => {
  assert.equal(shaLf('src/errors.mjs'), SHA_ERRORS);
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
});

test('[CONSTRAINT-2] no new files added under src/', () => {
  const srcFiles = fs.readdirSync(path.join(REPO_DIR, 'src')).sort();
  assert.deepEqual(srcFiles, [
    'batchIngestor.mjs',
    'clock.mjs',
    'constants.mjs',
    'creditPool.mjs',
    'errors.mjs',
    'frozenWire.mjs',
    'idempotencyGuard.mjs',
    'invoiceBuilder.mjs',
    'queryDsl.mjs',
    'tierEngine.mjs'
  ]);
});
