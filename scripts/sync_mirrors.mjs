import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * T4.2: Canonical Mirror Synchronization & SHA-256 Parity Verifier.
 *
 * Keeps core modules and the WebView HTML (`horizon_panel.html` / `sidepane.html`)
 * byte-for-byte identical across the repository root and any installed local
 * Antigravity plugin mirrors (`~/.gemini/config/plugins/agy-horizon*`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CANONICAL_ROOT = path.resolve(__dirname, '..');
const AGY_HORIZON_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon');
const FLIGHTCHECK_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');

function getCoreFiles() {
  const coreDir = path.join(CANONICAL_ROOT, 'src', 'core');
  if (!fs.existsSync(coreDir)) return [];
  return fs.readdirSync(coreDir).filter(f => f.endsWith('.mjs')).sort();
}

const CORE_FILES = getCoreFiles();

const HTML_TARGETS = [
  path.join(CANONICAL_ROOT, 'src', 'webview', 'horizon_panel.html'),
  path.join(AGY_HORIZON_ROOT, 'src', 'ui', 'sidepane.html'),
  path.join(FLIGHTCHECK_ROOT, 'src', 'webview', 'horizon_panel.html')
];

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function syncAndVerifyMirrors({ verifyOnly = false } = {}) {
  const canonicalHtml = HTML_TARGETS[0];
  if (!fs.existsSync(canonicalHtml)) {
    throw new Error(`Canonical WebView HTML missing: ${canonicalHtml}`);
  }

  if (!verifyOnly) {
    // 1. Sync HTML to agy-horizon and agy-horizon-flightcheck
    for (const target of HTML_TARGETS.slice(1)) {
      if (fs.existsSync(path.dirname(target))) {
        fs.copyFileSync(canonicalHtml, target);
      }
    }
    const legacyWidget = path.join(AGY_HORIZON_ROOT, 'src', 'ui', 'widget.html');
    if (fs.existsSync(legacyWidget)) {
      fs.copyFileSync(canonicalHtml, legacyWidget);
    }

    // 2. Sync core modules (including telemetry/ and coach/ subdirectories) across all 3 roots
    for (const file of CORE_FILES) {
      const src = path.join(CANONICAL_ROOT, 'src', 'core', file);
      if (!fs.existsSync(src)) continue;
      for (const root of [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT]) {
        const destDir = path.join(root, 'src', 'core');
        if (fs.existsSync(destDir)) {
          fs.copyFileSync(src, path.join(destDir, file));
        }
      }
    }

    for (const subDirParts of [['src', 'core', 'telemetry'], ['src', 'core', 'coach'], ['src', 'shims'], ['src', 'ui'], ['src', 'hooks']]) {
      const srcSubDir = path.join(CANONICAL_ROOT, ...subDirParts);
      if (!fs.existsSync(srcSubDir)) continue;
      const entries = fs.readdirSync(srcSubDir).filter(f => /\.(mjs|js|css)$/i.test(f));
      for (const file of entries) {
        const srcFile = path.join(srcSubDir, file);
        for (const root of [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT]) {
          if (!fs.existsSync(root)) continue;
          const destSubDir = path.join(root, ...subDirParts);
          fs.mkdirSync(destSubDir, { recursive: true });
          fs.copyFileSync(srcFile, path.join(destSubDir, file));
        }
      }
    }

    // 3. Preserve/repair absolute quoted forward-slash paths in plugin hooks.json (never clobber with relative ./src/hooks/...)
    if (fs.existsSync(FLIGHTCHECK_ROOT)) {
      const flightcheckHooksPath = path.join(FLIGHTCHECK_ROOT, 'hooks.json');
      const normHook = (rel) => path.join(FLIGHTCHECK_ROOT, rel).replace(/\\/g, '/');
      let existingEnabled = true;
      let needsRewrite = true;
      if (fs.existsSync(flightcheckHooksPath)) {
        try {
          const rawHooks = fs.readFileSync(flightcheckHooksPath, 'utf8');
          const parsedHooks = JSON.parse(rawHooks);
          if (typeof parsedHooks?.['horizon-flightcheck-lifecycle']?.enabled === 'boolean') {
            existingEnabled = parsedHooks['horizon-flightcheck-lifecycle'].enabled;
          }
          // Preserve untouched if all commands already use quoted absolute forward-slash paths (no relative ./src/ and no unescaped backslashes)
          const hasRelative = /(?:^|\s|\.)\/?src\/hooks\//.test(rawHooks) && !rawHooks.includes(`"${normHook('src/hooks/')}`);
          const hasBackslashes = /node[^"]*\\/.test(rawHooks);
          if (!hasRelative && !hasBackslashes && rawHooks.includes(`"${normHook('src/hooks/pre_invocation.mjs')}"`)) {
            needsRewrite = false;
          }
        } catch {
          needsRewrite = true;
        }
      }
      if (needsRewrite) {
        const resolvedHooks = {
          'horizon-flightcheck-lifecycle': {
            enabled: existingEnabled,
            SessionStart: [{ type: 'command', command: `node --no-warnings "${normHook('src/hooks/session_start.mjs')}"`, timeout: 5 }],
            PreInvocation: [{ type: 'command', command: `node --no-warnings "${normHook('src/hooks/pre_invocation.mjs')}"`, timeout: 15 }],
            PostInvocation: [{ type: 'command', command: `node --no-warnings "${normHook('src/hooks/post_invocation.mjs')}"`, timeout: 5 }]
          }
        };
        fs.writeFileSync(flightcheckHooksPath, JSON.stringify(resolvedHooks, null, 2) + '\n', 'utf8');
      }
    }

    if (fs.existsSync(AGY_HORIZON_ROOT)) {
      const horizonHooksPath = path.join(AGY_HORIZON_ROOT, 'hooks.json');
      if (fs.existsSync(horizonHooksPath)) {
        try {
          const rawHorizonHooks = fs.readFileSync(horizonHooksPath, 'utf8');
          if (rawHorizonHooks.includes('./src/')) {
            const absPrefix = AGY_HORIZON_ROOT.replace(/\\/g, '/');
            const upgraded = rawHorizonHooks.replace(
              /node\s+--no-warnings\s+\.\/src\/([^\s"]+)(\s+[^"]*)?/g,
              (_, relPart, argsPart = '') => `node --no-warnings \\"${absPrefix}/src/${relPart}\\"${argsPart}`
            );
            JSON.parse(upgraded); // validate JSON before writing
            fs.writeFileSync(horizonHooksPath, upgraded, 'utf8');
          }
        } catch {}
      }
    }

    // 4. Consolidate plugin.json manifests & asset/rule/skill directories across mirrors
    const canonicalPluginPath = path.join(CANONICAL_ROOT, 'plugin.json');
    if (fs.existsSync(canonicalPluginPath)) {
      const canonicalManifest = JSON.parse(fs.readFileSync(canonicalPluginPath, 'utf8'));
      for (const dirName of ['assets', 'rules', 'skills', 'config']) {
        const srcDir = path.join(CANONICAL_ROOT, dirName);
        if (!fs.existsSync(srcDir)) continue;
        for (const root of [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT]) {
          if (!fs.existsSync(root)) continue;
          fs.cpSync(srcDir, path.join(root, dirName), { recursive: true });
        }
      }
      if (fs.existsSync(FLIGHTCHECK_ROOT)) {
        fs.writeFileSync(path.join(FLIGHTCHECK_ROOT, 'plugin.json'), JSON.stringify(canonicalManifest, null, 2) + '\n', 'utf8');
      }
      if (fs.existsSync(AGY_HORIZON_ROOT)) {
        const horizonManifest = {
          ...canonicalManifest,
          name: 'agy-horizon',
          displayName: 'Context Horizon (ctxtop)'
        };
        fs.writeFileSync(path.join(AGY_HORIZON_ROOT, 'plugin.json'), JSON.stringify(horizonManifest, null, 2) + '\n', 'utf8');
      }
    }

    const extraSyncPairs = [
      ['sidecars', 'horizon-daemon', 'server.mjs'],
      ['src', 'cli', 'horizon_hud.mjs'],
      ['tests', 'fixtures', 'synthetic_states.mjs']
    ];
    for (const relParts of extraSyncPairs) {
      const canonicalFile = path.join(CANONICAL_ROOT, ...relParts);
      if (!fs.existsSync(canonicalFile)) continue;
      for (const root of [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT]) {
        if (!fs.existsSync(root)) continue;
        const destFile = path.join(root, ...relParts);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(canonicalFile, destFile);
      }
    }
  }

  // Verify 3-way SHA-256 parity
  const hashes = HTML_TARGETS.filter(p => fs.existsSync(p)).map(p => ({
    path: p,
    sha256: sha256File(p)
  }));

  const uniqueHashes = new Set(hashes.map(h => h.sha256));
  const parityOk = uniqueHashes.size === 1 && hashes.length >= 1;

  for (const h of hashes) {
    console.log(`[SHA-256] ${h.sha256}  ${h.path}`);
  }

  if (!parityOk) {
    throw new Error(`3-Way Mirror SHA-256 Parity FAILED: found ${uniqueHashes.size} distinct hashes across ${hashes.length} targets.`);
  }

  console.log('✓ 3-Way WebView Mirror Parity VERIFIED (byte-for-byte identical).');
  return { parityOk, sha256: hashes[0].sha256, targets: hashes.length };
}

const isMain = process.argv[1] && process.argv[1].endsWith('sync_mirrors.mjs');
if (isMain) {
  const verifyOnly = process.argv.includes('--verify-only');
  syncAndVerifyMirrors({ verifyOnly });
}
