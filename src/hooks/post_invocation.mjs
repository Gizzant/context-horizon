import {
  readSidecarSync,
  writeSidecarAtomicSync,
  readToolUsageSync,
  writeToolUsageAtomicSync
} from '../core/sidecar_store.mjs';

async function readStdinSafe() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    }, 150);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

export async function handlePostInvocation(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);

  sidecar.sessionMeta.turnCount = (sidecar.sessionMeta.turnCount || 0) + 1;

  // Track subagent use
  const toolsInvoked = Array.isArray(inputData.toolsInvoked)
    ? inputData.toolsInvoked
    : (inputData.tool_calls || []).map(c => c.name || c.tool);

  const usedSubagent = toolsInvoked.some(t => t === 'invoke_subagent');
  sidecar.sessionMeta.lastTurnUsedSubagent = usedSubagent;

  // Update tool usage ledger for MCP tools
  const toolLedger = readToolUsageSync();
  toolLedger.servers = toolLedger.servers || {};
  let ledgerChanged = false;

  for (const t of toolsInvoked) {
    if (typeof t === 'string' && t.startsWith('mcp_')) {
      const parts = t.split('_');
      const server = parts[1];
      if (server) {
        if (!toolLedger.servers[server]) {
          toolLedger.servers[server] = { invocationsLast15Sessions: 1, lastUsedMs: Date.now() };
        } else {
          toolLedger.servers[server].invocationsLast15Sessions = (toolLedger.servers[server].invocationsLast15Sessions || 0) + 1;
          toolLedger.servers[server].lastUsedMs = Date.now();
        }
        ledgerChanged = true;
      }
    }
  }
  if (ledgerChanged) {
    writeToolUsageAtomicSync(toolLedger);
  }

  // Track consecutive trivial on max
  const effort = inputData.effort || sidecar.sessionMeta.activeEffort || 'high';
  const isMaxEffort = effort === 'max';
  const promptTokens = inputData.promptTokens || inputData.tokens || 100;
  if (isMaxEffort && promptTokens < 15) {
    sidecar.sessionMeta.consecutiveTrivialOnMax = (sidecar.sessionMeta.consecutiveTrivialOnMax || 0) + 1;
  } else {
    sidecar.sessionMeta.consecutiveTrivialOnMax = 0;
  }

  // Track error streak
  const hasError = inputData.exitCode !== undefined && inputData.exitCode !== null && inputData.exitCode !== 0;
  if (hasError || inputData.status === 'ERROR') {
    sidecar.sessionMeta.consecutiveErrorStreak = (sidecar.sessionMeta.consecutiveErrorStreak || 0) + 1;
  } else {
    sidecar.sessionMeta.consecutiveErrorStreak = 0;
  }

  // Track test runs
  const isTestRun = toolsInvoked.includes('run_command') && /(test|pytest|jest|vitest|cargo test)/i.test(inputData.command || '');
  if (isTestRun && inputData.exitCode === 0) {
    sidecar.sessionMeta.turnsSinceLastPassingTest = 0;
  } else {
    sidecar.sessionMeta.turnsSinceLastPassingTest = (sidecar.sessionMeta.turnsSinceLastPassingTest || 0) + 1;
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  return {};
}

// Auto-run if executed directly
const isMain = process.argv[1] && (process.argv[1].endsWith('post_invocation.mjs') || process.argv[1].endsWith('post_invocation.js'));
if (isMain) {
  readStdinSafe().then(input => {
    return handlePostInvocation(input);
  }).then(output => {
    console.log(JSON.stringify(output || {}));
    process.exit(0);
  }).catch(() => {
    console.log('{}');
    process.exit(0);
  });
}
