#!/usr/bin/env node
import { runStrictPostToolUse } from '../src/hooks/portfolio_runtime.mjs';
import { handlePostInvocation, readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe({ maxTimeoutMs: 500, settleMs: 15 })
  .then(async (input) => {
    await runStrictPostToolUse(input);
    await handlePostInvocation(input);
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
