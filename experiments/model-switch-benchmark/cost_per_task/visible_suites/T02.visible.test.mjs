import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyGuard } from '../src/idempotencyGuard.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('T02 visible: inclusive TTL expiry allows re-recording with new hash', () => {
  const guard = new IdempotencyGuard({ ttlMs: 5000, maxEntries: 10 });
  assert.equal(guard.checkAndRecord('k1', 'h1', 1000).status, 'accepted');
  // At exact boundary nowMs === 6000 (1000 + 5000), entry is expired
  const r2 = guard.checkAndRecord('k1', 'h2', 6000);
  assert.equal(r2.status, 'accepted');
  assert.equal(r2.originalRecordedAtMs, 6000);
});

test('T02 visible: invalid TTL rejected and pruneExpired cleans boundary entries', () => {
  assert.throws(
    () => new IdempotencyGuard({ ttlMs: 0 }),
    (err) => err.code === ERROR_CODES.ERR_INVALID_TTL
  );
  const guard = new IdempotencyGuard({ ttlMs: 1000, maxEntries: 10 });
  guard.checkAndRecord('k1', 'h1', 100);
  guard.checkAndRecord('k2', 'h2', 500);
  assert.equal(guard.pruneExpired(1100), 1);
  assert.equal(guard.size, 1);
});
