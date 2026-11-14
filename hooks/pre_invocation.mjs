#!/usr/bin/env node
import { runStrictPreInvocation } from '../src/hooks/portfolio_runtime.mjs';
import { toProtoSafePreHookOutput } from '../src/hooks/pre_invocation.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe({ maxTimeoutMs: 500, settleMs: 15 })
  .then((input) => runStrictPreInvocation(input))
  .then((out) => {
    const safeOut = toProtoSafePreHookOutput(out, { isPreToolUse: false });
    process.stdout.write(JSON.stringify(safeOut) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
