/**
 * Handoff Quality Gate & Checkpoint Auditor.
 * Adapted from .agents/skills/handoff-auditor/SKILL.md & state-compressor/SKILL.md.
 * Verifies that task.md / STATE.md is clean, actionable, and ready before compaction or handoff.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isInternalTelemetryPath, isCompactionRelevant, synthesizeParameterizedCompact } from './prompt_rubric.mjs';
import { canonicalizePath } from './paths.mjs';

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
      const taskHint = sessionSignals?.activeSignal?.taskMdPathHint;
      if (fs.existsSync(taskMd)) targetFile = taskMd;
      else if (taskHint && fs.existsSync(taskHint)) targetFile = taskHint;
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
  const sessionEdited = Boolean(
    sessionSignals?.sessionHasWorkspaceEdits ??
    sessionSignals?.activeSignal?.sessionHasWorkspaceEdits ??
    (Array.isArray(options.sessionWrittenPaths) && options.sessionWrittenPaths.length > 0)
  );
  const turnsBehind = sessionSignals?.activeSignal?.taskMdTurnsBehind ?? 0;
  if (turnsBehind > 2 && sessionEdited) {
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
 * Verifies all three brain artifacts (`task.md`, `implementation_plan.md`, `walkthrough.md`)
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
      const hint = filename === 'task.md' ? sessionSignals?.activeSignal?.taskMdPathHint : null;
      if (hint && fs.existsSync(hint)) {
        return { exists: true, path: hint, mtimeMs: fs.statSync(hint).mtimeMs };
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
  let dirtyEntries = [];
  let repoRoot = workspacePath || '';
  if (typeof options.gitPorcelainOutput === 'string') {
    dirtyEntries = parseGitPorcelain(options.gitPorcelainOutput);
  } else if (workspacePath && fs.existsSync(workspacePath)) {
    const snap = readGitStatusCached(workspacePath);
    dirtyEntries = snap.entries;
    repoRoot = snap.repoRoot || workspacePath;
  }
  dirtyFiles = dirtyEntries.map(e => `${e.status} ${e.path}`);

  // session-scoped drift — only files this session wrote/edited count toward the warning.
  const hasSessionScope = Array.isArray(options.sessionWrittenPaths);
  let sessionDirtyFiles = [];
  if (hasSessionScope) {
    const norm = (p) => canonicalizePath(p).toLowerCase();
    const sessionSet = new Set(options.sessionWrittenPaths.filter(Boolean).map(norm));
    sessionDirtyFiles = dirtyEntries
      .filter(e => {
        const abs = path.isAbsolute(e.path) ? e.path : path.join(repoRoot || '', e.path);
        return sessionSet.has(norm(abs));
      })
      .map(e => e.path);
  }

  const turnsBehind = Number(sessionSignals?.activeSignal?.taskMdTurnsBehind ?? 0);
  const isTaskMdStale = !artifacts.taskMd.exists || turnsBehind >= 1;
  const hasDirtyGit = hasSessionScope ? sessionDirtyFiles.length > 0 : dirtyFiles.length > 0;
  const compactionRelevant = isCompactionRelevant({
    totalActiveTokens: sessionSignals?.totalActiveTokens ?? 0,
    sludgeTokens: sessionSignals?.sludgeTokens ?? 0
  });
  const explicitEditFlag = sessionSignals?.sessionHasWorkspaceEdits ?? sessionSignals?.activeSignal?.sessionHasWorkspaceEdits;
  const sessionEditedWorkspace =
    explicitEditFlag !== undefined
      ? Boolean(explicitEditFlag)
      : (hasSessionScope ? sessionDirtyFiles.length > 0 : true);
  const preCompactionWarning = hasDirtyGit && sessionEditedWorkspace && isTaskMdStale && compactionRelevant;
  const taskMdState = !artifacts.taskMd.exists ? 'missing' : `${turnsBehind} turn${turnsBehind === 1 ? '' : 's'} stale`;
  let preCompactionWarningMessage = '';
  if (preCompactionWarning) {
    if (hasSessionScope) {
      const n = sessionDirtyFiles.length;
      preCompactionWarningMessage = `\u26A0\uFE0F ${n} file${n === 1 ? '' : 's'} edited in this session ${n === 1 ? 'is' : 'are'} uncommitted (${dirtyFiles.length} repo-wide) while task.md is ${taskMdState}.`;
    } else {
      // Legacy shape (direct unit calls without a session path set).
      preCompactionWarningMessage = `\u26A0\uFE0F Pre-Compaction Drift Warning: ${dirtyFiles.length} uncommitted workspace file(s) detected via git status --porcelain while task.md is ${taskMdState}. Sync task.md before compacting.`;
    }
  }

  return {
    artifacts,
    gitDrift: {
      hasDirtyFiles: dirtyFiles.length > 0,
      dirtyFileCount: dirtyFiles.length,
      dirtyFiles: dirtyFiles.slice(0, 15),
      sessionScoped: hasSessionScope,
      sessionDirtyFileCount: hasSessionScope ? sessionDirtyFiles.length : null,
      sessionDirtyFiles: hasSessionScope ? sessionDirtyFiles.slice(0, 15) : []
    },
    preCompactionWarning,
    preCompactionWarningMessage
  };
}

/**
 * Parses `git status --porcelain=v1` output. Accepts both `-z` (NUL-separated) and newline output.
 * Status columns are read BEFORE any trimming (a leading space in " M path" is significant).
 * Renames/copies report the NEW path. Returns [{ status, path }] with repo-root-relative paths.
 */
export function parseGitPorcelain(output = '') {
  const s = String(output || '');
  const entries = [];
  if (s.includes('\0')) {
    const parts = s.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (!rec || rec.length < 4) continue;
      const status = rec.slice(0, 2);
      const p = rec.slice(3);
      // In -z mode a rename/copy record is "XY new\0old": skip the following old-path field.
      if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') i++;
      if (p) entries.push({ status, path: p });
    }
    return entries;
  }
  for (const rawLine of s.split(/\r?\n/)) {
    if (!rawLine || !rawLine.trim() || rawLine.length < 4) continue;
    const status = rawLine.slice(0, 2);
    let p = rawLine.slice(3);
    if ((status[0] === 'R' || status[0] === 'C') && p.includes(' -> ')) p = p.split(' -> ').pop();
    p = p.trim().replace(/^"(.*)"$/, '$1');
    if (p) entries.push({ status, path: p });
  }
  return entries;
}

const GIT_STATUS_CACHE_TTL_MS = 4000;
const gitStatusCache = new Map();

/**
 * Runs `git status --porcelain=v1 -z -uall` (no shell) plus `git rev-parse --show-toplevel`,
 * cached for a few seconds per workspace so refreshes don't spawn git every time.
 */
export function readGitStatusCached(workspacePath, { nowMs = Date.now(), ttlMs = GIT_STATUS_CACHE_TTL_MS } = {}) {
  const key = canonicalizePath(workspacePath).toLowerCase();
  const hit = gitStatusCache.get(key);
  if (hit && (nowMs - hit.atMs) < ttlMs) return hit.value;
  let value = { entries: [], repoRoot: '' };
  try {
    const execOpts = { cwd: workspacePath, encoding: 'utf8', timeout: 1200, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 };
    const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], execOpts);
    let repoRoot = '';
    try {
      repoRoot = String(execFileSync('git', ['rev-parse', '--show-toplevel'], execOpts) || '').trim();
    } catch {}
    value = { entries: parseGitPorcelain(String(out || '')), repoRoot };
  } catch {}
  gitStatusCache.set(key, { atMs: nowMs, value });
  return value;
}

/**
 * Generates the Baton Pass (`/handoff`) Markdown file summarizing
 * active AST contracts, test states, brain artifact status, and pending `task.md` tasks.
 */
export function generateHandoffMarkdown(state = {}, options = {}) {
  const ts = options.timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const relPath = `docs/HANDOFF_${ts}.md`;
  const wsPath = options.workspacePath || state?.workspace?.canonicalPath || process.cwd();
  const absPath = path.resolve(wsPath, relPath);

  const sessionId = state?.sessionId || state?.conversationId || 'active-session';
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
    synthesizeParameterizedCompact({
      activeFiles,
      userCorrections: state?.brainSignals?.userCorrectionTexts || [],
      workspaceRoot: wsPath
    });

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

/**
 * Deterministically extracts a rotating `.handoff.md` file at >=80% context saturation
 * (or on explicit 1-click/hook invocation) without LLM calls, containing:
 *  (1) Modified and inspected file paths (`toolUseResult.filePath`, `structuredPatch`, `edited_text_file`, `codeBlockDiff`)
 *  (2) Active checklist items (`TodoWrite`, `goal_status`, `task.md.resolved`)
 *  (3) Last 3 user prompts + unresolved `stderr`/`errorDetails`
 */
export function distillPreCompactionHandoff(steps = [], state = {}, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const totalTok = Number(state?.window?.totalActiveTokens || options.totalActiveTokens || 0);
  const maxTok = Number(state?.window?.maxTokens || options.maxTokens || 256000);
  const saturationPct = maxTok > 0 ? Math.round((totalTok / maxTok) * 100) : 0;
  const shouldTrigger = Boolean(options.force || saturationPct >= 80);

  const modifiedPaths = new Set();
  const inspectedPaths = new Set();
  const checklistItems = [];
  const userPrompts = [];
  const unresolvedErrors = [];

  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const type = String(s.type || s.role || '').toUpperCase();
    const calls = Array.isArray(s.toolCalls)
      ? s.toolCalls
      : (Array.isArray(s.tool_calls) ? s.tool_calls : []);

    if (type === 'USER_INPUT' || type === 'USER') {
      const promptText = String(s.content || s.text || '').trim();
      if (promptText) userPrompts.push(promptText.slice(0, 240));
    }

    if (s.toolUseResult?.filePath) {
      const fp = String(s.toolUseResult.filePath);
      if (s.toolUseResult.structuredPatch || s.structuredPatch) modifiedPaths.add(fp);
      else inspectedPaths.add(fp);
    }
    if (s.edited_text_file) modifiedPaths.add(String(s.edited_text_file));
    if (s.codeBlockDiff?.filePath) modifiedPaths.add(String(s.codeBlockDiff.filePath));

    for (const c of calls) {
      const name = String(c.name || c.tool || '').toLowerCase();
      const args = c.args || c.parameters || c.Arguments || {};
      const fp = args.Path || args.path || args.TargetFile || args.AbsolutePath;
      if (fp && typeof fp === 'string' && !isInternalTelemetryPath(fp)) {
        if (/edit|write|replace/i.test(name)) modifiedPaths.add(fp);
        else if (/read|view/i.test(name)) inspectedPaths.add(fp);
      }
      if (name === 'todowrite' && Array.isArray(args.todos)) {
        for (const td of args.todos) {
          if (td && td.content) {
            const box = td.status === 'completed' ? '[x]' : (td.status === 'in_progress' ? '[/]' : '[ ]');
            checklistItems.push(`- ${box} ${td.content}`);
          }
        }
      }
    }

    if (s.goal_status && typeof s.goal_status === 'string') {
      checklistItems.push(`- [/] ${s.goal_status.trim()}`);
    }

    const isErr = Boolean(
      s.status === 'ERROR' ||
      (typeof s.exitCode === 'number' && s.exitCode !== 0) ||
      s.errorDetails ||
      s.stderr
    );
    if (isErr) {
      const errMsg = String(s.errorDetails || s.stderr || s.content || '').trim().split(/\r?\n/).slice(0, 3).join(' | ');
      if (errMsg) unresolvedErrors.push(`Turn #${s.stepIndex ?? i}: ${errMsg.slice(0, 200)}`);
    } else if (calls.some(c => /run_command|bash/i.test(String(c.name || ''))) && s.exitCode === 0) {
      // Later passing test run clears earlier transient command errors
      unresolvedErrors.length = 0;
    }
  }

  const brainDir = options.brainDir || state?.brainDir || '';
  if (brainDir) {
    for (const fname of ['task.md.resolved', 'task.md']) {
      const p = path.join(brainDir, fname);
      if (fs.existsSync(p)) {
        try {
          const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(l => /^[-*]\s*\[[ x/]\]/i.test(l.trim()));
          for (const l of lines.slice(0, 12)) checklistItems.push(l.trim());
          break;
        } catch {}
      }
    }
  }

  const recentUserPrompts = userPrompts.slice(-3);
  const modList = Array.from(modifiedPaths);
  const inspList = Array.from(inspectedPaths).filter(p => !modifiedPaths.has(p));

  const wsPath = options.workspacePath || state?.workspace?.canonicalPath || process.cwd();
  const handoffPath = options.outputPath || path.join(wsPath, '.handoff.md');

  const markdown = [
    `# Pre-Compaction Deterministic Handoff (\`.handoff.md\`)`,
    ``,
    `- **Context Saturation**: ${saturationPct}% (${Math.round(totalTok / 1000)}k / ${Math.round(maxTok / 1000)}k tokens)`,
    `- **Distilled At**: ${new Date().toISOString()}`,
    ``,
    `## 1. Modified & Inspected Files`,
    `### Modified (${modList.length})`,
    ...(modList.length > 0 ? modList.map(p => `- \`${p}\``) : ['- None']),
    `### Inspected (${inspList.length})`,
    ...(inspList.length > 0 ? inspList.slice(0, 15).map(p => `- \`${p}\``) : ['- None']),
    ``,
    `## 2. Active Checklist & Goal State`,
    ...(checklistItems.length > 0 ? Array.from(new Set(checklistItems)) : ['- [ ] Continue active implementation task']),
    ``,
    `## 3. Last 3 User Prompts`,
    ...(recentUserPrompts.length > 0 ? recentUserPrompts.map((p, idx) => `${idx + 1}. "${p}"`) : ['1. (No user prompts recorded)']),
    ``,
    `## 4. Unresolved Errors / Stderr`,
    ...(unresolvedErrors.length > 0 ? unresolvedErrors.slice(-5).map(e => `- ${e}`) : ['- Zero unresolved errors']),
    ``
  ].join('\n');

  let written = false;
  if (shouldTrigger && options.writeToDisk !== false) {
    try {
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      const tmp = `${handoffPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, markdown, 'utf8');
      fs.renameSync(tmp, handoffPath);
      written = true;
    } catch {}
  }

  return {
    triggered: shouldTrigger,
    written,
    saturationPct,
    handoffPath,
    modifiedFiles: modList,
    inspectedFiles: inspList,
    checklistItems: Array.from(new Set(checklistItems)),
    lastUserPrompts: recentUserPrompts,
    unresolvedErrors,
    markdown
  };
}

