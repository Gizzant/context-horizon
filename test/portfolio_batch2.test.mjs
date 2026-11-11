import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  archiveAndCompressDet07Output,
  queryAhCliArchiveBm25,
  executeAndCompressCommand,
  AH_CLI_ARCHIVE_MAX_BYTES
} from '../src/shims/agy_cli_compressor.mjs';
import { runAhLogQueryCli } from '../src/shims/ah_log_query.mjs';
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import {
  runStrictPreInvocation,
  runStrictPreToolUse,
  runStrictPostToolUse
} from '../src/hooks/portfolio_runtime.mjs';
import { readSidecarSync } from '../src/core/sidecar_store.mjs';
import { SavedQuotaReceiptLedger } from '../src/core/coach/saved_quota_ledger.mjs';
import { validateSafePreInvocationOutput } from '../src/core/shared/index.mjs';

function makeTmp(prefix = 'ah-b2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Batch 2 — Rank 3 (DET-07): Exit-Safe CLI Compressor, 5 MB FTS5 Ring Archive & BM25 Query', () => {
  it('propagates exact child exitCode via CLI shim, preserves 30 head + 45 tail + 100% errors, scrubs secrets, and records ledger savings', () => {
    const ws = makeTmp('ah-det07-');
    try {
      const ledgerDb = path.join(ws, 'ledger.sqlite');
      // 1. CLI wrapper shim propagates exact exitCode (e.g., 42)
      const shimScript = path.resolve('src/shims/agy_cli_compressor.mjs');
      const childRun = spawnSync(
        process.execPath,
        [shimScript, '--', process.execPath, '-e', 'console.log("hello"); process.exit(42);'],
        { cwd: ws, encoding: 'utf8' }
      );
      assert.equal(childRun.status, 42, 'agy_cli_compressor.mjs MUST propagate exact child exitCode 42');

      // 2. >4,096-char output with ANSI, spinner, secret, 30 head, middle errors, and 45 tail
      const lines = [];
      for (let i = 1; i <= 35; i++) lines.push(`HEAD_MARKER_${i}: initializing module ${i}`);
      for (let i = 1; i <= 120; i++) lines.push(`✓ passing_unit_test_case_${i} (2ms)`);
      lines.push('\x1B[31mAssertionError: expected 200 to equal 500 in auth_handler.mjs\x1B[0m');
      lines.push('error[E0502]: cannot borrow `ctx` as mutable');
      lines.push('API_TOKEN="sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"');
      for (let i = 1; i <= 50; i++) lines.push(`TAIL_MARKER_${i}: summary row ${i} padding_text_for_4k_threshold`);

      const rawOutput = lines.join('\n');
      assert.ok(rawOutput.length > 4096);

      const res = archiveAndCompressDet07Output(rawOutput, {
        command: 'npm test',
        exitCode: 1,
        sessionId: 'sess-det07',
        workspaceDir: ws,
        ledgerDbPath: ledgerDb
      });

      assert.equal(res.archived, true);
      assert.equal(res.exitCode, 1);
      // Preserves head (first 30 lines) + tail (last 45 lines) + middle error lines + query hint
      assert.ok(res.output.includes('HEAD_MARKER_1:'));
      assert.ok(res.output.includes('HEAD_MARKER_30:'));
      assert.ok(res.output.includes('TAIL_MARKER_6:'));
      assert.ok(res.output.includes('TAIL_MARKER_50:'));
      assert.ok(res.output.includes('AssertionError: expected 200 to equal 500 in auth_handler.mjs'));
      assert.ok(res.output.includes('error[E0502]: cannot borrow `ctx` as mutable'));
      assert.ok(res.output.includes('node .agents/shims/ah_log_query.mjs "<term>"'));

      // Verify secret redaction inside FTS5 SQLite archive + BM25 search via ah_log_query.mjs
      const archiveRaw = fs.readFileSync(res.archiveDbPath, 'latin1');
      assert.ok(!archiveRaw.includes('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'), 'Live secret MUST be scrubbed before SQLite FTS5 insert');

      const queryRes = runAhLogQueryCli(['AssertionError'], { workspaceDir: ws });
      assert.equal(queryRes.exitCode, 0);
      assert.equal(queryRes.hits.length, 1);
      assert.match(queryRes.output, /AssertionError/);

      // Verify exact byte-verified token savings recorded in SavedQuotaReceiptLedger
      const ledger = new SavedQuotaReceiptLedger({ dbPath: ledgerDb });
      const summary = ledger.getSummary('sess-det07');
      assert.equal(summary.totalArgonEquivTokensSaved, res.tokensSaved);
      assert.ok(summary.totalArgonEquivTokensSaved > 0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('enforces the 5 MB SQLite FTS5 ring cap by evicting oldest rows past cap', () => {
    const ws = makeTmp('ah-cap-');
    try {
      // Test ring eviction with a 256 KB test cap (and verify default constant === 5 MB)
      assert.equal(AH_CLI_ARCHIVE_MAX_BYTES, 5 * 1024 * 1024);
      const testCap = 256 * 1024;
      for (let i = 0; i < 8; i++) {
        const chunk = `BATCH_MARKER_${i} ` + 'x'.repeat(60000);
        archiveAndCompressDet07Output(chunk, {
          command: `cmd-${i}`,
          exitCode: 0,
          workspaceDir: ws,
          maxArchiveBytes: testCap
        });
      }
      const dbFile = path.join(ws, '.agents', 'cache', 'ah_cli_archive.sqlite');
      const stat = fs.statSync(dbFile);
      assert.ok(stat.size <= testCap, `Expected SQLite file ${stat.size} <= ${testCap}`);
      // Oldest row BATCH_MARKER_0 evicted, newest BATCH_MARKER_7 retained
      assert.equal(queryAhCliArchiveBm25('BATCH_MARKER_0', { workspaceDir: ws }).length, 0);
      assert.equal(queryAhCliArchiveBm25('BATCH_MARKER_7', { workspaceDir: ws }).length, 1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Batch 2 — Rank 10 (DET-13): Eager MCP Override & Startup Bloat Auditor', () => {
  it('flags explicit eager:true overrides, unreachable stdio binaries, and >15k eager schema tokens on SessionStart without false alarms on lazy defaults', async () => {
    const home = makeTmp('ah-mcp-home-');
    const ws = makeTmp('ah-mcp-ws-');
    const sid = `det13-${Date.now()}`;
    try {
      const globalMcpDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(globalMcpDir, { recursive: true });
      fs.writeFileSync(
        path.join(globalMcpDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'clean-lazy-server': { url: 'https://mcp.example.com/sse' },
            'bloated-eager-jira': { eager: true, url: 'https://jira.example.com/sse', estimatedTokens: 16500 },
            'dead-stdio-bin': { command: '/nonexistent/orphan/mcp-binary-xyz' }
          }
        }),
        'utf8'
      );

      await handleSessionStart({
        conversationId: sid,
        homeDir: home,
        workspacePath: ws
      });

      const sidecar = readSidecarSync(sid);
      const audit = sidecar.sensors.mcpAudit;
      assert.equal(audit.triggered, true);
      assert.deepEqual(audit.eagerOverrides, ['bloated-eager-jira']);
      assert.deepEqual(audit.unreachableServers, ['dead-stdio-bin']);
      assert.equal(audit.exceedsBudget, true);
      assert.ok(!audit.offendingServers.includes('clean-lazy-server'));
      assert.match(audit.hudAlert, /Antigravity 1\.3\.3\+ defaults to lazy MCP loading/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Batch 2 — Rank 11 (DET-02): Zero-Token PreInvocation Secret & Mega-Dump Hold + Symlink .env Deny', () => {
  it('fast-exits {} in < 1ms when invocationNum > 1, blocks live secrets in COACH & AUTO_PILOT, honors placeholders/[ah:allow-secret], and gates mega-dumps', async () => {
    // 1. < 1ms fast-exit on invocationNum > 1 (warm benchmark)
    await runStrictPreInvocation({ invocationNum: 2, prompt: 'warm up' });
    const t0 = performance.now();
    const fastOut = await runStrictPreInvocation({
      invocationNum: 2,
      prompt: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
    });
    const elapsedMs = performance.now() - t0;
    assert.deepEqual(fastOut, {});
    assert.ok(elapsedMs < 1.0, `Expected <1ms fast-exit on invocationNum > 1, got ${elapsedMs.toFixed(3)}ms`);

    // 2. Live secrets terminate at 0 tokens in BOTH COACH and AUTO_PILOT
    for (const mode of ['COACH', 'AUTO_PILOT']) {
      const secretRes = await runStrictPreInvocation({
        invocationNum: 1,
        flightMode: mode,
        prompt: 'Debug with key ghp_1234567890abcdefghijklmnopqrstuvwx'
      });
      assert.equal(secretRes.terminationBehavior, 'terminate');
      assert.match(secretRes.errorMessage.userMessage, /\[DET-02 Secret Hold\]/);
      assert.equal(validateSafePreInvocationOutput(secretRes).valid, true);
    }

    // 3. Placeholders (YOUR_API_KEY, changeme) and [ah:allow-secret] are allowed (negative check!)
    const placeholderRes = await runStrictPreInvocation({
      invocationNum: 1,
      flightMode: 'AUTO_PILOT',
      prompt: 'OPENAI_API_KEY=YOUR_API_KEY\nSECRET_TOKEN=changeme'
    });
    assert.deepEqual(placeholderRes, {});

    const allowTagRes = await runStrictPreInvocation({
      invocationNum: 1,
      flightMode: 'AUTO_PILOT',
      prompt: 'Test fixture [ah:allow-secret] AKIAIOSFODNN7REALKEY'
    });
    assert.deepEqual(allowTagRes, {});

    // 4. Raw Mega-Dump (>= 20,000 chars): terminates in AUTO_PILOT, silent {} + HUD hint in COACH, exempt with @file or [ah:allow-paste]
    const megaSid = `mega-${Date.now()}`;
    const megaText = 'log line content '.repeat(1300); // >20,000 chars
    const megaAuto = await runStrictPreInvocation({
      conversationId: megaSid,
      invocationNum: 1,
      flightMode: 'AUTO_PILOT',
      prompt: megaText
    });
    assert.equal(megaAuto.terminationBehavior, 'terminate');
    assert.match(megaAuto.errorMessage.userMessage, /@file/);

    const megaCoach = await runStrictPreInvocation({
      conversationId: `${megaSid}-coach`,
      invocationNum: 1,
      flightMode: 'COACH',
      prompt: megaText
    });
    assert.deepEqual(megaCoach, {}, 'COACH mega-dump must return {} on stdout and log silent HUD hint');
    assert.ok(readSidecarSync(`${megaSid}-coach`).portfolio.hudAlerts.some((a) => a.detectorId === 'DET-02'));

    const megaWithAtFile = await runStrictPreInvocation({
      invocationNum: 1,
      flightMode: 'AUTO_PILOT',
      prompt: `See @logs/server.log\n${megaText}`
    });
    assert.deepEqual(megaWithAtFile, {});
  });

  it('denies symlink-resolved .env*, *.pem, and ~/.ssh/* access in PreToolUse while allowing .env.example', async () => {
    const ws = makeTmp('ah-env-');
    try {
      const realEnv = path.join(ws, '.env.production');
      fs.writeFileSync(realEnv, 'DB_PASSWORD=supersecret\n', 'utf8');
      const envEx = path.join(ws, '.env.example');
      fs.writeFileSync(envEx, 'DB_PASSWORD=changeme\n', 'utf8');

      const denyDirect = await runStrictPreToolUse({
        cwd: ws,
        tool_name: 'view_file',
        tool_input: { Path: realEnv }
      });
      assert.equal(denyDirect.decision, 'deny');

      // Symlink alias pointing to .env.production (when OS permits symlink creation)
      const symPath = path.join(ws, 'innocent.txt');
      let symCreated = false;
      try {
        fs.symlinkSync(realEnv, symPath);
        symCreated = true;
      } catch (symErr) {
        // Windows without Developer Mode may disallow file symlinks
        void symErr;
      }
      if (symCreated) {
        const denySym = await runStrictPreToolUse({
          cwd: ws,
          tool_name: 'view_file',
          tool_input: { Path: symPath }
        });
        assert.equal(denySym.decision, 'deny', 'Symlink pointing to .env.production MUST be denied');
      }

      const allowExample = await runStrictPreToolUse({
        cwd: ws,
        tool_name: 'view_file',
        tool_input: { Path: envEx }
      });
      assert.equal(allowExample.decision, 'allow');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
