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
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
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

  test('Live SHADOW telemetry writes `.hints.jsonl` (0 stdout tokens, 0 blocks) & doctor exposes proseHookCandidates with checks.length === 7', () => {
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

      // 1. Claude Code PreToolUse in default SHADOW mode on slopsquat install
      const claudeRes = runPreToolUseHook(
        {
          session_id: 'shadow-sess-1',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm install react-codeshift' }
        },
        { cwd: tmpDir, persistState: false }
      );
      assert.equal(claudeRes.exitCode, 0);
      assert.equal(claudeRes.stdout, '', 'SHADOW mode must emit 0 stdout bytes (0 prompt tokens)');

      // 2. Antigravity handlePreInvocation in default SHADOW mode on frontier read-only scout
      const agRes = handlePreInvocation({
        conversation_id: 'shadow-sess-1',
        cwd: tmpDir,
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
}
