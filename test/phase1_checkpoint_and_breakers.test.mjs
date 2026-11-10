import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECKPOINT_BANDS,
  SOFT_WATERMARK_TOKENS,
  ProgressiveCheckpointer,
  extractNegativeConstraints,
  parseTaskMdChecklist
} from '../src/core/coach/progressive_checkpointer.mjs';
import {
  CircuitBreakers,
  inspectFileShrinkage,
  inspectErrorMaskingDiff
} from '../src/core/coach/circuit_breakers.mjs';

test('Phase 1 (DET-10): ProgressiveCheckpointer snapshots at 50k soft watermark and 20/35/50/65/80% bands with zero rule file mutations', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-ckpt-test-'));
  try {
    const checkpointer = new ProgressiveCheckpointer({
      workspaceDir: tmpDir,
      maxTokens: 256000,
      captureGitStat: false
    });

    assert.deepEqual(CHECKPOINT_BANDS, [0.20, 0.35, 0.50, 0.65, 0.80]);
    assert.equal(SOFT_WATERMARK_TOKENS, 50000);

    const sampleTaskMd = [
      '# Task Checklist',
      '- [x] Phase 0 setup',
      '- [/] Implement ProgressiveCheckpointer DET-10',
      '- [ ] Wire into server.mjs'
    ].join('\n');

    const sampleAgentsMd = [
      '# Invariants',
      '- NEVER render a clickable Copy button for /compact.',
      '- MUST preserve 3-Way SHA-256 mirror parity across webviews.',
      '- Do not open session SQLite databases in write mode.'
    ].join('\n');

    // 1. Below 50k (e.g. 30,000 tokens = 11.7%) -> no snapshot
    const belowRes = checkpointer.evaluateAndSnapshot({
      sessionId: 'sess-alpha',
      totalTokens: 30000,
      taskMdContent: sampleTaskMd,
      agentsMdContent: sampleAgentsMd
    });
    assert.equal(belowRes.snapshotted, false);

    // 2. Cross 50,000 soft watermark & 20% band (52,000 tokens = 20.3%) -> snapshots once
    const band20Res = checkpointer.evaluateAndSnapshot({
      sessionId: 'sess-alpha',
      totalTokens: 52000,
      taskMdContent: sampleTaskMd,
      agentsMdContent: sampleAgentsMd,
      modifiedFiles: [{ path: 'src/core/coach/progressive_checkpointer.mjs', content: 'export default 1;' }]
    });
    assert.equal(band20Res.snapshotted, true);
    assert.ok(band20Res.triggeredBands.includes('50k_watermark'));
    assert.ok(band20Res.triggeredBands.includes('20%'));
    assert.ok(fs.existsSync(band20Res.checkpoint.filePath));
    assert.equal(band20Res.checkpoint.zeroTokenOverhead, true);
    assert.equal(band20Res.checkpoint.negativeConstraints.length, 3);
    assert.deepEqual(band20Res.checkpoint.taskChecklist.inProgress, [
      'Implement ProgressiveCheckpointer DET-10'
    ]);

    // 3. Re-evaluating at 55,000 tokens (still in 20% band) does NOT duplicate snapshot
    const repeat20Res = checkpointer.evaluateAndSnapshot({
      sessionId: 'sess-alpha',
      totalTokens: 55000,
      taskMdContent: sampleTaskMd,
      agentsMdContent: sampleAgentsMd
    });
    assert.equal(repeat20Res.snapshotted, false);

    // 4. Cross 35% band (92,000 tokens = 35.9%) -> new snapshot
    const band35Res = checkpointer.evaluateAndSnapshot({
      sessionId: 'sess-alpha',
      totalTokens: 92000,
      taskMdContent: sampleTaskMd,
      agentsMdContent: sampleAgentsMd
    });
    assert.equal(band35Res.snapshotted, true);
    assert.equal(band35Res.bandLabel, '35%');

    // 5. Simulate post-compaction `<CONTEXT_SUMMARY>` that evaporated the SQLite read-only rule and active task
    const truncatedCompactionSummary = [
      'Summary of previous turns:',
      'We kept the /compact instruction as plain text without a copy button and verified 3-Way SHA-256 mirror parity.'
    ].join('\n');

    const evapAudit = checkpointer.detectConstraintEvaporation(truncatedCompactionSummary, 'sess-alpha');
    assert.equal(evapAudit.evaporated, true);
    assert.equal(evapAudit.detectorId, 'DET-10');
    assert.equal(evapAudit.missingConstraints.length, 1);
    assert.ok(evapAudit.missingConstraints[0].includes('session SQLite databases'));
    assert.equal(evapAudit.missingActiveTasks.length, 1);
    assert.ok(evapAudit.recoveryPrompt.includes('Implement ProgressiveCheckpointer DET-10'));
    assert.ok(evapAudit.recoveryPrompt.includes('Do not open session SQLite databases in write mode'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 1 (DET-04): CircuitBreakers detects >50% destructive file shrinkage unless user prompt authorizes deletion', () => {
  const cb = new CircuitBreakers();
  const fortyLines = Array.from({ length: 40 }, (_, i) => `export const line_${i} = ${i};`).join('\n');
  const tenLines = Array.from({ length: 10 }, (_, i) => `export const line_${i} = ${i};`).join('\n');

  // 1. Unauthorized 75% shrinkage (40 -> 10 lines) trips DET-04
  const unauthorizedRes = cb.recordTurn({
    turnIndex: 1,
    toolName: 'edit_file',
    filePath: 'src/core/service.mjs',
    previousContent: fortyLines,
    newContent: tenLines,
    userPrompt: 'Fix the typo in line_2'
  });

  assert.equal(unauthorizedRes.hasTripped, true);
  const det04 = unauthorizedRes.triggered.find((a) => a.detectorId === 'DET-04');
  assert.ok(det04, 'DET-04 must trip on unauthorized >50% file shrinkage');
  assert.equal(det04.shrinkagePct, 75);
  assert.equal(det04.previousLines, 40);
  assert.equal(det04.newLines, 10);

  // 2. Authorized deletion in user prompt ("remove legacy exports and strip old helpers") does NOT trip DET-04
  const authorizedRes = cb.recordTurn({
    turnIndex: 2,
    toolName: 'edit_file',
    filePath: 'src/core/legacy.mjs',
    previousContent: fortyLines,
    newContent: tenLines,
    userPrompt: 'Please remove the deprecated helpers and strip the file down'
  });
  const det04Auth = authorizedRes.triggered.find((a) => a.detectorId === 'DET-04');
  assert.equal(det04Auth, undefined, 'DET-04 must not trip when user explicitly requests removal');
});

test('Phase 1 (DET-05): CircuitBreakers catches removed try/catch blocks, empty catch swallows, and @ts-ignore / eslint-disable', () => {
  const cb = new CircuitBreakers();

  const beforeCode = [
    'export async function fetchData() {',
    '  try {',
    '    return await api.get();',
    '  } catch (err) {',
    '    logger.error(err);',
    '    throw err;',
    '  }',
    '}'
  ].join('\n');

  const afterMaskedCode = [
    'export async function fetchData() {',
    '  // @ts-ignore',
    '  try {',
    '    return await api.get();',
    '  } catch (err) {}',
    '}'
  ].join('\n');

  const res = cb.recordTurn({
    turnIndex: 1,
    toolName: 'edit_file',
    filePath: 'src/core/fetcher.mjs',
    previousContent: beforeCode,
    newContent: afterMaskedCode
  });

  assert.equal(res.hasTripped, true);
  const det05 = res.triggered.find((a) => a.detectorId === 'DET-05');
  assert.ok(det05, 'DET-05 must trip when error handlers are replaced with empty catch or @ts-ignore');
  assert.ok(det05.emptyCatchAddedCount >= 1);
  assert.ok(det05.suppressionsAddedCount >= 1);
});

test('Phase 1 (DET-17b): CircuitBreakers flags blind edits on unread files and unindexed new file creation', () => {
  const cb = new CircuitBreakers({ enableBlindEditGuard: true });

  // 1. Editing an existing file without reading it first trips DET-17b (mode: blind_edit)
  const blindEditRes = cb.recordTurn({
    turnIndex: 1,
    toolName: 'edit_file',
    filePath: 'src/core/unseen_module.mjs',
    newContent: 'export const x = 42;'
  });
  const det17Blind = blindEditRes.triggered.find((a) => a.detectorId === 'DET-17b');
  assert.ok(det17Blind, 'DET-17b must trip when editing a file without prior read_file');
  assert.equal(det17Blind.mode, 'blind_edit');

  // 2. Reading a file first, then editing it -> does NOT trip DET-17b
  cb.recordTurn({
    turnIndex: 2,
    toolName: 'read_file',
    filePath: 'src/core/seen_module.mjs'
  });
  const informedEditRes = cb.recordTurn({
    turnIndex: 3,
    toolName: 'edit_file',
    filePath: 'src/core/seen_module.mjs',
    newContent: 'export const y = 99;'
  });
  assert.equal(
    informedEditRes.triggered.find((a) => a.detectorId === 'DET-17b'),
    undefined,
    'DET-17b must not trip after file has been read'
  );
});

test('Stage 4 (Tasks 4.1 & 4.2): Antigravity edit schemas (TargetContent, ReplacementContent, ReplacementChunks) and non-destructive diff preview revert', () => {
  const cb = new CircuitBreakers();

  // 1. replace_file_content schema with TargetContent / ReplacementContent on test file
  const repRes = cb.recordTurn({
    turnIndex: 1,
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'test/sample.test.mjs',
      TargetContent: 'assert.equal(a, 1);\nexpect(b).toBe(2);',
      ReplacementContent: '// removed assertions'
    }
  });
  const det03Single = repRes.triggered.find((a) => a.detectorId === 'DET-03');
  assert.ok(det03Single, 'DET-03 must detect assertion deletion in replace_file_content');
  assert.equal(det03Single.revertAction.nonDestructive, true);
  assert.ok(det03Single.revertAction.command.includes('git diff -- "test/sample.test.mjs"'));
  assert.ok(!det03Single.revertAction.command.includes('git checkout'));

  // 2. multi_replace_file_content schema with ReplacementChunks
  const multiRes = cb.recordTurn({
    turnIndex: 2,
    toolName: 'multi_replace_file_content',
    args: {
      TargetFile: 'test/multi.test.mjs',
      ReplacementChunks: [
        { TargetContent: 'assert.ok(valid);', ReplacementContent: '// chunk 1' },
        { TargetContent: 'assert.strictEqual(x, 42);', ReplacementContent: '// chunk 2' }
      ]
    }
  });
  const det03Multi = multiRes.triggered.find((a) => a.detectorId === 'DET-03');
  assert.ok(det03Multi, 'DET-03 must detect assertion deletion across ReplacementChunks');
  assert.equal(det03Multi.netDeletedCount, 2);

  // 3. revertWeakenedTestFile executes git diff -- instead of git checkout --
  const executedGitCalls = [];
  const previewRes = cb.revertWeakenedTestFile('test/multi.test.mjs', {
    execFn: (bin, gitArgs) => {
      executedGitCalls.push({ bin, gitArgs });
      return 'diff --git a/test/multi.test.mjs b/test/multi.test.mjs\n-assert.ok(valid);';
    }
  });
  assert.equal(previewRes.ok, true);
  assert.equal(previewRes.nonDestructive, true);
  assert.equal(executedGitCalls.length, 1);
  assert.deepEqual(executedGitCalls[0].gitArgs, ['diff', '--', 'test/multi.test.mjs']);
});
