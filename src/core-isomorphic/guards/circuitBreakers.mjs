/**
 * @file src/guards/circuitBreakers.mjs
 * Normalized 20-Detector Circuit Breaker Engine (`DET-01` through `DET-20`)
 * for Claude Code Highbeam.
 *
 * Enforces:
 * - Option-argument skipping in `DET-01` (`git commit -m "-next"` never false-positives as `-n`)
 * - Allowlist for `.env.example`, `.env.sample`, `.env.template` in `DET-02`
 * - Manual-edit-only lockfile gate in `DET-03` (`npm install` via Bash/PowerShell is allowed)
 * - Added/deleted diff-line-only scanning in `DET-05` (never scans whole file, never runs `git checkout --`)
 * - Unicode tag `U+E0000`..`U+E007F` stripping & `<untrusted_subagent_data>` wrapping in `DET-19`
 * - Dotfile-aware multi-agent scope locks in `DET-20`
 */

import {
  path,
  sha256Hex,
  getFileByteSizeSafe,
  resolvePath,
  getCwd,
  readJsonSafe,
  writeJsonAtomic,
  readTextSafe,
  fileExists
} from '../utils/runtime.mjs';
import { normalizeModelId, computeTotalPromptTokens } from '../config/catalogLoader.mjs';
import {
  loadHorizonConfig,
  resolveDetectorOverride,
  applyDetectorOverride
} from '../config/horizonConfig.mjs';
import { recordRepoFileRead } from '../coach/repoCalibration.mjs';
import {
  FLIGHT_MODES,
  normalizeFlightMode,
  isSilentOrOffMode,
  isPrefixInstructionFile,
  evaluateDet09PrefixMutationFence,
  CacheGravityRouter
} from '../coach/cacheGravityRouter.mjs';

export { isPrefixInstructionFile, evaluateDet09PrefixMutationFence };
import { TtlWatchdog } from '../coach/ttlWatchdog.mjs';
import { evaluateScopeAndQuotaBrake } from '../telemetry/scopeLockRegistry.mjs';
import { loadMicroSkillsRegistry, evaluateMicroSkillIntercept } from '../coach/microSkills.mjs';
import {
  RELAY_STATES,
  evaluateScopeBrake,
  evaluateRelayBreaker,
  evaluateTwoStageSightseeingIntercept
} from '../coach/promptHygieneGovernor.mjs';

import {
  SHELL_TOOL_REGEX,
  EDIT_WRITE_TOOL_REGEX,
  SEARCH_READ_TOOL_REGEX,
  tokenizeShellSegment,
  evaluateDet01GitAndShellSafety,
  evaluateDet02SecretBoundary,
  evaluateDet03ProtectedFilesAskGate
} from './det01_03_shell_secret.mjs';
import {
  evaluateDet04ConsecutiveFailures,
  computeAddedAndDeletedDiffLines,
  hashFileContent,
  evaluateDet05DiffThrashing,
  evaluateDet06BlindSearchGuard,
  evaluateDet07OutputBombGuard,
  evaluateDet11ContextRotGate,
  evaluateDet12HaikuPreCliffBreaker
} from './det04_12_thrash_rot.mjs';
import {
  evaluateDet13McpSchemaBloatGuard,
  evaluateDet14PrematureStopGate,
  evaluateDet15BatchedStopFormatter,
  evaluateDet15PreFormatBypass,
  evaluateDet16SubagentRecursionCap,
  evaluateDet17AutoCompactionDeferral,
  evaluateSilentPrefixMutations,
  evaluateDet18UntrustedSettingsGuard,
  evaluateDet19SubagentIpiSanitizer,
  evaluateDet20ScopeLockAndQuotaBrake
} from './det13_20_mcp_scope.mjs';

export {
  tokenizeShellSegment,
  evaluateDet01GitAndShellSafety,
  evaluateDet02SecretBoundary,
  evaluateDet03ProtectedFilesAskGate,
  evaluateDet04ConsecutiveFailures,
  computeAddedAndDeletedDiffLines,
  hashFileContent,
  evaluateDet05DiffThrashing,
  evaluateDet06BlindSearchGuard,
  evaluateDet07OutputBombGuard,
  evaluateDet11ContextRotGate,
  evaluateDet12HaikuPreCliffBreaker,
  evaluateDet13McpSchemaBloatGuard,
  evaluateDet14PrematureStopGate,
  evaluateDet15BatchedStopFormatter,
  evaluateDet15PreFormatBypass,
  evaluateDet16SubagentRecursionCap,
  evaluateDet17AutoCompactionDeferral,
  evaluateSilentPrefixMutations,
  evaluateDet18UntrustedSettingsGuard,
  evaluateDet19SubagentIpiSanitizer,
  evaluateDet20ScopeLockAndQuotaBrake
};

/**
 * Sanitizes a session ID for `.claude/cache/ah_breaker_state_<sessionId>.json`.
 * @param {string} [sessionId='default']
 * @returns {string}
 */
export function sanitizeBreakerSessionId(sessionId = 'default') {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Resolves the atomic CLI circuit-breaker state file path (`.claude/cache/ah_breaker_state_<sessionId>.json`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {string}
 */
export function getBreakerStateFilePath(sessionId = 'default', options = {}) {
  if (options?.breakerStatePath) {
    return options.breakerStatePath;
  }
  const cwd = getCwd(options);
  return path.join(
    cwd,
    '.claude',
    'cache',
    `ah_breaker_state_${sanitizeBreakerSessionId(sessionId)}.json`
  );
}

/**
 * Safely reads a persisted `CircuitBreakerEngine` snapshot from disk (`ISS-038`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function readBreakerStateSnapshot(sessionId = 'default', options = {}) {
  return readJsonSafe(getBreakerStateFilePath(sessionId, options), null, options);
}

/**
 * Atomically writes a `CircuitBreakerEngine` snapshot to disk (`ISS-038`).
 * @param {string} [sessionId='default']
 * @param {object} [snapshot={}]
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function writeBreakerStateSnapshot(sessionId = 'default', snapshot = {}, options = {}) {
  return writeJsonAtomic(getBreakerStateFilePath(sessionId, options), snapshot, options);
}

/**
 * Unified Stateful Circuit Breaker Engine (`DET-01`..`DET-20`).
 */
export class CircuitBreakerEngine {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.options = options;
    this.horizonConfig = options.horizonConfig || loadHorizonConfig(options);
    this.mode = normalizeFlightMode(
      options.mode || options.flightMode || this.horizonConfig?.flightMode || FLIGHT_MODES.COACH
    );
    this.consecutiveFailures = Number(options.consecutiveFailures || 0);
    this.lastFailedToolKey = options.lastFailedToolKey || null;
    this.sequentialSearchCount = Number(options.sequentialSearchCount || 0);
    this.fileHashHistory = new Map();
    this.modifiedFilesInTurn = new Set();
    this.pendingBatchEdits = new Set();
    this.pendingFormatFiles = new Set();
    this.codeEditedSinceLastTest = Boolean(options.codeEditedSinceLastTest || false);
    this.lastTurnGitCommitted = Boolean(options.lastTurnGitCommitted || false);
    this.committedTopDirs = Array.isArray(options.committedTopDirs) ? [...options.committedTopDirs] : [];
    this.consecutiveTrivialMaxEffortTurns = Number(options.consecutiveTrivialMaxEffortTurns || 0);
    this.recentEditTimestampsByFile = options.recentEditTimestampsByFile && typeof options.recentEditTimestampsByFile === 'object' ? { ...options.recentEditTimestampsByFile } : {};
    this.totalDiscoveryCalls = Number(options.totalDiscoveryCalls || 0);
    this.consecutiveVisionTurns = Number(options.consecutiveVisionTurns || 0);
    this.unanchoredTurnFlag = Boolean(options.unanchoredTurnFlag || false);
    this.candidateFiles = Array.isArray(options.candidateFiles) ? [...options.candidateFiles] : [];
    this.relayState = options.relayState && typeof options.relayState === 'object'
      ? { ...options.relayState }
      : { state: RELAY_STATES.IDLE, critiquePastes: 0, boundSpecPath: 'SPEC.md' };
    this.steeredPrompts = Number(options.steeredPrompts || 0);
    this.blockedPrompts = Number(options.blockedPrompts || 0);
    this.sightseeingToolsPrevented = Number(options.sightseeingToolsPrevented || 0);
    this.subagentTurns = {};
    this.subagentTokens = {};
    this.det11AdvisedTurn = null;
    this.det13AdvisedTurn = null;
    this.router =
      options.router instanceof CacheGravityRouter
        ? options.router
        : new CacheGravityRouter({ mode: this.mode, ...options });
    this.watchdog =
      options.watchdog instanceof TtlWatchdog
        ? options.watchdog
        : new TtlWatchdog({ mode: this.mode, ...options });

    if (options.initialState && typeof options.initialState === 'object') {
      this.hydrateStateSnapshot(options.initialState);
    }
  }

  /**
   * Updates the active flight mode across the engine, router, and watchdog (`ISS-038`).
   * @param {string} mode
   * @returns {string}
   */
  setMode(mode) {
    this.mode = normalizeFlightMode(mode);
    this.router.setMode(this.mode);
    this.watchdog.setMode(this.mode);
    return this.mode;
  }

  /**
   * Reloads `.attention-horizon.json` and synchronizes flight mode unless pinned by explicit `options.mode`.
   * @param {object} [overrideOptions={}]
   * @returns {object}
   */
  refreshConfig(overrideOptions = {}) {
    const mergedOpts = { ...this.options, ...overrideOptions };
    delete mergedOpts.horizonConfig;
    this.horizonConfig = overrideOptions.horizonConfig || loadHorizonConfig(mergedOpts);
    const nextMode =
      overrideOptions.mode || overrideOptions.flightMode || this.horizonConfig?.flightMode || FLIGHT_MODES.COACH;
    this.setMode(nextMode);
    return this.horizonConfig;
  }

  /**
   * Exports a serializable snapshot of all stateful breaker counters and queues (`ISS-038`).
   * @returns {object}
   */
  exportStateSnapshot() {
    const hashObj = {};
    for (const [k, v] of this.fileHashHistory.entries()) {
      hashObj[k] = Array.isArray(v) ? [...v] : [];
    }
    return {
      schemaVersion: '1.0.0',
      updatedAt: Date.now(),
      mode: this.mode,
      consecutiveFailures: this.consecutiveFailures,
      lastFailedToolKey: this.lastFailedToolKey,
      sequentialSearchCount: this.sequentialSearchCount,
      fileHashHistory: hashObj,
      modifiedFilesInTurn: Array.from(this.modifiedFilesInTurn),
      editedFiles: Array.from(this.modifiedFilesInTurn),
      pendingBatchEdits: Array.from(this.pendingBatchEdits),
      pendingFormatFiles: Array.from(this.pendingFormatFiles),
      codeEditedSinceLastTest: Boolean(this.codeEditedSinceLastTest),
      lastTurnGitCommitted: Boolean(this.lastTurnGitCommitted),
      committedTopDirs: Array.isArray(this.committedTopDirs) ? [...this.committedTopDirs] : [],
      consecutiveTrivialMaxEffortTurns: this.consecutiveTrivialMaxEffortTurns,
      recentEditTimestampsByFile: { ...this.recentEditTimestampsByFile },
      totalDiscoveryCalls: this.totalDiscoveryCalls,
      consecutiveVisionTurns: this.consecutiveVisionTurns,
      unanchoredTurnFlag: Boolean(this.unanchoredTurnFlag),
      candidateFiles: Array.isArray(this.candidateFiles) ? [...this.candidateFiles] : [],
      relayState: this.relayState ? { ...this.relayState } : { state: RELAY_STATES.IDLE, critiquePastes: 0, boundSpecPath: 'SPEC.md' },
      steeredPrompts: Number(this.steeredPrompts || 0),
      blockedPrompts: Number(this.blockedPrompts || 0),
      sightseeingToolsPrevented: Number(this.sightseeingToolsPrevented || 0),
      subagentTurns: { ...this.subagentTurns },
      subagentTokens: { ...this.subagentTokens },
      det11AdvisedTurn: this.det11AdvisedTurn,
      det13AdvisedTurn: this.det13AdvisedTurn,
      queuedMutations: this.router.mutationQueue.toJSON(),
      hysteresisState: this.router.hysteresisLock.getStatus()
    };
  }

  /**
   * Hydrates stateful breaker counters and queues from a previously exported snapshot (`ISS-038`).
   * @param {object | null} snap
   * @returns {this}
   */
  hydrateStateSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return this;

    if (typeof snap.consecutiveFailures === 'number' && Number.isFinite(snap.consecutiveFailures)) {
      this.consecutiveFailures = Math.max(0, snap.consecutiveFailures);
    }
    if (snap.lastFailedToolKey !== undefined) {
      this.lastFailedToolKey = snap.lastFailedToolKey ? String(snap.lastFailedToolKey) : null;
    }
    if (
      typeof snap.sequentialSearchCount === 'number' &&
      Number.isFinite(snap.sequentialSearchCount)
    ) {
      this.sequentialSearchCount = Math.max(0, snap.sequentialSearchCount);
    }
    if (snap.fileHashHistory && typeof snap.fileHashHistory === 'object') {
      this.fileHashHistory = new Map();
      for (const [k, v] of Object.entries(snap.fileHashHistory)) {
        if (Array.isArray(v)) {
          this.fileHashHistory.set(k, v.slice(-6).map(String));
        }
      }
    }
    const editedList = Array.isArray(snap.modifiedFilesInTurn)
      ? snap.modifiedFilesInTurn
      : Array.isArray(snap.editedFiles)
        ? snap.editedFiles
        : null;
    if (editedList) {
      this.modifiedFilesInTurn = new Set(editedList.filter(Boolean).map(String));
    }
    if (Array.isArray(snap.pendingBatchEdits)) {
      this.pendingBatchEdits = new Set(snap.pendingBatchEdits.filter(Boolean).map(String));
    }
    if (Array.isArray(snap.pendingFormatFiles)) {
      this.pendingFormatFiles = new Set(snap.pendingFormatFiles.filter(Boolean).map(String));
    }
    if (typeof snap.codeEditedSinceLastTest === 'boolean') {
      this.codeEditedSinceLastTest = snap.codeEditedSinceLastTest;
    }
    if (typeof snap.lastTurnGitCommitted === 'boolean') {
      this.lastTurnGitCommitted = snap.lastTurnGitCommitted;
    }
    if (Array.isArray(snap.committedTopDirs)) {
      this.committedTopDirs = [...snap.committedTopDirs];
    }
    if (typeof snap.consecutiveTrivialMaxEffortTurns === 'number') {
      this.consecutiveTrivialMaxEffortTurns = snap.consecutiveTrivialMaxEffortTurns;
    }
    if (snap.recentEditTimestampsByFile && typeof snap.recentEditTimestampsByFile === 'object') {
      this.recentEditTimestampsByFile = { ...snap.recentEditTimestampsByFile };
    }
    if (typeof snap.totalDiscoveryCalls === 'number') {
      this.totalDiscoveryCalls = snap.totalDiscoveryCalls;
    }
    if (typeof snap.consecutiveVisionTurns === 'number') {
      this.consecutiveVisionTurns = snap.consecutiveVisionTurns;
    }
    if (typeof snap.unanchoredTurnFlag === 'boolean') {
      this.unanchoredTurnFlag = snap.unanchoredTurnFlag;
    }
    if (Array.isArray(snap.candidateFiles)) {
      this.candidateFiles = [...snap.candidateFiles];
    }
    if (snap.relayState && typeof snap.relayState === 'object') {
      this.relayState = { ...snap.relayState };
    }
    if (typeof snap.steeredPrompts === 'number') {
      this.steeredPrompts = snap.steeredPrompts;
    }
    if (typeof snap.blockedPrompts === 'number') {
      this.blockedPrompts = snap.blockedPrompts;
    }
    if (typeof snap.sightseeingToolsPrevented === 'number') {
      this.sightseeingToolsPrevented = snap.sightseeingToolsPrevented;
    }
    if (snap.subagentTurns && typeof snap.subagentTurns === 'object') {
      this.subagentTurns = { ...snap.subagentTurns };
    }
    if (snap.subagentTokens && typeof snap.subagentTokens === 'object') {
      this.subagentTokens = { ...snap.subagentTokens };
    }
    if (snap.det11AdvisedTurn !== undefined) {
      this.det11AdvisedTurn = snap.det11AdvisedTurn;
    }
    if (snap.det13AdvisedTurn !== undefined) {
      this.det13AdvisedTurn = snap.det13AdvisedTurn;
    }
    if (Array.isArray(snap.queuedMutations)) {
      this.router.mutationQueue.items = [...snap.queuedMutations];
    }
    if (snap.hysteresisState && typeof snap.hysteresisState === 'object') {
      this.router.hysteresisLock.locked = Boolean(snap.hysteresisState.locked);
      this.router.hysteresisLock.pinnedModel = snap.hysteresisState.pinnedModel || null;
      this.router.hysteresisLock.pinnedEffort = snap.hysteresisState.pinnedEffort || null;
      this.router.hysteresisLock.reason = snap.hysteresisState.reason || null;
      this.router.hysteresisLock.lockedAtTurn = snap.hysteresisState.lockedAtTurn ?? null;
    }
    return this;
  }

  /**
   * Evaluates `PreToolUse` across all relevant pre-execution detectors
   * (`DET-01`, `DET-02`, `DET-03`, `DET-04`, `DET-05`, `DET-06`, `DET-07`, `DET-11`, `DET-12`, `DET-13`, `DET-16`, `DET-18`, `DET-19`, `DET-20`),
   * applying any per-detector overrides (`off` | `warn` | `block`) from `.attention-horizon.json`.
   *
   * @param {object} [toolEvent={}]
   * @param {object} [telemetryState={}]
   */
  evaluatePreToolUse(toolEvent = {}, telemetryState = {}) {
    const toolName = String(toolEvent.tool_name || toolEvent.toolName || '');
    const toolInput = toolEvent.tool_input || toolEvent.toolInput || {};
    const command = String(toolInput.command || toolInput.cmd || toolEvent.command || '');
    const filePath = String(
      toolInput.file_path ||
        toolInput.notebook_path ||
        toolInput.filePath ||
        toolInput.path ||
        toolEvent.filePath ||
        ''
    );
    const firstEdit = Array.isArray(toolInput.edits) && toolInput.edits[0] ? toolInput.edits[0] : null;
    let oldText = String(
      toolInput.old_string ?? toolInput.oldText ?? firstEdit?.old_string ?? ''
    );
    if (!oldText && String(toolName).toLowerCase() === 'write' && filePath) {
      oldText = readTextSafe(filePath, null, this.options) || '';
    }
    const newText = String(
      toolInput.new_string ??
        toolInput.new_source ??
        toolInput.content ??
        toolInput.newText ??
        firstEdit?.new_string ??
        ''
    );
    const urlStr = String(toolInput.url || toolEvent.url || '');
    const activeMode = normalizeFlightMode(
      toolEvent.mode || telemetryState.flightMode || this.mode || FLIGHT_MODES.COACH
    );
    const silentCoachMode = isSilentOrOffMode(activeMode);
    const resolveVerdict = (verdict) => applyDetectorOverride(verdict, this.horizonConfig);
    const applyHabitSlug = (slug, verdict) => {
      const slugMode = resolveDetectorOverride(slug, this.horizonConfig);
      if (slugMode === 'off') {
        return { ...verdict, triggered: false, decision: 'allow', suppressedByConfig: true };
      }
      if (slugMode === 'warn') {
        return { ...verdict, triggered: true, decision: 'allow', advisory: true, overrideMode: 'warn' };
      }
      if (slugMode === 'block') {
        return { ...verdict, triggered: true, decision: 'deny', advisory: false, overrideMode: 'block' };
      }
      return resolveVerdict(verdict);
    };
    const isCoachAdvisorySuppressed = (detId) => {
      if (!silentCoachMode) return false;
      const explicitOverride = resolveDetectorOverride(detId, this.horizonConfig);
      return explicitOverride !== 'warn' && explicitOverride !== 'block';
    };

    // 1. DET-20: Quota Hard Brake & Concurrent Scope Lock
    const isSearchRead = SEARCH_READ_TOOL_REGEX.test(toolName);
    const det20 = resolveVerdict(
      evaluateDet20ScopeLockAndQuotaBrake(
        {
          targetFilePath: (EDIT_WRITE_TOOL_REGEX.test(toolName) || isSearchRead) ? filePath : '',
          isRead: isSearchRead,
          toolName,
          ownerId:
            toolEvent.ownerId ||
            toolEvent.agentId ||
            toolEvent.subagentId ||
            telemetryState.sessionId ||
            'default',
          rateLimits: telemetryState.rateLimits || {}
        },
        this.options
      )
    );
    if (det20.triggered) return det20;

    // 1.0b Two-Stage Prompt Hygiene Sightseeing Interception (Scope Brake & Relay Breaker Web Search)
    const scopeOverride = resolveDetectorOverride('vague-prompt-rubric', this.horizonConfig);
    const relayOverride = resolveDetectorOverride('relay-breaker', this.horizonConfig);
    const twoStage = evaluateTwoStageSightseeingIntercept({
      toolName,
      toolArgs: toolInput,
      unanchoredTurnFlag: Boolean(toolEvent.unanchoredTurnFlag ?? this.unanchoredTurnFlag),
      candidateFiles: Array.isArray(toolEvent.candidateFiles)
        ? toolEvent.candidateFiles
        : (this.candidateFiles.length > 0 ? this.candidateFiles : Array.from(this.modifiedFilesInTurn)),
      relayState: toolEvent.relayState ?? this.relayState,
      overrideMode: scopeOverride !== 'default' ? scopeOverride : relayOverride,
      flightMode: activeMode,
      detectorId: 'DET-14'
    });
    if (twoStage.intercepted) {
      if (twoStage.consumeFlag) {
        this.unanchoredTurnFlag = false;
      }
      this.sightseeingToolsPrevented = Number(this.sightseeingToolsPrevented || 0) + 1;
      return {
        detectorId: 'DET-14',
        triggered: true,
        subType: twoStage.subType,
        decision: twoStage.decision,
        advisory: twoStage.decision === 'allow',
        reason: twoStage.reason
      };
    }

    // 1a. RSI-04 ('micro-skills'): Intercept known-broken repo shell commands
    if (SHELL_TOOL_REGEX.test(toolName) && command) {
      const msOverride = resolveDetectorOverride('micro-skills', this.horizonConfig);
      if (msOverride !== 'off') {
        const msReg = loadMicroSkillsRegistry(this.options);
        const msIntercept = evaluateMicroSkillIntercept(msReg, {
          command,
          flightMode: activeMode,
          overrideMode: msOverride
        });
        if (msIntercept.triggered) {
          return {
            detectorId: 'RSI-04',
            triggered: true,
            subType: msIntercept.subType,
            decision: msIntercept.decision,
            advisory: msIntercept.decision === 'allow',
            failedCmd: msIntercept.failedCmd,
            workingCmd: msIntercept.workingCmd,
            reason: msIntercept.reason
          };
        }
      }
    }

    // 1b. DET-15 ('formatter-bypass'): Local Formatter Bypass on pasted code block
    const det15Bypass = evaluateDet15PreFormatBypass({
      prompt: toolEvent.prompt || toolEvent.user_input || toolInput.prompt || '',
      newText,
      lineCount: toolEvent.fullFileNewLines || (newText ? newText.split(/\r?\n/).length : 0)
    });
    if (det15Bypass.triggered) {
      const resolved = applyHabitSlug('formatter-bypass', det15Bypass);
      if (resolved.triggered) return resolved;
    }

    // 1c. DET-05 ('drip-feed'): Conversational Drip-Feeding Detector (<90s window)
    if (EDIT_WRITE_TOOL_REGEX.test(toolName) && filePath) {
      const now = Number(toolEvent.timestampMs ?? toolEvent.nowMs ?? Date.now());
      this.recentEditTimestampsByFile = this.recentEditTimestampsByFile || {};
      const tsList = (this.recentEditTimestampsByFile[filePath] || []).filter((t) => (now - t) <= 90000);
      tsList.push(now);
      this.recentEditTimestampsByFile[filePath] = tsList;
      if (tsList.length >= 4) {
        const det05Drip = applyHabitSlug('drip-feed', {
          detectorId: 'DET-05',
          triggered: true,
          subType: 'CONVERSATIONAL_DRIP_FEED',
          decision: activeMode === FLIGHT_MODES.AUTO_PILOT ? 'ask' : 'allow',
          advisory: true,
          reason: `[DET-05 Conversational Drip-Feed] Detected ${tsList.length} rapid edits on "${filePath}" in <90s. Batch multiple micro-requirements into a single turn to preserve KV cache.`
        });
        if (det05Drip.triggered) return det05Drip;
      }
    }

    // 1d. DET-14 ('vague-prompt-rubric'): Turn-1 Blind Multi-File Edit Gate (TDD *.test.*/*.spec.* exempted)
    const currentTurnNum = Number(
      toolEvent.turnId ??
      toolEvent.turn_id ??
      telemetryState.turnCount ??
      telemetryState.currentTurn ??
      0
    );
    if (SEARCH_READ_TOOL_REGEX.test(toolName)) {
      this.totalDiscoveryCalls = Number(this.totalDiscoveryCalls || 0) + 1;
    }
    if (EDIT_WRITE_TOOL_REGEX.test(toolName)) {
      const rawPromptStr = String(toolEvent.prompt || toolEvent.user_input || toolInput.prompt || '');
      const hasSpecificAnchor = /(?:^|\s)@[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/.test(rawPromptStr);
      const candidateModified = new Set(this.modifiedFilesInTurn);
      if (filePath) candidateModified.add(filePath);
      const nonTestModifiedCount = Array.from(candidateModified).filter((fp) => {
        const np = String(fp || '').replace(/\\/g, '/');
        return !/(?:^|\/)(?:tests?|__tests__|specs?|migrations|docs)\//i.test(np) &&
          !/\.(?:test|spec)\.[a-z0-9]+$|\.md$/i.test(np);
      }).length;

      if (currentTurnNum <= 1 && Number(this.totalDiscoveryCalls || 0) === 0 && nonTestModifiedCount >= 2 && !hasSpecificAnchor) {
        if (filePath) this.modifiedFilesInTurn.add(filePath);
        const det14Blind = applyHabitSlug('vague-prompt-rubric', {
          detectorId: 'DET-14',
          triggered: true,
          subType: 'BLIND_UNPLANNED_MULTI_EDIT',
          decision: activeMode === FLIGHT_MODES.AUTO_PILOT ? 'deny' : 'allow',
          advisory: activeMode !== FLIGHT_MODES.AUTO_PILOT,
          reason: `[DET-14 Blind Multi-File Edit] Turn 1 multi-file edit (${nonTestModifiedCount} non-test files) with 0 prior read/grep discovery calls. Verify existing architecture or create a plan first.`
        });
        if (det14Blind.triggered) return det14Blind;
      }
    }

    // 1e. DET-08 ('effort-overkill'): Pinned Opus Max Effort Trivial Streak
    const activeModelId =
      (typeof toolEvent.model === 'string' ? toolEvent.model : toolEvent.model?.id) ||
      toolEvent.modelId ||
      telemetryState.modelId;
    const activeEffort = String(toolEvent.effort || telemetryState.effort || '').toLowerCase();
    const isOpusModel = /(?:claude-)?opus/i.test(String(activeModelId || ''));
    if (EDIT_WRITE_TOOL_REGEX.test(toolName) && isOpusModel && activeEffort === 'max') {
      const { oldLineCount, newLineCount } = computeAddedAndDeletedDiffLines(oldText, newText);
      const diffLinesChanged = Math.abs(newLineCount - oldLineCount);
      if (diffLinesChanged <= 3) {
        this.consecutiveTrivialMaxEffortTurns = Number(this.consecutiveTrivialMaxEffortTurns || 0) + 1;
      } else {
        this.consecutiveTrivialMaxEffortTurns = 0;
      }
      if (this.consecutiveTrivialMaxEffortTurns >= 3 || Number(toolEvent.consecutiveTrivialMaxEffortTurns) >= 3) {
        const det08Streak = applyHabitSlug('effort-overkill', {
          detectorId: 'DET-08',
          triggered: true,
          subType: 'PINNED_MAX_EFFORT_TRIVIAL_STREAK',
          decision: 'allow',
          advisory: true,
          reason: `[DET-08 Pinned Max Effort Streak] Opus 4.6 pinned at effort: max across ${this.consecutiveTrivialMaxEffortTurns} trivial edits (<=3 lines). Run /effort low or switch to Sonnet/Haiku to reduce output token latency by 68%.`
        });
        if (det08Streak.triggered) return det08Streak;
      }
    }

    // 1f. DET-20 ('vision-screenshot-coach'): Vision / Screenshot & Base64 Accumulation Guard
    let base64ImageBlocks = 0;
    let msgCompoundingVisionTokens = 0;
    if (Array.isArray(toolEvent.messages)) {
      const msgLen = toolEvent.messages.length;
      for (let i = 0; i < msgLen; i++) {
        const msg = toolEvent.messages[i];
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        let msgImgs = 0;
        for (const b of blocks) {
          if (b && (b.type === 'image' || b?.source?.type === 'base64')) {
            base64ImageBlocks += 1;
            msgImgs += 1;
          }
        }
        if (msgImgs > 0) {
          const turnsResent = Math.max(1, Math.ceil((msgLen - i) / 2));
          msgCompoundingVisionTokens += msgImgs * 1600 * turnsResent;
        }
      }
    }
    const hasImageAttachment = Boolean(
      toolEvent.has_image_attachment ||
      toolEvent.hasImageAttachment ||
      base64ImageBlocks > 0 ||
      (Array.isArray(toolEvent.media) && toolEvent.media.some((m) => String(m?.mime_type || '').startsWith('image/'))) ||
      /\.(?:png|jpg|jpeg|webp|gif)$/i.test(filePath)
    );
    if (hasImageAttachment) {
      this.consecutiveVisionTurns = Number(this.consecutiveVisionTurns || 0) + 1;
    } else {
      this.consecutiveVisionTurns = 0;
    }
    const effectiveConsecutiveVision = Math.max(
      this.consecutiveVisionTurns,
      Number(toolEvent.consecutive_vision_turns ?? toolEvent.consecutiveVisionTurns ?? 0)
    );
    const imageCount = Math.max(
      base64ImageBlocks,
      Number(toolEvent.image_count ?? toolEvent.imageCount ?? (hasImageAttachment ? 1 : 0))
    );
    if ((effectiveConsecutiveVision >= 2 || imageCount >= 2) && hasImageAttachment) {
      const cumulativeVisionTaxTokens = Math.max(
        msgCompoundingVisionTokens,
        imageCount * 1600 * Math.max(1, effectiveConsecutiveVision)
      );
      const det20Vision = applyHabitSlug('vision-screenshot-coach', {
        detectorId: 'DET-20',
        triggered: true,
        subType: 'VISION_SCREENSHOT_ABUSE',
        decision: 'allow',
        advisory: true,
        base64ImageBlocks,
        cumulativeVisionTaxTokens,
        reason: `[DET-20 Vision Token Drain] ${imageCount} screenshot/image blocks accumulated (~${cumulativeVisionTaxTokens.toLocaleString()} cumulative vision tokens) for text-debuggable issues. Paste error logs or DOM/CSS snippets directly.`
      });
      if (det20Vision.triggered) return det20Vision;
    }

    // 2. DET-16: Subagent Recursion Cap (40k tokens / 12 turns)
    const agentId = toolEvent.agentId || toolEvent.subagentId || null;
    if (agentId) {
      const subFromTelemetry = telemetryState.subagents?.[agentId];
      const turns =
        subFromTelemetry?.turns !== undefined
          ? Number(subFromTelemetry.turns)
          : Number(this.subagentTurns[agentId] || 0);
      const totalTokens =
        subFromTelemetry?.totalTokens !== undefined
          ? Number(subFromTelemetry.totalTokens)
          : Number(this.subagentTokens[agentId] || 0);
      if (subFromTelemetry || turns > 0 || totalTokens > 0) {
        const det16 = resolveVerdict(
          evaluateDet16SubagentRecursionCap({
            agentId,
            turns,
            totalTokens
          })
        );
        if (det16.triggered) return det16;
      }
      this.subagentTurns[agentId] = turns + 1;
      this.subagentTokens[agentId] = totalTokens + Math.max(0, Number(toolEvent.tokensUsed || 0));
    }

    // 3. DET-04: Consecutive Tool Failure Breaker (>= 3)
    const det04 = resolveVerdict(
      evaluateDet04ConsecutiveFailures({
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.horizonConfig?.thresholds?.consecutiveFailureLimit
      })
    );
    if (det04.triggered) return det04;

    // 4. DET-01: Destructive Shell & Git Hook-Bypass Blocker (Ring-0 Security)
    const det01 = resolveVerdict(evaluateDet01GitAndShellSafety({ toolName, command }));
    if (det01.triggered) return det01;

    // 5. DET-02: Secret & Credential Boundary (Ring-0 Security)
    const det02 = resolveVerdict(evaluateDet02SecretBoundary({ toolName, filePath, command }));
    if (det02.triggered) return det02;

    // 6. DET-18: Untrusted Project settings.json CVE & Clobber Guard (Ring-0 Security)
    const det18 = resolveVerdict(
      evaluateDet18UntrustedSettingsGuard({
        toolName,
        filePath,
        newText,
        hasBackup: Boolean(toolEvent.hasBackup)
      })
    );
    if (det18.triggered) return det18;

    // 7. DET-03: Protected Migration, Lockfile & Workflow Ask Gate
    const det03 = resolveVerdict(evaluateDet03ProtectedFilesAskGate({ toolName, filePath }));
    if (det03.triggered) return det03;

    // 8. DET-19: Untrusted URL Exfiltration Guard on WebFetch (Ring-0 Security)
    if (/^WebFetch$/i.test(toolName) && urlStr) {
      const det19Url = resolveVerdict(
        evaluateDet19SubagentIpiSanitizer({ url: urlStr, wrapUntrusted: false })
      );
      if (det19Url.triggered && (det19Url.decision === 'deny' || det19Url.advisory)) {
        return det19Url;
      }
    }

    // 9. DET-05: AST/Diff Edit Thrashing & Code Stripping Breaker
    if (EDIT_WRITE_TOOL_REGEX.test(toolName)) {
      if (oldText || newText) {
        const history = this.fileHashHistory.get(filePath) || [];
        const rawDet05 = evaluateDet05DiffThrashing({
          filePath,
          oldText,
          newText,
          fullFileOldLines: toolEvent.fullFileOldLines,
          fullFileNewLines: toolEvent.fullFileNewLines,
          hashHistory: history
        });
        const det05 = resolveVerdict(rawDet05);
        if (det05.triggered) {
          this.router.hysteresisLock.engage({
            model: telemetryState.modelId || 'claude-opus-5-5',
            effort: 'high',
            reason: det05.subType
          });
          return det05;
        }
        history.push(rawDet05.nextHash);
        this.fileHashHistory.set(filePath, history.slice(-6));
      }
      if (filePath) {
        this.modifiedFilesInTurn.add(filePath);
        this.pendingFormatFiles.add(filePath);
        if (/^MultiEdit$/i.test(toolName)) {
          this.pendingBatchEdits.add(filePath);
        }
      }
      this.codeEditedSinceLastTest = true;
      this.sequentialSearchCount = 0;

      // 9b. DET-09: Warm-Prefix Instruction / MCP Config Mutation Fence (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/rules/*.md`)
      if (filePath && isPrefixInstructionFile(filePath) && !isCoachAdvisorySuppressed('DET-09')) {
        const ttlRem =
          toolEvent.ttlRemainingSeconds ??
          telemetryState.promptCache?.ttlSeconds ??
          telemetryState.ttlRemainingSeconds;
        const ttlExpired = ttlRem !== undefined && ttlRem !== null && Number(ttlRem) <= 0;
        const cachedTokens = Number(
          toolEvent.cachedTokens ??
            telemetryState.contextWindow?.cachedTokens ??
            telemetryState.contextWindow?.cacheReadTokens ??
            0
        );
        const cacheWarm =
          !ttlExpired &&
          Boolean(toolEvent.cacheWarm ?? telemetryState.promptCache?.warm) &&
          cachedTokens > 0;

        if (cacheWarm) {
          const det09Raw = this.router.interceptTopLevelMutation({
            type: 'system_prompt',
            key: filePath,
            value: newText.slice(0, 120),
            filePath,
            currentModel:
              (typeof toolEvent.model === 'string' ? toolEvent.model : toolEvent.model?.id) ||
              toolEvent.modelId ||
              telemetryState.modelId ||
              'claude-opus-5-5',
            cachedTokens,
            cacheWarm: true,
            ttlRemainingSeconds: ttlRem,
            cacheTtlTier: telemetryState.promptCache?.ttlTier || '5m'
          });
          if (det09Raw.triggered) {
            const det09 = resolveVerdict(
              activeMode === FLIGHT_MODES.AUTO_PILOT
                ? det09Raw
                : { ...det09Raw, decision: 'allow', advisory: true }
            );
            if (det09.triggered) return det09;
          }
        }
      }
    }

    // 10. DET-07: Unbounded Command Output Bomb Guard
    const det07 = resolveVerdict(
      evaluateDet07OutputBombGuard({
        toolName,
        command,
        filePath,
        limit: toolInput.limit ?? toolEvent.limit
      })
    );
    if (det07.triggered) return det07;

    // Track git commit and test runs in shell commands
    if (SHELL_TOOL_REGEX.test(toolName)) {
      if (/\bgit\s+commit\b/i.test(command)) {
        this.lastTurnGitCommitted = true;
        this.committedTopDirs = Array.from(this.modifiedFilesInTurn)
          .map((f) => f.split(/[\\/]/)[0])
          .filter(Boolean);
      }
      if (
        /\b(?:node\s+--test|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/i.test(
          command
        )
      ) {
        this.codeEditedSinceLastTest = false;
      }
      this.sequentialSearchCount = 0;
    }

    // 11. DET-06: Main-Thread Blind Search Guard (> 6 sequential Read/Grep calls) + Repo Calibration
    if (SEARCH_READ_TOOL_REGEX.test(toolName) && !agentId) {
      this.sequentialSearchCount += 1;
      let chronicAdvisory = null;
      if (
        /^(?:Read|read_file)$/i.test(toolName) &&
        filePath &&
        (this.options.enableRepoCalibration || this.options.calibrationPath)
      ) {
        let estimatedReadTokens = 0;
        if (toolEvent.estimatedTokens !== undefined && toolEvent.estimatedTokens !== null) {
          estimatedReadTokens = Math.max(0, Number(toolEvent.estimatedTokens));
        } else if (Number(toolEvent.fileByteSize) > 0) {
          estimatedReadTokens = Math.ceil(Number(toolEvent.fileByteSize) / 4);
        } else {
          const resolvedReadPath = resolvePath(getCwd(this.options), filePath);
          const byteSize = getFileByteSizeSafe(resolvedReadPath, this.options);
          estimatedReadTokens = byteSize > 0 ? Math.ceil(byteSize / 4) : 0;
        }
        const cal = recordRepoFileRead(
          {
            filePath,
            estimatedTokens: estimatedReadTokens,
            sessionId: telemetryState.sessionId || 'default'
          },
          this.options
        );
        if (cal.isChronicSink) {
          chronicAdvisory = cal.recommendation;
        }
      }

      if (!isCoachAdvisorySuppressed('DET-06')) {
        const blindLimit = this.horizonConfig?.thresholds?.blindSearchLimit;
        const det06 = resolveVerdict(
          evaluateDet06BlindSearchGuard({
            sequentialSearchCount: this.sequentialSearchCount,
            threshold: blindLimit,
            limit: blindLimit
          })
        );
        if (det06.triggered) {
          return chronicAdvisory
            ? { ...det06, reason: `${det06.reason} | ${chronicAdvisory}` }
            : det06;
        }
        if (chronicAdvisory && resolveDetectorOverride('DET-06', this.horizonConfig) !== 'off') {
          return resolveVerdict({
            detectorId: 'DET-06',
            triggered: true,
            decision: 'allow',
            advisory: true,
            subType: 'CHRONIC_REPO_FILE_SINK',
            reason: chronicAdvisory
          });
        }
      }
    }

    // 12. DET-12: Haiku 5.5 90,000-Token Pre-Cliff Breaker
    const eventUsage = toolEvent.usage || toolEvent.context_window?.current_usage || null;
    const totalDet12Tokens = Math.max(
      computeTotalPromptTokens(telemetryState.contextWindow || {}),
      computeTotalPromptTokens(toolEvent),
      eventUsage ? computeTotalPromptTokens(eventUsage) : 0
    );
    const rawDet12 = evaluateDet12HaikuPreCliffBreaker({
      modelId: activeModelId,
      totalPromptTokens: totalDet12Tokens
    });
    if (rawDet12.triggered) {
      // Hard >=98k cliff protection stays active even in SILENT/OFF unless explicitly overridden to 'off'
      if (!rawDet12.advisory || !isCoachAdvisorySuppressed('DET-12')) {
        const det12 = resolveVerdict(rawDet12);
        if (det12.triggered) return det12;
      }
    }

    const turnKey = String(
      toolEvent.turnId ??
        toolEvent.turn_id ??
        telemetryState.turnCount ??
        telemetryState.currentTurn ??
        0
    );

    // 13. DET-13: MCP Schema Bloat & tools_changed Cache-Miss Guard (once per turn)
    if (!isCoachAdvisorySuppressed('DET-13') && this.det13AdvisedTurn !== turnKey) {
      const mcpSchemaTokens = Number(
        toolEvent.mcpSchemaTokens ??
          telemetryState.mcpSchemaTokens ??
          telemetryState.mcp?.schemaTokens ??
          0
      );
      const mcpToolCount = Number(
        toolEvent.mcpToolCount ??
          telemetryState.mcpToolCount ??
          telemetryState.mcp?.toolCount ??
          0
      );
      const lastMissCause =
        toolEvent.lastMissCause ||
        telemetryState.lastMissCause ||
        telemetryState.promptCache?.lastMissCause ||
        (toolEvent.toolsChanged || telemetryState.toolsChanged ? 'tools_changed' : null);

      if (mcpSchemaTokens > 0 || mcpToolCount > 0 || lastMissCause) {
        const det13 = resolveVerdict(
          evaluateDet13McpSchemaBloatGuard({
            mcpSchemaTokens,
            mcpToolCount,
            lastMissCause,
            bundledSkillsTokens: Number(toolEvent.bundledSkillsTokens ?? telemetryState.bundledSkillsTokens ?? 0),
            syncedSkillsTokens: Number(toolEvent.syncedSkillsTokens ?? telemetryState.syncedSkillsTokens ?? 0),
            claudeMdTokens: Number(toolEvent.claudeMdTokens ?? telemetryState.claudeMdTokens ?? 0),
            turnsElapsed: Number(toolEvent.turnsElapsed ?? toolEvent.turnId ?? toolEvent.turn_id ?? telemetryState.turnCount ?? 0),
            mcpInvocations: Number(toolEvent.mcpInvocations ?? telemetryState.mcpInvocations ?? 0)
          })
        );
        if (det13.triggered) {
          this.det13AdvisedTurn = turnKey;
          return det13;
        }
      }
    }

    // 14. DET-11: Context Rot Soft Horizon Gate (once per turn)
    if (!isCoachAdvisorySuppressed('DET-11') && this.det11AdvisedTurn !== turnKey) {
      const totalInputTokens = Math.max(
        totalDet12Tokens,
        Number(
          toolEvent.totalInputTokens ??
            telemetryState.totalInputTokens ??
            telemetryState.contextWindow?.totalInputTokens ??
            0
        )
      );
      const distractorTokens =
        toolEvent.distractorTokens ??
        telemetryState.distractorTokens ??
        telemetryState.contextWindow?.distractorTokens;
      const distractorRatio =
        toolEvent.distractorRatio ??
        telemetryState.distractorRatio ??
        telemetryState.contextWindow?.distractorRatio;

      const postCommitOverride = resolveDetectorOverride('post-commit-handoff', this.horizonConfig);
      const postCommitTopicShift =
        postCommitOverride !== 'off' &&
        Boolean(
          toolEvent.postCommitTopicShift ??
          toolEvent.topic_shift ??
          toolEvent.topicShift ??
          (this.lastTurnGitCommitted && (toolEvent.topic_shift || toolEvent.topicShift))
        );

      if (
        (totalInputTokens > 0 &&
        (distractorTokens !== undefined || distractorRatio !== undefined)) ||
        postCommitTopicShift
      ) {
        const rawDet11 = evaluateDet11ContextRotGate({
          totalInputTokens,
          distractorTokens,
          distractorRatio,
          turnId: currentTurnNum,
          lastTurnGitCommitted: this.lastTurnGitCommitted || Boolean(toolEvent.last_turn_git_committed),
          topicShiftDetected: Boolean(toolEvent.topic_shift || toolEvent.topicShift),
          postCommitTopicShift
        });
        const det11 =
          rawDet11.subType === 'POST_COMMIT_TOPIC_SHIFT'
            ? applyHabitSlug('post-commit-handoff', rawDet11)
            : resolveVerdict(rawDet11);
        if (det11.triggered) {
          this.det11AdvisedTurn = turnKey;
          return det11;
        }
      }
    }

    return {
      detectorId: null,
      triggered: false,
      decision: 'allow',
      reason: null
    };
  }

  /**
   * Records tool outcome to update `DET-04` consecutive failure counter.
   * @param {boolean} succeeded
   * @param {string | null} [toolKey=null]
   */
  recordToolOutcome(succeeded = true, toolKey = null) {
    if (succeeded) {
      this.consecutiveFailures = 0;
      this.lastFailedToolKey = null;
    } else {
      this.consecutiveFailures += 1;
      if (toolKey) {
        this.lastFailedToolKey = String(toolKey);
      }
    }
    return this.consecutiveFailures;
  }

  /**
   * Evaluates `UserPromptSubmit` for Prompt Hygiene Governor (v4.1 Phase 1):
   * Relay Breaker (`'relay-breaker'`) & Scope Brake (`'vague-prompt-rubric'`).
   *
   * @param {object} [promptEvent={}]
   * @param {object} [telemetryState={}]
   */
  evaluateUserPromptSubmit(promptEvent = {}, telemetryState = {}) {
    const prompt = String(
      promptEvent.prompt ?? promptEvent.user_input ?? promptEvent.message ?? ''
    );
    const activeMode = normalizeFlightMode(
      promptEvent.mode || telemetryState.flightMode || this.mode || FLIGHT_MODES.COACH
    );
    if (activeMode === FLIGHT_MODES.OFF) {
      return { triggered: false, decision: 'allow', reason: null };
    }

    const modifiedNonMd = Array.from(this.modifiedFilesInTurn).filter(
      (f) => !/\.md$/i.test(String(f || ''))
    );
    const relayOverride = resolveDetectorOverride('relay-breaker', this.horizonConfig);
    const relayEval = evaluateRelayBreaker({
      prompt,
      relayState: promptEvent.relayState ?? this.relayState,
      sourceCodeEditsInSession: Number(
        promptEvent.sourceCodeEditsInSession ?? modifiedNonMd.length
      ),
      sourceCodeEditedSinceLastRelay: Boolean(promptEvent.sourceCodeEditedSinceLastRelay),
      priorTurnWebSearches: Number(promptEvent.priorTurnWebSearches ?? 0),
      zeroEditSessionTokens: Number(
        promptEvent.zeroEditSessionTokens ??
        (modifiedNonMd.length === 0 ? (telemetryState.contextWindow?.totalInputTokens || 0) : 0)
      ),
      boundSpecPath: promptEvent.boundSpecPath ?? this.relayState?.boundSpecPath ?? 'SPEC.md',
      overrideMode: relayOverride,
      flightMode: activeMode,
      detectorId: 'DET-14'
    });
    this.relayState = relayEval.relayStateSnapshot;
    if (relayEval.triggered) {
      if (relayEval.decision === 'block') {
        this.blockedPrompts = Number(this.blockedPrompts || 0) + 1;
      } else {
        this.steeredPrompts = Number(this.steeredPrompts || 0) + 1;
      }
      return {
        detectorId: 'DET-14',
        slug: 'relay-breaker',
        triggered: true,
        subType: relayEval.subType,
        decision: relayEval.decision,
        relayState: relayEval.nextState,
        hudBadge: relayEval.hudBadge,
        reason: relayEval.tailInjection
      };
    }

    const scopeOverride = resolveDetectorOverride('vague-prompt-rubric', this.horizonConfig);
    const scopeEval = evaluateScopeBrake({
      prompt,
      provenance: promptEvent.provenance || promptEvent.source || 'user',
      isAutonomousTurn: Boolean(promptEvent.isAutonomousTurn || promptEvent.autonomous),
      isSubagent: Boolean(promptEvent.isSubagent || promptEvent.agentId || promptEvent.subagentId),
      isScheduledTask: Boolean(promptEvent.isScheduledTask),
      isLoopIteration: Boolean(promptEvent.isLoopIteration),
      priorTurnEditedFilesCount: Number(
        promptEvent.priorTurnEditedFilesCount ?? this.modifiedFilesInTurn.size
      ),
      priorTurnSingleFileTarget:
        promptEvent.priorTurnSingleFileTarget ??
        (this.modifiedFilesInTurn.size === 1 ? Array.from(this.modifiedFilesInTurn)[0] : null),
      priorTurnHadToolOrTestFailure: Boolean(
        promptEvent.priorTurnHadToolOrTestFailure ?? (this.consecutiveFailures > 0)
      ),
      priorTurnAssistantAskedQuestion: Boolean(promptEvent.priorTurnAssistantAskedQuestion),
      activeSetPaths: promptEvent.activeSetPaths || [],
      modifiedFiles: Array.from(this.modifiedFilesInTurn),
      recentlyViewedFiles: promptEvent.recentlyViewedFiles || [],
      overrideMode: scopeOverride,
      flightMode: activeMode,
      detectorId: 'DET-14'
    });
    if (scopeEval.triggered) {
      this.unanchoredTurnFlag = true;
      this.candidateFiles = scopeEval.candidateFiles;
      if (scopeEval.decision === 'block') {
        this.blockedPrompts = Number(this.blockedPrompts || 0) + 1;
      } else {
        this.steeredPrompts = Number(this.steeredPrompts || 0) + 1;
      }
      return {
        detectorId: 'DET-14',
        slug: 'vague-prompt-rubric',
        triggered: true,
        subType: scopeEval.subType,
        decision: scopeEval.decision,
        candidateFiles: scopeEval.candidateFiles,
        reason: scopeEval.decision === 'block' ? scopeEval.blockReason : scopeEval.steerContext
      };
    }

    this.unanchoredTurnFlag = false;
    return {
      detectorId: null,
      triggered: false,
      decision: 'allow',
      reason: null
    };
  }
}

export default {
  tokenizeShellSegment,
  sanitizeBreakerSessionId,
  getBreakerStateFilePath,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot,
  evaluateDet01GitAndShellSafety,
  evaluateDet02SecretBoundary,
  evaluateDet03ProtectedFilesAskGate,
  evaluateDet04ConsecutiveFailures,
  computeAddedAndDeletedDiffLines,
  hashFileContent,
  evaluateDet05DiffThrashing,
  evaluateDet06BlindSearchGuard,
  evaluateDet07OutputBombGuard,
  isPrefixInstructionFile,
  evaluateDet09PrefixMutationFence,
  evaluateDet11ContextRotGate,
  evaluateDet12HaikuPreCliffBreaker,
  evaluateDet13McpSchemaBloatGuard,
  evaluateDet14PrematureStopGate,
  evaluateDet15BatchedStopFormatter,
  evaluateDet16SubagentRecursionCap,
  evaluateDet17AutoCompactionDeferral,
  evaluateDet18UntrustedSettingsGuard,
  evaluateDet19SubagentIpiSanitizer,
  evaluateDet20ScopeLockAndQuotaBrake,
  CircuitBreakerEngine
};
