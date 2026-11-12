/**
 * @file src/coach/stateBatonHydrator.mjs
 * Deterministic ~300-token Durable Fact Schema (`StateBaton`), `PreCompact` portable Markdown
 * handoff generator (`docs/HANDOFF_<timestamp>.md`), `SessionStart` `additionalContext`
 * injector, and `PostCompact` mutation queue + `SavedQuotaReceiptLedger` flusher.
 *
 * Strictly zero background LLM summarization workers ($0.00 worker cost).
 */

import {
  path,
  getCwd,
  fileExists,
  getFileMtimeMsSafe,
  readdirSafe,
  readTextSafe,
  writeTextAtomic,
  writeJsonAtomic,
  recordRuntimeDiagnostic
} from '../utils/runtime.mjs';
import { sanitizeSessionId } from '../telemetry/telemetryBridge.mjs';
import { PostCompactMutationQueue } from './cacheGravityRouter.mjs';
import { recordSavingsReceipt } from './savedQuotaLedger.mjs';

export const MAX_BATON_TOKEN_BUDGET = 300; // ~1,200 characters

// In-memory fallback set to guarantee idempotent compaction receipts even when disk I/O is disabled
const inMemoryRecordedCompactionKeys = new Set();

/**
 * Reads and parses a persisted State Baton JSON file, recording a structured diagnostic if corrupted (`ISS-065`).
 *
 * @param {string} targetPath
 * @param {string} operation
 * @param {object} [ioOpts={}]
 * @param {object} [diagOpts={}]
 * @returns {any}
 */
function readBatonJsonWithDiagnostics(targetPath, operation, ioOpts = {}, diagOpts = {}) {
  const raw = readTextSafe(targetPath, null, ioOpts);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    recordRuntimeDiagnostic('stateBatonHydrator', operation, err, diagOpts);
    return null;
  }
}

/**
 * Resolves the State Baton persistence path `.claude/cache/state_baton_<sessionId>.json`.
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {string}
 */
export function getStateBatonFilePath(sessionId = 'default', options = {}) {
  const cwd = getCwd(options);
  const safeId = sanitizeSessionId(sessionId);
  return path.join(cwd, '.claude', 'cache', `state_baton_${safeId}.json`);
}

/**
 * Builds or updates a deterministic Durable Fact Schema (`StateBaton`) bounded to ~300 tokens.
 *
 * @param {object} [input={}]
 * @param {string} [input.sessionId='default']
 * @param {string} [input.modelId='claude-sonnet-5-5']
 * @param {string} [input.activeGoal]
 * @param {Array<string>} [input.workingSetFiles]
 * @param {Array<string>} [input.verifiedInvariants]
 * @param {Array<string>} [input.deadEndsAndFailures]
 * @param {Array<object>} [input.queuedCacheMutations]
 * @param {number} [input.savedTokensBeforeCompact=0]
 * @param {number} [input.savedUSDBeforeCompact=0]
 * @param {number} [input.nowMs=Date.now()]
 */
export function buildDurableStateBaton(input = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const activeGoal = String(
    input.activeGoal || 'Maintain active implementation progress and verified invariants across compaction'
  )
    .trim()
    .slice(0, 240);

  const workingSetFiles = Array.from(new Set(input.workingSetFiles || []))
    .map((f) => String(f).trim())
    .filter(Boolean)
    .slice(0, 12);

  const verifiedInvariants = Array.from(new Set(input.verifiedInvariants || []))
    .map((inv) => String(inv).trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, 6);

  const deadEndsAndFailures = Array.from(new Set(input.deadEndsAndFailures || []))
    .map((err) => String(err).trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, 5);

  const queuedCacheMutations = Array.isArray(input.queuedCacheMutations)
    ? input.queuedCacheMutations.slice(0, 8)
    : [];

  const sessionId = sanitizeSessionId(input.sessionId || input.session_id || 'default');
  const explicitCycle =
    input.compactionId || input.compaction_id || input.compactionEpoch || input.turnId || null;
  const compactionId = explicitCycle
    ? `${sessionId}:${String(explicitCycle)}`
    : `${sessionId}:compact:${nowMs}`;

  return {
    schemaVersion: '2026.11.1',
    createdAt: nowMs,
    sessionId,
    compactionId,
    ledgerReceiptRecorded: false,
    lastRecordedCompactionId: null,
    modelId: String(input.modelId || input.model_id || input.model || 'claude-sonnet-5-5'),
    activeGoal,
    workingSetFiles,
    verifiedInvariants,
    deadEndsAndFailures,
    queuedCacheMutations,
    metricsSnapshot: {
      savedTokensBeforeCompact: Math.max(0, Math.round(Number(input.savedTokensBeforeCompact || 0))),
      savedUSDBeforeCompact: Math.max(0, Number(Number(input.savedUSDBeforeCompact || 0).toFixed(6)))
    }
  };
}

/**
 * Formats the Durable State Baton into a compact ~300-token `additionalContext` string
 * for injection on `SessionStart[compact|resume|startup|clear|fork]`.
 *
 * @param {object} baton
 * @returns {string}
 */
export function formatBatonAdditionalContext(baton = {}) {
  if (!baton || typeof baton !== 'object') return '';
  const files =
    Array.isArray(baton.workingSetFiles) && baton.workingSetFiles.length > 0
      ? baton.workingSetFiles.join(', ')
      : 'none recorded';
  const invariants =
    Array.isArray(baton.verifiedInvariants) && baton.verifiedInvariants.length > 0
      ? baton.verifiedInvariants.map((i) => `- ${i}`).join('\n')
      : '- Keep existing tests green and preserve cache prefix stability';
  const deadEnds =
    Array.isArray(baton.deadEndsAndFailures) && baton.deadEndsAndFailures.length > 0
      ? baton.deadEndsAndFailures.map((d) => `- ${d}`).join('\n')
      : '- None';
  const mutations =
    Array.isArray(baton.queuedCacheMutations) && baton.queuedCacheMutations.length > 0
      ? baton.queuedCacheMutations.map((m) => `${m.type}=${JSON.stringify(m.value)}`).join(', ')
      : 'none';

  const block = [
    `<attention_horizon_state_baton session="${baton.sessionId || 'default'}" model="${baton.modelId || 'claude-sonnet-5-5'}">`,
    `Active Goal: ${baton.activeGoal || 'Continue active task'}`,
    `Working Set Files: ${files}`,
    `Verified Invariants:\n${invariants}`,
    `Avoid Dead Ends / Prior Failures:\n${deadEnds}`,
    `Post-Compaction Applied Mutations: ${mutations}`,
    `</attention_horizon_state_baton>`
  ].join('\n');

  // Hard cap at ~1,200 chars (~300 tokens)
  return block.length <= 1250 ? block : `${block.slice(0, 1210)}\n</attention_horizon_state_baton>`;
}

/**
 * Renders a cross-tool portable Markdown handoff document (`docs/HANDOFF_<timestamp>.md`).
 *
 * @param {object} baton
 * @returns {string}
 */
export function renderPortableHandoffMarkdown(baton = {}) {
  const isoDate = new Date(baton.createdAt || Date.now()).toISOString();
  const filesList =
    Array.isArray(baton.workingSetFiles) && baton.workingSetFiles.length > 0
      ? baton.workingSetFiles.map((f) => `- \`${f}\``).join('\n')
      : '- *(none recorded)*';
  const invariantsList =
    Array.isArray(baton.verifiedInvariants) && baton.verifiedInvariants.length > 0
      ? baton.verifiedInvariants.map((i) => `- [x] ${i}`).join('\n')
      : '- [x] Maintain existing test suite pass rate';
  const deadEndsList =
    Array.isArray(baton.deadEndsAndFailures) && baton.deadEndsAndFailures.length > 0
      ? baton.deadEndsAndFailures.map((d) => `- ${d}`).join('\n')
      : '- *(none recorded)*';
  const mutationsList =
    Array.isArray(baton.queuedCacheMutations) && baton.queuedCacheMutations.length > 0
      ? baton.queuedCacheMutations
          .map((m) => `- **${m.type}** (\`${m.key}\`): \`${JSON.stringify(m.value)}\` — ${m.reason || ''}`)
          .join('\n')
      : '- *(no deferred cache mutations)*';

  return [
    `# Attention Horizon State Baton Handoff`,
    ``,
    `- **Session ID:** \`${baton.sessionId || 'default'}\``,
    `- **Active Model:** \`${baton.modelId || 'claude-sonnet-5-5'}\``,
    `- **Captured At:** \`${isoDate}\``,
    ``,
    `## 1. Active Goal`,
    `${baton.activeGoal || 'Continue active task'}`,
    ``,
    `## 2. Working Set Files`,
    filesList,
    ``,
    `## 3. Verified Invariants`,
    invariantsList,
    ``,
    `## 4. Dead Ends & Failures to Avoid`,
    deadEndsList,
    ``,
    `## 5. Queued Cache-Prefix Mutations (Released on PostCompact)`,
    mutationsList,
    ``
  ].join('\n');
}

/**
 * Formats an epoch-ms timestamp as UTC `YYYYMMDD_HHMMSS` for shared cross-edition
 * `HANDOFF_<YYYYMMDD_HHMMSS>.md` filenames (`ISS-055`).
 *
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatUtcHandoffTimestamp(nowMs = Date.now()) {
  const numeric = Number(nowMs);
  const d = new Date(Number.isFinite(numeric) ? numeric : Date.now());
  const pad2 = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}_` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

/**
 * Extracts a UTC epoch-ms timestamp from `HANDOFF_YYYYMMDD_HHMMSS.md` (or legacy `HANDOFF_<epochMs>.md`).
 * @param {string} [filename='']
 * @returns {number}
 */
export function parseHandoffFilenameTimestampMs(filename = '') {
  const base = path.basename(String(filename || ''));
  const utcMatch = base.match(/^HANDOFF_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.md$/i);
  if (utcMatch) {
    return Date.UTC(
      Number(utcMatch[1]),
      Number(utcMatch[2]) - 1,
      Number(utcMatch[3]),
      Number(utcMatch[4]),
      Number(utcMatch[5]),
      Number(utcMatch[6])
    );
  }
  const epochMatch = base.match(/^HANDOFF_(\d{10,15})\.md$/i);
  if (epochMatch) {
    const ms = Number(epochMatch[1]);
    return ms < 1e11 ? ms * 1000 : ms;
  }
  return 0;
}

/**
 * Parses a portable Markdown handoff document (from either Claude Code `State Baton Handoff`,
 * Antigravity `Baton-Pass Handoff Bundle`, or `/handoff` markdown) into a `StateBaton` object (`ISS-055`).
 *
 * @param {string} markdownText
 * @param {object} [defaults={}]
 * @returns {object | null}
 */
export function parsePortableHandoffMarkdown(markdownText = '', defaults = {}) {
  const raw = String(markdownText || '').trim();
  if (!raw) return null;

  const lines = raw.split(/\r?\n/);
  let sessionId = defaults.sessionId || '';
  let modelId = defaults.modelId || 'claude-sonnet-5-5';
  let parsedCreatedAt = 0;

  const goalLines = [];
  const workingSetFiles = [];
  const verifiedInvariants = [];
  const deadEndsAndFailures = [];
  const queuedCacheMutations = [];
  const topSummaryLines = [];

  let currentSection = 'preamble';

  const classifyHeading = (headingText) => {
    const h = headingText.toLowerCase();
    if (
      /(?:active\s+goal|resume\s+contract|active\s+step|objective|current\s+goal|active\s+task|next\s+step|next\s+action)/i.test(
        h
      )
    ) {
      return 'goal';
    }
    if (/(?:working\s+set|owned\s+scope|modified\s+files|active\s+files|files\s+locked|scope\s+paths|^files$)/i.test(h)) {
      return 'files';
    }
    if (/(?:verified\s+invariant|verified\s+unchanged|invariant|architectural|file\s+schema|decision)/i.test(h)) {
      return 'invariants';
    }
    if (/(?:dead\s+end|negative\s+constraint|failure|failed|avoid|do\s+not\s+repeat)/i.test(h)) {
      return 'dead_ends';
    }
    if (/(?:queued\s+cache|deferred.*mutation|cache-prefix\s+mutation)/i.test(h)) {
      return 'mutations';
    }
    return 'other';
  };

  const cleanBulletItem = (line) =>
    line
      .replace(/^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX]\]\s*)?/, '')
      .trim();

  const isPlaceholderBullet = (item) =>
    !item ||
    /^\*\(.*\)\*$/i.test(item) ||
    /^(?:none|none\s+recorded|n\/a|no\s+deferred\s+cache\s+mutations)$/i.test(item);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Top-level title
    if (/^#\s+/.test(trimmed) && !/^##/.test(trimmed)) {
      continue;
    }

    // Section heading
    const headingMatch = trimmed.match(/^#{2,4}\s+(?:\d+\.\s*)?(.+)$/);
    if (headingMatch) {
      currentSection = classifyHeading(headingMatch[1]);
      continue;
    }

    // Metadata extraction in preamble or anywhere near top
    const sessionMeta = trimmed.match(
      /(?:Session\s*ID|Trajectory(?:\s*\/\s*Session)?|Session)\s*:\**\s*`?([^`|*]+)`?/i
    );
    if (sessionMeta && currentSection === 'preamble') {
      sessionId = sessionMeta[1].trim();
      continue;
    }

    const modelMeta = trimmed.match(/(?:Active\s*Model|Model)\s*:\**\s*`?([^`|*]+)`?/i);
    if (modelMeta && currentSection === 'preamble') {
      modelId = modelMeta[1].trim();
      continue;
    }

    const dateMeta = trimmed.match(
      /(?:Captured\s*At|Generated(?:\s*At)?|Created(?:\s*At)?|Timestamp)\s*:\**\s*`?([^`]+)`?/i
    );
    if (dateMeta && currentSection === 'preamble') {
      const ts = Date.parse(dateMeta[1].trim());
      if (!Number.isNaN(ts)) parsedCreatedAt = ts;
      continue;
    }

    if (currentSection === 'preamble') {
      if (!trimmed.startsWith('>') && !trimmed.startsWith('---')) {
        topSummaryLines.push(cleanBulletItem(trimmed));
      }
      continue;
    }

    if (currentSection === 'goal') {
      const cleaned = cleanBulletItem(trimmed);
      if (!isPlaceholderBullet(cleaned)) {
        goalLines.push(cleaned);
      }
    } else if (currentSection === 'files') {
      const cleaned = cleanBulletItem(trimmed);
      if (!isPlaceholderBullet(cleaned)) {
        const backtickMatch = cleaned.match(/^`([^`]+)`/);
        const fileCandidate = (backtickMatch ? backtickMatch[1] : cleaned.split(/\s+[—–-]\s+/)[0]).trim();
        if (fileCandidate && !isPlaceholderBullet(fileCandidate)) {
          workingSetFiles.push(fileCandidate.replace(/^`|`$/g, ''));
        }
      }
    } else if (currentSection === 'invariants') {
      const cleaned = cleanBulletItem(trimmed);
      if (!isPlaceholderBullet(cleaned)) {
        verifiedInvariants.push(cleaned);
      }
    } else if (currentSection === 'dead_ends') {
      const cleaned = cleanBulletItem(trimmed);
      if (!isPlaceholderBullet(cleaned)) {
        deadEndsAndFailures.push(cleaned);
      }
    } else if (currentSection === 'mutations') {
      const mutMatch = trimmed.match(
        /[-*]\s*\*\*([^*]+)\*\*\s*\(`([^`]+)`\)\s*:\s*`([^`]+)`(?:\s*[—-]\s*(.*))?/
      );
      if (mutMatch) {
        let parsedVal = mutMatch[3];
        if (/^(?:["{[\d-]|true$|false$|null$)/.test(parsedVal.trim())) {
          try {
            parsedVal = JSON.parse(mutMatch[3]);
          } catch (err) {
            recordRuntimeDiagnostic(
              'stateBatonHydrator',
              'parsePortableHandoffMarkdown.mutationValue',
              err,
              defaults
            );
          }
        }
        queuedCacheMutations.push({
          type: mutMatch[1].trim(),
          key: mutMatch[2].trim(),
          value: parsedVal,
          reason: (mutMatch[4] || '').trim()
        });
      }
    }
  }

  const activeGoal =
    goalLines.join(' ').trim() ||
    topSummaryLines.join(' ').trim() ||
    'Continue active implementation from portable handoff baton';

  const built = buildDurableStateBaton({
    sessionId: sessionId || defaults.fallbackSessionId || 'default',
    modelId,
    activeGoal,
    workingSetFiles,
    verifiedInvariants,
    deadEndsAndFailures,
    queuedCacheMutations,
    nowMs: parsedCreatedAt || defaults.nowMs || Date.now()
  });

  return {
    ...built,
    source: 'portable_markdown',
    parsedCreatedAt
  };
}

/**
 * Executes `PreCompact` hydration:
 * 1. Builds and persists the Durable State Baton to `.claude/cache/state_baton_<sessionId>.json`
 * 2. Writes portable Markdown handoff to `HANDOFF_<YYYYMMDD_HHMMSS>.md` + `HANDOFF_LATEST.md`
 *    inside `.claude/cache/` (or explicit `options.handoffDir` when configured — keeping git-tracked `docs/` clean by default) (`ISS-055`).
 *
 * @param {object} [input={}]
 * @param {object} [options={}]
 * @returns {{ ok: boolean, baton: object, batonFilePath: string, handoffMarkdownPath: string, handoffLatestPath: string }}
 */
export function handlePreCompactBatonFlush(input = {}, options = {}) {
  const nowMs = options.nowMs ?? input.nowMs ?? Date.now();
  const explicitCwd = options.cwd || input.cwd || null;
  const cwd = getCwd(explicitCwd ? { ...options, cwd: explicitCwd } : options);
  const ioOpts = { ...options, cwd };
  const diagOpts = explicitCwd ? ioOpts : { ...options, cwd: undefined };
  const baton = buildDurableStateBaton({ ...input, nowMs });

  const batonFilePath = getStateBatonFilePath(baton.sessionId, ioOpts);
  const existingBaton = readBatonJsonWithDiagnostics(
    batonFilePath,
    'handlePreCompactBatonFlush.readBaton',
    ioOpts,
    diagOpts
  );

  // Deduplicate concurrent Tier-1 Mod + Tier-2 CLI PreCompact flushes on the same compaction cycle (ISS-036)
  const hasExplicitId = Boolean(
    input.compactionId || input.compaction_id || input.compactionEpoch || input.turnId
  );
  if (
    !hasExplicitId &&
    existingBaton &&
    existingBaton.compactionId &&
    existingBaton.ledgerReceiptRecorded === false &&
    Math.abs(nowMs - Number(existingBaton.createdAt || 0)) <= 5000
  ) {
    baton.compactionId = existingBaton.compactionId;
  }

  writeJsonAtomic(batonFilePath, baton, ioOpts);

  const cacheDir = path.join(cwd, '.claude', 'cache');
  const defaultBatonPath = path.join(cacheDir, 'state_baton.json');
  writeJsonAtomic(defaultBatonPath, baton, ioOpts);

  const utcStamp = formatUtcHandoffTimestamp(nowMs);
  const targetHandoffDir = options.handoffDir || input.handoffDir || cacheDir;
  const handoffMarkdownPath = path.join(targetHandoffDir, `HANDOFF_${utcStamp}.md`);
  const handoffLatestPath = path.join(targetHandoffDir, 'HANDOFF_LATEST.md');
  const cacheLatestPath = path.join(cacheDir, 'HANDOFF_LATEST.md');

  if (options.writeMarkdown !== false) {
    const markdownContent = renderPortableHandoffMarkdown(baton);
    writeTextAtomic(handoffMarkdownPath, markdownContent, ioOpts);
    writeTextAtomic(handoffLatestPath, markdownContent, ioOpts);
    if (cacheLatestPath !== handoffLatestPath) {
      writeTextAtomic(cacheLatestPath, markdownContent, ioOpts);
    }
  }

  return {
    ok: true,
    baton,
    compactionKey: `${baton.sessionId}:${baton.compactionId}`,
    batonFilePath,
    handoffMarkdownPath,
    handoffLatestPath
  };
}

/**
 * Discovers the newest valid portable Markdown handoff artifact across `.agents/horizon/`,
 * `.claude/cache/`, and `docs/` (`ISS-055`).
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {object} ioOpts
 * @returns {{ baton: object, path: string, effectiveTs: number, isExternal: boolean } | null}
 */
function findNewestMarkdownHandoffCandidate(cwd, sessionId, ioOpts = {}) {
  const candidates = [];

  const pushCandidatePath = (filePath, isExternal) => {
    if (!filePath || !fileExists(filePath, ioOpts)) return;
    candidates.push({ filePath, isExternal });
  };

  if (ioOpts.handoffMarkdownPath) {
    pushCandidatePath(ioOpts.handoffMarkdownPath, true);
  }
  pushCandidatePath(path.join(cwd, '.agents', 'horizon', 'HANDOFF_LATEST.md'), true);
  pushCandidatePath(path.join(cwd, '.claude', 'cache', 'HANDOFF_LATEST.md'), false);

  const scanDirs = [
    { dir: path.join(cwd, '.agents', 'horizon'), isExternal: true },
    { dir: path.join(cwd, 'docs'), isExternal: true }
  ];
  if (ioOpts.handoffDir) {
    scanDirs.push({ dir: ioOpts.handoffDir, isExternal: true });
  }

  for (const { dir, isExternal } of scanDirs) {
    const entries = readdirSafe(dir, ioOpts);
    for (const entry of entries) {
      if (/^HANDOFF_.*\.md$/i.test(entry)) {
        pushCandidatePath(path.join(dir, entry), isExternal);
      }
    }
  }

  let best = null;
  const visited = new Set();
  for (const { filePath, isExternal } of candidates) {
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const mdText = readTextSafe(filePath, null, ioOpts);
    if (!mdText) continue;
    const parsed = parsePortableHandoffMarkdown(mdText, { fallbackSessionId: sessionId });
    if (!parsed) continue;
    const mtimeMs = getFileMtimeMsSafe(filePath, ioOpts);
    const nameTs = parseHandoffFilenameTimestampMs(filePath);
    const effectiveTs = Math.max(mtimeMs, Number(parsed.parsedCreatedAt || 0), nameTs);
    if (
      !best ||
      effectiveTs > best.effectiveTs ||
      (effectiveTs === best.effectiveTs && isExternal && !best.isExternal)
    ) {
      best = {
        baton: parsed,
        path: filePath,
        effectiveTs,
        isExternal
      };
    }
  }

  return best;
}

/**
 * Executes `SessionStart` (`startup|resume|clear|compact|fork`) State Baton hydration,
 * returning the ~300-token `additionalContext` payload for Claude Code.
 * Supports both `.claude/cache/state_baton*.json` AND cross-tool portable Markdown handoffs
 * (`.agents/horizon/HANDOFF_LATEST.md`, `.claude/cache/HANDOFF_LATEST.md`, `docs/HANDOFF_*.md`) (`ISS-055`).
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {{ hydrated: boolean, hydratedFrom?: string, baton: object | null, additionalContext: string, hookSpecificOutput: object | null }}
 */
export function handleSessionStartHydration(event = {}, options = {}) {
  const explicitCwd = options.cwd || event.cwd || null;
  const cwd = getCwd(explicitCwd ? { ...options, cwd: explicitCwd } : options);
  const ioOpts = { ...options, cwd };
  const diagOpts = explicitCwd ? ioOpts : { ...options, cwd: undefined };
  const sessionId = sanitizeSessionId(event.session_id || event.sessionId || 'default');

  const sessionBatonPath = getStateBatonFilePath(sessionId, ioOpts);
  let jsonBaton = readBatonJsonWithDiagnostics(
    sessionBatonPath,
    'handleSessionStartHydration.readSessionBaton',
    ioOpts,
    diagOpts
  );
  let jsonBatonPath = sessionBatonPath;

  if (!jsonBaton) {
    const fallbackPath = path.join(cwd, '.claude', 'cache', 'state_baton.json');
    jsonBaton = readBatonJsonWithDiagnostics(
      fallbackPath,
      'handleSessionStartHydration.readFallbackBaton',
      ioOpts,
      diagOpts
    );
    jsonBatonPath = fallbackPath;
  }

  const jsonEffectiveTs = jsonBaton
    ? Math.max(getFileMtimeMsSafe(jsonBatonPath, ioOpts), Number(jsonBaton.createdAt || 0))
    : 0;

  const bestMarkdown = findNewestMarkdownHandoffCandidate(cwd, sessionId, ioOpts);

  let baton = jsonBaton;
  let hydratedFrom = jsonBaton ? 'json' : null;
  let hydratedPath = jsonBaton ? jsonBatonPath : null;

  if (bestMarkdown) {
    const preferMarkdown =
      !jsonBaton ||
      (bestMarkdown.isExternal && bestMarkdown.effectiveTs > jsonEffectiveTs) ||
      bestMarkdown.effectiveTs > jsonEffectiveTs + 50;
    if (preferMarkdown) {
      baton = bestMarkdown.baton;
      hydratedFrom = 'markdown';
      hydratedPath = bestMarkdown.path;
    }
  }

  if (!baton) {
    return {
      hydrated: false,
      hydratedFrom: null,
      baton: null,
      additionalContext: '',
      hookSpecificOutput: null
    };
  }

  const additionalContext = formatBatonAdditionalContext(baton);
  return {
    hydrated: true,
    hydratedFrom,
    hydratedPath,
    baton,
    additionalContext,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  };
}

/**
 * Executes `PostCompact` queue flush and records savings into `SavedQuotaReceiptLedger` (`horizon_ledger.jsonl`).
 * Deduplicates dual Tier-1 Mod + Tier-2 CLI execution using `(sessionId, compactionId)` (`ISS-036`).
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 */
export function handlePostCompactFlush(event = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const explicitCwd = options.cwd || event.cwd || null;
  const cwd = getCwd(explicitCwd ? { ...options, cwd: explicitCwd } : options);
  const ioOpts = { ...options, cwd };
  const diagOpts = explicitCwd ? ioOpts : { ...options, cwd: undefined };
  const sessionId = sanitizeSessionId(event.session_id || event.sessionId || 'default');

  const sessionBatonPath = getStateBatonFilePath(sessionId, ioOpts);
  const defaultBatonPath = path.join(cwd, '.claude', 'cache', 'state_baton.json');
  let baton = readBatonJsonWithDiagnostics(
    sessionBatonPath,
    'handlePostCompactFlush.readSessionBaton',
    ioOpts,
    diagOpts
  );
  if (!baton) {
    baton = readBatonJsonWithDiagnostics(
      defaultBatonPath,
      'handlePostCompactFlush.readFallbackBaton',
      ioOpts,
      diagOpts
    );
  }

  const explicitCycle =
    event.compactionId || event.compaction_id || event.compactionEpoch || event.turnId || null;
  const cycleId = explicitCycle
    ? `${sessionId}:${String(explicitCycle)}`
    : baton?.compactionId || `${sessionId}:post:${baton?.createdAt || nowMs}`;
  const dedupKey = `${cwd}::${sessionId}::${cycleId}`;

  const alreadyRecordedOnBaton = Boolean(
    baton &&
      (baton.lastRecordedCompactionId === cycleId ||
        (baton.compactionId === cycleId && baton.ledgerReceiptRecorded === true))
  );

  if (alreadyRecordedOnBaton || inMemoryRecordedCompactionKeys.has(dedupKey)) {
    return {
      ok: true,
      deduplicated: true,
      sessionId,
      compactionId: cycleId,
      flushedCount: 0,
      appliedMutations: [],
      totalAvoidedPenaltyUSD: 0,
      ledgerEntry: null
    };
  }

  const queue =
    options.mutationQueue instanceof PostCompactMutationQueue
      ? options.mutationQueue
      : new PostCompactMutationQueue(baton?.queuedCacheMutations || event.queuedCacheMutations || []);

  const flushResult = queue.flush({ nowMs });

  // Clear queuedCacheMutations and persist idempotent compaction receipt marker in stored baton
  if (baton) {
    baton.queuedCacheMutations = [];
    baton.lastFlushedAt = nowMs;
    baton.ledgerReceiptRecorded = true;
    baton.lastRecordedCompactionId = cycleId;
    writeJsonAtomic(sessionBatonPath, baton, ioOpts);
    writeJsonAtomic(defaultBatonPath, baton, ioOpts);
  }
  inMemoryRecordedCompactionKeys.add(dedupKey);

  // Record savings receipt in append-only horizon_ledger.jsonl at most once per compaction cycle (`ISS-024`: never fabricate 25000/mutation)
  const summedFlushedTokens = flushResult.appliedMutations.reduce(
    (acc, entry) => acc + Math.max(0, Number(entry?.cachedTokens || entry?.savedTokens || 0)),
    0
  );
  const batonSavedBeforeCompact = Math.max(
    0,
    Number(baton?.metricsSnapshot?.savedTokensBeforeCompact || 0)
  );
  const savedTokens = Math.max(
    0,
    Number(event.tokensSaved ?? batonSavedBeforeCompact + summedFlushedTokens)
  );
  const savedUSD = Math.max(
    0,
    Number(
      event.usdSaved ??
        (Number(baton?.metricsSnapshot?.savedUSDBeforeCompact || 0) +
          Number(flushResult.totalAvoidedPenaltyUSD || 0))
    )
  );

  let ledgerEntry = null;
  if (savedTokens > 0 || savedUSD > 0 || flushResult.flushedCount > 0) {
    const rec = recordSavingsReceipt(
      {
        timestamp: nowMs,
        sessionId,
        category: flushResult.flushedCount > 0 ? 'POST_COMPACT_MUTATION_RELEASE' : 'COMPACT_STATE_BATON',
        modelId: baton?.modelId || event.modelId || 'claude-sonnet-5-5',
        savedTokens,
        savedUSD,
        detail: `Flushed ${flushResult.flushedCount} deferred mutation(s) on fresh post-compaction prefix`
      },
      ioOpts
    );
    ledgerEntry = rec.entry;
  }

  return {
    ok: true,
    deduplicated: false,
    sessionId,
    compactionId: cycleId,
    flushedCount: flushResult.flushedCount,
    appliedMutations: flushResult.appliedMutations,
    totalAvoidedPenaltyUSD: flushResult.totalAvoidedPenaltyUSD,
    ledgerEntry
  };
}

export default {
  MAX_BATON_TOKEN_BUDGET,
  getStateBatonFilePath,
  buildDurableStateBaton,
  formatBatonAdditionalContext,
  formatUtcHandoffTimestamp,
  parseHandoffFilenameTimestampMs,
  renderPortableHandoffMarkdown,
  parsePortableHandoffMarkdown,
  handlePreCompactBatonFlush,
  handleSessionStartHydration,
  handlePostCompactFlush
};
