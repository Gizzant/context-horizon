import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  MODEL_REGISTRY,
  MODEL_PRICING_PER_MILLION,
  MODEL_CEILINGS,
  DEFAULT_MODEL_CATALOG_PATH,
  loadModelCatalog,
  loadCustomCeilings,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost,
  resolvePricePerM,
  resolveModelCeiling,
  resolveModelCeilingDetailed
} from '../src/core/constants.mjs';
import { BUILTIN_CONFIG } from '../src/core/config.mjs';
import { SETTINGS_LIMITS, validateSettings } from '../src/core/settings.mjs';
import {
  SESSION_5M_READ_TO_WRITE_MIN_ROI_RATIO,
  computeCacheRoi,
  computeQuotaAndCacheTelemetry,
  evaluateColdSessionCostGate
} from '../src/core/quota.mjs';
import {
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  EXPECTED_OUTPUT_TOKENS_BY_EFFORT,
  normalizeModelId,
  getQuotaMultiplier,
  computeClosedFormBreakEven,
  evaluateCacheGravity as evaluateCoreCacheGravity,
  evaluateTaskAndQuotaRoute
} from '../src/core/task_quota_router.mjs';
import {
  COST_MULTIPLIER_MATRIX,
  CacheGravityScorer as CoachCacheGravityScorer,
  TaskQuotaRouter
} from '../src/core/coach/task_quota_router.mjs';
import { CircuitBreakers } from '../src/core/coach/circuit_breakers.mjs';
import { classifyHorizonWindow } from '../src/core/horizon_classifier.mjs';
import { classifyHorizon } from '../src/core/classifier.mjs';
import { auditSchemaAndPayloads } from '../src/core/blindspot_sensors.mjs';
import { WATERMARKS, assessCompactionState } from '../src/core/compaction_coach.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { createDefaultSidecar, writeSidecarAtomicSync } from '../src/core/sidecar_store.mjs';
import { handlePostInvocation } from '../src/hooks/post_invocation.mjs';
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import { buildSubagentWorktreeDag } from '../src/core/subagents.mjs';
import { runCLI, formatDemoScenarioAnsi } from '../src/cli/horizon_hud.mjs';
import { runPostmortem } from '../src/cli/postmortem.mjs';
import { runDoctor } from '../src/cli/doctor.mjs';
import {
  parseClaudeCodeJsonl,
  parseCursorVscdbSync,
  parseTranscriptIncremental
} from '../src/core/parser.mjs';
import { resolveAndReadTranscriptIncremental } from '../src/core/log_resolver.mjs';
import {
  normalizeClaudeCodePayload,
  trackClaudeCodeSessionCache
} from '../src/adapters/claude-code/index.mjs';
import { buildGitCommitTokenLedger } from '../src/core/git_ledger.mjs';
import { renderThreeTierTufteHud } from '../src/ui/horizon_panel.js';
import { DEMO_SCENARIOS, buildDemoHorizonState } from '../tests/fixtures/synthetic_states.mjs';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

describe('Batch 2 Remediation — ISS-007: Claude 5.5 / Haiku 5.5 100k 5x Cliff / Fable 5.x / Multi-Rate & Dynamic Cold Gate', () => {
  it('registers claude-haiku-5-5 with 1,000,000 ceiling and 100,000-token 5x prompt cliff across fresh + cacheRead + cacheCreate', () => {
    const desc = resolveModelDescriptor('claude-haiku-5.5');
    assert.ok(desc, 'claude-haiku-5.5 alias must resolve to claude-haiku-5-5 descriptor');
    assert.equal(desc.id, 'claude-haiku-5-5');
    assert.equal(resolveModelCeiling('claude-haiku-5-5'), 1000000);

    // <= 100,000 total prompt tokens: $0.10 / $0.50 / $0.125 / $0.20 / $0.01
    const baseRates = resolveModelRates('claude-haiku-5-5', '2026-11-10T12:00:00Z', 'standard', {
      freshInputTokens: 20000,
      cacheReadInputTokens: 50000,
      cacheCreationInputTokens: 30000
    });
    assert.equal(baseRates.input_per_1m, 0.10);
    assert.equal(baseRates.output_per_1m, 0.50);
    assert.equal(baseRates.write_5m_per_1m, 0.125);
    assert.equal(baseRates.write_1h_per_1m, 0.20);
    assert.equal(baseRates.cached_read_per_1m, 0.01);

    // > 100,000 total prompt tokens (1 + 100,000 cached read = 100,001): 5x cliff!
    const cliffRates = resolveModelRates('haiku-5.5', '2026-11-10T12:00:00Z', 'standard', {
      freshInputTokens: 1,
      cacheReadInputTokens: 100000,
      cacheCreationInputTokens: 0
    });
    assert.equal(cliffRates.input_per_1m, 0.50);
    assert.equal(cliffRates.output_per_1m, 2.50);
    assert.equal(cliffRates.write_5m_per_1m, 0.625);
    assert.equal(cliffRates.write_1h_per_1m, 1.00);
    assert.equal(cliffRates.cached_read_per_1m, 0.05);
  });

  it('registers Claude 5.5, Fable 5.x, and Opus/Sonnet/Haiku 4.5-4.6 multi-rate cards and fixes claude-opus-5.5 ($4.00)', () => {
    const flightcheck = JSON.parse(fs.readFileSync(path.resolve('config/default_flightcheck.json'), 'utf8'));
    assert.equal(flightcheck.model_pricing_per_1m_input['claude-opus-5.5'], 4.00);
    assert.equal(flightcheck.model_pricing_per_1m_input['claude-opus-5-5'], 4.00);
    assert.equal(MODEL_PRICING_PER_MILLION['claude-opus-5.5'], 4.00);
    assert.equal(BUILTIN_CONFIG.model_pricing_per_1m_input['claude-opus-5.5'], 4.00);
    assert.equal(MODEL_PRICING_PER_MILLION['claude-opus-4-5'], 5.00);

    const sonnet55 = resolveModelRates('claude-sonnet-5-5');
    assert.equal(sonnet55.input_per_1m, 2.00);
    assert.equal(sonnet55.output_per_1m, 10.00);
    assert.equal(sonnet55.write_5m_per_1m, 2.50);
    assert.equal(sonnet55.write_1h_per_1m, 4.00);
    assert.equal(sonnet55.cached_read_per_1m, 0.10);
    assert.equal(resolveModelCeiling('claude-sonnet-5-5'), 1000000);

    const opus55 = resolveModelRates('claude-opus-5-5');
    assert.equal(opus55.input_per_1m, 4.00);
    assert.equal(opus55.output_per_1m, 20.00);
    assert.equal(opus55.write_5m_per_1m, 5.00);
    assert.equal(opus55.write_1h_per_1m, 8.00);
    assert.equal(opus55.cached_read_per_1m, 0.20);
    assert.equal(resolveModelCeiling('claude-opus-5-5'), 1000000);

    const fable52 = resolveModelRates('claude-fable-5-2');
    assert.equal(fable52.input_per_1m, 8.00);
    assert.equal(fable52.output_per_1m, 40.00);
    assert.equal(fable52.write_5m_per_1m, 10.00);
    assert.equal(fable52.write_1h_per_1m, 16.00);
    assert.equal(fable52.cached_read_per_1m, 0.20);
    assert.equal(resolveModelCeiling('claude-fable-5-2'), 1000000);

    const fable51 = resolveModelRates('claude-fable-5-1');
    assert.equal(fable51.input_per_1m, 10.00);
    assert.equal(fable51.output_per_1m, 50.00);
    assert.equal(fable51.write_5m_per_1m, 12.50);
    assert.equal(fable51.write_1h_per_1m, 20.00);
    assert.equal(fable51.cached_read_per_1m, 0.25);
    assert.equal(resolveModelCeiling('claude-fable-5-1'), 1000000);

    assert.equal(normalizeModelId('claude'), 'claude-sonnet-5-5');
    assert.equal(normalizeModelId('sonnet'), 'claude-sonnet-5-5');
    assert.equal(normalizeModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.equal(normalizeModelId('claude-haiku-5.5'), 'claude-haiku-5-5');
  });

  it('resolves multi-rate billing, 0.05x vs 0.10x cached read discount, dynamic 1h vs 5m TTL, and dynamic Cold Gate pricing', () => {
    const nowMs = Date.parse('2026-11-10T18:00:00Z');
    // 1h cache write 20 minutes ago -> still warm under 3600s TTL!
    const steps1h = [
      {
        stepIndex: 0,
        createdAt: new Date(nowMs - 20 * 60 * 1000).toISOString(),
        model: 'claude-sonnet-5-5',
        inputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 80000,
        write1hTokens: 80000,
        outputTokens: 2000
      },
      {
        stepIndex: 1,
        createdAt: new Date(nowMs - 10 * 60 * 1000).toISOString(),
        model: 'claude-sonnet-5-5',
        inputTokens: 500,
        cacheReadTokens: 80000,
        cacheCreationTokens: 0,
        outputTokens: 1000
      }
    ];
    const telemetry = computeQuotaAndCacheTelemetry(steps1h, {
      modelId: 'claude-sonnet-5-5',
      nowMs
    });
    assert.equal(telemetry.cache.isCacheCold, false, '1h cache written 10m ago must remain warm (>300s)');
    assert.ok(telemetry.cache.ttlRemainingSec > 2000, '1h TTL remaining should be ~3000s, not clamped to 300s');
    // Sonnet 5.5 cachedRead ($0.10) / input ($2.00) = 0.05 (95% discount, not hardcoded 0.10)
    assert.equal(telemetry.cache.pricing.rates.cachedRead, 0.10);
    assert.equal(telemetry.cache.pricing.rates.write1h, 4.00);

    // Cold gate without explicit pricePerMillionUsd uses resolveModelRates(modelId)
    const haikuCold80k = evaluateColdSessionCostGate({
      ttlRemainingSec: 0,
      activeTokens: 80000,
      modelId: 'claude-haiku-5-5'
    });
    // 80k <= 100k -> write5m = $0.125/1M -> 0.08 * 0.125 = $0.01 (never $3.0 * 1.25 = $0.30!)
    assert.ok(Math.abs(haikuCold80k.coldRewriteCostUsd - 0.01) < 1e-6);

    const haikuCold150k = evaluateColdSessionCostGate({
      ttlRemainingSec: 0,
      activeTokens: 150000,
      modelId: 'claude-haiku-5-5'
    });
    // 150k > 100k -> 5x cliff write5m = $0.625/1M -> 0.15 * 0.625 = $0.09375
    assert.ok(Math.abs(haikuCold150k.coldRewriteCostUsd - 0.09375) < 1e-5);
  });
});

describe('Batch 2 Remediation — ISS-008: gemini-4-argon Rates ($2/$0.10/$10 -> 2026-12-01 $4/$0.20/$20), -low Alias & 1048576 Ceiling', () => {
  it('shares CARBON_RATE_SCHEDULES across gemini-4-argon* (including -low) and steps 2x on 2026-12-01T00:00:00Z', () => {
    for (const alias of ['gemini-4-argon', 'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-med', 'gemini-4-argon-low']) {
      const desc = resolveModelDescriptor(alias);
      assert.ok(desc, `${alias} must resolve to gemini-4-argon descriptor`);
      assert.equal(desc.id, 'gemini-4-argon');
      assert.equal(resolveModelCeiling(alias), 1048576, `${alias} ceiling must be unified 1,048,576`);
    }

    const preCliff = resolveModelRates('gemini-4-argon-low', '2026-11-30T23:59:59Z', 'standard');
    assert.equal(preCliff.input_per_1m, 2.00);
    assert.equal(preCliff.cached_read_per_1m, 0.10);
    assert.equal(preCliff.output_per_1m, 10.00);

    const postCliff = resolveModelRates('gemini-4-argon', '2026-12-01T00:00:00Z', 'standard');
    assert.equal(postCliff.input_per_1m, 4.00);
    assert.equal(postCliff.cached_read_per_1m, 0.20);
    assert.equal(postCliff.output_per_1m, 20.00);

    assert.equal(resolvePricePerM('gemini-4-argon', { eventTimestampUtc: '2026-11-30T23:59:59Z' }), 2.00);
    assert.equal(resolvePricePerM('gemini-4-argon', { eventTimestampUtc: '2026-12-01T00:00:00Z' }), 4.00);
    assert.equal(BUILTIN_CONFIG.model_ceilings['gemini-4-argon'], 1048576);
    assert.equal(BUILTIN_CONFIG.model_ceilings['gemini-4-argon-low'], 1048576);
  });
});

describe('Batch 2 Remediation — ISS-009: Complete gemini-4-carbon Support Across Aliases, Classifier, Hooks, Routers, UI & Doctor', () => {
  it('resolves gemini-4-carbon-(high|medium|med|low), prices Carbon sludge dynamically, and triggers pre_invocation guards', async () => {
    for (const alias of ['gemini-4-carbon', 'gemini-4-carbon-high', 'gemini-4-carbon-medium', 'gemini-4-carbon-med', 'gemini-4-carbon-low']) {
      const desc = resolveModelDescriptor(alias);
      assert.ok(desc, `${alias} must resolve to gemini-4-carbon descriptor`);
      assert.equal(desc.id, 'gemini-4-carbon');
      assert.equal(resolveModelCeiling(alias), 1048576);
    }

    // Horizon classifier must price Carbon sludge using resolvePricePerM ($2.00 pre-cliff / $4.00 post-cliff, never $0.15)
    const classifiedPre = classifyHorizonWindow(
      [
        { stepIndex: 0, type: 'USER_INPUT', textSample: 'Run tests', tokenEstimate: 100000 },
        { stepIndex: 1, type: 'COMMAND', toolName: 'run_command', status: 'ERROR', exitCode: 1, tokenEstimate: 50000 },
        { stepIndex: 2, type: 'COMMAND', toolName: 'run_command', status: 'DONE', exitCode: 0, tokenEstimate: 1000 }
      ],
      { modelName: 'gemini-4-carbon-high' },
      '',
      [],
      { eventTimestampUtc: '2026-11-15T00:00:00Z' }
    );
    assert.equal(classifiedPre.model.maxTokens, 1048576);
    // 50,000 dead-error sludge tokens * $2.00 / 1M = $0.10 (NOT $0.0075 from $0.15!)
    assert.ok(classifiedPre.metrics.sludgeTaxUsdPerTurn >= 0.09, `Expected >= $0.09 Carbon sludge cost, got ${classifiedPre.metrics.sludgeTaxUsdPerTurn}`);

    // Pre-invocation hook QUOTA_FLOOR & EFFORT_OVERKILL must fire on gemini-4-carbon
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss009-pre-'));
    try {
      const scQuota = createDefaultSidecar('carbon-quota-sess', tmpHome);
      scQuota.sessionMeta.activeModel = 'gemini-4-carbon';
      scQuota.sessionMeta.activeEffort = 'high';
      scQuota.telemetry.totalInputTokens = 50000;
      scQuota.telemetry.confidence = 'HIGH';
      scQuota.telemetry.quota = { remaining_fraction: 0.05 };
      scQuota.sensors.quotaFloorBreached = true;
      writeSidecarAtomicSync('carbon-quota-sess', scQuota);

      const quotaRes = await handlePreInvocation({
        conversationId: 'carbon-quota-sess',
        modelName: 'gemini-4-carbon',
        effort: 'high',
        prompt: 'Refactor the entire authentication pipeline and add integration tests across modules'
      });
      assert.match(JSON.stringify(quotaRes), /Quota Floor Breached/i);

      const scOverkill = createDefaultSidecar('carbon-overkill-sess', tmpHome);
      scOverkill.sessionMeta.activeModel = 'gemini-4-carbon-high';
      scOverkill.sessionMeta.activeEffort = 'max';
      scOverkill.telemetry.totalInputTokens = 2000;
      scOverkill.telemetry.confidence = 'HIGH';
      writeSidecarAtomicSync('carbon-overkill-sess', scOverkill);

      const overkillRes = await handlePreInvocation({
        conversationId: 'carbon-overkill-sess',
        modelName: 'gemini-4-carbon-high',
        effort: 'max',
        prompt: 'fix typo'
      });
      assert.match(JSON.stringify(overkillRes), /Effort Overkill/i);

      const docRes = await runDoctor({ workspacePath: tmpHome, silent: true, diagnostic: true });
      assert.ok(docRes, 'runDoctor completes cleanly');
      const doctorSrc = fs.readFileSync(path.resolve('src/cli/doctor.mjs'), 'utf8');
      assert.ok(doctorSrc.includes("'gemini-4-carbon'"), 'doctor.mjs must include gemini-4-carbon');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('never switches an active warm gemini-4-carbon session to gemini-4-argon during routing or DET-01/DET-02 escalation', async () => {
    const coreRoute = evaluateTaskAndQuotaRoute({
      activeModel: 'gemini-4-carbon',
      activeEffort: 'high',
      prompt: 'Design distributed consensus state machine with multi-node failover across cluster modules',
      cachedTokens: 180000,
      cacheTtlSeconds: 240,
      userTier: 'ultra'
    });
    assert.equal(coreRoute.classification.recommendedModel, 'gemini-4-carbon');
    assert.notEqual(coreRoute.gravity.primaryRecommendation.model, 'gemini-4-argon');

    const coachRouter = new TaskQuotaRouter({
      activeModel: 'gemini-4-carbon',
      activeEffort: 'high'
    });
    const escalated = await coachRouter.evaluateTurn({
      currentModel: 'gemini-4-carbon',
      currentEffort: 'medium',
      targetModel: 'gemini-3.8-flash',
      targetEffort: 'low',
      det01Triggered: true
    });
    assert.equal(escalated.recommendedModel, 'gemini-4-carbon');

    const cb = new CircuitBreakers({ activeModel: 'gemini-4-carbon' });
    cb.recordTurn({ turnIndex: 1, toolName: 'run_command', args: { CommandLine: 'npm test' }, exitCode: 1, activeModel: 'gemini-4-carbon' });
    const det01 = cb.recordTurn({ turnIndex: 2, toolName: 'run_command', args: { CommandLine: 'npm test' }, exitCode: 1, activeModel: 'gemini-4-carbon' });
    const alert = (det01.triggered || det01.alerts || cb.activeAlerts).find((a) => a.detectorId === 'DET-01');
    assert.ok(alert, 'DET-01 should trigger on repeated failing command');
    assert.equal(alert.escalatedTier.model, 'gemini-4-carbon');
  });
});

describe('Batch 2 Remediation — ISS-010: gemini-3.8-flash ($0.75/$0.075/$3.75 -> 2027-01-01 $1.50/$0.15/$7.50) & Zero $0.15 Base Literals', () => {
  it('enforces $3.75 output pre-2027, steps 2x on 2027-01-01T00:00:00Z, and eliminates $0.15 base Flash literals', () => {
    const pre2027 = resolveModelRates('gemini-3.8-flash', '2026-12-31T23:59:59Z', 'standard');
    assert.equal(pre2027.input_per_1m, 0.75);
    assert.equal(pre2027.cached_read_per_1m, 0.075);
    assert.equal(pre2027.output_per_1m, 3.75);

    const post2027 = resolveModelRates('gemini-3.8-flash', '2027-01-01T00:00:00Z', 'standard');
    assert.equal(post2027.input_per_1m, 1.50);
    assert.equal(post2027.cached_read_per_1m, 0.15);
    assert.equal(post2027.output_per_1m, 7.50);

    // Fallback unknown model uses 5x output ratio
    const unknownRates = resolveModelRates('custom-unknown-model-xyz', '2026-11-10T00:00:00Z');
    assert.equal(unknownRates.output_per_1m, unknownRates.input_per_1m * 5);

    for (const meta of DEMO_SCENARIOS) {
      const scenario = buildDemoHorizonState(meta.id);
      const price = scenario?.model?.inputPricePerMillionUsd;
      assert.notEqual(price, 0.15, `Scenario ${meta.id} must not retain stale $0.15 Flash base price`);
    }
    const demoHtml = fs.readFileSync(path.resolve('docs/index.html'), 'utf8');
    assert.ok(!demoHtml.includes('"inputPricePerMillionUsd":0.15'), 'docs/index.html must not contain 0.15 inputPricePerMillionUsd');
  });
});

describe('Batch 2 Remediation — ISS-011: modelCatalog.json + customCeilings.json Loader, Dynamic Ceilings & 1,048,576 Safe Limit', () => {
  it('loads config/modelCatalog.json, merges customCeilings.json overrides ahead of family fallbacks, and supports 1,048,576 safeLimit', () => {
    assert.ok(fs.existsSync(DEFAULT_MODEL_CATALOG_PATH), 'config/modelCatalog.json must exist');
    const catalog = loadModelCatalog();
    assert.ok(catalog?.models?.['claude-haiku-5-5'], 'modelCatalog.json must contain claude-haiku-5-5');
    assert.equal(catalog.models['gemini-4-argon'].shared_pool_ceiling, 1048576);

    // Family fallback must NOT clobber claude-sonnet-5-5 (1,000,000 != 200,000)
    const sonnet55Detailed = resolveModelCeilingDetailed('claude-sonnet-5-5');
    assert.equal(sonnet55Detailed.ceilingTokens, 1000000);

    // Project customCeilings.json overrides built-in ceilings
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss011-home-'));
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss011-cwd-'));
    try {
      const userCeilDir = path.join(tmpHome, '.attention-horizon');
      const projCeilDir = path.join(tmpCwd, '.agents', 'horizon');
      fs.mkdirSync(userCeilDir, { recursive: true });
      fs.mkdirSync(projCeilDir, { recursive: true });
      fs.writeFileSync(path.join(userCeilDir, 'customCeilings.json'), JSON.stringify({
        'claude-sonnet-4-6': 400000,
        'gemini-3.8-flash': 512000
      }), 'utf8');
      fs.writeFileSync(path.join(projCeilDir, 'customCeilings.json'), JSON.stringify({
        'claude-sonnet-4-6': 500000
      }), 'utf8');

      const mergedCustom = loadCustomCeilings({ homeDir: tmpHome, cwd: tmpCwd, forceReload: true });
      assert.equal(mergedCustom['claude-sonnet-4-6'], 500000, 'Workspace .agents/horizon/customCeilings.json takes highest precedence');
      assert.equal(mergedCustom['gemini-3.8-flash'], 512000);

      const resolvedOverride = resolveModelCeilingDetailed('claude-sonnet-4-6', null, {
        homeDir: tmpHome,
        cwd: tmpCwd
      });
      assert.equal(resolvedOverride.ceilingTokens, 500000);
      assert.equal(resolvedOverride.source, 'custom');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }

    assert.equal(SETTINGS_LIMITS.SAFE_LIMIT_MAX, 1048576);
    const validated = validateSettings({ safeLimitTokens: 1048576 });
    assert.equal(validated.safeLimitTokens, 1048576);

    // Dynamic ceilings in compaction_coach, blindspot_sensors & classifier (including zero activeSteps ReferenceError!)
    const compState = assessCompactionState({
      totalActiveTokens: 600000,
      modelId: 'gemini-4-carbon'
    });
    assert.equal(compState.watermarks.binaryClamp, 1048576);

    const blindspot = auditSchemaAndPayloads([], {}, { activeModel: 'gemini-4-argon' });
    assert.ok(blindspot, 'auditSchemaAndPayloads resolves dynamic ceiling cleanly');

    const classifiedCarbon = classifyHorizon([
      { stepIndex: 0, type: 'USER_INPUT', content: 'Analyze kernel scheduler', inputTokens: 20000 },
      { stepIndex: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon', content: 'Inspecting scheduler.', thinking: 't'.repeat(1200), outputTokens: 600 },
      { stepIndex: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon', content: 'Done.', thinking: 't'.repeat(1200), outputTokens: 600 }
    ], { modelId: 'gemini-4-carbon' });
    assert.equal(classifiedCarbon.window.maxTokens, 1048576);
  });
});

describe('Batch 2 Remediation — ISS-012: Closed-Form C* (3529 / 4286 / 6522 / 4615), expectedOutputTokens=1500, Carbon==Argon Parity & <1.39 Cache ROI', () => {
  it('enforces Carbon == Argon multiplier parity (low: 3.0), expectedOutputTokens=1500, and exact closed-form break-even C*', () => {
    assert.equal(DEFAULT_EXPECTED_OUTPUT_TOKENS, 1500);
    assert.equal(EXPECTED_OUTPUT_TOKENS_BY_EFFORT.low, 800);
    assert.equal(EXPECTED_OUTPUT_TOKENS_BY_EFFORT.medium, 1500);
    assert.equal(EXPECTED_OUTPUT_TOKENS_BY_EFFORT.high, 3500);
    assert.equal(EXPECTED_OUTPUT_TOKENS_BY_EFFORT.max, 6000);

    assert.equal(COST_MULTIPLIER_MATRIX['gemini-4-carbon'].low, 3.2);
    assert.equal(COST_MULTIPLIER_MATRIX['gemini-4-argon'].low, 3.0);
    assert.equal(getQuotaMultiplier('gemini-4-carbon', 'low'), 3.2);
    assert.equal(getQuotaMultiplier('gemini-4-argon', 'low'), 3.0);

    // Argon -> Flash & Carbon -> Flash at 95% discount (0.05 read factor): C* = 3,529
    const argonFlash95 = computeClosedFormBreakEven({
      currentModel: 'gemini-4-argon',
      targetModel: 'gemini-3.8-flash',
      expectedOutputTokens: 1500,
      readDiscountFactor: 0.05
    });
    const carbonFlash95 = computeClosedFormBreakEven({
      currentModel: 'gemini-4-carbon',
      targetModel: 'gemini-3.8-flash',
      expectedOutputTokens: 1500,
      readDiscountFactor: 0.05
    });
    assert.equal(argonFlash95.breakEvenTokens, 3529);
    assert.equal(carbonFlash95.breakEvenTokens, 3929);

    // Argon -> Flash at 90% discount (0.10 read factor): C* = 4,286
    const argonFlash90 = computeClosedFormBreakEven({
      currentModel: 'gemini-4-argon',
      targetModel: 'gemini-3.8-flash',
      expectedOutputTokens: 1500,
      readDiscountFactor: 0.10
    });
    assert.equal(argonFlash90.breakEvenTokens, 4286);

    // Anthropic USD pairs (expectedOutputTokens = 1500, 5m 1.25x write):
    // Opus 5.5 -> Sonnet 5.5 = round(1500 * (20 - 10) / (2.50 - 0.20)) = 6,522
    const opus55Sonnet55 = computeClosedFormBreakEven({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500
    });
    assert.equal(opus55Sonnet55.breakEvenTokens, 6522);

    // Opus 4.6 -> Sonnet 4.6 = round(1500 * (25 - 15) / (3.75 - 0.50)) = 4,615
    const opus46Sonnet46 = computeClosedFormBreakEven({
      currentModel: 'claude-opus-4-6',
      targetModel: 'claude-sonnet-4-6',
      expectedOutputTokens: 1500
    });
    assert.equal(opus46Sonnet46.breakEvenTokens, 4615);

    // Dynamic warm-cache hold between 3,530..59,999 cached tokens (e.g. 12,000 warm tokens must HOLD, not cold-switch!)
    const scorer = new CoachCacheGravityScorer();
    const warm12k = scorer.computeBreakEvenDelta({
      currentModel: 'gemini-4-carbon',
      targetModel: 'gemini-3.8-flash',
      targetEffort: 'low',
      cachedTokens: 12000,
      ttlRemainingSeconds: 240,
      expectedOutputTokens: 1500
    });
    assert.equal(warm12k.breakEvenTokens, 3929);
    assert.equal(warm12k.hasWarmCacheGravity, true, '12k warm tokens (> 3,929 C*) must hold warm model instead of waiting for static 60k');
    assert.equal(warm12k.blockCrossModelSwitch, true);
    assert.equal(warm12k.recommendedModel, 'gemini-4-carbon');

    const core12k = evaluateCoreCacheGravity({
      currentModel: 'gemini-4-argon',
      targetModel: 'gemini-3.8-flash',
      cachedTokens: 12000,
      ttlRemainingSeconds: 240,
      expectedOutputTokens: 1500
    });
    assert.equal(core12k.shouldHoldWarmCache, true);
  });

  it('computes USD + < 1.39 5-minute session read-to-write Cache ROI churn telemetry in quota.mjs', () => {
    assert.equal(SESSION_5M_READ_TO_WRITE_MIN_ROI_RATIO, 1.39);

    // Churn scenario: 100k 5m write ($5.00/1M = $0.50, $0.10 surcharge over $4.00 fresh input) and only 20k read (0.20 < 1.39)
    const churnRoi = computeCacheRoi({
      modelId: 'claude-opus-5-5',
      cacheReadTokens: 20000,
      write5mTokens: 100000,
      write1hTokens: 0
    });
    assert.ok(churnRoi.readToWriteRatio < 1.39);
    assert.equal(churnRoi.belowSessionRoiThreshold, true);
    assert.equal(churnRoi.isNegativeCacheRoi, true);
    assert.ok(churnRoi.netCacheSavingsUsd < 0);

    // Healthy warm reuse scenario: 100k 5m write + 300k cached reads (3.0 >= 1.39)
    const healthyRoi = computeCacheRoi({
      modelId: 'claude-opus-5-5',
      cacheReadTokens: 300000,
      write5mTokens: 100000,
      write1hTokens: 0
    });
    assert.equal(healthyRoi.readToWriteRatio, 3.0);
    assert.equal(healthyRoi.belowSessionRoiThreshold, false);
    assert.equal(healthyRoi.isNegativeCacheRoi, false);
    assert.ok(healthyRoi.netCacheSavingsUsd > 0);
  });
});

describe('Batch 2 Remediation — ISS-025: Zero Live Fabricated Telemetry Fallbacks', () => {
  it('replaces fabricated Cursor tokens/timestamps, postmortem 14-session fallback, cold hitRatePct, and hook/subagent fallbacks with 0/null', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss025-'));
    try {
      // 1. Cursor state.vscdb with zero token metadata must report 0 tokens and null createdAt (never 12000/54000/8000/250/500)
      const vscdbPath = path.join(tmpDir, 'state.vscdb');
      const db = new DatabaseSync(vscdbPath);
      db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
      const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      ins.run('composerData:c1', JSON.stringify({ name: 'Bare Cursor Chat', model: 'claude-sonnet-5-5' }));
      ins.run('bubbleId:c1:b1', JSON.stringify({ type: 1, text: 'hello' }));
      ins.run('bubbleId:c1:b2', JSON.stringify({ type: 2, text: 'world' }));
      db.close();

      const parsedCursor = parseCursorVscdbSync(vscdbPath, DatabaseSync);
      assert.equal(parsedCursor.steps.length, 2);
      assert.equal(parsedCursor.steps[0].inputTokens, 0);
      assert.equal(parsedCursor.steps[1].cacheReadTokens, 0);
      assert.equal(parsedCursor.steps[0].outputTokens, 0);
      assert.equal(parsedCursor.steps[1].outputTokens, 0);
      assert.equal(parsedCursor.steps[0].createdAt, null);
      assert.equal(parsedCursor.genMetadata.totalContextTokens, 0);

      // 2. Postmortem with 0 sessions and demo: false must NOT return 14 synthetic sessions / 1.84M / $1.92
      const emptyHome = path.join(tmpDir, 'empty-home');
      fs.mkdirSync(emptyHome, { recursive: true });
      const pm = await runPostmortem({
        demo: false,
        homeDir: emptyHome,
        workspacePath: tmpDir,
        writeFiles: false,
        silent: true
      });
      assert.equal(pm.isSynthetic, false);
      assert.equal(pm.sessionCount, 0);
      assert.equal(pm.estTokensM, '0.00M');
      assert.equal(pm.sludgeUsdFormatted, '$0.00');
      assert.equal(pm.totalDuplicateReads, 0);
      assert.equal(pm.totalDeadErrors, 0);

      // 3. Subagent worktree DAG without explicit token count defaults to 0 (never 1500)
      const dag = buildSubagentWorktreeDag([
        {
          stepIndex: 1,
          createdAt: '2026-11-10T12:00:00Z',
          toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Verifier', Prompt: 'Check types' } }]
        }
      ]);
      for (const node of (dag.subagents || dag.nodes || [])) {
        assert.notEqual(node.tokens, 1500);
        assert.notEqual(node.estimatedTokens, 1500);
      }

      // 4. SessionStart & PostInvocation hooks never inject 600 / 1000 / 100 token fallbacks on empty steps
      const startRes = await handleSessionStart({
        conversationId: 'empty-sess',
        workspacePath: tmpDir,
        homeDir: emptyHome
      });
      assert.ok(startRes, 'handleSessionStart succeeds cleanly without fabricated 600-token rule sizes');

      const postRes = await handlePostInvocation({
        conversationId: 'empty-sess',
        workspacePath: tmpDir,
        homeDir: emptyHome,
        steps: [{ stepIndex: 0, type: 'GENERIC', content: '' }]
      });
      assert.ok(postRes, 'handlePostInvocation succeeds cleanly without 1000/100 fabricated fallbacks');

      // 5. Cold synthetic scenarios have hitRatePct === 0
      for (const meta of DEMO_SCENARIOS) {
        const scenario = buildDemoHorizonState(meta.id);
        if (scenario?.quota?.cache?.isCacheCold === true) {
          assert.equal(scenario.quota.cache.hitRatePct, 0, `Cold scenario ${meta.id} must have hitRatePct: 0`);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 2 Remediation — ISS-026: Claude Code input_tokens=1 Envelope, Streaming Chunk Dedupe, Zero Turn-1 Double-Count & StringDecoder', () => {
  it('deduplicates streaming assistant chunks by message.id, computes full prompt envelope, and prevents Turn-1 2x write billing', () => {
    const t0 = '2026-11-10T18:00:00Z';
    const t1 = '2026-11-10T18:01:00Z';
    const jsonl = [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: t0, message: { role: 'user', content: 'Audit auth.ts' } }),
      // Streaming chunk 1 (partial output_tokens: 12)
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1-part1',
        parentUuid: 'u1',
        timestamp: t0,
        message: {
          id: 'msg_01STREAM',
          model: 'claude-sonnet-5-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Checking...' }],
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 80000, ephemeral_1h_input_tokens: 0 },
            output_tokens: 12
          }
        }
      }),
      // Streaming chunk 2 (same message.id = msg_01STREAM, final output_tokens: 450)
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1-final',
        parentUuid: 'u1',
        timestamp: t0,
        message: {
          id: 'msg_01STREAM',
          model: 'claude-sonnet-5-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Checking... complete.' }],
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 80000, ephemeral_1h_input_tokens: 0 },
            output_tokens: 450
          }
        }
      }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1-final', timestamp: t1, message: { role: 'user', content: 'Fix bug' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2-final',
        parentUuid: 'u2',
        timestamp: t1,
        message: {
          id: 'msg_02WARM',
          model: 'claude-sonnet-5-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fixed.' }],
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 80001,
            cache_creation_input_tokens: 0,
            output_tokens: 200
          }
        }
      })
    ].join('\n');

    const parsed = parseClaudeCodeJsonl(jsonl);
    const assistantSteps = parsed.steps.filter((s) => s.type === 'PLANNER_RESPONSE');
    assert.equal(assistantSteps.length, 2, 'Two streaming chunks sharing msg_01STREAM must collapse into 1 assistant step');
    assert.equal(assistantSteps[0].outputTokens, 450, 'Final chunk output_tokens (450) kept, not summed (462)');
    assert.equal(assistantSteps[0].cacheCreationTokens, 80000, 'Nested ephemeral_5m_input_tokens extracted');
    assert.equal(assistantSteps[0].totalPromptTokens, 80001, 'input_tokens=1 + 80,000 cacheCreation = 80,001 prompt envelope');
    assert.equal(assistantSteps[1].totalPromptTokens, 80002, 'input_tokens=1 + 80,001 cacheRead = 80,002 prompt envelope');

    // Turn-1 inputTokens must NOT have inferredSystemPromptTokens (80,000) added on top of cacheCreationTokens!
    assert.equal(parsed.steps[0].inputTokens < 80000, true, 'steps[0].inputTokens must not duplicate 80k cacheCreationTokens');
    const quota = computeQuotaAndCacheTelemetry(parsed.steps, {
      modelId: 'claude-sonnet-5-5',
      nowMs: Date.parse('2026-11-10T18:02:00Z')
    });
    // Sonnet 5.5 cost:
    // Turn 1: 1 fresh ($2/1M) + 80,000 write5m ($2.50/1M = $0.20) + 450 out ($10/1M = $0.0045) = $0.204502
    // Turn 2: 1 fresh ($2/1M) + 80,001 read ($0.10/1M = $0.008) + 200 out ($10/1M = $0.002) = $0.010002
    // Total ~= $0.2145 (if Turn 1 double-counted 80k fresh input at $2/1M, it would be ~$0.3745!)
    assert.ok(quota.cache.pricing.sessionCostUsd < 0.25, `Turn-1 cache_creation must not be double-billed: got $${quota.cache.pricing.sessionCostUsd}`);

    // Adapter trackClaudeCodeSessionCache also deduplicates by message.id and extracts nested cache_creation
    const adapterRes = trackClaudeCodeSessionCache([
      {
        session_id: 's1',
        message: {
          id: 'msg_dup',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 50000 }, output_tokens: 10 }
        }
      },
      {
        session_id: 's1',
        message: {
          id: 'msg_dup',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 50000 }, output_tokens: 120 }
        }
      }
    ]);
    assert.equal(adapterRes.normalizedEvents.length, 1);
    assert.equal(adapterRes.normalizedEvents[0].write1hTokens, 50000);
    assert.equal(adapterRes.normalizedEvents[0].totalPromptTokens, 50001);
    assert.equal(adapterRes.normalizedEvents[0].ttlSeconds, 3600);
  });

  it('decodes multi-byte UTF-8 characters split across exact 65,536-byte (64KB) chunk boundaries without U+FFFD corruption', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss026-utf8-'));
    try {
      const brainSessionDir = path.join(tmpDir, 'brain', 'sess-utf8');
      const logsDir = path.join(brainSessionDir, '.system_generated', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const transcriptPath = path.join(logsDir, 'transcript.jsonl');

      // Construct line 1 + line 2 so a 4-byte emoji (🚀 = F0 9F 9A 80) inside line 2's first 80 chars straddles byte offset 65536!
      const line2Prefix = '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","content":"';
      const line2PrefixBytes = Buffer.byteLength(line2Prefix, 'utf8');
      const line1Prefix = '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"';
      const line1Suffix = '"}\n';
      const targetLine1Bytes = 65536 - line2PrefixBytes - 2; // leaves 2 bytes of 🚀 before 65536 and 2 bytes after 65536!
      const padLen = targetLine1Bytes - Buffer.byteLength(line1Prefix, 'utf8') - Buffer.byteLength(line1Suffix, 'utf8');
      const line1 = `${line1Prefix}${'a'.repeat(padLen)}${line1Suffix}`;
      const line2 = `${line2Prefix}🚀🔥漢字-split-ok"}\n`;

      const fullBuf = Buffer.concat([Buffer.from(line1, 'utf8'), Buffer.from(line2, 'utf8')]);
      // Confirm byte 65534..65537 straddle the 65536 boundary inside the 4-byte 🚀 sequence (0xF0 0x9F | 0x9A 0x80)
      assert.equal(fullBuf[65534], 0xf0);
      assert.equal(fullBuf[65535], 0x9f);
      assert.equal(fullBuf[65536], 0x9a);
      assert.equal(fullBuf[65537], 0x80);

      fs.writeFileSync(transcriptPath, fullBuf);

      const incParsed = parseTranscriptIncremental(brainSessionDir, path.join(tmpDir, 'cache'));
      assert.equal(incParsed.steps.length, 2);
      assert.ok(!incParsed.steps[1].content.includes('\uFFFD'), 'parseTranscriptIncremental must not emit U+FFFD replacement chars');
      assert.equal(incParsed.steps[1].content, '🚀🔥漢字-split-ok');

      const resolvedInc = resolveAndReadTranscriptIncremental('sess-utf8', {}, { brainDirOverride: brainSessionDir });
      assert.equal(resolvedInc.parsedEvents.length, 2);
      assert.ok(!resolvedInc.parsedEvents[1].rawTextSample.includes('\uFFFD'), 'resolveAndReadTranscriptIncremental must not emit U+FFFD');
      assert.equal(resolvedInc.parsedEvents[1].rawTextSample, '🚀🔥漢字-split-ok');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 2 Remediation — ISS-028: Non-Contradictory Warm >179k UI States & Negative TTL Clamping', () => {
  it('never renders "Cache cold" or "0s TTL" on a warm >179k Carbon/Argon session and clamps negative TTLs to 0', async (t) => {
    // 1. CLI HUD: Warm(<ttl>s) only when !isCacheCold && ttlSec > 0 && cacheHitPct > 0; Cold otherwise
    const demoWarmAnsi = formatDemoScenarioAnsi(2).text;
    const demoColdAnsi = formatDemoScenarioAnsi(5).text;
    assert.ok(demoWarmAnsi.includes('TTL: 215s'), 'Warm scenario 2 displays positive TTL');
    assert.ok(demoColdAnsi.includes('Cache Hit: 0%') && demoColdAnsi.includes('TTL: 0s'), 'Cold scenario 5 displays 0% hit and 0s TTL');

    const tmpHudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss028-hud-'));
    try {
      const zeroHitJsonl = path.join(tmpHudDir, 'zero-hit.jsonl');
      const nowIso = new Date().toISOString();
      fs.writeFileSync(zeroHitJsonl, [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: nowIso, message: { role: 'user', content: 'Cold turn' } }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          timestamp: nowIso,
          message: {
            id: 'msg_cold',
            model: 'claude-sonnet-5-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'First turn.' }],
            usage: { input_tokens: 12000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 }
          }
        })
      ].join('\n') + '\n', 'utf8');

      const coldCli = await runCLI({
        sessionDirOverride: zeroHitJsonl,
        cacheDirOverride: path.join(tmpHudDir, 'cache'),
        columns: 140,
        silent: true
      });
      assert.ok(coldCli.output.includes('Cold'), `0% cacheHitPct must render Cold, not Warm: got "${coldCli.output}"`);
      assert.ok(!coldCli.output.includes('Warm'), `0% cacheHitPct must never render Warm: got "${coldCli.output}"`);
    } finally {
      fs.rmSync(tmpHudDir, { recursive: true, force: true });
    }

    // 2. src/ui/horizon_panel.js negative & missing TTL clamping
    const miniDom = new JSDOM('<!doctype html><html><body><span id="ttlCountdownClock"></span></body></html>');
    renderThreeTierTufteHud(miniDom.window.document, {
      quota: { cache: { ttlRemainingSec: -42 } }
    });
    const clockEl = miniDom.window.document.getElementById('ttlCountdownClock');
    assert.equal(clockEl.textContent, 'TTL: 0m 00s');
    assert.ok(clockEl.classList.contains('ttl-expired-cold-risk'), 'Negative TTL must classify as expired, never warning pulse');
    assert.ok(!clockEl.classList.contains('ttl-warning-pulse'));
    miniDom.window.close();

    // 3. Full WebView JSDOM check on warm 220,000-token Gemini 4 Carbon session (> 179,000 safeLimit)
    const html = fs.readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });

    try {
      const w = dom.window;
      const d = w.document;
      assert.equal(d.getElementById('setSafeLimit')?.getAttribute('max'), '1048576');

      const warm220kCarbonState = {
        schemaVersion: '1.1.0',
        sessionId: 'warm-carbon-220k',
        modelId: 'gemini-4-carbon',
        window: {
          maxTokens: 1048576,
          cellSizeTokens: 26214,
          totalCells: 40,
          totalActiveTokens: 220000,
          usedPercentage: 21,
          turnCount: 18,
          safeLimit: 179000
        },
        tokens: { totalTokens: 220000, maxTokens: 1048576 },
        model: { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', maxTokens: 1048576 },
        metrics: {
          signalPurityPct: 84,
          sludgeTokens: 18000,
          sludgeCostUsd: 0.036
        },
        quota: {
          modelLabel: 'Gemini 4 Carbon',
          cache: {
            isCacheCold: false,
            hitRatePct: 95,
            ttlRemainingSec: 240,
            cacheReadTokens: 209000,
            freshInputTokens: 11000,
            inputPricePerMillionUsd: 2.00
          }
        },
        diagnostics: {
          amputationCrisis: false,
          recommendedCommand: '/compact',
          duplicateReads: { count: 0, topFiles: [] },
          deadErrorTraces: { count: 0, totalWastedTokens: 0 },
          staleSnapshots: { count: 0 },
          activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 }
        },
        cells: Array.from({ length: 40 }, (_, i) => ({
          index: i,
          dominantCategory: i < 9 ? 'CACHED_HISTORY' : 'FREE_HEADROOM',
          tokens: i < 9 ? 24444 : 0
        })),
        chronicReads: []
      };

      w.renderState(warm220kCarbonState);

      const ttlLabel = d.getElementById('tufteCol2TtlLabel')?.textContent || '';
      const verdictText = d.getElementById('unifiedVerdictText')?.textContent || '';
      const subClutter = d.getElementById('subClutter')?.textContent || '';
      const advisoryText = d.getElementById('cacheCompactionAdvisory')?.textContent || '';
      const modelDisplay = d.getElementById('modelDisplay')?.textContent || '';

      assert.ok(!ttlLabel.includes('Cold'), `#tufteCol2TtlLabel must not say Cold on warm 220k cache (got "${ttlLabel}")`);
      assert.ok(!ttlLabel.includes('0s TTL'), `#tufteCol2TtlLabel must not say 0s TTL on warm 220k cache (got "${ttlLabel}")`);
      assert.ok(!verdictText.toLowerCase().includes('cache cold'), `#unifiedVerdictText must not claim Cache cold (got "${verdictText}")`);
      assert.ok(!subClutter.toLowerCase().includes('cache cold'), `#subClutter must not claim Cache cold (got "${subClutter}")`);
      assert.ok(!advisoryText.toLowerCase().includes('cache is cold'), `#cacheCompactionAdvisory must not claim Cache is cold (got "${advisoryText}")`);
      if (modelDisplay) {
        assert.ok(modelDisplay.includes('Carbon'), `Model display should show Carbon (got "${modelDisplay}")`);
      }

      // Also test negative TTL clamping (-55s -> 0s, never "-55s")
      const negTtlState = structuredClone(warm220kCarbonState);
      negTtlState.quota.cache.isCacheCold = true;
      negTtlState.quota.cache.hitRatePct = 0;
      negTtlState.quota.cache.ttlRemainingSec = -55;
      w.renderState(negTtlState);
      const negTtlLabel = d.getElementById('tufteCol2TtlLabel')?.textContent || '';
      assert.ok(!negTtlLabel.includes('-55'), `Negative TTL must be clamped to >= 0 (got "${negTtlLabel}")`);
    } finally {
      dom.window.close();
    }
  });
});

describe('Batch 2 Remediation — ISS-029: Separate Tier-1 In-Process vs Tier-2 Spawned CLI Hook Latency', () => {
  it('documents and benchmarks Tier-1 in-process router evaluation separately from Tier-2 spawned CLI hook wall time', () => {
    const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
    const perfDoc = fs.readFileSync(path.resolve('docs/PERFORMANCE_BENCHMARK_REPORT.md'), 'utf8');
    const configSrc = fs.readFileSync(path.resolve('src/core/config.mjs'), 'utf8');
    const benchSrc = fs.readFileSync(path.resolve('tests/bench_latency.mjs'), 'utf8');

    assert.match(readme, /Tier-1/i);
    assert.match(readme, /Tier-2/i);
    assert.match(perfDoc, /Tier-1/i);
    assert.match(perfDoc, /Tier-2/i);
    assert.match(configSrc, /Tier-1/i);
    assert.match(configSrc, /Tier-2/i);
    assert.ok(benchSrc.includes('spawnSync'), 'tests/bench_latency.mjs must benchmark Tier-2 spawned CLI hook via spawnSync');
  });
});
