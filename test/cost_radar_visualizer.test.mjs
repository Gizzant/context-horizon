/**
 * @file test/cost_radar_visualizer.test.mjs
 * Unit and integration test suite for Attention Horizon v4.0 Cost Radar Visualizers.
 *
 * Covers:
 *   - Feature 23: Retention Step-Chart SVG, Drift Sparklines & Braille/Block Sparklines
 *   - Zero `<script>` XSS security guarantee
 *   - High data-ink ratio (Tufte style) tabular figures
 *   - 95% prefix retention discount threshold guide line
 *   - Canonical DET-30 scratchpad loop annotations
 *   - Unicode Braille pattern sparklines (U+2800..U+28FF)
 *   - Unicode Block sparklines (\u2581..\u2588)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderRetentionStepChart,
  renderDriftSparkline,
  renderTopologyGraph,
  renderCostRadarHtml,
  escapeXml,
  COST_RADAR_DIMENSIONS
} from '../src/core-isomorphic/ui/costRadarSvg.mjs';

import {
  buildTurnVelocitySparkline,
  renderBlockSparkline,
  buildBrailleSparkline,
  renderBrailleSparkline,
  formatSparklineSummary,
  BLOCK_SPARK_GLYPHS
} from '../src/core-isomorphic/ui/brailleSparkline.mjs';

// Backward compatibility adapter tests
import * as uiAdapter from '../src/ui/costRadarSvg.mjs';

describe('Cost Radar Visualizer: Feature 23 — SVG & Braille Sparklines', () => {
  it('renders valid XML SVG retention step chart with 95% guideline and accessible attributes', () => {
    const retention = {
      measured: true,
      measuredTurns: 4,
      bustCount: 1,
      ttlExpiredTurns: 0,
      retentionIndexPct: 92.5,
      grade: 'B',
      retainedDiscountSavingsUSD: 0.125,
      leakedColdPrefillUSD: 0.045,
      series: [
        { pct: 100, bust: false },
        { pct: 96, bust: false },
        { pct: 60, bust: true, cause: 'rule_mutation' },
        { pct: 95, bust: false }
      ]
    };

    const svg = renderRetentionStepChart(retention);
    assert.match(svg, /<svg class="cr-svg"/);
    assert.match(svg, /viewBox="0 0 640 120"/);
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label="Prefix-cache retention per turn"/);
    assert.match(svg, /<path d="M/);
    assert.equal(svg.includes('<script>'), false);

    // 95% retention threshold guide line
    assert.match(svg, />95%<\/text>/);
  });

  it('renders empty panel cleanly when retention data is unmeasured', () => {
    const emptySvg = renderRetentionStepChart(null);
    assert.match(emptySvg, /viewBox="0 0 640 40"/);
    assert.match(emptySvg, /role="img"/);
    assert.match(emptySvg, /Prefix retention: no multi-turn cache usage measured yet/);
    assert.equal(emptySvg.includes('<path d="M'), false);
  });

  it('renders thinking drift sparkline with TTFT strip and DET-30 loop marker', () => {
    const drift = {
      measured: true,
      lastDriftRatio: 12.5,
      rollingDriftRatio: 11.0,
      avgTtftMs: 450,
      loop: {
        triggered: true,
        severity: 'critical',
        consecutiveLoopTurns: 2
      },
      turns: [
        { turnIndex: 1, ttftMs: 350, driftRatio: 3.5, driftState: 'nominal', thinkingTokens: 1000, mutatingCalls: 1 },
        { turnIndex: 2, ttftMs: 500, driftRatio: 12.5, driftState: 'loop_suspect', thinkingTokens: 5000, mutatingCalls: 0 }
      ]
    };

    const svg = renderDriftSparkline(drift);
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label="Thinking vs generation drift and TTFT"/);
    assert.match(svg, /DET-30 CRITICAL/);
    assert.match(svg, />12x<\/text>/);
    assert.match(svg, />TTFT<\/text>/);
  });

  it('renders swarm and worktree topology graph', () => {
    const topology = {
      workers: [
        { name: 'worker-1', state: 'working', model: 'claude-sonnet-5-5' },
        { name: 'worker-2', state: 'waiting', parked: true }
      ],
      worktrees: [
        { isMain: true, branch: 'main' },
        { isMain: false, branch: 'feature-m3' }
      ]
    };

    const svg = renderTopologyGraph(topology);
    assert.match(svg, /role="img"/);
    assert.match(svg, /coordinator/);
    assert.match(svg, /worker-1/);
    assert.match(svg, /feature-m3/);
  });

  it('generates full HTML artifact with Zero-XSS escaping of malicious titles', () => {
    const maliciousTitle = 'Malicious <script>alert("pwned")</script> Title & "Quotes"';
    const html = renderCostRadarHtml({
      meta: { sessionTitle: maliciousTitle, model: 'claude-opus-5-5' }
    });

    assert.equal(html.includes('<script>alert'), false);
    assert.match(html, /&lt;script&gt;alert/);
    assert.match(html, /<!doctype html>/);
    assert.match(html, /id="cr-retention"/);
    assert.match(html, /id="cr-drift"/);
    assert.match(html, /id="cr-topology"/);
  });

  it('builds 8-level Unicode Block sparklines matching \\u2581..\\u2588', () => {
    const deltas = [100, 300, 700, 1500];
    const sparkline = buildTurnVelocitySparkline(deltas, 4);

    assert.equal(sparkline.length, 4);
    assert.match(sparkline, /^[\u2581-\u2588]{4}$/);

    // Caps to maxTurns
    const long = Array.from({ length: 25 }, (_, i) => i * 100);
    const capped = buildTurnVelocitySparkline(long, 12);
    assert.equal(capped.length, 12);

    // Empty returns empty string
    assert.equal(buildTurnVelocitySparkline([]), '');
  });

  it('builds high-resolution Unicode Braille sparklines (U+2800..U+28FF)', () => {
    const values = [10, 30, 60, 90, 40, 20];
    const braille = buildBrailleSparkline(values, { maxChars: 8 });

    assert.ok(braille.length > 0);
    // Every character must fall in the Unicode Braille Patterns range (U+2800..U+28FF)
    for (let i = 0; i < braille.length; i++) {
      const code = braille.charCodeAt(i);
      assert.ok(code >= 0x2800 && code <= 0x28FF, `Character ${braille[i]} (code ${code.toString(16)}) must be in Braille range`);
    }

    const summary = formatSparklineSummary(values, { maxChars: 8 });
    assert.match(summary, /10 .+ 90/);
  });

  it('verifies backward-compatible UI adapter re-exports', () => {
    assert.equal(typeof uiAdapter.renderRetentionStepChart, 'function');
    assert.equal(typeof uiAdapter.renderDriftSparkline, 'function');
    assert.equal(typeof uiAdapter.renderCostRadarHtml, 'function');
    assert.equal(typeof uiAdapter.escapeXml, 'function');
    assert.equal(uiAdapter.COST_RADAR_DIMENSIONS.WIDTH, 640);
  });
});
