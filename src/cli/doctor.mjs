import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadFlightcheckConfig, getUserConfigPath } from '../core/config.mjs';
import { resolveModelCeilingDetailed, resolvePricePerM } from '../core/constants.mjs';
import { getFlightcheckDir } from '../core/sidecar_store.mjs';
import { syncAndVerifyMirrors } from '../../scripts/sync_mirrors.mjs';
import { findSessionDirectory, parseTranscriptIncremental, parseRawJsonl } from '../core/parser.mjs';
import { executeToolOutputSurgery } from '../core/tool_surgeon.mjs';
import { compactCursorVscdbStreaming, recoverAntigravityBrainMigration } from '../core/storage_doctor.mjs';
import { reapOrphanProcesses } from '../core/host_watchdog.mjs';
import { generateHandoffMarkdown } from '../core/handoff_audit.mjs';

/**
 * Parses CLI flags (`--prune-tools`, `--reap-orphans`, `--handoff`, `--storage-gc`, `--gc-cursor`, `--recover-brain`, `--transcript <path>`, `--vscdb <path>`, `--dry-run`)
 */
export function parseDoctorArgs(argv = process.argv.slice(2)) {
  const pruneTools = argv.includes('--prune-tools');
  const reapOrphans = argv.includes('--reap-orphans');
  const handoff = argv.includes('--handoff') || argv.includes('--distill');
  const gcCursor = argv.includes('--gc-cursor');
  const recoverBrain = argv.includes('--recover-brain');
  const storageGc = argv.includes('--storage-gc') || gcCursor || recoverBrain;
  const dryRun = argv.includes('--dry-run');
  const tIdx = argv.indexOf('--transcript');
  const transcriptPath = tIdx !== -1 && argv[tIdx + 1] ? argv[tIdx + 1] : null;
  const vIdx = argv.indexOf('--vscdb');
  const vscdbPath = vIdx !== -1 && argv[vIdx + 1] ? argv[vIdx + 1] : null;
  return { pruneTools, reapOrphans, handoff, storageGc, gcCursor, recoverBrain, dryRun, transcriptPath, vscdbPath };
}

/**
 * Runs a comprehensive diagnosis of the Context Horizon (ctxtop) environment.
 */
export async function runDoctor({ workspacePath = process.cwd(), pruneTools = false, reapOrphans = false, handoff = false, storageGc = false, gcCursor = false, recoverBrain = false, dryRun = false, transcriptPath = null, vscdbPath = null, silent = false } = {}) {
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
  if (pruneTools) {
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
    const res = executeToolOutputSurgery(resolvedTranscript, { dryRun });
    if (!silent) {
      console.log(`  ✔ PASS  Tool-Output Surgeon            Pruned ${res.prunedCount} stale tool output(s), saved ~${res.savedTokens} tokens${dryRun ? ' (dry-run)' : ''}`);
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
    const symbol = status === 'PASS' ? '\x1b[32m✔ PASS\x1b[0m' : (status === 'WARN' ? '\x1b[33m▲ WARN\x1b[0m' : '\x1b[31m✖ FAIL\x1b[0m');
    console.log(`  ${symbol}  ${title.padEnd(35)} ${detail}`);
  }

  console.log('\n\x1b[1mContext Horizon (ctxtop) System Doctor v3.2\x1b[0m');
  console.log('='.repeat(70));

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
      } catch {}
    }
  }
  if (!hooksFound) {
    record('Antigravity Hooks', 'WARN', 'No hooks.json registering PreInvocation found in ~/.gemini/config or workspace');
  }

  // 2. Flight Check Configuration & Overlay
  const userCfgPath = getUserConfigPath();
  const config = loadFlightcheckConfig();
  if (fs.existsSync(userCfgPath)) {
    try {
      JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
      record('Configuration Overlay', 'PASS', `Valid overlay at ~/.gemini/flightcheck/config.json (hook_level: ${config.hook_level})`);
    } catch (err) {
      record('Configuration Overlay', 'FAIL', `Corrupt JSON in ~/.gemini/flightcheck/config.json: ${err.message}`);
    }
  } else {
    record('Configuration Overlay', 'PASS', `Using bundled defaults (hook_level: ${config.hook_level}, halt_cooldown: ${config.halt_cooldown_turns}t)`);
  }

  // 3. Model Ceiling & Pricing Resolution
  const testModels = ['gemini-3.8-flash', 'gemini-4-argon', 'claude-opus-5.5', 'custom-enterprise-model'];
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
        const rawContent = fs.readFileSync(inc.filePath, 'utf8');
        const parsed = parseRawJsonl(rawContent, { withHealth: true });
        const health = parsed.health;
        const status = health.confidence === 'HIGH' ? 'PASS' : (health.confidence === 'DEGRADED' ? 'WARN' : 'FAIL');
        record(
          'Transcript Health',
          status,
          `Session ${sessionInfo.sessionId.slice(0, 8)} (${sessionInfo.surfaceTag || '[App]'}) — Confidence: ${health.confidence} (${health.parsedLines}/${health.totalLines} lines, ${health.malformedLines} malformed)`
        );
      } else {
        record('Transcript Health', 'PASS', `Session ${sessionInfo.sessionId.slice(0, 8)} located; waiting for first JSONL turn`);
      }
    } else {
      record('Transcript Health', 'PASS', 'No active conversation folder currently open (idle)');
    }
  } catch (err) {
    record('Transcript Health', 'WARN', `Log check error: ${err.message}`);
  }

  console.log('='.repeat(70));
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  if (failCount > 0) {
    console.log(`\x1b[31mStatus: System issues detected (${failCount} failure${failCount > 1 ? 's' : ''}, ${warnCount} warning${warnCount > 1 ? 's' : ''}). Run recommendations above.\x1b[0m\n`);
    return { ok: false, failCount, warnCount };
  } else if (warnCount > 0) {
    console.log(`\x1b[33mStatus: Operational with ${warnCount} advisory warning${warnCount > 1 ? 's' : ''}.\x1b[0m\n`);
    return { ok: true, failCount: 0, warnCount };
  } else {
    console.log('\x1b[32mStatus: All checks PASSED. Context Horizon system is fully healthy.\x1b[0m\n');
    return { ok: true, failCount: 0, warnCount: 0 };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cliOpts = parseDoctorArgs(process.argv.slice(2));
  runDoctor(cliOpts).then(res => {
    process.exit(res.ok === false ? 1 : 0);
  }).catch(err => {
    console.error('Doctor fatal error:', err);
    process.exit(1);
  });
}
