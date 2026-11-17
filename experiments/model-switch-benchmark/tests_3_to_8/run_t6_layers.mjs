#!/usr/bin/env node
/**
 * T6: Prefix Layer Matrix (Item 6 of Cost Optimization Anti-Patterns)
 *
 * 1) Measures standalone layer token counts (tools ~5.9k, system ~3k, T6 ~15.3k)
 * 2) Runs 10 API arms (n=3, 12 turns, anthropic/claude-sonnet-4.6 via OpenRouter):
 *    C, TS, TF, TK, TA, SY, SRAG, MRAG, TSTUB, ME
 * 3) Runs 3 headless Claude Code 2.1.325 CLI arms (n=3, 12 turns, prompts_small.json):
 *    CC-T (--mcp-config @T6), CC-M (edit CLAUDE.md between T5 & T6), CC-S (change --append-system-prompt @T6)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import {
  STANDARD_CSV_COLUMNS,
  EXPERIMENT_DIR,
  RESULTS_DIR,
  createRepNonce,
  injectNonceAndBreakpoints,
  loadBenchmarkKeys,
  loadRateCard,
  sendMessagesCall,
  RunBudgetTracker,
  summarizeMedianRange,
  writeCsv,
  assertNoSensitiveLeaks,
  redactSensitiveText,
  computeUsageCostExt
} from './prefix_lab.mjs';
import {
  CLAUDE_EXE,
  FROZEN_REPO_DIR,
  RUNTIME_ROOT,
  normalizeUsage,
  mapCliModelToOpenRouter
} from '../config.mjs';
import { extractRequestFingerprint, parseSseTranscript } from '../proxy_recorder.mjs';
import {
  buildT6ToolCatalog,
  buildExtraTool21,
  buildSearchStubTool,
  buildDeferredSchemaBlockText,
  buildT6SystemText,
  buildT6TurnMessagesAndRag,
  selectDynamicToolsSubset15
} from './t6_fixtures.mjs';

const T6_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'harness',
  'cli_turn',
  'subcall_index',
  'tools_count',
  'tools_sha256',
  'system_sha256',
  'messages_prefix_sha256',
  'surviving_layers'
];

function classifySurvivingLayers(arm, turn, cacheReadTok, measured, prevPromptTok = 0) {
  if (turn < 6 && arm !== 'TF' && arm !== 'SRAG' && arm !== 'MRAG') {
    return cacheReadTok > 1000 ? 'full_prefix' : 'cold';
  }
  if (cacheReadTok < 500) return 'none';
  if (arm === 'TSTUB') {
    if ((prevPromptTok > 0 && cacheReadTok >= prevPromptTok - 60) || cacheReadTok >= 6000) {
      return 'tools+system+history';
    }
    if (cacheReadTok >= 4200) return 'tools+system';
  }
  const tTok = measured.toolsTokens;
  const tsTok = measured.toolsPlusSystemTokens;
  if (cacheReadTok >= tsTok + 1500) return 'tools+system+history';
  if (cacheReadTok >= tsTok - 800 && cacheReadTok <= tsTok + 1000) return 'tools+system';
  if (cacheReadTok >= tTok - 800 && cacheReadTok <= tTok + 800) return 'tools_only';
  if (cacheReadTok >= 1000 && cacheReadTok < tTok - 800) return `partial_${Math.round(cacheReadTok)}tok`;
  return `approx_${Math.round(cacheReadTok)}tok`;
}

async function measureApiLayerSizes({ customRateCard, extraSecrets }) {
  const tools20 = buildT6ToolCatalog({ shuffled: false });
  const sysText = buildT6SystemText();
  const nonceTools = createRepNonce('t6_cal_tools');
  const pTools = injectNonceAndBreakpoints({
    nonce: nonceTools,
    tools: tools20,
    system: [],
    messages: [{ role: 'user', content: 'Hi' }],
    breakpointLayers: ['tools'],
    omitMessageBreakpoint: true
  });
  const rTools = await sendMessagesCall({
    test: 'T6_CAL',
    arm: 'CAL_TOOLS',
    rep: 1,
    turn: 1,
    route: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    tools: pTools.tools,
    system: pTools.system,
    messages: pTools.messages,
    max_tokens: 1,
    stream: false,
    nonceId: nonceTools,
    customRateCard
  });

  const nonceTS = createRepNonce('t6_cal_ts');
  const pTS = injectNonceAndBreakpoints({
    nonce: nonceTS,
    tools: tools20,
    system: [{ type: 'text', text: sysText }],
    messages: [{ role: 'user', content: 'Hi' }],
    breakpointLayers: ['tools', 'system'],
    omitMessageBreakpoint: true
  });
  const rTS = await sendMessagesCall({
    test: 'T6_CAL',
    arm: 'CAL_TOOLS_SYS',
    rep: 1,
    turn: 1,
    route: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    tools: pTS.tools,
    system: pTS.system,
    messages: pTS.messages,
    max_tokens: 1,
    stream: false,
    nonceId: nonceTS,
    customRateCard
  });

  if (rTools.row.http_status >= 400 || rTS.row.http_status >= 400) {
    throw new Error(`T6 calibration failed: ${rTools.row.error_text || rTS.row.error_text}`);
  }
  const toolsTokens = rTools.row.prompt_tokens;
  const toolsPlusSystemTokens = rTS.row.prompt_tokens;
  const systemOnlyApproxTokens = toolsPlusSystemTokens - toolsTokens;
  const info = {
    toolsTokens,
    toolsPlusSystemTokens,
    systemOnlyApproxTokens,
    calCostUsd: Number(
      ((Number(rTools.row.billed_cost_usd) || rTools.row.computed_cost_usd) +
        (Number(rTS.row.billed_cost_usd) || rTS.row.computed_cost_usd)).toFixed(6)
    )
  };
  assertNoSensitiveLeaks(JSON.stringify(info), 't6_calibration', extraSecrets);
  console.log('[T6] Standalone measured layer sizes (OpenRouter Sonnet 4.6):', JSON.stringify(info));
  return info;
}

async function runApiArmRep({ armSpec, rep, fixtures, measured, customRateCard, extraSecrets }) {
  const nonceId = createRepNonce(`t6_${armSpec.arm}_r${rep}`);
  const tracker = new RunBudgetTracker({
    expectedRunUsd: armSpec.expectedRunUsd,
    multiplier: 3,
    globalCapUsd: 20,
    label: `T6_${armSpec.arm}_r${rep}`
  });

  const { tools20, tools20Shuffled, extra21, stubTool, deferredText, systemBaseText, turns, ragByTurn } = fixtures;
  const history = []; // committed { role, userText, assistantText, editedUserText? }
  const rows = [];
  let prevPromptTok = 0;

  for (let turn = 1; turn <= 12; turn++) {
    // 1. Select tools for this arm and turn
    let activeTools = tools20;
    if (armSpec.arm === 'TS' && turn >= 6) {
      activeTools = tools20.filter((_, i) => i < 5 || i >= 10);
    } else if (armSpec.arm === 'TF') {
      activeTools = selectDynamicToolsSubset15(tools20, turn);
    } else if (armSpec.arm === 'TK' && turn >= 6) {
      activeTools = tools20Shuffled;
    } else if (armSpec.arm === 'TA' && turn >= 6) {
      activeTools = [...tools20, extra21];
    } else if (armSpec.arm === 'TSTUB') {
      activeTools = [stubTool];
    }

    // 2. Select system blocks for this arm and turn
    let activeSystem = [{ type: 'text', text: systemBaseText }];
    if (armSpec.arm === 'SY' && turn >= 6) {
      activeSystem = [{
        type: 'text',
        text: `${systemBaseText}\n\nRule update added at turn 6: Cite exact module constants in backticks.`
      }];
    } else if (armSpec.arm === 'SRAG' && turn >= 2) {
      activeSystem = [
        { type: 'text', text: systemBaseText },
        { type: 'text', text: ragByTurn[turn] }
      ];
    }

    // 3. Assemble messages
    const apiMessages = [];
    for (const h of history) {
      const uText = (armSpec.arm === 'ME' && turn >= 6 && h.turn === 2 && h.editedUserText)
        ? h.editedUserText
        : h.userText;
      apiMessages.push({
        role: 'user',
        content: [{ type: 'text', text: uText }]
      });
      apiMessages.push({
        role: 'assistant',
        content: [{ type: 'text', text: h.assistantText }]
      });
    }

    const turnObj = turns[turn - 1];
    let currentUserText = turnObj.questionText;
    if (armSpec.arm === 'TSTUB' && turn === 6) {
      currentUserText = `${currentUserText}${deferredText}`;
    }

    let payload;
    if (armSpec.arm === 'MRAG' && turn >= 2) {
      // Transient RAG goes AFTER question_t, while cache_control sits on question_t (so history breakpoint stays intact on turn t+1).
      apiMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: currentUserText },
          { type: 'text', text: ragByTurn[turn] }
        ]
      });
      payload = injectNonceAndBreakpoints({
        nonce: nonceId,
        tools: activeTools,
        system: activeSystem,
        messages: apiMessages,
        breakpointLayers: ['tools', 'system'],
        omitMessageBreakpoint: true
      });
      const lastMsg = payload.messages[payload.messages.length - 1];
      lastMsg.content[0].cache_control = { type: 'ephemeral' };
    } else {
      apiMessages.push({
        role: 'user',
        content: [{ type: 'text', text: currentUserText }]
      });
      payload = injectNonceAndBreakpoints({
        nonce: nonceId,
        tools: activeTools,
        system: activeSystem,
        messages: apiMessages,
        breakpointLayers: ['tools', 'system', 'messages'],
        omitMessageBreakpoint: false
      });
    }

    if (armSpec.arm === 'TK' && turn === 5) {
      armSpec._t5ToolsJson = JSON.stringify(payload.tools);
    } else if (armSpec.arm === 'TK' && turn === 6) {
      if (armSpec._t5ToolsJson === JSON.stringify(payload.tools)) {
        throw new Error('TK invariant failed: T6 tools JSON matched T5 tools JSON');
      }
    }

    const fp = extractRequestFingerprint(
      { tools: payload.tools, system: payload.system, messages: payload.messages },
      {},
      '/v1/messages'
    );

    let callRes = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      callRes = await sendMessagesCall({
        test: 'T6',
        arm: armSpec.arm,
        rep,
        turn,
        route: 'openrouter',
        model: 'anthropic/claude-sonnet-4.6',
        tools: payload.tools,
        system: payload.system,
        messages: payload.messages,
        max_tokens: 100,
        stream: true,
        nonceId,
        customRateCard,
        budgetTracker: tracker
      });
      if (callRes.row.http_status < 400) break;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2500 * attempt));
      }
    }

    if (callRes.row.http_status >= 400) {
      return { ok: false, reason: `T${turn}_http_${callRes.row.http_status}:${callRes.row.error_text}`, rows };
    }

    const assistantText = callRes.assistantText && callRes.assistantText.trim()
      ? callRes.assistantText.trim()
      : 'Acknowledged.';
    history.push({
      turn,
      userText: currentUserText,
      editedUserText: turnObj.editedTurn2Text,
      assistantText
    });

    const surviving = classifySurvivingLayers(armSpec.arm, turn, callRes.row.cache_read_tokens, measured, prevPromptTok);
    prevPromptTok = callRes.row.prompt_tokens || 0;
    rows.push({
      ...callRes.row,
      harness: 'api',
      cli_turn: turn,
      subcall_index: 1,
      tools_count: fp.toolsCount,
      tools_sha256: fp.toolsSha256,
      system_sha256: fp.systemSha256,
      messages_prefix_sha256: fp.messagesPrefixSha256,
      surviving_layers: surviving
    });
  }

  assertNoSensitiveLeaks(JSON.stringify(rows), `t6_${armSpec.arm}_r${rep}`, extraSecrets);
  return { ok: true, rows };
}

async function startT6CcProxy({ keys, customRateCard }) {
  const state = {
    nonceId: '',
    arm: '',
    rep: 1,
    cliTurn: 1,
    records: [],
    subcallCounter: 0,
    sideCallsCount: 0,
    sideCallsCostUsd: 0
  };
  const upstreamUrl = new URL('https://openrouter.ai/api');

  const server = http.createServer((req, res) => {
    const reqStartNs = process.hrtime.bigint();
    const reqStartEpochMs = Date.now();
    const tStartIso = new Date(reqStartEpochMs).toISOString();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const urlPath = req.url || '/';
      let parsedReq = null;
      try { parsedReq = rawBody ? JSON.parse(rawBody) : null; } catch {}

      if (urlPath.includes('count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(rawBody, 'utf8') / 4)) }));
        return;
      }

      const isMessages = /^\/(?:api\/)?v1\/messages(?:\?|$)/.test(urlPath);
      const hasTools = Boolean(parsedReq && Array.isArray(parsedReq.tools) && parsedReq.tools.length > 0);
      const isSideCall = !isMessages || !hasTools;

      let outbound = parsedReq ? structuredClone(parsedReq) : null;
      if (outbound && isMessages) {
        outbound.model = mapCliModelToOpenRouter(outbound.model || 'claude-sonnet-4-6');
        outbound.provider = { only: ['anthropic'], allow_fallbacks: false };
        if (state.nonceId && !isSideCall) {
          const prefix = `[NONCE:${state.nonceId}] `;
          if (Array.isArray(outbound.tools) && outbound.tools.length > 0) {
            for (const t of outbound.tools) {
              t.description = `${prefix}${t.description || t.name || 'tool'}`;
            }
          }
        }
      }

      const outboundStr = outbound ? JSON.stringify(outbound) : rawBody;
      const fp = outbound && isMessages ? extractRequestFingerprint(outbound, req.headers, urlPath) : null;
      const cleanPath = urlPath.startsWith('/api/') ? urlPath.slice(4) : urlPath;
      const targetPath = `${upstreamUrl.pathname.replace(/\/+$/, '')}${cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath}`;

      const outHeaders = {
        'content-type': req.headers['content-type'] || 'application/json',
        'authorization': `Bearer ${keys.OPENROUTER_API_KEY}`,
        'accept-encoding': 'identity',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'http-referer': 'https://github.com/<GITHUB_HANDLE>/<TARGET_REPO>',
        'x-title': '<PROJECT_NAME> T6 CC Proxy',
        'content-length': Buffer.byteLength(outboundStr, 'utf8')
      };
      if (req.headers['anthropic-beta']) outHeaders['anthropic-beta'] = req.headers['anthropic-beta'];
      if (req.headers['accept']) outHeaders['accept'] = req.headers['accept'];

      const upstreamReq = https.request(
        {
          protocol: 'https:',
          hostname: upstreamUrl.hostname,
          port: 443,
          path: targetPath,
          method: req.method || 'POST',
          headers: outHeaders
        },
        (upstreamRes) => {
          const statusCode = upstreamRes.statusCode || 502;
          const clientHeaders = {};
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            const lk = k.toLowerCase();
            if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(lk)) continue;
            clientHeaders[k] = v;
          }
          res.writeHead(statusCode, clientHeaders);

          let firstByteNs = null;
          let messageStartNs = null;
          const resChunks = [];
          upstreamRes.on('data', (chunk) => {
            const nowNs = process.hrtime.bigint();
            if (firstByteNs === null) firstByteNs = nowNs;
            if (!messageStartNs && chunk.toString('utf8').includes('message_start')) {
              messageStartNs = nowNs;
            }
            resChunks.push(chunk);
            res.write(chunk);
          });
          upstreamRes.on('end', () => {
            res.end();
            const endNs = process.hrtime.bigint();
            const rawRes = Buffer.concat(resChunks).toString('utf8');
            const isSse = String(upstreamRes.headers['content-type'] || '').includes('text/event-stream') ||
              rawRes.includes('event: message_start');
            let parsedRes = { usage: {}, responseModel: outbound?.model || 'anthropic/claude-sonnet-4.6', errorPayload: null };
            if (isSse) {
              parsedRes = parseSseTranscript(rawRes);
            } else {
              try {
                const j = JSON.parse(rawRes);
                parsedRes = { usage: j?.usage || {}, responseModel: j?.model || null, errorPayload: j?.error || null };
              } catch {}
            }

            if (isMessages && !isSideCall) {
              state.subcallCounter += 1;
              const u = normalizeUsage(parsedRes.usage);
              const costCalc = computeUsageCostExt('anthropic/claude-sonnet-4.6', parsedRes.usage, { customRateCard });
              const hasBilled = typeof parsedRes.usage?.cost === 'number' && Number.isFinite(parsedRes.usage.cost);
              const billed = hasBilled ? Number(parsedRes.usage.cost) : '';
              const firstNs = messageStartNs || firstByteNs || endNs;
              const ttfbMs = Number((Number(firstNs - reqStartNs) / 1e6).toFixed(3));
              const latencyMs = Number((Number(endNs - reqStartNs) / 1e6).toFixed(3));
              const tFirstByteIso = new Date(reqStartEpochMs + ttfbMs).toISOString();
              const tEndIso = new Date(reqStartEpochMs + latencyMs).toISOString();
              state.records.push({
                test: 'T6',
                arm: state.arm,
                rep: state.rep,
                turn: state.cliTurn,
                model_slug: 'anthropic/claude-sonnet-4.6',
                provider: upstreamRes.headers['x-openrouter-provider'] || 'openrouter_anthropic_pinned',
                prompt_tokens: u.total_input_tokens,
                uncached_input_tokens: u.input_tokens,
                cache_read_tokens: u.cache_read_input_tokens,
                cache_write_5m_tokens: costCalc.write5mTokens,
                cache_write_1h_tokens: costCalc.write1hTokens,
                cache_write_tokens: u.cache_creation_input_tokens,
                output_tokens: u.output_tokens,
                billed_cost_usd: billed,
                computed_cost_usd: costCalc.totalCostUsd,
                cost_source: hasBilled ? 'billed' : 'computed',
                http_status: statusCode,
                error_text: parsedRes.errorPayload ? redactSensitiveText(JSON.stringify(parsedRes.errorPayload)) : '',
                t_start: tStartIso,
                t_first_byte: tFirstByteIso,
                t_end: tEndIso,
                ttfb_ms: ttfbMs,
                latency_ms: latencyMs,
                nonce_id: state.nonceId,
                harness: 'claude_code_2.1.325',
                cli_turn: state.cliTurn,
                subcall_index: state.subcallCounter,
                tools_count: fp?.toolsCount ?? 0,
                tools_sha256: fp?.toolsSha256 ?? '',
                system_sha256: fp?.systemSha256 ?? '',
                messages_prefix_sha256: fp?.messagesPrefixSha256 ?? '',
                surviving_layers: ''
              });
            } else if (isMessages && isSideCall) {
              state.sideCallsCount += 1;
              const hasBilled = typeof parsedRes.usage?.cost === 'number' && Number.isFinite(parsedRes.usage.cost);
              if (hasBilled) state.sideCallsCostUsd += Number(parsedRes.usage.cost);
            }
          });
        }
      );
      upstreamReq.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
      });
      upstreamReq.write(outboundStr);
      upstreamReq.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setTurnContext({ nonceId, arm, rep, cliTurn }) {
      state.nonceId = nonceId;
      state.arm = arm;
      state.rep = rep;
      state.cliTurn = cliTurn;
      state.subcallCounter = 0;
    },
    getRecords() {
      return state.records.slice();
    },
    getSideStats() {
      return { sideCallsCount: state.sideCallsCount, sideCallsCostUsd: Number(state.sideCallsCostUsd.toFixed(6)) };
    },
    clearRecords() {
      state.records.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  };
}

function runCcCliTurn({
  prompt,
  sessionId,
  appendSystemPrompt,
  mcpConfigPath = null,
  cwd,
  homeDir,
  cfgDir,
  settingsPath,
  proxyBaseUrl,
  timeoutMs = 180000
}) {
  return new Promise((resolve) => {
    const args = [];
    if (sessionId) args.push('--resume', sessionId);
    args.push(
      '-p', prompt,
      '--model', 'claude-sonnet-4-6',
      '--effort', 'medium',
      '--tools', 'Read',
      '--append-system-prompt', appendSystemPrompt,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--settings', settingsPath
    );
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }

    const env = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.OPENROUTER_API_KEY;
    env.ANTHROPIC_BASE_URL = proxyBaseUrl;
    env.ANTHROPIC_API_KEY = ['sk', 'ant', 'api03', 'local', 'proxy', '000000000000'].join('-');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.CLAUDE_CONFIG_DIR = cfgDir;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;

    const child = spawn(CLAUDE_EXE, args, {
      cwd,
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
      const stdout = Buffer.concat(outChunks).toString('utf8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      let parsed = null;
      try {
        parsed = stdout ? JSON.parse(stdout.split(/\r?\n/).pop()) : null;
      } catch {}
      resolve({
        code,
        timedOut,
        sessionId: parsed?.session_id || null,
        stdoutPreview: stdout.slice(0, 300),
        stderrPreview: stderr.slice(0, 300)
      });
    });
  });
}

async function runCcArmRep({ arm, rep, promptsSmall, proxy, customRateCard, extraSecrets }) {
  const nonceId = createRepNonce(`t6_${arm}_r${rep}`);
  const runDir = path.join(RUNTIME_ROOT, 't6_cc_runs', `${arm}_r${rep}_${nonceId.slice(-6)}`);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const repoCopy = path.join(runDir, 'repo');
  fs.cpSync(FROZEN_REPO_DIR, repoCopy, { recursive: true });
  const homeDir = path.join(runDir, 'home');
  const cfgDir = path.join(runDir, 'cfg');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  const settingsPath = path.join(runDir, 'settings.json');
  fs.writeFileSync(settingsPath, '{}', 'utf8');

  const mcpJsonPath = path.join(runDir, 'mcp_10.json');
  fs.writeFileSync(
    mcpJsonPath,
    JSON.stringify({
      mcpServers: {
        bench_mcp: {
          command: process.execPath,
          args: [path.resolve(EXPERIMENT_DIR, 'tests_3_to_8', 'mock_mcp_10tools.mjs')]
        }
      }
    }, null, 2),
    'utf8'
  );

  if (arm === 'CC-M') {
    fs.writeFileSync(
      path.join(repoCopy, 'CLAUDE.md'),
      '# Repository Benchmark Guide\n\n- Keep summaries concise and cite exact symbol names.\n- Use only read-only file inspection.\n',
      'utf8'
    );
  }

  proxy.clearRecords();
  const tracker = new RunBudgetTracker({
    expectedRunUsd: arm === 'CC-T' ? 0.25 : 0.1650,
    multiplier: 3,
    globalCapUsd: 20,
    label: `T6_${arm}_r${rep}`
  });

  let sessionId = null;
  try {
    for (let turn = 1; turn <= 12; turn++) {
      if (arm === 'CC-M' && turn === 6) {
        fs.writeFileSync(
          path.join(repoCopy, 'CLAUDE.md'),
          '# Repository Benchmark Guide\n\n- Keep summaries concise and cite exact symbol names.\n- Use only read-only file inspection.\n- Turn 6 addition: Include module filenames explicitly in bullet points.\n',
          'utf8'
        );
      }

      const appendPrompt = arm === 'CC-S' && turn >= 6
        ? 'Benchmark directive alpha: summarize accurately in <= 70 words. Turn 6 update: include module path prefixes.'
        : 'Benchmark directive alpha: summarize accurately in <= 70 words.';
      const useMcp = arm === 'CC-T' && turn >= 6 ? mcpJsonPath : null;

      proxy.setTurnContext({ nonceId, arm, rep, cliTurn: turn });
      const res = await runCcCliTurn({
        prompt: promptsSmall.prompts[turn - 1].prompt,
        sessionId,
        appendSystemPrompt: appendPrompt,
        mcpConfigPath: useMcp,
        cwd: repoCopy,
        homeDir,
        cfgDir,
        settingsPath,
        proxyBaseUrl: proxy.baseUrl
      });

      if (res.sessionId && !sessionId) sessionId = res.sessionId;
      if (res.code !== 0 || res.timedOut) {
        return {
          ok: false,
          reason: `CLI fail turn ${turn} code=${res.code} timedOut=${res.timedOut} stdout=${res.stdoutPreview} stderr=${res.stderrPreview}`,
          rows: proxy.getRecords()
        };
      }
      const recs = proxy.getRecords().filter((r) => r.cli_turn === turn);
      if (recs.length === 0 || recs.some((r) => r.http_status >= 400)) {
        return { ok: false, reason: `HTTP error on CLI turn ${turn}`, rows: proxy.getRecords() };
      }
      for (const r of recs) {
        tracker.record(r.billed_cost_usd !== '' ? Number(r.billed_cost_usd) : r.computed_cost_usd);
      }
    }

    const rows = proxy.getRecords().map((r) => {
      // Tag surviving layers by hash equality to T5 primary call
      const t5 = proxy.getRecords().find((x) => x.cli_turn === 5 && x.subcall_index === 1);
      let surv = 'n/a';
      if (t5 && r.cli_turn >= 6) {
        const toolsSame = r.tools_sha256 === t5.tools_sha256;
        const sysSame = r.system_sha256 === t5.system_sha256;
        const histKept = r.cache_read_tokens >= t5.cache_read_tokens * 0.90;
        if (!toolsSame) surv = 'none(tools_changed)';
        else if (!sysSame) surv = 'tools_only(system_changed)';
        else if (histKept) surv = 'tools+system+history';
        else surv = `approx_${Math.round(r.cache_read_tokens)}tok`;
      } else if (r.cli_turn < 6) {
        surv = r.cache_read_tokens > 1000 ? 'full_prefix' : 'cold';
      }
      return { ...r, surviving_layers: surv };
    });

    assertNoSensitiveLeaks(JSON.stringify(rows), `t6_${arm}_r${rep}`, extraSecrets);
    return { ok: true, rows };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const onlyCc = argv.has('--only-cc');
  const onlyApi = argv.has('--only-api');
  const fresh = argv.has('--fresh');
  if (onlyCc && onlyApi) {
    throw new Error('Cannot specify both --only-cc and --only-api');
  }

  const keys = loadBenchmarkKeys();
  const extraSecrets = [keys.OPENROUTER_API_KEY, keys.ANTHROPIC_API_KEY, keys.GEMINI_BENCHMARK_API_KEY].filter(Boolean);
  const customRateCard = loadRateCard();

  const tools20 = buildT6ToolCatalog({ shuffled: false });
  const tools20Shuffled = buildT6ToolCatalog({ shuffled: true });
  const fixtures = {
    tools20,
    tools20Shuffled,
    extra21: buildExtraTool21(),
    stubTool: buildSearchStubTool(),
    deferredText: buildDeferredSchemaBlockText(tools20),
    systemBaseText: buildT6SystemText(),
    ...buildT6TurnMessagesAndRag()
  };

  // Step 1: Standalone layer token calibration
  const measured = onlyCc
    ? { toolsTokens: 6368, toolsPlusSystemTokens: 9365, systemOnlyApproxTokens: 2997, calCostUsd: 0.058524 }
    : await measureApiLayerSizes({ customRateCard, extraSecrets });

  const checkpointPath = path.join(RESULTS_DIR, 'raw', 't6_checkpoint_rows.jsonl');
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  if (fresh && fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
  }

  const allRows = [];
  const completedKeys = new Set();
  if (!fresh && fs.existsSync(checkpointPath)) {
    const rawCk = fs.readFileSync(checkpointPath, 'utf8').trim();
    if (rawCk) {
      for (const line of rawCk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        allRows.push(row);
        completedKeys.add(`${row.arm}:r${row.rep}`);
      }
      console.log(`[T6] Loaded ${allRows.length} checkpointed rows (${completedKeys.size} completed reps).`);
    }
  }

  function appendCheckpointRows(rows, label) {
    const jsonLines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    assertNoSensitiveLeaks(jsonLines, label, extraSecrets);
    fs.appendFileSync(checkpointPath, jsonLines, 'utf8');
  }

  // Step 2: 10 API arms x 3 reps
  const apiArms = [
    { arm: 'C', expectedRunUsd: 0.1330 },
    { arm: 'TS', expectedRunUsd: 0.1855 },
    { arm: 'TF', expectedRunUsd: 0.6066 },
    { arm: 'TK', expectedRunUsd: 0.1855 },
    { arm: 'TA', expectedRunUsd: 0.1855 },
    { arm: 'SY', expectedRunUsd: 0.1648 },
    { arm: 'SRAG', expectedRunUsd: 0.3884 },
    { arm: 'MRAG', expectedRunUsd: 0.1577 },
    { arm: 'TSTUB', expectedRunUsd: 0.0957 },
    { arm: 'ME', expectedRunUsd: 0.1544 }
  ];

  const apiTasks = [];
  if (!onlyCc) {
    for (const armSpec of apiArms) {
      for (let rep = 1; rep <= 3; rep++) {
        if (!completedKeys.has(`${armSpec.arm}:r${rep}`)) {
          apiTasks.push({ armSpec, rep });
        }
      }
    }
  }

  const abortedRuns = [];

  if (apiTasks.length > 0) {
    await runPool(apiTasks, 3, async ({ armSpec, rep }) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`[T6 API] Running ${armSpec.arm} rep=${rep} attempt=${attempt}...`);
        let res;
        try {
          res = await runApiArmRep({ armSpec, rep, fixtures, measured, customRateCard, extraSecrets });
        } catch (err) {
          res = { ok: false, reason: err.message, rows: [] };
        }
        if (res.ok) {
          appendCheckpointRows(res.rows, `t6_ckpt_${armSpec.arm}_r${rep}`);
          allRows.push(...res.rows);
          completedKeys.add(`${armSpec.arm}:r${rep}`);
          const t5 = res.rows.find((r) => r.turn === 5);
          const t6 = res.rows.find((r) => r.turn === 6);
          const t7 = res.rows.find((r) => r.turn === 7);
          const totCost = res.rows.reduce((s, r) => s + Number(r.billed_cost_usd || r.computed_cost_usd), 0);
          console.log(
            `[T6 API] Done ${armSpec.arm} rep=${rep}: T5read=${t5?.cache_read_tokens}, ` +
            `T6read=${t6?.cache_read_tokens} (${t6?.surviving_layers}), T7read=${t7?.cache_read_tokens}, total=$${totCost.toFixed(4)}`
          );
          return;
        }
        abortedRuns.push({ harness: 'api', arm: armSpec.arm, rep, attempt, reason: res.reason });
        console.warn(`[T6 API] Aborted ${armSpec.arm} rep=${rep} attempt=${attempt}: ${res.reason}`);
        if (attempt >= 2) throw new Error(`T6 API ${armSpec.arm} rep=${rep} failed after retry: ${res.reason}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    });
  }

  // Step 3: 3 Claude Code CLI arms x 3 reps (sequential over shared local proxy)
  let ccSideStats = { sideCallsCount: 0, sideCallsCostUsd: 0 };
  if (!onlyApi) {
    const promptsSmall = JSON.parse(fs.readFileSync(path.join(EXPERIMENT_DIR, 'fixtures', 'prompts_small.json'), 'utf8'));
    const proxy = await startT6CcProxy({ keys, customRateCard });
    const ccArms = ['CC-T', 'CC-M', 'CC-S'];
    try {
      for (const arm of ccArms) {
        for (let rep = 1; rep <= 3; rep++) {
          if (completedKeys.has(`${arm}:r${rep}`)) continue;
          for (let attempt = 1; attempt <= 2; attempt++) {
            console.log(`[T6 CC] Running ${arm} rep=${rep} attempt=${attempt}...`);
            let res;
            try {
              res = await runCcArmRep({ arm, rep, promptsSmall, proxy, customRateCard, extraSecrets });
            } catch (err) {
              res = { ok: false, reason: err.message, rows: [] };
            }
            if (res.ok) {
              appendCheckpointRows(res.rows, `t6_ckpt_${arm}_r${rep}`);
              allRows.push(...res.rows);
              completedKeys.add(`${arm}:r${rep}`);
              const t5 = res.rows.find((r) => r.cli_turn === 5 && r.subcall_index === 1);
              const t6 = res.rows.find((r) => r.cli_turn === 6 && r.subcall_index === 1);
              const t7 = res.rows.find((r) => r.cli_turn === 7 && r.subcall_index === 1);
              const totCost = res.rows.reduce((s, r) => s + Number(r.billed_cost_usd || r.computed_cost_usd), 0);
              console.log(
                `[T6 CC] Done ${arm} rep=${rep}: T5read=${t5?.cache_read_tokens}, ` +
                `T6read=${t6?.cache_read_tokens} (${t6?.surviving_layers}), T7read=${t7?.cache_read_tokens}, total=$${totCost.toFixed(4)}`
              );
              break;
            }
            abortedRuns.push({ harness: 'claude_code_2.1.325', arm, rep, attempt, reason: res.reason });
            console.warn(`[T6 CC] Aborted ${arm} rep=${rep} attempt=${attempt}: ${res.reason}`);
            if (attempt >= 2) throw new Error(`T6 CC ${arm} rep=${rep} failed after retry: ${res.reason}`);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
      ccSideStats = proxy.getSideStats();
    } finally {
      await proxy.close();
    }
  }

  // Deterministic sort by harness, arm, rep, cli_turn, subcall_index
  const armOrder = ['C', 'TS', 'TF', 'TK', 'TA', 'SY', 'SRAG', 'MRAG', 'TSTUB', 'ME', 'CC-T', 'CC-M', 'CC-S'];
  allRows.sort((a, b) => {
    const ao = armOrder.indexOf(a.arm) - armOrder.indexOf(b.arm);
    if (ao !== 0) return ao;
    if (a.rep !== b.rep) return a.rep - b.rep;
    if (a.cli_turn !== b.cli_turn) return a.cli_turn - b.cli_turn;
    return a.subcall_index - b.subcall_index;
  });

  const csvPath = path.join(RESULTS_DIR, 't6_layers.csv');
  writeCsv(csvPath, T6_CSV_COLUMNS, allRows);

  const armSummaries = armOrder.map((arm) => {
    const armRows = allRows.filter((r) => r.arm === arm);
    const repNums = [...new Set(armRows.map((r) => r.rep))];
    const primaryAt = (turnNum) =>
      repNums.map((r) => armRows.find((x) => x.rep === r && x.cli_turn === turnNum && x.subcall_index === 1)).filter(Boolean);
    const t5Rows = primaryAt(5);
    const t6Rows = primaryAt(6);
    const t7Rows = primaryAt(7);
    const repTotals = repNums.map((r) =>
      armRows.filter((x) => x.rep === r).reduce((s, x) => s + Number(x.billed_cost_usd || x.computed_cost_usd), 0)
    );
    const t6Cost = t6Rows.map((x) => Number(x.billed_cost_usd || x.computed_cost_usd));
    const t5Prompt = t5Rows.map((x) => x.prompt_tokens);
    const t6Read = t6Rows.map((x) => x.cache_read_tokens);
    const t7Read = t7Rows.map((x) => x.cache_read_tokens);
    return {
      arm,
      harness: arm.startsWith('CC-') ? 'claude_code_2.1.325' : 'api',
      n: repNums.length,
      t5PromptTokens: summarizeMedianRange(t5Prompt),
      t6CacheReadTokens: summarizeMedianRange(t6Read),
      t7CacheReadTokens: summarizeMedianRange(t7Read),
      t6CostUsd: summarizeMedianRange(t6Cost),
      total12TurnCostUsd: summarizeMedianRange(repTotals),
      t6SurvivingLabels: t6Rows.map((x) => x.surviving_layers)
    };
  });

  const summaryPath = path.join(RESULTS_DIR, 't6_summary.json');
  const summaryJson = {
    generatedAtUtc: new Date().toISOString(),
    measuredLayerTokens: measured,
    ccProxySideCalls: ccSideStats,
    abortedRuns,
    armSummaries
  };
  const summaryStr = JSON.stringify(summaryJson, null, 2);
  assertNoSensitiveLeaks(summaryStr, 't6_summary.json', extraSecrets);
  fs.writeFileSync(summaryPath, summaryStr + '\n', 'utf8');

  console.log('\n=== T6 SUMMARY ===');
  for (const s of armSummaries) {
    console.log(
      `${s.arm} (n=${s.n}, ${s.harness}): T6read=${s.t6CacheReadTokens.median}[${s.t6CacheReadTokens.min}-${s.t6CacheReadTokens.max}], ` +
      `T7read=${s.t7CacheReadTokens.median}, T6cost=$${s.t6CostUsd.median?.toFixed(4)}, ` +
      `12turnTotal=$${s.total12TurnCostUsd.median?.toFixed(4)}, layers=${s.t6SurvivingLabels[0]}`
    );
  }
}

main().catch((err) => {
  console.error('[T6 FATAL]', err);
  process.exit(1);
});
