import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQLITE_OPEN_READONLY_OPTIONS } from './parser.mjs';

/**
 * Local Storage Doctor — Cursor `state.vscdb` Streaming GC & Antigravity 2.6+ `brain/` Recovery.
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
      const DbCtor = options.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
      db = new DbCtor(vscdbPath, SQLITE_OPEN_READONLY_OPTIONS);
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

  if (!vscdbPath || !fs.existsSync(vscdbPath)) {
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

  const DbCtor = options.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
  const activeSet = new Set(audit.activeComposerIds);
  const referencedBlobSet = new Set(audit.referencedBlobIds || []);
  const tmpExportPath = `${vscdbPath}.compact.${process.pid}.sqlite`;
  if (fs.existsSync(tmpExportPath)) {
    try { fs.unlinkSync(tmpExportPath); } catch {}
  }

  let srcDb = null;
  let dstDb = null;
  let exportedLiveRows = 0;

  try {
    srcDb = new DbCtor(vscdbPath, SQLITE_OPEN_READONLY_OPTIONS);
    dstDb = new DbCtor(tmpExportPath);

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
  } finally {
    try { if (srcDb) srcDb.close(); } catch {}
    try { if (dstDb) dstDb.close(); } catch {}
  }

  const backupPath = `${vscdbPath}.pre_gc.${Date.now()}.bak`;
  fs.copyFileSync(vscdbPath, backupPath);
  fs.renameSync(tmpExportPath, vscdbPath);

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
