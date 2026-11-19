import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  FTS5_COMPRESSOR_CONSTANTS,
  classifyCliCommandFamily,
  compressCliOutputFts5,
  compressCliOutputFts5Sync,
  searchToolLogsFts5
} from '../src/core/fts5_output_compressor.mjs';
import {
  DEFAULT_SHIELD_MAX_UNSLICED_BYTES,
  CLIFF_SHIELD_MAX_UNSLICED_BYTES,
  configureShield,
  evaluateShieldReadGuard
} from '../src/core/shield_manager.mjs';
import { computePostEditReadWindow } from '../src/core/code_fold_lite.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { readLedgerEntries } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    void err;
  }
}

describe('IMP-1: Broad CLI FTS5 Compressor (>40 lines or >=4,096 bytes + missed CLI families)', () => {
  it('compresses 50-line Select-String, Get-ChildItem, node, python, npm install, and PowerShell heredoc outputs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-imp1-broad-'));
    const dbPath = path.join(tmpDir, '.claude', 'cache', 'tool_logs_fts5.db');
    try {
      assert.equal(FTS5_COMPRESSOR_CONSTANTS.MIN_LINES_TO_COMPRESS, 40);
      assert.equal(FTS5_COMPRESSOR_CONSTANTS.MIN_BYTES_TO_COMPRESS, 4096);

      const commands = [
        {
          cmd: 'Select-String -Path src\\*.mjs -Pattern "router"',
          expectedFamily: 'search_list',
          body: Array.from({ length: 50 }, (_, i) => `src/core/mod_${i}.mjs:${i + 10}: export function route${i}() {}`).join('\n'),
          keyword: 'route25'
        },
        {
          cmd: 'Get-ChildItem -Recurse src',
          expectedFamily: 'search_list',
          body: Array.from({ length: 50 }, (_, i) => `C:/proj/src/sub_${i % 5}/file_${i}.mjs`).join('\n'),
          keyword: 'file_33'
        },
        {
          cmd: 'node scripts/check_matrix.mjs',
          expectedFamily: 'generic_cli',
          body: Array.from({ length: 50 }, (_, i) => (i === 12 ? 'Error: IMP1_NODE_TOKEN_42 failed' : `check step ${i} ok`)).join('\n'),
          keyword: 'IMP1_NODE_TOKEN_42'
        },
        {
          cmd: 'python analyze.py --report',
          expectedFamily: 'generic_cli',
          body: Array.from({ length: 50 }, (_, i) => `row ${i}: metric=${i * 1.5} status=OK`).join('\n'),
          keyword: 'metric=30'
        },
        {
          cmd: 'npm install --no-audit',
          expectedFamily: 'generic_cli',
          body: Array.from({ length: 50 }, (_, i) => `added pkg-${i}@1.0.${i} in 12ms`).join('\n'),
          keyword: 'pkg-41'
        },
        {
          cmd: "@'\nGet-Process\n'@",
          expectedFamily: 'generic_cli',
          body: Array.from({ length: 50 }, (_, i) => `proc-${i} mem=${i * 10}MB`).join('\n'),
          keyword: 'proc-19'
        }
      ];

      for (let i = 0; i < commands.length; i += 1) {
        const entry = commands[i];
        assert.equal(classifyCliCommandFamily(entry.cmd), entry.expectedFamily);
        const turnId = `turn-imp1-${i}`;
        const res = await compressCliOutputFts5({
          sessionId: 'sess-imp1',
          turnId,
          command: entry.cmd,
          exitCode: 0,
          rawOutput: entry.body,
          dbPath,
          homeDir: tmpDir
        });
        assert.equal(res.compressed, true, `Expected ${entry.cmd} to compress`);
        assert.ok(res.tokensSaved > 0, `Expected tokensSaved > 0 for ${entry.cmd}`);
        assert.ok(res.lineCount <= 25, `Expected <=25 lines for ${entry.cmd}, got ${res.lineCount}`);
        assert.ok(res.output.includes(`agy-log-search ${turnId}`));

        const hits = await searchToolLogsFts5(dbPath, { turnId, keyword: entry.keyword });
        assert.ok(hits.hits.length >= 1 && hits.matchedLines.length >= 1, `FTS5 must index ${entry.keyword}`);
      }

      // Existing test family classification stays preserved
      assert.equal(classifyCliCommandFamily('node --test test/foo.test.mjs'), 'test');
      assert.equal(classifyCliCommandFamily('git diff HEAD~1'), 'git');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('compresses wide single-line >=4 KB JSON dumps while leaving short <40 line & <4 KB output untouched', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-imp1-wide-'));
    const dbPath = path.join(tmpDir, '.claude', 'cache', 'tool_logs_fts5.db');
    try {
      const widePayload = JSON.stringify({
        items: Array.from({ length: 180 }, (_, i) => ({ id: i, name: `wide_record_${i}`, status: 'ok' }))
      });
      assert.ok(widePayload.length >= 4096);
      assert.equal(widePayload.split(/\r?\n/).length, 1);

      const comp = compressCliOutputFts5Sync({
        sessionId: 'sess-wide',
        turnId: 'turn-wide-1',
        command: 'node -e "console.log(JSON.stringify(data))"',
        exitCode: 0,
        rawOutput: widePayload,
        dbPath,
        homeDir: tmpDir,
        recordLedger: false
      });
      assert.equal(comp.compressed, true);
      assert.ok(comp.tokensSaved > 1000, `Expected >1000 tokensSaved, got ${comp.tokensSaved}`);
      assert.ok(comp.lineCount <= 25);

      const shortRes = compressCliOutputFts5Sync({
        sessionId: 'sess-wide',
        turnId: 'turn-short-1',
        command: 'node -e "console.log(123)"',
        exitCode: 0,
        rawOutput: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'),
        dbPath,
        homeDir: tmpDir,
        recordLedger: false
      });
      assert.equal(shortRes.compressed, false);
      assert.equal(shortRes.tokensSaved, 0);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('compresses PowerShell Select-String (~6 KB, 60 lines) in-place inside live runPostToolUseHook', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-imp1-posthook-'));
    try {
      const outputBody = Array.from(
        { length: 60 },
        (_, i) => `src/core/file_${i}.mjs:${i + 1}: const value_${i} = "${'x'.repeat(68)}";`
      ).join('\n');
      assert.ok(outputBody.length >= 4096 && outputBody.length < 16000);

      const hookRes = runPostToolUseHook(
        {
          session_id: 'sess-ps-post',
          tool_use_id: 'tu-ps-60',
          cwd: tmpDir,
          tool_name: 'PowerShell',
          tool_input: { command: 'Select-String -Path src/*.mjs -Pattern "value_"' },
          tool_response: { stdout: outputBody, stderr: '' }
        },
        { cwd: tmpDir }
      );
      assert.equal(hookRes.exitCode, 0);
      assert.ok(hookRes.hookSpecificOutput?.updatedToolOutput, 'Expected updatedToolOutput');
      const replaced = hookRes.hookSpecificOutput.updatedToolOutput.stdout;
      assert.ok(replaced.includes('[FTS5 Compressed CLI Output]'));
      assert.ok(replaced.includes('agy-log-search tu-ps-60'));

      const receipts = readLedgerEntries({ cwd: tmpDir });
      assert.ok(
        receipts.some((r) => r.category === 'CLI_FTS5_COMPRESSED' && Number(r.savedTokens) > 500),
        'Expected CLI_FTS5_COMPRESSED receipt in saved-quota ledger'
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe('IMP-4D: Byte-Width Read Guard (>16 KB off-cliff, >6 KB near pricing cliff)', () => {
  it('clamps wide 150-line >16 KB markdown reads in-place on Claude, blocks on Antigravity & unclampable minified files, and clamps 8 KB at 90% cliff', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-imp4d-width-'));
    try {
      assert.equal(DEFAULT_SHIELD_MAX_UNSLICED_BYTES, 16_384);
      assert.equal(CLIFF_SHIELD_MAX_UNSLICED_BYTES, 6_144);
      configureShield({ action: 'enable', platform: 'all', cwd: tmpDir });

      // Wide 150-line markdown (~31 KB > 16 KB byte-width cap, yet <= 1200 lines)
      const wideMd = path.join(tmpDir, 'wide_spec.md');
      const mdLines = Array.from({ length: 150 }, (_, i) =>
        i % 30 === 0
          ? `## Section ${i / 30}\n` + `Detailed specification prose token payload line ${i} ` + 'w'.repeat(180)
          : `Item ${i}: ` + 'z'.repeat(200)
      );
      fs.writeFileSync(wideMd, mdLines.join('\n'), 'utf8');
      assert.ok(fs.statSync(wideMd).size > DEFAULT_SHIELD_MAX_UNSLICED_BYTES);

      // Claude Code clamps in-place via updatedInput + inline structural index (0 extra turn!)
      const ccClamp = runPreToolUseHook(
        {
          session_id: 'sess-imp4d-cc',
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: wideMd }
        },
        { cwd: tmpDir }
      );
      assert.equal(ccClamp.verdict.decision, 'allow');
      assert.equal(ccClamp.verdict.subType, 'BYTE_WIDTH_CLAMP');
      assert.equal(ccClamp.verdict.triggerReason, 'byte_width_cap');
      assert.equal(ccClamp.verdict.updatedInput.offset, 1);
      assert.ok(ccClamp.verdict.updatedInput.limit >= 15 && ccClamp.verdict.updatedInput.limit < 150);
      assert.ok(ccClamp.verdict.indexPath && fs.existsSync(ccClamp.verdict.indexPath));
      const ccHookJson = JSON.parse(ccClamp.stdout);
      assert.equal(ccHookJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.equal(ccHookJson.hookSpecificOutput.updatedInput.offset, 1);
      assert.ok(ccHookJson.hookSpecificOutput.additionalContext.includes('## Section'));

      // Antigravity retains deny semantics because its hook API lacks updatedInput
      const agDeny = await handlePreToolUse({
        conversationId: 'ag-imp4d-test-1',
        cwd: tmpDir,
        tool_name: 'read_file',
        tool_input: { Path: wideMd }
      });
      assert.equal(agDeny.decision, 'deny');
      assert.equal(agDeny.triggerReason, 'byte_width_cap');
      assert.ok(agDeny.reason.includes('byte-width cap'));

      // Unclampable single-line 24 KB minified file (<20 lines) on Claude falls back to deny
      const minifiedBundle = path.join(tmpDir, 'minified.js');
      fs.writeFileSync(minifiedBundle, `export const data="${'x'.repeat(24_000)}";\n`, 'utf8');
      const ccMinifiedDeny = evaluateShieldReadGuard({
        platform: 'claude',
        cwd: tmpDir,
        filePath: minifiedBundle,
        hasSliceBounds: false,
        recordLedger: false
      });
      assert.equal(ccMinifiedDeny.action, 'deny');
      assert.equal(ccMinifiedDeny.triggerReason, 'byte_width_cap');

      // Sliced reads pass on both hosts
      const ccSliced = runPreToolUseHook(
        {
          session_id: 'sess-imp4d-cc',
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: wideMd, offset: 1, limit: 80 }
        },
        { cwd: tmpDir }
      );
      assert.notEqual(ccSliced.verdict.decision, 'deny');
      assert.notEqual(ccSliced.verdict.subType, 'BYTE_WIDTH_CLAMP');

      const agSliced = await handlePreToolUse({
        conversationId: 'ag-imp4d-test-1',
        cwd: tmpDir,
        tool_name: 'read_file',
        tool_input: { Path: wideMd, StartLine: 1, EndLine: 80 }
      });
      assert.notEqual(agSliced.decision, 'deny');

      // 80-line 8 KB wide file allowed off-cliff, clamped in-place at 90% Haiku cliff (> 6 KB cliff byte cap)
      const cliffMd = path.join(tmpDir, 'cliff_wide.md');
      fs.writeFileSync(
        cliffMd,
        Array.from({ length: 80 }, (_, i) => (i % 20 === 0 ? `# Heading ${i}` : 'k'.repeat(110))).join('\n'),
        'utf8'
      );
      assert.ok(fs.statSync(cliffMd).size > CLIFF_SHIELD_MAX_UNSLICED_BYTES);
      assert.ok(fs.statSync(cliffMd).size < DEFAULT_SHIELD_MAX_UNSLICED_BYTES);

      const offCliffAllow = evaluateShieldReadGuard({
        platform: 'claude',
        cwd: tmpDir,
        filePath: cliffMd,
        hasSliceBounds: false,
        currentPromptTokens: 10_000,
        modelId: 'claude-haiku-5-5',
        recordLedger: false
      });
      assert.equal(offCliffAllow.action, 'allow');

      const nearCliffClamp = evaluateShieldReadGuard({
        platform: 'claude',
        cwd: tmpDir,
        filePath: cliffMd,
        hasSliceBounds: false,
        currentPromptTokens: 92_000,
        modelId: 'claude-haiku-5-5',
        recordLedger: false
      });
      assert.equal(nearCliffClamp.action, 'clamp');
      assert.equal(nearCliffClamp.triggerReason, 'byte_width_cap');
      assert.equal(nearCliffClamp.detectorId, 'DET-12');
      assert.ok(nearCliffClamp.clampLimit < 80);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe('IMP-4B: Post-Edit Verify Re-Read Fold (Claude Code & Antigravity)', () => {
  it('folds immediate post-Edit re-reads (>150 lines) to a 150-line window centered on the edited hunk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-imp4b-fold-'));
    try {
      const targetCc = path.join(tmpDir, 'service_cc.mjs');
      const v1Lines = Array.from({ length: 300 }, (_, i) => `export function step_${i + 1}(x) { return x + ${i + 1}; }`);
      const v1 = v1Lines.join('\n') + '\n';
      const v2Lines = [...v1Lines];
      v2Lines[199] = 'export function step_200(x) { return Math.max(0, x - 99); }';
      const v2 = v2Lines.join('\n') + '\n';

      // Pure helper bounds check
      const winCheck = computePostEditReadWindow({ prevContent: v1, nextContent: v2, windowLines: 150 });
      assert.equal(winCheck.shouldFold, true);
      assert.equal(winCheck.hunkStartLine, 200);
      assert.equal(winCheck.windowLimit, 150);
      assert.ok(winCheck.windowStart <= 200 && winCheck.windowEnd >= 200);

      // 1. Claude Code: Edit hook (with NO prior Read) -> disk mutates -> immediate unsliced Read
      fs.writeFileSync(targetCc, v1, 'utf8');
      const ccSid = 'cc-imp4b-1';
      runPreToolUseHook(
        {
          session_id: ccSid,
          cwd: tmpDir,
          tool_name: 'Edit',
          tool_input: { file_path: targetCc, old_string: v1Lines[199], new_string: v2Lines[199] }
        },
        { cwd: tmpDir }
      );
      fs.writeFileSync(targetCc, v2, 'utf8');

      const ccVerifyRead = runPreToolUseHook(
        {
          session_id: ccSid,
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: targetCc }
        },
        { cwd: tmpDir }
      );
      assert.equal(ccVerifyRead.verdict.triggered, true);
      assert.equal(ccVerifyRead.verdict.subType, 'POST_EDIT_VERIFY_FOLD');
      assert.equal(ccVerifyRead.verdict.updatedInput.limit, 150);
      assert.ok(ccVerifyRead.verdict.updatedInput.offset <= 200);
      assert.ok(ccVerifyRead.verdict.deltaDiffStub?.includes('+export function step_200'));
      assert.ok(ccVerifyRead.verdict.savedTokens > 0);

      // Oversized 260-line slice also clamps to 150
      const ccOverslice = runPreToolUseHook(
        {
          session_id: ccSid,
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: targetCc, offset: 1, limit: 260 }
        },
        { cwd: tmpDir }
      );
      assert.equal(ccOverslice.verdict.subType, 'POST_EDIT_VERIFY_FOLD');
      assert.equal(ccOverslice.verdict.updatedInput.limit, 150);

      // Already <=150-line bounded verify slice passes without folding
      const ccSmallSlice = runPreToolUseHook(
        {
          session_id: ccSid,
          cwd: tmpDir,
          tool_name: 'Read',
          tool_input: { file_path: targetCc, offset: 175, limit: 60 }
        },
        { cwd: tmpDir }
      );
      assert.notEqual(ccSmallSlice.verdict.subType, 'POST_EDIT_VERIFY_FOLD');

      const receipts = readLedgerEntries({ cwd: tmpDir });
      assert.ok(receipts.some((r) => r.category === 'BOUNDED_READ_ENFORCED' && Number(r.savedTokens) > 0));

      // 2. Antigravity: COACH (advisory allow) vs Active Shield (deny with recommendedSlice)
      const targetAg = path.join(tmpDir, 'service_ag.mjs');
      fs.writeFileSync(targetAg, v1, 'utf8');
      const agCoachConv = 'ag-imp4b-coach-1';
      await handlePreToolUse({
        conversationId: agCoachConv,
        cwd: tmpDir,
        tool_name: 'edit_file',
        tool_input: { Path: targetAg, Target: v1Lines[199], Replacement: v2Lines[199] }
      });
      fs.writeFileSync(targetAg, v2, 'utf8');

      const agCoachRead = await handlePreToolUse({
        conversationId: agCoachConv,
        cwd: tmpDir,
        tool_name: 'read_file',
        tool_input: { Path: targetAg }
      });
      assert.equal(agCoachRead.decision, 'allow');
      assert.equal(agCoachRead.postEditVerifyFolded, true);
      assert.ok(agCoachRead.recommendedSlice.EndLine - agCoachRead.recommendedSlice.StartLine + 1 <= 150);
      assert.ok(agCoachRead.deltaDiffStub?.includes('+export function step_200'));
      assert.ok(agCoachRead.systemMessage?.includes('StartLine:'));

      // Active Shield enabled -> blocks unsliced verify re-read with slice coords + delta diff
      configureShield({ action: 'enable', platform: 'all', cwd: tmpDir });
      fs.writeFileSync(targetAg, v1, 'utf8');
      const agShieldConv = 'ag-imp4b-shield-1';
      await handlePreToolUse({
        conversationId: agShieldConv,
        cwd: tmpDir,
        tool_name: 'edit_file',
        tool_input: { Path: targetAg, Target: v1Lines[199], Replacement: v2Lines[199] }
      });
      fs.writeFileSync(targetAg, v2, 'utf8');

      const agShieldRead = await handlePreToolUse({
        conversationId: agShieldConv,
        cwd: tmpDir,
        tool_name: 'read_file',
        tool_input: { Path: targetAg }
      });
      assert.equal(agShieldRead.decision, 'deny');
      assert.equal(agShieldRead.subType, 'POST_EDIT_VERIFY_FOLD');
      assert.equal(agShieldRead.postEditVerifyFolded, true);
      assert.ok(agShieldRead.recommendedSlice.StartLine <= 200 && agShieldRead.recommendedSlice.EndLine >= 200);
      assert.ok(agShieldRead.deltaDiffStub?.includes('+export function step_200'));
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
