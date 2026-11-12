/**
 * @file src/engine-node/ipc/server.mjs
 * Attention Horizon Micro-IPC Server.
 *
 * Implements high-throughput, low-latency (<0.8ms SLA) local JSON-RPC 2.0 server
 * over Win32 Named Pipes and POSIX Unix Domain Sockets with non-spinning tool-boundary suspension.
 * Strictly 0 npm dependencies (uses only standard node:* built-ins).
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveIpcPath,
  formatJsonRpcResponse,
  formatJsonRpcError,
  JsonRpcStreamParser,
  JSON_RPC_ERRORS,
  IPC_LIMITS
} from './protocol.mjs';

import {
  CONTROL_STATES,
  createInitialControlState,
  transitionControlState,
  evaluateToolBoundaryLatch
} from '../../core-isomorphic/control/controlStateMachine.mjs';

import { evaluateCoachLatch } from '../../core-isomorphic/control/coachLatches.mjs';

export class MicroIpcServer {
  /**
   * @param {object} [options]
   * @param {string} [options.ipcPath]
   * @param {Function} [options.logger]
   */
  constructor(options = {}) {
    this.ipcPath = resolveIpcPath(options);
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.server = null;
    this.methods = new Map();
    this.activeSockets = new Set();

    // In-memory control state cache per session: Map<sessionId, ControlState>
    this.controlStates = new Map();

    // Non-spinning suspension map per session: Map<sessionId, Array<{ id, resolve, socket, timer }>>
    this.suspensions = new Map();

    this._registerDefaultMethods();
  }

  /**
   * Registers default JSON-RPC 2.0 methods.
   * @private
   */
  _registerDefaultMethods() {
    // Ping
    this.registerMethod('daemon.ping', async () => ({
      pong: true,
      timestamp: Date.now(),
      platform: process.platform,
      pid: process.pid
    }));

    // Control: get state
    this.registerMethod('control.getState', async (params) => {
      const sessionId = params?.sessionId || 'default';
      const state = this.controlStates.get(sessionId) || createInitialControlState(sessionId);
      return state;
    });

    // Control: transition state
    this.registerMethod('control.transition', async (params) => {
      const sessionId = params?.sessionId || 'default';
      const action = params?.action || 'run';
      const reason = params?.reason || '';
      const current = this.controlStates.get(sessionId) || createInitialControlState(sessionId);
      const next = transitionControlState(current, action, reason, params?.options || {});
      this.controlStates.set(sessionId, next);

      // Handle unpausing or stepping of suspended requests
      if (action === 'resume' || action === 'run') {
        this.resumeSuspended(sessionId, 'all', 'allow', reason || 'Execution resumed');
      } else if (action === 'step') {
        this.resumeSuspended(sessionId, 'one', 'allow', reason || 'Step executed');
      } else if (action === 'abort') {
        this.resumeSuspended(sessionId, 'all', 'deny', reason || 'Session aborted by user');
      }

      return next;
    });

    // Control: check latch
    this.registerMethod('control.checkLatch', async (params) => {
      const sessionId = params?.sessionId || 'default';
      const state = this.controlStates.get(sessionId) || createInitialControlState(sessionId);
      const flightMode = params?.flightMode || 'COACH';
      const detectorVerdict = params?.detectorVerdict || null;
      return evaluateCoachLatch({
        controlState: state,
        flightMode,
        detectorVerdict
      });
    });

    // Hook: PreToolUse with atomic non-spinning suspension
    this.registerMethod('hook.preToolUse', async (params, socket, id) => {
      const sessionId = params?.sessionId || params?.session_id || 'default';
      const controlState = this.controlStates.get(sessionId) || createInitialControlState(sessionId);
      const flightMode = params?.flightMode || 'COACH';

      // 1. Evaluate user control state
      const latch = evaluateToolBoundaryLatch(controlState);

      if (latch.decision === 'deny') {
        return {
          decision: 'deny',
          reason: latch.reason || 'Session aborted by user',
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: latch.reason || 'Session aborted by user'
          }
        };
      }

      if (latch.decision === 'suspend') {
        // Suspend non-spinning: hold request in suspension map
        return new Promise((resolve) => {
          const timeoutTimer = setTimeout(() => {
            this._removeSuspension(sessionId, id);
            resolve({
              decision: 'deny',
              reason: 'timeout: suspended execution exceeded safety ceiling',
              hookSpecificOutput: {
                permissionDecision: 'deny',
                permissionDecisionReason: 'timeout: suspended execution exceeded safety ceiling'
              }
            });
          }, 600000); // 10 minutes safety timeout

          if (!this.suspensions.has(sessionId)) {
            this.suspensions.set(sessionId, []);
          }
          this.suspensions.get(sessionId).push({
            id,
            resolve,
            socket,
            timer: timeoutTimer
          });
        });
      }

      if (latch.decision === 'allow' && latch.consumeStep) {
        // Auto-consume step: transition back to PAUSED
        const next = transitionControlState(controlState, 'consume_step');
        this.controlStates.set(sessionId, next);
      }

      // 2. Evaluate COACH mode composite latch
      const coachVerdict = evaluateCoachLatch({
        controlState,
        flightMode,
        detectorVerdict: params?.detectorVerdict || null
      });

      return {
        decision: coachVerdict.decision || 'allow',
        flightMode: coachVerdict.flightMode || flightMode,
        advisory: coachVerdict.advisory || false,
        systemMessage: coachVerdict.systemMessage || null,
        hookSpecificOutput: {
          permissionDecision: coachVerdict.decision === 'block' || coachVerdict.decision === 'deny' ? 'deny' : 'allow',
          permissionDecisionReason: coachVerdict.reason || coachVerdict.systemMessage || null
        }
      };
    });

    // Hook: PostToolUse
    this.registerMethod('hook.postToolUse', async (params) => {
      return {
        success: true,
        sanitized: false,
        timestamp: Date.now()
      };
    });
  }

  /**
   * Registers a custom JSON-RPC method handler.
   *
   * @param {string} name
   * @param {Function} handler
   */
  registerMethod(name, handler) {
    if (typeof handler === 'function') {
      this.methods.set(name, handler);
    }
  }

  /**
   * Resumes suspended requests for a session.
   *
   * @param {string} sessionId
   * @param {'all' | 'one'} mode
   * @param {'allow' | 'deny'} decision
   * @param {string} reason
   */
  resumeSuspended(sessionId, mode = 'all', decision = 'allow', reason = '') {
    const list = this.suspensions.get(sessionId);
    if (!list || list.length === 0) return;

    if (mode === 'one') {
      const item = list.shift();
      if (item) {
        clearTimeout(item.timer);
        item.resolve({
          decision,
          consumeStep: true,
          reason,
          hookSpecificOutput: {
            permissionDecision: decision,
            permissionDecisionReason: reason
          }
        });
      }
    } else {
      while (list.length > 0) {
        const item = list.shift();
        clearTimeout(item.timer);
        item.resolve({
          decision,
          reason,
          hookSpecificOutput: {
            permissionDecision: decision,
            permissionDecisionReason: reason
          }
        });
      }
    }
  }

  /**
   * Helper to remove a single suspension entry.
   * @private
   */
  _removeSuspension(sessionId, id) {
    const list = this.suspensions.get(sessionId);
    if (!list) return;
    const idx = list.findIndex((item) => item.id === id);
    if (idx !== -1) {
      clearTimeout(list[idx].timer);
      list.splice(idx, 1);
    }
  }

  /**
   * Cleans up any pending suspensions and cancels 600s safety timers
   * associated with a disconnected or errored socket.
   * @param {import('node:net').Socket} socket
   * @private
   */
  _cleanupSocketSuspensions(socket) {
    for (const [sessionId, list] of this.suspensions.entries()) {
      const remaining = [];
      for (const item of list) {
        if (item.socket === socket) {
          clearTimeout(item.timer);
          try {
            item.resolve({
              decision: 'deny',
              reason: 'Client socket disconnected'
            });
          } catch (_err) {
            void _err;
          }
        } else {
          remaining.push(item);
        }
      }
      if (remaining.length === 0) {
        this.suspensions.delete(sessionId);
      } else {
        this.suspensions.set(sessionId, remaining);
      }
    }
  }

  /**
   * Starts listening on the configured pipe or socket path.
   *
   * @returns {Promise<MicroIpcServer>}
   */
  async listen() {
    return new Promise((resolve, reject) => {
      // POSIX socket preparation
      if (process.platform !== 'win32') {
        try {
          const dir = path.dirname(this.ipcPath);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

          if (fs.existsSync(this.ipcPath)) {
            // Clean stale socket if not active
            try {
              fs.unlinkSync(this.ipcPath);
            } catch (_err) {
              void _err;
            }
          }
        } catch (prepErr) {
          return reject(prepErr);
        }
      }

      this.server = net.createServer((socket) => {
        this.activeSockets.add(socket);

        const parser = new JsonRpcStreamParser(
          async (msg) => {
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
              if (!socket.destroyed) {
                socket.write(formatJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request') + '\n');
              }
              return;
            }

            const id = msg.id !== undefined ? msg.id : null;
            const method = msg.method;

            if (!method || typeof method !== 'string') {
              if (!socket.destroyed) {
                socket.write(formatJsonRpcError(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'Missing or invalid method') + '\n');
              }
              return;
            }

            const handler = this.methods.get(method);
            if (!handler) {
              if (!socket.destroyed) {
                socket.write(formatJsonRpcError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`) + '\n');
              }
              return;
            }

            try {
              const result = await handler(msg.params || {}, socket, id);
              if (!socket.destroyed && id !== null) {
                socket.write(formatJsonRpcResponse(id, result));
              }
            } catch (execErr) {
              if (!socket.destroyed && id !== null) {
                socket.write(formatJsonRpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, execErr.message) + '\n');
              }
            }
          },
          (parseErr) => {
            // Malformed JSON: return -32700 Parse error without crashing (satisfies test 29.B2)
            if (!socket.destroyed) {
              socket.write(formatJsonRpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error: Invalid JSON'));
            }
          }
        );

        socket.on('data', (chunk) => parser.feed(chunk));

        socket.on('error', (err) => {
          this.activeSockets.delete(socket);
          this._cleanupSocketSuspensions(socket);
          // Client socket errors or disconnects mid-transmission handled cleanly without server crash
          try {
            socket.destroy();
          } catch (_err) {
            void _err;
          }
        });

        socket.on('close', () => {
          this.activeSockets.delete(socket);
          this._cleanupSocketSuspensions(socket);
        });
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.ipcPath, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.ipcPath, 0o600);
          } catch (_err) {
            void _err;
          }
        }
        resolve(this);
      });
    });
  }

  /**
   * Closes the server and releases all socket resources.
   *
   * @returns {Promise<void>}
   */
  async close() {
    // Release any pending suspensions with an abort reason
    for (const [sessionId, list] of this.suspensions.entries()) {
      for (const item of list) {
        clearTimeout(item.timer);
        item.resolve({
          decision: 'deny',
          reason: 'IPC server shut down'
        });
      }
    }
    this.suspensions.clear();

    // Close all connected sockets
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch (_err) {
        void _err;
      }
    }
    this.activeSockets.clear();

    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        if (process.platform !== 'win32') {
          try {
            if (fs.existsSync(this.ipcPath)) {
              fs.unlinkSync(this.ipcPath);
            }
          } catch (_err) {
            void _err;
          }
        }
        this.server = null;
        resolve();
      });
    });
  }
}
