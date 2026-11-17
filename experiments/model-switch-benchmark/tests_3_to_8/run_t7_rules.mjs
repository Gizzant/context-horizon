#!/usr/bin/env node
/**
 * T7: Rule Stuffing Accuracy Sweep (Option 7B)
 *
 * - API sweep (OpenRouter, anthropic/claude-sonnet-4.6):
 *     S in {10, 50, 100, 250, 500} x 3 seeds (ALPHA, BRAVO, CHARLIE) x 20 probes = 300 calls
 *     Static system prompt cached once per (S, seed) block; independent single-turn probes
 * - Optional CLAUDE.md check (Claude Code 2.1.325 via local OpenRouter proxy):
 *     S in {10, 100, 500} x seed ALPHA x 20 fresh headless tasks (n=1, 60 calls)
 * - Deterministic per-probe evaluation:
 *     Checks the 5 triggered rules (passed_rules / 5, strict_all_passed)
 * - Checkpoints every completed (harness, S, seed) group to results/raw/t7_checkpoint_rows.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import {
  STANDARD_CSV_COLUMNS,
  RESULTS_DIR,
  createRepNonce,
  injectNonceAndBreakpoints,
  loadBenchmarkKeys,
  loadRateCard,
  sendMessagesCall,
  RunBudgetTracker,
  summarizeMedianRange,
  wilson95,
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
import { parseSseTranscript } from '../proxy_recorder.mjs';
import {
  SEEDS,
  build20Probes,
  buildInterleavedRulebook,
  evaluateProbeResponse
} from './rules_500_catalog.mjs';

const CHECKPOINT_PATH = path.join(RESULTS_DIR, 'raw', 't7_checkpoint_rows.jsonl');
const CSV_OUT_PATH = path.join(RESULTS_DIR, 't7_rules.csv');
const SUMMARY_OUT_PATH = path.join(RESULTS_DIR, 't7_summary.json');

const API_S_VALUES = [10, 50, 100, 250, 500];
const CC_S_VALUES = [10, 100, 500];

const T7_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'harness',
  'rule_count_s',
  'seed_name',
  'probe_index',
  'active_rules',
  'passed_rules_count',
  'total_active_rules',
  'strict_all_passed',
  'per_rule_json',
  'group_key'
];

function getExtraSecrets(keys) {
  return [
    keys.OPENROUTER_API_KEY,
    keys.ANTHROPIC_API_KEY,
    keys.GEMINI_BENCHMARK_API_KEY,
    keys.ENV_GEMINI_API_KEY
  ].filter(Boolean);
}

function loadCheckpoints() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return [];
  const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      // Ignore truncated line
    }
  }
  return entries;
}

function appendCheckpoint(entry, extraSecrets) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  const serialized = JSON.stringify(entry);
  assertNoSensitiveLeaks(serialized, 't7_checkpoint_entry', extraSecrets);
  fs.appendFileSync(CHECKPOINT_PATH, `${serialized}\n`, 'utf8');
}

async function runApiGroup({ S, seedObj, probes, customRateCard, budgetTracker, extraSecrets }) {
  const { seed, name: seedName } = seedObj;
  const groupKey = `API|S${S}|${seedName}`;
  const nonce = createRepNonce(`t7_api_s${S}_${seedName}`);
  const { rulebookText, activeRulePositions } = buildInterleavedRulebook({
    S,
    seedName,
    extraOffset: (seed - 1) * 17
  });

  const rows = [];
  let aborted = false;

  console.log(`[T7 API] Running ${groupKey} (20 probes)...`);
  for (const probe of probes) {
    const built = injectNonceAndBreakpoints({
      nonce,
      tools: [],
      system: [{ type: 'text', text: rulebookText }],
      messages: [{ role: 'user', content: probe.userPrompt }],
      breakpointLayers: ['system'],
      omitMessageBreakpoint: true
    });

    const res = await sendMessagesCall({
      test: 'T7',
      arm: `API_S${S}`,
      rep: seed,
      turn: probe.probeIndex,
      route: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      system: built.system,
      messages: built.messages,
      max_tokens: 400,
      stream: true,
      nonceId: nonce,
      customRateCard,
      budgetTracker
    });

    if (res.row.http_status !== 200) {
      aborted = true;
      rows.push({
        ...res.row,
        harness: 'api',
        rule_count_s: S,
        seed_name: seedName,
        probe_index: probe.probeIndex,
        active_rules: probe.activeCodes.join(','),
        passed_rules_count: 0,
        total_active_rules: 5,
        strict_all_passed: false,
        per_rule_json: '{}',
        group_key: groupKey
      });
      console.error(`[T7 API] ABORT ${groupKey} probe=${probe.probeIndex}: HTTP ${res.row.http_status} ${res.row.error_text}`);
      break;
    }

    const ev = evaluateProbeResponse({
      seedName,
      activeDims: probe.activeDims,
      responseText: res.assistantText
    });

    rows.push({
      ...res.row,
      harness: 'api',
      rule_count_s: S,
      seed_name: seedName,
      probe_index: probe.probeIndex,
      active_rules: probe.activeCodes.join(','),
      passed_rules_count: ev.passedCount,
      total_active_rules: ev.totalActive,
      strict_all_passed: ev.strictAllPassed,
      per_rule_json: JSON.stringify(ev.perRule),
      group_key: groupKey
    });
  }

  const strictPasses = rows.filter((r) => r.strict_all_passed).length;
  const totalRuleChecks = rows.length * 5;
  const rulePasses = rows.reduce((a, r) => a + r.passed_rules_count, 0);
  const groupCostUsd = Number(rows.reduce((a, r) => a + (r.billed_cost_usd ?? r.computed_cost_usd ?? 0), 0).toFixed(6));

  console.log(`[T7 API] Done ${groupKey}: strict=${strictPasses}/${rows.length} rules=${rulePasses}/${totalRuleChecks} cost=$${groupCostUsd} p1_write=${rows[0]?.cache_write_tokens} p2_read=${rows[1]?.cache_read_tokens}`);

  const entry = {
    groupKey,
    harness: 'api',
    S,
    seed,
    seedName,
    activeRulePositions,
    aborted,
    rows,
    groupCostUsd,
    strictPasses,
    rulePasses,
    totalProbes: rows.length,
    totalRuleChecks
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

function startT7CcProxy({ apiKey, customRateCard, mockOnly = false }) {
  const upstreamUrl = new URL('https://openrouter.ai/api');
  const captures = [];

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      let reqJson = {};
      try {
        reqJson = JSON.parse(rawBody.toString('utf8'));
      } catch {
        reqJson = {};
      }

      if (mockOnly) {
        const sysText = JSON.stringify(reqJson.system || '');
        const msg0Text = JSON.stringify(reqJson.messages?.[0] || '');
        captures.push({
          path: reqUrl.pathname,
          model: reqJson.model,
          toolsCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
          hasClaudeMdInMessages: /FOLLOW ALL APPLICABLE CONDITIONAL RULES/.test(msg0Text),
          hasClaudeMdInSystem: /FOLLOW ALL APPLICABLE CONDITIONAL RULES/.test(sysText),
          stream: Boolean(reqJson.stream)
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: reqJson.model,
          content: [{ type: 'text', text: 'REC_ALPHA: mock check done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 6 }
        }));
        return;
      }

      const targetModel = mapCliModelToOpenRouter(reqJson.model || 'claude-sonnet-4-6');
      const forwardObj = {
        ...reqJson,
        model: targetModel,
        provider: { only: ['anthropic'], allow_fallbacks: false },
        usage: { include: true }
      };
      const forwardBuf = Buffer.from(JSON.stringify(forwardObj), 'utf8');
      const headers = {
        'content-type': 'application/json',
        'content-length': forwardBuf.length,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        accept: req.headers.accept || 'text/event-stream'
      };
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];

      const basePath = upstreamUrl.pathname.replace(/\/$/, '');
      const fullPath = `${basePath}${reqUrl.pathname}${reqUrl.search}`;
      const tStart = new Date().toISOString();
      const t0 = Date.now();
      let tFirstByte = '';

      const upReq = https.request(
        {
          hostname: upstreamUrl.hostname,
          port: 443,
          path: fullPath,
          method: req.method,
          headers
        },
        (upRes) => {
          const outChunks = [];
          const fwdHeaders = { ...upRes.headers };
          delete fwdHeaders['content-length'];
          delete fwdHeaders['transfer-encoding'];
          res.writeHead(upRes.statusCode || 502, fwdHeaders);

          upRes.on('data', (chunk) => {
            if (!tFirstByte) tFirstByte = new Date().toISOString();
            outChunks.push(chunk);
            res.write(chunk);
          });
          upRes.on('end', () => {
            res.end();
            const tEnd = new Date().toISOString();
            const rawText = Buffer.concat(outChunks).toString('utf8');
            const ctype = String(upRes.headers['content-type'] || '');
            let normUsage = normalizeUsage({});
            let rawUsageObj = {};
            let stopReason = '';
            let respModel = targetModel;

            if (ctype.includes('text/event-stream')) {
              const parsed = parseSseTranscript(rawText);
              rawUsageObj = parsed.usage || {};
              normUsage = normalizeUsage(rawUsageObj);
              stopReason = parsed.stopReason || '';
              respModel = parsed.model || targetModel;
            } else {
              try {
                const j = JSON.parse(rawText);
                rawUsageObj = j.usage || {};
                normUsage = normalizeUsage(rawUsageObj);
                stopReason = j.stop_reason || '';
                respModel = j.model || targetModel;
              } catch {
                // ignore
              }
            }

            const billed = typeof rawUsageObj.cost === 'number' ? rawUsageObj.cost : null;
            const computed = computeUsageCostExt(respModel, {
              uncached_input_tokens: normUsage.uncached_input_tokens,
              cache_read_tokens: normUsage.cache_read_tokens,
              cache_write_5m_tokens: rawUsageObj.cache_creation?.ephemeral_5m_input_tokens ?? normUsage.cache_write_tokens,
              cache_write_1h_tokens: rawUsageObj.cache_creation?.ephemeral_1h_input_tokens ?? 0,
              output_tokens: normUsage.output_tokens
            }, customRateCard);

            captures.push({
              path: reqUrl.pathname,
              statusCode: upRes.statusCode || 0,
              model: respModel,
              rawUsageObj,
              normUsage,
              billedCostUsd: billed,
              computedCostUsd: computed,
              stopReason,
              tStart,
              tFirstByte: tFirstByte || tEnd,
              tEnd,
              ttfbMs: tFirstByte ? Date.parse(tFirstByte) - t0 : Date.now() - t0,
              latencyMs: Date.now() - t0,
              toolsCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
              errorText: (upRes.statusCode || 0) >= 400 ? redactSensitiveText(rawText.slice(0, 300)) : ''
            });
          });
        }
      );
      upReq.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: redactSensitiveText(err.message) } }));
      });
      upReq.write(forwardBuf);
      upReq.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        captures,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function invokeClaudeCliOnce({ proxyPort, workDir, prompt, timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--model', 'claude-sonnet-4-6',
      '--output-format', 'json',
      '--no-session-persistence',
      '--max-turns', '1',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--dangerously-skip-permissions',
      '-p', prompt
    ];
    const isoCfg = path.join(workDir, '.claude_cfg');
    fs.mkdirSync(isoCfg, { recursive: true });
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
      ANTHROPIC_API_KEY: ['sk', 'ant', 'proxy', 'local'].join('-'),
      ANTHROPIC_AUTH_TOKEN: ['sk', 'ant', 'proxy', 'local'].join('-'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CONFIG_DIR: isoCfg
    };
    const child = spawn(CLAUDE_EXE, args, {
      cwd: workDir,
      env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude CLI timeout'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runMockCcPreflight() {
  const tmpDir = path.join(RUNTIME_ROOT, 't7_cc_mock_check');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.cpSync(FROZEN_REPO_DIR, tmpDir, { recursive: true });
  const { rulebookText } = buildInterleavedRulebook({ S: 10, seedName: 'ALPHA' });
  fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), rulebookText, 'utf8');

  const proxy = await startT7CcProxy({ apiKey: 'mock', customRateCard: {}, mockOnly: true });
  try {
    const cli = await invokeClaudeCliOnce({
      proxyPort: proxy.port,
      workDir: tmpDir,
      prompt: 'Active triggers for this task: [TAG-HDR]\nTask: Reply concisely.'
    });
    const cap = proxy.captures.find((c) => c.path.includes('/messages') && !c.path.includes('count_tokens')) || proxy.captures[0];
    console.log('[T7 CC $0 Mock Check]', JSON.stringify({ cliExit: cli.code, captureCount: proxy.captures.length, primary: cap }));
    if (!cap || (!cap.hasClaudeMdInMessages && !cap.hasClaudeMdInSystem)) {
      throw new Error(`CLAUDE.md did not appear in outbound wire payload! captures=${JSON.stringify(proxy.captures)}`);
    }
  } finally {
    await proxy.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runCcGroup({ S, probes, keys, customRateCard, budgetTracker, extraSecrets }) {
  const seedName = 'ALPHA';
  const groupKey = `CC|S${S}|${seedName}`;
  const workDir = path.join(RUNTIME_ROOT, 't7_cc', `S_${S}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.cpSync(FROZEN_REPO_DIR, workDir, { recursive: true });

  const { rulebookText, activeRulePositions } = buildInterleavedRulebook({
    S,
    seedName,
    extraOffset: 0
  });
  fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), rulebookText, 'utf8');

  const proxy = await startT7CcProxy({ apiKey: keys.OPENROUTER_API_KEY, customRateCard });
  const rows = [];
  let aborted = false;

  console.log(`[T7 CC] Running ${groupKey} (20 headless tasks via claude.exe)...`);
  try {
    for (const probe of probes) {
      const startCapIdx = proxy.captures.length;
      const cli = await invokeClaudeCliOnce({
        proxyPort: proxy.port,
        workDir,
        prompt: probe.userPrompt
      });
      const turnCaps = proxy.captures.slice(startCapIdx).filter((c) => c.path.includes('/messages') && !c.path.includes('count_tokens'));
      const cap = turnCaps[turnCaps.length - 1];

      let responseText = '';
      try {
        const parsed = JSON.parse(cli.stdout.trim());
        responseText = parsed.result || cli.stdout;
      } catch {
        responseText = cli.stdout;
      }

      if (!cap || cap.statusCode !== 200 || cli.code !== 0) {
        aborted = true;
        rows.push({
          test: 'T7',
          arm: `CC_S${S}`,
          rep: 1,
          turn: probe.probeIndex,
          model_slug: cap?.model || 'anthropic/claude-sonnet-4.6',
          provider: 'anthropic',
          prompt_tokens: cap?.normUsage?.prompt_tokens ?? 0,
          uncached_input_tokens: cap?.normUsage?.uncached_input_tokens ?? 0,
          cache_read_tokens: cap?.normUsage?.cache_read_tokens ?? 0,
          cache_write_5m_tokens: cap?.rawUsageObj?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          cache_write_1h_tokens: 0,
          cache_write_tokens: cap?.normUsage?.cache_write_tokens ?? 0,
          output_tokens: cap?.normUsage?.output_tokens ?? 0,
          billed_cost_usd: cap?.billedCostUsd ?? '',
          computed_cost_usd: cap?.computedCostUsd ?? 0,
          cost_source: cap?.billedCostUsd !== null ? 'billed' : 'computed',
          http_status: cap?.statusCode ?? 0,
          error_text: cap?.errorText || redactSensitiveText(cli.stderr.slice(0, 200)),
          t_start: cap?.tStart || new Date().toISOString(),
          t_first_byte: cap?.tFirstByte || new Date().toISOString(),
          t_end: cap?.tEnd || new Date().toISOString(),
          ttfb_ms: cap?.ttfbMs ?? 0,
          latency_ms: cap?.latencyMs ?? 0,
          nonce_id: `cc_s${S}`,
          harness: 'claude_code_claudemd',
          rule_count_s: S,
          seed_name: seedName,
          probe_index: probe.probeIndex,
          active_rules: probe.activeCodes.join(','),
          passed_rules_count: 0,
          total_active_rules: 5,
          strict_all_passed: false,
          per_rule_json: '{}',
          group_key: groupKey
        });
        console.error(`[T7 CC] ABORT ${groupKey} probe=${probe.probeIndex}: cli=${cli.code} http=${cap?.statusCode}`);
        break;
      }

      const cost = cap.billedCostUsd ?? cap.computedCostUsd ?? 0;
      budgetTracker.record(cost, `${groupKey}#${probe.probeIndex}`);

      const ev = evaluateProbeResponse({
        seedName,
        activeDims: probe.activeDims,
        responseText
      });

      rows.push({
        test: 'T7',
        arm: `CC_S${S}`,
        rep: 1,
        turn: probe.probeIndex,
        model_slug: cap.model,
        provider: 'anthropic',
        prompt_tokens: cap.normUsage.prompt_tokens,
        uncached_input_tokens: cap.normUsage.uncached_input_tokens,
        cache_read_tokens: cap.normUsage.cache_read_tokens,
        cache_write_5m_tokens: cap.rawUsageObj.cache_creation?.ephemeral_5m_input_tokens ?? cap.normUsage.cache_write_tokens,
        cache_write_1h_tokens: 0,
        cache_write_tokens: cap.normUsage.cache_write_tokens,
        output_tokens: cap.normUsage.output_tokens,
        billed_cost_usd: cap.billedCostUsd ?? '',
        computed_cost_usd: cap.computedCostUsd,
        cost_source: cap.billedCostUsd !== null ? 'billed' : 'computed',
        http_status: cap.statusCode,
        error_text: '',
        t_start: cap.tStart,
        t_first_byte: cap.tFirstByte,
        t_end: cap.tEnd,
        ttfb_ms: cap.ttfbMs,
        latency_ms: cap.latencyMs,
        nonce_id: `cc_s${S}`,
        harness: 'claude_code_claudemd',
        rule_count_s: S,
        seed_name: seedName,
        probe_index: probe.probeIndex,
        active_rules: probe.activeCodes.join(','),
        passed_rules_count: ev.passedCount,
        total_active_rules: ev.totalActive,
        strict_all_passed: ev.strictAllPassed,
        per_rule_json: JSON.stringify(ev.perRule),
        group_key: groupKey
      });
    }
  } finally {
    await proxy.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const strictPasses = rows.filter((r) => r.strict_all_passed).length;
  const totalRuleChecks = rows.length * 5;
  const rulePasses = rows.reduce((a, r) => a + r.passed_rules_count, 0);
  const groupCostUsd = Number(rows.reduce((a, r) => a + (Number(r.billed_cost_usd) || r.computed_cost_usd || 0), 0).toFixed(6));

  console.log(`[T7 CC] Done ${groupKey}: strict=${strictPasses}/${rows.length} rules=${rulePasses}/${totalRuleChecks} cost=$${groupCostUsd}`);

  const entry = {
    groupKey,
    harness: 'claude_code_claudemd',
    S,
    seed: 1,
    seedName,
    activeRulePositions,
    aborted,
    rows,
    groupCostUsd,
    strictPasses,
    rulePasses,
    totalProbes: rows.length,
    totalRuleChecks
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

function buildSummary(entries) {
  const validApi = entries.filter((e) => e.harness === 'api' && !e.aborted);
  const apiByS = {};
  for (const S of API_S_VALUES) {
    const groups = validApi.filter((e) => e.S === S);
    if (!groups.length) continue;
    const totalProbes = groups.reduce((a, g) => a + g.totalProbes, 0);
    const totalStrict = groups.reduce((a, g) => a + g.strictPasses, 0);
    const totalChecks = groups.reduce((a, g) => a + g.totalRuleChecks, 0);
    const totalRulePass = groups.reduce((a, g) => a + g.rulePasses, 0);
    const allRows = groups.flatMap((g) => g.rows);

    apiByS[`S=${S}`] = {
      ruleCountS: S,
      seedsCompleted: groups.length,
      strictTaskPass: { k: totalStrict, n: totalProbes, ...wilson95(totalStrict, totalProbes) },
      perRuleCompliance: { k: totalRulePass, n: totalChecks, ...wilson95(totalRulePass, totalChecks) },
      perSeedStrictPct: summarizeMedianRange(groups.map((g) => Number(((g.strictPasses / g.totalProbes) * 100).toFixed(2)))),
      perSeedRulePct: summarizeMedianRange(groups.map((g) => Number(((g.rulePasses / g.totalRuleChecks) * 100).toFixed(2)))),
      promptTokens: summarizeMedianRange(allRows.map((r) => r.prompt_tokens)),
      seedBlockCostUsd: summarizeMedianRange(groups.map((g) => g.groupCostUsd)),
      latencyMs: summarizeMedianRange(allRows.map((r) => r.latency_ms))
    };
  }

  const validCc = entries.filter((e) => e.harness === 'claude_code_claudemd' && !e.aborted);
  const ccByS = {};
  for (const S of CC_S_VALUES) {
    const groups = validCc.filter((e) => e.S === S);
    if (!groups.length) continue;
    const g = groups[0];
    ccByS[`S=${S}`] = {
      ruleCountS: S,
      strictTaskPass: { k: g.strictPasses, n: g.totalProbes, ...wilson95(g.strictPasses, g.totalProbes) },
      perRuleCompliance: { k: g.rulePasses, n: g.totalRuleChecks, ...wilson95(g.rulePasses, g.totalRuleChecks) },
      promptTokens: summarizeMedianRange(g.rows.map((r) => r.prompt_tokens)),
      blockCostUsd: g.groupCostUsd,
      latencyMs: summarizeMedianRange(g.rows.map((r) => r.latency_ms))
    };
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    apiByS,
    ccClaudeMdByS: ccByS,
    abortedGroups: entries.filter((e) => e.aborted).map((e) => e.groupKey)
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const onlyApi = args.includes('--only-api');
  const onlyCc = args.includes('--only-cc');
  const mockCcOnly = args.includes('--mock-cc-only');

  if (mockCcOnly) {
    await runMockCcPreflight();
    return;
  }

  const keys = loadBenchmarkKeys();
  const extraSecrets = getExtraSecrets(keys);
  const rateCard = loadRateCard();
  const probes = build20Probes();

  if (fresh && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log('[T7] Cleared checkpoint for --fresh run.');
  }

  const checkpointed = loadCheckpoints();
  const doneKeys = new Set(checkpointed.filter((e) => !e.aborted).map((e) => e.groupKey));

  const apiBudget = new RunBudgetTracker({
    expectedRunUsd: 2.0,
    multiplier: 3,
    maxRunUsd: 6.0,
    globalCapUsd: 15.0,
    label: 'T7_API'
  });

  if (!onlyCc) {
    for (const S of API_S_VALUES) {
      for (const seedObj of SEEDS) {
        const groupKey = `API|S${S}|${seedObj.name}`;
        if (doneKeys.has(groupKey)) {
          console.log(`[T7 API] Skipping completed ${groupKey}`);
          continue;
        }
        await runApiGroup({
          S,
          seedObj,
          probes,
          customRateCard: rateCard,
          budgetTracker: apiBudget,
          extraSecrets
        });
      }
    }
  }

  if (!onlyApi) {
    const missingCc = CC_S_VALUES.filter((S) => !doneKeys.has(`CC|S${S}|ALPHA`));
    if (missingCc.length > 0) {
      await runMockCcPreflight();
      const ccBudget = new RunBudgetTracker({
        expectedRunUsd: 2.25,
        multiplier: 3,
        maxRunUsd: 6.75,
        globalCapUsd: 15.0,
        label: 'T7_CC'
      });
      for (const S of missingCc) {
        await runCcGroup({
          S,
          probes,
          keys,
          customRateCard: rateCard,
          budgetTracker: ccBudget,
          extraSecrets
        });
      }
    }
  }

  const finalMap = new Map();
  for (const e of loadCheckpoints()) {
    finalMap.set(e.groupKey, e);
  }
  const allEntries = [...finalMap.values()];
  const allRows = allEntries.flatMap((e) => e.rows || []);

  writeCsv(CSV_OUT_PATH, T7_CSV_COLUMNS, allRows);
  const summary = buildSummary(allEntries);
  const summaryStr = JSON.stringify(summary, null, 2);
  assertNoSensitiveLeaks(summaryStr, 't7_summary.json', extraSecrets);
  fs.writeFileSync(SUMMARY_OUT_PATH, summaryStr, 'utf8');

  console.log(`[T7] Complete! Wrote ${allRows.length} rows -> ${CSV_OUT_PATH}`);
  console.log(`[T7] Summary -> ${SUMMARY_OUT_PATH}`);
  if (summary.abortedGroups.length > 0) {
    console.error(`[T7] WARNING aborted groups: ${summary.abortedGroups.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[T7] Fatal error:', redactSensitiveText(err.stack || err.message));
  process.exit(1);
});
