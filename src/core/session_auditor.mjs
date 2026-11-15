/**
 * @file src/core/session_auditor.mjs
 * Zero-Write Cross-Platform Historical Session Auditor (`ctxtop audit`).
 *
 * Scans local Antigravity (`transcript_full.jsonl` / `transcript.jsonl`) and Claude Code
 * (`~/.claude/projects/**\/*.jsonl`, deduplicating streaming chunks by `message.id`) transcripts
 * alongside `.agents/telemetry/*.hints.jsonl` and `.claude/cache/horizon_ledger.jsonl`.
 *
 * Guardrails:
 * - Strictly read-only: zero workspace mutations, zero network calls, zero OAuth file reads.
 * - Strictly excludes `packages/airlock/` and sister SKU paths.
 * - Framed strictly around Session ROI & Quota Shield (`Sludge Tax`, `Cold-Cache Spikes`,
 *   `Thrash Loops`, `Oversized Reads`, `Top 3 Offending Turns`) — never developer grades.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeModelKey, resolveModelRates, resolveModelCeiling } from './constants.mjs';
import { isForbiddenSkuPath } from './doc_indexer.mjs';
import { getSavedQuotaReceiptSummary } from '../core-isomorphic/coach/savedQuotaLedger.mjs';

export const COLD_CACHE_IDLE_GAP_MS = 300_000; // 5m TTL
export const OVERSIZED_READ_CHARS_THRESHOLD = 48_000; // ~1,200 lines / ~12k tokens
export const OVERSIZED_TOOL_OUTPUT_CHARS_THRESHOLD = 16_000; // ~4k tokens

function resolveHome(options = {}) {
  return (
    options.homeDir ||
    process.env.USERPROFILE ||
    process.env.HOME ||
    os.homedir()
  );
}

function parseIsoOrNumMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts.trim()) {
    const parsed = Date.parse(ts.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function listClaudeJsonlFiles(claudeRoot, cutoffMs) {
  const results = [];
  if (!claudeRoot || !fs.existsSync(claudeRoot)) return results;
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'airlock') continue;
      const full = path.join(dir, ent.name);
      if (isForbiddenSkuPath(full)) continue;
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoffMs) {
            results.push({ path: full, mtimeMs: st.mtimeMs, sessionId: path.basename(ent.name, '.jsonl') });
          }
        } catch {
          // Ignore unreadable file
        }
      }
    }
  };
  walk(claudeRoot, 0);
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listAntigravityTranscriptFiles(brainDirs, cutoffMs) {
  const results = [];
  const seen = new Set();
  for (const brainRoot of brainDirs) {
    if (!brainRoot || !fs.existsSync(brainRoot)) continue;
    let convDirs = [];
    try {
      convDirs = fs.readdirSync(brainRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of convDirs) {
      const convDir = path.join(brainRoot, d.name);
      if (seen.has(convDir) || isForbiddenSkuPath(convDir)) continue;
      seen.add(convDir);
      const logsDir = path.join(convDir, '.system_generated', 'logs');
      const fullLog = path.join(logsDir, 'transcript_full.jsonl');
      const compactLog = path.join(logsDir, 'transcript.jsonl');
      const chosen = fs.existsSync(fullLog) ? fullLog : fs.existsSync(compactLog) ? compactLog : null;
      if (!chosen) continue;
      try {
        const st = fs.statSync(chosen);
        if (st.mtimeMs >= cutoffMs) {
          results.push({
            path: chosen,
            mtimeMs: st.mtimeMs,
            sessionId: d.name
          });
        }
      } catch {
        // Ignore unreadable transcript
      }
    }
  }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function estimateSludgeCostUSD(modelId, wastedTokens, tsMs, isColdCacheWrite = false) {
  const tok = Math.max(0, Number(wastedTokens) || 0);
  if (tok === 0) return 0;
  const rates = resolveModelRates(modelId || 'claude-sonnet-4-6', tsMs || Date.now(), 'standard', {
    totalPromptTokens: tok
  });
  if (isColdCacheWrite) {
    const writeDiff = Math.max(
      0.25,
      Number(rates.write5mPer1M || 3.75) - Number(rates.cachedReadPer1M || 0.3)
    );
    return Number(((tok / 1_000_000) * writeDiff).toFixed(4));
  }
  return Number(((tok / 1_000_000) * Number(rates.inputPer1M || 3.0)).toFixed(4));
}

/**
 * Audits a single Claude Code `.jsonl` session transcript, deduplicating streaming
 * assistant chunks by `message.id`.
 *
 * @param {{ path: string, sessionId: string, mtimeMs: number }} item
 */
export function scoreClaudeTranscriptFile(item) {
  const lines = fs.readFileSync(item.path, 'utf8').split(/\r?\n/).filter(Boolean);
  const assistantByMsgId = new Map();
  const orderedEvents = [];
  let fallbackIdx = 0;

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const tsMs = parseIsoOrNumMs(row.timestamp || row.created_at || row.createdAt);

    if (row.type === 'assistant' || row.message?.role === 'assistant') {
      const msg = row.message || row;
      const msgId = String(msg.id || row.uuid || `anon_${++fallbackIdx}`);
      const usage = msg.usage || row.usage || {};
      const outTok = Math.max(0, Number(usage.output_tokens || 0));
      const inTok = Math.max(0, Number(usage.input_tokens || 0));
      const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens || 0));
      const cacheWrite = Math.max(
        0,
        Number(
          usage.cache_creation_input_tokens ||
            (Number(usage.cache_creation?.ephemeral_5m_input_tokens || 0) +
              Number(usage.cache_creation?.ephemeral_1h_input_tokens || 0)) ||
            0
        )
      );
      const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
      const prior = assistantByMsgId.get(msgId);
      if (!prior) {
        const entry = {
          kind: 'assistant',
          msgId,
          tsMs,
          modelId: normalizeModelKey(msg.model || row.model || 'claude-sonnet-4-6') || 'claude-sonnet-4-6',
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          toolUses: contentBlocks.filter((b) => b && b.type === 'tool_use')
        };
        assistantByMsgId.set(msgId, entry);
        orderedEvents.push(entry);
      } else {
        prior.inputTokens = Math.max(prior.inputTokens, inTok);
        prior.outputTokens = Math.max(prior.outputTokens, outTok);
        prior.cacheReadTokens = Math.max(prior.cacheReadTokens, cacheRead);
        prior.cacheWriteTokens = Math.max(prior.cacheWriteTokens, cacheWrite);
        if (tsMs > prior.tsMs) prior.tsMs = tsMs;
        const moreTools = contentBlocks.filter((b) => b && b.type === 'tool_use');
        if (moreTools.length > prior.toolUses.length) {
          prior.toolUses = moreTools;
        }
      }
    } else if (row.type === 'user' || row.message?.role === 'user') {
      const content = row.message?.content ?? row.content;
      const toolResults = Array.isArray(content)
        ? content.filter((b) => b && b.type === 'tool_result')
        : [];
      orderedEvents.push({
        kind: 'user',
        tsMs,
        toolResults
      });
    }
  }

  let turnIndex = 0;
  let lastAssistantTsMs = 0;
  let consecutiveToolErrors = 0;
  let thrashLoops = 0;
  let coldCacheSpikes = 0;
  let oversizedReads = 0;
  let oversizedOutputs = 0;
  let sludgeTaxTokens = 0;
  let sludgeTaxUSD = 0;
  let totalPromptTokens = 0;
  let activeModelId = 'claude-sonnet-4-6';
  const toolUseById = new Map();
  const offendingTurns = [];

  for (const ev of orderedEvents) {
    if (ev.kind === 'assistant') {
      turnIndex += 1;
      activeModelId = ev.modelId || activeModelId;
      totalPromptTokens += ev.inputTokens + ev.cacheReadTokens + ev.cacheWriteTokens;

      for (const tu of ev.toolUses) {
        if (tu?.id) toolUseById.set(tu.id, { name: tu.name, input: tu.input || {}, turnIndex });
      }

      // Detect >5m idle Cold-Cache Resume Spike
      if (
        lastAssistantTsMs > 0 &&
        ev.tsMs > 0 &&
        ev.tsMs - lastAssistantTsMs > COLD_CACHE_IDLE_GAP_MS &&
        ev.cacheWriteTokens >= 10_000
      ) {
        coldCacheSpikes += 1;
        const usd = estimateSludgeCostUSD(activeModelId, ev.cacheWriteTokens, ev.tsMs, true);
        sludgeTaxTokens += ev.cacheWriteTokens;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'claude',
          turnIndex,
          modelId: activeModelId,
          category: 'COLD_CACHE_SPIKE',
          wastedTokens: ev.cacheWriteTokens,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${turnIndex} (${Math.round((ev.tsMs - lastAssistantTsMs) / 60000)}m idle gap rebuilt ${ev.cacheWriteTokens.toLocaleString('en-US')} prefix tok)`,
          fix: 'Finish tool batch before 5m TTL expiry or compact before resuming cold threads.'
        });
      }
      if (ev.tsMs > 0) lastAssistantTsMs = ev.tsMs;
    } else if (ev.kind === 'user') {
      for (const tr of ev.toolResults) {
        const linked = tr.tool_use_id ? toolUseById.get(tr.tool_use_id) : null;
        const toolName = String(linked?.name || tr.tool_name || '');
        const toolInput = linked?.input || {};
        const tIdx = linked?.turnIndex || Math.max(1, turnIndex);
        const text =
          typeof tr.content === 'string'
            ? tr.content
            : Array.isArray(tr.content)
              ? tr.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
              : '';

        const isError = Boolean(tr.is_error);
        if (isError) {
          consecutiveToolErrors += 1;
          if (consecutiveToolErrors === 3) {
            thrashLoops += 1;
            const thrashTok = 6_000;
            const usd = estimateSludgeCostUSD(activeModelId, thrashTok, ev.tsMs, false);
            sludgeTaxTokens += thrashTok;
            sludgeTaxUSD += usd;
            offendingTurns.push({
              sessionId: item.sessionId,
              platform: 'claude',
              turnIndex: tIdx,
              modelId: activeModelId,
              category: 'THRASH_3X_LOOP',
              wastedTokens: thrashTok,
              wastedUSD: usd,
              citation: `${item.sessionId}#T${tIdx} (3 consecutive failed ${toolName || 'tool'} calls)`,
              fix: 'Enable Active Shield (`ctxtop shield --enable`) to halt 3x failure loops and inspect error lines first.'
            });
          }
        } else {
          consecutiveToolErrors = 0;
        }

        const isRead = /^Read$/i.test(toolName);
        const hasSlice = toolInput.offset !== undefined || toolInput.limit !== undefined || toolInput.pages !== undefined;
        if (isRead && !hasSlice && text.length >= OVERSIZED_READ_CHARS_THRESHOLD) {
          oversizedReads += 1;
          const estTok = Math.max(0, Math.ceil(text.length / 4) - 600);
          const usd = estimateSludgeCostUSD(activeModelId, estTok, ev.tsMs, false);
          sludgeTaxTokens += estTok;
          sludgeTaxUSD += usd;
          offendingTurns.push({
            sessionId: item.sessionId,
            platform: 'claude',
            turnIndex: tIdx,
            modelId: activeModelId,
            category: 'UNSLICED_LARGE_READ',
            wastedTokens: estTok,
            wastedUSD: usd,
            citation: `${item.sessionId}#T${tIdx} (un-sliced Read of ${path.basename(String(toolInput.file_path || 'file'))}, ~${estTok.toLocaleString('en-US')} excess tok)`,
            fix: 'Run `ctxtop shield --enable` to auto-index files >1,200 lines and enforce offset/limit slices.'
          });
        } else if (!isRead && text.length >= OVERSIZED_TOOL_OUTPUT_CHARS_THRESHOLD) {
          oversizedOutputs += 1;
          const estTok = Math.max(0, Math.ceil(text.length / 4) - 350);
          const usd = estimateSludgeCostUSD(activeModelId, estTok, ev.tsMs, false);
          sludgeTaxTokens += estTok;
          sludgeTaxUSD += usd;
          offendingTurns.push({
            sessionId: item.sessionId,
            platform: 'claude',
            turnIndex: tIdx,
            modelId: activeModelId,
            category: 'OVERSIZED_TOOL_DUMP',
            wastedTokens: estTok,
            wastedUSD: usd,
            citation: `${item.sessionId}#T${tIdx} (${toolName || 'Bash'} dumped ~${Math.ceil(text.length / 4).toLocaleString('en-US')} raw tok)`,
            fix: 'Enable Highbeam PostToolUse sanitizer (`ctxtop shield --enable`) to offload >4k-token logs with 100% error recovery.'
          });
        }
      }
    }
  }

  return {
    sessionId: item.sessionId,
    platform: 'claude',
    transcriptPath: item.path,
    turns: turnIndex,
    totalPromptTokens,
    sludgeTaxTokens,
    sludgeTaxUSD: Number(sludgeTaxUSD.toFixed(4)),
    coldCacheSpikes,
    thrashLoops,
    oversizedReads,
    oversizedOutputs,
    offendingTurns
  };
}

/**
 * Audits a single Antigravity `transcript_full.jsonl` / `transcript.jsonl` session file.
 *
 * @param {{ path: string, sessionId: string, mtimeMs: number }} item
 */
export function scoreAntigravityTranscriptFile(item) {
  const lines = fs.readFileSync(item.path, 'utf8').split(/\r?\n/).filter(Boolean);
  let turnIndex = 0;
  let lastStepTsMs = 0;
  let consecutiveErrors = 0;
  let thrashLoops = 0;
  let coldCacheSpikes = 0;
  let oversizedReads = 0;
  let oversizedOutputs = 0;
  let sludgeTaxTokens = 0;
  let sludgeTaxUSD = 0;
  let cumulativeContextTokens = 0;
  let activeModelId = 'gemini-4-carbon';
  let lastToolCall = null;
  const offendingTurns = [];

  for (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (!step || typeof step !== 'object') continue;
    const tsMs = parseIsoOrNumMs(step.created_at || step.timestamp);
    if (step.model || step.modelName) {
      activeModelId = normalizeModelKey(step.model || step.modelName) || activeModelId;
    }

    const stepType = String(step.type || '').toUpperCase();
    const contentStr =
      typeof step.content === 'string'
        ? step.content
        : step.content
          ? JSON.stringify(step.content)
          : '';
    const contentTok = Math.ceil(contentStr.length / 4);
    const modelCeiling = resolveModelCeiling(activeModelId) || 256_000;

    if (
      stepType.includes('COMPACT') ||
      (stepType === 'USER_INPUT' && /^\s*\/compact\b/i.test(contentStr))
    ) {
      cumulativeContextTokens = Math.min(cumulativeContextTokens, 16_000);
    }

    if (stepType === 'PLANNER_RESPONSE' || Array.isArray(step.tool_calls)) {
      turnIndex += 1;
      const activeWindowTok = Math.min(cumulativeContextTokens, modelCeiling);
      if (
        lastStepTsMs > 0 &&
        tsMs > 0 &&
        tsMs - lastStepTsMs > COLD_CACHE_IDLE_GAP_MS &&
        activeWindowTok >= 15_000
      ) {
        coldCacheSpikes += 1;
        const usd = estimateSludgeCostUSD(activeModelId, activeWindowTok, tsMs, true);
        sludgeTaxTokens += activeWindowTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'antigravity',
          turnIndex,
          modelId: activeModelId,
          category: 'COLD_CACHE_SPIKE',
          wastedTokens: activeWindowTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${turnIndex} (${Math.round((tsMs - lastStepTsMs) / 60000)}m idle gap on ~${activeWindowTok.toLocaleString('en-US')}-tok context)`,
          fix: 'Compact or checkpoint to task.md before >5m idle pauses to avoid cold-prefix rebuild spikes.'
        });
      }
      if (tsMs > 0) lastStepTsMs = tsMs;
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      lastToolCall = calls.length > 0 ? calls[0] : null;
    }

    cumulativeContextTokens = Math.min(modelCeiling, cumulativeContextTokens + contentTok);

    const statusUpper = String(step.status || '').toUpperCase();
    const failed =
      statusUpper === 'ERROR' ||
      /Command exited with code [1-9]/i.test(contentStr);
    if (failed) {
      consecutiveErrors += 1;
      if (consecutiveErrors === 3) {
        thrashLoops += 1;
        const thrashTok = 6_000;
        const usd = estimateSludgeCostUSD(activeModelId, thrashTok, tsMs, false);
        sludgeTaxTokens += thrashTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'antigravity',
          turnIndex: Math.max(1, turnIndex),
          modelId: activeModelId,
          category: 'THRASH_3X_LOOP',
          wastedTokens: thrashTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${Math.max(1, turnIndex)} (3 consecutive tool/command errors)`,
          fix: 'Pause blind retries after 2 failures and inspect the indexed error log.'
        });
      }
    } else if (stepType.includes('TOOL') || contentStr.includes('Command exited with code 0')) {
      consecutiveErrors = 0;
    }

    const callName = String(lastToolCall?.name || lastToolCall?.tool_name || '');
    const callArgs = lastToolCall?.args || lastToolCall?.parameters || lastToolCall?.arguments || {};
    const isRead = /^(?:default_api:)?(?:read_file|view_file)$/i.test(callName);
    const hasBounds =
      callArgs.StartLine !== undefined ||
      callArgs.EndLine !== undefined ||
      callArgs.offset !== undefined ||
      callArgs.limit !== undefined;

    if (stepType !== 'PLANNER_RESPONSE' && stepType !== 'USER_INPUT' && contentStr.length >= OVERSIZED_TOOL_OUTPUT_CHARS_THRESHOLD) {
      if (isRead && !hasBounds && contentStr.length >= OVERSIZED_READ_CHARS_THRESHOLD) {
        oversizedReads += 1;
        const estTok = Math.max(0, contentTok - 600);
        const usd = estimateSludgeCostUSD(activeModelId, estTok, tsMs, false);
        sludgeTaxTokens += estTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'antigravity',
          turnIndex: Math.max(1, turnIndex),
          modelId: activeModelId,
          category: 'UNSLICED_LARGE_READ',
          wastedTokens: estTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${Math.max(1, turnIndex)} (un-sliced ${callName || 'read_file'} of ${path.basename(String(callArgs.Path || callArgs.AbsolutePath || 'file'))}, ~${estTok.toLocaleString('en-US')} excess tok)`,
          fix: 'Enable Active Shield (`ctxtop shield --enable`) to index >1,200-line files and enforce StartLine/EndLine.'
        });
      } else if (!isRead) {
        oversizedOutputs += 1;
        const estTok = Math.max(0, contentTok - 350);
        const usd = estimateSludgeCostUSD(activeModelId, estTok, tsMs, false);
        sludgeTaxTokens += estTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'antigravity',
          turnIndex: Math.max(1, turnIndex),
          modelId: activeModelId,
          category: 'OVERSIZED_TOOL_DUMP',
          wastedTokens: estTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${Math.max(1, turnIndex)} (~${contentTok.toLocaleString('en-US')} raw tool output tok)`,
          fix: 'Pipe verbose test/grep commands or enable Highbeam output compaction.'
        });
      }
      lastToolCall = null;
    }
  }

  return {
    sessionId: item.sessionId,
    platform: 'antigravity',
    transcriptPath: item.path,
    turns: turnIndex,
    totalPromptTokens: cumulativeContextTokens,
    sludgeTaxTokens,
    sludgeTaxUSD: Number(sludgeTaxUSD.toFixed(4)),
    coldCacheSpikes,
    thrashLoops,
    oversizedReads,
    oversizedOutputs,
    offendingTurns
  };
}

/**
 * Runs a zero-write cross-platform audit across historical Antigravity and Claude Code sessions.
 *
 * @param {object} [options={}]
 * @param {'all' | 'antigravity' | 'claude'} [options.platform='all']
 * @param {number} [options.days=7]
 * @param {number} [options.limit=10]
 * @param {string} [options.cwd]
 * @param {string} [options.homeDir]
 * @param {string[]} [options.antigravityDirs]
 * @param {string} [options.claudeProjectsDir]
 * @param {number} [options.nowMs]
 */
export function runSessionAudit(options = {}) {
  const platform = String(options.platform || 'all').toLowerCase();
  const days = Math.max(1, Number(options.days) || 7);
  const limit = Math.max(1, Number(options.limit) || 10);
  const nowMs = Number(options.nowMs) || Date.now();
  const cutoffMs = nowMs - days * 86_400_000;
  const home = resolveHome(options);
  const baseCwd = path.resolve(options.cwd || process.cwd());

  const includeAg = platform === 'all' || platform === 'antigravity';
  const includeClaude = platform === 'all' || platform === 'claude';

  const agDirs = Array.isArray(options.antigravityDirs)
    ? options.antigravityDirs
    : [
        path.join(home, '.gemini', 'antigravity', 'brain'),
        path.join(home, '.gemini', 'antigravity-cli', 'brain')
      ];
  const claudeDir =
    options.claudeProjectsDir || path.join(home, '.claude', 'projects');

  const candidates = [];
  if (includeAg) {
    for (const f of listAntigravityTranscriptFiles(agDirs, cutoffMs)) {
      candidates.push({ ...f, platform: 'antigravity' });
    }
  }
  if (includeClaude) {
    for (const f of listClaudeJsonlFiles(claudeDir, cutoffMs)) {
      candidates.push({ ...f, platform: 'claude' });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, limit);

  const sessions = [];
  const allOffendingTurns = [];
  let totalSludgeTokens = 0;
  let totalSludgeUSD = 0;
  let totalColdCacheSpikes = 0;
  let totalThrashLoops = 0;
  let totalOversizedReads = 0;
  let totalOversizedOutputs = 0;

  for (const item of selected) {
    try {
      const scored =
        item.platform === 'claude'
          ? scoreClaudeTranscriptFile(item)
          : scoreAntigravityTranscriptFile(item);
      sessions.push(scored);
      totalSludgeTokens += scored.sludgeTaxTokens;
      totalSludgeUSD += scored.sludgeTaxUSD;
      totalColdCacheSpikes += scored.coldCacheSpikes;
      totalThrashLoops += scored.thrashLoops;
      totalOversizedReads += scored.oversizedReads;
      totalOversizedOutputs += scored.oversizedOutputs;
      allOffendingTurns.push(...scored.offendingTurns);
    } catch {
      // Skip unreadable transcript cleanly
    }
  }

  allOffendingTurns.sort((a, b) => b.wastedUSD - a.wastedUSD || b.wastedTokens - a.wastedTokens);
  const topOffendingTurns = allOffendingTurns.slice(0, 3);

  const ledger = getSavedQuotaReceiptSummary({
    cwd: baseCwd,
    homeDir: home
  });

  return {
    ok: true,
    platform,
    days,
    limit,
    sessionsScanned: sessions.length,
    sludgeTaxTokens: totalSludgeTokens,
    sludgeTaxUSD: Number(totalSludgeUSD.toFixed(2)),
    coldCacheSpikes: totalColdCacheSpikes,
    thrashLoops: totalThrashLoops,
    oversizedReads: totalOversizedReads,
    oversizedOutputs: totalOversizedOutputs,
    savedTokens30d: Number(ledger.workspace30dSavedTokens || 0),
    savedUSD30d: Number(Number(ledger.workspace30dSavedUSD || 0).toFixed(2)),
    topOffendingTurns,
    sessions
  };
}

/**
 * Formats a human-readable Quota Shield & Session ROI console report for `ctxtop audit`.
 *
 * @param {ReturnType<typeof runSessionAudit>} res
 * @returns {string}
 */
export function formatSessionAuditReport(res) {
  const lines = [
    `[Highbeam Session ROI Audit] Window: ${res.days}d | Platform: ${res.platform} | Sessions: ${res.sessionsScanned}`,
    `  Sludge Tax Preventable : ${res.sludgeTaxTokens.toLocaleString('en-US')} tok ($${res.sludgeTaxUSD.toFixed(2)} USD)`,
    `  Cold-Cache Spikes (>5m): ${res.coldCacheSpikes} | 3x Thrash Loops: ${res.thrashLoops}`,
    `  Un-Sliced Large Reads  : ${res.oversizedReads} | Oversized Tool Dumps: ${res.oversizedOutputs}`,
    `  Quota Shield Saved (30d): +${res.savedTokens30d.toLocaleString('en-US')} tok ($${res.savedUSD30d.toFixed(2)} USD)`
  ];
  if (res.topOffendingTurns.length > 0) {
    lines.push('  Top Offending Turns:');
    res.topOffendingTurns.forEach((turn, idx) => {
      lines.push(
        `    ${idx + 1}. [${turn.platform}/${turn.category}] ${turn.citation} -> ~$${turn.wastedUSD.toFixed(2)} (${turn.wastedTokens.toLocaleString('en-US')} tok)`
      );
      lines.push(`       Fix: ${turn.fix}`);
    });
  } else {
    lines.push('  Top Offending Turns: None detected in scanned window.');
  }
  return lines.join('\n');
}
