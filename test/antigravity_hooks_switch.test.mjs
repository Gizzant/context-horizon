/**
 * @file test/antigravity_hooks_switch.test.mjs
 * Fix list #15: a reinstall kept `"enabled": false` in the Antigravity hooks.json without saying so,
 * and doctor still reported the hooks as Active, so guards silently did not run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installPlugin } from '../src/cli/init.mjs';
import { runDoctor } from '../src/cli/doctor.mjs';

function seedDisabledHooks(home) {
  const dir = path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({
    hooks: { PreToolUse: [] },
    'horizon-flightcheck-lifecycle': { enabled: false, PreInvocation: [], PostInvocation: [], SessionStart: [] }
  }));
  return file;
}

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: fn(), lines }; } finally { console.log = orig; }
}

test('reinstall keeps an off switch but warns; --enable turns it back on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-agy-switch-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-agy-cwd-'));
  try {
    const file = seedDisabledHooks(home);
    const kept = captureLog(() => installPlugin({ homeDir: home, cwd }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['horizon-flightcheck-lifecycle'].enabled, false);
    assert.ok(kept.lines.some((l) => /switched off/.test(l) && /--enable/.test(l)), 'warns that guards are off');

    const on = captureLog(() => installPlugin({ homeDir: home, cwd, enable: true }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['horizon-flightcheck-lifecycle'].enabled, true);
    assert.ok(!on.lines.some((l) => /switched off/.test(l)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor warns when the Antigravity hooks are switched off', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-agy-doc-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-agy-doc-cwd-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    seedDisabledHooks(home);
    const res = await runDoctor({ workspacePath: cwd, silent: true });
    const row = res.results.find((r) => r.title === 'Antigravity Hooks');
    assert.ok(row, 'Antigravity Hooks row present');
    assert.equal(row.status, 'WARN');
    assert.match(JSON.stringify(row), /Switched off/);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
