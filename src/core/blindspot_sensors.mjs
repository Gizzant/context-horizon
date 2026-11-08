import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalizePath } from './path_canonicalizer.mjs';
import { fingerprintErrorLoop } from './session_forensics.mjs';

/**
 * Sensor 1: detectDirtySnapshots (DIRTY_SNAP)
 * Flags files modified on disk by external processes after agent last touched them.
 */
export function detectDirtySnapshots(stepEvents = [], workspacePath = '') {
  const lastTouchMap = new Map();
  const fileTools = new Set([
    'view_file', 'read_file',
    'write_to_file', 'write_file',
    'replace_file_content', 'edit_file'
  ]);

  for (const ev of stepEvents) {
    if (ev.targetPath && (fileTools.has(ev.toolName) || ev.type === 'FILE_ACCESS')) {
      const canonical = canonicalizePath(ev.targetPath);
      const prev = lastTouchMap.get(canonical) || 0;
      lastTouchMap.set(canonical, Math.max(prev, ev.timestampMs));
    }
  }

  const dirtySnapshotPaths = [];
  for (const [filePath, lastTouchMs] of lastTouchMap.entries()) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > lastTouchMs + 500) {
          dirtySnapshotPaths.push(filePath);
        }
      }
    } catch {}
  }

  return dirtySnapshotPaths;
}

/**
 * Sensor 2: auditSchemaAndPayloads (SCHEMA_TAX)
 * Audits Turn 0 schema cost and oversized tool payloads (>25k tokens).
 */
export function auditSchemaAndPayloads(stepEvents = [], toolUsageLedger = {}, config = {}) {
  let schemaTokens = 0;
  for (const ev of stepEvents) {
    if (ev.stepIndex === 0 && (ev.type === 'SCHEMA' || ev.type === 'ANCHOR_SCHEMA')) {
      schemaTokens += ev.tokenEstimate || 0;
    }
  }

  const baseCeiling = config.max_tokens || config.maxTokens || config.nativeCeilingTokens || 200000;
  const schemaTaxPct = Number(((schemaTokens / baseCeiling) * 100).toFixed(1));
  const unusedMcpServers = [];

  if (schemaTaxPct > 15 && toolUsageLedger && toolUsageLedger.servers) {
    for (const [serverName, meta] of Object.entries(toolUsageLedger.servers)) {
      const calls = meta.invocationsLast15Sessions ?? meta.invocations ?? 0;
      if (calls === 0) {
        unusedMcpServers.push(serverName);
      }
    }
  }

  const maxPayloadTokens = config.max_tool_payload_tokens || 25000;
  let oversizedPayloadDetected = false;

  // Check last turn tool outputs
  for (let i = stepEvents.length - 1; i >= 0; i--) {
    const ev = stepEvents[i];
    if (ev.role === 'user') break; // stop at boundary of last turn
    if ((ev.role === 'tool' || ev.type === 'TOOL_RESULT') && (ev.tokenEstimate || 0) > maxPayloadTokens) {
      oversizedPayloadDetected = true;
      break;
    }
  }

  return { schemaTaxPct, unusedMcpServers, oversizedPayloadDetected };
}

/**
 * Sensor 3: detectUnseenCallers (UNSEEN_CALLERS)
 * Identifies workspace files importing target files that are NOT in ACTIVE_SET.
 */
let cachedReverseMap = null;
let cachedWorkspace = '';
let cachedScanTime = 0;

export function buildReverseImportMap(workspacePath) {
  const now = Date.now();
  if (cachedReverseMap && cachedWorkspace === workspacePath && (now - cachedScanTime) < 15000) {
    return cachedReverseMap;
  }

  const importMap = new Map(); // targetBaseName -> Set of canonical importer paths
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return importMap;
  }

  const fileExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.py']);
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.gemini', 'out']);

  function scanDir(dir, depth = 0) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) scanDir(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (fileExtensions.has(ext)) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            const canonicalImporter = canonicalizePath(full);
            // JS/TS imports
            const jsMatches = content.matchAll(/(?:import|require|from)\s*\(?['"]([^'"]+)['"]/g);
            const importerDir = path.dirname(full);
            for (const m of jsMatches) {
              const rawSpec = m[1];
              const noExtSpec = rawSpec.replace(/\.[^/.]+$/, '');
              const base = path.basename(noExtSpec).toLowerCase();
              if (rawSpec.startsWith('.')) {
                const resolvedNoExt = canonicalizePath(path.resolve(importerDir, noExtSpec));
                if (!importMap.has(resolvedNoExt)) importMap.set(resolvedNoExt, new Set());
                importMap.get(resolvedNoExt).add(canonicalImporter);
              }
              const dirBase = path.posix.join(path.basename(path.dirname(noExtSpec)).toLowerCase(), base);
              if (dirBase && dirBase !== `.` && !dirBase.startsWith('./')) {
                if (!importMap.has(dirBase)) importMap.set(dirBase, new Set());
                importMap.get(dirBase).add(canonicalImporter);
              }
              if (base && base !== 'index') {
                if (!importMap.has(base)) importMap.set(base, new Set());
                importMap.get(base).add(canonicalImporter);
              }
            }
            // Python imports
            const pyMatches = content.matchAll(/(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g);
            for (const m of pyMatches) {
              const mod = (m[1] || m[2] || '').split('.').pop()?.toLowerCase();
              if (mod) {
                if (!importMap.has(mod)) importMap.set(mod, new Set());
                importMap.get(mod).add(canonicalImporter);
              }
            }
          } catch {}
        }
      }
    }
  }

  scanDir(workspacePath, 0);
  cachedReverseMap = importMap;
  cachedWorkspace = workspacePath;
  cachedScanTime = now;
  return importMap;
}

export function detectUnseenCallers(targetFiles = [], activeSetPaths = [], workspacePath = '') {
  const unseen = new Set();
  const activeSet = new Set(activeSetPaths.map(p => canonicalizePath(p)));
  const reverseMap = buildReverseImportMap(workspacePath);

  for (const target of targetFiles) {
    const canonicalTarget = canonicalizePath(target);
    const targetNoExt = canonicalTarget.replace(/\.[^/.]+$/, '');
    const baseName = path.basename(target).replace(/\.[^/.]+$/, '').toLowerCase();
    const dirBase = path.posix.join(path.basename(path.dirname(canonicalTarget)).toLowerCase(), baseName);
    const candidateSets = [
      reverseMap.get(targetNoExt),
      reverseMap.get(dirBase),
      baseName !== 'index' ? reverseMap.get(baseName) : null
    ];

    for (const callers of candidateSets) {
      if (callers) {
        for (const caller of callers) {
          if (!activeSet.has(caller) && caller !== canonicalTarget) {
            unseen.add(caller);
          }
        }
      }
    }
  }

  return Array.from(unseen);
}

/**
 * Sensor 4: detectLegacyPoison (LEGACY_POISON)
 * Detects deprecated legacy code loaded into attention context.
 */
export function detectLegacyPoison(stepEvents = [], config = {}) {
  const deprecatedGlobs = config.deprecated_paths || ['**/legacy/**', '**/deprecated/**', '**/v1/**'];
  const legacyPoison = new Set();

  for (const ev of stepEvents) {
    if (!ev.targetPath) continue;
    const canon = canonicalizePath(ev.targetPath);
    const hasDeprecatedTag = Boolean(ev.isDeprecatedContent) ||
      /@deprecated/i.test(String(ev.content || '').split(/\r?\n/).slice(0, 30).join('\n'));
    if (hasDeprecatedTag) {
      legacyPoison.add(canon);
    } else {
      const isDeprecated = deprecatedGlobs.some(g => canon.includes(g.replace(/\*/g, '').toLowerCase()));
      if (isDeprecated) {
        legacyPoison.add(canon);
      }
    }
  }

  return Array.from(legacyPoison);
}

/**
 * Sensor 5: evaluateQuotaAndStreamShield (QUOTA_AND_STREAM_SHIELD)
 * Guards 10% rolling quota floor and flags >600-line rewrite stream cutoff risk.
 */
export function evaluateQuotaAndStreamShield(sidecarState = {}, targetFiles = [], promptText = '', config = {}) {
  const remainingFraction = sidecarState.telemetry?.quota?.remaining_fraction ?? 1.0;
  const quotaFloor = config.quota_floor_fraction ?? 0.10;
  const quotaFloorBreached = remainingFraction < quotaFloor;

  const inPlan = Boolean(sidecarState.sessionMeta?.inPlanMode);
  const activeModel = String(sidecarState.sessionMeta?.activeModel || '');
  const isFlash = activeModel.includes('flash');
  const tokens = sidecarState.telemetry?.totalInputTokens || 0;
  const planToFlashHandoffNeeded = inPlan && isFlash && tokens > 40000;

  const maxLines = config.max_single_write_lines || 600;
  const streamCutoffRiskFiles = [];

  for (const tf of targetFiles) {
    try {
      if (fs.existsSync(tf)) {
        const text = fs.readFileSync(tf, 'utf8');
        const lines = text.split(/\r?\n/).length;
        if (lines > maxLines) {
          const isFullRewrite = /(rewrite|regenerate|replace whole|re-implement|create entire)/i.test(promptText) ||
            !/(lines?|slice|chunk|diff|function|method|surgical)/i.test(promptText);
          if (isFullRewrite) {
            streamCutoffRiskFiles.push(canonicalizePath(tf));
          }
        }
      }
    } catch {}
  }

  return {
    quotaFloorBreached,
    planToFlashHandoffNeeded,
    streamCutoffRiskFiles
  };
}

/**
 * Sensor 6: evaluateLoopAndGitGuard (LOOP_AND_GIT_GUARD)
 * Detects 3-strike error loops and uncheckpointed git code drift.
 */
let cachedGitResult = { dirtyGitFileCount: 0, uncheckpointedGitDrift: false, timestampMs: 0, workspace: '' };

export function evaluateLoopAndGitGuard(stepEvents = [], sidecarState = {}, workspacePath = '', config = {}) {
  const limit = config.consecutive_error_strike_limit || 3;
  let trailingErrorStreak = 0;

  for (let i = stepEvents.length - 1; i >= 0; i--) {
    const ev = stepEvents[i];
    if (ev.exitCode !== null && ev.exitCode !== 0) {
      trailingErrorStreak++;
    } else if (ev.exitCode === 0) {
      break;
    }
  }

  const loopFp = fingerprintErrorLoop(stepEvents);
  const threeStrikeLoop = trailingErrorStreak >= limit || Boolean(sidecarState.brainSignals?.errorLoop?.loop) || loopFp.loop;
  const loopFingerprint = loopFp.fingerprint || sidecarState.brainSignals?.errorLoop?.fingerprint || null;
  const turnsSincePassing = sidecarState.sessionMeta?.turnsSinceLastPassingTest || 0;
  const fileLimit = config.uncheckpointed_dirty_file_limit || 4;

  // If passing tests are recent (<3 turns), git drift is false by definition
  if (turnsSincePassing < 3 || !workspacePath) {
    return { threeStrikeLoop, loopFingerprint, uncheckpointedGitDrift: false, dirtyGitFileCount: 0 };
  }

  const now = Date.now();
  if (cachedGitResult.workspace === workspacePath && (now - cachedGitResult.timestampMs) < 3000) {
    return {
      threeStrikeLoop,
      loopFingerprint,
      uncheckpointedGitDrift: cachedGitResult.uncheckpointedGitDrift,
      dirtyGitFileCount: cachedGitResult.dirtyGitFileCount
    };
  }

  let dirtyGitFileCount = 0;
  let uncheckpointedGitDrift = false;

  // Only spawn git if .git directory exists in workspace
  const gitDir = path.join(workspacePath, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      const stdout = execFileSync('git', ['status', '--porcelain'], {
        cwd: workspacePath,
        timeout: 200,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
      dirtyGitFileCount = lines.length;

      if (dirtyGitFileCount >= fileLimit && turnsSincePassing >= 3) {
        uncheckpointedGitDrift = true;
      }
    } catch {
      // Git unavailable or timeout, skip gracefully
    }
  }

  cachedGitResult = {
    dirtyGitFileCount,
    uncheckpointedGitDrift,
    timestampMs: now,
    workspace: workspacePath
  };

  return { threeStrikeLoop, uncheckpointedGitDrift, dirtyGitFileCount };
}

/**
 * Aggregator: runs all 6 sensors in under 15ms.
 */
export function runAllBlindspotSensors(params = {}) {
  const {
    stepEvents = [],
    sidecarState = {},
    workspacePath = '',
    targetFiles = [],
    activeSetPaths = [],
    toolUsageLedger = {},
    promptText = '',
    config = {}
  } = params;

  const dirtySnapshotPaths = detectDirtySnapshots(stepEvents, workspacePath);
  const { schemaTaxPct, unusedMcpServers, oversizedPayloadDetected } = auditSchemaAndPayloads(stepEvents, toolUsageLedger, config);
  const unseenCallers = detectUnseenCallers(targetFiles, activeSetPaths, workspacePath);
  const legacyPoisonPaths = detectLegacyPoison(stepEvents, config);
  const { quotaFloorBreached, planToFlashHandoffNeeded, streamCutoffRiskFiles } = evaluateQuotaAndStreamShield(sidecarState, targetFiles, promptText, config);
  const { threeStrikeLoop, loopFingerprint, uncheckpointedGitDrift, dirtyGitFileCount } = evaluateLoopAndGitGuard(stepEvents, sidecarState, workspacePath, config);

  return {
    dirtySnapshotPaths,
    schemaTaxPct,
    unusedMcpServers,
    oversizedPayloadDetected,
    unseenCallers,
    legacyPoisonPaths,
    quotaFloorBreached,
    planToFlashHandoffNeeded,
    streamCutoffRiskFiles,
    threeStrikeLoop,
    loopFingerprint,
    uncheckpointedGitDrift,
    dirtyGitFileCount
  };
}
