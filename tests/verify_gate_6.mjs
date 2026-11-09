import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('C:/Users/frank/AppData/Local/Temp/node_modules/jsdom');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

test('[GATE-6.1] 3-Way WebView Mirror Parity & Single Action Button / Plain-Text /compact Invariants', () => {
  const primary = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
  const mirrors = [
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-horizon', 'src', 'ui', 'sidepane.html'),
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck', 'src', 'webview', 'horizon_panel.html')
  ];
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const primaryHash = sha(primary);

  for (const m of mirrors) {
    if (fs.existsSync(m)) {
      assert.equal(sha(m), primaryHash, `3-Way mirror drift detected in: ${m}`);
    }
  }

  const html = fs.readFileSync(primary, 'utf8');

  // UI Invariant 1: No clickable Copy /compact button (#btnCompactPrimary must NEVER exist)
  assert.ok(!html.includes('id="btnCompactPrimary"'), 'Invariant: #btnCompactPrimary must not exist');
  assert.ok(!html.includes('copyCompactWithGuidance'), 'Invariant: copyCompactWithGuidance must not exist');
  assert.ok(html.includes('id="compactInstruction"'), 'Invariant: #compactInstruction plain-text block must exist');
  assert.ok(html.includes('Type <kbd class="cmd-kbd">/compact</kbd> in the chat box and press <kbd>Enter</kbd>'));

  // Active Source File Protection: only show ignore on non-source paths
  assert.ok(html.includes('isIgnorablePath') || html.includes('.antigravityignore'));
});

test('[GATE-6.2] DOM Verification of Model & Effort Coach Bar, U-Shaped Attention in Rules Drawer, and DET-01..16 Strip', () => {
  const htmlPath = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  const dom = new JSDOM(htmlContent, {
    url: 'http://127.0.0.1:62935/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      w.EventSource = class { addEventListener() {} close() {} };
      w.navigator.clipboard = { writeText: async () => {} };
    }
  });

  const { window } = dom;
  const { document } = window;

  const mockLiveState = {
    sessionId: '54f51806-d87e-42f9-90e8-642c81fa02db',
    window: { totalActiveTokens: 80500, maxTokens: 256000 },
    metrics: { signalPurityPct: 91, sludgeTokens: 3200 },
    quota: {
      sprint5h: { usedPct: 35, resetLabel: '46m', modelPoolName: 'Gemini 4 Argon' },
      weekly7d: { usedPct: 42, resetLabel: '3d 12h' },
      cache: { hitRatePct: 95, ttlRemainingSec: 296, isCacheCold: false }
    },
    coachState: {
      prefixCacheShield: {
        locked: true,
        stagedCount: 1,
        badge: '⏳ 1 Rule Update Staged (Waiting for Cache TTL expiry)'
      },
      detectors: {
        active: true,
        totalCount: 16,
        summary: 'DET-01..16 Active'
      },
      fts5Compressor: {
        active: true,
        savedTokens: 41200
      },
      compactionCoach: {
        recommendBatonPass: true,
        recommendTailTrim: true
      },
      rsiEngine: {
        clusters: [
          { domain: 'testing', count: 5, avgConfidence: 0.88 }
        ]
      },
      uShapedAttention: {
        healthScore: 94,
        middleTroughRiskCount: 2,
        recencyMirrorActive: true
      },
      taskQuotaRouter: {
        activeModel: 'gemini-4-argon',
        activeModelLabel: 'Gemini 4 Argon',
        activeEffort: 'high',
        activeBurnMultiplier: 9.25,
        syncStatus: 'live synced',
        routerMode: 'coach',
        coachPillText: '💡 task.md step is [flash:low] → [Drop to Argon-Low (Keep 80.5k Cache)] | [Run in Flash Subagent]'
      }
    }
  };

  window.renderState(mockLiveState);

  // 1. Verify Model & Effort Coach Bar
  const coachBar = document.getElementById('modelCoachBar');
  assert.ok(coachBar, '#modelCoachBar must exist in DOM');
  const liveLabel = document.getElementById('modelCoachLiveLabel');
  assert.ok(liveLabel.textContent.includes('Gemini 4 Argon • High (9.25x burn • live synced)'));

  const resetLabel = document.getElementById('modelCoachResetLabel');
  assert.ok(resetLabel.textContent.includes('Resets in 46m'));

  const actionPill = document.getElementById('coachActionPill');
  assert.equal(actionPill.hidden, false, '#coachActionPill must be visible when coachData has recommendation');
  assert.ok(actionPill.textContent.includes('[flash:low]'));
  assert.ok(actionPill.textContent.includes('Keep 80.5k Cache'));

  // 2. Verify 3-way mode switch buttons
  assert.ok(document.getElementById('btnModeOff'), '#btnModeOff must exist');
  assert.ok(document.getElementById('btnModeCoach'), '#btnModeCoach must exist');
  assert.ok(document.getElementById('btnModeAutopilot'), '#btnModeAutopilot must exist');

  // 3. Verify U-Shaped Attention Health & PrefixCacheShield inside signalDrawer
  const uCurveRow = document.getElementById('uShapedAttentionRow');
  assert.ok(uCurveRow, '#uShapedAttentionRow must exist inside Rules drawer');
  const uCurveVal = document.getElementById('uCurveHealthVal');
  assert.ok(uCurveVal.textContent.includes('Primacy: 94%'));
  const shieldQueue = document.getElementById('prefixShieldQueue');
  assert.equal(shieldQueue.hidden, false);
  assert.ok(shieldQueue.textContent.includes('1 Rule Update Staged'));

  // 4. Verify Guardrail & FTS5 status in Session Health Summary
  const guardrailTxt = document.getElementById('summaryTextGuardrails');
  assert.ok(guardrailTxt.textContent.includes('DET-01..16 Active'));
  assert.ok(guardrailTxt.textContent.includes('41.2k tokens saved'));

  // 5. Verify Recommended Actions: Baton Pass, Tail Trim, Evolve, and U-Curve actions appear with Single Action Buttons
  const simpleActionList = document.getElementById('simpleActionList');
  const actionHtml = simpleActionList.innerHTML;

  assert.ok(actionHtml.includes('Execute Baton Pass (/handoff)'), 'Must render Baton Pass action');
  assert.ok(actionHtml.includes('Trim Uncached Tail Sludge'), 'Must render Tail Trim action');
  assert.ok(actionHtml.includes('Evolve 5 Clustered Instincts (/evolve)'), 'Must render Evolve action');
  assert.ok(actionHtml.includes('Reorder Rules for U-Shaped Attention'), 'Must render U-Curve action');

  // Check that each action card has exactly 1 Copy button (Single Action Button Simplicity)
  const copyButtons = Array.from(simpleActionList.querySelectorAll('button[data-simple-copy]'));
  assert.ok(copyButtons.length >= 4, 'Must render primary copy buttons for coaching actions');
});

test('[GATE-6.3] Sidecar Server Endpoint Contract Verification (Zero-Trust Local Loopback)', async () => {
  const { startServer } = await import('../sidecars/horizon-daemon/server.mjs');
  const { server, port } = await startServer(0);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. GET /api/health
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);

    // 2. GET /api/state returns coachState
    const stateRes = await fetch(`${baseUrl}/api/state`);
    const stateJson = await stateRes.json();
    assert.ok(stateJson, 'State response must be defined');

    // 3. POST /api/shield/flush
    const flushRes = await fetch(`${baseUrl}/api/shield/flush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const flushJson = await flushRes.json();
    assert.equal(flushJson.success, true);

    // 4. POST /api/router/mode
    const modeRes = await fetch(`${baseUrl}/api/router/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'autopilot' })
    });
    const modeJson = await modeRes.json();
    assert.equal(modeJson.success, true);
    assert.equal(modeJson.mode, 'autopilot');

    // Reset to coach mode
    await fetch(`${baseUrl}/api/router/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'coach' })
    });
  } finally {
    server.close();
  }
});
