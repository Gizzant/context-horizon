import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateProKeyPair,
  signProLicensePayload,
  activateProLicense,
  activateLocalTrial,
  requireProFeature
} from '../src/core/pro_license.mjs';
import {
  verifyPolarWebhookSignature,
  handlePolarWebhookRequest
} from '../packages/pro/workers/polar_webhook_worker.mjs';
import {
  buildTeamFinopsArtifacts,
  generateTeamFinopsPack
} from '../packages/pro/src/team_finops_pack.mjs';
import { buildOtelMetricRecords } from '../src/core-isomorphic/telemetry/otelExporter.mjs';
import {
  LEAN_PRE_TOOL_HOOK_MATCHER,
  LEAN_POST_TOOL_HOOK_MATCHER
} from '../src/core/layer5_hygiene.mjs';
import {
  installAttentionHorizon,
  LEAN_PRE_TOOL_USE_MATCHER,
  LEAN_POST_TOOL_USE_MATCHER,
  runCli
} from '../bin/ctxtop.mjs';
import { runPreModelSwitchHook } from '../hooks/handlers/pre-model-switch.mjs';

describe('Pre-Launch v4.0 Finishing Pack (Dual-License, Lean Hooks, BYO-Grafana Team Pack, Copy /compact)', () => {
  test('Workstream 1: Commercial Dual-License files, strict Pro/Team entitlement gates, and Polar.sh HMAC webhook signer', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-prelaunch-w1-'));
    try {
      // 1. Verify LICENSE-COMMERCIAL.md & package.json license
      const commLicense = fs.readFileSync(path.resolve('packages/pro/LICENSE-COMMERCIAL.md'), 'utf8');
      assert.match(commLicense, /Commercial Source-Available License/);
      const proPkg = JSON.parse(fs.readFileSync(path.resolve('packages/pro/package.json'), 'utf8'));
      assert.equal(proPkg.license, 'SEE LICENSE IN LICENSE-COMMERCIAL.md');

      // 2. Verify strict unentitled gate blocks PDF receipt & downgrades AUTO_PILOT to COACH
      const licPath = path.join(tmpDir, 'license.json');
      const unentitledCheck = requireProFeature('corporate_expense_receipts', {
        licensePath: licPath,
        strict: true
      });
      assert.equal(unentitledCheck.allowed, false);
      assert.equal(unentitledCheck.tier, 'free');

      const blockedPdfCli = runCli(['receipt', '--pdf'], {
        cwd: tmpDir,
        licensePath: licPath,
        strict: true
      });
      assert.equal(blockedPdfCli.exitCode, 2);
      assert.equal(blockedPdfCli.data.requiresPro, true);

      // Unentitled AUTO_PILOT model switch downgrades to advisory COACH (exitCode 0 instead of 2)
      const switchResFree = runPreModelSwitchHook(
        {
          mode: 'AUTO_PILOT',
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: 80000,
          cache_warm: true
        },
        {
          cwd: tmpDir,
          licensePath: licPath,
          strict: true
        }
      );
      assert.equal(switchResFree.exitCode, 0, 'Unentitled AUTO_PILOT must downgrade to advisory COACH');

      // 3. Activate 14-day local trial -> unlocks both Pro PDF receipt and AUTO_PILOT
      activateLocalTrial({ licensePath: licPath });
      const trialCheck = requireProFeature('corporate_expense_receipts', {
        licensePath: licPath,
        strict: true
      });
      assert.equal(trialCheck.allowed, true);
      assert.equal(trialCheck.tier, 'trial');

      // 4. Verify stateless Polar.sh Webhook HMAC-SHA256 + Ed25519 CTXP1 minting
      const { publicKeyPem, privateKeyPem } = generateProKeyPair();
      const webhookSecret = 'whsec_' + Buffer.from('super-secret-polar-key-32-bytes!').toString('base64');
      const nowMs = Date.now();
      const tsSec = String(Math.floor(nowMs / 1000));
      const webhookId = 'msg_polar_001';
      const rawBody = JSON.stringify({
        type: 'order.created',
        data: {
          id: 'ord_999',
          amount: 29900,
          product: { name: 'Attention Horizon Team (5 Seats)' },
          customer: { email: 'vp-eng@acme.io' }
        }
      });
      const sigB64 = crypto
        .createHmac('sha256', Buffer.from('super-secret-polar-key-32-bytes!'))
        .update(`${webhookId}.${tsSec}.${rawBody}`, 'utf8')
        .digest('base64');

      const webhookRes = handlePolarWebhookRequest(
        {
          rawBody,
          headers: {
            'webhook-id': webhookId,
            'webhook-timestamp': tsSec,
            'webhook-signature': `v1,${sigB64}`
          },
          nowMs
        },
        {
          CTXTOP_POLAR_WEBHOOK_SECRET: webhookSecret,
          CTXTOP_ED25519_PRIVATE_KEY_PEM: privateKeyPem
        }
      );
      assert.equal(webhookRes.status, 200);
      assert.equal(webhookRes.body.ok, true);
      assert.equal(webhookRes.body.tier, 'team');
      assert.equal(webhookRes.body.seats, 5);
      assert.ok(webhookRes.body.licenseKey.startsWith('CTXP1.'));

      // Tampered HMAC must be rejected with 401
      const tamperedRes = handlePolarWebhookRequest(
        {
          rawBody,
          headers: {
            'webhook-id': webhookId,
            'webhook-timestamp': tsSec,
            'webhook-signature': 'v1,aW52YWxpZHNpZ25hdHVyZQ=='
          },
          nowMs
        },
        {
          CTXTOP_POLAR_WEBHOOK_SECRET: webhookSecret,
          CTXTOP_ED25519_PRIVATE_KEY_PEM: privateKeyPem
        }
      );
      assert.equal(tamperedRes.status, 401);

      // Activate minted Team key and verify team_finops_pack entitlement
      const actTeam = activateProLicense(webhookRes.body.licenseKey, {
        licensePath: licPath,
        publicKeyPem
      });
      assert.equal(actTeam.ok, true);
      const teamEnt = requireProFeature('team_finops_pack', {
        licensePath: licPath,
        publicKeyPem,
        strict: true
      });
      assert.equal(teamEnt.allowed, true);
      assert.equal(teamEnt.tier, 'team');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Workstream 2 & 3: Asymmetric Default Lean Hooks + Item #8 BYO-Grafana Team FinOps Pack + 1-Click Copy /compact button', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-prelaunch-w23-'));
    try {
      // 1. Antigravity asymmetric lean matchers preserve read_file in PreToolUse (for DET-02 .env) and strip it from PostToolUse
      assert.match(LEAN_PRE_TOOL_HOOK_MATCHER, /\bread_file\b/);
      assert.doesNotMatch(LEAN_PRE_TOOL_HOOK_MATCHER, /\bgrep_search\b/);
      assert.doesNotMatch(LEAN_POST_TOOL_HOOK_MATCHER, /\bread_file\b|\bgrep_search\b/);

      // 2. Claude Code installAttentionHorizon defaults to lean hooks out-of-the-box
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      const inst = installAttentionHorizon({ cwd: tmpDir, settingsPath });
      assert.equal(inst.ok, true);
      const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(savedSettings.hooks.PreToolUse[0].matcher, LEAN_PRE_TOOL_USE_MATCHER);
      assert.equal(savedSettings.hooks.PostToolUse[0].matcher, LEAN_POST_TOOL_USE_MATCHER);

      // 3. OTel exporter emits attention_horizon.saved_quota.usd & intervention.count
      const otelRecords = buildOtelMetricRecords({
        sessionId: 'sess-otel-1',
        modelId: 'claude-opus-5-5',
        savedQuotaUSD: 14.5,
        interventionCount: 3
      });
      assert.ok(otelRecords.some((r) => r.metricName === 'attention_horizon.saved_quota.usd' && r.value === 14.5));
      assert.ok(otelRecords.some((r) => r.metricName === 'attention_horizon.intervention.count' && r.value === 3));

      // 4. Generate BYO-Grafana Team FinOps Pack via CLI
      const packDir = path.join(tmpDir, 'team-pack-out');
      const cliPack = runCli(['team-pack', '--out', packDir, '--org', 'Acme Corp', '--json'], {
        cwd: tmpDir
      });
      assert.equal(cliPack.exitCode, 0);
      assert.equal(fs.existsSync(path.join(packDir, 'grafana-dashboard.json')), true);
      assert.equal(fs.existsSync(path.join(packDir, 'datadog-dashboard.json')), true);
      assert.equal(fs.existsSync(path.join(packDir, '.attention-horizon.json')), true);
      assert.equal(fs.existsSync(path.join(packDir, 'otel-collector-config.yaml')), true);

      const grafana = JSON.parse(fs.readFileSync(path.join(packDir, 'grafana-dashboard.json'), 'utf8'));
      assert.match(grafana.title, /Acme Corp/);
      assert.equal(grafana.panels.length, 4);

      // 5. Verify 1-click Copy /compact button (#btnCompactPrimary & #btnCopyParameterizedCompact) in horizon_panel.html
      const html = fs.readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8');
      assert.match(html, /id="btnCompactPrimary"/);
      assert.match(html, /id="btnCopyParameterizedCompact"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
