import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const TARGET_DIRS_AND_FILES = [
  'package.json',
  'plugin.json',
  '.claude-plugin/plugin.json',
  'hooks.json',
  'hooks/hooks.json',
  'bin',
  'hooks',
  'src/core-isomorphic',
  'src/core',
  'src/webview/horizon_panel.html',
  'src/webview/simple_view.html',
  'src/webview/advanced_view.html'
];

function collectReleaseFiles(rootDir) {
  const relFiles = new Set();
  const walk = (absTarget) => {
    if (!fs.existsSync(absTarget)) return;
    const st = fs.statSync(absTarget);
    if (st.isFile()) {
      const rel = path.relative(rootDir, absTarget).replace(/\\/g, '/');
      if (/\.(m?js|cjs|json|html|md)$/i.test(rel) && !rel.endsWith('CHECKSUMS.sha256')) {
        relFiles.add(rel);
      }
      return;
    }
    if (st.isDirectory()) {
      for (const ent of fs.readdirSync(absTarget, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(path.join(absTarget, ent.name));
      }
    }
  };
  for (const item of TARGET_DIRS_AND_FILES) {
    walk(path.join(rootDir, item));
  }
  return Array.from(relFiles).sort();
}

export function computeCanonicalSha256(filePath) {
  const rawBytes = fs.readFileSync(filePath);
  // Normalize CRLF -> LF on text files so SHA-256 checksums verify identically across Windows and POSIX git checkouts
  const normalized = rawBytes.toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function generateChecksumsManifest(rootDir = REPO_ROOT) {
  const files = collectReleaseFiles(rootDir);
  const lines = files.map((rel) => {
    const hash = computeCanonicalSha256(path.join(rootDir, rel));
    return `${hash}  ${rel}`;
  });
  const outPath = path.join(rootDir, 'CHECKSUMS.sha256');
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return { outPath, fileCount: files.length };
}

export function verifyChecksumsManifest(rootDir = REPO_ROOT) {
  const manifestPath = path.join(rootDir, 'CHECKSUMS.sha256');
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, verifiedCount: 0, mismatches: ['Missing CHECKSUMS.sha256 manifest'] };
  }
  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const mismatches = [];
  let verifiedCount = 0;

  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s\s(.+)$/);
    if (!match) continue;
    const [, expectedHash, relPath] = match;
    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath)) {
      mismatches.push(`Missing file: ${relPath}`);
      continue;
    }
    const actualHash = computeCanonicalSha256(absPath);
    if (actualHash !== expectedHash) {
      mismatches.push(`Checksum mismatch: ${relPath}`);
    } else {
      verifiedCount++;
    }
  }

  return {
    valid: mismatches.length === 0 && verifiedCount > 0,
    verifiedCount,
    mismatches
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const res = generateChecksumsManifest(REPO_ROOT);
  console.log(`[Checksums] Generated ${res.outPath} (${res.fileCount} release files verified)`);
}
