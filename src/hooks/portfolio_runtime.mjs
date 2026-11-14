import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSidecarSync, writeSidecarAtomicSync } from '../core/sidecar_store.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../core/horizon_config.mjs';
import { getHomeDir } from '../core/paths.mjs';
import { SavedQuotaReceiptLedger, SAVINGS_EVENT_TYPES } from '../core/coach/saved_quota_ledger.mjs';
import {
  evaluateDet02PreInvocationHold,
  isSensitiveCredentialPath,
  evaluateDet04ConsecutiveFailureBreaker,
  recordToolOutcomeForDet04,
  evaluateDet05PreWriteIntegrity,
  evaluateDet06UnmodifiedReRead,
  evaluateDet06BlindNewModule,
  evaluateDet06bFlashScoutOffloader,
  evaluateDet07IgnorableFileReadGuard,
  evaluateDet16HybridQuotaThrottle,
  evaluateDet20VisionOverageGuard,
  SOURCE_CODE_EXT_RE,
  BLIND_EDIT_EXEMPT_PATH_RE
} from '../core/shared/detectors.mjs';
import { archiveAndCompressDet07Output } from '../shims/agy_cli_compressor.mjs';
import {
  evaluateDet08DestructiveShell,
  evaluateDet09MidSessionRuleMutate,
  evaluateDet18UntrustedWorkspaceSettings,
  evaluateDet19GitHookBypass
} from '../core/detectors_det01_to_16.mjs';
import {
  loadMicroSkillsRegistry,
  evaluateMicroSkillIntercept,
  recordWorkspaceShellOutcome
} from '../core/micro_skills_store.mjs';
import {
  evaluateScopeBrake,
  evaluateRelayBreaker,
  evaluateTwoStageSightseeingIntercept
} from '../core/shared/prompt_hygiene_governor.mjs';

const SOURCE_FILE_EXT_RE = /\.(mjs|js|ts|tsx|py|go|rs)$/i;

function resolveTargetFileFromArgs(toolArgs = {}, workspacePath = process.cwd()) {
  const raw = String(
    toolArgs.TargetFile ??
    toolArgs.Path ??
    toolArgs.path ??
    toolArgs.AbsolutePath ??
    toolArgs.file_path ??
    toolArgs.DirectoryPath ??
    toolArgs.SearchPath ??
    ''
  ).trim();
  if (!raw) return { raw: '', absPath: '', realPath: '' };
  const absPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspacePath, raw);
  let realPath = absPath;
  try {
    if (fs.existsSync(absPath)) {
      realPath = fs.realpathSync(absPath);
    } else {
      const parent = path.dirname(absPath);
      if (fs.existsSync(parent)) {
        realPath = path.join(fs.realpathSync(parent), path.basename(absPath));
      }
    }
  } catch {
    realPath = absPath;
  }
  return { raw, absPath, realPath };
}

function sha256FileSafe(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const stat = fs.statSync(absPath);
    return {
      exists: true,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      mtimeMs: Number(stat.mtimeMs || 0),
      size: Number(stat.size || buf.length || 0),
      content: buf.toString('utf8')
    };
  } catch {
    return { exists: false, sha256: '', mtimeMs: 0, content: null };
  }
}

function countSiblingSourceFiles(absTargetPath) {
  try {
    const dir = path.dirname(absTargetPath);
    if (!fs.existsSync(dir)) return 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && SOURCE_FILE_EXT_RE.test(e.name)).length;
  } catch {
    return 0;
  }
}

function ensurePortfolioState(sidecar) {
  sidecar.portfolio = sidecar.portfolio || {};
  sidecar.portfolio.fnvRings = sidecar.portfolio.fnvRings || {};
  sidecar.portfolio.readLedger = Array.isArray(sidecar.portfolio.readLedger) ? sidecar.portfolio.readLedger : [];
  sidecar.portfolio.discoveryCallsCount = Number(sidecar.portfolio.discoveryCallsCount || 0);
  sidecar.portfolio.consecutiveReadSearchCount = Number(sidecar.portfolio.consecutiveReadSearchCount || 0);
  sidecar.portfolio.failureStreaks = sidecar.portfolio.failureStreaks || {};
  sidecar.portfolio.lastAlertTurnByKey = sidecar.portfolio.lastAlertTurnByKey || {};
  sidecar.portfolio.hudAlerts = Array.isArray(sidecar.portfolio.hudAlerts) ? sidecar.portfolio.hudAlerts : [];
  sidecar.portfolio.lastUserPrompt = String(sidecar.portfolio.lastUserPrompt || '');
  return sidecar.portfolio;
}

function pushHudAlert(portfolio, detectorId, message, turn = 0) {
  if (!message) return;
  portfolio.hudAlerts.push({
    detectorId,
    message: String(message),
    turn: Number(turn || 0),
    createdAt: new Date().toISOString()
  });
  if (portfolio.hudAlerts.length > 25) {
    portfolio.hudAlerts = portfolio.hudAlerts.slice(-25);
  }
}

function loadPlatformQuirksSafe(workspacePath) {
  const candidates = [
    path.join(workspacePath, 'src', 'config', 'platformQuirks.json'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../config/platformQuirks.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  return { visionOverageHttp400: { enabled: true } };
}

/**
 * Strict Antigravity `PreInvocation` Evaluator (`hooks/pre_invocation.mjs`)
 *
 * Output contract: `{}` | `{"ephemeralMessage": "..."}` | `{"terminationBehavior": "terminate", "errorMessage": {"userMessage": "..."}}`
 */
export async function runStrictPreInvocation(inputData = {}) {
  // Rank 11 (DET-02): Fast-exit `{}` in < 1ms when invocationNum > 1
  const invocationNum = Number(
    inputData.invocationNum ?? inputData.invocation_num ?? inputData.stepInTurn ?? 1
  );
  if (invocationNum > 1) {
    return {};
  }

  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  const workspacePath = inputData.cwd || inputData.workspacePath || (Array.isArray(inputData.workspacePaths) && inputData.workspacePaths[0]) || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  if (flightMode === 'OFF') return {};

  const prompt = String(inputData.lastUserInput ?? inputData.prompt ?? inputData.user_input ?? inputData.message ?? '');
  const airlockPrompt = runAirlockPromptBridge(
    { ...inputData, prompt },
    { cwd: workspacePath, ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {}) },
    { ...inputData, host: 'antigravity', horizonConfig }
  );
  if (airlockPrompt?.blocked) {
    const reason = airlockPrompt.verdict?.reason || 'Blocked by Highbeam Airlock PreInvocation guard';
    return {
      decision: 'deny',
      terminationBehavior: 'terminate',
      reason,
      userMessage: reason,
      errorMessage: { userMessage: reason },
      systemMessage: reason,
      airlock: airlockPrompt.airlock
    };
  }
  const portfolio = ensurePortfolioState(sidecar);
  portfolio.lastUserPrompt = prompt;
  // Reset per-turn unedited read/search counter on a new user turn
  portfolio.consecutiveReadSearchCount = 0;

  // 1. Rank 11 (DET-02): Live Secrets & Raw Mega-Dumps
  const det02 = evaluateDet02PreInvocationHold({
    prompt,
    invocationNum,
    flightMode
  });
  if (det02.triggered) {
    if (det02.hudHint) {
      // Silent HUD hint in COACH (zero stdout chatter)
      pushHudAlert(portfolio, 'DET-02', det02.hudHint, sidecar.sessionMeta?.turnCount || 1);
      writeSidecarAtomicSync(conversationId, sidecar);
      return {};
    }
    writeSidecarAtomicSync(conversationId, sidecar);
    return det02.output;
  }

  // 1b. DET-15 ('formatter-bypass'): Local Formatter Bypass on Pasted Indentation / Import Sorting
  const fmtOverride = resolveDetectorOverride(horizonConfig, 'formatter-bypass');
  const isFormattingIntent = /\b(fix\s+(?:the\s+)?indentation|sort\s+(?:the\s+)?imports|format\s+this\s+(?:code|file|block)|convert\s+tabs\s+to\s+spaces|run\s+prettier)\b/i.test(prompt);
  const pastedLineCount = (prompt.match(/\r?\n/g) || []).length;
  if (fmtOverride !== 'off' && isFormattingIntent && pastedLineCount >= 40 && !/\b(add|implement|refactor|create|fix\s+bug|logic|test|calculate)\b/i.test(prompt)) {
    const bypassNotice = '[DET-15 Local Formatter Bypass] Prompt requests code formatting / import sorting on a pasted code block. Run `npx prettier --write <file>` or `npx eslint --fix <file>` directly (0 LLM tokens).';
    pushHudAlert(portfolio, 'DET-15', bypassNotice, sidecar.sessionMeta?.turnCount || 1);
    writeSidecarAtomicSync(conversationId, sidecar);
    if (fmtOverride === 'block' || (fmtOverride === 'default' && flightMode === 'AUTO_PILOT')) {
      return { terminationBehavior: 'terminate', decision: 'block', detectorId: 'DET-15', userMessage: bypassNotice };
    }
    return { ephemeralMessage: bypassNotice, systemMessage: bypassNotice };
  }

  // 1c. DET-02B ('drip-feed'): Rapid <90s Conversational Drip-Feeding in Portfolio PreInvocation
  const dripOverride = resolveDetectorOverride(horizonConfig, 'drip-feed');
  if (dripOverride !== 'off') {
    const tsMs = Number(inputData.timestampMs ?? inputData.nowMs ?? inputData.timestamp ?? Date.now());
    const wCount = prompt.trim().split(/\s+/).filter(Boolean).length;
    const inlineFileMatch = prompt.match(/(?:^|\s)@?([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|cjs|jsx|py|rs|go|rb|java|cs|css|scss|html|json|md))\b/);
    const scopeHint = String(
      inputData.targetScope ||
      (inlineFileMatch ? inlineFileMatch[1] : '') ||
      sidecar.fileState?.activeSetPaths?.[0] ||
      sidecar.fileState?.modifiedFiles?.[0] ||
      ''
    );
    portfolio.recentPromptEvents = (Array.isArray(portfolio.recentPromptEvents) ? portfolio.recentPromptEvents : [])
      .filter((e) => tsMs - Number(e.ts || 0) <= 90000);
    portfolio.recentPromptEvents.push({ ts: tsMs, wordCount: wCount, targetScope: scopeHint });
    const rapidMicroCount = portfolio.recentPromptEvents.filter(
      (e) => e.wordCount > 0 && e.wordCount <= 18 && Boolean(scopeHint) && e.targetScope === scopeHint
    ).length;
    if (rapidMicroCount >= 4) {
      const dripNotice = `[DET-02B Conversational Drip-Feed Advisory] Detected ${rapidMicroCount} rapid micro-prompts in <90s. Batch requirements into a single numbered checklist prompt.`;
      pushHudAlert(portfolio, 'DET-02B', dripNotice, sidecar.sessionMeta?.turnCount || 1);
      writeSidecarAtomicSync(conversationId, sidecar);
      if (dripOverride === 'block' || (dripOverride === 'default' && flightMode === 'AUTO_PILOT')) {
        return { terminationBehavior: 'terminate', decision: 'block', detectorId: 'DET-02B', userMessage: dripNotice };
      }
      return { ephemeralMessage: dripNotice, systemMessage: dripNotice };
    }
  }

  // 2. Rank 12 (DET-20 / 'vision-screenshot-coach'): Vision Overage HTTP 400 & Vision Screenshot Abuse Guard
  const visionOverride = resolveDetectorOverride(horizonConfig, 'vision-screenshot-coach');
  const quirks = inputData.platformQuirks || loadPlatformQuirksSafe(workspacePath);
  const hasImageAttachment = Boolean(
    inputData.hasImageAttachment ||
    (Array.isArray(inputData.media) && inputData.media.some((m) => String(m?.mime_type || m?.mimeType || '').startsWith('image/'))) ||
    (Array.isArray(inputData.attachments) && inputData.attachments.some((a) => /image|\.(png|jpg|jpeg|webp|gif)$/i.test(String(a?.mimeType || a?.type || a?.name || '')))) ||
    (Array.isArray(inputData.messages) && inputData.messages.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'image' || b?.source?.type === 'base64')))
  );
  const aiCreditOveragesActive = Boolean(
    inputData.aiCreditOveragesActive ??
    sidecar.telemetry?.quota?.aiCreditOveragesActive ??
    (Number(inputData.baseQuotaUsedPct ?? sidecar.telemetry?.quota?.usedPct ?? 0) >= 100 && inputData.overageEnabled !== false)
  );
  portfolio.consecutiveImageTurns = hasImageAttachment ? Number(portfolio.consecutiveImageTurns || 0) + 1 : 0;
  const screenshotMatch = prompt.match(/(\d+)\s+screenshots?/i);
  const imageCount = Number(
    inputData.imageCount ??
    (screenshotMatch ? Number(screenshotMatch[1]) : (hasImageAttachment ? 1 : 0))
  );
  const det20 = evaluateDet20VisionOverageGuard({
    quirkConfig: quirks.visionOverageHttp400 || { enabled: true },
    aiCreditOveragesActive,
    hasImageAttachment,
    consecutiveImageTurns: portfolio.consecutiveImageTurns,
    promptText: prompt,
    imageCount,
    messages: inputData.messages || [],
    contentBlocks: inputData.contentBlocks || []
  });
  if (det20.triggered && (det20.subType === 'VISION_OVERAGE_HTTP400' || visionOverride !== 'off')) {
    pushHudAlert(portfolio, 'DET-20', det20.warningMessage, sidecar.sessionMeta?.turnCount || 1);
    writeSidecarAtomicSync(conversationId, sidecar);
    if (visionOverride === 'block' && det20.subType === 'VISION_SCREENSHOT_ABUSE') {
      return { terminationBehavior: 'terminate', decision: 'block', detectorId: 'DET-20', userMessage: det20.warningMessage };
    }
    return flightMode === 'SILENT' ? {} : { ephemeralMessage: det20.ephemeralMessage, systemMessage: det20.ephemeralMessage, cumulativeVisionTaxTokens: det20.cumulativeVisionTaxTokens };
  }

  // 3. Prompt Hygiene Governor (v4.1 Phase 1): Relay Breaker ('relay-breaker') & Scope Brake ('vague-prompt-rubric')
  const relayOverride = resolveDetectorOverride(horizonConfig, 'relay-breaker');
  const relayEval = evaluateRelayBreaker({
    prompt,
    relayState: inputData.relayState ?? portfolio.relayState,
    sourceCodeEditsInSession: Number(
      inputData.sourceCodeEditsInSession ??
      (sidecar.fileState?.modifiedFiles || []).filter((p) => !/\.md$/i.test(String(p || ''))).length
    ),
    sourceCodeEditedSinceLastRelay: Boolean(inputData.sourceCodeEditedSinceLastRelay),
    priorTurnWebSearches: Number(inputData.priorTurnWebSearches ?? portfolio.priorTurnWebSearches ?? 0),
    zeroEditSessionTokens: Number(
      inputData.zeroEditSessionTokens ??
      (((sidecar.fileState?.modifiedFiles || []).length === 0) ? (sidecar.telemetry?.totalInputTokens || 0) : 0)
    ),
    boundSpecPath: inputData.boundSpecPath ?? portfolio.relayState?.boundSpecPath ?? null,
    overrideMode: relayOverride,
    flightMode,
    detectorId: 'DET-26'
  });
  portfolio.relayState = relayEval.relayStateSnapshot;
  if (relayEval.triggered) {
    pushHudAlert(portfolio, 'DET-26', relayEval.tailInjection, sidecar.sessionMeta?.turnCount || 1);
    if (relayEval.decision === 'block') {
      portfolio.blockedPrompts = Number(portfolio.blockedPrompts || 0) + 1;
      writeSidecarAtomicSync(conversationId, sidecar);
      return {
        terminationBehavior: 'terminate',
        decision: 'block',
        detectorId: 'DET-26',
        subType: relayEval.subType,
        relayState: relayEval.nextState,
        userMessage: relayEval.tailInjection
      };
    }
    portfolio.steeredPrompts = Number(portfolio.steeredPrompts || 0) + 1;
    writeSidecarAtomicSync(conversationId, sidecar);
    return flightMode === 'SILENT'
      ? {}
      : {
          ephemeralMessage: relayEval.tailInjection,
          systemMessage: relayEval.tailInjection,
          detectorId: 'DET-26',
          subType: relayEval.subType,
          relayState: relayEval.nextState
        };
  }

  const scopeOverride = resolveDetectorOverride(horizonConfig, 'vague-prompt-rubric');
  const scopeEval = evaluateScopeBrake({
    prompt,
    provenance: inputData.provenance || inputData.source || 'user',
    isAutonomousTurn: Boolean(inputData.isAutonomousTurn || inputData.autonomous),
    isSubagent: Boolean(inputData.isSubagent || sidecar.sessionMeta?.isSubagent),
    isScheduledTask: Boolean(inputData.isScheduledTask),
    isLoopIteration: Boolean(inputData.isLoopIteration),
    priorTurnEditedFilesCount: Number(inputData.priorTurnEditedFilesCount ?? 0),
    priorTurnSingleFileTarget: inputData.priorTurnSingleFileTarget ?? null,
    priorTurnHadToolOrTestFailure: Boolean(inputData.priorTurnHadToolOrTestFailure),
    priorTurnAssistantAskedQuestion: Boolean(inputData.priorTurnAssistantAskedQuestion),
    activeSetPaths: sidecar.fileState?.activeSetPaths || [],
    modifiedFiles: sidecar.fileState?.modifiedFiles || [],
    recentlyViewedFiles: (portfolio.readLedger || []).map((e) => e.absPath).filter(Boolean),
    overrideMode: scopeOverride,
    flightMode,
    detectorId: 'DET-26'
  });
  if (scopeEval.triggered) {
    portfolio.unanchoredTurnFlag = true;
    portfolio.candidateFiles = scopeEval.candidateFiles;
    pushHudAlert(portfolio, 'DET-26', scopeEval.steerContext, sidecar.sessionMeta?.turnCount || 1);
    if (scopeEval.decision === 'block') {
      portfolio.blockedPrompts = Number(portfolio.blockedPrompts || 0) + 1;
      writeSidecarAtomicSync(conversationId, sidecar);
      return {
        terminationBehavior: 'terminate',
        decision: 'block',
        detectorId: 'DET-26',
        subType: scopeEval.subType,
        userMessage: scopeEval.blockReason
      };
    }
    portfolio.steeredPrompts = Number(portfolio.steeredPrompts || 0) + 1;
    writeSidecarAtomicSync(conversationId, sidecar);
    return flightMode === 'SILENT'
      ? {}
      : {
          ephemeralMessage: scopeEval.steerContext,
          systemMessage: scopeEval.steerContext,
          detectorId: 'DET-26',
          subType: scopeEval.subType,
          candidateFiles: scopeEval.candidateFiles
        };
  }
  portfolio.unanchoredTurnFlag = false;

  writeSidecarAtomicSync(conversationId, sidecar);
  return {};
}

/**
 * Strict Antigravity `PreToolUse` Evaluator (`hooks/pre_tool_use.mjs`)
 *
 * Output contract: `{"decision": "allow" | "ask" | "deny", "reason"?: "..."}`
 */
import { runAirlockPromptBridge, runAirlockPreToolBridge } from '../core/airlock/hookBridge.mjs';

export async function runStrictPreToolUse(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  const workspacePath = inputData.cwd || inputData.workspacePath || (Array.isArray(inputData.workspacePaths) && inputData.workspacePaths[0]) || sidecar.workspacePath || process.cwd();
  const homeDir = inputData.homeDir || getHomeDir();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({ cwd: workspacePath, homeDir });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  const portfolio = ensurePortfolioState(sidecar);
  const currentTurn = Math.max(1, Number(inputData.turn ?? sidecar.sessionMeta?.turnCount ?? 1));

  const toolName = String(inputData.tool_name || inputData.tool || inputData.toolName || inputData.toolCall?.name || '').trim();
  const toolArgs = inputData.tool_input || inputData.args || inputData.parameters || inputData.Arguments || inputData.toolCall?.args || {};
  const userPrompt = String(inputData.lastUserInput ?? inputData.userPrompt ?? inputData.prompt ?? portfolio.lastUserPrompt ?? '');
  const { raw: rawTarget, absPath, realPath } = resolveTargetFileFromArgs(toolArgs, workspacePath);

  const syntheticStep = [{ toolCalls: [{ name: toolName, args: toolArgs }] }];

  const airlockPre = runAirlockPreToolBridge(
    {
      ...inputData,
      session_id: conversationId,
      cwd: workspacePath,
      tool_name: toolName,
      tool_input: toolArgs
    },
    { cwd: workspacePath, homeDir },
    { ...inputData, host: 'antigravity', horizonConfig }
  );
  if (airlockPre?.blocked) {
    return {
      decision: 'deny',
      overwrite: false,
      reason: airlockPre.stderr || airlockPre.verdict?.reason || 'Blocked by Highbeam Airlock PreToolUse guard',
      airlock: airlockPre.airlock
    };
  }

  // Ring-0 Security Gates (active in all modes unless explicitly disabled)
  // 1. Symlink-resolved .env* / *.pem / ~/.ssh/* denial (Rank 11 / DET-02)
  if (rawTarget && /^(view_file|read_file|write_to_file|write_file|replace_file_content|multi_replace_file_content|edit_file|grep_search)$/i.test(toolName)) {
    const cleanHomeSsh = path.join(homeDir, '.ssh').replace(/\\/g, '/').toLowerCase();
    const normReal = realPath.replace(/\\/g, '/');
    const inHomeSsh = normReal.toLowerCase().startsWith(`${cleanHomeSsh}/`) || normReal.toLowerCase() === cleanHomeSsh;
    if (inHomeSsh || isSensitiveCredentialPath(realPath) || isSensitiveCredentialPath(absPath)) {
      return {
        decision: 'deny',
        reason: `[DET-02] Access denied to symlink-resolved credential/key file "${path.basename(realPath)}".`
      };
    }
  }

  // Also check shell commands reading .env / .pem / .ssh
  if (/^(run_command|execute_bash|bash|powershell|exec)$/i.test(toolName)) {
    const cmdStr = String(toolArgs.CommandLine || toolArgs.command || toolArgs.cmd || '');
    if (/\b(?:cat|type|Get-Content|gc|head|tail|more|less)\s+['"]?(?:~\/\.ssh\/|[^\s'"]*\.pem\b|[^\s'"]*\/?\.env(?:\.(?!example|sample|template)[A-Za-z0-9_.-]+)?\b)/i.test(cmdStr)) {
      return {
        decision: 'deny',
        reason: '[DET-02] Shell credential read denied (.env / .pem / ~/.ssh/*).'
      };
    }
    if (resolveDetectorOverride(horizonConfig, 'DET-19') !== 'off') {
      const det19 = evaluateDet19GitHookBypass(syntheticStep);
      if (det19) return { decision: 'deny', reason: det19.message };
    }
    if (resolveDetectorOverride(horizonConfig, 'DET-08') !== 'off') {
      const det08Shell = evaluateDet08DestructiveShell(syntheticStep);
      if (det08Shell) return { decision: 'deny', reason: det08Shell.message };
    }
  }

  if (/^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|run_command)$/i.test(toolName)) {
    if (resolveDetectorOverride(horizonConfig, 'DET-18') !== 'off') {
      const det18 = evaluateDet18UntrustedWorkspaceSettings(syntheticStep, { workspacePath, scanWorkspace: false });
      if (det18) return { decision: 'deny', reason: det18.message };
    }
  }

  if (flightMode === 'OFF') {
    return { decision: 'allow' };
  }

  // Two-Stage Prompt Hygiene Sightseeing Interception (Scope Brake & Relay Breaker Web Search)
  const scopeOverride = resolveDetectorOverride(horizonConfig, 'vague-prompt-rubric');
  const relayOverride = resolveDetectorOverride(horizonConfig, 'relay-breaker');
  const twoStage = evaluateTwoStageSightseeingIntercept({
    toolName,
    toolArgs,
    unanchoredTurnFlag: Boolean(inputData.unanchoredTurnFlag ?? portfolio.unanchoredTurnFlag),
    candidateFiles: Array.isArray(inputData.candidateFiles)
      ? inputData.candidateFiles
      : (portfolio.candidateFiles || sidecar.fileState?.modifiedFiles || sidecar.fileState?.activeSetPaths || []),
    relayState: inputData.relayState ?? portfolio.relayState,
    overrideMode: scopeOverride !== 'default' ? scopeOverride : relayOverride,
    flightMode,
    detectorId: 'DET-26'
  });
  if (twoStage.intercepted) {
    if (twoStage.consumeFlag) {
      portfolio.unanchoredTurnFlag = false;
    }
    portfolio.sightseeingToolsPrevented = Number(portfolio.sightseeingToolsPrevented || 0) + 1;
    pushHudAlert(portfolio, 'DET-26', twoStage.reason, currentTurn);
    writeSidecarAtomicSync(conversationId, sidecar);
    return {
      decision: twoStage.decision,
      reason: twoStage.reason,
      detectorId: 'DET-26',
      subType: twoStage.subType
    };
  }

  // RSI-04 ('micro-skills'): Intercept known-broken repo shell commands before execution
  if (/^(run_command|execute_bash|bash|powershell|exec)$/i.test(toolName)) {
    const msOverride = resolveDetectorOverride(horizonConfig, 'micro-skills');
    if (msOverride !== 'off') {
      const cmdStr = String(toolArgs.CommandLine || toolArgs.command || toolArgs.cmd || '');
      const msRegistry = loadMicroSkillsRegistry(workspacePath);
      const msIntercept = evaluateMicroSkillIntercept(msRegistry, {
        command: cmdStr,
        flightMode,
        overrideMode: msOverride
      });
      if (msIntercept.triggered) {
        pushHudAlert(portfolio, 'RSI-04', msIntercept.hudAlert, currentTurn);
        writeSidecarAtomicSync(conversationId, sidecar);
        if (msIntercept.decision === 'deny') {
          return { decision: 'deny', reason: msIntercept.reason, detectorId: 'RSI-04', workingCmd: msIntercept.workingCmd };
        }
        return { decision: 'allow', reason: msIntercept.reason, detectorId: 'RSI-04', workingCmd: msIntercept.workingCmd };
      }
    }
  }

  // TurnZeroGate warm-cache rule fence (Core Invariant: zero mid-session mutations to AGENTS.md / GEMINI.md / .agents/rules/*.md)
  if (/^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(toolName)) {
    const cachedTokens = Number(inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? sidecar.telemetry?.totalInputTokens ?? 0);
    const det09 = evaluateDet09MidSessionRuleMutate(syntheticStep, {
      cachedTokens,
      cacheTtlSeconds: Number(inputData.cacheTtlSeconds ?? sidecar.telemetry?.cacheTtlSeconds ?? 300),
      cacheState: inputData.cacheState
    });
    if (det09) {
      pushHudAlert(portfolio, 'TurnZeroGate', det09.message, currentTurn);
      writeSidecarAtomicSync(conversationId, sidecar);
      if (flightMode === 'AUTO_PILOT' || cachedTokens > 3529) {
        return { decision: 'deny', reason: det09.message };
      }
    }
  }

  // Rank 5 (DET-04): 3-Strike Consecutive Tool Failure Breaker
  const det04 = evaluateDet04ConsecutiveFailureBreaker({
    toolName,
    toolArgs,
    failureStreaks: portfolio.failureStreaks,
    currentTurn,
    lastAlertTurnByKey: portfolio.lastAlertTurnByKey,
    cooldownTurns: 3,
    flightMode
  });
  if (det04.triggered) {
    portfolio.lastAlertTurnByKey = det04.lastAlertTurnByKey;
    if (det04.hudAlert) pushHudAlert(portfolio, 'DET-04', det04.hudAlert, currentTurn);
    writeSidecarAtomicSync(conversationId, sidecar);
    if (det04.decision === 'deny') {
      try {
        const ledger = new SavedQuotaReceiptLedger({ homeDir });
        ledger.recordSaving({
          sessionId: String(conversationId),
          eventType: SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED,
          tokensSaved: Math.max(1500, Math.round(Number(inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? 4000) * 0.15)),
          dedupeKey: `det04:${conversationId}:${currentTurn}:${toolName}`,
          detail: `DET-04 blocked 3-strike retry loop on ${toolName}`
        });
      } catch (err) {
        void err;
      }
      return { decision: 'deny', reason: det04.reason };
    }
  }

  // Track discovery calls for Rank 2 (DET-06 Blind New-Module Check)
  if (/^(grep_search|find_by_name|list_dir|glob|grep)$/i.test(toolName)) {
    portfolio.discoveryCallsCount += 1;
  }

  // Rank 6 (DET-06B): Lean Flash Subagent Search Offloader
  const activeModel = String(inputData.activeModel || inputData.modelName || sidecar.sessionMeta?.activeModel || '');
  const cachedTokens = Number(inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? 0);
  const det06b = evaluateDet06bFlashScoutOffloader({
    toolName,
    consecutiveReadSearchCount: portfolio.consecutiveReadSearchCount,
    activeModel,
    cachedTokens,
    isSubagent: Boolean(inputData.isSubagent || sidecar.sessionMeta?.isSubagent),
    flightMode
  });
  portfolio.consecutiveReadSearchCount = det06b.nextCount;
  if (det06b.triggered) {
    pushHudAlert(portfolio, 'DET-06B', det06b.hudAlert, currentTurn);
    writeSidecarAtomicSync(conversationId, sidecar);
    if (det06b.decision === 'deny') {
      return { decision: 'deny', reason: det06b.reason };
    }
  }

  // Rank 2a (DET-06): Unmodified File Re-Read Check & DET-20 Cross-Subagent Duplicate Read
  if (/^(view_file|read_file)$/i.test(toolName) && absPath) {
    const agentId = inputData.agentId || inputData.subagentId || inputData.agent_id || sidecar.sessionMeta?.agentId || null;
    if (agentId) {
      portfolio.subagentReadScopes = portfolio.subagentReadScopes || {};
      const normTarget = absPath.replace(/\\/g, '/').toLowerCase();
      const readers = Array.isArray(portfolio.subagentReadScopes[normTarget]) ? portfolio.subagentReadScopes[normTarget] : [];
      if (!readers.includes(agentId)) {
        readers.push(agentId);
        portfolio.subagentReadScopes[normTarget] = readers;
      }
      if (readers.length >= 2) {
        const msg = `[DET-20] Cross-subagent duplicate read of "${path.basename(absPath)}" by active agents (${readers.join(', ')}). Coordinate via StateBaton digest to avoid cold context duplication.`;
        pushHudAlert(portfolio, 'DET-20', msg, currentTurn);
        writeSidecarAtomicSync(conversationId, sidecar);
      }
    }

    // Rank 2a-2 (DET-07): Ignorable Lockfile & Minified Bundle Native Read Guard
    const startLine = toolArgs.StartLine ?? toolArgs.start_line ?? toolArgs.startLine ?? null;
    const endLine = toolArgs.EndLine ?? toolArgs.end_line ?? toolArgs.endLine ?? null;
    const limit = toolArgs.limit ?? toolArgs.Limit ?? null;
    const det07Ignorable = evaluateDet07IgnorableFileReadGuard({
      toolName,
      targetPath: rawTarget || absPath,
      startLine,
      endLine,
      limit,
      flightMode
    });
    if (det07Ignorable.triggered) {
      pushHudAlert(portfolio, 'DET-07', det07Ignorable.hudAlert, currentTurn);
      writeSidecarAtomicSync(conversationId, sidecar);
      if (det07Ignorable.decision === 'deny') {
        return { decision: 'deny', reason: det07Ignorable.reason, detectorId: 'DET-07' };
      }
    }

    const fileInfo = sha256FileSafe(absPath);
    if (fileInfo.exists) {
      const det06Read = evaluateDet06UnmodifiedReRead({
        absPath,
        sha256: fileInfo.sha256,
        mtimeMs: fileInfo.mtimeMs,
        startLine,
        endLine,
        currentTurn,
        readLedger: portfolio.readLedger,
        flightMode
      });
      portfolio.readLedger = det06Read.updatedLedger;
      if (det06Read.triggered) {
        pushHudAlert(portfolio, 'DET-06', det06Read.hudAlert, currentTurn);
        writeSidecarAtomicSync(conversationId, sidecar);
        if (det06Read.decision === 'deny') {
          try {
            const ledger = new SavedQuotaReceiptLedger({ homeDir });
            ledger.recordSaving({
              sessionId: String(conversationId),
              eventType: SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED,
              rawBytesSaved: Math.max(400, Number(fileInfo.size || 0)),
              dedupeKey: `det06:${conversationId}:${currentTurn}:${path.basename(absPath)}`,
              detail: `DET-06 blocked unmodified full-file re-read of ${path.basename(absPath)}`
            });
          } catch (err) {
            void err;
          }
          return { decision: 'deny', reason: det06Read.reason };
        }
      }
    }
  }

  // Rank 2b (DET-06 Blind New-Module & Turn-1 Blind Multi-File Edit) + Rank 1 (DET-05 Pre-Write Integrity)
  if (/^(write_to_file|write_file|replace_file_content|multi_replace_file_content|edit_file)$/i.test(toolName) && absPath) {
    portfolio.turn1EditedFiles = Array.isArray(portfolio.turn1EditedFiles) ? portfolio.turn1EditedFiles : [];
    const normKey = absPath.replace(/\\/g, '/');
    if (SOURCE_CODE_EXT_RE.test(normKey) && !BLIND_EDIT_EXEMPT_PATH_RE.test(normKey)) {
      if (currentTurn <= 1 && !portfolio.turn1EditedFiles.includes(normKey)) {
        portfolio.turn1EditedFiles.push(normKey);
      }
    }
    const fileInfo = sha256FileSafe(absPath);

    // Blind New-Module & Turn-1 Blind Multi-File Edit Check
    const explicitOverwrite = Boolean(toolArgs.Overwrite === true || toolArgs.overwrite === true);
    const isWriteTool = /^(write_to_file|write_file)$/i.test(toolName);
    const shouldCheckBlind = isWriteTool || (currentTurn <= 1 && portfolio.turn1EditedFiles.length >= 2);
    if (shouldCheckBlind) {
      const det06Blind = evaluateDet06BlindNewModule({
        targetPath: path.relative(workspacePath, absPath).replace(/\\/g, '/'),
        overwrite: explicitOverwrite,
        fileAlreadyExists: fileInfo.exists,
        discoveryCallsCount: portfolio.discoveryCallsCount,
        siblingSourceFileCount: inputData.siblingSourceFileCount ?? countSiblingSourceFiles(absPath),
        userPrompt,
        flightMode,
        editedFilesCount: portfolio.turn1EditedFiles.length,
        editedFiles: portfolio.turn1EditedFiles,
        turnCount: currentTurn
      });
      if (det06Blind.triggered) {
        pushHudAlert(portfolio, 'DET-06', det06Blind.hudAlert, currentTurn);
        writeSidecarAtomicSync(conversationId, sidecar);
        if (det06Blind.decision === 'ask') {
          return { decision: 'ask', reason: det06Blind.reason, detectorId: 'DET-06' };
        }
      }
    }

    // Rank 1 (DET-05): Pre-Write Destructive Code-Strip, Test-Assertion & 6-Turn FNV-1a Flip-Flop Guard
    const det05 = evaluateDet05PreWriteIntegrity({
      toolName,
      toolArgs,
      filePath: path.relative(workspacePath, absPath).replace(/\\/g, '/') || absPath,
      currentDiskContent: fileInfo.exists ? fileInfo.content : null,
      userPrompt,
      flightMode,
      fnvRing: portfolio.fnvRings[normKey] || [],
      turn: currentTurn
    });
    portfolio.fnvRings[normKey] = det05.ring;

    // Invalidate unmodified re-read cache for this file once mutated
    if (!det05.triggered || det05.decision !== 'deny') {
      portfolio.readLedger = portfolio.readLedger.filter((e) => e.absPath !== normKey);
    }

    if (det05.triggered) {
      pushHudAlert(portfolio, 'DET-05', det05.hudAlert, currentTurn);
      writeSidecarAtomicSync(conversationId, sidecar);
      if (det05.decision === 'deny') {
        return { decision: 'deny', reason: det05.reason };
      }
    }
  }

  // Rank 12 (DET-16): 80% Hybrid Quota Fan-Out Throttle & 40k/12-Turn Subagent Cap
  if (/^(invoke_subagent|swarm)$/i.test(toolName)) {
    const action = String(toolArgs.action || 'add').toLowerCase();
    if (toolName.toLowerCase() !== 'swarm' || action === 'add') {
      const baseQuotaUsedPct = Number(
        inputData.baseQuotaUsedPct ??
        sidecar.telemetry?.quota?.usedPct ??
        (sidecar.telemetry?.quota?.remaining_fraction !== undefined
          ? (1 - Number(sidecar.telemetry.quota.remaining_fraction)) * 100
          : 0)
      );
      const activeSubagentsCount = Number(
        inputData.activeSubagentsCount ??
        Object.values(sidecar.swarmRoster || {}).filter((w) => w && w.state !== 'terminated' && w.state !== 'killed').length
      );
      const requestedWorkers = Number(
        toolArgs.n ?? (Array.isArray(toolArgs.tasks) ? toolArgs.tasks.length : 1)
      );
      const det16 = evaluateDet16HybridQuotaThrottle({
        baseQuotaUsedPct,
        activeSubagentsCount,
        requestedWorkers,
        subagentTokens: Number(inputData.subagentTokens || 0),
        subagentTurns: Number(inputData.subagentTurns || 0)
      });
      if (det16.triggered) {
        pushHudAlert(portfolio, 'DET-16', det16.reason, currentTurn);
        writeSidecarAtomicSync(conversationId, sidecar);
        return { decision: det16.decision, reason: det16.reason };
      }
    }
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  return { decision: 'allow' };
}

/**
 * Strict Antigravity `PostToolUse` Recorder (`hooks/post_tool_use.mjs`)
 */
export async function runStrictPostToolUse(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  const portfolio = ensurePortfolioState(sidecar);
  const toolName = String(inputData.tool_name || inputData.tool || inputData.toolName || '').trim();
  const toolArgs = inputData.tool_input || inputData.args || inputData.parameters || {};
  const resp = inputData.tool_response || inputData.result || {};

  const exitCode = resp.exitCode ?? resp.exit_code ?? inputData.exitCode ?? inputData.exit_code;
  const failed = Boolean(
    (typeof exitCode === 'number' && exitCode !== 0) ||
    inputData.isError === true ||
    resp.isError === true ||
    String(inputData.status || resp.status || '').toUpperCase() === 'ERROR'
  );

  portfolio.failureStreaks = recordToolOutcomeForDet04({
    toolName,
    toolArgs,
    failed,
    failureStreaks: portfolio.failureStreaks
  });

  // Track active skill execution for Rank 9 (RSI-01 Skill Fault Router)
  if (/^(view_file|read_file)$/i.test(toolName)) {
    const p = String(toolArgs.Path || toolArgs.TargetFile || toolArgs.path || '').replace(/\\/g, '/');
    const skillMatch = p.match(/skills\/([a-zA-Z0-9_-]+)\/SKILL\.md$/i);
    if (skillMatch) {
      portfolio.lastExecutedSkill = skillMatch[1];
    }
  }

  // Rank 3 (DET-07) & RSI-04 ('micro-skills'): CLI hook integration & shell recovery learning
  if (/^(run_command|execute_bash|bash|powershell|exec)$/i.test(toolName)) {
    const workspacePath = inputData.cwd || inputData.workspacePath || (Array.isArray(inputData.workspacePaths) && inputData.workspacePaths[0]) || sidecar.workspacePath || process.cwd();
    const cmdStr = String(toolArgs.CommandLine || toolArgs.command || toolArgs.cmd || '');
    const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
      cwd: workspacePath,
      ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
    });
    if (cmdStr && resolveDetectorOverride(horizonConfig, 'micro-skills') !== 'off') {
      const currentTurn = Math.max(1, Number(inputData.turn ?? sidecar.sessionMeta?.turnCount ?? 1));
      const msOutcome = recordWorkspaceShellOutcome(workspacePath, {
        command: cmdStr,
        exitCode: typeof exitCode === 'number' ? exitCode : (failed ? 1 : 0),
        turn: currentTurn,
        sessionId: String(conversationId),
        confirmSessions: Number(horizonConfig.thresholds?.microSkillConfirmSessions ?? 2)
      });
      if (msOutcome.promotedSkill) {
        portfolio.lastPromotedMicroSkill = msOutcome.promotedSkill;
      }
    }

    const rawOut = String(resp.output ?? resp.stdout ?? inputData.stdout ?? '');
    if (rawOut.length > 4096) {
      const det07 = archiveAndCompressDet07Output(rawOut, {
        command: cmdStr || toolName,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
        sessionId: conversationId,
        workspaceDir: workspacePath,
        ledgerDbPath: inputData.ledgerDbPath || null
      });
      portfolio.lastDet07Summary = {
        archived: det07.archived,
        bytesSaved: det07.bytesSaved,
        tokensSaved: det07.tokensSaved,
        archiveDbPath: det07.archiveDbPath
      };
    }
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  return {};
}

/**
 * Trajectory Fallback Auditor for GUI Sessions where `PreToolUse` hooks may be bypassed.
 */
export function auditTrajectoryPortfolioFallback(steps = [], {
  userPrompt = '',
  flightMode = 'COACH'
} = {}) {
  const alerts = [];
  const fnvRings = {};
  let failureStreaks = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const calls = Array.isArray(step.toolCalls) ? step.toolCalls : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
    for (const call of calls) {
      const toolName = String(call?.name || call?.tool || '');
      const toolArgs = call?.args || call?.arguments || {};
      const fp = String(toolArgs.TargetFile || toolArgs.Path || toolArgs.path || '');
      if (/^(write_to_file|write_file|replace_file_content|multi_replace_file_content|edit_file)$/i.test(toolName)) {
        const res = evaluateDet05PreWriteIntegrity({
          toolName,
          toolArgs,
          filePath: fp,
          currentDiskContent: step.previousContent ?? null,
          userPrompt: step.userPrompt || userPrompt,
          flightMode,
          fnvRing: fnvRings[fp] || [],
          turn: i + 1
        });
        fnvRings[fp] = res.ring;
        if (res.triggered) alerts.push(res);
      }

      const failed = Boolean(step.status === 'ERROR' || (typeof step.exitCode === 'number' && step.exitCode !== 0));
      const check04 = evaluateDet04ConsecutiveFailureBreaker({
        toolName,
        toolArgs,
        failureStreaks,
        currentTurn: i + 1,
        flightMode
      });
      if (check04.triggered) alerts.push(check04);
      failureStreaks = recordToolOutcomeForDet04({ toolName, toolArgs, failed, failureStreaks });
    }
  }
  return { alerts, fnvRings, failureStreaks };
}
