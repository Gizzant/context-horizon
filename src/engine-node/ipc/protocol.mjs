/**
 * @file src/engine-node/ipc/protocol.mjs
 * Highbeam Micro-IPC Wire Protocol & Stream Parser.
 *
 * Implements Win32 Named-Pipe / POSIX Unix Domain Socket address resolution,
 * JSON-RPC 2.0 framing over newline-delimited streams (\n), and buffer overrun protection.
 * Strictly 0 npm dependencies (uses only standard node:* built-ins).
 */

import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const JSON_RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
});

export const IPC_LIMITS = Object.freeze({
  MAX_BUFFER_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  DEFAULT_CONNECT_TIMEOUT_MS: 15,
  DEFAULT_REQUEST_TIMEOUT_MS: 500
});

/**
 * Resolves the OS-specific local IPC transport address.
 * Win32: Named Pipe `\\.\pipe\ctxtop-<cleanUsername>`
 * POSIX: Unix Domain Socket `~/.ctxtop/daemon.sock`
 *
 * @param {object} [options]
 * @returns {string} Pipe path or socket filesystem path
 */
export function resolveIpcPath(options = {}) {
  if (options.ipcPath || process.env.CTXTOP_IPC_PATH) {
    return options.ipcPath || process.env.CTXTOP_IPC_PATH;
  }

  if (process.platform === 'win32') {
    let rawUser = process.env.USERNAME || process.env.USER;
    if (!rawUser) {
      try {
        rawUser = typeof os.userInfo === 'function' ? os.userInfo()?.username : null;
      } catch (_err) {
        void _err;
      }
    }
    const cleanUser = String(rawUser || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `\\\\.\\pipe\\ctxtop-${cleanUser}`;
  }

  const homeDir = options.homeDir || process.env.HOME || os.homedir() || '/tmp';
  return path.join(homeDir, '.ctxtop', 'daemon.sock');
}

/**
 * Creates a standard JSON-RPC 2.0 request payload string.
 *
 * @param {string} method
 * @param {*} [params]
 * @param {string|number} [id]
 * @returns {string} Formatted JSON-RPC request with trailing newline
 */
export function formatJsonRpcRequest(method, params = {}, id = null) {
  const reqId = id !== null && id !== undefined ? id : Date.now() + Math.random().toString(36).slice(2, 8);
  const msg = {
    jsonrpc: '2.0',
    id: reqId,
    method: String(method),
    params
  };
  return JSON.stringify(msg) + '\n';
}

/**
 * Creates a standard JSON-RPC 2.0 success response string.
 *
 * @param {string|number} id
 * @param {*} result
 * @returns {string} Formatted JSON-RPC response with trailing newline
 */
export function formatJsonRpcResponse(id, result) {
  const msg = {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    result: result !== undefined ? result : null
  };
  return JSON.stringify(msg) + '\n';
}

/**
 * Creates a standard JSON-RPC 2.0 error response string.
 *
 * @param {string|number} id
 * @param {number} code
 * @param {string} message
 * @param {*} [data]
 * @returns {string} Formatted JSON-RPC error response with trailing newline
 */
export function formatJsonRpcError(id, code, message, data = undefined) {
  const errObj = {
    code: typeof code === 'number' ? code : JSON_RPC_ERRORS.INTERNAL_ERROR,
    message: String(message || 'Internal error')
  };
  if (data !== undefined) {
    errObj.data = data;
  }
  const msg = {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    error: errObj
  };
  return JSON.stringify(msg) + '\n';
}

/**
 * Streaming parser for newline-delimited JSON-RPC 2.0 messages.
 * Reassembles chunked data, parses individual lines, and guards against buffer overruns.
 */
export class JsonRpcStreamParser {
  /**
   * @param {Function} onMessage - Invoked with valid parsed JSON-RPC message object
   * @param {Function} [onError] - Invoked with error when line fails to parse
   * @param {object} [options]
   */
  constructor(onMessage, onError = null, options = {}) {
    this.onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.maxBufferSize = options.maxBufferSize || IPC_LIMITS.MAX_BUFFER_SIZE_BYTES;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  /**
   * Feeds a stream chunk into the parser.
   *
   * @param {Buffer|string} chunk
   */
  feed(chunk) {
    if (!chunk) return;
    const str = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += str;

    // Buffer overrun protection
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = '';
      this.decoder = new StringDecoder('utf8');
      this.onError(new Error(`Buffer overrun: payload exceeded ${this.maxBufferSize} bytes`), null);
      return;
    }

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        this.onMessage(parsed);
      } catch (err) {
        this.onError(err, line);
      }
    }
  }

  /**
   * Resets the accumulator buffer.
   */
  reset() {
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }
}
