/**
 * @file test/antigravity_toolcall_payload.test.mjs
 * Fix list #15: Antigravity sends PreToolUse as `{ toolCall: { name, args } }`
 * (https://antigravity.google/docs/hooks). The guards read `tool_name` / `tool_input`, so every
 * Antigravity tool call looked empty and `git push --force` was allowed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { normalizeAntigravityToolPayload } from '../src/hooks/antigravity_payload.mjs';
import { handlePreInvocation, applyCoachHaltPolicy } from '../src/hooks/pre_invocation_core.mjs';
import { toProtoSafePreHookOutput } from '../src/hooks/pre_invocation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function agPayload(commandLine, cwd) {
  return {
    toolCall: { name: 'run_command', args: { CommandLine: commandLine, Cwd: cwd } },
    stepIdx: 19,
    conversationId: `ag-toolcall-${Math.random().toString(36).slice(2)}`,
    workspacePaths: [cwd],
    transcriptPath: '',
    artifactDirectoryPath: '',
    modelName: 'gemini-4-carbon',
    lastUserInput: 'push it'
  };
}

test('normalizer maps toolCall/hookEventName and keeps existing fields', () => {
  const n = normalizeAntigravityToolPayload({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, hookEventName: 'PreToolUse' });
  assert.equal(n.tool_name, 'run_command');
  assert.deepEqual(n.tool_input, { CommandLine: 'ls' });
  assert.equal(n.hook_event_name, 'PreToolUse');

  const s = normalizeAntigravityToolPayload({ toolCall: { name: 'run_command', arguments: '{"CommandLine":"pwd"}' } });
  assert.deepEqual(s.tool_input, { CommandLine: 'pwd' });

  const keep = normalizeAntigravityToolPayload({ tool_name: 'Bash', tool_input: { command: 'x' }, toolCall: { name: 'run_command', args: {} } });
  assert.equal(keep.tool_name, 'Bash');

  const preInv = normalizeAntigravityToolPayload({ invocationNum: 3, lastUserInput: 'hi' });
  assert.equal(preInv.tool_name, undefined);
  assert.equal(preInv.hook_event_name, undefined);
});

test('core denies git push --force sent in Antigravity toolCall shape', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ag-toolcall-'));
  try {
    const res = await handlePreInvocation(agPayload('git push --force origin main', cwd));
    assert.equal(String(res.decision).toLowerCase() === 'deny' || String(res.decision).toLowerCase() === 'block' || res.terminationBehavior === 'terminate', true, JSON.stringify(res));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('hook entrypoint replies {"decision":"deny"} for the Antigravity shape and allows a safe command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ag-toolcall-cli-'));
  const env = { ...process.env, CTXTOP_IPC_PATH: path.join(cwd, 'no-daemon.sock') };
  try {
    const script = path.join(ROOT, 'src', 'hooks', 'pre_invocation.mjs');
    const run = (cmd) => spawnSync(process.execPath, ['--no-warnings', script, '--event=PreToolUse'], {
      input: JSON.stringify(agPayload(cmd, cwd)), env, encoding: 'utf8', timeout: 20000
    });
    const bad = run('git push --force origin main');
    assert.equal(bad.status, 0);
    const badOut = JSON.parse(bad.stdout.trim().split('\n').pop());
    assert.equal(badOut.decision, 'deny');
    assert.match(badOut.reason, /git push --force/);

    const ok = run('git status');
    assert.equal(JSON.parse(ok.stdout.trim().split('\n').pop()).decision, 'allow');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('COACH keeps only the 3-strike loop, explicit blocks and #check as prompt stops', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ag-coach-'));
  try {
    const coach = { cwd, flightMode: 'COACH' };
    const amp = applyCoachHaltPolicy({ terminationBehavior: 'terminate', userMessage: '[Amputation Crisis] card', haltKey: 'AMPUTATION_CRISIS' }, coach);
    assert.equal(amp.terminationBehavior, undefined);
    assert.equal(amp.systemMessage, '[Amputation Crisis] card');
    assert.equal(amp.coachAdvisory, true);

    for (const kept of [
      { terminationBehavior: 'terminate', userMessage: 'loop', haltKey: 'THREE_STRIKE_LOOP' },
      { terminationBehavior: 'terminate', userMessage: 'b', decision: 'block', explicitBlock: true },
      { terminationBehavior: 'terminate', userMessage: 'scorecard', userRequested: true }
    ]) {
      assert.equal(applyCoachHaltPolicy(kept, coach).terminationBehavior, 'terminate');
    }
    // Not COACH: unchanged (AUTO_PILOT needs a licence; SILENT stands in for "another mode" here).
    const silent = applyCoachHaltPolicy({ terminationBehavior: 'terminate', userMessage: 'x', haltKey: 'QUOTA_FLOOR' }, { cwd, flightMode: 'SILENT' });
    assert.equal(silent.terminationBehavior, 'terminate');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('prompt stop uses the documented Antigravity shape (injectSteps + terminationBehavior)', () => {
  const out = toProtoSafePreHookOutput({ terminationBehavior: 'terminate', userMessage: 'Stop' });
  assert.deepEqual(out, { injectSteps: [{ errorMessage: { userMessage: 'Stop' } }], terminationBehavior: 'terminate' });
  assert.equal('errorMessage' in out, false);
  // PreToolUse still answers with decision only
  assert.deepEqual(toProtoSafePreHookOutput({ terminationBehavior: 'terminate', reason: 'no' }, { isPreToolUse: true }), { decision: 'deny', reason: 'no' });
});
