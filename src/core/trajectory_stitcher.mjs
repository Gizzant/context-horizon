import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const SQLITE_OPEN_READONLY_OPTIONS = Object.freeze({ readOnly: true });
import { canonicalizePath } from './paths.mjs';

/**
 * Cross-Harness SQLite & Protobuf Trajectory Stitcher.
 *
 * 1. Antigravity CLI/IDE: Zero-dependency protobuf wire-walker for `conversations/<uuid>.db`
 *    (`steps` table: `idx`, `step_type`, `metadata`, `step_payload`) to extract authoritative
 *    `file:///` workspace URIs or shell `cwd` and stitch with `transcript_full.jsonl` & `annotations/<uuid>.pbtxt`.
 * 2. Cursor: Correlates `composerData:<id>`, `bubbleId:<id>:<bubble>`, `messageRequestContext:<id>:<id>`,
 *    and `agentKv:blob:*` (`providerOptions.cursor.requestId` / `ai_code_hashes.requestId`) with `store.db`
 *    and timestamp-less `agent-transcripts/*.jsonl`.
 * 3. Claude Code: Reconstructs the full `uuid -> parentUuid` DAG up to the active `leafUuid`,
 *    identifying `/rewind` forks, `file-history-snapshot` restore points, and inferred system prompt tokens.
 */

const FILE_URI_RE = /file:\/\/\/[^\s"'\x00-\x1f<>]+/gi;
const CWD_PATH_RE = /(?:[A-Za-z]:[\\/](?:[^\s"'\x00-\x1f<>\\/:*?|]+[\\/])*[^\s"'\x00-\x1f<>\\/:*?|]+|\/(?:Users|home|workspaces|projects|var|opt|tmp)\/[^\s"'\x00-\x1f<>:]+)/g;

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function isLikelyPrintableUtf8(sub) {
  if (!sub || sub.length === 0) return false;
  const str = sub.toString('utf8');
  if (str.includes('\uFFFD')) return false;
  let printable = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 0xfffd)) {
      printable++;
    }
  }
  return (printable / str.length) >= 0.85;
}

/**
 * Zero-dependency Protobuf wire-format decoder.
 * Walks binary `step_payload` and `metadata` blobs without requiring `.proto` schemas.
 */
export function decodeProtobufWire(buffer, depth = 0) {
  const fields = [];
  const strings = [];
  const fileUris = new Set();
  const cwdCandidates = new Set();

  if (!buffer) {
    return { fields, strings, fileUris: [], cwdCandidates: [] };
  }
  const buf = Buffer.isBuffer(buffer)
    ? buffer
    : (buffer instanceof Uint8Array ? Buffer.from(buffer) : Buffer.from(String(buffer), 'utf8'));

  const extractStringSignals = (str) => {
    const trimmed = str.trim();
    if (!trimmed) return;
    strings.push(trimmed);
    const uris = trimmed.match(FILE_URI_RE) || [];
    for (const u of uris) fileUris.add(u);
    const paths = trimmed.match(CWD_PATH_RE) || [];
    for (const p of paths) {
      if (!/^https?:\/\//i.test(p)) cwdCandidates.add(p);
    }
  };

  let offset = 0;
  while (offset < buf.length) {
    const tagVarint = readVarint(buf, offset);
    if (!tagVarint || typeof tagVarint.value !== 'number' || tagVarint.value <= 0) break;
    offset = tagVarint.nextOffset;

    const wireType = tagVarint.value & 0x07;
    const fieldNumber = tagVarint.value >>> 3;
    if (fieldNumber <= 0 || fieldNumber > 536870911) break;

    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val) break;
      offset = val.nextOffset;
      fields.push({ fieldNumber, wireType, value: val.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      const slice = buf.subarray(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value: slice });
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, offset);
      if (!lenVarint || typeof lenVarint.value !== 'number' || lenVarint.value < 0) break;
      offset = lenVarint.nextOffset;
      const len = lenVarint.value;
      if (offset + len > buf.length) break;
      const sub = buf.subarray(offset, offset + len);
      offset += len;

      if (isLikelyPrintableUtf8(sub)) {
        const text = sub.toString('utf8');
        extractStringSignals(text);
        fields.push({ fieldNumber, wireType, value: text });
      } else if (depth < 4 && sub.length >= 2) {
        const nested = decodeProtobufWire(sub, depth + 1);
        for (const s of nested.strings) extractStringSignals(s);
        for (const u of nested.fileUris) fileUris.add(u);
        for (const c of nested.cwdCandidates) cwdCandidates.add(c);
        fields.push({ fieldNumber, wireType, value: nested.fields.length > 0 ? nested.fields : sub });
      } else {
        fields.push({ fieldNumber, wireType, value: sub });
      }
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      const slice = buf.subarray(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value: slice });
    } else {
      break;
    }
  }

  // Fallback raw scan if the buffer contains embedded plaintext or JSON
  if (fileUris.size === 0 && cwdCandidates.size === 0 && buf.length > 0) {
    const rawStr = buf.toString('utf8');
    extractStringSignals(rawStr);
  }

  return {
    fields,
    strings,
    fileUris: Array.from(fileUris),
    cwdCandidates: Array.from(cwdCandidates)
  };
}

/**
 * Parses `annotations/<uuid>.pbtxt` for session title and workspace metadata.
 */
export function parsePbtxtAnnotations(pbtxtContent = '') {
  const text = String(pbtxtContent || '');
  const titleMatch = text.match(/\btitle\s*:\s*"([^"]+)"/i) || text.match(/\bsummary\s*:\s*"([^"]+)"/i);
  const uriMatch = text.match(/file:\/\/\/[^\s"']+/i);
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    workspaceUri: uriMatch ? uriMatch[0].trim() : null
  };
}

/**
 * Stitches Antigravity CLI SQLite `conversations/<uuid>.db` (`steps` table protobuf blobs)
 * with `transcript_full.jsonl` and `annotations/<uuid>.pbtxt`.
 */
export async function stitchAntigravityCliTrajectory(dbPath, options = {}) {
  const sessionId = options.sessionId || (dbPath ? path.basename(dbPath, '.db') : 'unknown');
  let title = '';
  let workspaceUri = null;
  const cwdFound = [];
  const dbSteps = [];

  if (options.pbtxtPath && fs.existsSync(options.pbtxtPath)) {
    try {
      const parsedPbtxt = parsePbtxtAnnotations(fs.readFileSync(options.pbtxtPath, 'utf8'));
      if (parsedPbtxt.title) title = parsedPbtxt.title;
      if (parsedPbtxt.workspaceUri) workspaceUri = parsedPbtxt.workspaceUri;
    } catch {}
  } else if (options.pbtxtContent) {
    const parsedPbtxt = parsePbtxtAnnotations(options.pbtxtContent);
    if (parsedPbtxt.title) title = parsedPbtxt.title;
    if (parsedPbtxt.workspaceUri) workspaceUri = parsedPbtxt.workspaceUri;
  }

  let dbRows = Array.isArray(options.stepRows) ? options.stepRows : null;
  if (!dbRows && dbPath && fs.existsSync(dbPath)) {
    let db = null;
    try {
      const DbCtor = options.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
      db = new DbCtor(dbPath, SQLITE_OPEN_READONLY_OPTIONS);
      dbRows = db.prepare(
        'SELECT idx, step_type, status, has_subtrajectory, metadata, error_details, permissions, task_details, render_info, step_payload, step_format FROM steps ORDER BY idx ASC'
      ).all();
    } catch {
      dbRows = [];
    } finally {
      try { if (db && typeof db.close === 'function') db.close(); } catch {}
    }
  }

  for (const row of (dbRows || [])) {
    const blobs = [row.step_payload, row.metadata, row.task_details, row.render_info, row.error_details].filter(Boolean);
    const stepStrings = [];
    let hasSubtrajectory = Boolean(row.has_subtrajectory);

    for (const blob of blobs) {
      const decoded = decodeProtobufWire(blob);
      for (const u of decoded.fileUris) {
        if (!workspaceUri) workspaceUri = u;
      }
      for (const c of decoded.cwdCandidates) {
        cwdFound.push(c);
      }
      stepStrings.push(...decoded.strings);
    }

    dbSteps.push({
      stepIndex: Number(row.idx ?? dbSteps.length),
      stepType: row.step_type ?? 'STEP',
      status: row.status ?? 'DONE',
      hasSubtrajectory,
      extractedText: stepStrings.join('\n').slice(0, 4000)
    });
  }

  let jsonlSteps = Array.isArray(options.jsonlSteps) ? options.jsonlSteps : [];
  if (jsonlSteps.length === 0 && options.transcriptPath && fs.existsSync(options.transcriptPath)) {
    try {
      const lines = fs.readFileSync(options.transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
      jsonlSteps = lines.map((l, idx) => {
        try { return JSON.parse(l); } catch { return { step_index: idx, content: l }; }
      });
    } catch {}
  }

  const dbByIndex = new Map(dbSteps.map(s => [s.stepIndex, s]));
  const mergedSteps = [];
  const seenIndices = new Set();

  for (const jStep of jsonlSteps) {
    const idx = Number(jStep.step_index ?? jStep.stepIndex ?? mergedSteps.length);
    seenIndices.add(idx);
    const dbMatch = dbByIndex.get(idx);
    mergedSteps.push({
      ...jStep,
      stepIndex: idx,
      type: jStep.type || dbMatch?.stepType || 'STEP',
      hasSubtrajectory: Boolean(jStep.hasSubtrajectory || dbMatch?.hasSubtrajectory),
      content: jStep.content || dbMatch?.extractedText || '',
      workspaceUri: workspaceUri || null
    });
  }

  // Inject filtered PLANNER_RESPONSE or SQLite-only steps omitted from CLI JSONL
  for (const dStep of dbSteps) {
    if (!seenIndices.has(dStep.stepIndex)) {
      mergedSteps.push({
        stepIndex: dStep.stepIndex,
        type: String(dStep.stepType || 'PLANNER_RESPONSE'),
        status: dStep.status,
        hasSubtrajectory: dStep.hasSubtrajectory,
        content: dStep.extractedText,
        stitchedFromSqlite: true,
        workspaceUri: workspaceUri || null
      });
    }
  }

  mergedSteps.sort((a, b) => a.stepIndex - b.stepIndex);

  const rawWorkspace = workspaceUri || cwdFound[0] || '';
  const canonicalWorkspace = rawWorkspace ? canonicalizePath(rawWorkspace) : '';

  return {
    sessionId,
    title: title || sessionId.slice(0, 8),
    workspaceUri: workspaceUri || (cwdFound[0] ? `file:///${cwdFound[0].replace(/\\/g, '/')}` : null),
    canonicalWorkspace,
    steps: mergedSteps,
    stitchedCount: dbSteps.length,
    stitchedStepCount: dbSteps.length
  };
}

/**
 * Correlates Cursor `state.vscdb` (`cursorDiskKV`), `store.db` (`blobs`, `meta`),
 * and timestamp-less `agent-transcripts/*.jsonl` via `requestId` and content digests.
 */
export async function stitchCursorTrajectory(sources = {}) {
  let composerId = sources.composerId || sources.sessionId || null;
  let agentId = null;
  let latestRootBlobId = null;
  const correlatedRequestIds = new Set();
  const bubbles = [];
  const contexts = new Map();

  let kvRows = Array.isArray(sources.diskKvRows) ? sources.diskKvRows : null;
  if (!kvRows && sources.stateVscdbPath && fs.existsSync(sources.stateVscdbPath)) {
    let db = null;
    try {
      const DbCtor = sources.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
      db = new DbCtor(sources.stateVscdbPath, SQLITE_OPEN_READONLY_OPTIONS);
      kvRows = db.prepare('SELECT key, value FROM cursorDiskKV').all();
    } catch {
      kvRows = [];
    } finally {
      try { if (db && typeof db.close === 'function') db.close(); } catch {}
    }
  }

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
    } else if (key.startsWith('bubbleId:')) {
      const parts = key.split(':');
      const cid = parts[1] || '';
      if (!composerId || cid === composerId) {
        const reqId = val?.requestId || val?.providerOptions?.cursor?.requestId || val?.ai_code_hashes?.requestId || null;
        if (reqId) correlatedRequestIds.add(reqId);
        bubbles.push({
          composerId: cid,
          bubbleId: parts[2] || '',
          type: val?.type === 1 ? 'USER_INPUT' : 'PLANNER_RESPONSE',
          content: String(val?.text || val?.rawText || val?.content || ''),
          toolFormerData: val?.toolFormerData || null,
          requestId: reqId,
          createdAt: val?.createdAt || val?.timingInfo?.clientStartTime || null
        });
      }
    } else if (key.startsWith('messageRequestContext:')) {
      const parts = key.split(':');
      contexts.set(`${parts[1]}:${parts[2]}`, val);
    } else if (key.startsWith('agentKv:blob:')) {
      const reqId = val?.providerOptions?.cursor?.requestId || val?.ai_code_hashes?.requestId || val?.requestId || null;
      if (reqId) correlatedRequestIds.add(reqId);
    }
  }

  // Inspect Cursor CLI `store.db` (`meta` hex-encoded & `blobs`)
  let metaRows = Array.isArray(sources.storeMetaRows) ? sources.storeMetaRows : null;
  if (!metaRows && sources.storeDbPath && fs.existsSync(sources.storeDbPath)) {
    let db = null;
    try {
      const DbCtor = sources.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
      db = new DbCtor(sources.storeDbPath, SQLITE_OPEN_READONLY_OPTIONS);
      metaRows = db.prepare('SELECT key, value FROM meta').all();
    } catch {
      metaRows = [];
    } finally {
      try { if (db && typeof db.close === 'function') db.close(); } catch {}
    }
  }

  for (const m of (metaRows || [])) {
    let rawVal = String(m.value || '');
    if (/^[0-9a-fA-F]+$/.test(rawVal) && rawVal.length % 2 === 0) {
      try { rawVal = Buffer.from(rawVal, 'hex').toString('utf8'); } catch {}
    }
    try {
      const parsed = JSON.parse(rawVal);
      if (parsed.agentId) agentId = parsed.agentId;
      if (parsed.latestRootBlobId) latestRootBlobId = parsed.latestRootBlobId;
    } catch {
      if (m.key === 'agentId') agentId = rawVal;
      if (m.key === 'latestRootBlobId') latestRootBlobId = rawVal;
    }
  }

  // Correlate timestamp-less `agent-transcripts/*.jsonl` lines by content hash
  let transcriptLines = Array.isArray(sources.transcriptLines) ? sources.transcriptLines : [];
  if (transcriptLines.length === 0 && sources.transcriptJsonlPath && fs.existsSync(sources.transcriptJsonlPath)) {
    try {
      transcriptLines = fs.readFileSync(sources.transcriptJsonlPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return { content: l }; } });
    } catch {}
  }

  const bubbleByDigest = new Map();
  for (const b of bubbles) {
    const digest = crypto.createHash('sha1').update(String(b.content || '').trim().slice(0, 200)).digest('hex');
    bubbleByDigest.set(digest, b);
  }

  const steps = bubbles.map((b, idx) => ({
    stepIndex: idx,
    type: b.type,
    content: b.content,
    toolFormerData: b.toolFormerData,
    requestId: b.requestId,
    createdAt: b.createdAt,
    messageRequestContext: contexts.get(`${b.composerId}:${b.bubbleId}`) || null
  }));

  for (const tLine of transcriptLines) {
    const text = String(tLine.content || tLine.text || '');
    const digest = crypto.createHash('sha1').update(text.trim().slice(0, 200)).digest('hex');
    if (!bubbleByDigest.has(digest)) {
      steps.push({
        stepIndex: steps.length,
        type: tLine.role === 'user' ? 'USER_INPUT' : 'PLANNER_RESPONSE',
        content: text,
        stitchedFromTranscript: true
      });
    }
  }

  return {
    sessionId: composerId || agentId || 'cursor-session',
    composerId,
    agentId,
    storeAgentId: agentId,
    latestRootBlobId,
    correlatedRequestIds: Array.from(correlatedRequestIds),
    steps
  };
}

/**
 * Reconstructs the Claude Code `uuid -> parentUuid` DAG up to the active `leafUuid`,
 * identifying `/rewind` branches, `file-history-snapshot` restore points, and turn-1 inferred system prompt tokens.
 */
export function stitchClaudeCodeDag(jsonlLinesOrContent = []) {
  const rawArr = typeof jsonlLinesOrContent === 'string'
    ? jsonlLinesOrContent.split(/\r?\n/).filter(Boolean)
    : (Array.isArray(jsonlLinesOrContent) ? jsonlLinesOrContent : []);
  const entries = rawArr.map(item => {
    if (typeof item === 'string') {
      try { return JSON.parse(item); } catch { return null; }
    }
    return item;
  }).filter(Boolean);

  const nodeMap = new Map();
  const childrenMap = new Map();
  const restorePoints = [];
  let explicitLeafUuid = null;
  let lastEntryUuid = null;
  let inferredSystemPromptTokens = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;

    if (e.leafUuid) explicitLeafUuid = e.leafUuid;
    if (e.type === 'file-history-snapshot' || e.snapshot) {
      restorePoints.push({
        uuid: e.uuid || `restore-${i}`,
        stepIndex: i,
        timestamp: e.timestamp || e.createdAt || null,
        files: Object.keys(e.snapshot?.trackedFileBackups || e.files || {})
      });
    }

    const nestedCreate = e.message?.usage?.cache_creation || e.usage?.cache_creation || e.cache_creation || null;
    const nestedEphemeralCreate = nestedCreate && typeof nestedCreate === 'object'
      ? (Number(nestedCreate.ephemeral_5m_input_tokens || 0) + Number(nestedCreate.ephemeral_1h_input_tokens || 0))
      : 0;
    const cacheCreate = Number(
      e.cache_creation_input_tokens ??
      e.message?.usage?.cache_creation_input_tokens ??
      e.usage?.cache_creation_input_tokens ??
      0
    ) || nestedEphemeralCreate;
    if (inferredSystemPromptTokens === 0 && cacheCreate > 0) {
      inferredSystemPromptTokens = cacheCreate;
    }

    const uuid = e.uuid || e.id || `step-${i}`;
    const parentUuid = e.parentUuid !== undefined ? e.parentUuid : (lastEntryUuid || null);
    lastEntryUuid = uuid;

    nodeMap.set(uuid, { ...e, uuid, parentUuid, rawIndex: i });
    const pKey = parentUuid || '__ROOT__';
    if (!childrenMap.has(pKey)) childrenMap.set(pKey, []);
    childrenMap.get(pKey).push(uuid);
  }

  const activeTipUuid = (explicitLeafUuid && nodeMap.has(explicitLeafUuid)) ? explicitLeafUuid : lastEntryUuid;
  const activeUuidSet = new Set();
  const activeChain = [];

  let curr = activeTipUuid;
  const visited = new Set();
  while (curr && nodeMap.has(curr) && !visited.has(curr)) {
    visited.add(curr);
    activeUuidSet.add(curr);
    activeChain.push(nodeMap.get(curr));
    curr = nodeMap.get(curr).parentUuid;
  }
  activeChain.reverse();

  // Identify /rewind branches: children of active nodes that are not in activeUuidSet
  const rewindBranches = [];
  const countSubtree = (startUuid) => {
    let count = 0;
    let tokens = 0;
    let tip = startUuid;
    const stack = [startUuid];
    while (stack.length > 0) {
      const u = stack.pop();
      const n = nodeMap.get(u);
      if (!n) continue;
      count++;
      tip = u;
      tokens += Number(n.output_tokens ?? n.message?.usage?.output_tokens ?? Math.ceil(String(n.content || '').length / 4));
      for (const ch of (childrenMap.get(u) || [])) {
        stack.push(ch);
      }
    }
    return { count, tokens, tip };
  };

  for (const activeNode of activeChain) {
    const siblings = childrenMap.get(activeNode.uuid) || [];
    for (const childUuid of siblings) {
      if (!activeUuidSet.has(childUuid)) {
        const sub = countSubtree(childUuid);
        rewindBranches.push({
          forkParentUuid: activeNode.uuid,
          forkUuid: activeNode.uuid,
          abandonedTipUuid: sub.tip,
          droppedStepCount: sub.count,
          abandonedStepCount: sub.count,
          droppedTokens: sub.tokens,
          abandonedTokens: sub.tokens
        });
      }
    }
  }

  // Deduplicate/consolidate streaming assistant JSONL chunks sharing the same message.id
  // so content blocks merge cleanly while ONLY the final chunk's usage snapshot is retained.
  const consolidatedActiveChain = [];
  const msgIdIndexMap = new Map();

  const mergeMessageContentBlocks = (prevContent, nextContent) => {
    if (nextContent === undefined || nextContent === null) return prevContent;
    if (prevContent === undefined || prevContent === null) return nextContent;
    if (typeof prevContent === 'string' && typeof nextContent === 'string') {
      if (nextContent.startsWith(prevContent)) return nextContent;
      if (prevContent === nextContent) return nextContent;
      return `${prevContent}\n${nextContent}`;
    }
    const toBlocks = (val) => (Array.isArray(val) ? val : [{ type: 'text', text: String(val) }]);
    const merged = [...toBlocks(prevContent)];
    for (const blk of toBlocks(nextContent)) {
      if (!blk || typeof blk !== 'object') continue;
      if (blk.id) {
        const existingIdx = merged.findIndex((b) => b && b.id === blk.id);
        if (existingIdx >= 0) {
          merged[existingIdx] = blk;
          continue;
        }
      }
      if (blk.type === 'text' && typeof blk.text === 'string') {
        const prevTextIdx = merged.findIndex(
          (b) => b && b.type === 'text' && typeof b.text === 'string' &&
            (b.text === blk.text || blk.text.startsWith(b.text))
        );
        if (prevTextIdx >= 0) {
          merged[prevTextIdx] = blk;
          continue;
        }
      }
      if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
        const prevThinkIdx = merged.findIndex(
          (b) => b && b.type === 'thinking' && typeof b.thinking === 'string' &&
            (b.thinking === blk.thinking || blk.thinking.startsWith(b.thinking))
        );
        if (prevThinkIdx >= 0) {
          merged[prevThinkIdx] = blk;
          continue;
        }
      }
      merged.push(blk);
    }
    return merged;
  };

  for (const node of activeChain) {
    const msg = node?.message && typeof node.message === 'object' ? node.message : null;
    const role = String(msg?.role || node?.role || node?.type || '').toLowerCase();
    const msgId = (role === 'assistant' || node?.type === 'assistant')
      ? String(msg?.id || node?.message_id || node?.messageId || '').trim()
      : '';

    if (msgId && msgIdIndexMap.has(msgId)) {
      const idx = msgIdIndexMap.get(msgId);
      const prev = consolidatedActiveChain[idx];
      const prevMsg = prev?.message && typeof prev.message === 'object' ? prev.message : {};
      const nextMsg = msg || {};
      const mergedContent = mergeMessageContentBlocks(
        prevMsg.content ?? prev.content,
        nextMsg.content ?? node.content
      );
      consolidatedActiveChain[idx] = {
        ...prev,
        ...node,
        uuid: node.uuid || prev.uuid,
        parentUuid: prev.parentUuid,
        content: msg ? prev.content : mergedContent,
        tool_calls: [
          ...(Array.isArray(prev.tool_calls) ? prev.tool_calls : []),
          ...(Array.isArray(node.tool_calls) ? node.tool_calls : [])
        ],
        message: msg || prev.message
          ? {
              ...prevMsg,
              ...nextMsg,
              content: mergedContent,
              usage: nextMsg.usage || prevMsg.usage
            }
          : undefined,
        usage: node.usage || nextMsg.usage || prev.usage
      };
    } else {
      if (msgId) {
        msgIdIndexMap.set(msgId, consolidatedActiveChain.length);
      }
      consolidatedActiveChain.push(node);
    }
  }

  return {
    leafUuid: activeTipUuid || null,
    activeBranchSteps: consolidatedActiveChain.map((n, idx) => ({ ...n, stepIndex: idx })),
    rewindBranches,
    restorePoints,
    inferredSystemPromptTokens
  };
}
