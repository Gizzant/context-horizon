import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { atomicWriteFileSync, atomicWriteJsonSync } from '../src/core/atomic_io.mjs';
import {
  isHostProtectedSqlitePath,
  openLocalHorizonDb,
  openHostReadOnlyDb
} from '../src/core/sqlite_client.mjs';
import { isProtectedPrefixFile } from '../src/core/prefix_cache_shield.mjs';
import { UShapedAttentionOptimizer } from '../src/core/u_shaped_optimizer.mjs';
import { auditInstructionStaticRot } from '../src/core/baseline.mjs';
import {
  getClaudeCodeProjectsDir,
  getCursorWorkspaceStorageDirs,
  parseCliHarnessArg
} from '../src/core/paths.mjs';
import { findSessionDirectory, parseTranscriptIncremental } from '../src/core/parser.mjs';
import { saveRegistry, loadRegistry } from '../src/core/telemetry/scope_lock_registry.mjs';
import { registerCliDampeningHook, buildTrustedPluginHookCommand } from '../src/core/layer5_hygiene.mjs';
import {
  inspectGitArgs,
  resolveRealGitBinary,
  runGitGuard,
  getBypassNonceFilePath,
  generateGitBypassNonce,
  consumeGitBypassNonce
} from '../src/shims/agy_git_guard.mjs';
import { evaluateDetectorsOnSteps } from '../src/core/detectors_det01_to_16.mjs';
import { runPassiveWalCheckpoint, inspectDatabaseWalHealth } from '../src/core/wal_hygiene.mjs';
import { auditCursorVscdbOrphans, compactCursorVscdbStreaming } from '../src/core/storage_doctor.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function sendRawHttpRequest({ port, method = 'GET', pathName = '/api/health', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (body !== null && reqHeaders['Content-Length'] === undefined && reqHeaders['content-length'] === undefined) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

describe('Batch 1 Remediation — ISS-021: Strict Antigravity Isolation & No CLAUDE.md Ownership', () => {
  it('never protects, scans, or flags CLAUDE.md in Antigravity rule/prefix engines', () => {
    assert.equal(isProtectedPrefixFile('CLAUDE.md'), false);
    assert.equal(isProtectedPrefixFile('/repo/CLAUDE.md'), false);
    assert.equal(isProtectedPrefixFile('AGENTS.md'), true);
    assert.equal(isProtectedPrefixFile('GEMINI.md'), true);

    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss021-ws-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss021-home-'));
    try {
      fs.writeFileSync(path.join(tmpWs, 'CLAUDE.md'), '# Foreign Claude instructions\n'.repeat(120), 'utf8');
      fs.writeFileSync(path.join(tmpWs, 'AGENTS.md'), '# Antigravity Rules\n- Keep invariant.\n', 'utf8');

      const optimizer = new UShapedAttentionOptimizer({ workspaceDir: tmpWs, homeDir: tmpHome });
      const scan = optimizer.scanWorkspaceAndGlobalRules();
      const scannedBasenames = scan.fileReports.map((f) => path.basename(f.filePath));
      assert.ok(!scannedBasenames.includes('CLAUDE.md'), 'UShapedAttentionOptimizer must ignore CLAUDE.md');
      assert.ok(scannedBasenames.includes('AGENTS.md'));

      const rotAudit = auditInstructionStaticRot(tmpWs, tmpHome);
      const rotNames = rotAudit.inspectedFiles.map((f) => path.basename(f.path));
      assert.ok(!rotNames.includes('CLAUDE.md'), 'auditInstructionStaticRot must ignore CLAUDE.md');
      assert.ok(!rotNames.includes('.cursorrules'), 'auditInstructionStaticRot must ignore .cursorrules');
      assert.ok(rotNames.includes('AGENTS.md'));
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('gates ~/.claude/projects and Cursor state.vscdb discovery behind explicit --harness flags while preserving direct file parsing', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss021-disc-'));
    try {
      const claudeProj = path.join(tmpHome, '.claude', 'projects', 'demo');
      fs.mkdirSync(claudeProj, { recursive: true });
      const claudeJsonl = path.join(claudeProj, 'sess-c1.jsonl');
      fs.writeFileSync(
        claudeJsonl,
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          type: 'user',
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'Hello from Claude' }
        }) + '\n',
        'utf8'
      );

      assert.equal(getClaudeCodeProjectsDir(tmpHome), '');
      assert.ok(getClaudeCodeProjectsDir(tmpHome, { harness: 'claude' }));
      assert.deepEqual(getCursorWorkspaceStorageDirs(tmpHome), []);
      assert.equal(parseCliHarnessArg(['--live']), null);
      assert.equal(parseCliHarnessArg(['--harness=claude']), 'claude');
      assert.equal(parseCliHarnessArg(['--harness', 'cursor']), 'cursor');

      // Default Antigravity discovery must NOT pick up foreign ~/.claude sessions
      assert.equal(findSessionDirectory(null, tmpHome), null);
      // Explicit --harness=claude discovers it
      const explicitClaude = findSessionDirectory(null, tmpHome, { harness: 'claude' });
      assert.ok(explicitClaude);
      assert.equal(explicitClaude.storeName, 'claude-code');

      // Direct file path calls for unit tests still work cleanly
      const directFound = findSessionDirectory(claudeJsonl, tmpHome);
      assert.ok(directFound);
      const parsed = parseTranscriptIncremental(directFound.sessionDir, path.join(tmpHome, 'cache'));
      assert.equal(parsed.steps.length, 1);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('Batch 1 Remediation — ISS-023: Centralized atomicWriteFileSync & Read-Only Host Transcripts', () => {
  it('retries Windows EPERM/EBUSY on renameSync, never pre-unlinks targetPath, and cleans up tempPath on failure', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss023-atomic-'));
    try {
      const target = path.join(tmpDir, 'scope-locks.json');
      atomicWriteJsonSync(target, { version: 1, status: 'initial' });
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 1, status: 'initial' });

      // Simulate 2 transient Windows EPERM rename failures followed by success, spying on unlinkSync
      let renameAttempts = 0;
      const unlinkedPaths = [];
      const mockFs = {
        ...fs,
        mkdirSync: (...args) => fs.mkdirSync(...args),
        openSync: (...args) => fs.openSync(...args),
        writeSync: (...args) => fs.writeSync(...args),
        fsyncSync: (...args) => fs.fsyncSync(...args),
        closeSync: (...args) => fs.closeSync(...args),
        existsSync: (...args) => fs.existsSync(...args),
        unlinkSync: (p) => {
          unlinkedPaths.push(path.resolve(p));
          return fs.unlinkSync(p);
        },
        renameSync: (src, dst) => {
          renameAttempts += 1;
          if (renameAttempts <= 2) {
            const err = new Error('Simulated Windows file lock');
            err.code = renameAttempts === 1 ? 'EPERM' : 'EBUSY';
            throw err;
          }
          return fs.renameSync(src, dst);
        }
      };

      atomicWriteFileSync(target, JSON.stringify({ version: 2, status: 'updated' }), {
        fsModule: mockFs
      });
      assert.equal(renameAttempts, 3);
      assert.ok(
        !unlinkedPaths.includes(path.resolve(target)),
        'atomicWriteFileSync must NEVER pre-unlink targetPath before renameSync'
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2, status: 'updated' });

      // Now simulate persistent rename failure: targetPath must stay intact and .tmp file must be cleaned up
      const alwaysFailFs = {
        ...mockFs,
        renameSync: () => {
          const err = new Error('Persistent lock');
          err.code = 'EACCES';
          throw err;
        }
      };
      assert.throws(
        () => atomicWriteFileSync(target, '{"corrupted":true}', { fsModule: alwaysFailFs, maxRetries: 2 }),
        /Persistent lock/
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2, status: 'updated' });
      const remainingTmp = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp.'));
      assert.deepEqual(remainingTmp, [], 'Temporary write file must be cleaned up on failure');

      // Verify scope_lock_registry round-trip uses atomic persistence cleanly
      saveRegistry(tmpDir, {
        version: 1,
        leases: [{ trajectoryId: 's1', pid: process.pid, claimedPaths: ['src/a.mjs'], expiresAtMs: Date.now() + 60000 }]
      });
      const loaded = loadRegistry(tmpDir);
      assert.equal(loaded.leases[0].trajectoryId, 's1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 1 Remediation — ISS-037: Trusted Plugin Hook Resolution & Daemon CSRF / Origin / Caps', () => {
  it('hooks.json and layer5_hygiene resolve hooks strictly from ~/.gemini/config/plugins with zero workspace ./src/hooks references', () => {
    const hooksRaw = fs.readFileSync(path.resolve('hooks.json'), 'utf8');
    assert.ok(!hooksRaw.includes('./src/hooks/'), 'hooks.json must not resolve ./src/hooks/ from workspace CWD');
    assert.ok(!hooksRaw.includes('.agents/plugins'), 'hooks.json must not resolve .agents/plugins from workspace CWD');

    const parsedHooks = JSON.parse(hooksRaw);
    for (const group of Object.values(parsedHooks.hooks || {})) {
      for (const entry of group) {
        for (const h of entry.hooks || []) {
          assert.ok(h.command.includes('agy-horizon-flightcheck'), `Expected trusted plugin path in hook command: ${h.command}`);
          assert.ok(!h.command.includes('./src/hooks'), `Untrusted CWD hook path found: ${h.command}`);
        }
      }
    }

    const cmd = buildTrustedPluginHookCommand('pre_invocation.mjs');
    assert.ok(!cmd.includes('./src/hooks/'));
    assert.ok(cmd.includes('agy-horizon-flightcheck'));

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss037-hooks-'));
    try {
      const reg = registerCliDampeningHook(tmpHome, { dryRun: false });
      assert.equal(reg.success, true);
      assert.equal(reg.written, true);
      const writtenHooks = fs.readFileSync(reg.hooksPath, 'utf8');
      assert.ok(!writtenHooks.includes('./src/hooks/'));
      assert.ok(!writtenHooks.includes('.agents/plugins'));
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }

    const panelHtml = fs.readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8');
    assert.ok(panelHtml.includes('X-Horizon-CSRF'), 'horizon_panel.html must attach X-Horizon-CSRF header on POST requests');
    assert.ok(panelHtml.includes('__HORIZON_CSRF_TOKEN__'), 'horizon_panel.html must read window.__HORIZON_CSRF_TOKEN__');
  });

  it('enforces Origin!=null, non-wildcard CORS, per-boot CSRF on browser POSTs, 1MB body cap (413), SSE 16-client cap (429), and read-only /api/tail/trim', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss037-daemon-'));
    const port = await getFreeLoopbackPort();
    const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const logsDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const hostTranscriptPath = path.join(logsDir, 'transcript_full.jsonl');

    const sampleSteps = [
      { step_index: 0, type: 'USER_INPUT', content: 'Run build check', created_at: '2026-11-10T10:00:00Z' },
      { step_index: 1, type: 'TOOL_RESPONSE', content: 'X'.repeat(24000), created_at: '2026-11-10T10:00:05Z' },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: 'Inspecting output', created_at: '2026-11-10T10:00:10Z' },
      { step_index: 3, type: 'USER_INPUT', content: 'Continue', created_at: '2026-11-10T10:00:15Z' }
    ];
    const originalTranscriptContent = sampleSteps.map((s) => JSON.stringify(s)).join('\n') + '\n';
    fs.writeFileSync(hostTranscriptPath, originalTranscriptContent, 'utf8');

    const daemonProc = spawn(
      process.execPath,
      [path.resolve('sidecars/horizon-daemon/server.mjs'), '--demo'],
      {
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          PORT: String(port)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for test Horizon daemon to listen')), 10000);
      daemonProc.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Listening on')) {
          clearTimeout(timer);
          resolve();
        }
      });
      daemonProc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Daemon exited prematurely with code ${code}`));
      });
    });

    const openStreams = [];
    try {
      // 1. Reject sandboxed iframe `Origin: null`
      const nullOriginRes = await sendRawHttpRequest({
        port,
        method: 'GET',
        pathName: '/api/health',
        headers: { Origin: 'null' }
      });
      assert.equal(nullOriginRes.statusCode, 403);
      assert.notEqual(nullOriginRes.headers['access-control-allow-origin'], '*');

      // 2. Echo exact loopback Origin (never '*') and retrieve per-boot CSRF token
      const validOrigin = `http://127.0.0.1:${port}`;
      const csrfRes = await sendRawHttpRequest({
        port,
        method: 'GET',
        pathName: '/api/csrf-token',
        headers: { Origin: validOrigin }
      });
      assert.equal(csrfRes.statusCode, 200);
      assert.equal(csrfRes.headers['access-control-allow-origin'], validOrigin);
      const { csrfToken } = JSON.parse(csrfRes.body);
      assert.match(csrfToken, /^[0-9a-f]{64}$/);

      // 3. Browser-originated POST without X-Horizon-CSRF -> 403
      const missingCsrfPost = await sendRawHttpRequest({
        port,
        method: 'POST',
        pathName: '/api/settings',
        headers: {
          Origin: validOrigin,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reminderAtPct: 75 })
      });
      assert.equal(missingCsrfPost.statusCode, 403);

      // 4. Browser-originated POST with valid X-Horizon-CSRF -> 200
      const validCsrfPost = await sendRawHttpRequest({
        port,
        method: 'POST',
        pathName: '/api/settings',
        headers: {
          Origin: validOrigin,
          'Content-Type': 'application/json',
          'X-Horizon-CSRF': csrfToken
        },
        body: JSON.stringify({ reminderAtPct: 75 })
      });
      assert.equal(validCsrfPost.statusCode, 200);

      // 5. POST /api/tail/trim never mutates host transcript_full.jsonl on disk (ISS-023 + AGENTS.md Invariant 4)
      const trimPost = await sendRawHttpRequest({
        port,
        method: 'POST',
        pathName: '/api/tail/trim',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ conversationId: convId, transcriptPath: hostTranscriptPath })
      });
      assert.equal(trimPost.statusCode, 200);
      const trimJson = JSON.parse(trimPost.body);
      assert.equal(trimJson.hostTranscriptMutated, false);
      assert.equal(
        fs.readFileSync(hostTranscriptPath, 'utf8'),
        originalTranscriptContent,
        'Host Antigravity transcript_full.jsonl must remain byte-for-byte untouched'
      );

      // 6. Oversized >1MB POST payload -> 413 Payload Too Large
      const oversizedBody = JSON.stringify({ pad: 'A'.repeat(1_100_000) });
      const tooLargeRes = await sendRawHttpRequest({
        port,
        method: 'POST',
        pathName: '/api/settings',
        headers: {
          'Content-Type': 'application/json'
        },
        body: oversizedBody
      });
      assert.equal(tooLargeRes.statusCode, 413);

      // 7. SSE cap: 16 concurrent clients allowed, 17th returns 429
      for (let i = 0; i < 16; i++) {
        await new Promise((resolve, reject) => {
          const req = http.get(
            { hostname: '127.0.0.1', port, path: '/api/stream', agent: false },
            (res) => {
              assert.equal(res.statusCode, 200);
              openStreams.push({ req, res });
              resolve();
            }
          );
          req.on('error', reject);
        });
      }
      const seventeenthRes = await sendRawHttpRequest({
        port,
        method: 'GET',
        pathName: '/api/stream'
      });
      assert.equal(seventeenthRes.statusCode, 429);
    } finally {
      for (const s of openStreams) {
        try { s.req.destroy(); } catch (err) { if (err && err.code !== 'ERR_STREAM_DESTROYED') throw err; }
        try { s.res.destroy(); } catch (err) { if (err && err.code !== 'ERR_STREAM_DESTROYED') throw err; }
      }
      try { daemonProc.kill(); } catch (err) { if (err && !['ESRCH', 'EINVAL', 'EPERM'].includes(err.code)) throw err; }
      await new Promise((r) => daemonProc.once('exit', r));
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('Batch 1 Remediation — ISS-044: Hardened agy_git_guard.mjs & Tokenized DET-08', () => {
  it('parses short-option clusters left-to-right (-mnotes allowed, -mfoo --no-verify blocked) and blocks hook-bypass vectors', () => {
    // Commit message starting with 'n' attached to -m must NOT false-positive
    const mnotes = inspectGitArgs(['commit', '-mnotes'], {});
    assert.equal(mnotes.blocked, false);

    // Attached -mfoo must NOT consume the next token (--no-verify must still be caught!)
    const mfooBypass = inspectGitArgs(['commit', '-mfoo', '--no-verify'], {});
    assert.equal(mfooBypass.blocked, true);

    // `git log -n 5` and `git show -n 1` must NOT false-positive
    assert.equal(inspectGitArgs(['log', '-n', '5'], {}).blocked, false);
    assert.equal(inspectGitArgs(['show', '-n', '1'], {}).blocked, false);

    // HUSKY_SKIP_HOOKS=1, GIT_CONFIG_COUNT/KEY=core.hooksPath, attached -ccore.hooksPath=..., and `git config core.hooksPath`
    assert.equal(inspectGitArgs(['commit', '-m', 'ok'], { HUSKY_SKIP_HOOKS: '1' }).blocked, true);
    assert.equal(inspectGitArgs(['commit', '-m', 'ok'], { HUSKY_SKIP_HOOKS: '0' }).blocked, false);
    assert.equal(
      inspectGitArgs(['commit', '-m', 'ok'], {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/tmp/evil'
      }).blocked,
      true
    );
    assert.equal(inspectGitArgs(['-ccore.hooksPath=/tmp/evil', 'commit', '-m', 'ok'], {}).blocked, true);
    assert.equal(inspectGitArgs(['config', 'core.hooksPath', '/tmp/evil'], {}).blocked, true);
    assert.equal(inspectGitArgs(['config', '--local', 'core.hooksPath', '/tmp/evil'], {}).blocked, true);
    assert.equal(inspectGitArgs(['config', '--get', 'core.hooksPath'], {}).blocked, false);
  });

  it('stores HMAC-signed bypass nonces outside workspace by default and rejects tampered/unsigned nonces', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss044-ws-'));
    const tmpSec = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss044-sec-'));
    try {
      const defaultNoncePath = getBypassNonceFilePath(tmpWs);
      assert.ok(
        !defaultNoncePath.startsWith(tmpWs),
        `Default bypass nonce path (${defaultNoncePath}) must reside outside agent-writable workspace (${tmpWs})`
      );
      assert.ok(defaultNoncePath.includes('.attention-horizon'));

      const nonceFilePath = path.join(tmpSec, 'git_bypass_nonce.json');
      const secretKeyPath = path.join(tmpSec, 'git_bypass_hmac.key');

      // Unsigned JSON forged on disk must be rejected
      fs.writeFileSync(
        nonceFilePath,
        JSON.stringify({ nonce: 'forged123', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 }),
        'utf8'
      );
      const forgedCheck = consumeGitBypassNonce({ nonceFilePath, secretKeyPath });
      assert.equal(forgedCheck.allowed, false);
      assert.equal(forgedCheck.reason, 'INVALID_SIGNATURE');

      // Properly signed nonce fails if tampered on disk
      const issued = generateGitBypassNonce({ nonceFilePath, secretKeyPath });
      assert.ok(issued.signature);
      const rawIssued = JSON.parse(fs.readFileSync(nonceFilePath, 'utf8'));
      rawIssued.expiresAtMs += 999_999;
      fs.writeFileSync(nonceFilePath, JSON.stringify(rawIssued), 'utf8');
      const tamperedCheck = consumeGitBypassNonce({ nonceFilePath, secretKeyPath });
      assert.equal(tamperedCheck.allowed, false);
      assert.equal(tamperedCheck.reason, 'INVALID_SIGNATURE');

      // Untampered signed nonce succeeds strictly once
      const cleanIssued = generateGitBypassNonce({ nonceFilePath, secretKeyPath });
      assert.ok(cleanIssued.nonce);
      const cleanCheck = consumeGitBypassNonce({ nonceFilePath, secretKeyPath });
      assert.equal(cleanCheck.allowed, true);
      const replayCheck = consumeGitBypassNonce({ nonceFilePath, secretKeyPath });
      assert.equal(replayCheck.allowed, false);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
      fs.rmSync(tmpSec, { recursive: true, force: true });
    }
  });

  it('combines Windows PATH + Path when resolving git and fails closed with exit 127 when missing', () => {
    const tmpShimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss044-shim-'));
    const tmpRealGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss044-realgit-'));
    try {
      const fakeGitBin = path.join(tmpRealGitDir, 'git.exe');
      const fakeShimFile = path.join(tmpShimDir, 'agy_git_guard.mjs');
      fs.writeFileSync(fakeGitBin, 'echo git', 'utf8');
      fs.writeFileSync(fakeShimFile, '// shim', 'utf8');

      const scopedFs = {
        existsSync: (p) => path.resolve(p) === path.resolve(fakeGitBin) || path.resolve(p) === path.resolve(fakeShimFile),
        statSync: () => ({ isFile: () => true }),
        realpathSync: (p) => path.resolve(p)
      };

      // Simulate `env.PATH` holding only the shim dir while `env.Path` holds the real git dir on win32
      const resolved = resolveRealGitBinary({
        env: { PATH: tmpShimDir, Path: tmpRealGitDir },
        platform: 'win32',
        fsModule: scopedFs,
        shimFilePath: fakeShimFile
      });
      assert.equal(path.resolve(resolved), path.resolve(fakeGitBin));

      // When no real git exists anywhere, fail closed (null -> exitCode 127, never bare 'git')
      const emptyFs = {
        existsSync: () => false,
        statSync: () => ({ isFile: () => false }),
        realpathSync: (p) => path.resolve(p)
      };
      const missing = resolveRealGitBinary({
        env: { PATH: tmpShimDir, Path: '' },
        platform: 'win32',
        fsModule: emptyFs,
        shimFilePath: fakeShimFile
      });
      assert.equal(missing, null);

      const guardRes = runGitGuard({
        args: ['status'],
        env: { PATH: tmpShimDir, Path: '' },
        cwd: tmpShimDir,
        platform: 'win32',
        fsModule: emptyFs,
        stderr: { write() {} }
      });
      assert.equal(guardRes.exitCode, 127);
    } finally {
      fs.rmSync(tmpShimDir, { recursive: true, force: true });
      fs.rmSync(tmpRealGitDir, { recursive: true, force: true });
    }
  });

  it('tokenizes DET-08 shell commands so quoted strings do not trigger false positives', () => {
    const benignSteps = [
      {
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', arguments: { CommandLine: 'git commit -m "fix --no-verify and reset --hard docs"' } },
          { name: 'run_command', arguments: { CommandLine: 'echo "git push --force && git clean -fd"' } }
        ]
      }
    ];
    const benignRes = evaluateDetectorsOnSteps(benignSteps);
    const benignDet08 = benignRes.findings.filter((f) => f.detectorId === 'DET-08');
    assert.equal(benignDet08.length, 0, 'Quoted strings must not trigger DET-08');

    const destructiveSteps = [
      {
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', arguments: { CommandLine: 'git commit -m "msg" --no-verify' } },
          { name: 'run_command', arguments: { CommandLine: 'git reset --hard HEAD~1' } }
        ]
      }
    ];
    const destructiveRes = evaluateDetectorsOnSteps(destructiveSteps);
    const destructiveDet08 = destructiveRes.findings.filter((f) => f.detectorId === 'DET-08');
    assert.equal(destructiveDet08.length, 2);
  });
});

describe('Batch 1 Remediation — ISS-045: Centralized openLocalHorizonDb (WAL + busy_timeout=5000) & Host DB Guards', () => {
  it('configures WAL + busy_timeout=5000 on local DBs, enforces readOnly handles, and blocks RW opens on host DBs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-iss045-sqlite-'));
    try {
      const localDbPath = path.join(tmpDir, '.agents', 'cache', 'plugin_store.sqlite');
      const rwDb = openLocalHorizonDb(localDbPath, { readOnly: false });
      try {
        const jm = rwDb.prepare('PRAGMA journal_mode').get();
        const bt = rwDb.prepare('PRAGMA busy_timeout').get();
        assert.equal(String(jm.journal_mode).toLowerCase(), 'wal');
        assert.equal(Number(bt.timeout), 5000);
        rwDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'ok\');');
      } finally {
        rwDb.close();
      }

      const roDb = openLocalHorizonDb(localDbPath, { readOnly: true });
      try {
        assert.equal(roDb.prepare('SELECT v FROM t WHERE id = 1').get().v, 'ok');
        assert.throws(() => roDb.exec('INSERT INTO t (v) VALUES (\'blocked\')'), /readonly|read-only/i);
      } finally {
        roDb.close();
      }

      // Host protected DB paths must throw immediately on RW open
      const hostConvDb = path.join(tmpDir, '.gemini', 'antigravity', 'conversations', 'sess-1.db');
      const hostSummariesDb = path.join(tmpDir, '.gemini', 'antigravity', 'conversation_summaries.db');
      const hostVscdb = path.join(tmpDir, 'state.vscdb');
      assert.equal(isHostProtectedSqlitePath(hostConvDb), true);
      assert.equal(isHostProtectedSqlitePath(hostSummariesDb), true);
      assert.equal(isHostProtectedSqlitePath(hostVscdb), true);

      assert.throws(() => openLocalHorizonDb(hostConvDb, { readOnly: false }), /Zero-Trust SQLite Guard/);
      assert.throws(() => openLocalHorizonDb(hostSummariesDb, { readOnly: false }), /Zero-Trust SQLite Guard/);
      assert.throws(() => openLocalHorizonDb(hostVscdb, { readOnly: false }), /Zero-Trust SQLite Guard/);

      // Create host conversation DB to verify runPassiveWalCheckpoint unconditionally skips even if allowHostWriteOverride: true is passed
      fs.mkdirSync(path.dirname(hostConvDb), { recursive: true });
      const seedHost = new DatabaseSync(hostConvDb);
      seedHost.exec('CREATE TABLE meta (k TEXT);');
      seedHost.close();

      const cpHost = await runPassiveWalCheckpoint(hostConvDb, { allowHostWriteOverride: true });
      assert.equal(cpHost.skipped, true);
      assert.equal(cpHost.reason, 'HOST_DB_READONLY_GUARD');

      const healthHost = await inspectDatabaseWalHealth(hostConvDb);
      assert.equal(healthHost.readOnlyEnforced, true);

      const cpLocal = await runPassiveWalCheckpoint(localDbPath);
      assert.equal(cpLocal.success, true);
      assert.equal(cpLocal.skipped, false);

      // Verify compactCursorVscdbStreaming rejects host state.vscdb and outside-.agents paths
      const seedVsc = new DatabaseSync(hostVscdb);
      seedVsc.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);');
      seedVsc.close();
      const auditHost = await auditCursorVscdbOrphans(hostVscdb);
      assert.equal(auditHost.totalRows, 0);

      const blockedCompact = await compactCursorVscdbStreaming(hostVscdb, { dryRun: false });
      assert.equal(blockedCompact.success, false);
      assert.equal(blockedCompact.blockedHostWrite, true);
      assert.equal(blockedCompact.reason, 'HOST_DB_READONLY_GUARD');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
