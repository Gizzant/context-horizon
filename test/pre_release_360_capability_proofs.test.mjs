import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SavedQuotaReceiptLedger,
  SAVINGS_EVENT_TYPES,
  computeUnifiedSavings
} from '../src/core/coach/saved_quota_ledger.mjs';
import {
  recordTurnCacheSavings,
  recordInterventionSavings,
  getSavedQuotaReceiptSummary
} from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { compressCliOutputFts5 } from '../src/core/fts5_output_compressor.mjs';
import { PrefixCacheShield } from '../src/core/prefix_cache_shield.mjs';
import { generateCorporateExpenseReceipt } from '../src/core-isomorphic/ui/pdfReceiptGenerator.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Pre-Release 360° Capability Proofs — Dual-Host Parity, External-CWD Execution & Actuarial Math', () => {
  it('Proof 1: Google Antigravity and Claude Code manifests expose 6-for-6 core skill/command parity', () => {
    const agyRootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
    const agyDotManifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.antigravity-plugin', 'plugin.json'), 'utf8'));
    const claudeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

    assert.deepEqual(agyRootManifest.skills, agyDotManifest.skills, 'Root plugin.json and .antigravity-plugin/plugin.json skills must match');

    const expectedCoreSlugs = ['horizon', 'precheck', 'handoff', 'cost-radar', 'inspect', 'evolve'];
    for (const slug of expectedCoreSlugs) {
      assert.ok(
        agyRootManifest.skills.includes(`./skills/${slug}`),
        `Antigravity plugin.json must register ./skills/${slug}`
      );
      assert.ok(
        fs.existsSync(path.join(ROOT, 'skills', slug, 'SKILL.md')),
        `Skill file skills/${slug}/SKILL.md must exist on disk`
      );
      assert.ok(
        claudeManifest.commands.includes(`./commands/${slug}.md`),
        `Claude Code .claude-plugin/plugin.json must register ./commands/${slug}.md`
      );
      assert.ok(
        fs.existsSync(path.join(ROOT, 'commands', `${slug}.md`)),
        `Command file commands/${slug}.md must exist on disk`
      );
    }
  });

  it('Proof 2: External-CWD execution works cleanly across both Google Antigravity and Claude Code hooks/CLIs', () => {
    const extWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ext-cwd-proof-'));
    try {
      const sampleFile = path.join(extWorkspace, 'service.mjs');
      const lines = Array.from({ length: 80 }, (_, i) => `export function fn${i}(x) { return x + ${i}; }`);
      fs.writeFileSync(sampleFile, lines.join('\n') + '\n', 'utf8');

      // 1. Claude Code statusline CLI executed with cwd = extWorkspace
      const statusOut = execFileSync(
        process.execPath,
        [path.join(ROOT, 'bin', 'ah-statusline.mjs'), '--demo', '--columns', '110'],
        { cwd: extWorkspace, encoding: 'utf8' }
      );
      assert.match(statusOut, /AH \[/, 'Claude ah-statusline must render cleanly from external CWD');
      assert.match(statusOut, /Saved \$/, 'Claude ah-statusline must display Saved USD');

      // 2. Claude Code PreToolUse & PostToolUse handlers executed against external workspace
      const ccPre1 = runPreToolUseHook(
        { session_id: 'proof-cc-1', cwd: extWorkspace, tool_name: 'Read', tool_input: { file_path: sampleFile } },
        { cwd: extWorkspace }
      );
      assert.equal(ccPre1.exitCode, 0);

      const noisyStdout = Array.from({ length: 220 }, (_, i) =>
        i === 15
          ? '\x1b[31mERROR: TypeError at service.mjs:42:11\x1b[0m'
          : '\x1b[32mDownloading dependencies... [====================] 100%\r\x1b[0m'
      ).join('\n');
      const ccPost = runPostToolUseHook(
        {
          session_id: 'proof-cc-1',
          cwd: extWorkspace,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: noisyStdout, exit_code: 1 }
        },
        { cwd: extWorkspace }
      );
      assert.equal(ccPost.exitCode, 0);
      assert.equal(ccPost.sanitized.sanitized, true, 'Claude PostToolUse must sanitize verbose output');
      assert.ok(ccPost.sanitized.savedTokens > 0, 'Claude PostToolUse must record positive savedTokens');

      // 3. Antigravity hook scripts spawned from external CWD
      const agyStartOut = execFileSync(
        process.execPath,
        [path.join(ROOT, 'hooks', 'session_start.mjs')],
        {
          cwd: extWorkspace,
          input: JSON.stringify({ conversationId: 'proof-agy-1', cwd: extWorkspace }),
          encoding: 'utf8'
        }
      );
      assert.doesNotThrow(() => JSON.parse(agyStartOut.trim()), 'Antigravity session_start.mjs must return valid JSON from external CWD');

      const agyPreToolOut = execFileSync(
        process.execPath,
        [path.join(ROOT, 'hooks', 'pre_tool_use.mjs')],
        {
          cwd: extWorkspace,
          input: JSON.stringify({
            conversationId: 'proof-agy-1',
            cwd: extWorkspace,
            toolName: 'read_file',
            toolArgs: { Path: sampleFile, StartLine: 1, EndLine: 50 }
          }),
          encoding: 'utf8'
        }
      );
      const parsedAgyPre = JSON.parse(agyPreToolOut.trim());
      assert.equal(parsedAgyPre.decision, 'allow', 'Bounded read_file must be allowed by Antigravity pre_tool_use.mjs');
    } finally {
      try {
        fs.rmSync(extWorkspace, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  });

  it('Proof 3: Actuarial "Tokens Saved" zero-inflation, idempotency, 10-event conservation, and model-rate fidelity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-actuarial-proof-'));
    try {
      const sqlitePath = path.join(tmpDir, 'saved_quota_ledger.sqlite');
      const jsonlPath = path.join(tmpDir, 'horizon_ledger.jsonl');
      const ftsDbPath = path.join(tmpDir, 'tool_logs_fts5.db');
      const queuePath = path.join(tmpDir, 'pending_rule_deltas.json');

      // 1. Cold-boot zero-inflation invariant across both ledgers
      const agyLedger = new SavedQuotaReceiptLedger({ dbPath: sqlitePath });
      const coldUnified = computeUnifiedSavings({ sessionId: 'cold-sess' }, { ledger: agyLedger, sessionId: 'cold-sess' });
      assert.equal(coldUnified.session.totalTokens, 0, 'Antigravity cold session must start at 0 tokens');
      assert.equal(coldUnified.session.estimatedUsd, 0, 'Antigravity cold session must start at $0.00');
      assert.equal(coldUnified.session.formattedUsd, '$0.00');

      const ccCold = getSavedQuotaReceiptSummary({ ledgerPath: jsonlPath, sessionId: 'cold-sess' });
      assert.equal(ccCold.totalSavedTokens, 0, 'Claude Code cold ledger must start at 0 tokens');
      assert.equal(ccCold.totalSavedUSD, 0, 'Claude Code cold ledger must start at $0.00');

      // 2. Deduplication idempotency across 10 repeated submissions of the same dedupeKey / turnId
      for (let i = 0; i < 10; i++) {
        agyLedger.recordSaving({
          sessionId: 'sess-actuarial',
          eventType: SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED,
          tokensSaved: 12000,
          inputPricePer1M: 3.0,
          dedupeKey: 'det06-turn-4',
          detail: 'Blocked duplicate full-file read'
        });
        recordTurnCacheSavings(
          {
            sessionId: 'sess-actuarial',
            turnId: 'cc-turn-4',
            model: 'claude-sonnet-4-6',
            inputTokens: 10000,
            cacheReadTokens: 100000,
            outputTokens: 1000
          },
          { ledgerPath: jsonlPath }
        );
        recordInterventionSavings(
          {
            sessionId: 'sess-actuarial',
            category: 'DET_06_LOOP_BREAKER',
            modelId: 'claude-sonnet-4-6',
            savedTokens: 12000,
            dedupeId: 'det06-turn-4'
          },
          { ledgerPath: jsonlPath }
        );
      }

      assert.equal(
        agyLedger.getSummary('sess-actuarial').totalsByType.LOOP_TURN_PREVENTED,
        12000,
        'Antigravity SQLite ledger must record deduplicated event strictly once across 10 retries'
      );
      const ccAfter10 = getSavedQuotaReceiptSummary({ ledgerPath: jsonlPath, sessionId: 'sess-actuarial' });
      assert.equal(ccAfter10.entryCount, 2, 'Claude JSONL ledger must record turn cache + intervention strictly once across 10 retries');

      // 3. Record prompt hygiene & sightseeing events + FTS5 CLI compression + PrefixCacheShield deferral
      agyLedger.recordSaving({
        sessionId: 'sess-actuarial',
        eventType: SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_STEERED,
        tokensSaved: 3500,
        inputPricePer1M: 3.0,
        dedupeKey: 'hygiene-1'
      });
      agyLedger.recordSaving({
        sessionId: 'sess-actuarial',
        eventType: SAVINGS_EVENT_TYPES.SIGHTSEEING_TOOL_PREVENTED,
        tokensSaved: 4500,
        inputPricePer1M: 3.0,
        dedupeKey: 'sightseeing-1'
      });

      const verboseLog = Array.from({ length: 140 }, (_, i) =>
        i === 5 ? 'FAIL src/auth.js:19:4 Expected token to be valid' : `stdout log line ${i} with routine test output`
      ).join('\n');
      const ftsRes = await compressCliOutputFts5({
        sessionId: 'sess-actuarial',
        turnId: 'turn-5',
        command: 'npm test',
        exitCode: 1,
        rawOutput: verboseLog,
        dbPath: ftsDbPath
      });
      assert.equal(ftsRes.compressed, true);

      const shield = new PrefixCacheShield({ queuePath });
      shield.stageOrApplyDelta(
        { targetPath: path.join(tmpDir, 'AGENTS.md'), newContent: '# Updated rule\n' },
        { sessionId: 'sess-actuarial', cacheWarm: true, cachedTokens: 60000, cacheTtlSeconds: 180 }
      );

      // Prior session recorded at higher Opus/Fable rate ($8.00/1M) for 50,000 tokens = $0.40
      agyLedger.recordSaving({
        sessionId: 'sess-opus-prior',
        eventType: SAVINGS_EVENT_TYPES.SUBAGENT_ISOLATED,
        tokensSaved: 50000,
        inputPricePer1M: 8.0,
        dedupeKey: 'opus-sub-1'
      });

      // Evaluate unified savings with Sonnet 4.6 pricing ($3.00 input, $0.30 read -> 90% cache discount ratio)
      const unified = computeUnifiedSavings(
        {
          sessionId: 'sess-actuarial',
          model: { pricing: { inputPer1M: 3.0, readPer1M: 0.3 } },
          subagents: { invocations: [{ id: 'sub-1', tokensSaved: 20000 }, { id: 'sub-1', tokensSaved: 20000 }] },
          quota: { cache: { cacheReadTokens: 100000 } },
          coachState: { fts5Compressor: { savedTokens: ftsRes.tokensSaved } }
        },
        { ledger: agyLedger, sessionId: 'sess-actuarial' }
      );

      // Verify subagent deduplication (20,000, not 40,000)
      assert.equal(unified.session.bySource.subagentIsolated, 20000);
      // Verify 90% model-specific cache discount (100,000 * 0.90 = 90,000) + 60,000 cold prefill avoided = 150,000
      assert.equal(unified.session.cacheDiscountRatio, 0.9);
      assert.equal(unified.session.billingEquivalentCacheTokens, 90000);
      assert.equal(unified.session.bySource.cachePreserved, 90000 + 60000);
      // Verify prompt hygiene + loop turn prevented are summed in guardsPrevented (12,000 + 3,500 + 4,500 = 20,000)
      assert.equal(unified.session.bySource.guardsPrevented, 20000);

      // Verify exact additive conservation across the 4 unified sources
      const sumOfSources =
        unified.session.bySource.subagentIsolated +
        unified.session.bySource.cachePreserved +
        unified.session.bySource.cliCompressed +
        unified.session.bySource.avoidedBloat;
      assert.equal(
        unified.session.totalTokens,
        sumOfSources,
        'Session totalTokens must equal exact sum of subagentIsolated + cachePreserved + cliCompressed + avoidedBloat'
      );

      // Verify physical vs billing-equivalent decomposition adds up to totalTokens
      assert.equal(
        unified.session.physicalTokensAvoided + unified.session.billingEquivalentCacheTokens,
        unified.session.totalTokens,
        'physicalTokensAvoided + billingEquivalentCacheTokens must equal session.totalTokens'
      );

      // Verify multi-model 30-day workspace USD honors prior $8/1M session ($0.40) + current session USD
      assert.ok(
        unified.workspace30d.estimatedUsd >= Number((unified.session.estimatedUsd + 0.4).toFixed(4)),
        'workspace30d.estimatedUsd must preserve higher historical model USD rates'
      );

      // Verify Corporate Expense Receipt (PDF 1.4 + Markdown + HTML) includes both FinOps ROI and GreenOps Scope 3 energy metrics
      const corpReceipt = generateCorporateExpenseReceipt({
        sessionSavedTokens: unified.session.totalTokens,
        sessionSavedUSD: unified.session.estimatedUsd,
        workspace30dSavedTokens: 1000000,
        workspace30dSavedUSD: 45.0
      });
      assert.equal(corpReceipt.netRoiMultiplier, 3.0);
      assert.equal(corpReceipt.estimatedGpuWhSaved, 650);
      assert.equal(corpReceipt.estimatedCo2GramsSaved, 247);
      assert.match(corpReceipt.markdown, /GreenOps Compute Energy Avoided/);
      assert.match(corpReceipt.html, /GreenOps Energy Avoided/);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  });
});
