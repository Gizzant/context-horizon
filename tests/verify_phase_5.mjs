import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { writeSidecarAtomicSync, createDefaultSidecar } from '../src/core/sidecar_store.mjs';
import { parseRawJsonl } from '../src/core/parser.mjs';
import {
  classifyHorizon,
  CORTEX_STEP_TYPE_CHECKPOINT,
  MEMORY_MD_TRUNCATION_THRESHOLD_LINES,
  evaluateSmartFileReReads,
  wrapNoisyCommandWithDampener,
  registerCliDampeningHook,
  promoteRuleWithAttentionZone
} from '../src/core/classifier.mjs';
import { classifyHorizonWindow } from '../src/core/horizon_classifier.mjs';
import { auditMcpPrefixBloat, measureBaseline } from '../src/core/baseline.mjs';
import { startServer } from '../sidecars/horizon-daemon/server.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { JSDOM } = require('C:/Users/frank/AppData/Local/Temp/node_modules/jsdom');

console.log('=== Verifying Phase 5: Filtered Waste Classification, MCP Prefix Auditing & Lifecycle Hooks (Layer 5) ===\n');

// ---------------------------------------------------------------------------
// 1. Existing Lifecycle Hooks & 8-State Router Verification
// ---------------------------------------------------------------------------
console.log('[1/6] Verifying PreInvocation Lifecycle Hooks & 8-State Router (<15ms)...');
const testSessionId = 'test_pre_invoc_session';
const baseSidecar = createDefaultSidecar(testSessionId, 'c:/projects/ga-visualizer-v2');

const t0 = process.hrtime.bigint();
const res1 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: '! run arbitrary command without flightcheck'
});
const t1 = process.hrtime.bigint();
const duration1 = Number(t1 - t0) / 1_000_000;
assert.deepEqual(res1, {}, 'ALLOW_SILENT must return empty object {}');

const warmSidecar = {
  ...baseSidecar,
  telemetry: {
    ...baseSidecar.telemetry,
    totalInputTokens: 35000,
    signalPurityPct: 85.0
  },
  sessionMeta: {
    ...baseSidecar.sessionMeta,
    activeEffort: 'low',
    turnCount: 5
  }
};
writeSidecarAtomicSync(testSessionId, warmSidecar);

const t2 = process.hrtime.bigint();
const res2 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: 'Diagnose the concurrency deadlock in the worker queue',
  effort: 'low'
});
const t3 = process.hrtime.bigint();
const duration2 = Number(t3 - t2) / 1_000_000;
assert.ok(res2.systemMessage, 'STEER_SUBAGENT must inject systemMessage');
assert.ok(res2.systemMessage.includes('invoke_subagent'), 'Must advise using invoke_subagent');

const amputateSidecar = {
  ...baseSidecar,
  telemetry: {
    ...baseSidecar.telemetry,
    totalInputTokens: 160000,
    amputationRisk: true,
    signalPurityPct: 35.0
  }
};
writeSidecarAtomicSync(testSessionId, amputateSidecar);

const t4 = process.hrtime.bigint();
const res3 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: 'Add new payment gateway endpoint',
  effort: 'high'
});
const t5 = process.hrtime.bigint();
const duration3 = Number(t5 - t4) / 1_000_000;
assert.equal(res3.terminationBehavior, 'terminate', 'Must terminate execution');
assert.ok(res3.userMessage.includes('Flight Check'), 'Must output Scorecard');

const normalSidecar = {
  ...baseSidecar,
  telemetry: {
    ...baseSidecar.telemetry,
    totalInputTokens: 20000,
    signalPurityPct: 80.0
  },
  fileState: {
    ...baseSidecar.fileState,
    activeSetPaths: ['src/core/router.mjs']
  }
};
writeSidecarAtomicSync(testSessionId, normalSidecar);

const t6 = process.hrtime.bigint();
const res4 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: '#check Refactor everything across database and auth modules'
});
const t7 = process.hrtime.bigint();
const duration4 = Number(t7 - t6) / 1_000_000;
assert.equal(res4.terminationBehavior, 'terminate');
assert.ok(res4.userMessage.includes('Flight Check v3.1'));

const maxDuration = Math.max(duration1, duration2, duration3, duration4);
assert.ok(maxDuration < 15.0, `Hook latency ${maxDuration}ms exceeded 15ms threshold`);
console.log(`  ✓ PreInvocation Router verified (max latency ${maxDuration.toFixed(2)}ms < 15ms).\n`);

// ---------------------------------------------------------------------------
// 2. Smart File Re-Read Classifier (`evaluateSmartFileReReads` & `classifyHorizon`)
// ---------------------------------------------------------------------------
console.log('[2/6] Verifying Smart File Re-Read Classifier (Checkpoint, Edit & Command Exemptions)...');
assert.equal(CORTEX_STEP_TYPE_CHECKPOINT, 23);

// 2a. Compaction step (step_type == 23) between consecutive view_file calls -> NOT waste
const checkpointJsonl = [
  JSON.stringify({ step_index: 0, type: 'SYSTEM_PROMPT', content: 'Anchors', input_tokens: 4000 }),
  JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: { Path: 'src/auth.ts' } }], content: 'export function login() {}', output_tokens: 1500 }),
  JSON.stringify({ step_index: 2, step_type: 23, content: '<CONTEXT_SUMMARY>Compacted epoch</CONTEXT_SUMMARY>', output_tokens: 800 }),
  JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: { Path: 'src/auth.ts' } }], content: 'export function login() {}', output_tokens: 1500 })
].join('\n');
const cpSteps = parseRawJsonl(checkpointJsonl);
assert.equal(cpSteps[2].type, 'CHECKPOINT', 'step_type=23 must normalize to CHECKPOINT');
const cpEval = evaluateSmartFileReReads(cpSteps);
assert.equal(cpEval.wasteTargetByStep.size, 0, 'Re-read separated by step_type=23 checkpoint must NOT be classified as waste');
assert.equal(cpEval.exemptedReReads.length, 1);
assert.equal(cpEval.exemptedReReads[0].reason, 'CHECKPOINT');
const cpState = classifyHorizon(cpSteps, { useNativeCeiling: true });
assert.equal(cpState.brainSignals.duplicateReads.fileCount, 0, 'classifyHorizon must report 0 duplicate read offenders across checkpoint');

// 2b. Edit tool (`replace_file_content` / `write_to_file`) between consecutive view_file calls -> NOT waste
const editSteps = [
  { stepIndex: 0, type: 'SYSTEM_PROMPT', content: 'Anchors', inputTokens: 4000 },
  { stepIndex: 1, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'view_file', args: { Path: 'src/service.ts' } }], content: 'v1', outputTokens: 2000 },
  { stepIndex: 2, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'replace_file_content', args: { Path: 'src/service.ts' } }], content: 'edited', outputTokens: 500 },
  { stepIndex: 3, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'view_file', args: { Path: 'src/service.ts' } }], content: 'v2', outputTokens: 2000 }
];
const editEval = evaluateSmartFileReReads(editSteps);
assert.equal(editEval.wasteTargetByStep.size, 0, 'Re-read after replace_file_content on same file must NOT be classified as waste');
assert.equal(editEval.exemptedReReads[0].reason, 'FILE_EDIT');
const editState = classifyHorizon(editSteps, { useNativeCeiling: true });
assert.equal(editState.brainSignals.duplicateReads.fileCount, 0, 'classifyHorizon must NOT flag read-edit-read as duplicate read waste');

// 2c. Build/test command (`run_command`) between consecutive view_file calls -> NOT waste
const cmdSteps = [
  { stepIndex: 0, type: 'SYSTEM_PROMPT', content: 'Anchors', inputTokens: 4000 },
  { stepIndex: 1, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'view_file', args: { Path: 'src/worker.ts' } }], content: 'code', outputTokens: 2000 },
  { stepIndex: 2, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }], content: 'PASS', outputTokens: 600 },
  { stepIndex: 3, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'view_file', args: { Path: 'src/worker.ts' } }], content: 'code', outputTokens: 2000 }
];
const cmdEval = evaluateSmartFileReReads(cmdSteps);
assert.equal(cmdEval.wasteTargetByStep.size, 0, 'Re-read after run_command must NOT be classified as waste');
assert.equal(cmdEval.exemptedReReads[0].reason, 'RUN_COMMAND');
const cmdState = classifyHorizon(cmdSteps, { useNativeCeiling: true });
assert.equal(cmdState.brainSignals.duplicateReads.fileCount, 0, 'classifyHorizon must NOT flag read-command-read as duplicate read waste');

// 2d. True unmodified re-read in the same continuous context epoch -> IS classified as waste
const wasteSteps = [
  { stepIndex: 0, type: 'SYSTEM_PROMPT', content: 'Anchors', inputTokens: 4000 },
  { stepIndex: 1, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'view_file', args: { Path: 'src/unmodified.ts' } }], content: 'same content', outputTokens: 3500 },
  { stepIndex: 2, type: 'USER_INPUT', toolCalls: [], content: 'What does this function do?', outputTokens: 100 },
  { stepIndex: 3, type: 'PLANNER_RESPONSE', toolCalls: [{ name: 'view_file', args: { Path: 'src/unmodified.ts' } }], content: 'same content', outputTokens: 3500 }
];
const wasteEval = evaluateSmartFileReReads(wasteSteps);
assert.equal(wasteEval.wasteTargetByStep.has(1), true, 'Unmodified repeat read in same epoch MUST flag earlier read as waste');
const wasteState = classifyHorizon(wasteSteps, { useNativeCeiling: true });
assert.equal(wasteState.brainSignals.duplicateReads.fileCount, 1, 'classifyHorizon must flag unmodified repeat read');
assert.equal(wasteState.brainSignals.duplicateReads.topFiles[0].path, 'src/unmodified.ts');

// Also check classifyHorizonWindow (`horizon_classifier.mjs`) parity
const hwEditRes = classifyHorizonWindow([
  { stepIndex: 0, role: 'system', type: 'SCHEMA', tokenEstimate: 5000 },
  { stepIndex: 1, role: 'tool', toolName: 'view_file', targetPath: 'c:/app/index.js', exitCode: 0, tokenEstimate: 5000 },
  { stepIndex: 2, role: 'tool', toolName: 'write_to_file', targetPath: 'c:/app/index.js', exitCode: 0, tokenEstimate: 1000 },
  { stepIndex: 3, role: 'tool', toolName: 'view_file', targetPath: 'c:/app/index.js', exitCode: 0, tokenEstimate: 5000 }
], { total_input_tokens: 20000, modelName: 'gemini-3.8-flash' }, 'c:/app');
assert.equal(hwEditRes.fileState.staleDupPaths.includes('c:/app/index.js'), false, 'horizon_classifier must exempt read-write-read');
console.log('  ✓ Smart File Re-Read Classifier verified across checkpoint, edit, command, and unmodified re-reads.\n');

// ---------------------------------------------------------------------------
// 3. MCP Prefix Bloat & Schema Audit (`mcp_config.json`)
// ---------------------------------------------------------------------------
console.log('[3/6] Verifying MCP Prefix Bloat & Schema Audit (~/.gemini/config/mcp_config.json & .agents/mcp_config.json)...');
const tmpMcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase5-mcp-'));
const tmpHome = path.join(tmpMcpRoot, 'home');
const tmpWs = path.join(tmpMcpRoot, 'workspace');
fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
fs.mkdirSync(path.join(tmpWs, '.agents'), { recursive: true });

// Global ~/.gemini/config/mcp_config.json with an eager unused server & an eager used server
fs.writeFileSync(path.join(tmpHome, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
  mcpServers: {
    'heavy-unused-mcp': {
      command: 'npx',
      args: ['-y', 'heavy-unused-mcp'],
      loading: 'eager',
      schemaTokens: 14200
    },
    'active-used-mcp': {
      command: 'npx',
      args: ['-y', 'active-used-mcp'],
      loading: 'eager',
      schemaTokens: 6400
    }
  }
}, null, 2), 'utf8');

// Workspace .agents/mcp_config.json with a lazy server and another eager unused server
fs.writeFileSync(path.join(tmpWs, '.agents', 'mcp_config.json'), JSON.stringify({
  mcpServers: {
    'workspace-eager-unused': {
      command: 'node',
      args: ['server.js'],
      eager: true,
      tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(200) }))
    },
    'workspace-lazy-server': {
      command: 'node',
      args: ['lazy.js'],
      loading: 'lazy',
      schemaTokens: 9000
    }
  }
}, null, 2), 'utf8');

const sessionStepsWithOneMcpCall = [
  {
    stepIndex: 1,
    type: 'PLANNER_RESPONSE',
    toolCalls: [{ name: 'call_mcp_tool', args: { ServerName: 'active-used-mcp', ToolName: 'query' } }],
    content: 'Called active-used-mcp'
  }
];

const mcpAudit = auditMcpPrefixBloat({
  workspaceDir: tmpWs,
  homeDir: tmpHome,
  steps: sessionStepsWithOneMcpCall
});
assert.equal(mcpAudit.configPaths.length, 2, 'Must parse both ~/.gemini/config/mcp_config.json and .agents/mcp_config.json');
const unusedNames = mcpAudit.unusedEagerServers.map(s => s.name);
assert.ok(unusedNames.includes('heavy-unused-mcp'), 'Must flag eager server with 0 calls in ~/.gemini/config/mcp_config.json');
assert.ok(unusedNames.includes('workspace-eager-unused'), 'Must flag eager server with 0 calls in .agents/mcp_config.json');
assert.ok(!unusedNames.includes('active-used-mcp'), 'Must NOT flag eager server that had tool calls in active session');
assert.ok(!unusedNames.includes('workspace-lazy-server'), 'Must NOT flag lazy-loaded server');
assert.ok(mcpAudit.recommendations.some(r => r.includes('heavy-unused-mcp') && r.includes('lazy')), 'Must recommend switching unused eager server to lazy');

const baseWithMcp = measureBaseline(tmpWs, tmpHome, { steps: sessionStepsWithOneMcpCall, force: true });
assert.ok(baseWithMcp.mcpAudit.unusedEagerServers.length === 2, 'measureBaseline must attach mcpAudit');
console.log('  ✓ MCP Prefix Bloat & Schema Audit verified.\n');

// ---------------------------------------------------------------------------
// 4. Fail-Open CLI Command Dampening Hook (`.agents/hooks.json` under `PreToolUse`)
// ---------------------------------------------------------------------------
console.log('[4/6] Verifying Fail-Open CLI Command Dampening Hook (.agents/hooks.json PreToolUse)...');
const wrappedCmd = wrapNoisyCommandWithDampener('git log -p -n 50', { maxLines: 100 });
assert.ok(wrappedCmd.includes('head -n 100'), 'Wrapped command must include head -n 100');
assert.ok(wrappedCmd.includes('tee .agents/tmp/cli_stdout.log'), 'Wrapped command must pipe to temporary log file');
assert.ok(wrappedCmd.endsWith('|| true'), 'Wrapped command must be fail-open (|| true)');

const hookReg = registerCliDampeningHook(tmpWs, {
  command: 'pytest -vv',
  maxLines: 100,
  writeToDisk: true
});
assert.equal(hookReg.success, true);
assert.ok(fs.existsSync(hookReg.hooksPath), '.agents/hooks.json must be written to disk');
const parsedHooks = JSON.parse(fs.readFileSync(hookReg.hooksPath, 'utf8'));
assert.ok(Array.isArray(parsedHooks.PreToolUse) && parsedHooks.PreToolUse.length === 1, 'Must register under PreToolUse');
assert.equal(parsedHooks.PreToolUse[0].matcher, 'run_command');
assert.equal(parsedHooks.PreToolUse[0].failOpen, true);
assert.equal(parsedHooks.PreToolUse[0].maxLines, 100);
console.log('  ✓ Fail-Open CLI Command Dampening Hook verified.\n');

// ---------------------------------------------------------------------------
// 5. Attention-Aware Rule Promotion (Primacy Top 30% / Recency Bottom 30% & 200-Line Check)
// ---------------------------------------------------------------------------
console.log('[5/6] Verifying Attention-Aware Rule Promotion (Primacy/Recency Zones & 200-Line Threshold)...');
assert.equal(MEMORY_MD_TRUNCATION_THRESHOLD_LINES, 200);

const sampleAgentsMd = path.join(tmpWs, 'AGENTS.md');
const initial40Lines = [
  '# Workspace Rules',
  ...Array.from({ length: 39 }, (_, i) => `- Existing rule line ${i + 2}`)
].join('\n');
fs.writeFileSync(sampleAgentsMd, initial40Lines, 'utf8');

// 5a. Primacy zone insertion (strictly within top 30%)
const primacyRes = promoteRuleWithAttentionZone(sampleAgentsMd, 'Never use synchronous network calls in UI thread.', {
  zone: 'primacy',
  writeToDisk: true
});
assert.equal(primacyRes.success, true);
assert.equal(primacyRes.inPrimacyZone, true, `Expected Primacy insertion <= 0.30, got ${primacyRes.normalizedPosition}`);
assert.ok(primacyRes.normalizedPosition <= 0.30, 'Primacy directive must be strictly within top 30%');
assert.equal(primacyRes.exceeds200LineThreshold, false);

// 5b. Recency zone insertion (strictly within bottom 30%)
const recencyRes = promoteRuleWithAttentionZone(sampleAgentsMd, 'Always run sync_mirrors.mjs after editing horizon_panel.html.', {
  zone: 'recency',
  writeToDisk: true
});
assert.equal(recencyRes.success, true);
assert.equal(recencyRes.inRecencyZone, true, `Expected Recency insertion >= 0.70, got ${recencyRes.normalizedPosition}`);
assert.ok(recencyRes.normalizedPosition >= 0.70, 'Recency directive must be strictly within bottom 30%');

// 5c. 200-Line MEMORY.md truncation threshold warning
const oversizedContextMd = path.join(tmpWs, '.agents', 'CONTEXT.md');
const lines205 = [
  '# Context Rules',
  ...Array.from({ length: 204 }, (_, i) => `- Rule item ${i + 1}`)
].join('\n');
fs.writeFileSync(oversizedContextMd, lines205, 'utf8');
const truncRes = promoteRuleWithAttentionZone(oversizedContextMd, 'Keep critical invariants in Primacy zone.', {
  zone: 'primacy',
  writeToDisk: true
});
assert.equal(truncRes.exceeds200LineThreshold, true, 'Must flag file exceeding 200-line MEMORY.md truncation threshold');
assert.ok(truncRes.truncationWarning.includes('200-line MEMORY.md truncation threshold'), 'Must include 200-line truncation warning message');
console.log('  ✓ Attention-Aware Rule Promotion & 200-line MEMORY.md threshold check verified.\n');

// ---------------------------------------------------------------------------
// 6. JSDOM & Live Daemon Endpoint Verification + 3-Way Mirror Parity
// ---------------------------------------------------------------------------
console.log('[6/6] Verifying JSDOM Layer 5 Cards, Daemon Endpoints & 3-Way Mirror Parity...');
const syncRes = syncAndVerifyMirrors();
assert.equal(syncRes.parityOk, true, '3-Way WebView Mirror SHA-256 parity must hold');

const html = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
const apiCalls = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1/',
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      apiCalls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (String(url).includes('/api/hooks/dampen')) {
        return { ok: true, status: 200, json: async () => ({ success: true, hooksPath: '.agents/hooks.json' }) };
      }
      if (String(url).includes('/api/rules/promote')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            zoneUsed: 'primacy',
            insertedAtLine: 2,
            totalLinesAfter: 45,
            targetPath: 'c:/projects/ga-visualizer-v2/AGENTS.md',
            truncationWarning: ''
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    w.EventSource = class { addEventListener() {} close() {} };
    w.navigator.clipboard = { writeText: async () => {} };
  }
});

const w = dom.window;
const d = w.document;

w.renderState({
  sessionId: 'phase5-ui-session',
  sessionTitle: 'Phase 5 Layer 5 Test',
  window: {
    maxTokens: 256000,
    totalActiveTokens: 84000,
    safeLimit: 179000,
    turnCount: 14
  },
  breakdown: {
    ANCHOR: 14000,
    ACTIVE_WORKING_SET: 50000,
    STALE_DUPLICATE: 20000,
    DEAD_ERROR: 0
  },
  metrics: {
    signalPurityPct: 76,
    sludgeTokens: 20000
  },
  brainSignals: {
    activeSignal: { liveSessionTokens: 50000, taskMdSaved: true, taskMdTurnsBehind: 0 },
    duplicateReads: { fileCount: 0, reclaimableTokens: 0, topFiles: [] },
    oldHistory: { turnCount: 8, reclaimableTokens: 20000 },
    deadErrors: { errorCount: 0, reclaimableTokens: 0, isErrorLoop: false },
    blowupSteps: [{
      stepIndex: 9,
      tokens: 24000,
      category: 'ACTIVE_WORKING_SET',
      target: 'Command: pytest -vv',
      payload: { kind: 'command', tool: 'run_command', detail: 'pytest -vv' }
    }],
    userCorrections: 2,
    userCorrectionTexts: ['Always use readOnly: true on SQLite connections'],
    rulePromotion: {
      exceeds200LineThreshold: true,
      truncationWarning: "Rule file (212 lines) exceeds Antigravity's 200-line MEMORY.md truncation threshold."
    },
    mcpAudit
  },
  cells: Array.from({ length: 40 }, (_, i) => ({
    index: i,
    dominantCategory: i < 13 ? 'ACTIVE_WORKING_SET' : 'FREE_HEADROOM'
  }))
});
await new Promise(r => setTimeout(r, 30));

// Verify Dampening Hook button in Biggest Single Turn
const dampenBtn = d.getElementById('btnRegisterDampeningHook');
assert.ok(dampenBtn, '#btnRegisterDampeningHook must be rendered for CLI command blowup step');
dampenBtn.click();
await new Promise(r => setTimeout(r, 30));
assert.ok(apiCalls.some(c => c.url === '/api/hooks/dampen' && c.method === 'POST'), 'Clicking #btnRegisterDampeningHook must POST to /api/hooks/dampen');
assert.ok(d.getElementById('feedbackToast').textContent.includes('.agents/hooks.json'), 'Toast must confirm .agents/hooks.json registration');

// Verify Attention-Aware Rule Promotion button & 200-line warning
const promoteBtn = d.getElementById('btnPromoteRulePrimacy');
assert.ok(promoteBtn, '#btnPromoteRulePrimacy must be rendered in Unlogged User Corrections card');
assert.ok(d.getElementById('playbookList').textContent.includes('200-line MEMORY.md truncation threshold'), 'Must display 200-line MEMORY.md truncation warning');
promoteBtn.click();
await new Promise(r => setTimeout(r, 30));
assert.ok(apiCalls.some(c => c.url === '/api/rules/promote' && c.method === 'POST'), 'Clicking #btnPromoteRulePrimacy must POST to /api/rules/promote');

// Verify Unused Eager MCP Schemas card
const mcpCard = d.getElementById('mcpAuditCard');
assert.ok(mcpCard, '#mcpAuditCard must be rendered when unusedEagerServers > 0');
assert.ok(mcpCard.textContent.includes('heavy-unused-mcp'), 'Must list unused eager MCP server');

dom.window.close();

// Live HTTP server check for POST /api/hooks/dampen and POST /api/rules/promote
const { server, port } = await startServer(0);
try {
  const resDampen = await fetch(`http://127.0.0.1:${port}/api/hooks/dampen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: tmpWs, command: 'git log', maxLines: 100 })
  });
  assert.equal(resDampen.status, 200);
  const jsonDampen = await resDampen.json();
  assert.equal(jsonDampen.success, true);

  const resPromote = await fetch(`http://127.0.0.1:${port}/api/rules/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetPath: sampleAgentsMd, ruleText: 'Enforce strict read-only SQLite access.', zone: 'primacy' })
  });
  assert.equal(resPromote.status, 200);
  const jsonPromote = await resPromote.json();
  assert.equal(jsonPromote.success, true);
  assert.equal(jsonPromote.inPrimacyZone, true);
} finally {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  try { fs.rmSync(tmpMcpRoot, { recursive: true, force: true }); } catch {}
}

console.log('  ✓ JSDOM Layer 5 controls, live HTTP endpoints, and 3-Way Mirror Parity verified.\n');
console.log('✓ Phase 5 verification PASSED with 0 errors.');
