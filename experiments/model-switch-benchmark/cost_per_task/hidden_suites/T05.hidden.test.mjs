import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFilter } from './src/queryDsl.mjs';
import { buildInvoice } from './src/invoiceBuilder.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('T05 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('T05 hidden: NOT IN, precedence with OR/AND, and syntax error on empty/malformed IN', () => {
  const pred = compileFilter('tier == "vip" OR NOT env IN ("dev", "staging") AND units >= 10');
  assert.equal(pred({ tier: 'vip', env: 'dev', units: 1 }), true);
  assert.equal(pred({ tier: 'std', env: 'prod', units: 15 }), true);
  assert.equal(pred({ tier: 'std', env: 'dev', units: 15 }), false);

  const numIn = compileFilter('code IN (200, 201, null)');
  assert.equal(numIn({ code: 201 }), true);
  assert.equal(numIn({ code: null }), true);
  assert.equal(numIn({ code: 500 }), false);

  assert.throws(() => compileFilter('env IN ()'), (e) => e.code === ERROR_CODES.ERR_DSL_SYNTAX);
  assert.throws(() => compileFilter('env IN ("a",)'), (e) => e.code === ERROR_CODES.ERR_DSL_SYNTAX);
});

test('T05 hidden: untagged sorts LAST after zebra, and pooled multi-tier units price cleanly', () => {
  const metricTiers = {
    b_compute: [{ upTo: 100, unitRateCents: 10 }, { upTo: null, unitRateCents: 5 }],
    a_api: [{ upTo: 100, unitRateCents: 10 }, { upTo: null, unitRateCents: 5 }]
  };
  const inv = buildInvoice({
    invoiceId: 'inv-t05-h1',
    accountId: 'acct-h',
    events: [
      { metric: 'b_compute', units: 80, tags: { team: 'zebra', env: 'prod' } },
      { metric: 'b_compute', units: 70, tags: { team: 'zebra', env: 'prod' } }, // 150 total -> 1250c
      { metric: 'b_compute', units: 10, tags: { env: 'prod' } }, // missing team -> 'untagged' LAST!
      { metric: 'b_compute', units: 20, tags: { team: 'alpha', env: 'prod' } },
      { metric: 'a_api', units: 5, tags: { env: 'dev' } }, // excluded by filter
      { metric: 'a_api', units: 15, tags: { team: 'ops', env: 'prod' } }
    ],
    metricTiers,
    filterExpr: 'tags.env IN ("prod")',
    groupByTag: 'team'
  });

  assert.equal(inv.excludedEventCount, 1);
  assert.deepEqual(
    inv.lineItems.map((l) => [l.metric, l.groupValue, l.units, l.amountCents]),
    [
      ['a_api', 'ops', 15, 150],
      ['b_compute', 'alpha', 20, 200],
      ['b_compute', 'zebra', 150, 1250],
      ['b_compute', 'untagged', 10, 100]
    ]
  );
  assert.equal(inv.usageSubtotalCents, 1700);
});

test('[CONSTRAINT-1] zero eval or Function constructor in src/', () => {
  for (const fname of fs.readdirSync(path.join(REPO_DIR, 'src'))) {
    if (!fname.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(REPO_DIR, 'src', fname), 'utf8');
    assert.equal(/\beval\s*\(/.test(text), false, `eval found in ${fname}`);
    assert.equal(/\bnew\s+Function\b/.test(text), false, `new Function found in ${fname}`);
  }
});

test('[CONSTRAINT-2] frozenWire.mjs remains unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
});
