import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';

import { findSessionDirectory } from '../src/core/parser.mjs';
import { getDatabaseSyncClass } from '../src/engine-node/db/probe.mjs';
import { runCLI } from '../src/cli/horizon_hud.mjs';
import { installPlugin } from '../src/cli/init.mjs';
import { runStopGateHook } from '../hooks/handlers/stop-gate.mjs';
import { readBreakerStateSnapshot } from '../src/core-isomorphic/guards/circuitBreakers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'sidecars', 'horizon-daemon', 'server.mjs');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
const TOKEN = 'pre-push-bug-sweep-token';

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
  let json = {};
  try {
    json = await res.json();
  } catch (err) {
    void err;
  }
  return { status: res.status, json };
}

function makePanelState(sessionId, totalTokens = 64000, extra = {}) {
  return {
    sessionId,
    sessionTitle: `Session ${sessionId}`,
    workspaceName: 'demo-ws',
    storeSource: 'antigravity',
    surfaceTag: '[AG]',
    window: {
      totalTokens,
      totalActiveTokens: totalTokens,
      safeLimit: 179000,
      maxTokens: 256000,
      activeModelLabel: 'Claude Opus 4.6 (Medium)'
    },
    model: {
      id: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6 (Medium)',
      rawLabel: 'Claude Opus 4.6 (Medium)'
    },
    breakdown: {
      systemRules: 0,
      toolDefinitions: 0,
      activeCodeAndRules: totalTokens,
      reclaimableClutter: 12000
    },
    brainSignals: {
      duplicateReads: { fileCount: 0, reclaimableTokens: 0, topFiles: [] },
      deadErrors: { errorCount: 0, isErrorLoop: false, reclaimableTokens: 0 },
      oldHistory: { turnCount: 4, reclaimableTokens: 12000 },
      foreignBleed: { reclaimableTokens: 0 }
    },
    quota: {
      cache: {
        state: 'COLD',
        ttlRemainingSec: 0,
        hitRatePct: 0,
        isCacheCold: true
      }
    },
    routerMode: 'coach',
    flightMode: 'COACH',
    proEntitlement: { entitled: false, tier: 'free', source: 'free_core' },
    recentSessions: [
      { sessionId: 'conv-a', title: 'Conv A', stepCount: 6, liveTokens: 64000, surface: 'antigravity', surfaceTag: '[AG]' }
    ],
    ...extra
  };
}

async function openPanel(fetchImpl, url = 'http://127.0.0.1:43210/', sidecarExtras = {}) {
  const html = fs
    .readFileSync(HTML_PATH, 'utf8')
    .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const errors = [];
  const esUrls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e?.message || e)));
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.EventSource = class {
        constructor(streamUrl) {
          this.url = streamUrl;
          esUrls.push(streamUrl);
        }
        close() {}
      };
      win.fetch = fetchImpl;
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      win.sidecar = { onWorkspaceChange() {}, ...sidecarExtras };
      if (!win.URL.createObjectURL) win.URL.createObjectURL = () => 'blob:mock-pdf';
      if (!win.URL.revokeObjectURL) win.URL.revokeObjectURL = () => {};
    }
  });
  await new Promise((r) => setTimeout(r, 80));
  return { dom, errors, esUrls };
}

describe('Pre-push 13-bug sweep regressions', () => {
  let child;
  let port;
  let tmpRoot;
  let tmpHome;
  let tmpCwd;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-bug-sweep-'));
    tmpHome = path.join(tmpRoot, 'home');
    tmpCwd = path.join(tmpRoot, 'ws');
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpCwd, { recursive: true });
    port = await freePort();

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
      } catch (err) {
        void err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(ready, 'daemon must start for route regression checks');
  });

  after(() => {
    try { child?.kill(); } catch (err) { void err; }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
  });

  it('BUG-01 & BUG-04 (UI): conversation bar & toasts live outside legacyCompatSurface, pin/sync works, SSE reconnects, stale frames ignored', async () => {
    const stateA = makePanelState('conv-a', 64000);
    const stateB = makePanelState('conv-b', 32000, { sessionTitle: 'Second Chat', isEmptySession: false });
    const stateC = makePanelState('conv-c', 12000, { sessionTitle: 'Third Chat' });
    const { dom, errors, esUrls } = await openPanel(async (url) => {
      const u = String(url);
      if (u.includes('conversationId=conv-b')) return { ok: true, status: 200, json: async () => stateB };
      if (u.includes('conversationId=conv-c')) return { ok: true, status: 200, json: async () => stateC };
      if (u.includes('/api/router/mode')) return { ok: true, status: 200, json: async () => ({ success: true, autoShadow: false }) };
      return { ok: true, status: 200, json: async () => stateA };
    });
    const d = dom.window.document;
    try {
      const toastEl = d.getElementById('feedbackToast');
      const watchdogEl = d.getElementById('hostWatchdogBar');
      const convBar = d.getElementById('tsConversationBar');
      const tsSel = d.getElementById('tsSessionSelect');
      assert.ok(toastEl && toastEl.closest('#legacyCompatSurface') === null, 'feedbackToast must not sit inside opacity:0 legacyCompatSurface');
      assert.ok(watchdogEl && watchdogEl.closest('#legacyCompatSurface') === null, 'hostWatchdogBar must not sit inside opacity:0 legacyCompatSurface');
      assert.ok(convBar && tsSel && tsSel.closest('#legacyCompatSurface') === null, 'tsConversationBar must sit in visible surface');

      dom.window.renderState(stateA);
      // Pin to conv-b even though recentSessions only lists conv-a (like newly opened chat or fixture)
      const optB = d.createElement('option');
      optB.value = 'conv-b';
      optB.textContent = 'conv-b';
      tsSel.appendChild(optB);
      tsSel.value = 'conv-b';
      tsSel.dispatchEvent(new dom.window.Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(tsSel.value, 'conv-b', 'tsSessionSelect must keep pinned session even if missing from recentSessions');
      assert.equal(d.getElementById('sessionSelect').value, 'conv-b');
      assert.equal(d.getElementById('tsBtnFollowActive').hidden, false);
      assert.equal(d.getElementById('tsUsedLabel').textContent, '32.0k');
      assert.ok(esUrls.some((u) => u.includes('/api/stream?conversationId=conv-b')), 'must reconnect EventSource to pinned conversation');

      // Incoming SSE frame from conv-a must NOT overwrite pinned conv-b
      dom.window.renderState(stateA);
      assert.equal(d.getElementById('tsUsedLabel').textContent, '32.0k');
      assert.equal(tsSel.value, 'conv-b');

      // IDE postMessage conversation-change switches pinned selection too
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'conversation-change', conversationId: 'conv-c' } }));
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(d.getElementById('tsUsedLabel').textContent, '12.0k');
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });

  it('BUG-05, BUG-06 & BUG-07 (UI): Trial/Pro Auto click never throws ReferenceError, Advanced switch handles shadow preview, and drawer says preview/advises', async () => {
    const freeAuto = makePanelState('conv-free', 48000, {
      routerMode: 'autopilot',
      flightMode: 'AUTO_PILOT',
      autoShadow: true,
      autoEnforced: false,
      proEntitlement: { entitled: false, tier: 'free' },
      coachState: {
        detectors: {
          totalCount: 20,
          armedCount: 20,
          list: [
            { id: 'DET-01', name: 'Read Limit Guard', mode: 'guard', tripped: false },
            { id: 'DET-30', name: 'Thinking Drift Advisory', mode: 'advisory', tripped: false }
          ]
        }
      }
    });
    const trialAuto = makePanelState('conv-trial', 48000, {
      routerMode: 'autopilot',
      flightMode: 'AUTO_PILOT',
      autoShadow: false,
      autoEnforced: true,
      proEntitlement: { entitled: true, tier: 'trial', daysRemaining: 14 }
    });

    let respondShadow = true;
    const { dom, errors } = await openPanel(async (url) => {
      const u = String(url);
      if (u.includes('/api/router/mode')) {
        return {
          ok: true,
          status: 200,
          json: async () => (respondShadow
            ? { success: true, routerMode: 'autopilot', autoShadow: true, autoEnforced: false, state: freeAuto }
            : { success: true, routerMode: 'autopilot', autoShadow: false, autoEnforced: true, state: trialAuto })
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const d = dom.window.document;
    try {
      // BUG-06: Advanced View Auto-Pilot switch on Free opens shadow banner & syncs Simple slider
      dom.window.renderState(makePanelState('conv-free', 48000));
      const advAutoBtn = d.querySelector('#taRouterSwitch button[data-ta-mode="autopilot"]');
      assert.ok(advAutoBtn);
      advAutoBtn.click();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(d.getElementById('tsShadowAutoBanner').hidden, false);
      assert.equal(d.getElementById('tsModeSlider').dataset.activeMode, 'autopilot');

      // BUG-07: Activity drawer in Free Shadow Auto shows "preview" / "advises", NOT "enforcing" / "enforces"
      const rosterHint = d.getElementById('tsGuardRosterHint').textContent;
      const headTxt = d.getElementById('tsGuardListHead').textContent;
      const listHtml = d.getElementById('tsGuardList').innerHTML;
      assert.match(headTxt, /Auto preview guards/);
      assert.match(rosterHint, /preview/);
      assert.doesNotMatch(rosterHint, /enforcing/);
      assert.match(listHtml, /advises/);
      assert.doesNotMatch(listHtml, />enforces</);

      // BUG-05: Trial/Pro Auto click where modeResp.autoShadow === false must NOT throw ReferenceError: banner is not defined
      respondShadow = false;
      d.getElementById('tsShadowAutoBanner').hidden = false;
      d.getElementById('tsModeBtnAuto').click();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(d.getElementById('tsShadowAutoBanner').hidden, true);
      assert.equal(d.getElementById('feedbackToast').style.display, 'block');
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });

  it('BUG-10, BUG-12 & BUG-13 (UI): Smart Compact suggestion surfaces, action buttons work honestly, and no fabricated host/quota numbers appear', async () => {
    const called = [];
    const { dom, errors } = await openPanel(async (url, init) => {
      const u = String(url);
      called.push({ url: u, method: init?.method || 'GET', body: init?.body });
      if (u.includes('/api/receipt/export?format=pdf')) {
        return { ok: false, status: 402, json: async () => ({ error: 'PRO_REQUIRED' }) };
      }
      if (u.includes('/api/ignore')) {
        return { ok: false, status: 400, json: async () => ({ success: false, error: 'Active source code files cannot be added' }) };
      }
      if (u.includes('/api/shield/flush')) {
        return { ok: true, status: 200, json: async () => ({ success: true, deferred: false }) };
      }
      if (u.includes('/api/force-prune')) {
        return { ok: true, status: 200, json: async () => ({ success: true, savedTokens: 4500, hostTranscriptMutated: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const d = dom.window.document;
    try {
      // BUG-12 + BUG-13 on clean 0-token state with H7 smartCompactSuggestion
      const zeroState = makePanelState('conv-zero', 0, {
        window: { totalTokens: 0, totalActiveTokens: 0, safeLimit: 179000, maxTokens: 256000 },
        model: { id: 'auto', displayName: 'Auto', rawLabel: 'Auto' },
        activeEffortProfile: { label: 'Auto' },
        prefixShield: { queuedCount: 2 },
        coachState: {
          smartCompactSuggestion: {
            shouldSuggest: true,
            estimatedNetSavingsUsd: 0.42,
            horizonTurns: 6,
            reclaimableTokens: 12000
          },
          detectors: { totalCount: 20, armedCount: 20 }
        },
        topConsumers: [
          { kind: 'file', path: 'package-lock.json', pattern: '2x read', tokens: 8000 }
        ]
      });
      zeroState.breakdown = { systemRules: 0, toolDefinitions: 0, activeCodeAndRules: 0, reclaimableClutter: 0 };
      dom.window.renderState(zeroState);

      assert.match(d.getElementById('tsDoText').textContent, /Task complete.*\/compact/);
      assert.equal(d.getElementById('tufteTopHostBadge').textContent, 'Antigravity \u00B7 Auto');
      assert.equal(d.getElementById('taSprint5h').textContent, '\u2014');
      assert.equal(d.getElementById('taWeekly7d').textContent, '\u2014');
      assert.equal(d.getElementById('taBtnShield').disabled, false);

      // BUG-10: click Shield flush, PDF export (402 opens trial banner), and Ignore (400 keeps button enabled)
      d.getElementById('taBtnShield').click();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(called.some((c) => c.url.includes('/api/shield/flush')));

      d.getElementById('btnExportPdfReceipt').click();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(d.getElementById('tsShadowAutoBanner').hidden, false);

      const ignBtn = d.querySelector('#taConsumersBody button[data-ignore-path]');
      assert.ok(ignBtn);
      ignBtn.click();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ignBtn.disabled, false, '400 /api/ignore response must not disable +Ignore button');

      // BUG-13: Off mode pauses guards + empty consumers show 0.0k (never 12.4k / 4.2k)
      dom.window.renderState(makePanelState('conv-off', 0, {
        routerMode: 'off',
        flightMode: 'OFF',
        window: { totalTokens: 0, totalActiveTokens: 0, safeLimit: 179000, maxTokens: 256000 },
        model: { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6 (Medium)', rawLabel: 'Claude Opus 4.6 (Medium)' },
        topConsumers: []
      }));
      assert.equal(d.getElementById('tufteTopHostBadge').textContent, 'Antigravity \u00B7 Claude Opus 4.6 (Medium)');
      assert.equal(d.getElementById('taDetBadge').textContent, 'Guards paused');
      assert.doesNotMatch(d.getElementById('taConsumersBody').textContent, /12\.4k|4\.2k/);
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });

  it('BUG-02, BUG-04 & BUG-10 (Daemon): /api/pre-compact, /api/force-prune, /api/ignore guard, empty session, and plain reload unpins', async () => {
    // 1. Pre-compact checkpoint & dry-run force-prune
    const preCompact = await api(port, 'POST', '/api/pre-compact', { conversationId: 'conv-fresh' });
    assert.equal(preCompact.status, 200);
    assert.equal(preCompact.json.success, true);

    const prune = await api(port, 'POST', '/api/force-prune', { conversationId: 'conv-fresh' });
    assert.equal(prune.status, 200);
    assert.equal(prune.json.stagedOnly, true);
    assert.equal(prune.json.hostTranscriptMutated, false);

    // 2. /api/ignore blocks active source code and accepts lockfile
    const badIgnore = await api(port, 'POST', '/api/ignore', { path: 'src/index.ts', workspacePath: tmpCwd });
    assert.equal(badIgnore.status, 400);
    assert.equal(badIgnore.json.success, false);
    assert.equal(fs.existsSync(path.join(tmpCwd, '.antigravityignore')), false);

    const okIgnore = await api(port, 'POST', '/api/ignore', { path: 'package-lock.json', workspacePath: tmpCwd });
    assert.equal(okIgnore.status, 200);
    assert.equal(okIgnore.json.success, true);
    assert.match(fs.readFileSync(path.join(tmpCwd, '.antigravityignore'), 'utf8'), /package-lock\.json/);

    // 3. Explicit unknown/new empty session returns clean 0-token empty state (not stale cache)
    const emptyRes = await api(port, 'GET', '/api/state?conversationId=new-unmaterialized-conv');
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.json.sessionId, 'new-unmaterialized-conv');
    assert.equal(emptyRes.json.window.totalActiveTokens, 0);

    // 4. Pinning via /api/action then hitting plain GET / resets server pinnedConversationId
    await api(port, 'POST', '/api/action', { action: 'select_session', conversationId: 'new-unmaterialized-conv' });
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'X-Sidecar-Token': TOKEN }
    });
    assert.equal(htmlRes.status, 200);
    const afterReload = await api(port, 'GET', '/api/state');
    assert.notEqual(afterReload.json.pinnedConversationId, 'new-unmaterialized-conv');
  });

  it('BUG-02 & BUG-03 (Parser/CLI): runCLI returns valid state on 0-step session and findSessionDirectory skips child subagents', async () => {
    const parserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-parser-sub-'));
    try {
      const agDir = path.join(parserRoot, '.gemini', 'antigravity');
      const brainDir = path.join(agDir, 'brain');
      const parentId = 'parent-conv-1111';
      const childDbId = 'child-sub-sql-2222';
      const childHeadlessId = 'child-sub-txt-3333';
      const emptyDir = path.join(brainDir, 'empty-new-4444');

      const writeLogs = (id, content) => {
        const logsDir = path.join(brainDir, id, '.system_generated', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        if (content !== null) {
          fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), content, 'utf8');
        }
      };

      writeLogs(parentId, `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Build feature X' })}\n`);
      // Make child sessions slightly newer
      await new Promise((r) => setTimeout(r, 30));
      writeLogs(childDbId, `${JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Subagent task' })}\n`);
      writeLogs(childHeadlessId, `${JSON.stringify({ step_index: 0, type: 'SYSTEM', source: 'SYSTEM', content: 'BROWSER_HOST_FACTS check' })}\n`);
      fs.mkdirSync(path.join(emptyDir, '.system_generated', 'logs'), { recursive: true });

      const DatabaseSync = getDatabaseSyncClass();
      if (DatabaseSync) {
        const db = new DatabaseSync(path.join(agDir, 'conversation_summaries.db'));
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, title TEXT)');
        db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(parentId, '', 'Main Chat');
        db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(childDbId, parentId, 'Child Subagent');
        db.close();
      }

      const found = findSessionDirectory(null, parserRoot);
      assert.ok(found);
      assert.equal(found.sessionId, parentId, 'must select parent user session instead of child subagent');

      const cacheDir = path.join(parserRoot, 'cache');
      const emptyCli = await runCLI({ sessionDirOverride: emptyDir, cacheDirOverride: cacheDir, silent: true });
      assert.ok(emptyCli.state, '0-step sessionDirOverride must yield non-null empty Horizon state');
      assert.equal(emptyCli.state.isEmptySession, true);
      assert.equal(emptyCli.state.window.totalActiveTokens, 0);

      const newCli = await runCLI({ stdinData: { session_id: 'fresh-conv-id' }, cacheDirOverride: cacheDir, silent: true });
      assert.ok(newCli.state, 'explicit new session_id without logs must yield non-null empty Horizon state');
      assert.equal(newCli.state.isEmptySession, true);
      assert.equal(newCli.state.sessionTitle, 'New Conversation');
    } finally {
      try { fs.rmSync(parserRoot, { recursive: true, force: true }); } catch (err) { void err; }
    }
  });

  it('BUG-08, BUG-09 & BUG-11 (CLI/Hooks): init does not auto-burn trial, Free AUTO_PILOT steps down in stop-gate, and H7 arms cooldown even if declined', () => {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-init-gate-'));
    try {
      const cliHome = path.join(cliRoot, 'home');
      const cliCwd = path.join(cliRoot, 'ws');
      fs.mkdirSync(cliHome, { recursive: true });
      fs.mkdirSync(cliCwd, { recursive: true });

      // BUG-08: installPlugin must NOT consume 14-day reverse trial unless provisionReverseTrial === true
      installPlugin({ dryRun: false, workspace: true, cwd: cliCwd, homeDir: cliHome });
      assert.equal(fs.existsSync(path.join(cliHome, '.ctxtop', 'license.json')), false);

      // BUG-09 + BUG-11: Free user with AUTO_PILOT config does not hit DET-14 hard block and arms cooldown when H7 fires
      const stopRes = runStopGateHook(
        {
          session_id: 'hook-free-h7',
          cwd: cliCwd,
          editedFiles: ['src/app.js'],
          codeEditedSinceLastTest: true,
          boundaryDetected: true,
          context_tokens: 160000,
          turns_since_last_compact: 10,
          expected_remaining_turns: 8,
          model: 'claude-sonnet-5-5'
        },
        {
          cwd: cliCwd,
          homeDir: cliHome,
          strict: true,
          horizonConfig: { flightMode: 'AUTO_PILOT', thresholds: { smartCompactBoundarySuggest: true } }
        }
      );
      assert.notEqual(stopRes.stdoutJson?.decision, 'block', 'unentitled Free user must step down to COACH and not hit DET-14 block');
      assert.equal(stopRes.smartCompactSuggestion?.shouldSuggest, true);

      const snap = readBreakerStateSnapshot('hook-free-h7', { cwd: cliCwd });
      assert.equal(snap?.turnsSinceLastCompact, 1, 'declining H7 suggestion must arm turnsSinceLastCompact = 1');

      // Immediate second boundary without running /compact must be suppressed by 4-turn cooldown
      const secondStop = runStopGateHook(
        {
          session_id: 'hook-free-h7',
          cwd: cliCwd,
          codeEditedSinceLastTest: false,
          boundaryDetected: true,
          context_tokens: 160000,
          expected_remaining_turns: 8,
          model: 'claude-sonnet-5-5'
        },
        {
          cwd: cliCwd,
          homeDir: cliHome,
          strict: true,
          horizonConfig: { flightMode: 'AUTO_PILOT', thresholds: { smartCompactBoundarySuggest: true } }
        }
      );
      assert.equal(secondStop.smartCompactSuggestion?.shouldSuggest, false);
      assert.equal(secondStop.smartCompactSuggestion?.suppressedReason, 'post_compact_cooldown');
    } finally {
      try { fs.rmSync(cliRoot, { recursive: true, force: true }); } catch (err) { void err; }
    }
  });
});
