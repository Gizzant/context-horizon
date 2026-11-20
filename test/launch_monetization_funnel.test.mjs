/** Tests for Hybrid pricing parity, 30d emailed trial worker, offline receipt --share, marketplace manifest, and launch benchmark assets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../src/utils/nodeIo.mjs';
import {
  PRO_PRICING_TIERS,
  PLG_TIER_MATRIX,
  generateProKeyPair,
  verifyProLicenseKey,
  activateProLicense,
  requireProFeature
} from '../src/core/pro_license.mjs';
import {
  handleEmailTrialRequest,
  mapPolarOrderToLicenseSpec
} from '../packages/pro/workers/polar_webhook_worker.mjs';
import { formatAnonymizedShareReceipt, runCli } from '../bin/ctxtop.mjs';

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    dump() { return Object.fromEntries(store.entries()); }
  };
}

test('30-day emailed trial route validates email, prevents leaks, handles email failure, dedupes, and unlocks Pro + Team offline', async () => {
  const { publicKeyPem, privateKeyPem } = generateProKeyPair();
  const baseEnv = (kv) => ({
    LICENSE_KV: kv,
    CTXTOP_ED25519_PRIVATE_KEY_PEM: privateKeyPem,
    RESEND_API_KEY: 're_test',
    CTXTOP_EMAIL_FROM: 'Highbeam <licenses@highbeamdev.com>'
  });

  const missingKv = await handleEmailTrialRequest({ rawBody: '{"email":"a@acme.dev"}' }, {});
  assert.equal(missingKv.status, 500);
  assert.equal(missingKv.body.error, 'LICENSE_KV_NOT_BOUND');

  const kv = makeKv();
  const badEmail = await handleEmailTrialRequest({ rawBody: '{"email":"not-an-email"}' }, baseEnv(kv));
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.body.error, 'INVALID_EMAIL');

  const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
  const failSend = await handleEmailTrialRequest(
    { rawBody: '{"email":"Dev@Acme.dev"}', nowMs },
    baseEnv(kv),
    { async sendEmail() { throw new Error('SMTP_DOWN'); } }
  );
  assert.equal(failSend.status, 500);
  assert.equal(failSend.body.error, 'TRIAL_EMAIL_FAILED');
  assert.equal(Object.keys(kv.dump()).length, 0, 'failed email send must not record trial in KV');

  const sent = [];
  const okRes = await handleEmailTrialRequest(
    { rawBody: '{"email":" Dev@Acme.dev "}', nowMs },
    baseEnv(kv),
    { async sendEmail(msg) { sent.push(msg); } }
  );
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.emailed, true);
  assert.equal(okRes.body.tier, 'trial');
  assert.equal(okRes.body.durationDays, 30);
  assert.equal(JSON.stringify(okRes.body).includes('CTXP1.'), false, 'HTTP response must never expose CTXP1 key');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'dev@acme.dev');

  const keyMatch = sent[0].text.match(/CTXP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.ok(keyMatch, 'email text must contain signed CTXP1 trial key');
  const licenseKey = keyMatch[0];

  assert.equal(kv.dump()['metrics:email_trials_issued'], '1');
  const dupRes = await handleEmailTrialRequest(
    { rawBody: '{"email":"dev@acme.dev"}', nowMs },
    baseEnv(kv),
    { async sendEmail() { throw new Error('must not resend'); } }
  );
  assert.equal(dupRes.status, 409);
  assert.equal(dupRes.body.error, 'TRIAL_ALREADY_ISSUED');

  const validAtStart = verifyProLicenseKey(licenseKey, { publicKeyPem, nowMs: nowMs + 86400 * 1000 });
  assert.equal(validAtStart.valid, true);
  assert.equal(validAtStart.payload.tier, 'trial');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial30-'));
  try {
    const act = activateProLicense(licenseKey, { homeDir: tmpHome, publicKeyPem, nowMs: nowMs + 1000 });
    assert.equal(act.ok, true);
    const proGate = requireProFeature('corporate_expense_receipts', { homeDir: tmpHome, publicKeyPem, nowMs: nowMs + 1000 });
    const teamGate = requireProFeature('team_ci_budget_gate', { homeDir: tmpHome, publicKeyPem, nowMs: nowMs + 1000 });
    assert.equal(proGate.allowed, true);
    assert.equal(teamGate.allowed, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  const expiredAt31d = verifyProLicenseKey(licenseKey, { publicKeyPem, nowMs: nowMs + 31 * 86400 * 1000 });
  assert.equal(expiredAt31d.valid, false);
  assert.equal(expiredAt31d.reason, 'LICENSE_EXPIRED');
});

test('Hybrid pricing aligns across pro_license, LICENSE-COMMERCIAL, README, and Polar SKU mapper', () => {
  assert.equal(PRO_PRICING_TIERS.pro_ltd.priceUSD, 199);
  assert.equal(PRO_PRICING_TIERS.pro_annual.priceUSD, 149);
  assert.equal(PRO_PRICING_TIERS.team.priceUSD, 299);
  assert.equal(PRO_PRICING_TIERS.team.seatMonthlyUSD, 15);
  assert.equal(PRO_PRICING_TIERS.team.standardAnnual5SeatUSD, 900);
  assert.equal(PLG_TIER_MATRIX.team.pricePerSeatMonthlyUSD, 15);
  assert.equal(PLG_TIER_MATRIX.team.standardAnnual5SeatUSD, 900);

  const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
  const licenseDoc = fs.readFileSync(path.resolve('packages/pro/LICENSE-COMMERCIAL.md'), 'utf8');
  for (const txt of [readme, licenseDoc]) {
    assert.match(txt, /\$199/);
    assert.match(txt, /\$149\/yr/);
    assert.match(txt, /\$299\/yr/);
    assert.match(txt, /\$15\/seat\/mo/);
    assert.match(txt, /\$900\/yr/);
  }

  const intro = mapPolarOrderToLicenseSpec({ data: { amount: 29900, product: { name: 'Highbeam Team' }, customer: { email: 'a@b.dev' } } });
  assert.equal(intro.sku, 'team_starter');
  assert.equal(intro.seats, 5);

  const stdMonthly = mapPolarOrderToLicenseSpec({ data: { amount: 7500, product: { name: 'Highbeam Team', recurring_interval: 'month' }, customer: { email: 'a@b.dev' } } });
  assert.equal(stdMonthly.sku, 'team_seat_monthly');
  assert.equal(stdMonthly.seats, 5);

  const stdAnnual = mapPolarOrderToLicenseSpec({ data: { amount: 90000, product: { name: 'Highbeam Team Annual', recurring_interval: 'year' }, customer: { email: 'a@b.dev' } } });
  assert.equal(stdAnnual.sku, 'team_standard_annual');
  assert.equal(stdAnnual.seats, 5);
});

test('formatAnonymizedShareReceipt and receipt --share separate 3 buckets and strip all local PII', async () => {
  const sampleReport = {
    summary: {
      workspace30dSavedTokens: 125000,
      workspace30dSavedUSD: 3.12,
      sessionSavedTokens: 14800,
      sessionSavedUSD: 0.44,
      buckets: {
        avoidedWrites: { tokens: 125000, usd: 3.12, sessionTokens: 14800, sessionUSD: 0.44, workspace30dTokens: 125000, workspace30dUSD: 3.12 },
        realizedPromptBill: { count: 1, tokens: 42000, usd: 0.42, workspace30dTokens: 42000, workspace30dUSD: 0.42 },
        platformCacheDiscount: { tokens: 185000, usd: 0.50, workspace30dTokens: 185000, workspace30dUSD: 0.50 }
      }
    }
  };
  const formatted = formatAnonymizedShareReceipt(sampleReport, { cwd: process.cwd(), homeDir: os.homedir() });
  assert.match(formatted, /Highbeam Avoided Writes.*125,000 tok \(\$3\.12\).*14,800 tok \(\$0\.44\)/);
  assert.match(formatted, /Ex-Post Realized Prompt-Bill Delta.*\+42,000 tok \(\+\$0\.4200\)/);
  assert.match(formatted, /Provider KV-Cache Discount \(separate\).*185,000 tok \(\$0\.50\)/);

  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-secret-repo-name-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-secret-'));
  try {
    const cliRes = await runCli(['receipt', '--share'], { cwd: secretDir, homeDir });
    assert.equal(cliRes.exitCode, 0);
    assert.match(cliRes.output, /Highbeam Avoided Writes/);
    assert.match(cliRes.output, /Ex-Post Realized Prompt-Bill Delta/);
    assert.match(cliRes.output, /Provider KV-Cache Discount \(separate\)/);
    assert.match(cliRes.output, /npx highbeam-cli audit --days 7/);
    for (const pii of [secretDir, path.basename(secretDir), homeDir, os.hostname()]) {
      if (pii && pii.length >= 3) {
        assert.equal(cliRes.output.includes(pii), false, `share card must never expose PII (${pii})`);
      }
    }
  } finally {
    fs.rmSync(secretDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Claude Code marketplace manifest and 144-run benchmark launch kit exist with v4.4.1 parity', () => {
  const mp = JSON.parse(fs.readFileSync(path.resolve('.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(mp.name, 'highbeam-marketplace');
  assert.equal(mp.metadata.version, '4.4.1');
  assert.equal(mp.plugins[0].name, 'highbeam');
  assert.equal(mp.plugins[0].version, '4.4.1');

  for (const docPath of [
    'docs-site/benchmark.html',
    'docs/launch/BENCHMARK_LAUNCH_POST.md',
    'docs/launch/DISTRIBUTION_AND_PILOT_PACK.md'
  ]) {
    const body = fs.readFileSync(path.resolve(docPath), 'utf8');
    assert.match(body, /-13\.31%/, `${docPath} must cite -13.31%`);
    assert.match(body, /-24\.31%/, `${docPath} must cite -24.31%`);
    assert.match(body, /T09.*T11/, `${docPath} must cite T09-T11 exploration caveat`);
  }
});
