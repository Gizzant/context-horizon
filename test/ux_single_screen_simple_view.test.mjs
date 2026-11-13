import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { getRegisteredPanels } from '../src/webview/registry.mjs';
import { startServer } from '../sidecars/horizon-daemon/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIMPLE_HTML_PATH = path.join(ROOT, 'src', 'webview', 'simple_view.html');

function parseDisplayedK(str) {
  const m = String(str || '').match(/(\d+(?:\.\d+)?)k/);
  return m ? Number(m[1]) : NaN;
}

describe('Single-Screen Simple View (Google Argon / Edward Tufte Spec — Option A)', () => {
  it('enforces strict single-screen, zero-network CSP, AGENTS.md UI invariants, and dark/light tokens', () => {
    assert.ok(fs.existsSync(SIMPLE_HTML_PATH), 'src/webview/simple_view.html must exist');
    const html = fs.readFileSync(SIMPLE_HTML_PATH, 'utf8');

    // 1. Strict Single-Screen Constraint: zero modals, zero <details> drill-downs, zero Advanced View tabs
    assert.ok(!/<details\b/i.test(html), 'Must not include collapsible <details> secondary drill-downs');
    assert.ok(!/<dialog\b/i.test(html), 'Must not include <dialog> modals');
    assert.ok(!/data-view-tab="advanced"|Advanced View/i.test(html), 'Must not reference or expose Advanced View tabs');
    assert.ok(!/window\.confirm\s*\(|window\.alert\s*\(/i.test(html), 'Must not use blocking browser popups');

    // 2. Zero-Trust Offline CSP: zero external CDN scripts or stylesheets
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'Must not fetch external CDN scripts');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'Must not fetch external stylesheets/fonts');

    // 3. AGENTS.md UI Invariants & Typography
    assert.ok(html.includes('id="btnCompactPrimary"'), 'Must render #btnCompactPrimary');
    assert.ok(html.includes('id="compactInstruction"'), 'Must render #compactInstruction');
    assert.ok(html.includes('id="compactReclaim"'), 'Must render #compactReclaim');
    assert.ok(!html.includes('.antigravityignore'), 'Must not expose source-file ignore buttons');
    assert.ok(html.includes('tabular-nums'), 'Must enforce tabular-nums for zero layout jitter');
    assert.ok(html.includes('vscode-light') && html.includes('vscode-dark'), 'Must define both Light and Dark IDE theme palettes');

    // 4. Registered in Webview Registry
    const panels = getRegisteredPanels();
    const entry = panels.find((p) => p.id === 'single-screen-simple-view');
    assert.ok(entry, 'single-screen-simple-view must be registered in src/webview/registry.mjs');
    assert.equal(entry.route, '/simple');
  });

  it('drives Zones A–D across Lean, Warm-Guarded, Cold-Saturated, and Crisis states with 0.1k sum parity', async () => {
    const html = fs.readFileSync(SIMPLE_HTML_PATH, 'utf8');
    const apiCalls = [];
    const clipboardWrites = [];

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:62935/simple',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.__HORIZON_CSRF_TOKEN__ = 'test-csrf-token';
        win.EventSource = class { close() {} };
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
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, savedTokens: 48200 })
          };
        };
        Object.defineProperty(win.navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (txt) => { clipboardWrites.push(String(txt)); }
          }
        });
      }
    });

    const d = dom.window.document;
    await new Promise((r) => setTimeout(r, 25));

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

    assert.equal(d.getElementById('statusLabel').textContent, 'Optimal Cache');
    assert.equal(d.getElementById('hostModelTag').textContent, 'Antigravity \u00B7 Gemini 3.8 Flash');
    assert.match(d.getElementById('guidanceModelEffortText').textContent, /Model: OK to switch.*Effort: OK to change/);
    assert.equal(d.getElementById('zoneBModelEffortBadge').textContent, 'Model: OK \u00B7 Effort: OK');
    assert.equal(d.getElementById('btnCompactPrimary').disabled, true);
    assert.equal(d.getElementById('btnCompactPrimary').dataset.ctaState, 'disabled');
    assert.equal(
      Number((parseDisplayedK(d.getElementById('valActiveSignal').textContent) + parseDisplayedK(d.getElementById('valReclaimable').textContent)).toFixed(1)),
      parseDisplayedK(d.getElementById('activeUsedLabel').textContent),
      'Tenth-of-a-kilotoken sum parity must hold in Lean state'
    );

    // --- State 2: Warm KV Cache Guardrail (Protects 95% Discount) ---
    dom.window.renderState({
      sessionId: 'sess-warm',
      storeSource: 'claude-code',
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 96000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 26600, DUPLICATE_READ: 63000 },
      quota: {
        sprint5h: { modelPoolName: 'Sonnet 4.5' },
        cache: { hitRatePct: 94, ttlRemainingSec: 218, isCacheCold: false, cacheReadTokens: 88300 }
      },
      savings: {
        session: {
          totalPhysicalTokens: 112400,
          estimatedInputValueUsd: 0.22,
          bySource: { cachePreserved: 83900, cliCompressed: 14200, subagentIsolated: 14300 }
        },
        workspace30d: { totalPhysicalTokens: 1120000, estimatedInputValueUsd: 2.24 }
      }
    });

    assert.equal(d.getElementById('hostModelTag').textContent, 'Claude Code \u00B7 Sonnet 4.5');
    assert.equal(d.getElementById('statusLabel').textContent, 'Optimal Cache');
    assert.match(d.getElementById('cacheTtlMeta').textContent, /94% hit \u00B7 03:38 warm/);
    assert.match(d.getElementById('guidanceModelEffortText').textContent, /Model: Not OK to switch for 03:38.*Effort: OK to change/);
    assert.equal(d.getElementById('zoneBModelEffortBadge').textContent, 'Model: Hold 03:38 \u00B7 Effort: OK');
    assert.equal(d.getElementById('btnCompactPrimary').dataset.ctaState, 'guarded');
    assert.equal(d.getElementById('barReclaimableClutter').dataset.clutterTone, 'cached');
    assert.ok(d.querySelectorAll('#activityLedgerList > li').length <= 4, 'Automated ledger must stay bounded to <= 4 rows');

    // Clicking while warm invokes prefix-safe /api/tail/trim (never destructive hot /api/prune)
    d.getElementById('btnCompactPrimary').click();
    await new Promise((r) => setTimeout(r, 25));
    const tailCall = apiCalls.find((c) => c.url.includes('/api/tail/trim'));
    assert.ok(tailCall, 'Guarded click must route to prefix-safe POST /api/tail/trim');
    assert.equal(tailCall.headers['X-Horizon-CSRF'], 'test-csrf-token');

    // --- State 3: Cold Cache Saturation Risk -> Full Clean & Purge Cycle ---
    dom.window.renderState({
      sessionId: 'sess-cold-sat',
      storeSource: 'antigravity',
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 146000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 91400, DUPLICATE_READ: 34200, DEAD_ERROR: 14000 },
      brainSignals: {
        activeFiles: ['src/webview/simple_view.html'],
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

    assert.equal(d.getElementById('statusLabel').textContent, 'Context Saturation Risk');
    assert.equal(d.getElementById('btnCompactPrimary').dataset.ctaState, 'ready');
    assert.equal(
      Number((parseDisplayedK(d.getElementById('valActiveSignal').textContent) + parseDisplayedK(d.getElementById('valReclaimable').textContent)).toFixed(1)),
      parseDisplayedK(d.getElementById('activeUsedLabel').textContent),
      '97.8k + 48.2k must equal 146.0k exactly'
    );

    d.getElementById('btnCompactPrimary').click();
    // Instant (<16ms) sensory state check before async fetch resolves
    assert.equal(d.getElementById('statusLabel').textContent, 'Memory Pruning Active');
    await new Promise((r) => setTimeout(r, 30));

    const pruneCall = apiCalls.find((c) => c.url.includes('/api/prune'));
    assert.ok(pruneCall, 'Ready click must invoke POST /api/prune');
    assert.equal(pruneCall.body.forceHotCache, false);
    assert.ok(
      clipboardWrites.some((cmd) => cmd.startsWith('/compact Focus on preserving:')),
      'Must copy spec-preserving parameterized /compact command to clipboard'
    );
    assert.equal(d.getElementById('statusLabel').textContent, 'Optimal Cache');
    assert.equal(d.getElementById('valReclaimable').textContent, '0.0k');
    assert.equal(d.getElementById('kpiSessionSavedTokens').textContent, '196.8k');

    // --- State 4: Amputation / Safe-Horizon Crisis Overrides Warm Hold ---
    dom.window.renderState({
      sessionId: 'sess-crisis',
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

    assert.equal(d.getElementById('statusLabel').textContent, 'Context Saturation Risk');
    assert.equal(d.getElementById('statusDot').dataset.tone, 'danger');
    assert.equal(d.getElementById('btnCompactPrimary').dataset.ctaState, 'crisis');
    assert.equal(d.getElementById('anchorHealthLabel').textContent, '2 rules at risk');

    dom.window.close();
  });

  it('serves GET /simple from the live Horizon daemon with CSRF & state bootstrap injected', async () => {
    const { server, port, ipcServer } = await startServer(0);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/simple`);
      assert.equal(resp.status, 200);
      const body = await resp.text();
      assert.ok(body.includes('id="highbeamSimpleScreen"'), 'Must serve Simple View container');
      assert.ok(body.includes('window.__HORIZON_CSRF_TOKEN__'), 'Must inject per-boot CSRF token');
    } finally {
      if (ipcServer) {
        try { await ipcServer.close(); } catch (_err) { void _err; }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
