import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFilter } from './src/queryDsl.mjs';
import { BatchIngestor } from './src/batchIngestor.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_ERRORS = 'ffdcf392b978388c8fec1e3f9561e39270f5a12a1218704b8ded5ca488df4a42';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T08 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T08 hidden: backslash + quote unescaping and syntax errors', () => {
  const pred = compileFilter('msg == "say \\"hi\\\\\\"" AND tag == "a\\\\b"');
  assert.equal(pred({ msg: 'say "hi\\"', tag: 'a\\b' }), true);
  assert.equal(pred({ msg: 'say "hi\\"', tag: 'ab' }), false);
  assert.throws(() => compileFilter('msg == "unterminated\\"'), (e) => e.code === ERROR_CODES.ERR_DSL_SYNTAX);
});

test('T08 hidden: NOT > AND > OR precedence and null/missing comparison safety', () => {
  const p1 = compileFilter('NOT a == 1 OR b == 2 AND c == 3');
  assert.equal(p1({ a: 2, b: 0, c: 0 }), true);
  assert.equal(p1({ a: 1, b: 2, c: 0 }), false);
  assert.equal(p1({ a: 1, b: 2, c: 3 }), true);

  const pNull = compileFilter('missing == null AND extra != "x"');
  assert.equal(pNull({}), true);
  assert.equal(pNull({ missing: null, extra: 'y' }), true);
  assert.equal(pNull({ missing: 'ok', extra: 'y' }), false);

  // JS null >= 0 is true natively! Must be false in DSL!
  const pRel = compileFilter('units >= 0 OR units <= 0 OR units < 5 OR units > -5');
  assert.equal(pRel({}), false);
  assert.equal(pRel({ units: null }), false);
  assert.equal(pRel({ units: 0 }), true);
});

test('T08 hidden: BatchIngestor concurrent ingest+flush mutex and failure restoration ahead of new arrivals', async () => {
  let activeSinks = 0;
  let maxConcurrentSinks = 0;
  let failCall = true;
  const delivered = [];

  const ingestor = new BatchIngestor({
    maxBatchSize: 2,
    sinkFn: async (batch) => {
      activeSinks += 1;
      maxConcurrentSinks = Math.max(maxConcurrentSinks, activeSinks);
      await new Promise((r) => setTimeout(r, 15));
      try {
        if (failCall) {
          failCall = false;
          throw new Error('sink down');
        }
        delivered.push(...batch.map((b) => b.seq));
      } finally {
        activeSinks -= 1;
      }
    }
  });

  // Trigger batch 1 flush (seq 1, 2) which fails, while seq 3 arrives mid-flight!
  const p1 = ingestor.ingest({ seq: 1, metric: 'm', units: 1 });
  const p2 = ingestor.ingest({ seq: 2, metric: 'm', units: 2 });
  await new Promise((r) => setTimeout(r, 3));
  const p3 = ingestor.ingest({ seq: 3, metric: 'm', units: 3 });

  const results = await Promise.allSettled([p1, p2, p3]);
  assert.equal(results.some((r) => r.status === 'rejected'), true);
  assert.equal(ingestor.committedWatermarkSeq, 0);

  // Now ingest seq 4, 5, 6 concurrently alongside flush()
  await Promise.all([
    ingestor.ingest({ seq: 4, metric: 'm', units: 4 }),
    ingestor.ingest({ seq: 5, metric: 'm', units: 5 }),
    ingestor.flush(),
    ingestor.ingest({ seq: 6, metric: 'm', units: 6 })
  ]);
  await ingestor.flush();

  assert.equal(maxConcurrentSinks, 1, 'sinkFn must never execute concurrently');
  assert.deepEqual(delivered, [1, 2, 3, 4, 5, 6]);
  assert.equal(ingestor.committedWatermarkSeq, 6);
  assert.equal(ingestor.totalCommitted, 6);
  assert.equal(ingestor.pendingCount, 0);
});

test('[CONSTRAINT-1] zero eval or Function constructor in src/', () => {
  for (const fname of fs.readdirSync(path.join(REPO_DIR, 'src'))) {
    if (!fname.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(REPO_DIR, 'src', fname), 'utf8');
    assert.equal(/\beval\s*\(/.test(text), false);
    assert.equal(/\bnew\s+Function\b/.test(text), false);
  }
});

test('[CONSTRAINT-2] frozenWire.mjs and errors.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/errors.mjs'), SHA_ERRORS);
});
