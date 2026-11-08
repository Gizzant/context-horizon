#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHomeDir, getBrainStores } from '../core/paths.mjs';
import { runDemoShowcase } from './horizon_hud.mjs';
import { startServer } from '../../sidecars/horizon-daemon/server.mjs';
import { runPostmortem, printPostmortemSummary } from './postmortem.mjs';
import { runDoctor } from './doctor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

export function buildHooksConfig(targetPluginDir) {
  const norm = (rel) => path.join(targetPluginDir, rel).replace(/\\/g, '/');
  return {
    'horizon-flightcheck-lifecycle': {
      enabled: true,
      SessionStart: [
        {
          type: 'command',
          command: `node "${norm('src/hooks/session_start.mjs')}"`,
          timeout: 5
        }
      ],
      PreInvocation: [
        {
          type: 'command',
          command: `node "${norm('src/hooks/pre_invocation.mjs')}"`,
          timeout: 15
        }
      ],
      PostInvocation: [
        {
          type: 'command',
          command: `node "${norm('src/hooks/post_invocation.mjs')}"`,
          timeout: 5
        }
      ]
    }
  };
}

export function installPlugin(options = {}) {
  const { dryRun = false, workspace = false } = options;
  const home = getHomeDir();
  const targetPluginDir = workspace
    ? path.resolve(process.cwd(), '.agents', 'plugins', 'agy-horizon-flightcheck')
    : path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');

  console.log('\n\x1b[1m\x1b[38;5;51m⚡ Context Horizon (ctxtop v3.1.0) — Zero-Config Installer\x1b[0m');
  console.log(`  • Mode   : ${workspace ? 'Workspace (.agents/plugins)' : 'Global (~/.gemini/config/plugins)'}${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`  • Source : ${PACKAGE_ROOT}`);
  console.log(`  • Target : ${targetPluginDir}`);

  const toCopy = [
    'plugin.json',
    'package.json',
    'README.md',
    'config',
    'assets',
    'rules',
    'skills',
    'sidecars',
    'src',
    'tests'
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
    fs.writeFileSync(
      path.join(targetPluginDir, 'hooks.json'),
      JSON.stringify(resolvedHooks, null, 2) + '\n',
      'utf8'
    );
  }
  console.log('  \x1b[38;5;82m✓\x1b[0m Deployed plugin files & cross-platform lifecycle hooks (SessionStart, PreInvocation, PostInvocation)');

  const settingsPaths = [
    path.join(home, '.gemini', 'antigravity', 'settings.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  ];

  const hudScriptPath = path.join(targetPluginDir, 'src', 'cli', 'horizon_hud.mjs').replace(/\\/g, '/');
  for (const sPath of settingsPaths) {
    const sDir = path.dirname(sPath);
    let settings = {};
    if (fs.existsSync(sPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(sPath, 'utf8'));
        if (!dryRun) {
          fs.writeFileSync(`${sPath}.bak`, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        }
      } catch {
        settings = {};
      }
    }

    settings.statusLine = {
      type: 'command',
      command: `node --no-warnings "${hudScriptPath}"`,
      interval_ms: 300,
      stack_with_default: true
    };

    if (!dryRun) {
      fs.mkdirSync(sDir, { recursive: true });
      fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
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

  console.log('\n\x1b[1m\x1b[38;5;208m╭── CONTEXT HORIZON FORENSIC AUDIT (ctxtop v3.1.0) ─────────────────────────╮\x1b[0m');
  console.log(`\x1b[38;5;208m│\x1b[0m Sessions Audited : \x1b[1m${auditedSessions} sessions\x1b[0m (${estTokensM} cumulative tokens inspected)${isSynthetic ? ' [Demo]' : ''}`);
  console.log(`\x1b[38;5;208m│\x1b[0m Signal Purity    : \x1b[38;5;196m\x1b[1m${worstPurity} worst\x1b[0m (${result.avgPurityPct}% avg across sessions)`);
  console.log(`\x1b[38;5;208m│\x1b[0m Redundant Reads  : \x1b[38;5;214m${dupCount} duplicate file reads\x1b[0m + \x1b[38;5;196m${errCount} dead stack traces\x1b[0m kept in memory`);
  console.log(`\x1b[38;5;208m│\x1b[0m Sludge Tax Burned: \x1b[38;5;214m\x1b[1m${sludgeUsd}\x1b[0m wasted re-sending stale context to the model`);
  console.log(`\x1b[38;5;208m│\x1b[0m Over Safe Limit  : \x1b[38;5;196m${ampCount} sessions crossed safe horizon\x1b[0m (early-anchor truncation risk)`);
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
\x1b[1m\x1b[38;5;51m⚡ context-horizon (ctxtop v3.1.0)\x1b[0m — htop for AI Coding Agent Context Windows

\x1b[1mUSAGE:\x1b[0m
  npx context-horizon init [--workspace] [--dry-run]   Install plugin, hooks & CLI statusLine
  npx context-horizon --demo [--scenario 1..8]         Preview 40-cell HUD & Flight Check Scorecard
  npx context-horizon --demo-animate                   Play live 5-stage terminal crisis animation
  npx ctxtop --roast                                   Audit local logs & print shareable Context Roast Card
  npx ctxtop doctor                                    Diagnose hooks, configuration, mirrors & transcript health
  npx ctxtop postmortem [--last N] [--json]            Generate forensic report & diagnostic dataset
  npx context-horizon --serve                          Launch Edward Tufte IDE Webview in browser
`);
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('init.mjs') ||
  process.argv[1].endsWith('context-horizon') ||
  process.argv[1].endsWith('ctxtop') ||
  process.argv[1].endsWith('agy-horizon') ||
  process.argv[1].endsWith('agy-horizon-flightcheck')
);

if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0] || '--demo';

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
  } else if (cmd === 'init' || args.includes('--install')) {
    const dryRun = args.includes('--dry-run');
    const workspace = args.includes('--workspace');
    installPlugin({ dryRun, workspace });
    runDemoShowcase({ scenarioId: 5, animate: false });
  } else if (cmd === 'roast' || args.includes('--roast')) {
    runContextRoast();
  } else if (cmd === 'doctor' || args.includes('--doctor')) {
    runDoctor().then(res => {
      process.exit(res.ok ? 0 : 1);
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
  } else if (cmd === 'serve' || args.includes('--serve')) {
    process.env.HORIZON_DEMO = '1';
    startServer().then(({ port }) => {
      console.log(`\x1b[1m\x1b[38;5;82m✓ Edward Tufte Webview Live at:\x1b[0m \x1b[38;5;51mhttp://127.0.0.1:${port}\x1b[0m (Press Ctrl+C to stop)`);
    });
  } else {
    const scenIdx = args.indexOf('--scenario');
    const scenarioId = scenIdx !== -1 ? Number(args[scenIdx + 1]) : null;
    runDemoShowcase({ scenarioId, animate: args.includes('--demo-animate') });
  }
}
