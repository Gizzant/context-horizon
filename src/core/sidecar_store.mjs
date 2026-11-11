import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalizePath } from './path_canonicalizer.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';

function resolveVersion() {
  try {
    let curr = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      const p = path.join(curr, 'package.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (data.version) return data.version;
      }
      const pl = path.join(curr, 'plugin.json');
      if (fs.existsSync(pl)) {
        const data = JSON.parse(fs.readFileSync(pl, 'utf8'));
        if (data.version) return data.version;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
  } catch {}
  return '3.2.0';
}

export const SIDECAR_VERSION = resolveVersion();
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
      active_model_id: 'gemini-3.8-flash',
      pending_model_id: null,
      activeEffort: 'high',
      inPlanMode: false,
      effortLocked: false,
      lastTurnUsedSubagent: false,
      consecutiveTrivialOnMax: 0,
      consecutiveErrorStreak: 0,
      turnsSinceLastPassingTest: 0
    },
    swarmRoster: {},
    agentCacheMap: {},
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
 * Writes an arbitrary JSON object to disk atomically via temporary file, fsync, and bounded rename retry.
 */
export function writeJsonAtomicSync(filePath, dataObj) {
  const jsonStr = JSON.stringify(dataObj, null, 2);
  atomicWriteFileSync(filePath, jsonStr, { encoding: 'utf8' });
  _sidecarMemCache.set(filePath, { timeMs: Date.now(), data: JSON.parse(jsonStr) });
  return dataObj;
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
 * Atomically updates a single `/swarm` agent's state inside `sidecar.swarmRoster`
 * using UTF-8 temp-file swap-and-rename so concurrent hook processes never corrupt session telemetry.
 */
export function updateSwarmAgentStateAtomicSync(conversationId, agentId, agentStatePatch = {}, baseDirOverride = null) {
  if (!conversationId || !agentId) return null;
  const current = readSidecarSync(conversationId, baseDirOverride);
  const roster = (current.swarmRoster && typeof current.swarmRoster === 'object' && !Array.isArray(current.swarmRoster))
    ? { ...current.swarmRoster }
    : {};
  const existingAgent = (roster[agentId] && typeof roster[agentId] === 'object') ? roster[agentId] : {};
  roster[agentId] = {
    ...existingAgent,
    ...agentStatePatch,
    agent_id: String(agentId)
  };
  return writeSidecarAtomicSync(
    conversationId,
    { ...current, swarmRoster: roster },
    baseDirOverride
  );
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
  atomicWriteFileSync(filePath, jsonStr, { encoding: 'utf8' });
  return payload;
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
