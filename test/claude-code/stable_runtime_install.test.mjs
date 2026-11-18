/** Blocker #6: hooks installed from an npx cache must point at a stable copy, not the cache. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isEphemeralPackageRoot,
  ensureStableRuntime,
  installAttentionHorizon,
  PKG_ROOT
} from '../../bin/ctxtop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('detects npx / npm-cache / dlx / temp roots as ephemeral, real installs as stable', () => {
  const tmpDir = '/var/tmp-x';
  for (const p of [
    '/home/u/.npm/_npx/3f2a/node_modules/ctxtop',
    'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\ctxtop',
    '/home/u/.cache/pnpm/dlx/abc/node_modules/ctxtop',
    '/var/tmp-x/xfs-1234/dlx-99/node_modules/ctxtop'
  ]) {
    assert.equal(isEphemeralPackageRoot(p, { tmpDir }), true, p);
  }
  for (const p of [
    '/usr/local/lib/node_modules/ctxtop',
    '/home/u/projects/ga-visualizer-v2',
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ctxtop'
  ]) {
    assert.equal(isEphemeralPackageRoot(p, { tmpDir }), false, p);
  }
});

function fakeNpxPackage() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-npx-'));
  const root = path.join(base, '_npx', 'abc123', 'node_modules', 'ctxtop');
  fs.mkdirSync(path.join(root, 'hooks', 'handlers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs-not-shipped'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ctxtop', version: '9.9.9', files: ['hooks/', 'CHECKSUMS.sha256'] })
  );
  fs.writeFileSync(path.join(root, 'CHECKSUMS.sha256'), 'abc  hooks/handlers/pre-tool-use.mjs\n');
  fs.writeFileSync(path.join(root, 'hooks', 'handlers', 'pre-tool-use.mjs'), '// handler\n');
  fs.writeFileSync(path.join(root, 'docs-not-shipped', 'x.md'), 'x');
  return { base, root };
}

test('ensureStableRuntime copies only published files, atomically, and re-uses a complete copy', () => {
  const { base, root } = fakeNpxPackage();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-'));
  try {
    const first = ensureStableRuntime({ sourceRoot: root, homeDir });
    assert.equal(first.copied, true);
    const target = path.join(homeDir, '.ctxtop', 'app', '9.9.9');
    assert.equal(first.root, target.replace(/\\/g, '/'));
    assert.ok(fs.existsSync(path.join(target, 'hooks', 'handlers', 'pre-tool-use.mjs')));
    assert.ok(fs.existsSync(path.join(target, 'package.json')));
    assert.equal(fs.existsSync(path.join(target, 'docs-not-shipped')), false);
    assert.deepEqual(
      fs.readdirSync(path.join(homeDir, '.ctxtop', 'app')).filter((n) => n.includes('staging')),
      []
    );
    const second = ensureStableRuntime({ sourceRoot: root, homeDir });
    assert.equal(second.copied, false, 'same build is re-used, not re-copied');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('install from an npx cache wires every hook to ~/.ctxtop/app/<version>, never the cache', () => {
  const { base, root } = fakeNpxPackage();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-proj-'));
  try {
    const res = installAttentionHorizon({
      cwd,
      homeDir,
      sourceRoot: root,
      checkBinaryCapabilities: false
    });
    assert.equal(res.ok, true);
    assert.equal(res.runtimeCopied, true);
    const stable = path.join(homeDir, '.ctxtop', 'app', '9.9.9').replace(/\\/g, '/');
    const settings = JSON.parse(fs.readFileSync(res.settingsPath, 'utf8'));
    const commands = [];
    for (const [ev, list] of Object.entries(settings.hooks)) {
      if (ev === 'modules') continue;
      for (const m of list) for (const h of m.hooks || []) commands.push(h.command);
    }
    assert.ok(commands.length > 0);
    for (const c of [...commands, settings.statusLine?.command || '']) {
      assert.ok(!c.includes('_npx'), `still points at the npx cache: ${c}`);
    }
    assert.ok(commands.every((c) => c.includes(stable)), 'every hook uses the stable copy');
  } finally {
    for (const d of [base, homeDir, cwd]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('install from a git checkout or global install keeps using the package folder', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-proj-'));
  try {
    const res = installAttentionHorizon({ cwd, homeDir, dryRun: true, checkBinaryCapabilities: false, tmpDir: '/nonexistent-tmp' });
    assert.equal(res.runtimeCopied, false);
    assert.equal(res.runtimeRoot, PKG_ROOT);
    assert.equal(fs.existsSync(path.join(homeDir, '.ctxtop', 'app')), false);
    assert.ok(ROOT);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
