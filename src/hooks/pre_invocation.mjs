import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSidecarSync, writeSidecarAtomicSync, getSidecarPath } from '../core/sidecar_store.mjs';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import { scorePromptSufficiency, toWorkspaceRelativePath } from '../core/prompt_rubric.mjs';
import { loadFlightcheckConfig } from '../core/config.mjs';
import { resolveModelCeiling } from '../core/constants.mjs';
import {
  classifyTaskComplexity,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
} from '../core/task_quota_router.mjs';

export {
  classifyTaskComplexity,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
};

async function readStdinSafe() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    }, 150);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

function formatScorecard(p1, p2, p3, p4) {
  const pad = (s, len = 74) => s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
  return [
    '╭─ Flight Check v3.1 ──────────────────────────────────────────────────────────╮',
    `│ 1. PROMPT : ${pad(p1, 62)} │`,
    `│ 2. HORIZON: ${pad(p2, 62)} │`,
    `│ 3. ACTION : ${pad(p3, 62)} │`,
    `│ 4. REWRITE: ${pad(p4, 62)} │`,
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    'Bypass once: prefix with `!`  •  Lock model/effort: include `!lock`'
  ].join('\n');
}

export async function handlePreInvocation(inputData = {}) {
  const config = inputData.configOverride || loadFlightcheckConfig();
  const rawPrompt = String(inputData.prompt || inputData.user_input || inputData.message || '').trim();
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';

  // 1. Control Flags Handling
  if (config.hook_level === 'off') {
    return {};
  }

  const sidecar = readSidecarSync(conversationId);
  const sessionMeta = sidecar.sessionMeta || {};
  const telemetry = sidecar.telemetry || {};
  const sensors = sidecar.sensors || {};
  const fileState = sidecar.fileState || {};

  if (rawPrompt.includes('!lock')) {
    sessionMeta.effortLocked = true;
    sidecar.sessionMeta = sessionMeta;
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch {}
    return {};
  }

  if (rawPrompt.startsWith('! ') || rawPrompt === '!' || rawPrompt.startsWith('!force')) {
    return {};
  }

  const hasCheckTag = /#check\b/i.test(rawPrompt);
  const turnCount = sessionMeta.turnCount || 0;
  const purity = telemetry.signalPurityPct ?? 100.0;
  const tokens = telemetry.totalInputTokens || 0;
  const activeEffort = inputData.effort || sessionMeta.activeEffort || 'high';
  const activeModel = inputData.modelName || sessionMeta.activeModel || (config.recommended_models?.fast || 'gemini-3.8-flash');
  const quotaFrac = telemetry.quota?.remaining_fraction ?? 1.0;
  const ceiling = resolveModelCeiling(activeModel, null, { config }) || 256000;
  const ceilingK = Math.round(ceiling / 1000);

  const hookLevel = config.hook_level || 'guard';
  const cooldownTurns = config.halt_cooldown_turns ?? 3;
  const lastHalts = { ...(sessionMeta.lastHalts || {}) };
  const isTelemetryReliable = telemetry.confidence !== 'LOW';

  function haltOrAdvise(stateKey, card, { exemptFromCooldown = false } = {}) {
    const lastFiredTurn = lastHalts[stateKey];
    const isWithinCooldown = typeof lastFiredTurn === 'number' && ((turnCount - lastFiredTurn) <= cooldownTurns);

    if (hookLevel === 'advisory' || (isWithinCooldown && !exemptFromCooldown)) {
      return { systemMessage: card };
    }

    lastHalts[stateKey] = turnCount;
    sessionMeta.lastHalts = lastHalts;
    sidecar.sessionMeta = sessionMeta;
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch {}
    return { terminationBehavior: 'terminate', userMessage: card };
  }

  // 2. ALLOW_PLAN_OR_SUBAGENT
  if (!hasCheckTag && (sessionMeta.inPlanMode || sessionMeta.lastTurnUsedSubagent)) {
    if (!telemetry.amputationRisk && !sensors.threeStrikeLoop) {
      return {};
    }
  }

  // 3. HALT_HYGIENE_OR_SAFETY
  const isHighOrMaxEffort = activeEffort === 'high' || activeEffort === 'max';
  if (telemetry.amputationRisk && isTelemetryReliable) {
    const handoff = sidecar.handoff || {};
    const handoffAction = handoff.result === 'NEEDS_FIXES'
      ? `Handoff NEEDS FIXES: ${(handoff.failingChecks || []).slice(0, 2).join('; ') || 'update task.md'}`
      : `/clear or /compact`;
    const rewriteCmd = handoff.result === 'NEEDS_FIXES'
      ? `"Update task.md checkpoint (/handoff), then type /compact or /clear"`
      : `"Save progress to task.md and start a clean session with /clear (or /compact)"`;

    const card = formatScorecard(
      `[Amputation Crisis] Tokens: ${Math.round(tokens / 1000)}k/${ceilingK}k`,
      `[Purity: ${purity}% | Amputation: Earliest cells at risk]`,
      handoffAction,
      rewriteCmd
    );
    return haltOrAdvise('AMPUTATION_CRISIS', card, { exemptFromCooldown: true });
  }

  if (sensors.threeStrikeLoop) {
    const loopInfo = sensors.loopFingerprint
      ? `Loop: ${sensors.loopFingerprint.slice(0, 48)}`
      : 'Consecutive command failures detected';
    const card = formatScorecard(
      `[3-Strike Error Loop] ${loopInfo}`,
      `[Purity: ${purity}% | Errors: 3 strikes]`,
      `Break loop: isolate with subagent or compact`,
      `"Diagnose previous errors using invoke_subagent or run /compact"`
    );
    return haltOrAdvise('THREE_STRIKE_LOOP', card);
  }

  if (fileState.foreignBleedKiIds && fileState.foreignBleedKiIds.length > 0 && sessionMeta.inPlanMode) {
    const card = formatScorecard(
      `[Foreign KI Bleed] Injected memory from other workspace`,
      `[Bleed IDs: ${fileState.foreignBleedKiIds.join(', ')}]`,
      `/context`,
      `"Eject foreign knowledge items in /context before planning"`
    );
    return haltOrAdvise('FOREIGN_BLEED', card);
  }

  if (isTelemetryReliable && purity < (config.compact_halt_purity_pct || 45.0) && isHighOrMaxEffort) {
    const card = formatScorecard(
      `[Low Signal Purity] ${purity}% pure on ${activeEffort} effort`,
      `[Sludge: +$${(telemetry.sludgeTaxUsdPerTurn || 0).toFixed(2)}/turn]`,
      `/compact`,
      `"Run /compact to compress stale reads before high-effort execution"`
    );
    return haltOrAdvise('LOW_PURITY', card);
  }

  if (sensors.uncheckpointedGitDrift) {
    const card = formatScorecard(
      `[Uncheckpointed Drift] ${sensors.dirtyGitFileCount || 4}+ dirty files untested`,
      `[Git Drift: >=3 turns without passing test]`,
      `git commit or run test`,
      `"Run unit tests and commit working changes before editing further"`
    );
    return haltOrAdvise('GIT_DRIFT', card);
  }

  // 4. HALT_EFFORT_OR_QUOTA
  const fastModel = config.recommended_models?.fast || 'gemini-3.8-flash';
  const deepModel = config.recommended_models?.deep || 'gemini-3.1-pro';

  if (isTelemetryReliable && sensors.quotaFloorBreached && (activeModel.includes('pro') || activeModel.includes('argon') || activeEffort === 'max')) {
    const card = formatScorecard(
      `[Quota Floor Breached] 5h Quota: ${Math.round(quotaFrac * 100)}% (<10%)`,
      `[Tokens: ${Math.round(tokens / 1000)}k | Risk: 0% lockout]`,
      `/model ${fastModel}  •  /effort low`,
      `"Switch to ${fastModel} on low effort to preserve remaining quota"`
    );
    return haltOrAdvise('QUOTA_FLOOR', card);
  }

  const promptTokenEst = Math.max(1, Math.ceil(rawPrompt.length / 4));
  const isColdCache = tokens < 10000;
  const isTrivial = promptTokenEst < 15;
  if (isTelemetryReliable && !sessionMeta.effortLocked && isTrivial && (sessionMeta.consecutiveTrivialOnMax >= 2 || (isColdCache && (activeModel.includes('pro') || activeModel.includes('argon')) && activeEffort === 'max'))) {
    const card = formatScorecard(
      `[Effort Overkill] Trivial edit (${promptTokenEst} tokens) on max effort`,
      `[Cold cache / trivial turn]`,
      `/model ${fastModel}  •  /effort low`,
      `"Run trivial single-file edit on ${fastModel} / low effort"`
    );
    return haltOrAdvise('EFFORT_OVERKILL', card);
  }

  // 5. INJECT_CONTEXT_GUARD
  const guards = [];
  if (!isTelemetryReliable) {
    guards.push('Telemetry confidence DEGRADED (parser schema drift detected) — running fail-open');
  }
  if (fileState.dirtySnapshotPaths && fileState.dirtySnapshotPaths.length > 0) {
    guards.push(`Dirty Snapshots modified externally: ${fileState.dirtySnapshotPaths.slice(0, 2).join(', ')} — re-read with view_file before editing`);
  }
  if (fileState.unseenCallers && fileState.unseenCallers.length > 0) {
    guards.push(`Unseen Callers importing target: ${fileState.unseenCallers.slice(0, 2).join(', ')} — verify signature compatibility`);
  }
  if (fileState.legacyPoisonPaths && fileState.legacyPoisonPaths.length > 0) {
    guards.push(`Legacy Poison paths in context: ${fileState.legacyPoisonPaths.slice(0, 2).join(', ')} — avoid copying deprecated patterns`);
  }
  if (fileState.streamCutoffRiskFiles && fileState.streamCutoffRiskFiles.length > 0) {
    guards.push(`Stream Cutoff Risk (>600 lines): ${fileState.streamCutoffRiskFiles.slice(0, 2).join(', ')} — use surgical edit chunks under 300 lines`);
  }

  if (guards.length > 0) {
    return {
      systemMessage: `[Flight Check Context Guard] Active hazards: ${guards.join('; ')}`
    };
  }

  // 6. STEER_SUBAGENT
  const isComplexTopic = /(concurrency|deadlock|race condition|architecture refactor|multi-module)/i.test(rawPrompt);
  if (tokens >= (config.subagent_min_cache_tokens || 25000) &&
      purity >= (config.subagent_min_purity_pct || 70.0) &&
      (activeEffort === 'low' || activeEffort === 'medium') &&
      isComplexTopic) {
    return {
      systemMessage: `[Flight Check KV-Cache Guard] Warm context detected (${Math.round(tokens / 1000)}k tokens, ${purity}% Purity). Do not switch session model (preserves warm KV cache). Delegate this analysis via invoke_subagent with pro/max depth.`
    };
  }

  // 7. ALLOW_ACTIVE_SET & Trust Decay
  const hasActiveSetMatch = (fileState.activeSetPaths || []).some(p => {
    const base = path.basename(p);
    return rawPrompt.includes(base) || rawPrompt.includes(p);
  });

  if (!hasCheckTag) {
    if (hasActiveSetMatch) return {};
    if (config.hook_level === 'guard' && turnCount > (config.trust_decay_turn_threshold || 10)) {
      return {};
    }
  }

  // 8. HALT_REWRITE_SCORECARD (Explicit #check or Cold Session Vague Multi-File Prompt)
  const isColdSession = turnCount <= (config.cold_session_max_turns || 3);
  const promptSufficiency = scorePromptSufficiency(rawPrompt, { activeSetPaths: fileState.activeSetPaths });
  const isVagueMultiFile = /(refactor everything|fix all|update the whole project|caching)/i.test(rawPrompt) && !rawPrompt.includes('@');

  // Ground rule: "Short prompts are not bad by default" - concise scoped instructions shouldn't trigger vague halt
  if (hasCheckTag || (isColdSession && isVagueMultiFile && !promptSufficiency.shortPrompt)) {
    const cleanedPrompt = rawPrompt.replace(/#check\b/gi, '').trim();
    const recommendedModel = tokens > 50000 ? deepModel : fastModel;
    const recommendedEffort = isComplexTopic ? 'high' : 'medium';
    const rawTargetHint = (fileState.activeSetPaths && fileState.activeSetPaths[0]) || '';
    const targetHint = (rawTargetHint ? toWorkspaceRelativePath(rawTargetHint, sidecar.workspacePath || process.cwd()) : '') || '<target-file>';
    const missingSnippet = promptSufficiency.missing.length > 0 ? ` | Missing: ${promptSufficiency.missing[0]}` : '';

    const rewriteSuggestion = promptSufficiency.missing.includes('testability & expected outcome')
      ? `"In @${targetHint}, ${cleanedPrompt || 'implement updates'} and run automated tests to verify"`
      : `"In @${targetHint}, ${cleanedPrompt || 'implement surgical updates with unit test'}"`;

    const card = formatScorecard(
      `[Sufficiency ${promptSufficiency.score}/12 ${promptSufficiency.band}]${missingSnippet}`,
      `[Purity: ${purity}% | Sludge: +$${(telemetry.sludgeTaxUsdPerTurn || 0).toFixed(2)}/t | Tokens: ${Math.round(tokens / 1000)}k]`,
      `/model ${recommendedModel}  •  /effort ${recommendedEffort}`,
      rewriteSuggestion
    );
    return haltOrAdvise('REWRITE_SCORECARD', card);
  }

  return {};
}

// Auto-run when executed directly by Antigravity Hook Harness
const isMain = process.argv[1] && (process.argv[1].endsWith('pre_invocation.mjs') || process.argv[1].endsWith('pre_invocation.js'));
if (isMain) {
  readStdinSafe().then(input => {
    return handlePreInvocation(input);
  }).then(output => {
    console.log(JSON.stringify(output || {}));
    process.exit(0);
  }).catch(() => {
    console.log(JSON.stringify({}));
    process.exit(0);
  });
}
