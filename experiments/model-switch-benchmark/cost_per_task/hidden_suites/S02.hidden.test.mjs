import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IdempotencyGuard } from './src/idempotencyGuard.mjs';
import { BatchIngestor, ingestTransactionalBatch } from './src/batchIngestor.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_ERRORS = 'ffdcf392b978388c8fec1e3f9561e39270f5a12a1218704b8ded5ca488df4a42';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('S02 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('S02 hidden: intra-batch conflicting hash and invalid event roll back all state atomically', async () => {
  const guard = new IdempotencyGuard({ ttlMs: 10_000, maxEntries: 10 });
  const delivered = [];
  const ingestor = new BatchIngestor({ maxBatchSize: 10, sinkFn: async (b) => delivered.push(...b) });

  await ingestTransactionalBatch(guard, ingestor, [
    { key: 'base', payloadHash: 'hb', seq: 1, metric: 'm', units: 1 }
  ], 100);
  await ingestor.flush();

  await assert.rejects(
    () => ingestTransactionalBatch(guard, ingestor, [
      { key: 'new-1', payloadHash: 'h1', seq: 2, metric: 'm', units: 2 },
      { key: 'new-1', payloadHash: 'h2-conflict', seq: 3, metric: 'm', units: 3 }
    ], 200),
    (err) => err.code === ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT
  );
  assert.equal(guard.size, 1);
  assert.equal(ingestor.pendingCount, 0);

  await assert.rejects(
    () => ingestTransactionalBatch(guard, ingestor, [
      { key: 'new-2', payloadHash: 'h2', seq: 2, metric: 'm', units: 2 },
      { key: 'bad', payloadHash: 'hbad', seq: 'not-int', metric: 'm', units: 1 }
    ], 300),
    (err) => err.code === ERROR_CODES.ERR_INVALID_EVENT
  );
  assert.equal(guard.size, 1);
  assert.equal(ingestor.pendingCount, 0);
});

test('[CONSTRAINT-1] zero dependencies added in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs and errors.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/errors.mjs'), SHA_ERRORS);
});
