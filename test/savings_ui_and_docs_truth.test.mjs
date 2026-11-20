/**
 * @file test/savings_ui_and_docs_truth.test.mjs
 * Verifies 3-bucket savings separation across UI panes, receipts, WebView HUD,
 * VS Code statusBar formatter, and updated documentation benchmarks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

import {
  deriveSurfaceMetrics,
  renderSimpleViewPane,
  renderAdvancedViewPane,
  stripAnsi
} from '../src/core-isomorphic/ui/modViews.mjs';
import '../src/utils/nodeIo.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { generateCorporateExpenseReceipt } from '../src/core-isomorphic/ui/pdfReceiptGenerator.mjs';
import { SavedQuotaReceiptLedger } from '../src/core/coach/saved_quota_ledger.mjs';
import { getSavedQuotaReceiptSummary, recordInterventionSavings, recordTurnCacheSavings } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';

const require = createRequire(import.meta.url);
const { formatStatusBar } = require('../extensions/vscode-highbeam/src/statusBarFormatter.js');

const ROOT = process.cwd();
const WEBVIEW_HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

async function mountWebviewDom() {
  const html = fs
    .readFileSync(WEBVIEW_HTML_PATH, 'utf8')
    .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const jsdomErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:43199/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.EventSource = class MockEventSource {
        close() {}
      };
      window.fetch = async (url) => {
        const u = String(url || '');
        if (u.includes('/api/state')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };
      window.matchMedia =
        window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      window.sidecar = { onWorkspaceChange() {} };
    }
  });
  await new Promise((r) => setTimeout(r, 80));
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors };
}

describe('Savings UI, 3-Bucket Receipts & Benchmark Doc Truth', () => {
  it('separates Highbeam avoided writes from platform cache discount in modViews & horizonPanelHtml', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ui-buckets-'));
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    try {
      recordInterventionSavings(
        {
          sessionId: 'sess-bkt',
          category: 'BOUNDED_READ_ENFORCED',
          savedTokens: 12_400,
          savedUSD: 0.0372
        },
        { ledgerPath }
      );
      recordTurnCacheSavings(
        {
          sessionId: 'sess-bkt',
          turnIndex: 1,
          cacheReadTokens: 80_000,
          modelId: 'claude-sonnet-5-5'
        },
        { ledgerPath }
      );

      const summary = getSavedQuotaReceiptSummary({
        ledgerPath,
        activeSessionId: 'sess-bkt',
        sessionId: 'sess-bkt'
      });
      summary.buckets.realizedPromptBill = {
        tokens: -4_200,
        usd: -0.012,
        sessionTokens: -4_200,
        sessionUSD: -0.012,
        workspace30dTokens: -4_200,
        workspace30dUSD: -0.012,
        count: 1
      };

      const state = {
        sessionId: 'sess-bkt',
        model: 'claude-sonnet-5-5',
        totalInputTokens: 96_000,
        cacheReadTokens: 80_000,
        ttlRemainingSec: 180
      };
      const metrics = deriveSurfaceMetrics(state, { ledgerSummary: summary, includeDiskLedger: false });
      assert.equal(metrics.savingsBuckets.avoidedWrites.sessionTokens, 12_400);
      assert.ok(metrics.savingsBuckets.platformCacheDiscount.sessionTokens > 0);

      const simple = renderSimpleViewPane(state, {
        viewMode: 'SIMPLE_4_RANK',
        ledgerSummary: summary,
        includeDiskLedger: false,
        maxCols: 80,
        ansi: false
      });
      for (const line of simple.text.split('\n')) {
        assert.ok(stripAnsi(line).length <= 80, `Line exceeds 80 cols: ${line}`);
      }
      assert.match(simple.text, /Split : Avoided \+12\.4k · Provider cache \+/);

      const defaultBox = renderSimpleViewPane(state, {
        ledgerSummary: summary,
        includeDiskLedger: false,
        maxCols: 80,
        ansi: false
      });
      for (const line of defaultBox.text.split('\n')) {
        assert.ok(stripAnsi(line).length <= 80, `Box line exceeds 80 cols: ${line}`);
      }

      const adv = renderAdvancedViewPane(state, {
        ledgerSummary: summary,
        includeDiskLedger: false,
        ansi: false
      });
      assert.match(adv.text, /\[Section 1\] Estimated 5-Category Token Savings & Cache Efficiency/);
      assert.match(adv.text, /Highbeam Avoided Writes: \+12\.4k tok session/);
      assert.match(adv.text, /Platform Cache Discount \(provider KV\):/);
      assert.match(adv.text, /Ex-Post Realized Prompt-Bill: -4\.2k tok \(-\$0\.01\)/);

      const { html } = renderHorizonPanelHtml(state, {
        ledgerSummary: summary,
        includeDiskLedger: false
      });
      assert.match(html, /id="savedBucketAvoided"[\s\S]*?\+12\.4k tok/);
      assert.match(html, /id="savedBucketPlatformCache"/);
      assert.match(html, /id="savedBucketRealized"[\s\S]*?-4\.2k tok/);
      assert.match(html, /id="advBucketAvoided"[\s\S]*?\+12\.4k/);
      assert.ok(html.includes('npx ah receipt --pdf'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('copyPlainSavingsReceipt and generateCorporateExpenseReceipt keep avoided writes separate and avoid Verified API claims', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-rcpt-buckets-'));
    try {
      const ledger = new SavedQuotaReceiptLedger({
        dbPath: path.join(tmpDir, 'ledger.sqlite'),
        clipboardWriter: () => {}
      });
      const res = ledger.copyPlainSavingsReceipt({
        sessionId: 'sess-rcpt',
        liveSavings: {
          session: {
            totalTokens: 92_000,
            physicalTokensAvoided: 16_000,
            billingEquivalentCacheTokens: 76_000,
            estimatedUsd: 0.25,
            buckets: {
              avoidedWrites: { tokens: 16_000, usd: 0.048 },
              platformCacheDiscount: { tokens: 76_000, usd: 0.202 },
              realizedPromptBill: { tokens: -2_500, usd: -0.008 }
            },
            bySource: {
              subagentIsolated: 4_000,
              cachePreserved: 76_000,
              cliCompressed: 9_000,
              compactionReclaimed: 1_000,
              guardsPrevented: 2_000
            }
          },
          workspace30d: { totalTokens: 180_000, estimatedUsd: 0.49 }
        }
      });
      assert.equal(res.ok, true);
      assert.match(res.markdown, /\*\*Highbeam Avoided Writes:\*\* `\+16\.0k`/);
      assert.match(res.markdown, /\*\*Platform Prompt-Cache Discount \(Provider KV\):\*\* `\+76\.0k`/);
      assert.match(res.markdown, /\*\*Ex-Post Realized Prompt-Bill Delta:\*\* `-2\.5k`/);
      assert.doesNotMatch(res.markdown, /Warm prompt cache preserved \(95% off\)/);

      const corp = generateCorporateExpenseReceipt({
        sessionSavedTokens: 92_000,
        sessionSavedUSD: 0.25,
        workspace30dSavedTokens: 180_000,
        workspace30dSavedUSD: 45,
        buckets: {
          avoidedWrites: { workspace30dTokens: 32_000, usd: 0.1 },
          platformCacheDiscount: { workspace30dTokens: 148_000, usd: 0.39 }
        },
        byCategory: {
          POST_TOOL_USE_SANITIZER: { savedTokens: 20_000, savedUSD: 0.06 },
          DET_11_BOUNDED_READ: { savedTokens: 12_000, savedUSD: 0.04 }
        }
      });
      assert.match(corp.markdown, /\*\*30-Day Estimated API Savings\*\*/);
      assert.match(corp.markdown, /\*\*Highbeam Avoided Writes\*\* \| \*\*\+32,000 tokens\*\*/);
      assert.match(corp.markdown, /\*\*Platform Cache Discount \(Provider\)\*\* \| \*\*\+148,000 tokens\*\*/);
      assert.doesNotMatch(corp.markdown, /Verified API Savings/);
      assert.doesNotMatch(Buffer.from(corp.pdfBytes).toString('utf8'), /30-DAY VERIFIED LEDGER/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('horizon_panel.html renders separated bucket readouts in JSDOM and never fabricates splits on flat legacy payloads', async () => {
    const { dom, win, d, jsdomErrors } = await mountWebviewDom();
    try {
      // Case 1: explicit bucket breakdown
      win.renderState({
        sessionId: 'sess-wv-1',
        window: { totalActiveTokens: 84_000, safeLimit: 179_000, maxTokens: 256_000 },
        breakdown: { ANCHOR: 8_000, ACTIVE_WORKING_SET: 60_000, DUPLICATE_READ: 16_000 },
        savings: {
          session: {
            totalTokens: 94_000,
            physicalTokensAvoided: 18_000,
            billingEquivalentCacheTokens: 76_000,
            buckets: {
              avoidedWrites: { tokens: 18_000, usd: 0.05 },
              platformCacheDiscount: { tokens: 76_000, usd: 0.2 }
            },
            bySource: {
              subagentIsolated: 0,
              cachePreserved: 76_000,
              cliCompressed: 12_000,
              avoidedBloat: 6_000
            }
          },
          workspace30d: { totalTokens: 210_000 }
        }
      });

      assert.equal(d.getElementById('tsKpiSaved').textContent, '+94.0k');
      assert.equal(d.getElementById('tufteSavedTokensLabel').textContent, '+94.0k');
      assert.equal(d.getElementById('savAvoidedTotalVal').textContent, '+18.0k');
      assert.equal(d.getElementById('advSavAvoidedTotalVal').textContent, '+18.0k');
      assert.equal(d.getElementById('savCacheVal').textContent, '+76.0k');
      assert.equal(d.getElementById('tsHeroBuckets').hidden, false);
      assert.equal(d.getElementById('tsHeroBuckets').textContent, 'Highbeam avoided: +18.0k · Provider cache: +76.0k');

      // Case 2: flat legacy payload with zero breakdown must hide #tsHeroBuckets
      win.renderState({
        sessionId: 'sess-wv-2',
        window: { totalActiveTokens: 64_000, safeLimit: 179_000, maxTokens: 256_000 },
        breakdown: { ANCHOR: 8_000, ACTIVE_WORKING_SET: 56_000 },
        savings: {
          session: { totalTokens: 45_000 },
          workspace30d: { totalTokens: 45_000 }
        }
      });
      assert.equal(d.getElementById('tsKpiSaved').textContent, '+45.0k');
      assert.equal(d.getElementById('tsHeroBuckets').hidden, true);
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('statusBarFormatter includes separated bucket tooltip details when buckets are present', () => {
    const out = formatStatusBar(
      {
        model: { rawLabel: 'claude-sonnet-5-5' },
        window: { totalActiveTokens: 60_000, maxTokens: 200_000 },
        savings: {
          session: {
            totalTokens: 52_000,
            buckets: {
              avoidedWrites: { tokens: 12_000 },
              platformCacheDiscount: { tokens: 40_000 }
            }
          },
          workspace30d: { totalTokens: 90_000 }
        }
      },
      { connected: true, port: 43199 }
    );
    assert.match(out.tooltipMarkdown, /Tokens Saved.*52k chat/);
    assert.match(out.tooltipMarkdown, /Highbeam avoided: `\+12k` · Provider cache: `\+40k`/);
  });

  it('documentation reflects replicated 72-run benchmarks, T09-T11 null caveat, and zero banned strings', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const emp = fs.readFileSync(path.join(ROOT, 'docs', 'EMPIRICAL_BENCHMARKS.md'), 'utf8');
    const cookbook = fs.readFileSync(path.join(ROOT, 'docs', 'COOKBOOK.md'), 'utf8');
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const bannedRe = new RegExp(
      'Context Horizon|cc-attention-horizon|ga-' + 'visualizer-v2|file:///C:/' + 'Projects',
      'i'
    );

    for (const [name, content] of [
      ['README.md', readme],
      ['EMPIRICAL_BENCHMARKS.md', emp],
      ['CHANGELOG.md', changelog]
    ]) {
      assert.ok(content.includes('-13.31%'), `${name} must cite -13.31% mean billed cost`);
      assert.ok(content.includes('-14.39%'), `${name} must cite -14.39% median paired delta`);
      assert.ok(content.includes('-24.31%'), `${name} must cite -24.31% prompt-bill reduction`);
      assert.ok(content.includes('T09'), `${name} must document T09-T11 code-exploration null result`);
      assert.ok(content.includes('ah-haiku-scout'), `${name} must document opt-in ah-haiku-scout`);
      assert.doesNotMatch(content, bannedRe);
    }

    assert.match(readme, /96%`? token reduction|96%/);
    assert.ok(readme.includes('19 noisy CLI fixtures') || readme.includes('19-fixture'));
    assert.ok(emp.includes('$1.2346') && emp.includes('$1.3195') && emp.includes('$1.4085'));
    assert.ok(cookbook.includes('Highbeam Avoided Writes') && cookbook.includes('Platform Cache Discount'));
  });
});
