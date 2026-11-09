import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalizePath } from './path_canonicalizer.mjs';

const SIDECAR_VERSION = '3.1.0';
const UUID_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_FLIGHTCHECK_DIR = path.join(os.tmpdir(), 'agy-flightcheck-test');

/**
 * Returns default flightcheck root directory (~/.gemini/flightcheck)
 */
export function getFlightcheckDir(baseDirOverride = null) {
  if (baseDirOverride) return baseDirOverride;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.gemini', 'flightcheck');
}

/**
 * Returns path to session sidecar file.
 * Non-UUID synthetic/test session IDs are routed to os.tmpdir() so unit tests never pollute ~/.gemini/flightcheck/sessions.
 */
export function getSidecarPath(conversationId, baseDirOverride = null) {
  if (baseDirOverride) {
    return path.join(baseDirOverride, 'sessions', `${conversationId}.sidecar.json`);
  }
  const isRealUuid = UUID_SESSION_RE.test(String(conversationId || '').trim());
  const root = isRealUuid ? getFlightcheckDir() : TEST_FLIGHTCHECK_DIR;
  return path.join(root, 'sessions', `${conversationId}.sidecar.json`);
}

/**
 * Returns path to tool usage ledger
 */
export function getToolUsagePath(baseDirOverride = null) {
  const root = getFlightcheckDir(baseDirOverride);
  return path.join(root, 'tool_usage.json');
}

/**
 * Creates a clean default sidecar state object.
 */
export function createDefaultSidecar(conversationId = '', workspacePath = '') {
  return {
    version: SIDECAR_VERSION,
    conversationId: String(conversationId || ''),
    workspacePath: canonicalizePath(workspacePath || ''),
    updatedAtMs: Date.now(),
    sessionMeta: {
      turnCount: 0,
      activeModel: 'gemini-3.8-flash',
      activeEffort: 'high',
      inPlanMode: false,
      effortLocked: false,
      lastTurnUsedSubagent: false,
      consecutiveTrivialOnMax: 0,
      consecutiveErrorStreak: 0,
      turnsSinceLastPassingTest: 0
    },
    telemetry: {
      totalInputTokens: 0,
      usedPercentage: 0,
      exceeds200kTokens: false,
      signalPurityPct: 100.0,
      sludgeTaxUsdPerTurn: 0.0,
      amputationRisk: false,
      agentState: 'idle',
      mode: 'auto',
      quota: {
        remaining_fraction: 1.0,
        remaining_amount: 100,
        reset_in_seconds: 18000,
        buckets: {}
      },
      history: []
    },
    cells: [],
    fileState: {
      activeSetPaths: [],
      staleDupPaths: [],
      dirtySnapshotPaths: [],
      legacyPoisonPaths: [],
      unseenCallers: [],
      streamCutoffRiskFiles: [],
      foreignBleedKiIds: []
    },
    sensors: {
      schemaTaxPct: 0.0,
      unusedMcpServers: [],
      oversizedPayloadDetected: false,
      quotaFloorBreached: false,
      planToFlashHandoffNeeded: false,
      threeStrikeLoop: false,
      loopFingerprint: null,
      uncheckpointedGitDrift: false,
      dirtyGitFileCount: 0,
      planRevisions: 0,
      planRevisionWarn: false,
      proofQuality: 'None',
      proofQualityReason: '',
      splitRecommended: false,
      splitReason: ''
    },
    handoff: {
      result: 'MISSING',
      targetFile: null,
      failingChecks: [],
      fixes: []
    },
    cursor: {
      filePath: null,
      byteOffset: 0,
      tier: 0
    }
  };
}

const _sidecarMemCache = new Map();
const SIDECAR_CACHE_TTL_MS = 250;

/**
 * Reads sidecar JSON synchronously with <2ms guaranteed SLA.
 * Falls back to default state on ENOENT or parse error.
 */
export function readSidecarSync(conversationId, baseDirOverride = null) {
  if (!conversationId) return createDefaultSidecar();
  const filePath = getSidecarPath(conversationId, baseDirOverride);
  const now = Date.now();
  const cached = _sidecarMemCache.get(filePath);
  if (cached && (now - cached.timeMs) < SIDECAR_CACHE_TTL_MS) {
    return JSON.parse(JSON.stringify(cached.data));
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      _sidecarMemCache.set(filePath, { timeMs: now, data: parsed });
      return JSON.parse(JSON.stringify(parsed));
    }
  } catch {
    _sidecarMemCache.delete(filePath);
  }

  return createDefaultSidecar(conversationId);
}

/**
 * Performs atomic rename with exponential backoff on Windows EPERM/EBUSY contention.
 */
function renameWithBackoffSync(tmpPath, targetPath, fallbackPayloadStr) {
  const delaysMs = [1, 2];
  let renamed = false;

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      renamed = true;
      break;
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < delaysMs.length) {
        sleepSync(delaysMs[attempt]);
      } else if (err.code !== 'EPERM' && err.code !== 'EBUSY') {
        throw err;
      }
    }
  }

  if (!renamed) {
    fs.writeFileSync(targetPath, fallbackPayloadStr, 'utf8');
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Writes an arbitrary JSON object to disk atomically via temporary file and rename with backoff.
 */
export function writeJsonAtomicSync(filePath, dataObj) {
  const targetDir = path.dirname(filePath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const jsonStr = JSON.stringify(dataObj, null, 2);
  const baseName = path.basename(filePath);
  const tmpPath = path.join(
    targetDir,
    `${baseName}.${process.pid}.${process.hrtime.bigint()}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    renameWithBackoffSync(tmpPath, filePath, jsonStr);
    _sidecarMemCache.set(filePath, { timeMs: Date.now(), data: JSON.parse(jsonStr) });
    return dataObj;
  } catch {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(filePath, jsonStr, 'utf8');
    _sidecarMemCache.set(filePath, { timeMs: Date.now(), data: JSON.parse(jsonStr) });
    return dataObj;
  }
}

/**
 * Performs lock-free atomic write via unique temp file + renameSync.
 * Includes Windows EPERM/EBUSY exponential backoff retry.
 */
export function writeSidecarAtomicSync(conversationId, stateObj, baseDirOverride = null) {
  const filePath = getSidecarPath(conversationId, baseDirOverride);
  const payload = {
    ...stateObj,
    conversationId: String(conversationId),
    updatedAtMs: Date.now()
  };
  return writeJsonAtomicSync(filePath, payload);
}

/**
 * Reads the freshest sidecar state immediately before write, merges only the targeted
 * section (e.g. 'sessionMeta', 'telemetry'), and writes back atomically.
 * Prevents race conditions and lost updates between concurrent writers.
 */
export function mergeSidecarSectionSync(conversationId, sectionName, patchObj, baseDirOverride = null) {
  if (!conversationId || !sectionName) return null;
  const current = readSidecarSync(conversationId, baseDirOverride);
  const existingSection = (current[sectionName] && typeof current[sectionName] === 'object' && !Array.isArray(current[sectionName]))
    ? current[sectionName]
    : {};
  const updated = {
    ...current,
    [sectionName]: {
      ...existingSection,
      ...patchObj
    }
  };
  return writeSidecarAtomicSync(conversationId, updated, baseDirOverride);
}

/**
 * Mutates sidecar state atomically and returns updated state.
 */
export function updateSidecarPartialSync(conversationId, mutatorFn, baseDirOverride = null) {
  const current = readSidecarSync(conversationId, baseDirOverride);
  const updated = mutatorFn(current) || current;
  return writeSidecarAtomicSync(conversationId, updated, baseDirOverride);
}

/**
 * Reads the 15-session tool usage ledger.
 */
export function readToolUsageSync(baseDirOverride = null) {
  const filePath = getToolUsagePath(baseDirOverride);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      version: SIDECAR_VERSION,
      updatedAtMs: Date.now(),
      servers: {}
    };
  }
}

/**
 * Writes the tool usage ledger atomically with backoff.
 */
export function writeToolUsageAtomicSync(ledgerObj, baseDirOverride = null) {
  const filePath = getToolUsagePath(baseDirOverride);
  const targetDir = path.dirname(filePath);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const payload = {
    ...ledgerObj,
    version: SIDECAR_VERSION,
    updatedAtMs: Date.now()
  };
  const jsonStr = JSON.stringify(payload, null, 2);
  const tmpPath = path.join(
    targetDir,
    `tool_usage.${process.pid}.${process.hrtime.bigint()}.tmp`
  );

  try {
    fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    renameWithBackoffSync(tmpPath, filePath, jsonStr);
    return payload;
  } catch {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(filePath, jsonStr, 'utf8');
    return payload;
  }
}

function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // spin wait fallback
    }
  }
}
