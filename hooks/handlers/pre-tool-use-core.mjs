/**
 * @file hooks/handlers/pre-tool-use-core.mjs
 * Full evaluation engine for `PreToolUse`
 * (`Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 *
 * Loaded lazily by the thin `pre-tool-use.mjs` fast-shell or held warm inside Horizon Daemon IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { computeTotalPromptTokens } from '../../src/core-isomorphic/config/catalogLoader.mjs';
import { loadHorizonConfig } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { isNonCodeDocOrArtifactPath } from '../../src/core-isomorphic/coach/smartCompactAdvisor.mjs';
import { atomicWriteFileSync } from '../../src/core/atomic_io.mjs';
import {
  CircuitBreakerEngine,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';

const requireFromHere = createRequire(import.meta.url);

let _savedQuotaMod = null;
function getSavedQuotaMod() {
  if (!_savedQuotaMod) _savedQuotaMod = requireFromHere('../../src/core-isomorphic/coach/savedQuotaLedger.mjs');
  return _savedQuotaMod;
}

let _proLicenseMod = null;
function getProLicenseMod() {
  if (!_proLicenseMod) _proLicenseMod = requireFromHere('../../src/core/pro_license.mjs');
  return _proLicenseMod;
}

let _shadowAutoMod = null;
function getShadowAutoMod() {
  if (!_shadowAutoMod) _shadowAutoMod = requireFromHere('../../src/core/shadow_auto_ledger.mjs');
  return _shadowAutoMod;
}

let _codeFoldMod = null;
function getCodeFoldMod() {
  if (!_codeFoldMod) _codeFoldMod = requireFromHere('../../src/core/code_fold_lite.mjs');
  return _codeFoldMod;
}

let _shieldMod = null;
function getShieldMod() {
  if (!_shieldMod) _shieldMod = requireFromHere('../../src/core/shield_manager.mjs');
  return _shieldMod;
}

let _bucketBMod = null;
function getBucketBMod() {
  if (!_bucketBMod) _bucketBMod = requireFromHere('../../src/core/bucket_b_runtime.mjs');
  return _bucketBMod;
}

function getSnapStorePath(baseCwd, sessionId) {
  if (!baseCwd) return '';
  const safeSid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(baseCwd, '.claude', 'cache', `read_snapshots_${safeSid}.json`);
}

function loadReadSnapStore(baseCwd, sessionId) {
  const snapFilePath = getSnapStorePath(baseCwd, sessionId);
  let store = {};
  if (snapFilePath && fs.existsSync(snapFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(snapFilePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) store = parsed;
    } catch (readErr) {
      void readErr;
      store = {};
    }
  }
  return { snapFilePath, store };
}

const MUTATING_SHELL_INTERVAL_RE =
  /\b(git\s+(?:checkout|reset|pull|merge|rebase|stash|apply|cherry-pick)|rm\s|mv\s|cp\s|sed\s+-i|prettier\s+--write|eslint\s+--fix)\b/i;

export function mergeLineIntervals(intervals = []) {
  const normalized = [];
  for (const pair of Array.isArray(intervals) ? intervals : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const s = Math.max(1, Math.floor(Number(pair[0])));
    const e = Math.floor(Number(pair[1]));
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      normalized.push([s, e]);
    }
  }
  if (normalized.length === 0) return [];
  normalized.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const merged = [normalized[0]];
  for (let i = 1; i < normalized.length; i += 1) {
    const cur = normalized[i];
    const last = merged[merged.length - 1];
    if (cur[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push([cur[0], cur[1]]);
    }
  }
  return merged;
}

/**
 * OPT-3B: Checks whether `[reqStart, reqEnd]` overlaps already-in-context line intervals
 * and returns a contiguous unread trim or 5-line anchor when redundant coverage >= 50%.
 */
export function trimRequestedRangeAgainstIntervals(reqStart, reqEnd, rawIntervals = []) {
  const start = Math.max(1, Math.floor(Number(reqStart) || 1));
  const end = Math.floor(Number(reqEnd) || 0);
  if (end < start) return { status: 'none' };
  const merged = mergeLineIntervals(rawIntervals);
  if (merged.length === 0) return { status: 'none' };

  const reqLen = end - start + 1;
  let overlapLines = 0;
  const uncovered = [];
  let cursor = start;

  for (const [is, ie] of merged) {
    if (ie < start) continue;
    if (is > end) break;
    const ovStart = Math.max(start, is);
    const ovEnd = Math.min(end, ie);
    if (ovEnd >= ovStart) {
      overlapLines += ovEnd - ovStart + 1;
    }
    if (cursor < is) {
      uncovered.push([cursor, Math.min(end, is - 1)]);
    }
    cursor = Math.max(cursor, ie + 1);
    if (cursor > end) break;
  }
  if (cursor <= end) {
    uncovered.push([cursor, end]);
  }

  if (overlapLines === 0) return { status: 'none' };
  if (overlapLines >= reqLen && reqLen >= 25) {
    return {
      status: 'full_covered',
      anchorOffset: start,
      anchorLimit: 5,
      savedLines: reqLen - 5
    };
  }
  if (
    uncovered.length === 1 &&
    overlapLines >= Math.ceil(reqLen * 0.5) &&
    overlapLines >= 10
  ) {
    const [uStart, uEnd] = uncovered[0];
    return {
      status: 'trimmed',
      offset: uStart,
      limit: uEnd - uStart + 1,
      savedLines: overlapLines
    };
  }
  return { status: 'none' };
}

function recordReadIntervalEntry(store, normKey, statObj, startLine, endLine) {
  if (!store || !normKey || !statObj || endLine < startLine) return;
  if (!store.__readIntervals || typeof store.__readIntervals !== 'object') {
    store.__readIntervals = {};
  }
  const prev = store.__readIntervals[normKey];
  const sameStat =
    prev &&
    Number(prev.mtimeMs) === Number(statObj.mtimeMs) &&
    Number(prev.size) === Number(statObj.size);
  const existing = sameStat && Array.isArray(prev.intervals) ? prev.intervals : [];
  store.__readIntervals[normKey] = {
    mtimeMs: Number(statObj.mtimeMs),
    size: Number(statObj.size),
    intervals: mergeLineIntervals([...existing, [startLine, endLine]])
  };
}

function saveReadSnapStore(snapFilePath, store) {
  if (!snapFilePath) return;
  try {
    fs.mkdirSync(path.dirname(snapFilePath), { recursive: true });
    const fileKeys = Object.keys(store).filter((k) => !k.startsWith('__'));
    while (fileKeys.length > 12) {
      const oldest = fileKeys.shift();
      delete store[oldest];
    }
    if (store.__recentEdits && typeof store.__recentEdits === 'object') {
      const editKeys = Object.keys(store.__recentEdits);
      while (editKeys.length > 16) {
        const oldestEdit = editKeys.shift();
        delete store.__recentEdits[oldestEdit];
      }
    }
    if (store.__readIntervals && typeof store.__readIntervals === 'object') {
      const intervalKeys = Object.keys(store.__readIntervals);
      while (intervalKeys.length > 24) {
        const oldestInterval = intervalKeys.shift();
        delete store.__readIntervals[oldestInterval];
      }
    }
    fs.writeFileSync(snapFilePath, JSON.stringify(store), 'utf8');
  } catch (writeErr) {
    void writeErr;
  }
}

function resolveApproxEditLine(srcText = '', snippet = '', explicitStart = null) {
  const parsed = Number(explicitStart);
  if (Number.isFinite(parsed) && parsed >= 1) return Math.round(parsed);
  if (srcText && snippet) {
    const probe = String(snippet).split(/\r?\n/).find((l) => l.trim().length > 0) || '';
    if (probe) {
      const idx = srcText.indexOf(probe);
      if (idx >= 0) return srcText.slice(0, idx).split(/\r?\n/).length;
    }
  }
  return 1;
}

/**
 * Evaluates a `PreToolUse` hook payload and returns the contract response.
 * Persists stateful breaker counters atomically across separate CLI hook spawns (`ISS-038`).
 *
 * @param {object} event
 * @param {object} [options={}]
 */
export function runPreToolUseHook(event = {}, options = {}) {
  const toolName = String(event.tool_name || event.toolName || '');
  const tier1Active = Boolean(
    options.tier1ModActive ||
    event.tier1ModActive ||
    globalThis.process?.env?.AH_TIER1_MOD_ACTIVE === '1'
  );
  if (tier1Active && /^(Grep|Glob)$/i.test(toolName)) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      fastPath: 'tier1_mod_active',
      verdict: { triggered: false, decision: 'allow', reason: 'Handled in-process by Tier 1 Mod' }
    };
  }
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
  const configHasDiskSource = Boolean(
    horizonConfig?.sources?.projectLoaded || horizonConfig?.sources?.globalLoaded
  );
  const rawEffectiveMode =
    event.mode ||
    options.mode ||
    options.telemetryState?.flightMode ||
    (configHasDiskSource
      ? horizonConfig.flightMode
      : liveState?.flightMode || horizonConfig?.flightMode || 'COACH');
  const proAutoPilot =
    rawEffectiveMode === 'AUTO_PILOT'
      ? getProLicenseMod().requireProFeature('auto_pilot_locks', options)
      : { allowed: true };
  const effectiveMode =
    rawEffectiveMode === 'AUTO_PILOT' && !proAutoPilot.allowed ? 'COACH' : rawEffectiveMode;

  const shouldPersistState =
    !options.engine &&
    options.persistState !== false &&
    Boolean(event.cwd || options.cwd || options.breakerStatePath || options.persistState);

  const priorSnapshot = shouldPersistState
    ? readBreakerStateSnapshot(sessionId, cwdOptions)
    : null;

  const engine =
    options.engine ||
    new CircuitBreakerEngine({
      ...cwdOptions,
      horizonConfig,
      mode: effectiveMode,
      initialState: priorSnapshot
    });

  let clearTurnBoundaryFlag = false;
  const saveBreakerWithBoundaryPreserved = () => {
    if (!shouldPersistState) return;
    writeBreakerStateSnapshot(
      sessionId,
      {
        ...engine.exportStateSnapshot(),
        ...(clearTurnBoundaryFlag
          ? { turnBoundaryReached: false }
          : priorSnapshot?.turnBoundaryReached !== undefined
            ? { turnBoundaryReached: Boolean(priorSnapshot.turnBoundaryReached) }
            : {}),
        ...(priorSnapshot?.turnMidDebug !== undefined
          ? { turnMidDebug: Boolean(priorSnapshot.turnMidDebug) }
          : {}),
        ...(priorSnapshot?.turnsSinceLastCompact !== undefined
          ? { turnsSinceLastCompact: priorSnapshot.turnsSinceLastCompact }
          : {}),
        ...(priorSnapshot?.lastContextTokens !== undefined
          ? { lastContextTokens: priorSnapshot.lastContextTokens }
          : {}),
        ...(priorSnapshot?.lastModelId !== undefined
          ? { lastModelId: priorSnapshot.lastModelId }
          : {}),
        ...(priorSnapshot?.lastToolsetHash !== undefined
          ? { lastToolsetHash: priorSnapshot.lastToolsetHash }
          : {})
      },
      cwdOptions
    );
  };

  const eventUsage = event.usage || event.context_window?.current_usage || null;
  const computedEventPromptTokens = Math.max(
    computeTotalPromptTokens(event),
    eventUsage ? computeTotalPromptTokens(eventUsage) : 0
  );
  const eventCacheReadTokens = Number(
    eventUsage?.cache_read_input_tokens ?? eventUsage?.cacheReadTokens ?? 0
  );
  const enrichedEvent = {
    ...event,
    ...(computedEventPromptTokens > 0 && event.totalPromptTokens === undefined
      ? { totalPromptTokens: computedEventPromptTokens }
      : {}),
    ...(eventCacheReadTokens > 0 && event.cachedTokens === undefined
      ? { cachedTokens: eventCacheReadTokens }
      : {}),
    mode: event.mode || effectiveMode
  };

  const verdict = engine.evaluatePreToolUse(enrichedEvent, {
    ...liveState,
    flightMode: effectiveMode
  });

  // Playbook Step 4 & VC Gap 4: Post-Edit Unified Delta Diff + 3rd-Read AST Signature Stub Interception
  const isReadTool = /^(Read|read_file|view_file)$/i.test(toolName);
  const tIn = event.tool_input || event.toolInput || event.args || {};
  const hasLineBounds =
    tIn.StartLine !== undefined ||
    tIn.EndLine !== undefined ||
    tIn.offset !== undefined ||
    tIn.limit !== undefined ||
    tIn.pages !== undefined;
  const rawReadPath = String(tIn.file_path || tIn.Path || tIn.AbsolutePath || tIn.path || '').trim();

  // Item A8 (#14): Multimodal .ipynb Base64 Stripper (`updatedInput`) & Unbounded >10-page .pdf Blocker
  if (
    isReadTool &&
    rawReadPath &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask' &&
    verdict.decision !== 'defer' &&
    /\.(?:ipynb|pdf)$/i.test(rawReadPath)
  ) {
    const baseCwdForMm = event.cwd || options.cwd || process.cwd();
    const mmVerdict = getShieldMod().inspectAndSanitizeMultimodalRead({
      platform: 'claude',
      cwd: baseCwdForMm,
      filePath: rawReadPath,
      pages: tIn.pages,
      hasPageBounds: tIn.pages !== undefined
    });
    if (mmVerdict.action === 'deny') {
      if (shouldPersistState) {
        saveBreakerWithBoundaryPreserved();
      }
      const denyOut = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: mmVerdict.reason
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(denyOut),
        stderr: '',
        verdict: {
          triggered: true,
          detectorId: mmVerdict.detectorId,
          subType: mmVerdict.subType,
          decision: 'deny',
          pageCount: mmVerdict.pageCount,
          savedTokens: mmVerdict.savedTokens,
          reason: mmVerdict.reason
        }
      };
    }
    if (mmVerdict.action === 'rewrite' && mmVerdict.sanitizedPath) {
      if (shouldPersistState) {
        saveBreakerWithBoundaryPreserved();
      }
      if (
        mmVerdict.savedTokens > 0 &&
        options.recordLedger !== false &&
        Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
      ) {
        getSavedQuotaMod().recordInterventionSavings(
          {
            sessionId,
            category: 'BOUNDED_READ_ENFORCED',
            modelId: event.model || event.modelId || liveState?.modelId || 'claude-sonnet-4-6',
            savedTokens: mmVerdict.savedTokens,
            detail: `Sanitized .ipynb base64 blobs in ${path.basename(rawReadPath)}`
          },
          cwdOptions
        );
      }
      const updatedInput = {
        ...tIn,
        file_path: mmVerdict.sanitizedPath
      };
      const rewriteOut = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput,
          additionalContext: mmVerdict.reason
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(rewriteOut),
        stderr: '',
        verdict: {
          triggered: true,
          detectorId: mmVerdict.detectorId,
          subType: mmVerdict.subType,
          decision: 'allow',
          sanitizedPath: mmVerdict.sanitizedPath,
          savedTokens: mmVerdict.savedTokens,
          updatedInput,
          reason: mmVerdict.reason
        }
      };
    }
  }

  // IMP-4B: Immediate post-Edit verify re-read fold (<= 2 turns) before heavy Shield block
  if (
    isReadTool &&
    rawReadPath &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask' &&
    verdict.decision !== 'defer'
  ) {
    try {
      const baseCwdForEditFold = event.cwd || options.cwd || '';
      const absFoldPath = path.isAbsolute(rawReadPath)
        ? rawReadPath
        : path.resolve(baseCwdForEditFold || process.cwd(), rawReadPath);
      const normFoldKey = absFoldPath.replace(/\\/g, '/').toLowerCase();
      const { snapFilePath: foldSnapPath, store: foldStore } =
        baseCwdForEditFold && shouldPersistState
          ? loadReadSnapStore(baseCwdForEditFold, sessionId)
          : { snapFilePath: '', store: {} };
      if (foldSnapPath) {
        foldStore.__turnSeq = Number(foldStore.__turnSeq || 0) + 1;
      }
      const recentEdit = event.recentEdit || foldStore.__recentEdits?.[normFoldKey] || null;
      const curTurnSeq = Number(foldStore.__turnSeq || 0);
      const nowEpochMs = Date.now();
      const isRecentEdit = Boolean(
        recentEdit &&
          ((Number.isFinite(Number(recentEdit.turn)) && curTurnSeq - Number(recentEdit.turn) <= 2) ||
            (Number.isFinite(Number(recentEdit.timestampMs)) &&
              nowEpochMs - Number(recentEdit.timestampMs) <= 120_000))
      );
      if (isRecentEdit && fs.existsSync(absFoldPath) && fs.statSync(absFoldPath).isFile()) {
        const stFold = fs.statSync(absFoldPath);
        if (stFold.size > 256 && stFold.size <= 512 * 1024) {
          const rawNow = fs.readFileSync(absFoldPath, 'utf8');
          const totalFoldLines = rawNow.length > 0 ? rawNow.replace(/\r\n/g, '\n').split('\n').length : 0;
          const explicitSpan =
            tIn.limit !== undefined
              ? Number(tIn.limit)
              : tIn.StartLine !== undefined && tIn.EndLine !== undefined
                ? Number(tIn.EndLine) - Number(tIn.StartLine) + 1
                : totalFoldLines;
          const requestedSpan = hasLineBounds && Number.isFinite(explicitSpan) ? explicitSpan : totalFoldLines;
          if (totalFoldLines > 150 && requestedSpan > 150) {
            const prevForDiff =
              typeof event.priorContentSnapshot === 'string'
                ? event.priorContentSnapshot
                : typeof foldStore[normFoldKey] === 'string'
                  ? foldStore[normFoldKey]
                  : '';
            const win = getCodeFoldMod().computePostEditReadWindow({
              prevContent: prevForDiff,
              nextContent: rawNow,
              explicitStartLine: recentEdit.approxLineStart,
              windowLines: 150
            });
            const delta =
              prevForDiff && prevForDiff !== rawNow
                ? getCodeFoldMod().computeCompactLineDiff(prevForDiff, rawNow, path.basename(absFoldPath))
                : { wasDiffed: false, diffText: '', savedTokens: 0 };
            const clampedLinesSaved = Math.max(1, Math.min(requestedSpan, totalFoldLines) - win.windowLimit);
            const estSliceSavings = Math.max(
              1,
              Math.round((rawNow.length / 4) * (clampedLinesSaved / Math.max(1, totalFoldLines)))
            );
            const savedTokens = Math.max(Number(delta.savedTokens || 0), estSliceSavings);
            const updatedInput = { ...tIn };
            delete updatedInput.StartLine;
            delete updatedInput.EndLine;
            updatedInput.offset = win.windowStart;
            updatedInput.limit = win.windowLimit;

            if (foldSnapPath) {
              if (rawNow.length <= 128 * 1024) foldStore[normFoldKey] = rawNow;
              saveReadSnapStore(foldSnapPath, foldStore);
            }
            if (shouldPersistState) {
              saveBreakerWithBoundaryPreserved();
            }
            if (
              options.recordLedger !== false &&
              Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
            ) {
              getSavedQuotaMod().recordInterventionSavings(
                {
                  sessionId,
                  category: 'BOUNDED_READ_ENFORCED',
                  modelId: event.model || event.modelId || liveState?.modelId || 'claude-sonnet-4-6',
                  savedTokens,
                  dedupeId:
                    event.tool_use_id ||
                    event.toolUseId ||
                    `post_edit_fold:${sessionId}:${path.basename(absFoldPath)}:${curTurnSeq}`,
                  detail: `Post-edit verify re-read folded to L${win.windowStart}-L${win.windowEnd} of ${path.basename(absFoldPath)}`
                },
                cwdOptions
              );
            }
            const foldReason =
              `[GUARD-4 Post-Edit Verify Fold] Clamped immediate re-read of ${path.basename(absFoldPath)} (${totalFoldLines} lines) to L${win.windowStart}-L${win.windowEnd} (limit ${win.windowLimit}, +${savedTokens} tokens saved).` +
              (delta.wasDiffed ? `\n${delta.diffText}` : '');
            const allowOut = {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput,
                additionalContext: foldReason,
                ...(delta.wasDiffed ? { deltaDiffStub: delta.diffText, savedTokens } : { savedTokens })
              }
            };
            return {
              exitCode: 0,
              stdout: JSON.stringify(allowOut),
              stderr: '',
              verdict: {
                triggered: true,
                detectorId: 'DET-06',
                subType: 'POST_EDIT_VERIFY_FOLD',
                decision: 'allow',
                updatedInput,
                recommendedSlice: {
                  offset: win.windowStart,
                  limit: win.windowLimit,
                  StartLine: win.windowStart,
                  EndLine: win.windowEnd
                },
                ...(delta.wasDiffed ? { deltaDiffStub: delta.diffText } : {}),
                savedTokens,
                reason: foldReason
              }
            };
          }
        }
      } else if (foldSnapPath) {
        saveReadSnapStore(foldSnapPath, foldStore);
      }
    } catch (foldErr) {
      void foldErr;
    }
  }

  const rawStartBound = tIn.offset ?? tIn.StartLine ?? tIn.start_line;
  const rawEndBound = tIn.EndLine ?? tIn.end_line;
  const rawLimitBound = tIn.limit;
  const hasExplicitLineSlice =
    rawStartBound !== undefined || rawEndBound !== undefined || rawLimitBound !== undefined;
  let effectiveSliceOffset = hasExplicitLineSlice ? Math.max(1, Math.floor(Number(rawStartBound) || 1)) : null;
  let effectiveSliceLimit = hasExplicitLineSlice
    ? rawLimitBound !== undefined && Number.isFinite(Number(rawLimitBound))
      ? Math.max(1, Math.floor(Number(rawLimitBound)))
      : rawEndBound !== undefined && Number.isFinite(Number(rawEndBound))
        ? Math.max(1, Math.floor(Number(rawEndBound)) - effectiveSliceOffset + 1)
        : null
    : null;

  // OPT-3B: Check Per-File Read-Interval Ledger on explicitly sliced Reads BEFORE Shield
  // (avoids unnecessary Shield clamp when already-loaded overlap trims down into safe bounds)
  let trimmedByInterval = null;
  if (
    isReadTool &&
    hasExplicitLineSlice &&
    rawReadPath &&
    shouldPersistState &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask' &&
    verdict.decision !== 'defer' &&
    !/\.(?:ipynb|pdf)$/i.test(rawReadPath)
  ) {
    try {
      const baseCwdForInt = event.cwd || options.cwd || '';
      if (baseCwdForInt) {
        const absIntPath = path.isAbsolute(rawReadPath)
          ? rawReadPath
          : path.resolve(baseCwdForInt, rawReadPath);
        if (fs.existsSync(absIntPath) && fs.statSync(absIntPath).isFile()) {
          const stInt = fs.statSync(absIntPath);
          if (stInt.size > 0 && stInt.size <= 1024 * 1024) {
            const normIntKey = absIntPath.replace(/\\/g, '/').toLowerCase();
            const { snapFilePath: intSnapPath, store: intStore } = loadReadSnapStore(baseCwdForInt, sessionId);
            const entry = intStore.__readIntervals?.[normIntKey];
            const entryValid =
              entry &&
              Number(entry.mtimeMs) === Number(stInt.mtimeMs) &&
              Number(entry.size) === Number(stInt.size) &&
              Array.isArray(entry.intervals) &&
              entry.intervals.length > 0;
            if (entryValid) {
              const rawIntSrc = fs.readFileSync(absIntPath, 'utf8');
              const totalFileLines = rawIntSrc.length === 0 ? 0 : rawIntSrc.replace(/\r\n/g, '\n').split('\n').length;
              const reqStart = effectiveSliceOffset || 1;
              const reqEnd = effectiveSliceLimit
                ? Math.min(totalFileLines, reqStart + effectiveSliceLimit - 1)
                : totalFileLines;
              const trimRes = trimRequestedRangeAgainstIntervals(reqStart, reqEnd, entry.intervals);
              if (trimRes.status === 'full_covered') {
                const avgBytesPerLine = totalFileLines > 0 ? stInt.size / totalFileLines : 40;
                const savedTok = Math.max(10, Math.round((trimRes.savedLines * avgBytesPerLine) / 4));
                const updatedInput = { ...tIn };
                delete updatedInput.StartLine;
                delete updatedInput.EndLine;
                updatedInput.offset = trimRes.anchorOffset;
                updatedInput.limit = trimRes.anchorLimit;
                if (
                  options.recordLedger !== false &&
                  Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
                ) {
                  getSavedQuotaMod().recordInterventionSavings(
                    {
                      sessionId,
                      category: 'BOUNDED_READ_ENFORCED',
                      modelId: event.model || event.modelId || liveState?.modelId || 'claude-sonnet-5-5',
                      savedTokens: savedTok,
                      dedupeId:
                        event.tool_use_id ||
                        event.toolUseId ||
                        `interval_anchor:${sessionId}:${path.basename(absIntPath)}:${reqStart}:${reqEnd}`,
                      detail: `Read-interval cache anchor on ${path.basename(absIntPath)} L${reqStart}-L${reqEnd}`
                    },
                    cwdOptions
                  );
                }
                if (shouldPersistState) {
                  saveBreakerWithBoundaryPreserved();
                }
                const reasonMsg = `[Highbeam Read-Interval Cache] L${reqStart}-L${reqEnd} of ${path.basename(absIntPath)} already in context (unmodified); clamped to 5-line anchor (+${savedTok} tok saved).`;
                const allowOut = {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    updatedInput,
                    additionalContext: reasonMsg,
                    savedTokens: savedTok
                  }
                };
                return {
                  exitCode: 0,
                  stdout: JSON.stringify(allowOut),
                  stderr: '',
                  verdict: {
                    triggered: true,
                    detectorId: 'DET-06',
                    subType: 'READ_INTERVAL_ANCHOR',
                    decision: 'allow',
                    updatedInput,
                    savedTokens: savedTok,
                    reason: reasonMsg
                  }
                };
              }
              if (trimRes.status === 'trimmed') {
                const avgBytesPerLine = totalFileLines > 0 ? stInt.size / totalFileLines : 40;
                const savedTok = Math.max(10, Math.round((trimRes.savedLines * avgBytesPerLine) / 4));
                effectiveSliceOffset = trimRes.offset;
                effectiveSliceLimit = trimRes.limit;
                trimmedByInterval = {
                  reqStart,
                  reqEnd,
                  offset: trimRes.offset,
                  limit: trimRes.limit,
                  savedTokens: savedTok,
                  absPath: absIntPath,
                  normKey: normIntKey,
                  statObj: stInt,
                  intSnapPath,
                  intStore
                };
              }
            }
          }
        }
      }
    } catch (intErr) {
      void intErr;
    }
  }

  if (
    isReadTool &&
    rawReadPath &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask' &&
    verdict.decision !== 'defer' &&
    !/\.(?:ipynb|pdf)$/i.test(rawReadPath)
  ) {
    const baseCwdForShield = event.cwd || options.cwd || process.cwd();
    const shieldVerdict = getShieldMod().evaluateShieldReadGuard({
      platform: 'claude',
      sessionId,
      cwd: baseCwdForShield,
      filePath: rawReadPath,
      hasSliceBounds: hasExplicitLineSlice || hasLineBounds,
      sliceOffset: effectiveSliceOffset,
      sliceLimit: effectiveSliceLimit,
      currentPromptTokens:
        computedEventPromptTokens || Number(liveState?.contextWindow?.totalInputTokens || 0),
      modelId: event.model || event.modelId || liveState?.modelId || 'claude-sonnet-4-6',
      shieldConfig: options.shieldConfig,
      forceActive: Boolean(options.shieldForceActive),
      recordLedger:
        options.recordLedger !== false &&
        Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger),
      ledgerPath: options.ledgerPath
    });
    if (shieldVerdict.action === 'deny') {
      if (shouldPersistState) {
        saveBreakerWithBoundaryPreserved();
      }
      const denyOut = {
        permissionDecision: 'deny',
        reason: shieldVerdict.reason,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: shieldVerdict.reason
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(denyOut),
        stderr: '',
        verdict: {
          triggered: true,
          detectorId: shieldVerdict.detectorId,
          triggerReason: shieldVerdict.triggerReason,
          decision: 'deny',
          reason: shieldVerdict.reason,
          indexPath: shieldVerdict.indexPath,
          fileBytes: shieldVerdict.fileBytes,
          maxBytes: shieldVerdict.maxBytes,
          savedTokens: shieldVerdict.savedTokens,
          savedUSD: shieldVerdict.savedUSD
        }
      };
    }
    if (shieldVerdict.action === 'clamp') {
      if (shouldPersistState && baseCwdForShield) {
        try {
          const absClampPath = path.isAbsolute(rawReadPath)
            ? rawReadPath
            : path.resolve(baseCwdForShield, rawReadPath);
          if (fs.existsSync(absClampPath) && fs.statSync(absClampPath).isFile()) {
            const stClamp = fs.statSync(absClampPath);
            const { snapFilePath: clampSnapPath, store: clampStore } = loadReadSnapStore(baseCwdForShield, sessionId);
            const clampStart = shieldVerdict.clampOffset || 1;
            const clampEnd = clampStart + shieldVerdict.clampLimit - 1;
            recordReadIntervalEntry(
              clampStore,
              absClampPath.replace(/\\/g, '/').toLowerCase(),
              stClamp,
              clampStart,
              clampEnd
            );
            saveReadSnapStore(clampSnapPath, clampStore);
          }
        } catch (clampIntErr) {
          void clampIntErr;
        }
      }
      if (shouldPersistState) {
        saveBreakerWithBoundaryPreserved();
      }
      const updatedInput = { ...tIn };
      delete updatedInput.StartLine;
      delete updatedInput.EndLine;
      updatedInput.offset = shieldVerdict.clampOffset || 1;
      updatedInput.limit = shieldVerdict.clampLimit;
      const clampSubType = String(shieldVerdict.triggerReason || '').startsWith('explicit_slice')
        ? 'EXPLICIT_SLICE_CLAMP'
        : 'BYTE_WIDTH_CLAMP';
      const clampOut = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput,
          additionalContext: shieldVerdict.reason
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(clampOut),
        stderr: '',
        verdict: {
          triggered: true,
          detectorId: shieldVerdict.detectorId,
          triggerReason: shieldVerdict.triggerReason,
          subType: clampSubType,
          decision: 'allow',
          updatedInput,
          clampOffset: updatedInput.offset,
          clampLimit: updatedInput.limit,
          reason: shieldVerdict.reason,
          indexPath: shieldVerdict.indexPath,
          fileBytes: shieldVerdict.fileBytes,
          maxBytes: shieldVerdict.maxBytes,
          clampedBytes: shieldVerdict.clampedBytes,
          savedTokens: shieldVerdict.savedTokens,
          savedUSD: shieldVerdict.savedUSD
        }
      };
    }
  }

  // If OPT-3B interval trim succeeded and trimmed range cleared Shield safely, emit READ_INTERVAL_TRIM
  if (trimmedByInterval) {
    recordReadIntervalEntry(
      trimmedByInterval.intStore,
      trimmedByInterval.normKey,
      trimmedByInterval.statObj,
      trimmedByInterval.offset,
      trimmedByInterval.offset + trimmedByInterval.limit - 1
    );
    saveReadSnapStore(trimmedByInterval.intSnapPath, trimmedByInterval.intStore);
    if (
      options.recordLedger !== false &&
      Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
    ) {
      getSavedQuotaMod().recordInterventionSavings(
        {
          sessionId,
          category: 'BOUNDED_READ_ENFORCED',
          modelId: event.model || event.modelId || liveState?.modelId || 'claude-sonnet-5-5',
          savedTokens: trimmedByInterval.savedTokens,
          dedupeId:
            event.tool_use_id ||
            event.toolUseId ||
            `interval_trim:${sessionId}:${path.basename(trimmedByInterval.absPath)}:${trimmedByInterval.reqStart}:${trimmedByInterval.reqEnd}`,
          detail: `Trimmed overlapping read of ${path.basename(trimmedByInterval.absPath)} to L${trimmedByInterval.offset}-L${trimmedByInterval.offset + trimmedByInterval.limit - 1}`
        },
        cwdOptions
      );
    }
    if (shouldPersistState) {
      saveBreakerWithBoundaryPreserved();
    }
    const updatedInput = { ...tIn };
    delete updatedInput.StartLine;
    delete updatedInput.EndLine;
    updatedInput.offset = trimmedByInterval.offset;
    updatedInput.limit = trimmedByInterval.limit;
    const trimReason = `[Highbeam Read-Interval Trim] L${trimmedByInterval.reqStart}-L${trimmedByInterval.reqEnd} overlapped already-loaded lines of ${path.basename(trimmedByInterval.absPath)}; clamped to unread L${trimmedByInterval.offset}-L${trimmedByInterval.offset + trimmedByInterval.limit - 1} (+${trimmedByInterval.savedTokens} tok saved).`;
    const allowOut = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
        additionalContext: trimReason,
        savedTokens: trimmedByInterval.savedTokens
      }
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(allowOut),
      stderr: '',
      verdict: {
        triggered: true,
        detectorId: 'DET-06',
        subType: 'READ_INTERVAL_TRIM',
        decision: 'allow',
        updatedInput,
        savedTokens: trimmedByInterval.savedTokens,
        reason: trimReason
      }
    };
  }

  // Record clean explicitly sliced Read interval into Read-Interval Ledger
  if (
    isReadTool &&
    hasExplicitLineSlice &&
    rawReadPath &&
    shouldPersistState &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask' &&
    verdict.decision !== 'defer' &&
    !/\.(?:ipynb|pdf)$/i.test(rawReadPath)
  ) {
    try {
      const baseCwdForRec = event.cwd || options.cwd || '';
      if (baseCwdForRec) {
        const absRecPath = path.isAbsolute(rawReadPath)
          ? rawReadPath
          : path.resolve(baseCwdForRec, rawReadPath);
        if (fs.existsSync(absRecPath) && fs.statSync(absRecPath).isFile()) {
          const stRec = fs.statSync(absRecPath);
          if (stRec.size > 0 && stRec.size <= 1024 * 1024) {
            const rawRecSrc = fs.readFileSync(absRecPath, 'utf8');
            const totalRecLines = rawRecSrc.length === 0 ? 0 : rawRecSrc.replace(/\r\n/g, '\n').split('\n').length;
            const recStart = effectiveSliceOffset || 1;
            const recEnd = effectiveSliceLimit
              ? Math.min(totalRecLines, recStart + effectiveSliceLimit - 1)
              : totalRecLines;
            const { snapFilePath: recSnapPath, store: recStore } = loadReadSnapStore(baseCwdForRec, sessionId);
            recordReadIntervalEntry(
              recStore,
              absRecPath.replace(/\\/g, '/').toLowerCase(),
              stRec,
              recStart,
              recEnd
            );
            saveReadSnapStore(recSnapPath, recStore);
          }
        }
      }
    } catch (recIntErr) {
      void recIntErr;
    }
  }

  if (isReadTool && !hasLineBounds && rawReadPath) {
    try {
      const baseCwd = event.cwd || options.cwd || '';
      const absReadPath = path.isAbsolute(rawReadPath)
        ? rawReadPath
        : path.resolve(baseCwd || process.cwd(), rawReadPath);
      if (fs.existsSync(absReadPath) && fs.statSync(absReadPath).isFile()) {
        const st = fs.statSync(absReadPath);
        if (st.size > 256 && st.size <= 256 * 1024) {
          const rawSrc = fs.readFileSync(absReadPath, 'utf8');
          const totalRawLines = rawSrc.length === 0 ? 0 : rawSrc.replace(/\r\n/g, '\n').split('\n').length;
          const normKey = absReadPath.replace(/\\/g, '/').toLowerCase();
          let prevSrc = typeof event.priorContentSnapshot === 'string' ? event.priorContentSnapshot : null;
          let snapFilePath = '';
          let snapMap = {};

          if (baseCwd && shouldPersistState) {
            const loadedSnap = loadReadSnapStore(baseCwd, sessionId);
            snapFilePath = loadedSnap.snapFilePath;
            snapMap = loadedSnap.store;
            if (prevSrc === null && typeof snapMap[normKey] === 'string') {
              prevSrc = snapMap[normKey];
            }
          }

          if (prevSrc !== null && prevSrc !== rawSrc) {
            const delta = getCodeFoldMod().computeCompactLineDiff(prevSrc, rawSrc, path.basename(absReadPath));
            if (delta.wasDiffed) {
              // OPT-3C: Clamp underlying Read via updatedInput to changed hunk instead of loading full file + diff
              const hunkWin = getCodeFoldMod().computePostEditReadWindow({
                prevContent: prevSrc,
                nextContent: rawSrc,
                windowLines: 40
              });
              const g4UpdatedInput = { ...tIn };
              delete g4UpdatedInput.StartLine;
              delete g4UpdatedInput.EndLine;
              g4UpdatedInput.offset = hunkWin.windowStart;
              g4UpdatedInput.limit = hunkWin.windowLimit;
              verdict.updatedInput = g4UpdatedInput;
              verdict.triggered = true;
              verdict.detectorId = verdict.detectorId || 'DET-06';
              verdict.decision = verdict.decision || 'allow';
              verdict.deltaDiffStub = delta.diffText;
              verdict.savedTokens = Math.max(Number(verdict.savedTokens || 0), delta.savedTokens);
              verdict.reason = `[GUARD-4 Post-Edit Delta Read] Clamped Read to edited window L${hunkWin.windowStart}-L${hunkWin.windowEnd}; delta (+${delta.savedTokens} tokens saved):\n${delta.diffText}`;
            }
          } else if (verdict.detectorId === 'DET-06' || Number(event.priorUnclippedReads || 0) >= 2) {
            const folded = getCodeFoldMod().foldCodeToSignatureStub(rawSrc, rawReadPath);
            if (folded.wasFolded) {
              // OPT-3C: Clamp repeat Read via updatedInput to a 20-line header anchor alongside AST stub
              const astUpdatedInput = { ...tIn };
              delete astUpdatedInput.StartLine;
              delete astUpdatedInput.EndLine;
              astUpdatedInput.offset = 1;
              astUpdatedInput.limit = Math.max(1, Math.min(20, totalRawLines));
              const stubSavedTok = Math.max(250, Math.round(folded.savedChars / 4));
              verdict.updatedInput = astUpdatedInput;
              verdict.triggered = true;
              verdict.detectorId = verdict.detectorId || 'DET-06';
              verdict.decision = verdict.decision || 'allow';
              verdict.astSignatureStub = folded.condensed;
              verdict.savedTokens = Math.max(Number(verdict.savedTokens || 0), stubSavedTok);
              verdict.reason = `${verdict.reason ? verdict.reason + '\n\n' : '[GUARD-4 Repeat-Read Surgeon] Full-file re-read clamped to 20L anchor; AST signature stub (+' + stubSavedTok + ' tokens saved):\n'}${folded.condensed}`;
            }
          }

          if (snapFilePath && rawSrc.length <= 128 * 1024) {
            snapMap[normKey] = rawSrc;
            if (!verdict.deltaDiffStub && !verdict.astSignatureStub && verdict.decision !== 'deny') {
              recordReadIntervalEntry(snapMap, normKey, st, 1, totalRawLines);
            }
            saveReadSnapStore(snapFilePath, snapMap);
          }
        }
      }
    } catch (_stubErr) {
      void _stubErr;
    }
  }

  const hasExplicitCwd = Boolean(event.cwd || options.cwd);

  // Bucket B Coach/Shadow Pass (B-Alpha defaults to COACH; B-Beta & B-Gamma default to SHADOW)
  if (!verdict.triggered && options.bucketBShadow !== false) {
    try {
      const priorUnverifiedEdits = Array.isArray(event.editsSinceVerify)
        ? event.editsSinceVerify
        : engine.codeEditedSinceLastTest
          ? engine.unverifiedEdits
          : [];
      const shadowRes = getBucketBMod().runBucketBPreToolShadowPass({
        platform: 'claude',
        sessionId,
        cwd: event.cwd || options.cwd || '',
        hasExplicitCwd,
        toolName,
        toolInput: tIn,
        lastUserPrompt: event.prompt || engine.lastUserPrompt || '',
        editsSinceVerify: priorUnverifiedEdits,
        options: {
          ...options,
          cliCapabilities: event.cliCapabilities || options.cliCapabilities,
          lspCapabilities: event.lspCapabilities || options.lspCapabilities,
          bucketBStage: event.bucketBStage ?? options.bucketBStage,
          bucketBGammaStage: event.bucketBGammaStage ?? options.bucketBGammaStage,
          bucketBLspStage: event.bucketBLspStage ?? options.bucketBLspStage,
          persistState: shouldPersistState,
          mode: effectiveMode,
          horizonConfig
        }
      });
      if (shadowRes.triggered && shadowRes.activeRecords.length > 0) {
        const primaryEntry =
          shadowRes.activeRecords.find((r) => r.verdict.decision === 'ask') ||
          shadowRes.activeRecords[0];
        const topRec = primaryEntry.verdict;
        verdict.triggered = true;
        verdict.decision = topRec.decision === 'ask' ? 'ask' : 'allow';
        verdict.detectorId = topRec.code || 'BUCKET_B_GUARD';
        verdict.reason = shadowRes.activeRecords
          .map((r) => r.verdict.reason)
          .filter(Boolean)
          .join('\n');
        const maxSavedTokens = Math.max(
          0,
          ...shadowRes.activeRecords.map((r) => Number(r.verdict.tokensSavedEst || 0))
        );
        if (maxSavedTokens > 0) {
          verdict.savedTokens = Math.max(
            Number(verdict.savedTokens || 0),
            maxSavedTokens
          );
        }

        // OPT-5A: Auto-tier unmistakable read-only scouts to Haiku in AUTO_PILOT unless user pinned Frontier
        if (/^(?:Task|Agent)$/i.test(toolName) && effectiveMode === 'AUTO_PILOT') {
          const scoutGov = shadowRes.activeRecords.find(
            (r) =>
              r.verdict?.code === 'SUBAGENT_TEAM_GOVERNOR' &&
              r.verdict?.isReadOnlyScout === true &&
              r.verdict?.recommendedModel === 'flash_or_haiku'
          );
          const userPromptTxt = String(event.prompt || engine.lastUserPrompt || '');
          const hasExplicitFrontierPin =
            /\b(?:use\s+(?:opus|sonnet|pro|fable|mythos)|with\s+(?:opus|sonnet|pro)|model\s*[:=]\s*(?:opus|sonnet|pro))\b/i.test(
              userPromptTxt
            );
          if (scoutGov && !hasExplicitFrontierPin) {
            verdict.updatedInput = { ...tIn, model: 'haiku' };
            verdict.autoTieredModel = 'haiku';
            verdict.decision = 'allow';
          }
        }
      }
    } catch (_shadowErr) {
      // Non-fatal Bucket B shadow/coach pass
    }
  }

  if (
    shouldPersistState &&
    /^(?:Edit|MultiEdit|Write|NotebookEdit)$/i.test(toolName) &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask'
  ) {
    const rawEditPath = String(
      tIn.file_path || tIn.Path || tIn.path || tIn.filePath || ''
    ).trim();
    if (rawEditPath) {
      const addedTxt = String(
        tIn.new_string ??
          tIn.content ??
          tIn.newText ??
          (Array.isArray(tIn.edits) ? tIn.edits.map((e) => e?.new_string ?? '').join('\n') : '') ??
          ''
      );
      const oldTxt = String(
        tIn.old_string ??
          tIn.oldText ??
          (Array.isArray(tIn.edits) ? tIn.edits.map((e) => e?.old_string ?? '').join('\n') : '') ??
          ''
      );
      const changedLines = addedTxt.split(/\r?\n/);
      const netLines = changedLines.filter((l) => l.trim().length > 0).length;
      const deletedLineCount = oldTxt ? oldTxt.split(/\r?\n/).length : 0;
      if (!Array.isArray(engine.unverifiedEdits)) engine.unverifiedEdits = [];
      engine.unverifiedEdits.push({
        filePath: rawEditPath,
        netLines,
        changedLines: changedLines.slice(0, 64)
      });
      if (engine.unverifiedEdits.length > 32) {
        engine.unverifiedEdits = engine.unverifiedEdits.slice(-32);
      }
      if (!Array.isArray(engine.turnFileDiffs)) engine.turnFileDiffs = [];
      engine.turnFileDiffs.push({
        filePath: rawEditPath,
        addedLines: addedTxt ? changedLines.slice(0, 400) : [],
        deletedLineCount
      });
      if (engine.turnFileDiffs.length > 32) {
        engine.turnFileDiffs = engine.turnFileDiffs.slice(-32);
      }
      if (event.prompt) {
        engine.lastUserPrompt = String(event.prompt);
      }
      engine.codeEditedSinceLastTest = true;
      if (!isNonCodeDocOrArtifactPath(rawEditPath)) {
        engine.taskBoundaryState = {
          openFailure: Boolean(engine.taskBoundaryState?.openFailure),
          editsSinceBoundary: Math.max(0, Number(engine.taskBoundaryState?.editsSinceBoundary || 0)) + 1,
          lastBoundarySuggestedTurn: engine.taskBoundaryState?.lastBoundarySuggestedTurn ?? null
        };
        clearTurnBoundaryFlag = true;
      }

      // Record recent-edit marker + pre-edit file snapshot for IMP-4B immediate verify re-read fold
      try {
        const baseCwdForEdit = event.cwd || options.cwd || '';
        if (baseCwdForEdit) {
          const absEditPath = path.isAbsolute(rawEditPath)
            ? rawEditPath
            : path.resolve(baseCwdForEdit, rawEditPath);
          const normEditKey = absEditPath.replace(/\\/g, '/').toLowerCase();
          const { snapFilePath: editSnapPath, store: editStore } = loadReadSnapStore(baseCwdForEdit, sessionId);
          editStore.__turnSeq = Number(editStore.__turnSeq || 0) + 1;
          let preEditSrc = '';
          if (fs.existsSync(absEditPath) && fs.statSync(absEditPath).isFile() && fs.statSync(absEditPath).size <= 128 * 1024) {
            preEditSrc = fs.readFileSync(absEditPath, 'utf8');
            editStore[normEditKey] = preEditSrc;
          } else if (typeof editStore[normEditKey] === 'string') {
            preEditSrc = editStore[normEditKey];
          }
          if (!editStore.__recentEdits || typeof editStore.__recentEdits !== 'object') {
            editStore.__recentEdits = {};
          }
          editStore.__recentEdits[normEditKey] = {
            turn: editStore.__turnSeq,
            timestampMs: Date.now(),
            approxLineStart: resolveApproxEditLine(preEditSrc, oldTxt, tIn.StartLine ?? tIn.start_line)
          };
          if (editStore.__readIntervals && typeof editStore.__readIntervals === 'object') {
            delete editStore.__readIntervals[normEditKey];
          }
          saveReadSnapStore(editSnapPath, editStore);
        }
      } catch (editSnapErr) {
        void editSnapErr;
      }
    }
  }

  if (
    shouldPersistState &&
    /^(?:Bash|PowerShell|pwsh|cmd|sh|run_command|execute_bash)$/i.test(toolName) &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask'
  ) {
    const shellCmd = String(tIn.command || tIn.CommandLine || tIn.cmd || '');
    if (shellCmd && MUTATING_SHELL_INTERVAL_RE.test(shellCmd)) {
      try {
        const baseCwdForShell = event.cwd || options.cwd || '';
        if (baseCwdForShell) {
          const { snapFilePath: shSnapPath, store: shStore } = loadReadSnapStore(baseCwdForShell, sessionId);
          if (shStore.__readIntervals && Object.keys(shStore.__readIntervals).length > 0) {
            shStore.__readIntervals = {};
            saveReadSnapStore(shSnapPath, shStore);
          }
        }
      } catch (shIntErr) {
        void shIntErr;
      }
    }
  }

  saveBreakerWithBoundaryPreserved();

  // Option A Shadow Auto tracking: silent local log when Coach/Off would have been gated by Auto
  const SHADOW_DET_RE = /^(DET-04|DET-09|DET-12|DET-16|DET-26|DET-30)$/;
  let shadowMissDet = null;
  let shadowMissReason = '';
  let shadowMissPenaltyUsd = null;
  if (
    effectiveMode !== 'AUTO_PILOT' &&
    verdict.triggered &&
    verdict.decision !== 'deny' &&
    SHADOW_DET_RE.test(String(verdict.detectorId || ''))
  ) {
    shadowMissDet = String(verdict.detectorId);
    shadowMissReason = String(verdict.reason || '');
    shadowMissPenaltyUsd = verdict.estimatedPenaltyUSD ?? verdict.avoidedPenaltyUSD ?? null;
  } else if (effectiveMode === 'OFF' && !verdict.triggered) {
    try {
      const shadowEngine = new CircuitBreakerEngine({
        ...cwdOptions,
        horizonConfig,
        mode: 'AUTO_PILOT',
        initialState: priorSnapshot ? structuredClone(priorSnapshot) : null
      });
      const autoCheck = shadowEngine.evaluatePreToolUse(
        { ...enrichedEvent, mode: 'AUTO_PILOT' },
        { ...liveState, flightMode: 'AUTO_PILOT' }
      );
      if (
        autoCheck?.triggered &&
        (autoCheck.decision === 'deny' || autoCheck.decision === 'defer') &&
        SHADOW_DET_RE.test(String(autoCheck.detectorId || ''))
      ) {
        shadowMissDet = String(autoCheck.detectorId);
        shadowMissReason = String(autoCheck.reason || '');
        shadowMissPenaltyUsd = autoCheck.estimatedPenaltyUSD ?? autoCheck.avoidedPenaltyUSD ?? null;
      }
    } catch {
      // Non-fatal Shadow Auto pass
    }
  }
  if (shadowMissDet) {
    const mappedCategory =
      shadowMissDet === 'DET-16'
        ? 'COLD_SWARM_WAKEUP'
        : shadowMissDet === 'DET-09'
          ? 'PREFIX_MUTATION_BUST'
          : 'RUNAWAY_LOOP_TURN';
    const fallbackUsd = shadowMissDet === 'DET-16' ? 0.55 : shadowMissDet === 'DET-09' ? 0.25 : 0.35;
    const resolvedMissUsd =
      Number.isFinite(Number(shadowMissPenaltyUsd)) && Number(shadowMissPenaltyUsd) > 0
        ? Number(shadowMissPenaltyUsd)
        : fallbackUsd;
    getShadowAutoMod().recordShadowAutoMiss(
      {
        sessionId,
        workspacePath: event.cwd || options.cwd || '',
        harness: 'claude-code',
        effectiveMode,
        category: mappedCategory,
        detectorId: shadowMissDet,
        turnKey:
          event.tool_use_id ||
          event.toolUseId ||
          event.turn_id ||
          event.turnId ||
          `${shadowMissDet}:${toolName}`,
        wastedTokens:
          computedEventPromptTokens || Number(liveState?.contextWindow?.cachedTokens || 30000),
        missedUsd: resolvedMissUsd,
        avoidedPrompts: 1,
        detail: shadowMissReason.slice(0, 160)
      },
      {
        ...cwdOptions,
        ...(event.shadowLedgerPath ? { shadowLedgerPath: event.shadowLedgerPath } : {})
      }
    );
  }

  if (!verdict.triggered) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      verdict
    };
  }

  const detId = String(verdict.detectorId || '');
  const isQuotaSavingGuard =
    /^(DET-04|DET-06|DET-09|DET-10|DET-11|DET-12|DET-13|DET-14|DET-20|SLOPSQUAT_DEP_GATE|BLAST_RADIUS_BREAKER|DUPLICATE_CLONE_DETECTOR|EVILGENIE_HARDCODED_ORACLE|SUBAGENT_TEAM_GOVERNOR|MCP_CLI_ROUTER)$/.test(
      detId
    );
  if (
    isQuotaSavingGuard &&
    (verdict.decision === 'deny' ||
      verdict.decision === 'ask' ||
      verdict.decision === 'defer' ||
      Boolean(verdict.astSignatureStub) ||
      Boolean(verdict.deltaDiffStub)) &&
    options.recordLedger !== false &&
    Boolean(event.cwd || options.cwd || options.ledgerPath || options.recordLedger)
  ) {
    const isPrefixFence = detId === 'DET-09';
    const isBoundedRead =
      detId === 'DET-11' || Boolean(verdict.astSignatureStub) || Boolean(verdict.deltaDiffStub);
    const estimatedSavedTokens = Math.max(
      0,
      Number(
        verdict.savedTokens ||
          verdict.estimatedTokensSaved ||
          (isPrefixFence ? liveState?.contextWindow?.cachedTokens || 25000 : 4000)
      )
    );
    getSavedQuotaMod().recordInterventionSavings(
      {
        sessionId,
        category: isPrefixFence
          ? 'DET_09_PREFIX_FENCE'
          : isBoundedRead
            ? 'BOUNDED_READ_ENFORCED'
            : 'LOOP_TURN_PREVENTED',
        modelId: liveState?.modelId || 'claude-sonnet-5-5',
        savedTokens: estimatedSavedTokens,
        savedUSD: Math.max(0, Number(verdict.avoidedPenaltyUSD || 0)),
        dedupeId:
          event.tool_use_id ||
          event.toolUseId ||
          event.turn_id ||
          event.turnId ||
          `${detId}:${event.tool_name || event.toolName || 'tool'}`,
        detail: `${detId} intervention (${verdict.decision}): ${String(verdict.reason || '').slice(0, 120)}`
      },
      cwdOptions
    );
  }

  if (
    (verdict.decision === 'deny' || verdict.decision === 'defer') &&
    detId === 'DET-09' &&
    /^(?:Edit|MultiEdit|Write|NotebookEdit)$/i.test(toolName) &&
    shouldPersistState &&
    (event.cwd || options.cwd) &&
    options.stagePrefixDelta !== false
  ) {
    const stageTarget = String(
      tIn.file_path || tIn.Path || tIn.path || tIn.filePath || ''
    ).trim();
    const stageNewTxt = String(
      tIn.new_string ??
        tIn.content ??
        tIn.newText ??
        (Array.isArray(tIn.edits) ? tIn.edits.map((e) => e?.new_string ?? '').join('\n') : '') ??
        ''
    );
    const stageOldTxt = String(
      tIn.old_string ??
        tIn.oldText ??
        (Array.isArray(tIn.edits) ? tIn.edits.map((e) => e?.old_string ?? '').join('\n') : '') ??
        ''
    );
    if (stageTarget && (stageOldTxt || stageNewTxt)) {
      try {
        const baseCwdForStage = event.cwd || options.cwd;
        const absStagePath = path.isAbsolute(stageTarget)
          ? stageTarget
          : path.resolve(baseCwdForStage, stageTarget);
        const queuePath = path.join(
          path.resolve(baseCwdForStage),
          '.claude',
          'cache',
          'pending_prefix_deltas.json'
        );
        let queue = [];
        if (fs.existsSync(queuePath)) {
          const parsedQ = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
          if (Array.isArray(parsedQ)) queue = parsedQ;
        }
        const deltaOp = stageOldTxt
          ? 'MODIFY'
          : /^Write$/i.test(toolName)
            ? 'REPLACE'
            : 'ADD';
        queue.push({
          id: `cc-delta-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          targetPath: absStagePath,
          operation: deltaOp,
          targetText: stageOldTxt || null,
          replacementText: stageOldTxt ? stageNewTxt : null,
          newContent: !stageOldTxt ? stageNewTxt : null,
          ruleText: !stageOldTxt ? stageNewTxt : null,
          createdAt: new Date().toISOString()
        });
        fs.mkdirSync(path.dirname(queuePath), { recursive: true });
        atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2));
        verdict.prefixDeltaStaged = true;
        verdict.stagedCount = queue.length;
        verdict.stagedQueuePath = queuePath;
        verdict.reason = `${verdict.reason} [Highbeam staged edit #${queue.length} for automatic flush on PostCompact]`;
      } catch (ccStageErr) {
        void ccStageErr;
      }
    }
  }

  if (verdict.decision === 'ask' || verdict.decision === 'defer') {
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision === 'defer' ? 'defer' : 'ask',
        permissionDecisionReason: verdict.reason
      }
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(out),
      stderr: '',
      verdict
    };
  }

  if (verdict.decision === 'deny') {
    if (options.useJsonDecision) {
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(out),
        stderr: '',
        verdict
      };
    }
    return {
      exitCode: 2,
      stdout: '',
      stderr: verdict.reason,
      verdict
    };
  }

  // ISS-034: Coach advisory on 'allow' uses additionalContext so Claude sees the message!
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}),
      additionalContext: verdict.reason,
      ...(verdict.astSignatureStub ? { astSignatureStub: verdict.astSignatureStub, savedTokens: verdict.savedTokens } : {}),
      ...(verdict.deltaDiffStub ? { deltaDiffStub: verdict.deltaDiffStub, savedTokens: verdict.savedTokens } : {})
    }
  };
  return {
    exitCode: 0,
    stdout: JSON.stringify(out),
    stderr: '',
    verdict,
    ...(verdict.astSignatureStub ? { decision: 'allow', astSignatureStub: verdict.astSignatureStub, savedTokens: verdict.savedTokens } : {}),
    ...(verdict.deltaDiffStub ? { decision: 'allow', deltaDiffStub: verdict.deltaDiffStub, savedTokens: verdict.savedTokens } : {})
  };
}
