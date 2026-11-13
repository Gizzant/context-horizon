#!/usr/bin/env node
/**
 * @file bin/ctxtop.mjs
 * Attention Horizon v4.0 Unified Cross-Platform CLI (`ctxtop`).
 *
 * Commands:
 *   - `ctxtop init [--antigravity | --claude | --all | --workspace | --project | --dry-run | --dedupe]`
 *   - `ctxtop install [--global | --project]`
 *   - `ctxtop uninstall [--global | --project]`
 *   - `ctxtop doctor [--diagnostic | --json]`
 *   - `ctxtop receipt [--advanced | --markdown | --json]`
 *   - `ctxtop config [list | set <DET-ID> <mode> | reset]`
 *   - `ctxtop cost-radar [--out <file.html>] [--json]`
 *   - `ctxtop panel [--advanced] [--out <file.html>]`
 *   - `ctxtop statusline [--demo]`
 *   - `ctxtop postmortem [--last N]`
 */

import {
  fs,
  path,
  os,
  url,
  fileURLToPath,
  readJsonSafe,
  writeTextAtomic,
  writeJsonAtomic
} from '../src/utils/nodeIo.mjs';
import {
  loadHorizonConfig,
  setDetectorOverride,
  resetHorizonConfig
} from '../src/core-isomorphic/config/horizonConfig.mjs';
import {
  readLiveStateSnapshot,
  sanitizeSessionId,
  getLiveStateBridgePath
} from '../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import {
  normalizeSessionTrajectory,
  normalizeAntigravitySession,
  normalizeClaudeCodeSession,
  createEmptyUstfSession
} from '../src/core-isomorphic/ustf/index.mjs';
import {
  getHomeDir,
  getBrainStores,
  getAntigravitySurfaces
} from '../src/core/paths.mjs';
import { runPostmortem, printPostmortemSummary } from '../src/cli/postmortem.mjs';
import { runDoctor, parseDoctorArgs } from '../src/cli/doctor.mjs';
import { getSavedQuotaReceiptSummary } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  renderSimpleViewPane,
  renderSimpleHudPane,
  renderAdvancedViewPane
} from '../src/core-isomorphic/ui/modViews.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { renderCostRadarHtml } from '../src/core-isomorphic/ui/costRadarSvg.mjs';
import {
  generateCorporateExpenseReceipt,
  sha256HexPure
} from '../src/core-isomorphic/ui/pdfReceiptGenerator.mjs';
import {
  activateProLicense,
  activateLocalTrial,
  deactivateProLicense,
  getProEntitlementStatus,
  requireProFeature,
  verifyProLicenseKey,
  PLG_TIER_MATRIX
} from '../src/core/pro_license.mjs';
import { generateTeamFinopsPack } from '../packages/pro/src/team_finops_pack.mjs';
import {
  computeSwarmSummary,
  toCostRadarTopology,
  formatSwarmCompact
} from '../src/core-isomorphic/telemetry/swarmTopology.mjs';
import {
  formatRetentionLabel,
  formatDriftLabel
} from '../src/core-isomorphic/telemetry/sprintMetrics.mjs';
import {
  transitionControlState,
  serializeControlFile,
  parseControlFile
} from '../src/core-isomorphic/control/index.mjs';
import { MicroIpcClient } from '../src/engine-node/ipc/client.mjs';
import {
  generateZeroPiiDiagnosticBundle,
  generateGitCommitEfficiencyReceipt
} from '../src/diagnostics/bugReportGenerator.mjs';
import {
  inspectHookDiagnostics,
  runDoctorDiagnostics
} from '../src/diagnostics/doctorEngine.mjs';
import { installPlugin, runLiveOrDemoCli } from '../src/cli/init.mjs';
import { executeStatusLineBridge, runStatusLineCli } from './ah-statusline.mjs';

export { inspectHookDiagnostics, runDoctorDiagnostics };

export const PKG_ROOT = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  .replace(/\\/g, '/');

export const PRE_TOOL_USE_MATCHER =
  'Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|Task|Agent|WebFetch|mcp__.*';
export const POST_TOOL_USE_MATCHER =
  'Bash|PowerShell|Grep|Glob|Task|Agent|WebFetch|mcp__.*';
export const LEAN_PRE_TOOL_USE_MATCHER =
  'Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Task|Agent|WebFetch|mcp__.*';
export const LEAN_POST_TOOL_USE_MATCHER =
  'Bash|PowerShell|Task|Agent|WebFetch|mcp__.*';

const AH_HANDLER_REGEX =
  /hooks[\\/]handlers[\\/](pre-tool-use|post-tool-use|pre-model-switch|compact-lifecycle|stop-gate)\.mjs/i;
const AH_STATUSLINE_REGEX = /ah-statusline\.mjs/i;
const AH_MOD_REGISTER_REGEX = /(?:^|[\\/])hooks[\\/]register\.js$|^\.\/register\.js$/i;

/**
 * Extracts the Attention Horizon command string from either a nested (`{ hooks: [{ command }] }`)
 * or legacy flat (`{ command }`) hook entry.
 *
 * @param {object} entry
 * @returns {string}
 */
export function extractAhCommandFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.command === 'string' && AH_HANDLER_REGEX.test(entry.command)) {
    return entry.command;
  }
  if (Array.isArray(entry.hooks)) {
    const found = entry.hooks.find((inner) =>
      AH_HANDLER_REGEX.test(String(inner?.command || ''))
    );
    if (found) return String(found.command || '');
  }
  return '';
}

/**
 * Builds canonical nested Claude Code hook entries using either `${CLAUDE_PLUGIN_ROOT}`
 * (when `usePluginRootVar: true`) or double-quoted absolute `${pkgRoot}` paths.
 *
 * @param {object} [options={}]
 * @returns {Record<string, Array<object>>}
 */
export function buildCanonicalAhHooks(options = {}) {
  const rootPrefix = options.usePluginRootVar
    ? '${CLAUDE_PLUGIN_ROOT}'
    : options.pkgRoot
      ? String(options.pkgRoot).replace(/\\/g, '/').replace(/\/+$/, '')
      : PKG_ROOT;

  const handlerPrefix = `${rootPrefix}/hooks/handlers`;
  const preMatcher = options.leanHooks ? LEAN_PRE_TOOL_USE_MATCHER : PRE_TOOL_USE_MATCHER;
  const postMatcher = options.leanHooks ? LEAN_POST_TOOL_USE_MATCHER : POST_TOOL_USE_MATCHER;

  return {
    PreToolUse: [
      {
        matcher: preMatcher,
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/pre-tool-use.mjs"`
          }
        ]
      }
    ],
    PostToolUse: [
      {
        matcher: postMatcher,
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/post-tool-use.mjs"`
          }
        ]
      }
    ],
    PreModelSwitch: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/pre-model-switch.mjs"`
          }
        ]
      }
    ],
    PreCompact: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/compact-lifecycle.mjs" --phase=pre`
          }
        ]
      }
    ],
    PostCompact: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/compact-lifecycle.mjs" --phase=post`
          }
        ]
      }
    ],
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact|fork',
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/compact-lifecycle.mjs" --phase=start`
          }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/stop-gate.mjs"`
          }
        ]
      }
    ]
  };
}

export const CANONICAL_AH_HOOKS = Object.freeze(buildCanonicalAhHooks({ usePluginRootVar: false }));

export function isAttentionHorizonHookEntry(entry) {
  return Boolean(extractAhCommandFromEntry(entry));
}

export function resolveSettingsPath(options = {}) {
  if (typeof options.settingsPath === 'string' && options.settingsPath.trim()) {
    return options.settingsPath.trim();
  }
  const scope = options.scope === 'global' || options.global ? 'global' : 'project';
  if (scope === 'global') {
    const home = options.homeDir || os.homedir() || '.';
    return path.join(home, '.claude', 'settings.json');
  }
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  return path.join(cwd, '.claude', 'settings.json');
}

export function ensureGitExcludeEntries(cwd) {
  const gitDir = path.join(cwd, '.git');
  if (!fs.existsSync(gitDir)) {
    return { updated: false, excludePath: null };
  }

  try {
    const infoDir = path.join(gitDir, 'info');
    if (!fs.existsSync(infoDir)) {
      fs.mkdirSync(infoDir, { recursive: true });
    }
    const excludePath = path.join(infoDir, 'exclude');
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    const required = ['.claude/cache/', '.claude/locks/'];
    let appended = false;
    let nextContent = existing;

    for (const req of required) {
      if (!lines.some((line) => line.trim() === req)) {
        if (nextContent.length > 0 && !nextContent.endsWith('\n')) {
          nextContent += '\n';
        }
        nextContent += `${req}\n`;
        appended = true;
      }
    }

    if (appended) {
      writeTextAtomic(excludePath, nextContent);
    }
    return { updated: appended, excludePath };
  } catch (_err) {
    return { updated: false, excludePath: null };
  }
}

export function installAttentionHorizon(options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const pkgRoot = options.pkgRoot
    ? String(options.pkgRoot).replace(/\\/g, '/').replace(/\/+$/, '')
    : PKG_ROOT;
  const settingsPath = resolveSettingsPath(options);
  const ts = options.timestamp || Date.now();
  const dryRun = Boolean(options.dryRun);

  let backupPath = null;
  let currentSettings = {};

  if (fs.existsSync(settingsPath)) {
    backupPath = `${settingsPath}.ah-backup.${ts}`;
    if (!dryRun) {
      fs.copyFileSync(settingsPath, backupPath);
    }
    const parsed = readJsonSafe(settingsPath, {});
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      currentSettings = JSON.parse(JSON.stringify(parsed));
    }
  }

  if (!currentSettings.hooks || typeof currentSettings.hooks !== 'object') {
    currentSettings.hooks = {};
  }

  const canonicalRegisterPath = `${pkgRoot}/hooks/register.js`;
  const existingModules = Array.isArray(currentSettings.hooks.modules)
    ? [...currentSettings.hooks.modules]
    : [];
  const modIdx = existingModules.findIndex((m) => AH_MOD_REGISTER_REGEX.test(String(m)));
  if (modIdx >= 0) {
    existingModules[modIdx] = canonicalRegisterPath;
  } else {
    existingModules.push(canonicalRegisterPath);
  }
  currentSettings.hooks.modules = existingModules;

  const useLeanHooks =
    options.leanHooks !== undefined ? Boolean(options.leanHooks) : !Boolean(options.fullHooks);
  const canonicalHooks = buildCanonicalAhHooks({
    usePluginRootVar: false,
    pkgRoot,
    leanHooks: useLeanHooks
  });
  for (const [eventName, ahEntries] of Object.entries(canonicalHooks)) {
    const existingList = Array.isArray(currentSettings.hooks[eventName])
      ? [...currentSettings.hooks[eventName]]
      : [];

    for (const ahEntry of ahEntries) {
      const targetCmd = ahEntry.hooks[0].command;
      const targetHandlerMatch = targetCmd.match(AH_HANDLER_REGEX);
      const targetHandlerName = targetHandlerMatch ? targetHandlerMatch[1].toLowerCase() : '';
      const targetPhaseMatch = targetCmd.match(/--phase=([a-z]+)/i);
      const targetPhase = targetPhaseMatch ? targetPhaseMatch[1].toLowerCase() : '';

      const idx = existingList.findIndex((item) => {
        const existingCmd = extractAhCommandFromEntry(item);
        if (!existingCmd) return false;
        const m = existingCmd.match(AH_HANDLER_REGEX);
        const name = m ? m[1].toLowerCase() : '';
        const pm = existingCmd.match(/--phase=([a-z]+)/i);
        const phase = pm ? pm[1].toLowerCase() : '';
        return name === targetHandlerName && phase === targetPhase;
      });

      const clonedEntry = JSON.parse(JSON.stringify(ahEntry));
      if (idx >= 0) {
        existingList[idx] = clonedEntry;
      } else {
        existingList.push(clonedEntry);
      }
    }

    currentSettings.hooks[eventName] = existingList;
  }

  const ahStatusLine = {
    type: 'command',
    command: `node "${pkgRoot}/bin/ah-statusline.mjs"`
  };
  if (!currentSettings.statusLine) {
    currentSettings.statusLine = ahStatusLine;
  } else if (
    typeof currentSettings.statusLine === 'object' &&
    !AH_STATUSLINE_REGEX.test(String(currentSettings.statusLine.command || ''))
  ) {
    currentSettings.ahPreviousStatusLine = currentSettings.statusLine;
    currentSettings.statusLine = ahStatusLine;
  } else {
    currentSettings.statusLine = ahStatusLine;
  }

  let ok = true;
  if (!dryRun) {
    ok = writeJsonAtomic(settingsPath, currentSettings);
  }
  const gitExclude = dryRun ? { updated: false } : ensureGitExcludeEntries(cwd);

  return {
    ok,
    settingsPath,
    backupPath,
    gitExcludeUpdated: gitExclude.updated,
    settings: currentSettings
  };
}

export function uninstallAttentionHorizon(options = {}) {
  const settingsPath = resolveSettingsPath(options);
  if (!fs.existsSync(settingsPath)) {
    return {
      ok: true,
      settingsPath,
      removedHooksCount: 0,
      settings: {}
    };
  }

  const currentSettings = readJsonSafe(settingsPath, {});
  let removedHooksCount = 0;

  if (currentSettings.hooks && typeof currentSettings.hooks === 'object') {
    if (Array.isArray(currentSettings.hooks.modules)) {
      const before = currentSettings.hooks.modules.length;
      currentSettings.hooks.modules = currentSettings.hooks.modules.filter(
        (m) => !AH_MOD_REGISTER_REGEX.test(String(m))
      );
      removedHooksCount += before - currentSettings.hooks.modules.length;
      if (currentSettings.hooks.modules.length === 0) {
        delete currentSettings.hooks.modules;
      }
    }

    for (const eventName of Object.keys(CANONICAL_AH_HOOKS)) {
      if (Array.isArray(currentSettings.hooks[eventName])) {
        const before = currentSettings.hooks[eventName].length;
        currentSettings.hooks[eventName] = currentSettings.hooks[eventName].filter(
          (entry) => !isAttentionHorizonHookEntry(entry)
        );
        removedHooksCount += before - currentSettings.hooks[eventName].length;
        if (currentSettings.hooks[eventName].length === 0) {
          delete currentSettings.hooks[eventName];
        }
      }
    }
  }

  if (
    currentSettings.statusLine &&
    AH_STATUSLINE_REGEX.test(String(currentSettings.statusLine.command || ''))
  ) {
    if (currentSettings.ahPreviousStatusLine) {
      currentSettings.statusLine = currentSettings.ahPreviousStatusLine;
      delete currentSettings.ahPreviousStatusLine;
    } else {
      delete currentSettings.statusLine;
    }
  }

  const ok = writeJsonAtomic(settingsPath, currentSettings);
  return {
    ok,
    settingsPath,
    removedHooksCount,
    settings: currentSettings
  };
}

export function generateReceiptReport(options = {}) {
  const sessionId = options.sessionId || 'default';
  const state = options.state || readLiveStateSnapshot(sessionId, options);
  const summary = getSavedQuotaReceiptSummary(options);
  const renderOpts = {
    ...options,
    ledgerSummary: summary
  };
  const pane = options.advanced
    ? renderAdvancedViewPane(state, renderOpts)
    : options.fourRank
      ? renderSimpleHudPane(state, renderOpts)
      : renderSimpleViewPane(state, renderOpts);
  const gitReceipt = generateGitCommitEfficiencyReceipt(options);
  const corporateReceipt = generateCorporateExpenseReceipt(summary, options);

  return {
    summary,
    pane,
    gitReceipt,
    corporateReceipt,
    text: pane.text,
    markdown: gitReceipt.markdown,
    html: corporateReceipt.html,
    pdfBytes: corporateReceipt.pdfBytes
  };
}

export function generateRoastCard(options = {}) {
  const summary = getSavedQuotaReceiptSummary(options);
  const sessionId = options.sessionId || 'default';
  const live = options.state || readLiveStateSnapshot(sessionId, options) || {};
  const retentionPct = Number(live?.prefixRetention?.retentionIndexPct ?? (options.demo ? 74 : 92));
  const retentionGrade = live?.prefixRetention?.grade || (retentionPct >= 90 ? 'A' : retentionPct >= 75 ? 'B' : 'C');
  const savedTok = Math.max(Number(summary.workspace30dSavedTokens || 0), options.demo ? 142800 : 0);
  const savedUsd = Math.max(Number(summary.workspace30dSavedUSD || 0), options.demo ? 4.28 : 0);
  const leakedUsd = Number(live?.prefixRetention?.leakedColdPrefillUSD ?? (options.demo ? 1.85 : 0.12));

  const ascii = [
    '╭── 🔥 ATTENTION HORIZON CONTEXT ROAST (Claude Code + Antigravity) ──────────╮',
    `│ KV-Cache Retention : Grade ${retentionGrade} (${retentionPct}% prefix warmth retained)               │`,
    `│ Cold Prefill Leak  : $${leakedUsd.toFixed(2)} burned on avoidable cold-cache switches/edits    │`,
    `│ Verified Savings   : +${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)} USD saved in 30d)            │`,
    '│ Top Remediation    : Fence mid-session CLAUDE.md/AGENTS.md edits (DET-09)  │',
    '╰────────────────────────────────────────────────────────────────────────────╯',
    `Share: Shielded +${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)}) with npx ah-claude --roast #ClaudeCode #Antigravity`
  ].join('\n');

  const markdown = [
    '### 🔥 Attention Horizon Context Roast (`npx ah-claude --roast`)',
    `- **KV-Cache Retention**: Grade **${retentionGrade}** (${retentionPct}% warmth retained)`,
    `- **Cold Prefill Leak**: **$${leakedUsd.toFixed(2)}** burned on avoidable cold switches`,
    `- **30-Day Verified Savings**: **+${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)} USD)**`,
    `- **Top Fix**: Fence mid-session \`CLAUDE.md\` / \`AGENTS.md\` edits via \`DET-09\` & offload >4k CLI dumps.`
  ].join('\n');

  return {
    retentionPct,
    retentionGrade,
    leakedUsd,
    savedTok,
    savedUsd,
    ascii,
    markdown
  };
}

export function generateHorizonPanel(options = {}) {
  const sessionId = options.sessionId || 'default';
  const state = options.state || readLiveStateSnapshot(sessionId, options) || {};
  const ledgerSummary = options.ledgerSummary || getSavedQuotaReceiptSummary(options);
  const panel = renderHorizonPanelHtml(state, {
    ...options,
    ledgerSummary,
    initialView: options.advanced ? 'advanced' : options.initialView || 'simple'
  });
  const summary = {
    verdict: panel.verdict.headline,
    action: panel.priorityAction.title,
    sessionSavedTokens: panel.metrics.sessionSavedTokens,
    sessionSavedUSD: panel.metrics.sessionSavedUSD,
    workspace30dSavedTokens: panel.metrics.workspace30dSavedTokens,
    workspace30dSavedUSD: panel.metrics.workspace30dSavedUSD
  };
  return { html: panel.html, summary, state, panel };
}

export function generateCostRadar(options = {}) {
  const sessionId = options.sessionId || 'default';
  let state = options.state || readLiveStateSnapshot(sessionId, options) || {};
  if (options.demo && (!state.prefixRetention || !state.prefixRetention.measured)) {
    state = {
      ...state,
      prefixRetention: {
        measured: true,
        retentionIndexPct: 92,
        grade: 'A',
        retainedDiscountSavingsUSD: 1.5,
        leakedColdPrefillUSD: 0.12,
        measuredTurns: 5,
        bustCount: 0,
        timeline: []
      },
      thinkingDrift: {
        ratio: 1.2,
        loop: { triggered: false }
      }
    };
  }
  const swarm = computeSwarmSummary(state, { nowMs: options.nowMs || Date.now() });
  const html = renderCostRadarHtml({
    retention: state.prefixRetention || null,
    drift: state.thinkingDrift || null,
    topology: toCostRadarTopology(swarm),
    meta: {
      sessionTitle: state.sessionTitle || state.sessionId || '',
      model: state.modelLabel || state.modelId || '',
      edition: 'Cross-Platform',
      generatedAt: options.generatedAt || new Date().toISOString()
    }
  });
  const summary = {
    retention: formatRetentionLabel(state.prefixRetention),
    drift: formatDriftLabel(state.thinkingDrift),
    swarm: formatSwarmCompact(swarm) || 'Solo',
    loopTriggered: Boolean(state.thinkingDrift?.loop?.triggered)
  };
  return { html, summary, state };
}

/**
 * Unified `ctxtop init` installer router.
 * Supports `--antigravity`, `--claude`, `--all`, `--workspace`, `--project`, `--dry-run`, `--dedupe`.
 */
export function executeInitSubcommand(args = [], options = {}) {
  const isAntigravity = args.includes('--antigravity') || args.includes('-a');
  const isClaude = args.includes('--claude') || args.includes('-c');
  const isAll = args.includes('--all') || (!isAntigravity && !isClaude);
  const isDryRun = args.includes('--dry-run') || Boolean(options.dryRun);
  const isWorkspace = args.includes('--workspace') || args.includes('--project') || Boolean(options.workspace);
  const isGlobal = args.includes('--global') || Boolean(options.global);
  const isDedupe = args.includes('--dedupe') || Boolean(options.dedupe);
  const isLeanHooks = args.includes('--lean-hooks') || Boolean(options.leanHooks);
  const isFullHooks = args.includes('--full-hooks') || Boolean(options.fullHooks);

  const lines = [
    `\x1b[1m\x1b[38;5;51m⚡ Attention Horizon (ctxtop v4.0.0) — Zero-Config Unified Installer\x1b[0m`,
    `  • Target Harnesses : ${isAll ? 'Google Antigravity & Claude Code' : isAntigravity ? 'Google Antigravity' : 'Claude Code'}`,
    `  • Installation Scope: ${isWorkspace ? 'Workspace' : 'Global'}${isDryRun ? ' [DRY RUN]' : ''}`
  ];

  let claudeResult = null;
  let antigravityResult = null;

  if (isClaude || isAll) {
    const scope = isGlobal ? 'global' : 'project';
    const hasExplicitLeanArg = args.includes('--lean-hooks') || options.leanHooks !== undefined;
    claudeResult = installAttentionHorizon({
      ...options,
      scope,
      dryRun: isDryRun,
      ...(hasExplicitLeanArg ? { leanHooks: isLeanHooks } : {}),
      ...(isFullHooks ? { leanHooks: false, fullHooks: true } : {}),
      cwd: options.cwd || process.cwd()
    });
    const backupNote = claudeResult.backupPath
      ? ` (backup: ${path.basename(claudeResult.backupPath)})`
      : '';
    lines.push(
      `  \x1b[38;5;82m✓\x1b[0m Claude Code   : ${isDryRun ? '[DRY RUN] Would configure' : 'Configured'} ${claudeResult.settingsPath}${backupNote}`
    );
  }

  if (isAntigravity || isAll) {
    try {
      const agyInstall = installPlugin({
        dryRun: isDryRun,
        workspace: isWorkspace,
        dedupe: isDedupe,
        leanHooks: isLeanHooks,
        fullHooks: isFullHooks,
        cwd: options.cwd || process.cwd(),
        homeDir: options.homeDir || options.home
      });
      lines.push(
        `  \x1b[38;5;82m✓\x1b[0m Antigravity   : ${isDryRun ? '[DRY RUN] Would deploy plugin files & lifecycle hooks' : 'Deployed plugin files & lifecycle hooks'}`
      );
      antigravityResult = { ok: true, leanHooks: Boolean(agyInstall?.leanHooks) };
    } catch (err) {
      lines.push(`  \x1b[38;5;196m✖\x1b[0m Antigravity   : Failed — ${err.message}`);
      antigravityResult = { ok: false, error: err.message };
    }
  }

  const ok = (claudeResult ? claudeResult.ok : true) && (antigravityResult ? antigravityResult.ok : true);
  return {
    ok,
    exitCode: ok ? 0 : 1,
    output: lines.join('\n'),
    data: { claude: claudeResult, antigravity: antigravityResult, dryRun: isDryRun }
  };
}

export function runCli(args = [], options = {}) {
  const subcommand = String(args[0] || 'doctor').toLowerCase();
  const isGlobal = args.includes('--global') || args.includes('-g');
  const isJson = args.includes('--json') || Boolean(options.json);
  const isMarkdown = args.includes('--markdown') || args.includes('--md') || args.includes('--git');
  const isDiagnostic = args.includes('--diagnostic') || args.includes('--bug-report');
  const scope = isGlobal ? 'global' : 'project';

  if (args.includes('--version') || args.includes('-v') || subcommand === 'version') {
    return { exitCode: 0, output: '4.0.0', data: { version: '4.0.0' } };
  }

  if (subcommand === 'inspect') {
    const isLast = args.includes('--last') || args[1] === '--last' || Boolean(options.last);
    let sessionId = !isLast && args[1] && !args[1].startsWith('-') ? args[1] : options.sessionId || '';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--session' && args[i + 1]) {
        sessionId = args[i + 1];
        break;
      }
    }

    const outIdx = args.indexOf('--out');
    const outPath = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : options.out ? path.resolve(options.out) : null;
    const homeDir = options.homeDir || getHomeDir();
    const cwd = options.cwd || process.cwd();

    let foundData = null;
    let foundSource = null;

    // 1. Check live state cache (.claude/cache/ah_live_state_<sessionId>.json)
    if (sessionId && sessionId !== 'default') {
      const safeId = sanitizeSessionId(sessionId);
      const p1 = path.join(cwd, '.claude', 'cache', `ah_live_state_${safeId}.json`);
      const p2 = path.join(homeDir, '.claude', 'cache', `ah_live_state_${safeId}.json`);
      if (fs.existsSync(p1)) {
        foundData = readJsonSafe(p1, null);
        foundSource = p1;
      } else if (fs.existsSync(p2)) {
        foundData = readJsonSafe(p2, null);
        foundSource = p2;
      }
    } else if (isLast) {
      const cacheDir = path.join(cwd, '.claude', 'cache');
      if (fs.existsSync(cacheDir)) {
        try {
          const files = fs.readdirSync(cacheDir)
            .filter((f) => f.startsWith('ah_live_state_') && f.endsWith('.json'))
            .map((f) => ({ name: f, full: path.join(cacheDir, f), mtime: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0) {
            foundData = readJsonSafe(files[0].full, null);
            foundSource = files[0].full;
            if (foundData?.sessionId) sessionId = foundData.sessionId;
          }
        } catch (_err) {
          void _err;
        }
      }
    }

    // 2. Check USTF sessions directory (~/.ctxtop/sessions/<sessionId>.jsonl or .json)
    if (!foundData && sessionId) {
      const safeId = sanitizeSessionId(sessionId);
      const sDir = path.join(homeDir, '.ctxtop', 'sessions');
      const pJsonl = path.join(sDir, `${safeId}.jsonl`);
      const pJson = path.join(sDir, `${safeId}.json`);
      if (fs.existsSync(pJsonl)) {
        try {
          const lines = fs.readFileSync(pJsonl, 'utf8').trim().split('\n').filter(Boolean);
          const events = lines.map((l) => JSON.parse(l));
          foundData = { sessionId, events, harness: 'claude-code' };
          foundSource = pJsonl;
        } catch (_err) {
          void _err;
        }
      } else if (fs.existsSync(pJson)) {
        foundData = readJsonSafe(pJson, null);
        foundSource = pJson;
      }
    }

    // 3. Check Antigravity session directories
    if (!foundData && sessionId) {
      try {
        const surfaces = getAntigravitySurfaces(homeDir, { includeMissing: false });
        const stores = surfaces.length > 0
          ? surfaces.map((s) => s.brainDir)
          : getBrainStores(homeDir).map((s) => s.path);
        for (const sPath of stores) {
          const candidateDir = path.join(sPath, sessionId);
          if (fs.existsSync(candidateDir)) {
            foundData = { sessionId, path: candidateDir, isAntigravity: true };
            foundSource = candidateDir;
            break;
          }
        }
      } catch (_err) {
        void _err;
      }
    }

    if (!foundData) {
      return {
        exitCode: 1,
        output: `[Attention Horizon Inspect] Session "${sessionId}" not found.`,
        data: { found: false, sessionId }
      };
    }

    let trajectory = null;
    if (foundData.version === '1.0.0' && foundData.sessionId && foundData.events) {
      trajectory = foundData;
    } else if (foundData.isAntigravity || Array.isArray(foundData.steps)) {
      trajectory = normalizeAntigravitySession(foundData, { sessionId, source: foundSource });
    } else if (Array.isArray(foundData.events) || Array.isArray(foundData.entries)) {
      trajectory = normalizeClaudeCodeSession(foundData, { sessionId, source: foundSource });
    } else {
      const empty = createEmptyUstfSession(sessionId || foundData.sessionId || 'default', 'claude-code', {
        modelId: foundData.modelId || foundData.rawModelId || 'claude-sonnet-5-5',
        startTimeMs: foundData.sessionStartTimeMs || Date.now()
      });
      const uncached = Math.max(0, Number(foundData.contextWindow?.totalInputTokens || 0) - Number(foundData.contextWindow?.cachedTokens || 0));
      empty.usage = {
        uncached,
        cacheWrite5m: Number(foundData.contextWindow?.cacheWrite5mTokens || 0),
        cacheWrite1h: Number(foundData.contextWindow?.cacheWrite1hTokens || 0),
        cacheRead: Number(foundData.contextWindow?.cacheReadTokens || foundData.contextWindow?.cachedTokens || 0),
        output: Number(foundData.contextWindow?.outputTokens || 0),
        thinking: Number(foundData.contextWindow?.thinkingTokens || 0),
        costUSD: Number(foundData.savedQuota?.sessionSavedUSD || 0)
      };
      empty.turnsCompleted = Number(foundData.turnsCompleted || 0);
      empty.flightMode = foundData.flightMode || 'COACH';
      trajectory = empty;
    }

    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      writeJsonAtomic(outPath, trajectory);
    }

    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(trajectory, null, 2), data: trajectory };
    }

    const totalToks = (trajectory.usage?.uncached || 0) + (trajectory.usage?.cacheRead || 0);
    const lines = [
      `[Attention Horizon Inspect] Session "${sessionId || trajectory.sessionId}" (${trajectory.harness || 'claude-code'})`,
      `  Model: ${trajectory.modelId || 'unknown'} | Events: ${trajectory.events?.length || 0} | Spans: ${trajectory.spans?.length || 0}`,
      `  Tokens: ${totalToks.toLocaleString()} (Uncached: ${(trajectory.usage?.uncached || 0).toLocaleString()}, Cache: ${(trajectory.usage?.cacheRead || 0).toLocaleString()})`,
      `  Cost: $${(trajectory.usage?.costUSD || 0).toFixed(4)}`,
      outPath ? `  Artifact written: ${outPath}` : ''
    ].filter(Boolean);

    return { exitCode: 0, output: lines.join('\n'), data: trajectory };
  }

  if (subcommand === 'control') {
    const action = String(args[1] || '').toLowerCase();
    const validActions = ['pause', 'resume', 'step', 'abort', 'rewind', 'status'];
    if (!validActions.includes(action)) {
      return {
        exitCode: 1,
        output: `[Attention Horizon Control] Invalid control action "${args[1] || ''}". Valid actions: pause, resume, step, abort, rewind`,
        data: { ok: false, validActions }
      };
    }

    let sessionId = options.sessionId || 'default';
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--session' && args[i + 1]) {
        sessionId = args[i + 1];
        break;
      }
    }

    const homeDir = options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
    const runtimeDir = path.join(homeDir, '.ctxtop', 'runtime');

    if (action === 'status') {
      const ctlPath = path.join(runtimeDir, `${sessionId}.ctl`);
      let currentState = { sessionId, state: 'RUNNING', reason: 'default' };
      if (fs.existsSync(ctlPath)) {
        try {
          currentState = parseControlFile(fs.readFileSync(ctlPath, 'utf8'), sessionId);
        } catch (_err) {
          void _err;
        }
      }
      return {
        exitCode: 0,
        output: `[Attention Horizon Control] Session "${sessionId}" is ${currentState.state}`,
        data: { ok: true, sessionId, state: currentState }
      };
    }

    let rewindTarget = options.target || options.rewindTarget || null;
    const targetIdx = args.indexOf('--target') !== -1 ? args.indexOf('--target') : args.indexOf('--turn');
    if (targetIdx !== -1 && args[targetIdx + 1]) {
      rewindTarget = args[targetIdx + 1];
    } else if (args[2] && !args[2].startsWith('-')) {
      rewindTarget = args[2];
    }

    const reason = options.reason || `CLI /control ${action}${rewindTarget ? ` (target: ${rewindTarget})` : ''}`;

    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      const ctlPath = path.join(runtimeDir, `${sessionId}.ctl`);
      let currentState = null;
      if (fs.existsSync(ctlPath)) {
        try {
          currentState = parseControlFile(fs.readFileSync(ctlPath, 'utf8'), sessionId);
        } catch (_err) {
          void _err;
        }
      }
      const nextState = transitionControlState(currentState, action, reason, { sessionId, target: rewindTarget });
      fs.writeFileSync(ctlPath, serializeControlFile(nextState), 'utf8');

      // Best-effort notify warm IPC daemon
      try {
        const client = new MicroIpcClient({ homeDir });
        client.call('control.transition', { sessionId, action, reason, target: rewindTarget }, { connectTimeoutMs: 15, requestTimeoutMs: 100 }).catch((_ipcErr) => {
          void _ipcErr;
        });
      } catch (_ipcErr) {
        void _ipcErr;
      }

      return {
        exitCode: 0,
        output: `[Attention Horizon Control] State transitioned to ${nextState.state}`,
        data: { ok: true, action, sessionId, state: nextState }
      };
    } catch (err) {
      return {
        exitCode: 1,
        output: `[Attention Horizon Control] Failed to transition control state: ${err.message}`,
        data: { ok: false, error: err.message }
      };
    }
  }

  if (subcommand === 'init') {
    return executeInitSubcommand(args.slice(1), options);
  }

  if (subcommand === 'install') {
    const fullHooks =
      args.includes('--full-hooks') || options.leanHooks === false || Boolean(options.fullHooks);
    const leanHooks =
      args.includes('--lean-hooks') || options.leanHooks === true || !fullHooks;
    const res = installAttentionHorizon({ ...options, scope, leanHooks });
    const backupNote = res.backupPath ? `\nBackup saved: ${res.backupPath}` : '';
    const output = `[Attention Horizon] Installed non-destructively into ${res.settingsPath}${backupNote}`;
    return { exitCode: res.ok ? 0 : 1, output, data: res };
  }

  if (subcommand === 'team-pack' || subcommand === 'team-finops') {
    const outIdx = args.indexOf('--out');
    const orgIdx = args.indexOf('--org');
    const outDir =
      outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : options.outDir;
    const orgName =
      orgIdx !== -1 && args[orgIdx + 1] ? args[orgIdx + 1] : options.orgName || 'Engineering Team';
    const preview = args.includes('--preview') || Boolean(options.preview);
    const packRes = generateTeamFinopsPack({ ...options, outDir, orgName, preview });
    if (!packRes.ok) {
      return {
        exitCode: 2,
        output: `[Attention Horizon Team] ${packRes.entitlement.upgradeHint}`,
        data: packRes
      };
    }
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(packRes, null, 2), data: packRes };
    }
    return {
      exitCode: 0,
      output: `[Attention Horizon Team] Generated BYO-Grafana & Datadog Team FinOps Pack in: ${packRes.outDir}\n  Files written: ${packRes.filesWritten.length}`,
      data: packRes
    };
  }

  if (subcommand === 'verify' || subcommand === 'verify-checksums') {
    const rootDir = options.rootDir || PKG_ROOT;
    const manifestPath = path.join(rootDir, 'CHECKSUMS.sha256');
    if (!fs.existsSync(manifestPath)) {
      const missingRes = {
        valid: false,
        verifiedCount: 0,
        mismatches: ['Missing CHECKSUMS.sha256 manifest']
      };
      return {
        exitCode: 1,
        output: isJson
          ? JSON.stringify(missingRes, null, 2)
          : '[Attention Horizon Verify] FAILED: Missing CHECKSUMS.sha256 manifest',
        data: missingRes
      };
    }
    const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const mismatches = [];
    let verifiedCount = 0;
    for (const line of lines) {
      const match = line.match(/^([a-f0-9]{64})\s\s(.+)$/);
      if (!match) continue;
      const [, expectedHash, relPath] = match;
      const absPath = path.join(rootDir, relPath);
      if (!fs.existsSync(absPath)) {
        mismatches.push(`Missing file: ${relPath}`);
        continue;
      }
      const normalized = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
      const actualHash = sha256HexPure(normalized);
      if (actualHash !== expectedHash) {
        mismatches.push(`Checksum mismatch: ${relPath}`);
      } else {
        verifiedCount++;
      }
    }
    const verifyRes = {
      valid: mismatches.length === 0 && verifiedCount > 0,
      verifiedCount,
      mismatches
    };
    if (isJson) {
      return {
        exitCode: verifyRes.valid ? 0 : 1,
        output: JSON.stringify(verifyRes, null, 2),
        data: verifyRes
      };
    }
    return {
      exitCode: verifyRes.valid ? 0 : 1,
      output: verifyRes.valid
        ? `[Attention Horizon Verify] PASS — ${verifiedCount} release files verified against CHECKSUMS.sha256 (0 mismatches)`
        : `[Attention Horizon Verify] FAIL — ${mismatches.length} mismatch(es): ${mismatches.slice(0, 5).join('; ')}`,
      data: verifyRes
    };
  }

  if (subcommand === 'tiers') {
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(PLG_TIER_MATRIX, null, 2), data: PLG_TIER_MATRIX };
    }
    const lines = [
      'Attention Horizon — 3-Tier Self-Expensing PLG Funnel:',
      `  • Free ($0/mo): ${PLG_TIER_MATRIX.free.features.join(', ')}`,
      `  • Pro ($${PLG_TIER_MATRIX.pro.priceMonthlyUSD}/mo [$12-$19/mo]): ${PLG_TIER_MATRIX.pro.features.join(', ')}`,
      `  • Team ($${PLG_TIER_MATRIX.team.pricePerSeatMonthlyUSD}/seat/mo): ${PLG_TIER_MATRIX.team.features.join(', ')}`
    ];
    return { exitCode: 0, output: lines.join('\n'), data: PLG_TIER_MATRIX };
  }

  if (subcommand === 'license' || subcommand === 'pro') {
    const action = String(args[1] || 'status').toLowerCase();
    if (action === 'tiers') {
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(PLG_TIER_MATRIX, null, 2), data: PLG_TIER_MATRIX };
      }
      const lines = [
        'Attention Horizon — 3-Tier Self-Expensing PLG Funnel:',
        `  • Free ($0/mo): ${PLG_TIER_MATRIX.free.features.join(', ')}`,
        `  • Pro ($${PLG_TIER_MATRIX.pro.priceMonthlyUSD}/mo [$12-$19/mo]): ${PLG_TIER_MATRIX.pro.features.join(', ')}`,
        `  • Team ($${PLG_TIER_MATRIX.team.pricePerSeatMonthlyUSD}/seat/mo): ${PLG_TIER_MATRIX.team.features.join(', ')}`
      ];
      return { exitCode: 0, output: lines.join('\n'), data: PLG_TIER_MATRIX };
    }
    if (action === 'activate' && args[2]) {
      const actRes = activateProLicense(args[2], options);
      if (isJson) {
        return { exitCode: actRes.ok ? 0 : 1, output: JSON.stringify(actRes, null, 2), data: actRes };
      }
      return {
        exitCode: actRes.ok ? 0 : 1,
        output: actRes.ok
          ? `[Attention Horizon Pro] Activated ${actRes.tier.toUpperCase()} license (${actRes.payload.email}) -> ${actRes.licensePath}`
          : `[Attention Horizon Pro] License activation failed: ${actRes.reason}`,
        data: actRes
      };
    }
    if (action === 'trial') {
      const trRes = activateLocalTrial(options);
      return {
        exitCode: 0,
        output: `[Attention Horizon Pro] Activated 14-day local trial (expires ${trRes.expiresAt}) -> ${trRes.licensePath}`,
        data: trRes
      };
    }
    if (action === 'deactivate') {
      const deactRes = deactivateProLicense(options);
      return {
        exitCode: 0,
        output: `[Attention Horizon Pro] Deactivated license (${deactRes.licensePath})`,
        data: deactRes
      };
    }
    const status = getProEntitlementStatus(options);
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(status, null, 2), data: status };
    }
    return {
      exitCode: 0,
      output: `[Attention Horizon Pro] Tier=${status.tier} | Entitled=${status.entitled} | Source=${status.source}`,
      data: status
    };
  }

  if (subcommand === 'roast' || (args.includes('--roast') && subcommand !== 'postmortem')) {
    const isDemo = args.includes('--demo') || Boolean(options.demo);
    const roast = generateRoastCard({ ...options, demo: isDemo });
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(roast, null, 2), data: roast };
    }
    if (isMarkdown) {
      return { exitCode: 0, output: roast.markdown, data: roast };
    }
    return { exitCode: 0, output: roast.ascii, data: roast };
  }

  if (subcommand === 'uninstall') {
    const res = uninstallAttentionHorizon({ ...options, scope });
    const output = `[Attention Horizon] Uninstalled ${res.removedHooksCount} hook entries from ${res.settingsPath}`;
    return { exitCode: res.ok ? 0 : 1, output, data: res };
  }

  if (subcommand === 'config') {
    const action = String(args[1] || 'list').toLowerCase();
    if (action === 'set') {
      const detId = args[2];
      const mode = args[3] || 'default';
      const res = setDetectorOverride(detId, mode, { ...options, scope });
      if (!res.ok) {
        return {
          exitCode: 1,
          output: `[Attention Horizon Config] Invalid detector ID "${detId}". Expected DET-01..DET-20.`,
          data: res
        };
      }
      return {
        exitCode: 0,
        output: `[Attention Horizon Config] Set ${res.detectorId}=${res.mode} in ${res.configPath}`,
        data: res
      };
    }
    if (action === 'reset') {
      const res = resetHorizonConfig({ ...options, scope });
      return {
        exitCode: res.ok ? 0 : 1,
        output: `[Attention Horizon Config] Reset detector overrides at ${res.configPath}`,
        data: res
      };
    }
    const cfg = loadHorizonConfig({ ...options, scope });
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(cfg, null, 2), data: cfg };
    }
    const lines = [
      `[Attention Horizon Config] FlightMode=${cfg.flightMode} (projectLoaded=${cfg.sources.projectLoaded})`,
      ...Object.entries(cfg.detectors).map(([id, m]) => `  ${id}: ${m}`)
    ];
    return { exitCode: 0, output: lines.join('\n'), data: cfg };
  }

  if (subcommand === 'cost-radar' || subcommand === 'radar') {
    const isDemo = args.includes('--demo') || Boolean(options.demo);
    const isShare = args.includes('--share') || Boolean(options.share);
    const outIdx = args.indexOf('--out');
    const target = path.resolve(
      outIdx !== -1 && args[outIdx + 1]
        ? args[outIdx + 1]
        : path.join(os.homedir(), '.claude', 'attention-horizon', 'cost_radar.html')
    );
    const res = generateCostRadar({ ...options, demo: isDemo });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ok = writeTextAtomic(target, res.html) !== false;
    const shareSnippet = `⚡ Cost Radar: ${res.summary.retention} · ${res.summary.drift} · ${res.summary.swarm} (via npx ah-claude cost-radar)`;
    const data = { ok, path: target, ...res.summary, shareSnippet };
    if (isJson) {
      return { exitCode: ok ? 0 : 1, output: JSON.stringify(data, null, 2), data };
    }
    return {
      exitCode: ok ? 0 : 1,
      output: `[Attention Horizon] Cost Radar written: ${target}\n  ${res.summary.retention}\n  ${res.summary.drift}\n  ${res.summary.swarm}${isShare ? `\n  Share: ${shareSnippet}` : ''}`,
      data
    };
  }

  if (subcommand === 'postmortem' || args.includes('--postmortem')) {
    const lastIdx = args.indexOf('--last');
    const last = lastIdx !== -1 && args[lastIdx + 1] ? Number(args[lastIdx + 1]) : (options.last || 15);
    const isRoast = args.includes('--roast') || Boolean(options.roast);
    const isDemo = args.includes('--demo') || Boolean(options.demo);
    return runPostmortem({
      ...options,
      last,
      json: false,
      demo: isDemo,
      roast: isRoast,
      writeFiles: options.writeFiles !== false
    }).then((res) => {
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(res, null, 2), data: res };
      }
      const estM = typeof res.estTokensM === 'number' ? `${res.estTokensM.toFixed(2)}M` : String(res.estTokensM || '0M');
      const summaryText = [
        `[Attention Horizon Postmortem] Analyzed ${res.sessionCount} sessions (${estM} active tokens)`,
        `  Clean Sessions: ${res.cleanSessionCount || 0} | Churn: ${res.churnSessionCount || 0} | Rot: ${res.rotSessionCount || 0}`,
        res.reportPath ? `  Report: ${res.reportPath}` : ''
      ].filter(Boolean).join('\n');
      return { exitCode: 0, output: summaryText, data: res };
    });
  }

  if (subcommand === 'panel') {
    const outIdx = args.indexOf('--out');
    const isAdvanced = args.includes('--advanced') || args.includes('advanced');
    const target = path.resolve(
      outIdx !== -1 && args[outIdx + 1]
        ? args[outIdx + 1]
        : path.join(os.homedir(), '.claude', 'attention-horizon', 'horizon_panel.html')
    );
    const res = generateHorizonPanel({ ...options, advanced: isAdvanced });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ok = writeTextAtomic(target, res.html) !== false;
    const data = { ok, path: target, ...res.summary };
    if (isJson) {
      return { exitCode: ok ? 0 : 1, output: JSON.stringify(data, null, 2), data };
    }
    return {
      exitCode: ok ? 0 : 1,
      output: `[Attention Horizon] Claude Code HUD written: ${target}\n  Verdict: ${res.summary.verdict}\n  Next Action: ${res.summary.action}\n  Saved: +${res.summary.sessionSavedTokens.toLocaleString('en-US')} tokens ($${res.summary.sessionSavedUSD.toFixed(2)}) this session`,
      data
    };
  }

  if (subcommand === 'receipt') {
    const isAdvanced = args.includes('--advanced') || args.includes('advanced');
    const isFourRank = args.includes('--4-rank') || args.includes('--simple');
    const isPdf = args.includes('--pdf') || Boolean(options.pdf);
    const isHtml = args.includes('--html') || Boolean(options.html);
    const outIdx = args.indexOf('--out');
    const outPath = outIdx !== -1 && args[outIdx + 1]
      ? path.resolve(args[outIdx + 1])
      : options.out
        ? path.resolve(options.out)
        : null;
    const res = generateReceiptReport({
      ...options,
      advanced: isAdvanced,
      fourRank: isFourRank
    });
    if (isPdf) {
      const proCheck = requireProFeature('corporate_expense_receipts', options);
      if (!proCheck.allowed) {
        const savedUsd = res.corporateReceipt.workspace30dSavedUSD.toFixed(2);
        return {
          exitCode: 2,
          output: `[Attention Horizon Pro] Pro would expense +$${savedUsd} USD saved over 30d. ${proCheck.upgradeHint}`,
          data: { ok: false, requiresPro: true, entitlement: proCheck, shadowSavedUSD: Number(savedUsd) }
        };
      }
      const targetPdf = outPath || path.resolve(options.cwd || process.cwd(), 'attention-horizon-expense-receipt.pdf');
      fs.mkdirSync(path.dirname(targetPdf), { recursive: true });
      fs.writeFileSync(targetPdf, Buffer.from(res.pdfBytes));
      const pdfData = {
        ok: true,
        path: targetPdf,
        receiptId: res.corporateReceipt.receiptId,
        sha256: res.corporateReceipt.sha256,
        workspace30dSavedUSD: res.corporateReceipt.workspace30dSavedUSD,
        netRoiMultiplier: res.corporateReceipt.netRoiMultiplier
      };
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(pdfData, null, 2), data: pdfData };
      }
      return {
        exitCode: 0,
        output: `[Attention Horizon Pro] Corporate Expense Receipt (PDF 1.4) written: ${targetPdf}\n  Receipt ID : ${pdfData.receiptId}\n  30d Saved  : +$${pdfData.workspace30dSavedUSD.toFixed(2)} USD (${pdfData.netRoiMultiplier}x ROI)\n  SHA-256    : ${pdfData.sha256}`,
        data: pdfData
      };
    }
    if (isHtml) {
      if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        writeTextAtomic(outPath, res.html);
      }
      return { exitCode: 0, output: res.html, data: res };
    }
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(res.gitReceipt, null, 2), data: res };
    }
    if (isMarkdown) {
      if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        writeTextAtomic(outPath, res.markdown);
      }
      return { exitCode: 0, output: res.markdown, data: res };
    }
    return { exitCode: 0, output: res.text, data: res };
  }

  if (subcommand === 'doctor') {
    if (args.includes('--prune-tools') || args.includes('--gc-cursor') || args.includes('--recover-brain') || args.includes('--reap-orphans') || args.includes('--handoff')) {
      return runDoctor({ ...options, ...parseDoctorArgs(args) }).then((docRes) => ({
        exitCode: docRes.ok ? 0 : 1,
        output: JSON.stringify(docRes, null, 2),
        data: docRes
      }));
    }
    const res = runDoctorDiagnostics(options);
    if (isDiagnostic) {
      const bundle = generateZeroPiiDiagnosticBundle(res, options);
      return {
        exitCode: res.ok ? 0 : 1,
        output: isJson ? JSON.stringify(bundle, null, 2) : bundle.markdown,
        data: bundle
      };
    }
    if (isJson) {
      return { exitCode: res.ok ? 0 : 1, output: JSON.stringify(res, null, 2), data: res };
    }
    const hookDiag = res.hookDiagnostics || { recentErrorCount: 0, recentErrors: [] };
    const lines = [
      `[Attention Horizon Doctor] Status: ${res.ok ? 'HEALTHY' : 'ISSUES DETECTED'}`,
      ...res.checks.map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`),
      `  [${hookDiag.recentErrorCount > 0 ? 'WARN' : 'PASS'}] hook_diagnostics: ${hookDiag.recentErrorCount} recent non-fatal error(s)`
    ];
    for (const errEntry of hookDiag.recentErrors) {
      lines.push(
        `    - [${errEntry.timestamp}] ${errEntry.source}#${errEntry.operation} (${errEntry.name}): ${errEntry.message}`
      );
    }
    return { exitCode: res.ok ? 0 : 1, output: lines.join('\n'), data: res };
  }

  if (subcommand === 'statusline') {
    return runStatusLineCli(args.slice(1));
  }

  if (args.includes('--demo') || args.includes('--demo-animate') || args.includes('--roast') || args.includes('--serve')) {
    return runLiveOrDemoCli(options);
  }

  const knownSubcommands = new Set([
    'init', 'install', 'uninstall', 'config', 'cost-radar', 'radar', 'panel',
    'receipt', 'doctor', 'statusline', 'inspect', 'control', 'postmortem',
    'license', 'pro', 'roast',
    '--help', '-h', 'help', '--version', '-v', 'version'
  ]);
  const hasHelp = args.length === 0 || args.includes('--help') || args.includes('-h') || subcommand === 'help';
  const isUnknown = !hasHelp && args.length > 0 && !knownSubcommands.has(subcommand);

  const helpText = [
    'Usage: ctxtop <command> [options]',
    'Commands:',
    '  init [--antigravity | --claude | --all | --workspace | --dry-run] Zero-config dual-host installer',
    '  install [--global | --project]                                      Merge Claude Code hooks & statusLine',
    '  uninstall [--global | --project]                                    Remove Attention Horizon hooks',
    '  doctor [--diagnostic | --json]                                      Verify contracts or emit zero-PII report',
    '  postmortem [--last N] [--json] [--demo]                             Analyze transcript forensics & rot',
    '  receipt [--advanced | --markdown | --json]                          Print Simple View or Git-Commit Receipt',
    '  panel [--advanced] [--out <file.html>]                              Write zero-socket Claude Code HTML HUD',
    '  radar [--out <file.html>] [--json] [--demo]                         Write SVG KV-cache retention radar timeline',
    '  cost-radar [--out <file.html>] [--json]                             (Alias for radar)',
    '  statusline [--demo] [--columns N]                                   Responsive single-line statusline bridge',
    '  config [list | set <DET-ID> <mode> | reset]                        Configure per-detector overrides',
    '  inspect [<session-id> | --last] [--out <file.json>]                 Inspect session trajectory',
    '  control <pause|resume|step|abort|rewind|status>                     Execution control plane command'
  ].join('\n');
  return { exitCode: isUnknown ? 1 : 0, output: helpText, data: { help: true, isUnknown } };
}

export function isCliMain(
  argv1 = globalThis.process?.argv?.[1],
  metaUrl = import.meta.url,
  fsImpl = fs
) {
  if (!argv1 || !metaUrl) return false;
  try {
    return fsImpl.realpathSync(argv1) === fsImpl.realpathSync(url.fileURLToPath(metaUrl));
  } catch {
    try {
      return path.resolve(String(argv1)) === path.resolve(url.fileURLToPath(metaUrl));
    } catch {
      return false;
    }
  }
}

export function main(args = globalThis.process?.argv?.slice(2) || []) {
  const result = runCli(args);
  if (result && typeof result.then === 'function') {
    return result.then((res) => {
      if (res?.output) globalThis.process?.stdout?.write?.(`${res.output}\n`);
      if (res?.exitCode !== undefined && res?.exitCode !== 0 && globalThis.process?.exit) {
        globalThis.process.exit(res.exitCode);
      }
      return res;
    });
  }
  if (result?.output) globalThis.process?.stdout?.write?.(`${result.output}\n`);
  if (result?.exitCode !== undefined && result?.exitCode !== 0 && globalThis.process?.exit) {
    globalThis.process.exit(result.exitCode);
  }
  return result;
}

if (isCliMain()) {
  main();
}

export default {
  PKG_ROOT,
  CANONICAL_AH_HOOKS,
  PRE_TOOL_USE_MATCHER,
  POST_TOOL_USE_MATCHER,
  isAttentionHorizonHookEntry,
  resolveSettingsPath,
  ensureGitExcludeEntries,
  installAttentionHorizon,
  uninstallAttentionHorizon,
  inspectHookDiagnostics,
  runDoctorDiagnostics,
  generateReceiptReport,
  generateHorizonPanel,
  generateCostRadar,
  executeInitSubcommand,
  runCli,
  isCliMain,
  main
};
