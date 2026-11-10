import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalizePath } from '../paths.mjs';

/**
 * Phase 1.2: `DET-17` Shadowed File Bloat Detector (`src/core/telemetry/shadow_file_detector.mjs`)
 *
 * Strictly read-only `.pb` / JSONL trajectory scanner with zero side effects.
 * Scans tool-call blocks for multiple full-file `view_file` / `read_file` reads on the
 * same normalized file path across turns where intermediate file edits
 * (`replace_file_content`, `multi_replace_file_content`, `write_to_file`, `edit_file`, `write_file`)
 * occurred.
 *
 * Computes `staleSnapshotCount` and `redundantTokens` per file and formats
 * 40-Cell Flamegraph callout payloads:
 *   e.g. `router.mjs (3x snapshots • 42.1k stale tokens)`
 */

const VIEW_FILE_TOOLS = new Set([
  'view_file',
  'read_file',
  'view_code',
  'mcp_filesystem_read_file'
]);

const EDIT_FILE_TOOLS = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'edit_file',
  'write_file',
  'apply_patch',
  'str_replace'
]);

export function formatTokensCompactK(tokens = 0) {
  const n = Math.max(0, Number(tokens) || 0);
  return `${(n / 1000).toFixed(1)}k`;
}

function isPairedResultStep(nextStep = {}, curStep = {}) {
  if (!nextStep || typeof nextStep !== 'object') return false;
  const nextCalls = Array.isArray(nextStep.toolCalls)
    ? nextStep.toolCalls
    : (Array.isArray(nextStep.tool_calls) ? nextStep.tool_calls : []);
  if (nextCalls.length > 0 || nextStep.tool || nextStep.name || nextStep.toolName) return false;
  const nextType = String(nextStep.type || '').toUpperCase();
  const nextSource = String(nextStep.source || '').toUpperCase();
  if (nextType === 'USER_INPUT' || nextSource === 'USER_EXPLICIT' || nextType === 'SYSTEM_PROMPT') return false;
  const curType = String(curStep.type || '').toUpperCase();
  if (curType === 'PLANNER_RESPONSE' && (nextType === 'GENERIC' || nextType === 'TOOL_RESULT' || nextSource === 'TOOL' || nextSource === 'MODEL')) {
    return true;
  }
  return nextType === 'TOOL_RESULT' || nextSource === 'TOOL';
}

function extractToolCallsFromStep(step = {}, stepIdx = 0, list = []) {
  if (!step || typeof step !== 'object') return [];
  const rawList = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : (Array.isArray(step.tool_calls) ? step.tool_calls : null);

  if (rawList && rawList.length > 0) {
    const nextStep = Array.isArray(list) ? list[stepIdx + 1] : null;
    const hasPairedResult = isPairedResultStep(nextStep, step);
    const ownTokens = Number(step.tokens ?? step.outputTokens ?? 0);
    const nextTokens = hasPairedResult ? Number(nextStep.tokens ?? nextStep.outputTokens ?? 0) : 0;
    const effectiveStepTokens = nextTokens > 0
      ? Math.max(ownTokens, nextTokens)
      : (ownTokens > 0 ? ownTokens : null);
    const effectiveContent = hasPairedResult && nextStep.content
      ? nextStep.content
      : (step.content ?? '');

    return rawList.map((call) => ({
      ...call,
      _stepIndex: Number.isFinite(step.stepIndex) ? step.stepIndex : stepIdx,
      _stepTokens: effectiveStepTokens,
      _stepContent: effectiveContent
    }));
  }

  // Support flat tool-call block objects directly in `.pb` trajectory arrays
  if (step.tool || step.name || step.toolName) {
    return [{
      ...step,
      _stepIndex: Number.isFinite(step.stepIndex) ? step.stepIndex : stepIdx,
      _stepTokens: step.tokens ?? step.outputTokens ?? null,
      _stepContent: step.content ?? ''
    }];
  }

  return [];
}

function resolveCallPath(call = {}) {
  const args = call.args || call.parameters || call.Arguments || {};
  const raw =
    call.path ||
    call.filePath ||
    call.targetFile ||
    args.AbsolutePath ||
    args.TargetFile ||
    args.Path ||
    args.path ||
    args.file_path ||
    '';
  return String(raw || '').trim();
}

function isFullFileViewCall(call = {}) {
  if (call.isFullFile === false || call.rangedRead === true) return false;
  if (call.isFullFile === true) return true;

  const args = call.args || call.parameters || call.Arguments || {};
  const startLine = args.StartLine ?? args.start_line ?? call.StartLine ?? call.startLine ?? null;
  const endLine = args.EndLine ?? args.end_line ?? call.EndLine ?? call.endLine ?? null;
  const totalLines = args.TotalLines ?? args.total_lines ?? call.totalLines ?? null;

  if (startLine === null && endLine === null) {
    return true;
  }

  if (Number(startLine) <= 1 && endLine !== null && totalLines !== null && Number(endLine) >= Number(totalLines)) {
    return true;
  }

  return false;
}

function estimateCallTokens(call = {}) {
  const explicit =
    call.tokens ??
    call.tokenCount ??
    call.outputTokens ??
    call.resultTokens ??
    call._stepTokens ??
    null;

  if (Number.isFinite(Number(explicit)) && Number(explicit) > 0) {
    return Math.round(Number(explicit));
  }

  const textPayload = String(
    call.result ??
    call.output ??
    call.content ??
    call._stepContent ??
    ''
  );
  if (textPayload.length > 0) {
    return Math.ceil(textPayload.length / 4);
  }

  const byteLen = Number(call.byteLength ?? call.bytes ?? 0);
  if (byteLen > 0) {
    return Math.ceil(byteLen / 4);
  }

  return 2500;
}

/**
 * Scans `.pb` / transcript steps for `DET-17` Shadowed File Bloat.
 *
 * @param {Array} steps - Trajectory steps or `.pb` tool-call blocks
 * @param {object} [options={}]
 * @returns {object} { detectorId: 'DET-17', triggered, totalStaleSnapshots, totalRedundantTokens, offenders, flamegraphBadges, elapsedMs }
 */
export function detectShadowedFileBloat(steps = [], options = {}) {
  const startMs = performance.now();
  const list = Array.isArray(steps) ? steps : [];

  // normalizedPath -> { rawPath, events: Array<{ type: 'READ'|'EDIT', turnIndex, tokens, toolName }> }
  const historyByFile = new Map();

  for (let idx = 0; idx < list.length; idx++) {
    const calls = extractToolCallsFromStep(list[idx], idx, list);
    for (const call of calls) {
      const toolName = String(call.name || call.tool || call.toolName || '').toLowerCase().trim();
      if (!VIEW_FILE_TOOLS.has(toolName) && !EDIT_FILE_TOOLS.has(toolName)) {
        continue;
      }

      const rawPath = resolveCallPath(call);
      if (!rawPath) continue;
      const normPath = canonicalizePath(rawPath);
      if (!normPath) continue;

      if (!historyByFile.has(normPath)) {
        historyByFile.set(normPath, {
          rawPath,
          normalizedPath: normPath,
          events: []
        });
      }

      const record = historyByFile.get(normPath);
      const turnIndex = Number.isFinite(call._stepIndex) ? call._stepIndex : idx;

      if (VIEW_FILE_TOOLS.has(toolName)) {
        if (!isFullFileViewCall(call)) continue;
        record.events.push({
          type: 'READ',
          turnIndex,
          tokens: estimateCallTokens(call),
          toolName
        });
      } else if (EDIT_FILE_TOOLS.has(toolName)) {
        record.events.push({
          type: 'EDIT',
          turnIndex,
          tokens: 0,
          toolName
        });
      }
    }
  }

  const offenders = [];

  for (const [, fileRecord] of historyByFile.entries()) {
    const events = fileRecord.events;
    const reads = events.filter((e) => e.type === 'READ');
    if (reads.length < 2) continue;

    // Identify whether intermediate edits occurred between the first and last full-file reads
    const firstReadIdx = events.findIndex((e) => e.type === 'READ');
    let lastReadIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'READ') {
        lastReadIdx = i;
        break;
      }
    }

    const intermediateEdits = events
      .slice(firstReadIdx + 1, lastReadIdx)
      .filter((e) => e.type === 'EDIT');

    if (intermediateEdits.length === 0) {
      continue;
    }

    // Every full-file read prior to the latest full-file read is now a shadowed/stale snapshot
    const staleReads = reads.slice(0, -1);
    const staleSnapshotCount = staleReads.length;
    const redundantTokens = staleReads.reduce((sum, r) => sum + r.tokens, 0);
    const totalReadTokens = reads.reduce((sum, r) => sum + r.tokens, 0);
    const baseName = path.basename(fileRecord.rawPath.replace(/\\/g, '/'));
    const callout = `${baseName} (${staleSnapshotCount}x snapshots • ${formatTokensCompactK(redundantTokens)} stale tokens)`;

    offenders.push({
      detectorId: 'DET-17',
      filePath: fileRecord.rawPath,
      normalizedPath: fileRecord.normalizedPath,
      baseName,
      totalSnapshotCount: reads.length,
      staleSnapshotCount,
      intermediateEditCount: intermediateEdits.length,
      redundantTokens,
      totalReadTokens,
      turnIndices: reads.map((r) => r.turnIndex),
      staleTurnIndices: staleReads.map((r) => r.turnIndex),
      callout
    });
  }

  offenders.sort((a, b) => b.redundantTokens - a.redundantTokens || b.staleSnapshotCount - a.staleSnapshotCount);

  const topLimit = Math.max(1, Number(options.limit || 5));
  const topOffenders = offenders.slice(0, topLimit);
  const totalStaleSnapshots = offenders.reduce((sum, o) => sum + o.staleSnapshotCount, 0);
  const totalRedundantTokens = offenders.reduce((sum, o) => sum + o.redundantTokens, 0);

  return {
    detectorId: 'DET-17',
    triggered: offenders.length > 0,
    totalStaleSnapshots,
    totalRedundantTokens,
    offenders,
    topOffenders,
    flamegraphBadges: topOffenders.map((o) => o.callout),
    elapsedMs: Number((performance.now() - startMs).toFixed(3))
  };
}

export default {
  detectShadowedFileBloat,
  formatTokensCompactK
};
