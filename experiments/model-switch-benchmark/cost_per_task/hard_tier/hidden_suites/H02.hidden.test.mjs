import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFilter } from './src/queryDsl.mjs';
import { computeCanonicalPayloadHash } from './src/idempotencyGuard.mjs';
import { formatBoundedAuditEntry } from './src/invoiceBuilder.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('H02 hidden: baseline and visible suite pass', () => {
  const files = fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x));
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('H02 hidden: unicode escapes, surrogate rejection, IN NFC, and case-insensitive ~=', () => {
  const pred = compileFilter('emoji == "\\u{1F680}" AND tag IN ("caf\\u00e9") AND city ~= "MU\\u0308NCHEN"');
  assert.equal(pred({ emoji: '🚀', tag: 'cafe\u0301', city: 'm\u00fcnchen' }), true);
  assert.equal(pred({ emoji: '🚀', tag: 'cafe', city: 'm\u00fcnchen' }), false);

  // Lone surrogate & out-of-range rejections
  assert.throws(() => compileFilter('a == "\\uD800"'), (e) => e.code === ERROR_CODES.ERR_DSL_SYNTAX);
  assert.throws(() => compileFilter('a == "\\u{110000}"'), (e) => e.code === ERROR_CODES.ERR_DSL_SYNTAX);
  assert.throws(() => compileFilter('a == "\\uZZZZ"'), (e) => e.code === ERROR_CODES.ERR_DSL_SYNTAX);
});

test('H02 hidden: canonical hash key sorting, circular/NaN/BigInt rejection, and undefined property omission', () => {
  const h1 = computeCanonicalPayloadHash({ z: [1, { b: 'e\u0301', a: 2, drop: undefined }], a: -0 });
  const h2 = computeCanonicalPayloadHash({ a: 0, z: [1, { a: 2, b: '\u00e9' }] });
  assert.equal(h1, h2);

  const cyc = {};
  cyc.self = cyc;
  assert.throws(() => computeCanonicalPayloadHash(cyc), (e) => e.code === ERROR_CODES.ERR_INVALID_EVENT);
  assert.throws(() => computeCanonicalPayloadHash([undefined]), (e) => e.code === ERROR_CODES.ERR_INVALID_EVENT);
  assert.throws(() => computeCanonicalPayloadHash({ x: Number.NaN }), (e) => e.code === ERROR_CODES.ERR_INVALID_EVENT);
  assert.throws(() => computeCanonicalPayloadHash({ x: 1n }), (e) => e.code === ERROR_CODES.ERR_INVALID_EVENT);
});

test('H02 hidden: grapheme-safe UTF-8 byte boundary truncation across flags, combining marks, and 4-byte emoji', () => {
  // Regional indicator flag 🇺🇸 is 2 code points (8 UTF-8 bytes) = 1 grapheme!
  const memo = 'abc🇺🇸def';
  const entry = formatBoundedAuditEntry({ invoiceId: 'i1', totalDueCents: 100, memo }, 20);
  // prefix "i1|100|" = 7 bytes; 20 - 3("…") = 17; "abc" = 3 -> 10 bytes; + 🇺🇸 (8 bytes) = 18 > 17 -> must NOT split 🇺🇸!
  assert.equal(entry, 'i1|100|abc…');
  assert.ok(Buffer.byteLength(entry, 'utf8') <= 20);

  const exact = formatBoundedAuditEntry({ invoiceId: 'i1', totalDueCents: 100, memo: 'e\u0301' }, 16);
  // NFC "é" is 2 bytes -> "i1|100|é" = 9 bytes <= 16
  assert.equal(exact, 'i1|100|\u00e9');

  assert.throws(
    () => formatBoundedAuditEntry({ invoiceId: 'i1', totalDueCents: 1, memo: 'x' }, 15),
    (e) => e.code === ERROR_CODES.ERR_INVALID_CONFIG
  );
});

test('[CONSTRAINT-1] zero external deps and zero eval/Function in src/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  for (const f of fs.readdirSync(path.join(REPO_DIR, 'src'))) {
    if (!f.endsWith('.mjs')) continue;
    const t = fs.readFileSync(path.join(REPO_DIR, 'src', f), 'utf8');
    assert.equal(/\beval\s*\(/.test(t), false);
    assert.equal(/\bnew\s+Function\b/.test(t), false);
  }
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
