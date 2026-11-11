#!/usr/bin/env node
import { runStrictPreToolUse } from '../src/hooks/portfolio_runtime.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe({ maxTimeoutMs: 500, settleMs: 15 })
  .then((input) => runStrictPreToolUse(input))
  .then((out) => {
    const safe = out && ['allow', 'ask', 'deny'].includes(out.decision)
      ? (out.reason ? { decision: out.decision, reason: String(out.reason) } : { decision: out.decision })
      : { decision: 'allow' };
    process.stdout.write(JSON.stringify(safe) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{"decision":"allow"}\n');
    process.exit(0);
  });
