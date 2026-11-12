import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './paths.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { PrefixCacheShield, isWarmCacheState } from './prefix_cache_shield.mjs';

export function buildTrustedPluginHookCommand(hookFileName) {
  const safeHook = path.posix.basename(String(hookFileName || ''));
  return `node --no-warnings -e "import('node:fs').then(fs=>import('node:os').then(os=>import('node:path').then(p=>{const f1=p.join(os.homedir(),'.gemini/config/plugins/agy-horizon-flightcheck/src/hooks/${safeHook}');const f2=p.join(os.homedir(),'.gemini/config/plugins/agy-horizon/src/hooks/${safeHook}');const target=fs.existsSync(f1)?f1:(fs.existsSync(f2)?f2:'');if(target)import(process.platform==='win32'?'file:///'+target.replace(/\\\\/g,'/'):target);})));"`;
}

/**
 * Epoch-Aware File Re-Read Classifier, Fail-Open CLI Output Dampener,
 * and Positional Rule Promotion.
 */

export const CORTEX_STEP_TYPE_CHECKPOINT = 23;
export const MEMORY_MD_TRUNCATION_THRESHOLD_LINES = 200;
export const SWARM_TOOL_MATCHER = 'invoke_subagent|define_subagent|send_message|manage_subagents';
export const FULL_TOOL_HOOK_MATCHER =
  'run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|read_file|view_file|grep_search|find_by_name|list_dir|invoke_subagent|define_subagent|send_message|manage_subagents|swarm';
export const LEAN_PRE_TOOL_HOOK_MATCHER =
  'run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|read_file|view_file|invoke_subagent|define_subagent|send_message|manage_subagents|swarm';
export const LEAN_POST_TOOL_HOOK_MATCHER =
  'run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|invoke_subagent|define_subagent|send_message|manage_subagents|swarm';
export const CLI_DAMPENER_MATCHER = 'run_command|execute_bash|bash|Bash|PowerShell';
export const FLAT_LIFECYCLE_EVENTS = Object.freeze(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']);

const READ_TOOLS = new Set([
  'view_file',
  'read_file',
  'view_file_outline',
  'view_code_item',
  'read',
  'read_file_v2'
]);

const EDIT_TOOLS = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'write_file',
  'edit_file',
  'edit',
  'multiedit',
  'multi_edit',
  'write',
  'notebookedit',
  'edit_file_v2'
]);

/**
 * Determines whether a parsed step or stepEvent represents a Cortex compaction checkpoint
 * (`CORTEX_STEP_TYPE_CHECKPOINT = 23`).
 */
export function isCompactionCheckpointStep(step) {
  if (!step || typeof step !== 'object') return false;
  // If the step is a tool call/result reading or discussing files, it is NOT a compaction checkpoint
  const t = String(step.type || '').toUpperCase();
  if (t === 'TOOL_CALL' || t === 'TOOL_RESULT' || t === 'TOOL_OUTPUT') return false;
  if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0 && !step.content) return false;
  const st = step.step_type ?? step.stepType;
  return (
    t === 'CHECKPOINT' ||
    t === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    Number(st) === CORTEX_STEP_TYPE_CHECKPOINT ||
    st === 'CORTEX_STEP_TYPE_CHECKPOINT'
  );
}

/**
 * Smart File Re-Read Classifier.
 *
 * Inspects transcript steps between consecutive `view_file` / `read_file` calls for the same file path.
 * Does NOT classify a repeat read as waste if:
 *  1. A compaction step (`CORTEX_STEP_TYPE_CHECKPOINT = 23`) occurred between reads (in-memory buffer was wiped).
 *  2. An edit tool (`replace_file_content`, `write_to_file`, `edit_file`, `write_file`) was invoked on that file between reads.
 *  3. A build/test tool (`run_command`) executed between reads.
 *
 * Only classifies as waste if the file was read multiple times in an unmodified state
 * within the same continuous context epoch.
 */
export function evaluateSmartFileReReads(steps = []) {
  const stepMeta = [];
  const readsByPath = new Map(); // canonicalPath -> Array<{ idx, rawPath, callOrder }>
  const latestTouchByPath = new Map();

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx] || {};
    const isCheckpoint = isCompactionCheckpointStep(step);
    let hasRunCommand = false;
    const editedCanonPaths = new Set();
    const readEntries = [];

    const calls = Array.isArray(step.toolCalls)
      ? step.toolCalls
      : (Array.isArray(step.tool_calls) ? step.tool_calls : []);

    if (calls.length > 0) {
      for (let cIdx = 0; cIdx < calls.length; cIdx++) {
        const call = calls[cIdx] || {};
        const name = String(call.name || call.tool || '').toLowerCase();
        const args = call.args || call.parameters || call.Arguments || call.input || {};
        const targetFile = args.Path || args.path || args.file_path || args.target_file || args.notebook_path || args.Target || args.target || args.TargetFile || args.AbsolutePath || args.uri;

        if (name === 'run_command' || name === 'bash' || name === 'run_terminal_cmd') {
          hasRunCommand = true;
        }
        if (targetFile && typeof targetFile === 'string') {
          const normalizedTarget = targetFile.replace(/\\/g, '/');
          if (/\.system_generated(\/|$)|(^|\/)steps\/\d+\/output\.txt$/i.test(normalizedTarget)) {
            continue;
          }
          const canon = canonicalizePath(targetFile);
          latestTouchByPath.set(canon, idx);
          if (READ_TOOLS.has(name)) {
            const startLine = Number(args.StartLine ?? args.start_line ?? args.startLine ?? args.offset);
            const endLine = Number(args.EndLine ?? args.end_line ?? args.endLine ?? args.limit);
            const hasLineRange = Number.isInteger(startLine) && startLine > 0;
            const readObj = {
              canon,
              rawPath: targetFile,
              callOrder: cIdx,
              startLine: hasLineRange ? startLine : null,
              endLine: Number.isInteger(endLine) && endLine > 0 ? endLine : null,
              hasLineRange
            };
            readEntries.push(readObj);
            if (!readsByPath.has(canon)) readsByPath.set(canon, []);
            readsByPath.get(canon).push({ idx, ...readObj });
          } else if (EDIT_TOOLS.has(name)) {
            editedCanonPaths.add(canon);
          }
        }
      }
    } else if (step.toolName || step.type === 'COMMAND') {
      const name = String(step.toolName || '').toLowerCase();
      if (name === 'run_command' || name === 'bash' || name === 'run_terminal_cmd' || step.type === 'COMMAND') {
        hasRunCommand = true;
      }
      if (step.targetPath && typeof step.targetPath === 'string') {
        const canon = canonicalizePath(step.targetPath);
        latestTouchByPath.set(canon, idx);
        if (READ_TOOLS.has(name)) {
          readEntries.push({ canon, rawPath: step.targetPath, callOrder: 0 });
          if (!readsByPath.has(canon)) readsByPath.set(canon, []);
          readsByPath.get(canon).push({ idx, rawPath: step.targetPath, callOrder: 0 });
        } else if (EDIT_TOOLS.has(name)) {
          editedCanonPaths.add(canon);
        }
      }
    }

    stepMeta.push({
      idx,
      isCheckpoint,
      hasRunCommand,
      editedCanonPaths,
      readEntries
    });
  }

  const wasteTargetByStep = new Map(); // stepIdx -> rawPath
  const wasteCanonPaths = new Set();
  const exemptedReReads = [];

  for (const [canon, readList] of readsByPath.entries()) {
    if (readList.length < 2) continue;

    for (let j = 0; j < readList.length - 1; j++) {
      const first = readList[j];
      const second = readList[j + 1];

      let hasCheckpointBetween = false;
      let hasFileEditBetween = false;
      let hasRunCommandBetween = false;

      for (let k = first.idx + 1; k < second.idx; k++) {
        const m = stepMeta[k];
        if (!m) continue;
        if (m.isCheckpoint) hasCheckpointBetween = true;
        if (m.editedCanonPaths.has(canon)) hasFileEditBetween = true;
        if (m.hasRunCommand) hasRunCommandBetween = true;
      }

      // Also check if the same turn had an edit or run_command between the two reads
      if (first.idx === second.idx) {
        const m = stepMeta[first.idx];
        if (m?.editedCanonPaths.has(canon)) hasFileEditBetween = true;
        if (m?.hasRunCommand) hasRunCommandBetween = true;
      } else {
        const mFirst = stepMeta[first.idx];
        const mSecond = stepMeta[second.idx];
        if (mFirst?.editedCanonPaths.has(canon) || mSecond?.editedCanonPaths.has(canon)) {
          hasFileEditBetween = true;
        }
      }

      const areDisjointRanges = Boolean(
        first.hasLineRange && second.hasLineRange &&
        (first.startLine !== second.startLine || first.endLine !== second.endLine)
      );

      const exemptionReason = hasCheckpointBetween
        ? 'CHECKPOINT'
        : (hasFileEditBetween
            ? 'FILE_EDIT'
            : (hasRunCommandBetween
                ? 'RUN_COMMAND'
                : (areDisjointRanges ? 'DISJOINT_LINE_RANGE' : null)));

      if (exemptionReason) {
        exemptedReReads.push({
          path: second.rawPath || first.rawPath,
          canonicalPath: canon,
          firstStepIndex: first.idx,
          secondStepIndex: second.idx,
          reason: exemptionReason
        });
      } else {
        wasteTargetByStep.set(first.idx, first.rawPath);
        wasteCanonPaths.add(canon);
      }
    }
  }

  return {
    wasteTargetByStep,
    wasteCanonPaths,
    exemptedReReads,
    latestTouchByPath,
    readsByPath
  };
}

/**
 * Wraps a noisy CLI command in a fail-open stdout dampener (`head -n 100` + log redirect)
 * to prevent accidental 20k+ token single-turn bloat.
 */
export function wrapNoisyCommandWithDampener(commandLine, {
  maxLines = 100,
  logFile = '.agents/tmp/cli_stdout.log',
  platform = process.platform
} = {}) {
  const cleanCmd = String(commandLine || '').trim();
  if (!cleanCmd) return '';
  const limit = Math.max(10, Number(maxLines) || 100);
  if (
    cleanCmd.includes('head -n') ||
    cleanCmd.includes('Select-Object -First') ||
    cleanCmd.includes('Tee-Object') ||
    cleanCmd.includes(logFile)
  ) {
    return cleanCmd;
  }
  if (platform === 'win32') {
    return `& { ${cleanCmd} } *>&1 | Tee-Object -FilePath "${logFile}" | Select-Object -First ${limit}; $LASTEXITCODE = 0`;
  }
  return `(${cleanCmd}) 2>&1 | tee "${logFile}" | head -n ${limit} || true`;
}

/**
 * Registers a fail-open PreToolUse CLI command dampening hook in `.agents/hooks.json`.
 * Wraps noisy commands in PowerShell `Tee-Object | Select-Object -First` on Windows or POSIX `tee | head -n`.
 */
export function registerCliDampeningHook(workspacePath, {
  command = '',
  maxLines = 100,
  logFile = '.agents/tmp/cli_stdout.log',
  platform = process.platform,
  writeToDisk = true
} = {}) {
  const wsRoot = workspacePath || process.cwd();
  const hooksJsonPath = path.join(wsRoot, '.agents', 'hooks.json');
  const limit = Math.max(10, Number(maxLines) || 100);
  const isWin = platform === 'win32';

  let existing = {};
  if (fs.existsSync(hooksJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    existing = {};
  }

  const preToolList = Array.isArray(existing.PreToolUse)
    ? [...existing.PreToolUse]
    : (Array.isArray(existing.hooks?.PreToolUse) ? [...existing.hooks.PreToolUse] : []);

  const wrappedExample = wrapNoisyCommandWithDampener(command || 'npm test', {
    maxLines: limit,
    logFile,
    platform
  });
  const inlineGuardScript = [
    `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{`,
    `try{const j=JSON.parse(d||'{}');const cmd=String(j.tool_input?.CommandLine||j.tool_input?.command||j.CommandLine||'');`,
    `if(cmd&&cmd.length>0&&!cmd.includes('head -n')&&!cmd.includes('Select-Object')){`,
    `process.stdout.write(JSON.stringify({systemMessage:'[CLI Output Dampener] Pipe large command output through head -n ${limit} (or Select-Object -First ${limit} on PowerShell) or redirect to ${logFile} to prevent >20k single-turn context bloat.'}));`,
    `}}catch{}process.exit(0);});`
  ].join('');
  const wrappedCommandTemplate = isWin
    ? `& { <command> } *>&1 | Tee-Object -FilePath "${logFile}" | Select-Object -First ${limit}; $LASTEXITCODE = 0`
    : `(<command>) 2>&1 | tee "${logFile}" | head -n ${limit} || true`;
  const hookEntry = {
    id: 'horizon-cli-dampener',
    event: 'PreToolUse',
    matcher: CLI_DAMPENER_MATCHER,
    failOpen: true,
    maxLines: limit,
    logFile,
    platform,
    wrapperStrategy: isWin
      ? `Tee-Object -FilePath "${logFile}" | Select-Object -First ${limit}`
      : `tee "${logFile}" | head -n ${limit}`,
    targetCommandPattern: String(command || '*').slice(0, 160),
    command: `node -e "${inlineGuardScript.replace(/"/g, '\\"')}"`,
    wrappedCommandTemplate,
    description: `Fail-open PreToolUse wrapper: caps noisy CLI stdout via ${isWin ? 'Select-Object -First' : 'head -n'} ${limit} or pipes full output to ${logFile} to prevent 20k+ single-turn bloat.`,
    updatedAt: new Date().toISOString()
  };

  const existingIdx = preToolList.findIndex(
    h => h && (h.id === 'horizon-cli-dampener' || h.matcher === 'run_command' || h.matcher === CLI_DAMPENER_MATCHER)
  );
  if (existingIdx >= 0) {
    preToolList[existingIdx] = { ...preToolList[existingIdx], ...hookEntry };
  } else {
    preToolList.push(hookEntry);
  }

  const swarmPreIdx = preToolList.findIndex(h => h && (h.id === 'horizon-swarm-pre-tool' || h.matcher === SWARM_TOOL_MATCHER));
  const swarmPreEntry = {
    id: 'horizon-swarm-pre-tool',
    event: 'PreToolUse',
    matcher: SWARM_TOOL_MATCHER,
    type: 'command',
    command: buildTrustedPluginHookCommand('pre_invocation.mjs'),
    timeout: 5
  };
  if (swarmPreIdx >= 0) {
    preToolList[swarmPreIdx] = { ...preToolList[swarmPreIdx], ...swarmPreEntry };
  } else {
    preToolList.push(swarmPreEntry);
  }

  const postToolList = Array.isArray(existing.PostToolUse)
    ? [...existing.PostToolUse]
    : (Array.isArray(existing.hooks?.PostToolUse) ? [...existing.hooks.PostToolUse] : []);
  const swarmPostIdx = postToolList.findIndex(h => h && (h.id === 'horizon-swarm-post-tool' || h.matcher === SWARM_TOOL_MATCHER));
  const swarmPostEntry = {
    id: 'horizon-swarm-post-tool',
    event: 'PostToolUse',
    matcher: SWARM_TOOL_MATCHER,
    type: 'command',
    command: buildTrustedPluginHookCommand('post_invocation.mjs'),
    timeout: 5
  };
  if (swarmPostIdx >= 0) {
    postToolList[swarmPostIdx] = { ...postToolList[swarmPostIdx], ...swarmPostEntry };
  } else {
    postToolList.push(swarmPostEntry);
  }

  const nextHooksConfig = {
    ...existing,
    PreToolUse: preToolList,
    PostToolUse: postToolList,
    hooks: {
      ...(existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {}),
      PreToolUse: preToolList,
      PostToolUse: postToolList
    }
  };

  let written = false;
  if (writeToDisk) {
    try {
      atomicWriteFileSync(hooksJsonPath, JSON.stringify(nextHooksConfig, null, 2) + '\n', { encoding: 'utf8' });
      written = true;
    } catch (err) {
      return {
        success: false,
        error: String(err?.message || err),
        hooksPath: hooksJsonPath
      };
    }
  }

  return {
    success: true,
    written,
    hooksPath: hooksJsonPath,
    hookEntry,
    wrappedExample,
    hooksConfig: nextHooksConfig
  };
}

/**
 * Computes a line insertion index strictly within the top 30% (Primacy zone)
 * or bottom 30% (Recency zone) of a document, avoiding the 30%-70% Low-Attention Trough.
 */
export function computeAttentionZoneInsertionIndex(lines = [], zone = 'primacy') {
  const total = Array.isArray(lines) ? lines.length : Number(lines) || 0;
  const normalizedZone = String(zone || 'primacy').toLowerCase() === 'recency' ? 'recency' : 'primacy';

  if (total <= 3) {
    return normalizedZone === 'primacy' ? (total <= 2 ? 0 : 1) : total;
  }

  if (normalizedZone === 'primacy') {
    const maxPrimacyLine = Math.max(1, Math.floor(total * 0.25));
    // Prefer inserting right after the first markdown heading or blank line within the top 25%
    if (Array.isArray(lines)) {
      for (let i = 0; i <= maxPrimacyLine; i++) {
        if (/^#\s+/.test(lines[i])) {
          return Math.min(maxPrimacyLine, i + 1);
        }
      }
    }
    return Math.min(maxPrimacyLine, Math.max(1, Math.floor(total * 0.15)));
  }

  // Recency zone: strictly within bottom 30% (>= ceil(total * 0.75))
  const minRecencyLine = Math.ceil(total * 0.75);
  return Math.max(minRecencyLine, total);
}

/**
 * Audits workspace rule files (`AGENTS.md`, `.agents/CONTEXT.md`, `MEMORY.md`) against
 * Antigravity's 200-line `MEMORY.md` truncation threshold.
 */
export function auditRuleFileAttentionAndLineLimit(workspacePath, {
  maxLines = MEMORY_MD_TRUNCATION_THRESHOLD_LINES
} = {}) {
  const wsRoot = workspacePath || process.cwd();
  const candidates = [
    { label: '.agents/CONTEXT.md', path: path.join(wsRoot, '.agents', 'CONTEXT.md') },
    { label: 'AGENTS.md', path: path.join(wsRoot, 'AGENTS.md') },
    { label: 'MEMORY.md', path: path.join(wsRoot, 'MEMORY.md') }
  ];

  const files = [];
  let maxFileLines = 0;
  let primaryTargetPath = path.join(wsRoot, 'AGENTS.md');

  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      try {
        const text = fs.readFileSync(c.path, 'utf8');
        const lineCount = text.split(/\r?\n/).length;
        if (lineCount > maxFileLines) maxFileLines = lineCount;
        if (c.label === '.agents/CONTEXT.md' || c.label === 'AGENTS.md') {
          primaryTargetPath = c.path;
        }
        files.push({
          label: c.label,
          path: c.path,
          lineCount,
          exceedsLimit: lineCount > maxLines,
          nearLimit: lineCount >= Math.round(maxLines * 0.85)
        });
      } catch {}
    }
  }

  const exceeds200LineThreshold = files.some(f => f.exceedsLimit);
  const near200LineThreshold = files.some(f => f.nearLimit);
  const truncationWarning = exceeds200LineThreshold
    ? `Rule file (${maxFileLines} lines) exceeds Antigravity's ${maxLines}-line MEMORY.md truncation threshold. Insert critical rules in the Primacy zone (top 30%) or offload domain rules to .agents/skills/.`
    : (near200LineThreshold
        ? `Rule file (${maxFileLines}/${maxLines} lines) is approaching Antigravity's ${maxLines}-line MEMORY.md truncation threshold.`
        : '');

  return {
    thresholdLines: maxLines,
    maxFileLines,
    primaryTargetPath,
    exceeds200LineThreshold,
    near200LineThreshold,
    truncationWarning,
    files
  };
}

/**
 * Promotes an Unlogged User Correction into `.agents/CONTEXT.md` or `AGENTS.md`
 * strictly within the top 30% (Primacy zone) or bottom 30% (Recency zone),
 * and checks total line count against Antigravity's 200-line `MEMORY.md` truncation threshold.
 */
export function promoteRuleWithAttentionZone(targetFileOrWorkspace, ruleText, {
  zone = 'primacy',
  targetFileName = null,
  maxLines = MEMORY_MD_TRUNCATION_THRESHOLD_LINES,
  writeToDisk = true,
  session = null,
  cacheState = null,
  cacheWarm = false,
  cachedTokens = 0,
  cacheTtlSeconds = 0,
  forceColdBust = false,
  prefixCacheShield = null,
  homeDir = undefined
} = {}) {
  const cleanRule = String(ruleText || '').replace(/<\/?USER_REQUEST>/gi, '').trim();
  if (!cleanRule) {
    return { success: false, error: 'Rule text cannot be empty' };
  }

  let resolvedPath = targetFileOrWorkspace || path.join(process.cwd(), 'AGENTS.md');
  try {
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      const contextMd = path.join(resolvedPath, '.agents', 'CONTEXT.md');
      const agentsMd = path.join(resolvedPath, 'AGENTS.md');
      if (targetFileName) {
        resolvedPath = path.join(resolvedPath, targetFileName);
      } else if (fs.existsSync(contextMd)) {
        resolvedPath = contextMd;
      } else {
        resolvedPath = agentsMd;
      }
    }
  } catch {}

  let existingContent = '';
  if (fs.existsSync(resolvedPath)) {
    try {
      existingContent = fs.readFileSync(resolvedPath, 'utf8');
    } catch {}
  } else {
    existingContent = [
      '# Project Context & Agent Rules',
      '',
      '## Primacy Directives (Top 30% High-Attention Zone)',
      '',
      '## Architecture & Workflow Notes',
      '- Maintain strict module boundaries.',
      '- Keep tests deterministic and isolated.',
      '- Validate inputs at system boundaries.',
      '- Avoid unnecessary dependencies.',
      '- Preserve existing comments and documentation.',
      '',
      '## Recency Directives (Bottom 30% High-Attention Zone)'
    ].join('\n');
  }

  const lines = existingContent.split(/\r?\n/);
  const totalLinesBefore = lines.length;
  const requestedZone = String(zone || 'primacy').toLowerCase() === 'recency' ? 'recency' : 'primacy';

  // If the file already exceeds the 200-line MEMORY.md truncation threshold and recency was requested,
  // warn that lines past 200 risk truncation!
  const formattedBullet = cleanRule.startsWith('-') || cleanRule.startsWith('*')
    ? cleanRule
    : `- **User Constraint**: ${cleanRule}`;

  const insertIdx = computeAttentionZoneInsertionIndex(lines, requestedZone);
  const updatedLines = [
    ...lines.slice(0, insertIdx),
    formattedBullet,
    ...lines.slice(insertIdx)
  ];

  const totalLinesAfter = updatedLines.length;
  const normalizedPosition = totalLinesAfter > 1
    ? parseFloat((insertIdx / totalLinesAfter).toFixed(3))
    : (requestedZone === 'primacy' ? 0.0 : 1.0);

  const inPrimacyZone = normalizedPosition <= 0.30;
  const inRecencyZone = normalizedPosition >= 0.70;
  const exceeds200LineThreshold = totalLinesAfter > maxLines;
  const near200LineThreshold = totalLinesAfter >= Math.round(maxLines * 0.85);

  const truncationWarning = exceeds200LineThreshold
    ? `Total length (${totalLinesAfter} lines) exceeds Antigravity's ${maxLines}-line MEMORY.md truncation threshold. Lines past ${maxLines} may be truncated; keep critical rules in the Primacy zone (top 30%).`
    : (near200LineThreshold
        ? `Total length (${totalLinesAfter}/${maxLines} lines) is approaching Antigravity's ${maxLines}-line MEMORY.md truncation threshold.`
        : '');

  const updatedContent = updatedLines.join('\n');
  const resolvedSession = session || {
    cacheState,
    cacheWarm,
    cachedTokens,
    cacheTtlSeconds,
    forceColdBust
  };
  const isWarmLocked = writeToDisk && !forceColdBust && isWarmCacheState(resolvedSession);
  if (isWarmLocked) {
    const shield = prefixCacheShield || new PrefixCacheShield({ homeDir });
    const shieldResult = shield.stageOrApplyDelta(
      {
        targetPath: resolvedPath,
        operation: 'REPLACE',
        newContent: updatedContent,
        ruleText: formattedBullet,
        source: 'layer5-hygiene-promote'
      },
      resolvedSession
    );
    return {
      success: true,
      written: false,
      staged: true,
      deferred: true,
      reason: 'CACHE_WARM_FENCE',
      shieldResult,
      targetPath: resolvedPath,
      zoneUsed: requestedZone,
      insertedAtLine: insertIdx + 1,
      totalLinesBefore,
      totalLinesAfter,
      normalizedPosition,
      inPrimacyZone,
      inRecencyZone,
      exceeds200LineThreshold,
      near200LineThreshold,
      truncationWarning,
      formattedRule: formattedBullet,
      content: updatedContent
    };
  }

  let written = false;
  if (writeToDisk) {
    try {
      atomicWriteFileSync(resolvedPath, updatedContent, { encoding: 'utf8' });
      written = true;
    } catch (err) {
      return {
        success: false,
        error: String(err?.message || err),
        targetPath: resolvedPath
      };
    }
  }

  return {
    success: true,
    written,
    staged: false,
    deferred: false,
    targetPath: resolvedPath,
    zoneUsed: requestedZone,
    insertedAtLine: insertIdx + 1,
    totalLinesBefore,
    totalLinesAfter,
    normalizedPosition,
    inPrimacyZone,
    inRecencyZone,
    exceeds200LineThreshold,
    near200LineThreshold,
    truncationWarning,
    formattedRule: formattedBullet,
    content: updatedContent
  };
}

/**
 * Updates `.antigravityignore` safely behind `PrefixCacheShield` when prompt cache is warm.
 */
export function updateAntigravityIgnore(workspaceOrIgnorePath, patterns = [], {
  writeToDisk = true,
  session = null,
  cacheState = null,
  cacheWarm = false,
  cachedTokens = 0,
  cacheTtlSeconds = 0,
  forceColdBust = false,
  prefixCacheShield = null,
  homeDir = undefined
} = {}) {
  const baseStr = String(workspaceOrIgnorePath || process.cwd());
  const ignorePath = baseStr.endsWith('.antigravityignore')
    ? path.resolve(baseStr)
    : path.join(path.resolve(baseStr), '.antigravityignore');
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const existingSet = new Set(lines.map((l) => l.trim()).filter(Boolean));
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const added = [];
  for (const pat of list) {
    const clean = String(pat || '').trim();
    if (clean && !existingSet.has(clean)) {
      lines.push(clean);
      existingSet.add(clean);
      added.push(clean);
    }
  }
  const updatedContent = lines.filter((l, idx) => idx < lines.length - 1 || l !== '').join('\n') + '\n';
  const resolvedSession = session || {
    cacheState,
    cacheWarm,
    cachedTokens,
    cacheTtlSeconds,
    forceColdBust
  };
  if (writeToDisk && !forceColdBust && isWarmCacheState(resolvedSession)) {
    const shield = prefixCacheShield || new PrefixCacheShield({ homeDir });
    const shieldResult = shield.stageOrApplyDelta(
      {
        targetPath: ignorePath,
        operation: 'REPLACE',
        newContent: updatedContent,
        source: 'layer5-antigravityignore'
      },
      resolvedSession
    );
    return {
      success: true,
      written: false,
      staged: true,
      deferred: true,
      reason: 'CACHE_WARM_FENCE',
      targetPath: ignorePath,
      addedPatterns: added,
      shieldResult,
      content: updatedContent
    };
  }
  let written = false;
  if (writeToDisk) {
    atomicWriteFileSync(ignorePath, updatedContent, { encoding: 'utf8' });
    written = true;
  }
  return {
    success: true,
    written,
    staged: false,
    deferred: false,
    targetPath: ignorePath,
    addedPatterns: added,
    content: updatedContent
  };
}

/**
 * Quantifies the exact "Context Re-Read Tax" whenever an unmodified file inspected before
 * a `compact_boundary` / `CORTEX_STEP_TYPE_CHECKPOINT` / `prompt-suggestion-compact` is re-read after compaction.
 */
export function evaluatePostCompactionReReadTax(rawSteps = []) {
  const list = Array.isArray(rawSteps) ? rawSteps : [];
  let compactionSeen = false;
  let compactionStepIndex = null;
  const preCompactionReads = new Map(); // canonPath -> { rawPath, stepIndex, tokens }
  const editedSincePreRead = new Set();
  const postCompactionReReads = [];
  let totalReReadTaxTokens = 0;

  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const typeStr = String(s.type || s.subtype || '').toLowerCase();
    const isBoundary = Boolean(
      isCompactionCheckpointStep(s) ||
      typeStr.includes('compact') ||
      s.compactMetadata ||
      (typeStr === 'user_input' || typeStr === 'system_message' || typeStr === 'checkpoint'
        ? String(s.content || '').includes('<CONTEXT_SUMMARY>')
        : false)
    );

    if (isBoundary) {
      compactionSeen = true;
      compactionStepIndex = s.stepIndex ?? i;
      continue;
    }

    const calls = Array.isArray(s.toolCalls)
      ? s.toolCalls
      : (Array.isArray(s.tool_calls) ? s.tool_calls : []);

    for (const c of calls) {
      const name = String(c.name || c.tool || '').toLowerCase();
      const args = c.args || c.parameters || c.Arguments || {};
      const fp = args.Path || args.path || args.TargetFile || args.AbsolutePath;
      if (!fp || typeof fp !== 'string') continue;
      const canon = canonicalizePath(fp);

      if (EDIT_TOOLS.has(name)) {
        editedSincePreRead.add(canon);
      } else if (READ_TOOLS.has(name)) {
        const tok = Number(s.outputTokens ?? s.output_tokens ?? Math.max(500, Math.ceil(String(s.content || '').length / 4)));
        if (!compactionSeen) {
          preCompactionReads.set(canon, { rawPath: fp, stepIndex: s.stepIndex ?? i, tokens: tok });
          editedSincePreRead.delete(canon);
        } else if (preCompactionReads.has(canon) && !editedSincePreRead.has(canon)) {
          const prev = preCompactionReads.get(canon);
          totalReReadTaxTokens += tok;
          postCompactionReReads.push({
            path: fp,
            canonicalPath: canon,
            preCompactionStepIndex: prev.stepIndex,
            compactionStepIndex,
            postCompactionStepIndex: s.stepIndex ?? i,
            wastedTokens: tok
          });
          preCompactionReads.delete(canon);
        }
      }
    }
  }

  return {
    compactionDetected: compactionSeen,
    compactionStepIndex,
    reReadCount: postCompactionReReads.length,
    totalReReadTaxTokens,
    reReads: postCompactionReReads
  };
}

/**
 * Analyzes per-turn ratios of reasoning tokens (`thinkingTokens`) and `thinkingDurationMs`
 * to classify `unused_effort`, `loop_tax`, `housekeeping`, and `thrashing`.
 */
export function detectEffortThrashing(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const flaggedTurns = [];
  let totalWastedThinkingTokens = 0;
  let consecutiveHighSimple = 0;

  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const thinkingTokens = Number(s.thinkingTokens ?? s.thinking_tokens ?? s.usage?.thinking_tokens ?? 0);
    const outputTokens = Number(s.outputTokens ?? s.output_tokens ?? s.usage?.output_tokens ?? Math.ceil(String(s.content || '').length / 4));
    const thinkingDurationMs = Number(s.thinkingDurationMs ?? s.thinking_duration_ms ?? 0);
    const calls = Array.isArray(s.toolCalls)
      ? s.toolCalls
      : (Array.isArray(s.tool_calls) ? s.tool_calls : []);
    const toolNames = calls.map(c => String(c.name || c.tool || '').toLowerCase());

    if (thinkingTokens <= 0 && thinkingDurationMs <= 0) continue;

    const isError = Boolean(s.status === 'ERROR' || (typeof s.exitCode === 'number' && s.exitCode !== 0));
    const isHousekeepingOnly = toolNames.length > 0 && toolNames.every(n => /todowrite|list_dir|find_by_name|glob/i.test(n));

    let classification = null;
    if (isError && thinkingTokens >= 2000) {
      classification = 'loop_tax';
    } else if (isHousekeepingOnly && thinkingTokens >= 1500) {
      classification = 'housekeeping';
    } else if (thinkingTokens >= 3000 && outputTokens > 0 && (thinkingTokens / Math.max(1, outputTokens)) >= 6) {
      consecutiveHighSimple += 1;
      classification = consecutiveHighSimple >= 2 ? 'thrashing' : 'unused_effort';
    } else {
      consecutiveHighSimple = 0;
    }

    if (classification) {
      totalWastedThinkingTokens += thinkingTokens;
      flaggedTurns.push({
        stepIndex: s.stepIndex ?? i,
        classification,
        thinkingTokens,
        outputTokens,
        thinkingDurationMs
      });
    }
  }

  return {
    thrashingDetected: flaggedTurns.some(t => t.classification === 'thrashing' || t.classification === 'loop_tax'),
    totalWastedThinkingTokens,
    flaggedTurns
  };
}

/**
 * Validates that an Antigravity `hooks.json` / `.agents/hooks.json` configuration obeys:
 *  1. `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` MUST be flat handler arrays
 *     with NO `matcher` wrapper object or `matcher` property.
 *  2. `PreToolUse` and `PostToolUse` capture swarm coordination and lifecycle tools:
 *     `"invoke_subagent|define_subagent|send_message|manage_subagents"`.
 */
export function validateAntigravityHooksSchema(hooksConfig) {
  const errors = [];
  if (!hooksConfig || typeof hooksConfig !== 'object' || Array.isArray(hooksConfig)) {
    return { valid: false, errors: ['hooksConfig must be a non-null JSON object'] };
  }

  const scopes = [hooksConfig];
  if (hooksConfig.hooks && typeof hooksConfig.hooks === 'object' && !Array.isArray(hooksConfig.hooks)) {
    scopes.push(hooksConfig.hooks);
  }
  for (const [key, val] of Object.entries(hooksConfig)) {
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      key !== 'hooks' &&
      !FLAT_LIFECYCLE_EVENTS.includes(key) &&
      key !== 'PreToolUse' &&
      key !== 'PostToolUse'
    ) {
      scopes.push(val);
    }
  }

  let hasSwarmPreToolMatcher = false;
  let hasSwarmPostToolMatcher = false;

  for (const scope of scopes) {
    for (const evt of FLAT_LIFECYCLE_EVENTS) {
      if (!(evt in scope)) continue;
      const arr = scope[evt];
      if (!Array.isArray(arr)) {
        errors.push(`${evt} must be a flat array of handlers (found ${typeof arr})`);
        continue;
      }
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${evt}[${i}] must be a handler object`);
          continue;
        }
        if ('matcher' in entry || 'hooks' in entry) {
          errors.push(`${evt}[${i}] must be a flat handler entry with NO matcher wrapper object`);
        }
      }
    }

    for (const toolEvt of ['PreToolUse', 'PostToolUse']) {
      if (!(toolEvt in scope)) continue;
      const arr = scope[toolEvt];
      if (!Array.isArray(arr)) {
        errors.push(`${toolEvt} must be an array of tool matcher handlers`);
        continue;
      }
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i];
        if (!entry || typeof entry !== 'object') continue;
        if ('hooks' in entry) {
          if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
            errors.push(`${toolEvt}[${i}].hooks must be a non-empty array of command handlers`);
          }
        }
        const m = String(entry.matcher || '');
        if (
          m.includes('invoke_subagent') &&
          m.includes('define_subagent') &&
          m.includes('send_message') &&
          m.includes('manage_subagents')
        ) {
          if (toolEvt === 'PreToolUse') hasSwarmPreToolMatcher = true;
          if (toolEvt === 'PostToolUse') hasSwarmPostToolMatcher = true;
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    hasSwarmPreToolMatcher,
    hasSwarmPostToolMatcher,
    swarmToolMatcher: SWARM_TOOL_MATCHER,
    errors
  };
}


