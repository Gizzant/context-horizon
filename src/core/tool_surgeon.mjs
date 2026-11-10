import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './paths.mjs';

/**
 * Prefix-Safe Offline Tool-Output Surgeon (`--prune-tools`).
 *
 * Pairs every `tool_use` with its corresponding `tool_result` across Antigravity steps,
 * Claude Code (`tool_use_id` / `sourceToolAssistantUUID`), and Cursor (`toolFormerData`),
 * while strictly pinning Turn 0 (index 0) and the newest 6 turns (`steps.length - 6 .. steps.length - 1`).
 *
 * Flags a tool output as deterministically stale for truncation (retaining first 300 chars + 1-line note) when:
 *  1. `SUPERSEDED_READ`: Earlier `Read`/`view_file` call on a file path is superseded by a later `Read` or `Edit`/`structuredPatch` on the exact same canonical path.
 *  2. `UNREFERENCED_SEARCH`: Exploratory search (`grep`, `glob`, `find`, `grep_search`, `find_by_name`) returns >1,200 chars of stdout whose file paths are never referenced in the subsequent N=5 turns.
 *  3. `RESOLVED_TEST_STDERR`: Verbose `Bash`/`run_command` test-failure `stderr` trace is superseded by a later passing test run (`exitCode === 0`).
 */

const READ_TOOL_NAMES = new Set(['read_file', 'view_file', 'read', 'view_file_outline', 'view_code_item']);
const EDIT_TOOL_NAMES = new Set(['edit_file', 'write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit', 'write']);
const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'find', 'grep_search', 'find_by_name', 'ripgrep']);
const EXEC_TOOL_NAMES = new Set(['run_command', 'bash', 'execute_command']);

function isToolResultStep(step = {}, prev = null) {
  if (!step || !prev) return false;
  const prevCalls = Array.isArray(prev.toolCalls)
    ? prev.toolCalls
    : (Array.isArray(prev.tool_calls) ? prev.tool_calls : []);
  if (prevCalls.length === 0) return false;
  const curCalls = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
  if (curCalls.length > 0) return false;
  if (prev.type === 'PLANNER_RESPONSE' && (step.type === 'GENERIC' || step.type === 'tool_result' || step.source === 'MODEL')) return true;
  if (step.type === 'TOOL_RESULT' || step.type === 'tool_result' || step.source === 'TOOL') return true;
  return false;
}

function extractStepToolMeta(step = {}, idx = 0, steps = []) {
  let calls = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
  if (calls.length === 0 && idx > 0 && Array.isArray(steps) && steps[idx - 1]) {
    const prev = steps[idx - 1];
    if (isToolResultStep(step, prev)) {
      const prevCalls = Array.isArray(prev.toolCalls)
        ? prev.toolCalls
        : (Array.isArray(prev.tool_calls) ? prev.tool_calls : []);
      if (prevCalls.length > 0) {
        calls = prevCalls;
      }
    }
  }
  const firstCall = calls[0] || {};
  const rawName = String(
    firstCall.name ||
    firstCall.tool ||
    step.toolName ||
    step.toolFormerData?.name ||
    ''
  ).toLowerCase();

  const args = firstCall.args || firstCall.parameters || firstCall.Arguments || step.toolFormerData?.params || {};
  const rawPath = String(
    args.Path ||
    args.path ||
    args.TargetFile ||
    args.AbsolutePath ||
    step.targetPath ||
    step.toolUseResult?.filePath ||
    ''
  ).trim();

  const toolUseId = String(
    firstCall.id ||
    firstCall.tool_use_id ||
    step.tool_use_id ||
    step.sourceToolAssistantUUID ||
    step.toolFormerData?.toolCallId ||
    `step-${idx}`
  );

  const hasStructuredPatch = Boolean(
    step.structuredPatch ||
    step.toolUseResult?.structuredPatch ||
    step.edited_text_file ||
    step.codeBlockDiff
  );

  const content = String(
    step.content ??
    step.toolUseResult?.stdout ??
    step.toolUseResult?.content ??
    step.toolFormerData?.result ??
    ''
  );

  const isError = Boolean(
    step.status === 'ERROR' ||
    (typeof step.exitCode === 'number' && step.exitCode !== 0) ||
    step.is_error === true ||
    /Traceback \(most recent call last\)|AssertionError|FAIL |ERR_|Exit code: [1-9]/i.test(content)
  );

  const isPassExec = EXEC_TOOL_NAMES.has(rawName) && !isError && (
    step.exitCode === 0 ||
    step.status === 'DONE' ||
    /\bPASS\b|0 fail|exit code 0/i.test(content)
  );

  return {
    toolName: rawName,
    toolUseId,
    rawPath: rawPath || null,
    canonPath: rawPath ? canonicalizePath(rawPath) : null,
    hasStructuredPatch,
    content,
    isError,
    isPassExec
  };
}

function extractCandidatePathsFromSearchOutput(text = '') {
  const matches = String(text || '').match(/[A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|go|rs|sql|html|css)/g) || [];
  return Array.from(new Set(matches.map(m => path.basename(m).toLowerCase())));
}

export function analyzeStaleToolOutputs(steps = [], options = {}) {
  const pinnedTailCount = Number.isFinite(options.pinnedTailCount) ? Math.max(0, options.pinnedTailCount) : 6;
  const maxRetainedChars = Number.isFinite(options.maxRetainedChars) ? Math.max(80, options.maxRetainedChars) : 300;
  const unreferencedTurnWindow = Number.isFinite(options.unreferencedTurnWindow) ? Math.max(1, options.unreferencedTurnWindow) : 5;

  const list = Array.isArray(steps) ? steps : [];
  const metaList = list.map((s, idx) => extractStepToolMeta(s, idx, list));

  // Track latest read or edit index per canonical path
  const latestTouchByPath = new Map();
  let latestPassExecIdx = -1;

  for (let i = 0; i < metaList.length; i++) {
    const m = metaList[i];
    if (m.canonPath && (READ_TOOL_NAMES.has(m.toolName) || EDIT_TOOL_NAMES.has(m.toolName) || m.hasStructuredPatch)) {
      latestTouchByPath.set(m.canonPath, i);
    }
    if (m.isPassExec) {
      latestPassExecIdx = i;
    }
  }

  const cutoffIndex = Math.max(1, list.length - pinnedTailCount);
  const cachedTokensWatermark = Number.isFinite(options.cachedTokens) ? options.cachedTokens : null;
  let splitIndex = 1;
  if (cachedTokensWatermark && cachedTokensWatermark > 0) {
    let cumulativeTokens = 0;
    for (let j = 0; j < list.length; j++) {
      const s = list[j];
      const tok = Number(
        s.totalTokens ??
        s.tokens ??
        s.output_tokens ??
        s.outputTokens ??
        (s.content ? Math.ceil(String(s.content).length / 4) : 0)
      );
      cumulativeTokens += tok;
      if (cumulativeTokens <= cachedTokensWatermark) {
        splitIndex = j + 1;
      } else {
        break;
      }
    }
  }
  const startIndex = Math.max(1, splitIndex);
  const candidates = [];
  const prunedSteps = list.map(s => ({ ...s }));
  let totalSavedTokens = 0;

  for (let i = startIndex; i < cutoffIndex; i++) {
    const m = metaList[i];
    const origLen = m.content.length;
    if (origLen <= maxRetainedChars + 60) continue;

    let reason = null;
    if (m.canonPath && READ_TOOL_NAMES.has(m.toolName)) {
      const latestIdx = latestTouchByPath.get(m.canonPath) ?? -1;
      if (latestIdx > i) {
        reason = 'SUPERSEDED_READ';
      }
    }

    if (!reason && SEARCH_TOOL_NAMES.has(m.toolName) && origLen > 1200) {
      const searchBasenames = extractCandidatePathsFromSearchOutput(m.content);
      let referencedLater = false;
      const winEnd = Math.min(list.length, i + 1 + unreferencedTurnWindow);
      for (let k = i + 1; k < winEnd; k++) {
        const nextText = JSON.stringify(list[k] || {}).toLowerCase();
        if (searchBasenames.some(bn => bn && nextText.includes(bn))) {
          referencedLater = true;
          break;
        }
      }
      if (!referencedLater) {
        reason = 'UNREFERENCED_SEARCH';
      }
    }

    if (!reason && EXEC_TOOL_NAMES.has(m.toolName) && m.isError && latestPassExecIdx > i) {
      reason = 'RESOLVED_TEST_STDERR';
    }

    if (reason) {
      const headSlice = m.content.slice(0, maxRetainedChars).trimEnd();
      const droppedChars = Math.max(0, origLen - headSlice.length);
      const savedTok = Math.max(1, Math.floor(droppedChars / 4));
      const note = `\n... [Tool-Output Surgeon (${reason}): truncated ${droppedChars} chars (~${savedTok} tok) at Turn #${i}]`;
      const truncatedContent = `${headSlice}${note}`;

      candidates.push({
        stepIndex: i,
        toolUseId: m.toolUseId,
        toolName: m.toolName || 'tool',
        reason,
        targetPath: m.rawPath,
        originalChars: origLen,
        truncatedChars: truncatedContent.length,
        savedTokens: savedTok,
        truncatedContent
      });

      totalSavedTokens += savedTok;
      prunedSteps[i] = {
        ...prunedSteps[i],
        content: truncatedContent,
        output_tokens: Math.ceil(truncatedContent.length / 4),
        outputTokens: Math.ceil(truncatedContent.length / 4),
        surgeonTruncated: true,
        surgeonReason: reason
      };
    }
  }

  return {
    candidates,
    totalSavedTokens,
    prunedSteps
  };
}

export function executeToolOutputSurgery(transcriptPath, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const uncachedTail = Boolean(options.uncachedTail);
  const cachedTokens = Number.isFinite(options.cachedTokens)
    ? options.cachedTokens
    : (uncachedTail ? 50000 : null);
  const opts = { ...options, cachedTokens };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      success: false,
      dryRun,
      prunedCount: 0,
      savedTokens: 0,
      backupPath: null,
      candidates: [],
      error: 'Transcript file does not exist'
    };
  }

  const rawText = fs.readFileSync(transcriptPath, 'utf8');
  const lines = rawText.split(/\r?\n/).filter(Boolean);
  const parsedSteps = lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch {
      return { step_index: idx, content: line };
    }
  });

  const analysis = analyzeStaleToolOutputs(parsedSteps, opts);
  if (dryRun || analysis.candidates.length === 0) {
    return {
      success: true,
      dryRun,
      prunedCount: analysis.candidates.length,
      savedTokens: analysis.totalSavedTokens,
      backupPath: null,
      candidates: analysis.candidates
    };
  }

  const backupSuffix = uncachedTail ? 'pre_tail_trim' : 'pre_surgeon';
  const backupPath = `${transcriptPath}.${backupSuffix}.${Date.now()}.bak`;
  fs.copyFileSync(transcriptPath, backupPath);

  const tmpPath = `${transcriptPath}.${process.pid}.tmp`;
  const serialized = analysis.prunedSteps.map(s => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  fs.renameSync(tmpPath, transcriptPath);

  return {
    success: true,
    dryRun: false,
    prunedCount: analysis.candidates.length,
    savedTokens: analysis.totalSavedTokens,
    backupPath,
    candidates: analysis.candidates
  };
}
