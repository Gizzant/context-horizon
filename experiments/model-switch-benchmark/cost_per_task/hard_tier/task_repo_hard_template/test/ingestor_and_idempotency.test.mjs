import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyGuard } from '../src/idempotencyGuard.mjs';
import { BatchIngestor } from '../src/batchIngestor.mjs';
import { UsageCursor } from '../src/usageCursor.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('IdempotencyGuard accepts fresh, flags active duplicate, rejects conflict', () => {
  const guard = new IdempotencyGuard({ ttlMs: 10_000, maxEntries: 100 });
  const r1 = guard.checkAndRecord('evt-1', 'hash-a', 1000);
  assert.equal(r1.status, 'accepted');

  const r2 = guard.checkAndRecord('evt-1', 'hash-a', 2000);
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.originalRecordedAtMs, 1000);

  assert.throws(
    () => guard.checkAndRecord('evt-1', 'hash-b', 2500),
    (err) => err.code === ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT
  );
});

test('BatchIngestor sequential ingest and flush', async () => {
  const flushed = [];
  const ingestor = new BatchIngestor({
    maxBatchSize: 2,
    sinkFn: async (batch) => {
      flushed.push(batch);
    }
  });
  await ingestor.ingest({ seq: 1, metric: 'tokens', units: 10 });
  assert.equal(ingestor.pendingCount, 1);
  await ingestor.ingest({ seq: 2, metric: 'tokens', units: 20 });
  assert.equal(ingestor.pendingCount, 0);
  assert.equal(ingestor.committedWatermarkSeq, 2);
  assert.equal(ingestor.totalCommitted, 2);
  assert.equal(flushed.length, 1);
});

test('UsageCursor tracks in-order monotonic commits', () => {
  const cursor = new UsageCursor();
  const wm = cursor.markCommitted([1, 2, 3]);
  assert.equal(wm.highestCommittedSeq, 3);
  assert.equal(wm.contiguousWatermarkSeq, 3);
});
