/**
 * @file src/core/shield_manager.mjs
 * Unified Active Context Shield Manager, Net-Positive Read Firewall (`>=1,200` lines default,
 * `150` lines near `100k`/`200k` pricing cliffs), Out-of-Band `.hints.jsonl` Telemetry,
 * and Non-Destructive Hook Merger (`ctxtop shield --enable | --disable | --status`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { buildIndex, isForbiddenSkuPath } from './doc_indexer.mjs';
import { normalizeModelKey, resolveModelRates } from './constants.mjs';
import {
  recordInterventionSavings,
  getSavedQuotaReceiptSummary
} from '../core-isomorphic/coach/savedQuotaLedger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');

export const DEFAULT_SHIELD_MAX_UNSLICED_LINES = 1200;
export const CLIFF_SHIELD_MAX_UNSLICED_LINES = 150;
export const COLD_CACHE_GAP_MS = 300_000; // 5-minute TTL

const CTXTOP_CLAUDE_SCRIPT_RE =
  /hooks[\\/]handlers[\\/](?:pre-tool-use|post-tool-use)\.mjs/i;

/**
 * Resolves known model prompt-pricing cliff thresholds (`100k` Haiku 5.5, `200k` Gemini 3.1/2.5 Pro).
 *
 * @param {string} [modelId='']
 * @returns {number}
 */
export function resolvePromptCliffTokens(modelId = '') {
  const norm = normalizeModelKey(modelId || '');
  if (!norm) return 0;
  if (norm.includes('haiku-5-5') || norm.includes('haiku-5.5')) {
    return 100_000;
  }
  if (
    norm.includes('gemini-3-1-pro') ||
    norm.includes('gemini-3.1-pro') ||
    norm.includes('gemini-2-5-pro') ||
    norm.includes('gemini-2.5-pro')
  ) {
    return 200_000;
  }
  return 0;
}

/**
 * Resolves `.agents/telemetry/ctxtop-shield.config.json` inside `<cwd>`.
 *
 * @param {object} [options={}]
 * @returns {string}
 */
export function getShieldConfigPath(options = {}) {
  if (typeof options.shieldConfigPath === 'string' && options.shieldConfigPath.trim()) {
    return path.resolve(options.shieldConfigPath.trim());
  }
  const baseCwd = path.resolve(options.cwd || process.cwd());
  return path.join(baseCwd, '.agents', 'telemetry', 'ctxtop-shield.config.json');
}

/**
 * Loads the Active Context Shield configuration, defaulting `enabled` to `false` until
 * explicitly activated via `ctxtop shield --enable` (or programmatic override).
 *
 * @param {object} [options={}]
 * @returns {{
 *   enabled: boolean,
 *   platforms: { antigravity: boolean, claude: boolean },
 *   maxUnslicedLines: number,
 *   cliffMaxUnslicedLines: number,
 *   updatedAt: string | null,
 *   configPath: string
 * }}
 */
export function loadShieldConfig(options = {}) {
  const configPath = getShieldConfigPath(options);
  const defaults = {
    enabled: false,
    platforms: { antigravity: false, claude: false },
    maxUnslicedLines: DEFAULT_SHIELD_MAX_UNSLICED_LINES,
    cliffMaxUnslicedLines: CLIFF_SHIELD_MAX_UNSLICED_LINES,
    updatedAt: null,
    configPath
  };
  if (!fs.existsSync(configPath)) {
    return defaults;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaults;
    const enabled = Boolean(parsed.enabled);
    const platforms = {
      antigravity:
        parsed.platforms && typeof parsed.platforms.antigravity === 'boolean'
          ? parsed.platforms.antigravity
          : enabled,
      claude:
        parsed.platforms && typeof parsed.platforms.claude === 'boolean'
          ? parsed.platforms.claude
          : enabled
    };
    const maxLines = Number(parsed.maxUnslicedLines);
    const cliffLines = Number(parsed.cliffMaxUnslicedLines);
    return {
      enabled: Boolean(enabled || platforms.antigravity || platforms.claude),
      platforms,
      maxUnslicedLines:
        Number.isFinite(maxLines) && maxLines >= 100
          ? Math.round(maxLines)
          : DEFAULT_SHIELD_MAX_UNSLICED_LINES,
      cliffMaxUnslicedLines:
        Number.isFinite(cliffLines) && cliffLines >= 50
          ? Math.round(cliffLines)
          : CLIFF_SHIELD_MAX_UNSLICED_LINES,
      updatedAt: parsed.updatedAt || null,
      configPath
    };
  } catch {
    return defaults;
  }
}

/**
 * Atomically persists `.agents/telemetry/ctxtop-shield.config.json`.
 *
 * @param {object} partial
 * @param {object} [options={}]
 */
export function saveShieldConfig(partial = {}, options = {}) {
  const current = loadShieldConfig(options);
  const nextPlatforms = {
    antigravity:
      partial.platforms?.antigravity !== undefined
        ? Boolean(partial.platforms.antigravity)
        : current.platforms.antigravity,
    claude:
      partial.platforms?.claude !== undefined
        ? Boolean(partial.platforms.claude)
        : current.platforms.claude
  };
  const nextEnabled =
    partial.enabled !== undefined
      ? Boolean(partial.enabled)
      : Boolean(nextPlatforms.antigravity || nextPlatforms.claude);
  const payload = {
    enabled: nextEnabled,
    platforms: nextPlatforms,
    maxUnslicedLines:
      Number.isFinite(Number(partial.maxUnslicedLines)) && Number(partial.maxUnslicedLines) >= 100
        ? Math.round(Number(partial.maxUnslicedLines))
        : current.maxUnslicedLines,
    cliffMaxUnslicedLines:
      Number.isFinite(Number(partial.cliffMaxUnslicedLines)) && Number(partial.cliffMaxUnslicedLines) >= 50
        ? Math.round(Number(partial.cliffMaxUnslicedLines))
        : current.cliffMaxUnslicedLines,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(current.configPath), { recursive: true });
  atomicWriteFileSync(current.configPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { ...payload, configPath: current.configPath };
}

function sanitizeSessionFileId(sessionId = 'default') {
  const cleaned = String(sessionId || 'default')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
  return cleaned || 'default';
}

/**
 * Appends a zero-prompt-token telemetry event to `.agents/telemetry/<sessionId>.hints.jsonl`.
 *
 * @param {string} sessionId
 * @param {object} eventRecord
 * @param {object} [options={}]
 * @returns {string}
 */
export function appendShieldHint(sessionId, eventRecord = {}, options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const safeId = sanitizeSessionFileId(sessionId);
  const telemetryDir = path.join(baseCwd, '.agents', 'telemetry');
  const hintsPath = path.join(telemetryDir, `${safeId}.hints.jsonl`);
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    const row = {
      timestamp: new Date().toISOString(),
      sessionId: safeId,
      ...eventRecord
    };
    fs.appendFileSync(hintsPath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // Non-fatal telemetry write
  }
  return hintsPath;
}

/**
 * Evaluates an incoming `Read` / `read_file` / `view_file` call against the Active Context Shield.
 *
 * Net-Positive Cache Math:
 * - Default threshold is `1,200` lines (`~12k+` tokens), tightening to `150` lines when the session
 *   is at `>= 90%` of a model prompt-pricing cliff (`90k` Haiku 5.5 / `180k` Gemini 3.1/2.5 Pro).
 * - Never blocks sliced reads (`StartLine`/`EndLine` or `offset`/`limit`/`pages`), `.index.md` files,
 *   or isolated `packages/airlock/` files.
 *
 * @param {object} params
 * @param {'antigravity' | 'claude'} [params.platform='claude']
 * @param {string} [params.sessionId='default']
 * @param {string} [params.cwd]
 * @param {string} [params.filePath='']
 * @param {boolean} [params.hasSliceBounds=false]
 * @param {number} [params.currentPromptTokens=0]
 * @param {string} [params.modelId='claude-sonnet-5-5']
 * @param {object} [params.shieldConfig]
 * @param {boolean} [params.forceActive=false]
 * @param {boolean} [params.recordLedger=true]
 * @param {string} [params.ledgerPath]
 * @returns {{
 *   action: 'allow' | 'deny',
 *   detectorId?: string,
 *   reason?: string,
 *   indexPath?: string,
 *   relIndexPath?: string,
 *   totalLines?: number,
 *   maxLines?: number,
 *   nearCliff?: boolean,
 *   savedTokens?: number,
 *   savedUSD?: number
 * }}
 */
export function evaluateShieldReadGuard({
  platform = 'claude',
  sessionId = 'default',
  cwd = process.cwd(),
  filePath = '',
  hasSliceBounds = false,
  currentPromptTokens = 0,
  modelId = 'claude-sonnet-5-5',
  shieldConfig,
  forceActive = false,
  recordLedger = true,
  ledgerPath
} = {}) {
  const rawTarget = String(filePath || '').trim();
  if (!rawTarget || hasSliceBounds) {
    return { action: 'allow' };
  }
  if (rawTarget.endsWith('.index.md') || isForbiddenSkuPath(rawTarget)) {
    return { action: 'allow' };
  }

  const baseCwd = path.resolve(cwd || process.cwd());
  const absFile = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(baseCwd, rawTarget);
  const relFile = path.relative(baseCwd, absFile).replace(/\\/g, '/');
  if (isForbiddenSkuPath(absFile) || isForbiddenSkuPath(relFile)) {
    return { action: 'allow' };
  }

  const cfg = shieldConfig || loadShieldConfig({ cwd: baseCwd });
  const platformKey = platform === 'antigravity' ? 'antigravity' : 'claude';
  const shieldEnabledForPlatform = Boolean(
    forceActive || (cfg.enabled && cfg.platforms?.[platformKey] !== false)
  );

  const cliffTokens = resolvePromptCliffTokens(modelId);
  const promptTok = Math.max(0, Number(currentPromptTokens) || 0);
  const nearCliff = cliffTokens > 0 && promptTok >= Math.floor(cliffTokens * 0.9);

  // Near a pricing cliff (>=90% of 100k/200k), cliff protection activates even if general shield is passive,
  // unless shield was explicitly passed with forceActive === false and nearCliff === false.
  if (!shieldEnabledForPlatform && !nearCliff) {
    return { action: 'allow' };
  }

  if (!fs.existsSync(absFile)) {
    return { action: 'allow' };
  }
  let stat;
  try {
    stat = fs.statSync(absFile);
  } catch {
    return { action: 'allow' };
  }
  if (!stat.isFile() || stat.size < 1024) {
    return { action: 'allow' };
  }

  const maxLines = nearCliff
    ? (cfg.cliffMaxUnslicedLines || CLIFF_SHIELD_MAX_UNSLICED_LINES)
    : (cfg.maxUnslicedLines || DEFAULT_SHIELD_MAX_UNSLICED_LINES);

  let rawText;
  try {
    rawText = fs.readFileSync(absFile, 'utf8');
  } catch {
    return { action: 'allow' };
  }
  // Skip binary buffers with NUL bytes
  if (rawText.includes('\0')) {
    return { action: 'allow' };
  }

  const totalLines = rawText.length === 0 ? 0 : rawText.replace(/\r\n/g, '\n').split('\n').length;
  if (totalLines <= maxLines) {
    return { action: 'allow' };
  }

  const indexed = buildIndex(absFile, { cwd: baseCwd });
  if (!indexed.ok) {
    return { action: 'allow' };
  }

  const estFullTokens = Math.ceil(stat.size / 4);
  const savedTokens = Math.max(0, estFullTokens - indexed.indexTokens);
  const rates = resolveModelRates(modelId, Date.now(), 'standard', {
    totalPromptTokens: promptTok + estFullTokens
  });
  const savedUSD = Number(((savedTokens / 1_000_000) * Number(rates.inputPer1M || 3.0)).toFixed(6));

  const displayFile = !relFile.startsWith('..') && !path.isAbsolute(relFile) ? relFile : path.basename(absFile);
  const displayIndex = !indexed.relIndexPath.startsWith('..') ? indexed.relIndexPath : indexed.indexPath;
  const cliffTag = nearCliff
    ? ` (90% of ${(cliffTokens / 1000).toFixed(0)}k pricing cliff)`
    : '';

  const reason =
    platformKey === 'antigravity'
      ? `Highbeam Shield blocked un-sliced read of ${displayFile} (${totalLines} lines > ${maxLines}-line cap${cliffTag}; +${savedTokens.toLocaleString('en-US')} tok saved). Structural map ready at ${displayIndex}: read ${displayIndex} first, then call read_file with StartLine and EndLine.`
      : `Highbeam Shield blocked un-sliced Read of ${displayFile} (${totalLines} lines > ${maxLines}-line cap${cliffTag}; +${savedTokens.toLocaleString('en-US')} tok saved). Structural map ready at ${displayIndex}: call Read on ${displayIndex} first, then call Read on ${displayFile} with offset and limit.`;

  if (recordLedger) {
    recordInterventionSavings(
      {
        sessionId,
        category: 'BOUNDED_READ_ENFORCED',
        modelId,
        savedTokens,
        savedUSD,
        dedupeId: `shield_read:${sessionId}:${displayFile}:${indexed.sha256?.slice(0, 8) || totalLines}`,
        detail: `Blocked un-sliced read of ${displayFile} (${totalLines} lines -> ${displayIndex})`
      },
      { cwd: baseCwd, ...(ledgerPath ? { ledgerPath } : {}) }
    );
    appendShieldHint(
      sessionId,
      {
        event: 'blocked_unsliced_read',
        platform: platformKey,
        file: displayFile,
        index_path: displayIndex,
        lines_at_read: totalLines,
        max_lines: maxLines,
        near_cliff: nearCliff,
        tokens_saved_est: savedTokens,
        dollars_saved_est: savedUSD
      },
      { cwd: baseCwd }
    );
  }

  return {
    action: 'deny',
    detectorId: nearCliff ? 'DET-12' : 'DET-11',
    reason,
    indexPath: indexed.indexPath,
    relIndexPath: displayIndex,
    totalLines,
    maxLines,
    nearCliff,
    savedTokens,
    savedUSD
  };
}

/**
 * Ensures `.agents/` and `.claude/cache/` are listed in `.git/info/exclude` when `.git` exists,
 * without touching tracked files.
 *
 * @param {string} baseCwd
 */
function ensureLocalGitExclude(baseCwd) {
  const excludeFile = path.join(baseCwd, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.dirname(excludeFile))) return;
  try {
    const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    const needed = ['.agents/cache/', '.agents/telemetry/', '.claude/cache/'];
    const missing = needed.filter((entry) => !existing.includes(entry));
    if (missing.length > 0) {
      const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
      fs.writeFileSync(excludeFile, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Non-destructively merges or removes `ctxtop-*` named hook groups in `<cwd>/.agents/hooks.json`.
 * Preserves any `ctxvault` or custom user hook groups and NEVER touches `~/.gemini/antigravity-cli/settings.json`.
 *
 * @param {object} params
 * @param {'enable' | 'disable'} params.mode
 * @param {string} params.cwd
 * @param {string} [params.pkgRoot=PKG_ROOT]
 */
export function syncAntigravityShieldHooks({ mode = 'enable', cwd = process.cwd(), pkgRoot = PKG_ROOT } = {}) {
  const baseCwd = path.resolve(cwd);
  const hooksFile = path.join(baseCwd, '.agents', 'hooks.json');
  const rootNorm = String(pkgRoot || PKG_ROOT).replace(/\\/g, '/');
  const preScript = `${rootNorm}/src/hooks/pre_invocation.mjs`;
  const postScript = `${rootNorm}/src/hooks/post_invocation.mjs`;

  let doc = {};
  if (fs.existsSync(hooksFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = { ...parsed };
      }
    } catch {
      doc = {};
    }
  }

  if (mode === 'enable') {
    doc['ctxtop-read-guard'] = {
      PreToolUse: [
        {
          matcher: 'read_file|view_file',
          hooks: [
            {
              type: 'command',
              command: `node "${preScript}" --event=PreToolUse`,
              timeout: 5
            }
          ]
        }
      ]
    };
    doc['ctxtop-tail-guard'] = {
      PostToolUse: [
        {
          matcher: 'run_command',
          hooks: [
            {
              type: 'command',
              command: `node "${postScript}"`,
              timeout: 5
            }
          ]
        }
      ]
    };
    doc['ctxtop-turn-tracker'] = {
      PreInvocation: [
        {
          type: 'command',
          command: `node "${preScript}"`,
          timeout: 10
        }
      ]
    };
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    atomicWriteFileSync(hooksFile, `${JSON.stringify(doc, null, 2)}\n`);
  } else if (fs.existsSync(hooksFile)) {
    delete doc['ctxtop-read-guard'];
    delete doc['ctxtop-tail-guard'];
    delete doc['ctxtop-turn-tracker'];
    atomicWriteFileSync(hooksFile, `${JSON.stringify(doc, null, 2)}\n`);
  }

  return { hooksPath: hooksFile, document: doc };
}

function isCtxtopClaudeEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.command === 'string' && CTXTOP_CLAUDE_SCRIPT_RE.test(entry.command)) {
    return true;
  }
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(
      (inner) => typeof inner?.command === 'string' && CTXTOP_CLAUDE_SCRIPT_RE.test(inner.command)
    );
  }
  return false;
}

/**
 * Non-destructively merges or removes `ctxtop` hook entries in `<cwd>/.claude/settings.json`
 * under top-level `"hooks"`, preserving `ctxvault` and custom hooks and NEVER setting `"disableAllHooks": true`.
 *
 * @param {object} params
 * @param {'enable' | 'disable'} params.mode
 * @param {string} params.cwd
 * @param {string} [params.pkgRoot=PKG_ROOT]
 */
export function syncClaudeShieldHooks({ mode = 'enable', cwd = process.cwd(), pkgRoot = PKG_ROOT } = {}) {
  const baseCwd = path.resolve(cwd);
  const settingsFile = path.join(baseCwd, '.claude', 'settings.json');
  const rootNorm = String(pkgRoot || PKG_ROOT).replace(/\\/g, '/');
  const preCmd = `node "${rootNorm}/hooks/handlers/pre-tool-use.mjs"`;
  const postCmd = `node "${rootNorm}/hooks/handlers/post-tool-use.mjs"`;

  let doc = {};
  if (fs.existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = { ...parsed };
      }
    } catch {
      doc = {};
    }
  }

  // Safeguard: never introduce disableAllHooks: true
  const hooksObj =
    doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)
      ? { ...doc.hooks }
      : {};

  const preservedPre = Array.isArray(hooksObj.PreToolUse)
    ? hooksObj.PreToolUse.filter((entry) => !isCtxtopClaudeEntry(entry))
    : [];
  const preservedPost = Array.isArray(hooksObj.PostToolUse)
    ? hooksObj.PostToolUse.filter((entry) => !isCtxtopClaudeEntry(entry))
    : [];

  if (mode === 'enable') {
    hooksObj.PreToolUse = [
      ...preservedPre,
      {
        matcher: 'Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|Task|Agent|WebFetch|mcp__.*',
        hooks: [{ type: 'command', command: preCmd }]
      }
    ];
    hooksObj.PostToolUse = [
      ...preservedPost,
      {
        matcher: 'Bash|PowerShell|Grep|Glob|Task|Agent|WebFetch|mcp__.*',
        hooks: [{ type: 'command', command: postCmd }]
      }
    ];
    doc.hooks = hooksObj;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    atomicWriteFileSync(settingsFile, `${JSON.stringify(doc, null, 2)}\n`);
  } else if (fs.existsSync(settingsFile)) {
    if (preservedPre.length > 0) hooksObj.PreToolUse = preservedPre;
    else delete hooksObj.PreToolUse;
    if (preservedPost.length > 0) hooksObj.PostToolUse = preservedPost;
    else delete hooksObj.PostToolUse;
    doc.hooks = hooksObj;
    atomicWriteFileSync(settingsFile, `${JSON.stringify(doc, null, 2)}\n`);
  }

  return { settingsPath: settingsFile, document: doc };
}

/**
 * Runs a deterministic synthetic self-test verifying indexer + read-guard behavior (`< 50ms`).
 *
 * @returns {{ ok: boolean, elapsedMs: number, detail: string }}
 */
export function runShieldSelfTest() {
  const start = performance.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-shield-selftest-'));
  try {
    const sampleFile = path.join(tmpDir, 'large_fixture.mjs');
    const body = Array.from(
      { length: 1250 },
      (_, idx) =>
        idx % 250 === 0
          ? `export function sectionHandler_${idx}(requestContext) { return requestContext; }`
          : `  const stepMetric_${idx} = ${idx};`
    ).join('\n');
    fs.writeFileSync(sampleFile, body, 'utf8');

    const denied = evaluateShieldReadGuard({
      platform: 'claude',
      sessionId: 'selftest',
      cwd: tmpDir,
      filePath: sampleFile,
      hasSliceBounds: false,
      forceActive: true,
      recordLedger: false
    });
    const allowedSliced = evaluateShieldReadGuard({
      platform: 'claude',
      sessionId: 'selftest',
      cwd: tmpDir,
      filePath: sampleFile,
      hasSliceBounds: true,
      forceActive: true,
      recordLedger: false
    });

    const elapsedMs = Number((performance.now() - start).toFixed(2));
    const ok =
      denied.action === 'deny' &&
      Boolean(denied.indexPath && fs.existsSync(denied.indexPath)) &&
      allowedSliced.action === 'allow';
    return {
      ok,
      elapsedMs,
      detail: ok
        ? `Self-test passed in ${elapsedMs}ms (1,250-line un-sliced read blocked + .index.md generated; sliced read allowed)`
        : `Self-test failed (denied=${denied.action}, sliced=${allowedSliced.action})`
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race
    }
  }
}

/**
 * Aggregates Active Context Shield status and unified Session ROI metrics from
 * `savedQuotaLedger.mjs` (`horizon_ledger.jsonl`) and `.agents/telemetry/*.hints.jsonl`.
 *
 * @param {object} [options={}]
 */
export function getShieldStatus(options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const cfg = loadShieldConfig({ ...options, cwd: baseCwd });
  const agHooksPath = path.join(baseCwd, '.agents', 'hooks.json');
  const claudeSettingsPath = path.join(baseCwd, '.claude', 'settings.json');

  let agConfigured = false;
  if (fs.existsSync(agHooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(agHooksPath, 'utf8'));
      agConfigured = Boolean(parsed?.['ctxtop-read-guard']);
    } catch {
      agConfigured = false;
    }
  }

  let claudeConfigured = false;
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      const preArr = parsed?.hooks?.PreToolUse;
      claudeConfigured = Array.isArray(preArr) && preArr.some((e) => isCtxtopClaudeEntry(e));
    } catch {
      claudeConfigured = false;
    }
  }

  const ledgerSummary = getSavedQuotaReceiptSummary({
    cwd: baseCwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {})
  });

  let readsBlocked = 0;
  let logsCompacted = 0;
  let thrashStopped = 0;
  let hintTokensSaved = 0;
  let hintDollarsSaved = 0;

  const telemetryDir = path.join(baseCwd, '.agents', 'telemetry');
  if (fs.existsSync(telemetryDir)) {
    try {
      for (const name of fs.readdirSync(telemetryDir)) {
        if (!name.endsWith('.hints.jsonl')) continue;
        const lines = fs
          .readFileSync(path.join(telemetryDir, name), 'utf8')
          .split(/\r?\n/)
          .filter(Boolean);
        for (const line of lines) {
          try {
            const row = JSON.parse(line);
            if (row.event === 'blocked_unsliced_read') readsBlocked += 1;
            else if (row.event === 'truncated_tail_output') logsCompacted += 1;
            else if (row.event === 'thrash_3x_breaker') thrashStopped += 1;
            hintTokensSaved += Math.max(0, Number(row.tokens_saved_est || 0));
            hintDollarsSaved += Math.max(0, Number(row.dollars_saved_est || 0));
          } catch {
            // Skip malformed hint row
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const tokensSaved = Math.max(
    Number(ledgerSummary.workspace30dSavedTokens || 0),
    hintTokensSaved
  );
  const dollarsSaved = Number(
    Math.max(Number(ledgerSummary.workspace30dSavedUSD || 0), hintDollarsSaved).toFixed(4)
  );

  return {
    enabled: cfg.enabled,
    platforms: cfg.platforms,
    maxUnslicedLines: cfg.maxUnslicedLines,
    cliffMaxUnslicedLines: cfg.cliffMaxUnslicedLines,
    configPath: cfg.configPath,
    hooksConfigured: {
      antigravity: agConfigured,
      claude: claudeConfigured
    },
    roi: {
      tokensSaved,
      dollarsSaved,
      readsBlocked,
      logsCompacted,
      thrashStopped
    }
  };
}

/**
 * Executes `ctxtop shield <--enable | --disable | --status> [--platform all|antigravity|claude]`.
 *
 * @param {object} [options={}]
 * @param {'enable' | 'disable' | 'status'} [options.action='status']
 * @param {'all' | 'antigravity' | 'claude'} [options.platform='all']
 * @param {string} [options.cwd]
 * @param {number} [options.maxUnslicedLines]
 */
export function configureShield(options = {}) {
  const action = String(options.action || 'status').toLowerCase();
  const platform = String(options.platform || 'all').toLowerCase();
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const pkgRoot = options.pkgRoot || PKG_ROOT;

  if (action === 'status') {
    return {
      ok: true,
      action: 'status',
      platform,
      ...getShieldStatus({ ...options, cwd: baseCwd })
    };
  }

  const targetAg = platform === 'all' || platform === 'antigravity';
  const targetClaude = platform === 'all' || platform === 'claude';
  const current = loadShieldConfig({ ...options, cwd: baseCwd });

  if (action === 'enable') {
    ensureLocalGitExclude(baseCwd);
    const nextPlatforms = {
      antigravity: targetAg ? true : current.platforms.antigravity,
      claude: targetClaude ? true : current.platforms.claude
    };
    saveShieldConfig(
      {
        enabled: true,
        platforms: nextPlatforms,
        ...(options.maxUnslicedLines ? { maxUnslicedLines: options.maxUnslicedLines } : {})
      },
      { ...options, cwd: baseCwd }
    );
    if (targetAg) {
      syncAntigravityShieldHooks({ mode: 'enable', cwd: baseCwd, pkgRoot });
    }
    if (targetClaude) {
      syncClaudeShieldHooks({ mode: 'enable', cwd: baseCwd, pkgRoot });
    }
    const selfTest = runShieldSelfTest();
    const status = getShieldStatus({ ...options, cwd: baseCwd });
    return {
      ok: selfTest.ok,
      action: 'enable',
      platform,
      selfTest,
      ...status
    };
  }

  if (action === 'disable') {
    const nextPlatforms = {
      antigravity: targetAg ? false : current.platforms.antigravity,
      claude: targetClaude ? false : current.platforms.claude
    };
    const stillEnabled = Boolean(nextPlatforms.antigravity || nextPlatforms.claude);
    saveShieldConfig(
      {
        enabled: stillEnabled,
        platforms: nextPlatforms
      },
      { ...options, cwd: baseCwd }
    );
    if (targetAg) {
      syncAntigravityShieldHooks({ mode: 'disable', cwd: baseCwd, pkgRoot });
    }
    if (targetClaude) {
      syncClaudeShieldHooks({ mode: 'disable', cwd: baseCwd, pkgRoot });
    }
    const status = getShieldStatus({ ...options, cwd: baseCwd });
    return {
      ok: true,
      action: 'disable',
      platform,
      ...status
    };
  }

  return {
    ok: false,
    action,
    reason: `Unknown shield action: ${action}`
  };
}
