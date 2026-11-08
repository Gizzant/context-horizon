# Source File: src/core/pruner.mjs

```javascript
import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';
import { findSessionDirectory, resolveSessionLogs, parseRawJsonl } from './parser.mjs';
import { classifyHorizon } from './classifier.mjs';
import { CATEGORIES, HORIZON_WINDOW } from './constants.mjs';

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

const SIGNATURE_LINE_RE = /^\s*(?:export\s+|import\s+|async\s+function\s+|function\s+|class\s+|interface\s+|type\s+\w+\s*=|const\s+\w+\s*=\s*(?:async\s*)?\(|def\s+\w+|class\s+\w+|pub\s+(?:fn|struct|enum|trait)|fn\s+\w+|struct\s+\w+|CREATE\s+TABLE)/;

/**
 * Folds raw source code or file read output into a compact AST-like signature stub
 * with original line numbers preserved.
 */
export function foldCodeToSignatureStub(rawContent, targetPath = 'file') {
  const text = String(rawContent || '');
  const lines = text.split(/\r?\n/);
  if (lines.length <= 24 || text.length <= 1000) {
    return { condensed: text, savedChars: 0, wasFolded: false };
  }

  const kept = [];
  let skippedRun = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    // Strip optional `123: ` prefix from read_file outputs before matching
    const cleanLine = line.replace(/^\s*\d+\s*[:|]\s*/, '');
    if (i < 3 || i >= lines.length - 2 || SIGNATURE_LINE_RE.test(cleanLine)) {
      if (skippedRun > 0) {
        kept.push(`  /* ... [condensed ${skippedRun} implementation lines] ... */`);
        skippedRun = 0;
      }
      kept.push(`${lineNum}: ${cleanLine.slice(0, 140)}`);
    } else {
      skippedRun++;
    }
  }
  if (skippedRun > 0) {
    kept.push(`  /* ... [condensed ${skippedRun} implementation lines] ... */`);
  }

  const header = `[AST Signature Stub — Condensed Stale Read of ${path.basename(String(targetPath || 'file'))} (${lines.length} lines)]`;
  const condensed = `${header}\n${kept.join('\n')}`;
  const savedChars = Math.max(0, text.length - condensed.length);
  return {
    condensed: savedChars > 200 ? condensed : text,
    savedChars: savedChars > 200 ? savedChars : 0,
    wasFolded: savedChars > 200
  };
}

/**
 * Collapses a resolved Dead Error stack trace into a 1-line tombstone.
 */
export function collapseDeadErrorToTombstone(rawContent, stepIndex = 0, target = 'Command') {
  const text = String(rawContent || '');
  if (text.length <= 400) {
    return { condensed: text, savedChars: 0, wasCollapsed: false };
  }
  const firstMeaningfulLine = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('Created At:') && !l.startsWith('Completed At:')) || 'Error output';
  const savedTokensEst = Math.round(text.length / 4);
  const tombstone = `[Resolved Error at Turn #${stepIndex} (${target}): "${firstMeaningfulLine.slice(0, 120)}" — pruned ~${savedTokensEst} tokens of resolved stack trace]`;
  const savedChars = Math.max(0, text.length - tombstone.length);
  return {
    condensed: tombstone,
    savedChars,
    wasCollapsed: savedChars > 100
  };
}

/**
 * Analyzes or executes prefix-safe surgical pruning on a session's JSONL transcript.
 */
export function pruneSessionTranscript(sessionDir, {
  dryRun = false,
  forceHotCache = false,
  cacheDir = null,
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

  // Map step index -> classification
  const activeCutoff = Math.max(0, parsedSteps.length - HORIZON_WINDOW.ACTIVE_SET_STEP_WINDOW);
  const latestTouchByFile = new Map();
  for (let i = 0; i < parsedSteps.length; i++) {
    const calls = parsedSteps[i]?.toolCalls || [];
    for (const c of calls) {
      const f = c.args?.Path || c.args?.path || c.args?.Target;
      if (f) latestTouchByFile.set(String(f).toLowerCase(), i);
    }
  }

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
    const isError = entry.status === 'ERROR' || entry.exitCode === 1 || content.includes('Traceback (most recent call last)');

    let modified = false;
    if (isError && content.length > 400) {
      const collapsed = collapseDeadErrorToTombstone(content, entry.step_index ?? i, calls[0]?.name || 'Error');
      if (collapsed.wasCollapsed) {
        entry.content = collapsed.condensed;
        entry.pruned_by_horizon = 'DEAD_ERROR_TOMBSTONE';
        const newTok = Math.max(10, Math.ceil(collapsed.condensed.length / 4));
        if (entry.output_tokens !== undefined) entry.output_tokens = newTok;
        if (entry.outputTokens !== undefined) entry.outputTokens = newTok;
        savedCharsTotal += collapsed.savedChars;
        prunedSteps++;
        prunedDetails.push({ stepIndex: i, kind: 'DEAD_ERROR', savedTokens: Math.round(collapsed.savedChars / 4) });
        modified = true;
      }
    } else if (content.length > 1000) {
      // Check if this is a superseded file read or older turn > 25 steps ago
      let targetFile = '';
      let isSupersededFile = false;
      for (const c of calls) {
        const f = c.args?.Path || c.args?.path || c.args?.Target;
        if (f) {
          targetFile = String(f);
          const latestIdx = latestTouchByFile.get(targetFile.toLowerCase());
          if (latestIdx !== undefined && latestIdx > i) {
            isSupersededFile = true;
          }
        }
      }
      const isOldTurn = i < parsedSteps.length - HORIZON_WINDOW.STALE_STEP_THRESHOLD;
      if (isSupersededFile || isOldTurn) {
        const folded = foldCodeToSignatureStub(content, targetFile || `turn-${i}`);
        if (folded.wasFolded) {
          entry.content = folded.condensed;
          entry.pruned_by_horizon = 'AST_SIGNATURE_STUB';
          const newTok = Math.max(10, Math.ceil(folded.condensed.length / 4));
          if (entry.output_tokens !== undefined) entry.output_tokens = newTok;
          if (entry.outputTokens !== undefined) entry.outputTokens = newTok;
          savedCharsTotal += folded.savedChars;
          prunedSteps++;
          prunedDetails.push({ stepIndex: i, kind: 'AST_FOLD', target: targetFile || `turn-${i}`, savedTokens: Math.round(folded.savedChars / 4) });
          modified = true;
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
    const tmpPath = `${transcriptPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, updatedLines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmpPath, transcriptPath);

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
```
