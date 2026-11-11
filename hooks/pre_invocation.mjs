#!/usr/bin/env node
import { runStrictPreInvocation } from '../src/hooks/portfolio_runtime.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe({ maxTimeoutMs: 500, settleMs: 15 })
  .then((input) => runStrictPreInvocation(input))
  .then((out) => {
    process.stdout.write(JSON.stringify(out && typeof out === 'object' ? out : {}) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
