/**
 * @file src/core-isomorphic/guards/det01_03_shell_secret.mjs
 * Shell & Git Safety, Secret Boundary, and Protected File Ask-Gate (`DET-01`..`DET-03`).
 * Pure-V8 isomorphic ESM module (zero `node:*` imports).
 */

import { path } from '../utils/runtime.mjs';

export const SHELL_TOOL_REGEX = /^(Bash|PowerShell|pwsh|cmd|sh)$/i;
export const EDIT_WRITE_TOOL_REGEX = /^(Edit|Write|MultiEdit|NotebookEdit)$/i;
export const SEARCH_READ_TOOL_REGEX = /^(Read|Grep|Glob|read_file|grep_search)$/i;

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
