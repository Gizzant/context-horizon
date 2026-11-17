#!/usr/bin/env node
/**
 * Minimal local stdio JSON-RPC 2.0 MCP server exposing 10 deterministic synthetic tools
 * (~2.5k tokens of tool schemas) for T6 CC-T (--mcp-config) experiments.
 */
import readline from 'node:readline';

function buildSchema(idx) {
  return {
    type: 'object',
    properties: {
      target_id: {
        type: 'string',
        description: `Primary workspace object identifier for MCP tool #${idx} inspection and deterministic state correlation.`
      },
      window_start_iso: {
        type: 'string',
        description: `Inclusive ISO-8601 UTC boundary marking the beginning of telemetry aggregation for MCP tool #${idx}.`
      },
      window_end_iso: {
        type: 'string',
        description: `Exclusive ISO-8601 UTC boundary marking the end of telemetry aggregation for MCP tool #${idx}.`
      },
      strict_mode: {
        type: 'boolean',
        description: `When true, enforces read-only invariant validation and schema checksum checks on MCP tool #${idx} results.`
      }
    },
    required: ['target_id']
  };
}

const TOOLS = Array.from({ length: 10 }, (_, i) => {
  const num = String(i + 1).padStart(2, '0');
  return {
    name: `bench_mcp_tool_${num}`,
    description:
      `Synthetic benchmark MCP tool ${num} designed for deterministic prompt-cache tool-layer invalidation measurement. ` +
      `Inspects immutable state segment ${num}, validates monotonic sequence markers, and returns structured JSON without modifying files.`,
    inputSchema: buildSchema(num)
  };
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: req?.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bench_mcp', version: '1.0.0' }
      }
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    if (id !== undefined && id !== null) {
      send({ jsonrpc: '2.0', id, result: {} });
    }
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    });
    return;
  }
  if (method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: req?.params?.name || 'unknown' }) }]
      }
    });
    return;
  }
  if (id !== undefined && id !== null) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
});
