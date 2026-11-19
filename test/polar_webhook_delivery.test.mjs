/**
 * Blocker 3: paid buyers must receive their license key (by email), retries must not double-send,
 * the LTD cap must use a real counter, and the key must never appear in the HTTP response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import workerDefault, {
  mapPolarOrderToLicenseSpec,
  processPolarWebhook
} from '../packages/pro/workers/polar_webhook_worker.mjs';

const secretRaw = 'super-secret-polar-key-32-bytes!';
const secret = 'whsec_' + Buffer.from(secretRaw).toString('base64');
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

function makeKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
}

function signedReq(orderId, body, nowMs = Date.now()) {
  const rawBody = JSON.stringify(body);
  const id = `msg_${orderId}`;
  const ts = String(Math.floor(nowMs / 1000));
  const sig = crypto
    .createHmac('sha256', Buffer.from(secretRaw))
    .update(`${id}.${ts}.${rawBody}`, 'utf8')
    .digest('base64');
  return {
    rawBody,
    nowMs,
    headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }
  };
}

const order = (id, name, amount) => ({
  type: 'order.paid',
  data: { id, amount, product: { name }, customer: { email: 'buyer@acme.dev' } }
});
const baseEnv = (kv) => ({
  CTXTOP_POLAR_WEBHOOK_SECRET: secret,
  CTXTOP_ED25519_PRIVATE_KEY_PEM: pem,
  LICENSE_KV: kv
});

test('paid order emails the key and never returns it in the response', async () => {
  const kv = makeKv();
  const sent = [];
  const res = await processPolarWebhook(
    signedReq('ord_1', order('ord_1', 'Highbeam Pro Monthly', 1500)),
    baseEnv(kv),
    { sendEmail: async (m) => void sent.push(m) }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.emailed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'buyer@acme.dev');
  assert.match(sent[0].text, /CTXP1\.[\w-]+\.[\w-]+/);
  assert.ok(!JSON.stringify(res.body).includes('CTXP1.'), 'key leaked in response body');
  assert.equal(res.body.licenseKey, undefined);
});

test('retried webhook for the same order sends only one email', async () => {
  const kv = makeKv();
  const sent = [];
  const deps = { sendEmail: async (m) => void sent.push(m) };
  const req = signedReq('ord_2', order('ord_2', 'Highbeam Pro Annual', 14900));
  await processPolarWebhook(req, baseEnv(kv), deps);
  const again = await processPolarWebhook(req, baseEnv(kv), deps);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(sent.length, 1);
});

test('email failure returns 500 and records nothing so Polar retries', async () => {
  const kv = makeKv();
  const req = signedReq('ord_3', order('ord_3', 'Highbeam Pro Monthly', 1500));
  const fail = await processPolarWebhook(req, baseEnv(kv), {
    sendEmail: async () => {
      throw new Error('EMAIL_SEND_FAILED_500');
    }
  });
  assert.equal(fail.status, 500);
  assert.equal(kv.m.size, 0);
  const sent = [];
  const retry = await processPolarWebhook(req, baseEnv(kv), { sendEmail: async (m) => void sent.push(m) });
  assert.equal(retry.status, 200);
  assert.equal(sent.length, 1);
});

test('LTD sales are counted in KV; over-cap paid orders are honored by default and blocked only when CTXTOP_ENFORCE_HARD_409_CAP=true', async () => {
  const kv = makeKv({ 'ltd:sold_count': '199' });
  const sent = [];
  const deps = { sendEmail: async (m) => void sent.push(m) };
  const ltd = (id) => signedReq(id, order(id, 'Highbeam Founders LTD', 19900));
  const last = await processPolarWebhook(ltd('ord_199'), baseEnv(kv), deps);
  assert.equal(last.status, 200);
  assert.equal(kv.m.get('ltd:sold_count'), '200');

  // Default honor-paid behavior protects an already-charged customer from HTTP 409 lockouts
  const overDefault = await processPolarWebhook(ltd('ord_200'), baseEnv(kv), deps);
  assert.equal(overDefault.status, 200);
  assert.equal(overDefault.body.emailed, true);
  assert.equal(overDefault.body.overCapFulfilled, true);
  assert.equal(overDefault.body.warning, 'LTD_CAP_200_EXCEEDED_HONOR_PAID');
  assert.equal(sent.length, 2);

  // Strict opt-in flag restores HTTP 409 cap rejection
  const overStrict = await processPolarWebhook(
    ltd('ord_201'),
    { ...baseEnv(kv), CTXTOP_ENFORCE_HARD_409_CAP: 'true' },
    deps
  );
  assert.equal(overStrict.status, 409);
  assert.equal(overStrict.body.error, 'LTD_CAP_200_EXCEEDED');
  assert.equal(sent.length, 2);
});

test('invalid signature is rejected before any state or email', async () => {
  const kv = makeKv();
  const req = signedReq('ord_5', order('ord_5', 'Highbeam Pro Monthly', 1500));
  req.headers['webhook-signature'] = 'v1,aW52YWxpZA==';
  const sent = [];
  const res = await processPolarWebhook(req, baseEnv(kv), { sendEmail: async (m) => void sent.push(m) });
  assert.equal(res.status, 401);
  assert.equal(sent.length, 0);
  assert.equal(kv.m.size, 0);
});

test('missing KV binding fails closed', async () => {
  const res = await processPolarWebhook(
    signedReq('ord_6', order('ord_6', 'Highbeam Pro Monthly', 1500)),
    { CTXTOP_POLAR_WEBHOOK_SECRET: secret, CTXTOP_ED25519_PRIVATE_KEY_PEM: pem },
    { sendEmail: async () => {} }
  );
  assert.equal(res.status, 500);
});

test('order.paid issues a key; an unpaid order.created is ignored', async () => {
  const kv = makeKv();
  const sent = [];
  const deps = { sendEmail: async (m) => void sent.push(m) };

  const pending = { type: 'order.created', data: { id: 'ord_p', status: 'pending', amount: 1500, product: { name: 'Highbeam Pro Monthly' }, customer: { email: 'buyer@acme.dev' } } };
  const r1 = await processPolarWebhook(signedReq('ord_p', pending), baseEnv(kv), deps);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ignored, true);
  assert.equal(sent.length, 0, 'no key for an unpaid order');

  const paid = { type: 'order.paid', data: { id: 'ord_p', status: 'paid', amount: 1500, product: { name: 'Highbeam Pro Monthly' }, customer: { email: 'buyer@acme.dev' } } };
  const r2 = await processPolarWebhook(signedReq('ord_p', paid), baseEnv(kv), deps);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.emailed, true);
  assert.equal(sent.length, 1);
});

test('only order.paid issues keys; benefit_grant/subscription events and orders without an email never email', async () => {
  const kv = makeKv();
  const sent = [];
  const deps = { sendEmail: async (m) => void sent.push(m) };

  for (const type of ['benefit_grant.created', 'subscription.created', 'subscription.active', 'order.created']) {
    const evt = { type, data: { id: 'x_' + type, status: 'paid', amount: 1500, product: { name: 'Highbeam Pro Monthly' }, customer: { email: 'buyer@acme.dev' } } };
    const r = await processPolarWebhook(signedReq('evt_' + type, evt), baseEnv(kv), deps);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, true, `${type} must be ignored`);
  }
  assert.equal(sent.length, 0);

  const noEmail = { type: 'order.paid', data: { id: 'ord_noemail', status: 'paid', amount: 1500, product: { name: 'Highbeam Pro Monthly' } } };
  const r = await processPolarWebhook(signedReq('ord_noemail', noEmail), baseEnv(kv), deps);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'MISSING_CUSTOMER_EMAIL');
  assert.equal(sent.length, 0, 'never email a placeholder address');
});

test('CTXTOP_POLAR_PRODUCT_MAP and pre-discount amounts prevent coupon discounts from downgrading tiers', () => {
  // 1) Explicit product_id mapping overrides heavy 50% coupon price ($99 LTD -> pro_ltd)
  const mappedLtd = mapPolarOrderToLicenseSpec(
    {
      data: {
        id: 'ord_coup_1',
        product_id: 'prod_founders_ltd',
        amount: 9900,
        product: { id: 'prod_founders_ltd', name: 'Highbeam' },
        customer: { email: 'coup@acme.dev' }
      }
    },
    { CTXTOP_POLAR_PRODUCT_MAP: JSON.stringify({ prod_founders_ltd: 'pro_ltd' }) }
  );
  assert.equal(mappedLtd.sku, 'pro_ltd');
  assert.equal(mappedLtd.tier, 'ltd');
  assert.equal(mappedLtd.expiresAt, null);

  // 2) Pre-discount subtotal_amount / discount_amount protects Annual & LTD in fallback price bands
  const discountedAnnual = mapPolarOrderToLicenseSpec({
    data: {
      id: 'ord_coup_2',
      amount: 8900,
      subtotal_amount: 14900,
      product: { name: 'Highbeam Pro' },
      customer: { email: 'ann@acme.dev' }
    }
  });
  assert.equal(discountedAnnual.sku, 'pro_annual');
  assert.equal(discountedAnnual.tier, 'pro');

  const discountedLtd = mapPolarOrderToLicenseSpec({
    data: {
      id: 'ord_coup_3',
      amount: 14900,
      discount_amount: 5000,
      product: { name: 'Highbeam Founders' },
      customer: { email: 'ltd@acme.dev' }
    }
  });
  assert.equal(discountedLtd.sku, 'pro_ltd');
  assert.equal(discountedLtd.tier, 'ltd');
  assert.equal(discountedLtd.expiresAt, null);
});

test('Worker fetch() never exposes raw error stack traces in HTTP 500 responses', async () => {
  const throwingReq = {
    method: 'POST',
    async text() {
      throw new Error('simulated sensitive boom');
    },
    headers: new Headers()
  };
  const res = await workerDefault.fetch(throwingReq, {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, error: 'INTERNAL_WORKER_ERROR' });
  assert.equal(body.stack, undefined);
  assert.equal(body.message, undefined);
});
