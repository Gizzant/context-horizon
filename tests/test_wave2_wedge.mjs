import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDatabaseSyncClass } from '../src/engine-node/db/probe.mjs';
import { JsonlFallbackDatabaseSync } from '../src/core/sqlite_client.mjs';

const DatabaseSync = getDatabaseSyncClass() || JsonlFallbackDatabaseSync;

import {
  analyzeStaleToolOutputs,
  executeToolOutputSurgery
} from '../src/core/tool_surgeon.mjs';
import {
  auditCursorVscdbOrphans,
  compactCursorVscdbStreaming,
  recoverAntigravityBrainMigration
} from '../src/core/storage_doctor.mjs';
import { distillPreCompactionHandoff } from '../src/core/handoff_audit.mjs';
import {
  evaluatePostCompactionReReadTax,
  detectEffortThrashing
} from '../src/core/layer5_hygiene.mjs';

describe('Wave 2 — Wedge F2 (Prefix-Safe Offline Tool-Output Surgeon)', () => {
  test('F2: analyzeStaleToolOutputs detects SUPERSEDED_READ, UNREFERENCED_SEARCH, and RESOLVED_TEST_STDERR while pinning Turn 0 and newest 6 turns', () => {
    const bigFileRead = 'export function alpha() {}\n' + 'x'.repeat(2400);
    const bigSearchOut = 'src/unreferenced/foo.mjs:10: match\n' + 'y'.repeat(1800);
    const bigStderr = 'AssertionError [ERR_ASSERTION]: test failed\n' + 'z'.repeat(2000);

    const steps = [
      { stepIndex: 0, type: 'SYSTEM_PROMPT', content: 'Pinned Turn 0 anchor ' + 'a'.repeat(1500) },
      { stepIndex: 1, toolCalls: [{ id: 't1', name: 'read_file', args: { Path: 'src/core/quota.mjs' } }], content: bigFileRead },
      { stepIndex: 2, toolCalls: [{ id: 't2', name: 'grep_search', args: { Query: 'foo' } }], content: bigSearchOut },
      { stepIndex: 3, status: 'ERROR', exitCode: 1, toolCalls: [{ id: 't3', name: 'run_command', args: { CommandLine: 'npm test' } }], content: bigStderr },
      { stepIndex: 4, toolCalls: [{ id: 't4', name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }], content: 'Edited quota.mjs' },
      { stepIndex: 5, status: 'DONE', exitCode: 0, toolCalls: [{ id: 't5', name: 'run_command', args: { CommandLine: 'npm test' } }], content: 'PASS all tests (0 fail)' },
      // 6 pinned tail turns (steps 6..11)
      ...Array.from({ length: 6 }, (_, idx) => ({
        stepIndex: 6 + idx,
        toolCalls: [{ id: `tail_${idx}`, name: 'read_file', args: { Path: 'src/core/quota.mjs' } }],
        content: bigFileRead
      }))
    ];

    const res = analyzeStaleToolOutputs(steps, { pinnedTailCount: 6, maxRetainedChars: 300 });
    assert.equal(res.candidates.length, 3, 'Must identify 3 stale tool outputs in middle window');
    assert.equal(res.candidates[0].stepIndex, 1);
    assert.equal(res.candidates[0].reason, 'SUPERSEDED_READ');
    assert.equal(res.candidates[1].stepIndex, 2);
    assert.equal(res.candidates[1].reason, 'UNREFERENCED_SEARCH');
    assert.equal(res.candidates[2].stepIndex, 3);
    assert.equal(res.candidates[2].reason, 'RESOLVED_TEST_STDERR');
    assert.ok(res.totalSavedTokens > 1000);
    // Verify Turn 0 and tail turns 6..11 were NOT modified
    assert.equal(res.prunedSteps[0].content, steps[0].content);
    assert.equal(res.prunedSteps[6].content, bigFileRead);
  });

  test('F2: executeToolOutputSurgery writes atomic .pre_surgeon backup and truncates JSONL on disk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f2-surg-'));
    const jsonlPath = path.join(tmpDir, 'transcript_full.jsonl');
    const bigContent = 'const data = 1;\n' + 'w'.repeat(2000);

    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Init' }),
      JSON.stringify({ step_index: 1, tool_calls: [{ name: 'read_file', args: { Path: 'src/a.mjs' } }], content: bigContent }),
      JSON.stringify({ step_index: 2, tool_calls: [{ name: 'read_file', args: { Path: 'src/a.mjs' } }], content: bigContent }),
      ...Array.from({ length: 6 }, (_, i) => JSON.stringify({ step_index: 3 + i, content: `tail ${i}` }))
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');

    const res = executeToolOutputSurgery(jsonlPath, { dryRun: false, pinnedTailCount: 6 });
    assert.equal(res.success, true);
    assert.equal(res.prunedCount, 1);
    assert.ok(res.savedTokens > 300);
    assert.ok(res.backupPath && fs.existsSync(res.backupPath), 'Backup file must exist');

    const { parseDoctorArgs } = await import('../src/cli/doctor.mjs');
    const parsedArgs = parseDoctorArgs(['doctor', '--prune-tools', '--storage-gc', '--dry-run', '--transcript', jsonlPath]);
    assert.equal(parsedArgs.pruneTools, true);
    assert.equal(parsedArgs.storageGc, true);
    assert.equal(parsedArgs.dryRun, true);
    assert.equal(parsedArgs.transcriptPath, jsonlPath);
  });
});

describe('Wave 2 — Wedge F4 (Local Storage Doctor: Cursor state.vscdb GC & Antigravity Brain Recovery)', () => {
  test('F4: auditCursorVscdbOrphans audits host state.vscdb read-only while compactCursorVscdbStreaming guards host DBs and compacts plugin-owned .agents/ stores', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f4-vscdb-'));
    const hostDbPath = path.join(tmpDir, 'state.vscdb');
    const pluginDbPath = path.join(tmpDir, '.agents', 'cache', 'local_kv.sqlite');
    fs.mkdirSync(path.dirname(pluginDbPath), { recursive: true });

    for (const targetDbPath of [hostDbPath, pluginDbPath]) {
      const db = new DatabaseSync(targetDbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);');
      db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);');
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('workbench.theme', 'dark');
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('composerData:live-1', '{"id":"live-1"}');
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('bubbleId:live-1:b1', '{"text":"keep me"}');
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('bubbleId:dead-99:b1', 'x'.repeat(4000));
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('checkpointId:dead-99:c1', 'y'.repeat(4000));
      db.close();
    }

    const audit = await auditCursorVscdbOrphans(hostDbPath);
    assert.deepEqual(audit.activeComposerIds, ['live-1']);
    assert.equal(audit.orphanRowCount, 2);
    assert.ok(audit.orphanBytes >= 8000);

    const hostBlocked = await compactCursorVscdbStreaming(hostDbPath, { dryRun: false });
    assert.equal(hostBlocked.success, false);
    assert.equal(hostBlocked.blockedHostWrite, true);
    assert.equal(hostBlocked.reason, 'HOST_DB_READONLY_GUARD');

    const gc = await compactCursorVscdbStreaming(pluginDbPath, { dryRun: false });
    assert.equal(gc.success, true);
    assert.equal(gc.exportedLiveRows, 2);
    assert.equal(gc.removedOrphanRows, 2);
    assert.ok(gc.backupPath && fs.existsSync(gc.backupPath));

    const postAudit = await auditCursorVscdbOrphans(pluginDbPath);
    assert.equal(postAudit.orphanRowCount, 0);
  });

  test('F4: recoverAntigravityBrainMigration relinks orphaned brain artifacts across antigravity-cli -> antigravity', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f4-home-'));
    const sid = '11112222-3333-4444-5555-666677778888';
    const cliBrain = path.join(tmpHome, '.gemini', 'antigravity-cli', 'brain', sid);
    const primaryConv = path.join(tmpHome, '.gemini', 'antigravity', 'conversations');
    fs.mkdirSync(cliBrain, { recursive: true });
    fs.mkdirSync(primaryConv, { recursive: true });
    fs.writeFileSync(path.join(primaryConv, `${sid}.db`), '', 'utf8');
    fs.writeFileSync(path.join(cliBrain, 'task.md'), '# Migrated Task\n- [x] Done\n', 'utf8');

    const rec = recoverAntigravityBrainMigration(tmpHome, { dryRun: false });
    assert.equal(rec.scannedDbCount, 1);
    assert.equal(rec.orphanedBrainCount, 1);
    assert.equal(rec.recoveredLinks.length, 1);
    assert.ok(fs.existsSync(path.join(tmpHome, '.gemini', 'antigravity', 'brain', sid, 'task.md')));
  });
});

describe('Wave 2 — Wedge F5 (Pre-Compaction Handoff Distiller) & F8 (Post-Compaction Re-Read & Effort Loop Tax)', () => {
  test('F5: distillPreCompactionHandoff deterministically writes .handoff.md at >=80% saturation with modified files, checklist, last 3 prompts, and unresolved stderr', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f5-ws-'));
    const steps = [
      { stepIndex: 0, type: 'USER_INPUT', content: 'Prompt 1: setup' },
      { stepIndex: 1, type: 'USER_INPUT', content: 'Prompt 2: refactor quota' },
      { stepIndex: 2, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }], content: 'Edited' },
      { stepIndex: 3, toolCalls: [{ name: 'TodoWrite', args: { todos: [{ content: 'Finish Wave 2 tests', status: 'in_progress' }] } }] },
      { stepIndex: 4, type: 'USER_INPUT', content: 'Prompt 3: verify stderr' },
      { stepIndex: 5, status: 'ERROR', stderr: 'SyntaxError: Unexpected token in storage_doctor.mjs' }
    ];

    const res = distillPreCompactionHandoff(
      steps,
      { window: { totalActiveTokens: 215000, maxTokens: 256000 } },
      { workspacePath: tmpWs, writeToDisk: true }
    );

    assert.equal(res.triggered, true);
    assert.equal(res.written, true);
    assert.ok(res.saturationPct >= 80);
    assert.ok(res.modifiedFiles.includes('src/core/quota.mjs'));
    assert.equal(res.lastUserPrompts.length, 3);
    assert.equal(res.unresolvedErrors.length, 1);
    assert.ok(fs.existsSync(res.handoffPath));
  });

  test('F8: evaluatePostCompactionReReadTax quantifies post-compaction re-reads of unmodified files', () => {
    const steps = [
      { stepIndex: 0, toolCalls: [{ name: 'read_file', args: { Path: 'src/core/classifier.mjs' } }], outputTokens: 4500 },
      { stepIndex: 1, type: 'CORTEX_STEP_TYPE_CHECKPOINT', step_type: 23, content: '<CONTEXT_SUMMARY>' },
      { stepIndex: 2, toolCalls: [{ name: 'read_file', args: { Path: 'src/core/classifier.mjs' } }], outputTokens: 4500 }
    ];

    const tax = evaluatePostCompactionReReadTax(steps);
    assert.equal(tax.compactionDetected, true);
    assert.equal(tax.reReadCount, 1);
    assert.equal(tax.totalReReadTaxTokens, 4500);
    assert.equal(tax.reReads[0].path, 'src/core/classifier.mjs');
  });

  test('F8: detectEffortThrashing classifies loop_tax, housekeeping, unused_effort, and thrashing', () => {
    const steps = [
      { stepIndex: 0, status: 'ERROR', thinkingTokens: 3200, outputTokens: 200, content: 'Error' },
      { stepIndex: 1, thinkingTokens: 2000, outputTokens: 150, toolCalls: [{ name: 'TodoWrite', args: {} }] },
      { stepIndex: 2, thinkingTokens: 4200, outputTokens: 300, content: 'ok' },
      { stepIndex: 3, thinkingTokens: 4800, outputTokens: 350, content: 'done' }
    ];

    const thrash = detectEffortThrashing(steps);
    assert.equal(thrash.thrashingDetected, true);
    assert.equal(thrash.flaggedTurns.length, 4);
    assert.equal(thrash.flaggedTurns[0].classification, 'loop_tax');
    assert.equal(thrash.flaggedTurns[1].classification, 'housekeeping');
    assert.equal(thrash.flaggedTurns[2].classification, 'unused_effort');
    assert.equal(thrash.flaggedTurns[3].classification, 'thrashing');
  });
});
