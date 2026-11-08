import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './paths.mjs';

/**
 * Epoch-Aware File Re-Read Classifier, Fail-Open CLI Output Dampener,
 * and Positional Rule Promotion.
 */

export const CORTEX_STEP_TYPE_CHECKPOINT = 23;
export const MEMORY_MD_TRUNCATION_THRESHOLD_LINES = 200;

const READ_TOOLS = new Set([
  'view_file',
  'read_file',
  'view_file_outline',
  'view_code_item'
]);

const EDIT_TOOLS = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'write_file',
  'edit_file'
]);

/**
 * Determines whether a parsed step or stepEvent represents a Cortex compaction checkpoint
 * (`CORTEX_STEP_TYPE_CHECKPOINT = 23`).
 */
export function isCompactionCheckpointStep(step) {
  if (!step || typeof step !== 'object') return false;
  const t = String(step.type || '').toUpperCase();
  const st = step.step_type ?? step.stepType;
  return (
    t === 'CHECKPOINT' ||
    t === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    Number(st) === CORTEX_STEP_TYPE_CHECKPOINT ||
    st === 'CORTEX_STEP_TYPE_CHECKPOINT'
  );
}

/**
 * Phase 5 (Layer 5): Smart File Re-Read Classifier.
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
        const args = call.args || call.parameters || call.Arguments || {};
        const targetFile = args.Path || args.path || args.Target || args.target || args.TargetFile || args.AbsolutePath;

        if (name === 'run_command') {
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
            readEntries.push({ canon, rawPath: targetFile, callOrder: cIdx });
            if (!readsByPath.has(canon)) readsByPath.set(canon, []);
            readsByPath.get(canon).push({ idx, rawPath: targetFile, callOrder: cIdx });
          } else if (EDIT_TOOLS.has(name)) {
            editedCanonPaths.add(canon);
          }
        }
      }
    } else if (step.toolName || step.type === 'COMMAND') {
      const name = String(step.toolName || '').toLowerCase();
      if (name === 'run_command' || step.type === 'COMMAND') {
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

      const exemptionReason = hasCheckpointBetween
        ? 'CHECKPOINT'
        : (hasFileEditBetween
            ? 'FILE_EDIT'
            : (hasRunCommandBetween ? 'RUN_COMMAND' : null));

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
  logFile = '.agents/tmp/cli_stdout.log'
} = {}) {
  const cleanCmd = String(commandLine || '').trim();
  if (!cleanCmd) return '';
  const limit = Math.max(10, Number(maxLines) || 100);
  if (cleanCmd.includes('head -n') || cleanCmd.includes(logFile)) {
    return cleanCmd;
  }
  return `(${cleanCmd}) 2>&1 | tee ${logFile} | head -n ${limit} || true`;
}

/**
 * Registers a fail-open PreToolUse CLI command dampening hook in `.agents/hooks.json`.
 * Wraps noisy commands in `head -n 100` or pipes stdout to a temporary log file.
 */
export function registerCliDampeningHook(workspacePath, {
  command = '',
  maxLines = 100,
  logFile = '.agents/tmp/cli_stdout.log',
  writeToDisk = true
} = {}) {
  const wsRoot = workspacePath || process.cwd();
  const hooksJsonPath = path.join(wsRoot, '.agents', 'hooks.json');
  const limit = Math.max(10, Number(maxLines) || 100);

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

  const wrappedExample = wrapNoisyCommandWithDampener(command || 'npm test', { maxLines: limit, logFile });
  const inlineGuardScript = [
    `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{`,
    `try{const j=JSON.parse(d||'{}');const cmd=String(j.tool_input?.CommandLine||j.tool_input?.command||j.CommandLine||'');`,
    `if(cmd&&cmd.length>0&&!cmd.includes('head -n')&&!cmd.includes('Select-Object')){`,
    `process.stdout.write(JSON.stringify({systemMessage:'[CLI Output Dampener] Pipe large command output through head -n ${limit} or ${logFile} to prevent >20k single-turn context bloat.'}));`,
    `}}catch{}process.exit(0);});`
  ].join('');
  const hookEntry = {
    id: 'horizon-cli-dampener',
    event: 'PreToolUse',
    matcher: 'run_command',
    failOpen: true,
    maxLines: limit,
    logFile,
    wrapperStrategy: `head -n ${limit} | tee ${logFile}`,
    targetCommandPattern: String(command || '*').slice(0, 160),
    command: `node -e "${inlineGuardScript.replace(/"/g, '\\"')}"`,
    wrappedCommandTemplate: `(<command>) 2>&1 | tee ${logFile} | head -n ${limit} || true`,
    description: `Fail-open PreToolUse wrapper: caps noisy CLI stdout via head -n ${limit} or pipes full output to ${logFile} to prevent 20k+ single-turn bloat.`,
    updatedAt: new Date().toISOString()
  };

  const existingIdx = preToolList.findIndex(h => h && (h.id === 'horizon-cli-dampener' || h.matcher === 'run_command'));
  if (existingIdx >= 0) {
    preToolList[existingIdx] = { ...preToolList[existingIdx], ...hookEntry };
  } else {
    preToolList.push(hookEntry);
  }

  const nextHooksConfig = {
    ...existing,
    PreToolUse: preToolList,
    hooks: {
      ...(existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {}),
      PreToolUse: preToolList
    }
  };

  let written = false;
  if (writeToDisk) {
    try {
      fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
      fs.writeFileSync(hooksJsonPath, JSON.stringify(nextHooksConfig, null, 2) + '\n', 'utf8');
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
    return normalizedZone === 'primacy' ? Math.min(1, total) : total;
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
  writeToDisk = true
} = {}) {
  const cleanRule = String(ruleText || '').trim();
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
  let written = false;
  if (writeToDisk) {
    try {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, updatedContent, 'utf8');
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
