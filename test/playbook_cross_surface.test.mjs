import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import {
  PLAYBOOK_REGIMES,
  computeNextPromptPlaybook,
  formatNextPromptPlaybookCli,
  formatNextPromptPlaybookOneLine
} from '../src/core-isomorphic/coach/nextPromptPlaybook.mjs';
import {
  renderAbovePromptBand,
  renderStatusLine,
  renderSimpleHudPane,
  stripAnsi
} from '../src/core-isomorphic/ui/modViews.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

const REGIME_FIXTURES = [
  {
    name: 'WARM_EFFORT_SAFE (Claude Sonnet 5.5)',
    expectedRegime: PLAYBOOK_REGIMES.WARM_EFFORT_SAFE,
    modelId: 'claude-sonnet-5-5',
    totalInputTokens: 60_000,
    cachedTokens: 48_000,
    cacheWarm: true,
    ttlRemainingSec: 210,
    safeLimitTokens: 200_000
  },
  {
    name: 'WARM_EFFORT_UNSAFE (Claude Sonnet 4.6)',
    expectedRegime: PLAYBOOK_REGIMES.WARM_EFFORT_UNSAFE,
    modelId: 'claude-sonnet-4-6',
    totalInputTokens: 55_000,
    cachedTokens: 48_000,
    cacheWarm: true,
    ttlRemainingSec: 200,
    safeLimitTokens: 200_000
  },
  {
    name: 'COLD_BOUNDARY (TTL expired)',
    expectedRegime: PLAYBOOK_REGIMES.COLD_BOUNDARY,
    modelId: 'claude-opus-5-5',
    totalInputTokens: 52_000,
    cachedTokens: 0,
    cacheWarm: false,
    ttlRemainingSec: 0,
    safeLimitTokens: 200_000
  },
  {
    name: 'NEAR_CLIFF (Claude 180k)',
    expectedRegime: PLAYBOOK_REGIMES.NEAR_CLIFF,
    modelId: 'claude-sonnet-5-5',
    totalInputTokens: 182_000,
    cachedTokens: 150_000,
    cacheWarm: true,
    ttlRemainingSec: 180,
    safeLimitTokens: 200_000
  },
  {
    name: 'WARM_EFFORT_UNVERIFIED (Gemini 4 Neon)',
    expectedRegime: PLAYBOOK_REGIMES.WARM_EFFORT_UNVERIFIED,
    modelId: 'gemini-4-neon',
    host: 'antigravity',
    totalInputTokens: 55_000,
    cachedTokens: 48_000,
    cacheWarm: true,
    ttlRemainingSec: 200,
    safeLimitTokens: 179_000
  }
];

function buildClaudeSurfaceState(fx, nowMs) {
  return {
    sessionId: `pb-contract-${fx.expectedRegime}`,
    model: fx.modelId,
    modelId: fx.modelId,
    contextWindow: {
      totalInputTokens: fx.totalInputTokens,
      contextWindowSize: 200_000,
      safeLimit: fx.safeLimitTokens,
      systemAndMcpTokens: 8_000,
      cachedTokens: fx.cachedTokens,
      cacheReadTokens: fx.cachedTokens,
      distractorTokens: Math.max(0, fx.totalInputTokens - fx.cachedTokens - 8_000)
    },
    promptCache: {
      warm: fx.cacheWarm,
      ttl: '5m',
      expiresAt: fx.cacheWarm ? nowMs + fx.ttlRemainingSec * 1000 : nowMs - 1000
    },
    cumulative: { cacheReadTokens: fx.cachedTokens, netCacheSavingsUSD: 0.42 }
  };
}

describe('Next-Prompt Playbook Cross-Surface Contract (CLI + Claude Code + Antigravity WebView)', () => {
  it('renders identical core Playbook verdicts across CLI, Claude statusLine/AbovePrompt/Pane/HTML, and Antigravity WebView', async () => {
    const nowMs = 1_760_000_000_000;
    const rawHtml = fs.readFileSync(HTML_PATH, 'utf8')
      .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const jsdomErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));

    const dom = new JSDOM(rawHtml, {
      url: 'http://127.0.0.1:62935/simple',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.__INITIAL_VIEW_MODE__ = 'simple';
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: false, status: 204, json: async () => null });
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        win.sidecar = { onWorkspaceChange() {} };
      }
    });

    const d = dom.window.document;
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      await new Promise((r) => setTimeout(r, 60));

      for (const fx of REGIME_FIXTURES) {
        const core = computeNextPromptPlaybook({
          host: fx.host || 'claude',
          modelId: fx.modelId,
          cachedTokens: fx.cachedTokens,
          totalTokens: fx.totalInputTokens,
          safeLimit: fx.safeLimitTokens,
          cacheWarm: fx.cacheWarm,
          cacheTtlTier: '5m',
          ttlRemainingSec: fx.ttlRemainingSec
        });
        assert.equal(core.regime, fx.expectedRegime, fx.name);

        // 1. CLI formatter
        const cliText = formatNextPromptPlaybookCli(core);
        assert.ok(cliText.includes(core.badge), `CLI must include ${core.badge}`);
        assert.ok(formatNextPromptPlaybookOneLine(core, 40).length <= 40);

        // 2-5. Claude Code surfaces (Anthropic scenarios)
        if (!fx.host || fx.host === 'claude') {
          const ccState = buildClaudeSurfaceState(fx, nowMs);

          const st80 = renderStatusLine(ccState, { nowMs, columns: 80, includeDiskLedger: false });
          const st110 = renderStatusLine(ccState, { nowMs, columns: 110, includeDiskLedger: false });
          const st144 = renderStatusLine(ccState, { nowMs, columns: 144, includeDiskLedger: false });
          assert.ok(st80.visibleLength <= 80);
          assert.ok(st110.visibleLength <= 110);
          assert.ok(st144.visibleLength <= 144);
          assert.equal(st144.grid.cellCount, 40, 'Wide 144-col statusLine must preserve 40 horizon cells');
          assert.equal(st144.playbook.regime, core.regime);
          assert.ok(
            st144.plainLine.includes(core.compactHint) || st144.plainLine.includes(core.oneLine),
            `144-col statusLine must display Playbook hint for ${fx.name}: "${st144.plainLine}"`
          );

          const band80 = renderAbovePromptBand(ccState, { nowMs, maxCols: 80, includeDiskLedger: false });
          const band120 = renderAbovePromptBand(ccState, { nowMs, maxCols: 120, includeDiskLedger: false });
          const band136 = renderAbovePromptBand(ccState, { nowMs, maxCols: 136, includeDiskLedger: false });
          assert.ok(band80.plainLine.length <= 80);
          assert.equal(band80.playbook.regime, core.regime);
          assert.equal(band80.playbookHint, formatNextPromptPlaybookOneLine(core, 40));
          assert.ok(band120.plainLine.length <= 120);
          assert.ok(band136.plainLine.length <= 136);
          assert.ok(
            band136.plainLine.includes(core.compactHint) || band136.plainLine.includes(core.oneLine),
            `136-col AbovePrompt band must show Playbook hint for ${fx.name}: "${band136.plainLine}"`
          );

          const pane = renderSimpleHudPane(ccState, { nowMs, maxCols: 80, includeDiskLedger: false });
          assert.equal(pane.ranks.length, 4);
          assert.equal(pane.boxes.length, 5);
          assert.ok(pane.ranks[2].text.includes(core.badge), `Rank 3 must include ${core.badge}`);
          assert.match(pane.ranks[2].text, /Quick \(typo\/lookup\)/);
          for (const line of pane.text.split('\n')) {
            assert.ok(stripAnsi(line).length <= 80, `Mod pane exceeded 80 cols: "${line}"`);
          }

          const ccHtml = renderHorizonPanelHtml(ccState, { nowMs, includeDiskLedger: false });
          assert.equal(ccHtml.playbook.regime, core.regime);
          const ccDoc = new JSDOM(ccHtml.html).window.document;
          const ccPb = ccDoc.getElementById('ccPlaybookCard');
          assert.ok(ccPb && ccPb.closest('details') === null, 'Claude HTML HUD Playbook must be outside <details>');
          assert.equal(ccDoc.getElementById('ccPbRegimeBadge').textContent.trim(), core.badge);
          assert.equal(ccDoc.getElementById('ccGuidanceBadge').textContent.trim(), core.badge);
          assert.equal(ccDoc.querySelector('#ccPbRowQuick .cc-pb-cat').textContent.trim(), 'Quick \u00B7 typo/lookup');
          if (core.regime === PLAYBOOK_REGIMES.NEAR_CLIFF) {
            assert.equal(ccPb.querySelectorAll('button.cc-pb-copy').length, 0, 'NEAR_CLIFF rows stay plain text');
            assert.ok(ccDoc.getElementById('btnCompactPrimary'), 'Card 1 retains sole #btnCompactPrimary');
          } else if (core.regime === PLAYBOOK_REGIMES.WARM_EFFORT_SAFE) {
            assert.equal(ccPb.querySelectorAll('button.cc-pb-copy').length, 3, '5.5 warm renders 3 /effort Copy buttons');
          } else if (core.regime === PLAYBOOK_REGIMES.WARM_EFFORT_UNSAFE) {
            assert.equal(ccPb.querySelectorAll('button.cc-pb-copy').length, 0, '4.6 locked renders zero Copy buttons');
          }
        }

        // 6. Antigravity WebView JSDOM — verify both core-fed coachState and fallback parity without layout jump
        dom.window.renderState({
          sessionId: `wv-${fx.expectedRegime}`,
          storeSource: fx.host === 'antigravity' ? 'antigravity' : 'claude-code',
          model: { id: fx.modelId, canonicalId: fx.modelId, displayName: fx.modelId },
          window: { maxTokens: 256000, safeLimit: fx.safeLimitTokens, totalActiveTokens: fx.totalInputTokens },
          breakdown: { ANCHOR: 8000, ACTIVE_WORKING_SET: Math.max(0, fx.totalInputTokens - 8000) },
          quota: {
            cache: {
              cacheReadTokens: fx.cachedTokens,
              hitRatePct: fx.cacheWarm ? 92 : 0,
              ttlRemainingSec: fx.ttlRemainingSec,
              isCacheCold: !fx.cacheWarm
            }
          },
          coachState: { nextPromptPlaybook: core }
        });

        assert.equal(d.getElementById('tsSwitchDetailsDrawer').open, false, 'Drawer must not auto-open on regime change');
        assert.equal(d.getElementById('tsPlaybookCard').dataset.regime, core.regime);
        assert.equal(txt('tsPbRegimeBadge'), core.badge);
        assert.equal(txt('tsGuidanceBadge'), core.badge);
        assert.equal(d.querySelector('#tsPbRowQuick .ts-pb-cat').textContent.trim(), 'Quick \u00B7 typo/lookup');
        assert.equal(d.querySelector('#tsPbRowStandard .ts-pb-cat').textContent.trim(), 'Standard \u00B7 feature/bug');
        assert.equal(d.querySelector('#tsPbRowDeep .ts-pb-cat').textContent.trim(), 'Deep \u00B7 arch/refactor');
        if (core.regime === PLAYBOOK_REGIMES.NEAR_CLIFF) {
          assert.equal(d.querySelectorAll('#tsPlaybookCard .ts-pb-copy:not([hidden])').length, 0);
        }

        // Verify pure client fallback (without server-injected coachState.nextPromptPlaybook) also matches core regime
        dom.window.renderState({
          sessionId: `wv-fb-${fx.expectedRegime}`,
          storeSource: fx.host === 'antigravity' ? 'antigravity' : 'claude-code',
          model: { id: fx.modelId, canonicalId: fx.modelId, displayName: fx.modelId },
          window: { maxTokens: 256000, safeLimit: fx.safeLimitTokens, totalActiveTokens: fx.totalInputTokens },
          breakdown: { ANCHOR: 8000, ACTIVE_WORKING_SET: Math.max(0, fx.totalInputTokens - 8000) },
          quota: {
            cache: {
              cacheReadTokens: fx.cachedTokens,
              hitRatePct: fx.cacheWarm ? 92 : 0,
              ttlRemainingSec: fx.ttlRemainingSec,
              isCacheCold: !fx.cacheWarm
            }
          }
        });
        assert.equal(d.getElementById('tsPlaybookCard').dataset.regime, core.regime, `Fallback regime must match core for ${fx.name}`);
        assert.equal(txt('tsPbRegimeBadge'), core.badge, `Fallback badge must match core for ${fx.name}`);
      }
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});
