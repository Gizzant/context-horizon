import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyGuard } from '../src/idempotencyGuard.mjs';
import { BatchIngestor, ingestTransactionalBatch } from '../src/batchIngestor.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('S02 visible: ingestTransactionalBatch coalesces intra-batch duplicates and rolls back on conflict', async () => {
  const guard = new IdempotencyGuard({ ttlMs: 10_000, maxEntries: 10 });
  const delivered = [];
  const ingestor = new BatchIngestor({
    maxBatchSize: 10,
    sinkFn: async (batch) => delivered.push(...batch)
  });

  await ingestTransactionalBatch(guard, ingestor, [
    { key: 'k1', payloadHash: 'h1', seq: 1, metric: 'm', units: 5 },
    { key: 'k1', payloadHash: 'h1', seq: 2, metric: 'm', units: 5 }
  ], 1000);
  await ingestor.flush();
  assert.equal(delivered.length, 1);

  await assert.rejects(
    () => ingestTransactionalBatch(guard, ingestor, [
      { key: 'k2', payloadHash: 'h2', seq: 3, metric: 'm', units: 7 },
      { key: 'k1', payloadHash: 'CONFLICT', seq: 4, metric: 'm', units: 9 }
    ], 2000),
    (err) => err.code === ERROR_CODES.ERR_IDEMPOTENCY_CONFLICT
  );
  assert.equal(guard.size, 1);
  assert.equal(ingestor.pendingCount, 0);
});
