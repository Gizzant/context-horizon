import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './paths.mjs';
import { loadHorizonConfig, filterFindingsByHorizonConfig } from './horizon_config.mjs';
import { inspectGitArgs } from '../shims/agy_git_guard.mjs';
import { detectShadowedFileBloat } from './telemetry/shadow_file_detector.mjs';
import { loadScopeLockRegistry, detectScopeCollision } from './telemetry/scope_lock_registry.mjs';
import { isProtectedPrefixFile, isWarmCacheState } from './prefix_cache_shield.mjs';

/**
 * Phase 1: Real-Time Event Multiplexer (`HookStateMachine`) &
 * 20 Canonical Deterministic Anti-Pattern Circuit Breakers (`DET-01` through `DET-20`).
 *
 * Executes 100% locally in Node.js with zero LLM API tokens and sub-10ms latency.
 */

export const UNTRUSTED_SETTINGS_FILES = Object.freeze([
  '.gemini/settings.json',
  '.gemini/hooks.json',
  '.agents/hooks.json',
  'hooks.json',
  '.vscode/settings.json',
  '.vscode/tasks.json',
  '.mcp.json'
]);

const PROTECTED_SETTINGS_OR_HOOKS_RE =
  /(^|[\\/])(\.gemini[\\/](settings|hooks)\.json|\.agents[\\/]hooks\.json|hooks\.json|\.vscode[\\/](settings|tasks)\.json|\.mcp\.json)$/i;

export function isProtectedSettingsOrHooksFile(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return false;
  return PROTECTED_SETTINGS_OR_HOOKS_RE.test(filePath.trim());
}

export function evaluateDet17ShadowFileBloat(steps = []) {
  const shadowRes = detectShadowedFileBloat(steps);
  return {
    detectorId: 'DET-17',
    triggered: Boolean(shadowRes.triggered && shadowRes.totalShadowWastedTokens > 0),
    severity: 'WARN',
    haltsGeneration: false,
    ...shadowRes,
    message: shadowRes.triggered
      ? `⚠️ DET-17 Alert: Shadow file context bloat (${shadowRes.shadowedFileCount} shadowed file(s), ~${shadowRes.totalShadowWastedTokens} wasted tokens).`
      : null
  };
}

function inspectSettingsContentHazards(rawContent = '', relLabel = '') {
  const text = String(rawContent || '');
  const hazards = [];

  if (
    /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/i.test(text) ||
    /\b(?:Invoke-WebRequest|iwr|irm|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i.test(text) ||
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|enc|encodedcommand)\b/i.test(text) ||
    /\bbase64\b[^\n|]*-d[^\n|]*\|\s*(?:ba|z)?sh\b/i.test(text) ||
    /\beval\s+\$\(/i.test(text)
  ) {
    hazards.push('REMOTE_OR_ENCODED_SHELL_RCE');
  }

  if (
    /"(?:autoApprove|yolo|dangerouslySkipPermissions|allowUnsandboxedCommands|bypassPermissions)"\s*:\s*true/i.test(text) ||
    /"chat\.tools\.autoApprove"\s*:\s*true/i.test(text) ||
    /"permissionMode"\s*:\s*"bypassPermissions"/i.test(text) ||
    /"runOn"\s*:\s*"folderOpen"/i.test(text)
  ) {
    hazards.push('PERMISSION_OR_AUTO_APPROVE_BYPASS');
  }

  const isCanonicalPluginHooksFile =
    /(?:^|[\\/])hooks\.json$/i.test(relLabel) &&
    !/\.agents[\\/]hooks\.json|\.gemini[\\/]hooks\.json/i.test(relLabel);

  if (
    /(?:^|["'\s])(?:\.\/|\.\.\\|\$\{workspaceFolder\}\/|\$WORKSPACE\/|\.agents\/plugins\/)[^\s"']+/i.test(text)
  ) {
    const strippedOfficialHooks = isCanonicalPluginHooksFile
      ? text.replace(/node\s+(?:--no-warnings\s+)?\.\/hooks\/(?:session_start|pre_invocation|post_invocation|pre_tool_use|post_tool_use|stop)\.mjs\b/g, () => 'TRUSTED_PLUGIN_HOOK')
      : text;
    if (/(?:^|["'\s])(?:\.\/|\.\.\\|\$\{workspaceFolder\}\/|\$WORKSPACE\/|\.agents\/plugins\/)[^\s"']+/i.test(strippedOfficialHooks)) {
      hazards.push('WORKSPACE_RELATIVE_HOOK_RCE');
    }
  }

  if (/(hooks\.json|\.mcp\.json)$/i.test(relLabel) && text.trim()) {
    try {
      const parsed = JSON.parse(text);
      const commandStrings = [];
      const collectCommands = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) collectCommands(item);
          return;
        }
        if (typeof node.command === 'string') {
          commandStrings.push({ id: node.id || '', cmd: node.command });
        }
        for (const val of Object.values(node)) {
          if (val && typeof val === 'object') collectCommands(val);
        }
      };
      collectCommands(parsed);
      for (const entry of commandStrings) {
        const isTrustedPluginRootRelHook =
          isCanonicalPluginHooksFile &&
          /^node\s+(?:--no-warnings\s+)?\.\/hooks\/(?:session_start|pre_invocation|post_invocation|pre_tool_use|post_tool_use|stop)\.mjs$/.test(entry.cmd.trim());
        const isTrustedHorizonPlugin =
          entry.cmd.includes('.gemini/config/plugins/agy-horizon') &&
          !entry.cmd.includes('./') &&
          !/\b(curl|wget|Invoke-WebRequest|iex)\b/i.test(entry.cmd);
        const isBenignDampener =
          entry.id === 'horizon-cli-dampener' &&
          entry.cmd.includes('[CLI Output Dampener]') &&
          !entry.cmd.includes('child_process') &&
          !/\b(curl|wget|Invoke-WebRequest|iex|spawn|exec)\b/i.test(entry.cmd);
        if (!isTrustedPluginRootRelHook && !isTrustedHorizonPlugin && !isBenignDampener) {
          hazards.push('UNTRUSTED_HOOK_OR_MCP_COMMAND');
          break;
        }
      }
    } catch {
      hazards.push('MALFORMED_HOOKS_CONFIG');
    }
  }

  return hazards;
}

export function evaluateDet18UntrustedWorkspaceSettings(paramsOrSteps = {}, context = {}) {
  if (Array.isArray(paramsOrSteps)) {
    const ctx = context && typeof context === 'object' ? context : {};
    if (ctx.scanWorkspace) {
      const scanRes = evaluateDet18UntrustedWorkspaceSettings({ ...ctx, scanWorkspace: true });
      if (scanRes.blocked) return scanRes;
    }
    for (const step of paramsOrSteps) {
      if (!step || typeof step !== 'object') continue;
      const calls = Array.isArray(step.toolCalls)
        ? step.toolCalls
        : (Array.isArray(step.tool_calls) ? step.tool_calls : [step]);
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        const toolName = String(call.name || call.toolName || call.tool || step.toolName || '').trim();
        const args = call.args || call.arguments || call.input || {};
        const userAuth = Boolean(ctx.userAuthorizedSettingsEdit || step.userAuthorizedSettingsEdit);
        const cmdStr = String(args.CommandLine || args.command || args.cmd || call.command || '').trim();
        if (cmdStr) {
          const execRes = evaluateDet18UntrustedWorkspaceSettings({
            command: cmdStr,
            userAuthorizedSettingsEdit: userAuth
          });
          if (execRes.blocked) return execRes;
        }
        const targetPath = String(
          args.Path || args.path || args.TargetFile || args.AbsolutePath || call.targetPath || ''
        ).trim();
        if (targetPath && /write|edit|replace|create|patch/i.test(toolName || 'write_file')) {
          const newContent = String(
            args.Content ?? args.CodeContent ?? args.Replacement ?? args.ReplacementContent ?? args.newContent ?? ''
          );
          const writeRes = evaluateDet18UntrustedWorkspaceSettings({
            targetPath,
            newContent,
            toolName,
            userAuthorizedSettingsEdit: userAuth
          });
          if (writeRes.blocked) return writeRes;
        }
      }
    }
    return null;
  }

  const params = paramsOrSteps && typeof paramsOrSteps === 'object' ? paramsOrSteps : {};
  const userAuthorized = Boolean(params.userAuthorizedSettingsEdit || params.userAuthorized);
  if (userAuthorized) {
    return {
      id: 'DET-18',
      detectorId: 'DET-18',
      blocked: false,
      triggered: false,
      severity: 'CRITICAL',
      haltsGeneration: false,
      hazards: []
    };
  }

  // Mode 1: Scan existing workspace config files on disk (used by PreInvocation / SessionStart checks)
  if (params.scanWorkspace) {
    const wsRoot = params.workspacePath || params.cwd || process.cwd();
    for (const relFile of UNTRUSTED_SETTINGS_FILES) {
      const fullPath = path.join(wsRoot, relFile);
      if (!fs.existsSync(fullPath)) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      const hazards = inspectSettingsContentHazards(raw, relFile);
      if (hazards.length > 0) {
        return {
          id: 'DET-18',
          detectorId: 'DET-18',
          blocked: true,
          triggered: true,
          severity: 'CRITICAL',
          haltsGeneration: true,
          targetPath: fullPath,
          hazards,
          message: `🚨 DET-18 Blocked: Untrusted workspace settings/hook injection detected in ${relFile} (${hazards.join(', ')}).`
        };
      }
    }
    return {
      id: 'DET-18',
      detectorId: 'DET-18',
      blocked: false,
      triggered: false,
      severity: 'CRITICAL',
      haltsGeneration: false,
      hazards: []
    };
  }

  // Mode 2: Inspect shell command writing/redirecting to protected settings/hooks files
  const cmdStr = String(params.command || params.cmdStr || '').trim();
  if (cmdStr) {
    const writesSettingsViaShell =
      /(?:>|>>|\btee\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bcp\b|\bmv\b|\bCopy-Item\b|\bMove-Item\b).*?(?:\.gemini[\\/](?:settings|hooks)\.json|\.agents[\\/]hooks\.json|(?:^|[\s"'\\/])hooks\.json|\.vscode[\\/](?:settings|tasks)\.json|\.mcp\.json)/i.test(
        cmdStr
      );
    if (writesSettingsViaShell) {
      const cmdHazards = inspectSettingsContentHazards(cmdStr, 'hooks.json');
      const hazards = cmdHazards.length > 0 ? cmdHazards : ['SHELL_SETTINGS_WRITE'];
      return {
        id: 'DET-18',
        detectorId: 'DET-18',
        blocked: true,
        triggered: true,
        severity: 'CRITICAL',
        haltsGeneration: true,
        command: cmdStr,
        hazards,
        message: `🚨 DET-18 Blocked: Unauthorized shell mutation of workspace settings/hooks config (${hazards.join(', ')}).`
      };
    }
  }

  // Mode 3: Direct write/edit tool targeting protected settings/hooks file
  const targetPath = String(params.targetPath || params.filePath || '').trim();
  if (!isProtectedSettingsOrHooksFile(targetPath)) {
    return {
      id: 'DET-18',
      detectorId: 'DET-18',
      blocked: false,
      triggered: false,
      severity: 'CRITICAL',
      haltsGeneration: false,
      hazards: []
    };
  }

  const newContent = String(params.newContent ?? params.content ?? '');
  const detectedHazards = inspectSettingsContentHazards(newContent, targetPath);
  const hazards = detectedHazards.length > 0 ? detectedHazards : ['UNAUTHORIZED_WORKSPACE_SETTINGS_MUTATION'];
  return {
    id: 'DET-18',
    detectorId: 'DET-18',
    blocked: true,
    triggered: true,
    severity: 'CRITICAL',
    haltsGeneration: true,
    targetPath,
    hazards,
    message: `🚨 DET-18 Blocked: Unauthorized workspace settings/hook mutation targeting ${path.basename(targetPath)} (${hazards.join(', ')}).`
  };
}

export function evaluateDet19GitHookBypass(cmdOrArgs, env = {}) {
  if (Array.isArray(cmdOrArgs)) {
    const isStepArray =
      cmdOrArgs.length === 0 || (typeof cmdOrArgs[0] === 'object' && cmdOrArgs[0] !== null);
    if (isStepArray) {
      const baseEnv = env && typeof env === 'object' ? (env.env || env) : {};
      for (const step of cmdOrArgs) {
        if (!step || typeof step !== 'object') continue;
        const calls = Array.isArray(step.toolCalls)
          ? step.toolCalls
          : (Array.isArray(step.tool_calls) ? step.tool_calls : [step]);
        for (const call of calls) {
          if (!call || typeof call !== 'object') continue;
          const args = call.args || call.arguments || call.input || {};
          const cmdStr = String(
            args.CommandLine || args.command || args.cmd || call.command || step.command || ''
          ).trim();
          if (!cmdStr) continue;
          const res = evaluateDet19GitHookBypass(cmdStr, call.env || step.env || baseEnv);
          if (res.blocked) return res;
        }
      }
      return null;
    }

    const res = inspectGitArgs(cmdOrArgs, env);
    return {
      id: 'DET-19',
      detectorId: 'DET-19',
      blocked: Boolean(res.blocked),
      triggered: Boolean(res.blocked),
      severity: 'CRITICAL',
      haltsGeneration: Boolean(res.blocked),
      reason: res.reason || null,
      subcommand: res.subcommand || null,
      flags: res.flags || [],
      message: res.blocked ? `🚨 DET-19 Blocked: ${res.reason}` : null
    };
  }

  const cmdStr = String(cmdOrArgs || '').trim();
  if (!cmdStr) {
    return { id: 'DET-19', detectorId: 'DET-19', blocked: false, triggered: false, severity: 'CRITICAL', haltsGeneration: false };
  }

  const segments = tokenizeShellCommandSegments(cmdStr);
  for (const rawTokens of segments) {
    const segEnv = { ...(env && typeof env === 'object' ? env : {}) };
    let idx = 0;
    while (idx < rawTokens.length) {
      const tok = rawTokens[idx];
      if (!tok.quoted && tok.value === '&') {
        idx++;
        continue;
      }
      if (!tok.quoted && /^(sudo|env|command)$/i.test(tok.value)) {
        idx++;
        continue;
      }
      const envMatch = !tok.quoted && tok.value.match(/^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (envMatch) {
        segEnv[envMatch[1]] = envMatch[2].replace(/^['"]|['"]$/g, '');
        idx++;
        continue;
      }
      break;
    }
    if (idx >= rawTokens.length) continue;
    const exeBase = path.posix
      .basename(rawTokens[idx].value.replace(/\\/g, '/'))
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const argTokens = rawTokens.slice(idx + 1);

    if (['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(exeBase)) {
      for (let j = 0; j < argTokens.length; j++) {
        const flagLow = argTokens[j].value.toLowerCase();
        if (!argTokens[j].quoted && (flagLow === '-c' || flagLow === '/c' || flagLow === '-command') && j + 1 < argTokens.length) {
          const nested = evaluateDet19GitHookBypass(argTokens[j + 1].value, segEnv);
          if (nested.blocked) return nested;
        }
      }
    }

    if (exeBase === 'git') {
      const guardRes = inspectGitArgs(argTokens.map((t) => t.value), segEnv);
      if (guardRes.blocked) {
        return {
          id: 'DET-19',
          detectorId: 'DET-19',
          blocked: true,
          triggered: true,
          severity: 'CRITICAL',
          haltsGeneration: true,
          reason: guardRes.reason,
          subcommand: guardRes.subcommand,
          flags: guardRes.flags,
          message: `🚨 DET-19 Blocked: ${guardRes.reason}`
        };
      }
    }
  }

  return { id: 'DET-19', detectorId: 'DET-19', blocked: false, triggered: false, severity: 'CRITICAL', haltsGeneration: false };
}

export function evaluateDet20ScopeCollision(paramsOrSteps = {}, context = {}) {
  if (Array.isArray(paramsOrSteps)) {
    const ctx = context && typeof context === 'object' ? context : {};
    const stepPaths = [];
    for (const step of paramsOrSteps) {
      if (!step || typeof step !== 'object') continue;
      const calls = Array.isArray(step.toolCalls)
        ? step.toolCalls
        : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
      for (const call of calls) {
        if (/write|edit|replace|create|patch/i.test(String(call?.name || call?.tool || ''))) {
          const args = call?.args || call?.arguments || call?.input || {};
          const p = args.Path || args.path || args.TargetFile || args.AbsolutePath;
          if (p) stepPaths.push(p);
        }
      }
    }
    const mergedClaims = Array.isArray(ctx.claimedPaths)
      ? [...ctx.claimedPaths, ...stepPaths]
      : stepPaths;
    const res = evaluateDet20ScopeCollision({
      sessionId: ctx.sessionId || ctx.currentTrajectoryId || ctx.trajectoryId || 'active-session',
      workspacePath: ctx.workspacePath || ctx.workspaceDir || ctx.cwd || '',
      claimedPaths: mergedClaims,
      leases: ctx.leases || ctx.activeLeases,
      enforceBlock: ctx.enforceBlock !== undefined ? Boolean(ctx.enforceBlock) : true
    });
    return res.triggered ? res : null;
  }

  const params = paramsOrSteps && typeof paramsOrSteps === 'object' ? paramsOrSteps : {};
  const sessionId = String(params.sessionId || params.currentTrajectoryId || params.trajectoryId || 'active-session');
  const wsDir = params.workspacePath || params.workspaceDir || params.cwd || '';
  const rawPaths = Array.isArray(params.claimedPaths)
    ? params.claimedPaths
    : (params.targetPath ? [params.targetPath] : []);
  const normalizedClaimed = rawPaths
    .filter(Boolean)
    .map((p) => {
      const s = String(p);
      if (wsDir && path.isAbsolute(s)) {
        return path.relative(wsDir, s).replace(/\\/g, '/');
      }
      return s.replace(/\\/g, '/');
    });

  const activeLeases = Array.isArray(params.leases)
    ? params.leases
    : (Array.isArray(params.activeLeases) ? params.activeLeases : (wsDir ? loadScopeLockRegistry(wsDir).leases : []));

  const collision = detectScopeCollision(sessionId, normalizedClaimed, activeLeases);
  if (!collision) {
    return {
      id: 'DET-20',
      detectorId: 'DET-20',
      blocked: false,
      triggered: false,
      severity: 'CRITICAL',
      haltsGeneration: false
    };
  }

  return {
    id: 'DET-20',
    detectorId: 'DET-20',
    blocked: Boolean(params.enforceBlock),
    triggered: true,
    severity: 'CRITICAL',
    haltsGeneration: Boolean(params.enforceBlock),
    conflictingTrajectoryId: collision.trajectoryId,
    conflictingPid: collision.pid,
    overlappingPaths: collision.overlappingPaths,
    source: collision.source || 'local',
    message: `🚨 DET-20 Scope Collision: [${collision.overlappingPaths.join(', ')}] leased by "${collision.trajectoryId}".`
  };
}

export const DETECTOR_CATALOG = Object.freeze({
  'DET-01': { id: 'DET-01', name: 'Retry Churn', severity: 'CRITICAL', haltsGeneration: true },
  'DET-02': { id: 'DET-02', name: 'Edit Oscillation', severity: 'CRITICAL', haltsGeneration: true },
  'DET-03': { id: 'DET-03', name: 'Test-Assertion Weakening', severity: 'CRITICAL', haltsGeneration: true },
  'DET-04': { id: 'DET-04', name: 'Synthetic Proof / Fake Screenshot Fabrication', severity: 'CRITICAL', haltsGeneration: true },
  'DET-05': { id: 'DET-05', name: 'Unverified [x] Task Completion', severity: 'HIGH', haltsGeneration: true },
  'DET-06': { id: 'DET-06', name: 'Redundant Full-File Re-Reads', severity: 'WARN', haltsGeneration: false },
  'DET-07': { id: 'DET-07', name: '<rrthought> Panic & Instruction-Loop Spiral', severity: 'CRITICAL', haltsGeneration: true },
  'DET-08': { id: 'DET-08', name: 'Unauthorized Brain / Git Destructive Command', severity: 'CRITICAL', haltsGeneration: true },
  'DET-09': { id: 'DET-09', name: 'Prefix-Busting Config Mutation', severity: 'HIGH', haltsGeneration: true },
  'DET-10': { id: 'DET-10', name: 'Unbounded CLI Output Flood', severity: 'WARN', haltsGeneration: false },
  'DET-11': { id: 'DET-11', name: 'Phantom File / Identifier Confabulation', severity: 'HIGH', haltsGeneration: false },
  'DET-12': { id: 'DET-12', name: 'Zombie Background Subprocess Leak', severity: 'HIGH', haltsGeneration: false },
  'DET-13': { id: 'DET-13', name: 'Premature Execution Without Plan Approval', severity: 'CRITICAL', haltsGeneration: true },
  'DET-14': { id: 'DET-14', name: 'Subagent File-Write Collision', severity: 'CRITICAL', haltsGeneration: true },
  'DET-15': { id: 'DET-15', name: 'Secret / Credential Leakage in Brain Artifacts', severity: 'CRITICAL', haltsGeneration: true },
  'DET-16': { id: 'DET-16', name: 'Silent Truncation / Placeholder Slop Injection', severity: 'CRITICAL', haltsGeneration: true },
  'DET-17': { id: 'DET-17', name: 'Shadow File Context Bloat', severity: 'WARN', haltsGeneration: false, evaluate: evaluateDet17ShadowFileBloat },
  'DET-18': { id: 'DET-18', name: 'Untrusted Workspace Settings & Hook Injection Guard', severity: 'CRITICAL', haltsGeneration: true, evaluate: evaluateDet18UntrustedWorkspaceSettings },
  'DET-19': { id: 'DET-19', name: 'Git Hook-Bypass Guard', severity: 'CRITICAL', haltsGeneration: true, evaluate: evaluateDet19GitHookBypass },
  'DET-20': { id: 'DET-20', name: 'Concurrent File-Scope Collision', severity: 'CRITICAL', haltsGeneration: false, evaluate: evaluateDet20ScopeCollision }
});

export function sha256Hex(content = '') {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function normalizeToolSignature(toolName = '', args = {}) {
  const cleanName = String(toolName || '').toLowerCase().trim();
  const sortedKeys = Object.keys(args || {}).sort();
  const normObj = {};
  for (const k of sortedKeys) {
    const val = args[k];
    normObj[k] = typeof val === 'string' ? val.trim().replace(/\s+/g, ' ') : val;
  }
  return `${cleanName}::${JSON.stringify(normObj)}`;
}

export function isTestFilePath(filePath = '') {
  const s = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return (
    /\.(test|spec)\.[a-z0-9]+$/i.test(s) ||
    /(^|\/)(test|tests|__tests__)\/.*\.(js|mjs|cjs|ts|tsx|py)$/i.test(s) ||
    /_test\.py$/i.test(s) ||
    /verify_.*\.(mjs|js|ts)$/i.test(s)
  );
}

export function tokenizeShellCommandSegments(cmdStr = '') {
  const input = String(cmdStr || '');
  const segments = [];
  let currentSegment = [];
  let buf = '';
  let tokenQuoted = false;
  let hasChars = false;
  let inSingle = false;
  let inDouble = false;

  const flushToken = () => {
    if (hasChars) {
      currentSegment.push({ value: buf, quoted: tokenQuoted });
      buf = '';
      tokenQuoted = false;
      hasChars = false;
    }
  };

  const flushSegment = () => {
    flushToken();
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        buf += input[i + 1];
        i++;
      } else if (ch === '`' && i + 1 < input.length && input[i + 1] === '"') {
        buf += '"';
        i++;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      tokenQuoted = true;
      hasChars = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      tokenQuoted = true;
      hasChars = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      flushToken();
      continue;
    }

    if (ch === ';' || ch === '\n' || ch === '\r') {
      flushSegment();
      continue;
    }

    if (ch === '&' && input[i + 1] === '&') {
      flushSegment();
      i++;
      continue;
    }

    if (ch === '|') {
      if (input[i + 1] === '|') i++;
      flushSegment();
      continue;
    }

    buf += ch;
    hasChars = true;
  }

  flushSegment();
  return segments;
}

export function isDestructiveOrBypassShellCommand(cmdStr = '', depth = 0) {
  if (!cmdStr || depth > 2) return false;
  const segments = tokenizeShellCommandSegments(cmdStr);

  for (const rawTokens of segments) {
    const segEnv = {};
    let idx = 0;

    while (idx < rawTokens.length) {
      const tok = rawTokens[idx];
      if (!tok.quoted && tok.value === '&') {
        idx++;
        continue;
      }
      if (!tok.quoted && /^(sudo|env|command)$/i.test(tok.value)) {
        idx++;
        continue;
      }
      const envMatch = !tok.quoted && tok.value.match(/^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (envMatch) {
        segEnv[envMatch[1]] = envMatch[2].replace(/^['"]|['"]$/g, '');
        idx++;
        continue;
      }
      break;
    }

    if (idx >= rawTokens.length) continue;

    const exeRaw = rawTokens[idx].value.replace(/\\/g, '/');
    const exeBase = path.posix
      .basename(exeRaw)
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const argTokens = rawTokens.slice(idx + 1);

    if (['echo', 'printf', 'write-host', 'write-output'].includes(exeBase)) {
      continue;
    }

    if (['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(exeBase)) {
      for (let j = 0; j < argTokens.length; j++) {
        const flagLow = argTokens[j].value.toLowerCase();
        if (!argTokens[j].quoted && (flagLow === '-c' || flagLow === '/c' || flagLow === '-command')) {
          if (j + 1 < argTokens.length && isDestructiveOrBypassShellCommand(argTokens[j + 1].value, depth + 1)) {
            return true;
          }
        }
      }
    }

    if (exeBase === 'git') {
      const gitArgs = argTokens.map(t => t.value);
      const guardRes = inspectGitArgs(gitArgs, segEnv);
      if (guardRes.blocked) {
        return true;
      }

      // Inspect unquoted destructive git subcommand flags (`reset --hard`, `push --force`, `clean -fd`)
      let subIdx = -1;
      for (let j = 0; j < argTokens.length; j++) {
        const val = argTokens[j].value;
        if (val === '--') break;
        if (val.startsWith('-')) {
          if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(val)) {
            j++;
          }
          continue;
        }
        subIdx = j;
        break;
      }

      if (subIdx !== -1) {
        const sub = argTokens[subIdx].value.toLowerCase();
        const subTokens = argTokens.slice(subIdx + 1);
        if (sub === 'reset') {
          if (subTokens.some(t => !t.quoted && t.value === '--hard')) return true;
        } else if (sub === 'push') {
          if (subTokens.some(t => !t.quoted && (t.value === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t.value)))) {
            return true;
          }
        } else if (sub === 'clean') {
          if (subTokens.some(t => !t.quoted && (t.value === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t.value)))) {
            return true;
          }
        }
      }
      continue;
    }

    if (exeBase === 'rm') {
      let hasRec = false;
      let hasForce = false;
      for (const t of argTokens) {
        if (/\.gemini[\\/]antigravity[\\/]brain/i.test(t.value)) return true;
        if (!t.quoted && t.value.startsWith('-')) {
          if (t.value === '--recursive') hasRec = true;
          else if (t.value === '--force') hasForce = true;
          else if (/^-[a-zA-Z]+$/.test(t.value)) {
            if (/[rR]/.test(t.value)) hasRec = true;
            if (/f/.test(t.value)) hasForce = true;
          }
        }
      }
      if (hasRec && hasForce) return true;
      continue;
    }

    if (['del', 'erase', 'remove-item', 'ri', 'rd', 'rmdir', 'unlink'].includes(exeBase)) {
      let hasRec = false;
      let hasForce = false;
      for (const t of argTokens) {
        if (/\.gemini[\\/]antigravity[\\/]brain/i.test(t.value)) return true;
        if (!t.quoted) {
          if (/^-recurse$/i.test(t.value)) hasRec = true;
          if (/^-force$/i.test(t.value)) hasForce = true;
        }
      }
      if ((exeBase === 'remove-item' || exeBase === 'ri') && hasRec && hasForce) {
        return true;
      }
    }
  }

  return false;
}

export function evaluateDet08DestructiveShell(stepsOrCmd = [], _context = {}) {
  if (typeof stepsOrCmd === 'string') {
    const blocked = isDestructiveOrBypassShellCommand(stepsOrCmd);
    return {
      id: 'DET-08',
      detectorId: 'DET-08',
      blocked,
      triggered: blocked,
      severity: 'CRITICAL',
      haltsGeneration: blocked,
      command: stepsOrCmd,
      message: blocked
        ? `🚨 DET-08 Blocked: Unauthorized destructive command intercepted ("${stepsOrCmd.slice(0, 80)}").`
        : null
    };
  }

  const list = Array.isArray(stepsOrCmd) ? stepsOrCmd : [];
  for (const step of list) {
    if (!step || typeof step !== 'object') continue;
    const calls = Array.isArray(step.toolCalls)
      ? step.toolCalls
      : (Array.isArray(step.tool_calls) ? step.tool_calls : [step]);
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      const toolName = String(call.name || call.toolName || call.tool || step.toolName || '').toLowerCase().trim();
      const args = call.args || call.arguments || call.input || {};
      const cmdStr = String(args.CommandLine || args.command || args.cmd || call.command || step.command || '').trim();
      const targetPath = String(args.Path || args.path || args.TargetFile || args.AbsolutePath || call.targetPath || '').trim();
      if (cmdStr && isDestructiveOrBypassShellCommand(cmdStr)) {
        return {
          id: 'DET-08',
          detectorId: 'DET-08',
          blocked: true,
          triggered: true,
          severity: 'CRITICAL',
          haltsGeneration: true,
          command: cmdStr,
          message: `🚨 DET-08 Blocked: Unauthorized destructive command intercepted ("${cmdStr.slice(0, 80)}").`
        };
      }
      if (/delete|remove/i.test(toolName) && /\.gemini[\\/]antigravity[\\/]brain/i.test(targetPath)) {
        return {
          id: 'DET-08',
          detectorId: 'DET-08',
          blocked: true,
          triggered: true,
          severity: 'CRITICAL',
          haltsGeneration: true,
          targetPath,
          message: `🚨 DET-08 Blocked: Unauthorized brain artifact deletion targeting ${targetPath}.`
        };
      }
    }
  }
  return null;
}

export function evaluateDet09MidSessionRuleMutate(steps = [], context = {}) {
  const cachedTokens = Number(context.cachedTokens ?? context.session?.cachedTokens ?? 0);
  const cacheTtlSeconds = Number(context.cacheTtlSeconds ?? context.session?.cacheTtlSeconds ?? 0);
  const warm = isWarmCacheState({
    cachedTokens,
    cacheTtlSeconds,
    cacheState: context.cacheState || context.session?.cacheState
  });
  if (!warm) return null;

  const list = Array.isArray(steps) ? steps : [];
  for (const step of list) {
    if (!step || typeof step !== 'object') continue;
    const calls = Array.isArray(step.toolCalls)
      ? step.toolCalls
      : (Array.isArray(step.tool_calls) ? step.tool_calls : [step]);
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      const toolName = String(call.name || call.toolName || call.tool || step.toolName || '').trim();
      if (toolName && !/write|edit|replace|delete|remove|create|patch/i.test(toolName)) continue;
      const args = call.args || call.arguments || call.input || {};
      const targetPath = String(
        args.Path || args.path || args.TargetFile || args.AbsolutePath || call.targetPath || ''
      ).trim();
      if (targetPath && isProtectedPrefixFile(targetPath)) {
        return {
          id: 'DET-09',
          detectorId: 'DET-09',
          blocked: true,
          triggered: true,
          severity: 'HIGH',
          haltsGeneration: true,
          targetPath,
          message: `🚨 DET-09 Blocked: Mid-session mutation of ${path.basename(targetPath)} while prompt cache is warm (${cachedTokens} tok, TTL ${cacheTtlSeconds}s).`
        };
      }
    }
  }
  return null;
}

function countAssertionsInCode(code = '') {
  const text = String(code || '');
  const assertMatches = text.match(/\b(assert(?:\.[a-zA-Z0-9_]+)?|expect|should)\s*\(/g) || [];
  const pyAssertMatches = text.match(/^\s*assert\s+/gm) || [];
  return assertMatches.length + pyAssertMatches.length;
}

function countSkipsInCode(code = '') {
  const text = String(code || '');
  const skips = text.match(/(\.(?:skip|todo)\s*\(|@pytest\.mark\.skip\b|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\()/g) || [];
  return skips.length;
}

/**
 * Evaluates a step or stream of steps across all 16 deterministic detectors (`DET-01` .. `DET-16`).
 */
export function evaluateDetectorsOnSteps(steps = [], context = {}) {
  const startHr = process.hrtime.bigint();
  const list = Array.isArray(steps) ? steps : [];
  const findings = [];

  const cachedTokens = Number(context.cachedTokens ?? context.session?.cachedTokens ?? 0);
  const cacheTtlSeconds = Number(context.cacheTtlSeconds ?? context.session?.cacheTtlSeconds ?? 0);
  const approvalGateEnabled = context.approvalGateEnabled !== false;
  const userAuthorizedTestDeletion = Boolean(context.userAuthorizedTestDeletion);
  const workspacePath = context.workspacePath || '';
  const existingFilesSet = context.existingFiles instanceof Set
    ? new Set(Array.from(context.existingFiles).map(p => canonicalizePath(p)))
    : null;
  const concurrentSessionTargets = context.concurrentSessionTargets || {}; // sessionId -> Set/Array of paths
  const currentSessionId = String(context.sessionId || 'active-session');

  // State trackers across turns
  let consecutiveRetrySig = '';
  let consecutiveRetryCount = 0;

  // DET-02: path -> Array<{ turnIndex, hash }>
  const fileHashHistory = new Map();

  // DET-04: track whether a recent screenshot was black / 0-byte / failed
  let recentBlackScreenshotTurn = -100;

  // DET-05: track most recent test runner exit code
  let lastTestRunnerExitCode = 0;
  let lastTestRunnerSeen = false;

  // DET-06: path::range::hash -> Array<turnIndex>
  const readHistory = new Map();

  // DET-07: consecutive task_boundary errors
  let consecutiveTaskBoundaryErrors = 0;

  // DET-13: track PLANNING phase & whether user approved
  let inPlanningPhase = false;
  let userApprovedPlan = Boolean(context.userApprovedPlan);
  const destructiveEditedFilesInPlan = new Set();

  for (let idx = 0; idx < list.length; idx++) {
    const step = list[idx] || {};
    const stepType = String(step.type || '').toUpperCase();
    const role = String(step.role || step.source || '').toLowerCase();
    const content = String(step.content || '');
    const thinking = String(step.thinking || step.rrthought || '');
    const calls = Array.isArray(step.toolCalls)
      ? step.toolCalls
      : (Array.isArray(step.tool_calls) ? step.tool_calls : []);

    // Check if user turn authorized test deletion or approved plan
    if (stepType === 'USER_INPUT' || role === 'user') {
      if (/\b(approve|approved|proceed|lgtm|looks good|go ahead)\b/i.test(content)) {
        userApprovedPlan = true;
        inPlanningPhase = false;
      }
    }

    // DET-07: <rrthought> Panic & Instruction-Loop Spiral
    const thoughtBlob = `${thinking}\n${content}`;
    const capsMatches = thoughtBlob.match(/\b(CRITICAL INSTRUCTIONS|MUST NOT FAIL|PANIC|DO NOT REPEAT THIS ERROR|IMPOSSIBLE STATE)\b/g) || [];
    const circularMatches = thoughtBlob.match(/\b(wait, no, actually|no wait that's wrong|wait let me rethink from scratch)\b/gi) || [];
    if (capsMatches.length >= 2 || circularMatches.length >= 3) {
      findings.push({
        detectorId: 'DET-07',
        turnIndex: idx,
        severity: 'CRITICAL',
        haltsGeneration: true,
        message: `🚨 DET-07 Blocked: <rrthought> panic or high-entropy instruction loop detected at turn #${idx}.`
      });
    }

    // DET-15: Secret / Credential Leakage in Brain Artifacts or Transcript
    const secretRe = /(\bsk-(?:proj-|live-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{24,}|\bAIza[0-9A-Za-z_-]{30,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{28,})/;
    if (secretRe.test(content)) {
      findings.push({
        detectorId: 'DET-15',
        turnIndex: idx,
        severity: 'CRITICAL',
        haltsGeneration: true,
        message: `🚨 DET-15 Blocked: Secret or credential token leakage detected in transcript/artifact at turn #${idx}.`
      });
    }

    // Check screenshot status for DET-04
    if (
      step.blackScreenshot === true ||
      step.screenshotByteLength === 0 ||
      /black screenshot|zero-byte screenshot|blank_screenshot|0 bytes screenshot/i.test(content)
    ) {
      recentBlackScreenshotTurn = idx;
    }

    for (const call of calls) {
      const toolName = String(call.name || call.tool || '').toLowerCase();
      const args = call.args || call.arguments || call.parameters || call.Arguments || {};
      const targetPath = String(
        args.Path || args.path || args.TargetFile || args.AbsolutePath || step.targetPath || ''
      ).trim();
      const canonTarget = targetPath ? canonicalizePath(targetPath) : '';
      const cmdStr = String(args.CommandLine || args.command || args.cmd || '');
      const exitCode = call.exitCode ?? step.exitCode ?? (step.status === 'ERROR' ? 1 : 0);
      const stderrStr = String(call.stderr || step.stderr || (exitCode !== 0 ? content : ''));
      const stdoutStr = String(call.stdout || step.stdout || content || '');

      // DET-01: Retry Churn (>=3 consecutive identical tool calls returning error)
      const sig = normalizeToolSignature(toolName, args);
      const isFailure = (typeof exitCode === 'number' && exitCode !== 0) || step.status === 'ERROR' || Boolean(call.error);
      if (isFailure) {
        if (sig === consecutiveRetrySig) {
          consecutiveRetryCount++;
        } else {
          consecutiveRetrySig = sig;
          consecutiveRetryCount = 1;
        }
        if (consecutiveRetryCount >= 3) {
          findings.push({
            detectorId: 'DET-01',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            toolName,
            message: `🚨 DET-01 Blocked: Retry Churn (${consecutiveRetryCount} consecutive failed calls to ${toolName}).`
          });
        }
      } else {
        consecutiveRetrySig = '';
        consecutiveRetryCount = 0;
      }

      // DET-07 (task_boundary consecutive errors)
      if (toolName === 'task_boundary' && isFailure) {
        consecutiveTaskBoundaryErrors++;
        if (consecutiveTaskBoundaryErrors >= 2) {
          findings.push({
            detectorId: 'DET-07',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            message: `🚨 DET-07 Blocked: Consecutive task_boundary tool errors (${consecutiveTaskBoundaryErrors}).`
          });
        }
      } else if (toolName === 'task_boundary') {
        consecutiveTaskBoundaryErrors = 0;
      }

      // Track test runner executions for DET-05
      const isExecTool = /^(run_command|execute_bash|bash|execute_command)$/.test(toolName);
      if (isExecTool && /\b(pytest|jest|vitest|cargo\s+test|npm\s+test|node\s+--test|go\s+test)\b/i.test(cmdStr)) {
        lastTestRunnerSeen = true;
        lastTestRunnerExitCode = typeof exitCode === 'number' ? exitCode : (isFailure ? 1 : 0);
      }

      // DET-08: Unauthorized Brain / Git Destructive Command (shell-tokenized to avoid quoted string false positives)
      const isWriteOrDelete = /write|edit|replace|delete|remove/i.test(toolName);
      if (isExecTool) {
        if (isDestructiveOrBypassShellCommand(cmdStr)) {
          findings.push({
            detectorId: 'DET-08',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            command: cmdStr,
            message: `🚨 DET-08 Blocked: Unauthorized destructive command intercepted ("${cmdStr.slice(0, 80)}").`
          });
        }
        const det19Exec = evaluateDet19GitHookBypass(cmdStr, call.env || step.env || {});
        if (det19Exec.blocked) {
          findings.push({
            detectorId: 'DET-19',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            command: cmdStr,
            reason: det19Exec.reason,
            message: det19Exec.message
          });
        }
        const det18Exec = evaluateDet18UntrustedWorkspaceSettings({
          command: cmdStr,
          userAuthorizedSettingsEdit: Boolean(context.userAuthorizedSettingsEdit || step.userAuthorizedSettingsEdit)
        });
        if (det18Exec.blocked) {
          findings.push({
            detectorId: 'DET-18',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            command: cmdStr,
            hazards: det18Exec.hazards,
            message: det18Exec.message
          });
        }
      }
      if (/delete|remove/i.test(toolName) && /\.gemini[\\/]antigravity[\\/]brain/i.test(targetPath)) {
        findings.push({
          detectorId: 'DET-08',
          turnIndex: idx,
          severity: 'CRITICAL',
          haltsGeneration: true,
          targetPath,
          message: `🚨 DET-08 Blocked: Unauthorized brain artifact deletion targeting ${targetPath}.`
        });
      }

      // DET-10: Unbounded CLI Output Flood (>12,000 chars)
      if (isExecTool && (stdoutStr.length > 12000 || stderrStr.length > 12000)) {
        findings.push({
          detectorId: 'DET-10',
          turnIndex: idx,
          severity: 'WARN',
          haltsGeneration: false,
          charCount: Math.max(stdoutStr.length, stderrStr.length),
          message: `⚠️ DET-10 Alert: Unbounded CLI output flood (${Math.max(stdoutStr.length, stderrStr.length)} chars > 12,000 limit).`
        });
      }

      // File read detectors (DET-06)
      const isReadTool = /^(read_file|view_file|read)$/.test(toolName);
      if (isReadTool && canonTarget) {
        const startLine = args.StartLine ?? args.start_line ?? 1;
        const endLine = args.EndLine ?? args.end_line ?? 'EOF';
        const fileHash = call.fileHash || step.fileHash || sha256Hex(stdoutStr || canonTarget);
        const readKey = `${canonTarget}::${startLine}-${endLine}::${fileHash}`;
        const prevReads = readHistory.get(readKey) || [];
        const recentReads = prevReads.filter(prevTurn => (idx - prevTurn) <= 15);
        recentReads.push(idx);
        readHistory.set(readKey, recentReads);

        if (recentReads.length >= 2) {
          findings.push({
            detectorId: 'DET-06',
            turnIndex: idx,
            severity: 'WARN',
            haltsGeneration: false,
            targetPath,
            message: `⚠️ DET-06 Alert: Redundant unchanged file re-read on ${path.basename(targetPath)} (${recentReads.length}x within 15 turns).`
          });
        }
      }

      // File write / edit detectors (DET-02, DET-03, DET-04, DET-05, DET-09, DET-11, DET-13, DET-14, DET-15, DET-16)
      if (isWriteOrDelete && targetPath) {
        const replacementChunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : null;
        const chunksNew = replacementChunks
          ? replacementChunks.map(ch => String(ch?.ReplacementContent ?? ch?.Replacement ?? ch?.newContent ?? '')).filter(Boolean).join('\n')
          : undefined;
        const chunksOld = replacementChunks
          ? replacementChunks.map(ch => String(ch?.TargetContent ?? ch?.Target ?? ch?.oldContent ?? '')).filter(Boolean).join('\n')
          : undefined;
        const newContent = String(
          args.Content ?? args.CodeContent ?? args.Replacement ?? args.ReplacementContent ?? chunksNew ?? args.newContent ?? call.newContent ?? step.newContent ?? ''
        );
        const oldContent = String(
          args.Target ?? args.TargetContent ?? chunksOld ?? args.oldContent ?? call.oldContent ?? step.oldContent ?? ''
        );

        // DET-18: Untrusted Workspace Settings & Hook Injection Guard
        const det18Write = evaluateDet18UntrustedWorkspaceSettings({
          targetPath,
          newContent,
          toolName,
          userAuthorizedSettingsEdit: Boolean(context.userAuthorizedSettingsEdit || step.userAuthorizedSettingsEdit)
        });
        if (det18Write.blocked) {
          findings.push({
            detectorId: 'DET-18',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            hazards: det18Write.hazards,
            message: det18Write.message
          });
        }

        // DET-15 on written content
        if (/walkthrough\.md|transcript\.jsonl/i.test(targetPath) && secretRe.test(newContent)) {
          findings.push({
            detectorId: 'DET-15',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-15 Blocked: Secret/credential leakage in brain artifact ${path.basename(targetPath)}.`
          });
        }

        // DET-02: Edit Oscillation (H1 -> H2 -> H1 within 6 turns)
        const nextHash = call.afterHash || step.afterHash || (newContent ? sha256Hex(newContent) : null);
        const prevHash = call.beforeHash || step.beforeHash || (oldContent ? sha256Hex(oldContent) : null);
        if (canonTarget && nextHash && !isFailure) {
          const hist = fileHashHistory.get(canonTarget) || [];
          if (hist.length === 0 && prevHash) {
            hist.push({ turnIndex: Math.max(0, idx - 1), hash: prevHash });
          }
          const oscillating = hist.some(
            h => h.hash === nextHash && (idx - h.turnIndex) <= 6 && hist[hist.length - 1]?.hash !== nextHash
          );
          hist.push({ turnIndex: idx, hash: nextHash });
          fileHashHistory.set(canonTarget, hist);

          if (oscillating) {
            findings.push({
              detectorId: 'DET-02',
              turnIndex: idx,
              severity: 'CRITICAL',
              haltsGeneration: true,
              targetPath,
              message: `🚨 DET-02 Blocked: Edit oscillation (H1 -> H2 -> H1 SHA-256 revert within 6 turns) on ${path.basename(targetPath)}.`
            });
          }
        }

        // DET-03: Test-Assertion Weakening
        if (isTestFilePath(targetPath) && !userAuthorizedTestDeletion && !step.userAuthorizedTestDeletion) {
          const beforeAssertions = countAssertionsInCode(oldContent);
          const afterAssertions = countAssertionsInCode(newContent);
          const beforeSkips = countSkipsInCode(oldContent);
          const afterSkips = countSkipsInCode(newContent);

          const deletedAssertions = Math.max(0, beforeAssertions - afterAssertions);
          const addedSkips = Math.max(0, afterSkips - beforeSkips);

          if (deletedAssertions > 0 || addedSkips > 0) {
            findings.push({
              detectorId: 'DET-03',
              turnIndex: idx,
              severity: 'CRITICAL',
              haltsGeneration: true,
              targetPath,
              deletedAssertions,
              addedSkips,
              message: `🚨 DET-03 Blocked: Agent attempted to delete ${deletedAssertions} expect()/assert() assertion(s) or add ${addedSkips} skip(s) in ${path.basename(targetPath)}`
            });
          }
        }

        // DET-04: Synthetic Proof / Fake Screenshot Fabrication
        const isBrainOrScratchScript =
          /(\.gemini[\\/]antigravity[\\/]brain|scratch)[\\/].*\.(py|js|mjs)$/i.test(targetPath);
        const importsVisionFabricator =
          /\b(PIL|ImageDraw|matplotlib|cv2|createCanvas)\b/.test(newContent);
        if (isBrainOrScratchScript && importsVisionFabricator && (idx - recentBlackScreenshotTurn) <= 4) {
          findings.push({
            detectorId: 'DET-04',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-04 Blocked: Synthetic proof / fake screenshot generator script detected in ${path.basename(targetPath)} following black screenshot.`
          });
        }

        // DET-05: Unverified [x] Task Completion
        if (/task\.md$/i.test(targetPath) && /[-*]\s*\[x\]/i.test(newContent) && lastTestRunnerSeen && lastTestRunnerExitCode !== 0) {
          findings.push({
            detectorId: 'DET-05',
            turnIndex: idx,
            severity: 'HIGH',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-05 Blocked: Agent marked task.md item [x] while most recent test run exited with code ${lastTestRunnerExitCode}.`
          });
        }
        if (/walkthrough\.md$/i.test(targetPath) && /\b(all tests pass|tests passed|0 errors)\b/i.test(newContent) && lastTestRunnerSeen && lastTestRunnerExitCode !== 0) {
          findings.push({
            detectorId: 'DET-05',
            turnIndex: idx,
            severity: 'HIGH',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-05 Blocked: Agent claimed passing tests in walkthrough.md while most recent test run exited with code ${lastTestRunnerExitCode}.`
          });
        }

        // DET-09: Prefix-Busting Config Mutation (aligned Antigravity rule globs; excludes CLAUDE.md / .claude/)
        const warmForDet09 = isWarmCacheState({
          cachedTokens,
          cacheTtlSeconds,
          cacheState: context.cacheState || context.session?.cacheState
        });
        if (isProtectedPrefixFile(targetPath) && warmForDet09) {
          findings.push({
            detectorId: 'DET-09',
            turnIndex: idx,
            severity: 'HIGH',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-09 Blocked: Mid-session mutation of ${path.basename(targetPath)} while prompt cache is warm (${cachedTokens} tok, TTL ${cacheTtlSeconds}s).`
          });
        }

        // DET-11: Phantom File / Identifier Confabulation in implementation_plan.md or walkthrough.md
        if (/(implementation_plan|walkthrough)\.md$/i.test(targetPath) && (existingFilesSet || workspacePath)) {
          const lines = newContent.split(/\r?\n/);
          for (const line of lines) {
            if (/\[NEW\]/i.test(line)) continue;
            const pathMatches = line.match(/\b(?:src|lib|app|sidecars|scripts|tests)\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|py|json|html)\b/g) || [];
            for (const refRel of pathMatches) {
              const absCandidate = workspacePath ? path.resolve(workspacePath, refRel) : refRel;
              const canonCandidate = canonicalizePath(absCandidate);
              const existsInSet = existingFilesSet
                ? (existingFilesSet.has(canonCandidate) || existingFilesSet.has(canonicalizePath(refRel)))
                : (workspacePath ? fs.existsSync(absCandidate) : true);
              if (!existsInSet) {
                findings.push({
                  detectorId: 'DET-11',
                  turnIndex: idx,
                  severity: 'HIGH',
                  haltsGeneration: false,
                  phantomPath: refRel,
                  message: `⚠️ DET-11 Alert: Phantom file path "${refRel}" referenced in ${path.basename(targetPath)} does not exist in workspace.`
                });
              }
            }
          }
        }

        // DET-13: Premature Execution Without Plan Approval
        if (/implementation_plan\.md$/i.test(targetPath)) {
          inPlanningPhase = true;
        } else if (
          inPlanningPhase &&
          approvalGateEnabled &&
          !userApprovedPlan &&
          !/(\.gemini[\\/]antigravity[\\/]brain|task\.md|implementation_plan\.md)/i.test(targetPath)
        ) {
          destructiveEditedFilesInPlan.add(canonTarget);
          if (destructiveEditedFilesInPlan.size >= 2) {
            findings.push({
              detectorId: 'DET-13',
              turnIndex: idx,
              severity: 'CRITICAL',
              haltsGeneration: true,
              targetPath,
              message: `🚨 DET-13 Blocked: Premature multi-file execution (${destructiveEditedFilesInPlan.size} files) without user approval after implementation_plan.md creation.`
            });
          }
        }

        // DET-14: Subagent File-Write Collision
        if (canonTarget && concurrentSessionTargets && typeof concurrentSessionTargets === 'object') {
          for (const [otherSid, targets] of Object.entries(concurrentSessionTargets)) {
            if (otherSid === currentSessionId) continue;
            const targetList = Array.isArray(targets) ? targets : Array.from(targets || []);
            if (targetList.some(t => canonicalizePath(t) === canonTarget)) {
              findings.push({
                detectorId: 'DET-14',
                turnIndex: idx,
                severity: 'CRITICAL',
                haltsGeneration: true,
                targetPath,
                conflictingSessionId: otherSid,
                message: `🚨 DET-14 Blocked: Subagent file-write collision on ${path.basename(targetPath)} with concurrent session ${otherSid}.`
              });
            }
          }
        }

        // DET-16: Silent Truncation / Placeholder Slop Injection
        const slopRe = /(\/\/\s*TODO:\s*implement\s+rest|\/\/\s*\.\.\.\s*existing\s+code\s*\.\.\.|#\s*\.\.\.\s*existing\s+code\s*\.\.\.|\/\*\s*\.\.\.\s*rest\s+of\s+code\s*\.\.\.\s*\*\/)/i;
        const oldLines = oldContent ? oldContent.split(/\r?\n/).length : 0;
        const newLines = newContent ? newContent.split(/\r?\n/).length : 0;
        const suddenLineDrop = oldLines >= 20 && newLines > 0 && ((oldLines - newLines) / oldLines) > 0.40;
        if (slopRe.test(newContent) || suddenLineDrop) {
          findings.push({
            detectorId: 'DET-16',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-16 Blocked: Silent truncation or placeholder slop injection detected in ${path.basename(targetPath)}.`
          });
        }
      }
    }

    // DET-12: Zombie Background Subprocess Leak on turn completion
    const orphans = Array.isArray(step.orphanedProcesses)
      ? step.orphanedProcesses
      : (idx === list.length - 1 && Array.isArray(context.orphanedProcesses) ? context.orphanedProcesses : []);
    for (const proc of orphans) {
      const pName = String(proc.name || '').toLowerCase();
      if (/(python|python3|node|cargo|pytest)/.test(pName) && (proc.cpuPct === 0 || proc.orphaned === true || proc.parentAlive === false)) {
        findings.push({
          detectorId: 'DET-12',
          turnIndex: idx,
          severity: 'HIGH',
          haltsGeneration: false,
          pid: proc.pid,
          processName: proc.name,
          message: `⚠️ DET-12 Alert: Zombie background subprocess leak (${proc.name} PID ${proc.pid}, 0% CPU / orphaned).`
        });
      }
    }
  }

  // DET-17: Shadow File Context Bloat across transcript steps
  if (list.length > 0) {
    const det17Res = evaluateDet17ShadowFileBloat(list);
    if (det17Res.triggered) {
      findings.push({
        detectorId: 'DET-17',
        turnIndex: list.length - 1,
        severity: 'WARN',
        haltsGeneration: false,
        shadowedFileCount: det17Res.shadowedFileCount,
        totalShadowWastedTokens: det17Res.totalShadowWastedTokens,
        message: det17Res.message
      });
    }
  }

  // DET-20: Concurrent Multi-Agent Scope Lock Collision
  if (Array.isArray(context.scopeLeases) || context.checkScopeLocks === true) {
    const editedStepPaths = [];
    for (const s of list) {
      const cList = Array.isArray(s?.toolCalls) ? s.toolCalls : (Array.isArray(s?.tool_calls) ? s.tool_calls : []);
      for (const c of cList) {
        if (/write|edit|replace|create|patch/i.test(String(c?.name || c?.tool || ''))) {
          const p = c?.args?.Path || c?.args?.path || c?.args?.TargetFile || c?.args?.AbsolutePath;
          if (p) editedStepPaths.push(p);
        }
      }
    }
    const claimedForDet20 = Array.isArray(context.claimedPaths)
      ? [...context.claimedPaths, ...editedStepPaths]
      : editedStepPaths;
    if (claimedForDet20.length > 0) {
      const det20Res = evaluateDet20ScopeCollision({
        sessionId: currentSessionId,
        claimedPaths: claimedForDet20,
        workspacePath: workspacePath || context.cwd || '',
        leases: context.scopeLeases,
        enforceBlock: Boolean(context.enforceScopeBlock)
      });
      if (det20Res.triggered) {
        findings.push({
          detectorId: 'DET-20',
          turnIndex: Math.max(0, list.length - 1),
          severity: 'CRITICAL',
          haltsGeneration: Boolean(det20Res.haltsGeneration),
          conflictingTrajectoryId: det20Res.conflictingTrajectoryId,
          overlappingPaths: det20Res.overlappingPaths,
          message: det20Res.message
        });
      }
    }
  }

  const normalizedFindings = findings.map((f) => ({
    ...f,
    id: f.id || f.detectorId,
    detectorId: f.detectorId || f.id
  }));
  const activeConfig =
    context.horizonConfig ||
    (context.cwd || context.workspacePath || context.configPath
      ? loadHorizonConfig(context)
      : null);
  const filteredFindings = filterFindingsByHorizonConfig(normalizedFindings, activeConfig);

  const elapsedMs = Number(process.hrtime.bigint() - startHr) / 1e6;
  const shouldHalt = filteredFindings.some(f => f.haltsGeneration);

  return {
    findings: filteredFindings,
    shouldHalt,
    haltFinding: filteredFindings.find(f => f.haltsGeneration) || null,
    elapsedMs: Number(elapsedMs.toFixed(3))
  };
}

/**
 * Real-Time Event Multiplexer (`HookStateMachine`) synthesizing `PreInvocation`,
 * `PreToolUse`, `PostToolUse`, and `Stop` events and triggering `AgBridgeService.pauseActiveGeneration`
 * when a critical detector trips.
 */
export class HookStateMachine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bridge = options.bridge || null;
    this.sessionId = options.sessionId || 'default-session';
    this.context = options.context || {};
    this.steps = [];
    this.activeFindings = [];
    this.paused = false;
  }

  async ingestStep(step = {}, eventType = 'PostToolUse') {
    this.steps.push(step);
    this.emit(eventType, step);

    const evalRes = evaluateDetectorsOnSteps(this.steps, {
      ...this.context,
      sessionId: this.sessionId
    });
    this.activeFindings = evalRes.findings;

    if (evalRes.shouldHalt && !this.paused) {
      this.paused = true;
      const haltReason = evalRes.haltFinding?.detectorId || 'CIRCUIT_BREAKER';
      this.emit('CircuitBreakerTrip', evalRes.haltFinding);
      if (this.bridge && typeof this.bridge.pauseActiveGeneration === 'function') {
        await this.bridge.pauseActiveGeneration(this.sessionId, {
          reason: haltReason,
          finding: evalRes.haltFinding
        });
      }
      this.emit('Stop', { reason: haltReason, finding: evalRes.haltFinding });
    }

    return evalRes;
  }
}

export default HookStateMachine;
