#!/usr/bin/env node
/**
 * @file scripts/verify_monorepo_sharing.mjs
 * Verifies the Milestone M1 monorepo code-sharing gate (>= 80% shared core & engine logic
 * across `@ctxtop/core` + `@ctxtop/engine-node` relative to host-specific adapter layers).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function walkCodeFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkCodeFiles(full));
    } else if (/\.(mjs|js|cjs|json)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function countLinesInDirs(relDirs) {
  let totalLines = 0;
  let totalFiles = 0;
  for (const rel of relDirs) {
    const abs = path.join(PROJECT_ROOT, rel);
    for (const file of walkCodeFiles(abs)) {
      const content = fs.readFileSync(file, 'utf8');
      totalLines += content.split(/\r?\n/).length;
      totalFiles += 1;
    }
  }
  return { totalFiles, totalLines };
}

export function verifyMonorepoSharing() {
  const sharedCore = countLinesInDirs([
    'src/core-isomorphic',
    'src/engine-node',
    'src/core/shared',
    'src/core/coach',
    'src/core/telemetry',
    'src/diagnostics',
    'src/utils',
    'packages/core',
    'packages/engine-node'
  ]);

  const hostAdapters = countLinesInDirs([
    'src/adapters/antigravity',
    'src/adapters/claude-code',
    'hooks',
    'src/hooks',
    'packages/antigravity',
    'packages/claude-code'
  ]);

  const totalCompared = sharedCore.totalLines + hostAdapters.totalLines;
  const sharedPct =
    totalCompared > 0 ? Number(((sharedCore.totalLines / totalCompared) * 100).toFixed(2)) : 0;

  return {
    sharedCore,
    hostAdapters,
    totalCompared,
    sharedPct,
    passed: sharedPct >= 80.0
  };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const report = verifyMonorepoSharing();
  console.log('\nHighbeam v4.0 Monorepo Sharing Verification (Milestone M1)');
  console.log('===================================================================');
  console.log(
    `  Shared Core & Engine (@ctxtop/core + @ctxtop/engine-node): ${report.sharedCore.totalLines.toLocaleString('en-US')} LOC (${report.sharedCore.totalFiles} files)`
  );
  console.log(
    `  Host Adapters & Shims (@ctxtop/antigravity + @ctxtop/claude-code): ${report.hostAdapters.totalLines.toLocaleString('en-US')} LOC (${report.hostAdapters.totalFiles} files)`
  );
  console.log(`  Shared Logic Ratio: ${report.sharedPct}% (Target: >= 80.0%)`);

  if (!report.passed) {
    console.error(`\nFAIL: Shared logic ratio ${report.sharedPct}% is below the 80.0% M1 gate.`);
    process.exit(1);
  }
  console.log('\nPASS: Monorepo sharing gate (>= 80.0%) satisfied.\n');
}
