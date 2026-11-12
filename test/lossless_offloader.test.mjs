/**
 * @file test/lossless_offloader.test.mjs
 * Verification of lossless PostToolUse >4k offloader (Feature 16).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isWorkspaceReadTool,
  stripAnsi,
  estimateTokens,
  offloadToolResult,
  CRITICAL_ERROR_REGEX
} from '../src/engine-node/offloader/tool_offloader.mjs';

function createTempArtifactEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_offloader_test_'));
  const artifactDir = path.join(tmpDir, 'artifacts');
  const ctxtopDir = tmpDir;
  return {
    tmpDir,
    artifactDir,
    ctxtopDir,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

test('offloader: strictly NEVER offloads workspace read/edit tools regardless of size', () => {
  const hugePayload = 'const x = 1;\n'.repeat(2000); // ~26k chars, ~6.5k tokens

  const readTools = [
    'read_file',
    'Read',
    'view_file',
    'View',
    'Edit',
    'edit_file',
    'Write',
    'write_file',
    'write_to_file',
    'replace_file_content',
    'MultiEdit',
    'NotebookEdit'
  ];

  for (const tool of readTools) {
    assert.strictEqual(isWorkspaceReadTool(tool), true, `${tool} must be recognized as workspace read/edit`);
    const res = offloadToolResult(tool, hugePayload);
    assert.strictEqual(res.eligible, false, `${tool} must NOT be eligible for offloading`);
    assert.strictEqual(res.offloaded, false, `${tool} must NOT be offloaded`);
    assert.strictEqual(res.output, hugePayload, `${tool} output must be preserved 100% untouched`);
  }
});

test('offloader: strictly NEVER offloads edit_file regardless of payload size (Antigravity parity)', () => {
  const massiveDiff = '--- a/large.js\n+++ b/large.js\n' + '@@ -1,5 +1,5 @@\n// modification\n'.repeat(800); // >20k chars, >5k tokens
  assert.strictEqual(isWorkspaceReadTool('edit_file'), true, 'edit_file must be recognized as workspace read/edit tool');
  assert.strictEqual(isWorkspaceReadTool('EDIT_FILE'), true, 'EDIT_FILE (uppercase) must be recognized');
  assert.strictEqual(isWorkspaceReadTool('Edit_File'), true, 'Edit_File (mixed case) must be recognized');

  const res = offloadToolResult('edit_file', massiveDiff);
  assert.strictEqual(res.eligible, false, 'edit_file must not be eligible for offload');
  assert.strictEqual(res.offloaded, false, 'edit_file must never be offloaded');
  assert.strictEqual(res.output, massiveDiff, 'edit_file output must be preserved 100% untouched');
});

test('offloader: small outputs (<=4k tokens) are not offloaded', () => {
  const smallOutput = 'Build completed in 1.2s with 0 warnings.';
  const res = offloadToolResult('Bash', smallOutput);
  assert.strictEqual(res.eligible, true);
  assert.strictEqual(res.offloaded, false);
  assert.strictEqual(res.output, smallOutput);
});

test('offloader: large Bash/MCP output (>4k tokens) is offloaded to disk with SHA-256', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempArtifactEnv();
  try {
    // Generate 6,000 token output (>24k chars)
    const lines = [];
    lines.push('=== Starting heavy build pipeline ===');
    for (let i = 1; i <= 600; i++) {
      lines.push(`Compiling module_${i}.cpp [OK]`);
    }
    lines.push('=== Build finished successfully ===');
    const dump = lines.join('\n');

    const res = offloadToolResult('Bash', dump, { ctxtopDir, artifactDir });
    assert.strictEqual(res.eligible, true);
    assert.strictEqual(res.offloaded, true);
    assert.ok(res.sha256);
    assert.ok(res.artifactPath);

    // Verify artifact exists on disk with full content
    assert.ok(fs.existsSync(res.artifactPath));
    const saved = fs.readFileSync(res.artifactPath, 'utf8');
    assert.strictEqual(saved, dump);

    // Verify summary text
    assert.ok(res.output.includes('[Artifact Offloaded: ah_'));
    assert.ok(res.output.includes('To query this artifact: ctxtop search'));
    assert.ok(res.summaryTokens < res.originalTokens);
  } finally {
    cleanup();
  }
});

test('offloader: preserves 100% of critical error lines in the summary', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempArtifactEnv();
  try {
    const lines = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(`normal log line ${i}`);
    }
    // Inject critical errors
    lines.push('FAIL test/engine_node_db.test.mjs: timeout reached');
    lines.push('AssertionError: expected true to equal false');
    lines.push('npm ERR! code ERESOLVE');
    lines.push('panic: runtime error: index out of range');

    for (let i = 501; i <= 800; i++) {
      lines.push(`subsequent log line ${i}`);
    }
    const dump = lines.join('\n');

    const res = offloadToolResult('mcp__execute_command', dump, { ctxtopDir, artifactDir });
    assert.strictEqual(res.offloaded, true);
    assert.strictEqual(res.preservedErrorLines, 4);

    // Assert every critical error line is present in res.output summary
    assert.ok(res.output.includes('FAIL test/engine_node_db.test.mjs'));
    assert.ok(res.output.includes('AssertionError: expected true'));
    assert.ok(res.output.includes('npm ERR! code ERESOLVE'));
    assert.ok(res.output.includes('panic: runtime error'));

    // Assert summary line count is <= 25 lines
    const summaryLines = res.output.split(/\r?\n/);
    assert.ok(summaryLines.length <= 25, `Summary line count ${summaryLines.length} must be <= 25`);
  } finally {
    cleanup();
  }
});

test('offloader: strips ANSI escape sequences cleanly', () => {
  const ansiText = '\x1B[31mError:\x1B[0m \x1B[1mBuild failed\x1B[0m';
  const stripped = stripAnsi(ansiText);
  assert.strictEqual(stripped, 'Error: Build failed');
});
