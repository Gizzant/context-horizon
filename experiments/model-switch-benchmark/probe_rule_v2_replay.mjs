import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  PINNED_REPO_COMMIT,
  MODEL_A_CLI,
  MODEL_B_CLI,
  EFFORT_BASELINE
} from './config.mjs';
import { installAttentionHorizon, ensureGitExcludeEntries } from '../../bin/ctxtop.mjs';
import { activateLocalTrial } from '../../src/core/pro_license.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { EMPIRICAL_SESSION_API_CALL_PRIOR } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';

const RESULTS_V2_DIR = path.join(EXPERIMENT_DIR, 'results', 'round2_c2', 'rule_v2');
const RUNS_V2_CSV = path.join(RESULTS_V2_DIR, 'runs_round2_c2.csv');

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

function escapeCsv(val) {
  if (val === null || val === undefined || val === '') return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sanitizeText(rawText) {
  const username = os.userInfo().username || '';
  let text = String(rawText ?? '');
  for (const variant of [REPO_ROOT, REPO_ROOT.replace(/\\/g, '/'), REPO_ROOT.replace(/\\/g, '\\\\')]) {
    if (variant) text = text.split(variant).join('<REPO_ROOT>');
  }
  text = text
    .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+\\\\AppData\\\\Local\\\\Temp\\\\[^\\"\s]+/gi, '<TEMP>')
    .replace(/[A-Za-z]:\\Users\\[^\\"\s]+\\AppData\\Local\\Temp\\[^\\"\s]+/gi, '<TEMP>')
    .replace(/[A-Za-z]:\/Users\/[^/"\s]+\/AppData\/Local\/Temp\/[^/"\s]+/gi, '<TEMP>')
    .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
    .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]')
    .replace(/\/Users\/[^/"\s]+/g, '/Users/[USER]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]');
  if (username && username.length >= 3) {
    const rx = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(rx, '[USER]');
  }
  return text;
}

function findRuntimePaths() {
  const tmpDir = os.tmpdir();
  const candidates = fs
    .readdirSync(tmpDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-model-switch-runtime'))
    .map((d) => path.join(tmpDir, d.name));
  for (const rtRoot of candidates) {
    const claudeExe = path.join(rtRoot, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const frozenRepoDir = path.join(rtRoot, 'frozen-repo');
    if (fs.existsSync(claudeExe) && fs.existsSync(frozenRepoDir)) {
      return { rtRoot, claudeExe, frozenRepoDir };
    }
  }
  return null;
}

function resetFrozenRepoClean(frozenRepoDir) {
  spawnSync('git', ['checkout', '-f', PINNED_REPO_COMMIT], { cwd: frozenRepoDir, encoding: 'utf8' });
  spawnSync('git', ['clean', '-fdx'], { cwd: frozenRepoDir, encoding: 'utf8' });
  ensureGitExcludeEntries(frozenRepoDir);
}

function loadRunPreSwitchSequences() {
  const lines = fs.readFileSync(RUNS_V2_CSV, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const hdr = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cols = parseCsvLine(l);
    return Object.fromEntries(hdr.map((h, i) => [h, cols[i] ?? '']));
  });

  const targetRuns = [
    { run_id: 'C2_L1_hb_rule_v2_r01', arm: 'L1', rep: 1, switch_turn: 3 },
    { run_id: 'C2_L1_hb_rule_v2_r02', arm: 'L1', rep: 2, switch_turn: 3 },
    { run_id: 'C2_L1_hb_rule_v2_r03', arm: 'L1', rep: 3, switch_turn: 3 },
    { run_id: 'C2_L2_hb_rule_v2_r01', arm: 'L2', rep: 1, switch_turn: 24 }
  ];

  return targetRuns.map((spec) => {
    const preMainRows = rows.filter(
      (r) =>
        r.run_id === spec.run_id &&
        r.is_side_call === 'false' &&
        Number(r.turn) < spec.switch_turn
    );
    const last = preMainRows[preMainRows.length - 1];
    const lastIn = Number(last.input_tokens || 0);
    const lastCw = Number(last.cache_creation_input_tokens || 0);
    const lastCr = Number(last.cache_read_input_tokens || 0);
    const lastOut = Number(last.output_tokens || 0);
    return {
      ...spec,
      preMainRows,
      lastUsage: {
        input_tokens: lastIn,
        cache_creation_input_tokens: lastCw,
        cache_read_input_tokens: lastCr,
        output_tokens: lastOut
      },
      contextTokensAtSwitch: lastIn + lastCw + lastCr + lastOut
    };
  });
}

async function startReplayMockServer(recordedPreTurnsByTurn) {
  let reqSeq = 0;
  let currentTurn = 1;
  let turnCallIdx = 0;

  const server = http.createServer((req, res) => {
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1000 }));
        return;
      }

      if (!body.stream) {
        reqSeq += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_sync_${reqSeq}`,
            type: 'message',
            role: 'assistant',
            model: body.model || MODEL_A_CLI,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 }
          })
        );
        return;
      }

      reqSeq += 1;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      let rawUsage;
      if (!hasTools) {
        rawUsage = {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          output_tokens: 12
        };
      } else {
        const turnRows = recordedPreTurnsByTurn.get(currentTurn) || [];
        const chosen = turnRows[Math.min(turnCallIdx, Math.max(0, turnRows.length - 1))] || turnRows[turnRows.length - 1];
        turnCallIdx += 1;
        const cw = Number(chosen?.cache_creation_input_tokens || 1000);
        rawUsage = {
          input_tokens: Number(chosen?.input_tokens || 3),
          cache_creation_input_tokens: cw,
          cache_read_input_tokens: Number(chosen?.cache_read_input_tokens || 0),
          cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 },
          output_tokens: Number(chosen?.output_tokens || 130)
        };
      }

      const evs = [
        {
          type: 'message_start',
          message: {
            id: `msg_probe_${reqSeq}`,
            type: 'message',
            role: 'assistant',
            model: body.model || MODEL_A_CLI,
            content: [],
            stop_reason: null,
            usage: { ...rawUsage, output_tokens: 1 }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ack (mock probe).' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: rawUsage.output_tokens } },
        { type: 'message_stop' }
      ];

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    setTurn(t) {
      currentTurn = t;
      turnCallIdx = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  };
}

async function runLiveClaudeMockStdinCapture(runSpec, runtimePaths) {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ctxtop-v2-probe-${runSpec.arm}-`));
  const homeDir = path.join(probeRoot, 'home');
  const cfgDir = path.join(probeRoot, 'claude_config');
  const settingsPath = path.join(probeRoot, 'settings.json');
  const teeScriptPath = path.join(probeRoot, 'pre_model_switch_tee.mjs');
  const capturedStdinPath = path.join(probeRoot, 'captured_hook_stdin.jsonl');
  const licensePath = path.join(homeDir, '.ctxtop', 'license.json');

  const preByTurn = new Map();
  for (const r of runSpec.preMainRows) {
    const t = Number(r.turn);
    if (!preByTurn.has(t)) preByTurn.set(t, []);
    preByTurn.get(t).push(r);
  }
  const server = await startReplayMockServer(preByTurn);

  try {
    resetFrozenRepoClean(runtimePaths.frozenRepoDir);
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    activateLocalTrial({ homeDir, licensePath });
    const ahDir = path.join(homeDir, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(
      path.join(ahDir, 'config.json'),
      JSON.stringify({ flightMode: 'AUTO_PILOT', useEmpiricalHorizonPrior: true }, null, 2),
      'utf8'
    );
    installAttentionHorizon({
      settingsPath,
      cwd: runtimePaths.frozenRepoDir,
      leanHooks: false
    });

    const realHandler = path.join(REPO_ROOT, 'hooks', 'handlers', 'pre-model-switch.mjs');
    fs.writeFileSync(
      teeScriptPath,
      `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const raw = fs.readFileSync(0, 'utf8');
const res = spawnSync(process.execPath, [${JSON.stringify(realHandler)}], { input: raw, encoding: 'utf8', env: process.env });
fs.appendFileSync(${JSON.stringify(capturedStdinPath)}, JSON.stringify({ stdinRaw: raw, parsed: JSON.parse(raw), exitCode: res.status, stdout: res.stdout, stderr: res.stderr }) + '\\n', 'utf8');
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status ?? 0);
`,
      'utf8'
    );

    const parsedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    parsedSettings.hooks.PreModelSwitch = [
      {
        hooks: [{ type: 'command', command: `node "${teeScriptPath.replace(/\\/g, '/')}"` }]
      }
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(parsedSettings, null, 2), 'utf8');

    const env = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.OPENROUTER_API_KEY;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    env.ANTHROPIC_BASE_URL = server.baseUrl;
    env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
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
      '--include-hook-events',
      '--dangerously-skip-permissions',
      '--tools', 'Read',
      '--model', MODEL_A_CLI,
      '--effort', EFFORT_BASELINE,
      '--settings', settingsPath,
      '--setting-sources', 'local'
    ];

    const child = spawn(runtimePaths.claudeExe, args, {
      cwd: runtimePaths.frozenRepoDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const events = [];
    let stdoutBuf = '';
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

    const waitForEvent = (pred, fromIndex = 0, timeoutMs = 45000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const iv = setInterval(() => {
          for (let i = fromIndex; i < events.length; i++) {
            if (pred(events[i], i)) {
              clearInterval(iv);
              resolve({ event: events[i], index: i });
              return;
            }
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(iv);
            reject(new Error(`Timeout waiting for event on ${runSpec.run_id}`));
          }
        }, 25);
      });

    for (let t = 1; t < runSpec.switch_turn; t++) {
      server.setTurn(t);
      const fromIdx = events.length;
      const msgText = t === runSpec.switch_turn - 1 ? 'Final pre-switch acknowledgement.' : `Pre-switch turn ${t}. Respond with OK.`;
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msgText } }) + '\n');
      await waitForEvent((e) => e.type === 'result', fromIdx);
    }

    const beforeSwitchIdx = events.length;
    const reqId = `req_probe_${runSpec.run_id}`;
    child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: reqId,
        request: { subtype: 'set_model', model: MODEL_B_CLI }
      }) + '\n'
    );
    await waitForEvent((e) => e.type === 'control_response' && e.response?.request_id === reqId, beforeSwitchIdx);
    child.stdin.end();
    await new Promise((r) => child.on('close', r));

    const capturedLines = fs.existsSync(capturedStdinPath)
      ? fs.readFileSync(capturedStdinPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
      : [];
    return {
      captured: capturedLines[0] || null,
      cacheDirExistsInFrozenRepo: fs.existsSync(path.join(runtimePaths.frozenRepoDir, '.claude', 'cache')),
      cacheFilesInFrozenRepo: fs.existsSync(path.join(runtimePaths.frozenRepoDir, '.claude', 'cache'))
        ? fs.readdirSync(path.join(runtimePaths.frozenRepoDir, '.claude', 'cache'))
        : []
    };
  } finally {
    await server.close();
    resetFrozenRepoClean(runtimePaths.frozenRepoDir);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

function resolvePriorBucketLabel(turnsCompleted) {
  const b = EMPIRICAL_SESSION_API_CALL_PRIOR.survivalBuckets.find((x) => turnsCompleted <= x.maxTurn);
  if (!b) return '>24';
  const prevIdx = EMPIRICAL_SESSION_API_CALL_PRIOR.survivalBuckets.indexOf(b) - 1;
  const lo = prevIdx >= 0 ? EMPIRICAL_SESSION_API_CALL_PRIOR.survivalBuckets[prevIdx].maxTurn + 1 : 0;
  return Number.isFinite(b.maxTurn) ? `${lo}..${b.maxTurn}` : `>=${lo}`;
}

function replayExactStdinPayload(runSpec, mockCapturedStdin) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ctxtop-v2-replay-${runSpec.run_id}-`));
  const homeDir = path.join(tmpRoot, 'home');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    activateLocalTrial({ homeDir });
    const ahDir = path.join(homeDir, '.attention-horizon');
    fs.mkdirSync(ahDir, { recursive: true });
    fs.writeFileSync(
      path.join(ahDir, 'config.json'),
      JSON.stringify({ flightMode: 'AUTO_PILOT', useEmpiricalHorizonPrior: true }, null, 2),
      'utf8'
    );

    const exactStdin = {
      session_id: `sess_${runSpec.run_id}`,
      cwd: '<FROZEN_REPO>',
      hook_event_name: 'PreModelSwitch',
      from_model: MODEL_A_CLI,
      to_model: MODEL_B_CLI,
      prompt_cache_warm: true,
      context_tokens: runSpec.contextTokensAtSwitch
    };

    const res = runPreModelSwitchHook(exactStdin, {
      cwd: tmpRoot,
      homeDir,
      recordLedger: false
    });
    const v = res.verdict || {};
    const b = v.breakEven || {};
    const turnsUsed = 0; // PreModelSwitch stdin omits current_turn; liveState in Phase 2 has turnsCompleted=0
    const bucketLabel = `${resolvePriorBucketLabel(turnsUsed)} (median=+${b.expectedRemainingTurns ?? ''} calls)`;
    const singleTurnShouldHold = Boolean(
      b.currentModel !== b.targetModel &&
        !b.isCapabilityUpshift &&
        b.cacheWarm &&
        Number(b.coldWritePenaltyUSD || 0) > 0 &&
        Number(b.cachedTokens || 0) > Number(b.breakEvenTokens || 0)
    );
    const fellThroughDefaultAllow = !(
      b.ruleVersion === 'rule_v2' &&
      b.horizonPriorSource === 'empirical_496_session_prior' &&
      singleTurnShouldHold === true &&
      Number(b.expectedRemainingTurns) >= Number(b.paybackTurns)
    );

    return {
      run_id: runSpec.run_id,
      arm: runSpec.arm,
      rep: runSpec.rep,
      switch_turn: runSpec.switch_turn,
      mock_probe_stdin_keys: mockCapturedStdin?.parsed ? Object.keys(mockCapturedStdin.parsed) : [],
      mock_probe_context_tokens: mockCapturedStdin?.parsed?.context_tokens ?? null,
      stdin_context_tokens: exactStdin.context_tokens,
      stdin_prompt_cache_warm: exactStdin.prompt_cache_warm,
      stdin_has_current_turn: Object.prototype.hasOwnProperty.call(exactStdin, 'current_turn'),
      evaluated_rule_version: b.ruleVersion || 'unknown',
      fell_through_default_allow: fellThroughDefaultAllow,
      single_turn_should_hold_under_v1: singleTurnShouldHold,
      turns_completed_used: turnsUsed,
      prior_source: b.horizonPriorSource || '',
      prior_bucket: bucketLabel,
      expected_output_tokens: b.expectedOutputTokens ?? null,
      break_even_c_star: b.breakEvenTokens ?? null,
      cold_write_penalty_usd: b.coldWritePenaltyUSD ?? null,
      per_turn_saving_usd: b.perTurnPostSwitchSavingUSD ?? null,
      payback_turns: b.paybackTurns ?? null,
      expected_remaining_turns: b.expectedRemainingTurns ?? null,
      horizon_net_savings_usd: b.horizonNetSavingsUSD ?? null,
      decision: v.decision || 'unknown',
      hook_exit_code: res.exitCode,
      hook_stdout_bytes: Buffer.byteLength(res.stdout || '', 'utf8'),
      internal_verdict_reason: v.reason || ''
    };
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const runSpecs = loadRunPreSwitchSequences();
  const runtimePaths = findRuntimePaths();

  const mockCaptures = {};
  if (runtimePaths) {
    for (const sampleId of ['C2_L1_hb_rule_v2_r01', 'C2_L2_hb_rule_v2_r01']) {
      const spec = runSpecs.find((s) => s.run_id === sampleId);
      const capRes = await runLiveClaudeMockStdinCapture(spec, runtimePaths);
      mockCaptures[spec.arm] = capRes;
    }
  }

  const replayRows = runSpecs.map((spec) =>
    replayExactStdinPayload(spec, mockCaptures[spec.arm]?.captured || null)
  );

  const csvCols = [
    'run_id',
    'arm',
    'rep',
    'switch_turn',
    'stdin_context_tokens',
    'stdin_prompt_cache_warm',
    'stdin_has_current_turn',
    'evaluated_rule_version',
    'fell_through_default_allow',
    'turns_completed_used',
    'prior_source',
    'prior_bucket',
    'expected_output_tokens',
    'cold_write_penalty_usd',
    'per_turn_saving_usd',
    'payback_turns',
    'expected_remaining_turns',
    'decision',
    'hook_exit_code',
    'hook_stdout_bytes',
    'internal_verdict_reason'
  ];

  const csvText = [
    csvCols.join(','),
    ...replayRows.map((r) => csvCols.map((c) => escapeCsv(r[c])).join(','))
  ].join('\n') + '\n';

  const jsonPayload = {
    generatedAtUtc: new Date().toISOString(),
    costUsd: 0,
    claudeCodeMockProbe: Object.fromEntries(
      Object.entries(mockCaptures).map(([arm, data]) => [
        arm,
        {
          capturedKeys: data.captured?.parsed ? Object.keys(data.captured.parsed) : [],
          parsedStdin: data.captured?.parsed
            ? {
                ...data.captured.parsed,
                session_id: `sess_mock_${arm}`,
                cwd: '<FROZEN_REPO>',
                transcript_path: data.captured.parsed.transcript_path ? '<MOCK_TRANSCRIPT_PATH>' : undefined
              }
            : null,
          exitCode: data.captured?.exitCode ?? null,
          stdout: data.captured?.stdout ?? '',
          stderr: data.captured?.stderr ?? '',
          cacheDirExistsInFrozenRepo: data.cacheDirExistsInFrozenRepo
        }
      ])
    ),
    replayRows
  };

  const outCsvPath = path.join(RESULTS_V2_DIR, 'interceptions_replay_probe.csv');
  const outJsonPath = path.join(RESULTS_V2_DIR, 'interceptions_replay_probe.json');
  fs.writeFileSync(outCsvPath, sanitizeText(csvText), 'utf8');
  fs.writeFileSync(outJsonPath, sanitizeText(JSON.stringify(jsonPayload, null, 2)), 'utf8');

  console.log('=== MOCK PROBE STDIN KEYS (L1 & L2) ===');
  console.log(sanitizeText(JSON.stringify(jsonPayload.claudeCodeMockProbe, null, 2)));
  console.log('=== PHASE 2 EXACT DECISION REPLAY ===');
  console.table(
    replayRows.map((r) => ({
      run_id: r.run_id,
      turn: r.switch_turn,
      ctx_tok: r.stdin_context_tokens,
      rule: r.evaluated_rule_version,
      fell_through: r.fell_through_default_allow,
      turns_used: r.turns_completed_used,
      prior_bucket: r.prior_bucket,
      exp_out: r.expected_output_tokens,
      penalty: r.cold_write_penalty_usd,
      saving: r.per_turn_saving_usd,
      payback: r.payback_turns,
      exp_rem: r.expected_remaining_turns,
      decision: r.decision
    }))
  );
  console.log('Wrote:', outCsvPath);
  console.log('Wrote:', outJsonPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
