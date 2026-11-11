import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic_io.mjs';

export const MAX_HOOK_DIAGNOSTIC_ENTRIES = 50;
export const HOOK_DIAGNOSTICS_FILENAME = 'ga_hook_diagnostics.jsonl';

const inMemoryDiagnostics = [];
let ignoredDiagnosticCount = 0;

/**
 * Resolves the diagnostics directory outside the workspace root so hook/shim telemetry
 * never pollutes `.agents/cache/` or `stdout`.
 */
export function getHookDiagnosticsDir(options = {}) {
  if (options.diagnosticsDir && typeof options.diagnosticsDir === 'string') {
    return path.resolve(options.diagnosticsDir);
  }
  const envDir = process.env.HORIZON_DIAGNOSTICS_DIR;
  if (envDir && typeof envDir === 'string' && envDir.trim().length > 0) {
    return path.resolve(envDir.trim());
  }
  const home = options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.attention-horizon', 'diagnostics');
}

export function getHookDiagnosticsFilePath(options = {}) {
  return path.join(getHookDiagnosticsDir(options), HOOK_DIAGNOSTICS_FILENAME);
}

function sanitizeDiagnosticMessage(rawMessage = '') {
  return String(rawMessage || 'Unknown error')
    .replace(/\r?\n/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>')
    .replace(/\/(?:Users|home)\/[^\s"']+/g, '<path>')
    .slice(0, 240);
}

/**
 * Records a structured diagnostic event into the bounded in-memory ring buffer (<= 50)
 * and persists bounded JSONL (`<= 50` entries) to `~/.attention-horizon/diagnostics/ga_hook_diagnostics.jsonl`.
 * Never writes to `stdout` and never throws.
 */
export function recordHookDiagnostic(source, operation, err, options = {}) {
  const code = err && typeof err === 'object' && err.code ? String(err.code) : null;
  const ignoreCodes = Array.isArray(options.ignoreCodes) ? options.ignoreCodes : [];
  if (code && ignoreCodes.includes(code)) {
    ignoredDiagnosticCount += 1;
    return { recorded: false, ignored: true, code };
  }

  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    source: String(source || 'unknown').slice(0, 64),
    operation: String(operation || 'unknown').slice(0, 80),
    name: err && typeof err === 'object' && err.name ? String(err.name).slice(0, 48) : 'Error',
    code,
    message: sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err ?? 'Unknown error'))
  };

  inMemoryDiagnostics.push(entry);
  while (inMemoryDiagnostics.length > MAX_HOOK_DIAGNOSTIC_ENTRIES) {
    inMemoryDiagnostics.shift();
  }

  if (options.persist !== false) {
    try {
      const filePath = getHookDiagnosticsFilePath(options);
      let existingLines = [];
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        existingLines = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
      }
      existingLines.push(JSON.stringify(entry));
      const bounded = existingLines.slice(-MAX_HOOK_DIAGNOSTIC_ENTRIES);
      atomicWriteFileSync(filePath, `${bounded.join('\n')}\n`, { encoding: 'utf8' });
    } catch (persistErr) {
      // Never throw or write to stdout from diagnostic recorder
      entry.persistFailedCode = persistErr?.code || 'PERSIST_ERR';
    }
  }

  return { recorded: true, ignored: false, entry };
}

export function getHookDiagnostics() {
  return [...inMemoryDiagnostics];
}

export function getIgnoredHookDiagnosticCount() {
  return ignoredDiagnosticCount;
}

export function clearHookDiagnostics() {
  inMemoryDiagnostics.length = 0;
  ignoredDiagnosticCount = 0;
}

export function readPersistedHookDiagnostics(options = {}) {
  const filePath = getHookDiagnosticsFilePath(options);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
      } catch (parseErr) {
        if (parseErr) {
          // Skip malformed line while preserving valid entries
        }
      }
    }
    return entries.slice(-MAX_HOOK_DIAGNOSTIC_ENTRIES);
  } catch (err) {
    return err ? [] : [];
  }
}

export function getHookDiagnosticSummary(options = {}) {
  const persisted = readPersistedHookDiagnostics(options);
  const bySource = {};
  for (const item of persisted) {
    const key = String(item.source || 'unknown');
    bySource[key] = (bySource[key] || 0) + 1;
  }
  const latest = persisted.length > 0 ? persisted[persisted.length - 1] : null;
  return {
    totalCount: persisted.length,
    inMemoryCount: inMemoryDiagnostics.length,
    bySource,
    latestSource: latest?.source || null,
    latestOperation: latest?.operation || null,
    latestCode: latest?.code || null,
    latestTimestamp: latest?.timestamp || null
  };
}

export default {
  MAX_HOOK_DIAGNOSTIC_ENTRIES,
  HOOK_DIAGNOSTICS_FILENAME,
  getHookDiagnosticsDir,
  getHookDiagnosticsFilePath,
  recordHookDiagnostic,
  getHookDiagnostics,
  getIgnoredHookDiagnosticCount,
  clearHookDiagnostics,
  readPersistedHookDiagnostics,
  getHookDiagnosticSummary
};
