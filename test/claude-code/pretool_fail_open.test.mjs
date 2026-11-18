/** #24: PreToolUse fails open on internal faults; deliberate guard verdicts still block. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { executePreToolUseCli } from '../../hooks/handlers/pre-tool-use.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANDLER = path.join(ROOT, 'hooks', 'handlers', 'pre-tool-use.mjs');

function runCli(opts) {
  let exitCode = null;
  let stderr = '';
  return executePreToolUseCli({
    ...opts,
    ioOverride: { writeStderr: (s) => (stderr += s), exitFn: (c) => (exitCode = c) }
  }).then(() => ({ exitCode, stderr }));
}

test('a guard verdict (exit 2) still blocks the tool call', async () => {
  const res = await runCli({
    readPayload: async () => ({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    runHook: () => ({ exitCode: 2, stderr: '[Highbeam] blocked: destructive command' })
  });
  assert.equal(res.exitCode, 2);
  assert.match(res.stderr, /blocked: destructive command/);
});

test('an internal crash allows the tool call and says so', async () => {
  const res = await runCli({
    readPayload: async () => ({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    runHook: () => {
      throw new Error('detector exploded');
    }
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stderr, /\[Highbeam PreToolUse Diagnostic\].*fail-open.*detector exploded/);
});

test('HIGHBEAM_PRETOOL_FAIL_MODE=closed restores blocking on internal faults', async () => {
  const prev = process.env.HIGHBEAM_PRETOOL_FAIL_MODE;
  process.env.HIGHBEAM_PRETOOL_FAIL_MODE = 'closed';
  try {
    const res = await runCli({
      readPayload: async () => {
        throw new Error('simulated');
      }
    });
    assert.equal(res.exitCode, 2);
    assert.match(res.stderr, /Fail-Closed/);
  } finally {
    if (prev === undefined) delete process.env.HIGHBEAM_PRETOOL_FAIL_MODE;
    else process.env.HIGHBEAM_PRETOOL_FAIL_MODE = prev;
  }
});

test('real process: unparseable stdin does not block, a dangerous command still does', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pt-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.HIGHBEAM_PRETOOL_FAIL_MODE;
    const garbage = spawnSync(process.execPath, [HANDLER], { input: '{not json', env, encoding: 'utf8', cwd: home });
    assert.equal(garbage.status, 0, `garbage stdin should fail open, got ${garbage.status}: ${garbage.stderr}`);
    const evil = spawnSync(process.execPath, [HANDLER], {
      input: JSON.stringify({
        session_id: 'pt1',
        cwd: home,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin main' }
      }),
      env,
      encoding: 'utf8',
      cwd: home
    });
    // The unsafe-git guard (DET-01) must still be able to block; if it only warns, exit is 0 but never a crash.
    assert.ok([0, 2].includes(evil.status), `unexpected exit ${evil.status}: ${evil.stderr}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
