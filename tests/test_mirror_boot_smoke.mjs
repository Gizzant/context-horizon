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
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncAndVerifyMirrors, getSyncedPluginSubdirs } from '../scripts/sync_mirrors.mjs';

const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
const AGY_HORIZON_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon');
const FLIGHTCHECK_ROOT = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');
const ACTIVE_MIRRORS = [AGY_HORIZON_ROOT, FLIGHTCHECK_ROOT].filter(r => fs.existsSync(r));

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
    assert.equal(result.parityOk, true, 'Mirror verification must succeed');
    assert.ok(result.verifiedFilePairs >= 300, `Expected >= 300 verified file pairs, got ${result.verifiedFilePairs}`);
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
