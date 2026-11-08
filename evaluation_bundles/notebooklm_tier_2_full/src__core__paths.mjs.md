# Source File: src/core/paths.mjs

```javascript
import path from 'node:path';
import fs from 'node:fs';

/**
 * Normalizes Windows & POSIX paths and file:// URIs into a canonical lowercase forward-slash path.
 * Handles file:///c%3A/..., file:///C:/..., C:\..., c:/...
 */
export function canonicalizePath(input) {
  if (!input || typeof input !== 'string') return '';
  let str = input.trim();
  try {
    str = decodeURIComponent(str);
  } catch {
    // keep as-is if decoding fails
  }

  // Strip file:// prefix
  str = str.replace(/^file:\/\/\/?/i, '');

  // Normalize all backslashes to forward slashes
  str = str.replace(/\\+/g, '/');

  // Strip leading slash before Windows drive letters (e.g. /c:/ -> c:/)
  if (/^\/[a-zA-Z]:/.test(str)) {
    str = str.slice(1);
  }

  // Remove trailing slashes (except root "c:/" or "/")
  if (str.length > 3 && str.endsWith('/')) {
    str = str.replace(/\/+$/, '');
  }

  // Lowercase on Windows or Windows drive formats for deterministic case-insensitive matching
  if (process.platform === 'win32' || /^[a-zA-Z]:\//.test(str)) {
    str = str.toLowerCase();
  }

  return str;
}

/**
 * Returns user home directory across platforms
 */
export function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || path.resolve('/');
}

/**
 * Returns true only for lockfiles, logs, build artifacts, or scratch files.
 * Rule: Active source code files must NEVER be recommended for .antigravityignore.
 */
export function isIgnorablePath(p) {
  if (!p) return false;
  const raw = String(p).replace(/\\/g, '/');
  const s = raw
    .replace(/^[a-z]:\/users\/[^/]+\/appdata\/local\/temp\/[^/]+\//i, '')
    .replace(/^\/(?:private\/)?tmp\/[^/]+\//i, '');
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|\.lock)$/i.test(s)) return true;
  if (/\.log$/i.test(s) || /(^|\/)logs?(\/|$)/i.test(s) || /\.jsonl$/i.test(s)) return true;
  if (/(^|\/)(dist|build|out|target|\.next|\.nuxt|coverage|node_modules)(\/|$)/i.test(s)) return true;
  if (/\.(min\.js|min\.css|map|pyc)$/i.test(s)) return true;
  if (/(^|\/)(scratch|\.scratch|tmp|temp)(\/|$)/i.test(s)) return true;
  return false;
}

/**
 * Returns all three local Antigravity surface store descriptors:
 * - Desktop 2.0 / Unified Daemon: ~/.gemini/antigravity ([App])
 * - Standalone IDE Fork: ~/.gemini/antigravity-ide ([IDE])
 * - CLI: ~/.gemini/antigravity-cli ([CLI])
 */
export function getAntigravitySurfaces(homeDir = getHomeDir(), { includeMissing = false } = {}) {
  const surfaces = [
    {
      name: 'antigravity',
      surfaceTag: '[App]',
      rootDir: path.join(homeDir, '.gemini', 'antigravity'),
      path: path.join(homeDir, '.gemini', 'antigravity', 'brain'),
      brainDir: path.join(homeDir, '.gemini', 'antigravity', 'brain'),
      conversationsDir: path.join(homeDir, '.gemini', 'antigravity', 'conversations'),
      summariesDbPath: path.join(homeDir, '.gemini', 'antigravity', 'conversation_summaries.db')
    },
    {
      name: 'antigravity-ide',
      surfaceTag: '[IDE]',
      rootDir: path.join(homeDir, '.gemini', 'antigravity-ide'),
      path: path.join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
      brainDir: path.join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
      conversationsDir: path.join(homeDir, '.gemini', 'antigravity-ide', 'conversations'),
      summariesDbPath: path.join(homeDir, '.gemini', 'antigravity-ide', 'conversation_summaries.db')
    },
    {
      name: 'antigravity-cli',
      surfaceTag: '[CLI]',
      rootDir: path.join(homeDir, '.gemini', 'antigravity-cli'),
      path: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain'),
      brainDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain'),
      conversationsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations'),
      summariesDbPath: path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
    }
  ];
  if (includeMissing) return surfaces;
  return surfaces.filter(s =>
    fs.existsSync(s.brainDir) ||
    fs.existsSync(s.conversationsDir) ||
    fs.existsSync(s.summariesDbPath)
  );
}

/**
 * Discovers potential Antigravity brain directories across all three surfaces
 */
export function getBrainStores(homeDir = getHomeDir()) {
  return getAntigravitySurfaces(homeDir, { includeMissing: true })
    .filter(s => fs.existsSync(s.path));
}
```
