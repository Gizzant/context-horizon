/**
 * Cross-Session Forensic Postmortem Engine.
 * Deterministic local transcript forensics with file/line/config remediations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHomeDir, getBrainStores, getAntigravitySurfaces, isIgnorablePath, ensureSupportedNodeVersion } from '../core/paths.mjs';
import { parseTranscriptIncremental } from '../core/parser.mjs';
import { classifyHorizon } from '../core/classifier.mjs';
import { measureBaseline } from '../core/baseline.mjs';
import { getFlightcheckDir } from '../core/sidecar_store.mjs';
import { buildGitCommitTokenLedger } from '../core/git_ledger.mjs';
import { upsertEpisodicMemory } from '../core/episodic_memory.mjs';

export const ROOT_CAUSES = {
  CONTEXT_ROT_DECAY: 'CONTEXT_ROT_DECAY',
  VERIFICATION_CHURN: 'VERIFICATION_CHURN',
  SPEC_AMBIGUITY: 'SPEC_AMBIGUITY',
  CLEAN: 'CLEAN',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE'
};

export const REWORK_SHAPES = {
  CLEAN: 'Clean execution',
  EARLY_REPLAN_STABLE: 'Early replan then stable finish',
  VERIFICATION_CHURN: 'Late-stage verification churn',
  EXPLORATORY: 'Exploratory / research session',
  ABANDONED: 'Abandoned mid-flight'
};

/**
 * Runs the forensic postmortem over historical Antigravity sessions.
 */
export async function runPostmortem(options = {}) {
  const {
    last = 15,
    workspace = process.cwd(),
    json = false,
    writeFiles = true,
    demo = false
  } = options;

  const home = getHomeDir();
  const surfaces = getAntigravitySurfaces(home, { includeMissing: false });
  const stores = surfaces.length > 0
    ? surfaces.map(s => ({ name: s.name, path: s.brainDir }))
    : getBrainStores(home);

  const seenDirs = new Set();
  const sessionCandidates = [];
  for (const store of stores) {
    if (!fs.existsSync(store.path)) continue;
    try {
      const dirs = fs.readdirSync(store.path, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const fullPath = path.join(store.path, d.name);
          let mtimeMs = 0;
          try {
            const logsDir = path.join(fullPath, '.system_generated', 'logs');
            const fullJsonl = path.join(logsDir, 'transcript_full.jsonl');
            const compactJsonl = path.join(logsDir, 'transcript.jsonl');
            if (fs.existsSync(fullJsonl)) mtimeMs = fs.statSync(fullJsonl).mtimeMs;
            else if (fs.existsSync(compactJsonl)) mtimeMs = fs.statSync(compactJsonl).mtimeMs;
            else mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {}
          return { id: d.name, path: fullPath, store: store.name, mtimeMs };
        });
      for (const item of dirs) {
        if (!seenDirs.has(item.path)) {
          seenDirs.add(item.path);
          sessionCandidates.push(item);
        }
      }
    } catch {}
  }

  // Sort newest first and inspect up to `targetLimit` non-empty sessions
  sessionCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const targetLimit = Math.max(1, Number(last) || 15);

  const diagnostics = [];
  const hotspotMap = new Map(); // path -> { path, occurrences, wastedTokens, sessions: Set, sampleSteps: number[] }
  let latestSessionSteps = [];
  let totalTokensInspected = 0;
  let totalSludgeUsd = 0;
  let amputationSessionsCount = 0;
  let strongProofCount = 0;
  let totalPlanRevisions = 0;
  let errorLoopCount = 0;
  let totalDuplicateReadsCount = 0;
  let totalDeadErrorsCount = 0;
  let worstSessionOffender = null;

  if (!demo) {
    for (const candidate of sessionCandidates) {
      if (diagnostics.length >= targetLimit) break;

      let parsed = null;
      try {
        parsed = parseTranscriptIncremental(candidate.path, null);
      } catch {
        continue;
      }

      if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        continue;
      }

      let horizon = null;
      try {
        horizon = classifyHorizon(parsed.steps, {
          sessionId: candidate.id,
          brainDir: candidate.path,
          logFilePath: parsed.filePath,
          canonicalWorkspace: workspace,
          useNativeCeiling: true
        });
      } catch {
        continue;
      }

      if (!horizon) continue;
      if (latestSessionSteps.length === 0) {
        latestSessionSteps = parsed.steps;
      }

      const purity = horizon.metrics?.signalPurityPct ?? 100;
      const tokens = horizon.window?.totalActiveTokens || 0;
      const sludgeUsd = horizon.metrics?.sludgeTaxPerTurnUsd || 0;
      const isAmputation = Boolean(horizon.amputation?.inAmputationZone);
      const signals = horizon.brainSignals || {};

      totalTokensInspected += tokens;
      totalSludgeUsd += sludgeUsd;
      if (isAmputation) amputationSessionsCount++;

      const planChurn = signals.planChurn || { planRevisions: 0, warn: false };
      const proofQuality = signals.proofQuality || { grade: 'None', reason: '' };
      const contextRot = signals.contextRot || { splitRecommended: false, reason: '' };
      const errorLoop = signals.errorLoop || { loop: false, fingerprint: null };

      totalPlanRevisions += planChurn.planRevisions || 0;
      if (proofQuality.grade === 'Strong') strongProofCount++;
      if (errorLoop.loop) errorLoopCount++;

      // Track hotspots from duplicate read offenders & classifier offenders
      const dupOffenders = signals.duplicateReads?.topFiles || [];
      const rawOffenders = horizon.offenders || [];
      for (const off of dupOffenders) {
        if (!off.path) continue;
        totalDuplicateReadsCount += Math.max(1, (off.occurrences || 2) - 1);
        const matchRaw = rawOffenders.find(r => r.target === off.path);
        const curr = hotspotMap.get(off.path) || {
          path: off.path,
          occurrences: 0,
          wastedTokens: 0,
          sessions: new Set(),
          sampleSteps: []
        };
        curr.occurrences += off.occurrences || 1;
        curr.wastedTokens += off.wastedTokens || 0;
        curr.sessions.add(candidate.id);
        if (matchRaw && Array.isArray(matchRaw.stepIndices) && curr.sampleSteps.length === 0) {
          curr.sampleSteps = matchRaw.stepIndices.slice(0, 6);
        }
        hotspotMap.set(off.path, curr);
      }

      if (rawOffenders.length > 0) {
        const topOff = rawOffenders[0];
        if (!worstSessionOffender || topOff.wastedTokens > worstSessionOffender.wastedTokens) {
          worstSessionOffender = {
            ...topOff,
            sessionId: candidate.id
          };
        }
      }

      totalDeadErrorsCount += (signals.deadErrors?.errorCount || 0);

      // Root Cause & Confidence Classification
      let rootCause = ROOT_CAUSES.INSUFFICIENT_EVIDENCE;
      let confidence = 'Low';
      const evidenceFor = [];
      const evidenceAgainst = [];

      if (contextRot.splitRecommended || (purity < 45 && tokens > 100000)) {
        rootCause = ROOT_CAUSES.CONTEXT_ROT_DECAY;
        confidence = 'High';
        evidenceFor.push(`High sludge dilution (${purity}% purity)`, contextRot.reason);
        if (planChurn.planRevisions > 0) evidenceAgainst.push(`Plan underwent ${planChurn.planRevisions} revisions`);
      } else if (errorLoop.loop || (proofQuality.grade === 'None' && (signals.deadErrors?.errorCount || 0) >= 3)) {
        rootCause = ROOT_CAUSES.VERIFICATION_CHURN;
        confidence = 'High';
        evidenceFor.push(
          errorLoop.loop ? `Repeated error loop: ${errorLoop.fingerprint}` : `${signals.deadErrors?.errorCount} dead errors without passing test`
        );
        if (purity > 70) evidenceAgainst.push(`Context purity remained relatively high (${purity}%)`);
      } else if (planChurn.planRevisions >= 3) {
        rootCause = ROOT_CAUSES.SPEC_AMBIGUITY;
        confidence = 'Medium';
        evidenceFor.push(`${planChurn.planRevisions} plan revisions indicate evolving spec or scope churn`);
      } else if (purity >= 70 && !isAmputation && !errorLoop.loop) {
        rootCause = ROOT_CAUSES.CLEAN;
        confidence = parsed.steps.length >= 8 ? 'High' : 'Medium';
        evidenceFor.push(`High signal purity (${purity}%)`, 'Zero amputation or error loops detected');
      } else {
        rootCause = ROOT_CAUSES.INSUFFICIENT_EVIDENCE;
        confidence = 'Low';
        evidenceFor.push(`Short or inconclusive session (${parsed.steps.length} steps)`);
      }

      let reworkShape = REWORK_SHAPES.CLEAN;
      if (rootCause === ROOT_CAUSES.VERIFICATION_CHURN) {
        reworkShape = REWORK_SHAPES.VERIFICATION_CHURN;
      } else if (planChurn.planRevisions >= 1 && proofQuality.grade === 'Strong') {
        reworkShape = REWORK_SHAPES.EARLY_REPLAN_STABLE;
      } else if (tokens < 25000 && !dupOffenders.length) {
        reworkShape = REWORK_SHAPES.EXPLORATORY;
      } else if (rootCause === ROOT_CAUSES.CONTEXT_ROT_DECAY) {
        reworkShape = REWORK_SHAPES.ABANDONED;
      }

      diagnostics.push({
        session_id: candidate.id,
        mtime: new Date(candidate.mtimeMs).toISOString(),
        turns: horizon.window?.turnCount || parsed.steps.length,
        total_tokens: tokens,
        signal_purity_pct: purity,
        sludge_tax_usd_turn: sludgeUsd,
        primary_root_cause: rootCause,
        confidence,
        rework_shape: reworkShape,
        proof_quality: proofQuality.grade,
        plan_revisions: planChurn.planRevisions,
        handoff_status: horizon.handoff?.result || 'UNKNOWN',
        top_offender: rawOffenders[0] ? `${rawOffenders[0].target} (${Math.round(rawOffenders[0].wastedTokens / 1000)}k tok)` : 'None',
        evidence_for: evidenceFor,
        evidence_against: evidenceAgainst
      });

      if (writeFiles) {
        try {
          const epDbPath = path.join(getFlightcheckDir(), 'episodic_memory.db');
          await upsertEpisodicMemory(epDbPath, {
            sessionId: candidate.id,
            workspacePath: workspace || process.cwd(),
            title: `Session ${candidate.id.slice(0, 8)} (${reworkShape})`,
            summary: `Purity ${purity}%, ${tokens.toLocaleString()} tokens, root cause: ${rootCause}.`,
            decisions: evidenceFor,
            modifiedFiles: dupOffenders.map(f => f.path).slice(0, 6),
            updatedAt: new Date(candidate.mtimeMs).toISOString()
          });
        } catch {}
      }
    }
  }

  const gitLedger = buildGitCommitTokenLedger(workspace || process.cwd(), latestSessionSteps);

  const sessionCount = diagnostics.length;
  const isSynthetic = demo || sessionCount === 0;

  // Baseline Turn-0 MCP & Rule overhead check
  let baseline = null;
  try {
    baseline = measureBaseline(workspace || process.cwd(), home);
  } catch {}

  const worstPurityPct = isSynthetic ? 34.8 : Math.min(...diagnostics.map(d => d.signal_purity_pct));
  const avgPurityPct = isSynthetic ? 62.4 : Math.round(diagnostics.reduce((s, d) => s + d.signal_purity_pct, 0) / sessionCount);
  const strongProofRatePct = isSynthetic ? 55 : Math.round((strongProofCount / sessionCount) * 100);
  const avgPlanRevisions = isSynthetic ? 1.2 : Number((totalPlanRevisions / sessionCount).toFixed(1));
  const estTokensM = isSynthetic ? '1.84M' : `${(totalTokensInspected / 1000000).toFixed(2)}M`;
  const totalSludgeFormatted = isSynthetic ? '$1.92' : `$${totalSludgeUsd.toFixed(2)}`;

  const recommendations = [];
  const allHotspots = Array.from(hotspotMap.values()).sort((a, b) => b.wastedTokens - a.wastedTokens);

  // Rec 1: Ignorable file hotspots -> .antigravityignore
  const ignorableHotspots = allHotspots.filter(h => isIgnorablePath(h.path));
  if (ignorableHotspots.length > 0) {
    const topIgnorable = ignorableHotspots[0];
    const wastedK = Math.max(0.1, (topIgnorable.wastedTokens / 1000).toFixed(1));
    recommendations.push({
      id: 'REC-IGNORE-HOTSPOTS',
      observed_pattern: `Non-source file "${topIgnorable.path}" had ${topIgnorable.occurrences} redundant read(s) across ${topIgnorable.sessions.size} session(s), wasting ~${wastedK}k tokens.`,
      likely_cause: 'Lockfile, build artifact, or scratch file is unignored in workspace.',
      change_to_make: `Run: echo "${topIgnorable.path}" >> .antigravityignore`,
      confidence: 'High',
      rollback_method: 'Remove line from .antigravityignore'
    });
  }

  // Rec 2: Active source file duplicate reads -> Line-bounded read_file or Surgical Pruner
  const sourceHotspots = allHotspots.filter(h => !isIgnorablePath(h.path));
  if (sourceHotspots.length > 0) {
    const topSource = sourceHotspots[0];
    const wastedK = Math.max(0.1, (topSource.wastedTokens / 1000).toFixed(1));
    const stepStr = topSource.sampleSteps.length > 0 ? ` (e.g., steps [${topSource.sampleSteps.join(', ')}])` : '';
    recommendations.push({
      id: 'REC-BOUNDED-SOURCE-READS',
      observed_pattern: `Source file "${topSource.path}" had ${topSource.occurrences} superseded read(s) across ${topSource.sessions.size} session(s)${stepStr}, wasting ~${wastedK}k tokens.`,
      likely_cause: 'Unbounded full-file reads instead of targeted line-range reads or surgical pruning.',
      change_to_make: `Use line-bounded reads: read_file { Path: "${topSource.path}", StartLine: 1, EndLine: 250 } or fold stale reads via npx ctxtop --serve (Condense Stale Reads).`,
      confidence: 'High',
      rollback_method: 'Restore from .pre_prune backup in session logs directory'
    });
  }

  // Rec 3: Heavy MCP Server Schema Overhead
  const mcpRows = (baseline?.rows || []).filter(r => r.kind === 'mcp' && (r.schemaTokens || r.tokens) >= 4000);
  if (mcpRows.length > 0) {
    const topMcp = mcpRows.sort((a, b) => (b.schemaTokens || b.tokens) - (a.schemaTokens || a.tokens))[0];
    const schemaTok = topMcp.schemaTokens || topMcp.tokens;
    recommendations.push({
      id: 'REC-MCP-SCHEMA-TAX',
      observed_pattern: `${topMcp.source} injects ~${Math.round(schemaTok / 1000)}k tokens (${topMcp.toolCount || '?'} tools) into Turn-0 baseline metadata.`,
      likely_cause: 'Large MCP server tool catalog loaded in workspace or global config.',
      change_to_make: `Ensure ${topMcp.source.replace('MCP: ', '')} is set to "loading": "lazy" in ~/.gemini/config/mcp_config.json or disable when unused.`,
      confidence: 'High',
      rollback_method: 'Re-enable server in mcp_config.json'
    });
  }

  // Rec 4: Amputation / Threshold Compaction
  if (amputationSessionsCount > 0) {
    recommendations.push({
      id: 'REC-SAFE-LIMIT-COMPACT',
      observed_pattern: `${amputationSessionsCount} of ${sessionCount} sessions crossed the safe attention limit (>140k-179k tokens).`,
      likely_cause: 'Delayed compaction allowing superseded file snapshots and resolved error traces to accumulate.',
      change_to_make: 'Save state to task.md and run /compact when active context crosses 140k tokens.',
      confidence: 'High',
      rollback_method: 'None'
    });
  }

  // Rec 5: Verification / Error Loops
  if (errorLoopCount > 0 || (strongProofRatePct < 50 && sessionCount >= 3)) {
    recommendations.push({
      id: 'REC-VERIFICATION-HYGIENE',
      observed_pattern: errorLoopCount > 0
        ? `${errorLoopCount} session(s) hit 3+ consecutive command failures with identical error fingerprints.`
        : `Automated test proof was recorded in only ${strongProofRatePct}% of audited sessions.`,
      likely_cause: 'Repeating failing commands in the main context window without isolating root cause.',
      change_to_make: 'Delegate failing test triage to invoke_subagent (research) or register a CLI output dampener in .agents/hooks.json.',
      confidence: 'High',
      rollback_method: 'Remove PreToolUse entry from .agents/hooks.json'
    });
  }

  const cappedRecommendations = recommendations.slice(0, 5);

  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(getFlightcheckDir(), 'postmortems', timestampStr);

  const reportMarkdown = [
    '# Context Horizon Session Postmortem Report',
    '',
    `**Generated**: ${new Date().toISOString()}  `,
    `**Sessions Audited**: ${isSynthetic ? '14 (Demo)' : sessionCount}  `,
    `**Total Active Tokens Inspected**: ${estTokensM}  `,
    '',
    '## Executive Telemetry KPIs',
    '',
    '| KPI Dimension | Value | Rating | Health Guideline |',
    '| :--- | :---: | :---: | :--- |',
    `| **Worst Signal Purity** | **${worstPurityPct}%** | ${worstPurityPct >= 70 ? 'GOOD' : (worstPurityPct >= 45 ? 'WARN' : 'CRITICAL')} | Target >70% signal |`,
    `| **Average Purity** | **${avgPurityPct}%** | ${avgPurityPct >= 70 ? 'GOOD' : (avgPurityPct >= 50 ? 'WARN' : 'CRITICAL')} | Historical average across sessions |`,
    `| **Over-Limit Sessions** | **${amputationSessionsCount}** | ${amputationSessionsCount === 0 ? 'GOOD' : 'HAZARD'} | Sessions crossing safe token limit |`,
    `| **Strong Proof Rate** | **${strongProofRatePct}%** | ${strongProofRatePct >= 70 ? 'GOOD' : (strongProofRatePct >= 40 ? 'MODERATE' : 'LOW')} | Verified via automated test suite |`,
    `| **Avg Plan Revisions** | **${avgPlanRevisions}** | ${avgPlanRevisions <= 1.5 ? 'STABLE' : (avgPlanRevisions < 3 ? 'MODERATE' : 'CHURN')} | Revisions >= 3 indicate churn |`,
    `| **Repetitive Error Loops** | **${errorLoopCount}** | ${errorLoopCount === 0 ? 'NONE' : 'DETECTED'} | Identical command failure fingerprint |`,
    `| **Sludge Tax Wasted** | **${totalSludgeFormatted}** | TELEMETRY | Cumulative wasted re-sending noise |`,
    '',
    '## Top Hotspot Files (Duplicate Reads)',
    '',
    allHotspots.length === 0
      ? '_No duplicate file reads detected across audited sessions._'
      : [
          '| File Path | Occurrences | Wasted Tokens | Sessions Affected | Action |',
          '| :--- | :---: | :---: | :---: | :--- |',
          ...allHotspots
            .slice(0, 8)
            .map(h => `| \`${h.path}\` | ${h.occurrences} | ~${Math.round(h.wastedTokens / 1000)}k | ${h.sessions.size} | ${isIgnorablePath(h.path) ? 'Add to `.antigravityignore`' : 'Use `StartLine`/`EndLine` or Surgical Pruner'} |`)
        ].join('\n'),
    '',
    '## Actionable Recommendations (Max 5)',
    '',
    cappedRecommendations.length === 0
      ? '_All inspected sessions exhibit clean context hygiene. No configuration changes required._'
      : cappedRecommendations.map((r, idx) => [
          `### ${idx + 1}. [${r.id}] ${r.change_to_make}`,
          `- **Observed Pattern**: ${r.observed_pattern}`,
          `- **Likely Cause**: ${r.likely_cause}`,
          `- **Confidence**: ${r.confidence}`,
          `- **Safe Rollback**: ${r.rollback_method}`
        ].join('\n')).join('\n\n')
  ].join('\n');

  if (writeFiles && !isSynthetic) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'session_analysis_report.md'), reportMarkdown, 'utf8');

      const jsonlContent = diagnostics.map(d => JSON.stringify(d)).join('\n');
      fs.writeFileSync(path.join(outDir, 'conversation_diagnostics.jsonl'), jsonlContent, 'utf8');
    } catch {}
  }

  const hotspotsSummary = allHotspots.slice(0, 5).map(h => ({
    path: h.path,
    occurrences: h.occurrences,
    wastedTokens: h.wastedTokens,
    sessionsAffected: h.sessions.size,
    ignorable: isIgnorablePath(h.path),
    sampleSteps: h.sampleSteps
  }));

  const resultPayload = {
    isSynthetic,
    sessionCount: isSynthetic ? 14 : sessionCount,
    estTokensM,
    worstPurityPct,
    avgPurityPct,
    strongProofRatePct,
    avgPlanRevisions,
    amputationSessionsCount,
    totalDuplicateReads: isSynthetic ? 47 : Math.max(0, totalDuplicateReadsCount),
    totalDeadErrors: isSynthetic ? 19 : Math.max(0, totalDeadErrorsCount),
    sludgeUsdFormatted: totalSludgeFormatted,
    errorLoopCount,
    hotspots: hotspotsSummary,
    worstSessionOffender,
    recommendations: cappedRecommendations,
    gitLedger,
    reportPath: writeFiles && !isSynthetic ? path.join(outDir, 'session_analysis_report.md') : null,
    diagnostics
  };

  if (json) {
    console.log(JSON.stringify(resultPayload, null, 2));
  }

  return resultPayload;
}

export function printPostmortemSummary(res) {
  console.log(`\n\x1b[1mContext Horizon Forensic Postmortem (${res.sessionCount} sessions${res.isSynthetic ? ' [Demo]' : ''})\x1b[0m`);
  console.log('='.repeat(76));
  console.log(`  Tokens Inspected : ${res.estTokensM}   | Avg Purity : ${res.avgPurityPct}% (Worst: ${res.worstPurityPct}%)`);
  console.log(`  Duplicate Reads  : ${res.totalDuplicateReads} reads  | Dead Errors: ${res.totalDeadErrors} traces | Est. Waste: ${res.sludgeUsdFormatted}`);
  console.log(`  Over Safe Limit  : ${res.amputationSessionsCount} sessions | Error Loops: ${res.errorLoopCount}        | Proof Rate: ${res.strongProofRatePct}%`);

  if (res.hotspots && res.hotspots.length > 0) {
    console.log('\n\x1b[1mTop Duplicate-Read File Hotspots:\x1b[0m');
    for (const h of res.hotspots) {
      const wastedK = Math.max(0.1, (h.wastedTokens / 1000).toFixed(1));
      const stepsNote = h.sampleSteps && h.sampleSteps.length ? ` [steps ${h.sampleSteps.join(',')}]` : '';
      console.log(`  • ${h.path} — ${h.occurrences} superseded read(s) (~${wastedK}k tok wasted across ${h.sessionsAffected} session(s))${stepsNote}`);
    }
  }

  if (res.recommendations && res.recommendations.length > 0) {
    console.log('\n\x1b[1mConcrete Remediations:\x1b[0m');
    for (const [idx, r] of res.recommendations.entries()) {
      console.log(`  ${idx + 1}. [\x1b[36m${r.id}\x1b[0m] ${r.change_to_make}`);
      console.log(`     └─ ${r.observed_pattern}`);
    }
  }

  if (res.reportPath) {
    console.log(`\nReport written to: \x1b[36m${res.reportPath}\x1b[0m\n`);
  } else {
    console.log('');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const lastIdx = args.indexOf('--last');
  const last = lastIdx !== -1 ? Number(args[lastIdx + 1]) : 15;
  const json = args.includes('--json');
  const demo = args.includes('--demo');
  runPostmortem({ last, json, demo, writeFiles: true }).then(res => {
    if (!json) {
      printPostmortemSummary(res);
    }
  });
}
