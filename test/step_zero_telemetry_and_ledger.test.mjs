import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  LEDGER_BUCKETS,
  classifyLedgerBucket,
  recordTurnCacheSavings,
  recordInterventionSavings,
  computeExPostRealizedSavings,
  recordRealizedPromptBillSavings,
  getSavedQuotaReceiptSummary
} from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  computeUnifiedSavings,
  SAVINGS_EVENT_TYPES
} from '../src/core/coach/saved_quota_ledger.mjs';
import {
  getShieldStatus,
  loadShieldConfig
} from '../src/core/shield_manager.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use-core.mjs';
import { evaluateIdleTtlPreCompactGate } from '../src/core-isomorphic/coach/smartCompactAdvisor.mjs';
import { evaluateDet17AutoCompactionDeferral } from '../src/core-isomorphic/guards/det13_20_mcp_scope.mjs';
import { runCompactLifecycleHook } from '../hooks/handlers/compact-lifecycle.mjs';
import {
  readHighbeamHookStats,
  buildSettingsPayload,
  createEmptyWireObs,
  observeWireRequest,
  persistRunArtifacts,
  parseArgs,
  rmDirBestEffort,
  pruneOrphanWireLog
} from '../experiments/model-switch-benchmark/cost_per_task/run_highbeam_ab.mjs';

function rmSafe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (err) {
    if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
  }
}

test('SZ-1: 3-bucket savings ledger separates avoided_write, realized_prompt_bill, and platform_cache_discount without double-counting', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sz-ledger-'));
  try {
    const ledgerPath = path.join(tmpDir, '.claude', 'cache', 'horizon_ledger.jsonl');

    // 1. Bucket 1: real-time avoided writes (hook intervention + PostToolUse output compression with writeRateUSD)
    const inter = recordInterventionSavings(
      {
        sessionId: 'sess-sz',
        category: 'BOUNDED_READ_ENFORCED',
        modelId: 'claude-sonnet-5-5',
        savedTokens: 10_000,
        savedUSD: 0.02,
        writeRateUSD: 0.025,
        dedupeId: 'sz-read-1'
      },
      { cwd: tmpDir, ledgerPath }
    );
    assert.equal(inter.recorded, true);
    assert.equal(inter.receipt.ledgerBucket, LEDGER_BUCKETS.AVOIDED_WRITE);
    assert.equal(inter.receipt.writeRateUSD, 0.025);

    const bigLog = Array.from(
      { length: 80 },
      (_, i) => `[trace ${i}] ok status=PASS padding=${'a'.repeat(55)}`
    ).join('\n');
    const postRes = runPostToolUseHook(
      {
        session_id: 'sess-sz',
        cwd: tmpDir,
        tool_name: 'Bash',
        tool_input: { command: 'node check.mjs' },
        tool_response: { stdout: bigLog, stderr: '' },
        model: 'claude-sonnet-5-5'
      },
      { cwd: tmpDir, ledgerPath }
    );
    assert.equal(postRes.exitCode, 0);

    // 2. Bucket 3: platform KV-cache discount (kept strictly out of avoidedWrites & Shield ROI)
    const cacheRec = recordTurnCacheSavings(
      {
        sessionId: 'sess-sz',
        turnId: 'turn-cache-1',
        model: 'claude-sonnet-5-5',
        inputTokens: 500,
        cacheReadTokens: 100_000,
        outputTokens: 400
      },
      { cwd: tmpDir, ledgerPath }
    );
    assert.equal(cacheRec.recorded, true);
    assert.equal(cacheRec.receipt.ledgerBucket, LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT);

    // 3. Bucket 2: ex-post realized prompt-bill savings (including signed negative regression like T05)
    const exPostOk = computeExPostRealizedSavings({
      baselinePromptBillTokens: 400_000,
      actualPromptBillTokens: 280_000,
      baselineCostUSD: 0.30,
      actualCostUSD: 0.22,
      avoidedWriteTokens: 15_000,
      estimatedRealizedTokens: 105_000,
      estimatedRealizedUSD: 0.075,
      tolerancePct: 25
    });
    assert.equal(exPostOk.realizedPromptBillTokens, 120_000);
    assert.equal(exPostOk.realizedCostUSD, 0.08);
    assert.equal(exPostOk.withinTokenTolerance, true);
    assert.equal(exPostOk.withinUsdTolerance, true);

    const exPostRegress = recordRealizedPromptBillSavings(
      {
        sessionId: 'sess-sz',
        dedupeId: 'T05-regression',
        baselinePromptBillTokens: 300_000,
        actualPromptBillTokens: 325_000,
        baselineCostUSD: 0.21,
        actualCostUSD: 0.2472,
        avoidedWriteTokens: 6_000,
        estimatedRealizedTokens: 20_000,
        estimatedRealizedUSD: 0.02
      },
      { cwd: tmpDir, ledgerPath }
    );
    assert.equal(exPostRegress.recorded, true);
    assert.equal(exPostRegress.receipt.ledgerBucket, LEDGER_BUCKETS.REALIZED_PROMPT_BILL);
    assert.equal(exPostRegress.receipt.savedTokens, -25_000);
    assert.equal(exPostRegress.receipt.savedUSD, -0.0372);
    assert.equal(exPostRegress.exPost.withinTokenTolerance, false);
    assert.equal(exPostRegress.exPost.withinUsdTolerance, false);

    // Positive ex-post row
    recordRealizedPromptBillSavings(
      {
        sessionId: 'sess-sz',
        dedupeId: 'T01-gain',
        baselinePromptBillTokens: 360_000,
        actualPromptBillTokens: 260_000,
        baselineCostUSD: 0.28,
        actualCostUSD: 0.19,
        avoidedWriteTokens: 12_000,
        estimatedRealizedTokens: 110_000,
        estimatedRealizedUSD: 0.085
      },
      { cwd: tmpDir, ledgerPath }
    );

    const summary = getSavedQuotaReceiptSummary({
      cwd: tmpDir,
      ledgerPath,
      sessionId: 'sess-sz'
    });
    assert.equal(classifyLedgerBucket('REALIZED_PROMPT_BILL_SAVINGS'), LEDGER_BUCKETS.REALIZED_PROMPT_BILL);
    assert.equal(classifyLedgerBucket('CACHE_READ_DISCOUNT'), LEDGER_BUCKETS.PLATFORM_CACHE_DISCOUNT);
    assert.equal(classifyLedgerBucket('BOUNDED_READ_ENFORCED'), LEDGER_BUCKETS.AVOIDED_WRITE);

    // Ex-post signed delta = +100,000 - 25,000 = +75,000 tok and +$0.09 - $0.0372 = $0.0528
    assert.equal(summary.buckets.realizedPromptBill.tokens, 75_000);
    assert.equal(summary.buckets.realizedPromptBill.usd, 0.0528);
    assert.equal(summary.buckets.realizedPromptBill.count, 2);
    assert.equal(summary.buckets.realizedPromptBill.checkedToleranceCount, 2);
    assert.equal(summary.buckets.realizedPromptBill.withinToleranceCount, 1);

    // Avoided writes stay separate from platformCacheDiscount & realizedPromptBill
    assert.ok(summary.buckets.avoidedWrites.tokens >= 10_000);
    assert.ok(summary.buckets.avoidedWrites.writeRateUSD >= 0.025);
    assert.equal(summary.buckets.platformCacheDiscount.tokens, 100_000);
    assert.notEqual(summary.topHighbeamDriver.id, 'cacheReadDiscount');

    // Legacy totalSavedTokens MUST NOT double-count ex-post rows
    assert.equal(
      summary.totalSavedTokens,
      summary.buckets.avoidedWrites.tokens + summary.buckets.platformCacheDiscount.tokens
    );

    // Shield ROI must exclude platformCacheDiscount!
    const shieldStatus = getShieldStatus({ cwd: tmpDir, ledgerPath });
    assert.equal(shieldStatus.roi.tokensSaved, summary.buckets.avoidedWrites.tokens);
    assert.ok(shieldStatus.roi.tokensSaved < summary.totalSavedTokens);
    assert.ok(shieldStatus.roi.buckets?.avoidedWrites);

    // Unified SQLite/live savings exposes 3 buckets while preserving physicalTokensAvoided + billingEquivalentCacheTokens === totalTokens
    const unified = computeUnifiedSavings(
      {
        sessionId: 'sess-sz',
        model: { pricing: { inputPer1M: 2.0, readPer1M: 0.1 } },
        subagents: { invocations: [{ id: 's1', tokensSaved: 15_000 }] },
        quota: { cache: { cacheReadTokens: 80_000 } },
        savings: { realizedPromptBill: { tokens: 75_000, usd: 0.0528 } }
      },
      { sessionId: 'sess-sz' }
    );
    assert.equal(
      unified.session.physicalTokensAvoided + unified.session.billingEquivalentCacheTokens,
      unified.session.totalTokens
    );
    assert.equal(unified.session.buckets.avoidedWrites.tokens, 15_000);
    assert.equal(unified.session.buckets.realizedPromptBill.tokens, 75_000);
    assert.equal(unified.session.buckets.platformCacheDiscount.tokens, 76_000);
    assert.ok(unified.workspace30d.buckets);
  } finally {
    rmSafe(tmpDir);
  }
});

test('SZ-2: Cold-resume gate aligns with DET-17 (/handoff + /clear) and PreCompact falls back to live telemetry', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sz-det17-'));
  try {
    const det17 = evaluateDet17AutoCompactionDeferral({
      trigger: 'manual',
      cacheExpired: true,
      cachedTokens: 90_000
    });
    assert.equal(det17.triggered, true);
    assert.equal(det17.subType, 'COLD_CACHE_COMPACT_BLOCKED');

    const idleOnCompact = evaluateIdleTtlPreCompactGate({
      idleGapMs: 600_000,
      contextTokens: 90_000,
      modelId: 'claude-sonnet-5-5',
      promptText: '/compact'
    });
    assert.equal(idleOnCompact.shouldSuggest, true);
    assert.equal(idleOnCompact.coldCompactRedirect, true);
    assert.equal(idleOnCompact.recommendedAction, 'STATE_BATON_CLEAR');
    assert.ok(idleOnCompact.message.includes('Avoid /compact'));
    assert.ok(idleOnCompact.message.includes('/clear'));

    // PreCompact falls back to live telemetry when event omits cacheExpired/cachedTokens
    const preRes = runCompactLifecycleHook(
      { hook_event_name: 'PreCompact', trigger: 'manual', cwd: tmpDir },
      {
        cwd: tmpDir,
        telemetryState: {
          promptCache: { expired: true },
          contextWindow: { cachedTokens: 85_000 }
        }
      }
    );
    assert.equal(preRes.stdoutJson?.decision, 'block');
    assert.equal(preRes.result?.subType, 'COLD_CACHE_COMPACT_BLOCKED');
  } finally {
    rmSafe(tmpDir);
  }
});

test('SZ-3: A/B harness helpers count slice-clamps, configure HIGHBEAM_SHIELD_OFF, observe wire requests, and persist scrubbed artifacts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sz-ab-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const cfgDir = path.join(tmpDir, 'cfg');
    const homeDir = path.join(tmpDir, 'home');
    const rawDir = path.join(tmpDir, 'raw');
    fs.mkdirSync(path.join(repoDir, '.agents', 'telemetry'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.claude', 'cache'), { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    // Seed telemetry hints mimicking T03 (2 unsliced clamps + 1 explicit slice clamp + 1 oversized slice block)
    fs.writeFileSync(
      path.join(repoDir, '.agents', 'telemetry', 'sess1.hints.jsonl'),
      [
        JSON.stringify({ event: 'clamped_unsliced_read' }),
        JSON.stringify({ event: 'clamped_unsliced_read' }),
        JSON.stringify({ event: 'clamped_explicit_slice' }),
        JSON.stringify({ event: 'blocked_unsliced_read', trigger_reason: 'byte_width_cap' }),
        JSON.stringify({ event: 'blocked_oversized_slice' })
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, '.claude', 'cache', 'horizon_ledger.jsonl'),
      [
        JSON.stringify({
          sessionId: 'sess1',
          category: 'BOUNDED_READ_ENFORCED',
          ledgerBucket: 'avoided_write',
          savedTokens: 5000,
          savedUSD: 0.01,
          writeRateUSD: 0.0125
        }),
        JSON.stringify({
          sessionId: 'sess1',
          category: 'CACHE_READ_DISCOUNT',
          ledgerBucket: 'platform_cache_discount',
          savedTokens: 40000,
          savedUSD: 0.076
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const stats = readHighbeamHookStats(repoDir);
    assert.equal(stats.shieldClampsByteCap, 2);
    assert.equal(stats.shieldClampsExplicitSlice, 1);
    assert.equal(stats.shieldClampsTotal, 3);
    assert.equal(stats.shieldBlocksByteCap, 1);
    assert.equal(stats.shieldBlocksOversizedSlice, 1);
    assert.equal(stats.shieldBlocksTotal, 2);
    assert.equal(stats.ledgerBuckets.avoidedWriteTokens, 5000);
    assert.equal(stats.ledgerBuckets.platformCacheDiscountTokens, 40000);

    // HIGHBEAM_SHIELD_OFF disables Shield while preserving PreToolUse + PostToolUse hooks
    const shieldOffRepo = path.join(tmpDir, 'repo_shield_off');
    fs.mkdirSync(shieldOffRepo, { recursive: true });
    const shieldOffSettings = buildSettingsPayload('HIGHBEAM_SHIELD_OFF', shieldOffRepo);
    assert.equal(shieldOffSettings.hooks.PreToolUse.length, 1);
    assert.equal(shieldOffSettings.hooks.PostToolUse.length, 1);
    assert.equal(loadShieldConfig({ cwd: shieldOffRepo }).enabled, false);

    // observeWireRequest extracts spec/bash/post-edit counts cleanly
    const obs = createEmptyWireObs();
    observeWireRequest(
      obs,
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'docs/ARCHITECTURE_SPEC.md' } }]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'clamped spec excerpt' },
              { type: 'text', text: '[Highbeam Shield clamped wide unsliced Read to 120 lines]' }
            ]
          }
        ]
      },
      { phase: 'plan' }
    );
    observeWireRequest(
      obs,
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'docs/ARCHITECTURE_SPEC.md' } }]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'clamped spec excerpt' }]
          },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'node scripts/diag_check.mjs' } }]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'diag line 1\ndiag line 2' }]
          }
        ]
      },
      { phase: 'implement' }
    );
    assert.equal(obs.requests, 2);
    assert.equal(obs.specShieldClamped, true);
    assert.equal(obs.specReadResultChars, 'clamped spec excerpt'.length);
    assert.equal(obs.bashDiagResultChars, 'diag line 1\ndiag line 2'.length);
    assert.equal(obs.toolCallsByName.Read, 1);
    assert.equal(obs.toolCallsByName.Bash, 1);

    // persistRunArtifacts scrubs repoDir and writes transcripts + ledgers + hints
    fs.writeFileSync(
      path.join(cfgDir, 'sess.jsonl'),
      JSON.stringify({ msg: `read ${repoDir.replace(/\\/g, '/')}/src/tierEngine.mjs` }) + '\n',
      'utf8'
    );
    const arts = persistRunArtifacts({
      rawDir,
      spec: { run_id: 'T03_HIGHBEAM_test' },
      repoDir,
      cfgDir,
      homeDir
    });
    assert.equal(arts.transcriptPath, 'transcripts/T03_HIGHBEAM_test.jsonl');
    assert.equal(arts.ledgerPath, 'ledgers/T03_HIGHBEAM_test.ledger.jsonl');
    assert.equal(arts.hintsPath, 'telemetry/T03_HIGHBEAM_test.hints.jsonl');
    const savedTx = fs.readFileSync(path.join(rawDir, arts.transcriptPath), 'utf8');
    assert.ok(savedTx.includes('<REPO_DIR>/src/tierEngine.mjs'));

    // parseArgs supports --arms and --reps
    const parsedFlags = parseArgs(['--arms', 'BASELINE,HIGHBEAM_SHIELD_OFF', '--reps', '3', '--tasks', 'T05,T06']);
    assert.deepEqual(parsedFlags.arms, ['BASELINE', 'HIGHBEAM_SHIELD_OFF']);
    assert.equal(parsedFlags.reps, 3);
    assert.deepEqual(parsedFlags.tasks, ['T05', 'T06']);

    // rmDirBestEffort & pruneOrphanWireLog handle resume recovery safely
    const tempRmTarget = path.join(tmpDir, 'ephemeral_cleanup');
    fs.mkdirSync(path.join(tempRmTarget, 'sub'), { recursive: true });
    assert.equal(rmDirBestEffort(tempRmTarget, { label: 'test' }), true);
    assert.equal(fs.existsSync(tempRmTarget), false);
    assert.equal(rmDirBestEffort(tempRmTarget, { label: 'nonexistent' }), true);

    const mockWirePath = path.join(rawDir, 'proxy_wire_log.jsonl');
    fs.writeFileSync(
      mockWirePath,
      [
        JSON.stringify({ wireSeq: 1, context: { runId: 'T07_HIGHBEAM_SHIELD_OFF_r2_live' }, billedCostUsd: 0.32 }),
        JSON.stringify({ wireSeq: 2, context: { runId: 'T07_HIGHBEAM_r2_live' }, billedCostUsd: 0.26 }),
        JSON.stringify({ wireSeq: 3, context: { runId: 'T07_HIGHBEAM_r2_live' }, billedCostUsd: 0.01 })
      ].join('\n') + '\n',
      'utf8'
    );
    const pruneRes = pruneOrphanWireLog(mockWirePath, new Set(['T07_HIGHBEAM_SHIELD_OFF_r2_live']));
    assert.equal(pruneRes.kept, 1);
    assert.equal(pruneRes.pruned, 2);
    const remainingWire = fs.readFileSync(mockWirePath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(remainingWire.length, 1);
    assert.equal(remainingWire[0].context.runId, 'T07_HIGHBEAM_SHIELD_OFF_r2_live');
  } finally {
    rmSafe(tmpDir);
  }
});
