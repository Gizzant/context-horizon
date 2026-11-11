import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isHostProtectedSqlitePath,
  openLocalHorizonDb,
  openHostReadOnlyDb
} from './sqlite_client.mjs';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function renameSqliteWithRetrySync(srcPath, dstPath, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(srcPath, dstPath);
      return;
    } catch (err) {
      if (RETRYABLE_RENAME_CODES.has(err?.code) && attempt < maxAttempts) {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
        } catch {}
        continue;
      }
      throw err;
    }
  }
}

/**
 * Returns true strictly for plugin-owned `.agents/` SQLite databases (never host
 * `state.vscdb`, `conversations/*.db`, or `conversation_summaries.db`).
 */
export function isPluginOwnedAgentsSqlitePath(dbPath = '') {
  if (!dbPath || typeof dbPath !== 'string') return false;
  if (isHostProtectedSqlitePath(dbPath)) return false;
  const resolved = path.resolve(dbPath).replace(/\\/g, '/').toLowerCase();
  return /(^|\/)\.agents(\/|$)/.test(resolved);
}

/**
 * Local Storage Doctor — Read-only host orphan auditing, `.agents/` SQLite streaming GC,
 * and Antigravity 2.6+ `brain/` recovery.
 */

export async function auditCursorVscdbOrphans(vscdbPath, options = {}) {
  const breakdown = {
    bubbleId: 0,
    checkpointId: 0,
    messageRequestContext: 0,
    agentKv: 0
  };

  let rows = Array.isArray(options.mockRows) ? options.mockRows : null;
  if (!rows && vscdbPath && fs.existsSync(vscdbPath)) {
    let db = null;
    try {
      db = openHostReadOnlyDb(vscdbPath, { DatabaseSync: options.DatabaseSync });
      rows = db.prepare('SELECT key, value FROM cursorDiskKV').all();
    } catch {
      rows = [];
    } finally {
      try { if (db && typeof db.close === 'function') db.close(); } catch {}
    }
  }

  const list = rows || [];
  const activeComposerIds = new Set();
  const referencedBlobIds = new Set();

  for (const r of list) {
    const key = String(r.key || '');
    const rawVal = typeof r.value === 'string'
      ? r.value
      : (Buffer.isBuffer(r.value) ? r.value.toString('utf8') : String(r.value || ''));

    if (key.startsWith('composerData:')) {
      const cid = key.slice('composerData:'.length).trim();
      if (cid) activeComposerIds.add(cid);
      const blobMatches = rawVal.match(/agentKv:blob:[A-Za-z0-9_-]+/g) || [];
      for (const bm of blobMatches) referencedBlobIds.add(bm);
    }
  }

  // Second pass: collect blob references from live bubbles
  for (const r of list) {
    const key = String(r.key || '');
    if (key.startsWith('bubbleId:')) {
      const parts = key.split(':');
      const cid = parts[1] || '';
      if (activeComposerIds.has(cid)) {
        const rawVal = typeof r.value === 'string'
          ? r.value
          : (Buffer.isBuffer(r.value) ? r.value.toString('utf8') : String(r.value || ''));
        const blobMatches = rawVal.match(/agentKv:blob:[A-Za-z0-9_-]+/g) || [];
        for (const bm of blobMatches) referencedBlobIds.add(bm);
      }
    }
  }

  let orphanRowCount = 0;
  let orphanBytes = 0;

  for (const r of list) {
    const key = String(r.key || '');
    const valBytes = Buffer.isBuffer(r.value)
      ? r.value.length
      : Buffer.byteLength(String(r.value || ''), 'utf8');
    const rowBytes = Buffer.byteLength(key, 'utf8') + valBytes;

    let isOrphan = false;
    if (key.startsWith('bubbleId:')) {
      const cid = key.split(':')[1] || '';
      if (!activeComposerIds.has(cid)) {
        isOrphan = true;
        breakdown.bubbleId += 1;
      }
    } else if (key.startsWith('checkpointId:')) {
      const cid = key.split(':')[1] || '';
      if (!activeComposerIds.has(cid)) {
        isOrphan = true;
        breakdown.checkpointId += 1;
      }
    } else if (key.startsWith('messageRequestContext:')) {
      const cid = key.split(':')[1] || '';
      if (!activeComposerIds.has(cid)) {
        isOrphan = true;
        breakdown.messageRequestContext += 1;
      }
    } else if (key.startsWith('agentKv:blob:')) {
      if (!referencedBlobIds.has(key) && activeComposerIds.size > 0) {
        isOrphan = true;
        breakdown.agentKv += 1;
      }
    }

    if (isOrphan) {
      orphanRowCount += 1;
      orphanBytes += rowBytes;
    }
  }

  return {
    vscdbPath: vscdbPath || '',
    totalRows: list.length,
    activeComposerIds: Array.from(activeComposerIds),
    referencedBlobIds: Array.from(referencedBlobIds),
    orphanRowCount,
    orphanBytes,
    orphanBreakdown: breakdown
  };
}

export async function compactCursorVscdbStreaming(vscdbPath, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const audit = await auditCursorVscdbOrphans(vscdbPath, options);

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      exportedLiveRows: Math.max(0, audit.totalRows - audit.orphanRowCount),
      removedOrphanRows: audit.orphanRowCount,
      reclaimedBytes: audit.orphanBytes,
      backupPath: null
    };
  }

  if (!isPluginOwnedAgentsSqlitePath(vscdbPath)) {
    return {
      success: false,
      dryRun: false,
      blockedHostWrite: true,
      reason: 'HOST_DB_READONLY_GUARD',
      exportedLiveRows: 0,
      removedOrphanRows: 0,
      reclaimedBytes: 0,
      backupPath: null,
      error: 'Compaction is restricted strictly to plugin-owned .agents/ SQLite databases; host state.vscdb and session DBs are read-only.'
    };
  }

  const resolvedPath = path.resolve(vscdbPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      dryRun: false,
      exportedLiveRows: 0,
      removedOrphanRows: 0,
      reclaimedBytes: 0,
      backupPath: null,
      error: 'vscdbPath does not exist'
    };
  }

  const activeSet = new Set(audit.activeComposerIds);
  const referencedBlobSet = new Set(audit.referencedBlobIds || []);
  const rand = Math.random().toString(36).slice(2, 8);
  const tmpExportPath = `${resolvedPath}.compact.${process.pid}.${Date.now()}.${rand}.sqlite`;

  let srcDb = null;
  let dstDb = null;
  let exportedLiveRows = 0;

  try {
    srcDb = openLocalHorizonDb(resolvedPath, {
      readOnly: true,
      DatabaseSync: options.DatabaseSync
    });
    dstDb = openLocalHorizonDb(tmpExportPath, {
      readOnly: false,
      DatabaseSync: options.DatabaseSync
    });

    dstDb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
    dstDb.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');

    try {
      const items = srcDb.prepare('SELECT key, value FROM ItemTable').all();
      const insItem = dstDb.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      for (const it of items) {
        insItem.run(it.key, it.value);
      }
    } catch {}

    const kvRows = srcDb.prepare('SELECT key, value FROM cursorDiskKV').all();
    const insKv = dstDb.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');

    for (const r of kvRows) {
      const key = String(r.key || '');
      let isOrphan = false;
      if (key.startsWith('bubbleId:') || key.startsWith('checkpointId:') || key.startsWith('messageRequestContext:')) {
        const cid = key.split(':')[1] || '';
        if (!activeSet.has(cid)) isOrphan = true;
      } else if (key.startsWith('agentKv:blob:')) {
        if (!referencedBlobSet.has(key) && activeSet.size > 0) isOrphan = true;
      }
      if (!isOrphan) {
        insKv.run(r.key, r.value);
        exportedLiveRows += 1;
      }
    }

    try {
      dstDb.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    } catch {}
  } catch (err) {
    try { if (srcDb) srcDb.close(); } catch {}
    try { if (dstDb) dstDb.close(); } catch {}
    srcDb = null;
    dstDb = null;
    for (const cleanupPath of [tmpExportPath, `${tmpExportPath}-wal`, `${tmpExportPath}-shm`]) {
      try { if (fs.existsSync(cleanupPath)) fs.unlinkSync(cleanupPath); } catch {}
    }
    throw err;
  } finally {
    try { if (srcDb) srcDb.close(); } catch {}
    try { if (dstDb) dstDb.close(); } catch {}
  }

  const backupPath = `${resolvedPath}.pre_gc.${Date.now()}.bak`;
  fs.copyFileSync(resolvedPath, backupPath);

  for (const sidecarPath of [`${tmpExportPath}-wal`, `${tmpExportPath}-shm`, `${resolvedPath}-wal`, `${resolvedPath}-shm`]) {
    try {
      if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
    } catch {}
  }

  renameSqliteWithRetrySync(tmpExportPath, resolvedPath);

  return {
    success: true,
    dryRun: false,
    exportedLiveRows,
    removedOrphanRows: audit.orphanRowCount,
    reclaimedBytes: audit.orphanBytes,
    backupPath
  };
}

export function recoverAntigravityBrainMigration(homeDir = os.homedir(), options = {}) {
  const dryRun = Boolean(options.dryRun);
  const geminiRoot = path.join(homeDir, '.gemini');
  const surfaces = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

  const dbSessionIds = new Set();
  const brainDirsBySurface = new Map();

  for (const surf of surfaces) {
    const convDir = path.join(geminiRoot, surf, 'conversations');
    if (fs.existsSync(convDir)) {
      try {
        for (const f of fs.readdirSync(convDir)) {
          if (f.endsWith('.db')) {
            dbSessionIds.add(path.basename(f, '.db'));
          }
        }
      } catch {}
    }

    const brainDir = path.join(geminiRoot, surf, 'brain');
    if (fs.existsSync(brainDir)) {
      try {
        for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const full = path.join(brainDir, entry.name);
            if (!brainDirsBySurface.has(entry.name)) brainDirsBySurface.set(entry.name, []);
            brainDirsBySurface.get(entry.name).push({ surface: surf, dir: full });
          }
        }
      } catch {}
    }
  }

  const recoveredLinks = [];
  let orphanedBrainCount = 0;

  for (const [sid, locations] of brainDirsBySurface.entries()) {
    const primaryBrain = path.join(geminiRoot, 'antigravity', 'brain', sid);
    const hasPrimaryTask = fs.existsSync(path.join(primaryBrain, 'task.md')) || fs.existsSync(path.join(primaryBrain, 'task.md.resolved'));

    if (!hasPrimaryTask) {
      const donor = locations.find(loc =>
        fs.existsSync(path.join(loc.dir, 'task.md')) ||
        fs.existsSync(path.join(loc.dir, 'task.md.resolved')) ||
        fs.existsSync(path.join(loc.dir, '.system_generated', 'logs', 'transcript_full.jsonl'))
      );
      if (donor && donor.dir !== primaryBrain) {
        orphanedBrainCount += 1;
        const filesCopied = [];
        const candidates = ['task.md', 'task.md.resolved', 'implementation_plan.md', 'walkthrough.md'];
        for (const cFile of candidates) {
          const srcFile = path.join(donor.dir, cFile);
          const dstFile = path.join(primaryBrain, cFile);
          if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
            if (!dryRun) {
              fs.mkdirSync(primaryBrain, { recursive: true });
              fs.copyFileSync(srcFile, dstFile);
            }
            filesCopied.push(cFile);
          }
        }
        recoveredLinks.push({
          sessionId: sid,
          fromBrainDir: donor.dir,
          toBrainDir: primaryBrain,
          filesCopied
        });
      }
    }
  }

  return {
    scannedDbCount: dbSessionIds.size,
    orphanedBrainCount,
    recoveredLinks
  };
}
