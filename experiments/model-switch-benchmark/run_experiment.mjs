import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  RESULTS_DIR,
  CLAUDE_EXE,
  FROZEN_REPO_DIR,
  RUNS_WORK_DIR,
  PINNED_REPO_COMMIT,
  PINNED_CLAUDE_CODE_VERSION,
  MAX_BUDGET_USD,
  PILOT_BUDGET_USD,
  ARM_E_IDLE_SECONDS,
  buildPilotSchedule,
  buildFullSchedule,
  loadOpenRouterApiKey,
  normalizeModelShortName
} from './config.mjs';
import { startProxyServer } from './proxy_recorder.mjs';

function parseArgs(argv = []) {
  const flags = {
    pilot: false,
    calibOnly: false,
    runAll: false,
    resume: false,
    stripCacheTtl: false,
    maxRuns: Infinity,
    maxBudgetUsd: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pilot') flags.pilot = true;
    else if (a === '--calib-only') flags.calibOnly = true;
    else if (a === '--run-all') flags.runAll = true;
    else if (a === '--resume') flags.resume = true;
    else if (a === '--strip-cache-ttl') flags.stripCacheTtl = true;
    else if (a === '--max-runs' && argv[i + 1]) {
      flags.maxRuns = Number(argv[++i]) || Infinity;
    } else if (a === '--max-budget' && argv[i + 1]) {
      flags.maxBudgetUsd = Number(argv[++i]) || null;
    }
  }
  return flags;
}

function loadPrompts(tier) {
  const filename = tier === 'large' ? 'prompts_large.json' : 'prompts_small.json';
  const fullPath = path.join(EXPERIMENT_DIR, 'fixtures', filename);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function sanitizeTranscriptText(rawText, homeDir, cfgDir) {
  let out = rawText
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]');
  for (const [needle, repl] of [
    [FROZEN_REPO_DIR, '<FROZEN_REPO>'],
    [FROZEN_REPO_DIR.replace(/\\/g, '/'), '<FROZEN_REPO>'],
    [FROZEN_REPO_DIR.replace(/\\/g, '\\\\'), '<FROZEN_REPO>'],
    [homeDir, '<ISOLATED_HOME>'],
    [homeDir.replace(/\\/g, '/'), '<ISOLATED_HOME>'],
    [homeDir.replace(/\\/g, '\\\\'), '<ISOLATED_HOME>'],
    [cfgDir, '<ISOLATED_CLAUDE_CONFIG>'],
    [cfgDir.replace(/\\/g, '/'), '<ISOLATED_CLAUDE_CONFIG>'],
    [cfgDir.replace(/\\/g, '\\\\'), '<ISOLATED_CLAUDE_CONFIG>']
  ]) {
    if (needle) out = out.split(needle).join(repl);
  }
  out = out
    .replace(/C:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
    .replace(/C:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]');
  return out;
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

function verifyRuntimeEnvironment() {
  if (!fs.existsSync(CLAUDE_EXE)) {
    throw new Error(`Pinned claude.exe missing at ${CLAUDE_EXE}. Run setup first.`);
  }
  if (!fs.existsSync(FROZEN_REPO_DIR)) {
    throw new Error(`Frozen repo missing at ${FROZEN_REPO_DIR}. Run setup first.`);
  }
  const verRes = spawnSync(CLAUDE_EXE, ['--version'], { encoding: 'utf8' });
  const versionOutput = String(verRes.stdout || verRes.stderr || '').trim();
  const gitRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: FROZEN_REPO_DIR, encoding: 'utf8' });
  const actualCommit = String(gitRes.stdout || '').trim();
  if (actualCommit !== PINNED_REPO_COMMIT) {
    throw new Error(`Frozen repo HEAD ${actualCommit} !== expected ${PINNED_REPO_COMMIT}`);
  }
  return { versionOutput, actualCommit };
}

function resetFrozenRepo() {
  const co = spawnSync('git', ['checkout', '-f', PINNED_REPO_COMMIT], { cwd: FROZEN_REPO_DIR, encoding: 'utf8' });
  if (co.status !== 0) throw new Error(`git checkout failed: ${co.stderr}`);
  const cl = spawnSync('git', ['clean', '-fdx'], { cwd: FROZEN_REPO_DIR, encoding: 'utf8' });
  if (cl.status !== 0) throw new Error(`git clean failed: ${cl.stderr}`);
}

function runClaudeTurn({
  prompt,
  model,
  effort,
  sessionId,
  appendSystemPrompt,
  homeDir,
  cfgDir,
  settingsPath,
  proxyBaseUrl,
  timeoutMs = 180000
}) {
  return new Promise((resolve) => {
    const args = [];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(
      '-p', prompt,
      '--model', model,
      '--effort', effort,
      '--tools', 'Read',
      '--append-system-prompt', appendSystemPrompt,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--settings', settingsPath
    );

    const env = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.OPENROUTER_API_KEY;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    env.ANTHROPIC_BASE_URL = proxyBaseUrl;
    env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.CLAUDE_CONFIG_DIR = cfgDir;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;

    const startNs = process.hrtime.bigint();
    const child = spawn(CLAUDE_EXE, args, {
      cwd: FROZEN_REPO_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const stdout = Buffer.concat(outChunks).toString('utf8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();

      let parsedOut = null;
      try {
        parsedOut = stdout ? JSON.parse(stdout) : null;
      } catch {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsedOut = JSON.parse(lines[i]);
            break;
          } catch {}
        }
      }

      resolve({
        code,
        timedOut,
        wallMs: Number(wallMs.toFixed(2)),
        parsedOut,
        stdoutPreview: stdout.slice(0, 400),
        stderrPreview: stderr.slice(0, 400)
      });
    });
  });
}

function readWireLogsForTurn(wireLogPath, runId, turn) {
  if (!fs.existsSync(wireLogPath)) return [];
  const lines = fs.readFileSync(wireLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const matched = [];
  for (const l of lines) {
    try {
      const obj = JSON.parse(l);
      if (obj?.context?.runId === runId && obj?.context?.turn === turn) {
        matched.push(obj);
      }
    } catch {}
  }
  return matched;
}

function verifyPilotGate(wireLogPath, runStates) {
  const checks = [];
  const controlRun = runStates.find((r) => r.runId === 'PILOT_A_S_r01');
  const switchCRun = runStates.find((r) => r.runId === 'PILOT_C_S_r01');
  const effortDRun = runStates.find((r) => r.runId === 'PILOT_D_S_r01');
  const largeBRun = runStates.find((r) => r.runId === 'PILOT_B_L_r01');

  const lines = fs.readFileSync(wireLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const mainFor = (runId, turn) => lines.filter((r) => !r.isSideCall && r.context?.runId === runId && r.context?.turn === turn && r.statusCode === 200);

  // 1. Control Turn 2-5 cache_hit_ratio >= 0.80 and Turn 5 Small total_input_tokens in [4500, 11000]
  if (controlRun) {
    const t2 = mainFor(controlRun.runId, 2)[0];
    const t5 = mainFor(controlRun.runId, 5)[0];
    const t6 = mainFor(controlRun.runId, 6)[0];
    checks.push({
      name: 'control_small_t2_hit_ratio',
      pass: Boolean(t2 && t2.usage.cache_hit_ratio >= 0.70),
      actual: t2 ? Number(t2.usage.cache_hit_ratio.toFixed(4)) : null
    });
    checks.push({
      name: 'control_small_t5_hit_ratio',
      pass: Boolean(t5 && t5.usage.cache_hit_ratio >= 0.80),
      actual: t5 ? Number(t5.usage.cache_hit_ratio.toFixed(4)) : null
    });
    checks.push({
      name: 'control_small_t5_prefix_size',
      pass: Boolean(t5 && t5.usage.total_input_tokens >= 11000 && t5.usage.total_input_tokens <= 16000),
      actual: t5?.usage?.total_input_tokens ?? null
    });
    checks.push({
      name: 'ephemeral_5m_ttl_confirmed',
      pass: Boolean(t6 && t6.usage.ephemeral_1h_input_tokens === 0),
      actual: { eph5m: t5?.usage?.ephemeral_5m_input_tokens, eph1h: t5?.usage?.ephemeral_1h_input_tokens }
    });
    checks.push({
      name: 'single_api_call_t5_t6',
      pass: mainFor(controlRun.runId, 5).length === 1 && mainFor(controlRun.runId, 6).length === 1,
      actual: { t5Calls: mainFor(controlRun.runId, 5).length, t6Calls: mainFor(controlRun.runId, 6).length }
    });
  }

  if (largeBRun) {
    const lt5 = mainFor(largeBRun.runId, 5)[0];
    const lt6 = mainFor(largeBRun.runId, 6)[0];
    checks.push({
      name: 'large_t5_prefix_size',
      pass: Boolean(lt5 && lt5.usage.total_input_tokens >= 50000 && lt5.usage.total_input_tokens <= 68000),
      actual: lt5?.usage?.total_input_tokens ?? null
    });
    checks.push({
      name: 'large_t6_switch_single_call',
      pass: mainFor(largeBRun.runId, 6).length === 1 && Boolean(lt6),
      actual: { t6Calls: mainFor(largeBRun.runId, 6).length, t6HitRatio: lt6 ? Number(lt6.usage.cache_hit_ratio.toFixed(4)) : null }
    });
  }

  return {
    allPassed: checks.every((c) => c.pass),
    checks,
    summaries: {
      PILOT_A_S_r01: summarizeRunTurns(lines, 'PILOT_A_S_r01'),
      PILOT_C_S_r01: summarizeRunTurns(lines, 'PILOT_C_S_r01'),
      PILOT_D_S_r01: summarizeRunTurns(lines, 'PILOT_D_S_r01'),
      PILOT_B_L_r01: summarizeRunTurns(lines, 'PILOT_B_L_r01')
    }
  };
}

function summarizeRunTurns(lines, runId) {
  return lines
    .filter((r) => !r.isSideCall && r.context?.runId === runId && r.statusCode === 200)
    .map((r) => ({
      turn: r.context.turn,
      model: normalizeModelShortName(r.responseModel || r.mappedModel),
      effort: r.requestFingerprint?.output_config?.effort || r.context.scheduledEffort,
      input: r.usage.input_tokens,
      write: r.usage.cache_creation_input_tokens,
      eph5m: r.usage.ephemeral_5m_input_tokens,
      eph1h: r.usage.ephemeral_1h_input_tokens,
      read: r.usage.cache_read_input_tokens,
      out: r.usage.output_tokens,
      totalIn: r.usage.total_input_tokens,
      hitPct: Number((r.usage.cache_hit_ratio * 100).toFixed(1)),
      costUsd: Number(r.cost.totalCostUsd.toFixed(5)),
      ttfbMs: r.timing.ttfbMs,
      wallMs: r.context.cliWallMs ?? r.timing.latencyMs
    }));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.pilot && !flags.runAll) {
    console.error('Usage: node run_experiment.mjs [--pilot | --run-all] [--resume] [--strip-cache-ttl]');
    process.exit(1);
  }

  const mode = flags.pilot ? 'pilot' : 'full';
  const modeDir = flags.pilot ? path.join(RESULTS_DIR, 'pilot') : path.join(RESULTS_DIR, 'raw');
  const transcriptsDir = path.join(modeDir, 'transcripts');
  const wireLogPath = path.join(modeDir, 'proxy_wire_log.jsonl');
  const cliTurnsPath = path.join(modeDir, 'cli_turns.jsonl');
  const ledgerPath = path.join(modeDir, 'openrouter_ledger.jsonl');
  const checkpointPath = path.join(modeDir, 'checkpoint.json');
  const manifestPath = path.join(modeDir, 'run_manifest.json');

  fs.mkdirSync(transcriptsDir, { recursive: true });
  if (!flags.resume) {
    for (const f of [wireLogPath, cliTurnsPath, ledgerPath, checkpointPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  const apiKey = loadOpenRouterApiKey();
  const runtimeInfo = verifyRuntimeEnvironment();
  const budgetCap = flags.maxBudgetUsd || (flags.pilot ? PILOT_BUDGET_USD : MAX_BUDGET_USD);
  const proxy = await startProxyServer({
    port: 0,
    upstreamBaseUrl: 'https://openrouter.ai',
    upstreamApiPrefix: '/api',
    apiKey,
    maxBudgetUsd: budgetCap,
    wireLogPath,
    pinProvider: true,
    stripCacheTtl: flags.stripCacheTtl
  });

  const keyStart = await fetchOpenRouterKeyUsage(apiKey);
  fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'start', ...keyStart }) + '\n', 'utf8');

  const baseSchedule = flags.pilot
    ? (flags.calibOnly
        ? buildPilotSchedule().filter((r) => r.runId === 'PILOT_A_S_r01' || r.runId === 'PILOT_B_L_r01')
        : buildPilotSchedule())
    : buildFullSchedule();
  const scheduledRuns = baseSchedule.slice(0, flags.maxRuns);
  const promptsCache = {
    small: loadPrompts('small'),
    large: loadPrompts('large')
  };

  let checkpoint = { mode, runs: {} };
  if (flags.resume && fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    mode,
    startedAt: new Date().toISOString(),
    pinnedRepoCommit: runtimeInfo.actualCommit,
    claudeCodeVersion: runtimeInfo.versionOutput,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    predictionsSha256: crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(EXPERIMENT_DIR, 'predictions.md'), 'utf8'))
      .digest('hex'),
    armEIdleSeconds: ARM_E_IDLE_SECONDS,
    budgetCapUsd: budgetCap,
    scheduledRuns: scheduledRuns.map((r) => ({
      runId: r.runId,
      arm: r.arm,
      tier: r.tier,
      replicate: r.replicate,
      turnsToRun: r.turnsToRun
    }))
  }, null, 2));

  // Initialize mutable run queue states
  const runQueue = scheduledRuns.map((spec) => {
    const existing = checkpoint.runs[spec.runId];
    const workRoot = path.join(RUNS_WORK_DIR, mode, spec.runId);
    const homeDir = path.join(workRoot, 'home');
    const cfgDir = path.join(workRoot, 'claude_config');
    const settingsPath = path.join(workRoot, 'frozen_settings.json');
    if (!existing) {
      fs.rmSync(workRoot, { recursive: true, force: true });
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');
    }
    const salt = existing?.salt || `Benchmark-Run-Salt: ${spec.runId}_${crypto.createHash('sha256').update(spec.runId + '_' + mode).digest('hex').slice(0, 8)}`;
    return {
      ...spec,
      workRoot,
      homeDir,
      cfgDir,
      settingsPath,
      salt,
      sessionId: existing?.sessionId || null,
      nextTurn: existing?.nextTurn || 1,
      completed: Boolean(existing?.completed),
      turn5FinishedAtMs: existing?.turn5FinishedAtMs || 0,
      parkedUntilMs: existing?.parkedUntilMs || 0,
      actualIdleSec: existing?.actualIdleSec ?? null
    };
  });

  function saveCheckpoint(runState) {
    checkpoint.runs[runState.runId] = {
      sessionId: runState.sessionId,
      nextTurn: runState.nextTurn,
      completed: runState.completed,
      salt: runState.salt,
      turn5FinishedAtMs: runState.turn5FinishedAtMs,
      parkedUntilMs: runState.parkedUntilMs,
      actualIdleSec: runState.actualIdleSec
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
  }

  async function executeSingleRunSegment(runState, stopAfterTurn = runState.turnsToRun) {
    if (!runState.sessionId && runState.nextTurn === 1) {
      resetFrozenRepo();
    }
    const tierPrompts = promptsCache[runState.tier].prompts;

    while (runState.nextTurn <= stopAfterTurn && !runState.completed) {
      const turn = runState.nextTurn;
      const stepSpec = runState.schedule[turn - 1];
      const promptObj = tierPrompts[turn - 1];

      let actualIdleSec = null;
      if (runState.arm === 'E' && turn === 6 && runState.turn5FinishedAtMs > 0) {
        const waitMs = Math.max(0, runState.parkedUntilMs - Date.now());
        if (waitMs > 0) {
          console.log(`[${runState.runId}] Waiting ${(waitMs / 1000).toFixed(1)}s before Turn 6 to clear 5m TTL...`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
        actualIdleSec = Number(((Date.now() - runState.turn5FinishedAtMs) / 1000).toFixed(2));
        runState.actualIdleSec = actualIdleSec;
      }

      let turnResult = null;
      let attempt = 0;
      while (attempt < 2) {
        attempt += 1;
        proxy.setContext({
          runId: runState.runId,
          arm: runState.arm,
          tier: runState.tier,
          replicate: runState.replicate,
          turn,
          attempt,
          phase: promptObj.phase,
          scheduledModel: stepSpec.model,
          scheduledEffort: stepSpec.effort,
          actualIdleSec
        });

        turnResult = await runClaudeTurn({
          prompt: promptObj.prompt,
          model: stepSpec.model,
          effort: stepSpec.effort,
          sessionId: runState.sessionId,
          appendSystemPrompt: runState.salt,
          homeDir: runState.homeDir,
          cfgDir: runState.cfgDir,
          settingsPath: runState.settingsPath,
          proxyBaseUrl: proxy.baseUrl
        });

        // Update CLI wall time in wire log check
        const turnWireLogs = readWireLogsForTurn(wireLogPath, runState.runId, turn);
        const okMain = turnWireLogs.filter((w) => !w.isSideCall && w.statusCode === 200);
        if (turnResult.code === 0 && !turnResult.timedOut && okMain.length > 0) {
          break;
        }
        if (proxy.getState().budgetExceeded) {
          throw new Error(`Budget circuit breaker triggered ($${proxy.getState().totalSpendUsd}). Halting cleanly.`);
        }
        console.warn(`[${runState.runId}] Turn ${turn} attempt ${attempt} issue (code=${turnResult.code}, okMain=${okMain.length}, stderr=${turnResult.stderrPreview}). Retrying once after 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }

      const returnedSessionId = turnResult?.parsedOut?.session_id;
      if (returnedSessionId && !runState.sessionId) {
        runState.sessionId = returnedSessionId;
      }
      if (!runState.sessionId) {
        const jsonls = findSessionJsonlFiles(runState.cfgDir);
        if (jsonls.length > 0) {
          runState.sessionId = path.basename(jsonls[0], '.jsonl');
        }
      }

      fs.appendFileSync(cliTurnsPath, JSON.stringify({
        runId: runState.runId,
        arm: runState.arm,
        tier: runState.tier,
        replicate: runState.replicate,
        turn,
        scheduledModel: stepSpec.model,
        scheduledEffort: stepSpec.effort,
        actualIdleSec,
        exitCode: turnResult.code,
        wallMs: turnResult.wallMs,
        durationMs: turnResult.parsedOut?.duration_ms ?? null,
        durationApiMs: turnResult.parsedOut?.duration_api_ms ?? null,
        totalCostUsd: turnResult.parsedOut?.total_cost_usd ?? null,
        usage: turnResult.parsedOut?.usage ?? null,
        modelUsage: turnResult.parsedOut?.modelUsage ?? null
      }) + '\n', 'utf8');

      console.log(`[${runState.runId}] T${turn}/${runState.turnsToRun} | ${stepSpec.model.replace('claude-', '')} | eff=${stepSpec.effort} | cliWall=${turnResult.wallMs}ms | cumSpend=$${proxy.getState().totalSpendUsd.toFixed(4)}`);

      if (turnResult.code !== 0) {
        throw new Error(`[${runState.runId}] Turn ${turn} failed after retry: ${turnResult.stderrPreview || turnResult.stdoutPreview}`);
      }

      runState.nextTurn = turn + 1;
      if (runState.arm === 'E' && turn === 5 && stopAfterTurn === 5) {
        runState.turn5FinishedAtMs = Date.now();
        runState.parkedUntilMs = runState.turn5FinishedAtMs + (ARM_E_IDLE_SECONDS * 1000);
        saveCheckpoint(runState);
        return;
      }

      if (runState.nextTurn > runState.turnsToRun) {
        runState.completed = true;
        // Archive sanitized transcript
        const jsonls = findSessionJsonlFiles(runState.cfgDir);
        if (jsonls.length > 0) {
          // Pick largest/main session transcript (matches sessionId if possible)
          const mainFile = jsonls.find((p) => runState.sessionId && p.includes(runState.sessionId)) || jsonls[0];
          const rawJsonl = fs.readFileSync(mainFile, 'utf8');
          const cleanJsonl = sanitizeTranscriptText(rawJsonl, runState.homeDir, runState.cfgDir);
          fs.writeFileSync(path.join(transcriptsDir, `${runState.runId}.jsonl`), cleanJsonl, 'utf8');
        }
      }
      saveCheckpoint(runState);
    }
  }

  try {
    // Single-wire-concurrency scheduler supporting parked Arm E runs during 330s TTL wait
    while (runQueue.some((r) => !r.completed)) {
      const now = Date.now();
      // 1. Priority: resume any parked Arm E run whose TTL wait has expired
      const readyParked = runQueue.find((r) => !r.completed && r.arm === 'E' && r.nextTurn === 6 && r.parkedUntilMs > 0 && now >= r.parkedUntilMs);
      if (readyParked) {
        await executeSingleRunSegment(readyParked, readyParked.turnsToRun);
        continue;
      }

      // 2. Otherwise pick next runnable non-parked run
      const nextRun = runQueue.find((r) => !r.completed && !(r.arm === 'E' && r.nextTurn === 6 && r.parkedUntilMs > 0));
      if (nextRun) {
        if (nextRun.arm === 'E' && nextRun.nextTurn <= 5) {
          await executeSingleRunSegment(nextRun, 5);
        } else {
          await executeSingleRunSegment(nextRun, nextRun.turnsToRun);
        }
        continue;
      }

      // 3. Only parked Arm E runs remain: finish earliest one (sleeps remaining time cleanly)
      const parked = runQueue
        .filter((r) => !r.completed && r.arm === 'E' && r.parkedUntilMs > 0)
        .sort((a, b) => a.parkedUntilMs - b.parkedUntilMs);
      if (parked.length > 0) {
        await executeSingleRunSegment(parked[0], parked[0].turnsToRun);
      }
    }

    // Wait 10s for OpenRouter async usage accounting to settle before querying /api/v1/key
    await new Promise((r) => setTimeout(r, 10000));
    const keyEnd = await fetchOpenRouterKeyUsage(apiKey);
    fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'end', ...keyEnd }) + '\n', 'utf8');

    const proxyState = proxy.getState();
    console.log('\n=== EXECUTION SUMMARY ===');
    console.log(JSON.stringify({
      mode,
      runsCompleted: runQueue.filter((r) => r.completed).length,
      proxyTotalSpendUsd: proxyState.totalSpendUsd,
      openRouterUsageBeforeUsd: keyStart?.usage ?? null,
      openRouterUsageAfterUsd: keyEnd?.usage ?? null,
      openRouterDeltaUsd: (typeof keyStart?.usage === 'number' && typeof keyEnd?.usage === 'number')
        ? Number((keyEnd.usage - keyStart.usage).toFixed(6))
        : null,
      mainRequests: proxyState.mainRequestsCount,
      sideCalls: proxyState.sideCallsCount
    }, null, 2));

    if (flags.pilot) {
      const gate = verifyPilotGate(wireLogPath, runQueue);
      fs.writeFileSync(path.join(modeDir, 'pilot_gate_report.json'), JSON.stringify(gate, null, 2), 'utf8');
      console.log('\n=== PILOT GATE ===');
      console.log(JSON.stringify(gate, null, 2));
      if (!gate.allPassed) {
        console.error('PILOT GATE FAILED! Inspect results/pilot/pilot_gate_report.json before running full suite.');
        process.exitCode = 2;
      }
    }
  } finally {
    await proxy.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
