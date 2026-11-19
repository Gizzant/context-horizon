import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';

import { computeShadowAutoSummary } from '../src/core-isomorphic/economics/shadowAutoModel.mjs';
import { loadHorizonConfig } from '../src/core/horizon_config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'sidecars', 'horizon-daemon', 'server.mjs');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
const TOKEN = 'free-auto-shadow-test-token';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function api(port, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('Free Auto = shadow preview (daemon routes, real Free entitlement)', () => {
  let child;
  let port;
  let tmpRoot;
  let tmpHome;
  let tmpCwd;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-free-auto-'));
    tmpHome = path.join(tmpRoot, 'home');
    tmpCwd = path.join(tmpRoot, 'ws');
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpCwd, { recursive: true });
    port = await freePort();
    // Strip the test-runner flags so the daemon sees a genuine Free machine (no dev/test Pro bypass).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_ENV;
    delete env.CTXTOP_PRO_DEV;
    Object.assign(env, {
      USERPROFILE: tmpHome,
      HOME: tmpHome,
      ANTIGRAVITY_SIDECAR_UI_TOKEN: TOKEN,
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
      HORIZON_TEST_NO_SPAWN: '1'
    });
    child = spawn(process.execPath, [SERVER], { cwd: tmpCwd, env, stdio: 'ignore' });
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        const r = await api(port, 'GET', '/api/state');
        ready = r.status === 200;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(ready, 'daemon must start for route tests');
  });

  after(() => {
    try { child?.kill(); } catch (err) { void err; }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
  });

  it('selecting Auto on Free stays Auto (shadow), never steps down, never provisions a trial', async () => {
    const r = await api(port, 'POST', '/api/router/mode', { mode: 'autopilot' });
    assert.equal(r.status, 200);
    assert.equal(r.json.routerMode, 'autopilot');
    assert.equal(r.json.mode, 'autopilot');
    assert.equal(r.json.autoShadow, true);
    assert.equal(r.json.autoEnforced, false);
    assert.equal(r.json.enforcedRouterMode, 'coach');
    assert.equal(r.json.steppedDownToCoach, false);
    assert.equal(r.json.reverseTrialStarted, false);
    assert.equal(r.json.requiresPro, true);
    assert.equal(r.json.flightMode, 'AUTO_PILOT');
    assert.equal(
      fs.existsSync(path.join(tmpHome, '.ctxtop', 'license.json')),
      false,
      'selecting Auto must NOT create a trial license'
    );
    assert.equal(loadHorizonConfig({ cwd: tmpCwd, homeDir: tmpHome }).flightMode, 'AUTO_PILOT');
  });

  it('Off and Coach selections are unaffected by the license gate', async () => {
    const coach = await api(port, 'POST', '/api/router/mode', { mode: 'coach' });
    assert.equal(coach.json.routerMode, 'coach');
    assert.equal(coach.json.autoShadow, false);
    assert.equal(coach.json.autoEnforced, false);
    const off = await api(port, 'POST', '/api/router/mode', { mode: 'off' });
    assert.equal(off.json.routerMode, 'off');
    assert.equal(off.json.autoShadow, false);
  });

  it('explicit trial start flips Auto to enforced while the selection stays Auto', async () => {
    const before = await api(port, 'POST', '/api/router/mode', { mode: 'autopilot' });
    assert.equal(before.json.autoShadow, true);
    const act = await api(port, 'POST', '/api/license/activate', { trial: true });
    assert.equal(act.status, 200);
    assert.equal(act.json.success, true);
    const after = await api(port, 'POST', '/api/router/mode', { mode: 'autopilot' });
    assert.equal(after.json.routerMode, 'autopilot');
    assert.equal(after.json.autoShadow, false);
    assert.equal(after.json.autoEnforced, true);
    assert.equal(after.json.enforcedRouterMode, 'autopilot');
    assert.equal(after.json.steppedDownToCoach, false);
  });
});

describe('Shadow Auto summary: recent incidents + preview wording', () => {
  it('exposes newest-first recentIncidents for the session and no longer says Coach is active', () => {
    const now = Date.now();
    const free = { entitled: false, tier: 'free', trialExpired: true };
    const summary = computeShadowAutoSummary(
      [
        { ts: now - 3 * 60000, sessionId: 's1', category: 'COLD_SWARM_WAKEUP', detectorId: 'DET-16', wastedTokens: 150000, missedUsd: 0.65, detail: 'Cold swarm wake-up' },
        { ts: now - 1 * 60000, sessionId: 's1', category: 'PREFIX_MUTATION_BUST', detectorId: 'DET-09', wastedTokens: 60000, missedUsd: 0.25, detail: 'AGENTS.md edit mid-session' },
        { ts: now - 2 * 60000, sessionId: 's2', category: 'WARM_SWITCH_BUST', wastedTokens: 40000, missedUsd: 0.2 }
      ],
      { nowMs: now, sessionId: 's1', proEntitlement: free }
    );
    assert.deepEqual(summary.recentIncidents.map((i) => i.detectorId), ['DET-09', 'DET-16']);
    assert.ok(summary.recentIncidents.every((i) => i.ts <= now));

    const quiet = computeShadowAutoSummary([], { nowMs: now, proEntitlement: free });
    assert.match(quiet.headlineText, /preview/i);
    assert.doesNotMatch(quiet.headlineText + quiet.sublineText, /Coach is active|Watching in Coach/);
    assert.deepEqual(quiet.recentIncidents, []);
  });
});

describe('Panel: Auto selection is sticky and Simple follows the displayed conversation', () => {
  function makeState(sessionId, totalTokens, extra = {}) {
    return {
      schemaVersion: '1.0',
      sessionId,
      sessionTitle: `Title ${sessionId}`,
      window: { totalTokens, ceilingTokens: 256000, safeTokens: 179200, utilizationPct: 25, status: 'OK' },
      breakdown: { SYSTEM_RULES: 8000, MCP_TOOLS: 2000, CACHED_PREFIX: 20000, STALE_CLUTTER: 10000, ACTIVE_WORKING_SET: 24000 },
      quota: { cache: { warm: true, hitRatePct: 82, ttlRemainingSec: 180, ttlTotalSec: 300 } },
      routerMode: 'coach',
      flightMode: 'COACH',
      proEntitlement: { entitled: false, tier: 'free', source: 'free_core' },
      ...extra
    };
  }

  async function openPanel(fetchImpl) {
    const html = fs
      .readFileSync(HTML_PATH, 'utf8')
      .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(String(e?.message || e)));
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = fetchImpl;
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        win.sidecar = { onWorkspaceChange() {} };
      }
    });
    await new Promise((r) => setTimeout(r, 80));
    return { dom, errors };
  }

  it('slider stays on Auto when a stale Coach state arrives mid-flight and after the POST resolves', async () => {
    let releasePost;
    const postGate = new Promise((r) => { releasePost = r; });
    const freeAutoState = makeState('conv-a', 64000, { routerMode: 'autopilot', flightMode: 'AUTO_PILOT', autoShadow: true, autoEnforced: false });
    const { dom, errors } = await openPanel(async (url) => {
      if (String(url).includes('/api/router/mode')) {
        await postGate;
        return { ok: true, status: 200, json: async () => ({ success: true, routerMode: 'autopilot', autoShadow: true, autoEnforced: false, state: freeAutoState }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const d = dom.window.document;
    try {
      dom.window.renderState(makeState('conv-a', 64000));
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'coach');

      d.getElementById('tsModeBtnAuto').click();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'autopilot');

      // Stale broadcast (serialised before the POST persisted) must NOT flip the slider back.
      dom.window.renderState(makeState('conv-a', 64000));
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'autopilot');

      releasePost();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'autopilot');
      assert.equal(d.getElementById('argonSimpleSurface').dataset.enforcement, 'shadow');
      assert.equal(d.getElementById('tsShadowAutoBanner').hidden, false);

      // Later daemon broadcasts that carry the selection keep it on Auto.
      dom.window.renderState(freeAutoState);
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'autopilot');
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });

  it('entitled Auto is enforced (no preview banner / chip) and shows trial days', async () => {
    const { dom, errors } = await openPanel(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    const d = dom.window.document;
    try {
      dom.window.renderState(
        makeState('conv-a', 64000, {
          routerMode: 'autopilot',
          flightMode: 'AUTO_PILOT',
          autoShadow: false,
          autoEnforced: true,
          proEntitlement: { entitled: true, tier: 'trial', daysRemaining: 9 }
        })
      );
      assert.equal(d.getElementById('argonSimpleSurface').dataset.enforcement, 'enforced');
      assert.match(d.getElementById('tsModeHint').textContent, /Trial 9d left/);
      assert.match(d.getElementById('tsGuardsSummary').textContent, /Auto-enforcing/);
      assert.equal(d.getElementById('tsShadowAutoBanner').hidden, true);
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });

  it('free shadow Auto lists "Would have" rows and potential savings, never "Auto-enforcing"', async () => {
    const { dom, errors } = await openPanel(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    const d = dom.window.document;
    try {
      dom.window.renderState(
        makeState('conv-a', 64000, {
          routerMode: 'autopilot',
          flightMode: 'AUTO_PILOT',
          autoShadow: true,
          autoEnforced: false,
          coachState: {
            autoShadow: true,
            autoShadowCorrections: [
              { ts: Date.now() - 120000, category: 'COLD_SWARM_WAKEUP', detectorId: 'DET-16', detail: 'hold the cold swarm wake-up', missedUsd: 0.65, wastedTokens: 150000 }
            ]
          },
          shadowAuto: computeShadowAutoSummary(
            [{ ts: Date.now(), sessionId: 'conv-a', category: 'COLD_SWARM_WAKEUP', wastedTokens: 150000, missedUsd: 0.65 }],
            { proEntitlement: { entitled: false, tier: 'free' } }
          )
        })
      );
      const ledger = d.getElementById('tsLedgerList').textContent;
      assert.match(ledger, /Would have: hold the cold swarm wake-up/);
      assert.match(ledger, /\+150\.0k/);
      assert.match(ledger, /Potential tokens saved/);
      assert.doesNotMatch(ledger, /\$/);
      assert.doesNotMatch(d.getElementById('tsGuardsSummary').textContent, /Auto-enforcing/);
      assert.match(d.getElementById('tsGuardsSummary').textContent, /would have fixed 1/);
      assert.match(d.getElementById('tsModeHint').textContent, /Preview/);
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });

  it('Simple view paints the SELECTED conversation even when a stream state for another one arrives', async () => {
    const stateB = makeState('conv-b', 32000);
    const { dom, errors } = await openPanel(async (url) => {
      if (String(url).includes('conversationId=conv-b')) {
        return { ok: true, status: 200, json: async () => stateB };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const d = dom.window.document;
    try {
      const stateA = makeState('conv-a', 64000);
      dom.window.renderState(stateA);
      const usedBefore = d.getElementById('tsUsedLabel').textContent;

      dom.window.__PRECOMPUTED_SESSIONS__['conv-b'] = stateB;
      const sel = d.getElementById('sessionSelect');
      const opt = d.createElement('option');
      opt.value = 'conv-b';
      opt.textContent = 'conv-b';
      sel.appendChild(opt);
      sel.value = 'conv-b';
      sel.dispatchEvent(new dom.window.Event('change'));
      await new Promise((r) => setTimeout(r, 40));
      const usedB = d.getElementById('tsUsedLabel').textContent;
      assert.notEqual(usedB, usedBefore, 'Simple view must switch to the selected conversation');

      // A live stream payload for the OTHER conversation must not repaint Simple with conversation A.
      dom.window.renderState(stateA);
      assert.equal(d.getElementById('tsUsedLabel').textContent, usedB);
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });
});
