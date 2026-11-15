/**
 * @file src/guards/docIndexCore.mjs
 * Pure JavaScript zero-token structural document & log indexer (`< 20ms`, 0 LLM tokens).
 *
 * Architectural Invariants:
 * - ZERO `node:*` imports, ZERO `require()`, ZERO dynamic `import()` (Mod Law 4 compliant).
 * - Strictly excludes `ctxvault` SKU paths (`packages/airlock/`, `airlock-schema-canary.yml`,
 *   `docs/HIGHBEAM_AIRLOCK_*.md`).
 * - Scans outside fenced code blocks for Markdown headings (`#`..`####`), code definitions
 *   (`export`, `function`, `class`, `interface`, `type`, `def`, `async def`, `func`, `struct`),
 *   or top-level JSON/YAML keys, with a contiguous 150-line unstructured fallback when `< 3`
 *   structural boundaries exist in files `> 400` lines.
 */

import { normalizeSlashes, sha256Hex } from '../utils/runtime.mjs';

export const UNSTRUCTURED_FALLBACK_LINE_THRESHOLD = 400;
export const UNSTRUCTURED_SPAN_SIZE = 150;
export const MIN_STRUCTURAL_BOUNDARIES = 3;
export const MAX_IDENTIFIERS_PER_SPAN = 8;

const STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'async', 'await', 'return', 'export', 'import', 'from',
  'default', 'class', 'interface', 'type', 'extends', 'implements', 'public', 'private',
  'protected', 'static', 'true', 'false', 'null', 'undefined', 'this', 'super', 'new',
  'throw', 'catch', 'try', 'finally', 'else', 'switch', 'case', 'break', 'continue',
  'while', 'for', 'typeof', 'instanceof', 'void', 'delete', 'with', 'yield', 'def',
  'self', 'none', 'pass', 'elif', 'lambda', 'func', 'struct', 'impl', 'pub', 'mut',
  'string', 'number', 'boolean', 'object', 'array', 'promise', 'record', 'the', 'and',
  'with', 'that', 'this', 'from', 'into', 'when', 'where', 'then', 'only', 'also',
  'must', 'should', 'never', 'always', 'line', 'lines', 'file', 'files', 'test', 'data'
]);

/**
 * Checks whether a path belongs to the isolated sister security SKU and must never be indexed or read.
 *
 * @param {string} [filePath='']
 * @returns {boolean}
 */
export function isForbiddenSkuPath(filePath = '') {
  const norm = normalizeSlashes(String(filePath || '')).trim();
  if (!norm) return false;
  const lower = norm.toLowerCase();
  if (
    /(?:^|\/)packages\/airlock(?:\/|$)/i.test(lower) ||
    lower.endsWith('.github/workflows/airlock-schema-canary.yml') ||
    /(?:^|\/)\.github\/workflows\/airlock-schema-canary\.yml$/i.test(lower) ||
    /(?:^|\/)docs\/highbeam_airlock_[^/]*\.md$/i.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * Splits text into lines across CRLF and LF line endings.
 *
 * @param {string} [rawText='']
 * @returns {string[]}
 */
export function splitLinesNormalized(rawText = '') {
  const str = String(rawText ?? '');
  if (str.length === 0) return [];
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * Parses YAML frontmatter from a `.index.md` document.
 *
 * @param {string} [markdownText='']
 * @returns {{ indexed_file: string, sha256: string, total_lines: number, generated_by: string } | null}
 */
export function parseIndexFrontmatter(markdownText = '') {
  const lines = splitLinesNormalized(markdownText);
  if (lines.length < 3 || lines[0].trim() !== '---') return null;
  const meta = {
    indexed_file: '',
    sha256: '',
    total_lines: 0,
    generated_by: ''
  };
  let closed = false;
  for (let i = 1; i < Math.min(lines.length, 25); i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '---') {
      closed = true;
      break;
    }
    const sepIdx = trimmed.indexOf(':');
    if (sepIdx === -1) continue;
    const key = trimmed.slice(0, sepIdx).trim();
    const val = trimmed.slice(sepIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'indexed_file') meta.indexed_file = val;
    else if (key === 'sha256') meta.sha256 = val;
    else if (key === 'total_lines') meta.total_lines = Number(val) || 0;
    else if (key === 'generated_by') meta.generated_by = val;
  }
  return closed && meta.sha256 ? meta : null;
}

/**
 * Compares live SHA-256 of a file against `.index.md` YAML frontmatter.
 * Returns `0` (`FRESH`), `1` (`STALE`), or `2` (`MISSING`).
 *
 * @param {string} liveSha256
 * @param {string | null | undefined} indexMarkdownText
 * @returns {{ code: 0 | 1 | 2, status: 'FRESH' | 'STALE' | 'MISSING', recordedSha256: string | null }}
 */
export function compareIndexFreshness(liveSha256, indexMarkdownText) {
  if (!indexMarkdownText || typeof indexMarkdownText !== 'string') {
    return { code: 2, status: 'MISSING', recordedSha256: null };
  }
  const fm = parseIndexFrontmatter(indexMarkdownText);
  if (!fm || !fm.sha256) {
    return { code: 2, status: 'MISSING', recordedSha256: null };
  }
  if (String(fm.sha256).toLowerCase() === String(liveSha256 || '').toLowerCase()) {
    return { code: 0, status: 'FRESH', recordedSha256: fm.sha256 };
  }
  return { code: 1, status: 'STALE', recordedSha256: fm.sha256 };
}

function sanitizeTableCell(text = '') {
  return String(text || '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
}

/**
 * Extracts up to `maxCount` backticked terms or high-signal identifiers from a slice of lines.
 *
 * @param {string[]} lines
 * @param {number} startIdx - 0-based inclusive
 * @param {number} endIdx - 0-based inclusive
 * @param {number} [maxCount=MAX_IDENTIFIERS_PER_SPAN]
 * @returns {string[]}
 */
export function extractSpanIdentifiers(lines, startIdx, endIdx, maxCount = MAX_IDENTIFIERS_PER_SPAN) {
  const counts = new Map();
  const backtickTerms = [];
  const backtickSeen = new Set();

  const upper = Math.min(lines.length - 1, endIdx);
  for (let i = Math.max(0, startIdx); i <= upper; i++) {
    const line = lines[i] || '';
    if (line.length > 500) continue;

    // 1. Backticked terms first (high signal in Markdown/JSDoc/logs)
    const btRegex = /`([A-Za-z0-9_./:-]{3,48})`/g;
    let btMatch;
    while ((btMatch = btRegex.exec(line)) !== null) {
      const term = btMatch[1];
      if (!backtickSeen.has(term) && !STOPWORDS.has(term.toLowerCase())) {
        backtickSeen.add(term);
        backtickTerms.push(term);
        if (backtickTerms.length >= maxCount) break;
      }
    }

    // 2. Identifiers (camelCase, PascalCase, snake_case, SCREAMING_SNAKE, error codes)
    const idRegex = /\b([A-Za-z_][A-Za-z0-9_]{3,44})\b/g;
    let idMatch;
    while ((idMatch = idRegex.exec(line)) !== null) {
      const ident = idMatch[1];
      const lower = ident.toLowerCase();
      if (STOPWORDS.has(lower)) continue;
      const isStructuredIdent =
        /[A-Z]/.test(ident) || ident.includes('_') || ident.length >= 6;
      if (!isStructuredIdent) continue;
      counts.set(ident, (counts.get(ident) || 0) + 1);
    }
  }

  const out = [...backtickTerms.slice(0, maxCount)];
  if (out.length < maxCount) {
    const ranked = Array.from(counts.entries())
      .filter(([ident]) => !backtickSeen.has(ident))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [ident] of ranked) {
      out.push(ident);
      if (out.length >= maxCount) break;
    }
  }
  return out;
}

/**
 * Detects structural boundary label on a single line (outside Markdown code fences).
 *
 * @param {string} line
 * @param {boolean} isMarkdownLike
 * @returns {string | null}
 */
function matchStructuralBoundary(line, isMarkdownLike) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 240) return null;

  // Markdown headings (# .. ####)
  const mdMatch = /^(#{1,4})\s+(.+)$/.exec(line);
  if (mdMatch) {
    return `${mdMatch[1]} ${mdMatch[2].trim().slice(0, 72)}`;
  }
  if (isMarkdownLike) return null;

  // JS/TS exports, functions, classes, interfaces, types
  const jsMatch =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)|class\s+([A-Za-z_$][A-Za-z0-9_$]*)|interface\s+([A-Za-z_$][A-Za-z0-9_$]*)|type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=|const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|(?:export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=))/.exec(
      line
    );
  if (jsMatch) {
    const sym = jsMatch[1] || jsMatch[2] || jsMatch[3] || jsMatch[4] || jsMatch[5] || jsMatch[6];
    if (sym) return sym;
  }

  // Python / Go / Rust definitions
  const pyGoRustMatch =
    /^(?:async\s+def|def|class|func(?:\s*\([^)]+\))?|pub\s+(?:async\s+)?fn|fn|pub\s+struct|struct|impl)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      line
    );
  if (pyGoRustMatch) {
    return pyGoRustMatch[1];
  }

  // Top-level JSON or YAML keys (0-2 leading spaces)
  const jsonKeyMatch = /^ {0,2}"([A-Za-z0-9_.-]{2,48})"\s*:\s*[{[]/.exec(line);
  if (jsonKeyMatch) {
    return `"${jsonKeyMatch[1]}"`;
  }
  const yamlKeyMatch = /^([A-Za-z][A-Za-z0-9_.-]{1,48}):\s*(?:#.*)?$/.exec(line);
  if (yamlKeyMatch && !/^(?:https?|file|mailto)$/i.test(yamlKeyMatch[1])) {
    return `${yamlKeyMatch[1]}:`;
  }

  return null;
}

/**
 * Builds deterministic zero-token `.index.md` content for any text/code/log file.
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {string} [params.displayPath]
 * @param {string} params.rawText
 * @param {string} [params.sha256]
 * @returns {{
 *   markdown: string,
 *   sha256: string,
 *   totalLines: number,
 *   spanCount: number,
 *   usedFallback: boolean,
 *   indexTokens: number
 * }}
 */
export function buildStructuralIndexMarkdown({
  filePath = '',
  displayPath = '',
  rawText = '',
  sha256 = ''
} = {}) {
  const normalizedRaw = String(rawText ?? '').replace(/\r\n/g, '\n');
  const computedSha = sha256 || sha256Hex(normalizedRaw);
  const lines = splitLinesNormalized(rawText);
  const totalLines = lines.length;
  const labelPath = normalizeSlashes(displayPath || filePath || 'unknown');
  const isMarkdownLike = /\.(?:md|mdx|markdown)$/i.test(labelPath);

  const boundaries = [];
  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const label = matchStructuralBoundary(line, isMarkdownLike);
    if (label) {
      boundaries.push({ lineNum: i + 1, label });
    }
  }

  let spans = [];
  let usedFallback = false;

  if (boundaries.length < MIN_STRUCTURAL_BOUNDARIES && totalLines > UNSTRUCTURED_FALLBACK_LINE_THRESHOLD) {
    usedFallback = true;
    for (let start = 1; start <= totalLines; start += UNSTRUCTURED_SPAN_SIZE) {
      const end = Math.min(totalLines, start + UNSTRUCTURED_SPAN_SIZE - 1);
      const idents = extractSpanIdentifiers(lines, start - 1, end - 1);
      spans.push({
        startLine: start,
        endLine: end,
        label: `Unstructured Span L${start}-L${end}`,
        identifiers: idents
      });
    }
  } else if (boundaries.length > 0) {
    // Include leading preamble if boundary 0 starts after line 1
    if (boundaries[0].lineNum > 1) {
      const preEnd = boundaries[0].lineNum - 1;
      spans.push({
        startLine: 1,
        endLine: preEnd,
        label: 'Preamble / Imports',
        identifiers: extractSpanIdentifiers(lines, 0, preEnd - 1)
      });
    }
    for (let idx = 0; idx < boundaries.length; idx++) {
      const curr = boundaries[idx];
      const next = boundaries[idx + 1];
      const endLine = next ? Math.max(curr.lineNum, next.lineNum - 1) : totalLines;
      spans.push({
        startLine: curr.lineNum,
        endLine,
        label: curr.label,
        identifiers: extractSpanIdentifiers(lines, curr.lineNum - 1, endLine - 1)
      });
    }
  } else {
    const end = Math.max(1, totalLines);
    spans.push({
      startLine: 1,
      endLine: end,
      label: totalLines === 0 ? 'Empty File' : `Full Span L1-L${end}`,
      identifiers: totalLines === 0 ? [] : extractSpanIdentifiers(lines, 0, end - 1)
    });
  }

  // Cap extreme table rows at 120 spans by coalescing adjacent micro-spans if needed
  if (spans.length > 120) {
    const bucketSize = Math.ceil(spans.length / 80);
    const merged = [];
    for (let i = 0; i < spans.length; i += bucketSize) {
      const group = spans.slice(i, i + bucketSize);
      const combinedIdents = [];
      const seen = new Set();
      for (const g of group) {
        for (const id of g.identifiers) {
          if (!seen.has(id)) {
            seen.add(id);
            combinedIdents.push(id);
          }
          if (combinedIdents.length >= MAX_IDENTIFIERS_PER_SPAN) break;
        }
      }
      merged.push({
        startLine: group[0].startLine,
        endLine: group[group.length - 1].endLine,
        label: group.length > 1 ? `${group[0].label} (+${group.length - 1} more)` : group[0].label,
        identifiers: combinedIdents
      });
    }
    spans = merged;
  }

  const rows = spans.map((sp) => {
    const rangeStr = `L${sp.startLine}-L${sp.endLine}`;
    const sectionStr = sanitizeTableCell(sp.label);
    const identStr =
      sp.identifiers.length > 0
        ? sp.identifiers.map((id) => `\`${sanitizeTableCell(id)}\``).join(', ')
        : '—';
    return `| ${rangeStr} | ${sectionStr} | ${identStr} |`;
  });

  const markdown = [
    '---',
    `indexed_file: "${labelPath}"`,
    `sha256: "${computedSha}"`,
    `total_lines: ${totalLines}`,
    'generated_by: "ctxtop-doc-indexer"',
    '---',
    '',
    `# Structural Index: \`${labelPath}\` (${totalLines} lines)`,
    '',
    '| Lines | Section / Symbol | High-Signal Identifiers |',
    '| :--- | :--- | :--- |',
    ...rows,
    ''
  ].join('\n');

  return {
    markdown,
    sha256: computedSha,
    totalLines,
    spanCount: spans.length,
    usedFallback,
    indexTokens: Math.max(1, Math.ceil(markdown.length / 4))
  };
}

/**
 * Formats 1-indexed line-numbered slice output (`   142 | ...`) across CRLF and LF inputs.
 *
 * @param {string} [rawText='']
 * @param {number} [startLine=1]
 * @param {number} [endLine=1]
 * @returns {{ text: string, startLine: number, endLine: number, totalLines: number }}
 */
export function formatSlicedLines(rawText = '', startLine = 1, endLine = 1) {
  const lines = splitLinesNormalized(rawText);
  const totalLines = lines.length;
  if (totalLines === 0) {
    return { text: '', startLine: 0, endLine: 0, totalLines: 0 };
  }
  const s = Math.max(1, Math.min(totalLines, Math.floor(Number(startLine) || 1)));
  const e = Math.max(s, Math.min(totalLines, Math.floor(Number(endLine) || s)));
  const width = Math.max(6, String(e).length);
  const out = [];
  for (let lineNum = s; lineNum <= e; lineNum++) {
    out.push(`${String(lineNum).padStart(width, ' ')} | ${lines[lineNum - 1]}`);
  }
  return {
    text: out.join('\n'),
    startLine: s,
    endLine: e,
    totalLines
  };
}

export default {
  UNSTRUCTURED_FALLBACK_LINE_THRESHOLD,
  UNSTRUCTURED_SPAN_SIZE,
  MIN_STRUCTURAL_BOUNDARIES,
  MAX_IDENTIFIERS_PER_SPAN,
  isForbiddenSkuPath,
  splitLinesNormalized,
  parseIndexFrontmatter,
  compareIndexFreshness,
  extractSpanIdentifiers,
  buildStructuralIndexMarkdown,
  formatSlicedLines
};
