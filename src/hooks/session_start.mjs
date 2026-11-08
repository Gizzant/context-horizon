import {
  createDefaultSidecar,
  writeSidecarAtomicSync,
  readSidecarSync,
  readToolUsageSync,
  writeToolUsageAtomicSync
} from '../core/sidecar_store.mjs';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import { loadFlightcheckConfig } from '../core/config.mjs';
import { resolveModelCeiling } from '../core/constants.mjs';

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

export async function handleSessionStart(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const workspacePath = canonicalizePath(inputData.workspacePath || process.cwd());
  const activeModel = inputData.modelName || inputData.model?.id || 'gemini-3.8-flash';
  const activeEffort = inputData.effort || 'high';

  let sidecar = readSidecarSync(conversationId);
  if (!sidecar.conversationId || sidecar.sessionMeta.turnCount === 0) {
    sidecar = createDefaultSidecar(conversationId, workspacePath);
  }

  sidecar.sessionMeta.activeModel = activeModel;
  sidecar.sessionMeta.activeEffort = activeEffort;
  sidecar.sessionMeta.inPlanMode = inputData.mode === 'plan';

  // Audit Turn 0 MCP Schemas if provided
  let schemaTokens = 0;
  const toolLedger = readToolUsageSync();
  toolLedger.servers = toolLedger.servers || {};

  if (Array.isArray(inputData.mcpServers)) {
    for (const s of inputData.mcpServers) {
      const sName = s.name || String(s);
      if (!toolLedger.servers[sName]) {
        toolLedger.servers[sName] = { invocationsLast15Sessions: 0, sessionsSeen: 1 };
      } else {
        toolLedger.servers[sName].sessionsSeen = (toolLedger.servers[sName].sessionsSeen || 0) + 1;
      }
      schemaTokens += s.tokenCount || 1500;
    }
    writeToolUsageAtomicSync(toolLedger);
  }

  if (schemaTokens > 0) {
    const config = loadFlightcheckConfig();
    const ceiling = resolveModelCeiling(modelId, inputData.context_window || inputData.contextWindow, { config });
    sidecar.sensors.schemaTaxPct = Number(((schemaTokens / (ceiling || 256000)) * 100).toFixed(1));
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  return {};
}

// Auto-run when executed directly
const isMain = process.argv[1] && (process.argv[1].endsWith('session_start.mjs') || process.argv[1].endsWith('session_start.js'));
if (isMain) {
  readStdinSafe().then(input => {
    return handleSessionStart(input);
  }).then(output => {
    console.log(JSON.stringify(output || {}));
    process.exit(0);
  }).catch(() => {
    console.log('{}');
    process.exit(0);
  });
}
