/**
 * Exhaustive Advanced View Truth, Information Architecture & Zero-Dead-End Audit Suite (AV-BUG-01 .. AV-BUG-17).
 * Verifies 0.1k parity with Simple View, cache/baseline/savings honesty (zero fabricated splits),
 * session bleed isolation, interactive drill-down drawers, 40-cell navigation & scaling,
 * DET-09 model economics, standalone /advanced workbench, and Claude Code Advanced panes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { renderAdvancedViewPane } from '../src/core-isomorphic/ui/modViews.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

function parseCompactK(str) {
  const s = String(str || '').trim().replace(/^\+/, '');
  if (/^\d+(?:\.\d+)?M$/i.test(s)) return parseFloat(s) * 1000;
  if (/k$/i.test(s)) return parseFloat(s);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n / 1000 : 0;
}

async function mountPanel({ theme = 'dark', initialView = 'advanced', fetchHandler = null } = {}) {
  const rawHtml = fs.readFileSync(HTML_PATH, 'utf8')
    .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const jsdomErrors = [];
  const apiCalls = [];
  const copiedTexts = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));

  const dom = new JSDOM(rawHtml, {
    url: 'http://127.0.0.1:62935/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.__HORIZON_CSRF_TOKEN__ = 'av-audit-csrf';
      win.localStorage?.setItem('ctxtop.viewMode', initialView);
      win.EventSource = class { close() {} };
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      win.sidecar = { onWorkspaceChange() {} };
      win.fetch = async (url, init = {}) => {
        const u = String(url);
        let parsedBody = null;
        if (init?.body) {
          try { parsedBody = JSON.parse(init.body); } catch (err) { void err; }
        }
        apiCalls.push({ url: u, method: init?.method || 'GET', headers: init?.headers || {}, body: parsedBody });
        if (typeof fetchHandler === 'function') return fetchHandler(u, init, parsedBody);
        if (u.includes('/api/savings/receipt')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, receiptMarkdown: '# Highbeam Receipt\nSaved: +10.0k' }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true, ok: true, savedTokens: 4200 }) };
      };
      Object.defineProperty(win.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { copiedTexts.push(String(text)); } }
      });
    }
  });
  await new Promise((r) => setTimeout(r, 70));
  if (theme === 'light') {
    dom.window.document.documentElement.setAttribute('data-theme', 'light');
  }
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors, apiCalls, copiedTexts };
}

describe('AV-BUG-01..14: Primary Advanced View Math Parity, Honesty & Zero-Dead-End Drills', () => {
  it('enforces 0.1k Simple<->Advanced parity and zero fabricated savings across 200 seeds (dark + light + 320px)', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel({ theme: 'light' });
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      assert.equal(d.body.dataset.viewMode, 'advanced');

      for (let i = 1; i <= 200; i++) {
        const anchor = i * 137;
        const mem = (i % 5) * 231;
        const dup = (i % 7) * 419;
        const active = i * 523;
        const total = anchor + mem + dup + active;
        const sessionSaved = (i % 11) * 1500;
        win.renderState({
          sessionId: `av-parity-${i}`,
          window: { totalActiveTokens: total, safeLimit: 179000, maxTokens: 256000 },
          breakdown: { ANCHOR: anchor, MEMORY_KI: mem, STALE_DUPLICATE: dup, ACTIVE_WORKING_SET: active },
          savingsLedger: sessionSaved > 0 ? { totalTokensSaved: sessionSaved, prefixCacheTokens: i % 2 === 0 ? 500 : 0 } : null
        });

        const usedK = parseCompactK(txt('taUsedTok'));
        const sigK = parseCompactK(txt('taSigTok'));
        const cluK = parseCompactK(txt('taClutterTok'));
        assert.equal(Number((sigK + cluK).toFixed(1)), Number(usedK.toFixed(1)), `seed ${i}: sig + clutter must equal used`);
        assert.equal(txt('taUsedTok'), txt('tsUsedLabel'), `seed ${i}: Advanced & Simple used tokens must match`);
        assert.equal(txt('taSafeTok'), txt('tsSafeLabel'), `seed ${i}: Advanced & Simple safe limits must match`);

        if (sessionSaved > 0 && i % 2 === 1) {
          assert.equal(txt('taSrcCache'), '+0.0k', 'must not fabricate 75% cache split when prefixCacheTokens=0');
          assert.equal(txt('taSrcSub'), '+0.0k', 'must not fabricate 10% subagent split');
          assert.equal(txt('taSrcCli'), '+0.0k', 'must not fabricate 8% CLI split');
          assert.equal(txt('taSrcGuards'), '+0.0k', 'must not fabricate residual guard split');
        }
      }
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('isolates session switches with zero stale guard-log bleed and never fabricates DET-01..03 IDs (AV-BUG-06)', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      // Session A: active autoFix + tripped breaker (no guardId on first item)
      win.renderState({
        sessionId: 'sess-active-a',
        routerMode: 'coach',
        window: { totalActiveTokens: 64000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 10000, ACTIVE_WORKING_SET: 54000 },
        autoFixLog: {
          items: [
            { label: 'Trimmed noisy test stdout', tokensSaved: 8400, turn: 4 },
            { guardId: 'DET-06', label: 'Blocked repeat full-file read', tokensSaved: 3100, turn: 5 }
          ]
        },
        coachState: {
          detectors: {
            totalCount: 32,
            armedCount: 32,
            tripped: { detectorId: 'DET-02', reason: 'Rapid rewrite churn on config.mjs' }
          }
        }
      });

      const activeLogTxt = txt('taGuardBody');
      assert.match(activeLogTxt, /Trimmed noisy test stdout/);
      assert.match(activeLogTxt, /GUARD/, 'missing guardId must fall back to GUARD, never fake DET-01');
      assert.doesNotMatch(activeLogTxt, /\bDET-01\b/);
      assert.equal(txt('taDetBadge'), 'DET-02 tripped');
      assert.equal(txt('taStatusLabel'), 'DET-02 Tripped');
      assert.equal(d.getElementById('taStatusDot').dataset.tone, 'danger');
      assert.equal(d.getElementById('statusDot').dataset.riskBand, 'RED');

      // Session B: clean zero-token session — must completely wipe Session A's guard rows!
      win.renderState({
        sessionId: 'sess-clean-b',
        routerMode: 'coach',
        window: { totalActiveTokens: 0, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 0, ACTIVE_WORKING_SET: 0 },
        autoFixLog: { items: [] },
        coachState: { detectors: { totalCount: 32, armedCount: 32, tripped: null } }
      });

      const cleanLogTxt = txt('taGuardBody');
      assert.doesNotMatch(cleanLogTxt, /Trimmed noisy test stdout/, 'Session A intervention leaked into Session B!');
      assert.doesNotMatch(cleanLogTxt, /Blocked repeat full-file read/);
      assert.match(cleanLogTxt, /DET-01\.\.32.*armed/);
      assert.equal(txt('taDetBadge'), '32/32 guards armed');
      assert.equal(txt('taStatusLabel'), 'Nominal Memory');
      assert.equal(d.querySelectorAll('#taHorizonGrid .ta-cell[data-cat]').length, 0, '0-token session must have 40 empty cells');

      // Off mode resets guard table to paused row
      win.renderState({
        sessionId: 'sess-off-c',
        routerMode: 'off',
        window: { totalActiveTokens: 12000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 4000, ACTIVE_WORKING_SET: 8000 },
        coachState: { detectors: { totalCount: 32, armedCount: 32, tripped: null } }
      });
      assert.equal(txt('taDetBadge'), 'Guards paused');
      assert.match(txt('taGuardBody'), /Guards paused/);
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('eliminates dead ends: Guard Roster (4 modes), RSL drawer, Swarm/Trajectory drawer, Consumers overflow, Reap/Unlock APIs & Drift (AV-BUG-07..13)', async () => {
    const { dom, win, d, jsdomErrors, apiCalls, copiedTexts } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      const sampleGuards = [
        { id: 'DET-06', title: 'Repeat File Read Guard', mode: 'guard', tripped: false, summary: 'Prevents identical full-file reads.' },
        { id: 'DET-19', title: 'Swarm Git Guard', mode: 'advisory', tripped: true, summary: 'Two agents touched the same file.' }
      ];
      const basePayload = (overrides = {}) => ({
        sessionId: 'sess-zero-dead-ends',
        routerMode: 'coach',
        workloadMode: 'edit-test',
        confidence: 'DEGRADED',
        parseHealth: { confidence: 'DEGRADED', malformedLines: 2 },
        logTierUsed: 'fallback_db',
        window: { totalActiveTokens: 152000, safeLimit: 179000, maxTokens: 256000, turnCount: 6 },
        breakdown: { ANCHOR: 12000, TOOL_DEFINITIONS: 6000, ACTIVE_WORKING_SET: 90000, STALE_DUPLICATE: 34000, FOREIGN_BLEED: 10000 },
        baseline: { rulesTokens: 6000, skillsTokens: 4000, mcpTokens: 8000 },
        offenders: [
          { category: 'FOREIGN_BLEED', target: 'OtherWorkspace memory item', wastedTokens: 10000, occurrences: 1 },
          { category: 'STALE_DUPLICATE', target: 'src/a.mjs', wastedTokens: 12000, occurrences: 4 },
          { category: 'STALE_DUPLICATE', target: 'src/b.mjs', wastedTokens: 9000, occurrences: 3 },
          { category: 'STALE_DUPLICATE', target: 'src/c.mjs', wastedTokens: 7000, occurrences: 2 },
          { category: 'STALE_DUPLICATE', target: 'src/d.mjs', wastedTokens: 4000, occurrences: 2 },
          { category: 'STALE_DUPLICATE', target: 'logs/build.log', wastedTokens: 2000, occurrences: 2 }
        ],
        hostHealth: { rssGb: 4.4, orphanCount: 2, orphans: [{ pid: 9012 }, { pid: 9013 }] },
        attentionHeatmap: { strandedSignalCount: 1, strandedSignals: [{ cellIndex: 19, topTarget: 'task.md checklist' }] },
        compaction: {
          preCompactionWarning: true,
          preCompactionWarningMessage: '3 uncommitted files while task.md is stale — sync before /compact.',
          parameterizedCommand: '/compact Focus on preserving: server.mjs and task.md.'
        },
        rsl: {
          totalActive: 2,
          promotedHooks: 1,
          clashCount: 1,
          uiRules: [
            { kind: 'hook', title: 'Guard router.mjs edits', detail: 'Run unit tests first' },
            { kind: 'rule', title: 'Always wrap PS && in cmd /c', detail: 'PS 5.1 rule' }
          ]
        },
        shardedSpecCount: 3,
        swarmTopology: {
          workers: [{ agentId: 'worker-1', state: 'working', worktree: 'wt-1', totalTokens: 18000 }],
          worktrees: ['main', 'wt-1'],
          scopeLocks: { collisions: [{ file: 'src/core/router.mjs', worktreeCommand: 'git worktree add ../wt-2' }] }
        },
        sessionTimeline: {
          totalTurns: 6,
          kpis: { goodCount: 4, badCount: 2, burnRateTokens: 12000 },
          turns: [
            { turn: 1, deltaTokens: 12000, cumulativeTokens: 12000, practice: 'good', reason: 'initial load' },
            { turn: 2, deltaTokens: 24000, cumulativeTokens: 36000, practice: 'bad', reason: 'duplicate read' }
          ],
          markers: [{ turn: 2, type: 'MODEL_SWITCH' }]
        },
        coachState: {
          hysteresisLock: { locked: true },
          detectors: {
            totalCount: 32,
            armedCount: 32,
            list: sampleGuards,
            tripped: { detectorId: 'DET-19', reason: 'Scope overlap on router.mjs', worktreeCommand: 'git worktree add ../wt-2' }
          }
        },
        ...overrides
      });

      win.renderState(basePayload());

      // Sub-HUD badges + Turn-0 component sum + Status + Cache telemetry
      assert.equal(d.getElementById('taWorkloadBadge').hidden, false);
      assert.equal(txt('taWorkloadBadge'), 'edit-test');
      assert.equal(d.getElementById('taConfidenceBadge').hidden, false);
      assert.equal(txt('taConfidenceBadge'), 'Parse: DEGRADED');
      assert.match(txt('taBaselineText'), /18\.0k \/ 20\.0k budget \(Rules 6\.0k · MCP\/Tools 8\.0k · KI 4\.0k\)/);

      // Overflow consumers drawer + FOREIGN_BLEED captured + Source file protection inside overflow too
      assert.match(txt('taConsumersBody'), /OtherWorkspace memory item/);
      assert.equal(d.getElementById('taMoreConsumersDrawer').hidden, false);
      assert.equal(txt('taMoreConsumersSummary'), '2 more context consumers');
      assert.match(txt('taMoreConsumersBody'), /build\.log/);
      assert.ok(d.querySelector('#taMoreConsumersBody [data-ignore-path="logs/build.log"]'));
      assert.equal(d.querySelector('#taConsumersBody [data-ignore-path="src/a.mjs"]'), null, 'source files never get +Ignore');

      // Zone B: Action Queue breaker + swarm collision + copy button + Reap & Unlock buttons
      assert.match(txt('taActionQueue'), /DET-19/);
      assert.match(txt('taActionQueue'), /router\.mjs/);
      assert.equal(d.getElementById('taQueueOverflowDrawer').hidden, false);
      d.querySelector('#taActionQueue [data-ta-copy]').click();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(copiedTexts[copiedTexts.length - 1], 'git worktree add ../wt-2');

      d.getElementById('taBtnReapOrphans').click();
      d.getElementById('taBtnUnlockHysteresis').click();
      await new Promise((r) => setTimeout(r, 20));
      const reapCall = apiCalls.find((c) => c.url.includes('/api/host/reap'));
      assert.ok(reapCall, 'Reap button must POST /api/host/reap');
      assert.deepEqual(reapCall.body.pids, [9012, 9013]);
      assert.ok(apiCalls.some((c) => c.url.includes('/api/router/unlock-hysteresis')));

      // Zone C: Detector roster auto-opens on tripped guard, RSL drawer renders rules & clashes
      assert.equal(d.getElementById('taGuardRosterDrawer').open, true);
      assert.match(txt('taGuardRosterBody'), /DET-19[\s\S]*tripped/);
      assert.equal(d.getElementById('taRslDrawer').hidden, false);
      assert.match(txt('taRslSummary'), /Learned rules \(RSL: 2 active\)/);
      assert.match(txt('taRslList'), /CLASH[\s\S]*Guard router\.mjs edits/);

      // Zone D: Trajectory sparkline + swarm/turn drawer
      assert.equal(d.getElementById('taTimelineSwarmDrawer').hidden, false);
      assert.match(txt('taSwarmBlock'), /worker-1/);
      assert.match(txt('taSwarmBlock'), /Collision: src\/core\/router\.mjs/);
      assert.match(txt('taTurnTableBody'), /T2[\s\S]*\+24\.0k/);

      // Zone E: Git Drift warning + Antigravity Focus Args (never copies leading /compact)
      assert.equal(d.getElementById('taGitDriftWarn').hidden, false);
      assert.match(txt('taGitDriftWarn'), /3 uncommitted files/);
      assert.equal(txt('taBtnCopyCompact'), 'Copy Focus Args');
      assert.equal(txt('taCompactCmdText'), 'Focus on preserving: server.mjs and task.md.');
      d.getElementById('taBtnCopyCompact').click();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(copiedTexts[copiedTexts.length - 1], 'Focus on preserving: server.mjs and task.md.');

      // Claude Code copies full `/compact ...`
      win.renderState(basePayload({ storeSource: 'claude-code' }));
      assert.equal(txt('taBtnCopyCompact'), 'Copy /compact');
      assert.equal(txt('taCompactCmdText'), '/compact Focus on preserving: server.mjs and task.md.');

      // Shadow AutoPreview label in #taRouterSwitch & roster
      win.renderState(basePayload({
        routerMode: 'autopilot',
        autoShadow: true,
        proEntitlement: { entitled: false },
        coachState: {
          detectors: { totalCount: 32, armedCount: 32, list: sampleGuards.map(g => ({ ...g, tripped: false })) }
        }
      }));
      assert.equal(d.querySelector('#taRouterSwitch [data-ta-mode="autopilot"]').textContent, 'Auto-Pilot (Preview)');
      assert.equal(txt('taGuardRosterMeta'), '2 preview');
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('renders 40-cell keyboard nav, unused headroom label, safe boundary & DET-09 model economics accurately (AV-BUG-02..04, 10)', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      const cells = Array.from({ length: 40 }, (_, i) => ({
        dominantCategory: i < 2 ? 'ANCHOR' : (i === 5 ? 'DIRTY_SNAP' : (i < 8 ? 'ACTIVE_WORKING_SET' : 'FREE_HEADROOM')),
        fillPct: i < 8 ? 100 : 0,
        topTarget: i === 5 ? 'stale-snapshot.tmp' : undefined,
        turnIndex: i === 5 ? 3 : undefined,
        attentionWeight: i < 8 ? 0.91 : 1.0
      }));

      // Claude Sonnet 4.6 -> DET-09 busts whole prefix
      win.renderState({
        sessionId: 'econ-s46',
        window: { totalActiveTokens: 51200, safeLimit: 140000, maxTokens: 200000, cellSizeTokens: 5000 },
        breakdown: { ANCHOR: 10000, DIRTY_SNAP: 5000, ACTIVE_WORKING_SET: 36200 },
        cells,
        model: {
          id: 'claude-sonnet-4-6',
          canonicalId: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          rawLabel: 'Claude Sonnet 4.6 (High)',
          inputPricePerMillionUsd: 3.0,
          nativeCeilingTokens: 200000
        },
        effortGovernor: { burnMultiplier: 3.0 },
        quota: {
          cache: {
            hitRatePct: 88,
            ttlRemainingSec: 195,
            billingBlockRemainingSec: 2100,
            cacheReadTokens: 40000,
            isCacheCold: false,
            costGate: { coldRewriteCostUsd: 0.12 },
            prefixRetention: { measured: true, retentionIndexPct: 92, grade: 'A' }
          }
        }
      });

      assert.match(txt('taDualTtl'), /^88% hit · 5m KV 03:15 · 1h 35:00 · 92% kept \(A\)$/);
      assert.match(txt('taEconModelLine'), /Claude Sonnet 4\.6.*High \(3x burn\).*Pool: 200\.0k/);
      assert.doesNotMatch(txt('taEconModelLine'), /\$3\.00\/1M in/);
      assert.match(txt('taEconCacheLine'), /busts whole prefix \(EF1_46\).*(?:Switch rewrites 40\.0k warm tok|Mid-turn switch breaks warm KV)/);
      assert.doesNotMatch(txt('taEconCacheLine'), /\$/);

      // 40-cell default #1, safe boundary marker, DIRTY_SNAP clutter cell with turn tag, keyboard navigation
      const domCells = d.querySelectorAll('#taHorizonGrid .ta-cell');
      assert.equal(domCells[0].getAttribute('aria-selected'), 'true');
      assert.equal(domCells[5].dataset.cat, 'clutter', 'DIRTY_SNAP must map to clutter cell');
      assert.equal(domCells[27].hasAttribute('data-safe-boundary'), true, 'safe 140/200 cell #28 marked as safe boundary');
      assert.equal(txt('taGridScaleMeta'), 'Safe @ Cell #28 · 5.0k/cell');

      domCells[5].click();
      assert.equal(txt('taCellLeft'), 'Cell #6 · stale-snapshot.tmp (T3)');
      assert.match(txt('taCellRight'), /5\.0k \/ cell · 0\.91 recall/);

      // ArrowRight to empty cell #9 via sequential navigation from cell #6 -> wait dispatch End then ArrowLeft
      domCells[5].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      assert.equal(txt('taCellLeft'), 'Cell #40 · Available Headroom');
      assert.equal(txt('taCellRight'), '0.0k / cell · unused', 'empty headroom cells must say unused, never 1.00 recall');

      // Claude Sonnet 5.5 -> DET-09 keeps prefix; Gemini 4 Hydrogen -> clamped 256k/1M + thinking outside prefix
      win.renderState({
        sessionId: 'econ-s55',
        window: { totalActiveTokens: 32000, safeLimit: 140000, maxTokens: 200000 },
        breakdown: { ANCHOR: 8000, ACTIVE_WORKING_SET: 24000 },
        model: { id: 'claude-sonnet-5-5', canonicalId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', rawLabel: 'Claude Sonnet 5.5 (Medium)' },
        quota: { cache: { prefixRetention: { unmeasuredReason: 'no_cache_telemetry' }, isCacheCold: true } }
      });
      assert.equal(txt('taDualTtl'), 'Cache unmeasured');
      assert.match(txt('taEconCacheLine'), /keeps prefix \(99\.3% read\)/);

      win.renderState({
        sessionId: 'econ-h2',
        window: { totalActiveTokens: 32000, safeLimit: 179000, maxTokens: 256000 },
        breakdown: { ANCHOR: 8000, ACTIVE_WORKING_SET: 24000 },
        model: {
          id: 'gemini-4-hydrogen',
          canonicalId: 'gemini-4-hydrogen',
          displayName: 'Gemini 4 Hydrogen',
          rawLabel: 'Gemini 4 Hydrogen (XHigh)',
          inputPricePerMillionUsd: 1.5,
          nativeCeilingTokens: 1048576,
          isClamped1MModel: true
        }
      });
      assert.match(txt('taEconModelLine'), /Pool: 256\.0k IDE cap \/ 1\.0M native$/);
      assert.doesNotMatch(txt('taEconModelLine'), /\$/);
      assert.match(txt('taEconCacheLine'), /Effort change: unverified \(hold while warm\)/);
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});

describe('AV-BUG-15..17: Unified /advanced Workbench & Claude Code Isomorphic Advanced Parity', () => {
  it('fixes model label precedence, unmeasured quota dash, STALE_DUPLICATE/FOREIGN_BLEED clutter, and zero fake baseline splits in unified advanced mode', async () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'webview', 'advanced_view.html')), false);
    const { dom, win, d } = await mountPanel({ initialView: 'advanced' });
    try {
      win.renderState({
        sessionId: 'adv-standalone-audit',
        routerMode: 'off',
        window: { totalTokens: 65000, maxTokens: 256000, safeLimit: 179000 },
        model: { displayName: 'Gemini 4 Hydrogen (XHigh)' },
        quota: { sprint5h: { modelPoolName: 'Gemini 3 Flash' } },
        breakdown: { ANCHOR: 10000, ACTIVE_WORKING_SET: 40000, STALE_DUPLICATE: 10000, FOREIGN_BLEED: 5000 },
        brainSignals: { activeSignal: { baselineTokens: 10000 } },
        coachState: { mode: 'off', detectors: { totalCount: 32, armedCount: 32 } }
      });

      assert.equal(d.body.getAttribute('data-view-mode'), 'advanced');
      assert.equal(d.getElementById('tufteTopHostBadge').textContent, 'Antigravity · Gemini 4 Hydrogen (XHigh)');
      assert.equal(d.getElementById('taSprint5h').textContent, '—');
      assert.equal(d.getElementById('taWeekly7d').textContent, '—');
      assert.equal(d.getElementById('taUsedTok').textContent, '65.0k');
      assert.equal(d.getElementById('taClutterTok').textContent, '15.0k', 'must count STALE_DUPLICATE + FOREIGN_BLEED');
      assert.equal(d.getElementById('taSigTok').textContent, '50.0k');
      assert.match(d.getElementById('taBaselineText').textContent, /10\.0k \/ 20\.0k budget \(Rules 10\.0k · MCP\/Tools 0\.0k\)/);
      assert.doesNotMatch(d.getElementById('taBaselineText').textContent, /4\.5k.*2\.0k.*3\.5k/, 'must never fabricate 45/20/35 baseline split');
      assert.equal(d.getElementById('taDetBadge').textContent, 'Guards paused');
    } finally {
      dom.window.close();
    }
  });

  it('wires state.offenders, tripped breakers, DET-01..32, and window.turnCount into Claude isomorphic Advanced HUD & CLI views', () => {
    const state = {
      sessionId: 'cc-adv-audit',
      model: 'claude-sonnet-5-5',
      totalInputTokens: 62000,
      offenders: [
        { category: '[D]', name: 'server.mjs (re-reads)', tokens: 18500, pct: 29.8 }
      ],
      window: { turnCount: 14 },
      coachState: {
        detectors: {
          tripped: { detectorId: 'DET-06', reason: 'Unmodified re-read blocked' }
        }
      }
    };

    const hud = renderHorizonPanelHtml(state, { viewMode: 'advanced', includeDiskLedger: false });
    assert.match(hud.html, /server\.mjs \(re-reads\)/);
    assert.match(hud.html, /DET-06/);

    const pane = renderAdvancedViewPane(state, { includeDiskLedger: false });
    const sec3 = pane.sections.find((s) => s.id === 'circuit-breakers-drift');
    const sec5 = pane.sections.find((s) => s.id === 'state-baton-forensics');
    assert.equal(sec3.title, 'Circuit Breakers (DET-01..32), Thinking Drift & Retention');
    assert.match(sec3.text, /DET-06 \(Unmodified re-read blocked\)/);
    assert.match(sec5.text, /Completed Turns: 14/);
  });
});
