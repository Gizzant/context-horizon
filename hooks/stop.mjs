#!/usr/bin/env node
import { handlePostInvocation, readStdinSafe } from '../src/hooks/post_invocation.mjs';
import { handleAntigravityRslHook } from '../src/hooks/antigravity_rsl_hook.mjs';

readStdinSafe({ maxTimeoutMs: 500, settleMs: 15 })
  .then(async (input) => {
    if (input?.workspacePaths?.[0] || input?.cwd) {
      try {
        handleAntigravityRslHook(input, { event: 'Stop' });
      } catch {
        // Fail open for RSL post-mortem
      }
    }
    return handlePostInvocation({ ...input, hook_event_name: 'Stop' });
  })
  .then(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
