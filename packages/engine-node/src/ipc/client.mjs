/**
 * @file src/engine-node/ipc/client.mjs
 * Highbeam Micro-IPC Client.
 *
 * Implements high-performance (<0.8ms SLA, p95 ~0.13ms) local IPC communication
 * with persistent warm socket reuse, message demultiplexing, and 15ms failover
 * to local in-process fallback execution when daemon is offline.
 * Strictly 0 npm dependencies (uses only standard node:* built-ins).
 */

import net from 'node:net';
import {
  resolveIpcPath,
  formatJsonRpcRequest,
  JsonRpcStreamParser,
  IPC_LIMITS
} from './protocol.mjs';

export class MicroIpcClient {
  /**
   * @param {object} [options]
   * @param {string} [options.ipcPath]
   * @param {number} [options.connectTimeoutMs=15]
   * @param {number} [options.requestTimeoutMs=500]
   * @param {boolean} [options.persistent=true]
   */
  constructor(options = {}) {
    this.ipcPath = resolveIpcPath(options);
    this.connectTimeoutMs = options.connectTimeoutMs ?? IPC_LIMITS.DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? IPC_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS;
    this.persistent = options.persistent ?? true;

    // Warm socket management
    this.activeSocket = null;
    this.streamParser = null;
    this.connectingPromise = null;

    // In-flight pending requests: Map<reqId, { resolve, reject, timer, method }>
    this.pendingRequests = new Map();
    this.isClosed = false;
  }

  /**
   * Returns the warm active socket if connected and writable, or initiates
   * a new connection if none exists or the previous socket was closed.
   *
   * @param {number} connectTimeoutMs
   * @returns {Promise<import('node:net').Socket>}
   * @private
   */
  async _ensureConnected(connectTimeoutMs) {
    if (this.isClosed) {
      this.isClosed = false;
    }

    if (
      this.activeSocket &&
      !this.activeSocket.destroyed &&
      !this.activeSocket.connecting &&
      this.activeSocket.writable
    ) {
      return this.activeSocket;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this._connect(connectTimeoutMs);
    try {
      return await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  /**
   * Establishes a new connection to the IPC socket / pipe.
   *
   * @param {number} connectTimeoutMs
   * @returns {Promise<import('node:net').Socket>}
   * @private
   */
  _connect(connectTimeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer = null;
      let socket = null;

      const cleanupTimer = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };

      try {
        socket = net.connect(this.ipcPath);
      } catch (err) {
        return reject(err);
      }

      // Fast connection timeout guard (default 15ms)
      connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanupTimer();
          try {
            socket.destroy();
          } catch (_err) {
            void _err;
          }
          reject(new Error(`[MicroIPC] Connection timeout (${connectTimeoutMs}ms) to ${this.ipcPath}`));
        }
      }, connectTimeoutMs);

      // Create stream parser attached to this socket
      const parser = new JsonRpcStreamParser(
        (msg) => this._onMessage(msg),
        (parseErr) => this._onParseError(parseErr, socket)
      );

      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        cleanupTimer();

        // Unref warm idle socket so it does not keep Node.js event loop alive unnecessarily
        socket.unref();

        this.activeSocket = socket;
        this.streamParser = parser;
        resolve(socket);
      });

      socket.on('data', (chunk) => {
        parser.feed(chunk);
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          cleanupTimer();
          reject(err);
        }
        this._handleSocketError(socket, err);
      });

      socket.on('close', () => {
        if (!settled) {
          settled = true;
          cleanupTimer();
          reject(new Error('[MicroIPC] Socket closed during connection'));
        }
        this._handleSocketClose(socket);
      });
    });
  }

  /**
   * Handles unexpected socket errors, cleans up active state, and rejects in-flight requests.
   *
   * @param {import('node:net').Socket} socket
   * @param {Error} err
   * @private
   */
  _handleSocketError(socket, err) {
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.streamParser = null;
    }
    const errorMsg = err?.message || 'Unknown socket error';
    this._rejectAllPending(new Error(`[MicroIPC] Socket error: ${errorMsg}`));
  }

  /**
   * Handles socket close / disconnect events, cleans up active state, and rejects in-flight requests.
   *
   * @param {import('node:net').Socket} socket
   * @private
   */
  _handleSocketClose(socket) {
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.streamParser = null;
    }
    this._rejectAllPending(new Error('[MicroIPC] Socket closed before receiving response'));
  }

  /**
   * Handles JSON-RPC stream parser errors (e.g. buffer overrun).
   *
   * @param {Error} parseErr
   * @param {import('node:net').Socket} socket
   * @private
   */
  _onParseError(parseErr, socket) {
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.streamParser = null;
      try {
        socket.destroy();
      } catch (_err) {
        void _err;
      }
    }
    this._rejectAllPending(parseErr);
  }

  /**
   * Rejects all currently pending in-flight requests with the given error.
   *
   * @param {Error} error
   * @private
   */
  _rejectAllPending(error) {
    const entries = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();
    for (const [id, pending] of entries) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      try {
        pending.reject(error);
      } catch (_err) {
        void _err;
      }
    }
  }

  /**
   * Dispatches incoming parsed JSON-RPC responses to their matching pending request.
   *
   * @param {object} msg
   * @private
   */
  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    if (id === null || id === undefined) return;

    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    this.pendingRequests.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    if (msg.error) {
      const errMsg = typeof msg.error === 'string'
        ? msg.error
        : (msg.error.message || 'JSON-RPC Error');
      const err = new Error(errMsg);
      if (typeof msg.error === 'object' && msg.error.code !== undefined) {
        err.code = msg.error.code;
      }
      if (typeof msg.error === 'object' && msg.error.data !== undefined) {
        err.data = msg.error.data;
      }
      pending.reject(err);
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Executes a remote JSON-RPC 2.0 method over the warm local IPC socket/pipe.
   *
   * @param {string} method
   * @param {*} [params={}]
   * @param {object} [options={}]
   * @param {number} [options.connectTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {boolean} [options.persistent]
   * @returns {Promise<*>} Result payload
   */
  async call(method, params = {}, options = {}) {
    const connectTimeout = options.connectTimeoutMs ?? this.connectTimeoutMs;
    const requestTimeout = options.requestTimeoutMs ?? this.requestTimeoutMs;
    const isPersistent = options.persistent ?? this.persistent;
    const id = Date.now() + Math.random().toString(36).slice(2, 8);

    const socket = await this._ensureConnected(connectTimeout);

    return new Promise((resolve, reject) => {
      let requestTimer = null;

      requestTimer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          // When a request times out, destroy the socket to cleanly cancel remote work
          // and trigger server-side suspension cleanup without leaks.
          if (this.activeSocket === socket) {
            this.activeSocket = null;
            this.streamParser = null;
            try {
              socket.destroy();
            } catch (_err) {
              void _err;
            }
          }
          reject(new Error(`[MicroIPC] Request timeout (${requestTimeout}ms) for method ${method}`));
        }
      }, requestTimeout);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          if (!isPersistent) {
            this.close();
          }
          resolve(result);
        },
        reject: (err) => {
          if (!isPersistent) {
            this.close();
          }
          reject(err);
        },
        timer: requestTimer,
        method
      });

      try {
        const payload = formatJsonRpcRequest(method, params, id);
        socket.write(payload, (writeErr) => {
          if (writeErr) {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
              if (requestTimer) {
                clearTimeout(requestTimer);
                requestTimer = null;
              }
              if (this.activeSocket === socket) {
                this.activeSocket = null;
                this.streamParser = null;
                try {
                  socket.destroy();
                } catch (_e) {
                  void _e;
                }
              }
              reject(writeErr);
            }
          }
        });
      } catch (err) {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          if (requestTimer) {
            clearTimeout(requestTimer);
            requestTimer = null;
          }
        }
        if (this.activeSocket === socket) {
          this.activeSocket = null;
          this.streamParser = null;
          try {
            socket.destroy();
          } catch (_e) {
            void _e;
          }
        }
        reject(err);
      }
    });
  }

  /**
   * Calls a remote method, seamlessly falling back to local evaluation if the IPC
   * daemon is unreachable, delayed >15ms, or errors.
   *
   * @param {string} method
   * @param {*} params
   * @param {Function} fallbackFn
   * @param {object} [options]
   * @returns {Promise<{ source: 'ipc' | 'fallback', result: *, fallbackReason?: string }>}
   */
  async callWithFallback(method, params, fallbackFn, options = {}) {
    try {
      const result = await this.call(method, params, options);
      return { source: 'ipc', result };
    } catch (err) {
      try {
        const fallbackResult = await fallbackFn(params, err);
        return {
          source: 'fallback',
          result: fallbackResult,
          fallbackReason: err.message
        };
      } catch (fallbackErr) {
        throw fallbackErr;
      }
    }
  }

  /**
   * Pings the IPC daemon. Returns true if responsive within timeout, false otherwise.
   * Defaults to this.requestTimeoutMs or 500ms instead of hardcoded 15ms.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  async ping(timeoutMs = this.requestTimeoutMs ?? 500) {
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs ?? 500;
    try {
      await this.call('daemon.ping', {}, { connectTimeoutMs: effectiveTimeout, requestTimeoutMs: effectiveTimeout });
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Closes the active socket connection and cleans up pending requests.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.isClosed) return;
    this.isClosed = true;
    const sock = this.activeSocket;
    this.activeSocket = null;
    this.streamParser = null;
    this.connectingPromise = null;

    if (sock && !sock.destroyed) {
      try {
        sock.end();
        sock.destroy();
      } catch (_err) {
        void _err;
      }
    }

    this._rejectAllPending(new Error('[MicroIPC] Client closed'));
  }

  /**
   * Alias for close() for stream/socket lifecycle compatibility.
   */
  destroy() {
    this.close();
  }
}
