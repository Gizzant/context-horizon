import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyGuard } from '../src/idempotencyGuard.mjs';
import { createSettlementRegistry } from '../src/invoiceBuilder.mjs';
import { executeSettlementSaga } from '../src/invoiceBuilder.mjs';

test('H05 visible: settlement saga succeeds and replays cached result without re-charging', async () => {
  const reg = createSettlementRegistry([{ grantId: 'g1', remainingCents: 200, effectiveFromMs: 0, expiresAtMs: 50_000 }]);
  const guard = new IdempotencyGuard({ ttlMs: 10_000, maxEntries: 10 });
  let authCalls = 0;
  let ledgerCalls = 0;
  const gateway = {
    authorize: async () => { authCalls += 1; return { authId: 'auth-1' }; },
    capture: async () => ({ captureId: 'cap-1' }),
    release: async () => {},
    refund: async () => {}
  };
  const ledgerStore = { append: async () => { ledgerCalls += 1; } };

  const req = {
    idempotencyKey: 'idem-1',
    invoiceId: 'inv-h05',
    accountId: 'acct-1',
    usageRows: [{ metric: 'api', units: 50, tiers: [{ upTo: null, unitRateCents: 10 }] }], // 500 - 200 = 300
    asOfMs: 1000
  };
  const r1 = await executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, req);
  assert.equal(r1.replayed, false);
  assert.equal(r1.totalDueCents, 300);

  const r2 = await executeSettlementSaga({ registry: reg, guard, gateway, ledgerStore }, req);
  assert.equal(r2.replayed, true);
  assert.equal(authCalls, 1);
  assert.equal(ledgerCalls, 1);
});
