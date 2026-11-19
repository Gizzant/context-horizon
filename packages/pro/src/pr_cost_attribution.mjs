/**
 * @file packages/pro/src/pr_cost_attribution.mjs
 * Pro Anchor #2: Git Branch & PR Token/USD Cost Attribution.
 *
 * Correlates `git log <base>..HEAD --numstat` commits on the current branch with
 * local session steps and 30-day savings ledger entries to attribute exact tokens,
 * cache hit rate, USD spend, USD saved, waste ratio, and USD per 100 LOC without
 * leaking OS home directories. Zero runtime npm dependencies, zero network calls.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireProFeature } from './_license.mjs';

export const PR_ATTRIBUTION_FORMAT = 'highbeam-pr-attribution/v1';

const RING0_DETECTORS = new Set(['DET-01', 'DET-02', 'DET-03', 'DET-04', 'DET-05']);

function sanitizeRelativeRepoPath(rawPath = '', cwd = '') {
  const input = String(rawPath || '').trim();
  if (!input) return '';
  let normalized = input.replace(/\\/g, '/');
  if (cwd) {
    const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input);
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      normalized = rel;
    }
  }
  normalized = normalized
    .replace(/^[A-Za-z]:\/Users\/[^/]+\//i, '')
    .replace(/^\/Users\/[^/]+\//i, '')
    .replace(/^\/home\/[^/]+\//i, '')
    .replace(/^file:\/\/\//i, '')
    .replace(/^\.\//, '');
  return normalized;
}

function parseGitLogNumstat(rawText = '', cwd = '') {
  const commits = [];
  let current = null;

  for (const line of String(rawText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('COMMIT|')) {
      const parts = line.split('|');
      const sha = parts[1] || '';
      const timestampIso = parts[2] || '';
      const author = parts[3] || '';
      const subject = parts.slice(4).join('|').trim();
      const parsedMs = Date.parse(timestampIso);
      current = {
        sha,
        shortSha: sha.slice(0, 7),
        timestampIso,
        timestampMs: Number.isFinite(parsedMs) ? parsedMs : 0,
        author,
        subject,
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        totalLoc: 0
      };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    const numMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (numMatch) {
      const additions = numMatch[1] === '-' ? 0 : Number(numMatch[1]);
      const deletions = numMatch[2] === '-' ? 0 : Number(numMatch[2]);
      const filePath = sanitizeRelativeRepoPath(numMatch[3], cwd);
      current.files.push({ filePath, additions, deletions });
      current.totalAdditions += additions;
      current.totalDeletions += deletions;
      current.totalLoc += additions + deletions;
    }
  }

  return commits;
}

/**
 * Runs local read-only `git log <base>..<head> --numstat` cleanly without shell expansion.
 */
export function collectGitBranchCommits(cwd, { base = 'main', head = 'HEAD', maxCommits = 100, fallbackToRecent = true } = {}) {
  const repoDir = path.resolve(cwd || process.cwd());
  const formatArg = '--format=COMMIT|%H|%aI|%an|%s';

  const runGit = (revRangeArgs) =>
    execFileSync('git', ['log', ...revRangeArgs, formatArg, '--numstat', '-n', String(maxCommits)], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

  try {
    const raw = runGit([`${base}..${head}`]);
    return {
      ok: true,
      base,
      head,
      fallbackUsed: false,
      commits: parseGitLogNumstat(raw, repoDir)
    };
  } catch (rangeErr) {
    if (!fallbackToRecent) {
      return { ok: false, base, head, commits: [], error: rangeErr?.message || String(rangeErr) };
    }
    try {
      const rawFallback = runGit([head]);
      return {
        ok: true,
        base,
        head,
        fallbackUsed: true,
        commits: parseGitLogNumstat(rawFallback, repoDir)
      };
    } catch (headErr) {
      return {
        ok: false,
        base,
        head,
        fallbackUsed: false,
        commits: [],
        error: headErr?.message || String(headErr)
      };
    }
  }
}

function readLedgerJsonlSafe(homeDir) {
  const p = path.join(String(homeDir || os.homedir()), '.ctxtop', 'saved_quota_ledger.jsonl');
  if (!fs.existsSync(p)) return [];
  const entries = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (err) {
      void err; // Ignore malformed ledger lines during read-only PR aggregation.
    }
  }
  return entries;
}

function extractStepFields(step = {}, cwd = '') {
  const inTok = Number(step.inputTokens ?? step.input_tokens ?? 0) + Number(step.cacheCreationTokens ?? step.cache_creation_input_tokens ?? 0);
  const cacheReadTok = Number(step.cacheReadTokens ?? step.cache_read_input_tokens ?? 0);
  const outTok =
    Number(step.outputTokens ?? step.output_tokens ?? 0) +
    Number(step.thinkingTokens ?? step.thinking_tokens ?? 0);
  const wasteTok = Number(step.wasteTokens ?? step.wastedTokens ?? 0);
  const rawTs = step.timestampMs ?? step.createdAt ?? step.created_at ?? step.timestamp ?? null;
  const tsMs = typeof rawTs === 'number' ? rawTs : rawTs ? Date.parse(String(rawTs)) : NaN;

  const filesTouched = new Set();
  const explicitFile = step.filePath || step.path || step.targetFile;
  if (explicitFile) {
    const clean = sanitizeRelativeRepoPath(explicitFile, cwd);
    if (clean) filesTouched.add(clean);
  }
  const calls = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : Array.isArray(step.tool_calls)
      ? step.tool_calls
      : [];
  for (const c of calls) {
    const args = c?.args || c?.parameters || c?.Arguments || {};
    const fp = args.Path || args.path || args.TargetFile || args.AbsolutePath;
    if (fp) {
      const clean = sanitizeRelativeRepoPath(fp, cwd);
      if (clean) filesTouched.add(clean);
    }
  }

  const detector = String(step.detector || step.detectorId || '').toUpperCase();
  const isRing0 =
    Boolean(step.ring0Violation) ||
    Boolean(step.blocked && RING0_DETECTORS.has(detector)) ||
    (step.decision === 'deny' && RING0_DETECTORS.has(detector));

  return {
    inTok,
    cacheReadTok,
    outTok,
    wasteTok,
    totalTok: inTok + cacheReadTok + outTok,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    filesTouched: Array.from(filesTouched),
    isRing0
  };
}

function computeStepCostUsd(inTok, cacheReadTok, outTok, pricePerMillionUsd = 3.0) {
  return ((inTok * 1.0 + cacheReadTok * 0.1 + outTok * 5.0) / 1_000_000) * pricePerMillionUsd;
}

/**
 * Builds Git branch / PR token and USD attribution report (Pro/LTD/Team/Trial).
 */
export function buildPrCostAttribution(options = {}) {
  const entitlement = requireProFeature('pr_cost_attribution', options);
  if (!entitlement.allowed && !options.preview) {
    return { ok: false, entitlement, upgradeHint: entitlement.upgradeHint };
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const base = String(options.base || 'main');
  const head = String(options.head || 'HEAD');
  const pricePerMillionUsd = Number(options.pricePerMillionUsd || 3.0);

  let commits = Array.isArray(options.commits) ? options.commits : null;
  let fallbackUsed = false;
  if (!commits) {
    const gitRes = collectGitBranchCommits(cwd, {
      base,
      head,
      fallbackToRecent: options.fallbackToRecent !== false
    });
    if (!gitRes.ok) {
      return { ok: false, error: gitRes.error, base, head, entitlement };
    }
    commits = gitRes.commits;
    fallbackUsed = gitRes.fallbackUsed;
  }

  const rawSteps = [];
  if (Array.isArray(options.steps)) {
    rawSteps.push(...options.steps);
  }
  if (Array.isArray(options.sessions)) {
    for (const sess of options.sessions) {
      if (Array.isArray(sess?.steps)) rawSteps.push(...sess.steps);
    }
  }
  const normalizedSteps = rawSteps.map((s) => extractStepFields(s, cwd));

  const rawLedger = Array.isArray(options.ledgerEntries)
    ? options.ledgerEntries
    : options.readLedger !== false
      ? readLedgerJsonlSafe(options.homeDir)
      : [];

  const validTimestamps = commits.map((c) => c.timestampMs).filter((t) => Number.isFinite(t) && t > 0);
  const minCommitMs = validTimestamps.length ? Math.min(...validTimestamps) : -Infinity;
  const maxCommitMs = validTimestamps.length ? Math.max(...validTimestamps) : Infinity;

  const sortedCommits = [...commits]
    .map((c, origIdx) => ({
      ...c,
      origIdx,
      files: (Array.isArray(c.files) ? c.files : []).map((f) => ({
        filePath: sanitizeRelativeRepoPath(f.filePath, cwd),
        additions: Number(f.additions || 0),
        deletions: Number(f.deletions || 0)
      }))
    }))
    .sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));

  for (const c of sortedCommits) {
    if (!c.totalLoc) {
      c.totalAdditions = c.files.reduce((s, f) => s + f.additions, 0);
      c.totalDeletions = c.files.reduce((s, f) => s + f.deletions, 0);
      c.totalLoc = c.totalAdditions + c.totalDeletions;
    }
  }

  // Filter ledger savings entries into PR window when timestamps are available
  const matchingLedger = rawLedger.filter((entry) => {
    const rawTs = entry.timestamp ?? entry.ts ?? null;
    const tsMs = typeof rawTs === 'number' ? rawTs : rawTs ? Date.parse(String(rawTs)) : NaN;
    if (!Number.isFinite(tsMs) || !validTimestamps.length) return true;
    return tsMs >= minCommitMs - 30 * 60 * 1000 && tsMs <= maxCommitMs + 15 * 60 * 1000;
  });

  const ledgerSavedUsd = matchingLedger.reduce((s, e) => s + Number(e.savedUSD ?? e.savedUsd ?? 0), 0);

  // Assign each step to the best single commit (disjoint attribution so branch total is never inflated)
  const commitBuckets = new Map(sortedCommits.map((_, idx) => [idx, []]));
  const totalBranchLoc = sortedCommits.reduce((s, c) => s + Math.max(1, c.totalLoc || 0), 0);

  let unmatchedIn = 0;
  let unmatchedCache = 0;
  let unmatchedOut = 0;
  let unmatchedWaste = 0;
  let unmatchedRing0 = 0;

  for (const st of normalizedSteps) {
    let assignedIdx = -1;

    // 1. Prefer timestamp-interval correlation when both commits and step carry valid timestamps
    if (st.tsMs !== null && validTimestamps.length > 0) {
      const windowStart = minCommitMs - 30 * 60 * 1000;
      const windowEnd = maxCommitMs + 15 * 60 * 1000;
      if (st.tsMs < windowStart || st.tsMs > windowEnd) {
        continue; // Step outside this branch's PR window
      }
      for (let i = 0; i < sortedCommits.length; i++) {
        const prevMs = i > 0 ? sortedCommits[i - 1].timestampMs : windowStart;
        const curMs =
          i === sortedCommits.length - 1
            ? Math.max(sortedCommits[i].timestampMs, windowEnd)
            : sortedCommits[i].timestampMs;
        if (st.tsMs >= prevMs && st.tsMs <= curMs) {
          assignedIdx = i;
          break;
        }
      }
    }

    // 2. Fallback to file path overlap when timestamps are absent
    if (assignedIdx === -1 && st.filesTouched.length > 0 && sortedCommits.length > 0) {
      assignedIdx = sortedCommits.findIndex((c) =>
        c.files.some((cf) => st.filesTouched.includes(cf.filePath))
      );
    }

    if (assignedIdx >= 0) {
      commitBuckets.get(assignedIdx).push(st);
    } else if (sortedCommits.length > 0 && st.tsMs === null) {
      unmatchedIn += st.inTok;
      unmatchedCache += st.cacheReadTok;
      unmatchedOut += st.outTok;
      unmatchedWaste += st.wasteTok;
      if (st.isRing0) unmatchedRing0 += 1;
    }
  }

  const fileAggMap = new Map();
  let sumIn = 0;
  let sumCache = 0;
  let sumOut = 0;
  let sumWaste = 0;
  let sumRing0 = unmatchedRing0;

  const commitRows = sortedCommits.map((c, idx) => {
    const bucket = commitBuckets.get(idx) || [];
    const locShare = totalBranchLoc > 0 ? Math.max(1, c.totalLoc || 0) / totalBranchLoc : 0;

    const cIn = bucket.reduce((s, st) => s + st.inTok, 0) + Math.round(unmatchedIn * locShare);
    const cCache = bucket.reduce((s, st) => s + st.cacheReadTok, 0) + Math.round(unmatchedCache * locShare);
    const cOut = bucket.reduce((s, st) => s + st.outTok, 0) + Math.round(unmatchedOut * locShare);
    const cWaste = bucket.reduce((s, st) => s + st.wasteTok, 0) + Math.round(unmatchedWaste * locShare);
    const cRing0 = bucket.filter((st) => st.isRing0).length;
    const cTotal = cIn + cCache + cOut;
    const cDenom = cIn + cCache;
    const cHitPct = cDenom > 0 ? Math.round((cCache / cDenom) * 100) : 0;
    const cCostUsd = Number(computeStepCostUsd(cIn, cCache, cOut, pricePerMillionUsd).toFixed(4));

    sumIn += cIn;
    sumCache += cCache;
    sumOut += cOut;
    sumWaste += cWaste;
    sumRing0 += cRing0;

    // Distribute commit cost across modified files proportionally to file LOC
    const fileLocSum = c.files.reduce((s, f) => s + Math.max(1, f.additions + f.deletions), 0);
    for (const f of c.files) {
      const share = fileLocSum > 0 ? Math.max(1, f.additions + f.deletions) / fileLocSum : 0;
      const cur = fileAggMap.get(f.filePath) || {
        filePath: f.filePath,
        commits: 0,
        additions: 0,
        deletions: 0,
        attributedTokens: 0,
        estimatedCostUsd: 0
      };
      cur.commits += 1;
      cur.additions += f.additions;
      cur.deletions += f.deletions;
      cur.attributedTokens += Math.round(cTotal * share);
      cur.estimatedCostUsd = Number((cur.estimatedCostUsd + cCostUsd * share).toFixed(4));
      fileAggMap.set(f.filePath, cur);
    }

    return {
      sha: c.sha,
      shortSha: c.shortSha,
      timestampIso: c.timestampIso,
      author: c.author,
      subject: c.subject,
      filesChanged: c.files.length,
      additions: c.totalAdditions,
      deletions: c.totalDeletions,
      attributedTokens: cTotal,
      inputTokens: cIn,
      cacheReadTokens: cCache,
      outputTokens: cOut,
      wasteTokens: cWaste,
      cacheHitPct: cHitPct,
      estimatedCostUsd: cCostUsd,
      ring0Violations: cRing0
    };
  });

  const totalTokens = sumIn + sumCache + sumOut;
  const cacheDenom = sumIn + sumCache;
  const cacheHitPct = cacheDenom > 0 ? Math.round((sumCache / cacheDenom) * 100) : 0;
  const estimatedCostUsd = Number(computeStepCostUsd(sumIn, sumCache, sumOut, pricePerMillionUsd).toFixed(4));
  const wasteRatioPct = totalTokens > 0 ? Math.round((sumWaste / totalTokens) * 100) : 0;
  const uniqueFiles = new Set(commitRows.flatMap((_, idx) => sortedCommits[idx].files.map((f) => f.filePath)));
  const totalAdditions = sortedCommits.reduce((s, c) => s + c.totalAdditions, 0);
  const totalDeletions = sortedCommits.reduce((s, c) => s + c.totalDeletions, 0);
  const totalLoc = totalAdditions + totalDeletions;
  const usdPer100Loc = totalLoc > 0 ? Number(((estimatedCostUsd / totalLoc) * 100).toFixed(4)) : 0;

  const topCostFiles = Array.from(fileAggMap.values())
    .sort((a, b) => b.attributedTokens - a.attributedTokens || b.estimatedCostUsd - a.estimatedCostUsd)
    .slice(0, 10);

  return {
    ok: true,
    format: PR_ATTRIBUTION_FORMAT,
    generatedAt: new Date().toISOString(),
    base,
    head,
    fallbackUsed,
    summary: {
      totalCommits: commitRows.length,
      totalFilesChanged: uniqueFiles.size,
      totalAdditions,
      totalDeletions,
      totalLoc,
      totalInputTokens: sumIn,
      totalCacheReadTokens: sumCache,
      totalOutputTokens: sumOut,
      totalTokens,
      cacheHitPct,
      estimatedCostUsd,
      estimatedSavedUsd: Number(ledgerSavedUsd.toFixed(4)),
      estimatedWasteTokens: sumWaste,
      wasteRatioPct,
      ring0Violations: sumRing0,
      usdPer100Loc
    },
    commits: commitRows,
    topCostFiles,
    entitlement
  };
}

/**
 * Formats PR cost attribution as clean PR comment Markdown with zero local paths.
 */
export function formatPrAttributionMarkdown(report = {}) {
  const s = report.summary || {};
  const lines = [
    `### Highbeam PR Token & Cost Attribution (\`${report.base || 'main'}..${report.head || 'HEAD'}\`)`,
    '',
    '| Metric | Value |',
    '| :--- | :--- |',
    `| **Commits / Files Changed** | \`${s.totalCommits ?? 0}\` commits · \`${s.totalFilesChanged ?? 0}\` files (\`+${s.totalAdditions ?? 0} / -${s.totalDeletions ?? 0}\`) |`,
    `| **Total Attributed Tokens** | \`${((s.totalTokens || 0) / 1000).toFixed(1)}k\` |`,
    `| **Cache Hit Rate** | \`${s.cacheHitPct ?? 0}%\` |`,
    `| **Estimated PR AI Cost** | \`$${Number(s.estimatedCostUsd || 0).toFixed(4)}\` (\`$${Number(s.usdPer100Loc || 0).toFixed(4)} / 100 LOC\`) |`,
    `| **Preventable Waste Ratio** | \`${s.wasteRatioPct ?? 0}%\` (\`${((s.estimatedWasteTokens || 0) / 1000).toFixed(1)}k\` tok) |`,
    `| **Estimated Saved USD** | \`$${Number(s.estimatedSavedUsd || 0).toFixed(4)}\` |`,
    `| **Ring-0 Violations** | \`${s.ring0Violations ?? 0}\` |`
  ];

  if (Array.isArray(report.topCostFiles) && report.topCostFiles.length > 0) {
    lines.push('', '#### Top Cost-Driver Files', '', '| File | LOC Changed | Attributed Tokens | Est. Cost |', '| :--- | :---: | :---: | :---: |');
    for (const f of report.topCostFiles) {
      lines.push(
        `| \`${f.filePath}\` | \`+${f.additions}/-${f.deletions}\` | \`${(f.attributedTokens / 1000).toFixed(1)}k\` | \`$${Number(f.estimatedCostUsd || 0).toFixed(4)}\` |`
      );
    }
  }

  if (Array.isArray(report.commits) && report.commits.length > 0) {
    lines.push('', '#### Commit Attribution Breakdown', '', '| Commit | Subject | Tokens | Cache Hit | Est. Cost |', '| :--- | :--- | :---: | :---: | :---: |');
    for (const c of report.commits) {
      lines.push(
        `| \`${c.shortSha}\` | ${String(c.subject || '').replace(/\|/g, '\\|')} | \`${(c.attributedTokens / 1000).toFixed(1)}k\` | \`${c.cacheHitPct}%\` | \`$${Number(c.estimatedCostUsd || 0).toFixed(4)}\` |`
      );
    }
  }

  return lines.join('\n') + '\n';
}
