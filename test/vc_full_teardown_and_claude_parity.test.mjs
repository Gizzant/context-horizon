import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import register from '../hooks/register.js';
import { buildDemoHorizonState } from '../src/demo/synthetic_states.mjs';
import { getCodexSessionsDir, getGeminiCliChatsDirs } from '../src/core/paths.mjs';
import {
  discoverCodexSessions,
  parseCodexRolloutJsonl,
  discoverGeminiCliSessions,
  parseGeminiCliChatJson
} from '../src/core/parser.mjs';
import { computeCompactLineDiff } from '../src/core/pruner.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { readLedgerEntries } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { runCli } from '../bin/ctxtop.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

describe('Full VC Teardown (Sections 1–4) & Claude Code Extension Parity Suite', () => {
  describe('Component 1: Claude Code Extension Parity & Lean Hook Alignment', () => {
    it('renders 6 Core Auditable Guards (32 rules) and PDF receipt command in Claude Studio HTML', () => {
      const { html } = renderHorizonPanelHtml({
        sessionId: 'cc-test-parity',
        activeModel: 'claude-sonnet-4-6',
        flightMode: 'COACH',
        window: { usedTokens: 64000, maxTokens: 200000, safeLimit: 140000 }
      });

      assert.ok(
        html.includes('3. 6 Core Auditable Guards (32 rules) &amp; Thinking Drift') ||
          html.includes('3. 6 Core Auditable Guards (32 rules) & Thinking Drift'),
        'Claude Studio Accordion 3 must display 6 Core Auditable Guards (32 rules)'
      );
      assert.ok(
        html.includes('6 Core Guards quiet (32 rules)'),
        'Claude Studio nominal summary must state 6 Core Guards quiet (32 rules)'
      );
      assert.ok(
        !html.includes('DET-01..21'),
        'Stale DET-01..21 string must be completely removed from Claude Studio HTML'
      );
      assert.ok(
        html.includes('npx ah receipt --pdf'),
        'Claude Studio Accordion 1 must advertise npx ah receipt --pdf'
      );
    });

    it('registers all 6 slash commands in .claude-plugin/plugin.json and verifies lean hooks/hooks.json matchers', () => {
      const pluginJsonPath = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json');
      const pluginManifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      const expectedCommands = [
        './commands/horizon.md',
        './commands/cost-radar.md',
        './commands/inspect.md',
        './commands/handoff.md',
        './commands/precheck.md',
        './commands/evolve.md'
      ];
      assert.deepEqual(pluginManifest.commands, expectedCommands);

      for (const relCmd of expectedCommands) {
        const absCmd = path.join(REPO_ROOT, relCmd);
        assert.ok(fs.existsSync(absCmd), `Slash command file must exist: ${relCmd}`);
        const cmdText = fs.readFileSync(absCmd, 'utf8');
        assert.match(cmdText, /^---\r?\ndescription:/, `${relCmd} must have YAML frontmatter description`);
      }

      const ccHooksPath = path.join(REPO_ROOT, 'hooks', 'hooks.json');
      const ccHooks = JSON.parse(fs.readFileSync(ccHooksPath, 'utf8'));
      const preMatcher = ccHooks.hooks.PreToolUse[0].matcher;
      const postMatcher = ccHooks.hooks.PostToolUse[0].matcher;
      assert.ok(!preMatcher.includes('Grep'), 'Default PreToolUse matcher must exclude Grep');
      assert.ok(!preMatcher.includes('Glob'), 'Default PreToolUse matcher must exclude Glob');
      assert.ok(!postMatcher.includes('Grep'), 'Default PostToolUse matcher must exclude Grep');
      assert.ok(!postMatcher.includes('Glob'), 'Default PostToolUse matcher must exclude Glob');
      assert.ok(preMatcher.includes('Read'), 'Default PreToolUse matcher must retain Read for GUARD-4');
    });

    it('tracks unclipped Read calls in-process inside hooks/register.js and emits GUARD-4 advisory on 3rd Read', async () => {
      const handlers = {};
      register((evt, fn) => {
        handlers[evt] = fn;
      });
      const store = new Map();
      const mockCtx = {
        store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
        ui: { open: () => {}, invalidate: () => {} },
        clock: { every: () => () => {} }
      };

      await handlers['classic.SessionStart']({ session_id: 'mod-read-test' }, mockCtx);

      const readEvt = {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/src/engine/heavyModule.ts' }
      };

      const r1 = await handlers['tool.call'](readEvt, mockCtx);
      const r2 = await handlers['tool.call'](readEvt, mockCtx);
      const r3 = await handlers['tool.call'](readEvt, mockCtx);

      assert.equal(r1, undefined, '1st unclipped Read in Mod path should pass silently');
      assert.equal(r2, undefined, '2nd unclipped Read in Mod path should pass silently');
      assert.ok(
        r3 && typeof r3.additionalContext === 'string' && r3.additionalContext.includes('[GUARD-4 Repeat-Read Surgeon]'),
        `3rd unclipped Read in Mod path must emit GUARD-4 Repeat-Read Surgeon advisory, got: ${JSON.stringify(r3)}`
      );
    });
  });

  describe('Component 2: Dual-Host Interactive Demo Showcase (docs/index.html)', () => {
    it('renders the Host Surface switcher ([Antigravity IDE] / [Claude Code Studio + CLI]) and ?surface=claude deep link', async () => {
      const demoHtmlPath = path.join(REPO_ROOT, 'docs', 'index.html');
      assert.ok(fs.existsSync(demoHtmlPath), 'docs/index.html must exist');
      const demoHtml = fs.readFileSync(demoHtmlPath, 'utf8');

      const dom = new JSDOM(demoHtml, {
        url: 'http://127.0.0.1:62935/?surface=claude&scenario=4',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
          w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
          w.EventSource = class { addEventListener() {} close() {} };
          w.navigator.clipboard = { writeText: async () => {} };
        }
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const { window } = dom;
        const doc = window.document;

        const toggle = doc.getElementById('chSurfaceToggle');
        const ccMount = doc.getElementById('ccDemoMount');
        const statusLine = doc.getElementById('ccDemoStatusLine');
        const abovePrompt = doc.getElementById('ccDemoAbovePrompt');
        const studioFrame = doc.getElementById('ccStudioFrame');

        assert.ok(toggle, '#chSurfaceToggle must be injected into docs/index.html');
        assert.ok(ccMount, '#ccDemoMount must be injected into docs/index.html');
        assert.equal(ccMount.classList.contains('active'), true, '?surface=claude must activate Claude Code showcase');
        assert.equal(doc.body.getAttribute('data-demo-surface'), 'claude');
        assert.ok((statusLine?.textContent || '').length > 10, 'Claude CLI StatusLine must be populated');
        assert.ok((abovePrompt?.textContent || '').length > 5, 'Claude AbovePrompt band must be populated');
        assert.ok(
          (studioFrame?.getAttribute('srcdoc') || '').includes('6 Core Auditable Guards (32 rules)'),
          'Embedded Claude Studio iframe srcdoc must contain 6 Core Auditable Guards (32 rules)'
        );

        window.__setDemoSurface('antigravity');
        assert.equal(doc.body.getAttribute('data-demo-surface'), 'antigravity');
        assert.equal(ccMount.classList.contains('active'), false);
      } finally {
        dom.window.close();
      }
    });
  });

  describe('Component 3: Harness-Aware Physical Watermarks & 5-Host Read-Only Log Discovery', () => {
    it('renders harness-specific physical cliffs in horizon_panel.html and persists ah.viewMode', () => {
      const htmlPath = path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html');
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');
      const dom = new JSDOM(htmlContent, {
        url: 'http://127.0.0.1:62935/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
          w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
          w.EventSource = class { addEventListener() {} close() {} };
          w.navigator.clipboard = { writeText: async () => {} };
        }
      });

      try {
        const { window } = dom;
        const doc = window.document;
        const baseState = buildDemoHorizonState(1);

        // 1. Claude Haiku 5.5 -> 100k 5x Cliff + anthropic-pricing-tier
        window.renderState({
          ...baseState,
          harness: 'claude-code',
          activeModel: 'claude-haiku-5-5',
          window: { ...baseState.window, maxTokens: 200000, safeLimit: 140000 }
        });
        assert.equal(doc.getElementById('cascadeWatermarkLine').hidden, false);
        assert.equal(doc.getElementById('cascadeWatermarkTag').textContent, '100k 5x Cliff');
        assert.equal(doc.getElementById('hardCeilingLine').dataset.source, 'anthropic-pricing-tier');

        // 2. Claude Opus 4.6 (1M context) -> 200k Pricing Cliff
        window.renderState({
          ...baseState,
          harness: 'claude-code',
          activeModel: 'claude-opus-4-6',
          window: { ...baseState.window, maxTokens: 1000000, safeLimit: 700000 }
        });
        assert.equal(doc.getElementById('cascadeWatermarkLine').hidden, false);
        assert.equal(doc.getElementById('cascadeWatermarkTag').textContent, '200k Pricing Cliff');

        // 3. OpenAI Codex CLI -> hides Antigravity 50k Sync watermark + host-context-window source
        window.renderState({
          ...baseState,
          harness: 'codex',
          activeModel: 'gpt-5-codex',
          window: { ...baseState.window, maxTokens: 400000, safeLimit: 280000 }
        });
        assert.equal(doc.getElementById('cascadeWatermarkLine').hidden, true);
        assert.equal(doc.getElementById('hardCeilingLine').dataset.source, 'host-context-window');

        // 4. Antigravity default -> 50k Sync + cortex/utils.GetCheckpointConfig
        window.renderState({
          ...baseState,
          harness: 'antigravity',
          activeModel: 'gemini-2.5-pro',
          window: { ...baseState.window, maxTokens: 256000, safeLimit: 179200 }
        });
        assert.equal(doc.getElementById('cascadeWatermarkLine').hidden, false);
        assert.equal(doc.getElementById('cascadeWatermarkTag').textContent, '50k Sync');
        assert.equal(doc.getElementById('hardCeilingLine').dataset.source, 'cortex/utils.GetCheckpointConfig');

        // 5. ah.viewMode localStorage persistence
        const btnAdv = doc.querySelector('[data-view-tab="advanced"]');
        assert.ok(btnAdv, '[data-view-tab="advanced"] must exist');
        btnAdv.click();
        assert.equal(window.localStorage.getItem('ah.viewMode'), 'advanced');
      } finally {
        dom.window.close();
      }
    });

    it('discovers and parses OpenAI Codex CLI (.jsonl) and Google Gemini CLI (.json) transcripts strictly read-only when opted in', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-5host-'));
      try {
        // Default off when harness flag is not provided
        assert.equal(getCodexSessionsDir(tmpHome, {}), '');
        assert.deepEqual(getGeminiCliChatsDirs(tmpHome, {}), []);

        // Create Codex rollout fixture
        const codexDir = path.join(tmpHome, '.codex', 'sessions', '2026', '11', '12');
        fs.mkdirSync(codexDir, { recursive: true });
        const codexFile = path.join(codexDir, 'rollout-codex-001.jsonl');
        fs.writeFileSync(
          codexFile,
          [
            JSON.stringify({
              type: 'session_meta',
              payload: { id: 'codex-sess-001', cwd: '/repo/demo', model: 'gpt-5-codex' }
            }),
            JSON.stringify({
              role: 'user',
              content: [{ type: 'input_text', text: 'Audit token retention across worker pool' }]
            }),
            JSON.stringify({
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: { last_token_usage: { input_tokens: 48200, cached_input_tokens: 41000 } }
              }
            })
          ].join('\n') + '\n',
          'utf8'
        );

        // Create Gemini CLI chat fixture
        const gemChatDir = path.join(tmpHome, '.gemini', 'tmp', 'projhash123', 'chats');
        fs.mkdirSync(gemChatDir, { recursive: true });
        const gemFile = path.join(gemChatDir, 'session-gem-001.json');
        fs.writeFileSync(
          gemFile,
          JSON.stringify({
            sessionId: 'gem-cli-001',
            messages: [
              { type: 'user', content: 'Inspect Gemini CLI cache hit ratio' },
              {
                type: 'gemini',
                model: 'gemini-2.5-pro',
                content: 'Cache hit ratio is 94.2%.',
                tokens: { input: 36500, cached: 34383 }
              }
            ]
          }),
          'utf8'
        );

        const codexList = discoverCodexSessions(tmpHome, { harness: 'codex' });
        assert.equal(codexList.length, 1);
        const parsedCodex = parseCodexRolloutJsonl(codexList[0].filePath);
        assert.equal(parsedCodex.sessionId, 'codex-sess-001');
        assert.equal(parsedCodex.surface, 'codex');
        assert.equal(parsedCodex.surfaceTag, '[Codex]');
        assert.equal(parsedCodex.genMetadata.totalContextTokens, 48200);
        assert.equal(parsedCodex.genMetadata.cacheReadTokens, 41000);

        const gemList = discoverGeminiCliSessions(tmpHome, { harness: 'gemini-cli' });
        assert.equal(gemList.length, 1);
        const parsedGem = parseGeminiCliChatJson(gemList[0].filePath);
        assert.equal(parsedGem.sessionId, 'gem-cli-001');
        assert.equal(parsedGem.surface, 'gemini-cli');
        assert.equal(parsedGem.surfaceTag, '[Gemini CLI]');
        assert.equal(parsedGem.genMetadata.totalContextTokens, 36500);
        assert.equal(parsedGem.genMetadata.cacheReadTokens, 34383);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  describe('Component 4: Post-Edit Unified Delta Diffs on Repeat File Reads', () => {
    it('computes compact unified line diffs and returns deltaDiffStub across Claude Code and Antigravity hooks when a file changes between reads', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-delta-diff-'));
      try {
        const targetFile = path.join(tmpDir, 'routerService.mjs');
        const linesV1 = [];
        for (let i = 1; i <= 60; i += 1) {
          linesV1.push(`export function routeStep${i}(ctx) { return ctx.tokens + ${i}; }`);
        }
        const v1 = linesV1.join('\n') + '\n';

        const linesV2 = [...linesV1];
        linesV2[29] = 'export function routeStep30(ctx) { return Math.max(0, ctx.tokens - 1024); }';
        const v2 = linesV2.join('\n') + '\n';

        const directDiff = computeCompactLineDiff(v1, v2, 'routerService.mjs');
        assert.equal(directDiff.wasDiffed, true);
        assert.ok(directDiff.savedTokens > 100, `Expected >100 savedTokens, got ${directDiff.savedTokens}`);
        assert.ok(directDiff.diffText.includes('-export function routeStep30(ctx) { return ctx.tokens + 30; }'));
        assert.ok(directDiff.diffText.includes('+export function routeStep30(ctx) { return Math.max(0, ctx.tokens - 1024); }'));

        // 1. Claude Code PreToolUse hook: Read #1 snapshots v1, Edit to v2, Read #2 returns deltaDiffStub
        fs.writeFileSync(targetFile, v1, 'utf8');
        const ccSid = 'cc-delta-session-1';
        runPreToolUseHook(
          { session_id: ccSid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: targetFile } },
          { cwd: tmpDir }
        );

        fs.writeFileSync(targetFile, v2, 'utf8');
        const ccRead2 = runPreToolUseHook(
          { session_id: ccSid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: targetFile } },
          { cwd: tmpDir }
        );
        assert.equal(ccRead2.verdict.triggered, true);
        assert.ok(
          typeof ccRead2.verdict.deltaDiffStub === 'string' &&
            ccRead2.verdict.deltaDiffStub.includes('+export function routeStep30'),
          'Claude Code PreToolUse must emit deltaDiffStub when file changed since prior read'
        );

        // 2. Antigravity PreToolUse hook: Read #1 snapshots v1, Edit to v2, Read #2 returns deltaDiffStub
        const agyTarget = path.join(tmpDir, 'agyService.mjs');
        fs.writeFileSync(agyTarget, v1, 'utf8');
        const agySid = 'agy-delta-session-1';
        await handlePreToolUse({
          conversation_id: agySid,
          cwd: tmpDir,
          tool_name: 'read_file',
          tool_input: { Path: agyTarget }
        });

        fs.writeFileSync(agyTarget, v2, 'utf8');
        const agyRead2 = await handlePreToolUse({
          conversation_id: agySid,
          cwd: tmpDir,
          tool_name: 'read_file',
          tool_input: { Path: agyTarget }
        });
        assert.ok(
          typeof agyRead2.deltaDiffStub === 'string' &&
            agyRead2.deltaDiffStub.includes('+export function routeStep30'),
          'Antigravity handlePreToolUse must emit deltaDiffStub when file changed since prior read'
        );

        const ledger = readLedgerEntries({ cwd: tmpDir });
        assert.ok(
          ledger.some((e) => e.category === 'BOUNDED_READ_ENFORCED' && Number(e.savedTokens) > 0),
          'Saved-quota ledger must record BOUNDED_READ_ENFORCED savings from post-edit delta diff'
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Component 5: N=10,000 SLA Gates, D5 Security Metrics, A/B Compression Table & CHECKSUMS.sha256', () => {
    it('certifies N=10,000 hot-path SLA samples and populated D5 CSRF / PII-scrub metrics in composite_benchmark_results.json', () => {
      const benchPath = path.join(REPO_ROOT, 'docs', 'composite_benchmark_results.json');
      const report = JSON.parse(fs.readFileSync(benchPath, 'utf8'));

      assert.equal(report.dimensions.D1.metrics.spanTracking.sampleSize, 10000);
      assert.equal(report.dimensions.D2.metrics.retentionDiffing.sampleSize, 10000);
      assert.equal(report.slaCertification?.allPassed, true);
      assert.equal(report.dimensions.D5.metrics.csrfRejection?.falseAllowRate, 0);
      assert.equal(report.dimensions.D5.metrics.sanitizedExportPiiScrub?.leakedPiiCount, 0);
    });

    it('publishes reproducible A/B Before/After token compression benchmarks in docs/ab_compression_benchmarks.json', () => {
      const abPath = path.join(REPO_ROOT, 'docs', 'ab_compression_benchmarks.json');
      assert.ok(fs.existsSync(abPath), 'docs/ab_compression_benchmarks.json must exist');
      const abReport = JSON.parse(fs.readFileSync(abPath, 'utf8'));

      assert.equal(abReport.workloads.length, 4);
      for (const w of abReport.workloads) {
        assert.ok(w.reductionPct > 30, `Workload ${w.id} must achieve >30% compression (got ${w.reductionPct}%)`);
        assert.equal(w.criticalSignalPreserved, true, `Workload ${w.id} must preserve critical signals`);
      }
      assert.ok(abReport.aggregate.overallReductionPct > 50);
    });

    it('verifies release manifest integrity via npx ah verify --json against CHECKSUMS.sha256', async () => {
      const res = await runCli(['verify', '--json'], { rootDir: REPO_ROOT });
      assert.equal(res.exitCode, 0, `Expected exitCode 0, got: ${res.output}`);
      assert.equal(res.data.valid, true);
      assert.ok(res.data.verifiedCount >= 100, `Expected >=100 verified release files, got ${res.data.verifiedCount}`);
      assert.deepEqual(res.data.mismatches, []);
    });
  });
});
