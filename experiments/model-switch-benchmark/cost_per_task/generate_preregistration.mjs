#!/usr/bin/env node
/**
 * Generates and SHA-256-locks `results/preregistration_cost_per_task.json` ($0.00 live spend)
 * and computes the grounded Stage 1 (24 runs) + Full (72 runs) Cost Estimate.
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
} from '../config.mjs';
import {
  TASKS,
  TURN1_PLAN_PREFIX,
  TURN2_IMPLEMENT_PROMPT,
  RETRY_PROMPT_HEADER
} from './tasks_manifest.mjs';
import { buildRandomizedSchedule } from './run_cost_per_task.mjs';
import { resolveCptCaps } from './cpt_proxy.mjs';
import { assertNoSensitiveLeaks } from '../tests_3_to_8/prefix_lab.mjs';

const RAW_DIR = path.join(RESULTS_DIR, 'cost_per_task_raw');
const PHASE0_PATH = path.join(RAW_DIR, 'phase0_mock_verification.json');
const OFFLINE_VERIFY_PATH = path.join(RAW_DIR, 'offline_task_verification.json');
const PREREG_OUT_PATH = path.join(RESULTS_DIR, 'preregistration_cost_per_task.json');
const ESTIMATE_OUT_PATH = path.join(RAW_DIR, 'stage1_cost_estimate.json');

const RANDOM_SEED = 20261116;

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

function estimateSingleRunCost({ difficulty, arm, scenario = 'expected' }) {
  const opus = PRICING_PER_1M['anthropic/claude-opus-5.5'];
  const sonnet = PRICING_PER_1M['anthropic/claude-sonnet-5.5'];
  const planRate = arm === 'SONNET' ? sonnet : opus;
  const implRate = arm === 'OPUS' ? opus : sonnet;

  // Prefix & token profiles grounded in Claude Code 2.1.325 wire measurements
  const profiles = {
    expected: {
      easy: { t1StartTok: 12_000, t1DeltaTok: 4_000, t1Reqs: 4, t1Out: 900, implReqs: 4, implDeltaTok: 3_500, implOut: 1_200, avgRetries: 0.25, retryReqs: 3, retryDeltaTok: 2_000, retryOut: 700 },
      medium: { t1StartTok: 12_000, t1DeltaTok: 6_000, t1Reqs: 5, t1Out: 1_200, implReqs: 7, implDeltaTok: 7_000, implOut: 2_200, avgRetries: 0.9, retryReqs: 4, retryDeltaTok: 3_000, retryOut: 1_100 },
      hard: { t1StartTok: 12_000, t1DeltaTok: 8_000, t1Reqs: 6, t1Out: 1_600, implReqs: 10, implDeltaTok: 10_000, implOut: 3_200, avgRetries: 1.6, retryReqs: 5, retryDeltaTok: 4_000, retryOut: 1_500 }
    },
    stress: {
      easy: { t1StartTok: 13_000, t1DeltaTok: 5_000, t1Reqs: 5, t1Out: 1_200, implReqs: 6, implDeltaTok: 5_000, implOut: 1_800, avgRetries: 0.8, retryReqs: 4, retryDeltaTok: 3_000, retryOut: 1_000 },
      medium: { t1StartTok: 13_000, t1DeltaTok: 8_000, t1Reqs: 7, t1Out: 1_600, implReqs: 11, implDeltaTok: 11_000, implOut: 3_500, avgRetries: 1.8, retryReqs: 6, retryDeltaTok: 5_000, retryOut: 1_800 },
      hard: { t1StartTok: 13_000, t1DeltaTok: 11_000, t1Reqs: 9, t1Out: 2_200, implReqs: 15, implDeltaTok: 15_000, implOut: 5_000, avgRetries: 2.7, retryReqs: 8, retryDeltaTok: 7_000, retryOut: 2_600 }
    }
  };

  const p = profiles[scenario][difficulty];
  // Turn 1: req 1 writes t1StartTok; reqs 2..t1Reqs read ~t1StartTok + cumulative delta and write delta
  const t1AvgPrefix = p.t1StartTok + p.t1DeltaTok * 0.5;
  const planWriteTok = p.t1StartTok + p.t1DeltaTok;
  const planReadTok = Math.max(0, p.t1Reqs - 1) * t1AvgPrefix;
  const planCostUsd =
    (planWriteTok / 1e6) * planRate.write5m +
    (planReadTok / 1e6) * planRate.read +
    (p.t1Out / 1e6) * planRate.output;

  // Turn 2: if SWITCH, req 1 cold-writes the entire Turn 1 context (~t1StartTok + t1DeltaTok) on Sonnet!
  const t2StartCtx = p.t1StartTok + p.t1DeltaTok;
  const t2AvgPrefix = t2StartCtx + p.implDeltaTok * 0.5;
  const implWriteTok = arm === 'SWITCH' ? t2StartCtx + p.implDeltaTok : p.implDeltaTok;
  const implReadTok = arm === 'SWITCH' ? Math.max(0, p.implReqs - 1) * t2AvgPrefix : p.implReqs * t2AvgPrefix;
  const implTurnCostUsd =
    (implWriteTok / 1e6) * implRate.write5m +
    (implReadTok / 1e6) * implRate.read +
    (p.implOut / 1e6) * implRate.output;

  const endT2Ctx = t2StartCtx + p.implDeltaTok;
  const retryWriteTok = p.retryDeltaTok;
  const retryReadTok = p.retryReqs * (endT2Ctx + p.retryDeltaTok * 0.5);
  const perRetryCostUsd =
    (retryWriteTok / 1e6) * implRate.write5m +
    (retryReadTok / 1e6) * implRate.read +
    (p.retryOut / 1e6) * implRate.output;

  const retriesCostUsd = p.avgRetries * perRetryCostUsd;
  const totalBaseUsd = planCostUsd + implTurnCostUsd + retriesCostUsd;
  return {
    planCostUsd: Number(planCostUsd.toFixed(4)),
    implAndRetriesCostUsd: Number((implTurnCostUsd + retriesCostUsd).toFixed(4)),
    totalBaseUsd: Number(totalBaseUsd.toFixed(4))
  };
}

function buildCostEstimate(stage1Schedule, keySnapshot) {
  const arms = ['OPUS', 'SONNET', 'SWITCH'];
  const byCell = [];
  let s1ExpectedBase = 0;
  let s1StressBase = 0;

  for (const arm of arms) {
    for (const diff of ['easy', 'medium', 'hard']) {
      const count = stage1Schedule.filter((r) => r.arm === arm && r.difficulty === diff).length;
      const exp = estimateSingleRunCost({ difficulty: diff, arm, scenario: 'expected' });
      const str = estimateSingleRunCost({ difficulty: diff, arm, scenario: 'stress' });
      s1ExpectedBase += count * exp.totalBaseUsd;
      s1StressBase += count * str.totalBaseUsd;
      byCell.push({
        arm,
        difficulty: diff,
        stage1Runs: count,
        expectedPlanPerRunUsd: exp.planCostUsd,
        expectedImplRetriesPerRunUsd: exp.implAndRetriesCostUsd,
        expectedPerRunUsd: exp.totalBaseUsd,
        expectedPerRunWith15PctUsd: Number((exp.totalBaseUsd * 1.15).toFixed(4)),
        stressPerRunUsd: str.totalBaseUsd
      });
    }
  }

  const s1ExpectedPlus15 = Number((s1ExpectedBase * 1.15).toFixed(2));
  const s1StressPlus15 = Number((s1StressBase * 1.15).toFixed(2));
  const full72ExpectedPlus15 = Number((s1ExpectedPlus15 * 3).toFixed(2));
  const full72StressPlus15 = Number((s1StressPlus15 * 3).toFixed(2));
  const absoluteWorstCaseCapUsd = 24 * 3.0; // $3.00/run hard cap * 24 runs

  return {
    pricingBasis: '2026-11-16 OpenRouter live /api/v1/models (Opus 5.5 $4/$20/$5/$0.20, Sonnet 5.5 $2/$10/$2.5/$0.10)',
    openRouterKeySnapshot: keySnapshot,
    byArmAndDifficulty: byCell,
    stage1Pilot24Runs: {
      expectedBaseUsd: Number(s1ExpectedBase.toFixed(2)),
      expectedWith15PctMarginUsd: s1ExpectedPlus15,
      stressBaseUsd: Number(s1StressBase.toFixed(2)),
      stressWith15PctMarginUsd: s1StressPlus15,
      hardAbortCeilingUsd: absoluteWorstCaseCapUsd,
      fitsRemainingKeyCap: keySnapshot.limitRemaining !== null ? keySnapshot.limitRemaining >= s1StressPlus15 : null
    },
    fullStudy72Runs: {
      expectedWith15PctMarginUsd: full72ExpectedPlus15,
      stressWith15PctMarginUsd: full72StressPlus15,
      fitsRemainingKeyCap: keySnapshot.limitRemaining !== null ? keySnapshot.limitRemaining >= full72StressPlus15 : null
    }
  };
}

async function main() {
  assert.ok(fs.existsSync(PHASE0_PATH), `Missing ${PHASE0_PATH}. Run phase0_mock_and_catalog_gate.mjs first.`);
  assert.ok(fs.existsSync(OFFLINE_VERIFY_PATH), `Missing ${OFFLINE_VERIFY_PATH}. Run verify_tasks_offline.mjs first.`);

  const phase0 = JSON.parse(fs.readFileSync(PHASE0_PATH, 'utf8'));
  const offlineVerify = JSON.parse(fs.readFileSync(OFFLINE_VERIFY_PATH, 'utf8'));
  const apiKey = loadOpenRouterApiKey();
  const keySnapshot = await httpsGetKeyUsage(apiKey);
  assert.equal(keySnapshot.statusCode, 200);

  const spendSincePhase0 = Number(
    ((keySnapshot.usage ?? 0) - (phase0.openRouterKeySnapshot?.usageAfterUsd ?? 0)).toFixed(6)
  );
  assert.equal(spendSincePhase0, 0, `Expected $0.00 spend before pre-registration, got $${spendSincePhase0}`);

  const activeTasks = TASKS.filter((t) => !t.is_spare);
  const spareTasks = TASKS.filter((t) => t.is_spare);
  const schedules = buildRandomizedSchedule(RANDOM_SEED, activeTasks);
  const caps = resolveCptCaps();
  const estimate = buildCostEstimate(schedules.stage1, keySnapshot);

  const now = new Date();
  const prereg = {
    schemaVersion: 'cost_per_task_prereg_v1',
    preregisteredAtUtc: now.toISOString(),
    preregisteredAtLocal: now.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T') + '-05:00',
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
      runCostCapUsd: caps.maxRunCostUsd,
      capPolicy: 'Any run stopped by a cap counts as completed=no with cost_at_completion_usd blank and cap_reason recorded; its total_billed_usd counts in arm spend / completions.'
    },
    cacheIsolationMethod: {
      verifiedAtZeroSpend: true,
      phase0Finding: phase0.mockVerification.cacheIsolationConclusion,
      enforcedMethod: 'Per-run --append-system-prompt salt PLUS >= 365s same-model idle cooldown between consecutive requests on the same upstream model, verified via request[0].cache_read_input_tokens === 0.'
    },
    stage1TaskReplacementRule:
      'Keep pre-registered easy tasks even if all arms one-shot them in Stage 1. Replace a task with a pre-written spare (S01/S02) ONLY with user confirmation if: (a) a task fails 0/3 across every arm, (b) a spec or checker bug is found, or (c) >= 6 of the 8 tasks are one-shot in every arm.',
    prompts: {
      turn1PlanPrefix: TURN1_PLAN_PREFIX,
      turn2ImplementPrompt: TURN2_IMPLEMENT_PROMPT,
      retryPromptHeader: RETRY_PROMPT_HEADER,
      retryPromptFormat: `${RETRY_PROMPT_HEADER}\\n- <failing_test_names>\\n\\n<first_30_lines_of_sanitized_output>`
    },
    repositoryHashes: offlineVerify.hashes,
    tasksActive: activeTasks.map((t) => ({
      task_id: t.task_id,
      difficulty: t.difficulty,
      title: t.title,
      target_files: t.target_files,
      constraints: t.constraints,
      spec: t.spec,
      visibleSuiteSha256: offlineVerify.hashes.visible_suites.perFile[`${t.task_id}.visible.test.mjs`],
      hiddenSuiteSha256: offlineVerify.hashes.hidden_suites.perFile[`${t.task_id}.hidden.test.mjs`]
    })),
    tasksSpares: spareTasks.map((t) => ({
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
    schedules,
    predictions: {
      Q1: 'Per completed task, SONNET is lowest-cost on easy and most medium tasks (~45-55% lower token price than OPUS), while OPUS has a higher completion rate on hard tasks (T07 DST windows, T08 parser escaping + async mutex rollback).',
      Q2: 'SONNET needs more retry attempts on medium/hard tasks (predicted +0.5 to +1.5 retries on hard tasks), partially narrowing its 2x price advantage, though its lower per-token rate keeps total spend/completion below OPUS on easy/medium unless hard-task failures dominate.',
      Q3: 'Under Option A (Opus Turn-1 plan -> Sonnet Turn-2+ implement), SWITCH incurs a Turn-2 cold-write penalty (25x write/read ratio on Claude 5.5) on a ~15k-25k Turn-1 context (~$0.04-$0.06 surcharge). On easy 1-shot Turn-2 tasks, SWITCH likely costs MORE than SONNET and pays back only partially vs OPUS unless Opus-grade Turn-1 diagnosis cuts Sonnet retries on medium/hard tasks.',
      Q4: 'Capping failures (retry_cap or turn_request_cap) will occur predominantly on hard tasks (T07/T08), highest on SONNET (1-3 capped runs), lowest on OPUS (0-1), and intermediate on SWITCH (0-2).'
    },
    stage1CostEstimate: estimate
  };

  const preregText = JSON.stringify(prereg, null, 2) + '\n';
  assertNoSensitiveLeaks(preregText, 'preregistration_cost_per_task.json', [apiKey]);
  fs.writeFileSync(PREREG_OUT_PATH, preregText, 'utf8');

  const preregSha256 = crypto.createHash('sha256').update(preregText.replace(/\r\n/g, '\n')).digest('hex');
  const estSummary = {
    generatedAtUtc: now.toISOString(),
    preregistrationSha256: preregSha256,
    spendSincePhase0Usd: spendSincePhase0,
    ...estimate
  };
  fs.writeFileSync(ESTIMATE_OUT_PATH, JSON.stringify(estSummary, null, 2) + '\n', 'utf8');

  console.log('PREREGISTRATION_LOCKED');
  console.log(JSON.stringify({
    preregistrationPath: 'experiments/model-switch-benchmark/results/preregistration_cost_per_task.json',
    preregistrationSha256: preregSha256,
    templateTreeSha256: offlineVerify.hashes.task_repo_template.treeSha256,
    visibleTreeSha256: offlineVerify.hashes.visible_suites.treeSha256,
    hiddenTreeSha256: offlineVerify.hashes.hidden_suites.treeSha256,
    stage1Runs: schedules.stage1.length,
    stage2Runs: schedules.stage2.length,
    openRouterUsageUsd: keySnapshot.usage,
    openRouterLimitRemainingUsd: keySnapshot.limitRemaining,
    spendDeltaUsd: spendSincePhase0,
    stage1PilotEstimate: estimate.stage1Pilot24Runs,
    full72Estimate: estimate.fullStudy72Runs
  }, null, 2));
}

main().catch((err) => {
  console.error('PREREG_FAIL:', err);
  process.exit(1);
});
