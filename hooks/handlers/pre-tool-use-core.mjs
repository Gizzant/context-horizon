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

  const eventUsage = event.usage || event.context_window?.current_usage || null;
  const computedEventPromptTokens = Math.max(
    computeTotalPromptTokens(event),
    eventUsage ? computeTotalPromptTokens(eventUsage) : 0
  );
  const enrichedEvent = {
    ...event,
    ...(computedEventPromptTokens > 0 && event.totalPromptTokens === undefined
      ? { totalPromptTokens: computedEventPromptTokens }
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
        writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
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
        writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
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
              writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
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

  if (
    isReadTool &&
    !hasLineBounds &&
    rawReadPath &&
    verdict.decision !== 'deny' &&
    verdict.decision !== 'ask' &&
    verdict.decision !== 'defer'
  ) {
    const baseCwdForShield = event.cwd || options.cwd || process.cwd();
    const shieldVerdict = getShieldMod().evaluateShieldReadGuard({
      platform: 'claude',
      sessionId,
      cwd: baseCwdForShield,
      filePath: rawReadPath,
      hasSliceBounds: false,
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
        writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
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
      if (shouldPersistState) {
        writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
      }
      const updatedInput = { ...tIn };
      delete updatedInput.StartLine;
      delete updatedInput.EndLine;
      updatedInput.offset = shieldVerdict.clampOffset || 1;
      updatedInput.limit = shieldVerdict.clampLimit;
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
          subType: 'BYTE_WIDTH_CLAMP',
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
              verdict.triggered = true;
              verdict.detectorId = verdict.detectorId || 'DET-06';
              verdict.decision = verdict.decision || 'allow';
              verdict.deltaDiffStub = delta.diffText;
              verdict.savedTokens = Math.max(Number(verdict.savedTokens || 0), delta.savedTokens);
              verdict.reason = `[GUARD-4 Post-Edit Delta Read] File modified since last read; returning unified delta diff (+${delta.savedTokens} tokens saved):\n${delta.diffText}`;
            }
          } else if (verdict.detectorId === 'DET-06' || Number(event.priorUnclippedReads || 0) >= 2) {
            const folded = getCodeFoldMod().foldCodeToSignatureStub(rawSrc, rawReadPath);
            if (folded.wasFolded) {
              const stubSavedTok = Math.max(250, Math.round(folded.savedChars / 4));
              verdict.triggered = true;
              verdict.detectorId = verdict.detectorId || 'DET-06';
              verdict.decision = verdict.decision || 'allow';
              verdict.astSignatureStub = folded.condensed;
              verdict.savedTokens = Math.max(Number(verdict.savedTokens || 0), stubSavedTok);
              verdict.reason = `${verdict.reason ? verdict.reason + '\n\n' : '[GUARD-4 Repeat-Read Surgeon] Full-file re-read intercepted; returning AST signature stub (+' + stubSavedTok + ' tokens saved):\n'}${folded.condensed}`;
            }
          }

          if (snapFilePath && rawSrc.length <= 128 * 1024) {
            snapMap[normKey] = rawSrc;
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
          saveReadSnapStore(editSnapPath, editStore);
        }
      } catch (editSnapErr) {
        void editSnapErr;
      }
    }
  }

  if (shouldPersistState) {
    writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);
  }

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
