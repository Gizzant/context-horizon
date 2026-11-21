import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_EFFORT_CACHE_CAPABILITIES,
  evaluatePreModelSwitch,
  getEffortMutationCacheCapability
} from '../src/core-isomorphic/coach/cacheGravityRouter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLAYBOOK_RESULTS_PATH = path.join(
  ROOT,
  'experiments',
  'model-switch-benchmark',
  'results',
  'playbook_ab_results.json'
);

describe('Playbook Guard Replay & Measured Effort-Cache Capabilities', () => {
  it('verifies measured 5.5 vs 4.6 capabilities and leaves Gemini strictly unverified', () => {
    assert.equal(MODEL_EFFORT_CACHE_CAPABILITIES['claude-sonnet-5-5'].invalidatesCache, 'no');
    assert.equal(MODEL_EFFORT_CACHE_CAPABILITIES['claude-opus-5-5'].invalidatesCache, 'no');
    assert.match(MODEL_EFFORT_CACHE_CAPABILITIES['claude-opus-5-5'].status, /measured.*behaviour/i);

    assert.equal(MODEL_EFFORT_CACHE_CAPABILITIES['claude-sonnet-4-6'].invalidatesCache, 'yes');
    assert.equal(MODEL_EFFORT_CACHE_CAPABILITIES['claude-opus-4-6'].invalidatesCache, 'yes');

    for (const gm of ['gemini-4-neon', 'gemini-4-argon', 'gemini-2.5-pro']) {
      const cap = getEffortMutationCacheCapability(gm);
      assert.equal(cap.invalidatesCache, 'unknown', `${gm} must stay unverified`);
      assert.equal(cap.status, 'unverified for this model');
    }
  });

  it('replays all recorded model switches from the 36-session A/B dataset through DET-08 + round-trip TTL guard', () => {
    assert.ok(fs.existsSync(PLAYBOOK_RESULTS_PATH), `Missing dataset at ${PLAYBOOK_RESULTS_PATH}`);
    const data = JSON.parse(fs.readFileSync(PLAYBOOK_RESULTS_PATH, 'utf8'));
    const core = (data.runs || []).filter(
      (r) => (r.suite === 'A1_OPUS' || r.suite === 'A2_SONNET') && r.status === 'ok'
    );
    assert.equal(core.length, 36, 'Expected 36 core recorded runs in playbook_ab_results.json');

    let opusT2Count = 0;
    let opusT2Hold = 0;
    let sonnetHaikuT2Count = 0;
    let sonnetHaikuT2OneWayAllow = 0;
    let sonnetHaikuT2RoundTrip5mHold = 0;
    let sonnetHaikuT2RoundTrip1hAllow = 0;

    for (const run of core) {
      for (let i = 1; i < run.turns.length; i += 1) {
        const prev = run.turns[i - 1];
        const curr = run.turns[i];
        if (prev.scheduledModel === curr.scheduledModel) continue;

        const cachedTokens =
          (curr.firstRequestCacheCreateTokens || 0) + (curr.firstRequestCacheReadTokens || 0);
        const remTurns = run.turns.length - i;

        const resRem = evaluatePreModelSwitch({
          currentModel: prev.scheduledModel,
          targetModel: curr.scheduledModel,
          cachedTokens,
          uncachedDeltaTokens: 500,
          expectedOutputTokens: curr.outputTokens,
          expectedRemainingTurns: remTurns,
          cacheWarm: true,
          cacheTtlTier: '5m'
        });

        if (run.arm === 'OPUS_NAIVE_SWITCH' && curr.turn === 2) {
          opusT2Count += 1;
          if (resRem.breakEven.shouldHold) opusT2Hold += 1;
        }

        if (run.arm === 'SONNET_NAIVE_HAIKU' && curr.turn === 2) {
          sonnetHaikuT2Count += 1;
          if (!resRem.breakEven.shouldHold) sonnetHaikuT2OneWayAllow += 1;

          const rt5m = evaluatePreModelSwitch({
            currentModel: prev.scheduledModel,
            targetModel: curr.scheduledModel,
            cachedTokens,
            uncachedDeltaTokens: 500,
            expectedOutputTokens: curr.outputTokens,
            expectedRemainingTurns: 1,
            cacheWarm: true,
            cacheTtlTier: '5m',
            isRoundTripDetour: true
          });
          if (rt5m.breakEven.shouldHold && rt5m.breakEven.roundTripDetour?.triggeredHold) {
            sonnetHaikuT2RoundTrip5mHold += 1;
            assert.equal(rt5m.advisory, true);
            assert.match(rt5m.reason, /DET-08 5m Round-Trip TTL Guard/);
            assert.equal(rt5m.recommendedModel, 'claude-sonnet-5-5');
          }

          const rt1h = evaluatePreModelSwitch({
            currentModel: prev.scheduledModel,
            targetModel: curr.scheduledModel,
            cachedTokens,
            uncachedDeltaTokens: 500,
            expectedOutputTokens: curr.outputTokens,
            expectedRemainingTurns: 1,
            cacheWarm: true,
            cacheTtlTier: '1h',
            isRoundTripDetour: true
          });
          if (!rt1h.breakEven.shouldHold && rt1h.breakEven.roundTripDetour?.ttlTierSafeForDetour) {
            sonnetHaikuT2RoundTrip1hAllow += 1;
          }
        }
      }
    }

    assert.equal(opusT2Count, 6);
    assert.equal(opusT2Hold, 6, 'Opus -> Sonnet T2 quick bust must HOLD 6/6');
    assert.equal(sonnetHaikuT2Count, 6);
    assert.equal(sonnetHaikuT2OneWayAllow, 6, 'Legacy one-way Sonnet -> Haiku math preserves backward compat 6/6');
    assert.equal(sonnetHaikuT2RoundTrip5mHold, 6, 'Round-trip 5m Sonnet -> Haiku detour must HOLD 6/6');
    assert.equal(sonnetHaikuT2RoundTrip1hAllow, 6, 'Round-trip 1h Sonnet -> Haiku detour must ALLOW 6/6');
  });
});
