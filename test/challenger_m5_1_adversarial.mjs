/**
 * @file test/challenger_m5_1_adversarial.mjs
 * Milestone 5 Adversarial Stress Test Suite:
 * Empirical adversarial stress testing of Unified CLI Subcommands (Feature 31),
 * Zero-Flicker ANSI StatusLine Extreme Column Resilience (Feature 32),
 * AbovePrompt 40-Cell HUD (Feature 33), Claude Docked Pane (Feature 34),
 * Antigravity Studio Artifacts (Feature 35), and Invariant Parity (Features 36–40).
 *
 * Authored by: challenger_m5_1 (Role: Milestone 5 Challenger 1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../bin/ctxtop.mjs';
import { executeStatusLineBridge, runStatusLineCli } from '../bin/ah-statusline.mjs';
import {
  renderStatusLine,
  renderAbovePromptBand,
  renderSimpleViewPane,
  renderAdvancedViewPane,
  isIgnorableClaudePath,
  stripAnsi
} from '../src/core-isomorphic/ui/modViews.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';
import { emitHorizonWidget } from '../src/cli/horizon_hud.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Milestone 5 Challenger 1: Adversarial Stress & Hard Invariants Suite', () => {

  // =========================================================================
  // SECTION 1: bin/ah-statusline.mjs Extreme Column Widths & Visual Invariants
  // =========================================================================
  describe('Section 1: bin/ah-statusline.mjs Extreme Column Resilience', () => {
    const requiredWidths = [0, 1, 40, 79, 80, 81, 109, 110, 111, 143, 144, 200, 1000];

    for (const width of requiredWidths) {
      it(`1.1.${width} columns=${width}: zero line wrapping, zero newlines, valid bounds`, async () => {
        const res = await runStatusLineCli(['--demo', '--columns', String(width)]);
        assert.ok(res, `runStatusLineCli must return result object for width=${width}`);

        // Zero \n and zero \r invariants
        assert.equal(res.line.includes('\n'), false, `Line must contain 0 newlines at width=${width}`);
        assert.equal(res.line.includes('\r'), false, `Line must contain 0 carriage returns at width=${width}`);
        assert.equal(res.plainLine.includes('\n'), false, `Plain line must contain 0 newlines at width=${width}`);

        // Exact visible length checks
        assert.equal(typeof res.visibleLength, 'number');
        assert.equal(res.visibleLength, res.plainLine.length, 'visibleLength must equal stripAnsi length');

        if (width >= 40) {
          // Terminal width constraint: visible length cannot exceed columns
          assert.ok(
            res.visibleLength <= width,
            `visibleLength (${res.visibleLength}) must be <= columns (${width})`
          );
        } else if (width === 0) {
          // Width 0 falls back to default 80 columns
          assert.ok(res.visibleLength <= 80, `visibleLength (${res.visibleLength}) must be <= default 80`);
        } else {
          // Width 1..39 is clamped to minimum floor 40 cells
          assert.ok(res.visibleLength <= 40, `visibleLength (${res.visibleLength}) must be <= min floor 40`);
        }

        // Layout tier validation
        if (width >= 132) {
          assert.equal(res.layoutTier, 'wide-144');
        } else if (width >= 96) {
          assert.equal(res.layoutTier, 'standard-110');
        } else {
          assert.equal(res.layoutTier, 'compact-80');
        }
      });
    }

    it('1.2 ANSI Escape Code Integrity across all widths (no severed escape sequences)', async () => {
      for (const width of requiredWidths) {
        const res = await runStatusLineCli(['--demo', '--columns', String(width)]);
        const raw = res.line;

        // Verify every ESC '[' is terminated with a valid final byte [a-zA-Z]
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === '\x1b') {
            const sub = raw.slice(i);
            const match = sub.match(/^\x1b\[[0-9;]*[a-zA-Z]/);
            assert.ok(
              match,
              `Severed or malformed ANSI escape sequence at index ${i} for width=${width}: ${JSON.stringify(sub.slice(0, 10))}`
            );
          }
        }
      }
    });

    it('1.3 Non-numeric, negative, floating, and extreme column inputs fallback safely', async () => {
      const weirdCols = ['NaN', 'Infinity', '-50', '80.5', '', 'null', 'undefined', 'invalid_string'];
      for (const col of weirdCols) {
        const res = await runStatusLineCli(['--demo', '--columns', col]);
        assert.ok(res, `Must return valid result for --columns ${col}`);
        assert.equal(res.line.includes('\n'), false);
        assert.ok(res.visibleLength <= 80 || res.visibleLength <= 110);
      }
    });

    it('1.4 Stdin JSON bridge resilience: handles corrupted stdin, empty stdin, and EOF', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-bridge-'));
      try {
        // 1. Valid payload via executeStatusLineBridge
        const validRes = executeStatusLineBridge({
          session_id: 'test-bridge-resilience',
          terminal: { columns: 80 }
        }, { cwd: tmpDir });
        assert.ok(validRes);
        assert.equal(validRes.visibleLength <= 80, true);

        // 2. Corrupt/malformed payload
        const corruptPayloads = [
          {},
          null,
          { session_id: 'session-!@#$%^&*()' },
          { terminal: { columns: -10 } },
          { context_window: { total_input_tokens: NaN, cached_tokens: -1 } }
        ];
        for (const p of corruptPayloads) {
          const res = executeStatusLineBridge(p || {}, { cwd: tmpDir });
          assert.ok(res);
          assert.equal(res.line.includes('\n'), false);
          assert.ok(res.visibleLength > 0);
        }

        // 3. Child process with broken stdin should exit 0 cleanly without crash
        const proc = spawnSync(process.execPath, [path.join(PKG_ROOT, 'bin', 'ah-statusline.mjs')], {
          cwd: tmpDir,
          input: '<<<MALFORMED_JSON_STDIN>>>',
          encoding: 'utf8'
        });
        assert.equal(proc.status, 0, 'ah-statusline must exit code 0 on broken stdin (graceful fallback)');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // SECTION 2: bin/ctxtop.mjs radar Subcommand Adversarial Stress
  // =========================================================================
  describe('Section 2: bin/ctxtop.mjs radar Adversarial Stress', () => {
    it('2.1 radar alias matches cost-radar exactly with --json and --demo', async () => {
      const radarRes = runCli(['radar', '--demo', '--json']);
      const costRadarRes = runCli(['cost-radar', '--demo', '--json']);

      assert.equal(radarRes.exitCode, 0);
      assert.equal(costRadarRes.exitCode, 0);

      const rData = typeof radarRes.output === 'string' ? JSON.parse(radarRes.output) : radarRes.data;
      const crData = typeof costRadarRes.output === 'string' ? JSON.parse(costRadarRes.output) : costRadarRes.data;

      assert.equal(rData.ok, true);
      assert.equal(crData.ok, true);
      assert.equal(rData.retention, crData.retention);
      assert.equal(rData.drift, crData.drift);
      assert.equal(rData.loopTriggered, crData.loopTriggered);
    });

    it('2.2 radar creates deep nested directories for --out target', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-radar-deep-'));
      const deepOut = path.join(tmpDir, 'a', 'b', 'c', 'radar_output.html');

      const res = runCli(['radar', '--demo', '--out', deepOut, '--json']);
      assert.equal(res.exitCode, 0);
      assert.ok(fs.existsSync(deepOut), 'Deep output file must be created');

      const html = fs.readFileSync(deepOut, 'utf8');
      assert.ok(html.includes('<svg'), 'Radar HTML must contain SVG chart');
      assert.ok(html.includes('Cost Radar') || html.includes('Retention'));

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('2.3 radar handles unwritable / invalid --out path gracefully (exitCode 1, no crash)', () => {
      const res = runCli(['radar', '--demo', '--out', '.']);
      assert.equal(res.exitCode, 1, 'Writing radar to an existing directory must return exitCode 1');
    });

    it('2.4 radar handles trailing --out flag without value by falling back to default', () => {
      const res = runCli(['radar', '--demo', '--out']);
      assert.equal(res.exitCode, 0);
      assert.ok(res.data.path.includes('cost_radar.html'));
    });

    it('2.5 radar without --json outputs human-readable summary text', () => {
      const res = runCli(['radar', '--demo']);
      assert.equal(res.exitCode, 0);
      assert.ok(res.output.includes('[Highbeam]'));
      assert.ok(res.output.includes('Cost Radar written:'));
    });
  });

  // =========================================================================
  // SECTION 3: bin/ctxtop.mjs postmortem Subcommand Adversarial Stress
  // =========================================================================
  describe('Section 3: bin/ctxtop.mjs postmortem Adversarial Stress', () => {
    it('3.1 postmortem handles extreme and malformed --last values', async () => {
      const extremeLast = ['abc', '-5', '0', '9999999', 'NaN', '1e6'];
      for (const val of extremeLast) {
        const res = await runCli(['postmortem', '--demo', '--last', val, '--json']);
        assert.equal(res.exitCode, 0, `--last ${val} must resolve cleanly`);
        const data = typeof res.output === 'string' ? JSON.parse(res.output) : res.data;
        assert.ok('estTokensM' in data);
        assert.ok('recommendations' in data);
        assert.ok(Array.isArray(data.recommendations));
      }
    });

    it('3.2 postmortem handles missing trailing --last argument', async () => {
      const res = await runCli(['postmortem', '--demo', '--last', '--json']);
      assert.equal(res.exitCode, 0);
    });

    it('3.3 postmortem supports --roast flag in both json and plain text formats', async () => {
      const roastJson = await runCli(['postmortem', '--demo', '--roast', '--json']);
      assert.equal(roastJson.exitCode, 0);
      const data = typeof roastJson.output === 'string' ? JSON.parse(roastJson.output) : roastJson.data;
      assert.ok(data);

      const roastText = await runCli(['postmortem', '--demo', '--roast']);
      assert.equal(roastText.exitCode, 0);
      assert.ok(roastText.output.includes('[Highbeam Postmortem]'));
    });

    it('3.4 postmortem live mode scans sessions directory and handles corrupt transcripts safely', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-postmortem-corrupt-'));
      const brainDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain');
      const corruptSess = path.join(brainDir, 'corrupt-sess');
      fs.mkdirSync(corruptSess, { recursive: true });

      // Put corrupted JSON in session directory
      fs.writeFileSync(path.join(corruptSess, 'session.json'), 'NOT_VALID_JSON{', 'utf8');

      const res = await runCli(['postmortem', '--json'], { homeDir: tmpHome });
      assert.equal(res.exitCode, 0);
      assert.ok(res.data);

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // SECTION 4: bin/ctxtop.mjs control Subcommand Adversarial Stress
  // =========================================================================
  describe('Section 4: bin/ctxtop.mjs control Adversarial Stress', () => {
    it('4.1 control without action returns exitCode 1 and lists valid actions', () => {
      const res = runCli(['control']);
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes('Invalid control action'));
      assert.ok(res.output.includes('pause, resume, step, abort'));
      assert.ok(res.output.includes('rewind'));
    });

    it('4.2 control with invalid actions returns exitCode 1', () => {
      const badActions = ['foo', 'destroy', 'restart', '123', 'null', 'undefined'];
      for (const act of badActions) {
        const res = runCli(['control', act]);
        assert.equal(res.exitCode, 1, `Action "${act}" must fail`);
        assert.ok(res.output.includes('Invalid control action'));
      }
    });

    it('4.3 control handles case-insensitive actions (PAUSE, Step, REWIND)', () => {
      const testSession = `test-case-${Date.now()}`;
      try {
        const r1 = runCli(['control', 'PAUSE', '--session', testSession]);
        assert.equal(r1.exitCode, 0);
        assert.equal(r1.data.state.state, 'PAUSED');

        const r2 = runCli(['control', 'Step', '--session', testSession]);
        assert.equal(r2.exitCode, 0);
        assert.equal(r2.data.state.state, 'STEP');

        const r3 = runCli(['control', 'ReWinD', '--session', testSession, '--target', '3']);
        assert.equal(r3.exitCode, 0);
        assert.equal(r3.data.state.state, 'REWIND');
        assert.equal(r3.data.state.rewindTarget, '3');
      } finally {
        const ctlPath = path.join(os.homedir(), '.ctxtop', 'runtime', `${testSession}.ctl`);
        try { fs.unlinkSync(ctlPath); } catch (_err) { void _err; }
      }
    });

    it('4.4 control rewind supports various target formats (--target, --turn, positional)', () => {
      const sess = `test-targets-${Date.now()}`;
      try {
        // --target 0
        const r0 = runCli(['control', 'rewind', '--session', sess, '--target', '0']);
        assert.equal(r0.exitCode, 0);
        assert.equal(r0.data.state.rewindTarget, '0');

        // --turn 4
        const rTurn = runCli(['control', 'rewind', '--session', sess, '--turn', '4']);
        assert.equal(rTurn.exitCode, 0);
        assert.equal(rTurn.data.state.rewindTarget, '4');

        // positional target
        const rPos = runCli(['control', 'rewind', 'turn_9', '--session', sess]);
        assert.equal(rPos.exitCode, 0);
        assert.equal(rPos.data.state.rewindTarget, 'turn_9');

        // trailing --target without value
        const rTrail = runCli(['control', 'rewind', '--session', sess, '--target']);
        assert.equal(rTrail.exitCode, 0);
        assert.equal(rTrail.data.state.state, 'REWIND');
      } finally {
        const ctlPath = path.join(os.homedir(), '.ctxtop', 'runtime', `${sess}.ctl`);
        try { fs.unlinkSync(ctlPath); } catch (_err) { void _err; }
      }
    });

    it('4.5 control recovers gracefully from pre-existing corrupted .ctl file', () => {
      const sess = `corrupt-ctl-${Date.now()}`;
      const runtimeDir = path.join(os.homedir(), '.ctxtop', 'runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const ctlPath = path.join(runtimeDir, `${sess}.ctl`);

      // Write garbage binary/corrupted bytes into .ctl file
      fs.writeFileSync(ctlPath, '<<<CORRUPTED_NON_JSON_BYTES_!@#$%^>>>', 'utf8');

      try {
        const res = runCli(['control', 'rewind', '--session', sess, '--target', '2']);
        assert.equal(res.exitCode, 0, 'Must recover from corrupted .ctl file without throwing');
        assert.equal(res.data.state.state, 'REWIND');
        assert.equal(res.data.state.rewindTarget, '2');

        const statusRes = runCli(['control', 'status', '--session', sess]);
        assert.equal(statusRes.exitCode, 0);
        assert.equal(statusRes.data.state.state, 'REWIND');
      } finally {
        try { fs.unlinkSync(ctlPath); } catch (_err) { void _err; }
      }
    });

    it('4.6 control status on non-existent session returns default RUNNING state', () => {
      const missingSess = `missing-session-${Date.now()}`;
      const res = runCli(['control', 'status', '--session', missingSess]);
      assert.equal(res.exitCode, 0);
      assert.ok(res.output.includes('is RUNNING'));
      assert.equal(res.data.state.state, 'RUNNING');
    });

    it('4.7 control resists session ID path traversal attacks without crashing', () => {
      const res = runCli(['control', 'rewind', '--session', '../../escaped/target/path']);
      assert.equal(res.exitCode, 1, 'Path traversal must return exitCode 1 without unhandled throw');
      assert.ok(res.output.includes('Failed to transition control state'));
    });
  });

  // =========================================================================
  // SECTION 5: bin/ctxtop.mjs inspect Subcommand Adversarial Stress
  // =========================================================================
  describe('Section 5: bin/ctxtop.mjs inspect Adversarial Stress', () => {
    it('5.1 inspect non-existent session returns exitCode 1 and helpful error', () => {
      const nonExistent = '00000000-dead-beef-0000-000000000000';
      const res = runCli(['inspect', nonExistent]);
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes(`Session "${nonExistent}" not found.`));
      assert.equal(res.data.found, false);
    });

    it('5.2 inspect without session argument returns exitCode 1', () => {
      const res = runCli(['inspect']);
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes('not found'));
    });

    it('5.3 inspect handles corrupted JSON in .claude/cache safely', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-inspect-corrupt-'));
      const cacheDir = path.join(tmpHome, '.claude', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      const corruptId = 'corrupt-cache-session';
      fs.writeFileSync(path.join(cacheDir, `ah_live_state_${corruptId}.json`), '{INVALID_JSON_CORRUPT', 'utf8');

      const res = runCli(['inspect', corruptId], { homeDir: tmpHome, cwd: tmpHome });
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes('not found'));

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('5.4 inspect handles corrupted JSONL in ~/.ctxtop/sessions safely', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-inspect-jsonl-'));
      const sDir = path.join(tmpHome, '.ctxtop', 'sessions');
      fs.mkdirSync(sDir, { recursive: true });

      const corruptId = 'corrupt-jsonl-session';
      fs.writeFileSync(path.join(sDir, `${corruptId}.jsonl`), '{"type": "start"}\nCORRUPTED_LINE\n', 'utf8');

      const res = runCli(['inspect', corruptId], { homeDir: tmpHome, cwd: tmpHome });
      assert.equal(res.exitCode, 1);
      assert.ok(res.output.includes('not found'));

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('5.5 inspect --last selects most recently modified cache session', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-inspect-last-'));
      const cacheDir = path.join(tmpHome, '.claude', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      const oldSess = path.join(cacheDir, 'ah_live_state_old_session.json');
      const newSess = path.join(cacheDir, 'ah_live_state_new_session.json');

      fs.writeFileSync(oldSess, JSON.stringify({ sessionId: 'old_session', turnsCompleted: 2 }), 'utf8');
      await new Promise((r) => setTimeout(r, 40));
      fs.writeFileSync(newSess, JSON.stringify({ sessionId: 'new_session', turnsCompleted: 9 }), 'utf8');

      const res = runCli(['inspect', '--last', '--json'], { homeDir: tmpHome, cwd: tmpHome });
      assert.equal(res.exitCode, 0);
      assert.equal(res.data.sessionId, 'new_session');
      assert.equal(res.data.turnsCompleted, 9);

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('5.6 inspect normalizes Antigravity session directory to canonical USTF v1', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-inspect-ag-'));
      const brainDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain');
      const agId = 'ag-test-session-1';
      const agDir = path.join(brainDir, agId);
      fs.mkdirSync(agDir, { recursive: true });
      fs.writeFileSync(path.join(agDir, 'task.md'), '# Plan\n- [x] Done', 'utf8');

      const res = runCli(['inspect', agId, '--json'], { homeDir: tmpHome });
      assert.equal(res.exitCode, 0);
      assert.equal(res.data.sessionId, agId);
      assert.equal(res.data.harness, 'antigravity');
      assert.ok('events' in res.data);
      assert.ok('spans' in res.data);

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('5.7 inspect writes trajectory to --out artifact path and creates directories', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-inspect-out-'));
      const cacheDir = path.join(tmpHome, '.claude', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      const sessId = 'inspect-out-sess';
      fs.writeFileSync(path.join(cacheDir, `ah_live_state_${sessId}.json`), JSON.stringify({
        sessionId: sessId,
        modelId: 'claude-sonnet-5-5',
        contextWindow: { totalInputTokens: 80000, cachedTokens: 64000 }
      }), 'utf8');

      const outArtifact = path.join(tmpHome, 'deep', 'artifacts', 'trajectory.json');
      const res = runCli(['inspect', sessId, '--out', outArtifact], { homeDir: tmpHome, cwd: tmpHome });

      assert.equal(res.exitCode, 0);
      assert.ok(fs.existsSync(outArtifact), 'Output artifact must be written');
      assert.ok(res.output.includes('Artifact written:'));

      const loaded = JSON.parse(fs.readFileSync(outArtifact, 'utf8'));
      assert.equal(loaded.sessionId, sessId);
      assert.equal(loaded.usage.uncached, 16000);
      assert.equal(loaded.usage.cacheRead, 64000);

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // SECTION 6: Features 33, 34, 35 UI Surfaces & Studio Artifacts
  // =========================================================================
  describe('Section 6: UI Surfaces & Studio Artifacts', () => {
    it('6.1 AbovePrompt HUD band strictly renders 1 line with 40-cell grid and Coach pill', () => {
      const band = renderAbovePromptBand({}, { columns: 110 });
      assert.ok(band);
      assert.equal(typeof band.line, 'string');
      assert.equal(band.line.includes('\n'), false, 'AbovePrompt band must contain 0 newlines');
      assert.equal(band.line.includes('\r'), false, 'AbovePrompt band must contain 0 carriage returns');
      assert.ok(band.plainLine.includes('[COACH]') || band.plainLine.includes('COACH'));
    });

    it('6.2 Claude Code docked /horizon pane renders 4-Rank Simple HUD by default', () => {
      const res = renderSimpleViewPane({}, { viewMode: 'SIMPLE_4_RANK' });
      assert.ok(res);
      assert.ok(res.ranks, 'Must return ranks structure');
      assert.equal(res.ranks.length, 4, 'Must return strictly 4 ranks for SIMPLE_4_RANK');
      assert.equal(res.title, 'Highbeam');
      assert.ok(res.text.includes('[Rank 1]'));
      assert.ok(res.text.includes('[Rank 2]'));
      assert.ok(res.text.includes('[Rank 3]'));
      assert.ok(res.text.includes('[Rank 4]'));
    });

    it('6.3 Advanced Workbench Section 3 references DET-01..32 and DET-30 loop detector', () => {
      const adv = renderAdvancedViewPane({}, {});
      assert.ok(adv.text.includes('DET-01..32'), 'Must reference DET-01..32 catalog');
      assert.ok(adv.text.includes('DET-30'), 'Must reference DET-30 scratchpad loop detector');
    });

    it('6.4 emitHorizonWidget generates zero-socket self-contained HTML and outputs <agent-embed>', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-widget-'));
      const widgetPath = path.join(tmpDir, 'test_widget.html');

      const result = await emitHorizonWidget({ out: widgetPath, silent: true });
      assert.equal(result.ok, true);
      assert.ok(fs.existsSync(widgetPath));
      assert.ok(result.embedTag.startsWith('<agent-embed src="file:///'));
      assert.ok(result.embedTag.endsWith('"></agent-embed>'));

      const html = fs.readFileSync(widgetPath, 'utf8');
      assert.ok(html.includes('Highbeam') || html.includes('ctxtop'));
      // Invariant: Plain-Text /compact instruction without copy buttons
      assert.ok(html.includes('id="compactInstruction"'));
      assert.ok(html.includes('id="compactReclaim"'));
      assert.equal(html.includes('btnCompactPrimary'), false);
      assert.equal(html.includes('copyCompactWithGuidance'), false);

      // Zero socket invariant
      assert.equal(html.includes('ws://'), false);
      assert.equal(html.includes('wss://'), false);
      assert.equal(html.includes('http://'), false);
      assert.equal(html.includes('https://'), false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // SECTION 7: Features 36–40 Hard Invariants & Mirror Parity
  // =========================================================================
  describe('Section 7: Features 36–40 Hard Architectural & UI Invariants', () => {
    it('7.1 Feature 36: Plain-Text /compact Instruction Invariant (0 copy buttons, 0 paste hints)', () => {
      const panelPath = path.join(PKG_ROOT, 'src', 'webview', 'horizon_panel.html');
      const panelHtml = fs.readFileSync(panelPath, 'utf8');

      // 1. Mandatory plain text instruction present
      assert.ok(
        panelHtml.includes('Type <kbd class="cmd-kbd">/compact</kbd> in the chat box and press <kbd>Enter</kbd>') ||
        panelHtml.includes('Type /compact in the chat box and press Enter'),
        'Must render plain-text instruction for /compact'
      );
      assert.ok(panelHtml.includes('id="compactInstruction"'), 'Must have #compactInstruction element');
      assert.ok(panelHtml.includes('id="compactReclaim"'), 'Must have #compactReclaim element');

      // 2. Strict prohibition: NO copy buttons, NO copy functions for /compact
      assert.equal(panelHtml.includes('btnCompactPrimary'), false, 'Prohibited: #btnCompactPrimary copy button');
      assert.equal(panelHtml.includes('copyCompactWithGuidance'), false, 'Prohibited: copyCompactWithGuidance handler');

      // 3. Compact instruction area must NOT contain paste hint or buttons
      const compactInstructionBlock = panelHtml.slice(
        panelHtml.indexOf('id="actionRowCompact"'),
        panelHtml.indexOf('id="actionRowHighLeverage"')
      );
      assert.equal(compactInstructionBlock.includes('Ctrl+V'), false, 'No Ctrl+V paste hint in /compact instruction');
      assert.equal(compactInstructionBlock.includes('<button'), false, 'No button in /compact instruction block');
    });

    it('7.2 Feature 37: Active Source Code Protection Invariant (isIgnorablePath strictly false)', () => {
      const activeSourceFiles = [
        'src/index.js',
        'src/app.mjs',
        'src/core.ts',
        'src/module.tsx',
        'src/main.py',
        'src/lib.rs',
        'src/main.go',
        'bin/ctxtop.mjs',
        'bin/ah-statusline.mjs',
        'hooks/register.js'
      ];

      for (const src of activeSourceFiles) {
        assert.equal(
          isIgnorablePath(src),
          false,
          `isIgnorablePath must strictly return false for active source file: ${src}`
        );
        assert.equal(
          isIgnorableClaudePath(src),
          false,
          `isIgnorableClaudePath must strictly return false for active source file: ${src}`
        );
      }

      const nonSourceFiles = [
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'npm-debug.log',
        'build.log',
        'dist/bundle.js.map'
      ];

      for (const nonSrc of nonSourceFiles) {
        assert.equal(
          isIgnorablePath(nonSrc),
          true,
          `isIgnorablePath must return true for artifact: ${nonSrc}`
        );
      }
    });

    it('7.3 Feature 38: Byte-for-Byte SHA-256 Parity Across All 633 Mirrored Files', () => {
      const parityResult = syncAndVerifyMirrors({ verifyOnly: true, silent: true });
      assert.equal(
        parityResult.parityOk,
        true,
        `Mirror parity failed with ${parityResult.diffCount} mismatch(es)`
      );
      assert.equal(parityResult.targets, 8, 'Must verify all 8 HTML targets');
      assert.equal(parityResult.verifiedFilePairs, 633, 'Must verify 633 mirrored file pairs');
    });

    it('7.4 Feature 39: Zero Outbound Sockets Invariant in bin/ entrypoints', () => {
      const ctxtopCode = fs.readFileSync(path.join(PKG_ROOT, 'bin', 'ctxtop.mjs'), 'utf8');
      const statuslineCode = fs.readFileSync(path.join(PKG_ROOT, 'bin', 'ah-statusline.mjs'), 'utf8');

      for (const code of [ctxtopCode, statuslineCode]) {
        assert.equal(code.includes('http.request'), false);
        assert.equal(code.includes('https.request'), false);
        assert.equal(code.includes('fetch('), false);
        assert.equal(code.includes('WebSocket'), false);
      }
    });
  });
});
