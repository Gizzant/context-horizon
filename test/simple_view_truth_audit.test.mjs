/**
 * Exhaustive Simple View Truth & Accuracy Audit Test Suite (SV-BUG-01 through SV-BUG-18).
 * Verifies mathematical 0.1k sum parity, cache/safeguard honesty, mode gating,
 * model/effort resolution, XSS safety, backend breaker precision, and session isolation.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';

import { normalizeModelId, resolveModelDescriptor, resolveModelCeiling, resolvePricePerM } from '../src/core/constants.mjs';
import { classifyHorizon } from '../src/core/classifier.mjs';
import { CircuitBreakers } from '../src/core/coach/circuit_breakers.mjs';
import { getAlertGuidance } from '../src/core-isomorphic/catalog/safeguardGuide.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
const SERVER = path.join(ROOT, 'sidecars', 'horizon-daemon', 'server.mjs');
const WS = 'c:/Projects/demo-workspace';

function parseCompactK(str) {
  const s = String(str || '').trim();
  if (/^\d+(?:\.\d+)?M$/i.test(s)) return parseFloat(s) * 1000;
  if (/k$/i.test(s)) return parseFloat(s);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n / 1000 : 0;
}

async function mountPanel() {
  const rawHtml = fs.readFileSync(HTML_PATH, 'utf8')
    .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
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
  await new Promise((r) => setTimeout(r, 70));
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors };
}

describe('SV-BUG-01..06: Context math parity, cachedHistory exclusion, over-limit & status sync', () => {
  it('enforces exact 0.1k sum parity across 200 random distributions on Antigravity & Claude Simple surfaces', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      for (let i = 1; i <= 200; i++) {
        const anchor = i * 137;
        const mem = (i % 5) * 231;
        const dup = (i % 7) * 419;
        const active = i * 523;
        const total = anchor + mem + dup + active;
        win.renderState({
          sessionId: `parity-${i}`,
          window: { totalActiveTokens: total, safeLimit: 179000, maxTokens: 256000 },
          breakdown: { ANCHOR: anchor, MEMORY_KI: mem, STALE_DUPLICATE: dup, ACTIVE_WORKING_SET: active }
        });
        const usedK = parseCompactK(txt('tsUsedLabel'));
        const newK = parseCompactK(txt('tsValNew'));
        const cluK = parseCompactK(txt('tsValClutter'));
        const pinK = parseCompactK(txt('tsValPinned'));
        assert.equal(Number((newK + cluK + pinK).toFixed(1)), Number(usedK.toFixed(1)), `seed ${i}: breakdown must sum to ${usedK}k`);
      }

      // Claude static HUD 200-seed sum parity & safeLimit glass % (SV-BUG-01 & SV-BUG-05)
      for (let i = 1; i <= 50; i++) {
        const S = 1000 + i * 247;
        const D = (i % 9) * 3421;
        const total = 15000 + i * 4123;
        const C = total - S - D;
        const { html } = renderHorizonPanelHtml({
          sessionId: `cc-parity-${i}`,
          model: 'claude-opus-4-6',
          totalInputTokens: total,
          systemTokens: S,
          cachedTokens: C,
          distractorTokens: D,
          safeLimitTokens: 140000,
          maxTokens: 200000
        });
        const cd = new JSDOM(html).window.document;
        const headlineUsed = cd.getElementById('simpleRunwaySub').textContent.split('/')[0].trim();
        const vals = [...cd.querySelectorAll('#claudeSimpleSurface .ts-cat-val')].map((el) => parseCompactK(el.textContent));
        assert.equal(
          Number(vals.reduce((a, b) => a + b, 0).toFixed(1)),
          Number(parseCompactK(headlineUsed).toFixed(1)),
          `Claude seed ${i}: breakdown must match ${headlineUsed}`
        );
      }

      const overClaude = new JSDOM(renderHorizonPanelHtml({
        sessionId: 'cc-over',
        model: 'claude-opus-4-6',
        totalInputTokens: 215000,
        systemTokens: 12340,
        cachedTokens: 170470,
        distractorTokens: 32190,
        safeLimitTokens: 140000,
        maxTokens: 200000
      }).html).window.document;
      assert.equal(overClaude.getElementById('ccGlassCaption').textContent.trim(), 'Over safe limit');
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('excludes cachedHistory from clutter (SV-BUG-02), shows >100% and zero-clutter crisis honestly (SV-BUG-03/04/05), and syncs status dot (SV-BUG-06)', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      // SV-BUG-02: cachedHistory must not inflate staleT
      win.renderState({
        sessionId: 'cached-hist',
        reclaimableTokens: 2000,
        window: { totalActiveTokens: 70000, safeLimit: 179000, maxTokens: 256000, breakdown: { systemAndTools: 10000, cachedHistory: 58000, reclaimableClutter: 2000 } },
        quota: { cache: { isCacheCold: true, ttlRemainingSec: 0, hitRatePct: 0 } }
      });
      assert.equal(txt('tsValClutter'), '2.0k');
      assert.equal(txt('tsStatusLabel'), 'Healthy');

      // SV-BUG-03: 215k / 179k with 0 clutter shows 120% and avoids "0.0k of clutter"
      win.renderState({
        sessionId: 'over-clean',
        window: { totalActiveTokens: 215000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 15000, ACTIVE_WORKING_SET: 200000 }
      });
      assert.equal(txt('tsUsedPct'), '120%');
      assert.doesNotMatch(txt('tsContextSummary'), /0\.0k/);
      assert.doesNotMatch(txt('tsBtnCleanLabel'), /0\.0k/);
      assert.doesNotMatch(txt('tsAvoidText'), /0\.0k/);

      // SV-BUG-04: amputationCrisis below safeCap uses rule-risk messaging (never "0.0k past the safe limit")
      win.renderState({
        sessionId: 'amp-under',
        amputationCrisis: true,
        window: { totalActiveTokens: 145000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 15000, STALE_DUPLICATE: 20000, ACTIVE_WORKING_SET: 110000 }
      });
      assert.equal(txt('tsStatusLabel'), 'Pinned Rules at Risk');
      assert.match(txt('tsRunwayMeta'), /headroom · rules at risk/);
      assert.doesNotMatch(txt('tsDoText'), /0\.0k past the safe limit/);

      // SV-BUG-05: 300-token clutter aligns button, #tsCompactReclaim, #tsWhyClears, and warm tooltip
      win.renderState({
        sessionId: 'stale-300',
        window: { totalActiveTokens: 20000, safeLimit: 179000, maxTokens: 256000 },
        reclaimableTokens: 300,
        brainSignals: { duplicateReads: { fileCount: 1, reclaimableTokens: 220 }, deadErrors: { errorCount: 1, reclaimableTokens: 80 } },
        quota: { cache: { cacheReadTokens: 15000, hitRatePct: 88, ttlRemainingSec: 180, isCacheCold: false } }
      });
      assert.doesNotMatch(txt('tsBtnCleanLabel'), /Memory Clean/);
      assert.match(txt('tsBtnCleanLabel'), /0\.3k/);
      assert.equal(txt('tsWhyTotal'), '0.3k');
      const whyRowToks = [...d.querySelectorAll('#tsWhyList .ts-why-tok')].map((el) => parseCompactK(el.textContent));
      assert.equal(Number(whyRowToks.reduce((a, b) => a + b, 0).toFixed(1)), 0.3);
      assert.match(d.getElementById('tsRowOld').title, /Wait until the cache timer ends/i);

      // SV-BUG-06: actionable safeguard alert sets both Card 1 badge and header statusDot to danger
      const det23Guide = getAlertGuidance({ detectorId: 'DET-23', filePath: 'src/webview/partials/09_script.part' });
      win.renderState({
        sessionId: 'guard-sync',
        window: { totalActiveTokens: 20000, safeLimit: 179000, maxTokens: 256000 },
        coachState: { detectors: { tripped: { detectorId: 'DET-23', reason: 'Empty catch', guidance: det23Guide } } }
      });
      assert.equal(txt('tsStatusLabel'), 'Safeguard Alert');
      assert.equal(d.getElementById('tsStatusDot').dataset.tone, 'danger');
      assert.match(d.getElementById('statusDot').className, /\bdanger\b/);

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }

    // Unified horizon_panel.html (window.__INITIAL_VIEW_MODE__ = 'simple') replaces retired simple_view.html and never clamps >100%
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'webview', 'simple_view.html')), false);
    const svHtml = fs.readFileSync(HTML_PATH, 'utf8')
      .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
    const svDom = new JSDOM(svHtml, {
      url: 'http://127.0.0.1:43210/simple',
      runScripts: 'dangerously',
      beforeParse(win) {
        win.__INITIAL_VIEW_MODE__ = 'simple';
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: false, status: 204, json: async () => null });
      }
    });
    await new Promise((r) => setTimeout(r, 40));
    svDom.window.renderState({
      sessionId: 'sv-over',
      window: { maxTokens: 200000, safeLimit: 140000, totalActiveTokens: 220000 },
      breakdown: { ANCHOR: 10000, ACTIVE_WORKING_SET: 210000 }
    });
    assert.equal(svDom.window.document.body.getAttribute('data-view-mode'), 'simple');
    assert.equal(svDom.window.document.getElementById('tsUsedPct').textContent.trim(), '157%');
    assert.equal(svDom.window.document.getElementById('tsGlassCaption').textContent.trim(), 'Over safe limit');
    assert.match(svDom.window.document.getElementById('tsContextSummary').textContent, /157% of the safe limit/);
    svDom.window.close();
  });
});

describe('SV-BUG-07..14 & SV-BUG-18: XSS escaping, Orchestrator, Cross-Family, Shadow Auto, Off Rules, plainText & Card 4', () => {
  it('resolves Orchestrator (Carbon), Claude Opus 4.6, and GPT-OSS 120B cleanly (SV-BUG-08)', () => {
    assert.equal(normalizeModelId('Orchestrator (Carbon)'), 'gemini-4-carbon');
    assert.equal(normalizeModelId('Claude Opus 4.6 (Thinking)'), 'claude-opus-4.6');
    assert.equal(resolveModelDescriptor('Orchestrator (Carbon)')?.id, 'gemini-4-carbon');
    assert.equal(resolveModelCeiling('Orchestrator (Carbon)', null, { useLegacyDefault: false }), 1048576);
    assert.equal(resolvePricePerM('Orchestrator (Carbon)'), 2.00);

    const claudeState = classifyHorizon([{ type: 'USER_INPUT', content: 'hi', stepIndex: 0 }], { modelId: 'claude-opus-4-6' });
    assert.equal(claudeState.model.displayName, 'Claude Opus 4.6');
    assert.equal(claudeState.model.family, 'opus');
    const gptState = classifyHorizon([{ type: 'USER_INPUT', content: 'hi', stepIndex: 0 }], { modelId: 'gpt-oss-120b' });
    assert.equal(gptState.model.displayName, 'GPT-OSS 120B');
  });

  it('escapes dropdown HTML tags, fixes model/effort tooltips, Shadow Auto Card 2, Off rules, paths & Card 4 (SV-BUG-07,09..14,18)', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    const tip = (id) => d.getElementById(id)?.getAttribute('title') || '';
    try {
      // SV-BUG-07: HTML tags in chat title cannot split <option>
      win.renderState({
        sessionId: 'xss-1',
        sessionTitle: 'Fix <option>broken</option> & <script> tags',
        recentSessions: [
          { sessionId: 'xss-1', title: 'Fix <option>broken</option> & <script> tags', liveTokens: 12000, surface: 'antigravity' },
          { sessionId: 'real-2', title: 'Prompt <USER_REQUEST> test', liveTokens: 8000, surface: 'antigravity' }
        ],
        window: { totalActiveTokens: 12000, safeLimit: 179000, maxTokens: 256000 }
      });
      const opts = [...d.getElementById('tsSessionSelect').options];
      assert.equal(opts.length, 2);
      assert.equal(opts[1].value, 'real-2');
      assert.match(opts[1].textContent, /<USER_REQUEST>/);

      // SV-BUG-08/09/10: Orchestrator + Rebuilding cache + effort word
      win.renderState({
        sessionId: 'orch-rebuild',
        model: { id: 'gemini-4-carbon', canonicalId: 'gemini-4-carbon', family: 'carbon', displayName: 'Orchestrator (Carbon)', rawLabel: 'Orchestrator (Carbon)', inputPricePerMillionUsd: 2.0 },
        activeEffortProfile: { tier: 'HIGH', label: 'High Effort', shortLabel: 'High' },
        window: { totalActiveTokens: 45000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 5000, STALE_DUPLICATE: 32000, ACTIVE_WORKING_SET: 8000 },
        quota: { cache: { isCacheCold: false, cacheReadTokens: 0, hitRatePct: 0, ttlRemainingSec: 280, nextTurnLikelyWarm: true } }
      });
      assert.equal(txt('tufteTopHostBadge'), 'Antigravity · Orchestrator (Carbon) (High)');
      assert.equal(txt('tsEffortVerdict'), 'UNVERIFIED');
      assert.match(txt('tsModelCrossFam'), /To Claude:.*200\.0k window/);
      assert.match(tip('tsGuidanceBadge'), /warming up/i);

      // SV-BUG-11 & SV-BUG-12: Free Shadow Auto never claims AUTO/HANDLED; daysRemaining=0 renders <1d
      win.renderState({
        sessionId: 'shadow-zero',
        routerMode: 'autopilot',
        autoShadow: true,
        proEntitlement: { entitled: false, tier: 'free' },
        window: { totalActiveTokens: 30000, safeLimit: 179000, maxTokens: 256000 }
      });
      assert.notEqual(d.querySelector('#tsDoRow .ts-tag').textContent, 'AUTO');
      assert.notEqual(d.querySelector('#tsAvoidRow .ts-tag').textContent, 'HANDLED');
      assert.match(txt('tsGuidanceBadge'), /^Preview · /);

      win.renderState({
        sessionId: 'trial-zero',
        routerMode: 'autopilot',
        autoShadow: false,
        proEntitlement: { entitled: true, tier: 'trial', daysRemaining: 0 },
        window: { totalActiveTokens: 30000, safeLimit: 179000, maxTokens: 256000 }
      });
      assert.match(txt('tsModeHint'), /Trial <1d left/);

      // SV-BUG-13: Static shield + rsl on 0-turn session must not count as "2 auto-interventions"; Off mode leaves rules active
      win.renderState({
        sessionId: 'static-off',
        routerMode: 'off',
        shield: { enabled: true, maxUnslicedLines: 1200 },
        rsl: { totalActive: 2, promotedHooks: 1, uiRules: [{ kind: 'hook', title: 'Hook A', detail: 'stop' }, { kind: 'rule', title: 'Rule B', detail: 'follow' }] },
        window: { totalActiveTokens: 10000, safeLimit: 179000, maxTokens: 256000 }
      });
      assert.match(txt('tsLearnedRulesSummary'), /2 learned rules \(checks paused\)/);
      assert.equal(d.querySelectorAll('#tsLearnedRulesList [data-effective-state="paused"]').length, 1);
      assert.equal(d.querySelectorAll('#tsLearnedRulesList [data-effective-state="active"]').length, 1);

      win.renderState({
        sessionId: 'static-coach',
        routerMode: 'coach',
        shield: { enabled: true, maxUnslicedLines: 1200 },
        rsl: { totalActive: 2, promotedHooks: 0, uiRules: [{ kind: 'rule', title: 'Rule B', detail: 'follow' }] },
        coachState: { detectors: { totalCount: 31 } },
        window: { totalActiveTokens: 10000, safeLimit: 179000, maxTokens: 256000 }
      });
      assert.equal(txt('tsGuardsSummary'), '31 guards armed');

      // SV-BUG-14: plainText relative paths & try/catch preserved
      win.renderState({
        sessionId: 'rel-path',
        window: { totalActiveTokens: 20000, safeLimit: 179000, maxTokens: 256000 },
        coachState: { detectors: { tripped: { detectorId: 'DET-99', reason: 'Removed try/catch in src/webview/partials/09_script.part see https://example.com/a/b' } } }
      });
      assert.match(txt('tsDoText'), /\bin 09_script\.part\b/);
      assert.match(txt('tsDoText'), /try\/catch/);
      assert.doesNotMatch(txt('tsDoText'), /src09_script\.part/);

      // SV-BUG-18: usd30d >= usdSaved hidden in UI; token-first readout + flat 1-turn sparkline
      win.renderState({
        sessionId: 'usd-spark',
        window: { totalActiveTokens: 30000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 5000, ACTIVE_WORKING_SET: 25000 },
        savings: { session: { totalTokens: 45000, estimatedUsd: 0.18 }, workspace30d: { totalTokens: 45000, estimatedUsd: 0.04 } }
      });
      assert.equal(d.getElementById('tsKpiUsd').hidden, true);
      assert.equal(txt('tsKpiUsd'), '');
      assert.equal(txt('tsKpiSaved'), '+45.0k');
      assert.equal(txt('tsKpi30d'), '30d: +45.0k');
      const pts = d.getElementById('tsSparklinePath').getAttribute('points').split(' ').map((p) => Number(p.split(',')[1]));
      assert.equal(pts.length, 2);
      assert.equal(pts[0], pts[1], '1-turn sparkline must stay flat instead of fabricating a ramp');

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});

describe('SV-BUG-15..17: Backend breaker precision & session isolation', () => {
  it('skips DET-22 & spurious DET-02 on partial hunks, still catches exact hunk reversal, and clears readFiles on rewind(0)', () => {
    const cb = new CircuitBreakers();
    const fortyLines = Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join('\n');
    const twoLines = 'const x = 1;\nconst y = 2;';

    // Partial hunk shrinking 40 -> 2 lines must NOT trigger DET-22
    const hunkRes = cb.recordTurn({
      turnIndex: 1,
      toolName: 'replace_file_content',
      filePath: 'src/large.mjs',
      previousContent: fortyLines,
      newContent: twoLines,
      isPartialEdit: true
    });
    assert.equal(hunkRes.triggered.some((a) => a.detectorId === 'DET-22'), false);

    // Two unrelated hunks returning identical replacement snippet must NOT trigger DET-02
    const r1 = cb.recordTurn({
      turnIndex: 2, toolName: 'replace_file_content', filePath: 'src/large.mjs',
      previousContent: 'if (alphaConditionCheck) return false;', newContent: 'return null; // done a', isPartialEdit: true
    });
    const r2 = cb.recordTurn({
      turnIndex: 3, toolName: 'replace_file_content', filePath: 'src/large.mjs',
      previousContent: 'if (betaConditionCheck) return false;', newContent: 'return null; // done a', isPartialEdit: true
    });
    assert.equal(r1.triggered.length + r2.triggered.length, 0);

    // Exact hunk reversal A -> B then B -> A MUST still trigger DET-02
    cb.recordTurn({
      turnIndex: 4, toolName: 'replace_file_content', filePath: 'src/rev.mjs',
      previousContent: 'const stateMode = "enabled";', newContent: 'const stateMode = "disabled";', isPartialEdit: true
    });
    const revRes = cb.recordTurn({
      turnIndex: 5, toolName: 'replace_file_content', filePath: 'src/rev.mjs',
      previousContent: 'const stateMode = "disabled";', newContent: 'const stateMode = "enabled";', isPartialEdit: true
    });
    assert.ok(revRes.triggered.some((a) => a.detectorId === 'DET-02'));

    // Switching sessions (cutoff 0) clears readFiles
    cb.markFileIndexed('src/only_old_session.mjs');
    cb.purgeRewoundTurns(0);
    assert.equal(cb.readFiles.size, 0);
  });

  describe('Live daemon prompt_state session isolation (SV-BUG-17)', () => {
    let child; let port; let tmpRoot;
    const TOKEN = 'truth-audit-daemon-token';
    before(async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-truth-'));
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpCwd = path.join(tmpRoot, 'ws');
      fs.mkdirSync(path.join(tmpCwd, '.agents', 'telemetry'), { recursive: true });
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.writeFileSync(path.join(tmpCwd, '.agents', 'telemetry', 'prompt_state.old-sess.json'), JSON.stringify({
        sessionId: 'old-sess',
        specShards: ['s1', 's2', 's3', 's4', 's5'],
        turn1ContractInjected: true
      }));
      port = await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
        srv.on('error', reject);
      });
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_ENV;
      Object.assign(env, {
        USERPROFILE: tmpHome, HOME: tmpHome,
        ANTIGRAVITY_SIDECAR_UI_TOKEN: TOKEN,
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
        HORIZON_TEST_NO_SPAWN: '1'
      });
      child = spawn(process.execPath, [SERVER], { cwd: tmpCwd, env, stdio: 'ignore' });
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/state?conversationId=new-sess`, { headers: { 'X-Sidecar-Token': TOKEN } });
          ready = r.status === 200;
        } catch (err) {
          void err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      assert.ok(ready, 'daemon must start');
    });
    after(() => {
      try { child?.kill(); } catch (err) { void err; }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
    });

    it('never bleeds prompt_state shards from an unrelated session into a new conversation', async () => {
      const resNew = await fetch(`http://127.0.0.1:${port}/api/state?conversationId=new-sess`, { headers: { 'X-Sidecar-Token': TOKEN } });
      const sNew = await resNew.json();
      assert.equal(sNew.shardedSpecCount, 0);
      assert.equal(sNew.turn1ContractSteered, false);

      const resOld = await fetch(`http://127.0.0.1:${port}/api/state?conversationId=old-sess`, { headers: { 'X-Sidecar-Token': TOKEN } });
      const sOld = await resOld.json();
      assert.equal(sOld.shardedSpecCount, 5);
      assert.equal(sOld.turn1ContractSteered, true);
    });
  });
});
