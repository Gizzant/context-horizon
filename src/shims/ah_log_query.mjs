#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryAhCliArchiveBm25 } from './agy_cli_compressor.mjs';

export function runAhLogQueryCli(argv = process.argv.slice(2), options = {}) {
  const term = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!term) {
    return { exitCode: 1, output: 'Usage: node .agents/shims/ah_log_query.mjs "<search_term>"' };
  }
  const hits = queryAhCliArchiveBm25(term, {
    workspaceDir: options.workspaceDir || process.cwd(),
    archiveDbPath: options.archiveDbPath || null,
    limit: options.limit || 8
  });
  if (hits.length === 0) {
    return { exitCode: 0, hits: [], output: `[DET-07 BM25] No matches found for "${term}".` };
  }
  const lines = hits.map(
    (h, idx) => `#${idx + 1} [id=${h.id} exit=${h.exitCode} cmd="${h.command}"] ${h.snippet}`
  );
  return { exitCode: 0, hits, output: lines.join('\n') };
}

function isQueryMain(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isQueryMain()) {
  const res = runAhLogQueryCli(process.argv.slice(2));
  process.stdout.write(res.output + '\n');
  process.exit(res.exitCode);
}
