/**
 * @file src/engine-node/ipc/fast_client.mjs
 * Minimal zero-heavy-dependency JSON-RPC client for warm Horizon Daemon IPC checks.
 *
 * Imports strictly Node built-ins (`node:fs`, `node:path`, `node:os`, `node:net`) so
 * thin Tier-2 CLI hook shells avoid loading heavyweight ESM trees when probing or
 * dispatching directly over the warm daemon socket/pipe.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

function normalizeHomePath(raw = '') {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Ensures tests that isolate `HOME`/`USERPROFILE` to temporary sandboxes never
 * auto-connect to a developer's live host daemon pipe unless `CTXTOP_IPC_PATH`
 * is explicitly specified.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export function isRealHostHomeEnv(env = process.env) {
  if (env && typeof env.CTXTOP_IPC_PATH === 'string' && env.CTXTOP_IPC_PATH.trim()) {
    return true;
  }
  const envHome = normalizeHomePath(env?.USERPROFILE || env?.HOME || '');
  if (!envHome) return true;
  let realHome = '';
  try {
    realHome = normalizeHomePath(os.userInfo()?.homedir || '');
  } catch (err) {
    void err;
    return true;
  }
  if (!realHome) return true;
  if (process.platform === 'win32') {
    return envHome.toLowerCase() === realHome.toLowerCase();
  }
  return envHome === realHome;
}

/**
 * Mirrors `resolveIpcPath` from `src/engine-node/ipc/protocol.mjs` without loading it.
 *
 * @param {object} [options={}]
 * @returns {string | null}
 */
export function resolveFastIpcPipePath(options = {}) {
  if (options.ipcPath || process.env.CTXTOP_IPC_PATH) {
    return options.ipcPath || process.env.CTXTOP_IPC_PATH;
  }

  if (process.platform === 'win32') {
    let rawUser = process.env.USERNAME || process.env.USER;
    if (!rawUser) {
      try {
        rawUser = typeof os.userInfo === 'function' ? os.userInfo()?.username : null;
      } catch (err) {
        void err;
        rawUser = null;
      }
    }
    const cleanUser = String(rawUser || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `\\\\.\\pipe\\ctxtop-${cleanUser}`;
  }

  const homeDir = options.homeDir || process.env.HOME || os.homedir() || '/tmp';
  return path.join(homeDir, '.ctxtop', 'daemon.sock');
}

/**
 * Attempts a single fast JSON-RPC call to the warm Horizon Daemon pipe.
 * Returns `parsed.result` strictly when `result?.fullVerdict === true`, otherwise `null`.
 * Never writes to stderr and never throws.
 *
 * @param {string} method
 * @param {object} [params={}]
 * @param {object} [options={}]
 * @returns {Promise<object | null>}
 */
export function tryFastDaemonRpc(method, params = {}, options = {}) {
  if (!options.ipcPath && !process.env.CTXTOP_IPC_PATH && !isRealHostHomeEnv()) {
    return Promise.resolve(null);
  }
  const pipePath = resolveFastIpcPipePath(options);
  if (!pipePath || (process.platform !== 'win32' && !fs.existsSync(pipePath))) {
    return Promise.resolve(null);
  }

  const connectTimeoutMs = Math.max(1, Number(options.connectTimeoutMs ?? 12));
  const requestTimeoutMs = Math.max(20, Number(options.requestTimeoutMs ?? 5000));

  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let socket = null;
    let connectTimer = null;
    let requestTimer = null;
    let buffer = '';

    const settle = (val) => {
      if (settled) return;
      settled = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
      if (socket) {
        try {
          socket.removeAllListeners();
          socket.destroy();
        } catch (cleanupErr) {
          void cleanupErr;
        }
      }
      resolve(val);
    };

    try {
      socket = net.connect(pipePath);
    } catch (connErr) {
      void connErr;
      settle(null);
      return;
    }

    connectTimer = setTimeout(() => {
      if (!connected) settle(null);
    }, connectTimeoutMs);

    requestTimer = setTimeout(() => {
      settle(null);
    }, requestTimeoutMs);

    socket.once('connect', () => {
      connected = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      try {
        const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: String(method), params }) + '\n';
        socket.write(frame);
      } catch (writeErr) {
        void writeErr;
        settle(null);
      }
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2 * 1024 * 1024) {
        settle(null);
        return;
      }
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = buffer.slice(0, nlIdx).trim();
      if (!line) {
        buffer = buffer.slice(nlIdx + 1);
        return;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed && !parsed.error && parsed.result && parsed.result.fullVerdict === true) {
          settle(parsed.result);
        } else {
          settle(null);
        }
      } catch (parseErr) {
        void parseErr;
        settle(null);
      }
    });

    socket.once('error', () => settle(null));
    socket.once('close', () => settle(null));
  });
}
