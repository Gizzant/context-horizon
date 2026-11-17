import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageCursor } from '../src/usageCursor.mjs';
import { PartitionedBatchCoordinator } from '../src/batchIngestor.mjs';

test('H03 visible: UsageCursor contiguous watermark and PartitionedBatchCoordinator basic partition FIFO', async () => {
  const cursor = new UsageCursor();
  assert.deepEqual(cursor.markCommitted([2, 3]), { highestCommittedSeq: 3, contiguousWatermarkSeq: 0 });
  assert.deepEqual(cursor.markCommitted([1]), { highestCommittedSeq: 3, contiguousWatermarkSeq: 3 });

  const delivered = [];
  const coord = new PartitionedBatchCoordinator({
    maxBatchSize: 2,
    maxConcurrentFlushes: 2,
    sinkFn: async (batch) => {
      delivered.push(batch.map((e) => `${e.accountId}:${e.seq}`));
    }
  });
  await coord.ingest({ accountId: 'a1', key: 'k1', payloadHash: 'h1', seq: 1, metric: 'm', units: 1, nowMs: 100 });
  await coord.ingest({ accountId: 'a2', key: 'k2', payloadHash: 'h2', seq: 2, metric: 'm', units: 2, nowMs: 100 });
  const summary = await coord.shutdown();
  assert.equal(summary.committedCount, 2);
  assert.equal(summary.watermarks.contiguousWatermarkSeq, 2);
});
