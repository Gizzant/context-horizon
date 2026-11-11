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
import { recordHookDiagnostic } from '../core/hook_diagnostics.mjs';

async function readStdinSafe({ maxTimeoutMs = 1000, settleMs = 50 } = {}) {
  if (process.stdin.isTTY || process.stdin.readableEnded) return {};
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    let settleTimer = null;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        process.stdin.pause();
      } catch (err) {
        recordHookDiagnostic('session_start', 'stdin.pause', err, { persist: false });
      }
      resolve(val);
    };

    const tryParse = () => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch (err) {
        recordHookDiagnostic('session_start', 'stdin.parse', err);
        return {};
      }
    };

    const maxTimer = setTimeout(() => finish(tryParse()), maxTimeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      raw += chunk;
      if (settleTimer) clearTimeout(settleTimer);
      if (raw.trim().endsWith('}')) {
        settleTimer = setTimeout(() => {
          try {
            finish(JSON.parse(raw));
          } catch (err) {
            recordHookDiagnostic('session_start', 'stdin.settleParse', err, { persist: false });
          }
        }, settleMs);
      }
    });
    process.stdin.on('end', () => finish(tryParse()));
    process.stdin.on('error', (err) => {
      recordHookDiagnostic('session_start', 'stdin.error', err);
      finish({});
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
      schemaTokens += Math.max(0, Number(s.tokenCount ?? 0) || 0);
    }
    writeToolUsageAtomicSync(toolLedger);
  }

  if (schemaTokens > 0) {
    const config = loadFlightcheckConfig();
    const ceiling = resolveModelCeiling(activeModel, inputData.context_window || inputData.contextWindow, { config });
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
  }).catch((err) => {
    recordHookDiagnostic('session_start', 'main', err);
    console.log('{}');
    process.exit(0);
  });
}
