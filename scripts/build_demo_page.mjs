import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_SCENARIOS, buildDemoHorizonState } from '../tests/fixtures/synthetic_states.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const webviewPath = path.join(rootDir, 'src', 'webview', 'horizon_panel.html');
const docsDir = path.join(rootDir, 'docs');

if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

const rawHtml = fs.readFileSync(webviewPath, 'utf8');

const precomputedStates = {};
for (const s of DEMO_SCENARIOS) {
  precomputedStates[s.id] = buildDemoHorizonState(s.id);
}

const demoInjector = `
<!-- Context Horizon Interactive GitHub Pages Demo Harness -->
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
</style>
<script>
  (function() {
    const SCENARIOS = ${JSON.stringify(precomputedStates)};
    const META = ${JSON.stringify(DEMO_SCENARIOS)};
    let activeScenarioId = 5;

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
            limits: { minSafeTokens: 50000, maxSafeTokens: 900000 }
          })
        };
      }
      if (u.includes('/api/prune')) {
        activeScenarioId = 2;
        const sel = document.getElementById('chScenarioSelect');
        if (sel) sel.value = '2';
        updateComplaintBanner();
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

    window.addEventListener('DOMContentLoaded', () => {
      const bar = document.createElement('div');
      bar.id = 'chDemoBar';
      bar.innerHTML = \`
        <div class="ch-brand">⚡ Context Horizon (ctxtop v3.1) — Live Interactive Demo</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <label for="chScenarioSelect" style="font-size:11.5px;color:#94a3b8;">Inspect Crisis Scenario:</label>
          <select id="chScenarioSelect">
            \${META.map(m => \`<option value="\${m.id}" \${m.id === 5 ? 'selected' : ''}>\${m.title}</option>\`).join('')}
          </select>
          <a class="ch-cta" href="https://github.com/Gizzant/context-horizon" target="_blank" rel="noopener">★ Star on GitHub</a>
        </div>
        <div id="chComplaintText" class="ch-complaint"></div>
      \`;
      document.body.prepend(bar);
      updateComplaintBanner();

      const sel = document.getElementById('chScenarioSelect');
      sel.addEventListener('change', (e) => {
        activeScenarioId = Number(e.target.value) || 5;
        updateComplaintBanner();
        const st = SCENARIOS[activeScenarioId];
        if (typeof window.renderState === 'function') {
          window.renderState(st);
        } else if (typeof window.refreshTelemetry === 'function') {
          window.refreshTelemetry();
        }
      });
    });
  })();
</script>
`;

const bundledHtml = rawHtml.replace('<head>', `<head>\n${demoInjector}`);
const outPath = path.join(docsDir, 'index.html');
fs.writeFileSync(outPath, bundledHtml, 'utf8');
console.log(`[Demo Page] Built standalone interactive GitHub Pages demo at ${outPath} (${Buffer.byteLength(bundledHtml)} bytes)`);
