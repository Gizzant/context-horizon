import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  MODEL_B_CLI,
  EFFORT_BASELINE,
  loadOpenRouterApiKey
} from './config.mjs';
import { startProxyServer } from './proxy_recorder.mjs';
import {
  buildScripted30TurnPlan,
  fetchOpenRouterKeyUsage,
  runSinglePhase2Session
} from './run_smart_compact_pilot.mjs';

const RESULTS_ROOT = path.join(EXPERIMENT_DIR, 'results');
const SMART_COMPACT_DIR = path.join(RESULTS_ROOT, 'smart_compact');
const RAW_DIR = path.join(SMART_COMPACT_DIR, 'raw');
const TRANSCRIPTS_DIR = path.join(RAW_DIR, 'transcripts');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function fetchOpenRouterCredits(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/credits',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const totalCredits = Number(parsed?.data?.total_credits ?? 0);
            const totalUsage = Number(parsed?.data?.total_usage ?? 0);
            resolve({
              timestamp: new Date().toISOString(),
              statusCode: res.statusCode,
              totalCredits,
              totalUsage,
              availableBalance: Number((totalCredits - totalUsage).toFixed(6))
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function summarizeRunFromWireAndTranscript({
  runId,
  arm,
  rep,
  autoMemoryEnabled,
  wireLogPath,
  transcriptPath,
  outcomes,
  boundaryRows,
  keyBeforeRun,
  keyAfterRun
}) {
  const wireRows = readJsonl(wireLogPath).filter((w) => !w.isSideCall && w.statusCode === 200);
  const transcriptLines = readJsonl(transcriptPath);

  const compactBoundaryEntry = transcriptLines.find((e) => e?.type === 'system' && e?.subtype === 'compact_boundary');
  const compactResultEntry = transcriptLines.find(
    (e) =>
      e?.type === 'user' &&
      typeof e?.message?.content === 'string' &&
      e.message.content.includes('This session is being continued from a previous conversation')
  );

  const byTurn = new Map();
  let compactWireRow = null;
  let requestsWithSystem2MemoryMd = 0;
  let requestsWithAnySystemMemoryMd = 0;

  for (const w of wireRows) {
    if (w.requestFingerprint?.system2HasMemoryMd) requestsWithSystem2MemoryMd += 1;
    if (w.requestFingerprint?.systemHasMemoryMd) requestsWithAnySystemMemoryMd += 1;
    const ev = w.context?.event || 'turn';
    if (ev === 'compact') {
      compactWireRow = w;
    } else if (ev === 'turn') {
      const t = Number(w.context?.turn);
      if (!byTurn.has(t)) byTurn.set(t, []);
      byTurn.get(t).push(w);
    }
  }

  const perTurnSummary = [];
  let totalBilledTurns1To20 = 0;
  let totalBilledTurns21To30 = 0;
  let totalRequestsTurns1To20 = 0;
  let totalRequestsTurns21To30 = 0;

  for (let t = 1; t <= 30; t += 1) {
    const calls = byTurn.get(t) || [];
    const reqCount = calls.length;
    const turnBilledUsd = calls.reduce((s, c) => s + Number(c.upstreamReportedCostUsd ?? c.cost?.totalCostUsd ?? 0), 0);
    const turnComputedUsd = calls.reduce((s, c) => s + Number(c.cost?.totalCostUsd ?? 0), 0);
    const firstCall = calls[0] || null;
    const lastCall = calls[calls.length - 1] || null;

    const firstTotalIn = firstCall
      ? Number(firstCall.usage?.input_tokens || 0) +
        Number(firstCall.usage?.cache_creation_input_tokens || 0) +
        Number(firstCall.usage?.cache_read_input_tokens || 0)
      : 0;
    const lastTotalIn = lastCall
      ? Number(lastCall.usage?.input_tokens || 0) +
        Number(lastCall.usage?.cache_creation_input_tokens || 0) +
        Number(lastCall.usage?.cache_read_input_tokens || 0)
      : 0;

    if (t <= 20) {
      totalBilledTurns1To20 += turnBilledUsd;
      totalRequestsTurns1To20 += reqCount;
    } else {
      totalBilledTurns21To30 += turnBilledUsd;
      totalRequestsTurns21To30 += reqCount;
    }

    perTurnSummary.push({
      turn: t,
      requestsInTurn: reqCount,
      firstCallInputTokens: firstCall ? Number(firstCall.usage?.input_tokens || 0) : 0,
      firstCallCacheWriteTokens: firstCall ? Number(firstCall.usage?.cache_creation_input_tokens || 0) : 0,
      firstCallCacheReadTokens: firstCall ? Number(firstCall.usage?.cache_read_input_tokens || 0) : 0,
      firstCallTotalPromptTokens: firstTotalIn,
      lastCallTotalPromptTokens: lastTotalIn,
      turnOutputTokens: calls.reduce((s, c) => s + Number(c.usage?.output_tokens || 0), 0),
      turnBilledUsd: Number(turnBilledUsd.toFixed(6)),
      turnComputedUsd: Number(turnComputedUsd.toFixed(6)),
      systemBlocksCount: firstCall?.requestFingerprint?.systemBlocksCount ?? null,
      systemChars: firstCall?.requestFingerprint?.systemChars ?? null,
      system2HasMemoryMd: Boolean(firstCall?.requestFingerprint?.system2HasMemoryMd),
      systemHasMemoryMd: Boolean(firstCall?.requestFingerprint?.systemHasMemoryMd)
    });
  }

  const t1First = (byTurn.get(1) || [])[0] || null;
  const t20Calls = byTurn.get(20) || [];
  const t20Last = t20Calls[t20Calls.length - 1] || null;
  const t21First = (byTurn.get(21) || [])[0] || null;

  const compactCallCostBilledUsd = compactWireRow
    ? Number((compactWireRow.upstreamReportedCostUsd ?? compactWireRow.cost?.totalCostUsd ?? 0).toFixed(6))
    : 0;
  const compactCallCostComputedUsd = compactWireRow
    ? Number((compactWireRow.cost?.totalCostUsd ?? 0).toFixed(6))
    : 0;

  const totalBilledUsd = Number(
    wireRows.reduce((s, c) => s + Number(c.upstreamReportedCostUsd ?? c.cost?.totalCostUsd ?? 0), 0).toFixed(6)
  );
  const totalComputedUsd = Number(
    wireRows.reduce((s, c) => s + Number(c.cost?.totalCostUsd ?? 0), 0).toFixed(6)
  );

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of boundaryRows) {
    if (r.outcomeClass === 'TP') tp += 1;
    else if (r.outcomeClass === 'FP') fp += 1;
    else if (r.outcomeClass === 'FN') fn += 1;
    else tn += 1;
  }

  return {
    runId,
    arm,
    rep,
    autoMemoryEnabled,
    model: 'anthropic/claude-sonnet-4.6',
    effort: EFFORT_BASELINE,
    keyUsageBeforeUsd: keyBeforeRun ? Number(Number(keyBeforeRun.usage).toFixed(6)) : null,
    keyUsageAfterUsd: keyAfterRun ? Number(Number(keyAfterRun.usage).toFixed(6)) : null,
    keyDeltaUsd:
      keyBeforeRun && keyAfterRun
        ? Number((Number(keyAfterRun.usage) - Number(keyBeforeRun.usage)).toFixed(6))
        : null,
    totalBilledUsd,
    totalComputedUsd,
    totalBilledTurns1To20Usd: Number(totalBilledTurns1To20.toFixed(6)),
    compactCallCostBilledUsd,
    compactCallCostComputedUsd,
    totalBilledTurns21To30Usd: Number(totalBilledTurns21To30.toFixed(6)),
    totalRequestsAll: wireRows.length,
    totalRequestsTurns1To20,
    totalRequestsTurns21To30,
    meanRequestsPerTurnAll30: Number(((totalRequestsTurns1To20 + totalRequestsTurns21To30) / 30).toFixed(4)),
    meanRequestsPerTurnT1ToT20: Number((totalRequestsTurns1To20 / 20).toFixed(4)),
    meanRequestsPerTurnT21ToT30: Number((totalRequestsTurns21To30 / 10).toFixed(4)),
    wireMemoryAudit: {
      totalWireRequestsChecked: wireRows.length,
      requestsWithSystem2MemoryMd,
      requestsWithAnySystemMemoryMd,
      t1SystemBlocksCount: t1First?.requestFingerprint?.systemBlocksCount ?? null,
      t1SystemBlockLengths: t1First?.requestFingerprint?.systemBlockLengths ?? null,
      t20SystemBlocksCount: t20Last?.requestFingerprint?.systemBlocksCount ?? null,
      t20SystemBlockLengths: t20Last?.requestFingerprint?.systemBlockLengths ?? null,
      t21SystemBlocksCount: t21First?.requestFingerprint?.systemBlocksCount ?? null,
      t21SystemBlockLengths: t21First?.requestFingerprint?.systemBlockLengths ?? null,
      t21System2HasMemoryMd: Boolean(t21First?.requestFingerprint?.system2HasMemoryMd),
      t21SystemHasMemoryMd: Boolean(t21First?.requestFingerprint?.systemHasMemoryMd)
    },
    contextAtT20LastPromptTokens: t20Last
      ? Number(t20Last.usage?.input_tokens || 0) +
        Number(t20Last.usage?.cache_creation_input_tokens || 0) +
        Number(t20Last.usage?.cache_read_input_tokens || 0)
      : 0,
    compactionCallUsage: compactWireRow
      ? {
          input_tokens: Number(compactWireRow.usage?.input_tokens || 0),
          cache_creation_input_tokens: Number(compactWireRow.usage?.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(compactWireRow.usage?.cache_read_input_tokens || 0),
          output_tokens: Number(compactWireRow.usage?.output_tokens || 0),
          totalPromptTokens:
            Number(compactWireRow.usage?.input_tokens || 0) +
            Number(compactWireRow.usage?.cache_creation_input_tokens || 0) +
            Number(compactWireRow.usage?.cache_read_input_tokens || 0),
          billedCostUsd: compactCallCostBilledUsd,
          computedCostUsd: compactCallCostComputedUsd
        }
      : null,
    compactBoundaryMetadata: compactBoundaryEntry?.compactMetadata || null,
    compactSummaryCharLength: compactResultEntry ? String(compactResultEntry.message.content).length : null,
    postCompactionTurn21Split: t21First
      ? {
          t1InitialCacheCreationTokens_toolsAndSystemBaseline: t1First
            ? Number(t1First.usage?.cache_creation_input_tokens || 0)
            : 0,
          t21InputTokens: Number(t21First.usage?.input_tokens || 0),
          t21CacheReadInputTokens: Number(t21First.usage?.cache_read_input_tokens || 0),
          t21CacheCreationInputTokens: Number(t21First.usage?.cache_creation_input_tokens || 0),
          t21TotalPromptTokens:
            Number(t21First.usage?.input_tokens || 0) +
            Number(t21First.usage?.cache_creation_input_tokens || 0) +
            Number(t21First.usage?.cache_read_input_tokens || 0),
          t21BilledCostUsd: Number(
            (t21First.upstreamReportedCostUsd ?? t21First.cost?.totalCostUsd ?? 0).toFixed(6)
          ),
          toolsChars: t21First.requestFingerprint?.toolsChars ?? null,
          systemChars: t21First.requestFingerprint?.systemChars ?? null,
          messagesChars: t21First.requestFingerprint?.messagesChars ?? null,
          toolsSha256MatchedT20:
            t21First.requestFingerprint?.toolsSha256 === t20Last?.requestFingerprint?.toolsSha256,
          systemSha256MatchedT20:
            t21First.requestFingerprint?.systemSha256 === t20Last?.requestFingerprint?.systemSha256
        }
      : null,
    outcomes,
    phase1DetectorEval: {
      totalTurns: boundaryRows.length,
      tp,
      fp,
      fn,
      tn,
      precision: tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null,
      recall: tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null,
      falsePromptsPer100Turns: Number(((fp / boundaryRows.length) * 100).toFixed(2))
    },
    perTurnSummary
  };
}

function sanitizeSmartCompactDir(dir) {
  const dynamicUser = os.userInfo().username || '';
  const dynamicRepoDirName = path.basename(REPO_ROOT);
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsonl|json|csv|md)$/i.test(entry.name)) {
        let txt = fs.readFileSync(full, 'utf8');
        const orig = txt;
        txt = txt
          .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
          .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]')
          .replace(/[A-Za-z]--Users-[A-Za-z0-9_.-]+-AppData-Local-Temp-[A-Za-z0-9_.-]+/gi, '<FROZEN_REPO_SLUG>')
          .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
          .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]')
          .replace(/\/c\/Users\/[^/"\s]+/gi, '/c/Users/[USER]')
          .replace(/[A-Za-z]:\/Users\/[^/"\s]+/gi, 'C:/Users/[USER]')
          .replace(/\/Users\/[^/"\s]+/g, '/Users/[USER]')
          .replace(/(\\"device_id\\":\\"|\"device_id\"\s*:\s*\")[0-9a-f]{32,64}(\\"|\")/gi, '$1[REDACTED_DEVICE_ID]$2')
          .replace(/gen-\d{6,}-[A-Za-z0-9_-]+/g, '[REDACTED_UPSTREAM_REQ_ID]')
          .replace(/msg_01[A-Za-z0-9]{10,}/g, '[REDACTED_MSG_ID]')
          .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]');
        if (dynamicUser && dynamicUser.length >= 3) {
          txt = txt.replace(new RegExp(dynamicUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[USER]');
        }
        if (dynamicRepoDirName && dynamicRepoDirName.length >= 3) {
          txt = txt.replace(new RegExp(dynamicRepoDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<TARGET_REPO>');
        }
        if (txt !== orig) fs.writeFileSync(full, txt, 'utf8');
      }
    }
  };
  walk(dir);
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const apiKey = loadOpenRouterApiKey();
  const ledgerPath = path.join(RAW_DIR, 'stage_a_openrouter_ledger.jsonl');
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);

  const keyBeforeStage = await fetchOpenRouterKeyUsage(apiKey);
  const creditsBeforeStage = await fetchOpenRouterCredits(apiKey);
  fs.appendFileSync(
    ledgerPath,
    JSON.stringify({ event: 'before_stage_a', key: keyBeforeStage, credits: creditsBeforeStage }) + '\n',
    'utf8'
  );
  console.log(
    `[Before Stage A] keyUsage=$${Number(keyBeforeStage.usage).toFixed(6)} (limitRemaining=$${Number(keyBeforeStage.limitRemaining).toFixed(6)}) | accountAvailable=$${Number(creditsBeforeStage.availableBalance).toFixed(6)}`
  );

  // Authorized runs:
  // 1. C1_r02 (auto-memory OFF, Stage A gate #1)
  // 2. C1_r03 (auto-memory OFF, Stage A gate #2)
  // 3. C1mem_r02 (auto-memory ON, stock reference #2 alongside C1_r01)
  const stageAuthorizedBudgetCapUsd = 4.5;
  const perRunCapUsd = 2.0;
  const runSpecs = [
    { runId: 'C1_r02', arm: 'C1', rep: 2, disableAutoMemory: true },
    { runId: 'C1_r03', arm: 'C1', rep: 3, disableAutoMemory: true },
    { runId: 'C1mem_r02', arm: 'C1mem', rep: 2, disableAutoMemory: false }
  ];

  let cumulativeStageWireSpendUsd = 0;
  const completedSummaries = [];
  const allNewBoundaryRows = [];

  for (const spec of runSpecs) {
    const remainingStageBudget = Number((stageAuthorizedBudgetCapUsd - cumulativeStageWireSpendUsd).toFixed(6));
    if (remainingStageBudget < 0.5) {
      throw new Error(
        `[Stage A Budget Stop] Remaining stage budget $${remainingStageBudget.toFixed(4)} is insufficient before ${spec.runId}`
      );
    }
    const effectiveRunCapUsd = Math.min(perRunCapUsd, remainingStageBudget);
    const wireLogPath = path.join(RAW_DIR, `stage_a_${spec.runId}_wire_log.jsonl`);
    if (fs.existsSync(wireLogPath)) fs.unlinkSync(wireLogPath);

    const keyBeforeRun = await fetchOpenRouterKeyUsage(apiKey);
    const serverHandle = await startProxyServer({
      upstreamBaseUrl: 'https://openrouter.ai',
      upstreamApiPrefix: '/api',
      apiKey,
      maxBudgetUsd: effectiveRunCapUsd,
      wireLogPath,
      pinProvider: true,
      stripCacheTtl: false
    });

    let sessionResult = null;
    try {
      sessionResult = await runSinglePhase2Session({
        runId: spec.runId,
        arm: 'C1',
        rep: spec.rep,
        initialModel: MODEL_B_CLI,
        compactionTurn: 20,
        compactionInstructions: '',
        disableAutoMemory: spec.disableAutoMemory,
        abortCapUsd: effectiveRunCapUsd,
        serverHandle,
        wireLogPath
      });
    } finally {
      await serverHandle.close();
    }

    // Wait 8 seconds for OpenRouter key usage settlement after each run
    await new Promise((r) => setTimeout(r, 8000));
    const keyAfterRun = await fetchOpenRouterKeyUsage(apiKey);
    fs.appendFileSync(
      ledgerPath,
      JSON.stringify({ event: `after_${spec.runId}`, key: keyAfterRun }) + '\n',
      'utf8'
    );

    const summary = summarizeRunFromWireAndTranscript({
      runId: spec.runId,
      arm: spec.arm,
      rep: spec.rep,
      autoMemoryEnabled: !spec.disableAutoMemory,
      wireLogPath,
      transcriptPath: sessionResult.transcriptDest,
      outcomes: sessionResult.outcomes,
      boundaryRows: sessionResult.boundaryRows,
      keyBeforeRun,
      keyAfterRun
    });

    cumulativeStageWireSpendUsd = Number((cumulativeStageWireSpendUsd + summary.totalBilledUsd).toFixed(6));
    completedSummaries.push(summary);
    allNewBoundaryRows.push(...sessionResult.boundaryRows);

    console.log(
      `[Run Complete: ${spec.runId}] autoMemory=${!spec.disableAutoMemory} | billed=$${summary.totalBilledUsd.toFixed(6)} | cumStage=$${cumulativeStageWireSpendUsd.toFixed(6)} | violations=${summary.outcomes.constraintViolationsCount}/4 | ghostRevert=${summary.outcomes.ghostRevertOccurred} | recall=${summary.outcomes.recallFormat} | sysHasMemoryMd=${summary.wireMemoryAudit.requestsWithAnySystemMemoryMd}/${summary.wireMemoryAudit.totalWireRequestsChecked}`
    );
  }

  // Wait another 6s at end of Stage A to ensure 100% settled key usage and credits
  await new Promise((r) => setTimeout(r, 6000));
  const keyAfterStage = await fetchOpenRouterKeyUsage(apiKey);
  const creditsAfterStage = await fetchOpenRouterCredits(apiKey);
  fs.appendFileSync(
    ledgerPath,
    JSON.stringify({ event: 'after_stage_a_settled', key: keyAfterStage, credits: creditsAfterStage }) + '\n',
    'utf8'
  );

  // Load C1_r01 summary for comparison
  const c1r01Summary = JSON.parse(
    fs.readFileSync(path.join(SMART_COMPACT_DIR, 'pilot_c1_r01_summary.json'), 'utf8')
  );

  // Compute S-A vs S-D from the C1_r01 measured cache split ("computed from a measured cache split")
  // In C1_r01 at Turn 21:
  // - tools/system layer surviving compaction: 10,619 tokens
  // - system[2] + messages layer written cold after compaction: 21,957 tokens
  // - uncached input: 3 tokens (total T21 prompt = 32,579 tokens; cacheable = 32,576 tokens)
  // - T21 output tokens: 91 tokens
  // - T22..T30 (11 requests across 9 remaining turns in C1_r01): mean warm cache_read = 33,807 tokens/req, mean cache_write = 205 tokens/req, mean input = 3 tokens/req, mean output = 120.6 tokens/req
  const toolsSysTokens = 10619;
  const messagesColdTokens = 21957;
  const totalCacheableT21 = toolsSysTokens + messagesColdTokens; // 32,576
  const uncachedInT21 = 3;
  const outT21 = 91;

  // Opus 4.6 rates (5m cache write $6.25/M, warm read $0.50/M, input $5.00/M, output $25.00/M)
  const opusT21PromptUsd = Number(
    ((toolsSysTokens * 0.5 + messagesColdTokens * 6.25 + uncachedInT21 * 5.0) / 1e6).toFixed(6)
  );
  const opusT21TotalUsd = Number((opusT21PromptUsd + (outT21 * 25.0) / 1e6).toFixed(6));

  // Sonnet 4.6 rates (5m cache write $3.75/M, warm read $0.30/M, input $3.00/M, output $15.00/M)
  // On S-A (switch Opus -> Sonnet immediately after compaction), all 32,576 cacheable tokens are written cold on Sonnet:
  const sonnetSwitchT21PromptUsd = Number(
    ((totalCacheableT21 * 3.75 + uncachedInT21 * 3.0) / 1e6).toFixed(6)
  );
  const sonnetSwitchT21TotalUsd = Number((sonnetSwitchT21PromptUsd + (outT21 * 15.0) / 1e6).toFixed(6));

  // Subsequent warm turns T22..T30 measured in C1_r01 (11 requests across 9 turns):
  // In C1_r01, T22..T30 billed $0.225134 - $0.086898 = $0.138236 on Sonnet ($0.015360/turn across 9 turns, $0.012567/request across 11 requests).
  // Since Opus 4.6 rates are exactly 5/3 (1.6667x) of Sonnet 4.6 across every token bucket, T22..T30 on Opus costs $0.138236 * (5/3) = $0.230393 ($0.025599/turn, $0.020945/request).
  const sonnetT22ToT30TotalUsd = Number((0.225134 - 0.086898).toFixed(6)); // $0.138236
  const opusT22ToT30TotalUsd = Number((sonnetT22ToT30TotalUsd * (5 / 3)).toFixed(6)); // $0.230393
  const perTurnSavingAfterT21Usd = Number(((opusT22ToT30TotalUsd - sonnetT22ToT30TotalUsd) / 9).toFixed(6)); // $0.010240/turn
  const perRequestSavingAfterT21Usd = Number(((opusT22ToT30TotalUsd - sonnetT22ToT30TotalUsd) / 11).toFixed(6)); // $0.008378/req

  const computedSwitchAfterCompaction = {
    label: 'computed from a measured cache split',
    sourceRun: 'C1_r01',
    measuredT21Split: {
      toolsAndSystemLayerTokens: toolsSysTokens,
      messagesAndDynamicSystemLayerTokens: messagesColdTokens,
      totalCacheableTokens: totalCacheableT21,
      uncachedInputTokens: uncachedInT21,
      outputTokens: outT21
    },
    firstPostCompactionTurnT21: {
      sD_stayOnOpus: {
        description: 'Read 10,619 tools/system tokens warm on Opus ($0.50/M) + write 21,957 messages/system[2] tokens cold on Opus ($6.25/M)',
        toolsSystemWarmReadCostUsd: Number(((toolsSysTokens * 0.5) / 1e6).toFixed(6)),
        messagesColdWriteCostUsd: Number(((messagesColdTokens * 6.25) / 1e6).toFixed(6)),
        promptCostUsd: opusT21PromptUsd,
        totalTurn21CostUsd: opusT21TotalUsd
      },
      sA_switchToSonnet: {
        description: 'Write all 32,576 tokens (10,619 tools/system + 21,957 messages/system[2]) cold on Sonnet ($3.75/M)',
        toolsSystemColdWriteCostUsd: Number(((toolsSysTokens * 3.75) / 1e6).toFixed(6)),
        messagesColdWriteCostUsd: Number(((messagesColdTokens * 3.75) / 1e6).toFixed(6)),
        promptCostUsd: sonnetSwitchT21PromptUsd,
        totalTurn21CostUsd: sonnetSwitchT21TotalUsd
      },
      t21NetSavingFromSwitchingToSonnetPromptOnlyUsd: Number((opusT21PromptUsd - sonnetSwitchT21PromptUsd).toFixed(6)),
      t21NetSavingFromSwitchingToSonnetTotalUsd: Number((opusT21TotalUsd - sonnetSwitchT21TotalUsd).toFixed(6))
    },
    postT21WarmTurnsT22ToT30: {
      turnsCount: 9,
      requestsCount: 11,
      sD_opusTotalUsd: opusT22ToT30TotalUsd,
      sA_sonnetTotalUsd: sonnetT22ToT30TotalUsd,
      savingPerTurnUsd: perTurnSavingAfterT21Usd,
      savingPerRequestUsd: perRequestSavingAfterT21Usd,
      totalSavingT22ToT30Usd: Number((opusT22ToT30TotalUsd - sonnetT22ToT30TotalUsd).toFixed(6))
    },
    totalPostCompactionSavingT21ToT30Usd: Number(
      (opusT21TotalUsd + opusT22ToT30TotalUsd - (sonnetSwitchT21TotalUsd + sonnetT22ToT30TotalUsd)).toFixed(6)
    )
  };

  // Update phase1_boundary_detector.csv with all 4 Phase 2 runs (C1_r01, C1_r02, C1_r03, C1mem_r02)
  const existingCsvLines = fs
    .readFileSync(path.join(SMART_COMPACT_DIR, 'phase1_boundary_detector.csv'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const header = existingCsvLines[0];
  const existingBenchAndC1r01 = existingCsvLines.filter(
    (l, idx) => idx > 0 && (l.startsWith('existing_benchmark_transcripts,') || l.includes(',sess_C1_r01,'))
  );
  const newCsvLines = allNewBoundaryRows.map((r) =>
    [
      r.datasetGroup,
      r.sessionId,
      r.turnNumber,
      r.hadEdit,
      r.ranTestCommand,
      r.testPassed,
      r.testFailed,
      r.groundTruthLabel,
      r.detectorState,
      r.detectorSuggestCompact,
      r.outcomeClass
    ].join(',')
  );
  const updatedCsv = [header, ...existingBenchAndC1r01, ...newCsvLines].join('\n') + '\n';
  fs.writeFileSync(path.join(SMART_COMPACT_DIR, 'phase1_boundary_detector.csv'), updatedCsv, 'utf8');
  fs.writeFileSync(path.join(RESULTS_ROOT, 'phase1_boundary_detector.csv'), updatedCsv, 'utf8');

  // Check Stage A gate condition on C1_r02 and C1_r03 (both auto-memory OFF)
  const c1OffRuns = completedSummaries.filter((r) => r.runId === 'C1_r02' || r.runId === 'C1_r03');
  const stageAAtCeiling = c1OffRuns.every(
    (r) =>
      r.outcomes.constraintViolationsCount === 0 &&
      r.outcomes.recallCorrectCount === 3 &&
      !r.outcomes.ghostRevertOccurred
  );

  const stageASummary = {
    status: 'STAGE_A_COMPLETE',
    stageAAtCeiling,
    stageDecision: stageAAtCeiling
      ? 'STOP_AT_CEILING_PROPOSE_HARDER_FIXTURE_AT_0_USD'
      : 'LOSSES_OBSERVED_SEND_STAGE_B_ESTIMATE',
    ledger: {
      keyUsageBeforeStageUsd: Number(Number(keyBeforeStage.usage).toFixed(6)),
      keyUsageAfterStageSettledUsd: Number(Number(keyAfterStage.usage).toFixed(6)),
      settledKeyUsageDeltaUsd: Number((Number(keyAfterStage.usage) - Number(keyBeforeStage.usage)).toFixed(6)),
      keyLimitRemainingBeforeUsd: Number(Number(keyBeforeStage.limitRemaining).toFixed(6)),
      keyLimitRemainingAfterUsd: Number(Number(keyAfterStage.limitRemaining).toFixed(6)),
      accountAvailableBeforeUsd: creditsBeforeStage.availableBalance,
      accountAvailableAfterUsd: creditsAfterStage.availableBalance,
      settledAccountDeltaUsd: Number(
        (creditsBeforeStage.availableBalance - creditsAfterStage.availableBalance).toFixed(6)
      ),
      totalStageWireBilledUsd: cumulativeStageWireSpendUsd
    },
    memoryOffStageAGateRuns: c1OffRuns,
    memoryOnReferenceRuns: [
      {
        runId: 'C1_r01 (C1mem_r01)',
        autoMemoryEnabled: true,
        totalBilledUsd: c1r01Summary.totalBilledUsd,
        settledKeyDeltaUsd: c1r01Summary.fullySettledKeyDeltaUsd ?? c1r01Summary.settledKeyDeltaUsd,
        totalRequestsAll: c1r01Summary.totalRequestsAll,
        totalRequestsTurns1To20: c1r01Summary.totalRequestsTurns1To20,
        totalRequestsTurns21To30: c1r01Summary.totalRequestsTurns21To30,
        contextAtT20LastPromptTokens: c1r01Summary.contextAtT20LastPromptTokens,
        compactionCallUsage: c1r01Summary.compactionCallUsage,
        compactBoundaryMetadata: c1r01Summary.compactBoundaryMetadata,
        compactSummaryCharLength: c1r01Summary.compactSummaryCharLength,
        postCompactionTurn21Split: c1r01Summary.postCompactionTurn21Split,
        outcomes: c1r01Summary.outcomes
      },
      ...completedSummaries.filter((r) => r.runId === 'C1mem_r02')
    ],
    computedSwitchAfterCompaction
  };

  fs.writeFileSync(
    path.join(SMART_COMPACT_DIR, 'stage_a_summary.json'),
    JSON.stringify(stageASummary, null, 2) + '\n',
    'utf8'
  );

  sanitizeSmartCompactDir(SMART_COMPACT_DIR);
  console.log(JSON.stringify(stageASummary, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
