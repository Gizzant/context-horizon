/**
 * @file test/challenger_m3_2_adversarial.test.mjs
 * Empirical Adversarial Stress Test Suite for Milestone 3 Cost Radar & Economics Engine.
 *
 * Authored by: Milestone 3 Adversarial Challenger 2
 * Evaluates:
 *   1. retentionRadar.mjs (multibyte UTF-8 boundaries, divergence offsets, 95% threshold precision)
 *   2. dualTtl.mjs & billingBlocks.mjs (clock skew, zero/negative/massive elapsed, rolling modulo, malformed events)
 *   3. costRadarSvg.mjs & brailleSparkline.mjs (XSS injection, XML validity under JSDOM, 0/1/1000-point sparklines)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  verifyRetentionRadarDiff,
  findPrefixMutationOffset,
  classifyBustCause,
  createInitialPrefixRetention,
  computePrefixRetention,
  RetentionRadar,
  PREFIX_RETENTION_THRESHOLDS
} from '../src/core-isomorphic/economics/retentionRadar.mjs';

import {
  calculateDualTtlCountdown,
  evaluatePauseDistribution,
  DualTtlTracker,
  formatMmSs,
  formatRemainingTtl,
  DUAL_TTL_CONSTANTS
} from '../src/core-isomorphic/economics/dualTtl.mjs';

import {
  partitionBillingBlocks,
  attributeSubagentCosts,
  computeBillingBlockSummary,
  RollingBillingBlockTracker,
  BILLING_BLOCK_CONSTANTS
} from '../src/core-isomorphic/economics/billingBlocks.mjs';

import {
  escapeXml,
  renderRetentionStepChart,
  renderDriftSparkline,
  renderTopologyGraph,
  renderCostRadarHtml
} from '../src/core-isomorphic/ui/costRadarSvg.mjs';

import {
  buildTurnVelocitySparkline,
  renderBlockSparkline,
  buildBrailleSparkline,
  renderBrailleSparkline,
  formatSparklineSummary,
  BLOCK_SPARK_GLYPHS
} from '../src/core-isomorphic/ui/brailleSparkline.mjs';

// XML Parser helper using JSDOM
function parseSvgXml(svgString) {
  const dom = new JSDOM();
  const parser = new dom.window.DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const parserError = doc.querySelector('parsererror');
  return { doc, parserError, hasError: parserError !== null };
}

// ============================================================================
// PART 1: Stress Testing retentionRadar.mjs
// ============================================================================
describe('Challenger M3-2 Stress: retentionRadar.mjs', () => {

  describe('1. Multibyte UTF-8 Boundaries & Astral Plane Characters', () => {
    it('accurately pinpoints byte diff offset on multi-byte UTF-8 boundaries (ASCII -> 2-byte -> 3-byte -> 4-byte)', () => {
      // 1-byte: 'A' (0x41)
      // 2-byte: 'é' (0xC3, 0xA9)
      // 3-byte: '中' (0xE4, 0xB8, 0xAD)
      // 4-byte: '🚀' (0xF0, 0x9F, 0x9A, 0x80)
      const base = 'Aé中🚀';
      const encoder = new TextEncoder();
      const baseBytes = encoder.encode(base);
      assert.equal(baseBytes.length, 1 + 2 + 3 + 4); // 10 bytes

      // Mutate 4th character (the 4-byte emoji) to another 4-byte emoji '🛸' (0xF0, 0x9F, 0x9B, 0xB8)
      // First 3 characters take 1 + 2 + 3 = 6 bytes.
      // Byte 6 is 0xF0 (both have it).
      // Byte 7 is 0x9F (both have it).
      // Byte 8 is 0x9A vs 0x9B -> first diff at byte index 8!
      const mutatedMidEmoji = 'Aé中🛸';
      const diffEmoji = verifyRetentionRadarDiff(base, mutatedMidEmoji);
      assert.equal(diffEmoji.firstDiffOffset, 8);
      assert.equal(diffEmoji.prefixMatchBytes, 8);
      assert.equal(diffEmoji.retentionPct, 80.0); // 8 / 10 = 80.0%
      assert.equal(diffEmoji.grade, 'B');
    });

    it('handles Asian characters (CJK, Devanagari) and zero-width joiners/spaces', () => {
      const cjkOrig = '模型指令：深度思考模式已启用。\n规则一：严禁越权访问。';
      // Mutate one CJK character in the middle
      const cjkMut = '模型指令：深度思考模式已启用。\n规则二：严禁越权访问。';

      const diff = verifyRetentionRadarDiff(cjkOrig, cjkMut);
      // In UTF-8:
      // '一' is E4 B8 80 (3 bytes)
      // '二' is E4 BA 8C (3 bytes)
      // Notice both share the first byte 0xE4!
      // So byte 52 is identical (0xE4), and the first diff is at byte 53 (0xB8 vs 0xBA).
      assert.equal(diff.firstDiffOffset, 53);
      assert.ok(diff.retentionPct > 50);

      // Zero-width characters: ZWJ (U+200D), ZWNJ (U+200C), ZWSP (U+200B)
      const zwOrig = 'Prefix\u200DContext\u200BData';
      const zwMut = 'Prefix\u200CContext\u200BData';
      const zwDiff = verifyRetentionRadarDiff(zwOrig, zwMut);
      // 'Prefix' = 6 bytes, \u200D is 3 bytes (E2 80 8D), \u200C is 3 bytes (E2 80 8C)
      // Byte 6 is E2, Byte 7 is 80, Byte 8 is 8D vs 8C
      assert.equal(zwDiff.firstDiffOffset, 8);
    });

    it('handles complex emoji ZWJ family sequences', () => {
      // 👨‍👩‍👧‍👦 = Man + ZWJ + Woman + ZWJ + Girl + ZWJ + Boy (25 bytes UTF-8)
      const family1 = 'Team: 👨‍👩‍👧‍👦 coordinator';
      const family2 = 'Team: 👨‍👩‍👧 coordinator'; // missing boy at end of ZWJ sequence
      const diff = verifyRetentionRadarDiff(family1, family2);
      assert.ok(diff.firstDiffOffset > 6);
      assert.ok(diff.prefixMatchBytes > 6);
    });
  });

  describe('2. Byte-Level Divergence Positions & Length Mismatches', () => {
    it('divergence at exact index 0 (completely different first byte)', () => {
      const diff = verifyRetentionRadarDiff('Hello world', 'Jello world');
      assert.equal(diff.firstDiffOffset, 0);
      assert.equal(diff.prefixMatchBytes, 0);
      assert.equal(diff.retentionPct, 0);
      assert.equal(diff.is95PctRetained, false);
      assert.equal(diff.grade, 'C');
    });

    it('divergence at exact end of string (last byte differing)', () => {
      const orig = 'System prompt instructions version 1';
      const mut = 'System prompt instructions version 2';
      const diff = verifyRetentionRadarDiff(orig, mut);
      assert.equal(diff.firstDiffOffset, orig.length - 1);
      assert.equal(diff.prefixMatchBytes, orig.length - 1);
      assert.ok(diff.retentionPct >= 95.0);
      assert.equal(diff.is95PctRetained, true);
      assert.equal(diff.grade, 'A');
    });

    it('length mismatch: mutated is strict prefix of original (truncation)', () => {
      const orig = 'Long original prompt text';
      const mut = 'Long original';
      const diff = verifyRetentionRadarDiff(orig, mut);
      assert.equal(diff.firstDiffOffset, mut.length);
      assert.equal(diff.prefixMatchBytes, mut.length);
      assert.equal(diff.retentionPct, parseFloat(((mut.length / orig.length) * 100).toFixed(2)));
    });

    it('length mismatch: mutated extends original (original is strict prefix of mutated)', () => {
      const orig = 'Base prompt';
      const mut = 'Base prompt with additional user turn';
      const diff = verifyRetentionRadarDiff(orig, mut);
      assert.equal(diff.firstDiffOffset, orig.length);
      assert.equal(diff.prefixMatchBytes, orig.length);
      assert.equal(diff.retentionPct, 100);
      assert.equal(diff.is95PctRetained, true);
      assert.equal(diff.grade, 'A');
    });

    it('handles null, undefined, numbers, and empty strings gracefully without crashing', () => {
      assert.equal(verifyRetentionRadarDiff(null, null).retentionPct, 100);
      assert.equal(verifyRetentionRadarDiff(undefined, undefined).retentionPct, 100);
      assert.equal(verifyRetentionRadarDiff('', 'test').firstDiffOffset, 0);
      assert.equal(verifyRetentionRadarDiff('test', '').firstDiffOffset, 0);
      assert.equal(verifyRetentionRadarDiff(12345, 12345).firstDiffOffset, -1);
    });
  });

  describe('3. Precision Threshold Testing around 95.0%, 80.0%, and 50.0%', () => {
    it('rigorously checks 94.99% vs 95.00% vs 95.01% boundary', () => {
      // Create a 10,000-byte string
      const base = 'X'.repeat(10000);

      // 9,499 matching bytes -> 94.99%
      const mut9499 = 'X'.repeat(9499) + 'Y'.repeat(501);
      const diff9499 = verifyRetentionRadarDiff(base, mut9499);
      assert.equal(diff9499.retentionPct, 94.99);
      assert.equal(diff9499.is95PctRetained, false);
      assert.equal(diff9499.grade, 'B');

      // 9,500 matching bytes -> 95.00%
      const mut9500 = 'X'.repeat(9500) + 'Y'.repeat(500);
      const diff9500 = verifyRetentionRadarDiff(base, mut9500);
      assert.equal(diff9500.retentionPct, 95.00);
      assert.equal(diff9500.is95PctRetained, true);
      assert.equal(diff9500.grade, 'A');

      // 9,501 matching bytes -> 95.01%
      const mut9501 = 'X'.repeat(9501) + 'Y'.repeat(499);
      const diff9501 = verifyRetentionRadarDiff(base, mut9501);
      assert.equal(diff9501.retentionPct, 95.01);
      assert.equal(diff9501.is95PctRetained, true);
      assert.equal(diff9501.grade, 'A');
    });

    it('rigorously checks 79.99% vs 80.00% Grade B/C boundary', () => {
      const base = 'X'.repeat(10000);

      // 7,999 matching -> 79.99%
      const mut7999 = 'X'.repeat(7999) + 'Y'.repeat(2001);
      const diff7999 = verifyRetentionRadarDiff(base, mut7999);
      assert.equal(diff7999.retentionPct, 79.99);
      assert.equal(diff7999.grade, 'C');

      // 8,000 matching -> 80.00%
      const mut8000 = 'X'.repeat(8000) + 'Y'.repeat(2000);
      const diff8000 = verifyRetentionRadarDiff(base, mut8000);
      assert.equal(diff8000.retentionPct, 80.00);
      assert.equal(diff8000.grade, 'B');
    });

    it('rigorously checks multi-turn bust threshold at exactly 50.0%', () => {
      // BUST_RATIO is 0.50.
      // If retained / eligible < 0.50 -> bust = true. If >= 0.50 -> bust = false.
      const turnBust = [{ eligibleTokens: 1000, retainedTokens: 499 }];
      const resBust = computePrefixRetention(turnBust);
      assert.equal(resBust.bustCount, 1);
      assert.equal(resBust.series[0].bust, true);

      const turnSafe = [{ eligibleTokens: 1000, retainedTokens: 500 }];
      const resSafe = computePrefixRetention(turnSafe);
      assert.equal(resSafe.bustCount, 0);
      assert.equal(resSafe.series[0].bust, false);
    });
  });
});

// ============================================================================
// PART 2: Stress Testing dualTtl.mjs & billingBlocks.mjs
// ============================================================================
describe('Challenger M3-2 Stress: dualTtl.mjs & billingBlocks.mjs', () => {

  describe('1. Dual-TTL Clocks, Skew & Massive Elapsed', () => {
    it('handles clock skew (now < lastTurnTimestamp) by clamping elapsed to 0', () => {
      const t0 = 5000000;
      const skewedNow = t0 - 60000; // 60 seconds in the past!
      const res = calculateDualTtlCountdown(t0, skewedNow);

      assert.equal(res.cacheTtlSec, 300);
      assert.equal(res.billingTtlSec, 3600);
      assert.equal(res.formattedCacheTtl, '05:00');
      assert.equal(res.formattedBillingTtl, '60:00');
      assert.equal(res.isCacheExpired, false);
      assert.equal(res.isBillingExpired, false);
    });

    it('handles zero elapsed time (now === lastTurnTimestamp)', () => {
      const t0 = 1000000;
      const res = calculateDualTtlCountdown(t0, t0);
      assert.equal(res.cacheTtlSec, 300);
      assert.equal(res.billingTtlSec, 3600);
      assert.equal(res.formattedCacheTtl, '05:00');
      assert.equal(res.formattedBillingTtl, '60:00');
    });

    it('handles negative timestamps (lastTurnTimestamp < 0, now < 0)', () => {
      const res = calculateDualTtlCountdown(-100000, -40000); // 60s elapsed
      assert.equal(res.cacheTtlSec, 240);
      assert.equal(res.billingTtlSec, 3540);
      assert.equal(res.formattedCacheTtl, '04:00');
    });

    it('handles massive elapsed time (100 hours = 360,000,000 ms)', () => {
      const t0 = 1000000;
      const now = t0 + 360000000; // 100 hours

      // Non-rolling
      const nonRolling = calculateDualTtlCountdown(t0, now);
      assert.equal(nonRolling.cacheTtlSec, 0);
      assert.equal(nonRolling.billingTtlSec, 0);
      assert.equal(nonRolling.formattedCacheTtl, '00:00');
      assert.equal(nonRolling.formattedBillingTtl, '00:00');
      assert.equal(nonRolling.isCacheExpired, true);
      assert.equal(nonRolling.isBillingExpired, true);

      // Rolling
      const rolling = calculateDualTtlCountdown(t0, now, 300000, 3600000, { rolling: true });
      assert.equal(rolling.cacheTtlSec, 0);
      assert.equal(rolling.billingTtlSec, 0); // 100h % 1h === 0
      assert.equal(rolling.formattedBillingTtl, '00:00');
      assert.equal(rolling.isBillingExpired, true);
    });

    it('handles exact 3,600,000 ms rolling modulo edge cases', () => {
      const t0 = 1000000;

      // Exactly 3,599,999 ms (1ms before 1-hour block completion)
      const resBefore = calculateDualTtlCountdown(t0, t0 + 3599999, 300000, 3600000, { rolling: true });
      assert.equal(resBefore.billingTtlSec, 0); // Math.floor(1ms / 1000) = 0
      assert.equal(resBefore.formattedBillingTtl, '00:00');
      assert.equal(resBefore.isBillingExpired, false);

      // Exactly 3,600,000 ms (exactly 1-hour boundary)
      const resExact = calculateDualTtlCountdown(t0, t0 + 3600000, 300000, 3600000, { rolling: true });
      assert.equal(resExact.billingTtlSec, 0);
      assert.equal(resExact.formattedBillingTtl, '00:00');
      assert.equal(resExact.isBillingExpired, true);

      // Exactly 3,600,001 ms (1ms into the 2nd rolling block)
      const resAfter = calculateDualTtlCountdown(t0, t0 + 3600001, 300000, 3600000, { rolling: true });
      assert.equal(resAfter.billingTtlSec, 3599); // 3599s remaining
      assert.equal(resAfter.formattedBillingTtl, '59:59');
      assert.equal(resAfter.isBillingExpired, true);

      // Exactly 7,200,000 ms (exactly 2-hour boundary)
      const resExact2 = calculateDualTtlCountdown(t0, t0 + 7200000, 300000, 3600000, { rolling: true });
      assert.equal(resExact2.billingTtlSec, 0);
      assert.equal(resExact2.formattedBillingTtl, '00:00');
      assert.equal(resExact2.isBillingExpired, true);
    });

    it('evaluatePauseDistribution handles adversarial inputs and 3.1% boundary', () => {
      // Empty and non-array
      assert.equal(evaluatePauseDistribution([]).totalIntervals, 0);
      assert.equal(evaluatePauseDistribution(null).totalIntervals, 0);
      assert.equal(evaluatePauseDistribution('string').totalIntervals, 0);

      // Array with NaN, negative, Infinity
      const messy = [NaN, -50, Infinity, 'invalid', 400];
      const messyRes = evaluatePauseDistribution(messy);
      assert.equal(messyRes.totalIntervals, 1); // only 400 is valid
      assert.equal(messyRes.fiveToSixtyMinCount, 1);
      assert.equal(messyRes.recommend1hTierUpgrade, true);

      // Boundary: 30 / 1000 = 3.00% (< 3.10%) vs 31 / 1000 = 3.10% (>= 3.10%)
      const belowPauses = [...Array(30).fill(400), ...Array(970).fill(60)];
      const resBelow = evaluatePauseDistribution(belowPauses);
      assert.equal(resBelow.recommend1hTierUpgrade, false);

      const exactPauses = [...Array(31).fill(400), ...Array(969).fill(60)];
      const resExact = evaluatePauseDistribution(exactPauses);
      assert.equal(resExact.recommend1hTierUpgrade, true);
    });
  });

  describe('2. Billing Blocks & Subagent Attribution Malformed Inputs', () => {
    it('handles empty event streams gracefully', () => {
      assert.deepEqual(partitionBillingBlocks([]), []);
      assert.deepEqual(partitionBillingBlocks(null), []);
      assert.deepEqual(partitionBillingBlocks(undefined), []);
      assert.deepEqual(attributeSubagentCosts([]), {});
      assert.deepEqual(attributeSubagentCosts(null), {});
    });

    it('handles events missing subagentId, defaulting to "main"', () => {
      const events = [
        { timestamp: 1000, costUsd: 1.5, tokens: 5000 }, // missing subagentId
        { timestamp: 2000, costUsd: 2.0, tokens: 6000, subagentId: null },
        { timestamp: 3000, costUsd: 0.5, tokens: 1000, subagentId: '' }
      ];
      const blocks = partitionBillingBlocks(events);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].subagentSpend.main, 4.0);

      const attrib = attributeSubagentCosts(events);
      assert.equal(attrib.main.costUsd, 4.0);
      assert.equal(attrib.main.tokens, 12000);
      assert.equal(attrib.main.pct, 100.0);
    });

    it('handles negative, string, and zero costs/tokens without NaN contamination', () => {
      const events = [
        { timestamp: 1000, costUsd: -5.0, tokens: -200, subagentId: 'worker-1' },
        { timestamp: 2000, costUsd: 0, tokens: 0, subagentId: 'worker-1' },
        { timestamp: 3000, costUsd: '3.50', tokens: '10000', subagentId: 'worker-2' }
      ];
      const blocks = partitionBillingBlocks(events);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].totalCostUsd, 3.5);
      assert.equal(blocks[0].totalTokens, 10000);
      assert.equal(blocks[0].subagentSpend['worker-1'], 0);
      assert.equal(blocks[0].subagentSpend['worker-2'], 3.5);
    });

    it('partitions events spanning 100 hours (20 blocks)', () => {
      const fiveHoursMs = 5 * 3600 * 1000;
      const events = [];
      for (let i = 0; i < 20; i++) {
        events.push({
          timestamp: 1000000 + (i * fiveHoursMs) + 500,
          costUsd: 1.0,
          tokens: 5000,
          subagentId: `sub-${i}`
        });
      }
      const blocks = partitionBillingBlocks(events);
      assert.equal(blocks.length, 20);
      for (let i = 0; i < 20; i++) {
        assert.equal(blocks[i].blockIndex, i);
        assert.equal(blocks[i].totalCostUsd, 1.0);
      }

      const summary = computeBillingBlockSummary(blocks);
      assert.equal(summary.blockCount, 20);
      assert.equal(summary.cumulativeCostUsd, 20.0);
      assert.equal(summary.cumulativeTokens, 100000);
    });
  });
});

// ============================================================================
// PART 3: Stress Testing costRadarSvg.mjs & brailleSparkline.mjs
// ============================================================================
describe('Challenger M3-2 Stress: costRadarSvg.mjs & brailleSparkline.mjs', () => {

  describe('1. XSS Injection & Sanitization in SVG / HTML', () => {
    it('sanitizes adversarial XSS payloads in sessionTitle, model, and edition', () => {
      const maliciousMeta = {
        sessionTitle: '<script>alert("xss-title")</script>',
        model: '"><img src=x onerror=alert(1)>',
        edition: '<iframe src="javascript:alert(1)"></iframe>',
        generatedAt: '2026-11-11"><script>alert(2)</script>'
      };

      const html = renderCostRadarHtml({ meta: maliciousMeta });

      // Must NOT contain unescaped script tags
      assert.ok(!html.includes('<script>alert("xss-title")</script>'));
      assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
      assert.ok(!html.includes('<iframe'));

      // Must contain properly escaped entities
      assert.ok(html.includes('&lt;script&gt;alert(&quot;xss-title&quot;)&lt;/script&gt;'));
      assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
    });

    it('sanitizes adversarial XSS payloads in swarm topology workers and worktrees', () => {
      const maliciousTopology = {
        workers: [
          { name: '<script>alert("worker")</script>', state: 'working', model: '"><b onmouseover=alert(1)>', workspace: 'repo' }
        ],
        worktrees: [
          { name: '<svg onload=alert(1)>', branch: 'feat/<script>', path: 'C:/<img onerror=alert(1)>' }
        ],
        scopeLocks: {
          collisions: [
            { trajectories: ['traj<script>'], overlappingPaths: ['path<script>'] }
          ]
        }
      };

      const svg = renderTopologyGraph(maliciousTopology);
      assert.ok(!svg.includes('<script>'));
      assert.ok(!svg.includes('onload=alert'));
      assert.ok(!svg.includes('<img onerror'));

      // Validate SVG XML via JSDOM
      const { hasError, parserError } = parseSvgXml(svg);
      assert.equal(hasError, false, parserError ? parserError.textContent : '');
    });

    it('sanitizes malicious bust causes and drift labels in panels 1 and 2', () => {
      const retentionData = {
        measured: true,
        measuredTurns: 2,
        bustCount: 1,
        ttlExpiredTurns: 0,
        retentionIndexPct: 85,
        grade: 'B',
        retainedDiscountSavingsUSD: 0.12,
        leakedColdPrefillUSD: 0.05,
        series: [
          { pct: 100, bust: false, cause: 'none', ttlExpired: false },
          { pct: 45, bust: true, cause: '<script>alert("bust")</script>', ttlExpired: false }
        ]
      };

      const p1Svg = renderRetentionStepChart(retentionData);
      assert.ok(!p1Svg.includes('<script>alert("bust")</script>'));
      assert.ok(p1Svg.includes('&lt;script&gt;alert(&quot;bust&quot;)&lt;/script&gt;'));

      const { hasError: p1Error } = parseSvgXml(p1Svg);
      assert.equal(p1Error, false);

      const driftData = {
        measured: true,
        turns: [
          { driftRatio: 15, ttftMs: 1200, driftState: 'loop_suspect', thinkingTokens: 4500, mutatingCalls: 0 }
        ],
        loop: {
          triggered: true,
          severity: '<script>alert("loop")</script>',
          consecutiveLoopTurns: 2
        }
      };

      const p2Svg = renderDriftSparkline(driftData);
      assert.ok(!p2Svg.includes('<script>'));
      const { hasError: p2Error } = parseSvgXml(p2Svg);
      assert.equal(p2Error, false);
    });
  });

  describe('2. SVG XML Well-Formedness Under Adversarial Edge Cases', () => {
    it('produces valid XML for empty panels', () => {
      const emptyP1 = renderRetentionStepChart(null);
      assert.equal(parseSvgXml(emptyP1).hasError, false);

      const emptyP2 = renderDriftSparkline(null);
      assert.equal(parseSvgXml(emptyP2).hasError, false);

      const emptyP3 = renderTopologyGraph(null);
      assert.equal(parseSvgXml(emptyP3).hasError, false);
    });

    it('produces valid XML with 100 consecutive turns in step chart', () => {
      const series = [];
      for (let i = 0; i < 100; i++) {
        series.push({
          pct: (i % 2 === 0) ? 96 : 40,
          bust: i % 2 !== 0,
          cause: 'rule_mutation',
          ttlExpired: i === 50,
          savedUSD: 0.01,
          leakedUSD: 0.02
        });
      }
      const data = {
        measured: true,
        measuredTurns: 100,
        bustCount: 50,
        ttlExpiredTurns: 1,
        retentionIndexPct: 75.5,
        grade: 'C',
        series
      };

      const svg = renderRetentionStepChart(data);
      const { hasError, parserError } = parseSvgXml(svg);
      assert.equal(hasError, false, parserError ? parserError.textContent : '');
    });

    it('produces valid XML with 100 turns in drift sparkline with extreme TTFT and ratios', () => {
      const turns = [];
      for (let i = 0; i < 100; i++) {
        turns.push({
          driftRatio: i * 2,
          ttftMs: i === 99 ? 60000 : 800,
          driftState: i > 80 ? 'loop_suspect' : 'normal',
          thinkingTokens: 5000,
          mutatingCalls: 0
        });
      }
      const drift = {
        measured: true,
        turns,
        loop: { triggered: true, severity: 'warn', consecutiveLoopTurns: 20 }
      };

      const svg = renderDriftSparkline(drift);
      const { hasError, parserError } = parseSvgXml(svg);
      assert.equal(hasError, false, parserError ? parserError.textContent : '');
    });
  });

  describe('3. Sparkline Boundary & Scale Testing (0, 1, 1000 points)', () => {
    it('handles zero-point input arrays gracefully', () => {
      assert.equal(buildBrailleSparkline([]), '');
      assert.equal(buildBrailleSparkline(null), '');
      assert.equal(buildTurnVelocitySparkline([]), '');
      assert.equal(formatSparklineSummary([]), '—');
    });

    it('handles single-point input arrays gracefully', () => {
      const braille1 = buildBrailleSparkline([42]);
      assert.ok(braille1.length > 0);
      assert.equal(formatSparklineSummary([42]), `42 ${braille1} 42`);

      const block1 = buildTurnVelocitySparkline([100]);
      assert.equal(block1, BLOCK_SPARK_GLYPHS[BLOCK_SPARK_GLYPHS.length - 1]);
    });

    it('handles 1,000-point inputs with responsive terminal widths (40, 80, 110, 144 cols)', () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 100 + 100);

      const spark40 = buildBrailleSparkline(largeArray, { columns: 40 });
      assert.equal(spark40.length, 10); // 40 / 4 = 10 chars

      const spark80 = buildBrailleSparkline(largeArray, { columns: 80 });
      assert.equal(spark80.length, 20); // 80 / 4 = 20 chars

      const spark110 = buildBrailleSparkline(largeArray, { columns: 110 });
      assert.equal(spark110.length, 27); // Math.floor(110 / 4) = 27 chars

      const spark144 = buildBrailleSparkline(largeArray, { columns: 144 });
      assert.equal(spark144.length, 36); // Math.floor(144 / 4) = 36 chars

      // Verify all emitted characters are in Unicode Braille range U+2800..U+28FF
      for (const ch of spark144) {
        const code = ch.charCodeAt(0);
        assert.ok(code >= 0x2800 && code <= 0x28FF, `Character ${ch} (${code.toString(16)}) outside Braille range`);
      }
    });

    it('handles identical flat values, negative values, and NaN/Infinity', () => {
      // All identical values
      const flat = [10, 10, 10, 10];
      const flatSpark = buildBrailleSparkline(flat);
      assert.equal(flatSpark.length, 2); // 4 points -> 2 braille chars

      // Negative values
      const neg = [-100, -50, -20, 0];
      const negSpark = buildBrailleSparkline(neg);
      assert.equal(negSpark.length, 2);

      // NaN and Infinity
      const messy = [NaN, 10, Infinity, -Infinity, 50];
      const messySpark = buildBrailleSparkline(messy);
      assert.ok(messySpark.length > 0);
    });
  });
});

// ============================================================================
// PART 4: Empirical Vulnerability & Edge Case Demonstrations
// ============================================================================
describe('Challenger M3-2 Empirical Vulnerabilities & Findings', () => {
  it('FINDING 1 RESOLVED: findPrefixMutationOffset accurately aligns UTF-8 byte offset with UTF-16 code units', () => {
    // 20 emojis = 80 bytes in UTF-8, but only 40 UTF-16 code units in JS
    const orig = '🤖'.repeat(20) + 'line1\nline2: alpha';
    const mut = '🤖'.repeat(20) + 'line1\nline2: beta';

    const res = findPrefixMutationOffset(orig, mut);
    // firstDiffOffset is a UTF-8 byte offset (93 bytes)
    assert.equal(res.firstDiffOffset, 93);

    // Converted to UTF-16 code units (53), line and column are accurately computed
    assert.equal(res.line, 2);
    assert.equal(res.column, 8);
    // Snippet captures the mutation context instead of returning an empty string
    assert.equal(res.snippet, '🤖line1\nline2: beta');
  });

  it('FINDING 2 RESOLVED: XSS script tag injection in SVG prevented via strict numeric coercion and escaping', () => {
    // In renderRetentionStepChart: measuredTurns is coerced to safe integer
    const xssPayload = '</text><script>window.__xss=1;</script><text>';
    const svg = renderRetentionStepChart({
      measured: true,
      series: [{ pct: 95 }],
      measuredTurns: xssPayload,
      bustCount: 0,
      ttlExpiredTurns: 0
    });

    // Zero unescaped <script> tags present in the SVG markup
    assert.equal(svg.includes('<script>'), false);
    assert.equal(svg.includes('NaN'), false);

    // In renderDriftSparkline: mutatingCalls is coerced to safe integer
    const xssDrift = renderDriftSparkline({
      measured: true,
      turns: [{
        driftRatio: 15,
        ttftMs: 500,
        driftState: 'loop_suspect',
        thinkingTokens: 5000,
        mutatingCalls: '</title><script>window.__xss2=1;</script><title>'
      }],
      loop: { triggered: true }
    });
    assert.equal(xssDrift.includes('<script>'), false);
    assert.equal(xssDrift.includes('NaN'), false);

    // HTML wrapper handles meta: null without crash and zero script tags
    const html = renderCostRadarHtml({
      retention: { measured: true, measuredTurns: xssPayload, series: [] },
      meta: null
    });
    assert.equal(html.includes('<script>'), false);
  });

  it('FINDING 3 RESOLVED: partitionBillingBlocks handles null elements gracefully and sanitizes non-numeric strings to 0', () => {
    // 1. Crash on null element resolved -> returns empty array/object cleanly
    assert.deepEqual(partitionBillingBlocks([null]), []);
    assert.deepEqual(attributeSubagentCosts([null]), {});
    assert.deepEqual(computeBillingBlockSummary([null]), {
      blockCount: 0,
      cumulativeCostUsd: 0,
      cumulativeTokens: 0,
      maxBurnRateUsdPerHour: 0,
      avgTokensPerMin: 0
    });

    // 2. NaN contamination resolved -> non-numeric strings safely coerced to 0
    const blocks = partitionBillingBlocks([
      { timestamp: 1000, costUsd: 'unparsed_string', tokens: 'invalid_tokens' }
    ]);
    assert.strictEqual(blocks[0].totalCostUsd, 0);
    assert.strictEqual(blocks[0].totalTokens, 0);
    assert.strictEqual(blocks[0].burnRateUsdPerHour, 0);
    assert.strictEqual(blocks[0].tokensPerMin, 0);
    assert.strictEqual(blocks[0].subagentSpend.main, 0);
  });
});

