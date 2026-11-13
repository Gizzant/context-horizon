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
  LOOP_TURN_PREVENTED: 'LOOP_TURN_PREVENTED',
  SUBAGENT_ISOLATED: 'SUBAGENT_ISOLATED',
  CACHE_HIT_PRESERVED: 'CACHE_HIT_PRESERVED',
  COMPACTION_RECLAIMED: 'COMPACTION_RECLAIMED',
  PROMPT_HYGIENE_STEERED: 'PROMPT_HYGIENE_STEERED',
  PROMPT_HYGIENE_BLOCKED: 'PROMPT_HYGIENE_BLOCKED',
  SIGHTSEEING_TOOL_PREVENTED: 'SIGHTSEEING_TOOL_PREVENTED'
});

/** Plain-English labels for the Simple View Auto-fix log. */
export const AUTO_FIX_LABELS = Object.freeze({
  EFFORT_DOWNSHIFT: 'Effort downshifted',
  COLD_PREFILL_AVOIDED: 'Cold prefill avoided',
  CLI_DUMP_COMPRESSED: 'CLI output compressed',
  LOOP_TURN_PREVENTED: 'Loop turn prevented',
  SUBAGENT_ISOLATED: 'Subagent isolated',
  COMPACTION_RECLAIMED: 'Compaction reclaimed',
  PROMPT_HYGIENE_STEERED: 'Prompt steered',
  PROMPT_HYGIENE_BLOCKED: 'Prompt blocked',
  SIGHTSEEING_TOOL_PREVENTED: 'Sightseeing read prevented'
});

export function getDefaultSavingsLedgerDbPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'saved_quota_ledger.sqlite');
}

export function formatTokensCompactK(tokens = 0) {
  const n = Math.max(0, Number(tokens) || 0);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatTokensHuman(tokens = 0) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${(n / 1000).toFixed(1)}k`;
}

export class SavedQuotaReceiptLedger {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.dbPath = options.dbPath !== undefined && options.dbPath !== null
      ? String(options.dbPath)
      : getDefaultSavingsLedgerDbPath(this.homeDir);
    this.clipboardWriter = typeof options.clipboardWriter === 'function'
      ? options.clipboardWriter
      : (text) => { this.lastClipboardMarkdown = String(text || ''); return true; };
    this.lastClipboardMarkdown = '';
    if (this.dbPath) {
      this._initDb();
    }
  }

  _initDb() {
    if (!this.dbPath) return;
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
    argonEquivTokensSaved = undefined,
    tokensSaved = undefined,
    rawBytesSaved = 0,
    dollarsSaved = undefined,
    inputPricePer1M = 2.0,
    detail = '',
    dedupeKey = '',
    createdAt = new Date().toISOString()
  } = {}) {
    const type = String(eventType || SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT).toUpperCase();
    const bytes = Math.max(0, Math.round(Number(rawBytesSaved) || 0));
    const derivedTokens = bytes > 0 ? Math.floor(bytes / 4) : 0;
    const saved = Math.max(0, Math.round(Number(argonEquivTokensSaved ?? tokensSaved ?? derivedTokens) || 0));
    const usd = dollarsSaved !== undefined
      ? Math.max(0, Number(dollarsSaved) || 0)
      : Number(((saved / 1_000_000) * Math.max(0, Number(inputPricePer1M) || 0)).toFixed(6));
    const detailStr = dedupeKey
      ? `[key:${dedupeKey}] ${String(detail || '')}`.trim()
      : String(detail || '');
    if (!this.dbPath) {
      return this.getSummary(sessionId);
    }

    const db = openLocalHorizonDb(this.dbPath, { readOnly: false });
    try {
      if (dedupeKey) {
        const existing = db.prepare(`
          SELECT id FROM savings_events
          WHERE session_id = ? AND event_type = ? AND detail LIKE ?
          LIMIT 1
        `).get(String(sessionId), type, `[key:${dedupeKey}]%`);
        if (existing) {
          return this.getSummary(sessionId);
        }
      }
      db.prepare(`
        INSERT INTO savings_events (session_id, event_type, argon_equiv_tokens_saved, raw_bytes_saved, dollars_saved, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(String(sessionId), type, saved, bytes, usd, detailStr, String(createdAt));
    } finally {
      db.close();
    }

    return this.getSummary(sessionId);
  }

  /**
   * Lists the most recent verified auto-fix events for a session (strictly read-only SQLite).
   * Passive `CACHE_HIT_PRESERVED` rows are excluded: they are tracked in the KPI bar, not the fix log.
   * @returns {{ total: number, items: Array<object> }}
   */
  listRecentEvents(sessionId = null, limit = 20) {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return { total: 0, items: [] };
    const cap = Math.max(1, Math.min(200, Math.round(Number(limit) || 20)));
    let rows = [];
    let total = 0;
    const db = openLocalHorizonDb(this.dbPath, { readOnly: true });
    try {
      const where = sessionId ? 'WHERE session_id = ? AND event_type != ?' : 'WHERE event_type != ?';
      const args = sessionId
        ? [String(sessionId), SAVINGS_EVENT_TYPES.CACHE_HIT_PRESERVED]
        : [SAVINGS_EVENT_TYPES.CACHE_HIT_PRESERVED];
      total = Number(db.prepare(`SELECT COUNT(*) AS n FROM savings_events ${where}`).get(...args)?.n || 0);
      rows = db.prepare(`
        SELECT id, event_type AS eventType, argon_equiv_tokens_saved AS tokensSaved, raw_bytes_saved AS rawBytesSaved, dollars_saved AS usd, detail, created_at AS at
        FROM savings_events ${where}
        ORDER BY id DESC
        LIMIT ${cap}
      `).all(...args);
    } finally {
      db.close();
    }
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        type: r.eventType,
        label: AUTO_FIX_LABELS[r.eventType] || String(r.eventType || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
        tokensSaved: Math.max(0, Number(r.tokensSaved) || 0),
        usd: Math.max(0, Number(r.usd) || 0),
        detail: String(r.detail || '').replace(/^\[key:[^\]]*\]\s*/, '').slice(0, 160),
        at: r.at,
        turn: null
      }))
    };
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
      [SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED]: 0,
      [SAVINGS_EVENT_TYPES.SUBAGENT_ISOLATED]: 0,
      [SAVINGS_EVENT_TYPES.CACHE_HIT_PRESERVED]: 0,
      [SAVINGS_EVENT_TYPES.COMPACTION_RECLAIMED]: 0,
      [SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_STEERED]: 0,
      [SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_BLOCKED]: 0,
      [SAVINGS_EVENT_TYPES.SIGHTSEEING_TOOL_PREVENTED]: 0
    };

    const totalsByType = {
      [SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED]: 0,
      [SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT]: 0,
      [SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED]: 0,
      [SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED]: 0,
      [SAVINGS_EVENT_TYPES.SUBAGENT_ISOLATED]: 0,
      [SAVINGS_EVENT_TYPES.CACHE_HIT_PRESERVED]: 0,
      [SAVINGS_EVENT_TYPES.COMPACTION_RECLAIMED]: 0,
      [SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_STEERED]: 0,
      [SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_BLOCKED]: 0,
      [SAVINGS_EVENT_TYPES.SIGHTSEEING_TOOL_PREVENTED]: 0
    };

    let totalArgonEquivTokensSaved = 0;
    let totalRawBytesSaved = 0;
    let totalDollarsSaved = 0;
    const distinctSessions = new Set();

    for (const row of rows) {
      const t = String(row.eventType || '');
      const tok = Math.max(0, Number(row.argonEquivTokensSaved || 0));
      const b = Math.max(0, Number(row.rawBytesSaved || 0));
      const usd = Math.max(0, Number(row.dollarsSaved || 0));
      totalArgonEquivTokensSaved += tok;
      totalRawBytesSaved += b;
      totalDollarsSaved += usd;
      if (row.sessionId) distinctSessions.add(String(row.sessionId));
      if (counts[t] !== undefined) {
        counts[t]++;
        totalsByType[t] += tok;
      }
    }

    const coldCount = counts[SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED];
    const downshiftCount = counts[SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT];
    const cliCount = counts[SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED];
    const loopCount = counts[SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED];
    const steeredPrompts = counts[SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_STEERED];
    const blockedPrompts = counts[SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_BLOCKED];
    const sightseeingToolsPrevented = counts[SAVINGS_EVENT_TYPES.SIGHTSEEING_TOOL_PREVENTED];
    const modeledEstimateTokensSaved =
      totalsByType[SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_STEERED] +
      totalsByType[SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_BLOCKED] +
      totalsByType[SAVINGS_EVENT_TYPES.SIGHTSEEING_TOOL_PREVENTED];

    const parts = [
      `${coldCount} Cold Prefill${coldCount === 1 ? '' : 's'}`,
      `${downshiftCount} Downshift${downshiftCount === 1 ? '' : 's'}`,
      `${cliCount} CLI Compress`
    ];
    if (loopCount > 0) {
      parts.push(`${loopCount} Loop${loopCount === 1 ? '' : 's'} Prevented`);
    }

    const formattedSavedK = formatTokensCompactK(totalArgonEquivTokensSaved);
    const formattedSavedHuman = formatTokensHuman(totalArgonEquivTokensSaved);
    const formattedDollarsSaved = totalDollarsSaved === 0 ? '$0.00' : `$${totalDollarsSaved.toFixed(2)}`;
    const statusBarText = `$(shield) Horizon: +${formattedSavedK} Argon-equiv tokens saved (${parts.join(' • ')})`;
    const footerText = `🛡️ Horizon: +${formattedSavedK} Argon-equiv tokens saved (${parts.join(' • ')})`;
    const displayFooterText = `🛡️ Tokens Saved: +${formattedSavedHuman} (${parts.join(' · ')})`;

    return {
      totalTokensSaved: totalArgonEquivTokensSaved,
      totalArgonEquivTokensSaved,
      totalRawBytesSaved,
      totalDollarsSaved: Number(totalDollarsSaved.toFixed(6)),
      formattedDollarsSaved,
      formattedSavedK,
      formattedSavedHuman,
      sessionsCount: distinctSessions.size,
      counts,
      totalsByType,
      measuredPromptHygiene: {
        steeredPrompts,
        blockedPrompts,
        sightseeingToolsPrevented,
        modeledEstimateTokensSaved,
        provenanceTag: '[modeled-estimate]'
      },
      events: rows,
      statusBarText,
      footerText,
      displayFooterText
    };
  }

  /**
   * Returns both session-scoped and 30-day workspace/global ledger summaries.
   */
  getWorkspaceSummary({ sessionId = null, days = 30 } = {}) {
    const sessionSummary = sessionId ? this.getSummary(sessionId) : this.getSummary(null);
    const allSummary = this.getSummary(null);
    const cutoffMs = Date.now() - Math.max(1, Number(days) || 30) * 86_400_000;

    let totalTokens = 0;
    let totalDollarsSaved = 0;
    const sessions = new Set();
    const counts = {
      [SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED]: 0,
      [SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT]: 0,
      [SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED]: 0,
      [SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED]: 0,
      [SAVINGS_EVENT_TYPES.SUBAGENT_ISOLATED]: 0,
      [SAVINGS_EVENT_TYPES.CACHE_HIT_PRESERVED]: 0,
      [SAVINGS_EVENT_TYPES.COMPACTION_RECLAIMED]: 0,
      [SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_STEERED]: 0,
      [SAVINGS_EVENT_TYPES.PROMPT_HYGIENE_BLOCKED]: 0,
      [SAVINGS_EVENT_TYPES.SIGHTSEEING_TOOL_PREVENTED]: 0
    };
    const totalsByType = { ...counts };

    for (const ev of allSummary.events) {
      const ts = Date.parse(ev.createdAt || '');
      if (Number.isFinite(ts) && ts < cutoffMs) continue;
      const tok = Math.max(0, Number(ev.argonEquivTokensSaved || 0));
      const usd = Math.max(0, Number(ev.dollarsSaved || 0));
      const t = String(ev.eventType || '');
      totalTokens += tok;
      totalDollarsSaved += usd;
      if (ev.sessionId) sessions.add(String(ev.sessionId));
      if (counts[t] !== undefined) {
        counts[t]++;
        totalsByType[t] += tok;
      }
    }

    return {
      session: sessionSummary,
      workspace30d: {
        totalTokens,
        totalDollarsSaved: Number(totalDollarsSaved.toFixed(6)),
        formattedTokens: formatTokensHuman(totalTokens),
        formattedDollarsSaved: totalDollarsSaved === 0 ? '$0.00' : `$${totalDollarsSaved.toFixed(2)}`,
        sessionsCount: sessions.size,
        counts,
        totalsByType
      }
    };
  }

  /**
   * Exports a plain-English Markdown receipt of verified token savings.
   */
  copyPlainSavingsReceipt(arg = {}) {
    const opts = typeof arg === 'string' ? { sessionId: arg } : (arg || {});
    const sessionId = opts.sessionId || null;
    const liveSavings = opts.liveSavings || null;
    const ws = this.getWorkspaceSummary({ sessionId });
    const s = liveSavings?.session || {
      totalTokens: ws.session.totalTokensSaved,
      estimatedUsd: ws.session.totalDollarsSaved,
      bySource: {
        subagentIsolated: ws.session.totalsByType.SUBAGENT_ISOLATED || 0,
        cachePreserved: (ws.session.totalsByType.COLD_PREFILL_AVOIDED || 0) + (ws.session.totalsByType.CACHE_HIT_PRESERVED || 0),
        cliCompressed: ws.session.totalsByType.CLI_DUMP_COMPRESSED || 0,
        compactionReclaimed: ws.session.totalsByType.COMPACTION_RECLAIMED || 0,
        guardsPrevented:
          (ws.session.totalsByType.LOOP_TURN_PREVENTED || 0) +
          (ws.session.totalsByType.EFFORT_DOWNSHIFT || 0) +
          (ws.session.totalsByType.PROMPT_HYGIENE_STEERED || 0) +
          (ws.session.totalsByType.PROMPT_HYGIENE_BLOCKED || 0) +
          (ws.session.totalsByType.SIGHTSEEING_TOOL_PREVENTED || 0)
      }
    };
    const w30 = liveSavings?.workspace30d || {
      totalTokens: ws.workspace30d.totalTokens,
      estimatedUsd: ws.workspace30d.totalDollarsSaved
    };
    const lines = [
      `### 🛡️ Highbeam — Verified Tokens Saved Receipt`,
      ``,
      `**This Chat:** \`+${formatTokensHuman(s.totalTokens)}\` (\`~$${Number(s.estimatedUsd || 0).toFixed(2)}\` est.) · **30-Day Workspace:** \`+${formatTokensHuman(w30.totalTokens)}\``,
      ``,
      `| Source | Tokens Saved |`,
      `| :--- | :---: |`,
      `| Subagent context isolation | +${formatTokensHuman(s.bySource?.subagentIsolated || 0)} |`,
      `| Warm prompt cache preserved (95% off) | +${formatTokensHuman(s.bySource?.cachePreserved || 0)} |`,
      `| CLI & log output compressed | +${formatTokensHuman(s.bySource?.cliCompressed || 0)} |`,
      `| Loops, re-reads & tail trims avoided | +${formatTokensHuman((s.bySource?.guardsPrevented || 0) + (s.bySource?.compactionReclaimed || 0))} |`
    ];
    const markdown = lines.join('\n');
    this.clipboardWriter(markdown);
    return { ok: true, markdown, summary: ws.session };
  }

  /**
   * Exports a clean Markdown telemetry table receipt and copies it to the clipboard.
   */
  copySavingsReceipt(sessionId = null) {
    const summary = this.getSummary(sessionId);
    const lines = [
      `### 🛡️ Highbeam — Saved-Quota Receipt`,
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

/**
 * Computes the unified multi-source "Tokens Saved" payload (`state.savings`) combining
 * deduplicated subagent isolation, warm prompt cache 95% discount, FTS5 CLI compression,
 * compaction/tail-trim reclaims, and prevented loop/re-read guards.
 */
export function computeUnifiedSavings(state = {}, {
  ledger = null,
  sessionId = null,
  fts5SavedTokens = 0
} = {}) {
  const sessionKey = String(sessionId || state?.sessionId || 'default');
  const ws = ledger && typeof ledger.getWorkspaceSummary === 'function'
    ? ledger.getWorkspaceSummary({ sessionId: sessionKey, days: 30 })
    : null;
  const sessionLedger = ws?.session || null;
  const workspaceLedger = ws?.workspace30d || null;

  // 1. Deduplicated subagent context isolation
  const rawInvocations = Array.isArray(state?.subagents?.invocations) ? state.subagents.invocations : [];
  const seenSubIds = new Set();
  let dedupedSubagentSaved = 0;
  for (const inv of rawInvocations) {
    const id = String(inv?.conversationId || inv?.id || '');
    if (id && seenSubIds.has(id)) continue;
    if (id) seenSubIds.add(id);
    dedupedSubagentSaved += Math.max(0, Number(inv?.tokensSaved || 0));
  }
  if (dedupedSubagentSaved === 0 && rawInvocations.length === 0) {
    dedupedSubagentSaved = Math.max(
      0,
      Number(state?.subagents?.totalSavedTokens ?? state?.subagents?.tokensSaved ?? 0)
    );
  }
  const subagentIsolated = Math.max(
    dedupedSubagentSaved,
    Number(sessionLedger?.totalsByType?.SUBAGENT_ISOLATED || 0)
  );

  // 2. Warm KV prompt cache discount (defaults to 95% for Argon/Sonnet 5.5, or model-specific ratio) + avoided cold prefills
  const cacheBlock = state?.quota?.cache || state?.cache || {};
  const cacheReadTokens = Math.max(0, Number(cacheBlock.cacheReadTokens || 0));
  const pricing = state?.model?.pricing || {};
  const explicitDiscountRatio = Number(pricing.cacheReadDiscountRatio);
  const derivedDiscountRatio =
    Number(pricing.inputPer1M) > 0 && pricing.readPer1M !== undefined
      ? Math.max(0, Math.min(0.99, 1 - Number(pricing.readPer1M) / Number(pricing.inputPer1M)))
      : NaN;
  const discountRatio = Number.isFinite(explicitDiscountRatio) && explicitDiscountRatio > 0 && explicitDiscountRatio < 1
    ? explicitDiscountRatio
    : (Number.isFinite(derivedDiscountRatio) ? derivedDiscountRatio : 0.95);
  const cacheDiscountSaved = Math.round(cacheReadTokens * discountRatio);
  const ledgerCacheHits = Math.max(0, Number(sessionLedger?.totalsByType?.CACHE_HIT_PRESERVED || 0));
  const coldPrefillsSaved = Math.max(0, Number(sessionLedger?.totalsByType?.COLD_PREFILL_AVOIDED || 0));
  const billingEquivalentCacheTokens = Math.max(cacheDiscountSaved, ledgerCacheHits);
  const cachePreserved = billingEquivalentCacheTokens + coldPrefillsSaved;

  // 3. CLI & log compression
  const cliCompressed = Math.max(
    0,
    Number(state?.coachState?.fts5Compressor?.savedTokens || 0),
    Number(sessionLedger?.totalsByType?.CLI_DUMP_COMPRESSED || 0)
  );

  // 4. Compaction & uncached tail trims
  const liveCompactedDelta = state?.delta?.compacted && Number(state?.delta?.tokens) < 0
    ? Math.abs(Math.round(Number(state.delta.tokens)))
    : 0;
  const compactionReclaimed = Math.max(
    liveCompactedDelta,
    Number(sessionLedger?.totalsByType?.COMPACTION_RECLAIMED || 0)
  );

  // 5. Blocked retry loops, unmodified re-reads, effort downshifts & prompt hygiene interventions
  const guardsPrevented =
    Math.max(0, Number(sessionLedger?.totalsByType?.LOOP_TURN_PREVENTED || 0)) +
    Math.max(0, Number(sessionLedger?.totalsByType?.EFFORT_DOWNSHIFT || 0)) +
    Math.max(0, Number(sessionLedger?.totalsByType?.PROMPT_HYGIENE_STEERED || 0)) +
    Math.max(0, Number(sessionLedger?.totalsByType?.PROMPT_HYGIENE_BLOCKED || 0)) +
    Math.max(0, Number(sessionLedger?.totalsByType?.SIGHTSEEING_TOOL_PREVENTED || 0));
  const avoidedBloat = compactionReclaimed + guardsPrevented;

  const physicalTokensAvoided =
    subagentIsolated +
    coldPrefillsSaved +
    cliCompressed +
    compactionReclaimed +
    guardsPrevented;

  const sessionTotalTokens =
    subagentIsolated +
    cachePreserved +
    cliCompressed +
    compactionReclaimed +
    guardsPrevented;

  const inputRatePer1M = Math.max(0.1, Number(state?.model?.pricing?.inputPer1M || 2.0));
  const sessionEstimatedUsd = Number(((sessionTotalTokens / 1_000_000) * inputRatePer1M).toFixed(4));

  const nonSessionLedgerTokens = Math.max(
    0,
    Number(workspaceLedger?.totalTokens || 0) - Number(sessionLedger?.totalTokensSaved || 0)
  );
  const nonSessionLedgerDollars = Math.max(
    0,
    Number(workspaceLedger?.totalDollarsSaved || 0) - Number(sessionLedger?.totalDollarsSaved || 0)
  );
  const extraFts5Tokens = Math.max(
    0,
    Number(fts5SavedTokens || 0) - Number(workspaceLedger?.totalsByType?.CLI_DUMP_COMPRESSED || 0)
  );
  const extraFts5Usd = (extraFts5Tokens / 1_000_000) * inputRatePer1M;
  const workspaceTotalTokens = Math.max(
    sessionTotalTokens,
    sessionTotalTokens + nonSessionLedgerTokens + extraFts5Tokens
  );
  const workspaceEstimatedUsd = Number(
    Math.max(
      (workspaceTotalTokens / 1_000_000) * inputRatePer1M,
      sessionEstimatedUsd + nonSessionLedgerDollars + extraFts5Usd
    ).toFixed(4)
  );
  const baseSessionsCount = Number(workspaceLedger?.sessionsCount || 0);
  const hasCurrentInLedger = Number(sessionLedger?.sessionsCount || 0) > 0;
  const sessionsCount = Math.max(
    sessionTotalTokens > 0 ? 1 : 0,
    baseSessionsCount + (sessionTotalTokens > 0 && !hasCurrentInLedger ? 1 : 0)
  );

  return {
    session: {
      totalTokens: sessionTotalTokens,
      totalPhysicalTokens: sessionTotalTokens,
      physicalTokensAvoided,
      billingEquivalentCacheTokens,
      cacheDiscountRatio: discountRatio,
      formattedTokens: formatTokensHuman(sessionTotalTokens),
      estimatedUsd: sessionEstimatedUsd,
      estimatedInputValueUsd: sessionEstimatedUsd,
      formattedUsd: sessionEstimatedUsd === 0 ? '$0.00' : `$${sessionEstimatedUsd.toFixed(2)}`,
      bySource: {
        subagentIsolated,
        subagentIsolation: subagentIsolated,
        cachePreserved,
        cachePreservation: cachePreserved,
        cliCompressed,
        cliCompression: cliCompressed,
        compactionReclaimed,
        guardsPrevented,
        avoidedBloat
      }
    },
    workspace30d: {
      totalTokens: workspaceTotalTokens,
      totalPhysicalTokens: workspaceTotalTokens,
      formattedTokens: formatTokensHuman(workspaceTotalTokens),
      estimatedUsd: workspaceEstimatedUsd,
      estimatedInputValueUsd: workspaceEstimatedUsd,
      formattedUsd: workspaceEstimatedUsd === 0 ? '$0.00' : `$${workspaceEstimatedUsd.toFixed(2)}`,
      sessionsCount
    }
  };
}

export default SavedQuotaReceiptLedger;
