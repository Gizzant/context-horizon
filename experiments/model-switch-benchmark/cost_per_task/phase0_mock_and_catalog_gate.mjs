#!/usr/bin/env node
/**
 * Phase 0 ($0.00 Live LLM Spend):
 * 1. Read-only GET /api/v1/models & GET /api/v1/key on OpenRouter to confirm
 *    day-of-run 5.5 model availability, pricing, and remaining balance/key cap.
 * 2. Local $0 mock SSE verification of claude.exe@2.1.325:
 *    - Turn 1 under `--permission-mode plan` blocks Edit/Bash while allowing Read
 *    - Between Turn 1 & Turn 2: `set_permission_mode` -> `bypassPermissions`
 *      and `set_model` -> `claude-sonnet-5-5` succeed cleanly
 *    - Turn 2 executes Edit & Bash, routes `claude-sonnet-5-5` + effort `medium`,
 *      and verifies whether `toolsSha256` & `systemSha256` remain identical
 *    - Run A vs Run B `--append-system-prompt` prefix comparison (cache nonce check)
 *    - Zero auto-memory (`systemHasMemoryMd === false`) and zero hooks (`"hooks": {}`)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  RESULTS_DIR,
  CLAUDE_EXE,
  PINNED_CLAUDE_CODE_VERSION,
  PRICING_PER_1M,
  loadOpenRouterApiKey
} from '../config.mjs';
import { startProxyServer } from '../proxy_recorder.mjs';
import {
  assertNoSensitiveLeaks,
  redactSensitiveText
} from '../tests_3_to_8/prefix_lab.mjs';

const RAW_OUT_DIR = path.join(RESULTS_DIR, 'cost_per_task_raw');
const OUT_PATH = path.join(RAW_OUT_DIR, 'phase0_mock_verification.json');

function sha256Hex(val) {
  const s = typeof val === 'string' ? val : JSON.stringify(val ?? '');
  return crypto.createHash('sha256').update(s).digest('hex');
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, json, rawPreview: raw.slice(0, 400) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function findClaudeExe() {
  if (fs.existsSync(CLAUDE_EXE)) return CLAUDE_EXE;
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(tmp, entry.name, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Pinned claude.exe not found in %TEMP%');
}

function writeJsonTurnResponse(res, { model, msgId, contentBlocks, stopReason = 'end_turn', outputTokens = 5 }) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'x-openrouter-provider': 'Anthropic',
    'x-request-id': `req_mock_${msgId}`
  });
  res.end(JSON.stringify({
    id: msgId,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens
    }
  }));
}

function writeSseTurnResponse(res, { model, msgId, contentBlocks, stopReason = 'end_turn', outputTokens = 120 }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'x-openrouter-provider': 'Anthropic',
    'x-request-id': `req_mock_${msgId}`
  });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: {
        input_tokens: 15,
        cache_creation_input_tokens: 8000,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 8000, ephemeral_1h_input_tokens: 0 },
        output_tokens: 1
      }
    }
  });
  contentBlocks.forEach((blk, idx) => {
    if (blk.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: blk.text } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
    } else if (blk.type === 'tool_use') {
      send('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'tool_use', id: blk.id, name: blk.name, input: {} }
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(blk.input || {}) }
      });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
    }
  });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function getLastMessageSummary(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return { text: '', toolResults: [] };
  const last = messages[messages.length - 1];
  const blocks = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: String(last?.content || '') }];
  const texts = [];
  const toolResults = [];
  for (const b of blocks) {
    if (b?.type === 'text') texts.push(b.text || '');
    if (b?.type === 'tool_result') {
      toolResults.push({
        tool_use_id: b.tool_use_id,
        is_error: Boolean(b.is_error),
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
      });
    }
  }
  return { text: texts.join('\n'), toolResults };
}

async function runMockSession({ claudeExe, proxyBaseUrl, mockLog, runLabel, permissionPromptsMode = 'none' }) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cpt-p0-${runLabel}-`));
  const repoDir = path.join(workRoot, 'repo');
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'cfg');
  const settingsPath = path.join(workRoot, 'settings.json');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  const samplePath = path.join(repoDir, 'sample.mjs');
  fs.writeFileSync(samplePath, "export const STATUS = 'buggy';\n", 'utf8');
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {}, autoMemoryEnabled: false }, null, 2), 'utf8');

  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = proxyBaseUrl;
  env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-mock-000000000000';
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
    '--permission-prompts', permissionPromptsMode,
    '--tools', 'Read,Edit,Write,Bash,Grep,Glob',
    '--model', 'claude-opus-5-5',
    '--effort', 'medium',
    '--append-system-prompt', `Benchmark-Run-Salt: ${runLabel}_nonce`,
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
  const controlRequestsSeen = [];

  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        events.push(evt);
        if (evt.type === 'control_request') {
          controlRequestsSeen.push(evt);
          if (permissionPromptsMode === 'host' && evt.request?.subtype === 'can_use_tool') {
            child.stdin.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: evt.request_id,
                response: { behavior: 'deny', message: 'Blocked in Phase 0 test' }
              }
            }) + '\n');
          }
        }
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

  function waitForEvent(pred, timeoutMs = 45000, fromIndex = 0) {
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
          reject(new Error(`[${runLabel}] claude exited early (${exitCode}): ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 400)}`));
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`[${runLabel}] timed out waiting for event. events=${JSON.stringify(events.slice(fromIndex)).slice(0, 600)}`));
        }
      }, 25);
    });
  }

  try {
    // Turn 1 (plan mode)
    mockLog.currentPhase = `${runLabel}_T1_plan`;
    const t1From = events.length;
    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Inspect sample.mjs and produce a plan without editing files.' }
    }) + '\n');
    const t1Res = await waitForEvent((e) => e.type === 'result', 45000, t1From);
    const sampleAfterT1 = fs.readFileSync(samplePath, 'utf8');
    const pwnAfterT1 = fs.existsSync(path.join(repoDir, 'pwn.txt'));

    // Switch permission mode -> bypassPermissions, and model -> claude-sonnet-5-5
    const permFrom = events.length;
    child.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: `req_perm_${runLabel}`,
      request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' }
    }) + '\n');
    const permResp = await waitForEvent(
      (e) => e.type === 'control_response' && e.response?.request_id === `req_perm_${runLabel}`,
      20000,
      permFrom
    );

    const modelFrom = events.length;
    child.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: `req_model_${runLabel}`,
      request: { subtype: 'set_model', model: 'claude-sonnet-5-5' }
    }) + '\n');
    const modelResp = await waitForEvent(
      (e) => e.type === 'control_response' && e.response?.request_id === `req_model_${runLabel}`,
      20000,
      modelFrom
    );

    // Turn 2 (implement under bypassPermissions on claude-sonnet-5-5)
    mockLog.currentPhase = `${runLabel}_T2_impl`;
    const t2From = events.length;
    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Now apply your plan by editing sample.mjs and running a verification command.' }
    }) + '\n');
    const t2Res = await waitForEvent((e) => e.type === 'result', 45000, t2From);
    const sampleAfterT2 = fs.readFileSync(samplePath, 'utf8');
    const bashCheckAfterT2 = fs.existsSync(path.join(repoDir, 'bash_ran.txt'))
      ? fs.readFileSync(path.join(repoDir, 'bash_ran.txt'), 'utf8').trim()
      : null;

    child.stdin.end();
    await Promise.race([closePromise, new Promise((r) => setTimeout(r, 3000))]);

    return {
      runLabel,
      permissionPromptsMode,
      t1ResultText: t1Res.event.result,
      t2ResultText: t2Res.event.result,
      sampleAfterT1,
      pwnAfterT1,
      permControlResponse: permResp.event.response,
      modelControlResponse: modelResp.event.response,
      sampleAfterT2,
      bashCheckAfterT2,
      controlRequestsSeenCount: controlRequestsSeen.length,
      stderrPreview: redactSensitiveText(Buffer.concat(stderrChunks).toString('utf8').slice(0, 400))
    };
  } finally {
    if (!childClosed) {
      try { child.kill('SIGTERM'); } catch {}
    }
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(RAW_OUT_DIR, { recursive: true });
  const apiKey = loadOpenRouterApiKey();

  // 1. Live $0 metadata checks on OpenRouter
  const [modelsResp, keyBefore] = await Promise.all([
    httpsGetJson('https://openrouter.ai/api/v1/models', { Accept: 'application/json' }),
    httpsGetJson('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' })
  ]);
  assert.equal(modelsResp.statusCode, 200, `OpenRouter /api/v1/models failed with HTTP ${modelsResp.statusCode}`);
  assert.equal(keyBefore.statusCode, 200, `OpenRouter /api/v1/key failed with HTTP ${keyBefore.statusCode}`);

  const modelsList = modelsResp.json?.data || [];
  const findModel = (id) => modelsList.find((m) => m.id === id) || null;
  const opus55 = findModel('anthropic/claude-opus-5.5');
  const sonnet55 = findModel('anthropic/claude-sonnet-5.5');
  assert.ok(opus55, 'anthropic/claude-opus-5.5 missing from OpenRouter /api/v1/models');
  assert.ok(sonnet55, 'anthropic/claude-sonnet-5.5 missing from OpenRouter /api/v1/models');

  const toPer1M = (perTokStr) => perTokStr != null ? Number((Number(perTokStr) * 1e6).toFixed(6)) : null;
  const livePricing = {
    'anthropic/claude-opus-5.5': {
      inputPer1M: toPer1M(opus55.pricing?.prompt),
      outputPer1M: toPer1M(opus55.pricing?.completion),
      writePer1M: toPer1M(opus55.pricing?.input_cache_write),
      readPer1M: toPer1M(opus55.pricing?.input_cache_read),
      contextLength: opus55.context_length
    },
    'anthropic/claude-sonnet-5.5': {
      inputPer1M: toPer1M(sonnet55.pricing?.prompt),
      outputPer1M: toPer1M(sonnet55.pricing?.completion),
      writePer1M: toPer1M(sonnet55.pricing?.input_cache_write),
      readPer1M: toPer1M(sonnet55.pricing?.input_cache_read),
      contextLength: sonnet55.context_length
    }
  };
  assert.equal(livePricing['anthropic/claude-opus-5.5'].inputPer1M, PRICING_PER_1M['anthropic/claude-opus-5.5'].input);
  assert.equal(livePricing['anthropic/claude-opus-5.5'].outputPer1M, PRICING_PER_1M['anthropic/claude-opus-5.5'].output);
  assert.equal(livePricing['anthropic/claude-opus-5.5'].readPer1M, PRICING_PER_1M['anthropic/claude-opus-5.5'].read);
  assert.equal(livePricing['anthropic/claude-sonnet-5.5'].inputPer1M, PRICING_PER_1M['anthropic/claude-sonnet-5.5'].input);
  assert.equal(livePricing['anthropic/claude-sonnet-5.5'].outputPer1M, PRICING_PER_1M['anthropic/claude-sonnet-5.5'].output);
  assert.equal(livePricing['anthropic/claude-sonnet-5.5'].readPer1M, PRICING_PER_1M['anthropic/claude-sonnet-5.5'].read);

  // 2. Verify pinned claude.exe
  const claudeExe = findClaudeExe();
  const verOut = spawnSync(claudeExe, ['--version'], { encoding: 'utf8' });
  const cliVersionStr = String(verOut.stdout || verOut.stderr || '').trim();
  assert.ok(cliVersionStr.includes(PINNED_CLAUDE_CODE_VERSION), `Expected CLI ${PINNED_CLAUDE_CODE_VERSION}, got ${cliVersionStr}`);

  // 3. Local $0 Mock Upstream SSE Server
  const tmpWireDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-p0-wire-'));
  const wireLogPath = path.join(tmpWireDir, 'wire.jsonl');
  const rawCapturedRequests = [];
  const mockLog = { currentPhase: 'init', toolResultsObserved: [] };

  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.startsWith('/api/v1/messages/count_tokens')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock count_tokens 404' }));
        return;
      }
      if (!req.url?.startsWith('/api/v1/messages')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = JSON.parse(raw);
      const reqIndex = rawCapturedRequests.length + 1;
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const lastMsg = getLastMessageSummary(parsed.messages);

      rawCapturedRequests.push({
        reqIndex,
        phase: mockLog.currentPhase,
        model: parsed.model,
        stream: Boolean(parsed.stream),
        maxTokens: parsed.max_tokens ?? null,
        effort: parsed.output_config?.effort ?? null,
        hasTools,
        toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        toolsSha256: sha256Hex(parsed.tools || []),
        systemCount: Array.isArray(parsed.system) ? parsed.system.length : 0,
        systemPrefixSha256: Array.isArray(parsed.system) ? sha256Hex(parsed.system.slice(0, Math.max(0, parsed.system.length - 1))) : null,
        systemLastSha256: Array.isArray(parsed.system) && parsed.system.length > 0 ? sha256Hex(parsed.system[parsed.system.length - 1]) : null,
        systemSha256: sha256Hex(parsed.system || []),
        systemBlocksMeta: Array.isArray(parsed.system)
          ? parsed.system.map((b, i) => ({
              index: i,
              chars: JSON.stringify(b).length,
              hasCacheControl: Boolean(b?.cache_control),
              sha256: sha256Hex(b),
              preview: redactSensitiveText((typeof b?.text === 'string' ? b.text : JSON.stringify(b)).slice(0, 80))
            }))
          : [],
        messagesCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        lastMsg
      });

      const respond = (opts) => (parsed.stream ? writeSseTurnResponse(res, opts) : writeJsonTurnResponse(res, opts));

      if (!hasTools) {
        // E.g. set_model capability probe or auxiliary request
        respond({
          model: parsed.model,
          msgId: `mock_${reqIndex}`,
          contentBlocks: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          outputTokens: 5
        });
        return;
      }

      if (mockLog.currentPhase.endsWith('_T1_plan')) {
        if (lastMsg.toolResults.length === 0) {
          respond({
            model: parsed.model,
            msgId: `mock_${reqIndex}`,
            contentBlocks: [{ type: 'tool_use', id: `tu_read_${reqIndex}`, name: 'Read', input: { file_path: 'sample.mjs' } }],
            stopReason: 'tool_use'
          });
        } else if (lastMsg.toolResults.some((tr) => tr.tool_use_id.startsWith('tu_read_'))) {
          respond({
            model: parsed.model,
            msgId: `mock_${reqIndex}`,
            contentBlocks: [
              {
                type: 'tool_use',
                id: `tu_edit_t1_${reqIndex}`,
                name: 'Edit',
                input: { file_path: 'sample.mjs', old_string: "STATUS = 'buggy'", new_string: "STATUS = 'hacked_in_plan'" }
              },
              {
                type: 'tool_use',
                id: `tu_bash_t1_${reqIndex}`,
                name: 'Bash',
                input: { command: 'node -e "require(\'fs\').writeFileSync(\'pwn.txt\',\'hacked\')"' }
              }
            ],
            stopReason: 'tool_use'
          });
        } else {
          mockLog.toolResultsObserved.push({ phase: mockLog.currentPhase, results: lastMsg.toolResults });
          respond({
            model: parsed.model,
            msgId: `mock_${reqIndex}`,
            contentBlocks: [{ type: 'text', text: 'Plan complete: Read succeeded and Edit/Bash were tested.' }],
            stopReason: 'end_turn'
          });
        }
        return;
      }

      if (mockLog.currentPhase.endsWith('_T2_impl')) {
        if (lastMsg.toolResults.length === 0) {
          respond({
            model: parsed.model,
            msgId: `mock_${reqIndex}`,
            contentBlocks: [
              {
                type: 'tool_use',
                id: `tu_edit_t2_${reqIndex}`,
                name: 'Edit',
                input: { file_path: 'sample.mjs', old_string: "STATUS = 'buggy'", new_string: "STATUS = 'fixed'" }
              },
              {
                type: 'tool_use',
                id: `tu_bash_t2_${reqIndex}`,
                name: 'Bash',
                input: { command: 'node -e "require(\'fs\').writeFileSync(\'bash_ran.txt\',\'BASH_OK\')"' }
              }
            ],
            stopReason: 'tool_use'
          });
        } else {
          mockLog.toolResultsObserved.push({ phase: mockLog.currentPhase, results: lastMsg.toolResults });
          respond({
            model: parsed.model,
            msgId: `mock_${reqIndex}`,
            contentBlocks: [{ type: 'text', text: 'Implementation complete.' }],
            stopReason: 'end_turn'
          });
        }
        return;
      }

      respond({
        model: parsed.model,
        msgId: `mock_${reqIndex}`,
        contentBlocks: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn'
      });
    });
  });

  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const proxy = await startProxyServer({
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiPrefix: '/api',
    apiKey: 'sk-or-v1-mock-key-00000000',
    maxBudgetUsd: 5.0,
    wireLogPath,
    pinProvider: true
  });

  try {
    proxy.setContext({ runId: 'MOCK_A', turn: 1 });
    const runA = await runMockSession({
      claudeExe,
      proxyBaseUrl: proxy.baseUrl,
      mockLog,
      runLabel: 'runA',
      permissionPromptsMode: 'none'
    });

    proxy.setContext({ runId: 'MOCK_B', turn: 1 });
    const runB = await runMockSession({
      claudeExe,
      proxyBaseUrl: proxy.baseUrl,
      mockLog,
      runLabel: 'runB',
      permissionPromptsMode: 'none'
    });

    // Inspect captured requests
    const runAT1Reqs = rawCapturedRequests.filter((r) => r.phase === 'runA_T1_plan' && r.hasTools);
    const runAT2Reqs = rawCapturedRequests.filter((r) => r.phase === 'runA_T2_impl' && r.hasTools);
    const runBT1Reqs = rawCapturedRequests.filter((r) => r.phase === 'runB_T1_plan' && r.hasTools);
    const sideCalls = rawCapturedRequests.filter((r) => !r.hasTools);

    assert.ok(runAT1Reqs.length >= 2, `Run A Turn 1 must make >=2 main requests, got ${runAT1Reqs.length}; runA=${JSON.stringify(runA)}`);
    assert.ok(runAT2Reqs.length >= 2, `Run A Turn 2 must make >=2 main requests, got ${runAT2Reqs.length}; runA=${JSON.stringify(runA)}`);
    assert.equal(runA.sampleAfterT1, "export const STATUS = 'buggy';\n", `Plan mode MUST prevent Edit on Turn 1; runA=${JSON.stringify(runA)}`);
    assert.equal(runA.pwnAfterT1, false, 'Plan mode MUST prevent Bash file write on Turn 1');
    assert.equal(runA.permControlResponse?.subtype, 'success', `set_permission_mode must succeed: ${JSON.stringify(runA.permControlResponse)}`);
    assert.equal(runA.modelControlResponse?.subtype, 'success', `set_model must succeed: ${JSON.stringify(runA.modelControlResponse)}`);
    assert.equal(runA.sampleAfterT2, "export const STATUS = 'fixed';\n", 'bypassPermissions on Turn 2 MUST allow Edit');
    assert.equal(runA.bashCheckAfterT2, 'BASH_OK', 'bypassPermissions on Turn 2 MUST allow Bash');

    assert.equal(runAT2Reqs[0].model, 'anthropic/claude-sonnet-5.5', 'Turn 2 after set_model must route to Sonnet 5.5');
    assert.equal(runAT2Reqs[0].effort, 'medium', 'Effort must stay medium');

    const toolsMatchT1ToT2 = runAT1Reqs[0].toolsSha256 === runAT2Reqs[0].toolsSha256;
    const systemMatchT1ToT2 = runAT1Reqs[0].systemSha256 === runAT2Reqs[0].systemSha256;
    const toolsMatchAB = runAT1Reqs[0].toolsSha256 === runBT1Reqs[0].toolsSha256;
    const systemPrefixMatchAB = runAT1Reqs[0].systemPrefixSha256 === runBT1Reqs[0].systemPrefixSha256;
    const systemLastMatchAB = runAT1Reqs[0].systemLastSha256 === runBT1Reqs[0].systemLastSha256;

    // Check proxy wire log for memory / cache invariants
    const wireLines = fs.readFileSync(wireLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const anyMemoryMd = wireLines.some((w) => w.requestFingerprint?.systemHasMemoryMd === true);
    assert.equal(anyMemoryMd, false, 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 must keep systemHasMemoryMd === false');

    // Confirm $0 spend on OpenRouter key
    const keyAfter = await httpsGetJson('https://openrouter.ai/api/v1/key', {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    });
    assert.equal(keyAfter.statusCode, 200);
    const spendDeltaUsd = Number(((keyAfter.json?.data?.usage ?? 0) - (keyBefore.json?.data?.usage ?? 0)).toFixed(6));
    assert.equal(spendDeltaUsd, 0, `Phase 0 live OpenRouter spend must be $0.000000, got ${spendDeltaUsd}`);

    const report = {
      generatedAtUtc: new Date().toISOString(),
      cliVersion: cliVersionStr,
      openRouterKeySnapshot: {
        usageBeforeUsd: keyBefore.json?.data?.usage ?? null,
        usageAfterUsd: keyAfter.json?.data?.usage ?? null,
        spendDeltaUsd,
        limitUsd: keyAfter.json?.data?.limit ?? null,
        limitRemainingUsd: keyAfter.json?.data?.limit_remaining ?? null
      },
      livePricing55: livePricing,
      mockVerification: {
        runA,
        runB,
        toolsMatchT1ToT2,
        systemMatchT1ToT2,
        toolsMatchAB,
        systemPrefixMatchAB,
        systemLastMatchAB,
        sideCallsCount: sideCalls.length,
        sideCallsModels: sideCalls.map((s) => s.model),
        anyMemoryMd,
        t1Req0ToolsSha256: runAT1Reqs[0].toolsSha256,
        t2Req0ToolsSha256: runAT2Reqs[0].toolsSha256,
        t1Req0SystemBlocksMeta: runAT1Reqs[0].systemBlocksMeta,
        t2Req0SystemBlocksMeta: runAT2Reqs[0].systemBlocksMeta,
        toolResultsObserved: mockLog.toolResultsObserved.map((x) => ({
          phase: x.phase,
          results: x.results.map((r) => ({
            tool_use_id: r.tool_use_id,
            is_error: r.is_error,
            preview: redactSensitiveText(r.content).slice(0, 180)
          }))
        })),
        cacheIsolationConclusion:
          toolsMatchAB && systemPrefixMatchAB
            ? 'tools + system[0..prefix] with cache_control precede --append-system-prompt; MUST enforce >=365s per-model idle cooldown in addition to per-run salt'
            : 'per-run salt mutated prefix before first cache breakpoint'
      }
    };

    const reportStr = JSON.stringify(report, null, 2);
    assertNoSensitiveLeaks(reportStr, 'phase0_mock_verification.json', [apiKey]);
    fs.writeFileSync(OUT_PATH, reportStr + '\n', 'utf8');

    console.log('PHASE0_GATE_PASS');
    console.log(JSON.stringify({
      cliVersion: report.cliVersion,
      keyUsageUsd: report.openRouterKeySnapshot.usageAfterUsd,
      keyLimitRemainingUsd: report.openRouterKeySnapshot.limitRemainingUsd,
      spendDeltaUsd: report.openRouterKeySnapshot.spendDeltaUsd,
      livePricing55: report.livePricing55,
      toolsMatchT1ToT2,
      systemMatchT1ToT2,
      toolsMatchAB,
      systemPrefixMatchAB,
      systemLastMatchAB,
      sideCallsCount: sideCalls.length,
      anyMemoryMd,
      sampleAfterT1: runA.sampleAfterT1.trim(),
      sampleAfterT2: runA.sampleAfterT2.trim(),
      bashCheckAfterT2: runA.bashCheckAfterT2
    }, null, 2));
  } finally {
    await proxy.close();
    mockUpstream.close();
    fs.rmSync(tmpWireDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('PHASE0_GATE_FAIL:', err);
  process.exit(1);
});
