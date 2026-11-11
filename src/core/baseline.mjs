import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';

/**
 * Per-source estimate of the "workspace baseline" that is re-sent every turn:
 * rules (AGENTS.md / GEMINI.md / .agents/rules / plugin rules), the skill list
 * (name + description frontmatter only) and MCP tool listings.
 *
 * Token counts are ceil(bytes / 4) and always flagged `exact: false`.
 * MCP servers report the lazy listing cost (tool names + instructions.md) as
 * `tokens`, and the full schema size as `schemaTokens` (what eager loading would cost).
 * Results are memoised on a stat signature (path + mtime + size).
 */

const est = bytes => Math.ceil(bytes / 4);

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)); } catch { return []; }
}

function listFiles(dir, ext) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && d.name.toLowerCase().endsWith(ext)).map(d => path.join(dir, d.name)); } catch { return []; }
}

/** Extracts the YAML frontmatter block (between the first two `---` lines). */
export function frontmatterBytes(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return Buffer.byteLength(m ? m[1] : '', 'utf8');
}

export function collectBaselineSources(workspaceDir, homeDir = getHomeDir()) {
  const gemini = path.join(homeDir, '.gemini');
  const sources = [];
  const add = (kind, label, p, mode = 'full') => sources.push({ kind, label, path: p, mode });

  // Rules
  if (workspaceDir) {
    for (const name of ['AGENTS.md', 'GEMINI.md']) add('rule', `${name} (workspace)`, path.join(workspaceDir, name));
    for (const f of listFiles(path.join(workspaceDir, '.agents', 'rules'), '.md')) add('rule', `.agents/rules/${path.basename(f)}`, f);
  }
  add('rule', 'GEMINI.md (global)', path.join(gemini, 'GEMINI.md'));
  for (const plugin of listDirs(path.join(gemini, 'config', 'plugins'))) {
    for (const f of listFiles(path.join(plugin, 'rules'), '.md')) add('rule', `${path.basename(plugin)} rule: ${path.basename(f)}`, f);
  }

  // Skills (frontmatter only: the skill list is injected every turn, bodies only when read)
  const skillRoots = [
    path.join(gemini, 'config', 'skills'),
    path.join(gemini, 'antigravity', 'builtin', 'skills'),
    ...listDirs(path.join(gemini, 'config', 'plugins')).map(p => path.join(p, 'skills'))
  ];
  if (workspaceDir) skillRoots.push(path.join(workspaceDir, '.agents', 'skills'));
  for (const root of skillRoots) {
    for (const dir of listDirs(root)) add('skill', `skill: ${path.basename(dir)}`, path.join(dir, 'SKILL.md'), 'frontmatter');
  }

  // MCP servers
  for (const dir of listDirs(path.join(gemini, 'antigravity', 'mcp'))) add('mcp', `MCP: ${path.basename(dir)}`, dir, 'mcp');

  // Subagent definitions
  const subagentRoots = [
    path.join(gemini, 'config', 'agents'),
    ...listDirs(path.join(gemini, 'config', 'plugins')).map(p => path.join(p, 'agents'))
  ];
  if (workspaceDir) subagentRoots.push(path.join(workspaceDir, '.agents', 'agents'));
  for (const root of subagentRoots) {
    for (const f of listFiles(root, '.md')) add('subagent', `subagent: ${path.basename(f, '.md')}`, f);
  }

  // Workflows
  const workflowRoots = [
    path.join(gemini, 'config', 'workflows'),
    path.join(gemini, 'antigravity', 'global_workflows')
  ];
  if (workspaceDir) {
    workflowRoots.push(path.join(workspaceDir, '.agents', 'workflows'));
    workflowRoots.push(path.join(workspaceDir, '.agent', 'workflows'));
  }
  for (const root of workflowRoots) {
    for (const f of listFiles(root, '.md')) add('workflow', `workflow: ${path.basename(f, '.md')}`, f);
  }

  return sources;
}

function measureSource(src) {
  if (src.mode === 'mcp') {
    const files = listFiles(src.path, '.json');
    let schemaBytes = 0;
    let nameBytes = 0;
    for (const f of files) {
      schemaBytes += statSafe(f)?.size || 0;
      nameBytes += Buffer.byteLength(path.basename(f, '.json'), 'utf8') + 1;
    }
    const instr = statSafe(path.join(src.path, 'instructions.md'))?.size || 0;
    if (!files.length && !instr) return null;
    return { tokens: est(nameBytes + instr), schemaTokens: est(schemaBytes + instr), toolCount: files.length };
  }
  const st = statSafe(src.path);
  if (!st || !st.isFile()) return null;
  if (src.mode === 'frontmatter') {
    try { return { tokens: est(frontmatterBytes(fs.readFileSync(src.path, 'utf8'))) }; } catch { return null; }
  }
  return { tokens: est(st.size) };
}

function signatureOf(sources) {
  return sources.map(s => {
    if (s.mode === 'mcp') {
      const st = statSafe(s.path);
      return `${s.path}|${st ? st.mtimeMs : 0}|${listFiles(s.path, '.json').length}`;
    }
    const st = statSafe(s.path);
    return `${s.path}|${st ? st.mtimeMs : 0}|${st ? st.size : 0}`;
  }).join('\n');
}

const memo = new Map();

export const CUSTOMIZATION_BUCKET_BUDGET = 20000;

function normalizeMcpName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Parses `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`
 * to discover configured MCP servers, their loading mode (`eager` vs `lazy`),
 * and any inline tool schemas.
 */
export function parseMcpConfigFiles(workspaceDir = '', homeDir = getHomeDir()) {
  const candidates = [];
  if (homeDir) {
    candidates.push({
      sourceLabel: '~/.gemini/config/mcp_config.json',
      path: path.join(homeDir, '.gemini', 'config', 'mcp_config.json')
    });
  }
  if (workspaceDir) {
    candidates.push({
      sourceLabel: '.agents/mcp_config.json',
      path: path.join(workspaceDir, '.agents', 'mcp_config.json')
    });
  }

  const configPaths = [];
  const serverMap = new Map(); // serverName -> config descriptor

  for (const c of candidates) {
    const st = statSafe(c.path);
    if (!st || !st.isFile()) continue;
    configPaths.push(c.path);
    try {
      const parsed = JSON.parse(fs.readFileSync(c.path, 'utf8'));
      const rawServers = (parsed && typeof parsed === 'object')
        ? (parsed.mcpServers || parsed.servers || (!Array.isArray(parsed) ? parsed : {}))
        : {};
      for (const [serverName, rawCfg] of Object.entries(rawServers)) {
        if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) continue;
        if (rawCfg.disabled === true || rawCfg.enabled === false) continue;

        const modeRaw = String(rawCfg.loading || rawCfg.loadingMode || rawCfg.loadMode || rawCfg.mode || '').toLowerCase().trim();
        const isExplicitEager = modeRaw === 'eager' || rawCfg.eager === true;
        const loadingMode = isExplicitEager ? 'eager' : 'lazy';

        const inlineTools = Array.isArray(rawCfg.tools)
          ? rawCfg.tools
          : (Array.isArray(rawCfg.schemas) ? rawCfg.schemas : null);
        const inlineSchemaBytes = inlineTools
          ? Buffer.byteLength(JSON.stringify(inlineTools), 'utf8')
          : Buffer.byteLength(JSON.stringify(rawCfg), 'utf8');
        const explicitSchemaTokens = Number(rawCfg.schemaTokens || rawCfg.staticTokens || 0);

        serverMap.set(serverName, {
          name: serverName,
          configPath: c.path,
          configSource: c.sourceLabel,
          loadingMode,
          explicitSchemaTokens: explicitSchemaTokens > 0 ? explicitSchemaTokens : null,
          inlineSchemaTokens: est(inlineSchemaBytes),
          inlineToolCount: inlineTools ? inlineTools.length : 0
        });
      }
    } catch {}
  }

  return { configPaths, serverMap };
}

/**
 * Counts tool invocations per MCP server across the active session steps.
 */
export function countMcpServerCallsInSession(steps = [], stepEvents = []) {
  const counts = new Map(); // normalized server name -> count
  const bump = (srv) => {
    const key = normalizeMcpName(srv);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (const step of (Array.isArray(steps) ? steps : [])) {
    const calls = step?.toolCalls || step?.tool_calls || [];
    for (const call of calls) {
      const name = String(call?.name || call?.tool || '').trim();
      const args = call?.args || call?.parameters || call?.Arguments || {};
      if (name === 'call_mcp_tool' || name === 'read_resource' || name === 'list_resources') {
        const srv = args.ServerName || args.server_name || args.server;
        if (srv) bump(srv);
      } else if (/^mcp_([a-z0-9_-]+)_/i.test(name)) {
        // Check against known `mcp_<server>_<tool>` convention
        bump(name.replace(/^mcp_/i, ''));
      } else if (name.includes(':')) {
        bump(name.split(':')[0]);
      }
    }
  }

  for (const ev of (Array.isArray(stepEvents) ? stepEvents : [])) {
    const name = String(ev?.toolName || '').trim();
    if (ev?.serverName || ev?.ServerName) {
      bump(ev.serverName || ev.ServerName);
    } else if (/^mcp_([a-z0-9_-]+)_/i.test(name)) {
      bump(name.replace(/^mcp_/i, ''));
    } else if (name.includes(':')) {
      bump(name.split(':')[0]);
    }
  }

  return counts;
}

const mcpDirMemo = new Map();

/**
 * MCP Prefix Bloat & Schema Audit.
 *
 * - Parses `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`.
 * - Calculates static token overhead of registered tool schemas.
 * - Flags `eager`-loaded MCP servers that have had zero tool calls across the active session
 *   and suggests switching to `lazy` loading.
 */
export function auditMcpPrefixBloat({
  workspaceDir = '',
  homeDir = getHomeDir(),
  steps = [],
  stepEvents = []
} = {}) {
  const { configPaths, serverMap } = parseMcpConfigFiles(workspaceDir, homeDir);
  const callCounts = countMcpServerCallsInSession(steps, stepEvents);
  const mcpDirRoot = path.join(homeDir, '.gemini', 'antigravity', 'mcp');
  const rootStat = statSafe(mcpDirRoot);
  const rootSig = `${mcpDirRoot}|${rootStat ? rootStat.mtimeMs : -1}`;
  let dirServers = mcpDirMemo.get(rootSig);

  if (!dirServers) {
    dirServers = new Map();
    for (const dir of listDirs(mcpDirRoot)) {
      const serverName = path.basename(dir);
      const m = measureSource({ path: dir, mode: 'mcp' });
      if (m) {
        dirServers.set(serverName, {
          name: serverName,
          dirPath: dir,
          listingTokens: m.tokens,
          schemaTokens: m.schemaTokens,
          toolCount: m.toolCount
        });
      }
    }
    if (mcpDirMemo.size > 16) mcpDirMemo.clear();
    mcpDirMemo.set(rootSig, dirServers);
  }

  const allServerNames = new Set([
    ...serverMap.keys(),
    ...dirServers.keys()
  ]);

  // Deduplicate servers by normalized name (e.g. chrome-devtools and chrome_devtools)
  // Prefer the entry with higher schemaTokens/toolCount or the one from an explicit config file
  const deduplicatedNames = new Map();
  for (const name of allServerNames) {
    const norm = normalizeMcpName(name);
    if (!deduplicatedNames.has(norm)) {
      deduplicatedNames.set(norm, name);
    } else {
      const existingName = deduplicatedNames.get(norm);
      const existingCfg = serverMap.get(existingName);
      const existingDir = dirServers.get(existingName);
      const existingTok = existingCfg?.explicitSchemaTokens || existingDir?.schemaTokens || 0;

      const newCfg = serverMap.get(name);
      const newDir = dirServers.get(name);
      const newTok = newCfg?.explicitSchemaTokens || newDir?.schemaTokens || 0;

      if ((newCfg && !existingCfg) || newTok > existingTok) {
        deduplicatedNames.set(norm, name);
      }
    }
  }

  const servers = [];
  for (const name of deduplicatedNames.values()) {
    const cfg = serverMap.get(name) || null;
    const dirInfo = dirServers.get(name) || null;
    const loadingMode = cfg ? cfg.loadingMode : 'lazy';
    const schemaTokens = cfg?.explicitSchemaTokens
      || dirInfo?.schemaTokens
      || cfg?.inlineSchemaTokens
      || 0;
    const listingTokens = dirInfo?.listingTokens || Math.min(schemaTokens, Math.max(25, Math.round(schemaTokens * 0.1)));
    const toolCount = dirInfo?.toolCount || cfg?.inlineToolCount || 1;

    const norm = normalizeMcpName(name);
    let sessionCallCount = callCounts.get(norm) || 0;
    if (sessionCallCount === 0) {
      for (const [calledKey, cnt] of callCounts.entries()) {
        if (calledKey.startsWith(norm + '_') || calledKey === norm) {
          sessionCallCount += cnt;
        }
      }
    }

    const unusedEager = loadingMode === 'eager' && sessionCallCount === 0;
    const configSource = cfg?.configSource || '~/.gemini/config/mcp_config.json';
    const recommendation = unusedEager
      ? `Switch eager MCP server "${name}" to "lazy" loading in ${configSource} (saves ~${(schemaTokens / 1000).toFixed(1)}k static schema tokens/turn; 0 tool calls in active session).`
      : null;

    servers.push({
      name,
      configSource: cfg?.configSource || 'mcp_schema_cache',
      configPath: cfg?.configPath || dirInfo?.dirPath || '',
      loadingMode,
      schemaTokens,
      listingTokens,
      activeOverheadTokens: loadingMode === 'eager' ? schemaTokens : listingTokens,
      toolCount,
      sessionCallCount,
      unusedEager,
      recommendation
    });
  }

  servers.sort((a, b) => b.schemaTokens - a.schemaTokens);

  const unusedEagerServers = servers.filter(s => s.unusedEager);
  const totalStaticSchemaTokens = servers.reduce((s, r) => s + r.schemaTokens, 0);
  const totalEagerSchemaTokens = servers
    .filter(s => s.loadingMode === 'eager')
    .reduce((s, r) => s + r.schemaTokens, 0);
  const reclaimableEagerSchemaTokens = unusedEagerServers.reduce((s, r) => s + Math.max(0, r.schemaTokens - r.listingTokens), 0);

  return {
    configPaths,
    servers,
    unusedEagerServers,
    totalStaticSchemaTokens,
    totalEagerSchemaTokens,
    reclaimableEagerSchemaTokens,
    recommendations: unusedEagerServers.map(s => s.recommendation).filter(Boolean)
  };
}

/** Returns `{ rows, totalEst, buckets, eagerInjectionWarning, recommendations, mcpAudit, measuredAt }`, rows sorted by tokens desc. */
export function measureBaseline(workspaceDir, homeDir = getHomeDir(), options = {}) {
  const sources = collectBaselineSources(workspaceDir, homeDir);
  const mcpConfigFiles = [
    homeDir ? path.join(homeDir, '.gemini', 'config', 'mcp_config.json') : '',
    workspaceDir ? path.join(workspaceDir, '.agents', 'mcp_config.json') : ''
  ].filter(Boolean);
  const mcpCfgSig = mcpConfigFiles.map(p => {
    const st = statSafe(p);
    return `${p}|${st ? st.mtimeMs : 0}|${st ? st.size : 0}`;
  }).join('|');
  const hasSessionSteps = Array.isArray(options.steps) && options.steps.length > 0;
  const key = `${workspaceDir}|${homeDir}`;
  const sig = `${signatureOf(sources)}\n${mcpCfgSig}`;
  const hit = memo.get(key);
  if (hit && hit.sig === sig && !hasSessionSteps && !options.force) return hit.result;

  const rows = [];
  for (const src of sources) {
    const m = measureSource(src);
    if (!m || m.tokens <= 0) continue;
    rows.push({ source: src.label, kind: src.kind, path: src.path, exact: false, ...m });
  }

  const mcpAudit = auditMcpPrefixBloat({
    workspaceDir,
    homeDir,
    steps: options.steps || [],
    stepEvents: options.stepEvents || []
  });

  // Ensure any server configured in mcp_config.json is represented in rows with accurate eager/lazy overhead
  for (const srv of mcpAudit.servers) {
    const existingRow = rows.find(r => r.kind === 'mcp' && r.source === `MCP: ${srv.name}`);
    if (existingRow) {
      existingRow.loadingMode = srv.loadingMode;
      existingRow.unusedEager = srv.unusedEager;
      existingRow.sessionCallCount = srv.sessionCallCount;
      if (srv.loadingMode === 'eager') {
        existingRow.tokens = srv.schemaTokens;
      }
    } else if (srv.schemaTokens > 0) {
      rows.push({
        source: `MCP: ${srv.name}`,
        kind: 'mcp',
        path: srv.configPath,
        exact: false,
        tokens: srv.activeOverheadTokens,
        schemaTokens: srv.schemaTokens,
        toolCount: srv.toolCount,
        loadingMode: srv.loadingMode,
        unusedEager: srv.unusedEager,
        sessionCallCount: srv.sessionCallCount
      });
    }
  }

  rows.sort((a, b) => b.tokens - a.tokens);

  const bucketDefs = [
    { id: 'rule', label: 'Rules (AGENTS.md & Global)', budgetTokens: CUSTOMIZATION_BUCKET_BUDGET },
    { id: 'skill', label: 'Skills (Frontmatter Index)', budgetTokens: CUSTOMIZATION_BUCKET_BUDGET },
    { id: 'mcp', label: 'MCP Tool Listings & Instructions', budgetTokens: CUSTOMIZATION_BUCKET_BUDGET },
    { id: 'subagent', label: 'Subagent Definitions', budgetTokens: CUSTOMIZATION_BUCKET_BUDGET },
    { id: 'workflow', label: 'Workflows', budgetTokens: CUSTOMIZATION_BUCKET_BUDGET }
  ];

  const buckets = {};
  for (const b of bucketDefs) {
    const matching = rows.filter(r => r.kind === b.id);
    const tokens = matching.reduce((s, r) => s + r.tokens, 0);
    const eagerSchemaTokens = b.id === 'mcp' ? matching.reduce((s, r) => s + (r.schemaTokens || r.tokens), 0) : tokens;
    const usedPct = parseFloat(Math.min(100, (tokens / b.budgetTokens) * 100).toFixed(1));
    buckets[b.id] = {
      id: b.id,
      label: b.label,
      tokens,
      eagerSchemaTokens,
      budgetTokens: b.budgetTokens,
      usedPct,
      itemCount: matching.length
    };
  }

  const totalEst = rows.reduce((s, r) => s + r.tokens, 0);
  const eagerInjectionWarning = totalEst > 30000 || Object.values(buckets).some(b => b.usedPct >= 60) || mcpAudit.unusedEagerServers.length > 0;

  const recommendations = [...mcpAudit.recommendations];
  if (buckets.rule.tokens > 8000) {
    recommendations.push(`Move domain-specific rules out of AGENTS.md (${(buckets.rule.tokens / 1000).toFixed(1)}k tok) into on-demand .agents/skills/ frontmatter.`);
  }
  const heavyMcp = rows.filter(r => r.kind === 'mcp' && (r.schemaTokens || 0) > 5000);
  if (heavyMcp.length > 0) {
    recommendations.push(`Keep ${heavyMcp[0].source} lazy-loaded (saves ${Math.round(((heavyMcp[0].schemaTokens || 0) - heavyMcp[0].tokens) / 1000)}k eager schema tokens per turn).`);
  }

  const result = {
    rows,
    totalEst,
    buckets,
    eagerInjectionWarning,
    recommendations,
    mcpAudit,
    topHeaviest: rows.slice(0, 5),
    measuredAt: new Date().toISOString()
  };
  if (!hasSessionSteps) {
    memo.set(key, { sig, result });
  }
  return result;
}

/**
 * Computes per-MCP-server Token ROI (`calls / schemaTokens`, `tokensPerCall`, `IDLE_BLOAT_TAX`, `LOW_ROI`)
 * and tracks dynamic `deferred_tools_delta` / `mcp_instructions_delta` expansion across turns.
 */
export function computeMcpTokenRoiMatrix({
  workspaceDir = '',
  homeDir = getHomeDir(),
  steps = [],
  stepEvents = []
} = {}) {
  const audit = auditMcpPrefixBloat({ workspaceDir, homeDir, steps, stepEvents });
  let dynamicDeltaTokens = 0;

  for (const s of (steps || [])) {
    const mcpDelta = String(s?.mcp_instructions_delta || s?.attachment?.mcp_instructions_delta || '');
    const defDelta = String(s?.deferred_tools_delta || s?.attachment?.deferred_tools_delta || '');
    if (mcpDelta) dynamicDeltaTokens += Math.ceil(mcpDelta.length / 4);
    if (defDelta) dynamicDeltaTokens += Math.ceil(defDelta.length / 4);
  }

  const matrix = audit.servers.map(srv => {
    const calls = Number(srv.sessionCallCount || 0);
    const schemaTok = Number(srv.schemaTokens || 0);
    const tokensPerCall = calls > 0 ? Math.round(schemaTok / calls) : schemaTok;
    const status = (srv.loadingMode === 'eager' && calls === 0)
      ? 'IDLE_BLOAT_TAX'
      : (tokensPerCall > 3500 ? 'LOW_ROI' : 'HEALTHY_ROI');
    return {
      name: srv.name,
      loadingMode: srv.loadingMode,
      schemaTokens: schemaTok,
      sessionCallCount: calls,
      tokensPerCall,
      status,
      recommendation: srv.recommendation
    };
  });

  return {
    matrix,
    dynamicDeltaTokens,
    idleBloatServers: matrix.filter(m => m.status === 'IDLE_BLOAT_TAX'),
    totalEagerSchemaTokens: audit.totalEagerSchemaTokens,
    reclaimableEagerSchemaTokens: audit.reclaimableEagerSchemaTokens
  };
}

/**
 * Audits workspace instruction files (`AGENTS.md`, `GEMINI.md`, `.agents/CONTEXT.md`) for static rot:
 * broken `@path` references to non-existent files and oversized instruction files.
 */
export function auditInstructionStaticRot(workspaceDir = '', homeDir = getHomeDir()) {
  const ws = workspaceDir || process.cwd();
  const candidates = [
    path.join(ws, 'AGENTS.md'),
    path.join(ws, 'GEMINI.md'),
    path.join(ws, '.agents', 'CONTEXT.md')
  ];

  const brokenReferences = [];
  const inspectedFiles = [];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const tokens = est(Buffer.byteLength(content, 'utf8'));
      inspectedFiles.push({ path: filePath, tokens });

      const refs = content.match(/@([A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js|ts|tsx|json|md|py|sh|ps1|html|css))/g) || [];
      for (const rawRef of refs) {
        const rel = rawRef.slice(1);
        const resolved = path.resolve(ws, rel);
        if (!fs.existsSync(resolved)) {
          brokenReferences.push({
            ruleFile: path.basename(filePath),
            reference: rawRef,
            resolvedPath: resolved
          });
        }
      }
    } catch {}
  }

  return {
    inspectedFiles,
    brokenReferences,
    hasStaticRot: brokenReferences.length > 0
  };
}

