import fs from 'node:fs';
import { getHomeDir } from './paths.mjs';
import { findSessionDirectory, parseTranscriptIncremental } from './parser.mjs';

/**
 * Multi-Agent (`invoke_subagent`) Context Tree & Handoff Inspector.
 *
 * Scans parent transcript steps for `invoke_subagent` tool calls, resolves child
 * session transcripts across `inherit`, `branch`, and `share` workspace modes,
 * and computes isolated child exploration bloat vs. parent handoff compression.
 */

export const HANDOFF_BLOAT_THRESHOLD_TOKENS = 4000;

export function inspectSubagentTree(steps = [], {
  homeDir = getHomeDir(),
  cacheDir = null
} = {}) {
  const invocations = [];
  const childIdsSeen = new Set();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const calls = step.toolCalls || [];
    for (const call of calls) {
      const name = String(call.name || '').toLowerCase();
      if (name === 'invoke_subagent') {
        const args = call.args || {};
        const role = args.Role || args.role || 'Subagent';
        const typeName = args.TypeName || args.typeName || 'self';
        const workspaceMode = args.Workspace || args.workspace || 'inherit';
        const model = args.Model || args.model || 'inherit';

        // Extract returned conversationId or subagent response from subsequent steps
        let childConversationId = call.result?.conversationId || call.conversationId || args.conversationId || null;
        let handoffTokens = 0;
        let handoffStepIdx = i;

        // Look ahead up to 6 steps for the subagent completion/response or conversationId
        for (let j = i; j < Math.min(steps.length, i + 7); j++) {
          const lookStep = steps[j] || {};
          const text = String(lookStep.content || '');
          if (!childConversationId) {
            const m = text.match(/conversation(?:Id|_id)["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (m) childConversationId = m[1];
          }
          const isParentStep = !lookStep.agentId || lookStep.agentId === 'parent';
          if (j > i && isParentStep && (text.toLowerCase().includes('subagent') || text.includes(role))) {
            const est = lookStep.outputTokens || Math.ceil(text.length / 4) || 0;
            if (est > handoffTokens) {
              handoffTokens = est;
              handoffStepIdx = j;
            }
          }
        }

        if (handoffTokens === 0) {
          handoffTokens = Math.max(250, Math.min(2500, Math.ceil(String(step.content || '').length / 4) || 600));
        }

        let isolatedTokens = 0;
        let childStepCount = 0;

        // If child session exists on disk, measure its isolated transcript size
        if (childConversationId) {
          childIdsSeen.add(childConversationId);
          try {
            const childSession = findSessionDirectory(childConversationId, homeDir);
            if (childSession && fs.existsSync(childSession.sessionDir)) {
              const parsedChild = parseTranscriptIncremental(childSession.sessionDir, cacheDir);
              childStepCount = (parsedChild.steps || []).length;
              isolatedTokens = (parsedChild.steps || []).reduce((sum, cs) => {
                const tok = cs.outputTokens || Math.ceil((cs.untruncatedLength || 0) / 4) || 500;
                return sum + tok;
              }, 0);
            }
          } catch {}
        }

        // Fallback estimate for child steps embedded via agentId === `child:...`
        if (isolatedTokens === 0) {
          const embeddedChildSteps = steps.filter(s => s.agentId && s.agentId !== 'parent');
          if (embeddedChildSteps.length > 0) {
            childStepCount = embeddedChildSteps.length;
            isolatedTokens = embeddedChildSteps.reduce((sum, cs) => sum + (cs.outputTokens || Math.ceil((cs.untruncatedLength || 0) / 4) || 800), 0);
          } else {
            isolatedTokens = Math.max(handoffTokens * 12, 18000);
            childStepCount = 8;
          }
        }

        const compressionRatio = parseFloat((isolatedTokens / Math.max(1, handoffTokens)).toFixed(1));
        const rawDumpLeak = handoffTokens >= HANDOFF_BLOAT_THRESHOLD_TOKENS;

        invocations.push({
          stepIndex: i,
          handoffStepIndex: handoffStepIdx,
          conversationId: childConversationId || `subagent-step-${i}`,
          role,
          typeName,
          workspaceMode,
          model,
          childStepCount,
          isolatedTokens,
          handoffTokens,
          tokensSaved: Math.max(0, isolatedTokens - handoffTokens),
          compressionRatio,
          rawDumpLeak,
          badgeLabel: `[Subagent: ${typeName} | ${(isolatedTokens / 1000).toFixed(1)}k isolated -> ${(handoffTokens / 1000).toFixed(1)}k handoff (${Math.round(compressionRatio)}x)]`
        });
      }
    }
  }

  const totalIsolatedTokens = invocations.reduce((s, x) => s + x.isolatedTokens, 0);
  const totalHandoffTokens = invocations.reduce((s, x) => s + x.handoffTokens, 0);
  const totalSavedTokens = invocations.reduce((s, x) => s + x.tokensSaved, 0);
  const overallCompressionRatio = totalHandoffTokens > 0
    ? parseFloat((totalIsolatedTokens / totalHandoffTokens).toFixed(1))
    : 0;

  return {
    count: invocations.length,
    totalIsolatedTokens,
    totalHandoffTokens,
    totalSavedTokens,
    overallCompressionRatio,
    hasRawDumpLeak: invocations.some(x => x.rawDumpLeak),
    invocations
  };
}

/**
 * Builds a parent -> subagent worktree DAG (`inherit`, `branch`, `share`),
 * tracking isolated vs handoff tokens, `cacheCreationEphemeral5mInputTokens` TTL countdowns,
 * and detecting concurrent `fileCollisions` when >= 2 active subagents edit the same file path.
 */
export function buildSubagentWorktreeDag(steps = [], { childTranscripts = [], nowMs = Date.now() } = {}) {
  const baseTree = inspectSubagentTree(steps);
  const editsByAgent = new Map(); // canonPath -> Set<agentId>
  const nodes = [];

  for (const child of (childTranscripts || [])) {
    const agentId = String(child.agentId || child.conversationId || `sub-${nodes.length}`);
    const workspaceMode = child.workspaceMode || 'inherit';
    const childSteps = Array.isArray(child.steps) ? child.steps : [];
    let isolatedTokens = 0;
    let latestTs = 0;
    const modifiedFiles = new Set();

    for (const cs of childSteps) {
      isolatedTokens += Number(cs.outputTokens ?? cs.output_tokens ?? 600);
      const ts = cs.createdAt ? Date.parse(cs.createdAt) : (cs.timestamp ? Date.parse(cs.timestamp) : 0);
      if (Number.isFinite(ts) && ts > latestTs) latestTs = ts;

      const calls = Array.isArray(cs.toolCalls) ? cs.toolCalls : (Array.isArray(cs.tool_calls) ? cs.tool_calls : []);
      for (const c of calls) {
        const name = String(c.name || c.tool || '').toLowerCase();
        const args = c.args || c.parameters || c.Arguments || {};
        const fp = args.Path || args.path || args.TargetFile || args.AbsolutePath;
        if (fp && /edit|write|replace/i.test(name)) {
          const norm = String(fp).replace(/\\/g, '/').toLowerCase();
          modifiedFiles.add(norm);
          if (!editsByAgent.has(norm)) editsByAgent.set(norm, new Set());
          editsByAgent.get(norm).add(agentId);
        }
      }
    }

    const idleSec = latestTs > 0 ? Math.max(0, Math.round((nowMs - latestTs) / 1000)) : 0;
    const ttlRemainingSec = latestTs > 0 ? Math.max(0, 300 - idleSec) : 300;

    nodes.push({
      agentId,
      workspaceMode,
      isolatedTokens,
      ttlWindowSec: 300,
      ttlRemainingSec,
      modifiedFiles: Array.from(modifiedFiles)
    });
  }

  const fileCollisions = [];
  for (const [filePath, agentsSet] of editsByAgent.entries()) {
    if (agentsSet.size >= 2) {
      fileCollisions.push({
        filePath,
        agents: Array.from(agentsSet),
        severity: 'CONCURRENT_EDIT_COLLISION'
      });
    }
  }

  return {
    parentInvocationCount: baseTree.count,
    nodes,
    fileCollisions,
    hasFileCollision: fileCollisions.length > 0
  };
}

