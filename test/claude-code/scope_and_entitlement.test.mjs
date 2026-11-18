/** #9 init scope is reported per host and flags are consistent; #27 no environment-variable Pro unlock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../bin/ctxtop.mjs';

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

for (const [name, value] of [['CTXTOP_PRO_DEV', '1'], ['NODE_ENV', 'test']]) {
  test(`${name}=${value} does not unlock Pro outside the test runner`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ent-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, [name]: value };
      delete env.NODE_TEST_CONTEXT; // a real user's shell, not node --test
      const script =
        `import(${JSON.stringify(path.join(ROOT, 'src', 'core', 'pro_license.mjs'))})` +
        `.then((m) => process.stdout.write(JSON.stringify(m.getProEntitlementStatus({}))))`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const status = JSON.parse(r.stdout);
      assert.equal(status.entitled, false);
      assert.notEqual(status.source, 'dev_or_test_bypass');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('CTXTOP_ED25519_PUBLIC_KEY_PEM cannot replace the trust root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pk-'));
  try {
    const script = `
      import crypto from 'node:crypto';
      const m = await import(${JSON.stringify(path.join(ROOT, 'src', 'core', 'pro_license.mjs'))});
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
