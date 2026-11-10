import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inspectGitArgs,
  resolveRealGitBinary,
  generateGitBypassNonce,
  consumeGitBypassNonce,
  runGitGuard,
  DET19_CONSTANTS
} from '../src/shims/agy_git_guard.mjs';

test('DET-19: inspectGitArgs blocks commit bypass flags', () => {
  // Commit bypass flags
  const testCases = [
    { args: ['commit', '-n', '-m', 'fix'], blocked: true, flag: '-n' },
    { args: ['commit', '--no-verify', '-m', 'fix'], blocked: true, flag: '--no-verify' },
    { args: ['commit', '-amn', 'fix'], blocked: true, flag: '-amn' },
    { args: ['commit', '-anm', 'fix'], blocked: true, flag: '-anm' },
    { args: ['commit', '--no-gpg-sign', '-m', 'fix'], blocked: true, flag: '--no-gpg-sign' },
    { args: ['push', '--no-verify'], blocked: true, flag: '--no-verify' },
    { args: ['merge', 'feat', '--no-verify'], blocked: true, flag: '--no-verify' },
    { args: ['rebase', 'main', '--no-verify'], blocked: true, flag: '--no-verify' },
    { args: ['cherry-pick', 'abc', '--no-verify'], blocked: true, flag: '--no-verify' },
    { args: ['-c', 'core.hooksPath=NUL', 'commit', '-m', 'bypass'], blocked: true, flag: 'core.hooksPath=NUL' },
    { args: ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'bypass'], blocked: true, flag: 'core.hooksPath=/dev/null' }
  ];

  for (const tc of testCases) {
    const res = inspectGitArgs(tc.args, {});
    assert.strictEqual(res.blocked, true, `Expected ${tc.args.join(' ')} to be blocked`);
    assert.strictEqual(res.detectorId, 'DET-19');
    assert.ok(res.flags.some((f) => f.includes(tc.flag)), `Expected flag ${tc.flag} in ${JSON.stringify(res.flags)}`);
  }
});

test('DET-19: inspectGitArgs blocks HUSKY=0 and GIT_HOOKS=0 environment overrides', () => {
  const huskyRes = inspectGitArgs(['commit', '-m', 'msg'], { HUSKY: '0' });
  assert.strictEqual(huskyRes.blocked, true);
  assert.strictEqual(huskyRes.detectorId, 'DET-19');

  const hooksRes = inspectGitArgs(['commit', '-m', 'msg'], { GIT_HOOKS: '0' });
  assert.strictEqual(hooksRes.blocked, true);
  assert.strictEqual(hooksRes.detectorId, 'DET-19');
});

test('DET-19: inspectGitArgs allows non-bypass commands (Zero False Positives)', () => {
  const allowedCases = [
    ['log', '-n', '5'],
    ['clean', '-n'],
    ['diff', '--name-only'],
    ['show', '-n', '1'],
    ['checkout', '-b', 'feature-branch'],
    ['status'],
    ['commit', '-m', 'clean commit message'],
    ['commit', '-am', 'clean all commit'],
    ['commit', '-m', '-next: cleanup and refactor'],
    ['commit', '-am', '-n: note starts with dash-n'],
    ['commit', '--message', '-next: long message flag'],
    ['commit', '-F', '-notes.txt'],
    ['push', 'origin', 'main'],
    ['merge', 'origin/main']
  ];

  for (const args of allowedCases) {
    const res = inspectGitArgs(args, {});
    assert.strictEqual(res.blocked, false, `Expected ${args.join(' ')} to be ALLOWED`);
  }
});

test('DET-19: resolveRealGitBinary filters out .agents/shims to prevent recursion', () => {
  const mockEnv = {
    PATH: [
      path.join('C:', 'workspace', '.agents', 'shims'),
      path.join('C:', 'workspace', '.agents', 'shims') + path.sep,
      path.join('C:', 'custom', 'shims'),
      process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd' : '/usr/bin'
    ].join(path.delimiter)
  };

  const resolved = resolveRealGitBinary({ env: mockEnv, platform: process.platform });
  assert.ok(resolved, 'Should resolve a git binary');
  assert.ok(
    !resolved.toLowerCase().includes('.agents/shims') && !resolved.toLowerCase().includes('.agents\\shims'),
    `Resolved binary ${resolved} must NOT be inside .agents/shims`
  );
});

test('DET-19: One-time cryptographic nonce permits bypass and is consumed strictly once', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'det19-test-'));
  try {
    // 1. Without nonce, commit --no-verify is blocked with exit code 126
    let stderrOutput = '';
    const fakeStderr = { write: (msg) => { stderrOutput += msg; } };
    const blockedRes = runGitGuard({
      args: ['commit', '--no-verify', '-m', 'fix'],
      cwd: tmpDir,
      stderr: fakeStderr
    });
    assert.strictEqual(blockedRes.blocked, true);
    assert.strictEqual(blockedRes.exitCode, 126);
    assert.ok(stderrOutput.includes('[HORIZON DET-19 BLOCKED]'));

    // Check security event logged
    const secEventsPath = path.join(tmpDir, '.agents', 'cache', 'security_events.jsonl');
    assert.ok(fs.existsSync(secEventsPath));
    const events = fs.readFileSync(secEventsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(events[0].event, 'DET-19_HOOK_BYPASS_ATTEMPT');
    assert.strictEqual(events[0].detectorId, 'DET-19');

    // 2. Generate nonce
    const payload = generateGitBypassNonce(tmpDir, 60000);
    assert.ok(payload.nonce);
    assert.ok(payload.expiresAtMs > Date.now());

    // 3. Run git guard with fake spawnFn: nonce allows bypass once
    let spawnCalled = false;
    const fakeSpawn = (bin, args) => {
      spawnCalled = true;
      return { status: 0 };
    };

    const allowedRes = runGitGuard({
      args: ['commit', '--no-verify', '-m', 'fix with nonce'],
      cwd: tmpDir,
      spawnFn: fakeSpawn
    });
    assert.strictEqual(allowedRes.blocked, false);
    assert.strictEqual(allowedRes.exitCode, 0);
    assert.strictEqual(spawnCalled, true);

    // 4. Verify nonce was consumed and deleted
    const nonceFile = path.join(tmpDir, '.agents', 'cache', 'git_bypass_nonce.json');
    assert.strictEqual(fs.existsSync(nonceFile), false, 'Nonce file must be unlinked after consumption');

    // 5. Subsequent attempt without nonce is blocked again
    const secondAttempt = runGitGuard({
      args: ['commit', '--no-verify', '-m', 'second attempt'],
      cwd: tmpDir,
      stderr: fakeStderr
    });
    assert.strictEqual(secondAttempt.blocked, true);
    assert.strictEqual(secondAttempt.exitCode, 126);

    // 6. Expired nonce test
    const expiredPayload = generateGitBypassNonce(tmpDir, -1000); // already expired
    const expiredConsume = consumeGitBypassNonce(tmpDir);
    assert.strictEqual(expiredConsume.allowed, false);
    assert.strictEqual(expiredConsume.reason, 'EXPIRED_NONCE');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
