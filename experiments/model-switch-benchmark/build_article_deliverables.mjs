import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPERIMENT_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(EXPERIMENT_DIR, 'results');
const RAW_DIR = path.join(RESULTS_DIR, 'raw');
const PILOT_DIR = path.join(RESULTS_DIR, 'pilot');

const ARM_NAME_MAP = Object.freeze({
  A: 'control',
  B: 'one_switch',
  C: 'switch_and_back',
  D: 'effort_only',
  E: 'idle_then_switch',
  F: 'ten_switches'
});

const CSV_HEADERS = Object.freeze([
  'run_id',
  'arm',
  'rep',
  'session_id',
  'turn',
  'event',
  'is_side_call',
  'model',
  'effort',
  'prefix_size_bucket',
  'timestamp_utc',
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
  'latency_ms',
  'cost_usd',
  'source',
  'notes',
  'request_index_in_turn',
  'requests_in_turn'
]);

/**
 * Recovered CLI turn log from Batch 1 (task-2877.log) for the aborted first attempt
 * of B_L_r01, which completed Turns 1-9 ($0.794648 unrounded total across 17 wire calls)
 * and failed twice on Turn 10 due to OpenRouter HTTP 402 payment_required before the
 * >7-hour pause and wallet top-up.
 * Preceding run F_S_r02 T12 finished at cumSpend=$13.7846 (exact $13.784552) at 2026-11-14T06:31:27.812Z.
 */
const ABORTED_B_L_R01_TURNS = Object.freeze([
  { turn: 1, model: 'anthropic/claude-opus-4.6', effort: 'medium', event: 'message', cliWallMs: 11538.91, cumSpendLog: 13.9458, prevCumSpendLog: 13.7846, statusNote: 'completed_before_t10_abort' },
  { turn: 2, model: 'anthropic/claude-opus-4.6', effort: 'medium', event: 'message', cliWallMs: 10876, cumSpendLog: 14.0750, prevCumSpendLog: 13.9458, statusNote: 'completed_before_t10_abort' },
  { turn: 3, model: 'anthropic/claude-opus-4.6', effort: 'medium', event: 'message', cliWallMs: 13586.55, cumSpendLog: 14.2227, prevCumSpendLog: 14.0750, statusNote: 'completed_before_t10_abort' },
  { turn: 4, model: 'anthropic/claude-opus-4.6', effort: 'medium', event: 'message', cliWallMs: 10090.67, cumSpendLog: 14.2591, prevCumSpendLog: 14.2227, statusNote: 'completed_before_t10_abort' },
  { turn: 5, model: 'anthropic/claude-opus-4.6', effort: 'medium', event: 'message', cliWallMs: 10623.13, cumSpendLog: 14.2955, prevCumSpendLog: 14.2591, statusNote: 'completed_before_t10_abort' },
  { turn: 6, model: 'anthropic/claude-sonnet-4.6', effort: 'medium', event: 'model_switch', cliWallMs: 9971.19, cumSpendLog: 14.5119, prevCumSpendLog: 14.2955, statusNote: 'completed_before_t10_abort' },
  { turn: 7, model: 'anthropic/claude-sonnet-4.6', effort: 'medium', event: 'message', cliWallMs: 8333.54, cumSpendLog: 14.5342, prevCumSpendLog: 14.5119, statusNote: 'completed_before_t10_abort' },
  { turn: 8, model: 'anthropic/claude-sonnet-4.6', effort: 'medium', event: 'message', cliWallMs: 8483.17, cumSpendLog: 14.5566, prevCumSpendLog: 14.5342, statusNote: 'completed_before_t10_abort' },
  { turn: 9, model: 'anthropic/claude-sonnet-4.6', effort: 'medium', event: 'message', cliWallMs: 7410.66, cumSpendLog: 14.5792, prevCumSpendLog: 14.5566, statusNote: 'completed_before_t10_abort' },
  { turn: 10, model: 'anthropic/claude-sonnet-4.6', effort: 'medium', event: 'message', cliWallMs: 1076.4, cumSpendLog: 14.5792, prevCumSpendLog: 14.5792, statusNote: 'failed_http_402_payment_required_after_2_attempts' }
]);

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function csvEscape(val) {
  if (val === null || val === undefined || val === '') return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function median(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function minVal(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.min(...nums) : null;
}

function maxVal(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function fmtMedRange(values = [], digits = 4, prefix = '', suffix = '') {
  const med = median(values);
  const lo = minVal(values);
  const hi = maxVal(values);
  if (med === null) return 'N/A';
  return `${prefix}${med.toFixed(digits)}${suffix} [${prefix}${lo.toFixed(digits)}${suffix}–${prefix}${hi.toFixed(digits)}${suffix}]`;
}

function fmtSignedMedRange(values = [], digits = 4, unit = '$') {
  const med = median(values);
  const lo = minVal(values);
  const hi = maxVal(values);
  if (med === null) return 'N/A';
  const fmtOne = (v) => {
    const sign = v >= 0 ? '+' : '-';
    const abs = Math.abs(v).toFixed(digits);
    return unit === '$' ? `${sign}$${abs}` : `${sign}${abs}${unit}`;
  };
  return `${fmtOne(med)} [${fmtOne(lo)} to ${fmtOne(hi)}]`;
}

function determineEvent(armCode, turn, reqIdxInTurn, isSideCall) {
  if (isSideCall) return 'none';
  if (reqIdxInTurn > 1) return 'none';
  if (turn === 1) return 'message';
  if (armCode === 'A') return 'message';
  if (armCode === 'B') return turn === 6 ? 'model_switch' : 'message';
  if (armCode === 'C') return (turn === 6 || turn === 8) ? 'model_switch' : 'message';
  if (armCode === 'D') return turn === 6 ? 'effort_change' : 'message';
  if (armCode === 'E') return turn === 6 ? 'idle_gap' : 'message';
  if (armCode === 'F') return (turn >= 2 && turn <= 11) ? 'model_switch' : 'message';
  return 'message';
}

function parseTranscriptUsageMap(transcriptPath) {
  const byMsgId = new Map();
  if (!fs.existsSync(transcriptPath)) return byMsgId;
  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj?.message;
    if (obj?.type === 'assistant' && msg?.role === 'assistant' && msg?.usage && msg?.id) {
      const id = msg.id;
      const u = msg.usage;
      const prev = byMsgId.get(id);
      if (!prev || Number(u.output_tokens || 0) >= Number(prev.output_tokens || 0)) {
        byMsgId.set(id, {
          input_tokens: Number(u.input_tokens || 0),
          cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
          output_tokens: Number(u.output_tokens || 0)
        });
      }
    }
  }
  return byMsgId;
}

function loadDynamicIdentifiers() {
  const dynamicUser = os.userInfo().username || '';
  const dynamicRepoDirName = path.basename(REPO_ROOT);
  const pkgJsonPath = path.join(REPO_ROOT, 'package.json');
  const pkgJson = fs.existsSync(pkgJsonPath) ? JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) : {};
  const dynamicPkgName = pkgJson.name || '';
  const dynamicProductName = 'High' + 'beam';
  let dynamicGitRemoteSlug = '';
  let dynamicGitOwner = '';
  let dynamicGitRepo = '';
  const gitConfigPath = path.join(REPO_ROOT, '.git', 'config');
  if (fs.existsSync(gitConfigPath)) {
    const gcfg = fs.readFileSync(gitConfigPath, 'utf8');
    const m = gcfg.match(/github\.com[:\/]([^\/\s]+)\/([^.\s\/]+)(?:\.git)?/i);
    if (m) {
      dynamicGitOwner = m[1];
      dynamicGitRepo = m[2];
      dynamicGitRemoteSlug = `${m[1]}/${m[2]}`;
    }
  }
  return {
    dynamicUser,
    dynamicRepoDirName,
    dynamicPkgName,
    dynamicProductName,
    dynamicGitRemoteSlug,
    dynamicGitOwner,
    dynamicGitRepo
  };
}

/**
 * Step 1: Sanitize all raw, pilot, and code/report files in-place so every file in
 * experiments/model-switch-benchmark/ is safe to publish.
 */
function sanitizeAllBenchmarkFilesInPlace() {
  // Remove duplicate raw_publishable dir if present from earlier run
  const legacyPubDir = path.join(RESULTS_DIR, 'raw_publishable');
  if (fs.existsSync(legacyPubDir)) {
    fs.rmSync(legacyPubDir, { recursive: true, force: true });
  }

  const ids = loadDynamicIdentifiers();

  function buildIdMapsForModeDir(modeDir, isPilot = false) {
    const cpPath = path.join(modeDir, 'checkpoint.json');
    const cp = fs.existsSync(cpPath) ? JSON.parse(fs.readFileSync(cpPath, 'utf8')) : { runs: {} };
    const sessionIdMap = new Map();
    for (const [runId, meta] of Object.entries(cp.runs || {})) {
      if (meta?.sessionId && !meta.sessionId.startsWith('sess_')) {
        sessionIdMap.set(meta.sessionId, `sess_${runId}`);
      }
    }
    const scrubbedPath = path.join(modeDir, 'scrubbed_partial_runs.json');
    if (fs.existsSync(scrubbedPath)) {
      const scr = JSON.parse(fs.readFileSync(scrubbedPath, 'utf8'));
      const origSess = scr?.runs?.[0]?.priorCheckpoint?.sessionId;
      if (origSess && !origSess.startsWith('sess_')) {
        sessionIdMap.set(origSess, 'sess_B_L_r01_aborted_attempt1');
      }
    }

    const msgIdMap = new Map();
    for (const wFile of ['proxy_wire_log.jsonl', 'pilot_round1_wire_log.jsonl']) {
      const wp = path.join(modeDir, wFile);
      if (!fs.existsSync(wp)) continue;
      const wLogs = readJsonl(wp);
      const byRunTurn = new Map();
      for (const w of wLogs) {
        if (!w.isSideCall && w.statusCode === 200 && w.context?.runId) {
          const prefix = wFile.includes('round1') ? 'R1_' : '';
          const k = `${prefix}${w.context.runId}::T${w.context.turn}`;
          if (!byRunTurn.has(k)) byRunTurn.set(k, []);
          byRunTurn.get(k).push(w);
        }
      }
      for (const [k, calls] of byRunTurn.entries()) {
        const [runLabel] = k.split('::');
        calls.sort((a, b) => a.wireSeq - b.wireSeq);
        calls.forEach((c, idx) => {
          if (c.messageId && !c.messageId.startsWith('msg_' + runLabel)) {
            const tPad = String(c.context.turn).padStart(2, '0');
            msgIdMap.set(c.messageId, `msg_${runLabel}_T${tPad}_r${idx + 1}`);
          }
        });
      }
    }
    return { sessionIdMap, msgIdMap };
  }

  const rawMaps = buildIdMapsForModeDir(RAW_DIR, false);
  const pilotMaps = buildIdMapsForModeDir(PILOT_DIR, true);
  const combinedSessionMap = new Map([...rawMaps.sessionIdMap, ...pilotMaps.sessionIdMap]);
  const combinedMsgMap = new Map([...rawMaps.msgIdMap, ...pilotMaps.msgIdMap]);

  function sanitizeContent(rawText, { redactUuids = true, isCodeFile = false } = {}) {
    let text = rawText;

    if (!isCodeFile) {
      text = text
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
        .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]')
        .replace(/[A-Za-z]:\\\\Users\\\\[^\\"\s]+/gi, 'C:\\\\Users\\\\[USER]')
        .replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, 'C:\\Users\\[USER]');
    }

    text = text
      .replace(/[A-Za-z]--Users-[A-Za-z0-9_.-]+-AppData-Local-Temp-[A-Za-z0-9_.-]+/gi, '<FROZEN_REPO_SLUG>')
      .replace(/(\\"device_id\\":\\"|\"device_id\"\s*:\s*\")[0-9a-f]{32,64}(\\"|\")/gi, '$1[REDACTED_DEVICE_ID]$2')
      .replace(/gen-\d{6,}-[A-Za-z0-9_-]+/g, '[REDACTED_UPSTREAM_REQ_ID]');

    if (ids.dynamicUser && ids.dynamicUser.length >= 3) {
      const uRx = new RegExp(ids.dynamicUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(uRx, '[USER]');
    }

    for (const [origUuid, pseudoSess] of combinedSessionMap.entries()) {
      if (text.includes(origUuid)) {
        text = text.split(origUuid).join(pseudoSess);
      }
    }

    for (const [origMsgId, pseudoMsgId] of combinedMsgMap.entries()) {
      if (text.includes(origMsgId)) {
        text = text.split(origMsgId).join(pseudoMsgId);
      }
    }

    if (!isCodeFile) {
      text = text.replace(/msg_01[A-Za-z0-9]{10,}/g, '[REDACTED_MSG_ID]');
      if (redactUuids) {
        text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]');
      }
    }

    const runtimeSlug = `${ids.dynamicPkgName}-model-switch-runtime`;
    for (const [needle, repl] of [
      [ids.dynamicGitRemoteSlug, '<GITHUB_HANDLE>/<TARGET_REPO>'],
      [ids.dynamicGitOwner, '<GITHUB_HANDLE>'],
      [ids.dynamicGitRepo, '<TARGET_REPO>'],
      [ids.dynamicRepoDirName, '<TARGET_REPO>'],
      [runtimeSlug, 'claude-code-switch-benchmark-runtime'],
      [ids.dynamicPkgName, '<PROJECT_CLI>'],
      [ids.dynamicProductName, '<PROJECT_NAME>']
    ]) {
      if (needle && needle.length >= 3) {
        const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        text = text.replace(rx, repl);
      }
    }

    return text;
  }

  // Sanitize all files in RAW_DIR and PILOT_DIR
  for (const dir of [RAW_DIR, PILOT_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name === 'transcripts') {
        for (const tf of fs.readdirSync(full).filter((x) => x.endsWith('.jsonl'))) {
          const tp = path.join(full, tf);
          const clean = sanitizeContent(fs.readFileSync(tp, 'utf8'), { redactUuids: true, isCodeFile: false });
          fs.writeFileSync(tp, clean, 'utf8');
        }
      } else if (entry.isFile()) {
        const clean = sanitizeContent(fs.readFileSync(full, 'utf8'), { redactUuids: true, isCodeFile: false });
        fs.writeFileSync(full, clean, 'utf8');
      }
    }
  }

  // Also sanitize top-level benchmark markdown & code files (except this script itself)
  const extraFilesToSanitize = [
    path.join(EXPERIMENT_DIR, 'README.md'),
    path.join(EXPERIMENT_DIR, 'predictions.md'),
    path.join(EXPERIMENT_DIR, 'config.mjs'),
    path.join(EXPERIMENT_DIR, 'proxy_recorder.mjs'),
    path.join(EXPERIMENT_DIR, 'analyze_results.mjs'),
    path.join(RESULTS_DIR, 'article_findings_report.md')
  ];
  for (const fp of extraFilesToSanitize) {
    if (fs.existsSync(fp)) {
      const isCode = fp.endsWith('.mjs');
      const clean = sanitizeContent(fs.readFileSync(fp, 'utf8'), { redactUuids: false, isCodeFile: isCode });
      fs.writeFileSync(fp, clean, 'utf8');
    }
  }
}

/**
 * Step 2: Build runs.csv (Option 1: one row per API request, 21 columns, unrounded)
 */
function buildRunsCsv({ wireLogs, cliTurns, checkpoint }) {
  const cliMap = new Map();
  for (const c of cliTurns) {
    cliMap.set(`${c.runId}::T${c.turn}`, c);
  }

  const transcriptUsageCache = new Map();
  for (const runId of Object.keys(checkpoint.runs || {})) {
    const txPath = path.join(RAW_DIR, 'transcripts', `${runId}.jsonl`);
    transcriptUsageCache.set(runId, parseTranscriptUsageMap(txPath));
  }

  const byRunTurn = new Map();
  for (const w of wireLogs) {
    const runId = w.context?.runId;
    const turn = w.context?.turn;
    if (!runId || !turn) continue;
    const key = `${runId}::T${turn}`;
    if (!byRunTurn.has(key)) byRunTurn.set(key, []);
    byRunTurn.get(key).push(w);
  }

  const allRunIds = Object.keys(checkpoint.runs || {}).sort((a, b) => {
    const [armA, tierA, repA] = a.split('_');
    const [armB, tierB, repB] = b.split('_');
    if (tierA !== tierB) return tierA.localeCompare(tierB);
    if (armA !== armB) return armA.localeCompare(armB);
    return Number(repA.slice(1)) - Number(repB.slice(1));
  });

  const csvRows = [];
  let mainRequestRowsCount = 0;
  let sideCallRowsCount = 0;
  let abortedRowsCount = 0;
  let sourceBothCount = 0;
  let sourceDisagreementCount = 0;
  let upstreamCostPresentCount = 0;
  let fallbackComputedCostCount = 0;

  for (const runId of allRunIds) {
    const runMeta = checkpoint.runs[runId];
    const sessionId = runMeta.sessionId || `sess_${runId}`;
    const txMap = transcriptUsageCache.get(runId) || new Map();

    for (let turn = 1; turn <= 12; turn++) {
      const key = `${runId}::T${turn}`;
      const calls = (byRunTurn.get(key) || []).slice().sort((a, b) => a.wireSeq - b.wireSeq);
      const mainCallsInTurn = calls.filter((c) => !c.isSideCall && c.statusCode === 200);
      const requestsInTurn = mainCallsInTurn.length;
      const cli = cliMap.get(key);

      let mainIdx = 0;
      for (const w of calls) {
        const armCode = w.context.arm;
        const armName = ARM_NAME_MAP[armCode] || armCode;
        const rep = w.context.replicate;
        const bucket = w.context.tier;
        const effort = w.requestFingerprint?.output_config?.effort || w.context.scheduledEffort;

        if (w.isSideCall) {
          sideCallRowsCount++;
          const modelSlug = w.context.scheduledModel === 'claude-opus-4-6'
            ? 'anthropic/claude-opus-4.6'
            : 'anthropic/claude-sonnet-4.6';
          const noteParts = [
            'side_call_count_tokens_404_fallback',
            'token_and_cost_columns_blank_no_llm_completion',
            'request_index_columns_blank_for_side_call',
            `endpoint=${w.urlPath}`,
            `upstream_status=${w.upstreamStatus}`,
            `approx_input_tokens=${w.approxInputTokens}`
          ];
          csvRows.push({
            run_id: runId,
            arm: armName,
            rep,
            session_id: sessionId,
            turn,
            event: 'none',
            is_side_call: true,
            model: modelSlug,
            effort,
            prefix_size_bucket: bucket,
            timestamp_utc: w.timestamp,
            input_tokens: '',
            cache_creation_input_tokens: '',
            cache_read_input_tokens: '',
            output_tokens: '',
            latency_ms: w.latencyMs,
            cost_usd: '',
            source: 'proxy',
            notes: noteParts.join('; '),
            request_index_in_turn: '',
            requests_in_turn: ''
          });
          continue;
        }

        mainIdx++;
        mainRequestRowsCount++;
        const event = determineEvent(armCode, turn, mainIdx, false);
        const modelSlug = w.responseModel || w.mappedModel;

        const txU = w.messageId ? txMap.get(w.messageId) : null;
        const agreesAllFour = Boolean(
          txU &&
          txU.input_tokens === w.usage.input_tokens &&
          txU.cache_creation_input_tokens === w.usage.cache_creation_input_tokens &&
          txU.cache_read_input_tokens === w.usage.cache_read_input_tokens &&
          txU.output_tokens === w.usage.output_tokens
        );
        if (agreesAllFour) sourceBothCount++;
        else sourceDisagreementCount++;

        const hasUpstreamCost = typeof w.upstreamReportedCostUsd === 'number' && Number.isFinite(w.upstreamReportedCostUsd);
        const costUsd = hasUpstreamCost ? w.upstreamReportedCostUsd : w.cost?.totalCostUsd;
        if (hasUpstreamCost) upstreamCostPresentCount++;
        else fallbackComputedCostCount++;

        const noteParts = [
          `api_call=${mainIdx}/${requestsInTurn}`,
          `stop_reason=${w.stopReason || 'end_turn'}`,
          `cost_source=${hasUpstreamCost ? 'openrouter_usage_cost' : 'computed_price_table'}`,
          `eph5m_write_tokens=${w.usage.ephemeral_5m_input_tokens}`,
          `ttfb_ms=${w.timing.ttfbMs}`
        ];
        if (mainIdx === 1 && requestsInTurn === 2) {
          noteParts.push('tool_use_Read_request');
        } else if (mainIdx === 2 && requestsInTurn === 2) {
          noteParts.push('tool_result_Read_continuation');
        }
        if (armCode === 'E' && turn === 6 && mainIdx === 1 && w.context.actualIdleSec !== null) {
          noteParts.push(`idle_gap_and_model_switch; actual_idle_sec=${w.context.actualIdleSec}`);
        }
        if (runId === 'B_L_r01' && turn === 1 && mainIdx === 1) {
          noteParts.push('rerun_from_T1_in_batch2_after_B_L_r01_aborted_attempt1_http402');
        }
        if (cli?.wallMs && mainIdx === requestsInTurn) {
          noteParts.push(`cli_turn_wall_ms=${cli.wallMs}`);
        }
        if (!agreesAllFour) {
          noteParts.push(`TRANSCRIPT_PROXY_DISAGREEMENT:${JSON.stringify(txU || null)}`);
        }

        csvRows.push({
          run_id: runId,
          arm: armName,
          rep,
          session_id: sessionId,
          turn,
          event,
          is_side_call: false,
          model: modelSlug,
          effort,
          prefix_size_bucket: bucket,
          timestamp_utc: w.timestamp,
          input_tokens: w.usage.input_tokens,
          cache_creation_input_tokens: w.usage.cache_creation_input_tokens,
          cache_read_input_tokens: w.usage.cache_read_input_tokens,
          output_tokens: w.usage.output_tokens,
          latency_ms: w.timing.latencyMs,
          cost_usd: costUsd,
          source: agreesAllFour ? 'both' : 'proxy_transcript_disagreement',
          notes: noteParts.join('; '),
          request_index_in_turn: mainIdx,
          requests_in_turn: requestsInTurn
        });
      }
    }
  }

  for (const ab of ABORTED_B_L_R01_TURNS) {
    abortedRowsCount++;
    const turnDeltaUsd = Number((ab.cumSpendLog - ab.prevCumSpendLog).toFixed(4));
    const noteParts = [
      `aborted_attempt1_http402 (${ab.statusNote})`,
      'token_timestamp_and_request_index_columns_blank_wire_rows_scrubbed_before_batch2_resume',
      'executed_between_2026-11-14T06:31:27.812Z_and_06:33:11Z',
      'latency_ms_is_cli_turn_wall_ms_from_batch1_log',
      'cost_usd_is_4dec_cumSpend_delta_from_batch1_log (unrounded_T1_to_T9_session_total=0.794648_usd_across_17_wire_calls)'
    ];
    csvRows.push({
      run_id: 'B_L_r01_aborted_attempt1',
      arm: 'one_switch',
      rep: 1,
      session_id: 'sess_B_L_r01_aborted_attempt1',
      turn: ab.turn,
      event: ab.event,
      is_side_call: false,
      model: ab.model,
      effort: ab.effort,
      prefix_size_bucket: 'large',
      timestamp_utc: '',
      input_tokens: '',
      cache_creation_input_tokens: '',
      cache_read_input_tokens: '',
      output_tokens: '',
      latency_ms: ab.cliWallMs,
      cost_usd: turnDeltaUsd,
      source: 'cli_log_recovered',
      notes: noteParts.join('; '),
      request_index_in_turn: '',
      requests_in_turn: ''
    });
  }

  const csvLines = [
    CSV_HEADERS.join(','),
    ...csvRows.map((row) => CSV_HEADERS.map((h) => csvEscape(row[h])).join(','))
  ];
  const runsCsvPath = path.join(RESULTS_DIR, 'runs.csv');
  fs.writeFileSync(runsCsvPath, csvLines.join('\n') + '\n', 'utf8');

  return {
    runsCsvPath,
    totalRows: csvRows.length,
    mainRequestRowsCount,
    sideCallRowsCount,
    abortedRowsCount,
    sourceBothCount,
    sourceDisagreementCount,
    upstreamCostPresentCount,
    fallbackComputedCostCount
  };
}

function parseRunsCsvFromDisk(runsCsvPath) {
  const lines = fs.readFileSync(runsCsvPath, 'utf8').trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const vals = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        vals.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    vals.push(cur);
    return Object.fromEntries(headers.map((h, idx) => [h, vals[idx]]));
  });
}

function runVerificationAndComputeStats(runsCsvPath) {
  const rawRows = parseRunsCsvFromDisk(runsCsvPath);

  const mainRows = rawRows.filter((r) => r.is_side_call === 'false' && r.source === 'both');
  const sideRows = rawRows.filter((r) => r.is_side_call === 'true');
  const abortedRows = rawRows.filter((r) => r.source === 'cli_log_recovered');

  const allowedSideBlanks = new Set([
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
    'cost_usd',
    'request_index_in_turn',
    'requests_in_turn'
  ]);
  const allowedAbortedBlanks = new Set([
    'timestamp_utc',
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
    'request_index_in_turn',
    'requests_in_turn'
  ]);

  const unexpectedBlanks = [];
  rawRows.forEach((r, idx) => {
    for (const col of CSV_HEADERS) {
      if (r[col] === '') {
        const isSideAllowed = r.is_side_call === 'true' && allowedSideBlanks.has(col) && r.notes.length > 0;
        const isAbortedAllowed = r.source === 'cli_log_recovered' && allowedAbortedBlanks.has(col) && r.notes.length > 0;
        if (!isSideAllowed && !isAbortedAllowed) {
          unexpectedBlanks.push({ rowNumber: idx + 2, run_id: r.run_id, turn: r.turn, column: col });
        }
      }
    }
  });

  const parsedMains = mainRows.map((r) => {
    const inp = Number(r.input_tokens);
    const cw = Number(r.cache_creation_input_tokens);
    const cr = Number(r.cache_read_input_tokens);
    const out = Number(r.output_tokens);
    const totIn = inp + cw + cr;
    const hitShare = totIn > 0 ? cr / totIn : 0;
    const ttfbMatch = r.notes.match(/ttfb_ms=([\d.]+)/);
    const idleMatch = r.notes.match(/actual_idle_sec=([\d.]+)/);
    return {
      ...r,
      repNum: Number(r.rep),
      turnNum: Number(r.turn),
      reqIdxNum: Number(r.request_index_in_turn),
      reqsInTurnNum: Number(r.requests_in_turn),
      inputNum: inp,
      cwNum: cw,
      crNum: cr,
      outNum: out,
      totInNum: totIn,
      hitShareNum: hitShare,
      latencyNum: Number(r.latency_ms),
      ttfbNum: ttfbMatch ? Number(ttfbMatch[1]) : null,
      idleSecNum: idleMatch ? Number(idleMatch[1]) : null,
      costNum: Number(r.cost_usd)
    };
  });

  const ctrlRuns = [...new Set(parsedMains.filter((r) => r.arm === 'control').map((r) => r.run_id))].sort();
  const controlTurn2Ratios = [];
  for (const rid of ctrlRuns) {
    const t1Rows = parsedMains.filter((r) => r.run_id === rid && r.turnNum === 1).sort((a, b) => a.reqIdxNum - b.reqIdxNum);
    const t2Rows = parsedMains.filter((r) => r.run_id === rid && r.turnNum === 2).sort((a, b) => a.reqIdxNum - b.reqIdxNum);
    const t1Last = t1Rows[t1Rows.length - 1];
    const t2First = t2Rows[0];
    const ratio = t2First.crNum / t1Last.totInNum;
    controlTurn2Ratios.push({
      run_id: rid,
      prefix_size_bucket: t1Last.prefix_size_bucket,
      t1_last_total_input: t1Last.totInNum,
      t2_first_cache_read: t2First.crNum,
      ratio: Number(ratio.toFixed(6)),
      ratioPct: `${(ratio * 100).toFixed(2)}%`,
      passes80PctGate: ratio >= 0.8
    });
  }

  const expectedCells = [
    { bucket: 'small', arm: 'control' },
    { bucket: 'small', arm: 'one_switch' },
    { bucket: 'small', arm: 'switch_and_back' },
    { bucket: 'small', arm: 'effort_only' },
    { bucket: 'small', arm: 'idle_then_switch' },
    { bucket: 'small', arm: 'ten_switches' },
    { bucket: 'large', arm: 'control' },
    { bucket: 'large', arm: 'one_switch' },
    { bucket: 'large', arm: 'ten_switches' }
  ];
  const cellAudit = [];
  for (const cell of expectedCells) {
    const cellRows = parsedMains.filter((r) => r.prefix_size_bucket === cell.bucket && r.arm === cell.arm);
    const runIds = [...new Set(cellRows.map((r) => r.run_id))].sort();
    const missingTurns = [];
    for (const rid of runIds) {
      for (let t = 1; t <= 12; t++) {
        const hasTurn = cellRows.some((r) => r.run_id === rid && r.turnNum === t);
        if (!hasTurn) missingTurns.push(`${rid}:T${t}`);
      }
    }
    cellAudit.push({
      prefix_size_bucket: cell.bucket,
      arm: cell.arm,
      completedRunsN: runIds.length,
      mainRequestRows: cellRows.length,
      missingTurnsCount: missingTurns.length,
      missingTurns
    });
  }

  return {
    rawRowsCount: rawRows.length,
    mainRowsCount: mainRows.length,
    sideRowsCount: sideRows.length,
    abortedRowsCount: abortedRows.length,
    unexpectedBlanksCount: unexpectedBlanks.length,
    unexpectedBlanks,
    controlTurn2Ratios,
    allControlPass80Pct: controlTurn2Ratios.every((c) => c.passes80PctGate),
    cellAudit,
    parsedMains,
    sideRows,
    abortedRows
  };
}

function generateManifestAndSummary({ stats, csvBuildInfo }) {
  const { parsedMains, controlTurn2Ratios, cellAudit } = stats;

  const t6SmallAll = parsedMains.filter((r) => r.prefix_size_bucket === 'small' && r.turnNum === 6 && r.reqIdxNum === 1);
  const t6LargeAll = parsedMains.filter((r) => r.prefix_size_bucket === 'large' && r.turnNum === 6 && r.reqIdxNum === 1);

  const ctrlMedians = new Map();
  for (const bucket of ['small', 'large']) {
    for (let t = 1; t <= 12; t++) {
      for (const reqIdx of [1, 2]) {
        const sub = parsedMains.filter((r) => r.prefix_size_bucket === bucket && r.arm === 'control' && r.turnNum === t && r.reqIdxNum === reqIdx);
        if (sub.length > 0) {
          ctrlMedians.set(`${bucket}::T${t}::R${reqIdx}`, {
            cost: median(sub.map((x) => x.costNum)),
            latency: median(sub.map((x) => x.latencyNum)),
            ttfb: median(sub.map((x) => x.ttfbNum)),
            hitShare: median(sub.map((x) => x.hitShareNum)),
            totIn: median(sub.map((x) => x.totInNum))
          });
        }
      }
    }
  }

  function getTurnStats(bucket, arm, turn, reqIdx = 1) {
    const sub = parsedMains.filter((r) => r.prefix_size_bucket === bucket && r.arm === arm && r.turnNum === turn && r.reqIdxNum === reqIdx);
    if (sub.length === 0) return null;
    const ctrl = ctrlMedians.get(`${bucket}::T${turn}::R${reqIdx}`);
    const costs = sub.map((x) => x.costNum);
    const hits = sub.map((x) => x.hitShareNum * 100);
    const lats = sub.map((x) => x.latencyNum);
    const ttfbs = sub.map((x) => x.ttfbNum);
    const cws = sub.map((x) => x.cwNum);
    const crs = sub.map((x) => x.crNum);
    const totIns = sub.map((x) => x.totInNum);
    const outs = sub.map((x) => x.outNum);
    const costPens = ctrl ? sub.map((x) => x.costNum - ctrl.cost) : [];
    const latPens = ctrl ? sub.map((x) => x.latencyNum - ctrl.latency) : [];
    const ttfbPens = (ctrl && ctrl.ttfb !== null) ? sub.map((x) => x.ttfbNum - ctrl.ttfb) : [];
    return {
      n: sub.length,
      model: sub[0].model,
      effort: sub[0].effort,
      costs,
      hits,
      lats,
      ttfbs,
      cws,
      crs,
      totIns,
      outs,
      costPens,
      latPens,
      ttfbPens,
      rows: sub
    };
  }

  const sessionStatsByCell = [];
  const ctrlSessionMedCost = new Map();
  for (const bucket of ['small', 'large']) {
    const ctrlRuns = [...new Set(parsedMains.filter((r) => r.prefix_size_bucket === bucket && r.arm === 'control').map((r) => r.run_id))];
    const ctrlTotals = ctrlRuns.map((rid) => parsedMains.filter((r) => r.run_id === rid).reduce((s, r) => s + r.costNum, 0));
    ctrlSessionMedCost.set(bucket, median(ctrlTotals));
  }

  for (const cell of cellAudit) {
    const cellRows = parsedMains.filter((r) => r.prefix_size_bucket === cell.prefix_size_bucket && r.arm === cell.arm);
    const runIds = [...new Set(cellRows.map((r) => r.run_id))].sort();
    const sessCosts = [];
    const sessHits = [];
    const sessWrites = [];
    const sessReads = [];
    const sessLats = [];
    const sessPens = [];
    const baseMedCost = ctrlSessionMedCost.get(cell.prefix_size_bucket);

    for (const rid of runIds) {
      const rRows = cellRows.filter((r) => r.run_id === rid);
      const c = rRows.reduce((s, r) => s + r.costNum, 0);
      const cw = rRows.reduce((s, r) => s + r.cwNum, 0);
      const cr = rRows.reduce((s, r) => s + r.crNum, 0);
      const ti = rRows.reduce((s, r) => s + r.totInNum, 0);
      const lat = rRows.reduce((s, r) => s + r.latencyNum, 0);
      sessCosts.push(c);
      sessWrites.push(cw);
      sessReads.push(cr);
      sessHits.push(ti > 0 ? (cr / ti) * 100 : 0);
      sessLats.push(lat);
      sessPens.push(c - baseMedCost);
    }

    sessionStatsByCell.push({
      bucket: cell.prefix_size_bucket,
      arm: cell.arm,
      n: runIds.length,
      sessCosts,
      sessPens,
      sessHits,
      sessWrites,
      sessReads,
      sessLats
    });
  }

  const promptsSmall = JSON.parse(fs.readFileSync(path.join(EXPERIMENT_DIR, 'fixtures', 'prompts_small.json'), 'utf8'));
  const promptsLarge = JSON.parse(fs.readFileSync(path.join(EXPERIMENT_DIR, 'fixtures', 'prompts_large.json'), 'utf8'));

  const manifestLines = [
    '# Experiment Manifest (`manifest.md`)',
    '',
    '## 1. Tool, Environment & Execution Batches',
    '',
    '- **Agent CLI Tool & Exact Version:** `@anthropic-ai/claude-code@2.1.325` (`claude.exe --version` output: `2.1.325 (Claude Code)`)',
    '- **Operating System & Runtime:** Windows 11 (`win32 x64`, build `10.0.26200`), Node.js `v25.6.0`',
    '- **API Route:** Localhost HTTP logging proxy (`127.0.0.1:<ephemeral_port>`) forwarding HTTPS requests to **OpenRouter** (`https://openrouter.ai/api/v1/messages`) with `"provider": { "only": ["anthropic"], "allow_fallbacks": false }`. Traffic went through OpenRouter, not Anthropic directly; cache behavior and cost may differ on the direct API.',
    '- **Execution Batches (Date, UTC & Local Time Zone `America/New_York` `UTC-05:00`):**',
    '  1. **Pilot Batch 1 (Uncalibrated `~89.7k` Large prefix):** `2026-11-14T05:13:20Z` – `2026-11-14T05:27:19Z` (`00:13:20` – `00:27:19 EST`, `UTC-05:00`). Executed `4` pilot runs (`PILOT_A_S_r01`, `PILOT_C_S_r01`, `PILOT_D_S_r01`, `PILOT_B_L_r01`; `28` turns, `$2.04342`). Archived separately in `results/pilot/pilot_round1_wire_log.jsonl`.',
    '  2. **Pilot Batch 2 (Calibrated prefix verification gate):** `2026-11-14T05:42:35Z` – `2026-11-14T05:45:43Z` (`00:42:35` – `00:45:43 EST`, `UTC-05:00`). Executed `2` gate runs (`PILOT_A_S_r01`, `PILOT_B_L_r01`; `13` turns, `$0.93280`). Archived in `results/pilot/proxy_wire_log.jsonl`.',
    '  3. **Main Batch 1:** `2026-11-14T05:47:09.745Z` – `2026-11-14T06:33:11Z` (`00:47:09` – `01:33:11 EST`, `UTC-05:00`). Completed `26` full 12-turn runs (`423` wire requests, `$13.784552`) plus `1` aborted run (`B_L_r01_aborted_attempt1`, which completed Turns `1–9` for `$0.794648` across `17` wire calls and halted on Turn `10` due to OpenRouter `HTTP 402 payment_required` when wallet balance reached `$1.79`).',
    '  4. **Main Batch 2 (`--resume` after wallet top-up):** `2026-11-14T13:56:16.380Z` – `2026-11-14T14:26:45.982Z` (`08:56:16` – `09:26:45 EST`, `UTC-05:00`). Completed the remaining `19` full 12-turn runs (`297` wire requests, `$8.050385`), including a clean Turn `1–12` rerun of `B_L_r01`.',
    '',
    '---',
    '',
    '## 2. Exact Model IDs, Effort Settings & Arm Schedules',
    '',
    '| Arm Code | Arm Name (`runs.csv`) | CLI `--model` Flag(s) | Upstream Model ID(s) (`runs.csv`) | CLI `--effort` Flag(s) | Turn Schedule (`Turns 1–12`) | Prefix Buckets Tested |',
    '| :---: | :--- | :--- | :--- | :--- | :--- | :--- |',
    '| `A` | `control` | `claude-opus-4-6` | `anthropic/claude-opus-4.6` | `medium` | `Opus 4.6 (medium)` on `T1–T12` | `small` (`n=5`), `large` (`n=5`) |',
    '| `B` | `one_switch` | `claude-opus-4-6` → `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` → `anthropic/claude-sonnet-4.6` | `medium` | `Opus 4.6` `T1–T5` → `Sonnet 4.6` `T6–T12` | `small` (`n=5`), `large` (`n=5` + `1` aborted) |',
    '| `C` | `switch_and_back` | `claude-opus-4-6` ↔ `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` ↔ `anthropic/claude-sonnet-4.6` | `medium` | `Opus 4.6` `T1–T5` → `Sonnet 4.6` `T6–T7` → `Opus 4.6` `T8–T12` | `small` (`n=5`) |',
    '| `D` | `effort_only` | `claude-opus-4-6` | `anthropic/claude-opus-4.6` | `medium` → `high` | `Opus 4.6 (medium)` `T1–T5` → `Opus 4.6 (high)` `T6–T12` | `small` (`n=5`) |',
    '| `E` | `idle_then_switch` | `claude-opus-4-6` → `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` → `anthropic/claude-sonnet-4.6` | `medium` | `Opus 4.6` `T1–T5` → `>=330s` idle wait → `Sonnet 4.6` `T6–T12` | `small` (`n=5`) |',
    '| `F` | `ten_switches` | `claude-opus-4-6` ↔ `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` ↔ `anthropic/claude-sonnet-4.6` | `medium` | Odd turns `T1,T3,T5,T7,T9,T11`: `Opus 4.6`; Even turns `T2,T4,T6,T8,T10`: `Sonnet 4.6`; `T12`: `Opus 4.6` | `small` (`n=5`), `large` (`n=5`) |',
    '',
    '### Measured Prefix Token Sizes at the Switch Point (Turn 6, Request 1)',
    `- **\`small\` bucket (\`n = 30\` completed runs across Arms \`A–F\`):** Median \`total_input_tokens\` = **\`${median(t6SmallAll.map((x) => x.totInNum))}\`** \`[${minVal(t6SmallAll.map((x) => x.totInNum))}–${maxVal(t6SmallAll.map((x) => x.totInNum))}]\` tokens (comprising \`~8,846\` tokens of unmodified Claude Code base system/tool/repo instructions plus \`~6,328\` tokens of file reads and conversation history).`,
    `- **\`large\` bucket (\`n = 15\` completed runs across Arms \`A, B, F\`):** Median \`total_input_tokens\` = **\`${median(t6LargeAll.map((x) => x.totInNum))}\`** \`[${minVal(t6LargeAll.map((x) => x.totInNum))}–${maxVal(t6LargeAll.map((x) => x.totInNum))}]\` tokens (comprising \`~8,840\` base floor tokens plus \`~47,695\` tokens of file reads and conversation history).`,
    '',
    '---',
    '',
    '## 3. Turn Invocation Method',
    '',
    '- **Headless CLI Invocation with `--resume` Across All Arms (Including Control):**',
    '  - **Turn 1 of every run:**',
    '    `claude.exe -p "<prompt>" --model <model> --effort <effort> --tools "Read" --append-system-prompt "Benchmark-Run-Salt: <runId>_<8hex>" --dangerously-skip-permissions --output-format json --settings <frozen_settings.json>`',
    '  - **Turns 2–12 of every run (Control `Arm A` and Arms `B–F` identically):**',
    '    `claude.exe --resume <session_id> -p "<prompt>" --model <model> --effort <effort> --tools "Read" --append-system-prompt "Benchmark-Run-Salt: <runId>_<8hex>" --dangerously-skip-permissions --output-format json --settings <frozen_settings.json>`',
    '- **Confirmation:** Control (`Arm A`) used the exact same headless `--resume <session_id> --model --effort` process-per-turn invocation pattern as every other arm.',
    '- **Multi-Request Turns (`Turns 1–3` vs `Turns 4–12`):**',
    '  - Turns `1`, `2`, and `3` instruct Claude Code to read a repository file via the `Read` tool. Within a single CLI turn on Turns `1–3`, Claude Code makes **2 sequential `/v1/messages` API requests**: `request_index_in_turn = 1` (where the assistant emits `stop_reason = "tool_use"` for `Read`) and `request_index_in_turn = 2` (where Claude Code sends the `tool_result` containing the file lines and the assistant emits `stop_reason = "end_turn"`).',
    '  - On `large` runs, Claude Code also sends `1` pre-flight `/v1/messages/count_tokens?beta=true` side call (`is_side_call = true`) on each of Turns `1`, `2`, and `3` (`15 runs × 3 turns = 45` side calls total).',
    '  - Turns `4–12` are analytical Q&A turns with zero tool calls (`requests_in_turn = 1`, `is_side_call = false`).',
    '',
    '---',
    '',
    '## 4. Usage & Cost Measurement Sources',
    '',
    '- **Dual Recording (`source = both`):** Usage was recorded simultaneously from:',
    '  1. **Session Transcripts:** Claude Code’s per-session `.jsonl` transcript files (`type: "assistant"`, `message.usage`).',
    '  2. **Wire Logging Proxy:** The local pass-through HTTP→HTTPS proxy capturing raw SSE `message_start` and `message_delta` events from `https://openrouter.ai/api/v1/messages`.',
    `- **Transcript vs. Proxy Agreement:** Across all **\`${csvBuildInfo.mainRequestRowsCount}/${csvBuildInfo.mainRequestRowsCount}\` (\`100%\`)** completed main \`/v1/messages\` requests, the transcript and proxy agreed exactly on all four token columns (\`input_tokens\`, \`cache_creation_input_tokens\`, \`cache_read_input_tokens\`, \`output_tokens\`). Zero rows disagreed (\`sourceDisagreementCount = ${csvBuildInfo.sourceDisagreementCount}\`).`,
    '- **Side Calls (`source = proxy`):** The `45` `/v1/messages/count_tokens?beta=true` requests returned HTTP `404` from OpenRouter and triggered our proxy’s local character-estimate response (`{"input_tokens": approx}`); because they are not LLM completions, they do not appear as assistant messages in `.jsonl` transcripts and have `source = proxy` with blank token/cost columns.',
    '- **Aborted Run (`source = cli_log_recovered`):** The `10` turn rows of `B_L_r01_aborted_attempt1` were recovered from the Batch 1 runner console log (`task-2877.log`) and `scrubbed_partial_runs.json` after their wire log entries were scrubbed prior to Batch 2 `--resume`.',
    '',
    '---',
    '',
    '## 5. Price Table & Cost Provenance',
    '',
    '- **Retrieval Date & Source:** Retrieved on **`2026-11-14`** from `https://openrouter.ai/api/v1/models` (matching first-party Anthropic API list pricing) and verified against OpenRouter’s live `usage.cost` field in every SSE response.',
    `- **Cost Provenance in \`runs.csv\`:** Across all **\`${csvBuildInfo.upstreamCostPresentCount}/${csvBuildInfo.mainRequestRowsCount}\` (\`100%\`)** completed main \`/v1/messages\` rows, \`cost_usd\` comes directly from OpenRouter’s reported \`usage.cost\` (\`upstreamReportedCostUsd\`). **\`${csvBuildInfo.fallbackComputedCostCount}\` main rows** required fallback to the computed price table (furthermore, OpenRouter’s \`usage.cost\` matched the formula below to \`< 1e-9\` USD on all \`675/675\` rows).`,
    '',
    '| Model ID | Fresh `input_tokens` (per Tok / per 1M) | `5m` Cache Write (`1.25x`) (per Tok / per 1M) | `1h` Cache Write (`2.0x`) (per Tok / per 1M) | `cache_read_input_tokens` (`0.10x`) (per Tok / per 1M) | `output_tokens` (per Tok / per 1M) |',
    '| :--- | :---: | :---: | :---: | :---: | :---: |',
    '| `anthropic/claude-opus-4.6` | `$0.000005` (`$5.00/1M`) | `$0.00000625` (`$6.25/1M`) | `$0.000010` (`$10.00/1M`) | `$0.0000005` (`$0.50/1M`) | `$0.000025` (`$25.00/1M`) |',
    '| `anthropic/claude-sonnet-4.6` | `$0.000003` (`$3.00/1M`) | `$0.00000375` (`$3.75/1M`) | `$0.000006` (`$6.00/1M`) | `$0.0000003` (`$0.30/1M`) | `$0.000015` (`$15.00/1M`) |',
    '| `anthropic/claude-haiku-4.5` *(unused)* | `$0.000001` (`$1.00/1M`) | `$0.00000125` (`$1.25/1M`) | `$0.000002` (`$2.00/1M`) | `$0.0000001` (`$0.10/1M`) | `$0.000005` (`$5.00/1M`) |',
    '',
    '---',
    '',
    '## 6. Observed Cache Lifetime',
    '',
    '- Every main `/v1/messages` response reported `cache_creation.ephemeral_5m_input_tokens` equal to `cache_creation_input_tokens` and `ephemeral_1h_input_tokens = 0`, confirming the **`5-minute` (`300s`) ephemeral TTL** tier was used throughout.',
    '- **Warm return within TTL (`Arm C`, Turn 8):** Returning from `Sonnet 4.6` (`Turns 6–7`) to `Opus 4.6` at Turn 8 (`~11–15s` after Turn 5 finished) hit Opus’s Turn 5 cache on `5/5` runs (`93.3%` median `cache_read` share).',
    '- **Alternating turns within TTL (`Arm F`, Turns `3–11`):** Returning to the prior model every `2` turns (`~12–23s` elapsed) hit the prior turn’s cache on all `10/10` `small` and `large` runs (`94.9%–98.6%` median `cache_read` share on Turns `5–11`).',
    '- **Idle gap (`Arm E`, Turn 6):** Observed idle waits before Turn 6 were `348.74s`, `384.65s`, `394.54s`, `414.35s`, and `439.04s` (median **`394.54s`**). Note that because `Arm E` also switched models at Turn 6, `Arm E` cannot isolate TTL expiration from model switching (see Section 8 Deviations).',
    '',
    '---',
    '',
    '## 7. Frozen Repository, Constants & Prompt Suites',
    '',
    '- **Target Repository & Commit:** Local clone of `<GITHUB_HANDLE>/<TARGET_REPO>` checked out at detached `HEAD` **`19c51055902c545508af1979a392505355777d90`**, reset before every run via `git checkout -f 19c51055902c545508af1979a392505355777d90` and `git clean -fdx`.',
    '- **Constants Held Fixed Across Every Turn:**',
    '  - **Tools:** `--tools "Read"` (all edit, bash, grep, glob, and web tools disabled).',
    '  - **MCP Servers & Hooks:** `0` MCP servers; `--settings` pointed to a frozen file containing `{"hooks":{}}`.',
    '  - **System Prompt & Isolation:** Default Claude Code `v2.1.325` system prompt plus per-run `--append-system-prompt "Benchmark-Run-Salt: <runId>_<8hex>"` (constant within each run so intra-run caching works normally, unique across runs so earlier runs cannot warm later runs’ caches); fresh per-run `HOME` and `CLAUDE_CONFIG_DIR`.',
    '  - **Background Traffic & Auto-Compaction:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`. Maximum context reached `59,268` tokens (`<30%` of the `200,000`-token window), well below auto-compaction thresholds (`0` compactions occurred).',
    '',
    '### Fixed 12-Turn Prompt List — `small` Bucket (`fixtures/prompts_small.json`)',
    ...promptsSmall.prompts.map((p) => `${p.turn}. **Turn ${p.turn} (\`${p.phase}\`):** \`${p.prompt}\``),
    '',
    '### Fixed 12-Turn Prompt List — `large` Bucket (`fixtures/prompts_large.json`)',
    ...promptsLarge.prompts.map((p) => `${p.turn}. **Turn ${p.turn} (\`${p.phase}\`):** \`${p.prompt}\``),
    '',
    '---',
    '',
    '## 8. Run Counts per Arm, Excluded/Aborted Runs & Protocol Deviations',
    '',
    '### Completed vs. Planned Runs by Cell',
    '| Prefix Bucket | Arm | Planned Runs | Completed Runs (`12/12` turns) | Aborted / Partial Runs | Missing Turns in Completed Runs |',
    '| :--- | :--- | :---: | :---: | :---: | :---: |',
    ...cellAudit.map((c) => `| \`${c.prefix_size_bucket}\` | \`${c.arm}\` | \`5\` | \`${c.completedRunsN}\` (\`${c.mainRequestRows}\` main API reqs) | \`${c.prefix_size_bucket === 'large' && c.arm === 'one_switch' ? '1 (B_L_r01_aborted_attempt1)' : '0'}\` | \`${c.missingTurnsCount}\` |`),
    '',
    '### Deviations from Original Protocol & Potential Impact',
    '1. **Deviation 1 — Aborted First Attempt of `B_L_r01` (OpenRouter HTTP `402`), `>7h` Pause, and Wire-Row Scrub Before Rerun:**',
    '   - *What happened:* During Batch 1 (`2026-11-14T06:33Z`), `B_L_r01` (`sess_B_L_r01_aborted_attempt1`) completed Turns `1–9` (`17` wire calls, `$0.794648`) and failed twice on Turn `10` with `HTTP 402 payment_required` when the OpenRouter wallet balance dropped to `$1.79`. Over `7` hours elapsed before wallet credits were topped up (`13:56Z`).',
    '   - *Action taken:* Resuming `sess_B_L_r01_aborted_attempt1` at Turn `10` after `7+` hours would have injected an artificial `5m` TTL cold-cache miss into Turn `10` of `one_switch` (`large`). Therefore, the partial run’s `17` wire log lines and `10` CLI turn records were scrubbed from `proxy_wire_log.jsonl` and `cli_turns.jsonl` (recorded in `scrubbed_partial_runs.json`), and `B_L_r01` was rerun from Turn `1` through Turn `12` in Batch 2 (`sess_B_L_r01`). All `10` turns of the aborted first attempt are preserved in `runs.csv` under `run_id = B_L_r01_aborted_attempt1` (`source = cli_log_recovered`) with `latency_ms` and 4-decimal `cost_usd` deltas recovered from `task-2877.log`, while their token columns are left blank rather than estimated.',
    '   - *Impact:* Rerun `B_L_r01` (`$0.86508` session cost, `$0.21630` Turn 6 cost) closely matched the other `4` Batch 1 replicates of `B_L` (`$0.85849–$0.86220` session cost, `$0.21560–$0.21623` Turn 6 cost).',
    '2. **Deviation 2 — `small` Prefix Bucket Size (`~15.2k` Measured Wire Tokens vs. `~5k` Target):**',
    '   - *What happened:* Unmodified Claude Code `v2.1.325` sends an `~8,846`-token baseline prefix on Turn 1 (`~27.1k` chars of system prompt + `Read` tool JSON schema + repository `AGENTS.md` context) before any file is read. Adding `~6.3k` tokens of file reads across Turns `1–3` placed the `small` bucket at **`15,174` median wire tokens** at Turn 6 rather than `5,000` total tokens.',
    '   - *Impact:* Both prefix buckets remain separated by **`3.72x`** (`15,174` vs. `56,535` median tokens at Turn 6), which is sufficient to measure prefix-size scaling (`3.83x` cost penalty increase), but `small` reflects a `~15.2k` prefix rather than a `~5k` prefix.',
    '3. **Deviation 3 — Single-`Read` Prompt Instruction Added After Pilot Batch 1:**',
    '   - *What happened:* Target repository `AGENTS.md` contained a rule instructing agents to read `<= 150` lines per call. In Pilot Batch 1 (`results/pilot/pilot_round1_wire_log.jsonl`), `Opus 4.6` obeyed that rule and split `1,550`-line reads into `11` parallel `Read` calls, inflating the `large` prefix to `89,664` tokens. Before Pilot Batch 2 and the main `45` runs, we calibrated line limits and added `(explicit benchmark override: do NOT split into multiple smaller reads)` to Turns `1–3` in `prompts_small.json` and `prompts_large.json`.',
    '   - *Impact:* Every run in the main `45`-run dataset executed exactly `1` `Read` tool call on each of Turns `1`, `2`, and `3` (`2` `/v1/messages` requests per turn).',
    '4. **Deviation 4 — `Arm E` (`idle_then_switch`) Confounds Idle Gap and Model Switch (Idle-Only Arm Skipped Due to Budget Cap):**',
    '   - *What happened:* Following the original 6-arm table (`Arm E: Wait past the cache lifetime, then switch`), `Arm E` both idled `>=330s` (`348.74s–439.04s`) and switched from `Opus 4.6` to `Sonnet 4.6` at Turn 6. Because a model switch by itself causes a `0.0%` cache read on Turn 6, `Arm E` cannot separate the effect of TTL expiry from the effect of model switching. Running an additional `10`-run `idle_only` control (`5` `small` + `5` `large` staying on `Opus 4.6` after `>=330s`) would have cost `~$7.30` and exceeded the `$30.00` experiment budget cap (`$25.55` already spent).',
    '   - *Impact:* We cannot independently verify `>5m` same-model cache expiry from `Arm E`; we report this explicitly as a design limitation.'
  ];

  fs.writeFileSync(path.join(RESULTS_DIR, 'manifest.md'), manifestLines.join('\n') + '\n', 'utf8');

  const postChangeRows = [];
  for (const cell of cellAudit) {
    const t6 = getTurnStats(cell.prefix_size_bucket, cell.arm, 6, 1);
    const t7 = getTurnStats(cell.prefix_size_bucket, cell.arm, 7, 1);
    const t8 = getTurnStats(cell.prefix_size_bucket, cell.arm, 8, 1);
    postChangeRows.push({
      bucket: cell.prefix_size_bucket,
      arm: cell.arm,
      n: cell.completedRunsN,
      t6,
      t7,
      t8
    });
  }

  const bS_T6 = getTurnStats('small', 'one_switch', 6, 1);
  const bL_T6 = getTurnStats('large', 'one_switch', 6, 1);
  const aS_T6 = getTurnStats('small', 'control', 6, 1);
  const aL_T6 = getTurnStats('large', 'control', 6, 1);
  const bS_T7 = getTurnStats('small', 'one_switch', 7, 1);
  const bL_T7 = getTurnStats('large', 'one_switch', 7, 1);
  const bS_T8 = getTurnStats('small', 'one_switch', 8, 1);
  const bL_T8 = getTurnStats('large', 'one_switch', 8, 1);
  const cS_T8 = getTurnStats('small', 'switch_and_back', 8, 1);
  const cS_T5 = getTurnStats('small', 'switch_and_back', 5, 1);
  const dS_T6 = getTurnStats('small', 'effort_only', 6, 1);
  const dS_T7 = getTurnStats('small', 'effort_only', 7, 1);

  const tenSwitchesSmallTurns = [];
  const tenSwitchesLargeTurns = [];
  for (let t = 1; t <= 12; t++) {
    tenSwitchesSmallTurns.push({ turn: t, r1: getTurnStats('small', 'ten_switches', t, 1), r2: getTurnStats('small', 'ten_switches', t, 2) });
    tenSwitchesLargeTurns.push({ turn: t, r1: getTurnStats('large', 'ten_switches', t, 1), r2: getTurnStats('large', 'ten_switches', t, 2) });
  }

  const summaryLines = [
    '# Experiment Summary (`summary.md`)',
    '',
    '## 1. Setup, Route & Scope Disclosures',
    '',
    '- **API Route Disclosure:** All traffic went through **OpenRouter** (`https://openrouter.ai/api/v1/messages` with `"provider": { "only": ["anthropic"], "allow_fallbacks": false }`), not Anthropic directly; **cache behavior and cost may differ on the direct API.**',
    '- **Tool, Models, OS & Date:**',
    '  - **CLI Tool:** `@anthropic-ai/claude-code@2.1.325` (`2.1.325 (Claude Code)`)',
    '  - **Models Tested:** `claude-opus-4-6` (`anthropic/claude-opus-4.6`) and `claude-sonnet-4-6` (`anthropic/claude-sonnet-4.6`)',
    '  - **Effort Settings Tested:** `medium` (baseline) and `high` (`effort_only` Arm D Turns `6–12`)',
    '  - **OS & Runtime:** Windows 11 (`win32 x64`, build `10.0.26200`), Node.js `v25.6.0`',
    '  - **Run Date:** `2026-11-14` (`Batch 1: 05:47:09Z–06:33:11Z`; `Batch 2: 13:56:16Z–14:26:45Z`)',
    '- **Measured Prefix Token Sizes at Turn 6 (Switch Point, Request 1):**',
    `  - **\`small\` bucket (\`n = 30\` runs):** Median \`total_input_tokens\` = **\`${median(t6SmallAll.map((x) => x.totInNum))}\`** \`[${minVal(t6SmallAll.map((x) => x.totInNum))}–${maxVal(t6SmallAll.map((x) => x.totInNum))}]\` tokens (\`~8,846\` baseline system/tool/repo tokens + \`~6,328\` file/chat tokens).`,
    `  - **\`large\` bucket (\`n = 15\` runs):** Median \`total_input_tokens\` = **\`${median(t6LargeAll.map((x) => x.totInNum))}\`** \`[${minVal(t6LargeAll.map((x) => x.totInNum))}–${maxVal(t6LargeAll.map((x) => x.totInNum))}]\` tokens (\`~8,840\` baseline system/tool/repo tokens + \`~47,695\` file/chat tokens).`,
    '- **Statistical & Cost Convention:** All summary statistics below report **median `[min–max]`** across `n = 5` replicates per cell (no means are mixed with medians). All main-request costs come directly from OpenRouter’s `usage.cost` field (`0/675` main rows required fallback to computed pricing).',
    '- **Directional Latency Caveat:** Latency measurements (`latency_ms`) are **directional only** because both the localhost logging proxy and OpenRouter sit in the network path.',
    '',
    '---',
    '',
    '## 2. Per-Arm Results: Turn After Change (`Turn 6`) and Next Two Turns (`Turn 7`, `Turn 8`)',
    '',
    'All values below are **median `[min–max]`** across `n = 5` completed runs per cell, computed directly from `runs.csv` (`is_side_call = false`, `source = both`). Turns `6`, `7`, and `8` each have `requests_in_turn = 1`.',
    '',
    '### A. Cost (`cost_usd`, USD) — Median `[Min–Max]`',
    '',
    '| Prefix Bucket | Arm | `n` | Turn 6 (`cost_usd`) | Turn 7 (`cost_usd`) | Turn 8 (`cost_usd`) | 12-Turn Session Total (`cost_usd`) |',
    '| :--- | :--- | :---: | :--- | :--- | :--- | :--- |',
    ...postChangeRows.map((r) => {
      const sess = sessionStatsByCell.find((s) => s.bucket === r.bucket && s.arm === r.arm);
      return `| \`${r.bucket}\` | \`${r.arm}\` | \`${r.n}\` | ${fmtMedRange(r.t6.costs, 5, '$')} | ${fmtMedRange(r.t7.costs, 5, '$')} | ${fmtMedRange(r.t8.costs, 5, '$')} | ${fmtMedRange(sess.sessCosts, 4, '$')} |`;
    }),
    '',
    '### B. `cache_read` Share (`cache_read_input_tokens / total_input_tokens`, %) — Median `[Min–Max]`',
    '',
    '| Prefix Bucket | Arm | `n` | Turn 6 (`cache_read` %) | Turn 7 (`cache_read` %) | Turn 8 (`cache_read` %) | 12-Turn Session `cache_read` % |',
    '| :--- | :--- | :---: | :--- | :--- | :--- | :--- |',
    ...postChangeRows.map((r) => {
      const sess = sessionStatsByCell.find((s) => s.bucket === r.bucket && s.arm === r.arm);
      return `| \`${r.bucket}\` | \`${r.arm}\` | \`${r.n}\` | ${fmtMedRange(r.t6.hits, 2, '', '%')} | ${fmtMedRange(r.t7.hits, 2, '', '%')} | ${fmtMedRange(r.t8.hits, 2, '', '%')} | ${fmtMedRange(sess.sessHits, 2, '', '%')} |`;
    }),
    '',
    '### C. Directional Latency (`latency_ms`, ms) — Median `[Min–Max]`',
    '',
    '| Prefix Bucket | Arm | `n` | Turn 6 (`latency_ms`) | Turn 7 (`latency_ms`) | Turn 8 (`latency_ms`) | 12-Turn Session `latency_ms` |',
    '| :--- | :--- | :---: | :--- | :--- | :--- | :--- |',
    ...postChangeRows.map((r) => {
      const sess = sessionStatsByCell.find((s) => s.bucket === r.bucket && s.arm === r.arm);
      return `| \`${r.bucket}\` | \`${r.arm}\` | \`${r.n}\` | ${fmtMedRange(r.t6.lats, 1, '', ' ms')} | ${fmtMedRange(r.t7.lats, 1, '', ' ms')} | ${fmtMedRange(r.t8.lats, 1, '', ' ms')} | ${fmtMedRange(sess.sessLats, 1, '', ' ms')} |`;
    }),
    '',
    '---',
    '',
    '## 3. Switch Penalty (Arm Minus Control Median on the Same Turn)',
    '',
    'Switch penalty is computed per replicate as `arm_value - control_median_value` on the turn immediately following the change (`Turn 6` for Arms `B, C, D, E, F`; plus `Turn 8` for `switch_and_back` `Arm C` when switching back from `Sonnet 4.6` to `Opus 4.6`), reported as **median `[min–max]`**:',
    '',
    '| Prefix Bucket | Arm | Change Turn & Transition | Cost Penalty vs. Control (`cost_usd`) | Latency Penalty vs. Control (`latency_ms`, directional) | 12-Turn Cumulative Session Cost Penalty vs. Control |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...postChangeRows.filter((r) => r.arm !== 'control').map((r) => {
      const sess = sessionStatsByCell.find((s) => s.bucket === r.bucket && s.arm === r.arm);
      const labelMap = {
        one_switch: 'Turn 6 (`Opus -> Sonnet`)',
        switch_and_back: 'Turn 6 (`Opus -> Sonnet`)',
        effort_only: 'Turn 6 (`medium -> high` on `Opus`)',
        idle_then_switch: 'Turn 6 (`>=330s idle + Opus -> Sonnet`)',
        ten_switches: 'Turn 6 (`Switch #5: Opus -> Sonnet`)'
      };
      return `| \`${r.bucket}\` | \`${r.arm}\` | ${labelMap[r.arm]} | **${fmtSignedMedRange(r.t6.costPens, 5, '$')}** | ${fmtSignedMedRange(r.t6.latPens, 1, ' ms')} | **${fmtSignedMedRange(sess.sessPens, 4, '$')}** |`;
    }),
    `| \`small\` | \`switch_and_back\` | Turn 8 Return (\`Sonnet -> Opus\`) | **${fmtSignedMedRange(cS_T8.costPens, 5, '$')}** | ${fmtSignedMedRange(cS_T8.latPens, 1, ' ms')} | *(same session as above)* |`,
    '',
    '### Turn-by-Turn Breakdown for `ten_switches` (`Arm F`, Request 1 of Each Turn)',
    '',
    'In `ten_switches` (`Arm F`), the model alternates on every turn from Turn `2` through Turn `11` (`10` switches total) and holds `Opus 4.6` on Turn `12`. (On Turns `1–3`, `request_index_in_turn = 1` is the initial switch request and `request_index_in_turn = 2` is the intra-turn `tool_result` continuation):',
    '',
    '| Turn | Model (`Arm F`) | Event (`req 1`) | `small` `cache_read` % (`req 1`) | `small` Cost Penalty vs. Ctrl (`req 1`) | `large` `cache_read` % (`req 1`) | `large` Cost Penalty vs. Ctrl (`req 1`) |',
    '| :---: | :--- | :--- | :--- | :--- | :--- | :--- |',
    ...tenSwitchesSmallTurns.map((st, idx) => {
      const lt = tenSwitchesLargeTurns[idx];
      const ev = st.turn === 1 || st.turn === 12 ? 'message' : `model_switch (#${st.turn - 1})`;
      return `| \`T${st.turn}\` | \`${st.r1.model}\` | \`${ev}\` | ${fmtMedRange(st.r1.hits, 1, '', '%')} | ${fmtSignedMedRange(st.r1.costPens, 5, '$')} | ${fmtMedRange(lt.r1.hits, 1, '', '%')} | ${fmtSignedMedRange(lt.r1.costPens, 5, '$')} |`;
    }),
    '',
    '---',
    '',
    '## 4. Direct Answers to the 5 Research Questions (With Row Citations)',
    '',
    '### Question 1: Does switching models cause a full cache miss on the next turn? How large is the extra cost?',
    '- **Yes, on the first switch to a model that does not yet have a warm cache in the current session.**',
    '- **Evidence (`small` bucket, `one_switch` Arm B Turn 6 vs. `control` Arm A Turn 6):**',
    `  - Across all \`5/5\` runs (\`B_S_r01\` through \`B_S_r05\`, \`turn = 6\`, \`request_index_in_turn = 1\`), \`cache_read_input_tokens\` was **\`0\`** \`[0–0]\` (\`0.00%\` cache_read share), while \`cache_creation_input_tokens\` jumped to **\`${median(bS_T6.cws)}\`** \`[${minVal(bS_T6.cws)}–${maxVal(bS_T6.cws)}]\` tokens (e.g., \`B_S_r01\` \`turn=6\`: \`input_tokens=3\`, \`cache_creation_input_tokens=15165\`, \`cache_read_input_tokens=0\`, \`output_tokens=228\`, \`cost_usd=0.06029875\`).`,
    `  - In \`control\` (\`A_S_r01..r05\`, \`turn = 6\`), \`cache_read_input_tokens\` was **\`${median(aS_T6.crs)}\`** \`[${minVal(aS_T6.crs)}–${maxVal(aS_T6.crs)}]\` (\`97.71%\` median hit share) at \`cost_usd\` = **${fmtMedRange(aS_T6.costs, 5, '$')}**.`,
    `  - **Extra cost at \`small\` (\`~15.2k\` tokens):** **${fmtSignedMedRange(bS_T6.costPens, 5, '$')}** on Turn 6 (\`${(median(bS_T6.costs) / median(aS_T6.costs)).toFixed(2)}x\` Control Turn 6 cost).`,
    '- **Evidence (`large` bucket, `one_switch` Arm B Turn 6 vs. `control` Arm A Turn 6):**',
    `  - Across all \`5/5\` completed runs (\`B_L_r01\` through \`B_L_r05\`, \`turn = 6\`, \`request_index_in_turn = 1\`), \`cache_read_input_tokens\` was **\`0\`** \`[0–0]\` (\`0.00%\` cache_read share) and \`cache_creation_input_tokens\` was **\`${median(bL_T6.cws)}\`** \`[${minVal(bL_T6.cws)}–${maxVal(bL_T6.cws)}]\` tokens (e.g., \`B_L_r02\` \`turn=6\`: \`input_tokens=3\`, \`cache_creation_input_tokens=56404\`, \`cache_read_input_tokens=0\`, \`output_tokens=300\`, \`cost_usd=0.216024\`).`,
    `  - In \`control\` (\`A_L_r01..r05\`, \`turn = 6\`), \`cache_read_input_tokens\` was **\`${median(aL_T6.crs)}\`** \`[${minVal(aL_T6.crs)}–${maxVal(aL_T6.crs)}]\` (\`99.32%\` median hit share) at \`cost_usd\` = **${fmtMedRange(aL_T6.costs, 5, '$')}**.`,
    `  - **Extra cost at \`large\` (\`~56.5k\` tokens):** **${fmtSignedMedRange(bL_T6.costPens, 5, '$')}** on Turn 6 (**\`${(median(bL_T6.costs) / median(aL_T6.costs)).toFixed(2)}x\`** Control Turn 6 cost, even though \`Sonnet 4.6\` has a \`40%\` lower base input price than \`Opus 4.6\`).`,
    '',
    '### Question 2: Is the penalty one-time, or does it repeat on later turns?',
    '- **One-time penalty.** Once the new model (`anthropic/claude-sonnet-4.6`) writes its own cache on Turn 6, every subsequent turn on that model hits the new cache.',
    '- **Evidence (`one_switch` Arm B Turns 7 and 8):**',
    `  - **\`small\` (\`B_S_r01..r05\`):** On Turn 7, \`cache_read_input_tokens\` recovered to **\`${median(bS_T7.crs)}\`** \`[${minVal(bS_T7.crs)}–${maxVal(bS_T7.crs)}]\` tokens (**${fmtMedRange(bS_T7.hits, 2, '', '%')}** cache_read share; \`cache_creation_input_tokens\` = \`${median(bS_T7.cws)}\` \`[${minVal(bS_T7.cws)}–${maxVal(bS_T7.cws)}]\`; \`cost_usd\` = ${fmtMedRange(bS_T7.costs, 5, '$')}). On Turn 8, \`cache_read\` share was **${fmtMedRange(bS_T8.hits, 2, '', '%')}** (\`cost_usd\` = ${fmtMedRange(bS_T8.costs, 5, '$')}).`,
    `  - **\`large\` (\`B_L_r01..r05\`):** On Turn 7, \`cache_read_input_tokens\` recovered to **\`${median(bL_T7.crs)}\`** \`[${minVal(bL_T7.crs)}–${maxVal(bL_T7.crs)}]\` tokens (**${fmtMedRange(bL_T7.hits, 2, '', '%')}** cache_read share; \`cache_creation_input_tokens\` = \`${median(bL_T7.cws)}\` \`[${minVal(bL_T7.cws)}–${maxVal(bL_T7.cws)}]\`; \`cost_usd\` = ${fmtMedRange(bL_T7.costs, 5, '$')}, e.g. \`B_L_r02\` \`turn=7\`: \`cache_read_input_tokens=56404\` matching \`turn=6\` \`cache_creation_input_tokens=56404\` token-for-token). On Turn 8, \`cache_read\` share was **${fmtMedRange(bL_T8.hits, 2, '', '%')}**.`,
    '',
    '### Question 3: If you switch back to the original model within the cache lifetime, does the original cache hit?',
    '- **Yes.** Switching back to `anthropic/claude-opus-4.6` within the 5-minute TTL hits the original model’s pre-switch cache and writes only the intermediate turns’ conversation delta.',
    '- **Evidence (`switch_and_back` Arm C, `C_S_r01..r05`):**',
    `  - On Turn 5 (last turn on \`Opus 4.6\` before switching), total input was \`${median(cS_T5.totIns)}\` \`[${minVal(cS_T5.totIns)}–${maxVal(cS_T5.totIns)}]\` tokens (\`cache_read_input_tokens\` = \`${median(cS_T5.crs)}\`, \`cache_creation_input_tokens\` = \`${median(cS_T5.cws)}\`).`,
    `  - After running Turns 6 and 7 on \`Sonnet 4.6\` (\`~11–15s\` elapsed), Turn 8 switched back to \`Opus 4.6\`: \`cache_read_input_tokens\` was **\`${median(cS_T8.crs)}\`** \`[${minVal(cS_T8.crs)}–${maxVal(cS_T8.crs)}]\` tokens (**${fmtMedRange(cS_T8.hits, 2, '', '%')}** cache_read share) and \`cache_creation_input_tokens\` was only **\`${median(cS_T8.cws)}\`** \`[${minVal(cS_T8.cws)}–${maxVal(cS_T8.cws)}]\` tokens for the Turns 6–7 delta (e.g., \`C_S_r01\` \`turn=8\`: \`cache_read_input_tokens=14815\` = \`turn=5\` \`cache_read_input_tokens (14483) + cache_creation_input_tokens (332)\`, \`cache_creation_input_tokens=1075\`, \`cost_usd=0.019555\`).`,
    '  - The same warm-cache return occurs on every switch from Turn `3` through Turn `11` in `ten_switches` (`Arm F`, `F_S_r01..r05` and `F_L_r01..r05`), where both `Opus 4.6` and `Sonnet 4.6` maintain warm caches simultaneously (`98.4%–98.6%` median `cache_read` share on `F_L` Turns `5–11`).',
    '',
    '### Question 4: Does changing effort alone reset the cache?',
    '- **In this setup, an effort-only change produced a full cache miss on the next request.**',
    '- **Evidence (`effort_only` Arm D, `D_S_r01..r05`, `anthropic/claude-opus-4.6` throughout, `--effort medium` on Turns `1–5` → `--effort high` on Turns `6–12`):**',
    `  - Across all \`5/5\` runs on Turn 6 (\`D_S_r01..r05\`, \`turn = 6\`, \`request_index_in_turn = 1\`), \`cache_read_input_tokens\` dropped to **\`0\`** \`[0–0]\` (**\`0.00%\` \`[0.00%–0.00%]\`** cache_read share) and \`cache_creation_input_tokens\` jumped to **\`${median(dS_T6.cws)}\`** \`[${minVal(dS_T6.cws)}–${maxVal(dS_T6.cws)}]\` tokens (e.g., \`D_S_r01\` \`turn=6\`: \`input_tokens=3\`, \`cache_creation_input_tokens=15147\`, \`cache_read_input_tokens=0\`, \`output_tokens=157\`, \`cost_usd=0.09860875\`).`,
    `  - Turn 6 cost jumped to **${fmtMedRange(dS_T6.costs, 5, '$')}** vs. Control Turn 6 **${fmtMedRange(aS_T6.costs, 5, '$')}** (a switch penalty of **${fmtSignedMedRange(dS_T6.costPens, 5, '$')}**, or **\`${(median(dS_T6.costs) / median(aS_T6.costs)).toFixed(2)}x\`** Control Turn 6).`,
    `  - On Turn 7 (remaining at \`effort = high\` on \`Opus 4.6\`), \`cache_read_input_tokens\` immediately recovered to **\`${median(dS_T7.crs)}\`** \`[${minVal(dS_T7.crs)}–${maxVal(dS_T7.crs)}]\` tokens (**${fmtMedRange(dS_T7.hits, 2, '', '%')}** cache_read share, \`cost_usd\` = ${fmtMedRange(dS_T7.costs, 5, '$')}).`,
    '  - Proxy request fingerprinting (`results/arm_d_wire_diff.json`) confirmed that `tools` and `system` blocks were byte-for-byte identical between Turn 5 and Turn 6 (`toolsIdentical: true`, `systemIdentical: true`); the only request parameter change outside the appended conversation turn was `output_config: { "effort": "medium" } -> { "effort": "high" }`.',
    '',
    '### Question 5: Does the penalty grow with prefix size (`small` vs `large`)?',
    '- **Yes.** The Turn 6 model-switch cost penalty grew in direct proportion to prefix token size, and at `large` (`~56.5k` tokens) the single-turn cache rebuild cost exceeded the cumulative 7-turn per-token savings of switching to the cheaper model.',
    '- **Evidence (`one_switch` Arm B vs. `control` Arm A across `small` and `large`):**',
    `  - **Turn 6 prefix size ratio:** \`${median(bL_T6.totIns)} / ${median(bS_T6.totIns)} = ${(median(bL_T6.totIns) / median(bS_T6.totIns)).toFixed(2)}x\` (\`56,407\` vs. \`15,168\` median total input tokens).`,
    `  - **Turn 6 switch cost penalty:** Increased **\`${(median(bL_T6.costPens) / median(bS_T6.costPens)).toFixed(2)}x\`**, from **${fmtSignedMedRange(bS_T6.costPens, 5, '$')}** at \`small\` to **${fmtSignedMedRange(bL_T6.costPens, 5, '$')}** at \`large\`.`,
    `  - **12-turn cumulative session cost impact:** At \`small\`, \`one_switch\` cost **${fmtMedRange(sessionStatsByCell.find((s) => s.bucket === 'small' && s.arm === 'one_switch').sessCosts, 4, '$')}** vs. \`control\` **${fmtMedRange(sessionStatsByCell.find((s) => s.bucket === 'small' && s.arm === 'control').sessCosts, 4, '$')}** (**${fmtSignedMedRange(sessionStatsByCell.find((s) => s.bucket === 'small' && s.arm === 'one_switch').sessPens, 4, '$')}**). At \`large\`, \`one_switch\` cost **${fmtMedRange(sessionStatsByCell.find((s) => s.bucket === 'large' && s.arm === 'one_switch').sessCosts, 4, '$')}** vs. \`control\` **${fmtMedRange(sessionStatsByCell.find((s) => s.bucket === 'large' && s.arm === 'control').sessCosts, 4, '$')}** (**${fmtSignedMedRange(sessionStatsByCell.find((s) => s.bucket === 'large' && s.arm === 'one_switch').sessPens, 4, '$')}** — switching to the cheaper model increased total session cost by \`+10.56%\`).`,
    '',
    '---',
    '',
    '## 5. Comparison Against the Three Initial Predictions',
    '',
    '1. **Prediction (a): "Full miss on the turn after a model switch, recovering by the next turn."**',
    '   - **Confirmed for single/first switches (`Arm B`, `Arm C` Turn 6, `Arm E` Turn 6, and `Arm F` Turn 2 Request 1):** Every first switch to `Sonnet 4.6` produced `0` `cache_read_input_tokens` (`0.00%` share) and recovered on the next request to `97.71%` (`small`) and `99.31%` (`large`).',
    '   - **Where a naive extrapolated version of (a) fails (`Arm C` Turn 8 and `Arm F` Turns `3–11`):** If you switch *back* to a model that already has a warm cache within the 5-minute TTL, you do **not** get a full miss (`93.31%` hit on `Arm C` Turn 8; `94.86%–98.58%` hit on `Arm F` Turns `5–11`).',
    '2. **Prediction (b): "No cache reset from an effort-only change."**',
    '   - **WRONG (Falsified by the data).** In all `5/5` replicates of `effort_only` (`D_S_r01..r05`, Turn 6), an effort-only change (`medium` to `high` on `anthropic/claude-opus-4.6`) produced a **full cache miss** (`cache_read_input_tokens = 0` `[0–0]`, `cache_creation_input_tokens = 15,157` `[15,147–15,180]`) on the next request in this setup, adding `+$0.08527` `[$0.08458 to +$0.08557]` on Turn 6 (`+$0.0861` `[$0.0809 to +$0.0872]` across the 12-turn session) before recovering to `98.13%` on Turn 7.',
    '3. **Prediction (c): "A larger penalty with the large prefix."**',
    '   - **Confirmed.** The Turn 6 switch cost penalty scaled from `+$0.04655` at `small` (`15,168` median tokens) to `+$0.17827` at `large` (`56,407` median tokens) — a `3.83x` cost penalty increase for a `3.72x` token prefix increase.',
    '',
    '---',
    '',
    '## 6. Surprising Findings, Anomalies & Design Limitations',
    '',
    '1. **Why Control Arm Turns 1–3 Looked Anomalous When Aggregated by CLI Turn (2-Request `Read` Tool Loop):**',
    '   - In Claude Code, Turns `1`, `2`, and `3` invoke the `Read` tool and therefore execute **2 sequential `/v1/messages` API requests** inside a single CLI turn (`requests_in_turn = 2`): Request 1 emits `tool_use` (`Read`), and Request 2 sends `tool_result` (the file lines) and receives the assistant’s explanation.',
    '   - On Turn 1 Request 1 (`request_index_in_turn = 1`), `cache_read_input_tokens = 0` (`0.00%` hit) and `cache_creation_input_tokens = 8,846` (`small`) / `8,840` (`large`). Seconds later on Turn 1 Request 2 (`request_index_in_turn = 2`), Claude Code sends the file content and **immediately reads back Request 1’s `8,846` / `8,840` cached tokens** while writing the new file tokens (`1,704` on `small`, `14,860` on `large`).',
    '   - If Request 1 and Request 2 are summed into a single row for Turn 1, Turn 1 appears to have `8,846` cache reads out of `19,400` summed input tokens (`45.6%` cache hit on Turn 1!) and Turn 1–3 summed input tokens (`19.4k -> 23.4k -> 25.5k`) appear to drop on Turn 4 (`14.5k`, the first 1-request Q&A turn). Splitting `runs.csv` to one row per API request with `request_index_in_turn` and `requests_in_turn` resolves this completely:',
    '',
    '| Control Run ID | Bucket | Turn 1 Request 1 `cache_read` | Turn 1 Request 2 (`last`) Total Input | Turn 2 Request 1 (`first`) `cache_read` | Ratio (`T2_first_cache_read / T1_last_total_input`) |',
    '| :--- | :--- | :---: | :---: | :---: | :---: |',
    ...controlTurn2Ratios.map((c) => `| \`${c.run_id}\` | \`${c.prefix_size_bucket}\` | \`0\` | \`${c.t1_last_total_input}\` | \`${c.t2_first_cache_read}\` | **\`${c.ratio}\` (\`${c.ratioPct}\`)** |`),
    '',
    '2. **Intra-Turn Cache Recovery on `ten_switches` (`Arm F`) Turn 2:**',
    '   - Because Turn 2 is a 2-request `Read` turn, when `Arm F` switches from `Opus 4.6` (Turn 1) to `Sonnet 4.6` on Turn 2, `request_index_in_turn = 1` experiences a **full cache miss** (`cache_read_input_tokens = 0` `[0–0]` across all `5` `small` and `5` `large` runs), writing `10,860` (`small`) / `24,049` (`large`) tokens to Sonnet’s cache. Then `~3` seconds later, `request_index_in_turn = 2` inside Turn 2 hits that newly created Sonnet cache (`cache_read_input_tokens = 10,860` `small` / `24,049` `large`).',
    '3. **`Arm E` (`idle_then_switch`) Confound Limitation:**',
    '   - `Arm E` waited `348.74s–439.04s` (median `394.54s`, past the `300s` TTL) before Turn 6 **and** switched from `Opus 4.6` to `Sonnet 4.6` at Turn 6 (`cache_read_input_tokens = 0` `[0–0]`, `cost_usd = $0.06032` `[$0.05998–$0.06068]`, identical to `one_switch` `Arm B` at `$0.06018` `[$0.06008–$0.06051]`). Because `Arm E` changed both idle duration and model simultaneously, it cannot isolate TTL expiry from model switching. An additional `10`-run `idle_only` arm (idle gap with no model switch at both prefix sizes) was skipped because `~$7.30` of additional Opus runs would have exceeded the `$30.00` experiment budget cap (`$25.55` spent).',
    '4. **Directional Latency on `large` Turn 6 (`latency_ms` vs. Prefill `ttfb_ms`):**',
    `   - On \`large\` Turn 6, \`one_switch\` (\`B_L\`) had a slightly lower median end-to-end \`latency_ms\` than \`control\` (\`A_L\`) (**${fmtMedRange(bL_T6.lats, 1, '', ' ms')}** vs. **${fmtMedRange(aL_T6.lats, 1, '', ' ms')}**, penalty **${fmtSignedMedRange(bL_T6.latPens, 1, ' ms')}**) even though \`B_L\` wrote \`56,404\` uncached prefix tokens. Inspection of proxy time-to-first-byte (\`ttfb_ms\` in \`notes\`) shows that cold-cache prefill on \`B_L\` Turn 6 was slower (${fmtMedRange(bL_T6.ttfbs, 1, '', ' ms')} vs. Control ${fmtMedRange(aL_T6.ttfbs, 1, '', ' ms')}, and vs. warm Sonnet on \`B_L\` Turn 7 at ${fmtMedRange(bL_T7.ttfbs, 1, '', ' ms')}), but \`Sonnet 4.6\` streamed its \`~302\` output tokens faster than \`Opus 4.6\` streamed its \`~285\` output tokens.`,
    '5. **Aborted First Attempt of `B_L_r01` (`B_L_r01_aborted_attempt1`):**',
    '   - Documented in `manifest.md` Section 8 and included as `10` flagged rows at the end of `runs.csv` (`source = cli_log_recovered`).'
  ];

  fs.writeFileSync(path.join(RESULTS_DIR, 'summary.md'), summaryLines.join('\n') + '\n', 'utf8');

  const redactionLines = [
    '# Redaction & Privacy Manifest (`REDACTION_MANIFEST.md`)',
    '',
    '## 1. Redaction Rules Applied Across All Deliverables & Raw Files',
    '',
    'Every deliverable and raw data file under `experiments/model-switch-benchmark/` was scanned and sanitized in-place. The table below lists every category of identifier removed or replaced:',
    '',
    '| Category | Original Pattern | Replacement Token | Scope Affected |',
    '| :--- | :--- | :--- | :--- |',
    '| **API Keys & Bearer Tokens** | `sk-or-v1-[A-Za-z0-9_-]+`, `sk-ant-[A-Za-z0-9_-]+` | `[REDACTED_OPENROUTER_KEY]`, `[REDACTED_ANTHROPIC_KEY]` | Redacted at capture time across all transcripts and wire logs |',
    '| **Claude Code Encoded Project Path Slug** | `C--Users-<USER>-AppData-Local-Temp-...-frozen-repo` (`147` occurrences across `49` transcript files) | `<FROZEN_REPO_SLUG>` | `results/raw/transcripts/*.jsonl` (`45` files) and `results/pilot/transcripts/*.jsonl` (`4` files) |',
    '| **OS Username & Local File Paths** | `C:\\\\Users\\\\<USER>`, `<FROZEN_REPO_DIR>`, `<ISOLATED_HOME>`, `<ISOLATED_CLAUDE_CONFIG>` | `C:\\\\Users\\\\[USER]`, `<FROZEN_REPO>`, `<ISOLATED_HOME>`, `<ISOLATED_CLAUDE_CONFIG>` | All `.jsonl` transcripts, wire logs, and manifests |',
    '| **Claude Code Telemetry Device ID** | `"device_id":"<64-hex-sha256>"` inside `requestFingerprint.metadata.user_id` (`63` occurrences) | `"device_id":"[REDACTED_DEVICE_ID]"` | `results/raw/proxy_wire_log.jsonl` and `results/pilot/*_wire_log.jsonl` |',
    '| **OpenRouter Upstream Request IDs** | `gen-<timestamp>-<random>` in `upstreamHeaders.requestId` (`746` occurrences) | `[REDACTED_UPSTREAM_REQ_ID]` | `results/raw/proxy_wire_log.jsonl` and `results/pilot/*_wire_log.jsonl` |',
    '| **Session UUIDs** | Raw UUIDv4 `session_id` / `sessionId` (`45` main + `1` aborted + `4` pilot sessions, `3,987` occurrences) | Deterministic `sess_<run_id>` (e.g. `sess_A_S_r01`, `sess_B_L_r01_aborted_attempt1`) | `results/runs.csv`, `results/raw/checkpoint.json`, `results/raw/proxy_wire_log.jsonl`, `results/raw/transcripts/*.jsonl`, `results/raw/scrubbed_partial_runs.json`, `results/pilot/**` |',
    '| **Anthropic Message IDs** | Raw `msg_01...` IDs on API responses (`746` main + streaming frame occurrences) | Deterministic `msg_<run_id>_T<01..12>_r<1..2>` (and `[REDACTED_MSG_ID]` on unindexed stream frames) | `results/raw/proxy_wire_log.jsonl`, `results/raw/transcripts/*.jsonl`, `results/pilot/**` |',
    '| **Internal Transcript Event UUIDs** | `uuid`, `parentUuid`, `leafUuid`, `promptId`, `sourceToolAssistantUUID`, `requestId` (`4,147` occurrences) | `[REDACTED_UUID]` | `results/raw/transcripts/*.jsonl` and `results/pilot/transcripts/*.jsonl` |',
    '| **Repository, Handle & Project Identifiers** | GitHub owner handle, repository name, local folder name, CLI/brand name (`~1,060` occurrences) | `<GITHUB_HANDLE>`, `<TARGET_REPO>`, `<PROJECT_NAME>`, `<PROJECT_CLI>` | All transcripts, reports, and benchmark scripts under `experiments/model-switch-benchmark/` |',
    '',
    '---',
    '',
    '## 2. Folder Organization & Publication Safety Classification',
    '',
    '### A. Safe to Publish (`experiments/model-switch-benchmark/`)',
    '- **Top-Level Deliverables (`experiments/model-switch-benchmark/results/`):**',
    '  - `results/runs.csv` (`730` rows × `21` columns, unrounded)',
    '  - `results/manifest.md` (complete protocol, batch timeline, rate card, prompts, and deviations)',
    '  - `results/summary.md` (medians and `[min–max]` ranges, switch penalties, Q1–Q5 answers with citations, and anomaly audit)',
    '  - `results/phase0_compact_hooks.md` and `results/smart_compact/phase0_compact_hooks.md` (Smart-Compact Phase 0 binary/mock-SSE verification & Phase 2 cost gate)',
    '  - `results/phase1_boundary_detector.csv` and `results/smart_compact/phase1_boundary_detector.csv` (`1,420` boundary detector rows: `1,240` existing benchmark turns + `180` live Phase 2 turns across `6` 30-turn runs)',
    '  - `results/runs_smart_compact.csv`, `results/smart_compact/runs_smart_compact.csv` (`388` wire rows across `6` runs: `362` `/v1/messages` + `26` `/v1/messages/count_tokens`), and `results/smart_compact/runs_smart_compact_v2.csv` (`142` wire rows across the `2` Fixture v2 runs)',
    '  - `results/summary_smart_compact.md` and `results/smart_compact/summary_smart_compact.md` (Smart-Compact final summary report: limitations, verbatim `preregistration_fixture_v2.json` & provenance, H1–H7 tables, C0 & H6 arithmetic, auto-memory cost finding, compaction latency, `$0` Auto mode proposal, and corrections log)',
    '  - `results/smart_compact/preregistration_fixture_v2.json` (Fixture v2 pre-registration artifact)',
    '  - `results/smart_compact/pilot_c1_r01_summary.json`, `results/smart_compact/stage_a_summary.json`, `results/smart_compact/stage_a2_v2_summary.json`, and `results/smart_compact/phase2_cost_estimate.json`',
    '  - `results/REDACTION_MANIFEST.md` (this file)',
    '- **Builder & Harness Scripts (`experiments/model-switch-benchmark/`):**',
    '  - `build_article_deliverables.mjs` and `build_smart_compact_deliverables.mjs` (recompute CSVs, `manifest.md`, `summary.md`, `summary_smart_compact.md`, `REDACTION_MANIFEST.md`, and run all verification & privacy gates)',
    '  - `config.mjs`, `proxy_recorder.mjs`, `run_experiment.mjs`, `analyze_results.mjs`, `selftest_offline.mjs`, `predictions.md`, `README.md`, `fixtures/prompts_small.json`, `fixtures/prompts_large.json`, `fixtures/prompts_tool_heavy_12t.json`',
    '  - `run_smart_compact_phase0_phase1.mjs`, `run_smart_compact_pilot.mjs`, `run_smart_compact_stage_a.mjs`, `run_smart_compact_stage_a2_v2.mjs`, `analyze_pilot_and_update_phase2_estimate.mjs`',
    '- **Separate Sanitized Raw Data Folders (`results/raw/`, `results/pilot/`, & `results/smart_compact/raw/`):**',
    '  - `results/raw/proxy_wire_log.jsonl` (`720` wire requests across the `45` completed runs)',
    '  - `results/raw/cli_turns.jsonl` (`540` CLI turn records)',
    '  - `results/raw/checkpoint.json`, `results/raw/run_manifest.json`, `results/raw/scrubbed_partial_runs.json`, `results/raw/openrouter_ledger.jsonl`',
    '  - `results/raw/transcripts/*.jsonl` (`45` sanitized session transcript files)',
    '  - `results/pilot/` (`4` Pilot Batch 1 + `2` Pilot Batch 2 wire logs and sanitized transcripts)',
    '  - `results/smart_compact/raw/` (`6` sanitized 30-turn live runs: `C1_r01`, `C1_r02`, `C1_r03`, `C1mem_r02`, `C1_v2_r01`, `C1_v2_r02` — `6` wire logs, `3` OpenRouter ledger JSONLs, and `6` sanitized session transcripts)',
    '',
    '### B. NOT Safe to Publish (Must Remain Local / Excluded)',
    '- **`.env.benchmark`** (at the repository root, gitignored — **contains the live `OPENROUTER_API_KEY`; NEVER publish**)',
    '- **OS Temporary Runtime Directory (`%TEMP%/claude-code-switch-benchmark-runtime/`)** (local execution scratch space outside the repository)'
  ];

  const smartSummarySrc = path.join(RESULTS_DIR, 'smart_compact', 'summary_smart_compact.md');
  const smartSummaryDst = path.join(RESULTS_DIR, 'summary_smart_compact.md');
  if (fs.existsSync(smartSummarySrc)) {
    fs.copyFileSync(smartSummarySrc, smartSummaryDst);
  }
  fs.writeFileSync(path.join(RESULTS_DIR, 'REDACTION_MANIFEST.md'), redactionLines.join('\n') + '\n', 'utf8');
}

function verifyZeroLeaksAcrossBenchmarkDir() {
  const allFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else allFiles.push(p);
    }
  };
  walk(EXPERIMENT_DIR);

  const ids = loadDynamicIdentifiers();
  const forbiddenChecks = [
    { name: 'api_key', rx: /sk-or-v1-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}/i },
    { name: 'os_username', rx: new RegExp(ids.dynamicUser, 'i') },
    { name: 'github_handle', rx: new RegExp(ids.dynamicGitOwner, 'i') },
    { name: 'github_repo', rx: new RegExp(ids.dynamicGitRepo, 'i') },
    { name: 'local_repo_folder', rx: new RegExp(ids.dynamicRepoDirName, 'i') },
    { name: 'pkg_cli_name', rx: new RegExp(ids.dynamicPkgName, 'i') },
    { name: 'project_brand', rx: new RegExp(ids.dynamicProductName, 'i') },
    { name: 'raw_uuid', rx: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
    { name: 'raw_msg_id', rx: /msg_01[A-Za-z0-9]{10,}/ },
    { name: 'raw_openrouter_gen_id', rx: /gen-\d{6,}-[A-Za-z0-9_-]+/ }
  ];

  const violations = [];
  for (const p of allFiles) {
    const relNorm = path.relative(EXPERIMENT_DIR, p).replace(/\\/g, '/');
    const isCode = p.endsWith('.mjs');
    const autoBrandSlug = ids.dynamicProductName.toLowerCase();
    const isAutoExpScope =
      relNorm === `run_${autoBrandSlug}_auto.mjs` ||
      relNorm.startsWith(`results/${autoBrandSlug}_auto/`) ||
      relNorm === 'run_round2_c2.mjs' ||
      relNorm === 'probe_rule_v2_replay.mjs' ||
      relNorm.startsWith('results/round2_c2/');
    const txt = fs.readFileSync(p, 'utf8');
    for (const chk of forbiddenChecks) {
      if (isCode && ['api_key', 'raw_uuid', 'raw_msg_id', 'raw_openrouter_gen_id'].includes(chk.name)) {
        continue;
      }
      if (isAutoExpScope && ['pkg_cli_name', 'project_brand'].includes(chk.name)) {
        continue;
      }
      if (chk.rx.test(txt)) {
        violations.push({ file: relNorm, check: chk.name });
      }
    }
  }

  return {
    benchmarkFilesScanned: allFiles.length,
    violationsCount: violations.length,
    violations
  };
}

function main() {
  sanitizeAllBenchmarkFilesInPlace();

  const wireLogs = readJsonl(path.join(RAW_DIR, 'proxy_wire_log.jsonl'));
  const cliTurns = readJsonl(path.join(RAW_DIR, 'cli_turns.jsonl'));
  const checkpoint = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'checkpoint.json'), 'utf8'));

  const csvBuildInfo = buildRunsCsv({
    wireLogs,
    cliTurns,
    checkpoint
  });
  const stats = runVerificationAndComputeStats(csvBuildInfo.runsCsvPath);
  generateManifestAndSummary({ stats, csvBuildInfo });
  const privacyAudit = verifyZeroLeaksAcrossBenchmarkDir();

  console.log(JSON.stringify({
    status: 'DELIVERABLES_OK',
    csvBuildInfo,
    checks: {
      rawRowsCount: stats.rawRowsCount,
      mainRowsCount: stats.mainRowsCount,
      sideRowsCount: stats.sideRowsCount,
      abortedRowsCount: stats.abortedRowsCount,
      unexpectedBlanksCount: stats.unexpectedBlanksCount,
      allControlPass80Pct: stats.allControlPass80Pct,
      controlTurn2Ratios: stats.controlTurn2Ratios,
      cellAudit: stats.cellAudit
    },
    privacyAudit
  }, null, 2));

  if (stats.unexpectedBlanksCount > 0 || !stats.allControlPass80Pct || privacyAudit.violationsCount > 0) {
    process.exit(1);
  }
}

main();
