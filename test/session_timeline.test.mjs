import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSessionTimeline,
  applyAutoFixToTimeline,
  TIMELINE_TAGS
} from '../src/core/session_timeline.mjs';
import {
  SavedQuotaReceiptLedger,
  SAVINGS_EVENT_TYPES
} from '../src/core/coach/saved_quota_ledger.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

function user(sec) {
  return { type: 'USER_INPUT', source: 'USER_EXPLICIT', createdAt: at(sec) };
}
function model(sec, toolCalls = [], extra = {}) {
  return { type: 'PLANNER_RESPONSE', source: 'MODEL', createdAt: at(sec), toolCalls, ...extra };
}

/** Builds steps + classifiedSteps from compact specs: [step, tokens, category, target]. */
function scenario(specs) {
  const steps = [];
  const classifiedSteps = [];
  specs.forEach(([step, tokens, category = 'ACTIVE_WORKING_SET', target = 'Active Coding & Context'], idx) => {
    steps.push(step);
    classifiedSteps.push({ stepIndex: idx, tokens, category, target });
  });
  return { steps, classifiedSteps };
}

describe('Session Timeline builder (Simple View Flight Recorder)', () => {
  it('partitions turns, keeps anchors out of bars, and tags every bad/good practice deterministically', () => {
    const { steps, classifiedSteps } = scenario([
      [{ type: 'SYSTEM_PROMPT', createdAt: at(0) }, 6000, 'ANCHOR', 'System & Project Anchors'],
      [user(1), 200],
      [model(5, [{ name: 'view_file', args: { Path: 'a.js', StartLine: 1, EndLine: 40 } }]), 500],
      [user(10), 100],
      [model(12), 3000, 'STALE_DUPLICATE', 'a.js'],
      [user(20), 100],
      [model(22), 2000, 'DEAD_ERROR', 'npm test'],
      [user(30), 100],
      [model(32), 9000],
      [user(40), 100],
      [model(41, [{ name: 'write_to_file', args: { TargetFile: 'C:/p/task.md' } }]), 300],
      [user(50), 100],
      [model(52, [{ name: 'invoke_subagent', args: {} }]), 300]
    ]);
    const tl = buildSessionTimeline({ steps, classifiedSteps, safeLimit: 140000, totalActiveTokens: 22000 });

    assert.equal(tl.totalTurns, 6, 'system prompt must not open its own turn');
    assert.equal(tl.turns[0].tokensAdded, 700, 'anchor tokens are baseline, not bar height');
    assert.ok(tl.turns[0].tags.includes('LINE_RANGE_READ'));
    assert.equal(tl.turns[0].practice, 'good');
    assert.ok(tl.turns[1].tags.includes('DUPLICATE_READ'));
    assert.equal(tl.turns[1].practice, 'bad');
    assert.ok(tl.turns[2].tags.includes('DEAD_ERROR'));
    assert.ok(tl.turns[3].tags.includes('SPIKE'));
    assert.ok(tl.turns[4].tags.includes('CHECKPOINT_SAVED'));
    assert.ok(tl.turns[5].tags.includes('SUBAGENT_DELEGATED'));
    assert.match(tl.turns[1].reason, /Re-read a file in full/);
    assert.ok(tl.markers.some((m) => m.kind === 'CHECKPOINT'));
    for (const t of tl.turns) {
      for (const tag of t.tags) assert.ok(TIMELINE_TAGS[tag], `known tag ${tag}`);
    }
    assert.equal(tl.turns[tl.turns.length - 1].cumulative, 6000 + 700 + 3100 + 2100 + 9100 + 400 + 400);
  });

  it('distinguishes compaction while warm (bad) vs cold (good) and model switch while warm vs cold', () => {
    const isCompactionStep = (s) => Boolean(s.isCheckpoint);
    const { steps, classifiedSteps } = scenario([
      [user(0), 1000],
      [model(5), 1000],
      [{ ...model(20), isCheckpoint: true }, 500],        // 15s gap -> warm compaction
      [user(30), 100],
      [model(31), 100],
      [{ ...user(500), }, 100],                           // idle
      [{ ...model(900), isCheckpoint: true }, 500]        // 400s gap -> cold compaction
    ]);
    const tl = buildSessionTimeline({
      steps, classifiedSteps, safeLimit: 140000, isCompactionStep,
      effortTransitions: [
        { stepNumber: 4, fromLabel: 'Auto', toLabel: 'High' },   // 1s gap -> warm switch
        { stepNumber: 6, fromLabel: 'High', toLabel: 'Fast' }    // 400s gap -> cold switch
      ]
    });
    const byTurn = Object.fromEntries(tl.turns.map((t) => [t.turn, t]));
    assert.ok(byTurn[1].tags.includes('COMPACT_WHILE_WARM'));
    assert.equal(byTurn[1].practice, 'bad');
    assert.ok(byTurn[3].tags.includes('COMPACT_WHILE_COLD'));
    assert.ok(byTurn[2].tags.includes('MODEL_SWITCH_WARM'));
    assert.ok(!byTurn[3].tags.includes('MODEL_SWITCH_WARM'), 'cold switch must not be flagged bad');
    assert.equal(tl.markers.filter((m) => m.kind === 'MODEL_SWITCH').length, 2);
  });

  it('flags cold-cliff resumes only when a large prefix is already in context and prices the lost discount', () => {
    const { steps, classifiedSteps } = scenario([
      [user(0), 100],
      [model(5), 60000],                 // 60k prefix, also a spike
      [user(700), 100],                  // 695s idle > 300s TTL
      [model(705), 100],
      [user(2000), 100]                  // idle again but only if prefix large -> still large
    ]);
    const tl = buildSessionTimeline({ steps, classifiedSteps, safeLimit: 140000, totalActiveTokens: 60400 });
    assert.ok(tl.turns[1].tags.includes('COLD_CLIFF'));
    assert.equal(tl.coldCliffs.length, 2);
    assert.ok(tl.markers.some((m) => m.kind === 'COLD_GAP'));
    assert.ok(tl.kpis.coldRestartLossUsd > 0.1, 'two ~60k cold resumes at 95% discount loss');

    const small = scenario([[user(0), 100], [model(5), 400], [user(900), 100]]);
    const tl2 = buildSessionTimeline({ ...small, safeLimit: 140000 });
    assert.equal(tl2.coldCliffs.length, 0, 'small prefix after idle is not a cliff');
  });

  it('degrades honestly without timestamps: compaction is marked approx and no cache tags are invented', () => {
    const { steps, classifiedSteps } = scenario([
      [{ type: 'USER_INPUT', source: 'USER_EXPLICIT' }, 100],
      [{ type: 'PLANNER_RESPONSE', isCheckpoint: true }, 100]
    ]);
    const tl = buildSessionTimeline({ steps, classifiedSteps, isCompactionStep: (s) => Boolean(s.isCheckpoint) });
    assert.equal(tl.hasTimestamps, false);
    assert.deepEqual(tl.turns[0].tags.filter((k) => k.startsWith('COMPACT_')), []);
    assert.equal(tl.markers.find((m) => m.kind === 'COMPACT')?.approx, true);
    assert.equal(tl.turns[0].cache, 'unknown');
  });

  it('windows to the last 39 turns and collapses older history into one aggregate', () => {
    const specs = [];
    for (let i = 0; i < 120; i++) {
      specs.push([user(i * 10), 100]);
      specs.push([model(i * 10 + 1), i % 3 === 0 ? 3000 : 200, i % 3 === 0 ? 'STALE_DUPLICATE' : 'ACTIVE_WORKING_SET', 'x.js']);
    }
    const { steps, classifiedSteps } = scenario(specs);
    const tl = buildSessionTimeline({ steps, classifiedSteps, safeLimit: 140000 });
    assert.equal(tl.totalTurns, 120);
    assert.equal(tl.turns.length, 39);
    assert.equal(tl.turns[0].turn, 82);
    assert.equal(tl.earlier.turns, 81);
    assert.ok(tl.earlier.bad > 0 && tl.earlier.tokens > 0);
    assert.ok(tl.markers.every((m) => m.turn >= 82));
  });

  it('projects turns-left from the last 5 turns, clamps at 0 when over limit, and hides with <3 turns', () => {
    const mk = (n, per) => {
      const specs = [];
      for (let i = 0; i < n; i++) { specs.push([user(i * 5), 0]); specs.push([model(i * 5 + 1), per]); }
      return scenario(specs);
    };
    const a = buildSessionTimeline({ ...mk(10, 10000), safeLimit: 140000, totalActiveTokens: 100000 });
    assert.equal(a.kpis.burnRateTokens, 10000);
    assert.equal(a.kpis.turnsLeft, 4);
    const over = buildSessionTimeline({ ...mk(10, 10000), safeLimit: 140000, totalActiveTokens: 150000 });
    assert.equal(over.kpis.turnsLeft, 0);
    assert.equal(over.kpis.overLimit, true);
    const few = buildSessionTimeline({ ...mk(2, 10000), safeLimit: 140000, totalActiveTokens: 20000 });
    assert.equal(few.kpis.turnsLeft, null);
  });

  it('applies ledger auto-fix events to the owning turn idempotently', () => {
    const { steps, classifiedSteps } = scenario([
      [user(0), 100], [model(5), 400], [user(60), 100], [model(65), 400]
    ]);
    const tl = buildSessionTimeline({ steps, classifiedSteps, safeLimit: 140000 });
    const items = [{ at: at(70), tokensSaved: 4200 }, { at: at(2), tokensSaved: 100 }];
    applyAutoFixToTimeline(tl, items);
    applyAutoFixToTimeline(tl, items); // second daemon tick must not double count
    assert.equal(items[0].turn, 2);
    assert.equal(items[1].turn, 1);
    assert.equal(tl.turns[1].tagCounts.AUTO_FIX_FIRED, 1);
    assert.equal(tl.turns[1].practice, 'good');
    assert.equal(tl.kpis.goodCount, 2);
  });

  it('ledger.listRecentEvents is read-only, newest-first, per-session, and excludes passive cache preservation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-timeline-ledger-'));
    try {
      const ledger = new SavedQuotaReceiptLedger({ dbPath: path.join(dir, 'ledger.sqlite') });
      ledger.recordSaving({ sessionId: 's1', eventType: SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED, tokensSaved: 4200, detail: 'npm test', createdAt: at(10) });
      ledger.recordSaving({ sessionId: 's1', eventType: SAVINGS_EVENT_TYPES.CACHE_HIT_PRESERVED, tokensSaved: 90000, dedupeKey: 'k1', createdAt: at(11) });
      ledger.recordSaving({ sessionId: 's1', eventType: SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED, tokensSaved: 3100, dedupeKey: 'k2', detail: 'dup read', createdAt: at(12) });
      ledger.recordSaving({ sessionId: 's2', eventType: SAVINGS_EVENT_TYPES.SUBAGENT_ISOLATED, tokensSaved: 18000, createdAt: at(13) });

      const res = ledger.listRecentEvents('s1', 20);
      assert.equal(res.total, 2);
      assert.deepEqual(res.items.map((i) => i.type), ['LOOP_TURN_PREVENTED', 'CLI_DUMP_COMPRESSED']);
      assert.equal(res.items[0].label, 'Loop turn prevented');
      assert.equal(res.items[0].detail, 'dup read', 'dedupe key prefix is stripped');
      assert.equal(res.items[1].tokensSaved, 4200);
      assert.equal(ledger.listRecentEvents('s1', 1).items.length, 1);
      assert.equal(new SavedQuotaReceiptLedger({ dbPath: path.join(dir, 'missing.sqlite') }).listRecentEvents('s1').total, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
