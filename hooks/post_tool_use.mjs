#!/usr/bin/env node
import { runStrictPostToolUse } from '../src/hooks/portfolio_runtime.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';
import { handleAntigravityRslHook } from '../src/hooks/antigravity_rsl_hook.mjs';

readStdinSafe({ maxTimeoutMs: 250, settleMs: 2 })
  .then(async (input) => {
    if (input?.workspacePaths?.[0] || input?.cwd) {
      try {
        handleAntigravityRslHook(input, { event: 'PostToolUse' });
      } catch {
        // Fail open for RSL step telemetry
      }
    }
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
