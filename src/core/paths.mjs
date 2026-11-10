import path from 'node:path';
import fs from 'node:fs';

/**
 * Suppresses Node.js `ExperimentalWarning: SQLite is an experimental feature` on CLI and daemon entrypoints.
 */
export function suppressSqliteExperimentalWarning() {
  if (typeof process === 'undefined' || process.__ctxtopSqliteWarningSuppressed) return;
  process.__ctxtopSqliteWarningSuppressed = true;
  if (typeof process.emitWarning === 'function') {
    const origEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = function (warning, ...args) {
      const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
      const type = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].type) || (warning && warning.name) || '';
      if ((type === 'ExperimentalWarning' && /SQLite/i.test(msg)) || /SQLite is an experimental feature/i.test(msg)) {
        return;
      }
      return origEmitWarning(warning, ...args);
    };
  }
}

suppressSqliteExperimentalWarning();

export function parseNodeVersion(versionStr = (typeof process !== 'undefined' && process.versions?.node) || '0.0.0') {
  const parts = String(versionStr || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

export function isSupportedNodeVersion(versionStr = (typeof process !== 'undefined' && process.versions?.node) || '0.0.0') {
  const { major, minor } = parseNodeVersion(versionStr);
  return major > 22 || (major === 22 && minor >= 5);
}

export function formatNodeUpgradeHint(versionStr = (typeof process !== 'undefined' && process.versions?.node) || '0.0.0') {
  const cleanVer = String(versionStr || '0.0.0').replace(/^v/i, '');
  return [
    `\x1b[33m▲ ctxtop requires Node.js >= 22.5.0 for built-in zero-dependency SQLite (detected v${cleanVer}).\x1b[0m`,
    `  Upgrade in 10s: \x1b[36mnvm install 22 && nvm use 22\x1b[0m (or download from https://nodejs.org)`
  ].join('\n');
}

export function ensureSupportedNodeVersion({ exitOnUnsupported = true, stream = process.stderr, versionStr = process.versions?.node } = {}) {
  if (isSupportedNodeVersion(versionStr)) return { supported: true, message: '' };
  const message = formatNodeUpgradeHint(versionStr);
  if (stream && typeof stream.write === 'function') {
    stream.write(message + '\n');
  }
  if (exitOnUnsupported && typeof process !== 'undefined' && typeof process.exit === 'function') {
    process.exit(1);
  }
  return { supported: false, message };
}

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

/**
 * Returns canonical `~/.ctxtop/daemon.port` path used by CLI, healthchecks, and UI.
 */
export function getDaemonPortFile(homeDir = getHomeDir()) {
  return path.join(homeDir, '.ctxtop', 'daemon.port');
}

/**
 * Reads the active daemon port from `~/.ctxtop/daemon.port` (or `~/.gemini/runtime/horizon-latest.json` fallback).
 */
export function readDaemonPort(homeDir = getHomeDir(), fallbackPort = 62935) {
  const portFile = getDaemonPortFile(homeDir);
  if (fs.existsSync(portFile)) {
    try {
      const p = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      if (p > 0 && p <= 65535) return p;
    } catch {}
  }
  const latestJson = path.join(homeDir, '.gemini', 'runtime', 'horizon-latest.json');
  if (fs.existsSync(latestJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(latestJson, 'utf8'));
      const p = parseInt(String(parsed?.port || '0'), 10);
      if (p > 0 && p <= 65535) return p;
    } catch {}
  }
  return fallbackPort;
}

/**
 * Returns Claude Code `~/.claude/projects` directory.
 */
export function getClaudeCodeProjectsDir(homeDir = getHomeDir()) {
  return path.join(homeDir, '.claude', 'projects');
}

/**
 * Returns candidate Cursor `workspaceStorage` directories across Windows, macOS, Linux, and test roots.
 */
export function getCursorWorkspaceStorageDirs(homeDir = getHomeDir()) {
  const candidates = [
    path.join(homeDir, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage'),
    path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
    path.join(homeDir, '.config', 'Cursor', 'User', 'workspaceStorage'),
    path.join(homeDir, '.cursor', 'workspaceStorage'),
    path.join(homeDir, 'workspaceStorage')
  ];
  if (process.env.APPDATA && canonicalizePath(process.env.APPDATA).startsWith(canonicalizePath(homeDir))) {
    const appDataPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'workspaceStorage');
    if (!candidates.includes(appDataPath)) candidates.unshift(appDataPath);
  }
  return candidates.filter(p => fs.existsSync(p));
}
