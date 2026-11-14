import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SPIKE_DIR = process.cwd();
const CLAUDE_EXE = path.join(SPIKE_DIR, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const HOOK_SCRIPT = path.join(SPIKE_DIR, 'vault_hook.mjs').replace(/\\/g, '/');
const RUNS_DIR = path.join(SPIKE_DIR, 'runs_round3');

const CANARIES = [
  'ceo.secret@acme-corp.internal',
  'postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core',
  'LivePass99!',
  'db-prod.acme-corp.internal',
  ('sk_live_' + '99887766554433221100aabbcc'),
  'ProjectTitan'
];

const TWINS = [
  'persona_4f2a8c10@synthetic.test',
  'host-4f2a8c10.synthetic.internal',
  'SynthPass00',
  'SYNTH_STRIPE_4f2a8c10_9e',
  'CODENAME_4f2a8c10'
];

function findCanaries(val) {
  const s = typeof val === 'string' ? val : JSON.stringify(val || '');
  return CANARIES.filter((c) => s.includes(c));
}

function findTwins(val) {
  const s = typeof val === 'string' ? val : JSON.stringify(val || '');
  return TWINS.filter((t) => s.includes(t));
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function maxVal(arr) {
  if (!arr.length) return 0;
  return Number(Math.max(...arr).toFixed(2));
}

function createLoopbackServer() {
  let active = null;

  function writeSseToolUse(res, id, name, inputObj) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: `msg_r3_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1 }
      }
    });
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} }
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) }
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 20 }
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  function writeSseText(res, text) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: `msg_r3_done_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1 }
      }
    });
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 8 }
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        parsed = { rawBody };
      }

      if (req.url?.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }

      if (req.url?.startsWith('/v1/messages')) {
        const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
        if (!hasTools || !active) {
          if (active) active.auxRequests.push({ url: req.url, rawBody, parsed });
          if (parsed?.stream) writeSseText(res, 'aux');
          else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'msg_aux',
              type: 'message',
              role: 'assistant',
              model: parsed?.model || 'claude-haiku-4-5',
              content: [{ type: 'text', text: 'aux' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 2 }
            }));
          }
          return;
        }

        const turnIdx = active.mainRequests.length;
        active.mainRequests.push({
          turnIdx,
          ts: Date.now(),
          tsHrNs: Number(process.hrtime.bigint()),
          rawBody,
          body: parsed
        });

        const step = active.steps[turnIdx];
        if (!step) {
          if (parsed?.stream) writeSseText(res, 'Done.');
          else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: `msg_done_${turnIdx}`,
              type: 'message',
              role: 'assistant',
              model: parsed?.model || 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'Done.' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 5 }
            }));
          }
          return;
        }

        writeSseToolUse(res, `toolu_r3_${turnIdx}_${Date.now()}`, step.name, step.input);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return { server, setActive: (s) => { active = s; } };
}

function setupScenarioDirs(id) {
  const scDir = path.join(RUNS_DIR, id);
  fs.rmSync(scDir, { recursive: true, force: true });
  const wsDir = path.join(scDir, 'workspace');
  const homeDir = path.join(scDir, 'isolated_home');
  const cfgDir = path.join(scDir, 'isolated_claude_config');
  fs.mkdirSync(path.join(wsDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'config'), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  const prodJsonPath = path.join(wsDir, 'config', 'prod.json');
  const initialProdJson =
    '{\n' +
    '  "adminEmail": "ceo.secret@acme-corp.internal",\n' +
    '  "dbUri": "postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core",\n' +
    '  "apiKey": "sk_test_99887766554433221100aabbcc",\n' +
    '  "codename": "ProjectTitan",\n' +
    '  "pool": 5\n' +
    '}\n';
  fs.writeFileSync(prodJsonPath, initialProdJson, 'utf8');

  return { scDir, wsDir, homeDir, cfgDir, prodJsonPath, initialProdJson };
}

function buildHookSettings(hooksEnabled, postIncludesEdit = true) {
  if (!hooksEnabled) {
    return { hooks: {} };
  }
  const hookCmd = `node "${HOOK_SCRIPT}"`;
  const postMatcher = postIncludesEdit ? 'Read|Bash|Grep|Glob|Edit|Write|mcp__.*' : 'Read|Bash|Grep|Glob|mcp__.*';
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Read|Bash|Grep|Glob|Edit|Write|mcp__.*', hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] }
      ],
      PostToolUse: [
        { matcher: postMatcher, hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] }
      ]
    }
  };
}

function invokeClaude({ wsDir, homeDir, cfgDir, settingsPath, hookMode, hookLogPath, port, extraArgs, prompt, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const args = [
      ...extraArgs,
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--model', 'claude-sonnet-4-6',
      '--output-format', 'json',
      '--settings', settingsPath
    ];
    const t0 = Date.now();
    const child = spawn(CLAUDE_EXE, args, {
      cwd: wsDir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'sk-ant-api03-spike-loopback-mock-000000000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CONFIG_DIR: cfgDir,
        USERPROFILE: homeDir,
        HOME: homeDir,
        SPIKE_HOOK_MODE: hookMode,
        SPIKE_HOOK_LOG: hookLogPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, elapsedMs: Date.now() - t0, stdout, stderr });
    });
  });
}

function inspectJsonlFiles(cfgDir, homeDir, baseDir) {
  const files = [...walkFiles(cfgDir), ...walkFiles(homeDir)].filter((f) => f.endsWith('.jsonl'));
  const details = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const hitLines = [];
    lines.forEach((line, idx) => {
      const hits = findCanaries(line);
      if (hits.length > 0) {
        let obj = {};
        try { obj = JSON.parse(line); } catch {}
        hitLines.push({
          line: idx + 1,
          type: obj.type || 'unknown',
          attachmentType: obj.attachment?.type || null,
          hookName: obj.attachment?.hookName || null,
          hasToolUseResult: 'toolUseResult' in obj,
          hits
        });
      }
    });
    details.push({
      file: path.relative(baseDir, f).replace(/\\/g, '/'),
      lineCount: lines.length,
      hitLines
    });
  }
  return details;
}

async function main() {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  const { server, setActive } = createLoopbackServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  console.log(`Round 3 loopback server on 127.0.0.1:${port}`);

  // 1. R3_1a & R3_1b: Scrub-on-Read + Stateless FM-1 on Editable Config
  const r3_1_results = [];
  for (const sub of [
    {
      id: 'R3_1a_scrub_read_clean_anchor_edit',
      steps: (p) => [
        { name: 'Read', input: { file_path: p } },
        { name: 'Edit', input: { file_path: p, old_string: '  "pool": 5', new_string: '  "pool": 20' } }
      ]
    },
    {
      id: 'R3_1b_scrub_read_placeholder_new_string_blocked',
      steps: (p) => [
        { name: 'Read', input: { file_path: p } },
        {
          name: 'Edit',
          input: {
            file_path: p,
            old_string: '  "pool": 5',
            new_string: '  "backupEmail": "persona_4f2a8c10@synthetic.test",\n  "pool": 20'
          }
        }
      ]
    }
  ]) {
    console.log(`\n>>> Running ${sub.id}`);
    const dirs = setupScenarioDirs(sub.id);
    const settingsPath = path.join(dirs.wsDir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(buildHookSettings(true, true), null, 2));
    const hookLogPath = path.join(dirs.scDir, 'hook_events_log.jsonl');
    const state = { steps: sub.steps(dirs.prodJsonPath), mainRequests: [], auxRequests: [] };
    setActive(state);
    const res = await invokeClaude({
      ...dirs,
      settingsPath,
      hookMode: 'STATELESS_V1',
      hookLogPath,
      port,
      extraArgs: [],
      prompt: 'Inspect config/prod.json and apply edit.'
    });
    const wireCanaries = findCanaries(state.mainRequests.map((r) => r.rawBody));
    const wireTwins = findTwins(state.mainRequests.map((r) => r.rawBody));
    const lastMsgs = state.mainRequests[state.mainRequests.length - 1]?.body?.messages || [];
    const lastToolResults = [];
    for (const m of lastMsgs) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') {
            lastToolResults.push({ is_error: Boolean(b.is_error), preview: JSON.stringify(b.content).slice(0, 200) });
          }
        }
      }
    }
    const jsonl = inspectJsonlFiles(dirs.cfgDir, dirs.homeDir, dirs.scDir);
    const finalProd = fs.readFileSync(dirs.prodJsonPath, 'utf8');
    const hookLogs = fs.existsSync(hookLogPath)
      ? fs.readFileSync(hookLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const summary = {
      id: sub.id,
      exitCode: res.code,
      mainRequestCount: state.mainRequests.length,
      wireCanaries,
      wireTwins,
      lastToolResults,
      jsonlTotalHitLines: jsonl.reduce((a, f) => a + f.hitLines.length, 0),
      prodChanged: finalProd !== dirs.initialProdJson,
      finalProdPoolLine: finalProd.split('\n').find((l) => l.includes('pool'))?.trim() || '',
      finalProdCanaryCount: findCanaries(finalProd).length,
      hooks: hookLogs.map((h) => `${h.hookEvent}:${h.toolName}:${h.action}`)
    };
    console.log('   ', JSON.stringify(summary));
    r3_1_results.push(summary);
  }

  // 2. R3_2: Does --continue / --resume replay .jsonl attachment.hook_success on wire?
  console.log('\n>>> Running R3_2_resume_hook_success_wire_check');
  const r32Dirs = setupScenarioDirs('R3_2_resume_hook_success_wire_check');
  const r32Settings = path.join(r32Dirs.wsDir, '.claude', 'settings.json');
  fs.writeFileSync(r32Settings, JSON.stringify(buildHookSettings(true, true), null, 2));
  const r32HookLog = path.join(r32Dirs.scDir, 'hook_events_log.jsonl');

  const part1State = {
    steps: [
      { name: 'Read', input: { file_path: r32Dirs.prodJsonPath } },
      {
        name: 'Edit',
        input: {
          file_path: r32Dirs.prodJsonPath,
          old_string: '  "pool": 5',
          new_string: '  "backupEmail": "persona_4f2a8c10@synthetic.test",\n  "pool": 20'
        }
      }
    ],
    mainRequests: [],
    auxRequests: []
  };
  setActive(part1State);
  const p1Res = await invokeClaude({
    ...r32Dirs,
    settingsPath: r32Settings,
    hookMode: 'NORMAL',
    hookLogPath: r32HookLog,
    port,
    extraArgs: [],
    prompt: 'Read and Edit pool adding backupEmail.'
  });
  let part1SessionId = null;
  try {
    const outObj = JSON.parse(p1Res.stdout);
    part1SessionId = outObj.session_id || null;
  } catch {}
  const part1Jsonl = inspectJsonlFiles(r32Dirs.cfgDir, r32Dirs.homeDir, r32Dirs.scDir);
  if (!part1SessionId && part1Jsonl.length > 0) {
    part1SessionId = path.basename(part1Jsonl[0].file, '.jsonl');
  }

  const part2ContinueState = { steps: [], mainRequests: [], auxRequests: [] };
  setActive(part2ContinueState);
  const p2ContinueRes = await invokeClaude({
    ...r32Dirs,
    settingsPath: r32Settings,
    hookMode: 'NORMAL',
    hookLogPath: r32HookLog,
    port,
    extraArgs: ['--continue'],
    prompt: 'Summarize the backupEmail edit we just performed.'
  });

  const part2ResumeState = { steps: [], mainRequests: [], auxRequests: [] };
  setActive(part2ResumeState);
  const p2ResumeRes = part1SessionId
    ? await invokeClaude({
        ...r32Dirs,
        settingsPath: r32Settings,
        hookMode: 'NORMAL',
        hookLogPath: r32HookLog,
        port,
        extraArgs: ['--resume', part1SessionId],
        prompt: 'What email address was written in that edit?'
      })
    : null;

  const r32Summary = {
    id: 'R3_2_resume_hook_success_wire_check',
    part1SessionId,
    part1WireCanaries: findCanaries(part1State.mainRequests.map((r) => r.rawBody)),
    part1JsonlHits: part1Jsonl,
    part2ContinueMainReqs: part2ContinueState.mainRequests.length,
    part2ContinueWireCanaries: findCanaries(part2ContinueState.mainRequests.map((r) => r.rawBody)),
    part2ContinueWireTwins: findTwins(part2ContinueState.mainRequests.map((r) => r.rawBody)),
    part2ContinueMessageCount: part2ContinueState.mainRequests[0]?.body?.messages?.length || 0,
    part2ContinueExitCode: p2ContinueRes.code,
    part2ResumeMainReqs: part2ResumeState.mainRequests.length,
    part2ResumeWireCanaries: findCanaries(part2ResumeState.mainRequests.map((r) => r.rawBody)),
    part2ResumeWireTwins: findTwins(part2ResumeState.mainRequests.map((r) => r.rawBody)),
    part2ResumeMessageCount: part2ResumeState.mainRequests[0]?.body?.messages?.length || 0,
    part2ResumeExitCode: p2ResumeRes?.code ?? null
  };
  console.log('   ', JSON.stringify(r32Summary));

  // 3. R3_3: N = 250 Cold Node Spawn + N = 30 Hooks-OFF vs Hooks-ON A/B Baseline
  console.log('\n>>> Running R3_3: N=250 cold hook spawns + N=30 Claude Code Hooks-OFF vs Hooks-ON A/B');
  const samplePayload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_response: {
      type: 'text',
      file: {
        filePath: 'config/prod.json',
        content: '{"adminEmail":"ceo.secret@acme-corp.internal","dbUri":"postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core"}\n'.repeat(50),
        numLines: 50,
        startLine: 1,
        totalLines: 50
      }
    }
  });
  const warmupLog = path.join(RUNS_DIR, 'r3_warmup.jsonl');
  for (let i = 0; i < 5; i++) {
    spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: samplePayload,
      env: { ...process.env, SPIKE_HOOK_MODE: 'STATELESS_V1', SPIKE_HOOK_LOG: warmupLog },
      encoding: 'utf8'
    });
  }

  const coldLog250 = path.join(RUNS_DIR, 'r3_cold_250.jsonl');
  const coldWallMs = [];
  for (let i = 0; i < 250; i++) {
    const ts0 = process.hrtime.bigint();
    spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: samplePayload,
      env: { ...process.env, SPIKE_HOOK_MODE: 'STATELESS_V1', SPIKE_HOOK_LOG: coldLog250 },
      encoding: 'utf8'
    });
    coldWallMs.push(Number(process.hrtime.bigint() - ts0) / 1e6);
  }
  const coldAlgMs = fs.readFileSync(coldLog250, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).algMs);

  // Warm up claude.exe process once
  const warmDirs = setupScenarioDirs('R3_3_warmup');
  const warmSettings = path.join(warmDirs.wsDir, '.claude', 'settings.json');
  fs.writeFileSync(warmSettings, JSON.stringify(buildHookSettings(false), null, 2));
  const warmState = { steps: [{ name: 'Read', input: { file_path: warmDirs.prodJsonPath } }], mainRequests: [], auxRequests: [] };
  setActive(warmState);
  await invokeClaude({ ...warmDirs, settingsPath: warmSettings, hookMode: 'STATELESS_V1', hookLogPath: '', port, extraArgs: [], prompt: 'Warmup.' });

  async function run30Reads(id, hooksOn) {
    const dirs = setupScenarioDirs(id);
    const settingsPath = path.join(dirs.wsDir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(buildHookSettings(hooksOn, false), null, 2));
    const hookLogPath = hooksOn ? path.join(dirs.scDir, 'hook_events_log.jsonl') : '';
    const state = {
      steps: Array.from({ length: 30 }, () => ({ name: 'Read', input: { file_path: dirs.prodJsonPath } })),
      mainRequests: [],
      auxRequests: []
    };
    setActive(state);
    const res = await invokeClaude({
      ...dirs,
      settingsPath,
      hookMode: 'STATELESS_V1',
      hookLogPath,
      port,
      extraArgs: [],
      prompt: 'Execute 30 sequential Read calls.',
      timeoutMs: 120000
    });
    const deltasMs = [];
    for (let i = 1; i < state.mainRequests.length; i++) {
      deltasMs.push(Number(((state.mainRequests[i].tsHrNs - state.mainRequests[i - 1].tsHrNs) / 1e6).toFixed(2)));
    }
    const hookLogs = hooksOn && fs.existsSync(hookLogPath)
      ? fs.readFileSync(hookLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return {
      id,
      hooksOn,
      exitCode: res.code,
      totalElapsedMs: res.elapsedMs,
      mainRequestCount: state.mainRequests.length,
      turnDeltaCount: deltasMs.length,
      turnDeltaP50Ms: percentile(deltasMs, 50),
      turnDeltaMaxMs: maxVal(deltasMs),
      hookLogCount: hookLogs.length,
      wireCanaries: findCanaries(state.mainRequests.map((r) => r.rawBody)),
      rawDeltasMs: deltasMs
    };
  }

  const abOff = await run30Reads('R3_3_ab_hooks_off_30_reads', false);
  const abOn = await run30Reads('R3_3_ab_hooks_on_30_reads', true);

  const latencySummary = {
    nCold: coldWallMs.length,
    coldNodeWallMs: {
      p50: percentile(coldWallMs, 50),
      p95: percentile(coldWallMs, 95),
      p99: percentile(coldWallMs, 99),
      max: maxVal(coldWallMs)
    },
    coldAlgMs: {
      p50: percentile(coldAlgMs, 50),
      p95: percentile(coldAlgMs, 95),
      p99: percentile(coldAlgMs, 99),
      max: maxVal(coldAlgMs)
    },
    ab30Reads: {
      hooksOff: {
        turnDeltaCount: abOff.turnDeltaCount,
        p50Ms: abOff.turnDeltaP50Ms,
        maxMs: abOff.turnDeltaMaxMs,
        totalElapsedMs: abOff.totalElapsedMs,
        wireCanaryCount: abOff.wireCanaries.length
      },
      hooksOn: {
        turnDeltaCount: abOn.turnDeltaCount,
        p50Ms: abOn.turnDeltaP50Ms,
        maxMs: abOn.turnDeltaMaxMs,
        totalElapsedMs: abOn.totalElapsedMs,
        hookLogCount: abOn.hookLogCount,
        wireCanaryCount: abOn.wireCanaries.length
      },
      netAddedP50MsPerTurn: Number((abOn.turnDeltaP50Ms - abOff.turnDeltaP50Ms).toFixed(2)),
      netAddedSessionElapsedMs: abOn.totalElapsedMs - abOff.totalElapsedMs
    }
  };
  console.log('   Latency R3_3:', JSON.stringify(latencySummary, null, 2));

  server.close();

  const out = {
    claudeVersion: '2.1.325',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    r3_1: r3_1_results,
    r3_2: r32Summary,
    r3_3: latencySummary
  };

  const outPath = path.join(SPIKE_DIR, 'round3_results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n=== SAVED ${outPath} ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
