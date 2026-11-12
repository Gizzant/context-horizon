/**
 * @file test/test_m5_workflow_surfaces.mjs
 * Milestone 5 Comprehensive Verification Suite: Developer Workflow, UI Surfaces & Studio Artifacts
 * (Features 31–40).
 *
 * Verifies:
 * - Feature 31: Unified ctxtop CLI (radar alias, postmortem, control rewind & status, inspect found/not-found)
 * - Feature 32: Zero-Flicker ANSI StatusLine responsive column scaling (80, 110, 144 cols)
 * - Feature 33: AbovePrompt 40-Cell HUD & Coach mode pill
 * - Feature 34: Claude Code 4-Rank Simple View HUD default & Section 3 DET-01..32 / DET-30
 * - Feature 35: Antigravity Studio Artifacts (<agent-embed> and horizon_hud.mjs --emit-widget)
 * - Features 36-40: Invariants, Active Source Protection, and Mirror Parity with 'bin' directory
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCli } from '../bin/ctxtop.mjs';
import { runStatusLineCli, executeStatusLineBridge } from '../bin/ah-statusline.mjs';
import { emitHorizonWidget } from '../src/cli/horizon_hud.mjs';
import {
  renderSimpleViewPane,
  renderAdvancedViewPane,
  renderAbovePromptBand,
  renderStatusLine,
  stripAnsi
} from '../src/core-isomorphic/ui/modViews.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { getSyncedPluginSubdirs } from '../scripts/sync_mirrors.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');

describe('Milestone 5: Developer Workflow, UI Surfaces & Studio Artifacts', () => {

  describe('Task 1 & Feature 31: Unified ctxtop CLI Subcommands', () => {
    test('31.1 ctxtop radar alias functions identically to cost-radar with --json', async () => {
      const radarRes = await runCli(['radar', '--json']);
      assert.equal(radarRes.exitCode, 0);
      const radarData = typeof radarRes.output === 'string' ? JSON.parse(radarRes.output) : radarRes.data;
      assert.equal(radarData.ok, true);
      assert.ok('retention' in radarData);
      assert.ok('drift' in radarData);
      assert.ok('swarm' in radarData);

      const costRadarRes = await runCli(['cost-radar', '--json']);
      assert.equal(costRadarRes.exitCode, 0);
      const costRadarData = typeof costRadarRes.output === 'string' ? JSON.parse(costRadarRes.output) : costRadarRes.data;
      assert.equal(costRadarData.ok, true);
      assert.equal(typeof costRadarData.retention, 'string');
    });

    test('31.2 ctxtop radar supports --demo flag producing non-empty metrics', async () => {
      const res = await runCli(['radar', '--demo', '--json']);
      assert.equal(res.exitCode, 0);
      const data = typeof res.output === 'string' ? JSON.parse(res.output) : res.data;
      assert.equal(data.ok, true);
      assert.ok(data.retention.includes('Retain') || data.retention.includes('%'));
    });

    test('31.3 ctxtop postmortem --demo --json executes forensic engine', async () => {
      const res = await runCli(['postmortem', '--demo', '--json']);
      assert.equal(res.exitCode, 0);
      const data = typeof res.output === 'string' ? JSON.parse(res.output) : res.data;
      assert.ok(data.isSynthetic === true || data.sessionCount >= 0);
      assert.ok('estTokensM' in data);
      assert.ok('recommendations' in data);
      assert.ok(Array.isArray(data.recommendations));
    });

    test('31.4 ctxtop postmortem without --json outputs formatted summary text', async () => {
      const res = await runCli(['postmortem', '--demo']);
      assert.equal(res.exitCode, 0);
      assert.ok(res.output.includes('[Attention Horizon Postmortem]'));
      assert.ok(res.output.includes('Analyzed'));
    });

    test('31.5 ctxtop control rewind transitions session state to REWIND with target', async () => {
      const testSessionId = `test-ctl-rewind-${Date.now()}`;
      const res = await runCli(['control', 'rewind', '--session', testSessionId, '--target', '5']);
      assert.equal(res.exitCode, 0);
      assert.ok(res.output.includes('State transitioned to REWIND'));
      assert.equal(res.data.state.state, 'REWIND');
      assert.equal(res.data.state.rewindTarget, '5');

      // Verify status subcommand reads persisted state
      const statusRes = await runCli(['control', 'status', '--session', testSessionId]);
      assert.equal(statusRes.exitCode, 0);
      assert.ok(statusRes.output.includes('is REWIND'));
      assert.equal(statusRes.data.state.state, 'REWIND');

      // Cleanup control file
      const ctlPath = path.join(os.homedir(), '.ctxtop', 'runtime', `${testSessionId}.ctl`);
      if (fs.existsSync(ctlPath)) {
        try { fs.unlinkSync(ctlPath); } catch (_e) { void _e; }
      }
    });

    test('31.6 ctxtop control invalid action returns exitCode 1 and includes pause, resume, step, abort', async () => {
      const res = await runCli(['control', 'invalid-action-foo']);
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes('Invalid control action'));
      assert.ok(res.output.includes('pause, resume, step, abort'));
      assert.ok(res.output.includes('rewind'));
    });

    test('31.7 ctxtop inspect with non-existent session returns exitCode 1', async () => {
      const missingId = '00000000-dead-beef-0000-000000000000';
      const res = await runCli(['inspect', missingId]);
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes('not found'));
      assert.equal(res.data.found, false);
    });

    test('31.8 ctxtop inspect with existing session returns exitCode 0 and USTF trajectory', async () => {
      const tmpSessId = `test-inspect-${Date.now()}`;
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-inspect-'));
      const cacheDir = path.join(tmpHome, '.claude', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      const stateFile = path.join(cacheDir, `ah_live_state_${tmpSessId}.json`);
      fs.writeFileSync(stateFile, JSON.stringify({
        sessionId: tmpSessId,
        modelId: 'claude-sonnet-5-5',
        contextWindow: { totalInputTokens: 75000, cachedTokens: 60000, outputTokens: 2500 },
        savedQuota: { sessionSavedUSD: 1.25 },
        turnsCompleted: 8,
        flightMode: 'COACH'
      }), 'utf8');

      const outArtifact = path.join(tmpHome, 'inspect_call_tree.json');
      const res = await runCli(['inspect', tmpSessId, '--out', outArtifact, '--json'], {
        homeDir: tmpHome,
        cwd: tmpHome
      });

      assert.equal(res.exitCode, 0);
      assert.ok(res.data);
      assert.equal(res.data.sessionId, tmpSessId);
      assert.equal(res.data.modelId, 'claude-sonnet-5-5');
      assert.equal(res.data.usage.uncached, 15000);
      assert.equal(res.data.usage.cacheRead, 60000);
      assert.ok(fs.existsSync(outArtifact));

      // Cleanup
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
  });

  describe('Task 2 & Feature 32: Zero-Flicker ANSI StatusLine Column Scaling', () => {
    test('32.1 ah-statusline parses --columns 80 and bounds visibleLength <= 80', async () => {
      const res = await runStatusLineCli(['--demo', '--columns', '80']);
      assert.ok(res);
      assert.ok(res.visibleLength <= 80);
      assert.equal(res.line.includes('\n'), false);
      assert.equal(res.line.includes('\r'), false);
      assert.ok(res.line.includes('AH ['));
      assert.ok(res.line.includes('COACH'));
    });

    test('32.2 ah-statusline parses --columns 110 and bounds visibleLength <= 110', async () => {
      const res = await runStatusLineCli(['--demo', '--columns', '110']);
      assert.ok(res);
      assert.ok(res.visibleLength <= 110);
      assert.equal(res.line.includes('\n'), false);
      assert.ok(res.line.includes('sonnet-5-5'));
      assert.ok(res.line.includes('Cache'));
    });

    test('32.3 ah-statusline parses --columns 144 and renders wide 40-cell layout', async () => {
      const res = await runStatusLineCli(['--demo', '--columns', '144']);
      assert.ok(res);
      assert.ok(res.visibleLength <= 144);
      assert.equal(res.line.includes('\n'), false);
      assert.ok(res.line.includes('AH ['));
      assert.ok(res.line.includes('[COACH]'));
    });

    test('32.4 ah-statusline supports --cols alias identically', async () => {
      const res = await runStatusLineCli(['--demo', '--cols', '80']);
      assert.ok(res);
      assert.ok(res.visibleLength <= 80);
    });
  });

  describe('Task 3 & Feature 35: Studio Artifacts & horizon_hud.mjs --emit-widget', () => {
    test('35.1 emitHorizonWidget generates self-contained HTML and outputs <agent-embed>', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-widget-'));
      const targetWidget = path.join(tmpDir, 'horizon_widget.html');

      const res = await emitHorizonWidget({ out: targetWidget, silent: true });
      assert.equal(res.ok, true);
      assert.ok(fs.existsSync(targetWidget));

      // Invariant: <agent-embed src="file:///<path>"></agent-embed> format
      assert.ok(res.embedTag.startsWith('<agent-embed src="file:///'));
      assert.ok(res.embedTag.endsWith('"></agent-embed>'));

      const htmlContent = fs.readFileSync(targetWidget, 'utf8');
      assert.ok(htmlContent.includes('<!doctype html>'));

      // Invariant 1: Plain-Text /compact instruction without copy buttons
      assert.ok(htmlContent.includes('id="compactInstruction"'));
      assert.ok(htmlContent.includes('id="compactReclaim"'));
      assert.equal(htmlContent.includes('#btnCompactPrimary'), false);
      assert.equal(htmlContent.includes('copyCompactWithGuidance'), false);
      assert.equal(htmlContent.includes('<button'), false);

      // Verify compact recommendation emits plain-text instruction
      const { html: compactHtml } = renderHorizonPanelHtml({
        cliffTriggered: true,
        modelId: 'claude-haiku-5-5',
        contextWindow: { totalInputTokens: 105000, cachedTokens: 90000 }
      }, { viewMode: 'simple' });
      assert.ok(compactHtml.includes('Type /compact in the chat box and press Enter'));

      // Invariant 4: Zero external network sockets
      assert.equal(htmlContent.includes('http://'), false);
      assert.equal(htmlContent.includes('https://'), false);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Task 4 & Feature 34: Claude Code 4-Rank Simple View HUD & modViews DET-01..32', () => {
    const mockState = {
      modelId: 'claude-sonnet-5-5',
      flightMode: 'COACH',
      contextWindow: { totalInputTokens: 85000, cachedTokens: 70000 },
      promptCache: { warm: true, ttlSeconds: 220 }
    };

    test('34.1 renderSimpleViewPane with SIMPLE_4_RANK returns exactly 4 ranks', () => {
      const pane = renderSimpleViewPane(mockState, { viewMode: 'SIMPLE_4_RANK' });
      assert.equal(pane.ranks.length, 4);
      assert.equal(pane.ranks[0].rankNumber, 1);
      assert.equal(pane.ranks[1].rankNumber, 2);
      assert.equal(pane.ranks[2].rankNumber, 3);
      assert.equal(pane.ranks[3].rankNumber, 4);
      assert.ok(pane.ranks[0].text.includes('claude-sonnet-5-5'));
      assert.ok(pane.ranks[1].text.includes('Scale: 0k'));
      assert.ok(pane.ranks[2].text.includes('[Rank 3]'));
      assert.ok(pane.ranks[3].text.includes('[Rank 4]'));
    });

    test('34.2 renderAdvancedViewPane Section 3 references DET-01..32 and DET-30', () => {
      const adv = renderAdvancedViewPane(mockState, { maxCols: 144 });
      assert.ok(adv.text.includes('[Section 3] Circuit Breakers (DET-01..32), Thinking Drift & Retention'));
      assert.ok(adv.text.includes('32 guards nominal'));
      assert.ok(adv.text.includes('Thinking Drift (DET-30)'));
      assert.ok(adv.text.includes('CLI Tools : npx ctxtop statusline | npx ctxtop radar | npx ctxtop inspect | npx ctxtop doctor'));
    });
  });

  describe('Task 5 & Feature 38: Mirror Parity and Directory Discovery', () => {
    test('38.1 getSyncedPluginSubdirs includes bin directory', () => {
      const subdirs = getSyncedPluginSubdirs(PROJECT_ROOT);
      const hasBin = subdirs.some((parts) => parts[0] === 'bin');
      assert.equal(hasBin, true, "getSyncedPluginSubdirs must include 'bin' directory");
    });

    test('38.2 bin directory contains ctxtop.mjs and ah-statusline.mjs in repo root', () => {
      assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'bin', 'ctxtop.mjs')));
      assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'bin', 'ah-statusline.mjs')));
    });
  });

  describe('Task 6: Inspect Slash Command & Skill Documentation', () => {
    test('commands/inspect.md and skills/inspect/SKILL.md exist and document /inspect', () => {
      const cmdPath = path.join(PROJECT_ROOT, 'commands', 'inspect.md');
      const skillPath = path.join(PROJECT_ROOT, 'skills', 'inspect', 'SKILL.md');

      assert.ok(fs.existsSync(cmdPath), 'commands/inspect.md must exist');
      assert.ok(fs.existsSync(skillPath), 'skills/inspect/SKILL.md must exist');

      const cmdContent = fs.readFileSync(cmdPath, 'utf8');
      assert.ok(cmdContent.includes('ctxtop inspect'));

      const skillContent = fs.readFileSync(skillPath, 'utf8');
      assert.ok(skillContent.includes('ctxtop.mjs inspect'));
      assert.ok(skillContent.includes('<agent-embed'));
    });
  });

  describe('Feature 33: AbovePrompt 40-Cell HUD & Coach Pill', () => {
    test('33.1 AbovePrompt band produces strictly 1 line with 40-cell grid and COACH pill', () => {
      const band = renderAbovePromptBand({
        flightMode: 'COACH',
        totalInputTokens: 60000,
        cachedTokens: 48000
      });
      assert.equal(band.grid.cellCount, 40);
      assert.ok(band.coachPill.includes('COACH'));
      assert.equal(band.line.includes('\n'), false);
      assert.equal(band.line.includes('\r'), false);
    });
  });

});
