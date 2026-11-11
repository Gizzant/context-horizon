import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  compressCliOutputWithRecovery,
  searchCliLogsBm25
} from '../src/shims/agy_cli_compressor.mjs';
import { CircuitBreakers } from '../src/core/coach/circuit_breakers.mjs';
import { SubagentPhantomAuditor } from '../src/core/coach/subagent_phantom_auditor.mjs';

test('Phase 3.2: CLI Output Compressor archives >4KB stdout into .agents/cache/cli_logs.sqlite and recovers 100% of omitted Error/FAIL/AssertionError lines', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-cli-shim-'));
  try {
    const fillerLines = Array.from(
      { length: 120 },
      (_, i) => `test_module_${i}.py::test_passing_case_${i} PASSED [ ${Math.round((i / 120) * 100)}% ]`
    );

    const criticalLines = [
      'FAIL test/router.spec.ts > should preserve warm cache gravity',
      'AssertionError: expected "gemini-3.8-flash" to equal "gemini-4-argon"',
      'SyntaxError: Unexpected token export in C:/Projects/app/broken.js:14',
      'panic: runtime error: index out of range [4] with length 4',
      'npm ERR! Lifecycle script `test` failed with exit code 1'
    ];

    // Place critical error lines in the middle so head/tail summary omits them
    const allLines = [
      ...fillerLines.slice(0, 50),
      ...criticalLines,
      ...fillerLines.slice(50)
    ];
    const rawStdout = allLines.join('\n');
    assert.ok(rawStdout.length > 4096, `Expected >4096 chars, got ${rawStdout.length}`);

    const res = await compressCliOutputWithRecovery({
      command: 'pytest -v',
      rawStdout,
      exitCode: 1,
      sessionId: 'sess-cli-1',
      turnId: 'turn-7',
      workspaceDir: tmpDir
    });

    assert.equal(res.compressed, true);
    assert.equal(res.archivedInSqlite, true);
    assert.equal(res.dbPath, path.join(tmpDir, '.agents', 'cache', 'cli_logs.sqlite'));
    assert.equal(fs.existsSync(res.dbPath), true);

    // Verify Critical Error-Line Recovery Backstop recovered all 5 critical lines
    assert.equal(res.recoveredCount, criticalLines.length);
    assert.ok(
      res.output.includes(`[horizon-cli-shim: ${criticalLines.length} critical error line(s) preserved]`),
      'Output must include [horizon-cli-shim: N critical error line(s) preserved] header'
    );
    for (const crit of criticalLines) {
      assert.ok(res.output.includes(crit), `Output must preserve critical line: ${crit}`);
    }

    // Verify FTS5 BM25 search on .agents/cache/cli_logs.sqlite
    const hits = await searchCliLogsBm25('AssertionError', { workspaceDir: tmpDir });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, 'sess-cli-1');
    assert.ok(hits[0].snippet.includes('AssertionError'));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (err) {
      if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
    }
  }
});

test('Phase 3.1: DET-03 detects Test Assertion Weakening in git diff and provides 1-click git hunk revert', () => {
  const breakers = new CircuitBreakers();
  const sampleDiff = [
    '--- a/test/auth.test.mjs',
    '+++ b/test/auth.test.mjs',
    '@@ -12,4 +12,2 @@ test("validates token", () => {',
    '-  assert.equal(res.status, 200);',
    '-  expect(res.authenticated).toBe(true);',
    '+  // TODO: fix test later'
  ].join('\n');

  const check = breakers.recordTurn({
    turnIndex: 4,
    filePath: 'test/auth.test.mjs',
    gitDiff: sampleDiff
  });

  assert.equal(check.hasTripped, true);
  const det03 = check.triggered.find((a) => a.detectorId === 'DET-03');
  assert.ok(det03);
  assert.equal(det03.netDeletedCount, 2);
  assert.equal(det03.revertAction.type, 'GIT_HUNK_REVERT');
  assert.equal(det03.revertAction.nonDestructive, true);
  assert.ok(det03.revertAction.command.includes('git diff -- "test/auth.test.mjs"'));
  assert.ok(!det03.revertAction.command.includes('git checkout'));
});

test('Phase 3.3: SubagentPhantomAuditor formats Coach Bar pill, kills orphan Chrome/Pyrefly processes, and guards DET-28 Vision HTTP 400 Overage', () => {
  const killedPids = [];
  const auditor = new SubagentPhantomAuditor({
    killFn: (pid, sig) => { killedPids.push({ pid, sig }); }
  });

  // 1. Live subagent pill formatting
  const auditRes = auditor.auditTrajectories([
    {
      id: 'sub-browser-1',
      name: 'browser_subagent',
      turns: 4,
      screenshots: 3,
      tokens: 41200,
      active: true
    }
  ]);
  assert.equal(
    auditRes.coachBarPill,
    '⚡ 1 Subagent: browser_subagent (4 turns • 3 screenshots • 41.2k tokens) [Kill]'
  );

  // 2. Orphan headless Chrome & Pyrefly LSP scanner + SIGTERM killer
  const orphanScan = auditor.scanOrphans(
    [
      { pid: 1001, ppid: 9999, name: 'chrome.exe', commandLine: 'chrome.exe --headless --remote-debugging-port=9222' },
      { pid: 1002, ppid: 9999, name: 'pyrefly.exe', commandLine: 'pyrefly lsp --stdio', hung: true }
    ],
    { turnActive: false }
  );
  assert.equal(orphanScan.orphanCount, 2);

  const killRes = auditor.killOrphan(1001);
  assert.equal(killRes.ok, true);
  assert.equal(killRes.signal, 'SIGTERM');
  assert.deepEqual(killedPids, [{ pid: 1001, sig: 'SIGTERM' }]);

  // 3. DET-28 Vision HTTP 400 Overage Guard
  const visionSafe = auditor.checkVisionOverage({ primaryQuotaUsedPct: 82, googleOneAiCreditOveragesActive: true });
  assert.equal(visionSafe.triggered, false);

  const visionDanger = auditor.checkVisionOverage({ primaryQuotaUsedPct: 100, googleOneAiCreditOveragesActive: true });
  assert.equal(visionDanger.triggered, true);
  assert.equal(visionDanger.detectorId, 'DET-28');
  assert.ok(visionDanger.warningBanner.includes('HTTP 400'));
});
