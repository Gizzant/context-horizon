#!/usr/bin/env node
import { runStrictPostToolUse } from '../src/hooks/portfolio_runtime.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe({ maxTimeoutMs: 250, settleMs: 2 })
  .then(async (input) => {
    await runStrictPostToolUse(input);
    return {};
  })
  .then(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
