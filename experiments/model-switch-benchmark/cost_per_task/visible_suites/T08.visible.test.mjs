import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter } from '../src/queryDsl.mjs';
import { BatchIngestor } from '../src/batchIngestor.mjs';

test('T08 visible: escaped trailing backslash and AND-over-OR precedence', () => {
  const pathPred = compileFilter('path == "C:\\\\temp\\\\"');
  assert.equal(pathPred({ path: 'C:\\temp\\' }), true);
  assert.equal(pathPred({ path: 'C:\\other\\' }), false);

  // AND binds tighter than OR: a == 1 OR (b == 2 AND c == 3)
  const precPred = compileFilter('a == 1 OR b == 2 AND c == 3');
  assert.equal(precPred({ a: 1, b: 0, c: 0 }), true);
  assert.equal(precPred({ a: 0, b: 2, c: 0 }), false);
});

test('T08 visible: BatchIngestor preserves events when sink rejects', async () => {
  let failOnce = true;
  const delivered = [];
  const ingestor = new BatchIngestor({
    maxBatchSize: 10,
    sinkFn: async (batch) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient sink error');
      }
      delivered.push(...batch);
    }
  });
  await ingestor.ingest({ seq: 1, metric: 'm', units: 5 });
  await ingestor.ingest({ seq: 2, metric: 'm', units: 6 });

  await assert.rejects(() => ingestor.flush(), /transient sink error/);
  assert.equal(ingestor.pendingCount, 2);
  assert.equal(ingestor.committedWatermarkSeq, 0);

  await ingestor.flush();
  assert.equal(ingestor.pendingCount, 0);
  assert.equal(ingestor.committedWatermarkSeq, 2);
  assert.deepEqual(delivered.map((x) => x.seq), [1, 2]);
});
