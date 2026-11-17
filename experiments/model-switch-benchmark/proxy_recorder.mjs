import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  RAW_RESULTS_DIR,
  MAX_BUDGET_USD,
  mapCliModelToOpenRouter,
  loadOpenRouterApiKey,
  normalizeUsage,
  computeUsageCostUsd
} from './config.mjs';

function sha256Short(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function redactText(str = '') {
  return String(str)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]')
    .replace(/\/Users\/[^/"\s]+/g, '/Users/[USER]');
}

export function extractRequestFingerprint(parsed = {}, rawHeaders = {}, urlPath = '') {
  if (!parsed || typeof parsed !== 'object') {
    return { validJson: false };
  }

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const systemBlocks = Array.isArray(parsed.system)
    ? parsed.system
    : (typeof parsed.system === 'string' ? [{ type: 'text', text: parsed.system }] : []);
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  const cacheBreakpoints = [];
  tools.forEach((t, idx) => {
    if (t?.cache_control) {
      cacheBreakpoints.push({ section: 'tools', index: idx, cache_control: t.cache_control });
    }
  });
  systemBlocks.forEach((b, idx) => {
    if (b?.cache_control) {
      cacheBreakpoints.push({ section: 'system', index: idx, cache_control: b.cache_control });
    }
  });
  messages.forEach((m, mIdx) => {
    const blocks = Array.isArray(m?.content) ? m.content : [];
    blocks.forEach((b, bIdx) => {
      if (b?.cache_control) {
        cacheBreakpoints.push({
          section: 'messages',
          messageIndex: mIdx,
          role: m.role,
          blockIndex: bIdx,
          blockType: b.type,
          cache_control: b.cache_control
        });
      }
    });
  });

  const messageBlockSummary = messages.map((m, mIdx) => {
    if (typeof m?.content === 'string') {
      return {
        index: mIdx,
        role: m.role,
        kind: 'string',
        chars: m.content.length,
        sha256: sha256Short(m.content)
      };
    }
    const blocks = Array.isArray(m?.content) ? m.content : [];
    return {
      index: mIdx,
      role: m.role,
      kind: 'blocks',
      blocks: blocks.map((b, bIdx) => ({
        index: bIdx,
        type: b?.type || 'unknown',
        chars: JSON.stringify(b || '').length,
        sha256: sha256Short(b),
        cache_control: b?.cache_control || null
      }))
    };
  });

  return {
    validJson: true,
    urlPath,
    topLevelKeys: Object.keys(parsed).sort(),
    model: parsed.model || null,
    stream: Boolean(parsed.stream),
    max_tokens: parsed.max_tokens ?? null,
    temperature: parsed.temperature ?? null,
    thinking: parsed.thinking ?? null,
    output_config: parsed.output_config ?? null,
    metadata: parsed.metadata ?? null,
    anthropicBetaHeader: rawHeaders['anthropic-beta'] || null,
    anthropicVersionHeader: rawHeaders['anthropic-version'] || null,
    toolsCount: tools.length,
    toolsChars: JSON.stringify(tools).length,
    toolNames: tools.map((t) => t?.name).filter(Boolean),
    toolsSha256: sha256Short(tools),
    systemBlocksCount: systemBlocks.length,
    systemChars: JSON.stringify(parsed.system ?? '').length,
    systemBlockLengths: systemBlocks.map((b) =>
      typeof b === 'string' ? b.length : typeof b?.text === 'string' ? b.text.length : JSON.stringify(b ?? '').length
    ),
    system2HasMemoryMd: Boolean(
      systemBlocks[2] &&
        /MEMORY\.md|# auto memory|auto-memory/i.test(
          typeof systemBlocks[2] === 'string'
            ? systemBlocks[2]
            : typeof systemBlocks[2]?.text === 'string'
              ? systemBlocks[2].text
              : JSON.stringify(systemBlocks[2])
        )
    ),
    systemHasMemoryMd: /MEMORY\.md|# auto memory|auto-memory/i.test(JSON.stringify(parsed.system ?? '')),
    systemSha256: sha256Short(parsed.system ?? ''),
    messagesCount: messages.length,
    messagesChars: JSON.stringify(messages).length,
    messagesPrefixSha256: sha256Short(messages.slice(0, Math.max(0, messages.length - 1))),
    messagesAllSha256: sha256Short(messages),
    messageBlockSummary,
    cacheBreakpoints
  };
}

export function mergeAnthropicUsage(base = {}, incoming = {}) {
  if (!incoming || typeof incoming !== 'object') return { ...base };
  const merged = { ...base };
  for (const key of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens'
  ]) {
    if (typeof incoming[key] === 'number' && Number.isFinite(incoming[key])) {
      merged[key] = incoming[key];
    }
  }
  if (incoming.cache_creation && typeof incoming.cache_creation === 'object') {
    const prevCc = merged.cache_creation || {};
    merged.cache_creation = {
      ...prevCc,
      ...(typeof incoming.cache_creation.ephemeral_5m_input_tokens === 'number'
        ? { ephemeral_5m_input_tokens: incoming.cache_creation.ephemeral_5m_input_tokens }
        : {}),
      ...(typeof incoming.cache_creation.ephemeral_1h_input_tokens === 'number'
        ? { ephemeral_1h_input_tokens: incoming.cache_creation.ephemeral_1h_input_tokens }
        : {})
    };
  }
  if (incoming.output_tokens_details && typeof incoming.output_tokens_details === 'object') {
    merged.output_tokens_details = {
      ...(merged.output_tokens_details || {}),
      ...incoming.output_tokens_details
    };
  }
  if (typeof incoming.cost === 'number') {
    merged.cost = incoming.cost;
  }
  return merged;
}

export function parseSseTranscript(sseText = '') {
  const frames = String(sseText || '').split(/\r?\n\r?\n/);
  let messageId = null;
  let responseModel = null;
  let stopReason = null;
  let usage = {};
  let eventCount = 0;
  let errorPayload = null;
  const eventTypes = [];

  for (const frame of frames) {
    if (!frame.trim()) continue;
    const lines = frame.split(/\r?\n/);
    let eventName = null;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join('\n').trim();
    if (rawData === '[DONE]') continue;

    let data = null;
    try {
      data = JSON.parse(rawData);
    } catch {
      continue;
    }

    eventCount += 1;
    const kind = eventName || data?.type || 'unknown';
    if (!eventTypes.includes(kind)) eventTypes.push(kind);

    if (kind === 'message_start' && data?.message) {
      messageId = data.message.id || messageId;
      responseModel = data.message.model || responseModel;
      if (data.message.usage) {
        usage = mergeAnthropicUsage(usage, data.message.usage);
      }
    } else if (kind === 'message_delta') {
      if (data?.delta?.stop_reason) {
        stopReason = data.delta.stop_reason;
      }
      if (data?.usage) {
        usage = mergeAnthropicUsage(usage, data.usage);
      }
    } else if (kind === 'error') {
      errorPayload = data?.error || data;
    } else if (data?.usage) {
      usage = mergeAnthropicUsage(usage, data.usage);
    }
  }

  return {
    messageId,
    responseModel,
    stopReason,
    usage,
    eventCount,
    eventTypes,
    errorPayload
  };
}

export async function startProxyServer({
  port = 0,
  upstreamBaseUrl = 'https://openrouter.ai',
  upstreamApiPrefix = '/api',
  apiKey = null,
  maxBudgetUsd = MAX_BUDGET_USD,
  wireLogPath = path.join(RAW_RESULTS_DIR, 'proxy_wire_log.jsonl'),
  pinProvider = true,
  stripCacheTtl = false
} = {}) {
  const resolvedApiKey = apiKey || loadOpenRouterApiKey();
  fs.mkdirSync(path.dirname(wireLogPath), { recursive: true });
  const parsedUpstream = new URL(upstreamBaseUrl);
  const transport = parsedUpstream.protocol === 'http:' ? http : https;

  const state = {
    wireSeq: 0,
    totalSpendUsd: 0,
    budgetExceeded: false,
    activeContext: null,
    requestsCount: 0,
    mainRequestsCount: 0,
    sideCallsCount: 0
  };

  function appendLog(record) {
    fs.appendFileSync(wireLogPath, JSON.stringify(record) + '\n', 'utf8');
  }

  function mapTargetPath(incomingUrl = '/v1/messages') {
    const clean = incomingUrl.startsWith('/api/') ? incomingUrl.slice(4) : incomingUrl;
    const prefix = upstreamApiPrefix ? upstreamApiPrefix.replace(/\/+$/, '') : '';
    const basePath = parsedUpstream.pathname.replace(/\/+$/, '');
    return `${basePath}${prefix}${clean.startsWith('/') ? clean : '/' + clean}`;
  }

  const server = http.createServer((req, res) => {
    const reqStartNs = process.hrtime.bigint();
    const reqStartedAt = new Date().toISOString();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const urlPath = req.url || '/';
      const isMessagesEndpoint = /^\/(?:api\/)?v1\/messages(?:\?|$)/.test(urlPath) && !urlPath.includes('count_tokens');
      const isCountTokens = urlPath.includes('count_tokens');

      let parsedReq = null;
      try {
        parsedReq = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        parsedReq = null;
      }

      if (state.budgetExceeded || state.totalSpendUsd >= maxBudgetUsd) {
        state.budgetExceeded = true;
        const wireSeq = ++state.wireSeq;
        appendLog({
          wireSeq,
          timestamp: reqStartedAt,
          context: state.activeContext,
          urlPath,
          isSideCall: !isMessagesEndpoint,
          blockedByBudgetBreaker: true,
          cumulativeSpendUsd: Number(state.totalSpendUsd.toFixed(6))
        });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `Local benchmark budget cap ($${maxBudgetUsd}) reached.`
          }
        }));
        return;
      }

      const wireSeq = ++state.wireSeq;
      state.requestsCount += 1;
      const fingerprint = extractRequestFingerprint(parsedReq, req.headers, urlPath);
      const hasTools = Boolean(parsedReq && Array.isArray(parsedReq.tools) && parsedReq.tools.length > 0);
      const isSideCall = !isMessagesEndpoint || !hasTools;
      if (isSideCall) state.sideCallsCount += 1;
      else state.mainRequestsCount += 1;

      let outboundBodyStr = rawBody;
      let requestedModel = parsedReq?.model || null;
      let mappedModel = requestedModel ? mapCliModelToOpenRouter(requestedModel) : null;

      if (parsedReq && typeof parsedReq === 'object' && isMessagesEndpoint) {
        const outbound = { ...parsedReq };
        outbound.model = mappedModel;
        if (pinProvider) {
          outbound.provider = {
            only: ['anthropic'],
            allow_fallbacks: false
          };
        }
        if (stripCacheTtl) {
          const stripFromArr = (arr) => Array.isArray(arr)
            ? arr.map((item) => {
                if (item?.cache_control?.ttl) {
                  const { ttl, ...restCc } = item.cache_control;
                  return { ...item, cache_control: restCc };
                }
                return item;
              })
            : arr;
          if (Array.isArray(outbound.tools)) outbound.tools = stripFromArr(outbound.tools);
          if (Array.isArray(outbound.system)) outbound.system = stripFromArr(outbound.system);
          if (Array.isArray(outbound.messages)) {
            outbound.messages = outbound.messages.map((m) => Array.isArray(m?.content)
              ? { ...m, content: stripFromArr(m.content) }
              : m);
          }
        }
        outboundBodyStr = JSON.stringify(outbound);
      }

      const targetPath = mapTargetPath(urlPath);
      const outHeaders = {
        'content-type': req.headers['content-type'] || 'application/json',
        'authorization': `Bearer ${resolvedApiKey}`,
        'accept-encoding': 'identity',
        'http-referer': 'https://github.com/<GITHUB_HANDLE>/<TARGET_REPO>',
        'x-title': '<PROJECT_NAME> Model-Switch Benchmark',
        'content-length': Buffer.byteLength(outboundBodyStr, 'utf8')
      };
      if (req.headers['anthropic-version']) {
        outHeaders['anthropic-version'] = req.headers['anthropic-version'];
      } else {
        outHeaders['anthropic-version'] = '2023-06-01';
      }
      if (req.headers['anthropic-beta']) {
        outHeaders['anthropic-beta'] = req.headers['anthropic-beta'];
      }
      if (req.headers['accept']) {
        outHeaders['accept'] = req.headers['accept'];
      }

      const upstreamReq = transport.request(
        {
          protocol: parsedUpstream.protocol,
          hostname: parsedUpstream.hostname,
          port: parsedUpstream.port || (parsedUpstream.protocol === 'http:' ? 80 : 443),
          path: targetPath,
          method: req.method || 'POST',
          headers: outHeaders
        },
        (upstreamRes) => {
          const statusCode = upstreamRes.statusCode || 502;
          const contentType = String(upstreamRes.headers['content-type'] || '');

          if (isCountTokens && statusCode >= 400) {
            upstreamRes.resume();
            const approxTokens = Math.max(1, Math.ceil(Buffer.byteLength(rawBody, 'utf8') / 4));
            const fallbackJson = JSON.stringify({ input_tokens: approxTokens });
            const latencyMs = Number(process.hrtime.bigint() - reqStartNs) / 1e6;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(fallbackJson);
            appendLog({
              wireSeq,
              timestamp: reqStartedAt,
              context: state.activeContext,
              urlPath,
              targetPath,
              isSideCall: true,
              countTokensFallback: true,
              upstreamStatus: statusCode,
              approxInputTokens: approxTokens,
              latencyMs: Number(latencyMs.toFixed(2))
            });
            return;
          }

          const clientHeaders = {};
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            const lk = k.toLowerCase();
            if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(lk)) continue;
            clientHeaders[k] = v;
          }
          res.writeHead(statusCode, clientHeaders);

          let firstByteNs = null;
          let messageStartNs = null;
          let firstContentDeltaNs = null;
          const resChunks = [];

          upstreamRes.on('data', (chunk) => {
            const nowNs = process.hrtime.bigint();
            if (firstByteNs === null) firstByteNs = nowNs;
            resChunks.push(chunk);
            if (!messageStartNs || !firstContentDeltaNs) {
              const s = chunk.toString('utf8');
              if (!messageStartNs && s.includes('message_start')) messageStartNs = nowNs;
              if (!firstContentDeltaNs && s.includes('content_block_delta')) firstContentDeltaNs = nowNs;
            }
            res.write(chunk);
          });

          upstreamRes.on('end', () => {
            res.end();
            const endNs = process.hrtime.bigint();
            const rawResText = Buffer.concat(resChunks).toString('utf8');
            const isSse = contentType.includes('text/event-stream') || rawResText.includes('event: message_start');

            let parsedRes = null;
            if (isSse) {
              parsedRes = parseSseTranscript(rawResText);
            } else {
              try {
                const json = JSON.parse(rawResText);
                parsedRes = {
                  messageId: json?.id || null,
                  responseModel: json?.model || null,
                  stopReason: json?.stop_reason || null,
                  usage: json?.usage || {},
                  eventCount: 0,
                  eventTypes: [],
                  errorPayload: json?.error || null
                };
              } catch {
                parsedRes = {
                  messageId: null,
                  responseModel: null,
                  stopReason: null,
                  usage: {},
                  eventCount: 0,
                  eventTypes: [],
                  errorPayload: statusCode >= 400 ? redactText(rawResText.slice(0, 600)) : null
                };
              }
            }

            const modelForPricing = mappedModel || parsedRes.responseModel || requestedModel || 'anthropic/claude-sonnet-4.6';
            const normalizedUsage = normalizeUsage(parsedRes.usage);
            const costBreakdown = computeUsageCostUsd(modelForPricing, parsedRes.usage);
            if (statusCode < 400) {
              state.totalSpendUsd += costBreakdown.totalCostUsd;
              if (state.totalSpendUsd >= maxBudgetUsd) {
                state.budgetExceeded = true;
              }
            }

            const latencyMs = Number(endNs - reqStartNs) / 1e6;
            const firstByteMs = firstByteNs !== null ? Number(firstByteNs - reqStartNs) / 1e6 : null;
            const ttfbMs = messageStartNs !== null
              ? Number(messageStartNs - reqStartNs) / 1e6
              : firstByteMs;
            const firstTokenMs = firstContentDeltaNs !== null
              ? Number(firstContentDeltaNs - reqStartNs) / 1e6
              : null;

            appendLog({
              wireSeq,
              timestamp: reqStartedAt,
              context: state.activeContext,
              urlPath,
              targetPath,
              isSideCall,
              statusCode,
              requestedModel,
              mappedModel,
              responseModel: parsedRes.responseModel,
              messageId: parsedRes.messageId,
              stopReason: parsedRes.stopReason,
              upstreamReportedCostUsd: typeof parsedRes.usage?.cost === 'number' ? parsedRes.usage.cost : null,
              upstreamHeaders: {
                openrouterProvider: upstreamRes.headers['x-openrouter-provider'] || null,
                requestId: upstreamRes.headers['x-request-id'] || upstreamRes.headers['request-id'] || null
              },
              usage: normalizedUsage,
              cost: costBreakdown,
              cumulativeSpendUsd: Number(state.totalSpendUsd.toFixed(6)),
              timing: {
                firstByteMs: firstByteMs !== null ? Number(firstByteMs.toFixed(2)) : null,
                ttfbMs: ttfbMs !== null ? Number(ttfbMs.toFixed(2)) : null,
                firstTokenMs: firstTokenMs !== null ? Number(firstTokenMs.toFixed(2)) : null,
                latencyMs: Number(latencyMs.toFixed(2))
              },
              sseEventCount: parsedRes.eventCount,
              sseEventTypes: parsedRes.eventTypes,
              errorPayload: parsedRes.errorPayload ? redactText(JSON.stringify(parsedRes.errorPayload)) : null,
              requestFingerprint: isMessagesEndpoint ? fingerprint : { urlPath, isSideCall: true }
            });
          });
        }
      );

      upstreamReq.on('error', (err) => {
        const latencyMs = Number(process.hrtime.bigint() - reqStartNs) / 1e6;
        appendLog({
          wireSeq,
          timestamp: reqStartedAt,
          context: state.activeContext,
          urlPath,
          isSideCall,
          statusCode: 502,
          errorPayload: redactText(err.message),
          timing: { latencyMs: Number(latencyMs.toFixed(2)) }
        });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Upstream error: ${redactText(err.message)}` }
        }));
      });

      upstreamReq.write(outboundBodyStr);
      upstreamReq.end();
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    wireLogPath,
    setContext(ctx) {
      state.activeContext = ctx ? { ...ctx } : null;
    },
    getState() {
      return { ...state, totalSpendUsd: Number(state.totalSpendUsd.toFixed(6)) };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
