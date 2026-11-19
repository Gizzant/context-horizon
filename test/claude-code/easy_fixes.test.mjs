/** Pre-launch easy fixes: <cmd> --help never runs the command; saved output is owner-only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../src/utils/nodeIo.mjs';
import { runCli } from '../../bin/ctxtop.mjs';
import { runPostToolUseHook } from '../../hooks/handlers/post-tool-use-core.mjs';

for (const cmd of ['install', 'init', 'uninstall']) {
  for (const flag of ['--help', '-h']) {
    test(`ctxtop ${cmd} ${flag} prints help and changes nothing`, async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-help-'));
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-help-home-'));
      try {
        const res = await runCli([cmd, flag], { cwd, homeDir });
        assert.equal(res.exitCode, 0);
        assert.match(res.output, new RegExp(`^Usage: highbeam ${cmd}`));
        assert.equal(res.data.help, true);
        assert.deepEqual(fs.readdirSync(cwd), [], 'help must not write into the project');
        assert.deepEqual(fs.readdirSync(homeDir), [], 'help must not write into home');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });
  }
}

test('offloaded command output is written owner-only (0600 files, 0700 directory)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-perm-'));
  const prevUmask = process.umask(0o022);
  try {
    const log = Array.from({ length: 900 }, (_, i) => `line ${i} output text ${(i * 7919) % 1000}`).join('\n');

    // 1. CLI command routes through FTS5 archive (.claude/cache/tool_logs_fts5.db)
    runPostToolUseHook(
      {
        session_id: 'perm1',
        cwd: dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: log, stderr: '', exit_code: 1 }
      },
      { cwd: dir, persistState: true }
    );
    const cacheDir = path.join(dir, '.claude', 'cache');
    const dbPath = path.join(cacheDir, 'tool_logs_fts5.db');
    assert.ok(fs.existsSync(dbPath), 'FTS5 archive database should have been created');
    assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700, '.claude/cache dir should be 0700');
    for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(candidate)) {
        assert.equal(fs.statSync(candidate).mode & 0o777, 0o600, `${path.basename(candidate)} should be 0600`);
      }
    }

    // 2. Non-FTS5 >4k-token command falls back to flat artifact offload (.claude/cache/artifacts/*.txt)
    runPostToolUseHook(
      {
        session_id: 'perm2',
        cwd: dir,
        tool_name: 'Bash',
        tool_input: { command: 'cat dump.log' },
        tool_response: { stdout: log, stderr: '', exit_code: 0 }
      },
      { cwd: dir, persistState: true }
    );
    const artDir = path.join(cacheDir, 'artifacts');
    const files = fs.readdirSync(artDir);
    assert.ok(files.length >= 1, 'an artifact should have been saved');
    for (const f of files) {
      assert.equal(fs.statSync(path.join(artDir, f)).mode & 0o777, 0o600, `${f} should be 0600`);
    }
    assert.equal(fs.statSync(artDir).mode & 0o777, 0o700);
  } finally {
    process.umask(prevUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
