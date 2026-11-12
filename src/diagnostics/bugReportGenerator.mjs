/**
 * @file src/diagnostics/bugReportGenerator.mjs
 * Zero-PII GitHub Issue Diagnostic Bundle (`IDEA-02` — `doctor --diagnostic`)
 * and Git-Commit / Session Efficiency Receipt Exporter (`IDEA-04` — `receipt --markdown`).
 *
 * Uses pure `fs` inspection (`.git/HEAD`) with zero subprocess or network calls.
 */

import { fs, path, os } from '../utils/nodeIo.mjs';
import { loadHorizonConfig } from '../core-isomorphic/config/horizonConfig.mjs';
import { getSavedQuotaReceiptSummary } from '../core-isomorphic/coach/savedQuotaLedger.mjs';
import { loadRepoCalibration, getTopChronicReadFiles } from '../core-isomorphic/coach/repoCalibration.mjs';
import { inspectHookDiagnostics } from './doctorEngine.mjs';

/**
 * Redacts the user's OS home directory and username from any diagnostic string.
 * @param {string} text
 * @param {string} [homeDir]
 * @returns {string}
 */
export function redactUserPaths(text, homeDir) {
  const raw = String(text || '');
  const home = homeDir || os?.homedir?.() || '';
  if (!home) return raw;
  const escapedWin = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const posixHome = home.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw
    .replace(new RegExp(escapedWin, 'gi'), '~')
    .replace(new RegExp(posixHome, 'gi'), '~');
}

/**
 * Resolves the current Git branch and short HEAD commit hash via pure read-only `.git/HEAD` inspection.
 * Never spawns a child process.
 *
 * @param {string} [cwd='.']
 * @returns {{ branch: string, shortCommit: string, isGitRepo: boolean }}
 */
export function resolveGitHeadMetadata(cwd = '.') {
  if (!fs || !path) {
    return { branch: 'detached', shortCommit: 'none', isGitRepo: false };
  }
  try {
    const gitDir = path.join(cwd, '.git');
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) {
      return { branch: 'untracked', shortCommit: 'none', isGitRepo: false };
    }
    const headRaw = fs.readFileSync(headPath, 'utf-8').trim();
    if (headRaw.startsWith('ref:')) {
      const refRel = headRaw.replace(/^ref:\s*/, '').trim();
      const branch = refRel.replace(/^refs\/heads\//, '');
      const refFullPath = path.join(gitDir, ...refRel.split('/'));
      if (fs.existsSync(refFullPath)) {
        const sha = fs.readFileSync(refFullPath, 'utf-8').trim();
        return {
          branch,
          shortCommit: sha.slice(0, 7) || 'HEAD',
          isGitRepo: true
        };
      }
      return { branch, shortCommit: 'HEAD', isGitRepo: true };
    }
    return {
      branch: 'detached',
      shortCommit: headRaw.slice(0, 7) || 'HEAD',
      isGitRepo: true
    };
  } catch (_err) {
    return { branch: 'unknown', shortCommit: 'none', isGitRepo: false };
  }
}

/**
 * Generates a 100% Zero-PII Markdown diagnostic bundle for GitHub issue reporting (`ah-claude doctor --diagnostic`).
 *
 * @param {object} doctorResult - Result from `runDoctorDiagnostics`
 * @param {object} [options={}]
 * @returns {{
 *   ok: boolean,
 *   environment: object,
 *   configSummary: object,
 *   checks: Array<object>,
 *   markdown: string
 * }}
 */
export function generateZeroPiiDiagnosticBundle(doctorResult, options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const homeDir = options.homeDir || os?.homedir?.() || '';
  const config = loadHorizonConfig({ ...options, cwd, homeDir });
  const calibration = loadRepoCalibration({ ...options, cwd });

  const platform = globalThis.process?.platform || 'unknown';
  const arch = globalThis.process?.arch || 'unknown';
  const nodeVersion = doctorResult?.nodeVersion || globalThis.process?.versions?.node || 'unknown';
  const latencyTier =
    platform === 'win32'
      ? 'Tier-1 V8 Mod (~0.05ms, <0.1ms) | Tier-2 Win11 PowerShell (~40-90ms Node ESM CLI spawn)'
      : 'Tier-1 V8 Mod (~0.05ms, <0.1ms) | Tier-2 POSIX (~5ms minimal shell / ~15-35ms Node ESM CLI cold-start)';

  const activeOverrides = Object.entries(config.detectors || {})
    .filter(([, mode]) => mode !== 'default')
    .map(([id, mode]) => `${id}=${mode}`);

  const sanitizedChecks = (doctorResult?.checks || []).map((c) => ({
    id: c.id,
    ok: Boolean(c.ok),
    detail: redactUserPaths(c.detail, homeDir)
  }));

  const rawHookDiag =
    doctorResult?.hookDiagnostics || inspectHookDiagnostics({ ...options, cwd, homeDir });
  const hookDiagnostics = {
    diagnosticsPath: redactUserPaths(rawHookDiag.diagnosticsPath || '', homeDir),
    recentErrorCount: Number(rawHookDiag.recentErrorCount || 0),
    recentErrors: (rawHookDiag.recentErrors || []).slice(-5).map((entry) => ({
      timestamp: String(entry.timestamp || ''),
      source: String(entry.source || 'unknown'),
      operation: String(entry.operation || 'unknown'),
      name: String(entry.name || 'Error'),
      message: redactUserPaths(entry.message || '', homeDir).slice(0, 300)
    }))
  };

  const environment = {
    edition: 'attention-horizon-claude',
    version: '1.0.0',
    platform,
    arch,
    nodeVersion: `v${nodeVersion}`,
    latencyTier,
    networkProfile: 'ZERO_SOCKET_100%_LOCAL'
  };

  const configSummary = {
    flightMode: config.flightMode,
    projectConfigLoaded: config.sources.projectLoaded,
    globalConfigLoaded: config.sources.globalLoaded,
    detectorOverrides: activeOverrides,
    calibratedSessionsCompacted: calibration.compactions.count,
    empiricalCacheHitRatio: calibration.cachePerformance.empiricalHitRatio,
    recentHookErrorCount: hookDiagnostics.recentErrorCount
  };

  const recentErrorLines =
    hookDiagnostics.recentErrors.length > 0
      ? hookDiagnostics.recentErrors.map(
          (e) =>
            `- \`[${e.timestamp}]\` **\`${e.source}#${e.operation}\`** (\`${e.name}\`): ${e.message}`
        )
      : ['- *(0 recent runtime errors recorded)*'];

  const mdLines = [
    '### Attention Horizon — Zero-PII Diagnostic Report',
    '',
    '| Field | Value |',
    '| :--- | :--- |',
    `| **Package** | \`${environment.edition}@${environment.version}\` |`,
    `| **OS / Arch** | \`${platform} (${arch})\` |`,
    `| **Node.js** | \`${environment.nodeVersion}\` |`,
    `| **Flight Mode** | \`${configSummary.flightMode}\` |`,
    `| **Detector Overrides** | \`${activeOverrides.length > 0 ? activeOverrides.join(', ') : 'none (all 20 default)'}\` |`,
    `| **Recent Hook Errors** | \`${hookDiagnostics.recentErrorCount}\` |`,
    `| **Latency Profile** | ${latencyTier} |`,
    `| **Doctor Contract Status** | **${doctorResult?.ok ? 'ALL PASS' : 'ISSUES DETECTED'}** (${sanitizedChecks.filter((c) => c.ok).length}/${sanitizedChecks.length}) |`,
    '',
    '#### Contract Self-Check Matrix',
    ...sanitizedChecks.map(
      (c) => `- [${c.ok ? 'x' : ' '}] **\`${c.id}\`**: ${c.detail}`
    ),
    '',
    '#### Recent Runtime Diagnostics (`ah_diagnostics.jsonl`)',
    ...recentErrorLines
  ];

  return {
    ok: Boolean(doctorResult?.ok),
    environment,
    configSummary,
    checks: sanitizedChecks,
    hookDiagnostics,
    markdown: mdLines.join('\n')
  };
}

/**
 * Generates a shareable Git-Commit & Session Efficiency Receipt (`ah-claude receipt --markdown` / `--json`).
 *
 * @param {object} [options={}]
 * @returns {{
 *   git: { branch: string, shortCommit: string, isGitRepo: boolean },
 *   summary: object,
 *   chronicFiles: Array<object>,
 *   markdown: string
 * }}
 */
export function generateGitCommitEfficiencyReceipt(options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const git = resolveGitHeadMetadata(cwd);
  const summary = getSavedQuotaReceiptSummary(options);
  const chronicFiles = getTopChronicReadFiles({ ...options, cwd, limit: 3 });
  const calibration = loadRepoCalibration({ ...options, cwd });

  const categoryRows = Object.entries(summary.byCategory || {});
  const catTableLines =
    categoryRows.length > 0
      ? categoryRows.map(
          ([cat, info]) =>
            `| \`${cat}\` | ${info.count} | ${info.savedTokens.toLocaleString()} tok | \`$${info.savedUSD.toFixed(4)}\` |`
        )
      : ['| `NONE_YET` | 0 | 0 tok | `$0.0000` |'];

  const mdLines = [
    `### Attention Horizon — Session & Git Efficiency Receipt (\`${git.branch}@${git.shortCommit}\`)`,
    '',
    '| Metric | Verified Value |',
    '| :--- | :--- |',
    `| **Git Context** | \`${git.branch}\` (\`${git.shortCommit}\`) |`,
    `| **Total Saved Tokens** | **${summary.totalSavedTokens.toLocaleString()} tok** |`,
    `| **Total Verified Savings (USD)** | **\`$${summary.totalSavedUSD.toFixed(4)}\`** (${summary.entryCount} ledger events) |`,
    `| **Empirical Cache-Hit Baseline** | \`${(calibration.cachePerformance.empiricalHitRatio * 100).toFixed(1)}%\` (${calibration.cachePerformance.warmHitTurns}/${calibration.cachePerformance.totalTurns} turns) |`,
    '',
    '#### Savings Breakdown by Ledger Category',
    '| Category | Events | Saved Tokens | Verified USD |',
    '| :--- | :---: | :---: | :---: |',
    ...catTableLines
  ];

  if (chronicFiles.length > 0) {
    mdLines.push(
      '',
      '#### Top Repo Context-Sink Hotspots (Calibrated)',
      ...chronicFiles.map(
        (f) =>
          `- \`${f.fileKey}\`: read **${f.readCount}x** across ${f.sessionCount} session(s) (~${f.totalEstimatedTokens.toLocaleString()} tok)`
      )
    );
  }

  return {
    git,
    summary,
    chronicFiles,
    markdown: mdLines.join('\n')
  };
}

export default {
  redactUserPaths,
  resolveGitHeadMetadata,
  generateZeroPiiDiagnosticBundle,
  generateGitCommitEfficiencyReceipt
};
