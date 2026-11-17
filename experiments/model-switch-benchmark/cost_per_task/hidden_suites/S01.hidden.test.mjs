import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInvoice, exportInvoiceCsv } from './src/invoiceBuilder.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('S01 hidden: baseline and visible suite pass', () => {
  const res = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x))], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('S01 hidden: formula prefix sanitization on all trigger chars and unprefixed numeric columns', () => {
  const inv = buildInvoice({
    invoiceId: '@inv',
    accountId: '+acct\nline2',
    currency: 'USD',
    usageRows: [
      { metric: '-cmd', units: 10, tiers: [{ upTo: null, unitRateCents: 3 }] },
      { metric: '\tmetric', units: 5, tiers: [{ upTo: null, unitRateCents: 2 }] }
    ]
  });
  const csv = exportInvoiceCsv(inv);
  assert.ok(csv.includes("'@inv"));
  assert.ok(csv.includes(`"'+acct\nline2"`));
  assert.ok(csv.includes("'-cmd,10,30,40"));
  assert.ok(csv.includes("'\tmetric,5,10,40") || csv.includes(`"'\tmetric",5,10,40`));
});

test('[CONSTRAINT-1] zero dependencies added in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
});

test('[CONSTRAINT-2] frozenWire.mjs remains unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
});
