import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageCursor } from './src/usageCursor.mjs';
import { PartitionedBatchCoordinator } from './src/batchIngestor.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('H03 hidden: baseline and visible suite pass', () => {
  const files = fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x));
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('H03 hidden: per-account FIFO serial flush, global concurrency cap, retryable=false DLQ, and contiguous watermark', async () => {
  let active = 0;
  let maxActive = 0;
  const perAcctOrder = { a1: [], a2: [], a3: [] };
  const dlqEvents = [];
  let a2TransientAttempts = 0;

  const coord = new PartitionedBatchCoordinator({
    maxBatchSize: 2,
    maxConcurrentFlushes: 2,
    maxRetries: 2,
    sinkFn: async (batch) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setTimeout(r, 15));
        const acct = batch[0].accountId;
        if (acct === 'a1' && batch.some((e) => e.seq === 1)) {
          const err = new Error('poison payload');
          err.retryable = false;
          throw err;
        }
        if (acct === 'a2' && a2TransientAttempts === 0) {
          a2TransientAttempts += 1;
          throw new Error('transient blip');
        }
        perAcctOrder[acct].push(...batch.map((e) => e.seq));
      } finally {
        active -= 1;
      }
    },
    onDeadLetter: async (batch) => {
      dlqEvents.push(...batch.map((e) => e.seq));
    }
  });

  await Promise.all([
    coord.ingest({ accountId: 'a1', key: 'k1', payloadHash: 'h', seq: 1, metric: 'm', units: 1, nowMs: 10 }),
    coord.ingest({ accountId: 'a1', key: 'k2', payloadHash: 'h', seq: 2, metric: 'm', units: 1, nowMs: 10 }),
    coord.ingest({ accountId: 'a2', key: 'k3', payloadHash: 'h', seq: 3, metric: 'm', units: 1, nowMs: 10 }),
    coord.ingest({ accountId: 'a2', key: 'k4', payloadHash: 'h', seq: 4, metric: 'm', units: 1, nowMs: 10 }),
    coord.ingest({ accountId: 'a3', key: 'k5', payloadHash: 'h', seq: 5, metric: 'm', units: 1, nowMs: 10 }),
    coord.ingest({ accountId: 'a3', key: 'k6', payloadHash: 'h', seq: 6, metric: 'm', units: 1, nowMs: 10 }),
    coord.ingest({ accountId: 'a1', key: 'k7', payloadHash: 'h', seq: 7, metric: 'm', units: 1, nowMs: 10 })
  ]);

  const summary = await coord.shutdown();
  assert.ok(maxActive <= 2 && maxActive >= 1);
  assert.deepEqual(dlqEvents, [1, 2]); // retryable=false moved immediately to DLQ
  assert.deepEqual(perAcctOrder.a2, [3, 4]); // transient retried and succeeded
  assert.deepEqual(perAcctOrder.a3, [5, 6]);
  assert.deepEqual(perAcctOrder.a1, [7]); // later batch on a1 still ran cleanly
  // Poisoned seq 1,2 marked skipped so contiguousWatermarkSeq reaches 7!
  assert.equal(summary.watermarks.contiguousWatermarkSeq, 7);
  assert.equal(summary.watermarks.highestCommittedSeq, 7);
  assert.equal(summary.deadLetterCount, 2);

  await assert.rejects(
    () => coord.ingest({ accountId: 'a1', key: 'k8', payloadHash: 'h', seq: 8, metric: 'm', units: 1, nowMs: 20 }),
    (err) => err.code === ERROR_CODES.ERR_SHUTTING_DOWN
  );
});

test('H03 hidden: AbortSignal aborts drain cleanly while preserving queued/in-flight work', async () => {
  const delivered = [];
  const coord = new PartitionedBatchCoordinator({
    maxBatchSize: 5,
    maxConcurrentFlushes: 1,
    sinkFn: async (batch) => {
      await new Promise((r) => setTimeout(r, 40));
      delivered.push(...batch.map((e) => e.seq));
    }
  });
  await coord.ingest({ accountId: 'a1', key: 'k1', payloadHash: 'h1', seq: 1, metric: 'm', units: 1, nowMs: 10 });
  const ac = new AbortController();
  const drainP = coord.drain({ signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(() => drainP, (err) => err.code === ERROR_CODES.ERR_ABORTED);

  // Subsequent drain completes without losing seq 1!
  await coord.drain();
  assert.deepEqual(delivered, [1]);
});

test('[CONSTRAINT-1] zero dependencies in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
