import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  PLAYBOOK_REGIMES,
  computeNextPromptPlaybook,
  formatNextPromptPlaybookCli
} from '../src/core-isomorphic/coach/nextPromptPlaybook.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLAYBOOK_RESULTS_PATH = path.join(
  ROOT,
  'experiments',
  'model-switch-benchmark',
  'results',
  'playbook_ab_results.json'
);

describe('Next-Prompt Playbook (Layer 1 5x3x2 Matrix + Layer 2 Replay)', () => {
  it('covers all 5 regimes x 3 workloads x 2 hosts cleanly and keeps Gemini unverified + Haiku note 1h-only', () => {
    const scenarios = [
      {
        name: 'WARM_EFFORT_SAFE (5m TTL)',
        expectedRegime: PLAYBOOK_REGIMES.WARM_EFFORT_SAFE,
        expectedEffStatus: 'safe',
        baseState: { modelId: 'claude-sonnet-5-5', cachedTokens: 48_000, totalTokens: 60_000, cacheWarm: true, cacheTtlTier: '5m', ttlRemainingSec: 210 }
      },
      {
        name: 'COLD_BOUNDARY (TTL expired)',
        expectedRegime: PLAYBOOK_REGIMES.COLD_BOUNDARY,
        expectedEffStatus: 'safe',
        baseState: { modelId: 'claude-opus-5-5', cachedTokens: 48_000, totalTokens: 52_000, cacheWarm: true, cacheTtlTier: '5m', ttlRemainingSec: 0, idleSeconds: 320 }
      },
      {
        name: 'NEAR_CLIFF (165k Claude)',
        expectedRegime: PLAYBOOK_REGIMES.NEAR_CLIFF,
        expectedEffStatus: 'safe',
        baseState: { modelId: 'claude-sonnet-5-5', cachedTokens: 150_000, totalTokens: 165_000, cacheWarm: true, cacheTtlTier: '5m', ttlRemainingSec: 180 }
      },
      {
        name: 'WARM_EFFORT_UNSAFE (4.6)',
        expectedRegime: PLAYBOOK_REGIMES.WARM_EFFORT_UNSAFE,
        expectedEffStatus: 'unsafe',
        baseState: { modelId: 'claude-sonnet-4-6', cachedTokens: 48_000, totalTokens: 55_000, cacheWarm: true, cacheTtlTier: '5m', ttlRemainingSec: 200 }
      },
      {
        name: 'WARM_EFFORT_UNVERIFIED (Gemini 4 Neon)',
        expectedRegime: PLAYBOOK_REGIMES.WARM_EFFORT_UNVERIFIED,
        expectedEffStatus: 'unverified',
        baseState: { modelId: 'gemini-4-neon', cachedTokens: 48_000, totalTokens: 55_000, contextCeiling: 256_000, safeLimit: 179_000, cacheWarm: true, cacheTtlTier: '5m', ttlRemainingSec: 200 }
      }
    ];

    let totalCellsChecked = 0;
    for (const sc of scenarios) {
      for (const host of ['claude', 'antigravity']) {
        const pb = computeNextPromptPlaybook({ ...sc.baseState, host });
        assert.equal(pb.regime, sc.expectedRegime, `${sc.name} host=${host}`);
        assert.equal(pb.effortCacheStatus, sc.expectedEffStatus, `${sc.name} status`);
        assert.equal(pb.rows.length, 3, 'Must return exactly 3 workload categories');
        assert.deepEqual(pb.rows.map((r) => r.category), ['quick', 'standard', 'deep']);

        if (sc.expectedRegime === PLAYBOOK_REGIMES.WARM_EFFORT_SAFE) {
          assert.equal(pb.optionalDetourNote, null, '5m TTL must NEVER recommend optional Haiku detour');
          if (host === 'claude') {
            assert.deepEqual(pb.rows.map((r) => r.copyCommand), ['/effort low', '/effort medium', '/effort high']);
          } else {
            assert.deepEqual(pb.rows.map((r) => r.copyCommand), [null, null, null]);
            assert.match(pb.rows[0].action, /Effort: Low/);
          }
        } else if (sc.expectedRegime === PLAYBOOK_REGIMES.NEAR_CLIFF) {
          for (const r of pb.rows) {
            assert.match(r.action, /\/compact/i);
          }
        } else if (sc.expectedRegime === PLAYBOOK_REGIMES.COLD_BOUNDARY) {
          assert.match(pb.rows[0].mechanism, /0 warm prefix/i);
          if (host === 'claude') assert.match(pb.rows[0].action, /haiku/i);
          else assert.match(pb.rows[0].action, /Flash/);
        } else if (sc.expectedRegime === PLAYBOOK_REGIMES.WARM_EFFORT_UNSAFE) {
          for (const r of pb.rows) assert.match(r.action, /Hold/i);
        } else if (sc.expectedRegime === PLAYBOOK_REGIMES.WARM_EFFORT_UNVERIFIED) {
          for (const r of pb.rows) {
            assert.match(r.action, /unverified/i);
            assert.match(r.mechanism, /unverified/i);
          }
        }

        const cliText = formatNextPromptPlaybookCli(pb);
        assert.match(cliText, new RegExp(pb.badge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        totalCellsChecked += pb.rows.length;
      }
    }
    assert.equal(totalCellsChecked, 30, 'Verified all 5 regimes x 2 hosts x 3 rows = 30 cells');

    // Optional Haiku detour note appears ONLY on explicit `1h` cache tier for 5.5 models
    const pb1h = computeNextPromptPlaybook({
      modelId: 'claude-sonnet-5-5',
      cachedTokens: 48_000,
      totalTokens: 55_000,
      cacheWarm: true,
      cacheTtlTier: '1h',
      ttlRemainingSec: 3200,
      host: 'claude'
    });
    assert.equal(pb1h.regime, PLAYBOOK_REGIMES.WARM_EFFORT_SAFE);
    assert.ok(pb1h.optionalDetourNote && /1h TTL only.*Haiku 5\.5/i.test(pb1h.optionalDetourNote));

    // Performance budget: < 1ms mean over 100 calls
    const t0 = performance.now();
    for (let i = 0; i < 100; i += 1) {
      computeNextPromptPlaybook({ modelId: 'claude-opus-5-5', cachedTokens: 60_000, totalTokens: 70_000, cacheWarm: true, ttlRemainingSec: 210 });
    }
    const avgMs = (performance.now() - t0) / 100;
    assert.ok(avgMs < 1.0, `Expected <1ms per call, got ${avgMs.toFixed(3)}ms`);
  });

  it('replays recorded OPUS_PLAYBOOK, SONNET_PLAYBOOK, and LEGACY_46 turns with stable regime selection', () => {
    assert.ok(fs.existsSync(PLAYBOOK_RESULTS_PATH), `Missing dataset at ${PLAYBOOK_RESULTS_PATH}`);
    const data = JSON.parse(fs.readFileSync(PLAYBOOK_RESULTS_PATH, 'utf8'));
    const pbRuns = (data.runs || []).filter((r) =>
      r.arm === 'OPUS_PLAYBOOK' || r.arm === 'SONNET_PLAYBOOK' || r.arm === 'LEGACY_46_EFFORT_CHECK'
    );
    assert.equal(pbRuns.length, 13, 'Expected 6 Opus Playbook + 6 Sonnet Playbook + 1 Legacy 4.6 run');

    for (const run of pbRuns) {
      for (const turn of run.turns.slice(1)) {
        const prefix = (turn.firstRequestCacheCreateTokens || 0) + (turn.firstRequestCacheReadTokens || 0);
        const pb = computeNextPromptPlaybook({
          modelId: turn.scheduledModel,
          effort: turn.scheduledEffort,
          cachedTokens: prefix,
          totalTokens: prefix + turn.inputTokens,
          cacheWarm: true,
          cacheTtlTier: '5m',
          ttlRemainingSec: 240,
          host: 'claude'
        });
        if (run.arm === 'LEGACY_46_EFFORT_CHECK') {
          assert.equal(pb.regime, PLAYBOOK_REGIMES.WARM_EFFORT_UNSAFE);
        } else {
          assert.equal(pb.regime, PLAYBOOK_REGIMES.WARM_EFFORT_SAFE);
          assert.equal(pb.optionalDetourNote, null);
        }
      }
    }
  });
});
