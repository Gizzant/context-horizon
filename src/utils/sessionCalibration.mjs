/**
 * @file src/utils/sessionCalibration.mjs
 * Read-only Stop-hook session transcript calibrator for Claude Code (`DET-08`).
 *
 * Counts completed interactive turns (`turnsCompleted`), unique API calls (`apiCallsCompleted`),
 * initial session prefix tokens, and the rolling median output tokens across the most recent
 * turns, persisting compact numeric state outside `<cwd>` under
 * `~/.attention-horizon/cache/sessions/cal_<sessionId>.json`.
 */

import { fs, path, os, readJsonSafe, writeJsonAtomic } from './nodeIo.mjs';

export const ROLLING_OUTPUT_WINDOW = 10;
export const MIN_TRUSTED_OUTPUT_TURNS = 5;
export const DEFAULT_OUTPUT_SHRINKAGE_PRIOR_TOKENS = 500;
export const MIN_TRUSTED_RPT_TURNS = 5;
export const DEFAULT_RPT_SHRINKAGE_PRIOR = 2.0;
export const RPT_AGREEMENT_MAX_RELATIVE_SPREAD = 0.25;
export const OUTPUT_SHRINKAGE_PRIOR_METADATA = Object.freeze({
  priorTokens: DEFAULT_OUTPUT_SHRINKAGE_PRIOR_TOKENS,
  minTrustedTurns: MIN_TRUSTED_OUTPUT_TURNS,
  effectivePseudoCountExampleAtN2: MIN_TRUSTED_OUTPUT_TURNS - 2,
  isPlaceholderPrior: true,
  provenance: 'placeholder_engineering_heuristic_midpoint_not_claude_code_telemetry',
  description:
    'Heuristic 500-token output midpoint over a 5-turn ramp (effective k = minTrustedTurns - n, e.g. k = 3 at n = 2); not derived from Claude Code telemetry.'
});
export const RPT_SHRINKAGE_PRIOR_METADATA = Object.freeze({
  priorRequestsPerTurn: DEFAULT_RPT_SHRINKAGE_PRIOR,
  minTrustedTurns: MIN_TRUSTED_RPT_TURNS,
  agreementReducedMinTurns: Number((MIN_TRUSTED_RPT_TURNS / 2).toFixed(2)),
  agreementMaxRelativeSpread: RPT_AGREEMENT_MAX_RELATIVE_SPREAD,
  localTranscriptOverrideMinSessions: 3,
  effectivePseudoCountExampleAtN2: MIN_TRUSTED_RPT_TURNS - 2,
  isPlaceholderPrior: true,
  provenance: 'placeholder_single_tool_round_rpt_prior_2.0_not_empirical_evidence',
  description:
    'Placeholder rationale of 2.0 requests/turn (1 tool round + 1 reply, not empirical evidence) over a 5-turn ramp (halved to 2.5 when >= 2 observed turns agree within 25% spread, w = 0.8 at n = 2), overridden once >= 3 non-current, non-benchmark local Claude Code transcripts exist; replaces earlier 1.0 (0 tool calls) placeholder.'
});

/**
 * Linearly shrink an early rolling output median toward a conservative placeholder prior
 * until `minTrustedTurns` turns of output have been observed.
 */
export function shrinkRollingOutputEstimate(rollingMedian, sampleSize, options = {}) {
  const minTurnsRaw = Number(options.minTrustedTurns);
  const minTrustedTurns =
    Number.isFinite(minTurnsRaw) && minTurnsRaw > 0
      ? Math.round(minTurnsRaw)
      : MIN_TRUSTED_OUTPUT_TURNS;
  const priorRaw = Number(options.priorTokens);
  const priorTokens =
    Number.isFinite(priorRaw) && priorRaw > 0
      ? Math.round(priorRaw)
      : DEFAULT_OUTPUT_SHRINKAGE_PRIOR_TOKENS;
  const count = Math.max(0, Math.round(Number(sampleSize) || 0));
  const rawMedian = Number(rollingMedian);
  if (!Number.isFinite(rawMedian) || rawMedian <= 0 || count === 0) {
    return {
      expectedOutputTokens: priorTokens,
      rawRollingMedianOutputTokens: null,
      sampleSize: 0,
      shrinkageWeight: 0,
      minTrustedTurns,
      priorTokens,
      effectiveSmoothingK: minTrustedTurns,
      isPlaceholderShrinkagePrior: true,
      shrinkagePriorProvenance: OUTPUT_SHRINKAGE_PRIOR_METADATA.provenance,
      source: 'shrinkage_prior_default'
    };
  }
  const weight = Math.min(1, count / minTrustedTurns);
  const blended = Math.round(weight * rawMedian + (1 - weight) * priorTokens);
  return {
    expectedOutputTokens: Math.max(1, blended),
    rawRollingMedianOutputTokens: Math.round(rawMedian),
    sampleSize: count,
    shrinkageWeight: Number(weight.toFixed(4)),
    minTrustedTurns,
    priorTokens,
    effectiveSmoothingK: Math.max(0, minTrustedTurns - Math.min(minTrustedTurns, count)),
    isPlaceholderShrinkagePrior: true,
    shrinkagePriorProvenance: OUTPUT_SHRINKAGE_PRIOR_METADATA.provenance,
    source: weight < 1 ? 'stop_hook_shrunk_median' : 'stop_hook_rolling_median'
  };
}

/**
 * Sanitizes a session ID for safe cache filenames.
 * @param {string} [sessionId='default']
 * @returns {string}
 */
function sanitizeSessionId(sessionId = 'default') {
  const cleaned = String(sessionId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'default';
}

/**
 * Resolves the user home directory across options, `HOME`, `USERPROFILE`, and `os.homedir()`.
 * @param {object} [options={}]
 * @returns {string}
 */
export function resolveCalibrationHomeDir(options = {}) {
  return (
    options.homeDir ||
    globalThis.process?.env?.HOME ||
    globalThis.process?.env?.USERPROFILE ||
    os.homedir()
  );
}

/**
 * Computes the rounded integer median of positive finite numbers over the trailing window.
 * @param {number[]} [values=[]]
 * @param {number} [windowSize=ROLLING_OUTPUT_WINDOW]
 * @returns {number | null}
 */
export function computeRollingMedian(values = [], windowSize = ROLLING_OUTPUT_WINDOW) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (nums.length === 0) return null;
  const recent = nums.slice(-Math.max(1, Number(windowSize) || ROLLING_OUTPUT_WINDOW));
  recent.sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  return recent.length % 2 === 1
    ? Math.round(recent[mid])
    : Math.round((recent[mid - 1] + recent[mid]) / 2);
}

/**
 * Computes the floating-point median of positive finite numbers over the trailing window (4 decimals).
 * @param {number[]} [values=[]]
 * @param {number} [windowSize=ROLLING_OUTPUT_WINDOW]
 * @returns {number | null}
 */
export function computeRollingMedianFloat(values = [], windowSize = ROLLING_OUTPUT_WINDOW) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (nums.length === 0) return null;
  const recent = nums.slice(-Math.max(1, Number(windowSize) || ROLLING_OUTPUT_WINDOW));
  recent.sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  const med = recent.length % 2 === 1 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
  return Number(med.toFixed(4));
}

/**
 * Computes the rounded integer median of non-negative finite numbers over the trailing window.
 * @param {number[]} [values=[]]
 * @param {number} [windowSize=ROLLING_OUTPUT_WINDOW]
 * @returns {number | null}
 */
export function computeRollingMedianNonNegative(values = [], windowSize = ROLLING_OUTPUT_WINDOW) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (nums.length === 0) return null;
  const recent = nums.slice(-Math.max(1, Number(windowSize) || ROLLING_OUTPUT_WINDOW));
  recent.sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  return recent.length % 2 === 1
    ? Math.round(recent[mid])
    : Math.round((recent[mid - 1] + recent[mid]) / 2);
}

/**
 * Linearly shrinks an early rolling requests/turn median toward a prior (`2.0` structural tool-round
 * placeholder, or median `requests/turn` over >= 1 local deduplicated Claude Code transcript).
 * When `>= 2` observed turns agree closely (relative spread `(max - min) / med <= maxSpread`),
 * halves the effective shrinkage horizon (`Math.max(2, minTrustedTurns / 2)`, i.e. `2.5` at default `5`,
 * giving `w = 0.8` at `n = 2`).
 *
 * @param {number | null} rollingMedianRpt
 * @param {number} sampleSize
 * @param {object} [options={}]
 */
export function shrinkRollingRequestsPerTurn(rollingMedianRpt, sampleSize, options = {}) {
  const minTurnsRaw = Number(options.minTrustedTurns);
  const minTrustedTurns =
    Number.isFinite(minTurnsRaw) && minTurnsRaw > 0
      ? Math.round(minTurnsRaw)
      : MIN_TRUSTED_RPT_TURNS;
  const maxSpreadRaw = Number(options.agreementMaxRelativeSpread);
  const maxSpread =
    Number.isFinite(maxSpreadRaw) && maxSpreadRaw >= 0
      ? maxSpreadRaw
      : RPT_AGREEMENT_MAX_RELATIVE_SPREAD;
  const hasLocalPrior =
    options.priorSource === 'local_transcripts' &&
    Number.isFinite(Number(options.priorRequestsPerTurn)) &&
    Number(options.priorRequestsPerTurn) >= 1;
  const priorRaw = Number(options.priorRequestsPerTurn);
  const priorRequestsPerTurn =
    Number.isFinite(priorRaw) && priorRaw > 0
      ? Number(priorRaw.toFixed(4))
      : DEFAULT_RPT_SHRINKAGE_PRIOR;
  const isPlaceholderShrinkagePrior = !hasLocalPrior;
  const shrinkagePriorProvenance = hasLocalPrior
    ? 'local_claude_code_transcripts_median_rpt'
    : RPT_SHRINKAGE_PRIOR_METADATA.provenance;

  const recentCounts = Array.isArray(options.recentTurnRequestCounts)
    ? options.recentTurnRequestCounts
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
        .slice(-ROLLING_OUTPUT_WINDOW)
    : [];
  const computeAgreeingStats = (slice) => {
    if (!Array.isArray(slice) || slice.length < 2) return null;
    const sortedCounts = [...slice].sort((a, b) => a - b);
    const mid = Math.floor(sortedCounts.length / 2);
    const medR =
      sortedCounts.length % 2 === 1
        ? sortedCounts[mid]
        : (sortedCounts[mid - 1] + sortedCounts[mid]) / 2;
    const minR = sortedCounts[0];
    const maxR = sortedCounts[sortedCounts.length - 1];
    const relativeSpread = medR > 0 ? (maxR - minR) / medR : Infinity;
    return { agreed: relativeSpread <= maxSpread, median: medR, length: slice.length };
  };

  const fullStats = computeAgreeingStats(recentCounts);
  const turnsAgree = Boolean(fullStats?.agreed);

  const effectiveMinTrustedTurns = turnsAgree
    ? Math.max(2, Number((minTrustedTurns / 2).toFixed(4)))
    : minTrustedTurns;

  const count = Math.max(0, Math.round(Number(sampleSize) || 0));
  const rawMedian = Number(rollingMedianRpt);
  if (!Number.isFinite(rawMedian) || rawMedian <= 0 || count === 0) {
    return {
      expectedRequestsPerTurn: priorRequestsPerTurn,
      rawRollingMedianRequestsPerTurn: null,
      sampleSize: 0,
      shrinkageWeight: 0,
      minTrustedTurns,
      effectiveMinTrustedTurns,
      turnsAgree: false,
      trailingRegimeDetected: false,
      priorRequestsPerTurn,
      effectiveSmoothingK: effectiveMinTrustedTurns,
      isPlaceholderShrinkagePrior,
      shrinkagePriorProvenance,
      source: hasLocalPrior ? 'local_transcript_rpt_prior' : 'placeholder_rpt_prior_2.0'
    };
  }

  // Detect a stabilized trailing regime shift (e.g. [2,2,2,1,1] setup -> Q&A) without unlocking early growth extrapolation
  let trailingStats = null;
  if (!turnsAgree && recentCounts.length >= 4) {
    for (let k = recentCounts.length - 1; k >= 2; k--) {
      const candidate = computeAgreeingStats(recentCounts.slice(-k));
      if (candidate?.agreed) {
        trailingStats = candidate;
        break;
      }
    }
  }
  if (trailingStats && Math.abs(trailingStats.median - rawMedian) > 1e-6) {
    const trailingMed = Number(trailingStats.median.toFixed(4));
    const isStepDown = trailingMed < rawMedian;
    const agreedHorizon = Math.max(2, Number((minTrustedTurns / 2).toFixed(4)));
    const wTrail = isStepDown ? 1 : Math.min(1, trailingStats.length / agreedHorizon);
    const expectedTrail = isStepDown
      ? Math.max(1, trailingMed)
      : Math.max(1, Number((wTrail * trailingMed + (1 - wTrail) * priorRequestsPerTurn).toFixed(4)));
    const effectiveSmoothTrail = isStepDown
      ? Math.max(0, effectiveMinTrustedTurns - Math.min(effectiveMinTrustedTurns, count))
      : Math.max(0, agreedHorizon - Math.min(agreedHorizon, trailingStats.length));
    return {
      expectedRequestsPerTurn: expectedTrail,
      rawRollingMedianRequestsPerTurn: Number(rawMedian.toFixed(4)),
      sampleSize: count,
      shrinkageWeight: Number(wTrail.toFixed(4)),
      minTrustedTurns,
      effectiveMinTrustedTurns,
      turnsAgree: false,
      trailingRegimeDetected: true,
      trailingRegimeLength: trailingStats.length,
      trailingRegimeMedian: trailingMed,
      priorRequestsPerTurn,
      effectiveSmoothingK: Number(effectiveSmoothTrail.toFixed(4)),
      isPlaceholderShrinkagePrior,
      shrinkagePriorProvenance,
      source: isStepDown ? 'stop_hook_trailing_regime_rpt' : 'stop_hook_trailing_regime_shrunk_rpt'
    };
  }

  const weight = Math.min(1, count / effectiveMinTrustedTurns);
  const blended = Math.max(
    1,
    Number((weight * rawMedian + (1 - weight) * priorRequestsPerTurn).toFixed(4))
  );
  return {
    expectedRequestsPerTurn: blended,
    rawRollingMedianRequestsPerTurn: Number(rawMedian.toFixed(4)),
    sampleSize: count,
    shrinkageWeight: Number(weight.toFixed(4)),
    minTrustedTurns,
    effectiveMinTrustedTurns,
    turnsAgree,
    trailingRegimeDetected: false,
    priorRequestsPerTurn,
    effectiveSmoothingK: Number(
      Math.max(0, effectiveMinTrustedTurns - Math.min(effectiveMinTrustedTurns, count)).toFixed(4)
    ),
    isPlaceholderShrinkagePrior,
    shrinkagePriorProvenance,
    source:
      weight >= 1
        ? 'stop_hook_rolling_rpt_median'
        : turnsAgree
          ? 'stop_hook_agreed_shrunk_rpt_median'
          : 'stop_hook_shrunk_rpt_median'
  };
}

/**
 * Resolves `~/.attention-horizon/cache/sessions/cal_<safeId>.json` (or explicit `options.calibrationPath`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {string}
 */
export function getSessionCalibrationPath(sessionId = 'default', options = {}) {
  if (typeof options.calibrationPath === 'string' && options.calibrationPath.trim()) {
    return options.calibrationPath.trim();
  }
  const home = resolveCalibrationHomeDir(options);
  const safeId = sanitizeSessionId(sessionId);
  return path.join(home, '.attention-horizon', 'cache', 'sessions', `cal_${safeId}.json`);
}

/**
 * Parses a Claude Code JSONL transcript read-only (`'r'`), deduplicating streaming assistant
 * rows by `message.id` and extracting completed turn counts, rolling median output tokens,
 * and initial prefix size without retaining any prompt or response prose.
 *
 * @param {string} transcriptPath
 * @returns {{
 *   turnsCompleted: number,
 *   apiCallsCompleted: number,
 *   rollingMedianOutputTokens: number | null,
 *   rollingMedianOutputTokensPerCall: number | null,
 *   recentTurnOutputs: number[],
 *   initialPrefixTokens: number | null,
 *   latestContextTokens: number | null
 * } | null}
 */
/**
 * Checks whether a Claude Code transcript `user` record represents a real human prompt
 * (excluding tool results and synthetic `/model` or local-command UI rows).
 * @param {object} obj
 * @returns {boolean}
 */
export function isRealHumanUserTranscriptEntry(obj) {
  if (obj?.type !== 'user' || (obj?.message?.role !== 'user' && obj?.message)) {
    return false;
  }
  if (obj?.isMeta === true || obj?.isCompactSummary === true) {
    return false;
  }
  const content = obj?.message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return (
      trimmed.length > 0 &&
      !/^<(?:local-command-|command-name>)/.test(trimmed) &&
      !trimmed.startsWith('This session is being continued from a previous conversation')
    );
  }
  return Array.isArray(content) && content.some((b) => b && b.type !== 'tool_result');
}

export function parseSessionTranscriptCalibration(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
    return null;
  }
  let fd = null;
  let raw = '';
  try {
    fd = fs.openSync(transcriptPath, 'r');
    raw = fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors on read-only transcript fd
      }
    }
  }

  let currentTurnBucket = 0;
  const byMsgId = new Map();
  let lineIdx = 0;

  for (const line of raw.split(/\r?\n/)) {
    lineIdx += 1;
    if (!line || !line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (isRealHumanUserTranscriptEntry(obj)) {
      currentTurnBucket += 1;
      continue;
    }

    if (obj?.type === 'assistant' && obj?.message?.usage) {
      const msg = obj.message;
      const u = msg.usage;
      const msgId = msg.id ? String(msg.id) : `anon_line_${lineIdx}`;
      const prev = byMsgId.get(msgId);
      const outTok = Number(u.output_tokens || 0);
      const inTok = Number(u.input_tokens || 0);
      const cwTok = Number(u.cache_creation_input_tokens || 0);
      const crTok = Number(u.cache_read_input_tokens || 0);
      const turnBucket = prev ? prev.turnBucket : currentTurnBucket > 0 ? currentTurnBucket : byMsgId.size + 1;

      if (!prev) {
        byMsgId.set(msgId, {
          turnBucket,
          outputTokens: outTok,
          inputTokens: inTok,
          cacheCreationTokens: cwTok,
          cacheReadTokens: crTok
        });
      } else {
        byMsgId.set(msgId, {
          turnBucket: prev.turnBucket,
          outputTokens: Math.max(prev.outputTokens, outTok),
          inputTokens: outTok >= prev.outputTokens ? inTok : prev.inputTokens,
          cacheCreationTokens: outTok >= prev.outputTokens ? cwTok : prev.cacheCreationTokens,
          cacheReadTokens: outTok >= prev.outputTokens ? crTok : prev.cacheReadTokens
        });
      }
    }
  }

  const orderedMsgs = Array.from(byMsgId.values());
  const perCallOutputs = orderedMsgs.map((m) => m.outputTokens);
  const turnSums = new Map();
  const turnCallCounts = new Map();
  const turnMsgGroups = new Map();
  for (const m of orderedMsgs) {
    turnSums.set(m.turnBucket, (turnSums.get(m.turnBucket) || 0) + m.outputTokens);
    turnCallCounts.set(m.turnBucket, (turnCallCounts.get(m.turnBucket) || 0) + 1);
    if (!turnMsgGroups.has(m.turnBucket)) turnMsgGroups.set(m.turnBucket, []);
    turnMsgGroups.get(m.turnBucket).push(m);
  }
  const sortedTurnGroups = Array.from(turnMsgGroups.entries()).sort((a, b) => a[0] - b[0]);
  const turnPromptGrowths = [];
  let prevEndContext = null;
  for (const [, msgs] of sortedTurnGroups) {
    const firstMsgInTurn = msgs[0];
    const lastMsgInTurn = msgs[msgs.length - 1];
    const firstPrompt =
      firstMsgInTurn.inputTokens +
      firstMsgInTurn.cacheCreationTokens +
      firstMsgInTurn.cacheReadTokens;
    const endContext =
      lastMsgInTurn.inputTokens +
      lastMsgInTurn.cacheCreationTokens +
      lastMsgInTurn.cacheReadTokens +
      lastMsgInTurn.outputTokens;
    const prevBoundary = prevEndContext === null ? firstPrompt : prevEndContext;
    const growth = endContext - prevBoundary;
    if (Number.isFinite(growth) && growth >= 0) {
      turnPromptGrowths.push(Math.round(growth));
    }
    prevEndContext = endContext;
  }
  const turnOutputs = Array.from(turnSums.values());
  const turnRequestCounts = Array.from(turnCallCounts.values());
  const recentTurnOutputs = turnOutputs.slice(-ROLLING_OUTPUT_WINDOW);
  const recentTurnRequestCounts = turnRequestCounts.slice(-ROLLING_OUTPUT_WINDOW);
  const recentTurnPromptGrowths = turnPromptGrowths.slice(-ROLLING_OUTPUT_WINDOW);

  const firstMsg = orderedMsgs[0] || null;
  const lastMsg = orderedMsgs[orderedMsgs.length - 1] || null;
  const initialPrefixTokens = firstMsg
    ? firstMsg.inputTokens + firstMsg.cacheCreationTokens + firstMsg.cacheReadTokens
    : null;
  const latestContextTokens = lastMsg
    ? lastMsg.inputTokens +
      lastMsg.cacheCreationTokens +
      lastMsg.cacheReadTokens +
      lastMsg.outputTokens
    : null;

  const turnsCompleted = turnOutputs.length;
  const apiCallsCompleted = byMsgId.size;
  return {
    turnsCompleted,
    apiCallsCompleted,
    outputSampleSize: recentTurnOutputs.length,
    rptSampleSize: recentTurnRequestCounts.length,
    promptGrowthSampleSize: recentTurnPromptGrowths.length,
    requestsPerTurn:
      turnsCompleted > 0 && apiCallsCompleted > 0
        ? Number((apiCallsCompleted / turnsCompleted).toFixed(4))
        : null,
    rollingMedianRequestsPerTurn: computeRollingMedianFloat(
      recentTurnRequestCounts,
      ROLLING_OUTPUT_WINDOW
    ),
    recentTurnRequestCounts,
    rollingMedianOutputTokens: computeRollingMedian(recentTurnOutputs, ROLLING_OUTPUT_WINDOW),
    rollingMedianOutputTokensPerCall: computeRollingMedian(perCallOutputs, ROLLING_OUTPUT_WINDOW),
    recentTurnOutputs,
    rollingMedianPromptGrowthTokens: computeRollingMedianNonNegative(
      recentTurnPromptGrowths,
      ROLLING_OUTPUT_WINDOW
    ),
    recentTurnPromptGrowths,
    initialPrefixTokens:
      Number.isFinite(initialPrefixTokens) && initialPrefixTokens > 0 ? initialPrefixTokens : null,
    latestContextTokens:
      Number.isFinite(latestContextTokens) && latestContextTokens > 0 ? latestContextTokens : null
  };
}

/**
 * Updates persisted Stop-hook calibration metrics from `event.transcript_path` or direct `output_tokens`.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function updateSessionCalibrationOnStop(event = {}, options = {}) {
  const sessionId = event.session_id || event.sessionId || 'default';
  const calPath = getSessionCalibrationPath(sessionId, options);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const txPath = event.transcript_path || event.transcriptPath;

  if (typeof txPath === 'string' && txPath.trim() && fs.existsSync(txPath)) {
    const parsed = parseSessionTranscriptCalibration(txPath);
    if (parsed) {
      const record = {
        sessionId,
        updatedAtMs: nowMs,
        source: 'stop_transcript',
        ...parsed
      };
      writeJsonAtomic(calPath, record, options);
      return record;
    }
  }

  const stopHookActive = Boolean(event.stop_hook_active ?? event.stopHookActive);
  const directOut = Number(
    event.output_tokens ?? event.outputTokens ?? event.usage?.output_tokens ?? 0
  );
  if (!stopHookActive && Number.isFinite(directOut) && directOut > 0) {
    const prev = readJsonSafe(calPath, null, options);
    const prevOutputs = Array.isArray(prev?.recentTurnOutputs) ? prev.recentTurnOutputs : [];
    const recentTurnOutputs = [...prevOutputs, Math.round(directOut)].slice(-ROLLING_OUTPUT_WINDOW);
    const prevRpts = Array.isArray(prev?.recentTurnRequestCounts) ? prev.recentTurnRequestCounts : [];
    const directRptRaw = Number(event.requests_in_turn ?? event.requestsInTurn ?? 1);
    const directRpt = Number.isFinite(directRptRaw) && directRptRaw >= 1 ? Math.round(directRptRaw) : 1;
    const recentTurnRequestCounts = [...prevRpts, directRpt].slice(-ROLLING_OUTPUT_WINDOW);
    const directContextRaw = Number(event.context_tokens ?? event.contextTokens ?? 0);
    const prevGrowths = Array.isArray(prev?.recentTurnPromptGrowths) ? prev.recentTurnPromptGrowths : [];
    let recentTurnPromptGrowths = prevGrowths;
    let latestContextTokens = prev?.latestContextTokens ?? null;
    if (Number.isFinite(directContextRaw) && directContextRaw > 0) {
      const roundedCtx = Math.round(directContextRaw);
      if (Number.isFinite(Number(prev?.latestContextTokens)) && Number(prev.latestContextTokens) > 0) {
        const delta = roundedCtx - Number(prev.latestContextTokens);
        if (delta >= 0) {
          recentTurnPromptGrowths = [...prevGrowths, delta].slice(-ROLLING_OUTPUT_WINDOW);
        }
      }
      latestContextTokens = roundedCtx;
    }
    const turnsCompleted = Number(prev?.turnsCompleted || 0) + 1;
    const apiCallsCompleted = Number(prev?.apiCallsCompleted || 0) + directRpt;
    const record = {
      sessionId,
      updatedAtMs: nowMs,
      source: 'stop_direct_usage',
      turnsCompleted,
      apiCallsCompleted,
      outputSampleSize: recentTurnOutputs.length,
      rptSampleSize: recentTurnRequestCounts.length,
      promptGrowthSampleSize: recentTurnPromptGrowths.length,
      requestsPerTurn:
        turnsCompleted > 0 && apiCallsCompleted > 0
          ? Number((apiCallsCompleted / turnsCompleted).toFixed(4))
          : null,
      rollingMedianRequestsPerTurn: computeRollingMedianFloat(
        recentTurnRequestCounts,
        ROLLING_OUTPUT_WINDOW
      ),
      recentTurnRequestCounts,
      rollingMedianOutputTokens: computeRollingMedian(recentTurnOutputs, ROLLING_OUTPUT_WINDOW),
      rollingMedianOutputTokensPerCall: computeRollingMedian(recentTurnOutputs, ROLLING_OUTPUT_WINDOW),
      recentTurnOutputs,
      rollingMedianPromptGrowthTokens: computeRollingMedianNonNegative(
        recentTurnPromptGrowths,
        ROLLING_OUTPUT_WINDOW
      ),
      recentTurnPromptGrowths,
      initialPrefixTokens: prev?.initialPrefixTokens ?? null,
      latestContextTokens
    };
    writeJsonAtomic(calPath, record, options);
    return record;
  }

  return null;
}

/**
 * Reads persisted Stop-hook calibration snapshot or falls back read-only to `event.transcript_path`.
 *
 * @param {string} [sessionId='default']
 * @param {object} [event={}]
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function readSessionCalibration(sessionId = 'default', event = {}, options = {}) {
  const canCheckCache = Boolean(
    options.homeDir ||
      options.calibrationPath ||
      event.cwd ||
      options.cwd ||
      event.transcript_path ||
      event.transcriptPath ||
      event.session_id ||
      event.sessionId
  );

  if (canCheckCache) {
    const calPath = getSessionCalibrationPath(sessionId, options);
    const cached = readJsonSafe(calPath, null, options);
    if (cached && typeof cached === 'object') {
      const sampleSize =
        cached.outputSampleSize ??
        (Array.isArray(cached.recentTurnOutputs)
          ? cached.recentTurnOutputs.length
          : Number(cached.turnsCompleted || 0));
      const turns = Number(cached.turnsCompleted || 0);
      const calls = Number(cached.apiCallsCompleted || 0);
      const rpt =
        cached.requestsPerTurn ??
        (turns > 0 && calls > 0 ? Number((calls / turns).toFixed(4)) : null);
      const rptSampleSize =
        cached.rptSampleSize ??
        (Array.isArray(cached.recentTurnRequestCounts)
          ? cached.recentTurnRequestCounts.length
          : turns);
      const rollingMedianRequestsPerTurn =
        cached.rollingMedianRequestsPerTurn ??
        (Array.isArray(cached.recentTurnRequestCounts)
          ? computeRollingMedianFloat(cached.recentTurnRequestCounts, ROLLING_OUTPUT_WINDOW)
          : rpt);
      const promptGrowthSampleSize =
        cached.promptGrowthSampleSize ??
        (Array.isArray(cached.recentTurnPromptGrowths) ? cached.recentTurnPromptGrowths.length : 0);
      const rollingMedianPromptGrowthTokens =
        cached.rollingMedianPromptGrowthTokens !== undefined
          ? cached.rollingMedianPromptGrowthTokens
          : Array.isArray(cached.recentTurnPromptGrowths)
            ? computeRollingMedianNonNegative(cached.recentTurnPromptGrowths, ROLLING_OUTPUT_WINDOW)
            : null;
      return {
        ...cached,
        outputSampleSize: Number.isFinite(Number(sampleSize)) ? Number(sampleSize) : 0,
        rptSampleSize: Number.isFinite(Number(rptSampleSize)) ? Number(rptSampleSize) : 0,
        promptGrowthSampleSize: Number.isFinite(Number(promptGrowthSampleSize))
          ? Number(promptGrowthSampleSize)
          : 0,
        requestsPerTurn: rpt,
        rollingMedianRequestsPerTurn,
        rollingMedianPromptGrowthTokens
      };
    }
  }

  const txPath = event.transcript_path || event.transcriptPath;
  if (typeof txPath === 'string' && txPath.trim() && fs.existsSync(txPath)) {
    const parsed = parseSessionTranscriptCalibration(txPath);
    if (parsed) {
      return {
        sessionId,
        source: 'transcript_fallback',
        ...parsed
      };
    }
  }

  return null;
}
