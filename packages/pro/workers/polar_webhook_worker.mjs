/**
 * @file packages/pro/workers/polar_webhook_worker.mjs
 * Zero-dependency Polar.sh Webhook Handler for minting offline `CTXP1` Ed25519 Pro licenses.
 *
 * Compatible with Cloudflare Workers (`export default { fetch }`) and Node.js HTTP servers.
 * Needs one Cloudflare KV namespace (retry dedupe + LTD counter) and an email sender (Resend by default).
 */

import crypto from 'node:crypto';
import { signProLicensePayload } from '../src/pro_license.mjs';

/**
 * Verifies a Standard Webhooks / Polar.sh HMAC-SHA256 signature (`v1,<base64Sig>`).
 *
 * @param {object} params
 * @param {string} params.rawBody
 * @param {string} params.webhookId
 * @param {string} params.webhookTimestamp
 * @param {string} params.webhookSignature
 * @param {string} params.secret
 * @param {number} [params.toleranceSeconds=300]
 * @param {number} [params.nowMs=Date.now()]
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function verifyPolarWebhookSignature({
  rawBody = '',
  webhookId = '',
  webhookTimestamp = '',
  webhookSignature = '',
  secret = '',
  toleranceSeconds = 300,
  nowMs = Date.now()
} = {}) {
  if (!secret || !webhookId || !webhookTimestamp || !webhookSignature) {
    return { valid: false, reason: 'MISSING_WEBHOOK_HEADERS_OR_SECRET' };
  }

  const tsSec = Number(webhookTimestamp);
  if (!Number.isFinite(tsSec)) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' };
  }
  const ageSec = Math.abs(Math.floor(nowMs / 1000) - tsSec);
  if (toleranceSeconds > 0 && ageSec > toleranceSeconds) {
    return { valid: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE' };
  }

  const cleanSecret = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'utf8');

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expectedB64 = crypto
    .createHmac('sha256', cleanSecret)
    .update(signedContent, 'utf8')
    .digest('base64');

  const candidates = String(webhookSignature)
    .split(/\s+/)
    .map((part) => (part.startsWith('v1,') ? part.slice(3) : part))
    .filter(Boolean);

  const expectedBuf = Buffer.from(expectedB64, 'utf8');
  for (const cand of candidates) {
    const candBuf = Buffer.from(cand, 'utf8');
    if (candBuf.length === expectedBuf.length && crypto.timingSafeEqual(candBuf, expectedBuf)) {
      return { valid: true, reason: null };
    }
  }

  return { valid: false, reason: 'INVALID_HMAC_SIGNATURE' };
}

export const POLAR_LIVE_SKU_CATALOG = Object.freeze({
  pro_monthly: Object.freeze({ sku: 'pro_monthly', tier: 'pro', priceCents: 1500, billingInterval: 'month', defaultSeats: 1, durationDays: 32 }),
  pro_annual: Object.freeze({ sku: 'pro_annual', tier: 'pro', priceCents: 14900, billingInterval: 'year', defaultSeats: 1, durationDays: 366 }),
  pro_ltd: Object.freeze({ sku: 'pro_ltd', tier: 'ltd', priceCents: 19900, billingInterval: 'lifetime', defaultSeats: 1, durationDays: null, cap: 200 }),
  team_starter: Object.freeze({ sku: 'team_starter', tier: 'team', priceCents: 29900, billingInterval: 'year', defaultSeats: 5, durationDays: 366 }),
  team_seat_monthly: Object.freeze({ sku: 'team_seat_monthly', tier: 'team', priceCents: 3900, billingInterval: 'month', defaultSeats: 1, durationDays: 32 })
});

/**
 * Maps a Polar.sh order/subscription payload to a Highbeam Pro/Team SKU, tier, and seat count.
 * @param {object} eventPayload
 */
export function mapPolarOrderToLicenseSpec(eventPayload = {}) {
  const data = eventPayload.data || eventPayload;
  const productName = String(
    data.product?.name || data.product_name || data.price?.product_name || data.tier || 'pro'
  ).toLowerCase();
  const recurringInterval = String(
    data.product?.recurring_interval ||
      data.price?.recurring_interval ||
      data.recurring_interval ||
      data.billing_interval ||
      ''
  ).toLowerCase();
  const skuHint = String(
    data.metadata?.sku || data.product?.metadata?.sku || data.sku || ''
  ).toLowerCase();
  const amountCents = Number(
    data.amount ?? data.total_amount ?? data.price_amount ?? data.price?.price_amount ?? 0
  );
  const rawSeats = Number(data.seats || data.quantity || data.metadata?.seats || 0);
  const ltdEditionNumber = Number(
    data.metadata?.ltd_edition_number ?? data.ltd_edition_number ?? data.ltd_count ?? 0
  );
  const email =
    data.customer?.email ||
    data.user?.email ||
    data.customer_email ||
    data.email ||
    '';

  let sku = 'pro_monthly';
  let tier = 'pro';
  let seats = 1;
  let expiresAt = null;
  let cap = null;
  const issuedAt = new Date().toISOString();

  const isExplicitTeam = productName.includes('team') || skuHint.includes('team');
  const isExplicitPerSeat =
    skuHint === 'team_seat_monthly' ||
    productName.includes('per-seat') ||
    productName.includes('seat/mo') ||
    productName.includes('finops');
  const isTeamSeatMultiple =
    amountCents > 0 && amountCents !== 29900 && amountCents % 3900 === 0;

  if (
    isExplicitPerSeat ||
    (isExplicitTeam &&
      skuHint !== 'team_starter' &&
      (recurringInterval === 'month' || productName.includes('month') || isTeamSeatMultiple)) ||
    (!productName.includes('pro') &&
      !productName.includes('founder') &&
      !productName.includes('ltd') &&
      isTeamSeatMultiple &&
      amountCents !== 19500)
  ) {
    sku = 'team_seat_monthly';
    tier = 'team';
    seats =
      rawSeats > 0
        ? rawSeats
        : isTeamSeatMultiple
          ? Math.max(1, Math.round(amountCents / 3900))
          : 5;
    const isAnnual =
      recurringInterval === 'year' ||
      productName.includes('annual') ||
      productName.includes('year');
    expiresAt = new Date(Date.now() + (isAnnual ? 366 : 32) * 86400 * 1000).toISOString();
  } else if (skuHint === 'team_starter' || isExplicitTeam || amountCents >= 25000) {
    sku = 'team_starter';
    tier = 'team';
    seats = rawSeats > 0 ? rawSeats : 5;
    expiresAt = new Date(Date.now() + 366 * 86400 * 1000).toISOString();
  } else if (
    skuHint === 'pro_ltd' ||
    productName.includes('lifetime') ||
    productName.includes('ltd') ||
    productName.includes('founder') ||
    (amountCents >= 18000 && amountCents < 25000)
  ) {
    sku = 'pro_ltd';
    tier = 'ltd';
    seats = 1;
    expiresAt = null;
    cap = 200;
  } else if (
    skuHint === 'pro_annual' ||
    productName.includes('annual') ||
    productName.includes('year') ||
    recurringInterval === 'year' ||
    (amountCents >= 10000 && amountCents < 18000)
  ) {
    sku = 'pro_annual';
    tier = 'pro';
    seats = 1;
    expiresAt = new Date(Date.now() + 366 * 86400 * 1000).toISOString();
  } else {
    sku = 'pro_monthly';
    tier = 'pro';
    seats = 1;
    expiresAt = new Date(Date.now() + 32 * 86400 * 1000).toISOString();
  }

  return {
    sku,
    tier,
    seats,
    email,
    issuedAt,
    expiresAt,
    cap,
    ltdEditionNumber: ltdEditionNumber || null,
    orderId: data.id || null,
    source: 'polar.sh'
  };
}

/**
 * Processes a raw Polar.sh webhook HTTP request and signs an offline `CTXP1` Ed25519 license key.
 *
 * @param {object} reqInput
 * @param {string} reqInput.rawBody
 * @param {Record<string, string>} reqInput.headers
 * @param {object} env
 * @param {string} env.CTXTOP_POLAR_WEBHOOK_SECRET
 * @param {string} env.CTXTOP_ED25519_PRIVATE_KEY_PEM
 * @param {number} [reqInput.nowMs]
 */
export function handlePolarWebhookRequest(reqInput = {}, env = {}) {
  const headers = reqInput.headers || {};
  const getHeader = (name) =>
    headers[name] || headers[name.toLowerCase()] || '';

  const secret = env.CTXTOP_POLAR_WEBHOOK_SECRET || process.env.CTXTOP_POLAR_WEBHOOK_SECRET || '';
  const privateKeyPem =
    env.CTXTOP_ED25519_PRIVATE_KEY_PEM || process.env.CTXTOP_ED25519_PRIVATE_KEY_PEM || '';

  const sigCheck = verifyPolarWebhookSignature({
    rawBody: reqInput.rawBody || '',
    webhookId: getHeader('webhook-id') || getHeader('svix-id'),
    webhookTimestamp: getHeader('webhook-timestamp') || getHeader('svix-timestamp'),
    webhookSignature: getHeader('webhook-signature') || getHeader('svix-signature'),
    secret,
    nowMs: reqInput.nowMs || Date.now()
  });

  if (!sigCheck.valid) {
    return {
      status: 401,
      body: { ok: false, error: sigCheck.reason }
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(reqInput.rawBody || '{}');
  } catch {
    return {
      status: 400,
      body: { ok: false, error: 'INVALID_JSON_BODY' }
    };
  }

  const eventType = String(parsed.type || 'order.paid');
  // Only `order.paid` issues keys. It fires once per paid order (initial purchase and each renewal) and its
  // `data.id` is the order id used for dedupe. Subscription/benefit events carry different ids and would
  // email duplicate keys for one purchase.
  if (!/^order\.paid$/i.test(eventType)) {
    return {
      status: 200,
      body: { ok: true, ignored: true, eventType }
    };
  }
  // Never issue a key for an order that is not paid yet (order.created can fire before payment).
  const orderStatus = parsed?.data?.status;
  if (/^order\./i.test(eventType) && orderStatus && String(orderStatus).toLowerCase() !== 'paid') {
    return {
      status: 200,
      body: { ok: true, ignored: true, eventType, reason: 'ORDER_NOT_PAID', orderStatus }
    };
  }

  const spec = mapPolarOrderToLicenseSpec(parsed);
  const maxLtdCap = Number(env.CTXTOP_LTD_MAX_CAP || 200);
  const soldCount = Number(env.CTXTOP_LTD_SOLD_COUNT || 0);
  if (
    spec.tier === 'ltd' &&
    ((spec.ltdEditionNumber !== null && spec.ltdEditionNumber > maxLtdCap) ||
      soldCount >= maxLtdCap)
  ) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'LTD_CAP_200_EXCEEDED',
        cap: maxLtdCap
      }
    };
  }

  const licenseKey = signProLicensePayload(spec, privateKeyPem);

  return {
    status: 200,
    body: {
      ok: true,
      eventType,
      sku: spec.sku,
      tier: spec.tier,
      seats: spec.seats,
      cap: spec.cap,
      email: spec.email,
      expiresAt: spec.expiresAt,
      licenseKey,
      activationCommand: `npx ctxtop license activate ${licenseKey}`
    }
  };
}

const LTD_COUNT_KEY = 'ltd:sold_count';

function jsonResponse(status, body) {
  return { status, body };
}

/**
 * Builds the plain-text license email. The key is only ever sent here, never returned over HTTP.
 */
export function buildLicenseEmail({ licenseKey, activationCommand, sku, tier, seats }) {
  const lines = [
    'Thanks for buying Highbeam Pro.',
    '',
    `Plan: ${sku}${tier ? ` (${tier})` : ''}${seats ? `, ${seats} seat(s)` : ''}`,
    '',
    'Activate it with one command:',
    activationCommand,
    '',
    'Your license key (keep it private):',
    licenseKey,
    '',
    'Keys are verified offline; Highbeam makes no network call to check them.',
    'Lost this email or need a replacement? Reply and we will reissue it.'
  ];
  return { subject: 'Your Highbeam Pro license key', text: lines.join('\n') };
}

/**
 * Sends the email through Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 * Swap this function (or pass `deps.sendEmail`) to use another provider.
 */
export async function sendLicenseEmailViaResend({ to, subject, text }, env, fetchImpl = fetch) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.CTXTOP_EMAIL_FROM;
  if (!apiKey || !from) throw new Error('EMAIL_NOT_CONFIGURED');
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
  if (!res.ok) throw new Error(`EMAIL_SEND_FAILED_${res.status}`);
}

/**
 * Async Polar webhook pipeline used by the Worker:
 *   verify signature -> dedupe retries -> enforce the real LTD counter -> sign key -> EMAIL it.
 * The license key is never included in the HTTP response (anyone replaying a webhook could read it).
 * A failed email returns 500 and records nothing, so Polar's retry delivers it later.
 *
 * @param {object} reqInput  { rawBody, headers, nowMs }
 * @param {object} env       secrets/vars plus optional `LICENSE_KV` namespace binding
 * @param {object} [deps]    { sendEmail } override for tests or another provider
 */
export async function processPolarWebhook(reqInput = {}, env = {}, deps = {}) {
  const kv = env.LICENSE_KV;
  if (!kv) {
    return jsonResponse(500, { ok: false, error: 'LICENSE_KV_NOT_BOUND' });
  }
  const soldCount = Number((await kv.get(LTD_COUNT_KEY)) || 0);

  let res;
  try {
    res = handlePolarWebhookRequest(reqInput, { ...env, CTXTOP_LTD_SOLD_COUNT: soldCount });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: 'HANDLE_WEBHOOK_EXCEPTION',
      detail: String(err?.message || err)
    });
  }
  if (res.status !== 200 || res.body.ignored) return res;

  const headers = reqInput.headers || {};
  let orderId = '';
  try {
    orderId = String(JSON.parse(reqInput.rawBody || '{}')?.data?.id || '');
  } catch {
    // handlePolarWebhookRequest already validated the JSON
  }
  const dedupeId =
    orderId || String(headers['webhook-id'] || headers['svix-id'] || '');
  if (!dedupeId) {
    return jsonResponse(400, { ok: false, error: 'MISSING_ORDER_ID' });
  }
  const orderKey = `order:${dedupeId}`;
  if (await kv.get(orderKey)) {
    return jsonResponse(200, { ok: true, duplicate: true, sku: res.body.sku });
  }

  const { licenseKey, activationCommand, ...publicBody } = res.body;
  if (!publicBody.email) {
    return jsonResponse(422, { ok: false, error: 'MISSING_CUSTOMER_EMAIL' });
  }

  const sendEmail =
    deps.sendEmail || ((msg) => sendLicenseEmailViaResend(msg, env, deps.fetch || fetch));
  try {
    await sendEmail({
      to: publicBody.email,
      ...buildLicenseEmail({ licenseKey, activationCommand, ...publicBody })
    });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: 'LICENSE_EMAIL_FAILED',
      detail: String(err?.message || err).slice(0, 80)
    });
  }

  await kv.put(orderKey, JSON.stringify({ sku: publicBody.sku, at: Date.now() }));
  if (publicBody.tier === 'ltd') {
    // KV is not atomic; at a 200-unit cap with human-speed purchases the race window is negligible.
    await kv.put(LTD_COUNT_KEY, String(soldCount + 1));
  }
  return jsonResponse(200, { ...publicBody, emailed: true });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }), {
          status: 405,
          headers: { 'content-type': 'application/json' }
        });
      }
      const rawBody = await request.text();
      const headersObj = {};
      request.headers.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
      const res = await processPolarWebhook({ rawBody, headers: headersObj }, env);
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' }
      });
    } catch (err) {
      console.error('WORKER_UNCAUGHT_EXCEPTION:', err);
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'WORKER_EXCEPTION',
          message: err?.message || String(err),
          stack: err?.stack || ''
        }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' }
        }
      );
    }
  }
};
