import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalizePath } from './path_canonicalizer.mjs';

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * Resolves the 4-tier log file path for a given conversation.
 */
export function resolveTranscriptPath(conversationId, brainDirOverride = null) {
  const home = getHomeDir();
  const brainDir = brainDirOverride || path.join(home, '.gemini', 'antigravity', 'brain', conversationId);

  // Tier 1: transcript_full.jsonl
  const tier1Path = path.join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (fs.existsSync(tier1Path)) {
    return { path: tier1Path, tier: 1, brainDir };
  }

  // Tier 2: chunks/transcript_full/*.jsonl
  const tier2Dir = path.join(brainDir, '.system_generated', 'logs', 'chunks', 'transcript_full');
  if (fs.existsSync(tier2Dir)) {
    try {
      const files = fs.readdirSync(tier2Dir)
        .filter(f => f.endsWith('.jsonl'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (files.length > 0) {
        return { path: path.join(tier2Dir, files[files.length - 1]), tier: 2, brainDir, chunkFiles: files.map(f => path.join(tier2Dir, f)) };
      }
    } catch {}
  }

  // Tier 3: transcript.jsonl
  const tier3Path = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(tier3Path)) {
    return { path: tier3Path, tier: 3, brainDir };
  }

  // Tier 4: SQLite DB fallback
  const tier4Path = path.join(home, '.gemini', 'antigravity', 'conversations', `${conversationId}.db`);
  if (fs.existsSync(tier4Path)) {
    return { path: tier4Path, tier: 4, brainDir };
  }

  return { path: null, tier: 0, brainDir };
}

/**
 * Checks for '@deprecated' tag within the first 30 lines of text.
 */
export function checkDeprecatedInHeader(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.slice(0, 4000).split(/\r?\n/).slice(0, 30);
  return lines.some(line => /@deprecated/i.test(line));
}

/**
 * Normalizes raw JSONL step objects into lightweight StepEvents.
 */
export function normalizeStepEntry(entry, index, brainDir = null) {
  const stepIndex = typeof entry.step_index === 'number' ? entry.step_index : index;
  const timestampMs = entry.created_at ? new Date(entry.created_at).getTime() : Date.now();
  
  let role = 'model';
  if (entry.source === 'USER_EXPLICIT' || entry.type === 'USER_INPUT') {
    role = 'user';
  } else if (entry.source === 'SYSTEM' || entry.type === 'ANCHOR' || entry.type === 'SCHEMA') {
    role = 'system';
  } else if (entry.type === 'TOOL_RESULT' || entry.tool_results) {
    role = 'tool';
  }

  let toolName = null;
  let targetPath = null;
  let exitCode = null;
  let textSample = '';
  let fullText = '';

  // Extract from tool_calls
  if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
    const call = entry.tool_calls[0];
    toolName = call.name || call.tool || null;
    const args = call.args || call.parameters || call.Arguments || {};
    const rawPath = args.Path || args.path || args.target_file || args.file_path || args.targetPath;
    if (rawPath) targetPath = canonicalizePath(String(rawPath));
    if (toolName === 'run_command' && args.CommandLine) {
      textSample = String(args.CommandLine);
    }
  }

  // Extract from tool output or content
  if (entry.content) {
    if (typeof entry.content === 'string') {
      fullText = entry.content;
    } else if (typeof entry.content === 'object') {
      fullText = JSON.stringify(entry.content);
    }
  }

  if (entry.thinking && typeof entry.thinking === 'string') {
    fullText += ' ' + entry.thinking;
  }

  // Check hydration if transcript.jsonl had truncated_fields
  if (brainDir && Array.isArray(entry.truncated_fields) && entry.truncated_fields.length > 0) {
    const stepOutputPath = path.join(brainDir, 'steps', String(stepIndex), 'output.txt');
    const altOutputPath = path.join(brainDir, '.system_generated', 'steps', String(stepIndex), 'output.txt');
    try {
      if (fs.existsSync(stepOutputPath)) {
        fullText = fs.readFileSync(stepOutputPath, 'utf8');
      } else if (fs.existsSync(altOutputPath)) {
        fullText = fs.readFileSync(altOutputPath, 'utf8');
      }
    } catch {}
  }

  if (!textSample && fullText) {
    textSample = fullText.slice(0, 512);
  }

  // Determine exitCode if command or tool error
  if (entry.status === 'ERROR' || entry.exit_code === 1 || entry.exitCode === 1) {
    exitCode = 1;
  } else if (entry.status === 'DONE' && (entry.exit_code === 0 || entry.exitCode === 0)) {
    exitCode = 0;
  } else if (typeof entry.exitCode === 'number') {
    exitCode = entry.exitCode;
  }

  const tokenEstimate = entry.token_count || Math.max(1, Math.ceil(fullText.length / 4));
  const isDeprecatedContent = checkDeprecatedInHeader(fullText);

  return {
    stepIndex,
    timestampMs,
    role,
    type: entry.type || (role === 'user' ? 'USER_INPUT' : 'PLANNER_RESPONSE'),
    toolName,
    targetPath,
    exitCode,
    tokenEstimate,
    isDeprecatedContent,
    rawTextSample: textSample
  };
}

/**
 * Incrementally reads transcript logs using byte-offset cursor across all 4 tiers.
 */
export function resolveAndReadTranscriptIncremental(conversationId, cursorState = {}, options = {}) {
  const { brainDirOverride = null } = options;
  const resolution = resolveTranscriptPath(conversationId, brainDirOverride);

  const state = {
    filePath: cursorState.filePath || null,
    byteOffset: cursorState.byteOffset || 0,
    parsedEvents: Array.isArray(cursorState.parsedEvents) ? [...cursorState.parsedEvents] : [],
    tier: resolution.tier
  };

  if (!resolution.path) {
    return state;
  }

  const currentPath = resolution.path;

  // Handle tier 4 (db) or non-jsonl paths
  if (resolution.tier === 4 || !currentPath.endsWith('.jsonl')) {
    state.filePath = currentPath;
    return state;
  }

  // If path changed or log rotated, reset offset
  let stat;
  try {
    stat = fs.statSync(currentPath);
  } catch {
    return state;
  }

  if (state.filePath !== currentPath || stat.size < state.byteOffset) {
    state.filePath = currentPath;
    state.byteOffset = 0;
    state.parsedEvents = [];
  }

  const bytesToRead = stat.size - state.byteOffset;
  if (bytesToRead <= 0) {
    return state;
  }

  const fd = fs.openSync(currentPath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, state.byteOffset);
    state.byteOffset = stat.size;

    const rawChunk = buffer.toString('utf8');
    const lines = rawChunk.split(/\r?\n/).filter(l => l.trim().length > 0);

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        const normalized = normalizeStepEntry(entry, state.parsedEvents.length, resolution.brainDir);
        state.parsedEvents.push(normalized);
      } catch {
        // Skip malformed individual lines
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return state;
}
