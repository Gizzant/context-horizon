/**
 * @file src/core/rsl_distiller.mjs
 * Stage 2 Dual-Platform RSL Distiller (`--mode local` default, 0 LLM tokens, <15ms;
 * optional `--mode sdk` wrapper around `scripts/rsl_sdk_distiller.py`).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'rsl_sdk_distiller.py');

const XML_LEAK_RE = /<\/?(?:system_context_prefix|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY|SYSTEM_MESSAGE|RULE|user_rules)\b/i;
const TRIVIAL_TYPO_RE = /\b(?:SyntaxError:\s*Unexpected\s+token|missing\s+semicolon|typo\s+in\s+identifier)\b/i;

/**
 * Normalizes any text into a strict lowercase kebab-case slug (<= 48 chars).
 * @param {string} raw
 * @param {string} [fallback='session-lesson']
 * @returns {string}
 */
export function toKebabSlug(raw = '', fallback = 'session-lesson') {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return cleaned || fallback;
}

function shortStableHash(input = '') {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 6);
}

function buildGlobPatterns(targetFile = '') {
  const posix = String(targetFile || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posix) return { globs: '', paths: [] };
  const ext = path.posix.extname(posix);
  const dir = path.posix.dirname(posix);
  const patterns = [];
  if (ext) patterns.push(`*${ext}`);
  if (dir && dir !== '.') {
    const topDir = dir.split('/')[0];
    if (topDir) patterns.push(`${topDir}/**`);
  } else {
    patterns.push(posix);
  }
  const unique = Array.from(new Set(patterns));
  return {
    globs: unique.join(', '),
    paths: unique
  };
}

function inferToolMatchers(toolName = '', command = '') {
  const lower = String(toolName || '').toLowerCase();
  if (lower === 'run_command' || lower === 'bash' || lower === 'powershell' || command) {
    return {
      toolMatcher: 'run_command',
      claudeToolMatcher: 'Bash|PowerShell'
    };
  }
  if (/edit|write|replace|patch/i.test(lower)) {
    return {
      toolMatcher: 'edit_file|write_file|replace_file_content|multi_replace_file_content',
      claudeToolMatcher: 'Edit|MultiEdit|Write|NotebookEdit'
    };
  }
  return {
    toolMatcher: toolName || 'run_command|edit_file|write_file',
    claudeToolMatcher: 'Bash|PowerShell|Edit|MultiEdit|Write'
  };
}

function extractDenyPattern(command = '', text = '') {
  const cmd = String(command || '').trim();
  if (cmd) {
    // Capture first two tokens of failing risky command if concise
    const tokens = cmd.split(/\s+/).slice(0, 3).join(' ');
    if (tokens.length >= 4 && tokens.length <= 64) {
      return tokens;
    }
  }
  const m = String(text || '').match(/`([^`]{4,64})`/);
  return m ? m[1] : '';
}

function buildThirdPersonDescription(contextText = '', negativeScope = 'unrelated files or tasks outside this scope') {
  const cleanCtx = String(contextText || 'applying workspace lessons')
    .replace(/^(?:you are|proactively|always)\s+/i, '')
    .replace(/\$ARGUMENTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return `Use when ${cleanCtx}. Do not use for ${negativeScope}.`;
}

function sanitizeGuidanceText(raw = '') {
  return String(raw || '')
    .replace(/\$ARGUMENTS\b/gi, '')
    .replace(XML_LEAK_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function distillLocally(digest) {
  const heuristics = [];
  const seenSlugs = new Set();

  const pushHeuristic = (item) => {
    if (!item || !item.slug || !item.then_guidance) return;
    if (XML_LEAK_RE.test(item.then_guidance) || XML_LEAK_RE.test(item.when_condition || '')) return;
    let slug = toKebabSlug(item.slug);
    if (seenSlugs.has(slug)) {
      slug = toKebabSlug(`${slug}-${shortStableHash(item.when_condition || item.then_guidance)}`);
    }
    seenSlugs.add(slug);
    heuristics.push({
      ...item,
      slug,
      description: buildThirdPersonDescription(
        item.description || item.when_condition,
        item.negativeScope || 'unrelated modules or one-off tasks'
      )
    });
  };

  // 1. Contrastive Failure-Recovery Pairs -> Skill Workflows (multi-step) or Glob/Domain Rules
  for (const pair of digest.contrastivePairs || []) {
    const err = sanitizeGuidanceText(pair.errorText || '');
    const cmd = sanitizeGuidanceText(pair.command || '');
    const recovery = sanitizeGuidanceText(pair.recoveryAction || '');
    const targetFile = String(pair.targetFile || '').replace(/\\/g, '/');
    const recoverySteps = Array.isArray(pair.recoverySteps) ? pair.recoverySteps : [];

    // Filter out isolated one-off syntax typos unless backed by multi-step test-verified recovery
    const nonTestRecoverySteps = recoverySteps.filter(
      (s) => !s.isTestPass && !/(?:npm\s+(?:run\s+)?test|node\s+--test|pytest|vitest|jest)/i.test(String(s.command || ''))
    );
    if (TRIVIAL_TYPO_RE.test(err) && nonTestRecoverySteps.length < 2 && !pair.validatedByTest) {
      continue;
    }

    const isMultiStep = nonTestRecoverySteps.length >= 2;
    const { globs, paths } = buildGlobPatterns(targetFile);
    const matchers = inferToolMatchers(pair.toolName, cmd);
    const errorSignature = `${pair.toolName || 'tool'}:${err.slice(0, 80)}`.toLowerCase();

    if (isMultiStep) {
      const stepLines = recoverySteps.map((s, idx) => {
        const actionDesc = sanitizeGuidanceText(s.command || s.targetFile || s.toolName || `step ${idx + 1}`);
        return `${idx + 1}. Run \`${s.toolName || 'tool'}\` on ${actionDesc}`;
      });
      const baseName = targetFile
        ? path.posix.basename(targetFile, path.posix.extname(targetFile))
        : (pair.toolName || 'recovery');
      const slug = toKebabSlug(`recover-${baseName}-${shortStableHash(err || recovery)}`);
      pushHeuristic({
        carrier: 'skill_workflow',
        slug,
        when_condition: `Recovering after \`${pair.toolName || 'tool'}\` fails${err ? ` with "${err.slice(0, 120)}"` : ''}`,
        description: `replaying the verified ${recoverySteps.length}-step recovery workflow for ${targetFile || pair.toolName || 'this task'}`,
        negativeScope: 'unrelated features or clean runs without this failure signature',
        globs,
        paths,
        then_guidance: `Follow the verified recovery sequence:\n${stepLines.join('\n')}`,
        steps: stepLines,
        evidence_step_ids: [pair.failureStepIdx, ...recoverySteps.map((s) => s.stepIdx)].filter(
          (n) => Number.isFinite(Number(n))
        ),
        errorSignature,
        ...matchers,
        denyPattern: extractDenyPattern(cmd, err)
      });
    } else {
      const carrier = globs ? 'rule_glob' : 'rule_model_decision';
      const baseName = targetFile
        ? path.posix.basename(targetFile, path.posix.extname(targetFile))
        : (pair.toolName || 'constraint');
      const slug = toKebabSlug(`avoid-${baseName}-${shortStableHash(err || cmd || recovery)}`);
      const refFile = targetFile ? `@[${path.posix.basename(targetFile)}](${targetFile})` : '';
      const whenCond = `Invoking \`${pair.toolName || 'tool'}\`${targetFile ? ` on ${refFile}` : ''}${cmd ? ` (\`${cmd.slice(0, 80)}\`)` : ''}`;
      const thenGuide = recovery
        ? `Avoid repeating "${err.slice(0, 140)}"; apply verified recovery \`${recovery}\`${targetFile ? ` against ${refFile}` : ''}.`
        : `Verify prerequisites before running \`${pair.toolName || 'tool'}\` so "${err.slice(0, 140)}" does not recur.`;
      pushHeuristic({
        carrier,
        slug,
        when_condition: whenCond,
        description: `working with ${targetFile || pair.toolName || 'this domain'} to prevent "${err.slice(0, 80)}"`,
        globs,
        paths,
        then_guidance: thenGuide,
        steps: [],
        evidence_step_ids: [pair.failureStepIdx, pair.recoveryStepIdx].filter((n) => Number.isFinite(Number(n))),
        errorSignature,
        ...matchers,
        denyPattern: extractDenyPattern(cmd, err)
      });
    }
  }

  // 2. Antigravity Artifact Rejections & Inline User Comments -> Rules
  for (const comment of digest.artifactComments || []) {
    const cleanText = sanitizeGuidanceText(comment.text || '');
    if (!cleanText || cleanText.length < 8) continue;
    const fileMatch = cleanText.match(/([a-zA-Z0-9_./-]+\.(?:mjs|js|ts|tsx|py|json|md|go|rs))/);
    const targetFile = fileMatch ? fileMatch[1].replace(/\\/g, '/') : '';
    const { globs, paths } = buildGlobPatterns(targetFile);
    const carrier = globs ? 'rule_glob' : 'rule_model_decision';
    const slug = toKebabSlug(`review-${comment.kind || 'feedback'}-${shortStableHash(cleanText)}`);
    pushHeuristic({
      carrier,
      slug,
      when_condition: `User review ${comment.kind === 'rejected' ? 'rejection' : 'inline feedback'} in ${comment.file || 'artifact'}`,
      description: `planning or editing ${targetFile || 'workspace architecture'} affected by artifact review feedback`,
      globs,
      paths,
      then_guidance: `Enforce user artifact guidance: ${cleanText.slice(0, 320)}`,
      steps: [],
      evidence_step_ids: [],
      errorSignature: `artifact:${shortStableHash(cleanText)}`,
      ...inferToolMatchers('edit_file', ''),
      denyPattern: extractDenyPattern('', cleanText)
    });
  }

  // 3. Claude / Antigravity User Correction Turns -> Rules
  for (const corr of digest.userCorrections || []) {
    const cleanText = sanitizeGuidanceText(corr.text || '');
    if (!cleanText || cleanText.length < 8) continue;
    const fileMatch = cleanText.match(/([a-zA-Z0-9_./-]+\.(?:mjs|js|ts|tsx|py|json|md|go|rs))/);
    const targetFile = fileMatch ? fileMatch[1].replace(/\\/g, '/') : '';
    const { globs, paths } = buildGlobPatterns(targetFile);
    const carrier = globs ? 'rule_glob' : 'rule_model_decision';
    const slug = toKebabSlug(`user-correction-${shortStableHash(cleanText)}`);
    pushHeuristic({
      carrier,
      slug,
      when_condition: `Session user correction turn (${digest.platform || 'agent'})`,
      description: `handling ${targetFile || 'commands and edits'} governed by explicit user correction`,
      globs,
      paths,
      then_guidance: `Follow explicit user directive: ${cleanText.slice(0, 320)}`,
      steps: [],
      evidence_step_ids: Number.isFinite(Number(corr.stepIdx)) ? [Number(corr.stepIdx)] : [],
      errorSignature: `correction:${shortStableHash(cleanText)}`,
      ...inferToolMatchers('run_command', cleanText),
      denyPattern: extractDenyPattern('', cleanText)
    });
  }

  // 4. Resolved 3+ Turn Thrash Loops -> Rules (if not already captured above)
  for (const loop of digest.thrashLoops || []) {
    const target = String(loop.target || '').replace(/\\/g, '/');
    const { globs, paths } = buildGlobPatterns(target.includes('.') || target.includes('/') ? target : '');
    const slug = toKebabSlug(`stop-thrash-${target || loop.resolvedTool || 'loop'}-${shortStableHash(String(loop.startStepIdx))}`);
    if (seenSlugs.has(slug)) continue;
    pushHeuristic({
      carrier: globs ? 'rule_glob' : 'rule_model_decision',
      slug,
      when_condition: `After ${loop.failureCount || 3}+ consecutive failures on \`${target || loop.resolvedTool || 'target'}\``,
      description: `breaking repeated edit-test failure loops on ${target || 'the current task'}`,
      globs,
      paths,
      then_guidance: `Stop retrying the same change on \`${target || 'target'}\`; read diagnostics first and switch to the verified approach (\`${loop.resolvedTool || 'verification'}\`).`,
      steps: [],
      evidence_step_ids: [loop.startStepIdx, loop.resolvedStepIdx].filter((n) => Number.isFinite(Number(n))),
      errorSignature: `thrash:${target || loop.resolvedTool}`.toLowerCase(),
      ...inferToolMatchers(loop.resolvedTool, ''),
      denyPattern: ''
    });
  }

  return {
    is_valid_learning: heuristics.length > 0,
    mode: 'local',
    heuristics
  };
}

function normalizeSdkReport(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.heuristics)) {
    return null;
  }
  const allowedCarriers = new Set(['rule_glob', 'rule_model_decision', 'skill_workflow', 'pre_tool_hook']);
  const heuristics = parsed.heuristics
    .filter((h) => h && typeof h === 'object' && allowedCarriers.has(h.carrier))
    .map((h) => ({
      carrier: h.carrier,
      slug: toKebabSlug(h.slug),
      description: buildThirdPersonDescription(h.description || h.when_condition),
      globs: String(h.globs || '').trim(),
      paths: Array.isArray(h.paths)
        ? h.paths.map((p) => String(p).trim()).filter(Boolean)
        : String(h.globs || '')
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
      when_condition: sanitizeGuidanceText(h.when_condition || ''),
      then_guidance: sanitizeGuidanceText(h.then_guidance || ''),
      steps: Array.isArray(h.steps) ? h.steps.map((s) => sanitizeGuidanceText(s)).filter(Boolean) : [],
      evidence_step_ids: Array.isArray(h.evidence_step_ids) ? h.evidence_step_ids : [],
      errorSignature: String(h.errorSignature || `sdk:${toKebabSlug(h.slug)}`),
      toolMatcher: String(h.toolMatcher || 'run_command|edit_file|write_file'),
      claudeToolMatcher: String(h.claudeToolMatcher || 'Bash|PowerShell|Edit|MultiEdit|Write'),
      denyPattern: String(h.denyPattern || '')
    }))
    .filter((h) => h.slug && h.then_guidance && !XML_LEAK_RE.test(h.then_guidance));

  return {
    is_valid_learning: Boolean(parsed.is_valid_learning) && heuristics.length > 0,
    mode: 'sdk',
    heuristics
  };
}

/**
 * Distills a contrastive post-mortem digest into structured heuristics.
 * Default `--mode local` runs deterministically in <15ms with 0 LLM tokens.
 * Optional `--mode sdk` executes `scripts/rsl_sdk_distiller.py` (blocked during test mode unless mocked)
 * and automatically falls back to `local` on failure.
 *
 * @param {object} digest
 * @param {object} [options={}]
 */
export function distillContrastiveDigest(digest, options = {}) {
  if (!digest || typeof digest !== 'object') {
    return { is_valid_learning: false, mode: 'local', heuristics: [], reason: 'EMPTY_DIGEST' };
  }
  if (digest.tainted || digest.status === 'TAINTED_REWARD_HACK') {
    return { is_valid_learning: false, mode: 'local', heuristics: [], reason: 'TAINTED_REWARD_HACK' };
  }
  if (!digest.triggered) {
    return { is_valid_learning: false, mode: 'local', heuristics: [], reason: 'NO_TRIGGERS' };
  }

  const requestedMode = String(options.mode || 'local').toLowerCase();
  if (requestedMode === 'sdk') {
    if (typeof options.sdkRunner === 'function') {
      try {
        const sdkOut = normalizeSdkReport(options.sdkRunner(digest));
        if (sdkOut) return sdkOut;
      } catch {
        // Fall back cleanly to deterministic local distiller
      }
    } else {
      const inTestMode = process.env.NODE_ENV === 'test' || process.env.CTXTOP_TEST_MODE === '1';
      const digestPath = digest.digestPath && fs.existsSync(digest.digestPath) ? digest.digestPath : null;
      if (!inTestMode && digestPath && fs.existsSync(SDK_SCRIPT_PATH)) {
        try {
          const pythonBin = options.pythonBin || (process.platform === 'win32' ? 'python' : 'python3');
          const stdout = execFileSync(pythonBin, [SDK_SCRIPT_PATH, digestPath], {
            encoding: 'utf8',
            timeout: Number(options.sdkTimeoutMs || 15_000),
            stdio: ['ignore', 'pipe', 'pipe']
          });
          const sdkOut = normalizeSdkReport(JSON.parse(stdout));
          if (sdkOut) return sdkOut;
        } catch {
          // Automatic fallback to zero-token local distiller
        }
      }
    }
  }

  return distillLocally(digest);
}
