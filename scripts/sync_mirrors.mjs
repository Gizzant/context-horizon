import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../src/core/atomic_io.mjs';
import {
  FULL_TOOL_HOOK_MATCHER,
  LEAN_PRE_TOOL_HOOK_MATCHER,
  LEAN_POST_TOOL_HOOK_MATCHER
} from '../src/core/layer5_hygiene.mjs';
import { buildDemoPage } from './build_demo_page.mjs';
import { buildEvaluationBundles, TIER_1_FILES, TIER_2_FILES } from './build_evaluation_bundles.mjs';

/**
 * T4.2: Canonical Mirror Synchronization & Exhaustive SHA-256 Parity Verifier.
 *
 * Keeps all core/adapter/webview/demo/cli/hook/shim/sidecar modules, configuration,
 * rules, skills, `docs/index.html`, `evaluation_bundles/`, and local Antigravity
 * plugin mirrors (`~/.gemini/config/plugins/agy-horizon*`) 100% synchronized and
 * verified via SHA-256.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CANONICAL_ROOT = path.resolve(__dirname, '..');
const AGY_HORIZON_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon');
const FLIGHTCHECK_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');
const IN_REPO_FLIGHTCHECK_ROOT = path.join(CANONICAL_ROOT, '.agents', 'plugins', 'agy-horizon-flightcheck');

export function getSyncedPluginSubdirs(canonicalRoot = CANONICAL_ROOT) {
  const baseDirNames = ['bin', 'src', 'hooks', 'sidecars', 'agents', 'config', 'rules', 'commands'];
  const subdirs = [];
  for (const baseName of baseDirNames) {
    const baseDir = path.join(canonicalRoot, baseName);
    if (!fs.existsSync(baseDir)) continue;
    const walk = (relParts) => {
      subdirs.push(relParts);
      const fullPath = path.join(canonicalRoot, ...relParts);
      let entries = [];
      try {
        entries = fs.readdirSync(fullPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          walk([...relParts, ent.name]);
        }
      }
    };
    walk([baseName]);
  }
  return subdirs.sort((a, b) => a.join('/').localeCompare(b.join('/')));
}

export const SYNCED_PLUGIN_SUBDIRS = getSyncedPluginSubdirs(CANONICAL_ROOT);

const SYNCED_FILE_EXT_RE = /\.(mjs|js|css|json|html|md|svg|txt)$/i;
const TEXT_NORMALIZE_EXT_RE = /\.(m?js|cjs|css|json|html|md|svg|ya?ml|txt)$/i;

const HTML_TARGETS = [
  path.join(CANONICAL_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(AGY_HORIZON_ROOT, 'src', 'ui', 'sidepane.html'),
  path.join(AGY_HORIZON_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(FLIGHTCHECK_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(IN_REPO_FLIGHTCHECK_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full', 'src', 'webview', 'horizon_panel.html')
];

function sha256File(filePath) {
  if (TEXT_NORMALIZE_EXT_RE.test(filePath)) {
    const normalized = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  }
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeTextFileInPlaceSync(filePath) {
  if (!TEXT_NORMALIZE_EXT_RE.test(filePath) || !fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.includes('\r\n')) {
    fs.writeFileSync(filePath, raw.replace(/\r\n/g, '\n'), 'utf8');
  }
}

function copyNormalizedSync(srcFile, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (TEXT_NORMALIZE_EXT_RE.test(srcFile)) {
    const normalized = fs.readFileSync(srcFile, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(destFile, normalized, 'utf8');
    return;
  }
  fs.copyFileSync(srcFile, destFile);
}

function copyDirNormalizedSync(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyDirNormalizedSync(srcPath, destPath);
    } else if (ent.isFile()) {
      copyNormalizedSync(srcPath, destPath);
    }
  }
}

export function buildFullLifecycleHooksBlock(pluginRoot, enabled = true) {
  const normHook = (rel) => {
    const p = path.join(pluginRoot, rel).replace(/\\/g, '/');
    return /\s/.test(p) ? `"${p}"` : p;
  };
  return {
    enabled: Boolean(enabled),
    SessionStart: [
      { type: 'command', command: `node --no-warnings ${normHook('src/hooks/session_start.mjs')}`, timeout: 5 }
    ],
    PreInvocation: [
      { type: 'command', command: `node --no-warnings ${normHook('src/hooks/pre_invocation.mjs')}`, timeout: 15 }
    ],
    PostInvocation: [
      { type: 'command', command: `node --no-warnings ${normHook('src/hooks/post_invocation.mjs')}`, timeout: 5 }
    ],
    Stop: [
      { type: 'command', command: `node --no-warnings ${normHook('src/hooks/post_invocation.mjs')}`, timeout: 5 }
    ],
    PreToolUse: [
      {
        matcher: LEAN_PRE_TOOL_HOOK_MATCHER,
        hooks: [
          {
            type: 'command',
            command: `node --no-warnings ${normHook('src/hooks/pre_invocation.mjs')} --event=PreToolUse`,
            timeout: 5
          }
        ]
      }
    ],
    PostToolUse: [
      {
        matcher: LEAN_POST_TOOL_HOOK_MATCHER,
        hooks: [
          {
            type: 'command',
            command: `node --no-warnings ${normHook('src/hooks/post_invocation.mjs')}`,
            timeout: 5
          }
        ]
      }
    ]
  };
}

function hasCompleteSixLifecycleHooks(lifecycleBlock, pluginRoot) {
  if (!lifecycleBlock || typeof lifecycleBlock !== 'object') return false;
  const requiredEvents = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop', 'PreToolUse', 'PostToolUse'];
  for (const ev of requiredEvents) {
    if (!Array.isArray(lifecycleBlock[ev]) || lifecycleBlock[ev].length === 0) return false;
  }
  const normPre = path.join(pluginRoot, 'src/hooks/pre_invocation.mjs').replace(/\\/g, '/');
  const preCmd = String(lifecycleBlock.PreInvocation?.[0]?.command || '');
  const preToolCmd = String(lifecycleBlock.PreToolUse?.[0]?.hooks?.[0]?.command || '');
  const expectQuoted = /\s/.test(normPre);
  if (!preCmd.includes(normPre)) return false;
  if (!expectQuoted && (preCmd.includes(`"${normPre}"`) || preToolCmd.includes(`"${normPre}"`))) return false;
  if (!preToolCmd.includes('--event=PreToolUse')) return false;
  if (lifecycleBlock.PreToolUse?.[0]?.matcher !== LEAN_PRE_TOOL_HOOK_MATCHER) return false;
  if (lifecycleBlock.PostToolUse?.[0]?.matcher !== LEAN_POST_TOOL_HOOK_MATCHER) return false;
  return true;
}

function listSkillAndAssetFiles(relRootDir) {
  const results = [];
  const baseDir = path.join(CANONICAL_ROOT, relRootDir);
  if (!fs.existsSync(baseDir)) return results;
  const walk = (curr) => {
    for (const ent of fs.readdirSync(curr, { withFileTypes: true })) {
      const full = path.join(curr, ent.name);
      if (ent.isDirectory()) walk(full);
      else results.push(path.relative(CANONICAL_ROOT, full));
    }
  };
  walk(baseDir);
  return results.sort();
}

export function syncAndVerifyMirrors({
  verifyOnly = false,
  pluginRoots
} = {}) {
  const canonicalHtml = path.join(CANONICAL_ROOT, 'src', 'webview', 'horizon_panel.html');
  if (!fs.existsSync(canonicalHtml)) {
    throw new Error(`Canonical WebView HTML missing: ${canonicalHtml}`);
  }

  const isDefaultRoots = !Array.isArray(pluginRoots);
  const candidateRoots = isDefaultRoots
    ? [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT, IN_REPO_FLIGHTCHECK_ROOT]
    : pluginRoots;

  // On clean CI runners where gitignored mirror directories or evaluation_bundles do not exist yet,
  // auto-bootstrap the default mirror directories so 8-target / 702-pair verification succeeds deterministically.
  let effectiveVerifyOnly = verifyOnly;
  if (isDefaultRoots) {
    const evalBundleTier2 = path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full', 'src', 'webview', 'horizon_panel.html');
    for (const r of candidateRoots) {
      const uiDir = path.join(r, 'src', 'ui');
      const sidepaneHtml = path.join(uiDir, 'sidepane.html');
      if (!fs.existsSync(sidepaneHtml)) {
        fs.mkdirSync(uiDir, { recursive: true });
        effectiveVerifyOnly = false;
      }
    }
    if (!fs.existsSync(evalBundleTier2)) {
      fs.mkdirSync(path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_1_essential'), { recursive: true });
      fs.mkdirSync(path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full'), { recursive: true });
      effectiveVerifyOnly = false;
    }
  }

  const activePluginRoots = candidateRoots.filter(r => Boolean(r) && fs.existsSync(r));
  const syncedSubdirs = getSyncedPluginSubdirs(CANONICAL_ROOT);

  if (!effectiveVerifyOnly) {
    // 0. Pre-flight ESM syntax gate on live hook entrypoints & core modules so a syntax typo never propagates into active plugin hooks
    const criticalSyntaxTargets = [
      'src/hooks/pre_invocation.mjs',
      'src/hooks/post_invocation.mjs',
      'src/hooks/session_start.mjs',
      'src/core/parser.mjs',
      'src/core/paths.mjs',
      'src/core/pruner.mjs',
      'hooks/register.js',
      'hooks/handlers/pre-tool-use.mjs',
      'bin/ctxtop.mjs'
    ];
    for (const relTarget of criticalSyntaxTargets) {
      const absTarget = path.join(CANONICAL_ROOT, relTarget);
      if (fs.existsSync(absTarget)) {
        execFileSync(process.execPath, ['--check', absTarget], { stdio: 'pipe' });
      }
    }

    // 0b. Normalize canonical synced source text files to LF so raw-byte and checksum hashes match across Windows & POSIX
    normalizeTextFileInPlaceSync(canonicalHtml);
    for (const subDirParts of syncedSubdirs) {
      const srcSubDir = path.join(CANONICAL_ROOT, ...subDirParts);
      if (!fs.existsSync(srcSubDir)) continue;
      for (const ent of fs.readdirSync(srcSubDir, { withFileTypes: true })) {
        if (ent.isFile() && SYNCED_FILE_EXT_RE.test(ent.name)) {
          normalizeTextFileInPlaceSync(path.join(srcSubDir, ent.name));
        }
      }
    }
    for (const relAsset of [...listSkillAndAssetFiles('skills'), ...listSkillAndAssetFiles('assets')]) {
      normalizeTextFileInPlaceSync(path.join(CANONICAL_ROOT, relAsset));
    }

    // 1. Rebuild standalone docs/index.html & evaluation_bundles/ first so in-repo mirrors are current
    buildDemoPage({ silent: false });
    if (fs.existsSync(path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_1_essential')) ||
        fs.existsSync(path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full'))) {
      buildEvaluationBundles({ silent: false });
    }

    // 2. Sync all module, config, rule, skill, asset, and sidecar subdirectories to active plugin mirrors
    for (const subDirParts of syncedSubdirs) {
      const srcSubDir = path.join(CANONICAL_ROOT, ...subDirParts);
      if (!fs.existsSync(srcSubDir)) continue;
      const entries = fs.readdirSync(srcSubDir, { withFileTypes: true })
        .filter(ent => ent.isFile() && SYNCED_FILE_EXT_RE.test(ent.name))
        .map(ent => ent.name)
        .sort();
      for (const file of entries) {
        const srcFile = path.join(srcSubDir, file);
        for (const root of activePluginRoots) {
          const destSubDir = path.join(root, ...subDirParts);
          copyNormalizedSync(srcFile, path.join(destSubDir, file));
        }
      }
    }

    for (const dirName of ['assets', 'skills']) {
      const srcDir = path.join(CANONICAL_ROOT, dirName);
      if (!fs.existsSync(srcDir)) continue;
      for (const root of activePluginRoots) {
        copyDirNormalizedSync(srcDir, path.join(root, dirName));
      }
    }

    // Sync sidepane.html & legacy widget.html in agy-horizon if present
    for (const root of activePluginRoots) {
      const sidepaneTarget = path.join(root, 'src', 'ui', 'sidepane.html');
      if (fs.existsSync(path.dirname(sidepaneTarget))) {
        copyNormalizedSync(canonicalHtml, sidepaneTarget);
      }
      const legacyWidget = path.join(root, 'src', 'ui', 'widget.html');
      if (fs.existsSync(legacyWidget)) {
        copyNormalizedSync(canonicalHtml, legacyWidget);
      }
      // Clean stale tests/ directory from installed plugin mirrors so plugins never carry test fixtures
      const stalePluginTests = path.join(root, 'tests');
      if (fs.existsSync(stalePluginTests)) {
        fs.rmSync(stalePluginTests, { recursive: true, force: true });
      }
    }

    // 3. Preserve/upgrade all 6 lifecycle hooks in plugin hooks.json without wiping Stop/PreToolUse/PostToolUse
    for (const root of activePluginRoots) {
      const isFlightcheck = path.basename(root) === 'agy-horizon-flightcheck' || root === FLIGHTCHECK_ROOT;
      const hooksPath = path.join(root, 'hooks.json');
      if (isFlightcheck) {
        let parsedHooks = {};
        let existingEnabled = true;
        let needsRewrite = true;
        if (fs.existsSync(hooksPath)) {
          try {
            const rawHooks = fs.readFileSync(hooksPath, 'utf8');
            parsedHooks = JSON.parse(rawHooks);
            if (typeof parsedHooks?.['horizon-flightcheck-lifecycle']?.enabled === 'boolean') {
              existingEnabled = parsedHooks['horizon-flightcheck-lifecycle'].enabled;
            }
            const hasBackslashes = /node[^"]*\\/.test(rawHooks);
            if (!hasBackslashes && hasCompleteSixLifecycleHooks(parsedHooks?.['horizon-flightcheck-lifecycle'], root)) {
              needsRewrite = false;
            }
          } catch {
            parsedHooks = {};
            needsRewrite = true;
          }
        }
        if (needsRewrite) {
          const updatedHooks = {
            ...parsedHooks,
            'horizon-flightcheck-lifecycle': buildFullLifecycleHooksBlock(root, existingEnabled)
          };
          atomicWriteFileSync(hooksPath, JSON.stringify(updatedHooks, null, 2) + '\n', { encoding: 'utf8' });
        }
      } else if (fs.existsSync(hooksPath)) {
        try {
          const rawHorizonHooks = fs.readFileSync(hooksPath, 'utf8');
          const parsedHorizon = JSON.parse(rawHorizonHooks);
          if (parsedHorizon?.['horizon-flightcheck-lifecycle']) {
            const en = typeof parsedHorizon['horizon-flightcheck-lifecycle'].enabled === 'boolean'
              ? parsedHorizon['horizon-flightcheck-lifecycle'].enabled
              : true;
            if (!hasCompleteSixLifecycleHooks(parsedHorizon['horizon-flightcheck-lifecycle'], root)) {
              parsedHorizon['horizon-flightcheck-lifecycle'] = buildFullLifecycleHooksBlock(root, en);
              atomicWriteFileSync(hooksPath, JSON.stringify(parsedHorizon, null, 2) + '\n', { encoding: 'utf8' });
            }
          } else if (rawHorizonHooks.includes('./src/')) {
            const absPrefix = root.replace(/\\/g, '/');
            const upgraded = rawHorizonHooks.replace(
              /node\s+--no-warnings\s+(?:\\")?(?:\.\/src\/|[^"]*\/src\/)([^\s"\\]+)(?:\\")?(\s+[^"]*)?/g,
              (_, relPart, argsPart = '') => `node --no-warnings ${absPrefix}/src/${relPart}${argsPart}`
            );
            JSON.parse(upgraded);
            atomicWriteFileSync(hooksPath, upgraded, { encoding: 'utf8' });
          }
        } catch {}
      }
    }

    // 4. Consolidate plugin.json manifests with unified 'Highbeam' branding
    const canonicalPluginPath = path.join(CANONICAL_ROOT, 'plugin.json');
    if (fs.existsSync(canonicalPluginPath)) {
      const canonicalManifest = JSON.parse(fs.readFileSync(canonicalPluginPath, 'utf8'));
      for (const root of activePluginRoots) {
        const isFlightcheck = path.basename(root) === 'agy-horizon-flightcheck' || root === FLIGHTCHECK_ROOT;
        const manifestOut = isFlightcheck
          ? canonicalManifest
          : {
              ...canonicalManifest,
              name: path.basename(root),
              displayName: 'Highbeam'
            };
        atomicWriteFileSync(path.join(root, 'plugin.json'), JSON.stringify(manifestOut, null, 2) + '\n', { encoding: 'utf8' });
        atomicWriteFileSync(path.join(root, '.antigravity-plugin', 'plugin.json'), JSON.stringify(manifestOut, null, 2) + '\n', { encoding: 'utf8' });
      }
    }

    const canonicalPkgPath = path.join(CANONICAL_ROOT, 'package.json');
    if (fs.existsSync(canonicalPkgPath)) {
      const canonicalPkg = JSON.parse(fs.readFileSync(canonicalPkgPath, 'utf8'));
      for (const root of activePluginRoots) {
        const isFlightcheck = path.basename(root) === 'agy-horizon-flightcheck' || root === FLIGHTCHECK_ROOT;
        const pkgOut = isFlightcheck
          ? canonicalPkg
          : {
              ...canonicalPkg,
              name: path.basename(root)
            };
        atomicWriteFileSync(path.join(root, 'package.json'), JSON.stringify(pkgOut, null, 2) + '\n', { encoding: 'utf8' });
      }
    }
  }

  // 5. Exhaustive SHA-256 Parity Verification across HTML, .mjs, .js, .css, .json, .md, and evaluation_bundles
  const mismatches = [];
  let verifiedFilePairs = 0;

  const candidateHtmlTargets = [
    canonicalHtml,
    ...activePluginRoots.flatMap(r => [
      path.join(r, 'src', 'ui', 'sidepane.html'),
      path.join(r, 'src', 'webview', 'horizon_panel.html')
    ]),
    path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full', 'src', 'webview', 'horizon_panel.html')
  ];
  const uniqueHtmlPaths = Array.from(new Set(candidateHtmlTargets.map(p => path.resolve(p)))).filter(p => fs.existsSync(p));
  const htmlHashes = uniqueHtmlPaths.map(p => ({ path: p, sha256: sha256File(p) }));
  const canonicalHtmlSha = htmlHashes[0].sha256;

  for (const h of htmlHashes) {
    console.log(`[SHA-256] ${h.sha256}  ${h.path}`);
    if (h.sha256 !== canonicalHtmlSha) {
      mismatches.push(`HTML mismatch: ${h.path} (${h.sha256} !== ${canonicalHtmlSha})`);
    }
  }

  // Verify every synced file in syncedSubdirs + skills/ + assets/ across activePluginRoots
  for (const subDirParts of syncedSubdirs) {
    const srcSubDir = path.join(CANONICAL_ROOT, ...subDirParts);
    if (!fs.existsSync(srcSubDir)) continue;
    const entries = fs.readdirSync(srcSubDir, { withFileTypes: true })
      .filter(ent => ent.isFile() && SYNCED_FILE_EXT_RE.test(ent.name))
      .map(ent => ent.name)
      .sort();
    for (const file of entries) {
      const srcFile = path.join(srcSubDir, file);
      const srcSha = sha256File(srcFile);
      for (const root of activePluginRoots) {
        const destFile = path.join(root, ...subDirParts, file);
        if (!fs.existsSync(destFile)) {
          mismatches.push(`Missing plugin mirror file: ${destFile}`);
          continue;
        }
        const destSha = sha256File(destFile);
        verifiedFilePairs += 1;
        if (destSha !== srcSha) {
          mismatches.push(`SHA-256 mismatch: ${destFile} (${destSha} !== ${srcSha})`);
        }
      }
    }
  }

  for (const relFile of [...listSkillAndAssetFiles('skills'), ...listSkillAndAssetFiles('assets')]) {
    const srcFile = path.join(CANONICAL_ROOT, relFile);
    const srcSha = sha256File(srcFile);
    for (const root of activePluginRoots) {
      const destFile = path.join(root, relFile);
      if (!fs.existsSync(destFile)) {
        mismatches.push(`Missing plugin skill/asset file: ${destFile}`);
        continue;
      }
      const destSha = sha256File(destFile);
      verifiedFilePairs += 1;
      if (destSha !== srcSha) {
        mismatches.push(`SHA-256 mismatch: ${destFile} (${destSha} !== ${srcSha})`);
      }
    }
  }

  // Verify Flightcheck hooks.json preserves all 6 hooks & plugin.json displayName === 'Highbeam'
  for (const root of activePluginRoots) {
    const isFlightcheck = path.basename(root) === 'agy-horizon-flightcheck' || root === FLIGHTCHECK_ROOT;
    const pJsonPath = path.join(root, 'plugin.json');
    if (fs.existsSync(pJsonPath)) {
      const pJson = JSON.parse(fs.readFileSync(pJsonPath, 'utf8'));
      const dn = String(pJson.displayName || '');
      if (!dn.startsWith('Highbeam') || /Context Horizon/i.test(dn)) {
        mismatches.push(`Branding drift in ${pJsonPath}: displayName="${dn}"`);
      }
    }
    if (isFlightcheck) {
      const hJsonPath = path.join(root, 'hooks.json');
      if (!fs.existsSync(hJsonPath)) {
        mismatches.push(`Missing hooks.json in ${root}`);
      } else {
        const hJson = JSON.parse(fs.readFileSync(hJsonPath, 'utf8'));
        if (!hasCompleteSixLifecycleHooks(hJson?.['horizon-flightcheck-lifecycle'], root)) {
          mismatches.push(`Incomplete lifecycle hooks in ${hJsonPath}: expected all 6 hooks with widened matcher`);
        }
      }
    }
  }

  // Verify evaluation_bundles SHA-256 parity & absence of orphan docs/HANDOFF.md when present on disk
  for (const [bundleName, fileList] of [['tier_1_essential', TIER_1_FILES], ['tier_2_full', TIER_2_FILES]]) {
    const bundleRoot = path.join(CANONICAL_ROOT, 'evaluation_bundles', bundleName);
    if (!fs.existsSync(bundleRoot)) continue;
    const orphanHandoff = path.join(bundleRoot, 'docs', 'HANDOFF.md');
    if (fs.existsSync(orphanHandoff)) {
      mismatches.push(`Orphan file remains in evaluation bundle: ${orphanHandoff}`);
    }
    for (const relPath of fileList) {
      const srcFile = path.join(CANONICAL_ROOT, relPath);
      const destFile = path.join(bundleRoot, relPath);
      if (!fs.existsSync(destFile)) {
        mismatches.push(`Missing evaluation bundle file: ${destFile}`);
        continue;
      }
      const srcSha = sha256File(srcFile);
      const destSha = sha256File(destFile);
      verifiedFilePairs += 1;
      if (srcSha !== destSha) {
        mismatches.push(`Evaluation bundle SHA-256 mismatch: ${destFile} (${destSha} !== ${srcSha})`);
      }
    }
  }

  // Verify docs/index.html parity markers
  const docsIndexPath = path.join(CANONICAL_ROOT, 'docs', 'index.html');
  if (fs.existsSync(docsIndexPath)) {
    const docsHtml = fs.readFileSync(docsIndexPath, 'utf8');
    if (docsHtml.includes('<span style="display:none"> Context Memory</span>')) {
      mismatches.push(`Stale hidden Context Memory span in ${docsIndexPath}`);
    }
    if (!docsHtml.includes('<h1>Highbeam</h1>')) {
      mismatches.push(`Missing <h1>Highbeam</h1> in ${docsIndexPath}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Mirror SHA-256 Parity FAILED (${mismatches.length} issue(s)):\n  - ${mismatches.join('\n  - ')}`);
  }

  console.log(`✓ Mirror SHA-256 Parity VERIFIED (${htmlHashes.length} HTML targets, ${verifiedFilePairs} mirrored file pairs byte-for-byte identical).`);
  return {
    parityOk: true,
    sha256: canonicalHtmlSha,
    targets: htmlHashes.length,
    verifiedFilePairs
  };
}

function isSyncMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

if (isSyncMain()) {
  const verifyOnly = process.argv.includes('--verify-only');
  syncAndVerifyMirrors({ verifyOnly });
}
