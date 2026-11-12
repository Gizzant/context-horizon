/**
 * @file test/batch2_economics_and_telemetry.test.mjs
 * Comprehensive regression suite for Batch 2 remediation (`ISS-001`, `ISS-002`, `ISS-003`,
 * `ISS-004`, `ISS-005`, `ISS-006`, `ISS-024`, `ISS-027`, `ISS-030`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../../src/utils/nodeIo.mjs';

import {
  BUILTIN_CATALOG,
  getModelSpec,
  extractNormalizedTokenBreakdown,
  computeTotalPromptTokens,
  resolveEffectiveRates,
  calculateTurnCostUSD
} from '../../src/core-isomorphic/config/catalogLoader.mjs';
import {
  computeCacheRoi,
  createInitialTelemetryState,
  ingestModTurnEvent,
  ingestStatusLinePayload,
  writeLiveStateSnapshot
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import {
  FLIGHT_MODES,
  resolveNaturalDownshiftPeer,
  computeBreakEvenCachedTokens,
  PostCompactMutationQueue,
  CacheGravityRouter
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { TtlWatchdog } from '../../src/core-isomorphic/coach/ttlWatchdog.mjs';
import { handlePostCompactFlush } from '../../src/core-isomorphic/coach/stateBatonHydrator.mjs';
import {
  getSavedQuotaReceiptSummary,
  recordTurnCacheSavings
} from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { loadRepoCalibration } from '../../src/core-isomorphic/coach/repoCalibration.mjs';
import {
  CircuitBreakerEngine,
  evaluateDet12HaikuPreCliffBreaker
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { computeHorizonGrid, resolveHorizonZoomTier } from '../../src/core-isomorphic/ui/horizonGrid.mjs';
import {
  deriveSurfaceMetrics,
  renderAbovePromptBand,
  renderSpinnerSuffix,
  renderSimpleViewPane,
  renderStatusLine
} from '../../src/core-isomorphic/ui/modViews.mjs';
import {
  sanitizeRepositoryUrl,
  exportOtelTelemetry
} from '../../src/core-isomorphic/telemetry/otelExporter.mjs';
import { runPostToolUseHook } from '../../hooks/handlers/post-tool-use.mjs';
import { runPreToolUseHook } from '../../hooks/handlers/pre-tool-use.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import register from '../../hooks/register.js';
import { runHookLatencyBenchmark } from '../../scripts/bench_hooks.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..', '..');

function makeTempDir(prefix = 'ah-batch2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildNoisyBashOutput(lineCount = 120) {
  return Array.from(
    { length: lineCount },
    (_, idx) => `\x1b[32m✔ passing test case #${idx} (${'x'.repeat(40)})\x1b[0m`
  ).join('\n');
}

// ============================================================================
// 1. ISS-001: Dynamic Model Rate Resolution in hooks/handlers/post-tool-use.mjs
// ============================================================================

test('ISS-001: post-tool-use resolves dynamic model & cliff rates instead of hardcoded $2.00/1M', () => {
  const tmpDir = makeTempDir('ah-iss001-');
  try {
    const noisyOutput = buildNoisyBashOutput(120);

    // 1. Haiku 5.5 below 100k cliff ($0.10/1M input — 20x lower than legacy hardcoded $2.00/1M)
    const haikuBaseState = createInitialTelemetryState('sess-haiku-base', 'claude-haiku-5-5');
    haikuBaseState.contextWindow.totalInputTokens = 40_000;
    writeLiveStateSnapshot('sess-haiku-base', haikuBaseState, { cwd: tmpDir });

    const resHaikuBase = runPostToolUseHook(
      {
        session_id: 'sess-haiku-base',
        tool_name: 'Bash',
        tool_output: noisyOutput
      },
      { cwd: tmpDir }
    );
    assert.ok(resHaikuBase.sanitized.savedTokens > 0);

    const summaryBase = getSavedQuotaReceiptSummary({
      cwd: tmpDir,
      sessionId: 'sess-haiku-base'
    });
    assert.equal(summaryBase.entryCount, 1);
    assert.equal(summaryBase.entries[0].modelId, 'claude-haiku-5-5');
    const expectedHaikuBaseUSD = Number(
      ((resHaikuBase.sanitized.savedTokens / 1_000_000) * 0.1).toFixed(6)
    );
    assert.equal(summaryBase.entries[0].savedUSD, expectedHaikuBaseUSD);

    // 2. Haiku 5.5 above 100k cliff ($0.50/1M input — 5x step-up)
    const resHaikuCliff = runPostToolUseHook(
      {
        session_id: 'sess-haiku-cliff',
        model: 'claude-haiku-5-5',
        usage: {
          input_tokens: 15_000,
          cache_read_input_tokens: 90_000
        },
        tool_name: 'Bash',
        tool_output: noisyOutput
      },
      { cwd: tmpDir }
    );
    const summaryCliff = getSavedQuotaReceiptSummary({
      cwd: tmpDir,
      sessionId: 'sess-haiku-cliff'
    });
    const expectedHaikuCliffUSD = Number(
      ((resHaikuCliff.sanitized.savedTokens / 1_000_000) * 0.5).toFixed(6)
    );
    assert.equal(summaryCliff.entries[0].savedUSD, expectedHaikuCliffUSD);

    // 3. Opus 4.6 ($5.00/1M) and Fable 5.1 ($10.00/1M)
    const resOpus46 = runPostToolUseHook(
      {
        session_id: 'sess-opus46',
        model: { id: 'claude-opus-4-6' },
        tool_name: 'Bash',
        tool_output: noisyOutput
      },
      { cwd: tmpDir }
    );
    const summaryOpus46 = getSavedQuotaReceiptSummary({
      cwd: tmpDir,
      sessionId: 'sess-opus46'
    });
    assert.equal(summaryOpus46.entries[0].modelId, 'claude-opus-4-6');
    assert.equal(
      summaryOpus46.entries[0].savedUSD,
      Number(((resOpus46.sanitized.savedTokens / 1_000_000) * 5.0).toFixed(6))
    );

    const resFable = runPostToolUseHook(
      {
        session_id: 'sess-fable',
        model: 'claude-fable-5-1',
        tool_name: 'Bash',
        tool_output: noisyOutput
      },
      { cwd: tmpDir }
    );
    const summaryFable = getSavedQuotaReceiptSummary({
      cwd: tmpDir,
      sessionId: 'sess-fable'
    });
    assert.equal(summaryFable.entries[0].modelId, 'claude-fable-5-1');
    assert.equal(
      summaryFable.entries[0].savedUSD,
      Number(((resFable.sanitized.savedTokens / 1_000_000) * 10.0).toFixed(6))
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. ISS-002: Catalog Parity, Haiku 4.5 ($1.00/$5.00) & [1m] Claude 4.6 Ceilings
// ============================================================================

test('ISS-002: BUILTIN_CATALOG strictly matches anthropicModelCatalog.json, Haiku 4.5 is $1/$5, and [1m] unlocks 1M on 4.6', () => {
  const jsonCatalog = JSON.parse(
    fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'core-isomorphic', 'config', 'anthropicModelCatalog.json'),
      'utf8'
    )
  );

  // Strict structural parity check across every model ID, rate, multiplier, ceiling, and cliff
  assert.equal(BUILTIN_CATALOG.schemaVersion, jsonCatalog.schemaVersion);
  assert.equal(BUILTIN_CATALOG.defaultModel, jsonCatalog.defaultModel);
  assert.deepStrictEqual(BUILTIN_CATALOG.models, jsonCatalog.models);

  // Published Haiku 4.5 rates: $1.00 / $5.00 / $1.25 / $2.00 / $0.10
  const haiku45 = resolveEffectiveRates('claude-haiku-4-5', 50_000);
  assert.equal(haiku45.inputPer1M, 1.0);
  assert.equal(haiku45.outputPer1M, 5.0);
  assert.equal(haiku45.write5mPer1M, 1.25);
  assert.equal(haiku45.write1hPer1M, 2.0);
  assert.equal(haiku45.readPer1M, 0.1);

  // Claude 4.6 defaults to 200,000 without [1m], and resolves 1,000,000 when [1m]/-1m/extendedContext1M is present
  assert.equal(resolveEffectiveRates('claude-sonnet-4-6', 50_000).contextCeiling, 200_000);
  assert.equal(resolveEffectiveRates('claude-opus-4-6', 50_000).contextCeiling, 200_000);

  assert.equal(resolveEffectiveRates('claude-sonnet-4-6[1m]', 50_000).contextCeiling, 1_000_000);
  assert.equal(resolveEffectiveRates('claude-opus-4-6[1m]', 50_000).contextCeiling, 1_000_000);
  assert.equal(resolveEffectiveRates('claude-sonnet-4-6-1m', 50_000).contextCeiling, 1_000_000);
  assert.equal(
    getModelSpec('claude-opus-4-6', { extendedContext1M: true }).contextCeiling,
    1_000_000
  );
});

// ============================================================================
// 3. ISS-003: Nested cache_creation.ephemeral_* & Non-Retroactive Haiku 5x Cliff
// ============================================================================

test('ISS-003: computeTotalPromptTokens captures nested ephemeral_* without double-counting and 4x30k warm Haiku never triggers 5x cliff', () => {
  // 1. Nested-only cache_creation.ephemeral_5m_input_tokens = 95,000 + input_tokens = 10,000 -> 105,000 (> 100k cliff!)
  const nestedOnly = {
    model: 'claude-haiku-5-5',
    input_tokens: 10_000,
    cache_creation: {
      ephemeral_5m_input_tokens: 95_000
    },
    output_tokens: 1_000
  };
  assert.equal(computeTotalPromptTokens(nestedOnly), 105_000);
  const nestedCost = calculateTurnCostUSD(nestedOnly);
  assert.equal(nestedCost.cliffTriggered, true);
  assert.equal(nestedCost.tokens.cacheWrite5m, 95_000);
  // Above 100k cliff on Haiku 5.5: write5m is $0.625/1M -> 95k * 0.625 = $0.059375
  assert.equal(nestedCost.costsUSD.write5m, 0.059375);

  // 2. Flat + nested fields present simultaneously MUST NOT double-count
  const bothFlatAndNested = {
    input_tokens: 10_000,
    cache_creation_input_tokens: 95_000,
    cache_creation: {
      ephemeral_5m_input_tokens: 60_000,
      ephemeral_1h_input_tokens: 35_000
    }
  };
  const breakdown = extractNormalizedTokenBreakdown(bothFlatAndNested);
  assert.equal(breakdown.remainingGenericWriteTokens, 0);
  assert.equal(breakdown.totalCacheWriteTokens, 95_000);
  assert.equal(computeTotalPromptTokens(bothFlatAndNested), 105_000);

  // 3. Multi-turn non-retroactive cliff: 4 warm Haiku 5.5 turns of 30k tokens (120k cumulative, 0 turns > 100k)
  let modState = createInitialTelemetryState('sess-haiku-4x30k', 'claude-haiku-5-5');
  for (let turn = 1; turn <= 4; turn++) {
    modState = ingestModTurnEvent(modState, {
      type: 'turn.complete',
      turnId: `turn-${turn}`,
      model: 'claude-haiku-5-5',
      usage: {
        input_tokens: 2_000,
        cache_creation_input_tokens: turn === 1 ? 28_000 : 0,
        cache_read_input_tokens: turn === 1 ? 0 : 28_000,
        output_tokens: 500
      }
    });
  }
  assert.equal(modState.steps, 4);
  assert.equal(modState.cliffTriggered, false);
  assert.equal(modState.cacheRoi.cliffTriggered, false);
  // Cumulative tokens = 8k uncached + 28k write5m + 84k cacheRead = 120k (> 100k cumulative, but each turn was 30k <= 100k!)
  // Base Haiku 5.5 rates: write5m = $0.125/1M, read = $0.01/1M, input = $0.10/1M
  // Actual cache spend = 28k * $0.125/1M ($0.0035) + 84k * $0.01/1M ($0.00084) = $0.00434
  // Uncached baseline = (28k + 84k) * $0.10/1M = $0.0112
  assert.equal(modState.cacheRoi.actualCacheSpendUSD, 0.00434);
  assert.equal(modState.cacheRoi.uncachedBaselineUSD, 0.0112);
  assert.equal(modState.cacheRoi.netCacheSavingsUSD, 0.00686);

  // 4. Standalone statusLine ticks increment state.steps and keep 4x30k non-retroactive
  let slState = createInitialTelemetryState('sess-sl-4x30k', 'claude-haiku-5-5');
  for (let turn = 1; turn <= 4; turn++) {
    slState = ingestStatusLinePayload(slState, {
      session_id: 'sess-sl-4x30k',
      turn_id: `sl-turn-${turn}`,
      model: { id: 'claude-haiku-5-5' },
      context_window: {
        total_input_tokens: 30_000,
        current_usage: {
          input_tokens: 2_000,
          cache_creation_input_tokens: turn === 1 ? 28_000 : 0,
          cache_read_input_tokens: turn === 1 ? 0 : 28_000,
          output_tokens: 500
        }
      }
    });
  }
  assert.equal(slState.steps, 4);
  assert.equal(slState.cliffTriggered, false);
  assert.equal(slState.cacheRoi.cliffTriggered, false);
  assert.equal(slState.cacheRoi.actualCacheSpendUSD, 0.00434);
  assert.equal(slState.cacheRoi.uncachedBaselineUSD, 0.0112);
});

// ============================================================================
// 4. ISS-004: computeTotalPromptTokens Across DET-12, DET-09, DET-10 & PreModelSwitch
// ============================================================================

test('ISS-004: DET-12, DET-09, DET-10 (including 1h write rate), and PreModelSwitch sum full prompt envelopes', () => {
  // 1. DET-12 with camelCase + nested ephemeral_5m_input_tokens summing to 99,000 (>= 98,000 hard deny)
  const det12 = evaluateDet12HaikuPreCliffBreaker({
    modelId: 'claude-haiku-5-5',
    freshInputTokens: 15_000,
    cacheReadInputTokens: 40_000,
    cache_creation: {
      ephemeral_5m_input_tokens: 44_000
    }
  });
  assert.equal(det12.triggered, true);
  assert.equal(det12.totalInputTokens, 99_000);
  assert.equal(det12.decision, 'deny');

  // Also verify via runPreToolUseHook in AUTO_PILOT mode
  const hookRes = runPreToolUseHook(
    {
      tool_name: 'Grep',
      model: 'claude-haiku-5-5',
      usage: {
        freshInputTokens: 15_000,
        cacheReadInputTokens: 40_000,
        cache_creation: { ephemeral_5m_input_tokens: 44_000 }
      },
      tool_input: { pattern: 'foo' }
    },
    { mode: 'AUTO_PILOT' }
  );
  assert.equal(hookRes.exitCode, 2);
  assert.match(hookRes.stderr, /DET-12/);

  // 2. DET-09 (PostCompactMutationQueue): Haiku 5.5 with 60k cached + 45k uncached = 105k (> 100k 5x cliff)
  const router = new CacheGravityRouter({ mode: FLIGHT_MODES.COACH });
  const det09 = router.interceptTopLevelMutation({
    type: 'effort',
    value: 'high',
    currentModel: 'claude-haiku-5-5',
    cachedTokens: 60_000,
    uncachedInputTokens: 45_000,
    cacheWarm: true,
    cacheTtlTier: '5m'
  });
  assert.equal(det09.queued, true);
  // Above 100k on Haiku 5.5: write5m = $0.625, read = $0.05 -> 60k/1M * 0.575 = $0.0345 (5x of $0.0069!)
  assert.equal(det09.avoidedRewritePenaltyUSD, 0.0345);

  // 3. DET-10 (TtlWatchdog): honors totalPromptTokens cliff AND 1h write1hPer1M rate
  const watchdog = new TtlWatchdog({ mode: FLIGHT_MODES.COACH });
  const tickHaikuCliff = watchdog.evaluateTick({
    modelId: 'claude-haiku-5-5',
    cacheWarm: true,
    cachedTokens: 60_000,
    input_tokens: 45_000, // 105k total > 100k cliff
    remainingSeconds: 30,
    hasRecentWorkspaceEdits: true,
    ttlTier: '5m'
  });
  assert.equal(tickHaikuCliff.expiryPenaltyUSD, 0.0345);

  const tickOpus1h = watchdog.evaluateTick({
    modelId: 'claude-opus-5-5',
    cacheWarm: true,
    cachedTokens: 100_000,
    remainingSeconds: 30,
    hasRecentWorkspaceEdits: true,
    ttlTier: '1h'
  });
  // Opus 5.5 1h write = $8.00/1M, read = $0.20/1M -> 100k/1M * 7.80 = $0.78 (vs 5m $0.48)
  assert.equal(tickOpus1h.expiryPenaltyUSD, 0.78);

  // 4. pre-model-switch.mjs forwards uncached_delta_tokens and cache_ttl_tier: '1h'
  const preSwitch1h = runPreModelSwitchHook({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 40_000,
    uncached_delta_tokens: 10_000,
    cache_ttl_tier: '1h',
    cacheWarm: true,
    mode: 'AUTO_PILOT'
  });
  assert.equal(preSwitch1h.exitCode, 2);
  assert.equal(preSwitch1h.verdict.breakEven.cacheTtlTier, '1h');
  assert.equal(preSwitch1h.verdict.breakEven.uncachedDeltaTokens, 10_000);
  assert.match(preSwitch1h.stderr, /2\.0x/);
});

// ============================================================================
// 5. ISS-005: Honor customCeilings.json in telemetryBridge.mjs & horizonGrid.mjs
// ============================================================================

test('ISS-005: customCeilings.json overrides statusLine context_window_size and scales 40-cell Horizon Grid', () => {
  const tmpDir = makeTempDir('ah-iss005-');
  try {
    const customDir = path.join(tmpDir, '.claude', 'attention-horizon');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, 'customCeilings.json'),
      JSON.stringify({ 'claude-sonnet-5-5': 400_000 }, null, 2),
      'utf8'
    );

    const state = ingestStatusLinePayload(
      null,
      {
        session_id: 'sess-custom-ceiling',
        model: { id: 'claude-sonnet-5-5' },
        context_window: {
          total_input_tokens: 100_000,
          context_window_size: 200_000 // Must NOT clobber user's 400k custom ceiling!
        }
      },
      { cwd: tmpDir }
    );

    assert.equal(state.contextCeiling, 400_000);
    assert.equal(state.contextWindow.customCeiling, 400_000);

    const grid = computeHorizonGrid(state, { cwd: tmpDir });
    assert.equal(grid.zoomTier.id, '400k');
    assert.equal(grid.zoomTier.ceilingTokens, 400_000);
    assert.equal(grid.zoomTier.tokensPerCell, 10_000);
    assert.equal(grid.occupiedCells, 10);
    assert.equal(grid.utilizationPct, 25);

    const directTier = resolveHorizonZoomTier('claude-sonnet-5-5', 100_000, { cwd: tmpDir });
    assert.equal(directTier.id, '400k');

    const pane = renderSimpleViewPane(state, { cwd: tmpDir, includeDiskLedger: false });
    assert.match(pane.boxes[0].text, /400k Custom Horizon/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. ISS-006: Break-Even C*, Pane Peer Mapping, Dynamic ROI Ratio & Turn-1 Cache 0%
// ============================================================================

test('ISS-006: C* uncachedDelta term, upshift allow, Opus 4.6 -> 4,615 Pane, dynamic ROI ratios, and Turn-1 Cold Cache 0%', () => {
  // 1. Exact baseline C* numbers preserved when uncachedDeltaTokens === 0
  assert.equal(
    computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500
    }).breakEvenTokens,
    6522
  );
  assert.equal(
    computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-4-6',
      targetModel: 'claude-sonnet-4-6',
      expectedOutputTokens: 1500
    }).breakEvenTokens,
    4615
  );

  // 2. uncachedDeltaTokens write differential shifts C* and prevents holding when coldWritePenaltyUSD <= 0
  const withUncachedDelta = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    expectedOutputTokens: 1500,
    cachedTokens: 10_000,
    uncachedDeltaTokens: 20_000,
    cacheWarm: true
  });
  assert.equal(withUncachedDelta.breakEvenTokens, 28_261);
  assert.ok(withUncachedDelta.coldWritePenaltyUSD < 0);
  assert.equal(withUncachedDelta.shouldHoldModel, false);

  // 3. Capability upshifts (Sonnet 5.5 -> Opus 5.5) NEVER hold or deny even in AUTO_PILOT with 90k warm cache
  const autoRouter = new CacheGravityRouter({ mode: FLIGHT_MODES.AUTO_PILOT });
  const upshift = autoRouter.evaluateModelSwitch({
    currentModel: 'claude-sonnet-5-5',
    targetModel: 'claude-opus-5-5',
    cachedTokens: 90_000,
    cacheWarm: true
  });
  assert.equal(upshift.decision, 'allow');
  assert.equal(upshift.blocked, false);
  assert.equal(upshift.breakEven.shouldHoldModel, false);

  // 4. Docked Pane natural downshift peer mapping (Opus 4.6 -> 4,615, Opus 5.5 -> 6,522, Fable -> Opus 5.5)
  assert.equal(resolveNaturalDownshiftPeer('claude-opus-5-5'), 'claude-sonnet-5-5');
  assert.equal(resolveNaturalDownshiftPeer('claude-opus-4-6'), 'claude-sonnet-4-6');
  assert.equal(resolveNaturalDownshiftPeer('claude-opus-4-5'), 'claude-sonnet-4-6');
  assert.equal(resolveNaturalDownshiftPeer('claude-sonnet-5-5'), 'claude-haiku-5-5');
  assert.equal(resolveNaturalDownshiftPeer('claude-sonnet-4-6'), 'claude-haiku-4-5');
  assert.equal(resolveNaturalDownshiftPeer('claude-fable-5-2'), 'claude-opus-5-5');

  const paneOpus46 = renderSimpleViewPane(
    createInitialTelemetryState('sess-o46', 'claude-opus-4-6'),
    { includeDiskLedger: false }
  );
  assert.match(paneOpus46.boxes[1].text, /Break-Even Gravity C\*: 4,615 cached tokens/);

  const paneOpus55 = renderSimpleViewPane(
    createInitialTelemetryState('sess-o55', 'claude-opus-5-5'),
    { includeDiskLedger: false }
  );
  assert.match(paneOpus55.boxes[1].text, /Break-Even Gravity C\*: 6,522 cached tokens/);

  // 5. Dynamic breakEvenReadsPerWrite across 95% & 90% read discounts and 5m/1h tiers + sessionFiveMinRoiTarget = 1.39
  const roi5m95 = computeCacheRoi({ model: 'claude-opus-5-5', cacheTtlTier: '5m' });
  const roi5m90 = computeCacheRoi({ model: 'claude-opus-4-6', cacheTtlTier: '5m' });
  const roi1h95 = computeCacheRoi({ model: 'claude-opus-5-5', cacheTtlTier: '1h' });
  const roi1h90 = computeCacheRoi({ model: 'claude-opus-4-6', cacheTtlTier: '1h' });
  assert.equal(roi5m95.breakEvenReadsPerWrite, 0.263);
  assert.equal(roi5m90.breakEvenReadsPerWrite, 0.278);
  assert.equal(roi1h95.breakEvenReadsPerWrite, 1.053);
  assert.equal(roi1h90.breakEvenReadsPerWrite, 1.111);
  assert.equal(roi5m90.sessionFiveMinRoiTarget, 1.39);

  // 6. Turn-1 Cold Cache Write (cacheReadTokens = 0, write5mTokens = 50,000) renders Cache 0% and R/W = 0
  const turn1ColdState = ingestModTurnEvent(
    createInitialTelemetryState('sess-cold-t1', 'claude-sonnet-5-5'),
    {
      type: 'turn.complete',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 0,
        output_tokens: 400
      }
    },
    { nowMs: 1_760_000_000_000 }
  );
  const coldMetrics = deriveSurfaceMetrics(turn1ColdState, {
    nowMs: 1_760_000_005_000,
    includeDiskLedger: false
  });
  assert.equal(coldMetrics.cacheHitPct, 0);
  assert.equal(coldMetrics.readsPerWriteRatio, 0);
  assert.equal(coldMetrics.warmPrefixTokens, 50_000);

  const coldSpinner = renderSpinnerSuffix(turn1ColdState, {
    nowMs: 1_760_000_005_000,
    includeDiskLedger: false
  });
  assert.match(coldSpinner.suffix, /Cache 0%/);

  const coldStatus = renderStatusLine(turn1ColdState, {
    nowMs: 1_760_000_005_000,
    columns: 110,
    ansi: false,
    includeDiskLedger: false
  });
  assert.match(coldStatus.plainLine, /Cache 0%/);
});

// ============================================================================
// 7. ISS-024: Eliminate Fabricated 25000 & 1500 Token Fallbacks
// ============================================================================

test('ISS-024: PostCompact never fabricates 25,000 tokens/mutation and Read calibration never fabricates 1,500 tokens', () => {
  const tmpDir = makeTempDir('ah-iss024-');
  try {
    const ledgerPath = path.join(tmpDir, '.claude', 'cache', 'horizon_ledger.jsonl');

    // 1. Flush 2 queued mutations with unknown cachedTokens -> savedTokens MUST be 0 (never 2 * 25000 = 50000!)
    const queueUnknown = new PostCompactMutationQueue([
      { type: 'effort', key: 'effort', value: 'high', avoidedRewritePenaltyUSD: 0.12 },
      { type: 'thinking', key: 'thinking', value: 'enabled', avoidedRewritePenaltyUSD: 0.08 }
    ]);
    const flushUnknown = handlePostCompactFlush(
      { session_id: 'sess-zero-fab', compactionId: 'c1' },
      { cwd: tmpDir, ledgerPath, mutationQueue: queueUnknown }
    );
    assert.equal(flushUnknown.flushedCount, 2);
    assert.equal(flushUnknown.ledgerEntry.savedTokens, 0);
    assert.equal(flushUnknown.ledgerEntry.savedUSD, 0.2);

    // 2. Flush queued mutation with actual recorded cachedTokens -> sums actual entry.cachedTokens
    const queueActual = new PostCompactMutationQueue([
      {
        type: 'effort',
        key: 'effort',
        value: 'medium',
        cachedTokens: 32_000,
        avoidedRewritePenaltyUSD: 0.15
      }
    ]);
    const flushActual = handlePostCompactFlush(
      { session_id: 'sess-actual-fab', compactionId: 'c2' },
      { cwd: tmpDir, ledgerPath, mutationQueue: queueActual }
    );
    assert.equal(flushActual.ledgerEntry.savedTokens, 32_000);

    // 3. CircuitBreakerEngine Read calibration: unknown missing file -> 0 tokens (never 1500); real file -> ceil(bytes/4)
    const calibrationPath = path.join(tmpDir, '.claude', 'cache', 'repo_calibration.json');
    const engine = new CircuitBreakerEngine({
      cwd: tmpDir,
      enableRepoCalibration: true,
      calibrationPath
    });

    engine.evaluatePreToolUse(
      {
        tool_name: 'Read',
        tool_input: { file_path: 'src/does_not_exist.mjs' }
      },
      { sessionId: 'sess-cal-1' }
    );

    const realFile = path.join(tmpDir, 'src', 'real_module.mjs');
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, 'x'.repeat(800), 'utf8'); // 800 bytes -> 200 estimated tokens

    engine.evaluatePreToolUse(
      {
        tool_name: 'Read',
        tool_input: { file_path: 'src/real_module.mjs' }
      },
      { sessionId: 'sess-cal-1' }
    );

    engine.evaluatePreToolUse(
      {
        tool_name: 'Read',
        fileByteSize: 4000,
        tool_input: { file_path: 'src/injected_size.mjs' }
      },
      { sessionId: 'sess-cal-1' }
    );

    const calState = loadRepoCalibration({ cwd: tmpDir, calibrationPath });
    assert.equal(calState.fileReads['src/does_not_exist.mjs'].totalEstimatedTokens, 0);
    assert.equal(calState.fileReads['src/real_module.mjs'].totalEstimatedTokens, 200);
    assert.equal(calState.fileReads['src/injected_size.mjs'].totalEstimatedTokens, 1000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. ISS-027: Deduplicate turn.step + turn.complete, Isolate Subagent & Fix WARM 0s
// ============================================================================

test('ISS-027: turn.step + turn.complete commits 1x, subagents never overwrite empty main window, and 0s TTL is COLD', async () => {
  const tmpDir = makeTempDir('ah-iss027-');
  try {
    let state = createInitialTelemetryState('sess-dedupe', 'claude-opus-5-5');

    // 1. Subagent finishes FIRST while main contextWindow.totalInputTokens === 0 -> main window MUST stay 0!
    state = ingestModTurnEvent(state, {
      type: 'turn.step',
      subagentId: 'subagent-first',
      isSubagent: true,
      model: 'claude-haiku-5-5',
      usage: {
        input_tokens: 4_000,
        output_tokens: 500
      }
    });
    state = ingestModTurnEvent(state, {
      type: 'turn.complete',
      subagentId: 'subagent-first',
      isSubagent: true,
      model: 'claude-haiku-5-5',
      usage: {
        input_tokens: 4_000,
        output_tokens: 500
      }
    });
    assert.equal(state.contextWindow.totalInputTokens, 0);
    assert.equal(state.modelId, 'claude-opus-5-5');
    assert.equal(state.subagents['subagent-first'].turns, 1);
    assert.equal(state.subagents['subagent-first'].totalTokens, 4_500);

    // 2. Main agent turn: turn.step + turn.complete with identical usage commits strictly 1x (not 2x!)
    const mainUsage = {
      input_tokens: 2_000,
      cache_creation_input_tokens: 50_000,
      cache_read_input_tokens: 10_000,
      output_tokens: 1_000
    };
    state = ingestModTurnEvent(state, {
      type: 'turn.step',
      turnId: 'main-turn-1',
      model: 'claude-opus-5-5',
      usage: mainUsage
    });
    state = ingestModTurnEvent(state, {
      type: 'turn.complete',
      turnId: 'main-turn-1',
      model: 'claude-opus-5-5',
      usage: mainUsage
    });

    assert.equal(state.contextWindow.totalInputTokens, 62_000);
    assert.equal(state.cumulative.cacheWrite5mTokens, 50_000);
    assert.equal(state.cumulative.cacheReadTokens, 10_000);
    assert.equal(state.cumulative.outputTokens, 1_500); // 500 subagent + 1,000 main (1x!)

    // Duplicate turn.complete with same turnId in register.js & recordTurnCacheSavings does not double-record
    const ledgerPath = path.join(tmpDir, '.claude', 'cache', 'horizon_ledger.jsonl');
    const r1 = recordTurnCacheSavings(
      { sessionId: 'sess-dedupe', turnId: 'main-turn-1', model: 'claude-opus-5-5', cacheReadTokens: 40_000 },
      { ledgerPath }
    );
    const r2 = recordTurnCacheSavings(
      { sessionId: 'sess-dedupe', turnId: 'main-turn-1', model: 'claude-opus-5-5', cacheReadTokens: 40_000 },
      { ledgerPath }
    );
    assert.equal(r1.recorded, true);
    assert.equal(r2.recorded, false);
    assert.equal(r2.deduplicated, true);

    const handlers = {};
    register((name, fn) => {
      handlers[name] = fn;
    });
    const store = new Map();
    const ctx = {
      store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
      ui: { invalidate: () => {}, open: () => {} },
      clock: { every: () => () => {} }
    };
    await handlers['turn.complete'](
      {
        turnId: 'dup-t99',
        cwd: tmpDir,
        headless: true,
        usage: { input_tokens: 1000, output_tokens: 100 }
      },
      ctx
    );
    await handlers['turn.complete'](
      {
        turnId: 'dup-t99',
        cwd: tmpDir,
        headless: true,
        usage: { input_tokens: 1000, output_tokens: 100 }
      },
      ctx
    );
    assert.equal(store.get('ah_session_telemetry').turnsCompleted, 1);

    // 3. Explicit ttlSeconds: 0 or expired expiresAt MUST render COLD (never WARM | 00:00 (0s))
    const zeroTtlState = {
      modelId: 'claude-opus-5-5',
      contextWindow: { totalInputTokens: 60_000, cachedTokens: 55_000, cacheReadTokens: 55_000 },
      promptCache: { warm: true, ttlTier: '5m', ttlSeconds: 0 }
    };
    const zeroBand = renderAbovePromptBand(zeroTtlState, { includeDiskLedger: false });
    const zeroPane = renderSimpleViewPane(zeroTtlState, { includeDiskLedger: false });
    assert.equal(zeroBand.metrics.cacheWarm, false);
    assert.equal(zeroBand.metrics.remainingSeconds, 0);
    assert.doesNotMatch(zeroBand.plainLine, /HOLD WARM PREFIX/);
    assert.match(zeroBand.plainLine, /TTL COLD · \[COACH · COLD PREFIX\]/);
    assert.match(zeroPane.boxes[1].text, /State: COLD/);
    assert.doesNotMatch(zeroPane.boxes[1].text, /State: WARM.*00:00/);

    const nowMs = 1_760_000_100_000;
    const expiredState = {
      modelId: 'claude-opus-5-5',
      contextWindow: { totalInputTokens: 60_000, cachedTokens: 55_000, cacheReadTokens: 55_000 },
      promptCache: { warm: true, ttlTier: '5m', expiresAt: nowMs - 5_000 }
    };
    const expiredMetrics = deriveSurfaceMetrics(expiredState, { nowMs, includeDiskLedger: false });
    assert.equal(expiredMetrics.cacheWarm, false);
    assert.equal(expiredMetrics.remainingSeconds, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. ISS-030: Redact vcs.repository.url.full Credentials & Benchmark Runner
// ============================================================================

test('ISS-030: otelExporter strips URL credentials/query tokens and scripts/bench_hooks.mjs benchmarks Tier-1 & Tier-2', async () => {
  assert.equal(
    sanitizeRepositoryUrl('https://user:ghp_secretToken123@github.com/org/repo.git?token=abc#main'),
    'https://github.com/org/repo.git'
  );
  assert.equal(
    sanitizeRepositoryUrl('https://ghp_onlyToken@github.com/org/repo.git'),
    'https://github.com/org/repo.git'
  );
  assert.equal(
    sanitizeRepositoryUrl('git@github.com:org/repo.git'),
    'git@github.com:org/repo.git'
  );

  const tmpDir = makeTempDir('ah-iss030-');
  try {
    const otelFilePath = path.join(tmpDir, '.claude', 'cache', 'otel_metrics.jsonl');
    const state = createInitialTelemetryState('sess-otel', 'claude-sonnet-5-5');
    const exported = exportOtelTelemetry(state, {
      enabled: true,
      cwd: tmpDir,
      otelFilePath,
      vcs: {
        repositoryUrl: 'https://frank:ghp_TOP_SECRET_PAT@github.com/acme/private-repo.git?key=secret',
        branch: 'main',
        revision: 'deadbeef'
      }
    });
    assert.equal(exported.exported, true);
    const rawJsonl = fs.readFileSync(otelFilePath, 'utf8');
    assert.doesNotMatch(rawJsonl, /ghp_TOP_SECRET_PAT|frank:|key=secret/);
    assert.match(rawJsonl, /https:\/\/github\.com\/acme\/private-repo\.git/);

    const bench = await runHookLatencyBenchmark({
      tier1Iterations: 40,
      tier1Warmup: 10,
      tier2Iterations: 2
    });
    assert.equal(bench.tier1ModToolCall.count, 40);
    assert.ok(bench.tier1ModToolCall.p50Ms < 5.0);
    assert.equal(bench.tier2CliPreToolUse.count, 2);
    assert.ok(bench.tier2CliPreToolUse.p50Ms > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
