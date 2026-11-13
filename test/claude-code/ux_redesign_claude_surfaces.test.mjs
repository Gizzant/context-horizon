/**
 * @file test/ux_redesign_claude_surfaces.test.mjs
 * Verification suite for the Claude Code Highbeam UX Redesign & "Tokens Saved" Elevation:
 *   1. 5-Category Claude Code Savings Ledger (`SAVINGS_BUCKETS`, `recordInterventionSavings`, session vs 30d totals)
 *   2. Producer wiring across `PreModelSwitch` (`DET-08`), `PreToolUse` (`DET-09`/`DET-11`), and `Task`/`Agent` subagents
 *   3. 4-Rank Simple View (`renderSimpleHudPane` / `pane.ranks`) & 5-Section Advanced View (`renderAdvancedViewPane`) <= 80 cols
 *   4. Self-contained 420px Claude Code HTML HUD (`renderHorizonPanelHtml` / `npx ah-claude panel`) with zero Antigravity residue
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  SAVINGS_BUCKETS,
  normalizeSavingsBucketId,
  recordTurnCacheSavings,
  recordInterventionSavings,
  getSavedQuotaReceiptSummary
} from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  stripAnsi,
  isIgnorableClaudePath,
  deriveClaudeCodeVerdictAndActions,
  renderSimpleViewPane,
  renderSimpleHudPane,
  renderAdvancedViewPane
} from '../../src/core-isomorphic/ui/modViews.mjs';
import { renderHorizonPanelHtml } from '../../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { createInitialTelemetryState, ingestModTurnEvent } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { runPreToolUseHook } from '../../hooks/handlers/pre-tool-use.mjs';
import { runCli } from '../../bin/cli.mjs';
import register from '../../hooks/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

test('UX-1: 5-Category Claude Code Savings Ledger aggregates This Session vs 30-Day Workspace and identifies topDriver', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ux1-ledger-'));
  try {
    const nowMs = 1_760_000_500_000;
    const ledgerPath = path.join(tmpDir, '.claude', 'cache', 'horizon_ledger.jsonl');

    // Prior session within 30d window
    recordTurnCacheSavings(
      {
        sessionId: 'sess-prev',
        turnId: 't-prev-1',
        model: 'claude-sonnet-5-5',
        inputTokens: 4_000,
        cacheReadTokens: 80_000,
        outputTokens: 600
      },
      { cwd: tmpDir, ledgerPath, nowMs: nowMs - 2 * 86_400_000 }
    );

    // Active session: warm cache read + DET-08 model switch hold + DET-09 prefix fence
    recordTurnCacheSavings(
      {
        sessionId: 'sess-active',
        turnId: 't-act-1',
        model: 'claude-opus-5-5',
        inputTokens: 2_000,
        cacheReadTokens: 60_000,
        outputTokens: 800
      },
      { cwd: tmpDir, ledgerPath, nowMs }
    );

    const holdRec = recordInterventionSavings(
      {
        sessionId: 'sess-active',
        category: 'DET_08_MODEL_SWITCH_HOLD',
        modelId: 'claude-opus-5-5',
        savedTokens: 60_000,
        savedUSD: 0.45,
        dedupeId: 'switch-1',
        detail: 'Held Opus 5.5 warm prefix above C* = 6,522'
      },
      { cwd: tmpDir, ledgerPath, nowMs }
    );
    assert.equal(holdRec.recorded, true);

    // Duplicate intervention with same dedupeId is suppressed
    const dupRec = recordInterventionSavings(
      {
        sessionId: 'sess-active',
        category: 'DET_08_MODEL_SWITCH_HOLD',
        modelId: 'claude-opus-5-5',
        savedTokens: 60_000,
        savedUSD: 0.45,
        dedupeId: 'switch-1'
      },
      { cwd: tmpDir, ledgerPath, nowMs }
    );
    assert.equal(dupRec.recorded, false);
    assert.equal(dupRec.deduplicated, true);

    const summary = getSavedQuotaReceiptSummary({
      cwd: tmpDir,
      ledgerPath,
      activeSessionId: 'sess-active',
      nowMs
    });

    assert.equal(Object.keys(SAVINGS_BUCKETS).length, 5);
    assert.equal(normalizeSavingsBucketId('DET_08_MODEL_SWITCH_HOLD'), 'prefixBustAvoided');
    assert.equal(normalizeSavingsBucketId('ARTIFACT_OFFLOAD_4K'), 'toolOutputCompressed');
    assert.equal(normalizeSavingsBucketId('BOUNDED_READ_ENFORCED'), 'loopAndReadGuarded');
    assert.equal(normalizeSavingsBucketId('SUBAGENT_ISOLATED'), 'subagentIsolated');

    assert.equal(summary.sessionSavedTokens, 120_000);
    assert.equal(summary.workspace30dSavedTokens, 200_000);
    assert.ok(summary.workspace30dSavedUSD > summary.sessionSavedUSD);
    assert.equal(summary.categories.cacheReadDiscount.savedTokens, 140_000);
    assert.equal(summary.categories.prefixBustAvoided.savedTokens, 60_000);
    assert.equal(summary.topDriver.id, 'cacheReadDiscount');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UX-2: PreModelSwitch (DET-08), PreToolUse (DET-09), and Subagent Isolation feed the 5-Category Savings breakdown', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ux2-producers-'));
  try {
    // 1. PreModelSwitch DET-08 block in AUTO_PILOT records DET_08_MODEL_SWITCH_HOLD
    const switchRes = runPreModelSwitchHook(
      {
        session_id: 'sess-prod',
        mode: 'AUTO_PILOT',
        current_model: 'claude-opus-5-5',
        target_model: 'claude-sonnet-5-5',
        cached_tokens: 50_000,
        cache_warm: true,
        turn_id: 'turn-sw-1'
      },
      { cwd: tmpDir }
    );
    assert.equal(switchRes.verdict.blocked, true);

    // 2. PreToolUse DET-09 warm-prefix CLAUDE.md edit in AUTO_PILOT records DET_09_PREFIX_FENCE
    const telemetryState = createInitialTelemetryState('sess-prod', 'claude-opus-5-5');
    telemetryState.contextWindow.totalInputTokens = 55_000;
    telemetryState.contextWindow.cachedTokens = 50_000;
    telemetryState.promptCache.warm = true;
    telemetryState.promptCache.ttlSeconds = 240;

    const fenceRes = runPreToolUseHook(
      {
        session_id: 'sess-prod',
        mode: 'AUTO_PILOT',
        tool_name: 'Edit',
        tool_use_id: 'tu-fence-1',
        tool_input: {
          file_path: path.join(tmpDir, 'CLAUDE.md'),
          old_string: 'a',
          new_string: 'b'
        }
      },
      { cwd: tmpDir, telemetryState }
    );
    assert.equal(fenceRes.verdict.triggered, true);
    assert.equal(fenceRes.verdict.detectorId, 'DET-09');

    // 3. Subagent turn isolation in telemetry state
    let stateWithSub = ingestModTurnEvent(telemetryState, {
      type: 'turn.complete',
      agentId: 'researcher-1',
      turnId: 'sub-t1',
      usage: {
        input_tokens: 18_000,
        output_tokens: 2_000
      }
    });

    const hud = renderSimpleHudPane(stateWithSub, { cwd: tmpDir });
    assert.ok(hud.metrics.savingsCategories.prefixBustAvoided.savedTokens >= 50_000);
    assert.equal(hud.metrics.savingsCategories.subagentIsolated.savedTokens, 20_000);
    assert.ok(hud.metrics.sessionSavedTokens >= 70_000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UX-3: 4-Rank Simple View (renderSimpleHudPane) and 5-Section Advanced View (renderAdvancedViewPane) fit <= 80 cols and integrate with Mod ui.render', async () => {
  const nowMs = 1_760_000_000_000;
  const state = createInitialTelemetryState('sess-ux3', 'claude-sonnet-5-5');
  state.modelLabel = 'Claude Sonnet 5.5';
  state.contextWindow.totalInputTokens = 160_000;
  state.contextWindow.cachedTokens = 110_000;
  state.contextWindow.cacheReadTokens = 110_000;
  state.contextWindow.systemAndMcpTokens = 12_000;
  state.contextWindow.distractorTokens = 30_000;
  state.contextWindow.lastWriteTokens = 8_000;
  state.promptCache.warm = true;
  state.promptCache.expiresAt = nowMs + 180_000;
  state.cumulative.cacheReadTokens = 110_000;
  state.cumulative.netCacheSavingsUSD = 2.97;

  const simpleHud = renderSimpleHudPane(state, {
    nowMs,
    maxCols: 80,
    includeDiskLedger: false
  });
  assert.equal(simpleHud.viewMode, 'SIMPLE_4_RANK');
  assert.equal(simpleHud.ranks.length, 4);
  assert.deepEqual(
    simpleHud.ranks.map((r) => r.rankNumber),
    [1, 2, 3, 4]
  );
  assert.match(simpleHud.text, /\[Rank 1\]/);
  assert.match(simpleHud.text, /\[Rank 2\]/);
  assert.match(simpleHud.text, /\[Rank 3\]/);
  assert.match(simpleHud.text, /\[Rank 4\] Verified Tokens & USD Saved/);

  for (const line of simpleHud.text.split('\n')) {
    const vis = stripAnsi(line).length;
    assert.ok(vis <= 80, `Simple 4-Rank line (${vis} cols) exceeded 80 cols: "${line}"`);
  }

  const advPane = renderAdvancedViewPane(state, {
    nowMs,
    maxCols: 80,
    includeDiskLedger: false,
    offenders: [
      { name: 'package-lock.json', tokens: 22_000, category: '[D]' },
      { name: 'src/core-isomorphic/ui/modViews.mjs', tokens: 8_000, category: '[C]' }
    ]
  });
  assert.equal(advPane.viewMode, 'ADVANCED_5_SECTION');
  assert.equal(advPane.sections.length, 5);
  assert.deepEqual(
    advPane.sections.map((s) => s.sectionNumber),
    [1, 2, 3, 4, 5]
  );
  assert.match(advPane.sections[1].text, /package-lock\.json.*\[\.claudeignore candidate\]/);
  assert.doesNotMatch(advPane.sections[1].text, /modViews\.mjs.*\[\.claudeignore candidate\]/);

  for (const line of advPane.text.split('\n')) {
    const vis = stripAnsi(line).length;
    assert.ok(vis <= 80, `Advanced 5-Section line (${vis} cols) exceeded 80 cols: "${line}"`);
  }

  // Verify Mod command.horizon -> ui.render switches between Simple and Advanced views
  const handlers = {};
  register((eventName, fn) => {
    handlers[eventName] = fn;
  });
  const store = new Map([
    ['ah_session_telemetry', state],
    ['ah_flight_mode', 'COACH']
  ]);
  const ctx = {
    store: {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v)
    },
    ui: {
      open: () => {},
      invalidate: () => {}
    },
    clock: {
      every: () => () => {}
    }
  };

  await handlers['command.horizon']({ args: 'advanced' }, ctx);
  const renderedAdv = await handlers['ui.render'](
    { component: 'Pane', id: 'attention-horizon', nowMs },
    ctx
  );
  assert.equal(renderedAdv.viewMode, 'ADVANCED_5_SECTION');
  assert.equal(renderedAdv.sections.length, 5);
});

test('UX-4: Self-contained Claude Code HTML HUD (renderHorizonPanelHtml & npx ah-claude panel) enforces invariants and zero Antigravity UI leaks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ux4-panel-'));
  try {
    const htmlSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'core-isomorphic', 'ui', 'horizonPanelHtml.mjs'),
      'utf8'
    );
    assert.doesNotMatch(htmlSrc, /from\s+['"]node:/, 'horizonPanelHtml.mjs must remain node:* free');

    const nowMs = 1_760_000_000_000;
    const state = createInitialTelemetryState('sess-html', 'claude-haiku-5-5');
    state.modelLabel = 'Claude Haiku 5.5';
    state.preCliffWarningTriggered = true;
    state.contextWindow.totalInputTokens = 92_000;
    state.contextWindow.cachedTokens = 70_000;
    state.contextWindow.cacheReadTokens = 70_000;
    state.contextWindow.systemAndMcpTokens = 8_000;
    state.contextWindow.distractorTokens = 10_000;
    state.contextWindow.lastWriteTokens = 4_000;
    state.promptCache.warm = true;
    state.promptCache.expiresAt = nowMs + 210_000;
    state.cumulative.cacheReadTokens = 70_000;
    state.cumulative.netCacheSavingsUSD = 0.42;

    const panel = renderHorizonPanelHtml(state, {
      nowMs,
      includeDiskLedger: false,
      offenders: [
        { name: 'pnpm-lock.yaml', tokens: 10_000, category: '[D]' },
        { name: 'src/guards/circuitBreakers.mjs', tokens: 6_000, category: '[C]' }
      ]
    });

    // 1. 4-Rank Simple View & 5-Accordion Advanced View DOM markers exist
    for (const id of [
      'simpleViewContainer',
      'verdictBanner',
      'capacityAndCacheCard',
      'priorityActionCard',
      'tokensSavedCard',
      'advancedViewContainer',
      'advSavingsAccordion',
      'advAnatomyAccordion',
      'advBreakersAccordion',
      'advSwarmAccordion',
      'advForensicsAccordion',
      'compactInstruction',
      'compactReclaim'
    ]) {
      assert.match(panel.html, new RegExp(`id="${id}"`), `Missing DOM id="${id}"`);
    }

    // 2. /compact instruction & 1-click Copy /compact button (#btnCompactPrimary)
    assert.match(panel.html, /Type \/compact in the chat box and press Enter/);
    assert.match(panel.html, /id="btnCompactPrimary"/);
    assert.doesNotMatch(panel.html, /copyCompactWithGuidance|Ctrl\+V/i);

    // 3. Active source file protection (.claudeignore only on lockfiles/logs/build artifacts)
    assert.equal(isIgnorableClaudePath('pnpm-lock.yaml'), true);
    assert.equal(isIgnorableClaudePath('src/guards/circuitBreakers.mjs'), false);
    assert.match(panel.html, /pnpm-lock\.yaml\s*<span class="adv-badge-ignore">\.claudeignore candidate<\/span>/);
    assert.doesNotMatch(panel.html, /circuitBreakers\.mjs\s*<span class="adv-badge-ignore">/);

    // 4. Zero Antigravity UI concepts or repo name leaks
    assert.doesNotMatch(
      panel.html,
      /antigravity|50k Cascade Sync|task\.md|GEMINI\.md|Argon|Carbon|ctxtop|ga-visualizer-v2|cc-attention-horizon/i
    );

    // 5. CLI `npx ah-claude panel --json` & `npx ah-claude receipt --advanced`
    const outFile = path.join(tmpDir, 'custom_panel.html');
    const cliPanel = runCli(['panel', '--advanced', '--out', outFile, '--json'], {
      cwd: tmpDir,
      state
    });
    assert.equal(cliPanel.exitCode, 0);
    assert.equal(fs.existsSync(outFile), true);
    const parsedCli = JSON.parse(cliPanel.output);
    assert.equal(parsedCli.ok, true);
    assert.equal(parsedCli.sessionSavedTokens, 70_000);

    const cliAdvReceipt = runCli(['receipt', '--advanced'], {
      cwd: tmpDir,
      state
    });
    assert.equal(cliAdvReceipt.exitCode, 0);
    assert.match(cliAdvReceipt.output, /\[Section 1\] Verified 5-Category Savings/);
    assert.match(cliAdvReceipt.output, /\[Section 5\] PreCompact State Baton/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
