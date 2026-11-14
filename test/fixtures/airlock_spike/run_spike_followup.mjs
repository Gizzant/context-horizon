import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const SPIKE_DIR = process.cwd();
const CLAUDE_EXE = path.join(SPIKE_DIR, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const HOOK_SCRIPT = path.join(SPIKE_DIR, 'vault_hook.mjs').replace(/\\/g, '/');
const RUNS_DIR = path.join(SPIKE_DIR, 'runs');

const CANARIES = [
  'ceo.secret@acme-corp.internal',
  'postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core',
  'LivePass99!',
  'db-prod.acme-corp.internal',
  ('sk_live_' + '99887766554433221100aabbcc'),
  'ProjectTitan'
];

function findCanaries(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj || '');
  return CANARIES.filter((c) => s.includes(c));
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

console.log('=== PART 1: INSPECTING EXISTING JSONL LEAK LOCATIONS ===');
for (const sc of ['S1a_read_edit_post_edit_unscrubbed', 'S2_bash_updated_tool_output_and_input', 'S3_grep_glob_updated_tool_output', 'S4_mcp_vault_and_unvault', 'S5b_user_prompt_block_exit2', 'S5c_user_prompt_suppress_original']) {
  const scDir = path.join(RUNS_DIR, sc);
  const files = walkFiles(scDir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('hook_events_log.jsonl'));
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    console.log(`\n[${sc}] ${path.basename(f)} (${lines.length} lines):`);
    lines.forEach((line, idx) => {
      const hits = findCanaries(line);
      if (hits.length > 0) {
        let obj = {};
        try { obj = JSON.parse(line); } catch {}
        const msgType = obj.type || 'unknown';
        const role = obj.message?.role || '';
        const contentTypes = Array.isArray(obj.message?.content) ? obj.message.content.map((c) => c.type).join(',') : typeof obj.message?.content;
        console.log(`  line ${idx + 1}: type=${msgType} role=${role} contentTypes=${contentTypes} hasToolUseResult=${'toolUseResult' in obj} hits=${JSON.stringify(hits)}`);
        console.log(`    snippet: ${line.slice(0, 260)}`);
      }
    });
  }
}

console.log('\n=== PART 2: RUNNING SURGICAL FOLLOW-UP SCENARIOS ===');

function createMockServer() {
  let active = null;
  function writeSseToolUse(res, id, name, inputObj) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const s = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    s('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    s('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
    s('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) } });
    s('content_block_stop', { type: 'content_block_stop', index: 0 });
    s('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    s('message_stop', { type: 'message_stop' });
    res.end();
  }
  function writeSseText(res, text) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const s = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    s('message_start', { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    s('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    s('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    s('content_block_stop', { type: 'content_block_stop', index: 0 });
    s('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    s('message_stop', { type: 'message_stop' });
    res.end();
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch {}
      if (req.url?.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"input_tokens":100}');
        return;
      }
      if (req.url?.startsWith('/v1/messages')) {
        const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
        if (!hasTools || !active) {
          if (parsed?.stream) writeSseText(res, 'aux');
          else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"aux"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":1}}'); }
          return;
        }
        const idx = active.mainRequests.length;
        active.mainRequests.push({ idx, body: parsed });
        const step = active.steps[idx];
        if (!step) {
          writeSseText(res, 'Done.');
          return;
        }
        writeSseToolUse(res, `toolu_f_${idx}`, step.name, step.input);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return { server, setActive: (a) => { active = a; } };
}

async function runOne(port, setActive, cfg) {
  const scDir = path.join(RUNS_DIR, cfg.id);
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
  fs.writeFileSync(
    path.join(wsDir, 'config', 'ProjectTitan_secrets.txt'),
    'OWNER=ceo.secret@acme-corp.internal\nDB=postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(wsDir, 'print_db.mjs'),
    `import fs from 'node:fs'; console.log(fs.readFileSync('config/prod.json','utf8'));\n`,
    'utf8'
  );

  const hookCmd = `node "${HOOK_SCRIPT}"`;
  const postMatcher = cfg.includeEditInPost ? 'Read|Bash|Grep|Glob|Edit|Write|mcp__.*' : 'Read|Bash|Grep|Glob|mcp__.*';
  const settingsPath = path.join(wsDir, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Read|Bash|Grep|Glob|Edit|Write|mcp__.*', hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] }],
      PostToolUse: [{ matcher: postMatcher, hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] }]
    }
  }, null, 2));

  const hookLogPath = path.join(scDir, 'hook_events_log.jsonl');
  const state = { steps: cfg.steps({ wsDir, prodJsonPath }), mainRequests: [] };
  setActive(state);

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_EXE, [
      '-p', cfg.prompt,
      '--dangerously-skip-permissions',
      '--model', 'claude-sonnet-4-6',
      '--output-format', 'json',
      '--settings', settingsPath
    ], {
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
        SPIKE_HOOK_MODE: cfg.hookMode || 'NORMAL',
        SPIKE_HOOK_LOG: hookLogPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('close', () => {
      const lastReq = state.mainRequests[state.mainRequests.length - 1]?.body?.messages || [];
      const wireCanaries = findCanaries(lastReq);
      const wireToolResults = [];
      for (const m of lastReq) {
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'tool_result') wireToolResults.push({ is_error: b.is_error, canaries: findCanaries(b.content), preview: JSON.stringify(b.content).slice(0, 220) });
          }
        }
      }
      const jsonls = walkFiles(cfgDir).filter((f) => f.endsWith('.jsonl'));
      const jsonlLinesWithCanaries = [];
      for (const f of jsonls) {
        fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).forEach((line, i) => {
          const hits = findCanaries(line);
          if (hits.length) {
            let obj = {};
            try { obj = JSON.parse(line); } catch {}
            jsonlLinesWithCanaries.push({ line: i + 1, type: obj.type, hasToolUseResult: 'toolUseResult' in obj, hits, snippet: line.slice(0, 200) });
          }
        });
      }
      const hooks = fs.existsSync(hookLogPath) ? fs.readFileSync(hookLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
      const finalProd = fs.readFileSync(prodJsonPath, 'utf8');
      resolve({
        id: cfg.id,
        wireCanaries,
        wireToolResults,
        jsonlLinesWithCanaries,
        hooks: hooks.map((h) => `${h.hookEvent}:${h.toolName}:${h.action}`),
        prodChanged: finalProd !== initialProdJson,
        finalProdHasCanary: findCanaries(finalProd),
        finalProdSnippet: finalProd.replace(/\n/g, ' ')
      });
    });
  });
}

const { server, setActive } = createMockServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const followups = [
  {
    id: 'F1_write_unvault_roundtrip_unscrubbed',
    hookMode: 'NORMAL',
    includeEditInPost: false,
    prompt: 'Read and Write config/prod.json.',
    steps: ({ prodJsonPath }) => [
      { name: 'Read', input: { file_path: prodJsonPath } },
      {
        name: 'Write',
        input: {
          file_path: prodJsonPath,
          content: '{\n  "adminEmail": "persona_4f2a8c10@synthetic.test",\n  "dbUri": "postgres://synth:SynthPass00@host-4f2a8c10.synthetic.internal:5432/core",\n  "codename": "CODENAME_4f2a8c10",\n  "pool": 20\n}\n'
        }
      }
    ]
  },
  {
    id: 'F2_edit_nonsecret_old_string_twin_new_string_unscrubbed',
    hookMode: 'POST_EDIT_UNSCRUBBED',
    includeEditInPost: false,
    prompt: 'Read and Edit pool line adding backupEmail.',
    steps: ({ prodJsonPath }) => [
      { name: 'Read', input: { file_path: prodJsonPath } },
      {
        name: 'Edit',
        input: {
          file_path: prodJsonPath,
          old_string: '  "pool": 5',
          new_string: '  "backupEmail": "persona_4f2a8c10@synthetic.test",\n  "pool": 20'
        }
      }
    ]
  },
  {
    id: 'F2b_edit_nonsecret_old_string_twin_new_string_scrubbed',
    hookMode: 'NORMAL',
    includeEditInPost: true,
    prompt: 'Read and Edit pool line adding backupEmail with PostToolUse(Edit).',
    steps: ({ prodJsonPath }) => [
      { name: 'Read', input: { file_path: prodJsonPath } },
      {
        name: 'Edit',
        input: {
          file_path: prodJsonPath,
          old_string: '  "pool": 5',
          new_string: '  "backupEmail": "persona_4f2a8c10@synthetic.test",\n  "pool": 20'
        }
      }
    ]
  },
  {
    id: 'F3_bash_grep_glob_clean_inputs',
    hookMode: 'NORMAL',
    includeEditInPost: true,
    prompt: 'Run clean-input Bash, Grep, Glob.',
    steps: ({ wsDir }) => [
      { name: 'Bash', input: { command: 'node print_db.mjs' } },
      { name: 'Grep', input: { pattern: 'dbUri', path: path.join(wsDir, 'config'), output_mode: 'content' } },
      { name: 'Glob', input: { pattern: '*.txt', path: path.join(wsDir, 'config') } }
    ]
  },
  {
    id: 'F4_fm1_mutated_twin_in_edit_new_string',
    hookMode: 'NORMAL',
    includeEditInPost: true,
    prompt: 'Edit with mutated twin.',
    steps: ({ prodJsonPath }) => [
      { name: 'Read', input: { file_path: prodJsonPath } },
      {
        name: 'Edit',
        input: {
          file_path: prodJsonPath,
          old_string: '  "pool": 5',
          new_string: '  "backupEmail": "persona_4f2b8c10@synthetic.test",\n  "pool": 20'
        }
      }
    ]
  }
];

for (const cfg of followups) {
  const res = await runOne(port, setActive, cfg);
  console.log('\n' + JSON.stringify(res, null, 2));
}
server.close();
