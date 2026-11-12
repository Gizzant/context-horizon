/**
 * @file test/phase4_ui_surfaces.test.mjs
 * Phase 4 Exit Gate verification suite:
 *   1. 40-Cell Dynamic Horizon Bar (`src/ui/horizonGrid.mjs`) across 100k (Haiku 90k), 200k, and 1M (>180k) zoom tiers
 *   2. Docked `Pane` 5-Box Simple View vertical hierarchy + zero promotional banner text + 0-fallback receipt
 *   3. `AbovePrompt` 1-line band + `Spinner` suffix (`· Cache 95% (4m12s) · Saved $1.84`) + Mod `ui.render` integration
 *   4. Standalone `statusLine` JSON bridge (`bin/ah-statusline.mjs`) at 80, 110, and 144 terminal columns
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  GRID_CELL_COUNT,
  CELL_CATEGORIES,
  resolveHorizonZoomTier,
  computeHorizonGrid
} from '../../src/core-isomorphic/ui/horizonGrid.mjs';
import {
  stripAnsi,
  renderAbovePromptBand,
  renderSpinnerSuffix,
  renderSimpleViewPane,
  renderStatusLine
} from '../../src/core-isomorphic/ui/modViews.mjs';
import { executeStatusLineBridge } from '../../bin/ah-statusline.mjs';
import { createInitialTelemetryState } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import register from '../../hooks/register.js';

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-phase4-test-'));
}

test('Phase 4.1: 40-Cell Dynamic Horizon Bar zoom tiers (100k Haiku 90k, 200k standard, 1M >180k) & categories', () => {
  // 1. Haiku 5.5 at 90,000 tokens -> 100k zoom tier (2,500 tokens/cell -> 36 occupied cells)
  const haiku90k = computeHorizonGrid({
    modelId: 'claude-haiku-5-5',
    totalInputTokens: 90000,
    systemAndMcpTokens: 10000,
    cachedTokens: 60000,
    distractorTokens: 12500,
    lastWriteTokens: 7500
  });
  assert.equal(haiku90k.cellCount, GRID_CELL_COUNT);
  assert.equal(haiku90k.zoomTier.id, '100k');
  assert.equal(haiku90k.zoomTier.tokensPerCell, 2500);
  assert.equal(haiku90k.occupiedCells, 36);
  assert.equal(haiku90k.emptyCells, 4);
  assert.equal(haiku90k.utilizationPct, 90);
  assert.equal(haiku90k.barChars.length, 40);
  assert.ok(haiku90k.cellCounts.S > 0);
  assert.ok(haiku90k.cellCounts.C > 0);
  assert.ok(haiku90k.cellCounts.D > 0);
  assert.ok(haiku90k.cellCounts.W > 0);
  assert.equal(
    haiku90k.cellCounts.S +
      haiku90k.cellCounts.C +
      haiku90k.cellCounts.D +
      haiku90k.cellCounts.W +
      haiku90k.cellCounts.empty,
    40
  );

  // Verify canonical category colors
  assert.equal(CELL_CATEGORIES.S.colorHex, '#1A73E8');
  assert.equal(CELL_CATEGORIES.C.colorHex, '#81C995');
  assert.equal(CELL_CATEGORIES.D.colorHex, '#F538A0');
  assert.equal(CELL_CATEGORIES.W.colorHex, '#FA903E');

  // 2. Standard 200k operational horizon (Sonnet 5.5 at 100,000 tokens -> 5,000 tokens/cell -> 20 cells)
  const sonnet100k = computeHorizonGrid({
    modelId: 'claude-sonnet-5-5',
    totalInputTokens: 100000,
    systemAndMcpTokens: 15000,
    cachedTokens: 70000,
    distractorTokens: 10000,
    lastWriteTokens: 5000
  });
  assert.equal(sonnet100k.zoomTier.id, '200k');
  assert.equal(sonnet100k.zoomTier.tokensPerCell, 5000);
  assert.equal(sonnet100k.occupiedCells, 20);
  assert.equal(sonnet100k.utilizationPct, 50);

  // 3. Auto-zoom to 1M ceiling when total_input_tokens > 180,000 (250,000 tokens -> 25,000 tokens/cell -> 10 cells)
  const opus250k = computeHorizonGrid({
    modelId: 'claude-opus-5-5',
    totalInputTokens: 250000,
    systemAndMcpTokens: 25000,
    cachedTokens: 175000,
    distractorTokens: 25000,
    lastWriteTokens: 25000
  });
  assert.equal(resolveHorizonZoomTier('claude-opus-5-5', 250000).id, '1M');
  assert.equal(opus250k.zoomTier.id, '1M');
  assert.equal(opus250k.zoomTier.tokensPerCell, 25000);
  assert.equal(opus250k.occupiedCells, 10);
  assert.equal(opus250k.utilizationPct, 25);
});

test('Phase 4.2: Docked Simple View Pane 5-Box vertical hierarchy, zero promotional text, and 0-fallback receipt', () => {
  const tmpDir = createTempWorkspace();
  const initialState = createInitialTelemetryState('sess-pane-test', 'claude-sonnet-5-5');

  const paneEmpty = renderSimpleViewPane(initialState, { cwd: tmpDir });
  assert.equal(paneEmpty.paneId, 'attention-horizon');
  assert.equal(paneEmpty.viewMode, 'SIMPLE_5_BOX');
  assert.equal(paneEmpty.boxes.length, 5);

  // Verify exact 5-Box vertical order
  assert.deepEqual(
    paneEmpty.boxes.map((b) => b.boxNumber),
    [1, 2, 3, 4, 5]
  );
  assert.match(paneEmpty.boxes[0].title, /Capacity & Horizon Bar/);
  assert.match(paneEmpty.boxes[1].title, /Cache Hold & 5m TTL Countdown/);
  assert.match(paneEmpty.boxes[2].title, /Active Coach \/ Circuit Breaker Slot/);
  assert.match(paneEmpty.boxes[3].title, /Top Context Offenders/);
  assert.match(paneEmpty.boxes[4].title, /Deterministic Saved-Quota Receipt/);

  // Verify Box 5 starts strictly at $0.00 and 0 tokens (never legacy 142,400 fallback)
  assert.match(paneEmpty.boxes[4].text, /\$0\.00 USD \| 0 tokens preserved/);
  assert.doesNotMatch(paneEmpty.text, /142,400|142400/);

  // Verify zero self-promotional taglines or marketing banners
  assert.doesNotMatch(
    paneEmpty.text,
    /powered by|built with love|star us|upgrade to pro|sponsor|follow us|the ultimate/i
  );
});

test('Phase 4.3: AbovePrompt Band, Spinner Suffix (`· Cache 95% (4m12s) · Saved $1.84`), and Mod `ui.render` integration', async () => {
  const nowMs = 1_760_000_000_000;
  const state = createInitialTelemetryState('sess-render', 'claude-opus-5-5');
  state.contextWindow.totalInputTokens = 100000;
  state.contextWindow.cachedTokens = 95000;
  state.contextWindow.systemAndMcpTokens = 10000;
  state.contextWindow.distractorTokens = 15000;
  state.contextWindow.lastWriteTokens = 5000;
  state.promptCache.warm = true;
  state.promptCache.expiresAt = nowMs + 252 * 1000; // 4m12s = 252 seconds
  state.cacheRoi.cacheHitRatio = 0.95;
  state.cumulative.netCacheSavingsUSD = 1.84;

  // Test Spinner suffix directly
  const spinner = renderSpinnerSuffix(state, {
    nowMs,
    includeDiskLedger: false
  });
  assert.equal(spinner.suffix, '· Cache 95% (4m12s) · Saved $1.84');

  // Test AbovePrompt band directly
  const band = renderAbovePromptBand(state, {
    nowMs,
    flightMode: 'COACH',
    includeDiskLedger: false
  });
  assert.match(band.plainLine, /\[COACH · HOLD WARM PREFIX\]/);
  assert.match(band.plainLine, /TTL 4m12s/);

  // Test in-process Mod `ui.render` handlers registered in `hooks/register.js`
  const handlers = {};
  register((eventName, fn) => {
    handlers[eventName] = fn;
  });
  assert.equal(typeof handlers['ui.render'], 'function');

  const storeMap = new Map([
    ['ah_session_telemetry', state],
    ['ah_flight_mode', 'AUTO_PILOT']
  ]);
  const mockContext = {
    store: {
      get: (k) => storeMap.get(k),
      set: (k, v) => storeMap.set(k, v)
    },
    ui: {
      invalidate: () => {},
      open: () => {}
    }
  };

  // 1. Spinner render with downstream chaining
  const spinnerOut = await handlers['ui.render'](
    { component: 'Spinner', nowMs },
    mockContext,
    async () => ({ text: 'Thinking...' })
  );
  assert.match(spinnerOut.text, /^Thinking\.\.\. · Cache 95% \(4m12s\) · Saved \$1\.84$/);

  // 2. Pane render (`id: 'attention-horizon'`)
  const paneOut = await handlers['ui.render'](
    { component: 'Pane', id: 'attention-horizon', nowMs },
    mockContext,
    async () => null
  );
  assert.equal(paneOut.boxes.length, 5);
  assert.match(paneOut.content, /Flight Mode: AUTO_PILOT/);

  // 3. AbovePrompt render chaining downstream string
  const aboveOut = await handlers['ui.render'](
    { component: 'AbovePrompt', nowMs },
    mockContext,
    async () => 'User Prompt Line'
  );
  assert.match(aboveOut, /\[AUTO_PILOT · HOLD WARM PREFIX\]/);
  assert.match(aboveOut, /User Prompt Line$/);
});

test('Phase 4.4: Standalone `statusLine` Bridge (`bin/ah-statusline.mjs`) at 80, 110, and 144 terminal columns', () => {
  const tmpDir = createTempWorkspace();
  const nowMs = 1_760_000_000_000;

  const statusPayload = {
    session_id: 'sess-statusline-width',
    model: {
      id: 'claude-haiku-5-5',
      display_name: 'Claude Haiku 5.5'
    },
    context_window: {
      total_input_tokens: 90000,
      context_window_size: 200000,
      system_tokens: 10000,
      distractor_tokens: 15000,
      current_usage: {
        input_tokens: 5000,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 80000,
        output_tokens: 800
      }
    },
    prompt_cache: {
      warm: true,
      ttl: '5m',
      expires_at: nowMs + 252 * 1000
    }
  };

  for (const cols of [80, 110, 144]) {
    const res = executeStatusLineBridge(statusPayload, {
      cwd: tmpDir,
      nowMs,
      columns: cols,
      ansi: true,
      savedUSD: 1.84
    });

    assert.equal(res.columns, cols);
    assert.ok(
      res.visibleLength <= cols,
      `Expected visible length (${res.visibleLength}) <= ${cols} cols: "${res.plainLine}"`
    );
    assert.equal(stripAnsi(res.line).length, res.visibleLength);
    // Verify Haiku 90k selected the 100k zoom tier
    assert.equal(res.grid.zoomTier.id, '100k');
    assert.match(res.plainLine, /90k\/100k/);
    assert.ok(fs.existsSync(res.sessionPath));
  }

  const r80 = renderStatusLine(
    { modelId: 'claude-sonnet-5-5', contextWindow: { totalInputTokens: 45000 } },
    { columns: 80, includeDiskLedger: false }
  );
  const r110 = renderStatusLine(
    { modelId: 'claude-sonnet-5-5', contextWindow: { totalInputTokens: 45000 } },
    { columns: 110, includeDiskLedger: false }
  );
  const r144 = renderStatusLine(
    { modelId: 'claude-sonnet-5-5', contextWindow: { totalInputTokens: 45000 } },
    { columns: 144, includeDiskLedger: false }
  );

  assert.equal(r80.layoutTier, 'compact-80');
  assert.equal(r110.layoutTier, 'standard-110');
  assert.equal(r144.layoutTier, 'wide-144');
  assert.equal(r144.grid.cellCount, 40);
});
