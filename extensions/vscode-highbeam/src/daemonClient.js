'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DEFAULT_DAEMON_PORT = 62935;
const LOOPBACK_HOST = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

function isValidLoopbackPort(port) {
  const num = Number(port);
  return Number.isInteger(num) && num >= 1024 && num <= 65535;
}

function readJsonReadOnly(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    void err; // Ignore malformed or transient lockfiles; callers fall back cleanly.
    return null;
  }
}

function readPortLockfile(homeDir = os.homedir()) {
  const baseDir = path.join(String(homeDir || os.homedir()), '.ctxtop');
  const jsonPath = path.join(baseDir, 'daemon.json');
  const jsonLock = readJsonReadOnly(jsonPath);
  if (jsonLock && isValidLoopbackPort(jsonLock.port)) {
    return {
      port: Number(jsonLock.port),
      pid: Number.isInteger(Number(jsonLock.pid)) ? Number(jsonLock.pid) : null,
      workspace: typeof jsonLock.workspace === 'string' ? jsonLock.workspace : null,
      source: 'daemon.json',
      lockPath: jsonPath
    };
  }

  const portPath = path.join(baseDir, 'daemon.port');
  try {
    if (fs.existsSync(portPath)) {
      const raw = fs.readFileSync(portPath, 'utf8').trim();
      const parsed = parseInt(raw, 10);
      if (isValidLoopbackPort(parsed)) {
        return {
          port: parsed,
          pid: null,
          workspace: null,
          source: 'daemon.port',
          lockPath: portPath
        };
      }
    }
  } catch (err) {
    void err; // Ignore unreadable lockfile and fall back to default port scan.
  }
  return null;
}

function fetchLoopbackJson(port, apiPath = '/api/health', timeoutMs = 2500) {
  if (!isValidLoopbackPort(port)) {
    return Promise.reject(new Error(`Invalid loopback port: ${port}`));
  }
  const cleanPath = String(apiPath || '/api/health');
  if (!cleanPath.startsWith('/')) {
    return Promise.reject(new Error(`Invalid loopback path: ${cleanPath}`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data);
    };

    const req = http.get(
      {
        hostname: LOOPBACK_HOST,
        port: Number(port),
        path: cleanPath,
        timeout: Math.max(200, Number(timeoutMs || 2500)),
        headers: {
          Accept: 'application/json'
        }
      },
      (res) => {
        const chunks = [];
        let byteLen = 0;
        res.on('data', (chunk) => {
          byteLen += chunk.length;
          if (byteLen > MAX_JSON_BODY_BYTES) {
            req.destroy();
            finish(new Error('Loopback JSON payload exceeded 2 MB limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            finish(new Error(`HTTP ${res.statusCode} from ${cleanPath}`));
            return;
          }
          try {
            finish(null, JSON.parse(text));
          } catch (parseErr) {
            finish(new Error(`Invalid JSON from ${cleanPath}: ${parseErr.message}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Loopback request timeout (${cleanPath})`));
    });
    req.on('error', (err) => {
      finish(err);
    });
  });
}

async function discoverRunningDaemon(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const preferredPort = Number(options.preferredPort || DEFAULT_DAEMON_PORT);
  const timeoutMs = Number(options.timeoutMs || 1500);
  const lock = readPortLockfile(homeDir);

  const candidates = [];
  const pushCandidate = (port, source) => {
    if (!isValidLoopbackPort(port)) return;
    if (!candidates.some((c) => c.port === Number(port))) {
      candidates.push({ port: Number(port), source });
    }
  };

  if (lock) pushCandidate(lock.port, 'lockfile');
  pushCandidate(preferredPort, 'preferred');
  pushCandidate(DEFAULT_DAEMON_PORT, 'default');

  for (const cand of candidates) {
    try {
      const health = await fetchLoopbackJson(cand.port, '/api/health', timeoutMs);
      if (health && health.ok === true) {
        return {
          port: cand.port,
          health,
          source: cand.source
        };
      }
    } catch (err) {
      void err; // Probe next loopback candidate port cleanly.
    }
  }
  return null;
}

function resolveDaemonLaunchSpec(options = {}) {
  const nodePath = String(options.nodePath || process.execPath || 'node').trim() || 'node';
  const cliCommand = String(options.cliCommand || '').trim();
  const workspaceFolders = Array.isArray(options.workspaceFolders) ? options.workspaceFolders : [];
  const homeDir = String(options.homeDir || os.homedir());
  const extensionRoot = String(options.extensionRoot || path.resolve(__dirname, '..'));
  const platform = String(options.platform || process.platform);

  if (cliCommand) {
    if (/\.(mjs|js|cjs)$/i.test(cliCommand)) {
      const isDaemonScript = path.basename(cliCommand).toLowerCase() === 'server.mjs';
      return {
        command: nodePath,
        args: isDaemonScript ? [cliCommand] : [cliCommand, '--serve'],
        source: 'configured_script',
        useCmdWrapper: false
      };
    }
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliCommand)) {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', cliCommand, '--serve'],
        source: 'configured_cli',
        useCmdWrapper: true
      };
    }
    return {
      command: cliCommand,
      args: ['--serve'],
      source: 'configured_cli',
      useCmdWrapper: false
    };
  }

  for (const wsPath of workspaceFolders) {
    if (!wsPath) continue;
    const candidate = path.join(String(wsPath), 'sidecars', 'horizon-daemon', 'server.mjs');
    if (fs.existsSync(candidate)) {
      return {
        command: nodePath,
        args: [candidate],
        source: 'workspace_checkout',
        useCmdWrapper: false
      };
    }
  }

  const stableRoot = path.join(homeDir, '.ctxtop', 'app');
  if (fs.existsSync(stableRoot)) {
    try {
      const versions = fs
        .readdirSync(stableRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
      for (const ver of versions) {
        const candidate = path.join(stableRoot, ver, 'sidecars', 'horizon-daemon', 'server.mjs');
        if (fs.existsSync(candidate)) {
          return {
            command: nodePath,
            args: [candidate],
            source: 'stable_runtime',
            useCmdWrapper: false
          };
        }
      }
    } catch (err) {
      void err; // Fall back to monorepo sibling or npx when stable runtime folder cannot be listed.
    }
  }

  if (extensionRoot) {
    const monorepoSibling = path.resolve(extensionRoot, '..', '..', 'sidecars', 'horizon-daemon', 'server.mjs');
    if (fs.existsSync(monorepoSibling)) {
      return {
        command: nodePath,
        args: [monorepoSibling],
        source: 'monorepo_sibling',
        useCmdWrapper: false
      };
    }
  }

  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npx', '--yes', 'highbeam-cli', '--serve'],
      source: 'npx_fallback',
      useCmdWrapper: true
    };
  }

  return {
    command: 'npx',
    args: ['--yes', 'highbeam-cli', '--serve'],
    source: 'npx_fallback',
    useCmdWrapper: false
  };
}

class DaemonManager {
  constructor(options = {}) {
    this.getOptions = typeof options.getOptions === 'function' ? options.getOptions : () => options;
    this.spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.port = null;
    this.owned = false;
    this.ownedChild = null;
    this.startingPromise = null;
    this.lastError = null;
  }

  _opts() {
    return this.getOptions() || {};
  }

  async ensureRunning() {
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = this._ensureRunningInternal().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async _ensureRunningInternal() {
    const opts = this._opts();
    const homeDir = opts.homeDir || os.homedir();
    const preferredPort = Number(opts.preferredPort || DEFAULT_DAEMON_PORT);

    const existing = await discoverRunningDaemon({
      homeDir,
      preferredPort,
      timeoutMs: Number(opts.probeTimeoutMs || 1500)
    });
    if (existing) {
      this.port = existing.port;
      this.owned = Boolean(this.ownedChild && this.owned);
      this.lastError = null;
      return {
        ok: true,
        port: existing.port,
        owned: this.owned,
        source: existing.source,
        health: existing.health
      };
    }

    const spec = resolveDaemonLaunchSpec({
      workspaceFolders: opts.workspaceFolders,
      cliCommand: opts.cliCommand,
      nodePath: opts.nodePath,
      homeDir,
      extensionRoot: opts.extensionRoot,
      platform: opts.platform || process.platform
    });

    const childEnv = { ...process.env };
    if (isValidLoopbackPort(preferredPort) && preferredPort !== DEFAULT_DAEMON_PORT) {
      childEnv.PORT = String(preferredPort);
      childEnv.ANTIGRAVITY_SIDECAR_WEB_PORT = String(preferredPort);
    }

    const cwd = (Array.isArray(opts.workspaceFolders) && opts.workspaceFolders[0]) || homeDir;
    this.logger(`Spawning Highbeam daemon (${spec.source}): ${spec.command} ${spec.args.join(' ')}`);

    const child = this.spawnFn(spec.command, spec.args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.ownedChild = child;
    this.owned = true;
    this.lastError = null;

    let observedPort = null;
    let exitedEarly = false;
    let stderrTail = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      const match = text.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        const parsed = parseInt(match[1], 10);
        if (isValidLoopbackPort(parsed)) observedPort = parsed;
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1024);
    });

    child.once('error', (err) => {
      exitedEarly = true;
      this.lastError = err.message;
      this.logger(`Daemon process error: ${err.message}`);
    });

    child.once('exit', (code, signal) => {
      exitedEarly = true;
      if (this.ownedChild === child) {
        this.ownedChild = null;
        this.owned = false;
      }
      if (code !== 0 && code !== null) {
        this.lastError = stderrTail.trim() || `Daemon exited with code ${code} (${signal || 'none'})`;
      }
    });

    const deadline = Date.now() + Math.max(1500, Number(opts.startTimeoutMs || 8000));
    while (Date.now() < deadline) {
      if (observedPort) {
        try {
          const health = await fetchLoopbackJson(observedPort, '/api/health', 1000);
          if (health && health.ok === true) {
            this.port = observedPort;
            this.lastError = null;
            return { ok: true, port: observedPort, owned: true, source: spec.source, health };
          }
        } catch (err) {
          void err; // Keep waiting briefly until listener starts serving health.
        }
      }

      const discovered = await discoverRunningDaemon({
        homeDir,
        preferredPort,
        timeoutMs: 800
      });
      if (discovered) {
        this.port = discovered.port;
        this.lastError = null;
        return {
          ok: true,
          port: discovered.port,
          owned: Boolean(this.ownedChild),
          source: discovered.source,
          health: discovered.health
        };
      }

      if (exitedEarly) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!this.lastError) {
      this.lastError = stderrTail.trim() || 'Timed out waiting for Highbeam daemon on 127.0.0.1';
    }
    this.stop();
    return {
      ok: false,
      port: null,
      owned: false,
      error: this.lastError
    };
  }

  stop() {
    if (!this.ownedChild) {
      return {
        stopped: false,
        reason: this.port ? 'EXTERNAL_DAEMON' : 'NOT_RUNNING'
      };
    }
    const child = this.ownedChild;
    this.ownedChild = null;
    this.owned = false;
    this.port = null;
    try {
      child.kill();
    } catch (err) {
      void err; // Process may already be exiting.
    }
    return { stopped: true, owned: true };
  }

  async getHealth() {
    if (!isValidLoopbackPort(this.port)) return null;
    return fetchLoopbackJson(this.port, '/api/health', 1500);
  }

  async getState() {
    if (!isValidLoopbackPort(this.port)) return null;
    return fetchLoopbackJson(this.port, '/api/state', 2000);
  }
}

module.exports = {
  DEFAULT_DAEMON_PORT,
  LOOPBACK_HOST,
  isValidLoopbackPort,
  readPortLockfile,
  fetchLoopbackJson,
  discoverRunningDaemon,
  resolveDaemonLaunchSpec,
  DaemonManager
};
