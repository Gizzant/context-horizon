import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../core/atomic_io.mjs';
import { recordHookDiagnostic } from '../core/hook_diagnostics.mjs';

/**
 * DET-19: Git Hook-Bypass Guard Shim (`src/shims/agy_git_guard.mjs`)
 *
 * Intercepts `git` invocations and strictly blocks evasion flags:
 *  - `git commit`, `push`, `merge`, `rebase`, `cherry-pick`, `am` with `--no-verify` or `-n` (where `-n` = `--no-verify`).
 *  - `git commit` with `--no-gpg-sign`.
 *  - Global / subcommand config overrides: `-c core.hooksPath=...`, `-ccore.hooksPath=...`, `git config ... core.hooksPath`.
 *  - Child environment overrides: `HUSKY=0`, `GIT_HOOKS=0`, `HUSKY_SKIP_HOOKS=1`, `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_i=core.hooksPath`.
 *
 * Anti-Gaming Human Override:
 *  - Stores human bypass nonces outside the agent-writable workspace in
 *    `~/.attention-horizon/security/git_bypass_nonce.json` signed with a `0o600` HMAC key.
 */

const currentFilePath = fileURLToPath(import.meta.url);
const currentShimDir = path.dirname(currentFilePath);

export const DET19_CONSTANTS = Object.freeze({
  DETECTOR_ID: 'DET-19',
  EXIT_CODE_BLOCKED: 126,
  EXIT_CODE_GIT_NOT_FOUND: 127,
  BLOCKED_MESSAGE:
    '[HORIZON DET-19 BLOCKED] Pre-commit / verification bypass flags (--no-verify, -n, hooksPath override) are prohibited. Read the hook failure output and fix the underlying lint, type, or test error.',
  BYPASS_NONCE_TTL_MS: 60000,
  PROTECTED_SUBCOMMANDS: Object.freeze(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'am']),
  SHORT_N_NO_VERIFY_SUBCOMMANDS: Object.freeze(['commit', 'push', 'merge', 'cherry-pick', 'am'])
});

function normalizePathForCompare(targetPath, fsModule = fs, platform = process.platform) {
  let resolved = path.resolve(String(targetPath || ''));
  try {
    if (typeof fsModule.realpathSync === 'function' && fsModule.existsSync(resolved)) {
      resolved = fsModule.realpathSync(resolved);
    }
  } catch (err) {
    // Keep path.resolve result if realpathSync fails
    recordHookDiagnostic('agy_git_guard', 'normalizePathForCompare.realpathSync', err, {
      ignoreCodes: ['ENOENT'],
      persist: false
    });
  }
  const slashNorm = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? slashNorm.toLowerCase() : slashNorm;
}

/**
 * Resolves the real system git binary while combining `PATH` + `Path` + `path` on Windows,
 * filtering out shim directories/self-paths, and returning `null` (fail-closed) when missing.
 */
export function resolveRealGitBinary({
  env = process.env,
  platform = process.platform,
  fsModule = fs,
  shimFilePath = currentFilePath
} = {}) {
  const pathSeparator = platform === 'win32' ? ';' : ':';
  const rawSegments = [];
  if (platform === 'win32') {
    for (const key of ['PATH', 'Path', 'path']) {
      if (typeof env[key] === 'string' && env[key].length > 0) {
        rawSegments.push(...env[key].split(pathSeparator));
      }
    }
    // Also inspect any remaining case-variant keys in custom env objects
    for (const [k, v] of Object.entries(env || {})) {
      if (k.toLowerCase() === 'path' && !['PATH', 'Path', 'path'].includes(k) && typeof v === 'string') {
        rawSegments.push(...v.split(pathSeparator));
      }
    }
  } else {
    const posixPath = env.PATH || env.Path || '';
    rawSegments.push(...posixPath.split(pathSeparator));
  }

  const seenDirs = new Set();
  const selfFileNorm = normalizePathForCompare(shimFilePath, fsModule, platform);
  const selfDirNorm = normalizePathForCompare(path.dirname(shimFilePath), fsModule, platform);

  const filteredDirs = [];
  for (const rawDir of rawSegments) {
    const trimmed = String(rawDir || '').trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    const normLower = trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normLower.includes('.agents/shims') || normLower.endsWith('/shims')) {
      continue;
    }
    const dirNorm = normalizePathForCompare(trimmed, fsModule, platform);
    if (dirNorm === selfDirNorm || seenDirs.has(dirNorm)) {
      continue;
    }
    seenDirs.add(dirNorm);
    filteredDirs.push(trimmed);
  }

  const gitExeNames = platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];

  for (const dir of filteredDirs) {
    for (const exe of gitExeNames) {
      const candidate = path.join(dir, exe);
      try {
        if (fsModule.existsSync(candidate) && fsModule.statSync(candidate).isFile()) {
          const candNorm = normalizePathForCompare(candidate, fsModule, platform);
          if (candNorm === selfFileNorm || path.dirname(candNorm) === selfDirNorm) {
            continue;
          }
          return candidate;
        }
      } catch (err) {
        // Continue searching
        recordHookDiagnostic('agy_git_guard', 'resolveRealGitBinary.pathProbe', err, {
          ignoreCodes: ['ENOENT', 'ENOTDIR']
        });
      }
    }
  }

  // System fallbacks when PATH does not resolve
  const fallbacks = platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        'C:\\Program Files (x86)\\Git\\bin\\git.exe'
      ]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];

  for (const candidate of fallbacks) {
    try {
      if (fsModule.existsSync(candidate) && fsModule.statSync(candidate).isFile()) {
        const candNorm = normalizePathForCompare(candidate, fsModule, platform);
        if (candNorm !== selfFileNorm && path.dirname(candNorm) !== selfDirNorm) {
          return candidate;
        }
      }
    } catch (err) {
      // Ignore inaccessible fallback
      recordHookDiagnostic('agy_git_guard', 'resolveRealGitBinary.fallbackProbe', err, {
        ignoreCodes: ['ENOENT', 'ENOTDIR']
      });
    }
  }

  // Fail closed: NEVER return bare 'git' (prevents infinite fork-bomb recursion)
  return null;
}

function extractSecurityOptions(workspaceDirOrOptions, maybeOptions) {
  if (workspaceDirOrOptions && typeof workspaceDirOrOptions === 'object') {
    return workspaceDirOrOptions;
  }
  if (maybeOptions && typeof maybeOptions === 'object') {
    return maybeOptions;
  }
  return {};
}

/**
 * Returns the path to the user-private bypass nonce file outside the agent-writable workspace.
 * Never reads `.agents/cache/git_bypass_nonce.json` from workspace CWD by default.
 */
export function getBypassNonceFilePath(options = {}) {
  const opts = extractSecurityOptions(options);
  if (opts.nonceFilePath && typeof opts.nonceFilePath === 'string') {
    return path.resolve(opts.nonceFilePath);
  }
  return path.join(os.homedir(), '.attention-horizon', 'security', 'git_bypass_nonce.json');
}

/**
 * Returns the path to the `0o600` HMAC secret key file used to authenticate bypass nonces.
 */
export function getBypassHmacKeyPath(options = {}) {
  const opts = extractSecurityOptions(options);
  if (opts.secretKeyPath && typeof opts.secretKeyPath === 'string') {
    return path.resolve(opts.secretKeyPath);
  }
  return path.join(os.homedir(), '.attention-horizon', 'security', 'git_bypass_hmac.key');
}

function getOrCreateBypassHmacSecret(options = {}) {
  const keyPath = getBypassHmacKeyPath(options);
  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  }
  const secret = crypto.randomBytes(32).toString('hex');
  atomicWriteFileSync(keyPath, `${secret}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    dirMode: 0o700
  });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch (err) {
    recordHookDiagnostic('agy_git_guard', 'getOrCreateBypassHmacSecret.chmod', err, {
      ignoreCodes: ['ENOSYS', 'EINVAL'],
      persist: false
    });
  }
  return secret;
}

export function signBypassNoncePayload(secret, { nonce, createdAtMs, expiresAtMs }) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${nonce}:${createdAtMs}:${expiresAtMs}`, 'utf8')
    .digest('hex');
}

/**
 * Returns the path to the security events log.
 */
export function getSecurityEventsFilePath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.agents', 'cache', 'security_events.jsonl');
}

/**
 * Generates an HMAC-SHA256 signed one-time cryptographic bypass nonce with a 60-second TTL.
 */
export function generateGitBypassNonce(
  workspaceDirOrOptions = {},
  ttlMs = DET19_CONSTANTS.BYPASS_NONCE_TTL_MS,
  maybeOptions = {}
) {
  const opts = extractSecurityOptions(workspaceDirOrOptions, maybeOptions);
  const effectiveTtlMs = typeof workspaceDirOrOptions === 'object' && typeof workspaceDirOrOptions?.ttlMs === 'number'
    ? workspaceDirOrOptions.ttlMs
    : ttlMs;

  const secret = getOrCreateBypassHmacSecret(opts);
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const createdAtMs = now;
  const expiresAtMs = now + effectiveTtlMs;
  const signature = signBypassNoncePayload(secret, { nonce, createdAtMs, expiresAtMs });

  const payload = {
    nonce,
    createdAtMs,
    expiresAtMs,
    createdAtIso: new Date(now).toISOString(),
    signature
  };

  const noncePath = getBypassNonceFilePath(opts);
  atomicWriteFileSync(noncePath, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
    dirMode: 0o700
  });

  return payload;
}

/**
 * Consumes the one-time bypass nonce if present, validly HMAC-signed, and unexpired.
 * Immediately unlinks the file to prevent replay attacks.
 */
export function consumeGitBypassNonce(workspaceDirOrOptions = {}, maybeOptions = {}) {
  const opts = extractSecurityOptions(workspaceDirOrOptions, maybeOptions);
  const noncePath = getBypassNonceFilePath(opts);
  if (!fs.existsSync(noncePath)) {
    return { allowed: false, reason: 'NO_NONCE' };
  }

  try {
    const raw = fs.readFileSync(noncePath, 'utf8');
    // Invalidate immediately regardless of validity to prevent replay
    try {
      fs.unlinkSync(noncePath);
    } catch (unlinkErr) {
      recordHookDiagnostic('agy_git_guard', 'consumeGitBypassNonce.unlink', unlinkErr, {
        ignoreCodes: ['ENOENT']
      });
    }

    const data = JSON.parse(raw);
    const keyPath = getBypassHmacKeyPath(opts);
    if (
      !data ||
      typeof data.nonce !== 'string' ||
      !data.nonce ||
      typeof data.createdAtMs !== 'number' ||
      typeof data.expiresAtMs !== 'number' ||
      typeof data.signature !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(data.signature) ||
      !fs.existsSync(keyPath)
    ) {
      return { allowed: false, reason: 'INVALID_SIGNATURE' };
    }

    const secret = fs.readFileSync(keyPath, 'utf8').trim();
    if (!secret) {
      return { allowed: false, reason: 'INVALID_SIGNATURE' };
    }

    const expectedHex = signBypassNoncePayload(secret, {
      nonce: data.nonce,
      createdAtMs: data.createdAtMs,
      expiresAtMs: data.expiresAtMs
    });
    const actualBuf = Buffer.from(data.signature, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (actualBuf.length !== 32 || expectedBuf.length !== 32 || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      return { allowed: false, reason: 'INVALID_SIGNATURE' };
    }

    const now = Date.now();
    if (now <= data.expiresAtMs) {
      return { allowed: true, nonce: data.nonce };
    }

    return { allowed: false, reason: 'EXPIRED_NONCE' };
  } catch (err) {
    recordHookDiagnostic('agy_git_guard', 'consumeGitBypassNonce', err);
    try {
      if (fs.existsSync(noncePath)) fs.unlinkSync(noncePath);
    } catch (cleanupErr) {
      recordHookDiagnostic('agy_git_guard', 'consumeGitBypassNonce.cleanupUnlink', cleanupErr, {
        ignoreCodes: ['ENOENT']
      });
    }
    return { allowed: false, reason: 'INVALID_NONCE' };
  }
}

/**
 * Records a security event in `.agents/cache/security_events.jsonl`.
 */
export function recordSecurityEvent(workspaceDir = process.cwd(), eventPayload = {}) {
  try {
    const eventsPath = getSecurityEventsFilePath(workspaceDir);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...eventPayload
    }) + '\n';
    fs.appendFileSync(eventsPath, line, 'utf8');
  } catch (err) {
    // Non-fatal telemetry failure
    recordHookDiagnostic('agy_git_guard', 'recordSecurityEvent', err);
  }
}

function hasHooksPathEnvOverride(env = {}) {
  if (!env || typeof env !== 'object') return null;

  if (String(env.HUSKY || '') === '0' || String(env.GIT_HOOKS || '') === '0') {
    return 'HUSKY=0 / GIT_HOOKS=0';
  }

  const huskySkip = String(env.HUSKY_SKIP_HOOKS ?? '').trim().toLowerCase();
  if (huskySkip && huskySkip !== '0' && huskySkip !== 'false') {
    return `HUSKY_SKIP_HOOKS=${env.HUSKY_SKIP_HOOKS}`;
  }

  if (typeof env.GIT_CONFIG_PARAMETERS === 'string' && /core\.hooksPath/i.test(env.GIT_CONFIG_PARAMETERS)) {
    return 'GIT_CONFIG_PARAMETERS=core.hooksPath';
  }

  const count = parseInt(String(env.GIT_CONFIG_COUNT ?? '0'), 10);
  if (Number.isFinite(count) && count > 0) {
    for (let idx = 0; idx < Math.min(count, 64); idx++) {
      const kVal = String(env[`GIT_CONFIG_KEY_${idx}`] || '').trim();
      if (/^core\.hooksPath$/i.test(kVal)) {
        return `GIT_CONFIG_KEY_${idx}=${kVal}`;
      }
    }
  }

  for (const [k, v] of Object.entries(env)) {
    if (/^GIT_CONFIG_KEY_\d+$/i.test(k) && /^core\.hooksPath$/i.test(String(v || '').trim())) {
      return `${k}=${v}`;
    }
  }

  return null;
}

/**
 * Inspects raw git CLI arguments and environment for DET-19 evasion patterns.
 */
export function inspectGitArgs(rawArgs = [], env = process.env) {
  // 1. Check hook-disabling environment variables
  const envViolation = hasHooksPathEnvOverride(env);
  if (envViolation) {
    return {
      blocked: true,
      detectorId: DET19_CONSTANTS.DETECTOR_ID,
      reason: `Hook-disabling environment variable detected (${envViolation})`,
      subcommand: null,
      flags: [envViolation]
    };
  }

  // 2. Parse global flags vs subcommand
  let subcommand = null;
  let subcommandIdx = -1;
  const globalFlags = [];
  const subcommandArgs = [];

  let i = 0;
  while (i < rawArgs.length) {
    const arg = String(rawArgs[i] ?? '');
    if (arg === '--') {
      i++;
      continue;
    }

    if (subcommand === null) {
      if (arg.startsWith('-')) {
        globalFlags.push(arg);
        if (
          arg === '-c' ||
          arg === '-C' ||
          arg === '--git-dir' ||
          arg === '--work-tree' ||
          arg === '--namespace' ||
          arg === '--config-env'
        ) {
          if (i + 1 < rawArgs.length) {
            globalFlags.push(String(rawArgs[i + 1] ?? ''));
            i++;
          }
        }
      } else {
        subcommand = arg.toLowerCase();
        subcommandIdx = i;
        i++;
        break;
      }
    }
    i++;
  }

  if (subcommandIdx !== -1) {
    for (; i < rawArgs.length; i++) {
      subcommandArgs.push(String(rawArgs[i] ?? ''));
    }
  }

  // 3. Inspect global flags for core.hooksPath overrides (both `-c core.hooksPath=...` and attached `-ccore.hooksPath=...`)
  for (let j = 0; j < globalFlags.length; j++) {
    const gf = globalFlags[j];
    if (gf === '-c' || gf === '--config-env') {
      const nextVal = globalFlags[j + 1] || '';
      if (/^core\.hooksPath(?:\s*=|$)/i.test(nextVal)) {
        return {
          blocked: true,
          detectorId: DET19_CONSTANTS.DETECTOR_ID,
          subcommand,
          flags: [gf, nextVal],
          reason: 'Global config override core.hooksPath is prohibited.'
        };
      }
    } else if (/^-c\s*core\.hooksPath(?:\s*=|$)/i.test(gf) || /^--config-env=core\.hooksPath(?:\s*=|$)/i.test(gf)) {
      return {
        blocked: true,
        detectorId: DET19_CONSTANTS.DETECTOR_ID,
        subcommand,
        flags: [gf],
        reason: 'Global config override core.hooksPath is prohibited.'
      };
    }
  }

  if (!subcommand) {
    return { blocked: false, subcommand: null, flags: [] };
  }

  // 3b. Block mutating `git config ... core.hooksPath ...` while allowing read-only `--get` / `--list`
  if (subcommand === 'config') {
    const isReadOnlyQuery = subcommandArgs.some((a) =>
      /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/i.test(String(a || ''))
    );
    if (!isReadOnlyQuery) {
      const positionalConfigArgs = [];
      for (let i = 0; i < subcommandArgs.length; i++) {
        const sArg = String(subcommandArgs[i] ?? '');
        if (sArg === '--') {
          positionalConfigArgs.push(...subcommandArgs.slice(i + 1).map((x) => String(x ?? '')));
          break;
        }
        if (sArg === '-f' || sArg === '--file' || sArg === '--blob') {
          i++;
          continue;
        }
        if (/^(--unset|--unset-all|--replace-all|--add)$/i.test(sArg)) {
          const targetKey = String(subcommandArgs[i + 1] ?? '');
          if (/^core\.hooksPath$/i.test(targetKey)) {
            return {
              blocked: true,
              detectorId: DET19_CONSTANTS.DETECTOR_ID,
              subcommand,
              flags: [sArg, targetKey],
              reason: 'Modifying git config core.hooksPath is prohibited.'
            };
          }
        }
        if (!sArg.startsWith('-')) {
          positionalConfigArgs.push(sArg);
        }
      }
      // `git config core.hooksPath <value>` has >= 2 positional args (or `core.hooksPath=...`)
      for (let p = 0; p < positionalConfigArgs.length; p++) {
        const pos = positionalConfigArgs[p];
        if (/^core\.hooksPath=/i.test(pos) || (/^core\.hooksPath$/i.test(pos) && positionalConfigArgs.length >= p + 2)) {
          return {
            blocked: true,
            detectorId: DET19_CONSTANTS.DETECTOR_ID,
            subcommand,
            flags: [pos],
            reason: 'Modifying git config core.hooksPath is prohibited.'
          };
        }
      }
    }
    return { blocked: false, subcommand, flags: [] };
  }

  // 4. Subcommand-specific bypass detection with strict left-to-right short-flag parsing
  const blockedFlags = [];
  const VALUE_TAKING_LONG_FLAGS = new Set([
    '--message',
    '--file',
    '--author',
    '--date',
    '--template',
    '--cleanup',
    '--reuse-message',
    '--reedit-message',
    '--fixup',
    '--squash',
    '--trailer',
    '--pathspec-from-file',
    '--strategy',
    '--strategy-option',
    '--exec',
    '--onto'
  ]);
  const VALUE_TAKING_SHORT_CHARS = new Set(['m', 'F', 'C', 'c', 't', 'u']);
  const shortNMeansNoVerify = DET19_CONSTANTS.SHORT_N_NO_VERIFY_SUBCOMMANDS.includes(subcommand);

  if (DET19_CONSTANTS.PROTECTED_SUBCOMMANDS.includes(subcommand)) {
    for (let k = 0; k < subcommandArgs.length; k++) {
      const sArg = String(subcommandArgs[k] ?? '');
      if (sArg === '--') break;

      if (sArg === '--no-verify') {
        blockedFlags.push(sArg);
        continue;
      }

      if (subcommand === 'commit' && sArg === '--no-gpg-sign') {
        blockedFlags.push(sArg);
        continue;
      }

      if (/^-c\s*core\.hooksPath(?:\s*=|$)/i.test(sArg)) {
        blockedFlags.push(sArg);
        continue;
      }

      if (VALUE_TAKING_LONG_FLAGS.has(sArg)) {
        // Skip the next token because it is the value for this long option (e.g. --message "-next")
        k++;
        continue;
      }

      if (/^-[^-].*$/.test(sArg)) {
        const cluster = sArg.slice(1);
        for (let idx = 0; idx < cluster.length; idx++) {
          const ch = cluster[idx];

          if (ch === 'n' && shortNMeansNoVerify) {
            blockedFlags.push(sArg);
            continue;
          }

          if (VALUE_TAKING_SHORT_CHARS.has(ch)) {
            if (idx < cluster.length - 1) {
              const attachedVal = cluster.slice(idx + 1);
              if (ch === 'c' && /^core\.hooksPath(?:\s*=|$)/i.test(attachedVal)) {
                blockedFlags.push(sArg);
                break;
              }
              // Special case: grouped flags like `-amn "fix"` where boolean flag(s) precede `m`,
              // the remainder is solely `n`, and a separate non-flag message token immediately follows.
              if (
                subcommand === 'commit' &&
                idx > 0 &&
                attachedVal === 'n' &&
                k + 1 < subcommandArgs.length &&
                !String(subcommandArgs[k + 1] ?? '').startsWith('-')
              ) {
                blockedFlags.push(sArg);
                k++;
                break;
              }
              // Otherwise remainder is this option's attached argument (e.g. `-mnotes`, `-mfoo`, `-uno`):
              // stop scanning cluster without checking remaining chars for `n` and WITHOUT incrementing `k`!
              break;
            }

            // `idx === cluster.length - 1`: option is at the end of the cluster
            if (ch === 'c' && k + 1 < subcommandArgs.length) {
              const nextVal = String(subcommandArgs[k + 1] ?? '');
              if (/^core\.hooksPath(?:\s*=|$)/i.test(nextVal)) {
                blockedFlags.push(`${sArg} ${nextVal}`);
              }
            }
            if (ch === 'u') {
              // In `git commit` (`-u[<mode>]`) and `git push` (`-u`), standalone `-u` does not consume a following flag token.
              break;
            }
            k++;
            break;
          }
        }
      }
    }
  }

  if (blockedFlags.length > 0) {
    return {
      blocked: true,
      detectorId: DET19_CONSTANTS.DETECTOR_ID,
      subcommand,
      flags: blockedFlags,
      reason: `Pre-commit / verification bypass flags (${blockedFlags.join(', ')}) are prohibited for "git ${subcommand}".`
    };
  }

  return { blocked: false, subcommand, flags: [] };
}

/**
 * Runs the Git Guard engine for a CLI or process invocation.
 */
export function runGitGuard({
  args = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  realGitBinary = null,
  spawnFn = spawnSync,
  stderr = process.stderr,
  nonceFilePath = null,
  secretKeyPath = null,
  fsModule = fs,
  platform = process.platform
} = {}) {
  const inspection = inspectGitArgs(args, env);
  const nonceOpts = {};
  if (nonceFilePath) nonceOpts.nonceFilePath = nonceFilePath;
  if (secretKeyPath) nonceOpts.secretKeyPath = secretKeyPath;

  if (inspection.blocked) {
    // Check for valid single-use HMAC-signed human cryptographic nonce outside workspace
    const nonceResult = consumeGitBypassNonce(nonceOpts);
    if (nonceResult.allowed) {
      recordSecurityEvent(cwd, {
        event: 'DET-19_HOOK_BYPASS_AUTHORIZED_BY_NONCE',
        detectorId: DET19_CONSTANTS.DETECTOR_ID,
        subcommand: inspection.subcommand,
        flags: inspection.flags,
        cwd,
        nonce: nonceResult.nonce,
        blocked: false
      });
    } else {
      if (stderr && typeof stderr.write === 'function') {
        stderr.write(`${DET19_CONSTANTS.BLOCKED_MESSAGE}\n`);
      }
      recordSecurityEvent(cwd, {
        event: 'DET-19_HOOK_BYPASS_ATTEMPT',
        detectorId: DET19_CONSTANTS.DETECTOR_ID,
        subcommand: inspection.subcommand,
        flags: inspection.flags,
        cwd,
        blocked: true,
        reason: inspection.reason
      });

      return {
        blocked: true,
        exitCode: DET19_CONSTANTS.EXIT_CODE_BLOCKED,
        reason: inspection.reason,
        inspection
      };
    }
  }

  // Resolve real git binary; fail closed with exit code 127 if unavailable
  const binary = realGitBinary || resolveRealGitBinary({ env, platform, fsModule });
  if (!binary) {
    const msg = '[HORIZON DET-19 ERROR] Real git binary could not be resolved outside shim directories.\n';
    if (stderr && typeof stderr.write === 'function') {
      stderr.write(msg);
    }
    return {
      blocked: true,
      exitCode: DET19_CONSTANTS.EXIT_CODE_GIT_NOT_FOUND,
      reason: 'Real git binary not found in PATH'
    };
  }

  const child = spawnFn(binary, args, {
    cwd,
    env,
    stdio: 'inherit'
  });

  return {
    blocked: false,
    exitCode: child.status ?? 0
  };
}

// CLI Direct Invocation
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFilePath && path.resolve(currentFilePath) === invokedFilePath) {
  const result = runGitGuard();
  process.exit(result.exitCode);
}

export default {
  DET19_CONSTANTS,
  resolveRealGitBinary,
  getBypassNonceFilePath,
  getBypassHmacKeyPath,
  signBypassNoncePayload,
  getSecurityEventsFilePath,
  generateGitBypassNonce,
  consumeGitBypassNonce,
  recordSecurityEvent,
  inspectGitArgs,
  runGitGuard
};
