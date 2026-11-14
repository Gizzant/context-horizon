/**
 * Shared Node-layer Airlock Hook Bridge for Claude Code CLI handlers.
 * Centralizes policy/key/salt loading, Pro licensing gate, 3.5s watchdog setup,
 * FM-1..FM-11 evaluation, instruction file static scan, and tamper-evident ledger logging.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateAirlockPreToolGuard,
  evaluateAirlockPromptGuard,
  scanInstructionFilesForSecrets,
  cloneAndScrubToolResponse,
  isTestedClaudeCodeVersion,
  resolveAirlockConfig
} from '../../core-isomorphic/airlock/index.mjs';
import {
  loadAirlockPolicy,
  getOrCreateSessionHmacKey,
  getOrCreateOrgSalts,
  readStrikeState,
  writeStrikeState,
  resolveAirlockStateDir
} from './policyLoader.mjs';
import { AirlockAuditLedger } from './auditLedger.mjs';
import { requireProFeature } from '../pro_license.mjs';

function extractToolUseId(event = {}) {
  return String(event.tool_use_id || event.toolUseId || event.call_id || event.id || '').trim();
}

function extractHostVersion(event = {}, options = {}) {
  return String(
    options.hostVersion ||
    event.claude_code_version ||
    event.host_version ||
    event.version ||
    process.env.CLAUDE_CODE_VERSION ||
    ''
  ).trim();
}

function collectSafeMatchMeta(matches = []) {
  const categories = [...new Set(matches.map((m) => m.category).filter(Boolean))];
  const entityHmacs = [...new Set(matches.map((m) => m.entityHmac).filter(Boolean))];
  return { categories, entityHmacs };
}

export function resolveAirlockRuntime(event = {}, cwdOptions = {}, options = {}) {
  const cwd = event.cwd || cwdOptions.cwd || '';
  const stateDir = options.airlockStateDir || options.stateDir || cwdOptions.airlockStateDir;
  const horizonConfig = options.horizonConfig || cwdOptions.horizonConfig || {};
  const loaded = loadAirlockPolicy({
    cwd,
    policyPath: options.airlockPolicyPath || cwdOptions.airlockPolicyPath,
    stateDir,
    horizonConfig,
    publicKeyPem: options.publicKeyPem,
    hmacKey: options.hmacKey
  });

  const overridePolicy = options.airlockPolicy && typeof options.airlockPolicy === 'object'
    ? options.airlockPolicy
    : null;
  const effectivePolicy = overridePolicy ? { ...loaded.policy, ...overridePolicy } : loaded.policy;

  const overrideAirlock = options.airlock && typeof options.airlock === 'object'
    ? options.airlock
    : (typeof options.airlock === 'boolean' ? { enabled: options.airlock } : {});

  const envObj = {
    ...process.env,
    ...(options.airlockMode ? { AH_AIRLOCK_MODE: options.airlockMode } : {})
  };
  const config = resolveAirlockConfig(horizonConfig, { ...effectivePolicy, ...overrideAirlock }, envObj);

  if (!config.enabled || config.mode === 'off') {
    return { active: false, unlicensed: false, config, policy: effectivePolicy, loaded, stateDir: resolveAirlockStateDir({ stateDir }) };
  }

  const proGate = requireProFeature('airlock_context_module', {
    strict: Boolean(options.strictLicense),
    licensePath: options.licensePath
  });
  if (!proGate.allowed) {
    return {
      active: false,
      unlicensed: true,
      upgradeHint: proGate.upgradeHint,
      config,
      policy: effectivePolicy,
      loaded,
      stateDir: resolveAirlockStateDir({ stateDir })
    };
  }

  const resolvedStateDir = resolveAirlockStateDir({ stateDir });
  const sessionId = String(event.session_id || event.sessionId || 'default');
  const sessionKey = getOrCreateSessionHmacKey(sessionId, { stateDir: resolvedStateDir });
  const orgSalts = getOrCreateOrgSalts({ stateDir: resolvedStateDir });
  const hostVersion = extractHostVersion(event, options);
  const versionCheck = isTestedClaudeCodeVersion(hostVersion);

  return {
    active: true,
    unlicensed: false,
    sessionId,
    cwd,
    stateDir: resolvedStateDir,
    config,
    policy: effectivePolicy,
    loaded,
    sessionKey,
    orgAuditSalt: orgSalts.orgAuditSalt,
    orgAllowlistSalt: orgSalts.orgAllowlistSalt,
    hostVersion,
    versionCheck
  };
}

function openLedger(runtime, options = {}) {
  return new AirlockAuditLedger({
    stateDir: runtime.stateDir,
    forceFallback: Boolean(options.forceLedgerFallback)
  });
}

export function runAirlockPreToolBridge(event = {}, cwdOptions = {}, options = {}) {
  const startedMs = Date.now();
  const runtime = resolveAirlockRuntime(event, cwdOptions, options);
  if (!runtime.active) return null;

  const strikeState = readStrikeState(runtime.sessionId, { stateDir: runtime.stateDir });
  const guard = evaluateAirlockPreToolGuard(event, {
    policy: runtime.policy,
    mode: runtime.config.mode,
    sessionKey: runtime.sessionKey,
    orgAuditSalt: runtime.orgAuditSalt,
    orgAllowlistSalt: runtime.orgAllowlistSalt,
    strikeCount: strikeState.strikeCount,
    strikeCap: runtime.config.fm1StrikeCap
  });

  const toolName = String(event.tool_name || event.toolName || event.toolCall?.name || '');
  const toolUseId = extractToolUseId(event);
  const combinedMatches = [...(guard.matches || []), ...(guard.auditOnlyMatches || [])];
  const { categories } = collectSafeMatchMeta(combinedMatches);

  const ledger = openLedger(runtime, options);
  try {
    if (guard.blocked) {
      if (guard.fmCode === 'FM-1') {
        writeStrikeState(
          runtime.sessionId,
          {
            strikeCount: guard.strikeCount,
            totalBlocked: strikeState.totalBlocked + 1,
            lastFmCode: 'FM-1'
          },
          { stateDir: runtime.stateDir }
        );
      }

      ledger.recordEvent({
        sessionId: runtime.sessionId,
        host: options.host || 'claude_code',
        hookPhase: 'PreToolUse',
        toolName,
        decision: 'deny',
        fmCode: guard.fmCode || '',
        categories,
        entityHmacs: guard.uniqueEntityHmacs || [],
        matchCount: (guard.matches || []).length,
        auditOnlyCount: (guard.auditOnlyMatches || []).length,
        hostVersion: runtime.hostVersion,
        latencyMs: Date.now() - startedMs
      });

      return {
        blocked: true,
        exitCode: 2,
        stdout: '',
        stderr: guard.reason,
        verdict: {
          triggered: true,
          decision: 'deny',
          fmCode: guard.fmCode,
          reason: guard.reason
        },
        airlock: {
          active: true,
          blocked: true,
          fmCode: guard.fmCode,
          strikeCount: guard.strikeCount,
          strikeCapReached: guard.strikeCapReached,
          uniqueEntityHmacs: guard.uniqueEntityHmacs || []
        }
      };
    }

    if (toolUseId) {
      ledger.recordPreToolInFlight({
        sessionId: runtime.sessionId,
        toolUseId,
        toolName,
        host: options.host || 'claude_code'
      });
    }

    if (guard.auditOnlyMatches?.length > 0 || guard.auditOnly) {
      ledger.recordEvent({
        sessionId: runtime.sessionId,
        host: options.host || 'claude_code',
        hookPhase: 'PreToolUse',
        toolName,
        decision: 'audit_only',
        fmCode: guard.fmCode || '',
        categories,
        entityHmacs: guard.uniqueEntityHmacs || [],
        matchCount: (guard.matches || []).length,
        auditOnlyCount: (guard.auditOnlyMatches || []).length,
        hostVersion: runtime.hostVersion,
        latencyMs: Date.now() - startedMs
      });
    }

    return {
      blocked: false,
      airlock: {
        active: true,
        blocked: false,
        auditOnly: Boolean(guard.auditOnly),
        auditOnlyCount: (guard.auditOnlyMatches || []).length,
        uniqueEntityHmacs: guard.uniqueEntityHmacs || []
      }
    };
  } finally {
    ledger.close();
  }
}

export function runAirlockPostToolBridge(event = {}, cwdOptions = {}, options = {}, runInnerFn) {
  const startedMs = Date.now();
  const runtime = resolveAirlockRuntime(event, cwdOptions, options);
  if (!runtime.active) {
    return runInnerFn({ ...event, __airlockWrapped: true }, options);
  }

  const toolName = String(event.tool_name || event.toolName || '');
  const toolUseId = extractToolUseId(event);
  const shaped = cloneAndScrubToolResponse(event, {
    policy: runtime.policy,
    mode: runtime.config.mode,
    sessionKey: runtime.sessionKey,
    orgAuditSalt: runtime.orgAuditSalt,
    orgAllowlistSalt: runtime.orgAllowlistSalt,
    auditOnly: runtime.config.mode === 'audit',
    enableStage3Redaction: runtime.config.enableStage3Redaction,
    strictSsn: runtime.config.strictSsn,
    hostVersion: runtime.hostVersion
  });

  const scrubbedEvent = shaped.modified && shaped.updatedToolOutput !== undefined
    ? { ...event, tool_response: shaped.updatedToolOutput, __airlockWrapped: true }
    : { ...event, __airlockWrapped: true };

  const innerRes = runInnerFn(scrubbedEvent, options);

  const ledger = openLedger(runtime, options);
  try {
    if (toolUseId) {
      ledger.completePostToolInFlight({ toolUseId });
    }
    if (options.sweepInFlight) {
      ledger.sweepExpiredInFlight(options.inflightMaxAgeMs || 15000);
    }

    const combinedMatches = [...(shaped.matches || []), ...(shaped.auditOnlyMatches || [])];
    const { categories } = collectSafeMatchMeta(combinedMatches);
    if (shaped.modified || shaped.auditOnlyMatches.length > 0 || shaped.schemaDriftDetected) {
      ledger.recordEvent({
        sessionId: runtime.sessionId,
        host: options.host || 'claude_code',
        hookPhase: 'PostToolUse',
        toolName,
        decision: shaped.modified ? 'scrubbed' : (shaped.auditOnlyMatches.length > 0 ? 'audit_only' : 'allow'),
        fmCode: shaped.schemaDriftDetected ? 'FM-SCHEMA-DRIFT' : '',
        categories,
        entityHmacs: shaped.uniqueEntityHmacs || [],
        matchCount: (shaped.matches || []).length,
        auditOnlyCount: (shaped.auditOnlyMatches || []).length,
        schemaDrift: Boolean(shaped.schemaDriftDetected),
        hostVersion: runtime.hostVersion,
        latencyMs: Date.now() - startedMs
      });
    }

    ledger.recordSessionHeartbeat({
      sessionId: runtime.sessionId,
      host: options.host || 'claude_code',
      hostVersion: runtime.hostVersion,
      mode: runtime.config.mode,
      policySigned: runtime.config.policySigned,
      policySignatureValid: runtime.config.policySignatureValid,
      schemaTested: !runtime.versionCheck.known || runtime.versionCheck.tested,
      schemaDrift: Boolean(shaped.schemaDriftDetected),
      watchdogMs: runtime.config.watchdogTimeoutMs
    });
  } finally {
    ledger.close();
  }

  let finalStdout = innerRes?.stdout || '';
  if (shaped.modified) {
    let outObj = {};
    if (finalStdout) {
      try {
        outObj = JSON.parse(finalStdout) || {};
      } catch {
        outObj = {};
      }
    }
    outObj.updatedToolOutput = shaped.updatedToolOutput;
    finalStdout = JSON.stringify(outObj);
  }

  let finalStderr = innerRes?.stderr || '';
  if (shaped.schemaDriftDetected) {
    const warn = `[Highbeam Airlock] Schema drift detected on '${toolName}' (host version '${runtime.hostVersion || 'unknown'}'); verify tested range.`;
    finalStderr = finalStderr ? `${finalStderr}\n${warn}` : warn;
  }

  return {
    ...innerRes,
    stdout: finalStdout,
    stderr: finalStderr,
    airlock: {
      active: true,
      modified: Boolean(shaped.modified),
      matchCount: (shaped.matches || []).length,
      auditOnlyCount: (shaped.auditOnlyMatches || []).length,
      schemaDriftDetected: Boolean(shaped.schemaDriftDetected),
      schemaTested: !runtime.versionCheck.known || runtime.versionCheck.tested,
      uniqueEntityHmacs: shaped.uniqueEntityHmacs || []
    }
  };
}

export function runAirlockPromptBridge(event = {}, cwdOptions = {}, options = {}) {
  const startedMs = Date.now();
  const runtime = resolveAirlockRuntime(event, cwdOptions, options);
  if (!runtime.active) return null;

  const guard = evaluateAirlockPromptGuard(event, {
    policy: runtime.policy,
    mode: runtime.config.mode,
    sessionKey: runtime.sessionKey,
    orgAuditSalt: runtime.orgAuditSalt,
    orgAllowlistSalt: runtime.orgAllowlistSalt
  });

  const combinedMatches = [...(guard.matches || []), ...(guard.auditOnlyMatches || [])];
  const { categories } = collectSafeMatchMeta(combinedMatches);
  const ledger = openLedger(runtime, options);
  try {
    if (guard.blocked || guard.auditOnlyMatches?.length > 0) {
      ledger.recordEvent({
        sessionId: runtime.sessionId,
        host: options.host || 'claude_code',
        hookPhase: 'UserPromptSubmit',
        toolName: 'Prompt',
        decision: guard.blocked ? 'deny' : 'audit_only',
        fmCode: guard.fmCode || '',
        categories,
        entityHmacs: guard.uniqueEntityHmacs || [],
        matchCount: (guard.matches || []).length,
        auditOnlyCount: (guard.auditOnlyMatches || []).length,
        hostVersion: runtime.hostVersion,
        latencyMs: Date.now() - startedMs
      });
    }
  } finally {
    ledger.close();
  }

  if (guard.blocked) {
    return {
      blocked: true,
      exitCode: 2,
      stdout: '',
      stderr: guard.reason,
      verdict: {
        triggered: true,
        decision: 'block',
        fmCode: guard.fmCode,
        reason: guard.reason
      },
      airlock: {
        active: true,
        blocked: true,
        fmCode: guard.fmCode,
        uniqueEntityHmacs: guard.uniqueEntityHmacs || []
      }
    };
  }

  return {
    blocked: false,
    airlock: {
      active: true,
      blocked: false,
      auditOnly: Boolean(guard.auditOnly),
      auditOnlyCount: (guard.auditOnlyMatches || []).length,
      uniqueEntityHmacs: guard.uniqueEntityHmacs || []
    }
  };
}

function readCandidateInstructionFiles(cwd = '') {
  if (!cwd) return [];
  const root = path.resolve(String(cwd));
  const relCandidates = [
    'CLAUDE.md',
    'AGENTS.md',
    '.cursorrules',
    '.windsurfrules',
    '.github/copilot-instructions.md',
    path.join('.claude', 'CLAUDE.md')
  ];
  const claudeCmdDir = path.join(root, '.claude', 'commands');
  if (fs.existsSync(claudeCmdDir)) {
    try {
      const entries = fs.readdirSync(claudeCmdDir).slice(0, 32);
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].endsWith('.md')) {
          relCandidates.push(path.join('.claude', 'commands', entries[i]));
        }
      }
    } catch {
      // ignore directory read errors
    }
  }

  const loaded = [];
  for (let i = 0; i < relCandidates.length; i++) {
    const abs = path.join(root, relCandidates[i]);
    try {
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      loaded.push({ path: relCandidates[i].replace(/\\/g, '/'), content: fs.readFileSync(abs, 'utf8') });
    } catch {
      // ignore unreadable instruction files
    }
  }
  return loaded;
}

export function runAirlockSessionStartBridge(cwd = '', event = {}, cwdOptions = {}, options = {}) {
  const startedMs = Date.now();
  const runtime = resolveAirlockRuntime({ ...event, cwd }, cwdOptions, options);
  if (!runtime.active) return null;

  const ledger = openLedger(runtime, options);
  try {
    const expiredLapses = ledger.sweepExpiredInFlight(options.inflightMaxAgeMs || 15000);
    const files = options.instructionFiles || readCandidateInstructionFiles(cwd || runtime.cwd);
    const instructionScan = scanInstructionFilesForSecrets(files, {
      policy: runtime.policy,
      sessionKey: runtime.sessionKey,
      orgAuditSalt: runtime.orgAuditSalt,
      orgAllowlistSalt: runtime.orgAllowlistSalt
    });

    const schemaTested = !runtime.versionCheck.known || runtime.versionCheck.tested;
    ledger.recordSessionHeartbeat({
      sessionId: runtime.sessionId,
      host: options.host || 'claude_code',
      hostVersion: runtime.hostVersion,
      mode: runtime.config.mode,
      policySigned: runtime.config.policySigned,
      policySignatureValid: runtime.config.policySignatureValid,
      schemaTested,
      schemaDrift: false,
      watchdogMs: runtime.config.watchdogTimeoutMs
    });

    ledger.recordEvent({
      sessionId: runtime.sessionId,
      host: options.host || 'claude_code',
      hookPhase: 'SessionStart',
      toolName: 'SessionStart',
      decision: instructionScan.findings.length > 0 ? 'audit_only' : 'allow',
      fmCode: runtime.loaded.tampered ? 'FM-POLICY-TAMPER' : '',
      categories: [...new Set(instructionScan.findings.map((f) => f.category))],
      entityHmacs: instructionScan.uniqueEntityHmacs || [],
      matchCount: instructionScan.findings.length,
      auditOnlyCount: instructionScan.auditOnlyFindings.length,
      hostVersion: runtime.hostVersion,
      latencyMs: Date.now() - startedMs
    });

    const extraBlocks = [];
    if (runtime.loaded.tampered) {
      extraBlocks.push(
        `[Highbeam Airlock POLICY WARNING]: Signed policy verification failed (${runtime.loaded.signatureReason}). Airlock failed closed to 'enforce' mode.`
      );
    }
    if (!schemaTested) {
      extraBlocks.push(
        `[Highbeam Airlock VERSION WARNING]: Claude Code '${runtime.hostVersion}' is outside tested range (${runtime.versionCheck.normalized ? 'check schema canary' : 'untested'}).`
      );
    }
    if (expiredLapses.length > 0) {
      extraBlocks.push(
        `[Highbeam Airlock COVERAGE WARNING]: Detected ${expiredLapses.length} incomplete prior PostToolUse call(s) recorded as coverage lapses.`
      );
    }
    if (instructionScan.findings.length > 0) {
      const sample = instructionScan.findings
        .slice(0, 5)
        .map((f) => `${f.path}:${f.line} [${f.category}]`)
        .join(', ');
      extraBlocks.push(
        `[Highbeam Airlock INSTRUCTION SCAN]: Detected ${instructionScan.findings.length} secret finding(s) in workspace instruction files: ${sample}. Rotate exposed credentials immediately.`
      );
    }

    return {
      active: true,
      extraBlocks,
      instructionScan,
      policyTampered: runtime.loaded.tampered,
      schemaTested,
      expiredLapsesCount: expiredLapses.length
    };
  } finally {
    ledger.close();
  }
}

export function recordAirlockWatchdogTimeout(hookPhase, event = {}, cwdOptions = {}, options = {}) {
  try {
    const runtime = resolveAirlockRuntime(event, cwdOptions, options);
    if (!runtime.active) return;
    const ledger = openLedger(runtime, options);
    try {
      ledger.recordEvent({
        sessionId: runtime.sessionId,
        host: options.host || 'claude_code',
        hookPhase,
        toolName: String(event?.tool_name || event?.toolName || hookPhase),
        decision: 'watchdog_timeout',
        fmCode: 'FM-8-WATCHDOG',
        coverageLapse: hookPhase === 'PostToolUse',
        hostVersion: runtime.hostVersion,
        latencyMs: runtime.config.watchdogTimeoutMs
      });
    } finally {
      ledger.close();
    }
  } catch {
    // Watchdog timeout logging must never mask exit(2)
  }
}
