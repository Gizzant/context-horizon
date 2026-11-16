import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';

import { syncPromotedDualHooks } from '../src/core/rsl_ledger.mjs';
import {
  generateProKeyPair,
  signProLicensePayload,
  activateProLicense,
  activateLocalTrial,
  getProEntitlementStatus,
  ensureReverseTrialProvisioned,
  resolveEffectiveAutoFlightMode
} from '../src/core/pro_license.mjs';
import {
  computeShadowAutoSummary,
  estimateShadowIncidentImpact
} from '../src/core-isomorphic/economics/shadowAutoModel.mjs';
import {
  recordShadowAutoMiss,
  readShadowAutoEntries,
  getShadowAutoSummary
} from '../src/core/shadow_auto_ledger.mjs';
import { runPreModelSwitchHook } from '../hooks/handlers/pre-model-switch.mjs';
import { runPostModelSwitchHook } from '../hooks/handlers/post-model-switch.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { handlePreToolUse, handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { runCli } from '../bin/ctxtop.mjs';
import { installPlugin } from '../src/cli/init.mjs';

function makeTmpDir(prefix = 'ctxtop-optA-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    assert.ok(err instanceof Error);
  }
}

describe('Option A (14-Day Reverse Trial -> Shadow Auto) & RSL Hook Path Fix', () => {
  test('1. syncPromotedDualHooks emits unquoted .agents-relative command that executes cleanly', () => {
    const ws = makeTmpDir('ctxtop-rsl-hookcmd-');
    try {
      const pkgRoot = path.join(ws, '.agents', 'plugins', 'agy-horizon-flightcheck');
      const hookDest = path.join(pkgRoot, 'src', 'hooks', 'antigravity_rsl_hook.mjs');
      fs.mkdirSync(path.dirname(hookDest), { recursive: true });
      fs.writeFileSync(
        hookDest,
        'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("{}"); });\n',
        'utf8'
      );

      const ledger = {
        items: {
          'test-guard': {
            status: 'active',
            promotedHook: true,
            toolMatcher: 'read_file|edit_file',
            claudeToolMatcher: 'Edit|Write'
          }
        }
      };

      const res = syncPromotedDualHooks(ws, ledger, { pkgRoot });
      const agDoc = JSON.parse(fs.readFileSync(res.agHooksPath, 'utf8'));
      const cmd = agDoc['ctxtop-rsl-guards']?.PreToolUse?.[0]?.hooks?.[0]?.command || '';
      assert.equal(
        cmd,
        'node plugins/agy-horizon-flightcheck/src/hooks/antigravity_rsl_hook.mjs --event=PreToolUse'
      );
      assert.equal(cmd.includes('"'), false, 'Relative path without spaces must not be quoted');

      const [bin, ...args] = cmd.split(' ');
      const stdout = execFileSync(bin === 'node' ? process.execPath : bin, args, {
        cwd: path.join(ws, '.agents'),
        input: '{}',
        encoding: 'utf8'
      });
      assert.equal(stdout.trim(), '{}');

      const ccDoc = JSON.parse(fs.readFileSync(res.ccSettingsPath, 'utf8'));
      const ccCmd = ccDoc.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command || '';
      assert.equal(ccCmd.includes('claude_rsl_hook.mjs --event=PreToolUse'), true);
    } finally {
      cleanupDir(ws);
    }
  });

  test('2. Option A Reverse Trial grants 14d Auto once, expires cleanly at +15d, steps down both harnesses, and re-unlocks with CTXP1 key', () => {
    const ws = makeTmpDir('ctxtop-trial-life-');
    const homeDir = makeTmpDir('ctxtop-trial-home-');
    try {
      const licPath = path.join(homeDir, '.ctxtop', 'license.json');
      const shadowPath = path.join(homeDir, '.ctxtop', 'shadow_auto_ledger.jsonl');
      const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);
      const t15 = t0 + 15 * 86400 * 1000;

      // Clean install provisions reverse trial automatically when requested
      const inst = installPlugin({
        dryRun: false,
        workspace: true,
        cwd: ws,
        homeDir,
        licensePath: licPath,
        nowMs: t0,
        provisionReverseTrial: true
      });
      assert.equal(inst.success, true);

      const statusActive = getProEntitlementStatus({ licensePath: licPath, nowMs: t0, strict: true });
      assert.equal(statusActive.entitled, true);
      assert.equal(statusActive.tier, 'trial');

      // Second provision attempt is idempotent
      const secondProv = ensureReverseTrialProvisioned({ licensePath: licPath, nowMs: t0, strict: true });
      assert.equal(secondProv.ok, true);
      assert.equal(secondProv.provisioned, false);

      // Active trial unlocks AUTO_PILOT on Claude Code PreModelSwitch
      const ccAutoRes = runPreModelSwitchHook(
        {
          mode: 'AUTO_PILOT',
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: 90000,
          cache_warm: true
        },
        { cwd: ws, licensePath: licPath, nowMs: t0, strict: true }
      );
      assert.equal(ccAutoRes.exitCode, 2, 'Active Reverse Trial must enforce AUTO_PILOT warm hold');

      // Active trial unlocks AUTO_PILOT on Antigravity PreToolUse (cold wake gate)
      const agAutoRes = resolveEffectiveAutoFlightMode('AUTO_PILOT', {
        licensePath: licPath,
        nowMs: t0,
        strict: true
      });
      assert.equal(agAutoRes.effectiveFlightMode, 'AUTO_PILOT');
      assert.equal(agAutoRes.steppedDown, false);

      // Day 15: Trial expires -> entitled:false, trialExpired:true, cannot reset trial
      const statusExp = getProEntitlementStatus({ licensePath: licPath, nowMs: t15, strict: true });
      assert.equal(statusExp.entitled, false);
      assert.equal(statusExp.tier, 'free');
      assert.equal(statusExp.source, 'expired_trial');
      assert.equal(statusExp.trialExpired, true);

      const retryTrial = activateLocalTrial({ licensePath: licPath, nowMs: t15 });
      assert.equal(retryTrial.ok, false);
      assert.equal(retryTrial.reason, 'TRIAL_ALREADY_EXPIRED');

      const ensureExp = ensureReverseTrialProvisioned({ licensePath: licPath, nowMs: t15, strict: true });
      assert.equal(ensureExp.ok, false);
      assert.equal(ensureExp.steppedDownToCoach, true);
      assert.equal(ensureExp.reason, 'TRIAL_ALREADY_EXPIRED'.replace('ALREADY_', ''));

      // Expired trial steps down AUTO_PILOT -> COACH on Claude Code
      const ccStepDown = runPreModelSwitchHook(
        {
          mode: 'AUTO_PILOT',
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: 90000,
          cache_warm: true
        },
        {
          cwd: ws,
          licensePath: licPath,
          shadowLedgerPath: shadowPath,
          nowMs: t15,
          strict: true
        }
      );
      assert.equal(ccStepDown.exitCode, 0, 'Expired trial must downgrade AUTO_PILOT to COACH');

      // Expired trial steps down AUTO_PILOT -> COACH on Antigravity PreInvocation / PreToolUse
      const agStepDown = resolveEffectiveAutoFlightMode('AUTO_PILOT', {
        licensePath: licPath,
        nowMs: t15,
        strict: true
      });
      assert.equal(agStepDown.effectiveFlightMode, 'COACH');
      assert.equal(agStepDown.steppedDown, true);

      // Paid CTXP1 activation unlocks AUTO_PILOT again
      const { publicKeyPem, privateKeyPem } = generateProKeyPair();
      const key = signProLicensePayload({ tier: 'pro', email: 'dev@highbeam.dev' }, privateKeyPem);
      const actPaid = activateProLicense(key, { licensePath: licPath, publicKeyPem, nowMs: t15 });
      assert.equal(actPaid.ok, true);

      const ccUnlocked = runPreModelSwitchHook(
        {
          mode: 'AUTO_PILOT',
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: 90000,
          cache_warm: true
        },
        { cwd: ws, licensePath: licPath, publicKeyPem, nowMs: t15, strict: true }
      );
      assert.equal(ccUnlocked.exitCode, 2, 'Verified Pro key restores AUTO_PILOT hold');

      const cliTrialFail = runCli(['license', 'trial'], {
        licensePath: licPath,
        publicKeyPem,
        nowMs: t15
      });
      assert.equal(cliTrialFail.exitCode, 0);
      assert.equal(cliTrialFail.data.alreadyLicensed, true);
    } finally {
      cleanupDir(ws);
      cleanupDir(homeDir);
    }
  });

  test('3. Shadow Auto verified post-event logging, zero LLM upsell pollution, and Reverse-ROI thresholds', async () => {
    const ws = makeTmpDir('ctxtop-shadow-ws-');
    const homeDir = makeTmpDir('ctxtop-shadow-home-');
    try {
      const shadowPath = path.join(homeDir, '.ctxtop', 'shadow_auto_ledger.jsonl');
      const breakerPath = path.join(homeDir, '.ctxtop', 'breaker.json');
      const licPath = path.join(homeDir, '.ctxtop', 'license.json');
      const nowMs = Date.UTC(2026, 10, 10, 10, 0, 0);

      // a) PreModelSwitch WITHOUT PostModelSwitch records 0 shadow entries
      const preOnly = runPreModelSwitchHook(
        {
          session_id: 'sess-unswitched',
          cwd: ws,
          mode: 'COACH',
          current_model: 'claude-opus-5-5',
          target_model: 'claude-sonnet-5-5',
          cached_tokens: 80000,
          cache_warm: true
        },
        {
          cwd: ws,
          breakerStatePath: breakerPath,
          shadowLedgerPath: shadowPath,
          nowMs,
          persistState: true
        }
      );
      assert.equal(preOnly.exitCode, 0);
      assert.equal(
        /upgrade|trial|CTXP1|Shadow Auto/i.test(preOnly.stdout + preOnly.stderr),
        false,
        'Hook LLM output must NEVER include upsell copy'
      );
      assert.equal(readShadowAutoEntries({ shadowLedgerPath: shadowPath }).length, 0);

      // b) PostModelSwitch commits the verified post-event miss with zero stdout/stderr
      const postSwitch = runPostModelSwitchHook(
        {
          session_id: 'sess-unswitched',
          cwd: ws,
          shadowLedgerPath: shadowPath
        },
        {
          cwd: ws,
          breakerStatePath: breakerPath,
          shadowLedgerPath: shadowPath,
          persistState: true
        }
      );
      assert.equal(postSwitch.exitCode, 0);
      assert.equal(postSwitch.stdout, '');
      assert.equal(postSwitch.stderr, '');
      assert.equal(fs.existsSync(path.join(ws, '.claude', 'cache', 'shadow_auto_ledger.jsonl')), false);

      const entries = readShadowAutoEntries({ shadowLedgerPath: shadowPath });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].category, 'WARM_SWITCH_BUST');
      assert.equal(entries[0].detectorId, 'DET-08');

      // c) PreToolUse DET-09 in OFF/COACH silently logs PREFIX_MUTATION_BUST with zero upsell in stdout
      const preToolCoach = runPreToolUseHook(
        {
          session_id: 'sess-det09',
          cwd: ws,
          mode: 'COACH',
          tool_name: 'Edit',
          tool_input: { file_path: path.join(ws, 'CLAUDE.md'), new_string: '# updated' },
          cached_tokens: 60000,
          cache_warm: true,
          cache_ttl_seconds: 240,
          turn_id: 't-det09'
        },
        {
          cwd: ws,
          breakerStatePath: breakerPath,
          shadowLedgerPath: shadowPath,
          nowMs: nowMs + 120000
        }
      );
      assert.equal(/upgrade|trial|CTXP1/i.test(preToolCoach.stdout + preToolCoach.stderr), false);

      // d) Antigravity PreToolUse DET-16 / DET-09 in COACH records silently
      await handlePreToolUse({
        hook_event_name: 'PreToolUse',
        conversationId: 'ag-shadow-1',
        workspacePath: ws,
        cwd: ws,
        flightMode: 'COACH',
        toolName: 'edit_file',
        toolInput: { Path: path.join(ws, 'AGENTS.md'), Replacement: '# rule' },
        cachedTokens: 65000,
        cacheTtlSeconds: 200,
        shadowLedgerPath: shadowPath,
        nowMs: nowMs + 240000
      });

      const afterAg = readShadowAutoEntries({ shadowLedgerPath: shadowPath });
      assert.ok(afterAg.length >= 2);

      // e) Reverse-ROI Guard: < $12.42 total and max < $0.50 MUST hide small dollar amounts
      const smallSummary = computeShadowAutoSummary(
        [
          { ts: nowMs, category: 'WARM_SWITCH_BUST', wastedTokens: 60000, missedUsd: 0.42 },
          { ts: nowMs - 1000, category: 'PREFIX_MUTATION_BUST', wastedTokens: 50000, missedUsd: 0.28 },
          { ts: nowMs - 2000, category: 'RUNAWAY_LOOP_TURN', wastedTokens: 40000, missedUsd: 0.35 }
        ],
        {
          nowMs,
          proEntitlement: { entitled: false, tier: 'free', trialExpired: false }
        }
      );
      assert.equal(smallSummary.displayMode, 'shadow_incidents_only');
      assert.equal(smallSummary.exceedsBreakEvenThreshold, false);
      assert.equal(/\$/.test(`${smallSummary.headlineText} ${smallSummary.sublineText}`), false);
      assert.match(smallSummary.headlineText, /3 cache or loop incidents/);
      assert.match(smallSummary.sublineText, /frontier quota turns/);

      // f) High-impact single incident >= $0.50 flips to shadow_roi_proven
      const highImpactSummary = computeShadowAutoSummary(
        [{ ts: nowMs, category: 'COLD_SWARM_WAKEUP', wastedTokens: 150000, missedUsd: 0.65 }],
        {
          nowMs,
          proEntitlement: { entitled: false, tier: 'free', trialExpired: true }
        }
      );
      assert.equal(highImpactSummary.displayMode, 'shadow_roi_proven');
      assert.equal(highImpactSummary.exceedsBreakEvenThreshold, true);
      assert.equal(highImpactSummary.ctaMode, 'upgrade_pro');
      assert.match(highImpactSummary.headlineText, /\$0\.65/);
      assert.match(highImpactSummary.sublineText, /frontier quota turns/);

      // g) Break-even 30d total >= $12.42 flips to shadow_roi_proven
      const breakEvenSummary = computeShadowAutoSummary(
        Array.from({ length: 40 }, (_, i) => ({
          ts: nowMs - i * 3600000,
          category: 'RUNAWAY_LOOP_TURN',
          wastedTokens: 50000,
          missedUsd: 0.42
        })),
        {
          nowMs,
          proEntitlement: { entitled: false, tier: 'free', trialExpired: true }
        }
      );
      assert.equal(breakEvenSummary.displayMode, 'shadow_roi_proven');
      assert.match(breakEvenSummary.headlineText, /\$16\.80/);

      // h) CLI license status exposes shadowAuto summary safely
      const statusCli = runCli(['license', 'status', '--cwd', ws, '--json'], {
        cwd: ws,
        licensePath: licPath,
        shadowLedgerPath: shadowPath,
        strict: true
      });
      assert.equal(statusCli.exitCode, 0);
      assert.ok(statusCli.data.shadowAuto);
      assert.equal(estimateShadowIncidentImpact({ wastedTokens: 90000 }).wastedFrontierTurns, 2);
      assert.ok(getShadowAutoSummary({ shadowLedgerPath: shadowPath }).incidentCount30d >= 2);
    } finally {
      cleanupDir(ws);
      cleanupDir(homeDir);
    }
  });

  test('4. Antigravity & Claude Code HUDs render Shadow Auto & expired-trial lock cleanly (UX-4 safe)', async () => {
    const html = fs
      .readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8')
      .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const jsdomErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        win.sidecar = { onWorkspaceChange() {} };
      }
    });
    await new Promise((r) => setTimeout(r, 80));
    const d = dom.window.document;
    try {
      const expState = {
        schemaVersion: '1.0',
        sessionId: 'exp-trial-1',
        window: { totalTokens: 64000, ceilingTokens: 256000, safeTokens: 179200, utilizationPct: 25, status: 'OK' },
        breakdown: {
          SYSTEM_RULES: 8000,
          MCP_TOOLS: 2000,
          CACHED_PREFIX: 20000,
          STALE_CLUTTER: 10000,
          ACTIVE_WORKING_SET: 24000
        },
        quota: { cache: { warm: true, hitRatePct: 82, ttlRemainingSec: 180, ttlTotalSec: 300 } },
        routerMode: 'coach',
        flightMode: 'COACH',
        proEntitlement: { entitled: false, tier: 'free', source: 'expired_trial', trialExpired: true },
        shadowAuto: computeShadowAutoSummary(
          [{ ts: Date.now(), category: 'COLD_SWARM_WAKEUP', wastedTokens: 150000, missedUsd: 0.65 }],
          { proEntitlement: { entitled: false, tier: 'free', trialExpired: true } }
        )
      };

      dom.window.renderState(expState);
      assert.equal(d.getElementById('tsShadowAutoRow').hidden, false);
      assert.match(d.getElementById('tsShadowAutoMeta').textContent, /\$0\.65/);

      d.getElementById('tsModeBtnAuto').click();
      await new Promise((r) => setTimeout(r, 20));
      // Selection is never stepped down to Coach: unentitled Auto stays on Auto in shadow (preview) mode.
      assert.equal(d.getElementById('argonSimpleSurface').dataset.protectionMode, 'autopilot');
      assert.equal(d.getElementById('argonSimpleSurface').dataset.enforcement, 'shadow');
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'autopilot');
      assert.match(d.getElementById('tsModeHint').textContent, /Preview/);
      assert.doesNotMatch(d.getElementById('tsGuardsSummary').textContent, /Auto-enforcing/);
      assert.match(d.getElementById('tsGuardsSummary').textContent, /Auto preview/);
      assert.equal(d.getElementById('tsShadowAutoBanner').hidden, false);
      assert.equal(d.getElementById('tsShadowBtnTrial').hidden, true);
      assert.match(d.getElementById('tsShadowAutoHeadline').textContent, /\$0\.65/);
      assert.deepEqual(jsdomErrors, []);

      // Verify Claude Code 4-Card Glass HUD renders Shadow Auto row without UX-4 leaks
      const ccExpired = renderHorizonPanelHtml(
        {
          sessionId: 'cc-exp-1',
          modelId: 'claude-sonnet-5-5',
          flightMode: 'COACH',
          totalInputTokens: 64000,
          cachedTokens: 32000,
          proEntitlement: expState.proEntitlement,
          shadowAuto: expState.shadowAuto
        },
        {}
      );
      const ccDom = new JSDOM(ccExpired.html);
      const shadowEl = ccDom.window.document.getElementById('claudeShadowAutoRow');
      assert.ok(shadowEl, 'Claude HUD must render #claudeShadowAutoRow when unentitled & incidents > 0');
      assert.match(shadowEl.textContent, /\$0\.65/);
      assert.match(shadowEl.textContent, /npx ctxtop license activate/);
      const visibleSimpleText =
        ccDom.window.document.getElementById('simpleViewContainer')?.textContent || '';
      assert.equal(
        /\b(DET-\d+|parabolic|primacy|trough|hysteresis|FTS5)\b|C\*/i.test(shadowEl.textContent),
        false,
        'Shadow Auto copy must obey UX-4 plain-English discipline'
      );
      assert.equal(/Antigravity|GEMINI\.md|AGENTS\.md/i.test(visibleSimpleText), false);

      // Verify active trial badge on Claude HUD
      const ccTrial = renderHorizonPanelHtml(
        {
          sessionId: 'cc-trial-1',
          modelId: 'claude-sonnet-5-5',
          flightMode: 'AUTO_PILOT',
          totalInputTokens: 30000,
          cachedTokens: 15000,
          proEntitlement: { entitled: true, tier: 'trial', source: 'local_trial', daysRemaining: 11 }
        },
        {}
      );
      const ccTrialDom = new JSDOM(ccTrial.html);
      assert.match(ccTrialDom.window.document.getElementById('flightModeBadge').textContent, /Auto \(Trial .* 11d\)/);
    } finally {
      dom.window.close();
    }
  });
});
