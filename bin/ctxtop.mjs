#!/usr/bin/env node
/**
 * @file bin/ctxtop.mjs
 * Highbeam v4.1.1 Unified Cross-Platform CLI (`ctxtop`).
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
import { getShadowAutoSummary } from '../src/core/shadow_auto_ledger.mjs';
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
import {
  formatPreEffortChangeCapability,
  inspectClaudeBinaryCapabilities
} from '../src/diagnostics/claudeHookCapabilities.mjs';
import { installPlugin, runLiveOrDemoCli, openBrowserUrl } from '../src/cli/init.mjs';
import { executeStatusLineBridge, runStatusLineCli } from './ah-statusline.mjs';
import { runSessionAudit, formatSessionAuditReport } from '../src/core/session_auditor.mjs';
import { configureShield, getShieldStatus } from '../src/core/shield_manager.mjs';
import { buildContrastiveDigest, sanitizeRslSessionId } from '../src/core/rsl_triage.mjs';
import { distillContrastiveDigest } from '../src/core/rsl_distiller.mjs';
import {
  getRslLedgerPath,
  getRslSummary,
  ingestDistilledHeuristics,
  promoteHeuristic,
  pruneHeuristic,
  auditWorkspaceRuleClashes,
  buildConsolidatedSpecMarkdown
} from '../src/core/rsl_ledger.mjs';
import {
  searchOffloadedContextFts5,
  getOffloadIndexStats
} from '../src/core/fts5_output_compressor.mjs';
import {
  SUPPORTED_MCP_HOSTS,
  installHostMcpConfig
} from '../src/engine-node/multi_host_mcp.mjs';
import { resolveFastIpcPipePath } from '../src/engine-node/ipc/fast_client.mjs';

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
  /hooks[\\/]handlers[\\/](pre-tool-use|post-tool-use|pre-model-switch|post-model-switch|compact-lifecycle|stop-gate|user-prompt-submit|config-change)\.mjs/i;
const AH_STATUSLINE_REGEX = /ah-statusline\.mjs/i;
const AH_MOD_REGISTER_REGEX = /(?:^|[\\/])hooks[\\/]register\.js$|^\.\/register\.js$/i;

/**
 * Extracts the Highbeam command string from either a nested (`{ hooks: [{ command }] }`)
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
  const includePostModelSwitch = options.includePostModelSwitch !== false;

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
    ...(includePostModelSwitch
      ? {
          PostModelSwitch: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node "${handlerPrefix}/post-model-switch.mjs"`
                }
              ]
            }
          ]
        }
      : {}),
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
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/user-prompt-submit.mjs"`
          }
        ]
      }
    ],
    ConfigChange: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/config-change.mjs"`
          }
        ]
      }
    ],
    InstructionsLoaded: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/compact-lifecycle.mjs" --phase=instructions`
          }
        ]
      }
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: `node "${handlerPrefix}/stop-gate.mjs" --phase=end`
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
  let includePostModelSwitch =
    options.includePostModelSwitch !== undefined ? Boolean(options.includePostModelSwitch) : true;
  const omittedUnsupportedHooks = [];
  if (
    options.includePostModelSwitch === undefined &&
    options.checkBinaryCapabilities !== false
  ) {
    const caps = inspectClaudeBinaryCapabilities({
      ...options,
      cwd,
      probeVersion: false,
      recordDiagnostic: false,
      writeCache: false
    });
    if (caps.found === true && caps.postModelSwitchSupported === false) {
      includePostModelSwitch = false;
      omittedUnsupportedHooks.push('PostModelSwitch');
    }
  }
  const canonicalHooks = buildCanonicalAhHooks({
    usePluginRootVar: false,
    pkgRoot,
    leanHooks: useLeanHooks,
    includePostModelSwitch
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
    omittedUnsupportedHooks,
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
    '╭── 🔥 HIGHBEAM CONTEXT ROAST (Claude Code + Antigravity) ──────────╮',
    `│ KV-Cache Retention : Grade ${retentionGrade} (${retentionPct}% prefix warmth retained)               │`,
    `│ Cold Prefill Leak  : $${leakedUsd.toFixed(2)} burned on avoidable cold-cache switches/edits    │`,
    `│ Verified Savings   : +${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)} USD saved in 30d)            │`,
    '│ Top Remediation    : Fence mid-session CLAUDE.md/AGENTS.md edits (DET-09)  │',
    '╰────────────────────────────────────────────────────────────────────────────╯',
    `Share: Shielded +${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)}) with npx ctxtop --roast #ClaudeCode #Antigravity`
  ].join('\n');

  const markdown = [
    '### 🔥 Highbeam Context Roast (`npx ctxtop --roast`)',
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
 * Supports `--antigravity`, `--claude`, `--mcp`, `--cursor`, `--all`, `--workspace`, `--project`, `--dry-run`, `--dedupe`.
 */
/**
 * Non-destructively writes or merges the `@ctxtop/mcp` server entry into `.cursor/mcp.json`.
 *
 * @param {object} [options]
 * @returns {{ ok: boolean, mcpPath: string, serverKey: string, serverScript: string, dryRun: boolean }}
 */
export function installMcpConfig(options = {}) {
  const isDryRun = Boolean(options.dryRun);
  const isGlobal = options.scope === 'global' || Boolean(options.global);
  const baseDir = isGlobal
    ? options.homeDir || options.home || getHomeDir()
    : options.cwd || process.cwd();
  const mcpPath = options.mcpConfigPath
    ? path.resolve(options.mcpConfigPath)
    : path.join(baseDir, '.cursor', 'mcp.json');
  const existing = readJsonSafe(mcpPath, {});
  const currentObj =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const mcpServers =
    currentObj.mcpServers &&
    typeof currentObj.mcpServers === 'object' &&
    !Array.isArray(currentObj.mcpServers)
      ? { ...currentObj.mcpServers }
      : {};
  const serverScript = `${PKG_ROOT}/packages/mcp/src/server.mjs`;
  mcpServers['attention-horizon'] = {
    command: 'node',
    args: [serverScript]
  };
  const updated = {
    ...currentObj,
    mcpServers
  };
  if (!isDryRun) {
    writeJsonAtomic(mcpPath, updated);
  }
  return {
    ok: true,
    mcpPath,
    serverKey: 'attention-horizon',
    serverScript,
    dryRun: isDryRun
  };
}

export function executeInitSubcommand(args = [], options = {}) {
  const isAllHosts = args.includes('--all-hosts') || Boolean(options.allHosts);
  const isAntigravity = args.includes('--antigravity') || args.includes('-a') || isAllHosts;
  const isClaude = args.includes('--claude') || args.includes('-c') || isAllHosts;
  const isLegacyMcp = args.includes('--mcp') || Boolean(options.mcp);

  const selectedMcpHosts = [];
  if (args.includes('--cursor') || Boolean(options.cursor)) selectedMcpHosts.push('cursor');
  if (args.includes('--windsurf') || Boolean(options.windsurf)) selectedMcpHosts.push('windsurf');
  if (args.includes('--codex') || Boolean(options.codex)) selectedMcpHosts.push('codex');
  if (args.includes('--gemini-cli') || args.includes('--gemini') || Boolean(options.geminiCli)) {
    selectedMcpHosts.push('gemini-cli');
  }
  if (isAllHosts) {
    for (const h of SUPPORTED_MCP_HOSTS) {
      if (!selectedMcpHosts.includes(h)) selectedMcpHosts.push(h);
    }
  } else if (isLegacyMcp && selectedMcpHosts.length === 0) {
    // Also ensure --mcp works cleanly alongside legacy .cursor/mcp.json contract
  }

  const hasMcpTarget = isLegacyMcp || selectedMcpHosts.length > 0;
  const isAll = args.includes('--all') || (!isAntigravity && !isClaude && !hasMcpTarget);
  const isDryRun = args.includes('--dry-run') || Boolean(options.dryRun);
  const isWorkspace = args.includes('--workspace') || args.includes('--project') || Boolean(options.workspace);
  const isGlobal = args.includes('--global') || Boolean(options.global);
  const isDedupe = args.includes('--dedupe') || Boolean(options.dedupe);
  const isLeanHooks = args.includes('--lean-hooks') || Boolean(options.leanHooks);
  const isFullHooks = args.includes('--full-hooks') || Boolean(options.fullHooks);

  const targetParts = [];
  if (isAll || isAntigravity) targetParts.push('Google Antigravity');
  if (isAll || isClaude) targetParts.push('Claude Code');
  if (isLegacyMcp) targetParts.push('MCP (.cursor/mcp.json)');
  if (selectedMcpHosts.length > 0) targetParts.push(`MCP (${selectedMcpHosts.join(', ')})`);
  const targetLabel =
    targetParts.length === 2 && !hasMcpTarget ? targetParts.join(' & ') : targetParts.join(', ');

  const lines = [
    `\x1b[1m\x1b[38;5;51m⚡ Highbeam (ctxtop v4.1.1) — Zero-Config Unified Installer\x1b[0m`,
    `  • Target Harnesses : ${targetLabel}`,
    `  • Installation Scope: ${isWorkspace ? 'Workspace' : 'Global'}${isDryRun ? ' [DRY RUN]' : ''}`
  ];

  let claudeResult = null;
  let antigravityResult = null;
  let mcpResult = null;
  let hostMcpResult = null;

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

  if (isLegacyMcp) {
    mcpResult = installMcpConfig({
      ...options,
      global: isGlobal,
      dryRun: isDryRun,
      cwd: options.cwd || process.cwd()
    });
    lines.push(
      `  \x1b[38;5;82m✓\x1b[0m MCP Server    : ${isDryRun ? '[DRY RUN] Would configure' : 'Configured'} ${mcpResult.mcpPath} (attention-horizon)`
    );
  }

  if (selectedMcpHosts.length > 0) {
    hostMcpResult = installHostMcpConfig({
      hosts: selectedMcpHosts,
      cwd: options.cwd || process.cwd(),
      homeDir: options.homeDir || options.home,
      global: isGlobal,
      dryRun: isDryRun
    });
    for (const r of hostMcpResult.results) {
      lines.push(
        `  \x1b[38;5;82m✓\x1b[0m MCP [${r.host.padEnd(10)}]: ${isDryRun ? '[DRY RUN] Would configure' : 'Configured'} ${r.configPath} (${r.serverKey})`
      );
      if (r.tomlSnippet) {
        lines.push(`    Tip: Append to ~/.codex/config.toml:\n${r.tomlSnippet}`);
      }
    }
  }

  const ok =
    (claudeResult ? claudeResult.ok : true) &&
    (antigravityResult ? antigravityResult.ok : true) &&
    (mcpResult ? mcpResult.ok : true) &&
    (hostMcpResult ? hostMcpResult.ok : true);
  return {
    ok,
    exitCode: ok ? 0 : 1,
    output: lines.join('\n'),
    data: {
      claude: claudeResult,
      antigravity: antigravityResult,
      mcp: mcpResult,
      hostMcp: hostMcpResult,
      dryRun: isDryRun
    }
  };
}

export function runCli(args = [], options = {}) {
  const invokedBin = path.basename(String(globalThis.process?.argv?.[1] || '')).toLowerCase();
  const isLogSearchBin = invokedBin.includes('agy-log-search');
  const effectiveArgs = isLogSearchBin && !['search', 'log-search'].includes(String(args[0] || '').toLowerCase())
    ? ['search', ...args]
    : args;
  const subcommand = String(effectiveArgs[0] || 'doctor').toLowerCase();
  const isGlobal = effectiveArgs.includes('--global') || effectiveArgs.includes('-g');
  const isJson = effectiveArgs.includes('--json') || Boolean(options.json);
  const isMarkdown = effectiveArgs.includes('--markdown') || effectiveArgs.includes('--md') || effectiveArgs.includes('--git');
  const isDiagnostic = effectiveArgs.includes('--diagnostic') || effectiveArgs.includes('--bug-report');
  const scope = isGlobal ? 'global' : 'project';

  if (effectiveArgs.includes('--version') || effectiveArgs.includes('-v') || subcommand === 'version') {
    return { exitCode: 0, output: '4.1.1', data: { version: '4.1.1' } };
  }

  if (subcommand === 'search' || subcommand === 'log-search') {
    const positional = [];
    let turnId = options.turnId || '';
    let cwd = options.cwd || process.cwd();
    let limit = Number(options.limit || 10);
    for (let i = 1; i < effectiveArgs.length; i++) {
      const a = String(effectiveArgs[i] || '');
      if (a === '--turn' && effectiveArgs[i + 1]) {
        turnId = String(effectiveArgs[++i]);
      } else if (a === '--cwd' && effectiveArgs[i + 1]) {
        cwd = String(effectiveArgs[++i]);
      } else if (a === '--limit' && effectiveArgs[i + 1]) {
        limit = Math.max(1, Number(effectiveArgs[++i]) || 10);
      } else if (a === '--json') {
        // handled via isJson
      } else if (!a.startsWith('-')) {
        positional.push(a);
      }
    }
    let keyword = '';
    if (!turnId && positional.length >= 2 && /^(turn-|art_)/i.test(positional[0])) {
      turnId = positional[0];
      keyword = positional.slice(1).join(' ');
    } else if (!turnId && positional.length === 1 && /^(turn-|art_)/i.test(positional[0])) {
      turnId = positional[0];
    } else {
      keyword = positional.join(' ');
    }
    return searchOffloadedContextFts5({
      turnId,
      keyword,
      cwd,
      homeDir: options.homeDir || getHomeDir(),
      dbPath: options.dbPath || null,
      limit
    }).then((searchRes) => {
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(searchRes, null, 2), data: searchRes };
      }
      if (searchRes.matchedLines.length === 0) {
        return {
          exitCode: 0,
          output: `[Highbeam FTS5 Search] No indexed matches for "${keyword || turnId || '*'}" (hits=${searchRes.totalHits}).`,
          data: searchRes
        };
      }
      const lines = [
        `[Highbeam FTS5 Search] Matched ${searchRes.matchedLines.length} line(s) across ${searchRes.toolLogHits} tool log(s) + ${searchRes.artifactHits} artifact(s):`,
        ...searchRes.matchedLines.map((m) => `  [${m.turnId}:${m.lineNumber}] (${m.source}) ${m.text}`)
      ];
      return { exitCode: 0, output: lines.join('\n'), data: searchRes };
    });
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
        output: `[Highbeam Inspect] Session "${sessionId}" not found.`,
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
      `[Highbeam Inspect] Session "${sessionId || trajectory.sessionId}" (${trajectory.harness || 'claude-code'})`,
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
        output: `[Highbeam Control] Invalid control action "${args[1] || ''}". Valid actions: pause, resume, step, abort, rewind`,
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
        output: `[Highbeam Control] Session "${sessionId}" is ${currentState.state}`,
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
        output: `[Highbeam Control] State transitioned to ${nextState.state}`,
        data: { ok: true, action, sessionId, state: nextState }
      };
    } catch (err) {
      return {
        exitCode: 1,
        output: `[Highbeam Control] Failed to transition control state: ${err.message}`,
        data: { ok: false, error: err.message }
      };
    }
  }

  if (subcommand === 'init') {
    const initRes = executeInitSubcommand(effectiveArgs.slice(1), options);
    if (isJson) {
      return {
        exitCode: initRes.exitCode,
        output: JSON.stringify(initRes.data, null, 2),
        data: initRes.data
      };
    }
    return initRes;
  }

  if (subcommand === 'install') {
    const fullHooks =
      args.includes('--full-hooks') || options.leanHooks === false || Boolean(options.fullHooks);
    const leanHooks =
      args.includes('--lean-hooks') || options.leanHooks === true || !fullHooks;
    const res = installAttentionHorizon({ ...options, scope, leanHooks });
    const backupNote = res.backupPath ? `\nBackup saved: ${res.backupPath}` : '';
    const output = `[Highbeam] Installed non-destructively into ${res.settingsPath}${backupNote}`;
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
        output: `[Highbeam Team] ${packRes.entitlement.upgradeHint}`,
        data: packRes
      };
    }
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(packRes, null, 2), data: packRes };
    }
    return {
      exitCode: 0,
      output: `[Highbeam Team] Generated BYO-Grafana & Datadog Team FinOps Pack in: ${packRes.outDir}\n  Files written: ${packRes.filesWritten.length}`,
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
          : '[Highbeam Verify] FAILED: Missing CHECKSUMS.sha256 manifest',
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
        ? `[Highbeam Verify] PASS — ${verifiedCount} release files verified against CHECKSUMS.sha256 (0 mismatches)`
        : `[Highbeam Verify] FAIL — ${mismatches.length} mismatch(es): ${mismatches.slice(0, 5).join('; ')}`,
      data: verifyRes
    };
  }

  if (subcommand === 'tiers') {
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(PLG_TIER_MATRIX, null, 2), data: PLG_TIER_MATRIX };
    }
    const lines = [
      'Highbeam — 3-Tier Self-Expensing PLG Funnel:',
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
        'Highbeam — 3-Tier Self-Expensing PLG Funnel:',
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
          ? `[Highbeam Pro] Activated ${actRes.tier.toUpperCase()} license (${actRes.payload.email}) -> ${actRes.licensePath}`
          : `[Highbeam Pro] License activation failed: ${actRes.reason}`,
        data: actRes
      };
    }
    if (action === 'trial') {
      const trRes = activateLocalTrial(options);
      if (!trRes.ok) {
        if (isJson) {
          return { exitCode: 1, output: JSON.stringify(trRes, null, 2), data: trRes };
        }
        return {
          exitCode: 1,
          output: `[Highbeam Pro] 14-day trial already expired (${trRes.expiresAt || ''}). Unlock Pro with: npx ctxtop license activate <CTXP1-KEY>`,
          data: trRes
        };
      }
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(trRes, null, 2), data: trRes };
      }
      return {
        exitCode: 0,
        output: `[Highbeam Pro] Activated 14-day local trial (expires ${trRes.expiresAt}) -> ${trRes.licensePath}`,
        data: trRes
      };
    }
    if (action === 'deactivate') {
      const deactRes = deactivateProLicense(options);
      return {
        exitCode: 0,
        output: `[Highbeam Pro] Deactivated license (${deactRes.licensePath})`,
        data: deactRes
      };
    }
    const status = getProEntitlementStatus(options);
    const shadowAuto = getShadowAutoSummary({
      workspacePath: options.cwd || process.cwd(),
      proEntitlement: status,
      ...options
    });
    const outData = { ...status, shadowAuto };
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(outData, null, 2), data: outData };
    }
    const statusLines = [
      `[Highbeam Pro] Tier=${status.tier} | Entitled=${status.entitled} | Source=${status.source}`
    ];
    if (!status.entitled && shadowAuto.incidentCount30d > 0) {
      statusLines.push(`  Auto preview (30d): ${shadowAuto.headlineText} — ${shadowAuto.sublineText}`);
    }
    return {
      exitCode: 0,
      output: statusLines.join('\n'),
      data: outData
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
    const output = `[Highbeam] Uninstalled ${res.removedHooksCount} hook entries from ${res.settingsPath}`;
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
          output: `[Highbeam Config] Invalid detector ID "${detId}". Expected DET-01..DET-20.`,
          data: res
        };
      }
      return {
        exitCode: 0,
        output: `[Highbeam Config] Set ${res.detectorId}=${res.mode} in ${res.configPath}`,
        data: res
      };
    }
    if (action === 'reset') {
      const res = resetHorizonConfig({ ...options, scope });
      return {
        exitCode: res.ok ? 0 : 1,
        output: `[Highbeam Config] Reset detector overrides at ${res.configPath}`,
        data: res
      };
    }
    const cfg = loadHorizonConfig({ ...options, scope });
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(cfg, null, 2), data: cfg };
    }
    const lines = [
      `[Highbeam Config] FlightMode=${cfg.flightMode} (projectLoaded=${cfg.sources.projectLoaded})`,
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
    const shareSnippet = `⚡ Cost Radar: ${res.summary.retention} · ${res.summary.drift} · ${res.summary.swarm} (via npx ctxtop cost-radar)`;
    const data = { ok, path: target, ...res.summary, shareSnippet };
    if (isJson) {
      return { exitCode: ok ? 0 : 1, output: JSON.stringify(data, null, 2), data };
    }
    return {
      exitCode: ok ? 0 : 1,
      output: `[Highbeam] Cost Radar written: ${target}\n  ${res.summary.retention}\n  ${res.summary.drift}\n  ${res.summary.swarm}${isShare ? `\n  Share: ${shareSnippet}` : ''}`,
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
        `[Highbeam Postmortem] Analyzed ${res.sessionCount} sessions (${estM} active tokens)`,
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
      output: `[Highbeam] Claude Code HUD written: ${target}\n  Verdict: ${res.summary.verdict}\n  Next Action: ${res.summary.action}\n  Saved: +${res.summary.sessionSavedTokens.toLocaleString('en-US')} tokens ($${res.summary.sessionSavedUSD.toFixed(2)}) this session`,
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
          output: `[Highbeam Pro] Pro would expense +$${savedUsd} USD saved over 30d. ${proCheck.upgradeHint}`,
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
        output: `[Highbeam Pro] Corporate Expense Receipt (PDF 1.4) written: ${targetPdf}\n  Receipt ID : ${pdfData.receiptId}\n  30d Saved  : +$${pdfData.workspace30dSavedUSD.toFixed(2)} USD (${pdfData.netRoiMultiplier}x ROI)\n  SHA-256    : ${pdfData.sha256}`,
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
    const ccCap = res.claudeCapabilities;
    const lines = [
      `[Highbeam Doctor] Status: ${res.ok ? 'HEALTHY' : 'ISSUES DETECTED'}`,
      ...res.checks.map((c) => {
        const badge = c.status || (c.ok ? 'PASS' : 'FAIL');
        return `  [${badge}] ${c.id}: ${c.detail}`;
      }),
      ...(ccCap?.found
        ? [
            `  [${ccCap.contractValid ? 'PASS' : 'WARN'}] claude_pre_model_switch: Claude Code ${ccCap.claudeVersion || 'unknown'} | PreModelSwitch=${ccCap.preModelSwitchSupported} | ask=${ccCap.supportsAskDecision} | PreEffortChange=${ccCap.preEffortChangeSummary || formatPreEffortChangeCapability(ccCap)}`
          ]
        : []),
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

  if (subcommand === 'audit') {
    const platIdx = args.indexOf('--platform');
    const platform =
      platIdx !== -1 && args[platIdx + 1]
        ? String(args[platIdx + 1]).toLowerCase()
        : (options.platform || 'all');
    const daysIdx = args.indexOf('--days');
    const days =
      daysIdx !== -1 && args[daysIdx + 1]
        ? Number(args[daysIdx + 1])
        : (options.days || 7);
    const limitIdx = args.indexOf('--limit');
    const limit =
      limitIdx !== -1 && args[limitIdx + 1]
        ? Number(args[limitIdx + 1])
        : (options.limit || 10);

    const auditRes = runSessionAudit({
      ...options,
      platform,
      days,
      limit
    });
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(auditRes, null, 2), data: auditRes };
    }
    return { exitCode: 0, output: formatSessionAuditReport(auditRes), data: auditRes };
  }

  if (subcommand === 'rsl') {
    const action = String(args[1] || 'status').toLowerCase();
    const readFlag = (flag, fallback) => {
      const idx = args.indexOf(flag);
      return idx !== -1 && args[idx + 1] ? String(args[idx + 1]) : fallback;
    };
    const wsRoot = path.resolve(readFlag('--cwd', options.cwd || process.cwd()));
    const platform = readFlag('--platform', options.platform || 'all').toLowerCase();

    if (action === 'status') {
      const summary = { ok: true, platform, ...getRslSummary(wsRoot, options) };
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(summary, null, 2), data: summary };
      }
      const memNote = summary.claudeMemoryAudit?.triggered
        ? `WARN (${summary.claudeMemoryAudit.maxLines}L / ${Math.round(summary.claudeMemoryAudit.maxBytes / 1024)}KB)`
        : 'OK';
      const lines = [
        `[Highbeam RSL] Dual-Platform Self-Learning Status (platform=${platform})`,
        `  Active Carriers : ${summary.activeRules} rules · ${summary.activeSkills} skills · ${summary.promotedHooks} promoted hooks`,
        `  Rule Budget     : ${summary.ruleBudgetTokens}/${summary.ruleBudgetMaxTokens} tokens (${summary.ruleBudgetPct}%)`,
        `  Rule Clashes    : ${summary.clashCount || 0} conflict(s)${summary.quarantinedCount ? ` (${summary.quarantinedCount} quarantined)` : ''}`,
        `  Lifecycle Stats : ${summary.prunedCount} pruned · ${summary.taintedSessions} tainted sessions`,
        `  Claude Memory   : ${memNote}`,
        ...((summary.activeClashes || []).map((c) => `  [RULE_CONFLICT] ${c.reason}`))
      ];
      return { exitCode: 0, output: lines.join('\n'), data: summary };
    }

    if (action === 'list') {
      const includeAll = args.includes('--all') || Boolean(options.all);
      const summary = getRslSummary(wsRoot, { ...options, includeAll });
      const payload = { ok: true, includeAll, count: summary.items.length, items: summary.items };
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      const lines = [`[Highbeam RSL] Heuristics (${payload.count} item(s), all=${includeAll}):`];
      for (const it of summary.items) {
        lines.push(`  - ${it.slug} [${it.carrier}] importance=${it.importance} status=${it.status} hook=${Boolean(it.promotedHook)}`);
      }
      return { exitCode: 0, output: lines.join('\n'), data: payload };
    }

    if (action === 'run') {
      const mode = readFlag('--mode', options.mode || 'local').toLowerCase();
      let sessionId = readFlag('--session', options.sessionId || '');
      if (!sessionId) {
        const telemetryDir = path.join(wsRoot, '.agents', 'telemetry');
        if (fs.existsSync(telemetryDir)) {
          const candidates = fs.readdirSync(telemetryDir)
            .filter((f) => f.endsWith('.rsl_steps.jsonl'))
            .map((f) => ({ name: f.replace(/\.rsl_steps\.jsonl$/, ''), mtime: fs.statSync(path.join(telemetryDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (candidates[0]) sessionId = candidates[0].name;
        }
      }
      sessionId = sanitizeRslSessionId(sessionId || 'default');
      const resolvedPlatform = platform === 'auto' || platform === 'all'
        ? (options.transcriptPath && String(options.transcriptPath).includes('.claude') ? 'claude' : 'antigravity')
        : platform;
      const digest = buildContrastiveDigest(
        {
          conversationId: sessionId,
          session_id: sessionId,
          cwd: wsRoot,
          workspacePaths: [wsRoot],
          transcriptPath: readFlag('--transcript', options.transcriptPath || ''),
          artifactDirectoryPath: readFlag('--artifacts', options.artifactDirectoryPath || '')
        },
        { ...options, cwd: wsRoot, platform: resolvedPlatform }
      );
      const distillation = digest.triggered
        ? distillContrastiveDigest(digest, { mode, sdkRunner: options.sdkRunner })
        : { is_valid_learning: false, mode, heuristics: [] };
      const ledgerResult = (digest.tainted || digest.triggered || fs.existsSync(getRslLedgerPath(wsRoot)))
        ? ingestDistilledHeuristics(wsRoot, distillation, digest, options)
        : null;
      const summary = getRslSummary(wsRoot, options);
      const res = {
        ok: !digest.tainted,
        sessionId,
        platform: resolvedPlatform,
        mode: distillation.mode || mode,
        digest,
        distillation,
        ledgerResult,
        summary
      };
      if (isJson) {
        return { exitCode: res.ok ? 0 : 1, output: JSON.stringify(res, null, 2), data: res };
      }
      const msg = digest.tainted
        ? `[Highbeam RSL] Session ${sessionId} flagged ${digest.status} (${digest.taintDetails.join('; ')}) — extraction aborted.`
        : `[Highbeam RSL] Session ${sessionId} distilled (${res.mode}): +${ledgerResult?.added?.length || 0} added, ${ledgerResult?.upvoted?.length || 0} upvoted, ${ledgerResult?.pruned?.length || 0} pruned.`;
      return { exitCode: res.ok ? 0 : 1, output: msg, data: res };
    }

    if (action === 'promote' || action === 'prune') {
      const slug = args[2] && !args[2].startsWith('-') ? args[2] : (options.slug || '');
      if (!slug) {
        const errRes = { ok: false, error: `Missing <slug> for rsl ${action}` };
        return {
          exitCode: 1,
          output: isJson ? JSON.stringify(errRes, null, 2) : `[Highbeam RSL] ERROR: ${errRes.error}`,
          data: errRes
        };
      }
      const res = action === 'promote'
        ? promoteHeuristic(wsRoot, slug, options)
        : pruneHeuristic(wsRoot, slug, options);
      if (isJson) {
        return { exitCode: res.ok ? 0 : 1, output: JSON.stringify(res, null, 2), data: res };
      }
      return {
        exitCode: res.ok ? 0 : 1,
        output: res.ok
          ? `[Highbeam RSL] ${action === 'promote' ? 'Promoted' : 'Pruned'} heuristic "${res.slug}" across .agents/ and .claude/`
          : `[Highbeam RSL] ERROR: ${res.error}`,
        data: res
      };
    }

    const helpRsl = 'Usage: ctxtop rsl <status|list|run|promote <slug>|prune <slug>> [--platform all|antigravity|claude] [--mode local|sdk] [--json]';
    return {
      exitCode: 1,
      output: isJson ? JSON.stringify({ ok: false, error: `Unknown rsl action: ${action}` }, null, 2) : helpRsl,
      data: { ok: false }
    };
  }

  if (subcommand === 'shield' || subcommand === 'status') {
    const platIdx = args.indexOf('--platform');
    const platform =
      platIdx !== -1 && args[platIdx + 1]
        ? String(args[platIdx + 1]).toLowerCase()
        : (options.platform || 'all');
    const linesIdx = args.indexOf('--max-lines');
    const maxUnslicedLines =
      linesIdx !== -1 && args[linesIdx + 1] ? Number(args[linesIdx + 1]) : options.maxUnslicedLines;

    let action = 'status';
    if (subcommand === 'shield') {
      if (args.includes('--enable') || args[1] === 'enable') action = 'enable';
      else if (args.includes('--disable') || args[1] === 'disable') action = 'disable';
      else action = 'status';
    }

    const baseRes =
      subcommand === 'status'
        ? { ok: true, action: 'status', platform, ...getShieldStatus({ ...options }) }
        : configureShield({
            ...options,
            action,
            platform,
            ...(maxUnslicedLines ? { maxUnslicedLines } : {})
          });

    const offloadIndex =
      subcommand === 'status'
        ? getOffloadIndexStats({
            cwd: options.cwd || process.cwd(),
            homeDir: options.homeDir || getHomeDir(),
            dbPath: options.dbPath || null
          })
        : null;
    const ipcFastPath =
      subcommand === 'status'
        ? {
            pipePath: resolveFastIpcPipePath({ homeDir: options.homeDir || getHomeDir() }),
            socketPresent: (() => {
              const p = resolveFastIpcPipePath({ homeDir: options.homeDir || getHomeDir() });
              return (p && p.startsWith('\\\\.\\pipe\\')) ? null : (p ? fs.existsSync(p) : false);
            })()
          }
        : null;
    const res =
      subcommand === 'status'
        ? { ...baseRes, offloadIndex, ipcFastPath }
        : baseRes;

    if (isJson) {
      return { exitCode: res.ok === false ? 1 : 0, output: JSON.stringify(res, null, 2), data: res };
    }
    const lines = [
      `[Highbeam Shield] Status: ${res.enabled ? 'ACTIVE' : 'PASSIVE'} (action=${res.action}, platform=${platform})`,
      `  Targets       : Antigravity=${res.platforms.antigravity ? 'ON' : 'OFF'} (hooks=${res.hooksConfigured.antigravity}) | Claude=${res.platforms.claude ? 'ON' : 'OFF'} (hooks=${res.hooksConfigured.claude})`,
      `  Read Threshold: >${res.maxUnslicedLines} lines default | >${res.cliffMaxUnslicedLines} lines near pricing cliff`,
      `  Session ROI   : +${res.roi.tokensSaved.toLocaleString('en-US')} tok saved ($${res.roi.dollarsSaved.toFixed(2)} USD) | ${res.roi.readsBlocked} oversized reads indexed`,
      ...(offloadIndex
        ? [
            `  Offload Index : ${offloadIndex.indexedToolLogs} FTS5 CLI logs · ${offloadIndex.indexedArtifacts} artifact(s) (query: npx ctxtop search "<keyword>")`
          ]
        : []),
      ...(res.selfTest ? [`  Self-Test     : ${res.selfTest.detail}`] : [])
    ];
    return { exitCode: res.ok === false ? 1 : 0, output: lines.join('\n'), data: res };
  }

  if (subcommand === 'handoff') {
    const readFlag = (flag, fallback) => {
      const idx = args.indexOf(flag);
      return idx !== -1 && args[idx + 1] ? String(args[idx + 1]) : fallback;
    };
    const wsRoot = path.resolve(readFlag('--cwd', options.cwd || process.cwd()));
    const sessionId = readFlag('--session', options.sessionId || '');
    const result = buildConsolidatedSpecMarkdown(wsRoot, { sessionId });
    let outputPath = null;
    if (args.includes('--write') || Boolean(options.write)) {
      outputPath = path.join(wsRoot, '.agents', 'telemetry', 'CONSOLIDATED_SPEC.md');
      writeTextAtomic(outputPath, `${result.consolidatedMarkdown}\n`);
    }
    const payload = { ...result, ...(outputPath ? { outputPath } : {}) };
    return {
      exitCode: 0,
      output: isJson ? JSON.stringify(payload, null, 2) : payload.consolidatedMarkdown,
      data: payload
    };
  }

  if (subcommand === 'mcp') {
    return import('../packages/mcp/src/server.mjs').then(({ startMcpStdioServer }) => {
      startMcpStdioServer(options);
      if (isCliMain()) {
        globalThis.process?.stdin?.resume?.();
      }
      return { exitCode: 0, output: '', data: { ok: true, mode: 'mcp' } };
    });
  }

  if (subcommand === 'ui' || subcommand === 'serve' || args.includes('--serve')) {
    if (args.includes('--demo')) {
      process.env.HORIZON_DEMO = '1';
    }
    const shouldOpenBrowser = (subcommand === 'ui' || args.includes('--open')) && !args.includes('--no-open');
    return import('../sidecars/horizon-daemon/server.mjs').then(({ startServer }) =>
      startServer().then(({ port }) => {
        const targetUrl = `http://127.0.0.1:${port}`;
        if (shouldOpenBrowser) {
          openBrowserUrl(targetUrl);
        }
        return {
          exitCode: 0,
          output: `✓ Highbeam Web UI Live at: ${targetUrl} (Press Ctrl+C to stop)`,
          data: { ok: true, port, url: targetUrl }
        };
      })
    );
  }

  if (args.includes('--demo') || args.includes('--demo-animate') || args.includes('--roast')) {
    return runLiveOrDemoCli(options);
  }

  const knownSubcommands = new Set([
    'init', 'install', 'uninstall', 'config', 'cost-radar', 'radar', 'panel',
    'receipt', 'doctor', 'statusline', 'inspect', 'control', 'postmortem',
    'audit', 'shield', 'status', 'rsl', 'handoff', 'search', 'log-search',
    'mcp', 'ui', 'serve', 'license', 'pro', 'roast', 'tiers', 'team-pack',
    'verify', 'verify-checksums', '--help', '-h', 'help', '--version', '-v', 'version'
  ]);
  const hasHelp = args.length === 0 || args.includes('--help') || args.includes('-h') || subcommand === 'help';
  const isUnknown = !hasHelp && args.length > 0 && !knownSubcommands.has(subcommand);

  const helpText = [
    'Usage: ctxtop <command> [options]',
    '',
    'Quick Start (Zero-Write & Setup):',
    '  audit [--platform all|antigravity|claude|codex|gemini|cursor] [--days 7] [--json]',
    '                                                                      Zero-write 5-host Sludge Tax & ROI scan',
    '  init [--antigravity|--claude|--cursor|--windsurf|--codex|--gemini-cli|--mcp|--all-hosts]',
    '                                                                      Zero-config multi-host installer',
    '  ui [--open] [--demo]                                                Launch local Simple/Advanced Web UI (127.0.0.1)',
    '  doctor [--diagnostic | --json]                                      Verify contracts, FTS5 index & IPC readiness',
    '',
    'Daily Cockpit & Live UX:',
    '  status [--platform all|antigravity|claude] [--json]                 Show Shield, FTS5 offload & Session ROI status',
    '  statusline [--demo] [--columns N]                                   Responsive single-line statusline bridge',
    '  panel [--advanced] [--out <file.html>]                              Write zero-socket HTML HUD',
    '  radar [--out <file.html>] [--json] [--demo]                         Write SVG KV-cache retention radar timeline',
    '  postmortem [--last N] [--json] [--demo]                             Analyze transcript forensics & rot',
    '  inspect [<session-id> | --last] [--out <file.json>]                 Inspect session trajectory',
    '',
    'Compression, Search & Multi-Host MCP:',
    '  shield <--enable | --disable | --status> [--platform all|...]       Toggle Active Context Shield & read-index guard',
    '  search [<turn-id>] "<keyword>" [--limit 10] [--json]                Search FTS5 offloaded CLI logs & artifacts',
    '  mcp                                                                 Start zero-network 7-tool stdio MCP (@ctxtop/mcp)',
    '',
    'Governance, RSL & FinOps:',
    '  rsl <status|list|run|promote|prune> [--platform ...] [--json]       Dual-platform RSL post-mortem & rule ledger',
    '  handoff [--consolidate] [--session <id>] [--write] [--json]         Consolidate sharded spec constraints & diff',
    '  receipt [--advanced | --markdown | --pdf | --json]                  Print Simple View, Git Receipt, or FinOps PDF',
    '  config [list | set <DET-ID> <mode> | reset]                         Configure per-detector overrides',
    '  control <pause|resume|step|abort|rewind|status>                     Execution control plane command',
    '  verify [--json] | uninstall [--global | --project]                  Verify checksums or remove Highbeam hooks'
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
