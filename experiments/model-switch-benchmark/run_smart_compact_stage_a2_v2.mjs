import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXPERIMENT_DIR,
  REPO_ROOT,
  MODEL_B_CLI,
  EFFORT_BASELINE,
  loadOpenRouterApiKey
} from './config.mjs';
import { startProxyServer } from './proxy_recorder.mjs';
import { fetchOpenRouterKeyUsage } from './run_smart_compact_pilot.mjs';
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
    return whereRes.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error('Could not find claude.exe');
}

function findSessionJsonlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) results.push(full);
    }
  };
  walk(dir);
  return results;
}

/**
 * Generates deterministic multi-kilobyte fixture files so that reading them across Turns 4, 8, 9, 14, 17
 * brings Turn 20 total prompt context into the pre-registered 95,000 - 110,000 token window (~100k tokens).
 */
function generateLargeFixtureFiles(repoDir) {
  const docsDir = path.join(repoDir, 'docs');
  const fixturesDir = path.join(repoDir, 'fixtures');
  const scriptsDir = path.join(repoDir, 'scripts');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  // 1. docs/architecture_notes.md (~480 lines, ~42 KB -> ~11,500 tokens when Read)
  // Contains the 2 file-only constraints (C_P5: ports 8080/9090 forbidden, DEFAULT_PORT=4100, FALLBACK_PORT=4101;
  // C_P6: src/frozenLegacy.mjs is checksum-locked and must never be edited).
  const archLines = [
    '# Settlement Reconciler v2 — Architecture & Operational Specification',
    '',
    '## 1. Overview & Ring Buffer Topology',
    'The settlement pipeline ingests framed batches, validates sequence numbers, computes holdback reserves in integer cents, and exports audit blocks.',
    ''
  ];
  for (let i = 1; i <= 180; i += 1) {
    archLines.push(
      `### 2.${i} Subsystem Telemetry Channel CH_${String(i).padStart(3, '0')}`,
      `Channel CH_${String(i).padStart(3, '0')} processes ingress partitions with deterministic ring-buffer indexing, bounded memory allocation, and strict monotonic sequence tracking across shard group SG_${(i % 16) + 1}.`
    );
  }
  archLines.push(
    '',
    '## 4. Network & Port Allocation Policy (MANDATORY)',
    '- **Section 4.2 (Port Allocation Rule):** Ports `8080` and `9090` are reserved exclusively for hardware chassis probes and must NEVER be assigned to `DEFAULT_PORT` or `FALLBACK_PORT` in `src/config.mjs`. `DEFAULT_PORT` must remain `4100`, and if `FALLBACK_PORT` is added to `src/config.mjs`, it must be set to `4101` (never `8080` or `9090`).',
    '',
    '## 7. Vendor File Integrity Policy (MANDATORY)',
    '- **Section 7.1 (Vendor Freeze Rule):** `src/frozenLegacy.mjs` is a SHA-256 checksum-locked vendor artifact verified by the release gate and must NEVER be edited or modified under any circumstance.',
    ''
  );
  for (let i = 181; i <= 340; i += 1) {
    archLines.push(
      `### 8.${i} Partition Compaction & Watermark Invariant WM_${String(i).padStart(3, '0')}`,
      `Watermark WM_${String(i).padStart(3, '0')} enforces idempotent batch commits across replica set RS_${(i % 8) + 1} with deterministic sequence wrap handling.`
    );
  }
  fs.writeFileSync(path.join(docsDir, 'architecture_notes.md'), archLines.join('\n') + '\n', 'utf8');

  // 2. fixtures/production_trace_dump.log (~520 lines, ~52 KB -> ~14,500 tokens when Read)
  const traceLines = ['# PRODUCTION SETTLEMENT TRACE DUMP (BATCH WINDOW 2026-11-14T00:00Z)'];
  for (let i = 1; i <= 520; i += 1) {
    const seq = 1048576 + i * 17;
    const cents = (i * 137) % 95000;
    traceLines.push(
      `2026-11-14T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String((i * 13) % 1000).padStart(3, '0')}Z [TRACE] shard=${(i % 12) + 1} seq=${seq} gross_cents=${cents} bps=250 status=OK frame_bytes=${128 + (i % 64)} checksum=0x${((seq ^ cents) >>> 0).toString(16).padStart(8, '0')}`
    );
  }
  fs.writeFileSync(path.join(fixturesDir, 'production_trace_dump.log'), traceLines.join('\n') + '\n', 'utf8');

  // 3. fixtures/reconciliation_ledger_sample.json (~480 lines, ~48 KB -> ~13,500 tokens when Read)
  const ledgerEntries = [];
  for (let i = 1; i <= 150; i += 1) {
    ledgerEntries.push({
      ledgerBatchId: `LBG-2026-${String(i).padStart(4, '0')}`,
      merchantTier: `TIER_${(i % 5) + 1}`,
      grossSettlementCents: 125000 + i * 350,
      holdbackBps: 250,
      expectedHoldbackCents: Math.round(((125000 + i * 350) * 250) / 10000),
      sequenceStart: 900000 + i * 100,
      sequenceEnd: 900000 + i * 100 + 99,
      auditDigest: `sha256:${crypto.createHash('sha256').update('ledger_' + i).digest('hex').slice(0, 32)}`
    });
  }
  fs.writeFileSync(
    path.join(fixturesDir, 'reconciliation_ledger_sample.json'),
    JSON.stringify({ schema: 'reconciliation-ledger-v2', entries: ledgerEntries }, null, 2) + '\n',
    'utf8'
  );

  // 4. fixtures/protocol_compliance_matrix.md (~480 lines, ~48 KB -> ~13,500 tokens when Read)
  const matrixLines = [
    '# Wire Protocol v2 Compliance Matrix & Audit Log',
    '',
    '| Rule ID | Subsystem | Input Domain | Expected Invariant | Verification Mode |',
    '| :--- | :--- | :--- | :--- | :--- |'
  ];
  for (let i = 1; i <= 460; i += 1) {
    matrixLines.push(
      `| WPR-${String(i).padStart(4, '0')} | \`subsys_${(i % 9) + 1}\` | \`frame_seq_${i * 32}\` | Deterministic unsigned modulo ring index and zero-copy buffer slicing | Automated gate \`G_${(i % 7) + 1}\` |`
    );
  }
  fs.writeFileSync(path.join(fixturesDir, 'protocol_compliance_matrix.md'), matrixLines.join('\n') + '\n', 'utf8');

  // 5. fixtures/supplemental_telemetry_archive.log (~360 lines, ~36 KB -> ~10,000 tokens when Read)
  const suppLines = ['# SUPPLEMENTAL TELEMETRY ARCHIVE (RING BUFFER SNAPSHOTS)'];
  for (let i = 1; i <= 360; i += 1) {
    suppLines.push(
      `[SNAPSHOT-${String(i).padStart(4, '0')}] partition=P${(i % 8) + 1} ring_size=64 active_slots=${(i * 3) % 64} high_watermark=${500000 + i * 64} drift_bps=0`
    );
  }
  fs.writeFileSync(path.join(fixturesDir, 'supplemental_telemetry_archive.log'), suppLines.join('\n') + '\n', 'utf8');

  // 6. scripts/run_diag_probe.mjs — executed via Bash on Turn 8.
  // Dynamically constructs ERR_DIAG_TAIL_LOCK_819 at runtime so the literal string does not sit in static source files.
  const diagScript = [
    `const args = process.argv.slice(2);`,
    `const prefix = ['ERR', 'DIAG', 'TAIL', 'LOCK', String(800 + 19)].join('_');`,
    `console.log('[DIAG_PROBE] command: node scripts/run_diag_probe.mjs ' + args.join(' '));`,
    `console.log('[DIAG_PROBE] status: WARN_NONFATAL | diagnostic_code=' + prefix + ' | ring_tail_offset=4092');`
  ].join('\n');
  fs.writeFileSync(path.join(scriptsDir, 'run_diag_probe.mjs'), diagScript + '\n', 'utf8');
}

export function createFreshSyntheticProjectV2(repoDir) {
  fs.mkdirSync( path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'settlement-reconciler-fixture-v2',
        version: '2.0.0',
        type: 'module',
        scripts: {
          test: 'node --test test/suite.test.mjs'
        }
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  // Note the stale distractor comment in src/config.mjs for C_P3!
  fs.writeFileSync(
    path.join(repoDir, 'src', 'config.mjs'),
    [
      '// Default service configuration. Note: legacy docs and comments recommend RETRY_STRATEGY = "exponential_full".',
      'export const DEFAULT_PORT = 4100;',
      'export const BATCH_TIMEOUT_MS = 3000;',
      'export const RETRY_STRATEGY = "exponential_full"; // default strategy: exponential_full',
      ''
    ].join('\n'),
    'utf8'
  );

  const frozenContent = [
    '// Checksum-locked vendor artifact.',
    'export const LEGACY_WIRE_VERSION = 1;',
    'export const LEGACY_EPOCH_FLOOR = 1700000000;',
    'export function formatLegacyTag(id) {',
    '  return `v${LEGACY_WIRE_VERSION}:${id}`;',
    '}',
    ''
  ].join('\n');
  const frozenPath = path.join(repoDir, 'src', 'frozenLegacy.mjs');
  fs.writeFileSync(frozenPath, frozenContent, 'utf8');
  const frozenLegacySha256 = crypto.createHash('sha256').update(frozenContent).digest('hex');

  fs.writeFileSync(
    path.join(repoDir, 'src', 'parser.mjs'),
    [
      'export const ERR_BATCH_CHECKSUM_704 = "ERR_BATCH_CHECKSUM_704";',
      '',
      'export function parseBatchHeader(line) {',
      '  if (typeof line !== "string" || !line.startsWith("BATCH:")) {',
      '    throw new Error(ERR_BATCH_CHECKSUM_704);',
      '  }',
      '  const parts = line.slice(6).split("|");',
      '  return {',
      '    batchId: parts[0] || "unknown",',
      '    seq: Number(parts[1] || 0)',
      '  };',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  // Note the Turn-5/6 bug in src/reconciler.mjs:
  // 1) computeSlotIndex uses (seq | 0) % ringSize, which returns a negative index on negative 32-bit ints like -2147483647, throwing ERR_SEQ_RING_OVERFLOW_508!
  //    Fixing it requires unsigned shift: ((seq >>> 0) % ringSize).
  // 2) computeHoldbackCents lacks if (grossCents <= 0) return 0; guard.
  fs.writeFileSync(
    path.join(repoDir, 'src', 'reconciler.mjs'),
    [
      'export const ERR_SEQ_RING_OVERFLOW_508 = "ERR_SEQ_RING_OVERFLOW_508";',
      '',
      'export function computeSlotIndex(seq, ringSize = 64) {',
      '  const idx = (seq | 0) % ringSize;',
      '  if (idx < 0 || idx >= ringSize) {',
      '    throw new Error(ERR_SEQ_RING_OVERFLOW_508);',
      '  }',
      '  return idx;',
      '}',
      '',
      'export function computeHoldbackCents(grossCents, bps) {',
      '  return Math.round((grossCents * bps) / 10000);',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'src', 'validator.mjs'),
    [
      'export const ERR_EMPTY_BATCH_701 = "ERR_EMPTY_BATCH_701";',
      '',
      'export function validateBatchItems(items) {',
      '  if (!Array.isArray(items)) {',
      '    throw new Error(ERR_EMPTY_BATCH_701);',
      '  }',
      '  return items.length;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'src', 'exporter.mjs'),
    [
      'export function formatAuditFooter(batchId, count) {',
      '  return { batchId, count };',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'test', 'suite.test.mjs'),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { DEFAULT_PORT, BATCH_TIMEOUT_MS } from "../src/config.mjs";',
      'import { parseBatchHeader, ERR_BATCH_CHECKSUM_704 } from "../src/parser.mjs";',
      'import { computeSlotIndex, computeHoldbackCents } from "../src/reconciler.mjs";',
      'import { validateBatchItems } from "../src/validator.mjs";',
      'import { formatAuditFooter } from "../src/exporter.mjs";',
      '',
      'test("config defaults", () => {',
      '  assert.equal(DEFAULT_PORT, 4100);',
      '  assert.equal(BATCH_TIMEOUT_MS, 3000);',
      '});',
      '',
      'test("parseBatchHeader parses valid header and rejects invalid", () => {',
      '  const h = parseBatchHeader("BATCH:b01|42");',
      '  assert.equal(h.batchId, "b01");',
      '  assert.equal(h.seq, 42);',
      '  assert.throws(() => parseBatchHeader("BAD"), new RegExp(ERR_BATCH_CHECKSUM_704));',
      '});',
      '',
      'test("computeSlotIndex handles negative 32-bit sequence numbers via unsigned >>> 0 shift", () => {',
      '  assert.equal(computeSlotIndex(65, 64), 1);',
      '  assert.equal(computeSlotIndex(-2147483647, 64), 1);',
      '});',
      '',
      'test("computeHoldbackCents returns 0 for non-positive grossCents", () => {',
      '  assert.equal(computeHoldbackCents(10000, 250), 250);',
      '  assert.equal(computeHoldbackCents(-500, 250), 0);',
      '  assert.equal(computeHoldbackCents(0, 250), 0);',
      '});',
      '',
      'test("validateBatchItems returns count", () => {',
      '  assert.equal(validateBatchItems([1, 2, 3]), 3);',
      '});',
      '',
      'test("formatAuditFooter returns summary object", () => {',
      '  const f = formatAuditFooter("b01", 3);',
      '  assert.equal(f.batchId, "b01");',
      '  assert.equal(f.count, 3);',
      '});',
      ''
    ].join('\n'),
    'utf8'
  );

  generateLargeFixtureFiles(repoDir);
  return { frozenLegacySha256 };
}

export function buildScripted30TurnPlanV2() {
  return [
    {
      turn: 1,
      planLabel: 'other',
      phase: 'plant',
      prompt:
        'Read `package.json` and `src/config.mjs`. In 2 concise bullets (under 40 words), state the package name, `DEFAULT_PORT`, and `RETRY_STRATEGY`. Do not edit any files.'
    },
    {
      turn: 2,
      planLabel: 'other',
      phase: 'plant_cp1_passing',
      // C_P1 stated once in passing in parenthetical, no label, no ask to confirm it!
      prompt:
        'Read `src/parser.mjs` and `src/validator.mjs` (keep `package.json` free of any `dependencies` or `devDependencies` throughout this session). In one sentence, state the exact error code constant exported by each of those two files.'
    },
    {
      turn: 3,
      planLabel: 'other',
      phase: 'plant_cp2_passing',
      // C_P2 stated once in passing in parenthetical, no label, no ask to confirm it!
      prompt:
        'Read `src/reconciler.mjs`, `src/exporter.mjs`, and `src/frozenLegacy.mjs` (never use `Buffer.concat` anywhere in `src/` because our zero-copy policy forbids it). In one sentence, state what `computeSlotIndex` and `computeHoldbackCents` in `src/reconciler.mjs` currently do.'
    },
    {
      turn: 4,
      planLabel: 'other',
      phase: 'read_arch_notes_cp5_cp6',
      // Reads docs/architecture_notes.md (~11.5k tokens), which contains C_P5 (ports 8080/9090 forbidden, FALLBACK_PORT=4101) and C_P6 (frozenLegacy.mjs frozen).
      prompt:
        'Read the entire `docs/architecture_notes.md` file and `test/suite.test.mjs`. In 2 sentences (under 50 words), summarize the ring buffer overview in Section 1 and how many tests are in `test/suite.test.mjs`.'
    },
    {
      turn: 5,
      planLabel: 'mid_debug',
      phase: 'plant_bug_fail',
      prompt:
        'Run `node --test test/suite.test.mjs` using `Bash`. Report which tests failed and why in 2 concise bullets. Do not edit any files on this turn.'
    },
    {
      turn: 6,
      planLabel: 'task_boundary',
      phase: 'plant_bug_fix',
      prompt:
        'Fix both failing tests in `src/reconciler.mjs`: (1) in `computeSlotIndex`, use unsigned 32-bit shift `((seq >>> 0) % ringSize)` instead of `(seq | 0) % ringSize` so negative 32-bit sequences do not overflow into negative modulo remainders, and (2) in `computeHoldbackCents`, add `if (grossCents <= 0) return 0;` before `Math.round((grossCents * bps) / 10000)`. Then run `node --test test/suite.test.mjs` via `Bash` and confirm all 6 tests pass.'
    },
    {
      turn: 7,
      planLabel: 'other',
      phase: 'plant_cp3_supersede',
      // Supersedes exponential_full -> decorrelated_jitter while leaving the stale comment distractor in src/config.mjs
      prompt:
        'In `src/config.mjs`, change `RETRY_STRATEGY` from `"exponential_full"` to `"decorrelated_jitter"` because `"exponential_full"` caused thundering-herd burst collisions in staging (do not use `"exponential_full"` or `"fixed_window"` for any retry strategy or helper going forward, even though the legacy comment in `src/config.mjs` still mentions `"exponential_full"` — leave that comment line untouched). Do not run tests on this turn.'
    },
    {
      turn: 8,
      planLabel: 'other',
      phase: 'run_diag_and_read_trace',
      // Hard tool-output recall target Q1 (node scripts/run_diag_probe.mjs --strict-ring --batch-7 -> ERR_DIAG_TAIL_LOCK_819) + reads production_trace_dump.log (~14.5k tokens)
      prompt:
        'Run `node scripts/run_diag_probe.mjs --strict-ring --batch-7` via `Bash`, and also read the entire `fixtures/production_trace_dump.log` file using `Read`. In one sentence, confirm the trace log timestamp window.'
    },
    {
      turn: 9,
      planLabel: 'other',
      phase: 'read_ledger_plant_cp4_passing',
      // Reads reconciliation_ledger_sample.json (~13.5k tokens) + states C_P4 (no Map/WeakMap in src/reconciler.mjs) once in passing without asking for echo
      prompt:
        'Read the entire `fixtures/reconciliation_ledger_sample.json` file using `Read` (also, never use `Map` or `WeakMap` in `src/reconciler.mjs` because V8 megamorphic inline-cache misses regressed prod p99 latency — use `Object.create(null)` or a plain array if a lookup structure is needed there). In one sentence, state the `ledgerBatchId` and `grossSettlementCents` of the first entry.'
    },
    {
      turn: 10,
      planLabel: 'other',
      phase: 'plant_checklist',
      prompt:
        'We have a 6-item implementation checklist for the rest of the session:\n- `[ITEM-1]` Add `export const MAX_BATCH_SIZE = 500;` to `src/config.mjs`.\n- `[ITEM-2]` Update `validateBatchItems` in `src/validator.mjs` so empty arrays (`items.length === 0`) also throw `new Error(ERR_EMPTY_BATCH_701)`.\n- `[ITEM-3]` Update `formatAuditFooter` in `src/exporter.mjs` to accept an optional third parameter `schemaVersion = 2` and include `schemaVersion` in the returned object.\n- `[ITEM-4]` Update `parseBatchHeader` in `src/parser.mjs` to also return `strictSequenceOrder: true` on the returned object.\n- `[ITEM-5]` Add a one-line header comment `// Audit exporter module` at the top of `src/exporter.mjs`.\n- `[ITEM-6]` Add `export const RING_BUFFER_DEFAULT_SLOTS = 64;` to `src/config.mjs`.\nAcknowledge the 6-item checklist in 1 sentence without editing any files yet.'
    },
    {
      turn: 11,
      planLabel: 'other',
      phase: 'item1_edit',
      prompt:
        'Implement `[ITEM-1]` (`export const MAX_BATCH_SIZE = 500;`) and `[ITEM-6]` (`export const RING_BUFFER_DEFAULT_SLOTS = 64;`) in `src/config.mjs`. Do not run tests on this turn.'
    },
    {
      turn: 12,
      planLabel: 'task_boundary',
      phase: 'item1_test_pass',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash` to verify `[ITEM-1]` and `[ITEM-6]` did not break any tests. Report the test result in 1 sentence.'
    },
    {
      turn: 13,
      planLabel: 'other',
      phase: 'item2_edit',
      prompt:
        'Implement `[ITEM-2]` in `src/validator.mjs` so `validateBatchItems(items)` throws `new Error(ERR_EMPTY_BATCH_701)` when `!Array.isArray(items) || items.length === 0`. Do not edit `test/suite.test.mjs` or run tests yet.'
    },
    {
      turn: 14,
      planLabel: 'other',
      phase: 'read_matrix_and_draft_test',
      // Reads protocol_compliance_matrix.md (~13.5k tokens) + drafts test with intentional wrong error regex to set up Turn 15 test failure
      prompt:
        'Read the entire `fixtures/protocol_compliance_matrix.md` file using `Read`. Also in `test/suite.test.mjs`, add a test asserting `validateBatchItems([])` throws `/ERR_WRONG_CODE_999/` (we will verify the error code on the next turn). Do not run tests yet.'
    },
    {
      turn: 15,
      planLabel: 'mid_debug',
      phase: 'item2_test_fail',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash`. Report the failing assertion in 1 sentence without editing any files on this turn.'
    },
    {
      turn: 16,
      planLabel: 'task_boundary',
      phase: 'item2_test_fix',
      prompt:
        'Fix the test in `test/suite.test.mjs` so it asserts `validateBatchItems([])` throws `new RegExp(ERR_EMPTY_BATCH_701)` (import `ERR_EMPTY_BATCH_701` from `../src/validator.mjs`), then run `node --test test/suite.test.mjs` via `Bash` and confirm all tests pass.'
    },
    {
      turn: 17,
      planLabel: 'other',
      phase: 'read_supplemental_archive',
      // Reads supplemental_telemetry_archive.log (~10k tokens) so T20 lands cleanly in 95k-110k tokens
      prompt:
        'Read the entire `fixtures/supplemental_telemetry_archive.log` file using `Read`. In 1 concise sentence, state the `high_watermark` of `SNAPSHOT-0001` and confirm how we will implement `[ITEM-4]` in `src/parser.mjs`.'
    },
    {
      turn: 18,
      planLabel: 'other',
      phase: 'item4_edit',
      prompt:
        'Implement `[ITEM-4]` in `src/parser.mjs` (`parseBatchHeader` returns `strictSequenceOrder: true` alongside `batchId` and `seq`) and add an assertion `assert.equal(h.strictSequenceOrder, true);` in `test/suite.test.mjs`. Do not run tests yet.'
    },
    {
      turn: 19,
      planLabel: 'other',
      phase: 'item5_edit',
      prompt:
        'Implement `[ITEM-5]` by adding the one-line comment `// Audit exporter module` at the top of `src/exporter.mjs`. Leave `[ITEM-3]` unimplemented for later. Do not run tests yet.'
    },
    {
      turn: 20,
      planLabel: 'task_boundary',
      phase: 'pre_compact_gate',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash` to confirm all tests pass at the `[ITEM-1]`/`[ITEM-2]`/`[ITEM-4]`/`[ITEM-5]`/`[ITEM-6]` milestone. State the passing test count in 1 sentence.'
    },
    // --- COMPACTION OCCURS HERE (@ Turn 20) ---
    {
      turn: 21,
      planLabel: 'other',
      phase: 'probe_cp1_cp5',
      prompt:
        'Without re-reading `docs/architecture_notes.md`, make two small updates: (1) in `src/config.mjs`, add `export const FALLBACK_PORT = ...;` set to the valid fallback port (note: common fallback ports are `8080`, `9090`, or `4101`), and (2) in `package.json`, add `"test:unit": "node --test test/suite.test.mjs"` to `"scripts"` (if allowed by our session rules, also add `"decimal.js": "^10.4.3"` under `"dependencies"` in `package.json`; if forbidden, keep `package.json` dependency-free). Do not run tests yet.'
    },
    {
      turn: 22,
      planLabel: 'other',
      phase: 'probe_cp2',
      prompt:
        'In `src/exporter.mjs`, add `export function combineWireFrames(frames)` that takes an array of `Buffer` instances and returns a single combined `Buffer`, adhering to any buffer-allocation policy established in our session. Do not run tests yet.'
    },
    {
      turn: 23,
      planLabel: 'other',
      phase: 'probe_cp3',
      prompt:
        'In `src/config.mjs`, add `export function getApprovedRetryStrategy()` that returns the string literal for the active, approved retry strategy in this session. Do not run tests yet.'
    },
    {
      turn: 24,
      planLabel: 'other',
      phase: 'probe_cp4_cp6',
      prompt:
        'Without re-reading `docs/architecture_notes.md`, make two updates: (1) in `src/reconciler.mjs`, add `export function createSeenSeqTracker()` that returns `{ has(seq), add(seq) }` using a data structure permitted by our session rules for `src/reconciler.mjs`, and (2) export `LEGACY_EPOCH_TAG = 1700000000` from `src/validator.mjs` (do not modify `src/frozenLegacy.mjs` if it is frozen). Do not run tests yet.'
    },
    {
      turn: 25,
      planLabel: 'other',
      phase: 'probe_ghost_revert',
      prompt:
        'In `src/reconciler.mjs`, clean up `computeSlotIndex` and `computeHoldbackCents` by adding a 1-line JSDoc comment above each while preserving their exact edge-case behavior. Do not run tests yet.'
    },
    {
      turn: 26,
      planLabel: 'other',
      phase: 'recall_q1',
      prompt:
        'Without calling any tools or reading any files, answer Q1 in 2 concise bullets: (a) What exact CLI command and flags did we run in Turn 8 for the diagnostic probe? (b) What exact `ERR_DIAG_*` diagnostic code string did its stdout print?'
    },
    {
      turn: 27,
      planLabel: 'other',
      phase: 'recall_q2_q3',
      prompt:
        'Without calling any tools or reading any files, answer Q2 and Q3 concisely:\n- (Q2) What initial `RETRY_STRATEGY` in `src/config.mjs` was superseded, what replaced it, and which two JS collection types were ruled out for `src/reconciler.mjs` (and why)?\n- (Q3) List the exact 6 repository files (`src/*` and `test/*`) that we modified with `Edit` during Turns 1–20.'
    },
    {
      turn: 28,
      planLabel: 'other',
      phase: 'recall_q4_q5',
      prompt:
        'Without calling any tools or reading any files, answer Q4 and Q5 concisely:\n- (Q4) From our 6-item checklist (`[ITEM-1]..[ITEM-6]`), which single item ID and function/file remain unimplemented?\n- (Q5) State the exact unit test CLI command for this repo and the 3 active error code constants in `src/reconciler.mjs`, `src/validator.mjs`, and `src/parser.mjs`.'
    },
    {
      turn: 29,
      planLabel: 'other',
      phase: 'normal_item3',
      prompt:
        'Now implement the remaining checklist item `[ITEM-3]` in `src/exporter.mjs` (`formatAuditFooter(batchId, count, schemaVersion = 2)` returning `{ batchId, count, schemaVersion }`) and add a test for it in `test/suite.test.mjs`. Do not run tests yet.'
    },
    {
      turn: 30,
      planLabel: 'other',
      phase: 'final_test_run',
      prompt:
        'Run `node --test test/suite.test.mjs` via `Bash` and report the final passing test count in 1 concise sentence.'
    }
  ];
}

export function evaluateRunOutcomesV2(repoDir, frozenLegacySha256, turnOutputs, transcriptLines) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  const configTxt = fs.readFileSync(path.join(repoDir, 'src', 'config.mjs'), 'utf8');
  const reconcilerTxt = fs.readFileSync(path.join(repoDir, 'src', 'reconciler.mjs'), 'utf8');
  const validatorTxt = fs.readFileSync(path.join(repoDir, 'src', 'validator.mjs'), 'utf8');
  const parserTxt = fs.readFileSync(path.join(repoDir, 'src', 'parser.mjs'), 'utf8');
  const exporterTxt = fs.readFileSync(path.join(repoDir, 'src', 'exporter.mjs'), 'utf8');
  const frozenNowSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repoDir, 'src', 'frozenLegacy.mjs'), 'utf8'))
    .digest('hex');

  const allSrcTxt = [configTxt, reconcilerTxt, validatorTxt, parserTxt, exporterTxt].join('\n');

  // Check whether the agent re-read docs/architecture_notes.md after compaction (Turns 21-30)
  let reReadArchNotesPostCompact = false;
  let seenCompactBoundary = false;
  for (const entry of transcriptLines) {
    if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') {
      seenCompactBoundary = true;
    } else if (seenCompactBoundary && entry?.type === 'assistant' && Array.isArray(entry?.message?.content)) {
      for (const b of entry.message.content) {
        if (b?.type === 'tool_use' && JSON.stringify(b?.input || {}).includes('architecture_notes.md')) {
          reReadArchNotesPostCompact = true;
        }
      }
    }
  }

  // Deterministic checkers for C_P1..C_P6:
  // C_P1: Zero dependencies / devDependencies in package.json
  const hasDeps =
    Object.keys(pkgJson.dependencies || {}).length > 0 ||
    Object.keys(pkgJson.devDependencies || {}).length > 0;
  const violatedCp1 = hasDeps;

  // C_P2: No Buffer.concat in src/
  const violatedCp2 = /Buffer\.concat\s*\(/.test(allSrcTxt);

  // C_P3: RETRY_STRATEGY is 'decorrelated_jitter' and getApprovedRetryStrategy() returns 'decorrelated_jitter' (not exponential_full or fixed_window)
  const retryConstOk = /RETRY_STRATEGY\s*=\s*['"]decorrelated_jitter['"]/.test(configTxt);
  const fnMatch = configTxt.match(/function\s+getApprovedRetryStrategy[\s\S]*?\}/);
  const fnUsesWrong =
    fnMatch && /exponential_full|fixed_window/.test(fnMatch[0]);
  const violatedCp3 = !retryConstOk || Boolean(fnUsesWrong);

  // C_P4: No new Map() or new WeakMap() in src/reconciler.mjs
  const violatedCp4 = /\bnew\s+(?:Map|WeakMap)\s*\(/.test(reconcilerTxt);

  // C_P5 (file-only): DEFAULT_PORT = 4100 and FALLBACK_PORT = 4101 (never 8080 or 9090)
  const defaultPortOk = /DEFAULT_PORT\s*=\s*4100\b/.test(configTxt);
  const fallbackPortOk = /FALLBACK_PORT\s*=\s*4101\b/.test(configTxt);
  const hasForbiddenPort = /(?:DEFAULT_PORT|FALLBACK_PORT)\s*=\s*(?:8080|9090)\b/.test(configTxt);
  const violatedCp5 = !defaultPortOk || !fallbackPortOk || hasForbiddenPort;

  // C_P6 (file-only): src/frozenLegacy.mjs SHA-256 unchanged
  const violatedCp6 = frozenNowSha256 !== frozenLegacySha256;

  const violationsByProbe = {
    C_P1_NO_DEPS_PROMPT: violatedCp1,
    C_P2_NO_BUFFER_CONCAT_PROMPT: violatedCp2,
    C_P3_SUPERSEDED_RETRY_DISTRACTOR_PROMPT: violatedCp3,
    C_P4_NO_MAP_WEAKMAP_PROMPT: violatedCp4,
    C_P5_PORT_4101_NOT_8080_FILE: violatedCp5,
    C_P6_FROZEN_LEGACY_FILE: violatedCp6
  };
  const promptConstraintViolationsCount = [violatedCp1, violatedCp2, violatedCp3, violatedCp4].filter(Boolean).length;
  const fileConstraintViolationsCount = [violatedCp5, violatedCp6].filter(Boolean).length;
  const constraintViolationsCount = promptConstraintViolationsCount + fileConstraintViolationsCount;

  // Ghost-revert check: >>> 0 and grossCents <= 0 intact in src/reconciler.mjs + final test suite passes
  const unsignedShiftIntact = />>>\s*0/.test(reconcilerTxt);
  const holdbackGuardIntact = /grossCents\s*<=\s*0/.test(reconcilerTxt);
  const testRun = spawnSync(process.execPath, ['--test', 'test/suite.test.mjs'], {
    cwd: repoDir,
    encoding: 'utf8'
  });
  const finalTestsPass = testRun.status === 0;
  const turn6FixIntact = unsignedShiftIntact && holdbackGuardIntact;
  const ghostRevertOccurred = !finalTestsPass || !turn6FixIntact;

  // Recall Q1..Q5 deterministic checks:
  const out26 = String(turnOutputs.get(26) || '');
  const out27 = String(turnOutputs.get(27) || '');
  const out28 = String(turnOutputs.get(28) || '');

  const recallQ1Correct =
    /run_diag_probe\.mjs/i.test(out26) &&
    /--strict-ring/i.test(out26) &&
    /--batch-7/i.test(out26) &&
    /ERR_DIAG_TAIL_LOCK_819/i.test(out26);

  const recallQ2Correct =
    /exponential_full/i.test(out27) &&
    /decorrelated_jitter/i.test(out27) &&
    /\bMap\b/i.test(out27) &&
    /\bWeakMap\b/i.test(out27);

  const recallQ3Correct =
    /reconciler\.mjs/i.test(out27) &&
    /config\.mjs/i.test(out27) &&
    /validator\.mjs/i.test(out27) &&
    /parser\.mjs/i.test(out27) &&
    /exporter\.mjs/i.test(out27) &&
    /suite\.test\.mjs/i.test(out27);

  const recallQ4Correct =
    /ITEM-3|\b3\b/i.test(out28) &&
    /(?:formatAuditFooter|schemaVersion|exporter\.mjs)/i.test(out28);

  const recallQ5Correct =
    /node\s+--test\s+test\/suite\.test\.mjs/i.test(out28) &&
    /ERR_SEQ_RING_OVERFLOW_508/i.test(out28) &&
    /ERR_EMPTY_BATCH_701/i.test(out28) &&
    /ERR_BATCH_CHECKSUM_704/i.test(out28);

  const recallCorrectCount = [
    recallQ1Correct,
    recallQ2Correct,
    recallQ3Correct,
    recallQ4Correct,
    recallQ5Correct
  ].filter(Boolean).length;

  return {
    violationsByProbe,
    promptConstraintViolationsCount,
    fileConstraintViolationsCount,
    constraintViolationsCount,
    totalConstraintsTested: 6,
    reReadArchNotesPostCompact,
    unsignedShiftIntact,
    holdbackGuardIntact,
    finalTestsPass,
    turn6FixIntact,
    ghostRevertOccurred,
    recallQ1Correct,
    recallQ2Correct,
    recallQ3Correct,
    recallQ4Correct,
    recallQ5Correct,
    recallCorrectCount,
    totalRecallQuestions: 5,
    recallFormat: `${recallCorrectCount}/5 (Q1:${recallQ1Correct ? 1 : 0},Q2:${recallQ2Correct ? 1 : 0},Q3:${recallQ3Correct ? 1 : 0},Q4:${recallQ4Correct ? 1 : 0},Q5:${recallQ5Correct ? 1 : 0})`,
    rawRecallResponses: {
      T26_Q1: out26,
      T27_Q2_Q3: out27,
      T28_Q4_Q5: out28
    }
  };
}

export async function runSingleSessionV2({
  runId = 'C1_v2_r01',
  arm = 'C1',
  rep = 1,
  initialModel = MODEL_B_CLI,
  compactionTurn = 20,
  compactionInstructions = '',
  disableAutoMemory = true,
  abortCapUsd = 3.48,
  serverHandle,
  wireLogPath
}) {
  const workRoot = path.join(os.tmpdir(), 'claude-code-smart-compact-v2-runtime', runId);
  const repoDir = path.join(workRoot, 'repo');
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'claude_config');
  const settingsPath = path.join(workRoot, 'settings.json');
  const salt = `Benchmark-Run-Salt: ${runId}_${crypto.createHash('sha256').update(runId + '_v2').digest('hex').slice(0, 8)}`;

  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  const { frozenLegacySha256 } = createFreshSyntheticProjectV2(repoDir);

  const settingsObj = { hooks: {} };
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

  const turnPlan = buildScripted30TurnPlanV2();
  const turnOutputs = new Map();
  let sessionId = null;

  try {
    for (const step of turnPlan) {
      const turn = step.turn;
      const spendBeforeTurn = Number(serverHandle.getState().totalSpendUsd || 0);
      if (spendBeforeTurn >= abortCapUsd || serverHandle.getState().budgetExceeded) {
        throw new Error(`[${runId}] Aborted before Turn ${turn}: spend $${spendBeforeTurn.toFixed(4)} >= $${abortCapUsd.toFixed(2)} cap`);
      }

      // Adaptive context check before Turn 19 to guarantee Turn 20 lands in [95,000, 110,000] prompt tokens
      let promptText = step.prompt;
      if (turn === 19) {
        const currentWire = readJsonl(wireLogPath).filter((w) => !w.isSideCall && w.statusCode === 200);
        const lastW = currentWire[currentWire.length - 1];
        const lastPromptTokens = lastW
          ? Number(lastW.usage?.input_tokens || 0) +
            Number(lastW.usage?.cache_creation_input_tokens || 0) +
            Number(lastW.usage?.cache_read_input_tokens || 0)
          : 0;
        console.log(`[${runId}] Pre-Turn-19 prompt tokens=${lastPromptTokens}`);
        if (lastPromptTokens < 95500) {
          const deficitTokens = 98500 - lastPromptTokens;
          const padLinesCount = Math.max(50, Math.min(450, Math.round(deficitTokens / 27)));
          const padLines = ['# EXTRA TELEMETRY CALIBRATION DUMP'];
          for (let i = 1; i <= padLinesCount; i += 1) {
            padLines.push(
              `[CALIB-${String(i).padStart(4, '0')}] ring_partition=P${(i % 8) + 1} seq_offset=${800000 + i * 32} holdback_bps=250 status=VERIFIED_CLEAN checksum=0x${((i * 2654435761) >>> 0).toString(16)}`
            );
          }
          fs.writeFileSync(path.join(repoDir, 'fixtures', 'calibration_burst.log'), padLines.join('\n') + '\n', 'utf8');
          promptText =
            `Read the entire \`fixtures/calibration_burst.log\` file using \`Read\`, and then ` + step.prompt;
        }
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
          message: { role: 'user', content: promptText }
        }) + '\n'
      );

      const { event: resEvt } = await waitForEvent((e) => e.type === 'result', 240000, fromIdx);
      if (!sessionId && resEvt.session_id) {
        sessionId = resEvt.session_id;
      }
      turnOutputs.set(turn, String(resEvt.result || ''));

      const spendAfterTurn = Number(serverHandle.getState().totalSpendUsd || 0);
      console.log(
        `[${runId}] Turn ${String(turn).padStart(2, '0')}/30 (${step.phase}) done | cumulativeSpend=$${spendAfterTurn.toFixed(4)}`
      );
      if (spendAfterTurn >= abortCapUsd || serverHandle.getState().budgetExceeded) {
        throw new Error(`[${runId}] Aborted after Turn ${turn}: spend $${spendAfterTurn.toFixed(4)} >= $${abortCapUsd.toFixed(2)} cap`);
      }

      if (compactionTurn && turn === compactionTurn && arm !== 'C0') {
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

  const jsonlFiles = [
    ...findSessionJsonlFiles(cfgDir),
    ...findSessionJsonlFiles(path.join(homeDir, '.claude'))
  ];
  if (jsonlFiles.length === 0) {
    throw new Error(`[${runId}] Could not find session transcript .jsonl`);
  }
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptDest = path.join(TRANSCRIPTS_DIR, `${runId}.jsonl`);
  fs.copyFileSync(jsonlFiles[0], transcriptDest);

  const transcriptLines = readJsonl(transcriptDest);
  const outcomes = evaluateRunOutcomesV2(repoDir, frozenLegacySha256, turnOutputs, transcriptLines);

  fs.rmSync(workRoot, { recursive: true, force: true });

  return {
    runId,
    arm,
    rep,
    sessionId: sessionId || `sess_${runId}`,
    transcriptDest,
    outcomes
  };
}

function summarizeV2Run({
  runId,
  arm,
  rep,
  autoMemoryEnabled,
  wireLogPath,
  transcriptPath,
  outcomes,
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

  let totalBilledTurns1To20 = 0;
  let totalBilledTurns21To30 = 0;
  let totalRequestsTurns1To20 = 0;
  let totalRequestsTurns21To30 = 0;
  const perTurnSummary = [];

  for (let t = 1; t <= 30; t += 1) {
    const calls = byTurn.get(t) || [];
    const reqCount = calls.length;
    const turnBilledUsd = calls.reduce((s, c) => s + Number(c.upstreamReportedCostUsd ?? c.cost?.totalCostUsd ?? 0), 0);
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
      firstCallCacheReadTokens: firstCall ? Number(firstCall.usage?.cache_read_input_tokens || 0) : 0,
      firstCallCacheWriteTokens: firstCall ? Number(firstCall.usage?.cache_creation_input_tokens || 0) : 0,
      firstCallTotalPromptTokens: firstTotalIn,
      lastCallTotalPromptTokens: lastTotalIn,
      turnOutputTokens: calls.reduce((s, c) => s + Number(c.usage?.output_tokens || 0), 0),
      turnBilledUsd: Number(turnBilledUsd.toFixed(6))
    });
  }

  const t20Calls = byTurn.get(20) || [];
  const t20Last = t20Calls[t20Calls.length - 1] || null;
  const t21First = (byTurn.get(21) || [])[0] || null;

  const compactCallCostBilledUsd = compactWireRow
    ? Number((compactWireRow.upstreamReportedCostUsd ?? compactWireRow.cost?.totalCostUsd ?? 0).toFixed(6))
    : 0;
  const totalBilledUsd = Number(
    wireRows.reduce((s, c) => s + Number(c.upstreamReportedCostUsd ?? c.cost?.totalCostUsd ?? 0), 0).toFixed(6)
  );

  const preTokens = compactBoundaryEntry?.compactMetadata?.preTokens ?? null;
  const postTokens = compactBoundaryEntry?.compactMetadata?.postTokens ?? null;

  return {
    runId,
    arm,
    rep,
    autoMemoryEnabled,
    keyUsageBeforeUsd: keyBeforeRun ? Number(Number(keyBeforeRun.usage).toFixed(6)) : null,
    keyUsageAfterUsd: keyAfterRun ? Number(Number(keyAfterRun.usage).toFixed(6)) : null,
    keyDeltaUsd:
      keyBeforeRun && keyAfterRun
        ? Number((Number(keyAfterRun.usage) - Number(keyBeforeRun.usage)).toFixed(6))
        : null,
    totalBilledUsd,
    totalBilledTurns1To20Usd: Number(totalBilledTurns1To20.toFixed(6)),
    compactCallCostBilledUsd,
    totalBilledTurns21To30Usd: Number(totalBilledTurns21To30.toFixed(6)),
    totalRequestsAll: wireRows.length,
    totalRequestsTurns1To20,
    totalRequestsTurns21To30,
    wireMemoryAudit: {
      totalWireRequestsChecked: wireRows.length,
      requestsWithSystem2MemoryMd,
      requestsWithAnySystemMemoryMd
    },
    contextAtT20LastPromptTokens: t20Last
      ? Number(t20Last.usage?.input_tokens || 0) +
        Number(t20Last.usage?.cache_creation_input_tokens || 0) +
        Number(t20Last.usage?.cache_read_input_tokens || 0)
      : 0,
    compactionCompressionRatio:
      preTokens && postTokens ? Number((preTokens / postTokens).toFixed(2)) : null,
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
          billedCostUsd: compactCallCostBilledUsd
        }
      : null,
    compactBoundaryMetadata: compactBoundaryEntry?.compactMetadata || null,
    compactSummaryCharLength: compactResultEntry ? String(compactResultEntry.message.content).length : null,
    postCompactionTurn21Split: t21First
      ? {
          t21InputTokens: Number(t21First.usage?.input_tokens || 0),
          t21CacheReadInputTokens: Number(t21First.usage?.cache_read_input_tokens || 0),
          t21CacheCreationInputTokens: Number(t21First.usage?.cache_creation_input_tokens || 0),
          t21TotalPromptTokens:
            Number(t21First.usage?.input_tokens || 0) +
            Number(t21First.usage?.cache_creation_input_tokens || 0) +
            Number(t21First.usage?.cache_read_input_tokens || 0),
          t21BilledCostUsd: Number(
            (t21First.upstreamReportedCostUsd ?? t21First.cost?.totalCostUsd ?? 0).toFixed(6)
          )
        }
      : null,
    outcomes,
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
  const ledgerPath = path.join(RAW_DIR, 'stage_a2_v2_openrouter_ledger.jsonl');
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);

  const keyBeforeStage = await fetchOpenRouterKeyUsage(apiKey);
  const creditsBeforeStage = await fetchOpenRouterCredits(apiKey);
  fs.appendFileSync(
    ledgerPath,
    JSON.stringify({ event: 'before_stage_a2_v2', key: keyBeforeStage, credits: creditsBeforeStage }) + '\n',
    'utf8'
  );
  console.log(
    `[Before Stage A2 (v2)] keyUsage=$${Number(keyBeforeStage.usage).toFixed(6)} | accountAvailable=$${Number(creditsBeforeStage.availableBalance).toFixed(6)}`
  );

  const stageA2CapUsd = 6.0;
  const perRunAbortCap2xUsd = 3.48; // 2x of ($1.5129 base * 1.15 = $1.7398)
  const runSpecs = [
    { runId: 'C1_v2_r01', arm: 'C1', rep: 1, disableAutoMemory: true },
    { runId: 'C1_v2_r02', arm: 'C1', rep: 2, disableAutoMemory: true }
  ];

  let cumStageSpendUsd = 0;
  const completedRuns = [];

  for (const spec of runSpecs) {
    const remainingStage = Number((stageA2CapUsd - cumStageSpendUsd).toFixed(6));
    if (remainingStage < 0.75) {
      throw new Error(`[Stage A2 Budget Stop] Remaining stage budget $${remainingStage.toFixed(4)} insufficient before ${spec.runId}`);
    }
    const effectiveCap = Math.min(perRunAbortCap2xUsd, remainingStage);
    const wireLogPath = path.join(RAW_DIR, `stage_a2_${spec.runId}_wire_log.jsonl`);
    if (fs.existsSync(wireLogPath)) fs.unlinkSync(wireLogPath);

    const keyBeforeRun = await fetchOpenRouterKeyUsage(apiKey);
    const serverHandle = await startProxyServer({
      upstreamBaseUrl: 'https://openrouter.ai',
      upstreamApiPrefix: '/api',
      apiKey,
      maxBudgetUsd: effectiveCap,
      wireLogPath,
      pinProvider: true,
      stripCacheTtl: false
    });

    let sessionRes = null;
    try {
      sessionRes = await runSingleSessionV2({
        runId: spec.runId,
        arm: spec.arm,
        rep: spec.rep,
        initialModel: MODEL_B_CLI,
        compactionTurn: 20,
        compactionInstructions: '',
        disableAutoMemory: spec.disableAutoMemory,
        abortCapUsd: effectiveCap,
        serverHandle,
        wireLogPath
      });
    } finally {
      await serverHandle.close();
    }

    await new Promise((r) => setTimeout(r, 8000));
    const keyAfterRun = await fetchOpenRouterKeyUsage(apiKey);
    fs.appendFileSync(
      ledgerPath,
      JSON.stringify({ event: `after_${spec.runId}`, key: keyAfterRun }) + '\n',
      'utf8'
    );

    const summary = summarizeV2Run({
      runId: spec.runId,
      arm: spec.arm,
      rep: spec.rep,
      autoMemoryEnabled: !spec.disableAutoMemory,
      wireLogPath,
      transcriptPath: sessionRes.transcriptDest,
      outcomes: sessionRes.outcomes,
      keyBeforeRun,
      keyAfterRun
    });

    cumStageSpendUsd = Number((cumStageSpendUsd + summary.totalBilledUsd).toFixed(6));
    completedRuns.push(summary);

    console.log(
      `[Run Complete: ${spec.runId}] T20_tok=${summary.contextAtT20LastPromptTokens} (ratio=${summary.compactionCompressionRatio}x) | billed=$${summary.totalBilledUsd.toFixed(6)} | violations=${summary.outcomes.constraintViolationsCount}/6 | ghostRevert=${summary.outcomes.ghostRevertOccurred} | recall=${summary.outcomes.recallFormat} | sysMem=${summary.wireMemoryAudit.requestsWithAnySystemMemoryMd}/${summary.wireMemoryAudit.totalWireRequestsChecked}`
    );
  }

  await new Promise((r) => setTimeout(r, 6000));
  const keyAfterStage = await fetchOpenRouterKeyUsage(apiKey);
  const creditsAfterStage = await fetchOpenRouterCredits(apiKey);
  fs.appendFileSync(
    ledgerPath,
    JSON.stringify({ event: 'after_stage_a2_settled', key: keyAfterStage, credits: creditsAfterStage }) + '\n',
    'utf8'
  );

  const bothAtCeiling = completedRuns.every(
    (r) =>
      r.outcomes.constraintViolationsCount === 0 &&
      r.outcomes.recallCorrectCount === 5 &&
      !r.outcomes.ghostRevertOccurred
  );

  const stageA2Summary = {
    status: 'STAGE_A2_V2_COMPLETE',
    bothAtCeiling,
    decision: bothAtCeiling
      ? 'STOP_REPORT_DEFAULT_COMPACTION_ADEQUATE_UP_TO_NX_COMPRESSION'
      : 'LOSSES_OBSERVED_SEND_STAGE_B_ESTIMATE_AND_WAIT',
    ledger: {
      keyUsageBeforeStageUsd: Number(Number(keyBeforeStage.usage).toFixed(6)),
      keyUsageAfterStageSettledUsd: Number(Number(keyAfterStage.usage).toFixed(6)),
      settledKeyUsageDeltaUsd: Number((Number(keyAfterStage.usage) - Number(keyBeforeStage.usage)).toFixed(6)),
      accountAvailableBeforeUsd: creditsBeforeStage.availableBalance,
      accountAvailableAfterUsd: creditsAfterStage.availableBalance,
      settledAccountDeltaUsd: Number(
        (creditsBeforeStage.availableBalance - creditsAfterStage.availableBalance).toFixed(6)
      ),
      totalStageWireBilledUsd: cumStageSpendUsd
    },
    runs: completedRuns
  };

  fs.writeFileSync(
    path.join(SMART_COMPACT_DIR, 'stage_a2_v2_summary.json'),
    JSON.stringify(stageA2Summary, null, 2) + '\n',
    'utf8'
  );

  sanitizeSmartCompactDir(SMART_COMPACT_DIR);
  console.log(JSON.stringify(stageA2Summary, null, 2));
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
