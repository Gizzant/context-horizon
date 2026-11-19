#!/usr/bin/env node
/**
 * @file scripts/sync_workspaces.mjs
 * Synchronizes the 6 workspace packages under `packages/*` so that each package
 * is self-contained, valid, and cleanly publishable standalone via `npm pack` / `npm publish`
 * without any relative path escapes (`../../../src/...`) outside package boundaries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PKG.version || '4.1.4';

function writeFileIfChangedSync(filePath, content, encoding = 'utf8') {
  const nextBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), encoding);
  if (fs.existsSync(filePath)) {
    try {
      const prevBuf = fs.readFileSync(filePath);
      if (Buffer.compare(prevBuf, nextBuf) === 0) return;
    } catch (readErr) {
      void readErr;
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, nextBuf);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (renameErr) {
    void renameErr;
    fs.writeFileSync(filePath, nextBuf);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (unlinkErr) {
      void unlinkErr;
    }
  }
}

function copyDirRecursiveSync(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, ent.name);
    const destPath = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else if (ent.isFile()) {
      const content = fs.readFileSync(srcPath);
      writeFileIfChangedSync(destPath, content);
    }
  }
}

export function syncWorkspaces() {
  console.log('[sync_workspaces] Synchronizing 6 workspace packages...');

  // 1. @ctxtop/core (packages/core)
  const coreDestSrc = path.join(ROOT, 'packages', 'core', 'src');
  const coreSrcDir = path.join(ROOT, 'src', 'core-isomorphic');
  copyDirRecursiveSync(coreSrcDir, coreDestSrc);

  const coreIndexContent = `/**
 * @file packages/core/src/index.mjs
 * Highbeam v4.1 Isomorphic Core Barrel (@ctxtop/core).
 * Standalone publishable, zero node:* imports, 100% self-contained ESM.
 */

export * from './ustf/index.mjs';
export * from './catalog/index.mjs';
export * from './control/index.mjs';
export * from './economics/index.mjs';
export * from './diagnostics/index.mjs';
export * from './utils/runtime.mjs';
export * from './telemetry/telemetryBridge.mjs';
export * from './config/horizonConfig.mjs';
export * from './config/catalogLoader.mjs';
export * from './coach/cacheGravityRouter.mjs';
export * from './coach/ttlWatchdog.mjs';
export * from './coach/stateBatonHydrator.mjs';
export * from './coach/savedQuotaLedger.mjs';
export * from './guards/circuitBreakers.mjs';
export * from './guards/docIndexCore.mjs';
export * from './ui/modViews.mjs';
export * from './ui/horizonGrid.mjs';
export * from './ui/costRadarSvg.mjs';
export * from './ui/horizonPanelHtml.mjs';
`;
  writeFileIfChangedSync(path.join(coreDestSrc, 'index.mjs'), coreIndexContent, 'utf8');

  const corePkg = {
    name: '@ctxtop/core',
    version: VERSION,
    description: 'Highbeam isomorphic pure-JS core (DET-01..32 catalog, circuit breakers, economics, coach, UI renderers)',
    type: 'module',
    main: './src/index.mjs',
    exports: {
      '.': './src/index.mjs',
      './*': './src/*'
    },
    files: ['src/'],
    engines: {
      node: '>=20.0.0'
    },
    dependencies: {}
  };
  writeFileIfChangedSync(
    path.join(ROOT, 'packages', 'core', 'package.json'),
    JSON.stringify(corePkg, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ @ctxtop/core synchronized.');

  // 2. @ctxtop/engine-node (packages/engine-node)
  const engineDestSrc = path.join(ROOT, 'packages', 'engine-node', 'src');
  const engineSrcDir = path.join(ROOT, 'src', 'engine-node');
  copyDirRecursiveSync(engineSrcDir, engineDestSrc);

  // Vendor isomorphic core + config so @ctxtop/engine-node has zero ../ escapes outside package root
  copyDirRecursiveSync(
    path.join(ROOT, 'src', 'core-isomorphic'),
    path.join(engineDestSrc, 'vendor', 'core-isomorphic')
  );
  copyDirRecursiveSync(
    path.join(ROOT, 'config'),
    path.join(engineDestSrc, 'vendor', 'config')
  );

  const engineIpcServerPath = path.join(engineDestSrc, 'ipc', 'server.mjs');
  if (fs.existsSync(engineIpcServerPath)) {
    let ipcSrc = fs.readFileSync(engineIpcServerPath, 'utf8');
    ipcSrc = ipcSrc.replace(/\.\.\/\.\.\/core-isomorphic\//g, '../vendor/core-isomorphic/');
    writeFileIfChangedSync(engineIpcServerPath, ipcSrc, 'utf8');
  }

  // Copy RSL modules & local RSL transitive dependencies into packages/engine-node/src/vendor/core/
  // so every `../core-isomorphic/...` and `./...` relative import resolves inside packages/engine-node/.
  const engineVendorCore = path.join(engineDestSrc, 'vendor', 'core');
  fs.mkdirSync(engineVendorCore, { recursive: true });
  for (const rslDepFile of [
    'atomic_io.mjs',
    'constants.mjs',
    'doc_indexer.mjs',
    'shield_manager.mjs',
    'rsl_clash_auditor.mjs',
    'rsl_triage.mjs',
    'rsl_distiller.mjs',
    'rsl_ledger.mjs'
  ]) {
    const depSrc = path.join(ROOT, 'src', 'core', rslDepFile);
    if (fs.existsSync(depSrc)) {
      writeFileIfChangedSync(path.join(engineVendorCore, rslDepFile), fs.readFileSync(depSrc));
    }
  }
  const rslDest = path.join(engineDestSrc, 'rsl');
  fs.mkdirSync(rslDest, { recursive: true });
  for (const existingRslEntry of fs.readdirSync(rslDest)) {
    if (existingRslEntry !== 'index.mjs' && !existingRslEntry.includes('.tmp.')) {
      try {
        fs.rmSync(path.join(rslDest, existingRslEntry), { recursive: true, force: true });
      } catch (rmErr) {
        void rmErr;
      }
    }
  }
  const rslIndexContent = [
    "export * from '../vendor/core/rsl_triage.mjs';",
    "export * from '../vendor/core/rsl_distiller.mjs';",
    "export * from '../vendor/core/rsl_ledger.mjs';"
  ].join('\n') + '\n';
  writeFileIfChangedSync(path.join(rslDest, 'index.mjs'), rslIndexContent, 'utf8');

  const engineIndexContent = `/**
 * @file packages/engine-node/src/index.mjs
 * Highbeam Node.js >=22.13 runtime engine barrel (@ctxtop/engine-node).
 * Standalone publishable SQLite + JSONL fallback, Micro-IPC, offloader, git sensors & RSL.
 */

export * from './db/index.mjs';
export * from './sensors/index.mjs';
export * from './offloader/index.mjs';
export * from './ipc/index.mjs';
export * from './rsl/index.mjs';
`;
  writeFileIfChangedSync(path.join(engineDestSrc, 'index.mjs'), engineIndexContent, 'utf8');

  const enginePkg = {
    name: '@ctxtop/engine-node',
    version: VERSION,
    description: 'Highbeam Node.js >=22.13 runtime engine (SQLite + JSONL fallback, Micro-IPC, lossless offloader, git sensors)',
    type: 'module',
    main: './src/index.mjs',
    exports: {
      '.': './src/index.mjs',
      './*': './src/*'
    },
    files: ['src/'],
    engines: {
      node: '>=20.0.0'
    },
    dependencies: {}
  };
  writeFileIfChangedSync(
    path.join(ROOT, 'packages', 'engine-node', 'package.json'),
    JSON.stringify(enginePkg, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ @ctxtop/engine-node synchronized.');

  // 3. @ctxtop/pro (packages/pro)
  const proDir = path.join(ROOT, 'packages', 'pro');
  const proSrcDir = path.join(proDir, 'src');
  fs.mkdirSync(proSrcDir, { recursive: true });

  // Sync pro_license.mjs into packages/pro/src/pro_license.mjs
  const srcProLicense = path.join(ROOT, 'src', 'core', 'pro_license.mjs');
  if (fs.existsSync(srcProLicense)) {
    writeFileIfChangedSync(path.join(proSrcDir, 'pro_license.mjs'), fs.readFileSync(srcProLicense));
  }

  // Update team_finops_pack.mjs to use local pro_license.mjs import
  const finopsFile = path.join(proSrcDir, 'team_finops_pack.mjs');
  if (fs.existsSync(finopsFile)) {
    let content = fs.readFileSync(finopsFile, 'utf8');
    content = content.replace("from '../../../src/core/pro_license.mjs';", "from './pro_license.mjs';");
    writeFileIfChangedSync(finopsFile, content, 'utf8');
  }

  // Update polar_webhook_worker.mjs to use local pro_license.mjs import
  const workerFile = path.join(proDir, 'workers', 'polar_webhook_worker.mjs');
  if (fs.existsSync(workerFile)) {
    let content = fs.readFileSync(workerFile, 'utf8');
    content = content.replace("from '../../../src/core/pro_license.mjs';", "from '../src/pro_license.mjs';");
    writeFileIfChangedSync(workerFile, content, 'utf8');
  }

  const proIndexContent = `/**
 * @file packages/pro/src/index.mjs
 * Highbeam Pro Commercial Entitlement Barrel (@ctxtop/pro).
 * Offline Ed25519 License Verifier, Encrypted Sync, Git/PR Cost Attribution,
 * Zero-Knowledge Org FinOps Rollup, CI Budget Gate & Team FinOps Pack.
 * The Polar.sh webhook worker (workers/) is operator-only infrastructure and is NOT published.
 */

export * from './pro_license.mjs';
export * from './team_finops_pack.mjs';
export * from './encrypted_sync.mjs';
export * from './pr_cost_attribution.mjs';
export * from './team_finops_rollup.mjs';
export * from './ci_budget_gate.mjs';
`;
  writeFileIfChangedSync(path.join(proSrcDir, 'index.mjs'), proIndexContent, 'utf8');

  const proPkg = {
    name: '@ctxtop/pro',
    version: VERSION,
    description: 'Highbeam Pro — Offline Ed25519 License Verifier, Encrypted Sync, PR Cost Attribution, ZK Org FinOps Rollup & CI Budget Gate',
    license: 'SEE LICENSE IN LICENSE-COMMERCIAL.md',
    type: 'module',
    main: './src/index.mjs',
    exports: {
      '.': './src/index.mjs',
      './team-finops': './src/team_finops_pack.mjs',
      './encrypted-sync': './src/encrypted_sync.mjs',
      './pr-cost': './src/pr_cost_attribution.mjs',
      './team-rollup': './src/team_finops_rollup.mjs',
      './ci-gate': './src/ci_budget_gate.mjs'
    },
    files: [
      'src/',
      'LICENSE-COMMERCIAL.md'
    ],
    engines: {
      node: '>=20.0.0'
    },
    dependencies: {}
  };
  writeFileIfChangedSync(
    path.join(proDir, 'package.json'),
    JSON.stringify(proPkg, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ @ctxtop/pro synchronized.');

  // 4. @ctxtop/mcp (packages/mcp) — 100% standalone zero-escape bundle
  const mcpDir = path.join(ROOT, 'packages', 'mcp');
  const mcpSrc = path.join(mcpDir, 'src');
  const mcpVendor = path.join(mcpSrc, 'vendor');
  fs.mkdirSync(mcpSrc, { recursive: true });

  copyDirRecursiveSync(
    path.join(ROOT, 'src', 'core-isomorphic'),
    path.join(mcpVendor, 'core-isomorphic')
  );
  copyDirRecursiveSync(
    path.join(ROOT, 'config'),
    path.join(mcpVendor, 'config')
  );
  writeFileIfChangedSync(
    path.join(mcpVendor, 'engine-node', 'db', 'probe.mjs'),
    fs.readFileSync(path.join(ROOT, 'src', 'engine-node', 'db', 'probe.mjs'))
  );
  writeFileIfChangedSync(
    path.join(mcpVendor, 'pro', 'pro_license.mjs'),
    fs.readFileSync(path.join(ROOT, 'src', 'core', 'pro_license.mjs'))
  );
  for (const relCoreFile of [
    'atomic_io.mjs',
    'constants.mjs',
    'paths.mjs',
    'doc_indexer.mjs',
    'hook_diagnostics.mjs',
    'sqlite_client.mjs',
    'fts5_output_compressor.mjs',
    'session_auditor.mjs',
    'coach/saved_quota_ledger.mjs',
    'telemetry/scope_lock_registry.mjs'
  ]) {
    const srcFile = path.join(ROOT, 'src', 'core', relCoreFile);
    const destFile = path.join(mcpVendor, 'core', relCoreFile);
    if (fs.existsSync(srcFile)) {
      writeFileIfChangedSync(destFile, fs.readFileSync(srcFile));
    }
  }

  const mcpPkg = {
    name: '@ctxtop/mcp',
    version: VERSION,
    description: 'Highbeam Zero-Dependency 7-Tool MCP Stdio Server for Cursor, Windsurf, Codex CLI, Gemini CLI, Claude Code & Antigravity',
    license: 'MIT',
    type: 'module',
    main: './src/server.mjs',
    mcpName: 'io.github.gizzant/highbeam',
    publishConfig: {
      access: 'public'
    },
    repository: {
      type: 'git',
      url: 'git+https://github.com/Gizzant/context-horizon.git',
      directory: 'packages/mcp'
    },
    bin: {
      mcp: 'src/server.mjs',
      'ctxtop-mcp': 'src/server.mjs'
    },
    exports: {
      '.': './src/server.mjs'
    },
    files: ['src/', 'README.md', 'smithery.yaml', 'glama.json', 'server.json'],
    engines: {
      node: '>=20.0.0'
    },
    dependencies: {}
  };
  writeFileIfChangedSync(
    path.join(mcpDir, 'package.json'),
    JSON.stringify(mcpPkg, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ @ctxtop/mcp synchronized.');

  // 5. @ctxtop/antigravity (packages/antigravity)
  const agyDir = path.join(ROOT, 'packages', 'antigravity');
  const agySrc = path.join(agyDir, 'src');
  fs.mkdirSync(agySrc, { recursive: true });

  const agySrcOriginal = path.join(ROOT, 'src', 'adapters', 'antigravity', 'index.mjs');
  if (fs.existsSync(agySrcOriginal)) {
    let agyAdapter = fs.readFileSync(agySrcOriginal, 'utf8');
    agyAdapter = agyAdapter
      .replace(/from\s+'\.\.\/\.\.\/core-isomorphic\/([^']+)'/g, "from '@ctxtop/core/$1'")
      .replace(/from\s+'\.\.\/\.\.\/core\/(rsl_triage|rsl_distiller|rsl_ledger)\.mjs'/g, "from '@ctxtop/engine-node/rsl/index.mjs'")
      .replace(/from\s+'\.\.\/\.\.\/(hooks|core|cli)\/([^']+)'/g, "from '@ctxtop/engine-node/$1/$2'");
    writeFileIfChangedSync(path.join(agySrc, 'adapter.mjs'), agyAdapter, 'utf8');
  }

  const agyIndexContent = `/**
 * @file packages/antigravity/src/index.mjs
 * Highbeam Google Antigravity Adapter Barrel (@ctxtop/antigravity).
 * Standalone publishable host adapter, daemon, hooks, and WebView HUD.
 */

export * from './adapter.mjs';
`;
  writeFileIfChangedSync(path.join(agySrc, 'index.mjs'), agyIndexContent, 'utf8');

  const agyPkg = {
    name: '@ctxtop/antigravity',
    version: VERSION,
    description: 'Highbeam Google Antigravity host adapter, daemon, hooks, and WebView HUD',
    type: 'module',
    main: './src/index.mjs',
    exports: {
      '.': './src/index.mjs',
      './*': './src/*'
    },
    files: ['src/'],
    engines: {
      node: '>=20.0.0'
    },
    dependencies: {
      '@ctxtop/core': `^${VERSION}`,
      '@ctxtop/engine-node': `^${VERSION}`
    }
  };
  writeFileIfChangedSync(
    path.join(agyDir, 'package.json'),
    JSON.stringify(agyPkg, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ @ctxtop/antigravity synchronized.');

  // 6. @ctxtop/claude-code (packages/claude-code)
  const claudeDir = path.join(ROOT, 'packages', 'claude-code');
  const claudeSrc = path.join(claudeDir, 'src');
  fs.mkdirSync(claudeSrc, { recursive: true });

  const claudeSrcOriginal = path.join(ROOT, 'src', 'adapters', 'claude-code', 'index.mjs');
  if (fs.existsSync(claudeSrcOriginal)) {
    let claudeAdapter = fs.readFileSync(claudeSrcOriginal, 'utf8');
    claudeAdapter = claudeAdapter
      .replace(/from\s+'\.\.\/\.\.\/core-isomorphic\/([^']+)'/g, "from '@ctxtop/core/$1'")
      .replace(/from\s+'\.\.\/\.\.\/core\/(rsl_triage|rsl_distiller|rsl_ledger)\.mjs'/g, "from '@ctxtop/engine-node/rsl/index.mjs'")
      .replace(/from\s+'\.\.\/\.\.\/\.\.\/hooks\/([^']+)'/g, "from '@ctxtop/engine-node/hooks/$1'")
      .replace(/from\s+'\.\.\/\.\.\/(hooks|core)\/([^']+)'/g, "from '@ctxtop/engine-node/$1/$2'");
    writeFileIfChangedSync(path.join(claudeSrc, 'adapter.mjs'), claudeAdapter, 'utf8');
  }

  const claudeHookOriginal = path.join(ROOT, 'hooks', 'register.js');
  if (fs.existsSync(claudeHookOriginal)) {
    let regSrc = fs.readFileSync(claudeHookOriginal, 'utf8');
    regSrc = regSrc.replace(/from\s+'\.\.\/src\/core-isomorphic\/([^']+)'/g, "from '@ctxtop/core/$1'");
    writeFileIfChangedSync(path.join(claudeSrc, 'register.js'), regSrc, 'utf8');
  }

  const claudeIndexContent = `/**
 * @file packages/claude-code/src/index.mjs
 * Highbeam Claude Code Adapter Barrel (@ctxtop/claude-code).
 * Standalone publishable in-process V8 Mod, Tier-2 CLI hooks & terminal statusLine.
 */

export * from './adapter.mjs';
export { default as register } from './register.js';
`;
  writeFileIfChangedSync(path.join(claudeSrc, 'index.mjs'), claudeIndexContent, 'utf8');

  const claudePkg = {
    name: '@ctxtop/claude-code',
    version: VERSION,
    description: 'Highbeam Claude Code in-process V8 Mod, Tier-2 CLI hooks, and terminal statusLine adapter',
    type: 'module',
    main: './src/index.mjs',
    exports: {
      '.': './src/index.mjs',
      './*': './src/*'
    },
    files: ['src/'],
    engines: {
      node: '>=20.0.0'
    },
    dependencies: {
      '@ctxtop/core': `^${VERSION}`,
      '@ctxtop/engine-node': `^${VERSION}`
    }
  };
  writeFileIfChangedSync(
    path.join(claudeDir, 'package.json'),
    JSON.stringify(claudePkg, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ @ctxtop/claude-code synchronized.');
  console.log('[sync_workspaces] All 6 workspace packages successfully synchronized.\n');
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  syncWorkspaces();
}
