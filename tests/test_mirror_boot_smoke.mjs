/**
 * @file tests/test_mirror_boot_smoke.mjs
 * Automated Mirror Boot & Import Resolution Smoke Test Suite.
 *
 * Verifies that active Antigravity plugin mirrors (~/.gemini/config/plugins/agy-horizon*):
 * 1. Maintain 100% SHA-256 byte-for-byte parity across all isomorphic core, node engine,
 *    and hook handler modules.
 * 2. Successfully boot sidecars/horizon-daemon/server.mjs without ERR_MODULE_NOT_FOUND.
 * 3. Resolve 100% of ESM imports across all lifecycle hooks and hook handlers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { syncAndVerifyMirrors, getSyncedPluginSubdirs } from '../scripts/sync_mirrors.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeDir = process.env.HIGHBEAM_TEST_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
const AGY_HORIZON_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon');
const FLIGHTCHECK_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');
// In-repo mirror (.agents/plugins/...) is always checked, so isolated test homes keep boot coverage.
const IN_REPO_FLIGHTCHECK_ROOT = path.join(REPO_ROOT, '.agents', 'plugins', 'agy-horizon-flightcheck');
const ACTIVE_MIRRORS = [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT, IN_REPO_FLIGHTCHECK_ROOT].filter(r => fs.existsSync(r));

describe('Mirror Boot & ESM Import Resolution Smoke Suite', () => {
  test('discovers all v4 directories recursively under src, hooks, sidecars', () => {
    const subdirs = getSyncedPluginSubdirs();
    const joined = subdirs.map(parts => parts.join('/'));

    assert.ok(joined.includes('src/core-isomorphic'), 'Must discover src/core-isomorphic');
    assert.ok(joined.includes('src/core-isomorphic/catalog'), 'Must discover src/core-isomorphic/catalog');
    assert.ok(joined.includes('src/core-isomorphic/guards'), 'Must discover src/core-isomorphic/guards');
    assert.ok(joined.includes('src/engine-node'), 'Must discover src/engine-node');
    assert.ok(joined.includes('src/engine-node/db'), 'Must discover src/engine-node/db');
    assert.ok(joined.includes('src/engine-node/sensors'), 'Must discover src/engine-node/sensors');
    assert.ok(joined.includes('hooks/handlers'), 'Must discover hooks/handlers');
    assert.ok(joined.includes('sidecars/horizon-daemon'), 'Must discover sidecars/horizon-daemon');
    assert.ok(subdirs.length >= 35, `Expected >= 35 subdirectories discovered, got ${subdirs.length}`);
  });

  test('sync_mirrors --verify-only verifies 100% SHA-256 parity', () => {
    const result = syncAndVerifyMirrors({ verifyOnly: true });

    if (result.pluginStatus === 'not installed' || result.notInstalledRoots.length > 0) {
      assert.equal(result.parityOk, true, 'Every present mirror pair must match byte-for-byte');
      assert.match(result.sha256, /^[a-f0-9]{64}$/, 'Canonical HTML SHA-256 digest must be returned');

      const sha256Lf = (p) =>
        crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');

      const candidateHtmlTargets = [
        path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html'),
        ...ACTIVE_MIRRORS.flatMap((r) => [
          path.join(r, 'src', 'ui', 'sidepane.html'),
          path.join(r, 'src', 'webview', 'horizon_panel.html')
        ]),
        path.join(REPO_ROOT, 'evaluation_bundles', 'tier_2_full', 'src', 'webview', 'horizon_panel.html')
      ];
      const presentHtmlTargets = Array.from(new Set(candidateHtmlTargets.map((p) => path.resolve(p)))).filter((p) =>
        fs.existsSync(p)
      );
      assert.equal(result.targets, presentHtmlTargets.length, 'Verified HTML target count must match present targets');
      for (const htmlTarget of presentHtmlTargets) {
        assert.equal(sha256Lf(htmlTarget), result.sha256, `Present HTML target must match canonical SHA-256: ${htmlTarget}`);
      }

      const canonicalRouter = path.join(REPO_ROOT, 'src', 'core-isomorphic', 'coach', 'cacheGravityRouter.mjs');
      const canonicalRouterSha = sha256Lf(canonicalRouter);
      for (const wsMirror of [
        path.join(REPO_ROOT, 'packages', 'core', 'src', 'coach', 'cacheGravityRouter.mjs'),
        path.join(REPO_ROOT, 'packages', 'engine-node', 'src', 'vendor', 'core-isomorphic', 'coach', 'cacheGravityRouter.mjs'),
        path.join(REPO_ROOT, 'packages', 'mcp', 'src', 'vendor', 'core-isomorphic', 'coach', 'cacheGravityRouter.mjs')
      ]) {
        assert.equal(sha256Lf(wsMirror), canonicalRouterSha, `Workspace mirror must match canonical SHA-256: ${wsMirror}`);
      }

      const hasEvalBundles =
        fs.existsSync(path.join(REPO_ROOT, 'evaluation_bundles', 'tier_1_essential')) ||
        fs.existsSync(path.join(REPO_ROOT, 'evaluation_bundles', 'tier_2_full'));
      const expectedMinPairs = ACTIVE_MIRRORS.length * 200 + (hasEvalBundles ? 50 : 0);
      assert.ok(
        result.verifiedFilePairs >= expectedMinPairs,
        `Expected >= ${expectedMinPairs} verified present mirror pairs, got ${result.verifiedFilePairs}`
      );

      const canonicalInRepoTargets = [
        path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html'),
        path.join(REPO_ROOT, 'docs', 'index.html'),
        path.join(REPO_ROOT, 'packages', 'core', 'src', 'coach', 'cacheGravityRouter.mjs'),
        path.join(REPO_ROOT, 'packages', 'engine-node', 'src', 'vendor', 'core-isomorphic', 'coach', 'cacheGravityRouter.mjs'),
        path.join(REPO_ROOT, 'packages', 'mcp', 'src', 'vendor', 'core-isomorphic', 'coach', 'cacheGravityRouter.mjs')
      ];
      if (fs.existsSync(IN_REPO_FLIGHTCHECK_ROOT)) {
        canonicalInRepoTargets.push(
          path.join(IN_REPO_FLIGHTCHECK_ROOT, 'src', 'webview', 'horizon_panel.html'),
          path.join(IN_REPO_FLIGHTCHECK_ROOT, 'src', 'ui', 'sidepane.html')
        );
      }
      for (const target of canonicalInRepoTargets) {
        assert.equal(fs.existsSync(target), true, `Canonical in-repo target must be present: ${target}`);
      }

      const missingRoots = [FLIGHTCHECK_ROOT, IN_REPO_FLIGHTCHECK_ROOT].filter((r) => !fs.existsSync(r));
      assert.ok(missingRoots.length > 0, 'At least one expected root must be missing');
      for (const missingRoot of missingRoots) {
        assert.ok(
          result.notInstalledRoots.includes(missingRoot),
          `Missing root must appear in notInstalledRoots: ${missingRoot}`
        );
      }
      assert.equal(result.notInstalledRoots.length, missingRoots.length, 'notInstalledRoots must list every missing root');
    } else {
      assert.equal(result.parityOk, true, 'Mirror verification must succeed');
      assert.ok([6, 8].includes(result.targets), `Expected 6 or 8 HTML targets, got ${result.targets}`);
      assert.ok(result.verifiedFilePairs >= 500, `Expected >= 500 verified file pairs, got ${result.verifiedFilePairs}`);
    }
  });

  test('verifyOnly: true reports "not installed" under missing test home and leaves .agents/ unchanged', () => {
    const repoAgentsDir = path.resolve(path.dirname(IN_REPO_FLIGHTCHECK_ROOT), '..');
    const snapshotTree = (root) => {
      if (!fs.existsSync(root)) return [];
      const out = [];
      const stack = [root];
      while (stack.length > 0) {
        const cur = stack.pop();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, ent.name);
          const rel = path.relative(root, full).replace(/\\/g, '/');
          // Skip live host IDE telemetry logs (.agents/telemetry/*.rsl_steps.jsonl) which append concurrently during tool calls.
          if (rel === 'telemetry') continue;
          if (ent.isDirectory()) {
            stack.push(full);
          } else if (ent.isFile()) {
            const st = fs.statSync(full);
            const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            out.push({ rel, mtimeMs: st.mtimeMs, sha256 });
          }
        }
      }
      return out.sort((a, b) => a.rel.localeCompare(b.rel));
    };

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-empty-home-'));
    const beforeAgents = snapshotTree(repoAgentsDir);
    const capturedLogs = [];
    const origLog = console.log;
    console.log = (...args) => capturedLogs.push(args.map(String).join(' '));
    let verifyRes = null;
    try {
      try {
        verifyRes = syncAndVerifyMirrors({ verifyOnly: true, homeDir: emptyHome });
      } catch (err) {
        if (!/Mirror SHA-256 Parity FAILED/.test(String(err?.message || ''))) {
          throw err;
        }
      }
      const combinedLog = capturedLogs.join('\n');
      assert.match(combinedLog, /not installed/i, 'verifyOnly must report "not installed" when home plugin root is missing');
      assert.equal(
        fs.existsSync(path.join(emptyHome, '.gemini')),
        false,
        'verifyOnly must never bootstrap ~/.gemini under isolated test home'
      );
      if (verifyRes) {
        assert.equal(verifyRes.pluginStatus, 'not installed');
        assert.ok(
          verifyRes.notInstalledRoots.includes(path.join(emptyHome, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck'))
        );
      }
      const afterAgents = snapshotTree(repoAgentsDir);
      assert.deepEqual(afterAgents, beforeAgents, 'verifyOnly must leave .agents/ files, mtimes, and hashes untouched');
    } finally {
      console.log = origLog;
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  for (const mirrorRoot of ACTIVE_MIRRORS) {
    const mirrorName = path.basename(mirrorRoot);

    describe(`Mirror: ${mirrorName}`, () => {
      test('mirrored package.json exists with type module', () => {
        const pkgPath = path.join(mirrorRoot, 'package.json');
        assert.ok(fs.existsSync(pkgPath), `package.json must exist in ${mirrorName}`);
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        assert.equal(pkg.type, 'module', `package.json in ${mirrorName} must have type: module`);
      });

      test('mirrored plugin.json exists with Highbeam branding', () => {
        const pluginPath = path.join(mirrorRoot, 'plugin.json');
        assert.ok(fs.existsSync(pluginPath), `plugin.json must exist in ${mirrorName}`);
        const manifest = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
        assert.ok(
          String(manifest.displayName || '').startsWith('Highbeam'),
          `displayName must start with 'Highbeam', got "${manifest.displayName}"`
        );
      });

      test('mirrored server.mjs boots cleanly without ERR_MODULE_NOT_FOUND', async () => {
        const serverScript = path.join(mirrorRoot, 'sidecars', 'horizon-daemon', 'server.mjs');
        assert.ok(fs.existsSync(serverScript), `server.mjs must exist at ${serverScript}`);

        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--no-warnings', serverScript], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: '0' } // Port 0 for ephemeral test binding
          });

          let stdoutBuf = '';
          let stderrBuf = '';
          let settled = false;

          const timeoutTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { child.kill('SIGKILL'); } catch (err) { void err; }
              reject(new Error(`Daemon startup timed out after 8s. Stderr: ${stderrBuf}\nStdout: ${stdoutBuf}`));
            }
          }, 8000);

          child.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            if (/Listening on http:\/\//i.test(stdoutBuf)) {
              if (!settled) {
                settled = true;
                clearTimeout(timeoutTimer);
                try { child.kill('SIGTERM'); } catch (err) { void err; }
                assert.ok(!stderrBuf.includes('ERR_MODULE_NOT_FOUND'), `Must not contain ERR_MODULE_NOT_FOUND: ${stderrBuf}`);
                resolve();
              }
            }
          });

          child.stderr.on('data', chunk => {
            stderrBuf += chunk.toString();
            if (stderrBuf.includes('ERR_MODULE_NOT_FOUND')) {
              if (!settled) {
                settled = true;
                clearTimeout(timeoutTimer);
                try { child.kill('SIGKILL'); } catch (err) { void err; }
                reject(new Error(`Daemon crashed with ERR_MODULE_NOT_FOUND: ${stderrBuf}`));
              }
            }
          });

          child.on('exit', (code, signal) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutTimer);
              if (code !== 0 && signal !== 'SIGTERM') {
                reject(new Error(`Daemon exited prematurely with code ${code} signal ${signal}. Stderr: ${stderrBuf}`));
              } else {
                resolve();
              }
            }
          });
        });
      });

      test('resolves 100% of ESM imports across all hooks and handlers', async () => {
        const hookDirs = [
          path.join(mirrorRoot, 'hooks'),
          path.join(mirrorRoot, 'hooks', 'handlers'),
          path.join(mirrorRoot, 'src', 'hooks')
        ];

        let filesTested = 0;
        for (const dir of hookDirs) {
          if (!fs.existsSync(dir)) continue;
          const entries = fs.readdirSync(dir).filter(f => f.endsWith('.mjs'));
          for (const file of entries) {
            const filePath = path.join(dir, file);
            const fileUrl = pathToFileURL(filePath).href;

            // Execute dynamic import resolution in isolated node process to verify module graph integrity
            await new Promise((resolve, reject) => {
              const proc = spawn(
                process.execPath,
                ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(fileUrl)})`],
                { stdio: ['pipe', 'pipe', 'pipe'] }
              );

              // Feed empty object JSON on stdin in case the hook listens for CLI input immediately
              proc.stdin.write('{}\n');
              proc.stdin.end();

              let errBuf = '';
              proc.stderr.on('data', d => { errBuf += d.toString(); });

              proc.on('close', code => {
                if (errBuf.includes('ERR_MODULE_NOT_FOUND')) {
                  reject(new Error(`Module import resolution failed in ${file}: ${errBuf}`));
                } else {
                  filesTested += 1;
                  resolve();
                }
              });
            });
          }
        }

        assert.ok(filesTested >= 10, `Expected >= 10 hook files tested in ${mirrorName}, got ${filesTested}`);
      });
    });
  }
});
