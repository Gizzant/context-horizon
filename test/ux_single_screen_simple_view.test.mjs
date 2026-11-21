import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import { getRegisteredPanels } from '../src/webview/registry.mjs';
import { startServer } from '../sidecars/horizon-daemon/server.mjs';
import { computeNextPromptPlaybook } from '../src/core-isomorphic/coach/nextPromptPlaybook.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
const RETIRED_SIMPLE_PATH = path.join(ROOT, 'src', 'webview', 'simple_view.html');

function parseDisplayedK(str) {
  const s = String(str || '').trim().replace(/^\+/, '');
  const m = s.match(/(\d+(?:\.\d+)?)k/i);
  return m ? Number(m[1]) : NaN;
}

describe('Unified Simple View (Google Argon / Edward Tufte Spec — Option A)', () => {
  it('enforces retired legacy file check, zero-network CSP, AGENTS.md UI invariants, Playbook visibility, and theme tokens', () => {
    assert.equal(fs.existsSync(RETIRED_SIMPLE_PATH), false, 'Legacy src/webview/simple_view.html must be retired');
    assert.ok(fs.existsSync(HTML_PATH), 'src/webview/horizon_panel.html must exist');
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    // 1. Strict UI safety: zero <dialog> modals, zero window.alert popups, Playbook outside <details>
    assert.ok(!/<dialog\b/i.test(html), 'Must not include <dialog> modals');
    assert.ok(!/window\.alert\s*\(/i.test(html), 'Must not use blocking window.alert popups');
    const dom = new JSDOM(html);
    const d = dom.window.document;
    const pbCard = d.getElementById('tsPlaybookCard');
    assert.ok(pbCard, 'Simple View must render #tsPlaybookCard');
    assert.equal(pbCard.closest('details'), null, '#tsPlaybookCard must be visible by default outside <details>');
    assert.ok(d.getElementById('tsGuidanceSection')?.contains(pbCard), '#tsPlaybookCard must live in Direct Guidance Card 2');
    dom.window.close();

    // 2. Zero-Trust Offline CSP: zero external CDN scripts or stylesheets
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'Must not fetch external CDN scripts');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'Must not fetch external stylesheets/fonts');

    // 3. AGENTS.md UI Invariants & Typography
    assert.ok(html.includes('id="btnCompactPrimary"'), 'Must render #btnCompactPrimary');
    assert.ok(html.includes('id="compactInstruction"'), 'Must render #compactInstruction');
    assert.ok(html.includes('id="compactReclaim"'), 'Must render #compactReclaim');
    assert.ok(html.includes('tabular-nums'), 'Must enforce tabular-nums for zero layout jitter');
    assert.ok(
      html.includes('data-theme="light"') && html.includes('--hz-bg'),
      'Must define both Light and Dark IDE theme palettes'
    );

    // 4. Registered in Webview Registry targeting unified #argonSimpleSurface
    const panels = getRegisteredPanels();
    const entry = panels.find((p) => p.id === 'single-screen-simple-view');
    assert.ok(entry, 'single-screen-simple-view must be registered in src/webview/registry.mjs');
    assert.equal(entry.route, '/simple');
    assert.equal(entry.domSelector, '#argonSimpleSurface');
  });

  it('drives Cards 1–4 across Lean, Warm-Guarded, Cold-Saturated, and Crisis states with 0.1k sum parity', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8')
      .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const apiCalls = [];
    const jsdomErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:62935/simple',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.__INITIAL_VIEW_MODE__ = 'simple';
        win.__HORIZON_CSRF_TOKEN__ = 'test-csrf-token';
        win.EventSource = class { close() {} };
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        win.sidecar = { onWorkspaceChange() {} };
        win.fetch = async (url, init = {}) => {
          apiCalls.push({
            url: String(url),
            method: init.method || 'GET',
            headers: init.headers || {},
            body: init.body ? JSON.parse(init.body) : null
          });
          if (String(url).startsWith('/api/state')) {
            return { ok: false, status: 204, json: async () => null };
          }
          return { ok: true, status: 200, json: async () => ({ success: true, savedTokens: 48200 }) };
        };
      }
    });

    const d = dom.window.document;
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(d.body.getAttribute('data-view-mode'), 'simple');

    // --- State 1: Lean Optimal Session ---
    dom.window.renderState({
      sessionId: 'sess-lean',
      storeSource: 'antigravity',
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 14200 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 7800, DUPLICATE_READ: 0, DEAD_ERROR: 0 },
      quota: {
        sprint5h: { modelPoolName: 'Gemini 3.8 Flash' },
        cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true, cacheReadTokens: 0 }
      },
      savings: {
        session: { totalPhysicalTokens: 4800, estimatedInputValueUsd: 0.01, bySource: {} },
        workspace30d: { totalPhysicalTokens: 942000, estimatedInputValueUsd: 1.88 }
      }
    });

    assert.equal(txt('tsStatusLabel'), 'Healthy');
    assert.equal(txt('tufteTopHostBadge'), 'Antigravity \u00B7 Gemini 3.8 Flash (Auto)');
    assert.equal(txt('tsPbRegimeBadge'), 'COLD BOUNDARY');
    assert.equal(txt('tsGuidanceBadge'), 'COLD BOUNDARY');
    assert.match(txt('tsPbRowQuick'), /unverified on Gemini/i);
    assert.equal(d.getElementById('tsBtnCleanPrimary').dataset.ctaState, 'guarded');
    assert.equal(
      Number((parseDisplayedK(txt('tsValNew')) + parseDisplayedK(txt('tsValClutter')) + parseDisplayedK(txt('tsValPinned'))).toFixed(1)),
      parseDisplayedK(txt('tsUsedLabel')),
      'Tenth-of-a-kilotoken sum parity must hold in Lean state'
    );

    // --- State 2: Warm KV Cache Guardrail on Claude 5.5 ---
    const warmPb = computeNextPromptPlaybook({
      host: 'claude',
      modelId: 'claude-sonnet-5-5',
      cachedTokens: 88300,
      totalTokens: 96000,
      safeLimit: 179000,
      cacheWarm: true,
      cacheTtlTier: '5m',
      ttlRemainingSec: 218
    });
    dom.window.renderState({
      sessionId: 'sess-warm',
      storeSource: 'claude-code',
      model: { id: 'claude-sonnet-5-5', canonicalId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 96000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 26600, DUPLICATE_READ: 63000 },
      quota: {
        sprint5h: { modelPoolName: 'Claude Sonnet 5.5' },
        cache: { hitRatePct: 94, ttlRemainingSec: 218, isCacheCold: false, cacheReadTokens: 88300 }
      },
      coachState: { nextPromptPlaybook: warmPb },
      savings: {
        session: {
          totalPhysicalTokens: 112400,
          estimatedInputValueUsd: 0.22,
          bySource: { cachePreserved: 83900, cliCompressed: 14200, subagentIsolated: 14300 }
        },
        workspace30d: { totalPhysicalTokens: 1120000, estimatedInputValueUsd: 2.24 }
      }
    });

    assert.equal(txt('tufteTopHostBadge'), 'Claude Code \u00B7 Claude Sonnet 5.5 (Auto)');
    assert.match(txt('tsCacheMeta'), /94% hit \u00B7 Warm \(03:38\)/);
    assert.equal(txt('tsPbRegimeBadge'), 'WARM \u00B7 EFFORT SAFE');
    assert.equal(txt('tsGuidanceBadge'), 'WARM \u00B7 EFFORT SAFE');
    assert.equal(d.querySelector('#tsPbRowQuick .ts-pb-cat').textContent.trim(), 'Quick \u00B7 typo/lookup');
    assert.equal(d.querySelector('#tsPbRowQuick .ts-pb-copy').hidden, false);
    assert.equal(d.getElementById('tsBtnCleanPrimary').dataset.ctaState, 'guarded');
    assert.equal(d.getElementById('tsBarClutter').dataset.clutterTone, 'cached');
    assert.ok(d.querySelectorAll('#tsLedgerList > li').length <= 4, 'Automated ledger must stay bounded to <= 4 rows');

    // --- State 3: Cold Cache Saturation Risk ---
    dom.window.renderState({
      sessionId: 'sess-cold-sat',
      storeSource: 'antigravity',
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 146000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 91400, STALE_DUPLICATE: 34200, DEAD_ERROR: 14000 },
      brainSignals: {
        activeFiles: ['src/webview/horizon_panel.html'],
        duplicateReads: { reclaimableTokens: 34200 },
        deadErrors: { reclaimableTokens: 14000 },
        activeSignal: { baselineTokens: 6400 }
      },
      quota: {
        sprint5h: { modelPoolName: 'Gemini 4 Carbon' },
        cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true, cacheReadTokens: 0 }
      },
      savings: {
        session: {
          totalPhysicalTokens: 148600,
          estimatedInputValueUsd: 0.30,
          bySource: { cliCompressed: 14200, cachePreserved: 88400, avoidedBloat: 46000 }
        },
        workspace30d: { totalPhysicalTokens: 1210000, estimatedInputValueUsd: 2.42 }
      }
    });

    assert.equal(txt('tsStatusLabel'), 'Old Clutter High');
    assert.equal(d.getElementById('tsBtnCleanPrimary').dataset.ctaState, 'ready');
    assert.equal(
      Number((parseDisplayedK(txt('tsValNew')) + parseDisplayedK(txt('tsValClutter')) + parseDisplayedK(txt('tsValPinned'))).toFixed(1)),
      parseDisplayedK(txt('tsUsedLabel')),
      '97.8k + 48.2k must equal 146.0k exactly'
    );
    assert.equal(txt('tsKpiSaved'), '+148.6k');

    // --- State 4: Amputation / Safe-Horizon Crisis Overrides Warm Hold ---
    dom.window.renderState({
      sessionId: 'sess-crisis',
      storeSource: 'claude-code',
      verdictCode: 'CRITICAL_STOP',
      amputation: { amputationCrisis: true, anchorsAtRisk: 2 },
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 188400 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 110000, DUPLICATE_READ: 72000 },
      quota: {
        cache: { hitRatePct: 91, ttlRemainingSec: 180, isCacheCold: false, cacheReadTokens: 150000 }
      },
      savings: {
        session: { totalPhysicalTokens: 196800, estimatedInputValueUsd: 0.39, bySource: {} },
        workspace30d: { totalPhysicalTokens: 1258200, estimatedInputValueUsd: 2.52 }
      }
    });

    assert.equal(txt('tsStatusLabel'), 'Pinned Rules at Risk');
    assert.equal(d.getElementById('tsStatusDot').dataset.tone, 'danger');
    assert.equal(d.getElementById('tsBtnCleanPrimary').dataset.ctaState, 'crisis');
    assert.equal(txt('tsPbRegimeBadge'), 'NEAR CLIFF');
    assert.equal(d.querySelector('#tsPbRowQuick .ts-pb-copy').hidden, true, 'NEAR_CLIFF Playbook rows keep no Copy button');
    assert.equal(txt('tsAnchorHealth'), 'Oldest rules at risk');
    assert.deepEqual(jsdomErrors, []);

    dom.window.close();
  });

  it('serves GET /simple from the live Horizon daemon using unified horizon_panel.html with __INITIAL_VIEW_MODE__=simple', async () => {
    const { server, port, ipcServer } = await startServer(0);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/simple`);
      assert.equal(resp.status, 200);
      const body = await resp.text();
      assert.ok(body.includes('id="argonSimpleSurface"'), 'Must serve unified Simple View container');
      assert.ok(body.includes('window.__INITIAL_VIEW_MODE__ = "simple"'), 'Must inject initial view mode');
      assert.ok(body.includes('window.__HORIZON_CSRF_TOKEN__'), 'Must inject per-boot CSRF token');
    } finally {
      if (ipcServer) {
        try { await ipcServer.close(); } catch (err) { void err; }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
