/**
 * @file src/utils/nodeIo.mjs
 * Tier-2 Spawned Node.js CLI I/O Adapter (`ISS-032`).
 *
 * Architectural Boundary:
 * - Imported ONLY by Tier-2 Node CLI entrypoints (`bin/*`, `hooks/handlers/*`,
 *   `src/guards/losslessPostSanitizer.mjs`, `src/diagnostics/bugReportGenerator.mjs`, `scripts/*`).
 * - NEVER imported by `hooks/register.js` or any module in `register.js`'s transitive Mod graph!
 * - Uses standard ESM `node:*` imports supported across all Node.js >= 20.0.0 (`20.0.0`..`24.x`),
 *   completely eliminating `process.getBuiltinModule` smuggling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as url from 'node:url';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  registerNodeIo,
  writeTextAtomic,
  writeJsonAtomic,
  readJsonSafe,
  readTextSafe,
  appendJsonlSafe,
  getDiagnosticsFilePath,
  recordRuntimeDiagnostic,
  readRuntimeDiagnostics
} from '../core-isomorphic/utils/runtime.mjs';

export const NODE_IO_PROVIDER = Object.freeze({
  fs,
  path,
  os,
  crypto,
  url: Object.freeze({ fileURLToPath, pathToFileURL }),
  cwd: () => globalThis.process?.cwd?.() || '.'
});

// Automatically activate disk I/O for Tier-2 Node CLI processes on import
registerNodeIo(NODE_IO_PROVIDER);

export {
  fs,
  path,
  os,
  crypto,
  url,
  fileURLToPath,
  pathToFileURL,
  writeTextAtomic,
  writeJsonAtomic,
  readJsonSafe,
  readTextSafe,
  appendJsonlSafe,
  getDiagnosticsFilePath,
  recordRuntimeDiagnostic,
  readRuntimeDiagnostics
};
