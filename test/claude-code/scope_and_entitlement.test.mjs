/** #9 init scope is reported per host and flags are consistent; #27 no environment-variable Pro unlock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCli } from '../../bin/ctxtop.mjs';
import {
  activateLocalTrial,
  activateProLicense,
  deactivateProLicense,
  generateProKeyPair,
  getProEntitlementStatus,
  requireProFeature,
  resolveLicenseFilePath,
  signProLicensePayload
} from '../../src/core/pro_license.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const strip = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, '');

async function withDirs(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-scope-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-scope-home-'));
  try {
    return await fn({ cwd, homeDir });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test('init --claude reports project scope and targets the project settings file', async () => {
  await withDirs(async ({ cwd, homeDir }) => {
    const res = await runCli(['init', '--claude', '--dry-run'], { cwd, homeDir });
    const out = strip(res.output);
    assert.match(out, /Installation Scope: Claude Code: This project only/);
    assert.doesNotMatch(out, /Scope: Global/);
    assert.ok(out.includes(path.join(cwd, '.claude', 'settings.json')));
  });
});

test('init --claude --global reports global scope and targets the home settings file', async () => {
  await withDirs(async ({ cwd, homeDir }) => {
    const res = await runCli(['init', '--claude', '--global', '--dry-run'], { cwd, homeDir });
    const out = strip(res.output);
    assert.match(out, /Claude Code: Global \(all projects\)/);
    assert.ok(out.includes(path.join(homeDir, '.claude', 'settings.json')));
  });
});

test('init rejects --global together with --project', async () => {
  await withDirs(async ({ cwd, homeDir }) => {
    const res = await runCli(['init', '--claude', '--global', '--project', '--dry-run'], { cwd, homeDir });
    assert.equal(res.exitCode, 1);
    assert.match(res.output, /Choose one scope/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});

for (const [name, value] of [
  ['CTXTOP_PRO_DEV', '1'],
  ['NODE_ENV', 'test'],
  ['NODE_TEST_CONTEXT', '1'],
  ['NODE_TEST_CONTEXT', 'child-v8']
]) {
  test(`${name}=${value} does not unlock Pro in-process or in spawned CLI`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ent-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, [name]: value };
      if (name !== 'NODE_TEST_CONTEXT') {
        delete env.NODE_TEST_CONTEXT;
      }
      const inProc = getProEntitlementStatus({ homeDir: home });
      assert.equal(inProc.entitled, false);
      assert.equal(inProc.tier, 'free');
      assert.equal(inProc.source, 'free_core');

      const script =
        `import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'core', 'pro_license.mjs')).href)})` +
        `.then((m) => process.stdout.write(JSON.stringify(m.getProEntitlementStatus({}))))`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const status = JSON.parse(r.stdout);
      assert.equal(status.entitled, false);
      assert.equal(status.tier, 'free');
      assert.equal(status.source, 'free_core');

      const cliStatus = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ctxtop.mjs'), 'license', 'status', '--json'], {
        cwd: home,
        env,
        encoding: 'utf8'
      });
      assert.equal(cliStatus.status, 0, cliStatus.stderr);
      const parsedCli = JSON.parse(cliStatus.stdout);
      assert.equal(parsedCli.entitled, false);
      assert.equal(parsedCli.tier, 'free');

      const pdfOut = path.join(home, 'blocked.pdf');
      const cliPdf = spawnSync(
        process.execPath,
        [path.join(ROOT, 'bin', 'ctxtop.mjs'), 'receipt', '--pdf', '--out', pdfOut],
        { cwd: home, env, encoding: 'utf8' }
      );
      assert.equal(cliPdf.status, 2);
      assert.equal(fs.existsSync(pdfOut), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('Local 14-day trial cannot be reset via deactivate -> trial or extended by tampering license.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial-sec-'));
  try {
    const DAY = 86400 * 1000;
    const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);

    const t1 = activateLocalTrial({ homeDir: home, nowMs: t0 });
    assert.equal(t1.ok, true);
    const origExpiresAt = t1.expiresAt;

    // Deactivate and re-activate on day 5: must restore original expiresAt, never extend it
    const deactDay5 = deactivateProLicense({ homeDir: home, nowMs: t0 + 5 * DAY });
    assert.equal(deactDay5.ok, true);
    assert.equal(deactDay5.trialHistoryPreserved, true);
    const t5 = activateLocalTrial({ homeDir: home, nowMs: t0 + 5 * DAY });
    assert.equal(t5.ok, true);
    assert.equal(t5.expiresAt, origExpiresAt);

    // Deactivate and attempt reset on day 15: must stay expired
    deactivateProLicense({ homeDir: home, nowMs: t0 + 15 * DAY });
    const t15 = activateLocalTrial({ homeDir: home, nowMs: t0 + 15 * DAY });
    assert.equal(t15.ok, false);
    assert.equal(t15.reason, 'TRIAL_ALREADY_EXPIRED');
    const stAfter = getProEntitlementStatus({ homeDir: home, nowMs: t0 + 15 * DAY });
    assert.equal(stAfter.entitled, false);
    assert.equal(stAfter.tier, 'free');

    // Re-activate fresh in a second isolated dir, then test hand-tampering license.json
    const homeTamper = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial-tamper-'));
    try {
      activateLocalTrial({ homeDir: homeTamper, nowMs: t0 });
      const licPath = resolveLicenseFilePath({ homeDir: homeTamper });
      const orig = JSON.parse(fs.readFileSync(licPath, 'utf8'));

      // 1) Extend expiresAt to 2099
      fs.writeFileSync(licPath, JSON.stringify({ ...orig, expiresAt: '2099-01-01T00:00:00.000Z' }), 'utf8');
      const st2099 = getProEntitlementStatus({ homeDir: homeTamper, nowMs: t0 + DAY });
      assert.equal(st2099.entitled, false);
      assert.equal(st2099.tier, 'free');
      assert.equal(st2099.source, 'tampered_trial');

      // 2) Future-date activatedAt with valid-looking duration
      fs.writeFileSync(
        licPath,
        JSON.stringify({
          ...orig,
          activatedAt: new Date(t0 + 2 * DAY).toISOString(),
          expiresAt: new Date(t0 + 16 * DAY).toISOString()
        }),
        'utf8'
      );
      const stFuture = getProEntitlementStatus({ homeDir: homeTamper, nowMs: t0 + DAY });
      assert.equal(stFuture.entitled, false);
      assert.equal(stFuture.tier, 'free');
      assert.equal(stFuture.source, 'tampered_trial');

      // 3) Strip integrityMac completely
      const { integrityMac: _dropMac, ...noMac } = orig;
      void _dropMac;
      fs.writeFileSync(licPath, JSON.stringify(noMac), 'utf8');
      const stNoMac = getProEntitlementStatus({ homeDir: homeTamper, nowMs: t0 + DAY });
      assert.equal(stNoMac.entitled, false);
      assert.equal(stNoMac.tier, 'free');
      assert.equal(stNoMac.source, 'tampered_trial');
    } finally {
      fs.rmSync(homeTamper, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Team tier unlocks team_finops_pack while Free and expired keys are rejected', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-team-scope-'));
  try {
    const { publicKeyPem, privateKeyPem } = generateProKeyPair();
    const freeTeam = requireProFeature('team_finops_pack', { homeDir: home, publicKeyPem });
    assert.equal(freeTeam.allowed, false);
    assert.equal(freeTeam.tier, 'free');

    const teamKey = signProLicensePayload(
      { tier: 'team', email: 'team@acme.dev', seats: 5, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
      privateKeyPem
    );
    const actTeam = activateProLicense(teamKey, { homeDir: home, publicKeyPem });
    assert.equal(actTeam.ok, true);

    const teamAllowed = requireProFeature('team_finops_pack', { homeDir: home, publicKeyPem });
    assert.equal(teamAllowed.allowed, true);
    assert.equal(teamAllowed.tier, 'team');

    const expiredKey = signProLicensePayload(
      { tier: 'team', email: 'old@acme.dev', seats: 5, expiresAt: new Date(Date.now() - 86400_000).toISOString() },
      privateKeyPem
    );
    const actExpired = activateProLicense(expiredKey, { homeDir: home, publicKeyPem });
    assert.equal(actExpired.ok, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CTXTOP_ED25519_PUBLIC_KEY_PEM cannot replace the trust root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pk-'));
  try {
    const script = `
      import crypto from 'node:crypto';
      const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'core', 'pro_license.mjs')).href)});
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      process.env.CTXTOP_ED25519_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });
      const key = m.signProLicensePayload(
        { tier: 'pro', sku: 'pro_annual', seats: 1, email: 'x@y.z', expiresAt: null },
        privateKey.export({ type: 'pkcs8', format: 'pem' })
      );
      process.stdout.write(JSON.stringify(m.verifyProLicenseKey(key)));`;
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'INVALID_SIGNATURE');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Solo LTD tier unlocks Pro features but does not unlock team_finops_pack', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ltd-scope-'));
  try {
    const { publicKeyPem, privateKeyPem } = generateProKeyPair();
    const ltdKey = signProLicensePayload(
      { tier: 'ltd', email: 'founder-ltd@acme.dev', seats: 1, expiresAt: null },
      privateKeyPem
    );
    const act = activateProLicense(ltdKey, { homeDir: home, publicKeyPem });
    assert.equal(act.ok, true);

    const proFeature = requireProFeature('auto_pilot_locks', { homeDir: home, publicKeyPem });
    assert.equal(proFeature.allowed, true);
    assert.equal(proFeature.tier, 'ltd');

    const teamFeature = requireProFeature('team_finops_pack', { homeDir: home, publicKeyPem });
    assert.equal(teamFeature.allowed, false);
    assert.equal(teamFeature.tier, 'ltd');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Pro annual key unlocks Pro features without leaking team_finops_pack', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pro-scope-'));
  try {
    const { publicKeyPem, privateKeyPem } = generateProKeyPair();
    const proKey = signProLicensePayload(
      { tier: 'pro', email: 'pro@acme.dev', seats: 1, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
      privateKeyPem
    );
    const actPro = activateProLicense(proKey, { homeDir: home, publicKeyPem });
    assert.equal(actPro.ok, true);

    const proAuto = requireProFeature('auto_pilot_locks', { homeDir: home, publicKeyPem });
    assert.equal(proAuto.allowed, true);
    const proPdf = requireProFeature('corporate_expense_receipts', { homeDir: home, publicKeyPem });
    assert.equal(proPdf.allowed, true);
    assert.equal(proPdf.tier, 'pro');

    const proTeam = requireProFeature('team_finops_pack', { homeDir: home, publicKeyPem });
    assert.equal(proTeam.allowed, false);
    assert.equal(proTeam.tier, 'pro');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
