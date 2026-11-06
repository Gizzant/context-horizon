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
 * Discovers potential Antigravity brain directories
 */
export function getBrainStores(homeDir = getHomeDir()) {
  const stores = [
    { name: 'antigravity', path: path.join(homeDir, '.gemini', 'antigravity', 'brain') },
    { name: 'antigravity-ide', path: path.join(homeDir, '.gemini', 'antigravity-ide', 'brain') },
    { name: 'antigravity-cli', path: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain') }
  ];
  return stores.filter(s => fs.existsSync(s.path));
}
