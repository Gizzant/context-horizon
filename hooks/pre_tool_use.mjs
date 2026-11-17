#!/usr/bin/env node
/**
 * @file hooks/pre_tool_use.mjs
 * Thin Fast-Shell for root `hooks.json` `PreToolUse`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  tryFastDaemonRpc,
  canFastAllowBoundedRead,
  readStdinFast
} from '../src/hooks/fast_hook_ipc.mjs';

async function evaluateControlLatchOrFastIpc(input) {
  const sessionId = input?.sessionId || input?.session_id || 'default';
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const ctlPath = path.join(homeDir, '.ctxtop', 'runtime', `${sessionId}.ctl`);
  const hasCtlFile = fs.existsSync(ctlPath);

  if (!hasCtlFile && !input?.forceIpcCheck) {
    if (process.env.CTXTOP_IPC_PATH) {
      const ipcRes = await tryFastDaemonRpc('hook.antigravity.strictPreToolUse', { input });
      if (ipcRes && ipcRes.fullVerdict === true && ipcRes.safeOut) {
        return { fastHandled: true, safeOut: ipcRes.safeOut };
      }
    }
    if (canFastAllowBoundedRead(input, { platform: 'antigravity' })) {
      return { fastHandled: true, safeOut: { decision: 'allow' } };
    }
    return { fastHandled: false };
  }

  const fastVerdict = await tryFastDaemonRpc('hook.antigravity.strictPreToolUse', { input });
  if (fastVerdict && fastVerdict.fullVerdict === true && fastVerdict.safeOut) {
    return { fastHandled: true, safeOut: fastVerdict.safeOut };
  }

  const [{ MicroIpcClient }, controlMod] = await Promise.all([
    import('../src/engine-node/ipc/client.mjs'),
    import('../src/core-isomorphic/control/index.mjs')
  ]);
  const ipcClient = new MicroIpcClient({ connectTimeoutMs: 10, requestTimeoutMs: 600000 });
  try {
    const verdict = await ipcClient.call(
      'hook.preToolUse',
      { ...input, sessionId },
      { connectTimeoutMs: 10, requestTimeoutMs: 600000 }
    );
    if (verdict && verdict.decision) {
      if (verdict.decision === 'deny' || verdict.decision === 'block') {
        return {
          fastHandled: true,
          safeOut: { decision: 'deny', reason: verdict.reason || 'Execution halted by control latch' }
        };
      }
      return { fastHandled: false };
    }
  } catch (_ipcErr) {
    void _ipcErr;
  }

  if (hasCtlFile) {
    try {
      const raw = fs.readFileSync(ctlPath, 'utf8');
      const state = controlMod.parseControlFile(raw, sessionId);
      const latch = controlMod.evaluateToolBoundaryLatch(state);

      if (latch.decision === 'deny' || latch.decision === 'block') {
        return {
          fastHandled: true,
          safeOut: { decision: 'deny', reason: latch.reason || 'Execution halted by control latch' }
        };
      }

      if (latch.decision === 'suspend') {
        const resume = await controlMod.waitForSuspensionResume({
          checkControlStateFn: () => {
            if (!fs.existsSync(ctlPath)) return { state: 'RUNNING' };
            return controlMod.parseControlFile(fs.readFileSync(ctlPath, 'utf8'), sessionId);
          },
          pollIntervalMs: 50,
          timeoutMs: 600000
        });
        if (resume && (resume.decision === 'deny' || resume.decision === 'block')) {
          return {
            fastHandled: true,
            safeOut: { decision: 'deny', reason: resume.reason || 'Execution halted by control latch' }
          };
        }
      }

      if (latch.decision === 'allow' && latch.consumeStep) {
        const next = { ...state, state: 'PAUSED', stepRemaining: 0, updatedAt: Date.now() };
        fs.writeFileSync(ctlPath, controlMod.serializeControlFile(next), 'utf8');
      }
    } catch (_err) {
      void _err;
    }
  }

  return { fastHandled: false };
}

readStdinFast({ maxTimeoutMs: 250, settleMs: 2 })
  .then(async (input) => {
    const preCheck = await evaluateControlLatchOrFastIpc(input);
    if (preCheck.fastHandled) {
      return preCheck.safeOut;
    }
    const { runStrictPreToolUse } = await import('../src/hooks/portfolio_runtime.mjs');
    const out = await runStrictPreToolUse(input);
    return out && ['allow', 'ask', 'deny'].includes(out.decision)
      ? out.reason
        ? { decision: out.decision, reason: String(out.reason) }
        : { decision: out.decision }
      : { decision: 'allow' };
  })
  .then((safe) => {
    process.stdout.write(JSON.stringify(safe) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{"decision":"allow"}\n');
    process.exit(0);
  });
