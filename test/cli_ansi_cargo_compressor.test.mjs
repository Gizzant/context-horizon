import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  stripAnsiAndCarriageReturns,
  compressCliOutputWithRecovery,
  compressCargoOutput,
  compressNpmInstallOutput,
  CLI_SHIM_CONSTANTS
} from '../src/shims/agy_cli_compressor.mjs';

test('CLI Output Compressor: strips ANSI CSI/OSC escape codes and collapses carriage returns', () => {
  const coloredText = '\x1B[31mError:\x1B[0m something went \x1B[1;33mwrong\x1B[0m\x1B[2K';
  assert.strictEqual(stripAnsiAndCarriageReturns(coloredText), 'Error: something went wrong');

  const progressBar = 'Downloading:  10%\rDownloading:  50%\rDownloading: 100%\nDone!';
  const collapsed = stripAnsiAndCarriageReturns(progressBar);
  assert.strictEqual(collapsed, 'Downloading: 100%\nDone!');
});

test('CLI Output Compressor: cargo test profile aggregates compiling and passing tests while retaining diagnostics', () => {
  const cargoOutput = [
    '   Compiling serde v1.0.197',
    '   Compiling syn v2.0.48',
    '   Compiling my_crate v0.1.0 (C:/Projects/rust_app)',
    '    Checking tokio v1.35.1',
    '     Running unittests src/lib.rs',
    'test tests::test_init ... ok',
    'test tests::test_parse ... ok',
    'test tests::test_encode ... ok',
    'test tests::test_overflow ... FAILED',
    'failures:',
    '---- tests::test_overflow stdout ----',
    'thread \'tests::test_overflow\' panicked at src/lib.rs:88:9:',
    'attempt to multiply with overflow',
    'error[E0308]: mismatched types',
    '  --> src/lib.rs:92:5',
    '   |',
    '92 |     let x: u32 = -1;',
    '   |                  ^^ expected `u32`, found `i32`',
    'test result: FAILED. 3 passed; 1 failed; 0 ignored'
  ].join('\n');

  const compressed = compressCargoOutput(cargoOutput, {
    command: 'cargo test',
    exitCode: 101,
    logId: 'cargo-log-1',
    dbPath: 'test.sqlite'
  });

  assert.ok(compressed.includes('[horizon-cli-compressor:cargo]'));
  assert.ok(compressed.includes('compiled=3'));
  assert.ok(compressed.includes('passed_tests=3'));
  assert.ok(compressed.includes('error[E0308]: mismatched types'));
  assert.ok(compressed.includes('src/lib.rs:92:5'));
  assert.ok(compressed.includes('panicked at src/lib.rs:88:9'));
  assert.ok(compressed.includes('test result: FAILED'));
  assert.ok(!compressed.includes('test tests::test_init ... ok'), 'Passing test details should be collapsed');
});

test('CLI Output Compressor: npm install profile strips spinners and funding notices while retaining ERESOLVE', () => {
  const npmOutput = [
    '⠋ reify:rxjs: timing reifyNode:node_modules/rxjs',
    '⠙ reify:rxjs: sill finalize /node_modules/rxjs',
    '+-- react@18.2.0',
    '+-- react-dom@18.2.0',
    '15 packages are looking for funding',
    '  run `npm fund` for details',
    'npm ERR! code ERESOLVE',
    'npm ERR! ERESOLVE could not resolve',
    'npm ERR! While resolving: @types/react@18.0.0',
    'npm ERR! Found: react@19.0.0',
    'added 142 packages in 4s'
  ].join('\n');

  const compressed = compressNpmInstallOutput(npmOutput, {
    command: 'npm install',
    exitCode: 1,
    logId: 'npm-log-1',
    dbPath: 'test.sqlite'
  });

  assert.ok(compressed.includes('[horizon-cli-compressor:npm]'));
  assert.ok(compressed.includes('summary="added 142 packages in 4s"'));
  assert.ok(!compressed.includes('looking for funding'));
  assert.ok(!compressed.includes('run `npm fund`'));
  assert.ok(!compressed.includes('reify:rxjs'));
  assert.ok(compressed.includes('npm ERR! code ERESOLVE'));
  assert.ok(compressed.includes('npm ERR! ERESOLVE could not resolve'));
});

test('CLI Output Compressor: end-to-end compression with ANSI stripping and Critical Error-Line Recovery', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-compress-'));
  try {
    // Large cargo test output with ANSI colors
    const fillerPassing = Array.from(
      { length: 250 },
      (_, i) => `\x1B[32mtest test_case_${i} ... ok\x1B[0m\r\x1B[2Ktest test_case_${i} ... ok`
    );

    const errorBlock = [
      'failures:',
      'thread \'auth_test\' panicked at src/auth.rs:42:5:',
      'error[E0382]: use of moved value: `user`',
      '  --> src/auth.rs:43:10',
      'npm ERR! code 1',
      'ERESOLVE dependency conflict'
    ];

    const allLines = [...fillerPassing.slice(0, 75), ...errorBlock, ...fillerPassing.slice(75)];
    const rawStdout = allLines.join('\n');
    assert.ok(rawStdout.length > 4096);

    const res = await compressCliOutputWithRecovery({
      command: 'cargo test --all',
      rawStdout,
      exitCode: 101,
      sessionId: 'sess-cargo',
      turnId: 'turn-3',
      workspaceDir: tmpDir
    });

    assert.strictEqual(res.compressed, true);
    assert.strictEqual(res.archivedInSqlite, true);
    // Verify no ANSI escape remains in output
    assert.ok(!res.output.includes('\x1B['));
    // Verify critical error lines preserved
    assert.ok(res.output.includes('error[E0382]: use of moved value'));
    assert.ok(res.output.includes('npm ERR! code 1'));
    assert.ok(res.output.includes('ERESOLVE dependency conflict'));
    assert.ok(res.output.includes('panicked at src/auth.rs:42:5'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
