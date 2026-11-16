/**
 * @file src/core/rsl_ledger.mjs
 * Stage 3 Dual-Platform ExpeL Importance Ledger & Simultaneous Carrier Compiler.
 *
 * Compiles validated heuristics simultaneously into:
 *   - Carrier A: `.agents/rules/rsl-<slug>.md` AND `.claude/rules/rsl-<slug>.md`
 *   - Carrier B: `.agents/skills/rsl-<slug>/SKILL.md` AND `.claude/skills/rsl-<slug>/SKILL.md`
 *   - Carrier C: `.agents/hooks.json` (`PreToolUse`) AND `.claude/settings.json` (`PreToolUse`)
 *
 * Governs lifecycle weights (`importance: 2` init, `+1` clean reuse, `-1` repeat violation,
 * `<= 0` dual-platform deletion, `>= 5` or `>= 2` repeat violations -> deterministic hook promotion).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { RSL_CONSTANTS } from './constants.mjs';
import { auditClaudeAutoMemory } from './shield_manager.mjs';
import { toKebabSlug } from './rsl_distiller.mjs';
import { humanizeLearnedRule } from '../core-isomorphic/catalog/safeguardGuide.mjs';
import {
  extractRuleDirectives,
  doRuleScopesOverlap,
  detectRuleClashes,
  auditWorkspaceRuleClashes,
  buildConsolidatedSpecMarkdown
} from './rsl_clash_auditor.mjs';

export {
  extractRuleDirectives,
  doRuleScopesOverlap,
  detectRuleClashes,
  auditWorkspaceRuleClashes,
  buildConsolidatedSpecMarkdown
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RSL_PKG_ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');

const ANTIGRAVITY_RSL_HOOK_RE = /src[\\/]hooks[\\/]antigravity_rsl_hook\.mjs/i;
const CLAUDE_RSL_HOOK_RE = /src[\\/]hooks[\\/]claude_rsl_hook\.mjs/i;

/**
 * Resolves `<workspaceRoot>/.agents/telemetry/rsl_ledger.json`.
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function getRslLedgerPath(workspaceRoot = process.cwd()) {
  return path.join(path.resolve(workspaceRoot), '.agents', 'telemetry', 'rsl_ledger.json');
}

function createEmptyLedger() {
  return {
    schemaVersion: '2026.11.1',
    updatedAt: new Date().toISOString(),
    stats: {
      taintedSessions: 0,
      prunedCount: 0,
      lastSessionId: null,
      lastPlatform: null
    },
    items: {}
  };
}

/**
 * Reads `.agents/telemetry/rsl_ledger.json` safely.
 * @param {string} [workspaceRoot=process.cwd()]
 * @returns {object}
 */
export function readRslLedger(workspaceRoot = process.cwd()) {
  const ledgerPath = getRslLedgerPath(workspaceRoot);
  if (!fs.existsSync(ledgerPath)) {
    return createEmptyLedger();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return createEmptyLedger();
    return {
      schemaVersion: parsed.schemaVersion || '2026.11.1',
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      stats: {
        taintedSessions: Number(parsed.stats?.taintedSessions || 0),
        prunedCount: Number(parsed.stats?.prunedCount || 0),
        lastSessionId: parsed.stats?.lastSessionId || null,
        lastPlatform: parsed.stats?.lastPlatform || null
      },
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {}
    };
  } catch {
    return createEmptyLedger();
  }
}

/**
 * Atomically persists `.agents/telemetry/rsl_ledger.json`.
 * @param {string} workspaceRoot
 * @param {object} ledger
 */
export function writeRslLedger(workspaceRoot, ledger) {
  const ledgerPath = getRslLedgerPath(workspaceRoot);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const payload = {
    ...ledger,
    updatedAt: new Date().toISOString()
  };
  atomicWriteFileSync(ledgerPath, `${JSON.stringify(payload, null, 2)}\n`);
  return ledgerPath;
}

/**
 * Rewrites Antigravity `@[label](path)` inline includes into canonical `@path` pointers
 * so target files are not expanded prior to the 24,000-byte truncation check.
 * Also strips Claude-only `$ARGUMENTS` syntax.
 *
 * @param {string} text
 * @returns {string}
 */
export function rewriteAntigravityReferences(text = '') {
  return String(text || '')
    .replace(/@\[[^\]]*\]\(([^)\s]+)\)/g, (_, target) => `@${target.replace(/\\/g, '/')}`)
    .replace(/\$ARGUMENTS\b/gi, '')
    .trim();
}

/**
 * Rewrites Antigravity `@[label](path)` and bare `@path/file` tokens into backtick-wrapped paths
 * for Claude Code `.claude/rules/` (preventing eager `@path` file imports).
 *
 * @param {string} text
 * @returns {string}
 */
export function rewriteClaudeReferences(text = '') {
  return String(text || '')
    .replace(/@\[[^\]]*\]\(([^)\s]+)\)/g, (_, target) => `\`${target.replace(/\\/g, '/')}\``)
    .replace(/(^|[^a-zA-Z0-9_`])@([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+|\.[a-zA-Z0-9_.-]+|[a-zA-Z0-9_.-]+\.[a-z]{1,6})/g, '$1`$2`')
    .trim();
}

/**
 * Enforces strict Agent Skills third-person description hygiene without `"You are"`,
 * `"PROACTIVELY"`, or `$ARGUMENTS`.
 *
 * @param {string} desc
 * @param {string} slug
 * @returns {string}
 */
export function sanitizeSkillDescription(desc = '', slug = 'workflow') {
  let clean = String(desc || '')
    .replace(/\bYou are\b[^.]*\.?/gi, '')
    .replace(/\bPROACTIVELY\b/gi, '')
    .replace(/\$ARGUMENTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\bUse when\b/i.test(clean)) {
    clean = `Use when executing the ${slug} workflow${clean ? `: ${clean}` : ''}.`;
  }
  if (!/\bDo not use\b/i.test(clean)) {
    clean = `${clean.replace(/\.+$/, '')}. Do not use for unrelated tasks.`;
  }
  return clean;
}

function truncateToUtf8ByteCap(text, maxBytes = RSL_CONSTANTS.MAX_RULE_FILE_BYTES) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const lines = text.split('\n');
  const out = [];
  let currentBytes = 0;
  const suffix = '\n<!-- truncated by Highbeam RSL 24KB budget -->\n';
  const limit = maxBytes - Buffer.byteLength(suffix, 'utf8');
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (currentBytes + lineBytes > limit) break;
    out.push(line);
    currentBytes += lineBytes;
  }
  return `${out.join('\n')}${suffix}`;
}

/**
 * Estimates aggregate rule tokens across `AGENTS.md`, `GEMINI.md`, and `.agents/rules/*.md`.
 * @param {string} workspaceRoot
 * @returns {{ totalBytes: number, totalTokens: number, budgetTokens: number, pct: number, files: Array<object> }}
 */
export function measureWorkspaceRuleBudget(workspaceRoot = process.cwd()) {
  const baseRoot = path.resolve(workspaceRoot);
  const files = [];
  let totalBytes = 0;

  for (const topFile of ['AGENTS.md', 'GEMINI.md']) {
    const abs = path.join(baseRoot, topFile);
    if (fs.existsSync(abs)) {
      try {
        const bytes = fs.statSync(abs).size;
        totalBytes += bytes;
        files.push({ path: topFile, bytes, tokens: Math.ceil(bytes / 4) });
      } catch {
        // Ignore
      }
    }
  }

  const agRulesDir = path.join(baseRoot, '.agents', 'rules');
  if (fs.existsSync(agRulesDir)) {
    try {
      for (const ent of fs.readdirSync(agRulesDir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        const abs = path.join(agRulesDir, ent.name);
        const bytes = fs.statSync(abs).size;
        totalBytes += bytes;
        files.push({
          path: `.agents/rules/${ent.name}`,
          bytes,
          tokens: Math.ceil(bytes / 4)
        });
      }
    } catch {
      // Ignore
    }
  }

  const totalTokens = Math.ceil(totalBytes / 4);
  const budgetTokens = RSL_CONSTANTS.AGGREGATE_RULE_TOKEN_BUDGET;
  return {
    totalBytes,
    totalTokens,
    budgetTokens,
    pct: Math.min(100, Math.round((totalTokens / budgetTokens) * 100)),
    files
  };
}

function buildAntigravityRuleMarkdown(item) {
  const globs = String(item.globs || '').trim();
  const trigger = globs ? 'glob' : 'model_decision';
  const desc = rewriteAntigravityReferences(item.description || item.when_condition || item.slug).replace(/"/g, '\\"');
  const whenTxt = rewriteAntigravityReferences(item.when_condition || '');
  const guideTxt = rewriteAntigravityReferences(item.then_guidance || '');

  const fmLines = [
    '---',
    `trigger: ${trigger}`
  ];
  if (trigger === 'glob') {
    fmLines.push(`globs: "${globs.replace(/"/g, '')}"`);
  }
  fmLines.push(`description: "${desc}"`);
  fmLines.push('---');

  const body = [
    ...fmLines,
    '',
    `# RSL Learned Heuristic: ${item.slug}`,
    '',
    `- **Condition**: ${whenTxt}`,
    `- **Guidance**: ${guideTxt}`,
    `- **Importance**: ${item.importance} (${item.sourcePlatform || 'dual'} origin)`,
    ''
  ].join('\n');

  return truncateToUtf8ByteCap(body, RSL_CONSTANTS.MAX_RULE_FILE_BYTES - 128);
}

function buildClaudeRuleMarkdown(item) {
  const paths = Array.isArray(item.paths) && item.paths.length > 0
    ? item.paths
    : String(item.globs || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

  const whenTxt = rewriteClaudeReferences(item.when_condition || '');
  const guideTxt = rewriteClaudeReferences(item.then_guidance || '');

  const fmLines = ['---'];
  if (paths.length > 0) {
    fmLines.push('paths:');
    for (const p of paths) {
      fmLines.push(`  - "${p.replace(/"/g, '')}"`);
    }
  } else {
    fmLines.push(`description: "${rewriteClaudeReferences(item.description || item.slug).replace(/"/g, '\\"')}"`);
  }
  fmLines.push('---');

  return [
    ...fmLines,
    '',
    `# RSL Learned Heuristic: ${item.slug}`,
    '',
    `- **Condition**: ${whenTxt}`,
    `- **Guidance**: ${guideTxt}`,
    `- **Importance**: ${item.importance} (${item.sourcePlatform || 'dual'} origin)`,
    ''
  ].join('\n');
}

function buildAntigravitySkillMarkdown(item) {
  const slug = toKebabSlug(item.slug);
  const desc = sanitizeSkillDescription(
    rewriteAntigravityReferences(item.description || item.when_condition),
    slug
  );
  const steps = Array.isArray(item.steps) && item.steps.length > 0
    ? item.steps.map((s, idx) => `${idx + 1}. ${rewriteAntigravityReferences(s.replace(/^\d+\.\s*/, ''))}`)
    : [`1. ${rewriteAntigravityReferences(item.then_guidance)}`];

  return [
    '---',
    `name: rsl-${slug}`,
    `description: "${desc.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `# RSL Workflow: ${slug}`,
    '',
    '## When to Apply',
    rewriteAntigravityReferences(item.when_condition || desc),
    '',
    '## Verified Steps',
    ...steps,
    '',
    '## Validation',
    'Verify the targeted command or test suite passes with zero skipped assertions.',
    ''
  ].join('\n');
}

function buildClaudeSkillMarkdown(item) {
  const slug = toKebabSlug(item.slug);
  const desc = sanitizeSkillDescription(
    rewriteClaudeReferences(item.description || item.when_condition),
    slug
  );
  const steps = Array.isArray(item.steps) && item.steps.length > 0
    ? item.steps.map((s, idx) => `${idx + 1}. ${rewriteClaudeReferences(s.replace(/^\d+\.\s*/, ''))}`)
    : [`1. ${rewriteClaudeReferences(item.then_guidance)}`];

  return [
    '---',
    `name: rsl-${slug}`,
    `description: "${desc.replace(/"/g, '\\"')}"`,
    'argument-hint: "[target]"',
    'allowed-tools: Read Bash',
    '---',
    '',
    `# RSL Workflow: ${slug}`,
    '',
    '## When to Apply',
    rewriteClaudeReferences(item.when_condition || desc),
    '',
    '## Verified Steps',
    ...steps,
    '',
    '## Validation',
    'Verify the targeted command or test suite passes cleanly.',
    ''
  ].join('\n');
}

function removeDualCarrierFiles(workspaceRoot, slug) {
  const safeSlug = toKebabSlug(slug);
  const targets = [
    path.join(workspaceRoot, '.agents', 'rules', `rsl-${safeSlug}.md`),
    path.join(workspaceRoot, '.claude', 'rules', `rsl-${safeSlug}.md`)
  ];
  for (const file of targets) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      // Non-fatal
    }
  }
  const skillDirs = [
    path.join(workspaceRoot, '.agents', 'skills', `rsl-${safeSlug}`),
    path.join(workspaceRoot, '.claude', 'skills', `rsl-${safeSlug}`)
  ];
  for (const dir of skillDirs) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Synchronizes promoted Carrier C (`PreToolUse`) deterministic deny guards into
 * both `<workspaceRoot>/.agents/hooks.json` and `<workspaceRoot>/.claude/settings.json`
 * (never setting `disableAllHooks: true`).
 *
 * @param {string} workspaceRoot
 * @param {object} ledger
 * @param {object} [options={}]
 */
export function syncPromotedDualHooks(workspaceRoot, ledger, options = {}) {
  const baseRoot = path.resolve(workspaceRoot);
  const pkgRoot = String(options.pkgRoot || RSL_PKG_ROOT).replace(/\\/g, '/').replace(/\/+$/, '');
  const promoted = Object.values(ledger?.items || {}).filter(
    (it) =>
      it &&
      it.status === 'active' &&
      (it.promotedHook === true ||
        it.carrier === 'pre_tool_hook' ||
        Number(it.importance || 0) >= RSL_CONSTANTS.PROMOTE_HOOK_IMPORTANCE ||
        Number(it.violationCount || 0) >= RSL_CONSTANTS.REPEAT_VIOLATION_THRESHOLD)
  );

  // 1. Antigravity `.agents/hooks.json`
  const agHooksPath = path.join(baseRoot, '.agents', 'hooks.json');
  let agDoc = {};
  if (fs.existsSync(agHooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(agHooksPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        agDoc = { ...parsed };
      }
    } catch {
      agDoc = {};
    }
  }

  if (promoted.length > 0) {
    const agMatchers = Array.from(
      new Set(
        promoted
          .flatMap((it) => String(it.toolMatcher || 'run_command|edit_file|write_file').split('|'))
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    const agDir = path.dirname(agHooksPath);
    const agHookAbs = `${pkgRoot}/src/hooks/antigravity_rsl_hook.mjs`;
    const relAg = path.relative(agDir, agHookAbs).replace(/\\/g, '/');
    const agScriptPath =
      relAg && !relAg.startsWith('..') && !path.isAbsolute(relAg) ? relAg : agHookAbs;
    const safeAgScript = /\s/.test(agScriptPath) ? `"${agScriptPath}"` : agScriptPath;
    agDoc['ctxtop-rsl-guards'] = {
      enabled: true,
      PreToolUse: [
        {
          matcher: agMatchers.join('|') || '*',
          hooks: [
            {
              type: 'command',
              command: `node ${safeAgScript} --event=PreToolUse`,
              timeout: 5
            }
          ]
        }
      ]
    };
    fs.mkdirSync(path.dirname(agHooksPath), { recursive: true });
    atomicWriteFileSync(agHooksPath, `${JSON.stringify(agDoc, null, 2)}\n`);
  } else if ('ctxtop-rsl-guards' in agDoc) {
    delete agDoc['ctxtop-rsl-guards'];
    if (fs.existsSync(agHooksPath)) {
      atomicWriteFileSync(agHooksPath, `${JSON.stringify(agDoc, null, 2)}\n`);
    }
  }

  // 2. Claude Code `.claude/settings.json` (never sets disableAllHooks: true)
  const ccSettingsPath = path.join(baseRoot, '.claude', 'settings.json');
  let ccDoc = {};
  if (fs.existsSync(ccSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ccSettingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        ccDoc = { ...parsed };
      }
    } catch {
      ccDoc = {};
    }
  }

  if (promoted.length > 0) {
    const ccMatchers = Array.from(
      new Set(
        promoted
          .flatMap((it) => String(it.claudeToolMatcher || 'Bash|PowerShell|Edit|MultiEdit|Write').split('|'))
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    const prevHooks = ccDoc.hooks && typeof ccDoc.hooks === 'object' && !Array.isArray(ccDoc.hooks)
      ? { ...ccDoc.hooks }
      : {};
    const existingPre = Array.isArray(prevHooks.PreToolUse) ? prevHooks.PreToolUse : [];
    const filteredPre = existingPre.filter((entry) => {
      const cmds = [
        entry?.command,
        ...(Array.isArray(entry?.hooks) ? entry.hooks.map((h) => h?.command) : [])
      ].map((c) => String(c || ''));
      return !cmds.some((c) => CLAUDE_RSL_HOOK_RE.test(c) && c.includes('--event=PreToolUse'));
    });

    const ccHookAbs = `${pkgRoot}/src/hooks/claude_rsl_hook.mjs`;
    const safeCcScript = /\s/.test(ccHookAbs) ? `"${ccHookAbs}"` : ccHookAbs;
    filteredPre.push({
      matcher: ccMatchers.join('|') || 'Bash|PowerShell|Edit|MultiEdit|Write',
      hooks: [
        {
          type: 'command',
          command: `node ${safeCcScript} --event=PreToolUse`
        }
      ]
    });

    ccDoc.hooks = {
      ...prevHooks,
      PreToolUse: filteredPre
    };
    if (ccDoc.disableAllHooks === true) {
      delete ccDoc.disableAllHooks;
    }
    fs.mkdirSync(path.dirname(ccSettingsPath), { recursive: true });
    atomicWriteFileSync(ccSettingsPath, `${JSON.stringify(ccDoc, null, 2)}\n`);
  } else if (ccDoc.hooks && Array.isArray(ccDoc.hooks.PreToolUse)) {
    const filteredPre = ccDoc.hooks.PreToolUse.filter((entry) => {
      const cmds = [
        entry?.command,
        ...(Array.isArray(entry?.hooks) ? entry.hooks.map((h) => h?.command) : [])
      ].map((c) => String(c || ''));
      return !cmds.some((c) => CLAUDE_RSL_HOOK_RE.test(c) && c.includes('--event=PreToolUse'));
    });
    if (filteredPre.length !== ccDoc.hooks.PreToolUse.length) {
      if (filteredPre.length > 0) ccDoc.hooks.PreToolUse = filteredPre;
      else delete ccDoc.hooks.PreToolUse;
      atomicWriteFileSync(ccSettingsPath, `${JSON.stringify(ccDoc, null, 2)}\n`);
    }
  }

  return {
    promotedCount: promoted.length,
    agHooksPath,
    ccSettingsPath
  };
}

/**
 * Compiles a single active heuristic simultaneously into `.agents/` and `.claude/`.
 *
 * @param {string} workspaceRoot
 * @param {object} item
 * @param {object} [options={}]
 */
export function compileHeuristicDualTargets(workspaceRoot, item, options = {}) {
  const baseRoot = path.resolve(workspaceRoot);
  const slug = toKebabSlug(item.slug);
  const written = [];

  if (item.carrier === 'skill_workflow') {
    const agSkillPath = path.join(baseRoot, '.agents', 'skills', `rsl-${slug}`, 'SKILL.md');
    const ccSkillPath = path.join(baseRoot, '.claude', 'skills', `rsl-${slug}`, 'SKILL.md');
    fs.mkdirSync(path.dirname(agSkillPath), { recursive: true });
    fs.mkdirSync(path.dirname(ccSkillPath), { recursive: true });
    atomicWriteFileSync(agSkillPath, buildAntigravitySkillMarkdown(item));
    atomicWriteFileSync(ccSkillPath, buildClaudeSkillMarkdown(item));
    written.push(agSkillPath, ccSkillPath);
  } else {
    const agRuleContent = buildAntigravityRuleMarkdown(item);
    const ccRuleContent = buildClaudeRuleMarkdown(item);
    const agRulePath = path.join(baseRoot, '.agents', 'rules', `rsl-${slug}.md`);
    const ccRulePath = path.join(baseRoot, '.claude', 'rules', `rsl-${slug}.md`);

    const budget = measureWorkspaceRuleBudget(baseRoot);
    const existingBytes = fs.existsSync(agRulePath) ? fs.statSync(agRulePath).size : 0;
    const projectedTokens = budget.totalTokens - Math.ceil(existingBytes / 4) + Math.ceil(Buffer.byteLength(agRuleContent, 'utf8') / 4);

    if (projectedTokens <= RSL_CONSTANTS.AGGREGATE_RULE_TOKEN_BUDGET || options.force === true) {
      fs.mkdirSync(path.dirname(agRulePath), { recursive: true });
      fs.mkdirSync(path.dirname(ccRulePath), { recursive: true });
      atomicWriteFileSync(agRulePath, agRuleContent);
      atomicWriteFileSync(ccRulePath, ccRuleContent);
      written.push(agRulePath, ccRulePath);
    }
  }

  return { slug, written };
}

function globMatchesFile(globPattern = '', filePath = '') {
  const posixFile = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (!posixFile) return false;
  const parts = String(globPattern || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const pat of parts) {
    if (pat.startsWith('*.') && posixFile.endsWith(pat.slice(1))) return true;
    if (pat.endsWith('/**') && posixFile.startsWith(pat.slice(0, -3))) return true;
    if (posixFile === pat || posixFile.endsWith(`/${pat}`)) return true;
  }
  return false;
}

/**
 * Applies ExpeL `+1` clean reuse / `-1` repeat error feedback to existing active heuristics,
 * ingests newly distilled heuristics at `importance: 2`, prunes `<= 0` items from both
 * `.agents/` and `.claude/`, and promotes `>= 5` (or `>= 2` repeat violations) to hooks.
 *
 * @param {string} workspaceRoot
 * @param {object} distilledReport
 * @param {object} [sessionContext={}]
 * @param {object} [options={}]
 */
export function ingestDistilledHeuristics(workspaceRoot, distilledReport = {}, sessionContext = {}, options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const ledger = readRslLedger(baseRoot);
  ledger.stats.lastSessionId = sessionContext.sessionId || ledger.stats.lastSessionId;
  ledger.stats.lastPlatform = sessionContext.platform || ledger.stats.lastPlatform;

  if (sessionContext.tainted || sessionContext.status === 'TAINTED_REWARD_HACK') {
    ledger.stats.taintedSessions += 1;
    writeRslLedger(baseRoot, ledger);
    return {
      ok: false,
      tainted: true,
      upvoted: [],
      downvoted: [],
      pruned: [],
      promoted: [],
      added: [],
      quarantined: []
    };
  }

  const upvoted = [];
  const downvoted = [];
  const pruned = [];
  const promoted = [];
  const added = [];
  const quarantined = [];

  const touchedFiles = Array.isArray(sessionContext.touchedFiles) ? sessionContext.touchedFiles : [];
  const unresolvedErrors = Array.isArray(sessionContext.unresolvedErrors) ? sessionContext.unresolvedErrors : [];
  const pairs = Array.isArray(sessionContext.contrastivePairs) ? sessionContext.contrastivePairs : [];
  const sessionErrorsText = [
    ...unresolvedErrors.map((e) => `${e.toolName || ''}:${e.errorText || ''}`),
    ...pairs.map((p) => `${p.toolName || ''}:${p.errorText || ''}`)
  ]
    .join('\n')
    .toLowerCase();

  // 1. ExpeL feedback on existing active heuristics
  for (const item of Object.values(ledger.items)) {
    if (!item || item.status !== 'active') continue;
    const sig = String(item.errorSignature || '').toLowerCase();
    const sigErrPart = sig.includes(':') ? sig.split(':').slice(1).join(':').trim() : sig;
    const matchedError = Boolean(sigErrPart && sigErrPart.length >= 6 && sessionErrorsText.includes(sigErrPart.slice(0, 32)));

    if (matchedError) {
      item.importance = Math.max(0, Number(item.importance || 0) - 1);
      item.violationCount = Number(item.violationCount || 0) + 1;
      item.updatedAt = new Date().toISOString();
      downvoted.push(item.slug);
      if (item.importance <= 0) {
        item.status = 'pruned';
        item.promotedHook = false;
        ledger.stats.prunedCount += 1;
        removeDualCarrierFiles(baseRoot, item.slug);
        pruned.push(item.slug);
      } else {
        if (item.violationCount >= RSL_CONSTANTS.REPEAT_VIOLATION_THRESHOLD) {
          item.promotedHook = true;
          promoted.push(item.slug);
        }
        compileHeuristicDualTargets(baseRoot, item, options);
      }
      continue;
    }

    const touchedMatchingFile = touchedFiles.some((f) => globMatchesFile(item.globs, f));
    if (touchedMatchingFile && sessionContext.terminationReason !== 'ERROR') {
      item.importance = Number(item.importance || RSL_CONSTANTS.INITIAL_IMPORTANCE) + 1;
      item.cleanUses = Number(item.cleanUses || 0) + 1;
      item.updatedAt = new Date().toISOString();
      upvoted.push(item.slug);
      if (item.importance >= RSL_CONSTANTS.PROMOTE_HOOK_IMPORTANCE && !item.promotedHook) {
        item.promotedHook = true;
        promoted.push(item.slug);
      }
      compileHeuristicDualTargets(baseRoot, item, options);
    }
  }

  // 2. Ingest newly distilled heuristics (initialized at importance: 2, or staged as candidate for 1-turn user corrections)
  const incoming = Array.isArray(distilledReport?.heuristics) ? distilledReport.heuristics : [];
  const stagedCandidates = [];
  for (const h of incoming) {
    const slug = toKebabSlug(h.slug);
    if (!slug) continue;
    const existing = ledger.items[slug];
    if (existing && existing.status === 'active') {
      // Do not duplicate; reinforce if same pattern surfaced again cleanly or already handled above
      continue;
    }

    if (existing && existing.status === 'candidate') {
      const sameSession = Boolean(
        existing.lastSessionId &&
        sessionContext.sessionId &&
        existing.lastSessionId === sessionContext.sessionId
      );
      if (!sameSession) {
        existing.confirmations = Number(existing.confirmations || 1) + 1;
        existing.lastSessionId = sessionContext.sessionId || existing.lastSessionId || null;
        existing.updatedAt = new Date().toISOString();
      }
      if (existing.confirmations >= 2 || options.promoteCandidatesImmediately === true) {
        const clashReport = existing.carrier !== 'skill_workflow'
          ? auditWorkspaceRuleClashes(baseRoot, existing)
          : { candidateClashes: [] };
        if (clashReport.candidateClashes.length > 0 && options.allowClashingRules !== true) {
          existing.status = 'quarantined_conflict';
          existing.promotedHook = false;
          existing.quarantinedConflict = clashReport.candidateClashes[0];
          quarantined.push(slug);
          continue;
        }
        existing.status = 'active';
        existing.importance = Math.max(RSL_CONSTANTS.INITIAL_IMPORTANCE, Number(existing.importance || 0));
        compileHeuristicDualTargets(baseRoot, existing, options);
        added.push(slug);
      } else {
        stagedCandidates.push(slug);
      }
      continue;
    }

    const stageOnly = h.initialStatus === 'candidate' && options.promoteCandidatesImmediately !== true;
    const item = {
      slug,
      carrier: h.carrier || 'rule_model_decision',
      importance: RSL_CONSTANTS.INITIAL_IMPORTANCE,
      status: stageOnly ? 'candidate' : 'active',
      confirmations: 1,
      lastSessionId: sessionContext.sessionId || null,
      promotedHook: stageOnly ? false : h.carrier === 'pre_tool_hook',
      violationCount: stageOnly ? 0 : (h.carrier === 'pre_tool_hook' ? RSL_CONSTANTS.REPEAT_VIOLATION_THRESHOLD : 0),
      cleanUses: 0,
      sourcePlatform: sessionContext.platform || 'antigravity',
      description: h.description || '',
      globs: h.globs || '',
      paths: Array.isArray(h.paths) ? h.paths : [],
      when_condition: h.when_condition || '',
      then_guidance: h.then_guidance || '',
      steps: Array.isArray(h.steps) ? h.steps : [],
      errorSignature: h.errorSignature || '',
      toolMatcher: h.toolMatcher || 'run_command|edit_file|write_file',
      claudeToolMatcher: h.claudeToolMatcher || 'Bash|PowerShell|Edit|MultiEdit|Write',
      denyPattern: h.denyPattern || '',
      evidence_step_ids: Array.isArray(h.evidence_step_ids) ? h.evidence_step_ids : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (stageOnly) {
      ledger.items[slug] = item;
      stagedCandidates.push(slug);
      continue;
    }

    const isRuleCandidate = item.carrier !== 'skill_workflow';
    const clashReport = isRuleCandidate
      ? auditWorkspaceRuleClashes(baseRoot, item)
      : { candidateClashes: [] };
    if (clashReport.candidateClashes.length > 0 && options.allowClashingRules !== true) {
      item.status = 'quarantined_conflict';
      item.promotedHook = false;
      item.quarantinedConflict = clashReport.candidateClashes[0];
      ledger.items[slug] = item;
      quarantined.push(slug);
      continue;
    }

    ledger.items[slug] = item;
    compileHeuristicDualTargets(baseRoot, item, options);
    added.push(slug);
    if (item.promotedHook) promoted.push(slug);
  }

  syncPromotedDualHooks(baseRoot, ledger, options);
  writeRslLedger(baseRoot, ledger);

  return {
    ok: true,
    tainted: false,
    upvoted,
    downvoted,
    pruned,
    promoted: Array.from(new Set(promoted)),
    added,
    candidates: stagedCandidates,
    quarantined
  };
}

/**
 * Promotes a heuristic slug to `importance >= 5` and compiles dual-platform `PreToolUse` hooks.
 * @param {string} workspaceRoot
 * @param {string} slug
 * @param {object} [options={}]
 */
export function promoteHeuristic(workspaceRoot, slug, options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const safeSlug = toKebabSlug(slug);
  const ledger = readRslLedger(baseRoot);
  const item = ledger.items[safeSlug];
  if (!item) {
    return { ok: false, error: `Heuristic "${safeSlug}" not found in RSL ledger` };
  }
  item.status = 'active';
  item.importance = Math.max(RSL_CONSTANTS.PROMOTE_HOOK_IMPORTANCE, Number(item.importance || 0));
  item.promotedHook = true;
  item.updatedAt = new Date().toISOString();
  compileHeuristicDualTargets(baseRoot, item, options);
  const hooks = syncPromotedDualHooks(baseRoot, ledger, options);
  writeRslLedger(baseRoot, ledger);
  return { ok: true, slug: safeSlug, item, hooks };
}

/**
 * Prunes a heuristic slug (`importance = 0`, deletes files from both `.agents/` and `.claude/`).
 * @param {string} workspaceRoot
 * @param {string} slug
 * @param {object} [options={}]
 */
export function pruneHeuristic(workspaceRoot, slug, options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const safeSlug = toKebabSlug(slug);
  const ledger = readRslLedger(baseRoot);
  const item = ledger.items[safeSlug];
  if (!item) {
    removeDualCarrierFiles(baseRoot, safeSlug);
    return { ok: false, error: `Heuristic "${safeSlug}" not found in RSL ledger` };
  }
  if (item.status !== 'pruned') {
    ledger.stats.prunedCount += 1;
  }
  item.status = 'pruned';
  item.importance = 0;
  item.promotedHook = false;
  item.updatedAt = new Date().toISOString();
  removeDualCarrierFiles(baseRoot, safeSlug);
  const hooks = syncPromotedDualHooks(baseRoot, ledger, options);
  writeRslLedger(baseRoot, ledger);
  return { ok: true, slug: safeSlug, item, hooks };
}

/**
 * Directly adjusts heuristic importance (`+delta` or `-delta`), triggering automatic pruning at `<= 0`
 * or hook promotion at `>= 5` across both Antigravity and Claude Code.
 */
export function adjustHeuristicImportance(workspaceRoot, slug, delta = 1, options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const safeSlug = toKebabSlug(slug);
  const ledger = readRslLedger(baseRoot);
  const item = ledger.items[safeSlug];
  if (!item) return { ok: false, error: `Heuristic "${safeSlug}" not found` };

  const next = Number(item.importance || 0) + Number(delta || 0);
  if (next <= 0) {
    return pruneHeuristic(baseRoot, safeSlug, options);
  }
  item.status = 'active';
  item.importance = next;
  if (delta < 0) item.violationCount = Number(item.violationCount || 0) + 1;
  else if (delta > 0) item.cleanUses = Number(item.cleanUses || 0) + 1;
  item.updatedAt = new Date().toISOString();

  if (next >= RSL_CONSTANTS.PROMOTE_HOOK_IMPORTANCE || item.violationCount >= RSL_CONSTANTS.REPEAT_VIOLATION_THRESHOLD) {
    item.promotedHook = true;
  }
  compileHeuristicDualTargets(baseRoot, item, options);
  const hooks = syncPromotedDualHooks(baseRoot, ledger, options);
  writeRslLedger(baseRoot, ledger);
  return { ok: true, slug: safeSlug, item, hooks };
}

/**
 * Fast (<5ms) runtime evaluation of promoted Carrier C `PreToolUse` guards.
 *
 * @param {string} workspaceRoot
 * @param {'antigravity' | 'claude'} platform
 * @param {object} [payload={}]
 */
export function evaluatePromotedPreToolGuards(workspaceRoot, platform = 'antigravity', payload = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const ledgerPath = getRslLedgerPath(baseRoot);
  if (!fs.existsSync(ledgerPath)) {
    return { decision: 'allow', matchedSlug: null, reason: null };
  }

  const ledger = readRslLedger(baseRoot);
  const promoted = Object.values(ledger.items || {}).filter(
    (it) =>
      it &&
      it.status === 'active' &&
      Boolean(it.denyPattern) &&
      (it.promotedHook === true ||
        it.carrier === 'pre_tool_hook' ||
        Number(it.importance || 0) >= RSL_CONSTANTS.PROMOTE_HOOK_IMPORTANCE)
  );
  if (promoted.length === 0) {
    return { decision: 'allow', matchedSlug: null, reason: null };
  }

  const toolName = String(payload.toolCall?.name || payload.tool_name || payload.toolName || '');
  const args = payload.toolCall?.args || payload.tool_input || payload.toolInput || {};
  const haystack = [
    args.CommandLine,
    args.command,
    args.cmd,
    args.script,
    args.file_path,
    args.TargetFile,
    args.Path,
    args.path,
    args.content,
    args.Replacement
  ]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .join('\n')
    .toLowerCase();

  if (!haystack) {
    return { decision: 'allow', matchedSlug: null, reason: null };
  }

  for (const item of promoted) {
    const matcherStr = platform === 'claude' ? item.claudeToolMatcher : item.toolMatcher;
    if (matcherStr && toolName) {
      try {
        const re = new RegExp(`^(?:${matcherStr})$`, 'i');
        if (!re.test(toolName)) continue;
      } catch {
        // Ignore malformed matcher
      }
    }
    const needle = String(item.denyPattern || '').trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      return {
        decision: 'deny',
        matchedSlug: item.slug,
        reason: `[Highbeam RSL Guard: rsl-${item.slug}] Blocked repeated pattern "${item.denyPattern}". ${item.then_guidance || ''}`.trim()
      };
    }
  }

  return { decision: 'allow', matchedSlug: null, reason: null };
}

/**
 * Returns consolidated dual-platform RSL summary for CLI, Daemon, WebView, and StatusLine.
 *
 * @param {string} [workspaceRoot=process.cwd()]
 * @param {object} [options={}]
 */
export function getRslSummary(workspaceRoot = process.cwd(), options = {}) {
  const baseRoot = path.resolve(workspaceRoot || process.cwd());
  const ledger = readRslLedger(baseRoot);
  const allItems = Object.values(ledger.items || {});
  const activeItems = allItems.filter((it) => it && it.status === 'active');
  const candidateItems = allItems.filter((it) => it && it.status === 'candidate');
  const activeRules = activeItems.filter((it) => it.carrier !== 'skill_workflow').length;
  const candidateRules = candidateItems.filter((it) => it.carrier !== 'skill_workflow').length;
  const activeSkills = activeItems.filter((it) => it.carrier === 'skill_workflow').length;
  const promotedHooks = activeItems.filter(
    (it) =>
      it.promotedHook === true ||
      it.carrier === 'pre_tool_hook' ||
      Number(it.importance || 0) >= RSL_CONSTANTS.PROMOTE_HOOK_IMPORTANCE
  ).length;

  const budget = measureWorkspaceRuleBudget(baseRoot);
  const clashAudit = auditWorkspaceRuleClashes(baseRoot);
  const quarantinedItems = allItems.filter((it) => it && it.status === 'quarantined_conflict');
  const activeClashes = clashAudit.clashes.slice(0, 5);
  const claudeMemoryAudit = auditClaudeAutoMemory({
    cwd: baseRoot,
    homeDir: options.homeDir || os.homedir(),
    memoryDir: options.memoryDir,
    memoryFilePath: options.memoryFilePath
  });

  const topHeuristics = activeItems
    .slice()
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, 10)
    .map((it) => ({
      slug: it.slug,
      carrier: it.carrier,
      importance: Number(it.importance || 0),
      promotedHook: Boolean(it.promotedHook),
      sourcePlatform: it.sourcePlatform || 'dual',
      globs: it.globs || '',
      description: it.description || ''
    }));

  return {
    workspaceRoot: baseRoot,
    ledgerPath: getRslLedgerPath(baseRoot),
    activeRules,
    candidateRules,
    activeSkills,
    promotedHooks,
    totalActive: activeItems.length,
    clashCount: clashAudit.clashCount + quarantinedItems.length,
    quarantinedCount: quarantinedItems.length,
    activeClashes,
    prunedCount: Number(ledger.stats?.prunedCount || 0),
    taintedSessions: Number(ledger.stats?.taintedSessions || 0),
    lastSessionId: ledger.stats?.lastSessionId || null,
    lastPlatform: ledger.stats?.lastPlatform || null,
    ruleBudgetTokens: budget.totalTokens,
    ruleBudgetMaxTokens: budget.budgetTokens,
    ruleBudgetPct: budget.pct,
    claudeMemoryAudit,
    topHeuristics,
    uiRules: activeItems
      .slice()
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
      .slice(0, 12)
      .map((it) => humanizeLearnedRule(it)),
    items: options.includeAll ? allItems : activeItems
  };
}
