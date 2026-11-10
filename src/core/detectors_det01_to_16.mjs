import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './paths.mjs';

/**
 * Phase 1: Real-Time Event Multiplexer (`HookStateMachine`) &
 * 16 Deterministic Anti-Pattern Circuit Breakers (`DET-01` through `DET-16`).
 *
 * Executes 100% locally in Node.js with zero LLM API tokens and sub-10ms latency.
 */

export const DETECTOR_CATALOG = Object.freeze({
  'DET-01': { id: 'DET-01', name: 'Retry Churn', severity: 'CRITICAL', haltsGeneration: true },
  'DET-02': { id: 'DET-02', name: 'Edit Oscillation', severity: 'CRITICAL', haltsGeneration: true },
  'DET-03': { id: 'DET-03', name: 'Test-Assertion Weakening', severity: 'CRITICAL', haltsGeneration: true },
  'DET-04': { id: 'DET-04', name: 'Synthetic Proof / Fake Screenshot Fabrication', severity: 'CRITICAL', haltsGeneration: true },
  'DET-05': { id: 'DET-05', name: 'Unverified [x] Task Completion', severity: 'HIGH', haltsGeneration: true },
  'DET-06': { id: 'DET-06', name: 'Redundant Full-File Re-Reads', severity: 'WARN', haltsGeneration: false },
  'DET-07': { id: 'DET-07', name: '<rrthought> Panic & Instruction-Loop Spiral', severity: 'CRITICAL', haltsGeneration: true },
  'DET-08': { id: 'DET-08', name: 'Unauthorized Brain / Git Destructive Command', severity: 'CRITICAL', haltsGeneration: true },
  'DET-09': { id: 'DET-09', name: 'Prefix-Busting Config Mutation', severity: 'HIGH', haltsGeneration: true },
  'DET-10': { id: 'DET-10', name: 'Unbounded CLI Output Flood', severity: 'WARN', haltsGeneration: false },
  'DET-11': { id: 'DET-11', name: 'Phantom File / Identifier Confabulation', severity: 'HIGH', haltsGeneration: false },
  'DET-12': { id: 'DET-12', name: 'Zombie Background Subprocess Leak', severity: 'HIGH', haltsGeneration: false },
  'DET-13': { id: 'DET-13', name: 'Premature Execution Without Plan Approval', severity: 'CRITICAL', haltsGeneration: true },
  'DET-14': { id: 'DET-14', name: 'Subagent File-Write Collision', severity: 'CRITICAL', haltsGeneration: true },
  'DET-15': { id: 'DET-15', name: 'Secret / Credential Leakage in Brain Artifacts', severity: 'CRITICAL', haltsGeneration: true },
  'DET-16': { id: 'DET-16', name: 'Silent Truncation / Placeholder Slop Injection', severity: 'CRITICAL', haltsGeneration: true },
  'DET-19': { id: 'DET-19', name: 'Git Hook-Bypass Guard', severity: 'CRITICAL', haltsGeneration: true },
  'DET-20': { id: 'DET-20', name: 'Concurrent File-Scope Collision', severity: 'CRITICAL', haltsGeneration: false }
});

export function sha256Hex(content = '') {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function normalizeToolSignature(toolName = '', args = {}) {
  const cleanName = String(toolName || '').toLowerCase().trim();
  const sortedKeys = Object.keys(args || {}).sort();
  const normObj = {};
  for (const k of sortedKeys) {
    const val = args[k];
    normObj[k] = typeof val === 'string' ? val.trim().replace(/\s+/g, ' ') : val;
  }
  return `${cleanName}::${JSON.stringify(normObj)}`;
}

export function isTestFilePath(filePath = '') {
  const s = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return (
    /\.(test|spec)\.[a-z0-9]+$/i.test(s) ||
    /(^|\/)(test|tests|__tests__)\/.*\.(js|mjs|cjs|ts|tsx|py)$/i.test(s) ||
    /_test\.py$/i.test(s) ||
    /verify_.*\.(mjs|js|ts)$/i.test(s)
  );
}

function countAssertionsInCode(code = '') {
  const text = String(code || '');
  const assertMatches = text.match(/\b(assert(?:\.[a-zA-Z0-9_]+)?|expect|should)\s*\(/g) || [];
  const pyAssertMatches = text.match(/^\s*assert\s+/gm) || [];
  return assertMatches.length + pyAssertMatches.length;
}

function countSkipsInCode(code = '') {
  const text = String(code || '');
  const skips = text.match(/(\.(?:skip|todo)\s*\(|@pytest\.mark\.skip\b|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\()/g) || [];
  return skips.length;
}

/**
 * Evaluates a step or stream of steps across all 16 deterministic detectors (`DET-01` .. `DET-16`).
 */
export function evaluateDetectorsOnSteps(steps = [], context = {}) {
  const startHr = process.hrtime.bigint();
  const list = Array.isArray(steps) ? steps : [];
  const findings = [];

  const cachedTokens = Number(context.cachedTokens ?? context.session?.cachedTokens ?? 0);
  const cacheTtlSeconds = Number(context.cacheTtlSeconds ?? context.session?.cacheTtlSeconds ?? 0);
  const approvalGateEnabled = context.approvalGateEnabled !== false;
  const userAuthorizedTestDeletion = Boolean(context.userAuthorizedTestDeletion);
  const workspacePath = context.workspacePath || '';
  const existingFilesSet = context.existingFiles instanceof Set
    ? new Set(Array.from(context.existingFiles).map(p => canonicalizePath(p)))
    : null;
  const concurrentSessionTargets = context.concurrentSessionTargets || {}; // sessionId -> Set/Array of paths
  const currentSessionId = String(context.sessionId || 'active-session');

  // State trackers across turns
  let consecutiveRetrySig = '';
  let consecutiveRetryCount = 0;

  // DET-02: path -> Array<{ turnIndex, hash }>
  const fileHashHistory = new Map();

  // DET-04: track whether a recent screenshot was black / 0-byte / failed
  let recentBlackScreenshotTurn = -100;

  // DET-05: track most recent test runner exit code
  let lastTestRunnerExitCode = 0;
  let lastTestRunnerSeen = false;

  // DET-06: path::range::hash -> Array<turnIndex>
  const readHistory = new Map();

  // DET-07: consecutive task_boundary errors
  let consecutiveTaskBoundaryErrors = 0;

  // DET-13: track PLANNING phase & whether user approved
  let inPlanningPhase = false;
  let userApprovedPlan = Boolean(context.userApprovedPlan);
  const destructiveEditedFilesInPlan = new Set();

  for (let idx = 0; idx < list.length; idx++) {
    const step = list[idx] || {};
    const stepType = String(step.type || '').toUpperCase();
    const role = String(step.role || step.source || '').toLowerCase();
    const content = String(step.content || '');
    const thinking = String(step.thinking || step.rrthought || '');
    const calls = Array.isArray(step.toolCalls)
      ? step.toolCalls
      : (Array.isArray(step.tool_calls) ? step.tool_calls : []);

    // Check if user turn authorized test deletion or approved plan
    if (stepType === 'USER_INPUT' || role === 'user') {
      if (/\b(approve|approved|proceed|lgtm|looks good|go ahead)\b/i.test(content)) {
        userApprovedPlan = true;
        inPlanningPhase = false;
      }
    }

    // DET-07: <rrthought> Panic & Instruction-Loop Spiral
    const thoughtBlob = `${thinking}\n${content}`;
    const capsMatches = thoughtBlob.match(/\b(CRITICAL INSTRUCTIONS|MUST NOT FAIL|PANIC|DO NOT REPEAT THIS ERROR|IMPOSSIBLE STATE)\b/g) || [];
    const circularMatches = thoughtBlob.match(/\b(wait, no, actually|no wait that's wrong|wait let me rethink from scratch)\b/gi) || [];
    if (capsMatches.length >= 2 || circularMatches.length >= 3) {
      findings.push({
        detectorId: 'DET-07',
        turnIndex: idx,
        severity: 'CRITICAL',
        haltsGeneration: true,
        message: `🚨 DET-07 Blocked: <rrthought> panic or high-entropy instruction loop detected at turn #${idx}.`
      });
    }

    // DET-15: Secret / Credential Leakage in Brain Artifacts or Transcript
    const secretRe = /(\bsk-(?:proj-|live-)?[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{24,}|\bAIza[0-9A-Za-z_-]{30,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{28,})/;
    if (secretRe.test(content)) {
      findings.push({
        detectorId: 'DET-15',
        turnIndex: idx,
        severity: 'CRITICAL',
        haltsGeneration: true,
        message: `🚨 DET-15 Blocked: Secret or credential token leakage detected in transcript/artifact at turn #${idx}.`
      });
    }

    // Check screenshot status for DET-04
    if (
      step.blackScreenshot === true ||
      step.screenshotByteLength === 0 ||
      /black screenshot|zero-byte screenshot|blank_screenshot|0 bytes screenshot/i.test(content)
    ) {
      recentBlackScreenshotTurn = idx;
    }

    for (const call of calls) {
      const toolName = String(call.name || call.tool || '').toLowerCase();
      const args = call.args || call.parameters || call.Arguments || {};
      const targetPath = String(
        args.Path || args.path || args.TargetFile || args.AbsolutePath || step.targetPath || ''
      ).trim();
      const canonTarget = targetPath ? canonicalizePath(targetPath) : '';
      const cmdStr = String(args.CommandLine || args.command || args.cmd || '');
      const exitCode = call.exitCode ?? step.exitCode ?? (step.status === 'ERROR' ? 1 : 0);
      const stderrStr = String(call.stderr || step.stderr || (exitCode !== 0 ? content : ''));
      const stdoutStr = String(call.stdout || step.stdout || content || '');

      // DET-01: Retry Churn (>=3 consecutive identical tool calls returning error)
      const sig = normalizeToolSignature(toolName, args);
      const isFailure = (typeof exitCode === 'number' && exitCode !== 0) || step.status === 'ERROR' || Boolean(call.error);
      if (isFailure) {
        if (sig === consecutiveRetrySig) {
          consecutiveRetryCount++;
        } else {
          consecutiveRetrySig = sig;
          consecutiveRetryCount = 1;
        }
        if (consecutiveRetryCount >= 3) {
          findings.push({
            detectorId: 'DET-01',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            toolName,
            message: `🚨 DET-01 Blocked: Retry Churn (${consecutiveRetryCount} consecutive failed calls to ${toolName}).`
          });
        }
      } else {
        consecutiveRetrySig = '';
        consecutiveRetryCount = 0;
      }

      // DET-07 (task_boundary consecutive errors)
      if (toolName === 'task_boundary' && isFailure) {
        consecutiveTaskBoundaryErrors++;
        if (consecutiveTaskBoundaryErrors >= 2) {
          findings.push({
            detectorId: 'DET-07',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            message: `🚨 DET-07 Blocked: Consecutive task_boundary tool errors (${consecutiveTaskBoundaryErrors}).`
          });
        }
      } else if (toolName === 'task_boundary') {
        consecutiveTaskBoundaryErrors = 0;
      }

      // Track test runner executions for DET-05
      const isExecTool = /^(run_command|execute_bash|bash|execute_command)$/.test(toolName);
      if (isExecTool && /\b(pytest|jest|vitest|cargo\s+test|npm\s+test|node\s+--test|go\s+test)\b/i.test(cmdStr)) {
        lastTestRunnerSeen = true;
        lastTestRunnerExitCode = typeof exitCode === 'number' ? exitCode : (isFailure ? 1 : 0);
      }

      // DET-08: Unauthorized Brain / Git Destructive Command
      const isWriteOrDelete = /write|edit|replace|delete|remove/i.test(toolName);
      if (isExecTool) {
        const destructiveCmdRe = /(\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-fd\b|\bRemove-Item\b.*-Recurse.*-Force)/i;
        const brainDeleteRe = /(?:rm|del|Remove-Item|unlink).*\.gemini[\\/]antigravity[\\/]brain/i;
        if (destructiveCmdRe.test(cmdStr) || brainDeleteRe.test(cmdStr)) {
          findings.push({
            detectorId: 'DET-08',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            command: cmdStr,
            message: `🚨 DET-08 Blocked: Unauthorized destructive command intercepted ("${cmdStr.slice(0, 80)}").`
          });
        }
      }
      if (/delete|remove/i.test(toolName) && /\.gemini[\\/]antigravity[\\/]brain/i.test(targetPath)) {
        findings.push({
          detectorId: 'DET-08',
          turnIndex: idx,
          severity: 'CRITICAL',
          haltsGeneration: true,
          targetPath,
          message: `🚨 DET-08 Blocked: Unauthorized brain artifact deletion targeting ${targetPath}.`
        });
      }

      // DET-10: Unbounded CLI Output Flood (>12,000 chars)
      if (isExecTool && (stdoutStr.length > 12000 || stderrStr.length > 12000)) {
        findings.push({
          detectorId: 'DET-10',
          turnIndex: idx,
          severity: 'WARN',
          haltsGeneration: false,
          charCount: Math.max(stdoutStr.length, stderrStr.length),
          message: `⚠️ DET-10 Alert: Unbounded CLI output flood (${Math.max(stdoutStr.length, stderrStr.length)} chars > 12,000 limit).`
        });
      }

      // File read detectors (DET-06)
      const isReadTool = /^(read_file|view_file|read)$/.test(toolName);
      if (isReadTool && canonTarget) {
        const startLine = args.StartLine ?? args.start_line ?? 1;
        const endLine = args.EndLine ?? args.end_line ?? 'EOF';
        const fileHash = call.fileHash || step.fileHash || sha256Hex(stdoutStr || canonTarget);
        const readKey = `${canonTarget}::${startLine}-${endLine}::${fileHash}`;
        const prevReads = readHistory.get(readKey) || [];
        const recentReads = prevReads.filter(prevTurn => (idx - prevTurn) <= 15);
        recentReads.push(idx);
        readHistory.set(readKey, recentReads);

        if (recentReads.length >= 2) {
          findings.push({
            detectorId: 'DET-06',
            turnIndex: idx,
            severity: 'WARN',
            haltsGeneration: false,
            targetPath,
            message: `⚠️ DET-06 Alert: Redundant unchanged file re-read on ${path.basename(targetPath)} (${recentReads.length}x within 15 turns).`
          });
        }
      }

      // File write / edit detectors (DET-02, DET-03, DET-04, DET-05, DET-09, DET-11, DET-13, DET-14, DET-15, DET-16)
      if (isWriteOrDelete && targetPath) {
        const replacementChunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : null;
        const chunksNew = replacementChunks
          ? replacementChunks.map(ch => String(ch?.ReplacementContent ?? ch?.Replacement ?? ch?.newContent ?? '')).filter(Boolean).join('\n')
          : undefined;
        const chunksOld = replacementChunks
          ? replacementChunks.map(ch => String(ch?.TargetContent ?? ch?.Target ?? ch?.oldContent ?? '')).filter(Boolean).join('\n')
          : undefined;
        const newContent = String(
          args.Content ?? args.CodeContent ?? args.Replacement ?? args.ReplacementContent ?? chunksNew ?? args.newContent ?? call.newContent ?? step.newContent ?? ''
        );
        const oldContent = String(
          args.Target ?? args.TargetContent ?? chunksOld ?? args.oldContent ?? call.oldContent ?? step.oldContent ?? ''
        );

        // DET-15 on written content
        if (/walkthrough\.md|transcript\.jsonl/i.test(targetPath) && secretRe.test(newContent)) {
          findings.push({
            detectorId: 'DET-15',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-15 Blocked: Secret/credential leakage in brain artifact ${path.basename(targetPath)}.`
          });
        }

        // DET-02: Edit Oscillation (H1 -> H2 -> H1 within 6 turns)
        const nextHash = call.afterHash || step.afterHash || (newContent ? sha256Hex(newContent) : null);
        const prevHash = call.beforeHash || step.beforeHash || (oldContent ? sha256Hex(oldContent) : null);
        if (canonTarget && nextHash) {
          const hist = fileHashHistory.get(canonTarget) || [];
          if (hist.length === 0 && prevHash) {
            hist.push({ turnIndex: Math.max(0, idx - 1), hash: prevHash });
          }
          const oscillating = hist.some(
            h => h.hash === nextHash && (idx - h.turnIndex) <= 6 && hist[hist.length - 1]?.hash !== nextHash
          );
          hist.push({ turnIndex: idx, hash: nextHash });
          fileHashHistory.set(canonTarget, hist);

          if (oscillating) {
            findings.push({
              detectorId: 'DET-02',
              turnIndex: idx,
              severity: 'CRITICAL',
              haltsGeneration: true,
              targetPath,
              message: `🚨 DET-02 Blocked: Edit oscillation (H1 -> H2 -> H1 SHA-256 revert within 6 turns) on ${path.basename(targetPath)}.`
            });
          }
        }

        // DET-03: Test-Assertion Weakening
        if (isTestFilePath(targetPath) && !userAuthorizedTestDeletion && !step.userAuthorizedTestDeletion) {
          const beforeAssertions = countAssertionsInCode(oldContent);
          const afterAssertions = countAssertionsInCode(newContent);
          const beforeSkips = countSkipsInCode(oldContent);
          const afterSkips = countSkipsInCode(newContent);

          const deletedAssertions = Math.max(0, beforeAssertions - afterAssertions);
          const addedSkips = Math.max(0, afterSkips - beforeSkips);

          if (deletedAssertions > 0 || addedSkips > 0) {
            findings.push({
              detectorId: 'DET-03',
              turnIndex: idx,
              severity: 'CRITICAL',
              haltsGeneration: true,
              targetPath,
              deletedAssertions,
              addedSkips,
              message: `🚨 DET-03 Blocked: Agent attempted to delete ${deletedAssertions} expect()/assert() assertion(s) or add ${addedSkips} skip(s) in ${path.basename(targetPath)}`
            });
          }
        }

        // DET-04: Synthetic Proof / Fake Screenshot Fabrication
        const isBrainOrScratchScript =
          /(\.gemini[\\/]antigravity[\\/]brain|scratch)[\\/].*\.(py|js|mjs)$/i.test(targetPath);
        const importsVisionFabricator =
          /\b(PIL|ImageDraw|matplotlib|cv2|createCanvas)\b/.test(newContent);
        if (isBrainOrScratchScript && importsVisionFabricator && (idx - recentBlackScreenshotTurn) <= 4) {
          findings.push({
            detectorId: 'DET-04',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-04 Blocked: Synthetic proof / fake screenshot generator script detected in ${path.basename(targetPath)} following black screenshot.`
          });
        }

        // DET-05: Unverified [x] Task Completion
        if (/task\.md$/i.test(targetPath) && /[-*]\s*\[x\]/i.test(newContent) && lastTestRunnerSeen && lastTestRunnerExitCode !== 0) {
          findings.push({
            detectorId: 'DET-05',
            turnIndex: idx,
            severity: 'HIGH',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-05 Blocked: Agent marked task.md item [x] while most recent test run exited with code ${lastTestRunnerExitCode}.`
          });
        }
        if (/walkthrough\.md$/i.test(targetPath) && /\b(all tests pass|tests passed|0 errors)\b/i.test(newContent) && lastTestRunnerSeen && lastTestRunnerExitCode !== 0) {
          findings.push({
            detectorId: 'DET-05',
            turnIndex: idx,
            severity: 'HIGH',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-05 Blocked: Agent claimed passing tests in walkthrough.md while most recent test run exited with code ${lastTestRunnerExitCode}.`
          });
        }

        // DET-09: Prefix-Busting Config Mutation
        if (/(^|[\\/])(GEMINI\.md|AGENTS\.md|mcp_config\.json)$/i.test(targetPath) && cachedTokens >= 50000 && cacheTtlSeconds > 0) {
          findings.push({
            detectorId: 'DET-09',
            turnIndex: idx,
            severity: 'HIGH',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-09 Blocked: Mid-session mutation of ${path.basename(targetPath)} while Cached History (${cachedTokens} tok) >= 50k and TTL (${cacheTtlSeconds}s) > 0.`
          });
        }

        // DET-11: Phantom File / Identifier Confabulation in implementation_plan.md or walkthrough.md
        if (/(implementation_plan|walkthrough)\.md$/i.test(targetPath) && (existingFilesSet || workspacePath)) {
          const lines = newContent.split(/\r?\n/);
          for (const line of lines) {
            if (/\[NEW\]/i.test(line)) continue;
            const pathMatches = line.match(/\b(?:src|lib|app|sidecars|scripts|tests)\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|py|json|html)\b/g) || [];
            for (const refRel of pathMatches) {
              const absCandidate = workspacePath ? path.resolve(workspacePath, refRel) : refRel;
              const canonCandidate = canonicalizePath(absCandidate);
              const existsInSet = existingFilesSet
                ? (existingFilesSet.has(canonCandidate) || existingFilesSet.has(canonicalizePath(refRel)))
                : (workspacePath ? fs.existsSync(absCandidate) : true);
              if (!existsInSet) {
                findings.push({
                  detectorId: 'DET-11',
                  turnIndex: idx,
                  severity: 'HIGH',
                  haltsGeneration: false,
                  phantomPath: refRel,
                  message: `⚠️ DET-11 Alert: Phantom file path "${refRel}" referenced in ${path.basename(targetPath)} does not exist in workspace.`
                });
              }
            }
          }
        }

        // DET-13: Premature Execution Without Plan Approval
        if (/implementation_plan\.md$/i.test(targetPath)) {
          inPlanningPhase = true;
        } else if (
          inPlanningPhase &&
          approvalGateEnabled &&
          !userApprovedPlan &&
          !/(\.gemini[\\/]antigravity[\\/]brain|task\.md|implementation_plan\.md)/i.test(targetPath)
        ) {
          destructiveEditedFilesInPlan.add(canonTarget);
          if (destructiveEditedFilesInPlan.size >= 2) {
            findings.push({
              detectorId: 'DET-13',
              turnIndex: idx,
              severity: 'CRITICAL',
              haltsGeneration: true,
              targetPath,
              message: `🚨 DET-13 Blocked: Premature multi-file execution (${destructiveEditedFilesInPlan.size} files) without user approval after implementation_plan.md creation.`
            });
          }
        }

        // DET-14: Subagent File-Write Collision
        if (canonTarget && concurrentSessionTargets && typeof concurrentSessionTargets === 'object') {
          for (const [otherSid, targets] of Object.entries(concurrentSessionTargets)) {
            if (otherSid === currentSessionId) continue;
            const targetList = Array.isArray(targets) ? targets : Array.from(targets || []);
            if (targetList.some(t => canonicalizePath(t) === canonTarget)) {
              findings.push({
                detectorId: 'DET-14',
                turnIndex: idx,
                severity: 'CRITICAL',
                haltsGeneration: true,
                targetPath,
                conflictingSessionId: otherSid,
                message: `🚨 DET-14 Blocked: Subagent file-write collision on ${path.basename(targetPath)} with concurrent session ${otherSid}.`
              });
            }
          }
        }

        // DET-16: Silent Truncation / Placeholder Slop Injection
        const slopRe = /(\/\/\s*TODO:\s*implement\s+rest|\/\/\s*\.\.\.\s*existing\s+code\s*\.\.\.|#\s*\.\.\.\s*existing\s+code\s*\.\.\.|\/\*\s*\.\.\.\s*rest\s+of\s+code\s*\.\.\.\s*\*\/)/i;
        const oldLines = oldContent ? oldContent.split(/\r?\n/).length : 0;
        const newLines = newContent ? newContent.split(/\r?\n/).length : 0;
        const suddenLineDrop = oldLines >= 20 && newLines > 0 && ((oldLines - newLines) / oldLines) > 0.40;
        if (slopRe.test(newContent) || suddenLineDrop) {
          findings.push({
            detectorId: 'DET-16',
            turnIndex: idx,
            severity: 'CRITICAL',
            haltsGeneration: true,
            targetPath,
            message: `🚨 DET-16 Blocked: Silent truncation or placeholder slop injection detected in ${path.basename(targetPath)}.`
          });
        }
      }
    }

    // DET-12: Zombie Background Subprocess Leak on turn completion
    const orphans = Array.isArray(step.orphanedProcesses)
      ? step.orphanedProcesses
      : (idx === list.length - 1 && Array.isArray(context.orphanedProcesses) ? context.orphanedProcesses : []);
    for (const proc of orphans) {
      const pName = String(proc.name || '').toLowerCase();
      if (/(python|python3|node|cargo|pytest)/.test(pName) && (proc.cpuPct === 0 || proc.orphaned === true || proc.parentAlive === false)) {
        findings.push({
          detectorId: 'DET-12',
          turnIndex: idx,
          severity: 'HIGH',
          haltsGeneration: false,
          pid: proc.pid,
          processName: proc.name,
          message: `⚠️ DET-12 Alert: Zombie background subprocess leak (${proc.name} PID ${proc.pid}, 0% CPU / orphaned).`
        });
      }
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - startHr) / 1e6;
  const shouldHalt = findings.some(f => f.haltsGeneration);

  return {
    findings,
    shouldHalt,
    haltFinding: findings.find(f => f.haltsGeneration) || null,
    elapsedMs: Number(elapsedMs.toFixed(3))
  };
}

/**
 * Real-Time Event Multiplexer (`HookStateMachine`) synthesizing `PreInvocation`,
 * `PreToolUse`, `PostToolUse`, and `Stop` events and triggering `AgBridgeService.pauseActiveGeneration`
 * when a critical detector trips.
 */
export class HookStateMachine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bridge = options.bridge || null;
    this.sessionId = options.sessionId || 'default-session';
    this.context = options.context || {};
    this.steps = [];
    this.activeFindings = [];
    this.paused = false;
  }

  async ingestStep(step = {}, eventType = 'PostToolUse') {
    this.steps.push(step);
    this.emit(eventType, step);

    const evalRes = evaluateDetectorsOnSteps(this.steps, {
      ...this.context,
      sessionId: this.sessionId
    });
    this.activeFindings = evalRes.findings;

    if (evalRes.shouldHalt && !this.paused) {
      this.paused = true;
      const haltReason = evalRes.haltFinding?.detectorId || 'CIRCUIT_BREAKER';
      this.emit('CircuitBreakerTrip', evalRes.haltFinding);
      if (this.bridge && typeof this.bridge.pauseActiveGeneration === 'function') {
        await this.bridge.pauseActiveGeneration(this.sessionId, {
          reason: haltReason,
          finding: evalRes.haltFinding
        });
      }
      this.emit('Stop', { reason: haltReason, finding: evalRes.haltFinding });
    }

    return evalRes;
  }
}

export default HookStateMachine;
