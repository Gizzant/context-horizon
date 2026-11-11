import fs from 'node:fs';
import path from 'node:path';

/**
 * Git Commit & PR Token Cost Attribution Ledger.
 *
 * Parses `.git/logs/HEAD` (`commit`, `amend`, `rebase`, `checkout`) alongside session
 * transcript steps (`edit_file`, `write_file`, `cache_read_input_tokens`, `thinking_tokens`)
 * to attribute exact token burn, cache hit rate, and estimated USD cost per Git commit and modified file.
 */

export function buildGitCommitTokenLedger(workspacePath, steps = [], { headLogContent = null, pricePerMillionUsd = 3.0 } = {}) {
  let rawHeadLog = headLogContent;
  if (rawHeadLog === null && workspacePath) {
    const headLogPath = path.join(workspacePath, '.git', 'logs', 'HEAD');
    if (fs.existsSync(headLogPath)) {
      try {
        rawHeadLog = fs.readFileSync(headLogPath, 'utf8');
      } catch {
        rawHeadLog = '';
      }
    }
  }

  const allParsedCommits = [];
  for (const line of String(rawHeadLog || '').split(/\r?\n/).filter(Boolean)) {
    // Format: <oldSha> <newSha> <name> <<email>> <unixSec> <tz>\t<action>: <message>
    const m = line.match(/^([0-9a-f]{7,40})\s+([0-9a-f]{7,40})\s+(.+?)\s+(\d{9,12})\s+([+-]\d{4})\t([^:]+):\s*(.*)$/i);
    if (m) {
      allParsedCommits.push({
        parentSha: m[1],
        commitSha: m[2],
        shortSha: m[2].slice(0, 7),
        timestampMs: Number(m[4]) * 1000,
        action: m[6].trim().toLowerCase(),
        message: m[7].trim()
      });
    }
  }

  const list = Array.isArray(steps) ? steps : [];
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalThinkingTokens = 0;
  let totalOutputTokens = 0;
  let minStepMs = Infinity;
  let maxStepMs = -Infinity;
  const fileStats = new Map();
  const normalizedSteps = [];

  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const freshInTok = Number(s.inputTokens ?? s.input_tokens ?? 0);
    const cacheCreateTok = Number(s.cacheCreationTokens ?? s.cache_creation_input_tokens ?? 0);
    const inTok = freshInTok + cacheCreateTok;
    const cacheReadTok = Number(s.cacheReadTokens ?? s.cache_read_input_tokens ?? 0);
    const thinkTok = Number(s.thinkingTokens ?? s.thinking_tokens ?? 0);
    const outTok = Number(s.outputTokens ?? s.output_tokens ?? Math.ceil(String(s.content || '').length / 4));
    const stepTok = inTok + cacheReadTok + thinkTok + outTok;

    const rawTs = s.createdAt ?? s.created_at ?? s.timestamp ?? null;
    const parsedTs = typeof rawTs === 'number' ? rawTs : (rawTs ? Date.parse(String(rawTs)) : NaN);
    if (Number.isFinite(parsedTs) && parsedTs > 0) {
      if (parsedTs < minStepMs) minStepMs = parsedTs;
      if (parsedTs > maxStepMs) maxStepMs = parsedTs;
    }

    normalizedSteps.push({
      stepIndex: i,
      timestampMs: Number.isFinite(parsedTs) ? parsedTs : null,
      inTok,
      cacheReadTok,
      thinkTok,
      outTok,
      stepTok
    });

    totalInputTokens += inTok;
    totalCacheReadTokens += cacheReadTok;
    totalThinkingTokens += thinkTok;
    totalOutputTokens += outTok;

    const calls = Array.isArray(s.toolCalls)
      ? s.toolCalls
      : (Array.isArray(s.tool_calls) ? s.tool_calls : []);

    for (const c of calls) {
      const name = String(c.name || c.tool || '').toLowerCase();
      const args = c.args || c.parameters || c.Arguments || {};
      const fp = args.Path || args.path || args.TargetFile || args.AbsolutePath;
      if (fp && /edit|write|replace/i.test(name)) {
        const cur = fileStats.get(fp) || { filePath: fp, edits: 0, attributedTokens: 0 };
        cur.edits += 1;
        cur.attributedTokens += (inTok + outTok + thinkTok) || 1200;
        fileStats.set(fp, cur);
      }
    }
  }

  // Filter commits to actual commit actions within the session's timestamp window [minStepMs - 5m, maxStepMs + 15m]
  // when step timestamps exist andheadLogContent was read from disk; otherwise fall back to commit entries (up to last 10).
  const commitActionsOnly = allParsedCommits.filter(c => /commit|merge|cherry-pick/i.test(c.action));
  const candidateCommits = commitActionsOnly.length > 0 ? commitActionsOnly : allParsedCommits;

  let commits = candidateCommits;
  const hasStepTimestamps = Number.isFinite(minStepMs) && Number.isFinite(maxStepMs) && minStepMs <= maxStepMs;
  if (hasStepTimestamps) {
    const windowStart = minStepMs - (5 * 60 * 1000);
    const windowEnd = maxStepMs + (15 * 60 * 1000);
    const inWindow = candidateCommits.filter(c => c.timestampMs >= windowStart && c.timestampMs <= windowEnd);
    if (inWindow.length > 0) {
      commits = inWindow;
    } else if (headLogContent === null) {
      commits = candidateCommits.slice(-5);
    }
  } else if (headLogContent === null && candidateCommits.length > 5) {
    commits = candidateCommits.slice(-5);
  }

  const totalTokens = totalInputTokens + totalCacheReadTokens + totalThinkingTokens + totalOutputTokens;
  const cacheHitPct = (totalInputTokens + totalCacheReadTokens) > 0
    ? Math.round((totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)) * 100)
    : 0;
  const computeCostUsd = (inT, cacheT, outT, thinkT) => parseFloat((
    ((inT * 1.0 + cacheT * 0.1 + (outT + thinkT) * 3.0) / 1_000_000) * pricePerMillionUsd
  ).toFixed(4));
  const estimatedCostUsd = computeCostUsd(totalInputTokens, totalCacheReadTokens, totalOutputTokens, totalThinkingTokens);

  const fallbackPerCommitTokens = commits.length > 0 ? Math.round(totalTokens / commits.length) : totalTokens;
  const fallbackPerCommitCost = commits.length > 0 ? parseFloat((estimatedCostUsd / commits.length).toFixed(4)) : estimatedCostUsd;

  const commitRows = commits.map((c, idx) => {
    const prevCommitMs = idx > 0 ? commits[idx - 1].timestampMs : -Infinity;
    const isLastCommit = idx === commits.length - 1;
    const intervalSteps = hasStepTimestamps
      ? normalizedSteps.filter(st =>
          st.timestampMs !== null &&
          st.timestampMs > prevCommitMs &&
          (isLastCommit ? st.timestampMs <= Math.max(c.timestampMs, maxStepMs) : st.timestampMs <= c.timestampMs)
        )
      : [];

    if (intervalSteps.length > 0) {
      const cIn = intervalSteps.reduce((acc, s) => acc + s.inTok, 0);
      const cCache = intervalSteps.reduce((acc, s) => acc + s.cacheReadTok, 0);
      const cThink = intervalSteps.reduce((acc, s) => acc + s.thinkTok, 0);
      const cOut = intervalSteps.reduce((acc, s) => acc + s.outTok, 0);
      const cTotal = cIn + cCache + cThink + cOut;
      const cHit = (cIn + cCache) > 0 ? Math.round((cCache / (cIn + cCache)) * 100) : cacheHitPct;
      return {
        ...c,
        attributedTokens: cTotal,
        cacheHitPct: cHit,
        estimatedCostUsd: computeCostUsd(cIn, cCache, cOut, cThink)
      };
    }

    return {
      ...c,
      attributedTokens: fallbackPerCommitTokens,
      cacheHitPct,
      estimatedCostUsd: fallbackPerCommitCost
    };
  });

  const prMarkdownSummary = [
    `### ⚡ Attention Horizon PR Token Ledger`,
    `| Metric | Value |`,
    `| :--- | :--- |`,
    `| **Total Session Tokens** | \`${(totalTokens / 1000).toFixed(1)}k\` |`,
    `| **Prompt Cache Hit Rate** | \`${cacheHitPct}%\` |`,
    `| **Thinking / Reasoning Tokens** | \`${(totalThinkingTokens / 1000).toFixed(1)}k\` |`,
    `| **Estimated Session Cost** | \`$${estimatedCostUsd.toFixed(4)}\` |`,
    `| **Attributed Commits** | \`${commitRows.length}\` |`
  ].join('\n');

  return {
    totalTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalThinkingTokens,
    totalOutputTokens,
    cacheHitPct,
    estimatedCostUsd,
    commits: commitRows,
    files: Array.from(fileStats.values()),
    prMarkdownSummary
  };
}
