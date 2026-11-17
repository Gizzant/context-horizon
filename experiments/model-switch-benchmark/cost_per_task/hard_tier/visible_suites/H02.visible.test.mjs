import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter } from '../src/queryDsl.mjs';
import { computeCanonicalPayloadHash } from '../src/idempotencyGuard.mjs';
import { formatBoundedAuditEntry } from '../src/invoiceBuilder.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('H02 visible: Unicode escapes, NFC equality, collision detection, and grapheme-safe UTF-8 truncation', () => {
  const pred = compileFilter('note == "\\u00e9" AND region ~= "EU-WEST"');
  assert.equal(pred({ note: 'e\u0301', region: 'eu-west' }), true);

  assert.equal(
    computeCanonicalPayloadHash({ b: 'e\u0301', a: -0 }),
    computeCanonicalPayloadHash({ a: 0, b: '\u00e9' })
  );
  assert.throws(
    () => computeCanonicalPayloadHash({ ['e\u0301']: 1, ['\u00e9']: 2 }),
    (err) => err.code === ERROR_CODES.ERR_CANONICAL_COLLISION
  );

  const formatted = formatBoundedAuditEntry(
    { invoiceId: 'inv-1', totalDueCents: 500, memo: 'hello 👨‍👩‍👧‍👦 world' },
    24
  );
  assert.ok(Buffer.byteLength(formatted, 'utf8') <= 24);
  assert.ok(formatted.endsWith('…'));
  assert.equal(formatted.includes('\uFFFD'), false);
});
