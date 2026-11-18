/**
 * @file test/flight_mode_and_trial.test.mjs
 * Pricing policy: Free shows what Auto would do but changes nothing; the 14-day trial makes Auto
 * available but leaves it off until the user turns it on; when the trial ends Auto pauses (COACH).
 * `ctxtop mode` is the way to turn Auto on from the CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../bin/ctxtop.mjs';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mode-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mode-cwd-'));
  const opts = { homeDir: home, cwd, licensePath: path.join(home, '.ctxtop', 'license.json'), strict: true };
  return { home, cwd, opts, cleanup: () => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

test('free: mode auto is saved but runs as COACH, with a trial hint', async () => {
  const sb = sandbox();
  try {
    const res = await runCli(['mode', 'auto'], sb.opts);
    assert.equal(res.exitCode, 0);
    assert.equal(res.data.configuredMode, 'AUTO_PILOT');
    assert.equal(res.data.effectiveMode, 'COACH');
    assert.equal(res.data.steppedDown, true);
    assert.match(res.output, /license trial/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.home, '.attention-horizon', 'config.json'), 'utf8')).flightMode, 'AUTO_PILOT');
  } finally { sb.cleanup(); }
});

test('trial: Auto stays off until turned on, then runs with days left shown', async () => {
  const sb = sandbox();
  try {
    const tr = await runCli(['license', 'trial'], sb.opts);
    assert.equal(tr.exitCode, 0);
    assert.match(tr.output, /stays off until you turn it on: npx ctxtop mode auto/);

    const before = await runCli(['mode'], sb.opts);
    assert.equal(before.data.configuredMode, 'COACH', 'trial does not switch Auto on');

    const on = await runCli(['mode', 'auto'], sb.opts);
    assert.equal(on.data.effectiveMode, 'AUTO_PILOT');
    assert.match(on.output, /Trial: 14 days left/);
  } finally { sb.cleanup(); }
});

test('trial started after Auto was chosen says Auto is on', async () => {
  const sb = sandbox();
  try {
    await runCli(['mode', 'auto'], sb.opts);
    const tr = await runCli(['license', 'trial'], sb.opts);
    assert.match(tr.output, /Auto is on for the trial/);
  } finally { sb.cleanup(); }
});

test('expired trial: Auto pauses to COACH and says how to keep it', async () => {
  const sb = sandbox();
  try {
    await runCli(['license', 'trial'], sb.opts);
    await runCli(['mode', 'auto'], sb.opts);
    const later = { ...sb.opts, nowMs: Date.now() + 15 * 86400000 };
    const res = await runCli(['mode'], later);
    assert.equal(res.data.effectiveMode, 'COACH');
    assert.equal(res.data.trialExpired, true);
    assert.match(res.output, /trial has ended, so Auto is paused/);
    const st = await runCli(['license', 'status'], later);
    assert.match(st.output, /Trial ended: Auto is paused/);
  } finally { sb.cleanup(); }
});
