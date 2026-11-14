#!/usr/bin/env node
import { handleSessionStart, toProtoSafeSessionStartOutput } from '../src/hooks/session_start.mjs';
import { readStdinSafe } from '../src/hooks/post_invocation.mjs';

readStdinSafe()
  .then((input) => handleSessionStart(input))
  .then((out) => {
    const safeOut = toProtoSafeSessionStartOutput(out);
    process.stdout.write(JSON.stringify(safeOut) + '\n');
    process.exit(0);
  })
  .catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
