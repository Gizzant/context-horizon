#!/usr/bin/env node
/**
 * @file bin/ctxtop.mjs
 * Highbeam v4.4.1 Unified Cross-Platform CLI (`ctxtop`).
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
  crypto,
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
  PLG_TIER_MATRIX,
  resolveEffectiveAutoFlightMode
} from '../src/core/pro_license.mjs';
import { setHorizonFlightMode } from '../src/core/horizon_config.mjs';
import { getShadowAutoSummary } from '../src/core/shadow_auto_ledger.mjs';
import { getTrialSummary, formatTrialSummaryLines, dismissTrialEndNotice } from '../src/core/trial_summary.mjs';
import { generateTeamFinopsPack } from '../packages/pro/src/team_finops_pack.mjs';
import {
  exportEncryptedSyncVault,
  importEncryptedSyncVault,
  inspectSyncVault
} from '../packages/pro/src/encrypted_sync.mjs';
import {
  buildPrCostAttribution,
  formatPrAttributionMarkdown
} from '../packages/pro/src/pr_cost_attribution.mjs';
import {
  buildRedactedDeveloperSnapshot,
  aggregateOrgFinopsRollup,
  formatOrgRollupMarkdown,
  formatOrgRollupCsv
} from '../packages/pro/src/team_finops_rollup.mjs';
import {
  evaluateCiBudgetGate,
  formatCiGateMarkdown
} from '../packages/pro/src/ci_budget_gate.mjs';
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
import {
  computeNextPromptPlaybook,
  formatNextPromptPlaybookCli
} from '../src/core-isomorphic/coach/nextPromptPlaybook.mjs';
import { installPlugin, runLiveOrDemoCli, openBrowserUrl } from '../src/cli/init.mjs';
import { executeStatusLineBridge, runStatusLineCli } from './ah-statusline.mjs';
import { runSessionAudit, formatSessionAuditReport, formatPastWasteLine } from '../src/core/session_auditor.mjs';
import {
  configureShield,
  getShieldStatus,
  configureScout,
  getScoutStatus
} from '../src/core/shield_manager.mjs';
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
  'Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Task|Agent|WebFetch|mcp__.*';
export const LEAN_POST_TOOL_USE_MATCHER =
  'Bash|PowerShell|Grep|Glob|Task|Agent|WebFetch|mcp__.*';

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

/**
 * True when ctxtop is running from a package-runner cache that can be pruned or replaced
 * (npx `_npx`, npm-cache, pnpm/yarn `dlx`, bunx, or the OS temp folder). Hooks must never
 * point there: once the cache is cleared every hook command would reference a missing file.
 */
export function isEphemeralPackageRoot(root, options = {}) {
  const p = String(root || '').replace(/\\/g, '/');
  if (!p) return false;
  if (/\/_npx\//.test(p) || /\/npm-cache\//i.test(p) || /\/dlx[-/]/.test(p) || /\/bunx-/.test(p) || /\/\.bun\/install\/cache\//.test(p)) {
    return true;
  }
  const tmp = String(options.tmpDir ?? os.tmpdir()).replace(/\\/g, '/').replace(/\/+$/, '');
  return Boolean(tmp) && p.startsWith(`${tmp}/`);
}

/**
 * Copies the published package (package.json `files`) into ~/.ctxtop/app/<version>/ so installed
 * hooks keep working after the npx cache is cleared. Re-uses an existing complete copy of the same
 * build (matched on CHECKSUMS.sha256); writes to a temp folder first and renames it into place.
 *
 * @returns {{ root: string, copied: boolean }}
 */
export function ensureStableRuntime(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || PKG_ROOT);
  const homeDir = options.homeDir || os.homedir();
  const pkg = readJsonSafe(path.join(sourceRoot, 'package.json'), {}) || {};
  const version = String(pkg.version || 'dev').replace(/[^0-9A-Za-z._-]/g, '_');
  const appDir = path.join(homeDir, '.ctxtop', 'app');
  const target = path.join(appDir, version);
  const toPosix = (x) => x.replace(/\\/g, '/');
  const marker = path.join(target, '.ctxtop-runtime-complete');
  const checksumsPath = path.join(sourceRoot, 'CHECKSUMS.sha256');
  const buildId = fs.existsSync(checksumsPath)
    ? crypto.createHash('sha256').update(fs.readFileSync(checksumsPath)).digest('hex')
    : `${version}-no-checksums`;

  if (options.dryRun) return { root: toPosix(target), copied: false };
  try {
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === buildId) {
      return { root: toPosix(target), copied: false };
    }
  } catch {
    // fall through and re-copy
  }

  fs.mkdirSync(appDir, { recursive: true });
  const staging = path.join(appDir, `.${version}.staging-${process.pid}-${Date.now()}`);
  const entries = ['package.json', ...(Array.isArray(pkg.files) ? pkg.files : [])];
  try {
    for (const entry of entries) {
      const rel = String(entry).replace(/\/+$/, '');
      const from = path.join(sourceRoot, rel);
      if (!rel || !fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(staging, rel), { recursive: true, dereference: true });
    }
    fs.writeFileSync(path.join(staging, '.ctxtop-runtime-complete'), `${buildId}\n`, 'utf8');
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // best effort
    }
    throw err;
  }
  return { root: toPosix(target), copied: true };
}

const AH_HAIKU_SCOUT_MARKER = '# Highbeam Haiku Scout';

/**
 * Installs `agents/ah-haiku-scout.md` into `<dirname(settingsPath)>/agents/ah-haiku-scout.md`
 * so Claude Code sessions automatically discover the Haiku read-only scout subagent.
 *
 * @param {object} [options={}]
 */
export function installClaudeScoutAgent(options = {}) {
  const settingsPath = resolveSettingsPath(options);
  const sourceRoot = options.sourceRoot || PKG_ROOT;
  const srcAgent = path.join(sourceRoot, 'agents', 'ah-haiku-scout.md');
  const destAgent = path.join(path.dirname(settingsPath), 'agents', 'ah-haiku-scout.md');
  if (options.dryRun || !fs.existsSync(srcAgent)) {
    return {
      ok: fs.existsSync(srcAgent),
      installed: false,
      agentPath: destAgent.replace(/\\/g, '/')
    };
  }
  try {
    const content = fs.readFileSync(srcAgent, 'utf8');
    const ok = writeTextAtomic(destAgent, content);
    return { ok, installed: ok, agentPath: destAgent.replace(/\\/g, '/') };
  } catch (err) {
    void err;
    return { ok: false, installed: false, agentPath: destAgent.replace(/\\/g, '/') };
  }
}

/**
 * Removes the Highbeam-installed `ah-haiku-scout.md` subagent file if it carries the Highbeam marker.
 *
 * @param {object} [options={}]
 */
export function uninstallClaudeScoutAgent(options = {}) {
  const settingsPath = resolveSettingsPath(options);
  const destAgent = path.join(path.dirname(settingsPath), 'agents', 'ah-haiku-scout.md');
  if (options.dryRun || !fs.existsSync(destAgent)) {
    return { ok: true, removed: false, agentPath: destAgent.replace(/\\/g, '/') };
  }
  try {
    const existing = fs.readFileSync(destAgent, 'utf8');
    if (!existing.includes(AH_HAIKU_SCOUT_MARKER)) {
      return { ok: true, removed: false, agentPath: destAgent.replace(/\\/g, '/') };
    }
    fs.unlinkSync(destAgent);
    return { ok: true, removed: true, agentPath: destAgent.replace(/\\/g, '/') };
  } catch (err) {
    void err;
    return { ok: false, removed: false, agentPath: destAgent.replace(/\\/g, '/') };
  }
}

export function installAttentionHorizon(options = {}) {
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const settingsPath = resolveSettingsPath(options);
  const ts = options.timestamp || Date.now();
  const dryRun = Boolean(options.dryRun);
  // Hooks must point at a location that outlives this process. When running from an npx/dlx cache,
  // copy the package to ~/.ctxtop/app/<version>/ first and wire the hooks there.
  const sourceRoot = options.sourceRoot || PKG_ROOT;
  let stableRuntime = null;
  if (!options.pkgRoot && options.stableRuntime !== false && isEphemeralPackageRoot(sourceRoot, options)) {
    stableRuntime = ensureStableRuntime({ sourceRoot, homeDir: options.homeDir, dryRun });
  }
  const pkgRoot = options.pkgRoot
    ? String(options.pkgRoot).replace(/\\/g, '/').replace(/\/+$/, '')
    : stableRuntime
      ? stableRuntime.root
      : String(sourceRoot).replace(/\\/g, '/').replace(/\/+$/, '');

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

  // Claude Code has no `hooks.modules` setting: it skips the key and reports the settings file as invalid
  // (verified on Claude Code 2.1.325). Never write it; remove an entry an older Highbeam install added and keep
  // anything else the user put there.
  if (Array.isArray(currentSettings.hooks.modules)) {
    currentSettings.hooks.modules = currentSettings.hooks.modules.filter(
      (m) => !AH_MOD_REGISTER_REGEX.test(String(m))
    );
    if (currentSettings.hooks.modules.length === 0) {
      delete currentSettings.hooks.modules;
    }
  }

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
  const scoutInstall =
    ok && options.installScoutAgent !== false
      ? installClaudeScoutAgent({ settingsPath, sourceRoot: pkgRoot, dryRun })
      : { ok: true, installed: false, agentPath: null };
  const gitExclude = dryRun ? { updated: false } : ensureGitExcludeEntries(cwd);

  return {
    ok,
    settingsPath,
    backupPath,
    gitExcludeUpdated: gitExclude.updated,
    omittedUnsupportedHooks,
    runtimeRoot: pkgRoot,
    runtimeCopied: Boolean(stableRuntime?.copied),
    scoutAgentPath: scoutInstall.installed ? scoutInstall.agentPath : null,
    settings: currentSettings
  };
}

/**
 * Lists what `uninstall` deliberately leaves behind (existing paths only) so the user can remove it by hand.
 * Nothing here is deleted automatically: the stable runtime copy under ~/.ctxtop/app is shared by every
 * project that installed Highbeam, and license/ledger files are the user's data.
 *
 * @returns {Array<{ path: string, note: string }>}
 */
export function listUninstallLeftovers(options = {}) {
  const settingsPath = resolveSettingsPath(options);
  const cwd = options.cwd || globalThis.process?.cwd?.() || '.';
  const homeDir = options.homeDir || os.homedir();
  const out = [];
  const add = (p, note) => {
    try {
      if (p && fs.existsSync(p)) out.push({ path: String(p).replace(/\\/g, '/'), note });
    } catch {
      // ignore unreadable paths
    }
  };

  try {
    const dir = path.dirname(settingsPath);
    const base = `${path.basename(settingsPath)}.ah-backup.`;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(base)) add(path.join(dir, name), 'settings backup made by install');
    }
  } catch {
    // settings folder may not exist
  }
  add(path.join(cwd, '.claude', 'cache', 'artifacts'), 'saved command output from this project (may contain secrets)');
  add(path.join(cwd, '.claude', 'cache'), 'Highbeam cache for this project');
  add(path.join(homeDir, '.ctxtop', 'app'), 'copy of Highbeam that hooks in other projects may still use; delete only after uninstalling everywhere');
  add(path.join(homeDir, '.ctxtop'), 'license, savings ledger and runtime state');
  add(path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck'), 'Google Antigravity plugin (remove with the Antigravity plugin manager)');
  add(path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon'), 'Highbeam state databases');
  const exclude = path.join(cwd, '.git', 'info', 'exclude');
  try {
    if (fs.existsSync(exclude) && /highbeam|attention-horizon|\.ah-backup|ctxtop/i.test(fs.readFileSync(exclude, 'utf8'))) {
      add(exclude, 'contains Highbeam ignore entries added by install');
    }
  } catch {
    // ignore
  }
  return out;
}

export function uninstallAttentionHorizon(options = {}) {
  const settingsPath = resolveSettingsPath(options);
  const scoutUninstall =
    options.uninstallScoutAgent !== false
      ? uninstallClaudeScoutAgent({ settingsPath, dryRun: Boolean(options.dryRun) })
      : { ok: true, removed: false };
  if (!fs.existsSync(settingsPath)) {
    return {
      ok: true,
      settingsPath,
      removedHooksCount: 0,
      removedScoutAgent: Boolean(scoutUninstall.removed),
      leftovers: listUninstallLeftovers(options),
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
    removedScoutAgent: Boolean(scoutUninstall.removed),
    leftovers: listUninstallLeftovers(options),
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
  let corpOptions = { ...options };
  if (!corpOptions.tierLabel && typeof getProEntitlementStatus === 'function') {
    try {
      const ent = getProEntitlementStatus(options);
      if (ent && ent.entitled) {
        if (ent.tier === 'team') {
          corpOptions.tierLabel = `Highbeam Team Founding Intro ($299.00/yr · $15/seat/mo std · ${ent.seats || 5} seats)`;
          corpOptions.subscriptionCostUSD = Number(corpOptions.subscriptionCostUSD ?? 24.92);
        } else if (ent.tier === 'ltd') {
          corpOptions.tierLabel = 'Highbeam Pro Founder Lifetime ($199.00 one-time)';
          corpOptions.subscriptionCostUSD = Number(corpOptions.subscriptionCostUSD ?? 199.0);
          corpOptions.costPeriodLabel = corpOptions.costPeriodLabel ?? ' one-time';
        } else if (ent.tier === 'pro') {
          corpOptions.tierLabel = 'Highbeam Pro Annual ($149.00/yr · ~$12.42/mo)';
          corpOptions.subscriptionCostUSD = Number(corpOptions.subscriptionCostUSD ?? 12.42);
        }
        if (!corpOptions.email && ent.email) {
          corpOptions.email = ent.email;
        }
      }
    } catch (_entErr) {
      void _entErr;
    }
  }
  const corporateReceipt = generateCorporateExpenseReceipt(summary, corpOptions);

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

export function formatAnonymizedShareReceipt(report = {}, options = {}) {
  const s = report?.summary || {};
  const b = s.buckets || {};
  const av30 = Number(b.avoidedWrites?.workspace30dTokens ?? b.avoidedWrites?.tokens ?? s.workspace30dSavedTokens ?? 0);
  const avUsd = Number(b.avoidedWrites?.workspace30dUSD ?? b.avoidedWrites?.usd ?? s.workspace30dSavedUSD ?? 0);
  const avSes = Number(b.avoidedWrites?.sessionTokens ?? s.sessionSavedTokens ?? 0);
  const avSesUsd = Number(b.avoidedWrites?.sessionUSD ?? s.sessionSavedUSD ?? 0);
  const kv30 = Number(b.platformCacheDiscount?.workspace30dTokens ?? b.platformCacheDiscount?.tokens ?? 0);
  const kvUsd = Number(b.platformCacheDiscount?.workspace30dUSD ?? b.platformCacheDiscount?.usd ?? 0);
  const real = b.realizedPromptBill || {};
  const realCount = Number(real.count || 0);
  const realTok = Number(real.workspace30dTokens ?? real.tokens ?? 0);
  const realUsd = Number(real.workspace30dUSD ?? real.usd ?? 0);
  const realLine = realCount > 0
    ? `${realTok >= 0 ? '+' : '-'}${Math.abs(realTok).toLocaleString('en-US')} tok (${realUsd >= 0 ? '+' : '-'}$${Math.abs(realUsd).toFixed(4)})`
    : 'n/a (local session — wire A/B only)';
  let out = [
    'Highbeam v4.4.1 — Anonymized Savings Snapshot (Local / Zero-PII)',
    `  1. Highbeam Avoided Writes (Real-Time) : 30d +${av30.toLocaleString('en-US')} tok ($${avUsd.toFixed(2)}) | session +${avSes.toLocaleString('en-US')} tok ($${avSesUsd.toFixed(2)})`,
    `  2. Ex-Post Realized Prompt-Bill Delta    : ${realLine}`,
    `  3. Provider KV-Cache Discount (separate) : +${kv30.toLocaleString('en-US')} tok ($${kvUsd.toFixed(2)}) [never counted in Highbeam ROI]`,
    '  Run read-only on your own logs: npx highbeam-cli audit --days 7'
  ].join('\n');
  let user = '';
  try { user = os.userInfo().username || ''; } catch (_uErr) { void _uErr; }
  const cwd = options.cwd || '';
  const secrets = [cwd, cwd ? path.basename(cwd) : '', options.homeDir, os.homedir(), os.hostname(), user]
    .filter((v) => typeof v === 'string' && v.trim().length >= 3);
  for (const sec of secrets) {
    out = out.split(sec).join('[redacted]');
  }
  return out.replace(/(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s)\]]+/g, '[redacted]');
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
    `│ Estimated Savings  : +${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)} USD saved in 30d)            │`,
    '│ Top Remediation    : Fence mid-session CLAUDE.md/AGENTS.md edits (DET-09)  │',
    '╰────────────────────────────────────────────────────────────────────────────╯',
    `Share: Shielded +${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)}) with npx highbeam-cli --roast #ClaudeCode #Antigravity`
  ].join('\n');

  const markdown = [
    '### 🔥 Highbeam Context Roast (`npx highbeam-cli --roast`)',
    `- **KV-Cache Retention**: Grade **${retentionGrade}** (${retentionPct}% warmth retained)`,
    `- **Cold Prefill Leak**: **$${leakedUsd.toFixed(2)}** burned on avoidable cold switches`,
    `- **30-Day Estimated Savings**: **+${savedTok.toLocaleString('en-US')} tokens ($${savedUsd.toFixed(2)} USD)**`,
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

  if (isWorkspace && isGlobal) {
    return {
      exitCode: 1,
      output: '[Highbeam] Choose one scope: --global or --project (--workspace), not both.',
      data: { ok: false, error: 'CONFLICTING_SCOPE_FLAGS' }
    };
  }
  // Each host has its own default: Claude Code installs into this project unless --global;
  // Antigravity installs globally unless --project/--workspace. Report each host's real scope.
  const claudeScope = isGlobal ? 'global' : 'project';
  const antigravityScope = isWorkspace ? 'project' : 'global';
  const scopeParts = [];
  if (isAll || isClaude) scopeParts.push(`Claude Code: ${claudeScope === 'global' ? 'Global (all projects)' : 'This project only'}`);
  if (isAll || isAntigravity) scopeParts.push(`Antigravity: ${antigravityScope === 'global' ? 'Global' : 'This workspace only'}`);

  const lines = [
    `\x1b[1m\x1b[38;5;51m⚡ Highbeam (ctxtop v4.4.1) — Zero-Config Unified Installer\x1b[0m`,
    `  • Target Harnesses : ${targetLabel}`,
    ...(scopeParts.length
      ? [`  • Installation Scope: ${scopeParts.join(' · ')}${isDryRun ? ' [DRY RUN]' : ''}`]
      : isDryRun
        ? ['  • [DRY RUN]']
        : [])
  ];

  let claudeResult = null;
  let antigravityResult = null;
  let mcpResult = null;
  let hostMcpResult = null;

  if (isClaude || isAll) {
    const scope = claudeScope;
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
    if (claudeResult.runtimeCopied) {
      lines.push(`  • Hooks run from a stable copy: ${claudeResult.runtimeRoot}`);
    }
  }

  if (isAntigravity || isAll) {
    try {
      const agyInstall = installPlugin({
        dryRun: isDryRun,
        workspace: isWorkspace,
        dedupe: isDedupe,
        leanHooks: isLeanHooks,
        fullHooks: isFullHooks,
        enable: args.includes('--enable') || Boolean(options.enable),
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

  // Report commands read the savings ledger. Hooks write it to <project>/.claude/cache/,
  // so when run from a project that has one, read it there instead of the home-store fallback.
  if (
    ['receipt', 'panel', 'roast', 'radar', 'cost-radar'].includes(subcommand) &&
    !options.cwd &&
    !options.ledgerPath
  ) {
    const projectCwd = globalThis.process?.cwd?.();
    if (projectCwd && fs.existsSync(path.join(projectCwd, '.claude', 'cache', 'horizon_ledger.jsonl'))) {
      options = { ...options, cwd: projectCwd };
    }
  }

  if (effectiveArgs.includes('--version') || effectiveArgs.includes('-v') || subcommand === 'version') {
    return { exitCode: 0, output: '4.4.1', data: { version: '4.4.1' } };
  }

  // `<cmd> --help` must print help and never run the command (install/init/uninstall write files).
  if (
    ['install', 'init', 'uninstall'].includes(subcommand) &&
    (effectiveArgs.includes('--help') || effectiveArgs.includes('-h'))
  ) {
    const lines = {
      install: [
        'Usage: highbeam install [--global] [--full-hooks | --lean-hooks]',
        '',
        'Adds Highbeam hooks to Claude Code settings without removing existing entries.',
        '  --global       write to ~/.claude/settings.json instead of this project',
        '  --lean-hooks   register the small hook set (default)',
        '  --full-hooks   register every hook',
        'A backup of the settings file is saved before it is changed.'
      ],
      init: [
        'Usage: highbeam init [--antigravity|--claude|--cursor|--windsurf|--codex|--gemini-cli|--mcp|--all-hosts] [--global | --project] [--enable]',
        '',
        'Zero-config installer: sets Highbeam up for the chosen host(s).',
        'With no host flag it installs for Antigravity and Claude Code.',
        'Default scope: Claude Code -> this project; Antigravity -> global.',
        '  --global    install globally for every selected host',
        '  --project   install into this project/workspace for every selected host (alias: --workspace)'
      ],
      uninstall: [
        'Usage: highbeam uninstall [--global | --project]',
        '',
        'Removes Highbeam hook entries from the Claude Code settings file.',
        'It does not delete backups, saved output, licenses or the ~/.ctxtop folder; it lists what is left so you can remove it.'
      ]
    };
    return {
      exitCode: 0,
      output: lines[subcommand].join('\n'),
      data: { help: true, command: subcommand }
    };
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
    if (initRes.exitCode === 0 && !args.includes('--no-audit') && options.pastWasteTeaser !== false) {
      try {
        const line = formatPastWasteLine(runSessionAudit({ ...options, platform: 'all', days: 7 }));
        if (line) return { ...initRes, output: `${initRes.output}\n\n[Highbeam] ${line}` };
      } catch (err) {
        void err; // the teaser is optional; never break init
      }
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
    const runtimeNote = res.runtimeCopied ? `\nHooks run from a stable copy: ${res.runtimeRoot}` : '';
    const output = `[Highbeam] Installed non-destructively into ${res.settingsPath}${backupNote}${runtimeNote}`;
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

  const getCliFlag = (flagName) => {
    for (let i = 0; i < effectiveArgs.length; i++) {
      const a = String(effectiveArgs[i] || '');
      if (a === flagName && effectiveArgs[i + 1] !== undefined) {
        return String(effectiveArgs[i + 1]);
      }
      if (a.startsWith(`${flagName}=`)) {
        return a.slice(flagName.length + 1);
      }
    }
    return undefined;
  };

  if (subcommand === 'sync') {
    const rawAction = String(effectiveArgs[1] || 'inspect').toLowerCase();
    const action = rawAction.startsWith('-') ? 'inspect' : rawAction;
    const preview = effectiveArgs.includes('--preview') || Boolean(options.preview);
    const outPath = getCliFlag('--out') ? path.resolve(getCliFlag('--out')) : options.outPath;
    const inPath = getCliFlag('--in') ? path.resolve(getCliFlag('--in')) : options.inPath;
    const passphrase = getCliFlag('--passphrase') ?? options.passphrase;
    const dryRun = effectiveArgs.includes('--dry-run') || Boolean(options.dryRun);

    if (action === 'export') {
      const res = exportEncryptedSyncVault({ ...options, outPath, passphrase, preview });
      if (!res.ok) {
        const isEntFail = res.entitlement && !res.entitlement.allowed;
        const msg = isEntFail ? `[Highbeam Pro] ${res.upgradeHint || res.entitlement.upgradeHint}` : `[Highbeam Sync] ${res.error}`;
        return { exitCode: isEntFail ? 2 : 1, output: isJson ? JSON.stringify(res, null, 2) : msg, data: res };
      }
      const msg = `[Highbeam Sync] Encrypted vault written to: ${res.outPath} (${res.counts.ledgerEntries} ledger, ${res.counts.episodicRecords} episodic, ${res.counts.instincts} instincts; ${res.redactedSecretsCount} secrets scrubbed)`;
      return { exitCode: 0, output: isJson ? JSON.stringify(res, null, 2) : msg, data: res };
    }

    if (action === 'import') {
      const res = importEncryptedSyncVault({ ...options, inPath, passphrase, dryRun, preview });
      if (!res.ok) {
        const isEntFail = res.entitlement && !res.entitlement.allowed;
        const msg = isEntFail ? `[Highbeam Pro] ${res.upgradeHint || res.entitlement.upgradeHint}` : `[Highbeam Sync] ${res.error}`;
        return { exitCode: isEntFail ? 2 : 1, output: isJson ? JSON.stringify(res, null, 2) : msg, data: res };
      }
      const msg = `[Highbeam Sync] ${dryRun ? 'Dry-run merged' : 'Imported'} vault: +${res.added.ledgerEntries} ledger, +${res.added.episodicRecords} episodic (${res.updated.episodicRecords} updated), +${res.added.instincts} instincts`;
      return { exitCode: 0, output: isJson ? JSON.stringify(res, null, 2) : msg, data: res };
    }

    if (action === 'inspect') {
      const entitlement = requireProFeature('encrypted_memory_sync', options);
      if (!entitlement.allowed && !preview) {
        return {
          exitCode: 2,
          output: isJson ? JSON.stringify({ ok: false, entitlement }, null, 2) : `[Highbeam Pro] ${entitlement.upgradeHint}`,
          data: { ok: false, entitlement }
        };
      }
      const targetVault = inPath || outPath || path.resolve(options.cwd || process.cwd(), 'highbeam-sync.vault.json');
      const meta = inspectSyncVault(targetVault);
      if (!meta.ok) {
        return { exitCode: 1, output: isJson ? JSON.stringify(meta, null, 2) : `[Highbeam Sync] ${meta.error}`, data: meta };
      }
      const msg = `[Highbeam Sync] Vault (${meta.format}) machine=${meta.machineFingerprint} created=${meta.createdAt} ledger=${meta.counts.ledgerEntries} episodic=${meta.counts.episodicRecords} instincts=${meta.counts.instincts}`;
      return { exitCode: 0, output: isJson ? JSON.stringify(meta, null, 2) : msg, data: meta };
    }

    return {
      exitCode: 1,
      output: 'Usage: highbeam sync <export|import|inspect> [--out <vault.json> | --in <vault.json>] [--passphrase <secret>] [--dry-run] [--json]',
      data: { ok: false, error: `Unknown sync action: ${action}` }
    };
  }

  if (subcommand === 'pr-cost') {
    const base = getCliFlag('--base') || options.base || 'main';
    const head = getCliFlag('--head') || options.head || 'HEAD';
    const outPath = getCliFlag('--out') ? path.resolve(getCliFlag('--out')) : options.outPath;
    const preview = effectiveArgs.includes('--preview') || Boolean(options.preview);
    const res = buildPrCostAttribution({ ...options, base, head, preview });
    if (!res.ok) {
      const isEntFail = res.entitlement && !res.entitlement.allowed;
      const msg = isEntFail ? `[Highbeam Pro] ${res.upgradeHint || res.entitlement.upgradeHint}` : `[Highbeam PR Cost] ${res.error}`;
      return { exitCode: isEntFail ? 2 : 1, output: isJson ? JSON.stringify(res, null, 2) : msg, data: res };
    }
    const textOut = isJson ? JSON.stringify(res, null, 2) : formatPrAttributionMarkdown(res);
    if (outPath) {
      writeTextAtomic(outPath, textOut);
    }
    return { exitCode: 0, output: textOut, data: res };
  }

  if (subcommand === 'team-rollup') {
    const preview = effectiveArgs.includes('--preview') || Boolean(options.preview);
    const outPath = getCliFlag('--out') ? path.resolve(getCliFlag('--out')) : options.outPath;
    const inDir = getCliFlag('--in') ? path.resolve(getCliFlag('--in')) : options.inDir;
    const orgSalt = getCliFlag('--salt') || options.orgSalt;
    const orgName = getCliFlag('--org') || options.orgName;
    const seats = getCliFlag('--seats') ? Number(getCliFlag('--seats')) : options.seats;
    const formatFlag = String(getCliFlag('--format') || (effectiveArgs.includes('--csv') ? 'csv' : isJson ? 'json' : 'md')).toLowerCase();

    if (effectiveArgs.includes('--export-snapshot')) {
      const snapRes = buildRedactedDeveloperSnapshot({ ...options, orgSalt, preview });
      if (!snapRes.ok) {
        const isEntFail = snapRes.entitlement && !snapRes.entitlement.allowed;
        const msg = isEntFail ? `[Highbeam Team] ${snapRes.upgradeHint || snapRes.entitlement.upgradeHint}` : `[Highbeam Team] Snapshot verification failed`;
        return { exitCode: isEntFail ? 2 : 1, output: isJson ? JSON.stringify(snapRes, null, 2) : msg, data: snapRes };
      }
      const jsonOut = JSON.stringify(snapRes.snapshot, null, 2) + '\n';
      if (outPath) {
        writeTextAtomic(outPath, jsonOut);
      }
      return {
        exitCode: 0,
        output: isJson ? JSON.stringify(snapRes, null, 2) : jsonOut,
        data: snapRes
      };
    }

    const rollupRes = aggregateOrgFinopsRollup({ ...options, inDir, orgName, seats, preview });
    if (!rollupRes.ok) {
      const isEntFail = rollupRes.entitlement && !rollupRes.entitlement.allowed;
      const msg = isEntFail ? `[Highbeam Team] ${rollupRes.upgradeHint || rollupRes.entitlement.upgradeHint}` : `[Highbeam Team] ${rollupRes.error}`;
      return { exitCode: isEntFail ? 2 : 1, output: isJson ? JSON.stringify(rollupRes, null, 2) : msg, data: rollupRes };
    }
    const rendered =
      formatFlag === 'json'
        ? JSON.stringify(rollupRes, null, 2)
        : formatFlag === 'csv'
          ? formatOrgRollupCsv(rollupRes)
          : formatOrgRollupMarkdown(rollupRes);
    if (outPath) {
      writeTextAtomic(outPath, rendered);
    }
    return { exitCode: 0, output: rendered, data: rollupRes };
  }

  if (subcommand === 'ci-gate') {
    const preview = effectiveArgs.includes('--preview') || Boolean(options.preview);
    const base = getCliFlag('--base') || options.base || 'main';
    const head = getCliFlag('--head') || options.head || 'HEAD';
    const inputPath = getCliFlag('--input') ? path.resolve(getCliFlag('--input')) : options.inputPath;
    const outPath = getCliFlag('--out') ? path.resolve(getCliFlag('--out')) : options.outPath;
    const ghAnnotations = effectiveArgs.includes('--github-annotations');

    const policyOverrides = {};
    if (getCliFlag('--max-cost-usd') !== undefined) policyOverrides.maxPrCostUsd = Number(getCliFlag('--max-cost-usd'));
    if (getCliFlag('--max-tokens') !== undefined) policyOverrides.maxPrTokens = Number(getCliFlag('--max-tokens'));
    if (getCliFlag('--min-cache-pct') !== undefined) policyOverrides.minCacheHitPct = Number(getCliFlag('--min-cache-pct'));
    if (getCliFlag('--max-waste-pct') !== undefined) policyOverrides.maxWasteRatioPct = Number(getCliFlag('--max-waste-pct'));
    if (getCliFlag('--max-ring0') !== undefined) policyOverrides.maxRing0Violations = Number(getCliFlag('--max-ring0'));
    if (getCliFlag('--mode') !== undefined) policyOverrides.mode = getCliFlag('--mode');

    const gateRes = evaluateCiBudgetGate({ ...options, base, head, inputPath, policyOverrides, preview });
    if (gateRes.verdict === 'BLOCKED') {
      return {
        exitCode: 2,
        output: isJson ? JSON.stringify(gateRes, null, 2) : `[Highbeam Team] ${gateRes.upgradeHint}`,
        data: gateRes
      };
    }
    if (gateRes.verdict === 'ERROR') {
      return {
        exitCode: 1,
        output: isJson ? JSON.stringify(gateRes, null, 2) : `[Highbeam CI Gate] ${gateRes.error}`,
        data: gateRes
      };
    }

    const md = formatCiGateMarkdown(gateRes);
    const annotatedMd =
      ghAnnotations && gateRes.annotations.length > 0 ? `${gateRes.annotations.join('\n')}\n\n${md}` : md;
    const finalOut = isJson ? JSON.stringify(gateRes, null, 2) : isMarkdown || !ghAnnotations ? annotatedMd : annotatedMd;
    if (outPath) {
      writeTextAtomic(outPath, isJson ? JSON.stringify(gateRes, null, 2) : md);
    }
    return { exitCode: gateRes.exitCode, output: finalOut, data: gateRes };
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

  const formatTierLines = () => [
    'Highbeam — 3-Tier Self-Expensing PLG Funnel:',
    `  • Free ($0/mo): ${PLG_TIER_MATRIX.free.features.join(', ')}`,
    `  • Pro ($${PLG_TIER_MATRIX.pro.priceLtdUSD} Founder Lifetime Cap-${PLG_TIER_MATRIX.pro.ltdCap} · $${PLG_TIER_MATRIX.pro.priceAnnualUSD}/yr expensable): ${PLG_TIER_MATRIX.pro.features.join(', ')}`,
    `  • Team ($${PLG_TIER_MATRIX.team.starterAnnualUSD}/yr Founding ${PLG_TIER_MATRIX.team.starterSeats}-Seat Intro; $${PLG_TIER_MATRIX.team.pricePerSeatMonthlyUSD}/seat/mo std [$${PLG_TIER_MATRIX.team.standardAnnual5SeatUSD}/yr 5-seat min]; Free 60d Pilot & $1.5k-$3k Audit: sales@highbeamdev.com): ${PLG_TIER_MATRIX.team.features.join(', ')}`
  ];

  if (subcommand === 'tiers') {
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(PLG_TIER_MATRIX, null, 2), data: PLG_TIER_MATRIX };
    }
    return { exitCode: 0, output: formatTierLines().join('\n'), data: PLG_TIER_MATRIX };
  }

  if (subcommand === 'license' || subcommand === 'pro') {
    const action = String(args[1] || 'status').toLowerCase();
    if (action === 'tiers') {
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(PLG_TIER_MATRIX, null, 2), data: PLG_TIER_MATRIX };
      }
      return { exitCode: 0, output: formatTierLines().join('\n'), data: PLG_TIER_MATRIX };
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
          output: `[Highbeam Pro] 14-day trial already expired (${trRes.expiresAt || ''}). Unlock Pro with: npx highbeam-cli license activate <CTXP1-KEY>`,
          data: trRes
        };
      }
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(trRes, null, 2), data: trRes };
      }
      if (trRes.alreadyLicensed) {
        return {
          exitCode: 0,
          output: `[Highbeam Pro] A paid ${String(trRes.tier || 'pro').toUpperCase()} license is already active (${trRes.licensePath}); no trial needed.`,
          data: trRes
        };
      }
      return {
        exitCode: 0,
        output: `[Highbeam Pro] Activated 14-day local trial (expires ${trRes.expiresAt}) -> ${trRes.licensePath}\n  ${
          String(loadHorizonConfig({ ...options, cwd: options.cwd || process.cwd() })?.flightMode || '').toUpperCase() === 'AUTO_PILOT'
            ? 'Auto is on for the trial.'
            : 'Auto is available but stays off until you turn it on: npx highbeam-cli mode auto'
        }`,
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
    const trialSummary = getTrialSummary({ ...options, cwd: options.cwd || process.cwd() });
    dismissTrialEndNotice(options);
    const outData = { ...status, shadowAuto, trialSummary };
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(outData, null, 2), data: outData };
    }
    const statusLines = [
      `[Highbeam Pro] Tier=${status.tier} | Entitled=${status.entitled} | Source=${status.source}`
    ];
    if (trialSummary.state !== 'none') {
      statusLines.push(...formatTrialSummaryLines(trialSummary));
    } else if (status.trialExpired) {
      statusLines.push('  Trial ended: Auto is paused and Highbeam runs COACH (shows, changes nothing). Keep Auto: npx highbeam-cli license activate <CTXP1-KEY>');
    }
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
    const leftoverLines = (res.leftovers || []).map((l) => `  - ${l.path}  (${l.note})`);
    const output =
      `[Highbeam] Uninstalled ${res.removedHooksCount} hook entries from ${res.settingsPath}` +
      (leftoverLines.length
        ? `\n\nNot removed (delete by hand if you want everything gone):\n${leftoverLines.join('\n')}`
        : '');
    return { exitCode: res.ok ? 0 : 1, output, data: res };
  }

  if (subcommand === 'mode') {
    // Flight mode: COACH (default, shows and advises), AUTO_PILOT (acts; needs Pro or the trial),
    // SILENT, OFF. Without Pro or the trial, AUTO_PILOT runs as COACH and only shows what it would do.
    const requested = args[1] && !String(args[1]).startsWith('-') ? String(args[1]) : null;
    const modeOpts = { ...options, cwd: options.cwd || process.cwd(), ...(args.includes('--project') ? { scope: 'project' } : {}) };
    let configured;
    let configPath = null;
    if (requested) {
      const setRes = setHorizonFlightMode(requested, modeOpts);
      if (!setRes.ok) {
        return { exitCode: 1, output: `[Highbeam] Could not save flight mode to ${setRes.configPath}`, data: setRes };
      }
      configured = setRes.flightMode;
      configPath = setRes.configPath;
    } else {
      configured = String(loadHorizonConfig(modeOpts)?.flightMode || 'COACH').toUpperCase();
    }
    const eff = resolveEffectiveAutoFlightMode(configured, options);
    const status = eff.proStatus || getProEntitlementStatus(options);
    const trialSummary = getTrialSummary({ ...options, cwd: options.cwd || process.cwd() });
    dismissTrialEndNotice(options);
    const data = {
      configuredMode: configured,
      effectiveMode: eff.effectiveFlightMode,
      steppedDown: Boolean(eff.steppedDown),
      tier: status?.tier || null,
      trialExpired: Boolean(status?.trialExpired),
      trialSummary,
      configPath
    };
    if (isJson) return { exitCode: 0, output: JSON.stringify(data, null, 2), data };
    const lines = [
      configPath
        ? `[Highbeam] Flight mode set to ${configured} (${configPath})`
        : `[Highbeam] Flight mode: ${configured}${eff.steppedDown ? ' (running as COACH)' : ''}`
    ];
    if (eff.steppedDown) {
      if (trialSummary.state !== 'ended') {
        lines.push(
          status?.trialExpired
            ? '  Your 14-day trial has ended, so Auto is paused and Highbeam runs COACH: it shows what Auto would have saved but changes nothing. Keep Auto: npx highbeam-cli license activate <CTXP1-KEY>'
            : '  Auto needs Highbeam Pro or the 14-day trial. Until then Highbeam runs COACH and shows what Auto would have saved. Try it: npx highbeam-cli license trial'
        );
      }
    } else if (eff.effectiveFlightMode === 'AUTO_PILOT' && status?.tier === 'trial' && status?.expiresAt) {
      const nowMs = Number(options.nowMs || Date.now());
      const daysLeft = Math.max(0, Math.ceil((Date.parse(status.expiresAt) - nowMs) / 86400000));
      lines.push(`  Trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. After that Auto pauses and Highbeam runs COACH until you activate Pro.`);
    } else if (configured === 'COACH') {
      lines.push('  COACH shows savings and warnings and stops only destructive commands and repeat-failure loops. Let Highbeam act for you: npx highbeam-cli mode auto');
    }
    if (trialSummary.state !== 'none') lines.push(...formatTrialSummaryLines(trialSummary));
    return { exitCode: 0, output: lines.join('\n'), data };
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
    const shareSnippet = `⚡ Cost Radar: ${res.summary.retention} · ${res.summary.drift} · ${res.summary.swarm} (via npx highbeam-cli cost-radar)`;
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
    const isShare = args.includes('--share') || Boolean(options.share);
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
    if (isShare) {
      const shareText = formatAnonymizedShareReceipt(res, options);
      if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        writeTextAtomic(outPath, isJson ? JSON.stringify({ ok: true, card: shareText, buckets: res.summary?.buckets || {} }, null, 2) : shareText);
      }
      if (isJson) {
        const shareData = { ok: true, zeroPii: true, card: shareText, buckets: res.summary?.buckets || {} };
        return { exitCode: 0, output: JSON.stringify(shareData, null, 2), data: shareData };
      }
      return { exitCode: 0, output: shareText, data: { ok: true, zeroPii: true, card: shareText, buckets: res.summary?.buckets || {} } };
    }
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
      const targetPdf = outPath || path.resolve(options.cwd || process.cwd(), 'highbeam-expense-receipt.pdf');
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

    const helpRsl = 'Usage: highbeam rsl <status|list|run|promote <slug>|prune <slug>> [--platform all|antigravity|claude] [--mode local|sdk] [--json]';
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
      else if (args.includes('--auto') || args[1] === 'auto') action = 'auto';
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
    const liveState = options.state || readLiveStateSnapshot(options.sessionId || 'default', { ...options, cwd: options.cwd || process.cwd() }) || {};
    const nextPromptPlaybook = computeNextPromptPlaybook({
      modelId: liveState?.model?.canonicalId || liveState?.model?.id || liveState?.activeModel || (platform === 'claude' ? 'claude-sonnet-5-5' : 'unknown'),
      effort: liveState?.activeEffortProfile?.shortLabel || liveState?.thinkingEffort || 'Auto',
      cachedTokens: Number(liveState?.quota?.cache?.cacheReadTokens ?? liveState?.window?.cachedTokens ?? 0),
      totalTokens: Number(liveState?.window?.totalActiveTokens ?? liveState?.totalInputTokens ?? 0),
      contextCeiling: Number(liveState?.window?.maxTokens ?? liveState?.model?.nativeCeilingTokens ?? 200_000),
      safeLimit: Number(liveState?.window?.safeLimit ?? 0),
      cacheWarm: typeof liveState?.sessionRisk?.isCacheTrulyWarm === 'boolean' ? liveState.sessionRisk.isCacheTrulyWarm : false,
      cacheTtlTier: liveState?.quota?.cache?.cacheTtlTier || '5m',
      ttlRemainingSec: liveState?.quota?.cache?.ttlRemainingSec ?? null,
      isCrisis: Boolean(liveState?.window?.isCrisis),
      host: platform === 'claude' ? 'claude' : (baseRes.platforms.claude && !baseRes.platforms.antigravity ? 'claude' : 'antigravity')
    });
    const res =
      subcommand === 'status'
        ? { ...baseRes, offloadIndex, ipcFastPath, nextPromptPlaybook }
        : baseRes;

    if (isJson) {
      return { exitCode: res.ok === false ? 1 : 0, output: JSON.stringify(res, null, 2), data: res };
    }
    const statusLabel = res.enabled ? 'ACTIVE' : res.mode === 'auto' ? 'AUTO (clamp-only)' : 'DISABLED';
    const claudeLabel = res.platforms.claude ? 'ON' : res.mode === 'auto' ? 'AUTO (clamp-only)' : 'OFF';
    const playbookBlock = subcommand === 'status' ? formatNextPromptPlaybookCli(nextPromptPlaybook) : '';
    const lines = [
      `[Highbeam Shield] Status: ${statusLabel} (action=${res.action}, platform=${platform})`,
      `  Targets       : Antigravity=${res.platforms.antigravity ? 'ON' : 'OFF'} (hooks=${res.hooksConfigured.antigravity}) | Claude=${claudeLabel} (hooks=${res.hooksConfigured.claude})`,
      `  Read Threshold: >${res.maxUnslicedLines} lines default | >${res.cliffMaxUnslicedLines} lines near pricing cliff`,
      `  Session ROI   : +${res.roi.tokensSaved.toLocaleString('en-US')} tok saved ($${res.roi.dollarsSaved.toFixed(2)} USD) | ${res.roi.readsClamped || 0} clamped, ${res.roi.readsBlocked} oversized reads indexed`,
      ...(offloadIndex
        ? [
            `  Offload Index : ${offloadIndex.indexedToolLogs} FTS5 CLI logs · ${offloadIndex.indexedArtifacts} artifact(s) (query: npx highbeam-cli search "<keyword>")`
          ]
        : []),
      ...(playbookBlock ? [playbookBlock] : []),
      ...(res.selfTest ? [`  Self-Test     : ${res.selfTest.detail}`] : [])
    ];
    return { exitCode: res.ok === false ? 1 : 0, output: lines.join('\n'), data: res };
  }

  if (subcommand === 'scout') {
    const cwdFlag = getCliFlag('--cwd');
    const scoutCwd = path.resolve(cwdFlag || options.cwd || process.cwd());
    let action = 'status';
    if (args.includes('--enable') || args[1] === 'enable') action = 'enable';
    else if (args.includes('--disable') || args[1] === 'disable') action = 'disable';
    else if (args.includes('--status') || args[1] === 'status' || !args[1]) action = 'status';
    else action = String(args[1]).toLowerCase();

    const scoutRes = configureScout({
      ...options,
      cwd: scoutCwd,
      action
    });
    const res = scoutRes;
    if (isJson) {
      return { exitCode: res.ok === false ? 1 : 0, output: JSON.stringify(res, null, 2), data: res };
    }
    const modeLabel = res.autoTierReadOnlyScouts ? 'ENABLED (COACH Haiku auto-tier)' : 'ADVISORY-ONLY (COACH opt-in off)';
    const lines = [
      `[Highbeam Scout] Auto-Tier: ${modeLabel} (action=${res.action})`,
      `  Agent File    : ${res.agentPath} (${res.agentInstalled ? 'installed' : 'missing'})`,
      `  100k Cliff Cap: ${res.autoCompactSafe ? 'OK (autoCompactWindow <= 90,000)' : `WARN (${(res.unguardedAgents || []).map((a) => a.file).join(', ')})`}`
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
    'audit', 'shield', 'scout', 'status', 'rsl', 'handoff', 'search', 'log-search',
    'mcp', 'ui', 'serve', 'license', 'pro', 'roast', 'tiers', 'team-pack',
    'sync', 'pr-cost', 'team-rollup', 'ci-gate',
    'verify', 'verify-checksums', 'mode', '--help', '-h', 'help', '--version', '-v', 'version'
  ]);
  const hasHelp = args.length === 0 || args.includes('--help') || args.includes('-h') || subcommand === 'help';
  const isUnknown = !hasHelp && args.length > 0 && !knownSubcommands.has(subcommand);

  const helpText = [
    'Usage: highbeam <command> [options]',
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
    '  shield <--enable | --disable | --auto | --status> [--platform all|...] Toggle Active Context Shield & read-index guard',
    '  scout <--enable | --disable | --status> [--cwd <dir>] [--json]      Toggle Haiku read-only scout auto-tiering & install agent',
    '  search [<turn-id>] "<keyword>" [--limit 10] [--json]                Search FTS5 offloaded CLI logs & artifacts',
    '  mcp                                                                 Start zero-network 7-tool stdio MCP server',
    '',
    'Governance, RSL & FinOps:',
    '  rsl <status|list|run|promote|prune> [--platform ...] [--json]       Dual-platform RSL post-mortem & rule ledger',
    '  handoff [--consolidate] [--session <id>] [--write] [--json]         Consolidate sharded spec constraints & diff',
    '  receipt [--advanced | --markdown | --pdf | --share | --json]        Print Simple View, Share Card, Git Receipt, or PDF',
    '  sync <export|import|inspect> [--out|--in <file>] [--passphrase]     Pro: Encrypted cross-machine memory & ledger sync',
    '  pr-cost [--base main] [--head HEAD] [--markdown | --json]           Pro: Git branch & PR token/USD cost attribution',
    '  team-rollup [--export-snapshot | --in <dir>] [--format json|md|csv] Team: Zero-knowledge org FinOps rollup',
    '  ci-gate [--base main] [--max-cost-usd N] [--mode enforce|advisory]  Team: CI/PR token-budget enforcement gate',
    '  mode [coach | auto | silent | off] [--project]                      Show or set the flight mode (auto needs Pro or the trial)',
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
  installClaudeScoutAgent,
  uninstallClaudeScoutAgent,
  installAttentionHorizon,
  uninstallAttentionHorizon,
  inspectHookDiagnostics,
  runDoctorDiagnostics,
  generateReceiptReport,
  formatAnonymizedShareReceipt,
  generateHorizonPanel,
  generateCostRadar,
  executeInitSubcommand,
  runCli,
  isCliMain,
  main
};
