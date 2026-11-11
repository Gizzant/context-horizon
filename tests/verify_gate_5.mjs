import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  classifyTaskComplexity,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
} from '../src/core/task_quota_router.mjs';
import { AgBridgeService } from '../src/core/ag_bridge.mjs';

test('[GATE-5.1] Pre-Invocation Classifier across 30 prompt benchmarks (<5ms), Floor Guarantee & Loop Escalation', () => {
  const lowPrompts = [
    'fix typo in README header',
    'rename variable userCnt to userCount in @src/utils.mjs',
    'format markdown table in docs',
    'add docstring to calculateTotal helper',
    'write fixture for mock user profile JSON',
    'update comment on line 42',
    'bump version in package metadata',
    'fix lint warning unused variable',
    'sort imports alphabetically in @src/index.mjs',
    'export constant MAX_RETRIES = 3'
  ];

  const ambiguousOrMediumPrompts = [
    'something is wrong with the login flow',
    'the sidebar is not working after reload',
    'weird bug when clicking save twice',
    'intermittent timeout in parser',
    'flaky test in suite',
    'investigate why memory grows slowly',
    'implement input validation for email field',
    'add unit test for token counter',
    'optimize array filter in handler',
    'fix bug in date formatter'
  ];

  const highPrompts = [
    'architect a multi-process IPC state machine',
    'refactor across @src/a.mjs @src/b.mjs @src/c.mjs',
    'debug race condition in async worker pool',
    'resolve deadlock in sqlite wal checkpoint',
    'design concurrency control for prefix cache',
    'perform security audit of authentication boundary',
    'implement schema migration for instincts database',
    'cross-module refactor of telemetry pipeline',
    'redesign distributed consensus coordinator',
    '/plan draft full implementation_plan.md architecture'
  ];

  const all30 = [
    ...lowPrompts.map((p) => ({ prompt: p, expectedGroup: 'LOW' })),
    ...ambiguousOrMediumPrompts.map((p) => ({ prompt: p, expectedGroup: 'PROTECTED_FLOOR' })),
    ...highPrompts.map((p) => ({ prompt: p, expectedGroup: 'HIGH' }))
  ];
  assert.equal(all30.length, 30, 'Must evaluate 30 benchmark prompts');

  for (const item of all30) {
    const res = classifyTaskComplexity({ prompt: item.prompt });
    assert.ok(res.elapsedMs < 5.0, `Classification took ${res.elapsedMs}ms (>5ms limit) for "${item.prompt}"`);

    if (item.expectedGroup === 'LOW') {
      assert.equal(res.complexityTier, 'LOW', `Expected LOW tier for: ${item.prompt}`);
      assert.ok(res.confidence >= 0.85, `Expected confidence >= 0.85 for: ${item.prompt}`);
      assert.equal(res.recommendedModel, 'gemini-3.8-flash');
      assert.equal(res.recommendedEffort, 'low');
      assert.equal(res.estimatedBurnMultiplier, 1.0);
    } else if (item.expectedGroup === 'PROTECTED_FLOOR') {
      // "Floor is the Guarantee": never downgrade to budget Flash when confidence < 0.85 or MEDIUM tier
      assert.notEqual(
        res.recommendedModel,
        'gemini-3.8-flash',
        `Floor Guarantee violated: downgraded "${item.prompt}" to Flash`
      );
      assert.ok(res.estimatedBurnMultiplier >= 3.0);
    } else if (item.expectedGroup === 'HIGH') {
      assert.equal(res.complexityTier, 'HIGH', `Expected HIGH tier for: ${item.prompt}`);
      assert.equal(res.recommendedModel, 'gemini-4-argon');
      assert.equal(res.recommendedEffort, 'high');
      assert.equal(res.estimatedBurnMultiplier, 9.25);
    }
  }

  // Verify Floor Guarantee when confidence < 0.85 even on a LOW prompt
  const lowConfidenceCheck = classifyTaskComplexity({
    prompt: 'fix typo in header',
    confidenceOverride: 0.72
  });
  assert.equal(lowConfidenceCheck.floorGuaranteeApplied, true);
  assert.equal(lowConfidenceCheck.recommendedModel, 'gemini-4-argon');

  // Verify Auto-Escalation on DET-01 / DET-02 loop detection
  const loopEscalated = classifyTaskComplexity({
    prompt: 'fix typo in header',
    activeModel: 'gemini-3.8-flash',
    activeEffort: 'low',
    det01Count: 2
  });
  assert.equal(loopEscalated.loopEscalated, true);
  assert.equal(loopEscalated.recommendedModel, 'gemini-4-argon');
  assert.equal(loopEscalated.recommendedEffort, 'medium');
  assert.equal(loopEscalated.estimatedBurnMultiplier, 5.5);
});

test('[GATE-5.2] CacheGravityScorer across 30 scenarios (Cached History 0..180k & TTL 0s..296s)', () => {
  const scorer = new CacheGravityScorer();

  // Verify exact mathematical equation on a known point:
  // Active: gemini-4-argon (high, 9.25x), T_cached = 100,000, TTL = 296s, T_uncached_delta = 2,000
  const argonLowCost = scorer.computeEffectiveCost({
    candidateModel: 'gemini-4-argon',
    candidateEffort: 'low',
    activeModel: 'gemini-4-argon',
    cachedTokens: 100000,
    cacheTtlSeconds: 296,
    uncachedDeltaTokens: 2000
  });
  // M(argon, low) = 3.0; I_same = 1; E_output(low) = 800 -> 3.0 * (0.05 * 100000 + 0 + 2000 + 800) = 3.0 * 7800 = 23400
  assert.equal(argonLowCost.sameModelIndicator, 1);
  assert.equal(argonLowCost.effectiveTokens, 7800);
  assert.equal(argonLowCost.effectiveQuotaCost, 23400);

  const flashColdSwitchCost = scorer.computeEffectiveCost({
    candidateModel: 'gemini-3.8-flash',
    candidateEffort: 'low',
    activeModel: 'gemini-4-argon',
    cachedTokens: 100000,
    cacheTtlSeconds: 296,
    uncachedDeltaTokens: 2000
  });
  // M(flash, low) = 1.0; I_same = 0; E_output(low) = 800 -> 1.0 * (0 + 100000 + 2000 + 800) = 102800
  assert.equal(flashColdSwitchCost.sameModelIndicator, 0);
  assert.equal(flashColdSwitchCost.effectiveQuotaCost, 102800);
  assert.ok(
    argonLowCost.effectiveQuotaCost < flashColdSwitchCost.effectiveQuotaCost,
    'Staying on Argon-Low with warm 100k cache must be cheaper than cold-prefilling 100k on Flash-Low'
  );

  // Build 30 benchmark scenarios varying Cached History (0 .. 180k, crossing closed-form C* = 3,529) and TTL (0s .. 296s)
  const cachedTokenLevels = [0, 2000, 3500, 20000, 50000, 60000, 80500, 100000, 140000, 180000];
  const ttlLevels = [0, 120, 296];
  const scenarios = [];
  for (const tokens of cachedTokenLevels) {
    for (const ttl of ttlLevels) {
      scenarios.push({ cachedTokens: tokens, cacheTtlSeconds: ttl });
    }
  }
  assert.equal(scenarios.length, 30, 'Must test 30 cache gravity scenarios');

  const breakEven = scorer.computeBreakEven({
    currentModel: 'gemini-4-argon',
    targetModel: 'gemini-3.8-flash',
    targetEffort: 'low',
    cachedTokens: 100000,
    ttlRemainingSeconds: 296
  });
  assert.equal(breakEven.breakEvenTokens, 3529);

  for (const sc of scenarios) {
    const evalRes = scorer.evaluateCandidates({
      activeModel: 'gemini-4-argon',
      activeEffort: 'high',
      cachedTokens: sc.cachedTokens,
      cacheTtlSeconds: sc.cacheTtlSeconds,
      uncachedDeltaTokens: 2000,
      complexityTier: 'LOW',
      confidence: 0.92
    });

    if (sc.cachedTokens > breakEven.breakEvenTokens && sc.cacheTtlSeconds > 0) {
      // Warm Cache Gravity active (above closed-form break-even C* = 3,529) -> Rule A & Rule B
      assert.equal(evalRes.hasWarmCacheGravity, true);
      assert.equal(evalRes.primaryRecommendation.action, 'MODULATE_EFFORT_SAME_MODEL');
      assert.equal(evalRes.primaryRecommendation.model, 'gemini-4-argon');
      assert.equal(evalRes.primaryRecommendation.effort, 'low');
      assert.equal(evalRes.primaryRecommendation.preservesWarmCache, true);
      assert.ok(evalRes.subagentOffloadOption, 'Rule B must provide Flash-Low Subagent offload option');
      assert.ok(evalRes.localOffloadOption, 'Rule B must provide Local LiteRT Gemma 4 0.0x offload option');
    } else {
      // Cold cache (TTL == 0) or <= C* (3,529 tokens) -> safe to switch to Flash-Low
      assert.equal(evalRes.hasWarmCacheGravity, false);
      assert.equal(evalRes.primaryRecommendation.model, 'gemini-3.8-flash');
      assert.equal(evalRes.primaryRecommendation.effort, 'low');
    }
  }
});

test('[GATE-5.3] TaskMdDirectiveWatcher (<5ms) & ModelSelectorActuator (Coach vs Auto-Pilot warm-cache safety)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate5-router-'));
  const taskMdPath = path.join(tmpDir, 'task.md');

  const dispatchedCommands = [];
  const agBridge = new AgBridgeService({
    homeDir: tmpDir,
    rpcTransport: {
      getModelState: async () => ({ model: 'gemini-4-argon', effort: 'high' }),
      sendChatCommand: async (sessionId, payload) => {
        dispatchedCommands.push({ sessionId, payload });
        return { ok: true };
      }
    }
  });

  const scorer = new CacheGravityScorer();
  const actuator = new ModelSelectorActuator({
    agBridge,
    cacheGravityScorer: scorer,
    mode: 'coach',
    activeModel: 'gemini-4-argon',
    activeEffort: 'high'
  });
  const watcher = new TaskMdDirectiveWatcher({
    cacheGravityScorer: scorer,
    actuator
  });

  // 1. Test annotateTaskMdPlan during PLANNING mode
  const rawPlan = [
    '# Task Plan',
    '- [ ] Architect multi-process state machine across modules',
    '- [ ] Implement cache gravity scorer handler',
    '- [ ] Fix typo in README table'
  ].join('\n');
  const annotatedPlan = watcher.annotateTaskMdPlan(rawPlan);
  assert.ok(annotatedPlan.includes('- [ ] [argon:high] Architect multi-process state machine'));
  assert.ok(annotatedPlan.includes('- [ ] [argon:medium] Implement cache gravity scorer handler'));
  assert.ok(annotatedPlan.includes('- [ ] [flash:low] Fix typo in README table'));

  // 2. Test <5ms directive parsing on `- [/] [flash:low]` transition
  const activeTaskMd = [
    '# Task Plan',
    '- [x] [argon:high] Architect multi-process state machine across modules',
    '- [/] [flash:low] Add unit test fixtures and update README table',
    '- [ ] [local:gemma4] Format changelog'
  ].join('\n');
  fs.writeFileSync(taskMdPath, activeTaskMd, 'utf8');

  const parsed = watcher.parseTaskMdDirectives(activeTaskMd, {
    activeModel: 'gemini-4-argon',
    activeEffort: 'high',
    cachedTokens: 80500,
    cacheTtlSeconds: 296
  });

  assert.equal(parsed.foundActiveStep, true);
  assert.ok(parsed.elapsedMs < 5.0, `Expected <5ms parse, got ${parsed.elapsedMs}ms`);
  assert.equal(parsed.activeStep.directive.model, 'gemini-3.8-flash');
  assert.equal(parsed.activeStep.directive.effort, 'low');

  // 3. Test Coach Mode: recommends dropping to Argon-Low or spawning Flash Subagent without auto-actuating
  const coachRes = await actuator.handleDirectiveTransition(parsed, {
    activeModel: 'gemini-4-argon',
    activeEffort: 'high',
    cachedTokens: 80500,
    cacheTtlSeconds: 296
  });
  assert.equal(coachRes.mode, 'coach');
  assert.equal(coachRes.actuated, false);
  assert.equal(coachRes.preventedColdPrefill, true);
  assert.equal(coachRes.recommendedModel, 'gemini-4-argon');
  assert.equal(coachRes.recommendedEffort, 'low');
  assert.ok(coachRes.coachPillText.includes('[flash:low]'));
  assert.ok(coachRes.coachPillText.includes('Spawn Flash Subagent'));
  assert.equal(dispatchedCommands.length, 0);

  // 4. Test Auto-Pilot Mode with warm 80.5k cache: switches effort to Argon-Low WITHOUT busting model cache
  actuator.setMode('autopilot');
  const autoWarmRes = await actuator.handleDirectiveTransition(parsed, {
    activeModel: 'gemini-4-argon',
    activeEffort: 'high',
    cachedTokens: 80500,
    cacheTtlSeconds: 296
  });
  assert.equal(autoWarmRes.mode, 'autopilot');
  assert.equal(autoWarmRes.actuated, true);
  assert.equal(autoWarmRes.preventedColdPrefill, true);
  assert.equal(autoWarmRes.activeModel, 'gemini-4-argon', 'Must keep Argon model family to preserve 80.5k warm cache');
  assert.equal(autoWarmRes.activeEffort, 'low', 'Must drop effort tier to low (3.0x)');
  assert.equal(autoWarmRes.syncStatus, 'live synced');
  assert.equal(dispatchedCommands.length, 1);
  assert.equal(dispatchedCommands[0].payload.model, 'gemini-4-argon');
  assert.equal(dispatchedCommands[0].payload.effort, 'low');

  // 5. Test Auto-Pilot Mode at clean boundary (/handoff or cold cache): switches model family to Flash-Low
  const autoCleanRes = await actuator.handleDirectiveTransition(parsed, {
    activeModel: 'gemini-4-argon',
    activeEffort: 'low',
    cachedTokens: 0,
    cacheTtlSeconds: 0,
    isCleanBoundary: true
  });
  assert.equal(autoCleanRes.actuated, true);
  assert.equal(autoCleanRes.preventedColdPrefill, false);
  assert.equal(autoCleanRes.activeModel, 'gemini-3.8-flash');
  assert.equal(autoCleanRes.activeEffort, 'low');

  // 6. Test Unified Facade evaluateTaskAndQuotaRoute
  const routeSummary = evaluateTaskAndQuotaRoute({
    prompt: 'Add unit test fixtures and update README table',
    taskMdContent: activeTaskMd,
    activeModel: 'gemini-4-argon',
    activeEffort: 'high',
    cachedTokens: 80500,
    cacheTtlSeconds: 296,
    routerMode: 'coach'
  });
  assert.equal(routeSummary.activeModelLabel, 'Gemini 4 Argon');
  assert.equal(routeSummary.activeBurnMultiplier, 9.25);
  assert.equal(routeSummary.syncStatus, 'live synced');
  assert.ok(routeSummary.coachPillText.includes('Keep 80.5k Cache'));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
  }
});
