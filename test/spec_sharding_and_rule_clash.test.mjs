/**
 * @file test/spec_sharding_and_rule_clash.test.mjs
 * Contract & Adversarial Tests for:
 *   1. Cross-Turn Sharded Spec Detector (`SHARDED_SPEC_DRIFT`) & `ctxtop handoff --consolidate`
 *   2. Deterministic RSL Rule Clash Auditor (`RULE_CONFLICT`) & Quarantine
 *   3. One-Shot Dual-Platform Turn-1 Contract Gate (`[CTX_CONTRACT]`)
 *   4. `<10ms` deterministic evaluator performance budget
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  evaluateShardedSpecDrift,
  evaluateTurn1ContractGate
} from '../src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs';
import {
  detectRuleClashes,
  auditWorkspaceRuleClashes
} from '../src/core/rsl_clash_auditor.mjs';
import {
  ingestDistilledHeuristics,
  readRslLedger,
  getRslSummary
} from '../src/core/rsl_ledger.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { runUserPromptSubmitHook } from '../hooks/handlers/user-prompt-submit.mjs';
import { createDefaultSidecar, getSidecarPath, writeSidecarAtomicSync } from '../src/core/sidecar_store.mjs';
import { runCli } from '../bin/ctxtop.mjs';
import { formatRslStatusSegment } from '../src/core-isomorphic/ui/modViews.mjs';

function makeTempDir(prefix = 'ctxtop-sharding-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedAntigravitySidecar(convId, tmpDir, totalInputTokens = 28000) {
  const sc = createDefaultSidecar(convId, tmpDir);
  sc.sessionMeta.activeModel = 'gemini-4-argon';
  sc.sessionMeta.activeEffort = 'high';
  sc.telemetry.totalInputTokens = totalInputTokens;
  sc.telemetry.confidence = 'HIGH';
  writeSidecarAtomicSync(convId, sc);
  return getSidecarPath(convId);
}

describe('Spec Sharding Consolidator, Rule Clash Auditor & Turn-1 Contract Gate', () => {
  it('1. Detects 4+ requirement-mutating shards at >=25k tokens on both platforms while ignoring stack traces, trivial test runs, low tokens & cooldown', async () => {
    const tmpDir = makeTempDir('ctxtop-shards-');
    const convId = `ag-shard-${Date.now()}`;
    const scPath = seedAntigravitySidecar(convId, tmpDir, 28000);

    try {
      // Turn 1 sets initialGoal cleanly without Turn-1 contract trigger because target path + test verification are explicit
      const ag1 = await handlePreInvocation({
        conversationId: convId,
        cwd: tmpDir,
        prompt: 'Implement src/importer.mjs with strict schema validation and run tests.'
      });
      assert.notEqual(ag1.subType, 'SHARDED_SPEC_DRIFT');

      // Non-shard noise: stack trace & trivial test command must not accumulate shards
      await handlePreInvocation({
        conversationId: convId,
        cwd: tmpDir,
        prompt: 'TypeError: Cannot read properties\n    at parseRow (src/importer.mjs:42:10)\n    at main (src/cli.mjs:8:3)'
      });
      await handlePreInvocation({
        conversationId: convId,
        cwd: tmpDir,
        prompt: 'also run npm test'
      });

      await handlePreInvocation({ conversationId: convId, cwd: tmpDir, prompt: 'also support CSV export' });
      await handlePreInvocation({ conversationId: convId, cwd: tmpDir, prompt: 'actually change output format to NDJSON' });
      const ag4 = await handlePreInvocation({ conversationId: convId, cwd: tmpDir, prompt: 'make sure we reject empty payloads' });
      assert.notEqual(ag4.subType, 'SHARDED_SPEC_DRIFT', '3 shards must not trigger threshold of 4');

      // 4th real shard crosses threshold at 28k tokens
      const ag5 = await handlePreInvocation({
        conversationId: convId,
        cwd: tmpDir,
        prompt: "don't forget to enforce UTF-8 BOM"
      });
      assert.equal(ag5.subType, 'SHARDED_SPEC_DRIFT');
      assert.equal(ag5.shardCount, 4);
      assert.match(ag5.systemMessage, /\[CTX_HINT: SHARDED_SPEC/);

      // Cooldown suppression within 3 turns
      const agCooldown = await handlePreInvocation({
        conversationId: convId,
        cwd: tmpDir,
        prompt: 'one more constraint disallow nulls in output'
      });
      assert.notEqual(agCooldown.subType, 'SHARDED_SPEC_DRIFT', 'Must suppress inside 3-turn cooldown');

      // Below 25k tokens never triggers
      const lowTok = evaluateShardedSpecDrift({
        prompt: "don't forget to enforce UTF-8 BOM",
        priorShards: [
          { turn: 2, excerpt: 'also support CSV export' },
          { turn: 3, excerpt: 'actually change output format to NDJSON' },
          { turn: 4, excerpt: 'make sure we reject empty payloads' }
        ],
        totalTokens: 12000,
        turnNumber: 5
      });
      assert.equal(lowTok.triggered, false);

      // Claude Code UserPromptSubmit parity
      const ccSess = `cc-shard-${Date.now()}`;
      runUserPromptSubmitHook(
        {
          session_id: ccSess,
          cwd: tmpDir,
          totalTokens: 28000,
          prompt: 'Implement src/exporter.mjs with strict schema validation and run tests.'
        },
        { persistState: true }
      );
      for (const p of [
        'also support CSV export',
        'actually change output format to NDJSON',
        'make sure we reject empty payloads'
      ]) {
        const res = runUserPromptSubmitHook(
          { session_id: ccSess, cwd: tmpDir, totalTokens: 28000, prompt: p },
          { persistState: true }
        );
        assert.notEqual(res.verdict?.subType, 'SHARDED_SPEC_DRIFT');
      }
      const cc5 = runUserPromptSubmitHook(
        { session_id: ccSess, cwd: tmpDir, totalTokens: 28000, prompt: "don't forget to enforce UTF-8 BOM" },
        { persistState: true }
      );
      assert.equal(cc5.verdict?.subType, 'SHARDED_SPEC_DRIFT');
      assert.match(cc5.stdoutJson?.hookSpecificOutput?.additionalContext || '', /\[CTX_HINT: SHARDED_SPEC/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(scPath)) fs.rmSync(scPath, { force: true });
    }
  });

  it('2. Consolidates Turn-1 goal, constraint shards & diff via `ctxtop handoff --consolidate --json` and formats statusLine clashes', () => {
    const tmpDir = makeTempDir('ctxtop-handoff-');
    try {
      const ccSess = `cc-consolidate-${Date.now()}`;
      runUserPromptSubmitHook(
        {
          session_id: ccSess,
          cwd: tmpDir,
          totalTokens: 28000,
          prompt: 'Implement src/exporter.mjs with deterministic CSV streaming and run tests.'
        },
        { persistState: true }
      );
      for (const p of [
        'also support CSV export',
        'actually change output format to NDJSON',
        'make sure we reject empty payloads',
        "don't forget to enforce UTF-8 BOM"
      ]) {
        runUserPromptSubmitHook(
          { session_id: ccSess, cwd: tmpDir, totalTokens: 28000, prompt: p },
          { persistState: true }
        );
      }

      const cliRes = runCli(['handoff', '--consolidate', '--cwd', tmpDir, '--write', '--json']);
      assert.equal(cliRes.exitCode, 0);
      assert.equal(cliRes.data.ok, true);
      assert.ok(cliRes.data.shardCount >= 4);
      assert.match(cliRes.data.consolidatedMarkdown, /deterministic CSV streaming/i);
      assert.match(cliRes.data.consolidatedMarkdown, /UTF-8 BOM/);
      assert.equal(fs.existsSync(cliRes.data.outputPath), true);

      const seg = formatRslStatusSegment({ activeRules: 2, ruleBudgetTokens: 1200, clashCount: 1 });
      assert.equal(seg, 'RSL: 2 rules | Budget: 1.2k/20k | 1 clash!');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Flags opposite-polarity rule clashes, quarantines conflicting RSL compilation, and avoids false positives', () => {
    const tmpDir = makeTempDir('ctxtop-clash-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'AGENTS.md'),
        '# Workspace Rules\n\n- Never pass `SQLITE_OPEN_READWRITE` when opening telemetry DBs.\n',
        'utf8'
      );

      // True clash: candidate rule contradicts AGENTS.md on overlapping scope + SQLITE_OPEN_READWRITE
      const ingestRes = ingestDistilledHeuristics(
        tmpDir,
        {
          heuristics: [
            {
              slug: 'session-db-readwrite',
              carrier: 'rule_glob',
              globs: '*.mjs',
              when_condition: 'When opening session DBs in telemetry hooks',
              then_guidance: 'Always require `SQLITE_OPEN_READWRITE` on session DBs.'
            }
          ]
        },
        { sessionId: 'sess-clash', platform: 'antigravity', touchedFiles: ['src/db.mjs'] }
      );
      assert.ok(ingestRes.quarantined.includes('session-db-readwrite'));
      assert.equal(fs.existsSync(path.join(tmpDir, '.agents', 'rules', 'rsl-session-db-readwrite.md')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'rsl-session-db-readwrite.md')), false);

      const ledger = readRslLedger(tmpDir);
      assert.equal(ledger.items['session-db-readwrite']?.status, 'quarantined_conflict');
      const summary = getRslSummary(tmpDir);
      assert.ok(summary.clashCount >= 1);
      assert.equal(summary.quarantinedCount, 1);

      // Dual-compiled compatible rule must NOT self-clash between .agents/rules/ and .claude/rules/
      const okIngest = ingestDistilledHeuristics(
        tmpDir,
        {
          heuristics: [
            {
              slug: 'atomic-json-writes',
              carrier: 'rule_glob',
              globs: '*.mjs',
              when_condition: 'When persisting JSON telemetry snapshots',
              then_guidance: 'Always use `atomicWriteFileSync` for sidecar updates.'
            }
          ]
        },
        { sessionId: 'sess-ok', platform: 'claude', touchedFiles: ['src/store.mjs'] }
      );
      assert.ok(okIngest.added.includes('atomic-json-writes'));
      assert.equal(auditWorkspaceRuleClashes(tmpDir).clashCount, 0);

      // Benign non-clashes: distinct anchors (`var` vs `const`), disjoint env (`integration` vs `unit`), disjoint globs (`*.py` vs `*.ts`)
      const benign = detectRuleClashes([
        { source: 'rule-var', slug: 'rule-var', scopeType: 'always_on', content: '- Never use `var` declarations.' },
        { source: 'rule-const', slug: 'rule-const', scopeType: 'always_on', content: '- Always use `const` declarations.' },
        { source: 'rule-int', slug: 'rule-int', scopeType: 'always_on', content: '- Never mock `db` in integration tests.' },
        { source: 'rule-unit', slug: 'rule-unit', scopeType: 'always_on', content: '- Always mock `db` in unit tests.' },
        { source: 'rule-py', slug: 'rule-py', scopeType: 'glob', globs: ['*.py'], content: '---\ntrigger: glob\nglobs: "*.py"\n---\nNever use `eval`.' },
        { source: 'rule-ts', slug: 'rule-ts', scopeType: 'glob', globs: ['*.ts'], content: '---\ntrigger: glob\nglobs: "*.ts"\n---\nAlways allow `eval`.' }
      ]);
      assert.equal(benign.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. Injects Turn-1 [CTX_CONTRACT] once on unanchored multi-file build prompts across both platforms and skips exemptions', async () => {
    const tmpDir = makeTempDir('ctxtop-turn1-');
    const convMain = `ag-t1-main-${Date.now()}`;
    const convPlan = `ag-t1-plan-${Date.now()}`;
    const convQ = `ag-t1-q-${Date.now()}`;
    const convFile = `ag-t1-file-${Date.now()}`;
    const pathsToClean = [
      seedAntigravitySidecar(convMain, tmpDir, 1000),
      seedAntigravitySidecar(convPlan, tmpDir, 1000),
      seedAntigravitySidecar(convQ, tmpDir, 1000),
      seedAntigravitySidecar(convFile, tmpDir, 1000)
    ];

    try {
      const prompt = 'Build a webhook retry queue with exponential backoff for failed events';

      // Antigravity Turn 1 triggers
      const ag1 = await handlePreInvocation({ conversationId: convMain, cwd: tmpDir, prompt });
      assert.equal(ag1.subType, 'TURN1_CONTRACT_GATE');
      assert.match(ag1.systemMessage, /\[CTX_CONTRACT:/);

      // Antigravity Turn 2 (alreadyInjected / turnNumber > 1) and invocationNum > 1 must not re-fire
      const ag2 = await handlePreInvocation({ conversationId: convMain, cwd: tmpDir, prompt });
      assert.notEqual(ag2.subType, 'TURN1_CONTRACT_GATE');
      assert.equal(
        evaluateTurn1ContractGate({ prompt, invocationNum: 2 }).triggered,
        false
      );

      // Antigravity exemptions: Plan Mode, questions, slash commands, @file-anchored prompt
      const agPlan = await handlePreInvocation({ conversationId: convPlan, cwd: tmpDir, inPlanMode: true, prompt });
      const agQ = await handlePreInvocation({ conversationId: convQ, cwd: tmpDir, prompt: 'How does webhook exponential retry backoff work?' });
      const agFile = await handlePreInvocation({ conversationId: convFile, cwd: tmpDir, prompt: 'Build webhook retry queue in @src/worker.mjs' });
      assert.notEqual(agPlan.subType, 'TURN1_CONTRACT_GATE');
      assert.notEqual(agQ.subType, 'TURN1_CONTRACT_GATE');
      assert.notEqual(agFile.subType, 'TURN1_CONTRACT_GATE');
      assert.equal(evaluateTurn1ContractGate({ prompt: '/plan build retry queue' }).triggered, false);

      // Claude Code UserPromptSubmit parity
      const ccSess = `cc-t1-${Date.now()}`;
      const cc1 = runUserPromptSubmitHook({ session_id: ccSess, cwd: tmpDir, prompt }, { persistState: true });
      assert.equal(cc1.verdict?.subType, 'TURN1_CONTRACT_GATE');
      assert.match(cc1.stdoutJson?.hookSpecificOutput?.additionalContext || '', /\[CTX_CONTRACT:/);

      const cc2 = runUserPromptSubmitHook({ session_id: ccSess, cwd: tmpDir, prompt }, { persistState: true });
      assert.notEqual(cc2.verdict?.subType, 'TURN1_CONTRACT_GATE');

      const ccPlan = runUserPromptSubmitHook(
        { session_id: `${ccSess}-plan`, cwd: tmpDir, permission_mode: 'plan', prompt },
        { persistState: true }
      );
      assert.notEqual(ccPlan.verdict?.subType, 'TURN1_CONTRACT_GATE');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const p of pathsToClean) {
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    }
  });

  it('5. Completes deterministic evaluators within <10ms budget', () => {
    const tmpDir = makeTempDir('ctxtop-perf-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '- Never use `SQLITE_OPEN_READWRITE`.\n', 'utf8');
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) {
        evaluateShardedSpecDrift({
          prompt: 'also support CSV export',
          priorShards: [{ turn: 2, excerpt: 'a' }, { turn: 3, excerpt: 'b' }, { turn: 4, excerpt: 'c' }],
          totalTokens: 30000,
          turnNumber: 5
        });
        evaluateTurn1ContractGate({ prompt: 'Build a webhook retry queue with exponential backoff for failed events' });
        auditWorkspaceRuleClashes(tmpDir);
      }
      const perIterMs = (performance.now() - t0) / 50;
      assert.ok(perIterMs < 10, `Expected <10ms per evaluation bundle, got ${perIterMs.toFixed(2)}ms`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
