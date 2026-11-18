/**
 * @file src/hooks/daemon_hook_bridge.mjs
 * Warm-daemon JSON-RPC hook bridge registering full PreToolUse, PostToolUse,
 * PreInvocation, and PostInvocation handlers on MicroIpcServer.
 *
 * Modules are lazily loaded on first RPC call so Horizon Daemon HTTP/UI boot
 * adds 0ms startup latency, while keeping all subsequent hook RPCs (<1ms) in V8 memory.
 */

// The daemon process never imports a Tier-2 CLI entrypoint, so register the Node
// I/O adapter here. Without it writeTextAtomic()/appendJsonlSafe() return false and
// PostToolUse cannot write artifacts or ledger lines over IPC.
import '../utils/nodeIo.mjs';

let cachedClaudePreMod = null;
let cachedClaudePostMod = null;
let cachedAgPreMod = null;
let cachedAgPostMod = null;
let cachedPortfolioMod = null;
let cachedAgRslMod = null;

async function getClaudePreMod() {
  if (!cachedClaudePreMod) {
    cachedClaudePreMod = await import('../../hooks/handlers/pre-tool-use-core.mjs');
  }
  return cachedClaudePreMod;
}

async function getClaudePostMod() {
  if (!cachedClaudePostMod) {
    cachedClaudePostMod = await import('../../hooks/handlers/post-tool-use-core.mjs');
  }
  return cachedClaudePostMod;
}

async function getAgPreMod() {
  if (!cachedAgPreMod) {
    cachedAgPreMod = await import('./pre_invocation_core.mjs');
  }
  return cachedAgPreMod;
}

async function getAgPostMod() {
  if (!cachedAgPostMod) {
    cachedAgPostMod = await import('./post_invocation_core.mjs');
  }
  return cachedAgPostMod;
}

async function getPortfolioMod() {
  if (!cachedPortfolioMod) {
    cachedPortfolioMod = await import('./portfolio_runtime.mjs');
  }
  return cachedPortfolioMod;
}

async function getAgRslMod() {
  if (!cachedAgRslMod) {
    cachedAgRslMod = await import('./antigravity_rsl_hook.mjs');
  }
  return cachedAgRslMod;
}

function toProtoSafePreOutput(output, { isPreToolUse = false } = {}) {
  const out = output && typeof output === 'object' ? output : {};
  if (isPreToolUse) {
    const rawDecision = String(out.decision || '').toLowerCase();
    let decision = 'allow';
    if (
      rawDecision === 'deny' ||
      rawDecision === 'block' ||
      out.blocked === true ||
      out.terminationBehavior === 'terminate'
    ) {
      decision = 'deny';
    } else if (rawDecision === 'ask') {
      decision = 'ask';
    }
    const reasonText =
      out.reason || out.errorMessage?.userMessage || out.userMessage || out.systemMessage || out.ephemeralMessage;
    if (decision !== 'allow' && reasonText) {
      return { decision, reason: String(reasonText) };
    }
    return { decision };
  }

  if (out.terminationBehavior === 'terminate') {
    const userMessage = String(
      out.errorMessage?.userMessage ||
        out.userMessage ||
        out.reason ||
        out.systemMessage ||
        'Halted by Highbeam Flightcheck'
    );
    return {
      terminationBehavior: 'terminate',
      errorMessage: { userMessage }
    };
  }
  const advisory = out.ephemeralMessage || out.systemMessage;
  if (typeof advisory === 'string' && advisory.trim().length > 0) {
    return { ephemeralMessage: advisory };
  }
  return {};
}

/**
 * Registers full warm-daemon hook JSON-RPC handlers on a `MicroIpcServer` instance
 * while preserving the server's built-in `hook.preToolUse` and `hook.postToolUse` methods.
 *
 * @param {import('../engine-node/ipc/server.mjs').MicroIpcServer} ipcServer
 */
export function registerDaemonHookRpcMethods(ipcServer) {
  if (!ipcServer || typeof ipcServer.registerMethod !== 'function') {
    return;
  }

  const checkLatch = async (latchParams, socket, id) => {
    const basePre = ipcServer.methods?.get('hook.preToolUse');
    if (typeof basePre !== 'function') return { decision: 'allow' };
    return basePre(latchParams, socket, id);
  };

  ipcServer.registerMethod('hook.claude.preToolUse', async (params = {}, socket, id) => {
    const event = params?.event && typeof params.event === 'object' ? params.event : {};
    const latch = await checkLatch(
      {
        sessionId: event.session_id || event.sessionId || 'default',
        flightMode: event.mode || 'COACH'
      },
      socket,
      id
    );
    if (latch?.decision === 'deny' || latch?.decision === 'block') {
      return {
        fullVerdict: true,
        exitCode: 2,
        stdout: '',
        stderr:
          latch.reason ||
          latch.hookSpecificOutput?.permissionDecisionReason ||
          '[Highbeam] Tool execution denied'
      };
    }

    const { runPreToolUseHook } = await getClaudePreMod();
    const res = runPreToolUseHook(event, { persistState: true, ...(params?.options || {}) });
    return {
      fullVerdict: true,
      exitCode: res?.exitCode ?? 0,
      stdout: res?.stdout || '',
      stderr: res?.stderr || '',
      verdict: res?.verdict || null
    };
  });

  ipcServer.registerMethod('hook.claude.postToolUse', async (params = {}) => {
    const event = params?.event && typeof params.event === 'object' ? params.event : {};
    const { runPostToolUseHook } = await getClaudePostMod();
    const res = runPostToolUseHook(event, { persistState: true, ...(params?.options || {}) });
    return {
      fullVerdict: true,
      exitCode: res?.exitCode ?? 0,
      stdout: res?.stdout || '',
      stderr: res?.stderr || ''
    };
  });

  ipcServer.registerMethod('hook.antigravity.preInvocation', async (params = {}, socket, id) => {
    const input = params?.input && typeof params.input === 'object' ? params.input : {};
    const isPreToolUse = Boolean(params?.isPreToolUse);
    if (isPreToolUse) {
      const latch = await checkLatch(
        {
          sessionId: input.conversationId || input.session_id || input.sessionId || 'default',
          flightMode: input.flightMode || 'COACH'
        },
        socket,
        id
      );
      if (latch?.decision === 'deny' || latch?.decision === 'block') {
        return {
          fullVerdict: true,
          safeOut: {
            decision: 'deny',
            reason: latch.reason || 'Execution halted by control latch'
          }
        };
      }
    }

    const { handlePreInvocation } = await getAgPreMod();
    const out = await handlePreInvocation(input);
    return {
      fullVerdict: true,
      safeOut: toProtoSafePreOutput(out, { isPreToolUse })
    };
  });

  ipcServer.registerMethod('hook.antigravity.postInvocation', async (params = {}) => {
    const input = params?.input && typeof params.input === 'object' ? params.input : {};
    const { handlePostInvocation } = await getAgPostMod();
    await handlePostInvocation(input);
    return {
      fullVerdict: true,
      safeOut: {}
    };
  });

  ipcServer.registerMethod('hook.antigravity.strictPreToolUse', async (params = {}, socket, id) => {
    const input = params?.input && typeof params.input === 'object' ? params.input : {};
    const latch = await checkLatch(
      {
        sessionId: input.sessionId || input.session_id || input.conversationId || 'default',
        flightMode: input.flightMode || 'COACH'
      },
      socket,
      id
    );
    if (latch?.decision === 'deny' || latch?.decision === 'block') {
      return {
        fullVerdict: true,
        safeOut: {
          decision: 'deny',
          reason: latch.reason || 'Execution halted by control latch'
        }
      };
    }

    const { runStrictPreToolUse } = await getPortfolioMod();
    const out = await runStrictPreToolUse(input);
    const safeOut =
      out && ['allow', 'ask', 'deny'].includes(out.decision)
        ? out.reason
          ? { decision: out.decision, reason: String(out.reason) }
          : { decision: out.decision }
        : { decision: 'allow' };
    return {
      fullVerdict: true,
      safeOut
    };
  });

  ipcServer.registerMethod('hook.antigravity.strictPostToolUse', async (params = {}) => {
    const input = params?.input && typeof params.input === 'object' ? params.input : {};
    if (input?.workspacePaths?.[0] || input?.cwd) {
      try {
        const { handleAntigravityRslHook } = await getAgRslMod();
        handleAntigravityRslHook(input, { event: 'PostToolUse' });
      } catch {
        // Fail open for RSL step telemetry
      }
    }
    const { runStrictPostToolUse } = await getPortfolioMod();
    await runStrictPostToolUse(input);
    return {
      fullVerdict: true,
      safeOut: {}
    };
  });
}
