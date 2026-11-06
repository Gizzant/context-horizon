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

/** Returns `{ rows, totalEst, buckets, eagerInjectionWarning, recommendations, measuredAt }`, rows sorted by tokens desc. */
export function measureBaseline(workspaceDir, homeDir = getHomeDir()) {
  const sources = collectBaselineSources(workspaceDir, homeDir);
  const key = `${workspaceDir}|${homeDir}`;
  const sig = signatureOf(sources);
  const hit = memo.get(key);
  if (hit && hit.sig === sig) return hit.result;

  const rows = [];
  for (const src of sources) {
    const m = measureSource(src);
    if (!m || m.tokens <= 0) continue;
    rows.push({ source: src.label, kind: src.kind, path: src.path, exact: false, ...m });
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
  const eagerInjectionWarning = totalEst > 30000 || Object.values(buckets).some(b => b.usedPct >= 60);

  const recommendations = [];
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
    topHeaviest: rows.slice(0, 5),
    measuredAt: new Date().toISOString()
  };
  memo.set(key, { sig, result });
  return result;
}
