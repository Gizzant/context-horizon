/**
 * @file test/phase2_cache_physics.test.mjs
 * Phase 2 Exit Gate Tests:
 * 1. Unified Anthropic Model Catalog & Haiku 5.5 100k 5x Cliff
 * 2. Dual-Source Telemetry Engine, Exact USD Cache ROI & Atomic Bridge
 * 3. CacheGravityRouter (C* = 6,522 & 4,615), 3 Flight Modes, Cooldown & PostCompactMutationQueue
 * 4. 5-Minute TTL Cliff Watchdog, T-10s StateBaton Snapshot & 3.1% 1h-Tier Pause Distribution
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import '../../src/utils/nodeIo.mjs';

import {
  normalizeModelId,
  loadModelCatalog,
  resolveEffectiveRates,
  calculateTurnCostUSD
} from '../../src/core-isomorphic/config/catalogLoader.mjs';

import {
  computeCacheRoi,
  createInitialTelemetryState,
  ingestModTurnEvent,
  ingestStatusLinePayload,
  writeLiveStateSnapshot,
  readLiveStateSnapshot
} from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';

import { exportOtelTelemetry } from '../../src/core-isomorphic/telemetry/otelExporter.mjs';

import {
  FLIGHT_MODES,
  computeBreakEvenCachedTokens,
  PostCompactMutationQueue,
  HysteresisLock,
  CacheGravityRouter
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';

import {
  TtlWatchdog,
  evaluatePauseDistribution,
  formatRemainingTtl
} from '../../src/core-isomorphic/coach/ttlWatchdog.mjs';

test('1. Anthropic Model Catalog: rate cards, read discounts, and customCeilings.json override', () => {
  const catalog = loadModelCatalog();
  assert.equal(catalog.defaultModel, 'claude-sonnet-5-5');

  // Verify Fable 5.2 (0.025x read discount)
  const fable52 = resolveEffectiveRates('claude-fable-5-2', 50_000);
  assert.equal(fable52.contextCeiling, 1_000_000);
  assert.equal(fable52.inputPer1M, 8.0);
  assert.equal(fable52.outputPer1M, 40.0);
  assert.equal(fable52.write5mPer1M, 10.0);
  assert.equal(fable52.write1hPer1M, 16.0);
  assert.equal(fable52.readPer1M, 0.2);
  assert.equal(fable52.multipliers.read, 0.025);

  // Verify Fable 5.1 (0.025x read discount)
  const fable51 = resolveEffectiveRates('claude-fable-5-1', 50_000);
  assert.equal(fable51.inputPer1M, 10.0);
  assert.equal(fable51.outputPer1M, 50.0);
  assert.equal(fable51.write5mPer1M, 12.5);
  assert.equal(fable51.write1hPer1M, 20.0);
  assert.equal(fable51.readPer1M, 0.25);

  // Verify Opus 5.5 (0.05x read discount)
  const opus55 = resolveEffectiveRates('claude-opus-5-5-20261022', 80_000);
  assert.equal(opus55.modelId, 'claude-opus-5-5');
  assert.equal(opus55.inputPer1M, 4.0);
  assert.equal(opus55.outputPer1M, 20.0);
  assert.equal(opus55.write5mPer1M, 5.0);
  assert.equal(opus55.write1hPer1M, 8.0);
  assert.equal(opus55.readPer1M, 0.2);
  assert.equal(opus55.multipliers.read, 0.05);

  // Verify Sonnet 5.5 (0.05x read discount)
  const sonnet55 = resolveEffectiveRates('claude-sonnet-5-5', 80_000);
  assert.equal(sonnet55.inputPer1M, 2.0);
  assert.equal(sonnet55.outputPer1M, 10.0);
  assert.equal(sonnet55.write5mPer1M, 2.5);
  assert.equal(sonnet55.write1hPer1M, 4.0);
  assert.equal(sonnet55.readPer1M, 0.1);

  // Verify customCeilings.json override from disk
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ceilings-'));
  const customCeilingsPath = path.join(tmpDir, 'customCeilings.json');
  fs.writeFileSync(
    customCeilingsPath,
    JSON.stringify({
      models: {
        'claude-opus-4-6': { contextCeiling: 1_000_000, operationalSoftCeiling: 250_000 }
      }
    }),
    'utf-8'
  );

  const opus46Overridden = resolveEffectiveRates('claude-opus-4-6', 50_000, {
    customCeilingsPath
  });
  assert.equal(opus46Overridden.contextCeiling, 1_000_000);
  assert.equal(opus46Overridden.operationalSoftCeiling, 250_000);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('2. Claude Haiku 5.5 100k 5x Price Cliff across all token categories', () => {
  // At exactly 100,000 tokens -> base tier (no cliff)
  const belowCliff = resolveEffectiveRates('claude-haiku-5-5', 100_000);
  assert.equal(belowCliff.cliffTriggered, false);
  assert.equal(belowCliff.preCliffWarningTriggered, true); // >= 90,000 pre-cliff warning
  assert.equal(belowCliff.cliffMultiplier, 1.0);
  assert.equal(belowCliff.inputPer1M, 0.1);
  assert.equal(belowCliff.outputPer1M, 0.5);
  assert.equal(belowCliff.write5mPer1M, 0.125);
  assert.equal(belowCliff.write1hPer1M, 0.2);
  assert.equal(belowCliff.readPer1M, 0.01);

  // At 100,001 tokens -> 5x cliff triggered across all token categories
  const aboveCliff = resolveEffectiveRates('claude-haiku-5-5', 100_001);
  assert.equal(aboveCliff.cliffTriggered, true);
  assert.equal(aboveCliff.cliffMultiplier, 5.0);
  assert.equal(aboveCliff.inputPer1M, 0.5);
  assert.equal(aboveCliff.outputPer1M, 2.5);
  assert.equal(aboveCliff.write5mPer1M, 0.625);
  assert.equal(aboveCliff.write1hPer1M, 1.0);
  assert.equal(aboveCliff.readPer1M, 0.05);

  // Turn cost comparison at 80k vs 120k prompt tokens
  const turn80k = calculateTurnCostUSD({
    model: 'claude-haiku-5-5',
    inputTokens: 10_000,
    cacheReadTokens: 70_000,
    outputTokens: 2_000
  });
  assert.equal(turn80k.cliffTriggered, false);
  // 10k * $0.10/1M ($0.001) + 70k * $0.01/1M ($0.0007) + 2k * $0.50/1M ($0.001) = $0.0027
  assert.equal(turn80k.costsUSD.totalActualSpendUSD, 0.0027);

  const turn120k = calculateTurnCostUSD({
    model: 'claude-haiku-5-5',
    inputTokens: 10_000,
    cacheReadTokens: 110_000,
    outputTokens: 2_000
  });
  assert.equal(turn120k.cliffTriggered, true);
  // 10k * $0.50/1M ($0.005) + 110k * $0.05/1M ($0.0055) + 2k * $2.50/1M ($0.005) = $0.0155
  assert.equal(turn120k.costsUSD.totalActualSpendUSD, 0.0155);
});

test('3. Exact USD Cache ROI math: break-even ratios (0.263 for 5m, 1.053 for 1h) and Negative ROI detection', () => {
  // 1. 5m write on Opus 5.5 with zero cache reads -> Negative Cache ROI
  // 100k 5m write costs $0.50; uncached equivalent costs $0.40 -> Spend ($0.50) > Uncached ($0.40)
  const coldWriteOnly = computeCacheRoi({
    model: 'claude-opus-5-5',
    cacheWrite5mTokens: 100_000,
    cacheReadTokens: 0,
    cacheTtlTier: '5m'
  });
  assert.equal(coldWriteOnly.breakEvenReadsPerWrite, 0.263);
  assert.equal(coldWriteOnly.actualCacheSpendUSD, 0.5);
  assert.equal(coldWriteOnly.uncachedEquivalentUSD, 0.4);
  assert.equal(coldWriteOnly.negativeCacheRoi, true);
  assert.equal(coldWriteOnly.netCacheSavingsUSD, -0.1);

  // 2. 5m write on Opus 5.5 with 30,000 read tokens (reads/write = 0.30 > 0.263) -> Positive Cache ROI
  // Actual cache spend = 100k * $5/1M ($0.50) + 30k * $0.20/1M ($0.006) = $0.506
  // Uncached equivalent = 130k * $4/1M = $0.520 -> Spend ($0.506) < Uncached ($0.520)
  const warmReadPositive = computeCacheRoi({
    model: 'claude-opus-5-5',
    cacheWrite5mTokens: 100_000,
    cacheReadTokens: 30_000,
    cacheTtlTier: '5m'
  });
  assert.equal(warmReadPositive.negativeCacheRoi, false);
  assert.equal(warmReadPositive.actualCacheSpendUSD, 0.506);
  assert.equal(warmReadPositive.uncachedEquivalentUSD, 0.52);
  assert.equal(warmReadPositive.netCacheSavingsUSD, 0.014);

  // 3. 1h write on Sonnet 5.5 -> break-even ratio is (2.0 - 1) / (1 - 0.05) = 1.053
  const oneHourUnderRead = computeCacheRoi({
    model: 'claude-sonnet-5-5',
    cacheWrite1hTokens: 100_000,
    cacheReadTokens: 100_000, // ratio 1.0 < 1.053
    cacheTtlTier: '1h'
  });
  assert.equal(oneHourUnderRead.breakEvenReadsPerWrite, 1.053);
  assert.equal(oneHourUnderRead.negativeCacheRoi, true);

  const oneHourOverRead = computeCacheRoi({
    model: 'claude-sonnet-5-5',
    cacheWrite1hTokens: 100_000,
    cacheReadTokens: 110_000, // ratio 1.1 > 1.053
    cacheTtlTier: '1h'
  });
  assert.equal(oneHourOverRead.negativeCacheRoi, false);
});

test('4. Dual-Source Telemetry Engine: Mod turn.step/turn.complete, subagent attribution, statusLine & atomic bridge', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-telemetry-'));

  let state = createInitialTelemetryState('sess-42', 'claude-opus-5-5');

  // Step 1: Mod turn.step cold cache write of 60k tokens
  state = ingestModTurnEvent(
    state,
    {
      type: 'turn.step',
      sessionId: 'sess-42',
      model: 'claude-opus-5-5',
      result: {
        usage: {
          input_tokens: 2_000,
          cache_creation_input_tokens: 60_000,
          cache_read_input_tokens: 0,
          output_tokens: 1_000,
          thinking_tokens: 500
        }
      }
    },
    { nowMs: 1_700_000_000_000 }
  );

  assert.equal(state.steps, 1);
  assert.equal(state.contextWindow.totalInputTokens, 62_000);
  assert.equal(state.contextWindow.cachedTokens, 60_000);
  assert.equal(state.promptCache.warm, true);
  assert.equal(state.cacheRoi.negativeCacheRoi, true); // Only written, not read yet

  // Step 2: Mod turn.complete with warm cache read of 60k tokens
  state = ingestModTurnEvent(
    state,
    {
      type: 'turn.complete',
      sessionId: 'sess-42',
      model: 'claude-opus-5-5',
      result: {
        usage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 60_000,
          output_tokens: 1_200
        }
      }
    },
    { nowMs: 1_700_000_030_000 }
  );

  assert.equal(state.turnsCompleted, 1);
  assert.equal(state.cacheRoi.negativeCacheRoi, false); // 60k read on 62k written -> positive ROI!
  assert.ok(state.cumulative.netCacheSavingsUSD > 0.15);

  // Step 3: Subagent attribution (e.agentId)
  state = ingestModTurnEvent(
    state,
    {
      type: 'turn.step',
      sessionId: 'sess-42',
      agentId: 'subagent-explore-1',
      model: 'claude-haiku-5-5',
      result: {
        usage: {
          input_tokens: 1_500,
          output_tokens: 300
        }
      }
    },
    { nowMs: 1_700_000_040_000 }
  );

  assert.ok(state.subagents['subagent-explore-1']);
  assert.equal(state.subagents['subagent-explore-1'].turns, 1);
  assert.equal(state.subagents['subagent-explore-1'].totalTokens, 1_800);
  // Main context window remains untouched by isolated subagent step
  assert.equal(state.contextWindow.totalInputTokens, 63_000);

  // Step 4: Ingest statusLine JSON payload with rate limits and prompt_cache metadata
  state = ingestStatusLinePayload(
    state,
    {
      session_id: 'sess-42',
      model: { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
      context_window: {
        total_input_tokens: 65_000,
        context_window_size: 1_000_000,
        system_tokens: 8_000,
        mcp_tokens: 4_000,
        distractor_tokens: 6_000
      },
      prompt_cache: {
        warm: true,
        ttl: '5m',
        expires_at: 1_700_000_300_000,
        last_miss_cause: null
      },
      rate_limits: {
        five_hour: { used: 45, limit: 300, remaining_pct: 85 },
        spend_limit: { spent_usd: 12.4, limit_usd: 100.0, remaining_usd: 87.6 }
      }
    },
    { nowMs: 1_700_000_050_000 }
  );

  assert.equal(state.contextWindow.systemAndMcpTokens, 12_000);
  assert.equal(state.contextWindow.distractorTokens, 6_000);
  assert.equal(state.rateLimits.fiveHour.remaining_pct, 85);
  assert.equal(state.rateLimits.spendLimit.remaining_usd, 87.6);

  // Step 5: Atomic bridge write and read round-trip
  const writeRes = writeLiveStateSnapshot('sess-42', state, { cwd: tmpDir });
  assert.equal(writeRes.ok, true);
  assert.ok(fs.existsSync(writeRes.sessionPath));

  const loaded = readLiveStateSnapshot('sess-42', { cwd: tmpDir });
  assert.equal(loaded.sessionId, 'sess-42');
  assert.equal(loaded.contextWindow.totalInputTokens, 65_000);

  // Step 6: Optional OpenTelemetry exporter
  const capturedOtel = [];
  const otelRes = exportOtelTelemetry(state, {
    enabled: true,
    vcs: { branch: 'main', revision: 'abc1234' },
    sink: (records) => capturedOtel.push(...records)
  });
  assert.equal(otelRes.exported, true);
  assert.equal(capturedOtel.length, 5); // 4 token types + 1 cost record
  assert.equal(capturedOtel[0].metricName, 'claude_code.token.usage');
  assert.equal(capturedOtel[4].metricName, 'claude_code.cost.usage');
  assert.equal(capturedOtel[4].attributes['vcs.ref.head.name'], 'main');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('5. CacheGravityRouter: algebraic break-even C* = 6,522 (Opus 5.5 -> Sonnet 5.5) and C* = 4,615 (Opus 4.6 -> Sonnet 4.6)', () => {
  // Verify Opus 5.5 -> Sonnet 5.5 break-even C* = 6,522 tokens at O = 1,500
  const opus55ToSonnet55 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    expectedOutputTokens: 1500,
    cachedTokens: 50_000,
    cacheWarm: true
  });
  assert.equal(opus55ToSonnet55.breakEvenTokens, 6522);
  assert.equal(opus55ToSonnet55.shouldHoldModel, true);
  assert.ok(opus55ToSonnet55.coldWritePenaltyUSD > 0);

  // Verify Opus 4.6 -> Sonnet 4.6 break-even C* = 4,615 tokens at O = 1,500
  const opus46ToSonnet46 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    expectedOutputTokens: 1500,
    cachedTokens: 50_000,
    cacheWarm: true
  });
  assert.equal(opus46ToSonnet46.breakEvenTokens, 4615);
  assert.equal(opus46ToSonnet46.shouldHoldModel, true);

  // Verify PreModelSwitch (DET-08) hold, subagent delegation, and 3-turn cooldown in CacheGravityRouter
  const router = new CacheGravityRouter({ mode: FLIGHT_MODES.COACH, cooldownTurns: 3 });

  // Above C* (80k warm cache on Opus 5.5) in COACH mode -> non-blocking advisory warning
  const coachSwitch = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 80_000,
    cacheWarm: true,
    currentTurn: 1
  });
  assert.equal(coachSwitch.detectorId, 'DET-08');
  assert.equal(coachSwitch.blocked, false);
  assert.equal(coachSwitch.advisory, true);
  assert.equal(coachSwitch.decision, 'allow');
  assert.equal(coachSwitch.recommendedModel, 'claude-opus-5-5');
  assert.equal(coachSwitch.subagentDelegation?.agentType, 'Explore');
  assert.equal(coachSwitch.subagentDelegation?.model, 'claude-haiku-5-5');

  // Above C* in AUTO_PILOT mode -> actively blocks downgrade to Sonnet 5.5
  router.setMode(FLIGHT_MODES.AUTO_PILOT);
  const blockedSwitch = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 80_000,
    cacheWarm: true,
    currentTurn: 1
  });
  assert.equal(blockedSwitch.detectorId, 'DET-08');
  assert.equal(blockedSwitch.blocked, true);
  assert.equal(blockedSwitch.decision, 'deny');
  assert.equal(blockedSwitch.recommendedModel, 'claude-opus-5-5');
  router.setMode(FLIGHT_MODES.COACH);

  // Below C* (3,000 tokens < 6,522) -> allowed, and triggers 3-turn advisory cooldown
  const allowedTurn2 = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 3_000,
    cacheWarm: true,
    currentTurn: 2
  });
  assert.equal(allowedTurn2.blocked, false);
  assert.equal(allowedTurn2.cooldownSuppressed, false);

  const allowedTurn3 = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 3_000,
    cacheWarm: true,
    currentTurn: 3
  });
  assert.equal(allowedTurn3.cooldownSuppressed, true); // Turn 3 is within 3-turn cooldown of Turn 2

  const allowedTurn5 = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 3_000,
    cacheWarm: true,
    currentTurn: 5
  });
  assert.equal(allowedTurn5.cooldownSuppressed, false); // Turn 5 - Turn 2 >= 3 -> cooldown expired

  // Verify PostCompactMutationQueue (DET-09) — positive warm mutation + benign negative checks
  const benignWarmOrdinary = router.interceptTopLevelMutation({
    filePath: 'src/app.js',
    currentModel: 'claude-opus-5-5',
    cachedTokens: 100_000,
    cacheWarm: true
  });
  assert.equal(benignWarmOrdinary.triggered, false);
  assert.equal(benignWarmOrdinary.queued, false);

  const benignColdClaudeMd = router.interceptTopLevelMutation({
    filePath: 'CLAUDE.md',
    currentModel: 'claude-opus-5-5',
    cachedTokens: 100_000,
    cacheWarm: false,
    ttlRemainingSeconds: 0
  });
  assert.equal(benignColdClaudeMd.triggered, false);
  assert.equal(benignColdClaudeMd.queued, false);

  const interceptRes = router.interceptTopLevelMutation({
    type: 'effort',
    value: 'low',
    currentModel: 'claude-opus-5-5',
    cachedTokens: 100_000,
    cacheWarm: true
  });
  assert.equal(interceptRes.detectorId, 'DET-09');
  assert.equal(interceptRes.triggered, true);
  assert.equal(interceptRes.queued, true);
  assert.equal(interceptRes.decision, 'defer');
  assert.equal(interceptRes.avoidedRewritePenaltyUSD, 0.48); // 100k * ($5.00 - $0.20) / 1M = $0.48
  assert.equal(router.mutationQueue.size(), 1);

  const flushed = router.mutationQueue.flush();
  assert.equal(flushed.flushedCount, 1);
  assert.equal(flushed.appliedMutations[0].value, 'low');
  assert.equal(flushed.totalAvoidedPenaltyUSD, 0.48);
  assert.equal(router.mutationQueue.size(), 0);

  // Verify HysteresisLock
  const lock = new HysteresisLock();
  lock.engage({ model: 'claude-opus-5-5', effort: 'high', reason: 'DET-04 retry loop', turn: 4 });
  assert.equal(lock.getStatus().locked, true);
  lock.completeActiveTask();
  assert.equal(lock.getStatus().locked, false);
});

test('6. 5-Minute TTL Cliff Watchdog: <= 45s amber alert, T-10s zero-token StateBaton snapshot, and >= 3.1% 1h-tier pause advisor', () => {
  assert.equal(formatRemainingTtl(252), '4m12s');
  assert.equal(formatRemainingTtl(42), '42s');
  assert.equal(formatRemainingTtl(0), '0s');

  const snapshots = [];
  const watchdog = new TtlWatchdog({
    mode: FLIGHT_MODES.COACH,
    onSnapshot: (baton) => snapshots.push(baton)
  });

  watchdog.recordFileChanged('src/core-isomorphic/coach/cacheGravityRouter.mjs', 1_700_000_000_000);

  // 1. At 120s remaining -> no alert
  const tick120 = watchdog.evaluateTick({
    cacheWarm: true,
    cachedTokens: 80_000,
    remainingSeconds: 120,
    modelId: 'claude-opus-5-5'
  });
  assert.equal(tick120.amberAlertActive, false);
  assert.equal(tick120.alertLevel, 'NONE');

  // 2. At 40s remaining in COACH mode -> Amber countdown alert + 1-click actions
  const tick40Coach = watchdog.evaluateTick({
    cacheWarm: true,
    cachedTokens: 80_000,
    remainingSeconds: 40,
    modelId: 'claude-opus-5-5'
  });
  assert.equal(tick40Coach.amberAlertActive, true);
  assert.equal(tick40Coach.alertLevel, 'AMBER');
  assert.equal(tick40Coach.preSnapshotTriggered, false);
  assert.deepEqual(tick40Coach.availableActions, ['KEEP_ALIVE_PROMPT', 'SNAPSHOT_STATE_BATON']);
  assert.equal(tick40Coach.expiryPenaltyUSD, 0.384); // 80k * ($5.00 - $0.20) / 1M = $0.384

  // 3. At T-10s in AUTO_PILOT mode -> automatic zero-token StateBaton pre-snapshot
  watchdog.setMode(FLIGHT_MODES.AUTO_PILOT);
  const nowMs = 1_700_000_290_000;
  const expiresAtMs = 1_700_000_300_000; // 10 seconds remaining
  const tick10Auto = watchdog.evaluateTick({
    cacheWarm: true,
    cachedTokens: 80_000,
    expiresAt: expiresAtMs,
    nowMs,
    modelId: 'claude-opus-5-5',
    activeGoal: 'Complete Phase 2 TTL Watchdog'
  });
  assert.equal(tick10Auto.amberAlertActive, true);
  assert.equal(tick10Auto.alertLevel, 'CRITICAL_SNAPSHOT');
  assert.equal(tick10Auto.preSnapshotTriggered, true);
  assert.deepEqual(tick10Auto.availableActions, [
    'AUTO_SNAPSHOT_STATE_BATON',
    'LOCAL_CLI_KEEP_ALIVE'
  ]);
  assert.ok(tick10Auto.stateBatonSnapshot);
  assert.equal(tick10Auto.stateBatonSnapshot.trigger, 'TTL_T_MINUS_10S_PRE_SNAPSHOT');
  assert.deepEqual(tick10Auto.stateBatonSnapshot.workingSetFiles, [
    'src/core-isomorphic/coach/cacheGravityRouter.mjs'
  ]);
  assert.equal(snapshots.length, 1);

  // Subsequent tick at T-9s in same cycle does not duplicate snapshot
  const tick9Auto = watchdog.evaluateTick({
    cacheWarm: true,
    cachedTokens: 80_000,
    expiresAt: expiresAtMs,
    nowMs: nowMs + 1000,
    modelId: 'claude-opus-5-5'
  });
  assert.equal(tick9Auto.preSnapshotTriggered, false);
  assert.equal(snapshots.length, 1);

  // 4. Inter-turn pause distribution: 1 out of 30 turns (3.33% >= 3.1%) in 5m-to-60m window -> recommend 1h tier
  const pauses29Short1Long = [...Array(29).fill(45), 420]; // 29 pauses of 45s, 1 pause of 7 minutes (420s)
  const pauseEval = evaluatePauseDistribution(pauses29Short1Long);
  assert.equal(pauseEval.totalIntervals, 30);
  assert.equal(pauseEval.fiveToSixtyMinCount, 1);
  assert.equal(pauseEval.fiveToSixtyMinPct, 3.33);
  assert.equal(pauseEval.recommend1hTierUpgrade, true);
  assert.ok(pauseEval.advisoryMessage.includes('1h'));

  // 1 out of 40 turns (2.5% < 3.1%) -> do not recommend 1h tier
  const pauses39Short1Long = [...Array(39).fill(45), 420];
  const pauseEvalBelow = evaluatePauseDistribution(pauses39Short1Long);
  assert.equal(pauseEvalBelow.recommend1hTierUpgrade, false);
});
