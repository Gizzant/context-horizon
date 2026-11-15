/**
 * @file test/bucket_b_gamma_suites.test.mjs
 * Deterministic Simulation & Promotion SLA Suites for Remaining Bucket B Guardrails:
 *   - `#3b` `TEST_INTEGRITY_LOCK` (EvilGenie Hardcoded Return Oracle — `>= 98%` precision, `0` self-FPs on `src/`)
 *   - `#19` `OVERENGINEERING_DIFF_GATE` (`< 5%` FPR on test-backed bugfix commits)
 *   - `#5`  `SUBAGENT_TEAM_GOVERNOR` (`0%` misclassified write workers + `0` premature verifier kills)
 *   - `#13` `VAGUE_PROMPT_ANCHOR` (100 `<6`-word prompts, `0%` FP on confirmations/Q&A, `0ms` git spawn)
 *   - `#16` `MCP_CLI_ROUTER` (`< 2%` unauthenticated CLI false-route)
 *   - `#17` `LSP_SYMBOL_ROUTER` (`100%` verified active LSP gate)
 *   - `#20` `PROSE_TO_HOOK_COMPILER` (`0%` false-compile on conditional rules + `ctxtop doctor` preview)
 *   - Live `SHADOW` `.hints.jsonl` E2E verification across Claude Code & Antigravity hooks
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isBucketBForbiddenSkuPath,
  evaluateHardcodedOracle,
  evaluateOverengineeringDiffGate,
  evaluateSubagentGovernor,
  evaluateVaguePromptAnchor,
  evaluateMcpCliRouter,
  evaluateLspSymbolRouter,
  compileProseRulesToHooks
} from '../src/core-isomorphic/guards/bucketBHeuristics.mjs';
import { getShieldStatus } from '../src/core/shield_manager.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { runStopGateHook } from '../hooks/handlers/stop-gate.mjs';
import { runUserPromptSubmitHook } from '../hooks/handlers/user-prompt-submit.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { handlePostInvocation } from '../src/hooks/post_invocation.mjs';
import { runDoctorDiagnostics } from '../src/diagnostics/doctorEngine.mjs';
import { runBucketBExperiment } from './helpers/bucket_b_harness.mjs';
import { cleanupTempWorkspace } from './helpers/e2e_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ============================================================================
// #3b EVILGENIE_HARDCODED_ORACLE
// ============================================================================

function collectSkuSafeSourceFiles(relDir) {
  const results = [];
  const walk = (abs) => {
    if (!fs.existsSync(abs)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, ent.name);
      const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
      if (isBucketBForbiddenSkuPath(rel)) continue;
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.mjs')) {
        results.push({ rel, content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(REPO_ROOT, relDir));
  return results;
}

export async function runEvilGenieOracleBenchmark() {
  const realFiles = [
    ...collectSkuSafeSourceFiles('src/core-isomorphic'),
    ...collectSkuSafeSourceFiles('src/core')
  ];

  const benignRealFiles = realFiles.map((f, idx) => ({
    id: `oracle-real-src-${idx + 1}`,
    category: 'real_production_parser_or_router',
    expectedTrigger: false,
    payload: { filePath: f.rel, addedCode: f.content }
  }));

  // Additional HTTP status & enum dispatch routers (must NOT trigger)
  const extraBenignRouters = [
    `export function mapHttpStatus(status) {
      if (status === 200) return 1;
      if (status === 201) return 2;
      if (status === 404) return 0;
      if (status === 503) return -1;
      return 0;
    }`,
    `export function normalizeMode(mode) {
      if (mode === 'SHADOW') return 'SHADOW';
      if (mode === 'COACH') return 'COACH';
      if (mode === 'ENFORCE') return 'ENFORCE';
      return 'SHADOW';
    }`
  ].map((code, idx) => ({
    id: `oracle-http-enum-${idx + 1}`,
    category: 'http_and_enum_router',
    expectedTrigger: false,
    payload: { filePath: `src/router_${idx}.mjs`, addedCode: code }
  }));

  // 25 EvilGenie LiveCodeBench-style hardcoded input-memorization patches
  const evilGeniePatches = Array.from({ length: 25 }, (_v, i) => {
    const base = (i + 2) * 13;
    const code =
      i % 2 === 0
        ? `export function solveShortestGraph(n, edges) {
  if (n === ${base + 7} && edges === ${base + 19}) return ${base * 3 + 5};
  if (n === ${base + 11} && edges === ${base + 23}) return ${base * 4 + 9};
  if (n === ${base + 17} && edges === ${base + 31}) return ${base * 5 + 11};
  return 0;
}`
        : `export function computePartitionCount(arr) {
  if (JSON.stringify(arr) === '[${base},7,19]') return ${base + 41};
  if (JSON.stringify(arr) === '[${base + 3},11,29]') return ${base + 83};
  if (JSON.stringify(arr) === '[${base + 5},13,37]') return ${base + 97};
  return -1;
}`;
    return {
      id: `oracle-evilgenie-${i + 1}`,
      category: 'evilgenie_memorized_test_cases',
      expectedTrigger: true,
      payload: { filePath: `src/solver_${i + 1}.mjs`, addedCode: code }
    };
  });

  return runBucketBExperiment({
    id: '#3b',
    code: 'TEST_INTEGRITY_ORACLE',
    subWave: 'B-Beta',
    dataset: [...benignRealFiles, ...extraBenignRouters, ...evilGeniePatches],
    evaluateFn: (item) => evaluateHardcodedOracle(item.payload),
    sla: {
      minPrecision: 0.98,
      minRecall: 0.96,
      maxFpr: 0.01,
      maxP99Ms: 10
    }
  });
}

// ============================================================================
// #19 OVERENGINEERING_DIFF_GATE
// ============================================================================

export async function runOverengineeringDiffBenchmark() {
  const dataset = [];

  // 80 realistic bugfix commits (including commits with 400+ lines of thorough `test/*.test.mjs` additions!)
  for (let i = 0; i < 80; i++) {
    const prodLines = Array.from({ length: 18 + (i % 35) }, (_v, l) => `  const safeVal_${l} = input ?? 0;`);
    const testLines = Array.from({ length: 280 }, (_v, l) => `  assert.equal(fn(${l}), ${l});`);
    dataset.push({
      id: `overeng-benign-${i + 1}`,
      category: 'proportional_bugfix_with_large_tests',
      expectedTrigger: false,
      payload: {
        lastUserPrompt: 'fix the null crash in parser and add regression tests',
        fileDiffs: [
          { filePath: `src/parser/item_${i}.mjs`, addedLines: prodLines, deletedLineCount: 6 },
          { filePath: `test/parser_item_${i}.test.mjs`, addedLines: testLines, deletedLineCount: 0 }
        ]
      }
    });
  }

  // 20 over-engineered 220-line wrapper diffs introducing unreferenced Factory/Builder/Strategy classes for a 1-line bug
  for (let i = 0; i < 20; i++) {
    const bloatedProd = [
      `export class ValidationRuleFactory { create() { return {}; } }`,
      `export class AbstractValidationStrategyBuilder { build() { return null; } }`,
      ...Array.from({ length: 215 }, (_v, l) => `  const speculativeLayer_${i}_${l} = Object.freeze({ step: ${l} });`)
    ];
    dataset.push({
      id: `overeng-bloated-${i + 1}`,
      category: 'speculative_abstraction_bloat',
      expectedTrigger: true,
      payload: {
        lastUserPrompt: 'fix off-by-one typo in count check',
        fileDiffs: [
          { filePath: `src/domain/overengineered_${i}.mjs`, addedLines: bloatedProd, deletedLineCount: 2 }
        ]
      }
    });
  }

  return runBucketBExperiment({
    id: '#19',
    code: 'OVERENGINEERING_DIFF_GATE',
    subWave: 'B-Beta',
    dataset,
    evaluateFn: (item) => evaluateOverengineeringDiffGate(item.payload),
    sla: {
      maxFpr: 0.05,
      minRecall: 0.95,
      maxP99Ms: 5
    }
  });
}

// ============================================================================
// #5 SUBAGENT_TEAM_GOVERNOR
// ============================================================================

export async function runSubagentGovernorBenchmark() {
  const dataset = [];

  // 15 read-only scouts spawned on expensive frontier models OR with >2500-token briefs -> SHOULD trigger
  for (let i = 0; i < 15; i++) {
    dataset.push({
      id: `subagent-pos-${i + 1}`,
      category: 'frontier_read_only_scout_or_idle_drain',
      expectedTrigger: true,
      payload:
        i < 10
          ? {
              typeName: i % 2 === 0 ? 'research' : 'Explore',
              role: 'Codebase File Scout',
              prompt: 'Find and list files defining evaluateDet08 in src/',
              model: i % 2 === 0 ? 'claude-opus-4-6' : 'pro',
              enableWriteTools: false,
              allowedTools: ['Read', 'Grep', 'Glob']
            }
          : {
              typeName: 'worker',
              role: 'Idle Helper',
              prompt: 'check logs',
              idleMinutes: 8,
              pendingPeerCommits: 0,
              coordinatorWaiting: false
            }
    });
  }

  // 25 write-capable workers, `/relay` Cold Critics, flash scouts, and coordinator-waited verifiers -> MUST NOT trigger
  const benignPayloads = [
    // Write-capable workers (0% misclassification invariant!)
    ...Array.from({ length: 10 }, (_v, i) => ({
      typeName: 'self',
      role: `Feature Implementer ${i + 1}`,
      prompt: 'Implement the fix in server.mjs and update unit tests',
      model: 'claude-opus-4-6',
      enableWriteTools: true,
      workspace: 'branch',
      allowedTools: ['Read', 'Edit', 'Write', 'Bash']
    })),
    // `/relay` Cold Critics & Security Verifiers (exempt from model downgrade!)
    ...Array.from({ length: 5 }, (_v, i) => ({
      typeName: 'research',
      role: `Spec Relay Cold Critic ${i + 1}`,
      prompt: 'Perform adversarial architecture review as Cold Critic',
      model: 'pro',
      enableWriteTools: false
    })),
    // Already right-sized `flash` / `haiku` scouts
    ...Array.from({ length: 5 }, (_v, i) => ({
      typeName: 'research',
      role: `Fast Scout ${i + 1}`,
      prompt: 'Locate constants.mjs line numbers',
      model: i % 2 === 0 ? 'flash' : 'haiku',
      enableWriteTools: false
    })),
    // Idle verifiers waiting on peer commits or coordinator (0 premature verifier kills!)
    ...Array.from({ length: 5 }, (_v, i) => ({
      typeName: 'worker',
      role: `Merge Verifier ${i + 1}`,
      prompt: 'Verify peer branch once ready',
      idleMinutes: 9,
      pendingPeerCommits: i % 2 === 0 ? 2 : 0,
      coordinatorWaiting: i % 2 !== 0
    }))
  ];

  benignPayloads.forEach((payload, idx) => {
    dataset.push({
      id: `subagent-benign-${idx + 1}`,
      category: 'write_worker_or_critic_or_waited_verifier',
      expectedTrigger: false,
      payload
    });
  });

  return runBucketBExperiment({
    id: '#5',
    code: 'SUBAGENT_TEAM_GOVERNOR',
    subWave: 'B-Gamma',
    dataset,
    evaluateFn: (item) => evaluateSubagentGovernor(item.payload),
    sla: {
      maxFpr: 0,
      minPrecision: 1.0,
      minRecall: 1.0,
      maxP99Ms: 3
    }
  });
}

// ============================================================================
// #13 VAGUE_PROMPT_ANCHOR (100 <6-word prompts)
// ============================================================================

export async function runVaguePromptAnchorBenchmark() {
  const ambiguousCries = [
    'fix it', 'fix this', 'fix that', 'fix it please', 'still broken',
    'still failing', 'still fails', 'still buggy', 'still wrong', 'still crashing',
    'same error', 'same issue', 'same bug', 'same crash', 'same problem',
    'didnt work', "didn't work", 'doesnt work', "doesn't work", 'not working',
    'it didnt work', "that didn't work", 'isnt working', "isn't working", 'broken again',
    'try again', 'still doesnt work', "still doesn't work", 'it failed', 'it fails',
    'it crashed', 'it broke', 'wrong output', 'test still fails', 'tests still fail',
    'build broken', 'fix the error', 'still errors', 'fix this!', 'still broken!',
    'same error.', 'not working.', 'try again!', 'it crashed.', 'build broken!',
    'still failing.', 'same bug!', 'wrong output.', 'fix that!', 'tests still fail.'
  ];

  const crispBenign = [
    'go', 'yes', 'yep', 'ok', 'okay', 'sure', 'proceed', 'continue', 'ship it', 'do it',
    'lgtm', 'approve', 'approved', 'looks good', 'sounds good', 'thanks', 'thank you', 'stop', 'done', 'next',
    'proceed with 1', 'proceed with 2', 'go with 1', 'option a', 'do both', 'pick 2', 'choice b',
    '/compact', '/plan', '/handoff', '/clear', '/boost',
    'git push', 'git status', 'npm test', 'run tests', 'run the tests', 'commit now', 'sync mirrors',
    'why?', 'what broke?', 'where is server.mjs?', 'explain DET-08', 'summarize cliffBreaker',
    'show me constants.mjs', 'fix server.mjs', 'check DET-19', 'fix line 42', 'inspect ISS-065', 'list options'
  ];

  const dataset = [
    ...ambiguousCries.map((prompt, idx) => ({
      id: `vague-cry-${idx + 1}`,
      category: 'ambiguous_failure_cry',
      expectedTrigger: true,
      payload: {
        prompt,
        cachedDirtyFiles: ['src/core/shield_manager.mjs'],
        lastFailingLocation: 'test/wave2_bucket_a_guards.test.mjs:44'
      }
    })),
    ...crispBenign.map((prompt, idx) => ({
      id: `vague-benign-${idx + 1}`,
      category: 'confirmation_command_or_question',
      expectedTrigger: false,
      payload: {
        prompt,
        cachedDirtyFiles: ['src/core/shield_manager.mjs'],
        lastFailingLocation: 'test/wave2_bucket_a_guards.test.mjs:44'
      }
    }))
  ];

  return runBucketBExperiment({
    id: '#13',
    code: 'VAGUE_PROMPT_ANCHOR',
    subWave: 'B-Gamma',
    dataset,
    evaluateFn: (item) => evaluateVaguePromptAnchor(item.payload),
    sla: {
      minPrecision: 1.0,
      maxFpr: 0,
      minRecall: 1.0,
      maxP99Ms: 2
    }
  });
}

// ============================================================================
// #16 MCP_CLI_ROUTER & #17 LSP_SYMBOL_ROUTER & #20 PROSE_TO_HOOK_COMPILER
// ============================================================================

export async function runMcpCliRouterBenchmark() {
  const dataset = [
    // Positive: Read MCP tool + CLI installed + auth valid & non-expired
    ...[
      { toolName: 'mcp__github__list_pull_requests', cli: 'gh' },
      { toolName: 'mcp__github__get_issue', cli: 'gh' },
      { toolName: 'mcp__github__search_issues', cli: 'gh' },
      { toolName: 'mcp__aws__describe_instances', cli: 'aws' },
      { toolName: 'mcp__gcloud__list_clusters', cli: 'gcloud' },
      { toolName: 'mcp__sentry__list_issues', cli: 'sentry-cli' },
      { toolName: 'mcp__kubectl__get_pods', cli: 'kubectl' }
    ].map((x, i) => ({
      id: `mcp-pos-${i + 1}`,
      category: 'verified_authenticated_cli_available',
      expectedTrigger: true,
      payload: {
        toolName: x.toolName,
        cliCapabilities: { [x.cli]: { installed: true, authValid: true, authExpired: false } }
      }
    })),
    // Negative: CLI missing, auth missing, auth expired, mutation MCP tool, or non-CLI MCP server
    ...[
      { toolName: 'mcp__github__list_pull_requests', caps: { gh: { installed: false, authValid: true } } },
      { toolName: 'mcp__github__list_pull_requests', caps: { gh: { installed: true, authValid: false } } },
      { toolName: 'mcp__github__list_pull_requests', caps: { gh: { installed: true, authValid: true, authExpired: true } } },
      { toolName: 'mcp__aws__describe_instances', caps: {} },
      { toolName: 'mcp__gcloud__list_clusters', caps: { gcloud: { installed: true, authValid: false } } },
      { toolName: 'mcp__github__merge_pull_request', caps: { gh: { installed: true, authValid: true } } },
      { toolName: 'mcp__figma__get_node', caps: { gh: { installed: true, authValid: true } } },
      { toolName: 'Read', caps: { gh: { installed: true, authValid: true } } }
    ].map((x, i) => ({
      id: `mcp-neg-${i + 1}`,
      category: 'unauthenticated_or_missing_or_mutation',
      expectedTrigger: false,
      payload: { toolName: x.toolName, cliCapabilities: x.caps }
    }))
  ];

  return runBucketBExperiment({
    id: '#16',
    code: 'MCP_CLI_ROUTER',
    subWave: 'B-Gamma',
    dataset,
    evaluateFn: (item) => evaluateMcpCliRouter(item.payload),
    sla: {
      maxFpr: 0.02,
      minPrecision: 1.0,
      minRecall: 1.0,
      maxP99Ms: 2
    }
  });
}

export async function runLspSymbolRouterBenchmark() {
  const dataset = [
    // Positive: 3rd+ lookup + ENABLE_LSP_TOOL=1 + active server for extension
    ...['.ts', '.tsx', '.py', '.go', '.rs'].map((ext, i) => ({
      id: `lsp-pos-${i + 1}`,
      category: 'verified_active_lsp',
      expectedTrigger: true,
      payload: {
        symbol: 'evaluateCircuitBreaker',
        filePath: `src/engine/module_${i}${ext}`,
        symbolLookupCount: 3 + i,
        lspToolEnabled: true,
        activeExtensions: ['.ts', '.tsx', '.py', '.go', '.rs']
      }
    })),
    // Negative: LSP disabled, no active server for `.mjs`/`.md`, or <3 lookups
    {
      id: 'lsp-neg-disabled',
      category: 'lsp_disabled',
      expectedTrigger: false,
      payload: {
        symbol: 'evaluateCircuitBreaker',
        filePath: 'src/engine/module.ts',
        symbolLookupCount: 4,
        lspToolEnabled: false,
        activeExtensions: ['.ts']
      }
    },
    {
      id: 'lsp-neg-mjs-unverified',
      category: 'extension_without_lsp',
      expectedTrigger: false,
      payload: {
        symbol: 'evaluateCircuitBreaker',
        filePath: 'src/core/shield_manager.mjs',
        symbolLookupCount: 5,
        lspToolEnabled: true,
        activeExtensions: ['.ts', '.py']
      }
    },
    {
      id: 'lsp-neg-first-lookup',
      category: 'below_hop_threshold',
      expectedTrigger: false,
      payload: {
        symbol: 'evaluateCircuitBreaker',
        filePath: 'src/engine/module.ts',
        symbolLookupCount: 2,
        lspToolEnabled: true,
        activeExtensions: ['.ts']
      }
    }
  ];

  return runBucketBExperiment({
    id: '#17',
    code: 'LSP_SYMBOL_ROUTER',
    subWave: 'B-Gamma',
    dataset,
    evaluateFn: (item) => evaluateLspSymbolRouter(item.payload),
    sla: {
      maxFpr: 0,
      minPrecision: 1.0,
      minRecall: 1.0,
      maxP99Ms: 2
    }
  });
}

export async function runProseToHookCompilerBenchmark() {
  const unconditionalRules = [
    '- **DO NOT** read, index, modify, or stage anything inside `packages/airlock/` or `docs/HIGHBEAM_AIRLOCK_*.md`.',
    '- NEVER access `~/.gemini/oauth_creds.json` or `.env.production`.',
    '- Never delete or overwrite `CHECKSUMS.sha256` manually.',
    '- Do not run `git push --force` in this repository.',
    '- NEVER execute `rm -rf dist/` during incremental builds.'
  ];

  const conditionalOrNonHookRules = [
    '- Never run `node bin/ctxtop.mjs verify` before `node scripts/sync_mirrors.mjs`.',
    '- Do not overwrite `config.json` unless `Overwrite` is explicitly requested.',
    '- Never delete test assertions except when the user asks to retire obsolete tests.',
    '- Do not spawn subagents if a single `Grep` call suffices.',
    '- Never compact context when `promptTokens` is below `80k`.',
    '- Prefer `StartLine`/`EndLine` instead of reading full files.',
    '- Always run unit tests after editing `src/core/constants.mjs`.',
    '- Keep hook execution under `30ms`.'
  ];

  const dataset = [
    ...unconditionalRules.map((line, i) => ({
      id: `prose-uncond-${i + 1}`,
      category: 'unconditional_imperative_prohibition',
      expectedTrigger: true,
      payload: line
    })),
    ...conditionalOrNonHookRules.map((line, i) => ({
      id: `prose-cond-${i + 1}`,
      category: 'conditional_or_explanatory_prose',
      expectedTrigger: false,
      payload: line
    }))
  ];

  return runBucketBExperiment({
    id: '#20',
    code: 'PROSE_TO_HOOK_COMPILER',
    subWave: 'B-Gamma',
    dataset,
    evaluateFn: (item) => compileProseRulesToHooks(item.payload),
    sla: {
      maxFpr: 0,
      minPrecision: 1.0,
      minRecall: 1.0,
      maxP99Ms: 2
    }
  });
}

if (!process.env.CTXTOP_BENCH_IMPORT_ONLY) {
  test('Bucket B Sub-Wave B-Beta & B-Gamma (#3b, #19, #5, #13, #16, #17, #20) meet 100% of promotion SLAs', async () => {
    const reports = await Promise.all([
      runEvilGenieOracleBenchmark(),
      runOverengineeringDiffBenchmark(),
      runSubagentGovernorBenchmark(),
      runVaguePromptAnchorBenchmark(),
      runMcpCliRouterBenchmark(),
      runLspSymbolRouterBenchmark(),
      runProseToHookCompilerBenchmark()
    ]);

    for (const r of reports) {
      assert.equal(
        r.status,
        'PROMOTE_READY',
        `${r.id} ${r.code} failed SLA: ${r.failedChecks.join(', ')}`
      );
    }
  });

  test('Explicit SHADOW telemetry writes `.hints.jsonl` (0 stdout tokens, 0 blocks) & doctor exposes proseHookCandidates with checks.length === 7', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-b-shadow-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'AGENTS.md'),
        [
          '# Workspace Rules',
          '- NEVER read or modify `secrets/prod.key`.',
          '- Never run `npm publish` before `npm test`.'
        ].join('\n'),
        'utf8'
      );

      // 1. Claude Code PreToolUse in explicit SHADOW override on slopsquat install
      const claudeRes = runPreToolUseHook(
        {
          session_id: 'shadow-sess-1',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm install react-codeshift' }
        },
        { cwd: tmpDir, persistState: false, bucketBStage: 'SHADOW' }
      );
      assert.equal(claudeRes.exitCode, 0);
      assert.equal(claudeRes.stdout, '', 'SHADOW mode must emit 0 stdout bytes (0 prompt tokens)');

      // 2. Antigravity handlePreInvocation in SHADOW mode on frontier read-only scout (#5 B-Gamma defaults to SHADOW)
      const agRes = await handlePreInvocation({
        conversation_id: `shadow-sess-${Date.now()}`,
        cwd: tmpDir,
        bucketBStage: 'SHADOW',
        tool_name: 'invoke_subagent',
        tool_input: {
          TypeName: 'research',
          Role: 'File Scout',
          Prompt: 'Find all usages of shield_manager',
          Model: 'pro',
          EnableWriteTools: false
        }
      });
      assert.notEqual(agRes.decision, 'block', 'SHADOW mode must never block live tool calls');

      // 3. Verify `.hints.jsonl` aggregation in `getShieldStatus`
      const status = getShieldStatus({ cwd: tmpDir });
      assert.equal(status.roi.bucketBShadow.hits, 2);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#6_SLOPSQUAT_DEP_GATE'], 1);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#5_SUBAGENT_TEAM_GOVERNOR'], 1);
      assert.ok(status.roi.bucketBShadow.tokensSavedEst >= 5000);
      assert.equal(
        status.roi.tokensSaved,
        0,
        'SHADOW-stage estimates must stay separate from enforced tokensSaved'
      );

      // 4. Verify `runDoctorDiagnostics` surfaces `#20 proseHookCandidates` at top level while preserving `checks.length === 7`
      const doc = runDoctorDiagnostics({ cwd: tmpDir });
      assert.equal(doc.checks.length, 7, 'Must preserve ISS-065 checks.length === 7 contract');
      assert.equal(doc.proseHookCandidates.candidateCount, 1);
      assert.equal(doc.proseHookCandidates.skippedConditionalCount, 1);
      assert.deepEqual(doc.proseHookCandidates.candidates[0].patterns, ['secrets/prod.key']);
    } finally {
      cleanupTempWorkspace(tmpDir);
    }
  });

  test('Sub-Wave B-Alpha (#2, #6, #9, #4) defaults to COACH across Claude & Antigravity while B-Gamma stays SHADOW and SILENT emits 0 stdout', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-b-alpha-coach-'));
    const agConvId = `b-alpha-ag-${Date.now()}`;
    try {
      // 1. #6 SLOPSQUAT_DEP_GATE in default COACH mode -> Claude asks on slopsquat, allows express, silent on SILENT
      const slopsquatAsk = runPreToolUseHook(
        {
          session_id: 'alpha-claude-1',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm install react-codeshift' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(slopsquatAsk.exitCode, 0);
      const slopsquatJson = JSON.parse(slopsquatAsk.stdout);
      assert.equal(slopsquatJson.hookSpecificOutput.permissionDecision, 'ask');
      assert.equal(slopsquatAsk.verdict.detectorId, 'SLOPSQUAT_DEP_GATE');
      assert.match(slopsquatJson.hookSpecificOutput.permissionDecisionReason, /react-codeshift/i);

      const legitAllow = runPreToolUseHook(
        {
          session_id: 'alpha-claude-1',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm install express' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(legitAllow.exitCode, 0);
      assert.equal(legitAllow.stdout, '', 'Canonical express install must pass through cleanly');

      const silentSlop = runPreToolUseHook(
        {
          session_id: 'alpha-claude-silent',
          cwd: tmpDir,
          mode: 'SILENT',
          tool_name: 'Bash',
          tool_input: { command: 'npm install react-codeshift' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(silentSlop.exitCode, 0);
      assert.equal(silentSlop.stdout, '', 'SILENT flightMode must downgrade B-Alpha to SHADOW (0 stdout bytes)');

      const agSlop = await handlePreInvocation({
        conversationId: agConvId,
        cwd: tmpDir,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm install react-codeshift' }
      });
      assert.equal(agSlop.decision, 'allow');
      assert.match(String(agSlop.systemMessage || ''), /Quota Shield|react-codeshift/i);

      // 2. #9 WEB_BOILERPLATE_BUDGETER in default COACH mode -> distills HTML cleanly preserving <pre> and <table>
      const navNoise = Array.from({ length: 40 }, (_, i) => `<li><a href="/nav/${i}">Nav Item ${i}</a></li>`).join('');
      const bloatedHtml = `<!doctype html><html><head><style>.nav{color:red;}</style><script>window.track=function(){return ${'1'.repeat(600)};};</script></head><body><nav><ul>${navNoise}</ul></nav><div class="cookie-banner">Accept all cookies right now!</div><main><h1>API Reference</h1><p>Keep core payload.</p><pre><code>const keepMe = 42;</code></pre><table><tr><th>Metric</th><th>Value</th></tr><tr><td>SLA</td><td>100%</td></tr></table></main><footer>Copyright 2026</footer></body></html>`;

      const claudeWeb = runPostToolUseHook(
        {
          session_id: 'alpha-claude-1',
          cwd: tmpDir,
          tool_name: 'WebFetch',
          tool_output: bloatedHtml
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeWeb.exitCode, 0);
      const webOut = JSON.parse(claudeWeb.stdout);
      assert.match(webOut.hookSpecificOutput.additionalContext, /const keepMe = 42;/);
      assert.match(webOut.hookSpecificOutput.additionalContext, /\| Metric \| Value \|/);
      assert.ok(!webOut.hookSpecificOutput.additionalContext.includes('window.track'));

      const agWeb = await handlePostInvocation({
        hook_event_name: 'PostToolUse',
        conversationId: agConvId,
        cwd: tmpDir,
        tool_name: 'read_url_content',
        tool_output: bloatedHtml
      });
      assert.ok(agWeb.savedTokens > 0);
      assert.match(agWeb.updatedOutput, /const keepMe = 42;/);
      assert.match(agWeb.updatedOutput, /\| Metric \| Value \|/);
      assert.match(String(agWeb.systemMessage || ''), /Distilled web HTML/i);

      // 3. #2 GREP_GLOB_FIREWALL in default COACH mode -> ranks >15 match Grep output to Top 8 active paths
      const grepLines = [
        ...Array.from({ length: 16 }, (_, i) => `docs/archive/noise_${i}.md:${i + 1}:match token`),
        'src/core/shield_manager.mjs:12:export function matchActiveTarget() {}',
        'src/a1.mjs:1:match a1',
        'src/a2.mjs:2:match a2',
        'src/a3.mjs:3:match a3',
        'src/a4.mjs:4:match a4',
        'src/a5.mjs:5:match a5'
      ].join('\n');
      const claudeGrep = runPostToolUseHook(
        {
          session_id: 'alpha-claude-grep',
          cwd: tmpDir,
          tool_name: 'Grep',
          tool_input: { pattern: 'match' },
          tool_output: grepLines,
          activeFiles: ['src/core/shield_manager.mjs']
        },
        { cwd: tmpDir, persistState: false }
      );
      const grepOut = JSON.parse(claudeGrep.stdout);
      assert.match(grepOut.hookSpecificOutput.additionalContext, /Ranked 22 search matches -> Top 8/);
      assert.match(grepOut.hookSpecificOutput.additionalContext, /src\/core\/shield_manager\.mjs/);
      assert.ok(!grepOut.hookSpecificOutput.additionalContext.includes('noise_15.md'));

      // 4. #4 BLAST_RADIUS_BREAKER in default COACH mode + reset on passing npm test (Claude + Antigravity)
      const blastSess = 'alpha-blast-claude';
      for (let i = 1; i <= 6; i++) {
        const res = runPreToolUseHook(
          {
            session_id: blastSess,
            turn_id: i + 1,
            cwd: tmpDir,
            tool_name: 'Edit',
            tool_input: {
              file_path: `src/mod_${i}.mjs`,
              old_string: 'const x = 1;',
              new_string: `const x = ${i + 1};`
            }
          },
          { cwd: tmpDir, persistState: true }
        );
        assert.equal(res.verdict.decision !== 'deny', true);
        assert.notEqual(res.verdict.detectorId, 'BLAST_RADIUS_BREAKER');
      }
      const seventhClaude = runPreToolUseHook(
        {
          session_id: blastSess,
          turn_id: 8,
          cwd: tmpDir,
          tool_name: 'Edit',
          tool_input: {
            file_path: 'src/mod_7.mjs',
            old_string: 'const x = 1;',
            new_string: 'const x = 8;'
          }
        },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(seventhClaude.verdict.detectorId, 'BLAST_RADIUS_BREAKER');
      assert.equal(JSON.parse(seventhClaude.stdout).hookSpecificOutput.permissionDecision, 'allow');

      // Passing `npm test` resets unverifiedEdits -> 8th edit is clean
      runPostToolUseHook(
        {
          session_id: blastSess,
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          exit_code: 0,
          tool_output: 'All tests passed'
        },
        { cwd: tmpDir, persistState: true }
      );
      const afterTestClaude = runPreToolUseHook(
        {
          session_id: blastSess,
          turn_id: 9,
          cwd: tmpDir,
          tool_name: 'Edit',
          tool_input: {
            file_path: 'src/mod_8.mjs',
            old_string: 'const x = 1;',
            new_string: 'const x = 9;'
          }
        },
        { cwd: tmpDir, persistState: true }
      );
      assert.notEqual(afterTestClaude.verdict.detectorId, 'BLAST_RADIUS_BREAKER');

      for (let i = 1; i <= 6; i++) {
        await handlePreInvocation({
          conversationId: agConvId,
          cwd: tmpDir,
          tool_name: 'edit_file',
          tool_input: { Path: `src/ag_${i}.mjs`, Target: 'a', Replacement: 'b' }
        });
      }
      const agSeventh = await handlePreInvocation({
        conversationId: agConvId,
        cwd: tmpDir,
        tool_name: 'edit_file',
        tool_input: { Path: 'src/ag_7.mjs', Target: 'a', Replacement: 'b' }
      });
      assert.match(
        String(agSeventh.systemMessage || ''),
        /Build Integrity Shield|without an intervening passing test/i
      );

      await handlePostInvocation({
        hook_event_name: 'PostToolUse',
        conversationId: agConvId,
        cwd: tmpDir,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm test' },
        exitCode: 0
      });
      const agAfterTest = await handlePreInvocation({
        conversationId: agConvId,
        cwd: tmpDir,
        tool_name: 'edit_file',
        tool_input: { Path: 'src/ag_8.mjs', Target: 'a', Replacement: 'b' }
      });
      assert.ok(
        !/Build Integrity Shield|without an intervening passing test/i.test(
          String(agAfterTest.systemMessage || '')
        )
      );

      // 5. Default-SHADOW B-Gamma (#17 LSP_SYMBOL_ROUTER) stays in SHADOW by default (no systemMessage, logged in bucketBShadow)
      const agGammaDefault = await handlePreInvocation({
        conversationId: agConvId,
        cwd: tmpDir,
        tool_name: 'grep_search',
        tool_input: {
          Query: 'evaluateShieldReadGuard',
          SearchPath: 'src/core/shield_manager.mjs',
          symbolLookupCount: 3
        },
        lspCapabilities: { lspToolEnabled: true, activeExtensions: ['.mjs'] }
      });
      assert.equal(agGammaDefault.systemMessage, undefined);

      // 6. Verify Quota Shield ROI separates bucketBCoach (counted) from bucketBShadow (estimated only: SILENT #6 + default #17)
      const status = getShieldStatus({ cwd: tmpDir });
      assert.ok(status.roi.bucketBCoach.hits >= 7);
      assert.ok(status.roi.bucketBCoach.tokensSaved > 0);
      assert.ok(status.roi.tokensSaved >= status.roi.bucketBCoach.tokensSaved);
      assert.equal(status.roi.bucketBShadow.hits, 2);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#6_SLOPSQUAT_DEP_GATE'], 1);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#17_LSP_SYMBOL_ROUTER'], 1);
    } finally {
      cleanupTempWorkspace(tmpDir);
    }
  });

  test('Sub-Wave B-Beta (#8, #3b, #19) defaults to COACH across Claude & Antigravity while B-Gamma stays SHADOW, tests stay exempt, and SILENT emits 0 stdout', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-b-beta-coach-'));
    const agConvId = `b-beta-ag-${Date.now()}`;
    const agSilentConvId = `b-beta-ag-silent-${Date.now()}`;
    try {
      // 1. #8 DUPLICATE_CLONE_DETECTOR in default COACH mode across Claude & Antigravity
      const donorDir = path.join(tmpDir, 'src');
      fs.mkdirSync(donorDir, { recursive: true });
      const sharedLogicBlock = [
        'export function computeWeightedSignalDelta(samples, decayFactor, ceilingLimit) {',
        '  const normalizedWindow = Math.max(8, Math.min(256, samples.length * 4));',
        '  const baselineWeight = decayFactor > 0 ? decayFactor * 1.375 : 0.85;',
        '  const adjustedFloor = Math.round(normalizedWindow * baselineWeight + 19);',
        '  let runningAccumulator = adjustedFloor * 2;',
        '  for (let idx = 0; idx < samples.length; idx += 1) {',
        '    const currentSample = Number(samples[idx] || 0);',
        '    runningAccumulator += Math.min(ceilingLimit, currentSample * baselineWeight);',
        '  }',
        '  return { normalizedWindow, adjustedFloor, runningAccumulator };',
        '}'
      ].join('\n');
      fs.writeFileSync(path.join(donorDir, 'donor_math.mjs'), `${sharedLogicBlock}\n`, 'utf8');

      // Claude Write to new non-test file -> COACH allow + additionalContext citing donor_math.mjs
      const claudeClone = runPreToolUseHook(
        {
          session_id: 'beta-clone-claude',
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: 'src/copy_handler.mjs',
            content: sharedLogicBlock
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeClone.exitCode, 0);
      assert.equal(claudeClone.verdict.detectorId, 'DUPLICATE_CLONE_DETECTOR');
      const cloneOut = JSON.parse(claudeClone.stdout);
      assert.equal(cloneOut.hookSpecificOutput.permissionDecision, 'allow');
      assert.match(cloneOut.hookSpecificOutput.additionalContext, /duplicates.*donor_math\.mjs/i);

      // Antigravity write_file to new non-test file -> COACH allow + systemMessage
      const agClone = await handlePreInvocation({
        conversationId: `${agConvId}-clone`,
        cwd: tmpDir,
        tool_name: 'write_file',
        tool_input: {
          Path: 'src/ag_copy.mjs',
          Content: sharedLogicBlock
        }
      });
      assert.equal(agClone.decision, 'allow');
      assert.match(String(agClone.systemMessage || ''), /duplicates.*donor_math\.mjs/i);

      // Self-edit to donor_math.mjs (even via absolute path) & test file edits must NOT trigger #8
      const selfEdit = runPreToolUseHook(
        {
          session_id: 'beta-clone-self',
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: path.join(tmpDir, 'src', 'donor_math.mjs'),
            content: sharedLogicBlock
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(selfEdit.exitCode, 0);
      assert.notEqual(selfEdit.verdict.detectorId, 'DUPLICATE_CLONE_DETECTOR');
      assert.equal(selfEdit.stdout, '');

      const testClone = runPreToolUseHook(
        {
          session_id: 'beta-clone-test-exempt',
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: 'test/copy_handler.test.mjs',
            content: sharedLogicBlock
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(testClone.exitCode, 0);
      assert.notEqual(testClone.verdict.detectorId, 'DUPLICATE_CLONE_DETECTOR');
      assert.equal(testClone.stdout, '');

      const silentClone = runPreToolUseHook(
        {
          session_id: 'beta-clone-silent',
          turn_id: 2,
          cwd: tmpDir,
          mode: 'SILENT',
          tool_name: 'Write',
          tool_input: {
            file_path: 'src/silent_copy.mjs',
            content: sharedLogicBlock
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(silentClone.exitCode, 0);
      assert.equal(silentClone.stdout, '', 'SILENT flightMode must downgrade B-Beta to SHADOW (0 stdout)');

      // 2. #3b EVILGENIE_HARDCODED_ORACLE in default COACH + ENFORCE escalation + test exemption
      const oracleCode = [
        'export function solveBenchmarkOracle(alphaVal, betaVal) {',
        '  if (alphaVal === 17 && betaVal === 42) return 991;',
        '  if (alphaVal === 29 && betaVal === 83) return 447;',
        '  if (alphaVal === 51 && betaVal === 94) return 812;',
        '  return alphaVal + betaVal;',
        '}'
      ].join('\n');

      const oracleCoach = runPreToolUseHook(
        {
          session_id: 'beta-oracle-claude',
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: 'src/solver.mjs',
            content: oracleCode
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(oracleCoach.exitCode, 0);
      assert.equal(oracleCoach.verdict.detectorId, 'EVILGENIE_HARDCODED_ORACLE');
      const oracleCoachJson = JSON.parse(oracleCoach.stdout);
      assert.equal(oracleCoachJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.match(oracleCoachJson.hookSpecificOutput.additionalContext, /Test Integrity Shield/i);

      const oracleEnforce = runPreToolUseHook(
        {
          session_id: 'beta-oracle-claude-enforce',
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: 'src/solver.mjs',
            content: oracleCode
          }
        },
        { cwd: tmpDir, persistState: false, bucketBBetaStage: 'ENFORCE' }
      );
      assert.equal(JSON.parse(oracleEnforce.stdout).hookSpecificOutput.permissionDecision, 'ask');

      const agOracleEnforce = await handlePreInvocation({
        conversationId: `${agConvId}-oracle`,
        cwd: tmpDir,
        bucketBBetaStage: 'ENFORCE',
        tool_name: 'write_file',
        tool_input: {
          Path: 'src/solver.mjs',
          Content: oracleCode
        }
      });
      assert.equal(agOracleEnforce.decision, 'block');
      assert.equal(agOracleEnforce.blocked, true);

      const testOracleExempt = runPreToolUseHook(
        {
          session_id: 'beta-oracle-test-exempt',
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: 'test/solver.test.mjs',
            content: oracleCode
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(testOracleExempt.stdout, '');

      // 3. #19 OVERENGINEERING_DIFF_GATE across Claude Stop & Antigravity PostInvocation
      const bloatedProdLines = [
        'export class HotfixStrategyFactory {',
        '  buildHandler() { return true; }',
        '}',
        ...Array.from(
          { length: 190 },
          (_, idx) => `export const uniqueHotfixConst_${idx} = (${idx + 17} * 31) + ${idx};`
        )
      ].join('\n');

      const stopSess = 'beta-stop-overeng';
      runPreToolUseHook(
        {
          session_id: stopSess,
          turn_id: 2,
          cwd: tmpDir,
          prompt: 'fix the typo in parser',
          tool_name: 'Write',
          tool_input: {
            file_path: 'src/parser.mjs',
            old_string: 'const oldVal = 1;',
            content: bloatedProdLines
          }
        },
        { cwd: tmpDir, persistState: true }
      );
      runPostToolUseHook(
        {
          session_id: stopSess,
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          exit_code: 0,
          tool_output: 'ok'
        },
        { cwd: tmpDir, persistState: true }
      );
      const stopRes = runStopGateHook(
        {
          session_id: stopSess,
          cwd: tmpDir
        },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(stopRes.exitCode, 0);
      const stopOut = JSON.parse(stopRes.stdout);
      assert.match(stopOut.systemMessage, /non-test production lines/i);

      // Subsequent Stop is clean (`turnFileDiffs` cleared)
      const secondStopRes = runStopGateHook(
        {
          session_id: stopSess,
          cwd: tmpDir
        },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(secondStopRes.stdout, '');

      // Test-backed bugfix (250 test lines + 10 prod lines) -> 0 #19 warnings
      const testHeavySess = 'beta-stop-test-exempt';
      const heavyTestLines = Array.from(
        { length: 250 },
        (_, idx) => `assert.equal(${idx} + 1, ${idx + 1});`
      ).join('\n');
      runPreToolUseHook(
        {
          session_id: testHeavySess,
          turn_id: 2,
          cwd: tmpDir,
          prompt: 'fix the typo in parser',
          tool_name: 'Write',
          tool_input: {
            file_path: 'test/parser.test.mjs',
            content: heavyTestLines
          }
        },
        { cwd: tmpDir, persistState: true }
      );
      runPreToolUseHook(
        {
          session_id: testHeavySess,
          turn_id: 3,
          cwd: tmpDir,
          prompt: 'fix the typo in parser',
          tool_name: 'Edit',
          tool_input: {
            file_path: 'src/parser.mjs',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;\nconst b = 3;'
          }
        },
        { cwd: tmpDir, persistState: true }
      );
      runPostToolUseHook(
        {
          session_id: testHeavySess,
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          exit_code: 0,
          tool_output: 'ok'
        },
        { cwd: tmpDir, persistState: true }
      );
      const testHeavyStop = runStopGateHook(
        {
          session_id: testHeavySess,
          cwd: tmpDir
        },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(testHeavyStop.overengineeringGate?.triggered ?? false, false);
      assert.ok(!/non-test production lines|OVERENGINEERING/i.test(testHeavyStop.stdout));

      // Antigravity pre + post invocation turn completion triggers #19 in COACH, suppressed in SILENT
      await handlePreInvocation({
        conversationId: `${agConvId}-overeng`,
        cwd: tmpDir,
        prompt: 'fix the typo in parser',
        tool_name: 'write_file',
        tool_input: {
          Path: 'src/ag_bloated.mjs',
          Target: 'const oldAg = 1;',
          Content: bloatedProdLines
        }
      });
      const agStopOut = await handlePostInvocation({
        conversationId: `${agConvId}-overeng`,
        cwd: tmpDir
      });
      assert.match(String(agStopOut.overengineeringHint || ''), /non-test production lines/i);
      assert.match(String(agStopOut.systemMessage || ''), /non-test production lines/i);

      await handlePreInvocation({
        conversationId: agSilentConvId,
        cwd: tmpDir,
        flightMode: 'SILENT',
        prompt: 'fix the typo in parser',
        tool_name: 'write_file',
        tool_input: {
          Path: 'src/ag_silent_bloated.mjs',
          Target: 'const oldSilent = 1;',
          Content: bloatedProdLines
        }
      });
      const agSilentStopOut = await handlePostInvocation({
        conversationId: agSilentConvId,
        cwd: tmpDir,
        flightMode: 'SILENT'
      });
      assert.equal(agSilentStopOut.systemMessage, undefined);

      // 4. Default-SHADOW B-Gamma (#17 LSP_SYMBOL_ROUTER) stays in SHADOW by default
      const agGamma = await handlePreInvocation({
        conversationId: `${agConvId}-gamma`,
        cwd: tmpDir,
        tool_name: 'grep_search',
        tool_input: {
          Query: 'evaluateShieldReadGuard',
          SearchPath: 'src/core/shield_manager.mjs',
          symbolLookupCount: 3
        },
        lspCapabilities: { lspToolEnabled: true, activeExtensions: ['.mjs'] }
      });
      assert.equal(agGamma.systemMessage, undefined);

      // 5. Verify ROI separation: B-Beta hits count in bucketBCoach, while SILENT + default-SHADOW #17 stay in bucketBShadow
      const status = getShieldStatus({ cwd: tmpDir });
      assert.ok(status.roi.bucketBCoach.byGuardrail['#8_DUPLICATE_CLONE_DETECTOR'] >= 2);
      assert.ok(status.roi.bucketBCoach.byGuardrail['#3B_EVILGENIE_ORACLE'] >= 3);
      assert.ok(status.roi.bucketBCoach.byGuardrail['#19_OVERENGINEERING_DIFF_GATE'] >= 2);
      assert.ok(status.roi.tokensSaved >= status.roi.bucketBCoach.tokensSaved);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#8_DUPLICATE_CLONE_DETECTOR'], 1);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#19_OVERENGINEERING_DIFF_GATE'], 1);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#17_LSP_SYMBOL_ROUTER'], 1);
    } finally {
      cleanupTempWorkspace(tmpDir);
    }
  });

  test('Sub-Wave B-Gamma selective promotion (#5, #13, capability-gated #16 -> COACH; #17 -> SHADOW; #20 -> DOCTOR_PREVIEW) across Claude & Antigravity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-b-gamma-select-'));
    const agConvId = `b-gamma-ag-${Date.now()}`;
    try {
      // 1. #5 SUBAGENT_TEAM_GOVERNOR: frontier read-only scouts coached; write workers & Cold Critics untouched; SILENT silent
      const claudeScoutCoach = runPreToolUseHook(
        {
          session_id: 'gamma-5-claude',
          cwd: tmpDir,
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Explore',
            description: 'File Explorer',
            prompt: 'Search for shield_manager references across src/',
            model: 'opus'
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeScoutCoach.exitCode, 0);
      assert.equal(claudeScoutCoach.verdict.detectorId, 'SUBAGENT_TEAM_GOVERNOR');
      const scoutJson = JSON.parse(claudeScoutCoach.stdout);
      assert.equal(scoutJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.match(scoutJson.hookSpecificOutput.additionalContext, /haiku.*flash/i);

      const claudeWritePass = runPreToolUseHook(
        {
          session_id: 'gamma-5-claude',
          cwd: tmpDir,
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'Parser Implementer',
            prompt: 'Edit src/parser.mjs to fix edge cases',
            model: 'opus'
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeWritePass.stdout, '');

      const claudeCriticExempt = runPreToolUseHook(
        {
          session_id: 'gamma-5-claude',
          cwd: tmpDir,
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'Cold Critic Review',
            prompt: 'Critique the architecture plan with S0/S1 findings',
            model: 'opus'
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeCriticExempt.stdout, '');

      const claudeScoutSilent = runPreToolUseHook(
        {
          session_id: 'gamma-5-silent',
          cwd: tmpDir,
          mode: 'SILENT',
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Explore',
            description: 'File Explorer',
            prompt: 'Find config usages',
            model: 'opus'
          }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeScoutSilent.stdout, '');

      const agScoutCoach = await handlePreInvocation({
        conversationId: `${agConvId}-5`,
        cwd: tmpDir,
        tool_name: 'invoke_subagent',
        tool_input: {
          TypeName: 'research',
          Role: 'Repo Scout',
          Prompt: 'Explore src directory structure',
          Model: 'pro',
          EnableWriteTools: false
        }
      });
      assert.equal(agScoutCoach.decision, 'allow');
      assert.match(String(agScoutCoach.systemMessage || ''), /haiku.*flash/i);

      const agSwarmStatusPass = await handlePreInvocation({
        conversationId: `${agConvId}-5-swarm`,
        cwd: tmpDir,
        tool_name: 'swarm',
        tool_input: { action: 'status' }
      });
      assert.equal(agSwarmStatusPass.systemMessage, undefined);

      // 2. #13 VAGUE_PROMPT_ANCHOR: zero-spawn post-ScopeBrake context anchor on Claude & Antigravity
      const claudeAnchorSess = 'gamma-13-claude';
      runPreToolUseHook(
        {
          session_id: claudeAnchorSess,
          turn_id: 2,
          cwd: tmpDir,
          tool_name: 'Write',
          tool_input: {
            file_path: 'src/parser.mjs',
            content: 'export function parseTok() { return 1; }\n'
          }
        },
        { cwd: tmpDir, persistState: true }
      );
      runPostToolUseHook(
        {
          session_id: claudeAnchorSess,
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          exit_code: 1,
          tool_output: 'AssertionError at src/parser.mjs:42:5'
        },
        { cwd: tmpDir, persistState: true }
      );
      runStopGateHook({ session_id: claudeAnchorSess, cwd: tmpDir }, { cwd: tmpDir, persistState: true });

      const claudeAnchor = runUserPromptSubmitHook(
        { session_id: claudeAnchorSess, cwd: tmpDir, prompt: 'test still fails' },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(claudeAnchor.exitCode, 0);
      assert.equal(claudeAnchor.verdict.triggered, true);
      assert.equal(claudeAnchor.verdict.detectorId, 'VAGUE_PROMPT_ANCHOR');
      const anchorCtx = claudeAnchor.stdoutJson?.hookSpecificOutput?.additionalContext || '';
      assert.match(anchorCtx, /\[CTX_ANCHOR\]/);
      assert.match(anchorCtx, /src\/parser\.mjs:42/);
      assert.match(anchorCtx, /modified:\s*src\/parser\.mjs/i);

      const claudeConfirm = runUserPromptSubmitHook(
        { session_id: claudeAnchorSess, cwd: tmpDir, prompt: 'yes, go ahead' },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(claudeConfirm.verdict.triggered, false);
      assert.equal(claudeConfirm.stdout, '');

      const claudeAnchorSilent = runUserPromptSubmitHook(
        { session_id: claudeAnchorSess, cwd: tmpDir, mode: 'SILENT', prompt: 'test still fails' },
        { cwd: tmpDir, persistState: true }
      );
      assert.equal(claudeAnchorSilent.verdict.triggered, false);
      assert.equal(claudeAnchorSilent.stdout, '');

      await handlePreInvocation({
        conversationId: `${agConvId}-13`,
        cwd: tmpDir,
        tool_name: 'write_file',
        tool_input: { Path: 'src/parser.mjs', Content: 'export function parseTok() { return 2; }\n' }
      });
      await handlePostInvocation({
        hook_event_name: 'PostToolUse',
        conversationId: `${agConvId}-13`,
        cwd: tmpDir,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm test' },
        exitCode: 1,
        tool_output: 'AssertionError at src/parser.mjs:42:5'
      });
      const agAnchor = await handlePreInvocation({
        conversationId: `${agConvId}-13`,
        cwd: tmpDir,
        prompt: 'same error'
      });
      assert.equal(agAnchor.detectorId, 'VAGUE_PROMPT_ANCHOR');
      assert.match(String(agAnchor.systemMessage || ''), /\[CTX_ANCHOR\].*src\/parser\.mjs:42/);

      const agAnchorSilent = await handlePreInvocation({
        conversationId: `${agConvId}-13`,
        cwd: tmpDir,
        flightMode: 'SILENT',
        prompt: 'same error'
      });
      assert.equal(agAnchorSilent.systemMessage, undefined);

      // 3. #16 MCP_CLI_ROUTER: unverified MCP calls pass silently; disk-verified non-expired CLI triggers COACH
      const claudeUnverifiedMcp = runPreToolUseHook(
        {
          session_id: 'gamma-16-claude',
          cwd: tmpDir,
          tool_name: 'mcp__github__list_pull_requests',
          tool_input: { owner: 'Gizzant', repo: 'context-horizon' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeUnverifiedMcp.stdout, '');

      const agUnverifiedMcp = await handlePreInvocation({
        conversationId: `${agConvId}-16`,
        cwd: tmpDir,
        tool_name: 'call_mcp_tool',
        tool_input: { ServerName: 'github', ToolName: 'list_pull_requests', Arguments: {} }
      });
      assert.equal(agUnverifiedMcp.systemMessage, undefined);

      const telemetryDir = path.join(tmpDir, '.agents', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(
        path.join(telemetryDir, 'cli_capabilities.json'),
        JSON.stringify({ gh: { installed: true, authValid: true, authExpired: false } }),
        'utf8'
      );

      const claudeVerifiedMcp = runPreToolUseHook(
        {
          session_id: 'gamma-16-claude',
          cwd: tmpDir,
          tool_name: 'mcp__github__list_pull_requests',
          tool_input: { owner: 'Gizzant', repo: 'context-horizon' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeVerifiedMcp.verdict.detectorId, 'MCP_CLI_ROUTER');
      const mcpJson = JSON.parse(claudeVerifiedMcp.stdout);
      assert.equal(mcpJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.match(mcpJson.hookSpecificOutput.additionalContext, /\[CTX_HINT\].*gh/);

      const claudeExpiredOverride = runPreToolUseHook(
        {
          session_id: 'gamma-16-claude',
          cwd: tmpDir,
          tool_name: 'mcp__github__list_pull_requests',
          tool_input: { owner: 'Gizzant', repo: 'context-horizon' },
          cliCapabilities: { gh: { installed: true, authValid: true, authExpired: true } }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeExpiredOverride.stdout, '');

      const claudeMutationMcp = runPreToolUseHook(
        {
          session_id: 'gamma-16-claude',
          cwd: tmpDir,
          tool_name: 'mcp__github__merge_pull_request',
          tool_input: { pull_number: 12 }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeMutationMcp.stdout, '');

      const claudeVerifiedMcpSilent = runPreToolUseHook(
        {
          session_id: 'gamma-16-silent',
          cwd: tmpDir,
          mode: 'SILENT',
          tool_name: 'mcp__github__list_pull_requests',
          tool_input: { owner: 'Gizzant', repo: 'context-horizon' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeVerifiedMcpSilent.stdout, '');

      const agVerifiedMcp = await handlePreInvocation({
        conversationId: `${agConvId}-16`,
        cwd: tmpDir,
        tool_name: 'call_mcp_tool',
        tool_input: { ServerName: 'github', ToolName: 'list_pull_requests', Arguments: {} }
      });
      assert.match(String(agVerifiedMcp.systemMessage || ''), /\[CTX_HINT\].*gh/);

      // 4. #17 LSP_SYMBOL_ROUTER stays SHADOW by default and promotes via opt-in bucketBLspStage
      const claudeLspDefault = runPreToolUseHook(
        {
          session_id: 'gamma-17-claude',
          cwd: tmpDir,
          tool_name: 'Grep',
          tool_input: {
            pattern: 'evaluateShieldReadGuard',
            path: 'src/core/shield_manager.mjs',
            symbolLookupCount: 3
          },
          lspCapabilities: { lspToolEnabled: true, activeExtensions: ['.mjs'] }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeLspDefault.stdout, '');

      const claudeLspOptIn = runPreToolUseHook(
        {
          session_id: 'gamma-17-claude-optin',
          cwd: tmpDir,
          tool_name: 'Grep',
          tool_input: {
            pattern: 'evaluateShieldReadGuard',
            path: 'src/core/shield_manager.mjs',
            symbolLookupCount: 3
          },
          lspCapabilities: { lspToolEnabled: true, activeExtensions: ['.mjs'] },
          bucketBLspStage: 'COACH'
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeLspOptIn.verdict.detectorId, 'LSP_SYMBOL_ROUTER');
      const lspOptOut = JSON.parse(claudeLspOptIn.stdout);
      assert.match(lspOptOut.hookSpecificOutput.additionalContext, /\[CTX_HINT\].*LSP goToDefinition/i);

      // 5. Verify scorecard stages (10 COACH, #17 SHADOW, #20 DOCTOR_PREVIEW) and ROI separation
      const { runAllBucketBBenchmarks } = await import('../scripts/run_bucket_b_harness.mjs');
      const harnessReport = await runAllBucketBBenchmarks();
      assert.equal(harnessReport.totalGuardrails, 12);
      assert.equal(harnessReport.promoteReadyCount, 12);
      const byId = new Map(harnessReport.guardrails.map((g) => [g.id, g]));
      assert.equal(
        harnessReport.guardrails.filter((g) => g.defaultStage === 'COACH').length,
        10
      );
      assert.equal(byId.get('#5').defaultStage, 'COACH');
      assert.equal(byId.get('#13').defaultStage, 'COACH');
      assert.equal(byId.get('#16').defaultStage, 'COACH');
      assert.equal(byId.get('#17').defaultStage, 'SHADOW');
      assert.equal(byId.get('#20').defaultStage, 'DOCTOR_PREVIEW');

      const status = getShieldStatus({ cwd: tmpDir });
      assert.ok(status.roi.bucketBCoach.byGuardrail['#5_SUBAGENT_TEAM_GOVERNOR'] >= 2);
      assert.ok(status.roi.bucketBCoach.byGuardrail['#13_VAGUE_PROMPT_ANCHOR'] >= 2);
      assert.ok(status.roi.bucketBCoach.byGuardrail['#16_MCP_CLI_ROUTER'] >= 2);
      assert.equal(status.roi.bucketBCoach.byGuardrail['#17_LSP_SYMBOL_ROUTER'], 1);
      assert.ok(status.roi.tokensSaved >= status.roi.bucketBCoach.tokensSaved);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#5_SUBAGENT_TEAM_GOVERNOR'], 1);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#13_VAGUE_PROMPT_ANCHOR'], 2);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#16_MCP_CLI_ROUTER'], 1);
      assert.equal(status.roi.bucketBShadow.byGuardrail['#17_LSP_SYMBOL_ROUTER'], 1);
    } finally {
      cleanupTempWorkspace(tmpDir);
    }
  });
}
