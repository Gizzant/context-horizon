import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';
import { evaluateDet13EagerMcpAuditor } from './shared/detectors.mjs';

/**
 * Rank 10 (DET-13): Read-Only Eager MCP Override & Startup Bloat Auditor
 *
 * Antigravity 1.3.3+ already defaults MCP tools to lazy loading.
 * Audits `~/.gemini/config/mcp_config.json` and workspace MCP configs strictly read-only
 * on `SessionStart` for explicit `"eager": true` overrides, unreachable stdio binaries,
 * or eager schema overhead exceeding 15,000 tokens.
 */

function isExecutableOnPath(cmdName, envPath = process.env.PATH || '') {
  if (!cmdName || typeof cmdName !== 'string') return false;
  const trimmed = cmdName.trim().replace(/^['"]|['"]$/g, () => '');
  if (!trimmed) return false;

  if (path.isAbsolute(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.includes('/') || trimmed.includes('\\')) {
    return fs.existsSync(trimmed);
  }

  // Builtin standard runtime shims commonly present
  if (/^(node|npx|npm|python|python3|uv|uvx|docker|deno|bun)(\.exe|\.cmd)?$/i.test(trimmed)) {
    const dirs = String(envPath).split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        if (fs.existsSync(path.join(dir, trimmed + ext))) return true;
      }
    }
    return false;
  }

  const dirs = String(envPath).split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, trimmed + ext))) return true;
    }
  }
  return false;
}

function parseMcpConfigFileReadOnly(configPath, { workspacePath, envPath } = {}) {
  if (!configPath || !fs.existsSync(configPath)) return [];
  let parsed = null;
  try {
    const fd = fs.openSync(configPath, 'r');
    try {
      const raw = fs.readFileSync(fd, 'utf8');
      parsed = JSON.parse(raw);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const serversMap = parsed.mcpServers || parsed.servers || parsed;
  if (!serversMap || typeof serversMap !== 'object' || Array.isArray(serversMap)) return [];

  const extracted = [];
  for (const [name, cfg] of Object.entries(serversMap)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    if (cfg.disabled === true || cfg.enabled === false) continue;

    const isHttpOrSse = Boolean(cfg.url || cfg.serverUrl || cfg.httpUrl || cfg.transport === 'sse' || cfg.transport === 'http');
    const transport = isHttpOrSse ? 'remote' : 'stdio';
    let commandReachable = true;
    if (transport === 'stdio' && typeof cfg.command === 'string') {
      const rawCmd = cfg.command.trim();
      const resolvedCmd = (rawCmd.startsWith('./') || rawCmd.startsWith('../')) && workspacePath
        ? path.resolve(workspacePath, rawCmd)
        : rawCmd;
      commandReachable = isExecutableOnPath(resolvedCmd, envPath);
    }

    const eager = cfg.eager === true || cfg.lazy === false || cfg.loadingMode === 'eager';
    const estimatedTokens = Number(
      cfg.estimatedTokens ??
      cfg.schemaTokens ??
      cfg.tokenCount ??
      (Array.isArray(cfg.eagerTools) ? cfg.eagerTools.length * 450 : (eager ? 3200 : 0))
    );

    extracted.push({
      name,
      sourceFile: configPath,
      transport,
      command: cfg.command || null,
      commandReachable,
      eager,
      estimatedTokens
    });
  }
  return extracted;
}

export function auditWorkspaceAndGlobalMcpConfigs({
  homeDir = getHomeDir(),
  workspacePath = process.cwd(),
  extraServers = [],
  eagerTokenThreshold = 15000,
  envPath = process.env.PATH || ''
} = {}) {
  const configPaths = [
    path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
    path.join(workspacePath, '.agents', 'mcp_config.json'),
    path.join(workspacePath, '.mcp.json')
  ];

  const byName = new Map();
  for (const cfgPath of configPaths) {
    const entries = parseMcpConfigFileReadOnly(cfgPath, { workspacePath, envPath });
    for (const srv of entries) {
      byName.set(srv.name, srv);
    }
  }

  if (Array.isArray(extraServers)) {
    for (const s of extraServers) {
      if (s && typeof s === 'object' && s.name) {
        byName.set(String(s.name), {
          ...byName.get(String(s.name)),
          ...s
        });
      }
    }
  }

  return evaluateDet13EagerMcpAuditor({
    servers: Array.from(byName.values()),
    eagerTokenThreshold
  });
}
