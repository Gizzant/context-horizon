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
const ADVANCED_HTML_PATH = path.join(ROOT, 'src', 'webview', 'advanced_view.html');
const SIMPLE_HTML_PATH = path.join(ROOT, 'src', 'webview', 'simple_view.html');

function parseDisplayedK(str) {
  const m = String(str || '').match(/(\d+(?:\.\d+)?)k/);
  return m ? Number(m[1]) : NaN;
}

describe('Advanced View Forensic Workbench (Google Argon / Edward Tufte Spec — Option A)', () => {
  it('enforces zero-modal, zero-CDN CSP, AGENTS.md UI invariants, dark/light tokens, and Simple/Advanced boundary', () => {
    assert.ok(fs.existsSync(ADVANCED_HTML_PATH), 'src/webview/advanced_view.html must exist');
    const html = fs.readFileSync(ADVANCED_HTML_PATH, 'utf8');

    // 1. Zero modals, zero blocking popups, zero external network assets
    assert.ok(!/<dialog\b/i.test(html), 'Must not include <dialog> modals');
    assert.ok(!/window\.confirm\s*\(|window\.alert\s*\(/i.test(html), 'Must not use blocking browser popups');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'Must not fetch external CDN scripts');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'Must not fetch external stylesheets/fonts');

    // 2. AGENTS.md UI Invariants & Typography
    assert.ok(html.includes('id="btnCompactPrimary"'), 'Must render #btnCompactPrimary');
    assert.ok(html.includes('id="btnCopyParameterizedCompact"'), 'Must render #btnCopyParameterizedCompact');
    assert.ok(html.includes('id="btnCondenseAst"'), 'Must render #btnCondenseAst');
    assert.ok(html.includes('id="compactInstruction"'), 'Must render #compactInstruction');
    assert.ok(html.includes('id="compactReclaim"'), 'Must render #compactReclaim');
    assert.ok(html.includes('tabular-nums'), 'Must enforce tabular-nums for zero layout jitter');
    assert.ok(html.includes('vscode-light') && html.includes('vscode-dark'), 'Must define both Light and Dark IDE theme palettes');

    // 3. Simple View isolation preserved (Simple never mentions Advanced; Advanced links back to /simple)
    const simpleHtml = fs.readFileSync(SIMPLE_HTML_PATH, 'utf8');
    assert.ok(!/Advanced View|\/advanced/i.test(simpleHtml), 'Simple View must remain clean of Advanced View references');
    assert.ok(html.includes('href="/simple"'), 'Advanced View must provide header link back to /simple');

    // 4. Registered in Webview Registry
    const panels = getRegisteredPanels();
    const entry = panels.find((p) => p.id === 'tufte-advanced-workbench');
    assert.ok(entry, 'tufte-advanced-workbench must be registered in src/webview/registry.mjs');
    assert.equal(entry.route, '/advanced');
  });

  it('drives 40-cell map, U-curve, source-file protection, router/shield controls, and surgical cleanup with 0.1k parity', async () => {
    const html = fs.readFileSync(ADVANCED_HTML_PATH, 'utf8');
    const apiCalls = [];
    const clipboardWrites = [];

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:62935/advanced',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.__HORIZON_CSRF_TOKEN__ = 'adv-csrf-token';
        win.EventSource = class { close() {} };
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
            return {
              ok: true,
              status: 200,
              json: async () => ({ ok: true, deferred: false })
            };
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

    // 1. 40-cell interactive map & cell slice inspector
    const grid = d.getElementById('horizonGrid');
    assert.equal(grid.children.length, 40, 'Must render all 40 chronological context cells');

    dom.window.renderState({
      sessionId: 'adv-warm-1',
      storeSource: 'claude-code',
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 108400 },
      breakdown: { ANCHOR: 8200, ACTIVE_WORKING_SET: 52000, DUPLICATE_READ: 38200, DEAD_ERROR: 10000 },
      brainSignals: {
        activeFiles: ['sidecars/horizon-daemon/server.mjs', 'src/webview/advanced_view.html'],
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
    const sigK = parseDisplayedK(d.getElementById('advSignalTok').textContent);
    const reclK = parseDisplayedK(d.getElementById('advClutterTok').textContent);
    const usedK = parseDisplayedK(d.getElementById('advUsedTok').textContent);
    assert.equal(Number((sigK + reclK).toFixed(1)), usedK, 'Active Signal + Reclaimable must equal Total Used to 0.1k');

    // Clicking Cell #18 updates aria-selected and the 1-line slice inspector
    grid.children[17].click();
    assert.equal(grid.children[17].getAttribute('aria-selected'), 'true');
    assert.match(d.getElementById('cellInspectorLeft').textContent, /Cell #18/);
    assert.match(d.getElementById('cellInspectorRight').textContent, /recall/);
    assert.match(d.getElementById('uTroughVal').textContent, /1 spec/);

    // 2. Strict AGENTS.md Invariant 2: Active source files NEVER get +Ignore; .scratch/build.log DOES
    const consumerHtml = d.getElementById('advConsumersBody').innerHTML;
    assert.ok(!consumerHtml.includes('data-ignore-path="sidecars/horizon-daemon/server.mjs"'), 'Active .mjs file must never show +Ignore');
    assert.ok(!consumerHtml.includes('data-ignore-path="src/webview/horizon_panel.html"'), 'Active .html file must never show +Ignore');
    assert.ok(consumerHtml.includes('Protected source'), 'Active source files must display Protected source badge');
    const ignoreLogBtn = d.querySelector('[data-ignore-path=".scratch/build.log"]');
    assert.ok(ignoreLogBtn, 'Scratch log file must expose +Ignore button');

    // 3. Router Mode Switch -> POST /api/router/mode with CSRF
    const autoBtn = d.querySelector('[data-router-mode="autopilot"]');
    autoBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const routerCall = apiCalls.find((c) => c.url.includes('/api/router/mode'));
    assert.ok(routerCall, 'Router mode toggle must POST to /api/router/mode');
    assert.equal(routerCall.headers['X-Horizon-CSRF'], 'adv-csrf-token');
    assert.equal(routerCall.body.mode, 'autopilot');

    // 4. PrefixCacheShield Flush -> POST /api/shield/flush
    const shieldBtn = d.getElementById('btnFlushShield');
    assert.equal(shieldBtn.disabled, false);
    shieldBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/shield/flush')), 'Shield button must POST to /api/shield/flush');

    // 5. Verified Savings Receipt -> POST /api/savings/receipt
    d.getElementById('btnCopySavingsReceipt').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/savings/receipt')), 'Copy Receipt must POST to /api/savings/receipt');
    assert.ok(clipboardWrites.some((t) => t.includes('Highbeam Verified Receipt')), 'Must write verified receipt markdown to clipboard');

    // 6. Warm-Cache Guarded Primary CTA -> prefix-safe POST /api/tail/trim; Secondary #btnCondenseAst -> POST /api/prune (forceHotCache: true)
    assert.equal(d.getElementById('btnCompactPrimary').dataset.ctaState, 'guarded');
    d.getElementById('btnCompactPrimary').click();
    await new Promise((r) => setTimeout(r, 25));
    const tailCall = apiCalls.find((c) => c.url.includes('/api/tail/trim'));
    assert.ok(tailCall, 'Warm primary click must route to prefix-safe POST /api/tail/trim');

    // Reset state to warm guarded and click explicit secondary Fold AST button
    dom.window.renderState({
      sessionId: 'adv-warm-2',
      window: { maxTokens: 256000, safeLimit: 179000, totalActiveTokens: 108400 },
      breakdown: { ANCHOR: 8200, ACTIVE_WORKING_SET: 52000, DUPLICATE_READ: 38200, DEAD_ERROR: 10000 },
      quota: {
        cache: { hitRatePct: 95, ttlRemainingSec: 200, billingBlockRemainingSec: 2500, isCacheCold: false, cacheReadTokens: 96400 }
      }
    });
    d.getElementById('btnCondenseAst').click();
    assert.equal(d.getElementById('advStatusLabel').textContent, 'Memory Pruning Active', 'Must show instant <16ms pruning state');
    await new Promise((r) => setTimeout(r, 30));
    const forcePruneCall = apiCalls.find((c) => c.url.includes('/api/prune'));
    assert.ok(forcePruneCall, 'Secondary AST button must invoke POST /api/prune');
    assert.equal(forcePruneCall.body.forceHotCache, true, 'Secondary AST button must pass forceHotCache: true');

    dom.window.close();
  });

  it('serves GET /advanced from the live Horizon daemon with CSRF & state bootstrap injected', async () => {
    const { server, port, ipcServer } = await startServer(0);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/advanced`);
      assert.equal(resp.status, 200);
      const body = await resp.text();
      assert.ok(body.includes('id="highbeamAdvancedWorkbench"'), 'Must serve Advanced View workbench container');
      assert.ok(body.includes('window.__HORIZON_CSRF_TOKEN__'), 'Must inject per-boot CSRF token');
    } finally {
      if (ipcServer) {
        try { await ipcServer.close(); } catch (_err) { void _err; }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
