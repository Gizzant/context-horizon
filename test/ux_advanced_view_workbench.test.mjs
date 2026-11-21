import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import { getRegisteredPanels } from '../src/webview/registry.mjs';
import { startServer } from '../sidecars/horizon-daemon/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
const RETIRED_ADVANCED_PATH = path.join(ROOT, 'src', 'webview', 'advanced_view.html');

function parseDisplayedK(str) {
  const s = String(str || '').trim().replace(/^\+/, '');
  const m = s.match(/(\d+(?:\.\d+)?)k/i);
  return m ? Number(m[1]) : NaN;
}

describe('Unified Advanced View Forensic Workbench (Google Argon / Edward Tufte Spec — Option A)', () => {
  it('enforces retired legacy file check, zero-modal CSP, AGENTS.md UI invariants, theme tokens, and registry parity', () => {
    assert.equal(fs.existsSync(RETIRED_ADVANCED_PATH), false, 'Legacy src/webview/advanced_view.html must be retired');
    assert.ok(fs.existsSync(HTML_PATH), 'src/webview/horizon_panel.html must exist');
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    // 1. Zero modals, zero window.alert popups, zero external network assets
    assert.ok(!/<dialog\b/i.test(html), 'Must not include <dialog> modals');
    assert.ok(!/window\.alert\s*\(/i.test(html), 'Must not use blocking window.alert popups');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'Must not fetch external CDN scripts');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'Must not fetch external stylesheets/fonts');

    // 2. AGENTS.md UI Invariants & Typography
    assert.ok(html.includes('id="argonAdvancedSurface"'), 'Must render #argonAdvancedSurface');
    assert.ok(html.includes('id="btnCompactPrimary"'), 'Must render #btnCompactPrimary');
    assert.ok(html.includes('id="btnCopyParameterizedCompact"'), 'Must render #btnCopyParameterizedCompact');
    assert.ok(html.includes('id="taBtnForceAst"'), 'Must render #taBtnForceAst');
    assert.ok(html.includes('id="compactInstruction"'), 'Must render #compactInstruction');
    assert.ok(html.includes('id="compactReclaim"'), 'Must render #compactReclaim');
    assert.ok(html.includes('tabular-nums'), 'Must enforce tabular-nums for zero layout jitter');
    assert.ok(
      html.includes('data-theme="light"') && html.includes('--hz-bg'),
      'Must define both Light and Dark IDE theme palettes'
    );

    // 3. Registered in Webview Registry targeting unified #argonAdvancedSurface
    const panels = getRegisteredPanels();
    const entry = panels.find((p) => p.id === 'tufte-advanced-workbench');
    assert.ok(entry, 'tufte-advanced-workbench must be registered in src/webview/registry.mjs');
    assert.equal(entry.route, '/advanced');
    assert.equal(entry.domSelector, '#argonAdvancedSurface');
  });

  it('drives 40-cell map, U-curve, source-file protection, router/shield controls, and receipt/prune flows with 0.1k parity', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8')
      .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const apiCalls = [];
    const clipboardWrites = [];
    const jsdomErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:62935/advanced',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.__INITIAL_VIEW_MODE__ = 'advanced';
        win.__HORIZON_CSRF_TOKEN__ = 'adv-csrf-token';
        win.EventSource = class { close() {} };
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        win.sidecar = { onWorkspaceChange() {} };
        win.fetch = async (url, init = {}) => {
          const u = String(url);
          apiCalls.push({
            url: u,
            method: init.method || 'GET',
            headers: init.headers || {},
            body: init.body ? JSON.parse(init.body) : null
          });
          if (u.startsWith('/api/state')) {
            return { ok: false, status: 204, json: async () => null };
          }
          if (u.includes('/api/savings/receipt')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ ok: true, receiptMarkdown: '# Highbeam Verified Receipt\nSaved: 142.8k' })
            };
          }
          if (u.includes('/api/shield/flush')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, deferred: false }) };
          }
          return { ok: true, status: 200, json: async () => ({ success: true, ok: true, savedTokens: 48200 }) };
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
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(d.body.getAttribute('data-view-mode'), 'advanced');

    // 1. 40-cell interactive map & cell slice inspector
    const grid = d.getElementById('taHorizonGrid');
    assert.equal(grid.children.length, 40, 'Must render all 40 chronological context cells');

    dom.window.renderState({
      sessionId: 'adv-warm-1',
      storeSource: 'claude-code',
      routerMode: 'coach',
      proEntitlement: { entitled: true, tier: 'pro' },
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 108400 },
      cells: Array.from({ length: 40 }, (_, i) => ({
        dominantCategory: i < 2 ? 'ANCHOR' : (i < 22 ? 'ACTIVE_WORKING_SET' : (i < 28 ? 'DUPLICATE_READ' : 'FREE_HEADROOM')),
        fillPct: i < 28 ? 80 : 0,
        attentionWeight: i === 17 ? 0.62 : 0.91
      })),
      breakdown: { ANCHOR: 8200, ACTIVE_WORKING_SET: 52000, DUPLICATE_READ: 38200, DEAD_ERROR: 10000 },
      brainSignals: {
        activeFiles: ['sidecars/horizon-daemon/server.mjs', 'src/webview/horizon_panel.html'],
        duplicateReads: {
          reclaimableTokens: 38200,
          topFiles: [
            { path: 'sidecars/horizon-daemon/server.mjs', occurrences: 4, wastedTokens: 19400 },
            { path: 'src/webview/horizon_panel.html', occurrences: 3, wastedTokens: 12600 },
            { path: '.scratch/build.log', occurrences: 2, wastedTokens: 6200 }
          ]
        },
        deadErrors: { errorCount: 2, reclaimableTokens: 10000 }
      },
      topRiskyCells: [{ cellIndex: 17, inTrough: true, riskReason: 'TROUGH_STRANDED_SPEC' }],
      hostHealth: { rssGb: 4.3, orphanCount: 2 },
      coachState: {
        mode: 'coach',
        hysteresisLocked: true,
        breakerEvents: [
          { age: '1m', detectorId: 'DET-06', summary: 'Blocked unmodified full-file re-read on server.mjs', tokensSaved: 14200 }
        ]
      },
      baseline: {
        rulesTokens: 3200,
        skillsTokens: 1800,
        mcpTokens: 4600,
        mcpAudit: { unusedEagerServers: [{ name: 'figma', schemaTokens: 2400 }] }
      },
      prefixShield: { queuedCount: 2 },
      quota: {
        sprint5h: { usedPct: 38, resetLabel: '3h 14m', modelPoolName: 'Sonnet 4.5' },
        weekly7d: { usedPct: 21 },
        cache: {
          hitRatePct: 95,
          ttlRemainingSec: 214,
          billingBlockRemainingSec: 2680,
          isCacheCold: false,
          cacheReadTokens: 96400
        }
      },
      savings: {
        session: {
          totalPhysicalTokens: 142800,
          estimatedInputValueUsd: 0.29,
          bySource: {
            cachePreserved: 91600,
            subagentIsolated: 22000,
            cliCompressed: 15000,
            avoidedBloat: 14200
          }
        },
        workspace30d: { totalPhysicalTokens: 1840000, estimatedInputValueUsd: 3.68 }
      }
    });

    // Mathematical 0.1k sum parity: Active Signal + Reclaimable === Used
    const sigK = parseDisplayedK(d.getElementById('taSigTok').textContent);
    const reclK = parseDisplayedK(d.getElementById('taClutterTok').textContent);
    const usedK = parseDisplayedK(d.getElementById('taUsedTok').textContent);
    assert.equal(Number((sigK + reclK).toFixed(1)), usedK, 'Active Signal + Reclaimable must equal Total Used to 0.1k');

    // Clicking Cell #18 updates aria-selected and the 1-line slice inspector
    grid.children[17].click();
    assert.equal(grid.children[17].getAttribute('aria-selected'), 'true');
    assert.match(d.getElementById('taCellLeft').textContent, /Cell #18/);
    assert.match(d.getElementById('taCellRight').textContent, /recall/);
    assert.match(d.getElementById('taUTrough').textContent, /1 spec/);

    // 2. Strict AGENTS.md Invariant 2: Active source files NEVER get +Ignore; .scratch/build.log DOES
    const consumerHtml = d.getElementById('taConsumersBody').innerHTML;
    assert.ok(!consumerHtml.includes('data-ignore-path="sidecars/horizon-daemon/server.mjs"'), 'Active .mjs file must never show +Ignore');
    assert.ok(!consumerHtml.includes('data-ignore-path="src/webview/horizon_panel.html"'), 'Active .html file must never show +Ignore');
    assert.ok(consumerHtml.includes('Active Source'), 'Active source files must display Active Source badge');
    const ignoreLogBtn = d.querySelector('[data-ignore-path=".scratch/build.log"]');
    assert.ok(ignoreLogBtn, 'Scratch log file must expose +Ignore button');

    // 3. Router Mode Switch -> POST /api/router/mode with CSRF
    const autoBtn = d.querySelector('#taRouterSwitch [data-ta-mode="autopilot"]');
    autoBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    const routerCall = apiCalls.find((c) => c.url.includes('/api/router/mode'));
    assert.ok(routerCall, 'Router mode toggle must POST to /api/router/mode');
    assert.equal(routerCall.headers['X-Horizon-CSRF'], 'adv-csrf-token');
    assert.equal(routerCall.body.mode, 'autopilot');

    // 4. PrefixCacheShield Flush -> POST /api/shield/flush
    const shieldBtn = d.getElementById('taBtnShield');
    assert.equal(shieldBtn.disabled, false);
    shieldBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/shield/flush')), 'Shield button must POST to /api/shield/flush');

    // 5. Estimated Savings Receipt -> POST /api/savings/receipt
    d.getElementById('taBtnCopyReceipt').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/savings/receipt')), 'Copy Receipt must POST to /api/savings/receipt');
    assert.ok(clipboardWrites.some((t) => t.includes('Highbeam Verified Receipt')), 'Must write verified receipt markdown to clipboard');

    // 6. Warm-Cache Surgery CTA -> POST /api/pre-compact; Secondary #taBtnForceAst -> POST /api/force-prune
    assert.equal(d.getElementById('taBtnSurgeryPrimary').dataset.ctaState, 'guarded');
    d.getElementById('taBtnSurgeryPrimary').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/pre-compact')), 'Surgery primary click must POST /api/pre-compact');

    d.getElementById('taBtnForceAst').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/force-prune')), 'Dry-run prune button must POST /api/force-prune');
    assert.deepEqual(jsdomErrors, []);

    dom.window.close();
  });

  it('serves GET /advanced from the live Horizon daemon using unified horizon_panel.html with __INITIAL_VIEW_MODE__=advanced', async () => {
    const { server, port, ipcServer } = await startServer(0);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/advanced`);
      assert.equal(resp.status, 200);
      const body = await resp.text();
      assert.ok(body.includes('id="argonAdvancedSurface"'), 'Must serve unified Advanced View workbench container');
      assert.ok(body.includes('window.__INITIAL_VIEW_MODE__ = "advanced"'), 'Must inject initial view mode');
      assert.ok(body.includes('window.__HORIZON_CSRF_TOKEN__'), 'Must inject per-boot CSRF token');
    } finally {
      if (ipcServer) {
        try { await ipcServer.close(); } catch (err) { void err; }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
