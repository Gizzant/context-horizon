/**
 * @file src/core/shield_manager.mjs
 * Unified Active Context Shield Manager, Net-Positive Read Firewall (`>=1,200` lines default,
 * `150` lines near `100k`/`200k` pricing cliffs), Out-of-Band `.hints.jsonl` Telemetry,
 * and Non-Destructive Hook Merger (`ctxtop shield --enable | --disable | --status`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
export const DEFAULT_SHIELD_MAX_UNSLICED_BYTES = 16_384;
export const CLIFF_SHIELD_MAX_UNSLICED_BYTES = 6_144;
export const CLAMP_TARGET_BYTES = 6_144;
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
 *   maxUnslicedBytes: number,
 *   cliffMaxUnslicedBytes: number,
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
    maxUnslicedBytes: DEFAULT_SHIELD_MAX_UNSLICED_BYTES,
    cliffMaxUnslicedBytes: CLIFF_SHIELD_MAX_UNSLICED_BYTES,
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
    const maxBytes = Number(parsed.maxUnslicedBytes);
    const cliffBytes = Number(parsed.cliffMaxUnslicedBytes);
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
      maxUnslicedBytes:
        Number.isFinite(maxBytes) && maxBytes >= 2048
          ? Math.round(maxBytes)
          : DEFAULT_SHIELD_MAX_UNSLICED_BYTES,
      cliffMaxUnslicedBytes:
        Number.isFinite(cliffBytes) && cliffBytes >= 1024
          ? Math.round(cliffBytes)
          : CLIFF_SHIELD_MAX_UNSLICED_BYTES,
      updatedAt: parsed.updatedAt || null,
      configPath
    };
  } catch (err) {
    void err;
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
    maxUnslicedBytes:
      Number.isFinite(Number(partial.maxUnslicedBytes)) && Number(partial.maxUnslicedBytes) >= 2048
        ? Math.round(Number(partial.maxUnslicedBytes))
        : current.maxUnslicedBytes,
    cliffMaxUnslicedBytes:
      Number.isFinite(Number(partial.cliffMaxUnslicedBytes)) && Number(partial.cliffMaxUnslicedBytes) >= 1024
        ? Math.round(Number(partial.cliffMaxUnslicedBytes))
        : current.cliffMaxUnslicedBytes,
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
 * Appends a standardized `bucket_b_shadow_v1` telemetry record to `.agents/telemetry/<sessionId>.hints.jsonl`
 * (`0` stdout/stderr bytes, `0` prompt tokens, `0` cache-prefix mutations).
 *
 * @param {string} sessionId
 * @param {object} hint
 * @param {string} hint.guardrailId - e.g. `'#2_GREP_GLOB_FIREWALL'`
 * @param {'SHADOW' | 'COACH' | 'ENFORCE'} [hint.stage='SHADOW']
 * @param {'claude' | 'antigravity'} [hint.platform='claude']
 * @param {boolean} [hint.wouldTrigger=false]
 * @param {string} [hint.wouldDecision='allow']
 * @param {number} [hint.latencyMs=0]
 * @param {number} [hint.tokens_saved_est=0]
 * @param {number} [hint.dollars_saved_est=0]
 * @param {object} [hint.evidence={}]
 * @param {object} [options={}]
 * @returns {string}
 */
export function recordBucketBShadowHint(sessionId, hint = {}, options = {}) {
  const stage = String(hint.stage || 'SHADOW').toUpperCase();
  return appendShieldHint(
    sessionId,
    {
      schema: 'bucket_b_shadow_v1',
      event: 'bucket_b_shadow',
      guardrailId: String(hint.guardrailId || 'UNKNOWN'),
      stage: stage === 'COACH' || stage === 'ENFORCE' ? stage : 'SHADOW',
      platform: hint.platform === 'antigravity' ? 'antigravity' : 'claude',
      wouldTrigger: Boolean(hint.wouldTrigger),
      wouldDecision: String(hint.wouldDecision || 'allow'),
      latencyMs: Number(Math.max(0, Number(hint.latencyMs) || 0).toFixed(3)),
      tokens_saved_est: Math.max(0, Math.round(Number(hint.tokens_saved_est) || 0)),
      dollars_saved_est: Number(Math.max(0, Number(hint.dollars_saved_est) || 0).toFixed(6)),
      evidence: hint.evidence && typeof hint.evidence === 'object' ? hint.evidence : {}
    },
    options
  );
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
  const maxBytes = nearCliff
    ? (cfg.cliffMaxUnslicedBytes || CLIFF_SHIELD_MAX_UNSLICED_BYTES)
    : (cfg.maxUnslicedBytes || DEFAULT_SHIELD_MAX_UNSLICED_BYTES);

  let rawText;
  try {
    rawText = fs.readFileSync(absFile, 'utf8');
  } catch (readErr) {
    void readErr;
    return { action: 'allow' };
  }
  // Skip binary buffers with NUL bytes
  if (rawText.includes('\0')) {
    return { action: 'allow' };
  }

  const rawLines = rawText.length === 0 ? [] : rawText.replace(/\r\n/g, '\n').split('\n');
  const totalLines = rawLines.length;
  const exceedsLineCap = totalLines > maxLines;
  const exceedsByteCap = stat.size > maxBytes;
  if (!exceedsLineCap && !exceedsByteCap) {
    return { action: 'allow' };
  }

  const indexed = buildIndex(absFile, { cwd: baseCwd });
  if (!indexed.ok) {
    return { action: 'allow' };
  }

  const estFullTokens = Math.ceil(stat.size / 4);
  const savedTokens = Math.max(0, estFullTokens - indexed.indexTokens);
  if (!exceedsLineCap && savedTokens <= 200) {
    return { action: 'allow' };
  }
  const rates = resolveModelRates(modelId, Date.now(), 'standard', {
    totalPromptTokens: promptTok + estFullTokens
  });
  const savedUSD = Number(((savedTokens / 1_000_000) * Number(rates.inputPer1M || 3.0)).toFixed(6));

  const displayFile = !relFile.startsWith('..') && !path.isAbsolute(relFile) ? relFile : path.basename(absFile);
  const displayIndex = !indexed.relIndexPath.startsWith('..') ? indexed.relIndexPath : indexed.indexPath;
  const cliffTag = nearCliff
    ? ` (90% of ${(cliffTokens / 1000).toFixed(0)}k pricing cliff)`
    : '';
  const triggerReason = exceedsLineCap ? 'line_cap' : 'byte_width_cap';
  const capClause = exceedsLineCap
    ? `${totalLines} lines > ${maxLines}-line cap`
    : `${totalLines} lines / ${(stat.size / 1024).toFixed(1)} KB > ${(maxBytes / 1024).toFixed(0)} KB byte-width cap`;

  // On Claude Code, wide <=1200-line files clamp in-place via updatedInput instead of hard deny
  if (platformKey === 'claude' && !exceedsLineCap && exceedsByteCap && totalLines >= 20) {
    const targetBytes = nearCliff ? 3_072 : CLAMP_TARGET_BYTES;
    let accBytes = 0;
    let accLines = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      const lineBytes = Buffer.byteLength(rawLines[i], 'utf8') + 1;
      if (accLines > 0 && accBytes + lineBytes > targetBytes) break;
      accBytes += lineBytes;
      accLines += 1;
    }
    const clampLimit = Math.max(15, Math.min(150, accLines));
    if (clampLimit < Math.floor(totalLines * 0.8)) {
      const clampedBytes = Buffer.byteLength(rawLines.slice(0, clampLimit).join('\n'), 'utf8');
      const inlineIndexMap = String(indexed.markdown || '').trim().slice(0, 1600);
      const clampSavedTokens = Math.max(
        0,
        Math.ceil((stat.size - clampedBytes - inlineIndexMap.length) / 4)
      );
      if (clampSavedTokens > 200) {
        const clampSavedUSD = Number(
          ((clampSavedTokens / 1_000_000) * Number(rates.inputPer1M || 3.0)).toFixed(6)
        );
        const clampReason = `Highbeam Shield clamped wide unsliced Read of ${displayFile} (${capClause}${cliffTag}) to lines 1..${clampLimit} (~${(clampedBytes / 1024).toFixed(1)} KB; +${clampSavedTokens.toLocaleString('en-US')} tok saved, 0 extra turn). Structural map (${displayIndex}) — pass offset & limit to jump to another section:\n${inlineIndexMap}`;
        if (recordLedger) {
          recordInterventionSavings(
            {
              sessionId,
              category: 'BOUNDED_READ_ENFORCED',
              modelId,
              savedTokens: clampSavedTokens,
              savedUSD: clampSavedUSD,
              dedupeId: `shield_clamp:${sessionId}:${displayFile}:${indexed.sha256?.slice(0, 8) || totalLines}`,
              detail: `Clamped wide read of ${displayFile} (1..${clampLimit} of ${totalLines} lines)`
            },
            { cwd: baseCwd, ...(ledgerPath ? { ledgerPath } : {}) }
          );
          appendShieldHint(
            sessionId,
            {
              event: 'clamped_unsliced_read',
              platform: platformKey,
              file: displayFile,
              index_path: displayIndex,
              lines_at_read: totalLines,
              max_lines: maxLines,
              clamp_limit: clampLimit,
              bytes_at_read: stat.size,
              max_bytes: maxBytes,
              clamped_bytes: clampedBytes,
              trigger_reason: triggerReason,
              near_cliff: nearCliff,
              tokens_saved_est: clampSavedTokens,
              dollars_saved_est: clampSavedUSD
            },
            { cwd: baseCwd }
          );
        }
        return {
          action: 'clamp',
          detectorId: nearCliff ? 'DET-12' : 'DET-11',
          triggerReason,
          reason: clampReason,
          clampOffset: 1,
          clampLimit,
          indexPath: indexed.indexPath,
          relIndexPath: displayIndex,
          totalLines,
          maxLines,
          fileBytes: stat.size,
          maxBytes,
          clampedBytes,
          nearCliff,
          savedTokens: clampSavedTokens,
          savedUSD: clampSavedUSD
        };
      }
    }
  }

  const reason =
    platformKey === 'antigravity'
      ? `Highbeam Shield blocked un-sliced read of ${displayFile} (${capClause}${cliffTag}; +${savedTokens.toLocaleString('en-US')} tok saved). Structural map ready at ${displayIndex}: read ${displayIndex} first, then call read_file with StartLine and EndLine.`
      : `Highbeam Shield blocked un-sliced Read of ${displayFile} (${capClause}${cliffTag}; +${savedTokens.toLocaleString('en-US')} tok saved). Structural map ready at ${displayIndex}: call Read on ${displayIndex} first, then call Read on ${displayFile} with offset and limit.`;

  if (recordLedger) {
    recordInterventionSavings(
      {
        sessionId,
        category: 'BOUNDED_READ_ENFORCED',
        modelId,
        savedTokens,
        savedUSD,
        dedupeId: `shield_read:${sessionId}:${displayFile}:${indexed.sha256?.slice(0, 8) || totalLines}`,
        detail: `Blocked un-sliced read of ${displayFile} (${capClause} -> ${displayIndex})`
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
        bytes_at_read: stat.size,
        max_bytes: maxBytes,
        trigger_reason: triggerReason,
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
    triggerReason,
    reason,
    indexPath: indexed.indexPath,
    relIndexPath: displayIndex,
    totalLines,
    maxLines,
    fileBytes: stat.size,
    maxBytes,
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
  let shadowHits = 0;
  let shadowTokensSavedEst = 0;
  let shadowDollarsSavedEst = 0;
  const shadowByGuardrail = {};
  let coachHits = 0;
  let coachTokensSaved = 0;
  let coachDollarsSaved = 0;
  const coachByGuardrail = {};

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
            if (row.schema === 'bucket_b_shadow_v1') {
              if (row.wouldTrigger) {
                const gid = String(row.guardrailId || 'UNKNOWN');
                const tokEst = Math.max(0, Number(row.tokens_saved_est || 0));
                const usdEst = Math.max(0, Number(row.dollars_saved_est || 0));
                if (row.stage === 'COACH' || row.stage === 'ENFORCE') {
                  coachHits += 1;
                  coachByGuardrail[gid] = (coachByGuardrail[gid] || 0) + 1;
                  coachTokensSaved += tokEst;
                  coachDollarsSaved += usdEst;
                  hintTokensSaved += tokEst;
                  hintDollarsSaved += usdEst;
                } else {
                  shadowHits += 1;
                  shadowByGuardrail[gid] = (shadowByGuardrail[gid] || 0) + 1;
                  shadowTokensSavedEst += tokEst;
                  shadowDollarsSavedEst += usdEst;
                }
              }
              continue;
            }
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
      thrashStopped,
      bucketBCoach: {
        hits: coachHits,
        tokensSaved: Math.round(coachTokensSaved),
        dollarsSaved: Number(coachDollarsSaved.toFixed(4)),
        byGuardrail: coachByGuardrail
      },
      bucketBShadow: {
        hits: shadowHits,
        tokensSavedEst: Math.round(shadowTokensSavedEst),
        dollarsSavedEst: Number(shadowDollarsSavedEst.toFixed(4)),
        byGuardrail: shadowByGuardrail
      }
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
      if (options.syncIdleDrain !== false) {
        syncClaudeIdleDrainSettings({ cwd: baseCwd });
      }
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

/**
 * Non-destructively merges idle token-drain protections into `.claude/settings.local.json`:
 *   - `env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES = "0"`
 *   - `crossSessionInbound = "hold"`
 *   - `idleCompaction = false`
 *
 * @param {object} [options={}]
 */
export function syncClaudeIdleDrainSettings(options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const localSettingsPath = path.join(baseCwd, '.claude', 'settings.local.json');
  let existing = {};
  if (fs.existsSync(localSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      existing = {};
    }
  }
  const envObj =
    existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
      ? { ...existing.env }
      : {};
  if (envObj.CLAUDE_CODE_GOAL_CHECKIN_MINUTES === undefined) {
    envObj.CLAUDE_CODE_GOAL_CHECKIN_MINUTES = '0';
  }
  const next = {
    ...existing,
    env: envObj,
    crossSessionInbound:
      existing.crossSessionInbound !== undefined ? existing.crossSessionInbound : 'hold',
    idleCompaction:
      typeof existing.idleCompaction === 'boolean' ? existing.idleCompaction : false
  };
  fs.mkdirSync(path.dirname(localSettingsPath), { recursive: true });
  atomicWriteFileSync(localSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    updated: true,
    settingsLocalPath: localSettingsPath,
    settings: next
  };
}

/**
 * Audits `.claude/settings.local.json` (and `.claude/settings.json`) for idle-drain exposure.
 * Only triggers an advisory when `.claude/settings.local.json` (or explicit settings) contains
 * an enabled idle check-in / auto-inbound / idleCompaction drain, or when `requireExplicitGuard` is true.
 *
 * @param {object} [options={}]
 */
export function auditClaudeIdleDrainSettings(options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const localPath = path.join(baseCwd, '.claude', 'settings.local.json');
  const sharedPath = path.join(baseCwd, '.claude', 'settings.json');
  const readSafe = (p) => {
    if (!fs.existsSync(p)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };
  const local = readSafe(localPath);
  const shared = readSafe(sharedPath);
  if (!local && !shared && !options.requireExplicitGuard) {
    return { triggered: false, issues: [], advisory: null };
  }
  const merged = { ...(shared || {}), ...(local || {}) };
  const mergedEnv = { ...(shared?.env || {}), ...(local?.env || {}) };
  const issues = [];

  const checkinRaw = mergedEnv.CLAUDE_CODE_GOAL_CHECKIN_MINUTES;
  if (checkinRaw !== undefined && String(checkinRaw) !== '0') {
    issues.push(`CLAUDE_CODE_GOAL_CHECKIN_MINUTES=${checkinRaw} (set "0" to stop idle goal check-ins)`);
  } else if (options.requireExplicitGuard && checkinRaw === undefined) {
    issues.push('CLAUDE_CODE_GOAL_CHECKIN_MINUTES unset (recommend "0")');
  }

  if (merged.crossSessionInbound && merged.crossSessionInbound !== 'hold') {
    issues.push(`crossSessionInbound="${merged.crossSessionInbound}" (set "hold" to prevent idle cache wakeups)`);
  } else if (options.requireExplicitGuard && merged.crossSessionInbound === undefined) {
    issues.push('crossSessionInbound unset (recommend "hold")');
  }

  if (merged.idleCompaction === true) {
    issues.push('idleCompaction=true (set false to avoid background summarization burn)');
  } else if (options.requireExplicitGuard && merged.idleCompaction === undefined) {
    issues.push('idleCompaction unset (recommend false)');
  }

  if (issues.length === 0) {
    return { triggered: false, issues: [], advisory: null };
  }
  return {
    triggered: true,
    issues,
    advisory:
      `[Highbeam Quota Shield — Idle Drain Guard (#10)] ${issues.join('; ')}. ` +
      `Run "npx highbeam-cli shield --enable" to lock .claude/settings.local.json against background token drain.`
  };
}

/**
 * Audits `.claude/agents/*.md` YAML frontmatter for missing or unsafe `autoCompactWindow` caps
 * (`<= 90000` on Haiku subagents, `<= 180000` on Sonnet/Opus/Gemini Pro subagents).
 *
 * @param {object} [options={}]
 */
export function auditClaudeAgentAutoCompactWindows(options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const agentsDir = path.join(baseCwd, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) {
    return { triggered: false, unguardedAgents: [], advisory: null };
  }
  const unguardedAgents = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const fullPath = path.join(agentsDir, entry.name);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fm = fmMatch ? fmMatch[1] : '';
      const modelMatch = fm.match(/^\s*model\s*:\s*([^\r\n#]+)/im);
      const windowMatch = fm.match(/^\s*autoCompactWindow\s*:\s*(\d+)/im);
      const modelStr = modelMatch ? modelMatch[1].trim().replace(/^['"]|['"]$/g, '') : '';
      const isHaiku = /haiku/i.test(modelStr);
      const recommendedMax = isHaiku ? 90000 : 180000;
      const configuredWindow = windowMatch ? Number(windowMatch[1]) : null;
      if (configuredWindow === null || configuredWindow > recommendedMax) {
        unguardedAgents.push({
          file: `.claude/agents/${entry.name}`,
          model: modelStr || 'inherit',
          configuredWindow,
          recommendedMax
        });
      }
    }
  } catch {
    return { triggered: false, unguardedAgents: [], advisory: null };
  }

  if (unguardedAgents.length === 0) {
    return { triggered: false, unguardedAgents: [], advisory: null };
  }
  const summary = unguardedAgents
    .slice(0, 4)
    .map(
      (a) =>
        `${a.file} (${a.configuredWindow === null ? 'missing' : a.configuredWindow} -> <=${a.recommendedMax})`
    )
    .join(', ');
  return {
    triggered: true,
    unguardedAgents,
    advisory:
      `[Highbeam Quota Shield — Pricing Cliff Cap (#7)] Subagent frontmatter missing safe autoCompactWindow: ${summary}. ` +
      `Pin autoCompactWindow: 90000 (Haiku 100K 5x cliff) or 180000 (200K 2x cliff) to prevent cliff overruns.`
  };
}

/**
 * Item A2 (#3): Records a fast (<12ms) SHA-256 + assertion/skip count baseline of workspace test files
 * at `SessionStart` into `.agents/telemetry/<sessionId>.test_hashes.json`.
 * Strictly skips `packages/airlock/`, `node_modules/`, `.git/`, `.agents/`, and `.claude/`.
 *
 * @param {object} [options={}]
 */
export function snapshotWorkspaceTestHashes(options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const sessionId = String(options.sessionId || 'default')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  const maxFiles = Math.max(1, Number(options.maxFiles || 400));
  const deadlineMs = Date.now() + Number(options.budgetMs || 18);
  const skipDirs = new Set([
    '.git',
    'node_modules',
    '.agents',
    '.claude',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    'airlock'
  ]);
  const files = {};
  let scannedCount = 0;

  const isTestName = (relPosix) =>
    /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs)$/i.test(relPosix) ||
    /(?:^|\/)(?:test|tests|__tests__)\/.*\.(?:[cm]?[jt]sx?|py|go|rs)$/i.test(relPosix) ||
    /_test\.(?:py|go)$/i.test(relPosix);

  const walk = (dir, depth) => {
    if (depth > 4 || scannedCount >= maxFiles || Date.now() > deadlineMs) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scannedCount >= maxFiles || Date.now() > deadlineMs) break;
      const fullPath = path.join(dir, entry.name);
      const relPosix = path.relative(baseCwd, fullPath).replace(/\\/g, '/');
      if (relPosix === 'packages/airlock' || relPosix.startsWith('packages/airlock/')) continue;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && isTestName(relPosix)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 512 * 1024) continue;
          const raw = fs.readFileSync(fullPath, 'utf8');
          const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
          const assertionCount =
            (raw.match(/\b(?:assert(?:\.[a-zA-Z0-9_]+)?\s*\(|expect\s*\(|should\.|assert_eq!\s*\()/g) || []).length +
            (raw.match(/^\s*assert\s+\S+/gm) || []).length;
          const skipCount =
            (raw.match(/(?:\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip(?:if)?\b|#\[\s*ignore\b)/g) || []).length;
          files[relPosix] = {
            sha256,
            assertionCount,
            skipCount,
            bytes: stat.size
          };
          scannedCount += 1;
        } catch {
          // Skip unreadable file
        }
      }
    }
  };

  walk(baseCwd, 0);
  const outPath = path.join(baseCwd, '.agents', 'telemetry', `${sessionId}.test_hashes.json`);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    atomicWriteFileSync(
      outPath,
      `${JSON.stringify(
        {
          schemaVersion: '2026.11.1',
          sessionId,
          recordedAt: new Date().toISOString(),
          fileCount: scannedCount,
          files
        },
        null,
        2
      )}\n`
    );
  } catch {
    // Non-fatal on read-only FS
  }

  return {
    snapshotPath: outPath,
    fileCount: scannedCount,
    files
  };
}

/**
 * Item A5 (#15): Audits Claude Code `MEMORY.md` (`>200` lines or `>25,600` bytes `25KB` silent host truncation cap).
 *
 * @param {object} [options={}]
 */
export function auditClaudeAutoMemory(options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const homeDir = options.homeDir || os.homedir();
  const candidates = [];

  if (options.memoryFilePath) {
    candidates.push(path.resolve(options.memoryFilePath));
  }
  if (options.memoryDir) {
    candidates.push(path.join(path.resolve(options.memoryDir), 'MEMORY.md'));
  }
  candidates.push(path.join(baseCwd, '.claude', 'memory', 'MEMORY.md'));

  // Resolve `~/.claude/projects/<projectSlug>/memory/MEMORY.md`
  const slugVariants = new Set([
    baseCwd.replace(/[:\\/]+/g, '-').replace(/^-+/, ''),
    `-${baseCwd.replace(/[:\\/]+/g, '-').replace(/^-+/, '')}`
  ]);
  for (const slug of slugVariants) {
    candidates.push(path.join(homeDir, '.claude', 'projects', slug, 'memory', 'MEMORY.md'));
  }

  const seen = new Set();
  const issues = [];
  let maxLines = 0;
  let maxBytes = 0;
  let inspectedPath = null;

  for (const memPath of candidates) {
    const norm = memPath.replace(/\\/g, '/').toLowerCase();
    if (seen.has(norm) || !fs.existsSync(memPath)) continue;
    seen.add(norm);
    try {
      const buf = fs.readFileSync(memPath);
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/).length;
      const bytes = buf.byteLength;
      inspectedPath = memPath;
      if (lines > maxLines) maxLines = lines;
      if (bytes > maxBytes) maxBytes = bytes;
      if (lines > 200 || bytes > 25600) {
        issues.push(
          `MEMORY.md (${lines} lines, ${(bytes / 1024).toFixed(1)}KB) exceeds Claude Code's 200-line / 25KB (25,600B) auto-memory cap — trailing lines are silently truncated`
        );
      }
    } catch {
      // Ignore unreadable candidate
    }
  }

  if (issues.length === 0) {
    return { triggered: false, inspectedPath, maxLines, maxBytes, issues: [], advisory: null };
  }

  return {
    triggered: true,
    inspectedPath,
    maxLines,
    maxBytes,
    issues,
    advisory:
      `[Highbeam Quota Shield — Auto-Memory Truncation Guard (#15)] ${issues.join('; ')}. ` +
      `Move detailed notes into topic files under memory/<topic>.md and keep MEMORY.md <= 200 lines / <= 25KB.`
  };
}

/**
 * Item A8 (#14): Multimodal `.ipynb` Base64 Stripper & Unbounded `>10`-Page `.pdf` Read Blocker.
 *
 * - For `.ipynb`: If file > 256KB or contains `image/png` / `image/jpeg` / `image/webp` base64 blobs > 16KB,
 *   writes a sanitized copy (with code/markdown/text preserved and base64 images stripped) to
 *   `.claude/cache/sanitized_<name>.ipynb` (Claude `updatedInput` rewrite) or `.agents/tmp/sanitized_<name>.ipynb` (Antigravity).
 * - For `.pdf`: Counts `/Type /Page` objects; blocks un-paged reads (or ranges > 10 pages) when `pageCount > 10`.
 *
 * @param {object} [options={}]
 */
export function inspectAndSanitizeMultimodalRead(options = {}) {
  const platform = String(options.platform || 'claude').toLowerCase();
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const rawFilePath = String(options.filePath || '').trim();
  if (!rawFilePath) return { action: 'allow' };

  const resolved = path.isAbsolute(rawFilePath)
    ? rawFilePath
    : path.resolve(baseCwd, rawFilePath);
  const relCheck = path.relative(baseCwd, resolved).replace(/\\/g, '/');
  if (relCheck === 'packages/airlock' || relCheck.startsWith('packages/airlock/')) {
    return { action: 'allow' };
  }

  const normLower = resolved.replace(/\\/g, '/').toLowerCase();
  // Never re-intercept an already sanitized notebook!
  if (
    normLower.includes('/.claude/cache/sanitized_') ||
    normLower.includes('/.agents/tmp/sanitized_')
  ) {
    return { action: 'allow' };
  }

  if (!/\.ipynb$|\.pdf$/i.test(normLower) || !fs.existsSync(resolved)) {
    return { action: 'allow' };
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
    if (!stat.isFile()) return { action: 'allow' };
  } catch {
    return { action: 'allow' };
  }

  if (normLower.endsWith('.pdf')) {
    let pageSpan = null;
    if (options.pages !== undefined && options.pages !== null && String(options.pages).trim() !== '') {
      const pagesStr = String(options.pages).trim();
      const rangeMatch = pagesStr.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        pageSpan = Math.abs(Number(rangeMatch[2]) - Number(rangeMatch[1])) + 1;
      } else if (/^\d+$/.test(pagesStr)) {
        pageSpan = 1;
      }
    } else if (options.hasPageBounds) {
      pageSpan = 10;
    }

    try {
      const maxReadBytes = Math.min(stat.size, 16 * 1024 * 1024);
      const fd = fs.openSync(resolved, 'r');
      const buf = Buffer.allocUnsafe(maxReadBytes);
      fs.readSync(fd, buf, 0, maxReadBytes, 0);
      fs.closeSync(fd);
      const latin = buf.toString('latin1');
      const pageMatches = latin.match(/\/Type\s*\/Page\b(?!s)/g) || [];
      const pageCount = pageMatches.length;

      if (pageCount > 10 && (pageSpan === null || pageSpan > 10)) {
        const savedTokens = Math.max(1500, (pageCount - 10) * 1500);
        return {
          action: 'deny',
          detectorId: 'DET-07',
          subType: 'UNPAGED_PDF_BLOCKED',
          pageCount,
          savedTokens,
          reason:
            `[DET-07 Multimodal PDF Guard (#14)] Unbounded read of ${pageCount}-page PDF "${path.basename(resolved)}" (>10-page cap). ` +
            `Pass an explicit <=10-page slice (e.g. pages: "1-10") to prevent ~${savedTokens.toLocaleString()} multimodal tokens of bloat.`
        };
      }
    } catch {
      return { action: 'allow' };
    }
    return { action: 'allow' };
  }

  // `.ipynb` Notebook Base64 Image Sanitizer
  if (normLower.endsWith('.ipynb')) {
    try {
      const rawText = fs.readFileSync(resolved, 'utf8');
      const nb = JSON.parse(rawText);
      const cells = Array.isArray(nb?.cells) ? nb.cells : [];
      let strippedImages = 0;
      let strippedBytes = 0;

      for (const cell of cells) {
        if (!cell || !Array.isArray(cell.outputs)) continue;
        for (const out of cell.outputs) {
          if (!out || !out.data || typeof out.data !== 'object') continue;
          for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']) {
            const val = out.data[mime];
            if (!val) continue;
            const joined = Array.isArray(val) ? val.join('') : String(val);
            if (joined.length > 16384 || stat.size > 262144) {
              strippedImages += 1;
              strippedBytes += joined.length;
              delete out.data[mime];
              if (!out.data['text/plain']) {
                out.data['text/plain'] = [
                  `[Highbeam Sanitized (#14): ${mime} base64 payload (${(joined.length / 1024).toFixed(1)} KB) stripped]`
                ];
              }
            }
          }
        }
      }

      if (strippedImages === 0 && stat.size <= 262144) {
        return { action: 'allow' };
      }

      // If >256KB even without images, truncate oversized stream outputs >16KB per cell
      if (strippedImages === 0 && stat.size > 262144) {
        for (const cell of cells) {
          if (!cell || !Array.isArray(cell.outputs)) continue;
          for (const out of cell.outputs) {
            if (out && out.text) {
              const txt = Array.isArray(out.text) ? out.text.join('') : String(out.text);
              if (txt.length > 16384) {
                strippedBytes += txt.length - 4096;
                out.text = [
                  `${txt.slice(0, 2048)}\n...[Highbeam Sanitized (#14): ${(txt.length / 1024).toFixed(1)} KB notebook output truncated]...\n${txt.slice(-2048)}`
                ];
              }
            }
          }
        }
      }

      if (strippedImages === 0 && strippedBytes === 0) {
        return { action: 'allow' };
      }

      const safeBase = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, '_');
      const cacheSubdir =
        platform === 'claude'
          ? path.join(baseCwd, '.claude', 'cache')
          : path.join(baseCwd, '.agents', 'tmp');
      fs.mkdirSync(cacheSubdir, { recursive: true });
      const sanitizedPath = path.join(cacheSubdir, `sanitized_${safeBase}`);
      const sanitizedJson = `${JSON.stringify(nb, null, 1)}\n`;
      atomicWriteFileSync(sanitizedPath, sanitizedJson);
      const savedTokens = Math.max(100, Math.ceil(strippedBytes / 4));

      return {
        action: platform === 'claude' ? 'rewrite' : 'deny',
        detectorId: 'DET-07',
        subType: 'IPYNB_BASE64_SANITIZED',
        sanitizedPath,
        strippedImages,
        strippedBytes,
        savedTokens,
        reason:
          `[Highbeam Multimodal Notebook Sanitizer (#14)] Stripped ${strippedImages} embedded base64 image(s) ` +
          `(${(strippedBytes / 1024).toFixed(1)} KB, ~${savedTokens.toLocaleString()} tokens saved; source "${path.basename(resolved)}" -> "${sanitizedPath}").`
      };
    } catch {
      return { action: 'allow' };
    }
  }

  return { action: 'allow' };
}
