#!/usr/bin/env node
/**
 * @file packages/mcp/src/server.mjs
 * Zero-dependency MCP stdio JSON-RPC 2.0 server (`@ctxtop/mcp`) for Cursor, Windsurf,
 * Claude Code, and Google Antigravity.
 *
 * Supports both newline-delimited JSON-RPC and `Content-Length` framed stdio transport.
 * Exposes 4 local, zero-network tools:
 *   1. `horizon_status`
 *   2. `cache_gravity_check`
 *   3. `scope_lock_claim`
 *   4. `export_receipt_pdf`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLiveStateSnapshot } from '../../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { getSavedQuotaReceiptSummary } from '../../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { generateCorporateExpenseReceipt } from '../../../src/core-isomorphic/ui/pdfReceiptGenerator.mjs';
import { getProEntitlementStatus } from '../../../src/core/pro_license.mjs';
import { CacheGravityScorer } from '../../../src/core/task_quota_router.mjs';
import { ScopeLockRegistry, loadRegistry } from '../../../src/core/telemetry/scope_lock_registry.mjs';

export const MCP_SERVER_INFO = Object.freeze({
  name: '@ctxtop/mcp',
  version: '4.0.0',
  protocolVersion: '2024-11-05'
});

export const MCP_TOOLS = Object.freeze([
  {
    name: 'horizon_status',
    description: 'Read local Highbeam live telemetry, 30-day saved quota ledger, and @ctxtop/pro license status (zero network calls).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Workspace directory path' },
        sessionId: { type: 'string', description: 'Session or trajectory ID' }
      }
    }
  },
  {
    name: 'cache_gravity_check',
    description: 'Evaluate warm KV-cache break-even gravity before switching models or downshifting tiers.',
    inputSchema: {
      type: 'object',
      required: ['currentModel', 'targetModel'],
      properties: {
        currentModel: { type: 'string', description: 'Current active model ID' },
        targetModel: { type: 'string', description: 'Candidate target model ID' },
        cachedTokens: { type: 'number', description: 'Current warm cached prefix tokens' },
        ttlRemainingSeconds: { type: 'number', description: 'Remaining prompt-cache TTL in seconds' },
        remainingExpectedTurns: { type: 'number', description: 'Remaining expected turns in this session' },
        expectedOutputTokens: { type: 'number', description: 'Expected output tokens per turn' }
      }
    }
  },
  {
    name: 'scope_lock_claim',
    description: 'Inspect active multi-agent scope locks or acquire a DET-20 file-scope lease for a workspace path set.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceDir: { type: 'string', description: 'Workspace root directory' },
        sessionId: { type: 'string', description: 'Trajectory / session ID owning the lease' },
        agentId: { type: 'string', description: 'Tool/agent identifier (e.g., cursor, windsurf, claude-code)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Relative paths or globs to claim; omit for read-only inspection' },
        ttlSeconds: { type: 'number', description: 'Lease TTL in seconds (default 900)' }
      }
    }
  },
  {
    name: 'export_receipt_pdf',
    description: 'Generate a local SHA-256 verified Corporate PDF 1.4 Expense Receipt from 30-day saved-quota ledger telemetry.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Workspace root directory' },
        sessionId: { type: 'string', description: 'Session ID' },
        email: { type: 'string', description: 'Optional account email override' },
        outPath: { type: 'string', description: 'Optional output .pdf file path' },
        allowPreview: { type: 'boolean', description: 'Allow writing/previewing receipt when on Free tier (default false)' }
      }
    }
  }
]);

function executeHorizonStatusTool(args = {}, options = {}) {
  const cwd = args.cwd || options.cwd || process.cwd();
  const sessionId = args.sessionId || options.sessionId || 'default';
  const homeDir = args.homeDir || options.homeDir;
  const licensePath = args.licensePath || options.licensePath;
  const publicKeyPem = args.publicKeyPem || options.publicKeyPem;

  const live = readLiveStateSnapshot(sessionId, { cwd, ...(homeDir ? { homeDir } : {}) });
  const summary = getSavedQuotaReceiptSummary({ cwd, ...(homeDir ? { homeDir } : {}) });
  const entitlement = getProEntitlementStatus({
    ...(homeDir ? { homeDir } : {}),
    ...(licensePath ? { licensePath } : {}),
    ...(publicKeyPem ? { publicKeyPem } : {})
  });

  return {
    ok: true,
    cwd,
    sessionId,
    entitlement: {
      entitled: Boolean(entitlement.entitled),
      tier: entitlement.tier || 'free',
      source: entitlement.source || 'free'
    },
    savedQuota: summary,
    liveState: live || null
  };
}

function executeCacheGravityCheckTool(args = {}) {
  const scorer = new CacheGravityScorer();
  const cachedTokens = Number(args.cachedTokens || 0);
  const ttlRemainingSeconds = Number(args.ttlRemainingSeconds ?? 240);
  const expectedOutputTokens = Number(args.expectedOutputTokens ?? 1500);
  const remainingExpectedTurns = Math.max(1, Number(args.remainingExpectedTurns || 1));

  const verdict = scorer.computeBreakEven({
    currentModel: args.currentModel || 'claude-opus-5-5',
    targetModel: args.targetModel || 'claude-sonnet-5-5',
    targetEffort: args.targetEffort || 'low',
    cachedTokens,
    ttlRemainingSeconds,
    expectedOutputTokens
  });

  return {
    ok: true,
    remainingExpectedTurns,
    ...verdict
  };
}

function executeScopeLockClaimTool(args = {}, options = {}) {
  const workspaceDir = args.workspaceDir || args.cwd || options.cwd || process.cwd();
  const sessionId = args.sessionId || args.trajectoryId || options.sessionId || 'mcp-session';
  const toolName = args.agentId || args.tool || 'mcp';
  const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];

  if (paths.length === 0) {
    const reg = loadRegistry(workspaceDir);
    return {
      ok: true,
      mode: 'inspect',
      workspaceDir,
      activeLeases: reg.leases,
      leaseCount: reg.leases.length
    };
  }

  const registry = new ScopeLockRegistry({ workspaceDir, tool: toolName });
  const res = registry.acquireOrRenewLease({
    trajectoryId: sessionId,
    claimedPaths: paths,
    ttlSeconds: Number(args.ttlSeconds || 900)
  });

  return {
    mode: 'claim',
    workspaceDir,
    ...res
  };
}

function executeExportReceiptPdfTool(args = {}, options = {}) {
  const cwd = args.cwd || options.cwd || process.cwd();
  const homeDir = args.homeDir || options.homeDir;
  const licensePath = args.licensePath || options.licensePath;
  const publicKeyPem = args.publicKeyPem || options.publicKeyPem;

  const entitlement = getProEntitlementStatus({
    ...(homeDir ? { homeDir } : {}),
    ...(licensePath ? { licensePath } : {}),
    ...(publicKeyPem ? { publicKeyPem } : {})
  });
  const entitled = Boolean(entitlement.entitled);
  const previewOnly = !entitled;

  const summary = getSavedQuotaReceiptSummary({ cwd, ...(homeDir ? { homeDir } : {}) });
  const receipt = generateCorporateExpenseReceipt(summary, {
    email: args.email || entitlement.payload?.email || 'developer@workspace.local',
    tierLabel: 'Highbeam Pro ($15.00/mo)',
    subscriptionCostUSD: 15.0
  });

  let writtenPath = null;
  if (args.outPath && (entitled || Boolean(args.allowPreview))) {
    const resolvedOut = path.resolve(cwd, String(args.outPath));
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, Buffer.from(receipt.pdfBytes));
    writtenPath = resolvedOut;
  }

  return {
    ok: true,
    entitled,
    tier: entitlement.tier || 'free',
    previewOnly,
    receiptId: receipt.receiptId,
    sha256: receipt.sha256,
    pdfByteLength: receipt.pdfBytes.length,
    writtenPath,
    summary
  };
}

export async function handleMcpToolCall(name, args = {}, options = {}) {
  switch (String(name || '')) {
    case 'horizon_status':
      return executeHorizonStatusTool(args, options);
    case 'cache_gravity_check':
      return executeCacheGravityCheckTool(args);
    case 'scope_lock_claim':
      return executeScopeLockClaimTool(args, options);
    case 'export_receipt_pdf':
      return executeExportReceiptPdfTool(args, options);
    default: {
      const err = new Error(`Unknown MCP tool: ${name}`);
      err.code = -32601;
      throw err;
    }
  }
}

export async function handleMcpJsonRpcRequest(request, options = {}) {
  if (!request || typeof request !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }

  const id = request.id ?? null;
  const method = String(request.method || '');
  const params = request.params || {};

  if (method === 'notifications/initialized' || id === null && method.startsWith('notifications/')) {
    return null;
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion || MCP_SERVER_INFO.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: MCP_SERVER_INFO.name,
            version: MCP_SERVER_INFO.version
          }
        }
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      };
    }

    if (method === 'tools/call') {
      const toolName = String(params.name || '');
      try {
        const result = await handleMcpToolCall(toolName, params.arguments || {}, options);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false
          }
        };
      } catch (toolErr) {
        if (toolErr.code === -32601) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: toolErr.message }
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: toolErr.message }) }],
            isError: true
          }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err?.message || 'Internal error' }
    };
  }
}

function writeMcpMessage(stream, payload, useContentLength = false) {
  const json = JSON.stringify(payload);
  if (useContentLength) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    stream.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    stream.write(`${json}\n`);
  }
}

export function startMcpStdioServer(options = {}) {
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;
  let buffer = Buffer.alloc(0);

  const processPayloadText = async (text, useContentLength) => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed);
      const res = await handleMcpJsonRpcRequest(req, options);
      if (res !== null && req.id !== undefined) {
        writeMcpMessage(output, res, useContentLength);
      }
    } catch (err) {
      writeMcpMessage(
        output,
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } },
        useContentLength
      );
    }
  };

  input.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    while (buffer.length > 0) {
      const asStr = buffer.toString('utf8');
      if (/^Content-Length:\s*\d+/i.test(asStr)) {
        const sepIdx = buffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx === -1 ? buffer.indexOf('\n\n') : sepIdx;
        const sepLen = sepIdx !== -1 ? 4 : 2;
        if (lfSepIdx === -1) break;
        const header = buffer.slice(0, lfSepIdx).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        const contentLength = match ? Number(match[1]) : 0;
        const totalNeed = lfSepIdx + sepLen + contentLength;
        if (buffer.length < totalNeed) break;
        const body = buffer.slice(lfSepIdx + sepLen, totalNeed).toString('utf8');
        buffer = buffer.slice(totalNeed);
        await processPayloadText(body, true);
      } else {
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx === -1) break;
        const line = buffer.slice(0, nlIdx).toString('utf8');
        buffer = buffer.slice(nlIdx + 1);
        await processPayloadText(line, false);
      }
    }
  });
}

function isMainEntry(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch (err) {
    void err;
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

if (isMainEntry()) {
  startMcpStdioServer();
}
