import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  checkIndex,
  buildIndex,
  sliceFile,
  runDocIndexerCli
} from '../src/core/doc_indexer.mjs';
import {
  evaluateShieldReadGuard,
  configureShield,
  getShieldStatus
} from '../src/core/shield_manager.mjs';
import {
  runSessionAudit,
  formatSessionAuditReport
} from '../src/core/session_auditor.mjs';
import { sanitizePostToolOutput } from '../src/core-isomorphic/guards/losslessPostSanitizer.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { runCli } from '../bin/ctxtop.mjs';
import '../src/utils/nodeIo.mjs';

test('1. doc_indexer.mjs: FRESH/STALE/MISSING lifecycle, .agents/cache/indices cleanliness, 150-line fallback, CRLF/LF --slice, and SKU exclusion', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-doc-idx-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const structuredPath = path.join(srcDir, 'engine.mjs');
    const structuredContent = [
      '// Preamble header',
      'export function initializeEngine(configOption) {',
      '  return configOption;',
      '}',
      'export class TelemetryCollector {',
      '  recordMetric(metricPayload) { return metricPayload; }',
      '}',
      'export async function flushBatchQueue(batchItems) {',
      '  return batchItems.length;',
      '}'
    ].join('\r\n'); // CRLF input
    fs.writeFileSync(structuredPath, structuredContent, 'utf8');

    // MISSING before first build
    const missing = checkIndex(structuredPath, { cwd: tmpDir });
    assert.equal(missing.code, 2);
    assert.equal(missing.status, 'MISSING');

    // Build index -> stored inside .agents/cache/indices/, NOT next to src/engine.mjs
    const built = buildIndex(structuredPath, { cwd: tmpDir });
    assert.equal(built.ok, true);
    assert.equal(built.usedFallback, false);
    assert.ok(fs.existsSync(built.indexPath));
    assert.equal(fs.existsSync(`${structuredPath}.index.md`), false);
    assert.ok(built.relIndexPath.startsWith('.agents/cache/indices/'));
    assert.ok(built.markdown.includes('generated_by: "ctxtop-doc-indexer"'));
    assert.ok(built.markdown.includes('initializeEngine'));
    assert.ok(built.markdown.includes('TelemetryCollector'));

    // FRESH immediately after build
    const fresh = checkIndex(structuredPath, { cwd: tmpDir });
    assert.equal(fresh.code, 0);
    assert.equal(fresh.status, 'FRESH');

    // Mutate file -> STALE (1)
    fs.writeFileSync(structuredPath, `${structuredContent}\r\nexport const extraFlag = true;\r\n`, 'utf8');
    const stale = checkIndex(structuredPath, { cwd: tmpDir });
    assert.equal(stale.code, 1);
    assert.equal(stale.status, 'STALE');

    // CRLF and LF --slice parity
    const cliSlice = runDocIndexerCli(['--slice', structuredPath, '2', '5', '--cwd', tmpDir]);
    assert.equal(cliSlice.exitCode, 0);
    assert.ok(cliSlice.output.includes('     2 | export function initializeEngine'));
    assert.ok(cliSlice.output.includes('     5 | export class TelemetryCollector'));
    assert.ok(!cliSlice.output.includes('\r'));

    // Unstructured 500-line log (>400 lines, <3 headings/defs) -> 150-line spans in <20ms
    const rawDumpPath = path.join(tmpDir, 'dump.txt');
    const rawDump = Array.from(
      { length: 500 },
      (_, idx) => `2026-11-15T00:00:00Z worker_trace_${idx % 5} token_batch_${idx}`
    ).join('\n');
    fs.writeFileSync(rawDumpPath, rawDump, 'utf8');
    const fallbackBuild = buildIndex(rawDumpPath, { cwd: tmpDir });
    assert.equal(fallbackBuild.ok, true);
    assert.equal(fallbackBuild.usedFallback, true);
    assert.equal(fallbackBuild.spanCount, 4); // L1-150, L151-300, L301-450, L451-500
    assert.ok(fallbackBuild.markdown.includes('| L1-L150 |'));
    assert.ok(fallbackBuild.markdown.includes('| L451-L500 |'));

    // Strict SKU boundary: packages/airlock/ must be skipped and never indexed
    const forbiddenDir = path.join(tmpDir, 'packages', 'airlock');
    fs.mkdirSync(forbiddenDir, { recursive: true });
    const forbiddenFile = path.join(forbiddenDir, 'secret_sku.mjs');
    fs.writeFileSync(forbiddenFile, 'export function vaultOnly() {}\n', 'utf8');

    const skippedBuild = buildIndex(forbiddenFile, { cwd: tmpDir });
    assert.equal(skippedBuild.ok, false);
    assert.equal(skippedBuild.skipped, true);
    assert.equal(fs.existsSync(skippedBuild.indexPath), false);
    const skippedSlice = sliceFile(forbiddenFile, 1, 5, { cwd: tmpDir });
    assert.equal(skippedSlice.ok, false);
    assert.equal(skippedSlice.skipped, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. Net-positive Read Firewall: allows routine 500-line files, blocks >=1,200-line un-sliced reads across Claude & Antigravity (read_file|view_file), and tightens to 150 lines near pricing cliffs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-shield-read-'));
  try {
    configureShield({ action: 'enable', platform: 'all', cwd: tmpDir });

    // Routine 500-line file is ALLOWED so we do not burn 80k warm-cache prefix tokens on an extra turn
    const mediumFile = path.join(tmpDir, 'medium_500.mjs');
    fs.writeFileSync(
      mediumFile,
      Array.from({ length: 500 }, (_, i) => `export const val_${i} = ${i};`).join('\n'),
      'utf8'
    );
    const mediumClaude = runPreToolUseHook(
      {
        session_id: 'sess-med',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: mediumFile }
      },
      { cwd: tmpDir }
    );
    assert.equal(mediumClaude.verdict.decision !== 'deny', true);

    // Near 100k Haiku 5.5 pricing cliff (92,000 prompt tokens >= 90% of 100k), 500-line file > 150-line cliff cap IS blocked!
    const cliffClaude = runPreToolUseHook(
      {
        session_id: 'sess-cliff',
        cwd: tmpDir,
        model: 'claude-haiku-5-5',
        usage: { input_tokens: 92_000 },
        tool_name: 'Read',
        tool_input: { file_path: mediumFile }
      },
      { cwd: tmpDir }
    );
    assert.equal(cliffClaude.exitCode, 0);
    const cliffJson = JSON.parse(cliffClaude.stdout);
    assert.equal(cliffJson.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(cliffJson.hookSpecificOutput.permissionDecisionReason.includes('150-line cap'));

    // 1,300-line monolith is DENIED on Claude (`Read`) AND Antigravity (`read_file` with `Path` + `view_file` with `AbsolutePath`)
    const monolithFile = path.join(tmpDir, 'monolith_1300.mjs');
    fs.writeFileSync(
      monolithFile,
      Array.from(
        { length: 1300 },
        (_, i) =>
          i % 200 === 0
            ? `export function handleRoute_${i}(ctx) { return ctx; }`
            : `  const linePayload_${i} = "${'x'.repeat(32)}";`
      ).join('\n'),
      'utf8'
    );

    const claudeDeny = runPreToolUseHook(
      {
        session_id: 'sess-claude-1',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: monolithFile }
      },
      { cwd: tmpDir }
    );
    assert.equal(claudeDeny.exitCode, 0);
    const claudeParsed = JSON.parse(claudeDeny.stdout);
    assert.equal(claudeParsed.permissionDecision, 'deny');
    assert.equal(claudeParsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(claudeParsed.reason.includes('.agents/cache/indices/'));
    assert.ok(fs.existsSync(claudeDeny.verdict.indexPath));
    assert.ok(claudeDeny.verdict.savedTokens > 5_000);

    // Sliced Claude Read passes through
    const claudeSliced = runPreToolUseHook(
      {
        session_id: 'sess-claude-1',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: monolithFile, offset: 1, limit: 120 }
      },
      { cwd: tmpDir }
    );
    assert.equal(claudeSliced.verdict.decision !== 'deny', true);

    // Antigravity modern `read_file` (`Path`) + legacy `view_file` (`AbsolutePath`)
    const agReadFileDeny = await handlePreToolUse({
      conversationId: 'ag-conv-1',
      cwd: tmpDir,
      tool_name: 'read_file',
      tool_input: { Path: monolithFile }
    });
    assert.equal(agReadFileDeny.decision, 'deny');
    assert.equal(agReadFileDeny.blocked, true);
    assert.ok(agReadFileDeny.reason.includes('StartLine and EndLine'));

    const agViewFileDeny = await handlePreToolUse({
      conversationId: 'ag-conv-1',
      cwd: tmpDir,
      tool_name: 'view_file',
      tool_input: { AbsolutePath: monolithFile }
    });
    assert.equal(agViewFileDeny.decision, 'deny');

    // Antigravity sliced `read_file` passes
    const agSlicedAllow = await handlePreToolUse({
      conversationId: 'ag-conv-1',
      cwd: tmpDir,
      tool_name: 'read_file',
      tool_input: { Path: monolithFile, StartLine: 1, EndLine: 120 }
    });
    assert.notEqual(agSlicedAllow.decision, 'deny');

    // Unified ROI reflected in getShieldStatus (via savedQuotaLedger + .hints.jsonl)
    const status = getShieldStatus({ cwd: tmpDir });
    assert.equal(status.enabled, true);
    assert.ok(status.roi.readsBlocked >= 3);
    assert.ok(status.roi.tokensSaved >= 5_000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. losslessPostSanitizer.mjs: >4k-token failure log offload writes structural .index.md map and preserves AssertionError', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-post-idx-'));
  try {
    const bigFailureLog = [
      ...Array.from({ length: 950 }, (_, i) => `[trace] worker step #${i} processing chunk ${'z'.repeat(28)}`),
      'AssertionError [ERR_ASSERTION]: Expected status 200 to equal 500 at test/api.test.mjs:88:12',
      ...Array.from({ length: 60 }, (_, i) => `[cleanup] closing handle #${i}`)
    ].join('\n');

    const res = sanitizePostToolOutput(
      {
        toolName: 'Bash',
        toolOutput: bigFailureLog
      },
      { cwd: tmpDir }
    );

    assert.equal(res.offloaded, true);
    assert.ok(res.artifactPath && fs.existsSync(res.artifactPath));
    assert.ok(res.artifactIndexPath && fs.existsSync(res.artifactIndexPath));
    assert.ok(
      res.updatedToolOutput.includes(
        'AssertionError [ERR_ASSERTION]: Expected status 200 to equal 500 at test/api.test.mjs:88:12'
      )
    );
    assert.ok(res.updatedToolOutput.includes('.index.md'));
    const idxMd = fs.readFileSync(res.artifactIndexPath, 'utf8');
    assert.ok(idxMd.includes('generated_by: "ctxtop-doc-indexer"'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. ctxtop shield --enable / --disable: non-destructively preserves third-party security and custom user hooks without setting disableAllHooks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-hook-merge-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });

    // Seed pre-existing sister/custom hooks in both files
    const agHooksFile = path.join(tmpDir, '.agents', 'hooks.json');
    fs.writeFileSync(
      agHooksFile,
      JSON.stringify(
        {
          'external-guard': {
            PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node "/opt/ext/guard.mjs"' }] }]
          },
          'user-custom-lint': {
            PostToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'node "scripts/lint.mjs"' }] }]
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const claudeSettingsFile = path.join(tmpDir, '.claude', 'settings.json');
    fs.writeFileSync(
      claudeSettingsFile,
      JSON.stringify(
        {
          permissions: { allow: ['Read'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'node "/opt/ext/claude-guard.mjs"' }]
              }
            ]
          }
        },
        null,
        2
      ),
      'utf8'
    );

    // Enable via CLI
    const enableRes = runCli(['shield', '--enable', '--json'], { cwd: tmpDir });
    assert.equal(enableRes.exitCode, 0);
    const enabledData = JSON.parse(enableRes.output);
    assert.equal(enabledData.enabled, true);
    assert.equal(enabledData.selfTest.ok, true);

    const agAfterEnable = JSON.parse(fs.readFileSync(agHooksFile, 'utf8'));
    assert.ok(agAfterEnable['external-guard']);
    assert.ok(agAfterEnable['user-custom-lint']);
    assert.ok(agAfterEnable['ctxtop-read-guard']);
    assert.equal(agAfterEnable['ctxtop-read-guard'].PreToolUse[0].matcher, 'read_file|view_file');

    const claudeAfterEnable = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8'));
    assert.equal(claudeAfterEnable.disableAllHooks, undefined);
    assert.equal(claudeAfterEnable.hooks.PreToolUse.length, 2);
    assert.ok(
      claudeAfterEnable.hooks.PreToolUse.some((e) =>
        JSON.stringify(e).includes('/opt/ext/claude-guard.mjs')
      )
    );

    // Disable via CLI -> removes ctxtop entries while preserving external & user hooks
    const disableRes = runCli(['shield', '--disable', '--json'], { cwd: tmpDir });
    assert.equal(disableRes.exitCode, 0);
    const disabledData = JSON.parse(disableRes.output);
    assert.equal(disabledData.enabled, false);

    const agAfterDisable = JSON.parse(fs.readFileSync(agHooksFile, 'utf8'));
    assert.ok(agAfterDisable['external-guard']);
    assert.ok(agAfterDisable['user-custom-lint']);
    assert.equal(agAfterDisable['ctxtop-read-guard'], undefined);
    assert.equal(agAfterDisable['ctxtop-tail-guard'], undefined);

    const claudeAfterDisable = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8'));
    assert.equal(claudeAfterDisable.disableAllHooks, undefined);
    assert.equal(claudeAfterDisable.hooks.PreToolUse.length, 1);
    assert.ok(
      JSON.stringify(claudeAfterDisable.hooks.PreToolUse[0]).includes('/opt/ext/claude-guard.mjs')
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. ctxtop audit --json: zero-write scoring across Antigravity & Claude Code transcripts with message.id chunk deduplication', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-audit-home-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-audit-cwd-'));
  try {
    const nowMs = Date.parse('2026-11-15T00:00:00Z');
    const t0 = new Date(nowMs - 3_600_000).toISOString();
    const tCold = new Date(nowMs - 3_600_000 + 600_000).toISOString(); // +10m (>5m cold gap)

    // 1. Synthetic Claude Code transcript with duplicate streaming chunks sharing `msg_stream_1`
    const claudeProjDir = path.join(tmpHome, '.claude', 'projects', 'demo-proj');
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const claudeJsonl = path.join(claudeProjDir, 'claude-sess-01.jsonl');
    const hugeReadText = 'line content padding for oversized read\n'.repeat(1400); // >48KB
    const claudeRows = [
      // Streaming chunk 1 of msg_stream_1
      {
        type: 'assistant',
        timestamp: t0,
        message: {
          id: 'msg_stream_1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 2000, output_tokens: 20, cache_read_input_tokens: 25000, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: 'tu_read_1', name: 'Read', input: { file_path: 'src/huge.mjs' } }]
        }
      },
      // Final streaming chunk 2 of msg_stream_1 (must deduplicate, not double-count 25k!)
      {
        type: 'assistant',
        timestamp: t0,
        message: {
          id: 'msg_stream_1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 2000, output_tokens: 140, cache_read_input_tokens: 25000, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: 'tu_read_1', name: 'Read', input: { file_path: 'src/huge.mjs' } }]
        }
      },
      {
        type: 'user',
        timestamp: t0,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_read_1', content: hugeReadText }]
        }
      },
      // >5m idle cold-cache spike + 3 consecutive failed Bash calls
      {
        type: 'assistant',
        timestamp: tCold,
        message: {
          id: 'msg_cold_2',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 500, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 32000 },
          content: [
            { type: 'tool_use', id: 'tu_b1', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 'tu_b2', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 'tu_b3', name: 'Bash', input: { command: 'npm test' } }
          ]
        }
      },
      {
        type: 'user',
        timestamp: tCold,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_b1', is_error: true, content: 'FAIL 1' },
            { type: 'tool_result', tool_use_id: 'tu_b2', is_error: true, content: 'FAIL 2' },
            { type: 'tool_result', tool_use_id: 'tu_b3', is_error: true, content: 'FAIL 3' }
          ]
        }
      }
    ];
    fs.writeFileSync(claudeJsonl, claudeRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // 2. Synthetic Antigravity transcript_full.jsonl
    const agLogsDir = path.join(
      tmpHome,
      '.gemini',
      'antigravity',
      'brain',
      'ag-sess-01',
      '.system_generated',
      'logs'
    );
    fs.mkdirSync(agLogsDir, { recursive: true });
    const agRows = [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: t0,
        content: 'Reading file',
        tool_calls: [{ name: 'read_file', args: { Path: 'src/monolith.html' } }]
      },
      {
        step_index: 2,
        type: 'TOOL_RESPONSE',
        created_at: t0,
        status: 'DONE',
        content: hugeReadText
      }
    ];
    fs.writeFileSync(
      path.join(agLogsDir, 'transcript_full.jsonl'),
      agRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );

    const cliRes = runCli(['audit', '--days', '7', '--json'], {
      cwd: tmpCwd,
      homeDir: tmpHome,
      nowMs
    });
    assert.equal(cliRes.exitCode, 0);
    const parsed = JSON.parse(cliRes.output);
    assert.equal(parsed.sessionsScanned, 2);
    assert.equal(parsed.coldCacheSpikes, 1);
    assert.equal(parsed.thrashLoops, 1);
    assert.equal(parsed.oversizedReads, 2);
    assert.ok(parsed.sludgeTaxTokens > 20_000);
    assert.ok(parsed.sludgeTaxUSD > 0);
    assert.equal(parsed.topOffendingTurns.length, 3);

    // Verify msg_stream_1 was deduplicated (turns = 2 on Claude session, NOT 3)
    const claudeSession = parsed.sessions.find((s) => s.platform === 'claude');
    assert.equal(claudeSession.turns, 2);

    // Verify human-readable report has Quota Shield framing and zero developer grades
    const textReport = formatSessionAuditReport(runSessionAudit({ cwd: tmpCwd, homeDir: tmpHome, nowMs }));
    assert.ok(textReport.includes('Sludge Tax Preventable'));
    assert.ok(!/\bGrade\s*:\s*[A-F]\b/i.test(textReport));

    // Zero workspace mutations in tmpCwd
    assert.deepEqual(fs.readdirSync(tmpCwd), []);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});
