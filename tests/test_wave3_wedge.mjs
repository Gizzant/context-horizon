import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  computeMcpTokenRoiMatrix,
  auditInstructionStaticRot
} from '../src/core/baseline.mjs';
import { buildSubagentWorktreeDag } from '../src/core/subagents.mjs';
import {
  upsertEpisodicMemory,
  queryEpisodicMemoryBm25,
  synthesizeResumeHerePack
} from '../src/core/episodic_memory.mjs';
import { buildGitCommitTokenLedger } from '../src/core/git_ledger.mjs';
import {
  sanitizeForensicPayload,
  exportSanitizedSnapshot
} from '../src/core/sanitizer.mjs';

describe('Wave 3 — Wedge F6 (MCP Token ROI Matrix & Instruction Static Rot Auditor)', () => {
  test('F6: computeMcpTokenRoiMatrix flags IDLE_BLOAT_TAX on 0-call eager servers and tracks dynamic delta tokens', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f6-home-'));
    const cfgDir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        notebooklm: { loadingMode: 'eager', schemaTokens: 10800 },
        github: { loadingMode: 'lazy', schemaTokens: 2400 }
      }
    }), 'utf8');

    const steps = [
      { stepIndex: 0, mcp_instructions_delta: 'x'.repeat(1600), deferred_tools_delta: 'y'.repeat(800) }
    ];

    const roi = computeMcpTokenRoiMatrix({ homeDir: tmpHome, steps });
    assert.ok(roi.dynamicDeltaTokens >= 600);
    assert.equal(roi.idleBloatServers.length, 1);
    assert.equal(roi.idleBloatServers[0].name, 'notebooklm');
    assert.equal(roi.idleBloatServers[0].status, 'IDLE_BLOAT_TAX');
  });

  test('F6: auditInstructionStaticRot detects broken @path references in AGENTS.md / CLAUDE.md', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f6-ws-'));
    fs.writeFileSync(path.join(tmpWs, 'AGENTS.md'), '# Rules\nSee @src/existing.mjs and @src/missing_ghost_file.mjs for details.\n', 'utf8');
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, 'src', 'existing.mjs'), 'export const x = 1;', 'utf8');

    const rot = auditInstructionStaticRot(tmpWs);
    assert.equal(rot.hasStaticRot, true);
    assert.equal(rot.brokenReferences.length, 1);
    assert.equal(rot.brokenReferences[0].reference, '@src/missing_ghost_file.mjs');
  });
});

describe('Wave 3 — Wedge F7 (Subagent Worktree & Subtrajectory DAG + File Collision Detector)', () => {
  test('F7: buildSubagentWorktreeDag tracks 5m child TTLs and detects concurrent file edit collisions across >=2 subagents', () => {
    const nowMs = Date.parse('2026-11-08T17:00:00Z');
    const parentSteps = [
      { stepIndex: 0, toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Worker A', Workspace: 'share' } }] },
      { stepIndex: 1, toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Worker B', Workspace: 'share' } }] }
    ];
    const childTranscripts = [
      {
        agentId: 'sub-A',
        workspaceMode: 'share',
        steps: [
          { createdAt: '2026-11-08T16:58:00Z', outputTokens: 4200, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }] }
        ]
      },
      {
        agentId: 'sub-B',
        workspaceMode: 'share',
        steps: [
          { createdAt: '2026-11-08T16:59:00Z', outputTokens: 3800, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }] }
        ]
      }
    ];

    const dag = buildSubagentWorktreeDag(parentSteps, { childTranscripts, nowMs });
    assert.equal(dag.parentInvocationCount, 2);
    assert.equal(dag.nodes.length, 2);
    assert.equal(dag.nodes[0].ttlRemainingSec, 180);
    assert.equal(dag.hasFileCollision, true);
    assert.equal(dag.fileCollisions.length, 1);
    assert.equal(dag.fileCollisions[0].filePath, 'src/core/quota.mjs');
    assert.deepEqual(dag.fileCollisions[0].agents, ['sub-A', 'sub-B']);
  });
});

describe('Wave 3 — Wedge F10 (SQLite FTS5 Episodic Memory) & F11 (Git Commit Token Ledger)', () => {
  test('F10: upsertEpisodicMemory, queryEpisodicMemoryBm25, and synthesizeResumeHerePack generate <1,000 token [▶ RESUME HERE] pack', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f10-fts-'));
    const dbPath = path.join(tmpDir, 'episodic_memory.db');

    await upsertEpisodicMemory(dbPath, {
      sessionId: 'sess-alpha-1',
      workspacePath: 'c:/Projects/ga-visualizer-v2',
      title: 'Dual-TTL Cache Guardian Implementation',
      summary: 'Implemented 1h vs 5m TTL cliff detection and prefix mutation byte diffs.',
      decisions: ['Use rolling SHA-256 block hashes', 'Open SQLite strictly read-only'],
      modifiedFiles: ['src/core/quota.mjs', 'src/webview/horizon_panel.html']
    });

    const q = await queryEpisodicMemoryBm25(dbPath, {
      query: 'TTL cliff prefix',
      workspacePath: 'c:/Projects/ga-visualizer-v2'
    });
    assert.equal(q.hits.length, 1);
    assert.equal(q.hits[0].sessionId, 'sess-alpha-1');

    const pack = await synthesizeResumeHerePack(dbPath, {
      workspacePath: 'c:/Projects/ga-visualizer-v2',
      query: 'TTL cliff'
    });
    assert.equal(pack.header, '[▶ RESUME HERE]');
    assert.equal(pack.withinTokenBudget, true);
    assert.ok(pack.markdown.includes('[▶ RESUME HERE]'));
    assert.ok(pack.markdown.includes('Dual-TTL Cache Guardian Implementation'));
  });

  test('F11: buildGitCommitTokenLedger attributes session tokens, cache hit %, and USD cost across .git/logs/HEAD commits', () => {
    const headLogContent = [
      '0000000000000000000000000000000000000000 a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4 Dev <dev@example.com> 1762630000 -0500\tcommit (initial): feat: init wave 1',
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4 b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5 Dev <dev@example.com> 1762630600 -0500\tcommit: feat: add wave 2 surgeon'
    ].join('\n');

    const steps = [
      { stepIndex: 0, inputTokens: 10000, cacheReadTokens: 90000, thinkingTokens: 4000, outputTokens: 2000, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }] }
    ];

    const ledger = buildGitCommitTokenLedger('', steps, { headLogContent });
    assert.equal(ledger.commits.length, 2);
    assert.equal(ledger.cacheHitPct, 90);
    assert.ok(ledger.estimatedCostUsd > 0);
    assert.equal(ledger.files.length, 1);
    assert.ok(ledger.prMarkdownSummary.includes('Context Horizon PR Token Ledger'));

    // Verify timestamp-window interval attribution: step1 before commit 1, step2 between commit 1 and commit 2
    const timedSteps = [
      { stepIndex: 0, createdAt: 1762629900 * 1000, inputTokens: 2000, cacheReadTokens: 8000, thinkingTokens: 1000, outputTokens: 1000 },
      { stepIndex: 1, createdAt: 1762630300 * 1000, inputTokens: 6000, cacheReadTokens: 24000, thinkingTokens: 3000, outputTokens: 3000 }
    ];
    const timedLedger = buildGitCommitTokenLedger('', timedSteps, { headLogContent });
    assert.equal(timedLedger.commits.length, 2);
    assert.equal(timedLedger.commits[0].attributedTokens, 12000, 'Commit 1 must only attribute tokens from interval <= 1762630000');
    assert.equal(timedLedger.commits[1].attributedTokens, 36000, 'Commit 2 must attribute tokens from interval (1762630000, 1762630600]');
  });
});

describe('Wave 3 — Wedge F12 & Law 5 (Zero-PII Sanitizer & Forensic Snapshot Exporter)', () => {
  test('F12: sanitizeForensicPayload & exportSanitizedSnapshot scrub API keys, GitHub PATs, Bearer tokens, .env secrets, and OS home paths', () => {
    const dirtyState = {
      sessionId: 'sess-sec-99',
      workspacePath: 'C:\\Users\\alice\\Projects\\secret-app',
      notes: 'Used sk-ant-api03-1234567890abcdef and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and DATABASE_PASSWORD="superSecretPassword123"'
    };

    const { sanitized, redactedSecretCount, redactedPathCount } = sanitizeForensicPayload(dirtyState, {
      homeDir: 'C:\\Users\\alice'
    });

    assert.ok(redactedSecretCount >= 4, `Expected >=4 secrets scrubbed, got ${redactedSecretCount}`);
    assert.ok(redactedPathCount >= 1, `Expected >=1 home path scrubbed, got ${redactedPathCount}`);
    assert.ok(!JSON.stringify(sanitized).includes('sk-ant-'));
    assert.ok(!JSON.stringify(sanitized).includes('ghp_'));
    assert.ok(!JSON.stringify(sanitized).includes('superSecretPassword123'));
    assert.ok(!JSON.stringify(sanitized).includes('C:\\Users\\alice'));
    assert.equal(sanitized.workspacePath, '~\\Projects\\secret-app');

    const tmpOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f12-out-')), 'snapshot.json');
    const exp = exportSanitizedSnapshot(dirtyState, { format: 'json', homeDir: 'C:\\Users\\alice', outputPath: tmpOut });
    assert.equal(exp.success, true);
    assert.equal(exp.payload.zeroPiiVerified, true);
    assert.ok(fs.existsSync(tmpOut));
  });
});
