import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SPIKE_DIR = process.cwd();
const CLAUDE_EXE = path.join(SPIKE_DIR, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const HOOK_SCRIPT = path.join(SPIKE_DIR, 'vault_hook.mjs').replace(/\\/g, '/');
const MCP_SCRIPT = path.join(SPIKE_DIR, 'mock_mcp_server.mjs').replace(/\\/g, '/');
const RUNS_DIR = path.join(SPIKE_DIR, 'runs');

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

function findCanaries(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
  return CANARIES.filter((c) => s.includes(c));
}

function findTwins(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
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

function createLoopbackAnthropicServer() {
  let activeScenario = null;

  function writeSseToolUse(res, id, name, inputObj) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const sendEvt = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sendEvt('message_start', {
      type: 'message_start',
      message: {
        id: `msg_spike_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1 }
      }
    });
    sendEvt('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} }
    });
    sendEvt('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) }
    });
    sendEvt('content_block_stop', { type: 'content_block_stop', index: 0 });
    sendEvt('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 25 }
    });
    sendEvt('message_stop', { type: 'message_stop' });
    res.end();
  }

  function writeSseText(res, text) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const sendEvt = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sendEvt('message_start', {
      type: 'message_start',
      message: {
        id: `msg_spike_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1 }
      }
    });
    sendEvt('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    });
    sendEvt('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    });
    sendEvt('content_block_stop', { type: 'content_block_stop', index: 0 });
    sendEvt('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 10 }
    });
    sendEvt('message_stop', { type: 'message_stop' });
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
        res.end(JSON.stringify({ input_tokens: 120 }));
        return;
      }

      if (req.url?.startsWith('/v1/messages')) {
        const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
        if (!hasTools) {
          if (activeScenario) {
            activeScenario.auxiliaryRequests.push({ url: req.url, body: parsed });
          }
          if (parsed?.stream) {
            writeSseText(res, 'aux');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'msg_aux',
                type: 'message',
                role: 'assistant',
                model: parsed?.model || 'claude-haiku-4-5',
                content: [{ type: 'text', text: 'aux' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 2 }
              })
            );
          }
          return;
        }

        if (!activeScenario) {
          writeSseText(res, 'No active scenario');
          return;
        }

        const turnIdx = activeScenario.mainRequests.length;
        activeScenario.mainRequests.push({
          turnIdx,
          url: req.url,
          ts: Date.now(),
          body: parsed
        });

        const step = activeScenario.steps[turnIdx];
        if (!step) {
          if (parsed?.stream) {
            writeSseText(res, 'Spike complete.');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: `msg_done_${turnIdx}`,
                type: 'message',
                role: 'assistant',
                model: parsed?.model || 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'Spike complete.' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 150, output_tokens: 8 }
              })
            );
          }
          return;
        }

        const toolId = `toolu_spike_${turnIdx}_${Date.now()}`;
        if (parsed?.stream) {
          writeSseToolUse(res, toolId, step.name, step.input);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: `msg_tool_${turnIdx}`,
              type: 'message',
              role: 'assistant',
              model: parsed?.model || 'claude-sonnet-4-6',
              content: [{ type: 'tool_use', id: toolId, name: step.name, input: step.input }],
              stop_reason: 'tool_use',
              usage: { input_tokens: 150, output_tokens: 25 }
            })
          );
        }
        return;
      }

      // Catch-all for any optional telemetry/hello endpoints so nothing hangs
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return {
    server,
    setScenario(sc) {
      activeScenario = sc;
    }
  };
}

function runClaudeScenario(port, scenarioConfig) {
  const {
    id,
    title,
    hookMode = 'NORMAL',
    hookTimeoutSec = 5,
    includeEditInPost = true,
    useMcp = false,
    prompt = 'Execute the requested tool step.',
    steps = [],
    setupWorkspace
  } = scenarioConfig;

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
    '  "codename": "ProjectTitan",\n' +
    '  "pool": 5\n' +
    '}\n';
  fs.writeFileSync(prodJsonPath, initialProdJson, 'utf8');

  const secretTxtPath = path.join(wsDir, 'config', 'ProjectTitan_secrets.txt');
  fs.writeFileSync(
    secretTxtPath,
    'OWNER=ceo.secret@acme-corp.internal\nDB=postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core\nKEY=sk_test_99887766554433221100aabbcc\n',
    'utf8'
  );

  if (setupWorkspace) setupWorkspace({ wsDir, prodJsonPath, secretTxtPath });

  const hookCmd = `node "${HOOK_SCRIPT}"`;
  const postMatcher = includeEditInPost
    ? 'Read|Bash|Grep|Glob|Edit|Write|mcp__.*'
    : 'Read|Bash|Grep|Glob|Write|mcp__.*';

  const settingsObj = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: hookCmd, timeout: hookTimeoutSec }]
        }
      ],
      PreToolUse: [
        {
          matcher: 'Read|Bash|Grep|Glob|Edit|Write|mcp__.*',
          hooks: [{ type: 'command', command: hookCmd, timeout: hookTimeoutSec }]
        }
      ],
      PostToolUse: [
        {
          matcher: postMatcher,
          hooks: [{ type: 'command', command: hookCmd, timeout: hookTimeoutSec }]
        }
      ]
    }
  };
  const settingsPath = path.join(wsDir, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), 'utf8');

  const mcpPath = path.join(scDir, 'mcp_config.json');
  if (useMcp) {
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            spike: {
              command: 'node',
              args: [MCP_SCRIPT]
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );
  }

  const hookLogPath = path.join(scDir, 'hook_events_log.jsonl');

  const resolvedSteps = typeof steps === 'function' ? steps({ wsDir, prodJsonPath, secretTxtPath }) : steps;

  const state = {
    id,
    title,
    steps: resolvedSteps,
    mainRequests: [],
    auxiliaryRequests: []
  };

  return new Promise((resolve) => {
    const args = [
      '-p',
      prompt,
      '--dangerously-skip-permissions',
      '--model',
      'claude-sonnet-4-6',
      '--output-format',
      'json',
      '--settings',
      settingsPath
    ];
    if (useMcp) {
      args.push('--mcp-config', mcpPath, '--strict-mcp-config');
    }

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
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 45000);

    child.on('close', (code) => {
      clearTimeout(timer);

      // Inspect HTTP wire messages after initial user turn
      const wireTurns = state.mainRequests.map((req) => {
        const msgs = req.body?.messages || [];
        const toolResults = [];
        for (const m of msgs) {
          if (Array.isArray(m.content)) {
            for (const blk of m.content) {
              if (blk.type === 'tool_result') {
                toolResults.push({
                  tool_use_id: blk.tool_use_id,
                  is_error: Boolean(blk.is_error),
                  content: blk.content,
                  rawCanariesFound: findCanaries(blk.content),
                  twinsFound: findTwins(blk.content)
                });
              }
            }
          }
        }
        return {
          turnIdx: req.turnIdx,
          allMessagesCanaries: findCanaries(msgs),
          allMessagesTwins: findTwins(msgs),
          toolResults
        };
      });

      // Inspect all JSONL transcripts on disk under cfgDir and homeDir
      const diskFiles = [...walkFiles(cfgDir), ...walkFiles(homeDir)].filter((f) => f.endsWith('.jsonl'));
      const jsonlReport = diskFiles.map((f) => {
        const txt = fs.readFileSync(f, 'utf8');
        return {
          file: path.relative(scDir, f),
          bytes: txt.length,
          rawCanariesFound: findCanaries(txt),
          twinsFound: findTwins(txt)
        };
      });

      const hookLogs = fs.existsSync(hookLogPath)
        ? fs
            .readFileSync(hookLogPath, 'utf8')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];

      const finalProdJson = fs.readFileSync(prodJsonPath, 'utf8');

      resolve({
        id,
        title,
        exitCode: code,
        stdoutPreview: stdout.slice(0, 600),
        stderrPreview: stderr.slice(0, 600),
        mainRequestCount: state.mainRequests.length,
        wireTurns,
        jsonlReport,
        hookLogs,
        finalProdJson,
        prodJsonChanged: finalProdJson !== initialProdJson,
        wsDir,
        stateRef: state
      });
    });

    // expose state immediately via callback
    if (scenarioConfig.onStart) scenarioConfig.onStart(state);
  });
}

async function main() {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  const { server, setScenario } = createLoopbackAnthropicServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  console.log(`Loopback Anthropic mock server listening on 127.0.0.1:${port}`);

  const scenarios = [
    {
      id: 'S1a_read_edit_post_edit_unscrubbed',
      title: 'Scenario 1a: Read -> Vault -> Edit -> Unvault (Edit excluded from PostToolUse to test FM-9)',
      hookMode: 'POST_EDIT_UNSCRUBBED',
      includeEditInPost: false,
      prompt: 'Read config/prod.json and update pool from 5 to 20.',
      steps: ({ prodJsonPath }) => [
        { name: 'Read', input: { file_path: prodJsonPath } },
        {
          name: 'Edit',
          input: {
            file_path: prodJsonPath,
            old_string:
              '  "dbUri": "postgres://synth:SynthPass00@host-4f2a8c10.synthetic.internal:5432/core",\n  "codename": "CODENAME_4f2a8c10",\n  "pool": 5',
            new_string:
              '  "dbUri": "postgres://synth:SynthPass00@host-4f2a8c10.synthetic.internal:5432/core",\n  "codename": "CODENAME_4f2a8c10",\n  "pool": 20'
          }
        }
      ]
    },
    {
      id: 'S1b_read_edit_full_symmetric',
      title: 'Scenario 1b: Read -> Vault -> Edit -> Unvault (Edit INCLUDED in PostToolUse)',
      hookMode: 'NORMAL',
      includeEditInPost: true,
      prompt: 'Read config/prod.json and update pool from 5 to 20.',
      steps: ({ prodJsonPath }) => [
        { name: 'Read', input: { file_path: prodJsonPath } },
        {
          name: 'Edit',
          input: {
            file_path: prodJsonPath,
            old_string:
              '  "dbUri": "postgres://synth:SynthPass00@host-4f2a8c10.synthetic.internal:5432/core",\n  "codename": "CODENAME_4f2a8c10",\n  "pool": 5',
            new_string:
              '  "dbUri": "postgres://synth:SynthPass00@host-4f2a8c10.synthetic.internal:5432/core",\n  "codename": "CODENAME_4f2a8c10",\n  "pool": 20'
          }
        }
      ]
    },
    {
      id: 'S2_bash_updated_tool_output_and_input',
      title: 'Scenario 2: Built-in Bash PostToolUse updatedToolOutput + PreToolUse updatedInput',
      hookMode: 'NORMAL',
      prompt: 'Run the node diagnostic commands via Bash.',
      steps: () => [
        {
          name: 'Bash',
          input: {
            command: `node -e "console.log('URI=postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core')"`
          }
        },
        {
          name: 'Bash',
          input: {
            command: `node -e "console.log('ECHO_EMAIL=' + 'persona_4f2a8c10@synthetic.test')"`
          }
        }
      ]
    },
    {
      id: 'S3_grep_glob_updated_tool_output',
      title: 'Scenario 3: Built-in Grep & Glob PostToolUse updatedToolOutput',
      hookMode: 'NORMAL',
      prompt: 'Search config directory with Grep and Glob.',
      steps: ({ wsDir }) => [
        {
          name: 'Grep',
          input: {
            pattern: 'LivePass99!',
            path: path.join(wsDir, 'config'),
            output_mode: 'content'
          }
        },
        {
          name: 'Glob',
          input: {
            pattern: '*ProjectTitan*',
            path: path.join(wsDir, 'config')
          }
        }
      ]
    },
    {
      id: 'S4_mcp_vault_and_unvault',
      title: 'Scenario 4: MCP mcp__spike__get_secret_config PreToolUse updatedInput + PostToolUse',
      hookMode: 'NORMAL',
      useMcp: true,
      prompt: 'Call the spike MCP tool get_secret_config.',
      steps: () => [
        {
          name: 'mcp__spike__get_secret_config',
          input: { target: 'persona_4f2a8c10@synthetic.test' }
        }
      ]
    },
    {
      id: 'S5a_user_prompt_rewrite_attempt',
      title: 'Scenario 5a: UserPromptSubmit rewrite attempt (updatedPrompt / additionalContext)',
      hookMode: 'PROMPT_REWRITE_ATTEMPT',
      prompt: 'Please check key sk_test_99887766554433221100aabbcc for issues.',
      steps: () => []
    },
    {
      id: 'S5b_user_prompt_block_exit2',
      title: 'Scenario 5b: UserPromptSubmit exit 2 block',
      hookMode: 'PROMPT_BLOCK',
      prompt: 'Please check key sk_test_99887766554433221100aabbcc for issues.',
      steps: () => []
    },
    {
      id: 'S5c_user_prompt_suppress_original',
      title: 'Scenario 5c: UserPromptSubmit suppressOriginalPrompt: true + additionalContext',
      hookMode: 'PROMPT_SUPPRESS_TEST',
      prompt: 'Please check key sk_test_99887766554433221100aabbcc for issues.',
      steps: () => []
    },
    {
      id: 'S6a_fm1_mutated_twin_block',
      title: 'Scenario 6a: FM-1 Mutated synthetic twin (persona_4f2b8c10) fail-closed block',
      hookMode: 'NORMAL',
      prompt: 'Edit config/prod.json with mutated twin.',
      steps: ({ prodJsonPath }) => [
        {
          name: 'Edit',
          input: {
            file_path: prodJsonPath,
            old_string: '  "adminEmail": "persona_4f2b8c10@synthetic.test",',
            new_string: '  "adminEmail": "persona_4f2b8c10@synthetic.test",'
          }
        }
      ]
    },
    {
      id: 'S6b_fm10_unsafe_dest_git_commit',
      title: 'Scenario 6b: FM-10 Unsafe unvault destination (git commit -m) blocked',
      hookMode: 'NORMAL',
      prompt: 'Run git commit with synthetic twin.',
      steps: () => [
        {
          name: 'Bash',
          input: { command: 'git commit -m "fix persona_4f2a8c10@synthetic.test"' }
        }
      ]
    },
    {
      id: 'S6c_fm8_crash_exit1_fail_open',
      title: 'Scenario 6c: FM-8 Unhandled hook crash (exit 1) fail-open check',
      hookMode: 'CRASH_EXIT_1',
      prompt: 'Read config/prod.json while hook exits 1.',
      steps: ({ prodJsonPath }) => [{ name: 'Read', input: { file_path: prodJsonPath } }]
    },
    {
      id: 'S6d_fm8_timeout_fail_open',
      title: 'Scenario 6d: FM-8 Hook timeout (3.5s sleep vs 1s timeout) fail-open check',
      hookMode: 'TIMEOUT_HANG',
      hookTimeoutSec: 1,
      prompt: 'Read config/prod.json while hook times out.',
      steps: ({ prodJsonPath }) => [{ name: 'Read', input: { file_path: prodJsonPath } }]
    }
  ];

  const results = [];
  for (const sc of scenarios) {
    console.log(`\n>>> Running ${sc.id}: ${sc.title}`);
    const res = await runClaudeScenario(port, {
      ...sc,
      onStart: (st) => setScenario(st)
    });
    results.push({
      id: res.id,
      title: res.title,
      exitCode: res.exitCode,
      mainRequestCount: res.mainRequestCount,
      prodJsonChanged: res.prodJsonChanged,
      finalProdJson: res.finalProdJson,
      wireTurns: res.wireTurns,
      jsonlReport: res.jsonlReport,
      hookLogs: res.hookLogs,
      stdoutPreview: res.stdoutPreview,
      stderrPreview: res.stderrPreview
    });
    console.log(
      `    Done exitCode=${res.exitCode}, mainReqs=${res.mainRequestCount}, hookCalls=${res.hookLogs.length}, prodChanged=${res.prodJsonChanged}`
    );
  }

  // Scenario 7: Latency Benchmark (20 cold Node CLI spawns of vault_hook.mjs + 20 in-session Read hooks)
  console.log('\n>>> Running S7: Windows 11 Hook Latency Benchmark (20 cold CLI spawns + 20 in-session Read calls)');
  const samplePayload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_response: {
      type: 'text',
      file: {
        filePath: 'C:/tmp/prod.json',
        content:
          '{"adminEmail":"ceo.secret@acme-corp.internal","dbUri":"postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core"}\n'.repeat(
            50
          ),
        numLines: 50,
        startLine: 1,
        totalLines: 50
      }
    }
  });

  const coldSpawnWallMs = [];
  const coldSpawnAlgMs = [];
  const s7Log = path.join(RUNS_DIR, 's7_cold_hook_log.jsonl');
  for (let i = 0; i < 20; i++) {
    const tStart = process.hrtime.bigint();
    spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: samplePayload,
      env: { ...process.env, SPIKE_HOOK_MODE: 'NORMAL', SPIKE_HOOK_LOG: s7Log },
      encoding: 'utf8'
    });
    const wallMs = Number(process.hrtime.bigint() - tStart) / 1e6;
    coldSpawnWallMs.push(wallMs);
  }
  if (fs.existsSync(s7Log)) {
    for (const line of fs.readFileSync(s7Log, 'utf8').trim().split(/\r?\n/)) {
      if (line) coldSpawnAlgMs.push(JSON.parse(line).algMs);
    }
  }

  const s7SessionRes = await runClaudeScenario(port, {
    id: 'S7_20_sequential_reads',
    title: 'Scenario 7: 20 Sequential Read calls inside Claude Code session',
    hookMode: 'NORMAL',
    prompt: 'Execute 20 sequential Read calls.',
    steps: ({ prodJsonPath }) => Array.from({ length: 20 }, () => ({ name: 'Read', input: { file_path: prodJsonPath } })),
    onStart: (st) => setScenario(st)
  });

  const inSessionTurnDeltasMs = [];
  for (let i = 1; i < s7SessionRes.stateRef.mainRequests.length; i++) {
    inSessionTurnDeltasMs.push(
      s7SessionRes.stateRef.mainRequests[i].ts - s7SessionRes.stateRef.mainRequests[i - 1].ts
    );
  }
  const inSessionAlgMs = s7SessionRes.hookLogs.map((h) => h.algMs);

  const latencySummary = {
    coldSpawnCount: coldSpawnWallMs.length,
    coldNodeWallMs: {
      p50: percentile(coldSpawnWallMs, 50),
      p95: percentile(coldSpawnWallMs, 95),
      p99: percentile(coldSpawnWallMs, 99),
      samples: coldSpawnWallMs.map((v) => Number(v.toFixed(2)))
    },
    hookAlgMs: {
      p50: percentile(coldSpawnAlgMs, 50),
      p95: percentile(coldSpawnAlgMs, 95),
      p99: percentile(coldSpawnAlgMs, 99)
    },
    claudeSession20Reads: {
      totalHookLogs: s7SessionRes.hookLogs.length,
      inSessionAlgP50: percentile(inSessionAlgMs, 50),
      inSessionAlgP95: percentile(inSessionAlgMs, 95),
      turnToTurnDeltaP50Ms: percentile(inSessionTurnDeltasMs, 50),
      turnToTurnDeltaP95Ms: percentile(inSessionTurnDeltasMs, 95),
      turnToTurnDeltaP99Ms: percentile(inSessionTurnDeltasMs, 99)
    }
  };

  server.close();

  const outJson = {
    claudeVersion: '2.1.325',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    results,
    latencySummary
  };

  const outPath = path.join(SPIKE_DIR, 'spike_results.json');
  fs.writeFileSync(outPath, JSON.stringify(outJson, null, 2), 'utf8');
  console.log(`\n=== ALL SCENARIOS COMPLETE. Saved ${outPath} ===`);
  console.log('Latency summary:', JSON.stringify(latencySummary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
