import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';

import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { evaluateScopeBrake } from '../src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs';
import { HysteresisLock } from '../src/core/coach/task_quota_router.mjs';
import {
  generateProKeyPair,
  signProLicensePayload,
  verifyProLicenseKey,
  activateProLicense,
  activateLocalTrial,
  deactivateProLicense,
  getProEntitlementStatus
} from '../src/core/pro_license.mjs';
import {
  sha256HexPure,
  generateCorporateExpenseReceipt
} from '../src/core-isomorphic/ui/pdfReceiptGenerator.mjs';
import {
  buildCanonicalAhHooks,
  PRE_TOOL_USE_MATCHER,
  LEAN_PRE_TOOL_USE_MATCHER,
  runCli
} from '../bin/ctxtop.mjs';

test('Roadmap Item #2: GA post_tool_use skips per-tool transcript re-parse, pre_tool_use skips TCP when no .ctl exists, and CC Tier 1 fast-path + --lean-hooks work', () => {
  const postToolUseSrc = fs.readFileSync(path.resolve('hooks/post_tool_use.mjs'), 'utf8');
  assert.equal(
    postToolUseSrc.includes('handlePostInvocation'),
    false,
    'hooks/post_tool_use.mjs must not invoke handlePostInvocation on every tool call'
  );

  const preToolUseSrc = fs.readFileSync(path.resolve('hooks/pre_tool_use.mjs'), 'utf8');
  assert.ok(
    preToolUseSrc.includes('if (!hasCtlFile && !input?.forceIpcCheck)'),
    'hooks/pre_tool_use.mjs must skip IPC socket probe when no .ctl file exists'
  );

  // CC Tier-1-active fast-path for Grep/Glob (<2ms)
  const t0 = performance.now();
  const preRes = runPreToolUseHook(
    { tool_name: 'Grep', tool_input: { pattern: 'foo' } },
    { tier1ModActive: true }
  );
  const postRes = runPostToolUseHook(
    { tool_name: 'Glob', tool_response: 'src/index.mjs\n' },
    { tier1ModActive: true }
  );
  const elapsedMs = performance.now() - t0;
  assert.equal(preRes.fastPath, 'tier1_mod_active');
  assert.equal(postRes.fastPath, 'tier1_mod_active');
  assert.ok(elapsedMs < 10, `Tier 1 fast-path must complete in <10ms (got ${elapsedMs.toFixed(2)}ms)`);

  // --lean-hooks option strips Read|Grep|Glob while default preserves ISS-018 contract
  const defaultHooks = buildCanonicalAhHooks();
  const leanHooks = buildCanonicalAhHooks({ leanHooks: true });
  assert.equal(defaultHooks.PreToolUse[0].matcher, PRE_TOOL_USE_MATCHER);
  assert.equal(leanHooks.PreToolUse[0].matcher, LEAN_PRE_TOOL_USE_MATCHER);
  assert.equal(/\b(Read|Grep|Glob)\b/.test(leanHooks.PreToolUse[0].matcher), false);
});

test('Roadmap Item #3: promptHygieneGovernor passes short anchored prompts and HysteresisLock supports 1-click unlock & 3-turn auto-decay', () => {
  for (const prompt of [
    'Fix this UI alignment',
    'Update button padding',
    'Fix the failing test',
    'Check console error',
    'Update header border'
  ]) {
    const res = evaluateScopeBrake({ promptText: prompt, mode: 'AUTO_PILOT' });
    assert.equal(res.triggered, false, `Prompt "${prompt}" must not trigger false-positive Scope Brake`);
  }

  const lock = new HysteresisLock();
  lock.engage({
    stepId: 'step-1',
    model: 'gemini-4-argon',
    effort: 'high',
    detectorId: 'DET-01',
    turnIndex: 2
  });
  assert.equal(lock.isLocked(), true);

  // Auto-decay after 3 clean turns without requiring task.md [x]
  assert.equal(lock.onTurnCompleted({ hadBreakerError: false }).unlocked, false);
  assert.equal(lock.onTurnCompleted({ hadBreakerError: false }).unlocked, false);
  const decayRes = lock.onTurnCompleted({ hadBreakerError: false });
  assert.equal(decayRes.unlocked, true);
  assert.equal(decayRes.reason, 'AUTO_DECAY_CLEAN_TURNS');
  assert.equal(lock.isLocked(), false);

  // Manual 1-click UI unlock
  lock.engage({ stepId: 'step-2', detectorId: 'DET-02', turnIndex: 5 });
  assert.equal(lock.isLocked(), true);
  const manualRes = lock.unlock('MANUAL_UI_UNLOCK');
  assert.equal(manualRes.unlocked, true);
  assert.equal(lock.isLocked(), false);
});

test('Roadmap Item #4: @ctxtop/pro offline Ed25519 license verification, tamper rejection, trial, and CLI subcommands', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-pro-test-'));
  try {
    const licensePath = path.join(tmpDir, 'license.json');
    const { publicKeyPem, privateKeyPem } = generateProKeyPair();

    const validKey = signProLicensePayload(
      {
        tier: 'pro',
        email: 'founder@ctxtop.dev',
        seats: 1,
        expiresAt: new Date(Date.now() + 86400 * 1000).toISOString()
      },
      privateKeyPem
    );

    const checkValid = verifyProLicenseKey(validKey, { publicKeyPem });
    assert.equal(checkValid.valid, true);
    assert.equal(checkValid.payload.email, 'founder@ctxtop.dev');

    // Tampered payload must fail Ed25519 signature verification
    const tamperedKey = validKey.slice(0, -4) + 'AAAA';
    const checkTampered = verifyProLicenseKey(tamperedKey, { publicKeyPem });
    assert.equal(checkTampered.valid, false);
    assert.equal(checkTampered.reason, 'INVALID_SIGNATURE');

    // Expired license must fail with LICENSE_EXPIRED
    const expiredKey = signProLicensePayload(
      {
        tier: 'pro',
        email: 'expired@ctxtop.dev',
        expiresAt: new Date(Date.now() - 86400 * 1000).toISOString()
      },
      privateKeyPem
    );
    const checkExpired = verifyProLicenseKey(expiredKey, { publicKeyPem });
    assert.equal(checkExpired.valid, false);
    assert.equal(checkExpired.reason, 'LICENSE_EXPIRED');

    // CLI license activate -> status -> deactivate -> trial
    const actCli = runCli(['license', 'activate', validKey], { licensePath, publicKeyPem });
    assert.equal(actCli.exitCode, 0);
    assert.equal(actCli.data.tier, 'pro');

    const statusCli = runCli(['license', 'status'], { licensePath, publicKeyPem, strict: true });
    assert.equal(statusCli.exitCode, 0);
    assert.equal(statusCli.data.entitled, true);
    assert.equal(statusCli.data.source, 'ed25519_license');

    deactivateProLicense({ licensePath });
    const statusFree = getProEntitlementStatus({ licensePath, publicKeyPem, strict: true });
    assert.equal(statusFree.entitled, false);
    assert.equal(statusFree.tier, 'free');

    const trialRes = activateLocalTrial({ licensePath });
    assert.equal(trialRes.ok, true);
    const statusTrial = getProEntitlementStatus({ licensePath, strict: true });
    assert.equal(statusTrial.entitled, true);
    assert.equal(statusTrial.tier, 'trial');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Roadmap Item #5: Antigravity Advanced View consolidates into 4 .hz-adv-drawer drawers with 1-click Hysteresis Unlock & PDF Receipt button', () => {
  const html = fs.readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8');
  const dom = new JSDOM(html);
  const d = dom.window.document;

  const drawers = d.querySelectorAll('details.hz-adv-drawer');
  assert.equal(drawers.length, 4, 'Advanced View must have exactly 4 top-level .hz-adv-drawer drawers');
  assert.ok(d.getElementById('advAccWindow'));
  assert.ok(d.getElementById('advAccGuards'));
  assert.ok(d.getElementById('advAccRouter'));
  assert.ok(d.getElementById('advAccRules'));
  assert.ok(d.getElementById('advAccGuards').contains(d.getElementById('advAccQuota')));
  assert.ok(d.getElementById('btnUnlockHysteresis'), '1-click Hysteresis Unlock button must exist');
  assert.ok(d.getElementById('btnExportPdfReceipt'), '1-click Export PDF Receipt link must exist');
});

test('Roadmap Item #6 & #7: ctxtop roast / --roast card, cost-radar --share, and zero-dep PDF 1.4 Corporate Expense Receipt with SHA-256 verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-rcpt-roast-'));
  try {
    // Verify pure-V8 SHA-256 matches Node native crypto.createHash('sha256')
    const sample = 'Attention Horizon FinOps Verification Test';
    const expectedSha = crypto.createHash('sha256').update(sample, 'utf8').digest('hex');
    assert.equal(sha256HexPure(sample), expectedSha);

    // Item #6: ctxtop roast --demo & cost-radar --share
    const roastRes = runCli(['roast', '--demo']);
    assert.equal(roastRes.exitCode, 0);
    assert.match(roastRes.output, /ATTENTION HORIZON CONTEXT ROAST/);
    assert.match(roastRes.output, /npx ah-claude --roast/);

    const radarPath = path.join(tmpDir, 'radar.html');
    const radarRes = runCli(['cost-radar', '--demo', '--share', '--out', radarPath]);
    assert.equal(radarRes.exitCode, 0);
    assert.match(radarRes.output, /Share: ⚡ Cost Radar:/);

    // Item #7: ctxtop receipt --pdf --out <file.pdf>
    const pdfPath = path.join(tmpDir, 'expense-receipt.pdf');
    const pdfRes = runCli(['receipt', '--pdf', '--out', pdfPath], { cwd: tmpDir });
    assert.equal(pdfRes.exitCode, 0);
    assert.equal(fs.existsSync(pdfPath), true);
    const pdfRaw = fs.readFileSync(pdfPath, 'utf8');
    assert.ok(pdfRaw.startsWith('%PDF-1.4\n'), 'PDF receipt must start with %PDF-1.4 header');
    assert.ok(pdfRaw.trimEnd().endsWith('%%EOF'), 'PDF receipt must end with %%EOF trailer');
    assert.ok(pdfRaw.includes(pdfRes.data.sha256), 'PDF receipt must embed SHA-256 audit digest');
    assert.equal(pdfRes.data.sha256.length, 64);

    const directRcpt = generateCorporateExpenseReceipt({
      sessionSavedTokens: 85000,
      sessionSavedUSD: 1.42,
      workspace30dSavedTokens: 1240000,
      workspace30dSavedUSD: 24.80
    });
    assert.ok(directRcpt.netRoiMultiplier >= 2.5);
    assert.match(directRcpt.markdown, /Corporate FinOps Expense Receipt/);
    assert.match(directRcpt.html, /<!DOCTYPE html>/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
