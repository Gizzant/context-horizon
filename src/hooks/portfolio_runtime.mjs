import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSidecarSync, writeSidecarAtomicSync } from '../core/sidecar_store.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../core/horizon_config.mjs';
import { getHomeDir } from '../core/paths.mjs';
import {
  evaluateDet02PreInvocationHold,
  isSensitiveCredentialPath,
  evaluateDet04ConsecutiveFailureBreaker,
  recordToolOutcomeForDet04,
  evaluateDet05PreWriteIntegrity,
  evaluateDet06UnmodifiedReRead,
  evaluateDet06BlindNewModule,
  evaluateDet06bFlashScoutOffloader,
  evaluateDet16HybridQuotaThrottle,
  evaluateDet20VisionOverageGuard
} from '../core/shared/detectors.mjs';
import { archiveAndCompressDet07Output } from '../shims/agy_cli_compressor.mjs';
import {
  evaluateDet08DestructiveShell,
  evaluateDet09MidSessionRuleMutate,
  evaluateDet18UntrustedWorkspaceSettings,
  evaluateDet19GitHookBypass
} from '../core/detectors_det01_to_16.mjs';

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
  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  if (flightMode === 'OFF') return {};

  const prompt = String(inputData.prompt ?? inputData.user_input ?? inputData.message ?? '');
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

  // 2. Rank 12 (DET-20): Vision Overage HTTP 400 Quirk Guard
  const quirks = inputData.platformQuirks || loadPlatformQuirksSafe(workspacePath);
  const hasImageAttachment = Boolean(
    inputData.hasImageAttachment ||
    (Array.isArray(inputData.media) && inputData.media.some((m) => String(m?.mime_type || m?.mimeType || '').startsWith('image/'))) ||
    (Array.isArray(inputData.attachments) && inputData.attachments.some((a) => /image|\.(png|jpg|jpeg|webp|gif)$/i.test(String(a?.mimeType || a?.type || a?.name || ''))))
  );
  const aiCreditOveragesActive = Boolean(
    inputData.aiCreditOveragesActive ??
    sidecar.telemetry?.quota?.aiCreditOveragesActive ??
    (Number(inputData.baseQuotaUsedPct ?? sidecar.telemetry?.quota?.usedPct ?? 0) >= 100 && inputData.overageEnabled !== false)
  );
  const det20 = evaluateDet20VisionOverageGuard({
    quirkConfig: quirks.visionOverageHttp400 || { enabled: true },
    aiCreditOveragesActive,
    hasImageAttachment
  });
  if (det20.triggered) {
    pushHudAlert(portfolio, 'DET-20', det20.warningMessage, sidecar.sessionMeta?.turnCount || 1);
    writeSidecarAtomicSync(conversationId, sidecar);
    return flightMode === 'SILENT' ? {} : { ephemeralMessage: det20.ephemeralMessage };
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  return {};
}

/**
 * Strict Antigravity `PreToolUse` Evaluator (`hooks/pre_tool_use.mjs`)
 *
 * Output contract: `{"decision": "allow" | "ask" | "deny", "reason"?: "..."}`
 */
export async function runStrictPreToolUse(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const homeDir = inputData.homeDir || getHomeDir();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({ cwd: workspacePath, homeDir });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  const portfolio = ensurePortfolioState(sidecar);
  const currentTurn = Math.max(1, Number(inputData.turn ?? sidecar.sessionMeta?.turnCount ?? 1));

  const toolName = String(inputData.tool_name || inputData.tool || inputData.toolName || '').trim();
  const toolArgs = inputData.tool_input || inputData.args || inputData.parameters || inputData.Arguments || {};
  const userPrompt = String(inputData.userPrompt ?? inputData.prompt ?? portfolio.lastUserPrompt ?? '');
  const { raw: rawTarget, absPath, realPath } = resolveTargetFileFromArgs(toolArgs, workspacePath);

  const syntheticStep = [{ toolCalls: [{ name: toolName, args: toolArgs }] }];

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

  // Rank 2a (DET-06): Unmodified File Re-Read Check
  if (/^(view_file|read_file)$/i.test(toolName) && absPath) {
    const fileInfo = sha256FileSafe(absPath);
    if (fileInfo.exists) {
      const startLine = toolArgs.StartLine ?? toolArgs.start_line ?? toolArgs.startLine ?? null;
      const endLine = toolArgs.EndLine ?? toolArgs.end_line ?? toolArgs.endLine ?? null;
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
          return { decision: 'deny', reason: det06Read.reason };
        }
      }
    }
  }

  // Rank 2b (DET-06 Blind New-Module) + Rank 1 (DET-05 Pre-Write Integrity)
  if (/^(write_to_file|write_file|replace_file_content|multi_replace_file_content|edit_file)$/i.test(toolName) && absPath) {
    const fileInfo = sha256FileSafe(absPath);

    // Blind New-Module Check when creating a brand-new source file
    if (/^(write_to_file|write_file)$/i.test(toolName)) {
      const explicitOverwrite = Boolean(toolArgs.Overwrite === true || toolArgs.overwrite === true);
      const det06Blind = evaluateDet06BlindNewModule({
        targetPath: path.relative(workspacePath, absPath).replace(/\\/g, '/'),
        overwrite: explicitOverwrite,
        fileAlreadyExists: fileInfo.exists,
        discoveryCallsCount: portfolio.discoveryCallsCount,
        siblingSourceFileCount: inputData.siblingSourceFileCount ?? countSiblingSourceFiles(absPath),
        userPrompt,
        flightMode
      });
      if (det06Blind.triggered) {
        pushHudAlert(portfolio, 'DET-06', det06Blind.hudAlert, currentTurn);
        writeSidecarAtomicSync(conversationId, sidecar);
        if (det06Blind.decision === 'ask') {
          return { decision: 'ask', reason: det06Blind.reason };
        }
      }
    }

    // Rank 1 (DET-05): Pre-Write Destructive Code-Strip, Test-Assertion & 6-Turn FNV-1a Flip-Flop Guard
    const normKey = absPath.replace(/\\/g, '/');
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

  // Rank 3 (DET-07): CLI hook integration — archive >4,096-char CLI output into 5 MB FTS5 SQLite
  if (/^(run_command|execute_bash|bash|powershell|exec)$/i.test(toolName)) {
    const rawOut = String(resp.output ?? resp.stdout ?? inputData.stdout ?? '');
    if (rawOut.length > 4096) {
      const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
      const cmdStr = String(toolArgs.CommandLine || toolArgs.command || toolName);
      const det07 = archiveAndCompressDet07Output(rawOut, {
        command: cmdStr,
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
