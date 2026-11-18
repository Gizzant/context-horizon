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
