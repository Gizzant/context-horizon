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
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
  const dom = new JSDOM(rawHtml, {
    url: 'http://127.0.0.1:43210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.EventSource = class { close() {} };
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      win.sidecar = { onWorkspaceChange() {} };
    }
  });
  await new Promise((r) => setTimeout(r, 80));
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors };
}

function baseState(sessionId, extra = {}) {
  const steps = [
    { stepIndex: 0, type: 'SYSTEM_PROMPT', source: 'SYSTEM', status: 'DONE', content: 'rules/', inputTokens: 8000, outputTokens: 1000, toolCalls: [] },
    { stepIndex: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Update src/core/parser.mjs', outputTokens: 500, toolCalls: [] },
    { stepIndex: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '', outputTokens: 1500, toolCalls: [] }
  ];
  const st = classifyHorizon(steps, { sessionId, modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: WS });
  st.quota = st.quota || {};
  st.quota.cache = { ...(st.quota.cache || {}), cacheReadTokens: 0, hitRatePct: 0, isCacheCold: true, ttlRemainingSec: 0, nextTurnLikelyWarm: false };
  return Object.assign(st, extra);
}

describe('Simple view Next action: breakers, sharded spec, rule clashes & honest fillers', () => {
  it('surfaces new signals in tsDoText and removes fabricated filler values', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      win.renderState(baseState('nominal'));
      assert.match(txt('tsDoText'), /Safe to run multi-file edits/);
      assert.doesNotMatch(txt('tsGuardsSummary'), /\b32\b/, 'guard count must not be hard-coded');
      assert.doesNotMatch(txt('tsLedgerList'), /12\.4k/, 'no fabricated pinned-rules fallback');
      assert.equal(d.getElementById('tsKpiUsd').hidden, true, '~$0.00 hidden when nothing saved');
      assert.equal(d.getElementById('tsKpi30d').hidden, true, '30d hidden when nothing saved');

      win.renderState(baseState('clash', { rsl: { clashCount: 2 } }));
      assert.match(txt('tsDoText'), /2 conflicting rules detected .*ctxtop rsl status/);

      win.renderState(baseState('sharded', { shardedSpecCount: 5, rsl: { clashCount: 2 } }));
      assert.match(txt('tsDoText'), /Consolidate 5 scattered requirement changes .*ctxtop handoff --consolidate/);

      win.renderState(baseState('breaker', {
        shardedSpecCount: 5,
        coachState: { circuitBreakerAlerts: [{ detectorId: 'DET-03', reason: 'Test assertion weakened in parser.test.mjs' }] }
      }));
      assert.match(txt('tsDoText'), /Guard tripped \(DET-03\): Test assertion weakened/);
      assert.equal(d.getElementById('tsDoRow').dataset.tone, 'danger');

      win.renderState(baseState('guards', { coachState: { detectors: { totalCount: 41 } } }));
      assert.match(txt('tsGuardsSummary'), /41 guards armed/);
      assert.equal(d.getElementById('tsGuardList').hidden, true, 'roster hidden without a live list');

      win.renderState(baseState('roster', {
        coachState: {
          detectors: {
            totalCount: 3,
            list: [
              { id: 'DET-10', name: 'Idle 5m Implicit-Cache Watchdog', mode: 'advisory', tripped: false },
              { id: 'DET-01', name: 'Destructive Git/Shell Guard', mode: 'guard', tripped: false },
              { id: 'DET-05', name: 'Test-Weakening Guard', mode: 'guard', tripped: true }
            ]
          }
        }
      }));
      const roster = d.getElementById('tsGuardList');
      assert.equal(roster.hidden, false);
      assert.equal(txt('tsGuardListHead'), 'Live guards (3 \u00B7 1 tripped)');
      const rowIds = [...roster.querySelectorAll('.ts-ledger-age')].map((n) => n.textContent);
      assert.deepEqual(rowIds, ['DET-05', 'DET-01', 'DET-10'], 'tripped first, then blocking, then advisory');
      assert.match(roster.textContent, /tripped[\s\S]*blocks[\s\S]*advises/);
      assert.equal(d.getElementById('tsActivityDrawer').contains(roster), true, 'roster lives inside the click-to-expand drawer');

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});
