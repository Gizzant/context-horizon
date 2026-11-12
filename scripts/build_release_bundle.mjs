import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../src/utils/nodeIo.mjs';
import { writeTextAtomic } from '../src/core-isomorphic/utils/runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '3.3.0';
const DIST_DIR = path.join(ROOT, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'staging', 'attention-horizon-antigravity');

console.log(`\n\x1b[1m\x1b[38;5;51m📦 Building attention-horizon-antigravity Production Release Bundles v${VERSION}...\x1b[0m`);

// 1. Prepare dist & staging directories
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(STAGING_DIR, { recursive: true });

// 2. Files to include in the Antigravity Plugin bundle
const TO_COPY = [
  'plugin.json',
  'package.json',
  'hooks.json',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'config',
  'assets',
  'rules',
  'skills',
  'sidecars',
  'src',
  'hooks',
  'commands',
  'bin'
];

for (const item of TO_COPY) {
  const src = path.join(ROOT, item);
  const dest = path.join(STAGING_DIR, item);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

const zipName = `attention-horizon-antigravity-v${VERSION}.zip`;
const tarName = `attention-horizon-antigravity-v${VERSION}.tar.gz`;
const zipPath = path.join(DIST_DIR, zipName);
const tarPath = path.join(DIST_DIR, tarName);
const stagingParent = path.dirname(STAGING_DIR);

// 3. Compress .zip and .tar.gz archives using tar (tar -a auto-selects zip format based on extension)
console.log(`[zip] Creating ${zipName}...`);
execSync(`tar -a -cf "${zipPath}" -C "${stagingParent}" attention-horizon-antigravity`, { stdio: 'inherit' });

console.log(`[tar.gz] Creating ${tarName}...`);
execSync(`tar -czf "${tarPath}" -C "${stagingParent}" attention-horizon-antigravity`, { stdio: 'inherit' });

// 4. Create npm pack tarball (for npx / npm registry install)
console.log('[npm pack] Packing attention-horizon-antigravity tarball...');
execSync(`npm pack --pack-destination "${DIST_DIR}"`, { cwd: ROOT, stdio: 'inherit' });

// 5. Clean up staging
fs.rmSync(path.join(DIST_DIR, 'staging'), { recursive: true, force: true });

// 6. Generate SHA256SUMS.txt
const distFiles = fs.readdirSync(DIST_DIR).filter(f => !f.endsWith('.txt') && !f.endsWith('.md')).sort();
const shaLines = [];

for (const file of distFiles) {
  const fPath = path.join(DIST_DIR, file);
  const buf = fs.readFileSync(fPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const sizeMb = (buf.byteLength / 1024 / 1024).toFixed(2);
  shaLines.push(`${hash}  ${file}`);
  console.log(`  \x1b[38;5;82m✔\x1b[0m ${file.padEnd(42)} ${sizeMb} MB  (${hash.slice(0, 16)}...)`);
}

const shaManifestPath = path.join(DIST_DIR, 'SHA256SUMS.txt');
writeTextAtomic(shaManifestPath, shaLines.join('\n') + '\n');

console.log(`\n\x1b[1m\x1b[38;5;82m✓ Release artifacts built successfully in dist/:\x1b[0m`);
console.log(`  • ${shaManifestPath}`);
