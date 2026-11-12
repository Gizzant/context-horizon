import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadFlightcheckConfig, getUserConfigPath } from '../core/config.mjs';
import { getDaemonPortFile, readDaemonPort, ensureSupportedNodeVersion, isSupportedNodeVersion } from '../core/paths.mjs';
import { resolveModelCeilingDetailed, resolvePricePerM } from '../core/constants.mjs';
import { getFlightcheckDir, SIDECAR_VERSION } from '../core/sidecar_store.mjs';
import { syncAndVerifyMirrors } from '../../scripts/sync_mirrors.mjs';
import { findSessionDirectory, parseTranscriptIncremental, parseRawJsonl } from '../core/parser.mjs';
import { executeToolOutputSurgery } from '../core/tool_surgeon.mjs';
import { compactCursorVscdbStreaming, recoverAntigravityBrainMigration } from '../core/storage_doctor.mjs';
import { reapOrphanProcesses } from '../core/host_watchdog.mjs';
import { generateHandoffMarkdown } from '../core/handoff_audit.mjs';
import {
  loadHorizonConfig,
  generateAntigravityDiagnosticMarkdown
} from '../core/horizon_config.mjs';
import { getHookDiagnosticSummary } from '../core/hook_diagnostics.mjs';

/**
 * Parses CLI flags (`--prune-tools`, `--reap-orphans`, `--handoff`, `--storage-gc`, `--gc-cursor`, `--recover-brain`, `--diagnostic`, `--transcript <path>`, `--vscdb <path>`, `--dry-run`)
 */
export function parseDoctorArgs(argv = process.argv.slice(2)) {
  const pruneTools = argv.includes('--prune-tools') || argv.includes('--prune') || argv.includes('prune');
  const uncachedTail = argv.includes('--uncached-tail') || argv.includes('--tail');
  const reapOrphans = argv.includes('--reap-orphans');
  const handoff = argv.includes('--handoff') || argv.includes('--distill');
  const gcCursor = argv.includes('--gc-cursor');
  const recoverBrain = argv.includes('--recover-brain');
  const storageGc = argv.includes('--storage-gc') || gcCursor || recoverBrain;
  const diagnostic = argv.includes('--diagnostic') || argv.includes('--bug-report');
  const dryRun = argv.includes('--dry-run');
  const tIdx = argv.indexOf('--transcript');
  const transcriptPath = tIdx !== -1 && argv[tIdx + 1] ? argv[tIdx + 1] : null;
  const vIdx = argv.indexOf('--vscdb');
  const vscdbPath = vIdx !== -1 && argv[vIdx + 1] ? argv[vIdx + 1] : null;
  return { pruneTools, uncachedTail, reapOrphans, handoff, storageGc, gcCursor, recoverBrain, diagnostic, dryRun, transcriptPath, vscdbPath };
}

/**
 * Runs a comprehensive diagnosis of the Attention Horizon (`attention-horizon-antigravity`) environment.
 */
export async function runDoctor({ workspacePath = process.cwd(), pruneTools = false, uncachedTail = false, reapOrphans = false, handoff = false, storageGc = false, gcCursor = false, recoverBrain = false, diagnostic = false, dryRun = false, transcriptPath = null, vscdbPath = null, silent = false } = {}) {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (reapOrphans) {
    const res = await reapOrphanProcesses();
    if (!silent) {
      console.log(`  ✔ PASS  Orphan Watchdog                Reaped ${res.reapedCount} orphan process(es)`);
    }
    return { ok: true, ...res };
  }
  if (handoff) {
    const res = generateHandoffMarkdown({}, { workspacePath });
    if (!silent) {
      console.log(`  ✔ PASS  Handoff Distillation           Generated handoff document at ${res.relativePath}`);
    }
    return { ok: true, ...res };
  }
  if (pruneTools || uncachedTail) {
    let resolvedTranscript = transcriptPath;
    if (!resolvedTranscript) {
      const sessionInfo = findSessionDirectory(null, home);
      if (sessionInfo && sessionInfo.sessionDir) {
        const candidateFull = path.join(sessionInfo.sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
        const candidateCompact = path.join(sessionInfo.sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(candidateFull)) resolvedTranscript = candidateFull;
        else if (fs.existsSync(candidateCompact)) resolvedTranscript = candidateCompact;
      }
    }
    if (!resolvedTranscript || !fs.existsSync(resolvedTranscript)) {
      if (!silent) console.log('  ✖ FAIL  Tool-Output Surgeon            No active session transcript found to prune');
      return { ok: false, success: false, error: 'No active session transcript found to prune' };
    }
    const res = executeToolOutputSurgery(resolvedTranscript, { dryRun, uncachedTail: uncachedTail || pruneTools });
    if (!silent) {
      const tag = (uncachedTail || pruneTools) ? 'Uncached Tail Surgeon' : 'Tool-Output Surgeon';
      console.log(`  ✔ PASS  ${tag.padEnd(30)} Pruned ${res.prunedCount} stale tool output(s), saved ~${res.savedTokens} tokens${dryRun ? ' (dry-run)' : ''}`);
    }
    return { ok: Boolean(res.success), ...res };
  }
  if (storageGc || gcCursor || recoverBrain) {
    const migration = (!gcCursor || recoverBrain || storageGc) ? recoverAntigravityBrainMigration(home, { dryRun }) : null;
    const vscdbRes = vscdbPath ? await compactCursorVscdbStreaming(vscdbPath, { dryRun }) : null;
    if (!silent) {
      if (migration) {
        console.log(`  ✔ PASS  Antigravity Brain Recovery     Scanned ${migration.scannedDbCount} DBs, relinked ${migration.orphanedBrainCount} orphaned brain dir(s)${dryRun ? ' (dry-run)' : ''}`);
      }
      if (vscdbRes) {
        console.log(`  ✔ PASS  Cursor state.vscdb GC          Removed ${vscdbRes.removedOrphanRows} orphan rows, reclaimed ${vscdbRes.reclaimedBytes} bytes${dryRun ? ' (dry-run)' : ''}`);
      }
    }
    return { ok: true, migration, vscdb: vscdbRes };
  }
  const results = [];

  function record(title, status, detail = '') {
    results.push({ title, status, detail });
    if (silent || diagnostic) return;
    const symbol = status === 'PASS' ? '\x1b[32m✔ PASS\x1b[0m' : (status === 'WARN' ? '\x1b[33m▲ WARN\x1b[0m' : '\x1b[31m✖ FAIL\x1b[0m');
    console.log(`  ${symbol}  ${title.padEnd(35)} ${detail}`);
  }

  if (!silent && !diagnostic) {
    console.log(`\n\x1b[1mAttention Horizon (ah-antigravity) System Doctor v${SIDECAR_VERSION}\x1b[0m`);
    console.log('='.repeat(70));
  }

  // 0. Node.js Runtime & Daemon Port Discovery
  if (isSupportedNodeVersion()) {
    const sqliteDetail =
      typeof process !== 'undefined' && process.env?.CTXTOP_FORCE_NO_SQLITE === '1'
        ? `${process.version} (Node >= 20.0.0 LTS JSONL fallback active)`
        : `${process.version} (>= v22.5.0 built-in node:sqlite ready)`;
    record('Node.js Runtime', 'PASS', sqliteDetail);
  } else {
    record('Node.js Runtime', 'FAIL', `${process.version} — Upgrade to Node >= 20.0.0 LTS required`);
  }
  const portFile = getDaemonPortFile(home);
  const resolvedPort = readDaemonPort(home, 62935);
  const hasPortLock = fs.existsSync(portFile);
  record(
    'Daemon Port Discovery',
    'PASS',
    hasPortLock
      ? `Active lockfile at ~/.ctxtop/daemon.port -> 127.0.0.1:${resolvedPort}`
      : `Default loopback port 127.0.0.1:${resolvedPort} (start UI with: npx ctxtop ui)`
  );

  // 1. Hooks Registration Check
  const hooksCandidates = [
    path.join(home, '.gemini', 'config', 'hooks.json'),
    path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck', 'hooks.json'),
    path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon', 'hooks.json'),
    path.join(workspacePath, '.agents', 'hooks.json'),
    path.join(workspacePath, '.gemini', 'config', 'hooks.json'),
    path.join(workspacePath, 'hooks.json')
  ];
  let hooksFound = false;
  for (const hPath of hooksCandidates) {
    if (fs.existsSync(hPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(hPath, 'utf8'));
        const rootObj = parsed['horizon-flightcheck-lifecycle'] || parsed.hooks || parsed;
        const pre = Boolean(rootObj.PreInvocation || rootObj.pre_invocation || parsed.PreToolUse);
        const post = Boolean(rootObj.PostInvocation || rootObj.post_invocation);
        const start = Boolean(rootObj.SessionStart || rootObj.session_start);
        if (pre || post || start) {
          hooksFound = true;
          const relLabel = hPath.startsWith(workspacePath)
            ? path.relative(workspacePath, hPath).replace(/\\/g, '/') || 'hooks.json'
            : hPath.replace(home, '~').replace(/\\/g, '/');
          record('Antigravity Hooks', 'PASS', `Active at ${relLabel} (Pre:${pre ? '✔' : '✖'}, Post:${post ? '✔' : '✖'}, Start:${start ? '✔' : '✖'})`);
          break;
        }
      } catch (err) {
        const relLabel = hPath.startsWith(workspacePath)
          ? path.relative(workspacePath, hPath).replace(/\\/g, '/') || 'hooks.json'
          : hPath.replace(home, '~').replace(/\\/g, '/');
        record('Antigravity Hooks', 'WARN', `Malformed JSON in ${relLabel}: ${err.message}`);
      }
    }
  }
  if (!hooksFound) {
    record('Antigravity Hooks', 'WARN', 'No hooks.json registering PreInvocation found in ~/.gemini/config or workspace');
  }

  // 1b. Duplicate Plugin Integrity Check
  const agyHorizonDir = path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon');
  const flightcheckDir = path.join(home, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');
  if (fs.existsSync(agyHorizonDir) && fs.existsSync(flightcheckDir)) {
    record('Plugin Canonical Integrity', 'WARN', 'Duplicate plugin directories detected (~/agy-horizon & ~/agy-horizon-flightcheck). Run `npx attention-horizon-antigravity init --dedupe` to standardize.');
  } else if (fs.existsSync(flightcheckDir)) {
    record('Plugin Canonical Integrity', 'PASS', 'Canonical plugin directory active (~/.gemini/config/plugins/agy-horizon-flightcheck)');
  }

  // 2. Flight Check Configuration & Per-Detector Overlay (.attention-horizon.json)
  const userCfgPath = getUserConfigPath();
  const config = loadFlightcheckConfig();
  const horizonCfg = loadHorizonConfig({ workspacePath, homeDir: home });
  const customDetCount = Object.values(horizonCfg.detectors || {}).filter(m => m !== 'default').length;
  if (fs.existsSync(userCfgPath)) {
    try {
      JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
      record('Configuration Overlay', 'PASS', `Valid overlay at ~/.gemini/flightcheck/config.json (hook_level: ${config.hook_level}, detector overrides: ${customDetCount})`);
    } catch (err) {
      record('Configuration Overlay', 'FAIL', `Corrupt JSON in ~/.gemini/flightcheck/config.json: ${err.message}`);
    }
  } else {
    record('Configuration Overlay', 'PASS', `Using bundled defaults (hook_level: ${config.hook_level}, halt_cooldown: ${config.halt_cooldown_turns}t, detector overrides: ${customDetCount})`);
  }

  // 3. Model Ceiling & Pricing Resolution
  const testModels = ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'claude-opus-5.5', 'custom-enterprise-model'];
  let fallbackSeen = false;
  for (const m of testModels) {
    const details = resolveModelCeilingDetailed(m, null, { config });
    resolvePricePerM(m, config);
    if (m === 'custom-enterprise-model' && details.source === 'fallback') {
      fallbackSeen = true;
    }
  }
  if (fallbackSeen) {
    record('Model Registry', 'PASS', `Dynamic family inheritance active; unmapped models resolve safely to fallback ceiling (${config.model_ceilings?.default || 256000} tokens)`);
  } else {
    record('Model Registry', 'PASS', 'Model registry and pricing table operational');
  }

  // 4. Sidecar Store Directory
  const fcDir = getFlightcheckDir();
  const sessionsDir = path.join(fcDir, 'sessions');
  try {
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    const testFile = path.join(sessionsDir, `.doctor_write_${Date.now()}.tmp`);
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    record('Sidecar Store Storage', 'PASS', `Writable directory at ${sessionsDir}`);
  } catch (err) {
    record('Sidecar Store Storage', 'FAIL', `Cannot write to ${sessionsDir}: ${err.message}`);
  }

  // 5. 3-Way Mirror Parity Check
  try {
    const mirrorCheck = syncAndVerifyMirrors({ verifyOnly: true });
    if (mirrorCheck.parityOk) {
      record('3-Way WebView Parity', 'PASS', `SHA-256 byte-for-byte match (${mirrorCheck.sha256.slice(0, 12)}...) across ${mirrorCheck.targets} targets`);
    } else {
      record('3-Way WebView Parity', 'FAIL', 'HTML or core module mismatch across local plugin mirrors');
    }
  } catch (err) {
    record('3-Way WebView Parity', 'WARN', `Parity verify skipped or partial: ${err.message}`);
  }

  // 6. Transcript Parser Confidence
  try {
    const sessionInfo = findSessionDirectory(null, home);
    if (sessionInfo && sessionInfo.sessionDir && fs.existsSync(sessionInfo.sessionDir)) {
      const inc = parseTranscriptIncremental(sessionInfo.sessionDir, null);
      if (inc && inc.filePath && fs.existsSync(inc.filePath)) {
        if (inc.filePath.endsWith('.vscdb')) {
          record(
            'Transcript Health',
            'PASS',
            `Session ${sessionInfo.sessionId.slice(0, 8)} (${sessionInfo.surfaceTag || '[Cursor]'}) — Read-only SQLite state.vscdb (${(inc.steps || []).length} steps)`
          );
        } else {
          const rawContent = fs.readFileSync(inc.filePath, 'utf8');
          const parsed = parseRawJsonl(rawContent, { withHealth: true });
          const health = parsed.health;
          const status = health.confidence === 'HIGH' ? 'PASS' : (health.confidence === 'DEGRADED' ? 'WARN' : 'FAIL');
          record(
            'Transcript Health',
            status,
            `Session ${sessionInfo.sessionId.slice(0, 8)} (${sessionInfo.surfaceTag || '[App]'}) — Confidence: ${health.confidence} (${health.parsedLines}/${health.totalLines} lines, ${health.malformedLines} malformed)`
          );
        }
      } else {
        record('Transcript Health', 'PASS', `Session ${sessionInfo.sessionId.slice(0, 8)} located; waiting for first JSONL turn`);
      }
    } else {
      record('Transcript Health', 'PASS', 'No active conversation folder currently open (idle)');
    }
  } catch (err) {
    record('Transcript Health', 'WARN', `Log check error: ${err.message}`);
  }

  // 7. Hook & Shim Structured Diagnostics Ledger (~/.attention-horizon/diagnostics/ga_hook_diagnostics.jsonl)
  const hookDiagnostics = getHookDiagnosticSummary({ homeDir: home });
  if (hookDiagnostics.totalCount === 0) {
    record('Hook & Shim Diagnostics', 'PASS', '0 recent hook/shim diagnostic errors recorded');
  } else {
    const latestTag = hookDiagnostics.latestSource && hookDiagnostics.latestOperation
      ? ` (latest: ${hookDiagnostics.latestSource}:${hookDiagnostics.latestOperation})`
      : '';
    record(
      'Hook & Shim Diagnostics',
      'WARN',
      `${hookDiagnostics.totalCount} recent diagnostic event(s) in ~/.attention-horizon/diagnostics/ga_hook_diagnostics.jsonl${latestTag}`
    );
  }

  const failCount = results.filter(r => r.status === 'FAIL').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;

  if (diagnostic) {
    const diagBundle = generateAntigravityDiagnosticMarkdown(results, {
      workspacePath,
      homeDir: home
    });
    if (!silent) {
      console.log(diagBundle.markdown);
    }
    return {
      ok: failCount === 0,
      failCount,
      warnCount,
      hookDiagnostics,
      diagnosticMarkdown: diagBundle.markdown,
      diagnosticBundle: diagBundle
    };
  }

  if (!silent) {
    console.log('='.repeat(70));
  }
  if (failCount > 0) {
    if (!silent) console.log(`\x1b[31mStatus: System issues detected (${failCount} failure${failCount > 1 ? 's' : ''}, ${warnCount} warning${warnCount > 1 ? 's' : ''}). Run recommendations above.\x1b[0m\n`);
    return { ok: false, failCount, warnCount, hookDiagnostics, results };
  } else if (warnCount > 0) {
    if (!silent) console.log(`\x1b[33mStatus: Operational with ${warnCount} advisory warning${warnCount > 1 ? 's' : ''}.\x1b[0m\n`);
    return { ok: true, failCount: 0, warnCount, hookDiagnostics, results };
  } else {
    if (!silent) console.log('\x1b[32mStatus: All checks PASSED. Attention Horizon system is fully healthy.\x1b[0m\n');
    return { ok: true, failCount: 0, warnCount: 0, hookDiagnostics, results };
  }
}

export function isDoctorMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // Fallback to path.resolve when symlink target cannot be resolved
    }
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

const isMain = isDoctorMain();
if (isMain) {
  ensureSupportedNodeVersion();
  const cliOpts = parseDoctorArgs(process.argv.slice(2));
  runDoctor(cliOpts).then(res => {
    process.exit(res.ok === false ? 1 : 0);
  }).catch(err => {
    console.error('Doctor fatal error:', err);
    process.exit(1);
  });
}
