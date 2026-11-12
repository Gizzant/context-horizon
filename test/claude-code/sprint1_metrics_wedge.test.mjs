import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialPrefixRetention,
  applyPrefixRetentionRequest,
  applyThinkingDriftEvent,
  createInitialThinkingDrift,
  evaluateThinkingDriftLoop,
  formatRetentionCompact,
  formatDriftLabel,
  THINKING_DRIFT_DETECTOR_ID,
  THINKING_DRIFT_GA_DETECTOR_ID
} from '../../src/core-isomorphic/telemetry/sprintMetrics.mjs';
import { createInitialTelemetryState, ingestModTurnEvent } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { renderSimpleViewPane, renderSpinnerSuffix, renderStatusLine, renderAbovePromptBand } from '../../src/core-isomorphic/ui/modViews.mjs';
import { normalizeDetectorId, resolveDetectorSlug, ADVISORY_DETECTOR_IDS } from '../../src/core-isomorphic/config/horizonConfig.mjs';

const T0 = 1_794_000_000_000;
const SONNET = { inputPer1M: 2.0, readPer1M: 0.1 };

test('Sprint 1.1 (CC): retention is null until a second measured request in TTL', () => {
  let r = createInitialPrefixRetention();
  assert.equal(r.retentionIndexPct, null);
  assert.equal(formatRetentionCompact(r), 'Ret —');
  r = applyPrefixRetentionRequest(r, { streamKey: 'main', modelId: 'claude-sonnet-5-5', uncachedInputTokens: 80000, nowMs: T0, ...SONNET });
  assert.equal(r.measured, false);
  r = applyPrefixRetentionRequest(r, { streamKey: 'main', modelId: 'claude-sonnet-5-5', uncachedInputTokens: 1000, cacheReadTokens: 80000, nowMs: T0 + 20_000, ...SONNET });
  assert.equal(r.retentionIndexPct, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.retainedDiscountSavingsUSD, 0.152); // 80k * $1.90/M
});

test('Sprint 1.1 (CC): model switch bust attribution + TTL expiry exclusion', () => {
  let r = createInitialPrefixRetention();
  const base = { streamKey: 'main', ...SONNET };
  r = applyPrefixRetentionRequest(r, { ...base, modelId: 'claude-sonnet-5-5', cacheWriteTokens: 50000, nowMs: T0 });
  r = applyPrefixRetentionRequest(r, { ...base, modelId: 'claude-opus-5-5', uncachedInputTokens: 50000, nowMs: T0 + 10_000 });
  assert.equal(r.bustCount, 1);
  assert.deepEqual(r.bustCauses, { model_switch: 1 });
  assert.equal(r.retentionIndexPct, 0);
  r = applyPrefixRetentionRequest(r, { ...base, modelId: 'claude-opus-5-5', uncachedInputTokens: 50000, nowMs: T0 + 900_000 });
  assert.equal(r.ttlExpiredTurns, 1);
  assert.equal(r.measuredTurns, 1);
});

test('Sprint 1.2 (CC): DET-21 drift tracker flags in-flight and consecutive scratchpad loops', () => {
  assert.equal(THINKING_DRIFT_DETECTOR_ID, 'DET-30');
  assert.equal(THINKING_DRIFT_GA_DETECTOR_ID, 'DET-30');
  let d = createInitialThinkingDrift();
  d = applyThinkingDriftEvent(d, { eventType: 'turn.step', thinkingTokens: 6000, outputTokens: 200, nowMs: T0 + 1500, turnStartedAtMs: T0 });
  assert.equal(d.lastTtftMs, 1500);
  assert.equal(d.loop.severity, 'warn', 'in-flight loop detected before turn.complete');
  d = applyThinkingDriftEvent(d, { eventType: 'turn.complete', nowMs: T0 + 3000 });
  d = applyThinkingDriftEvent(d, { eventType: 'turn.step', thinkingTokens: 7000, outputTokens: 300, nowMs: T0 + 62_000, turnStartedAtMs: T0 + 60_000 });
  d = applyThinkingDriftEvent(d, { eventType: 'turn.complete', nowMs: T0 + 64_000 });
  assert.equal(d.loop.severity, 'critical');
  assert.equal(d.driftState, 'loop_detected');
  assert.match(formatDriftLabel(d), /^!LOOP 23\.33x · TTFT 2\.0s$/);

  const edited = evaluateThinkingDriftLoop([{ thinkingTokens: 7000, visibleOutputTokens: 300, mutatingCalls: 1 }]);
  assert.equal(edited.triggered, false);
});

test('Sprint 1 (CC): ingestModTurnEvent populates prefixRetention + thinkingDrift and skips streaming re-sends', () => {
  let s = createInitialTelemetryState('s1', 'claude-sonnet-5-5');
  s = ingestModTurnEvent(s, { type: 'turn.step', turnId: 't1', messageId: 'm1', usage: { input_tokens: 60000, output_tokens: 400 } }, { nowMs: T0 });
  s = ingestModTurnEvent(s, { type: 'turn.complete', turnId: 't1', messageId: 'm1', usage: { input_tokens: 60000, output_tokens: 400 } }, { nowMs: T0 + 2000 });
  s = ingestModTurnEvent(s, { type: 'turn.step', turnId: 't2', messageId: 'm2', usage: { input_tokens: 800, cache_read_input_tokens: 60000, output_tokens: 300 } }, { nowMs: T0 + 30_000 });
  // streaming re-send of the same message must not double-score retention
  s = ingestModTurnEvent(s, { type: 'turn.step', turnId: 't2', messageId: 'm2', usage: { input_tokens: 800, cache_read_input_tokens: 60000, output_tokens: 600 } }, { nowMs: T0 + 31_000 });
  assert.equal(s.prefixRetention.measuredTurns, 1);
  assert.equal(s.prefixRetention.retentionIndexPct, 100);
  assert.ok(s.thinkingDrift, 'thinkingDrift state present');
  assert.equal(s.thinkingDrift.measured, false, 'no reported thinking tokens => unmeasured, never fabricated');
});

test('Sprint 1 (CC): surfaces render retention + loop only when measured/triggered', () => {
  const base = createInitialTelemetryState('s1', 'claude-sonnet-5-5');
  assert.doesNotMatch(renderSpinnerSuffix(base).suffix, /Ret /);
  assert.match(renderSimpleViewPane(base).boxes[1].text, /Prefix Retention: Retain — /);

  const loopState = {
    ...base,
    prefixRetention: { ...createInitialPrefixRetention(), measured: true, retentionIndexPct: 94, grade: 'A', retainedDiscountSavingsUSD: 1.2 },
    thinkingDrift: {
      ...createInitialThinkingDrift(),
      measured: true,
      lastDriftRatio: 16.4,
      lastTtftMs: 1200,
      driftState: 'loop_detected',
      loop: { detectorId: 'DET-21', triggered: true, severity: 'critical', message: 'DET-21 Scratchpad Loop: 16.4x' }
    }
  };
  assert.match(renderSpinnerSuffix(loopState).suffix, /Ret 94% · !LOOP 16\.4x$/);
  assert.match(renderAbovePromptBand(loopState, { maxCols: 160 }).plainLine, /THINK LOOP 16\.4x/);
  assert.match(renderSimpleViewPane(loopState, { maxCols: 120 }).boxes[2].text, /DET-21 Scratchpad Loop/);
  const status = renderStatusLine(loopState, { columns: 144, ansi: false });
  assert.match(status.plainLine, /Ret 94%/);
  assert.match(status.plainLine, /!LOOP 16\.4x/);
  assert.ok(status.visibleLength <= 144);
  const compact = renderStatusLine(loopState, { columns: 80, ansi: false });
  assert.ok(compact.visibleLength <= 80);
});

test('Sprint 1 (CC): DET-21 is an advisory, configurable detector translating to GA DET-30', () => {
  assert.equal(normalizeDetectorId('DET-21'), 'DET-30');
  assert.equal(normalizeDetectorId('thinking-drift-loop'), 'DET-30');
  assert.equal(resolveDetectorSlug('DET-30'), 'thinking-drift-loop');
});
