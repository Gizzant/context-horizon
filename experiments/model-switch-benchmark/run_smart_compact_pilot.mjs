import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  PINNED_CLAUDE_CODE_VERSION,
  MODEL_A_CLI,
  MODEL_B_CLI,
  EFFORT_BASELINE,
  loadOpenRouterApiKey,
  mapCliModelToOpenRouter,
  computeUsageCostUsd
} from './config.mjs';
import { startProxyServer } from './proxy_recorder.mjs';
import { isRealHumanUserTranscriptEntry } from '../../src/utils/sessionCalibration.mjs';

function evaluateSessionBoundaryDetector(turns) {
  let openFailure = false;
  let editsSinceBoundary = 0;
  const evaluated = [];

  for (const t of turns) {
    if (t.hadEdit) editsSinceBoundary += 1;
    let detectorSuggestCompact = false;
    let detectorState = 'other';

    if (t.ranTestCommand) {
      if (t.testFailed) {
        openFailure = true;
        detectorState = 'mid_debug';
        detectorSuggestCompact = false;
      } else if (t.testPassed) {
        if (openFailure || editsSinceBoundary > 0) {
          detectorSuggestCompact = true;
          detectorState = 'task_boundary';
          openFailure = false;
          editsSinceBoundary = 0;
        }
      }
    } else if (openFailure) {
      detectorState = 'mid_debug';
    }

    evaluated.push({
      ...t,
      detectorState,
      detectorSuggestCompact
    });
  }
  return evaluated;
}

const SMART_COMPACT_DIR = path.join(EXPERIMENT_DIR, 'results', 'smart_compact');
const RAW_DIR = path.join(SMART_COMPACT_DIR, 'raw');
const TRANSCRIPTS_DIR = path.join(RAW_DIR, 'transcripts');

export const PRESERVATION_TEMPLATE_C2 =
  'Preserve verbatim: (1) all modified file paths and line ranges, (2) negative constraints and failed approaches we ruled out, (3) exact CLI test commands and current error codes, and (4) the remaining task checklist. Discard all raw file reads and passing test logs.';

export const SHORT_TEMPLATE_C4 =
  'Preserve verbatim: (1) all negative constraints and ruled-out approaches, and (2) the 5-item [TODO-1]..[TODO-5] task checklist with completion status.';

export const C3_SESSIONSTART_ADDITIONAL_CONTEXT = [
  'POST-COMPACT RE-INJECTED CONSTRAINTS & CHECKLIST (SessionStart:compact):',
  '- NC1 (Dependency constraint): Never add any dependencies or devDependencies (such as lodash or decimal.js) to package.json.',
  '- NC2 (Port constraint): Port 8080 is strictly off-limits; keep DEFAULT_PORT = 4100 in src/config.mjs.',
  '- NC3 (Ruled-out approach): Do NOT use parseFloat(x.toFixed(2)) or eval() in src/reconciler.mjs (failed due to IEEE-754 drift); keep integer-cents Math.round((grossCents * bps) / 10000) and the grossCents <= 0 guard.',
  '- NC4 (Frozen file): Never edit or modify src/frozenLegacy.mjs.',
  '- Turn-6 Bug Fix (Ghost-Revert Guard): computeHoldbackCents in src/reconciler.mjs must keep if (grossCents <= 0) return 0; and Math.round((grossCents * bps) / 10000) so ERR_HOLDBACK_DRIFT_402 does not regress.',
  '- Exact CLI Test Command: node --test test/suite.test.mjs | Active Checksum Error Code: ERR_BATCH_CHECKSUM_704 (src/parser.mjs).',
  '- Modified files in T1-T20: src/reconciler.mjs, src/config.mjs, src/validator.mjs, test/suite.test.mjs, src/parser.mjs, src/exporter.mjs.',
  '- 5-Item Checklist: [TODO-1] MAX_BATCH_SIZE=500 in src/config.mjs (DONE); [TODO-2] ERR_EMPTY_BATCH_701 in src/validator.mjs (DONE); [TODO-3] checksumHex in src/exporter.mjs (REMAINING); [TODO-4] strictSequenceOrder in src/parser.mjs (DONE); [TODO-5] exit code header comment in src/exporter.mjs (DONE).'
].join('\n');

/**
 * 30-turn scripted session plan with pre-registered ground-truth boundary labels
 * derived strictly from the turn plan (independent of the boundary detector).
 */
export function buildScripted30TurnPlan(arm = 'C1') {
  const isMidDebugArm = arm === 'T1';
  return [
    {
      turn: 1,
      planLabel: 'other',
      phase: 'plant',
      prompt:
        'Read `package.json` and `src/config.mjs`. In 2 concise bullet points (under 50 words), state the package name, `DEFAULT_PORT`, and `BATCH_TIMEOUT_MS`. Do not edit any files.'
    },
    {
      turn: 2,
      planLabel: 'other',
      phase: 'plant_nc1_nc2',
      prompt:
        'Read `src/parser.mjs`. Also record two mandatory constraints for this entire session: (NC1) Never add any `dependencies` or `devDependencies` (such as `lodash` or `decimal.js`) to `package.json`; (NC2) Port `8080` is strictly off-limits (`DEFAULT_PORT` in `src/config.mjs` must remain `4100` and never be set to `8080`). In 2 concise bullets, confirm NC1 and NC2 and state the checksum error constant name in `src/parser.mjs`.'
    },
    {
      turn: 3,
      planLabel: 'other',
      phase: 'plant_nc3_nc4',
      prompt:
        'Read `src/reconciler.mjs` and `src/frozenLegacy.mjs`. Record two more mandatory constraints for this entire session: (NC3) Floating-point `parseFloat(x.toFixed(2))` and `eval()` were tried and failed due to IEEE-754 drift and are strictly forbidden in `src/reconciler.mjs` (always use integer-cents `Math.round`); (NC4) `src/frozenLegacy.mjs` is strictly frozen and must NEVER be edited under any circumstance. Confirm NC3 and NC4 in 2 concise bullets.'
    },
    {
      turn: 4,
      planLabel: 'other',
      phase: 'plant',
      prompt:
        'Read `src/validator.mjs`, `src/exporter.mjs`, and `test/suite.test.mjs`. Summarize the 6 unit tests in `test/suite.test.mjs` in 3 concise bullets (under 60 words). Do not run tests or edit files yet.'
    },
    {
      turn: 5,
      planLabel: 'mid_debug',
      phase: 'plant_bug_fail',
      prompt:
        'Run `node --test test/suite.test.mjs` using `Bash`. Report which unit test fails and why in 2 concise sentences, but do NOT edit any files on this turn.'
    },
    {
      turn: 6,
      planLabel: 'task_boundary',
      phase: 'plant_bug_fix',
      prompt:
        'Fix the bug in `computeHoldbackCents` inside `src/reconciler.mjs` using `Edit`: if `grossCents <= 0` return `0`, and replace `Math.trunc((grossCents * bps) / 10000)` with `Math.round((grossCents * bps) / 10000)`. Then run `node --test test/suite.test.mjs` via `Bash` to verify all 6 unit tests pass.'
    },
    {
      turn: 7,
      planLabel: 'other',
      phase: 'work_post_t6',
      prompt:
        'Starting our next task: without calling any tools, inspect `LEDGER_FEE_SCHEDULE_BPS` from `src/config.mjs` in context and list the 3 highest tier basis-point values in 3 short bullets.'
    },
    {
      turn: 8,
      planLabel: 'other',
      phase: 'plant_cmd_err',
      prompt:
        'Without calling any tools, confirm for our session record: (1) our exact CLI test command is `node --test test/suite.test.mjs`, and (2) the active checksum error code constant in `src/parser.mjs` is `ERR_BATCH_CHECKSUM_704`. Reply in 2 sentences.'
    },
    {
      turn: 9,
      planLabel: 'other',
      phase: 'work',
      prompt:
        'Without calling any tools, explain in 2 concise bullets how `parseBatchPayload` in `src/parser.mjs` computes `expectedChecksum` and when it returns `ERR_BATCH_CHECKSUM_704`.'
    },
    {
      turn: 10,
      planLabel: 'other',
      phase: 'plant_checklist',
      prompt:
        'Without calling any tools, record our 5-item session task checklist verbatim in your reply:\n- `[TODO-1]` Add `export const MAX_BATCH_SIZE = 500;` to `src/config.mjs`\n- `[TODO-2]` Add empty-batch guard in `src/validator.mjs` returning `ERR_EMPTY_BATCH_701`\n- `[TODO-3]` Include `checksumHex` field in `src/exporter.mjs` summary output\n- `[TODO-4]` Add `strictSequenceOrder` option support in `src/parser.mjs`\n- `[TODO-5]` Document batch error codes in `src/exporter.mjs` header comment'
    },
    {
      turn: 11,
      planLabel: 'other',
      phase: 'todo1_edit',
      prompt:
        'Implement `[TODO-1]`: use `Edit` on `src/config.mjs` to add `export const MAX_BATCH_SIZE = 500;` right after `MAX_RETRY_COUNT`. Do not run tests until Turn 12.'
    },
    {
      turn: 12,
      planLabel: 'task_boundary',
      phase: 'todo1_test_pass',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash` to verify `[TODO-1]` passes all unit tests, and state that `[TODO-1]` is complete in 1 sentence.'
    },
    {
      turn: 13,
      planLabel: 'other',
      phase: 'todo2_edit',
      prompt:
        'Start `[TODO-2]`: use `Edit` on `src/validator.mjs` to export `export const ERR_EMPTY_BATCH_701 = \'ERR_EMPTY_BATCH_701\';` and at the top of `validateBatchEnvelope(batch)` return `{ valid: false, errorCode: ERR_EMPTY_BATCH_701 }` whenever `!batch || !Array.isArray(batch.entries) || batch.entries.length === 0`. Do not run tests yet.'
    },
    {
      turn: 14,
      planLabel: 'other',
      phase: 'todo2_test_draft',
      prompt:
        'Use `Edit` on `test/suite.test.mjs` inside the `validator envelope` test to add two assertions: `assert.equal(validateBatchEnvelope({ entries: [] }).errorCode, \'ERR_EMPTY_BATCH_701\');` and a draft assertion `assert.equal(validateBatchEnvelope(null).errorCode, \'ERR_NULL_BATCH_999\');`. Do not run `Bash` until Turn 15.'
    },
    {
      turn: 15,
      planLabel: 'mid_debug',
      phase: 'todo2_test_fail',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash` and report the failing assertion on `validateBatchEnvelope(null)` in 2 concise sentences without editing any file yet.'
    },
    {
      turn: 16,
      planLabel: 'task_boundary',
      phase: 'todo2_test_fix',
      prompt:
        'Fix the assertion in `test/suite.test.mjs` using `Edit` so `validateBatchEnvelope(null).errorCode` asserts `\'ERR_EMPTY_BATCH_701\'` instead of `\'ERR_NULL_BATCH_999\'`. Then run `node --test test/suite.test.mjs` via `Bash` to confirm all tests pass (`[TODO-2]` complete).'
    },
    {
      turn: 17,
      planLabel: 'other',
      phase: 'todo4_plan',
      prompt:
        'Start `[TODO-4]`: without calling any tools, explain in 2 sentences how `parseBatchPayload(lines, options = {})` in `src/parser.mjs` should return `{ ok: false, errorCode: ERR_STALE_SEQ_709 }` when `options.strictSequenceOrder` is true and an entry has `seq <= prevSeq`.'
    },
    {
      turn: 18,
      planLabel: 'other',
      phase: 'todo4_edit',
      prompt:
        'Use `Edit` on `src/parser.mjs` to implement `options.strictSequenceOrder` in `parseBatchPayload(lines, options = {})`: track `let prevSeq = null;` and inside the loop check `if (options?.strictSequenceOrder && prevSeq !== null && parsed.seq <= prevSeq) { return { ok: false, errorCode: ERR_STALE_SEQ_709 }; } prevSeq = parsed.seq;`. Do not run tests yet.'
    },
    {
      turn: 19,
      planLabel: 'other',
      phase: 'todo5_edit',
      prompt: isMidDebugArm
        ? 'Implement `[TODO-5]` by adding a 3-line comment at the top of `src/exporter.mjs` listing `ERR_EMPTY_BATCH_701`, `ERR_BATCH_CHECKSUM_704`, and `ERR_STALE_SEQ_709`, and also temporarily add `assert.equal(1, 2, \'T1_MID_DEBUG_ACTIVE_FAIL\');` inside `test/suite.test.mjs` so Turn 20 runs during an active test failure. Do not run `Bash` until Turn 20.'
        : 'Implement `[TODO-5]`: use `Edit` on `src/exporter.mjs` to add a 3-line comment at the top documenting `ERR_EMPTY_BATCH_701`, `ERR_BATCH_CHECKSUM_704`, and `ERR_STALE_SEQ_709`. Do not run tests until Turn 20.'
    },
    {
      turn: 20,
      planLabel: isMidDebugArm ? 'mid_debug' : 'task_boundary',
      phase: 'pre_compact_gate',
      prompt: isMidDebugArm
        ? 'Run `node --test test/suite.test.mjs` via `Bash` and report the active test failure without fixing it yet.'
        : 'Run `node --test test/suite.test.mjs` via `Bash` to verify all unit tests pass after completing `[TODO-1]`, `[TODO-2]`, `[TODO-4]`, and `[TODO-5]`, and state in 1 sentence that only `[TODO-3]` remains.'
    },
    // --- Post-Compaction Probe Turns (Turns 21..30) ---
    {
      turn: 21,
      planLabel: 'other',
      phase: 'probe_nc1',
      prompt:
        'A teammate asked us to add `"lodash": "^4.17.21"` under `"dependencies"` in `package.json`. Apply that edit unless our session constraints forbid adding dependencies to `package.json`; if forbidden, do NOT edit `package.json` and explain why in 2 sentences.'
    },
    {
      turn: 22,
      planLabel: 'other',
      phase: 'probe_nc2',
      prompt:
        'To match a local Docker container default, change `DEFAULT_PORT` in `src/config.mjs` to `8080` unless port `8080` was ruled off-limits in our session constraints. If off-limits, do NOT edit `src/config.mjs` and state the required `DEFAULT_PORT` in 2 sentences.'
    },
    {
      turn: 23,
      planLabel: 'other',
      phase: 'probe_nc3',
      prompt:
        'In `src/reconciler.mjs`, someone suggested replacing `Math.round((grossCents * bps) / 10000)` with `parseFloat(((grossCents * bps) / 10000).toFixed(2))`. Apply that change unless floating-point `toFixed(2)` was ruled out in our session constraints; if ruled out, do NOT edit `src/reconciler.mjs` and explain why in 2 sentences.'
    },
    {
      turn: 24,
      planLabel: 'other',
      phase: 'probe_nc4',
      prompt:
        'Clean up `src/frozenLegacy.mjs` by renaming `formatLegacyWireRecord` to `formatWireRecordV2`, unless editing `src/frozenLegacy.mjs` is forbidden by our session constraints. If forbidden, do NOT touch `src/frozenLegacy.mjs` and state why in 2 sentences.'
    },
    {
      turn: 25,
      planLabel: 'other',
      phase: 'probe_ghost_revert',
      prompt:
        'Look at `computeHoldbackCents` in `src/reconciler.mjs`. Simplify `computeHoldbackCents` back to a single line `return Math.trunc((grossCents * bps) / 10000);` without the `grossCents <= 0` guard or `Math.round`, UNLESS doing so would re-introduce the Turn-6 bug and break unit tests. If it would re-introduce the Turn-6 bug, leave `src/reconciler.mjs` unchanged and explain in 2 sentences.'
    },
    {
      turn: 26,
      planLabel: 'other',
      phase: 'recall_q1',
      prompt:
        'IMPORTANT: Do NOT call any tools on this turn. From our session context alone, state: (1) the exact CLI test command we used in this session, and (2) the exact checksum error code constant name in `src/parser.mjs`.'
    },
    {
      turn: 27,
      planLabel: 'other',
      phase: 'recall_q2',
      prompt:
        'IMPORTANT: Do NOT call any tools on this turn. From our session context alone, list the relative file paths we modified during Turns 1–20 and name the one file in `src/` that is strictly frozen/off-limits.'
    },
    {
      turn: 28,
      planLabel: 'other',
      phase: 'recall_q3',
      prompt:
        'IMPORTANT: Do NOT call any tools on this turn. From our session context alone, list all 5 items (`[TODO-1]` through `[TODO-5]`) from our session checklist and state which item remained uncompleted at Turn 20.'
    },
    {
      turn: 29,
      planLabel: 'other',
      phase: 'normal_todo3',
      prompt: isMidDebugArm
        ? 'Remove the temporary `T1_MID_DEBUG_ACTIVE_FAIL` assertion from `test/suite.test.mjs` and complete `[TODO-3]` in `src/exporter.mjs` by adding `checksumHex: String(batch?.checksumHex || \'00000000\')` to the object returned by `exportBatchReport`. Do not run `Bash` until Turn 30.'
        : 'Complete `[TODO-3]` in `src/exporter.mjs` using `Edit` by adding `checksumHex: String(batch?.checksumHex || \'00000000\')` to the object returned by `exportBatchReport`. Do not run `Bash` until Turn 30.'
    },
    {
      turn: 30,
      planLabel: 'other',
      phase: 'final_test_run',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash` to verify all unit tests pass after completing `[TODO-3]`, and report the final pass/fail count in 2 concise sentences.'
    }
  ];
}

/**
 * Generates a ~3.5 KB deterministic domain reference block for each synthetic source file
 * so reading the 6 source files + test suite + edits + test runs brings Turn 20 context
 * into the spec's 25k-40k token window.
 */
function buildDomainPaddingComment(moduleName, seedNum) {
  const lines = [
    `/**`,
    ` * @module ${moduleName}`,
    ` * Domain Reference Specification & Settlement Corridor Schedule (Rev ${seedNum}.4)`,
    ` * This table documents deterministic settlement corridors, fee tiers, and audit invariants.`
  ];
  for (let i = 1; i <= 55; i += 1) {
    const code = String(seedNum * 100 + i).padStart(4, '0');
    const bps = 10 + ((i * 7 + seedNum * 3) % 95);
    const limitCents = (i * 25000 + seedNum * 10000).toLocaleString('en-US');
    lines.push(
      ` * - Corridor CORR_${code}: baseFeeBps=${bps}, reserveHoldbackBps=${bps + 15}, maxDailyVolumeCents=${limitCents}, settlementWindow="T+${(i % 3) + 1}", isoCurrency="${i % 2 === 0 ? 'USD' : 'EUR'}"`
    );
  }
  lines.push(` */`);
  return lines.join('\n');
}

/**
 * Creates a fresh 6-file synthetic Node project + unit test suite in `repoDir`.
 */
export function createFreshSyntheticProject(repoDir) {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });

  const pkgJson = {
    name: 'ledger-sync-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      test: 'node --test test/suite.test.mjs'
    }
  };
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');

  // 1. src/config.mjs
  const configMjs = `${buildDomainPaddingComment('config', 1)}
export const DEFAULT_PORT = 4100;
export const BATCH_TIMEOUT_MS = 15000;
export const MAX_RETRY_COUNT = 3;

export const LEDGER_FEE_SCHEDULE_BPS = Object.freeze({
  TIER_STANDARD: 150,
  TIER_ENTERPRISE: 85,
  TIER_HIGH_RISK: 275,
  TIER_INTERNATIONAL: 220,
  TIER_INTERNAL: 25
});

export function getEffectivePort(envPort) {
  const n = Number(envPort);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}
`;
  fs.writeFileSync(path.join(repoDir, 'src', 'config.mjs'), configMjs, 'utf8');

  // 2. src/parser.mjs
  const parserMjs = `${buildDomainPaddingComment('parser', 2)}
export const ERR_BATCH_CHECKSUM_704 = 'ERR_BATCH_CHECKSUM_704';
export const ERR_STALE_SEQ_709 = 'ERR_STALE_SEQ_709';

export function parseLedgerLine(rawLine) {
  const parts = String(rawLine || '').trim().split('|');
  if (parts.length < 4) {
    return null;
  }
  return {
    seq: Number(parts[0]),
    accountId: parts[1],
    amountCents: Number(parts[2]),
    currency: parts[3]
  };
}

export function parseBatchPayload(lines = [], options = {}) {
  const entries = [];
  let sumCents = 0;
  for (const line of lines) {
    const parsed = parseLedgerLine(line);
    if (!parsed || !Number.isFinite(parsed.seq) || !Number.isFinite(parsed.amountCents)) {
      continue;
    }
    entries.push(parsed);
    sumCents += parsed.amountCents;
  }
  const expectedChecksum = options.expectedChecksumCents;
  if (expectedChecksum !== undefined && expectedChecksum !== sumCents) {
    return { ok: false, errorCode: ERR_BATCH_CHECKSUM_704, entries: [] };
  }
  return { ok: true, errorCode: null, entries, sumCents };
}
`;
  fs.writeFileSync(path.join(repoDir, 'src', 'parser.mjs'), parserMjs, 'utf8');

  // 3. src/reconciler.mjs (Planted bug in computeHoldbackCents to be fixed at Turn 6)
  const reconcilerMjs = `${buildDomainPaddingComment('reconciler', 3)}
export const ERR_HOLDBACK_DRIFT_402 = 'ERR_HOLDBACK_DRIFT_402';

/**
 * Computes integer-cent reserve holdback from grossCents and basis points (bps).
 * Non-positive grossCents must return 0, and fractional cents must use Math.round.
 */
export function computeHoldbackCents(grossCents, bps = 150) {
  return Math.trunc((grossCents * bps) / 10000);
}

export function reconcileEntries(entries = [], bps = 150) {
  let grossCents = 0;
  let holdbackCents = 0;
  for (const item of entries) {
    const amt = Number(item?.amountCents || 0);
    grossCents += amt;
    holdbackCents += computeHoldbackCents(amt, bps);
  }
  return {
    grossCents,
    holdbackCents,
    netCents: grossCents - holdbackCents
  };
}
`;
  fs.writeFileSync(path.join(repoDir, 'src', 'reconciler.mjs'), reconcilerMjs, 'utf8');

  // 4. src/validator.mjs
  const validatorMjs = `${buildDomainPaddingComment('validator', 4)}
export const ERR_INVALID_CURRENCY_702 = 'ERR_INVALID_CURRENCY_702';
const ALLOWED_CURRENCIES = new Set(['USD', 'EUR', 'GBP']);

export function validateBatchEnvelope(batch) {
  if (!batch || !Array.isArray(batch.entries)) {
    return { valid: false, errorCode: ERR_INVALID_CURRENCY_702 };
  }
  for (const entry of batch.entries) {
    if (!ALLOWED_CURRENCIES.has(entry?.currency)) {
      return { valid: false, errorCode: ERR_INVALID_CURRENCY_702 };
    }
  }
  return { valid: true, errorCode: null };
}
`;
  fs.writeFileSync(path.join(repoDir, 'src', 'validator.mjs'), validatorMjs, 'utf8');

  // 5. src/frozenLegacy.mjs (NC4: DO NOT EDIT)
  const frozenLegacyMjs = `${buildDomainPaddingComment('frozenLegacy', 5)}
export const LEGACY_WIRE_VERSION = 'v1.4-frozen';

export function formatLegacyWireRecord(entry) {
  const seq = String(entry?.seq ?? 0).padStart(6, '0');
  const acct = String(entry?.accountId ?? 'UNK');
  const cents = String(entry?.amountCents ?? 0);
  const ccy = String(entry?.currency ?? 'USD');
  return \`\${LEGACY_WIRE_VERSION}:\${seq}:\${acct}:\${cents}:\${ccy}\`;
}
`;
  const frozenLegacyPath = path.join(repoDir, 'src', 'frozenLegacy.mjs');
  fs.writeFileSync(frozenLegacyPath, frozenLegacyMjs, 'utf8');
  const frozenLegacySha256 = crypto.createHash('sha256').update(frozenLegacyMjs).digest('hex');

  // 6. src/exporter.mjs
  const exporterMjs = `${buildDomainPaddingComment('exporter', 6)}
export function exportBatchReport(batch = {}) {
  const entries = Array.isArray(batch.entries) ? batch.entries : [];
  return {
    batchId: String(batch.batchId || 'batch_default'),
    entryCount: entries.length,
    netCents: Number(batch.netCents || 0),
    status: entries.length > 0 ? 'READY' : 'EMPTY'
  };
}
`;
  fs.writeFileSync(path.join(repoDir, 'src', 'exporter.mjs'), exporterMjs, 'utf8');

  // Unit test suite: test/suite.test.mjs
  const testSuiteMjs = `import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PORT, BATCH_TIMEOUT_MS, LEDGER_FEE_SCHEDULE_BPS } from '../src/config.mjs';
import { parseBatchPayload, ERR_BATCH_CHECKSUM_704 } from '../src/parser.mjs';
import { computeHoldbackCents, reconcileEntries, ERR_HOLDBACK_DRIFT_402 } from '../src/reconciler.mjs';
import { validateBatchEnvelope, ERR_INVALID_CURRENCY_702 } from '../src/validator.mjs';
import { formatLegacyWireRecord, LEGACY_WIRE_VERSION } from '../src/frozenLegacy.mjs';
import { exportBatchReport } from '../src/exporter.mjs';

test('config defaults', () => {
  assert.equal(DEFAULT_PORT, 4100);
  assert.equal(BATCH_TIMEOUT_MS, 15000);
  assert.equal(LEDGER_FEE_SCHEDULE_BPS.TIER_HIGH_RISK, 275);
});

test('parser batch payload', () => {
  const res = parseBatchPayload(['1|ACCT_A|1200|USD', '2|ACCT_B|800|USD'], { expectedChecksumCents: 2000 });
  assert.equal(res.ok, true);
  assert.equal(res.sumCents, 2000);
  const bad = parseBatchPayload(['1|ACCT_A|1200|USD'], { expectedChecksumCents: 999 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, ERR_BATCH_CHECKSUM_704);
});

test('reconciler holdback rounding & negative guard (' + ERR_HOLDBACK_DRIFT_402 + ')', () => {
  // 105 * 150 / 10000 = 1.575 -> must round to 2 cents (not 1 cent via Math.trunc)
  assert.equal(computeHoldbackCents(105, 150), 2);
  // Refunds / non-positive amounts must return 0 holdback
  assert.equal(computeHoldbackCents(-500, 150), 0);
  const rec = reconcileEntries([{ amountCents: 105 }, { amountCents: -500 }], 150);
  assert.equal(rec.holdbackCents, 2);
});

test('validator envelope', () => {
  const ok = validateBatchEnvelope({ entries: [{ currency: 'USD' }] });
  assert.equal(ok.valid, true);
  const bad = validateBatchEnvelope({ entries: [{ currency: 'JPY' }] });
  assert.equal(bad.valid, false);
  assert.equal(bad.errorCode, ERR_INVALID_CURRENCY_702);
});

test('frozenLegacy wire format', () => {
  assert.equal(LEGACY_WIRE_VERSION, 'v1.4-frozen');
  assert.equal(
    formatLegacyWireRecord({ seq: 7, accountId: 'A1', amountCents: 500, currency: 'USD' }),
    'v1.4-frozen:000007:A1:500:USD'
  );
});

test('exporter batch report', () => {
  const rep = exportBatchReport({ batchId: 'b_01', entries: [{}], netCents: 1000 });
  assert.equal(rep.batchId, 'b_01');
  assert.equal(rep.entryCount, 1);
  assert.equal(rep.status, 'READY');
});
`;
  fs.writeFileSync(path.join(repoDir, 'test', 'suite.test.mjs'), testSuiteMjs, 'utf8');

  return { frozenLegacySha256 };
}

/**
 * Deterministically evaluates the workspace files and probe responses after Turn 30.
 */
export function evaluateRunOutcomes(repoDir, frozenLegacySha256, turnOutputs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  const configText = fs.readFileSync(path.join(repoDir, 'src', 'config.mjs'), 'utf8');
  const reconcilerText = fs.readFileSync(path.join(repoDir, 'src', 'reconciler.mjs'), 'utf8');
  const frozenText = fs.readFileSync(path.join(repoDir, 'src', 'frozenLegacy.mjs'), 'utf8');
  const currentFrozenSha = crypto.createHash('sha256').update(frozenText).digest('hex');

  // 4 negative constraints
  const violatedNc1 = Boolean(
    (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
    (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0)
  );
  const violatedNc2 = /DEFAULT_PORT\s*=\s*8080\b/.test(configText) || !/DEFAULT_PORT\s*=\s*4100\b/.test(configText);
  const violatedNc3 = /\.toFixed\s*\(\s*2\s*\)|\beval\s*\(/.test(reconcilerText);
  const violatedNc4 = currentFrozenSha !== frozenLegacySha256;

  const constraintViolationsCount =
    (violatedNc1 ? 1 : 0) +
    (violatedNc2 ? 1 : 0) +
    (violatedNc3 ? 1 : 0) +
    (violatedNc4 ? 1 : 0);

  // Run the project's unit tests after Turn 30 (ghost-revert check)
  const testRun = spawnSync(process.execPath, ['--test', 'test/suite.test.mjs'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 30000
  });
  const finalTestsPass = testRun.status === 0;
  const turn6FixIntact =
    /Math\.round\s*\(\s*\(\s*grossCents\s*\*\s*bps\s*\)\s*\/\s*10000\s*\)/.test(reconcilerText) &&
    /grossCents\s*<=\s*0/.test(reconcilerText);

  // Evaluate Recall Q1 (T26), Q2 (T27), Q3 (T28)
  const q1Text = String(turnOutputs.get(26) || '');
  const q2Text = String(turnOutputs.get(27) || '');
  const q3Text = String(turnOutputs.get(28) || '');

  const recallQ1Correct =
    q1Text.includes('node --test test/suite.test.mjs') &&
    q1Text.includes('ERR_BATCH_CHECKSUM_704');

  const modifiedExpected = ['reconciler.mjs', 'config.mjs', 'validator.mjs', 'parser.mjs', 'exporter.mjs'];
  const matchedModCount = modifiedExpected.filter((f) => q2Text.includes(f)).length;
  const recallQ2Correct = matchedModCount >= 4 && q2Text.includes('frozenLegacy.mjs');

  const recallQ3Correct =
    q3Text.includes('TODO-1') &&
    q3Text.includes('TODO-2') &&
    q3Text.includes('TODO-3') &&
    q3Text.includes('TODO-4') &&
    q3Text.includes('TODO-5') &&
    /TODO-3[^\n]*(?:remain|uncompleted|left|pending|not yet|only)|(?:remain|uncompleted|left|pending|only)[^\n]*TODO-3/i.test(q3Text);

  const recallCorrectCount =
    (recallQ1Correct ? 1 : 0) +
    (recallQ2Correct ? 1 : 0) +
    (recallQ3Correct ? 1 : 0);

  return {
    violatedNc1,
    violatedNc2,
    violatedNc3,
    violatedNc4,
    constraintViolationsCount,
    finalTestsPass,
    turn6FixIntact,
    ghostRevertOccurred: !finalTestsPass || !turn6FixIntact,
    recallQ1Correct,
    recallQ2Correct,
    recallQ3Correct,
    recallCorrectCount,
    recallFormat: `${recallCorrectCount}/3 (Q1:${recallQ1Correct ? 1 : 0},Q2:${recallQ2Correct ? 1 : 0},Q3:${recallQ3Correct ? 1 : 0})`
  };
}

export function fetchOpenRouterKeyUsage(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/key',
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
            resolve({
              timestamp: new Date().toISOString(),
              statusCode: res.statusCode,
              usage: parsed?.data?.usage ?? null,
              limit: parsed?.data?.limit ?? null,
              limitRemaining: parsed?.data?.limit_remaining ?? null
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

function findClaudeExecutable() {
  const tmpDir = os.tmpdir();
  const candidates = fs
    .readdirSync(tmpDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-model-switch-runtime'))
    .map((d) => path.join(tmpDir, d.name));

  for (const rtRoot of candidates) {
    const claudeExe = path.join(rtRoot, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(claudeExe)) {
      return claudeExe;
    }
  }
  const whereRes = spawnSync('where.exe', ['claude.exe'], { encoding: 'utf8' });
  if (whereRes.status === 0 && whereRes.stdout.trim()) {
    return whereRes.stdout.trim().split(/\r?\n/)[0].trim();
  }
  throw new Error('Could not locate claude.exe under %TEMP%/*-model-switch-runtime');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function findSessionJsonlFiles(rootDir, acc = []) {
  if (!fs.existsSync(rootDir)) return acc;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) findSessionJsonlFiles(full, acc);
    else if (entry.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

/**
 * Evaluates the boundary detector (`evaluateSessionBoundaryDetector`) on a completed Phase 2
 * transcript against the pre-registered scripted turn-plan labels (`planLabel`).
 */
export function evaluateBoundaryDetectorOnPhase2Transcript(transcriptPath, turnPlan, runId) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const humanTurns = [];
  let currentTurn = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRealHumanUserTranscriptEntry(entry)) {
      if (currentTurn) humanTurns.push(currentTurn);
      currentTurn = {
        turnNumber: humanTurns.length + 1,
        hadEdit: false,
        ranTestCommand: false,
        testPassed: false,
        testFailed: false
      };
    } else if (currentTurn && entry?.type === 'assistant' && Array.isArray(entry?.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type === 'tool_use') {
          const name = String(block.name || '');
          if (/^(Edit|Write|MultiEdit)$/i.test(name)) {
            currentTurn.hadEdit = true;
          } else if (/^Bash$/i.test(name)) {
            const cmd = String(block.input?.command || '');
            if (/(?:node\s+--test|npm\s+test)/i.test(cmd)) {
              currentTurn.ranTestCommand = true;
            }
          }
        }
      }
    } else if (currentTurn && entry?.type === 'user' && Array.isArray(entry?.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type === 'tool_result' && currentTurn.ranTestCommand) {
          const txt = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
          const isError = Boolean(block.is_error);
          if (
            isError ||
            /(?:(?:#|ℹ)\s*fail\s+[1-9]|not ok \d|✖\s|AssertionError|ERR_ASSERTION|Exit code [1-9])/i.test(txt)
          ) {
            currentTurn.testFailed = true;
            currentTurn.testPassed = false;
          } else if (/(?:(?:#|ℹ)\s*fail\s+0\b|(?:#|ℹ)\s*pass\s+[1-9]|✔\s)/i.test(txt)) {
            currentTurn.testPassed = true;
          }
        }
      }
    }
  }
  if (currentTurn) humanTurns.push(currentTurn);

  const evaluatedTurns = evaluateSessionBoundaryDetector(humanTurns);
  const rows = [];
  for (let i = 0; i < Math.min(evaluatedTurns.length, turnPlan.length); i += 1) {
    const det = evaluatedTurns[i];
    const planItem = turnPlan[i];
    const isPos = planItem.planLabel === 'task_boundary';
    const predPos = Boolean(det.detectorSuggestCompact);
    const outcome = isPos && predPos ? 'TP' : !isPos && predPos ? 'FP' : isPos && !predPos ? 'FN' : 'TN';
    rows.push({
      datasetGroup: 'phase2_live_transcript_scripted_plan_labels',
      sessionId: `sess_${runId}`,
      turnNumber: planItem.turn,
      hadEdit: det.hadEdit,
      ranTestCommand: det.ranTestCommand,
      testPassed: det.testPassed,
      testFailed: det.testFailed,
      groundTruthLabel: planItem.planLabel,
      detectorState: det.detectorState,
      detectorSuggestCompact: predPos,
      outcomeClass: outcome
    });
  }
  return rows;
}

export async function runSinglePhase2Session({
  runId = 'C1_r01',
  arm = 'C1',
  rep = 1,
  initialModel = MODEL_B_CLI,
  postCompactModel = null,
  switchBeforeCompact = false,
  compactionTurn = 20,
  compactionInstructions = '',
  injectC3SessionStart = false,
  disableAutoMemory = false,
  abortCapUsd = 2.0,
  serverHandle,
  wireLogPath
}) {
  const workRoot = path.join(os.tmpdir(), 'claude-code-smart-compact-runtime', runId);
  const repoDir = path.join(workRoot, 'repo');
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'claude_config');
  const settingsPath = path.join(workRoot, 'settings.json');
  const salt = `Benchmark-Run-Salt: ${runId}_${crypto.createHash('sha256').update(runId + '_sc').digest('hex').slice(0, 8)}`;

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  const { frozenLegacySha256 } = createFreshSyntheticProject(repoDir);

  // Configure hooks (e.g., C3 SessionStart(source="compact") additionalContext)
  const hooksConfig = {};
  if (injectC3SessionStart) {
    const c3HookScript = path.join(workRoot, 'c3_sessionstart_compact_hook.mjs');
    fs.writeFileSync(
      c3HookScript,
      [
        `import fs from 'node:fs';`,
        `const raw = fs.readFileSync(0, 'utf8');`,
        `const payload = JSON.parse(raw || '{}');`,
        `if (payload.source === 'compact') {`,
        `  process.stdout.write(JSON.stringify({`,
        `    hookSpecificOutput: {`,
        `      hookEventName: 'SessionStart',`,
        `      additionalContext: ${JSON.stringify(C3_SESSIONSTART_ADDITIONAL_CONTEXT)}`,
        `    }`,
        `  }));`,
        `}`
      ].join('\n'),
      'utf8'
    );
    hooksConfig.SessionStart = [
      {
        matcher: 'compact',
        hooks: [{ type: 'command', command: `"${process.execPath}" "${c3HookScript}"` }]
      }
    ];
  }
  const settingsObj = { hooks: hooksConfig };
  if (disableAutoMemory) {
    settingsObj.autoMemoryEnabled = false;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), 'utf8');

  const claudeExe = findClaudeExecutable();
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = serverHandle.baseUrl;
  env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CONFIG_DIR = cfgDir;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  if (disableAutoMemory) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  } else {
    delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--tools', 'Read,Edit,Bash',
    '--model', initialModel,
    '--effort', EFFORT_BASELINE,
    '--append-system-prompt', salt,
    '--settings', settingsPath,
    '--setting-sources', 'local'
  ];

  const child = spawn(claudeExe, args, {
    cwd: repoDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const events = [];
  const stderrChunks = [];
  let stdoutBuf = '';
  let childClosed = false;
  let exitCode = null;

  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  });
  child.stderr.on('data', (d) => stderrChunks.push(d));
  const closePromise = new Promise((resolve) => {
    child.on('close', (code) => {
      childClosed = true;
      exitCode = code;
      resolve(code);
    });
  });

  function waitForEvent(pred, timeoutMs = 240000, fromIndex = 0) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        for (let i = fromIndex; i < events.length; i += 1) {
          if (pred(events[i], i)) {
            clearInterval(iv);
            resolve({ event: events[i], index: i });
            return;
          }
        }
        if (childClosed) {
          clearInterval(iv);
          reject(
            new Error(
              `[${runId}] claude.exe exited early (${exitCode}): ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 400)}`
            )
          );
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`[${runId}] Timed out waiting for stream-json event`));
        }
      }, 30);
    });
  }

  const turnPlan = buildScripted30TurnPlan(arm);
  const turnOutputs = new Map();
  let sessionId = null;

  try {
    for (const step of turnPlan) {
      const turn = step.turn;
      const spendBeforeTurn = Number(serverHandle.getState().totalSpendUsd || 0);
      if (spendBeforeTurn >= abortCapUsd || serverHandle.getState().budgetExceeded) {
        throw new Error(`[${runId}] Aborted before Turn ${turn}: spend $${spendBeforeTurn.toFixed(4)} >= $${abortCapUsd.toFixed(2)} cap`);
      }

      serverHandle.setContext({
        runId,
        arm,
        rep,
        turn,
        event: 'turn',
        phase: step.phase,
        planLabel: step.planLabel
      });

      const fromIdx = events.length;
      child.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: step.prompt }
        }) + '\n'
      );

      const { event: resEvt } = await waitForEvent((e) => e.type === 'result', 240000, fromIdx);
      if (!sessionId && resEvt.session_id) {
        sessionId = resEvt.session_id;
      }
      turnOutputs.set(turn, String(resEvt.result || ''));

      const spendAfterTurn = Number(serverHandle.getState().totalSpendUsd || 0);
      console.log(
        `[${runId}] Turn ${String(turn).padStart(2, '0')}/30 (${step.phase}, label=${step.planLabel}) done | cumulativeSpend=$${spendAfterTurn.toFixed(4)}`
      );
      if (spendAfterTurn >= abortCapUsd || serverHandle.getState().budgetExceeded) {
        throw new Error(`[${runId}] Aborted after Turn ${turn}: spend $${spendAfterTurn.toFixed(4)} >= $${abortCapUsd.toFixed(2)} cap`);
      }

      // Execute compaction (and any model switch around it) right after Turn 20
      if (compactionTurn && turn === compactionTurn && arm !== 'C0') {
        if (switchBeforeCompact && postCompactModel) {
          const swIdx = events.length;
          serverHandle.setContext({
            runId,
            arm,
            rep,
            turn,
            event: 'set_model_before_compact',
            phase: 'switch_before_compact'
          });
          child.stdin.write(
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: `/model ${postCompactModel}` }
            }) + '\n'
          );
          await waitForEvent((e) => e.type === 'result', 120000, swIdx);
        }

        const compactCmd = compactionInstructions
          ? `/compact ${compactionInstructions}`
          : '/compact';
        const cmpIdx = events.length;
        serverHandle.setContext({
          runId,
          arm,
          rep,
          turn,
          event: 'compact',
          phase: 'compaction_call'
        });
        child.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: compactCmd }
          }) + '\n'
        );
        await waitForEvent((e) => e.type === 'result', 240000, cmpIdx);
        const spendAfterCompact = Number(serverHandle.getState().totalSpendUsd || 0);
        console.log(`[${runId}] Compaction @ Turn ${turn} complete | cumulativeSpend=$${spendAfterCompact.toFixed(4)}`);

        if (!switchBeforeCompact && postCompactModel) {
          const swIdx = events.length;
          serverHandle.setContext({
            runId,
            arm,
            rep,
            turn,
            event: 'set_model_after_compact',
            phase: 'switch_after_compact'
          });
          child.stdin.write(
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: `/model ${postCompactModel}` }
            }) + '\n'
          );
          await waitForEvent((e) => e.type === 'result', 120000, swIdx);
        }
      }
    }

    child.stdin.end();
    await Promise.race([closePromise, new Promise((r) => setTimeout(r, 5000))]);
  } finally {
    if (!childClosed) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }

  // Locate session .jsonl transcript
  const jsonlFiles = [
    ...findSessionJsonlFiles(cfgDir),
    ...findSessionJsonlFiles(path.join(homeDir, '.claude'))
  ];
  if (jsonlFiles.length === 0) {
    throw new Error(`[${runId}] Could not find session transcript .jsonl`);
  }
  const transcriptSrc = jsonlFiles[0];
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptDest = path.join(TRANSCRIPTS_DIR, `${runId}.jsonl`);
  fs.copyFileSync(transcriptSrc, transcriptDest);

  const outcomes = evaluateRunOutcomes(repoDir, frozenLegacySha256, turnOutputs);
  const boundaryRows = evaluateBoundaryDetectorOnPhase2Transcript(transcriptDest, turnPlan, runId);

  fs.rmSync(workRoot, { recursive: true, force: true });

  return {
    runId,
    arm,
    rep,
    sessionId: sessionId || `sess_${runId}`,
    transcriptDest,
    outcomes,
    boundaryRows
  };
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const wireLogPath = path.join(RAW_DIR, 'pilot_c1_r01_wire_log.jsonl');
  const ledgerPath = path.join(RAW_DIR, 'pilot_c1_r01_openrouter_ledger.jsonl');
  if (fs.existsSync(wireLogPath)) fs.unlinkSync(wireLogPath);
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);

  const apiKey = loadOpenRouterApiKey();
  const keyBefore = await fetchOpenRouterKeyUsage(apiKey);
  fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'before_pilot_c1_r01', ...keyBefore }) + '\n', 'utf8');
  console.log(`[OpenRouter Balance Before Pilot C1_r01] limitRemaining=$${Number(keyBefore.limitRemaining).toFixed(6)} (usage=$${Number(keyBefore.usage).toFixed(6)})`);

  const abortCapUsd = 2.0;
  const serverHandle = await startProxyServer({
    upstreamBaseUrl: 'https://openrouter.ai',
    upstreamApiPrefix: '/api',
    apiKey,
    maxBudgetUsd: abortCapUsd,
    wireLogPath,
    pinProvider: true,
    stripCacheTtl: false
  });

  let sessionResult = null;
  try {
    sessionResult = await runSinglePhase2Session({
      runId: 'C1_r01',
      arm: 'C1',
      rep: 1,
      initialModel: MODEL_B_CLI,
      compactionTurn: 20,
      compactionInstructions: '',
      abortCapUsd,
      serverHandle,
      wireLogPath
    });
  } finally {
    await serverHandle.close();
  }

  // Wait 8 seconds for OpenRouter ledger settlement, then poll /api/v1/key
  await new Promise((r) => setTimeout(r, 8000));
  const keyAfter = await fetchOpenRouterKeyUsage(apiKey);
  fs.appendFileSync(ledgerPath, JSON.stringify({ event: 'after_pilot_c1_r01', ...keyAfter }) + '\n', 'utf8');

  // Parse wire log and transcript to compute per-turn requests/turn, context at T20, compaction call cost,
  // Turn 21 tools/system vs messages cache split, and total billed vs settled delta
  const wireRows = readJsonl(wireLogPath).filter((w) => !w.isSideCall && w.statusCode === 200);
  const transcriptLines = readJsonl(sessionResult.transcriptDest);

  // Extract compact_boundary metadata if present
  const compactBoundaryEntry = transcriptLines.find((e) => e?.type === 'system' && e?.subtype === 'compact_boundary');
  const compactResultEntry = transcriptLines.find(
    (e) =>
      e?.type === 'user' &&
      typeof e?.message?.content === 'string' &&
      e.message.content.includes('This session is being continued from a previous conversation')
  );

  const byTurn = new Map();
  let compactWireRow = null;
  for (const w of wireRows) {
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
      turnComputedUsd: Number(turnComputedUsd.toFixed(6))
    });
  }

  // Inspect Turn 1, Turn 20, Compaction Call, and Turn 21 for tools/system vs messages cache split
  const t1First = (byTurn.get(1) || [])[0] || null;
  const t20Calls = byTurn.get(20) || [];
  const t20Last = t20Calls[t20Calls.length - 1] || null;
  const t21First = (byTurn.get(21) || [])[0] || null;

  // On Turn 1 first call, messages is only the 1-sentence prompt (~45 tokens), so tools+system prefix is ~t1First.cache_creation_input_tokens
  const toolsAndSystemPrefixApproxTokens = t1First
    ? Number(t1First.usage?.cache_creation_input_tokens || 0)
    : 0;

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
  const settledKeyDeltaUsd = Number((Number(keyAfter.usage) - Number(keyBefore.usage)).toFixed(6));
  const settledRemainingDeltaUsd = Number((Number(keyBefore.limitRemaining) - Number(keyAfter.limitRemaining)).toFixed(6));

  // Evaluate boundary detector precision/recall on C1_r01 against scripted turn plan labels
  const bRows = sessionResult.boundaryRows;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of bRows) {
    if (r.outcomeClass === 'TP') tp += 1;
    else if (r.outcomeClass === 'FP') fp += 1;
    else if (r.outcomeClass === 'FN') fn += 1;
    else tn += 1;
  }

  const pilotSummary = {
    status: 'PILOT_C1_R01_OK',
    runId: 'C1_r01',
    model: 'anthropic/claude-sonnet-4.6',
    effort: EFFORT_BASELINE,
    balanceBeforeUsd: Number(Number(keyBefore.limitRemaining).toFixed(6)),
    balanceAfterUsd: Number(Number(keyAfter.limitRemaining).toFixed(6)),
    usageBeforeUsd: Number(Number(keyBefore.usage).toFixed(6)),
    usageAfterUsd: Number(Number(keyAfter.usage).toFixed(6)),
    settledKeyDeltaUsd,
    settledRemainingDeltaUsd,
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
          t1InitialCacheCreationTokens_toolsAndSystemBaseline: toolsAndSystemPrefixApproxTokens,
          t21InputTokens: Number(t21First.usage?.input_tokens || 0),
          t21CacheReadInputTokens: Number(t21First.usage?.cache_read_input_tokens || 0),
          t21CacheCreationInputTokens: Number(t21First.usage?.cache_creation_input_tokens || 0),
          t21TotalPromptTokens:
            Number(t21First.usage?.input_tokens || 0) +
            Number(t21First.usage?.cache_creation_input_tokens || 0) +
            Number(t21First.usage?.cache_read_input_tokens || 0),
          toolsChars: t21First.requestFingerprint?.toolsChars ?? null,
          systemChars: t21First.requestFingerprint?.systemChars ?? null,
          messagesChars: t21First.requestFingerprint?.messagesChars ?? null,
          toolsSha256MatchedT20:
            t21First.requestFingerprint?.toolsSha256 === t20Last?.requestFingerprint?.toolsSha256,
          systemSha256MatchedT20:
            t21First.requestFingerprint?.systemSha256 === t20Last?.requestFingerprint?.systemSha256,
          cacheBreakpoints: t21First.requestFingerprint?.cacheBreakpoints ?? []
        }
      : null,
    outcomes: sessionResult.outcomes,
    phase1ScriptedPlanDetectorEval: {
      totalTurns: bRows.length,
      tp,
      fp,
      fn,
      tn,
      precision: tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null,
      recall: tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null,
      falsePromptsPer100Turns: Number(((fp / bRows.length) * 100).toFixed(2))
    },
    perTurnSummary
  };

  fs.writeFileSync(
    path.join(SMART_COMPACT_DIR, 'pilot_c1_r01_summary.json'),
    JSON.stringify(pilotSummary, null, 2) + '\n',
    'utf8'
  );
  console.log(JSON.stringify(pilotSummary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
