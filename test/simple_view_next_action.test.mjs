import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import { classifyHorizon } from '../src/core/classifier.mjs';
import { loadHorizonConfig, setHorizonFlightMode } from '../src/core/horizon_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'src', 'webview', 'horizon_panel.html');
const WS = 'c:/Projects/demo-workspace';

async function mountPanel() {
  let rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
  rawHtml = rawHtml.replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const jsdomErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
  const dom = new JSDOM(rawHtml, {
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
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors };
}

function baseState(sessionId, extra = {}) {
  const steps = [
    { stepIndex: 0, type: 'SYSTEM_PROMPT', source: 'SYSTEM', status: 'DONE', content: 'rules/', inputTokens: 8000, outputTokens: 1000, toolCalls: [] },
    { stepIndex: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Update src/core/parser.mjs', outputTokens: 500, toolCalls: [] },
    { stepIndex: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '', outputTokens: 1500, toolCalls: [] }
  ];
  const st = classifyHorizon(steps, { sessionId, modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: WS });
  st.quota = st.quota || {};
  st.quota.cache = { ...(st.quota.cache || {}), cacheReadTokens: 0, hitRatePct: 0, isCacheCold: true, ttlRemainingSec: 0, nextTurnLikelyWarm: false };
  return Object.assign(st, extra);
}

describe('Simple view Next action: breakers, sharded spec, rule clashes & honest fillers', () => {
  it('surfaces new signals in tsDoText and removes fabricated filler values', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      win.renderState(baseState('nominal'));
      assert.match(txt('tsDoText'), /Safe to run multi-file edits/);
      assert.doesNotMatch(txt('tsGuardsSummary'), /\b32\b/, 'guard count must not be hard-coded');
      assert.doesNotMatch(txt('tsLedgerList'), /12\.4k/, 'no fabricated pinned-rules fallback');
      assert.equal(d.getElementById('tsKpiUsd').hidden, true, '~$0.00 hidden when nothing saved');
      assert.equal(d.getElementById('tsKpi30d').hidden, true, '30d hidden when nothing saved');

      win.renderState(baseState('clash', { rsl: { clashCount: 2 } }));
      assert.match(txt('tsDoText'), /2 conflicting rules detected .*ctxtop rsl status/);

      win.renderState(baseState('sharded', { shardedSpecCount: 5, rsl: { clashCount: 2 } }));
      assert.match(txt('tsDoText'), /Your requirements changed 5 times .*ctxtop handoff --consolidate/);

      win.renderState(baseState('breaker', {
        shardedSpecCount: 5,
        coachState: { circuitBreakerAlerts: [{ detectorId: 'DET-03', reason: 'Test assertion weakened in parser.test.mjs' }] }
      }));
      assert.match(txt('tsDoText'), /A safeguard \(DET-03\) flagged your last step: Test assertion weakened/);
      assert.equal(d.getElementById('tsDoRow').dataset.tone, 'danger');

      win.renderState(baseState('guards', { coachState: { detectors: { totalCount: 41 } } }));
      assert.match(txt('tsGuardsSummary'), /41 guards armed/);
      assert.equal(d.getElementById('tsGuardList').hidden, true, 'roster hidden without a live list');

      win.renderState(baseState('roster', {
        coachState: {
          detectors: {
            totalCount: 3,
            list: [
              { id: 'DET-10', name: 'Idle 5m Implicit-Cache Watchdog', mode: 'advisory', tripped: false },
              { id: 'DET-01', name: 'Destructive Git/Shell Guard', mode: 'guard', tripped: false },
              { id: 'DET-05', name: 'Test-Weakening Guard', mode: 'guard', tripped: true }
            ]
          }
        }
      }));
      const roster = d.getElementById('tsGuardList');
      assert.equal(roster.hidden, false);
      assert.equal(txt('tsGuardListHead'), 'Live guards (3 \u00B7 1 tripped)');
      const rowIds = [...roster.querySelectorAll('.ts-ledger-age')].map((n) => n.textContent);
      assert.deepEqual(rowIds, ['DET-05', 'DET-01', 'DET-10'], 'tripped first, then blocking, then advisory');
      assert.match(roster.textContent, /tripped[\s\S]*blocks[\s\S]*advises/);
      assert.equal(d.getElementById('tsActivityDrawer').contains(roster), true, 'roster lives inside the click-to-expand drawer');

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('renders the 4-card sketch layout, reversed Glass of Water layers, v4.1 signals, and tooltips', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      const titles = [...d.querySelectorAll('#argonSimpleSurface .ts-card-title')].map((n) => n.textContent.trim());
      assert.deepEqual(titles, ['CONTEXT', 'DIRECT GUIDANCE', 'AUTOMATED ACTIVITY', 'SESSION OVERVIEW']);
      assert.equal(Boolean(d.getElementById('tsAvoidRow').closest('details')), false, 'AVOID guidance visible without expanding a drawer');
      assert.equal(Boolean(d.getElementById('tsLedgerList').closest('details')), false, 'Automated activity ledger visible without expanding a drawer');
      assert.ok(Boolean(d.getElementById('tsBtnCleanPrimary').compareDocumentPosition(d.querySelector('#argonSimpleSurface details')) & 4));

      // Verify reversed vertical layer order inside #tsGlassFill: top=New, middle=Old, bottom=Pinned rules
      const fillChildren = [...d.getElementById('tsGlassFill').children].map((el) => el.id);
      assert.deepEqual(fillChildren, ['tsGlassSegNew', 'tsGlassSegOld', 'tsGlassSegPinned']);

      // Empty state -> 0% glass fill
      win.renderState({ totalTokens: 0, maxTokens: 200000, window: { safeLimit: 120000 } });
      assert.equal(parseFloat(d.getElementById('tsGlassFill').style.height), 0);
      assert.equal(d.getElementById('tsGlassFill').dataset.empty, 'true');

      // Partial fill with distinct Rules & tools (BASE), Older & clutter (OLD), and New & active (NEW)
      const partial = baseState('glass-partial', {
        shardedSpecCount: 3,
        shield: { enabled: true, maxUnslicedLines: 1200 },
        rsl: { totalActive: 3, promotedHooks: 1, clashCount: 0 },
        swarmTopology: {
          mode: 'swarm',
          workers: [{ name: 'worker-1', state: 'working' }],
          worktrees: [{ path: WS }, { path: `${WS}-wt` }],
          scopeLocks: { leaseCount: 2, collisions: [{ trajectories: ['agent-a', 'agent-b'], overlappingPaths: ['src/webview/horizon_panel.html'] }] }
        },
        sessionTimeline: {
          totalTurns: 12,
          markers: [{ type: 'COMPACT' }, { type: 'CHECKPOINT' }],
          kpis: { burnRateTokens: 5000, goodCount: 10, badCount: 2 }
        }
      });
      partial.breakdown = {
        ANCHOR: 20000,
        STALE_DUPLICATE: 30000,
        ACTIVE_WORKING_SET: 50000
      };
      partial.totalTokens = 100000;
      partial.reclaimableTokens = 30000;
      partial.window = { ...partial.window, totalTokens: 100000, safeLimit: 200000, maxTokens: 400000 };
      partial.quota.cache = {
        ...partial.quota.cache,
        hitRatePct: 92,
        isCacheCold: false,
        ttlRemainingSec: 185,
        nextTurnLikelyWarm: true,
        prefixRetention: { measured: true, retentionIndexPct: 94, grade: 'A', retainedPrefixTokens: 90000, eligiblePrefixTokens: 96000 }
      };
      win.renderState(partial);

      assert.equal(txt('tsValPinned'), '20.0k');
      assert.equal(txt('tsValClutter'), '30.0k');
      assert.equal(txt('tsValNew'), '50.0k');
      assert.equal(parseFloat(d.getElementById('tsGlassFill').style.height), 50);
      assert.equal(parseFloat(d.getElementById('tsGlassSegNew').style.height), 50);
      assert.equal(parseFloat(d.getElementById('tsGlassSegOld').style.height), 30);
      assert.equal(parseFloat(d.getElementById('tsGlassSegPinned').style.height), 20);
      assert.equal(d.getElementById('tsGlassSafeLine').hidden, true);
      assert.match(txt('tsDoText'), /Two AI agents are working on the same file \(1 overlap\)/);
      assert.match(txt('tsLedgerList'), /Large-file read limit active.*1,200 lines/);
      assert.doesNotMatch(txt('tsLedgerList'), /learned rule/, 'learned rules live in their own drawer, not duplicated in the ledger');
      assert.match(txt('tsLearnedRulesSummary'), /Applying 3 learned rules/);
      assert.equal(txt('tsSessionTurnsMeta'), '12 turns · 2 heavy');
      assert.match(txt('tsSessionPaceMeta'), /\+5\.0k\/turn avg · 1× compacted · 1 checkpoint/);
      assert.match(txt('tsRetentionMeta'), /94% kept \(A\)/);
      assert.equal(d.getElementById('tsSessionExtraRow').hidden, false);
      assert.match(txt('tsSessionExtraText'), /1 helper agent across 2 worktrees · 3 goal updates · 3 learned rules · Large-file limit on/);

      // Tooltips verified across cards, glass segments, and controls
      assert.ok(d.getElementById('tsGlassVessel').title.includes('bottom = Rules & tools'));
      assert.ok(d.getElementById('tsGlassSegNew').title.includes('New & active work (top of glass): 50.0k'));
      assert.ok(d.getElementById('tsGlassSegOld').title.includes('Older & reclaimable'));
      assert.ok(d.getElementById('tsGlassSegPinned').title.includes('Rules & tools (base of glass): 20.0k'));
      assert.ok(d.getElementById('tsBtnCleanPrimary').title.length > 20);

      // Overflow past safe limit reveals dashed safe threshold line
      partial.totalTokens = 300000;
      partial.window.totalTokens = 300000;
      partial.breakdown.ACTIVE_WORKING_SET = 250000;
      win.renderState(partial);
      assert.equal(parseFloat(d.getElementById('tsGlassFill').style.height), 100);
      assert.equal(d.getElementById('tsGlassSafeLine').hidden, false);
      assert.equal(txt('tsGlassCaption'), 'Over safe limit');

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('switches Off / Coach / Auto slider modes in UI and persists flightMode without dirtying repo root', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const postedModes = [];
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
        win.fetch = async (url, init) => {
          if (String(url).includes('/api/router/mode')) {
            postedModes.push(JSON.parse(init?.body || '{}').mode);
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        };
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        win.sidecar = { onWorkspaceChange() {} };
      }
    });
    await new Promise((r) => setTimeout(r, 80));
    const d = dom.window.document;
    try {
      const modeState = baseState('mode-slider', {
        coachState: {
          detectors: {
            totalCount: 2,
            list: [
              { id: 'DET-01', name: 'Destructive Git/Shell Guard', mode: 'guard', tripped: false },
              { id: 'DET-08', name: 'Horizon-Aware Cache Router', mode: 'advisory', tripped: false }
            ]
          }
        }
      });
      dom.window.renderState(modeState);
      const surface = d.getElementById('argonSimpleSurface');
      const slider = d.getElementById('tsModeSlider');
      const btnOff = d.getElementById('tsModeBtnOff');
      const btnCoach = d.getElementById('tsModeBtnCoach');
      const btnAuto = d.getElementById('tsModeBtnAuto');
      assert.ok(slider && btnOff && btnCoach && btnAuto, 'Off/Coach/Auto slider controls must exist');
      assert.equal(surface.dataset.protectionMode, 'coach');
      assert.equal(slider.dataset.activeMode, 'coach');
      assert.equal(btnCoach.getAttribute('aria-checked'), 'true');
      assert.equal(d.getElementById('tsAvoidRow').hidden, false);
      assert.match(d.getElementById('tsGuardList').textContent, /advises/);
      assert.ok(btnOff.title.includes('Watch only') && btnAuto.title.includes('Hands-free'));

      btnAuto.click();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(surface.dataset.protectionMode, 'autopilot');
      assert.equal(slider.dataset.activeMode, 'autopilot');
      assert.equal(btnAuto.getAttribute('aria-checked'), 'true');
      assert.match(d.getElementById('tsModeHint').textContent, /Hands-free/);
      assert.match(d.getElementById('tsGuidanceBadge').textContent, /Auto-(?:routed|hold)/);
      assert.equal(d.getElementById('tsAvoidRow').dataset.tone, 'handled');
      assert.equal(d.getElementById('tsAvoidRow').querySelector('.ts-tag').textContent, 'HANDLED');
      assert.match(d.getElementById('tsGuardsSummary').textContent, /Auto-enforcing/);
      assert.match(d.getElementById('tsGuardList').textContent, /enforces/);
      assert.equal(postedModes[postedModes.length - 1], 'autopilot');

      btnOff.click();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(surface.dataset.protectionMode, 'off');
      assert.equal(slider.dataset.activeMode, 'off');
      assert.equal(btnOff.getAttribute('aria-checked'), 'true');
      assert.equal(d.getElementById('tsGuidanceBadge').textContent.trim(), 'Watch only');
      assert.equal(d.getElementById('tsAvoidRow').hidden, true);
      assert.match(d.getElementById('tsDoText').textContent, /Watch-only mode/);
      assert.equal(d.getElementById('tsGuardsSummary').textContent.trim(), 'Paused (Watch only)');
      assert.match(d.getElementById('tsGuardList').textContent, /paused/);
      assert.equal(postedModes[postedModes.length - 1], 'off');

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }

    // Verify setHorizonFlightMode writes cleanly to globalConfigPath when cwd lacks .attention-horizon.json
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mode-test-'));
    const tmpCwd = path.join(tmpRoot, 'repo');
    const tmpHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(tmpCwd, { recursive: true });
    fs.mkdirSync(tmpHome, { recursive: true });
    try {
      const rOff = setHorizonFlightMode('off', { cwd: tmpCwd, homeDir: tmpHome });
      assert.equal(rOff.ok, true);
      assert.equal(rOff.flightMode, 'OFF');
      assert.equal(fs.existsSync(path.join(tmpCwd, '.attention-horizon.json')), false, 'must not dirty clean repo root');
      assert.equal(loadHorizonConfig({ cwd: tmpCwd, homeDir: tmpHome }).flightMode, 'OFF');

      const rAuto = setHorizonFlightMode('auto', { cwd: tmpCwd, homeDir: tmpHome });
      assert.equal(rAuto.flightMode, 'AUTO_PILOT');
      assert.equal(loadHorizonConfig({ cwd: tmpCwd, homeDir: tmpHome }).flightMode, 'AUTO_PILOT');

      const rCoach = setHorizonFlightMode('coach', { cwd: tmpCwd, homeDir: tmpHome });
      assert.equal(rCoach.flightMode, 'COACH');
      assert.equal(loadHorizonConfig({ cwd: tmpCwd, homeDir: tmpHome }).flightMode, 'COACH');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
