#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runStrictPreToolUse } from '../src/hooks/portfolio_runtime.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';
import {
  parseControlFile,
  serializeControlFile,
  evaluateToolBoundaryLatch,
  waitForSuspensionResume
} from '../src/core-isomorphic/control/index.mjs';
import { MicroIpcClient } from '../src/engine-node/ipc/client.mjs';

async function checkControlLatchDirectOrIpc(input) {
  const sessionId = input?.sessionId || input?.session_id || 'default';
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const ctlPath = path.join(homeDir, '.ctxtop', 'runtime', `${sessionId}.ctl`);
  const hasCtlFile = fs.existsSync(ctlPath);

  if (!hasCtlFile && !input?.forceIpcCheck) {
    return { decision: 'allow' };
  }

  const ipcClient = new MicroIpcClient({ connectTimeoutMs: 10, requestTimeoutMs: 600000 });
  try {
    const verdict = await ipcClient.call(
      'hook.preToolUse',
      { ...input, sessionId },
      { connectTimeoutMs: 10, requestTimeoutMs: 600000 }
    );
    if (verdict && verdict.decision) {
      return verdict;
    }
  } catch (_ipcErr) {
    void _ipcErr;
  }

  if (!hasCtlFile) {
    return { decision: 'allow' };
  }

  try {
    const raw = fs.readFileSync(ctlPath, 'utf8');
    const state = parseControlFile(raw, sessionId);
    const latch = evaluateToolBoundaryLatch(state);

    if (latch.decision === 'deny') {
      return latch;
    }

    if (latch.decision === 'suspend') {
      // Non-spinning wait loop checking .ctl file
      const resume = await waitForSuspensionResume({
        checkControlStateFn: () => {
          if (!fs.existsSync(ctlPath)) return { state: 'RUNNING' };
          return parseControlFile(fs.readFileSync(ctlPath, 'utf8'), sessionId);
        },
        pollIntervalMs: 50,
        timeoutMs: 600000
      });
      return resume;
    }

    if (latch.decision === 'allow' && latch.consumeStep) {
      // Transition state to PAUSED
      const next = { ...state, state: 'PAUSED', stepRemaining: 0, updatedAt: Date.now() };
      fs.writeFileSync(ctlPath, serializeControlFile(next), 'utf8');
    }

    return latch;
  } catch (_err) {
    void _err;
    return { decision: 'allow' };
  }
}

readStdinSafe({ maxTimeoutMs: 250, settleMs: 2 })
  .then(async (input) => {
    const controlVerdict = await checkControlLatchDirectOrIpc(input);
    if (controlVerdict && (controlVerdict.decision === 'deny' || controlVerdict.decision === 'block')) {
      return { decision: 'deny', reason: controlVerdict.reason || 'Execution halted by control latch' };
    }
    return runStrictPreToolUse(input);
  })
  .then((out) => {
    const safe = out && ['allow', 'ask', 'deny'].includes(out.decision)
      ? (out.reason ? { decision: out.decision, reason: String(out.reason) } : { decision: out.decision })
      : { decision: 'allow' };
    process.stdout.write(JSON.stringify(safe) + '\n');
    process.exit(0);
  })
  .catch((err) => {
    void err;
    process.stdout.write('{"decision":"allow"}\n');
    process.exit(0);
  });
