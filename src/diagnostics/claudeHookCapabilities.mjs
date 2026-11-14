/**
 * @file src/diagnostics/claudeHookCapabilities.mjs
 * Startup feature-check for undocumented Claude Code hook contracts (`PreModelSwitch`,
 * `permissionBehavior === "ask"`, payload keys `from_model`/`to_model`/`prompt_cache_warm`,
 * and absence of `PreEffortChange`).
 *
 * Scans the installed Claude Code binary/bundle in bounded 4 MB chunks with 256-byte overlap,
 * caches results by `(binaryPath, size, mtimeMs)` under `.claude/cache/ah_claude_capabilities.json`,
 * and logs a non-fatal runtime diagnostic if the installed binary drops the hook contract.
 */

import { execFileSync } from 'node:child_process';
import {
  fs,
  path,
  readJsonSafe,
  writeJsonAtomic
} from '../utils/nodeIo.mjs';
import { recordRuntimeDiagnostic } from '../core-isomorphic/utils/runtime.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const OVERLAP_BYTES = 256;

const CAPABILITY_MARKERS = Object.freeze({
  preModelSwitchSupported: 'PreModelSwitch',
  postModelSwitchSupported: 'PostModelSwitch',
  preEffortChangeSupported: 'PreEffortChange',
  hasFromModelKey: 'from_model',
  hasToModelKey: 'to_model',
  hasPromptCacheWarmKey: 'prompt_cache_warm',
  hasContextTokensKey: 'context_tokens',
  hasAskBehavior: 'permissionBehavior==="ask"',
  hasAskDialog: 'A PreModelSwitch hook asked',
  sdkSetModelHooked: 'blocked_by_hook'
});

/**
 * Resolves the underlying JS bundle or native binary when given a Windows `.cmd` / POSIX wrapper.
 * @param {string} candidatePath
 * @returns {string}
 */
function unwrapClaudeShim(candidatePath) {
  if (!candidatePath || !fs.existsSync(candidatePath)) return candidatePath;
  const ext = path.extname(candidatePath).toLowerCase();
  const dir = path.dirname(candidatePath);

  if (ext === '.cmd' || ext === '.bat') {
    const pkgBase = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    const exeInPkg = path.join(pkgBase, 'bin', 'claude.exe');
    const jsInPkg = path.join(pkgBase, 'cli.js');
    if (fs.existsSync(exeInPkg)) return exeInPkg;
    if (fs.existsSync(jsInPkg)) return jsInPkg;
  }

  return candidatePath;
}

/**
 * Resolves the active `claude` binary/bundle path from options, `CLAUDE_BIN`, or `PATH`.
 * @param {object} [options={}]
 * @returns {string | null}
 */
export function resolveClaudeBinaryPath(options = {}) {
  const candidates = [];
  if (typeof options.claudeBinPath === 'string' && options.claudeBinPath.trim()) {
    candidates.push(options.claudeBinPath.trim());
  }
  const envBin = globalThis.process?.env?.CLAUDE_BIN;
  if (typeof envBin === 'string' && envBin.trim()) {
    candidates.push(envBin.trim());
  }

  if (candidates.length === 0) {
    const pathEnv = String(globalThis.process?.env?.PATH || '');
    const sep = globalThis.process?.platform === 'win32' ? ';' : ':';
    const names =
      globalThis.process?.platform === 'win32'
        ? ['claude.exe', 'claude.cmd', 'claude']
        : ['claude'];
    for (const dir of pathEnv.split(sep).filter(Boolean)) {
      for (const name of names) {
        candidates.push(path.join(dir, name));
      }
    }
  }

  for (const raw of candidates) {
    try {
      const unwrapped = unwrapClaudeShim(raw);
      if (unwrapped && fs.existsSync(unwrapped)) {
        const st = fs.statSync(unwrapped);
        if (st.isFile()) return unwrapped;
      }
    } catch {
      // Skip inaccessible candidate
    }
  }
  return null;
}

/**
 * Reads sibling `@anthropic-ai/claude-code/package.json` (fast, zero subprocess) or optionally
 * queries `claude --version` when `options.probeVersion === true`.
 *
 * @param {string} binPath
 * @param {object} [options={}]
 * @returns {string | null}
 */
function detectClaudeVersion(binPath, options = {}) {
  const pkgCandidates = [
    path.join(path.dirname(binPath), 'package.json'),
    path.join(path.dirname(binPath), '..', 'package.json')
  ];
  for (const pkgPath of pkgCandidates) {
    const parsed = readJsonSafe(pkgPath, null, options);
    if (parsed && parsed.name === '@anthropic-ai/claude-code' && typeof parsed.version === 'string') {
      return parsed.version;
    }
  }

  if (options.probeVersion === true) {
    try {
      const out = execFileSync(binPath, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const match = out.match(/(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/);
      if (match) return match[1];
    } catch {
      // Ignore version subprocess failure
    }
  }
  return null;
}

/**
 * Streams a file in bounded 4 MB overlapping chunks to test exact ASCII substring markers
 * without loading large standalone binaries wholly into V8 heap memory.
 *
 * @param {string} binPath
 * @returns {Record<string, boolean>}
 */
function scanBinaryMarkersChunked(binPath) {
  const foundFlags = Object.fromEntries(Object.keys(CAPABILITY_MARKERS).map((k) => [k, false]));
  const markerEntries = Object.entries(CAPABILITY_MARKERS);
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const fd = fs.openSync(binPath, 'r');
  try {
    let tail = '';
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK_BYTES, null)) > 0) {
      const chunkStr = tail + buf.subarray(0, bytesRead).toString('latin1');
      let allFound = true;
      for (const [key, marker] of markerEntries) {
        if (!foundFlags[key]) {
          if (chunkStr.includes(marker)) {
            foundFlags[key] = true;
          } else {
            allFound = false;
          }
        }
      }
      if (allFound) break;
      tail = chunkStr.slice(Math.max(0, chunkStr.length - OVERLAP_BYTES));
    }
  } finally {
    fs.closeSync(fd);
  }
  return foundFlags;
}

/**
 * Inspects the installed Claude Code CLI/bundle for `PreModelSwitch` support and contract parity.
 *
 * @param {object} [options={}]
 * @returns {{
 *   found: boolean,
 *   binaryPath: string | null,
 *   claudeVersion: string | null,
 *   preModelSwitchSupported: boolean | null,
 *   postModelSwitchSupported: boolean | null,
 *   preEffortChangeSupported: boolean | null,
 *   supportsAskDecision: boolean | null,
 *   sdkSetModelHooked: boolean | null,
 *   payloadKeys: { from_model: boolean, to_model: boolean, prompt_cache_warm: boolean, context_tokens: boolean } | null,
 *   contractValid: boolean | null,
 *   cached: boolean,
 *   warning: string | null
 * }}
 */
export function inspectClaudeBinaryCapabilities(options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const binPath = resolveClaudeBinaryPath(options);
  if (!binPath) {
    return {
      found: false,
      binaryPath: null,
      claudeVersion: null,
      preModelSwitchSupported: null,
      postModelSwitchSupported: null,
      preEffortChangeSupported: null,
      supportsAskDecision: null,
      sdkSetModelHooked: null,
      payloadKeys: null,
      contractValid: null,
      cached: false,
      warning: null
    };
  }

  let stat;
  try {
    stat = fs.statSync(binPath);
  } catch {
    return {
      found: false,
      binaryPath: null,
      claudeVersion: null,
      preModelSwitchSupported: null,
      postModelSwitchSupported: null,
      preEffortChangeSupported: null,
      supportsAskDecision: null,
      sdkSetModelHooked: null,
      payloadKeys: null,
      contractValid: null,
      cached: false,
      warning: null
    };
  }

  const cachePath = options.cachePath || path.join(cwd, '.claude', 'cache', 'ah_claude_capabilities.json');
  if (!options.bypassCache) {
    const cached = readJsonSafe(cachePath, null, options);
    if (
      cached &&
      cached.binaryPath === binPath &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.result &&
      typeof cached.result.contractValid === 'boolean'
    ) {
      return { ...cached.result, cached: true };
    }
  }

  const markers = scanBinaryMarkersChunked(binPath);
  const claudeVersion = options.claudeVersion || detectClaudeVersion(binPath, options);
  const payloadKeys = {
    from_model: markers.hasFromModelKey,
    to_model: markers.hasToModelKey,
    prompt_cache_warm: markers.hasPromptCacheWarmKey,
    context_tokens: markers.hasContextTokensKey
  };
  const supportsAskDecision = Boolean(markers.hasAskBehavior || markers.hasAskDialog);
  const contractValid = Boolean(
    markers.preModelSwitchSupported &&
      payloadKeys.from_model &&
      payloadKeys.to_model &&
      payloadKeys.prompt_cache_warm &&
      supportsAskDecision
  );

  const warning = contractValid
    ? null
    : `[Highbeam Startup Check] Claude Code (${claudeVersion || 'unknown'}) does not expose the expected undocumented PreModelSwitch hook contract; DET-08 native /model interception is unavailable.`;

  if (warning && options.recordDiagnostic !== false) {
    recordRuntimeDiagnostic(
      'claudeHookCapabilities',
      'inspectClaudeBinaryCapabilities',
      new Error(warning),
      { ...options, cwd }
    );
  }

  const result = {
    found: true,
    binaryPath: binPath,
    claudeVersion,
    preModelSwitchSupported: markers.preModelSwitchSupported,
    postModelSwitchSupported: markers.postModelSwitchSupported,
    preEffortChangeSupported: markers.preEffortChangeSupported,
    supportsAskDecision,
    sdkSetModelHooked: markers.sdkSetModelHooked,
    payloadKeys,
    contractValid,
    cached: false,
    warning
  };

  if (options.writeCache !== false && (options.cwd || options.cachePath)) {
    writeJsonAtomic(
      cachePath,
      {
        binaryPath: binPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        result
      },
      options
    );
  }

  return result;
}

export default {
  resolveClaudeBinaryPath,
  inspectClaudeBinaryCapabilities
};
