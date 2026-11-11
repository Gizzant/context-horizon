import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from '../paths.mjs';
import { openLocalHorizonDb } from '../sqlite_client.mjs';

/**
 * Phase 4.3: Deterministic "Saved-Quota Receipt" Ledger (`src/core/coach/saved_quota_ledger.mjs`)
 *
 * - Initializes strictly at `$0.00` and `0` tokens (zero mock constants).
 * - Stores byte-verified deterministic savings events in SQLite:
 *   `EFFORT_DOWNSHIFT`, `COLD_PREFILL_AVOIDED`, `CLI_DUMP_COMPRESSED`, `LOOP_TURN_PREVENTED`
 * - Updates the VS Code Status Bar item and Horizon Footer from live SQLite rows only.
 * - Implements `[Copy Savings Receipt]` to export a clean Markdown telemetry table to the clipboard.
 */

export const INITIAL_LEDGER_STATE = Object.freeze({
  totalTokensSaved: 0,
  totalArgonEquivTokensSaved: 0,
  totalDollarsSaved: 0,
  formattedDollarsSaved: '$0.00',
  formattedSavedK: '0.0k'
});

export const SAVINGS_EVENT_TYPES = Object.freeze({
  EFFORT_DOWNSHIFT: 'EFFORT_DOWNSHIFT',
  COLD_PREFILL_AVOIDED: 'COLD_PREFILL_AVOIDED',
  CLI_DUMP_COMPRESSED: 'CLI_DUMP_COMPRESSED',
  LOOP_TURN_PREVENTED: 'LOOP_TURN_PREVENTED'
});

export function getDefaultSavingsLedgerDbPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'saved_quota_ledger.sqlite');
}

export function formatTokensCompactK(tokens = 0) {
  const n = Math.max(0, Number(tokens) || 0);
  return `${(n / 1000).toFixed(1)}k`;
}

export class SavedQuotaReceiptLedger {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.dbPath = options.dbPath || getDefaultSavingsLedgerDbPath(this.homeDir);
    this.clipboardWriter = typeof options.clipboardWriter === 'function'
      ? options.clipboardWriter
      : (text) => { this.lastClipboardMarkdown = String(text || ''); return true; };
    this.lastClipboardMarkdown = '';
    this._initDb();
  }

  _initDb() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = openLocalHorizonDb(this.dbPath, { readOnly: false });
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS savings_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          argon_equiv_tokens_saved INTEGER NOT NULL DEFAULT 0,
          raw_bytes_saved INTEGER NOT NULL DEFAULT 0,
          dollars_saved REAL NOT NULL DEFAULT 0,
          detail TEXT,
          created_at TEXT NOT NULL
        );
      `);
      try { db.exec('ALTER TABLE savings_events ADD COLUMN raw_bytes_saved INTEGER NOT NULL DEFAULT 0;'); } catch {}
      try { db.exec('ALTER TABLE savings_events ADD COLUMN dollars_saved REAL NOT NULL DEFAULT 0;'); } catch {}
    } finally {
      db.close();
    }
  }

  /**
   * Records a verified deterministic savings event into SQLite.
   */
  recordSaving({
    sessionId = 'default-session',
    eventType = SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT,
    argonEquivTokensSaved = 0,
    tokensSaved = undefined,
    rawBytesSaved = 0,
    dollarsSaved = undefined,
    inputPricePer1M = 2.0,
    detail = '',
    createdAt = new Date().toISOString()
  } = {}) {
    const type = String(eventType || SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT).toUpperCase();
    const bytes = Math.max(0, Math.round(Number(rawBytesSaved) || 0));
    const derivedTokens = bytes > 0 ? Math.floor(bytes / 4) : 0;
    const saved = Math.max(0, Math.round(Number(argonEquivTokensSaved ?? tokensSaved ?? derivedTokens) || 0));
    const usd = dollarsSaved !== undefined
      ? Math.max(0, Number(dollarsSaved) || 0)
      : Number(((saved / 1_000_000) * Math.max(0, Number(inputPricePer1M) || 0)).toFixed(6));

    const db = openLocalHorizonDb(this.dbPath, { readOnly: false });
    try {
      db.prepare(`
        INSERT INTO savings_events (session_id, event_type, argon_equiv_tokens_saved, raw_bytes_saved, dollars_saved, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(String(sessionId), type, saved, bytes, usd, String(detail || ''), String(createdAt));
    } finally {
      db.close();
    }

    return this.getSummary(sessionId);
  }

  /**
   * Computes aggregated savings and formats the VS Code Status Bar and Horizon Footer string.
   */
  getSummary(sessionId = null) {
    let rows = [];
    if (this.dbPath && fs.existsSync(this.dbPath)) {
      const db = openLocalHorizonDb(this.dbPath, { readOnly: true });
      try {
        if (sessionId) {
          rows = db.prepare(`
            SELECT id, session_id AS sessionId, event_type AS eventType, argon_equiv_tokens_saved AS argonEquivTokensSaved, raw_bytes_saved AS rawBytesSaved, dollars_saved AS dollarsSaved, detail, created_at AS createdAt
            FROM savings_events
            WHERE session_id = ?
            ORDER BY id ASC
          `).all(String(sessionId));
        } else {
          rows = db.prepare(`
            SELECT id, session_id AS sessionId, event_type AS eventType, argon_equiv_tokens_saved AS argonEquivTokensSaved, raw_bytes_saved AS rawBytesSaved, dollars_saved AS dollarsSaved, detail, created_at AS createdAt
            FROM savings_events
            ORDER BY id ASC
          `).all();
        }
      } finally {
        db.close();
      }
    }

    const counts = {
      [SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED]: 0,
      [SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT]: 0,
      [SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED]: 0,
      [SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED]: 0
    };

    const totalsByType = {
      [SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED]: 0,
      [SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT]: 0,
      [SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED]: 0,
      [SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED]: 0
    };

    let totalArgonEquivTokensSaved = 0;
    let totalRawBytesSaved = 0;
    let totalDollarsSaved = 0;

    for (const row of rows) {
      const t = String(row.eventType || '');
      const tok = Math.max(0, Number(row.argonEquivTokensSaved || 0));
      const b = Math.max(0, Number(row.rawBytesSaved || 0));
      const usd = Math.max(0, Number(row.dollarsSaved || 0));
      totalArgonEquivTokensSaved += tok;
      totalRawBytesSaved += b;
      totalDollarsSaved += usd;
      if (counts[t] !== undefined) {
        counts[t]++;
        totalsByType[t] += tok;
      }
    }

    const coldCount = counts[SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED];
    const downshiftCount = counts[SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT];
    const cliCount = counts[SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED];
    const loopCount = counts[SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED];

    const parts = [
      `${coldCount} Cold Prefill${coldCount === 1 ? '' : 's'}`,
      `${downshiftCount} Downshift${downshiftCount === 1 ? '' : 's'}`,
      `${cliCount} CLI Compress`
    ];
    if (loopCount > 0) {
      parts.push(`${loopCount} Loop${loopCount === 1 ? '' : 's'} Prevented`);
    }

    const formattedSavedK = formatTokensCompactK(totalArgonEquivTokensSaved);
    const formattedDollarsSaved = totalDollarsSaved === 0 ? '$0.00' : `$${totalDollarsSaved.toFixed(2)}`;
    const statusBarText = `$(shield) Horizon: +${formattedSavedK} Argon-equiv tokens saved (${parts.join(' • ')})`;
    const footerText = `🛡️ Horizon: +${formattedSavedK} Argon-equiv tokens saved (${parts.join(' • ')})`;

    return {
      totalTokensSaved: totalArgonEquivTokensSaved,
      totalArgonEquivTokensSaved,
      totalRawBytesSaved,
      totalDollarsSaved: Number(totalDollarsSaved.toFixed(6)),
      formattedDollarsSaved,
      formattedSavedK,
      counts,
      totalsByType,
      events: rows,
      statusBarText,
      footerText
    };
  }

  /**
   * Exports a clean Markdown telemetry table receipt and copies it to the clipboard.
   */
  copySavingsReceipt(sessionId = null) {
    const summary = this.getSummary(sessionId);
    const lines = [
      `### 🛡️ Attention Horizon — Saved-Quota Receipt`,
      ``,
      `**Total Saved:** \`+${summary.formattedSavedK}\` Argon-equiv tokens`,
      ``,
      `| Category | Event Count | Argon-Equiv Tokens Saved |`,
      `| :--- | :---: | :---: |`,
      `| Cold Prefills Avoided (\`COLD_PREFILL_AVOIDED\`) | ${summary.counts.COLD_PREFILL_AVOIDED} | +${formatTokensCompactK(summary.totalsByType.COLD_PREFILL_AVOIDED)} |`,
      `| Effort Downshifts (\`EFFORT_DOWNSHIFT\`) | ${summary.counts.EFFORT_DOWNSHIFT} | +${formatTokensCompactK(summary.totalsByType.EFFORT_DOWNSHIFT)} |`,
      `| CLI Dumps Compressed (\`CLI_DUMP_COMPRESSED\`) | ${summary.counts.CLI_DUMP_COMPRESSED} | +${formatTokensCompactK(summary.totalsByType.CLI_DUMP_COMPRESSED)} |`,
      `| Loop Turns Prevented (\`LOOP_TURN_PREVENTED\`) | ${summary.counts.LOOP_TURN_PREVENTED} | +${formatTokensCompactK(summary.totalsByType.LOOP_TURN_PREVENTED)} |`
    ];

    const markdown = lines.join('\n');
    this.clipboardWriter(markdown);
    return {
      ok: true,
      markdown,
      summary
    };
  }
}

export default SavedQuotaReceiptLedger;
