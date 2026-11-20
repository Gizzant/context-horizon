import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {
  mapCliModelToOpenRouter,
  loadOpenRouterApiKey,
  normalizeUsage,
  computeUsageCostUsd
} from '../config.mjs';
import {
  extractRequestFingerprint,
  parseSseTranscript
} from '../proxy_recorder.mjs';
import { redactSensitiveText } from '../tests_3_to_8/prefix_lab.mjs';

export function resolveCptCaps(overrides = {}) {
  return {
    maxRetries: overrides.maxRetries ?? 3,
    maxHarnessTurns: overrides.maxHarnessTurns ?? 5, // 1 plan + 1 impl + 3 retries
    maxRequestsPerTurn: overrides.maxRequestsPerTurn ?? 30,
    maxRequestsPerRun: overrides.maxRequestsPerRun ?? 100,
    maxRunCostUsd: overrides.maxRunCostUsd ?? 3.0
  };
}

/**
 * Starts a local HTTP->HTTPS OpenRouter pass-through proxy tailored for
 * per-run variable-length benchmarks with real-time turn-request, run-request,
 * and dollar cost guards, plus per-model response timestamps for cache cooldown.
 */
export async function startCptProxyServer({
  port = 0,
  upstreamBaseUrl = 'https://openrouter.ai',
  upstreamApiPrefix = '/api',
  apiKey = null,
  wireLogPath,
  pinProvider = true,
  caps = resolveCptCaps(),
  onRequestObserve = null
} = {}) {
  const resolvedApiKey = apiKey || loadOpenRouterApiKey();
  fs.mkdirSync(path.dirname(wireLogPath), { recursive: true });
  const parsedUpstream = new URL(upstreamBaseUrl);
  const transport = parsedUpstream.protocol === 'http:' ? http : https;

  const state = {
    wireSeq: 0,
    runId: null,
    activeContext: null,
    runBilledUsd: 0,
    runMainRequests: 0,
    runSideCalls: 0,
    turnIndex: 0,
    turnMainRequests: 0,
    capReason: null,
    lastResponseAtMsByModel: new Map()
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
      const isMessagesEndpoint =
        /^\/(?:api\/)?v1\/messages(?:\?|$)/.test(urlPath) && !urlPath.includes('count_tokens');
      const isCountTokens = urlPath.includes('count_tokens');

      let parsedReq = null;
      try {
        parsedReq = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        parsedReq = null;
      }

      const hasTools = Boolean(parsedReq && Array.isArray(parsedReq.tools) && parsedReq.tools.length > 0);
      const isSideCall = !isMessagesEndpoint || !hasTools;

      // Enforce guards BEFORE forwarding if already capped or would exceed request cap
      if (!isSideCall) {
        if (!state.capReason && state.runBilledUsd >= caps.maxRunCostUsd) {
          state.capReason = 'cost_cap';
        } else if (!state.capReason && state.runMainRequests >= caps.maxRequestsPerRun) {
          state.capReason = 'run_request_cap';
        } else if (!state.capReason && state.turnMainRequests >= caps.maxRequestsPerTurn) {
          state.capReason = 'turn_request_cap';
        }
      }

      if (state.capReason && !isCountTokens) {
        const wireSeq = ++state.wireSeq;
        appendLog({
          wireSeq,
          timestamp: reqStartedAt,
          context: state.activeContext,
          urlPath,
          isSideCall,
          blockedByGuard: true,
          capReason: state.capReason,
          runBilledUsd: Number(state.runBilledUsd.toFixed(8))
        });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `Benchmark guard triggered: ${state.capReason}`
          }
        }));
        return;
      }

      const wireSeq = ++state.wireSeq;
      if (!isSideCall) {
        state.runMainRequests += 1;
        state.turnMainRequests += 1;
      } else {
        state.runSideCalls += 1;
      }
      const reqIndexInTurn = !isSideCall ? state.turnMainRequests : 0;
      const messagesArr = Array.isArray(parsedReq?.messages) ? parsedReq.messages : null;
      const messagesChars = messagesArr ? JSON.stringify(messagesArr).length : 0;
      const messagesCount = messagesArr ? messagesArr.length : 0;
      if (!isSideCall && messagesArr && typeof onRequestObserve === 'function') {
        try {
          onRequestObserve({
            runId: state.runId || state.activeContext?.runId || '',
            context: state.activeContext,
            reqIndexInTurn,
            parsedReq,
            messagesChars,
            messagesCount,
            urlPath
          });
        } catch {
          // Non-fatal request observer callback
        }
      }

      const fingerprint = extractRequestFingerprint(parsedReq, req.headers, urlPath);
      const requestedModel = parsedReq?.model || null;
      const mappedModel = requestedModel ? mapCliModelToOpenRouter(requestedModel) : null;

      let outboundBodyStr = rawBody;
      if (parsedReq && typeof parsedReq === 'object' && isMessagesEndpoint) {
        const outbound = { ...parsedReq };
        outbound.model = mappedModel;
        if (pinProvider) {
          outbound.provider = {
            only: ['anthropic'],
            allow_fallbacks: false
          };
        }
        outboundBodyStr = JSON.stringify(outbound);
      }

      const targetPath = mapTargetPath(urlPath);
      const outHeaders = {
        'content-type': req.headers['content-type'] || 'application/json',
        authorization: `Bearer ${resolvedApiKey}`,
        'accept-encoding': 'identity',
        'http-referer': 'https://github.com/<GITHUB_HANDLE>/<TARGET_REPO>',
        'x-title': '<PROJECT_NAME> Cost-Per-Task Benchmark',
        'content-length': Buffer.byteLength(outboundBodyStr, 'utf8')
      };
      outHeaders['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
      if (req.headers['anthropic-beta']) outHeaders['anthropic-beta'] = req.headers['anthropic-beta'];
      if (req.headers['accept']) outHeaders['accept'] = req.headers['accept'];

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
            const latencyMs = Number(process.hrtime.bigint() - reqStartNs) / 1e6;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ input_tokens: approxTokens }));
            appendLog({
              wireSeq,
              timestamp: reqStartedAt,
              context: state.activeContext,
              urlPath,
              targetPath,
              isSideCall: true,
              countTokensFallback: true,
              statusCode: 200,
              upstreamStatus: statusCode,
              approxInputTokens: approxTokens,
              timing: { latencyMs: Number(latencyMs.toFixed(2)) }
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
                  errorPayload: statusCode >= 400 ? redactSensitiveText(rawResText.slice(0, 600)) : null
                };
              }
            }

            const modelForPricing = mappedModel || parsedRes.responseModel || requestedModel || 'anthropic/claude-sonnet-5.5';
            const normalizedUsage = normalizeUsage(parsedRes.usage);
            const costBreakdown = computeUsageCostUsd(modelForPricing, parsedRes.usage);
            const upstreamReportedCostUsd =
              typeof parsedRes.usage?.cost === 'number' && Number.isFinite(parsedRes.usage.cost)
                ? parsedRes.usage.cost
                : null;
            const billedCostUsd = upstreamReportedCostUsd !== null ? upstreamReportedCostUsd : costBreakdown.totalCostUsd;
            const costSource = upstreamReportedCostUsd !== null ? 'openrouter_usage_cost' : 'computed_rate_card';

            if (statusCode < 400) {
              state.runBilledUsd += billedCostUsd;
              if (mappedModel && !isSideCall) {
                state.lastResponseAtMsByModel.set(mappedModel, Date.now());
              }
              if (!state.capReason && state.runBilledUsd >= caps.maxRunCostUsd) {
                state.capReason = 'cost_cap';
              }
            }

            const latencyMs = Number(endNs - reqStartNs) / 1e6;
            const firstByteMs = firstByteNs !== null ? Number(firstByteNs - reqStartNs) / 1e6 : null;
            const ttfbMs = messageStartNs !== null ? Number(messageStartNs - reqStartNs) / 1e6 : firstByteMs;
            const firstTokenMs = firstContentDeltaNs !== null ? Number(firstContentDeltaNs - reqStartNs) / 1e6 : null;

            appendLog({
              wireSeq,
              timestamp: reqStartedAt,
              completedAtUtc: new Date().toISOString(),
              context: state.activeContext,
              urlPath,
              targetPath,
              isSideCall,
              reqIndexInTurn,
              statusCode,
              requestedModel,
              mappedModel,
              responseModel: parsedRes.responseModel,
              messageId: parsedRes.messageId,
              stopReason: parsedRes.stopReason,
              upstreamReportedCostUsd,
              computedCostUsd: costBreakdown.totalCostUsd,
              billedCostUsd,
              costSource,
              upstreamHeaders: {
                openrouterProvider: upstreamRes.headers['x-openrouter-provider'] || null,
                requestId: upstreamRes.headers['x-request-id'] ? '[REDACTED_UPSTREAM_REQ_ID]' : null
              },
              usage: normalizedUsage,
              cost: costBreakdown,
              runCumulativeBilledUsd: Number(state.runBilledUsd.toFixed(8)),
              timing: {
                firstByteMs: firstByteMs !== null ? Number(firstByteMs.toFixed(2)) : null,
                ttfbMs: ttfbMs !== null ? Number(ttfbMs.toFixed(2)) : null,
                firstTokenMs: firstTokenMs !== null ? Number(firstTokenMs.toFixed(2)) : null,
                latencyMs: Number(latencyMs.toFixed(2))
              },
              sseEventCount: parsedRes.eventCount,
              sseEventTypes: parsedRes.eventTypes,
              errorPayload: parsedRes.errorPayload ? redactSensitiveText(JSON.stringify(parsedRes.errorPayload)) : null,
              messagesChars,
              messagesCount,
              requestFingerprint: isMessagesEndpoint ? fingerprint : { urlPath, isSideCall: true }
            });
            res.end();
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
          errorPayload: redactSensitiveText(err.message),
          timing: { latencyMs: Number(latencyMs.toFixed(2)) }
        });
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Upstream error: ${redactSensitiveText(err.message)}` }
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
    beginRun(runId) {
      state.runId = runId;
      state.runBilledUsd = 0;
      state.runMainRequests = 0;
      state.runSideCalls = 0;
      state.turnIndex = 0;
      state.turnMainRequests = 0;
      state.capReason = null;
    },
    beginTurn(turnNumber, context = {}) {
      state.turnIndex = turnNumber;
      state.turnMainRequests = 0;
      state.activeContext = { ...context, turn: turnNumber };
    },
    setContext(ctx) {
      state.activeContext = ctx ? { ...ctx } : null;
    },
    getState() {
      return {
        ...state,
        runBilledUsd: Number(state.runBilledUsd.toFixed(8)),
        lastResponseAtMsByModel: Object.fromEntries(state.lastResponseAtMsByModel.entries())
      };
    },
    getLastResponseAtMs(modelId) {
      const mapped = mapCliModelToOpenRouter(modelId);
      return state.lastResponseAtMsByModel.get(mapped) || 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
