import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../src/core/atomic_io.mjs';
import { FULL_TOOL_HOOK_MATCHER } from '../src/core/layer5_hygiene.mjs';
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

export const SYNCED_PLUGIN_SUBDIRS = [
  ['src', 'core'],
  ['src', 'core', 'telemetry'],
  ['src', 'core', 'coach'],
  ['src', 'adapters'],
  ['src', 'adapters', 'antigravity'],
  ['src', 'adapters', 'claude-code'],
  ['src', 'webview'],
  ['src', 'demo'],
  ['src', 'shims'],
  ['src', 'ui'],
  ['src', 'hooks'],
  ['src', 'cli'],
  ['sidecars', 'horizon-daemon'],
  ['config'],
  ['rules']
];

const SYNCED_FILE_EXT_RE = /\.(mjs|js|css|json|html|md)$/i;

const HTML_TARGETS = [
  path.join(CANONICAL_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(AGY_HORIZON_ROOT, 'src', 'ui', 'sidepane.html'),
  path.join(AGY_HORIZON_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(FLIGHTCHECK_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full', 'src', 'webview', 'horizon_panel.html')
];

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function buildFullLifecycleHooksBlock(pluginRoot, enabled = true) {
  const normHook = (rel) => path.join(pluginRoot, rel).replace(/\\/g, '/');
  return {
    enabled: Boolean(enabled),
    SessionStart: [
      { type: 'command', command: `node --no-warnings "${normHook('src/hooks/session_start.mjs')}"`, timeout: 5 }
    ],
    PreInvocation: [
      { type: 'command', command: `node --no-warnings "${normHook('src/hooks/pre_invocation.mjs')}"`, timeout: 15 }
    ],
    PostInvocation: [
      { type: 'command', command: `node --no-warnings "${normHook('src/hooks/post_invocation.mjs')}"`, timeout: 5 }
    ],
    Stop: [
      { type: 'command', command: `node --no-warnings "${normHook('src/hooks/post_invocation.mjs')}"`, timeout: 5 }
    ],
    PreToolUse: [
      {
        matcher: FULL_TOOL_HOOK_MATCHER,
        type: 'command',
        command: `node --no-warnings "${normHook('src/hooks/pre_invocation.mjs')}"`,
        timeout: 5
      }
    ],
    PostToolUse: [
      {
        matcher: FULL_TOOL_HOOK_MATCHER,
        type: 'command',
        command: `node --no-warnings "${normHook('src/hooks/post_invocation.mjs')}"`,
        timeout: 5
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
  if (!preCmd.includes(`"${normPre}"`)) return false;
  if (lifecycleBlock.PreToolUse?.[0]?.matcher !== FULL_TOOL_HOOK_MATCHER) return false;
  if (lifecycleBlock.PostToolUse?.[0]?.matcher !== FULL_TOOL_HOOK_MATCHER) return false;
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
  pluginRoots = [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT]
} = {}) {
  const canonicalHtml = path.join(CANONICAL_ROOT, 'src', 'webview', 'horizon_panel.html');
  if (!fs.existsSync(canonicalHtml)) {
    throw new Error(`Canonical WebView HTML missing: ${canonicalHtml}`);
  }

  const activePluginRoots = pluginRoots.filter(r => Boolean(r) && fs.existsSync(r));

  if (!verifyOnly) {
    // 1. Rebuild standalone docs/index.html & evaluation_bundles/ first so in-repo mirrors are current
    buildDemoPage({ silent: false });
    if (fs.existsSync(path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_1_essential')) ||
        fs.existsSync(path.join(CANONICAL_ROOT, 'evaluation_bundles', 'tier_2_full'))) {
      buildEvaluationBundles({ silent: false });
    }

    // 2. Sync all module, config, rule, skill, asset, and sidecar subdirectories to active plugin mirrors
    for (const subDirParts of SYNCED_PLUGIN_SUBDIRS) {
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
          fs.mkdirSync(destSubDir, { recursive: true });
          fs.copyFileSync(srcFile, path.join(destSubDir, file));
        }
      }
    }

    for (const dirName of ['assets', 'skills']) {
      const srcDir = path.join(CANONICAL_ROOT, dirName);
      if (!fs.existsSync(srcDir)) continue;
      for (const root of activePluginRoots) {
        fs.cpSync(srcDir, path.join(root, dirName), { recursive: true });
      }
    }

    // Sync sidepane.html & legacy widget.html in agy-horizon if present
    for (const root of activePluginRoots) {
      const sidepaneTarget = path.join(root, 'src', 'ui', 'sidepane.html');
      if (fs.existsSync(path.dirname(sidepaneTarget))) {
        fs.copyFileSync(canonicalHtml, sidepaneTarget);
      }
      const legacyWidget = path.join(root, 'src', 'ui', 'widget.html');
      if (fs.existsSync(legacyWidget)) {
        fs.copyFileSync(canonicalHtml, legacyWidget);
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
              /node\s+--no-warnings\s+\.\/src\/([^\s"]+)(\s+[^"]*)?/g,
              (_, relPart, argsPart = '') => `node --no-warnings \\"${absPrefix}/src/${relPart}\\"${argsPart}`
            );
            JSON.parse(upgraded);
            atomicWriteFileSync(hooksPath, upgraded, { encoding: 'utf8' });
          }
        } catch {}
      }
    }

    // 4. Consolidate plugin.json manifests with unified 'Attention Horizon' branding
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
              displayName: 'Attention Horizon'
            };
        atomicWriteFileSync(path.join(root, 'plugin.json'), JSON.stringify(manifestOut, null, 2) + '\n', { encoding: 'utf8' });
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

  // Verify every synced file in SYNCED_PLUGIN_SUBDIRS + skills/ + assets/ across activePluginRoots
  for (const subDirParts of SYNCED_PLUGIN_SUBDIRS) {
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

  // Verify Flightcheck hooks.json preserves all 6 hooks & plugin.json displayName === 'Attention Horizon'
  for (const root of activePluginRoots) {
    const isFlightcheck = path.basename(root) === 'agy-horizon-flightcheck' || root === FLIGHTCHECK_ROOT;
    const pJsonPath = path.join(root, 'plugin.json');
    if (fs.existsSync(pJsonPath)) {
      const pJson = JSON.parse(fs.readFileSync(pJsonPath, 'utf8'));
      const dn = String(pJson.displayName || '');
      if (!dn.startsWith('Attention Horizon') || /Context Horizon/i.test(dn)) {
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
    if (!docsHtml.includes('<h1>Attention Horizon</h1>')) {
      mismatches.push(`Missing <h1>Attention Horizon</h1> in ${docsIndexPath}`);
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
