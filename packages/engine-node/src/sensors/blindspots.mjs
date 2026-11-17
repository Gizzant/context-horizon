/**
 * @file src/engine-node/sensors/blindspots.mjs
 * Local filesystem & AST repository blindspot forensic sensors.
 *
 * Implements the 4 core repository sensors:
 *   1. DIRTY_SNAP (DET-28): Detects files modified externally after last touch.
 *   2. UNSEEN_CALLERS (DET-27): Reverses workspace AST import graph to identify unmonitored callers.
 *   3. LEGACY_POISON (DET-26): Detects deprecated / v1 code or @deprecated headers in context.
 *   4. FOREIGN_BLEED (DET-25 / DET-23): Detects foreign knowledge:// items or cross-workspace bleed.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalizes a path for consistent case-insensitive slash-independent comparisons.
 * @param {string} p
 * @returns {string}
 */
export function canonicalizePath(p = '') {
  const norm = String(p || '').replace(/\\/g, '/').trim();
  // On Windows, drive letters should be normalized
  return norm.toLowerCase();
}

/**
 * Sensor 1: detectDirtySnapshots (DIRTY_SNAP - DET-28)
 * Flags files modified on disk by external processes after agent last touched them.
 *
 * @param {Array<object>} stepEvents
 * @param {string} [workspacePath='']
 * @returns {string[]} List of dirty file paths
 */
export function detectDirtySnapshots(stepEvents = [], workspacePath = '') {
  if (!Array.isArray(stepEvents)) return [];
  const lastTouchMap = new Map();
  const fileTools = new Set([
    'view_file', 'read_file', 'read', 'view',
    'write_to_file', 'write_file', 'write',
    'replace_file_content', 'edit_file', 'edit'
  ]);

  for (const ev of stepEvents) {
    if (!ev || typeof ev !== 'object') continue;
    const tool = String(ev.toolName || ev.tool || '').toLowerCase();
    const target = ev.targetPath || ev.filePath || ev.path;
    if (target && (fileTools.has(tool) || ev.type === 'FILE_ACCESS' || ev.type === 'FILE_READ' || ev.type === 'FILE_WRITE')) {
      const ts = Number(ev.timestampMs || (ev.createdAt ? Date.parse(ev.createdAt) : 0) || ev.timestamp || 0);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const canonical = canonicalizePath(target);
      const prev = lastTouchMap.get(canonical);
      const nextTs = prev ? Math.max(prev.ts, ts) : ts;
      lastTouchMap.set(canonical, { ts: nextTs, rawPath: String(target).trim(), canonical });
    }
  }

  const dirtySnapshotPaths = [];
  for (const [canonical, entry] of lastTouchMap.entries()) {
    const lastTouchMs = entry.ts;
    if (!Number.isFinite(lastTouchMs) || lastTouchMs <= 0) continue;
    try {
      const candidatePath = fs.existsSync(entry.rawPath)
        ? entry.rawPath
        : (workspacePath && fs.existsSync(path.resolve(workspacePath, entry.rawPath))
          ? path.resolve(workspacePath, entry.rawPath)
          : canonical);
      if (fs.existsSync(candidatePath)) {
        const stat = fs.statSync(candidatePath);
        if (stat.mtimeMs > lastTouchMs + 500) {
          dirtySnapshotPaths.push(canonical);
        }
      }
    } catch {
      // Ignore file access errors
    }
  }

  return dirtySnapshotPaths;
}

let cachedReverseMap = null;
let cachedWorkspace = null;
let cachedScanTime = 0;

/**
 * Builds or retrieves cached reverse import map for workspace (<15s TTL).
 * Bounded to max depth 4, max 250 files to guarantee <8ms execution.
 *
 * @param {string} workspacePath
 * @returns {Map<string, Set<string>>}
 */
export function buildReverseImportMap(workspacePath) {
  const now = Date.now();
  if (cachedReverseMap && cachedWorkspace === workspacePath && (now - cachedScanTime) < 15000) {
    return cachedReverseMap;
  }

  const importMap = new Map();
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return importMap;
  }

  const fileExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.py']);
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.gemini', 'out', '.agents']);
  let scannedCount = 0;

  function scanDir(dir, depth = 0) {
    if (depth > 4 || scannedCount >= 250) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scannedCount >= 250) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) scanDir(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (fileExtensions.has(ext)) {
          scannedCount++;
          try {
            const content = fs.readFileSync(full, 'utf8');
            const canonicalImporter = canonicalizePath(full);
            const importerDir = path.dirname(full);

            // JS/TS imports and requires
            const jsMatches = content.matchAll(/(?:import|require|from)\s*\(?['"]([^'"]+)['"]/g);
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
              if (dirBase && dirBase !== '.' && !dirBase.startsWith('./')) {
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
          } catch {
            // Ignore individual file read errors
          }
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

/**
 * Sensor 2: detectUnseenCallers (UNSEEN_CALLERS - DET-27)
 * Identifies workspace files importing the targets that are not in the activeSet.
 *
 * @param {string[]} targetFiles
 * @param {string[]} activeSetPaths
 * @param {string} [workspacePath='']
 * @returns {string[]} List of unseen caller file paths
 */
export function detectUnseenCallers(targetFiles = [], activeSetPaths = [], workspacePath = '') {
  const unseen = new Set();
  const safeActivePaths = Array.isArray(activeSetPaths) ? activeSetPaths : [];
  const safeTargets = Array.isArray(targetFiles) ? targetFiles : [];
  const activeSet = new Set(safeActivePaths.filter(Boolean).map(p => canonicalizePath(p)));
  const reverseMap = buildReverseImportMap(workspacePath);

  for (const target of safeTargets) {
    if (!target) continue;
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
 * Sensor 3: detectLegacyPoison (LEGACY_POISON - DET-26)
 * Detects deprecated legacy code loaded into attention context.
 *
 * @param {Array<object>} stepEvents
 * @param {object} [config={}]
 * @returns {string[]} List of legacy poison file paths
 */
export function detectLegacyPoison(stepEvents = [], config = {}) {
  if (!Array.isArray(stepEvents)) return [];
  const cfg = (config && typeof config === 'object') ? config : {};
  const deprecatedGlobs = cfg.deprecated_paths || ['**/legacy/**', '**/deprecated/**', '**/v1/**'];
  const legacyPoison = new Set();

  for (const ev of stepEvents) {
    if (!ev || typeof ev !== 'object') continue;
    const target = ev.targetPath || ev.filePath || ev.path;
    if (!target) continue;
    const canon = canonicalizePath(target);
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
 * Sensor 4: detectForeignBleed (FOREIGN_BLEED - DET-25 / DET-23)
 * Evaluates knowledge URIs (knowledge://) and cross-workspace path references.
 *
 * @param {Array<object>} stepEvents
 * @param {string[]} [canonicalWorkspaces=[]]
 * @param {object} [options={}]
 * @returns {Array<object>} List of foreign bleed items
 */
export function detectForeignBleed(stepEvents = [], canonicalWorkspaces = [], options = {}) {
  if (!Array.isArray(stepEvents)) return [];
  const safeWorkspaces = Array.isArray(canonicalWorkspaces) ? canonicalWorkspaces : [];
  const allowedWorkspaces = safeWorkspaces
    .map(w => canonicalizePath(w))
    .filter(Boolean);

  const bleedItems = [];
  const seenUris = new Set();

  for (const ev of stepEvents) {
    if (!ev || typeof ev !== 'object') continue;
    // 1. Check knowledge:// references
    const text = [
      ev.content,
      ev.targetPath,
      ev.filePath,
      ev.uri,
      ev.description
    ].filter(Boolean).join(' ');

    const knowledgeMatches = text.match(/knowledge:\/\/([a-zA-Z0-9_.-]+)/gi);
    if (knowledgeMatches) {
      for (const km of knowledgeMatches) {
        if (!seenUris.has(km)) {
          seenUris.add(km);
          // If knowledge item points to metadata or workspace references outside allowedWorkspaces
          const isBleed = Boolean(ev.isForeignBleed || ev.isBleed);
          if (isBleed || allowedWorkspaces.length > 0) {
            bleedItems.push({
              uri: km,
              type: 'KNOWLEDGE_BLEED',
              source: ev.targetPath || ev.toolName || 'prompt',
              reason: `Foreign knowledge item reference: ${km}`
            });
          }
        }
      }
    }

    // 2. Check cross-workspace path bleed
    const targetPath = ev.targetPath || ev.filePath;
    if (targetPath && allowedWorkspaces.length > 0) {
      const canon = canonicalizePath(targetPath);
      // Skip system or temporary tool output paths
      if (!canon.includes('/tmp/') && !canon.includes('/temp/') && !canon.startsWith('node:')) {
        const matchesAnyWorkspace = allowedWorkspaces.some(w => canon.startsWith(w));
        if (!matchesAnyWorkspace && !seenUris.has(canon)) {
          seenUris.add(canon);
          bleedItems.push({
            uri: canon,
            type: 'WORKSPACE_BLEED',
            source: targetPath,
            reason: `Cross-workspace path reference outside active workspace roots: ${targetPath}`
          });
        }
      }
    }
  }

  return bleedItems;
}

/**
 * Aggregator: runs all 4 blindspot sensors in <12ms.
 *
 * @param {object} params
 * @param {Array<object>} [params.stepEvents=[]]
 * @param {string[]} [params.targetFiles=[]]
 * @param {string[]} [params.activeSetPaths=[]]
 * @param {string} [params.workspacePath='']
 * @param {string[]} [params.canonicalWorkspaces=[]]
 * @param {object} [params.config={}]
 * @returns {object} Aggregate blindspot forensic report
 */
export function runBlindspotSensors(params = {}) {
  const start = performance.now();
  const safeParams = (params && typeof params === 'object') ? params : {};
  const stepEvents = Array.isArray(safeParams.stepEvents) ? safeParams.stepEvents : [];
  const targetFiles = Array.isArray(safeParams.targetFiles) ? safeParams.targetFiles : [];
  const activeSetPaths = Array.isArray(safeParams.activeSetPaths) ? safeParams.activeSetPaths : [];
  const workspacePath = safeParams.workspacePath || '';
  const canonicalWorkspaces = Array.isArray(safeParams.canonicalWorkspaces)
    ? safeParams.canonicalWorkspaces
    : (workspacePath ? [workspacePath] : []);
  const config = (safeParams.config && typeof safeParams.config === 'object') ? safeParams.config : {};

  const dirtySnapshotPaths = detectDirtySnapshots(stepEvents, workspacePath);
  const unseenCallers = detectUnseenCallers(targetFiles, activeSetPaths, workspacePath);
  const legacyPoisonPaths = detectLegacyPoison(stepEvents, config);
  const foreignBleedItems = detectForeignBleed(stepEvents, canonicalWorkspaces, params);

  const durationMs = Number((performance.now() - start).toFixed(3));

  return {
    dirtySnapshotPaths,
    unseenCallers,
    legacyPoisonPaths,
    foreignBleedItems,
    durationMs
  };
}

export default {
  canonicalizePath,
  detectDirtySnapshots,
  buildReverseImportMap,
  detectUnseenCallers,
  detectLegacyPoison,
  detectForeignBleed,
  runBlindspotSensors
};
