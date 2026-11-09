import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  PrefixCacheShield,
  formatStagedBadge,
  isProtectedPrefixFile
} from '../src/core/prefix_cache_shield.mjs';
import {
  AgBridgeService,
  discoverLanguageServerProcess
} from '../src/core/ag_bridge.mjs';
import {
  WalHygieneManager,
  inspectDatabaseWalHealth,
  runPassiveWalCheckpoint
} from '../src/core/wal_hygiene.mjs';

test('[GATE-0.1] PrefixCacheShield blocks GEMINI.md disk mutation when cachedTokens=80500 and cacheTtlSeconds=296 until TTL=0 or flushOnHandoff()', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-gate0-shield-'));
  try {
    const geminiDir = path.join(tmpHome, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const geminiMdPath = path.join(geminiDir, 'GEMINI.md');
    const initialContent = '# Global Antigravity Rules\n- Follow strict TypeScript/ESM hygiene.\n';
    fs.writeFileSync(geminiMdPath, initialContent, 'utf8');
    const initialStat = fs.statSync(geminiMdPath);

    const shield = new PrefixCacheShield({ homeDir: tmpHome });
    assert.equal(isProtectedPrefixFile(geminiMdPath), true);

    // 1. Attempt mutation while warm cache is active (cachedTokens = 80500, cacheTtlSeconds = 296)
    const warmSession = { cachedTokens: 80500, cacheTtlSeconds: 296, turnCount: 5 };
    const stageRes = shield.stageOrApplyDelta(
      {
        targetPath: geminiMdPath,
        operation: 'ADD',
        ruleText: '- NEVER delete expect() assertions in test suites.',
        source: 'rsi'
      },
      warmSession
    );

    assert.equal(stageRes.staged, true, 'Rule delta must be staged when cache is warm');
    assert.equal(stageRes.flushed, false, 'Rule delta must NOT flush while TTL=296');
    assert.equal(stageRes.locked, true);
    assert.equal(stageRes.stagedCount, 1);
    assert.equal(
      stageRes.badge,
      '⏳ 1 Rule Update Staged (Waiting for Cache TTL expiry to prevent Prefix Bust)'
    );

    // Verify GEMINI.md on disk was NOT touched
    const afterStageContent = fs.readFileSync(geminiMdPath, 'utf8');
    const afterStageStat = fs.statSync(geminiMdPath);
    assert.equal(afterStageContent, initialContent, 'GEMINI.md on disk must remain byte-for-byte identical while cache is warm');
    assert.equal(afterStageStat.mtimeMs, initialStat.mtimeMs, 'GEMINI.md mtime must not change while staged');
    assert.equal(fs.existsSync(shield.queuePath), true, 'pending_rule_deltas.json must exist on disk');

    // 2. Verify flushIfEligible while TTL is still > 0 (e.g. 120s) does NOT touch GEMINI.md
    const midCheck = shield.flushIfEligible({ cachedTokens: 80500, cacheTtlSeconds: 120, turnCount: 6 });
    assert.equal(midCheck.flushed, false);
    assert.equal(fs.readFileSync(geminiMdPath, 'utf8'), initialContent);

    // 3. Verify flush when TTL reaches 0 (cacheTtlSeconds = 0)
    const ttlExpiredFlush = shield.flushIfEligible({ cachedTokens: 80500, cacheTtlSeconds: 0, turnCount: 6 });
    assert.equal(ttlExpiredFlush.flushed, true, 'Must flush immediately when cacheTtlSeconds === 0');
    assert.equal(ttlExpiredFlush.flushedCount, 1);
    assert.equal(ttlExpiredFlush.stagedCount, 0);

    const updatedContent = fs.readFileSync(geminiMdPath, 'utf8');
    assert.ok(
      updatedContent.includes('- NEVER delete expect() assertions in test suites.'),
      'GEMINI.md must contain the staged rule after TTL reaches 0'
    );

    // 4. Stage a second rule under warm cache and verify explicit flushOnHandoff()
    const stageRes2 = shield.stageOrApplyDelta(
      {
        targetPath: geminiMdPath,
        operation: 'ADD',
        ruleText: '- ALWAYS use SQLITE_OPEN_READONLY on session databases.',
        source: 'u-curve'
      },
      warmSession
    );
    assert.equal(stageRes2.staged, true);
    assert.ok(!fs.readFileSync(geminiMdPath, 'utf8').includes('SQLITE_OPEN_READONLY'));

    const handoffFlush = shield.flushOnHandoff();
    assert.equal(handoffFlush.flushed, true);
    assert.equal(handoffFlush.flushedCount, 1);
    assert.ok(
      fs.readFileSync(geminiMdPath, 'utf8').includes('- ALWAYS use SQLITE_OPEN_READONLY on session databases.'),
      'flushOnHandoff() must immediately flush queued rules to disk'
    );
    assert.equal(formatStagedBadge(0), '');
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('[GATE-0.2] AgBridgeService dispatches via RPC or CDP OOPIF and falls back to clipboard ONLY when both are unreachable', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-gate0-bridge-'));
  try {
    // 1. Verify language_server discovery
    const discovered = discoverLanguageServerProcess([
      {
        pid: 41200,
        name: 'language_server_windows_x64.exe',
        commandLine: 'language_server_windows_x64.exe --https_port=59123 --csrf_token=ag_secret_token_99'
      }
    ]);
    assert.equal(discovered.discovered, true);
    assert.equal(discovered.pid, 41200);
    assert.equal(discovered.port, 59123);
    assert.equal(discovered.csrfToken, 'ag_secret_token_99');

    // 2. RPC reachable -> uses RPC, no clipboard fallback
    const bridge = new AgBridgeService({
      homeDir: tmpHome,
      rpcTransport: {
        sendChatCommand: async (sid, payload) => ({ ok: true, echoed: payload.prompt }),
        pauseActiveGeneration: async (sid, opts) => ({ ok: true, paused: sid, reason: opts.reason }),
        spawnCleanSession: async (sid) => ({ ok: true, spawned: sid })
      }
    });

    const rpcDispatch = await bridge.sendChatCommand('sess-1', 'Run unit tests');
    assert.equal(rpcDispatch.transportUsed, 'rpc');
    assert.equal(rpcDispatch.fallbackUsed, false);
    assert.equal(bridge.lastClipboardText, '', 'Clipboard must NOT be touched when RPC succeeds');

    const rpcPause = await bridge.pauseActiveGeneration('sess-1', { reason: 'DET-03' });
    assert.equal(rpcPause.transportUsed, 'rpc');
    assert.equal(rpcPause.fallbackUsed, false);

    // 3. RPC unreachable, CDP reachable -> uses CDP OOPIF, no clipboard fallback
    bridge.setTransports({
      rpcTransport: {
        sendChatCommand: async () => { throw new Error('ECONNREFUSED'); }
      },
      cdpTransport: {
        sendChatCommand: async (sid, payload) => ({ ok: true, oopifTarget: 'cascade-iframe', text: payload.prompt })
      }
    });

    const cdpDispatch = await bridge.sendChatCommand('sess-1', 'Inspect AST');
    assert.equal(cdpDispatch.transportUsed, 'cdp');
    assert.equal(cdpDispatch.fallbackUsed, false);
    assert.equal(bridge.lastClipboardText, '', 'Clipboard must NOT be touched when CDP succeeds');

    // 4. Both RPC and CDP unreachable -> falls back to clipboard
    bridge.setTransports({
      rpcTransport: null,
      cdpTransport: null
    });
    const fallbackDispatch = await bridge.sendChatCommand('sess-1', '/handoff');
    assert.equal(fallbackDispatch.transportUsed, 'clipboard');
    assert.equal(fallbackDispatch.fallbackUsed, true);
    assert.equal(bridge.lastClipboardText, '/handoff');

    // 5. spawnCleanSession creates <NEW_GUID> brain artifacts on disk
    const spawned = await bridge.spawnCleanSession({
      sessionId: '11111111-2222-4333-8444-555555555555',
      taskMd: '# Task\n- [x] Phase 0\n- [/] Phase 1\n',
      implementationPlanMd: '# Plan\nDeterministic guardrails.\n'
    });
    assert.equal(spawned.ok, true);
    assert.equal(fs.existsSync(spawned.taskMdPath), true);
    assert.equal(fs.existsSync(spawned.planMdPath), true);
    assert.ok(fs.readFileSync(spawned.taskMdPath, 'utf8').includes('- [/] Phase 1'));
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('[GATE-0.3] WalHygieneManager checkpoints Horizon SQLite DBs and guards host DB read-only invariant', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-gate0-wal-'));
  try {
    const horizonDir = path.join(tmpHome, '.gemini', 'antigravity', 'agy-horizon');
    const convDir = path.join(tmpHome, '.gemini', 'antigravity', 'conversations');
    fs.mkdirSync(horizonDir, { recursive: true });
    fs.mkdirSync(convDir, { recursive: true });

    // 1. Create a writable Horizon DB in WAL mode
    const ftsDbPath = path.join(horizonDir, 'tool_logs_fts5.db');
    const ftsDb = new DatabaseSync(ftsDbPath);
    ftsDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT); INSERT INTO items VALUES (1, 'ok');");
    ftsDb.close();

    const cpRes = await runPassiveWalCheckpoint(ftsDbPath, { DatabaseSync });
    assert.equal(cpRes.success, true);
    assert.equal(cpRes.skipped, false, 'Horizon-managed DB must execute PRAGMA wal_checkpoint(PASSIVE)');

    // 2. Create a simulated host conversation DB and verify read-only guard
    const hostDbPath = path.join(convDir, 'abcd1234.db');
    const hostDb = new DatabaseSync(hostDbPath);
    hostDb.exec('CREATE TABLE gen_metadata (input_tokens INTEGER); INSERT INTO gen_metadata VALUES (5000);');
    hostDb.close();

    // Simulate a 31 MB .db-wal file next to hostDbPath
    const walPath = `${hostDbPath}-wal`;
    fs.writeFileSync(walPath, Buffer.alloc(1024));

    const hostSkipRes = await runPassiveWalCheckpoint(hostDbPath, { DatabaseSync });
    assert.equal(hostSkipRes.skipped, true);
    assert.equal(hostSkipRes.reason, 'HOST_DB_READONLY_GUARD', 'Host conversation DB must never be opened in write mode by default');

    const healthAlert = await inspectDatabaseWalHealth(hostDbPath, {
      DatabaseSync,
      maxWalBytes: 512 // trigger bloat warning with 1024-byte WAL
    });
    assert.equal(healthAlert.bloatWarning, true);
    assert.equal(healthAlert.readOnlyEnforced, true);

    // 3. Verify WalHygieneManager idle sweep
    const mgr = new WalHygieneManager({ homeDir: tmpHome, intervalMs: 5000, DatabaseSync });
    const sweep = await mgr.runIdleSweep();
    assert.ok(sweep.checkpointCount >= 1);
    mgr.stop();
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});
