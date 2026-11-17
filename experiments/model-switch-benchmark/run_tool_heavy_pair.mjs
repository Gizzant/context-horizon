import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
import { activateLocalTrial } from '../../src/core/pro_license.mjs';

const PKG_META = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const PKG_BIN_NAME = String(PKG_META.name || '').trim();
const { installAttentionHorizon, ensureGitExcludeEntries } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'bin', `${PKG_BIN_NAME}.mjs`)).href
);

const FIXTURE_PATH = path.join(EXPERIMENT_DIR, 'fixtures', 'prompts_tool_heavy_12t.json');
const PREREG_PREDICTION = Object.freeze({
  experiment: 'item5_tool_heavy_paired_n1',
  sampleSizeNote: 'n=1 exploratory paired run; no statistical precision claim',
  switchBeforeTurn: 3,
  totalTurns: 12,
  postSwitchRemainingTurns: 9,
  ttlTier: '5m',
  providerPinned: 'anthropic',
  modelA: mapCliModelToOpenRouter(MODEL_A_CLI),
  modelB: mapCliModelToOpenRouter(MODEL_B_CLI),
  effort: EFFORT_BASELINE,
  predictedRequestsPerTurn: 5,
  allowedRBand: Object.freeze([3, 7]),
  maxSingleTurnRequests: 10,
  predictedHoldCostUsd: 0.9816,
  predictedAllowCostUsd: 0.6915,
  predictedDiffUsd: 0.2901,
  abortMultiplier: 2.0,
  abortCapHold2xUsd: 1.9632,
  abortCapAllow2xUsd: 1.3830
});

const PAIR_RUN_SPECS = Object.freeze([
  Object.freeze({
    runId: 'TH_hold_r01',
    arm: 'TH_hold',
    condition: 'hold_rule_v1',
    ruleVersion: 'rule_v1',
    rep: 1,
    turns: 12,
    initialModel: MODEL_A_CLI,
    targetModel: MODEL_B_CLI,
    switchBeforeTurn: 3,
    useEmpiricalHorizonPrior: false,
    expectedRemainingTurns: null,
    expectedDecision: 'ask_blocked',
    expectedFinalModel: MODEL_A_CLI,
    predictedCostUsd: PREREG_PREDICTION.predictedHoldCostUsd,
    abortCapUsd: PREREG_PREDICTION.abortCapHold2xUsd
  }),
  Object.freeze({
    runId: 'TH_allow_r01',
    arm: 'TH_allow',
    condition: 'allow_rule_v2_calibrated',
    ruleVersion: 'rule_v2_calibrated',
    rep: 1,
    turns: 12,
    initialModel: MODEL_A_CLI,
    targetModel: MODEL_B_CLI,
    switchBeforeTurn: 3,
    useEmpiricalHorizonPrior: true,
    expectedRemainingTurns: 9,
    expectedDecision: 'allow',
    expectedFinalModel: MODEL_B_CLI,
    predictedCostUsd: PREREG_PREDICTION.predictedAllowCostUsd,
    abortCapUsd: PREREG_PREDICTION.abortCapAllow2xUsd
  })
]);

function parseArgs(argv = []) {
  const flags = {
    live: false,
    mockDryRun: false,
    confirmSpend: false
  };
  for (const a of argv) {
    if (a === '--live') flags.live = true;
    else if (a === '--mock-dry-run') flags.mockDryRun = true;
    else if (a === '--confirm-spend') flags.confirmSpend = true;
  }
  if (flags.live && flags.mockDryRun) {
    throw new Error('Pass only one of --live or --mock-dry-run.');
  }
  if (!flags.live && !flags.mockDryRun) {
    flags.mockDryRun = true;
  }
  if (flags.live && !flags.confirmSpend) {
    throw new Error('Refusing live spend without explicit --confirm-spend flag.');
  }
  return flags;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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

function mean(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
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
          ? path.join(rtRoot, 'runs', 'tool_heavy_live')
          : path.join(tmpDir, 'model-switch-tool-heavy-dry-run-work')
      };
    }
  }
  throw new Error('Could not locate isolated CLI binary + frozen-repo under %TEMP%/*-model-switch-runtime');
}

function verifyRuntimeEnvironment(runtimePaths) {
  const verRes = spawnSync(runtimePaths.claudeExe, ['--version'], { encoding: 'utf8' });
  const versionOutput = String(verRes.stdout || verRes.stderr || '').trim();
  if (!versionOutput.includes(PINNED_CLAUDE_CODE_VERSION)) {
    throw new Error(`Unexpected CLI version "${versionOutput}"; expected ${PINNED_CLAUDE_CODE_VERSION}`);
  }
  const gitRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: runtimePaths.frozenRepoDir, encoding: 'utf8' });
  const actualCommit = String(gitRes.stdout || '').trim();
  if (actualCommit !== PINNED_REPO_COMMIT) {
    throw new Error(`Frozen repo HEAD ${actualCommit} !== expected ${PINNED_REPO_COMMIT}`);
  }
  return { versionOutput, actualCommit };
}

function resetFrozenRepoClean(frozenRepoDir) {
  const co = spawnSync('git', ['checkout', '-f', PINNED_REPO_COMMIT], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (co.status !== 0) throw new Error(`git checkout failed: ${co.stderr}`);
  const cl = spawnSync('git', ['clean', '-fdx'], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (cl.status !== 0) throw new Error(`git clean failed: ${cl.stderr}`);
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
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: frozenRepoDir, encoding: 'utf8' });
  if (st.status !== 0 || String(st.stdout || '').trim() !== '') {
    throw new Error(`Frozen repo is not clean after reset: ${st.stdout || st.stderr}`);
  }
}

async function fetchOpenRouterKeyUsage(apiKey) {
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /api/v1/key HTTP ${res.status}`);
  }
  const json = await res.json();
  const data = json?.data || {};
  const limit = typeof data.limit === 'number' ? data.limit : null;
  const usage = typeof data.usage === 'number' ? data.usage : null;
  const limitRemaining = typeof data.limit_remaining === 'number'
    ? data.limit_remaining
    : (limit !== null && usage !== null ? Number((limit - usage).toFixed(8)) : null);
  return {
    limit,
    usage,
    limitRemaining,
    fetchedAtUtc: new Date().toISOString()
  };
}

function setupIsolatedRunEnv(spec, runtimePaths) {
  const workRoot = path.join(runtimePaths.workDir, spec.runId);
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'claude_config');
  const settingsPath = path.join(workRoot, 'settings.json');
  const licensePath = path.join(homeDir, `.${PKG_BIN_NAME}`, 'license.json');
  const hookLogPath = path.join(workRoot, 'ah_interception_log.jsonl');
  const saltToken = crypto.createHash('sha256').update(`${spec.runId}_tool_heavy_${Date.now()}`).digest('hex').slice(0, 8);
  const systemInstruction = [
    `Benchmark-Run-Salt: ${spec.runId}_${saltToken}`,
    'STRICT SEQUENTIAL BENCHMARK PROTOCOL: Emit AT MOST ONE `Read` tool_use block per assistant message. NEVER batch parallel `Read` calls in a single response. Always read each requested file one at a time, wait for its tool result, and after the 4th result answer in 2 short bullets (<40 words).'
  ].join('\n');

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  activateLocalTrial({ homeDir, licensePath });
  const ahDir = path.join(homeDir, '.attention-horizon');
  fs.mkdirSync(ahDir, { recursive: true });
  fs.writeFileSync(
    path.join(ahDir, 'config.json'),
    JSON.stringify({
      flightMode: 'AUTO_PILOT',
      useEmpiricalHorizonPrior: Boolean(spec.useEmpiricalHorizonPrior),
      detectors: {
        'DET-06': 'off'
      },
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

  return { workRoot, homeDir, cfgDir, settingsPath, licensePath, hookLogPath, systemInstruction };
}

/**
 * $0 multi-step tool-use mock SSE server simulating exact R=5 (4 sequential Read tool_use
 * responses + 1 final end_turn summary) per prompt turn.
 */
async function startMockToolHeavyServer(wireLogPath, prompts, abortCapUsd) {
  let wireSeq = 0;
  let activeContext = null;
  let sessionCachedPrefix = 8000;
  let lastWireModel = null;
  let totalSpendUsd = 0;
  let budgetExceeded = false;
  const wireLogs = [];

  const server = http.createServer((req, res) => {
    const reqStartNs = process.hrtime.bigint();
    const timestamp = new Date().toISOString();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const urlPath = req.url || '/';
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }

      if (budgetExceeded || totalSpendUsd >= abortCapUsd) {
        budgetExceeded = true;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: `Mock budget cap $${abortCapUsd} exceeded` }
        }));
        return;
      }

      if (urlPath.includes('count_tokens')) {
        wireSeq += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: sessionCachedPrefix + 300 }));
        const sideRec = {
          wireSeq,
          timestamp,
          context: activeContext ? { ...activeContext } : null,
          urlPath,
          isSideCall: true,
          statusCode: 200,
          requestedModel: body.model || MODEL_A_CLI,
          mappedModel: mapCliModelToOpenRouter(body.model || MODEL_A_CLI),
          approxInputTokens: sessionCachedPrefix + 300,
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
      const messageId = `msg_01MOCK${String(wireSeq).padStart(14, '0')}`;

      const turnNum = Number(activeContext?.turn || 1);
      const promptSpec = prompts[turnNum - 1] || prompts[0];
      const files = Array.isArray(promptSpec?.files) ? promptSpec.files : [];

      const messages = Array.isArray(body.messages) ? body.messages : [];
      let lastHumanIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'user') continue;
        const c = m.content;
        const isToolResultTurn = Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
        if (!isToolResultTurn) {
          lastHumanIdx = i;
          break;
        }
      }
      const turnSlice = lastHumanIdx >= 0 ? messages.slice(lastHumanIdx + 1) : [];
      const assistantStepsSoFar = turnSlice.filter((m) => m?.role === 'assistant').length;
      const shouldCallTool = !isSideCall && assistantStepsSoFar < files.length;

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
        const isFirstMain = wireLogs.filter((w) => !w.isSideCall).length === 0;
        const switchedWire = lastWireModel !== null && lastWireModel !== requestedModel;
        const delta = shouldCallTool ? 420 : 120;
        const writeTok = isFirstMain || switchedWire ? sessionCachedPrefix + delta : delta;
        const readTok = isFirstMain || switchedWire ? 0 : sessionCachedPrefix;
        const outTok = shouldCallTool ? 85 : 95;
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
        }
      ];

      if (shouldCallTool) {
        const fileToRead = files[assistantStepsSoFar];
        const partialJson = JSON.stringify({ file_path: fileToRead, offset: 1, limit: 25 });
        evs.push(
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: `toolu_mock_t${turnNum}_${assistantStepsSoFar + 1}`,
              name: 'Read',
              input: {}
            }
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: partialJson }
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: rawUsage.output_tokens }
          },
          { type: 'message_stop' }
        );
      } else {
        evs.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '- Read all 4 slices sequentially.\n- Symbols verified (mock).' }
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: rawUsage.output_tokens }
          },
          { type: 'message_stop' }
        );
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));

      const latencyMs = Number(Number(process.hrtime.bigint() - reqStartNs) / 1e6).toFixed(2);
      const totalIn = rawUsage.input_tokens + rawUsage.cache_creation_input_tokens + rawUsage.cache_read_input_tokens;
      const costBreakdown = computeUsageCostUsd(requestedModel, rawUsage);
      if (!isSideCall) {
        totalSpendUsd += costBreakdown.totalCostUsd;
        if (totalSpendUsd >= abortCapUsd) budgetExceeded = true;
      }

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
        upstreamReportedCostUsd: isSideCall ? null : costBreakdown.totalCostUsd,
        usage: {
          ...rawUsage,
          ephemeral_5m_input_tokens: rawUsage.cache_creation.ephemeral_5m_input_tokens,
          ephemeral_1h_input_tokens: 0,
          total_input_tokens: totalIn,
          cache_hit_ratio: totalIn > 0 ? rawUsage.cache_read_input_tokens / totalIn : 0
        },
        cost: costBreakdown,
        cumulativeSpendUsd: Number(totalSpendUsd.toFixed(6)),
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
    wireLogPath,
    setContext(ctx) {
      activeContext = ctx ? { ...ctx } : null;
    },
    getState() {
      return { totalSpendUsd: Number(totalSpendUsd.toFixed(6)), budgetExceeded };
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

function sanitizeToolHeavyInPlace(outDir, runtimePaths) {
  const cpPath = path.join(outDir, 'raw', 'checkpoint.json');
  const cp = fs.existsSync(cpPath) ? JSON.parse(fs.readFileSync(cpPath, 'utf8')) : { runs: {} };

  const sessionIdMap = new Map();
  for (const [runId, meta] of Object.entries(cp.runs || {})) {
    if (meta?.sessionId && !String(meta.sessionId).startsWith('sess_')) {
      sessionIdMap.set(meta.sessionId, `sess_${runId}`);
    }
  }

  const msgIdMap = new Map();
  const wireLogs = readJsonl(path.join(outDir, 'raw', 'proxy_wire_log.jsonl'));
  const byGroup = new Map();
  for (const w of wireLogs) {
    if (!w.isSideCall && w.statusCode === 200 && w.context?.runId && w.context?.turn) {
      const k = `${w.context.runId}::T${w.context.turn}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(w);
    }
  }
  for (const [k, calls] of byGroup.entries()) {
    const [runId] = k.split('::');
    calls.sort((a, b) => a.wireSeq - b.wireSeq);
    calls.forEach((c, idx) => {
      if (c.messageId && !String(c.messageId).startsWith(`msg_${runId}`)) {
        const tPad = String(c.context.turn).padStart(2, '0');
        msgIdMap.set(c.messageId, `msg_${runId}_T${tPad}_r${idx + 1}`);
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

async function executeToolHeavyRun({
  spec,
  runIndex,
  totalRuns,
  envSetup,
  prompts,
  runtimePaths,
  serverHandle,
  wireLogPath,
  cliTurnsPath,
  interceptionsPath,
  transcriptsDir
}) {
  const startedAtUtc = new Date().toISOString();
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
  env.AH_INTERCEPTION_LOG_PATH = envSetup.hookLogPath;

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
    '--append-system-prompt', envSetup.systemInstruction,
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

  function waitForEventWithSafety(pred, currentTurn, timeoutMs = 240000, fromIndex = 0) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastSafetyCheck = 0;
      const iv = setInterval(() => {
        for (let i = fromIndex; i < events.length; i++) {
          if (pred(events[i], i)) {
            clearInterval(iv);
            resolve({ event: events[i], index: i });
            return;
          }
        }
        const now = Date.now();
        if (now - lastSafetyCheck >= 500) {
          lastSafetyCheck = now;
          const st = serverHandle.getState();
          if (st.budgetExceeded || st.totalSpendUsd > spec.abortCapUsd) {
            clearInterval(iv);
            try { child.kill('SIGKILL'); } catch {}
            reject(new Error(`ABORT_2X_ESTIMATE [${spec.runId} T${currentTurn}] spend=$${st.totalSpendUsd.toFixed(6)} > cap=$${spec.abortCapUsd}`));
            return;
          }
          const curWire = readJsonl(wireLogPath).filter((w) =>
            !w.isSideCall &&
            w.statusCode === 200 &&
            w.context?.runId === spec.runId &&
            w.context?.turn === currentTurn
          );
          if (curWire.length > PREREG_PREDICTION.maxSingleTurnRequests) {
            clearInterval(iv);
            try { child.kill('SIGKILL'); } catch {}
            reject(new Error(`ABORT_MAX_TURN_REQS [${spec.runId} T${currentTurn}] requests=${curWire.length} > max=${PREREG_PREDICTION.maxSingleTurnRequests}`));
            return;
          }
        }
        if (childClosed) {
          clearInterval(iv);
          reject(new Error(`[${spec.runId} T${currentTurn}] CLI exited early (${exitCode}): ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 400)}`));
        } else if (now - start > timeoutMs) {
          clearInterval(iv);
          try { child.kill('SIGKILL'); } catch {}
          reject(new Error(`[${spec.runId} T${currentTurn}] Timed out waiting for stream-json event`));
        }
      }, 25);
    });
  }

  let effectiveModel = spec.initialModel;
  let switchSummary = null;
  let completedResults = 0;
  const requestsPerTurn = [];

  try {
    for (let turn = 1; turn <= spec.turns; turn++) {
      let hookRecord = null;
      if (turn === spec.switchBeforeTurn) {
        const beforeSwitchEvtIdx = events.length;
        const reqId = `req_switch_T${turn}_${spec.runId}`;
        serverHandle.setContext({
          runId: spec.runId,
          arm: spec.arm,
          condition: spec.condition,
          ruleVersion: spec.ruleVersion,
          rep: spec.rep,
          turn,
          switchBeforeTurn: spec.switchBeforeTurn,
          phase: 'sdk_set_model'
        });
        child.stdin.write(JSON.stringify({
          type: 'control_request',
          request_id: reqId,
          request: { subtype: 'set_model', model: spec.targetModel }
        }) + '\n');

        const { event: ctrlEvent, index: ctrlIdx } = await waitForEventWithSafety(
          (e) => e.type === 'control_response' && e.response?.request_id === reqId,
          turn,
          30000,
          beforeSwitchEvtIdx
        );

        const sliceAfterSwitch = events.slice(beforeSwitchEvtIdx, ctrlIdx + 1);
        const hookResp = sliceAfterSwitch.find((e) => e.subtype === 'hook_response' && e.hook_event === 'PreModelSwitch') || null;
        let parsedHookJson = null;
        if (hookResp?.stdout) {
          try { parsedHookJson = JSON.parse(String(hookResp.stdout).trim()); } catch {}
        }
        const hookDiagRows = fs.existsSync(envSetup.hookLogPath) ? readJsonl(envSetup.hookLogPath) : [];
        const hookDiag = hookDiagRows.length > 0 ? hookDiagRows[hookDiagRows.length - 1] : null;
        const allowed = ctrlEvent.response?.subtype === 'success';
        if (allowed) effectiveModel = spec.targetModel;

        const permDecision = parsedHookJson?.hookSpecificOutput?.permissionDecision || hookDiag?.decision || (allowed ? 'allow' : 'ask');
        const reason = parsedHookJson?.systemMessage
          || parsedHookJson?.hookSpecificOutput?.permissionDecisionReason
          || parsedHookJson?.hookSpecificOutput?.additionalContext
          || hookDiag?.notableAllowNote
          || hookDiag?.reason
          || ctrlEvent.response?.error
          || '';

        hookRecord = {
          run_id: spec.runId,
          arm: spec.arm,
          condition: spec.condition,
          rule_version: spec.ruleVersion,
          rep: spec.rep,
          turn,
          scheduled_model: mapCliModelToOpenRouter(spec.targetModel),
          effective_model: mapCliModelToOpenRouter(effectiveModel),
          hook_event: hookResp ? 'PreModelSwitch' : 'none',
          hook_outcome: hookResp?.outcome || 'none',
          permission_decision: permDecision,
          control_subtype: ctrlEvent.response?.subtype || 'unknown',
          control_error_code: ctrlEvent.response?.error_code || '',
          turns_completed_used: hookDiag?.turnsCompletedUsed ?? '',
          api_calls_completed: hookDiag?.apiCallsCompleted ?? '',
          requests_per_turn: hookDiag?.requestsPerTurn ?? '',
          raw_rolling_median_rpt: hookDiag?.rawRollingMedianRequestsPerTurn ?? '',
          rpt_sample_size: hookDiag?.rptSampleSize ?? '',
          rpt_estimate_source: hookDiag?.rptEstimateSource ?? '',
          rolling_output_median_raw: hookDiag?.rawRollingMedianOutputTokens ?? '',
          rolling_output_sample_size: hookDiag?.outputSampleSize ?? '',
          expected_output_tokens: hookDiag?.expectedOutputTokens ?? '',
          prior_bucket: hookDiag?.priorBucket ?? '',
          horizon_prior_source: hookDiag?.horizonPriorSource ?? '',
          expected_remaining_turns: hookDiag?.expectedRemainingTurns ?? '',
          cold_write_penalty_usd: hookDiag?.coldWritePenaltyUSD ?? '',
          per_turn_saving_usd: hookDiag?.perTurnPostSwitchSavingUSD ?? '',
          payback_warm_requests: hookDiag?.paybackWarmRequests ?? '',
          payback_turns: hookDiag?.paybackTurns ?? '',
          context_tokens: hookDiag?.cachedTokens ?? '',
          horizon_net_savings_usd: hookDiag?.horizonNetSavingsUSD ?? '',
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

      const { event: resEvent } = await waitForEventWithSafety(
        (e) => e.type === 'result',
        turn,
        240000,
        beforeTurnIdx
      );
      completedResults += 1;
      const wallMs = Number((Number(process.hrtime.bigint() - turnStartNs) / 1e6).toFixed(2));
      if (resEvent.is_error) {
        throw new Error(`[${spec.runId} T${turn}] Turn returned result error: ${JSON.stringify(resEvent).slice(0, 400)}`);
      }

      const wireLines = readJsonl(wireLogPath);
      const okMain = wireLines.filter((w) =>
        !w.isSideCall &&
        w.statusCode === 200 &&
        w.context?.runId === spec.runId &&
        w.context?.turn === turn
      );
      if (okMain.length === 0) {
        throw new Error(`[${spec.runId} T${turn}] Completed turn with zero main API calls`);
      }

      requestsPerTurn.push({
        turn,
        requests: okMain.length,
        effectiveModel,
        wireModelsObserved: okMain.map((w) => w.responseModel || w.requestedModel)
      });

      const runBilledSoFar = wireLines
        .filter((w) => w.statusCode === 200 && w.context?.runId === spec.runId)
        .reduce((acc, w) => acc + Number(typeof w.upstreamReportedCostUsd === 'number' ? w.upstreamReportedCostUsd : (w.cost?.totalCostUsd || 0)), 0);

      if (runBilledSoFar > spec.abortCapUsd || serverHandle.getState().totalSpendUsd > spec.abortCapUsd) {
        throw new Error(
          `ABORT_2X_ESTIMATE [${spec.runId} T${turn}] spend billed=$${runBilledSoFar.toFixed(6)} computed=$${serverHandle.getState().totalSpendUsd.toFixed(6)} > cap=$${spec.abortCapUsd}`
        );
      }

      const lastMain = okMain[okMain.length - 1];
      const hitPct = (Number(lastMain.usage?.cache_hit_ratio || 0) * 100).toFixed(1);
      console.log(
        `[Run ${runIndex + 1}/${totalRuns} ${spec.runId}] T${turn}/${spec.turns} | eff=${effectiveModel.replace('claude-', '')} | R=${okMain.length} | hit=${hitPct}% | runSpend=$${runBilledSoFar.toFixed(4)} / cap=$${spec.abortCapUsd.toFixed(4)}`
      );

      fs.appendFileSync(cliTurnsPath, JSON.stringify({
        runId: spec.runId,
        arm: spec.arm,
        condition: spec.condition,
        ruleVersion: spec.ruleVersion,
        rep: spec.rep,
        turn,
        sessionId: resEvent.session_id || null,
        effectiveModel,
        requestsInTurn: okMain.length,
        wireModelsObserved: okMain.map((w) => w.responseModel || w.requestedModel),
        wallMs,
        totalCostUsd: resEvent.total_cost_usd ?? null,
        switchHook: hookRecord
      }) + '\n', 'utf8');

      // Early Turn-2 R in [3, 7] guard
      if (turn === 2) {
        const earlyMeanR = (requestsPerTurn[0].requests + requestsPerTurn[1].requests) / 2;
        if (earlyMeanR < PREREG_PREDICTION.allowedRBand[0] || earlyMeanR > PREREG_PREDICTION.allowedRBand[1]) {
          throw new Error(
            `ABORT_R_OUT_OF_BAND_EARLY [${spec.runId} T1-T2] mean R=${earlyMeanR.toFixed(2)} outside [${PREREG_PREDICTION.allowedRBand[0]}, ${PREREG_PREDICTION.allowedRBand[1]}]`
          );
        }
      }
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

  const finishedAtUtc = new Date().toISOString();
  const sessionEvent = events.find((e) => e.session_id);
  const sessionId = sessionEvent?.session_id || null;
  const jsonls = findSessionJsonlFiles(envSetup.cfgDir);
  if (jsonls.length > 0) {
    const mainFile = jsonls.find((p) => sessionId && p.includes(sessionId)) || jsonls[0];
    fs.mkdirSync(transcriptsDir, { recursive: true });
    fs.copyFileSync(mainFile, path.join(transcriptsDir, `${spec.runId}.jsonl`));
  }

  const allWire = readJsonl(wireLogPath);
  const runAllWire = allWire.filter((w) => w.statusCode === 200 && w.context?.runId === spec.runId);
  const runMainWire = runAllWire.filter((w) => !w.isSideCall);
  const rCounts = requestsPerTurn.map((x) => x.requests);
  const meanR = mean(rCounts);
  const medianR = median(rCounts);
  const minR = Math.min(...rCounts);
  const maxR = Math.max(...rCounts);

  if (
    meanR < PREREG_PREDICTION.allowedRBand[0] ||
    meanR > PREREG_PREDICTION.allowedRBand[1] ||
    medianR < PREREG_PREDICTION.allowedRBand[0] ||
    medianR > PREREG_PREDICTION.allowedRBand[1]
  ) {
    throw new Error(
      `ABORT_R_OUT_OF_BAND [${spec.runId} T1-T12] meanR=${meanR.toFixed(2)}, medianR=${medianR} outside [${PREREG_PREDICTION.allowedRBand[0]}, ${PREREG_PREDICTION.allowedRBand[1]}]`
    );
  }

  const totalMainComputed = Number(runMainWire.reduce((a, w) => a + Number(w.cost?.totalCostUsd || 0), 0).toFixed(6));
  const hasAllMainBilled = runMainWire.length > 0 && runMainWire.every((w) => typeof w.upstreamReportedCostUsd === 'number');
  const totalMainBilled = hasAllMainBilled
    ? Number(runMainWire.reduce((a, w) => a + w.upstreamReportedCostUsd, 0).toFixed(6))
    : null;
  const totalAllBilled = Number(runAllWire.reduce((a, w) => a + Number(typeof w.upstreamReportedCostUsd === 'number' ? w.upstreamReportedCostUsd : (w.cost?.totalCostUsd || 0)), 0).toFixed(6));
  const finalWireModel = runMainWire[runMainWire.length - 1]?.requestedModel || null;

  if (finalWireModel !== spec.expectedFinalModel) {
    throw new Error(
      `UNEXPECTED_FINAL_MODEL [${spec.runId}] got wire model "${finalWireModel}", expected "${spec.expectedFinalModel}"`
    );
  }

  return {
    runId: spec.runId,
    arm: spec.arm,
    condition: spec.condition,
    ruleVersion: spec.ruleVersion,
    rep: spec.rep,
    startedAtUtc,
    finishedAtUtc,
    turnsCompleted: completedResults,
    sessionId,
    switchSummary,
    requestsPerTurn,
    meanR: Number(meanR.toFixed(4)),
    medianR,
    minR,
    maxR,
    mainReqs: runMainWire.length,
    sideReqs: runAllWire.length - runMainWire.length,
    turnBeforeSwitchWireModel: runMainWire.find((w) => w.context?.turn === spec.switchBeforeTurn - 1)?.requestedModel || null,
    turnAtSwitchWireModel: runMainWire.find((w) => w.context?.turn === spec.switchBeforeTurn)?.requestedModel || null,
    finalTurnWireModel: finalWireModel,
    totalMainComputedUsd: totalMainComputed,
    totalMainBilledUsd: totalMainBilled,
    totalAllWireBilledUsd: totalAllBilled
  };
}

function writePreregistrationFiles(outDir, modeLabel, balanceBefore) {
  fs.mkdirSync(outDir, { recursive: true });
  const preregObj = {
    ...PREREG_PREDICTION,
    mode: modeLabel,
    preregisteredAtUtc: new Date().toISOString(),
    openrouterBefore: balanceBefore
  };
  fs.writeFileSync(path.join(outDir, 'preregistration_tool_heavy.json'), JSON.stringify(preregObj, null, 2) + '\n', 'utf8');

  const md = [
    '# Item 5 Pre-Registration — Tool-Heavy Paired Run (`n = 1` Exploratory)',
    '',
    `- **Pre-registered At (UTC):** \`${preregObj.preregisteredAtUtc}\``,
    `- **Mode:** \`${modeLabel}\``,
    `- **Sample Size Disclaimer:** \`${PREREG_PREDICTION.sampleSizeNote}\``,
    `- **Design:** \`12\` turns, switch scheduled before \`T${PREREG_PREDICTION.switchBeforeTurn}\` (\`postSwitchRemainingTurns = ${PREREG_PREDICTION.postSwitchRemainingTurns}\`), \`${PREREG_PREDICTION.modelA} -> ${PREREG_PREDICTION.modelB}\`, effort \`${PREREG_PREDICTION.effort}\`, \`${PREREG_PREDICTION.ttlTier}\` cache TTL, upstream provider pinned to \`${PREREG_PREDICTION.providerPinned}\`.`,
    `- **Predicted \`requests/turn\`:** \`${PREREG_PREDICTION.predictedRequestsPerTurn}\` (acceptable band: \`[${PREREG_PREDICTION.allowedRBand[0]}, ${PREREG_PREDICTION.allowedRBand[1]}]\`, hard max/turn: \`${PREREG_PREDICTION.maxSingleTurnRequests}\`).`,
    `- **Predicted Cost (\`TH_hold_r01\`):** \`$${PREREG_PREDICTION.predictedHoldCostUsd.toFixed(4)}\` (hard \`2x\` abort cap: \`$${PREREG_PREDICTION.abortCapHold2xUsd.toFixed(4)}\`).`,
    `- **Predicted Cost (\`TH_allow_r01\`):** \`$${PREREG_PREDICTION.predictedAllowCostUsd.toFixed(4)}\` (hard \`2x\` abort cap: \`$${PREREG_PREDICTION.abortCapAllow2xUsd.toFixed(4)}\`).`,
    `- **Predicted Difference (\`hold - allow\`):** \`+$${PREREG_PREDICTION.predictedDiffUsd.toFixed(4)}\` (\`~$0.30\` saved by allowing switch at T3 under tool-heavy \`R = 5\`).`,
    `- **OpenRouter Key Before Run:** ${balanceBefore ? `balance \`$${balanceBefore.limitRemaining?.toFixed(6)}\`, usage \`$${balanceBefore.usage?.toFixed(8)}\`, limit \`$${balanceBefore.limit?.toFixed(2)}\`` : 'N/A (mock dry-run)'}`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'preregistration_tool_heavy.md'), md + '\n', 'utf8');
  return preregObj;
}

function buildCsvAndSummary(outDir, modeLabel, preregObj, runSummaries, balanceAfter) {
  const rawDir = path.join(outDir, 'raw');
  const wireLogs = readJsonl(path.join(rawDir, 'proxy_wire_log.jsonl'));
  const interceptions = readJsonl(path.join(rawDir, 'interceptions_live.jsonl'));
  const transcriptsDir = path.join(rawDir, 'transcripts');

  const transcriptMaps = new Map();
  for (const r of runSummaries) {
    transcriptMaps.set(r.runId, parseTranscriptUsageMap(path.join(transcriptsDir, `${r.runId}.jsonl`)));
  }

  // Group main wire calls per run/turn to fill request_index_in_turn and requests_in_turn
  const byRunTurn = new Map();
  for (const w of wireLogs) {
    if (w.statusCode !== 200 || !w.context?.runId) continue;
    if (!w.isSideCall && w.context.turn) {
      const k = `${w.context.runId}::${w.context.turn}`;
      if (!byRunTurn.has(k)) byRunTurn.set(k, []);
      byRunTurn.get(k).push(w);
    }
  }
  const reqIdxMap = new Map();
  for (const [, list] of byRunTurn.entries()) {
    list.sort((a, b) => a.wireSeq - b.wireSeq);
    list.forEach((w, idx) => reqIdxMap.set(w.wireSeq, { idx: idx + 1, total: list.length }));
  }

  const runHeaders = [
    'run_id', 'arm', 'condition', 'rule_version', 'rep', 'session_id', 'turn',
    'request_index_in_turn', 'requests_in_turn', 'is_side_call', 'model', 'effort',
    'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens',
    'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens', 'cache_hit_ratio',
    'cost_usd', 'cost_label', 'upstream_reported_cost_usd', 'computed_cost_usd',
    'latency_ms', 'ttfb_ms', 'source', 'notes'
  ];
  const runRows = [runHeaders.join(',')];
  for (const w of wireLogs) {
    if (w.statusCode !== 200 || !w.context?.runId) continue;
    const tMap = transcriptMaps.get(w.context.runId) || new Map();
    const tx = w.messageId ? tMap.get(w.messageId) : null;
    const u = w.usage || {};
    const ri = reqIdxMap.get(w.wireSeq) || { idx: 1, total: 1 };
    const billed = typeof w.upstreamReportedCostUsd === 'number' ? w.upstreamReportedCostUsd : null;
    const comp = typeof w.cost?.totalCostUsd === 'number' ? w.cost.totalCostUsd : null;
    const primaryCost = billed !== null ? billed : comp;
    const costLabel = billed !== null ? 'billed' : 'computed';
    const src = tx ? 'both' : 'proxy';
    runRows.push([
      w.context.runId,
      w.context.arm,
      w.context.condition,
      w.context.ruleVersion,
      w.context.rep ?? 1,
      `sess_${w.context.runId}`,
      w.context.turn ?? '',
      ri.idx,
      ri.total,
      Boolean(w.isSideCall),
      w.responseModel || w.mappedModel || w.requestedModel,
      w.context.scheduledEffort || EFFORT_BASELINE,
      u.input_tokens ?? '',
      u.cache_creation_input_tokens ?? '',
      u.cache_read_input_tokens ?? '',
      u.output_tokens ?? '',
      u.ephemeral_5m_input_tokens ?? '',
      u.ephemeral_1h_input_tokens ?? '',
      typeof u.cache_hit_ratio === 'number' ? u.cache_hit_ratio.toFixed(6) : '',
      primaryCost !== null ? primaryCost.toFixed(6) : '',
      costLabel,
      billed !== null ? billed.toFixed(6) : '',
      comp !== null ? comp.toFixed(6) : '',
      w.timing?.latencyMs ?? '',
      w.timing?.ttfbMs ?? '',
      src,
      w.isSideCall ? 'side_call' : ''
    ].map(escapeCsv).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'runs_tool_heavy.csv'), runRows.join('\n') + '\n', 'utf8');

  const hookHeaders = [
    'run_id', 'arm', 'condition', 'rule_version', 'rep', 'turn',
    'scheduled_model', 'effective_model', 'hook_event', 'hook_outcome',
    'permission_decision', 'control_subtype', 'control_error_code',
    'turns_completed_used', 'api_calls_completed', 'requests_per_turn',
    'raw_rolling_median_rpt', 'rpt_sample_size', 'rpt_estimate_source',
    'rolling_output_median_raw', 'rolling_output_sample_size', 'expected_output_tokens',
    'prior_bucket', 'horizon_prior_source', 'expected_remaining_turns',
    'cold_write_penalty_usd', 'per_turn_saving_usd', 'payback_warm_requests',
    'payback_turns', 'context_tokens', 'horizon_net_savings_usd', 'notable_allow_note', 'reason'
  ];
  const hookRows = [hookHeaders.join(',')];
  for (const h of interceptions) {
    hookRows.push(hookHeaders.map((k) => escapeCsv(h[k])).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'interceptions_tool_heavy.csv'), hookRows.join('\n') + '\n', 'utf8');

  const hold = runSummaries.find((r) => r.runId === 'TH_hold_r01');
  const allow = runSummaries.find((r) => r.runId === 'TH_allow_r01');
  const holdCost = hold?.totalMainBilledUsd ?? hold?.totalMainComputedUsd ?? 0;
  const allowCost = allow?.totalMainBilledUsd ?? allow?.totalMainComputedUsd ?? 0;
  const measuredDiff = Number((holdCost - allowCost).toFixed(6));
  const totalAllBilled = Number(((hold?.totalAllWireBilledUsd || 0) + (allow?.totalAllWireBilledUsd || 0)).toFixed(6));
  const keyDelta = preregObj.openrouterBefore && balanceAfter
    ? Number((balanceAfter.usage - preregObj.openrouterBefore.usage).toFixed(6))
    : null;

  const summary = {
    mode: modeLabel,
    sampleSizeNote: PREREG_PREDICTION.sampleSizeNote,
    preregisteredAtUtc: preregObj.preregisteredAtUtc,
    predicted: {
      requestsPerTurn: PREREG_PREDICTION.predictedRequestsPerTurn,
      holdCostUsd: PREREG_PREDICTION.predictedHoldCostUsd,
      allowCostUsd: PREREG_PREDICTION.predictedAllowCostUsd,
      diffUsd: PREREG_PREDICTION.predictedDiffUsd
    },
    measured: {
      holdCostUsd: holdCost,
      allowCostUsd: allowCost,
      diffUsd: measuredDiff,
      totalAllWireBilledUsd: totalAllBilled,
      keyDeltaUsd: keyDelta,
      reconciliationGapUsd: keyDelta !== null ? Number((totalAllBilled - keyDelta).toFixed(6)) : null
    },
    openrouterBefore: preregObj.openrouterBefore,
    openrouterAfter: balanceAfter,
    runs: runSummaries
  };
  fs.writeFileSync(path.join(outDir, 'summary_tool_heavy.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const turnTable = [
    '| Turn | `TH_hold_r01` reqs/turn (`model`) | `TH_allow_r01` reqs/turn (`model`) |',
    '|---:|---|---|'
  ];
  for (let t = 1; t <= 12; t++) {
    const hT = hold?.requestsPerTurn?.find((x) => x.turn === t);
    const aT = allow?.requestsPerTurn?.find((x) => x.turn === t);
    turnTable.push(`| T${t} | \`${hT?.requests ?? ''}\` (\`${hT?.effectiveModel?.replace('claude-', '') || ''}\`) | \`${aT?.requests ?? ''}\` (\`${aT?.effectiveModel?.replace('claude-', '') || ''}\`) |`);
  }

  const md = [
    '# Item 5 Summary — Exploratory Tool-Heavy Paired Run (`n = 1`)',
    '',
    `> **Sample-size disclaimer:** \`${PREREG_PREDICTION.sampleSizeNote}\` Single paired run (\`n = 1\` hold vs \`n = 1\` allow); do not extrapolate point precision.`,
    '',
    `- **Mode:** \`${modeLabel}\``,
    `- **Pre-registered At (UTC):** \`${preregObj.preregisteredAtUtc}\``,
    `- **Run 1 (\`TH_hold_r01\`) Started At (UTC):** \`${hold?.startedAtUtc}\` | **Final Model:** \`${hold?.finalTurnWireModel}\` | **Mean / Median R:** \`${hold?.meanR} / ${hold?.medianR}\` (min \`${hold?.minR}\`, max \`${hold?.maxR}\`)`,
    `- **Run 2 (\`TH_allow_r01\`) Started At (UTC):** \`${allow?.startedAtUtc}\` | **Final Model:** \`${allow?.finalTurnWireModel}\` | **Mean / Median R:** \`${allow?.meanR} / ${allow?.medianR}\` (min \`${allow?.minR}\`, max \`${allow?.maxR}\`)`,
    `- **Predicted (\`hold\` / \`allow\` / \`diff\`):** \`$${PREREG_PREDICTION.predictedHoldCostUsd.toFixed(4)}\` / \`$${PREREG_PREDICTION.predictedAllowCostUsd.toFixed(4)}\` / \`+$${PREREG_PREDICTION.predictedDiffUsd.toFixed(4)}\` at \`R = ${PREREG_PREDICTION.predictedRequestsPerTurn}\``,
    `- **Billed Main (\`hold\` / \`allow\` / \`diff\`):** \`$${holdCost.toFixed(6)}\` / \`$${allowCost.toFixed(6)}\` / \`+$${measuredDiff.toFixed(6)}\``,
    `- **All-Wire Billed Sum:** \`$${totalAllBilled.toFixed(6)}\``,
    `- **OpenRouter \`/api/v1/key\`:** before \`$${preregObj.openrouterBefore?.limitRemaining?.toFixed(6) ?? 'N/A'}\` (usage \`$${preregObj.openrouterBefore?.usage?.toFixed(8) ?? 'N/A'}\`), after \`$${balanceAfter?.limitRemaining?.toFixed(6) ?? 'N/A'}\` (usage \`$${balanceAfter?.usage?.toFixed(8) ?? 'N/A'}\`), immediate delta \`$${keyDelta?.toFixed(6) ?? 'N/A'}\``,
    '',
    '## Per-Turn Requests/Turn (`T1..T12`)',
    '',
    ...turnTable,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary_tool_heavy.md'), md + '\n', 'utf8');
  return summary;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const modeLabel = flags.live ? 'live' : 'mock_dry_run';
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const prompts = fixture.prompts || [];
  if (prompts.length !== 12) {
    throw new Error(`Expected 12 prompts in ${FIXTURE_PATH}, got ${prompts.length}`);
  }

  const runtimePaths = resolveRuntimePaths(flags.live);
  const envInfo = verifyRuntimeEnvironment(runtimePaths);
  const outDir = flags.live
    ? path.join(EXPERIMENT_DIR, 'results', 'round2_c2', 'tool_heavy')
    : path.join(os.tmpdir(), 'model-switch-tool-heavy-dry-run-out');

  fs.rmSync(outDir, { recursive: true, force: true });
  const rawDir = path.join(outDir, 'raw');
  const transcriptsDir = path.join(rawDir, 'transcripts');
  const wireLogPath = path.join(rawDir, 'proxy_wire_log.jsonl');
  const cliTurnsPath = path.join(rawDir, 'cli_turns.jsonl');
  const interceptionsPath = path.join(rawDir, 'interceptions_live.jsonl');
  const checkpointPath = path.join(rawDir, 'checkpoint.json');
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const apiKey = flags.live ? loadOpenRouterApiKey() : null;
  const balanceBefore = flags.live ? await fetchOpenRouterKeyUsage(apiKey) : null;
  const preregObj = writePreregistrationFiles(outDir, modeLabel, balanceBefore);

  console.log(
    JSON.stringify({
      phase: 'PREREGISTERED',
      mode: modeLabel,
      cliVersion: envInfo.versionOutput,
      frozenCommit: envInfo.actualCommit,
      preregisteredAtUtc: preregObj.preregisteredAtUtc,
      predictedHoldUsd: PREREG_PREDICTION.predictedHoldCostUsd,
      predictedAllowUsd: PREREG_PREDICTION.predictedAllowCostUsd,
      predictedDiffUsd: PREREG_PREDICTION.predictedDiffUsd,
      predictedRequestsPerTurn: PREREG_PREDICTION.predictedRequestsPerTurn,
      balanceBeforeUsd: balanceBefore?.limitRemaining ?? null
    })
  );

  const checkpoint = { mode: modeLabel, runs: {} };
  const runSummaries = [];

  for (let i = 0; i < PAIR_RUN_SPECS.length; i++) {
    const spec = PAIR_RUN_SPECS[i];
    resetFrozenRepoClean(runtimePaths.frozenRepoDir);
    const envSetup = setupIsolatedRunEnv(spec, runtimePaths);
    const serverHandle = flags.live
      ? await startProxyServer({
          port: 0,
          upstreamBaseUrl: 'https://openrouter.ai',
          upstreamApiPrefix: '/api',
          apiKey,
          maxBudgetUsd: spec.abortCapUsd,
          wireLogPath,
          pinProvider: true
        })
      : await startMockToolHeavyServer(wireLogPath, prompts, spec.abortCapUsd);

    try {
      const summary = await executeToolHeavyRun({
        spec,
        runIndex: i,
        totalRuns: PAIR_RUN_SPECS.length,
        envSetup,
        prompts,
        runtimePaths,
        serverHandle,
        wireLogPath,
        cliTurnsPath,
        interceptionsPath,
        transcriptsDir
      });
      runSummaries.push(summary);
      checkpoint.runs[spec.runId] = {
        status: 'completed',
        sessionId: summary.sessionId,
        meanR: summary.meanR,
        medianR: summary.medianR,
        finalModel: summary.finalTurnWireModel,
        totalMainBilledUsd: summary.totalMainBilledUsd,
        totalMainComputedUsd: summary.totalMainComputedUsd
      };
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
    } finally {
      await serverHandle.close();
    }
  }

  const balanceAfter = flags.live ? await fetchOpenRouterKeyUsage(apiKey) : null;
  const finalSummary = buildCsvAndSummary(outDir, modeLabel, preregObj, runSummaries, balanceAfter);
  sanitizeToolHeavyInPlace(outDir, runtimePaths);

  console.log(JSON.stringify({ status: 'TOOL_HEAVY_PAIR_COMPLETE', outDir, ...finalSummary }, null, 2));
}

main().catch((err) => {
  console.error(`[TOOL_HEAVY_PAIR_ERROR] ${err?.stack || err}`);
  process.exit(1);
});
