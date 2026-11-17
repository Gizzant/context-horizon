import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  PINNED_REPO_COMMIT,
  PINNED_CLAUDE_CODE_VERSION,
  MODEL_A_CLI,
  MODEL_B_CLI,
  EFFORT_BASELINE,
  PRICING_PER_1M,
  loadOpenRouterApiKey,
  mapCliModelToOpenRouter,
  computeUsageCostUsd
} from './config.mjs';
import { startProxyServer } from './proxy_recorder.mjs';
import { installAttentionHorizon, ensureGitExcludeEntries } from '../../bin/ctxtop.mjs';
import { activateLocalTrial } from '../../src/core/pro_license.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { runStopGateHook } from '../../hooks/handlers/stop-gate.mjs';

const RESULTS_C2_ROOT = path.join(EXPERIMENT_DIR, 'results', 'round2_c2');

const CSV_HEADERS = Object.freeze([
  'run_id',
  'arm',
  'rep',
  'session_id',
  'turn',
  'event',
  'is_side_call',
  'model',
  'effort',
  'prefix_size_bucket',
  'timestamp_utc',
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
  'latency_ms',
  'cost_usd',
  'source',
  'notes',
  'request_index_in_turn',
  'requests_in_turn'
]);

const INTERCEPTIONS_HEADERS = Object.freeze([
  'run_id',
  'arm',
  'rep',
  'condition',
  'rule_version',
  'turn',
  'scheduled_model',
  'effective_model',
  'wire_model_after_hook',
  'hook_event',
  'hook_outcome',
  'hook_exit_code',
  'permission_decision',
  'control_subtype',
  'control_error_code',
  'turns_completed_used',
  'api_calls_completed',
  'requests_per_turn',
  'rolling_output_median_raw',
  'rolling_output_sample_size',
  'shrinkage_weight',
  'expected_output_tokens',
  'output_estimate_source',
  'prior_bucket',
  'horizon_prior_source',
  'horizon_unit',
  'prior_native_unit',
  'expected_remaining_turns',
  'break_even_tokens',
  'cold_write_penalty_usd',
  'per_turn_saving_usd',
  'payback_turns',
  'context_tokens',
  'notable_allow_note',
  'reason'
]);

/**
 * 18 deterministic follow-up prompts extending the 12-turn `prompts_small.json` chat
 * to 30 turns using ONLY the already-loaded slices of `billingBlocks.mjs`, `dualTtl.mjs`,
 * and `cliffBreaker.mjs` with Read tool usage disabled.
 */
const EXTENSION_PROMPTS_T13_TO_T30 = Object.freeze([
  {
    turn: 13,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace in 3 concise bullet points (under 80 words total) how `partitionBillingBlocks` sorts out-of-order timestamps and sets `startTimestamp`.'
  },
  {
    turn: 14,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 3 concise bullet points (under 80 words total) how `blockIndex`, `startTime`, and `endTime` are computed in `billingBlocks.mjs`.'
  },
  {
    turn: 15,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, compare how `totalCostUsd`, `subagentSpend`, and `totalTokens` are accumulated inside `partitionBillingBlocks` (3 bullets, under 80 words total).'
  },
  {
    turn: 16,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, compare `formatMmSs` and `formatRemainingTtl` in `dualTtl.mjs` on zero, sub-minute, and multi-minute inputs (3 bullets, under 80 words total).'
  },
  {
    turn: 17,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace how `elapsedMs`, `cacheRemainingMs`, `isCacheExpired`, and `isBillingExpired` are computed in `calculateDualTtlCountdown` (3 bullets, under 80 words total).'
  },
  {
    turn: 18,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, list the alert and upgrade constants in `DUAL_TTL_CONSTANTS` (`AMBER_ALERT_SEC`, `KEEP_ALIVE_SEC`, `SNAPSHOT_SEC`, `ONE_HOUR_UPGRADE_PAUSE_RATIO_THRESHOLD`) in 3 bullets (under 80 words total).'
  },
  {
    turn: 19,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 3 concise bullet points (under 80 words total) how `isHaikuModel` and the early non-Haiku exemption in `checkHaiku100kCliffBreaker` behave.'
  },
  {
    turn: 20,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, state the exact token intervals for `allow`, `advisory`, `warn`, and `halt` in `cliffBreaker.mjs` (3 bullets, under 80 words total).'
  },
  {
    turn: 21,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, compare rounding across the 3 modules: `parseFloat(...toFixed(4))` in `billingBlocks.mjs`, `Math.floor` in `dualTtl.mjs`, and `toLocaleString` in `cliffBreaker.mjs` (3 bullets, under 80 words total).'
  },
  {
    turn: 22,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, summarize the defensive input guards for empty, null, negative, or non-numeric inputs across all three loaded functions (3 bullets, under 80 words total).'
  },
  {
    turn: 23,
    phase: 'pre_switch_l2',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, list which of the three loaded slices have `import` statements vs zero imports under the Claude Mod Laws 1-5 header (3 bullets, under 80 words total).'
  },
  {
    turn: 24,
    phase: 'switch_point_l2',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace how a new entry in `blocksMap` is initialized when a `blockIndex` is first encountered in `partitionBillingBlocks` (3 bullets, under 80 words total).'
  },
  {
    turn: 25,
    phase: 'recovery_l2',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace `subagentId` coercion and negative `costUsd`/`tokens` clamping in `partitionBillingBlocks` (3 bullets, under 80 words total).'
  },
  {
    turn: 26,
    phase: 'return_l2',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace what `{ rolling: true }` returns in `calculateDualTtlCountdown` when `elapsedMs === billingTtlMs` vs `billingTtlMs + 1` (3 bullets, under 80 words total).'
  },
  {
    turn: 27,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain why `checkHaiku100kCliffBreaker` returns `threshold: 98000` across every outcome object even when matching `100000` or `90000` (3 bullets, under 80 words total).'
  },
  {
    turn: 28,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, compare the JSDoc return object schemas declared in `billingBlocks.mjs`, `dualTtl.mjs`, and `cliffBreaker.mjs` (3 bullets, under 80 words total).'
  },
  {
    turn: 29,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace how invalid `blockDurationMs <= 0` fallback and `durationHours > 0` division guards behave in `partitionBillingBlocks` (3 bullets, under 80 words total).'
  },
  {
    turn: 30,
    phase: 'extend',
    prompt: 'IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, list every exported constant identifier and key count across the three loaded slices (3 bullets, under 80 words total).'
  }
]);

const ARM_SPECS_C2 = Object.freeze({
  L1: Object.freeze({
    arm: 'L1',
    armName: 'long_early_switch_T3',
    turns: 30,
    initialModel: MODEL_A_CLI,
    targetModel: MODEL_B_CLI,
    switchBeforeTurn: 3,
    defaultLiveReps: 3
  }),
  L2: Object.freeze({
    arm: 'L2',
    armName: 'long_late_switch_T24',
    turns: 30,
    initialModel: MODEL_A_CLI,
    targetModel: MODEL_B_CLI,
    switchBeforeTurn: 24,
    defaultLiveReps: 3
  }),
  U1: Object.freeze({
    arm: 'U1',
    armName: 'upshift_sonnet_to_opus_T6',
    turns: 12,
    initialModel: MODEL_B_CLI,
    targetModel: MODEL_A_CLI,
    switchBeforeTurn: 6,
    defaultLiveReps: 1
  })
});

function parseArgs(argv = []) {
  const flags = {
    live: false,
    mockDryRun: false,
    buildOnly: false,
    confirmSpend: false,
    resume: false,
    hbOnly: false,
    rule: 'rule_v1',
    arms: ['L1', 'L2', 'U1'],
    armReps: {},
    armHorizons: {},
    repsOverride: null,
    maxBudgetUsd: 11.0
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') flags.live = true;
    else if (a === '--mock-dry-run') flags.mockDryRun = true;
    else if (a === '--build-only') flags.buildOnly = true;
    else if (a === '--confirm-spend') flags.confirmSpend = true;
    else if (a === '--resume') flags.resume = true;
    else if (a === '--hb-only') flags.hbOnly = true;
    else if (a === '--rule' && argv[i + 1]) flags.rule = String(argv[++i]).trim();
    else if (a === '--arms' && argv[i + 1]) {
      flags.arms = String(argv[++i])
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => Boolean(ARM_SPECS_C2[s]));
    } else if (a === '--arm-reps' && argv[i + 1]) {
      for (const pair of String(argv[++i]).split(',')) {
        const [armRaw, repRaw] = pair.split(':');
        const armKey = String(armRaw || '').trim().toUpperCase();
        const repNum = Number(repRaw);
        if (ARM_SPECS_C2[armKey] && Number.isFinite(repNum) && repNum >= 1) {
          flags.armReps[armKey] = Math.floor(repNum);
        }
      }
    } else if (a === '--arm-horizons' && argv[i + 1]) {
      for (const pair of String(argv[++i]).split(',')) {
        const [armRaw, horizonRaw] = pair.split(':');
        const armKey = String(armRaw || '').trim().toUpperCase();
        const horizonNum = Number(horizonRaw);
        if (ARM_SPECS_C2[armKey] && Number.isFinite(horizonNum) && horizonNum >= 0) {
          flags.armHorizons[armKey] = horizonNum;
        }
      }
    } else if (a === '--reps' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 1) flags.repsOverride = Math.floor(n);
    } else if (a === '--max-budget' && argv[i + 1]) {
      const b = Number(argv[++i]);
      if (Number.isFinite(b) && b > 0) flags.maxBudgetUsd = b;
    }
  }
  if (!flags.live && !flags.mockDryRun && !flags.buildOnly) {
    flags.mockDryRun = true;
  }
  if (
    flags.rule !== 'rule_v1' &&
    flags.rule !== 'rule_v2' &&
    flags.rule !== 'rule_v2_calibrated'
  ) {
    throw new Error(
      `Invalid --rule "${flags.rule}". Expected rule_v1, rule_v2, or rule_v2_calibrated.`
    );
  }
  if (flags.arms.length === 0) {
    throw new Error('No valid arms selected. Expected subset of L1,L2,U1.');
  }
  return flags;
}

function getRepoGitHead(cwd = REPO_ROOT) {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  return res.status === 0 ? String(res.stdout || '').trim() : 'unknown';
}

function resolveRuntimePaths(isLive) {
  const tmpDir = os.tmpdir();
  const candidates = fs.readdirSync(tmpDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-model-switch-runtime'))
    .map((d) => path.join(tmpDir, d.name));

  for (const rtRoot of candidates) {
    const claudeExe = path.join(rtRoot, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const frozenRepoDir = path.join(rtRoot, 'frozen-repo');
    if (fs.existsSync(claudeExe) && fs.existsSync(frozenRepoDir)) {
      return {
        runtimeRoot: rtRoot,
        claudeExe,
        frozenRepoDir,
        workDir: isLive
          ? path.join(rtRoot, 'runs', 'round2_c2_live')
          : path.join(tmpDir, 'ctxtop-round2-c2-dry-run')
      };
    }
  }
  throw new Error('Could not locate installed claude.exe + frozen-repo under %TEMP%/*-model-switch-runtime');
}

function verifyRuntimeEnvironment(runtimePaths) {
  const verRes = spawnSync(runtimePaths.claudeExe, ['--version'], { encoding: 'utf8' });
  const versionOutput = String(verRes.stdout || verRes.stderr || '').trim();
  const gitRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: runtimePaths.frozenRepoDir, encoding: 'utf8' });
  const actualCommit = String(gitRes.stdout || '').trim();
  if (actualCommit !== PINNED_REPO_COMMIT) {
    throw new Error(`Frozen repo HEAD ${actualCommit} !== expected ${PINNED_REPO_COMMIT}`);
  }
  return { versionOutput, actualCommit };
}

function ensureAutoGitExclude(frozenRepoDir) {
  ensureGitExcludeEntries(frozenRepoDir);
  const excludePath = path.join(frozenRepoDir, '.git', 'info', 'exclude');
  if (fs.existsSync(excludePath)) {
    let content = fs.readFileSync(excludePath, 'utf8');
    if (!content.split(/\r?\n/).some((l) => l.trim() === '.claude/')) {
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += '.claude/\n';
      fs.writeFileSync(excludePath, content, 'utf8');
    }
  }
}

function resetFrozenRepoClean(frozenRepoDir) {
  const co = spawnSync('git', ['checkout', '-f', PINNED_REPO_COMMIT], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (co.status !== 0) throw new Error(`git checkout failed: ${co.stderr}`);
  const cl = spawnSync('git', ['clean', '-fdx'], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (cl.status !== 0) throw new Error(`git clean failed: ${cl.stderr}`);
  ensureAutoGitExclude(frozenRepoDir);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (st.status !== 0) throw new Error(`git status failed: ${st.stderr}`);
  if (String(st.stdout || '').trim() !== '') {
    throw new Error(`Frozen repo is not clean after reset: ${st.stdout}`);
  }
}

function build30TurnSmallPrompts() {
  const basePath = path.join(EXPERIMENT_DIR, 'fixtures', 'prompts_small.json');
  const baseJson = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  return [...baseJson.prompts, ...EXTENSION_PROMPTS_T13_TO_T30];
}

function buildScheduleRuns(flags) {
  const queue = [];
  for (const armCode of flags.arms) {
    const spec = ARM_SPECS_C2[armCode];
    const reps = flags.armReps?.[armCode] ?? (
      flags.mockDryRun
        ? (flags.repsOverride || 1)
        : (flags.repsOverride || spec.defaultLiveReps)
    );
    for (let rep = 1; rep <= reps; rep++) {
      const repStr = `r${String(rep).padStart(2, '0')}`;
      if (!flags.hbOnly) {
        queue.push({
          runId: `C2_${armCode}_off_${repStr}`,
          arm: armCode,
          armName: spec.armName,
          condition: 'baseline_off',
          ruleVersion: 'baseline_off',
          hbEnabled: false,
          rep,
          turns: spec.turns,
          initialModel: spec.initialModel,
          targetModel: spec.targetModel,
          switchBeforeTurn: spec.switchBeforeTurn
        });
      }
      queue.push({
        runId: `C2_${armCode}_hb_${flags.rule}_${repStr}`,
        arm: armCode,
        armName: spec.armName,
        condition: 'highbeam_auto',
        ruleVersion: flags.rule,
        hbEnabled: true,
        rep,
        turns: spec.turns,
        initialModel: spec.initialModel,
        targetModel: spec.targetModel,
        switchBeforeTurn: spec.switchBeforeTurn,
        expectedRemainingTurns: flags.armHorizons?.[armCode] ?? null
      });
    }
  }
  return queue;
}

async function fetchOpenRouterKeyUsage(apiKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      usage: json?.data?.usage ?? null,
      limit: json?.data?.limit ?? null,
      limit_remaining: json?.data?.limit_remaining ?? null
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Localhost $0.00 mock Anthropic SSE server reproducing small-prefix prompt caching
 * and emitting stable `messageId` values so `source = both` reconciliation can run end-to-end.
 */
async function startMockSseServer(wireLogPath) {
  const wireLogs = [];
  let wireSeq = 0;
  let activeContext = null;
  let sessionCachedPrefix = 0;
  let lastWireModel = null;

  const server = http.createServer((req, res) => {
    const reqStartNs = process.hrtime.bigint();
    const timestamp = new Date().toISOString();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const urlPath = req.url || '/';
      let body = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        body = {};
      }

      if (urlPath.includes('count_tokens')) {
        wireSeq += 1;
        const est = Math.max(50, sessionCachedPrefix + 345);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: est }));
        const sideRec = {
          wireSeq,
          timestamp,
          context: activeContext ? { ...activeContext } : null,
          urlPath,
          isSideCall: true,
          statusCode: 200,
          requestedModel: body.model || MODEL_A_CLI,
          mappedModel: mapCliModelToOpenRouter(body.model || MODEL_A_CLI),
          approxInputTokens: est,
          timing: { latencyMs: 1.0 },
          mockMode: true
        };
        wireLogs.push(sideRec);
        fs.appendFileSync(wireLogPath, JSON.stringify(sideRec) + '\n', 'utf8');
        return;
      }

      if (!body.stream) {
        wireSeq += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `msg_mock_sync_${wireSeq}`,
          type: 'message',
          role: 'assistant',
          model: body.model || MODEL_A_CLI,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 }
        }));
        return;
      }

      wireSeq += 1;
      const requestedModel = body.model || MODEL_A_CLI;
      const mappedModel = mapCliModelToOpenRouter(requestedModel);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const isSideCall = !hasTools;
      const messageId = `msg_mock_${wireSeq}`;

      let rawUsage;
      if (isSideCall) {
        rawUsage = {
          input_tokens: 120,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          output_tokens: 16
        };
      } else {
        const isFirstMain = sessionCachedPrefix === 0;
        const switchedWire = lastWireModel !== null && lastWireModel !== requestedModel;
        const delta = isFirstMain ? 10549 : 345;
        const writeTok = isFirstMain || switchedWire ? sessionCachedPrefix + delta : delta;
        const readTok = isFirstMain || switchedWire ? 0 : sessionCachedPrefix;
        const outTok = isFirstMain ? 132 : 215;
        sessionCachedPrefix += delta;
        lastWireModel = requestedModel;
        rawUsage = {
          input_tokens: 3,
          cache_creation_input_tokens: writeTok,
          cache_read_input_tokens: readTok,
          cache_creation: { ephemeral_5m_input_tokens: writeTok, ephemeral_1h_input_tokens: 0 },
          output_tokens: outTok
        };
      }

      const evs = [
        {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: requestedModel,
            content: [],
            stop_reason: null,
            usage: { ...rawUsage, output_tokens: 1 }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK (mock).' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: rawUsage.output_tokens } },
        { type: 'message_stop' }
      ];

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));

      const latencyMs = Number(Number(process.hrtime.bigint() - reqStartNs) / 1e6).toFixed(2);
      const totalIn = rawUsage.input_tokens + rawUsage.cache_creation_input_tokens + rawUsage.cache_read_input_tokens;
      const costBreakdown = computeUsageCostUsd(requestedModel, rawUsage);
      const record = {
        wireSeq,
        timestamp,
        context: activeContext ? { ...activeContext } : null,
        urlPath,
        isSideCall,
        statusCode: 200,
        requestedModel,
        mappedModel,
        responseModel: requestedModel,
        messageId,
        upstreamReportedCostUsd: null,
        usage: {
          ...rawUsage,
          ephemeral_5m_input_tokens: rawUsage.cache_creation.ephemeral_5m_input_tokens,
          ephemeral_1h_input_tokens: 0,
          total_input_tokens: totalIn,
          cache_hit_ratio: totalIn > 0 ? rawUsage.cache_read_input_tokens / totalIn : 0
        },
        cost: costBreakdown,
        timing: { latencyMs: Number(latencyMs) },
        mockMode: true
      };
      wireLogs.push(record);
      fs.appendFileSync(wireLogPath, JSON.stringify(record) + '\n', 'utf8');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    resetSessionState() {
      sessionCachedPrefix = 0;
      lastWireModel = null;
    },
    setContext(ctx) {
      activeContext = ctx ? { ...ctx } : null;
    },
    getState() {
      return { totalSpendUsd: 0, budgetExceeded: false };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  };
}

function findSessionJsonlFiles(rootDir, acc = []) {
  if (!fs.existsSync(rootDir)) return acc;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) findSessionJsonlFiles(full, acc);
    else if (entry.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function loadDynamicIdentifiers() {
  const dynamicUser = os.userInfo().username || '';
  const dynamicRepoDirName = path.basename(REPO_ROOT);
  let dynamicGitRemoteSlug = '';
  let dynamicGitOwner = '';
  let dynamicGitRepo = '';
  const gitConfigPath = path.join(REPO_ROOT, '.git', 'config');
  if (fs.existsSync(gitConfigPath)) {
    const gcfg = fs.readFileSync(gitConfigPath, 'utf8');
    const m = gcfg.match(/github\.com[:\/]([^\/\s]+)\/([^.\s\/]+)(?:\.git)?/i);
    if (m) {
      dynamicGitOwner = m[1];
      dynamicGitRepo = m[2];
      dynamicGitRemoteSlug = `${m[1]}/${m[2]}`;
    }
  }
  return {
    dynamicUser,
    dynamicRepoDirName,
    dynamicGitRemoteSlug,
    dynamicGitOwner,
    dynamicGitRepo
  };
}

function sanitizeRound2C2InPlace(outDir, runtimePaths = null) {
  const rawDir = path.join(outDir, 'raw');
  const cpPath = path.join(rawDir, 'checkpoint.json');
  const cp = fs.existsSync(cpPath) ? JSON.parse(fs.readFileSync(cpPath, 'utf8')) : { runs: {} };

  const sessionIdMap = new Map();
  for (const [runId, meta] of Object.entries(cp.runs || {})) {
    if (meta?.sessionId && !String(meta.sessionId).startsWith('sess_')) {
      sessionIdMap.set(meta.sessionId, `sess_${runId}`);
    }
  }

  const msgIdMap = new Map();
  const wireLogs = readJsonl(path.join(rawDir, 'proxy_wire_log.jsonl'));
  const byGroup = new Map();
  for (const w of wireLogs) {
    if (!w.isSideCall && w.statusCode === 200 && w.context?.runId && w.context?.turn) {
      const att = w.context.attempt || 1;
      const k = `${w.context.runId}::a${att}::T${w.context.turn}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(w);
    }
  }
  for (const [k, calls] of byGroup.entries()) {
    const [runId, attPart] = k.split('::');
    const attNum = Number(attPart.slice(1)) || 1;
    const winAtt = cp.runs?.[runId]?.attempt || 1;
    calls.sort((a, b) => a.wireSeq - b.wireSeq);
    calls.forEach((c, idx) => {
      if (c.messageId && !String(c.messageId).startsWith(`msg_${runId}`)) {
        const tPad = String(c.context.turn).padStart(2, '0');
        const attSuffix = attNum === winAtt ? '' : `_a${attNum}`;
        msgIdMap.set(c.messageId, `msg_${runId}${attSuffix}_T${tPad}_r${idx + 1}`);
      }
    });
  }

  const ids = loadDynamicIdentifiers();
  const extraPaths = [[REPO_ROOT, '<REPO_ROOT>']];
  if (runtimePaths?.frozenRepoDir) extraPaths.push([runtimePaths.frozenRepoDir, '<FROZEN_REPO>']);
  if (runtimePaths?.workDir) extraPaths.push([runtimePaths.workDir, '<ISOLATED_WORK_DIR>']);
  if (runtimePaths?.runtimeRoot) extraPaths.push([runtimePaths.runtimeRoot, '<RUNTIME_ROOT>']);

  function sanitizeText(rawText) {
    let text = String(rawText)
      .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/[A-Za-z]--Users-[A-Za-z0-9_.-]+-AppData-Local-Temp-[A-Za-z0-9_.-]+/gi, '<FROZEN_REPO_SLUG>');

    for (const [origPath, repl] of extraPaths) {
      for (const variant of [origPath, origPath.replace(/\\/g, '/'), origPath.replace(/\\/g, '\\\\')]) {
        if (variant) text = text.split(variant).join(repl);
      }
    }

    text = text
      .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
      .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]')
      .replace(/\/Users\/[^/"\s]+/g, '/Users/[USER]')
      .replace(/(\\"device_id\\":\\"|\"device_id\"\s*:\s*\")[0-9a-f]{32,64}(\\"|\")/gi, '$1[REDACTED_DEVICE_ID]$2')
      .replace(/gen-\d{6,}-[A-Za-z0-9_-]+/g, '[REDACTED_UPSTREAM_REQ_ID]');

    for (const [origUuid, pseudoSess] of sessionIdMap.entries()) {
      if (text.includes(origUuid)) text = text.split(origUuid).join(pseudoSess);
    }
    for (const [origMsgId, pseudoMsgId] of msgIdMap.entries()) {
      if (text.includes(origMsgId)) text = text.split(origMsgId).join(pseudoMsgId);
    }

    text = text
      .replace(/msg_01[A-Za-z0-9]{10,}/g, '[REDACTED_MSG_ID]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]');

    for (const [needle, repl] of [
      [ids.dynamicGitRemoteSlug, '<GITHUB_HANDLE>/<TARGET_REPO>'],
      [ids.dynamicGitOwner, '<GITHUB_HANDLE>'],
      [ids.dynamicGitRepo, '<TARGET_REPO>'],
      [ids.dynamicRepoDirName, '<TARGET_REPO>'],
      [ids.dynamicUser, '[USER]']
    ]) {
      if (needle && needle.length >= 3) {
        const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        text = text.replace(rx, repl);
      }
    }
    return text;
  }

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsonl|json|csv|md)$/i.test(e.name)) {
        const prev = fs.readFileSync(p, 'utf8');
        const next = sanitizeText(prev);
        if (next !== prev) fs.writeFileSync(p, next, 'utf8');
      }
    }
  };
  walk(outDir);
}

function parseTranscriptUsageMap(transcriptPath) {
  const byMsgId = new Map();
  if (!fs.existsSync(transcriptPath)) return byMsgId;
  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message;
    if (obj?.type === 'assistant' && msg?.role === 'assistant' && msg?.usage && msg?.id) {
      const id = msg.id;
      const u = msg.usage;
      const prev = byMsgId.get(id);
      if (!prev || Number(u.output_tokens || 0) >= Number(prev.output_tokens || 0)) {
        byMsgId.set(id, {
          input_tokens: Number(u.input_tokens || 0),
          cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
          output_tokens: Number(u.output_tokens || 0)
        });
      }
    }
  }
  return byMsgId;
}

function setupIsolatedRunEnv(spec, runtimePaths) {
  const workRoot = path.join(runtimePaths.workDir, spec.runId);
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'claude_config');
  const settingsPath = path.join(workRoot, 'settings.json');
  const licensePath = path.join(homeDir, '.ctxtop', 'license.json');
  const hookLogPath = path.join(workRoot, 'ah_interception_log.jsonl');
  const salt = `Benchmark-Run-Salt: ${spec.runId}_${crypto.createHash('sha256').update(spec.runId + '_c2').digest('hex').slice(0, 8)}`;

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  if (spec.hbEnabled) {
    activateLocalTrial({ homeDir, licensePath });
    const ahDir = path.join(homeDir, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(
      path.join(ahDir, 'config.json'),
      JSON.stringify({
        flightMode: 'AUTO_PILOT',
        useEmpiricalHorizonPrior: String(spec.ruleVersion || '').startsWith('rule_v2'),
        ...(spec.expectedRemainingTurns !== null && spec.expectedRemainingTurns !== undefined
          ? { expectedRemainingTurns: spec.expectedRemainingTurns }
          : {})
      }, null, 2),
      'utf8'
    );
    installAttentionHorizon({
      settingsPath,
      cwd: runtimePaths.frozenRepoDir,
      leanHooks: false
    });
  } else {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');
  }

  return { workRoot, homeDir, cfgDir, settingsPath, licensePath, salt, hookLogPath };
}

/**
 * Executes one complete multi-turn session inside a single persistent `claude.exe`
 * `-p --input-format stream-json --output-format stream-json` process and drives the
 * model switch via SDK `control_request: { subtype: "set_model" }` before `switchBeforeTurn`.
 */
async function executePersistentSession({
  spec,
  runIndex,
  totalRuns,
  attempt,
  initialSpendUsd,
  envSetup,
  prompts,
  runtimePaths,
  serverHandle,
  wireLogPath,
  cliTurnsPath,
  interceptionsPath,
  transcriptsDir
}) {
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = serverHandle.baseUrl;
  env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CONFIG_DIR = envSetup.cfgDir;
  env.HOME = envSetup.homeDir;
  env.USERPROFILE = envSetup.homeDir;
  if (envSetup.hookLogPath) {
    env.AH_INTERCEPTION_LOG_PATH = envSetup.hookLogPath;
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--dangerously-skip-permissions',
    '--tools', 'Read',
    '--model', spec.initialModel,
    '--effort', EFFORT_BASELINE,
    '--append-system-prompt', envSetup.salt,
    '--settings', envSetup.settingsPath,
    '--setting-sources', 'local'
  ];

  const child = spawn(runtimePaths.claudeExe, args, {
    cwd: runtimePaths.frozenRepoDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const events = [];
  const stderrChunks = [];
  let stdoutBuf = '';
  let childClosed = false;
  let exitCode = null;

  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  });
  child.stderr.on('data', (d) => stderrChunks.push(d));
  const closePromise = new Promise((resolve) => {
    child.on('close', (code) => {
      childClosed = true;
      exitCode = code;
      resolve(code);
    });
  });

  function waitForEvent(pred, timeoutMs = 180000, fromIndex = 0) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        for (let i = fromIndex; i < events.length; i++) {
          if (pred(events[i], i)) {
            clearInterval(iv);
            resolve({ event: events[i], index: i });
            return;
          }
        }
        if (childClosed) {
          clearInterval(iv);
          reject(new Error(`[${spec.runId} a${attempt}] claude.exe exited early (${exitCode}): ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 400)}`));
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`[${spec.runId} a${attempt}] Timed out waiting for stream-json event`));
        }
      }, 25);
    });
  }

  let effectiveModel = spec.initialModel;
  let switchSummary = null;
  let completedResults = 0;

  try {
    for (let turn = 1; turn <= spec.turns; turn++) {
      let hookRecord = null;
      if (turn === spec.switchBeforeTurn) {
        const beforeSwitchEvtIdx = events.length;
        const reqId = `req_switch_T${turn}_${spec.runId}_a${attempt}`;
        serverHandle.setContext({
          runId: spec.runId,
          arm: spec.arm,
          condition: spec.condition,
          ruleVersion: spec.ruleVersion,
          rep: spec.rep,
          attempt,
          turn,
          switchBeforeTurn: spec.switchBeforeTurn,
          phase: 'sdk_set_model'
        });
        child.stdin.write(JSON.stringify({
          type: 'control_request',
          request_id: reqId,
          request: { subtype: 'set_model', model: spec.targetModel }
        }) + '\n');

        const { event: ctrlEvent, index: ctrlIdx } = await waitForEvent(
          (e) => e.type === 'control_response' && e.response?.request_id === reqId,
          30000,
          beforeSwitchEvtIdx
        );

        const sliceAfterSwitch = events.slice(beforeSwitchEvtIdx, ctrlIdx + 1);
        const hookResp = sliceAfterSwitch.find((e) => e.subtype === 'hook_response' && e.hook_event === 'PreModelSwitch') || null;
        let parsedHookJson = null;
        if (hookResp?.stdout) {
          try {
            parsedHookJson = JSON.parse(String(hookResp.stdout).trim());
          } catch {}
        }
        const hookDiagRows =
          envSetup.hookLogPath && fs.existsSync(envSetup.hookLogPath)
            ? readJsonl(envSetup.hookLogPath)
            : [];
        const hookDiag = hookDiagRows.length > 0 ? hookDiagRows[hookDiagRows.length - 1] : null;

        const permDecision = parsedHookJson?.hookSpecificOutput?.permissionDecision || hookDiag?.decision || null;
        const reason = parsedHookJson?.systemMessage
          || parsedHookJson?.hookSpecificOutput?.permissionDecisionReason
          || parsedHookJson?.hookSpecificOutput?.additionalContext
          || hookDiag?.notableAllowNote
          || hookDiag?.reason
          || ctrlEvent.response?.error
          || '';
        const allowed = ctrlEvent.response?.subtype === 'success';
        if (allowed) {
          effectiveModel = spec.targetModel;
        }

        hookRecord = {
          run_id: spec.runId,
          arm: spec.arm,
          rep: spec.rep,
          attempt,
          condition: spec.condition,
          rule_version: spec.ruleVersion,
          turn,
          scheduled_model: mapCliModelToOpenRouter(spec.targetModel),
          effective_model: mapCliModelToOpenRouter(effectiveModel),
          wire_model_after_hook: effectiveModel,
          hook_event: hookResp ? 'PreModelSwitch' : 'none',
          hook_outcome: hookResp?.outcome || 'none',
          hook_exit_code: hookResp?.exit_code ?? '',
          permission_decision: permDecision || (hookResp ? (allowed ? 'allow' : 'blocked') : (allowed ? 'allow_no_hook' : 'blocked')),
          control_subtype: ctrlEvent.response?.subtype || 'unknown',
          control_error_code: ctrlEvent.response?.error_code || '',
          turns_completed_used: hookDiag?.turnsCompletedUsed ?? '',
          api_calls_completed: hookDiag?.apiCallsCompleted ?? '',
          requests_per_turn: hookDiag?.requestsPerTurn ?? '',
          rolling_output_median_raw: hookDiag?.rawRollingMedianOutputTokens ?? '',
          rolling_output_sample_size: hookDiag?.outputSampleSize ?? '',
          shrinkage_weight: hookDiag?.shrinkageWeight ?? '',
          expected_output_tokens: hookDiag?.expectedOutputTokens ?? '',
          output_estimate_source: hookDiag?.outputEstimateSource ?? '',
          prior_bucket: hookDiag?.priorBucket ?? '',
          horizon_prior_source: hookDiag?.horizonPriorSource ?? '',
          horizon_unit: hookDiag?.horizonUnit ?? '',
          prior_native_unit: hookDiag?.priorNativeUnit ?? '',
          expected_remaining_turns: hookDiag?.expectedRemainingTurns ?? '',
          break_even_tokens: hookDiag?.breakEvenTokens ?? '',
          cold_write_penalty_usd: hookDiag?.coldWritePenaltyUSD ?? '',
          per_turn_saving_usd: hookDiag?.perTurnPostSwitchSavingUSD ?? '',
          payback_turns: hookDiag?.paybackTurns ?? '',
          context_tokens: hookDiag?.cachedTokens ?? '',
          notable_allow_note: hookDiag?.notableAllowNote ?? '',
          reason: String(reason)
        };
        switchSummary = hookRecord;
        fs.appendFileSync(interceptionsPath, JSON.stringify(hookRecord) + '\n', 'utf8');
      }

      const promptObj = prompts[turn - 1];
      const beforeTurnIdx = events.length;
      const turnStartNs = process.hrtime.bigint();
      serverHandle.setContext({
        runId: spec.runId,
        arm: spec.arm,
        condition: spec.condition,
        ruleVersion: spec.ruleVersion,
        rep: spec.rep,
        attempt,
        turn,
        switchBeforeTurn: spec.switchBeforeTurn,
        phase: promptObj.phase,
        scheduledModel: turn >= spec.switchBeforeTurn ? spec.targetModel : spec.initialModel,
        effectiveModel,
        scheduledEffort: EFFORT_BASELINE
      });

      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: promptObj.prompt }
      }) + '\n');

      const { event: resEvent } = await waitForEvent(
        (e) => e.type === 'result',
        180000,
        beforeTurnIdx
      );
      completedResults += 1;
      const wallMs = Number(Number(process.hrtime.bigint() - turnStartNs) / 1e6).toFixed(2);
      if (resEvent.is_error) {
        throw new Error(`[${spec.runId} a${attempt}] Turn ${turn} returned result error: ${JSON.stringify(resEvent).slice(0, 400)}`);
      }

      const wireLines = readJsonl(wireLogPath);
      const okMain = wireLines.filter((w) =>
        !w.isSideCall &&
        w.statusCode === 200 &&
        w.context?.runId === spec.runId &&
        (w.context?.attempt || 1) === attempt &&
        w.context?.turn === turn
      );
      if (okMain.length === 0) {
        throw new Error(`[${spec.runId} a${attempt}] Turn ${turn} completed CLI without any status=200 main API response`);
      }

      const lastMain = okMain[okMain.length - 1];
      const hitPct = (Number(lastMain.usage?.cache_hit_ratio || 0) * 100).toFixed(1);
      const cumSpend = initialSpendUsd + Number(serverHandle.getState().totalSpendUsd || 0);
      console.log(
        `[Run ${runIndex + 1}/${totalRuns} ${spec.runId} a${attempt}] T${turn}/${spec.turns} | eff=${effectiveModel.replace('claude-', '')} | reqs=${okMain.length} | hit=${hitPct}% | cumSpend=$${cumSpend.toFixed(4)}`
      );

      fs.appendFileSync(cliTurnsPath, JSON.stringify({
        runId: spec.runId,
        arm: spec.arm,
        condition: spec.condition,
        ruleVersion: spec.ruleVersion,
        rep: spec.rep,
        attempt,
        turn,
        sessionId: resEvent.session_id || null,
        effectiveModel,
        wireModelsObserved: okMain.map((w) => w.responseModel || w.requestedModel),
        wallMs: Number(wallMs),
        totalCostUsd: resEvent.total_cost_usd ?? null,
        usage: resEvent.usage ?? null,
        modelUsage: resEvent.modelUsage ?? null,
        switchHook: hookRecord
      }) + '\n', 'utf8');
    }
  } finally {
    if (!childClosed) {
      child.stdin.end();
      await Promise.race([
        closePromise,
        new Promise((r) => setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          r();
        }, 5000))
      ]);
    }
  }

  const sessionEvent = events.find((e) => e.session_id);
  const sessionId = sessionEvent?.session_id || null;
  const jsonls = findSessionJsonlFiles(envSetup.cfgDir);
  if (jsonls.length > 0) {
    const mainFile = jsonls.find((p) => sessionId && p.includes(sessionId)) || jsonls[0];
    fs.mkdirSync(transcriptsDir, { recursive: true });
    // Copy raw unmodified transcript so msg_01... IDs stay intact for deterministic mapping
    fs.copyFileSync(mainFile, path.join(transcriptsDir, `${spec.runId}.jsonl`));
  }

  const allWire = readJsonl(wireLogPath);
  const runMainWire = allWire.filter((w) =>
    !w.isSideCall &&
    w.statusCode === 200 &&
    w.context?.runId === spec.runId &&
    (w.context?.attempt || 1) === attempt
  );
  const distinctWireModels = Array.from(new Set(runMainWire.map((w) => w.requestedModel)));
  const totalCostComputed = runMainWire.reduce((acc, w) => acc + Number(w.cost?.totalCostUsd || 0), 0);
  const hasAllBilled = runMainWire.length > 0 && runMainWire.every((w) => typeof w.upstreamReportedCostUsd === 'number');
  const totalCostBilled = hasAllBilled
    ? Number(runMainWire.reduce((acc, w) => acc + w.upstreamReportedCostUsd, 0).toFixed(6))
    : null;

  return {
    runId: spec.runId,
    arm: spec.arm,
    condition: spec.condition,
    ruleVersion: spec.ruleVersion,
    rep: spec.rep,
    attempt,
    turnsCompleted: completedResults,
    expectedTurns: spec.turns,
    sessionId,
    switchSummary,
    distinctWireModels,
    turnBeforeSwitchWireModel: runMainWire.find((w) => w.context?.turn === spec.switchBeforeTurn - 1)?.requestedModel || null,
    turnAtSwitchWireModel: runMainWire.find((w) => w.context?.turn === spec.switchBeforeTurn)?.requestedModel || null,
    finalTurnWireModel: runMainWire[runMainWire.length - 1]?.requestedModel || null,
    totalCostUsdBilled: totalCostBilled,
    totalCostUsdComputed: Number(totalCostComputed.toFixed(6))
  };
}

function escapeCsv(val) {
  if (val === null || val === undefined || val === '') return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function median(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function fmtMedRange(values = [], digits = 4, prefix = '', suffix = '') {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return 'N/A';
  const med = median(nums);
  if (nums.length === 1) return `${prefix}${med.toFixed(digits)}${suffix}`;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return `${prefix}${med.toFixed(digits)}${suffix} [${prefix}${lo.toFixed(digits)}${suffix}–${prefix}${hi.toFixed(digits)}${suffix}]`;
}

function fmtIntMedRange(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return 'N/A';
  const med = Math.round(median(nums));
  if (nums.length === 1) return med.toLocaleString('en-US');
  const lo = Math.round(Math.min(...nums));
  const hi = Math.round(Math.max(...nums));
  return `${med.toLocaleString('en-US')} [${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')}]`;
}

function fmtSignedUsdMedRange(values = [], digits = 4) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return 'N/A';
  const fmtOne = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(digits)}`;
  const med = median(nums);
  if (nums.length === 1) return fmtOne(med);
  return `${fmtOne(med)} [${fmtOne(Math.min(...nums))} to ${fmtOne(Math.max(...nums))}]`;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else if (ch === '"') {
      inQuotes = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadPhase1ReferenceAggs() {
  const v1Dir = path.join(RESULTS_C2_ROOT, 'rule_v1');
  const sumPath = path.join(v1Dir, 'summary.json');
  const csvPath = path.join(v1Dir, 'runs_round2_c2.csv');
  if (!fs.existsSync(sumPath) || !fs.existsSync(csvPath)) return null;

  const v1Sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
  const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (csvLines.length < 2) return null;

  const hdr = parseCsvLine(csvLines[0]);
  const mainRows = [];
  for (let i = 1; i < csvLines.length; i++) {
    const cols = parseCsvLine(csvLines[i]);
    const row = {};
    hdr.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    if (row.is_side_call === 'false') {
      mainRows.push(row);
    }
  }

  return (v1Sum.runs || [])
    .filter((r) => r.arm === 'L1' || r.arm === 'L2')
    .map((r) => {
      const spec = ARM_SPECS_C2[r.arm];
      const rows = mainRows.filter((x) => x.run_id === r.runId);
      const repMatch = String(r.runId || '').match(/_r(\d+)$/);
      const rep = Number(r.switchHook?.rep || (repMatch ? repMatch[1] : 1));
      const totalRead = rows.reduce((a, x) => a + Number(x.cache_read_input_tokens || 0), 0);
      const turnAgg = (t) => {
        const tr = rows.filter((x) => Number(x.turn) === t);
        const wr = tr.reduce((a, x) => a + Number(x.cache_creation_input_tokens || 0), 0);
        const rd = tr.reduce((a, x) => a + Number(x.cache_read_input_tokens || 0), 0);
        const inp = tr.reduce((a, x) => a + Number(x.input_tokens || 0), 0);
        const ti = inp + wr + rd;
        return {
          costUsd: tr.reduce((a, x) => a + Number(x.cost_usd || 0), 0),
          write: wr,
          readPct: ti > 0 ? (rd / ti) * 100 : 0,
          latencyMs: tr.reduce((a, x) => a + Number(x.latency_ms || 0), 0)
        };
      };
      return {
        runId: r.runId,
        arm: r.arm,
        condition: r.condition,
        ruleVersion: r.ruleVersion,
        hbEnabled: r.condition !== 'baseline_off',
        rep,
        turns: r.turnsCompleted,
        switchBeforeTurn: spec.switchBeforeTurn,
        mainReqs: r.mainReqs,
        allBilled: r.costLabel === 'billed',
        totalCostUsd: r.totalCostUsd,
        totalWrite: r.totalWrite,
        totalRead,
        cacheReadPct: r.cacheReadPct,
        tSwitch: turnAgg(spec.switchBeforeTurn),
        tPlus1: turnAgg(spec.switchBeforeTurn + 1),
        tPlus2: turnAgg(spec.switchBeforeTurn + 2),
        distinctModels: r.distinctModels || [],
        hook: r.switchHook || null
      };
    });
}

function buildTruncatedPreSwitchTranscript(srcPath, maxUserTurns, destPath) {
  const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const kept = [];
  let humanTurnsSeen = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === 'user' && (obj?.message?.role === 'user' || !obj?.message)) {
      const content = obj?.message?.content;
      const isHumanPrompt =
        typeof content === 'string'
          ? content.trim().length > 0
          : Array.isArray(content) && content.some((b) => b && b.type !== 'tool_result');
      if (isHumanPrompt) {
        humanTurnsSeen += 1;
        if (humanTurnsSeen > maxUserTurns) break;
      }
    }
    kept.push(line);
  }
  fs.writeFileSync(destPath, kept.join('\n') + '\n', 'utf8');
}

function computeFlipHorizons(payback) {
  if (!Number.isFinite(payback) || payback <= 0) {
    return { flipContinuous: 0, maxIntAsk: null, minIntAllow: 0 };
  }
  const minAllow = Math.ceil(payback);
  const maxAsk = Number.isInteger(payback) ? payback - 1 : minAllow - 1;
  return {
    flipContinuous: Number(payback.toFixed(4)),
    maxIntAsk: maxAsk,
    minIntAllow: minAllow
  };
}

function computeOfflineL2HorizonTable() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-l1-l2-offline-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const armConfigs = [
    {
      arm: 'L1',
      switchTurn: 3,
      preSwitchTurns: 2,
      context_tokens: 11970,
      transcriptSrc: path.join(RESULTS_C2_ROOT, 'rule_v1', 'raw', 'transcripts', 'C2_L1_hb_rule_v1_r01.jsonl'),
      measured: {
        expected_output_tokens: 181,
        cold_write_penalty_usd: 0.0302,
        per_turn_saving_usd: 0.0058,
        payback_turns: 5.3
      }
    },
    {
      arm: 'L2',
      switchTurn: 24,
      preSwitchTurns: 23,
      context_tokens: 19131,
      transcriptSrc: path.join(RESULTS_C2_ROOT, 'rule_v1', 'raw', 'transcripts', 'C2_L2_hb_rule_v1_r03.jsonl'),
      measured: {
        expected_output_tokens: 182,
        cold_write_penalty_usd: 0.0608,
        per_turn_saving_usd: 0.0059,
        payback_turns: 10.3
      }
    }
  ];
  const horizons = [3, 6, 12, 30, 'unguided_prior'];
  const rows = [];

  try {
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    activateLocalTrial({ homeDir: tmpDir });

    for (const cfg of armConfigs) {
      const calSessionId = `offline_cal_${cfg.arm}`;
      const txPath = path.join(tmpDir, `${calSessionId}_preswitch.jsonl`);
      buildTruncatedPreSwitchTranscript(cfg.transcriptSrc, cfg.preSwitchTurns, txPath);
      const stopRes = runStopGateHook(
        { session_id: calSessionId, transcript_path: txPath, cwd: tmpDir },
        { cwd: tmpDir, homeDir: tmpDir, persistState: false }
      );
      const stopCal = stopRes?.sessionCalibration;

      let calibratedUnguidedRem = null;
      let calibratedTurnsUsed = stopCal?.turnsCompleted ?? cfg.preSwitchTurns;

      for (const profileName of ['uncalibrated', 'calibrated', 'measured']) {
        for (const h of horizons) {
          const isPrior = h === 'unguided_prior';
          if (profileName === 'measured') {
            const m = cfg.measured;
            const rem = isPrior ? (calibratedUnguidedRem ?? (cfg.arm === 'L1' ? 59 : 47)) : Number(h);
            const flip = computeFlipHorizons(m.payback_turns);
            const hold = rem < m.payback_turns;
            rows.push({
              arm: cfg.arm,
              profile: 'measured',
              turns_completed_used: calibratedTurnsUsed,
              context_tokens: cfg.context_tokens,
              expected_output_tokens: m.expected_output_tokens,
              output_estimate_source: 'empirical_paired_runs',
              uncached_delta_tokens: 0,
              horizon_spec: String(h),
              effective_remaining_turns: rem,
              prior_source: isPrior ? 'placeholder_antigravity_496_prior' : 'explicit',
              break_even_c_star: null,
              cold_write_penalty_usd: m.cold_write_penalty_usd,
              per_turn_saving_usd: m.per_turn_saving_usd,
              payback_turns: m.payback_turns,
              flip_horizon_continuous: flip.flipContinuous,
              max_int_horizon_ask: flip.maxIntAsk,
              min_int_horizon_allow: flip.minIntAllow,
              horizon_net_savings_usd: Number((rem * m.per_turn_saving_usd - m.cold_write_penalty_usd).toFixed(6)),
              should_hold_model: hold,
              hook_decision: hold ? 'ask' : 'allow',
              requests_per_turn: stopCal?.requestsPerTurn ?? '',
              prior_bucket: isPrior ? 'placeholder_bucket' : 'explicit_turns',
              horizon_unit: 'turns',
              prior_native_unit: isPrior ? 'api_requests' : 'turns',
              rolling_output_median_raw: m.expected_output_tokens,
              rolling_output_sample_size: '',
              shrinkage_weight: 1
            });
            continue;
          }

          const isCalibrated = profileName === 'calibrated';
          const res = runPreModelSwitchHook(
            {
              hook_event_name: 'PreModelSwitch',
              session_id: isCalibrated ? calSessionId : `offline_uncal_${cfg.arm}`,
              from_model: MODEL_A_CLI,
              to_model: MODEL_B_CLI,
              context_tokens: cfg.context_tokens,
              uncached_delta_tokens: 0,
              prompt_cache_warm: true,
              cache_ttl: '5m',
              mode: 'AUTO_PILOT',
              ...(isCalibrated
                ? {}
                : { expectedOutputTokens: 1500, useObservedOutputTokens: false }),
              ...(isPrior ? { use_empirical_horizon_prior: true } : { expected_remaining_turns: h })
            },
            {
              cwd: tmpDir,
              homeDir: tmpDir,
              recordLedger: false,
              useSessionCalibration: isCalibrated
            }
          );
          const v = res.verdict || {};
          const b = v.breakEven || {};
          if (isCalibrated && isPrior) {
            calibratedUnguidedRem = b.expectedRemainingTurns ?? null;
          }
          const flip = computeFlipHorizons(Number(b.paybackTurns ?? 0));
          rows.push({
            arm: cfg.arm,
            profile: profileName,
            turns_completed_used: v.turnsCompletedUsed ?? 0,
            context_tokens: cfg.context_tokens,
            expected_output_tokens: b.expectedOutputTokens ?? null,
            output_estimate_source: v.outputEstimateSource || 'default_1500',
            uncached_delta_tokens: 0,
            horizon_spec: String(h),
            effective_remaining_turns: b.expectedRemainingTurns ?? null,
            prior_source: b.horizonPriorSource || '',
            break_even_c_star: b.breakEvenTokens ?? null,
            cold_write_penalty_usd: b.coldWritePenaltyUSD ?? null,
            per_turn_saving_usd: b.perTurnPostSwitchSavingUSD ?? null,
            payback_turns: b.paybackTurns ?? null,
            flip_horizon_continuous: flip.flipContinuous,
            max_int_horizon_ask: flip.maxIntAsk,
            min_int_horizon_allow: flip.minIntAllow,
            horizon_net_savings_usd: b.horizonNetSavingsUSD ?? null,
            should_hold_model: Boolean(b.shouldHoldModel),
            hook_decision: v.decision || 'unknown',
            requests_per_turn: b.requestsPerTurn ?? '',
            prior_bucket: b.priorBucket ?? '',
            horizon_unit: b.horizonUnit ?? 'turns',
            prior_native_unit: b.priorNativeUnit ?? '',
            rolling_output_median_raw: v.rawRollingMedianOutputTokens ?? '',
            rolling_output_sample_size: v.outputSampleSize ?? '',
            shrinkage_weight: v.shrinkageWeight ?? ''
          });
        }
      }
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return rows;
}

function buildDeliverableCsvsAndReports(outDir, schedule, meta = {}) {
  const rawDir = path.join(outDir, 'raw');
  const wireLogPath = path.join(rawDir, 'proxy_wire_log.jsonl');
  const interceptionsPath = path.join(rawDir, 'interceptions_live.jsonl');
  const checkpointPath = path.join(rawDir, 'checkpoint.json');
  const ledgerPath = path.join(rawDir, 'openrouter_ledger.jsonl');
  const transcriptsDir = path.join(rawDir, 'transcripts');

  const cp = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(cpPathSafe(checkpointPath), 'utf8')) : { runs: {} };
  const wireLogs = readJsonl(wireLogPath);
  const intLogs = readJsonl(interceptionsPath);
  const ledgerRows = readJsonl(ledgerPath);

  const specById = new Map(schedule.map((s) => [s.runId, s]));
  const countsByRunAttemptTurn = new Map();
  for (const w of wireLogs) {
    if (w.isSideCall || w.statusCode !== 200) continue;
    const runId = w.context?.runId || '';
    const att = w.context?.attempt || 1;
    const winAtt = cp.runs?.[runId]?.attempt || 1;
    if (att !== winAtt) continue;
    const k = `${runId}::T${w.context?.turn}`;
    countsByRunAttemptTurn.set(k, (countsByRunAttemptTurn.get(k) || 0) + 1);
  }

  const txCache = new Map();
  const getTxMap = (runId) => {
    if (!txCache.has(runId)) {
      txCache.set(runId, parseTranscriptUsageMap(path.join(transcriptsDir, `${runId}.jsonl`)));
    }
    return txCache.get(runId);
  };

  let mainRowsCount = 0;
  let sideRowsCount = 0;
  let abortedRowsCount = 0;
  let sourceBothCount = 0;
  let sourceDisagreementCount = 0;
  let billedCostCount = 0;
  let fallbackComputedCostCount = 0;
  let sideCostTotalUsd = 0;

  const seenIdx = new Map();
  const sortedWire = [...wireLogs].sort((a, b) => a.wireSeq - b.wireSeq);
  const mainRowsData = [];

  const csvRows = sortedWire.map((w) => {
    const runId = w.context?.runId || '';
    const turn = w.context?.turn ?? '';
    const att = w.context?.attempt || 1;
    const winAtt = cp.runs?.[runId]?.attempt || 1;
    const isAbortedAttempt = Boolean(cp.runs?.[runId]) && att !== winAtt;
    const spec = specById.get(runId);

    if (isAbortedAttempt) {
      abortedRowsCount += 1;
      return [
        `${runId}_aborted_a${att}`,
        w.context?.arm || '',
        w.context?.rep ?? '',
        '',
        turn,
        'none',
        Boolean(w.isSideCall),
        w.mappedModel || mapCliModelToOpenRouter(w.requestedModel || ''),
        EFFORT_BASELINE,
        'small',
        w.timestamp || '',
        '',
        '',
        '',
        '',
        w.timing?.latencyMs ?? '',
        '',
        w.mockMode ? 'mock_sse' : 'proxy',
        `aborted_attempt_before_retry; token_cost_and_index_columns_blank; condition=${w.context?.condition || ''}; rule=${w.context?.ruleVersion || ''}`,
        '',
        ''
      ].map(escapeCsv).join(',');
    }

    if (w.isSideCall) {
      sideRowsCount += 1;
      const scCost = typeof w.upstreamReportedCostUsd === 'number'
        ? w.upstreamReportedCostUsd
        : Number(w.cost?.totalCostUsd || 0);
      sideCostTotalUsd += scCost;
      return [
        runId,
        w.context?.arm || '',
        w.context?.rep ?? '',
        `sess_${runId}`,
        turn,
        'none',
        true,
        w.mappedModel || mapCliModelToOpenRouter(w.requestedModel || ''),
        EFFORT_BASELINE,
        'small',
        w.timestamp || '',
        '',
        '',
        '',
        '',
        w.timing?.latencyMs ?? '',
        '',
        w.mockMode ? 'mock_sse' : 'proxy',
        `side_call_count_tokens; token_cost_and_index_columns_blank; endpoint=${w.urlPath || ''}; status=${w.statusCode ?? ''}; condition=${w.context?.condition || ''}; rule=${w.context?.ruleVersion || ''}`,
        '',
        ''
      ].map(escapeCsv).join(',');
    }

    if (w.statusCode !== 200) return null;

    mainRowsCount += 1;
    const k = `${runId}::T${turn}`;
    const reqIdx = (seenIdx.get(k) || 0) + 1;
    seenIdx.set(k, reqIdx);
    const reqTotal = countsByRunAttemptTurn.get(k) || 1;

    const u = w.usage || {};
    const wireUsage = {
      input_tokens: Number(u.input_tokens || 0),
      cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0),
      cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
      output_tokens: Number(u.output_tokens || 0)
    };
    const txMap = getTxMap(runId);
    const txUsage = w.messageId ? txMap.get(w.messageId) : null;
    const agrees = Boolean(
      txUsage &&
      txUsage.input_tokens === wireUsage.input_tokens &&
      txUsage.cache_creation_input_tokens === wireUsage.cache_creation_input_tokens &&
      txUsage.cache_read_input_tokens === wireUsage.cache_read_input_tokens &&
      txUsage.output_tokens === wireUsage.output_tokens
    );
    if (agrees) sourceBothCount += 1;
    else sourceDisagreementCount += 1;

    const hasBilled = typeof w.upstreamReportedCostUsd === 'number';
    const costVal = hasBilled ? w.upstreamReportedCostUsd : Number(w.cost?.totalCostUsd || 0);
    if (hasBilled) billedCostCount += 1;
    else fallbackComputedCostCount += 1;

    const costTag = w.mockMode ? 'mock_computed' : (hasBilled ? 'openrouter_billed' : 'computed_fallback');
    const eventVal = reqIdx === 1 && turn === (w.context?.switchBeforeTurn ?? spec?.switchBeforeTurn)
      ? 'model_switch'
      : (reqIdx > 1 ? 'tool_continuation' : 'message');
    const sourceVal = agrees ? 'both' : (w.mockMode ? 'mock_sse' : 'proxy_transcript_mismatch');
    const modelStr = w.mappedModel || mapCliModelToOpenRouter(w.responseModel || w.requestedModel || '');

    mainRowsData.push({
      runId,
      arm: w.context?.arm || '',
      rep: Number(w.context?.rep || 1),
      condition: w.context?.condition || '',
      ruleVersion: w.context?.ruleVersion || '',
      turn: Number(turn),
      event: eventVal,
      model: modelStr,
      ...wireUsage,
      latencyMs: Number(w.timing?.latencyMs || 0),
      costUsd: costVal,
      isBilled: hasBilled,
      source: sourceVal
    });

    return [
      runId,
      w.context?.arm || '',
      w.context?.rep ?? '',
      `sess_${runId}`,
      turn,
      eventVal,
      false,
      modelStr,
      w.requestFingerprint?.output_config?.effort || EFFORT_BASELINE,
      'small',
      w.timestamp || '',
      wireUsage.input_tokens,
      wireUsage.cache_creation_input_tokens,
      wireUsage.cache_read_input_tokens,
      wireUsage.output_tokens,
      w.timing?.latencyMs ?? '',
      costVal,
      sourceVal,
      `condition=${w.context?.condition || ''}; rule=${w.context?.ruleVersion || ''}; cost_source=${costTag}; mode=${w.mockMode ? 'mock_sse' : 'live_openrouter'}`,
      reqIdx,
      reqTotal
    ].map(escapeCsv).join(',');
  }).filter(Boolean);

  fs.writeFileSync(path.join(outDir, 'runs_round2_c2.csv'), [CSV_HEADERS.join(','), ...csvRows].join('\n') + '\n', 'utf8');

  const winningInts = intLogs.filter((r) => {
    const winAtt = cp.runs?.[r.run_id]?.attempt || 1;
    return (r.attempt || 1) === winAtt;
  });
  const intRows = winningInts.map((r) => INTERCEPTIONS_HEADERS.map((h) => escapeCsv(r[h])).join(','));
  fs.writeFileSync(path.join(outDir, 'interceptions_round2_c2.csv'), [INTERCEPTIONS_HEADERS.join(','), ...intRows].join('\n') + '\n', 'utf8');

  // Compute run-level aggregates for summary & JSON
  const runAggs = schedule.map((spec) => {
    const rows = mainRowsData.filter((r) => r.runId === spec.runId);
    const totalCostUsd = rows.reduce((a, r) => a + r.costUsd, 0);
    const totalWrite = rows.reduce((a, r) => a + r.cache_creation_input_tokens, 0);
    const totalRead = rows.reduce((a, r) => a + r.cache_read_input_tokens, 0);
    const totalIn = rows.reduce((a, r) => a + r.input_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens, 0);
    const cacheReadPct = totalIn > 0 ? (totalRead / totalIn) * 100 : 0;

    const turnAgg = (t) => {
      const tr = rows.filter((r) => r.turn === t);
      const wr = tr.reduce((a, r) => a + r.cache_creation_input_tokens, 0);
      const rd = tr.reduce((a, r) => a + r.cache_read_input_tokens, 0);
      const ti = tr.reduce((a, r) => a + r.input_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens, 0);
      return {
        costUsd: tr.reduce((a, r) => a + r.costUsd, 0),
        write: wr,
        readPct: ti > 0 ? (rd / ti) * 100 : 0,
        latencyMs: tr.reduce((a, r) => a + r.latencyMs, 0)
      };
    };

    const hook = winningInts.find((i) => i.run_id === spec.runId) || null;
    const distinctModels = Array.from(new Set(rows.map((r) => r.model)));
    return {
      ...spec,
      mainReqs: rows.length,
      allBilled: rows.length > 0 && rows.every((r) => r.isBilled),
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalWrite,
      totalRead,
      cacheReadPct: Number(cacheReadPct.toFixed(2)),
      tSwitch: turnAgg(spec.switchBeforeTurn),
      tPlus1: turnAgg(spec.switchBeforeTurn + 1),
      tPlus2: turnAgg(spec.switchBeforeTurn + 2),
      distinctModels,
      hook
    };
  });

  const keyStart = ledgerRows.find((r) => r.event === 'start') || null;
  const keySettled = [...ledgerRows].reverse().find((r) => r.event === 'settled_after_12m_idle' || r.event === 'settled') || null;
  const keyImmediateEnd = [...ledgerRows].reverse().find((r) => r.event === 'end') || null;
  const keyEnd = keySettled || keyImmediateEnd;
  const openRouterDeltaUsd = (typeof keyStart?.usage === 'number' && typeof keyEnd?.usage === 'number')
    ? Number((keyEnd.usage - keyStart.usage).toFixed(6))
    : null;
  const immediateOpenRouterDeltaUsd = (typeof keyStart?.usage === 'number' && typeof keyImmediateEnd?.usage === 'number')
    ? Number((keyImmediateEnd.usage - keyStart.usage).toFixed(6))
    : null;

  const isLiveMode = meta.isLive ?? (!mainRowsData.some((r) => r.source === 'mock_sse') && billedCostCount > 0);
  const costKindLabel = isLiveMode && fallbackComputedCostCount === 0 ? 'billed' : 'computed';
  const highbeamCommit = cp.highbeamCommit || meta.highbeamCommit || getRepoGitHead();
  const startedAt = cp.startedAt || meta.startedAt || new Date().toISOString();
  const finishedAt = meta.finishedAt || keyEnd?.timestamp || new Date().toISOString();
  const claudeVer = meta.claudeCodeVersion || PINNED_CLAUDE_CODE_VERSION;
  const ruleVer = cp.ruleVersion || meta.ruleVersion || 'rule_v1';
  const fmtSignedIntMedRange = (values = []) => {
    const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (nums.length === 0) return 'N/A';
    const fmtOne = (v) => `${v >= 0 ? '+' : '-'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
    const med = median(nums);
    if (nums.length === 1) return fmtOne(med);
    return `${fmtOne(med)} [${fmtOne(Math.min(...nums))} to ${fmtOne(Math.max(...nums))}]`;
  };
  const pairDeltas = (targetRuns, refRuns, getter) => targetRuns.map((tr) => {
    const match = refRuns.find((rr) => rr.rep === tr.rep);
    return match ? getter(tr) - getter(match) : null;
  }).filter((v) => v !== null);

  const cellSummaries = ['L1', 'L2', 'U1'].filter((a) => runAggs.some((r) => r.arm === a)).map((armCode) => {
    const spec = ARM_SPECS_C2[armCode];
    const offRuns = runAggs.filter((r) => r.arm === armCode && !r.hbEnabled);
    const hbRuns = runAggs.filter((r) => r.arm === armCode && r.hbEnabled);
    const deltasCost = pairDeltas(hbRuns, offRuns, (r) => r.totalCostUsd);
    const deltasWrite = pairDeltas(hbRuns, offRuns, (r) => r.totalWrite);
    return { armCode, spec, offRuns, hbRuns, deltasCost, deltasWrite };
  });

  const isRuleV2Family = String(ruleVer || '').startsWith('rule_v2');
  const phase1Refs = isRuleV2Family ? loadPhase1ReferenceAggs() : null;
  const offlineHorizonTableL2 = isRuleV2Family ? computeOfflineL2HorizonTable() : null;

  if (offlineHorizonTableL2) {
    const offlineHdr = [
      'arm',
      'profile',
      'turns_completed_used',
      'context_tokens',
      'expected_output_tokens',
      'output_estimate_source',
      'uncached_delta_tokens',
      'horizon_spec',
      'effective_remaining_turns',
      'prior_source',
      'break_even_c_star',
      'cold_write_penalty_usd',
      'per_turn_saving_usd',
      'payback_turns',
      'flip_horizon_continuous',
      'max_int_horizon_ask',
      'min_int_horizon_allow',
      'horizon_net_savings_usd',
      'should_hold_model',
      'hook_decision',
      'requests_per_turn',
      'prior_bucket',
      'horizon_unit',
      'prior_native_unit',
      'rolling_output_median_raw',
      'rolling_output_sample_size',
      'shrinkage_weight'
    ];
    const offlineCsv = [
      offlineHdr.join(','),
      ...offlineHorizonTableL2.map((r) => offlineHdr.map((h) => escapeCsv(r[h])).join(','))
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(outDir, 'offline_horizon_table_l2.csv'), offlineCsv, 'utf8');
    fs.writeFileSync(path.join(outDir, 'offline_decision_table_l1_l2.csv'), offlineCsv, 'utf8');
  }

  let phase1Comparison = null;
  if (phase1Refs && phase1Refs.length > 0) {
    const buildArmComp = (armCode) => {
      const v2Runs = runAggs.filter((r) => r.arm === armCode && r.hbEnabled);
      if (v2Runs.length === 0) return null;
      const offRefs = phase1Refs.filter((r) => r.arm === armCode && r.condition === 'baseline_off');
      const v1Refs = phase1Refs.filter((r) => r.arm === armCode && r.condition === 'highbeam_auto');
      const v2VsOffCost = pairDeltas(v2Runs, offRefs, (r) => r.totalCostUsd);
      const v2VsOffWrite = pairDeltas(v2Runs, offRefs, (r) => r.totalWrite);
      const v2VsV1Cost = pairDeltas(v2Runs, v1Refs, (r) => r.totalCostUsd);
      const v2VsV1Write = pairDeltas(v2Runs, v1Refs, (r) => r.totalWrite);
      const v1VsOffCost = pairDeltas(v1Refs, offRefs, (r) => r.totalCostUsd);
      const v1VsOffWrite = pairDeltas(v1Refs, offRefs, (r) => r.totalWrite);
      return {
        armCode,
        v2Runs,
        offRefs,
        v1Refs,
        v2VsOffCost,
        v2VsOffWrite,
        v2VsV1Cost,
        v2VsV1Write,
        v1VsOffCost,
        v1VsOffWrite
      };
    };
    phase1Comparison = {
      l1: buildArmComp('L1'),
      l2: buildArmComp('L2')
    };
  }

  const reportJson = {
    mode: isLiveMode ? 'live_openrouter' : 'mock_dry_run_zero_cost',
    ruleVersion: ruleVer,
    claudeCodeVersion: claudeVer,
    pinnedRepoCommit: PINNED_REPO_COMMIT,
    highbeamCommit,
    startedAt,
    finishedAt,
    runCount: runAggs.length,
    csvStats: {
      mainRowsCount,
      sideRowsCount,
      abortedRowsCount,
      sourceBothCount,
      sourceDisagreementCount,
      billedCostCount,
      fallbackComputedCostCount
    },
    openRouter: {
      usageBeforeUsd: keyStart?.usage ?? null,
      usageAfterUsd: keyEnd?.usage ?? null,
      usageAfterImmediateUsd: keyImmediateEnd?.usage ?? null,
      settledTimestamp: keySettled?.timestamp ?? null,
      deltaBilledUsd: openRouterDeltaUsd,
      immediateDeltaBilledUsd: immediateOpenRouterDeltaUsd,
      remainingAfterUsd: keyEnd?.limit_remaining ?? null,
      proxyBilledRowsSumUsd: Number(mainRowsData.reduce((a, r) => a + r.costUsd, 0).toFixed(6)),
      sideCallsBilledSumUsd: Number(sideCostTotalUsd.toFixed(6)),
      totalWireBilledSumUsd: Number((mainRowsData.reduce((a, r) => a + r.costUsd, 0) + sideCostTotalUsd).toFixed(6))
    },
    ...(phase1Comparison ? {
      phase1Comparison: {
        l1: phase1Comparison.l1 ? {
          v2VsOffPairedCostDeltaUsd: phase1Comparison.l1.v2VsOffCost.map((v) => Number(v.toFixed(6))),
          v2VsV1PairedCostDeltaUsd: phase1Comparison.l1.v2VsV1Cost.map((v) => Number(v.toFixed(6))),
          v1VsOffPairedCostDeltaUsd: phase1Comparison.l1.v1VsOffCost.map((v) => Number(v.toFixed(6))),
          prePhase1ComputedHoldDeltaUsd: 0.1463
        } : null,
        l2: phase1Comparison.l2 ? {
          v2VsOffR01CostDeltaUsd: phase1Comparison.l2.v2VsOffCost.map((v) => Number(v.toFixed(6))),
          v2VsV1R01CostDeltaUsd: phase1Comparison.l2.v2VsV1Cost.map((v) => Number(v.toFixed(6))),
          v2VsOffMedian3CostDeltaUsd: phase1Comparison.l2.offRefs.length > 0 && phase1Comparison.l2.v2Runs.length === 1
            ? Number((phase1Comparison.l2.v2Runs[0].totalCostUsd - median(phase1Comparison.l2.offRefs.map((r) => r.totalCostUsd))).toFixed(6))
            : null,
          v2VsV1Median3CostDeltaUsd: phase1Comparison.l2.v1Refs.length > 0 && phase1Comparison.l2.v2Runs.length === 1
            ? Number((phase1Comparison.l2.v2Runs[0].totalCostUsd - median(phase1Comparison.l2.v1Refs.map((r) => r.totalCostUsd))).toFixed(6))
            : null
        } : null
      }
    } : {}),
    ...(offlineHorizonTableL2 ? { offlineHorizonTableL2 } : {}),
    runs: runAggs.map((r) => ({
      runId: r.runId,
      arm: r.arm,
      condition: r.condition,
      ruleVersion: r.ruleVersion,
      turnsCompleted: r.turns,
      mainReqs: r.mainReqs,
      distinctModels: r.distinctModels,
      totalCostUsd: r.totalCostUsd,
      costLabel: r.allBilled ? 'billed' : 'computed',
      totalWrite: r.totalWrite,
      cacheReadPct: r.cacheReadPct,
      switchHook: r.hook
    }))
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(reportJson, null, 2) + '\n', 'utf8');

  const countByArm = (armCode) => runAggs.filter((r) => r.arm === armCode).length;
  const runCountsLine = isRuleV2Family
    ? `- **Run Counts (\`${ruleVer}\` Highbeam-only):** \`L1\` (${countByArm('L1')} Highbeam run(s)), \`L2\` (${countByArm('L2')} Highbeam run(s)); Phase 1 \`baseline_off\` (\`n=3\`) and \`highbeam_rule_v1\` (\`n=3\`) references reused from \`results/round2_c2/rule_v1/\`; \`U1\` skipped (\`0\` runs; unchanged from Phase 1); aborted retry attempts recorded: ${abortedRowsCount} wire rows.`
    : `- **Run Counts:** \`L1\` (${countByArm('L1')} runs), \`L2\` (${countByArm('L2')} runs), \`U1\` (${countByArm('U1')} runs); aborted retry attempts recorded: ${abortedRowsCount} wire rows.`;

  // Write manifest_round2_c2.md
  const manifestLines = [
    `# Round 2 C2 Benchmark Manifest (\`${ruleVer}\`)`,
    '',
    `- **Route:** OpenRouter (\`https://openrouter.ai/api/v1/messages\`, upstream \`provider: { only: ["anthropic"], allow_fallbacks: false }\`) — ${isLiveMode ? '**live API traffic**' : '**zero-cost localhost mock SSE dry-run**'}. Cache behavior and cost may differ on the direct Anthropic API.`,
    `- **Tool & OS:** ${claudeVer} on Windows (\`${process.platform} ${process.arch}\`)`,
    `- **Batch Window (UTC):** \`${startedAt}\` to \`${finishedAt}\``,
    `- **Target Frozen Repo:** commit \`${PINNED_REPO_COMMIT}\` (cleaned via \`git checkout -f\` and \`git clean -fdx\` before every run)`,
    `- **Highbeam Revision:** branch \`round2-c1-fixes\`, commit \`${highbeamCommit}\`, rule config \`${ruleVer}\` (\`AUTO_PILOT\`, local trial license, \`PreModelSwitch\` native default \`permissionDecision: "ask"\`${isRuleV2Family ? ', `useEmpiricalHorizonPrior: true`' : ''})`,
    '- **Invocation Method:** Persistent `claude.exe -p --input-format stream-json --output-format stream-json --verbose --include-hook-events --dangerously-skip-permissions --tools Read --effort medium --settings <settingsPath> --setting-sources local` with SDK `control_request: { subtype: "set_model", model }` sent before `switchBeforeTurn`.',
    '- **Models & Effort:** `anthropic/claude-opus-4.6` (`claude-opus-4-6`), `anthropic/claude-sonnet-4.6` (`claude-sonnet-4-6`), `effort = medium`, API-key `5m` ephemeral cache tier.',
    '- **Cost Accounting:** OpenRouter `usage.cost` (`billed`) when present (`' + billedCostCount + '/' + mainRowsCount + '` main rows); fallback to `PRICING_PER_1M` (`computed`, `' + fallbackComputedCostCount + '` rows).',
    ...(isRuleV2Family ? [
      '- **Placeholder Empirical Survival Prior (`EMPIRICAL_SESSION_API_CALL_PRIOR`, `isPlaceholderPrior: true`):** Placeholder distribution built from `496` Antigravity IDE workstation transcripts (`120` interactive multi-turn + `376` single-prompt/subagent sessions, NOT Claude Code telemetry; runtime override scans `~/.claude/projects/**/*.jsonl` when `>= 5` deduplicated local transcripts exist, absent in clean isolated benchmark temp homes). Native bucket residuals (`+59`, `+47`, etc.) are in **`api_requests`** and are converted to **`turns`** via observed `requestsPerTurn`.'
    ] : []),
    '',
    '## Price Table Used for Fallback / Attribution (`PRICING_PER_1M`, USD per 1M tokens)',
    '',
    '| Model | Input | 5m Cache Write (1.25x) | 1h Cache Write (2.0x) | Cache Read (0.1x) | Output |',
    '|---|---:|---:|---:|---:|---:|',
    `| \`anthropic/claude-opus-4.6\` | $${PRICING_PER_1M['anthropic/claude-opus-4.6'].input.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-opus-4.6'].write5m.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-opus-4.6'].write1h.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-opus-4.6'].read.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-opus-4.6'].output.toFixed(2)} |`,
    `| \`anthropic/claude-sonnet-4.6\` | $${PRICING_PER_1M['anthropic/claude-sonnet-4.6'].input.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-sonnet-4.6'].write5m.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-sonnet-4.6'].write1h.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-sonnet-4.6'].read.toFixed(2)} | $${PRICING_PER_1M['anthropic/claude-sonnet-4.6'].output.toFixed(2)} |`,
    '',
    '## Prompt List & Sample Counts (`small` Tier Fixed Workload)',
    '- **Turns 1–12:** `fixtures/prompts_small.json` (`Read` slices of `billingBlocks.mjs`, `dualTtl.mjs`, `cliffBreaker.mjs` in T1–T3; zero-tool analytical prompts T4–T12).',
    '- **Turns 13–30 (`L1`/`L2` only):** 18 deterministic zero-tool prompts restricted to the already-loaded T1–T3 file slices.',
    runCountsLine,
    `- **Transcript Verification:** \`${sourceBothCount}/${mainRowsCount}\` main rows matched on all 4 token fields (\`source = both\`), disagreements = ${sourceDisagreementCount}.`
  ];
  fs.writeFileSync(path.join(outDir, 'manifest_round2_c2.md'), manifestLines.join('\n') + '\n', 'utf8');

  // Write summary_round2_c2.md
  const modeLabel = isLiveMode ? 'live' : 'mock';
  const summaryLines = [
    `# Round 2 C2 Live Validation Summary (\`${ruleVer}\`)`,
    '',
    `> **Route & Disclosure (\`${modeLabel}\`):** Traffic ran via OpenRouter (\`https://openrouter.ai/api/v1/messages\`, Anthropic provider pinned, \`allow_fallbacks: false\`); cache behavior and cost may differ on the direct Anthropic API. Tested under API-key \`5m\` cache TTL rules (\`ephemeral_1h_input_tokens = 0\`) with ${claudeVer} on Windows (\`${startedAt.slice(0, 10)}\` UTC) and Highbeam commit \`${highbeamCommit}\` (\`${ruleVer}\`). All latency values are directional only due to proxy + OpenRouter routing. Transcript-vs-proxy reconciliation matched on **${sourceBothCount}/${mainRowsCount}** main requests (\`source = both\`, \`${sourceDisagreementCount}\` disagreements).`,
    '',
    `## 1. Native \`PreModelSwitch\` SDK \`set_model\` Interception (\`${modeLabel}\` / \`AUTO_PILOT\`)`,
    '',
    '| Run ID | Switch Turn | Hook Event | Permission Decision | Control Subtype (`error_code`) | Distinct Wire Models | Sanitized Hook Reason |',
    '|---|---:|---|---|---|---|---|',
    ...runAggs.filter((r) => r.hbEnabled).map((r) => {
      const h = r.hook || {};
      const errCode = h.control_error_code ? ` (\`${h.control_error_code}\`)` : '';
      return `| \`${r.runId}\` | T${r.switchBeforeTurn} | \`${h.hook_event || 'none'}\` | \`${h.permission_decision || 'n/a'}\` | \`${h.control_subtype || 'n/a'}\`${errCode} | \`${r.distinctModels.join(' -> ')}\` | ${String(h.reason || 'pass-through allow').replace(/\|/g, '/')} |`;
    }),
    ''
  ];

  if (isRuleV2Family && phase1Comparison) {
    summaryLines.push(
      '*(Phase 1 `baseline_off` and `highbeam_rule_v1` reference runs come from `results/round2_c2/rule_v1/` on the identical frozen commit and API-key route.)*',
      '',
      `## 2. Session-Level Results (\`${modeLabel}\` — \`median [min–max]\` for \`n > 1\`, single value for \`n = 1\`)`,
      '',
      `| Arm | Condition | n | Total Cost (\`${costKindLabel}\`) | Paired Delta vs Off (\`${costKindLabel}\`) | Delta vs \`rule_v1\` Hold (\`${costKindLabel}\`) | Cache Write Tokens | Paired Write Delta vs Off | Cache Read Share | Main API Reqs |`,
      '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    );

    if (phase1Comparison.l1) {
      const { v2Runs, offRefs, v1Refs, v2VsOffCost, v2VsOffWrite, v2VsV1Cost, v1VsOffCost, v1VsOffWrite } = phase1Comparison.l1;
      const condLabelL1 = ruleVer === 'rule_v2_calibrated'
        ? `\`highbeam_${ruleVer}\` *(unguided prior, ${modeLabel})*`
        : `\`highbeam_${ruleVer}\` *(Phase 2 ${modeLabel})*`;
      summaryLines.push(
        `| \`L1\` (30t, @T3) | \`baseline_off\` *(Phase 1 ref)* | ${offRefs.length} | ${fmtMedRange(offRefs.map((r) => r.totalCostUsd), 4, '$')} | — | — | ${fmtIntMedRange(offRefs.map((r) => r.totalWrite))} | — | ${fmtMedRange(offRefs.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(offRefs.map((r) => r.mainReqs))} |`,
        `| \`L1\` (30t, @T3) | \`highbeam_rule_v1\` *(Phase 1 hold ref)* | ${v1Refs.length} | ${fmtMedRange(v1Refs.map((r) => r.totalCostUsd), 4, '$')} | ${fmtSignedUsdMedRange(v1VsOffCost, 4)} | — | ${fmtIntMedRange(v1Refs.map((r) => r.totalWrite))} | ${fmtSignedIntMedRange(v1VsOffWrite)} | ${fmtMedRange(v1Refs.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(v1Refs.map((r) => r.mainReqs))} |`,
        `| \`L1\` (30t, @T3) | ${condLabelL1} | ${v2Runs.length} | ${fmtMedRange(v2Runs.map((r) => r.totalCostUsd), 4, '$')} | ${fmtSignedUsdMedRange(v2VsOffCost, 4)} | ${fmtSignedUsdMedRange(v2VsV1Cost, 4)} | ${fmtIntMedRange(v2Runs.map((r) => r.totalWrite))} | ${fmtSignedIntMedRange(v2VsOffWrite)} | ${fmtMedRange(v2Runs.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(v2Runs.map((r) => r.mainReqs))} |`
      );
    }

    if (phase1Comparison.l2) {
      const { v2Runs, offRefs, v1Refs, v2VsOffCost, v2VsOffWrite, v2VsV1Cost } = phase1Comparison.l2;
      const offR01 = offRefs.find((r) => r.rep === 1);
      const v1R01 = v1Refs.find((r) => r.rep === 1);
      const v1Med = median(v1Refs.map((r) => r.totalCostUsd));
      const offMed = median(offRefs.map((r) => r.totalCostUsd));
      const v1VsOffMedCost = pairDeltas(v1Refs, offRefs, (r) => r.totalCostUsd);
      const v1VsOffMedWrite = pairDeltas(v1Refs, offRefs, (r) => r.totalWrite);
      if (offR01) {
        summaryLines.push(
          `| \`L2\` (30t, @T24) | \`baseline_off\` *(Phase 1 ref \`r01\`)* | 1 | $${offR01.totalCostUsd.toFixed(4)} | — | — | ${offR01.totalWrite.toLocaleString('en-US')} | — | ${offR01.cacheReadPct.toFixed(2)}% | ${offR01.mainReqs} |`
        );
      }
      if (offRefs.length > 1) {
        summaryLines.push(
          `| \`L2\` (30t, @T24) | \`baseline_off\` *(Phase 1 ref \`n=${offRefs.length}\`)* | ${offRefs.length} | ${fmtMedRange(offRefs.map((r) => r.totalCostUsd), 4, '$')} | — | — | ${fmtIntMedRange(offRefs.map((r) => r.totalWrite))} | — | ${fmtMedRange(offRefs.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(offRefs.map((r) => r.mainReqs))} |`
        );
      }
      if (v1R01) {
        const dOff = offR01 ? fmtSignedUsdMedRange([v1R01.totalCostUsd - offR01.totalCostUsd], 4) : '—';
        const dWr = offR01 ? fmtSignedIntMedRange([v1R01.totalWrite - offR01.totalWrite]) : '—';
        summaryLines.push(
          `| \`L2\` (30t, @T24) | \`highbeam_rule_v1\` *(Phase 1 ref \`r01\`)* | 1 | $${v1R01.totalCostUsd.toFixed(4)} | ${dOff} | — | ${v1R01.totalWrite.toLocaleString('en-US')} | ${dWr} | ${v1R01.cacheReadPct.toFixed(2)}% | ${v1R01.mainReqs} |`
        );
      }
      if (v1Refs.length > 1) {
        summaryLines.push(
          `| \`L2\` (30t, @T24) | \`highbeam_rule_v1\` *(Phase 1 ref \`n=${v1Refs.length}\`)* | ${v1Refs.length} | ${fmtMedRange(v1Refs.map((r) => r.totalCostUsd), 4, '$')} | ${fmtSignedUsdMedRange(v1VsOffMedCost, 4)} | — | ${fmtIntMedRange(v1Refs.map((r) => r.totalWrite))} | ${fmtSignedIntMedRange(v1VsOffMedWrite)} | ${fmtMedRange(v1Refs.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(v1Refs.map((r) => r.mainReqs))} |`
        );
      }
      const v2r = v2Runs[0];
      const vsMedOffStr = offMed !== null ? ` (vs \`n=3\` med: ${fmtSignedUsdMedRange([v2r.totalCostUsd - offMed], 4)})` : '';
      const vsMedV1Str = v1Med !== null ? ` (vs \`n=3\` med: ${fmtSignedUsdMedRange([v2r.totalCostUsd - v1Med], 4)})` : '';
      const isL2Explicit = v2r.hook?.horizon_prior_source === 'explicit';
      const l2HorizonDesc = isL2Explicit && v2r.hook?.expected_remaining_turns !== ''
        ? `explicit ${v2r.hook.expected_remaining_turns}t horizon`
        : 'unguided prior';
      summaryLines.push(
        `| \`L2\` (30t, @T24) | \`highbeam_${ruleVer}\` *(${l2HorizonDesc}, ${modeLabel})* | ${v2Runs.length} | $${v2r.totalCostUsd.toFixed(4)} | ${fmtSignedUsdMedRange(v2VsOffCost, 4)}${vsMedOffStr} | ${fmtSignedUsdMedRange(v2VsV1Cost, 4)}${vsMedV1Str} | ${v2r.totalWrite.toLocaleString('en-US')} | ${fmtSignedIntMedRange(v2VsOffWrite)} | ${v2r.cacheReadPct.toFixed(2)}% | ${v2r.mainReqs} |`
      );
    }

    summaryLines.push(
      '',
      '*(Note on `L1` `rule_v1` hold reference: `+$0.1463` was the pre-Phase-1 `computed` rate-card simulation estimate `$0.5818 - $0.4355`; Phase 1 live measured `$0.5280 [$0.5277–$0.5317]` `billed` vs `$0.4032 [$0.3948–$0.4058]` `billed` = paired `+$0.1248 [+$0.1218 to +$0.1369]` `billed`.)*',
      '',
      `## 3. Switch Turn (\`T_switch\`) and Next Two Turns (\`${modeLabel}\`, Directional Latency)`,
      '',
      `| Arm | Condition | n | \`T_switch\` Cost (\`${costKindLabel}\`) | \`T_switch\` Write Tokens | \`T_switch\` Read % | \`T_switch\` Latency | \`T+1\` Cost (\`${costKindLabel}\`) | \`T+2\` Cost (\`${costKindLabel}\`) |`,
      '|---|---|---:|---:|---:|---:|---:|---:|---:|'
    );

    const pushTurnRow = (armCode, turnNum, label, runs) => {
      if (!runs || runs.length === 0) return;
      summaryLines.push(
        `| \`${armCode}\` (T${turnNum}) | \`${label}\` | ${runs.length} | ${fmtMedRange(runs.map((r) => r.tSwitch.costUsd), 4, '$')} | ${fmtIntMedRange(runs.map((r) => r.tSwitch.write))} | ${fmtMedRange(runs.map((r) => r.tSwitch.readPct), 2, '', '%')} | ${fmtIntMedRange(runs.map((r) => r.tSwitch.latencyMs))} ms | ${fmtMedRange(runs.map((r) => r.tPlus1.costUsd), 4, '$')} | ${fmtMedRange(runs.map((r) => r.tPlus2.costUsd), 4, '$')} |`
      );
    };

    if (phase1Comparison.l1) {
      pushTurnRow('L1', 3, 'baseline_off (Phase 1 ref)', phase1Comparison.l1.offRefs);
      pushTurnRow('L1', 3, 'highbeam_rule_v1 (Phase 1 ref)', phase1Comparison.l1.v1Refs);
      pushTurnRow('L1', 3, `highbeam_${ruleVer} (${ruleVer === 'rule_v2_calibrated' ? 'unguided prior, ' : 'Phase 2 '}${modeLabel})`, phase1Comparison.l1.v2Runs);
    }
    if (phase1Comparison.l2) {
      const offR01 = phase1Comparison.l2.offRefs.filter((r) => r.rep === 1);
      const v1R01 = phase1Comparison.l2.v1Refs.filter((r) => r.rep === 1);
      const v2L2Hook = phase1Comparison.l2.v2Runs[0]?.hook;
      const v2L2Desc = v2L2Hook?.horizon_prior_source === 'explicit' && v2L2Hook?.expected_remaining_turns !== ''
        ? `explicit ${v2L2Hook.expected_remaining_turns}t horizon`
        : 'unguided';
      pushTurnRow('L2', 24, 'baseline_off (Phase 1 ref r01)', offR01);
      pushTurnRow('L2', 24, 'baseline_off (Phase 1 ref n=3)', phase1Comparison.l2.offRefs);
      pushTurnRow('L2', 24, 'highbeam_rule_v1 (Phase 1 ref r01)', v1R01);
      pushTurnRow('L2', 24, 'highbeam_rule_v1 (Phase 1 ref n=3)', phase1Comparison.l2.v1Refs);
      pushTurnRow('L2', 24, `highbeam_${ruleVer} (${v2L2Desc}, ${modeLabel})`, phase1Comparison.l2.v2Runs);
    }

    const mainRowsSumUsd = mainRowsData.reduce((a, r) => a + r.costUsd, 0);
    const totalWireBilledUsd = mainRowsSumUsd + sideCostTotalUsd;
    summaryLines.push(
      '',
      '## 4. OpenRouter Account Reconciliation (`billed`) & Audit Notes',
      `- **OpenRouter Key Usage Before / Settled After (\`billed\`):** \`${keyStart?.usage ?? 'N/A'}\` -> \`${keyEnd?.usage ?? 'N/A'}\` (settled delta = \`${openRouterDeltaUsd !== null ? '$' + openRouterDeltaUsd.toFixed(6) : 'N/A'}\`${keySettled && keyImmediateEnd ? `; immediate +13.8s poll \`${keyImmediateEnd.usage}\`, immediate delta \`$${immediateOpenRouterDeltaUsd.toFixed(6)}\`, lagged behind final 5 requests by \`$${(keyEnd.usage - keyImmediateEnd.usage).toFixed(6)}\`` : ''}; remaining = \`${keyEnd?.limit_remaining !== null && keyEnd?.limit_remaining !== undefined ? '$' + Number(keyEnd.limit_remaining).toFixed(6) : 'N/A'}\`).`,
      `- **Proxy Sum Across \`runs_round2_c2.csv\` (\`${costKindLabel}\`):** \`$${mainRowsSumUsd.toFixed(6)}\` across \`${mainRowsCount}\` main rows + \`$${sideCostTotalUsd.toFixed(6)}\` across \`${sideRowsCount}\` side calls = \`$${totalWireBilledUsd.toFixed(6)}\` total wire cost (\`${abortedRowsCount}\` aborted attempt rows).`,
      '',
      '## 5. Offline `rule_v2` Decision Table (`L1` @ T3 & `L2` @ T24 — `uncalibrated`, `calibrated`, `measured`)',
      '',
      '| Arm | Profile | Turns Used | Context Tokens | Out Tok (`source`) | Horizon | Eff. Rem. | Prior Source | Break-Even `C*` | Cold Penalty | Saving/t | Payback | Flip (`ask <=` / `allow >=`) | Net Savings | `shouldHoldModel` | Decision |',
      '|---|---|---:|---:|---|---|---:|---|---:|---:|---:|---:|---|---:|---|---|'
    );

    if (offlineHorizonTableL2) {
      for (const r of offlineHorizonTableL2) {
        const netStr = r.horizon_net_savings_usd >= 0
          ? `+$${Number(r.horizon_net_savings_usd).toFixed(4)}`
          : `-$${Math.abs(Number(r.horizon_net_savings_usd)).toFixed(4)}`;
        const cStarStr = r.break_even_c_star === null
          ? 'N/A (empirical)'
          : Number(r.break_even_c_star).toLocaleString('en-US');
        const flipAsk = r.max_int_horizon_ask === null ? 'none' : r.max_int_horizon_ask;
        const flipStr = `${Number(r.flip_horizon_continuous).toFixed(2)} (<= ${flipAsk} / >= ${r.min_int_horizon_allow})`;
        summaryLines.push(
          `| \`${r.arm}\` | \`${r.profile}\` | ${r.turns_completed_used} | ${Number(r.context_tokens).toLocaleString('en-US')} | ${r.expected_output_tokens} (\`${r.output_estimate_source}\`) | \`${r.horizon_spec}\` | ${r.effective_remaining_turns} | \`${r.prior_source}\` | ${cStarStr} | +$${Number(r.cold_write_penalty_usd).toFixed(4)} | +$${Number(r.per_turn_saving_usd).toFixed(4)} | ${Number(r.payback_turns).toFixed(2)} | ${flipStr} | ${netStr} | \`${r.should_hold_model}\` | \`${r.hook_decision}\` |`
        );
      }
    }

    summaryLines.push(
      '',
      '## 6. Interpretation of `rule_v2` Behavior & Survival Prior Audit',
      ...(ruleVer === 'rule_v2_calibrated'
        ? (() => {
            const calL1 = phase1Comparison?.l1?.v2Runs?.[0];
            const calL2 = phase1Comparison?.l2?.v2Runs?.[0];
            const offL1Med = median((phase1Comparison?.l1?.offRefs || []).map((r) => r.totalCostUsd));
            const v1L1Med = median((phase1Comparison?.l1?.v1Refs || []).map((r) => r.totalCostUsd));
            const offL2Med = median((phase1Comparison?.l2?.offRefs || []).map((r) => r.totalCostUsd));
            const l1Cost = calL1 ? `$${calL1.totalCostUsd.toFixed(4)}` : 'N/A';
            const l1VsOff = calL1 && offL1Med !== null ? fmtSignedUsdMedRange([calL1.totalCostUsd - offL1Med], 4) : 'N/A';
            const l1VsV1 = calL1 && v1L1Med !== null ? fmtSignedUsdMedRange([calL1.totalCostUsd - v1L1Med], 4) : 'N/A';
            const l2Cost = calL2 ? `$${calL2.totalCostUsd.toFixed(4)}` : 'N/A';
            const l2VsOff = calL2 && offL2Med !== null ? fmtSignedUsdMedRange([calL2.totalCostUsd - offL2Med], 4) : 'N/A';
            return [
              `- **\`L1\` (\`rule_v2_calibrated\` unguided live, \`n = 1\`, Opus -> Sonnet @ T3 of 30t):** Stop hook supplied \`turnsCompleted = 2\`, \`requestsPerTurn = 2\`, and raw rolling output median \`273\` tokens (\`n = 2\`), shrunk (\`0.4\` weight) toward the 500-token prior to \`409\` tokens (\`C* = 1,258\`, payback \`5.36\` turns vs prior horizon \`28.5\` turns). \`rule_v2\` allowed the switch cleanly with a one-line \`notableAllowNote\` (\`+$0.0348\` cold penalty, \`~$0.0065/turn\` saving, \`~5.4t\` payback), finishing at \`${l1Cost}\` \`billed\` (${l1VsOff} vs Phase 1 \`baseline_off\` median \`$${offL1Med?.toFixed(4) ?? 'N/A'}\`, ${l1VsV1} vs \`rule_v1\` hold \`$${v1L1Med?.toFixed(4) ?? 'N/A'}\`).`,
              `- **\`L2\` (\`rule_v2_calibrated\` explicit 6-turn horizon live, \`n = 1\`, Opus -> Sonnet @ T24 of 30t):** Stop hook supplied \`turnsCompleted = 23\`, \`requestsPerTurn = 1.1304\`, and mature 10-turn rolling output median \`150\` tokens (\`weight = 1.0\`, \`C* = 462\`, payback \`11.40\` turns). Because \`6 < 11.40\`, \`PreModelSwitch\` returned \`permissionDecision: "ask"\` (\`blocked_by_hook\` in headless \`-p\` SDK mode), keeping all \`30\` turns on \`claude-opus-4.6\` at \`${l2Cost}\` \`billed\` (${l2VsOff} vs Phase 1 \`baseline_off\` median \`$${offL2Med?.toFixed(4) ?? 'N/A'}\`, avoiding the \`+$0.0608\` cold rewrite).`
            ];
          })()
        : [
            '- **`L1` (`rule_v2` live, `n = 3`, Opus -> Sonnet @ T3 of 30t):** `rule_v2` allows the early T3 downgrade via `PreModelSwitch` (`permissionDecision: "allow"`, `control_subtype: "success"`), matching the switched baseline within run-to-run output variance and eliminating the `rule_v1` hold surcharge (`+$0.1248` `billed` measured in Phase 1; `+$0.1463` `computed` pre-Phase-1 simulation).',
            '- **`L2` (`rule_v2` unguided prior live, `n = 1`, Opus -> Sonnet @ T24 of 30t):** **No horizon signal, cannot beat baseline on late switches.** With no explicit remaining-turn bound provided, `rule_v2` relies on the empirical survival prior, predicts long continuation, and passes the T24 switch through cleanly (a structural limit of having no horizon signal, not a hook failure). Explicit bounded horizons (`3` or `6` remaining turns under calibrated output tokens) hold `ask` offline (Section 5) and reproduce the `rule_v1` hold already measured in Phase 1.'
          ]),
      '- **Survival Prior Provenance & Unit Audit:** `EMPIRICAL_SESSION_API_CALL_PRIOR` (`source = "placeholder_antigravity_496_prior"`, `isPlaceholderPrior = true`) is a **placeholder** built from `496` Antigravity IDE workstation planner runs (`120` interactive multi-turn + `376` single-prompt/subagent sessions, NOT Claude Code telemetry; overridden at runtime when `>= 5` deduplicated local transcripts exist under `~/.claude/projects/**/*.jsonl`, which is empty in isolated benchmark runs). Native bucket residuals (`+59`, `+47`, etc.) are measured in **`api_requests`** (`prior_native_unit = "api_requests"`) and are converted to **`turns`** (`horizon_unit = "turns"`) by dividing by the session\'s observed `requestsPerTurn`.'
    );
  } else {
    summaryLines.push(
      `*(Every paired \`baseline_off\` run returned \`hook_event = none\`, \`permission_decision = allow_no_hook\`, \`control_subtype = success\`, and switched wire model on \`T_switch\`.)*`,
      '',
      `## 2. Session-Level Results (\`${modeLabel}\` — \`median [min–max]\` for \`n > 1\`)`,
      '',
      `| Arm | Condition | n | Total Cost (\`${costKindLabel}\`) | Paired Delta vs Off (\`${costKindLabel}\`) | Cache Write Tokens | Paired Write Delta | Cache Read Share | Main API Reqs |`,
      '|---|---|---:|---:|---:|---:|---:|---:|---:|'
    );

    for (const c of cellSummaries) {
      if (c.offRuns.length > 0) {
        summaryLines.push(
          `| \`${c.armCode}\` (${c.spec.turns}t, @T${c.spec.switchBeforeTurn}) | \`baseline_off\` | ${c.offRuns.length} | ${fmtMedRange(c.offRuns.map((r) => r.totalCostUsd), 4, '$')} | — | ${fmtIntMedRange(c.offRuns.map((r) => r.totalWrite))} | — | ${fmtMedRange(c.offRuns.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(c.offRuns.map((r) => r.mainReqs))} |`
        );
      }
      summaryLines.push(
        `| \`${c.armCode}\` (${c.spec.turns}t, @T${c.spec.switchBeforeTurn}) | \`highbeam_${ruleVer}\` | ${c.hbRuns.length} | ${fmtMedRange(c.hbRuns.map((r) => r.totalCostUsd), 4, '$')} | ${fmtSignedUsdMedRange(c.deltasCost, 4)} | ${fmtIntMedRange(c.hbRuns.map((r) => r.totalWrite))} | ${fmtIntMedRange(c.deltasWrite)} | ${fmtMedRange(c.hbRuns.map((r) => r.cacheReadPct), 2, '', '%')} | ${fmtIntMedRange(c.hbRuns.map((r) => r.mainReqs))} |`
      );
    }

    summaryLines.push(
      '',
      `## 3. Switch Turn (\`T_switch\`) and Next Two Turns (\`${modeLabel}\`, Directional Latency)`,
      '',
      `| Arm | Condition | n | \`T_switch\` Cost (\`${costKindLabel}\`) | \`T_switch\` Write Tokens | \`T_switch\` Read % | \`T_switch\` Latency | \`T+1\` Cost (\`${costKindLabel}\`) | \`T+2\` Cost (\`${costKindLabel}\`) |`,
      '|---|---|---:|---:|---:|---:|---:|---:|---:|'
    );

    for (const c of cellSummaries) {
      for (const [label, runs] of [['baseline_off', c.offRuns], [`highbeam_${ruleVer}`, c.hbRuns]]) {
        if (runs.length === 0) continue;
        summaryLines.push(
          `| \`${c.armCode}\` (T${c.spec.switchBeforeTurn}) | \`${label}\` | ${runs.length} | ${fmtMedRange(runs.map((r) => r.tSwitch.costUsd), 4, '$')} | ${fmtIntMedRange(runs.map((r) => r.tSwitch.write))} | ${fmtMedRange(runs.map((r) => r.tSwitch.readPct), 2, '', '%')} | ${fmtIntMedRange(runs.map((r) => r.tSwitch.latencyMs))} ms | ${fmtMedRange(runs.map((r) => r.tPlus1.costUsd), 4, '$')} | ${fmtMedRange(runs.map((r) => r.tPlus2.costUsd), 4, '$')} |`
        );
      }
    }

    summaryLines.push(
      '',
      `## 4. OpenRouter Account Reconciliation (\`billed\`) & Audit Notes`,
      `- **OpenRouter Key Usage Before / After (\`billed\`):** \`${keyStart?.usage ?? 'N/A'}\` -> \`${keyEnd?.usage ?? 'N/A'}\` (delta = \`${openRouterDeltaUsd !== null ? '$' + openRouterDeltaUsd.toFixed(6) : 'N/A'}\`, remaining = \`${keyEnd?.limit_remaining !== null && keyEnd?.limit_remaining !== undefined ? '$' + Number(keyEnd.limit_remaining).toFixed(6) : 'N/A'}\`).`,
      `- **Proxy Sum Across \`runs_round2_c2.csv\` (\`${costKindLabel}\`):** \`$${mainRowsData.reduce((a, r) => a + r.costUsd, 0).toFixed(6)}\` across \`${mainRowsCount}\` main rows (\`${sideRowsCount}\` side calls, \`${abortedRowsCount}\` aborted attempt rows).`,
      '',
      '## 5. Interpretation of `rule_v1` Behavior',
      '- **`L1` (Opus -> Sonnet @ T3 of 30t):** `rule_v1` evaluates only single-turn break-even (`C* = 4,615`) without remaining-turn horizon, so it blocks the early downgrade via `permissionDecision: "ask"`. Across 30 turns, holding on Opus costs more than taking the T3 cold rewrite — demonstrating the exact horizon limitation targeted by `rule_v2` (`C1e`).',
      '- **`L2` (Opus -> Sonnet @ T24 of 30t):** Blocking the late downgrade via `permissionDecision: "ask"` avoids a large T24 prefix rewrite when only 7 turns remain (`T24–T30`), keeping session cost lower than the switched baseline.',
      '- **`U1` (Sonnet -> Opus @ T6 of 12t):** Capability upshift (`isCapabilityUpshift = true`, `breakEvenTokens = 0`) passes through `PreModelSwitch` (`exit_code = 0`, `permission_decision = allow`), switching wire model cleanly at T6.'
    );
  }

  fs.writeFileSync(path.join(outDir, 'summary_round2_c2.md'), summaryLines.join('\n') + '\n', 'utf8');
  return reportJson;
}

function cpPathSafe(p) {
  return p;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.live && !flags.confirmSpend) {
    throw new Error('Refusing live OpenRouter spend without --confirm-spend. Run with --mock-dry-run ($0.00) first.');
  }

  const outDir = flags.live || flags.buildOnly
    ? path.join(RESULTS_C2_ROOT, flags.rule)
    : path.join(os.tmpdir(), 'ctxtop-round2-c2-dry-run-out', flags.rule);
  const schedule = buildScheduleRuns(flags);

  if (flags.buildOnly) {
    const runtimePaths = (() => {
      try { return resolveRuntimePaths(true); } catch { return null; }
    })();
    sanitizeRound2C2InPlace(outDir, runtimePaths);
    const rebuilt = buildDeliverableCsvsAndReports(outDir, schedule, { isLive: true, ruleVersion: flags.rule });
    sanitizeRound2C2InPlace(outDir, runtimePaths);
    console.log(JSON.stringify(rebuilt, null, 2));
    return;
  }

  const runtimePaths = resolveRuntimePaths(flags.live);
  const envInfo = verifyRuntimeEnvironment(runtimePaths);
  const prompts = build30TurnSmallPrompts();

  const rawDir = path.join(outDir, 'raw');
  const transcriptsDir = path.join(rawDir, 'transcripts');
  const checkpointPath = path.join(rawDir, 'checkpoint.json');
  const wireLogPath = path.join(rawDir, 'proxy_wire_log.jsonl');
  const cliTurnsPath = path.join(rawDir, 'cli_turns.jsonl');
  const interceptionsPath = path.join(rawDir, 'interceptions_live.jsonl');
  const ledgerPath = path.join(rawDir, 'openrouter_ledger.jsonl');

  if (!flags.resume) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const checkpoint = flags.resume && fs.existsSync(checkpointPath)
    ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
    : {
        startedAt: new Date().toISOString(),
        ruleVersion: flags.rule,
        highbeamCommit: getRepoGitHead(),
        pinnedRepoCommit: PINNED_REPO_COMMIT,
        runs: {}
      };
  const saveCheckpoint = () => fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
  saveCheckpoint();

  const initialSpendUsd = fs.existsSync(wireLogPath) && flags.resume
    ? Number(readJsonl(wireLogPath).reduce((acc, w) => acc + Number(w.upstreamReportedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0).toFixed(6))
    : 0;

  let apiKey = null;
  let serverHandle;
  if (flags.live) {
    apiKey = loadOpenRouterApiKey();
    const keyStart = await fetchOpenRouterKeyUsage(apiKey);
    fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'start', ...keyStart }) + '\n', 'utf8');
    const remainingBudgetForProxy = Math.max(0.1, flags.maxBudgetUsd - initialSpendUsd);
    serverHandle = await startProxyServer({
      upstreamBaseUrl: 'https://openrouter.ai',
      upstreamApiPrefix: '/api',
      apiKey,
      maxBudgetUsd: remainingBudgetForProxy,
      wireLogPath,
      pinProvider: true,
      stripCacheTtl: false
    });
  } else {
    serverHandle = await startMockSseServer(wireLogPath);
  }

  try {
    for (let runIdx = 0; runIdx < schedule.length; runIdx++) {
      const spec = schedule[runIdx];
      if (flags.resume && checkpoint.runs[spec.runId]?.completed === true) {
        console.log(`[Skip completed ${runIdx + 1}/${schedule.length}] ${spec.runId}`);
        continue;
      }

      let finishedSummary = null;
      const abortedAttempts = Array.isArray(checkpoint.runs[spec.runId]?.abortedAttempts)
        ? [...checkpoint.runs[spec.runId].abortedAttempts]
        : [];

      for (let attempt = 1; attempt <= 2; attempt++) {
        const cumSpendNow = initialSpendUsd + Number(serverHandle.getState().totalSpendUsd || 0);
        if (serverHandle.getState().budgetExceeded || (flags.live && cumSpendNow >= flags.maxBudgetUsd)) {
          throw new Error(`Budget cap $${flags.maxBudgetUsd} reached ($${cumSpendNow.toFixed(4)}). Halting.`);
        }

        resetFrozenRepoClean(runtimePaths.frozenRepoDir);
        if (typeof serverHandle.resetSessionState === 'function') {
          serverHandle.resetSessionState();
        }
        const envSetup = setupIsolatedRunEnv(spec, runtimePaths);
        try {
          finishedSummary = await executePersistentSession({
            spec,
            runIndex: runIdx,
            totalRuns: schedule.length,
            attempt,
            initialSpendUsd,
            envSetup,
            prompts,
            runtimePaths,
            serverHandle,
            wireLogPath,
            cliTurnsPath,
            interceptionsPath,
            transcriptsDir
          });
          fs.rmSync(envSetup.workRoot, { recursive: true, force: true });
          break;
        } catch (err) {
          fs.rmSync(envSetup.workRoot, { recursive: true, force: true });
          abortedAttempts.push({ attempt, error: err.message, timestamp: new Date().toISOString() });
          checkpoint.runs[spec.runId] = { completed: false, abortedAttempts };
          saveCheckpoint();
          if (serverHandle.getState().budgetExceeded || attempt === 2) {
            throw err;
          }
          console.warn(`[${spec.runId}] Attempt ${attempt} failed (${err.message}). Waiting 5s before retry...`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }

      checkpoint.runs[spec.runId] = {
        completed: true,
        attempt: finishedSummary.attempt,
        sessionId: finishedSummary.sessionId,
        turnsCompleted: finishedSummary.turnsCompleted,
        totalCostUsdBilled: finishedSummary.totalCostUsdBilled,
        totalCostUsdComputed: finishedSummary.totalCostUsdComputed,
        abortedAttempts,
        finishedAt: new Date().toISOString()
      };
      saveCheckpoint();

      if (flags.live && apiKey) {
        const keySnap = await fetchOpenRouterKeyUsage(apiKey);
        fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'after_run', runId: spec.runId, ...keySnap }) + '\n', 'utf8');
      }
    }

    resetFrozenRepoClean(runtimePaths.frozenRepoDir);
    if (flags.live && apiKey) {
      await new Promise((r) => setTimeout(r, 8000));
      const keyEnd = await fetchOpenRouterKeyUsage(apiKey);
      fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'end', ...keyEnd }) + '\n', 'utf8');
    }
  } finally {
    await serverHandle.close();
  }

  sanitizeRound2C2InPlace(outDir, runtimePaths);
  const report = buildDeliverableCsvsAndReports(outDir, schedule, {
    isLive: flags.live,
    ruleVersion: flags.rule,
    claudeCodeVersion: envInfo.versionOutput || PINNED_CLAUDE_CODE_VERSION,
    startedAt: checkpoint.startedAt,
    finishedAt: new Date().toISOString(),
    highbeamCommit: checkpoint.highbeamCommit
  });
  sanitizeRound2C2InPlace(outDir, runtimePaths);

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
