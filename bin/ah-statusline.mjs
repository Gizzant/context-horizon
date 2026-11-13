#!/usr/bin/env node
/**
 * @file bin/ah-statusline.mjs
 * Standalone `statusLine` JSON bridge for Claude Code Highbeam.
 *
 * Reads Claude Code's `statusLine` JSON payload from `stdin`, updates the atomic
 * bridge snapshot at `.claude/cache/ah_live_state_<sessionId>.json`, and prints
 * a responsive single-line ANSI status bar adapting to terminal column width
 * (80 / 110 / 144 columns).
 */

import { fs, path, url } from '../src/utils/nodeIo.mjs';
import { readStdinJsonAsync } from '../hooks/handlers/hookIo.mjs';
import {
  createInitialTelemetryState,
  readLiveStateSnapshot,
  ingestStatusLinePayload,
  writeLiveStateSnapshot
} from '../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { renderStatusLine } from '../src/core-isomorphic/ui/modViews.mjs';

/**
 * Programmatic entrypoint for the `statusLine` bridge.
 *
 * @param {object} [payload={}] - Parsed `statusLine` stdin JSON payload
 * @param {object} [options={}]
 * @param {number} [options.columns]
 * @param {boolean} [options.ansi=true]
 * @param {string} [options.cwd]
 * @param {number} [options.nowMs]
 * @returns {{
 *   line: string,
 *   plainLine: string,
 *   visibleLength: number,
 *   columns: number,
 *   layoutTier: string,
 *   state: object,
 *   sessionPath: string
 * }}
 */
export function executeStatusLineBridge(payload = {}, options = {}) {
  const sessionId = payload.session_id || payload.sessionId || 'default';
  const currentState = readLiveStateSnapshot(sessionId, options);
  const nextState = ingestStatusLinePayload(currentState, payload, options);
  const persisted = writeLiveStateSnapshot(nextState.sessionId, nextState, options);

  const envCols = Number(globalThis.process?.env?.AH_COLUMNS || 0);
  const stdoutCols = Number(globalThis.process?.stdout?.columns || 0);
  const payloadCols = Number(payload.terminal?.columns || payload.columns || 0);

  const columns =
    options.columns ||
    (payloadCols > 0 ? payloadCols : envCols > 0 ? envCols : stdoutCols > 0 ? stdoutCols : 110);

  const rendered = renderStatusLine(nextState, {
    ...options,
    columns,
    ansi: options.ansi !== false
  });

  return {
    ...rendered,
    state: nextState,
    sessionPath: persisted.sessionPath
  };
}

/**
 * Symlink-safe CLI main guard (`ISS-014`).
 * Resolves `node_modules/.bin/ah-statusline` symlinks via `realpathSync`
 * with a `path.resolve` fallback when `realpathSync` is unavailable.
 *
 * @param {string} [argv1=globalThis.process?.argv?.[1]]
 * @param {string} [metaUrl=import.meta.url]
 * @param {{ realpathSync?: Function }} [fsImpl=fs]
 * @returns {boolean}
 */
export function isCliMain(
  argv1 = globalThis.process?.argv?.[1],
  metaUrl = import.meta.url,
  fsImpl = fs
) {
  if (!argv1 || !metaUrl) return false;
  try {
    return fsImpl.realpathSync(argv1) === fsImpl.realpathSync(url.fileURLToPath(metaUrl));
  } catch {
    try {
      return path.resolve(String(argv1)) === path.resolve(url.fileURLToPath(metaUrl));
    } catch {
      return false;
    }
  }
}

/**
 * CLI runner when invoked directly as `node bin/ah-statusline.mjs` or symlinked `ah-statusline`.
 */
export async function runStatusLineCli(args = globalThis.process?.argv?.slice(2) || []) {
  try {
    const colIdx = Array.isArray(args)
      ? (args.indexOf('--columns') !== -1 ? args.indexOf('--columns') : args.indexOf('--cols'))
      : -1;
    const cliCols = colIdx !== -1 && args[colIdx + 1] ? Number(args[colIdx + 1]) : null;
    const columns = (cliCols && Number.isFinite(cliCols) && cliCols > 0)
      ? cliCols
      : Number(globalThis.process?.env?.AH_COLUMNS || globalThis.process?.stdout?.columns || 80);

    if (Array.isArray(args) && args.includes('--demo')) {
      const demoState = createInitialTelemetryState('demo', 'claude-sonnet-5-5');
      demoState.contextWindow.totalInputTokens = 64000;
      demoState.contextWindow.cachedTokens = 56000;
      demoState.contextWindow.cacheReadTokens = 56000;
      demoState.contextWindow.systemAndMcpTokens = 8000;
      demoState.promptCache.warm = true;
      demoState.promptCache.ttlSeconds = 252;
      const demoRendered = renderStatusLine(demoState, {
        columns,
        includeDiskLedger: false,
        savedUSD: 1.84
      });
      globalThis.process?.stdout?.write?.(`${demoRendered.line}\n`);
      return demoRendered;
    }
    const payload = await readStdinJsonAsync(1500);
    const result = executeStatusLineBridge(payload, cliCols ? { columns: cliCols } : {});
    globalThis.process?.stdout?.write?.(`${result.line}\n`);
    return result;
  } catch (_err) {
    // Graceful statusLine fallback
    return null;
  }
}

export const main = runStatusLineCli;

if (isCliMain()) {
  runStatusLineCli();
}

export default {
  executeStatusLineBridge,
  runStatusLineCli,
  isCliMain,
  main
};
