/**
 * @file src/core/shared/multi_host_mcp.mjs
 * Zero-network idempotent MCP client configuration installer for multi-host parity
 * across Cursor, Windsurf, OpenAI Codex CLI, Gemini CLI, and generic `.mcp.json` hosts.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SUPPORTED_MCP_HOSTS = Object.freeze([
  'cursor',
  'windsurf',
  'codex',
  'gemini-cli',
  'generic'
]);

const CODEX_TOML_SNIPPET = [
  '[mcp_servers.highbeam]',
  'command = "npx"',
  'args = ["-y", "highbeam-cli", "mcp"]'
].join('\n');

function resolveHome(options = {}) {
  return (
    options.homeDir ||
    options.home ||
    process.env.USERPROFILE ||
    process.env.HOME ||
    os.homedir()
  );
}

function readJsonObjectSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    void err;
  }
  return {};
}

function writeJsonAtomicSafe(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function normalizeMcpHostName(rawHost = '') {
  const cleaned = String(rawHost || '').trim().toLowerCase();
  if (cleaned === 'gemini' || cleaned === 'gemini-cli') return 'gemini-cli';
  if (cleaned === 'mcp' || cleaned === 'generic') return 'generic';
  if (SUPPORTED_MCP_HOSTS.includes(cleaned)) return cleaned;
  return null;
}

/**
 * Resolves the MCP config path for a supported AI host.
 * Strictly avoids auth credential files such as `oauth_creds.json`.
 */
export function resolveHostMcpConfigPath(host, { cwd = process.cwd(), homeDir, global = false } = {}) {
  const normalized = normalizeMcpHostName(host) || 'generic';
  const home = resolveHome({ homeDir });
  const workspaceRoot = path.resolve(cwd);

  if (normalized === 'cursor') {
    return global
      ? path.join(home, '.cursor', 'mcp.json')
      : path.join(workspaceRoot, '.cursor', 'mcp.json');
  }
  if (normalized === 'windsurf') {
    return global
      ? path.join(home, '.codeium', 'windsurf', 'mcp_config.json')
      : path.join(workspaceRoot, '.windsurf', 'mcp.json');
  }
  if (normalized === 'gemini-cli') {
    return global
      ? path.join(home, '.gemini', 'settings.json')
      : path.join(workspaceRoot, '.gemini', 'settings.json');
  }
  if (normalized === 'codex') {
    return global
      ? path.join(home, '.codex', 'mcp.json')
      : path.join(workspaceRoot, '.codex', 'mcp.json');
  }
  return path.join(workspaceRoot, '.mcp.json');
}

/**
 * Idempotently installs `{ command: 'npx', args: ['-y', 'highbeam-cli', 'mcp'] }` under `mcpServers.highbeam`
 * while preserving all existing host settings and third-party MCP servers.
 */
export function installHostMcpConfig({
  hosts = ['generic'],
  cwd = process.cwd(),
  homeDir,
  global = false,
  dryRun = false,
  useLocalServer = false,
  serverScriptPath = ''
} = {}) {
  const resolvedHome = resolveHome({ homeDir });
  const uniqueHosts = Array.from(
    new Set(
      (Array.isArray(hosts) ? hosts : [hosts])
        .map((h) => normalizeMcpHostName(h))
        .filter(Boolean)
    )
  );
  if (uniqueHosts.length === 0) uniqueHosts.push('generic');

  const serverEntry =
    useLocalServer && serverScriptPath
      ? { command: 'node', args: [serverScriptPath] }
      : { command: 'npx', args: ['-y', 'highbeam-cli', 'mcp'] };

  const results = [];
  for (const host of uniqueHosts) {
    const configPath = resolveHostMcpConfigPath(host, {
      cwd,
      homeDir: resolvedHome,
      global
    });
    const existing = readJsonObjectSafe(configPath);
    const prevServers =
      existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
        ? { ...existing.mcpServers }
        : {};
    prevServers.highbeam = { ...serverEntry };

    const updated = {
      ...existing,
      mcpServers: prevServers
    };

    if (!dryRun) {
      writeJsonAtomicSafe(configPath, updated);
    }

    const codexTomlExists =
      host === 'codex' && fs.existsSync(path.join(resolvedHome, '.codex', 'config.toml'));
    results.push({
      ok: true,
      host,
      serverKey: 'highbeam',
      configPath,
      dryRun: Boolean(dryRun),
      entry: serverEntry,
      ...(codexTomlExists ? { tomlSnippet: CODEX_TOML_SNIPPET } : {})
    });
  }

  return {
    ok: results.every((r) => r.ok),
    dryRun: Boolean(dryRun),
    hosts: uniqueHosts,
    results
  };
}
