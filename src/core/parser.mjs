import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  canonicalizePath,
  getHomeDir,
  getBrainStores,
  getAntigravitySurfaces,
  getClaudeCodeProjectsDir,
  getCursorWorkspaceStorageDirs
} from './paths.mjs';
import { EFFORT_PROFILES, resolveEffortProfile, resolveSurfaceTag, normalizeModelId } from './constants.mjs';
import { stitchAntigravityCliTrajectory, stitchClaudeCodeDag } from './trajectory_stitcher.mjs';

const require = createRequire(import.meta.url);
function getSqliteDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync || null;
  } catch {
    return null;
  }
}

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
export function extractEffortTimeline(steps = [], options = {}) {
  let currentProfile = { ...EFFORT_PROFILES.STANDARD };
  let hasEstablishedTier = false;
  let cumTokens = 0;
  const effortHistory = [];
  const maxTokens = Number(options?.maxTokens) > 0 ? Number(options.maxTokens) : 256000;
  const tokensPerCell = Math.max(1, Math.round(maxTokens / 40));

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx] || {};
    const stepTok = step.inputTokens > 0 && step.outputTokens > 0
      ? Math.max(step.outputTokens, Math.round((step.untruncatedLength || 0) / 4))
      : (step.outputTokens || Math.round((step.untruncatedLength || 0) / 4) || 1000);
    const estBlock = Math.min(39, Math.max(0, Math.floor(cumTokens / tokensPerCell)));
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
  if (!sessionDir || typeof sessionDir !== 'string') return null;

  // Support direct file paths for Claude Code (.jsonl) and Cursor (state.vscdb)
  try {
    if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isFile()) {
      if (sessionDir.toLowerCase().endsWith('.vscdb')) {
        return { tier: 1, type: 'cursor-vscdb', path: sessionDir };
      }
      if (sessionDir.toLowerCase().endsWith('.jsonl')) {
        return { tier: 1, type: 'claude-jsonl', path: sessionDir };
      }
    }
  } catch {}

  const vscdbCandidate = path.join(sessionDir, 'state.vscdb');
  if (fs.existsSync(vscdbCandidate)) {
    return { tier: 1, type: 'cursor-vscdb', path: vscdbCandidate };
  }

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
 * Discovers Claude Code sessions under ~/.claude/projects/<project>/<sid>.jsonl
 */
export function discoverClaudeCodeSessions(homeDir = getHomeDir()) {
  const projectsDir = getClaudeCodeProjectsDir(homeDir);
  if (!fs.existsSync(projectsDir)) return [];
  const sessions = [];
  const inspectJsonlFile = (fullPath, projectSlug = '') => {
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size === 0) return;
      const base = path.basename(fullPath);
      if (!base.endsWith('.jsonl') || base.startsWith('.')) return;
      const sessionId = base.replace(/\.jsonl$/i, '');
      sessions.push({
        storeName: 'claude-code',
        surface: 'claude-code',
        surfaceTag: '[Claude]',
        sessionDir: fullPath,
        filePath: fullPath,
        sessionId,
        projectSlug,
        mtimeMs: stat.mtimeMs
      });
    } catch {}
  };

  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(projectsDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        inspectJsonlFile(full, '');
      } else if (entry.isDirectory()) {
        try {
          const children = fs.readdirSync(full);
          for (const child of children) {
            if (child.endsWith('.jsonl')) {
              inspectJsonlFile(path.join(full, child), entry.name);
            }
          }
        } catch {}
      }
    }
  } catch {}

  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Discovers Cursor IDE sessions under workspaceStorage/<hash>/state.vscdb in strict read-only mode.
 */
export function discoverCursorSessions(homeDir = getHomeDir(), DatabaseSyncClass = null) {
  const storageDirs = getCursorWorkspaceStorageDirs(homeDir);
  if (storageDirs.length === 0) return [];
  const DbCtor = DatabaseSyncClass || getSqliteDatabaseSync();
  const sessions = [];

  for (const storageRoot of storageDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(storageRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsDir = path.join(storageRoot, entry.name);
      const vscdbPath = path.join(wsDir, 'state.vscdb');
      if (!fs.existsSync(vscdbPath)) continue;
      try {
        const stat = fs.statSync(vscdbPath);
        if (!stat.isFile() || stat.size === 0) continue;
        let composerId = null;
        let title = '';
        let bubbleCount = 0;
        let workspaceUri = '';

        const wsJsonPath = path.join(wsDir, 'workspace.json');
        if (fs.existsSync(wsJsonPath)) {
          try {
            const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
            workspaceUri = wsJson.folder || wsJson.workspace || '';
          } catch {}
        }

        if (DbCtor) {
          let db = null;
          try {
            db = new DbCtor(vscdbPath, SQLITE_OPEN_READONLY_OPTIONS);
            const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'").get();
            if (hasTable) {
              const compRow = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 1").get();
              if (compRow && compRow.key) {
                composerId = String(compRow.key).slice('composerData:'.length);
                try {
                  const val = typeof compRow.value === 'string' ? JSON.parse(compRow.value) : JSON.parse(Buffer.from(compRow.value).toString('utf8'));
                  title = val?.name || val?.title || '';
                } catch {}
              }
              const cntRow = db.prepare("SELECT COUNT(*) AS cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").get();
              bubbleCount = Number(cntRow?.cnt || 0);
            }
          } catch {} finally {
            try { if (db && typeof db.close === 'function') db.close(); } catch {}
          }
        }

        if (composerId || bubbleCount > 0) {
          const sid = composerId || `cursor-${entry.name}`;
          sessions.push({
            storeName: 'cursor',
            surface: 'cursor',
            surfaceTag: '[Cursor]',
            sessionDir: vscdbPath,
            filePath: vscdbPath,
            sessionId: sid,
            title: title || sid.slice(0, 8),
            stepCount: bubbleCount,
            workspaceUri,
            mtimeMs: stat.mtimeMs
          });
        }
      } catch {}
    }
  }

  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Finds the active session directory across Antigravity ([App], [IDE], [CLI]),
 * Claude Code ([Claude]), and Cursor ([Cursor]).
 */
export function findSessionDirectory(sessionId, homeDir = getHomeDir()) {
  const stores = getBrainStores(homeDir);
  if (sessionId) {
    if (fs.existsSync(sessionId)) {
      const isVscdb = sessionId.toLowerCase().endsWith('.vscdb') || fs.existsSync(path.join(sessionId, 'state.vscdb'));
      const isJsonl = sessionId.toLowerCase().endsWith('.jsonl');
      const storeName = isVscdb ? 'cursor' : (isJsonl ? 'claude-code' : 'antigravity');
      return {
        storeName,
        surfaceTag: resolveSurfaceTag(storeName),
        sessionDir: sessionId,
        sessionId: path.basename(sessionId).replace(/\.(jsonl|vscdb)$/i, '')
      };
    }
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
    // Check Claude Code sessions
    const claudeMatch = discoverClaudeCodeSessions(homeDir).find(s => s.sessionId === sessionId);
    if (claudeMatch) return claudeMatch;
    // Check Cursor sessions
    const cursorMatch = discoverCursorSessions(homeDir).find(s => s.sessionId === sessionId);
    if (cursorMatch) return cursorMatch;
  }

  // Fallback to most recently active session based on real transcript log mtime across all harnesses
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

  for (const claudeSess of discoverClaudeCodeSessions(homeDir)) {
    if (!latest || claudeSess.mtimeMs > latest.mtimeMs) {
      latest = claudeSess;
    }
  }

  for (const cursorSess of discoverCursorSessions(homeDir)) {
    if (!latest || cursorSess.mtimeMs > latest.mtimeMs) {
      latest = cursorSess;
    }
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
    if (prevRow && cacheReadTokens === 0 && inputTokens > 0 && prevCacheRead > 0) {
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
 * Parses a Claude Code JSONL transcript using stitchClaudeCodeDag() to reconstruct
 * active branch steps, /rewind branches, and exact prompt-cache usage telemetry.
 */
export function parseClaudeCodeJsonl(rawContent = '') {
  const dag = stitchClaudeCodeDag(rawContent);
  const steps = [];
  const usageTurns = [];
  let sessionTitle = '';
  let workspacePath = '';
  let latestModel = null;

  for (let i = 0; i < dag.activeBranchSteps.length; i++) {
    const node = dag.activeBranchSteps[i];
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'file-history-snapshot' && !node.message && !node.content) {
      continue;
    }
    if (node.cwd && !workspacePath) {
      workspacePath = String(node.cwd);
    }

    const msg = node.message && typeof node.message === 'object' ? node.message : null;
    const role = String(msg?.role || node.role || node.type || '').toLowerCase();
    const isUser = role === 'user' || node.type === 'USER_INPUT' || node.source === 'USER_EXPLICIT';
    const isSummary = role === 'summary' || node.type === 'summary' || node.type === 'CHECKPOINT';

    const toolCalls = Array.isArray(node.tool_calls)
      ? [...node.tool_calls]
      : (Array.isArray(node.toolCalls) ? [...node.toolCalls] : []);
    const textParts = [];
    let thinkingText = String(node.thinking || '');

    const rawMsgContent = msg?.content ?? node.content;
    if (typeof rawMsgContent === 'string') {
      textParts.push(rawMsgContent);
    } else if (Array.isArray(rawMsgContent)) {
      for (const block of rawMsgContent) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) {
          textParts.push(String(block.text));
        } else if (block.type === 'thinking' && block.thinking) {
          thinkingText += (thinkingText ? '\n' : '') + String(block.thinking);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            name: block.name || 'tool_use',
            args: block.input || block.args || {}
          });
        } else if (block.type === 'tool_result') {
          const resContent = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.map(c => c?.text || '').join('\n')
              : JSON.stringify(block.content || ''));
          if (resContent) textParts.push(resContent);
        }
      }
    }

    const content = textParts.join('\n').trim();
    if (isUser && content && !sessionTitle) {
      sessionTitle = content.split(/\r?\n/)[0].slice(0, 64);
    }

    const usage = msg?.usage || node.usage || node.token_usage || {};
    const inputTokens = Number(
      node.input_tokens ??
      node.inputTokens ??
      usage.input_tokens ??
      0
    );
    const outputTokens = Number(
      node.output_tokens ??
      node.outputTokens ??
      usage.output_tokens ??
      0
    );
    const cacheReadTokens = Number(
      node.cache_read_input_tokens ??
      node.cacheReadInputTokens ??
      usage.cache_read_input_tokens ??
      usage.cached_content_token_count ??
      0
    );
    const cacheCreationTokens = Number(
      node.cache_creation_input_tokens ??
      node.cacheCreationInputTokens ??
      usage.cache_creation_input_tokens ??
      0
    );
    const thinkingTokens = Number(
      node.thinking_tokens ??
      node.thinkingTokens ??
      usage.thinking_tokens ??
      (thinkingText ? Math.ceil(thinkingText.length / 4) : 0)
    );
    const model = msg?.model || node.model || null;
    if (model) latestModel = model;
    const createdAt = node.timestamp || node.created_at || node.createdAt || null;

    if (inputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0 || outputTokens > 0) {
      usageTurns.push({
        stepIndex: steps.length,
        inputTokens: inputTokens + cacheCreationTokens,
        cacheReadTokens,
        outputTokens,
        model: model || latestModel,
        createdAt
      });
    }

    const turnMetadata = extractTurnEffortMetadata({ ...node, model: model || undefined, content });
    steps.push({
      stepIndex: steps.length,
      agentId: 'parent',
      source: isUser ? 'USER_EXPLICIT' : (isSummary ? 'SYSTEM' : 'MODEL'),
      type: isSummary ? 'CHECKPOINT' : (isUser ? 'USER_INPUT' : 'PLANNER_RESPONSE'),
      ...(isSummary ? { stepType: 23, step_type: 23 } : {}),
      status: 'DONE',
      createdAt,
      toolCalls,
      content,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      thinkingTokens,
      untruncatedLength: content.length,
      isTruncated: false,
      ...(turnMetadata ? { turnMetadata } : {})
    });
  }

  if (steps.length > 0 && dag.inferredSystemPromptTokens > 0 && steps[0].inputTokens < dag.inferredSystemPromptTokens) {
    steps[0].inputTokens += dag.inferredSystemPromptTokens;
  }

  let genMetadata = null;
  if (usageTurns.length > 0) {
    const last = usageTurns[usageTurns.length - 1];
    const prev = usageTurns.length > 1 ? usageTurns[usageTurns.length - 2] : null;
    let prefixBustDetected = false;
    let prefixBustDeltaSec = null;
    if (prev && last.cacheReadTokens === 0 && last.inputTokens > 0 && prev.cacheReadTokens > 0) {
      const currMs = last.createdAt ? Date.parse(last.createdAt) : NaN;
      const prevMs = prev.createdAt ? Date.parse(prev.createdAt) : NaN;
      if (Number.isFinite(currMs) && Number.isFinite(prevMs) && currMs >= prevMs) {
        const deltaSec = (currMs - prevMs) / 1000;
        if (deltaSec < 300) {
          prefixBustDetected = true;
          prefixBustDeltaSec = Math.round(deltaSec);
        }
      }
    }
    const userTurnCount = steps.filter(s => s.type === 'USER_INPUT').length || usageTurns.length;
    genMetadata = {
      inputTokens: last.inputTokens,
      cacheReadTokens: last.cacheReadTokens,
      outputTokens: last.outputTokens,
      totalContextTokens: last.inputTokens + last.cacheReadTokens,
      turnCount: userTurnCount,
      model: last.model || latestModel || 'claude-sonnet-4-5',
      createdAt: last.createdAt || new Date().toISOString(),
      prefixBustDetected,
      prefixBustDeltaSec,
      recentTurns: usageTurns.slice(-10),
      prefixBustCause: null
    };
  }

  return {
    steps,
    claudeDag: dag,
    rewindDetected: dag.rewindBranches.length > 0,
    genMetadata,
    sessionTitle,
    workspacePath
  };
}

/**
 * Parses a Cursor state.vscdb SQLite file in strict read-only mode (SQLITE_OPEN_READONLY_OPTIONS).
 */
export function parseCursorVscdbSync(vscdbPath, DatabaseSyncClass = null) {
  const DbCtor = DatabaseSyncClass || getSqliteDatabaseSync();
  if (!DbCtor || !vscdbPath || !fs.existsSync(vscdbPath)) {
    return { steps: [], genMetadata: null, sessionTitle: '', workspacePath: '' };
  }
  let db = null;
  const steps = [];
  let sessionTitle = '';
  let workspacePath = '';
  let composerId = null;
  let modelName = 'claude-sonnet-4-5';

  try {
    const wsJsonPath = path.join(path.dirname(vscdbPath), 'workspace.json');
    if (fs.existsSync(wsJsonPath)) {
      const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
      workspacePath = wsJson.folder || wsJson.workspace || '';
    }
  } catch {}

  try {
    db = new DbCtor(vscdbPath, SQLITE_OPEN_READONLY_OPTIONS);
    const kvRows = db.prepare('SELECT key, value FROM cursorDiskKV').all();
    const bubbles = [];
    for (const row of (kvRows || [])) {
      const key = String(row.key || '');
      let val = row.value;
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch {}
      } else if (Buffer.isBuffer(val)) {
        try { val = JSON.parse(val.toString('utf8')); } catch {}
      }
      if (key.startsWith('composerData:')) {
        const cid = key.slice('composerData:'.length);
        if (!composerId) composerId = cid;
        if (val?.name || val?.title) sessionTitle = String(val.name || val.title);
        if (val?.model || val?.modelName) modelName = String(val.model || val.modelName);
      } else if (key.startsWith('bubbleId:')) {
        const parts = key.split(':');
        const cid = parts[1] || '';
        if (!composerId || cid === composerId) {
          bubbles.push({
            composerId: cid,
            bubbleId: parts[2] || '',
            val: val || {}
          });
        }
      }
    }

    let totalInputTok = 0;
    let totalCacheReadTok = 0;
    const recentTurns = [];

    for (let idx = 0; idx < bubbles.length; idx++) {
      const b = bubbles[idx].val;
      const isUser = b.type === 1 || b.role === 'user';
      const content = String(b.text || b.rawText || b.content || '');
      if (isUser && content && !sessionTitle) {
        sessionTitle = content.split(/\r?\n/)[0].slice(0, 64);
      }
      if (b.model || b.modelName) modelName = String(b.model || b.modelName);

      const toolCalls = [];
      const tfList = Array.isArray(b.toolFormerData)
        ? b.toolFormerData
        : (b.toolFormerData && typeof b.toolFormerData === 'object' ? [b.toolFormerData] : []);
      for (const tf of tfList) {
        let args = tf.params || tf.args || tf.input || {};
        if (typeof tf.rawArgs === 'string') {
          try { args = JSON.parse(tf.rawArgs); } catch {}
        }
        toolCalls.push({
          name: tf.name || tf.toolName || 'read_file',
          args: typeof args === 'object' && args ? args : {}
        });
      }

      const inputTokens = Number(b.inputTokens ?? b.tokenCount?.inputTokens ?? (idx === 0 ? 12000 : 0));
      const outputTokens = Number(b.outputTokens ?? b.tokenCount?.outputTokens ?? Math.max(250, Math.ceil(content.length / 4)));
      const cacheReadTokens = Number(b.cacheReadTokens ?? b.tokenCount?.cacheReadTokens ?? (idx > 0 ? 54000 : 0));
      const createdAt = b.createdAt || b.timingInfo?.clientStartTime || new Date().toISOString();

      totalInputTok = inputTokens > 0 ? inputTokens : 8000;
      if (cacheReadTokens > 0) totalCacheReadTok = cacheReadTokens;

      recentTurns.push({
        stepIndex: idx,
        inputTokens: totalInputTok,
        cacheReadTokens: totalCacheReadTok,
        outputTokens,
        model: modelName,
        createdAt
      });

      steps.push({
        stepIndex: idx,
        agentId: 'parent',
        source: isUser ? 'USER_EXPLICIT' : 'MODEL',
        type: isUser ? 'USER_INPUT' : 'PLANNER_RESPONSE',
        status: 'DONE',
        createdAt,
        toolCalls,
        content,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        thinkingTokens: 0,
        untruncatedLength: content.length,
        isTruncated: false
      });
    }

    const userTurns = steps.filter(s => s.type === 'USER_INPUT').length || steps.length;
    const genMetadata = steps.length > 0 ? {
      inputTokens: totalInputTok,
      cacheReadTokens: totalCacheReadTok,
      outputTokens: steps[steps.length - 1].outputTokens || 500,
      totalContextTokens: totalInputTok + totalCacheReadTok,
      turnCount: userTurns,
      model: modelName,
      createdAt: steps[steps.length - 1].createdAt || new Date().toISOString(),
      prefixBustDetected: false,
      prefixBustDeltaSec: null,
      recentTurns: recentTurns.slice(-10),
      prefixBustCause: null
    } : null;

    return {
      steps,
      genMetadata,
      sessionTitle,
      workspacePath
    };
  } catch {
    return { steps: [], genMetadata: null, sessionTitle: '', workspacePath: '' };
  } finally {
    try { if (db && typeof db.close === 'function') db.close(); } catch {}
  }
}

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

  // Claude Code JSONL (DAG with parentUuid, /rewind, and cache_read_input_tokens)
  if (resolved.type === 'claude-jsonl') {
    const rawContent = fs.readFileSync(resolved.path, 'utf8');
    // Detect whether this JSONL is Claude Code format (has parentUuid, message.usage, or type user/assistant) vs Antigravity raw JSONL
    const isClaudeFormat = /"parentUuid"|"cache_read_input_tokens"|"cache_creation_input_tokens"|"leafUuid"|"role"\s*:\s*"(?:user|assistant)"/.test(rawContent);
    if (isClaudeFormat) {
      const parsedClaude = parseClaudeCodeJsonl(rawContent);
      const effortInfo = extractEffortTimeline(parsedClaude.steps);
      return {
        tier: resolved.tier,
        steps: parsedClaude.steps,
        filePath: resolved.path,
        rewindDetected: parsedClaude.rewindDetected,
        claudeDag: parsedClaude.claudeDag,
        genMetadata: parsedClaude.genMetadata,
        sessionTitle: parsedClaude.sessionTitle,
        workspacePath: parsedClaude.workspacePath,
        activeEffortProfile: effortInfo.activeEffortProfile,
        effortHistory: effortInfo.effortHistory,
        effortTransitions: effortInfo.effortHistory
      };
    }
    const steps = parseRawJsonl(rawContent, { tier: resolved.tier });
    const effortInfo = extractEffortTimeline(steps);
    return {
      tier: resolved.tier,
      steps,
      filePath: resolved.path,
      rewindDetected: false,
      activeEffortProfile: effortInfo.activeEffortProfile,
      effortHistory: effortInfo.effortHistory,
      effortTransitions: effortInfo.effortHistory
    };
  }

  // Cursor state.vscdb (SQLite cursorDiskKV)
  if (resolved.type === 'cursor-vscdb') {
    const parsedCursor = parseCursorVscdbSync(resolved.path);
    const effortInfo = extractEffortTimeline(parsedCursor.steps);
    return {
      tier: resolved.tier,
      steps: parsedCursor.steps,
      filePath: resolved.path,
      rewindDetected: false,
      genMetadata: parsedCursor.genMetadata,
      sessionTitle: parsedCursor.sessionTitle,
      workspacePath: parsedCursor.workspacePath,
      activeEffortProfile: effortInfo.activeEffortProfile,
      effortHistory: effortInfo.effortHistory,
      effortTransitions: effortInfo.effortHistory
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

      // Also include discovered Claude Code and Cursor sessions
      for (const claudeSess of discoverClaudeCodeSessions(homeDir).slice(0, 8)) {
        try {
          const parsedClaude = parseClaudeCodeJsonl(fs.readFileSync(claudeSess.filePath, 'utf8'));
          if (sessionId && claudeSess.sessionId === sessionId) {
            if (!sessionTitle && parsedClaude.sessionTitle) sessionTitle = parsedClaude.sessionTitle;
            if (!sessionGenMetadata && parsedClaude.genMetadata) sessionGenMetadata = parsedClaude.genMetadata;
            if (parsedClaude.workspacePath && workspaceUris.length === 0) workspaceUris.push(parsedClaude.workspacePath);
            sessionSurface = 'claude-code';
            sessionSurfaceTag = '[Claude]';
          }
          const mtimeIso = claudeSess.mtimeMs > 0 ? new Date(claudeSess.mtimeMs).toISOString() : '';
          upsertDiscoveredSession(claudeSess.sessionId, {
            sessionId: claudeSess.sessionId,
            title: parsedClaude.sessionTitle || claudeSess.sessionId.slice(0, 8),
            stepCount: parsedClaude.steps.length,
            workspace: parsedClaude.workspacePath ? path.basename(parsedClaude.workspacePath) : claudeSess.projectSlug,
            lastModified: mtimeIso,
            surface: 'claude-code',
            surfaceTag: '[Claude]',
            brainDir: claudeSess.filePath,
            ...(parsedClaude.genMetadata && parsedClaude.genMetadata.totalContextTokens > 0 ? {
              liveTokens: parsedClaude.genMetadata.totalContextTokens,
              cacheReadTokens: parsedClaude.genMetadata.cacheReadTokens
            } : {})
          });
        } catch {}
      }

      for (const cursorSess of discoverCursorSessions(homeDir, DatabaseSync).slice(0, 8)) {
        try {
          const parsedCursor = parseCursorVscdbSync(cursorSess.filePath, DatabaseSync);
          if (sessionId && cursorSess.sessionId === sessionId) {
            if (!sessionTitle && (parsedCursor.sessionTitle || cursorSess.title)) sessionTitle = parsedCursor.sessionTitle || cursorSess.title;
            if (!sessionGenMetadata && parsedCursor.genMetadata) sessionGenMetadata = parsedCursor.genMetadata;
            if ((parsedCursor.workspacePath || cursorSess.workspaceUri) && workspaceUris.length === 0) {
              workspaceUris.push(parsedCursor.workspacePath || cursorSess.workspaceUri);
            }
            sessionSurface = 'cursor';
            sessionSurfaceTag = '[Cursor]';
          }
          const mtimeIso = cursorSess.mtimeMs > 0 ? new Date(cursorSess.mtimeMs).toISOString() : '';
          upsertDiscoveredSession(cursorSess.sessionId, {
            sessionId: cursorSess.sessionId,
            title: parsedCursor.sessionTitle || cursorSess.title || cursorSess.sessionId.slice(0, 8),
            stepCount: parsedCursor.steps.length || cursorSess.stepCount || 0,
            workspace: parsedCursor.workspacePath ? path.basename(parsedCursor.workspacePath) : '',
            lastModified: mtimeIso,
            surface: 'cursor',
            surfaceTag: '[Cursor]',
            brainDir: cursorSess.filePath,
            ...(parsedCursor.genMetadata && parsedCursor.genMetadata.totalContextTokens > 0 ? {
              liveTokens: parsedCursor.genMetadata.totalContextTokens,
              cacheReadTokens: parsedCursor.genMetadata.cacheReadTokens
            } : {})
          });
        } catch {}
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
