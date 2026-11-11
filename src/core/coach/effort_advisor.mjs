import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from '../paths.mjs';
import { openLocalHorizonDb } from '../sqlite_client.mjs';
import {
  evaluateDet08CacheGravityAndEffort,
  WARM_CACHE_GRAVITY_FLOOR_TOKENS,
  resolveCarbonPricingForTimestamp
} from '../shared/detectors.mjs';

/**
 * Rank 7 (DET-08): KV-Cache Gravity & Same-Model Between-Turn Effort Advisor
 * (`src/core/coach/effort_advisor.mjs`)
 *
 * Triggered from BOTH `PostInvocation` and the `.pb` `TrajectoryWatcher`:
 *  - Turn 0-2 (`cachedTokens <= 3529`): Routes simple single-file/typo tasks to `gemini-3.8-flash`
 *    before Frontier KV-cache gravity locks in.
 *  - Mid-Session (`cachedTokens > 3529`): NEVER switches main-thread model ID to Flash (which
 *    forfeits the 95% warm cache discount and costs up to 7.5x more in input). When `HysteresisLock`
 *    is clear (`recentTestFailures < 2` and `det05Oscillation === false`), surfaces a 1-click
 *    `[Downshift: /effort low (-68% output burn, keeps warm cache)]` chip in Box 3 with 3-strike
 *    SQLite dismissal muting.
 */

export { WARM_CACHE_GRAVITY_FLOOR_TOKENS, resolveCarbonPricingForTimestamp };

export function getDefaultEffortAdvisorDbPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'effort_advisor.sqlite');
}

export class EffortAdvisor {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.dbPath = options.dbPath || getDefaultEffortAdvisorDbPath(this.homeDir);
    this._initDb();
  }

  _initDb() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = openLocalHorizonDb(this.dbPath, { readOnly: false, busyTimeoutMs: 3000 });
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS effort_dismissals (
          session_id TEXT PRIMARY KEY,
          dismissal_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }
  }

  getDismissalCount(sessionId = 'default_session') {
    if (!fs.existsSync(this.dbPath)) return 0;
    const db = openLocalHorizonDb(this.dbPath, { readOnly: true, busyTimeoutMs: 3000 });
    try {
      const row = db.prepare('SELECT dismissal_count AS c FROM effort_dismissals WHERE session_id = ?').get(String(sessionId));
      return Number(row?.c || 0);
    } finally {
      db.close();
    }
  }

  recordDismissal(sessionId = 'default_session') {
    const now = new Date().toISOString();
    const db = openLocalHorizonDb(this.dbPath, { readOnly: false, busyTimeoutMs: 3000 });
    try {
      db.prepare(`
        INSERT INTO effort_dismissals (session_id, dismissal_count, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          dismissal_count = dismissal_count + 1,
          updated_at = excluded.updated_at
      `).run(String(sessionId), now);
    } finally {
      db.close();
    }
    const count = this.getDismissalCount(sessionId);
    return {
      sessionId: String(sessionId),
      dismissalStrikes: count,
      muted: count >= 3
    };
  }

  resetDismissals(sessionId = 'default_session') {
    const db = openLocalHorizonDb(this.dbPath, { readOnly: false, busyTimeoutMs: 3000 });
    try {
      db.prepare('DELETE FROM effort_dismissals WHERE session_id = ?').run(String(sessionId));
    } finally {
      db.close();
    }
    return { sessionId: String(sessionId), dismissalStrikes: 0, muted: false };
  }

  evaluate({
    sessionId = 'default_session',
    turnCount = 0,
    cachedTokens = 0,
    activeModel = 'gemini-4-carbon',
    activeEffort = 'high',
    isSimpleTask = true,
    recentTestFailures = 0,
    det05Oscillation = false,
    timestampUtc = '2026-11-10T00:00:00Z'
  } = {}) {
    const dismissalStrikes = this.getDismissalCount(sessionId);
    const res = evaluateDet08CacheGravityAndEffort({
      turnCount,
      cachedTokens,
      activeModel,
      activeEffort,
      isSimpleTask,
      recentTestFailures,
      det05Oscillation,
      dismissalStrikes,
      timestampUtc
    });

    return {
      ...res,
      sessionId: String(sessionId),
      dismissalStrikes,
      box3Chip: res.lane === 'MID_SESSION_SAME_MODEL_EFFORT' && res.triggered
        ? {
            actionId: 'det08-effort-downshift',
            label: res.chipLabel,
            commandText: '/effort low',
            dismissable: true,
            dismissalStrikes
          }
        : null
    };
  }
}

export function evaluateBetweenTurnEffortAdvisor(params = {}, options = {}) {
  const advisor = new EffortAdvisor(options);
  return advisor.evaluate(params);
}

export default EffortAdvisor;
