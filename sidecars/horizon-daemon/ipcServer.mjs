/**
 * @file sidecars/horizon-daemon/ipcServer.mjs
 * Horizon Daemon Micro-IPC Socket Mount.
 *
 * Mounts warm MicroIpcServer on Win32 Named Pipes (\\.\pipe\ctxtop-<username>)
 * and POSIX Unix Domain Sockets (~/.ctxtop/daemon.sock).
 */

import { MicroIpcServer } from '../../src/engine-node/ipc/server.mjs';
import { resolveIpcPath } from '../../src/engine-node/ipc/protocol.mjs';

export { MicroIpcServer, resolveIpcPath };

/**
 * Creates and starts a MicroIpcServer instance.
 *
 * @param {object} [options]
 * @returns {Promise<MicroIpcServer>}
 */
export async function createAndStartIpcServer(options = {}) {
  const server = new MicroIpcServer(options);
  await server.listen();
  return server;
}
