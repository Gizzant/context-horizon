/**
 * @file src/guards/circuitBreakers.mjs
 * Normalized 20-Detector Circuit Breaker Engine (`DET-01` through `DET-20`)
 * for Claude Code Attention Horizon.
 *
 * Enforces:
 * - Option-argument skipping in `DET-01` (`git commit -m "-next"` never false-positives as `-n`)
 * - Allowlist for `.env.example`, `.env.sample`, `.env.template` in `DET-02`
 * - Manual-edit-only lockfile gate in `DET-03` (`npm install` via Bash/PowerShell is allowed)
 * - Added/deleted diff-line-only scanning in `DET-05` (never scans whole file, never runs `git checkout --`)
 * - Unicode tag `U+E0000`..`U+E007F` stripping & `<untrusted_subagent_data>` wrapping in `DET-19`
 * - Dotfile-aware multi-agent scope locks in `DET-20`
 */

import {
  path,
  sha256Hex,
  getFileByteSizeSafe,
  resolvePath,
  getCwd,
  readJsonSafe,
  writeJsonAtomic,
  readTextSafe,
  fileExists
} from '../utils/runtime.mjs';
import { normalizeModelId, computeTotalPromptTokens } from '../config/catalogLoader.mjs';
import {
  loadHorizonConfig,
  resolveDetectorOverride,
  applyDetectorOverride
} from '../config/horizonConfig.mjs';
import { recordRepoFileRead } from '../coach/repoCalibration.mjs';
import {
  FLIGHT_MODES,
  normalizeFlightMode,
  isSilentOrOffMode,
  isPrefixInstructionFile,
  evaluateDet09PrefixMutationFence,
  CacheGravityRouter
} from '../coach/cacheGravityRouter.mjs';

export { isPrefixInstructionFile, evaluateDet09PrefixMutationFence };
import { TtlWatchdog } from '../coach/ttlWatchdog.mjs';
import { evaluateScopeAndQuotaBrake } from '../telemetry/scopeLockRegistry.mjs';
import { loadMicroSkillsRegistry, evaluateMicroSkillIntercept } from '../coach/microSkills.mjs';
import {
  RELAY_STATES,
  evaluateScopeBrake,
  evaluateRelayBreaker,
  evaluateTwoStageSightseeingIntercept
} from '../coach/promptHygieneGovernor.mjs';

const SHELL_TOOL_REGEX = /^(Bash|PowerShell|pwsh|cmd|sh)$/i;
const EDIT_WRITE_TOOL_REGEX = /^(Edit|Write|MultiEdit|NotebookEdit)$/i;
const SEARCH_READ_TOOL_REGEX = /^(Read|Grep|Glob|read_file|grep_search)$/i;

const GIT_GLOBAL_OPTS_WITH_ARG = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env'
]);

const GIT_COMMIT_OPTS_WITH_ARG = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '-c',
  '--reedit-message',
  '-C',
  '--reuse-message',
  '--author',
  '--date',
  '--cleanup',
  '-t',
  '--template'
]);

const GIT_CONFIG_OPTS_WITH_ARG = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '-t',
  '--default',
  '--comment',
  '--fixed-value'
]);

const VALID_GIT_COMMIT_UNTRACKED_MODES = new Set(['', 'no', 'normal', 'all']);

const SHORT_COMMIT_ARG_CHARS = new Set(['m', 'F', 'c', 'C', 't']);

const SAFE_ENV_ALLOWLIST_REGEX =
  /(?:^|[\\/])\.env\.(?:example|sample|template|defaults|schema)$/i;

const SECRET_FILE_PATTERNS = [
  /(?:^|[\\/])\.env(?:\.[a-zA-Z0-9._-]+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:^|[\\/])id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /(?:^|[\\/])\.(?:ssh|aws)[\\/]/i,
  /(?:^|[\\/])\.(?:npmrc|netrc|pypirc)$/i
];

const PROTECTED_EDIT_PATTERNS = [
  /(?:^|[\\/])migrations[\\/]/i,
  /(?:^|[\\/])prisma[\\/]migrations[\\/]/i,
  /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/i,
  /(?:^|[\\/])\.github[\\/]workflows[\\/]/i
];

/**
 * Detects whether a command or tool invocation uses PowerShell lexical conventions
 * (leading `&` call operator, `$env:`, or PowerShell backtick flag escapes `` `-- `` / `` `-x ``).
 *
 * @param {string} [toolName='Bash']
 * @param {string} [command='']
 * @returns {boolean}
 */
function detectPowerShellSyntax(toolName = 'Bash', command = '') {
  if (/^(?:PowerShell|pwsh)$/i.test(String(toolName || ''))) {
    return true;
  }
  const str = String(command || '');
  return /(?:^|[;|&\r\n]\s*)&\s*['"A-Za-z0-9_.\\/]|(?:\$env:[A-Za-z_])|(?:`--|`-[A-Za-z])/i.test(
    str
  );
}

/**
 * Tokenizes a shell command line into tokens while preserving quoted strings as single tokens.
 * Supports both POSIX backslash escapes and PowerShell backtick escapes / `&` call operator (`ISS-043`).
 *
 * @param {string} commandSegment
 * @param {{ isPowerShell?: boolean }} [options={}]
 * @returns {Array<string>}
 */
export function tokenizeShellSegment(commandSegment = '', options = {}) {
  const tokens = [];
  const str = String(commandSegment || '').trim();
  const isPowerShell = Boolean(options?.isPowerShell);
  let current = '';
  let quoteChar = null;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quoteChar === "'") {
      if (ch === "'") {
        if (isPowerShell && str[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          quoteChar = null;
        }
      } else {
        current += ch;
      }
    } else if (quoteChar === '"') {
      if (isPowerShell && ch === '`' && i + 1 < str.length) {
        const next = str[i + 1];
        current += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
        i += 1;
      } else if (!isPowerShell && ch === '\\' && i + 1 < str.length && ['"', '\\', '$', '`'].includes(str[i + 1])) {
        current += str[i + 1];
        i += 1;
      } else if (isPowerShell && ch === '\\' && str[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoteChar = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
    } else if (isPowerShell && ch === '`' && i + 1 < str.length) {
      const next = str[i + 1];
      current += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
      i += 1;
    } else if (!isPowerShell && ch === '\\' && i + 1 < str.length) {
      current += str[i + 1];
      i += 1;
    } else if (current.length === 0 && ch === '&' && str[i + 1] !== '&' && str[i + 1] !== '>') {
      tokens.push('&');
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Extracts inner `$(...)` command substitutions (and POSIX `` `...` `` backtick substitutions
 * when `!isPowerShell`) outside single-quoted literals for recursive `DET-01` inspection (`ISS-043`).
 *
 * @param {string} commandLine
 * @param {{ isPowerShell?: boolean }} [options={}]
 * @returns {Array<string>}
 */
function extractCommandSubstitutions(commandLine = '', options = {}) {
  const extracted = [];
  const str = String(commandLine || '');
  const isPowerShell = Boolean(options?.isPowerShell);
  let quoteChar = null;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quoteChar === "'") {
      if (ch === "'") quoteChar = null;
      continue;
    }
    if (quoteChar === '"') {
      if ((ch === '\\' || (isPowerShell && ch === '`')) && i + 1 < str.length) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        quoteChar = null;
        continue;
      }
    } else if (ch === "'" || ch === '"') {
      quoteChar = ch;
      continue;
    } else if ((ch === '\\' || (isPowerShell && ch === '`')) && i + 1 < str.length) {
      i += 1;
      continue;
    }

    // Balanced $(...) extraction
    if (ch === '$' && str[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let innerQuote = null;
      while (j < str.length && depth > 0) {
        const c = str[j];
        if (innerQuote === "'") {
          if (c === "'") innerQuote = null;
        } else if (innerQuote === '"') {
          if (c === '\\' && j + 1 < str.length) {
            j += 1;
          } else if (c === '"') {
            innerQuote = null;
          }
        } else if (c === "'" || c === '"') {
          innerQuote = c;
        } else if (c === '(') {
          depth += 1;
        } else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      if (depth === 0) {
        const inner = str.slice(i + 2, j).trim();
        if (inner) extracted.push(inner);
      }
      continue;
    }

    // POSIX `...` backtick command substitution (only when not PowerShell escape syntax)
    if (!isPowerShell && ch === '`') {
      let j = i + 1;
      while (j < str.length) {
        if (str[j] === '\\' && j + 1 < str.length) {
          j += 2;
          continue;
        }
        if (str[j] === '`') break;
        j += 1;
      }
      if (j < str.length && str[j] === '`') {
        const inner = str.slice(i + 1, j).trim();
        if (inner && !inner.startsWith('-')) {
          extracted.push(inner);
        }
        i = j;
      }
    }
  }

  return extracted;
}

/**
 * Splits a compound Bash, cmd, or PowerShell command into individual command segments
 * on `;`, `\r?\n`, `&&`, `||`, single pipe `|` (`|&`), and non-redirection `&` separators (`ISS-043`).
 *
 * @param {string} commandLine
 * @param {{ isPowerShell?: boolean }} [options={}]
 * @returns {Array<string>}
 */
function splitCommandSegments(commandLine = '', options = {}) {
  const segments = [];
  const str = String(commandLine || '');
  const isPowerShell = Boolean(options?.isPowerShell);
  let current = '';
  let quoteChar = null;
  let subshellDepth = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quoteChar === "'") {
      current += ch;
      if (ch === "'") {
        if (isPowerShell && str[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          quoteChar = null;
        }
      }
      continue;
    }
    if (quoteChar === '"') {
      current += ch;
      if ((ch === '\\' || (isPowerShell && ch === '`')) && i + 1 < str.length) {
        current += str[i + 1];
        i += 1;
      } else if (ch === '"') {
        quoteChar = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      current += ch;
      continue;
    }

    if ((ch === '\\' || (isPowerShell && ch === '`')) && i + 1 < str.length) {
      current += ch + str[i + 1];
      i += 1;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      subshellDepth += 1;
      current += '$(';
      i += 1;
      continue;
    }
    if (subshellDepth > 0) {
      if (ch === '(') subshellDepth += 1;
      else if (ch === ')') subshellDepth -= 1;
      current += ch;
      continue;
    }

    if (ch === ';' || ch === '\n' || ch === '\r') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    if ((ch === '&' && str[i + 1] === '&') || (ch === '|' && str[i + 1] === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    if (ch === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (str[i + 1] === '&') i += 1;
      continue;
    }

    // Split mid-line `&` command separator (cmd.exe / POSIX background) while preserving leading `&` (PowerShell call op) and `2>&1` / `&>`
    const prevChar = i > 0 ? str[i - 1] : '';
    const nextChar = i + 1 < str.length ? str[i + 1] : '';
    if (
      ch === '&' &&
      current.trim().length > 0 &&
      prevChar !== '>' &&
      prevChar !== '<' &&
      nextChar !== '>' &&
      nextChar !== '&'
    ) {
      segments.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
}

/**
 * Checks whether a tokenized `(key, value)` environment variable assignment disables Git hooks
 * or injects `core.hooksPath` (`ISS-043`).
 *
 * @param {string} rawKey
 * @param {string} rawVal
 * @returns {{ subType: string, reason: string } | null}
 */
function checkForbiddenGitEnvAssignment(rawKey, rawVal) {
  const key = String(rawKey || '').trim().toUpperCase();
  const val = String(rawVal ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '');

  if (
    (key === 'HUSKY' && val === '0') ||
    (key === 'HUSKY_SKIP_HOOKS' && (val === '1' || val.toLowerCase() === 'true')) ||
    (key === 'SKIP_GIT_HOOKS' && (val === '1' || val.toLowerCase() === 'true'))
  ) {
    return {
      subType: 'GIT_HOOK_ENV_BYPASS',
      reason: `[DET-01 Git Hook Bypass Blocked] Disabling git hooks via ${key}=${val} is forbidden.`
    };
  }

  if (
    (key === 'GIT_CONFIG_COUNT' && /^[1-9]\d*$/.test(val)) ||
    (/^GIT_CONFIG_KEY_\d+$/.test(key) && /^core\.hooksPath$/i.test(val)) ||
    (key === 'GIT_CONFIG_PARAMETERS' && /core\.hooksPath/i.test(val))
  ) {
    return {
      subType: 'GIT_HOOKS_PATH_OVERRIDE',
      reason: `[DET-01 Git Hook Bypass Blocked] Overriding git config via environment variable ${key}=${val} is forbidden.`
    };
  }

  return null;
}

/**
 * Splits a `KEY=VALUE` token on its first `=` character.
 * @param {string} token
 * @returns {{ key: string, value: string } | null}
 */
function splitEnvKeyValToken(token = '') {
  const m = String(token || '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  if (!m) return null;
  return { key: m[1], value: m[2] };
}

/**
 * DET-01: Destructive Shell & Git Hook-Bypass Blocker (`Bash|PowerShell`).
 * Strictly skips option arguments (such as `-m "-next..."`, `-m "Fix HUSKY=0"`, `-F`, `-c`, `--author`),
 * never blocks `git log -n 5`, `git clean -n`, `git commit -mnotes`, or `git config --get core.hooksPath`,
 * and blocks `-u --no-verify`, pipe/subshell/newline chains, and PowerShell `&` / backtick bypasses (`ISS-043`).
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Bash']
 * @param {string} [params.command='']
 * @param {number} [_depth=0]
 */
export function evaluateDet01GitAndShellSafety(params = {}, _depth = 0) {
  if (_depth > 4) {
    return { detectorId: 'DET-01', triggered: false, decision: 'allow', reason: null };
  }

  const toolName = String(params.toolName || 'Bash');
  if (!SHELL_TOOL_REGEX.test(toolName)) {
    return { detectorId: 'DET-01', triggered: false, decision: 'allow', reason: null };
  }

  const command = String(params.command || params.cmd || '').trim();
  if (!command) {
    return { detectorId: 'DET-01', triggered: false, decision: 'allow', reason: null };
  }

  const isPowerShell = detectPowerShellSyntax(toolName, command);

  // 1. Recursively inspect any inner $(...) or `...` command substitutions
  const substitutions = extractCommandSubstitutions(command, { isPowerShell });
  for (const subCmd of substitutions) {
    const subVerdict = evaluateDet01GitAndShellSafety(
      { toolName: isPowerShell ? 'PowerShell' : toolName, command: subCmd },
      _depth + 1
    );
    if (subVerdict.triggered) return subVerdict;
  }

  // 2. Inspect individual command segments after splitting on ;, &&, ||, |, \r?\n
  const segments = splitCommandSegments(command, { isPowerShell });
  for (const segment of segments) {
    const rawTokens = tokenizeShellSegment(segment, { isPowerShell });
    if (rawTokens.length === 0) continue;

    let idx = 0;

    // Strip leading PowerShell `&` call operator (`& git ...`, `& "git.exe" ...`)
    while (idx < rawTokens.length && rawTokens[idx] === '&') {
      idx += 1;
    }
    if (idx >= rawTokens.length) continue;

    // 2a. PowerShell `$env:KEY = 'VAL'` / `$env:KEY='VAL'` assignment check
    const psEnvMatch = rawTokens[idx].match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/is);
    if (psEnvMatch) {
      const envKey = psEnvMatch[1];
      let envVal = psEnvMatch[2];
      if (envVal === undefined) {
        if (rawTokens[idx + 1] === '=') {
          envVal = rawTokens[idx + 2] ?? '';
        } else if (rawTokens[idx + 1]?.startsWith('=')) {
          envVal = rawTokens[idx + 1].slice(1) || (rawTokens[idx + 2] ?? '');
        }
      }
      if (envVal !== undefined) {
        const envHit = checkForbiddenGitEnvAssignment(envKey, envVal);
        if (envHit) {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: envHit.subType,
            reason: envHit.reason
          };
        }
      }
      continue;
    }

    // 2b. PowerShell `Set-Item Env:HUSKY 0` check
    if (/^(?:Set-Item|si)$/i.test(rawTokens[idx]) && rawTokens[idx + 1]) {
      const envPathMatch = rawTokens[idx + 1].match(/^env:[\\/]?([A-Za-z_][A-Za-z0-9_]*)$/i);
      if (envPathMatch) {
        const envHit = checkForbiddenGitEnvAssignment(envPathMatch[1], rawTokens[idx + 2] ?? '');
        if (envHit) {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: envHit.subType,
            reason: envHit.reason
          };
        }
      }
    }

    // 2c. `export KEY=VAL` or `set KEY=VAL` statements
    const firstWordLower = rawTokens[idx].toLowerCase();
    if (firstWordLower === 'export' || firstWordLower === 'set') {
      for (let eIdx = idx + 1; eIdx < rawTokens.length; eIdx++) {
        const kv = splitEnvKeyValToken(rawTokens[eIdx]);
        if (kv) {
          const envHit = checkForbiddenGitEnvAssignment(kv.key, kv.value);
          if (envHit) {
            return {
              detectorId: 'DET-01',
              triggered: true,
              decision: 'deny',
              subType: envHit.subType,
              reason: envHit.reason
            };
          }
        }
      }
      continue;
    }

    // 2d. Leading `KEY=VAL` assignments (`HUSKY=0 git commit ...`)
    while (idx < rawTokens.length) {
      const kv = splitEnvKeyValToken(rawTokens[idx]);
      if (!kv) break;
      const envHit = checkForbiddenGitEnvAssignment(kv.key, kv.value);
      if (envHit) {
        return {
          detectorId: 'DET-01',
          triggered: true,
          decision: 'deny',
          subType: envHit.subType,
          reason: envHit.reason
        };
      }
      idx += 1;
    }
    while (idx < rawTokens.length && rawTokens[idx] === '&') {
      idx += 1;
    }
    if (idx >= rawTokens.length) continue;

    // 2e. `env` wrapper (`env HUSKY=0 git commit ...`)
    let bin = rawTokens[idx].replace(/^.*[\\/]/, '').toLowerCase();
    if (bin === 'env' || bin === 'env.exe') {
      idx += 1;
      while (idx < rawTokens.length) {
        const t = rawTokens[idx];
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir' || t === '-S') {
          idx += 2;
          continue;
        }
        if (t.startsWith('-')) {
          idx += 1;
          continue;
        }
        const kv = splitEnvKeyValToken(t);
        if (kv) {
          const envHit = checkForbiddenGitEnvAssignment(kv.key, kv.value);
          if (envHit) {
            return {
              detectorId: 'DET-01',
              triggered: true,
              decision: 'deny',
              subType: envHit.subType,
              reason: envHit.reason
            };
          }
          idx += 1;
          continue;
        }
        break;
      }
      if (idx >= rawTokens.length) continue;
      bin = rawTokens[idx].replace(/^.*[\\/]/, '').toLowerCase();
    }

    // 2f. Nested shell wrappers (`bash -c "..."`, `sh -c "..."`, `cmd /c "..."`, `pwsh -Command "..."`)
    if (['bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'dash'].includes(bin)) {
      const cPos = rawTokens.findIndex((t, ti) => ti > idx && (t === '-c' || /^-[a-zA-Z]*c$/.test(t)));
      if (cPos !== -1 && rawTokens[cPos + 1]) {
        const nested = evaluateDet01GitAndShellSafety(
          { toolName: 'Bash', command: rawTokens[cPos + 1] },
          _depth + 1
        );
        if (nested.triggered) return nested;
      }
      continue;
    }
    if (bin === 'cmd' || bin === 'cmd.exe') {
      const cPos = rawTokens.findIndex((t, ti) => ti > idx && /^\/[ck]$/i.test(t));
      if (cPos !== -1 && cPos + 1 < rawTokens.length) {
        const nestedCmd = rawTokens.slice(cPos + 1).join(' ');
        const nested = evaluateDet01GitAndShellSafety(
          { toolName: 'cmd', command: nestedCmd },
          _depth + 1
        );
        if (nested.triggered) return nested;
      }
      continue;
    }
    if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(bin)) {
      const cPos = rawTokens.findIndex((t, ti) => ti > idx && /^-(?:c|command)$/i.test(t));
      if (cPos !== -1 && cPos + 1 < rawTokens.length) {
        const nestedCmd = rawTokens.slice(cPos + 1).join(' ');
        const nested = evaluateDet01GitAndShellSafety(
          { toolName: 'PowerShell', command: nestedCmd },
          _depth + 1
        );
        if (nested.triggered) return nested;
      }
      continue;
    }

    // 2g. Destructive filesystem wipe commands on tokenized segment (`rm -rf /`, `Remove-Item -Recurse -Force C:\`)
    if (bin === 'rm' || bin === 'rm.exe') {
      const rmArgs = rawTokens.slice(idx + 1);
      const hasRecursive = rmArgs.some(
        (a) => a === '--recursive' || (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a))
      );
      const hasForce = rmArgs.some(
        (a) => a === '--force' || (/^-[a-zA-Z]+$/.test(a) && /f/.test(a))
      );
      const targetsRootOrHome = rmArgs.some((a) =>
        /^(?:\/+|\/\*|\~|\$HOME|\$\{HOME\}|[A-Za-z]:[\\/]?)$/i.test(a)
      );
      if (hasRecursive && hasForce && targetsRootOrHome) {
        return {
          detectorId: 'DET-01',
          triggered: true,
          decision: 'deny',
          subType: 'DESTRUCTIVE_FS_WIPE',
          reason: `[DET-01 Destructive Shell Blocked] Recursive root/home deletion is forbidden.`
        };
      }
      continue;
    }

    if (/^(?:remove-item|ri|del|erase|rmdir)$/i.test(bin)) {
      const psArgs = rawTokens.slice(idx + 1);
      const hasRecurse = psArgs.some((a) => /^-r(?:ecurse)?$/i.test(a));
      const hasForce = psArgs.some((a) => /^-f(?:orce)?$/i.test(a));
      const targetsRootOrHome = psArgs.some((a) =>
        /^(?:[A-Za-z]:[\\/]?|\/+|\~|\$HOME|\$env:USERPROFILE)$/i.test(a)
      );
      if (hasRecurse && hasForce && targetsRootOrHome) {
        return {
          detectorId: 'DET-01',
          triggered: true,
          decision: 'deny',
          subType: 'DESTRUCTIVE_FS_WIPE',
          reason: `[DET-01 Destructive Shell Blocked] Recursive root/home deletion is forbidden.`
        };
      }
      continue;
    }

    if (bin !== 'git' && bin !== 'git.exe') continue;
    idx += 1;

    // Parse global git options before subcommand
    let subcommand = null;
    while (idx < rawTokens.length) {
      const tok = rawTokens[idx];
      if (!tok.startsWith('-')) {
        subcommand = tok.toLowerCase();
        idx += 1;
        break;
      }
      if (tok === '-c' && idx + 1 < rawTokens.length) {
        const cfg = rawTokens[idx + 1];
        if (/^core\.hooksPath(?:\s*=|$)/i.test(cfg)) {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: 'GIT_HOOKS_PATH_OVERRIDE',
            reason: `[DET-01 Git Hook Bypass Blocked] Overriding core.hooksPath via "git -c ${cfg}" is forbidden.`
          };
        }
        idx += 2;
        continue;
      }
      if (
        /^-c\s*core\.hooksPath(?:\s*=|$)/i.test(tok) ||
        /^--config-env=core\.hooksPath(?:=|$)/i.test(tok)
      ) {
        return {
          detectorId: 'DET-01',
          triggered: true,
          decision: 'deny',
          subType: 'GIT_HOOKS_PATH_OVERRIDE',
          reason: `[DET-01 Git Hook Bypass Blocked] Overriding core.hooksPath is forbidden.`
        };
      }
      if (tok === '--config-env' && idx + 1 < rawTokens.length) {
        if (/^core\.hooksPath(?:=|$)/i.test(rawTokens[idx + 1])) {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: 'GIT_HOOKS_PATH_OVERRIDE',
            reason: `[DET-01 Git Hook Bypass Blocked] Overriding core.hooksPath via --config-env is forbidden.`
          };
        }
        idx += 2;
        continue;
      }
      if (GIT_GLOBAL_OPTS_WITH_ARG.has(tok)) {
        idx += 2;
      } else {
        idx += 1;
      }
    }

    if (!subcommand) continue;

    const subArgs = rawTokens.slice(idx);

    // Check `git config ... core.hooksPath <val>` (allow read-only `--get`, `--list`, `get`, or single-arg query)
    if (subcommand === 'config') {
      let isReadOnlyQuery = false;
      const positional = [];
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === '--') {
          positional.push(...subArgs.slice(i + 1));
          break;
        }
        if (
          arg === '--get' ||
          arg === '--get-all' ||
          arg === '--get-regexp' ||
          arg === '--get-urlmatch' ||
          arg === '--list' ||
          arg === '-l'
        ) {
          isReadOnlyQuery = true;
          break;
        }
        if (GIT_CONFIG_OPTS_WITH_ARG.has(arg)) {
          i += 1;
          continue;
        }
        if (arg.startsWith('-')) {
          continue;
        }
        positional.push(arg);
      }

      if (!isReadOnlyQuery && positional.length >= 2) {
        const firstPosLower = positional[0].toLowerCase();
        if (firstPosLower !== 'get' && firstPosLower !== 'list') {
          const cfgKey = firstPosLower === 'set' ? positional[1] || '' : positional[0];
          const hasCfgVal = firstPosLower === 'set' ? positional.length >= 3 : positional.length >= 2;
          if (hasCfgVal && /^core\.hooksPath$/i.test(cfgKey)) {
            return {
              detectorId: 'DET-01',
              triggered: true,
              decision: 'deny',
              subType: 'GIT_HOOKS_PATH_OVERRIDE',
              reason: `[DET-01 Git Hook Bypass Blocked] Mutating "git config core.hooksPath" is forbidden.`
            };
          }
        }
      }
      continue;
    }

    // Check `git reset --hard`
    if (subcommand === 'reset' && subArgs.includes('--hard')) {
      return {
        detectorId: 'DET-01',
        triggered: true,
        decision: 'deny',
        subType: 'GIT_RESET_HARD',
        reason: `[DET-01 Destructive Git Blocked] "git reset --hard" destroys uncommitted work.`
      };
    }

    // Check `git clean` with any short-flag cluster containing `f` (e.g. `-f`, `-uf`, `-xfd`) while allowing `-n` / `--dry-run`
    if (subcommand === 'clean') {
      let hasDryRun = false;
      let hasForce = false;
      let hasExplicitLongForce = false;
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === '--') break;
        if (arg === '-e' || arg === '--exclude') {
          i += 1;
          continue;
        }
        if (arg === '-n' || arg === '--dry-run' || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('n'))) {
          hasDryRun = true;
        }
        if (arg === '--force') {
          hasForce = true;
          hasExplicitLongForce = true;
        } else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) {
          hasForce = true;
        }
      }
      if (hasForce && (!hasDryRun || hasExplicitLongForce)) {
        return {
          detectorId: 'DET-01',
          triggered: true,
          decision: 'deny',
          subType: 'GIT_CLEAN_FORCE',
          reason: `[DET-01 Destructive Git Blocked] "git clean -f" permanently deletes untracked files (use "git clean -n" for dry-run).`
        };
      }
    }

    // Check `git commit` with strict option-argument skipping (`-u` optional attached mode, `-mnotes` allowed, `-mfoo --no-verify` denied)
    if (subcommand === 'commit') {
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === '--') break; // End of options

        if (arg === '--no-verify') {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: 'GIT_COMMIT_NO_VERIFY',
            reason: `[DET-01 Git Hook Bypass Blocked] "git commit --no-verify" is forbidden.`
          };
        }

        // Exact option that consumes the next token as its value (e.g. `-m "msg"`, `-F file`, `--author "name"`)
        if (GIT_COMMIT_OPTS_WITH_ARG.has(arg)) {
          i += 1; // Skip argument value token!
          continue;
        }

        // Long option (e.g. `--message=...`, `--untracked-files`, `--untracked-files=no`) -> self-contained
        if (arg.startsWith('--')) {
          continue;
        }

        // Short flag or short flag cluster (`-n`, `-am`, `-amn`, `-m"msg"`, `-mnotes`, `-uno`, `-u`)
        if (arg.startsWith('-') && arg.length > 1) {
          const cluster = arg.slice(1);
          // Pure short-flag cluster not starting with a value-taking flag (e.g. `-n`, `-an`, `-amn`, `-nm`)
          if (
            !SHORT_COMMIT_ARG_CHARS.has(cluster[0]) &&
            cluster[0] !== 'u' &&
            /^[amnvqseS]+$/.test(cluster)
          ) {
            if (cluster.includes('n')) {
              return {
                detectorId: 'DET-01',
                triggered: true,
                decision: 'deny',
                subType: 'GIT_COMMIT_SHORT_NO_VERIFY',
                reason: `[DET-01 Git Hook Bypass Blocked] Short flag "-n" (--no-verify) in "git commit ${arg}" is forbidden.`
              };
            }
            if (cluster.includes('m')) {
              i += 1; // Next token is the commit message argument
            }
            continue;
          }

          let consumedRestOfToken = false;
          for (let cIdx = 0; cIdx < cluster.length; cIdx++) {
            const ch = cluster[cIdx];
            if (ch === 'n') {
              return {
                detectorId: 'DET-01',
                triggered: true,
                decision: 'deny',
                subType: 'GIT_COMMIT_SHORT_NO_VERIFY',
                reason: `[DET-01 Git Hook Bypass Blocked] Short flag "-n" (--no-verify) in "git commit ${arg}" is forbidden.`
              };
            }
            if (ch === 'u') {
              // `-u[<mode>]` takes an optional ATTACHED mode (`no`, `normal`, `all`) and NEVER consumes the next token!
              const restMode = cluster.slice(cIdx + 1);
              if (VALID_GIT_COMMIT_UNTRACKED_MODES.has(restMode)) {
                consumedRestOfToken = true;
                break;
              }
              continue;
            }
            if (SHORT_COMMIT_ARG_CHARS.has(ch)) {
              // If `m`/`F`/`c`/`C`/`t` is the last char in the cluster (e.g. `-am`), the NEXT token is its value
              if (cIdx === cluster.length - 1) {
                i += 1;
              }
              // Otherwise (e.g. `-mnotes`, `-mfoo`), the rest of THIS token is its attached value (do NOT skip next token!)
              consumedRestOfToken = true;
              break;
            }
          }
          if (consumedRestOfToken) continue;
        }
      }
    }

    // Check `git push`, `git merge`, `git rebase`, `git cherry-pick` for `--no-verify` or destructive force push
    if (['push', 'merge', 'rebase', 'cherry-pick'].includes(subcommand)) {
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === '--') break;
        if (arg === '--no-verify') {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: 'GIT_NO_VERIFY',
            reason: `[DET-01 Git Hook Bypass Blocked] "git ${subcommand} --no-verify" is forbidden.`
          };
        }
        if (
          subcommand === 'push' &&
          (arg === '--force' || arg === '-f') &&
          !subArgs.some((a) => a.startsWith('--force-with-lease'))
        ) {
          return {
            detectorId: 'DET-01',
            triggered: true,
            decision: 'deny',
            subType: 'GIT_PUSH_FORCE',
            reason: `[DET-01 Destructive Git Blocked] Unconditional "git push --force" is forbidden (use --force-with-lease if required).`
          };
        }
      }
    }
  }

  return { detectorId: 'DET-01', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-02: Secret & Credential Boundary.
 * Blocks access to `.env*`, `*.pem`, `~/.ssh/*`, `~/.aws/*` while explicitly allowlisting
 * `.env.example`, `.env.sample`, `.env.template`, `.env.defaults`, `.env.schema`.
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Read']
 * @param {string} [params.filePath='']
 * @param {string} [params.command='']
 */
export function evaluateDet02SecretBoundary(params = {}) {
  const candidates = [];
  if (params.filePath) candidates.push(String(params.filePath));
  if (params.path) candidates.push(String(params.path));

  // If shell command, extract any `.env*` or `.pem`/`.ssh`/`.aws` tokens referenced
  if (params.command && SHELL_TOOL_REGEX.test(String(params.toolName || 'Bash'))) {
    const tokens = tokenizeShellSegment(String(params.command));
    for (const tok of tokens) {
      if (
        tok.includes('.env') ||
        tok.includes('.pem') ||
        tok.includes('.ssh') ||
        tok.includes('.aws') ||
        tok.includes('id_rsa') ||
        tok.includes('id_ed25519')
      ) {
        candidates.push(tok);
      }
    }
  }

  for (const rawTarget of candidates) {
    const norm = String(rawTarget || '').trim().replace(/\\/g, '/');
    if (!norm) continue;

    // Explicit allowlist for safe template files
    if (SAFE_ENV_ALLOWLIST_REGEX.test(norm)) {
      continue;
    }

    for (const pattern of SECRET_FILE_PATTERNS) {
      if (pattern.test(norm)) {
        return {
          detectorId: 'DET-02',
          triggered: true,
          decision: 'deny',
          targetPath: norm,
          reason: `[DET-02 Secret & Credential Boundary] Access to sensitive credential path "${norm}" is blocked. (.env.example / .env.sample are permitted.)`
        };
      }
    }
  }

  return { detectorId: 'DET-02', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-03: Protected Migration, Lockfile & Workflow Ask Gate.
 * Triggers `"ask"` on manual `Edit`/`Write` to `migrations/*`, `package-lock.json`, `Cargo.lock`,
 * `.github/workflows/*`. Does NOT block automated `npm install` via `Bash|PowerShell`.
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Edit']
 * @param {string} [params.filePath='']
 */
export function evaluateDet03ProtectedFilesAskGate(params = {}) {
  const toolName = String(params.toolName || '');
  // Only gate manual file Edit/Write tools; never block npm install / cargo via Bash/PowerShell
  if (!EDIT_WRITE_TOOL_REGEX.test(toolName)) {
    return { detectorId: 'DET-03', triggered: false, decision: 'allow', reason: null };
  }

  const filePath = String(params.filePath || params.path || '').trim().replace(/\\/g, '/');
  if (!filePath) {
    return { detectorId: 'DET-03', triggered: false, decision: 'allow', reason: null };
  }

  for (const pattern of PROTECTED_EDIT_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        detectorId: 'DET-03',
        triggered: true,
        decision: 'ask',
        targetPath: filePath,
        reason: `[DET-03 Protected File Ask Gate] Direct manual ${toolName} to "${filePath}" requires confirmation (use package manager CLI for lockfiles).`
      };
    }
  }

  return { detectorId: 'DET-03', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-04: Consecutive Tool Failure Breaker (`>= 3` failures -> block 4th + strategy reset).
 *
 * @param {object} [params={}]
 * @param {number} [params.consecutiveFailures=0]
 * @param {number} [params.threshold=3]
 */
export function evaluateDet04ConsecutiveFailures(params = {}) {
  const count = Math.max(0, Number(params.consecutiveFailures || 0));
  const threshold = Math.max(1, Number(params.threshold ?? 3));

  if (count >= threshold) {
    return {
      detectorId: 'DET-04',
      triggered: true,
      decision: 'deny',
      consecutiveFailures: count,
      reason: `[DET-04 Consecutive Failure Breaker] ${count} consecutive tool failures detected. Halting 4th attempt to prevent retry churn; re-verify assumptions or escalate reasoning effort.`
    };
  }

  return {
    detectorId: 'DET-04',
    triggered: false,
    decision: 'allow',
    consecutiveFailures: count,
    reason: null
  };
}

/**
 * Computes added and deleted lines between `oldText` and `newText` without scanning unchanged lines.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ addedLines: Array<string>, deletedLines: Array<string>, oldLineCount: number, newLineCount: number }}
 */
export function computeAddedAndDeletedDiffLines(oldText = '', newText = '') {
  const oldLines = oldText ? String(oldText).split(/\r?\n/) : [];
  const newLines = newText ? String(newText).split(/\r?\n/) : [];

  const oldCounts = new Map();
  for (const line of oldLines) {
    oldCounts.set(line, (oldCounts.get(line) || 0) + 1);
  }

  const newCounts = new Map();
  for (const line of newLines) {
    newCounts.set(line, (newCounts.get(line) || 0) + 1);
  }

  const addedLines = [];
  for (const [line, count] of newCounts.entries()) {
    const prev = oldCounts.get(line) || 0;
    for (let i = 0; i < count - prev; i++) {
      addedLines.push(line);
    }
  }

  const deletedLines = [];
  for (const [line, count] of oldCounts.entries()) {
    const next = newCounts.get(line) || 0;
    for (let i = 0; i < count - next; i++) {
      deletedLines.push(line);
    }
  }

  return {
    addedLines,
    deletedLines,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length
  };
}

/**
 * Computes a fast deterministic hash of content for `A -> B -> A` oscillation tracking.
 * @param {string} content
 * @returns {string}
 */
export function hashFileContent(content = '') {
  return sha256Hex(String(content ?? '')).slice(0, 16);
}

/**
 * DET-05: AST/Diff Edit Thrashing & Destructive Code Stripping Breaker.
 * Scans ONLY newly added/deleted diff lines (never pre-existing unchanged file lines),
 * checks `A -> B -> A` file hash oscillation, `> 50%` sudden file shrinkage, and stripped assertions.
 * Never invokes destructive `git checkout -- <file>`.
 *
 * @param {object} [params={}]
 * @param {string} [params.filePath='']
 * @param {string} [params.oldText='']
 * @param {string} [params.newText='']
 * @param {number} [params.fullFileOldLines]
 * @param {number} [params.fullFileNewLines]
 * @param {Array<string>} [params.hashHistory=[]] - Previous content hashes for this file
 */
export function evaluateDet05DiffThrashing(params = {}) {
  const oldText = String(params.oldText ?? '');
  const newText = String(params.newText ?? '');
  const { addedLines, deletedLines, oldLineCount, newLineCount } =
    computeAddedAndDeletedDiffLines(oldText, newText);

  const effectiveOldLines = Number(params.fullFileOldLines ?? oldLineCount);
  const effectiveNewLines = Number(params.fullFileNewLines ?? newLineCount);
  const nextHash = hashFileContent(params.fullNewContent ?? newText);

  // 0. Check lazy elision comment placeholders (// ... existing code ...)
  const LAZY_ELISION_REGEX = /(?:\/\/|#|--|\/\*)\s*(?:\.\.\.|…)?\s*(?:existing|rest of|remaining|unchanged)\s+(?:code|implementation|file|methods|lines)\b/i;
  if (LAZY_ELISION_REGEX.test(newText)) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'LAZY_ELISION_PLACEHOLDER',
      nextHash,
      reason: `[DET-05 Destructive Code-Stripping] Diff inserts lazy placeholder comments ("// ... existing code ...") deleting implemented logic. Write the complete surgical replacement.`
    };
  }

  // 1. Check `A -> B -> A` hash oscillation
  const hashHistory = Array.isArray(params.hashHistory) ? params.hashHistory : [];
  const oscillationDetected =
    hashHistory.length >= 2 &&
    hashHistory[hashHistory.length - 2] === nextHash &&
    hashHistory[hashHistory.length - 1] !== nextHash;

  if (oscillationDetected) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'HASH_OSCILLATION_ABA',
      nextHash,
      addedLinesCount: addedLines.length,
      deletedLinesCount: deletedLines.length,
      reason: `[DET-05 Edit Thrashing Breaker] A -> B -> A file hash oscillation detected on "${params.filePath || 'file'}". Stop reverting and re-evaluate root cause.`
    };
  }

  // 2. Check > 50% sudden file shrinkage (when original has >= 12 lines)
  if (effectiveOldLines >= 12 && effectiveNewLines < effectiveOldLines * 0.5) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'SUDDEN_FILE_SHRINKAGE',
      nextHash,
      oldLineCount: effectiveOldLines,
      newLineCount: effectiveNewLines,
      reason: `[DET-05 Destructive Shrinkage Breaker] Edit shrinks "${params.filePath || 'file'}" from ${effectiveOldLines} lines to ${effectiveNewLines} lines (>50% reduction).`
    };
  }

  // 2b. Full-File Regurgitation Check (>=300 lines with >=90% unchanged lines on Write)
  const isFullWrite = String(params.toolName || '').toLowerCase() === 'write' || Boolean(params.isFullWrite);
  if (isFullWrite && effectiveOldLines >= 300 && effectiveNewLines >= Math.floor(effectiveOldLines * 0.9)) {
    const oldLinesArr = oldText.split(/\r?\n/);
    const newLinesArr = newText.split(/\r?\n/);
    const beforeMap = new Map();
    for (const line of oldLinesArr) {
      const trimmed = line.trim();
      beforeMap.set(trimmed, (beforeMap.get(trimmed) || 0) + 1);
    }
    let unchangedCount = 0;
    for (const line of newLinesArr) {
      const trimmed = line.trim();
      const count = beforeMap.get(trimmed) || 0;
      if (count > 0) {
        unchangedCount++;
        beforeMap.set(trimmed, count - 1);
      }
    }
    const changedCount = effectiveOldLines - unchangedCount;
    if (unchangedCount / effectiveOldLines >= 0.90 && changedCount <= Math.max(25, Math.floor(effectiveOldLines * 0.10))) {
      const flightMode = String(params.flightMode || 'COACH').toUpperCase();
      return {
        detectorId: 'DET-05',
        triggered: true,
        decision: flightMode === 'AUTO_PILOT' ? 'ask' : 'allow',
        advisory: flightMode !== 'AUTO_PILOT',
        subType: 'FULL_FILE_REGURGITATION',
        nextHash,
        oldLineCount: effectiveOldLines,
        newLineCount: effectiveNewLines,
        reason: `[DET-05 Full-File Regurgitation] Writing entire ${effectiveOldLines}-line file with ${unchangedCount} lines (${Math.round((unchangedCount / effectiveOldLines) * 100)}%) unchanged. Use surgical Edit instead.`
      };
    }
  }

  // 3. Scan ONLY deleted and added diff lines for test-assertion stripping / error masking
  const assertionRegex = /\b(?:assert\.[a-zA-Z]+|expect\s*\(|should\.)/;
  const trivialTautologyRegex =
    /\b(?:assert\.ok\s*\(\s*true\s*\)|assert\.(?:strictEqual|equal)\s*\(\s*true\s*,\s*true\s*\)|expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\))/;
  const deletedAssertions = deletedLines.filter(
    (l) => assertionRegex.test(l) && !trivialTautologyRegex.test(l)
  );
  const addedAssertions = addedLines.filter(
    (l) => assertionRegex.test(l) && !trivialTautologyRegex.test(l)
  );

  const errorMaskingRegex =
    /(?:catch\s*(?:\([^)]*\))?\s*\{\s*\}|@ts-ignore|@ts-nocheck|eslint-disable)/;
  const addedErrorMasking = addedLines.filter((l) => errorMaskingRegex.test(l));

  if (deletedAssertions.length >= 2 && addedAssertions.length === 0) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'TEST_ASSERTION_STRIPPING',
      nextHash,
      deletedAssertionsCount: deletedAssertions.length,
      reason: `[DET-05 Test Stripping Breaker] Diff deletes ${deletedAssertions.length} test assertions without replacement.`
    };
  }

  if (addedErrorMasking.length > 0 && deletedLines.length > addedLines.length && deletedAssertions.length > 0) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'ERROR_MASKING_DIFF',
      nextHash,
      reason: `[DET-05 Error Masking Breaker] Newly added diff lines introduce empty catch / lint suppression while deleting verification checks.`
    };
  }

  return {
    detectorId: 'DET-05',
    triggered: false,
    decision: 'allow',
    subType: null,
    nextHash,
    addedLinesCount: addedLines.length,
    deletedLinesCount: deletedLines.length,
    reason: null
  };
}

/**
 * DET-06: Main-Thread Blind Search Guard (`> 6` sequential `Read`/`Grep`/`Glob` calls -> nudge `Explore` subagent).
 *
 * @param {object} [params={}]
 * @param {number} [params.sequentialSearchCount=0]
 * @param {number} [params.threshold=6]
 * @param {number} [params.limit]
 */
export function evaluateDet06BlindSearchGuard(params = {}) {
  const count = Math.max(0, Number(params.sequentialSearchCount || 0));
  const rawThreshold = params.threshold ?? params.limit ?? 6;
  const threshold = Math.max(1, Number(rawThreshold));

  if (count > threshold) {
    return {
      detectorId: 'DET-06',
      triggered: true,
      decision: 'advise_subagent',
      advisory: true,
      sequentialSearchCount: count,
      threshold,
      recommendedSubagent: {
        agentType: 'Explore',
        model: 'claude-haiku-5-5'
      },
      reason: `[DET-06 Blind Search Guard] ${count} sequential Read/Grep calls on the main thread (> ${threshold}). Delegate open-ended codebase exploration to an Explore subagent on claude-haiku-5-5 to prevent main-window distractor bloat.`
    };
  }

  return {
    detectorId: 'DET-06',
    triggered: false,
    decision: 'allow',
    sequentialSearchCount: count,
    threshold,
    reason: null
  };
}

/**
 * DET-07: Unbounded Command Output Bomb Guard (`git log` without limit, unpaged `cat` on huge logs/lockfiles).
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Bash']
 * @param {string} [params.command='']
 */
export function evaluateDet07OutputBombGuard(params = {}) {
  const toolName = String(params.toolName || 'Bash');
  const filePath = String(params.filePath || params.path || params.targetPath || '');
  const limit = params.limit != null ? Number(params.limit) : null;

  // Native Read / read_file check on lockfiles and minified bundles
  if (/^(read|read_file|view_file)$/i.test(toolName) && filePath) {
    const norm = filePath.replace(/\\/g, '/');
    const isLockfileOrBundle =
      /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$/i.test(norm) ||
      /\.(?:min\.js|bundle\.min\.js|bundle\.js|min\.css|map)$/i.test(norm) ||
      /(?:^|\/)(dist|build|\.next|out)\/.*\.(?:js|json|css)$/i.test(norm);
    if (isLockfileOrBundle) {
      const isBounded = limit != null && limit > 0 && limit <= 100;
      if (!isBounded) {
        const base = norm.split('/').pop() || 'lockfile';
        return {
          detectorId: 'DET-07',
          triggered: true,
          decision: 'deny',
          subType: 'LOCKFILE_OR_BUNDLE_READ_BLOCKED',
          reason: `[DET-07 Unbounded Output Bomb Guard] Unbounded native Read on "${base}". Dumping full lockfile/bundle wastes context. Inspect package.json or specify line limits <= 100.`
        };
      }
    }
  }

  if (!SHELL_TOOL_REGEX.test(toolName)) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow', reason: null };
  }

  const command = String(params.command || '').trim();
  if (!command) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow', reason: null };
  }

  // Unbounded `git log` without `-n`, `--max-count`, `-<number>`, `head`, or `Select-Object`
  if (
    /\bgit\s+log\b/i.test(command) &&
    !/(?:\s-[n]\s*\d+|\s-\d+\b|--max-count|--oneline\s+-\d+|\|\s*(?:head|tail|Select-Object))/i.test(
      command
    )
  ) {
    return {
      detectorId: 'DET-07',
      triggered: true,
      decision: 'deny',
      subType: 'UNBOUNDED_GIT_LOG',
      reason: `[DET-07 Unbounded Output Bomb Guard] Unbounded "git log" can flood the context window. Add "-n 20" or "--max-count=20".`
    };
  }

  // Unpaged `cat` or `Get-Content` on massive lockfiles or `.jsonl` transcripts
  if (
    /\b(?:cat|Get-Content|type)\s+\S*(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|\.jsonl)\b/i.test(
      command
    ) &&
    !/(?:\|\s*(?:head|tail|Select-Object)|-TotalCount\s+\d+|-Tail\s+\d+)/i.test(command)
  ) {
    return {
      detectorId: 'DET-07',
      triggered: true,
      decision: 'deny',
      subType: 'UNPAGED_LARGE_FILE_DUMP',
      reason: `[DET-07 Unbounded Output Bomb Guard] Dumping entire lockfiles or JSONL transcripts without line limits floods the KV cache. Use head/tail or Grep.`
    };
  }

  return { detectorId: 'DET-07', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-11: Context Rot Soft Horizon Gate (`> 60k` tokens and middle distractor ratio `[D] > 35%`).
 *
 * @param {object} [params={}]
 * @param {number} [params.totalInputTokens=0]
 * @param {number} [params.distractorTokens=0]
 * @param {number} [params.distractorRatio]
 */
export function evaluateDet11ContextRotGate(params = {}) {
  const totalInputTokens = Math.max(
    0,
    Number(params.totalInputTokens ?? params.totalPromptTokens ?? 0)
  );
  let distractorTokens = 0;
  let distractorRatio = 0;

  if (params.distractorTokens !== undefined && params.distractorTokens !== null) {
    distractorTokens = Math.max(0, Number(params.distractorTokens || 0));
    distractorRatio =
      totalInputTokens > 0 ? Number((distractorTokens / totalInputTokens).toFixed(4)) : 0;
  } else if (params.distractorRatio !== undefined && params.distractorRatio !== null) {
    const rawRatio = Math.max(0, Number(params.distractorRatio || 0));
    distractorRatio = Number((rawRatio > 1 ? rawRatio / 100 : rawRatio).toFixed(4));
    distractorTokens = Math.round(totalInputTokens * distractorRatio);
  }

  // Sim 05: Post-commit topic shift check
  const lastTurnGitCommitted = Boolean(params.lastTurnGitCommitted ?? params.last_turn_git_committed);
  const topicShiftDetected = Boolean(params.topicShiftDetected ?? params.topic_shift ?? params.topicShift);
  const turnId = Number(params.turnId ?? params.currentTurn ?? 0);
  const postCommitTopicShift = Boolean(
    params.postCommitTopicShift ??
    (lastTurnGitCommitted && topicShiftDetected && (turnId === 0 || turnId >= 15) && totalInputTokens >= 25_000)
  );

  if (postCommitTopicShift) {
    return {
      detectorId: 'DET-11',
      triggered: true,
      decision: 'advise_compact',
      advisory: true,
      subType: 'POST_COMMIT_TOPIC_SHIFT',
      totalInputTokens,
      distractorTokens,
      distractorRatio,
      reason: `[DET-11 Context Rot Soft Horizon] Post-commit topic shift detected (${(totalInputTokens / 1000).toFixed(1)}k tokens). Previous task was committed; run /compact or /handoff to clear stale context before new feature.`
    };
  }

  if (totalInputTokens > 60_000 && distractorRatio > 0.35) {
    return {
      detectorId: 'DET-11',
      triggered: true,
      decision: 'advise_compact',
      advisory: true,
      totalInputTokens,
      distractorTokens,
      distractorRatio,
      reason: `[DET-11 Context Rot Soft Horizon] Context is ${(totalInputTokens / 1000).toFixed(1)}k tokens with ${(distractorRatio * 100).toFixed(1)}% stale middle-window distractor debt (> 35%). Recommend /compact with StateBaton handoff.`
    };
  }

  return {
    detectorId: 'DET-11',
    triggered: false,
    decision: 'allow',
    totalInputTokens,
    distractorTokens,
    distractorRatio,
    reason: null
  };
}

/**
 * DET-12: Haiku 5.5 `90,000`-Token Pre-Cliff Compaction Breaker (prevents crossing 100k `5x` cliff).
 * Sums `inputTokens + cacheReadTokens + cacheWriteTokens` when `totalPromptTokens` / `totalInputTokens`
 * is not pre-computed so the full prompt envelope is always evaluated against the 100,000-token cliff.
 *
 * @param {object} [params={}]
 * @param {string} [params.modelId='claude-haiku-5-5']
 * @param {number} [params.totalInputTokens=0]
 * @param {number} [params.totalPromptTokens]
 * @param {number} [params.inputTokens]
 * @param {number} [params.cacheReadTokens]
 * @param {number} [params.cacheWriteTokens]
 */
export function evaluateDet12HaikuPreCliffBreaker(params = {}) {
  const modelId = normalizeModelId(params.modelId || params.model || '');
  const totalInputTokens = computeTotalPromptTokens(params);

  if (modelId === 'claude-haiku-5-5' && totalInputTokens >= 90_000) {
    const isHardDeny = totalInputTokens >= 98_000;
    return {
      detectorId: 'DET-12',
      triggered: true,
      decision: isHardDeny ? 'deny' : 'advise_compact',
      advisory: !isHardDeny,
      modelId,
      totalInputTokens,
      cliffThresholdTokens: 100_000,
      reason: `[DET-12 Haiku 5.5 90k Pre-Cliff Breaker] Total prompt size (${totalInputTokens.toLocaleString()} tokens) is approaching Claude Haiku 5.5's 100,000-token 5x price cliff ($0.10->$0.50 input, $0.50->$2.50 output). Compact now to avoid a 5x jump across all token categories.`
    };
  }

  return {
    detectorId: 'DET-12',
    triggered: false,
    decision: 'allow',
    modelId,
    totalInputTokens,
    reason: null
  };
}

/**
 * DET-13: MCP Schema Bloat (`> 15k` startup tokens / `20+` tools) & `tools_changed` Cache-Miss Guard.
 *
 * @param {object} [params={}]
 * @param {number} [params.mcpSchemaTokens=0]
 * @param {number} [params.mcpToolCount=0]
 * @param {string|null} [params.lastMissCause=null]
 * @param {boolean} [params.toolsChanged=false]
 * @param {boolean} [params.cacheWarm=false]
 */
export function evaluateDet13McpSchemaBloatGuard(params = {}) {
  const mcpSchemaTokens = Math.max(0, Number(params.mcpSchemaTokens || 0));
  const mcpToolCount = Math.max(0, Number(params.mcpToolCount || 0));
  const bundledSkillsTokens = Math.max(0, Number(params.bundledSkillsTokens || 0));
  const syncedSkillsTokens = Math.max(0, Number(params.syncedSkillsTokens || 0));
  const claudeMdTokens = Math.max(0, Number(params.claudeMdTokens || 0));
  const turnsElapsed = Math.max(0, Number(params.turnsElapsed || 0));
  const mcpInvocations = Math.max(0, Number(params.mcpInvocations || 0));
  const turn0StaticPrefillBreakdown = {
    bundledSkillsTokens,
    syncedSkillsTokens,
    mcpSchemaTokens,
    claudeMdTokens,
    totalStaticPrefillTokens:
      bundledSkillsTokens + syncedSkillsTokens + mcpSchemaTokens + claudeMdTokens
  };

  const lastMissCause =
    params.lastMissCause || (params.toolsChanged ? 'tools_changed' : null);

  if (lastMissCause === 'tools_changed') {
    return {
      detectorId: 'DET-13',
      triggered: true,
      decision: 'defer_mcp_mutation',
      advisory: true,
      subType: 'TOOLS_CHANGED_CACHE_MISS',
      mcpSchemaTokens,
      mcpToolCount,
      turn0StaticPrefillBreakdown,
      reason: `[DET-13 MCP Cache-Miss Guard] Mid-session MCP "tools_changed" invalidated the warm prompt cache prefix. Queue dynamic MCP registrations in PostCompactMutationQueue.`
    };
  }

  const idleMcpHoarding5Turns =
    mcpSchemaTokens >= 15_000 && turnsElapsed >= 5 && mcpInvocations === 0;

  if (idleMcpHoarding5Turns) {
    return {
      detectorId: 'DET-13',
      triggered: true,
      decision: 'advise_lazy_mcp',
      advisory: true,
      subType: 'IDLE_MCP_HOARDING_5_TURNS',
      recommendedEnv: 'ENABLE_TOOL_SEARCH=auto:5',
      mcpSchemaTokens,
      mcpToolCount,
      turn0StaticPrefillBreakdown,
      reason: `[DET-13 Idle MCP Hoarding] ${mcpSchemaTokens.toLocaleString()} MCP schema tokens injected with 0 invocations across ${turnsElapsed} turns (Turn-0 prefill = ${turn0StaticPrefillBreakdown.totalStaticPrefillTokens.toLocaleString()} tok). Set ENABLE_TOOL_SEARCH=auto:5 or disable unused MCP servers.`
    };
  }

  if (mcpSchemaTokens > 15_000 || mcpToolCount >= 20) {
    return {
      detectorId: 'DET-13',
      triggered: true,
      decision: 'advise_lazy_mcp',
      advisory: true,
      subType: 'MCP_SCHEMA_BLOAT',
      recommendedEnv: 'ENABLE_TOOL_SEARCH=auto:5',
      mcpSchemaTokens,
      mcpToolCount,
      turn0StaticPrefillBreakdown,
      reason: `[DET-13 MCP Schema Bloat] ${mcpToolCount} MCP tools consuming ${mcpSchemaTokens.toLocaleString()} startup tokens (> 15k cap). Set ENABLE_TOOL_SEARCH=auto:5 or disable unused MCP servers.`
    };
  }

  return {
    detectorId: 'DET-13',
    triggered: false,
    decision: 'allow',
    mcpSchemaTokens,
    mcpToolCount,
    turn0StaticPrefillBreakdown,
    reason: null
  };
}

/**
 * DET-14: Premature Completion `Stop` Gate.
 * Strictly checks `stop_hook_active` first to prevent infinite loops.
 * Advisory in `COACH` mode; blocks `Stop` in `AUTO_PILOT` mode only when code was edited without running tests.
 *
 * @param {object} [params={}]
 * @param {boolean} [params.stopHookActive=false]
 * @param {boolean} [params.codeEditedSinceLastTest=false]
 * @param {Array<string>} [params.editedFiles=[]]
 * @param {'OFF'|'SILENT'|'COACH'|'AUTO_PILOT'} [params.mode='COACH']
 */
export function evaluateDet14PrematureStopGate(params = {}) {
  const stopHookActive = Boolean(params.stopHookActive ?? params.stop_hook_active ?? false);
  const mode = normalizeFlightMode(params.mode || FLIGHT_MODES.COACH);
  const editedFiles = Array.isArray(params.editedFiles) ? params.editedFiles : [];
  const codeEditedSinceLastTest = Boolean(
    params.codeEditedSinceLastTest ?? editedFiles.length > 0
  );

  // Loop-safety invariant: NEVER block when `stop_hook_active` is already true
  if (stopHookActive) {
    return {
      detectorId: 'DET-14',
      triggered: false,
      stopHookActive: true,
      decision: 'allow',
      advisory: false,
      reason: null
    };
  }

  if (!codeEditedSinceLastTest || isSilentOrOffMode(mode)) {
    return {
      detectorId: 'DET-14',
      triggered: false,
      stopHookActive: false,
      decision: 'allow',
      advisory: false,
      reason: null
    };
  }

  const fileSummary = editedFiles.slice(0, 4).join(', ') || 'workspace source files';

  if (mode === FLIGHT_MODES.COACH) {
    return {
      detectorId: 'DET-14',
      triggered: true,
      stopHookActive: false,
      decision: 'allow',
      advisory: true,
      reason: `[DET-14 Verification Advisory] Modified ${fileSummary} without running tests in this turn.`
    };
  }

  // AUTO_PILOT mode: block premature Stop once
  return {
    detectorId: 'DET-14',
    triggered: true,
    stopHookActive: false,
    decision: 'block',
    advisory: false,
    reason: `[DET-14 Premature Stop Gate] Modified ${fileSummary} without running verification tests. Run the relevant unit test suite before completing the turn.`
  };
}

/**
 * DET-15: Batched `Stop`-Phase Formatter.
 * Collects modified files during the turn so formatting can run once at `Stop` instead of after every edit.
 *
 * @param {object} [params={}]
 * @param {Array<string>} [params.modifiedFiles=[]]
 */
export function evaluateDet15BatchedStopFormatter(params = {}) {
  const files = Array.from(new Set(params.modifiedFiles || []))
    .map((f) => String(f).trim())
    .filter((f) => /\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|css|html)$/i.test(f));

  if (files.length === 0) {
    const cmd = String(params.command || params.cmd || '').trim();
    if (
      cmd &&
      /\b(?:prettier\s+(?:--write|-w)|biome\s+format\s+--write|gofmt\s+-w|rustfmt)\b/i.test(cmd)
    ) {
      return {
        detectorId: 'DET-15',
        triggered: true,
        filesToFormat: [],
        batchCommand: cmd
      };
    }
    return {
      detectorId: 'DET-15',
      triggered: false,
      filesToFormat: [],
      batchCommand: null
    };
  }

  return {
    detectorId: 'DET-15',
    triggered: true,
    filesToFormat: files,
    batchCommand: `npx prettier --write ${files.map((f) => `"${f}"`).join(' ')}`
  };
}

/**
 * DET-15: Pre-Invocation / Pre-Tool-Use Local CLI Formatter Bypass Advisory.
 * Emits advisory recommending local `npx prettier --write` / `npx eslint --fix` on pasted >=40-line blocks.
 *
 * @param {object} [params={}]
 */
export function evaluateDet15PreFormatBypass(params = {}) {
  const prompt = String(params.prompt || params.userPrompt || '');
  const newText = String(params.newText || '');
  const lineCount = Number(
    params.lineCount ??
    (newText ? newText.split(/\r?\n/).length : (prompt.match(/\r?\n/g) || []).length)
  );
  const isFormattingIntent = /\b(fix\s+(?:the\s+)?indentation|sort\s+(?:the\s+)?imports|format\s+this\s+(?:code|file|block)|convert\s+tabs\s+to\s+spaces|run\s+prettier)\b/i.test(prompt);

  if (isFormattingIntent && lineCount >= 40 && !/\b(add|implement|refactor|create|fix\s+bug|logic|test|calculate)\b/i.test(prompt)) {
    return {
      detectorId: 'DET-15',
      triggered: true,
      subType: 'LOCAL_FORMATTER_BYPASS',
      decision: 'allow',
      advisory: true,
      reason: '[DET-15 Local Formatter Bypass] Prompt requests code formatting / import sorting on a pasted code block. Run `npx prettier --write <file>` or `npx eslint --fix <file>` directly (0 LLM tokens).'
    };
  }

  return { detectorId: 'DET-15', triggered: false, decision: 'allow' };
}

/**
 * DET-16: Subagent Token (`40k`) & Turn (`12`) Recursion Cap.
 *
 * @param {object} [params={}]
 * @param {string} [params.agentId]
 * @param {number} [params.turns=0]
 * @param {number} [params.totalTokens=0]
 * @param {number} [params.maxTurns=12]
 * @param {number} [params.maxTokens=40000]
 */
export function evaluateDet16SubagentRecursionCap(params = {}) {
  const agentId = params.agentId || null;
  if (!agentId) {
    return { detectorId: 'DET-16', triggered: false, decision: 'allow', reason: null };
  }

  const turns = Math.max(0, Number(params.turns || 0));
  const totalTokens = Math.max(0, Number(params.totalTokens || 0));
  const maxTurns = Number(params.maxTurns ?? 12);
  const maxTokens = Number(params.maxTokens ?? 40_000);

  if (turns >= maxTurns || totalTokens >= maxTokens) {
    return {
      detectorId: 'DET-16',
      triggered: true,
      decision: 'deny',
      agentId,
      turns,
      totalTokens,
      reason: `[DET-16 Subagent Recursion Cap] Subagent "${agentId}" reached ${turns}/${maxTurns} turns and ${totalTokens.toLocaleString()}/${maxTokens.toLocaleString()} tokens. Terminate exploration and return synthesized summary immediately.`
    };
  }

  return {
    detectorId: 'DET-16',
    triggered: false,
    decision: 'allow',
    agentId,
    turns,
    totalTokens,
    reason: null
  };
}

/**
 * DET-17: Untimely Auto-Compaction Deferral (`PreCompact` `auto` mid-batch syntax guard).
 *
 * @param {object} [params={}]
 * @param {'auto'|'manual'} [params.trigger='auto']
 * @param {boolean} [params.midBatchEditInProgress=false]
 * @param {boolean} [params.unbalancedSyntaxDetected=false]
 */
export function evaluateDet17AutoCompactionDeferral(params = {}) {
  const trigger = String(params.trigger || 'auto').toLowerCase();
  const midBatch = Boolean(params.midBatchEditInProgress || params.unbalancedSyntaxDetected);
  const cacheExpired = Boolean(params.cacheExpired);
  const cachedTokens = Math.max(0, Number(params.cachedTokens ?? params.cached_tokens ?? 0));

  if (cacheExpired && cachedTokens >= 25_000) {
    return {
      detectorId: 'DET-17',
      subType: 'COLD_CACHE_COMPACT_BLOCKED',
      triggered: true,
      decision: 'defer',
      reason: `[DET-17 Cold-Cache /compact Guard] Prompt cache TTL has expired (${cachedTokens.toLocaleString()} cold tokens). Running /compact now would pay full uncached input rates to summarize stale history — flush a <300-token StateBaton and /clear instead.`
    };
  }

  if (trigger === 'auto' && midBatch) {
    return {
      detectorId: 'DET-17',
      subType: 'MID_BATCH_DEFERRED',
      triggered: true,
      decision: 'defer',
      reason: `[DET-17 Auto-Compaction Deferred] Deferring automatic compaction while a multi-file edit batch or syntax repair is in progress.`
    };
  }

  return {
    detectorId: 'DET-17',
    triggered: false,
    decision: 'allow',
    reason: null
  };
}

/**
 * Pure zero-I/O evaluator for Silent Prefix Mutations (`Sim 01` & `Sim 16` in Claude Code):
 *  - `LATE_MCP_CONNECT`: MCP server count or schema hash changing after Turn 1
 *  - `MEMORY_MD_MID_THREAD_MUTATION`: Mid-thread `MEMORY.md` hash/byte change (up to 25KB)
 *  - `IDE_STATE_PREFIX_MUTATION`: Dynamic IDE state injected into system prefix instead of user-turn tail
 *  - `LOOKBACK_WINDOW_DELETION`: Message deletion inside 20-block lookback window shifting cached suffix
 */
export function evaluateSilentPrefixMutations(params = {}) {
  const turn = Math.max(1, Number(params.turnCount || 1));
  const subTypes = [];
  const details = [];
  let shiftedSuffixTokens = 0;

  if (turn > 1) {
    const mcpCountChanged =
      params.prevMcpServerCount != null &&
      params.currMcpServerCount != null &&
      Number(params.prevMcpServerCount) !== Number(params.currMcpServerCount);
    const mcpHashChanged =
      Boolean(params.prevMcpSchemaHash && params.currMcpSchemaHash) &&
      String(params.prevMcpSchemaHash) !== String(params.currMcpSchemaHash);
    if (mcpCountChanged || mcpHashChanged) {
      subTypes.push('LATE_MCP_CONNECT');
      details.push(
        `Mid-session MCP server/schema change at Turn ${turn} (${params.prevMcpServerCount ?? '?'} -> ${params.currMcpServerCount ?? '?'} servers)`
      );
    }

    const memHashChanged =
      Boolean(params.prevMemoryMdHash && params.currMemoryMdHash) &&
      String(params.prevMemoryMdHash) !== String(params.currMemoryMdHash);
    const memBytesChanged =
      params.prevMemoryMdBytes != null &&
      params.currMemoryMdBytes != null &&
      Number(params.prevMemoryMdBytes) !== Number(params.currMemoryMdBytes);
    if (memHashChanged || memBytesChanged) {
      subTypes.push('MEMORY_MD_MID_THREAD_MUTATION');
      const kb =
        params.currMemoryMdBytes != null
          ? `${(Number(params.currMemoryMdBytes) / 1024).toFixed(1)}KB`
          : 'updated';
      details.push(`Mid-thread MEMORY.md mutation (${kb}) invalidated static system prefix`);
    }

    const ideHashChanged =
      Boolean(params.prevIdePrefixHash && params.currIdePrefixHash) &&
      String(params.prevIdePrefixHash) !== String(params.currIdePrefixHash);
    if (Boolean(params.ideStateInSystemPrefix) || ideHashChanged) {
      subTypes.push('IDE_STATE_PREFIX_MUTATION');
      details.push(
        'Dynamic IDE state (active tab / highlighted lines / Problems diagnostics) injected into system prefix instead of user-turn tail'
      );
    }
  }

  if (
    Array.isArray(params.prevMessageIds) &&
    Array.isArray(params.currMessageIds) &&
    params.prevMessageIds.length > 0
  ) {
    const currSet = new Set(params.currMessageIds);
    let firstDeletedIdx = -1;
    let deletedCount = 0;
    for (let i = 0; i < params.prevMessageIds.length; i++) {
      if (!currSet.has(params.prevMessageIds[i])) {
        if (firstDeletedIdx === -1) firstDeletedIdx = i;
        deletedCount += 1;
      }
    }
    if (firstDeletedIdx !== -1) {
      const remaining = Math.max(0, params.prevMessageIds.length - firstDeletedIdx - deletedCount);
      if (Array.isArray(params.tokensPerMessage)) {
        for (let j = firstDeletedIdx + deletedCount; j < params.prevMessageIds.length; j++) {
          shiftedSuffixTokens += Math.max(0, Number(params.tokensPerMessage[j] || 0));
        }
      } else {
        shiftedSuffixTokens = remaining * Math.max(1, Number(params.tokensPerMessage || 5000));
      }
      subTypes.push('LOOKBACK_WINDOW_DELETION');
      details.push(
        `Deleted ${deletedCount} historical message(s) starting at index ${firstDeletedIdx}, shifting ${shiftedSuffixTokens.toLocaleString()} suffix tokens outside 20-block lookback window`
      );
    }
  }

  const triggered = subTypes.length > 0;
  const detectorId = subTypes.includes('LOOKBACK_WINDOW_DELETION')
    ? 'DET-09'
    : subTypes.includes('LATE_MCP_CONNECT')
      ? 'DET-13'
      : 'DET-09';

  return {
    detectorId,
    triggered,
    subTypes,
    shiftedSuffixTokens:
      shiftedSuffixTokens || (triggered ? Math.max(0, Number(params.cachedTokens || 0)) : 0),
    details,
    reason: triggered ? `[${detectorId} Silent Prefix Mutation] ${details.join('; ')}.` : null
  };
}

/**
 * DET-18: Untrusted Project `settings.json` Hook CVE & Clobber Guard.
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Write']
 * @param {string} [params.filePath='']
 * @param {string} [params.newText='']
 */
export function evaluateDet18UntrustedSettingsGuard(params = {}) {
  const filePath = String(params.filePath || params.path || '').trim().replace(/\\/g, '/');
  if (!/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(filePath)) {
    return { detectorId: 'DET-18', triggered: false, decision: 'allow', reason: null };
  }

  const content = String(params.newText || params.content || '');
  const suspiciousHookRegex =
    /(?:\bcurl\b.*\|\s*(?:sh|bash|pwsh)|\bwget\b.*\|\s*(?:sh|bash)|\bInvoke-Expression\b|\biex\b\s*\(|\bnc\s+-e\b|\bbase64\s+-d\b.*\|\s*(?:sh|bash))/i;

  if (suspiciousHookRegex.test(content)) {
    return {
      detectorId: 'DET-18',
      triggered: true,
      decision: 'deny',
      subType: 'MALICIOUS_SETTINGS_HOOK_CVE',
      targetPath: filePath,
      reason: `[DET-18 Untrusted Settings CVE Guard] Blocked suspicious remote shell execution payload in "${filePath}".`
    };
  }

  if (EDIT_WRITE_TOOL_REGEX.test(String(params.toolName || 'Write')) && !params.hasBackup) {
    return {
      detectorId: 'DET-18',
      triggered: true,
      decision: 'ask',
      subType: 'SETTINGS_CLOBBER_GUARD',
      targetPath: filePath,
      reason: `[DET-18 Settings Clobber Guard] Direct modification of "${filePath}" requires user confirmation (or use "npx ah-claude install" for non-destructive backup merge).`
    };
  }

  return { detectorId: 'DET-18', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-19: Subagent Indirect Prompt Injection (IPI) & Untrusted URL Exfiltration Sanitizer (`ISS-053`).
 * - Neutralizes XML boundary breakout tags (`</untrusted_subagent_data>`, `<untrusted_subagent_output>`) BEFORE wrapping.
 * - Strips Unicode tag characters (`U+E0000`..`U+E007F`), zero-width/bidi override & isolate chars (`U+200B`..`U+200F`,
 *   `U+202A`..`U+202E`, `U+2060`..`U+2069`, `U+061C`, `U+FEFF`), general HTML comments (`<!-- ... -->`),
 *   `<script>`/`<style>` blocks, `data:text/html` / `application/javascript` URIs, chat template tokens,
 *   and line-leading prompt-injection role spoof headers.
 * - Counts stripped/neutralized source characters BEFORE replacement substitution so `strippedCharCount > 0`
 *   whenever any injection vector is neutralized.
 * - Wraps subagent / untrusted data in `<untrusted_subagent_data trust="untrusted" readonly="true">...</untrusted_subagent_data>`.
 * - Blocks `WebFetch` URLs attempting to exfiltrate secrets/tokens in query strings.
 *
 * @param {object} [params={}]
 * @param {string} [params.text='']
 * @param {string} [params.url='']
 * @param {boolean} [params.wrapUntrusted=true]
 */
export function evaluateDet19SubagentIpiSanitizer(params = {}) {
  const urlStr = String(params.url || '').trim();
  if (urlStr) {
    if (
      /(?:api[_-]?key|secret|token|password|authorization|aws_access_key|sk-ant-)[=:]\S+/i.test(
        urlStr
      ) ||
      /\$\{?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\}?/i.test(urlStr)
    ) {
      return {
        detectorId: 'DET-19',
        triggered: true,
        blocked: true,
        hadInjectionMarkers: false,
        decision: 'deny',
        subType: 'URL_EXFILTRATION_BLOCKED',
        sanitizedText: '',
        strippedCharCount: 0,
        reason: `[DET-19 Untrusted URL Exfiltration Blocked] Outbound request URL contains credential or environment secret interpolation.`
      };
    }
  }

  const rawText = String(params.text ?? '');
  if (!rawText) {
    return {
      detectorId: 'DET-19',
      triggered: false,
      blocked: false,
      hadInjectionMarkers: false,
      decision: 'allow',
      sanitizedText: '',
      strippedCharCount: 0,
      reason: null
    };
  }

  let strippedCharCount = 0;
  let hadInjectionMarkers = false;

  const stripEmpty = (text, regex) =>
    text.replace(regex, (match) => {
      strippedCharCount += match.length;
      hadInjectionMarkers = true;
      return '';
    });

  const stripWithMarker = (text, regex, replacement = '[STRIPPED_IPI_MARKER]') =>
    text.replace(regex, (match) => {
      strippedCharCount += match.length;
      hadInjectionMarkers = true;
      return replacement;
    });

  // 1. Neutralize closing/opening XML boundary tags FIRST so untrusted payloads can NEVER break out
  const boundaryTagRegex = /<\s*\/?\s*untrusted_subagent_(?:data|output)\b[^>]*>/gi;
  let cleaned = rawText.replace(boundaryTagRegex, (match) => {
    strippedCharCount += match.length;
    hadInjectionMarkers = true;
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });

  // 2. Strip Unicode Tags (U+E0000..U+E007F) and zero-width / bidi overrides & isolates / Arabic Letter Mark (U+061C)
  cleaned = stripEmpty(cleaned, /[\u{E0000}-\u{E007F}]/gu);
  cleaned = stripEmpty(cleaned, /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g);

  // 3. Strip general HTML comments, <script>, <style>, executable data: URIs, and chat template tokens
  cleaned = stripWithMarker(cleaned, /<!--[\s\S]*?-->/g);
  cleaned = stripWithMarker(cleaned, /<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi);
  cleaned = stripWithMarker(cleaned, /<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi);
  cleaned = stripWithMarker(
    cleaned,
    /data:(?:text\/(?:html|javascript)|application\/(?:javascript|x-javascript)|image\/svg\+xml)[^,\s"')]*(?:,[^\s"')>]+)?/gi
  );
  cleaned = stripWithMarker(
    cleaned,
    /<\|(?:im_start|im_end|endoftext|assistant|system|user|startoftext|extra_\d+)\|>/gi
  );

  // 4. Neutralize line-leading prompt-injection role spoof headers
  cleaned = cleaned.replace(
    /(^|\n)([ \t]*(?:SYSTEM|DEVELOPER|IMPORTANT\s+INSTRUCTION|IGNORE\s+(?:ALL\s+)?PREVIOUS\s+INSTRUCTIONS)[ \t]*:)/gi,
    (_full, prefix, roleHeader) => {
      strippedCharCount += roleHeader.length;
      hadInjectionMarkers = true;
      return `${prefix}[STRIPPED_IPI_MARKER]:`;
    }
  );

  if (params.wrapUntrusted !== false) {
    cleaned = `<untrusted_subagent_data trust="untrusted" readonly="true">\n${cleaned}\n</untrusted_subagent_data>`;
  }

  return {
    detectorId: 'DET-19',
    triggered: hadInjectionMarkers,
    blocked: false,
    hadInjectionMarkers,
    decision: 'allow',
    subType: hadInjectionMarkers ? 'IPI_PAYLOAD_SANITIZED' : null,
    sanitizedText: cleaned,
    strippedCharCount,
    reason: hadInjectionMarkers
      ? `[DET-19 Subagent IPI Sanitizer] Neutralized ${strippedCharCount} char(s) of hidden Unicode / XML boundary / prompt-injection markers and wrapped output in <untrusted_subagent_data trust="untrusted" readonly="true">.`
      : null
  };
}

/**
 * DET-20: Concurrent Multi-Agent File-Scope Lockfile + Quota Hard Brake.
 * Wrapper delegating to `evaluateScopeAndQuotaBrake` in `src/telemetry/scopeLockRegistry.mjs`.
 */
export function evaluateDet20ScopeLockAndQuotaBrake(params = {}, options = {}) {
  return evaluateScopeAndQuotaBrake(params, options);
}

/**
 * Sanitizes a session ID for `.claude/cache/ah_breaker_state_<sessionId>.json`.
 * @param {string} [sessionId='default']
 * @returns {string}
 */
export function sanitizeBreakerSessionId(sessionId = 'default') {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Resolves the atomic CLI circuit-breaker state file path (`.claude/cache/ah_breaker_state_<sessionId>.json`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {string}
 */
export function getBreakerStateFilePath(sessionId = 'default', options = {}) {
  if (options?.breakerStatePath) {
    return options.breakerStatePath;
  }
  const cwd = getCwd(options);
  return path.join(
    cwd,
    '.claude',
    'cache',
    `ah_breaker_state_${sanitizeBreakerSessionId(sessionId)}.json`
  );
}

/**
 * Safely reads a persisted `CircuitBreakerEngine` snapshot from disk (`ISS-038`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function readBreakerStateSnapshot(sessionId = 'default', options = {}) {
  return readJsonSafe(getBreakerStateFilePath(sessionId, options), null, options);
}

/**
 * Atomically writes a `CircuitBreakerEngine` snapshot to disk (`ISS-038`).
 * @param {string} [sessionId='default']
 * @param {object} [snapshot={}]
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function writeBreakerStateSnapshot(sessionId = 'default', snapshot = {}, options = {}) {
  return writeJsonAtomic(getBreakerStateFilePath(sessionId, options), snapshot, options);
}

/**
 * Unified Stateful Circuit Breaker Engine (`DET-01`..`DET-20`).
 */
export class CircuitBreakerEngine {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.options = options;
    this.horizonConfig = options.horizonConfig || loadHorizonConfig(options);
    this.mode = normalizeFlightMode(
      options.mode || options.flightMode || this.horizonConfig?.flightMode || FLIGHT_MODES.COACH
    );
    this.consecutiveFailures = Number(options.consecutiveFailures || 0);
    this.lastFailedToolKey = options.lastFailedToolKey || null;
    this.sequentialSearchCount = Number(options.sequentialSearchCount || 0);
    this.fileHashHistory = new Map();
    this.modifiedFilesInTurn = new Set();
    this.pendingBatchEdits = new Set();
    this.pendingFormatFiles = new Set();
    this.codeEditedSinceLastTest = Boolean(options.codeEditedSinceLastTest || false);
    this.lastTurnGitCommitted = Boolean(options.lastTurnGitCommitted || false);
    this.committedTopDirs = Array.isArray(options.committedTopDirs) ? [...options.committedTopDirs] : [];
    this.consecutiveTrivialMaxEffortTurns = Number(options.consecutiveTrivialMaxEffortTurns || 0);
    this.recentEditTimestampsByFile = options.recentEditTimestampsByFile && typeof options.recentEditTimestampsByFile === 'object' ? { ...options.recentEditTimestampsByFile } : {};
    this.totalDiscoveryCalls = Number(options.totalDiscoveryCalls || 0);
    this.consecutiveVisionTurns = Number(options.consecutiveVisionTurns || 0);
    this.unanchoredTurnFlag = Boolean(options.unanchoredTurnFlag || false);
    this.candidateFiles = Array.isArray(options.candidateFiles) ? [...options.candidateFiles] : [];
    this.relayState = options.relayState && typeof options.relayState === 'object'
      ? { ...options.relayState }
      : { state: RELAY_STATES.IDLE, critiquePastes: 0, boundSpecPath: 'SPEC.md' };
    this.steeredPrompts = Number(options.steeredPrompts || 0);
    this.blockedPrompts = Number(options.blockedPrompts || 0);
    this.sightseeingToolsPrevented = Number(options.sightseeingToolsPrevented || 0);
    this.subagentTurns = {};
    this.subagentTokens = {};
    this.det11AdvisedTurn = null;
    this.det13AdvisedTurn = null;
    this.router =
      options.router instanceof CacheGravityRouter
        ? options.router
        : new CacheGravityRouter({ mode: this.mode, ...options });
    this.watchdog =
      options.watchdog instanceof TtlWatchdog
        ? options.watchdog
        : new TtlWatchdog({ mode: this.mode, ...options });

    if (options.initialState && typeof options.initialState === 'object') {
      this.hydrateStateSnapshot(options.initialState);
    }
  }

  /**
   * Updates the active flight mode across the engine, router, and watchdog (`ISS-038`).
   * @param {string} mode
   * @returns {string}
   */
  setMode(mode) {
    this.mode = normalizeFlightMode(mode);
    this.router.setMode(this.mode);
    this.watchdog.setMode(this.mode);
    return this.mode;
  }

  /**
   * Reloads `.attention-horizon.json` and synchronizes flight mode unless pinned by explicit `options.mode`.
   * @param {object} [overrideOptions={}]
   * @returns {object}
   */
  refreshConfig(overrideOptions = {}) {
    const mergedOpts = { ...this.options, ...overrideOptions };
    delete mergedOpts.horizonConfig;
    this.horizonConfig = overrideOptions.horizonConfig || loadHorizonConfig(mergedOpts);
    const nextMode =
      overrideOptions.mode || overrideOptions.flightMode || this.horizonConfig?.flightMode || FLIGHT_MODES.COACH;
    this.setMode(nextMode);
    return this.horizonConfig;
  }

  /**
   * Exports a serializable snapshot of all stateful breaker counters and queues (`ISS-038`).
   * @returns {object}
   */
  exportStateSnapshot() {
    const hashObj = {};
    for (const [k, v] of this.fileHashHistory.entries()) {
      hashObj[k] = Array.isArray(v) ? [...v] : [];
    }
    return {
      schemaVersion: '1.0.0',
      updatedAt: Date.now(),
      mode: this.mode,
      consecutiveFailures: this.consecutiveFailures,
      lastFailedToolKey: this.lastFailedToolKey,
      sequentialSearchCount: this.sequentialSearchCount,
      fileHashHistory: hashObj,
      modifiedFilesInTurn: Array.from(this.modifiedFilesInTurn),
      editedFiles: Array.from(this.modifiedFilesInTurn),
      pendingBatchEdits: Array.from(this.pendingBatchEdits),
      pendingFormatFiles: Array.from(this.pendingFormatFiles),
      codeEditedSinceLastTest: Boolean(this.codeEditedSinceLastTest),
      lastTurnGitCommitted: Boolean(this.lastTurnGitCommitted),
      committedTopDirs: Array.isArray(this.committedTopDirs) ? [...this.committedTopDirs] : [],
      consecutiveTrivialMaxEffortTurns: this.consecutiveTrivialMaxEffortTurns,
      recentEditTimestampsByFile: { ...this.recentEditTimestampsByFile },
      totalDiscoveryCalls: this.totalDiscoveryCalls,
      consecutiveVisionTurns: this.consecutiveVisionTurns,
      unanchoredTurnFlag: Boolean(this.unanchoredTurnFlag),
      candidateFiles: Array.isArray(this.candidateFiles) ? [...this.candidateFiles] : [],
      relayState: this.relayState ? { ...this.relayState } : { state: RELAY_STATES.IDLE, critiquePastes: 0, boundSpecPath: 'SPEC.md' },
      steeredPrompts: Number(this.steeredPrompts || 0),
      blockedPrompts: Number(this.blockedPrompts || 0),
      sightseeingToolsPrevented: Number(this.sightseeingToolsPrevented || 0),
      subagentTurns: { ...this.subagentTurns },
      subagentTokens: { ...this.subagentTokens },
      det11AdvisedTurn: this.det11AdvisedTurn,
      det13AdvisedTurn: this.det13AdvisedTurn,
      queuedMutations: this.router.mutationQueue.toJSON(),
      hysteresisState: this.router.hysteresisLock.getStatus()
    };
  }

  /**
   * Hydrates stateful breaker counters and queues from a previously exported snapshot (`ISS-038`).
   * @param {object | null} snap
   * @returns {this}
   */
  hydrateStateSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return this;

    if (typeof snap.consecutiveFailures === 'number' && Number.isFinite(snap.consecutiveFailures)) {
      this.consecutiveFailures = Math.max(0, snap.consecutiveFailures);
    }
    if (snap.lastFailedToolKey !== undefined) {
      this.lastFailedToolKey = snap.lastFailedToolKey ? String(snap.lastFailedToolKey) : null;
    }
    if (
      typeof snap.sequentialSearchCount === 'number' &&
      Number.isFinite(snap.sequentialSearchCount)
    ) {
      this.sequentialSearchCount = Math.max(0, snap.sequentialSearchCount);
    }
    if (snap.fileHashHistory && typeof snap.fileHashHistory === 'object') {
      this.fileHashHistory = new Map();
      for (const [k, v] of Object.entries(snap.fileHashHistory)) {
        if (Array.isArray(v)) {
          this.fileHashHistory.set(k, v.slice(-6).map(String));
        }
      }
    }
    const editedList = Array.isArray(snap.modifiedFilesInTurn)
      ? snap.modifiedFilesInTurn
      : Array.isArray(snap.editedFiles)
        ? snap.editedFiles
        : null;
    if (editedList) {
      this.modifiedFilesInTurn = new Set(editedList.filter(Boolean).map(String));
    }
    if (Array.isArray(snap.pendingBatchEdits)) {
      this.pendingBatchEdits = new Set(snap.pendingBatchEdits.filter(Boolean).map(String));
    }
    if (Array.isArray(snap.pendingFormatFiles)) {
      this.pendingFormatFiles = new Set(snap.pendingFormatFiles.filter(Boolean).map(String));
    }
    if (typeof snap.codeEditedSinceLastTest === 'boolean') {
      this.codeEditedSinceLastTest = snap.codeEditedSinceLastTest;
    }
    if (typeof snap.lastTurnGitCommitted === 'boolean') {
      this.lastTurnGitCommitted = snap.lastTurnGitCommitted;
    }
    if (Array.isArray(snap.committedTopDirs)) {
      this.committedTopDirs = [...snap.committedTopDirs];
    }
    if (typeof snap.consecutiveTrivialMaxEffortTurns === 'number') {
      this.consecutiveTrivialMaxEffortTurns = snap.consecutiveTrivialMaxEffortTurns;
    }
    if (snap.recentEditTimestampsByFile && typeof snap.recentEditTimestampsByFile === 'object') {
      this.recentEditTimestampsByFile = { ...snap.recentEditTimestampsByFile };
    }
    if (typeof snap.totalDiscoveryCalls === 'number') {
      this.totalDiscoveryCalls = snap.totalDiscoveryCalls;
    }
    if (typeof snap.consecutiveVisionTurns === 'number') {
      this.consecutiveVisionTurns = snap.consecutiveVisionTurns;
    }
    if (typeof snap.unanchoredTurnFlag === 'boolean') {
      this.unanchoredTurnFlag = snap.unanchoredTurnFlag;
    }
    if (Array.isArray(snap.candidateFiles)) {
      this.candidateFiles = [...snap.candidateFiles];
    }
    if (snap.relayState && typeof snap.relayState === 'object') {
      this.relayState = { ...snap.relayState };
    }
    if (typeof snap.steeredPrompts === 'number') {
      this.steeredPrompts = snap.steeredPrompts;
    }
    if (typeof snap.blockedPrompts === 'number') {
      this.blockedPrompts = snap.blockedPrompts;
    }
    if (typeof snap.sightseeingToolsPrevented === 'number') {
      this.sightseeingToolsPrevented = snap.sightseeingToolsPrevented;
    }
    if (snap.subagentTurns && typeof snap.subagentTurns === 'object') {
      this.subagentTurns = { ...snap.subagentTurns };
    }
    if (snap.subagentTokens && typeof snap.subagentTokens === 'object') {
      this.subagentTokens = { ...snap.subagentTokens };
    }
    if (snap.det11AdvisedTurn !== undefined) {
      this.det11AdvisedTurn = snap.det11AdvisedTurn;
    }
    if (snap.det13AdvisedTurn !== undefined) {
      this.det13AdvisedTurn = snap.det13AdvisedTurn;
    }
    if (Array.isArray(snap.queuedMutations)) {
      this.router.mutationQueue.items = [...snap.queuedMutations];
    }
    if (snap.hysteresisState && typeof snap.hysteresisState === 'object') {
      this.router.hysteresisLock.locked = Boolean(snap.hysteresisState.locked);
      this.router.hysteresisLock.pinnedModel = snap.hysteresisState.pinnedModel || null;
      this.router.hysteresisLock.pinnedEffort = snap.hysteresisState.pinnedEffort || null;
      this.router.hysteresisLock.reason = snap.hysteresisState.reason || null;
      this.router.hysteresisLock.lockedAtTurn = snap.hysteresisState.lockedAtTurn ?? null;
    }
    return this;
  }

  /**
   * Evaluates `PreToolUse` across all relevant pre-execution detectors
   * (`DET-01`, `DET-02`, `DET-03`, `DET-04`, `DET-05`, `DET-06`, `DET-07`, `DET-11`, `DET-12`, `DET-13`, `DET-16`, `DET-18`, `DET-19`, `DET-20`),
   * applying any per-detector overrides (`off` | `warn` | `block`) from `.attention-horizon.json`.
   *
   * @param {object} [toolEvent={}]
   * @param {object} [telemetryState={}]
   */
  evaluatePreToolUse(toolEvent = {}, telemetryState = {}) {
    const toolName = String(toolEvent.tool_name || toolEvent.toolName || '');
    const toolInput = toolEvent.tool_input || toolEvent.toolInput || {};
    const command = String(toolInput.command || toolInput.cmd || toolEvent.command || '');
    const filePath = String(
      toolInput.file_path ||
        toolInput.notebook_path ||
        toolInput.filePath ||
        toolInput.path ||
        toolEvent.filePath ||
        ''
    );
    const firstEdit = Array.isArray(toolInput.edits) && toolInput.edits[0] ? toolInput.edits[0] : null;
    let oldText = String(
      toolInput.old_string ?? toolInput.oldText ?? firstEdit?.old_string ?? ''
    );
    if (!oldText && String(toolName).toLowerCase() === 'write' && filePath) {
      oldText = readTextSafe(filePath, null, this.options) || '';
    }
    const newText = String(
      toolInput.new_string ??
        toolInput.new_source ??
        toolInput.content ??
        toolInput.newText ??
        firstEdit?.new_string ??
        ''
    );
    const urlStr = String(toolInput.url || toolEvent.url || '');
    const activeMode = normalizeFlightMode(
      toolEvent.mode || telemetryState.flightMode || this.mode || FLIGHT_MODES.COACH
    );
    const silentCoachMode = isSilentOrOffMode(activeMode);
    const resolveVerdict = (verdict) => applyDetectorOverride(verdict, this.horizonConfig);
    const applyHabitSlug = (slug, verdict) => {
      const slugMode = resolveDetectorOverride(slug, this.horizonConfig);
      if (slugMode === 'off') {
        return { ...verdict, triggered: false, decision: 'allow', suppressedByConfig: true };
      }
      if (slugMode === 'warn') {
        return { ...verdict, triggered: true, decision: 'allow', advisory: true, overrideMode: 'warn' };
      }
      if (slugMode === 'block') {
        return { ...verdict, triggered: true, decision: 'deny', advisory: false, overrideMode: 'block' };
      }
      return resolveVerdict(verdict);
    };
    const isCoachAdvisorySuppressed = (detId) => {
      if (!silentCoachMode) return false;
      const explicitOverride = resolveDetectorOverride(detId, this.horizonConfig);
      return explicitOverride !== 'warn' && explicitOverride !== 'block';
    };

    // 1. DET-20: Quota Hard Brake & Concurrent Scope Lock
    const isSearchRead = SEARCH_READ_TOOL_REGEX.test(toolName);
    const det20 = resolveVerdict(
      evaluateDet20ScopeLockAndQuotaBrake(
        {
          targetFilePath: (EDIT_WRITE_TOOL_REGEX.test(toolName) || isSearchRead) ? filePath : '',
          isRead: isSearchRead,
          toolName,
          ownerId:
            toolEvent.ownerId ||
            toolEvent.agentId ||
            toolEvent.subagentId ||
            telemetryState.sessionId ||
            'default',
          rateLimits: telemetryState.rateLimits || {}
        },
        this.options
      )
    );
    if (det20.triggered) return det20;

    // 1.0b Two-Stage Prompt Hygiene Sightseeing Interception (Scope Brake & Relay Breaker Web Search)
    const scopeOverride = resolveDetectorOverride('vague-prompt-rubric', this.horizonConfig);
    const relayOverride = resolveDetectorOverride('relay-breaker', this.horizonConfig);
    const twoStage = evaluateTwoStageSightseeingIntercept({
      toolName,
      toolArgs: toolInput,
      unanchoredTurnFlag: Boolean(toolEvent.unanchoredTurnFlag ?? this.unanchoredTurnFlag),
      candidateFiles: Array.isArray(toolEvent.candidateFiles)
        ? toolEvent.candidateFiles
        : (this.candidateFiles.length > 0 ? this.candidateFiles : Array.from(this.modifiedFilesInTurn)),
      relayState: toolEvent.relayState ?? this.relayState,
      overrideMode: scopeOverride !== 'default' ? scopeOverride : relayOverride,
      flightMode: activeMode,
      detectorId: 'DET-14'
    });
    if (twoStage.intercepted) {
      if (twoStage.consumeFlag) {
        this.unanchoredTurnFlag = false;
      }
      this.sightseeingToolsPrevented = Number(this.sightseeingToolsPrevented || 0) + 1;
      return {
        detectorId: 'DET-14',
        triggered: true,
        subType: twoStage.subType,
        decision: twoStage.decision,
        advisory: twoStage.decision === 'allow',
        reason: twoStage.reason
      };
    }

    // 1a. RSI-04 ('micro-skills'): Intercept known-broken repo shell commands
    if (SHELL_TOOL_REGEX.test(toolName) && command) {
      const msOverride = resolveDetectorOverride('micro-skills', this.horizonConfig);
      if (msOverride !== 'off') {
        const msReg = loadMicroSkillsRegistry(this.options);
        const msIntercept = evaluateMicroSkillIntercept(msReg, {
          command,
          flightMode: activeMode,
          overrideMode: msOverride
        });
        if (msIntercept.triggered) {
          return {
            detectorId: 'RSI-04',
            triggered: true,
            subType: msIntercept.subType,
            decision: msIntercept.decision,
            advisory: msIntercept.decision === 'allow',
            failedCmd: msIntercept.failedCmd,
            workingCmd: msIntercept.workingCmd,
            reason: msIntercept.reason
          };
        }
      }
    }

    // 1b. DET-15 ('formatter-bypass'): Local Formatter Bypass on pasted code block
    const det15Bypass = evaluateDet15PreFormatBypass({
      prompt: toolEvent.prompt || toolEvent.user_input || toolInput.prompt || '',
      newText,
      lineCount: toolEvent.fullFileNewLines || (newText ? newText.split(/\r?\n/).length : 0)
    });
    if (det15Bypass.triggered) {
      const resolved = applyHabitSlug('formatter-bypass', det15Bypass);
      if (resolved.triggered) return resolved;
    }

    // 1c. DET-05 ('drip-feed'): Conversational Drip-Feeding Detector (<90s window)
    if (EDIT_WRITE_TOOL_REGEX.test(toolName) && filePath) {
      const now = Number(toolEvent.timestampMs ?? toolEvent.nowMs ?? Date.now());
      this.recentEditTimestampsByFile = this.recentEditTimestampsByFile || {};
      const tsList = (this.recentEditTimestampsByFile[filePath] || []).filter((t) => (now - t) <= 90000);
      tsList.push(now);
      this.recentEditTimestampsByFile[filePath] = tsList;
      if (tsList.length >= 4) {
        const det05Drip = applyHabitSlug('drip-feed', {
          detectorId: 'DET-05',
          triggered: true,
          subType: 'CONVERSATIONAL_DRIP_FEED',
          decision: activeMode === FLIGHT_MODES.AUTO_PILOT ? 'ask' : 'allow',
          advisory: true,
          reason: `[DET-05 Conversational Drip-Feed] Detected ${tsList.length} rapid edits on "${filePath}" in <90s. Batch multiple micro-requirements into a single turn to preserve KV cache.`
        });
        if (det05Drip.triggered) return det05Drip;
      }
    }

    // 1d. DET-14 ('vague-prompt-rubric'): Turn-1 Blind Multi-File Edit Gate (TDD *.test.*/*.spec.* exempted)
    const currentTurnNum = Number(
      toolEvent.turnId ??
      toolEvent.turn_id ??
      telemetryState.turnCount ??
      telemetryState.currentTurn ??
      0
    );
    if (SEARCH_READ_TOOL_REGEX.test(toolName)) {
      this.totalDiscoveryCalls = Number(this.totalDiscoveryCalls || 0) + 1;
    }
    if (EDIT_WRITE_TOOL_REGEX.test(toolName)) {
      const rawPromptStr = String(toolEvent.prompt || toolEvent.user_input || toolInput.prompt || '');
      const hasSpecificAnchor = /(?:^|\s)@[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/.test(rawPromptStr);
      const candidateModified = new Set(this.modifiedFilesInTurn);
      if (filePath) candidateModified.add(filePath);
      const nonTestModifiedCount = Array.from(candidateModified).filter((fp) => {
        const np = String(fp || '').replace(/\\/g, '/');
        return !/(?:^|\/)(?:tests?|__tests__|specs?|migrations|docs)\//i.test(np) &&
          !/\.(?:test|spec)\.[a-z0-9]+$|\.md$/i.test(np);
      }).length;

      if (currentTurnNum <= 1 && Number(this.totalDiscoveryCalls || 0) === 0 && nonTestModifiedCount >= 2 && !hasSpecificAnchor) {
        if (filePath) this.modifiedFilesInTurn.add(filePath);
        const det14Blind = applyHabitSlug('vague-prompt-rubric', {
          detectorId: 'DET-14',
          triggered: true,
          subType: 'BLIND_UNPLANNED_MULTI_EDIT',
          decision: activeMode === FLIGHT_MODES.AUTO_PILOT ? 'deny' : 'allow',
          advisory: activeMode !== FLIGHT_MODES.AUTO_PILOT,
          reason: `[DET-14 Blind Multi-File Edit] Turn 1 multi-file edit (${nonTestModifiedCount} non-test files) with 0 prior read/grep discovery calls. Verify existing architecture or create a plan first.`
        });
        if (det14Blind.triggered) return det14Blind;
      }
    }

    // 1e. DET-08 ('effort-overkill'): Pinned Opus Max Effort Trivial Streak
    const activeModelId =
      (typeof toolEvent.model === 'string' ? toolEvent.model : toolEvent.model?.id) ||
      toolEvent.modelId ||
      telemetryState.modelId;
    const activeEffort = String(toolEvent.effort || telemetryState.effort || '').toLowerCase();
    const isOpusModel = /(?:claude-)?opus/i.test(String(activeModelId || ''));
    if (EDIT_WRITE_TOOL_REGEX.test(toolName) && isOpusModel && activeEffort === 'max') {
      const { oldLineCount, newLineCount } = computeAddedAndDeletedDiffLines(oldText, newText);
      const diffLinesChanged = Math.abs(newLineCount - oldLineCount);
      if (diffLinesChanged <= 3) {
        this.consecutiveTrivialMaxEffortTurns = Number(this.consecutiveTrivialMaxEffortTurns || 0) + 1;
      } else {
        this.consecutiveTrivialMaxEffortTurns = 0;
      }
      if (this.consecutiveTrivialMaxEffortTurns >= 3 || Number(toolEvent.consecutiveTrivialMaxEffortTurns) >= 3) {
        const det08Streak = applyHabitSlug('effort-overkill', {
          detectorId: 'DET-08',
          triggered: true,
          subType: 'PINNED_MAX_EFFORT_TRIVIAL_STREAK',
          decision: 'allow',
          advisory: true,
          reason: `[DET-08 Pinned Max Effort Streak] Opus 4.6 pinned at effort: max across ${this.consecutiveTrivialMaxEffortTurns} trivial edits (<=3 lines). Run /effort low or switch to Sonnet/Haiku to reduce output token latency by 68%.`
        });
        if (det08Streak.triggered) return det08Streak;
      }
    }

    // 1f. DET-20 ('vision-screenshot-coach'): Vision / Screenshot & Base64 Accumulation Guard
    let base64ImageBlocks = 0;
    let msgCompoundingVisionTokens = 0;
    if (Array.isArray(toolEvent.messages)) {
      const msgLen = toolEvent.messages.length;
      for (let i = 0; i < msgLen; i++) {
        const msg = toolEvent.messages[i];
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        let msgImgs = 0;
        for (const b of blocks) {
          if (b && (b.type === 'image' || b?.source?.type === 'base64')) {
            base64ImageBlocks += 1;
            msgImgs += 1;
          }
        }
        if (msgImgs > 0) {
          const turnsResent = Math.max(1, Math.ceil((msgLen - i) / 2));
          msgCompoundingVisionTokens += msgImgs * 1600 * turnsResent;
        }
      }
    }
    const hasImageAttachment = Boolean(
      toolEvent.has_image_attachment ||
      toolEvent.hasImageAttachment ||
      base64ImageBlocks > 0 ||
      (Array.isArray(toolEvent.media) && toolEvent.media.some((m) => String(m?.mime_type || '').startsWith('image/'))) ||
      /\.(?:png|jpg|jpeg|webp|gif)$/i.test(filePath)
    );
    if (hasImageAttachment) {
      this.consecutiveVisionTurns = Number(this.consecutiveVisionTurns || 0) + 1;
    } else {
      this.consecutiveVisionTurns = 0;
    }
    const effectiveConsecutiveVision = Math.max(
      this.consecutiveVisionTurns,
      Number(toolEvent.consecutive_vision_turns ?? toolEvent.consecutiveVisionTurns ?? 0)
    );
    const imageCount = Math.max(
      base64ImageBlocks,
      Number(toolEvent.image_count ?? toolEvent.imageCount ?? (hasImageAttachment ? 1 : 0))
    );
    if ((effectiveConsecutiveVision >= 2 || imageCount >= 2) && hasImageAttachment) {
      const cumulativeVisionTaxTokens = Math.max(
        msgCompoundingVisionTokens,
        imageCount * 1600 * Math.max(1, effectiveConsecutiveVision)
      );
      const det20Vision = applyHabitSlug('vision-screenshot-coach', {
        detectorId: 'DET-20',
        triggered: true,
        subType: 'VISION_SCREENSHOT_ABUSE',
        decision: 'allow',
        advisory: true,
        base64ImageBlocks,
        cumulativeVisionTaxTokens,
        reason: `[DET-20 Vision Token Drain] ${imageCount} screenshot/image blocks accumulated (~${cumulativeVisionTaxTokens.toLocaleString()} cumulative vision tokens) for text-debuggable issues. Paste error logs or DOM/CSS snippets directly.`
      });
      if (det20Vision.triggered) return det20Vision;
    }

    // 2. DET-16: Subagent Recursion Cap (40k tokens / 12 turns)
    const agentId = toolEvent.agentId || toolEvent.subagentId || null;
    if (agentId) {
      const subFromTelemetry = telemetryState.subagents?.[agentId];
      const turns =
        subFromTelemetry?.turns !== undefined
          ? Number(subFromTelemetry.turns)
          : Number(this.subagentTurns[agentId] || 0);
      const totalTokens =
        subFromTelemetry?.totalTokens !== undefined
          ? Number(subFromTelemetry.totalTokens)
          : Number(this.subagentTokens[agentId] || 0);
      if (subFromTelemetry || turns > 0 || totalTokens > 0) {
        const det16 = resolveVerdict(
          evaluateDet16SubagentRecursionCap({
            agentId,
            turns,
            totalTokens
          })
        );
        if (det16.triggered) return det16;
      }
      this.subagentTurns[agentId] = turns + 1;
      this.subagentTokens[agentId] = totalTokens + Math.max(0, Number(toolEvent.tokensUsed || 0));
    }

    // 3. DET-04: Consecutive Tool Failure Breaker (>= 3)
    const det04 = resolveVerdict(
      evaluateDet04ConsecutiveFailures({
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.horizonConfig?.thresholds?.consecutiveFailureLimit
      })
    );
    if (det04.triggered) return det04;

    // 4. DET-01: Destructive Shell & Git Hook-Bypass Blocker (Ring-0 Security)
    const det01 = resolveVerdict(evaluateDet01GitAndShellSafety({ toolName, command }));
    if (det01.triggered) return det01;

    // 5. DET-02: Secret & Credential Boundary (Ring-0 Security)
    const det02 = resolveVerdict(evaluateDet02SecretBoundary({ toolName, filePath, command }));
    if (det02.triggered) return det02;

    // 6. DET-18: Untrusted Project settings.json CVE & Clobber Guard (Ring-0 Security)
    const det18 = resolveVerdict(
      evaluateDet18UntrustedSettingsGuard({
        toolName,
        filePath,
        newText,
        hasBackup: Boolean(toolEvent.hasBackup)
      })
    );
    if (det18.triggered) return det18;

    // 7. DET-03: Protected Migration, Lockfile & Workflow Ask Gate
    const det03 = resolveVerdict(evaluateDet03ProtectedFilesAskGate({ toolName, filePath }));
    if (det03.triggered) return det03;

    // 8. DET-19: Untrusted URL Exfiltration Guard on WebFetch (Ring-0 Security)
    if (/^WebFetch$/i.test(toolName) && urlStr) {
      const det19Url = resolveVerdict(
        evaluateDet19SubagentIpiSanitizer({ url: urlStr, wrapUntrusted: false })
      );
      if (det19Url.triggered && (det19Url.decision === 'deny' || det19Url.advisory)) {
        return det19Url;
      }
    }

    // 9. DET-05: AST/Diff Edit Thrashing & Code Stripping Breaker
    if (EDIT_WRITE_TOOL_REGEX.test(toolName)) {
      if (oldText || newText) {
        const history = this.fileHashHistory.get(filePath) || [];
        const rawDet05 = evaluateDet05DiffThrashing({
          filePath,
          oldText,
          newText,
          fullFileOldLines: toolEvent.fullFileOldLines,
          fullFileNewLines: toolEvent.fullFileNewLines,
          hashHistory: history
        });
        const det05 = resolveVerdict(rawDet05);
        if (det05.triggered) {
          this.router.hysteresisLock.engage({
            model: telemetryState.modelId || 'claude-opus-5-5',
            effort: 'high',
            reason: det05.subType
          });
          return det05;
        }
        history.push(rawDet05.nextHash);
        this.fileHashHistory.set(filePath, history.slice(-6));
      }
      if (filePath) {
        this.modifiedFilesInTurn.add(filePath);
        this.pendingFormatFiles.add(filePath);
        if (/^MultiEdit$/i.test(toolName)) {
          this.pendingBatchEdits.add(filePath);
        }
      }
      this.codeEditedSinceLastTest = true;
      this.sequentialSearchCount = 0;

      // 9b. DET-09: Warm-Prefix Instruction / MCP Config Mutation Fence (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/rules/*.md`)
      if (filePath && isPrefixInstructionFile(filePath) && !isCoachAdvisorySuppressed('DET-09')) {
        const ttlRem =
          toolEvent.ttlRemainingSeconds ??
          telemetryState.promptCache?.ttlSeconds ??
          telemetryState.ttlRemainingSeconds;
        const ttlExpired = ttlRem !== undefined && ttlRem !== null && Number(ttlRem) <= 0;
        const cachedTokens = Number(
          toolEvent.cachedTokens ??
            telemetryState.contextWindow?.cachedTokens ??
            telemetryState.contextWindow?.cacheReadTokens ??
            0
        );
        const cacheWarm =
          !ttlExpired &&
          Boolean(toolEvent.cacheWarm ?? telemetryState.promptCache?.warm) &&
          cachedTokens > 0;

        if (cacheWarm) {
          const det09Raw = this.router.interceptTopLevelMutation({
            type: 'system_prompt',
            key: filePath,
            value: newText.slice(0, 120),
            filePath,
            currentModel:
              (typeof toolEvent.model === 'string' ? toolEvent.model : toolEvent.model?.id) ||
              toolEvent.modelId ||
              telemetryState.modelId ||
              'claude-opus-5-5',
            cachedTokens,
            cacheWarm: true,
            ttlRemainingSeconds: ttlRem,
            cacheTtlTier: telemetryState.promptCache?.ttlTier || '5m'
          });
          if (det09Raw.triggered) {
            const det09 = resolveVerdict(
              activeMode === FLIGHT_MODES.AUTO_PILOT
                ? det09Raw
                : { ...det09Raw, decision: 'allow', advisory: true }
            );
            if (det09.triggered) return det09;
          }
        }
      }
    }

    // 10. DET-07: Unbounded Command Output Bomb Guard
    const det07 = resolveVerdict(
      evaluateDet07OutputBombGuard({
        toolName,
        command,
        filePath,
        limit: toolInput.limit ?? toolEvent.limit
      })
    );
    if (det07.triggered) return det07;

    // Track git commit and test runs in shell commands
    if (SHELL_TOOL_REGEX.test(toolName)) {
      if (/\bgit\s+commit\b/i.test(command)) {
        this.lastTurnGitCommitted = true;
        this.committedTopDirs = Array.from(this.modifiedFilesInTurn)
          .map((f) => f.split(/[\\/]/)[0])
          .filter(Boolean);
      }
      if (
        /\b(?:node\s+--test|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/i.test(
          command
        )
      ) {
        this.codeEditedSinceLastTest = false;
      }
      this.sequentialSearchCount = 0;
    }

    // 11. DET-06: Main-Thread Blind Search Guard (> 6 sequential Read/Grep calls) + Repo Calibration
    if (SEARCH_READ_TOOL_REGEX.test(toolName) && !agentId) {
      this.sequentialSearchCount += 1;
      let chronicAdvisory = null;
      if (
        /^(?:Read|read_file)$/i.test(toolName) &&
        filePath &&
        (this.options.enableRepoCalibration || this.options.calibrationPath)
      ) {
        let estimatedReadTokens = 0;
        if (toolEvent.estimatedTokens !== undefined && toolEvent.estimatedTokens !== null) {
          estimatedReadTokens = Math.max(0, Number(toolEvent.estimatedTokens));
        } else if (Number(toolEvent.fileByteSize) > 0) {
          estimatedReadTokens = Math.ceil(Number(toolEvent.fileByteSize) / 4);
        } else {
          const resolvedReadPath = resolvePath(getCwd(this.options), filePath);
          const byteSize = getFileByteSizeSafe(resolvedReadPath, this.options);
          estimatedReadTokens = byteSize > 0 ? Math.ceil(byteSize / 4) : 0;
        }
        const cal = recordRepoFileRead(
          {
            filePath,
            estimatedTokens: estimatedReadTokens,
            sessionId: telemetryState.sessionId || 'default'
          },
          this.options
        );
        if (cal.isChronicSink) {
          chronicAdvisory = cal.recommendation;
        }
      }

      if (!isCoachAdvisorySuppressed('DET-06')) {
        const blindLimit = this.horizonConfig?.thresholds?.blindSearchLimit;
        const det06 = resolveVerdict(
          evaluateDet06BlindSearchGuard({
            sequentialSearchCount: this.sequentialSearchCount,
            threshold: blindLimit,
            limit: blindLimit
          })
        );
        if (det06.triggered) {
          return chronicAdvisory
            ? { ...det06, reason: `${det06.reason} | ${chronicAdvisory}` }
            : det06;
        }
        if (chronicAdvisory && resolveDetectorOverride('DET-06', this.horizonConfig) !== 'off') {
          return resolveVerdict({
            detectorId: 'DET-06',
            triggered: true,
            decision: 'allow',
            advisory: true,
            subType: 'CHRONIC_REPO_FILE_SINK',
            reason: chronicAdvisory
          });
        }
      }
    }

    // 12. DET-12: Haiku 5.5 90,000-Token Pre-Cliff Breaker
    const eventUsage = toolEvent.usage || toolEvent.context_window?.current_usage || null;
    const totalDet12Tokens = Math.max(
      computeTotalPromptTokens(telemetryState.contextWindow || {}),
      computeTotalPromptTokens(toolEvent),
      eventUsage ? computeTotalPromptTokens(eventUsage) : 0
    );
    const rawDet12 = evaluateDet12HaikuPreCliffBreaker({
      modelId: activeModelId,
      totalPromptTokens: totalDet12Tokens
    });
    if (rawDet12.triggered) {
      // Hard >=98k cliff protection stays active even in SILENT/OFF unless explicitly overridden to 'off'
      if (!rawDet12.advisory || !isCoachAdvisorySuppressed('DET-12')) {
        const det12 = resolveVerdict(rawDet12);
        if (det12.triggered) return det12;
      }
    }

    const turnKey = String(
      toolEvent.turnId ??
        toolEvent.turn_id ??
        telemetryState.turnCount ??
        telemetryState.currentTurn ??
        0
    );

    // 13. DET-13: MCP Schema Bloat & tools_changed Cache-Miss Guard (once per turn)
    if (!isCoachAdvisorySuppressed('DET-13') && this.det13AdvisedTurn !== turnKey) {
      const mcpSchemaTokens = Number(
        toolEvent.mcpSchemaTokens ??
          telemetryState.mcpSchemaTokens ??
          telemetryState.mcp?.schemaTokens ??
          0
      );
      const mcpToolCount = Number(
        toolEvent.mcpToolCount ??
          telemetryState.mcpToolCount ??
          telemetryState.mcp?.toolCount ??
          0
      );
      const lastMissCause =
        toolEvent.lastMissCause ||
        telemetryState.lastMissCause ||
        telemetryState.promptCache?.lastMissCause ||
        (toolEvent.toolsChanged || telemetryState.toolsChanged ? 'tools_changed' : null);

      if (mcpSchemaTokens > 0 || mcpToolCount > 0 || lastMissCause) {
        const det13 = resolveVerdict(
          evaluateDet13McpSchemaBloatGuard({
            mcpSchemaTokens,
            mcpToolCount,
            lastMissCause,
            bundledSkillsTokens: Number(toolEvent.bundledSkillsTokens ?? telemetryState.bundledSkillsTokens ?? 0),
            syncedSkillsTokens: Number(toolEvent.syncedSkillsTokens ?? telemetryState.syncedSkillsTokens ?? 0),
            claudeMdTokens: Number(toolEvent.claudeMdTokens ?? telemetryState.claudeMdTokens ?? 0),
            turnsElapsed: Number(toolEvent.turnsElapsed ?? toolEvent.turnId ?? toolEvent.turn_id ?? telemetryState.turnCount ?? 0),
            mcpInvocations: Number(toolEvent.mcpInvocations ?? telemetryState.mcpInvocations ?? 0)
          })
        );
        if (det13.triggered) {
          this.det13AdvisedTurn = turnKey;
          return det13;
        }
      }
    }

    // 14. DET-11: Context Rot Soft Horizon Gate (once per turn)
    if (!isCoachAdvisorySuppressed('DET-11') && this.det11AdvisedTurn !== turnKey) {
      const totalInputTokens = Math.max(
        totalDet12Tokens,
        Number(
          toolEvent.totalInputTokens ??
            telemetryState.totalInputTokens ??
            telemetryState.contextWindow?.totalInputTokens ??
            0
        )
      );
      const distractorTokens =
        toolEvent.distractorTokens ??
        telemetryState.distractorTokens ??
        telemetryState.contextWindow?.distractorTokens;
      const distractorRatio =
        toolEvent.distractorRatio ??
        telemetryState.distractorRatio ??
        telemetryState.contextWindow?.distractorRatio;

      const postCommitOverride = resolveDetectorOverride('post-commit-handoff', this.horizonConfig);
      const postCommitTopicShift =
        postCommitOverride !== 'off' &&
        Boolean(
          toolEvent.postCommitTopicShift ??
          toolEvent.topic_shift ??
          toolEvent.topicShift ??
          (this.lastTurnGitCommitted && (toolEvent.topic_shift || toolEvent.topicShift))
        );

      if (
        (totalInputTokens > 0 &&
        (distractorTokens !== undefined || distractorRatio !== undefined)) ||
        postCommitTopicShift
      ) {
        const rawDet11 = evaluateDet11ContextRotGate({
          totalInputTokens,
          distractorTokens,
          distractorRatio,
          turnId: currentTurnNum,
          lastTurnGitCommitted: this.lastTurnGitCommitted || Boolean(toolEvent.last_turn_git_committed),
          topicShiftDetected: Boolean(toolEvent.topic_shift || toolEvent.topicShift),
          postCommitTopicShift
        });
        const det11 =
          rawDet11.subType === 'POST_COMMIT_TOPIC_SHIFT'
            ? applyHabitSlug('post-commit-handoff', rawDet11)
            : resolveVerdict(rawDet11);
        if (det11.triggered) {
          this.det11AdvisedTurn = turnKey;
          return det11;
        }
      }
    }

    return {
      detectorId: null,
      triggered: false,
      decision: 'allow',
      reason: null
    };
  }

  /**
   * Records tool outcome to update `DET-04` consecutive failure counter.
   * @param {boolean} succeeded
   * @param {string | null} [toolKey=null]
   */
  recordToolOutcome(succeeded = true, toolKey = null) {
    if (succeeded) {
      this.consecutiveFailures = 0;
      this.lastFailedToolKey = null;
    } else {
      this.consecutiveFailures += 1;
      if (toolKey) {
        this.lastFailedToolKey = String(toolKey);
      }
    }
    return this.consecutiveFailures;
  }

  /**
   * Evaluates `UserPromptSubmit` for Prompt Hygiene Governor (v4.1 Phase 1):
   * Relay Breaker (`'relay-breaker'`) & Scope Brake (`'vague-prompt-rubric'`).
   *
   * @param {object} [promptEvent={}]
   * @param {object} [telemetryState={}]
   */
  evaluateUserPromptSubmit(promptEvent = {}, telemetryState = {}) {
    const prompt = String(
      promptEvent.prompt ?? promptEvent.user_input ?? promptEvent.message ?? ''
    );
    const activeMode = normalizeFlightMode(
      promptEvent.mode || telemetryState.flightMode || this.mode || FLIGHT_MODES.COACH
    );
    if (activeMode === FLIGHT_MODES.OFF) {
      return { triggered: false, decision: 'allow', reason: null };
    }

    const modifiedNonMd = Array.from(this.modifiedFilesInTurn).filter(
      (f) => !/\.md$/i.test(String(f || ''))
    );
    const relayOverride = resolveDetectorOverride('relay-breaker', this.horizonConfig);
    const relayEval = evaluateRelayBreaker({
      prompt,
      relayState: promptEvent.relayState ?? this.relayState,
      sourceCodeEditsInSession: Number(
        promptEvent.sourceCodeEditsInSession ?? modifiedNonMd.length
      ),
      sourceCodeEditedSinceLastRelay: Boolean(promptEvent.sourceCodeEditedSinceLastRelay),
      priorTurnWebSearches: Number(promptEvent.priorTurnWebSearches ?? 0),
      zeroEditSessionTokens: Number(
        promptEvent.zeroEditSessionTokens ??
        (modifiedNonMd.length === 0 ? (telemetryState.contextWindow?.totalInputTokens || 0) : 0)
      ),
      boundSpecPath: promptEvent.boundSpecPath ?? this.relayState?.boundSpecPath ?? 'SPEC.md',
      overrideMode: relayOverride,
      flightMode: activeMode,
      detectorId: 'DET-14'
    });
    this.relayState = relayEval.relayStateSnapshot;
    if (relayEval.triggered) {
      if (relayEval.decision === 'block') {
        this.blockedPrompts = Number(this.blockedPrompts || 0) + 1;
      } else {
        this.steeredPrompts = Number(this.steeredPrompts || 0) + 1;
      }
      return {
        detectorId: 'DET-14',
        slug: 'relay-breaker',
        triggered: true,
        subType: relayEval.subType,
        decision: relayEval.decision,
        relayState: relayEval.nextState,
        hudBadge: relayEval.hudBadge,
        reason: relayEval.tailInjection
      };
    }

    const scopeOverride = resolveDetectorOverride('vague-prompt-rubric', this.horizonConfig);
    const scopeEval = evaluateScopeBrake({
      prompt,
      provenance: promptEvent.provenance || promptEvent.source || 'user',
      isAutonomousTurn: Boolean(promptEvent.isAutonomousTurn || promptEvent.autonomous),
      isSubagent: Boolean(promptEvent.isSubagent || promptEvent.agentId || promptEvent.subagentId),
      isScheduledTask: Boolean(promptEvent.isScheduledTask),
      isLoopIteration: Boolean(promptEvent.isLoopIteration),
      priorTurnEditedFilesCount: Number(
        promptEvent.priorTurnEditedFilesCount ?? this.modifiedFilesInTurn.size
      ),
      priorTurnSingleFileTarget:
        promptEvent.priorTurnSingleFileTarget ??
        (this.modifiedFilesInTurn.size === 1 ? Array.from(this.modifiedFilesInTurn)[0] : null),
      priorTurnHadToolOrTestFailure: Boolean(
        promptEvent.priorTurnHadToolOrTestFailure ?? (this.consecutiveFailures > 0)
      ),
      priorTurnAssistantAskedQuestion: Boolean(promptEvent.priorTurnAssistantAskedQuestion),
      activeSetPaths: promptEvent.activeSetPaths || [],
      modifiedFiles: Array.from(this.modifiedFilesInTurn),
      recentlyViewedFiles: promptEvent.recentlyViewedFiles || [],
      overrideMode: scopeOverride,
      flightMode: activeMode,
      detectorId: 'DET-14'
    });
    if (scopeEval.triggered) {
      this.unanchoredTurnFlag = true;
      this.candidateFiles = scopeEval.candidateFiles;
      if (scopeEval.decision === 'block') {
        this.blockedPrompts = Number(this.blockedPrompts || 0) + 1;
      } else {
        this.steeredPrompts = Number(this.steeredPrompts || 0) + 1;
      }
      return {
        detectorId: 'DET-14',
        slug: 'vague-prompt-rubric',
        triggered: true,
        subType: scopeEval.subType,
        decision: scopeEval.decision,
        candidateFiles: scopeEval.candidateFiles,
        reason: scopeEval.decision === 'block' ? scopeEval.blockReason : scopeEval.steerContext
      };
    }

    this.unanchoredTurnFlag = false;
    return {
      detectorId: null,
      triggered: false,
      decision: 'allow',
      reason: null
    };
  }
}

export default {
  tokenizeShellSegment,
  sanitizeBreakerSessionId,
  getBreakerStateFilePath,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot,
  evaluateDet01GitAndShellSafety,
  evaluateDet02SecretBoundary,
  evaluateDet03ProtectedFilesAskGate,
  evaluateDet04ConsecutiveFailures,
  computeAddedAndDeletedDiffLines,
  hashFileContent,
  evaluateDet05DiffThrashing,
  evaluateDet06BlindSearchGuard,
  evaluateDet07OutputBombGuard,
  isPrefixInstructionFile,
  evaluateDet09PrefixMutationFence,
  evaluateDet11ContextRotGate,
  evaluateDet12HaikuPreCliffBreaker,
  evaluateDet13McpSchemaBloatGuard,
  evaluateDet14PrematureStopGate,
  evaluateDet15BatchedStopFormatter,
  evaluateDet16SubagentRecursionCap,
  evaluateDet17AutoCompactionDeferral,
  evaluateDet18UntrustedSettingsGuard,
  evaluateDet19SubagentIpiSanitizer,
  evaluateDet20ScopeLockAndQuotaBrake,
  CircuitBreakerEngine
};
