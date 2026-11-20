#!/usr/bin/env node
/**
 * Paired Test B: Highbeam-OFF (BASELINE) vs. Highbeam-ON (HIGHBEAM) Cost-Per-Completed-Task Harness
 *
 * Modes:
 *   --dry-run-mock                          $0 wire-protocol & token-delta A/B proof with real pinned claude.exe
 *   --confirm-live-spend [--tasks T01,T04]  Live paid OpenRouter paired A/B benchmark (explicit opt-in required)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RESULTS_DIR,
  CLAUDE_EXE,
  loadOpenRouterApiKey,
  mapCliModelToOpenRouter
} from '../config.mjs';
import { startCptProxyServer, resolveCptCaps } from './cpt_proxy.mjs';
import {
  TASKS,
  TURN2_IMPLEMENT_PROMPT,
  RETRY_PROMPT_HEADER,
  buildTurn1Prompt
} from './tasks_manifest.mjs';
import {
  EXPLORATION_TASKS,
  applyExplorationOverlay,
  buildExplorationPadLines
} from './exploration_tasks_manifest.mjs';
import { redactSensitiveText } from '../tests_3_to_8/prefix_lab.mjs';
import { evaluateHiddenSuite } from './run_cost_per_task.mjs';
import { configureShield, configureScout } from '../../../src/core/shield_manager.mjs';
import {
  computeExPostRealizedSavings,
  getSavedQuotaReceiptSummary
} from '../../../src/core-isomorphic/coach/savedQuotaLedger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATE_DIR = path.join(__dirname, 'task_repo_template');
const VISIBLE_DIR = path.join(__dirname, 'visible_suites');
const HIDDEN_DIR = path.join(__dirname, 'hidden_suites');
const REF_DIR = path.join(__dirname, 'reference_solutions');
const EXP_VISIBLE_DIR = path.join(__dirname, 'exploration_suites', 'visible');
const EXP_HIDDEN_DIR = path.join(__dirname, 'exploration_suites', 'hidden');
const EXP_REF_DIR = path.join(__dirname, 'exploration_suites', 'reference');
const ALL_TASKS = [...TASKS, ...EXPLORATION_TASKS];
const SONNET_CLI = 'claude-sonnet-5-5';

export function rmDirBestEffort(dirPath, { label = 'temp', retries = 10, retryDelayMs = 150 } = {}) {
  if (!dirPath || !fs.existsSync(dirPath)) return true;
  try {
    fs.rmSync(dirPath, {
      recursive: true,
      force: true,
      maxRetries: retries,
      retryDelay: retryDelayMs
    });
    return true;
  } catch (err) {
    console.warn(`[cleanup-warn:${label}] Could not remove ${dirPath}: ${err?.code || err?.message}`);
    return false;
  }
}

export function pruneOrphanWireLog(wireLogPath, keepRunIds = new Set()) {
  if (!wireLogPath || !fs.existsSync(wireLogPath)) {
    return { kept: 0, pruned: 0 };
  }
  const keepSet = keepRunIds instanceof Set ? keepRunIds : new Set(keepRunIds || []);
  const lines = fs.readFileSync(wireLogPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const retained = [];
  let pruned = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const runId = rec?.context?.runId;
      if (runId && keepSet.has(runId)) {
        retained.push(line);
      } else {
        pruned += 1;
      }
    } catch {
      pruned += 1;
    }
  }
  if (pruned > 0) {
    fs.writeFileSync(wireLogPath, retained.length > 0 ? retained.join('\n') + '\n' : '', 'utf8');
  }
  return { kept: retained.length, pruned };
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

const AB_TURN2_IMPLEMENT_PROMPT =
  `${TURN2_IMPLEMENT_PROMPT} Also run \`node scripts/diag_check.mjs\` to confirm repository diagnostics pass cleanly.`;

function buildAbTurn1Prompt(task) {
  return `${buildTurn1Prompt(task)}\n\nAlso inspect \`docs/ARCHITECTURE_SPEC.md\` to confirm policy invariants before finalizing your plan.`;
}

function buildTrailingDocPadLines(count = 185) {
  return Array.from(
    { length: count },
    (_, i) => `export function diagPadHelper_${i + 1}(units = 0) { return Math.max(0, Number(units) || 0) + ${i + 1}; }`
  ).join('\n');
}

function resolvePrimaryPadTarget(task) {
  const list = Array.isArray(task?.target_files) ? task.target_files : [];
  return list.find((f) => !/(?:frozenWire|constants|errors)\.mjs$/i.test(f)) || 'src/tierEngine.mjs';
}

function applyRealisticScaleOverlay(repoDir, task) {
  // 1. Wide >16 KB markdown spec (~28 KB across 180 lines) for IMP-4D probe
  const docsDir = path.join(repoDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const specLines = [];
  for (let i = 0; i < 180; i += 1) {
    if (i % 30 === 0) {
      specLines.push(`## Section ${i / 30 + 1}: Graduated Tier Allocation Policy (${i + 1})`);
    } else if (i === 120) {
      specLines.push('REQUIRED_BAND_RULE: Use half-away-from-zero Math.round(bandUnits * unitRateCents) with marginal band deltas and ZERO +1 double counting across tiers.');
    } else {
      specLines.push(`Spec paragraph ${i + 1}: Deterministic multi-tenant ledger rounding and idempotent credit settlement invariant record payload padding ${'x'.repeat(92)}`);
    }
  }
  fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE_SPEC.md'), specLines.join('\n') + '\n', 'utf8');

  // 2. CLI diagnostic script producing 60 lines (~6.4 KB) for IMP-1 probe
  const scriptsDir = path.join(repoDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const diagScript = [
    'for (let i = 1; i <= 60; i += 1) {',
    "  const tag = i === 14 ? 'WARN: tier rounding edge at band boundary' : 'OK';",
    '  console.log(`check[${String(i).padStart(2, "0")}] module=ledger invariant=band_${i} detail=${"d".repeat(60)} status=${tag}`);',
    '}'
  ].join('\n');
  fs.writeFileSync(path.join(scriptsDir, 'diag_check.mjs'), diagScript + '\n', 'utf8');

  // 3. Extend task primary mutable source file beyond 150 lines (~240+ lines) while keeping exports valid for IMP-4B probe
  const relPad = resolvePrimaryPadTarget(task);
  const padPath = path.join(repoDir, relPad);
  if (fs.existsSync(padPath)) {
    const existing = fs.readFileSync(padPath, 'utf8');
    fs.writeFileSync(padPath, `${existing.trimEnd()}\n\n// Extended diagnostic helpers\n${buildTrailingDocPadLines(185)}\n`, 'utf8');
  }
}

export const AB_ARMS = ['BASELINE', 'HIGHBEAM_SHIELD_OFF', 'HIGHBEAM'];

export function readHighbeamHookStats(repoDir) {
  const byCategory = {};
  let totalReceipts = 0;
  let ledgerSavedTokens = 0;
  let shieldBlocksByteCap = 0;
  let shieldClampsByteCap = 0;
  let shieldClampsExplicitSlice = 0;
  let shieldBlocksLineCap = 0;
  let shieldBlocksOversizedSlice = 0;

  const ledgerPath = path.join(repoDir, '.claude', 'cache', 'horizon_ledger.jsonl');
  let ledgerBuckets = {
    avoidedWriteTokens: 0,
    avoidedWriteUsd: 0,
    avoidedWriteRateUsd: 0,
    platformCacheDiscountTokens: 0,
    platformCacheDiscountUsd: 0
  };
  if (fs.existsSync(ledgerPath)) {
    const lines = fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const cat = String(entry.category || 'UNKNOWN');
        byCategory[cat] = (byCategory[cat] || 0) + 1;
        totalReceipts += 1;
        ledgerSavedTokens += Number(entry.savedTokens || 0);
      } catch (err) {
        void err;
      }
    }
    try {
      const summary = getSavedQuotaReceiptSummary({ ledgerPath });
      ledgerBuckets = {
        avoidedWriteTokens: Number(summary.buckets?.avoidedWrites?.tokens || 0),
        avoidedWriteUsd: Number(summary.buckets?.avoidedWrites?.usd || 0),
        avoidedWriteRateUsd: Number(summary.buckets?.avoidedWrites?.writeRateUSD || 0),
        platformCacheDiscountTokens: Number(summary.buckets?.platformCacheDiscount?.tokens || 0),
        platformCacheDiscountUsd: Number(summary.buckets?.platformCacheDiscount?.usd || 0)
      };
    } catch (err) {
      void err;
    }
  }

  const telemetryDir = path.join(repoDir, '.agents', 'telemetry');
  if (fs.existsSync(telemetryDir)) {
    for (const fname of fs.readdirSync(telemetryDir)) {
      if (!fname.endsWith('.hints.jsonl')) continue;
      const lines = fs.readFileSync(path.join(telemetryDir, fname), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const hint = JSON.parse(line);
          if (hint.event === 'blocked_unsliced_read') {
            if (hint.trigger_reason === 'byte_width_cap') shieldBlocksByteCap += 1;
            else shieldBlocksLineCap += 1;
          } else if (hint.event === 'blocked_oversized_slice') {
            shieldBlocksOversizedSlice += 1;
          } else if (hint.event === 'clamped_unsliced_read') {
            shieldClampsByteCap += 1;
          } else if (hint.event === 'clamped_explicit_slice') {
            shieldClampsExplicitSlice += 1;
          }
        } catch (err) {
          void err;
        }
      }
    }
  }

  const shieldBlocksTotal = shieldBlocksByteCap + shieldBlocksLineCap + shieldBlocksOversizedSlice;
  const shieldClampsTotal = shieldClampsByteCap + shieldClampsExplicitSlice;

  return {
    totalReceipts,
    byCategory,
    ledgerSavedTokens,
    ledgerBuckets,
    shieldBlocksByteCap,
    shieldClampsByteCap,
    shieldClampsExplicitSlice,
    shieldClampsTotal,
    shieldBlocksLineCap,
    shieldBlocksOversizedSlice,
    shieldBlocksTotal
  };
}

export function buildHaikuScoutAgentsPayload() {
  const agentPath = path.join(REPO_ROOT, 'agents', 'ah-haiku-scout.md');
  const raw = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf8') : '';
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fm = fmMatch ? fmMatch[1] : '';
  const body = (fmMatch ? fmMatch[2] : raw).trim() ||
    'Read-only repository scout. Use Glob, Grep, and bounded Read (offset/limit) to return File:StartLine-EndLine coordinates concisely.';
  const descMatch = fm.match(/^\s*description\s*:\s*([^\r\n]+)/im);
  const description = descMatch
    ? descMatch[1].trim().replace(/^['"]|['"]$/g, '')
    : 'Lean Haiku read-only repository scout for multi-file exploration.';
  return {
    'ah-haiku-scout': {
      description,
      prompt: body,
      tools: ['Read', 'Grep', 'Glob'],
      model: 'haiku'
    }
  };
}

export function buildSettingsPayload(arm, repoDir) {
  if (arm === 'BASELINE') {
    return { hooks: {}, autoMemoryEnabled: false };
  }
  if (arm === 'HIGHBEAM_SHIELD_OFF') {
    configureShield({ action: 'disable', platform: 'claude', cwd: repoDir });
  } else if (arm === 'HIGHBEAM_AUTO') {
    configureShield({ action: 'auto', platform: 'claude', cwd: repoDir });
  } else {
    configureShield({ action: 'enable', platform: 'claude', cwd: repoDir });
  }
  const isScoutArm = arm === 'HIGHBEAM_SCOUT';
  if (isScoutArm) {
    configureScout({ action: 'enable', cwd: repoDir, pkgRoot: REPO_ROOT });
  }
  const preHookPath = path.join(REPO_ROOT, 'hooks', 'handlers', 'pre-tool-use.mjs').replace(/\\/g, '/');
  const postHookPath = path.join(REPO_ROOT, 'hooks', 'handlers', 'post-tool-use.mjs').replace(/\\/g, '/');
  return {
    autoMemoryEnabled: false,
    hooks: {
      PreToolUse: [
        {
          matcher: isScoutArm
            ? 'Read|Edit|Write|MultiEdit|Bash|PowerShell|Task|Agent'
            : 'Read|Edit|Write|MultiEdit|Bash|PowerShell',
          hooks: [
            {
              type: 'command',
              command: `node --no-warnings "${preHookPath}"`
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: isScoutArm
            ? 'Bash|PowerShell|Grep|Glob|Task|Agent'
            : 'Bash|PowerShell|Grep|Glob',
          hooks: [
            {
              type: 'command',
              command: `node --no-warnings "${postHookPath}"`
            }
          ]
        }
      ]
    }
  };
}

function writeMockSse(res, { model, msgId, contentBlocks, stopReason = 'end_turn', isWarm = false, cost = 0.005 }) {
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
        ? { input_tokens: 150, cache_creation_input_tokens: 400, cache_read_input_tokens: 12000, output_tokens: 1 }
        : { input_tokens: 50, cache_creation_input_tokens: 12000, cache_read_input_tokens: 0, output_tokens: 1 }
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
    usage: { output_tokens: 60, cost }
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function extractResultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.filter((x) => x && typeof x.text === 'string').map((x) => x.text).join('\n');
  }
  return JSON.stringify(block.content || '');
}

export function createEmptyWireObs() {
  return {
    requests: 0,
    totalMessagesChars: 0,
    finalMessagesChars: 0,
    totalToolResultChars: 0,
    totalBashResultChars: 0,
    toolCallsByName: {},
    modelsSeen: {},
    haikuRequests: 0,
    sonnetRequests: 0,
    subagentSpawns: [],
    specReadResultChars: 0,
    specShieldDenied: false,
    specShieldClamped: false,
    bashDiagResultChars: 0,
    postEditReadResultChars: 0,
    postEditFoldContextInjected: false
  };
}

export function observeWireRequest(obs, parsedReq, context = {}) {
  if (!obs || !parsedReq) return obs;
  const messages = Array.isArray(parsedReq.messages) ? parsedReq.messages : [];
  const msgsStr = JSON.stringify(messages);
  obs.requests += 1;
  obs.totalMessagesChars += msgsStr.length;
  obs.finalMessagesChars = msgsStr.length;

  const rawModel = String(parsedReq.model || 'unknown');
  obs.modelsSeen[rawModel] = (obs.modelsSeen[rawModel] || 0) + 1;
  if (/haiku/i.test(rawModel)) obs.haikuRequests += 1;
  else if (/sonnet/i.test(rawModel)) obs.sonnetRequests += 1;

  const trailingUser = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') break;
    trailingUser.unshift(messages[i]);
  }
  const trailingBlocks = trailingUser.flatMap((m) =>
    Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content || '') }]
  );
  const trailingText = trailingBlocks
    .filter((b) => b && b.type === 'text')
    .map((b) => String(b.text || ''))
    .join('\n');
  const trailingResults = trailingBlocks.filter((b) => b && b.type === 'tool_result');

  if (trailingText.includes('GUARD-4 Post-Edit Verify Fold')) {
    obs.postEditFoldContextInjected = true;
  }

  const allToolUses = [];
  const toolUseById = new Map();
  const editedPathsBeforeTrailing = new Set();
  const cutoffIdx = messages.length - trailingUser.length;
  for (let i = 0; i < cutoffIdx; i += 1) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use') {
          allToolUses.push(b);
          if (b.id) toolUseById.set(b.id, b);
          if (i < cutoffIdx - 1 && /^(?:Edit|Write|MultiEdit)$/i.test(String(b.name || ''))) {
            const ep = String(b.input?.file_path || '');
            if (ep) editedPathsBeforeTrailing.add(ep.replace(/\\/g, '/'));
          }
        }
      }
    }
  }

  const lastToolFallback = allToolUses[allToolUses.length - 1] || null;
  for (const resBlock of trailingResults) {
    const tu = (resBlock.tool_use_id && toolUseById.get(resBlock.tool_use_id)) || lastToolFallback;
    const resText = extractResultText(resBlock);
    obs.totalToolResultChars += resText.length;

    const tName = String(tu?.name || 'unknown');
    obs.toolCallsByName[tName] = (obs.toolCallsByName[tName] || 0) + 1;

    if (resText.includes('GUARD-4 Post-Edit Verify Fold')) {
      obs.postEditFoldContextInjected = true;
    }

    if (tName === 'Read') {
      const fpath = String(tu?.input?.file_path || '').replace(/\\/g, '/');
      if (fpath.includes('ARCHITECTURE_SPEC.md') || fpath.endsWith('.index.md')) {
        obs.specReadResultChars += resText.length;
        if (fpath.includes('ARCHITECTURE_SPEC.md') && tu?.input?.limit === undefined) {
          if (
            !resBlock.is_error &&
            (trailingText.includes('Highbeam Shield clamped') || resText.includes('Highbeam Shield clamped'))
          ) {
            obs.specShieldClamped = true;
          }
          if (resBlock.is_error && resText.includes('.agents/cache/indices/')) {
            obs.specShieldDenied = true;
          }
        }
      } else {
        const isEditedTarget =
          editedPathsBeforeTrailing.has(fpath) ||
          Array.from(editedPathsBeforeTrailing).some((ep) => ep && fpath.endsWith(path.posix.basename(ep)));
        if (tu?.input?.limit === undefined && isEditedTarget) {
          obs.postEditReadResultChars += resText.length;
        }
      }
    } else if (tName === 'Bash') {
      obs.totalBashResultChars += resText.length;
      const cmd = String(tu?.input?.command || '');
      if (cmd.includes('diag_check') || String(context?.phase || '').startsWith('implement')) {
        if (cmd.includes('diag_check') || obs.bashDiagResultChars === 0) {
          obs.bashDiagResultChars += resText.length;
        }
      }
    } else if (tName === 'Agent' || tName === 'Task') {
      obs.subagentSpawns.push({
        toolName: tName,
        subagentType: String(tu?.input?.subagent_type || 'unknown'),
        requestedModel: String(tu?.input?.model || 'inherit')
      });
    }
  }

  return obs;
}

export function findSessionJsonlFiles(rootDir, acc = []) {
  if (!rootDir || !fs.existsSync(rootDir)) return acc;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) findSessionJsonlFiles(full, acc);
    else if (entry.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

export function sanitizeArtifactText(raw = '', repoDir = '') {
  let text = String(raw || '');
  if (repoDir) {
    text = text.split(repoDir).join('<REPO_DIR>').split(repoDir.replace(/\\/g, '/')).join('<REPO_DIR>');
  }
  return redactSensitiveText(text);
}

export function persistRunArtifacts({ rawDir, spec, repoDir, cfgDir, homeDir }) {
  if (!rawDir) {
    return { transcriptPath: null, ledgerPath: null, hintsPath: null };
  }
  fs.mkdirSync(rawDir, { recursive: true });
  const runId = String(spec?.run_id || 'run');
  let transcriptPath = null;
  let ledgerPath = null;
  let hintsPath = null;

  const jsonls = [
    ...findSessionJsonlFiles(cfgDir),
    ...findSessionJsonlFiles(path.join(homeDir || '', '.claude'))
  ].sort((a, b) => {
    try {
      return fs.statSync(b).size - fs.statSync(a).size;
    } catch {
      return 0;
    }
  });
  if (jsonls.length > 0) {
    const tDir = path.join(rawDir, 'transcripts');
    fs.mkdirSync(tDir, { recursive: true });
    const dst = path.join(tDir, `${runId}.jsonl`);
    fs.writeFileSync(dst, sanitizeArtifactText(fs.readFileSync(jsonls[0], 'utf8'), repoDir), 'utf8');
    transcriptPath = path.relative(rawDir, dst).replace(/\\/g, '/');
  }

  const srcLedger = path.join(repoDir, '.claude', 'cache', 'horizon_ledger.jsonl');
  if (fs.existsSync(srcLedger)) {
    const lDir = path.join(rawDir, 'ledgers');
    fs.mkdirSync(lDir, { recursive: true });
    const dst = path.join(lDir, `${runId}.ledger.jsonl`);
    fs.writeFileSync(dst, sanitizeArtifactText(fs.readFileSync(srcLedger, 'utf8'), repoDir), 'utf8');
    ledgerPath = path.relative(rawDir, dst).replace(/\\/g, '/');
  }

  const telemetryDir = path.join(repoDir, '.agents', 'telemetry');
  if (fs.existsSync(telemetryDir)) {
    const hintChunks = [];
    for (const fname of fs.readdirSync(telemetryDir)) {
      if (!fname.endsWith('.hints.jsonl')) continue;
      hintChunks.push(fs.readFileSync(path.join(telemetryDir, fname), 'utf8').trimEnd());
    }
    if (hintChunks.length > 0) {
      const hDir = path.join(rawDir, 'telemetry');
      fs.mkdirSync(hDir, { recursive: true });
      const dst = path.join(hDir, `${runId}.hints.jsonl`);
      fs.writeFileSync(dst, sanitizeArtifactText(hintChunks.filter(Boolean).join('\n') + '\n', repoDir), 'utf8');
      hintsPath = path.relative(rawDir, dst).replace(/\\/g, '/');
    }
  }

  return { transcriptPath, ledgerPath, hintsPath };
}

async function executeAbRun({ spec, task, claudeExe, proxy, caps, workBaseDir, rawDir = null, onWireObserve }) {
  const workRoot = path.join(workBaseDir, spec.run_id);
  const repoDir = path.join(workRoot, 'repo');
  const homeDir = path.join(workRoot, 'home');
  const cfgDir = path.join(workRoot, 'cfg');
  const settingsPath = path.join(workRoot, 'settings.json');
  const isExploration = Boolean(task?.is_exploration);
  const visibleDir = isExploration ? EXP_VISIBLE_DIR : VISIBLE_DIR;
  const hiddenDir = isExploration ? EXP_HIDDEN_DIR : HIDDEN_DIR;
  const nonce = crypto.createHash('sha256').update(`${spec.run_id}_${Date.now()}`).digest('hex').slice(0, 10);
  const salt = `Benchmark-Run-Salt: ${spec.run_id}_${nonce}`;

  rmDirBestEffort(workRoot, { label: 'pre_work' });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  copyDirClean(TEMPLATE_DIR, repoDir);
  fs.copyFileSync(path.join(visibleDir, `${task.task_id}.visible.test.mjs`), path.join(repoDir, 'test', 'task_visible.test.mjs'));
  if (isExploration) {
    applyExplorationOverlay(repoDir, task);
  } else {
    applyRealisticScaleOverlay(repoDir, task);
  }

  for (const gitArgs of [
    ['init'],
    ['config', 'user.email', 'bench@local'],
    ['config', 'user.name', 'bench'],
    ['add', '-A'],
    ['commit', '-m', 'baseline']
  ]) {
    const g = spawnSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8' });
    if (g.status !== 0) throw new Error(`git ${gitArgs[0]} failed: ${g.stderr}`);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(buildSettingsPayload(spec.arm, repoDir), null, 2), 'utf8');

  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = proxy.baseUrl;
  env.ANTHROPIC_API_KEY = 'sk-ant-api03-local-proxy-000000000000';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CONFIG_DIR = cfgDir;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  if (isExploration || spec.arm === 'HIGHBEAM_SCOUT') {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
  }

  const toolsArg =
    isExploration || spec.arm === 'HIGHBEAM_SCOUT'
      ? 'Read,Edit,Write,Bash,Grep,Glob,Agent'
      : 'Read,Edit,Write,Bash,Grep,Glob';
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'plan',
    '--allow-dangerously-skip-permissions',
    '--permission-prompts', 'none',
    '--tools', toolsArg,
    '--model', SONNET_CLI,
    '--effort', 'medium',
    '--append-system-prompt', salt,
    '--settings', settingsPath,
    '--setting-sources', 'local'
  ];
  if (spec.arm === 'HIGHBEAM_SCOUT') {
    const agentsJsonPath = path.join(workRoot, 'agents.json');
    fs.writeFileSync(agentsJsonPath, JSON.stringify(buildHaikuScoutAgentsPayload(), null, 2), 'utf8');
    args.push('--agents', agentsJsonPath);
  }

  const wireLogOffsetBytes = fs.existsSync(proxy.wireLogPath) ? fs.statSync(proxy.wireLogPath).size : 0;
  proxy.beginRun(spec.run_id);
  const runStartMs = Date.now();
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
      } catch (parseErr) {
        void parseErr;
      }
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

  function waitForEvent(pred, timeoutMs = 180_000, fromIndex = 0) {
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
        const pState = proxy.getState();
        if (pState.capReason) {
          clearInterval(iv);
          resolve({ capped: true, capReason: pState.capReason });
          return;
        }
        if (childClosed) {
          clearInterval(iv);
          reject(new Error(`[${spec.run_id}] claude exited early (${exitCode}): ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 400)}`));
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`[${spec.run_id}] Timed out waiting for claude event`));
        }
      }, 25);
    });
  }

  let turnsCompleted = 0;
  let completed = false;
  let capReason = '';
  let constraintViolations = 0;
  const wireObs = createEmptyWireObs();
  if (onWireObserve) onWireObserve(spec.run_id, wireObs);

  try {
    // Turn 1: Plan mode (neutral prompt identical across all arms)
    proxy.beginTurn(1, { runId: spec.run_id, arm: spec.arm, rep: spec.rep ?? 1, taskId: task.task_id, difficulty: task.difficulty, phase: 'plan' });
    const t1Idx = events.length;
    const turn1Prompt = isExploration ? buildTurn1Prompt(task) : buildAbTurn1Prompt(task);
    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: turn1Prompt }
    }) + '\n');
    const t1Res = await waitForEvent((e) => e.type === 'result', 240_000, t1Idx);
    turnsCompleted = 1;

    if (t1Res.capped || proxy.getState().capReason) {
      capReason = t1Res.capReason || proxy.getState().capReason;
    } else {
      const permIdx = events.length;
      const permReqId = `perm_${spec.run_id}`;
      child.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: permReqId,
        request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' }
      }) + '\n');
      const permRes = await waitForEvent((e) => e.type === 'control_response' && e.response?.request_id === permReqId, 30_000, permIdx);
      if (permRes.event?.response?.subtype !== 'success') {
        throw new Error(`[${spec.run_id}] set_permission_mode failed`);
      }

      // Turn 2+: Implement + retry loop
      let nextPrompt = isExploration ? TURN2_IMPLEMENT_PROMPT : AB_TURN2_IMPLEMENT_PROMPT;
      for (let turn = 2; turn <= caps.maxHarnessTurns; turn += 1) {
        proxy.beginTurn(turn, {
          runId: spec.run_id,
          arm: spec.arm,
          rep: spec.rep ?? 1,
          taskId: task.task_id,
          difficulty: task.difficulty,
          phase: turn === 2 ? 'implement' : `retry_${turn - 2}`
        });
        const tFrom = events.length;
        child.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: nextPrompt }
        }) + '\n');
        const tRes = await waitForEvent((e) => e.type === 'result', 240_000, tFrom);
        turnsCompleted = turn;
        if (tRes.capped || proxy.getState().capReason) {
          capReason = tRes.capReason || proxy.getState().capReason;
          break;
        }
        const evalRes = evaluateHiddenSuite({ runId: spec.run_id, turn, taskId: task.task_id, repoDir, hiddenDir });
        constraintViolations = evalRes.constraintViolations;
        if (evalRes.passed) {
          completed = true;
          break;
        }
        if (turn === caps.maxHarnessTurns) {
          capReason = `retry_cap:${(evalRes.failingNames || []).join(',')}`;
          break;
        }
        nextPrompt = evalRes.retryPrompt;
      }
    }

    if (!childClosed) {
      child.stdin.end();
      await Promise.race([closePromise, new Promise((r) => setTimeout(r, 3000))]);
    }
  } finally {
    if (!childClosed) {
      try {
        child.kill('SIGKILL');
      } catch (killErr) {
        void killErr;
      }
    }
  }

  const wallTimeS = (Date.now() - runStartMs) / 1000;
  const wireBuf = fs.existsSync(proxy.wireLogPath) ? fs.readFileSync(proxy.wireLogPath) : Buffer.alloc(0);
  const rawWireText = wireBuf.subarray(Math.min(wireLogOffsetBytes, wireBuf.length)).toString('utf8');
  const wireAll = rawWireText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((w) => w.context?.runId === spec.run_id && !w.isSideCall && !w.blockedByGuard && !w.countTokensFallback && (w.statusCode ?? 200) < 400);

  const billedUsd = wireAll.reduce((s, w) => s + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0), 0);
  const billedIn = wireAll.reduce((s, w) => s + Number(w.usage?.input_tokens || 0), 0);
  const billedCreate = wireAll.reduce((s, w) => s + Number(w.usage?.cache_creation_input_tokens || 0), 0);
  const billedRead = wireAll.reduce((s, w) => s + Number(w.usage?.cache_read_input_tokens || 0), 0);
  const highbeamHooks = readHighbeamHookStats(repoDir);
  const billedOut = wireAll.reduce((s, w) => s + Number(w.usage?.output_tokens || 0), 0);
  const byModel = {};
  for (const w of wireAll) {
    const mk = String(w.mappedModel || w.requestedModel || 'unknown');
    if (!byModel[mk]) {
      byModel[mk] = {
        requests: 0,
        billedUsd: 0,
        inputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0
      };
    }
    const bm = byModel[mk];
    bm.requests += 1;
    bm.billedUsd = Number((bm.billedUsd + Number(w.billedCostUsd ?? w.cost?.totalCostUsd ?? 0)).toFixed(6));
    bm.inputTokens += Number(w.usage?.input_tokens || 0);
    bm.cacheCreateTokens += Number(w.usage?.cache_creation_input_tokens || 0);
    bm.cacheReadTokens += Number(w.usage?.cache_read_input_tokens || 0);
    bm.outputTokens += Number(w.usage?.output_tokens || 0);
  }
  const artifacts = persistRunArtifacts({ rawDir, spec, repoDir, cfgDir, homeDir });

  rmDirBestEffort(workRoot, { label: spec.run_id });

  return {
    run_id: spec.run_id,
    arm: spec.arm,
    rep: spec.rep ?? 1,
    task_id: task.task_id,
    difficulty: task.difficulty,
    completed,
    turns: turnsCompleted,
    cap_reason: capReason,
    constraint_violations: constraintViolations,
    wall_time_s: Number(wallTimeS.toFixed(2)),
    highbeamHooks,
    artifacts,
    wireObs: {
      ...wireObs,
      estCumulativeMessagesTok: Math.ceil(wireObs.totalMessagesChars / 4),
      estFinalMessagesTok: Math.ceil(wireObs.finalMessagesChars / 4)
    },
    billing: {
      requests: wireAll.length,
      billedUsd: Number(billedUsd.toFixed(6)),
      inputTokens: billedIn,
      cacheCreateTokens: billedCreate,
      cacheReadTokens: billedRead,
      outputTokens: billedOut,
      byModel
    }
  };
}

async function runDryRunMock() {
  const claudeExe = findClaudeExe();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ab-dry-'));
  const rawDir = path.join(root, 'raw');
  const workBaseDir = path.join(root, 'work');
  const wireLogPath = path.join(rawDir, 'wire.jsonl');
  fs.mkdirSync(rawDir, { recursive: true });

  const wireObsByRun = new Map();
  let reqSeq = 0;

  // Deterministic upstream driving identical workflow: IMP-4D Read -> IMP-1 Bash -> Write -> IMP-4B Read
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
          id: `probe_${reqSeq}`,
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
      const ctxRun = pState.runId || pState.activeContext?.runId || '';
      const messages = parsed.messages || [];
      const trailingUser = [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'assistant') break;
        trailingUser.unshift(messages[i]);
      }
      const trailingBlocks = trailingUser.flatMap((m) =>
        Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content || '') }]
      );
      const trailingText = trailingBlocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const trailingResults = trailingBlocks.filter((b) => b.type === 'tool_result');

      // Map tool_use_id -> last tool_use block across prior messages
      const allToolUses = [];
      for (const m of messages) {
        if (m?.role === 'assistant' && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === 'tool_use') allToolUses.push(b);
          }
        }
      }
      const lastTool = allToolUses[allToolUses.length - 1];
      const lastResult = trailingResults[trailingResults.length - 1];
      const lastResText = extractResultText(lastResult);
      const phase = pState.activeContext?.phase || 'plan';
      if (lastResult?.is_error && wireObsByRun.has(ctxRun) && !lastResText.includes('.agents/cache/indices/')) {
        console.log('[WIRE_ERR]', ctxRun, phase, lastTool?.name, lastResText.slice(0, 160));
      }

      if (ctxRun.startsWith('T09_')) {
        if (/haiku/i.test(String(parsed.model || ''))) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'end_turn',
            isWarm: false,
            cost: 0.0005,
            contentBlocks: [
              {
                type: 'text',
                text: 'Files & Coordinates:\n- src/policies/discountStackingPolicy.mjs:L12-L44\n- src/policies/fxConversionPolicy.mjs:L16-L52\n- src/services/billingOrchestrator.mjs:L12-L60'
              }
            ]
          });
          return;
        }
        const refT09Disc =
          fs.readFileSync(path.join(EXP_REF_DIR, 'T09', 'src', 'policies', 'discountStackingPolicy.mjs'), 'utf8').trimEnd() +
          '\n\n// Standard coupon schedule reference helpers\n' +
          buildExplorationPadLines('discountSchedule', 92) +
          '\n';
        const refT09Fx =
          fs.readFileSync(path.join(EXP_REF_DIR, 'T09', 'src', 'policies', 'fxConversionPolicy.mjs'), 'utf8').trimEnd() +
          '\n\n// Triangulated FX corridor reference helpers\n' +
          buildExplorationPadLines('fxCorridor', 90) +
          '\n';
        const refT09Orch =
          fs.readFileSync(path.join(EXP_REF_DIR, 'T09', 'src', 'services', 'billingOrchestrator.mjs'), 'utf8').trimEnd() +
          '\n\n' +
          buildExplorationPadLines('billingPipeline', 90) +
          '\n';
        if (phase === 'plan') {
          if (trailingResults.length === 0) {
            writeMockSse(res, {
              model: parsed.model,
              msgId: `m_${reqSeq}`,
              stopReason: 'tool_use',
              contentBlocks: [
                {
                  type: 'tool_use',
                  id: `tu_agent_${reqSeq}`,
                  name: 'Agent',
                  input: {
                    subagent_type: 'Explore',
                    description: 'Locate billing policies and FX orchestrator',
                    prompt: 'Search src/ policies, services, and docs/runbooks/ to locate discount stacking, FX conversion, and cross-border invoice code.'
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
            contentBlocks: [{ type: 'text', text: 'Plan: Haiku scout located T09 policy and billing orchestrator modules.' }]
          });
          return;
        }
        if (trailingText.includes('Now implement your plan') && trailingResults.length === 0) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm: true,
            contentBlocks: [{ type: 'tool_use', id: `tu_w1_${reqSeq}`, name: 'Write', input: { file_path: 'src/policies/discountStackingPolicy.mjs', content: refT09Disc } }]
          });
          return;
        }
        if (lastTool?.name === 'Write' && String(lastTool.input?.file_path).endsWith('discountStackingPolicy.mjs')) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm: true,
            contentBlocks: [{ type: 'tool_use', id: `tu_w2_${reqSeq}`, name: 'Write', input: { file_path: 'src/policies/fxConversionPolicy.mjs', content: refT09Fx } }]
          });
          return;
        }
        if (lastTool?.name === 'Write' && String(lastTool.input?.file_path).endsWith('fxConversionPolicy.mjs')) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm: true,
            contentBlocks: [{ type: 'tool_use', id: `tu_w3_${reqSeq}`, name: 'Write', input: { file_path: 'src/services/billingOrchestrator.mjs', content: refT09Orch } }]
          });
          return;
        }
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          contentBlocks: [{ type: 'text', text: 'Implemented and verified T09.' }]
        });
        return;
      }

      const refT01 = fs.readFileSync(path.join(REF_DIR, 'T01', 'src', 'tierEngine.mjs'), 'utf8');
      const fixedFullT01 = `${refT01.trimEnd()}\n\n// Extended diagnostic helpers\n${buildTrailingDocPadLines(185)}\n`;
      if (phase === 'plan') {
        if (trailingResults.length === 0) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            contentBlocks: [{ type: 'tool_use', id: `tu_spec_${reqSeq}`, name: 'Read', input: { file_path: 'docs/ARCHITECTURE_SPEC.md' } }]
          });
          return;
        }
        if (lastTool?.name === 'Read' && String(lastTool.input?.file_path).includes('ARCHITECTURE_SPEC.md') && lastTool.input?.limit === undefined) {
          if (!lastResult?.is_error && trailingText.includes('Highbeam Shield clamped wide unsliced Read')) {
            writeMockSse(res, {
              model: parsed.model,
              msgId: `m_${reqSeq}`,
              stopReason: 'tool_use',
              isWarm: true,
              contentBlocks: [{ type: 'tool_use', id: `tu_slice_${reqSeq}`, name: 'Read', input: { file_path: 'docs/ARCHITECTURE_SPEC.md', offset: 115, limit: 35 } }]
            });
            return;
          }
          const idxMatch = lastResText.match(/(\.agents\/cache\/indices\/[^\s:]+\.index\.md)/);
          if (lastResult?.is_error && idxMatch) {
            writeMockSse(res, {
              model: parsed.model,
              msgId: `m_${reqSeq}`,
              stopReason: 'tool_use',
              isWarm: true,
              contentBlocks: [{ type: 'tool_use', id: `tu_idx_${reqSeq}`, name: 'Read', input: { file_path: idxMatch[1] } }]
            });
            return;
          }
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'end_turn',
            isWarm: true,
            contentBlocks: [{ type: 'text', text: 'Plan: read spec & fix tierEngine.mjs.' }]
          });
          return;
        }
        if (lastTool?.name === 'Read' && String(lastTool.input?.file_path).endsWith('.index.md')) {
          writeMockSse(res, {
            model: parsed.model,
            msgId: `m_${reqSeq}`,
            stopReason: 'tool_use',
            isWarm: true,
            contentBlocks: [{ type: 'tool_use', id: `tu_slice_${reqSeq}`, name: 'Read', input: { file_path: 'docs/ARCHITECTURE_SPEC.md', offset: 115, limit: 35 } }]
          });
          return;
        }
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'end_turn',
          isWarm: true,
          contentBlocks: [{ type: 'text', text: 'Plan: slice read complete; ready to implement tierEngine.mjs.' }]
        });
        return;
      }

      // Implement turn sequence: 1) Bash diag -> 2) Bounded Read src/tierEngine -> 3) Write tierEngine -> 4) Unbounded Verify Read tierEngine -> 5) End
      if (trailingText.includes('Now implement your plan') && trailingResults.length === 0) {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm: true,
          contentBlocks: [{ type: 'tool_use', id: `tu_bash_${reqSeq}`, name: 'Bash', input: { command: 'node scripts/diag_check.mjs' } }]
        });
        return;
      }
      if (lastTool?.name === 'Bash') {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm: true,
          contentBlocks: [{ type: 'tool_use', id: `tu_initread_${reqSeq}`, name: 'Read', input: { file_path: 'src/tierEngine.mjs', offset: 1, limit: 110 } }]
        });
        return;
      }
      if (lastTool?.name === 'Read' && String(lastTool.input?.file_path).endsWith('tierEngine.mjs') && lastTool.input?.limit === 110) {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm: true,
          contentBlocks: [{ type: 'tool_use', id: `tu_write_${reqSeq}`, name: 'Write', input: { file_path: 'src/tierEngine.mjs', content: fixedFullT01 } }]
        });
        return;
      }
      if (lastTool?.name === 'Write') {
        writeMockSse(res, {
          model: parsed.model,
          msgId: `m_${reqSeq}`,
          stopReason: 'tool_use',
          isWarm: true,
          contentBlocks: [{ type: 'tool_use', id: `tu_verify_read_${reqSeq}`, name: 'Read', input: { file_path: 'src/tierEngine.mjs' } }]
        });
        return;
      }
      writeMockSse(res, {
        model: parsed.model,
        msgId: `m_${reqSeq}`,
        stopReason: 'end_turn',
        isWarm: true,
        contentBlocks: [{ type: 'text', text: 'Implemented and verified T01.' }]
      });
    });
  });

  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;
  const caps = resolveCptCaps();
  const proxy = await startCptProxyServer({
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiPrefix: '/api',
    apiKey: 'sk-or-v1-dryrun-ab-00000000',
    wireLogPath,
    pinProvider: true,
    caps,
    onRequestObserve: ({ runId, parsedReq, context }) => {
      const obs = wireObsByRun.get(runId);
      if (obs) observeWireRequest(obs, parsedReq, context);
    }
  });

  try {
    const taskT01 = TASKS.find((t) => t.task_id === 'T01');
    const runs = [];
    for (const arm of AB_ARMS) {
      const spec = { run_id: `T01_${arm}_dry`, arm, rep: 1, task_id: 'T01', difficulty: taskT01.difficulty };
      const r = await executeAbRun({
        spec,
        task: taskT01,
        claudeExe,
        proxy,
        caps,
        workBaseDir,
        rawDir,
        onWireObserve: (runId, obj) => wireObsByRun.set(runId, obj)
      });
      assert.equal(r.completed, true, `${spec.run_id} must pass hidden T01 tests (cap=${r.cap_reason}, turns=${r.turns})`);
      assert.ok(r.wireObs.requests > 0, `${spec.run_id} must capture wireObs.requests > 0`);
      assert.ok(r.wireObs.estCumulativeMessagesTok > 0, `${spec.run_id} must capture estCumulativeMessagesTok > 0`);
      runs.push(r);
    }

    const [base, shieldOff, hb] = runs;
    assert.equal(shieldOff.highbeamHooks.shieldClampsTotal, 0, 'HIGHBEAM_SHIELD_OFF must have 0 Shield clamps');
    assert.equal(shieldOff.highbeamHooks.shieldBlocksTotal, 0, 'HIGHBEAM_SHIELD_OFF must have 0 Shield blocks');
    assert.ok(
      shieldOff.wireObs.bashDiagResultChars < base.wireObs.bashDiagResultChars,
      'HIGHBEAM_SHIELD_OFF must still compress Bash diagnostic output via PostToolUse'
    );
    assert.ok(
      hb.highbeamHooks.shieldClampsTotal >= 1 || hb.highbeamHooks.shieldBlocksTotal >= 1,
      'HIGHBEAM must trigger at least one Shield clamp or block on unsliced T01 read'
    );
    assert.ok(
      hb.wireObs.specReadResultChars < base.wireObs.specReadResultChars,
      'HIGHBEAM must reduce specReadResultChars relative to BASELINE'
    );
    assert.ok(fs.existsSync(wireLogPath), 'wireLogPath must exist on disk');
    assert.ok(
      hb.artifacts?.transcriptPath && fs.existsSync(path.join(rawDir, hb.artifacts.transcriptPath)),
      'Persisted redacted transcript must exist for HIGHBEAM dry run'
    );
    assert.ok(
      hb.artifacts?.ledgerPath && fs.existsSync(path.join(rawDir, hb.artifacts.ledgerPath)),
      'Persisted ledger JSONL must exist for HIGHBEAM dry run'
    );

    const savedTotalTok = base.wireObs.estCumulativeMessagesTok - hb.wireObs.estCumulativeMessagesTok;
    const pctSaved = base.wireObs.estCumulativeMessagesTok > 0
      ? Number(((savedTotalTok / base.wireObs.estCumulativeMessagesTok) * 100).toFixed(1))
      : 0;

    // Verify HIGHBEAM_SCOUT on exploration task T09: real claude.exe accepts --agents & re-tiers Explore -> haiku in COACH
    const taskT09 = EXPLORATION_TASKS.find((t) => t.task_id === 'T09');
    const scoutRun = await executeAbRun({
      spec: {
        run_id: 'T09_HIGHBEAM_SCOUT_dry',
        arm: 'HIGHBEAM_SCOUT',
        rep: 1,
        task_id: 'T09',
        difficulty: taskT09.difficulty
      },
      task: taskT09,
      claudeExe,
      proxy,
      caps,
      workBaseDir,
      rawDir,
      onWireObserve: (runId, obj) => wireObsByRun.set(runId, obj)
    });
    assert.equal(
      scoutRun.completed,
      true,
      `T09_HIGHBEAM_SCOUT_dry must pass hidden T09 tests (cap=${scoutRun.cap_reason}, turns=${scoutRun.turns})`
    );
    assert.ok(
      scoutRun.wireObs.haikuRequests >= 1,
      `T09_HIGHBEAM_SCOUT_dry must route child read-only scout to haiku on the wire (seen=${JSON.stringify(scoutRun.wireObs.modelsSeen)})`
    );
    assert.ok(
      Number(scoutRun.billing?.byModel?.['anthropic/claude-haiku-5.5']?.requests || 0) >= 1,
      `T09_HIGHBEAM_SCOUT_dry must record anthropic/claude-haiku-5.5 billing breakdown (${JSON.stringify(scoutRun.billing?.byModel)})`
    );

    console.log('TEST_B_DRY_RUN_AB_PASS');
    console.log(JSON.stringify({
      baseline: base,
      highbeamShieldOff: shieldOff,
      highbeam: hb,
      highbeamScout: scoutRun,
      delta: {
        estCumulativeMessagesTokSaved: savedTotalTok,
        estCumulativeMessagesPctSaved: pctSaved,
        specReadCharsDelta: base.wireObs.specReadResultChars - hb.wireObs.specReadResultChars,
        bashDiagCharsDelta: base.wireObs.bashDiagResultChars - hb.wireObs.bashDiagResultChars,
        bashDiagCharsDeltaShieldOff: base.wireObs.bashDiagResultChars - shieldOff.wireObs.bashDiagResultChars,
        postEditReadCharsDelta: base.wireObs.postEditReadResultChars - hb.wireObs.postEditReadResultChars
      }
    }, null, 2));
  } finally {
    await proxy.close();
    mockUpstream.close();
    rmDirBestEffort(root, { label: 'dry_run_root' });
  }
}

export function summarizeAbArm(list = []) {
  const count = list.length;
  const completedCount = list.filter((r) => r.completed).length;
  const billedUsd = list.reduce((s, r) => s + Number(r.billing?.billedUsd || 0), 0);
  const inputTokens = list.reduce((s, r) => s + Number(r.billing?.inputTokens || 0), 0);
  const cacheCreateTokens = list.reduce((s, r) => s + Number(r.billing?.cacheCreateTokens || 0), 0);
  const cacheReadTokens = list.reduce((s, r) => s + Number(r.billing?.cacheReadTokens || 0), 0);
  const outputTokens = list.reduce((s, r) => s + Number(r.billing?.outputTokens || 0), 0);
  const requests = list.reduce((s, r) => s + Number(r.billing?.requests || 0), 0);
  const turns = list.reduce((s, r) => s + Number(r.turns || 0), 0);
  const wallTimeS = list.reduce((s, r) => s + Number(r.wall_time_s || 0), 0);
  const ledgerSavedTokens = list.reduce((s, r) => s + Number(r.highbeamHooks?.ledgerSavedTokens || 0), 0);
  const ledgerAvoidedWriteTokens = list.reduce(
    (s, r) => s + Number(r.highbeamHooks?.ledgerBuckets?.avoidedWriteTokens ?? r.highbeamHooks?.ledgerSavedTokens ?? 0),
    0
  );
  const ledgerAvoidedWriteUsd = list.reduce(
    (s, r) => s + Number(r.highbeamHooks?.ledgerBuckets?.avoidedWriteUsd || 0),
    0
  );
  const totalReceipts = list.reduce((s, r) => s + Number(r.highbeamHooks?.totalReceipts || 0), 0);
  const shieldBlocksByteCap = list.reduce((s, r) => s + Number(r.highbeamHooks?.shieldBlocksByteCap || 0), 0);
  const shieldClampsByteCap = list.reduce((s, r) => s + Number(r.highbeamHooks?.shieldClampsByteCap || 0), 0);
  const shieldClampsExplicitSlice = list.reduce(
    (s, r) => s + Number(r.highbeamHooks?.shieldClampsExplicitSlice || 0),
    0
  );
  const shieldClampsTotal = list.reduce(
    (s, r) =>
      s +
      Number(
        r.highbeamHooks?.shieldClampsTotal ??
          (Number(r.highbeamHooks?.shieldClampsByteCap || 0) +
            Number(r.highbeamHooks?.shieldClampsExplicitSlice || 0))
      ),
    0
  );
  const shieldBlocksLineCap = list.reduce((s, r) => s + Number(r.highbeamHooks?.shieldBlocksLineCap || 0), 0);
  const shieldBlocksOversizedSlice = list.reduce(
    (s, r) => s + Number(r.highbeamHooks?.shieldBlocksOversizedSlice || 0),
    0
  );
  const shieldBlocksTotal = list.reduce(
    (s, r) =>
      s +
      Number(
        r.highbeamHooks?.shieldBlocksTotal ??
          (Number(r.highbeamHooks?.shieldBlocksByteCap || 0) +
            Number(r.highbeamHooks?.shieldBlocksLineCap || 0) +
            Number(r.highbeamHooks?.shieldBlocksOversizedSlice || 0))
      ),
    0
  );
  const wireObsRequests = list.reduce((s, r) => s + Number(r.wireObs?.requests || 0), 0);
  const wireObsHaikuRequests = list.reduce((s, r) => s + Number(r.wireObs?.haikuRequests || 0), 0);
  const wireObsSonnetRequests = list.reduce((s, r) => s + Number(r.wireObs?.sonnetRequests || 0), 0);
  const wireObsSubagentSpawns = list.reduce(
    (s, r) => s + (Array.isArray(r.wireObs?.subagentSpawns) ? r.wireObs.subagentSpawns.length : 0),
    0
  );
  const wireObsEstCumulativeMessagesTok = list.reduce(
    (s, r) => s + Number(r.wireObs?.estCumulativeMessagesTok || 0),
    0
  );
  const wireObsTotalToolResultChars = list.reduce(
    (s, r) => s + Number(r.wireObs?.totalToolResultChars || 0),
    0
  );
  const byModel = {};
  for (const r of list) {
    for (const [mk, bm] of Object.entries(r.billing?.byModel || {})) {
      if (!byModel[mk]) {
        byModel[mk] = {
          requests: 0,
          billedUsd: 0,
          inputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0
        };
      }
      byModel[mk].requests += Number(bm.requests || 0);
      byModel[mk].billedUsd = Number((byModel[mk].billedUsd + Number(bm.billedUsd || 0)).toFixed(6));
      byModel[mk].inputTokens += Number(bm.inputTokens || 0);
      byModel[mk].cacheCreateTokens += Number(bm.cacheCreateTokens || 0);
      byModel[mk].cacheReadTokens += Number(bm.cacheReadTokens || 0);
      byModel[mk].outputTokens += Number(bm.outputTokens || 0);
    }
  }

  return {
    runs: count,
    completed: completedCount,
    completionPct: count > 0 ? Number(((100 * completedCount) / count).toFixed(1)) : 0,
    totalBilledUsd: Number(billedUsd.toFixed(6)),
    meanBilledUsdPerRun: count > 0 ? Number((billedUsd / count).toFixed(6)) : 0,
    costPerCompletedTaskUsd: completedCount > 0 ? Number((billedUsd / completedCount).toFixed(6)) : null,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens,
    totalPromptBillTokens: inputTokens + cacheCreateTokens + cacheReadTokens,
    requests,
    turns,
    wallTimeS: Number(wallTimeS.toFixed(2)),
    byModel,
    wireObs: {
      requests: wireObsRequests,
      haikuRequests: wireObsHaikuRequests,
      sonnetRequests: wireObsSonnetRequests,
      subagentSpawns: wireObsSubagentSpawns,
      estCumulativeMessagesTok: wireObsEstCumulativeMessagesTok,
      totalToolResultChars: wireObsTotalToolResultChars
    },
    highbeamHooks: {
      totalReceipts,
      ledgerSavedTokens,
      ledgerAvoidedWriteTokens,
      ledgerAvoidedWriteUsd: Number(ledgerAvoidedWriteUsd.toFixed(6)),
      shieldBlocksByteCap,
      shieldClampsByteCap,
      shieldClampsExplicitSlice,
      shieldClampsTotal,
      shieldBlocksLineCap,
      shieldBlocksOversizedSlice,
      shieldBlocksTotal
    }
  };
}

async function runLiveAb({
  taskIds = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'],
  arms = AB_ARMS,
  reps = 1,
  maxStageSpendUsd = 5,
  resume = false
}) {
  const apiKey = loadOpenRouterApiKey();
  if (!apiKey) throw new Error('OpenRouter API key not loaded');
  const claudeExe = findClaudeExe();
  const keyBefore = await httpsGetKeyUsage(apiKey);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const rawDir = path.join(RESULTS_DIR, 'highbeam_ab_raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const checkpointPath = path.join(RESULTS_DIR, 'highbeam_ab_checkpoint.jsonl');
  const wireLogPath = path.join(rawDir, 'proxy_wire_log.jsonl');

  const priorById = new Map();
  if (resume && fs.existsSync(checkpointPath)) {
    for (const line of fs.readFileSync(checkpointPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec?.run_id) priorById.set(rec.run_id, rec);
      } catch (err) {
        void err;
      }
    }
    const pruned = pruneOrphanWireLog(wireLogPath, new Set(priorById.keys()));
    if (pruned.pruned > 0) {
      console.log(`[AB resume] Pruned ${pruned.pruned} orphan wire log rows not in checkpoint`);
    }
  } else if (!resume) {
    if (fs.existsSync(checkpointPath)) fs.writeFileSync(checkpointPath, '', 'utf8');
    if (fs.existsSync(wireLogPath)) fs.writeFileSync(wireLogPath, '', 'utf8');
  }

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ab-live-'));
  const workBaseDir = path.join(runRoot, 'work');
  const hasExplorationTasks = taskIds.some((id) => EXPLORATION_TASKS.some((t) => t.task_id === id));
  const caps = {
    ...resolveCptCaps({
      maxRequestsPerRun: hasExplorationTasks ? 140 : 100,
      maxRequestsPerTurn: hasExplorationTasks ? 50 : 30
    }),
    maxRunCostUsd: hasExplorationTasks ? 2.0 : 1.50
  };
  const wireObsByRun = new Map();
  const proxy = await startCptProxyServer({
    port: 0,
    upstreamBaseUrl: 'https://openrouter.ai',
    upstreamApiPrefix: '/api',
    apiKey,
    wireLogPath,
    pinProvider: true,
    caps,
    onRequestObserve: ({ runId, parsedReq, context }) => {
      const obs = wireObsByRun.get(runId);
      if (obs) observeWireRequest(obs, parsedReq, context);
    }
  });

  const activeArms = arms.length > 0 ? arms : AB_ARMS;
  const repCount = Math.max(1, Math.round(Number(reps) || 1));
  const schedule = [];
  for (let rep = 1; rep <= repCount; rep += 1) {
    for (let i = 0; i < taskIds.length; i += 1) {
      const taskId = taskIds[i];
      const task = ALL_TASKS.find((t) => t.task_id === taskId);
      if (!task) throw new Error(`Unknown task_id: ${taskId}`);
      const shift = (i + rep - 1) % activeArms.length;
      const orderedArms = [...activeArms.slice(shift), ...activeArms.slice(0, shift)];
      for (const arm of orderedArms) {
        const run_id = repCount === 1 ? `${taskId}_${arm}_live` : `${taskId}_${arm}_r${rep}_live`;
        schedule.push({ run_id, arm, rep, task_id: taskId, difficulty: task.difficulty, task });
      }
    }
  }

  const results = [];
  let spendSoFar = 0;
  for (const r of priorById.values()) {
    spendSoFar += Number(r.billing?.billedUsd || 0);
  }

  try {
    for (let idx = 0; idx < schedule.length; idx += 1) {
      const item = schedule[idx];
      if (priorById.has(item.run_id)) {
        results.push(priorById.get(item.run_id));
        console.log(`[AB ${idx + 1}/${schedule.length}] Resumed cached ${item.run_id}`);
        continue;
      }
      if (spendSoFar >= maxStageSpendUsd) {
        console.log(`[AB ${idx + 1}/${schedule.length}] Spend cap $${maxStageSpendUsd.toFixed(2)} reached ($${spendSoFar.toFixed(4)}). Stopping cleanly.`);
        break;
      }
      const res = await executeAbRun({
        spec: item,
        task: item.task,
        claudeExe,
        proxy,
        caps,
        workBaseDir,
        rawDir,
        onWireObserve: (id, obj) => wireObsByRun.set(id, obj)
      });
      fs.appendFileSync(checkpointPath, JSON.stringify(res) + '\n', 'utf8');
      spendSoFar += Number(res.billing?.billedUsd || 0);
      results.push(res);
      console.log(
        `[AB ${idx + 1}/${schedule.length}] ${res.run_id} | ok=${res.completed} | turns=${res.turns} | reqs=${res.billing.requests} | wire=${res.wireObs.requests} | billed=$${res.billing.billedUsd.toFixed(4)} | clamps=${res.highbeamHooks.shieldClampsTotal} | hooks=${res.highbeamHooks.totalReceipts}(saved=${res.highbeamHooks.ledgerSavedTokens}tok) | cum=$${spendSoFar.toFixed(4)}`
      );
    }
  } finally {
    await proxy.close();
    rmDirBestEffort(runRoot, { label: 'live_run_root' });
  }

  await new Promise((r) => setTimeout(r, 15_000));
  const keyAfter = await httpsGetKeyUsage(apiKey);

  const baseRuns = results.filter((r) => r.arm === 'BASELINE');
  const shieldOffRuns = results.filter((r) => r.arm === 'HIGHBEAM_SHIELD_OFF');
  const hbRuns = results.filter((r) => r.arm === 'HIGHBEAM');
  const scoutRuns = results.filter((r) => r.arm === 'HIGHBEAM_SCOUT');
  const baseSum = summarizeAbArm(baseRuns);
  const shieldOffSum = shieldOffRuns.length > 0 ? summarizeAbArm(shieldOffRuns) : null;
  const hbSum = summarizeAbArm(hbRuns);
  const scoutSum = scoutRuns.length > 0 ? summarizeAbArm(scoutRuns) : null;
  const costDeltaUsd = Number((hbSum.totalBilledUsd - baseSum.totalBilledUsd).toFixed(6));
  const costDeltaPct = baseSum.totalBilledUsd > 0
    ? Number((((hbSum.totalBilledUsd - baseSum.totalBilledUsd) / baseSum.totalBilledUsd) * 100).toFixed(2))
    : 0;
  const shieldOffVsBaseline = shieldOffSum
    ? {
        costDeltaUsd: Number((shieldOffSum.totalBilledUsd - baseSum.totalBilledUsd).toFixed(6)),
        costDeltaPct:
          baseSum.totalBilledUsd > 0
            ? Number((((shieldOffSum.totalBilledUsd - baseSum.totalBilledUsd) / baseSum.totalBilledUsd) * 100).toFixed(2))
            : 0,
        requestsDelta: shieldOffSum.requests - baseSum.requests
      }
    : null;
  const highbeamVsShieldOff = shieldOffSum
    ? {
        costDeltaUsd: Number((hbSum.totalBilledUsd - shieldOffSum.totalBilledUsd).toFixed(6)),
        costDeltaPct:
          shieldOffSum.totalBilledUsd > 0
            ? Number((((hbSum.totalBilledUsd - shieldOffSum.totalBilledUsd) / shieldOffSum.totalBilledUsd) * 100).toFixed(2))
            : 0,
        requestsDelta: hbSum.requests - shieldOffSum.requests
      }
    : null;
  const highbeamScoutVsBaseline = scoutSum
    ? {
        costDeltaUsd: Number((scoutSum.totalBilledUsd - baseSum.totalBilledUsd).toFixed(6)),
        costDeltaPct:
          baseSum.totalBilledUsd > 0
            ? Number((((scoutSum.totalBilledUsd - baseSum.totalBilledUsd) / baseSum.totalBilledUsd) * 100).toFixed(2))
            : 0,
        requestsDelta: scoutSum.requests - baseSum.requests
      }
    : null;
  const highbeamScoutVsHighbeam = scoutSum && hbRuns.length > 0
    ? {
        costDeltaUsd: Number((scoutSum.totalBilledUsd - hbSum.totalBilledUsd).toFixed(6)),
        costDeltaPct:
          hbSum.totalBilledUsd > 0
            ? Number((((scoutSum.totalBilledUsd - hbSum.totalBilledUsd) / hbSum.totalBilledUsd) * 100).toFixed(2))
            : 0,
        requestsDelta: scoutSum.requests - hbSum.requests
      }
    : null;
  const exPostLedgerReconciliation = {
    highbeamVsBaseline: computeExPostRealizedSavings({
      baselinePromptBillTokens: baseSum.totalPromptBillTokens,
      actualPromptBillTokens: hbSum.totalPromptBillTokens,
      baselineCostUSD: baseSum.totalBilledUsd,
      actualCostUSD: hbSum.totalBilledUsd,
      avoidedWriteTokens: hbSum.highbeamHooks.ledgerAvoidedWriteTokens
    }),
    ...(shieldOffSum
      ? {
          shieldOffVsBaseline: computeExPostRealizedSavings({
            baselinePromptBillTokens: baseSum.totalPromptBillTokens,
            actualPromptBillTokens: shieldOffSum.totalPromptBillTokens,
            baselineCostUSD: baseSum.totalBilledUsd,
            actualCostUSD: shieldOffSum.totalBilledUsd,
            avoidedWriteTokens: shieldOffSum.highbeamHooks.ledgerAvoidedWriteTokens
          })
        }
      : {}),
    ...(scoutSum
      ? {
          highbeamScoutVsBaseline: computeExPostRealizedSavings({
            baselinePromptBillTokens: baseSum.totalPromptBillTokens,
            actualPromptBillTokens: scoutSum.totalPromptBillTokens,
            baselineCostUSD: baseSum.totalBilledUsd,
            actualCostUSD: scoutSum.totalBilledUsd,
            avoidedWriteTokens: scoutSum.highbeamHooks.ledgerAvoidedWriteTokens
          })
        }
      : {})
  };

  const byTask = taskIds.map((tid) => {
    const bList = baseRuns.filter((r) => r.task_id === tid);
    const sList = shieldOffRuns.filter((r) => r.task_id === tid);
    const hList = hbRuns.filter((r) => r.task_id === tid);
    const scList = scoutRuns.filter((r) => r.task_id === tid);
    const meanUsd = (arr) =>
      arr.length > 0 ? Number((arr.reduce((s, r) => s + Number(r.billing?.billedUsd || 0), 0) / arr.length).toFixed(6)) : null;
    const bUsd = meanUsd(bList);
    const sUsd = meanUsd(sList);
    const hUsd = meanUsd(hList);
    const scUsd = meanUsd(scList);
    return {
      task_id: tid,
      reps: Math.max(bList.length, sList.length, hList.length, scList.length),
      baselineUsd: bUsd,
      shieldOffUsd: sUsd,
      highbeamUsd: hUsd,
      ...(scList.length > 0 ? { highbeamScoutUsd: scUsd } : {}),
      deltaUsd: bUsd !== null && hUsd !== null ? Number((hUsd - bUsd).toFixed(6)) : null,
      shieldOffDeltaUsd: bUsd !== null && sUsd !== null ? Number((sUsd - bUsd).toFixed(6)) : null,
      ...(scList.length > 0 ? { scoutDeltaUsd: bUsd !== null && scUsd !== null ? Number((scUsd - bUsd).toFixed(6)) : null } : {}),
      baselineOk: bList.length > 0 ? bList.every((r) => r.completed) : null,
      shieldOffOk: sList.length > 0 ? sList.every((r) => r.completed) : null,
      highbeamOk: hList.length > 0 ? hList.every((r) => r.completed) : null,
      ...(scList.length > 0 ? { highbeamScoutOk: scList.every((r) => r.completed) } : {}),
      shieldOffHooks: sList[sList.length - 1]?.highbeamHooks ?? null,
      highbeamHooks: hList[hList.length - 1]?.highbeamHooks ?? null,
      ...(scList.length > 0 ? { highbeamScoutHooks: scList[scList.length - 1]?.highbeamHooks ?? null } : {})
    };
  });

  const report = {
    recordedAtUtc: new Date().toISOString(),
    model: mapCliModelToOpenRouter(SONNET_CLI),
    arms: activeArms,
    reps: repCount,
    rawArtifactsDir: path.relative(REPO_ROOT, rawDir).replace(/\\/g, '/'),
    keyDeltaUsd: Number(((keyAfter.usage ?? 0) - (keyBefore.usage ?? 0)).toFixed(6)),
    summedRunUsd: Number(spendSoFar.toFixed(6)),
    summary: {
      baseline: baseSum,
      ...(shieldOffSum ? { highbeamShieldOff: shieldOffSum } : {}),
      highbeam: hbSum,
      ...(scoutSum ? { highbeamScout: scoutSum } : {}),
      costDeltaUsd,
      costDeltaPct,
      ...(shieldOffVsBaseline ? { shieldOffVsBaseline } : {}),
      ...(highbeamVsShieldOff ? { highbeamVsShieldOff } : {}),
      ...(highbeamScoutVsBaseline ? { highbeamScoutVsBaseline } : {}),
      ...(highbeamScoutVsHighbeam ? { highbeamScoutVsHighbeam } : {}),
      exPostLedgerReconciliation
    },
    byTask,
    results
  };
  const jsonOut = path.join(RESULTS_DIR, 'highbeam_ab_results.json');
  fs.writeFileSync(jsonOut, redactSensitiveText(JSON.stringify(report, null, 2)) + '\n', 'utf8');
  console.log('TEST_B_LIVE_AB_COMPLETE:', jsonOut);
  console.log('SUMMARY:', JSON.stringify(report.summary, null, 2));
}

export function parseArgs(argv = []) {
  const out = {
    dryRunMock: false,
    confirmLiveSpend: false,
    resume: false,
    suite: 'default',
    tasks: ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'],
    arms: [...AB_ARMS],
    reps: 1,
    maxStageSpendUsd: 5
  };
  let explicitTasks = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run-mock') out.dryRunMock = true;
    else if (a === '--confirm-live-spend') out.confirmLiveSpend = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--suite' && argv[i + 1]) {
      const s = String(argv[++i]).trim().toLowerCase();
      out.suite = s;
      if (s === 'exploration' && !explicitTasks) {
        out.tasks = EXPLORATION_TASKS.map((t) => t.task_id);
      }
    } else if (a === '--tasks' && argv[i + 1]) {
      explicitTasks = true;
      out.tasks = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--arms' && argv[i + 1]) {
      const allowedArms = [...AB_ARMS, 'HIGHBEAM_AUTO', 'HIGHBEAM_SCOUT'];
      const parsed = String(argv[++i])
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => allowedArms.includes(s));
      if (parsed.length > 0) out.arms = parsed;
    } else if (a === '--reps' && argv[i + 1]) {
      out.reps = Math.max(1, Math.round(Number(argv[++i]) || 1));
    } else if (a === '--max-stage-spend' && argv[i + 1]) out.maxStageSpendUsd = Number(argv[++i]) || 5;
  }
  return out;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.dryRunMock) {
    runDryRunMock().catch((err) => {
      console.error('TEST_B_DRY_RUN_FAIL:', err);
      process.exit(1);
    });
  } else if (flags.confirmLiveSpend) {
    runLiveAb({
      taskIds: flags.tasks,
      arms: flags.arms,
      reps: flags.reps,
      maxStageSpendUsd: flags.maxStageSpendUsd,
      resume: flags.resume
    }).catch((err) => {
      console.error('TEST_B_LIVE_FAIL:', err);
      process.exit(1);
    });
  } else {
    console.log('Usage: node run_highbeam_ab.mjs [--dry-run-mock | --confirm-live-spend [--tasks T01..T08] [--arms BASELINE,HIGHBEAM_SHIELD_OFF,HIGHBEAM] [--reps 1] [--max-stage-spend 5] [--resume]]');
  }
}
