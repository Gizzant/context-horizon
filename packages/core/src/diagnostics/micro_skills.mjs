/**
 * @file src/core-isomorphic/diagnostics/micro_skills.mjs
 * RSI-04 ("micro-skills") — Zero-LLM-Cost Deterministic Command-Pair Micro-Skills Engine.
 *
 * Strictly zero `node:*` imports (Claude Code Mod Law 4 compliant).
 * Captures verified shell recovery pairs (`failedCmd` -> `workingCmd` within <= 3 turns),
 * promotes after >= N distinct sessions (default 2), evicts contradicted skills,
 * rejects secret-bearing or Ring-0 unsafe bypass commands, and formats <80-token StateBaton snippets.
 */

import { path, getCwd, readJsonSafe, writeJsonAtomic } from '../utils/runtime.mjs';

export const MAX_MICRO_SKILL_BATON_TOKENS = 80;
export const MAX_MICRO_SKILL_BATON_CHARS = 300; // ~75-78 tokens

const LIVE_SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /-----BEGIN\s+[A-Z0-9\s]*PRIVATE\s+KEY-----/,
  /[a-z0-9+.-]+:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/i,
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|AUTH_TOKEN|ACCESS_KEY|STRIPE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*=\s*['"]?[^\s'"]{6,}/i,
  /--(?:token|password|api-key|secret|auth)(?:=|\s+)['"]?[^\s'"]+/i
]);

const UNSAFE_BYPASS_PATTERNS = Object.freeze([
  /--no-verify\b/i,
  /--no-gpg-sign\b/i,
  /\bgit\s+commit\b[^\r\n]*\s-[a-z]*n[a-z]*\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b[^\r\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i,
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /\bRemove-Item\b[^\r\n]*-Recurse[^\r\n]*-Force\b/i,
  /\bdel\s+\/[sqf]/i,
  /\bsudo\s+/i,
  /\bchmod\s+777\b/i,
  /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/i,
  /\b(?:curl|wget)\b[^\r\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i
]);

function shannonEntropy(str = '') {
  if (!str) return 0;
  const freq = new Map();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Validates that a shell command string is safe to record (contains zero secrets
 * and zero Ring-0 destructive / hook-bypass flags).
 *
 * @param {string} rawCommand
 * @returns {{ safe: boolean, reason: string | null }}
 */
export function inspectCommandSafetyForMicroSkill(rawCommand = '') {
  const text = String(rawCommand || '').trim();
  if (!text || text.length > 400 || /[\r\n]/.test(text)) {
    return { safe: false, reason: 'INVALID_LENGTH_OR_MULTILINE' };
  }

  for (const re of LIVE_SECRET_PATTERNS) {
    if (re.test(text)) {
      return { safe: false, reason: 'SECRET_DETECTED' };
    }
  }

  // Check inline KEY=VALUE env assignments for high-entropy secrets
  const envMatches = text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{1,})\s*=\s*(['"]?)([^\s'"]{16,})\2/g);
  for (const m of envMatches) {
    const val = m[3] || '';
    if (shannonEntropy(val) >= 3.55) {
      return { safe: false, reason: 'SECRET_DETECTED' };
    }
  }

  for (const re of UNSAFE_BYPASS_PATTERNS) {
    if (re.test(text)) {
      return { safe: false, reason: 'UNSAFE_BYPASS_COMMAND' };
    }
  }

  return { safe: true, reason: null };
}

function isFileTargetToken(tok = '') {
  const clean = String(tok || '').replace(/^['"]|['"]$/g, '');
  if (!clean || clean === './...' || clean.startsWith('-')) return false;
  if (clean.includes('::')) return true;
  if (/^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|tests?[\\/]|src[\\/]|lib[\\/]|packages[\\/]|app[\\/])/i.test(clean)) {
    return true;
  }
  if (/\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|rb|java|kt|cs|php|json|ya?ml|toml|md)$/i.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Normalizes a shell command down to its canonical reusable runner invocation and detects its `commandFamily`.
 * E.g. `poetry run pytest tests/test_auth.py::test_login` -> `{ canonical: 'poetry run pytest', commandFamily: 'pytest' }`.
 *
 * @param {string} rawCommand
 * @returns {{ valid: boolean, canonical: string, commandFamily: string | null, rejectedReason: string | null }}
 */
export function canonicalizeMicroSkillCommand(rawCommand = '') {
  const safety = inspectCommandSafetyForMicroSkill(rawCommand);
  if (!safety.safe) {
    return { valid: false, canonical: '', commandFamily: null, rejectedReason: safety.reason };
  }

  // Reject compound multi-statement shell pipelines (`&&`, `||`, `;`, `|`) to keep micro-skills atomic
  const trimmed = String(rawCommand || '').trim().replace(/\s+/g, ' ');
  if (/(?:\|\||&&|;|\|)/.test(trimmed)) {
    return { valid: false, canonical: '', commandFamily: null, rejectedReason: 'COMPOUND_COMMAND' };
  }

  const tokens = trimmed.split(' ').filter(Boolean);
  // Strip trailing specific file targets while keeping runner, subcommand, and structural flags like `--workspace` / `run`
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i >= 1 && isFileTargetToken(tok)) {
      continue;
    }
    kept.push(tok);
  }

  const canonical = kept.join(' ').trim();
  const lower = canonical.toLowerCase();

  let commandFamily = null;
  if (/\bpytest\b/.test(lower)) {
    commandFamily = 'pytest';
  } else if (/\b(?:vitest|jest|mocha|ava)\b/.test(lower) || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(lower) || /^node\s+--test\b/.test(lower)) {
    commandFamily = 'js-test';
  } else if (/\bcargo\s+test\b/.test(lower)) {
    commandFamily = 'cargo-test';
  } else if (/\bcargo\s+(?:build|check)\b/.test(lower)) {
    commandFamily = 'cargo-build';
  } else if (/\bgo\s+test\b/.test(lower)) {
    commandFamily = 'go-test';
  } else if (/\btsc\b/.test(lower) || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck\b/.test(lower)) {
    commandFamily = 'typecheck';
  } else if (/\b(?:eslint|biome)\b/.test(lower) || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/.test(lower)) {
    commandFamily = 'js-lint';
  } else if (/\b(?:ruff|flake8|black)\b/.test(lower)) {
    commandFamily = 'py-lint';
  } else if (/\bmypy\b|\bpyright\b/.test(lower)) {
    commandFamily = 'py-typecheck';
  } else if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(lower)) {
    commandFamily = 'js-build';
  }

  if (!commandFamily) {
    return { valid: false, canonical, commandFamily: null, rejectedReason: 'UNSUPPORTED_FAMILY' };
  }

  return { valid: true, canonical, commandFamily, rejectedReason: null };
}

export function createEmptyMicroSkillsRegistry() {
  return {
    schemaVersion: '1.0.0',
    skills: [],
    pendingFailuresBySession: {}
  };
}

/**
 * Pure state-transition function recording a shell command's exit outcome in the Micro-Skills registry.
 *
 * @param {object} currentRegistry
 * @param {object} event
 * @param {string} event.command
 * @param {number} event.exitCode
 * @param {number} [event.turn=1]
 * @param {string} [event.sessionId='default']
 * @param {number} [event.confirmSessions=2]
 * @param {string} [event.nowIso]
 */
export function recordShellOutcomeInRegistry(currentRegistry = {}, event = {}) {
  const base = currentRegistry && typeof currentRegistry === 'object'
    ? currentRegistry
    : createEmptyMicroSkillsRegistry();

  const skills = Array.isArray(base.skills) ? base.skills.map((s) => ({
    ...s,
    confirmedSessionIds: Array.isArray(s.confirmedSessionIds) ? [...s.confirmedSessionIds] : []
  })) : [];
  const pendingMap = base.pendingFailuresBySession && typeof base.pendingFailuresBySession === 'object'
    ? { ...base.pendingFailuresBySession }
    : {};

  const parsed = canonicalizeMicroSkillCommand(event.command || '');
  if (!parsed.valid) {
    return {
      updated: false,
      rejectedReason: parsed.rejectedReason,
      promotedSkill: null,
      capturedCandidate: null,
      evictedContradictions: [],
      registry: { schemaVersion: '1.0.0', skills, pendingFailuresBySession: pendingMap }
    };
  }

  const sessionId = String(event.sessionId || 'default');
  const turn = Math.max(1, Number(event.turn ?? 1));
  const exitCode = Number(event.exitCode ?? 0);
  const confirmSessions = Math.max(1, Number(event.confirmSessions ?? 2));
  const nowIso = event.nowIso || new Date().toISOString();
  const sessionFailures = Array.isArray(pendingMap[sessionId]) ? [...pendingMap[sessionId]] : [];

  if (exitCode !== 0) {
    // Prune stale failures (> 3 turns old) and record this failed command
    const fresh = sessionFailures.filter((f) => turn - Number(f.turn || 0) <= 3 && f.failedCmd !== parsed.canonical);
    fresh.push({
      failedCmd: parsed.canonical,
      commandFamily: parsed.commandFamily,
      turn,
      recordedAt: nowIso
    });
    pendingMap[sessionId] = fresh.slice(-8);

    // Track if an existing promoted workingCmd just failed in this session
    for (const sk of skills) {
      if (sk.workingCmd === parsed.canonical && sk.commandFamily === parsed.commandFamily) {
        sk.lastWorkingFailedSession = sessionId;
        sk.lastWorkingFailedTurn = turn;
      }
    }

    return {
      updated: true,
      rejectedReason: null,
      promotedSkill: null,
      capturedCandidate: null,
      evictedContradictions: [],
      registry: { schemaVersion: '1.0.0', skills, pendingFailuresBySession: pendingMap }
    };
  }

  // exitCode === 0: Check contradiction eviction & candidate capture within <= 3 turns
  const evictedContradictions = [];
  for (let i = skills.length - 1; i >= 0; i--) {
    const sk = skills[i];
    const failedCmdNowWorks =
      sk.failedCmd === parsed.canonical &&
      sk.commandFamily === parsed.commandFamily;
    const workingCmdSuperseded =
      sk.commandFamily === parsed.commandFamily &&
      sk.workingCmd !== parsed.canonical &&
      sk.lastWorkingFailedSession === sessionId &&
      typeof sk.lastWorkingFailedTurn === 'number' &&
      turn - sk.lastWorkingFailedTurn >= 0 &&
      turn - sk.lastWorkingFailedTurn <= 3;

    if (failedCmdNowWorks || workingCmdSuperseded) {
      evictedContradictions.push({ ...sk });
      skills.splice(i, 1);
    }
  }

  // Match most recent failure in the same commandFamily within <= 3 turns
  const matchingFailure = [...sessionFailures]
    .reverse()
    .find(
      (f) =>
        f.commandFamily === parsed.commandFamily &&
        f.failedCmd !== parsed.canonical &&
        turn - Number(f.turn || 0) >= 0 &&
        turn - Number(f.turn || 0) <= 3
    );

  if (!matchingFailure) {
    return {
      updated: evictedContradictions.length > 0,
      rejectedReason: null,
      promotedSkill: null,
      capturedCandidate: null,
      evictedContradictions,
      registry: { schemaVersion: '1.0.0', skills, pendingFailuresBySession: pendingMap }
    };
  }

  // Clear consumed failure from session pending list
  pendingMap[sessionId] = sessionFailures.filter((f) => f !== matchingFailure);

  let target = skills.find(
    (s) => s.failedCmd === matchingFailure.failedCmd && s.commandFamily === parsed.commandFamily
  );

  if (!target) {
    target = {
      failedCmd: matchingFailure.failedCmd,
      workingCmd: parsed.canonical,
      commandFamily: parsed.commandFamily,
      confirmedSessionIds: [sessionId],
      confirmedSessions: 1,
      promoted: 1 >= confirmSessions,
      lastVerifiedAt: nowIso
    };
    skills.push(target);
  } else if (target.workingCmd !== parsed.canonical) {
    // Working command changed for this failedCmd -> reset confirmation to new workingCmd
    target.workingCmd = parsed.canonical;
    target.confirmedSessionIds = [sessionId];
    target.confirmedSessions = 1;
    target.promoted = 1 >= confirmSessions;
    target.lastVerifiedAt = nowIso;
  } else {
    if (!target.confirmedSessionIds.includes(sessionId)) {
      target.confirmedSessionIds.push(sessionId);
    }
    target.confirmedSessions = target.confirmedSessionIds.length;
    target.promoted = target.confirmedSessions >= confirmSessions;
    target.lastVerifiedAt = nowIso;
  }

  delete target.lastWorkingFailedSession;
  delete target.lastWorkingFailedTurn;

  return {
    updated: true,
    rejectedReason: null,
    promotedSkill: target.promoted ? { ...target } : null,
    capturedCandidate: { ...target },
    evictedContradictions,
    registry: { schemaVersion: '1.0.0', skills, pendingFailuresBySession: pendingMap }
  };
}

/**
 * Evaluates a `PreToolUse` shell command against promoted Repo Micro-Skills (`RSI-04`).
 *
 * @param {object} registry
 * @param {object} params
 * @param {string} params.command
 * @param {string} [params.flightMode='COACH']
 * @param {string} [params.overrideMode='default']
 */
export function evaluateMicroSkillIntercept(registry = {}, {
  command = '',
  flightMode = 'COACH',
  overrideMode = 'default'
} = {}) {
  const normOverride = String(overrideMode || 'default').toLowerCase();
  if (normOverride === 'off') {
    return { triggered: false, detectorId: 'RSI-04', decision: 'allow' };
  }

  const parsed = canonicalizeMicroSkillCommand(command);
  if (!parsed.valid) {
    return { triggered: false, detectorId: 'RSI-04', decision: 'allow' };
  }

  const skills = Array.isArray(registry?.skills) ? registry.skills : [];
  const match = skills.find(
    (s) => s && s.promoted === true && s.failedCmd === parsed.canonical && s.workingCmd !== parsed.canonical
  );

  if (!match) {
    return { triggered: false, detectorId: 'RSI-04', decision: 'allow' };
  }

  const fMode = String(flightMode || 'COACH').toUpperCase();
  const shouldBlock =
    normOverride === 'block' || (normOverride === 'default' && fMode === 'AUTO_PILOT');

  const reason = `[RSI-04 Repo Micro-Skill] "${match.failedCmd}" previously failed in this repo; use verified command "${match.workingCmd}" instead.`;

  return {
    triggered: true,
    detectorId: 'RSI-04',
    slug: 'micro-skills',
    subType: 'KNOWN_BROKEN_REPO_COMMAND',
    failedCmd: match.failedCmd,
    workingCmd: match.workingCmd,
    commandFamily: match.commandFamily,
    decision: shouldBlock ? 'deny' : 'allow',
    reason,
    hudAlert: reason
  };
}

/**
 * Formats promoted repo Micro-Skills into a compact `SessionStart` StateBaton line
 * strictly capped under `<80` tokens (`<= 300` chars).
 *
 * @param {object} registry
 * @returns {{ snippet: string, estimatedTokens: number, count: number }}
 */
export function formatMicroSkillsBatonSnippet(registry = {}) {
  const skills = Array.isArray(registry?.skills)
    ? registry.skills.filter((s) => s && s.promoted === true && s.failedCmd && s.workingCmd)
    : [];

  if (skills.length === 0) {
    return { snippet: '', estimatedTokens: 0, count: 0 };
  }

  const prefix = '[RSI-04 Verified Repo Commands] ';
  const pairs = [];
  let currentLen = prefix.length;
  for (const sk of skills) {
    const item = `"${sk.failedCmd}" -> "${sk.workingCmd}"`;
    const sepLen = pairs.length > 0 ? 2 : 0;
    if (currentLen + sepLen + item.length > MAX_MICRO_SKILL_BATON_CHARS) {
      break;
    }
    pairs.push(item);
    currentLen += sepLen + item.length;
  }

  if (pairs.length === 0) {
    return { snippet: '', estimatedTokens: 0, count: 0 };
  }

  const snippet = `${prefix}${pairs.join('; ')}`;
  const estimatedTokens = Math.ceil(snippet.length / 4);
  return {
    snippet,
    estimatedTokens,
    count: pairs.length
  };
}

export function resolveMicroSkillsPath(options = {}) {
  const cwd = getCwd(options);
  return path.join(cwd, '.agents', 'state', 'micro_skills.json');
}

export function loadMicroSkillsRegistry(options = {}) {
  const filePath = resolveMicroSkillsPath(options);
  const parsed = readJsonSafe(filePath, null, options);
  if (!parsed || typeof parsed !== 'object') {
    return createEmptyMicroSkillsRegistry();
  }
  return {
    schemaVersion: '1.0.0',
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    pendingFailuresBySession:
      parsed.pendingFailuresBySession && typeof parsed.pendingFailuresBySession === 'object'
        ? parsed.pendingFailuresBySession
        : {}
  };
}

export function recordWorkspaceShellOutcome(event = {}, options = {}) {
  const current = loadMicroSkillsRegistry(options);
  const res = recordShellOutcomeInRegistry(current, event);
  if (res.updated) {
    const filePath = resolveMicroSkillsPath(options);
    writeJsonAtomic(filePath, res.registry, options);
  }
  return res;
}
