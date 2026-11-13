import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_SCENARIOS, buildDemoHorizonState } from '../src/demo/synthetic_states.mjs';
import { atomicWriteFileSync } from '../src/core/atomic_io.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { renderStatusLine, renderAbovePromptBand } from '../src/core-isomorphic/ui/modViews.mjs';

export function serializeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const webviewPath = path.join(rootDir, 'src', 'webview', 'horizon_panel.html');
const docsDir = path.join(rootDir, 'docs');

function mapDemoStateToClaudeState(agState = {}, meta = {}) {
  const totalTok = Number(agState.window?.totalActiveTokens || 62000);
  const bd = agState.breakdown || {};
  const qCache = agState.quota?.cache || {};
  const isWarm = !qCache.isCacheCold && Number(qCache.ttlRemainingSec || 0) > 0;
  const cachedRead = isWarm ? Math.max(0, Number(qCache.cacheReadTokens || Math.round(totalTok * 0.62))) : 0;
  const systemTok = Number(bd.ANCHOR || 0) + Number(bd.INJECTED_MEMORY || 0);
  const debtTok = Number(bd.DUPLICATE_READ || 0) + Number(bd.STALE_TURN || 0) + Number(bd.DEAD_ERROR || 0);
  const freshWriteTok = Math.max(0, totalTok - cachedRead - systemTok);
  const modelMap = {
    1: 'claude-haiku-5-5',
    2: 'claude-sonnet-5-5',
    3: 'claude-sonnet-5-5',
    4: 'claude-sonnet-5-5',
    5: 'claude-opus-5-5',
    6: 'claude-sonnet-5-5',
    7: 'claude-opus-5-5',
    8: 'claude-sonnet-5-5'
  };
  const claudeModel = modelMap[meta.id] || 'claude-sonnet-5-5';
  const savedTok = meta.id === 1 ? 0 : Math.round((totalTok * 0.45) + 12400);
  const savedUsd = Number((savedTok * 0.0000045).toFixed(2));
  const subWorkers = (agState.subagents?.invocations || []).map((inv, idx) => ({
    agentId: `${inv.typeName || 'worker'}-${idx + 1}`,
    state: 'working',
    totalTokens: Number(inv.childTokens || 38000),
    turns: 4
  }));

  return {
    state: {
      sessionId: agState.sessionId || `claude-demo-${meta.id}`,
      model: claudeModel,
      modelId: claudeModel,
      flightMode: meta.id === 5 || meta.id === 7 ? 'AUTO_PILOT' : 'COACH',
      totalInputTokens: totalTok,
      systemSchemaTokens: systemTok,
      cacheReadTokens: cachedRead,
      staleDebtTokens: debtTok,
      cacheCreationTokens: freshWriteTok,
      ttlRemainingSec: Number(qCache.ttlRemainingSec || 0),
      cacheTtlTier: qCache.dualTtl?.mainWindowLabel === '1h' ? '1h' : '5m',
      sessionSavedTokens: savedTok,
      sessionSavedUSD: savedUsd,
      workspace30dSavedTokens: savedTok * 14 + 185000,
      workspace30dSavedUSD: Number((savedUsd * 14 + 1.42).toFixed(2)),
      readsPerWriteRatio: isWarm ? 3.4 : 0.0,
      cliffTriggered: meta.id === 5,
      preCliffWarningTriggered: meta.id === 4,
      swarmTopology: subWorkers.length > 0 ? { active: true, workers: subWorkers } : { active: false, workers: [] }
    },
    options: {
      offenders: (agState.offenders || []).map((o) => ({
        name: o.target || 'src/core/router.mjs',
        tokens: Number(o.wastedTokens || 0),
        category: o.category === 'DEAD_ERROR' ? '[D]' : '[D]'
      })),
      breakerVerdict: (meta.id === 4 || meta.id === 5)
        ? { triggered: true, detectorId: meta.id === 5 ? 'DET-11' : 'DET-06', reason: meta.recommendedAction }
        : { triggered: false }
    }
  };
}

export function buildDemoPage(options = {}) {
  const customStates = options.precomputedStates || null;
  const customMeta = options.demoScenarios || DEMO_SCENARIOS;
  const outPath = options.outPath || path.join(docsDir, 'index.html');

  if (!fs.existsSync(path.dirname(outPath))) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
  }

  const rawHtml = fs.readFileSync(webviewPath, 'utf8');

  const precomputedStates = customStates || {};
  if (!customStates) {
    for (const s of customMeta) {
      precomputedStates[s.id] = buildDemoHorizonState(s.id);
    }
  }

  const claudeDemos = {};
  for (const m of customMeta) {
    const agSt = precomputedStates[m.id] || buildDemoHorizonState(m.id);
    const { state: ccSt, options: ccOpts } = mapDemoStateToClaudeState(agSt, m);
    const panelRes = renderHorizonPanelHtml(ccSt, ccOpts);
    const statusRes = renderStatusLine(ccSt, { ...ccOpts, columns: 144, ansi: false });
    const aboveRes = renderAbovePromptBand(ccSt, { ...ccOpts, ansi: false });
    claudeDemos[m.id] = {
      studioHtml: panelRes.html,
      statusLine: statusRes.plainLine,
      abovePrompt: aboveRes.plainBand || statusRes.plainLine,
      modelId: ccSt.modelId
    };
  }

  const demoInjector = `
<!-- Attention Horizon Interactive GitHub Pages Demo Harness -->
<style>
  #chDemoBar {
    position: sticky;
    top: 0;
    z-index: 99999;
    background: linear-gradient(90deg, #090d16 0%, #111827 100%);
    border-bottom: 1px solid #334155;
    padding: 8px 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    color: #f8fafc;
    box-shadow: 0 4px 12px rgba(0,0,0,0.45);
  }
  #chDemoBar .ch-brand {
    font-weight: 700;
    font-size: 13px;
    color: #38bdf8;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #chSurfaceToggle {
    display: inline-flex;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 6px;
    overflow: hidden;
  }
  #chSurfaceToggle button {
    background: transparent;
    color: #94a3b8;
    border: none;
    padding: 4px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  #chSurfaceToggle button.active {
    background: #0284c7;
    color: #f8fafc;
  }
  #chDemoBar select {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid #475569;
    border-radius: 5px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  #chDemoBar .ch-complaint {
    font-size: 11.5px;
    color: #fbbf24;
    flex: 1 1 100%;
    padding-top: 2px;
  }
  #chDemoBar .ch-cta {
    background: #22c55e;
    color: #052e16;
    text-decoration: none;
    font-size: 11.5px;
    font-weight: 700;
    padding: 5px 10px;
    border-radius: 5px;
  }
  #ccDemoMount {
    display: none;
    max-width: 980px;
    margin: 14px auto;
    padding: 0 12px 24px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  #ccDemoMount .cc-term-box {
    background: #090d16;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 14px;
    color: #e2e8f0;
    font-size: 12px;
    line-height: 1.55;
    overflow-x: auto;
  }
  #ccDemoMount .cc-term-hdr {
    color: #38bdf8;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  #ccStudioFrame {
    width: 440px;
    max-width: 100%;
    height: 700px;
    border: 1px solid #334155;
    border-radius: 10px;
    background: #0b0f19;
    display: block;
    margin: 0 auto;
  }
  body[data-demo-surface="claude"] > *:not(#chDemoBar):not(#ccDemoMount):not(script):not(style) {
    display: none !important;
  }
  body[data-demo-surface="claude"] #ccDemoMount {
    display: block !important;
  }
</style>
<script>
  (function() {
    const SCENARIOS = ${serializeScriptJson(precomputedStates)};
    const CC_DEMOS = ${serializeScriptJson(claudeDemos)};
    const META = ${serializeScriptJson(customMeta)};
    const urlParams = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search) : new URLSearchParams();
    let activeScenarioId = urlParams.has('scenario') ? Number(urlParams.get('scenario')) : 5;
    let activeSurface = urlParams.get('surface') === 'claude' ? 'claude' : 'antigravity';

    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async function(url, opts) {
      const u = String(url || '');
      if (u.includes('/api/state')) {
        return {
          ok: true,
          status: 200,
          json: async () => SCENARIOS[activeScenarioId]
        };
      }
      if (u.includes('/api/settings')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            settings: { safeLimitTokens: 140000, reminderAtPct: 85, modelOverrides: {} },
            limits: { minSafeTokens: 20000, maxSafeTokens: 1048576 }
          })
        };
      }
      if (u.includes('/api/prune')) {
        activeScenarioId = 2;
        const sel = document.getElementById('chScenarioSelect');
        if (sel) sel.value = '2';
        updateComplaintBanner();
        renderClaudeDemoSurface();
        setTimeout(() => { if (typeof window.renderState === 'function') window.renderState(SCENARIOS[2]); }, 50);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            prunedSteps: 6,
            savedTokens: 81000,
            state: SCENARIOS[2]
          })
        };
      }
      if (u.includes('/api/host/reap')) {
        SCENARIOS[activeScenarioId].hostHealth = { orphanCount: 0, orphanRamMb: 0, rssGb: 1.0, status: 'OK', orphans: [] };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            reapedCount: 2,
            freedMb: 570,
            state: SCENARIOS[activeScenarioId]
          })
        };
      }
      if (u.includes('/api/handoff')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            relativePath: 'docs/HANDOFF_DEMO.md'
          })
        };
      }
      if (u.includes('/api/hooks/dampen')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true
          })
        };
      }
      if (u.includes('/api/rules/promote')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            insertedAtLine: 12,
            totalLinesAfter: 84,
            zoneUsed: 'primacy',
            targetPath: 'AGENTS.md'
          })
        };
      }
      if (u.includes('/api/open-brain')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            surfaceTag: '[App]',
            brainDir: '~/.gemini/antigravity/brain/demo'
          })
        };
      }
      if (origFetch) return origFetch(url, opts);
      return { ok: true, status: 200, json: async () => ({}) };
    };

    window.EventSource = class MockEventSource {
      constructor() {
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage({ data: JSON.stringify(SCENARIOS[activeScenarioId]) });
          }
        }, 60);
      }
      addEventListener() {}
      close() {}
    };

    function updateComplaintBanner() {
      const m = META.find(x => x.id === Number(activeScenarioId)) || META[4];
      const el = document.getElementById('chComplaintText');
      if (el) {
        el.textContent = 'Failure Mode: "' + m.complaint + '"  ->  Router Action: ' + m.recommendedAction;
      }
    }

    function renderClaudeDemoSurface() {
      const cc = CC_DEMOS[activeScenarioId] || CC_DEMOS[5];
      const statusEl = document.getElementById('ccDemoStatusLine');
      const aboveEl = document.getElementById('ccDemoAbovePrompt');
      const frameEl = document.getElementById('ccStudioFrame');
      if (statusEl && cc) statusEl.textContent = cc.statusLine;
      if (aboveEl && cc) aboveEl.textContent = cc.abovePrompt;
      if (frameEl && cc) frameEl.srcdoc = cc.studioHtml;
    }

    function setDemoSurface(nextSurface) {
      activeSurface = nextSurface === 'claude' ? 'claude' : 'antigravity';
      document.body.dataset.demoSurface = activeSurface;
      const ccEl = document.getElementById('ccDemoMount');
      if (ccEl) ccEl.classList.toggle('active', activeSurface === 'claude');
      const btnAg = document.getElementById('btnSurfaceAntigravity');
      const btnCc = document.getElementById('btnSurfaceClaude');
      if (btnAg) btnAg.classList.toggle('active', activeSurface === 'antigravity');
      if (btnCc) btnCc.classList.toggle('active', activeSurface === 'claude');
      renderClaudeDemoSurface();
    }
    window.__setDemoSurface = setDemoSurface;

    function initDemoHarness() {
      if (document.getElementById('chDemoBar')) return;
      const bar = document.createElement('div');
      bar.id = 'chDemoBar';
      bar.innerHTML = \`
        <div class="ch-brand">⚡ Attention Horizon (ah v4.0) — Live Interactive Demo</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div id="chSurfaceToggle" role="group" aria-label="Host IDE Surface">
            <button type="button" id="btnSurfaceAntigravity" class="active" data-surface="antigravity">Antigravity IDE</button>
            <button type="button" id="btnSurfaceClaude" data-surface="claude">Claude Code Studio + CLI</button>
          </div>
          <label for="chScenarioSelect" style="font-size:11.5px;color:#94a3b8;">Scenario:</label>
          <select id="chScenarioSelect">
            \${META.map(m => \`<option value="\${m.id}" \${m.id === 5 ? 'selected' : ''}>\${m.title}</option>\`).join('')}
          </select>
          <a class="ch-cta" href="https://github.com/Gizzant/attention-horizon-antigravity" target="_blank" rel="noopener">★ Star on GitHub</a>
        </div>
        <div id="chComplaintText" class="ch-complaint"></div>
      \`;
      document.body.prepend(bar);

      const ccMount = document.createElement('section');
      ccMount.id = 'ccDemoMount';
      ccMount.innerHTML = \`
        <div class="cc-term-box">
          <div class="cc-term-hdr">Claude Code Terminal StatusLine (bin/ah-statusline.mjs · 144 cols)</div>
          <div id="ccDemoStatusLine" style="white-space:pre;"></div>
          <div class="cc-term-hdr" style="margin-top:10px;">Tier-1 Pure-V8 Studio Mod — AbovePrompt Band (hooks/register.js)</div>
          <div id="ccDemoAbovePrompt" style="white-space:pre-wrap;color:#cbd5e1;"></div>
        </div>
        <iframe id="ccStudioFrame" title="Claude Code Attention Horizon Studio HUD"></iframe>
      \`;
      bar.insertAdjacentElement('afterend', ccMount);

      updateComplaintBanner();
      setDemoSurface(activeSurface);

      document.getElementById('btnSurfaceAntigravity')?.addEventListener('click', () => setDemoSurface('antigravity'));
      document.getElementById('btnSurfaceClaude')?.addEventListener('click', () => setDemoSurface('claude'));

      const sel = document.getElementById('chScenarioSelect');
      if (sel && urlParams.has('scenario')) {
        sel.value = String(activeScenarioId);
      }
      if (urlParams.has('view')) {
        const viewMode = urlParams.get('view');
        const tabBtn = document.querySelector('[data-view-tab="' + viewMode + '"]');
        if (tabBtn) tabBtn.click();
      }
      sel.addEventListener('change', (e) => {
        activeScenarioId = Number(e.target.value) || 5;
        updateComplaintBanner();
        renderClaudeDemoSurface();
        const st = SCENARIOS[activeScenarioId];
        if (typeof window.renderState === 'function') {
          window.renderState(st);
        } else if (typeof window.refreshTelemetry === 'function') {
          window.refreshTelemetry();
        }
      });
    }
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', initDemoHarness);
    } else {
      initDemoHarness();
    }
  })();
</script>
`;

  const bundledHtml = rawHtml.replace('<head>', () => `<head>\n${demoInjector}`);
  atomicWriteFileSync(outPath, bundledHtml);
  return { outPath, html: bundledHtml, bytes: Buffer.byteLength(bundledHtml, 'utf8') };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const res = buildDemoPage();
  console.log(`[Demo Page] Built standalone interactive GitHub Pages demo at ${res.outPath} (${res.bytes} bytes)`);
}
