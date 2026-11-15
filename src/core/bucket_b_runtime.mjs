/**
 * @file src/core/bucket_b_runtime.mjs
 * Node.js Runtime & Shadow-Telemetry Adapter for Bucket B Guardrails (`ctxtop`).
 *
 * Responsibilities:
 * - SKU-isolated workspace manifest / `.npmrc` / workspace-package discovery for `#6 SLOPSQUAT_DEP_GATE`
 * - Cold (`<25ms`) + incremental (`<3ms`) 5-line FNV-1a shingle index cache for `#8 DUPLICATE_CLONE_DETECTOR`
 * - Zero-spawn cached dirty-file state reader for `#13 VAGUE_PROMPT_ANCHOR`
 * - `AGENTS.md` / `CLAUDE.md` candidate hook preview scanner for `#20 PROSE_TO_HOOK_COMPILER` (`ctxtop doctor`)
 * - Unified `SHADOW` / `COACH` hook evaluation wrapper emitting `.hints.jsonl` records via `recordBucketBShadowHint`
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { recordBucketBShadowHint } from './shield_manager.mjs';
import {
  isBucketBForbiddenSkuPath,
  evaluateSlopsquatCommand,
  evaluateGrepGlobFirewall,
  distillHtmlWebPayload,
  evaluateBlastRadiusBreaker,
  computeFileShingles,
  detectDuplicateClones,
  evaluateHardcodedOracle,
  evaluateOverengineeringDiffGate,
  evaluateSubagentGovernor,
  evaluateVaguePromptAnchor,
  evaluateMcpCliRouter,
  evaluateLspSymbolRouter,
  compileProseRulesToHooks
} from '../core-isomorphic/guards/bucketBHeuristics.mjs';

const CODE_SCAN_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx)$/i;
const SKIP_WALK_DIRS = new Set([
  '.git',
  'node_modules',
  '.agents',
  '.claude',
  'evaluation_bundles',
  'dist',
  'build',
  'coverage',
  'experiments'
]);

const MEM_SHINGLE_CACHE = new Map();

export const BUCKET_B_ALPHA_IDS = Object.freeze([
  '#2_GREP_GLOB_FIREWALL',
  '#6_SLOPSQUAT_DEP_GATE',
  '#9_WEB_BOILERPLATE_BUDGETER',
  '#4_BLAST_RADIUS_BREAKER'
]);

export const BUCKET_B_BETA_IDS = Object.freeze([
  '#8_DUPLICATE_CLONE_DETECTOR',
  '#3B_EVILGENIE_ORACLE',
  '#19_OVERENGINEERING_DIFF_GATE'
]);

function isSilentOrOffFlightMode(options = {}) {
  const fm = String(
    options.mode || options.flightMode || options.horizonConfig?.flightMode || ''
  )
    .trim()
    .toUpperCase();
  return fm === 'SILENT' || fm === 'OFF';
}

/**
 * Resolves rollout stage for Sub-Wave B-Alpha (`#2`, `#6`, `#9`, `#4`) — promoted to `'COACH'`
 * by default after achieving `100%` precision and `0%` false-deny SLAs; drops to `'SHADOW'`
 * whenever flight mode is `'SILENT'` or `'OFF'`.
 *
 * @param {object} [options={}]
 * @returns {'SHADOW' | 'COACH' | 'ENFORCE'}
 */
export function resolveBucketBAlphaStage(options = {}) {
  if (isSilentOrOffFlightMode(options)) return 'SHADOW';
  const raw = String(
    options.bucketBAlphaStage ||
      options.bucketBStage ||
      process.env.CTXTOP_BUCKET_B_ALPHA_MODE ||
      process.env.CTXTOP_BUCKET_B_MODE ||
      options.horizonConfig?.bucketBAlphaMode ||
      options.horizonConfig?.bucketBMode ||
      'COACH'
  )
    .trim()
    .toUpperCase();
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'ENFORCE') return 'ENFORCE';
  return 'COACH';
}

/**
 * Resolves rollout stage for Sub-Wave B-Beta (`#8`, `#3b`, `#19`) — promoted to `'COACH'`
 * by default; drops to `'SHADOW'` whenever flight mode is `'SILENT'` or `'OFF'`.
 *
 * @param {object} [options={}]
 * @returns {'SHADOW' | 'COACH' | 'ENFORCE'}
 */
export function resolveBucketBBetaStage(options = {}) {
  if (isSilentOrOffFlightMode(options)) return 'SHADOW';
  const raw = String(
    options.bucketBBetaStage ||
      options.bucketBStage ||
      process.env.CTXTOP_BUCKET_B_BETA_MODE ||
      process.env.CTXTOP_BUCKET_B_MODE ||
      options.horizonConfig?.bucketBBetaMode ||
      options.horizonConfig?.bucketBMode ||
      'COACH'
  )
    .trim()
    .toUpperCase();
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'ENFORCE') return 'ENFORCE';
  return 'COACH';
}

/**
 * Resolves the active Bucket B rollout stage for Sub-Wave B-Gamma
 * (`'SHADOW'` default -> `0` prompt tokens, `0` blocks). Drops to `'SHADOW'` in `'SILENT'`/`'OFF'` modes.
 *
 * @param {object} [options={}]
 * @returns {'SHADOW' | 'COACH' | 'ENFORCE'}
 */
export function resolveBucketBStage(options = {}) {
  if (isSilentOrOffFlightMode(options)) return 'SHADOW';
  const raw = String(
    options.bucketBStage ||
      process.env.CTXTOP_BUCKET_B_MODE ||
      options.horizonConfig?.bucketBMode ||
      'SHADOW'
  )
    .trim()
    .toUpperCase();
  if (raw === 'COACH') return 'COACH';
  if (raw === 'ENFORCE') return 'ENFORCE';
  return 'SHADOW';
}

/**
 * Loads existing package manifest dependencies, monorepo workspace names, and private `.npmrc` scopes
 * from `cwd` (`< 3ms`, strictly offline and SKU-isolated).
 *
 * @param {string} cwd
 * @returns {{ manifestDeps: Set<string>, workspacePackages: Set<string>, privateScopes: Set<string> }}
 */
export function loadWorkspacePackageAllowlist(cwd) {
  const baseCwd = path.resolve(cwd || process.cwd());
  const manifestDeps = new Set();
  const workspacePackages = new Set();
  const privateScopes = new Set();

  // 1. Root package.json
  const pkgJsonPath = path.join(baseCwd, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.name) {
        workspacePackages.add(String(pkg.name).toLowerCase());
        if (String(pkg.name).startsWith('@')) {
          const slashIdx = String(pkg.name).indexOf('/');
          if (slashIdx > 1) privateScopes.add(String(pkg.name).slice(0, slashIdx).toLowerCase());
        }
      }
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies'
      ]) {
        const map = pkg[field];
        if (map && typeof map === 'object') {
          for (const depName of Object.keys(map)) {
            manifestDeps.add(depName.toLowerCase());
          }
        }
      }
      const wsList = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : Array.isArray(pkg.workspaces?.packages)
          ? pkg.workspaces.packages
          : [];
      for (const wsRel of wsList) {
        const cleanRel = String(wsRel || '').replace(/\/\*+$/, '');
        if (!cleanRel || isBucketBForbiddenSkuPath(cleanRel)) continue;
        const wsPkgPath = path.join(baseCwd, cleanRel, 'package.json');
        if (fs.existsSync(wsPkgPath)) {
          try {
            const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8'));
            if (wsPkg.name) {
              workspacePackages.add(String(wsPkg.name).toLowerCase());
              if (String(wsPkg.name).startsWith('@')) {
                const idx = String(wsPkg.name).indexOf('/');
                if (idx > 1) privateScopes.add(String(wsPkg.name).slice(0, idx).toLowerCase());
              }
            }
          } catch (_err) {
            // Skip unreadable workspace manifest
          }
        }
      }
    } catch (_err) {
      // Skip malformed package.json
    }
  }

  // 2. Project `.npmrc` private scopes (`@corp:registry=https://...`) — never reads auth tokens
  const npmrcPath = path.join(baseCwd, '.npmrc');
  if (fs.existsSync(npmrcPath)) {
    try {
      const lines = fs.readFileSync(npmrcPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.trim().match(/^(@[a-z0-9._-]+):registry\s*=/i);
        if (m) privateScopes.add(m[1].toLowerCase());
      }
    } catch (_err) {
      // Non-fatal
    }
  }

  // 3. Python `requirements.txt` / `pyproject.toml` if present
  const reqPath = path.join(baseCwd, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    try {
      const lines = fs.readFileSync(reqPath, 'utf8').split(/\r?\n/);
      for (const l of lines) {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        const base = trimmed.split(/[=<>~!;\s[]/)[0].trim().toLowerCase().replace(/_/g, '-');
        if (base) manifestDeps.add(base);
      }
    } catch (_err) {
      // Non-fatal
    }
  }

  return { manifestDeps, workspacePackages, privateScopes };
}

/**
 * Walks SKU-allowed source directories (`src`, `hooks`, `bin` by default) to build or refresh
 * `.agents/telemetry/shingle_index.json` for `#8 DUPLICATE_CLONE_DETECTOR`.
 *
 * @param {string} cwd
 * @param {object} [options={}]
 * @param {string[]} [options.scanDirs=['src', 'hooks']]
 * @param {boolean} [options.persist=true]
 */
export function buildOrLoadWorkspaceShingleIndex(cwd, options = {}) {
  const baseCwd = path.resolve(cwd || process.cwd());
  const scanDirs = Array.isArray(options.scanDirs) ? options.scanDirs : ['src', 'hooks'];
  const indexPath = path.join(baseCwd, '.agents', 'telemetry', 'shingle_index.json');

  let cachedFiles = {};
  if (options.useCache !== false) {
    const memCached = MEM_SHINGLE_CACHE.get(baseCwd);
    if (memCached && memCached.files && typeof memCached.files === 'object') {
      cachedFiles = memCached.files;
    } else if (fs.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
          cachedFiles = parsed.files;
        }
      } catch (_err) {
        cachedFiles = {};
      }
    }
  }

  const nextFiles = {};
  const postings = {};

  const addFilePostings = (relNorm, shingles) => {
    for (const sh of shingles) {
      if (!postings[sh.hash]) postings[sh.hash] = [];
      postings[sh.hash].push({ file: relNorm, startLine: sh.startLine });
    }
  };

  const walk = (absDir) => {
    if (!fs.existsSync(absDir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const ent of entries) {
      if (SKIP_WALK_DIRS.has(ent.name)) continue;
      const fullPath = path.join(absDir, ent.name);
      const relNorm = path.relative(baseCwd, fullPath).replace(/\\/g, '/');
      if (isBucketBForbiddenSkuPath(relNorm)) continue;

      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile() && CODE_SCAN_EXT_RE.test(ent.name)) {
        if (options.useCache !== false) {
          let stat;
          try {
            stat = fs.statSync(fullPath);
          } catch (_err) {
            continue;
          }
          const prev = cachedFiles[relNorm];
          if (
            prev &&
            prev.mtimeMs === stat.mtimeMs &&
            prev.size === stat.size &&
            Array.isArray(prev.shingles)
          ) {
            nextFiles[relNorm] = prev;
            addFilePostings(relNorm, prev.shingles);
            continue;
          }
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const shingles = computeFileShingles(content, 5);
            nextFiles[relNorm] = { mtimeMs: stat.mtimeMs, size: stat.size, shingles };
            addFilePostings(relNorm, shingles);
          } catch (_err) {
            // Skip unreadable file
          }
        } else {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const shingles = computeFileShingles(content, 5);
            nextFiles[relNorm] = { mtimeMs: 0, size: content.length, shingles };
            addFilePostings(relNorm, shingles);
          } catch (_err) {
            // Skip unreadable file
          }
        }
      }
    }
  };

  for (const relDir of scanDirs) {
    if (isBucketBForbiddenSkuPath(relDir)) continue;
    walk(path.join(baseCwd, relDir));
  }

  const indexState = {
    version: 1,
    files: nextFiles,
    postings
  };

  if (options.useCache !== false) {
    if (!MEM_SHINGLE_CACHE.has(baseCwd) && MEM_SHINGLE_CACHE.size >= 8) {
      const oldestKey = MEM_SHINGLE_CACHE.keys().next().value;
      if (oldestKey !== undefined) MEM_SHINGLE_CACHE.delete(oldestKey);
    }
    MEM_SHINGLE_CACHE.set(baseCwd, { files: nextFiles, postings });
  }

  if (options.persist !== false) {
    try {
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify({ version: 1, files: nextFiles }), 'utf8');
    } catch (_err) {
      // Non-fatal cache write
    }
  }

  return indexState;
}

/**
 * Parallel libuv file-reader variant of `buildOrLoadWorkspaceShingleIndex` (`< 25ms` cold on Windows NTFS).
 *
 * @param {string} cwd
 * @param {object} [options={}]
 */
export async function buildOrLoadWorkspaceShingleIndexAsync(cwd, options = {}) {
  const baseCwd = path.resolve(cwd || process.cwd());
  const scanDirs = Array.isArray(options.scanDirs) ? options.scanDirs : ['src', 'hooks'];
  const indexPath = path.join(baseCwd, '.agents', 'telemetry', 'shingle_index.json');

  const candidateFiles = [];
  const walk = (absDir) => {
    if (!fs.existsSync(absDir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const ent of entries) {
      if (SKIP_WALK_DIRS.has(ent.name)) continue;
      const fullPath = path.join(absDir, ent.name);
      const relNorm = path.relative(baseCwd, fullPath).replace(/\\/g, '/');
      if (isBucketBForbiddenSkuPath(relNorm)) continue;
      if (ent.isDirectory()) walk(fullPath);
      else if (ent.isFile() && CODE_SCAN_EXT_RE.test(ent.name)) {
        candidateFiles.push({ fullPath, relNorm });
      }
    }
  };

  for (const relDir of scanDirs) {
    if (isBucketBForbiddenSkuPath(relDir)) continue;
    walk(path.join(baseCwd, relDir));
  }

  const contents = await Promise.all(
    candidateFiles.map(async (f) => {
      try {
        const text = await fs.promises.readFile(f.fullPath, 'utf8');
        return { relNorm: f.relNorm, text };
      } catch (_err) {
        return null;
      }
    })
  );

  const nextFiles = {};
  const postings = {};
  for (const item of contents) {
    if (!item) continue;
    const shingles = computeFileShingles(item.text, 5);
    nextFiles[item.relNorm] = { mtimeMs: 0, size: item.text.length, shingles };
    for (const sh of shingles) {
      if (!postings[sh.hash]) postings[sh.hash] = [];
      postings[sh.hash].push({ file: item.relNorm, startLine: sh.startLine });
    }
  }

  if (options.persist === true) {
    try {
      await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.promises.writeFile(indexPath, JSON.stringify({ version: 1, files: nextFiles }), 'utf8');
    } catch (_err) {
      // Non-fatal
    }
  }

  return { version: 1, files: nextFiles, postings };
}

/**
 * Incrementally updates a single file inside an in-memory shingle index in `< 3ms`.
 *
 * @param {{ files: Record<string, any>, postings: Record<string, Array<{ file: string, startLine: number }>> }} indexState
 * @param {string} relPath
 * @param {string} newContent
 */
export function updateFileInShingleIndex(indexState, relPath, newContent = '') {
  const relNorm = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!indexState || !relNorm || isBucketBForbiddenSkuPath(relNorm)) return indexState;

  const prev = indexState.files?.[relNorm];
  if (prev && Array.isArray(prev.shingles)) {
    for (const sh of prev.shingles) {
      const arr = indexState.postings[sh.hash];
      if (Array.isArray(arr)) {
        const filtered = arr.filter((p) => p.file !== relNorm);
        if (filtered.length > 0) indexState.postings[sh.hash] = filtered;
        else delete indexState.postings[sh.hash];
      }
    }
  }

  const shingles = computeFileShingles(newContent, 5);
  indexState.files[relNorm] = {
    mtimeMs: Date.now(),
    size: Buffer.byteLength(newContent, 'utf8'),
    shingles
  };
  for (const sh of shingles) {
    if (!indexState.postings[sh.hash]) indexState.postings[sh.hash] = [];
    indexState.postings[sh.hash].push({ file: relNorm, startLine: sh.startLine });
  }
  return indexState;
}

/**
 * Scans workspace `AGENTS.md` and `CLAUDE.md` files for `#20 PROSE_TO_HOOK_COMPILER` preview candidates
 * (`ctxtop doctor` top-level diagnostic property; `0` live hook mutations).
 *
 * @param {string} cwd
 */
export function auditProseRuleHookCandidates(cwd) {
  const baseCwd = path.resolve(cwd || process.cwd());
  const ruleFiles = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];
  const allCandidates = [];
  const allSkippedConditional = [];

  for (const rel of ruleFiles) {
    const abs = path.join(baseCwd, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const compiled = compileProseRulesToHooks(content, { sourceFile: rel });
      allCandidates.push(...compiled.candidates);
      allSkippedConditional.push(...compiled.skippedConditional);
    } catch (_err) {
      // Non-fatal
    }
  }

  return {
    candidateCount: allCandidates.length,
    skippedConditionalCount: allSkippedConditional.length,
    candidates: allCandidates,
    skippedConditional: allSkippedConditional
  };
}

/**
 * Evaluates applicable Bucket B guardrails on an incoming `PreToolUse` / `pre_invocation` event.
 * Sub-Waves B-Alpha (`#6`, `#4`) & B-Beta (`#8`, `#3b`) run in `'COACH'` mode by default
 * (`'SHADOW'` in `SILENT`/`OFF`); Sub-Wave B-Gamma defaults to `'SHADOW'` (`0` stdout, `.hints.jsonl`).
 *
 * @param {object} params
 * @param {'claude' | 'antigravity'} [params.platform='claude']
 * @param {string} [params.sessionId='default']
 * @param {string} [params.cwd]
 * @param {boolean} [params.hasExplicitCwd]
 * @param {string} [params.toolName='']
 * @param {object} [params.toolInput={}]
 * @param {string} [params.lastUserPrompt='']
 * @param {Array<{ filePath: string, netLines?: number, changedLines?: string[] }>} [params.editsSinceVerify=[]]
 * @param {object} [params.options={}]
 */
export function runBucketBPreToolShadowPass(params = {}) {
  const platform = params.platform === 'antigravity' ? 'antigravity' : 'claude';
  const sessionId = params.sessionId || 'default';
  const hasExplicitCwd = params.hasExplicitCwd !== false && Boolean(params.cwd);
  const baseCwd = hasExplicitCwd ? path.resolve(params.cwd) : process.cwd();
  const alphaStage = resolveBucketBAlphaStage(params.options);
  const betaStage = resolveBucketBBetaStage(params.options);
  const gammaStage = resolveBucketBStage(params.options);
  const toolName = String(params.toolName || '');
  const tIn = params.toolInput || {};
  const recorded = [];
  const activeRecords = [];

  const emit = (guardrailId, verdict, elapsedMs, itemStage = gammaStage) => {
    if (!verdict?.triggered) return;
    if (hasExplicitCwd) {
      recordBucketBShadowHint(
        sessionId,
        {
          guardrailId,
          stage: itemStage,
          platform,
          wouldTrigger: true,
          wouldDecision: verdict.decision || 'warn',
          latencyMs: elapsedMs,
          tokens_saved_est: verdict.tokensSavedEst || 0,
          dollars_saved_est: Number((((verdict.tokensSavedEst || 0) / 1_000_000) * 3.0).toFixed(6)),
          evidence: {
            code: verdict.code || guardrailId,
            reason: String(verdict.reason || '').slice(0, 220)
          }
        },
        { cwd: baseCwd }
      );
    }
    const entry = { guardrailId, stage: itemStage, verdict };
    recorded.push(entry);
    if (itemStage !== 'SHADOW') {
      activeRecords.push(entry);
    }
  };

  // #6 SLOPSQUAT_DEP_GATE (Sub-Wave B-Alpha -> default COACH) on shell install commands
  if (/^(?:Bash|PowerShell|run_command)$/i.test(toolName)) {
    const command = String(tIn.command || tIn.CommandLine || tIn.cmd || '');
    if (/\b(?:npm|pnpm|yarn|bun|pip3?|uv|poetry|cargo)\b/i.test(command)) {
      const t0 = performance.now();
      const allowlist = hasExplicitCwd
        ? loadWorkspacePackageAllowlist(baseCwd)
        : { manifestDeps: new Set(), workspacePackages: new Set(), privateScopes: new Set() };
      const verdict = evaluateSlopsquatCommand({
        command,
        ...allowlist,
        registryMetadata: params.options?.registryMetadata
      });
      emit('#6_SLOPSQUAT_DEP_GATE', verdict, performance.now() - t0, alphaStage);
    }
  }

  // #4 BLAST_RADIUS_BREAKER (B-Alpha -> COACH) & #3b Hardcoded Oracle / #8 Duplicate Clone (B-Beta -> COACH)
  if (
    /^(?:Edit|MultiEdit|Write|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(
      toolName
    )
  ) {
    const filePath = String(
      tIn.file_path || tIn.Path || tIn.path || tIn.TargetFile || tIn.AbsolutePath || ''
    );
    const absTarget = filePath
      ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseCwd, filePath))
      : '';
    const relFromCwd = absTarget ? path.relative(baseCwd, absTarget).replace(/\\/g, '/') : '';
    const relTargetPath =
      relFromCwd && !relFromCwd.startsWith('..') && !path.isAbsolute(relFromCwd)
        ? relFromCwd
        : filePath.replace(/\\/g, '/').replace(/^\.\//, '');

    const addedCode = String(
      tIn.new_string ??
        tIn.Replacement ??
        tIn.ReplacementContent ??
        tIn.content ??
        tIn.Content ??
        tIn.CodeContent ??
        (Array.isArray(tIn.edits)
          ? tIn.edits.map((e) => e?.new_string ?? '').join('\n')
          : Array.isArray(tIn.ReplacementChunks)
            ? tIn.ReplacementChunks.map((c) => c?.ReplacementContent ?? c?.Replacement ?? '').join('\n')
            : '') ??
        ''
    );

    if (filePath) {
      const tBlast = performance.now();
      const changedLines = addedCode.split(/\r?\n/);
      const netLines = changedLines.filter((l) => l.trim().length > 0).length;
      const priorEdits = Array.isArray(params.editsSinceVerify) ? params.editsSinceVerify : [];
      const editsSinceVerify = [...priorEdits, { filePath: relTargetPath || filePath, netLines, changedLines }];
      const blastVerdict = evaluateBlastRadiusBreaker({
        editsSinceVerify,
        lastUserPrompt: params.lastUserPrompt || ''
      });
      if (blastVerdict.triggered) {
        blastVerdict.decision = alphaStage === 'ENFORCE' ? 'ask' : 'warn';
      }
      emit('#4_BLAST_RADIUS_BREAKER', blastVerdict, performance.now() - tBlast, alphaStage);
    }

    if (relTargetPath && addedCode.length >= 60) {
      const t0 = performance.now();
      const verdict = evaluateHardcodedOracle({ filePath: relTargetPath, addedCode });
      if (verdict.triggered) {
        verdict.decision = betaStage === 'ENFORCE' ? 'ask' : 'warn';
      }
      emit('#3B_EVILGENIE_ORACLE', verdict, performance.now() - t0, betaStage);
    }

    if (
      relTargetPath &&
      addedCode.length >= 100 &&
      CODE_SCAN_EXT_RE.test(relTargetPath) &&
      !isBucketBForbiddenSkuPath(relTargetPath) &&
      computeFileShingles(addedCode, 5).length >= 2
    ) {
      const tClone = performance.now();
      const postings =
        params.options?.shingleIndex ||
        (hasExplicitCwd
          ? buildOrLoadWorkspaceShingleIndex(baseCwd, {
              useCache: true,
              persist: params.options?.persistState !== false
            }).postings
          : {});
      const cloneVerdict = detectDuplicateClones({
        targetPath: relTargetPath,
        addedCode,
        shingleIndex: postings
      });
      if (cloneVerdict.triggered) {
        cloneVerdict.decision = betaStage === 'ENFORCE' ? 'ask' : 'warn';
      }
      emit('#8_DUPLICATE_CLONE_DETECTOR', cloneVerdict, performance.now() - tClone, betaStage);
    }
  }

  // #5 SUBAGENT_TEAM_GOVERNOR (Sub-Wave B-Gamma -> default SHADOW) on subagent/task spawns
  if (/^(?:Task|Agent|invoke_subagent|swarm)$/i.test(toolName)) {
    const t0 = performance.now();
    const verdict = evaluateSubagentGovernor({
      typeName: tIn.subagent_type || tIn.TypeName || tIn.name || '',
      role: tIn.description || tIn.Role || '',
      prompt: tIn.prompt || tIn.Prompt || tIn.brief || '',
      model: tIn.model || tIn.Model || 'inherit',
      enableWriteTools: tIn.EnableWriteTools,
      allowedTools: tIn.allowed_tools || tIn.tools,
      workspace: tIn.isolation || tIn.Workspace || tIn.workspace || 'inherit'
    });
    emit('#5_SUBAGENT_TEAM_GOVERNOR', verdict, performance.now() - t0, gammaStage);
  }

  // #16 MCP_CLI_ROUTER (Sub-Wave B-Gamma -> default SHADOW) on heavy MCP read tools
  if (/^mcp__/i.test(toolName)) {
    const t0 = performance.now();
    const verdict = evaluateMcpCliRouter({
      toolName,
      cliCapabilities: params.options?.cliCapabilities || {}
    });
    emit('#16_MCP_CLI_ROUTER', verdict, performance.now() - t0, gammaStage);
  }

  // Expose other runtime-callable evaluators for PostToolUse / UserPromptSubmit / tests
  return {
    stage: gammaStage,
    alphaStage,
    betaStage,
    shadowOnly: alphaStage === 'SHADOW' && betaStage === 'SHADOW' && gammaStage === 'SHADOW',
    triggered: activeRecords.length > 0,
    activeRecords,
    recorded,
    evaluators: {
      evaluateGrepGlobFirewall,
      distillHtmlWebPayload,
      evaluateBlastRadiusBreaker,
      detectDuplicateClones,
      evaluateOverengineeringDiffGate,
      evaluateVaguePromptAnchor,
      evaluateLspSymbolRouter
    }
  };
}

function parseSearchOutputPath(line = '') {
  const trimmed = String(line || '').replace(/\r$/, '').trim();
  if (!trimmed || trimmed === '--' || /^Found\s+\d+\s+(?:results?|files?|matches?)/i.test(trimmed)) {
    return null;
  }
  // Match `dir/file.ext:12:snippet` or `C:\dir\file.ext:12-snippet`
  const lineNumMatch = trimmed.match(
    /^((?:[A-Za-z]:[\\/])?[^:\s][^:]*?\.[A-Za-z0-9]{1,8}):\d+(?:[:\-]|$)/
  );
  if (lineNumMatch) return lineNumMatch[1];

  // Match `dir/file.ext: snippet`
  const colonSnippetMatch = trimmed.match(
    /^((?:[A-Za-z]:[\\/])?[^:\s][^:]*?(?:[\\/][^:\s]+|\.[A-Za-z0-9]{1,8})):\s/
  );
  if (colonSnippetMatch) return colonSnippetMatch[1];

  // Plain file path per line (requires `/` or `\` or extension, and no internal whitespace)
  if (!/\s/.test(trimmed) && (/[\\/]/.test(trimmed) || /\.[A-Za-z0-9]{1,8}$/.test(trimmed))) {
    return trimmed;
  }
  return null;
}

/**
 * Evaluates Sub-Wave B-Alpha `PostToolUse` / `post_invocation` guardrails:
 *   - `#9 WEB_BOILERPLATE_BUDGETER` (lossless HTML `<pre>`/`<code>`/`<table>` distillation)
 *   - `#2 GREP_GLOB_FIREWALL` (active-context Top-K ranking for `>15` matched search files)
 *
 * Runs in `'COACH'` mode by default (`'SHADOW'` in `SILENT`/`OFF` modes) and records
 * `.hints.jsonl` telemetry when `hasExplicitCwd` is true.
 *
 * @param {object} [params={}]
 */
export function runBucketBPostToolPass(params = {}) {
  const platform = params.platform === 'antigravity' ? 'antigravity' : 'claude';
  const sessionId = params.sessionId || 'default';
  const hasExplicitCwd = Boolean(params.hasExplicitCwd && params.cwd);
  const baseCwd = hasExplicitCwd ? path.resolve(params.cwd) : process.cwd();
  const alphaStage = resolveBucketBAlphaStage(params.options);
  const toolName = String(params.toolName || '');
  const tIn = params.toolInput || {};
  const rawOutput = typeof params.rawOutput === 'string' ? params.rawOutput : String(params.rawOutput ?? '');

  // 1. #9 WEB_BOILERPLATE_BUDGETER
  if (
    /^(?:WebFetch|read_url_content|mcp__(?:fetch|firecrawl|playwright|puppeteer|browser).*)$/i.test(
      toolName
    ) &&
    rawOutput.length >= 1200 &&
    /<(?:html|body|div|table|script|style|nav|header|footer|article|main|section|pre|code)\b/i.test(
      rawOutput
    )
  ) {
    const t0 = performance.now();
    const verdict = distillHtmlWebPayload({
      html: rawOutput,
      webFetchesInTurn: Number(params.webFetchesInTurn) || 1
    });
    const elapsedMs = performance.now() - t0;
    if (verdict.triggered) {
      if (hasExplicitCwd) {
        recordBucketBShadowHint(
          sessionId,
          {
            guardrailId: '#9_WEB_BOILERPLATE_BUDGETER',
            stage: alphaStage,
            platform,
            wouldTrigger: true,
            wouldDecision: 'warn',
            latencyMs: elapsedMs,
            tokens_saved_est: verdict.tokensSavedEst || 0,
            dollars_saved_est: Number((((verdict.tokensSavedEst || 0) / 1_000_000) * 3.0).toFixed(6)),
            evidence: {
              code: verdict.code || 'WEB_BOILERPLATE_BUDGETER',
              reason: String(verdict.reason || '').slice(0, 220)
            }
          },
          { cwd: baseCwd }
        );
      }
      if (alphaStage !== 'SHADOW') {
        return {
          triggered: true,
          stage: alphaStage,
          guardrailId: '#9_WEB_BOILERPLATE_BUDGETER',
          code: verdict.code || 'WEB_BOILERPLATE_BUDGETER',
          updatedOutput: `${verdict.reason}\n\n${verdict.distilled}`,
          savedTokens: verdict.tokensSavedEst || 0,
          reason: verdict.reason
        };
      }
    }
  }

  // 2. #2 GREP_GLOB_FIREWALL
  if (/^(?:Grep|Glob|grep_search|find_by_name)$/i.test(toolName) && rawOutput) {
    const t0 = performance.now();
    const lines = rawOutput.split(/\r?\n/);
    const linesByPath = new Map();
    const matchPaths = [];

    for (const rawLine of lines) {
      const candidate = parseSearchOutputPath(rawLine);
      if (!candidate) continue;
      const norm = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!norm || isBucketBForbiddenSkuPath(norm)) continue;
      if (!linesByPath.has(norm)) {
        linesByPath.set(norm, []);
        matchPaths.push(norm);
      }
      linesByPath.get(norm).push(rawLine.replace(/\r$/, ''));
    }

    if (matchPaths.length > 15) {
      const query = String(tIn.pattern || tIn.Query || tIn.Pattern || '');
      const verdict = evaluateGrepGlobFirewall({
        matchPaths,
        query,
        lastUserPrompt: params.lastUserPrompt || '',
        activeFiles: params.activeFiles || [],
        dirtyFiles: params.dirtyFiles || [],
        lastEditedFile: params.lastEditedFile || ''
      });
      const elapsedMs = performance.now() - t0;

      if (verdict.triggered) {
        if (hasExplicitCwd) {
          recordBucketBShadowHint(
            sessionId,
            {
              guardrailId: '#2_GREP_GLOB_FIREWALL',
              stage: alphaStage,
              platform,
              wouldTrigger: true,
              wouldDecision: 'warn',
              latencyMs: elapsedMs,
              tokens_saved_est: verdict.tokensSavedEst || 0,
              dollars_saved_est: Number((((verdict.tokensSavedEst || 0) / 1_000_000) * 3.0).toFixed(6)),
              evidence: {
                code: verdict.code || 'GREP_GLOB_FIREWALL',
                reason: String(verdict.reason || '').slice(0, 220)
              }
            },
            { cwd: baseCwd }
          );
        }
        if (alphaStage !== 'SHADOW') {
          const topBlocks = [];
          for (const p of verdict.topPaths) {
            const matchedLines = linesByPath.get(p) || [p];
            topBlocks.push(...matchedLines.slice(0, 4));
          }
          return {
            triggered: true,
            stage: alphaStage,
            guardrailId: '#2_GREP_GLOB_FIREWALL',
            code: verdict.code || 'GREP_GLOB_FIREWALL',
            updatedOutput: `${verdict.reason}\n${topBlocks.join('\n')}`,
            savedTokens: verdict.tokensSavedEst || 0,
            reason: verdict.reason,
            topPaths: verdict.topPaths,
            omittedCount: verdict.omittedCount
          };
        }
      }
    }
  }

  return {
    triggered: false,
    stage: alphaStage,
    updatedOutput: rawOutput,
    savedTokens: 0
  };
}

/**
 * Evaluates Sub-Wave B-Beta `Stop` / `post_invocation` guardrail (`#19 OVERENGINEERING_DIFF_GATE`).
 * Runs in `'COACH'` mode by default (`'SHADOW'` in `SILENT`/`OFF` modes) and records
 * `.hints.jsonl` telemetry when `hasExplicitCwd` is true.
 *
 * @param {object} [params={}]
 */
export function runBucketBStopPass(params = {}) {
  const platform = params.platform === 'antigravity' ? 'antigravity' : 'claude';
  const sessionId = params.sessionId || 'default';
  const hasExplicitCwd = Boolean(params.hasExplicitCwd && params.cwd);
  const baseCwd = hasExplicitCwd ? path.resolve(params.cwd) : process.cwd();
  const betaStage = resolveBucketBBetaStage(params.options);
  const fileDiffs = Array.isArray(params.fileDiffs) ? params.fileDiffs : [];
  if (fileDiffs.length === 0) {
    return { triggered: false, stage: betaStage, savedTokens: 0 };
  }

  const t0 = performance.now();
  const verdict = evaluateOverengineeringDiffGate({
    fileDiffs,
    lastUserPrompt: String(params.lastUserPrompt || '')
  });
  const elapsedMs = performance.now() - t0;

  if (!verdict.triggered) {
    return { triggered: false, stage: betaStage, savedTokens: 0 };
  }

  const decision = betaStage === 'ENFORCE' ? 'block' : 'warn';
  if (hasExplicitCwd) {
    recordBucketBShadowHint(
      sessionId,
      {
        guardrailId: '#19_OVERENGINEERING_DIFF_GATE',
        stage: betaStage,
        platform,
        wouldTrigger: true,
        wouldDecision: decision,
        latencyMs: elapsedMs,
        tokens_saved_est: verdict.tokensSavedEst || 0,
        dollars_saved_est: Number((((verdict.tokensSavedEst || 0) / 1_000_000) * 3.0).toFixed(6)),
        evidence: {
          code: verdict.code || 'OVERENGINEERING_DIFF_GATE',
          reason: String(verdict.reason || '').slice(0, 220)
        }
      },
      { cwd: baseCwd }
    );
  }

  if (betaStage === 'SHADOW') {
    return {
      triggered: false,
      stage: betaStage,
      shadowed: true,
      savedTokens: 0
    };
  }

  return {
    triggered: true,
    stage: betaStage,
    decision,
    guardrailId: '#19_OVERENGINEERING_DIFF_GATE',
    code: verdict.code || 'OVERENGINEERING_DIFF_GATE',
    reason: verdict.reason,
    savedTokens: verdict.tokensSavedEst || 0,
    nonTestAddedLines: verdict.nonTestAddedLines,
    testAddedLines: verdict.testAddedLines,
    unusedExportedAbstractions: verdict.unusedExportedAbstractions
  };
}
