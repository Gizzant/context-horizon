/**
 * @file src/core-isomorphic/coach/resumeToolsetAuditor.mjs
 * Session-resume MCP / tool-set change auditor (`Item 6`).
 *
 * Evidence (`t6_layers.csv` arm `CC-T`):
 *   Resuming a warm session with a changed `--mcp-config` / tool definition list invalidated
 *   the entire KV prefix (`0` cache read tokens on turn 6).
 *
 * Hook visibility on Claude Code `2.1.325` (`$0` verified):
 *   `SessionStart:resume` stdin includes `session_id`, `transcript_path`, `cwd`, `source`,
 *   `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, and
 *   `estimated_cache_write_usd` — it does NOT pass `tools` or `mcp_servers` directly, and
 *   `deferred_tools_delta` is appended to `.jsonl` after `SessionStart` during `system/init`.
 *   Therefore this auditor hashes MCP & tool configuration from `.mcp.json`, `.claude/settings*.json`,
 *   `~/.claude.json`, explicit CLI `--mcp-config`/`--tools` flags if supplied, and optional host
 *   `event.tools`/`event.mcp_servers` arrays (using pure runtime I/O adapters per Mod Law 4).
 */

import {
  basenamePath,
  fileExists,
  getCwd,
  getHomeDir,
  joinPath,
  readJsonSafe,
  readTextSafe,
  resolvePath,
  sha256Hex
} from '../utils/runtime.mjs';
import {
  isKnownCatalogModel,
  normalizeModelId,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';

function normalizeServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const envKeys =
    entry.env && typeof entry.env === 'object' ? Object.keys(entry.env).sort() : [];
  return {
    type: String(entry.type || (entry.url ? 'http' : 'stdio')),
    command: entry.command ? String(entry.command) : null,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    url: entry.url ? String(entry.url) : null,
    envKeys,
    disabled: Boolean(entry.disabled)
  };
}

function mergeMcpServers(target, sourceObj) {
  if (!sourceObj || typeof sourceObj !== 'object' || Array.isArray(sourceObj)) return;
  for (const [name, cfg] of Object.entries(sourceObj)) {
    const cleanName = String(name || '').trim();
    if (!cleanName) continue;
    const normalized = normalizeServerEntry(cfg);
    if (normalized) {
      target[cleanName] = normalized;
    }
  }
}

function parseCliMcpFlags(cliArgs = []) {
  const args = Array.isArray(cliArgs) ? cliArgs.map(String) : [];
  const mcpConfigs = [];
  const toolFlags = [];
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    if (tok === '--mcp-config' && i + 1 < args.length) {
      mcpConfigs.push(args[i + 1]);
      i += 1;
    } else if (tok.startsWith('--mcp-config=')) {
      mcpConfigs.push(tok.slice('--mcp-config='.length));
    } else if (
      (tok === '--tools' || tok === '--allowedTools' || tok === '--disallowedTools') &&
      i + 1 < args.length
    ) {
      toolFlags.push(`${tok}:${args[i + 1]}`);
      i += 1;
    } else if (
      tok.startsWith('--tools=') ||
      tok.startsWith('--allowedTools=') ||
      tok.startsWith('--disallowedTools=')
    ) {
      toolFlags.push(tok);
    }
  }
  return { mcpConfigs, toolFlags: toolFlags.sort() };
}

function tryReadParentProcCmdline(options = {}) {
  try {
    const proc = globalThis.process;
    if (proc?.platform === 'linux' && proc?.ppid) {
      const cmdlinePath = `/proc/${proc.ppid}/cmdline`;
      if (fileExists(cmdlinePath, options)) {
        const raw = readTextSafe(cmdlinePath, '', options);
        if (typeof raw === 'string' && raw.length > 0) {
          return raw.split('\0').filter(Boolean);
        }
      }
    }
  } catch {
    // Fail-open; zero subprocess spawning in hot hook path
  }
  return null;
}

/**
 * Computes a deterministic SHA-256 hash of observable active MCP server & tool configuration.
 * Strictly read-only, excludes secret env values, and never throws on malformed files.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {{ hash: string, serverNames: string[], toolCount: number, toolNames: string[], cliFlags: string[], sourcesInspected: string[], recordedAt: string }}
 */
export function computeActiveToolsetHash(event = {}, options = {}) {
  const cwd = event.cwd || getCwd(options);
  const homeDir = options.homeDir || event.homeDir || getHomeDir(options);
  const ioOpts = { ...options, cwd, homeDir };
  const mcpServers = {};
  const toolSet = new Set();
  const sourcesInspected = [];

  // 1. Optional host-provided arrays (in case host or future CLI includes them)
  if (Array.isArray(event.tools)) {
    sourcesInspected.push('event.tools');
    for (const t of event.tools) {
      const name = typeof t === 'string' ? t : t?.name || t?.id;
      if (name) toolSet.add(String(name));
    }
  }
  if (event.mcp_servers && typeof event.mcp_servers === 'object') {
    sourcesInspected.push('event.mcp_servers');
    if (Array.isArray(event.mcp_servers)) {
      for (const s of event.mcp_servers) {
        const sName = typeof s === 'string' ? s : s?.name;
        if (sName) {
          mcpServers[String(sName)] = normalizeServerEntry(
            typeof s === 'object' ? s : { type: 'configured' }
          );
        }
      }
    } else {
      mergeMcpServers(mcpServers, event.mcp_servers);
    }
  }
  if (event.mcpServers && typeof event.mcpServers === 'object') {
    sourcesInspected.push('event.mcpServers');
    mergeMcpServers(mcpServers, event.mcpServers);
  }

  // 2. ~/.claude.json user + workspace project MCP config
  if (options.includeUserClaudeJson !== false && homeDir) {
    const userClaudePath = joinPath(homeDir, '.claude.json');
    const userClaude = readJsonSafe(userClaudePath, null, ioOpts);
    if (userClaude && typeof userClaude === 'object') {
      sourcesInspected.push('home:.claude.json');
      mergeMcpServers(mcpServers, userClaude.mcpServers);
      if (cwd && userClaude.projects && typeof userClaude.projects === 'object') {
        const normCwd = resolvePath(cwd).toLowerCase();
        for (const [projPath, projCfg] of Object.entries(userClaude.projects)) {
          if (
            resolvePath(projPath).toLowerCase() === normCwd &&
            projCfg &&
            typeof projCfg === 'object'
          ) {
            mergeMcpServers(mcpServers, projCfg.mcpServers);
          }
        }
      }
    }
  }

  // 3. Project .mcp.json and .claude/settings*.json
  const projectFiles = [
    { rel: '.mcp.json', label: 'project:.mcp.json' },
    { rel: '.claude/settings.json', label: 'project:.claude/settings.json' },
    { rel: '.claude/settings.local.json', label: 'project:.claude/settings.local.json' }
  ];
  for (const pf of projectFiles) {
    const fullPath = cwd ? joinPath(cwd, pf.rel) : null;
    const parsed = fullPath ? readJsonSafe(fullPath, null, ioOpts) : null;
    if (parsed && typeof parsed === 'object') {
      sourcesInspected.push(pf.label);
      mergeMcpServers(mcpServers, parsed.mcpServers);
      if (Array.isArray(parsed.tools)) {
        for (const t of parsed.tools) {
          if (typeof t === 'string' && t.trim()) toolSet.add(t.trim());
        }
      }
      if (Array.isArray(parsed.enabledMcpjsonServers)) {
        for (const s of parsed.enabledMcpjsonServers) {
          toolSet.add(`mcp_enabled:${String(s)}`);
        }
      }
      if (Array.isArray(parsed.disabledMcpjsonServers)) {
        for (const s of parsed.disabledMcpjsonServers) {
          toolSet.add(`mcp_disabled:${String(s)}`);
        }
      }
    }
  }

  // 4. Explicit CLI args or readable parent cmdline (--mcp-config / --tools / --allowedTools)
  const rawCliArgs =
    options.cliArgs ?? event.cliArgs ?? event.cli_args ?? tryReadParentProcCmdline(ioOpts) ?? [];
  const { mcpConfigs, toolFlags } = parseCliMcpFlags(rawCliArgs);
  for (const cfgArg of mcpConfigs) {
    const resolved = cwd ? resolvePath(cwd, cfgArg) : resolvePath(cfgArg);
    const parsedCfg = readJsonSafe(resolved, null, ioOpts);
    if (parsedCfg && typeof parsedCfg === 'object') {
      sourcesInspected.push(`cli:--mcp-config(${basenamePath(resolved)})`);
      mergeMcpServers(mcpServers, parsedCfg.mcpServers || parsedCfg);
    } else {
      toolFlags.push(`mcp-config:${basenamePath(cfgArg)}`);
    }
  }

  const orderedServers = {};
  for (const name of Object.keys(mcpServers).sort()) {
    orderedServers[name] = mcpServers[name];
  }
  const toolNames = Array.from(toolSet).sort();
  const payload = {
    mcpServers: orderedServers,
    tools: toolNames,
    cliFlags: toolFlags
  };

  const hash = sha256Hex(JSON.stringify(payload), options);

  return {
    hash,
    serverNames: Object.keys(orderedServers),
    toolNames,
    toolCount: toolNames.length,
    cliFlags: toolFlags,
    sourcesInspected,
    recordedAt: new Date().toISOString()
  };
}

/**
 * Evaluates whether a changed tool-set / MCP config on `SessionStart:resume` warrants a one-line
 * cache-rewrite advisory (`Item 6`, citing `t6_layers.csv` arm `CC-T`).
 *
 * @param {object} [params={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function evaluateResumeToolsetChange(params = {}, options = {}) {
  const prev = params.previousHashRecord || null;
  const curr = params.currentHashRecord || null;
  const contextTokens = Math.max(0, Number(params.contextTokens ?? 0));
  const minTokens = Math.max(0, Number(params.minContextTokens ?? 10_000));
  const cacheExpired = Boolean(params.cacheExpired);
  const ttlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';
  const rawModel = params.modelId || 'claude-sonnet-5-5';

  if (!prev?.hash || !curr?.hash) {
    return { changed: false, shouldWarn: false, reason: 'no_baseline', advisory: null };
  }
  if (prev.hash === curr.hash) {
    return { changed: false, shouldWarn: false, reason: 'unchanged', advisory: null };
  }
  if (cacheExpired) {
    return { changed: true, shouldWarn: false, reason: 'cache_already_expired', advisory: null };
  }
  if (contextTokens < minTokens) {
    return { changed: true, shouldWarn: false, reason: 'small_or_cold_context', advisory: null };
  }

  const prevSet = new Set(Array.isArray(prev.serverNames) ? prev.serverNames : []);
  const currSet = new Set(Array.isArray(curr.serverNames) ? curr.serverNames : []);
  const added = [...currSet].filter((s) => !prevSet.has(s));
  const removed = [...prevSet].filter((s) => !currSet.has(s));
  const diffParts = [];
  if (added.length > 0) diffParts.push(`+${added.join(',+')}`);
  if (removed.length > 0) diffParts.push(`-${removed.join(',-')}`);
  const diffSummary = diffParts.length > 0 ? diffParts.join(' ') : 'MCP/tool definitions updated';

  const knownModel = isKnownCatalogModel(rawModel, options);
  if (!knownModel) {
    const advisory =
      `[Highbeam Resume Toolset Advisory] Active MCP/tool set changed (${diffSummary}); ` +
      `prices are unknown for ${String(rawModel)}, and the first turn will rewrite ~${Math.round(contextTokens).toLocaleString()} cached tokens (t6_layers CC-T).`;
    return {
      changed: true,
      shouldWarn: true,
      unknownModel: true,
      estimatedWriteCostUSD: null,
      diffSummary,
      advisory
    };
  }

  const modelId = normalizeModelId(rawModel, options);
  const rates = resolveEffectiveRates(modelId, contextTokens, options);
  const writeRate = ttlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;
  const estimatedWriteCostUSD = Number(((contextTokens / 1_000_000) * writeRate).toFixed(4));

  const advisory =
    `[Highbeam Resume Toolset Advisory] Active MCP/tool set changed (${diffSummary}); ` +
    `the first turn will rewrite ~${Math.round(contextTokens).toLocaleString()} cached tokens ` +
    `(~$${estimatedWriteCostUSD.toFixed(4)} at ${modelId} ${ttlTier} write rate, t6_layers CC-T).`;

  return {
    changed: true,
    shouldWarn: true,
    unknownModel: false,
    modelId,
    estimatedWriteCostUSD,
    diffSummary,
    advisory
  };
}

export default {
  computeActiveToolsetHash,
  evaluateResumeToolsetChange
};
