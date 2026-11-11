import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { extractEffortTimeline } from '../src/core/parser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

describe('Surgical Patch: 256k 40-Cell Dynamic Scaling & Transition Placement', () => {
  test('extractEffortTimeline maps transitions to Math.floor(cumTokens / 6400) under 256k ceiling and does not default to 39', () => {
    const steps = [
      { stepIndex: 0, turnMetadata: { effort: 'auto' }, inputTokens: 50000, outputTokens: 20000 },
      { stepIndex: 1, turnMetadata: { effort: 'high', fromSpec: 'auto' }, inputTokens: 50000, outputTokens: 20000 }
    ];
    const res = extractEffortTimeline(steps, { maxTokens: 256000 });
    assert.equal(res.effortHistory.length, 1);
    const tr = res.effortHistory[0];
    // cumTokens at step 1 transition is 20000 -> Math.floor(20000 / 6400) = 3
    assert.equal(tr.blockIndex, 3);
    assert.notEqual(tr.blockIndex, 39);
    assert.equal(tr.fromTier, 'STANDARD');
    assert.equal(tr.toTier, 'HIGH');
  });

  test('At totalTokens = 147700, maxTokens = 256000, safeLimit = 147000: filled cells equal 24, red cells equal 1 (index 23), cells 24..39 empty', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const w = dom.window;
    const d = w.document;

    const testState = {
      schemaVersion: '1.1.0',
      sessionId: 'scale-256k-test',
      window: {
        maxTokens: 256000,
        cellSizeTokens: 6400,
        totalCells: 40,
        totalActiveTokens: 147700,
        usedPercentage: 58,
        turnCount: 20,
        safeLimit: 147000
      },
      tokens: { totalTokens: 147700, maxTokens: 256000 },
      activeEffortProfile: { tier: 'HIGH', label: 'High Reasoning', shortLabel: 'High', safeLimit: 147000 },
      quota: {
        cache: {
          ttlRemainingSec: 240,
          isCacheCold: false
        }
      },
      brainSignals: {
        rules: [],
        duplicateReads: { count: 0, topFiles: [] },
        deadErrorTraces: { count: 0, totalWastedTokens: 0 },
        staleSnapshots: { count: 0 },
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 }
      },
      chronicReads: []
    };

    w.renderState(testState);

    const cells = Array.from(d.querySelectorAll('#miniTimeline .mini-cell'));
    assert.equal(cells.length, 40, 'Should have exactly 40 cells');

    const filledCells = cells.filter(c => !c.classList.contains('headroom-empty'));
    assert.equal(filledCells.length, 24, 'Cells 0..23 (24 cells) must be filled');

    const emptyCells = cells.slice(24);
    assert.equal(emptyCells.length, 16, 'Cells 24..39 must be empty');
    for (const ec of emptyCells) {
      assert.ok(ec.classList.contains('headroom-empty'), `Cell ${ec.dataset.cellIndex} must have headroom-empty`);
    }

    const redCells = cells.filter(c => c.classList.contains('over-limit-cell'));
    assert.equal(redCells.length, 1, 'Only exactly 1 cell should be over-limit red');
    assert.equal(redCells[0].dataset.cellIndex, '23', 'Cell index 23 must be the single over-limit red cell');
  });

  test('When isCacheWarm === true, /compact and AST stub condensation are staged, and Cached History does not show /compact ready', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const w = dom.window;
    const d = w.document;

    const testState = {
      schemaVersion: '1.1.0',
      sessionId: 'warm-cache-test',
      window: {
        maxTokens: 256000,
        cellSizeTokens: 6400,
        totalCells: 40,
        totalActiveTokens: 160000,
        usedPercentage: 62,
        turnCount: 15,
        safeLimit: 147000
      },
      tokens: { totalTokens: 160000, maxTokens: 256000 },
      activeEffortProfile: { tier: 'HIGH', label: 'High Reasoning', shortLabel: 'High', safeLimit: 147000 },
      quota: {
        cache: {
          ttlRemainingSec: 200,
          isCacheCold: false,
          cachedTokens: 80000
        }
      },
      brainSignals: {
        rules: [],
        duplicateReads: { count: 2, topFiles: [{ path: 'foo.js', occurrences: 2, wastedTokens: 4000 }] },
        deadErrorTraces: { count: 0, totalWastedTokens: 0 },
        staleSnapshots: { count: 0 },
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 }
      },
      chronicReads: [
        { path: 'src/webview/horizon_panel.html', sessions: 11, totalWastedTokens: 69400 }
      ]
    };

    w.renderState(testState);

    // 1. Cached History subtext check
    const subClutter = d.getElementById('subClutter');
    assert.ok(subClutter.textContent.includes('95% discounted \u00B7 hold /compact'), 'Cached History must show hold /compact while warm');
    assert.ok(!subClutter.textContent.includes('/compact ready'), 'Cached History must NOT show /compact ready while warm');

    // 2. Hold banner visibility
    const holdBanner = d.getElementById('cacheGatedHoldBanner');
    assert.equal(holdBanner.style.display, 'flex', 'Cache-gated hold banner must be visible');
    const holdMsg = d.getElementById('cacheGatedHoldMsg');
    assert.ok(holdMsg.textContent.includes('STAGED FOR COLD CACHE'), 'Hold msg must mention STAGED FOR COLD CACHE');

    // 3. Prefix-mutating actions hidden in Simple View list when warm
    const actionList = d.getElementById('simpleActionList');
    assert.ok(!actionList.querySelector('[data-action-id="compact-context"]'), '/compact must be staged when cache is warm');
    assert.ok(!actionList.querySelector('[data-action-id="condense-ast"]'), 'AST condensation must be staged when cache is warm');
  });

  test('#compactInstruction contains exact text Type /compact in the chat box and press Enter with no button inside /compact row', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const w = dom.window;
    const d = w.document;

    const compactRow = d.getElementById('actionRowCompact');
    assert.ok(compactRow, '#actionRowCompact must exist');
    const compactInst = compactRow.querySelector('#compactInstruction') || d.getElementById('compactInstruction');
    assert.ok(compactInst, '#compactInstruction must exist');
    assert.ok(compactInst.textContent.includes('Type /compact in the chat box and press Enter'), 'Instruction must be exact');

    // Double check zero clickable buttons on the /compact row
    const btns = compactRow.querySelectorAll('button');
    assert.equal(btns.length, 0, 'Zero buttons allowed in /compact row');
  });

  test('Chronic offender row does not duplicate chat count in title and #strandedSignalBanner renders actionable [Re-anchor] button', async () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const w = dom.window;
    const d = w.document;

    const testState = {
      schemaVersion: '1.1.0',
      sessionId: 'chronic-test',
      window: {
        maxTokens: 256000,
        cellSizeTokens: 6400,
        totalCells: 40,
        totalActiveTokens: 80000,
        usedPercentage: 31,
        turnCount: 12,
        safeLimit: 179000
      },
      tokens: { totalTokens: 80000, maxTokens: 256000 },
      activeEffortProfile: { tier: 'STANDARD', label: 'Auto', shortLabel: 'Auto', safeLimit: 179000 },
      quota: { cache: { ttlRemainingSec: 0, isCacheCold: true } },
      brainSignals: {
        rules: [],
        duplicateReads: { count: 0, topFiles: [] },
        deadErrorTraces: { count: 0, totalWastedTokens: 0 },
        staleSnapshots: { count: 0 },
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 }
      },
      chronicReads: [
        { path: 'src/webview/horizon_panel.html', sessions: 11, totalWastedTokens: 69400 }
      ],
      cells: [
        ...Array.from({ length: 7 }, (_, i) => ({ index: i, dominantCategory: 'ANCHOR', totalTokens: 6400 })),
        { index: 7, dominantCategory: 'ANCHOR', totalTokens: 6400, topTarget: 'AGENTS.md', inAttentionTrough: true, isStrandedSignal: true },
        { index: 8, dominantCategory: 'ACTIVE_WORKING_SET', totalTokens: 6400, topTarget: 'constants.mjs', inAttentionTrough: true, isStrandedSignal: true },
        ...Array.from({ length: 31 }, (_, i) => ({ index: i + 9, dominantCategory: 'FREE_HEADROOM', totalTokens: 0 }))
      ]
    };

    w.renderState(testState);

    // 1. Chronic row title check
    const chronicRow = d.querySelector('[data-action-id="chronic-read"]');
    assert.ok(chronicRow, 'Chronic row must render');
    const title = chronicRow.querySelector('.m3-action-title')?.textContent || '';
    assert.ok(!title.includes('chats'), 'Title must NOT include chat count duplicate');
    assert.ok(!title.includes('69.4k'), 'Title must NOT include token waste duplicate');
    const badge = chronicRow.querySelector('.m3-impact-badge')?.textContent || '';
    assert.ok(badge.includes('11 chats') && badge.includes('69.4k'), 'Right badge must display 11 chats · 69.4k');

    // 2. Stranded banner with [Re-anchor] button
    const banner = d.getElementById('strandedSignalBanner');
    assert.equal(banner.hidden, false, 'Stranded banner must be visible');
    const reanchorBtn = banner.querySelector('#btnStrandedReanchor');
    assert.ok(reanchorBtn, '[Re-anchor] button must be rendered inside banner');
    assert.ok(reanchorBtn.textContent.includes('Re-anchor'), 'Button text must include Re-anchor');
  });
});
