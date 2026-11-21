#!/usr/bin/env node
/**
 * Live Multi-Turn Paired OpenRouter A/B Benchmark for Highbeam's
 * 3-Category Next-Prompt Playbook (Workload-Aware Model & Effort Coach).
 *
 * Modes:
 *   --dry-run-mock                 $0 local mock SSE upstream + real pinned claude.exe + graders
 *   --confirm-live-spend --pilot   Live OpenRouter Pilot gate (7 runs: T04 rep 1 across 6 core arms + LEGACY_46_EFFORT_CHECK)
 *   --confirm-live-spend --full    Full paired benchmark (36 core runs + LEGACY_46_EFFORT_CHECK + COLD_BOUNDARY_TTL pair = 39 runs)
 *   --resume                       Resume from playbook_ab_results.json, skipping completed status='ok' runs
 *   --max-budget <usd>             Cumulative hard USD safety cap across the entire invocation
 *   --skip-ttl-sleep               Skip the 320s COLD_BOUNDARY_TTL wait in --full mode
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RESULTS_DIR,
  CLAUDE_EXE,
  loadOpenRouterApiKey,
  normalizeModelShortName
} from '../config.mjs';
import { startCptProxyServer, resolveCptCaps } from './cpt_proxy.mjs';
import { TASKS } from './tasks_manifest.mjs';
import { evaluateHiddenSuite } from './run_cost_per_task.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'task_repo_template');
const VISIBLE_DIR = path.join(__dirname, 'visible_suites');
const REF_DIR = path.join(__dirname, 'reference_solutions');

const OUT_RESULTS_JSON = path.join(RESULTS_DIR, 'playbook_ab_results.json');
const OUT_WIRE_JSONL = path.join(RESULTS_DIR, 'playbook_ab_wire.jsonl');
const OUT_LEDGER_JSONL = path.join(RESULTS_DIR, 'playbook_ab_ledger.jsonl');
const OUT_MOCK_WIRE_JSONL = path.join(RESULTS_DIR, 'playbook_ab_mock_wire.jsonl');

const OPUS_55 = 'claude-opus-5-5';
const SONNET_55 = 'claude-sonnet-5-5';
const HAIKU_55 = 'claude-haiku-5-5';
const SONNET_46 = 'claude-sonnet-4-6';
const TOOLS_ARG = 'Read,Edit,Write,Bash,Grep,Glob';
const TTL_EXPIRY_WAIT_MS = 320_000;

export const CORE_ARMS = Object.freeze([
  {
    arm: 'OPUS_STATIC_HIGH',
    suite: 'A1_OPUS',
    baselineArm: null,
    turns: [
      { turn: 1, category: 'Deep', model: OPUS_55, effort: 'high' },
      { turn: 2, category: 'Quick', model: OPUS_55, effort: 'high' },
      { turn: 3, category: 'Standard', model: OPUS_55, effort: 'high' },
      { turn: 4, category: 'Quick', model: OPUS_55, effort: 'high' }
    ]
  },
  {
    arm: 'OPUS_PLAYBOOK',
    suite: 'A1_OPUS',
    baselineArm: 'OPUS_STATIC_HIGH',
    turns: [
      { turn: 1, category: 'Deep', model: OPUS_55, effort: 'high' },
      { turn: 2, category: 'Quick', model: OPUS_55, effort: 'low' },
      { turn: 3, category: 'Standard', model: OPUS_55, effort: 'medium' },
      { turn: 4, category: 'Quick', model: OPUS_55, effort: 'low' }
    ]
  },
  {
    arm: 'OPUS_NAIVE_SWITCH',
    suite: 'A1_OPUS',
    baselineArm: 'OPUS_STATIC_HIGH',
    turns: [
      { turn: 1, category: 'Deep', model: OPUS_55, effort: 'high' },
      { turn: 2, category: 'Quick', model: SONNET_55, effort: 'low' },
      { turn: 3, category: 'Standard', model: SONNET_55, effort: 'medium' },
      { turn: 4, category: 'Quick', model: HAIKU_55, effort: 'low' }
    ]
  },
  {
    arm: 'SONNET_STATIC_HIGH',
    suite: 'A2_SONNET',
    baselineArm: null,
    turns: [
      { turn: 1, category: 'Deep', model: SONNET_55, effort: 'high' },
      { turn: 2, category: 'Quick', model: SONNET_55, effort: 'high' },
      { turn: 3, category: 'Standard', model: SONNET_55, effort: 'high' },
      { turn: 4, category: 'Quick', model: SONNET_55, effort: 'high' }
    ]
  },
  {
    arm: 'SONNET_PLAYBOOK',
    suite: 'A2_SONNET',
    baselineArm: 'SONNET_STATIC_HIGH',
    turns: [
      { turn: 1, category: 'Deep', model: SONNET_55, effort: 'high' },
      { turn: 2, category: 'Quick', model: SONNET_55, effort: 'low' },
      { turn: 3, category: 'Standard', model: SONNET_55, effort: 'medium' },
      { turn: 4, category: 'Quick', model: SONNET_55, effort: 'low' }
    ]
  },
  {
    arm: 'SONNET_NAIVE_HAIKU',
    suite: 'A2_SONNET',
    baselineArm: 'SONNET_STATIC_HIGH',
    turns: [
      { turn: 1, category: 'Deep', model: SONNET_55, effort: 'high' },
      { turn: 2, category: 'Quick', model: HAIKU_55, effort: 'low' },
      { turn: 3, category: 'Standard', model: SONNET_55, effort: 'medium' },
      { turn: 4, category: 'Quick', model: HAIKU_55, effort: 'low' }
    ]
  }
]);

const CORE_TASK_IDS = Object.freeze(['T04', 'T05', 'T06']);

function parseArgs(argv = []) {
  const flags = {
    dryRunMock: false,
    confirmLiveSpend: false,
    pilot: false,
    full: false,
    resume: false,
    skipTtlSleep: false,
    maxBudgetUsd: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run-mock') flags.dryRunMock = true;
    else if (a === '--confirm-live-spend') flags.confirmLiveSpend = true;
    else if (a === '--pilot') flags.pilot = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--resume') flags.resume = true;
    else if (a === '--skip-ttl-sleep') flags.skipTtlSleep = true;
    else if (a === '--max-budget' && argv[i + 1]) {
      flags.maxBudgetUsd = Number(argv[++i]) || null;
    }
  }
  return flags;
}

function findClaudeExe() {
  if (fs.existsSync(CLAUDE_EXE)) return CLAUDE_EXE;
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cand = path.join(tmp, entry.name, 'cli', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error('Pinned claude.exe not found in %TEMP%');
}

function rmDirBestEffort(dirPath, { label = 'temp', retries = 10, retryDelayMs = 150 } = {}) {
  if (!dirPath || !fs.existsSync(dirPath)) return true;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: retries, retryDelay: retryDelayMs });
    return true;
  } catch (err) {
    console.warn(`[cleanup-warn:${label}] Could not remove ${dirPath}: ${err?.code || err?.message}`);
    return false;
  }
}

function copyDirClean(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDirClean(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeFileAtomic(targetPath, text) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotDirHashes(dirPath) {
  const out = {};
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = snapshotDirHashes(full);
      for (const [k, v] of Object.entries(sub)) {
        out[`${entry.name}/${k}`] = v;
      }
    } else if (entry.isFile()) {
      out[entry.name] = sha256File(full);
    }
  }
  return out;
}

function httpsGetKeyUsage(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/key',
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({
              timestampUtc: new Date().toISOString(),
              statusCode: res.statusCode,
              usage: j?.data?.usage ?? null,
              limit: j?.data?.limit ?? null,
              limitRemaining: j?.data?.limit_remaining ?? null
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

/**
 * Deterministic ~48 KB billing ledger specification & incident postmortem runbook
 * placed inside each isolated temp repoDir so Turn 1 builds a realistic ~30k-50k token
 * warm KV-cache prefix cleanly under Claude Read limits.
 */
function buildDeterministicArchitectureDoc() {
  const sections = [];
  sections.push(`# LedgerPulse Billing Architecture, Wire Contracts & Incident Postmortems

Document Version: 2026.11-R4
Owner: Core Billing & Settlement Engineering
Scope: Deterministic integer-cent rating, credit pools, DSL filtering, DST invoicing, and audit digests.

## 1. Executive Architecture Summary
LedgerPulse processes multi-tenant metered usage events, graduated pricing schedules, promotional/prepaid credit grants, invoice finalizations, and void reversals without floating-point currency accumulation drift. Every monetary quantity is represented as an integer in USD cents (\`unitRateCents\`, \`subtotalCents\`, \`totalDueCents\`). External callers must never rely on IEEE-754 floating-point \`.toFixed()\` formatting inside settlement computations.

### Core Modules
1. \`src/constants.mjs\` — Frozen global caps (\`MAX_BPS = 10000\`, wire format version, rounding constants). Immutable across tasks.
2. \`src/errors.mjs\` — \`ERROR_CODES\` and \`LedgerError\`. All new error codes must preserve backward-compatible enum values.
3. \`src/frozenWire.mjs\` — Cryptographic SHA-256 wire digest encoder (\`encodeFrozenWireDigest\`). Strictly frozen across every release.
4. \`src/tierEngine.mjs\` — Graduated tier validation, sorting without caller mutation, and band math.
5. \`src/idempotencyGuard.mjs\` — Bounded FIFO replay protection with inclusive expiry check before conflict comparison.
6. \`src/creditPool.mjs\` — Window-eligible credit grant filtering (\`effectiveFromMs <= asOfMs < expiresAtMs\`), earliest-expiry + lexicographic tie-break ordering, non-mutating clones.
7. \`src/queryDsl.mjs\` — Recursive-descent boolean filter compiler supporting \`()\`, \`NOT\`, \`AND\`, \`OR\`, comparisons, and \`IN (...)\` sets without dynamic code evaluation.
8. \`src/clock.mjs\` — IANA timezone-aware midnight boundary resolver handling DST spring-forward, fall-back, and half-hour offsets (\`Asia/Kolkata\`, \`America/New_York\`, \`Australia/Lord_Howe\`, etc.).
9. \`src/invoiceBuilder.mjs\` — Orchestrates event filtering, grouped rating, minimum-commit true-up, credit application, post-credit tax, and \`SettlementRegistry\` state transitions.
10. \`src/batchIngestor.mjs\` — Streaming chunk ingestion coupled with \`IdempotencyGuard\`.
`);

  const topics = [
    ['Graduated Band Math & Inclusive Upper Bounds', 'tierEngine.mjs', 'Prevent double-counting band boundaries when prevUpTo equals cap and guarantee callers passing unsorted or frozen tier arrays never observe mutation. Validate positive finite integer caps and allow at most one unbounded null/Infinity tail tier.'],
    ['Idempotency Window Eviction & Expiry-First Precedence', 'idempotencyGuard.mjs', 'Enforce strict FIFO insertion order under maxEntries capacity. Check inclusive nowMs >= expiresAtMs prior to payloadHash conflict comparison so expired keys re-enter cleanly without refreshing older slot order on duplicate reads.'],
    ['Promotional Credit Eligibility & Tie-Break Determinism', 'creditPool.mjs', 'Clone every grant before decrementing remainingCents. Filter grants strictly by remainingCents > 0 and half-open [effectiveFromMs, expiresAtMs). Sort by expiresAtMs ascending then UTF-16 code-unit grantId comparison rather than localeCompare.'],
    ['Minimum Commit True-Up & Post-Credit Tax Ordering', 'invoiceBuilder.mjs', 'Compute COMMIT_TRUE_UP shortfall against usageSubtotalCents first, enforce creditsEligibleForTrueUp cap before credit consumption, subtract applied credits to obtain netAfterCreditsCents, and only then apply taxBps rounding to feed encodeFrozenWireDigest.'],
    ['Query DSL Operator Precedence & Zero-Eval Compliance', 'queryDsl.mjs', 'Parse parentheses highest, followed by unary NOT, conjunction AND, and disjunction OR. Reject empty IN () lists, trailing commas, and malformed literals with ERR_DSL_SYNTAX. Never invoke eval or new Function anywhere under src/.'],
    ['Void Reversal Accounting & Expired Grant Quarantine', 'invoiceBuilder.mjs', 'Split restored credits between still-active grants (voidedAtMs < expiresAtMs) and expired grants (voidedAtMs >= expiresAtMs) so expired credits are refunded on audit reports without re-entering settleable pool balances. Normalize signed -0 to 0.'],
    ['IANA Timezone DST Day Boundary Resolution', 'clock.mjs', 'Resolve exact UTC epoch timestamps corresponding to midnight at start and end of local calendar days using built-in Intl.DateTimeFormat parts without npm timezone dependencies, covering 23-hour spring-forward and 25-hour fall-back transitions.'],
    ['Frozen Wire Contract & Cryptographic Audit Invariants', 'frozenWire.mjs', 'Preserve field ordering, digest encoding, and module immutability. Any unexpected edit to constants.mjs or frozenWire.mjs invalidates downstream ledger reconciliation across batch ingestors and settlement registries.']
  ];

  for (let i = 0; i < 42; i += 1) {
    const [title, mod, detail] = topics[i % topics.length];
    const incNum = String(100 + i).padStart(3, '0');
    sections.push(`
## Incident Postmortem INC-2026-${incNum}: ${title} (\`${mod}\`)
- **Severity:** SEV-${(i % 3) + 1} | **Component:** \`src/${mod}\` | **Audit Tag:** \`LEDGER_INV_${incNum}\`
- **Root Cause Analysis:** ${detail} Historical telemetry showed edge-case inputs near boundary values (\`units = 0\`, \`nowMs === expiresAtMs\`, empty sets, nested \`NOT ... IN (...)\`, \`voidedAtMs === grant.expiresAtMs\`, and \`totalDueCents === 0\` negative-zero coercion) triggered silent divergences against reference ledger digests.
- **Required Regression Checks:**
  1. Verify explicit validation error codes via \`LedgerError(ERROR_CODES.*)\` before any stateful accumulation.
  2. Assert strict immutability of caller-supplied arrays, grant records, \`src/frozenWire.mjs\`, and \`src/constants.mjs\`.
  3. Confirm edge boundaries: inclusive vs. exclusive timestamps (\`asOfMs < expiresAtMs\` vs. \`nowMs >= expiresAtMs\`), UTF-16 code-unit sort stability, and zero external package dependencies in \`package.json\`.
  4. Verify wire digest determinism (\`encodeFrozenWireDigest\`) across repeat invocations and void reversals.
- **Operator Runbook Checksum Note:** Sequence block \`SIG-${incNum}\` — cross-check visible tests in \`test/task_visible.test.mjs\` alongside regression suites in \`test/*.test.mjs\` prior to closing any maintenance change window.
`);
  }

  return sections.join('\n');
}

const ARCH_DOC_CONTENT = buildDeterministicArchitectureDoc();

function buildTurnPrompt(turnSpec, task) {
  if (turnSpec.turn === 1) {
    return [
      'You are working in a read-only planning turn. Do NOT use Edit, Write, or mutating Bash commands — only use Read, Grep, or Glob.',
      `Inspect docs/BILLING_ARCHITECTURE_AND_INCIDENTS.md (read the full file for architectural invariants), test/task_visible.test.mjs, README.md, and the relevant source files in src/ (especially ${task.target_files.join(', ')} and related imports).`,
      `Diagnose every bug, boundary condition, validation rule, error code, and constraint for task ${task.task_id}, and produce a concise, concrete implementation plan listing exact files, functions, and changes needed.`,
      '',
      `Task spec for ${task.task_id}:`,
      task.spec
    ].join('\n');
  }
  if (turnSpec.turn === 2) {
    return [
      'Quick routine documentation task: append a "## Task Checklist" section to the end of README.md containing the exact line:',
      `TASK_ID: ${task.task_id}`,
      'followed by one markdown bullet per file in this exact list:',
      ...task.target_files.map((f) => `- ${f}`),
      'Do NOT modify any file under src/, test/, docs/, or package.json in this turn. Keep your confirmation brief.'
    ].join('\n');
  }
  if (turnSpec.turn === 3) {
    return [
      `Implement your Turn 1 plan cleanly in src/ to satisfy every requirement and constraint for task ${task.task_id}:`,
      '',
      task.spec,
      '',
      'Preserve all existing baseline tests and constraints, then run `npm test` to verify all visible tests pass.'
    ].join('\n');
  }
  return [
    'Quick routine handoff task: create docs/VERIFICATION_SUMMARY.md containing the exact header line:',
    '# Verification Summary',
    `Task: ${task.task_id}`,
    'Status: PASS',
    `and one bullet per file in [${task.target_files.join(', ')}] confirming that src/frozenWire.mjs and package.json were left untouched.`,
    'Do NOT modify any files under src/ or package.json in this turn.'
  ].join('\n');
}

function gradeTurn2({ repoDir, task, preSrcHashes, prePkgHash }) {
  const readmePath = path.join(repoDir, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
  const hasHeader = /^##\s+Task Checklist/im.test(readme);
  const hasTaskId = readme.includes(`TASK_ID: ${task.task_id}`);
  const missingTargets = task.target_files.filter((f) => !readme.includes(f));
  const postSrcHashes = snapshotDirHashes(path.join(repoDir, 'src'));
  const srcUntouched = JSON.stringify(preSrcHashes) === JSON.stringify(postSrcHashes);
  const pkgUntouched = sha256File(path.join(repoDir, 'package.json')) === prePkgHash;

  const passed = hasHeader && hasTaskId && missingTargets.length === 0 && srcUntouched && pkgUntouched;
  return {
    passed,
    hasHeader,
    hasTaskId,
    missingTargets,
    srcUntouched,
    pkgUntouched
  };
}

function gradeTurn4({ runId, repoDir, task, prePkgHash, preFrozenHash, preConstantsHash }) {
  const docPath = path.join(repoDir, 'docs', 'VERIFICATION_SUMMARY.md');
  const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  const hasHeader = docText.includes('# Verification Summary');
  const hasTask = docText.includes(`Task: ${task.task_id}`);
  const hasStatus = /Status:\s*PASS/i.test(docText);
  const missingTargets = task.target_files.filter((f) => !docText.includes(f));
  const pkgUntouched = sha256File(path.join(repoDir, 'package.json')) === prePkgHash;
  const frozenUntouched = sha256File(path.join(repoDir, 'src', 'frozenWire.mjs')) === preFrozenHash;
  const constantsUntouched = sha256File(path.join(repoDir, 'src', 'constants.mjs')) === preConstantsHash;
  const hidden = evaluateHiddenSuite({ runId, turn: 4, taskId: task.task_id, repoDir });

  const passed =
    hasHeader &&
    hasTask &&
    hasStatus &&
    missingTargets.length === 0 &&
    pkgUntouched &&
    frozenUntouched &&
    constantsUntouched &&
    hidden.passed;
  return {
    passed,
    hasHeader,
    hasTask,
    hasStatus,
    missingTargets,
    pkgUntouched,
    frozenUntouched,
    constantsUntouched,
    hiddenPassed: hidden.passed,
    hiddenFailing: hidden.failingNames || []
  };
}

function parseTrailingJsonObject(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch (err) {
    // Claude CLI occasionally prefixes stream lines before the final JSON summary object.
    void err;
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (lineErr) {
      // Continue scanning upward until the complete summary JSON line is located.
      void lineErr;
    }
  }
  return null;
}

function spawnClaudeTurn({
  claudeExe,
  prompt,
  model,
  effort,
  sessionId,
  appendSystemPrompt,
  repoDir,
  homeDir,
  cfgDir,
  settingsPath,
  proxyBaseUrl,
  timeoutMs = 240_000
}) {
  return new Promise((resolve) => {
    const args = [];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(
      '-p', prompt,
      '--model', model,
      '--effort', effort,
      '--tools', TOOLS_ARG,
      '--append-system-prompt', appendSystemPrompt,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--settings', settingsPath,
      '--setting-sources', 'local'
    );

    const env = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.OPENROUTER_API_KEY;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    env.ANTHROPIC_BASE_URL = proxyBaseUrl;
    env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = HAIKU_55;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.CLAUDE_CONFIG_DIR = cfgDir;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;

    const startNs = process.hrtime.bigint();
    const child = spawn(claudeExe, args, {
      cwd: repoDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (killErr) {
        console.warn('[spawn-timeout-kill]', killErr?.message);
      }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
      const stdout = Buffer.concat(outChunks).toString('utf8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      const parsedOut = parseTrailingJsonObject(stdout);

      resolve({
        code,
        timedOut,
        wallMs,
        parsedOut,
        stdoutPreview: stdout.slice(0, 400),
        stderrPreview: stderr.slice(0, 400)
      });
    });
  });
}

function readWireRecordsSinceOffset(wireLogPath, offsetBytes, runId) {
  if (!fs.existsSync(wireLogPath)) return [];
  const buf = fs.readFileSync(wireLogPath);
  const text = buf.subarray(Math.min(offsetBytes, buf.length)).toString('utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.context?.runId === runId && !rec.blockedByGuard && !rec.countTokensFallback) {
        out.push(rec);
      }
    } catch (jsonErr) {
      console.warn('[wire-line-skip]', jsonErr?.message);
    }
  }
  return out;
}

function summarizeTurnWire(records, scheduledSpec, wallMs) {
  const okRecords = records.filter((r) => (r.statusCode ?? 200) < 400);
  const main = okRecords.filter((r) => !r.isSideCall);
  const side = okRecords.filter((r) => r.isSideCall);
  const errors = records.filter((r) => (r.statusCode ?? 200) >= 400);

  const sumField = (arr, fn) => arr.reduce((s, r) => s + Number(fn(r) || 0), 0);
  const billedCostUsd = Number(sumField(okRecords, (r) => r.billedCostUsd ?? r.cost?.totalCostUsd).toFixed(6));
  const computedCostUsd = Number(sumField(okRecords, (r) => r.computedCostUsd ?? r.cost?.totalCostUsd).toFixed(6));
  const mainCostUsd = Number(sumField(main, (r) => r.billedCostUsd ?? r.cost?.totalCostUsd).toFixed(6));
  const sideCostUsd = Number(sumField(side, (r) => r.billedCostUsd ?? r.cost?.totalCostUsd).toFixed(6));

  const inputTokens = sumField(main, (r) => r.usage?.input_tokens);
  const cacheCreateTokens = sumField(main, (r) => r.usage?.cache_creation_input_tokens);
  const cacheReadTokens = sumField(main, (r) => r.usage?.cache_read_input_tokens);
  const outputTokens = sumField(main, (r) => r.usage?.output_tokens);
  const totalIn = inputTokens + cacheCreateTokens + cacheReadTokens;

  const firstMain = main[0] || null;
  const firstHitRatio = firstMain ? Number((firstMain.usage?.cache_hit_ratio ?? 0).toFixed(4)) : null;
  const turnHitRatio = totalIn > 0 ? Number((cacheReadTokens / totalIn).toFixed(4)) : 0;

  return {
    turn: scheduledSpec.turn,
    category: scheduledSpec.category,
    scheduledModel: scheduledSpec.model,
    scheduledEffort: scheduledSpec.effort,
    observedModel: firstMain ? normalizeModelShortName(firstMain.mappedModel || firstMain.responseModel || firstMain.requestedModel) : null,
    observedMappedModel: firstMain?.mappedModel || null,
    observedEffort: firstMain?.requestFingerprint?.output_config?.effort || null,
    costSource: firstMain?.costSource || null,
    requests: main.length,
    sideCalls: side.length,
    httpErrors: errors.map((e) => ({ statusCode: e.statusCode, errorPayload: e.errorPayload })),
    billedCostUsd,
    computedCostUsd,
    mainCostUsd,
    sideCostUsd,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens,
    firstRequestCacheCreateTokens: firstMain?.usage?.cache_creation_input_tokens ?? null,
    firstRequestCacheReadTokens: firstMain?.usage?.cache_read_input_tokens ?? null,
    firstRequestCacheHitRatio: firstHitRatio,
    cacheHitRatio: turnHitRatio,
    ttfbMs: main.length > 0 ? Number((sumField(main, (r) => r.timing?.ttfbMs) / main.length).toFixed(1)) : null,
    wallMs
  };
}

function setupIsolatedRunEnv(workRoot, task) {
  const repoDir = path.join(workRoot, 'repo');
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'claude_config');
  const settingsPath = path.join(workRoot, 'settings.json');
  rmDirBestEffort(workRoot, { label: 'pre_clean' });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {}, autoMemoryEnabled: false }, null, 2), 'utf8');

  copyDirClean(TEMPLATE_DIR, repoDir);
  const visibleSrc = path.join(VISIBLE_DIR, `${task.task_id}.visible.test.mjs`);
  fs.copyFileSync(visibleSrc, path.join(repoDir, 'test', 'task_visible.test.mjs'));
  fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'docs', 'BILLING_ARCHITECTURE_AND_INCIDENTS.md'), ARCH_DOC_CONTENT, 'utf8');

  const preSrcHashes = snapshotDirHashes(path.join(repoDir, 'src'));
  const prePkgHash = sha256File(path.join(repoDir, 'package.json'));
  const preFrozenHash = sha256File(path.join(repoDir, 'src', 'frozenWire.mjs'));
  const preConstantsHash = sha256File(path.join(repoDir, 'src', 'constants.mjs'));
  const salt = `PlaybookBenchRunId: ${path.basename(workRoot)} ${crypto.randomUUID()}`;

  return {
    workRoot,
    repoDir,
    homeDir,
    cfgDir,
    settingsPath,
    salt,
    preSrcHashes,
    prePkgHash,
    preFrozenHash,
    preConstantsHash
  };
}

async function executeTurnWithRetry({
  claudeExe,
  proxy,
  runId,
  arm,
  suite,
  task,
  turnSpec,
  sessionId,
  runEnv
}) {
  const prompt = buildTurnPrompt(turnSpec, task);
  let attempt = 0;
  let turnResult = null;
  let turnWireRecords = [];
  const offsetBefore = fs.existsSync(proxy.wireLogPath) ? fs.statSync(proxy.wireLogPath).size : 0;

  while (attempt < 2) {
    attempt += 1;
    const attemptOffset = fs.existsSync(proxy.wireLogPath) ? fs.statSync(proxy.wireLogPath).size : 0;
    proxy.beginTurn(turnSpec.turn, {
      runId,
      arm,
      suite,
      taskId: task.task_id,
      category: turnSpec.category,
      scheduledModel: turnSpec.model,
      scheduledEffort: turnSpec.effort,
      attempt
    });

    turnResult = await spawnClaudeTurn({
      claudeExe,
      prompt,
      model: turnSpec.model,
      effort: turnSpec.effort,
      sessionId,
      appendSystemPrompt: runEnv.salt,
      repoDir: runEnv.repoDir,
      homeDir: runEnv.homeDir,
      cfgDir: runEnv.cfgDir,
      settingsPath: runEnv.settingsPath,
      proxyBaseUrl: proxy.baseUrl
    });

    const wireThisAttempt = readWireRecordsSinceOffset(proxy.wireLogPath, attemptOffset, runId)
      .filter((r) => r.context?.turn === turnSpec.turn);
    const okMain = wireThisAttempt.filter((r) => !r.isSideCall && (r.statusCode ?? 200) < 400);
    turnWireRecords = readWireRecordsSinceOffset(proxy.wireLogPath, offsetBefore, runId)
      .filter((r) => r.context?.turn === turnSpec.turn);

    if (turnResult.code === 0 && !turnResult.timedOut && okMain.length > 0) {
      break;
    }
    const pState = proxy.getState();
    if (pState.capReason) {
      break;
    }
    if (attempt < 2) {
      console.warn(`[retry:${runId}:T${turnSpec.turn}] code=${turnResult.code} timedOut=${turnResult.timedOut} okMain=${okMain.length} err=${turnResult.stderrPreview.slice(0, 140)}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const nextSessionId = turnResult?.parsedOut?.session_id || sessionId;
  const wireSummary = summarizeTurnWire(turnWireRecords, turnSpec, turnResult?.wallMs ?? null);
  const pState = proxy.getState();
  return {
    turnResult,
    nextSessionId,
    wireSummary,
    capReason: pState.capReason || (wireSummary.httpErrors.length > 0 && wireSummary.requests === 0 ? `http_${wireSummary.httpErrors[0].statusCode}` : null)
  };
}

function finalizeRunMetrics(meta, turnSummaries, grades, errorMsg = null) {
  const sum = (fn) => turnSummaries.reduce((s, t) => s + Number(fn(t) || 0), 0);
  const totalIn = sum((t) => t.inputTokens + t.cacheCreateTokens + t.cacheReadTokens);
  const totalRead = sum((t) => t.cacheReadTokens);
  const billedCostUsd = Number(sum((t) => t.billedCostUsd).toFixed(6));
  const computedCostUsd = Number(sum((t) => t.computedCostUsd).toFixed(6));
  const mainCostUsd = Number(sum((t) => t.mainCostUsd).toFixed(6));
  const sideCostUsd = Number(sum((t) => t.sideCostUsd).toFixed(6));
  const requests = sum((t) => t.requests);
  const sideCalls = sum((t) => t.sideCalls);
  const inputTokens = sum((t) => t.inputTokens);
  const cacheCreateTokens = sum((t) => t.cacheCreateTokens);
  const cacheReadTokens = sum((t) => t.cacheReadTokens);
  const outputTokens = sum((t) => t.outputTokens);
  const wallMs = Number(sum((t) => t.wallMs).toFixed(2));
  const anyErrors = turnSummaries.some((t) => (t.httpErrors || []).length > 0 && t.requests === 0);

  return {
    run_id: meta.run_id,
    suite: meta.suite,
    arm: meta.arm,
    baselineArm: meta.baselineArm || null,
    task_id: meta.task_id,
    rep: meta.rep,
    status: errorMsg || anyErrors ? 'error' : 'ok',
    error: errorMsg || (anyErrors ? JSON.stringify(turnSummaries.flatMap((t) => t.httpErrors)) : null),
    completedAtUtc: new Date().toISOString(),
    billedCostUsd,
    computedCostUsd,
    mainCostUsd,
    sideCostUsd,
    requests,
    sideCalls,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens,
    overallCacheHitRatio: totalIn > 0 ? Number((totalRead / totalIn).toFixed(4)) : 0,
    wallMs,
    ...grades,
    turns: turnSummaries
  };
}

function median(vals = []) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(vals = []) {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function computeAggregateSummaries(runs = []) {
  const byArm = {};
  const okCore = runs.filter((r) => (r.suite === 'A1_OPUS' || r.suite === 'A2_SONNET') && r.status === 'ok');

  for (const armSpec of CORE_ARMS) {
    const group = okCore.filter((r) => r.arm === armSpec.arm);
    if (!group.length) continue;
    const costs = group.map((r) => r.billedCostUsd);
    const outs = group.map((r) => r.outputTokens);
    const creates = group.map((r) => r.cacheCreateTokens);
    const reads = group.map((r) => r.cacheReadTokens);
    const hits = group.map((r) => r.overallCacheHitRatio);
    const walls = group.map((r) => r.wallMs);
    const reqs = group.map((r) => r.requests);

    const perTurn = [1, 2, 3, 4].map((tn) => {
      const ts = group.map((r) => r.turns.find((t) => t.turn === tn)).filter(Boolean);
      return {
        turn: tn,
        category: ts[0]?.category || null,
        scheduledModel: ts[0]?.scheduledModel || null,
        scheduledEffort: ts[0]?.scheduledEffort || null,
        meanCostUsd: Number((mean(ts.map((t) => t.billedCostUsd)) || 0).toFixed(6)),
        medianCostUsd: Number((median(ts.map((t) => t.billedCostUsd)) || 0).toFixed(6)),
        meanOutTokens: Math.round(mean(ts.map((t) => t.outputTokens)) || 0),
        meanCacheCreate: Math.round(mean(ts.map((t) => t.cacheCreateTokens)) || 0),
        meanCacheRead: Math.round(mean(ts.map((t) => t.cacheReadTokens)) || 0),
        meanFirstHitRatio: Number((mean(ts.map((t) => t.firstRequestCacheHitRatio ?? t.cacheHitRatio)) || 0).toFixed(4)),
        meanTurnHitRatio: Number((mean(ts.map((t) => t.cacheHitRatio)) || 0).toFixed(4)),
        meanWallMs: Math.round(mean(ts.map((t) => t.wallMs)) || 0)
      };
    });

    byArm[armSpec.arm] = {
      suite: armSpec.suite,
      baselineArm: armSpec.baselineArm,
      n: group.length,
      allPassCount: group.filter((r) => r.allPass).length,
      t2PassCount: group.filter((r) => r.t2Pass).length,
      t3HiddenPassCount: group.filter((r) => r.t3HiddenPass).length,
      t4PassCount: group.filter((r) => r.t4Pass).length,
      totalBilledUsd: Number(costs.reduce((a, b) => a + b, 0).toFixed(6)),
      meanBilledUsd: Number(mean(costs).toFixed(6)),
      medianBilledUsd: Number(median(costs).toFixed(6)),
      meanOutTokens: Math.round(mean(outs)),
      medianOutTokens: Math.round(median(outs)),
      meanCacheCreateTokens: Math.round(mean(creates)),
      meanCacheReadTokens: Math.round(mean(reads)),
      meanCacheHitRatio: Number(mean(hits).toFixed(4)),
      meanWallMs: Math.round(mean(walls)),
      meanRequests: Number(mean(reqs).toFixed(2)),
      perTurn
    };
  }

  for (const [armName, s] of Object.entries(byArm)) {
    if (!s.baselineArm || !byArm[s.baselineArm]) continue;
    const base = byArm[s.baselineArm];
    const baseRuns = okCore.filter((r) => r.arm === s.baselineArm);
    const armRuns = okCore.filter((r) => r.arm === armName);
    const pairedDeltas = [];
    for (const ar of armRuns) {
      const br = baseRuns.find((b) => b.task_id === ar.task_id && b.rep === ar.rep);
      if (br && br.billedCostUsd > 0) {
        pairedDeltas.push(((ar.billedCostUsd - br.billedCostUsd) / br.billedCostUsd) * 100);
      }
    }
    s.vsBaseline = {
      baselineArm: s.baselineArm,
      meanCostDeltaPct: base.meanBilledUsd > 0 ? Number((((s.meanBilledUsd - base.meanBilledUsd) / base.meanBilledUsd) * 100).toFixed(2)) : null,
      medianCostDeltaPct: base.medianBilledUsd > 0 ? Number((((s.medianBilledUsd - base.medianBilledUsd) / base.medianBilledUsd) * 100).toFixed(2)) : null,
      medianPairedCostDeltaPct: pairedDeltas.length ? Number(median(pairedDeltas).toFixed(2)) : null,
      pairedWinCount: pairedDeltas.filter((d) => d < 0).length,
      pairedCount: pairedDeltas.length,
      meanOutDeltaPct: base.meanOutTokens > 0 ? Number((((s.meanOutTokens - base.meanOutTokens) / base.meanOutTokens) * 100).toFixed(2)) : null,
      meanWallDeltaPct: base.meanWallMs > 0 ? Number((((s.meanWallMs - base.meanWallMs) / base.meanWallMs) * 100).toFixed(2)) : null
    };
  }

  const suiteB = {
    legacy46EffortCheck: runs.find((r) => r.arm === 'LEGACY_46_EFFORT_CHECK') || null,
    coldStayOpus: runs.find((r) => r.arm === 'COLD_STAY_OPUS') || null,
    coldSwitchHaiku: runs.find((r) => r.arm === 'COLD_SWITCH_HAIKU') || null
  };

  return { byArm, suiteB };
}

function buildFullJobList({ pilot, skipTtlSleep }) {
  const jobs = [];
  const taskMap = new Map(TASKS.map((t) => [t.task_id, t]));
  const reps = pilot ? [1] : [1, 2];
  const taskIds = pilot ? ['T04'] : CORE_TASK_IDS;

  for (const taskId of taskIds) {
    const task = taskMap.get(taskId);
    for (const rep of reps) {
      for (const armSpec of CORE_ARMS) {
        jobs.push({
          kind: 'core4turn',
          run_id: `${taskId}_${armSpec.arm}_r${rep}`,
          suite: armSpec.suite,
          arm: armSpec.arm,
          baselineArm: armSpec.baselineArm,
          task_id: taskId,
          rep,
          task,
          turns: armSpec.turns
        });
      }
    }
  }

  const t04 = taskMap.get('T04');
  jobs.push({
    kind: 'legacy46',
    run_id: 'T04_LEGACY_46_EFFORT_CHECK_r1',
    suite: 'B_CALIBRATION',
    arm: 'LEGACY_46_EFFORT_CHECK',
    baselineArm: 'SONNET_PLAYBOOK',
    task_id: 'T04',
    rep: 1,
    task: t04,
    turns: [
      { turn: 1, category: 'Deep', model: SONNET_46, effort: 'high' },
      { turn: 2, category: 'Quick', model: SONNET_46, effort: 'low' }
    ]
  });

  if (!pilot && !skipTtlSleep) {
    jobs.push({
      kind: 'coldPair',
      run_id: 'T04_COLD_BOUNDARY_TTL_PAIR_r1',
      task: t04,
      pair: [
        {
          run_id: 'T04_COLD_STAY_OPUS_r1',
          suite: 'B_CALIBRATION',
          arm: 'COLD_STAY_OPUS',
          baselineArm: null,
          task_id: 'T04',
          rep: 1,
          turns: [
            { turn: 1, category: 'Deep', model: OPUS_55, effort: 'high' },
            { turn: 2, category: 'Quick', model: OPUS_55, effort: 'high' }
          ]
        },
        {
          run_id: 'T04_COLD_SWITCH_HAIKU_r1',
          suite: 'B_CALIBRATION',
          arm: 'COLD_SWITCH_HAIKU',
          baselineArm: 'COLD_STAY_OPUS',
          task_id: 'T04',
          rep: 1,
          turns: [
            { turn: 1, category: 'Deep', model: OPUS_55, effort: 'high' },
            { turn: 2, category: 'Quick', model: HAIKU_55, effort: 'low' }
          ]
        }
      ]
    });
  }

  return jobs;
}

function writeMockSse(res, { model, msgId, contentBlocks, stopReason = 'end_turn', isWarm = false, cost = 0.005, outTokens = 80 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: isWarm
        ? { input_tokens: 180, cache_creation_input_tokens: 450, cache_read_input_tokens: 34000, output_tokens: 1 }
        : { input_tokens: 80, cache_creation_input_tokens: 34000, cache_read_input_tokens: 0, output_tokens: 1 }
    }
  });
  contentBlocks.forEach((b, idx) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: b.text } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
    } else {
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
    }
  });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outTokens, cost }
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

async function runDryRunMock() {
  const claudeExe = findClaudeExe();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-playbook-mock-'));
  const workBase = path.join(root, 'work');
  const wireLogPath = OUT_MOCK_WIRE_JSONL;
  if (fs.existsSync(wireLogPath)) fs.unlinkSync(wireLogPath);

  const repoByRunId = new Map();
  let reqSeq = 0;

  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!req.url?.startsWith('/api/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = JSON.parse(raw);
      reqSeq += 1;
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      if (!parsed.stream || !hasTools) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `mock_side_${reqSeq}`,
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 }
        }));
        return;
      }

      const pState = proxy.getState();
      const ctx = pState.activeContext || {};
      const runId = ctx.runId || pState.runId || '';
      const turn = ctx.turn || 1;
      const repoDir = repoByRunId.get(runId);
      const messages = parsed.messages || [];
      const trailingUser = [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'assistant') break;
        trailingUser.unshift(messages[i]);
      }
      const trailingResults = trailingUser.flatMap((m) =>
        (Array.isArray(m?.content) ? m.content : []).filter((b) => b.type === 'tool_result')
      );

      const effort = parsed.output_config?.effort || 'high';
      const isLegacy46 = String(parsed.model || '').includes('4.6');
      const isWarm = !(turn === 1 || (turn === 2 && isLegacy46 && effort !== 'high') || String(ctx.arm || '').includes('NAIVE'));
      const outTok = effort === 'low' ? 70 : effort === 'medium' ? 220 : 480;
      const cost = isWarm ? 0.012 : 0.14;

      if (turn === 1) {
        if (trailingResults.length === 0) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm: false,
            cost,
            outTokens: outTok,
            contentBlocks: [
              {
                type: 'tool_use',
                id: `tu_read_${reqSeq}`,
                name: 'Read',
                input: { file_path: path.join(repoDir, 'test', 'task_visible.test.mjs') }
              }
            ]
          });
          return;
        }
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          cost: 0.015,
          outTokens: outTok,
          contentBlocks: [{ type: 'text', text: 'Plan: Fix src/tierEngine.mjs, src/creditPool.mjs, and src/invoiceBuilder.mjs for T04.' }]
        });
        return;
      }

      if (turn === 2) {
        if (trailingResults.length === 0) {
          const prevReadme = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8');
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm,
            cost,
            outTokens: outTok,
            contentBlocks: [
              {
                type: 'tool_use',
                id: `tu_readme_${reqSeq}`,
                name: 'Write',
                input: {
                  file_path: path.join(repoDir, 'README.md'),
                  content: `${prevReadme.trimEnd()}\n\n## Task Checklist\nTASK_ID: T04\n- src/tierEngine.mjs\n- src/creditPool.mjs\n- src/invoiceBuilder.mjs\n`
                }
              }
            ]
          });
          return;
        }
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          cost: 0.008,
          outTokens: 35,
          contentBlocks: [{ type: 'text', text: 'Updated README.md with T04 Task Checklist.' }]
        });
        return;
      }

      if (turn === 3) {
        if (trailingResults.length === 0) {
          const refT04 = path.join(REF_DIR, 'T04', 'src');
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm,
            cost,
            outTokens: outTok,
            contentBlocks: [
              {
                type: 'tool_use',
                id: `tu_w1_${reqSeq}`,
                name: 'Write',
                input: { file_path: path.join(repoDir, 'src', 'tierEngine.mjs'), content: fs.readFileSync(path.join(refT04, 'tierEngine.mjs'), 'utf8') }
              },
              {
                type: 'tool_use',
                id: `tu_w2_${reqSeq}`,
                name: 'Write',
                input: { file_path: path.join(repoDir, 'src', 'creditPool.mjs'), content: fs.readFileSync(path.join(refT04, 'creditPool.mjs'), 'utf8') }
              },
              {
                type: 'tool_use',
                id: `tu_w3_${reqSeq}`,
                name: 'Write',
                input: { file_path: path.join(repoDir, 'src', 'invoiceBuilder.mjs'), content: fs.readFileSync(path.join(refT04, 'invoiceBuilder.mjs'), 'utf8') }
              }
            ]
          });
          return;
        }
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          cost: 0.015,
          outTokens: outTok,
          contentBlocks: [{ type: 'text', text: 'Implemented T04 solution in src/ and verified tests.' }]
        });
        return;
      }

      // Turn 4
      if (trailingResults.length === 0) {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm,
          cost,
          outTokens: outTok,
          contentBlocks: [
            {
              type: 'tool_use',
              id: `tu_doc_${reqSeq}`,
              name: 'Write',
              input: {
                file_path: path.join(repoDir, 'docs', 'VERIFICATION_SUMMARY.md'),
                content: '# Verification Summary\nTask: T04\nStatus: PASS\n- src/tierEngine.mjs (frozenWire.mjs and package.json untouched)\n- src/creditPool.mjs (frozenWire.mjs and package.json untouched)\n- src/invoiceBuilder.mjs (frozenWire.mjs and package.json untouched)\n'
              }
            }
          ]
        });
        return;
      }
      writeMockSse(res, {
        model: parsed.model,
        msgId: `m_${reqSeq}`,
        stopReason: 'end_turn',
        isWarm: true,
        cost: 0.006,
        outTokens: 30,
        contentBlocks: [{ type: 'text', text: 'Created docs/VERIFICATION_SUMMARY.md.' }]
      });
    });
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const mockAddr = mockUpstream.address();
  const proxy = await startCptProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${mockAddr.port}`,
    upstreamApiPrefix: '/api',
    apiKey: 'mock-openrouter-key',
    wireLogPath,
    pinProvider: false,
    caps: resolveCptCaps({ maxRunCostUsd: 5.0 })
  });

  const runs = [];
  try {
    const t04 = TASKS.find((t) => t.task_id === 'T04');
    const mockJobs = [
      ...['OPUS_STATIC_HIGH', 'OPUS_PLAYBOOK', 'OPUS_NAIVE_SWITCH', 'SONNET_PLAYBOOK'].map((armName) => {
        const spec = CORE_ARMS.find((a) => a.arm === armName);
        return {
          kind: 'core4turn',
          run_id: `MOCK_${armName}`,
          suite: spec.suite,
          arm: spec.arm,
          baselineArm: spec.baselineArm,
          task_id: 'T04',
          rep: 1,
          task: t04,
          turns: spec.turns
        };
      }),
      {
        kind: 'legacy46',
        run_id: 'MOCK_LEGACY_46_EFFORT_CHECK',
        suite: 'B_CALIBRATION',
        arm: 'LEGACY_46_EFFORT_CHECK',
        baselineArm: 'SONNET_PLAYBOOK',
        task_id: 'T04',
        rep: 1,
        task: t04,
        turns: [
          { turn: 1, category: 'Deep', model: SONNET_46, effort: 'high' },
          { turn: 2, category: 'Quick', model: SONNET_46, effort: 'low' }
        ]
      }
    ];

    for (const job of mockJobs) {
      const workRoot = path.join(workBase, job.run_id);
      const runEnv = setupIsolatedRunEnv(workRoot, job.task);
      repoByRunId.set(job.run_id, runEnv.repoDir);
      proxy.beginRun(job.run_id);

      let sessionId = null;
      const turnSummaries = [];
      let t2Grade = null;
      let t3Hidden = null;
      let t4Grade = null;
      let errMsg = null;

      for (const turnSpec of job.turns) {
        const { nextSessionId, wireSummary, capReason } = await executeTurnWithRetry({
          claudeExe,
          proxy,
          runId: job.run_id,
          arm: job.arm,
          suite: job.suite,
          task: job.task,
          turnSpec,
          sessionId,
          runEnv
        });
        sessionId = nextSessionId;
        turnSummaries.push(wireSummary);
        if (capReason) {
          errMsg = capReason;
          break;
        }
        if (turnSpec.turn === 2) {
          t2Grade = gradeTurn2({ repoDir: runEnv.repoDir, task: job.task, preSrcHashes: runEnv.preSrcHashes, prePkgHash: runEnv.prePkgHash });
        } else if (turnSpec.turn === 3) {
          t3Hidden = evaluateHiddenSuite({ runId: job.run_id, turn: 3, taskId: job.task_id, repoDir: runEnv.repoDir });
        } else if (turnSpec.turn === 4) {
          t4Grade = gradeTurn4({
            runId: job.run_id,
            repoDir: runEnv.repoDir,
            task: job.task,
            prePkgHash: runEnv.prePkgHash,
            preFrozenHash: runEnv.preFrozenHash,
            preConstantsHash: runEnv.preConstantsHash
          });
        }
      }

      const grades =
        job.kind === 'core4turn'
          ? {
              t2Pass: Boolean(t2Grade?.passed),
              t3HiddenPass: Boolean(t3Hidden?.passed),
              t4Pass: Boolean(t4Grade?.passed),
              allPass: Boolean(t2Grade?.passed && t3Hidden?.passed && t4Grade?.passed),
              constraintViolations: Number(t3Hidden?.constraintViolations || 0)
            }
          : { t2Pass: Boolean(t2Grade?.passed), t3HiddenPass: null, t4Pass: null, allPass: Boolean(t2Grade?.passed), constraintViolations: 0 };

      runs.push(finalizeRunMetrics(job, turnSummaries, grades, errMsg));
      rmDirBestEffort(workRoot, { label: job.run_id });
    }

    const opusPlay = runs.find((r) => r.arm === 'OPUS_PLAYBOOK');
    assert.equal(opusPlay.status, 'ok');
    assert.equal(opusPlay.allPass, true, 'OPUS_PLAYBOOK must pass T2, T3 hidden, and T4');
    assert.deepEqual(opusPlay.turns.map((t) => t.observedEffort), ['high', 'low', 'medium', 'low']);
    const opusNaive = runs.find((r) => r.arm === 'OPUS_NAIVE_SWITCH');
    assert.deepEqual(opusNaive.turns.map((t) => t.observedModel), ['opus-5.5', 'sonnet-5.5', 'sonnet-5.5', 'haiku-5.5']);
    const leg46 = runs.find((r) => r.arm === 'LEGACY_46_EFFORT_CHECK');
    assert.deepEqual(leg46.turns.map((t) => t.observedEffort), ['high', 'low']);
    assert.equal(leg46.t2Pass, true);

    const agg = computeAggregateSummaries(runs);
    console.log('=== DRY-RUN MOCK PASS ===');
    console.log(JSON.stringify({
      runsCompleted: runs.length,
      archDocBytes: Buffer.byteLength(ARCH_DOC_CONTENT, 'utf8'),
      opusPlaybookEfforts: opusPlay.turns.map((t) => t.observedEffort),
      opusNaiveModels: opusNaive.turns.map((t) => t.observedModel),
      legacy46Efforts: leg46.turns.map((t) => t.observedEffort),
      byArm: Object.fromEntries(Object.entries(agg.byArm).map(([k, v]) => [k, { n: v.n, allPassCount: v.allPassCount, meanBilledUsd: v.meanBilledUsd }]))
    }, null, 2));
  } finally {
    await proxy.close();
    await new Promise((r) => mockUpstream.close(r));
    rmDirBestEffort(root, { label: 'mock_root' });
  }
}

async function runLive({ pilot, skipTtlSleep, maxBudgetUsd }) {
  const apiKey = loadOpenRouterApiKey();
  const claudeExe = findClaudeExe();
  const budgetCap = maxBudgetUsd || (pilot ? 8.0 : 32.0);
  const workBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-playbook-live-'));

  const stateDoc = {
    benchmark: 'playbook_ab_v1',
    mode: pilot ? 'pilot' : 'full',
    startedAtUtc: new Date().toISOString(),
    budgetCapUsd: budgetCap,
    runs: []
  };

  const isResume = parseArgs(process.argv.slice(2)).resume;
  if (isResume && fs.existsSync(OUT_RESULTS_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_RESULTS_JSON, 'utf8'));
      stateDoc.runs = Array.isArray(prev.runs) ? prev.runs.filter((r) => r.status === 'ok') : [];
      stateDoc.resumedFromCount = stateDoc.runs.length;
    } catch (err) {
      console.warn('[resume-load-warn]', err?.message);
    }
  } else if (!isResume && fs.existsSync(OUT_WIRE_JSONL)) {
    fs.unlinkSync(OUT_WIRE_JSONL);
  }

  const completedMap = new Map(stateDoc.runs.map((r) => [r.run_id, r]));
  let cumulativeSessionUsd = stateDoc.runs.reduce((s, r) => s + Number(r.billedCostUsd || 0), 0);

  const keyStart = await httpsGetKeyUsage(apiKey);
  fs.mkdirSync(path.dirname(OUT_LEDGER_JSONL), { recursive: true });
  fs.appendFileSync(OUT_LEDGER_JSONL, JSON.stringify({ event: 'start', mode: stateDoc.mode, budgetCapUsd: budgetCap, ...keyStart }) + '\n', 'utf8');
  console.log(`[ledger:start] OpenRouter usage=$${keyStart.usage} remaining=$${keyStart.limitRemaining} cachedOkRuns=${completedMap.size} priorUsd=$${cumulativeSessionUsd.toFixed(4)}`);

  const proxy = await startCptProxyServer({
    upstreamBaseUrl: 'https://openrouter.ai',
    upstreamApiPrefix: '/api',
    apiKey,
    wireLogPath: OUT_WIRE_JSONL,
    pinProvider: true,
    caps: resolveCptCaps({ maxRunCostUsd: 3.0, maxRequestsPerTurn: 25, maxRequestsPerRun: 80 })
  });

  function saveSnapshot() {
    const agg = computeAggregateSummaries(stateDoc.runs);
    const totalBilledUsd = Number(stateDoc.runs.reduce((s, r) => s + Number(r.billedCostUsd || 0), 0).toFixed(6));
    const payload = {
      ...stateDoc,
      updatedAtUtc: new Date().toISOString(),
      completedRuns: stateDoc.runs.length,
      okRuns: stateDoc.runs.filter((r) => r.status === 'ok').length,
      errorRuns: stateDoc.runs.filter((r) => r.status !== 'ok').length,
      totalBilledUsd,
      summaries: agg
    };
    writeFileAtomic(OUT_RESULTS_JSON, JSON.stringify(payload, null, 2));
  }

  function recordRun(runRecord) {
    const idx = stateDoc.runs.findIndex((r) => r.run_id === runRecord.run_id);
    if (idx >= 0) stateDoc.runs[idx] = runRecord;
    else stateDoc.runs.push(runRecord);
    completedMap.set(runRecord.run_id, runRecord);
    cumulativeSessionUsd = stateDoc.runs.reduce((s, r) => s + Number(r.billedCostUsd || 0), 0);
    saveSnapshot();
  }

  const jobs = buildFullJobList({ pilot, skipTtlSleep });

  try {
    for (const job of jobs) {
      if (cumulativeSessionUsd >= budgetCap) {
        console.warn(`[budget-stop] Cumulative spend $${cumulativeSessionUsd.toFixed(4)} >= cap $${budgetCap.toFixed(2)}. Stopping cleanly.`);
        break;
      }

      if (job.kind === 'core4turn' || job.kind === 'legacy46') {
        if (completedMap.has(job.run_id)) {
          console.log(`[skip:ok] ${job.run_id}`);
          continue;
        }
        console.log(`[run:start] ${job.run_id} (spent=$${cumulativeSessionUsd.toFixed(4)} / $${budgetCap.toFixed(2)})`);
        const workRoot = path.join(workBase, job.run_id);
        const runEnv = setupIsolatedRunEnv(workRoot, job.task);
        proxy.beginRun(job.run_id);

        let sessionId = null;
        const turnSummaries = [];
        let t2Grade = null;
        let t3Hidden = null;
        let t4Grade = null;
        let errMsg = null;

        try {
          for (const turnSpec of job.turns) {
            const { nextSessionId, wireSummary, capReason } = await executeTurnWithRetry({
              claudeExe,
              proxy,
              runId: job.run_id,
              arm: job.arm,
              suite: job.suite,
              task: job.task,
              turnSpec,
              sessionId,
              runEnv
            });
            sessionId = nextSessionId;
            turnSummaries.push(wireSummary);
            if (capReason) {
              errMsg = capReason;
              break;
            }
            if (turnSpec.turn === 2) {
              t2Grade = gradeTurn2({ repoDir: runEnv.repoDir, task: job.task, preSrcHashes: runEnv.preSrcHashes, prePkgHash: runEnv.prePkgHash });
            } else if (turnSpec.turn === 3) {
              t3Hidden = evaluateHiddenSuite({ runId: job.run_id, turn: 3, taskId: job.task_id, repoDir: runEnv.repoDir });
            } else if (turnSpec.turn === 4) {
              t4Grade = gradeTurn4({
                runId: job.run_id,
                repoDir: runEnv.repoDir,
                task: job.task,
                prePkgHash: runEnv.prePkgHash,
                preFrozenHash: runEnv.preFrozenHash,
                preConstantsHash: runEnv.preConstantsHash
              });
            }
          }
        } catch (err) {
          errMsg = err?.message || String(err);
        } finally {
          rmDirBestEffort(workRoot, { label: job.run_id });
        }

        const grades =
          job.kind === 'core4turn'
            ? {
                t2Pass: Boolean(t2Grade?.passed),
                t3HiddenPass: Boolean(t3Hidden?.passed),
                t4Pass: Boolean(t4Grade?.passed),
                allPass: Boolean(t2Grade?.passed && t3Hidden?.passed && t4Grade?.passed),
                constraintViolations: Number(t3Hidden?.constraintViolations || 0),
                t2Detail: t2Grade,
                t3Failing: t3Hidden?.failingNames || [],
                t4Detail: t4Grade
              }
            : {
                t2Pass: Boolean(t2Grade?.passed),
                t3HiddenPass: null,
                t4Pass: null,
                allPass: Boolean(t2Grade?.passed),
                constraintViolations: 0,
                t2Detail: t2Grade
              };

        const rec = finalizeRunMetrics(job, turnSummaries, grades, errMsg);
        recordRun(rec);
        console.log(
          `[run:done] ${rec.run_id} status=${rec.status} cost=$${rec.billedCostUsd.toFixed(4)} allPass=${rec.allPass} out=${rec.outputTokens} hit=${(rec.overallCacheHitRatio * 100).toFixed(1)}%`
        );
      } else if (job.kind === 'coldPair') {
        const [staySpec, switchSpec] = job.pair;
        if (completedMap.has(staySpec.run_id) && completedMap.has(switchSpec.run_id)) {
          console.log('[skip:ok] COLD_BOUNDARY_TTL pair');
          continue;
        }
        console.log(`[run:start] COLD_BOUNDARY_TTL pair (shared 320s wait, spent=$${cumulativeSessionUsd.toFixed(4)} / $${budgetCap.toFixed(2)})`);
        const contexts = [];
        for (const spec of job.pair) {
          const workRoot = path.join(workBase, spec.run_id);
          const runEnv = setupIsolatedRunEnv(workRoot, job.task);
          proxy.beginRun(spec.run_id);
          const t1Res = await executeTurnWithRetry({
            claudeExe,
            proxy,
            runId: spec.run_id,
            arm: spec.arm,
            suite: spec.suite,
            task: job.task,
            turnSpec: spec.turns[0],
            sessionId: null,
            runEnv
          });
          contexts.push({
            spec,
            workRoot,
            runEnv,
            sessionId: t1Res.nextSessionId,
            t1Wire: t1Res.wireSummary,
            t1Cap: t1Res.capReason,
            t1DoneAtMs: Date.now()
          });
        }

        const latestT1DoneMs = Math.max(...contexts.map((c) => c.t1DoneAtMs));
        const waitMs = Math.max(0, (latestT1DoneMs + TTL_EXPIRY_WAIT_MS) - Date.now());
        if (waitMs > 0) {
          console.log(`[coldPair] Waiting ${(waitMs / 1000).toFixed(1)}s for both 5m ephemeral caches to expire...`);
          await new Promise((r) => setTimeout(r, waitMs));
        }

        for (const c of contexts) {
          const turnSummaries = [c.t1Wire];
          let t2Grade = null;
          let errMsg = c.t1Cap || null;
          const actualIdleSec = Number(((Date.now() - c.t1DoneAtMs) / 1000).toFixed(2));
          try {
            if (!errMsg) {
              proxy.beginRun(c.spec.run_id);
              const t2Res = await executeTurnWithRetry({
                claudeExe,
                proxy,
                runId: c.spec.run_id,
                arm: c.spec.arm,
                suite: c.spec.suite,
                task: job.task,
                turnSpec: c.spec.turns[1],
                sessionId: c.sessionId,
                runEnv: c.runEnv
              });
              turnSummaries.push({ ...t2Res.wireSummary, actualIdleSec });
              if (t2Res.capReason) errMsg = t2Res.capReason;
              else {
                t2Grade = gradeTurn2({
                  repoDir: c.runEnv.repoDir,
                  task: job.task,
                  preSrcHashes: c.runEnv.preSrcHashes,
                  prePkgHash: c.runEnv.prePkgHash
                });
              }
            }
          } finally {
            rmDirBestEffort(c.workRoot, { label: c.spec.run_id });
          }
          const rec = finalizeRunMetrics(
            c.spec,
            turnSummaries,
            { t2Pass: Boolean(t2Grade?.passed), t3HiddenPass: null, t4Pass: null, allPass: Boolean(t2Grade?.passed), constraintViolations: 0, actualIdleSec },
            errMsg
          );
          recordRun(rec);
          console.log(
            `[coldPair:done] ${rec.run_id} idle=${actualIdleSec}s t2Read=${rec.turns[1]?.cacheReadTokens ?? null} cost=$${rec.billedCostUsd.toFixed(4)} t2Pass=${rec.t2Pass}`
          );
        }
      }
    }
  } finally {
    await proxy.close();
    rmDirBestEffort(workBase, { label: 'live_work_base' });
    const keyEnd = await httpsGetKeyUsage(apiKey);
    fs.appendFileSync(
      OUT_LEDGER_JSONL,
      JSON.stringify({
        event: 'end',
        mode: stateDoc.mode,
        ...keyEnd,
        keyUsageDeltaUsd:
          typeof keyStart.usage === 'number' && typeof keyEnd.usage === 'number'
            ? Number((keyEnd.usage - keyStart.usage).toFixed(6))
            : null,
        summedWireBilledUsd: Number(stateDoc.runs.reduce((s, r) => s + Number(r.billedCostUsd || 0), 0).toFixed(6))
      }) + '\n',
      'utf8'
    );
    saveSnapshot();
    console.log(
      `[ledger:end] OpenRouter usage=$${keyEnd.usage} delta=$${
        typeof keyStart.usage === 'number' && typeof keyEnd.usage === 'number' ? (keyEnd.usage - keyStart.usage).toFixed(4) : 'n/a'
      } totalRuns=${stateDoc.runs.length}`
    );
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.dryRunMock) {
    await runDryRunMock();
    return;
  }
  if (!flags.confirmLiveSpend || (!flags.pilot && !flags.full)) {
    console.error(
      'Usage:\n' +
        '  node run_playbook_ab.mjs --dry-run-mock\n' +
        '  node run_playbook_ab.mjs --confirm-live-spend --pilot [--resume] [--max-budget 8.0]\n' +
        '  node run_playbook_ab.mjs --confirm-live-spend --full [--resume] [--max-budget 32.0] [--skip-ttl-sleep]'
    );
    process.exit(1);
  }
  await runLive({
    pilot: flags.pilot && !flags.full,
    skipTtlSleep: flags.skipTtlSleep,
    maxBudgetUsd: flags.maxBudgetUsd
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[FATAL]', err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
