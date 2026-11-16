import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  calculateTurnCostUSD,
  isKnownCatalogModel,
  loadModelCatalog,
  normalizeModelId,
  resolveEffectiveRates
} from '../../src/core-isomorphic/config/catalogLoader.mjs';
import {
  CacheGravityRouter,
  computeBreakEvenCachedTokens,
  getEffortMutationCacheCapability
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  computeCompactionHorizonNetSaving,
  evaluateSmartCompactSuggestion,
  evaluateTaskBoundaryTurn
} from '../../src/core-isomorphic/coach/smartCompactAdvisor.mjs';
import {
  computeActiveToolsetHash,
  evaluateResumeToolsetChange
} from '../../src/core-isomorphic/coach/resumeToolsetAuditor.mjs';
import { loadHorizonConfig } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import {
  CircuitBreakerEngine,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { runDoctorDiagnostics } from '../../src/diagnostics/doctorEngine.mjs';
import {
  extractClaudeSelectableModelsFromBinary,
  resolveClaudeBinaryPath
} from '../../src/diagnostics/claudeHookCapabilities.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { runPostModelSwitchHook } from '../../hooks/handlers/post-model-switch.mjs';
import { runConfigChangeHook } from '../../hooks/handlers/config-change.mjs';
import { runCompactLifecycleHook } from '../../hooks/handlers/compact-lifecycle.mjs';
import { runPostToolUseHook } from '../../hooks/handlers/post-tool-use.mjs';
import { runStopGateHook } from '../../hooks/handlers/stop-gate.mjs';

function makeTempDir(prefix = 'ctxtop-r2-suite-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cwd = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    root,
    cwd,
    homeDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function assertWithinPct(actual, expected, pct = 0.15, label = 'value') {
  const rel = Math.abs(actual - expected) / expected;
  assert.ok(
    rel <= pct,
    `${label}: expected ${actual} to be within ${(pct * 100).toFixed(0)}% of ${expected} (diff ${(rel * 100).toFixed(1)}%)`
  );
}

test('Item 1.1: catalog includes all required 5.5/5/fable/4.x models, multipliers, source, and dateRead', () => {
  const catalog = loadModelCatalog();
  const required = [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-2',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6'
  ];
  for (const id of required) {
    assert.equal(isKnownCatalogModel(id), true, `Missing catalog entry for ${id}`);
    const spec = catalog.models[id];
    assert.ok(spec, `Expected spec for ${id}`);
    assert.ok(typeof spec.source === 'string' && spec.source.length > 0, `Missing source for ${id}`);
    assert.equal(spec.dateRead, '2026-11-15', `Missing dateRead for ${id}`);
    assert.equal(Number(spec.ratesPer1M.write5m.toFixed(6)), Number((spec.ratesPer1M.input * 1.25).toFixed(6)));
    assert.equal(Number(spec.ratesPer1M.write1h.toFixed(6)), Number((spec.ratesPer1M.input * 2.0).toFixed(6)));
  }

  assert.equal(resolveEffectiveRates('claude-opus-5-5', 20_000).multipliers.read, 0.05);
  assert.equal(resolveEffectiveRates('claude-sonnet-5-5', 20_000).multipliers.read, 0.05);
  assert.equal(resolveEffectiveRates('claude-fable-5-2', 20_000).multipliers.read, 0.025);
  assert.equal(resolveEffectiveRates('claude-fable-5-1', 20_000).multipliers.read, 0.025);
  assert.equal(resolveEffectiveRates('claude-opus-4-6', 20_000).multipliers.read, 0.1);
  assert.equal(resolveEffectiveRates('claude-sonnet-4-6', 20_000).multipliers.read, 0.1);
});

test('Item 1.2: unknown models return explicit unknownModel state with null USD, zero-$ advisory, and doctor WARN', () => {
  const ws = makeTempDir('ctxtop-unknown-');
  try {
    assert.equal(isKnownCatalogModel('unknown-future-model-x'), false);
    assert.equal(normalizeModelId('unknown-future-model-x'), 'unknown');

    const rates = resolveEffectiveRates('unknown-future-model-x', 50_000);
    assert.equal(rates.unknownModel, true);
    assert.equal(rates.inputPer1M, null);
    assert.equal(rates.readPer1M, null);
    assert.equal(rates.outputPer1M, null);

    const turnCost = calculateTurnCostUSD({
      modelId: 'unknown-future-model-x',
      inputTokens: 10_000,
      cacheReadTokens: 20_000,
      outputTokens: 500
    });
    assert.equal(turnCost.unknownModel, true);
    assert.equal(turnCost.costsUSD.totalActualSpendUSD, null);
    assert.equal(turnCost.costsUSD.netCacheSavingsUSD, null);

    const be = computeBreakEvenCachedTokens({
      currentModel: 'unknown-future-model-x',
      targetModel: 'claude-sonnet-4-6',
      cachedTokens: 80_000,
      cacheWarm: true
    });
    assert.equal(be.unknownModel, true);
    assert.equal(be.shouldHoldModel, false);
    assert.equal(be.coldWritePenaltyUSD, null);
    assert.equal(be.breakEvenTokens, null);
    assert.equal(be.paybackTurns, null);

    const preRes = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        from_model: 'unknown-future-model-x',
        to_model: 'claude-sonnet-4-6',
        cached_tokens: 80_000,
        cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      { cwd: ws.cwd, homeDir: ws.homeDir, persistState: false, recordLedger: false, bypassLicense: true }
    );
    assert.equal(preRes.verdict.decision, 'allow');
    assert.equal(preRes.verdict.blocked, false);
    assert.equal(preRes.verdict.unknownModel, true);
    assert.match(preRes.verdict.reason, /prices are unknown/i);
    assert.ok(!preRes.verdict.reason.includes('$'));

    const doctor = runDoctorDiagnostics({
      cwd: ws.cwd,
      homeDir: ws.homeDir,
      env: { ANTHROPIC_MODEL: 'unknown-future-model-x' }
    });
    const covCheck = (doctor.checks || []).find((c) => c.id === 'model_catalog_coverage');
    assert.ok(covCheck, 'Expected model_catalog_coverage check');
    assert.equal(covCheck.status, 'WARN');
    assert.match(covCheck.detail, /unknown-future-model-x/);
  } finally {
    ws.cleanup();
  }
});

test('Item 1.3: every selectable model exposed by installed Claude Code binary is in catalog', () => {
  const binPath = resolveClaudeBinaryPath();
  if (binPath) {
    const extracted = extractClaudeSelectableModelsFromBinary(binPath);
    assert.equal(extracted.found, true);
    assert.ok(extracted.modelIds.length >= 20, 'Expected full model list extracted from Claude binary');
    const missingModels = extracted.modelIds.filter((id) => !isKnownCatalogModel(id));
    const missingAliases = extracted.aliases.filter((alias) => !isKnownCatalogModel(alias));
    assert.deepEqual(missingModels, []);
    assert.deepEqual(missingAliases, []);
  } else {
    // CI fallback without installed claude binary: verify standard Claude Code aliases & versions
    for (const id of ['best', 'fable', 'haiku', 'mythos', 'opus', 'sonnet', 'claude-3-5-haiku', 'claude-3-7-sonnet']) {
      assert.equal(isKnownCatalogModel(id), true, `Expected fallback selectable model ${id} in catalog`);
    }
  }
});

test('Item 2.1-2.3: per-pair DET-08 economics reproduce L2, 5.5 pair, TH within 15%, with request-first formatting', () => {
  // L2: Opus 4.6 -> Sonnet 4.6 (C = 19,154, O = 150, R = 1, g = 263 -> payback ~10.41 reqs; g=0 -> 11.40)
  const l2 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 19_154,
    expectedOutputTokens: 150,
    requestsPerTurn: 1,
    contextGrowthPerTurn: 263,
    cacheWarm: true
  });
  assertWithinPct(l2.paybackWarmRequests, 10.41, 0.15, 'L2 paybackWarmRequests (g=263)');

  // 5.5 pair: Opus 5.5 -> Sonnet 5.5 (C = 26,100, O = 150, R = 1 -> penalty ~$0.0584, saving ~$0.00425/turn, payback ~13.8-14 turns)
  const pair55 = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 26_100,
    expectedOutputTokens: 150,
    requestsPerTurn: 1,
    cacheWarm: true
  });
  assertWithinPct(pair55.coldWritePenaltyUSD, 0.0584, 0.15, '5.5 coldWritePenaltyUSD');
  assertWithinPct(pair55.perTurnPostSwitchSavingUSD, 0.00425, 0.15, '5.5 perTurnPostSwitchSavingUSD');
  assertWithinPct(pair55.paybackTurns, 13.8, 0.15, '5.5 paybackTurns');

  // TH: Opus 4.6 -> Sonnet 4.6 (C = 13,216, O = 547, R = 5, g = 2538, H_post = 9 -> ~5-7 warm reqs)
  const th = computeBreakEvenCachedTokens({
    currentModel: 'claude-opus-4-6',
    targetModel: 'claude-sonnet-4-6',
    cachedTokens: 13_216,
    expectedOutputTokens: 547,
    requestsPerTurn: 5,
    contextGrowthPerTurn: 2538,
    expectedRemainingTurns: 9,
    cacheWarm: true
  });
  assert.ok(th.paybackWarmRequests >= 4.5 && th.paybackWarmRequests <= 7.0, `Expected TH paybackWarmRequests in 4.5..7.0, got ${th.paybackWarmRequests}`);
  assert.equal(th.shouldHoldModel, false);

  // Message format: payback in warm requests first, turns in parentheses, under-5-turns omits net $ figure
  const router = new CacheGravityRouter({ mode: 'AUTO_PILOT' });
  const holdVerdict = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 60_000,
    expectedOutputTokens: 150,
    requestsPerTurn: 2,
    turnsCompleted: 2,
    expectedRemainingTurns: 3,
    cacheWarm: true
  });
  assert.equal(holdVerdict.blocked, true);
  assert.match(holdVerdict.reason, /post-switch warm requests \(~[\d.]+ turns\)/);

  const allowUnder5 = router.evaluateModelSwitch({
    currentModel: 'claude-opus-5-5',
    targetModel: 'claude-sonnet-5-5',
    cachedTokens: 60_000,
    expectedOutputTokens: 150,
    requestsPerTurn: 5,
    turnsCompleted: 3,
    expectedRemainingTurns: 25,
    cacheWarm: true
  });
  assert.equal(allowUnder5.blocked, false);
  assert.match(allowUnder5.reason, /warm requests \(~[\d.]+ turns\)/);
  assert.match(allowUnder5.notableAllowNote, /<5 observed turns: net USD omitted/);
});

test('Item 3: DET-09 model-aware effort capability table covers all 5 provenance rows', () => {
  // Row 1: Sonnet 4.6 -> Yes (EF1_46 measured)
  assert.equal(getEffortMutationCacheCapability('claude-sonnet-4-6').invalidatesCache, 'yes');
  // Row 2: Opus 4.6 -> Yes (earlier experiment)
  assert.equal(getEffortMutationCacheCapability('claude-opus-4-6').invalidatesCache, 'yes');
  // Row 3: Sonnet 5.5 -> No (n=3 with behaviour change)
  assert.equal(getEffortMutationCacheCapability('claude-sonnet-5-5').invalidatesCache, 'no');
  // Row 4: Opus 5.5 -> No (cache only; behaviour unverified)
  const opus55Cap = getEffortMutationCacheCapability('claude-opus-5-5');
  assert.equal(opus55Cap.invalidatesCache, 'no');
  assert.match(opus55Cap.status, /behaviour unverified/i);
  // Row 5: All others -> Unknown ("unverified for this model")
  const haikuCap = getEffortMutationCacheCapability('claude-haiku-5-5');
  assert.equal(haikuCap.invalidatesCache, 'unknown');
  assert.match(haikuCap.status, /unverified for this model/);

  for (const modelId of ['claude-sonnet-4-6', 'claude-opus-4-6']) {
    const r = new CacheGravityRouter({ mode: 'COACH' }).interceptTopLevelMutation({
      type: 'effort',
      value: 'high',
      currentModel: modelId,
      cachedTokens: 60_000,
      cacheWarm: true
    });
    assert.equal(r.triggered, true);
    assert.equal(r.decision, 'defer');

    const h = runConfigChangeHook(
      { key: 'effortLevel', old_value: 'medium', new_value: 'high', model: modelId, cached_tokens: 60_000, cache_warm: true },
      { persistState: false }
    );
    assert.equal(h.verdict.triggered, true);
  }

  for (const modelId of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    const r = new CacheGravityRouter({ mode: 'COACH' }).interceptTopLevelMutation({
      type: 'effort',
      value: 'high',
      currentModel: modelId,
      cachedTokens: 60_000,
      cacheWarm: true
    });
    assert.equal(r.triggered, false);
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, null);

    const h = runConfigChangeHook(
      { key: 'effortLevel', old_value: 'medium', new_value: 'high', model: modelId, cached_tokens: 60_000, cache_warm: true },
      { persistState: false }
    );
    assert.equal(h.verdict.triggered, false);
    assert.equal(h.stdout, '');
  }

  for (const modelId of ['claude-haiku-5-5', 'claude-fable-5-2', 'claude-sonnet-5']) {
    const r = new CacheGravityRouter({ mode: 'COACH' }).interceptTopLevelMutation({
      type: 'effort',
      value: 'high',
      currentModel: modelId,
      cachedTokens: 60_000,
      cacheWarm: true
    });
    assert.equal(r.triggered, true);
    assert.equal(r.decision, 'defer');
    assert.match(r.reason, /unverified for this model/);

    const h = runConfigChangeHook(
      { key: 'effortLevel', old_value: 'medium', new_value: 'high', model: modelId, cached_tokens: 60_000, cache_warm: true },
      { persistState: false }
    );
    assert.equal(h.verdict.triggered, true);
    assert.match(h.verdict.reason, /unverified for this model/);
  }
});

test('Item 4: pending_downshift recorded on DET-08 hold, surfaced once on SessionStart:compact, allowed on H6 v1/v2 splits, and cleared cleanly', () => {
  const ws = makeTempDir('ctxtop-item4-');
  try {
    const hookOpts = { cwd: ws.cwd, homeDir: ws.homeDir, persistState: true, recordLedger: false, bypassLicense: true };

    // 4.1 DET-08 hold writes pending_downshift
    const held = runPreModelSwitchHook(
      {
        session_id: 'sess-downshift',
        cwd: ws.cwd,
        hook_event_name: 'PreModelSwitch',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        cached_tokens: 90_000,
        expectedOutputTokens: 150,
        expected_remaining_turns: 4,
        cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      hookOpts
    );
    assert.equal(held.verdict.blocked, true);
    assert.equal(held.verdict.pending_downshift.fromModel, 'claude-opus-4-6');
    assert.equal(held.verdict.pending_downshift.toModel, 'claude-sonnet-4-6');
    const snapAfterHold = readBreakerStateSnapshot('sess-downshift', hookOpts);
    assert.equal(snapAfterHold.pending_downshift.toModel, 'claude-sonnet-4-6');

    // 4.2 SessionStart:compact emits one-line systemMessage naming /model <target> and reason, without additionalContext leak, and clears pending_downshift
    const ssCompact = runCompactLifecycleHook(
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess-downshift', cwd: ws.cwd },
      { ...hookOpts, checkCapabilities: false, snapshotTestHashes: false }
    );
    assert.match(ssCompact.stdoutJson.systemMessage, /\/model claude-sonnet-4-6/);
    assert.match(ssCompact.stdoutJson.systemMessage, /warm cache|pre-compact/i);
    assert.equal(ssCompact.stdoutJson.hookSpecificOutput, undefined);

    // Cleared after one suggestion: subsequent PostCompact is silent and emits NO hookSpecificOutput
    const postCompact = runCompactLifecycleHook(
      { hook_event_name: 'PostCompact', session_id: 'sess-downshift', cwd: ws.cwd },
      hookOpts
    );
    assert.equal(postCompact.stdout, '');

    // 4.3 DET-08 allows post-compaction switch right after compaction (prompt_cache_warm = false AND measured v1/v2 splits)
    const afterCompactCold = runPreModelSwitchHook(
      {
        session_id: 'sess-downshift',
        cwd: ws.cwd,
        hook_event_name: 'PreModelSwitch',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        cached_tokens: 15_000,
        prompt_cache_warm: false,
        mode: 'AUTO_PILOT'
      },
      hookOpts
    );
    assert.equal(afterCompactCold.verdict.blocked, false);

    // Measured H6 v1 splits (C1_r02: 7,627 + 21,725; C1_r01: 10,619 + 21,957) -> negative penalty, allow!
    for (const [cr, cw] of [
      [7_627, 21_725],
      [10_619, 21_957]
    ]) {
      const v1 = computeBreakEvenCachedTokens({
        currentModel: 'claude-opus-4-6',
        targetModel: 'claude-sonnet-4-6',
        cachedTokens: cr,
        uncachedWriteTokens: cw,
        expectedOutputTokens: 150,
        cacheWarm: true
      });
      assert.ok(v1.coldWritePenaltyUSD < 0, `Expected v1 penalty < 0 for ${cr}+${cw}, got ${v1.coldWritePenaltyUSD}`);
      assert.equal(v1.shouldHoldModel, false);
    }

    // Measured H6 v2 splits (C1_v2_r01: 7,629 + 7,846; C1_v2_r02: 7,631 + 7,310) -> small penalty, pays back <= 3 reqs, allow!
    for (const [cr, cw] of [
      [7_629, 7_846],
      [7_631, 7_310]
    ]) {
      const v2 = new CacheGravityRouter({ mode: 'AUTO_PILOT' }).evaluateModelSwitch({
        currentModel: 'claude-opus-4-6',
        targetModel: 'claude-sonnet-4-6',
        cachedTokens: cr,
        uncachedWriteTokens: cw,
        expectedOutputTokens: 150,
        expectedRemainingTurns: 21,
        cacheWarm: true
      });
      assert.equal(v2.blocked, false);
      assert.ok(v2.breakEven.coldWritePenaltyUSD < 0.02);
      assert.ok(v2.breakEven.paybackWarmRequests <= 3);
    }

    // 4.4 Clear triggers: PostModelSwitch and SessionEnd
    runPreModelSwitchHook(
      {
        session_id: 'sess-clear-test',
        cwd: ws.cwd,
        hook_event_name: 'PreModelSwitch',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        cached_tokens: 90_000,
        expectedOutputTokens: 150,
        expected_remaining_turns: 4,
        cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      hookOpts
    );
    assert.ok(readBreakerStateSnapshot('sess-clear-test', hookOpts).pending_downshift);
    runPostModelSwitchHook({ session_id: 'sess-clear-test', cwd: ws.cwd }, hookOpts);
    assert.equal(readBreakerStateSnapshot('sess-clear-test', hookOpts).pending_downshift, null);

    runPreModelSwitchHook(
      {
        session_id: 'sess-end-test',
        cwd: ws.cwd,
        hook_event_name: 'PreModelSwitch',
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        cached_tokens: 90_000,
        expectedOutputTokens: 150,
        expected_remaining_turns: 4,
        cache_warm: true,
        mode: 'AUTO_PILOT'
      },
      hookOpts
    );
    assert.ok(readBreakerStateSnapshot('sess-end-test', hookOpts).pending_downshift);
    runStopGateHook({ hook_event_name: 'SessionEnd', session_id: 'sess-end-test', cwd: ws.cwd }, hookOpts);
    assert.equal(readBreakerStateSnapshot('sess-end-test', hookOpts).pending_downshift, null);
  } finally {
    ws.cleanup();
  }
});

test('Item 5: task-boundary /compact suggestion defaults OFF, respects ROI/mid-debug/4-turn cooldown, and PreCompact stays clean', () => {
  const ws = makeTempDir('ctxtop-item5-');
  try {
    // 5.1 Default config has smartCompactBoundarySuggest === false
    const cfg = loadHorizonConfig({ cwd: ws.cwd, homeDir: ws.homeDir });
    assert.equal(cfg.thresholds.smartCompactBoundarySuggest, false);

    // 5.2 Negative ROI at ~49k (v1, 12 reqs) vs positive ROI at ~139k (v2, 21 reqs)
    const roi49k = computeCompactionHorizonNetSaving({
      modelId: 'claude-sonnet-4-6',
      preCompactTokens: 49_338,
      expectedRemainingRequests: 12
    });
    assert.equal(roi49k.positive, false);

    const roi139k = computeCompactionHorizonNetSaving({
      modelId: 'claude-sonnet-4-6',
      preCompactTokens: 139_174,
      expectedRemainingRequests: 21
    });
    assert.equal(roi139k.positive, true);
    assert.ok(roi139k.netSavingUSD > 0.4, `Expected positive net saving at 139k, got ${roi139k.netSavingUSD}`);

    // Disabled by default even on positive ROI boundary
    const defaultOff = evaluateSmartCompactSuggestion({
      boundaryDetected: true,
      detectorState: 'task_boundary',
      modelId: 'claude-sonnet-4-6',
      preCompactTokens: 139_174,
      expectedRemainingRequests: 21
    });
    assert.equal(defaultOff.shouldSuggest, false);

    // Suppressed during mid_debug and <4 turns post-compact
    const midDebug = evaluateSmartCompactSuggestion({
      enabled: true,
      boundaryDetected: false,
      detectorState: 'mid_debug',
      openFailure: true,
      modelId: 'claude-sonnet-4-6',
      preCompactTokens: 139_174,
      expectedRemainingRequests: 21
    });
    assert.equal(midDebug.shouldSuggest, false);
    assert.equal(midDebug.suppressedReason, 'mid_debug');

    const cooldown = evaluateSmartCompactSuggestion({
      enabled: true,
      boundaryDetected: true,
      detectorState: 'task_boundary',
      turnsSinceLastCompact: 3,
      modelId: 'claude-sonnet-4-6',
      preCompactTokens: 139_174,
      expectedRemainingRequests: 21
    });
    assert.equal(cooldown.shouldSuggest, false);
    assert.equal(cooldown.suppressedReason, 'post_compact_cooldown');

    // Fires via PostToolUse -> Stop when enabled, >=4 turns since compact, boundary passed, ROI positive
    const hookOpts = { cwd: ws.cwd, homeDir: ws.homeDir, persistState: true };
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify({ flightMode: 'COACH', smartCompactBoundarySuggest: true }),
      'utf8'
    );
    writeBreakerStateSnapshot('sess-b', new CircuitBreakerEngine({ turnsSinceLastCompact: 5 }).exportStateSnapshot(), hookOpts);
    runPostToolUseHook({ session_id: 'sess-b', cwd: ws.cwd, tool_name: 'Edit', tool_input: { file_path: 'a.mjs' } }, hookOpts);
    runPostToolUseHook(
      { session_id: 'sess-b', cwd: ws.cwd, tool_name: 'Bash', tool_input: { command: 'node --test test/a.test.mjs' }, exit_code: 0 },
      hookOpts
    );
    const stopRes = runStopGateHook(
      {
        hook_event_name: 'Stop',
        session_id: 'sess-b',
        cwd: ws.cwd,
        model: 'claude-sonnet-4-6',
        context_tokens: 139_174,
        expected_remaining_requests: 21
      },
      hookOpts
    );
    assert.equal(stopRes.smartCompactSuggestion.shouldSuggest, true);
    assert.match(stopRes.stdoutJson.systemMessage, /unverified/);
    assert.match(stopRes.stdoutJson.systemMessage, /2-minute/);
    assert.match(stopRes.stdoutJson.systemMessage, /\$/);

    // 5.4 PreCompact emits zero custom compaction instructions
    const preCompact = runCompactLifecycleHook(
      { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'sess-b', cwd: ws.cwd },
      hookOpts
    );
    assert.equal(preCompact.stdout, '');
  } finally {
    ws.cleanup();
  }
});

test('Item 6: SessionStart:resume advises on changed MCP/tool configuration when warm cache is large', () => {
  const ws = makeTempDir('ctxtop-item6-');
  try {
    const hookOpts = { cwd: ws.cwd, homeDir: ws.homeDir, persistState: true, checkCapabilities: false, snapshotTestHashes: false };
    fs.writeFileSync(
      path.join(ws.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { fsServer: { command: 'node', args: ['mcp-a.mjs'] } } }),
      'utf8'
    );

    // End session saving initial toolset hash + context tokens
    runStopGateHook(
      { hook_event_name: 'SessionEnd', session_id: 'sess-mcp', cwd: ws.cwd, model: 'claude-sonnet-4-6', context_tokens: 45_000 },
      hookOpts
    );

    // Unchanged resume -> silent
    const sameResume = runCompactLifecycleHook(
      { hook_event_name: 'SessionStart', source: 'resume', session_id: 'sess-mcp', cwd: ws.cwd, model: 'claude-sonnet-4-6', context_tokens: 45_000 },
      hookOpts
    );
    assert.equal(sameResume.stdout, '');

    // Mutate .mcp.json (like T6 CC-T) -> large non-expired resume warns with catalog write cost
    fs.writeFileSync(
      path.join(ws.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { fsServer: { command: 'node', args: ['mcp-a.mjs'] }, dbServer: { command: 'node', args: ['mcp-b.mjs'] } } }),
      'utf8'
    );
    const changedResume = runCompactLifecycleHook(
      {
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess-mcp',
        cwd: ws.cwd,
        model: 'claude-sonnet-4-6',
        context_tokens: 45_000,
        prompt_cache_likely_expired: false
      },
      hookOpts
    );
    assert.match(changedResume.stdoutJson.systemMessage, /rewrite ~45,000 cached tokens/);
    assert.match(changedResume.stdoutJson.systemMessage, /\$0\.168[78]/); // 45k * $3.75/1M
    assert.match(changedResume.stdoutJson.systemMessage, /CC-T/);

    // Expired cache or small context stays silent
    const h1 = computeActiveToolsetHash({ cwd: ws.cwd }, hookOpts);
    const h2 = computeActiveToolsetHash({ cwd: ws.cwd, mcpServers: { extra: { command: 'x' } } }, hookOpts);
    assert.equal(
      evaluateResumeToolsetChange({ previousHashRecord: h1, currentHashRecord: h2, contextTokens: 45_000, cacheExpired: true, modelId: 'claude-sonnet-4-6' }).shouldWarn,
      false
    );
    assert.equal(
      evaluateResumeToolsetChange({ previousHashRecord: h1, currentHashRecord: h2, contextTokens: 3_000, cacheExpired: false, modelId: 'claude-sonnet-4-6' }).shouldWarn,
      false
    );
    const unknownResume = evaluateResumeToolsetChange({
      previousHashRecord: h1,
      currentHashRecord: h2,
      contextTokens: 45_000,
      cacheExpired: false,
      modelId: 'unknown-model-x'
    });
    assert.equal(unknownResume.shouldWarn, true);
    assert.ok(!unknownResume.advisory.includes('$'));
  } finally {
    ws.cleanup();
  }
});
