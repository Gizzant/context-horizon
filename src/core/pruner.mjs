import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getHomeDir, canonicalizePath } from './paths.mjs';
import { findSessionDirectory, resolveSessionLogs, parseRawJsonl } from './parser.mjs';
import { classifyHorizon } from './classifier.mjs';
import { CATEGORIES, HORIZON_WINDOW } from './constants.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';
import {
  foldCodeToSignatureStub,
  collapseDeadErrorToTombstone,
  computeCompactLineDiff
} from './code_fold_lite.mjs';

export { foldCodeToSignatureStub, collapseDeadErrorToTombstone, computeCompactLineDiff };

/**
 * Prefix-Safe Surgical Context Pruner & Regex Signature Folder.
 *
 * Condenses `STALE_DUPLICATE` full-file reads into compact declaration signature stubs
 * (preserving imports, exports, class/function/interface/type/def declarations and
 * original line numbers) and collapses `DEAD_ERROR` stack traces into 1-line
 * `[Resolved Error at Turn #N]` tombstones.
 *
 * Enforces Prefix-Cache Safety: checks whether the 5-minute prompt prefix cache TTL
 * has expired (`isCacheCold`) or if the user explicitly confirms (`forceHotCache: true`),
 * and writes an atomic `.pre_prune.<timestamp>.bak` backup before modifying any JSONL file.
 */

/**
 * Analyzes or executes prefix-safe surgical pruning on a session's JSONL transcript.
 */
export function pruneSessionTranscript(sessionDir, {
  dryRun = false,
  forceHotCache = false,
  cacheDir = null,
  cwd = null,
  workspacePath = null,
  offloadDir = null,
  nowMs = Date.now()
} = {}) {
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return { success: false, error: 'Session directory not found', prunedSteps: 0, savedTokens: 0 };
  }

  const resolved = resolveSessionLogs(sessionDir);
  if (!resolved || !resolved.path || !fs.existsSync(resolved.path)) {
    return { success: false, error: 'Single-file JSONL transcript not found for session', prunedSteps: 0, savedTokens: 0 };
  }

  const transcriptPath = resolved.path;
  const rawFileContent = fs.readFileSync(transcriptPath, 'utf8');
  const rawLines = rawFileContent.split(/\r?\n/).filter(l => l.trim().length > 0);
  const parsedSteps = parseRawJsonl(rawFileContent, { tier: resolved.tier, stepsDir: resolved.stepsDir });
  const state = classifyHorizon(parsedSteps, {
    sessionId: path.basename(sessionDir),
    cacheDir
  });

  const isCacheCold = Boolean(state.quota?.cache?.isCacheCold) || (state.quota?.cache?.idleSeconds >= 300);
  const cacheTtlRemainingSec = state.quota?.cache?.ttlRemainingSec ?? 0;

  if (!dryRun && !isCacheCold && !forceHotCache) {
    return {
      success: false,
      requiresConfirmation: true,
      isCacheCold: false,
      cacheTtlRemainingSec,
      error: `Prompt prefix cache is still warm (${cacheTtlRemainingSec}s TTL remaining). Condense after idle TTL expires, before switching models, or pass forceHotCache=true.`
    };
  }

  // Pass 1 (ISS-040): Track (canonPath, startLine, endLine, lastEditTurnForPath) across the session
  // so disjoint line-range reads, post-edit verification reads, and active latest reads are protected.
  const activeCutoff = Math.max(0, parsedSteps.length - HORIZON_WINDOW.ACTIVE_SET_STEP_WINDOW);
  const isEditToolRe = /^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|edit|write|multiedit|notebookedit)$/i;
  const isReadToolRe = /^(view_file|read_file|read)$/i;
  const lastEditTurnByCanon = new Map();
  const stepReadMetaByIdx = new Map();
  const latestReadIdxByKey = new Map();
  const latestFullReadIdxByCanon = new Map();

  for (let i = 0; i < parsedSteps.length; i++) {
    const calls = parsedSteps[i]?.toolCalls || [];
    for (const c of calls) {
      const toolName = String(c.name || c.tool || '').toLowerCase();
      const args = c.args || c.parameters || c.Arguments || {};
      const f = args.Path || args.path || args.TargetFile || args.AbsolutePath || args.Target;
      if (!f) continue;
      const canon = canonicalizePath(String(f));
      if (!canon) continue;

      if (isEditToolRe.test(toolName)) {
        lastEditTurnByCanon.set(canon, i);
      } else if (isReadToolRe.test(toolName)) {
        const rawStart = args.StartLine ?? args.start_line ?? args.startLine ?? args.offset ?? null;
        const rawEnd = args.EndLine ?? args.end_line ?? args.endLine ?? args.limit ?? null;
        const startLine = rawStart !== null && rawStart !== undefined && rawStart !== '' && Number.isFinite(Number(rawStart))
          ? Number(rawStart)
          : 'FULL';
        const endLine = rawEnd !== null && rawEnd !== undefined && rawEnd !== '' && Number.isFinite(Number(rawEnd))
          ? Number(rawEnd)
          : 'FULL';
        const editGen = lastEditTurnByCanon.has(canon) ? lastEditTurnByCanon.get(canon) : -1;
        const readKey = `${canon}::${startLine}::${endLine}::${editGen}`;
        stepReadMetaByIdx.set(i, { canon, rawPath: String(f), startLine, endLine, editGen, readKey });
        latestReadIdxByKey.set(readKey, i);
        if (startLine === 'FULL' && endLine === 'FULL') {
          latestFullReadIdxByCanon.set(canon, i);
        }
      }
    }
  }

  const baseOffloadWorkspace = cwd || workspacePath || sessionDir;
  const resolvedOffloadDir = offloadDir || path.join(baseOffloadWorkspace, '.agents', 'tmp');

  const writeOffloadCopy = (rawText) => {
    const hash12 = crypto.createHash('sha256').update(rawText, 'utf8').digest('hex').slice(0, 12);
    const fileName = `offload_${hash12}.txt`;
    const offloadAbsPath = path.join(resolvedOffloadDir, fileName);
    const pointerRel = `.agents/tmp/${fileName}`;
    if (!dryRun) {
      atomicWriteFileSync(offloadAbsPath, rawText, { encoding: 'utf8' });
    }
    return { offloadAbsPath, pointerRel };
  };

  let prunedSteps = 0;
  let savedCharsTotal = 0;
  const prunedDetails = [];
  const updatedLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      updatedLines.push(line);
      continue;
    }

    // Never mutate Turn 0, checkpoints, or the active working window
    if (i === 0 || i >= activeCutoff || entry.type === 'CHECKPOINT' || entry.type === 'SYSTEM_PROMPT') {
      updatedLines.push(line);
      continue;
    }

    const content = String(entry.content || '');
    const calls = entry.tool_calls || entry.toolCalls || [];
    const isReadOnlyFileCall = calls.length > 0 && calls.every(c => /^(view_file|read_file|read|view_file_outline|view_code_item)$/i.test(String(c.name || c.tool || '')));
    const isError = entry.status === 'ERROR' ||
      (typeof entry.exitCode === 'number' && entry.exitCode !== 0) ||
      (!isReadOnlyFileCall && content.includes('Traceback (most recent call last)'));

    let modified = false;
    if (isError && content.length > 400) {
      const collapsed = collapseDeadErrorToTombstone(content, entry.step_index ?? i, calls[0]?.name || 'Error');
      if (collapsed.wasCollapsed) {
        let offloadMeta;
        try {
          offloadMeta = writeOffloadCopy(content);
        } catch {
          // ISS-040 Safety Invariant: if offload write fails, preserve raw output intact!
          updatedLines.push(line);
          continue;
        }
        const condensedWithPointer = `${collapsed.condensed} [Offloaded: ${offloadMeta.pointerRel}]`;
        const netSaved = Math.max(0, content.length - condensedWithPointer.length);
        if (netSaved > 60) {
          entry.content = condensedWithPointer;
          entry.pruned_by_horizon = 'DEAD_ERROR_TOMBSTONE';
          entry.offload_pointer = offloadMeta.pointerRel;
          const newTok = Math.max(10, Math.ceil(condensedWithPointer.length / 4));
          if (entry.output_tokens !== undefined) entry.output_tokens = newTok;
          if (entry.outputTokens !== undefined) entry.outputTokens = newTok;
          savedCharsTotal += netSaved;
          prunedSteps++;
          prunedDetails.push({
            stepIndex: i,
            kind: 'DEAD_ERROR',
            savedTokens: Math.round(netSaved / 4),
            offloadPointer: offloadMeta.pointerRel,
            offloadPath: offloadMeta.offloadAbsPath
          });
          modified = true;
        }
      }
    } else if (content.length > 1000) {
      const readMeta = stepReadMetaByIdx.get(i) || null;
      let targetFile = readMeta ? readMeta.rawPath : '';
      let isSupersededFile = false;
      let isProtectedActiveRead = false;

      if (readMeta) {
        const latestSameKeyIdx = latestReadIdxByKey.get(readMeta.readKey);
        const currentFinalEditGen = lastEditTurnByCanon.has(readMeta.canon)
          ? lastEditTurnByCanon.get(readMeta.canon)
          : -1;
        const latestFullIdx = latestFullReadIdxByCanon.get(readMeta.canon);

        if (latestSameKeyIdx !== undefined && latestSameKeyIdx > i) {
          // Identical (canonPath, startLine, endLine, editGen) read repeated later
          isSupersededFile = true;
        } else if (
          readMeta.startLine === 'FULL' &&
          readMeta.endLine === 'FULL' &&
          readMeta.editGen < currentFinalEditGen &&
          latestFullIdx !== undefined &&
          latestFullIdx > i
        ) {
          // Full-file pre-edit read superseded by a later post-edit full-file read
          isSupersededFile = true;
        } else if (readMeta.editGen === currentFinalEditGen && latestSameKeyIdx === i) {
          // Most recent read for this (canonPath, startLine, endLine, currentEditGen) — NEVER fold!
          isProtectedActiveRead = true;
        }
      } else {
        for (const c of calls) {
          const args = c.args || c.parameters || {};
          const f = args.Path || args.path || args.Target;
          if (f) targetFile = String(f);
        }
      }

      const isOldTurn = !isProtectedActiveRead && !readMeta && (i < parsedSteps.length - HORIZON_WINDOW.STALE_STEP_THRESHOLD);
      if (isSupersededFile || isOldTurn) {
        const folded = foldCodeToSignatureStub(content, targetFile || `turn-${i}`);
        if (folded.wasFolded) {
          let offloadMeta;
          try {
            offloadMeta = writeOffloadCopy(content);
          } catch {
            // ISS-040 Safety Invariant: if offload write fails, preserve raw output intact!
            updatedLines.push(line);
            continue;
          }
          const condensedWithPointer = `${folded.condensed}\n[Full raw output preserved at ${offloadMeta.pointerRel}]`;
          const netSaved = Math.max(0, content.length - condensedWithPointer.length);
          if (netSaved > 150) {
            entry.content = condensedWithPointer;
            entry.pruned_by_horizon = 'AST_SIGNATURE_STUB';
            entry.offload_pointer = offloadMeta.pointerRel;
            const newTok = Math.max(10, Math.ceil(condensedWithPointer.length / 4));
            if (entry.output_tokens !== undefined) entry.output_tokens = newTok;
            if (entry.outputTokens !== undefined) entry.outputTokens = newTok;
            savedCharsTotal += netSaved;
            prunedSteps++;
            prunedDetails.push({
              stepIndex: i,
              kind: 'AST_FOLD',
              target: targetFile || `turn-${i}`,
              savedTokens: Math.round(netSaved / 4),
              offloadPointer: offloadMeta.pointerRel,
              offloadPath: offloadMeta.offloadAbsPath
            });
            modified = true;
          }
        }
      }
    }

    updatedLines.push(modified ? JSON.stringify(entry) : line);
  }

  const savedTokens = Math.round(savedCharsTotal / 4);
  let backupPath = null;

  if (!dryRun && prunedSteps > 0) {
    backupPath = `${transcriptPath}.pre_prune.${nowMs}.bak`;
    fs.copyFileSync(transcriptPath, backupPath);
    atomicWriteFileSync(transcriptPath, updatedLines.join('\n') + '\n', { encoding: 'utf8' });

    // Invalidate incremental parser cache so the next poll reads the condensed transcript
    const actualCacheDir = cacheDir || path.join(getHomeDir(), '.gemini', 'antigravity', 'cache', 'agy-horizon');
    const idxCache = path.join(actualCacheDir, `${path.basename(sessionDir)}.idx.json`);
    if (fs.existsSync(idxCache)) {
      try { fs.unlinkSync(idxCache); } catch {}
    }
  }

  return {
    success: true,
    dryRun,
    isCacheCold,
    cacheTtlRemainingSec,
    prunedSteps,
    savedTokens,
    backupPath,
    details: prunedDetails
  };
}

