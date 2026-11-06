import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath, getHomeDir, getBrainStores } from './paths.mjs';
import { EFFORT_PROFILES, resolveEffortProfile } from './constants.mjs';

/**
 * Extracts model/effort metadata from a raw JSONL transcript entry if present.
 */
export function extractTurnEffortMetadata(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const rawContent = String(entry.content || '');
  let fromSpec = null;
  let toSpec = null;

  if (rawContent.includes('<USER_SETTINGS_CHANGE>')) {
    const blocks = rawContent.match(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi) || [];
    for (const block of blocks) {
      const m = block.match(/changed setting\s+`?(?:Model Selection|Reasoning Effort|Effort)`?\s+from\s+([^\n.]+?)\s+to\s+([^\n.]+?)(?:\.|\r|\n|<|$)/i);
      if (m) {
        if (fromSpec === null) fromSpec = m[1].trim();
        toSpec = m[2].trim();
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
    effort: effort || toSpec || null,
    tier: tier || null,
    model: model || toSpec || null,
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
export function parseRawJsonl(content, { tier = 1, stepsDir = null } = {}) {
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  const steps = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
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

      steps.push({
        stepIndex: stepIdx,
        agentId,
        source: entry.source || 'MODEL',
        type: entry.type || 'PLANNER_RESPONSE',
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
      // skip invalid lines
    }
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
 * Finds the active session directory across brain stores
 */
export function findSessionDirectory(sessionId, homeDir = getHomeDir()) {
  const stores = getBrainStores(homeDir);
  if (sessionId) {
    for (const store of stores) {
      const target = path.join(store.path, sessionId);
      if (fs.existsSync(target)) {
        return { storeName: store.name, sessionDir: target, sessionId };
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
              latest = { storeName: store.name, sessionDir: full, sessionId: name, mtimeMs: realMtime };
            }
          }
        } catch {}
      }
    } catch {}
  }

  return latest;
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
  if (fs.existsSync(cacheFile)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cachedData.schemaRev === 2 && cachedData.filePath === filePath) {
        if (cachedData.lastByteOffset <= stat.size) {
          cached = cachedData;
        } else {
          // File shrank due to IDE Undo/Rewind or surgical prune
          rewindDetected = true;
        }
      }
    } catch {}
  }

  if (cached.lastByteOffset === stat.size && cached.schemaRev === 2) {
    const effortInfo = extractEffortTimeline(cached.steps);
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

  // Save updated cache
  try {
    if (!fs.existsSync(actualCacheDir)) {
      fs.mkdirSync(actualCacheDir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify({
      schemaRev: 2,
      filePath,
      sessionId,
      lastByteOffset: stat.size,
      mtimeMs: stat.mtimeMs,
      steps: allSteps
    }), 'utf8');
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
 * Reconciles session with conversation_summaries.db and Knowledge Items for foreign bleed detection
 */
export async function reconcileWorkspaceAndKIs(sessionId, homeDir = getHomeDir(), dbOverride = null) {
  let workspaceUris = [];
  let projectId = '';
  let sessionTitle = '';
  let recentSessions = [];
  const canonicalWorkspaceSet = new Set();

  try {
    let db = dbOverride;
    if (!db) {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(homeDir, '.gemini', 'antigravity', 'conversation_summaries.db');
      if (fs.existsSync(dbPath)) {
        db = new DatabaseSync(dbPath, { readOnly: true });
      }
    }

    if (db) {
      if (sessionId) {
        const row = db.prepare('SELECT title, workspace_uris, project_id FROM conversation_summaries WHERE conversation_id = ?').get(sessionId);
        if (row) {
          sessionTitle = row.title || '';
          projectId = row.project_id || '';
          try {
            workspaceUris = JSON.parse(row.workspace_uris || '[]');
          } catch {
            workspaceUris = row.workspace_uris ? [row.workspace_uris] : [];
          }
        }
      }
      const recentRows = db.prepare('SELECT conversation_id, title, step_count, workspace_uris, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = \'\' ORDER BY last_modified_time DESC LIMIT 10').all();
      recentSessions = recentRows.map(r => {
        let ws = '';
        try {
          const parsed = JSON.parse(r.workspace_uris || '[]');
          ws = canonicalizePath(parsed[0] || '');
        } catch {}
        return {
          sessionId: r.conversation_id,
          title: r.title || r.conversation_id.slice(0, 8),
          stepCount: r.step_count || 0,
          workspace: ws ? path.basename(ws) : '',
          lastModified: r.last_modified_time
        };
      });
    }
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
    recentSessions,
    workspaceUris,
    projectId,
    canonicalWorkspaceSet,
    primaryWorkspace: Array.from(canonicalWorkspaceSet)[0] || '',
    kiBleedMap
  };
}
