/**
 * Mode-driven main view (panel redesign, step 1): the panel mirrors the running mode onto <body>
 * (`data-flight-mode` = off | coach | autopilot, `data-auto-state` = on | preview | na) so each
 * mode can show its own view through the `mode-hide-*` / `auto-*-only` CSS classes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { classifyHorizon } from '../src/core/classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'src', 'webview', 'horizon_panel.html');
const WS = 'c:/Projects/demo-workspace';

async function mountPanel() {
  let rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
  rawHtml = rawHtml.replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const jsdomErrors = [];
  const posts = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
  const dom = new JSDOM(rawHtml, {
    url: 'http://127.0.0.1:43210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.EventSource = class { close() {} };
      win.fetch = async (url, init) => {
        if (init && init.method === 'POST') posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      };
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      win.sidecar = { onWorkspaceChange() {} };
    }
  });
  await new Promise((r) => setTimeout(r, 80));
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors, posts };
}

function baseState(sessionId, extra = {}) {
  const steps = [
    { stepIndex: 0, type: 'SYSTEM_PROMPT', source: 'SYSTEM', status: 'DONE', content: 'rules/', inputTokens: 8000, outputTokens: 1000, toolCalls: [] },
    { stepIndex: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Update src/core/parser.mjs', outputTokens: 500, toolCalls: [] },
    { stepIndex: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '', outputTokens: 1500, toolCalls: [] }
  ];
  const st = classifyHorizon(steps, { sessionId, modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: WS });
  return Object.assign(st, extra);
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('Mode-driven main view: body mode attributes', () => {
  it('starts on Coach and follows the mode carried by each state update', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const attrs = () => [d.body.dataset.flightMode, d.body.dataset.autoState];
    try {
      assert.deepEqual(attrs(), ['coach', 'na'], 'static default before any state arrives');

      win.renderState(baseState('off', { flightMode: 'OFF' }));
      assert.deepEqual(attrs(), ['off', 'na']);

      win.renderState(baseState('coach', { flightMode: 'COACH' }));
      assert.deepEqual(attrs(), ['coach', 'na']);

      win.renderState(baseState('auto-on', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT', autoShadow: false,
        proEntitlement: { entitled: true, tier: 'trial', daysRemaining: 9 }
      }));
      assert.deepEqual(attrs(), ['autopilot', 'on'], 'entitled Auto is enforced');

      win.renderState(baseState('auto-preview', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT',
        proEntitlement: { entitled: false, tier: 'free' }
      }));
      assert.deepEqual(attrs(), ['autopilot', 'preview'], 'Free Auto is a preview, never shown as enforced');

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('switches the view at once when the user clicks a mode, and saves it through /api/router/mode', async () => {
    const { dom, win, d, jsdomErrors, posts } = await mountPanel();
    const attrs = () => [d.body.dataset.flightMode, d.body.dataset.autoState];
    try {
      win.renderState(baseState('free', { flightMode: 'COACH', proEntitlement: { entitled: false, tier: 'free' } }));
      assert.deepEqual(attrs(), ['coach', 'na']);

      d.getElementById('tsModeBtnAuto').click();
      assert.deepEqual(attrs(), ['autopilot', 'preview'], 'optimistic switch before the daemon answers');
      await tick();
      assert.equal(posts.some((p) => p.url.endsWith('/api/router/mode') && p.body?.mode === 'autopilot'), true);

      d.getElementById('tsModeBtnOff').click();
      assert.deepEqual(attrs(), ['off', 'na']);
      await tick();

      d.getElementById('tsModeBtnCoach').click();
      assert.deepEqual(attrs(), ['coach', 'na']);
      await tick();

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('hides mode-tagged elements only in their mode', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const shown = (el) => win.getComputedStyle(el).display !== 'none';
    const add = (cls) => {
      const el = d.createElement('div');
      el.className = cls;
      d.body.appendChild(el);
      return el;
    };
    try {
      const hideOff = add('mode-hide-off');
      const hideCoach = add('mode-hide-coach');
      const hideAuto = add('mode-hide-auto');
      const onOnly = add('auto-on-only');
      const previewOnly = add('auto-preview-only');
      const expectShown = (label, want) => assert.deepEqual(
        [shown(hideOff), shown(hideCoach), shown(hideAuto), shown(onOnly), shown(previewOnly)], want, label
      );

      win.renderState(baseState('off', { flightMode: 'OFF' }));
      expectShown('Off', [false, true, true, false, false]);

      win.renderState(baseState('coach', { flightMode: 'COACH' }));
      expectShown('Coach', [true, false, true, false, false]);

      win.renderState(baseState('auto-on', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT', autoShadow: false, proEntitlement: { entitled: true, tier: 'pro' }
      }));
      expectShown('Auto (on)', [true, true, false, true, false]);

      win.renderState(baseState('auto-preview', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT', proEntitlement: { entitled: false, tier: 'free' }
      }));
      expectShown('Auto (preview)', [true, true, false, false, true]);

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});

describe('Header: one Advanced toggle replaces the Simple / Advanced tabs', () => {
  it('opens the Advanced view, offers Back, and returns to the main view', async () => {
    const { dom, d, jsdomErrors } = await mountPanel();
    const btn = () => d.getElementById('tabAdvanced');
    try {
      assert.equal(d.getElementById('tabSimple'), null, 'no Simple tab');
      assert.equal(d.querySelectorAll('.header-controls [data-view-tab]').length, 1, 'exactly one view control');
      assert.equal(d.body.dataset.viewMode, 'simple');
      assert.equal(btn().textContent, 'Advanced');
      assert.equal(btn().getAttribute('aria-pressed'), 'false');

      btn().click();
      assert.equal(d.body.dataset.viewMode, 'advanced');
      assert.equal(btn().textContent, 'Back');
      assert.equal(btn().getAttribute('aria-pressed'), 'true');
      assert.equal(btn().dataset.viewTab, 'simple', 'data-view-tab names the view a click opens next');

      btn().click();
      assert.equal(d.body.dataset.viewMode, 'simple');
      assert.equal(btn().textContent, 'Advanced');
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});

describe('Mode views: what each mode shows', () => {
  const visible = (win, d, id) => {
    const el = d.getElementById(id);
    return Boolean(el) && win.getComputedStyle(el).display !== 'none';
  };
  const snapshot = (win, d) => ({
    hero: visible(win, d, 'tsSavedHero'),
    offNote: visible(win, d, 'tsOffNote'),
    strip: visible(win, d, 'tsStatusStrip'),
    needs: visible(win, d, 'tsNeedsRow'),
    context: visible(win, d, 'tsMetricHeader'),
    guidance: visible(win, d, 'tsGuidanceSection'),
    activity: visible(win, d, 'tsActivitySection'),
    session: visible(win, d, 'tsSessionSection'),
    guardDrawer: visible(win, d, 'tsActivityDrawer')
  });
  const saved = { savings: { session: { totalTokens: 18400 } } };

  it('Off: context and session cards plus a watch-only note; no advice, no activity', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      win.renderState(baseState('off', { flightMode: 'OFF', ...saved }));
      assert.deepEqual(snapshot(win, d), {
        hero: true, offNote: true, strip: false, needs: false,
        context: true, guidance: false, activity: false, session: true, guardDrawer: false
      });
      assert.match(d.getElementById('tsOffNote').textContent, /Watching only/);
      assert.deepEqual(jsdomErrors, []);
    } finally { dom.window.close(); }
  });

  it('Coach: status line and guidance only', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      win.renderState(baseState('coach', { flightMode: 'COACH', ...saved }));
      assert.deepEqual(snapshot(win, d), {
        hero: true, offNote: false, strip: true, needs: false,
        context: false, guidance: true, activity: false, session: false, guardDrawer: false
      });
      assert.ok(d.getElementById('tsDoText').textContent.trim().length > 0, 'DO text present');
      assert.ok(d.getElementById('tsAvoidText').textContent.trim().length > 0, 'AVOID text present');
      assert.match(d.getElementById('tsStripText').textContent, /\bof\b.*safe.*Cache:/);
      assert.deepEqual(jsdomErrors, []);
    } finally { dom.window.close(); }
  });

  it('Auto (on): status line, what Auto did, and a needs-you row that says nothing is needed', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      win.renderState(baseState('auto-on', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT', autoShadow: false,
        proEntitlement: { entitled: true, tier: 'trial', daysRemaining: 9 }, ...saved
      }));
      assert.deepEqual(snapshot(win, d), {
        hero: true, offNote: false, strip: true, needs: true,
        context: false, guidance: false, activity: true, session: false, guardDrawer: false
      });
      assert.equal(d.getElementById('tsNeedsRow').dataset.tone, 'ok');
      assert.match(d.getElementById('tsNeedsText').textContent, /Nothing needed from you\. Auto is handling it/);
      assert.deepEqual(jsdomErrors, []);
    } finally { dom.window.close(); }
  });

  it('Auto (Free preview): same layout, and the wording never says Auto applied anything', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      win.renderState(baseState('auto-preview', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT', proEntitlement: { entitled: false, tier: 'free' }, ...saved
      }));
      assert.equal(snapshot(win, d).activity, true);
      assert.equal(d.getElementById('tsNeedsTag').textContent, 'PREVIEW');
      assert.match(d.getElementById('tsNeedsText').textContent, /preview.*applies nothing/i);
      assert.deepEqual(jsdomErrors, []);
    } finally { dom.window.close(); }
  });

  it('Auto: a flagged situation turns the needs-you row into an instruction', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      win.renderState(baseState('auto-flag', {
        routerMode: 'autopilot', flightMode: 'AUTO_PILOT', autoShadow: false,
        proEntitlement: { entitled: true, tier: 'pro' },
        coachState: { circuitBreakerAlerts: [{ detectorId: 'DET-03', reason: 'Test assertion weakened in parser.test.mjs' }] }
      }));
      assert.equal(d.getElementById('tsNeedsRow').dataset.tone, 'danger');
      assert.equal(d.getElementById('tsNeedsTag').textContent, 'NEEDS YOU');
      assert.match(d.getElementById('tsNeedsText').textContent, /DET-03.*flagged your last step/);
      assert.deepEqual(jsdomErrors, []);
    } finally { dom.window.close(); }
  });

  it('Tokens saved is the visible headline in every mode and follows the ledger', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      for (const [label, extra] of [
        ['off', { flightMode: 'OFF' }],
        ['coach', { flightMode: 'COACH' }],
        ['auto', { routerMode: 'autopilot', flightMode: 'AUTO_PILOT', autoShadow: false, proEntitlement: { entitled: true, tier: 'pro' } }]
      ]) {
        win.renderState(baseState(label, { ...extra, ...saved }));
        assert.equal(visible(win, d, 'tsSavedHero'), true, `${label}: headline visible`);
        assert.match(d.getElementById('tsHeroSaved').textContent, /^\+18\.4k$/, `${label}: tokens`);
        assert.match(d.getElementById('tsSavedHero').textContent, /Est\. tokens saved/);
      }
      win.renderState(baseState('none', { flightMode: 'COACH' }));
      assert.match(d.getElementById('tsHeroSub').textContent, /nothing saved yet/i);
      assert.deepEqual(jsdomErrors, []);
    } finally { dom.window.close(); }
  });
});
