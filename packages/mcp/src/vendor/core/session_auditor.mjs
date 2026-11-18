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
    } catch (err) {
      void err;
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
        } catch (err) {
          void err;
        }
      }
    }
  };
  walk(claudeRoot, 0);
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listCodexJsonlFiles(codexRoot, cutoffMs) {
  return listClaudeJsonlFiles(codexRoot, cutoffMs);
}

function listCursorTranscriptFiles(cursorRoot, cutoffMs) {
  const results = [];
  if (!cursorRoot || !fs.existsSync(cursorRoot)) return results;
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      void err;
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'airlock') continue;
      const full = path.join(dir, ent.name);
      if (isForbiddenSkuPath(full)) continue;
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl') && dir.toLowerCase().includes('transcript')) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoffMs) {
            results.push({ path: full, mtimeMs: st.mtimeMs, sessionId: path.basename(ent.name, '.jsonl') });
          }
        } catch (err) {
          void err;
        }
      }
    }
  };
  walk(cursorRoot, 0);
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listGeminiSessionJsonFiles(geminiTmpRoot, cutoffMs) {
  const results = [];
  if (!geminiTmpRoot || !fs.existsSync(geminiTmpRoot)) return results;
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      void err;
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'oauth_creds.json' || ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'airlock') {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (isForbiddenSkuPath(full)) continue;
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        ent.isFile() &&
        /^session-.*\.json$/i.test(ent.name) &&
        path.basename(dir).toLowerCase() === 'chats'
      ) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoffMs) {
            results.push({ path: full, mtimeMs: st.mtimeMs, sessionId: path.basename(ent.name, '.json') });
          }
        } catch (err) {
          void err;
        }
      }
    }
  };
  walk(geminiTmpRoot, 0);
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
    } catch (err) {
      void err;
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
      } catch (err) {
        void err;
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
    } catch (parseErr) {
      void parseErr;
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
    } catch (parseErr) {
      void parseErr;
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

function scoreGenericJsonlEvents(item, platformName, defaultModelId) {
  const lines = fs.readFileSync(item.path, 'utf8').split(/\r?\n/).filter(Boolean);
  let turnIndex = 0;
  let lastTurnTsMs = 0;
  let consecutiveErrors = 0;
  let thrashLoops = 0;
  let coldCacheSpikes = 0;
  let oversizedReads = 0;
  let oversizedOutputs = 0;
  let sludgeTaxTokens = 0;
  let sludgeTaxUSD = 0;
  let totalPromptTokens = 0;
  let cumulativeContextTokens = 0;
  let activeModelId = defaultModelId;
  const callById = new Map();
  const offendingTurns = [];

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (parseErr) {
      void parseErr;
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const tsMs = parseIsoOrNumMs(row.timestamp || row.created_at || row.createdAt);
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : row;
    const rawModel = payload.model || row.model || payload.info?.model;
    if (rawModel) {
      activeModelId = normalizeModelKey(rawModel) || activeModelId;
    }

    const rowType = String(row.type || payload.type || '').toLowerCase();
    const role = String(payload.role || row.role || '').toLowerCase();

    if (rowType === 'token_count' && payload.info?.total_token_usage) {
      const u = payload.info.total_token_usage;
      const inTok = Number(u.input_tokens || 0) + Number(u.cached_input_tokens || 0);
      if (inTok > cumulativeContextTokens) {
        cumulativeContextTokens = inTok;
        totalPromptTokens += inTok;
      }
      continue;
    }

    if (role === 'assistant' || rowType === 'assistant' || rowType === 'agent_message' || rowType === 'turn_started') {
      turnIndex += 1;
      const u = payload.usage || row.usage || {};
      const stepIn = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
      if (stepIn > 0) {
        totalPromptTokens += stepIn;
        cumulativeContextTokens = Math.max(cumulativeContextTokens, stepIn);
      }
      if (lastTurnTsMs > 0 && tsMs > 0 && tsMs - lastTurnTsMs > COLD_CACHE_IDLE_GAP_MS && cumulativeContextTokens >= 15_000) {
        coldCacheSpikes += 1;
        const usd = estimateSludgeCostUSD(activeModelId, cumulativeContextTokens, tsMs, true);
        sludgeTaxTokens += cumulativeContextTokens;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: platformName,
          turnIndex,
          modelId: activeModelId,
          category: 'COLD_CACHE_SPIKE',
          wastedTokens: cumulativeContextTokens,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${turnIndex} (${Math.round((tsMs - lastTurnTsMs) / 60000)}m idle gap on ~${cumulativeContextTokens.toLocaleString('en-US')}-tok context)`,
          fix: 'Compact or save a handoff checkpoint before >5m idle pauses to avoid cold-prefix rebuilds.'
        });
      }
      if (tsMs > 0) lastTurnTsMs = tsMs;
    }

    if (rowType === 'function_call' || rowType === 'tool_use') {
      const cid = payload.call_id || payload.id || '';
      const cname = String(payload.name || payload.tool_name || '');
      let cargs = payload.arguments ?? payload.input ?? {};
      if (typeof cargs === 'string') {
        try {
          cargs = JSON.parse(cargs);
        } catch (argErr) {
          void argErr;
          cargs = {};
        }
      }
      if (cid) callById.set(cid, { name: cname, args: cargs, turnIndex: Math.max(1, turnIndex) });
      continue;
    }

    if (rowType === 'function_call_output' || rowType === 'tool_result' || role === 'tool') {
      const cid = payload.call_id || payload.tool_use_id || '';
      const linked = cid ? callById.get(cid) : null;
      const toolName = String(linked?.name || payload.name || payload.tool_name || '');
      const toolArgs = linked?.args || {};
      const tIdx = linked?.turnIndex || Math.max(1, turnIndex);
      const outputText = typeof payload.output === 'string'
        ? payload.output
        : typeof payload.content === 'string'
          ? payload.content
          : JSON.stringify(payload.output ?? payload.content ?? '');
      const contentTok = Math.ceil(outputText.length / 4);
      cumulativeContextTokens += contentTok;
      totalPromptTokens += contentTok;

      const failed = Boolean(payload.is_error || payload.error || /Exit code:\s*[1-9]|Command exited with code [1-9]/i.test(outputText));
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
            platform: platformName,
            turnIndex: tIdx,
            modelId: activeModelId,
            category: 'THRASH_3X_LOOP',
            wastedTokens: thrashTok,
            wastedUSD: usd,
            citation: `${item.sessionId}#T${tIdx} (3 consecutive ${toolName || 'tool'} failures)`,
            fix: 'Inspect the failing assertion digest via Highbeam MCP or FTS5 search before retrying.'
          });
        }
      } else {
        consecutiveErrors = 0;
      }

      const isRead = /^(?:read_file|Read|view_file|cat)$/i.test(toolName);
      const hasBounds = toolArgs.offset !== undefined || toolArgs.limit !== undefined || toolArgs.StartLine !== undefined || toolArgs.EndLine !== undefined;
      if (isRead && !hasBounds && outputText.length >= OVERSIZED_READ_CHARS_THRESHOLD) {
        oversizedReads += 1;
        const estTok = Math.max(0, contentTok - 600);
        const usd = estimateSludgeCostUSD(activeModelId, estTok, tsMs, false);
        sludgeTaxTokens += estTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: platformName,
          turnIndex: tIdx,
          modelId: activeModelId,
          category: 'UNSLICED_LARGE_READ',
          wastedTokens: estTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${tIdx} (un-sliced read of ${path.basename(String(toolArgs.file_path || toolArgs.path || 'file'))}, ~${estTok.toLocaleString('en-US')} excess tok)`,
          fix: 'Read bounded line ranges (<=150 lines) instead of full large files.'
        });
      } else if (!isRead && outputText.length >= OVERSIZED_TOOL_OUTPUT_CHARS_THRESHOLD) {
        oversizedOutputs += 1;
        const estTok = Math.max(0, contentTok - 350);
        const usd = estimateSludgeCostUSD(activeModelId, estTok, tsMs, false);
        sludgeTaxTokens += estTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: platformName,
          turnIndex: tIdx,
          modelId: activeModelId,
          category: 'OVERSIZED_TOOL_DUMP',
          wastedTokens: estTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${tIdx} (${toolName || 'CLI'} dumped ~${contentTok.toLocaleString('en-US')} raw tok)`,
          fix: 'Compress noisy CLI dumps via Highbeam FTS5 compressor (`horizon_compress_cli`).'
        });
      }
    }
  }

  return {
    sessionId: item.sessionId,
    platform: platformName,
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

export function scoreCodexTranscriptFile(item) {
  return scoreGenericJsonlEvents(item, 'codex', 'claude-sonnet-4-6');
}

export function scoreCursorTranscriptFile(item) {
  return scoreGenericJsonlEvents(item, 'cursor', 'claude-sonnet-4-6');
}

/**
 * Audits a single Gemini CLI `~/.gemini/tmp/<hash>/chats/session-*.json` transcript read-only.
 */
export function scoreGeminiSessionFile(item) {
  const raw = JSON.parse(fs.readFileSync(item.path, 'utf8'));
  const messages = Array.isArray(raw?.messages) ? raw.messages : [];
  let turnIndex = 0;
  let lastTsMs = 0;
  let consecutiveErrors = 0;
  let thrashLoops = 0;
  let coldCacheSpikes = 0;
  let oversizedReads = 0;
  let oversizedOutputs = 0;
  let sludgeTaxTokens = 0;
  let sludgeTaxUSD = 0;
  let totalPromptTokens = 0;
  let activeModelId = 'gemini-4-carbon';
  const offendingTurns = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const tsMs = parseIsoOrNumMs(msg.timestamp || msg.createdAt);
    if (msg.model) {
      activeModelId = normalizeModelKey(msg.model) || activeModelId;
    }
    const msgType = String(msg.type || '').toLowerCase();
    if (msgType === 'gemini' || msgType === 'model') {
      turnIndex += 1;
      const inTok = Number(msg.tokens?.input || 0);
      totalPromptTokens += inTok;
      if (lastTsMs > 0 && tsMs > 0 && tsMs - lastTsMs > COLD_CACHE_IDLE_GAP_MS && inTok >= 15_000) {
        coldCacheSpikes += 1;
        const usd = estimateSludgeCostUSD(activeModelId, inTok, tsMs, true);
        sludgeTaxTokens += inTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'gemini',
          turnIndex,
          modelId: activeModelId,
          category: 'COLD_CACHE_SPIKE',
          wastedTokens: inTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${turnIndex} (${Math.round((tsMs - lastTsMs) / 60000)}m idle gap on ~${inTok.toLocaleString('en-US')}-tok context)`,
          fix: 'Compact or save checkpoint before >5m pauses to preserve warm KV prefix.'
        });
      }
      if (tsMs > 0) lastTsMs = tsMs;
    }

    const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
    for (const tc of toolCalls) {
      const toolName = String(tc.name || '');
      const toolArgs = tc.args && typeof tc.args === 'object' ? tc.args : {};
      const outStr = typeof tc.result === 'string'
        ? tc.result
        : Array.isArray(tc.result)
          ? tc.result.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')
          : JSON.stringify(tc.result ?? '');
      const tok = Math.ceil(outStr.length / 4);
      const isErr = String(tc.status || '').toLowerCase() === 'error';
      if (isErr) {
        consecutiveErrors += 1;
        if (consecutiveErrors === 3) {
          thrashLoops += 1;
          const thrashTok = 6_000;
          const usd = estimateSludgeCostUSD(activeModelId, thrashTok, tsMs, false);
          sludgeTaxTokens += thrashTok;
          sludgeTaxUSD += usd;
          offendingTurns.push({
            sessionId: item.sessionId,
            platform: 'gemini',
            turnIndex: Math.max(1, turnIndex),
            modelId: activeModelId,
            category: 'THRASH_3X_LOOP',
            wastedTokens: thrashTok,
            wastedUSD: usd,
            citation: `${item.sessionId}#T${Math.max(1, turnIndex)} (3 consecutive ${toolName || 'tool'} failures)`,
            fix: 'Pause retries and inspect root cause via FTS5 search.'
          });
        }
      } else {
        consecutiveErrors = 0;
      }

      const isRead = /^(?:read_file|Read|view_file)$/i.test(toolName);
      const hasSlice = toolArgs.offset !== undefined || toolArgs.limit !== undefined || toolArgs.StartLine !== undefined;
      if (isRead && !hasSlice && outStr.length >= OVERSIZED_READ_CHARS_THRESHOLD) {
        oversizedReads += 1;
        const estTok = Math.max(0, tok - 600);
        const usd = estimateSludgeCostUSD(activeModelId, estTok, tsMs, false);
        sludgeTaxTokens += estTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'gemini',
          turnIndex: Math.max(1, turnIndex),
          modelId: activeModelId,
          category: 'UNSLICED_LARGE_READ',
          wastedTokens: estTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${Math.max(1, turnIndex)} (un-sliced read, ~${estTok.toLocaleString('en-US')} excess tok)`,
          fix: 'Use bounded line offsets on large source files.'
        });
      } else if (!isRead && outStr.length >= OVERSIZED_TOOL_OUTPUT_CHARS_THRESHOLD) {
        oversizedOutputs += 1;
        const estTok = Math.max(0, tok - 350);
        const usd = estimateSludgeCostUSD(activeModelId, estTok, tsMs, false);
        sludgeTaxTokens += estTok;
        sludgeTaxUSD += usd;
        offendingTurns.push({
          sessionId: item.sessionId,
          platform: 'gemini',
          turnIndex: Math.max(1, turnIndex),
          modelId: activeModelId,
          category: 'OVERSIZED_TOOL_DUMP',
          wastedTokens: estTok,
          wastedUSD: usd,
          citation: `${item.sessionId}#T${Math.max(1, turnIndex)} (${toolName || 'shell'} dumped ~${tok.toLocaleString('en-US')} raw tok)`,
          fix: 'Enable Highbeam MCP output compression (`horizon_compress_cli`).'
        });
      }
    }
  }

  return {
    sessionId: item.sessionId,
    platform: 'gemini',
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
 * Runs a zero-write cross-platform audit across historical Antigravity, Claude Code, Codex CLI,
 * Gemini CLI, and Cursor sessions.
 *
 * @param {object} [options={}]
 * @param {'all' | 'antigravity' | 'claude' | 'codex' | 'gemini' | 'cursor'} [options.platform='all']
 */
export function runSessionAudit(options = {}) {
  const rawPlatform = String(options.platform || 'all').toLowerCase();
  const platform = rawPlatform === 'gemini-cli' ? 'gemini' : rawPlatform;
  const days = Math.max(1, Number(options.days) || 7);
  const limit = Math.max(1, Number(options.limit) || 10);
  const nowMs = Number(options.nowMs) || Date.now();
  const cutoffMs = nowMs - days * 86_400_000;
  const home = resolveHome(options);
  const baseCwd = path.resolve(options.cwd || process.cwd());

  const includeAg = platform === 'all' || platform === 'antigravity';
  const includeClaude = platform === 'all' || platform === 'claude';
  const includeCodex = platform === 'all' || platform === 'codex';
  const includeGemini = platform === 'all' || platform === 'gemini';
  const includeCursor = platform === 'all' || platform === 'cursor';

  const agDirs = Array.isArray(options.antigravityDirs)
    ? options.antigravityDirs
    : [
        path.join(home, '.gemini', 'antigravity', 'brain'),
        path.join(home, '.gemini', 'antigravity-cli', 'brain')
      ];
  const claudeDir =
    options.claudeProjectsDir || path.join(home, '.claude', 'projects');
  const codexDir =
    options.codexSessionsDir || path.join(home, '.codex', 'sessions');
  const geminiTmpDir =
    options.geminiTmpDir || path.join(home, '.gemini', 'tmp');
  const cursorDir =
    options.cursorProjectsDir || path.join(home, '.cursor', 'projects');

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
  if (includeCodex) {
    for (const f of listCodexJsonlFiles(codexDir, cutoffMs)) {
      candidates.push({ ...f, platform: 'codex' });
    }
  }
  if (includeGemini) {
    for (const f of listGeminiSessionJsonFiles(geminiTmpDir, cutoffMs)) {
      candidates.push({ ...f, platform: 'gemini' });
    }
  }
  if (includeCursor) {
    for (const f of listCursorTranscriptFiles(cursorDir, cutoffMs)) {
      candidates.push({ ...f, platform: 'cursor' });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, limit);

  const sessions = [];
  const allOffendingTurns = [];
  const platformsBreakdown = { antigravity: 0, claude: 0, codex: 0, gemini: 0, cursor: 0 };
  let totalSludgeTokens = 0;
  let totalSludgeUSD = 0;
  let totalColdCacheSpikes = 0;
  let totalThrashLoops = 0;
  let totalOversizedReads = 0;
  let totalOversizedOutputs = 0;

  for (const item of selected) {
    try {
      let scored;
      if (item.platform === 'claude') {
        scored = scoreClaudeTranscriptFile(item);
      } else if (item.platform === 'codex') {
        scored = scoreCodexTranscriptFile(item);
      } else if (item.platform === 'gemini') {
        scored = scoreGeminiSessionFile(item);
      } else if (item.platform === 'cursor') {
        scored = scoreCursorTranscriptFile(item);
      } else {
        scored = scoreAntigravityTranscriptFile(item);
      }
      sessions.push(scored);
      platformsBreakdown[item.platform] = (platformsBreakdown[item.platform] || 0) + 1;
      totalSludgeTokens += scored.sludgeTaxTokens;
      totalSludgeUSD += scored.sludgeTaxUSD;
      totalColdCacheSpikes += scored.coldCacheSpikes;
      totalThrashLoops += scored.thrashLoops;
      totalOversizedReads += scored.oversizedReads;
      totalOversizedOutputs += scored.oversizedOutputs;
      allOffendingTurns.push(...scored.offendingTurns);
    } catch (err) {
      void err;
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
    platformsBreakdown,
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
  const activePlatforms = Object.entries(res.platformsBreakdown || {})
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  const lines = [
    `[Highbeam Session ROI Audit] Window: ${res.days}d | Platform: ${res.platform} | Sessions: ${res.sessionsScanned}${activePlatforms ? ` (${activePlatforms})` : ''}`,
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

/**
 * One-line "what you already wasted" teaser for the end of `ctxtop init`.
 * Returns '' when there is nothing worth showing.
 *
 * @param {ReturnType<typeof runSessionAudit>} res
 */
export function formatPastWasteLine(res) {
  if (!res || !res.ok || !(res.sludgeTaxUSD >= 0.5) || !(res.sessionsScanned > 0)) return '';
  const n = res.sessionsScanned;
  return (
    `Last ${res.days} days: ~$${res.sludgeTaxUSD.toFixed(2)} (${res.sludgeTaxTokens.toLocaleString('en-US')} tokens) ` +
    `across ${n} session${n === 1 ? '' : 's'} was preventable waste Highbeam would have caught. ` +
    `Details: npx ctxtop audit`
  );
}
