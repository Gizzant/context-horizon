/**
 * @file src/guards/losslessPostSanitizer.mjs
 * Lossless `PostToolUse` Sanitizer, Critical Error-Line Recovery Engine, and
 * Programmatic Artifact Offloader (> 4,000 tokens -> `.claude/cache/artifacts/ah_<sha256>.txt`).
 *
 * Strict Invariant:
 * - NEVER modifies or offloads workspace `Read` outputs (preserving exact file lines for `Edit`).
 * - Guarantees 100% survival of lines matching `CRITICAL_ERROR_REGEX`.
 */

import { path, getCwd, sha256Hex, writeTextAtomic } from '../utils/runtime.mjs';

export const OFFLOAD_TOKEN_THRESHOLD = 4000; // ~16 KB (~4 chars/token)
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export const CRITICAL_ERROR_REGEX =
  /(Error|Exception|FAIL|error\[E\d+\]|panic:|ERR!|ERESOLVE|AssertionError|SyntaxError)/i;

const ANSI_CSI_OSC_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const DOWNLOAD_NOISE_LINE_REGEX =
  /^\s*(?:npm\s+(?:http|verb|silly|timing|notice)\b|Progress:\s+resolved\s+\d+|Downloading\s+\S+\s+\[[=#>-]+\s*\]|\d+%\s+\[[=#>-]+\s*\]|Receiving objects:\s+\d+%|Resolving deltas:\s+\d+%)/i;

const PASSING_TEST_LINE_REGEX =
  /^\s*(?:✔|✓|PASS\s+\S+|ok\s+\d+\s+-\s+)/;

const HTML_BOILERPLATE_BLOCK_REGEX =
  /<(nav|footer|script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Checks whether a tool name is eligible for `PostToolUse` sanitization and offloading.
 * Workspace `Read` is strictly excluded.
 *
 * @param {string} [toolName='']
 * @returns {boolean}
 */
export function isToolEligibleForSanitization(toolName = '') {
  let cleaned = String(toolName || '').trim();
  if (!cleaned) return false;
  const unprefixed = cleaned.replace(/^(?:default_api:|mcp__[a-zA-Z0-9_-]+__)/i, '');
  if (/^(Read|read_file|view_file|View|Edit|edit_file|Write|write_file|write_to_file|replace_file_content|MultiEdit|NotebookEdit)$/i.test(unprefixed)) {
    return false;
  }
  return /^(Bash|PowerShell|pwsh|cmd|sh|WebFetch|Grep|Glob|Task|Agent|mcp__.+)$/i.test(cleaned);
}

/**
 * Estimates token count from text length (~4 chars per token).
 * @param {string} [text='']
 * @returns {number}
 */
export function estimateTokenCount(text = '') {
  const str = String(text || '');
  if (!str) return 0;
  return Math.ceil(str.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Strips ANSI escape sequences and resolves `\r` carriage-return spinner overwrites.
 * @param {string} [rawText='']
 * @returns {string}
 */
export function stripAnsiAndSpinners(rawText = '') {
  const withoutAnsi = String(rawText || '').replace(ANSI_CSI_OSC_REGEX, '');
  const lines = withoutAnsi.split(/\n/);
  const resolvedLines = lines.map((line) => {
    const trimmedCr = line.replace(/\r$/, '');
    if (!trimmedCr.includes('\r')) return trimmedCr;
    // Spinner overwrite: keep last non-empty segment after \r
    const segments = trimmedCr.split('\r').filter((seg) => seg.trim().length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : '';
  });
  return resolvedLines.join('\n');
}

/**
 * Extracts all critical error/failure lines verbatim from ANSI-cleaned text.
 * @param {string} [cleanText='']
 * @returns {Array<string>}
 */
export function extractCriticalErrorLines(cleanText = '') {
  const lines = String(cleanText || '').split(/\r?\n/);
  return lines.filter((line) => CRITICAL_ERROR_REGEX.test(line));
}

/**
 * Infers a brief schema description of structured output (JSON, CSV/table, or log lines).
 * @param {string} text
 * @returns {string}
 */
function inferPayloadSchema(text = '') {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const firstKeys =
          parsed[0] && typeof parsed[0] === 'object' ? Object.keys(parsed[0]).slice(0, 8).join(', ') : typeof parsed[0];
        return `JSON Array (${parsed.length} items, keys: [${firstKeys}])`;
      }
      if (parsed && typeof parsed === 'object') {
        return `JSON Object (keys: [${Object.keys(parsed).slice(0, 10).join(', ')}])`;
      }
    } catch (_err) {
      return 'Structured JSON/NDJSON stream';
    }
  }
  const firstLine = trimmed.split(/\r?\n/)[0] || '';
  if (firstLine.includes('\t') || (firstLine.split(',').length >= 4 && !firstLine.includes(' '))) {
    return `Tabular output (header: ${firstLine.slice(0, 80)})`;
  }
  return 'Command stdout/stderr log stream';
}

/**
 * Computes a SHA-256 hex digest of a string.
 * @param {string} content
 * @returns {string}
 */
function computeSha256(content = '', options = {}) {
  return sha256Hex(String(content ?? ''), options);
}

/**
 * Sanitizes `PostToolUse` output for `Bash|PowerShell|WebFetch|mcp__.*` (and multi-file `Grep`),
 * preserving 100% of critical error lines and offloading outputs > 4,000 tokens to
 * `.claude/cache/artifacts/ah_<sha256>.txt`.
 *
 * NEVER modifies or offloads workspace `Read` outputs.
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Bash']
 * @param {string} [params.toolOutput='']
 * @param {number} [params.offloadThresholdTokens=4000]
 * @param {object} [options={}]
 */
export function sanitizePostToolOutput(params = {}, options = {}) {
  const toolName = String(params.toolName || params.tool_name || '');
  const rawOutput = String(
    params.toolOutput ?? params.tool_output ?? params.output ?? ''
  );
  const offloadThresholdTokens = Number(
    params.offloadThresholdTokens ?? options.offloadThresholdTokens ?? OFFLOAD_TOKEN_THRESHOLD
  );

  const originalTokens = estimateTokenCount(rawOutput);

  // Strict Invariant: NEVER touch workspace Read/Edit/Write outputs
  if (!isToolEligibleForSanitization(toolName)) {
    return {
      toolName,
      eligible: false,
      sanitized: false,
      offloaded: false,
      artifactPath: null,
      originalTokens,
      finalTokens: originalTokens,
      savedTokens: 0,
      criticalErrorsPreserved: 0,
      updatedToolOutput: rawOutput,
      hookSpecificOutput: null
    };
  }

  // Step 1: Strip ANSI escape sequences and spinner overwrites
  let cleaned = stripAnsiAndSpinners(rawOutput);

  // Step 2: Strip HTML nav/footer/script/style boilerplate for WebFetch
  if (/^WebFetch$/i.test(toolName)) {
    cleaned = cleaned.replace(HTML_BOILERPLATE_BLOCK_REGEX, '');
  }

  // Step 3: Extract 100% of Critical Error lines from the ANSI-cleaned text BEFORE line filtering
  const criticalErrorLines = extractCriticalErrorLines(cleaned);

  // Step 4: Filter download progress bars and passing test lines (while keeping all critical error lines)
  const rawLines = cleaned.split(/\n/);
  const filteredLines = [];
  let strippedPassingTests = 0;

  for (const line of rawLines) {
    if (CRITICAL_ERROR_REGEX.test(line)) {
      filteredLines.push(line);
      continue;
    }
    if (DOWNLOAD_NOISE_LINE_REGEX.test(line)) {
      continue;
    }
    if (PASSING_TEST_LINE_REGEX.test(line) && rawLines.length > 10) {
      strippedPassingTests += 1;
      continue;
    }
    filteredLines.push(line);
  }

  if (strippedPassingTests > 0) {
    filteredLines.push(`[... ${strippedPassingTests} passing test lines compacted by Attention Horizon ...]`);
  }

  let sanitizedText = filteredLines.join('\n');

  // Step 5: Guarantee 100% Critical Error-Line Recovery
  for (const errLine of criticalErrorLines) {
    if (!sanitizedText.includes(errLine)) {
      sanitizedText += `\n${errLine}`;
    }
  }

  const postFilterTokens = estimateTokenCount(sanitizedText);

  // Step 6: Programmatic Artifact Offloading when structured/command output exceeds 4,000 tokens
  let offloaded = false;
  let artifactPath = null;
  let finalOutput = sanitizedText;

  if (originalTokens > offloadThresholdTokens || postFilterTokens > offloadThresholdTokens) {
    const sha256 = computeSha256(cleaned, options);
    const cwd = getCwd(options);
    const relativeArtifactPath = `.claude/cache/artifacts/ah_${sha256}.txt`;
    const candidateArtifactPath = path.join(
      cwd,
      '.claude',
      'cache',
      'artifacts',
      `ah_${sha256}.txt`
    );

    offloaded = writeTextAtomic(candidateArtifactPath, cleaned, options);

    if (offloaded) {
      artifactPath = candidateArtifactPath;
      const nonEmptyLines = filteredLines.filter((l) => l.trim().length > 0);
      const sampleLines = nonEmptyLines.slice(0, 3);
      const schemaSummary = inferPayloadSchema(cleaned);

      const summaryParts = [
        `[Attention Horizon Artifact Offload: ${originalTokens.toLocaleString()} tokens (${rawLines.length} lines) -> ${relativeArtifactPath}]`,
        `Schema: ${schemaSummary}`,
        `Full lossless output saved to: ${artifactPath}`,
        `Sample lines (1..${sampleLines.length}):`,
        ...sampleLines.map((l, idx) => `  ${idx + 1}: ${l.slice(0, 200)}`)
      ];

      if (criticalErrorLines.length > 0) {
        summaryParts.push(
          `Critical Error / Failure Lines Preserved Verbatim (${criticalErrorLines.length}):`
        );
        for (const errLine of criticalErrorLines) {
          summaryParts.push(`  ${errLine}`);
        }
      }

      finalOutput = summaryParts.join('\n');
    } else {
      // ISS-034: Never truncate to a broken pointer stub if offload write fails! Preserve full ANSI-cleaned output.
      artifactPath = null;
      finalOutput = cleaned;
    }
  }

  const finalTokens = estimateTokenCount(finalOutput);
  const savedTokens = Math.max(0, originalTokens - finalTokens);
  const wasModified = finalOutput !== rawOutput;
  const isMcpTool = /^mcp__/i.test(toolName);

  return {
    toolName,
    eligible: true,
    sanitized: wasModified,
    offloaded,
    artifactPath,
    originalTokens,
    finalTokens,
    savedTokens,
    criticalErrorsPreserved: criticalErrorLines.length,
    updatedToolOutput: finalOutput,
    hookSpecificOutput: wasModified
      ? isMcpTool
        ? {
            hookEventName: 'PostToolUse',
            updatedMCPToolOutput: finalOutput
          }
        : {
            hookEventName: 'PostToolUse',
            additionalContext: finalOutput
          }
      : null
  };
}

export default {
  OFFLOAD_TOKEN_THRESHOLD,
  CRITICAL_ERROR_REGEX,
  isToolEligibleForSanitization,
  estimateTokenCount,
  stripAnsiAndSpinners,
  extractCriticalErrorLines,
  sanitizePostToolOutput
};
