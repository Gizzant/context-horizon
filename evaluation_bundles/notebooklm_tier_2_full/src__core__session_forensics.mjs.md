# Source File: src/core/session_forensics.mjs

```javascript
/**
 * Session Forensics & Deterministic Quality Diagnostics.
 * Adapted from antigravity-postmortem-workflows (analyze-project, verify, recover, pause).
 * Zero external dependencies, pure functions with bounded runtime.
 */

/**
 * Normalizes an error string to create a durable fingerprint across turns.
 * Strips line numbers, timestamps, hex addresses, and file paths.
 */
export function normalizeErrorSignature(cmd = '', errorOutput = '') {
  const baseCmd = String(cmd || '').trim().split(/\s+/)[0].split(/[\\/]/).pop() || 'command';
  const firstLine = String(errorOutput || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('Created At:') && !l.startsWith('Completed At:')) || '';

  const clean = firstLine
    .replace(/[A-Za-z]:\\[^:\s]+/g, '<path>')
    .replace(/\/[^:\s]+/g, '<path>')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\b/g, '<date>')
    .replace(/:\d+:\d+/g, ':<line>')
    .replace(/\d+/g, '<n>')
    .trim()
    .slice(0, 100);

  return `${baseCmd}::${clean}`;
}

/**
 * Detects plan and task churn across session steps.
 * Revisions >= 3 indicate plan thrashing (severity warning in postmortem repo).
 */
export function computePlanChurn(steps = [], config = {}) {
  const planWarnThreshold = config.plan_revision_warn ?? 3;
  let planRevisions = 0;
  let taskRevisions = 0;
  const taskWriteIndices = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const calls = s?.toolCalls || s?.tool_calls || [];
    for (const call of calls) {
      const name = call.name || call.tool || '';
      const args = call.args || {};
      const targetPath = String(args.Path || args.path || args.TargetFile || args.AbsolutePath || '');
      const isWrite = /write|edit|replace|create|append/i.test(name);

      if (isWrite) {
        if (/implementation_plan\.md/i.test(targetPath)) {
          planRevisions++;
        } else if (/task\.md/i.test(targetPath)) {
          taskRevisions++;
          taskWriteIndices.push(i);
        }
      }
    }
  }

  // Late-stage task churn: multiple task rewrites in the last 30% of turns
  const lateCutoff = Math.floor(steps.length * 0.7);
  const lateTaskWrites = taskWriteIndices.filter(idx => idx >= lateCutoff).length;
  const lateStageTaskChurn = lateTaskWrites >= 2 && steps.length >= 10;

  return {
    planRevisions,
    taskRevisions,
    lateStageTaskChurn,
    warn: planRevisions >= planWarnThreshold
  };
}

/**
 * Grades proof quality when completion is claimed.
 * Strong = actual test/build/lint output with exitCode 0, or visual screenshots.
 * Medium = generic successful command execution.
 * Weak = only file edits without execution.
 * None = verbal claim with zero tool output.
 */
export function gradeProofQuality(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { grade: 'None', reason: 'No steps in session', claimStepIndex: -1 };
  }

  // Find the most recent step claiming completion
  let claimStepIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const content = String(s.content || '');
    const calls = s.toolCalls || s.tool_calls || [];
    const isWalkthrough = calls.some(c => /walkthrough\.md/i.test(JSON.stringify(c.args || {})));

    if (isWalkthrough || /\b(completed the task|task is complete|all steps (are )?verified|fixes verified|everything is working)\b/i.test(content)) {
      claimStepIndex = i;
      break;
    }
  }

  // If no explicit completion claim was found, check the final turn
  if (claimStepIndex === -1) {
    claimStepIndex = steps.length - 1;
  }

  // Inspect tool executions in the 5 turns leading up to or including the claim
  const windowStart = Math.max(0, claimStepIndex - 5);
  const relevantSteps = steps.slice(windowStart, claimStepIndex + 1);

  let hasTestPass = false;
  let hasBuildPass = false;
  let hasGenericPass = false;
  let hasFileEdits = false;
  let toolCount = 0;

  for (const s of relevantSteps) {
    const calls = s.toolCalls || s.tool_calls || [];
    toolCount += calls.length;

    for (const call of calls) {
      const name = call.name || call.tool || '';
      const args = call.args || {};
      const cmd = String(args.CommandLine || args.command || '');
      const exitCode = s.exitCode ?? (s.status === 'ERROR' ? 1 : 0);

      if (/write|edit|replace/i.test(name)) {
        hasFileEdits = true;
      }

      if (/run_command/i.test(name) || cmd) {
        if (exitCode === 0) {
          if (/(test|vitest|jest|pytest|cargo test|go test|npm test)/i.test(cmd)) {
            hasTestPass = true;
          } else if (/(node --check|build|tsc|lint|verify)/i.test(cmd)) {
            hasBuildPass = true;
          } else {
            hasGenericPass = true;
          }
        }
      }
    }
  }

  if (hasTestPass || hasBuildPass) {
    return {
      grade: 'Strong',
      reason: hasTestPass ? 'Verified via passing automated test suite' : 'Verified via syntax check / build run',
      claimStepIndex
    };
  }

  if (hasGenericPass) {
    return {
      grade: 'Medium',
      reason: 'Executed commands exited 0, but no dedicated test/build suite run',
      claimStepIndex
    };
  }

  if (hasFileEdits) {
    return {
      grade: 'Weak',
      reason: 'Files were edited but no automated execution or verification test was run',
      claimStepIndex
    };
  }

  return {
    grade: 'None',
    reason: 'Completion stated verbally without tool execution proof',
    claimStepIndex
  };
}

/**
 * Detects context rot and recommends splitting long, degrading sessions.
 * Ground rule: Duration alone never triggers split; requires evidence of performance decay.
 */
export function detectContextRot(steps = [], state = {}, config = {}) {
  const splitMinutesThreshold = config.split_recommend_minutes ?? 45;

  if (!Array.isArray(steps) || steps.length < 6) {
    return { elapsedMinutes: 0, splitRecommended: false, reason: 'Session too young to assess rot' };
  }

  // Estimate session duration from ISO timestamps
  let firstTs = null;
  let lastTs = null;
  for (const s of steps) {
    if (s.created_at) {
      const t = new Date(s.created_at).getTime();
      if (!isNaN(t)) {
        if (!firstTs || t < firstTs) firstTs = t;
        if (!lastTs || t > lastTs) lastTs = t;
      }
    }
  }

  const elapsedMinutes = (firstTs && lastTs && lastTs > firstTs)
    ? Math.round((lastTs - firstTs) / (1000 * 60))
    : Math.round(steps.length * 1.5); // Fallback: ~1.5 min per step

  // Compare error rate: first third vs last third
  const third = Math.max(2, Math.floor(steps.length / 3));
  const initialSteps = steps.slice(0, third);
  const finalSteps = steps.slice(-third);

  const isErr = s => s.status === 'ERROR' || (s.exitCode !== undefined && s.exitCode !== 0);
  const errInitial = initialSteps.filter(isErr).length / initialSteps.length;
  const errFinal = finalSteps.filter(isErr).length / finalSteps.length;

  const errorRateDeteriorated = errFinal > 0.25 && errFinal > (errInitial * 1.5);
  const userCorrections = state.correctionCount || 0;
  const lateTaskChurn = Boolean(state.lateStageTaskChurn);
  const lowPurity = (state.totalActiveTokens > 100000) && ((state.signalPurityPct ?? 100) < 45);

  const hasDegradation = errorRateDeteriorated || userCorrections >= 3 || lateTaskChurn || lowPurity;
  const splitRecommended = elapsedMinutes >= splitMinutesThreshold && hasDegradation;

  let reason = 'Context health stable';
  if (splitRecommended) {
    reason = `Session elapsed ${elapsedMinutes}m (>=${splitMinutesThreshold}m) with degrading error rate or late churn; checkpoint and /clear recommended`;
  }

  return {
    elapsedMinutes,
    errorRateInitial: Number(errInitial.toFixed(2)),
    errorRateFinal: Number(errFinal.toFixed(2)),
    splitRecommended,
    reason
  };
}

/**
 * Fingerprints command failures to detect loops across non-consecutive steps.
 * Categorizes failure into config | logic | integration | tooling.
 */
export function fingerprintErrorLoop(steps = []) {
  const occurrences = new Map();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const isError = s.status === 'ERROR' || (s.exitCode !== undefined && s.exitCode !== 0);
    if (!isError) continue;

    const calls = s.toolCalls || s.tool_calls || [];
    for (const call of calls) {
      const cmd = call.args?.CommandLine || call.args?.command || call.name || 'tool';
      const out = s.content || s.output || '';
      const fp = normalizeErrorSignature(cmd, out);

      if (!occurrences.has(fp)) {
        occurrences.set(fp, []);
      }
      occurrences.get(fp).push({
        stepIndex: i,
        command: cmd,
        firstErrorLine: String(out).split(/\r?\n/)[0]?.slice(0, 120) || ''
      });
    }
  }

  for (const [fp, attempts] of occurrences.entries()) {
    if (attempts.length >= 3) {
      const sampleText = attempts.map(a => a.firstErrorLine).join(' ').toLowerCase();

      let category = 'logic';
      if (/enoent|not found|cannot find module|cannot import/i.test(sampleText)) {
        category = 'config';
      } else if (/econnrefused|etimedout|socket|network|fetch/i.test(sampleText)) {
        category = 'integration';
      } else if (/command failed|syntaxerror|unexpected/i.test(sampleText)) {
        category = 'tooling';
      }

      return {
        loop: true,
        fingerprint: fp,
        occurrences: attempts.length,
        attempts,
        category
      };
    }
  }

  return {
    loop: false,
    fingerprint: null,
    occurrences: 0,
    attempts: [],
    category: null
  };
}
```
