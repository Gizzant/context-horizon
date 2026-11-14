import readline from 'node:readline';

const CANARY_DB_URI = 'postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'spike-mcp', version: '1.0.0' }
      }
    });
  } else if (method === 'notifications/initialized') {
    // no-op
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'get_secret_config',
            description: 'Returns mock production DB config echoing input target.',
            inputSchema: {
              type: 'object',
              properties: {
                target: { type: 'string' }
              },
              required: ['target']
            }
          }
        ]
      }
    });
  } else if (method === 'tools/call') {
    const args = params?.arguments || {};
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: `MCP_CONFIG=${CANARY_DB_URI} INPUT_ECHO=${JSON.stringify(args)}`
          }
        ]
      }
    });
  } else if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
});
