import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { buildDemoHorizonState } from '../src/demo/synthetic_states.mjs';
import {
  DETECTOR_CATALOG,
  CORE_AUDITABLE_GUARDS,
  summarizeCoreAuditableGuards
} from '../src/core-isomorphic/catalog/detectorCatalog.mjs';
import {
  probeGitMergeTree,
  clearGitMergeTreeCache
} from '../src/engine-node/sensors/git_merge_tree.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { readLedgerEntries } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { PLG_TIER_MATRIX } from '../src/core/pro_license.mjs';
import { runCli } from '../bin/ctxtop.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

describe('VC 90-Day Playbook Verification Suite (Workstreams 1–5)', () => {
  describe('Workstream 1: Demo Harness & Synthetic States Mathematical Integrity', () => {
    it('ensures all 8 demo scenarios have exact non-overlapping breakdown sums, exact cell sums, and non-zero useful tokens', () => {
      for (let scenarioId = 1; scenarioId <= 8; scenarioId += 1) {
        const state = buildDemoHorizonState(scenarioId);
        const total = state.window.totalActiveTokens;
        const bd = state.breakdown;

        const breakdownSum =
          Number(bd.ANCHOR || 0) +
          Number(bd.INJECTED_MEMORY || 0) +
          Number(bd.ACTIVE_WORKING_SET || 0) +
          Number(bd.DUPLICATE_READ || 0) +
          Number(bd.STALE_TURN || 0) +
          Number(bd.DEAD_ERROR || 0);

        assert.equal(
          breakdownSum,
          total,
          `Scenario ${scenarioId} non-overlapping breakdown sum (${breakdownSum}) must equal totalActiveTokens (${total})`
        );

        assert.equal(
          Number(bd.STALE_DUPLICATE || 0),
          Number(bd.DUPLICATE_READ || 0) + Number(bd.STALE_TURN || 0),
          `Scenario ${scenarioId} STALE_DUPLICATE must equal DUPLICATE_READ + STALE_TURN`
        );

        const clutterTokens = Number(bd.DUPLICATE_READ || 0) + Number(bd.STALE_TURN || 0);
        const deadErrorTokens = Number(bd.DEAD_ERROR || 0);
        const usefulTokens = total - clutterTokens - deadErrorTokens;
        assert.ok(
          usefulTokens > 0,
          `Scenario ${scenarioId} must have > 0 useful tokens (got ${usefulTokens})`
        );

        const cellTokenSum = state.cells.reduce((acc, cell) => acc + Number(cell.totalTokens || 0), 0);
        assert.equal(
          cellTokenSum,
          total,
          `Scenario ${scenarioId} sum of 40 cells (${cellTokenSum}) must equal totalActiveTokens (${total})`
        );

        assert.ok(state.routerState, `Scenario ${scenarioId} must include routerState`);
        assert.ok(state.coachState, `Scenario ${scenarioId} must include coachState`);
        assert.equal(state.hostHealth.status, 'HEALTHY', `Scenario ${scenarioId} hostHealth must default to HEALTHY`);
        assert.equal(state.hostHealth.orphanCount, 0, `Scenario ${scenarioId} orphanCount must be 0 in default demo`);
      }
    });

    it('keeps topRiskyCells, chronicReads, and subagents empty on Turn-1 Scenario 1 and populated on bloated/swarm scenarios', () => {
      const s1 = buildDemoHorizonState(1);
      assert.equal(s1.topRiskyCells.length, 0, 'Scenario 1 (Turn 1) must have 0 topRiskyCells');
      assert.equal(s1.chronicReads.length, 0, 'Scenario 1 (Turn 1) must have 0 chronicReads');
      assert.equal(s1.subagents.invocations.length, 0, 'Scenario 1 (Turn 1) must have 0 subagent invocations');

      const s4 = buildDemoHorizonState(4);
      assert.ok(s4.topRiskyCells.length >= 2, 'Scenario 4 (Bloated) must have risky cells');
      assert.ok(s4.chronicReads.length >= 1, 'Scenario 4 (Bloated) must have chronic reads');

      const s3 = buildDemoHorizonState(3);
      assert.equal(s3.subagents.count, 2, 'Scenario 3 (Swarm) must have count=2 subagents');
      assert.ok(s3.subagents.invocations.length >= 1, 'Scenario 3 (Swarm) must have subagent invocations');
    });

    it('renders non-zero Breakdown Useful % and Router recommendedAction / rewrite in horizon_panel.html', () => {
      const htmlPath = path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html');
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');
      const dom = new JSDOM(htmlContent, {
        url: 'http://127.0.0.1:62935/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
          w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
          w.EventSource = class { addEventListener() {} close() {} };
          w.navigator.clipboard = { writeText: async () => {} };
        }
      });
      try {
        const { window } = dom;
        const doc = window.document;
        const s6 = buildDemoHorizonState(6);
        window.renderState(s6);

        const usefulTxt = doc.getElementById('valUseful')?.textContent || '';
        assert.match(usefulTxt, /[1-9]\d*% of used/, `Scenario 6 Useful % should be > 0%, got "${usefulTxt}"`);

        const verdictTxt = doc.getElementById('unifiedVerdictText')?.textContent || '';
        assert.ok(
          verdictTxt.includes(s6.routerState),
          `unifiedVerdictText should include routerState ("${verdictTxt}")`
        );

        const simpleActionHtml = doc.getElementById('simpleActionableBox')?.textContent || '';
        assert.ok(
          simpleActionHtml.includes(s6.recommendedAction) || simpleActionHtml.includes(s6.rewrite),
          `simpleActionableBox should include router recommendedAction or rewrite ("${simpleActionHtml}")`
        );
      } finally {
        dom.window.close();
      }
    });
  });

  describe('Workstream 2: Empirical Benchmark Suite & Git Merge-Tree Mtime Cache', () => {
    it('verifies docs/composite_benchmark_results.json has non-tautological empirical scores and populated D5/D6 metrics', () => {
      const resultsPath = path.join(REPO_ROOT, 'docs', 'composite_benchmark_results.json');
      assert.ok(fs.existsSync(resultsPath), 'docs/composite_benchmark_results.json must exist');
      const report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

      assert.ok(report.compositeScore >= report.targetScore, 'Composite score must meet or exceed targetScore');
      for (const [dimKey, dim] of Object.entries(report.dimensions)) {
        assert.notEqual(
          dim.score,
          dim.target,
          `Dimension ${dimKey} score (${dim.score}) must be empirically computed, not hardcoded equal to target (${dim.target})`
        );
      }

      assert.ok(report.dimensions.D5.metrics.secretRedaction, 'D5 must include secretRedaction metrics');
      assert.ok(report.dimensions.D5.metrics.ipiAirlockScrub, 'D5 must include ipiAirlockScrub metrics');
      assert.ok(report.dimensions.D6.metrics.modLawsStaticAudit, 'D6 must include modLawsStaticAudit metrics');
      assert.ok(report.dimensions.D6.metrics.ustfValidation, 'D6 must include ustfValidation metrics');
      assert.ok(report.dimensions.D6.metrics.astStubPruningParity, 'D6 must include astStubPruningParity metrics');
    });

    it('caches probeGitMergeTree per .git/index + .git/HEAD mtime for sub-millisecond repeated polling', () => {
      clearGitMergeTreeCache();
      const first = probeGitMergeTree('HEAD', 'HEAD', { workspaceDir: REPO_ROOT });
      assert.equal(first.clean, true);
      assert.ok(!first.cached, 'First probeGitMergeTree call after cache clear should not be cached');

      const t0 = performance.now();
      const second = probeGitMergeTree('HEAD', 'HEAD', { workspaceDir: REPO_ROOT });
      const elapsedMs = performance.now() - t0;

      assert.equal(second.clean, true);
      assert.equal(second.cached, true, 'Second probeGitMergeTree call with unchanged .git/index mtime must hit cache');
      assert.ok(elapsedMs < 5, `Cached probeGitMergeTree should take < 5ms (took ${elapsedMs.toFixed(3)}ms)`);
    });
  });

  describe('Workstream 3: Brand Consolidation & 6 Core Auditable Guards Rollup', () => {
    it('exposes ah and attention-horizon CLI bin entries in package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
      assert.equal(pkg.bin.ah, './bin/ctxtop.mjs');
      assert.equal(pkg.bin['attention-horizon'], './bin/ctxtop.mjs');
      assert.equal(pkg.bin.ctxtop, './bin/ctxtop.mjs');
    });

    it('rolls up all 32 DET-01..32 detectors into exactly 6 Core Auditable Guards', () => {
      assert.equal(CORE_AUDITABLE_GUARDS.length, 6, 'Must define exactly 6 Core Auditable Guards');
      const coveredIds = new Set();
      for (const guard of CORE_AUDITABLE_GUARDS) {
        for (const detId of guard.detectorIds) {
          coveredIds.add(detId);
        }
      }
      assert.equal(coveredIds.size, 32, 'All 32 DET-01..32 detectors must map to the 6 Core Auditable Guards');
      for (const detId of Object.keys(DETECTOR_CATALOG)) {
        assert.ok(coveredIds.has(detId), `Detector ${detId} must be assigned to a Core Auditable Guard`);
      }

      const summary = summarizeCoreAuditableGuards('DET-01');
      assert.equal(summary.coreGuardCount, 6);
      assert.equal(summary.totalRuleCount, 32);
      assert.equal(summary.trippedGuard.id, 'GUARD-6');
    });
  });

  describe('Workstream 4: Automatic PreToolUse AST Signature Stub Interception', () => {
    it('auto-fetches an AST signature stub on the 3rd unclipped Read in Claude Code pre-tool-use handler', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-vc-ws4-cc-'));
      try {
        const sampleFile = path.join(tmpDir, 'sample_module.mjs');
        const bodyLines = Array.from({ length: 80 }, (_, idx) => `  const step${idx} = ${idx} * 2;`).join('\n');
        fs.writeFileSync(
          sampleFile,
          `export function computeHeavyMetrics(input, options = {}) {\n${bodyLines}\n  return input;\n}\n`,
          'utf8'
        );

        const sessionId = 'vc-ws4-cc-session';
        const r1 = runPreToolUseHook({ tool_name: 'Read', tool_input: { file_path: sampleFile }, session_id: sessionId }, { cwd: tmpDir });
        const r2 = runPreToolUseHook({ tool_name: 'Read', tool_input: { file_path: sampleFile }, session_id: sessionId }, { cwd: tmpDir });
        assert.equal(r1.astSignatureStub, undefined, '1st unclipped Read should not trigger AST stub');
        assert.equal(r2.astSignatureStub, undefined, '2nd unclipped Read should not trigger AST stub');

        const r3 = runPreToolUseHook(
          { tool_name: 'Read', tool_input: { file_path: sampleFile }, session_id: sessionId, priorUnclippedReads: 2 },
          { cwd: tmpDir }
        );
        assert.equal(r3.verdict.decision, 'allow');
        assert.ok(typeof r3.astSignatureStub === 'string' && r3.astSignatureStub.length > 0, '3rd unclipped Read must return astSignatureStub');
        assert.ok(r3.astSignatureStub.includes('computeHeavyMetrics'), 'AST stub must preserve exported function signature');
        assert.ok(r3.savedTokens > 0, '3rd unclipped Read must report positive savedTokens');

        const entries = readLedgerEntries({ cwd: tmpDir });
        const totalSaved = entries.reduce((acc, e) => acc + Number(e.savedTokens || 0), 0);
        assert.ok(totalSaved >= r3.savedTokens, 'Saved quota ledger must record BOUNDED_READ_ENFORCED savings');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('auto-fetches an AST signature stub on the 3rd unclipped read_file in Antigravity pre_invocation handler', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-vc-ws4-agy-'));
      try {
        const sampleFile = path.join(tmpDir, 'engine_service.mjs');
        const bodyLines = Array.from({ length: 80 }, (_, idx) => `  const val${idx} = ${idx} + 1;`).join('\n');
        fs.writeFileSync(
          sampleFile,
          `export async function runEngineService(payload) {\n${bodyLines}\n  return payload;\n}\n`,
          'utf8'
        );

        const convId = `vc-ws4-agy-${Date.now()}`;
        const r3 = await handlePreToolUse({
          conversationId: convId,
          workspacePath: tmpDir,
          toolName: 'read_file',
          toolInput: { Path: sampleFile },
          priorUnclippedReads: 2
        });

        assert.equal(r3.decision, 'allow');
        assert.ok(typeof r3.astSignatureStub === 'string' && r3.astSignatureStub.length > 0, 'Antigravity 3rd read_file must return astSignatureStub');
        assert.ok(r3.astSignatureStub.includes('runEngineService'), 'AST stub must preserve function signature');
        assert.ok(r3.savedTokens > 0, 'Must report positive savedTokens');
        assert.equal(fs.existsSync(path.join(tmpDir, '.claude')), false, 'Antigravity handlePreToolUse must never create .claude/cache in workspace');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Workstream 5: Three-Tier Self-Expensing PLG Funnel & CLI Subcommand', () => {
    it('defines PLG_TIER_MATRIX with Free ($0), Pro ($15), and Team ($39/seat) tiers and exposes ctxtop license tiers --json', async () => {
      assert.equal(PLG_TIER_MATRIX.free.priceMonthlyUSD, 0);
      assert.equal(PLG_TIER_MATRIX.pro.priceMonthlyUSD, 15);
      assert.equal(PLG_TIER_MATRIX.team.pricePerSeatMonthlyUSD, 39);

      const res = await runCli(['license', 'tiers', '--json']);
      assert.equal(res.exitCode, 0);
      const parsed = JSON.parse(res.output);
      assert.ok(parsed.free, 'JSON output must include free tier');
      assert.ok(parsed.pro, 'JSON output must include pro tier');
      assert.ok(parsed.team, 'JSON output must include team tier');
    });
  });
});
