import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../src/utils/nodeIo.mjs';
import {
  isCompressibleCliCommand,
  classifyShellPostToolPolicy,
  classifyCliCommandFamily,
  compressCliOutputFts5Sync
} from '../src/core/fts5_output_compressor.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use-core.mjs';
import { buildCompressionCorpus } from '../scripts/run_antigravity_and_compression_benchmark.mjs';

function makeTempDir(prefix = 'hb-idea5-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.git'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

describe('Idea #5 (Narrowed): Explicit Build/Test Parsers & Negative Inspection Exclusions', () => {
  it('compresses F11..F19 explicit stacks with >=80% reduction, 100% marker recall, and passes PostToolUse hook', () => {
    const ws = makeTempDir('hb-idea5-pos-');
    const dbPath = path.join(ws.dir, '.claude', 'cache', 'tool_logs_fts5.db');
    try {
      const corpus = buildCompressionCorpus().filter((c) => /^F1[1-9]-/.test(c.id));
      assert.equal(corpus.length, 9, 'Expected F11..F19 explicit build/test fixtures in benchmark corpus');

      for (const item of corpus) {
        assert.equal(
          isCompressibleCliCommand(item.command),
          true,
          `Expected isCompressibleCliCommand=true for ${item.command}`
        );
        assert.equal(
          classifyCliCommandFamily(item.command),
          item.family,
          `Expected family=${item.family} for ${item.command}`
        );
        assert.equal(classifyShellPostToolPolicy(item.command).allowFts5, true);

        const res = compressCliOutputFts5Sync({
          sessionId: 'sess-idea5',
          turnId: item.turnId,
          command: item.command,
          exitCode: item.exitCode,
          rawOutput: item.rawOutput,
          dbPath,
          homeDir: ws.dir
        });
        assert.equal(res.compressed, true, `Expected compression for ${item.id}`);
        assert.ok(res.reductionPct >= 80, `${item.id} reduction ${res.reductionPct}% must be >= 80%`);
        assert.ok(res.lineCount <= 25, `${item.id} lineCount ${res.lineCount} must be <= 25`);
        for (const marker of item.expectedMarkers) {
          assert.ok(
            res.output.includes(marker),
            `${item.id} summary missing marker "${marker}":\n${res.output}`
          );
        }

        const hookRes = runPostToolUseHook(
          {
            session_id: 'sess-idea5-hook',
            tool_use_id: `tu-${item.id}`,
            cwd: ws.dir,
            tool_name: 'Bash',
            tool_input: { command: item.command },
            tool_response: { stdout: item.rawOutput, stderr: '', exit_code: item.exitCode }
          },
          { cwd: ws.dir, homeDir: ws.dir }
        );
        const parsed = JSON.parse(hookRes.stdout);
        const updatedText = parsed.hookSpecificOutput.updatedToolOutput.stdout;
        for (const marker of item.expectedMarkers) {
          assert.ok(updatedText.includes(marker), `PostToolUse ${item.id} missing marker "${marker}"`);
        }
      }

      // Also verify bazel test and passing mvn test summary preservation
      assert.equal(classifyCliCommandFamily('bazel test //...'), 'test');
      assert.equal(classifyCliCommandFamily('make check'), 'test');
      assert.equal(classifyCliCommandFamily('dotnet build'), 'lint_build');
      assert.equal(classifyShellPostToolPolicy('git status && mvn test').allowFts5, true);

      const mvnPassRaw = [
        ...Array.from({ length: 80 }, (_, i) => `[INFO] Running com.ledger.Suite_${i} ${'p'.repeat(40)}`),
        '[INFO] Tests run: 80, Failures: 0, Errors: 0, Skipped: 0',
        '[INFO] BUILD SUCCESS'
      ].join('\n');
      const mvnPass = compressCliOutputFts5Sync({
        sessionId: 'sess-idea5',
        turnId: 'turn-mvn-pass',
        command: 'mvn test',
        exitCode: 0,
        rawOutput: mvnPassRaw,
        dbPath,
        homeDir: ws.dir
      });
      assert.equal(mvnPass.compressed, true);
      assert.ok(mvnPass.output.includes('Result: PASS (0 failing tests)'));
      assert.ok(mvnPass.output.includes('[INFO] BUILD SUCCESS'));
    } finally {
      ws.cleanup();
    }
  });

  it('never compresses negative file/jq fixtures or falls back generically on unlisted custom commands', () => {
    const ws = makeTempDir('hb-idea5-neg-');
    const dbPath = path.join(ws.dir, '.claude', 'cache', 'tool_logs_fts5.db');
    try {
      const largePayload = Array.from(
        { length: 120 },
        (_, i) => `{"id":${i},"name":"record_${i}","pad":"${'v'.repeat(48)}"}`
      ).join('\n');
      assert.ok(largePayload.length > 6000);

      for (const negCmd of ['cat src/file.ts', "jq '.items[]' data.json", "cat data.json | jq '.items'"]) {
        const policy = classifyShellPostToolPolicy(negCmd);
        assert.equal(policy.allowFts5, false, `Negative fixture ${negCmd} must block FTS5`);
        assert.equal(policy.allowOffload, false, `Negative fixture ${negCmd} must block offload`);

        const hookRes = runPostToolUseHook(
          {
            session_id: 'sess-idea5-neg',
            tool_use_id: `tu-neg-${negCmd.slice(0, 8)}`,
            cwd: ws.dir,
            tool_name: 'Bash',
            tool_input: { command: negCmd },
            tool_response: { stdout: largePayload, stderr: '', exit_code: 0 }
          },
          { cwd: ws.dir, homeDir: ws.dir }
        );
        assert.equal(hookRes.stdout, '', `Negative fixture ${negCmd} must pass through untouched`);
      }

      // Narrowed Idea #5 invariant: NO generic head+tail FTS5 fallback for unlisted custom commands
      for (const unlistedCmd of ['./scripts/custom_tool.sh', 'my_unlisted_cli dump']) {
        assert.equal(
          isCompressibleCliCommand(unlistedCmd),
          false,
          `Unlisted command ${unlistedCmd} must not match TARGET_COMMAND_REGEX`
        );
        const ftsRes = compressCliOutputFts5Sync({
          sessionId: 'sess-idea5-neg',
          turnId: 'turn-unlisted',
          command: unlistedCmd,
          exitCode: 0,
          rawOutput: largePayload,
          dbPath,
          homeDir: ws.dir
        });
        assert.equal(ftsRes.compressed, false, `Unlisted command ${unlistedCmd} must not use FTS5 generic fallback`);
        assert.equal(ftsRes.output, largePayload);
      }
    } finally {
      ws.cleanup();
    }
  });
});
