import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { canonicalizePath } from '../paths.mjs';
import { AgBridgeService } from '../ag_bridge.mjs';
import { extractActiveTaskStep } from '../task_quota_router.mjs';
import { loadRegistry, deriveSessionClaimedPaths } from '../telemetry/scope_lock_registry.mjs';

/**
 * Phase 4.2 / Ring 1 Hardening: Baton-Pass Generator & Cross-Tool Portable Handoff Packet
 * (`src/core/coach/handoff_hydrator.mjs`)
 *
 * - Deterministically generates standardized `docs/HANDOFF_<timestamp>.md` usable identically
 *   in Google Antigravity, Claude Code, Cursor, and Codex CLI:
 *     ## 1. Resume Contract & Active Step
 *     ## 2. Verified Unchanged File Schemas (Skip Re-Reading)
 *     ## 3. Active File Diffs & Owned Scope Paths
 *     ## 4. Negative Constraints & Ruled-Out Approaches
 * - Integrates ScopeLockRegistry (DET-20) to pin owned file scopes across concurrent agents.
 * - Supports silent pre-staging when `CacheTtlWatchdog` emits `TTL_PRE_SNAPSHOT` (`T-10s`).
 * - Provides `[Launch Hydrated Session]` (`HandoffHydrationLauncher`): opens a new Antigravity
 *   chat thread and populates the Turn-1 bootstrap contract.
 * - Includes Post-Handoff Amnesia Check on Turns 1–3 of the new session.
 */

export function buildTurn1BootstrapContract({
  handoffPath = 'docs/HANDOFF.md',
  activeTaskStepText = 'Resume active [/] step in task.md',
  verifiedSchemaFiles = []
} = {}) {
  const verifiedList = verifiedSchemaFiles.length > 0
    ? verifiedSchemaFiles.join(', ')
    : '(none)';

  return [
    `# Turn-1 Hydrated Baton-Pass Contract`,
    `- **Handoff Bundle:** \`${handoffPath}\``,
    `- **Active Step (\`[/]\` in \`task.md\`):** ${activeTaskStepText}`,
    `- **Execution Rules:**`,
    `  1. Resume immediately at the active \`[/]\` step in \`task.md\`.`,
    `  2. Always use \`StartLine\` and \`EndLine\` ranges when inspecting files.`,
    `  3. **SKIP \`view_file\` calls** on already-verified unchanged schema files: ${verifiedList}.`
  ].join('\n');
}

function readGitDiffStatSafe(workspaceDir) {
  try {
    const out = execFileSync('git', ['diff', '--stat'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    });
    return String(out || '').trim() || '(clean working tree)';
  } catch {
    return '(git diff unavailable)';
  }
}

export class HandoffHydrationLauncher {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.agBridge = options.agBridge || new AgBridgeService(options);
    this.preStagedBundle = null;
    this.lastGeneratedBundle = null;
  }

  /**
   * Generates `docs/HANDOFF_<timestamp>.md` deterministically in <2ms (when gitDiffSummary is supplied).
   */
  generateHandoffBundle({
    workspaceDir = this.workspaceDir,
    taskMdContent = null,
    gitDiffSummary = null,
    verifiedSchemaFiles = [],
    ownedScopePaths = null,
    negativeConstraints = [],
    timestamp = null,
    writeToDisk = true
  } = {}) {
    const startMs = performance.now();
    const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-');
    const handoffRelPath = `docs/HANDOFF_${ts}.md`;
    const handoffAbsPath = path.join(workspaceDir, 'docs', `HANDOFF_${ts}.md`);

    let resolvedTaskMd = taskMdContent;
    if (resolvedTaskMd === null) {
      const taskPath = path.join(workspaceDir, 'task.md');
      resolvedTaskMd = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : '- [/] Continue active task\n';
    }

    const activeStep = extractActiveTaskStep(resolvedTaskMd);
    const activeStepText = activeStep.found ? activeStep.rawText : 'Continue next pending item in task.md';
    const resolvedGitDiff = gitDiffSummary !== null ? String(gitDiffSummary) : readGitDiffStatSafe(workspaceDir);

    // Resolve owned scope paths from parameters, scope lockfile, or task.md
    let resolvedScopePaths = Array.isArray(ownedScopePaths) ? ownedScopePaths : null;
    if (resolvedScopePaths === null) {
      try {
        const reg = loadRegistry(workspaceDir);
        const allPaths = new Set();
        for (const l of reg.leases) {
          for (const p of l.claimedPaths || []) {
            allPaths.add(p);
          }
        }
        if (allPaths.size > 0) {
          resolvedScopePaths = Array.from(allPaths).sort();
        } else {
          resolvedScopePaths = deriveSessionClaimedPaths({ workspaceDir, taskMdContent: resolvedTaskMd });
        }
      } catch {
        resolvedScopePaths = [];
      }
    }

    const constraints = negativeConstraints.length > 0
      ? negativeConstraints
      : [
          'NEVER modify AGENTS.md or .agents/CONTEXT.md while KV cache is warm (cachedTokens >= 15000).',
          'NEVER perform un-ranged full-file view_file calls on large source or verified schema files.',
          'NEVER delete existing test assertions or replace error handlers with empty stubs.'
        ];

    const markdown = [
      `# Baton-Pass Handoff Bundle (${ts})`,
      ``,
      `## 1. Resume Contract & Active Step`,
      `**Active Step (\`[/]\` in \`task.md\`):** ${activeStepText}`,
      ``,
      '```markdown',
      String(resolvedTaskMd).trim(),
      '```',
      ``,
      `## 2. Verified Unchanged File Schemas (Skip Re-Reading)`,
      ...(verifiedSchemaFiles.length > 0
        ? verifiedSchemaFiles.map((f) => `- \`${f}\``)
        : ['- (No unchanged schema files pinned)']),
      ``,
      `## 3. Active File Diffs & Owned Scope Paths`,
      `### Owned Scope Paths (Concurrent Lockfile DET-20)`,
      ...(resolvedScopePaths.length > 0
        ? resolvedScopePaths.map((f) => `- \`${f}\``)
        : ['- (No explicit file leases claimed)']),
      ``,
      `### Git Diff Summary`,
      '```text',
      resolvedGitDiff,
      '```',
      ``,
      `## 4. Negative Constraints & Ruled-Out Approaches`,
      ...constraints.map((c) => `- ${c}`),
      ``
    ].join('\n');

    if (writeToDisk) {
      fs.mkdirSync(path.dirname(handoffAbsPath), { recursive: true });
      fs.writeFileSync(handoffAbsPath, markdown, 'utf8');
    }

    const bootstrapContract = buildTurn1BootstrapContract({
      handoffPath: handoffRelPath,
      activeTaskStepText: activeStepText,
      verifiedSchemaFiles
    });

    const bundle = {
      timestamp: ts,
      handoffRelPath,
      handoffAbsPath,
      activeStepText,
      verifiedSchemaFiles: [...verifiedSchemaFiles],
      ownedScopePaths: [...resolvedScopePaths],
      negativeConstraints: [...constraints],
      markdown,
      bootstrapContract,
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };

    this.lastGeneratedBundle = bundle;
    return bundle;
  }

  /**
   * Silently pre-stages a zero-token disk handoff bundle when `CacheTtlWatchdog` emits `TTL_PRE_SNAPSHOT` (`T-10s`).
   */
  preStageOnTtlSnapshot(options = {}) {
    this.preStagedBundle = this.generateHandoffBundle({
      ...options,
      writeToDisk: options.writeToDisk !== false
    });
    return this.preStagedBundle;
  }

  /**
   * Executes `[Launch Hydrated Session]`: opens a new Antigravity chat thread and populates
   * the Turn-1 bootstrap contract.
   */
  async launchHydratedSession(options = {}) {
    const bundle = this.preStagedBundle || this.lastGeneratedBundle || this.generateHandoffBundle(options);
    const spawnRes = await this.agBridge.spawnCleanSession({
      sessionId: options.sessionId,
      taskMd: options.taskMdContent,
      handoffMd: bundle.markdown,
      bootstrapPrompt: bundle.bootstrapContract
    });

    return {
      ok: true,
      action: 'LAUNCH_HYDRATED_SESSION',
      sessionId: spawnRes.sessionId,
      brainDir: spawnRes.brainDir,
      handoffRelPath: bundle.handoffRelPath,
      handoffAbsPath: bundle.handoffAbsPath,
      bootstrapContract: bundle.bootstrapContract,
      verifiedSchemaFiles: bundle.verifiedSchemaFiles,
      transportUsed: spawnRes.transportUsed
    };
  }

  /**
   * Post-Handoff Amnesia Check on Turns 1–3 of the new session:
   * Flags any redundant full-file `view_file` / `read_file` of files already summarized
   * in `verifiedSchemaFiles` from the handoff bundle.
   */
  checkPostHandoffAmnesia(steps = [], verifiedSchemaFiles = null) {
    const schemaFiles = Array.isArray(verifiedSchemaFiles)
      ? verifiedSchemaFiles
      : (this.lastGeneratedBundle?.verifiedSchemaFiles || []);

    const canonVerifiedSet = new Set(schemaFiles.map((f) => canonicalizePath(f)));
    const baseNameVerifiedSet = new Set(schemaFiles.map((f) => path.basename(String(f).replace(/\\/g, '/')).toLowerCase()));

    const list = Array.isArray(steps) ? steps.slice(0, 3) : [];
    const violations = [];

    for (let turnIdx = 0; turnIdx < list.length; turnIdx++) {
      const step = list[turnIdx] || {};
      const calls = Array.isArray(step.toolCalls)
        ? step.toolCalls
        : (Array.isArray(step.tool_calls) ? step.tool_calls : [step]);

      for (const call of calls) {
        const name = String(call.name || call.tool || '').toLowerCase();
        if (name !== 'view_file' && name !== 'read_file') continue;

        const args = call.args || call.parameters || {};
        const startLine = args.StartLine ?? args.start_line ?? call.StartLine ?? null;
        const endLine = args.EndLine ?? args.end_line ?? call.EndLine ?? null;
        const isFullRead = startLine === null && endLine === null;
        if (!isFullRead) continue;

        const rawPath = String(
          call.path || args.AbsolutePath || args.TargetFile || args.Path || args.path || ''
        ).trim();
        if (!rawPath) continue;

        const canon = canonicalizePath(rawPath);
        const base = path.basename(rawPath.replace(/\\/g, '/')).toLowerCase();

        if (canonVerifiedSet.has(canon) || baseNameVerifiedSet.has(base)) {
          violations.push({
            turnNumber: turnIdx + 1,
            filePath: rawPath,
            reason: `Redundant full-file read on Turn ${turnIdx + 1} of handoff-verified schema file "${rawPath}"`
          });
        }
      }
    }

    return {
      amnesiaDetected: violations.length > 0,
      violationCount: violations.length,
      violations
    };
  }
}

export default HandoffHydrationLauncher;
