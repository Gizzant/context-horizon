#!/usr/bin/env node
import { handlePostInvocation, readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe({ maxTimeoutMs: 500, settleMs: 15 })
  .then((input) => handlePostInvocation({ ...input, hook_event_name: 'Stop' }))
  .then(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
