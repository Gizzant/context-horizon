/**
 * @file test/helpers/sqlite_available.mjs
 * `node:sqlite` exists only on Node >= 22.5. On Node 20 Highbeam uses its JSONL fallback, which
 * does not cover SQLite-only features (FTS5 search, the SQLite savings ledger, reading host
 * SQLite stores). Tests of those features are skipped there with this reason.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let available = false;
try {
  available = Boolean(require('node:sqlite')?.DatabaseSync);
} catch (err) {
  void err;
}

export const HAS_NODE_SQLITE = available;
export const SKIP_WITHOUT_SQLITE = available
  ? false
  : 'needs node:sqlite (Node >= 22.5); Node 20 uses the JSONL fallback';
