/**
 * @file test/node20_antigravity_compat.test.mjs
 * Verifies Antigravity Node.js >= 20.0.0 LTS compatibility and graceful degradation
 * when built-in `node:sqlite` is absent (`CTXTOP_FORCE_NO_SQLITE=1`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isSupportedNodeVersion,
  hasNativeNodeSqlite,
  ensureSupportedNodeVersion
} from '../src/core/paths.mjs';
import {
  isNodeSqliteAvailable,
  getDatabaseSyncClass
} from '../src/engine-node/db/probe.mjs';
import {
  openLocalHorizonDb,
  JsonlFallbackDatabaseSync
} from '../src/core/sqlite_client.mjs';
import { reconcileWorkspaceAndKIs } from '../src/core/parser.mjs';
import {
  upsertEpisodicMemory,
  queryEpisodicMemoryBm25,
  synthesizeResumeHerePack
} from '../src/core/episodic_memory.mjs';
import {
  compressCliOutputFts5,
  searchToolLogsFts5,
  getFts5CompressionStats
} from '../src/core/fts5_output_compressor.mjs';
import {
  inspectDatabaseWalHealth,
  runPassiveWalCheckpoint
} from '../src/core/wal_hygiene.mjs';
import { auditCursorVscdbOrphans } from '../src/core/storage_doctor.mjs';
import { RsiInstinctEngine } from '../src/core/rsi_instinct_engine.mjs';
import { runDoctor } from '../src/cli/doctor.mjs';

test('Node 20 LTS compat: paths.mjs accepts Node >= 20.0.0 and rejects Node < 20', () => {
  assert.equal(isSupportedNodeVersion('v18.19.1'), false);
  assert.equal(isSupportedNodeVersion('v20.0.0'), true);
  assert.equal(isSupportedNodeVersion('v20.11.0'), true);
  assert.equal(isSupportedNodeVersion('v22.4.0'), true);
  assert.equal(isSupportedNodeVersion('v22.5.0'), true);

  assert.equal(hasNativeNodeSqlite('v20.11.0'), false);
  assert.equal(hasNativeNodeSqlite('v22.4.9'), false);
  assert.equal(ensureSupportedNodeVersion({ exitOnUnsupported: false, versionStr: 'v20.11.0' }).supported, true);
});

test('Node 20 LTS compat: CTXTOP_FORCE_NO_SQLITE=1 degrades gracefully across parser, episodic memory, FTS5 compressor, RSI, WAL hygiene, storage doctor, and doctor CLI', async () => {
  const prevEnv = process.env.CTXTOP_FORCE_NO_SQLITE;
  process.env.CTXTOP_FORCE_NO_SQLITE = '1';
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-node20-compat-'));

  try {
    assert.equal(isNodeSqliteAvailable(), false);
    assert.equal(getDatabaseSyncClass(), null);
    assert.equal(hasNativeNodeSqlite('v24.0.0'), false);

    // 1. Zero-Trust SQLite Read-Only Guard still blocks read-write opens on host DBs even without node:sqlite
    assert.throws(
      () => openLocalHorizonDb(path.join(tmpHome, '.gemini', 'antigravity', 'conversations', 'abc.db'), { readOnly: false }),
      /\[Zero-Trust SQLite Guard\] Refusing read-write open on protected host database/
    );

    // 2. Session discovery falls back cleanly to brain/<sid>/.system_generated/logs/transcript_full.jsonl
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const logsDir = path.join(
      tmpHome,
      '.gemini',
      'antigravity',
      'brain',
      sessionId,
      '.system_generated',
      'logs'
    );
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Hello on Node 20' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Ready on Node 20' })
      ].join('\n') + '\n',
      'utf8'
    );

    const discovered = await reconcileWorkspaceAndKIs(sessionId, tmpHome);
    assert.ok(Array.isArray(discovered.recentSessions));
    assert.equal(discovered.recentSessions.some((s) => s.sessionId === sessionId), true);

    // 3. Episodic memory works end-to-end via JsonlFallbackDatabaseSync
    const episodicDbPath = path.join(tmpHome, '.gemini', 'flightcheck', 'episodic_memory.db');
    const upRes = await upsertEpisodicMemory(episodicDbPath, {
      sessionId,
      workspacePath: tmpHome,
      title: 'Node 20 Fallback Session',
      summary: 'Verified JSONL fallback on Node 20 LTS',
      decisions: ['Use JsonlFallbackDatabaseSync when node:sqlite is absent'],
      modifiedFiles: ['src/core/sqlite_client.mjs']
    });
    assert.equal(upRes.success, true);

    const queryRes = await queryEpisodicMemoryBm25(episodicDbPath, {
      query: 'JsonlFallbackDatabaseSync',
      workspacePath: tmpHome
    });
    assert.equal(queryRes.hits.length, 1);
    assert.equal(queryRes.hits[0].title, 'Node 20 Fallback Session');

    const resumePack = await synthesizeResumeHerePack(episodicDbPath, {
      workspacePath: tmpHome,
      query: 'JsonlFallbackDatabaseSync'
    });
    assert.equal(resumePack.hitCount, 1);
    assert.equal(resumePack.withinTokenBudget, true);

    // 4. FTS5 CLI Output Compressor works end-to-end via fallback
    const noisyLines = Array.from({ length: 90 }, (_, i) =>
      i === 42 ? 'FAIL test/sample.test.mjs:42:10 AssertionError: expected 1 to equal 2' : `ok ${i} - passing test`
    ).join('\n');
    const ftsDbPath = path.join(tmpHome, '.gemini', 'antigravity', 'agy-horizon', 'tool_logs_fts5.db');
    const compRes = await compressCliOutputFts5({
      rawOutput: noisyLines,
      command: 'node --test',
      exitCode: 1,
      sessionId,
      turnId: 'turn-node20',
      dbPath: ftsDbPath,
      homeDir: tmpHome
    });
    assert.equal(compRes.compressed, true);
    const searchRes = await searchToolLogsFts5(ftsDbPath, {
      turnId: 'turn-node20',
      keyword: 'AssertionError'
    });
    assert.equal(searchRes.hits.length, 1);
    const ftsStats = getFts5CompressionStats(ftsDbPath, { homeDir: tmpHome });
    assert.equal(ftsStats.logCount, 1);

    // 5. WAL Hygiene & Storage Doctor degrade cleanly without throwing
    const walHealth = await inspectDatabaseWalHealth(episodicDbPath);
    assert.equal(walHealth.exists, true);
    assert.equal(walHealth.readOnlyEnforced, true);

    const walCkpt = await runPassiveWalCheckpoint(episodicDbPath);
    assert.equal(walCkpt.success, true);

    const orphanAudit = await auditCursorVscdbOrphans(episodicDbPath);
    assert.equal(orphanAudit.totalRows, 0);

    // 6. RSI Instinct Engine initializes and queries cleanly on fallback DB
    const rsiDbPath = path.join(tmpHome, '.gemini', 'antigravity', 'agy-horizon', 'instincts.db');
    const rsi = new RsiInstinctEngine({ dbPath: rsiDbPath, homeDir: tmpHome });
    const instincts = rsi.listInstincts();
    assert.ok(Array.isArray(instincts));
    rsi.close();

    // 7. Doctor CLI reports PASS on Node >= 20 even when node:sqlite is absent
    const docRes = await runDoctor({ home: tmpHome, workspacePath: tmpHome, silent: true });
    const nodeCheck = docRes.results.find((r) => r.title === 'Node.js Runtime');
    assert.ok(nodeCheck);
    assert.equal(nodeCheck.status, 'PASS');
  } finally {
    if (prevEnv === undefined) {
      delete process.env.CTXTOP_FORCE_NO_SQLITE;
    } else {
      process.env.CTXTOP_FORCE_NO_SQLITE = prevEnv;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
