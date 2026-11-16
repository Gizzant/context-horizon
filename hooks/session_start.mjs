#!/usr/bin/env node
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';
import { handleAntigravityRslHook } from '../src/hooks/antigravity_rsl_hook.mjs';

readStdinSafe()
  .then((input) => {
    if (input?.workspacePaths?.[0] || input?.cwd) {
      try {
        handleAntigravityRslHook(input, { event: 'SessionStart' });
      } catch {
        // Fail open for RSL baseline
      }
    }
    return handleSessionStart(input);
  })
  .then((out) => {
    process.stdout.write(JSON.stringify(out && typeof out === 'object' ? out : {}) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
