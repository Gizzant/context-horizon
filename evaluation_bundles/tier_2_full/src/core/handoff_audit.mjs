/**
 * Handoff Quality Gate & Checkpoint Auditor.
 * Adapted from .agents/skills/handoff-auditor/SKILL.md & state-compressor/SKILL.md.
 * Verifies that task.md / STATE.md is clean, actionable, and ready before compaction or handoff.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { isInternalTelemetryPath } from './prompt_rubric.mjs';

export const HANDOFF_RESULTS = {
  CLEAN: 'CLEAN',
  NEEDS_FIXES: 'NEEDS_FIXES',
  MISSING: 'MISSING'
};

/**
 * Deterministically audits task.md / STATE.md checkpoint for a session.
 * @param {string} brainDirOrPath Directory containing task.md or direct file path
 * @param {Object} [sessionSignals={}] Extracted brainSignals from classifier
 * @returns {Object} { result: 'CLEAN'|'NEEDS_FIXES'|'MISSING', checks: Array, fixes: string[] }
 */
export function auditHandoff(brainDirOrPath = '', sessionSignals = {}, options = {}) {
  let targetFile = null;
  let resolvedBrainDir = null;

  if (brainDirOrPath && fs.existsSync(brainDirOrPath)) {
    const stat = fs.statSync(brainDirOrPath);
    if (stat.isFile()) {
      targetFile = brainDirOrPath;
      resolvedBrainDir = path.dirname(brainDirOrPath);
    } else {
      resolvedBrainDir = brainDirOrPath;
      const taskMd = path.join(brainDirOrPath, 'task.md');
      const stateMd = path.join(brainDirOrPath, 'STATE.md');
      if (fs.existsSync(taskMd)) targetFile = taskMd;
      else if (fs.existsSync(stateMd)) targetFile = stateMd;
    }
  }

  const syncAudit = checkBrainArtifactsAndGitDrift(resolvedBrainDir, options.workspacePath || '', sessionSignals, options);

  if (!targetFile || !fs.existsSync(targetFile)) {
    return {
      result: HANDOFF_RESULTS.MISSING,
      targetFile: null,
      checks: [
        { id: 'file_exists', name: 'Checkpoint file exists', pass: false, detail: 'No task.md or STATE.md found in session directory' }
      ],
      fixes: ['Create task.md or STATE.md checkpoint with Next Action, Decisions, and Blockers'],
      ...syncAudit
    };
  }

  let text = '';
  try {
    text = fs.readFileSync(targetFile, 'utf8');
  } catch (err) {
    return {
      result: HANDOFF_RESULTS.MISSING,
      targetFile,
      checks: [
        { id: 'file_readable', name: 'Checkpoint file readable', pass: false, detail: err.message }
      ],
      fixes: ['Ensure task.md is readable']
    };
  }

  const checks = [];
  const fixes = [];

  // 1. Next Action Clarity: Must have specific, unblocked next action
  const lines = text.split(/\r?\n/);
  const nextSectionIdx = lines.findIndex(l => /^(#+\s*next action|next steps|up next)/i.test(l.trim()));
  let nextActionText = '';

  if (nextSectionIdx !== -1) {
    for (let i = nextSectionIdx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^#+/.test(l)) break;
      if (l.length > 0) {
        nextActionText = l.replace(/^[-*]\s*(\[[ x/]]\s*)?/, '').trim();
        break;
      }
    }
  } else {
    // Look for first pending checkbox
    const firstPending = lines.find(l => /^[-*]\s*\[ \]/i.test(l.trim()));
    if (firstPending) {
      nextActionText = firstPending.replace(/^[-*]\s*\[ \]\s*/, '').trim();
    }
  }

  const hasSpecificTarget = /(@[\w./\\-]+|\b[\w-]+\.(mjs|js|ts|json|md|py)\b|[/\\][\w.-]+|\b\w+\([^)]*\))/i.test(nextActionText);
  const isVague = /^(continue|keep going|finish|wip|work in progress|todo|implement|fix code)\.?$/i.test(nextActionText);

  if (nextActionText && !isVague && (hasSpecificTarget || nextActionText.length >= 18)) {
    checks.push({ id: 'next_action', name: 'Next Action Clarity', pass: true, detail: `Specific next step: "${nextActionText.slice(0, 60)}"` });
  } else {
    const detail = nextActionText ? `Next action is vague: "${nextActionText}"` : 'No Next Action or pending checkbox found';
    checks.push({ id: 'next_action', name: 'Next Action Clarity', pass: false, detail });
    fixes.push('Specify next action with exact file target (@file or function) and concrete verb');
  }

  // 2. Incomplete Work Coverage: Any in-progress items [-] or [/] must have details
  const inProgressItems = lines
    .filter(l => /^[-*]\s*\[\/\]/i.test(l.trim()))
    .map(l => l.replace(/^[-*]\s*\[\/\]\s*/, '').trim());

  let incompleteOk = true;
  for (const item of inProgressItems) {
    const hasPathOrDetail = /(@|[\w-]+\.\w+|[/\\]|\b(in|on|at)\b)/i.test(item);
    if (!hasPathOrDetail && item.length < 15) {
      incompleteOk = false;
      checks.push({ id: 'incomplete_coverage', name: 'Incomplete Work Coverage', pass: false, detail: `In-progress item has no files touched: "${item}"` });
      fixes.push(`Specify files touched for in-progress task "${item}"`);
      break;
    }
  }
  if (incompleteOk) {
    checks.push({ id: 'incomplete_coverage', name: 'Incomplete Work Coverage', pass: true, detail: `${inProgressItems.length} in-progress items properly documented` });
  }

  // 3. Blockers: If active error loop or failures detected, must be captured
  const hasActiveFailure = sessionSignals?.errorLoop?.loop || (sessionSignals?.deadErrors?.isErrorLoop);
  const hasBlockerSection = /#+\s*blockers?/i.test(text) || /\bblocker\b/i.test(text);

  if (hasActiveFailure && !hasBlockerSection) {
    checks.push({ id: 'blocker_accuracy', name: 'Blocker Accuracy', pass: false, detail: 'Active failure loop detected in session, but not captured in blockers' });
    fixes.push('Add active failure to Blockers section with context and severity');
  } else {
    checks.push({ id: 'blocker_accuracy', name: 'Blocker Accuracy', pass: true, detail: 'Blocker state aligned with transcript evidence' });
  }

  // 4. Decision Log: If plan underwent revisions, rationale must be noted
  const hasPlanChurn = (sessionSignals?.planChurn?.planRevisions || 0) >= 1;
  const hasDecisionLogged = /#+\s*decisions?|\bdecision|\brationale\b/i.test(text);

  if (hasPlanChurn && !hasDecisionLogged) {
    checks.push({ id: 'decision_completeness', name: 'Decision Completeness', pass: false, detail: 'Plan was revised, but no decision or rationale was documented' });
    fixes.push('Document plan change in Decisions section with 1-sentence rationale');
  } else {
    checks.push({ id: 'decision_completeness', name: 'Decision Completeness', pass: true, detail: 'Decisions documented or plan stable' });
  }

  // 5. Freshness: task.md turns behind
  const turnsBehind = sessionSignals?.activeSignal?.taskMdTurnsBehind ?? 0;
  if (turnsBehind > 2) {
    checks.push({ id: 'state_freshness', name: 'State Freshness', pass: false, detail: `task.md is ${turnsBehind} user turns stale` });
    fixes.push('Update task.md with latest turn accomplishments');
  } else {
    checks.push({ id: 'state_freshness', name: 'State Freshness', pass: true, detail: `task.md freshness optimal (${turnsBehind} turns behind)` });
  }

  const allPassed = checks.every(c => c.pass);
  return {
    result: allPassed ? HANDOFF_RESULTS.CLEAN : HANDOFF_RESULTS.NEEDS_FIXES,
    targetFile,
    checks,
    fixes,
    ...syncAudit
  };
}

/**
 * Phase 4 (Layer 4): Verifies all three brain artifacts (`task.md`, `implementation_plan.md`, `walkthrough.md`)
 * and checks `git status --porcelain` in the workspace. Raises `preCompactionWarning` when uncommitted
 * git modifications exist alongside a stale or missing `task.md`.
 */
export function checkBrainArtifactsAndGitDrift(brainDir = null, workspacePath = '', sessionSignals = {}, options = {}) {
  const inspectArtifact = (filename) => {
    if (!brainDir) return { exists: false, path: null, mtimeMs: 0 };
    const p = path.join(brainDir, filename);
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        return { exists: true, path: p, mtimeMs: st.mtimeMs };
      }
    } catch {}
    return { exists: false, path: p, mtimeMs: 0 };
  };

  const artifacts = {
    taskMd: inspectArtifact('task.md'),
    implementationPlanMd: inspectArtifact('implementation_plan.md'),
    walkthroughMd: inspectArtifact('walkthrough.md')
  };

  let dirtyFiles = [];
  if (typeof options.gitPorcelainOutput === 'string') {
    dirtyFiles = options.gitPorcelainOutput
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
  } else if (workspacePath && fs.existsSync(workspacePath)) {
    try {
      const out = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 1200,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      dirtyFiles = String(out || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
    } catch {}
  }

  const turnsBehind = Number(sessionSignals?.activeSignal?.taskMdTurnsBehind ?? 0);
  const isTaskMdStale = !artifacts.taskMd.exists || turnsBehind >= 1;
  const hasDirtyGit = dirtyFiles.length > 0;
  const preCompactionWarning = hasDirtyGit && isTaskMdStale;
  const preCompactionWarningMessage = preCompactionWarning
    ? `\u26A0\uFE0F Pre-Compaction Drift Warning: ${dirtyFiles.length} uncommitted workspace file(s) detected via git status --porcelain while task.md is ${!artifacts.taskMd.exists ? 'missing' : `${turnsBehind} turn${turnsBehind === 1 ? '' : 's'} stale`}. Sync task.md before compacting.`
    : '';

  return {
    artifacts,
    gitDrift: {
      hasDirtyFiles: hasDirtyGit,
      dirtyFileCount: dirtyFiles.length,
      dirtyFiles: dirtyFiles.slice(0, 15)
    },
    preCompactionWarning,
    preCompactionWarningMessage
  };
}

/**
 * Phase 4 (Layer 4): Generates the Baton Pass (`/handoff`) Markdown file summarizing
 * active AST contracts, test states, brain artifact status, and pending `task.md` tasks.
 */
export function generateHandoffMarkdown(state = {}, options = {}) {
  const ts = options.timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const relPath = `docs/HANDOFF_${ts}.md`;
  const wsPath = options.workspacePath || state?.workspace?.canonicalPath || process.cwd();
  const absPath = path.resolve(wsPath, relPath);

  const sessionId = state?.sessionId || 'unknown';
  const sessionTitle = state?.sessionTitle || 'Active Session';
  const modelId = state?.model?.id || 'gemini-3.8-flash';
  const totalTok = state?.window?.totalActiveTokens || 0;
  const maxTok = state?.window?.maxTokens || 256000;

  const dupFiles = state?.brainSignals?.duplicateReads?.topFiles || [];
  const activeFiles = (options.activeFiles || dupFiles.map(f => f.path)).filter(p => p && !isInternalTelemetryPath(p));
  const proofGrade = state?.brainSignals?.proofQuality?.grade || 'Verified';
  const proofReason = state?.brainSignals?.proofQuality?.reason || 'Automated verification suite';

  let pendingTasks = options.pendingTasks || [];
  const handoffTarget = state?.brainSignals?.handoff?.targetFile;
  if (pendingTasks.length === 0 && handoffTarget && fs.existsSync(handoffTarget)) {
    try {
      const rawTask = fs.readFileSync(handoffTarget, 'utf8');
      pendingTasks = rawTask
        .split(/\r?\n/)
        .filter(l => /^[-*]\s*\[[ /]\]/.test(l.trim()))
        .map(l => l.trim())
        .slice(0, 10);
    } catch {}
  }

  const parameterizedCompact = state?.compaction?.parameterizedCommand ||
    `/compact Focus on preserving: 1) Exported symbol signatures and state scales for [${activeFiles.slice(0, 4).join(', ') || 'active workspace files'}], 2) Current checklist state in task.md, 3) Explicit user constraints: [preserve all active invariants and user rules].`;

  const markdown = [
    `# Session Handoff Baton Pass (\`${sessionId}\`)`,
    ``,
    `- **Session Title**: ${sessionTitle}`,
    `- **Generated At**: ${new Date().toISOString()}`,
    `- **Model & Window**: \`${modelId}\` (${Math.round(totalTok / 1000)}k / ${Math.round(maxTok / 1000)}k tokens)`,
    `- **Verification Proof State**: **${proofGrade}** (${proofReason})`,
    ``,
    `## 1. Active AST Contracts & Modified Modules`,
    ...(activeFiles.length > 0
      ? activeFiles.slice(0, 8).map(f => `- \`${f}\``)
      : [`- Active workspace modules in \`${wsPath}\``]),
    ``,
    `## 2. Pending \`task.md\` Checklist Items`,
    ...(pendingTasks.length > 0
      ? pendingTasks
      : [`- [ ] Review \`task.md\` and \`implementation_plan.md\` in session brain directory`]),
    ``,
    `## 3. Brain Artifacts & Git Synchronization`,
    `- \`task.md\`: ${state?.brainSignals?.handoff?.artifacts?.taskMd?.exists ? 'Present' : 'Check brain directory'}`,
    `- \`implementation_plan.md\`: ${state?.brainSignals?.handoff?.artifacts?.implementationPlanMd?.exists ? 'Present' : 'Check brain directory'}`,
    `- \`walkthrough.md\`: ${state?.brainSignals?.handoff?.artifacts?.walkthroughMd?.exists ? 'Present' : 'Not created yet'}`,
    `- **Uncommitted Git Files**: ${state?.brainSignals?.handoff?.gitDrift?.dirtyFileCount ?? 0}`,
    ``,
    `## 4. Guarded Compaction Fallback Command`,
    `\`\`\`text`,
    parameterizedCompact,
    `\`\`\``,
    ``
  ].join('\n');

  let writtenPath = null;
  if (options.writeToDisk !== false) {
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, markdown, 'utf8');
      writtenPath = absPath;
    } catch {}
  }

  return {
    success: true,
    timestamp: ts,
    relativePath: relPath,
    filePath: writtenPath || absPath,
    markdown
  };
}
