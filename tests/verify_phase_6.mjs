/**
 * Phase 6 Verification Suite — U-Shaped Attention Heatmap & Session Fracture Overlay (Layer 6)
 *
 * Verifies:
 * 1. Parabolic U-Shaped Attention Curve A(i) (gamma = 0.6) & 30%-70% Low-Attention Trough shading.
 * 2. Stranded Signal Warning in Cells 7-15 (0-based indices 6-14) with exact recall decay advisory.
 * 3. Session Fracture Markers (⚡) between cells for Compaction (step_type == 23) and Prefix Bust (cache_read_tokens == 0, dt < 300s).
 * 4. Interactive Turn Inspection in the 40-Cell WebView when clicking a cell.
 * 5. 3-Way WebView Mirror Parity (SHA-256).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  classifyHorizon,
  calculateParabolicAttentionCurve,
  calculateAttentionWeight
} from '../src/core/classifier.mjs';
import {
  STRANDED_SIGNAL_WARNING_TEXT,
  ATTENTION_TROUGH_CONFIG
} from '../src/core/constants.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

console.log('=== Phase 6 Verification: U-Shaped Attention Heatmap & Session Fracture Overlay ===');

// ---------------------------------------------------------------------------
// 1. Parabolic U-Shaped Attention Curve Math & Trough Detection
// ---------------------------------------------------------------------------
{
  assert.equal(ATTENTION_TROUGH_CONFIG.GAMMA, 0.6, 'Default gamma must be 0.6');
  assert.equal(
    STRANDED_SIGNAL_WARNING_TEXT,
    'Stranded in Low-Attention Trough. Risk of recall decay during multi-file reasoning. Re-reference in active prompt or anchor to task.md.'
  );

  // Endpoint Primacy (i = 0, N = 20)
  const primacy = calculateParabolicAttentionCurve(0, 20, 0.6);
  assert.equal(primacy.specFormulaValue, 0.4, 'A(0) = 1.0 - 4*0.6*(0 - 0.5)^2 = 0.4');
  assert.equal(primacy.uShapedWeight, 1.0, 'Primacy endpoint U-shaped weight must be 1.0');
  assert.equal(primacy.inTrough, false, 'Cell 0 must not be in Low-Attention Trough');
  assert.equal(primacy.zone, 'PRIMACY');

  // Midpoint Trough (i = 10, N = 21 -> ratio = 0.5)
  const midpoint = calculateParabolicAttentionCurve(10, 21, 0.6);
  assert.equal(midpoint.specFormulaValue, 1.0, 'A(0.5) = 1.0 - 4*0.6*(0)^2 = 1.0');
  assert.equal(midpoint.uShapedWeight, 0.4, 'Midpoint U-shaped weight must drop to 1 - gamma = 0.4');
  assert.equal(midpoint.inTrough, true, '50% midpoint must be in Low-Attention Trough (30%-70%)');
  assert.equal(midpoint.zone, 'LOW_ATTENTION_TROUGH');

  // Recency Endpoint (i = 20, N = 21 -> ratio = 1.0)
  const recency = calculateParabolicAttentionCurve(20, 21, 0.6);
  assert.equal(recency.uShapedWeight, 1.0, 'Recency endpoint U-shaped weight must be 1.0');
  assert.equal(recency.inTrough, false, 'Final cell must not be in Low-Attention Trough');
  assert.equal(recency.zone, 'RECENCY');

  const weightVal = calculateAttentionWeight(10, 21);
  assert.equal(weightVal, 0.4, 'calculateAttentionWeight must return parabolic U-shaped weight at midpoint');
  console.log('  [PASS] 1. Parabolic U-Shaped Attention Curve math & 30%-70% Low-Attention Trough verified');
}

// ---------------------------------------------------------------------------
// 2. Classifier Stranded Signal Warning & Session Fracture Overlay
// ---------------------------------------------------------------------------
{
  // Construct a Compaction Checkpoint at index 0 followed by 20 steps of 6,400 tokens each (~128k tokens = 20 populated cells).
  // Place an active file edit in post-checkpoint step 8 (Cell 9, inside Cells 7..15 trough) and a mid-run Prefix Bust at step 12.
  const baseMs = Date.parse('2026-11-08T00:00:00Z');
  const rawSteps = [
    {
      stepIndex: 0,
      source: 'SYSTEM',
      type: 'CORTEX_STEP_TYPE_CHECKPOINT',
      step_type: 23,
      inputTokens: 1200,
      outputTokens: 0,
      cacheReadTokens: 0,
      createdAt: new Date(baseMs).toISOString(),
      content: '<CONTEXT_SUMMARY>Compacted checkpoint</CONTEXT_SUMMARY>',
      toolCalls: []
    }
  ];

  for (let idx = 1; idx <= 20; idx++) {
    const isStrandedTarget = idx === 8; // Falls into Cell 9 (0-based cell 8, within Cells 7..15 trough)
    const isPrefixBustTurn = idx === 12; // Mid-run prefix bust (cacheReadTokens == 0, dt = 60s < 300s)

    rawSteps.push({
      stepIndex: idx,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      step_type: 1,
      inputTokens: 6000,
      outputTokens: 6400,
      untruncatedLength: 25600,
      cacheReadTokens: isPrefixBustTurn ? 0 : 32000,
      createdAt: new Date(baseMs + idx * 60_000).toISOString(),
      content: isStrandedTarget
        ? 'Updated src/core/stranded_module.mjs implementation'
        : `Working on step ${idx}`,
      toolCalls: isStrandedTarget
        ? [{ name: 'edit_file', args: { Path: 'src/core/stranded_module.mjs' } }]
        : [{ name: 'read_file', args: { Path: `src/file_${idx}.mjs` } }]
    });
  }

  const result = classifyHorizon(rawSteps, { maxTokensOverride: 256000 });

  assert.ok(result.attentionHeatmap, 'classifyHorizon must expose attentionHeatmap summary');
  assert.equal(result.attentionHeatmap.gamma, 0.6);
  assert.ok(result.attentionHeatmap.strandedSignals.length >= 1, 'Must detect stranded signal in Cells 7-15');

  const cell9 = result.cells[8]; // 0-based index 8 = Cell 9
  assert.equal(cell9.inAttentionTrough, true, 'Cell 9 must be flagged inAttentionTrough');
  assert.equal(cell9.isStrandedSignal, true, 'Cell 9 with ACTIVE_CODE must be flagged isStrandedSignal');
  assert.equal(cell9.strandedWarning, STRANDED_SIGNAL_WARNING_TEXT);
  assert.ok(Array.isArray(cell9.turnsDetail) && cell9.turnsDetail.length >= 1, 'Cell 9 must include turnsDetail for interactive click filtering');

  // Verify Session Fracture detection (Compaction + Prefix Bust)
  const fractures = result.attentionHeatmap.fractures;
  assert.ok(fractures.some(f => f.type === 'COMPACTION'), 'Must detect COMPACTION fracture at step_type == 23');
  assert.ok(fractures.some(f => f.type === 'PREFIX_BUST'), 'Must detect PREFIX_BUST fracture when cache_read_tokens drops to 0 with dt < 300s');

  console.log('  [PASS] 2. Classifier Stranded Signal Warning & Session Fracture Overlay verified');

  // -------------------------------------------------------------------------
  // 3. WebView DOM Verification (Trough Shading, Stranded Warning, Fractures, Click Inspection)
  // -------------------------------------------------------------------------
  const htmlPath = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(htmlContent, {
    url: 'http://localhost:51234/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      w.EventSource = class { addEventListener() {} close() {} };
      w.navigator.clipboard = { writeText: async () => {} };
    }
  });
  const { window } = dom;
  const { document } = window;

  window.renderState(result);

  const miniCells = Array.from(document.querySelectorAll('#miniTimeline .mini-cell'));
  assert.equal(miniCells.length, 40, 'Must render 40 .mini-cell blocks');

  const troughCells = miniCells.filter(el => el.classList.contains('low-attention-trough'));
  assert.ok(troughCells.length >= 5, `Must shade middle 30%-70% cells with .low-attention-trough (got ${troughCells.length})`);

  const strandedCells = miniCells.filter(el => el.classList.contains('stranded-signal'));
  assert.ok(strandedCells.length >= 1, 'Must highlight stranded signal cell with .stranded-signal');
  assert.ok(
    strandedCells[0].title.includes(STRANDED_SIGNAL_WARNING_TEXT),
    'Stranded cell tooltip must contain the exact Stranded Signal Warning text'
  );

  const strandedBanner = document.getElementById('strandedSignalBanner');
  assert.ok(strandedBanner && !strandedBanner.hidden, '#strandedSignalBanner must be visible when stranded signals exist');
  assert.ok(
    strandedBanner.textContent.includes(STRANDED_SIGNAL_WARNING_TEXT),
    '#strandedSignalBanner must display exact warning text'
  );

  const fractureMarkers = Array.from(document.querySelectorAll('#miniTimeline .fracture-marker'));
  assert.ok(fractureMarkers.length >= 2, `Must render ⚡ .fracture-marker elements for Compaction and Prefix Bust (got ${fractureMarkers.length})`);
  assert.ok(fractureMarkers.some(el => el.textContent.includes('\u26A1')), 'Fracture marker must render ⚡ icon');

  // Interactive Turn Inspection on Cell Click
  const turnFilterPanel = document.getElementById('cellTurnFilterPanel');
  assert.ok(turnFilterPanel.hidden, '#cellTurnFilterPanel must be hidden before clicking a cell');

  const targetCellEl = miniCells[8]; // Cell 9 (index 8)
  targetCellEl.click();

  assert.equal(targetCellEl.classList.contains('selected'), true, 'Clicked cell must receive .selected class');
  assert.equal(turnFilterPanel.hidden, false, '#cellTurnFilterPanel must unhide on cell click');
  assert.ok(
    turnFilterPanel.textContent.includes('Cell 9/40') &&
    turnFilterPanel.textContent.includes('stranded_module.mjs') &&
    turnFilterPanel.textContent.includes('edit_file'),
    `#cellTurnFilterPanel must show cell turns and tool calls (got: ${turnFilterPanel.textContent})`
  );

  console.log('  [PASS] 3. WebView DOM Trough Shading, Stranded Warning, ⚡ Fracture Markers & Interactive Click Filter verified');
}

// ---------------------------------------------------------------------------
// 4. 3-Way WebView Mirror Parity (SHA-256)
// ---------------------------------------------------------------------------
{
  const primary = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
  const mirrors = [
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-horizon', 'src', 'ui', 'sidepane.html'),
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck', 'src', 'webview', 'horizon_panel.html')
  ];
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const primaryHash = sha(primary);
  for (const m of mirrors) {
    if (fs.existsSync(m)) {
      assert.equal(sha(m), primaryHash, `Mirror drift detected in ${m}`);
    }
  }
  console.log(`  [PASS] 4. 3-Way WebView Mirror SHA-256 parity verified (${primaryHash.slice(0, 12)}...)`);
}

console.log('=== ALL PHASE 6 VERIFICATION CHECKS PASSED (0 errors) ===');
