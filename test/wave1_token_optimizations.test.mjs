import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import {
  mergeLineIntervals,
  trimRequestedRangeAgainstIntervals
} from '../hooks/handlers/pre-tool-use-core.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { handlePreToolUse } from '../src/hooks/pre_invocation_core.mjs';
import { handlePostToolUse, handlePostInvocation } from '../src/hooks/post_invocation_core.mjs';
import { configureShield } from '../src/core/shield_manager.mjs';
import { readLedgerEntries } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    void err;
  }
}

describe('OPT-2A: PostToolUse FTS5-Before-OFFLOAD_4K & Zero-Doubling Contract', () => {
  it('prefers structured FTS5 compression over flat OFFLOAD_4K on >4,000-token CLI test output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt2a-fts-'));
    try {
      const okLines = Array.from(
        { length: 220 },
        (_, i) => `ok ${i + 1} - test suite verification worker case #${i + 1} completed cleanly (${'p'.repeat(48)})`
      );
      const hugeCliOut = [
        ...okLines,
        'FAIL test/wave1_router.test.mjs',
        'AssertionError [ERR_ASSERTION]: Expected status 200 to equal 503 at src/core/router.mjs:118:9',
        '1 failing'
      ].join('\n');
      assert.ok(Buffer.byteLength(hugeCliOut, 'utf8') > 16_384, 'Fixture must exceed 4k-token threshold');

      const res = runPostToolUseHook(
        {
          session_id: 'sess-opt2a-fts',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'node --test test/wave1_router.test.mjs' },
          tool_response: { stdout: hugeCliOut, stderr: '' },
          exit_code: 1
        },
        { cwd: tmpDir }
      );

      assert.equal(res.exitCode, 0);
      assert.equal(res.sanitized.offloaded, false, 'FTS5 must compress before flat OFFLOAD_4K pre-empts it');
      const outJson = JSON.parse(res.stdout);
      const replaced = outJson.hookSpecificOutput.updatedToolOutput.stdout;
      assert.ok(replaced.includes('FTS5 Query Handle: agy-log-search'));
      assert.ok(replaced.includes('AssertionError [ERR_ASSERTION]'));
      assert.ok(replaced.length < hugeCliOut.length * 0.25);

      const receipts = readLedgerEntries({ cwd: tmpDir });
      assert.ok(
        receipts.some((r) => r.category === 'CLI_FTS5_COMPRESSED' && Number(r.savedTokens) > 2000),
        'Expected CLI_FTS5_COMPRESSED ledger receipt'
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('never appends finalOutput to additionalContext when replacement shape cannot be rebuilt in replace mode, while honoring explicit context opt-in', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt2a-noleak-'));
    const prevEnv = process.env.HIGHBEAM_POST_OUTPUT_MODE;
    try {
      delete process.env.HIGHBEAM_POST_OUTPUT_MODE;
      const hugeNonRebuildable = { ok: true, count: 42 };
      const res = runPostToolUseHook(
        {
          session_id: 'sess-opt2a-noleak',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'echo ok' },
          tool_response: hugeNonRebuildable
        },
        { cwd: tmpDir }
      );
      assert.equal(res.stdout, '', 'Default replace mode must never emit additionalContext duplication');

      process.env.HIGHBEAM_POST_OUTPUT_MODE = 'context';
      const ctxRes = runPostToolUseHook(
        {
          session_id: 'sess-opt2a-ctx-optin',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'echo ansi' },
          tool_response: '\x1b[32mPASS\x1b[0m suite clean\n'
        },
        { cwd: tmpDir }
      );
      const ctxJson = JSON.parse(ctxRes.stdout);
      assert.equal(ctxJson.hookSpecificOutput.additionalContext, 'PASS suite clean\n');
    } finally {
      if (prevEnv === undefined) delete process.env.HIGHBEAM_POST_OUTPUT_MODE;
      else process.env.HIGHBEAM_POST_OUTPUT_MODE = prevEnv;
      cleanupDir(tmpDir);
    }
  });
});

describe('OPT-2B: Antigravity PostToolUse & PostInvocation FTS5 Parity', () => {
  it('compresses Select-String shell output via FTS5 in handlePostToolUse and handlePostInvocation without writing .claude in workspace', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt2b-ws-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt2b-home-'));
    try {
      const selectOutput = Array.from(
        { length: 75 },
        (_, i) => `src/module_${i % 6}.mjs:${10 + i}:export function handler_${i}() { return '${'x'.repeat(64)}'; }`
      ).join('\n');

      const postToolRes = await handlePostToolUse({
        conversationId: 'ag-opt2b-1',
        cwd: tmpWs,
        homeDir: tmpHome,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'Select-String -Path src\\*.mjs -Pattern "handler_"' },
        tool_output: selectOutput,
        exitCode: 0
      });

      assert.equal(postToolRes.guardrailId, 'CLI_FTS5_COMPRESSED');
      assert.ok(postToolRes.savedTokens > 400);
      assert.ok(postToolRes.updatedOutput.includes('Search/List Summary'));
      assert.ok(postToolRes.updatedOutput.includes('FTS5 Query Handle: agy-log-search'));
      assert.equal(fs.existsSync(path.join(tmpWs, '.claude')), false, 'Antigravity hook must never write .claude inside workspace');
      assert.equal(
        fs.existsSync(path.join(tmpHome, '.gemini', 'antigravity', 'agy-horizon', 'tool_logs_fts5.db')),
        true
      );

      const postInvRes = await handlePostInvocation({
        conversationId: 'ag-opt2b-2',
        cwd: tmpWs,
        homeDir: tmpHome,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'node scripts/check_inventory.mjs' },
        tool_output: Array.from({ length: 65 }, (_, i) => `row_${i}: ${'k'.repeat(70)}`).join('\n'),
        exitCode: 0
      });
      assert.equal(postInvRes.guardrailId, 'CLI_FTS5_COMPRESSED');
      assert.ok(postInvRes.savedTokens > 400);
      assert.ok(postInvRes.updatedOutput.includes('FTS5 Query Handle: agy-log-search'));

      const offRes = await handlePostToolUse({
        conversationId: 'ag-opt2b-off',
        cwd: tmpWs,
        homeDir: tmpHome,
        flightMode: 'OFF',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'Select-String -Path src\\*.mjs -Pattern "x"' },
        tool_output: selectOutput
      });
      assert.equal(offRes.flightMode, 'OFF');
      assert.equal(offRes.updatedOutput, undefined);
    } finally {
      cleanupDir(tmpWs);
      cleanupDir(tmpHome);
    }
  });
});

describe('OPT-3A: Explicit-Slice Byte/Line Clamping', () => {
  it('clamps explicit over-wide line & byte slices in-place via updatedInput on Claude and blocks >24 KB explicit bombs on Antigravity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt3a-slice-'));
    try {
      configureShield({ action: 'enable', platform: 'all', cwd: tmpDir });

      // 1. 500-line JS file requested with explicit offset:1, limit:400 (> 250-line slice cap)
      const tallJs = path.join(tmpDir, 'tall_module.mjs');
      fs.writeFileSync(
        tallJs,
        Array.from({ length: 500 }, (_, i) =>
          i % 100 === 0
            ? `export function fn_${i}(x) { return x + ${i}; }`
            : `  const item_${i} = ${i} * 3; // padding payload ${'a'.repeat(40)}`
        ).join('\n'),
        'utf8'
      );

      const claudeLineClamp = runPreToolUseHook(
        {
          session_id: 'sess-opt3a-1',
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: tallJs, offset: 1, limit: 400 }
        },
        { cwd: tmpDir }
      );
      assert.equal(claudeLineClamp.verdict.decision, 'allow');
      assert.equal(claudeLineClamp.verdict.subType, 'EXPLICIT_SLICE_CLAMP');
      assert.equal(claudeLineClamp.verdict.triggerReason, 'explicit_slice_line_cap');
      assert.equal(claudeLineClamp.verdict.updatedInput.offset, 1);
      assert.ok(claudeLineClamp.verdict.updatedInput.limit <= 150);
      assert.ok(claudeLineClamp.verdict.savedTokens > 200);

      // 2. Wide 200-line markdown file requested with explicit StartLine:1, EndLine:180 (>20 KB slice byte cap)
      const wideMd = path.join(tmpDir, 'wide_slice_spec.md');
      fs.writeFileSync(
        wideMd,
        Array.from({ length: 200 }, (_, i) =>
          i % 40 === 0 ? `## Heading ${i}\n${'b'.repeat(220)}` : `Row ${i}: ${'c'.repeat(220)}`
        ).join('\n'),
        'utf8'
      );

      const claudeByteClamp = runPreToolUseHook(
        {
          session_id: 'sess-opt3a-2',
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: wideMd, offset: 1, limit: 180 }
        },
        { cwd: tmpDir }
      );
      assert.equal(claudeByteClamp.verdict.decision, 'allow');
      assert.equal(claudeByteClamp.verdict.subType, 'EXPLICIT_SLICE_CLAMP');
      assert.equal(claudeByteClamp.verdict.triggerReason, 'explicit_slice_byte_cap');
      assert.ok(claudeByteClamp.verdict.updatedInput.limit < 100);

      // 3. Normal bounded slice (offset: 1, limit: 80 on tallJs ~6 KB) passes untouched
      const normalSlice = runPreToolUseHook(
        {
          session_id: 'sess-opt3a-normal',
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: tallJs, offset: 1, limit: 80 }
        },
        { cwd: tmpDir }
      );
      assert.notEqual(normalSlice.verdict.subType, 'EXPLICIT_SLICE_CLAMP');
      assert.notEqual(normalSlice.verdict.decision, 'deny');

      // 4. Antigravity explicit StartLine:1, EndLine:180 (~40 KB > 24 KB severe bomb) is blocked with bounded hint
      const agBomb = await handlePreToolUse({
        conversationId: 'ag-opt3a-bomb',
        cwd: tmpDir,
        tool_name: 'read_file',
        tool_input: { Path: wideMd, StartLine: 1, EndLine: 180 }
      });
      assert.equal(agBomb.decision, 'deny');
      assert.equal(agBomb.triggerReason, 'explicit_slice_byte_cap');
      assert.ok(agBomb.reason.includes('StartLine=1, EndLine='));
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe('OPT-3B: Per-File Read-Interval Ledger (Zero-Deny Overlap Trimming)', () => {
  it('merges intervals and trims/anchors overlapping slices, invalidating cleanly on Edit', () => {
    assert.deepEqual(mergeLineIntervals([[40, 80], [1, 39], [100, 120], [50, 70]]), [[1, 80], [100, 120]]);
    assert.deepEqual(
      trimRequestedRangeAgainstIntervals(40, 139, [[1, 100]]),
      { status: 'trimmed', offset: 101, limit: 39, savedLines: 61 }
    );
    assert.deepEqual(
      trimRequestedRangeAgainstIntervals(10, 69, [[1, 139]]),
      { status: 'full_covered', anchorOffset: 10, anchorLimit: 5, savedLines: 55 }
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt3b-int-'));
    try {
      const target = path.join(tmpDir, 'ledger_mod.mjs');
      fs.writeFileSync(
        target,
        Array.from({ length: 300 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join('\n'),
        'utf8'
      );

      const sid = 'sess-opt3b-1';
      // Read 1: L1..L100 -> allowed, records [1, 100]
      const r1 = runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: target, offset: 1, limit: 100 } },
        { cwd: tmpDir }
      );
      assert.notEqual(r1.verdict.subType, 'READ_INTERVAL_TRIM');

      // Read 2: L40..L139 (61% overlap) -> trimmed in-place to unread L101..L139
      const r2 = runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: target, offset: 40, limit: 100 } },
        { cwd: tmpDir }
      );
      assert.equal(r2.verdict.decision, 'allow');
      assert.equal(r2.verdict.subType, 'READ_INTERVAL_TRIM');
      assert.equal(r2.verdict.updatedInput.offset, 101);
      assert.equal(r2.verdict.updatedInput.limit, 39);
      assert.ok(r2.verdict.savedTokens > 0);

      // Read 3: L10..L69 (100% covered by [1, 139]) -> clamped to 5-line anchor
      const r3 = runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: target, offset: 10, limit: 60 } },
        { cwd: tmpDir }
      );
      assert.equal(r3.verdict.decision, 'allow');
      assert.equal(r3.verdict.subType, 'READ_INTERVAL_ANCHOR');
      assert.equal(r3.verdict.updatedInput.offset, 10);
      assert.equal(r3.verdict.updatedInput.limit, 5);

      // Edit clears intervals -> Read 4 L10..L69 passes un-trimmed
      runPreToolUseHook(
        {
          session_id: sid,
          cwd: tmpDir,
          tool_name: 'Edit',
          tool_input: {
            file_path: target,
            old_string: 'export const line_15 = 15;',
            new_string: 'export const line_15 = 999;'
          }
        },
        { cwd: tmpDir }
      );
      const r4 = runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: target, offset: 10, limit: 60 } },
        { cwd: tmpDir }
      );
      assert.notEqual(r4.verdict.subType, 'READ_INTERVAL_ANCHOR');
      assert.notEqual(r4.verdict.subType, 'READ_INTERVAL_TRIM');
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe('OPT-3C: GUARD-4 Negative-ROI Bugfix (updatedInput Attached)', () => {
  it('attaches bounded updatedInput on both Post-Edit Delta Read and 3rd Repeat-Read AST Stub', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt3c-g4-'));
    try {
      const target = path.join(tmpDir, 'g4_service.mjs');
      const v1Lines = Array.from({ length: 120 }, (_, i) => `export function op_${i + 1}(n) { return n + ${i + 1}; }`);
      fs.writeFileSync(target, v1Lines.join('\n') + '\n', 'utf8');

      const sid = 'sess-opt3c-1';
      runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: target } },
        { cwd: tmpDir }
      );

      // Modify line 75 on disk to trigger GUARD-4 Post-Edit Delta Read
      const v2Lines = [...v1Lines];
      v2Lines[74] = 'export function op_75(n) { return Math.max(0, n * 42); }';
      fs.writeFileSync(target, v2Lines.join('\n') + '\n', 'utf8');

      const deltaRead = runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: target } },
        { cwd: tmpDir }
      );
      const deltaJson = JSON.parse(deltaRead.stdout);
      assert.equal(deltaJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.ok(deltaRead.verdict.deltaDiffStub.includes('+export function op_75'));
      assert.ok(deltaJson.hookSpecificOutput.updatedInput, 'GUARD-4 Delta Read must attach updatedInput');
      assert.ok(deltaJson.hookSpecificOutput.updatedInput.limit <= 40);
      assert.ok(
        deltaJson.hookSpecificOutput.updatedInput.offset <= 75 &&
          deltaJson.hookSpecificOutput.updatedInput.offset + deltaJson.hookSpecificOutput.updatedInput.limit >= 75
      );

      // Repeat unclipped read #3 on realistic multi-line function module -> AST signature stub + 20-line updatedInput anchor
      const astTarget = path.join(tmpDir, 'g4_ast_module.mjs');
      const astBody = Array.from({ length: 85 }, (_, i) => `  const item_${i} = ${i} * 2;`).join('\n');
      fs.writeFileSync(
        astTarget,
        `export function computeWaveMetrics(input, options = {}) {\n${astBody}\n  return { input, options };\n}\n`,
        'utf8'
      );
      const astRead = runPreToolUseHook(
        { session_id: 'sess-opt3c-ast', cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: astTarget }, priorUnclippedReads: 2 },
        { cwd: tmpDir }
      );
      const astJson = JSON.parse(astRead.stdout);
      assert.equal(astJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.ok(astRead.astSignatureStub.includes('computeWaveMetrics'));
      assert.deepEqual(astJson.hookSpecificOutput.updatedInput, {
        file_path: astTarget,
        offset: 1,
        limit: 20
      });
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
