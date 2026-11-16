/**
 * @file src/core/rsl_clash_auditor.mjs
 * Deterministic Dual-Platform Rule Clash & Polarity Auditor + Spec Consolidation Helper.
 *
 * Scans `AGENTS.md`, `CLAUDE.md`, `.agents/rules/*.md`, and `.claude/rules/*.md` read-only
 * (strictly excluding `packages/airlock/`) to catch opposite-polarity imperatives sharing an
 * overlapping scope and identical technical anchor before conflicting RSL rules activate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isExcludedFromRslScan } from './rsl_triage.mjs';

const NEG_POLARITY_RE =
  /\b(?:never|do\s+not|don't|must\s+not|must\s+never|forbid(?:den)?|prohibit(?:ed)?|avoid)\b/i;
const POS_POLARITY_RE = /\b(?:always|must|require(?:d|s)?|enforce|mandate|prefer)\b/i;
const BACKTICK_TOKEN_RE = /`([^`\n]{2,80})`/g;
const PATH_TOKEN_RE = /(?:@([A-Za-z0-9_./\\-]{3,80})|\b([A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|go|rs|json|ya?ml|md|db|sqlite|env|sh))\b)/gi;
const ENV_UNIT_RE = /\bunit(?:\s+tests?)?\b/i;
const ENV_INT_RE = /\b(?:integration|e2e|end-to-end)\b/i;
const ENV_PROD_RE = /\bprod(?:uction)?\b/i;
const ENV_DEV_RE = /\b(?:dev(?:elopment)?|local|staging|mock(?:ed)?\s+tests?)\b/i;
const STOP_ANCHORS = new Set(['true', 'false', 'null', 'undefined', 'json', 'utf8', 'utf-8', 'yes', 'no', 'on', 'off', 'read', 'write', 'file', 'code']);

function readFileReadOnlyUtf8(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) return '';
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, buf, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

function parseRuleFrontmatter(markdown = '') {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    return { trigger: '', globs: [], paths: [], description: '', body: normalized };
  }
  const fmBlock = fmMatch[1];
  const body = normalized.slice(fmMatch[0].length);
  const trigger = (fmBlock.match(/^trigger:\s*([^\n]+)/im)?.[1] || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  const description = (fmBlock.match(/^description:\s*([^\n]+)/im)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  const globsRaw = (fmBlock.match(/^globs:\s*([^\n]+)/im)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  const globs = globsRaw ? globsRaw.split(',').map((g) => g.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];

  const paths = [];
  const inlinePaths = fmBlock.match(/^paths:\s*\[([^\]]*)\]/im)?.[1];
  if (inlinePaths) {
    for (const part of inlinePaths.split(',')) {
      const clean = part.trim().replace(/^["']|["']$/g, '');
      if (clean) paths.push(clean);
    }
  } else {
    const pathsBlock = fmBlock.match(/^paths:\s*\n((?:\s+-\s+[^\n]+\n?)+)/im)?.[1] || '';
    for (const line of pathsBlock.split('\n')) {
      const item = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
      if (item) paths.push(item);
    }
  }
  return { trigger, globs, paths, description, body };
}

function extractEnvQualifiers(text = '') {
  const envs = new Set();
  if (ENV_UNIT_RE.test(text)) envs.add('unit');
  if (ENV_INT_RE.test(text)) envs.add('integration');
  if (ENV_PROD_RE.test(text)) envs.add('prod');
  if (ENV_DEV_RE.test(text)) envs.add('dev');
  return envs;
}

function areEnvsDisjoint(envsA, envsB) {
  if (!envsA || !envsB || envsA.size === 0 || envsB.size === 0) return false;
  for (const tag of envsA) {
    if (envsB.has(tag)) return false;
  }
  return true;
}

function extractAnchors(clause = '') {
  const anchors = new Set();
  for (const m of clause.matchAll(BACKTICK_TOKEN_RE)) {
    const raw = m[1].trim().replace(/^@/, '').toLowerCase();
    if (raw.length >= 2 && !STOP_ANCHORS.has(raw)) anchors.add(raw);
  }
  for (const m of clause.matchAll(PATH_TOKEN_RE)) {
    const tok = (m[1] || m[2] || '').trim().replace(/\\/g, '/').toLowerCase();
    if (tok.length >= 3 && !STOP_ANCHORS.has(tok)) anchors.add(tok);
  }
  for (const m of clause.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) {
    anchors.add(m[1].toLowerCase());
  }
  if (/\b(?:mock|stub|spy)\b[^.!?;]{0,24}\b(?:database|db|sqlite)\b/i.test(clause)) {
    anchors.add('mock:database');
  }
  if (/\b(?:mock|stub|spy)\b[^.!?;]{0,24}\b(?:external|network|http|i\/o|io)\b/i.test(clause)) {
    anchors.add('mock:external-io');
  }
  if (/\bdefault\s+exports?\b/i.test(clause)) anchors.add('export:default');
  if (/\bfull\s+files?\b|\bentire\s+files?\b/i.test(clause)) anchors.add('read:full-file');
  return Array.from(anchors);
}

/**
 * Extracts imperative polarity directives with concrete technical anchors and environment tags.
 * @param {string} markdown
 * @param {object} [meta={}]
 */
export function extractRuleDirectives(markdown = '', meta = {}) {
  const parsed = parseRuleFrontmatter(markdown);
  const scopePatterns = (parsed.globs.length > 0 ? parsed.globs : parsed.paths).length > 0
    ? (parsed.globs.length > 0 ? parsed.globs : parsed.paths)
    : (Array.isArray(meta.globs) ? meta.globs : []);
  const scopeType =
    meta.scopeType ||
    (parsed.trigger === 'always_on' || scopePatterns.includes('**')
      ? 'always_on'
      : scopePatterns.length > 0
        ? 'glob'
        : parsed.trigger || (meta.source?.startsWith('.claude/rules/') ? 'always_on' : 'model_decision'));

  const lines = parsed.body.split('\n');
  const directives = [];
  let inCodeFence = false;

  const inspectText = (text) => {
    const clauses = String(text || '').split(/[;]+|(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
    for (const clause of clauses) {
      const isNeg = NEG_POLARITY_RE.test(clause);
      const isPos = !isNeg && POS_POLARITY_RE.test(clause);
      if (!isNeg && !isPos) continue;
      const anchors = extractAnchors(clause);
      if (anchors.length === 0) continue;
      directives.push({
        source: meta.source || 'inline',
        slug: meta.slug || 'rule',
        scopeType,
        globs: scopePatterns.map((g) => g.toLowerCase()),
        polarity: isNeg ? 'NEGATIVE' : 'POSITIVE',
        anchors,
        envs: Array.from(extractEnvQualifiers(clause)),
        excerpt: clause.replace(/^[-*+\s#]+/, '').slice(0, 160)
      });
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || !trimmed || trimmed.startsWith('<!--')) continue;
    inspectText(trimmed);
  }
  if (directives.length === 0 && parsed.description) {
    inspectText(parsed.description);
  }
  return directives;
}

function getGlobExtension(glob = '') {
  const m = String(glob || '').toLowerCase().match(/\*\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function getGlobDirPrefix(glob = '') {
  return String(glob || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/?\*\*.*$/, '')
    .replace(/\/?\*[^/]*$/, '')
    .replace(/\/+$/, '');
}

function doGlobPairOverlap(g1 = '', g2 = '') {
  const a = String(g1 || '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  const b = String(g2 || '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!a || !b || a === b || a === '**' || b === '**' || a === '*' || b === '*') return true;
  const extA = getGlobExtension(a);
  const extB = getGlobExtension(b);
  if (extA && extB && extA !== extB) return false;
  const dirA = getGlobDirPrefix(a);
  const dirB = getGlobDirPrefix(b);
  if (dirA && dirB && dirA !== dirB && !dirA.startsWith(`${dirB}/`) && !dirB.startsWith(`${dirA}/`)) {
    return false;
  }
  return true;
}

/**
 * Checks whether two rule scopes can fire on the same file or turn.
 * @param {object} ruleA
 * @param {object} ruleB
 * @returns {boolean}
 */
export function doRuleScopesOverlap(ruleA = {}, ruleB = {}) {
  if (ruleA.scopeType === 'always_on' || ruleB.scopeType === 'always_on') return true;
  const globsA = Array.isArray(ruleA.globs) ? ruleA.globs : [];
  const globsB = Array.isArray(ruleB.globs) ? ruleB.globs : [];
  if (globsA.length === 0 || globsB.length === 0) return true;
  return globsA.some((ga) => globsB.some((gb) => doGlobPairOverlap(ga, gb)));
}

/**
 * Detects opposite-polarity imperative rule conflicts across parsed rule documents.
 * @param {Array<object>} ruleDocs
 */
export function detectRuleClashes(ruleDocs = []) {
  const allDirectives = [];
  for (const doc of ruleDocs) {
    if (!doc || !doc.content) continue;
    allDirectives.push(...extractRuleDirectives(doc.content, doc));
  }

  const clashes = [];
  const seenKeys = new Set();
  for (let i = 0; i < allDirectives.length; i++) {
    const a = allDirectives[i];
    for (let j = i + 1; j < allDirectives.length; j++) {
      const b = allDirectives[j];
      if (a.slug === b.slug || a.source === b.source || a.polarity === b.polarity) continue;
      if (!doRuleScopesOverlap(a, b)) continue;
      if (areEnvsDisjoint(new Set(a.envs), new Set(b.envs))) continue;
      const sharedAnchor = a.anchors.find((anc) => b.anchors.includes(anc));
      if (!sharedAnchor) continue;
      const pairKey = [a.slug, b.slug].sort().join('::') + `::${sharedAnchor}`;
      if (seenKeys.has(pairKey)) continue;
      seenKeys.add(pairKey);
      clashes.push({
        id: `RULE_CONFLICT:${pairKey}`,
        code: 'RULE_CONFLICT',
        sourceA: a.source,
        sourceB: b.source,
        slugA: a.slug,
        slugB: b.slug,
        polarityA: a.polarity,
        polarityB: b.polarity,
        anchor: sharedAnchor,
        excerptA: a.excerpt,
        excerptB: b.excerpt,
        reason: `[RULE_CONFLICT] "${a.source}" (${a.polarity}) and "${b.source}" (${b.polarity}) clash on \`${sharedAnchor}\`.`
      });
    }
  }
  return clashes;
}

/**
 * Scans workspace rule files (strictly excluding `packages/airlock/`) and checks optional candidate RSL item.
 * @param {string} [workspaceRoot=process.cwd()]
 * @param {object|null} [candidateItem=null]
 */
export function auditWorkspaceRuleClashes(workspaceRoot = process.cwd(), candidateItem = null) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const docs = [];
  const loadedRslSlugs = new Set();

  for (const topFile of ['AGENTS.md', 'CLAUDE.md']) {
    if (isExcludedFromRslScan(topFile)) continue;
    const abs = path.join(baseRoot, topFile);
    const content = readFileReadOnlyUtf8(abs);
    if (content) {
      docs.push({
        source: topFile,
        slug: topFile.toLowerCase().replace(/\./g, '-'),
        scopeType: 'always_on',
        globs: ['**'],
        content
      });
    }
  }

  for (const relDir of ['.agents/rules', '.claude/rules']) {
    const absDir = path.join(baseRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    try {
      for (const ent of fs.readdirSync(absDir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        const relPath = `${relDir}/${ent.name}`;
        if (isExcludedFromRslScan(relPath)) continue;
        const isRsl = ent.name.startsWith('rsl-');
        const slug = (isRsl ? ent.name.slice(4) : ent.name).replace(/\.md$/i, '').toLowerCase();
        // Skip dual-compiled `.claude/rules/rsl-*` copy when `.agents/rules/rsl-*` is present so same slug never self-compares
        if (relDir === '.claude/rules' && isRsl && loadedRslSlugs.has(slug)) continue;
        if (isRsl) loadedRslSlugs.add(slug);
        const content = readFileReadOnlyUtf8(path.join(absDir, ent.name));
        if (content) docs.push({ source: relPath, slug, content });
      }
    } catch {
      // Ignore unreadable rule dir
    }
  }

  let candidateSlug = null;
  if (candidateItem && candidateItem.carrier !== 'skill_workflow') {
    candidateSlug = String(candidateItem.slug || 'candidate-rule').toLowerCase();
    const candidateGlobs = Array.isArray(candidateItem.paths) && candidateItem.paths.length > 0
      ? candidateItem.paths
      : String(candidateItem.globs || '').split(',').map((g) => g.trim()).filter(Boolean);
    const body = [
      candidateGlobs.length > 0 ? `---\ntrigger: glob\nglobs: "${candidateGlobs.join(', ')}"\n---` : '---\ntrigger: model_decision\n---',
      candidateItem.when_condition || '',
      candidateItem.then_guidance || candidateItem.description || ''
    ].filter(Boolean).join('\n');
    const filteredDocs = docs.filter((d) => d.slug !== candidateSlug);
    const allClashes = detectRuleClashes([
      ...filteredDocs,
      { source: `candidate:rsl-${candidateSlug}`, slug: candidateSlug, globs: candidateGlobs, content: body }
    ]);
    const candidateClashes = allClashes.filter((c) => c.slugA === candidateSlug || c.slugB === candidateSlug);
    return { clashCount: allClashes.length, clashes: allClashes, candidateClashes };
  }

  const clashes = detectRuleClashes(docs);
  return { clashCount: clashes.length, clashes, candidateClashes: [] };
}

/**
 * Builds a concise Consolidated Requirements Contract merging Turn-1 goal, recorded sharded constraints,
 * and `git diff --stat` (excluding `packages/airlock/`).
 *
 * @param {string} [workspaceRoot=process.cwd()]
 * @param {object} [options={}]
 */
export function buildConsolidatedSpecMarkdown(workspaceRoot = process.cwd(), options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const telemetryDir = path.join(baseRoot, '.agents', 'telemetry');
  let initialGoal = String(options.initialGoal || '').trim();
  let shards = Array.isArray(options.specShards) ? options.specShards : [];

  if (shards.length === 0 && fs.existsSync(telemetryDir)) {
    try {
      const files = fs.readdirSync(telemetryDir)
        .filter((n) => n.startsWith('prompt_state.') && n.endsWith('.json'))
        .map((n) => ({ name: n, full: path.join(telemetryDir, n), mtime: fs.statSync(path.join(telemetryDir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const target = options.sessionId
        ? files.find((f) => f.name.includes(String(options.sessionId))) || files[0]
        : files[0];
      if (target) {
        const parsed = JSON.parse(readFileReadOnlyUtf8(target.full) || '{}');
        initialGoal = initialGoal || String(parsed.initialGoal || '').trim();
        shards = Array.isArray(parsed.specShards) ? parsed.specShards : [];
      }
    } catch {
      // Ignore missing telemetry
    }
  }

  let changedFiles = [];
  if (options.includeGitDiff !== false) {
    try {
      const rawDiff = execFileSync('git', ['diff', '--stat', '--name-only'], {
        cwd: baseRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500
      });
      changedFiles = rawDiff
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/\\/g, '/'))
        .filter((l) => l && !isExcludedFromRslScan(l))
        .slice(0, 15);
    } catch {
      // Not a git repo or git unavailable
    }
  }

  const lines = [
    '# Consolidated Requirements Contract',
    '',
    '## Objective',
    initialGoal || '(No initial Turn-1 goal recorded; summarize target objective before editing.)',
    '',
    '## Consolidated Constraint Shards'
  ];
  if (shards.length === 0) {
    lines.push('- (No incremental requirement shards recorded yet.)');
  } else {
    for (const s of shards) {
      lines.push(`- Turn ${s.turn || '?'}: ${String(s.excerpt || '').trim()}`);
    }
  }
  lines.push('', '## Touched Files');
  if (changedFiles.length === 0) {
    lines.push('- (Clean working tree / no uncommitted files)');
  } else {
    for (const f of changedFiles) lines.push(`- \`${f}\``);
  }
  lines.push('', '## Verification Gate', '- Run targeted tests and `node bin/ctxtop.mjs verify --json` before stopping.', '');

  return {
    ok: true,
    workspaceRoot: baseRoot,
    initialGoal,
    shardCount: shards.length,
    specShards: shards,
    changedFiles,
    consolidatedMarkdown: lines.join('\n')
  };
}
