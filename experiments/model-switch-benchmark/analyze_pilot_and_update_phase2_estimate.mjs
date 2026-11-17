import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EXPERIMENT_DIR, REPO_ROOT } from './config.mjs';
import {
  buildScripted30TurnPlan,
  evaluateBoundaryDetectorOnPhase2Transcript
} from './run_smart_compact_pilot.mjs';
import { isRealHumanUserTranscriptEntry } from '../../src/utils/sessionCalibration.mjs';

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

// 1. Re-evaluate boundary detector on C1_r01.jsonl against scripted turn plan labels
const pilotSummaryPath = path.join(SMART_COMPACT_DIR, 'pilot_c1_r01_summary.json');
const pilotSummary = JSON.parse(fs.readFileSync(pilotSummaryPath, 'utf8'));
const c1TranscriptPath = path.join(TRANSCRIPTS_DIR, 'C1_r01.jsonl');
const c1Plan = buildScripted30TurnPlan('C1');
const c1BoundaryRows = evaluateBoundaryDetectorOnPhase2Transcript(c1TranscriptPath, c1Plan, 'C1_r01');

let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;
for (const r of c1BoundaryRows) {
  if (r.outcomeClass === 'TP') tp += 1;
  else if (r.outcomeClass === 'FP') fp += 1;
  else if (r.outcomeClass === 'FN') fn += 1;
  else tn += 1;
}

pilotSummary.phase1ScriptedPlanDetectorEval = {
  status: 'UNVERIFIED_SINGLE_PILOT_N1',
  totalTurns: c1BoundaryRows.length,
  boundaryTurnsInPlan: c1BoundaryRows.filter((r) => r.groundTruthLabel === 'task_boundary').length,
  midDebugTurnsInPlan: c1BoundaryRows.filter((r) => r.groundTruthLabel === 'mid_debug').length,
  otherTurnsInPlan: c1BoundaryRows.filter((r) => r.groundTruthLabel === 'other').length,
  tp,
  fp,
  fn,
  tn,
  precision: tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null,
  recall: tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null,
  falsePromptsPer100Turns: Number(((fp / c1BoundaryRows.length) * 100).toFixed(2)),
  perTurnDetails: c1BoundaryRows
};

// 2. Inspect Turn 1, Turn 20, Compaction Call, and Turn 21 wire records in detail for tools/system vs messages split
const wireRows = readJsonl(path.join(RAW_DIR, 'pilot_c1_r01_wire_log.jsonl')).filter(
  (w) => !w.isSideCall && w.statusCode === 200
);
const t1First = wireRows.find((w) => w.context?.event === 'turn' && Number(w.context?.turn) === 1);
const t20Calls = wireRows.filter((w) => w.context?.event === 'turn' && Number(w.context?.turn) === 20);
const t20Last = t20Calls[t20Calls.length - 1];
const compactCall = wireRows.find((w) => w.context?.event === 'compact');
const t21First = wireRows.find((w) => w.context?.event === 'turn' && Number(w.context?.turn) === 21);

// Explain the exact tools/system vs messages split on Turn 21:
// - On Turn 1 first call, total prompt is 11,453 tokens (11,450 cache_creation + 3 input), where messages[0] is only 189 chars (~48 tokens).
//   Specifically, tools (17,243 chars) + system[0..1] static SDK instructions (~23,500 chars) = 10,619 tokens (cached at system[1] breakpoint!).
//   system[2] is the dynamic workspace/git/memory reminder block (~3,600 chars, ~830 tokens, cached at system[2] breakpoint).
// - On Turn 21 (first post-compaction request on Sonnet 4.6):
//   * cache_read_input_tokens = 10,619 tokens -> 100% of the static `tools + system[0..1]` prefix SURVIVED compaction in the warm cache!
//   * cache_creation_input_tokens = 21,957 tokens -> consists of `system[2]` (~830 tokens, modified during the session when MEMORY.md was created) + compacted `messages[0..3]` (~21,127 tokens = 58,385 chars: the 14,073-char compaction summary + preserved tail messages from Turn 20).
pilotSummary.postCompactionTurn21Split = {
  ...pilotSummary.postCompactionTurn21Split,
  layerDecomposition: {
    toolsAndStaticSystemLayerCacheReadTokens: Number(t21First.usage?.cache_read_input_tokens || 0), // 10,619
    dynamicSystemAndMessagesLayerCacheCreationTokens: Number(t21First.usage?.cache_creation_input_tokens || 0), // 21,957
    estimatedDynamicSystem2Tokens: 831,
    estimatedMessagesSummaryAndPreservedTailTokens:
      Number(t21First.usage?.cache_creation_input_tokens || 0) - 831, // ~21,126
    toolsAndStaticSystemSurvivedCompaction: Number(t21First.usage?.cache_read_input_tokens || 0) >= 10000,
    t20LastSystemChars: t20Last?.requestFingerprint?.systemChars ?? null,
    t21FirstSystemChars: t21First?.requestFingerprint?.systemChars ?? null,
    t20LastMessagesChars: t20Last?.requestFingerprint?.messagesChars ?? null,
    t21FirstMessagesChars: t21First?.requestFingerprint?.messagesChars ?? null,
    compactCallCacheReadTokens: Number(compactCall?.usage?.cache_read_input_tokens || 0),
    compactCallCacheCreationTokens: Number(compactCall?.usage?.cache_creation_input_tokens || 0),
    compactCallInputTokens: Number(compactCall?.usage?.input_tokens || 0),
    compactCallOutputTokens: Number(compactCall?.usage?.output_tokens || 0)
  }
};

// 3. Recompute Phase 2 Cost Estimate directly from Pilot C1_r01 with +15% margin
// Pilot C1_r01 measured:
// - Pre-compaction T1-T20 billed: $0.824975 (49 requests across 20 turns, R = 2.45; note Turn 2 had 13 requests = $0.1473 due to auto-memory bash probing)
// - Compaction call @ T20 billed: $0.115296 (48,996 cache_read + 89 cache_write + 1,681 input + 6,348 output tokens)
// - Post-compaction T21-T30 billed: $0.225134 (12 requests across 10 turns, R = 1.20; Turn 21 cold-wrote 21,957 tokens = $0.0869, Turns 22-30 read ~33k warm tokens)
// - Total Pilot C1_r01 billed: $1.165405 (settled /api/v1/key delta: $1.128175)
//
// Scaling to each remaining arm from the C1_r01 pilot baseline (and applying +15% safety margin):
// - Sonnet compact arms (C1 remaining, C2, C3, T1, C4):
//   * Base expected per run = Pilot C1_r01 billed ($1.1654):
//     - C1: $1.1654 base -> with +15% margin = $1.3402 / run
//     - C2 (preservation template, slightly shorter summary than 6,348-token default): $1.1654 base -> with +15% margin = $1.3402 / run
//     - C3 (default /compact + SessionStart(source=compact) additionalContext ~280 tokens in T21-T30):
//       +$0.0020/run for 280 extra tokens across T21-T30 -> $1.1674 base -> with +15% margin = $1.3425 / run
//     - T1 (C2 template compacted mid-debug @ T20): $1.1654 base -> with +15% margin = $1.3402 / run
//     - C4 (short template /compact @ T20, smaller summary ~2,500 out tokens & ~15k T21 context):
//       saves ~$0.058 on compact output + ~$0.045 on T21-T30 reads -> $1.0620 base -> with +15% margin = $1.2213 / run
// - Sonnet no-compact control (C0):
//   * T1-T20 is identical ($0.8250). No compaction call ($0.0000 instead of $0.1153).
//   * T21-T30 has no Turn-21 cold rewrite (-$0.0823 write penalty), but reads ~50,500 warm tokens across 12 requests instead of ~33,500 (+17,000 * 12 * $0.30/M = +$0.0612).
//   * Net T21-T30 on C0 = $0.2251 - $0.0823 + $0.0612 = $0.2040.
//   * Base expected per run for C0 = $0.8250 + $0.2040 = $1.0290 -> with +15% margin = $1.1834 / run.
// - Opus 4.6 arms (S-A and S-D, n=1 each; Opus 5m write $6.25/M, read $0.50/M, out $25.00/M = exactly 5/3 = 1.6667x Sonnet rates):
//   * T1-T20 on Opus 4.6 = $0.824975 * (5/3) = $1.3750
//   * Compaction call on Opus 4.6 @ T20 = $0.115296 * (5/3) = $0.1922
//   * S-A (switches to Sonnet 4.6 right after Opus compaction for T21-T30):
//     Because switching from Opus to Sonnet busts the 10,619-token `tools + system[0..1]` cache that survived in C1, Turn 21 on Sonnet must cold-write all 32,576 tokens instead of 21,957 (+10,619 * ($3.75 - $0.30)/M = +$0.0366).
//     So T21-T30 on Sonnet for S-A = $0.2251 + $0.0366 = $0.2617.
//     Base expected per run for S-A = $1.3750 + $0.1922 + $0.2617 = $1.8289 -> with +15% margin = $2.1032 / run.
//   * S-D (stays on Opus 4.6 for T21-T30 after Opus compaction, no switch):
//     `tools + system[0..1]` (10,619 tokens) survives in Opus warm cache just like C1; T21-T30 on Opus = $0.225134 * (5/3) = $0.3752.
//     Base expected per run for S-D = $1.3750 + $0.1922 + $0.3752 = $1.9424 -> with +15% margin = $2.2338 / run.

const currentKeyLimitRemaining8sUsd = pilotSummary.balanceAfterUsd; // $9.208424 (at 8s wait)
const currentKeyLimitRemainingFullySettledUsd = 9.171195; // $50.00 limit - $40.828805 fully settled usage
const fullySettledKeyDeltaUsd = 1.165405; // $40.828805 - $39.663400 (matches wire-billed $1.165405 to 6 decimals)
const accountAvailableBalanceUsd = 78.517771; // $525.00 total_credits - $446.482229 total_usage ($78.52)
const requiredReserveUsd = 1.0;
const maxUsableKeyCapBudgetUsd = Number((currentKeyLimitRemainingFullySettledUsd - requiredReserveUsd).toFixed(4)); // $8.1712
const maxUsableAccountBudgetUsd = Number((accountAvailableBalanceUsd - requiredReserveUsd).toFixed(4)); // $77.5178

const remainingArmsSpec = [
  {
    priorityRank: 1,
    arm: 'C1',
    modelSchedule: 'sonnet-4.6 (default /compact @ T20; 1/3 done in pilot, 2 remaining)',
    totalPlannedN: 3,
    completedPilotN: 1,
    remainingN: 2,
    pilotBasePerRunUsd: 1.1654,
    pre20BaseUsd: 0.8250,
    compactBaseUsd: 0.1153,
    post10BaseUsd: 0.2251
  },
  {
    priorityRank: 2,
    arm: 'C2',
    modelSchedule: 'sonnet-4.6 (preservation template /compact @ T20)',
    totalPlannedN: 3,
    completedPilotN: 0,
    remainingN: 3,
    pilotBasePerRunUsd: 1.1654,
    pre20BaseUsd: 0.8250,
    compactBaseUsd: 0.1153,
    post10BaseUsd: 0.2251
  },
  {
    priorityRank: 3,
    arm: 'C0',
    modelSchedule: 'sonnet-4.6 (T1-T30, no compact control)',
    totalPlannedN: 3,
    completedPilotN: 0,
    remainingN: 3,
    pilotBasePerRunUsd: 1.0290,
    pre20BaseUsd: 0.8250,
    compactBaseUsd: 0.0000,
    post10BaseUsd: 0.2040
  },
  {
    priorityRank: 4,
    arm: 'C3',
    modelSchedule: 'sonnet-4.6 (default /compact + SessionStart(source=compact) additionalContext)',
    totalPlannedN: 3,
    completedPilotN: 0,
    remainingN: 3,
    pilotBasePerRunUsd: 1.1674,
    pre20BaseUsd: 0.8250,
    compactBaseUsd: 0.1153,
    post10BaseUsd: 0.2271
  },
  {
    priorityRank: 5,
    arm: 'S-A',
    modelSchedule: 'opus-4.6 T1-T20 -> compact @ T20 -> switch sonnet-4.6 T21-T30 (n=1)',
    totalPlannedN: 1,
    completedPilotN: 0,
    remainingN: 1,
    pilotBasePerRunUsd: 1.8289,
    pre20BaseUsd: 1.3750,
    compactBaseUsd: 0.1922,
    post10BaseUsd: 0.2617
  },
  {
    priorityRank: 6,
    arm: 'S-D',
    modelSchedule: 'opus-4.6 T1-T30 (compact only @ T20, no switch, n=1)',
    totalPlannedN: 1,
    completedPilotN: 0,
    remainingN: 1,
    pilotBasePerRunUsd: 1.9424,
    pre20BaseUsd: 1.3750,
    compactBaseUsd: 0.1922,
    post10BaseUsd: 0.3752
  },
  {
    priorityRank: 7,
    arm: 'T1',
    modelSchedule: 'sonnet-4.6 (C2 template compacted mid-debug @ T20)',
    totalPlannedN: 2,
    completedPilotN: 0,
    remainingN: 2,
    pilotBasePerRunUsd: 1.1654,
    pre20BaseUsd: 0.8250,
    compactBaseUsd: 0.1153,
    post10BaseUsd: 0.2251
  },
  {
    priorityRank: 8,
    arm: 'C4',
    modelSchedule: 'sonnet-4.6 (short template /compact @ T20)',
    totalPlannedN: 2,
    completedPilotN: 0,
    remainingN: 2,
    pilotBasePerRunUsd: 1.0620,
    pre20BaseUsd: 0.8250,
    compactBaseUsd: 0.0575,
    post10BaseUsd: 0.1795
  }
];

let cumRemainingRuns = 0;
let cumBaseUsd = 0;
let cumPlus15PctUsd = 0;

for (const a of remainingArmsSpec) {
  a.perRunPlus15PctUsd = Number((a.pilotBasePerRunUsd * 1.15).toFixed(4));
  a.abortCapUsd = Number(Math.max(2.0, a.perRunPlus15PctUsd * 2.0).toFixed(2));
  a.armRemainingBaseUsd = Number((a.pilotBasePerRunUsd * a.remainingN).toFixed(4));
  a.armRemainingPlus15PctUsd = Number((a.perRunPlus15PctUsd * a.remainingN).toFixed(4));
  cumRemainingRuns += a.remainingN;
  cumBaseUsd = Number((cumBaseUsd + a.armRemainingBaseUsd).toFixed(4));
  cumPlus15PctUsd = Number((cumPlus15PctUsd + a.armRemainingPlus15PctUsd).toFixed(4));
  a.cumulativeRemainingRuns = cumRemainingRuns;
  a.cumulativeBaseUsd = cumBaseUsd;
  a.cumulativePlus15PctUsd = cumPlus15PctUsd;
  a.fitsAccountBudgetAtPlus15Pct = cumPlus15PctUsd <= maxUsableAccountBudgetUsd;
  a.fitsAccountBudgetAtBase = cumBaseUsd <= maxUsableAccountBudgetUsd;
  a.fitsCurrentKeyCapAtPlus15Pct = cumPlus15PctUsd <= maxUsableKeyCapBudgetUsd;
  a.fitsCurrentKeyCapAtBase = cumBaseUsd <= maxUsableKeyCapBudgetUsd;
}

// Also compute the n=2 per arm option (where C1 needs only 1 more run, and C2, C0, C3 run at n=2 each)
const n2OptionSpec = [
  { arm: 'C1 (1 more for n=2)', remainingN: 1, perRunBase: 1.1654, perRun15: Number((1.1654 * 1.15).toFixed(4)) },
  { arm: 'C2 (n=2)', remainingN: 2, perRunBase: 1.1654, perRun15: Number((1.1654 * 1.15).toFixed(4)) },
  { arm: 'C0 (n=2)', remainingN: 2, perRunBase: 1.0290, perRun15: Number((1.0290 * 1.15).toFixed(4)) },
  { arm: 'C3 (n=2)', remainingN: 2, perRunBase: 1.1674, perRun15: Number((1.1674 * 1.15).toFixed(4)) },
  { arm: 'S-A (n=1)', remainingN: 1, perRunBase: 1.8289, perRun15: Number((1.8289 * 1.15).toFixed(4)) },
  { arm: 'S-D (n=1)', remainingN: 1, perRunBase: 1.9424, perRun15: Number((1.9424 * 1.15).toFixed(4)) }
];
let n2CumRuns = 0;
let n2CumBase = 0;
let n2Cum15 = 0;
for (const item of n2OptionSpec) {
  n2CumRuns += item.remainingN;
  n2CumBase = Number((n2CumBase + item.remainingN * item.perRunBase).toFixed(4));
  n2Cum15 = Number((n2Cum15 + item.remainingN * item.perRun15).toFixed(4));
  item.cumRuns = n2CumRuns;
  item.cumBaseUsd = n2CumBase;
  item.cumPlus15PctUsd = n2Cum15;
}

pilotSummary.fullySettledKeyLimitRemainingUsd = currentKeyLimitRemainingFullySettledUsd;
pilotSummary.fullySettledKeyDeltaUsd = fullySettledKeyDeltaUsd;
pilotSummary.accountAvailableBalanceUsd = accountAvailableBalanceUsd;

pilotSummary.recomputedPhase2EstimateFromPilot = {
  keyLimitRemainingAt8sUsd: currentKeyLimitRemaining8sUsd,
  keyLimitRemainingFullySettledUsd: currentKeyLimitRemainingFullySettledUsd,
  fullySettledKeyDeltaUsd,
  accountAvailableBalanceUsd,
  requiredReserveUsd,
  maxUsableKeyCapBudgetUsd,
  maxUsableAccountBudgetUsd,
  remainingArmsInPriorityOrder: remainingArmsSpec,
  n2AlternativeFittingCorePlusOpus: n2OptionSpec
};

fs.writeFileSync(pilotSummaryPath, JSON.stringify(pilotSummary, null, 2) + '\n', 'utf8');

// 4. Update phase1_boundary_detector.csv: keep the 78 existing benchmark transcripts (0 boundaries)
//    + the real C1_r01 live transcript evaluated against the scripted turn plan labels (no synthetic author-labeled preview rows!)
const existingCsvLines = fs
  .readFileSync(path.join(SMART_COMPACT_DIR, 'phase1_boundary_detector.csv'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);
const header = existingCsvLines[0];
const existingOnlyLines = existingCsvLines.filter((l) => l.startsWith('existing_benchmark_transcripts,'));
const c1CsvLines = c1BoundaryRows.map((r) =>
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
const finalPhase1Csv = [header, ...existingOnlyLines, ...c1CsvLines].join('\n') + '\n';
fs.writeFileSync(path.join(SMART_COMPACT_DIR, 'phase1_boundary_detector.csv'), finalPhase1Csv, 'utf8');
fs.writeFileSync(path.join(RESULTS_ROOT, 'phase1_boundary_detector.csv'), finalPhase1Csv, 'utf8');

const phase0UpdatedMd = `# Smart-Compact Phase 0, Phase 1 (Unverified), Pilot \`C1_r01\`, & Recomputed Phase 2 Cost Gate

- **OpenRouter Account Available Credit Balance (\`/api/v1/credits\`):** **\`\$78.517771\` (\`\$78.52\`)** (\`total_credits = \$525.00\`, \`total_usage = \$446.482229\`; **\`\$77.52\` usable** after \`\$1.00\` reserve)
- **OpenRouter Per-Key Spend Cap (\`/api/v1/key\`, \`limit = \$50.00\`):**
  - **Before Pilot \`C1_r01\`:** \`limit_remaining = \$10.336600\` (\`usage = \$39.663400\`)
  - **After Pilot \`C1_r01\` (8s snapshot):** \`limit_remaining = \$9.208424\` (\`usage = \$40.791576\`, delta \`\$1.128175\`)
  - **After Pilot \`C1_r01\` (fully settled):** \`limit_remaining = \$9.171195\` (\`usage = \$40.828805\`, **settled \`/api/v1/key\` delta = \`\$1.165405\`**, matching wire-billed **\`\$1.165405\`** to 6 decimal places)

---

## 1. Pilot \`C1_r01\` Live Results (\`anthropic/claude-sonnet-4.6\`, 30 Turns, Default \`/compact\` @ Turn 20, Abort Cap \`\$2.00\`)

### A. Per-Turn \`requests/turn\`, Prompt Context Tokens, Output Tokens, and Billed Cost (\`C1_r01\`)

| Turn | Scripted Phase | Plan Label | \`requests/turn\` | First-Call \`cache_read\` | First-Call \`cache_write\` | First-Call Prompt Tok | Last-Call Prompt Tok | Turn Output Tok | Turn Billed Cost |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${pilotSummary.perTurnSummary
  .map(
    (t) =>
      `| **T${String(t.turn).padStart(2, '0')}** | \`${c1Plan[t.turn - 1].phase}\` | \`${c1Plan[t.turn - 1].planLabel}\` | **\`${t.requestsInTurn}\`** | \`${t.firstCallCacheReadTokens.toLocaleString()}\` | \`${t.firstCallCacheWriteTokens.toLocaleString()}\` | \`${t.firstCallTotalPromptTokens.toLocaleString()}\` | \`${t.lastCallTotalPromptTokens.toLocaleString()}\` | \`${t.turnOutputTokens.toLocaleString()}\` | \`$${t.turnBilledUsd.toFixed(6)}\` |`
  )
  .join('\n')}
| **Compaction Call (@T20)** | \`/compact\` (default) | — | **\`1\`** | \`48,996\` | \`89\` | \`50,766\` | \`50,766\` | \`6,348\` | **\`$0.115296\`** |
| **Total / Mean (30 Turns + Compact)** | — | — | **\`62\` reqs** (\`2.03/turn\` over 30 turns; \`2.45\` T1–T20, \`1.20\` T21–T30) | — | — | — | **T20: \`49,338\`**<br/>**T21: \`32,579\`** | **\`15,049\`** (\`8,701\` turns + \`6,348\` compact) | **\`$1.165405\`** (fully settled key delta: **\`$1.165405\`**) |

### B. Turn 21 First Post-Compaction Request: \`tools/system\` Layer vs. \`messages\` Cache Split (\`H4\` / \`H6\`)

| Metric | Measured Value in \`C1_r01\` (\`claude-sonnet-4-6\`) | Interpretation |
| :--- | :---: | :--- |
| **Turn 1 Initial \`cache_creation_input_tokens\` (\`tools + system\` baseline)** | \`11,450\` tokens | Baseline size of \`tools\` (\`17,243\` chars) + \`system[0..2]\` (\`27,115\` chars) + 1-sentence T1 prompt (\`~48\` tok) |
| **Turn 20 Last Request Total Prompt Tokens (Pre-Compaction)** | \`49,338\` tokens | \`48,850\` \`cache_read\` + \`146\` \`cache_write\` + \`3\` \`input\` (+ \`339\` on 2nd call) |
| **Compaction Request (\`@T20\`) Usage & Cost** | \`48,996\` \`cache_read\`, \`89\` \`cache_write\`, \`1,681\` \`input\`, **\`6,348\` \`output\`** | **\`$0.115296\`** billed (\`50,766\` prompt tokens; generated a \`14,073\`-char / \`6,348\`-tok summary) |
| **Turn 21 First Post-Compaction \`cache_read_input_tokens\` (\`tools + system[0..1]\` layer)** | **\`10,619\` tokens** | **SURVIVED COMPACTION:** \`toolsSha256\` matched Turn 20 (\`true\`), and the \`system[1]\` ephemeral breakpoint hit warm cache! |
| **Turn 21 First Post-Compaction \`cache_creation_input_tokens\` (\`system[2] + messages\` layer)** | **\`21,957\` tokens** | Re-written cold: \`~831\` tokens in \`system[2]\` (updated \`MEMORY.md\` block) + **\`~21,126\` tokens in \`messages\`** (\`58,385\` chars = compacted summary + preserved tail segment) |
| **Turn 21 First Post-Compaction Total Prompt Tokens** | **\`32,579\` tokens** | \`10,619\` warm read (\`32.6%\`) + \`21,957\` cold write (\`67.4%\`) + \`3\` uncached input |

- **Key Finding on \`tools/system\` Cache Survival & Auto-Memory Confound:**
  1. **\`tools + system[0..1]\` (\`10,619\` tokens) survives compaction on the same model:** Compaction replaces \`messages\` (and preserves the latest tail segment), but does **not** bust the \`tools + system[0..1]\` cache prefix (\`10,619\` tokens read at warm rate on Turn 21). When switching models immediately after compaction (\`S-A\`: Opus -> Sonnet), those \`10,619\` \`tools + system[0..1]\` tokens will be cold-written on Sonnet instead of read warm on Opus.
  2. **Turn 2 Auto-Memory Confound Discovered in \`C1_r01\`:** On Turn 2 (\`13\` requests, \`$0.1473\`), Claude Code's built-in auto-memory tried to persist \`NC1..NC4\` into \`claude_config/projects/.../memory/MEMORY.md\` via \`Bash\`/\`python3\`. That both inflated Turn 2 from \`2\` requests to \`13\` requests **and** injected \`MEMORY.md\` into \`system[2]\` after compaction (contributing to \`C1_r01\` scoring \`0/4\` constraint violations, \`0\` ghost reverts, and \`3/3\` recall). For Phase 2 runs, if you want pure compaction isolation without \`MEMORY.md\` assistance (and \`~\$0.125/run\` lower cost), we can set \`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1\`.

---

## 2. Phase 1: Boundary Detector Replay — Labeled **UNVERIFIED**

- **Status:** **UNVERIFIED**
  - The \`78\` existing benchmark transcripts (\`1,240\` turns) contain **\`0\` task boundaries** (\`0\` test-suite executions following code edits/failures).
  - The earlier synthetic preview trajectories have been removed from \`phase1_boundary_detector.csv\` because their turns and labels came from the same author as the detector.
  - Below is the detector's evaluation on the live **\`C1_r01\` pilot transcript (\`30\` turns, \`n = 1\`)** using labels derived **strictly from the scripted 30-turn plan** (\`4\` \`task_boundary\` turns at \`T6, T12, T16, T20\`; \`2\` \`mid_debug\` turns at \`T5, T15\`; \`24\` \`other\` turns):

| Dataset Group | Sessions | Turns | Plan \`task_boundary\` | Plan \`mid_debug\` | Plan \`other\` | TP | FP | FN | TN | Precision | Recall | False Prompts / 100 Turns | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Existing Benchmark Transcripts** (\`C1, C2, Cal, TH\`) | \`78\` | \`1,240\` | \`0\` | \`0\` | \`1,240\` | \`0\` | \`0\` | \`0\` | \`1,240\` | N/A | N/A | \`0.00\` | **UNVERIFIED (\`0\` boundaries)** |
| **Live Phase 2 Pilot Transcript (\`C1_r01\`, scripted turn-plan labels)** | \`1\` | \`30\` | \`4\` (\`T6, T12, T16, T20\`) | \`2\` (\`T5, T15\`) | \`24\` | **\`4\`** | **\`1\`** (\`T30\`) | **\`0\`** | **\`25\`** | **\`80.00%\` (\`4/5\`)** | **\`100.0%\` (\`4/4\`)** | **\`3.33\`** | **UNVERIFIED (\`n = 1\` pilot)** |

*(Note: The single \`FP\` on \`C1_r01\` is at Turn 30, where the agent edited \`src/exporter.mjs\` on Turn 29 and passed \`node --test test/suite.test.mjs\` on Turn 30; the scripted 30-turn plan labels Turn 30 as \`other\` because the session ends at Turn 30 rather than starting new work on Turn 31.)*

---

## 3. Recomputed Phase 2 Cost Estimate From Pilot \`C1_r01\` With \`+15%\` Margin

- **Account Available Credit Balance (\`/api/v1/credits\`):** **\`\$78.52\`** (\`\$78.517771\`; **\`\$77.52\` usable** after \`\$1.00\` reserve)
- **Current Per-Key Cap Remaining (\`/api/v1/key\`, \`limit = \$50.00\`):** **\`\$9.171195\`** (**\`\$8.1712\` usable** after \`\$1.00\` reserve unless key cap is raised)
- **Arm Changes Applied:**
  - Dropped \`S-B\` and \`S-C\` (\`S-C\` is covered by \`L1\`/\`L2\`).
  - Set \`S-A\` and \`S-D\` to \`n = 1\` each.
  - Changed \`C3\` to re-inject constraints via \`SessionStart(source="compact")\` \`additionalContext\` (\`c3_sessionstart_compact_hook.mjs\`).
  - Ordered by requested priority: **\`C1, C2, C0, C3, S-A, S-D, T1, C4\`**.

### A. Strict Priority Table (\`C1\` 2 Remaining, \`C2\` n=3, \`C0\` n=3, \`C3\` n=3, \`S-A\` n=1, \`S-D\` n=1, \`T1\` n=2, \`C4\` n=2)

| Priority | Arm | Schedule & Design | Planned \`n\` | Done in Pilot | Remaining Runs | Pilot Base / Run | **\`+15%\` Margin / Run** | Abort Cap / Run | Arm Total (Base) | **Arm Total (\`+15%\`)** | Cum. Rem. Runs | Cum. Base Cost | **Cum. \`+15%\` Cost** | Fits \`\$78.52\` Account Balance? | Fits Current \`\$50\` Key Cap (\`\$8.17\` Usable)? |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${remainingArmsSpec
  .map(
    (a) =>
      `| **${a.priorityRank}** | **\`${a.arm}\`** | ${a.modelSchedule} | \`${a.totalPlannedN}\` | \`${a.completedPilotN}\` | \`${a.remainingN}\` | \`$${a.pilotBasePerRunUsd.toFixed(4)}\` | **\`$${a.perRunPlus15PctUsd.toFixed(4)}\`** | \`$${a.abortCapUsd.toFixed(2)}\` | \`$${a.armRemainingBaseUsd.toFixed(4)}\` | **\`$${a.armRemainingPlus15PctUsd.toFixed(4)}\`** | \`${a.cumulativeRemainingRuns}\` | \`$${a.cumulativeBaseUsd.toFixed(4)}\` | **\`$${a.cumulativePlus15PctUsd.toFixed(4)}\`** | ${a.fitsAccountBudgetAtPlus15Pct ? '**YES**' : '**NO**'} | ${a.fitsCurrentKeyCapAtPlus15Pct ? '**YES**' : 'Raise key cap'} |`
  )
  .join('\n')}

### B. Summary Against Account Balance (\`\$78.52\`) vs. Per-Key Spend Cap (\`\$9.17\` Remaining on \`\$50\` Cap)

1. **Full 8-Arm Matrix (\`17\` remaining runs = \`\$20.6423\` base / \`\$23.7384\` with \`+15%\` margin):**
   - **Fits the \`\$78.52\` OpenRouter account balance** with **\`~\$54.78\`** remaining after all 8 arms (\`C1, C2, C0, C3, S-A, S-D, T1, C4\`) complete at full planned replicate counts (\`n = 3\` for \`C0..C3\`, \`n = 1\` for \`S-A, S-D\`, \`n = 2\` for \`T1, C4\`).
   - **Note on API key cap:** Because the active API key currently has a \`\$50.00\` per-key spend limit (\`usage = \$40.828805\`, \`limit_remaining = \$9.171195\`), running the full \`\$20.64\`–\`\$23.74\` Phase 2 matrix requires raising that key's limit from \`\$50\` to \`>=\$75\` (or removing the per-key cap) in OpenRouter Keys settings.
2. **If Keeping the Existing \`\$50\` Per-Key Cap (\`\$8.1712\` Usable After \`\$1.00\` Reserve):**
   - Fits \`C1\` (\`2\` remaining runs) + \`C2\` (\`3\` runs) + \`C0\` (\`1\` run) = **\`\$6.8560\` base / \`\$7.8843\` at \`+15%\`**, or \`n = 2\` across \`C1, C2, C0\` + \`n = 1\` on \`C3\` = **\`\$6.7214\` base / \`\$7.7296\` at \`+15%\`**.
`;

fs.writeFileSync(path.join(SMART_COMPACT_DIR, 'phase0_compact_hooks.md'), phase0UpdatedMd, 'utf8');
fs.writeFileSync(path.join(RESULTS_ROOT, 'phase0_compact_hooks.md'), phase0UpdatedMd, 'utf8');


// 5. Sanitize all files under SMART_COMPACT_DIR so zero usernames, paths, UUIDs, msg_01*, or gen-* remain
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

sanitizeSmartCompactDir(SMART_COMPACT_DIR);

console.log(
  JSON.stringify(
    {
      status: 'PILOT_ANALYSIS_UPDATED_OK',
      phase1ScriptedPlanDetectorEval: pilotSummary.phase1ScriptedPlanDetectorEval,
      postCompactionTurn21Split: pilotSummary.postCompactionTurn21Split,
      recomputedPhase2EstimateFromPilot: pilotSummary.recomputedPhase2EstimateFromPilot
    },
    null,
    2
  )
);
