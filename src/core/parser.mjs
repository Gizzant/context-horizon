import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath, getHomeDir, getBrainStores, getAntigravitySurfaces } from './paths.mjs';
import { EFFORT_PROFILES, resolveEffortProfile, resolveSurfaceTag, normalizeModelId } from './constants.mjs';
import { stitchAntigravityCliTrajectory } from './trajectory_stitcher.mjs';

/**
 * Zero-Trust Read-Only Filesystem Lock Configuration (SQLITE_OPEN_READONLY).
 * Never acquires write locks on active Antigravity session databases (conversations/*.db,
 * conversation_summaries.db) or JSONL transcript files (transcript_full.jsonl).
 */
export const SQLITE_OPEN_READONLY_OPTIONS = Object.freeze({ readOnly: true });
export const ZERO_TRUST_SECURITY_MANIFEST = Object.freeze({
  networkProfile: 'ZERO_OUTBOUND_CONNECTIONS',
  telemetryParsing: '100%_LOCAL_IN_MEMORY',
  sqliteOpenFlag: 'SQLITE_OPEN_READONLY',
  sqliteOptions: SQLITE_OPEN_READONLY_OPTIONS,
  jsonlOpenMode: 'r',
  requiresExternalApiKeys: false
});

/**
 * Matches the host's settings-change sentence, e.g.
 * "The user changed setting `Model Selection` from Claude Sonnet 5.5 (Medium) to Claude Opus 5.5 (Medium). No need ..."
 * Values may contain dots ("5.5"), so the terminator is ". No need" (or a sentence end at block end).
 */
const SETTINGS_CHANGE_RE = /changed setting\s+`(Model Selection|Reasoning Effort|Effort)`\s+from\s+(.+?)\s+to\s+(.+?)\.\s+No need/i;
const SETTINGS_CHANGE_FALLBACK_RE = /changed setting\s+`?(Model Selection|Reasoning Effort|Effort)`?\s+from\s+(.+?)\s+to\s+(.+?)\.?\s*(?:<|$)/i;

/**
 * Only genuine user turns carry authoritative settings-change blocks. Tool output, code views
 * and planner text that merely quote the tag are ignored.
 */
function isUserInputEntry(entry) {
  const t = String(entry?.type || '').toUpperCase();
  if (t) return t === 'USER_INPUT';
  return /^USER/i.test(String(entry?.source || ''));
}

/**
 * Parses all <USER_SETTINGS_CHANGE> blocks in a user turn.
 * Returns [{ setting, from, to }] in order of appearance.
 */
export function parseSettingsChanges(rawContent = '') {
  const out = [];
  const text = String(rawContent || '');
  if (!text.includes('<USER_SETTINGS_CHANGE>')) return out;
  const blocks = text.match(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi) || [];
  for (const block of blocks) {
    const inner = block.replace(/<\/?USER_SETTINGS_CHANGE>/gi, '').replace(/\r?\n/g, ' ').trim();
    const m = inner.match(SETTINGS_CHANGE_RE) || inner.match(SETTINGS_CHANGE_FALLBACK_RE);
    if (m) {
      out.push({ setting: m[1], from: m[2].trim(), to: m[3].trim() });
    }
  }
  return out;
}

/**
 * Returns the most recent `Model Selection` target from USER_INPUT settings-change blocks,
 * or null when the transcript never records a model switch.
 */
export function resolveModelFromTranscript(steps = []) {
  for (let i = (steps?.length || 0) - 1; i >= 0; i--) {
    const st = steps[i];
    if (!st || !isUserInputEntry(st)) continue;
    const content = String(st.content || '');
    if (!content.includes('<USER_SETTINGS_CHANGE>')) continue;
    const changes = parseSettingsChanges(content).filter(c => /model selection/i.test(c.setting));
    if (changes.length > 0) {
      const raw = changes[changes.length - 1].to;
      if (raw && !/^none$/i.test(raw)) return { raw, id: normalizeModelId(raw) };
    }
  }
  return null;
}

/**
 * Model precedence: stdin (host) > gen_metadata.model > last USER_INPUT Model Selection > fallback.
 * Returns { id, raw, source: 'stdin' | 'gen_metadata' | 'transcript' | 'fallback' }.
 */
export function resolveSessionModel({ stdinData = null, genMetadata = null, steps = [], fallback = 'gemini-3.8-flash' } = {}) {
  const stdinModel = stdinData?.model?.id || (typeof stdinData?.model === 'string' ? stdinData.model : null) || stdinData?.modelName || null;
  if (stdinModel) return { id: stdinModel, raw: stdinModel, source: 'stdin' };
  if (genMetadata?.model) return { id: normalizeModelId(genMetadata.model), raw: genMetadata.model, source: 'gen_metadata' };
  const fromTranscript = resolveModelFromTranscript(steps);
  if (fromTranscript) return { id: fromTranscript.id, raw: fromTranscript.raw, source: 'transcript' };
  return { id: fallback, raw: fallback, source: 'fallback' };
}

/**
 * Extracts model/effort metadata from a raw JSONL transcript entry if present.
 */
export function extractTurnEffortMetadata(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const rawContent = String(entry.content || '');
  let fromSpec = null;
  let toSpec = null;
  let setting = null;
  let modelFromSpec = null;
  let modelToSpec = null;

  if (isUserInputEntry(entry) && rawContent.includes('<USER_SETTINGS_CHANGE>')) {
    for (const change of parseSettingsChanges(rawContent)) {
      if (fromSpec === null) fromSpec = change.from;
      toSpec = change.to;
      setting = change.setting;
      if (/model selection/i.test(change.setting)) {
        if (modelFromSpec === null) modelFromSpec = change.from;
        modelToSpec = change.to;
      }
    }
  }

  const explicitMeta = entry.turnMetadata && typeof entry.turnMetadata === 'object' ? entry.turnMetadata : null;
  const effort = explicitMeta?.effort || explicitMeta?.reasoningEffort || explicitMeta?.reasoning_effort ||
    entry.effort || entry.reasoning_effort || entry.reasoningEffort || null;
  const tier = explicitMeta?.tier || explicitMeta?.effortTier || entry.effortTier || entry.tier || null;
  const model = explicitMeta?.model || explicitMeta?.modelId ||
    (typeof entry.model === 'string' ? entry.model : (entry.model?.id || entry.modelId || entry.model_id || null));

  if (!toSpec && !effort && !tier && !model && !explicitMeta) {
    return null;
  }

  return {
    fromSpec: explicitMeta?.fromSpec ?? fromSpec,
    toSpec: explicitMeta?.toSpec ?? toSpec,
    setting: setting || null,
    effort: effort || toSpec || null,
    tier: tier || null,
    model: model || modelToSpec || null,
    modelId: modelToSpec ? normalizeModelId(modelToSpec) : null,
    modelFromSpec,
    modelToSpec,
    rawLabel: toSpec || effort || tier || model || ''
  };
}

/**
 * Evaluates step-by-step effort profile resolution and mid-session transitions.
 */
export function extractEffortTimeline(steps = []) {
  let currentProfile = { ...EFFORT_PROFILES.STANDARD };
  let hasEstablishedTier = false;
  let cumTokens = 0;
  const effortHistory = [];

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx] || {};
    const stepTok = step.inputTokens > 0 && step.outputTokens > 0
      ? Math.max(step.outputTokens, Math.round((step.untruncatedLength || 0) / 4))
      : (step.outputTokens || Math.round((step.untruncatedLength || 0) / 4) || 1000);
    const estBlock = Math.min(39, Math.max(0, Math.floor(cumTokens / 5000)));
    cumTokens += stepTok;

    const meta = step.turnMetadata || extractTurnEffortMetadata(step);
    if (!meta) continue;

    const hasExplicitFrom = meta.fromSpec && !/^none$/i.test(String(meta.fromSpec).trim());
    if (hasExplicitFrom) {
      const fromProf = resolveEffortProfile(meta.fromSpec);
      const toProf = resolveEffortProfile(meta);
      const effectiveFrom = hasEstablishedTier ? currentProfile : fromProf;
      if (toProf.tier !== effectiveFrom.tier) {
        effortHistory.push({
          turnIndex: idx,
          stepNumber: step.stepIndex ?? idx,
          blockIndex: estBlock,
          fromTier: effectiveFrom.tier,
          toTier: toProf.tier,
          fromLabel: effectiveFrom.shortLabel || effectiveFrom.label,
          toLabel: toProf.shortLabel || toProf.label,
          timestamp: step.createdAt || step.timestamp || null
        });
      }
      currentProfile = toProf;
      hasEstablishedTier = true;
      continue;
    }

    if (idx === 0 && !hasEstablishedTier) {
      currentProfile = resolveEffortProfile(meta);
      hasEstablishedTier = true;
      continue;
    }

    const nextProfile = resolveEffortProfile(meta);
    if (nextProfile.tier !== currentProfile.tier) {
      effortHistory.push({
        turnIndex: idx,
        stepNumber: step.stepIndex ?? idx,
        blockIndex: estBlock,
        fromTier: currentProfile.tier,
        toTier: nextProfile.tier,
        fromLabel: currentProfile.shortLabel || currentProfile.label,
        toLabel: nextProfile.shortLabel || nextProfile.label,
        timestamp: step.createdAt || step.timestamp || null
      });
      currentProfile = nextProfile;
    }
    hasEstablishedTier = true;
  }

  return {
    activeEffortProfile: currentProfile,
    effortHistory
  };
}

/**
 * 4-Tier Untruncated Log Resolver
 * Tier 1: transcript_full.jsonl
 * Tier 2: chunks/transcript_full/*.jsonl
 * Tier 3: transcript.jsonl + steps/<idx>/output.txt hydration
 * Tier 4: chunks/transcript/*.jsonl
 */
export function resolveSessionLogs(sessionDir) {
  const logsDir = path.join(sessionDir, '.system_generated', 'logs');
  const stepsDir = path.join(sessionDir, '.system_generated', 'steps');

  // Tier 1
  const t1 = path.join(logsDir, 'transcript_full.jsonl');
  if (fs.existsSync(t1) && fs.statSync(t1).size > 0) {
    return { tier: 1, type: 'single', path: t1 };
  }

  // Tier 2
  const t2Dir = path.join(logsDir, 'chunks', 'transcript_full');
  if (fs.existsSync(t2Dir)) {
    const chunkFiles = fs.readdirSync(t2Dir)
      .filter(f => f.endsWith('.jsonl'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
        const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
        return numA - numB;
      })
      .map(f => path.join(t2Dir, f));
    if (chunkFiles.length > 0) {
      return { tier: 2, type: 'chunks', paths: chunkFiles };
    }
  }

  // Tier 3
  const t3 = path.join(logsDir, 'transcript.jsonl');
  if (fs.existsSync(t3) && fs.statSync(t3).size > 0) {
    return { tier: 3, type: 'hydrated', path: t3, stepsDir };
  }

  // Tier 4
  const t4Dir = path.join(logsDir, 'chunks', 'transcript');
  if (fs.existsSync(t4Dir)) {
    const chunkFiles = fs.readdirSync(t4Dir)
      .filter(f => f.endsWith('.jsonl'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
        const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
        return numA - numB;
      })
      .map(f => path.join(t4Dir, f));
    if (chunkFiles.length > 0) {
      return { tier: 4, type: 'chunks', paths: chunkFiles };
    }
  }

  return null;
}

/**
 * Parses raw JSONL lines into structured step records.
 * Hydrates steps/<idx>/output.txt when tier is 3 and truncated_fields is present.
 */
export function parseRawJsonl(content, { tier = 1, stepsDir = null, withHealth = false } = {}) {
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  const steps = [];
  let malformedLines = 0;
  let unknownShapeLines = 0;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      malformedLines++;
      continue;
    }

    // Check recognizable Antigravity/Agent log shape
    const hasIdx = entry.step_index !== undefined || entry.stepIndex !== undefined;
    const hasType = typeof entry.type === 'string' || entry.step_type !== undefined || entry.stepType !== undefined;
    const hasContent = entry.content !== undefined;
    const hasRole = typeof entry.role === 'string';
    const hasCalls = Array.isArray(entry.tool_calls) || Array.isArray(entry.toolCalls);
    if (!hasIdx && !hasType && !hasContent && !hasRole && !hasCalls) {
      unknownShapeLines++;
      continue;
    }

    try {
      const stepIdx = entry.step_index ?? entry.stepIndex ?? steps.length;
      let rawContent = entry.content || '';
      let isTruncated = Array.isArray(entry.truncated_fields) && entry.truncated_fields.length > 0;

      // Tier 3 Hydration check
      if (isTruncated && stepsDir) {
        const outputTxtPath = path.join(stepsDir, String(stepIdx), 'output.txt');
        if (fs.existsSync(outputTxtPath)) {
          try {
            rawContent = fs.readFileSync(outputTxtPath, 'utf8');
            isTruncated = false;
          } catch {
            // retain rawContent
          }
        }
      }

      const turnMetadata = extractTurnEffortMetadata({ ...entry, content: rawContent });
      const usage = entry.usage || entry.token_usage || {};
      const cacheReadTokens = Number(
        entry.cache_read_input_tokens ??
        entry.cacheReadInputTokens ??
        usage.cache_read_input_tokens ??
        usage.cached_content_token_count ??
        0
      );
      const cacheCreationTokens = Number(
        entry.cache_creation_input_tokens ??
        entry.cacheCreationInputTokens ??
        usage.cache_creation_input_tokens ??
        0
      );
      const thinkingTokens = Number(
        entry.thinking_tokens ??
        entry.thinkingTokens ??
        usage.thinking_tokens ??
        usage.thoughts_token_count ??
        (entry.thinking ? Math.ceil(String(entry.thinking).length / 4) : 0)
      );
      const rawSubagentId = entry.subagent_id || entry.subagentId || entry.agent_id || entry.agentId || null;
      const agentId = rawSubagentId && rawSubagentId !== 'parent' && rawSubagentId !== 'main'
        ? (String(rawSubagentId).startsWith('child:') ? String(rawSubagentId) : `child:${rawSubagentId}`)
        : 'parent';

      const rawStepType = entry.step_type ?? entry.stepType ?? null;
      const isCortexCheckpoint =
        Number(rawStepType) === 23 ||
        rawStepType === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
        entry.type === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
        entry.type === 'CHECKPOINT';

      steps.push({
        stepIndex: stepIdx,
        agentId,
        source: entry.source || 'MODEL',
        type: isCortexCheckpoint ? 'CHECKPOINT' : (entry.type || 'PLANNER_RESPONSE'),
        ...(rawStepType !== null ? { stepType: rawStepType, step_type: rawStepType } : (isCortexCheckpoint ? { stepType: 23, step_type: 23 } : {})),
        status: entry.status || 'DONE',
        createdAt: entry.created_at || entry.createdAt || entry.timestamp || null,
        toolCalls: entry.tool_calls || entry.toolCalls || [],
        content: rawContent,
        inputTokens: entry.input_tokens || entry.inputTokens || usage.input_tokens || 0,
        outputTokens: entry.output_tokens || entry.outputTokens || usage.output_tokens || 0,
        cacheReadTokens,
        cacheCreationTokens,
        thinkingTokens,
        untruncatedLength: rawContent.length,
        isTruncated,
        ...(turnMetadata ? { turnMetadata } : {})
      });
    } catch {
      malformedLines++;
    }
  }

  const totalLines = lines.length;
  const parsedLines = steps.length;
  let confidence = 'HIGH';
  if (totalLines > 0) {
    const badFraction = (malformedLines + unknownShapeLines) / totalLines;
    if (parsedLines === 0 || badFraction > 0.15) {
      confidence = 'LOW';
    } else if (badFraction > 0.02) {
      confidence = 'DEGRADED';
    }
  }

  const health = {
    totalLines,
    parsedLines,
    malformedLines,
    unknownShapeLines,
    confidence
  };

  Object.defineProperty(steps, 'health', {
    value: health,
    enumerable: false,
    writable: true,
    configurable: true
  });

  if (withHealth) {
    return { steps, health };
  }

  return steps;
}

/**
 * Helper to get the real last-activity timestamp of a session folder on Windows
 * (checks transcript logs inside .system_generated/logs rather than just folder mtime)
 */
function getRealSessionMtimeMs(sessionDir) {
  let maxMtime = 0;
  try {
    maxMtime = fs.statSync(sessionDir).mtimeMs;
  } catch {
    return 0;
  }
  const candidates = [
    path.join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl'),
    path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl')
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const m = fs.statSync(c).mtimeMs;
        if (m > maxMtime) maxMtime = m;
      }
    } catch {}
  }
  return maxMtime;
}

/**
 * Finds the active session directory across all three Antigravity brain stores
 * (Desktop 2.0 [App], Standalone IDE Fork [IDE], and CLI [CLI]).
 */
export function findSessionDirectory(sessionId, homeDir = getHomeDir()) {
  const stores = getBrainStores(homeDir);
  if (sessionId) {
    for (const store of stores) {
      const target = path.join(store.path, sessionId);
      if (fs.existsSync(target)) {
        return {
          storeName: store.name,
          surfaceTag: store.surfaceTag || resolveSurfaceTag(store.name),
          sessionDir: target,
          sessionId
        };
      }
    }
    // Check if a conversations/<sessionId>.db exists in any surface even if brain/<sessionId> is not yet created
    const surfaces = getAntigravitySurfaces(homeDir, { includeMissing: true });
    for (const surface of surfaces) {
      const dbFile = path.join(surface.conversationsDir, `${sessionId}.db`);
      if (fs.existsSync(dbFile)) {
        return {
          storeName: surface.name,
          surfaceTag: surface.surfaceTag || resolveSurfaceTag(surface.name),
          sessionDir: path.join(surface.brainDir, sessionId),
          dbPath: dbFile,
          sessionId
        };
      }
    }
  }

  // Fallback to most recently active session based on real transcript log mtime
  let latest = null;
  for (const store of stores) {
    try {
      const entries = fs.readdirSync(store.path);
      for (const name of entries) {
        const full = path.join(store.path, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            const realMtime = getRealSessionMtimeMs(full);
            if (!latest || realMtime > latest.mtimeMs) {
              latest = {
                storeName: store.name,
                surfaceTag: store.surfaceTag || resolveSurfaceTag(store.name),
                sessionDir: full,
                sessionId: name,
                mtimeMs: realMtime
              };
            }
          }
        } catch {}
      }
    } catch {}
  }

  return latest;
}

const genMetaMemo = new Map();

/**
 * Reads exact token telemetry (input_tokens + cache_read_tokens) and mid-run Prefix Bust
 * events from a session's conversations/<uuid>.db SQLite store (gen_metadata table) in strict read-only mode.
 */
export function readSessionGenMetadataSync(dbPath, DatabaseSyncClass = null) {
  if (!dbPath || !fs.existsSync(dbPath) || !DatabaseSyncClass) return null;
  let sig = '';
  try {
    const st = fs.statSync(dbPath);
    sig = `${dbPath}|${st.mtimeMs}|${st.size}`;
    if (genMetaMemo.has(sig)) return genMetaMemo.get(sig);
  } catch {
    return null;
  }
  let db = null;
  try {
    db = new DatabaseSyncClass(dbPath, SQLITE_OPEN_READONLY_OPTIONS);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gen_metadata'").all();
    if (!tables || tables.length === 0) return null;

    const rows = db.prepare(
      'SELECT input_tokens, cache_read_tokens, output_tokens, model, created_at FROM gen_metadata ORDER BY rowid DESC LIMIT 10'
    ).all();
    if (!rows || rows.length === 0) return null;

    let turnCount = rows.length;
    try {
      const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM gen_metadata').get();
      if (countRow && Number(countRow.cnt) > 0) turnCount = Number(countRow.cnt);
    } catch {}

    const row = rows[0];
    const prevRow = rows[1] || null;
    const inputTokens = Number(row.input_tokens || 0);
    const cacheReadTokens = Number(row.cache_read_tokens || 0);
    const outputTokens = Number(row.output_tokens || 0);

    let prefixBustDetected = false;
    let prefixBustDeltaSec = null;
    const prevCacheRead = Number(prevRow?.cache_read_tokens || 0);
    const modelChanged = Boolean(prevRow?.model && row?.model && prevRow.model !== row.model);
    if (prevRow && cacheReadTokens === 0 && inputTokens > 0 && (prevCacheRead > 0 || modelChanged)) {
      const currMs = row.created_at ? Date.parse(row.created_at) : NaN;
      const prevMs = prevRow.created_at ? Date.parse(prevRow.created_at) : NaN;
      if (Number.isFinite(currMs) && Number.isFinite(prevMs) && currMs >= prevMs) {
        const deltaSec = (currMs - prevMs) / 1000;
        if (deltaSec < 300) {
          prefixBustDetected = true;
          prefixBustDeltaSec = Math.round(deltaSec);
        }
      }
    }

    const recentTurns = rows.slice().reverse().map((r, idx) => ({
      stepIndex: idx,
      inputTokens: Number(r.input_tokens || 0),
      cacheReadTokens: Number(r.cache_read_tokens || 0),
      outputTokens: Number(r.output_tokens || 0),
      model: r.model || null,
      createdAt: r.created_at || null
    }));

    const result = {
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalContextTokens: inputTokens + cacheReadTokens,
      turnCount,
      model: row.model || null,
      createdAt: row.created_at || null,
      prefixBustDetected,
      prefixBustDeltaSec,
      recentTurns,
      // Attribute a bust to a model switch when gen_metadata shows one.
      prefixBustCause: (prefixBustDetected && modelChanged)
        ? { cause: 'model_switch', from: prevRow.model, to: row.model }
        : null
    };
    if (sig) {
      if (genMetaMemo.size > 64) genMetaMemo.clear();
      genMetaMemo.set(sig, result);
    }
    return result;
  } catch {
    return null;
  } finally {
    try { if (db && typeof db.close === 'function') db.close(); } catch {}
  }
}

const incrementalMemCache = new Map();

/**
 * Reads transcript incrementally using byte offsets and inode cache
 */
export function parseTranscriptIncremental(sessionDir, cacheDir = null) {
  const resolved = resolveSessionLogs(sessionDir);
  if (!resolved) {
    return {
      tier: 0,
      steps: [],
      lastByteOffset: 0,
      activeEffortProfile: { ...EFFORT_PROFILES.STANDARD },
      effortHistory: [],
      effortTransitions: []
    };
  }

  // If chunks or multiple files, do a full read of chunks
  if (resolved.type === 'chunks') {
    let allContent = '';
    for (const p of resolved.paths) {
      allContent += fs.readFileSync(p, 'utf8') + '\n';
    }
    const steps = parseRawJsonl(allContent, { tier: resolved.tier });
    const effortInfo = extractEffortTimeline(steps);
    return {
      tier: resolved.tier,
      steps,
      filePath: resolved.paths[resolved.paths.length - 1],
      activeEffortProfile: effortInfo.activeEffortProfile,
      effortHistory: effortInfo.effortHistory,
      effortTransitions: effortInfo.effortHistory
    };
  }

  const filePath = resolved.path;
  const stat = fs.statSync(filePath);
  const sessionId = path.basename(sessionDir);

  const defaultCacheDir = path.join(getHomeDir(), '.gemini', 'antigravity', 'cache', 'agy-horizon');
  const actualCacheDir = cacheDir || defaultCacheDir;
  const cacheFile = path.join(actualCacheDir, `${sessionId}.idx.json`);

  let cached = { lastByteOffset: 0, steps: [], mtimeMs: 0, schemaRev: 0 };
  let rewindDetected = false;
  const memCached = incrementalMemCache.get(cacheFile);
  if (memCached && memCached.filePath === filePath && fs.existsSync(cacheFile)) {
    if (memCached.lastByteOffset <= stat.size) {
      cached = memCached;
    } else {
      rewindDetected = true;
    }
  } else if (fs.existsSync(cacheFile)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cachedData.schemaRev === 2 && cachedData.filePath === filePath) {
        if (cachedData.lastByteOffset <= stat.size) {
          cached = cachedData;
          incrementalMemCache.set(cacheFile, cachedData);
        } else {
          // File shrank due to IDE Undo/Rewind or surgical prune
          rewindDetected = true;
        }
      }
    } catch {}
  }

  if (cached.lastByteOffset === stat.size && cached.schemaRev === 2) {
    const effortInfo = cached.effortInfo || extractEffortTimeline(cached.steps);
    return {
      tier: resolved.tier,
      steps: cached.steps,
      filePath,
      rewindDetected: false,
      activeEffortProfile: effortInfo.activeEffortProfile,
      effortHistory: effortInfo.effortHistory,
      effortTransitions: effortInfo.effortHistory
    };
  }

  // Read newly appended slice
  const fd = fs.openSync(filePath, 'r');
  const bytesToRead = stat.size - cached.lastByteOffset;
  const buffer = Buffer.alloc(bytesToRead);
  fs.readSync(fd, buffer, 0, bytesToRead, cached.lastByteOffset);
  fs.closeSync(fd);

  const newContent = buffer.toString('utf8');
  const newSteps = parseRawJsonl(newContent, { tier: resolved.tier, stepsDir: resolved.stepsDir });

  // Detect non-monotonic stepIndex regression on parent stream (Undo/Rewind)
  const prevParentSteps = (cached.steps || []).filter(s => !s?.agentId || s.agentId === 'parent');
  const newParentSteps = newSteps.filter(s => !s?.agentId || s.agentId === 'parent');
  let allSteps = [...(cached.steps || []), ...newSteps];

  if (
    prevParentSteps.length > 0 &&
    newParentSteps.length > 0 &&
    newParentSteps[0].stepIndex <= prevParentSteps[prevParentSteps.length - 1].stepIndex
  ) {
    rewindDetected = true;
    const rollbackIdx = newParentSteps[0].stepIndex;
    const retained = (cached.steps || []).filter(s => (s.agentId && s.agentId !== 'parent') || s.stepIndex < rollbackIdx);
    allSteps = [...retained, ...newSteps];
  }
  const effortInfo = extractEffortTimeline(allSteps);

  const updatedCachePayload = {
    schemaRev: 2,
    filePath,
    sessionId,
    lastByteOffset: stat.size,
    mtimeMs: stat.mtimeMs,
    steps: allSteps
  };
  if (incrementalMemCache.size > 24) incrementalMemCache.clear();
  incrementalMemCache.set(cacheFile, { ...updatedCachePayload, effortInfo });

  // Save updated cache
  try {
    if (!fs.existsSync(actualCacheDir)) {
      fs.mkdirSync(actualCacheDir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(updatedCachePayload), 'utf8');
  } catch {}

  return {
    tier: resolved.tier,
    steps: allSteps,
    filePath,
    rewindDetected,
    activeEffortProfile: effortInfo.activeEffortProfile,
    effortHistory: effortInfo.effortHistory,
    effortTransitions: effortInfo.effortHistory
  };
}

/**
 * Reconciles session with conversation_summaries.db, multi-store conversations/*.db,
 * and Knowledge Items for foreign bleed detection across [App], [IDE], and [CLI].
 */
export async function reconcileWorkspaceAndKIs(sessionId, homeDir = getHomeDir(), dbOverride = null) {
  let workspaceUris = [];
  let projectId = '';
  let sessionTitle = '';
  let sessionSurface = 'antigravity';
  let sessionSurfaceTag = '[App]';
  let recentSessions = [];
  let sessionGenMetadata = null;
  const canonicalWorkspaceSet = new Set();

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const surfaces = getAntigravitySurfaces(homeDir, { includeMissing: true });
    const discoveredMap = new Map();

    const upsertDiscoveredSession = (sid, candidate) => {
      if (!sid || !candidate) return;
      if (!discoveredMap.has(sid)) {
        discoveredMap.set(sid, candidate);
        return;
      }
      const existing = discoveredMap.get(sid);
      const existingMod = String(existing.lastModified || '');
      const candidateMod = String(candidate.lastModified || '');
      const preferCandidate = candidateMod.localeCompare(existingMod) > 0;
      const primary = preferCandidate ? candidate : existing;
      const secondary = preferCandidate ? existing : candidate;
      const defaultPrefix = sid.slice(0, 8);
      const bestTitle = (primary.title && primary.title !== defaultPrefix)
        ? primary.title
        : (secondary.title || primary.title || defaultPrefix);

      discoveredMap.set(sid, {
        ...secondary,
        ...primary,
        title: bestTitle,
        stepCount: Math.max(Number(existing.stepCount || 0), Number(candidate.stepCount || 0)),
        workspace: primary.workspace || secondary.workspace || '',
        liveTokens: primary.liveTokens || secondary.liveTokens,
        cacheReadTokens: primary.cacheReadTokens ?? secondary.cacheReadTokens
      });
    };

    const processSummaryDb = (dbInstance, surfaceDesc) => {
      if (!dbInstance) return;
      if (sessionId) {
        try {
          const row = dbInstance.prepare('SELECT title, workspace_uris, project_id FROM conversation_summaries WHERE conversation_id = ?').get(sessionId);
          if (row && !sessionTitle) {
            sessionTitle = row.title || '';
            projectId = row.project_id || '';
            sessionSurface = surfaceDesc.name;
            sessionSurfaceTag = surfaceDesc.surfaceTag;
            try {
              workspaceUris = JSON.parse(row.workspace_uris || '[]');
            } catch {
              workspaceUris = row.workspace_uris ? [row.workspace_uris] : [];
            }
          }
        } catch {}
      }
      try {
        const recentRows = dbInstance.prepare('SELECT conversation_id, title, step_count, workspace_uris, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = \'\' ORDER BY last_modified_time DESC LIMIT 12').all();
        for (const r of recentRows) {
          let ws = '';
          try {
            const parsed = JSON.parse(r.workspace_uris || '[]');
            ws = canonicalizePath(parsed[0] || '');
          } catch {}
          const sid = r.conversation_id;
          const convDbPath = path.join(surfaceDesc.conversationsDir, `${sid}.db`);
          const genMeta = readSessionGenMetadataSync(convDbPath, DatabaseSync);
          if (sessionId && sid === sessionId && genMeta && !sessionGenMetadata) {
            sessionGenMetadata = genMeta;
          }
          upsertDiscoveredSession(sid, {
            sessionId: sid,
            title: r.title || sid.slice(0, 8),
            stepCount: Math.max(Number(r.step_count || 0), Number(genMeta?.turnCount || 0)),
            workspace: ws ? path.basename(ws) : '',
            lastModified: r.last_modified_time,
            surface: surfaceDesc.name,
            surfaceTag: surfaceDesc.surfaceTag,
            brainDir: path.join(surfaceDesc.brainDir, sid),
            ...(genMeta && genMeta.totalContextTokens > 0 ? {
              liveTokens: genMeta.totalContextTokens,
              cacheReadTokens: genMeta.cacheReadTokens
            } : {})
          });
        }
      } catch {}
    };

    if (dbOverride) {
      processSummaryDb(dbOverride, surfaces[0]);
    } else {
      for (const surface of surfaces) {
        if (fs.existsSync(surface.summariesDbPath)) {
          let db = null;
          try {
            db = new DatabaseSync(surface.summariesDbPath, SQLITE_OPEN_READONLY_OPTIONS);
            processSummaryDb(db, surface);
          } catch {} finally {
            try { if (db && typeof db.close === 'function') db.close(); } catch {}
          }
        }

        // Also inspect per-conversation SQLite stores: ~/.gemini/<surface>/conversations/*.db
        if (fs.existsSync(surface.conversationsDir)) {
          try {
            const dbCandidates = fs.readdirSync(surface.conversationsDir)
              .filter(f => f.endsWith('.db'))
              .map(file => {
                const sid = file.replace(/\.db$/i, '');
                const fullDbPath = path.join(surface.conversationsDir, file);
                let mtimeMs = 0;
                try { mtimeMs = fs.statSync(fullDbPath).mtimeMs; } catch {}
                return { file, sid, fullDbPath, mtimeMs };
              })
              .sort((a, b) => b.mtimeMs - a.mtimeMs);
            const topDbCandidates = dbCandidates.slice(0, 12);
            if (sessionId && !topDbCandidates.some(c => c.sid === sessionId)) {
              const targetEntry = dbCandidates.find(c => c.sid === sessionId);
              if (targetEntry) topDbCandidates.push(targetEntry);
            }
            for (const { sid, fullDbPath, mtimeMs } of topDbCandidates) {
              const genMeta = readSessionGenMetadataSync(fullDbPath, DatabaseSync);
              if (sessionId && sid === sessionId && genMeta && !sessionGenMetadata) {
                sessionGenMetadata = genMeta;
              }
              if (sessionId && sid === sessionId && workspaceUris.length === 0) {
                try {
                  const pbtxtPath = path.join(path.dirname(surface.conversationsDir), 'annotations', `${sid}.pbtxt`);
                  const stitched = await stitchAntigravityCliTrajectory(fullDbPath, {
                    sessionId: sid,
                    pbtxtPath,
                    DatabaseSync
                  });
                  if (stitched.workspaceUri) workspaceUris.push(stitched.workspaceUri);
                  if (stitched.title && !sessionTitle) sessionTitle = stitched.title;
                } catch {}
              }
              const mtimeIso = mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '';
              upsertDiscoveredSession(sid, {
                sessionId: sid,
                title: sid.slice(0, 8),
                stepCount: Number(genMeta?.turnCount || 0),
                workspace: '',
                lastModified: mtimeIso,
                surface: surface.name,
                surfaceTag: surface.surfaceTag,
                brainDir: path.join(surface.brainDir, sid),
                ...(genMeta && genMeta.totalContextTokens > 0 ? {
                  liveTokens: genMeta.totalContextTokens,
                  cacheReadTokens: genMeta.cacheReadTokens
                } : {})
              });
            }
          } catch {}
        }
      }
    }

    recentSessions = Array.from(discoveredMap.values())
      .filter(s => s.sessionId === sessionId || Number(s.stepCount || 0) > 0)
      .sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')))
      .slice(0, 12);
  } catch {
    // SQLite lookup failure is non-fatal
  }

  for (const uri of workspaceUris) {
    const canon = canonicalizePath(uri);
    if (canon) canonicalWorkspaceSet.add(canon);
  }

  // Also check project json if projectId is present
  if (projectId && projectId !== 'outside-of-project') {
    const projFile = path.join(homeDir, '.gemini', 'config', 'projects', `${projectId}.json`);
    if (fs.existsSync(projFile)) {
      try {
        const projData = JSON.parse(fs.readFileSync(projFile, 'utf8'));
        const resources = projData.projectResources?.resources || [];
        for (const res of resources) {
          if (res.folderUri) {
            const canon = canonicalizePath(res.folderUri);
            if (canon) canonicalWorkspaceSet.add(canon);
          }
        }
      } catch {}
    }
  }

  // Reconcile KIs
  const kiBleedMap = new Map();
  const knowledgeDir = path.join(homeDir, '.gemini', 'antigravity', 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    try {
      const items = fs.readdirSync(knowledgeDir);
      for (const item of items) {
        const itemDir = path.join(knowledgeDir, item);
        const metaPath = path.join(itemDir, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const refs = meta.references || [];
            let isBleed = false;
            let foreignSources = [];

            for (const ref of refs) {
              if (ref.type === 'file') {
                const canon = canonicalizePath(ref.value);
                // Check if reference belongs to any canonical workspace
                const matches = Array.from(canonicalWorkspaceSet).some(w => canon.startsWith(w));
                if (!matches && canonicalWorkspaceSet.size > 0) {
                  isBleed = true;
                  foreignSources.push(ref.value);
                }
              }
            }

            kiBleedMap.set(item, {
              title: meta.title || item,
              isBleed,
              foreignSources
            });
          } catch {}
        }
      }
    } catch {}
  }

  return {
    sessionTitle,
    sessionSurface,
    sessionSurfaceTag,
    recentSessions,
    workspaceUris,
    projectId,
    canonicalWorkspaceSet,
    primaryWorkspace: Array.from(canonicalWorkspaceSet)[0] || '',
    kiBleedMap,
    // Read-only gen_metadata for the requested session (model, last-turn cache counters, bust cause).
    sessionGenMetadata
  };
}
