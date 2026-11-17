#!/usr/bin/env node
/**
 * Cost-Per-Completed-Task Harness (Option A: Turn 1 read-only plan mode, Turn 2+ bypassPermissions)
 *
 * Modes:
 *   --dry-run-mock                      $0 end-to-end verification against local mock SSE + real claude.exe
 *   --stage 1 --confirm-live-spend      Execute Stage 1 pilot (24 runs, rep=1) + key reconciliation
 *   --stage 2 --confirm-live-spend      Execute Stage 2 main (48 runs, rep=2..3) + key reconciliation
 *   --resume                            Skip run_ids already persisted in checkpoint_runs.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RESULTS_DIR,
  CLAUDE_EXE,
  PINNED_CLAUDE_CODE_VERSION,
  loadOpenRouterApiKey,
  mapCliModelToOpenRouter
} from '../config.mjs';
import { startCptProxyServer, resolveCptCaps } from './cpt_proxy.mjs';
import {
  TASKS,
  TURN2_IMPLEMENT_PROMPT,
  RETRY_PROMPT_HEADER,
  buildTurn1Prompt
} from './tasks_manifest.mjs';
import { buildCostPerTaskDeliverables } from './build_cost_per_task_deliverables.mjs';
import { assertNoSensitiveLeaks, redactSensitiveText } from '../tests_3_to_8/prefix_lab.mjs';
import { activateLocalTrial } from '../../../src/core/pro_license.mjs';
import { runPreModelSwitchHook } from '../../../hooks/handlers/pre-model-switch.mjs';
import {
  createInitialTelemetryState,
  writeLiveStateSnapshot
} from '../../../src/core-isomorphic/telemetry/telemetryBridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(__dirname, 'task_repo_template');
export const VISIBLE_DIR = path.join(__dirname, 'visible_suites');
export const HIDDEN_DIR = path.join(__dirname, 'hidden_suites');
export const REF_DIR = path.join(__dirname, 'reference_solutions');

const OPUS_CLI = 'claude-opus-5-5';
const SONNET_CLI = 'claude-sonnet-5-5';
const COOLDOWN_MS = 365_000; // >= 6m (365s > 300s 5m ephemeral cache TTL)

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildRandomizedSchedule(seed = 20261116, activeTasks = TASKS.filter((t) => !t.is_spare)) {
  const rng = mulberry32(seed);
  const arms = ['OPUS', 'SONNET', 'SWITCH'];
  const stage1 = [];
  const stage2 = [];

  for (const rep of [1, 2, 3]) {
    const block = [];
    for (const task of activeTasks) {
      for (const arm of arms) {
        block.push({
          run_id: `${task.task_id}_${arm}_r0${rep}`,
          task_id: task.task_id,
          difficulty: task.difficulty,
          arm,
          rep,
          initial_model: arm === 'SONNET' ? SONNET_CLI : OPUS_CLI,
          switch_to_model: arm === 'SWITCH' ? SONNET_CLI : null
        });
      }
    }
    for (let i = block.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
    if (rep === 1) stage1.push(...block);
    else stage2.push(...block);
  }
  return { stage1, stage2 };
}

function findClaudeExe() {
  if (fs.existsSync(CLAUDE_EXE)) return CLAUDE_EXE;
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cand = path.join(tmp, entry.name, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error('Pinned claude.exe not found in %TEMP%');
}

function copyDirClean(srcDir, dstDir, excludeGit = true) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (excludeGit && entry.name === '.git') continue;
    if (entry.name === 'node_modules') continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDirClean(s, d, excludeGit);
    else fs.copyFileSync(s, d);
  }
}

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

function sanitizeEvalText(text, evalDir, repoDir) {
  let out = String(text || '');
  for (const needle of [
    evalDir,
    evalDir.replace(/\\/g, '/'),
    repoDir,
    repoDir.replace(/\\/g, '/')
  ]) {
    if (needle) out = out.split(needle).join('<REPO_DIR>');
  }
  return redactSensitiveText(out);
}

export function evaluateHiddenSuite({ runId, turn, taskId, repoDir, hiddenDir = HIDDEN_DIR }) {
  const evalDir = fs.mkdtempSync(path.join(os.tmpdir(), `cpt-eval-${runId}-t${turn}-`));
  try {
    copyDirClean(repoDir, evalDir, true);
    const hiddenSrc = path.join(hiddenDir, `${taskId}.hidden.test.mjs`);
    fs.copyFileSync(hiddenSrc, path.join(evalDir, '__hidden_eval__.test.mjs'));

    const res = spawnSync(process.execPath, ['--test', '__hidden_eval__.test.mjs'], {
      cwd: evalDir,
      encoding: 'utf8',
      timeout: 25_000
    });

    const combinedRaw = [res.stdout || '', res.stderr || ''].filter(Boolean).join('\n');
    const combined = sanitizeEvalText(combinedRaw, evalDir, repoDir);
    const lines = combined.split(/\r?\n/);

    // Parse failing test names from node --test TAP/spec output
    const failingNames = [];
    for (const line of lines) {
      const m1 = line.match(/^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
      const m2 = line.match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/);
      const name = m1 ? m1[1].trim() : m2 ? m2[1].trim() : null;
      if (name && name !== '__hidden_eval__.test.mjs' && !failingNames.includes(name)) {
        failingNames.push(name);
      }
    }
    if (res.status !== 0 && failingNames.length === 0) {
      failingNames.push('hidden_suite_execution_or_syntax_error');
    }

    const constraintViolations = failingNames.filter((n) => n.includes('[CONSTRAINT-')).length;
    const first30Lines = lines.slice(0, 30).join('\n');
    const retryPrompt =
      res.status === 0
        ? null
        : `${RETRY_PROMPT_HEADER}\n${failingNames.map((n) => `- ${n}`).join('\n')}\n\n${first30Lines}`;

    return {
      passed: res.status === 0,
      exitCode: res.status,
      failingNames,
      constraintViolations,
      first30Lines,
      retryPrompt
    };
  } finally {
    fs.rmSync(evalDir, { recursive: true, force: true });
  }
}

function computeDiffLinesChanged(repoDir) {
  const diffRes = spawnSync('git', ['diff', '--numstat', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
  let linesChanged = 0;
  for (const line of String(diffRes.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\s+(\d+)\s+/);
    if (m) linesChanged += Number(m[1]) + Number(m[2]);
  }
  const untrackedRes = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoDir,
    encoding: 'utf8'
  });
  for (const rel of String(untrackedRes.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const full = path.join(repoDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const content = fs.readFileSync(full, 'utf8');
      linesChanged += content ? content.split(/\r?\n/).length : 0;
    }
  }
  return linesChanged;
}

function evaluateShadowPreModelSwitch({ runId, cachedTokens, turn1FinishedAtMs, shadowRoot }) {
  const shadowHome = path.join(shadowRoot, 'home');
  const shadowCwd = path.join(shadowRoot, 'cwd');
  const licensePath = path.join(shadowRoot, 'license.json');
  const ledgerPath = path.join(shadowRoot, 'saved_quota.jsonl');
  fs.mkdirSync(shadowHome, { recursive: true });
  fs.mkdirSync(shadowCwd, { recursive: true });
  activateLocalTrial({ homeDir: shadowHome, licensePath });
  const ahDir = path.join(shadowHome, '.attention-horizon');
  fs.mkdirSync(ahDir, { recursive: true });
  fs.writeFileSync(path.join(ahDir, 'config.json'), JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2), 'utf8');

  const elapsedSec = turn1FinishedAtMs ? Math.max(0, (Date.now() - turn1FinishedAtMs) / 1000) : 1;
  const ttlRemainingSec = Math.max(0, 300 - elapsedSec);
  const cacheWarm = ttlRemainingSec > 0 && cachedTokens > 0;
  const sessionId = `sess_${runId}`;

  const snapState = {
    ...createInitialTelemetryState(sessionId),
    sessionId,
    modelId: OPUS_CLI,
    effort: 'medium',
    flightMode: 'AUTO_PILOT',
    contextWindow: {
      cachedTokens: cacheWarm ? cachedTokens : 0,
      totalInputTokens: cachedTokens
    },
    promptCache: {
      warm: cacheWarm,
      ttlTier: '5m',
      ttlSeconds: ttlRemainingSec
    }
  };
  writeLiveStateSnapshot(sessionId, snapState, { cwd: shadowCwd });

  const hookRes = runPreModelSwitchHook(
    {
      session_id: sessionId,
      cwd: shadowCwd,
      current_model: OPUS_CLI,
      target_model: SONNET_CLI,
      cached_tokens: cacheWarm ? cachedTokens : 0,
      uncached_delta_tokens: 350,
      cache_warm: cacheWarm,
      cache_ttl_tier: '5m',
      turn_id: `${runId}_T2`
    },
    {
      cwd: shadowCwd,
      homeDir: shadowHome,
      licensePath,
      ledgerPath,
      recordLedger: false
    }
  );
  const v = hookRes.verdict || {};
  return {
    decision: v.decision || 'allow',
    blocked: Boolean(v.blocked),
    coldWritePenaltyUsd: Number(v.breakEven?.coldWritePenaltyUSD ?? 0),
    breakEvenTokens: v.breakEven?.breakEvenTokens ?? null,
    reason: v.reason || ''
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

async function waitForModelCooldown(proxy, modelCli, minGapMs, label) {
  if (!minGapMs || minGapMs <= 0) return 0;
  const lastMs = proxy.getLastResponseAtMs(modelCli);
  if (!lastMs) return 0;
  const elapsed = Date.now() - lastMs;
  if (elapsed >= minGapMs) return 0;
  const waitMs = minGapMs - elapsed;
  console.log(`[cooldown] Waiting ${(waitMs / 1000).toFixed(1)}s before ${label} (${mapCliModelToOpenRouter(modelCli)}) to clear 5m TTL...`);
  await new Promise((r) => setTimeout(r, waitMs));
  return waitMs;
}

async function executeSingleRun({
  spec,
  task,
  claudeExe,
  proxy,
  caps,
  cooldownMs,
  rawDir,
  workBaseDir,
  templateDir = TEMPLATE_DIR,
  visibleDir = VISIBLE_DIR,
  hiddenDir = HIDDEN_DIR,
  extraSecrets = []
}) {
  const workRoot = path.join(workBaseDir, spec.run_id);
  const repoDir = path.join(workRoot, 'repo');
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'cfg');
  const shadowRoot = path.join(workRoot, 'shadow_highbeam');
  const settingsPath = path.join(workRoot, 'settings.json');
  const nonce = crypto.createHash('sha256').update(`${spec.run_id}_${Date.now()}`).digest('hex').slice(0, 12);
  const salt = `Benchmark-Run-Salt: ${spec.run_id}_${nonce}`;

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  copyDirClean(templateDir, repoDir, true);
  fs.copyFileSync(path.join(visibleDir, `${task.task_id}.visible.test.mjs`), path.join(repoDir, 'test', 'task_visible.test.mjs'));

  for (const gitArgs of [
    ['init'],
    ['config', 'user.email', 'bench@local'],
    ['config', 'user.name', 'bench'],
    ['add', '-A'],
    ['commit', '-m', 'baseline']
  ]) {
    const g = spawnSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8' });
    if (g.status !== 0) throw new Error(`git ${gitArgs[0]} failed: ${g.stderr}`);
  }

  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {}, autoMemoryEnabled: false }, null, 2), 'utf8');

  await waitForModelCooldown(proxy, spec.initial_model, cooldownMs, `${spec.run_id} Turn 1`);

  proxy.beginRun(spec.run_id);
  const runStartMs = Date.now();

  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = proxy.baseUrl;
  env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CONFIG_DIR = cfgDir;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'plan',
    '--allow-dangerously-skip-permissions',
    '--permission-prompts', 'none',
    '--tools', 'Read,Edit,Write,Bash,Grep,Glob',
    '--model', spec.initial_model,
    '--effort', 'medium',
    '--append-system-prompt', salt,
    '--settings', settingsPath,
    '--setting-sources', 'local'
  ];

  const child = spawn(claudeExe, args, {
    cwd: repoDir,
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
      try { events.push(JSON.parse(line)); } catch {}
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

  function waitForEvent(pred, timeoutMs = 180_000, fromIndex = 0) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        for (let i = fromIndex; i < events.length; i += 1) {
          if (pred(events[i], i)) {
            clearInterval(iv);
            resolve({ event: events[i], index: i });
            return;
          }
        }
        const pState = proxy.getState();
        if (pState.capReason) {
          clearInterval(iv);
          resolve({ capped: true, capReason: pState.capReason });
          return;
        }
        if (childClosed) {
          clearInterval(iv);
          reject(new Error(`[${spec.run_id}] claude exited early (${exitCode}): ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 400)}`));
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`[${spec.run_id}] Timed out waiting for claude event`));
        }
      }, 25);
    });
  }

  let turnsCompleted = 0;
  let attempts = 0;
  let completed = false;
  let capReason = '';
  let turn1ReadonlyClean = true;
  let setModelControlOk = null;
  let shadowEval = null;
  let lastConstraintViolations = 0;

  try {
    // --- TURN 1: Plan Mode ---
    proxy.beginTurn(1, {
      runId: spec.run_id,
      arm: spec.arm,
      rep: spec.rep,
      taskId: spec.task_id,
      difficulty: spec.difficulty,
      effort: 'medium',
      phase: 'plan',
      attempt: 0,
      event: 'message'
    });
    const t1StartIdx = events.length;
    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: buildTurn1Prompt(task) }
    }) + '\n');
    const t1Res = await waitForEvent((e) => e.type === 'result', 240_000, t1StartIdx);
    turnsCompleted = 1;
    const turn1FinishedAtMs = Date.now();

    const stT1 = spawnSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
    if (String(stT1.stdout || '').trim() !== '') {
      turn1ReadonlyClean = false;
      spawnSync('git', ['checkout', '-f'], { cwd: repoDir, encoding: 'utf8' });
      spawnSync('git', ['clean', '-fdx'], { cwd: repoDir, encoding: 'utf8' });
    }

    if (t1Res.capped || proxy.getState().capReason) {
      capReason = t1Res.capReason || proxy.getState().capReason;
    } else {
      // --- Transition Turn 1 -> Turn 2: bypassPermissions + optional set_model ---
      const permIdx = events.length;
      const permReqId = `perm_${spec.run_id}`;
      child.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: permReqId,
        request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' }
      }) + '\n');
      const permRes = await waitForEvent(
        (e) => e.type === 'control_response' && e.response?.request_id === permReqId,
        30_000,
        permIdx
      );
      if (permRes.event?.response?.subtype !== 'success') {
        throw new Error(`[${spec.run_id}] set_permission_mode failed: ${JSON.stringify(permRes.event)}`);
      }

      if (spec.arm === 'SWITCH') {
        // Compute Turn 1 warm cached tokens from proxy wire log
        const wireSoFar = fs.readFileSync(proxy.wireLogPath, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((w) => w.context?.runId === spec.run_id && !w.isSideCall && w.statusCode < 400);
        const lastT1Wire = wireSoFar[wireSoFar.length - 1];
        const t1CachedTokens = lastT1Wire
          ? (lastT1Wire.usage?.input_tokens || 0) +
            (lastT1Wire.usage?.cache_creation_input_tokens || 0) +
            (lastT1Wire.usage?.cache_read_input_tokens || 0)
          : 0;

        shadowEval = evaluateShadowPreModelSwitch({
          runId: spec.run_id,
          cachedTokens: t1CachedTokens,
          turn1FinishedAtMs,
          shadowRoot
        });

        await waitForModelCooldown(proxy, SONNET_CLI, cooldownMs, `${spec.run_id} SWITCH->Sonnet`);

        proxy.setContext({
          runId: spec.run_id,
          arm: spec.arm,
          rep: spec.rep,
          taskId: spec.task_id,
          difficulty: spec.difficulty,
          effort: 'medium',
          turn: 2,
          phase: 'switch_probe',
          attempt: 1,
          event: 'set_model_probe'
        });

        const swIdx = events.length;
        const swReqId = `sw_${spec.run_id}`;
        child.stdin.write(JSON.stringify({
          type: 'control_request',
          request_id: swReqId,
          request: { subtype: 'set_model', model: SONNET_CLI }
        }) + '\n');
        const swRes = await waitForEvent(
          (e) => e.type === 'control_response' && e.response?.request_id === swReqId,
          30_000,
          swIdx
        );
        setModelControlOk = swRes.event?.response?.subtype === 'success';
        if (!setModelControlOk) {
          throw new Error(`[${spec.run_id}] set_model failed: ${JSON.stringify(swRes.event)}`);
        }
      }

      // --- TURNS 2..5: Implement & up to 3 Retries ---
      let nextPrompt = TURN2_IMPLEMENT_PROMPT;
      for (let turn = 2; turn <= caps.maxHarnessTurns; turn += 1) {
        const attempt = turn - 1;
        const phase = turn === 2 ? 'implement' : `retry_${turn - 2}`;
        proxy.beginTurn(turn, {
          runId: spec.run_id,
          arm: spec.arm,
          rep: spec.rep,
          taskId: spec.task_id,
          difficulty: spec.difficulty,
          effort: 'medium',
          phase,
          attempt,
          event: 'message'
        });
        const tFrom = events.length;
        child.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: nextPrompt }
        }) + '\n');
        const tRes = await waitForEvent((e) => e.type === 'result', 240_000, tFrom);
        turnsCompleted = turn;
        attempts = attempt;

        if (tRes.capped || proxy.getState().capReason) {
          capReason = tRes.capReason || proxy.getState().capReason;
          break;
        }

        const evalRes = evaluateHiddenSuite({
          runId: spec.run_id,
          turn,
          taskId: spec.task_id,
          repoDir,
          hiddenDir
        });
        lastConstraintViolations = evalRes.constraintViolations;

        if (evalRes.passed) {
          completed = true;
          break;
        }
        if (turn === caps.maxHarnessTurns) {
          capReason = 'retry_cap';
          break;
        }
        nextPrompt = evalRes.retryPrompt;
      }
    }

    if (!childClosed) {
      child.stdin.end();
      await Promise.race([closePromise, new Promise((r) => setTimeout(r, 3000))]);
    }
  } finally {
    if (!childClosed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  const wallTimeS = (Date.now() - runStartMs) / 1000;
  const diffLinesChanged = computeDiffLinesChanged(repoDir);

  // Save sanitized transcript
  const transcriptsDir = path.join(rawDir, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const jsonls = [
    ...findSessionJsonlFiles(cfgDir),
    ...findSessionJsonlFiles(path.join(homeDir, '.claude'))
  ];
  if (jsonls.length > 0) {
    const rawTx = fs.readFileSync(jsonls[0], 'utf8');
    const cleanTx = redactSensitiveText(
      rawTx.split(repoDir).join('<REPO_DIR>').split(repoDir.replace(/\\/g, '/')).join('<REPO_DIR>')
    );
    assertNoSensitiveLeaks(cleanTx, `transcript_${spec.run_id}`, extraSecrets);
    fs.writeFileSync(path.join(transcriptsDir, `${spec.run_id}.jsonl`), cleanTx, 'utf8');
  }

  // Aggregate run stats strictly from wire log
  const wireAll = fs.readFileSync(proxy.wireLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((w) => w.context?.runId === spec.run_id && !w.blockedByGuard && !w.countTokensFallback && (w.statusCode ?? 200) < 400);

  const mainReqs = wireAll.filter((w) => !w.isSideCall);
  const planReqs = wireAll.filter((w) => w.context?.turn === 1);
  const totalBilledUsd = wireAll.reduce((s, w) => s + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0);
  const planTurnBilledUsd = planReqs.reduce((s, w) => s + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0);
  const implBilledUsd = Math.max(0, totalBilledUsd - planTurnBilledUsd);

  const sumRead = mainReqs.reduce((s, w) => s + (w.usage?.cache_read_input_tokens || 0), 0);
  const sumTotIn = mainReqs.reduce((s, w) => s + (w.usage?.total_input_tokens || 0), 0);
  const cacheReadShare = sumTotIn > 0 ? sumRead / sumTotIn : 0;

  let switchTurnCostUsd = null;
  if (spec.arm === 'SWITCH' && turnsCompleted >= 2) {
    const t2Req1 = mainReqs.find((w) => w.context?.turn === 2 && w.reqIndexInTurn === 1);
    const swProbe = wireAll.find((w) => w.context?.phase === 'switch_probe');
    switchTurnCostUsd = Number(t2Req1?.billedCostUsd ?? t2Req1?.cost?.totalCostUsd ?? 0)
      + Number(swProbe?.billedCostUsd ?? swProbe?.cost?.totalCostUsd ?? 0);
  }

  fs.rmSync(workRoot, { recursive: true, force: true });

  return {
    run_id: spec.run_id,
    task_id: spec.task_id,
    difficulty: spec.difficulty,
    arm: spec.arm,
    rep: spec.rep,
    completed,
    attempts,
    turns: turnsCompleted,
    requests: mainReqs.length,
    plan_turn_requests: planReqs.filter((w) => !w.isSideCall).length,
    total_billed_usd: Number(totalBilledUsd.toFixed(8)),
    plan_turn_billed_usd: Number(planTurnBilledUsd.toFixed(8)),
    impl_and_retries_billed_usd: Number(implBilledUsd.toFixed(8)),
    wall_time_s: Number(wallTimeS.toFixed(2)),
    cache_read_share: Number(cacheReadShare.toFixed(4)),
    switch_turn_cost_usd: switchTurnCostUsd !== null ? Number(switchTurnCostUsd.toFixed(8)) : null,
    set_model_control_ok: setModelControlOk,
    shadow_pre_model_switch_decision: shadowEval?.decision ?? '',
    shadow_pre_model_switch_blocked: shadowEval ? shadowEval.blocked : '',
    shadow_cold_write_penalty_usd: shadowEval ? shadowEval.coldWritePenaltyUsd : null,
    shadow_break_even_tokens: shadowEval ? shadowEval.breakEvenTokens : '',
    cap_reason: capReason,
    constraint_violations: lastConstraintViolations,
    diff_lines_changed: diffLinesChanged,
    turn1_readonly_clean: turn1ReadonlyClean
  };
}

function writeMockSse(res, { model, msgId, contentBlocks, stopReason = 'end_turn', isWarm = false, cost = 0.01 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: isWarm
        ? { input_tokens: 150, cache_creation_input_tokens: 400, cache_read_input_tokens: 12000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 }
        : { input_tokens: 50, cache_creation_input_tokens: 12000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 12000, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 }
    }
  });
  contentBlocks.forEach((b, idx) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: b.text } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
    } else {
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
    }
  });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 80, cost }
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

async function runDryRunMock() {
  const claudeExe = findClaudeExe();
  const dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-dryrun-'));
  const rawDir = path.join(dryRoot, 'raw');
  const outDir = path.join(dryRoot, 'out');
  const workBaseDir = path.join(dryRoot, 'work');
  const wireLogPath = path.join(rawDir, 'proxy_wire_log.jsonl');
  const checkpointPath = path.join(rawDir, 'checkpoint_runs.jsonl');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  let currentMockSpec = null;
  let reqSeq = 0;

  // Deterministic $0 mock upstream mimicking OpenRouter Anthropic SSE + reference fix application via Write tool
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.startsWith('/api/v1/messages/count_tokens')) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!req.url?.startsWith('/api/v1/messages')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = JSON.parse(raw);
      reqSeq += 1;
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      if (!parsed.stream || !hasTools) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `mock_probe_${reqSeq}`,
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 }
        }));
        return;
      }

      const trailingUserMsgs = [];
      for (let i = (parsed.messages?.length || 0) - 1; i >= 0; i -= 1) {
        if (parsed.messages[i]?.role === 'assistant') break;
        trailingUserMsgs.unshift(parsed.messages[i]);
      }
      const blocks = trailingUserMsgs.flatMap((m) =>
        Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content || '') }]
      );
      const userText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const hasToolResults = blocks.some((b) => b.type === 'tool_result');

      const refFileContent = fs.readFileSync(path.join(REF_DIR, 'T01', 'src', 'tierEngine.mjs'), 'utf8');

      // Plan turn (Turn 1): only Read
      if (userText.includes('read-only planning turn') && !hasToolResults) {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm: false,
          cost: parsed.model.includes('opus') ? 0.062 : 0.031,
          contentBlocks: [{ type: 'tool_use', id: `tu_${reqSeq}`, name: 'Read', input: { file_path: 'src/tierEngine.mjs' } }]
        });
        return;
      }
      if (hasToolResults && currentMockSpec?.turnPhase === 'plan') {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          cost: parsed.model.includes('opus') ? 0.004 : 0.002,
          contentBlocks: [{ type: 'text', text: 'Plan: fix computeGraduatedCharge in src/tierEngine.mjs.' }]
        });
        return;
      }

      // Implement turn on SONNET intentionally misses fixing file first so retry Turn 3 fires!
      if (currentMockSpec?.arm === 'SONNET' && userText.includes('Now implement your plan') && !hasToolResults) {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          cost: 0.003,
          contentBlocks: [{ type: 'text', text: 'Attempt 1 incomplete.' }]
        });
        return;
      }

      // Implement turn (OPUS/SWITCH) or Retry turn (SONNET): apply reference fix via Write tool!
      if ((userText.includes('Now implement your plan') || userText.includes(RETRY_PROMPT_HEADER)) && !hasToolResults) {
        const isSwitchFirstT2 = currentMockSpec?.arm === 'SWITCH' && userText.includes('Now implement your plan');
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm: !isSwitchFirstT2,
          cost: isSwitchFirstT2 ? 0.031 : 0.004,
          contentBlocks: [{
            type: 'tool_use',
            id: `tu_write_${reqSeq}`,
            name: 'Write',
            input: { file_path: 'src/tierEngine.mjs', content: refFileContent }
          }]
        });
        return;
      }

      writeMockSse(res, {
        model: parsed.model,
        msgId: `m_${reqSeq}`,
        stopReason: 'end_turn',
        isWarm: true,
        cost: parsed.model.includes('opus') ? 0.004 : 0.002,
        contentBlocks: [{ type: 'text', text: 'Done.' }]
      });
    });
  });

  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const caps = resolveCptCaps();
  const proxy = await startCptProxyServer({
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiPrefix: '/api',
    apiKey: 'sk-or-v1-dryrun-mock-00000000',
    wireLogPath,
    pinProvider: true,
    caps
  });

  try {
    const taskT01 = TASKS.find((t) => t.task_id === 'T01');
    const mockRuns = [
      { run_id: 'T01_OPUS_r01', task_id: 'T01', difficulty: 'easy', arm: 'OPUS', rep: 1, initial_model: OPUS_CLI, switch_to_model: null },
      { run_id: 'T01_SONNET_r01', task_id: 'T01', difficulty: 'easy', arm: 'SONNET', rep: 1, initial_model: SONNET_CLI, switch_to_model: null },
      { run_id: 'T01_SWITCH_r01', task_id: 'T01', difficulty: 'easy', arm: 'SWITCH', rep: 1, initial_model: OPUS_CLI, switch_to_model: SONNET_CLI }
    ];

    const origBeginTurn = proxy.beginTurn.bind(proxy);
    proxy.beginTurn = (turnNo, ctx) => {
      if (currentMockSpec) currentMockSpec.turnPhase = turnNo === 1 ? 'plan' : 'impl';
      return origBeginTurn(turnNo, ctx);
    };

    const results = [];
    for (const spec of mockRuns) {
      currentMockSpec = { ...spec, turnPhase: 'plan' };
      const r = await executeSingleRun({
        spec,
        task: taskT01,
        claudeExe,
        proxy,
        caps,
        cooldownMs: 0,
        rawDir,
        workBaseDir
      });
      fs.appendFileSync(checkpointPath, JSON.stringify(r) + '\n', 'utf8');
      results.push(r);
    }

    assert.equal(results[0].completed, true);
    assert.equal(results[0].turns, 2);
    assert.equal(results[0].attempts, 1);
    assert.equal(results[1].completed, true);
    assert.equal(results[1].turns, 3, 'SONNET mock should trigger 1 retry on Turn 3');
    assert.equal(results[1].attempts, 2);
    assert.equal(results[2].completed, true);
    assert.equal(results[2].set_model_control_ok, true);
    assert.ok(results[2].shadow_pre_model_switch_decision, 'Shadow PreModelSwitch decision must be recorded');
    assert.ok(results.every((r) => r.turn1_readonly_clean === true));

    // Verify guard breaker unit behavior ($3.00 / 30 req/turn)
    proxy.beginRun('GUARD_CHECK');
    proxy.beginTurn(1, { runId: 'GUARD_CHECK', arm: 'OPUS', rep: 1, taskId: 'T01', difficulty: 'easy' });
    for (let i = 0; i < 30; i += 1) {
      await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OPUS_CLI, stream: false, tools: [{ name: 'Read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] })
      });
    }
    const blockedRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OPUS_CLI, stream: false, tools: [{ name: 'Read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(blockedRes.status, 429);
    assert.equal(proxy.getState().capReason, 'turn_request_cap');

    // Filter out GUARD_CHECK from dryrun wire log before building deliverables
    const filteredWire = fs.readFileSync(wireLogPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.includes('"GUARD_CHECK"'))
      .join('\n') + '\n';
    fs.writeFileSync(wireLogPath, filteredWire, 'utf8');

    const deliv = buildCostPerTaskDeliverables({
      rawDir,
      outDir,
      preregistrationPath: path.join(outDir, 'none.json'),
      updateRedactionManifest: false
    });
    assert.equal(deliv.summaryRowCount, 3);
    assert.ok(deliv.requestRowCount >= 9);
    const mdText = fs.readFileSync(deliv.mdOutPath, 'utf8');
    assert.ok(mdText.includes('computed offline; not shown to the model'));
    assert.ok(mdText.includes('Cost / Completed Task'));

    console.log('DRY_RUN_MOCK_PASS');
    console.log(JSON.stringify({
      runs: results.map((r) => ({
        run_id: r.run_id,
        completed: r.completed,
        turns: r.turns,
        attempts: r.attempts,
        set_model_control_ok: r.set_model_control_ok,
        shadowDecision: r.shadow_pre_model_switch_decision,
        shadowBlocked: r.shadow_pre_model_switch_blocked,
        turn1_readonly_clean: r.turn1_readonly_clean
      })),
      guardCheckCapReason: proxy.getState().capReason,
      deliverables: {
        requestRowCount: deliv.requestRowCount,
        summaryRowCount: deliv.summaryRowCount
      }
    }, null, 2));
  } finally {
    await proxy.close();
    mockUpstream.close();
    fs.rmSync(dryRoot, { recursive: true, force: true });
  }
}

async function runLiveStage({ stageNum, resume, study = 'routine', maxStageSpendUsd = Infinity }) {
  const isHard = study === 'hard';
  const preregPath = path.join(
    RESULTS_DIR,
    isHard ? 'preregistration_cost_per_task_hard.json' : 'preregistration_cost_per_task.json'
  );
  if (!fs.existsSync(preregPath)) {
    throw new Error(`Missing pre-registration file at ${preregPath}.`);
  }
  const prereg = JSON.parse(fs.readFileSync(preregPath, 'utf8'));
  const schedule = stageNum === 1 ? prereg.schedules.stage1 : prereg.schedules.stage2;
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error(`Empty schedule for stage ${stageNum}`);
  }

  let taskCatalog = TASKS;
  let templateDir = TEMPLATE_DIR;
  let visibleDir = VISIBLE_DIR;
  let hiddenDir = HIDDEN_DIR;
  if (isHard) {
    const hardMod = await import('./hard_tier/hard_tasks_manifest.mjs');
    taskCatalog = hardMod.HARD_TASKS;
    templateDir = path.join(__dirname, 'hard_tier', 'task_repo_hard_template');
    visibleDir = path.join(__dirname, 'hard_tier', 'visible_suites');
    hiddenDir = path.join(__dirname, 'hard_tier', 'hidden_suites');
  }

  const apiKey = loadOpenRouterApiKey();
  const extraSecrets = [apiKey];
  const claudeExe = findClaudeExe();
  const rawDir = path.join(RESULTS_DIR, isHard ? 'cost_per_task_hard_raw' : 'cost_per_task_raw');
  const wireLogPath = path.join(rawDir, 'proxy_wire_log.jsonl');
  const checkpointPath = path.join(rawDir, 'checkpoint_runs.jsonl');
  const workBaseDir = path.join(os.tmpdir(), isHard ? 'cpt-hard-runtime' : 'cpt-runtime');
  fs.mkdirSync(rawDir, { recursive: true });

  const doneIds = new Set();
  if (resume && fs.existsSync(checkpointPath)) {
    for (const line of fs.readFileSync(checkpointPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (obj?.run_id) doneIds.add(obj.run_id);
      } catch {}
    }
  }

  const pending = schedule.filter((s) => !doneIds.has(s.run_id));
  const keyBefore = await httpsGetKeyUsage(apiKey);
  console.log(`[${study} Stage ${stageNum}] Starting ${pending.length}/${schedule.length} runs. Key remaining: $${keyBefore.limitRemaining} | maxStageSpend=$${maxStageSpendUsd}`);

  const caps = resolveCptCaps(prereg.caps || {});
  const proxy = await startCptProxyServer({
    port: 0,
    upstreamBaseUrl: 'https://openrouter.ai',
    upstreamApiPrefix: '/api',
    apiKey,
    wireLogPath,
    pinProvider: true,
    caps
  });

  let stageSpendSoFar = 0;
  try {
    for (let i = 0; i < pending.length; i += 1) {
      if (Number.isFinite(maxStageSpendUsd) && stageSpendSoFar >= maxStageSpendUsd) {
        console.log(`[${study} Stage ${stageNum}] Stage spend cap $${maxStageSpendUsd.toFixed(2)} reached ($${stageSpendSoFar.toFixed(4)}). Stopping before ${pending[i].run_id}.`);
        break;
      }
      const spec = pending[i];
      const task = taskCatalog.find((t) => t.task_id === spec.task_id);
      if (!task) throw new Error(`Task ${spec.task_id} not found`);
      console.log(`[${study} Stage ${stageNum}] (${i + 1}/${pending.length}) Running ${spec.run_id}...`);
      const res = await executeSingleRun({
        spec,
        task,
        claudeExe,
        proxy,
        caps,
        cooldownMs: COOLDOWN_MS,
        rawDir,
        workBaseDir,
        templateDir,
        visibleDir,
        hiddenDir,
        extraSecrets
      });
      fs.appendFileSync(checkpointPath, JSON.stringify(res) + '\n', 'utf8');
      stageSpendSoFar += Number(res.total_billed_usd || 0);
      console.log(
        `[${study} Stage ${stageNum}] Done ${res.run_id} | completed=${res.completed} | turns=${res.turns} | billed=$${res.total_billed_usd.toFixed(4)} | stageCum=$${stageSpendSoFar.toFixed(4)} | cap=${res.cap_reason || 'none'}`
      );
    }
  } finally {
    await proxy.close();
  }

  console.log(`[${study} Stage ${stageNum}] Waiting 300s idle before OpenRouter /api/v1/key settlement check...`);
  await new Promise((r) => setTimeout(r, 300_000));
  const snap1 = await httpsGetKeyUsage(apiKey);
  await new Promise((r) => setTimeout(r, 60_000));
  const snap2 = await httpsGetKeyUsage(apiKey);

  const stageRunIds = new Set(schedule.map((s) => s.run_id));
  const allCheckpoint = fs.readFileSync(checkpointPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => stageRunIds.has(r.run_id));
  const summedRunBilledUsd = allCheckpoint.reduce((s, r) => s + Number(r.total_billed_usd || 0), 0);
  const keyDeltaUsd = (snap2.usage ?? 0) - (keyBefore.usage ?? 0);

  const rec = {
    study,
    stage: `stage${stageNum}`,
    recordedAtUtc: new Date().toISOString(),
    runCount: allCheckpoint.length,
    usageBeforeUsd: keyBefore.usage,
    usageAfterSnap1Usd: snap1.usage,
    usageAfterSettledUsd: snap2.usage,
    keyDeltaUsd: Number(keyDeltaUsd.toFixed(8)),
    summedRunBilledUsd: Number(summedRunBilledUsd.toFixed(8)),
    residualUsd: Number((keyDeltaUsd - summedRunBilledUsd).toFixed(8))
  };
  fs.writeFileSync(path.join(rawDir, `stage${stageNum}_reconciliation.json`), JSON.stringify(rec, null, 2) + '\n', 'utf8');

  buildCostPerTaskDeliverables({
    rawDir,
    outDir: RESULTS_DIR,
    preregistrationPath: preregPath,
    tierLabel: isHard ? 'hard tier' : 'routine tasks',
    runsCsvName: isHard ? 'runs_cost_per_task_hard.csv' : 'runs_cost_per_task.csv',
    summaryCsvName: isHard ? 'run_summary_cost_per_task_hard.csv' : 'run_summary_cost_per_task.csv',
    summaryMdName: isHard ? 'summary_cost_per_task_hard.md' : 'summary_cost_per_task.md',
    repoDesc: isHard
      ? '18-file zero-dependency Node.js repository (`ledgerpulse` hard tier)'
      : '16-file zero-dependency Node.js repository (`ledgerpulse`)',
    updateRedactionManifest: true,
    extraSecrets
  });

  console.log(`STAGE_${stageNum}_COMPLETE:`, JSON.stringify(rec, null, 2));
}

function parseCliArgs(argv = []) {
  const out = {
    dryRunMock: false,
    stage: null,
    confirmLiveSpend: false,
    resume: false,
    study: 'routine',
    maxStageSpendUsd: Infinity
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run-mock') out.dryRunMock = true;
    else if (a === '--confirm-live-spend') out.confirmLiveSpend = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--stage' && argv[i + 1]) out.stage = Number(argv[++i]);
    else if (a === '--study' && argv[i + 1]) out.study = String(argv[++i]).toLowerCase();
    else if (a === '--max-stage-spend' && argv[i + 1]) out.maxStageSpendUsd = Number(argv[++i]) || Infinity;
  }
  return out;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const flags = parseCliArgs(process.argv.slice(2));
  if (flags.dryRunMock) {
    runDryRunMock().catch((err) => {
      console.error('DRY_RUN_MOCK_FAIL:', err);
      process.exit(1);
    });
  } else if (flags.stage === 1 || flags.stage === 2) {
    if (!flags.confirmLiveSpend) {
      console.error(`Refusing live spend for --stage ${flags.stage} without explicit --confirm-live-spend flag.`);
      process.exit(1);
    }
    runLiveStage({
      stageNum: flags.stage,
      resume: flags.resume,
      study: flags.study,
      maxStageSpendUsd: flags.maxStageSpendUsd
    }).catch((err) => {
      console.error(`STAGE_${flags.stage}_FAIL:`, err);
      process.exit(1);
    });
  } else {
    console.log('Usage: node run_cost_per_task.mjs [--dry-run-mock | --stage <1|2> --confirm-live-spend [--study routine|hard] [--max-stage-spend USD] [--resume]]');
  }
}
