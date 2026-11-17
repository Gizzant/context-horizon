#!/usr/bin/env node
/**
 * Generates and SHA-256-locks `results/preregistration_cost_per_task_hard.json` ($0.00 live spend)
 * as a SEPARATE pre-registered study for `H01–H06` ("hard tier"),
 * and computes the grounded Hard-Tier Pilot (18 runs) + Reps 2-3 (36 runs) + Full (54 runs) Cost Estimate.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  RESULTS_DIR,
  PINNED_CLAUDE_CODE_VERSION,
  PRICING_PER_1M,
  loadOpenRouterApiKey
} from '../../config.mjs';
import {
  HARD_TASKS,
  TURN1_PLAN_PREFIX,
  TURN2_IMPLEMENT_PROMPT,
  RETRY_PROMPT_HEADER
} from './hard_tasks_manifest.mjs';
import { buildRandomizedSchedule } from '../run_cost_per_task.mjs';
import { resolveCptCaps } from '../cpt_proxy.mjs';
import { assertNoSensitiveLeaks } from '../../tests_3_to_8/prefix_lab.mjs';

const RAW_DIR = path.join(RESULTS_DIR, 'cost_per_task_raw');
const PHASE0_PATH = path.join(RAW_DIR, 'phase0_mock_verification.json');
const STAGE1_REC_PATH = path.join(RAW_DIR, 'stage1_reconciliation.json');
const OFFLINE_VERIFY_PATH = path.join(RAW_DIR, 'offline_hard_task_verification.json');
const PREREG_OUT_PATH = path.join(RESULTS_DIR, 'preregistration_cost_per_task_hard.json');
const ESTIMATE_OUT_PATH = path.join(RAW_DIR, 'hard_tier_pilot_cost_estimate.json');

const RANDOM_SEED = 20261117;

function httpsGetKeyUsage(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/key',
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({
              timestampUtc: new Date().toISOString(),
              statusCode: res.statusCode,
              usage: j?.data?.usage ?? null,
              limit: j?.data?.limit ?? null,
              limitRemaining: j?.data?.limit_remaining ?? null
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Calibrated from observed Stage 1 Claude Code 2.1.325 wire prefixes
 * scaled for 30-60 minute multi-file H01-H06 tasks.
 */
function estimateHardRunCost({ arm, scenario = 'expected' }) {
  const opus = PRICING_PER_1M['anthropic/claude-opus-5.5'];
  const sonnet = PRICING_PER_1M['anthropic/claude-sonnet-5.5'];
  const planRate = arm === 'SONNET' ? sonnet : opus;
  const implRate = arm === 'OPUS' ? opus : sonnet;

  const profiles = {
    expected: {
      t1StartTok: 15_000,
      t1DeltaTok: 9_000,
      t1Reqs: 7,
      t1Out: 2_000,
      implReqs: 12,
      implDeltaTok: 13_000,
      implOut: 3_800,
      retryReqs: 6,
      retryDeltaTok: 5_000,
      retryOut: 1_800,
      avgRetries: { OPUS: 1.2, SONNET: 1.8, SWITCH: 1.4 }
    },
    stress: {
      t1StartTok: 16_000,
      t1DeltaTok: 11_000,
      t1Reqs: 9,
      t1Out: 2_600,
      implReqs: 16,
      implDeltaTok: 17_000,
      implOut: 5_500,
      retryReqs: 8,
      retryDeltaTok: 7_000,
      retryOut: 2_600,
      avgRetries: { OPUS: 2.4, SONNET: 2.8, SWITCH: 2.6 }
    }
  };

  const p = profiles[scenario];

  // Turn 1 (Plan mode): req 1 cold-writes ~t1StartTok; reqs 2..t1Reqs read growing prefix and write delta.
  const t1AvgPrefix = p.t1StartTok + p.t1DeltaTok * 0.5;
  const planWriteTok = p.t1StartTok + p.t1DeltaTok;
  const planReadTok = Math.max(0, p.t1Reqs - 1) * t1AvgPrefix;
  const planCostUsd =
    (planWriteTok / 1e6) * planRate.write5m +
    (planReadTok / 1e6) * planRate.read +
    (p.t1Out / 1e6) * planRate.output;

  // Turn 2 (Implementation): if SWITCH, req 1 cold-writes the full Turn-1 prefix on Sonnet!
  const t2StartCtx = p.t1StartTok + p.t1DeltaTok;
  const t2AvgPrefix = t2StartCtx + p.implDeltaTok * 0.5;
  const implWriteTok = arm === 'SWITCH' ? t2StartCtx + p.implDeltaTok : p.implDeltaTok;
  const implReadTok = arm === 'SWITCH' ? Math.max(0, p.implReqs - 1) * t2AvgPrefix : p.implReqs * t2AvgPrefix;
  const implTurnCostUsd =
    (implWriteTok / 1e6) * implRate.write5m +
    (implReadTok / 1e6) * implRate.read +
    (p.implOut / 1e6) * implRate.output;

  // Retries (up to 3 max)
  const endT2Ctx = t2StartCtx + p.implDeltaTok;
  const retryWriteTok = p.retryDeltaTok;
  const retryReadTok = p.retryReqs * (endT2Ctx + p.retryDeltaTok * 0.5);
  const perRetryCostUsd =
    (retryWriteTok / 1e6) * implRate.write5m +
    (retryReadTok / 1e6) * implRate.read +
    (p.retryOut / 1e6) * implRate.output;

  const retriesCostUsd = p.avgRetries[arm] * perRetryCostUsd;
  const implAndRetriesUsd = implTurnCostUsd + retriesCostUsd;
  const totalBaseUsd = planCostUsd + implAndRetriesUsd;

  return {
    planTurnPerRunUsd: Number(planCostUsd.toFixed(4)),
    implAndRetriesPerRunUsd: Number(implAndRetriesUsd.toFixed(4)),
    totalPerRunUsd: Number(totalBaseUsd.toFixed(4)),
    totalPerRunPlus15PctUsd: Number((totalBaseUsd * 1.15).toFixed(4))
  };
}

function buildHardCostEstimate(stage1Schedule, keySnapshot) {
  const arms = ['OPUS', 'SONNET', 'SWITCH'];
  const byArm = {};
  let pilotExpectedBase = 0;
  let pilotStressBase = 0;

  for (const arm of arms) {
    const pilotRuns = stage1Schedule.filter((r) => r.arm === arm).length;
    const exp = estimateHardRunCost({ arm, scenario: 'expected' });
    const str = estimateHardRunCost({ arm, scenario: 'stress' });
    pilotExpectedBase += pilotRuns * exp.totalPerRunUsd;
    pilotStressBase += pilotRuns * str.totalPerRunUsd;
    byArm[arm] = {
      pilotRuns,
      planTurnPerRunUsd: exp.planTurnPerRunUsd,
      implAndRetriesPerRunUsd: exp.implAndRetriesPerRunUsd,
      totalPerRunUsd: exp.totalPerRunUsd,
      pilotPlanTurnUsd: Number((pilotRuns * exp.planTurnPerRunUsd).toFixed(4)),
      pilotImplAndRetriesUsd: Number((pilotRuns * exp.implAndRetriesPerRunUsd).toFixed(4)),
      pilotTotalBaseUsd: Number((pilotRuns * exp.totalPerRunUsd).toFixed(4)),
      pilotTotalWith15PctUsd: Number((pilotRuns * exp.totalPerRunUsd * 1.15).toFixed(4)),
      stressPlanTurnPerRunUsd: str.planTurnPerRunUsd,
      stressImplAndRetriesPerRunUsd: str.implAndRetriesPerRunUsd,
      stressTotalPerRunUsd: str.totalPerRunUsd,
      stressPilotTotalBaseUsd: Number((pilotRuns * str.totalPerRunUsd).toFixed(4)),
      stressPilotTotalWith15PctUsd: Number((pilotRuns * str.totalPerRunUsd * 1.15).toFixed(4))
    };
  }

  const pilotExpPlus15 = Number((pilotExpectedBase * 1.15).toFixed(2));
  const pilotStrPlus15 = Number((pilotStressBase * 1.15).toFixed(2));
  const reps23ExpBase = Number((pilotExpectedBase * 2).toFixed(2));
  const reps23ExpPlus15 = Number((pilotExpPlus15 * 2).toFixed(2));
  const reps23StrPlus15 = Number((pilotStrPlus15 * 2).toFixed(2));
  const full54ExpPlus15 = Number((pilotExpPlus15 * 3).toFixed(2));
  const full54StrPlus15 = Number((pilotStrPlus15 * 3).toFixed(2));

  return {
    pricingBasis: '2026-11-16 OpenRouter live /api/v1/models (Opus 5.5 $4/$20/$5/$0.20, Sonnet 5.5 $2/$10/$2.5/$0.10)',
    calibrationBasis: 'Claude Code 2.1.325 Stage-1 routine wire prefixes (~15k start, multi-file H01-H06 diagnosis 7 reqs / +9k / 2k out, Turn-2 12 reqs / +13k / 3.8k out, avgRetries O=1.2 / S=1.8 / SW=1.4)',
    openRouterKeySnapshot: keySnapshot,
    byArmPilot6RunsEach: byArm,
    pilot18Runs: {
      expectedBaseUsd: Number(pilotExpectedBase.toFixed(2)),
      expectedWith15PctMarginUsd: pilotExpPlus15,
      stressBaseUsd: Number(pilotStressBase.toFixed(2)),
      stressWith15PctMarginUsd: pilotStrPlus15,
      hardAbortCeilingUsd: 18 * 3.0,
      fitsRemainingKeyCap: keySnapshot.limitRemaining !== null ? keySnapshot.limitRemaining >= pilotStrPlus15 : null
    },
    reps2And3_36Runs: {
      expectedBaseUsd: reps23ExpBase,
      expectedWith15PctMarginUsd: reps23ExpPlus15,
      stressWith15PctMarginUsd: reps23StrPlus15,
      hardAbortCeilingUsd: 36 * 3.0
    },
    fullHardStudy54Runs: {
      expectedWith15PctMarginUsd: full54ExpPlus15,
      stressWith15PctMarginUsd: full54StrPlus15,
      hardAbortCeilingUsd: 54 * 3.0
    }
  };
}

async function main() {
  assert.ok(fs.existsSync(PHASE0_PATH), `Missing ${PHASE0_PATH}`);
  assert.ok(fs.existsSync(STAGE1_REC_PATH), `Missing ${STAGE1_REC_PATH}`);
  assert.ok(fs.existsSync(OFFLINE_VERIFY_PATH), `Missing ${OFFLINE_VERIFY_PATH}`);

  const phase0 = JSON.parse(fs.readFileSync(PHASE0_PATH, 'utf8'));
  const stage1Rec = JSON.parse(fs.readFileSync(STAGE1_REC_PATH, 'utf8'));
  const offlineVerify = JSON.parse(fs.readFileSync(OFFLINE_VERIFY_PATH, 'utf8'));
  assert.equal(offlineVerify.tasksVerified.length, 6);
  assert.ok(offlineVerify.tasksVerified.every((r) => r.preFixVisibleExit !== 0 && r.preFixHiddenExit !== 0));
  assert.ok(offlineVerify.tasksVerified.every((r) => r.postFixVisibleExit === 0 && r.postFixHiddenExit === 0));

  const apiKey = loadOpenRouterApiKey();
  const keySnapshot = await httpsGetKeyUsage(apiKey);
  assert.equal(keySnapshot.statusCode, 200);

  const spendDeltaSinceStage1 = Number(
    ((keySnapshot.usage ?? 0) - (stage1Rec.usageAfterSettledUsd ?? 0)).toFixed(6)
  );
  assert.ok(
    Math.abs(spendDeltaSinceStage1) < 1e-6,
    `Expected $0.00 spend since Routine Stage 1 settled ($${stage1Rec.usageAfterSettledUsd}), got delta=$${spendDeltaSinceStage1} (usage=$${keySnapshot.usage})`
  );

  const schedules = buildRandomizedSchedule(RANDOM_SEED, HARD_TASKS);
  assert.equal(schedules.stage1.length, 18);
  assert.equal(schedules.stage2.length, 36);

  const caps = resolveCptCaps();
  const pilotEstimate = buildHardCostEstimate(schedules.stage1, keySnapshot);

  const now = new Date();
  const prereg = {
    schemaVersion: 'cost_per_task_hard_prereg_v1',
    studyId: 'cost_per_completed_task_hard_tier_v1',
    tierLabel: 'hard tier',
    lockedAtUtc: now.toISOString(),
    preregisteredAtUtc: now.toISOString(),
    preregisteredAtLocal: now.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T') + '-05:00',
    openRouterKeySnapshotAtLock: {
      ...keySnapshot,
      spendDeltaSinceRoutineStage1Usd: spendDeltaSinceStage1,
      hardTierLiveSpendPriorToLockUsd: 0
    },
    environment: {
      claudeCodeVersion: PINNED_CLAUDE_CODE_VERSION,
      route: 'OpenRouter (/api/v1/messages), provider.only=["anthropic"], allow_fallbacks=false',
      effort: 'medium',
      autoMemory: 'disabled (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, autoMemoryEnabled=false)',
      hooks: '{} (Highbeam disabled on wire; shadow runPreModelSwitchHook() evaluated offline on SWITCH)',
      toolsPinned: 'Read,Edit,Write,Bash,Grep,Glob',
      turnProtocolOptionA: {
        turn1Mode: 'plan (--permission-mode plan --allow-dangerously-skip-permissions --permission-prompts none)',
        turn2PlusMode: 'bypassPermissions (via SDK control_request set_permission_mode)',
        switchAction: 'SDK control_request set_model -> claude-sonnet-5-5 between Turn 1 and Turn 2 on 100% of SWITCH runs',
        shadowEvaluationNote: 'runPreModelSwitchHook() evaluated offline at switch point and labeled "computed offline; not shown to the model"'
      }
    },
    pricingConfirmedDayOfRun: phase0.livePricing55,
    arms: {
      OPUS: 'claude-opus-5-5 for Turn 1 (plan) and Turns 2..5 (implement + retries)',
      SONNET: 'claude-sonnet-5-5 for Turn 1 (plan) and Turns 2..5 (implement + retries)',
      SWITCH: 'claude-opus-5-5 for Turn 1 (plan), then set_model -> claude-sonnet-5-5 for Turns 2..5 (implement + retries)'
    },
    caps: {
      maxRetries: caps.maxRetries,
      maxHarnessTurns: caps.maxHarnessTurns,
      maxRequestsPerTurn: caps.maxRequestsPerTurn,
      maxRequestsPerRun: caps.maxRequestsPerRun,
      maxRunCostUsd: caps.maxRunCostUsd,
      runCostCapUsd: caps.maxRunCostUsd,
      capPolicy: 'Any run stopped by a cap counts as completed=no with cost_at_completion_usd blank and cap_reason recorded; its total_billed_usd counts in arm spend / completions.'
    },
    cacheIsolationMethod: {
      verifiedAtZeroSpend: true,
      phase0Finding: phase0.mockVerification.cacheIsolationConclusion,
      enforcedMethod: 'Per-run --append-system-prompt salt PLUS >= 365s same-model idle cooldown between consecutive requests on the same upstream model, verified via request[0].cache_read_input_tokens === 0.'
    },
    taskReplacementRule:
      'Keep all 6 pre-registered hard tasks (H01-H06) whatever the empirical outcome; never adjust tasks after seeing model results. The ONLY allowed replacement is a proven specification or checker bug, requiring explicit user confirmation.',
    executionStagingRule:
      'Run Pilot rep 1 (18 runs) first, then report updated cost estimate for reps 2-3 (36 runs) and await explicit user confirmation before executing Stage 2.',
    prompts: {
      turn1PlanPrefix: TURN1_PLAN_PREFIX,
      turn2ImplementPrompt: TURN2_IMPLEMENT_PROMPT,
      retryPromptHeader: RETRY_PROMPT_HEADER,
      retryPromptFormat: `${RETRY_PROMPT_HEADER}\\n- <failing_test_names>\\n\\n<first_30_lines_of_sanitized_output>`
    },
    repositoryHashes: offlineVerify.hashes,
    tasksActive: HARD_TASKS.map((t) => ({
      task_id: t.task_id,
      difficulty: t.difficulty,
      title: t.title,
      target_files: t.target_files,
      constraints: t.constraints,
      spec: t.spec,
      visibleSuiteSha256: offlineVerify.hashes.visible_suites.perFile[`${t.task_id}.visible.test.mjs`],
      hiddenSuiteSha256: offlineVerify.hashes.hidden_suites.perFile[`${t.task_id}.hidden.test.mjs`]
    })),
    randomSeed: RANDOM_SEED,
    totalRuns: schedules.stage1.length + schedules.stage2.length,
    schedules,
    predictions: {
      Q1: 'On multi-file 30-60 minute tasks with subtle edge cases, OPUS achieves higher completion rate and lower total retries than SONNET, while SONNET pays half rate per token on successful tokens.',
      Q2: 'SONNET incurs substantially higher retry and request counts on hard multi-module state machines (H03 coordinator, H05 saga compensation, H06 retroactive re-waterfalling), eroding part or all of its 2x token rate advantage when amortized over completed tasks.',
      Q3: 'Under Option A, Opus Turn-1 planning diagnoses subtle edge-case invariants cleanly into the context before Sonnet implements Turn 2+, potentially saving >=1 retry turn on multi-file hard tasks that offsets SWITCH cold-write overhead more often than on routine tasks.',
      Q4: 'Guard halts (retry_cap or turn_request_cap) will concentrate on H03/H05/H06 and occur more frequently in SONNET than OPUS or SWITCH.'
    },
    pilotCostEstimate: pilotEstimate
  };

  const preregText = JSON.stringify(prereg, null, 2) + '\n';
  assertNoSensitiveLeaks(preregText, 'preregistration_cost_per_task_hard.json', [apiKey]);
  fs.writeFileSync(PREREG_OUT_PATH, preregText, 'utf8');

  const preregSha256 = crypto.createHash('sha256').update(preregText.replace(/\r\n/g, '\n')).digest('hex');
  const estPayload = {
    generatedAtUtc: now.toISOString(),
    tierLabel: 'hard tier',
    preregistrationSha256: preregSha256,
    spendDeltaSinceRoutineStage1Usd: spendDeltaSinceStage1,
    ...pilotEstimate
  };
  const estText = JSON.stringify(estPayload, null, 2) + '\n';
  assertNoSensitiveLeaks(estText, 'hard_tier_pilot_cost_estimate.json', [apiKey]);
  fs.writeFileSync(ESTIMATE_OUT_PATH, estText, 'utf8');

  console.log('HARD_PREREGISTRATION_LOCKED');
  console.log(JSON.stringify({
    preregistrationPath: 'experiments/model-switch-benchmark/results/preregistration_cost_per_task_hard.json',
    preregistrationSha256: preregSha256,
    templateTreeSha256: offlineVerify.hashes.task_repo_hard_template.treeSha256,
    visibleTreeSha256: offlineVerify.hashes.visible_suites.treeSha256,
    hiddenTreeSha256: offlineVerify.hashes.hidden_suites.treeSha256,
    manifestSha256: offlineVerify.hashes.hard_tasks_manifest_sha256,
    stage1PilotRuns: schedules.stage1.length,
    stage2Runs: schedules.stage2.length,
    openRouterUsageAtLockUsd: keySnapshot.usage,
    spendDeltaSinceRoutineStage1Usd: spendDeltaSinceStage1,
    pilot18Runs: pilotEstimate.pilot18Runs,
    byArmPilot6RunsEach: pilotEstimate.byArmPilot6RunsEach
  }, null, 2));
}

main().catch((err) => {
  console.error('HARD_PREREG_FAIL:', err);
  process.exit(1);
});
