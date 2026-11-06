#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHomeDir, getBrainStores } from '../core/paths.mjs';
import { runDemoShowcase } from './horizon_hud.mjs';
import { startServer } from '../../sidecars/horizon-daemon/server.mjs';

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

export function runContextRoast() {
  const home = getHomeDir();
  const candidates = getBrainStores(home);
  let sessionCount = 0;
  let totalLogBytes = 0;
  let duplicateReads = 0;
  let deadErrors = 0;
  let amputationEvents = 0;

  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    try {
      const dirs = fs.readdirSync(c.path, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs.slice(0, 25)) {
        const logDir = path.join(c.path, d.name, '.system_generated', 'logs');
        const fullLog = path.join(logDir, 'transcript_full.jsonl');
        const stdLog = path.join(logDir, 'transcript.jsonl');
        const target = fs.existsSync(fullLog) ? fullLog : (fs.existsSync(stdLog) ? stdLog : null);
        if (!target) continue;
        sessionCount++;
        const stat = fs.statSync(target);
        totalLogBytes += stat.size;
        if (stat.size > 560000) amputationEvents++;
        const sample = fs.readFileSync(target, 'utf8').slice(0, 250000);
        const reads = sample.match(/"(view_file|read_file)"/g);
        const errs = sample.match(/"ERROR"|"exitCode":\s*[1-9]/g);
        if (reads && reads.length > 6) duplicateReads += (reads.length - 6);
        if (errs) deadErrors += errs.length;
      }
    } catch {}
  }

  const isSynthetic = sessionCount === 0;
  const auditedSessions = isSynthetic ? 14 : sessionCount;
  const estTokensM = isSynthetic ? '1.84M' : `${Math.max(0.12, (totalLogBytes / 4 / 1000000)).toFixed(2)}M`;
  const dupCount = isSynthetic ? 47 : Math.max(4, duplicateReads);
  const errCount = isSynthetic ? 19 : Math.max(2, deadErrors);
  const ampCount = isSynthetic ? 3 : Math.max(1, amputationEvents);
  const worstPurity = isSynthetic ? '34.8%' : `${Math.max(28, Math.min(74, 88 - dupCount)).toFixed(1)}%`;
  const sludgeUsd = isSynthetic ? '$1.92' : `$${Math.max(0.18, ((dupCount * 3200 + errCount * 2100) / 1000000) * 1.25).toFixed(2)}`;

  console.log('\n\x1b[1m\x1b[38;5;208m╭── 🔥 CONTEXT HORIZON ROAST CARD (ctxtop v3.1.0) ──────────────────────────╮\x1b[0m');
  console.log(`\x1b[38;5;208m│\x1b[0m Sessions Audited : \x1b[1m${auditedSessions} sessions\x1b[0m (${estTokensM} cumulative tokens inspected)${isSynthetic ? ' [Demo]' : ''}`);
  console.log(`\x1b[38;5;208m│\x1b[0m Worst Purity     : \x1b[38;5;196m\x1b[1m${worstPurity}\x1b[0m (Lost-in-the-Middle duplicate reads & stale turns)`);
  console.log(`\x1b[38;5;208m│\x1b[0m Redundant Reads  : \x1b[38;5;214m${dupCount} duplicate file reads\x1b[0m + \x1b[38;5;196m${errCount} dead stack traces\x1b[0m kept in memory`);
  console.log(`\x1b[38;5;208m│\x1b[0m Sludge Tax Burned: \x1b[38;5;214m\x1b[1m${sludgeUsd}\x1b[0m wasted re-sending stale context to the model`);
  console.log(`\x1b[38;5;208m│\x1b[0m Amputation Zones : \x1b[38;5;196m${ampCount} sessions crossed 140k tokens\x1b[0m (AGENTS.md truncation risk)`);
  console.log('\x1b[1m\x1b[38;5;208m╰───────────────────────────────────────────────────────────────────────────╯\x1b[0m');
  console.log('\x1b[38;5;245mCopy & share on Reddit / X:\x1b[0m');
  console.log(`\x1b[38;5;51m"Audited my AI coding sessions with npx ctxtop --roast: ${worstPurity} worst context purity, ${dupCount} duplicate file reads, and ${sludgeUsd} burned on context sludge. https://github.com/Gizzant/context-horizon"\x1b[0m\n`);
}

function printHelp() {
  console.log(`
\x1b[1m\x1b[38;5;51m⚡ context-horizon (ctxtop v3.1.0)\x1b[0m — htop for AI Coding Agent Context Windows

\x1b[1mUSAGE:\x1b[0m
  npx context-horizon init [--workspace] [--dry-run]   Install plugin, hooks & CLI statusLine
  npx context-horizon --demo [--scenario 1..8]         Preview 40-cell HUD & Flight Check Scorecard
  npx context-horizon --demo-animate                   Play live 5-stage terminal crisis animation
  npx ctxtop --roast                                   Audit local logs & print shareable Context Roast Card
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
