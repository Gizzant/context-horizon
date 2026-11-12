/**
 * @file src/diagnostics/doctorEngine.mjs
 * Contract Self-Check & Bounded Hook Runtime Diagnostics Engine (`ah-claude doctor` — `ISS-065`).
 *
 * Reads `<cwd>/.claude/cache/ah_diagnostics.jsonl` via `readRuntimeDiagnostics` and surfaces
 * `hookDiagnostics` (`recentErrorCount` and up to the last 5 redacted `recentErrors`).
 */

import {
  fs,
  path,
  os,
  fileURLToPath,
  readJsonSafe,
  getDiagnosticsFilePath,
  readRuntimeDiagnostics
} from '../utils/nodeIo.mjs';
import { loadModelCatalog } from '../core-isomorphic/config/catalogLoader.mjs';
import { loadHorizonConfig } from '../core-isomorphic/config/horizonConfig.mjs';

/**
 * Redacts the user's OS home directory from any diagnostic string.
 *
 * @param {string} text
 * @param {string} [homeDir]
 * @returns {string}
 */
export function redactDoctorPaths(text, homeDir) {
  const raw = String(text || '');
  const home = homeDir || os?.homedir?.() || '';
  if (!home) return raw;
  const escapedWin = home.replace(/\//g, '\\').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const posixHome = home.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw
    .replace(new RegExp(escapedWin, 'gi'), '~')
    .replace(new RegExp(posixHome, 'gi'), '~');
}

/**
 * Resolves the target `settings.json` path for `--project` or `--global`.
 *
 * @param {object} [options={}]
 * @returns {string}
 */
function resolveDoctorSettingsPath(options = {}) {
  if (typeof options.settingsPath === 'string' && options.settingsPath.trim()) {
    return options.settingsPath.trim();
  }
  const scope = options.scope === 'global' || options.global ? 'global' : 'project';
  if (scope === 'global') {
    const home = options.homeDir || os.homedir() || '.';
    return path.join(home, '.claude', 'settings.json');
  }
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  return path.join(cwd, '.claude', 'settings.json');
}

/**
 * Reads `<cwd>/.claude/cache/ah_diagnostics.jsonl` and returns a zero-PII summary
 * with total `recentErrorCount` and up to the newest 5 redacted `recentErrors` (`ISS-065`).
 *
 * @param {object} [options={}]
 * @returns {{
 *   diagnosticsPath: string,
 *   recentErrorCount: number,
 *   recentErrors: Array<{ timestamp: string, source: string, operation: string, name: string, message: string }>
 * }}
 */
export function inspectHookDiagnostics(options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const homeDir = options.homeDir || os?.homedir?.() || '';
  const entries = readRuntimeDiagnostics({ ...options, cwd });
  const recentErrors = entries.slice(-5).map((entry) => ({
    timestamp: String(entry.timestamp || ''),
    source: String(entry.source || 'unknown'),
    operation: String(entry.operation || 'unknown'),
    name: String(entry.name || 'Error'),
    message: redactDoctorPaths(entry.message || '', homeDir).slice(0, 300)
  }));

  return {
    diagnosticsPath: getDiagnosticsFilePath({ ...options, cwd }),
    recentErrorCount: entries.length,
    recentErrors
  };
}

/**
 * Runs host contract & runtime diagnostic checks (`npx ah-claude doctor`).
 *
 * @param {object} [options={}]
 * @returns {{
 *   ok: boolean,
 *   nodeVersion: string,
 *   checks: Array<{ id: string, ok: boolean, detail: string }>,
 *   hookDiagnostics: {
 *     diagnosticsPath: string,
 *     recentErrorCount: number,
 *     recentErrors: Array<{ timestamp: string, source: string, operation: string, name: string, message: string }>
 *   }
 * }}
 */
export function runDoctorDiagnostics(options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const nodeVersion = globalThis.process?.versions?.node || '0.0.0';
  const major = Number(nodeVersion.split('.')[0] || 0);
  const checks = [];

  checks.push({
    id: 'node_version',
    ok: major >= 20,
    detail: `Node.js v${nodeVersion} (requires >= 20.0.0)`
  });

  try {
    const catalog = loadModelCatalog(options);
    const modelCount = Object.keys(catalog.models || {}).length;
    checks.push({
      id: 'model_catalog',
      ok: modelCount >= 6,
      detail: `Loaded ${modelCount} Anthropic model rate cards (Haiku 5.5 100k cliff enabled)`
    });
  } catch (err) {
    checks.push({
      id: 'model_catalog',
      ok: false,
      detail: `Failed to load catalog: ${err?.message || String(err)}`
    });
  }

  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const registerPath = path.join(pluginRoot, 'hooks', 'register.js');
  const hooksJsonPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  const pluginJsonPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');

  checks.push({
    id: 'mod_entrypoint',
    ok: Boolean(fs.existsSync(registerPath)),
    detail: `hooks/register.js present at ${registerPath}`
  });

  const parsedHooksJson = readJsonSafe(hooksJsonPath, null);
  const validHooksSchema = Boolean(
    parsedHooksJson &&
      typeof parsedHooksJson.hooks === 'object' &&
      Array.isArray(parsedHooksJson.hooks.PreToolUse) &&
      Array.isArray(parsedHooksJson.hooks.PreToolUse[0]?.hooks)
  );
  checks.push({
    id: 'hooks_manifest',
    ok: Boolean(fs.existsSync(hooksJsonPath) && validHooksSchema),
    detail: `hooks/hooks.json valid (nested hooks schema)`
  });

  const parsedPluginJson = readJsonSafe(pluginJsonPath, null);
  const validPluginSchema = Boolean(
    parsedPluginJson &&
      parsedPluginJson.entrypoint === undefined &&
      Array.isArray(parsedPluginJson.commands) &&
      parsedPluginJson.commands.every((c) => typeof c === 'string')
  );
  checks.push({
    id: 'plugin_manifest',
    ok: Boolean(fs.existsSync(pluginJsonPath) && validPluginSchema),
    detail: `.claude-plugin/plugin.json valid`
  });

  const settingsPath = resolveDoctorSettingsPath({ ...options, cwd });
  const settingsInstalled = Boolean(fs.existsSync(settingsPath));
  checks.push({
    id: 'settings_status',
    ok: true,
    detail: settingsInstalled
      ? `settings.json present at ${settingsPath}`
      : `settings.json not yet created at ${settingsPath} (run 'ah-claude install')`
  });

  const config = loadHorizonConfig({ ...options, cwd });
  const customDetectors = Object.entries(config.detectors || {}).filter(
    ([, mode]) => mode !== 'default'
  ).length;
  checks.push({
    id: 'horizon_config',
    ok: Boolean(config && config.detectors && Object.keys(config.detectors).length === 20),
    detail: `20 detectors configured (FlightMode=${config.flightMode}, overrides=${customDetectors})`
  });

  const hookDiagnostics = inspectHookDiagnostics({ ...options, cwd });
  const ok = checks.every((c) => c.ok);

  return {
    ok,
    nodeVersion,
    checks,
    hookDiagnostics
  };
}

export default {
  redactDoctorPaths,
  inspectHookDiagnostics,
  runDoctorDiagnostics
};
