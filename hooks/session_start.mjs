#!/usr/bin/env node
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe()
  .then((input) => handleSessionStart(input))
  .then((out) => {
    process.stdout.write(JSON.stringify(out && typeof out === 'object' ? out : {}) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
