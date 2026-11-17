#!/usr/bin/env node
/**
 * Offline $0.00 Organic Multi-Task H7 Replay Audit
 *
 * Strictly zero network calls, zero paid API spend, and strictly read-only ('r')
 * inspection of local Antigravity brain transcripts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POST_COMPACT_COOLDOWN_TURNS,
  TEST_CMD_REGEX,
  evaluateSmartCompactSuggestion,
  evaluateTaskBoundaryTurn,
  isNonCodeDocOrArtifactPath
} from '../../src/core-isomorphic/coach/smartCompactAdvisor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, 'results', 'smart_compact');
const OUT_JSON = path.join(OUT_DIR, 'organic_h7_boundary_audit.json');
const OUT_CSV = path.join(OUT_DIR, 'organic_h7_boundary_turns.csv');

const EXCLUDED_CONVERSATION_IDS = new Set([
  'af3e2eff-94cd-4177-90de-05778b5c0247'
]);

const EDIT_TOOL_RE =
  /^(?:write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|Write|Edit|MultiEdit|NotebookEdit|Replace)$/i;
const BRAIN_PATH_RE = /\.gemini[\\/]antigravity[\\/]brain(?:[\\/]|$)/i;
const VERIFY_CMD_RE = /\b(?:ctxtop(?:\.mjs)?\s+verify|build_webview_html|sync_mirrors)\b/i;
const GIT_COMMIT_RE = /\bgit\s+(?:commit|push)\b/i;
const EXIT_CODE_RE = /Command exited with code (\d+)/i;
const FAIL_OUT_RE =
  /\b(?:FAIL|FAILED|AssertionError|ERR_ASSERTION|[1-9]\d*\s+failing|not ok\s+\d+|ℹ fail [1-9]\d*)\b/i;
const PASS_OUT_RE =
  /\b(?:PASS|PASSED|ALL ASSERTIONS PASSED|0 failing|ℹ fail 0|ok\s+\d+\s+-|[1-9]\d*\s+passed)\b/i;
const NEXT_TURN_BUG_RE =
  /\b(?:still\s+(?:broken|failing|not|seeing|getting|wrong)|doesn't\s+work|does\s+not\s+work|not\s+working|not\s+updating|no\s+data|\berror\b|exception|stack\s*trace|\bfailed\b|\bbug\b|\bbroken\b|fix\s+the\s+error|same\s+issue|reverted|switches\s+to\s+coach)\b/i;

function readTextReadOnly(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function cleanUserText(raw) {
  return String(raw || '')
    .replace(/<\/?USER_REQUEST>/g, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/g, '')
    .trim();
}

function extractCommandOutcomeText(objs, startIdx, endIdx) {
  let immediate = '';
  for (let k = startIdx + 1; k < Math.min(endIdx, startIdx + 5); k += 1) {
    const step = objs[k];
    if (step?.type === 'GENERIC' || step?.type === 'SYSTEM_MESSAGE' || step?.type === 'RUN_COMMAND') {
      immediate = String(step.content || '');
      break;
    }
  }
  const taskMatch = immediate.match(/task id:\s*([^\s\r\n"]+)/i);
  if (taskMatch && taskMatch[1]) {
    const taskId = taskMatch[1];
    for (let k = startIdx + 1; k < endIdx; k += 1) {
      const step = objs[k];
      if (step?.type === 'SYSTEM_MESSAGE' && String(step.content || '').includes(taskId)) {
        return String(step.content || '');
      }
    }
  }
  return immediate;
}

function classifyCommandResult(outText) {
  const exitMatch = outText.match(EXIT_CODE_RE);
  if (exitMatch) {
    const exitCode = Number(exitMatch[1]);
    return {
      exitCode,
      failed: exitCode !== 0,
      succeeded: exitCode === 0
    };
  }
  if (/Running in background|Tool is running as a background task/i.test(outText)) {
    return { exitCode: null, failed: false, succeeded: false };
  }
  const hasFail = FAIL_OUT_RE.test(outText) && !/ℹ fail 0\b/i.test(outText);
  const hasPass = !hasFail && PASS_OUT_RE.test(outText);
  return {
    exitCode: hasFail ? 1 : (hasPass ? 0 : null),
    failed: hasFail,
    succeeded: hasPass
  };
}

function parseOrganicSession(sessionId, transcriptPath) {
  const raw = readTextReadOnly(transcriptPath);
  const objs = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        void err;
        return null;
      }
    })
    .filter(Boolean);

  const userIndices = [];
  for (let idx = 0; idx < objs.length; idx += 1) {
    if (objs[idx]?.type === 'USER_INPUT' && objs[idx]?.source === 'USER_EXPLICIT') {
      userIndices.push(idx);
    }
  }
  if (userIndices.length < 3) return null;

  let sessionHasCodeEdit = false;
  let sessionHasTestCmd = false;
  let cumChars = 32_000;
  const turns = [];

  for (let i = 0; i < userIndices.length; i += 1) {
    const start = userIndices[i];
    const end = i + 1 < userIndices.length ? userIndices[i + 1] : objs.length;
    const uText = cleanUserText(objs[start]?.content || '');
    if (/^\/compact\b/i.test(uText)) {
      cumChars = Math.min(cumChars, 60_000);
    }

    const toolEvents = [];
    for (let j = start; j < end; j += 1) {
      cumChars += JSON.stringify(objs[j]).length;
      if (j === start) continue;
      const obj = objs[j];
      for (const tc of obj?.tool_calls || []) {
        const toolName = String(tc?.name || tc?.tool_name || '');
        const args = tc?.args || tc?.arguments || {};
        const cmd = String(args.CommandLine || args.command || args.cmd || '');
        const filePath = String(args.Path || args.path || args.TargetFile || args.file_path || '');
        const isBrainEdit = BRAIN_PATH_RE.test(filePath);
        const isRawWorkspaceEdit = EDIT_TOOL_RE.test(toolName) && !isBrainEdit;
        const isCodeEdit = isRawWorkspaceEdit && !isNonCodeDocOrArtifactPath(filePath);
        const isCmdTool = /run_command|bash/i.test(toolName);
        const isTest = isCmdTool && TEST_CMD_REGEX.test(cmd);
        const isVerify = isCmdTool && VERIFY_CMD_RE.test(cmd);
        const isCommit = isCmdTool && GIT_COMMIT_RE.test(cmd);

        if (isCodeEdit) sessionHasCodeEdit = true;
        if (isTest) sessionHasTestCmd = true;

        let exitCode = null;
        let failed = false;
        let succeeded = false;
        if (isTest || isVerify) {
          const outText = extractCommandOutcomeText(objs, j, end);
          const outcome = classifyCommandResult(outText);
          exitCode = outcome.exitCode;
          failed = outcome.failed;
          succeeded = outcome.succeeded;
        }

        toolEvents.push({
          toolName,
          filePath,
          cmd,
          isRawWorkspaceEdit,
          isCodeEdit,
          isTest,
          isVerify,
          isCommit,
          exitCode,
          failed,
          succeeded
        });
      }
    }

    turns.push({
      sessionId,
      turnNumber: i + 1,
      totalTurnsInSession: userIndices.length,
      uText,
      estTokens: Math.round(cumChars / 4),
      toolEvents
    });
  }

  if (!sessionHasCodeEdit || !sessionHasTestCmd) return null;
  return turns;
}

function labelOracleGroundTruth(turns) {
  let openFail = false;
  let edits = 0;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    let boundary = false;

    for (const ev of turn.toolEvents) {
      if (ev.isCodeEdit) {
        edits += 1;
        boundary = false;
      }
      if (ev.isTest) {
        if (ev.failed) {
          openFail = true;
          boundary = false;
        } else if (ev.succeeded && (openFail || edits > 0)) {
          boundary = true;
          openFail = false;
          edits = 0;
        }
      }
    }

    const isTerminal = i === turns.length - 1;
    const nextText = !isTerminal ? turns[i + 1].uText : '';
    const nextIsBugReport = !isTerminal && NEXT_TURN_BUG_RE.test(nextText) && !/^\/compact\b/i.test(nextText);

    if (openFail) {
      turn.groundTruthLabel = 'mid_debug';
    } else if (boundary && !isTerminal && !nextIsBugReport) {
      turn.groundTruthLabel = 'task_boundary';
    } else {
      turn.groundTruthLabel = 'other';
    }
    turn.fpReason = boundary ? (isTerminal ? 'terminal_turn' : (nextIsBugReport ? 'next_turn_bug_report' : null)) : null;
  }
}

function initArmStats() {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

function recordScore(stats, isPos, predPos) {
  if (isPos && predPos) stats.tp += 1;
  else if (!isPos && predPos) stats.fp += 1;
  else if (isPos && !predPos) stats.fn += 1;
  else stats.tn += 1;
}

function finalizeStats(stats, totalTurns) {
  const precision = stats.tp + stats.fp > 0 ? Number((stats.tp / (stats.tp + stats.fp)).toFixed(4)) : null;
  const recall = stats.tp + stats.fn > 0 ? Number((stats.tp / (stats.tp + stats.fn)).toFixed(4)) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null;
  const falsePromptsPer100Turns = totalTurns > 0 ? Number(((stats.fp / totalTurns) * 100).toFixed(2)) : 0;
  return {
    ...stats,
    totalTurns,
    precision,
    recall,
    f1,
    falsePromptsPer100Turns
  };
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function main() {
  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const armStats = {
    arm1_phase1_turn_level: initArmStats(),
    arm2_per_tool_unfiltered_trailing: initArmStats(),
    arm3_per_tool_fixed_causal: initArmStats(),
    arm4_per_tool_with_4turn_cooldown: initArmStats()
  };

  let sessionCount = 0;
  let totalTurns = 0;
  let gtTaskBoundaries = 0;
  let gtMidDebug = 0;
  let gtOther = 0;
  let fpTerminalCount = 0;
  let fpNextTurnBugCount = 0;
  let roiGatedFires = 0;
  let roiGatedTp = 0;
  let roiGatedFp = 0;

  const csvRows = [
    [
      'sessionId',
      'turnNumber',
      'totalTurnsInSession',
      'groundTruthLabel',
      'fpReason',
      'estTokens',
      'arm1_phase1_turn_level',
      'arm2_per_tool_unfiltered_trailing',
      'arm3_per_tool_fixed_causal',
      'arm4_per_tool_with_4turn_cooldown',
      'roiGatedSuggest',
      'promptPreview'
    ].join(',')
  ];

  if (fs.existsSync(brainDir)) {
    const dirs = fs.readdirSync(brainDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (!dir.isDirectory() || EXCLUDED_CONVERSATION_IDS.has(dir.name)) continue;
      const transcriptPath = path.join(brainDir, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;

      const turns = parseOrganicSession(dir.name, transcriptPath);
      if (!turns) continue;

      sessionCount += 1;
      labelOracleGroundTruth(turns);

      let p1OpenFail = false;
      let p1Edits = 0;

      let a2OpenFail = false;
      let a2Edits = 0;

      let a3State = { openFailure: false, editsSinceBoundary: 0, lastBoundarySuggestedTurn: null };
      let lastCompactOrSuggestedTurn = -999;
      let lastCompactOrRoiSuggestedTurn = -999;

      for (const turn of turns) {
        totalTurns += 1;
        if (turn.groundTruthLabel === 'task_boundary') gtTaskBoundaries += 1;
        else if (turn.groundTruthLabel === 'mid_debug') gtMidDebug += 1;
        else gtOther += 1;

        if (/^\/compact\b/i.test(turn.uText)) {
          lastCompactOrSuggestedTurn = turn.turnNumber;
          lastCompactOrRoiSuggestedTurn = turn.turnNumber;
        }

        const isPos = turn.groundTruthLabel === 'task_boundary';

        // Arm 1: Original Phase 1 turn-level sticky OR aggregation
        const p1HadEdit = turn.toolEvents.some((ev) => ev.isCodeEdit);
        const p1RanTest = turn.toolEvents.some((ev) => ev.isTest);
        const p1Failed = turn.toolEvents.some((ev) => ev.isTest && ev.failed);
        const p1Passed = !p1Failed && turn.toolEvents.some((ev) => ev.isTest && ev.succeeded);
        if (p1HadEdit) p1Edits += 1;
        let arm1Pred = false;
        if (p1RanTest) {
          if (p1Failed) {
            p1OpenFail = true;
          } else if (p1Passed && (p1OpenFail || p1Edits > 0)) {
            arm1Pred = true;
            p1OpenFail = false;
            p1Edits = 0;
          }
        }
        recordScore(armStats.arm1_phase1_turn_level, isPos, arm1Pred);

        // Arm 2: Pre-fix per-tool without trailing-code-edit reset (counts doc edits, sticky boundary in turn)
        let arm2Pred = false;
        for (const ev of turn.toolEvents) {
          if (ev.isRawWorkspaceEdit) a2Edits += 1;
          if (ev.isTest) {
            if (ev.failed) {
              a2OpenFail = true;
              arm2Pred = false;
            } else if (ev.succeeded && (a2OpenFail || a2Edits > 0)) {
              arm2Pred = true;
              a2OpenFail = false;
              a2Edits = 0;
            }
          }
        }
        recordScore(armStats.arm2_per_tool_unfiltered_trailing, isPos, arm2Pred);

        // Arm 3: Fixed causal evaluateTaskBoundaryTurn (trailing code edit clears boundary; doc/artifact edits ignored)
        let arm3Pred = false;
        for (const ev of turn.toolEvents) {
          const res = evaluateTaskBoundaryTurn(
            {
              toolName: ev.isRawWorkspaceEdit ? 'Edit' : (ev.isTest ? 'Bash' : ev.toolName),
              command: ev.cmd,
              filePath: ev.filePath,
              fileEdited: ev.isRawWorkspaceEdit,
              failed: ev.isTest ? ev.failed : undefined,
              succeeded: ev.isTest ? ev.succeeded : undefined,
              exitCode: ev.exitCode
            },
            a3State
          );
          a3State = {
            openFailure: res.openFailure,
            editsSinceBoundary: res.editsSinceBoundary,
            lastBoundarySuggestedTurn: a3State.lastBoundarySuggestedTurn
          };
          if (res.detectorState === 'mid_debug' || res.editsSinceBoundary > 0) {
            arm3Pred = false;
          } else if (res.boundaryDetected) {
            arm3Pred = true;
          }
        }
        recordScore(armStats.arm3_per_tool_fixed_causal, isPos, arm3Pred);
        if (arm3Pred && !isPos) {
          if (turn.fpReason === 'terminal_turn') fpTerminalCount += 1;
          else if (turn.fpReason === 'next_turn_bug_report') fpNextTurnBugCount += 1;
        }

        // Arm 4: Arm 3 + 4-turn cooldown
        let arm4Pred = false;
        if (arm3Pred && turn.turnNumber - lastCompactOrSuggestedTurn >= DEFAULT_POST_COMPACT_COOLDOWN_TURNS) {
          arm4Pred = true;
          lastCompactOrSuggestedTurn = turn.turnNumber;
        }
        recordScore(armStats.arm4_per_tool_with_4turn_cooldown, isPos, arm4Pred);

        // Supplementary: full production evaluateSmartCompactSuggestion (with ROI horizon gate)
        const roiEval = evaluateSmartCompactSuggestion({
          enabled: true,
          boundaryDetected: arm3Pred,
          detectorState: a3State.openFailure ? 'mid_debug' : (arm3Pred ? 'task_boundary' : 'other'),
          openFailure: a3State.openFailure,
          editsSinceBoundary: a3State.editsSinceBoundary,
          turnsSinceLastCompact:
            lastCompactOrRoiSuggestedTurn > 0 ? turn.turnNumber - lastCompactOrRoiSuggestedTurn : 99,
          modelId: 'claude-sonnet-4-6',
          preCompactTokens: turn.estTokens,
          turnsCompleted: turn.turnNumber
        });
        if (roiEval.shouldSuggest) {
          roiGatedFires += 1;
          lastCompactOrRoiSuggestedTurn = turn.turnNumber;
          if (isPos) roiGatedTp += 1;
          else roiGatedFp += 1;
        }

        csvRows.push(
          [
            turn.sessionId,
            turn.turnNumber,
            turn.totalTurnsInSession,
            turn.groundTruthLabel,
            turn.fpReason || '',
            turn.estTokens,
            arm1Pred,
            arm2Pred,
            arm3Pred,
            arm4Pred,
            Boolean(roiEval.shouldSuggest),
            turn.uText.slice(0, 80).replace(/\s+/g, ' ')
          ]
            .map(csvEscape)
            .join(',')
        );
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    liveApiSpendUsd: 0,
    corpus: {
      sessions: sessionCount,
      totalTurns,
      groundTruth: {
        task_boundary: gtTaskBoundaries,
        mid_debug: gtMidDebug,
        other: gtOther
      }
    },
    arms: {
      arm1_phase1_turn_level: finalizeStats(armStats.arm1_phase1_turn_level, totalTurns),
      arm2_per_tool_unfiltered_trailing: finalizeStats(armStats.arm2_per_tool_unfiltered_trailing, totalTurns),
      arm3_per_tool_fixed_causal: finalizeStats(armStats.arm3_per_tool_fixed_causal, totalTurns),
      arm4_per_tool_with_4turn_cooldown: finalizeStats(armStats.arm4_per_tool_with_4turn_cooldown, totalTurns)
    },
    arm3FalsePositiveBreakdown: {
      terminal_turn: fpTerminalCount,
      next_turn_bug_report: fpNextTurnBugCount
    },
    supplementaryRoiGatedAdvisor: {
      fires: roiGatedFires,
      tp: roiGatedTp,
      fp: roiGatedFp,
      precision: roiGatedFires > 0 ? Number((roiGatedTp / roiGatedFires).toFixed(4)) : null
    },
    artifacts: {
      json: OUT_JSON,
      csv: OUT_CSV
    }
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(OUT_CSV, `${csvRows.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
