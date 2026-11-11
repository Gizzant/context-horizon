import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getHomeDir } from './paths.mjs';
import { PrefixCacheShield } from './prefix_cache_shield.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';

/**
 * Phase 4: U-Shaped Attention, Recency Mirror & Rule Hygiene Optimizer
 *
 * Prevents instruction drift caused by U-shaped transformer attention curves and
 * Antigravity's 16.6k–30.7k native system prompt sandwich.
 */

export const U_CURVE_CONSTANTS = Object.freeze({
  PRIMACY_END_RATIO: 0.30,
  MIDDLE_TROUGH_START_RATIO: 0.30,
  MIDDLE_TROUGH_END_RATIO: 0.70,
  RECENCY_START_RATIO: 0.70,
  GEMINI_MD_MAX_LINES: 150,
  MEMORY_MD_MAX_LINES: 200,
  MEMORY_MD_MAX_BYTES: 25 * 1024, // 25 KB
  STALE_RULE_MAX_AGE_DAYS: 180,
  STALE_RULE_MAX_AGE_MS: 180 * 24 * 60 * 60 * 1000,
  NATIVE_SYSTEM_HEADER_EST_TOKENS: 20000,
  RECENCY_MIRROR_MAX_INVARIANTS: 5,
  CRITICAL_KEYWORD_REGEX: /\b(NEVER|ALWAYS|MUST|CRITICAL|NON-NEGOTIABLE)\b/i
});

export function getDefaultArchivedRulesPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'archived_rules.md');
}

/**
 * Computes positional attention recall weight for a relative position ratio p in [0, 1].
 *  - Primacy Band (0.00 - 0.30): 0.90 .. 1.00
 *  - Middle Attention Trough (0.30 - 0.70): 0.55 .. 0.70 (lowest at p = 0.50 -> 0.55)
 *  - Recency Band (0.70 - 1.00): 0.88 .. 0.98
 */
export function computePositionalRecallWeight(positionRatio = 0) {
  const p = Math.max(0, Math.min(1, Number(positionRatio) || 0));
  if (p < U_CURVE_CONSTANTS.PRIMACY_END_RATIO) {
    const t = p / U_CURVE_CONSTANTS.PRIMACY_END_RATIO;
    return Number((1.00 - t * 0.10).toFixed(4));
  }
  if (p < U_CURVE_CONSTANTS.MIDDLE_TROUGH_END_RATIO) {
    const distFromCenter = Math.abs(p - 0.50) / 0.20; // 0 at center (0.50), 1 at edges (0.30, 0.70)
    return Number((0.55 + distFromCenter * 0.15).toFixed(4));
  }
  const t = (p - U_CURVE_CONSTANTS.RECENCY_START_RATIO) / (1 - U_CURVE_CONSTANTS.RECENCY_START_RATIO);
  return Number((0.88 + t * 0.10).toFixed(4));
}

export function classifyPositionalBand(positionRatio = 0) {
  const p = Math.max(0, Math.min(1, Number(positionRatio) || 0));
  if (p < U_CURVE_CONSTANTS.PRIMACY_END_RATIO) return 'PRIMACY';
  if (p < U_CURVE_CONSTANTS.MIDDLE_TROUGH_END_RATIO) return 'MIDDLE_TROUGH';
  return 'RECENCY';
}

export function isCriticalDirectiveLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('<!--')) return false;
  return U_CURVE_CONSTANTS.CRITICAL_KEYWORD_REGEX.test(trimmed);
}

/**
 * Scores directive priority for the top-5 Recency Anchor Mirror.
 * Prioritizes NEVER and NON-NEGOTIABLE highest, followed by MUST, CRITICAL, ALWAYS.
 */
export function scoreDirectivePriority(line = '') {
  const text = String(line || '').trim();
  let score = 0;
  if (/\bNON-NEGOTIABLE\b/i.test(text)) score += 50;
  if (/\bNEVER\b/i.test(text)) score += 45;
  if (/\bMUST\b/i.test(text)) score += 35;
  if (/\bCRITICAL\b/i.test(text)) score += 30;
  if (/\bALWAYS\b/i.test(text)) score += 25;
  if (/^[-*+]\s+\*\*\[?/.test(text) || /^[-*+]\s+\*\*/.test(text)) score += 10;
  return score;
}

/**
 * Parses inline staleness metadata or git blame timestamps to detect rules older than 180 days.
 * Supports inline tags such as `(last_verified: 2025-01-15)`, `[verified: 2025-01-15]`,
 * `[updated: 2025-01-15]`, or `<!-- date: 2025-01-15 -->`.
 */
export function extractLineTimestampMs(line = '', lineNumber = 1, gitBlameMap = null) {
  const text = String(line || '');
  const dateMatch = text.match(
    /(?:last_verified_at|last_verified|verified|updated|date|touched)\s*[:=]\s*(\d{4}-\d{2}-\d{2})/i
  ) || text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);

  if (dateMatch) {
    const parsed = Date.parse(`${dateMatch[1]}T00:00:00Z`);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (gitBlameMap && gitBlameMap.has(lineNumber)) {
    return gitBlameMap.get(lineNumber);
  }
  return null;
}

function getGitBlameLineTimestamps(filePath) {
  const map = new Map();
  if (!filePath || !fs.existsSync(filePath)) return map;
  try {
    const cwd = path.dirname(filePath);
    const out = execFileSync('git', ['blame', '--line-porcelain', path.basename(filePath)], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    });
    let currentLine = 0;
    for (const rawLine of out.split(/\r?\n/)) {
      const headerMatch = rawLine.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)/);
      if (headerMatch) {
        currentLine = Number(headerMatch[1]);
      } else if (rawLine.startsWith('committer-time ') && currentLine > 0) {
        const sec = Number(rawLine.slice('committer-time '.length).trim());
        if (Number.isFinite(sec) && sec > 0) {
          map.set(currentLine, sec * 1000);
        }
      }
    }
  } catch {}
  return map;
}

/**
 * Estimates MCP schema token overhead from ~/.gemini/config/mcp_config.json
 */
export function estimateCompositeSystemOverhead(homeDir = getHomeDir()) {
  const mcpConfigPath = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  let mcpSchemaTokens = 0;
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const stat = fs.statSync(mcpConfigPath);
      mcpSchemaTokens = Math.round(stat.size / 4) + 2500;
    } catch {}
  }
  return {
    nativeHeaderTokens: U_CURVE_CONSTANTS.NATIVE_SYSTEM_HEADER_EST_TOKENS,
    mcpSchemaTokens,
    totalSystemOverheadTokens: U_CURVE_CONSTANTS.NATIVE_SYSTEM_HEADER_EST_TOKENS + mcpSchemaTokens
  };
}

/**
 * Analyzes an instruction file's text (or file path) for U-shaped attention vulnerabilities.
 */
export function analyzeRuleFileAttention(input, options = {}) {
  let content = '';
  let filePath = options.filePath || null;

  if (typeof input === 'string' && !options.isRawText && fs.existsSync(input)) {
    filePath = path.resolve(input);
    content = fs.readFileSync(filePath, 'utf8');
  } else {
    content = String(input || '');
  }

  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const criticalDirectives = [];
  const middleTroughVulnerabilities = [];
  const primacyDirectives = [];
  const recencyDirectives = [];

  for (let i = 0; i < totalLines; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i];
    const positionRatio = totalLines > 1 ? i / (totalLines - 1) : 0;
    const band = classifyPositionalBand(positionRatio);
    const recallWeight = computePositionalRecallWeight(positionRatio);

    if (isCriticalDirectiveLine(rawLine)) {
      const matchedKeyword = (rawLine.match(U_CURVE_CONSTANTS.CRITICAL_KEYWORD_REGEX) || [])[1]?.toUpperCase() || 'CRITICAL';
      const item = {
        lineNumber,
        text: rawLine.trim(),
        keyword: matchedKeyword,
        positionRatio: Number(positionRatio.toFixed(4)),
        band,
        recallWeight,
        priorityScore: scoreDirectivePriority(rawLine)
      };
      criticalDirectives.push(item);
      if (band === 'MIDDLE_TROUGH') {
        middleTroughVulnerabilities.push(item);
      } else if (band === 'PRIMACY') {
        primacyDirectives.push(item);
      } else {
        recencyDirectives.push(item);
      }
    }
  }

  const avgCriticalRecall =
    criticalDirectives.length > 0
      ? criticalDirectives.reduce((sum, d) => sum + d.recallWeight, 0) / criticalDirectives.length
      : 0.95;

  // Vulnerability penalty for critical directives stranded in the 30-70% middle trough
  const troughRatio =
    criticalDirectives.length > 0
      ? middleTroughVulnerabilities.length / criticalDirectives.length
      : 0;

  const attentionHealthScore = Math.max(
    0,
    Math.min(100, Math.round(avgCriticalRecall * 100 - troughRatio * 25))
  );

  const primacyScorePct = Math.round(
    (primacyDirectives.length > 0
      ? primacyDirectives.reduce((s, d) => s + d.recallWeight, 0) / primacyDirectives.length
      : 0.94) * 100
  );

  return {
    filePath,
    totalLines,
    totalCriticalDirectives: criticalDirectives.length,
    middleTroughRiskCount: middleTroughVulnerabilities.length,
    middleTroughVulnerabilities,
    primacyDirectives,
    recencyDirectives,
    criticalDirectives,
    avgCriticalRecall: Number(avgCriticalRecall.toFixed(4)),
    primacyScorePct,
    attentionHealthScore,
    uiSummary: `Primacy: ${primacyScorePct}% | Middle Trough Risk: ${middleTroughVulnerabilities.length} critical rules`
  };
}

/**
 * Audits an instruction file (GEMINI.md, AGENTS.md, or MEMORY.md) for:
 *  - Line/byte budget violations (150 lines for GEMINI.md, 200 lines / 25 KB for MEMORY.md)
 *  - Duplicate directives
 *  - Contradictory directives (ALWAYS X vs NEVER/DO NOT X)
 *  - Stale entries (>180 days since last git touch or inline verification date)
 */
export function auditRuleFileHygiene(input, options = {}) {
  let content = '';
  let filePath = options.filePath || null;

  if (typeof input === 'string' && !options.isRawText && fs.existsSync(input)) {
    filePath = path.resolve(input);
    content = fs.readFileSync(filePath, 'utf8');
  } else {
    content = String(input || '');
  }

  const nowMs = typeof options.nowFn === 'function' ? options.nowFn() : Date.now();
  const isMemoryMd = filePath ? /MEMORY\.md$/i.test(filePath) : Boolean(options.isMemoryMd);
  const maxLines = isMemoryMd ? U_CURVE_CONSTANTS.MEMORY_MD_MAX_LINES : U_CURVE_CONSTANTS.GEMINI_MD_MAX_LINES;
  const maxBytes = isMemoryMd ? U_CURVE_CONSTANTS.MEMORY_MD_MAX_BYTES : 64 * 1024;

  const lines = content.split(/\r?\n/);
  const byteSize = Buffer.byteLength(content, 'utf8');
  const gitBlameMap = options.enableGitBlame && filePath ? getGitBlameLineTimestamps(filePath) : null;

  const seenNormalized = new Map();
  const duplicateLines = [];
  const staleLines = [];
  const positiveAssertions = new Map();
  const negativeAssertions = new Map();
  const contradictions = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;

    // 1. Check staleness (>180 days)
    const tsMs = extractLineTimestampMs(raw, lineNumber, gitBlameMap);
    if (tsMs !== null && nowMs - tsMs > U_CURVE_CONSTANTS.STALE_RULE_MAX_AGE_MS) {
      const ageDays = Math.floor((nowMs - tsMs) / (24 * 60 * 60 * 1000));
      staleLines.push({
        lineNumber,
        text: trimmed,
        ageDays
      });
    }

    // 2. Check duplicate directives
    const norm = trimmed
      .toLowerCase()
      .replace(/^[-*+\d.)\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (norm.length >= 12) {
      if (seenNormalized.has(norm)) {
        duplicateLines.push({
          lineNumber,
          firstLineNumber: seenNormalized.get(norm),
          text: trimmed
        });
      } else {
        seenNormalized.set(norm, lineNumber);
      }
    }

    // 3. Check contradictions (ALWAYS <target> vs NEVER/DO NOT <target>)
    const alwaysMatch = trimmed.match(/\b(?:ALWAYS|MUST)\s+(?:use\s+|enable\s+|run\s+)?([a-z0-9_./:-]{3,40})/i);
    if (alwaysMatch) {
      const subject = alwaysMatch[1].toLowerCase();
      positiveAssertions.set(subject, { lineNumber, text: trimmed });
      if (negativeAssertions.has(subject)) {
        contradictions.push({
          subject,
          positive: { lineNumber, text: trimmed },
          negative: negativeAssertions.get(subject)
        });
      }
    }

    const neverMatch = trimmed.match(/\b(?:NEVER|DO\s+NOT|DON'T)\s+(?:use\s+|enable\s+|run\s+)?([a-z0-9_./:-]{3,40})/i);
    if (neverMatch) {
      const subject = neverMatch[1].toLowerCase();
      negativeAssertions.set(subject, { lineNumber, text: trimmed });
      if (positiveAssertions.has(subject)) {
        contradictions.push({
          subject,
          positive: positiveAssertions.get(subject),
          negative: { lineNumber, text: trimmed }
        });
      }
    }
  }

  return {
    filePath,
    isMemoryMd,
    lineCount: lines.length,
    maxLines,
    overLineBudget: lines.length > maxLines,
    excessLines: Math.max(0, lines.length - maxLines),
    byteSize,
    maxBytes,
    overByteBudget: byteSize > maxBytes,
    staleLines,
    duplicateLines,
    contradictions
  };
}

/**
 * Reorders an instruction file for U-Shaped Attention while archiving >180-day stale lines
 * and deduplicating directives:
 *  - Primacy Band (Top 30%): Document title, core architectural overview & structural rules
 *  - Middle Band (30%-70%): Reference lookup tables, non-critical notes & examples
 *  - Recency Band (Bottom 30%): Hard NEVER / MUST / ALWAYS / CRITICAL / NON-NEGOTIABLE guardrails
 */
export function buildUShapedReorderedContent(rawContent = '', options = {}) {
  const nowMs = typeof options.nowFn === 'function' ? options.nowFn() : Date.now();
  const maxLines = Number.isFinite(options.maxLines)
    ? options.maxLines
    : U_CURVE_CONSTANTS.GEMINI_MD_MAX_LINES;

  const lines = String(rawContent || '').split(/\r?\n/);
  const primacyLines = [];
  const middleReferenceLines = [];
  const recencyCriticalLines = [];
  const archivedLines = [];
  const seenNormalized = new Set();

  let inCodeBlock = false;
  let currentSectionType = 'PRIMACY'; // 'PRIMACY' | 'MIDDLE'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      middleReferenceLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      middleReferenceLines.push(line);
      continue;
    }

    if (!trimmed) {
      continue;
    }

    // Check if >180 days stale
    const tsMs = extractLineTimestampMs(line, i + 1, null);
    if (tsMs !== null && nowMs - tsMs > U_CURVE_CONSTANTS.STALE_RULE_MAX_AGE_MS) {
      archivedLines.push({
        lineNumber: i + 1,
        text: trimmed,
        reason: 'STALE_OVER_180_DAYS'
      });
      continue;
    }

    // Deduplicate bullet rules
    const norm = trimmed
      .toLowerCase()
      .replace(/^[-*+\d.)\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!trimmed.startsWith('#') && !trimmed.startsWith('|') && norm.length >= 12) {
      if (seenNormalized.has(norm)) {
        archivedLines.push({
          lineNumber: i + 1,
          text: trimmed,
          reason: 'DUPLICATE_DIRECTIVE'
        });
        continue;
      }
      seenNormalized.add(norm);
    }

    // Critical NEVER/MUST/ALWAYS/CRITICAL/NON-NEGOTIABLE directives go to the Recency Band
    if (!trimmed.startsWith('#') && isCriticalDirectiveLine(trimmed)) {
      recencyCriticalLines.push(line);
      continue;
    }

    // Markdown tables or reference items go to Middle Band
    if (
      trimmed.startsWith('|') ||
      /\b(reference|lookup|table|appendix|glossary|note|example|background)\b/i.test(trimmed)
    ) {
      if (trimmed.startsWith('#')) currentSectionType = 'MIDDLE';
      middleReferenceLines.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (/\b(architecture|overview|foundation|identity|core|invariant|primacy)\b/i.test(trimmed)) {
        currentSectionType = 'PRIMACY';
        primacyLines.push(line);
      } else {
        currentSectionType = primacyLines.length < 25 ? 'PRIMACY' : 'MIDDLE';
        if (currentSectionType === 'PRIMACY') {
          primacyLines.push(line);
        } else {
          middleReferenceLines.push(line);
        }
      }
      continue;
    }

    if (currentSectionType === 'PRIMACY' && primacyLines.length < Math.floor(maxLines * 0.28)) {
      primacyLines.push(line);
    } else {
      middleReferenceLines.push(line);
    }
  }

  // Sort recencyCriticalLines so highest-priority NEVER / NON-NEGOTIABLE / MUST rules are at the very bottom
  recencyCriticalLines.sort((a, b) => scoreDirectivePriority(a) - scoreDirectivePriority(b));

  // Enforce line budget by trimming excess non-critical middle reference lines into archive if needed
  const headerLines = primacyLines.length > 0 ? primacyLines : ['# Workspace Architecture & Primacy Rules'];
  const recencySectionHeader = [
    '',
    '## Recency Guardrail Pin (Critical Invariants)',
    ...recencyCriticalLines
  ];

  const availableMiddleBudget = Math.max(
    10,
    maxLines - headerLines.length - recencySectionHeader.length - 4
  );

  let keptMiddle = middleReferenceLines;
  if (middleReferenceLines.length > availableMiddleBudget) {
    const overflow = middleReferenceLines.slice(availableMiddleBudget);
    for (const ov of overflow) {
      if (ov.trim()) {
        archivedLines.push({
          lineNumber: 0,
          text: ov.trim(),
          reason: 'LINE_BUDGET_OVERFLOW'
        });
      }
    }
    keptMiddle = middleReferenceLines.slice(0, availableMiddleBudget);
  }

  const finalLines = [
    ...headerLines,
    '',
    '## Reference & Context Lookup (Middle Band)',
    ...keptMiddle,
    ...recencySectionHeader,
    ''
  ];

  return {
    reorderedContent: finalLines.join('\n'),
    archivedLines,
    stats: {
      primacyCount: headerLines.length,
      middleCount: keptMiddle.length,
      recencyCriticalCount: recencyCriticalLines.length,
      archivedCount: archivedLines.length,
      totalLines: finalLines.length
    }
  };
}

export class UShapedAttentionOptimizer {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.archivedRulesPath =
      options.archivedRulesPath || getDefaultArchivedRulesPath(this.homeDir);
    this.prefixShield =
      options.prefixShield ||
      options.prefixCacheShield ||
      new PrefixCacheShield({
        homeDir: this.homeDir,
        queuePath: options.queuePath
      });
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  }

  /**
   * Scans global and workspace instruction files and returns composite U-shaped attention analysis.
   */
  scanWorkspaceAndGlobalRules(customFiles = null) {
    const candidates = customFiles || [
      path.join(this.homeDir, '.gemini', 'GEMINI.md'),
      path.join(this.workspaceDir, 'GEMINI.md'),
      path.join(this.workspaceDir, 'AGENTS.md'),
      path.join(this.workspaceDir, '.agents', 'CONTEXT.md'),
      path.join(this.workspaceDir, 'MEMORY.md')
    ];

    const fileReports = [];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        const attention = analyzeRuleFileAttention(candidate);
        const hygiene = auditRuleFileHygiene(candidate, { nowFn: this.nowFn });
        fileReports.push({
          filePath: candidate,
          attention,
          hygiene
        });
      }
    }

    const systemOverhead = estimateCompositeSystemOverhead(this.homeDir);
    const totalMiddleTroughRisk = fileReports.reduce(
      (sum, r) => sum + r.attention.middleTroughRiskCount,
      0
    );
    const avgPrimacyPct =
      fileReports.length > 0
        ? Math.round(
            fileReports.reduce((sum, r) => sum + r.attention.primacyScorePct, 0) /
              fileReports.length
          )
        : 94;

    return {
      systemOverhead,
      fileReports,
      totalMiddleTroughRisk,
      avgPrimacyPct,
      uiSummary: `Primacy: ${avgPrimacyPct}% | Middle Trough Risk: ${totalMiddleTroughRisk} critical rules`
    };
  }

  /**
   * 1-Click U-Shape Reorder & Hygiene Archiver:
   *  - Reorders directives so critical NEVER/MUST guardrails move out of the 30-70% Middle Trough
   *    into the bottom 30% Recency Band
   *  - Archives >180-day stale rules and budget overflow lines to `~/.gemini/antigravity/agy-horizon/archived_rules.md`
   *  - Routes GEMINI.md / AGENTS.md mutations through PrefixCacheShield so a warm prefix cache is never busted
   *  - Optionally mirrors the top 5 NEVER/MUST invariants into `brain/<GUID>/task.md`
   */
  optimizeRuleFile(filePath, options = {}) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Rule file not found: ${resolvedPath}`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const beforeAnalysis = analyzeRuleFileAttention(rawContent, {
      isRawText: true,
      filePath: resolvedPath
    });
    const beforeHygiene = auditRuleFileHygiene(rawContent, {
      isRawText: true,
      filePath: resolvedPath,
      nowFn: this.nowFn
    });

    const isMemoryMd = /MEMORY\.md$/i.test(resolvedPath);
    const maxLines = isMemoryMd
      ? U_CURVE_CONSTANTS.MEMORY_MD_MAX_LINES
      : options.maxLines || U_CURVE_CONSTANTS.GEMINI_MD_MAX_LINES;

    const { reorderedContent, archivedLines, stats } = buildUShapedReorderedContent(rawContent, {
      nowFn: this.nowFn,
      maxLines
    });

    // Write archived stale/overflow lines to ~/.gemini/antigravity/agy-horizon/archived_rules.md
    if (archivedLines.length > 0) {
      this._appendArchivedRules(resolvedPath, archivedLines);
    }

    const resolvedSession = options.session || {
      cacheState: options.cacheState,
      cacheWarm: options.cacheWarm,
      cachedTokens: options.cachedTokens,
      cacheTtlSeconds: options.cacheTtlSeconds,
      forceColdBust: options.forceColdBust,
      postCompact: options.postCompact
    };

    // Stage or apply the reordered rule file via PrefixCacheShield
    const shieldResult = this.prefixShield.stageOrApplyDelta(
      {
        targetPath: resolvedPath,
        operation: 'REORDER',
        newContent: reorderedContent,
        source: 'u-shaped-optimizer',
        metadata: {
          beforeMiddleTroughRisk: beforeAnalysis.middleTroughRiskCount,
          archivedCount: archivedLines.length
        }
      },
      resolvedSession
    );

    const afterAnalysis = analyzeRuleFileAttention(reorderedContent, {
      isRawText: true,
      filePath: resolvedPath
    });

    let recencyMirrorResult = null;
    if (options.taskMdPath) {
      recencyMirrorResult = this.mirrorTopGuardrailsToTaskMd(reorderedContent, options.taskMdPath);
    }

    return {
      filePath: resolvedPath,
      beforeAnalysis,
      beforeHygiene,
      afterAnalysis,
      archivedLines,
      archivedRulesPath: this.archivedRulesPath,
      stats,
      staged: Boolean(shieldResult.staged),
      deferred: Boolean(shieldResult.deferred),
      shieldResult,
      recencyMirrorResult
    };
  }

  _appendArchivedRules(sourceFilePath, archivedLines = []) {
    fs.mkdirSync(path.dirname(this.archivedRulesPath), { recursive: true });
    const nowIso = new Date(this.nowFn()).toISOString();
    const header = `\n## Archived from \`${path.basename(sourceFilePath)}\` (${nowIso})\n`;
    const body = archivedLines
      .map(item => `- [${item.reason}] (line ${item.lineNumber}): ${item.text}`)
      .join('\n');
    fs.appendFileSync(this.archivedRulesPath, `${header}${body}\n`, 'utf8');
  }

  /**
   * Antigravity Recency Anchor Mirror:
   * Mirrors the top 5 highest-priority NEVER/MUST invariants into a compact
   * `## Active Guardrail Pin` block at the very bottom of `~/.gemini/antigravity/brain/<GUID>/task.md`
   * so those rules remain inside the final 10% Recency Band of the entire conversation window.
   */
  mirrorTopGuardrailsToTaskMd(ruleContentOrFilePath, taskMdPath, options = {}) {
    if (!taskMdPath) {
      throw new Error('taskMdPath is required for mirrorTopGuardrailsToTaskMd');
    }

    const content =
      typeof ruleContentOrFilePath === 'string' && fs.existsSync(ruleContentOrFilePath)
        ? fs.readFileSync(ruleContentOrFilePath, 'utf8')
        : String(ruleContentOrFilePath || '');

    const analysis = analyzeRuleFileAttention(content, { isRawText: true });
    const maxInvariants = Number.isFinite(options.maxInvariants)
      ? options.maxInvariants
      : U_CURVE_CONSTANTS.RECENCY_MIRROR_MAX_INVARIANTS;

    // Select top 5 highest-priority NEVER / MUST invariants
    const sorted = [...analysis.criticalDirectives].sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return b.lineNumber - a.lineNumber;
    });

    const topInvariants = [];
    const seen = new Set();
    for (const item of sorted) {
      const normalized = item.text.replace(/^[-*+\d.)\s]+/, '').trim();
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        topInvariants.push(normalized.startsWith('-') ? normalized : `- ${normalized}`);
      }
      if (topInvariants.length >= maxInvariants) break;
    }

    const existingTaskMd = fs.existsSync(taskMdPath) ? fs.readFileSync(taskMdPath, 'utf8') : '';
    const stripped = existingTaskMd
      .replace(/\n*## Active Guardrail Pin[\s\S]*$/i, '')
      .trimEnd();

    const pinLines = [
      '## Active Guardrail Pin',
      ...topInvariants
    ];

    const updatedTaskMd = `${stripped}\n\n${pinLines.join('\n')}\n`;
    atomicWriteFileSync(taskMdPath, updatedTaskMd, { encoding: 'utf8' });

    return {
      taskMdPath,
      mirroredCount: topInvariants.length,
      invariants: topInvariants,
      activeInTaskMd: true
    };
  }
}

/**
 * HUD Hygiene: Computes a strictly read-only U-curve positional decay heatmap over
 * conversation transcript steps (Primacy top-30%, Middle Trough 30%-70%, Recency bottom-30%)
 * without mutating `AGENTS.md` or enforcing Claude Code's 200-line `MEMORY.md` cap.
 */
export function computeReadOnlyUCurveConversationHeatmap(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const totalSteps = list.length;
  let primacyTokens = 0;
  let middleTroughTokens = 0;
  let recencyTokens = 0;
  let middleTroughCriticalSteps = 0;

  const cells = list.map((step, idx) => {
    const ratio = totalSteps <= 1 ? 0 : idx / (totalSteps - 1);
    const band = classifyPositionalBand(ratio);
    const recallWeight = computePositionalRecallWeight(ratio);
    const text = String(step?.content ?? step?.text ?? '');
    const tokens = Math.max(0, Number(step?.tokens ?? Math.ceil(text.length / 4)));
    const hasCriticalConstraint = U_CURVE_CONSTANTS.CRITICAL_KEYWORD_REGEX.test(text);

    if (band === 'PRIMACY') primacyTokens += tokens;
    else if (band === 'MIDDLE_TROUGH') {
      middleTroughTokens += tokens;
      if (hasCriticalConstraint) middleTroughCriticalSteps++;
    } else {
      recencyTokens += tokens;
    }

    return {
      stepIndex: idx,
      positionRatio: Number(ratio.toFixed(4)),
      band,
      recallWeight,
      tokens,
      hasCriticalConstraint
    };
  });

  return Object.freeze({
    readOnly: true,
    mutatesAgentsMd: false,
    enforces200LineMemoryCap: false,
    totalSteps,
    primacyTokens,
    middleTroughTokens,
    recencyTokens,
    middleTroughCriticalSteps,
    cells
  });
}

export default UShapedAttentionOptimizer;
