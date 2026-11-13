import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { buildSessionTimeline } from '../src/core/session_timeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

function makeCells(usefulK, duplicateK, errorK) {
  const totalCells = 40;
  const cellSize = 6.4;
  const usefulCells = Math.round(usefulK / cellSize);
  const dupCells = Math.round(duplicateK / cellSize);
  const errCells = Math.round(errorK / cellSize);
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    if (i < usefulCells) {
      cells.push({ index: i, state: 'useful', dominantCategory: 'ACTIVE_WORKING_SET', fillPct: 100 });
    } else if (i < usefulCells + dupCells) {
      cells.push({ index: i, state: 'stale', dominantCategory: 'DUPLICATE_READ', fillPct: 100 });
    } else if (i < usefulCells + dupCells + errCells) {
      cells.push({ index: i, state: 'error', dominantCategory: 'DEAD_ERROR', fillPct: 100 });
    } else {
      cells.push({ index: i, state: 'free', dominantCategory: 'FREE_HEADROOM', fillPct: 0 });
    }
  }
  return cells;
}

function createVibeCodingSpiralStates() {
  const baseMeta = {
    schemaVersion: '1.1.0',
    sessionId: 'ux-spiral-test-session',
    sessionTitle: 'Fix auth webhook & SSE streaming',
    effortProfile: { tier: 'STANDARD', label: 'Auto (Standard)', shortLabel: 'Auto', safeLimit: 140000 }
  };

  return {
    stage0: {
      ...baseMeta,
      window: { maxTokens: 256000, totalActiveTokens: 14200, usedPercentage: 6, turnCount: 1, safeLimit: 140000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 7800, DUPLICATE_READ: 0, STALE_TURN: 0, DEAD_ERROR: 0 },
      quota: {
        sprint5h: { usedPct: 4, remainingPct: 96, modelPoolName: 'Gemini 3.8 Flash' },
        weekly7d: { usedPct: 11, remainingPct: 89 },
        cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true, cacheReadTokens: 0 }
      },
      brainSignals: {
        activeSignal: { baselineTokens: 6400, liveSessionTokens: 7800, taskMdSaved: true, taskMdTurnsBehind: 0 },
        duplicateReads: { files: [], totalWastedTokens: 0 },
        deadErrors: { errorCount: 0, totalTokens: 0 },
        oldHistory: { turnCount: 0, reclaimableTokens: 0 },
        blowupSteps: []
      },
      savings: {
        session: { totalPhysicalTokens: 4800, estimatedInputValueUsd: 0.02 },
        workspace30d: { totalPhysicalTokens: 942000, estimatedInputValueUsd: 1.88 }
      },
      cells: makeCells(14.2, 0, 0)
    },
    stage1: {
      ...baseMeta,
      verdictCode: 'HOLD_COMPACT',
      window: { maxTokens: 256000, totalActiveTokens: 96000, usedPercentage: 38, turnCount: 8, safeLimit: 140000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 26600, DUPLICATE_READ: 63000, STALE_TURN: 0, DEAD_ERROR: 0 },
      quota: {
        sprint5h: { usedPct: 18, remainingPct: 82, modelPoolName: 'Gemini 3.8 Flash' },
        weekly7d: { usedPct: 24, remainingPct: 76 },
        cache: { hitRatePct: 92, ttlRemainingSec: 218, isCacheCold: false, cacheReadTokens: 88300 }
      },
      brainSignals: {
        activeSignal: { baselineTokens: 6400, liveSessionTokens: 26600, taskMdSaved: true, taskMdTurnsBehind: 1 },
        duplicateReads: {
          topFiles: [
            { path: 'sidecars/horizon-daemon/server.mjs', occurrences: 5, wastedTokens: 38400 },
            { path: 'src/webview/horizon_panel.html', occurrences: 3, wastedTokens: 24600 }
          ],
          reclaimableTokens: 63000
        },
        deadErrors: { errorCount: 0, reclaimableTokens: 0 },
        oldHistory: { turnCount: 0, reclaimableTokens: 0 },
        blowupSteps: [
          { stepIndex: 7, tokens: 19200, target: 'sidecars/horizon-daemon/server.mjs', payload: { kind: 'file', path: 'sidecars/horizon-daemon/server.mjs', detail: 'sidecars/horizon-daemon/server.mjs' } }
        ]
      },
      savings: {
        session: { totalPhysicalTokens: 84200, estimatedInputValueUsd: 0.17 },
        workspace30d: { totalPhysicalTokens: 1021400, estimatedInputValueUsd: 2.04 }
      },
      cells: makeCells(33, 63, 0)
    },
    stage2: {
      ...baseMeta,
      verdictCode: 'HOLD_COMPACT',
      window: { maxTokens: 256000, totalActiveTokens: 134500, usedPercentage: 53, turnCount: 14, safeLimit: 140000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 39100, DUPLICATE_READ: 63000, STALE_TURN: 0, DEAD_ERROR: 26000 },
      quota: {
        sprint5h: { usedPct: 31, remainingPct: 69, modelPoolName: 'Gemini 3.8 Flash' },
        weekly7d: { usedPct: 27, remainingPct: 73 },
        cache: { hitRatePct: 91, ttlRemainingSec: 38, isCacheCold: false, cacheReadTokens: 122400 }
      },
      brainSignals: {
        activeSignal: { baselineTokens: 6400, liveSessionTokens: 39100, taskMdSaved: true, taskMdTurnsBehind: 2 },
        duplicateReads: {
          topFiles: [
            { path: 'sidecars/horizon-daemon/server.mjs', occurrences: 5, wastedTokens: 38400 },
            { path: 'src/webview/horizon_panel.html', occurrences: 3, wastedTokens: 24600 }
          ],
          reclaimableTokens: 63000
        },
        deadErrors: { errorCount: 4, reclaimableTokens: 26000, isErrorLoop: true },
        oldHistory: { turnCount: 0, reclaimableTokens: 0 },
        blowupSteps: [
          { stepIndex: 13, tokens: 18500, target: 'npm test', payload: { kind: 'command', detail: 'npm test' } }
        ]
      },
      savings: {
        session: { totalPhysicalTokens: 131400, estimatedInputValueUsd: 0.26 },
        workspace30d: { totalPhysicalTokens: 1068600, estimatedInputValueUsd: 2.14 }
      },
      cells: makeCells(45.5, 63, 26)
    },
    stage3: {
      ...baseMeta,
      window: { maxTokens: 256000, totalActiveTokens: 138000, usedPercentage: 54, turnCount: 15, safeLimit: 140000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 42600, DUPLICATE_READ: 63000, STALE_TURN: 0, DEAD_ERROR: 26000 },
      quota: {
        sprint5h: { usedPct: 33, remainingPct: 67, modelPoolName: 'Gemini 3.8 Flash' },
        weekly7d: { usedPct: 28, remainingPct: 72 },
        cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true, cacheReadTokens: 0 }
      },
      brainSignals: {
        activeSignal: { baselineTokens: 6400, liveSessionTokens: 42600, taskMdSaved: true, taskMdTurnsBehind: 3 },
        duplicateReads: {
          topFiles: [
            { path: 'sidecars/horizon-daemon/server.mjs', occurrences: 5, wastedTokens: 38400 },
            { path: 'src/webview/horizon_panel.html', occurrences: 3, wastedTokens: 24600 }
          ],
          reclaimableTokens: 63000
        },
        deadErrors: { errorCount: 4, reclaimableTokens: 26000, isErrorLoop: true },
        oldHistory: { turnCount: 0, reclaimableTokens: 0 },
        blowupSteps: []
      },
      savings: {
        session: { totalPhysicalTokens: 131400, estimatedInputValueUsd: 0.26 },
        workspace30d: { totalPhysicalTokens: 1068600, estimatedInputValueUsd: 2.14 }
      },
      cells: makeCells(49, 63, 26)
    },
    stage4: {
      ...baseMeta,
      window: { maxTokens: 256000, totalActiveTokens: 164000, usedPercentage: 64, turnCount: 18, safeLimit: 140000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 48600, DUPLICATE_READ: 71000, STALE_TURN: 12000, DEAD_ERROR: 26000 },
      amputation: { amputationCrisis: true },
      telemetry: { amputationRisk: true, confidence: 'HIGH' },
      quota: {
        sprint5h: { usedPct: 44, remainingPct: 56, modelPoolName: 'Gemini 3.8 Flash' },
        weekly7d: { usedPct: 31, remainingPct: 69 },
        cache: { hitRatePct: 88, ttlRemainingSec: 210, isCacheCold: false, cacheReadTokens: 144300 }
      },
      brainSignals: {
        activeSignal: { baselineTokens: 6400, liveSessionTokens: 48600, taskMdSaved: true, taskMdTurnsBehind: 0 },
        duplicateReads: {
          topFiles: [
            { path: 'sidecars/horizon-daemon/server.mjs', occurrences: 6, wastedTokens: 46400 },
            { path: 'src/webview/horizon_panel.html', occurrences: 3, wastedTokens: 24600 }
          ],
          reclaimableTokens: 71000
        },
        deadErrors: { errorCount: 4, reclaimableTokens: 26000, isErrorLoop: true },
        oldHistory: { turnCount: 4, reclaimableTokens: 12000 },
        blowupSteps: []
      },
      savings: {
        session: { totalPhysicalTokens: 139200, estimatedInputValueUsd: 0.28 },
        workspace30d: { totalPhysicalTokens: 1076400, estimatedInputValueUsd: 2.15 }
      },
      cells: makeCells(55, 83, 26)
    },
    stage5: {
      ...baseMeta,
      window: { maxTokens: 256000, totalActiveTokens: 28400, usedPercentage: 11, turnCount: 19, safeLimit: 140000 },
      breakdown: { ANCHOR: 6400, ACTIVE_WORKING_SET: 22000, DUPLICATE_READ: 0, STALE_TURN: 0, DEAD_ERROR: 0 },
      quota: {
        sprint5h: { usedPct: 44, remainingPct: 56, modelPoolName: 'Gemini 3.8 Flash' },
        weekly7d: { usedPct: 31, remainingPct: 69 },
        cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true, cacheReadTokens: 0 }
      },
      brainSignals: {
        activeSignal: { baselineTokens: 6400, liveSessionTokens: 22000, taskMdSaved: true, taskMdTurnsBehind: 0 },
        duplicateReads: { files: [], totalWastedTokens: 0 },
        deadErrors: { errorCount: 0, totalTokens: 0 },
        oldHistory: { turnCount: 0, reclaimableTokens: 0 },
        blowupSteps: []
      },
      savings: {
        session: {
          totalPhysicalTokens: 274800,
          estimatedInputValueUsd: 0.55,
          bySource: { subagentIsolation: 0, cachePreservation: 119800, cliCompression: 19400, avoidedBloat: 135600 }
        },
        workspace30d: { totalPhysicalTokens: 1212000, estimatedInputValueUsd: 2.42 }
      },
      cells: makeCells(28.4, 0, 0)
    }
  };
}

describe('Google UX & Edward Tufte Simple View Invariants', () => {
  it('verifies 6-stage Vibe-Coding Spiral root-cause attribution, warm-cache staging, crisis override & contrast CSS', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    // Static CSS & UI Invariant checks
    assert.ok(html.includes('body[data-view-mode="simple"] .simple-emoji-decor'), 'Must hide decorative emojis in Simple View');
    assert.ok(html.includes('body[data-view-mode="simple"] .m3-action-icon'), 'Must hide row emojis in Simple View');
    assert.ok(html.includes('body[data-view-mode="simple"] #footerMeta'), 'Must hide duplicate #footerMeta bar in Simple View');
    assert.ok(html.includes('body[data-view-mode="simple"] #cacheTokensSavedDisplay'), 'Must hide duplicate cache saved badge in Simple View');
    assert.ok(html.includes('.b-head > span:not(.b-swatch)'), 'Must apply ellipsis to stat column headers to avoid mid-glyph clipping');
    assert.ok(html.includes('tufte-baseline-strip[data-muted="true"]'), 'Must preserve WCAG AA contrast on muted baseline strip');
    assert.ok(html.includes('id="btnCompactPrimary"') && html.includes('id="compactInstruction"'), 'AGENTS.md UI Invariant 1 must remain intact');
    assert.ok(html.includes('max-height: 580px'), 'Must include 580px height ambient collapse rule');
    assert.ok(html.includes('.simple-runway-hero') && html.includes('.simple-cache-ring-wrap'), 'Option A+ Runway Hero & Watch Ring selectors must exist');

    const clipboardWrites = [];
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
        Object.defineProperty(win.navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (txt) => { clipboardWrites.push(String(txt)); } }
        });
      }
    });
    const d = dom.window.document;
    const states = createVibeCodingSpiralStates();
    await new Promise(r => setTimeout(r, 40));

    // Stage 0: Clean baseline
    dom.window.renderState(states.stage0);
    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'NOMINAL');
    assert.equal(d.getElementById('simpleTopOffenderLine').hidden, true);
    assert.equal(d.getElementById('simpleNominalConfirm').hidden, false);
    assert.ok(d.getElementById('simpleRunwayHero'), 'Must render #simpleRunwayHero');
    assert.equal(d.getElementById('simpleCacheRingPct').textContent, 'Cold');
    assert.ok(d.getElementById('simpleAmnesiaPill'), 'Must render Amnesia Radar anchor status pill');
    assert.equal(d.getElementById('simpleKpiBar'), null, 'Redundant #simpleKpiBar must be removed in Option A+ Hybrid');

    // Stage 1: Warm re-reads -> HOLD_COMPACT stages compact-context (without 2x double-count) + Top Hogs drawer protects source files
    dom.window.renderState(states.stage1);
    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'HOLD_COMPACT');
    assert.equal(d.getElementById('simpleTopOffenderLine').hidden, false);
    assert.match(d.getElementById('simpleTopOffenderLine').textContent, /Cause:\s*server\.mjs \(5× · 38\.4k\)/);
    assert.equal(d.getElementById('simpleCacheRingPct').textContent, '92% hit');
    assert.equal(d.getElementById('simpleTopHogsDrawer').hidden, false, 'Top Context Hogs drawer must be available when offenders exist');
    assert.ok(!d.getElementById('simpleTopHogsDrawer').innerHTML.includes('Ignore'), 'Source files must never expose Ignore file action');
    assert.equal(d.getElementById('cacheGatedHoldBanner').style.display, 'flex');
    assert.match(d.getElementById('cacheGatedHoldMsg').textContent, /~63k reclaimable/, 'Hold banner must not double-count compact + surgical condense');
    assert.equal(d.getElementById('subClutter').textContent, '95% discounted · hold /compact');
    assert.equal(d.querySelector('#simpleActionList [data-simple-copy="/compact"]'), null, 'compact-context must be held while warm non-crisis');

    // Stage 2: Verbose CLI/error thrash while TTL warm -> surfaces both server.mjs + 4 err traces and keeps prefix-safe blowup action
    dom.window.renderState(states.stage2);
    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'HOLD_COMPACT');
    assert.match(d.getElementById('simpleTopOffenderLine').textContent, /server\.mjs.*4 err traces \(26\.0k\)/);
    assert.ok(d.querySelector('#simpleActionList details[data-action-id="dampen-blowup"]'), 'Prefix-safe spike row should render while /compact is held');
    assert.equal(d.querySelector('#simpleActionList [data-simple-copy="/compact"]'), null);

    // Stage 3: Cold cliff -> COMPACT_READY hoists 1-click Copy /compact ABOVE Sync task.md / overflow drawer
    dom.window.renderState(states.stage3);
    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'COMPACT_READY');
    assert.equal(d.getElementById('subClutter').textContent, 'Can be cleared');
    const primaryColdBtn = d.querySelector('#simpleActionList > details[data-action-id="compact-context"] #btnSimpleCopyCompact');
    assert.ok(primaryColdBtn, 'Cold cliff must hoist compact-context (Copy /compact) to the primary visible slot outside overflow drawer');

    // Stage 4: Crisis -> CRITICAL_STOP Check-Run red accent, Copy /compact copies spec-preserving parameterized command when anchors present
    const stage4WithPinned = {
      ...states.stage4,
      amputation: { ...states.stage4.amputation, anchorsAtRisk: 2 }
    };
    dom.window.renderState(stage4WithPinned);
    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'CRITICAL_STOP');
    assert.equal(d.getElementById('subClutter').textContent, 'Crisis · compact');
    assert.ok(!d.getElementById('subClutter').textContent.includes('hold /compact'));
    assert.equal(d.getElementById('simpleActionableBox').dataset.crisis, 'true', 'Check-Run card must mark data-crisis="true"');
    const crisisCopyBtn = d.querySelector('#simpleActionList > details[data-action-id="compact-context"] #btnSimpleCopyCompact[data-simple-copy="/compact"]');
    assert.ok(crisisCopyBtn, 'Crisis must override warm hold in primary slot');
    crisisCopyBtn.click();
    await new Promise(r => setTimeout(r, 15));
    assert.ok(clipboardWrites.some(w => w.startsWith('/compact Focus on preserving:')), 'Clicking Copy /compact must copy spec-preserving parameterized command when present');

    // Stage 5: Recovered -> NOMINAL, top offender cleared, single canonical Saved pill + Why drawer inside #simpleFlightRecorder
    dom.window.renderState(states.stage5);
    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'NOMINAL');
    assert.equal(d.getElementById('simpleTopOffenderLine').hidden, true);
    assert.equal(d.getElementById('tufteSavedTokensLabel').textContent, '+274.8k');
    assert.ok(d.getElementById('simpleFlightRecorder').contains(d.getElementById('tufteBaselineStrip')), 'Canonical Saved strip must live inside #simpleFlightRecorder');
    assert.equal(d.getElementById('simpleSavingsWhyDrawer').hidden, true);
    d.getElementById('btnToggleSavingsWhy').click();
    assert.equal(d.getElementById('simpleSavingsWhyDrawer').hidden, false);

    dom.window.close();
  });

  it('verifies Claude Code renderHorizonPanelHtml Option A+ Simple View parity, tabular-nums & inline top offender', () => {
    const bloated = renderHorizonPanelHtml(
      {
        sessionId: 'claude-simple-ux',
        model: 'claude-sonnet-4-6',
        totalInputTokens: 96000,
        systemTokens: 6400,
        cachedTokens: 26600,
        distractorTokens: 63000,
        cache: { warm: true, ttlTier: '5m', remainingSeconds: 218, hitRatePct: 92 }
      },
      {
        offenders: [
          { target: 'sidecars/horizon-daemon/server.mjs', occurrences: 5, wastedTokens: 38400, category: '[D]' }
        ]
      }
    );

    assert.ok(bloated.html.includes('#simpleViewContainer .ah-card'), 'Simple View Bento card CSS must be emitted');
    assert.ok(bloated.html.includes('font-variant-numeric: tabular-nums'), 'Must enforce tabular-nums typography');
    assert.ok(bloated.html.includes('max-height: 580px'), 'Must emit 580px Ambient Collapse rule');
    assert.ok(bloated.html.includes('prefers-color-scheme: light'), 'Must emit light theme contrast tokens');
    assert.ok(bloated.html.includes('id="simpleRunwayHero"') && bloated.html.includes('id="simpleCacheRingPct"') && bloated.html.includes('id="simpleAmnesiaPill"'), 'Must render Runway Hero, Watch Cache Ring, and Amnesia Radar pill');
    assert.ok(bloated.html.includes('id="simpleTopOffender"') && bloated.html.includes('id="simpleTopHogsDrawer"'), 'Must render inline top offender + Top Hogs drawer when D > 0');
    assert.ok(bloated.html.includes('server.mjs (5x · 38.4k)'), 'Must include concise offender basename and wasted tokens');
    assert.equal(bloated.html.includes('.claudeignore'), false, 'Active source file must never show .claudeignore badge');
    assert.ok(bloated.html.includes('id="btnCompactPrimary"') && bloated.html.includes('id="compactInstruction"') && bloated.html.includes('id="compactReclaim"'));
    assert.equal(/https?:\/\/|wss?:\/\//i.test(bloated.html), false, 'Claude HUD HTML must have zero remote URLs or socket protocols');
    assert.equal(bloated.html.includes('id="simpleKpiBar"'), false, 'Option A+ Claude HUD must eliminate redundant #simpleKpiBar');

    const clean = renderHorizonPanelHtml({
      sessionId: 'claude-clean-ux',
      model: 'claude-sonnet-4-6',
      totalInputTokens: 14200,
      tokens: { S: 6400, C: 7800, D: 0, W: 0 }
    });
    assert.equal(clean.html.includes('id="simpleTopOffender"'), false, 'Clean session must omit top offender cause line');
  });

  it('renders the Flight Recorder (pulse timeline, coalesced auto-guard stream, canonical Saved pill) from the real builder contract', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const T0 = Date.parse('2026-01-01T00:00:00Z');
    const iso = (s) => new Date(T0 + s * 1000).toISOString();
    const specs = [];
    for (let i = 0; i < 12; i++) {
      specs.push([{ type: 'USER_INPUT', source: 'USER_EXPLICIT', createdAt: iso(i * 20) }, 100, 'ACTIVE_WORKING_SET']);
      specs.push([{ type: 'PLANNER_RESPONSE', source: 'MODEL', createdAt: iso(i * 20 + 5) }, i % 4 === 1 ? 9000 : 1500, i % 4 === 1 ? 'STALE_DUPLICATE' : 'ACTIVE_WORKING_SET', 'server.mjs']);
    }
    const steps = specs.map((s) => s[0]);
    const classifiedSteps = specs.map((s, idx) => ({ stepIndex: idx, tokens: s[1], category: s[2], target: s[3] || 'x' }));
    const timeline = buildSessionTimeline({ steps, classifiedSteps, safeLimit: 140000, totalActiveTokens: 50000 });
    assert.equal(timeline.turns.length, 12);
    const badTurns = timeline.turns.filter((t) => t.practice === 'bad').length;
    assert.ok(badTurns >= 2, 'fixture must contain bad turns');

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const d = dom.window.document;
    await new Promise((r) => setTimeout(r, 40));

    // Empty states first (Turn-1 / no fixes): 40 ghost slots, honest empty log, armed rail, one canonical saved counter
    const base = createVibeCodingSpiralStates().stage0;
    dom.window.renderState(base);
    assert.equal(d.querySelectorAll('#timelineChart .tl-slot').length, 40);
    assert.equal(d.querySelectorAll('#timelineChart .tl-slot[data-turn]').length, 0);
    assert.match(d.getElementById('autoFixList').textContent, /No auto-fixes yet/);
    assert.ok(d.querySelector('#autoFixList .fx-rail-armed'), 'Permanent auto-guard armed rail must be visible');

    const state = {
      ...createVibeCodingSpiralStates().stage1,
      sessionTimeline: timeline,
      autoFixLog: {
        total: 9,
        items: [
          { id: 3, type: 'CLI_DUMP_COMPRESSED', label: 'CLI output compressed', tokensSaved: 4200, usd: 0.0084, detail: 'npm test', at: iso(100), turn: 6 },
          { id: 2, type: 'LOOP_TURN_PREVENTED', label: 'Loop turn prevented', tokensSaved: 3100, usd: 0.0062, detail: 'dup read', at: iso(40), turn: 3 },
          { id: 1, type: 'LOOP_TURN_PREVENTED', label: 'Loop turn prevented', tokensSaved: 1000, usd: 0.0020, detail: 'dup read', at: iso(41), turn: 3 }
        ]
      }
    };
    dom.window.renderState(state);

    const section = d.getElementById('simpleFlightRecorder');
    assert.ok(section && section.classList.contains('simple-only'), 'Flight Recorder is Simple-View only');
    assert.equal(d.querySelectorAll('#timelineChart .tl-slot').length, 40, 'fixed 40-slot axis');
    assert.equal(d.querySelectorAll('#timelineChart .tl-slot[data-turn]').length, 12);
    assert.equal(d.querySelectorAll('#timelineChart .tl-bar.bad').length, badTurns);
    assert.ok(d.querySelector('#timelineChart svg.tl-line polyline'), 'cumulative context line is drawn');
    assert.ok(d.querySelector('#timelineChart svg.tl-line line[stroke-dasharray]'), 'safe-limit rule is drawn');

    // Default detail = latest bad turn; tapping a bar swaps the one-line reason
    assert.match(d.getElementById('timelineDetail').textContent, /Re-read a file in full/);
    const firstBar = d.querySelector('#timelineChart .tl-slot[data-turn="1"]');
    firstBar.click();
    assert.match(d.getElementById('timelineDetail').textContent, /^T1 /);
    assert.equal(firstBar.getAttribute('aria-pressed'), 'true');

    // Auto-fix log: coalesced identical (type, turn, detail) rows, total badge, expandable rows, permanent armed footer
    assert.equal(d.getElementById('autoFixCount').textContent, '9');
    const rows = d.querySelectorAll('#autoFixList .fx-row');
    assert.equal(rows.length, 2, 'Identical turn auto-fixes must coalesce into one row with xN count');
    assert.match(rows[0].textContent, /CLI output compressed/);
    assert.match(rows[0].querySelector('.fx-saved').textContent, /\+4\.2k/);
    assert.match(rows[1].textContent, /×2|x2|\u00D72/);
    assert.match(rows[1].querySelector('.fx-saved').textContent, /\+4\.1k/);
    assert.ok(d.querySelector('#autoFixList .fx-rail-armed'), 'Auto-guard armed rail remains visible after fixes');
    rows[0].querySelector('.fx-main').click();
    assert.equal(rows[0].querySelector('.fx-more').hidden, false);

    // Unified Option A+ Activity Top Bar + Runway Hero + Watch Ring (no redundant #simpleKpiBar)
    assert.equal(d.getElementById('simpleKpiBar'), null, 'Obsolete #simpleKpiBar must be gone');
    assert.ok(section.contains(d.getElementById('tufteBaselineStrip')), 'Canonical Saved strip lives in Flight Recorder top bar');
    assert.equal(d.querySelectorAll('#tufteSavedTokensLabel').length, 1);
    assert.match(d.getElementById('simpleRunwayHero').textContent, /turn/);
    assert.match(d.getElementById('simpleRunwaySub').textContent, /safe/);
    assert.match(d.getElementById('simpleBurnRateLbl').textContent, /\/turn/);
    assert.match(d.getElementById('simpleCacheRingPct').textContent, /(?:\d+% hit|Cold)/);
    assert.match(d.getElementById('tufteSavedUsd').textContent, /^~\$/);
    assert.ok(html.includes('clamp(56px, 12vh, 84px)'), 'timeline scales cleanly within compact bounds');

    dom.window.close();
  });

  it('renders the Flight Recorder statically for Claude Code from the same contract, with zero scripts-for-data and zero remote URLs', () => {
    const T0 = Date.parse('2026-01-01T00:00:00Z');
    const iso = (s) => new Date(T0 + s * 1000).toISOString();
    const specs = [];
    for (let i = 0; i < 6; i++) {
      specs.push([{ type: 'USER_INPUT', source: 'USER_EXPLICIT', createdAt: iso(i * 20) }, 100, 'ACTIVE_WORKING_SET']);
      specs.push([{ type: 'PLANNER_RESPONSE', source: 'MODEL', createdAt: iso(i * 20 + 5) }, i % 2 ? 9000 : 1200, i % 2 ? 'STALE_DUPLICATE' : 'ACTIVE_WORKING_SET', 'a.js']);
    }
    const timeline = buildSessionTimeline({
      steps: specs.map((s) => s[0]),
      classifiedSteps: specs.map((s, idx) => ({ stepIndex: idx, tokens: s[1], category: s[2], target: s[3] || 'x' })),
      safeLimit: 140000,
      totalActiveTokens: 40000
    });
    const state = {
      sessionId: 'claude-flight',
      model: 'claude-sonnet-4-6',
      totalInputTokens: 96000,
      systemTokens: 6400,
      cachedTokens: 26600,
      distractorTokens: 63000
    };
    const withData = renderHorizonPanelHtml(state, {
      sessionTimeline: timeline,
      autoFixLog: {
        total: 3,
        items: [
          { turn: 3, type: 'CLI_DUMP_COMPRESSED', label: 'CLI output compressed', detail: 'npm test', tokensSaved: 4200, usd: 0.0084 },
          { turn: 2, type: 'LOOP_TURN_PREVENTED', label: 'Loop turn prevented', detail: 'dup read', tokensSaved: 3100, usd: 0.0062 },
          { turn: 2, type: 'LOOP_TURN_PREVENTED', label: 'Loop turn prevented', detail: 'dup read', tokensSaved: 900, usd: 0.0018 }
        ]
      }
    });
    const doc = new JSDOM(withData.html).window.document;
    assert.equal(doc.querySelectorAll('#timelineChart .ah-tl-slot').length, 40);
    assert.equal(doc.querySelectorAll('#timelineChart .ah-tl-bar.ah-tl-bad').length, timeline.turns.filter((t) => t.practice === 'bad').length);
    assert.ok(doc.querySelector('#timelineChart svg polyline'), 'cumulative line');
    assert.equal(doc.querySelectorAll('#autoFixList .ah-fx-row').length, 2, 'Identical turn auto-fixes must coalesce');
    assert.equal(doc.getElementById('autoFixCount').textContent, '3');
    assert.ok(doc.querySelector('#autoFixList .ah-fx-rail-armed'), 'Auto-guard armed rail present');
    const fr = doc.getElementById('simpleFlightRecorder');
    assert.ok(fr && fr.querySelector('#tokensSavedCard'), 'Canonical Saved pill lives inside #simpleFlightRecorder');
    assert.equal(doc.getElementById('simpleKpiBar'), null);
    assert.equal(doc.getElementById('kpiRow'), null);
    assert.match(doc.getElementById('simpleRunwayHero').textContent, /turn/);
    assert.match(doc.getElementById('simpleCacheRingPct').textContent, /%$/);
    assert.equal(/https?:\/\/|wss?:\/\//i.test(withData.html), false);

    const empty = new JSDOM(renderHorizonPanelHtml(state, {}).html).window.document;
    assert.match(empty.getElementById('autoFixList').textContent, /No auto-fixes yet/);
    assert.ok(empty.querySelector('#autoFixList .ah-fx-rail-armed'));
    assert.equal(empty.querySelectorAll('#timelineChart .ah-tl-slot').length, 40);
    assert.equal(empty.querySelectorAll('#timelineChart .ah-tl-bar.ah-tl-bad').length, 0);
  });
});
