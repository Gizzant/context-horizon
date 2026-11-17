import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  RESULTS_DIR,
  PINNED_REPO_COMMIT,
  PRICING_PER_1M,
  normalizeUsage,
  mapCliModelToOpenRouter
} from '../config.mjs';
import { parseSseTranscript, mergeAnthropicUsage } from '../proxy_recorder.mjs';

export const TESTS_DIR = path.join(EXPERIMENT_DIR, 'tests_3_to_8');
export const PHASE0_RATE_CARD_PATH = path.join(RESULTS_DIR, 'phase0_rate_card.json');

export const STANDARD_CSV_COLUMNS = Object.freeze([
  'test',
  'arm',
  'rep',
  'turn',
  'model_slug',
  'provider',
  'prompt_tokens',
  'uncached_input_tokens',
  'cache_read_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'cache_write_tokens',
  'output_tokens',
  'billed_cost_usd',
  'computed_cost_usd',
  'cost_source',
  'http_status',
  'error_text',
  't_start',
  't_first_byte',
  't_end',
  'ttfb_ms',
  'latency_ms',
  'nonce_id'
]);

const pinnedFileLineCache = new Map();

/**
 * Loads API keys from .env.benchmark (fallback process.env) without logging secret values.
 */
export function loadBenchmarkKeys(dotenvPath = path.join(REPO_ROOT, '.env.benchmark')) {
  const fromFile = {};
  if (fs.existsSync(dotenvPath)) {
    const raw = fs.readFileSync(dotenvPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (val) fromFile[key] = val;
      }
    }
  }
  return {
    OPENROUTER_API_KEY: (process.env.OPENROUTER_API_KEY || fromFile.OPENROUTER_API_KEY || '').trim() || null,
    ANTHROPIC_API_KEY: (process.env.ANTHROPIC_API_KEY || fromFile.ANTHROPIC_API_KEY || '').trim() || null,
    GEMINI_BENCHMARK_API_KEY: (
      fromFile.GEMINI_BENCHMARK_API_KEY ||
      process.env.GEMINI_BENCHMARK_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      ''
    ).trim() || null,
    ENV_GEMINI_API_KEY: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim() || null
  };
}

/**
 * Redacts API tokens, OS usernames, and local filesystem paths.
 */
export function redactSensitiveText(input = '') {
  const home = os.homedir();
  const userInfo = os.userInfo().username;
  let out = String(input ?? '');
  out = out
    .replace(/sk-or-v1-[A-Za-z0-9_.-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-ant-[A-Za-z0-9_.-]+/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/AQ\.[A-Za-z0-9_.-]{16,}/g, '[REDACTED_GEMINI_KEY]')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/gen-\d{6,}-[A-Za-z0-9]+/g, '[REDACTED_UPSTREAM_REQ_ID]');

  const needles = [
    [REPO_ROOT, '<REPO_ROOT>'],
    [REPO_ROOT.replace(/\\/g, '/'), '<REPO_ROOT>'],
    [REPO_ROOT.replace(/\\/g, '\\\\'), '<REPO_ROOT>'],
    [home, '<USER_HOME>'],
    [home.replace(/\\/g, '/'), '<USER_HOME>'],
    [home.replace(/\\/g, '\\\\'), '<USER_HOME>']
  ];
  for (const [needle, repl] of needles) {
    if (needle) out = out.split(needle).join(repl);
  }
  out = out
    .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
    .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]')
    .replace(/\/Users\/[^/"\s]+/g, '/Users/[USER]')
    .replace(/\/home\/[^/"\s]+/g, '/home/[USER]');
  if (userInfo && userInfo.length >= 3) {
    const escaped = userInfo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<=\\\\|/)${escaped}(?=\\\\|/|$)`, 'gi'), '[USER]');
  }
  return out;
}

/**
 * Throws if raw keys or local user paths appear in serialized output text.
 */
export function assertNoSensitiveLeaks(text = '', contextLabel = 'output', extraSecrets = []) {
  const s = String(text ?? '');
  const checks = [
    { name: 'openrouter_key', re: /sk-or-v1-[A-Za-z0-9_-]{10,}/ },
    { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
    { name: 'gemini_aq_key', re: /AQ\.[A-Za-z0-9_.-]{16,}/ },
    { name: 'google_aiza_key', re: /AIza[A-Za-z0-9_-]{20,}/ },
    { name: 'windows_user_path', re: /[A-Za-z]:\\{1,2}Users\\{1,2}(?!\[USER\])[A-Za-z0-9._-]+/i },
    { name: 'unix_user_path', re: /\/Users\/(?!\[USER\])[A-Za-z0-9._-]+/i }
  ];
  for (const c of checks) {
    if (c.re.test(s)) {
      throw new Error(`Privacy leak detected (${c.name}) in ${contextLabel}`);
    }
  }
  for (const secret of extraSecrets) {
    if (secret && typeof secret === 'string' && secret.length >= 8 && s.includes(secret)) {
      throw new Error(`Explicit secret literal detected in ${contextLabel}`);
    }
  }
}

export function createRepNonce(tag = 'rep') {
  const cleanTag = String(tag).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${cleanTag}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeSystemBlocks(system) {
  if (!system) return [];
  if (typeof system === 'string') return system ? [{ type: 'text', text: system }] : [];
  if (Array.isArray(system)) {
    return system.map((b) => {
      if (typeof b === 'string') return { type: 'text', text: b };
      const copy = structuredClone(b);
      delete copy.cache_control;
      return copy;
    });
  }
  return [];
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const copy = structuredClone(m);
    if (typeof copy.content === 'string') {
      return {
        role: copy.role,
        ...(copy.output_config ? { output_config: copy.output_config } : {}),
        content: [{ type: 'text', text: copy.content }]
      };
    }
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.map((b) => {
        if (typeof b === 'string') return { type: 'text', text: b };
        const bc = structuredClone(b);
        delete bc.cache_control;
        return bc;
      });
    }
    return copy;
  });
}

/**
 * Injects a repetition nonce at token index 0 (tools -> system -> messages)
 * and sets ephemeral cache_control breakpoints mirroring control runs.
 */
export function injectNonceAndBreakpoints({
  nonce,
  tools = [],
  system = [],
  messages = [],
  ttl = null,
  breakpointLayers = ['tools', 'system', 'messages'],
  omitMessageBreakpoint = false
} = {}) {
  const bp = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const outTools = Array.isArray(tools)
    ? tools.map((t) => {
        const copy = structuredClone(t);
        delete copy.cache_control;
        return copy;
      })
    : [];
  const outSystem = normalizeSystemBlocks(system);
  const outMessages = normalizeMessages(messages);

  if (nonce) {
    const prefix = `[NONCE:${nonce}] `;
    if (outTools.length > 0) {
      for (const tool of outTools) {
        tool.description = `${prefix}${tool.description || tool.name || 'tool'}`;
      }
    }
    if (outSystem.length > 0) {
      outSystem[0].text = `${prefix}\n${outSystem[0].text || ''}`;
    } else if (outMessages.length > 0) {
      const firstBlocks = Array.isArray(outMessages[0].content) ? outMessages[0].content : [];
      const textBlock = firstBlocks.find((b) => b.type === 'text');
      if (textBlock) textBlock.text = `${prefix}\n${textBlock.text || ''}`;
      else firstBlocks.unshift({ type: 'text', text: prefix });
      outMessages[0].content = firstBlocks;
    }
  }

  if (breakpointLayers.includes('tools') && outTools.length > 0) {
    outTools[outTools.length - 1].cache_control = { ...bp };
  }
  if (breakpointLayers.includes('system') && outSystem.length > 0) {
    outSystem[outSystem.length - 1].cache_control = { ...bp };
  }
  if (!omitMessageBreakpoint && breakpointLayers.includes('messages') && outMessages.length > 0) {
    for (let i = outMessages.length - 1; i >= 0; i--) {
      const msg = outMessages[i];
      if (Array.isArray(msg.content) && msg.content.length > 0) {
        msg.content[msg.content.length - 1].cache_control = { ...bp };
        break;
      }
    }
  }

  return {
    tools: outTools,
    system: outSystem,
    messages: outMessages
  };
}

/**
 * Loads deterministic line slices [startLine..endLine] (1-indexed inclusive) from pinned repo commit.
 */
export function loadPinnedCorpusSlice(relPath, startLine = 1, endLine = Infinity, commit = PINNED_REPO_COMMIT) {
  const key = `${commit}:${relPath}`;
  let lines = pinnedFileLineCache.get(key);
  if (!lines) {
    const raw = execFileSync('git', ['show', `${commit}:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
    lines = raw.split(/\r?\n/);
    pinnedFileLineCache.set(key, lines);
  }
  const sIdx = Math.max(0, Number(startLine) - 1);
  const eIdx = Number.isFinite(endLine) ? Math.min(lines.length, Number(endLine)) : lines.length;
  return lines.slice(sIdx, eIdx).join('\n');
}

export function resolveModelPricing(modelSlug = '', customRateCard = {}) {
  if (customRateCard && customRateCard[modelSlug]) return customRateCard[modelSlug];
  const mapped = mapModelForRoute(modelSlug, 'openrouter');
  if (customRateCard && customRateCard[mapped]) return customRateCard[mapped];
  if (PRICING_PER_1M[mapped]) return PRICING_PER_1M[mapped];
  if (modelSlug.includes('sonnet-5.5') || modelSlug.includes('sonnet-5-5')) {
    return customRateCard['anthropic/claude-sonnet-5.5'] || {
      input: 2.0,
      output: 10.0,
      write5m: 2.5,
      write1h: 4.0,
      read: 0.1
    };
  }
  if (modelSlug.includes('opus-5.5') || modelSlug.includes('opus-5-5')) {
    return customRateCard['anthropic/claude-opus-5.5'] || {
      input: 5.0,
      output: 25.0,
      write5m: 6.25,
      write1h: 10.0,
      read: 0.25
    };
  }
  return PRICING_PER_1M['anthropic/claude-sonnet-4.6'];
}

export function mapModelForRoute(modelSlug = '', route = 'openrouter') {
  const m = String(modelSlug || '').trim();
  if (route === 'openrouter') {
    if (m.startsWith('anthropic/')) return m;
    if (m.includes('sonnet-5-5') || m.includes('sonnet-5.5')) return 'anthropic/claude-sonnet-5.5';
    if (m.includes('opus-5-5') || m.includes('opus-5.5')) return 'anthropic/claude-opus-5.5';
    return mapCliModelToOpenRouter(m);
  }
  if (m.startsWith('anthropic/')) {
    return m.slice('anthropic/'.length).replace(/\./g, '-');
  }
  return m;
}

export function computeUsageCostExt(modelSlug, rawUsage = {}, { customRateCard = {}, requestedTtl = null } = {}) {
  const rate = resolveModelPricing(modelSlug, customRateCard);
  const u = normalizeUsage(rawUsage);
  let write5mTokens = u.ephemeral_5m_input_tokens;
  let write1hTokens = u.ephemeral_1h_input_tokens;
  const detailedSum = write5mTokens + write1hTokens;
  if (detailedSum === 0 && u.cache_creation_input_tokens > 0) {
    if (requestedTtl === '1h') write1hTokens = u.cache_creation_input_tokens;
    else write5mTokens = u.cache_creation_input_tokens;
  } else if (u.cache_creation_input_tokens > detailedSum) {
    const rem = u.cache_creation_input_tokens - detailedSum;
    if (requestedTtl === '1h' && write5mTokens === 0) write1hTokens += rem;
    else write5mTokens += rem;
  }
  const uncachedCost = (u.input_tokens / 1e6) * rate.input;
  const write5mCost = (write5mTokens / 1e6) * rate.write5m;
  const write1hCost = (write1hTokens / 1e6) * rate.write1h;
  const readCost = (u.cache_read_input_tokens / 1e6) * rate.read;
  const outputCost = (u.output_tokens / 1e6) * rate.output;
  const totalCostUsd = Number((uncachedCost + write5mCost + write1hCost + readCost + outputCost).toFixed(8));
  return {
    rate,
    write5mTokens,
    write1hTokens,
    totalCostUsd
  };
}

export class RunBudgetTracker {
  constructor({ expectedRunUsd = null, multiplier = 3, maxRunUsd = null, globalCapUsd = 35, label = 'run' } = {}) {
    this.expectedRunUsd = typeof expectedRunUsd === 'number' && expectedRunUsd > 0 ? expectedRunUsd : null;
    this.multiplier = multiplier;
    this.maxRunUsd = maxRunUsd || (this.expectedRunUsd ? this.expectedRunUsd * multiplier : null);
    this.globalCapUsd = globalCapUsd;
    this.label = label;
    this.runSpentUsd = 0;
  }

  checkBeforeCall(globalSpentUsd = 0) {
    if (this.globalCapUsd && globalSpentUsd >= this.globalCapUsd) {
      throw new Error(`Global budget cap $${this.globalCapUsd.toFixed(2)} reached (spent $${globalSpentUsd.toFixed(4)})`);
    }
    if (this.maxRunUsd && this.runSpentUsd >= this.maxRunUsd) {
      throw new Error(`Run ${this.label} exceeded 3x cap $${this.maxRunUsd.toFixed(4)} (spent $${this.runSpentUsd.toFixed(4)})`);
    }
  }

  record(costUsd = 0) {
    const c = Number(costUsd || 0);
    if (Number.isFinite(c) && c > 0) this.runSpentUsd += c;
    if (this.maxRunUsd && this.runSpentUsd > this.maxRunUsd) {
      throw new Error(`Run ${this.label} aborted: spend $${this.runSpentUsd.toFixed(4)} exceeded 3x expected cap $${this.maxRunUsd.toFixed(4)}`);
    }
  }
}

function makeHttpRequest({ url, method = 'POST', headers = {}, body = null, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const baseEpochMs = Date.now();
    const baseHrNs = process.hrtime.bigint();
    const tStartIso = new Date(baseEpochMs).toISOString();

    const isoFromNs = (ns) => {
      const deltaMs = Number(ns - baseHrNs) / 1e6;
      return {
        iso: new Date(baseEpochMs + deltaMs).toISOString(),
        ms: Number(deltaMs.toFixed(3))
      };
    };

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers
      },
      (res) => {
        let firstByteNs = null;
        let messageStartNs = null;
        const chunks = [];
        res.on('data', (chunk) => {
          const nowNs = process.hrtime.bigint();
          if (firstByteNs === null) firstByteNs = nowNs;
          if (!messageStartNs) {
            const s = chunk.toString('utf8');
            if (s.includes('message_start')) messageStartNs = nowNs;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const endNs = process.hrtime.bigint();
          const firstNs = messageStartNs || firstByteNs || endNs;
          const fb = isoFromNs(firstNs);
          const end = isoFromNs(endNs);
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            rawText: Buffer.concat(chunks).toString('utf8'),
            t_start: tStartIso,
            t_first_byte: fb.iso,
            t_end: end.iso,
            ttfb_ms: fb.ms,
            latency_ms: end.ms
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function extractTextFromMessageJson(json) {
  if (!json || !Array.isArray(json.content)) return '';
  return json.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function extractThinkingTokensEstimate(json, sseText) {
  if (json && Array.isArray(json.content)) {
    const thinkingChars = json.content
      .filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string')
      .map((b) => b.thinking.length)
      .reduce((a, b) => a + b, 0);
    return thinkingChars;
  }
  if (!sseText) return 0;
  let thinkingChars = 0;
  for (const frame of String(sseText).split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trimStart();
      if (raw === '[DONE]') continue;
      try {
        const d = JSON.parse(raw);
        if (d?.delta?.type === 'thinking_delta' && typeof d.delta.thinking === 'string') {
          thinkingChars += d.delta.thinking.length;
        }
      } catch {}
    }
  }
  return thinkingChars;
}

function extractSseText(sseText = '') {
  let out = '';
  for (const frame of String(sseText).split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trimStart();
      if (raw === '[DONE]') continue;
      try {
        const d = JSON.parse(raw);
        if (d?.delta?.type === 'text_delta' && typeof d.delta.text === 'string') {
          out += d.delta.text;
        }
      } catch {}
    }
  }
  return out;
}

/**
 * Executes a single Messages API call through OpenRouter (pinned Anthropic) or Direct Anthropic API.
 */
export async function sendMessagesCall({
  test = '',
  arm = '',
  rep = 1,
  turn = 1,
  route = 'openrouter',
  baseUrl = null,
  apiKey = null,
  anthropicAuthMode = 'auto',
  model = 'anthropic/claude-sonnet-4.6',
  system = [],
  tools = [],
  messages = [],
  max_tokens = 100,
  stream = true,
  output_config = null,
  thinking = null,
  anthropicBeta = null,
  anthropicVersion = '2023-06-01',
  requestedTtl = null,
  nonceId = '',
  customRateCard = {},
  budgetTracker = null,
  timeoutMs = 120000
} = {}) {
  const keys = loadBenchmarkKeys();
  const isOpenRouter = route === 'openrouter';
  const resolvedKey = apiKey || (isOpenRouter ? keys.OPENROUTER_API_KEY : keys.ANTHROPIC_API_KEY);
  if (!resolvedKey) {
    throw new Error(`Missing API key for route=${route}`);
  }
  if (budgetTracker) budgetTracker.checkBeforeCall(0);

  const mappedModel = mapModelForRoute(model, route);
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, '')}/v1/messages`
    : (isOpenRouter
      ? 'https://openrouter.ai/api/v1/messages'
      : 'https://api.anthropic.com/v1/messages');

  const payload = {
    model: mappedModel,
    max_tokens,
    stream: Boolean(stream),
    messages
  };
  if (Array.isArray(system) ? system.length > 0 : Boolean(system)) payload.system = system;
  if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
  if (output_config) payload.output_config = output_config;
  if (thinking) payload.thinking = thinking;
  if (isOpenRouter) {
    payload.provider = {
      only: ['anthropic'],
      allow_fallbacks: false
    };
  }

  const bodyStr = JSON.stringify(payload);
  const buildHeaders = (mode) => {
    const h = {
      'content-type': 'application/json',
      'accept-encoding': 'identity',
      'anthropic-version': anthropicVersion,
      'content-length': Buffer.byteLength(bodyStr, 'utf8')
    };
    if (isOpenRouter) {
      h['authorization'] = `Bearer ${resolvedKey}`;
      h['http-referer'] = 'https://github.com/<GITHUB_HANDLE>/<TARGET_REPO>';
      h['x-title'] = '<PROJECT_NAME> Prefix Lab';
    } else if (mode === 'bearer') {
      h['authorization'] = `Bearer ${resolvedKey}`;
    } else {
      h['x-api-key'] = resolvedKey;
    }
    if (anthropicBeta) {
      h['anthropic-beta'] = anthropicBeta;
    }
    return h;
  };

  let authUsed = isOpenRouter ? 'bearer' : (anthropicAuthMode === 'bearer' ? 'bearer' : 'x-api-key');
  let res = await makeHttpRequest({
    url,
    method: 'POST',
    headers: buildHeaders(authUsed),
    body: bodyStr,
    timeoutMs
  });

  if (!isOpenRouter && res.statusCode === 401 && anthropicAuthMode === 'auto' && authUsed === 'x-api-key') {
    authUsed = 'bearer';
    res = await makeHttpRequest({
      url,
      method: 'POST',
      headers: buildHeaders('bearer'),
      body: bodyStr,
      timeoutMs
    });
  }

  const contentType = String(res.headers['content-type'] || '');
  const isSse = contentType.includes('text/event-stream') || res.rawText.includes('event: message_start');
  let parsed = null;
  let usage = {};
  let assistantText = '';
  let thinkingChars = 0;
  let errorText = '';
  let responseModel = mappedModel;
  let stopReason = null;

  if (isSse) {
    parsed = parseSseTranscript(res.rawText);
    usage = parsed.usage || {};
    assistantText = extractSseText(res.rawText);
    thinkingChars = extractThinkingTokensEstimate(null, res.rawText);
    responseModel = parsed.responseModel || mappedModel;
    stopReason = parsed.stopReason || null;
    if (parsed.errorPayload || res.statusCode >= 400) {
      errorText = redactSensitiveText(JSON.stringify(parsed.errorPayload || res.rawText.slice(0, 600)));
    }
  } else {
    try {
      const json = JSON.parse(res.rawText);
      usage = json?.usage || {};
      assistantText = extractTextFromMessageJson(json);
      thinkingChars = extractThinkingTokensEstimate(json, null);
      responseModel = json?.model || mappedModel;
      stopReason = json?.stop_reason || null;
      if (json?.error || res.statusCode >= 400) {
        errorText = redactSensitiveText(JSON.stringify(json?.error || json).slice(0, 600));
      }
    } catch {
      if (res.statusCode >= 400) {
        errorText = redactSensitiveText(res.rawText.slice(0, 600));
      }
    }
  }

  const normalized = normalizeUsage(usage);
  const thinkingTokens = typeof usage?.output_tokens_details?.thinking_tokens === 'number'
    ? usage.output_tokens_details.thinking_tokens
    : null;
  const costCalc = computeUsageCostExt(mappedModel, usage, { customRateCard, requestedTtl });
  const hasBilled = typeof usage.cost === 'number' && Number.isFinite(usage.cost);
  const billedCostUsd = hasBilled ? Number(usage.cost) : null;
  const effectiveCostUsd = hasBilled ? billedCostUsd : costCalc.totalCostUsd;
  if (budgetTracker && res.statusCode < 400) {
    budgetTracker.record(effectiveCostUsd);
  }

  const providerHeader = isOpenRouter
    ? (res.headers['x-openrouter-provider'] || 'openrouter_anthropic_pinned')
    : `anthropic_direct(${authUsed})`;

  return {
    row: {
      test,
      arm,
      rep,
      turn,
      model_slug: mappedModel,
      provider: providerHeader,
      prompt_tokens: normalized.total_input_tokens,
      uncached_input_tokens: normalized.input_tokens,
      cache_read_tokens: normalized.cache_read_input_tokens,
      cache_write_5m_tokens: costCalc.write5mTokens,
      cache_write_1h_tokens: costCalc.write1hTokens,
      cache_write_tokens: normalized.cache_creation_input_tokens,
      output_tokens: normalized.output_tokens,
      billed_cost_usd: billedCostUsd !== null ? billedCostUsd : '',
      computed_cost_usd: costCalc.totalCostUsd,
      cost_source: hasBilled ? 'billed' : 'computed',
      http_status: res.statusCode,
      error_text: errorText,
      t_start: res.t_start,
      t_first_byte: res.t_first_byte,
      t_end: res.t_end,
      ttfb_ms: res.ttfb_ms,
      latency_ms: res.latency_ms,
      nonce_id: nonceId
    },
    assistantText,
    thinkingChars,
    thinkingTokens,
    stopReason,
    responseModel,
    rawUsage: usage,
    authUsed
  };
}

/**
 * Computes exact median and [min, max] range across finite numbers. Never mixes means.
 */
export function summarizeMedianRange(values = []) {
  const nums = values.map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = nums.length;
  if (n === 0) return { n: 0, median: null, min: null, max: null };
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return {
    n,
    median,
    min: nums[0],
    max: nums[n - 1]
  };
}

/**
 * Wilson score 95% confidence interval for k successes out of n trials.
 */
export function wilson95(k, n) {
  if (!n || n <= 0) return { p: 0, low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin)
  };
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function writeCsv(filePath, columns, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = columns.map(escapeCsvCell).join(',');
  const lines = rows.map((row) => columns.map((col) => escapeCsvCell(row[col])).join(','));
  const content = [header, ...lines].join('\n') + '\n';
  assertNoSensitiveLeaks(content, path.basename(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

export function loadRateCard(rateCardPath = PHASE0_RATE_CARD_PATH) {
  if (!fs.existsSync(rateCardPath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(rateCardPath, 'utf8'));
    return data?.models || {};
  } catch {
    return {};
  }
}

export function makeSimpleHttpRequestForProbe(opts) {
  return makeHttpRequest(opts);
}

export {
  http,
  https,
  path,
  fs,
  os,
  EXPERIMENT_DIR,
  REPO_ROOT,
  RESULTS_DIR,
  mergeAnthropicUsage
};
