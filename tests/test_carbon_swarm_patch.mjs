import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CORE_SCHEMAS,
  CARBON_RATE_CLIFF_UTC,
  LEGACY_MODEL_SUNSET_UTC,
  SHARED_1M_CONTEXT_POOL_TOKENS,
  resolveModelDescriptor,
  validateModelDescriptor,
  resolveModelRates,
  calculateModelCost,
  isModelDeprecated,
  getDeprecatedModelMigrationNotice,
  isPlanTierEligible,
  computeUnifiedContextPool,
  evaluateCarbonVerbosityGuardrail,
  formatAgentCacheKey,
  parseAgentCacheKey,
  createSwarmAgentState,
  validateSwarmAgentState
} from '../src/core/constants.mjs';

import {
  classifyTaskComplexity,
  CacheGravityScorer,
  getEligibleModelsForRouting
} from '../src/core/task_quota_router.mjs';

import {
  TurnBoundaryModelSwitchBuffer,
  trackModelCachePools,
  detectRouterThrash,
  computeQuotaAndCacheTelemetry
} from '../src/core/quota.mjs';

import {
  SwarmIdleTtlTracker,
  evaluateSwarmColdCacheWakeup,
  computeSwarmRosterTtlBadges
} from '../src/core/subagents.mjs';

import {
  readSidecarSync,
  writeSidecarAtomicSync,
  updateSwarmAgentStateAtomicSync
} from '../src/core/sidecar_store.mjs';

import {
  SWARM_TOOL_MATCHER,
  validateAntigravityHooksSchema,
  registerCliDampeningHook
} from '../src/core/layer5_hygiene.mjs';

import {
  handlePreInvocation,
  handlePreToolUse,
  handlePostInvocation,
  handlePostToolUse,
  buildHooksConfig
} from '../src/adapters/antigravity/index.mjs';

import {
  normalizeClaudeCodePayload,
  trackClaudeCodeSessionCache
} from '../src/adapters/claude-code/index.mjs';

describe('Phase 5 Auditor Exit Criteria — Gemini 4 Carbon, Date-Gated Pricing, Composite Cache Keys, and /swarm Idle-TTL Sensors', () => {
  it('Schema Gate: freezes ModelDescriptor, RateSchedule, AgentCacheKey, and SwarmAgentState schemas', () => {
    assert.ok(Object.isFrozen(CORE_SCHEMAS));
    assert.ok(Object.isFrozen(CORE_SCHEMAS.ModelDescriptor));
    assert.ok(Object.isFrozen(CORE_SCHEMAS.RateSchedule));
    assert.ok(Object.isFrozen(CORE_SCHEMAS.AgentCacheKey));
    assert.ok(Object.isFrozen(CORE_SCHEMAS.SwarmAgentState));

    // Verify Gemini 4 Carbon & internal enum aliases M427, M437, M438, M670
    for (const alias of ['gemini-4-carbon', 'M427', 'M437', 'M438']) {
      const desc = resolveModelDescriptor(alias);
      assert.ok(desc, `Expected descriptor for ${alias}`);
      assert.equal(desc.id, 'gemini-4-carbon');
      assert.deepEqual(desc.supported_effort_tiers, ['low', 'medium', 'high']);
      assert.equal(desc.caching_mode, 'implicit_only');
      assert.equal(desc.supports_explicit_cache, false);
      assert.equal(desc.antigravity_min_tier, 'ultra');
      assert.equal(desc.shared_context_pool_tokens, 1048576);
      assert.equal(validateModelDescriptor(desc).valid, true);
    }

    const cyberDesc = resolveModelDescriptor('M670');
    assert.ok(cyberDesc);
    assert.equal(cyberDesc.id, 'gemini-4-carbon-cyber-permissive');
    assert.equal(cyberDesc.caching_mode, 'implicit_only');
    assert.equal(cyberDesc.supports_explicit_cache, false);
    assert.equal(cyberDesc.antigravity_min_tier, 'ultra');

    const argonDesc = resolveModelDescriptor('gemini-4-argon');
    assert.equal(argonDesc.caching_mode, 'implicit_only');
    assert.equal(argonDesc.supports_explicit_cache, false);
    assert.equal(argonDesc.antigravity_min_tier, 'pro');

    const flashDesc = resolveModelDescriptor('gemini-3.8-flash');
    assert.equal(flashDesc.antigravity_min_tier, 'free');
  });

  it('1. Pricing Schedule Tests: exact cost output before and on/after 2026-12-01T00:00:00Z across Standard & Priority tiers', () => {
    const payload = {
      input_tokens: 500_000,
      cached_input_tokens: 200_000, // 300k uncached + 200k cached read
      output_tokens: 50_000,
      thinking_tokens: 150_000 // total decode = 200k tokens
    };

    // Introductory window: 2026-11-30T23:59:59Z
    // Standard: $2.00 / 1M input, $10.00 / 1M output (output + thinking), $0.10 / 1M cached read
    const introRatesStd = resolveModelRates('gemini-4-carbon', '2026-11-30T23:59:59Z', 'standard');
    assert.equal(introRatesStd.window, 'introductory');
    assert.equal(introRatesStd.inputPerMillionUsd, 2.00);
    assert.equal(introRatesStd.outputPerMillionUsd, 10.00);
    assert.equal(introRatesStd.cachedReadPerMillionUsd, 0.10);

    const introCostStd = calculateModelCost(payload, {
      modelId: 'gemini-4-carbon',
      eventTimestampUtc: '2026-11-30T23:59:59Z',
      serviceTier: 'standard'
    });
    // 0.3M * $2.00 ($0.60) + 0.2M * $0.10 ($0.02) + 0.2M * $10.00 ($2.00) = $2.62
    assert.equal(introCostStd.inputCostUsd, 0.6);
    assert.equal(introCostStd.cachedReadCostUsd, 0.02);
    assert.equal(introCostStd.outputCostUsd, 2.0);
    assert.equal(introCostStd.totalCostUsd, 2.62);

    // Introductory Priority: $3.60 / 1M input, $18.00 / 1M output
    const introRatesPri = resolveModelRates('M427', '2026-11-30T23:59:59Z', 'priority');
    assert.equal(introRatesPri.inputPerMillionUsd, 3.60);
    assert.equal(introRatesPri.outputPerMillionUsd, 18.00);
    const introCostPri = calculateModelCost(payload, {
      modelId: 'M427',
      eventTimestampUtc: '2026-11-30T23:59:59Z',
      serviceTier: 'priority'
    });
    // 0.3M * $3.60 ($1.08) + 0.2M * $0.10 ($0.02) + 0.2M * $18.00 ($3.60) = $4.70
    assert.equal(introCostPri.totalCostUsd, 4.7);

    // Post-Introductory window: 2026-12-01T00:00:00Z
    // Standard: $4.00 / 1M input, $20.00 / 1M output (output + thinking), $0.20 / 1M cached read
    const postRatesStd = resolveModelRates('gemini-4-carbon', '2026-12-01T00:00:00Z', 'standard');
    assert.equal(postRatesStd.window, 'post_introductory');
    assert.equal(postRatesStd.inputPerMillionUsd, 4.00);
    assert.equal(postRatesStd.outputPerMillionUsd, 20.00);
    assert.equal(postRatesStd.cachedReadPerMillionUsd, 0.20);

    const postCostStd = calculateModelCost(payload, {
      modelId: 'gemini-4-carbon',
      eventTimestampUtc: '2026-12-01T00:00:00Z',
      serviceTier: 'standard'
    });
    // 0.3M * $4.00 ($1.20) + 0.2M * $0.20 ($0.04) + 0.2M * $20.00 ($4.00) = $5.24
    assert.equal(postCostStd.inputCostUsd, 1.2);
    assert.equal(postCostStd.cachedReadCostUsd, 0.04);
    assert.equal(postCostStd.outputCostUsd, 4.0);
    assert.equal(postCostStd.totalCostUsd, 5.24);

    // Post-Introductory Priority: $7.20 / 1M input, $36.00 / 1M output
    const postRatesPri = resolveModelRates('gemini-4-carbon-cyber-permissive', '2026-12-01T00:00:00Z', 'priority');
    assert.equal(postRatesPri.inputPerMillionUsd, 7.20);
    assert.equal(postRatesPri.outputPerMillionUsd, 36.00);
    const postCostPri = calculateModelCost(payload, {
      modelId: 'gemini-4-carbon-cyber-permissive',
      eventTimestampUtc: '2026-12-01T00:00:00Z',
      serviceTier: 'priority'
    });
    // 0.3M * $7.20 ($2.16) + 0.2M * $0.20 ($0.04) + 0.2M * $36.00 ($7.20) = $9.40
    assert.equal(postCostPri.totalCostUsd, 9.4);
  });

  it('2. Sunset & Tier Tests: suppresses claude-sonnet-4-6, claude-opus-4-6, and gpt-oss-120b on/after 2026-11-18T00:00:00Z and gates Carbon by Ultra/Enterprise tier', () => {
    const retiredIds = ['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-oss-120b'];
    const beforeSunset = '2026-11-17T23:59:59Z';
    const atSunset = '2026-11-18T00:00:00Z';

    for (const id of retiredIds) {
      assert.equal(isModelDeprecated(id, beforeSunset), false, `${id} should not be deprecated before Nov 18`);
      assert.equal(isModelDeprecated(id, atSunset), true, `${id} must be deprecated at/after Nov 18`);
      const notice = getDeprecatedModelMigrationNotice(id, atSunset);
      assert.ok(notice && notice.includes('2026-11-18T00:00:00Z'), `Expected migration notice for ${id}`);
    }

    // Verify routing candidate pool suppresses retired models on/after 2026-11-18T00:00:00Z
    const eligibleOnSunset = getEligibleModelsForRouting({
      eventTimestampUtc: atSunset,
      userTier: 'ultra'
    });
    for (const id of retiredIds) {
      assert.ok(!eligibleOnSunset.includes(id), `Expected ${id} to be excluded on/after ${LEGACY_MODEL_SUNSET_UTC}`);
    }
    assert.ok(eligibleOnSunset.includes('gemini-4-carbon'));

    // Verify Plan-Tier Gating: Free & Pro users never get recommended Ultra-only gemini-4-carbon
    assert.equal(isPlanTierEligible('gemini-4-carbon', 'free'), false);
    assert.equal(isPlanTierEligible('gemini-4-carbon', 'pro'), false);
    assert.equal(isPlanTierEligible('gemini-4-carbon', 'ultra'), true);
    assert.equal(isPlanTierEligible('gemini-4-carbon', 'enterprise'), true);
    assert.equal(isPlanTierEligible('gemini-4-argon', 'pro'), true);
    assert.equal(isPlanTierEligible('gemini-3.8-flash', 'free'), true);

    const eligiblePro = getEligibleModelsForRouting({
      eventTimestampUtc: atSunset,
      userTier: 'pro'
    });
    assert.ok(!eligiblePro.includes('gemini-4-carbon'));
    assert.ok(eligiblePro.includes('gemini-4-argon'));
    assert.ok(eligiblePro.includes('gemini-3.8-flash'));

    // Verify classifyTaskComplexity surfaces migrationNotice when pinned to retired model and respects userTier
    const complexOnPro = classifyTaskComplexity('Design a distributed multi-region consensus architecture refactor', {
      currentModel: 'claude-opus-4-6',
      userTier: 'pro',
      eventTimestampUtc: atSunset
    });
    assert.ok(!retiredIds.includes(complexOnPro.recommendedModel));
    assert.notEqual(complexOnPro.recommendedModel, 'gemini-4-carbon');
    assert.ok(complexOnPro.migrationNotice && complexOnPro.migrationNotice.includes('2026-11-18T00:00:00Z'));

    const complexOnUltra = classifyTaskComplexity('Design a distributed multi-region consensus architecture refactor', {
      currentModel: 'claude-opus-4-6',
      userTier: 'ultra',
      preferCarbon: true,
      eventTimestampUtc: atSunset
    });
    assert.equal(complexOnUltra.recommendedModel, 'gemini-4-carbon');
  });

  it('3. Unified Context Pool & Carbon Verbosity Guardrail Tests: 700K input + 200K thinking + 80K output = 980,000 / 1,048,576 (93.46%) and 348,576 decode headroom', () => {
    const pool = computeUnifiedContextPool(
      {
        input_tokens: 700_000,
        thinking_tokens: 200_000,
        output_tokens: 80_000
      },
      'gemini-4-carbon'
    );

    assert.equal(pool.ceiling, SHARED_1M_CONTEXT_POOL_TOKENS);
    assert.equal(pool.ceiling, 1_048_576);
    assert.equal(pool.pool_used, 980_000);
    assert.equal(pool.remaining_decode_headroom, 348_576);
    assert.equal(pool.remaining_pool_tokens, 68_576);
    assert.equal(pool.utilization_pct, 93.46);
    assert.equal(pool.is_overflow, false);

    // Carbon High-Effort Verbosity Detector across >= 2 consecutive routine turns
    const routineTurns = [
      {
        input_tokens: 10_000,
        thinking_tokens: 18_000,
        output_tokens: 2_000,
        effort: 'high',
        toolCalls: [{ name: 'edit_file', args: { Path: 'src/utils.js' } }],
        status: 'DONE'
      },
      {
        input_tokens: 12_000,
        thinking_tokens: 20_000,
        output_tokens: 1_500,
        effort: 'high',
        toolCalls: [{ name: 'run_command', args: { CommandLine: 'git status' } }],
        status: 'DONE'
      }
    ];

    const verbosity = evaluateCarbonVerbosityGuardrail(routineTurns, {
      modelId: 'gemini-4-carbon',
      activeEffort: 'high',
      reasoningTokenBudget: 12_000,
      eventTimestampUtc: '2026-11-20T00:00:00Z'
    });
    assert.equal(verbosity.triggered, true);
    assert.equal(verbosity.consecutiveRoutineHighTurns, 2);
    assert.ok(verbosity.prescription.includes('/effort medium'));
    assert.ok(verbosity.prescription.includes('gemini-3.8-flash'));
  });

  it('4. Swarm Hot-Swap & Turn-Boundary Tests: composite cache keys prevent false-positive prefix-bust alerts across interleaved swarm agents, and mid-turn switches wait until PostInvocation', async () => {
    const sessionId = 'swarm-session-42';
    const interleavedEvents = [
      {
        stepIndex: 1,
        session_id: sessionId,
        agent_id: 'agent_coordinator',
        model: 'gemini-4-carbon',
        inputTokens: 140_000,
        cachedTokens: 0,
        cacheCreationInputTokens: 0, // implicit-only cache: must NOT trigger missing-cache warning
        outputTokens: 2_000
      },
      {
        stepIndex: 2,
        session_id: sessionId,
        agent_id: 'agent_worker_1',
        model: 'gemini-3.8-flash',
        inputTokens: 22_000,
        cachedTokens: 0,
        outputTokens: 800
      },
      {
        stepIndex: 3,
        session_id: sessionId,
        agent_id: 'agent_verifier',
        model: 'gemini-4-carbon',
        inputTokens: 115_000,
        cachedTokens: 0,
        outputTokens: 1_500
      },
      {
        stepIndex: 4,
        session_id: sessionId,
        agent_id: 'agent_coordinator',
        model: 'gemini-4-carbon',
        inputTokens: 145_000,
        cachedTokens: 138_000,
        outputTokens: 1_200
      },
      {
        stepIndex: 5,
        session_id: sessionId,
        agent_id: 'agent_worker_1',
        model: 'gemini-3.8-flash',
        inputTokens: 25_000,
        cachedTokens: 21_000,
        outputTokens: 900
      },
      {
        stepIndex: 6,
        session_id: sessionId,
        agent_id: 'agent_verifier',
        model: 'gemini-4-carbon',
        inputTokens: 118_000,
        cachedTokens: 112_000,
        outputTokens: 1_100
      }
    ];

    const telemetry = computeQuotaAndCacheTelemetry(interleavedEvents, {
      sessionId,
      modelName: 'gemini-4-carbon'
    });

    // Zero false-positive prefix-bust or router-thrash alerts across interleaved swarm workers
    assert.equal(telemetry.routerThrash.thrashDetected, false);
    assert.equal(telemetry.routerThrash.switchCount, 0);
    assert.equal(telemetry.cache.bustDetected, false);
    assert.equal(telemetry.cache.missingExplicitCacheWarning, false);

    // Verify composite keys are keyed as `${session_id}::${agent_id}::${model_id}`
    assert.ok(telemetry.cache.agentCacheMap[`${sessionId}::agent_coordinator::gemini-4-carbon`]);
    assert.ok(telemetry.cache.agentCacheMap[`${sessionId}::agent_worker_1::gemini-3.8-flash`]);
    assert.ok(telemetry.cache.agentCacheMap[`${sessionId}::agent_verifier::gemini-4-carbon`]);

    // Verify Claude Code single-agent fallback defaults agent_id to "primary"
    const claudeSingle = normalizeClaudeCodePayload({
      session_id: 'cc-sess-1',
      model: 'claude-sonnet-4-5',
      inputTokens: 30_000
    });
    assert.equal(claudeSingle.agent_id, 'primary');
    assert.equal(claudeSingle.compositeCacheKey, 'cc-sess-1::primary::claude-sonnet-4-5');
    assert.deepEqual(parseAgentCacheKey(claudeSingle.compositeCacheKey), {
      session_id: 'cc-sess-1',
      agent_id: 'primary',
      model_id: 'claude-sonnet-4-5'
    });

    // Verify TurnBoundaryModelSwitchBuffer waits until PostInvocation / Stop to flip active_model_id
    const switchBuffer = new TurnBoundaryModelSwitchBuffer('gemini-4-carbon');
    assert.equal(switchBuffer.getActiveModelForStep(), 'gemini-4-carbon');

    // Mid-turn model switch requested during PreToolUse / in-flight tool call
    const midTurnState = switchBuffer.recordMidTurnModelChange('gemini-3.8-flash');
    assert.equal(midTurnState.active_model_id, 'gemini-4-carbon');
    assert.equal(midTurnState.pending_model_id, 'gemini-3.8-flash');
    assert.equal(switchBuffer.getActiveModelForStep(), 'gemini-4-carbon');

    // Promote only on PostInvocation
    const postTurnState = switchBuffer.onTurnBoundary('PostInvocation');
    assert.equal(postTurnState.promoted, true);
    assert.equal(postTurnState.active_model_id, 'gemini-3.8-flash');
    assert.equal(postTurnState.pending_model_id, null);
  });

  it('5. Cold-Cache Wakeup & Hook Schema Tests: t + 180s warm hit vs t + 305s cold cliff alert with exact dollar rebuild estimate, <60s TTL badge, and .agents/hooks.json schema compliance', () => {
    const t0 = Date.parse('2026-12-02T10:00:00Z'); // Post-introductory rate window ($4.00 / 1M input on Standard)
    const tracker = new SwarmIdleTtlTracker({
      cacheTtlMs: 300_000, // 5 minutes
      coldWakeThresholdTokens: 100_000,
      cliffWarningWindowMs: 60_000
    });

    // Coordinator completes its turn with 250,000 warm prefix tokens at t0 -> transitions to idle_zero_token
    const idleState = tracker.onTurnComplete('agent_coordinator', {
      modelId: 'gemini-4-carbon',
      warmPrefixTokens: 250_000,
      timestampMs: t0,
      parentSwarmLive: true
    });
    assert.equal(idleState.status, 'idle_zero_token');
    assert.equal(idleState.warm_prefix_tokens, 250_000);
    assert.equal(validateSwarmAgentState(idleState).valid, true);

    // Case A: send_message at t + 180s (180,000 ms) -> warm cache hit, no alert
    const warmCheck = tracker.handlePreToolSendMessage(
      {
        Recipient: 'agent_coordinator',
        Message: 'Status update from worker-1'
      },
      {
        nowMs: t0 + 180_000,
        eventTimestampUtc: '2026-12-02T10:03:00Z',
        serviceTier: 'standard'
      }
    );
    assert.equal(warmCheck.coldWakeDetected, false);
    assert.equal(warmCheck.cacheWarm, true);
    assert.equal(warmCheck.uncachedRebuildCostUsd, 0);

    // Check TTL badge at t + 250s (50s remaining -> within 60s of falling off the cache cliff)
    const badgesAt250s = tracker.getTtlBadges({ nowMs: t0 + 250_000 });
    const coordBadge = badgesAt250s.find(b => b.agent_id === 'agent_coordinator');
    assert.ok(coordBadge);
    assert.equal(coordBadge.remaining_ttl_sec, 50);
    assert.equal(coordBadge.within_cliff_warning, true);
    assert.ok(coordBadge.badge_label.includes('CACHE CLIFF WARNING'));

    // Case B: send_message at t + 305s (305,000 ms > 300,000 ms TTL) -> Cold-Cache Wakeup alert with exact dollar rebuild estimate
    // 250,000 tokens * ($4.00 / 1M uncached input post-Dec 1) = $1.0000 exact rebuild cost
    // Incremental penalty vs warm read ($0.20 / 1M = $0.0500) = $0.9500
    const coldCheck = tracker.handlePreToolSendMessage(
      {
        Recipient: 'agent_coordinator',
        Message: 'Ready for final verification'
      },
      {
        nowMs: t0 + 305_000,
        eventTimestampUtc: '2026-12-02T10:05:05Z',
        serviceTier: 'standard'
      }
    );
    assert.equal(coldCheck.coldWakeDetected, true);
    assert.equal(coldCheck.cacheWarm, false);
    assert.equal(coldCheck.warmPrefixTokens, 250_000);
    assert.equal(coldCheck.uncachedRebuildCostUsd, 1.0);
    assert.equal(coldCheck.incrementalColdPenaltyUsd, 0.95);
    assert.ok(coldCheck.message.includes('[Cold-Cache Wakeup]'));
    assert.ok(coldCheck.message.includes('$1.0000'));

    // Validate hooks.json and buildHooksConfig schema rules
    const repoHooksJson = JSON.parse(fs.readFileSync(path.resolve('hooks.json'), 'utf8'));
    const repoSchemaCheck = validateAntigravityHooksSchema(repoHooksJson);
    assert.equal(repoSchemaCheck.valid, true, `hooks.json schema errors: ${repoSchemaCheck.errors.join('; ')}`);
    assert.equal(repoSchemaCheck.hasSwarmPreToolMatcher, true);
    assert.equal(repoSchemaCheck.hasSwarmPostToolMatcher, true);

    const builtHooks = buildHooksConfig('/tmp/plugin');
    const builtSchemaCheck = validateAntigravityHooksSchema(builtHooks);
    assert.equal(builtSchemaCheck.valid, true);
    assert.equal(builtSchemaCheck.hasSwarmPreToolMatcher, true);
    assert.equal(builtSchemaCheck.hasSwarmPostToolMatcher, true);

    // Negative schema check: a matcher wrapper inside PreInvocation or Stop MUST be rejected
    const invalidHooks = {
      PreInvocation: [{ matcher: '.*', command: 'node hook.mjs' }]
    };
    const invalidSchemaCheck = validateAntigravityHooksSchema(invalidHooks);
    assert.equal(invalidSchemaCheck.valid, false);
    assert.ok(invalidSchemaCheck.errors.some(e => e.includes('NO matcher wrapper object')));

    // Verify atomic multi-agent state persistence via temp-file swap-and-rename
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-swarm-atomic-'));
    try {
      const updated = updateSwarmAgentStateAtomicSync(
        'test-swarm-conv',
        'agent_coordinator',
        idleState,
        tmpDir
      );
      assert.ok(updated.swarmRoster.agent_coordinator);
      assert.equal(updated.swarmRoster.agent_coordinator.warm_prefix_tokens, 250_000);
      const reloaded = readSidecarSync('test-swarm-conv', tmpDir);
      assert.equal(reloaded.swarmRoster.agent_coordinator.status, 'idle_zero_token');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
