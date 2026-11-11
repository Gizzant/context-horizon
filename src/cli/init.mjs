#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHomeDir, ensureSupportedNodeVersion, parseCliHarnessArg } from '../core/paths.mjs';
import { findSessionDirectory } from '../core/parser.mjs';
import { atomicWriteFileSync } from '../core/atomic_io.mjs';
import { runCLI, runDemoShowcase, formatActionQueueAnsi } from './horizon_hud.mjs';
import { startServer } from '../../sidecars/horizon-daemon/server.mjs';
import { runPostmortem, printPostmortemSummary } from './postmortem.mjs';
import { runDoctor, parseDoctorArgs } from './doctor.mjs';
import { compressCliOutputFts5, searchToolLogsFts5 } from '../core/fts5_output_compressor.mjs';
import { SWARM_TOOL_MATCHER, FULL_TOOL_HOOK_MATCHER, validateAntigravityHooksSchema } from '../core/layer5_hygiene.mjs';

export { SWARM_TOOL_MATCHER, FULL_TOOL_HOOK_MATCHER, validateAntigravityHooksSchema };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

function getVersion() {
  try {
    const p = path.join(PACKAGE_ROOT, 'package.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data.version) return data.version;
    }
  } catch (err) {
    if (process.env.DEBUG) console.error('[init] getVersion fallback:', err);
  }
  return '3.3.0';
}
const VERSION = getVersion();

export function buildHooksConfig(targetPluginDir) {
  const norm = (rel) => path.join(targetPluginDir, rel).replace(/\\/g, '/');
  return {
    'horizon-flightcheck-lifecycle': {
      enabled: true,
      SessionStart: [
        {
          type: 'command',
          command: `node --no-warnings "${norm('src/hooks/session_start.mjs')}"`,
          timeout: 5
        }
      ],
      PreInvocation: [
        {
          type: 'command',
          command: `node --no-warnings "${norm('src/hooks/pre_invocation.mjs')}"`,
          timeout: 15
        }
      ],
      PostInvocation: [
        {
          type: 'command',
          command: `node --no-warnings "${norm('src/hooks/post_invocation.mjs')}"`,
          timeout: 5
        }
      ],
      Stop: [
        {
          type: 'command',
          command: `node --no-warnings "${norm('src/hooks/post_invocation.mjs')}"`,
          timeout: 5
        }
      ],
      PreToolUse: [
        {
          matcher: FULL_TOOL_HOOK_MATCHER,
          type: 'command',
          command: `node --no-warnings "${norm('src/hooks/pre_invocation.mjs')}"`,
          timeout: 5
        }
      ],
      PostToolUse: [
        {
          matcher: FULL_TOOL_HOOK_MATCHER,
          type: 'command',
          command: `node --no-warnings "${norm('src/hooks/post_invocation.mjs')}"`,
          timeout: 5
        }
      ]
    }
  };
}

export function installPlugin(options = {}) {
  const { dryRun = false, workspace = false, dedupe = false } = options;
  const home = getHomeDir();
  const targetPluginDir = workspace
    ? path.resolve(process.cwd(), '.agents', 'plugins', 'agy-horizon-flightcheck')
    : path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');

  console.log(`\n\x1b[1m\x1b[38;5;51m⚡ Attention Horizon (attention-horizon-antigravity v${VERSION}) — Zero-Config Installer\x1b[0m`);
  console.log(`  • Mode   : ${workspace ? 'Workspace (.agents/plugins)' : 'Global (~/.gemini/config/plugins)'}${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`  • Source : ${PACKAGE_ROOT}`);
  console.log(`  • Target : ${targetPluginDir}`);

  // Deduplicate legacy duplicate plugin folder (~/.gemini/config/plugins/agy-horizon)
  if (!workspace) {
    const legacyPluginDir = path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon');
    if (fs.existsSync(legacyPluginDir)) {
      if (!dryRun) {
        try {
          fs.rmSync(legacyPluginDir, { recursive: true, force: true });
          console.log(`  \x1b[38;5;82m✓\x1b[0m Removed legacy duplicate plugin directory (~/.gemini/config/plugins/agy-horizon)`);
        } catch (err) {
          console.log(`  \x1b[38;5;214m▲\x1b[0m Legacy directory in use; recommend manual deletion of ~/.gemini/config/plugins/agy-horizon: ${err.message}`);
        }
      } else {
        console.log(`  \x1b[38;5;82m✓\x1b[0m [DRY RUN] Would remove legacy duplicate plugin directory (~/.gemini/config/plugins/agy-horizon)`);
      }
    }
  }

  const toCopy = [
    'plugin.json',
    'package.json',
    'README.md',
    'config',
    'assets',
    'rules',
    'skills',
    'sidecars',
    'src'
  ];

  if (!dryRun) {
    fs.mkdirSync(targetPluginDir, { recursive: true });
    for (const item of toCopy) {
      const srcItem = path.join(PACKAGE_ROOT, item);
      const destItem = path.join(targetPluginDir, item);
      if (fs.existsSync(srcItem)) {
        fs.cpSync(srcItem, destItem, { recursive: true });
      }
    }

    // Write dynamically resolved hooks.json so both global and workspace installs work across Windows/macOS/Linux
    const resolvedHooks = buildHooksConfig(targetPluginDir);
    atomicWriteFileSync(
      path.join(targetPluginDir, 'hooks.json'),
      JSON.stringify(resolvedHooks, null, 2) + '\n',
      { encoding: 'utf8' }
    );
  }
  console.log('  \x1b[38;5;82m✓\x1b[0m Deployed plugin files & cross-platform lifecycle hooks (SessionStart, PreInvocation, PostInvocation)');

  const settingsPaths = [
    path.join(home, '.gemini', 'antigravity', 'settings.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  ];

  const hudScriptPath = path.join(targetPluginDir, 'src', 'cli', 'horizon_hud.mjs').replace(/\\/g, '/');
  for (const sPath of settingsPaths) {
    let settings = {};
    if (fs.existsSync(sPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(sPath, 'utf8'));
        if (!dryRun) {
          atomicWriteFileSync(`${sPath}.bak`, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8' });
        }
      } catch (err) {
        settings = {};
        if (process.env.DEBUG) console.error(`[init] Failed parsing ${sPath}:`, err);
      }
    }

    settings.statusLine = {
      type: 'command',
      command: `node --no-warnings "${hudScriptPath}"`,
      interval_ms: 300,
      stack_with_default: true
    };

    if (!dryRun) {
      atomicWriteFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8' });
    }
    console.log(`  \x1b[38;5;82m✓\x1b[0m Configured CLI statusLine in ${sPath}`);
  }

  console.log('\n\x1b[1m\x1b[38;5;82m✓ Installation complete in <2 seconds!\x1b[0m');
  return { success: true, targetPluginDir, dryRun };
}

export async function runContextRoast() {
  const result = await runPostmortem({ last: 15, writeFiles: false });
  const isSynthetic = result.isSynthetic;
  const auditedSessions = result.sessionCount;
  const estTokensM = result.estTokensM;
  const dupCount = result.totalDuplicateReads;
  const errCount = result.totalDeadErrors;
  const ampCount = result.amputationSessionsCount;
  const worstPurity = `${result.worstPurityPct}%`;
  const sludgeUsd = result.sludgeUsdFormatted;

  console.log(`\n\x1b[1m\x1b[38;5;208m╭── ATTENTION HORIZON FORENSIC AUDIT (ctxtop v${VERSION}) ───────────────────────╮\x1b[0m`);
  console.log(`\x1b[38;5;208m│\x1b[0m Sessions Audited : \x1b[1m${auditedSessions} sessions\x1b[0m (${estTokensM} cumulative tokens inspected)${isSynthetic ? ' [Demo]' : ''}`);
  console.log(`\x1b[38;5;208m│\x1b[0m Useful Context % : \x1b[38;5;196m\x1b[1m${worstPurity} worst\x1b[0m (${result.avgPurityPct}% avg across sessions)`);
  console.log(`\x1b[38;5;208m│\x1b[0m Redundant Reads  : \x1b[38;5;214m${dupCount} duplicate file reads\x1b[0m + \x1b[38;5;196m${errCount} dead stack traces\x1b[0m kept in memory`);
  console.log(`\x1b[38;5;208m│\x1b[0m Wasted Tokens    : \x1b[38;5;214m\x1b[1m${sludgeUsd}\x1b[0m wasted re-sending stale context to the model`);
  console.log(`\x1b[38;5;208m│\x1b[0m Truncation Risk  : \x1b[38;5;196m${ampCount} sessions crossed safe horizon\x1b[0m (oldest rules at risk)`);
  console.log('\x1b[1m\x1b[38;5;208m╰───────────────────────────────────────────────────────────────────────────╯\x1b[0m');

  if (result.hotspots && result.hotspots.length > 0) {
    console.log('\x1b[1mTop Duplicate-Read Offenders:\x1b[0m');
    for (const h of result.hotspots.slice(0, 3)) {
      const wastedK = Math.max(0.1, (h.wastedTokens / 1000).toFixed(1));
      console.log(`  • ${h.path} (${h.occurrences}x reads, ~${wastedK}k tok wasted across ${h.sessionsAffected} session(s))`);
    }
  }

  if (result.recommendations && result.recommendations.length > 0) {
    console.log('\n\x1b[1mActionable Remediations:\x1b[0m');
    for (const [idx, rec] of result.recommendations.slice(0, 3).entries()) {
      console.log(`  ${idx + 1}. [\x1b[38;5;51m${rec.id}\x1b[0m] ${rec.change_to_make}`);
    }
  }
  console.log('');
}

function printHelp() {
  console.log(`
\x1b[1m\x1b[38;5;51m⚡ Attention Horizon (attention-horizon-antigravity / ctxtop v${VERSION})\x1b[0m — htop for AI Coding Agent Context Windows

\x1b[1mUSAGE:\x1b[0m
  npx attention-horizon-antigravity [--harness=claude|cursor] Auto-discover active Antigravity session & print live 40-cell HUD
  npx attention-horizon-antigravity ui [--open]               Launch local Simple View Web UI on 127.0.0.1:62935 & open in browser
  npx attention-horizon-antigravity init [--workspace]        Install plugin, hooks & CLI statusLine
  npx attention-horizon-antigravity --demo [--scenario 1..8]  Preview 40-cell HUD & Flight Check Scorecard
  npx attention-horizon-antigravity --demo-animate            Play live 5-stage terminal crisis animation
  npx attention-horizon-antigravity --roast                   Audit local logs & print shareable Context Roast Card
  npx attention-horizon-antigravity doctor                    Diagnose hooks, configuration, mirrors & transcript health
  npx attention-horizon-antigravity prune [--dry-run]         Prune stale tool outputs and fold AST stubs in active transcript
  npx attention-horizon-antigravity postmortem [--last N]     Generate forensic report & diagnostic dataset
`);
}

export function openBrowserUrl(url) {
  if (process.env.CTXTOP_NO_BROWSER === '1') return;
  try {
    const cmd = process.platform === 'win32'
      ? `cmd /c start "" "${url}"`
      : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
    exec(cmd, () => {});
  } catch (err) {
    if (process.env.DEBUG) console.error('[init] openBrowserUrl fallback:', err);
  }
}

export async function runLiveOrDemoCli(options = {}) {
  const home = options.homeDir || getHomeDir();
  const discoveryOpts = {
    harness: options.harness || null,
    includeCrossHost: Boolean(options.includeCrossHost)
  };
  const sessionInfo = findSessionDirectory(options.sessionId || null, home, discoveryOpts);
  if (sessionInfo && sessionInfo.sessionDir && fs.existsSync(sessionInfo.sessionDir)) {
    const res = await runCLI({
      silent: true,
      sessionDirOverride: sessionInfo.sessionDir,
      useNativeCeiling: true
    });
    if (res && res.state) {
      const sTag = res.state.surfaceTag || sessionInfo.surfaceTag || '[App]';
      const title = res.state.sessionTitle ? ` · "${res.state.sessionTitle}"` : '';
      console.log(`\n\x1b[1m\x1b[38;5;51m⚡ ATTENTION HORIZON (ctxtop v${VERSION})\x1b[0m — Live ${sTag} Session (${res.state.sessionId.slice(0, 8)})${title}`);
      console.log(res.output);
      const aq = formatActionQueueAnsi(res.state);
      if (aq) console.log(aq);
      console.log(`\x1b[38;5;245mTip: Run 'npx attention-horizon-antigravity ui' for interactive browser view | 'npx ctxtop --roast' for multi-session audit\x1b[0m\n`);
      return { mode: 'live', state: res.state, output: res.output };
    }
  }
  console.log('\x1b[38;5;245mℹ No active Antigravity session found on disk — showing interactive demo:\x1b[0m');
  await runDemoShowcase({ scenarioId: 5, animate: false });
  return { mode: 'demo', state: null };
}

export function isCliMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

const isMain = isCliMain();

if (isMain) {
  ensureSupportedNodeVersion();
  const binName = path.basename(process.argv[1] || '');
  const args = process.argv.slice(2);
  const cmd = binName.includes('agy-horizon-exec')
    ? 'exec'
    : (binName.includes('agy-log-search') ? 'log-search' : (args[0] || 'live'));

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
  } else if (cmd === 'log-search' || cmd === 'agy-log-search') {
    const offset = (args[0] === 'log-search' || args[0] === 'agy-log-search') ? 1 : 0;
    const turnId = args[offset] || '';
    const keyword = args.slice(offset + 1).join(' ');
    searchToolLogsFts5(null, { turnId, keyword }).then(res => {
      for (const m of res.matchedLines) {
        console.log(`[${m.turnId}:${m.lineNumber}] ${m.text}`);
      }
      process.exit(0);
    });
  } else if (cmd === 'exec' || cmd === 'agy-horizon-exec') {
    const offset = (args[0] === 'exec' || args[0] === 'agy-horizon-exec') ? 1 : 0;
    const execCmd = args.slice(offset).join(' ');
    exec(execCmd, { maxBuffer: 16 * 1024 * 1024 }, async (err, stdout, stderr) => {
      const rawOutput = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`;
      const exitCode = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      const comp = await compressCliOutputFts5({
        command: execCmd,
        exitCode,
        rawOutput,
        turnId: `turn-${Date.now()}`
      });
      process.stdout.write(comp.output + '\n');
      process.exit(exitCode);
    });
  } else if (cmd === 'init' || args.includes('--install')) {
    const dryRun = args.includes('--dry-run');
    const workspace = args.includes('--workspace');
    installPlugin({ dryRun, workspace });
    runDemoShowcase({ scenarioId: 5, animate: false });
  } else if (cmd === 'roast' || args.includes('--roast')) {
    runContextRoast();
  } else if (cmd === 'prune' || args.includes('--prune') || args.includes('--prune-tools')) {
    const dryRun = args.includes('--dry-run');
    runDoctor({ pruneTools: true, dryRun }).then(res => {
      process.exit(res.ok === false ? 1 : 0);
    });
  } else if (cmd === 'doctor' || args.includes('--doctor')) {
    const cliOpts = parseDoctorArgs(args);
    runDoctor(cliOpts).then(res => {
      process.exit(res.ok === false ? 1 : 0);
    });
  } else if (cmd === 'postmortem' || args.includes('--postmortem')) {
    const lastIdx = args.indexOf('--last');
    const last = lastIdx !== -1 ? Number(args[lastIdx + 1]) : 15;
    const json = args.includes('--json');
    runPostmortem({ last, json, writeFiles: true }).then(res => {
      if (!json) {
        printPostmortemSummary(res);
      }
    });
  } else if (cmd === 'ui' || cmd === 'serve' || args.includes('--serve') || args.includes('--open')) {
    if (args.includes('--demo')) {
      process.env.HORIZON_DEMO = '1';
    }
    const shouldOpenBrowser = (cmd === 'ui' || args.includes('ui') || args.includes('--open')) && !args.includes('--no-open');
    startServer().then(({ port }) => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`\x1b[1m\x1b[38;5;82m✓ Attention Horizon Web UI Live at:\x1b[0m \x1b[38;5;51m${url}\x1b[0m (Press Ctrl+C to stop)`);
      if (shouldOpenBrowser) {
        openBrowserUrl(url);
      }
    });
  } else if (cmd === '--demo' || cmd === 'demo' || args.includes('--demo') || args.includes('--demo-animate') || args.includes('--scenario')) {
    const scenIdx = args.indexOf('--scenario');
    const scenarioId = scenIdx !== -1 ? Number(args[scenIdx + 1]) : null;
    runDemoShowcase({ scenarioId, animate: args.includes('--demo-animate') });
  } else {
    const cliHarness = parseCliHarnessArg(args);
    runLiveOrDemoCli({ harness: cliHarness });
  }
}
