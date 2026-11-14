import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import { classifyHorizon } from '../src/core/classifier.mjs';
import {
  renderClassifierHudHtml,
  formatCliStatusLine,
  visibleWidth
} from '../src/cli/horizon_hud.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

function makeStep(idx, overrides = {}) {
  return {
    stepIndex: idx,
    type: idx === 0 ? 'SYSTEM_PROMPT' : 'PLANNER_RESPONSE',
    source: idx === 0 ? 'SYSTEM' : 'MODEL',
    status: 'DONE',
    content: '',
    outputTokens: 1000,
    toolCalls: [],
    ...overrides
  };
}

function makeColdCache(state) {
  state.quota = state.quota || {};
  state.quota.cache = {
    ...(state.quota.cache || {}),
    cacheReadTokens: 0,
    hitRatePct: 0,
    isCacheCold: true,
    prefixBustDetected: false,
    prefixBustCause: null,
    ttlRemainingSec: 0,
    nextTurnLikelyWarm: false
  };
  return state;
}

async function mountPanelDom() {
  let rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
  rawHtml = rawHtml.replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const jsdomErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
  let wsCallback = null;
  const dom = new JSDOM(rawHtml, {
    url: 'http://127.0.0.1:43210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.EventSource = class { close() {} };
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      win.sidecar = { onWorkspaceChange: (cb) => { wsCallback = cb; } };
    }
  });
  await new Promise((r) => setTimeout(r, 80));
  return {
    dom,
    win: dom.window,
    d: dom.window.document,
    getWsCallback: () => wsCallback,
    jsdomErrors
  };
}

describe('Top 10 Token Wasters — classifyHorizon + Horizon Panel UI Verification', () => {
  it('simulates all Top 10 Token Waster scenarios + Post-/compact reset across Simple & Advanced surfaces with zero JSDOM errors', async () => {
    const { dom, win, d, getWsCallback, jsdomErrors } = await mountPanelDom();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    const ws = 'c:/Projects/demo-workspace';

    try {
      // 1. Repeated Full-File Re-Reads (STALE_DUPLICATE)
      {
        const steps = [
          makeStep(0, { inputTokens: 12000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 1000, content: 'Inspect horizon_panel.html and server.mjs' }),
          makeStep(2, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
          makeStep(3, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
          makeStep(4, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
          makeStep(5, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
          makeStep(6, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
          makeStep(7, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] }),
          makeStep(8, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] }),
          makeStep(9, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] }),
          makeStep(10, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] })
        ];
        const st = makeColdCache(classifyHorizon(steps, { sessionId: 's1-reread', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        win.renderState(st);
        assert.equal(txt('tsStatusLabel'), 'Reclaimable Clutter High');
        assert.equal(txt('tsUsedLabel'), '81.0k');
        assert.equal(txt('tsValClutter'), '53.0k');
        assert.equal(txt('tsValSignal'), '28.0k');
        assert.notEqual(d.getElementById('tsBarSignal').style.width, '0%');
        assert.notEqual(d.getElementById('tsBarClutter').style.width, '0%');
        assert.match(txt('tsDoText'), /\/compact.*53\.0k clutter \(repeated file reads\)/i);
        assert.equal(d.getElementById('tsWhyClears').hidden, false);
        assert.match(txt('tsWhyList'), /Repeated file reads.*2 files.*53\.0k/);
        assert.equal(txt('tsWhyTotal'), '53.0k');
        assert.match(d.getElementById('taConsumersBody').textContent, /horizon_panel\.html/);
        assert.match(d.getElementById('taConsumersBody').textContent, /Active Source/);
        assert.equal(d.querySelectorAll('#taConsumersBody [data-ignore-path]').length, 0);
      }

      // 2. Uncompacted Older Chat History (>25 steps old) + Warm KV Cache
      {
        const steps = [makeStep(0, { inputTokens: 10000, content: 'rules/' })];
        for (let i = 1; i <= 10; i++) {
          steps.push(makeStep(i, { type: 'PLANNER_RESPONSE', outputTokens: 4000, content: `Legacy discussion turn alpha${i}` }));
        }
        for (let i = 11; i <= 34; i++) {
          steps.push(makeStep(i, { type: 'PLANNER_RESPONSE', outputTokens: 1000, content: `Active implementation step beta${i}` }));
        }
        steps.push(makeStep(35, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 1000, content: 'Continue refactor' }));
        const st = classifyHorizon(steps, { sessionId: 's2-hist', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws });
        st.model = { ...st.model, id: 'claude-opus-5.5', displayName: 'Claude Opus 5.5', rawLabel: 'Claude Opus 5.5 (Medium)' };
        st.quota.cache = {
          ...st.quota.cache,
          cacheReadTokens: 80000,
          hitRatePct: 88,
          isCacheCold: false,
          prefixBustDetected: false,
          ttlRemainingSec: 210,
          nextTurnLikelyWarm: true
        };
        win.renderState(st);
        assert.equal(txt('tsCacheMeta'), '88% hit · Warm (03:30)');
        assert.equal(txt('tsClutterKind'), 'Warm Reclaimable');
        assert.equal(txt('tsModelVerdict'), 'HOLD 03:30');
        assert.equal(txt('tsEffortVerdict'), 'HOLD 03:30');
        assert.equal(d.getElementById('tsBtnCleanPrimary').dataset.ctaState, 'guarded');
        assert.match(txt('tsWhyList'), /Earlier chat history.*10 old turns.*40\.0k/);
        assert.match(d.getElementById('taConsumersBody').textContent, /Cleared by \/compact/);
        assert.equal(d.querySelectorAll('#taConsumersBody [data-ignore-path]').length, 0);
      }

      // 3. Stuck Error & Stack-Trace Loop (DEAD_ERROR / isErrorLoop)
      {
        const steps = [
          makeStep(0, { inputTokens: 8000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Run tests' }),
          makeStep(2, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Error attempt 1', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
          makeStep(3, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Error attempt 2', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
          makeStep(4, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Error attempt 3', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
          makeStep(5, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Error attempt 4', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] })
        ];
        const st = makeColdCache(classifyHorizon(steps, { sessionId: 's3-err', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        win.renderState(st);
        assert.equal(txt('tsStatusLabel'), 'Error Loop Detected');
        assert.match(txt('tsDoText'), /Pause blind retries \(4× error loop\)/);
        assert.equal(txt('tsModelVerdict'), 'UPSHIFT OK');
        assert.equal(txt('tsEffortVerdict'), 'RAISE OK');
        assert.match(txt('tsWhyList'), /Error logs & loop traces[\s\S]*4 errors[\s\S]*24\.0k/);
        assert.ok(d.querySelectorAll('#taHorizonGrid .ta-cell[data-cat="error"]').length >= 1);
        d.querySelector('#taHorizonGrid .ta-cell[data-cat="error"]').click();
        assert.match(txt('taCellLeft'), /^Cell #\d+ · (?:Command: npm test|Resolved Stack Trace|Stale Error Trace)/);
        assert.match(txt('taCellRight'), /\d+\.\dk \/ cell · \d+\.\d\d recall/);
        assert.match(d.getElementById('taConsumersBody').textContent, /Error trace/);
      }

      // 4. Uncompressed Verbose CLI Output Spike (blowupSteps + FTS5 savings)
      {
        const steps = [
          makeStep(0, { inputTokens: 8000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Check lint' }),
          makeStep(2, { outputTokens: 1000, content: 'Checked' }),
          makeStep(3, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Now run full suite' }),
          makeStep(4, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Run verbose tests' }),
          makeStep(5, {
            outputTokens: 28000,
            exitCode: 0,
            content: 'Verbose test output...',
            toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test --verbose' } }]
          })
        ];
        const st = makeColdCache(classifyHorizon(steps, { sessionId: 's4-blowup', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        st.savings = {
          session: { totalPhysicalTokens: 14200, bySource: { cliCompressed: 14200 } },
          workspace30d: { totalPhysicalTokens: 14200 }
        };
        win.renderState(st);
        assert.equal(txt('tsStatusLabel'), 'Single-Turn Output Spike');
        assert.match(txt('tsDoText'), /28\.0k from npm test --verbose \(Turn #3\)/);
        assert.match(txt('tsLedgerList'), /FTS5[\s\S]*\+14\.2k/);
        assert.match(d.getElementById('taConsumersBody').textContent, /npm test --verbose[\s\S]*T3 spike[\s\S]*28\.0k[\s\S]*Output spike/);
      }

      // 5. Lockfiles & Build Logs (isIgnorablePath) vs. Active Source Protection
      {
        const steps = [
          makeStep(0, { inputTokens: 6000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Inspect deps and classifier' }),
          makeStep(2, { outputTokens: 10000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
          makeStep(3, { outputTokens: 10000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
          makeStep(4, { outputTokens: 10000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
          makeStep(5, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/build.log` } }] }),
          makeStep(6, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/build.log` } }] }),
          makeStep(7, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
          makeStep(8, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
          makeStep(9, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] })
        ];
        const st = makeColdCache(classifyHorizon(steps, { sessionId: 's5-ignorable', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        win.renderState(st);
        const ignoreBtns = Array.from(d.querySelectorAll('#taConsumersBody [data-ignore-path]')).map((el) => el.dataset.ignorePath);
        assert.equal(ignoreBtns.length, 2);
        assert.ok(ignoreBtns.some((p) => p.endsWith('package-lock.json')));
        assert.ok(ignoreBtns.some((p) => p.endsWith('build.log')));
        const rows = Array.from(d.querySelectorAll('#taConsumersBody tr'));
        const classifierRow = rows.find((r) => r.textContent.includes('classifier.mjs'));
        assert.ok(classifierRow, 'classifier.mjs must appear in Top Context Consumers');
        assert.match(classifierRow.textContent, /Active Source/);
        assert.equal(classifierRow.querySelector('[data-ignore-path]'), null);
      }

      // 6. Cross-Workspace Foreign Knowledge Bleed (FOREIGN_BLEED)
      {
        const steps = [
          makeStep(0, { inputTokens: 8000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Check memory' }),
          makeStep(2, { outputTokens: 19000, content: 'Loaded knowledge://legacy-billing-service runbook' })
        ];
        const st = makeColdCache(classifyHorizon(steps, {
          sessionId: 's6-bleed',
          modelId: 'claude-opus-5.5',
          useNativeCeiling: true,
          canonicalWorkspace: ws,
          kiBleedMap: new Map([['legacy-billing-service', { isBleed: true }]])
        }));
        win.renderState(st);
        assert.equal(txt('tsValClutter'), '19.0k');
        assert.equal(d.getElementById('tsWhyClears').hidden, false);
        assert.match(txt('tsWhyList'), /Cross-project memory bleed \(foreign KIs\)[\s\S]*19\.0k/);
        assert.equal(txt('tsWhyTotal'), '19.0k');
        assert.match(d.getElementById('taConsumersBody').textContent, /Foreign KI/);
      }

      // 7. Turn-0 Rules & Idle Eager MCP Schema Bloat (baseline + mcpAudit)
      {
        const steps = [
          makeStep(0, { inputTokens: 12000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Small edit' }),
          makeStep(2, { outputTokens: 2000, content: 'Applied small edit cleanly' })
        ];
        const st = makeColdCache(classifyHorizon(steps, { sessionId: 's7-turn0', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        st.baseline = { totalEst: 32400, eagerInjectionWarning: true };
        st.brainSignals.mcpAudit = {
          unusedEagerServers: [
            { name: 'powerbi-modeling-mcp', schemaTokens: 20875 },
            { name: 'notebooklm', schemaTokens: 10825 }
          ],
          reclaimableEagerSchemaTokens: 31700
        };
        win.renderState(st);
        assert.equal(txt('tsStatusLabel'), 'Turn-0 Prefix Bloat');
        assert.match(txt('tsDoText'), /Switch 2 idle eager MCPs to lazy loading to save ~31\.7k at Turn 0/);
        assert.match(txt('taBaselineText'), /32\.4k \/ 20\.0k budget/);
        assert.match(txt('taActionQueue'), /2 idle eager MCPs.*~31\.7k/);
      }

      // 8. Cross-Family Mid-TTL Model Switch (prefixBustCause + Gemini Effort Safety)
      {
        const steps = [
          makeStep(0, { inputTokens: 10000, content: 'rules/' }),
          makeStep(1, {
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            outputTokens: 1500,
            content: '<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Claude Opus 5.5 (Medium) to Gemini 4 Argon (High).</USER_SETTINGS_CHANGE>\nContinue design'
          }),
          makeStep(2, { outputTokens: 4000, content: 'Continuing design on Gemini 4 Argon' })
        ];
        const st = classifyHorizon(steps, { sessionId: 's8-switch', modelId: 'gemini-4-argon', useNativeCeiling: true, canonicalWorkspace: ws });
        st.model = { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', rawLabel: 'Gemini 4 Argon (High)', nativeCeilingTokens: 1048576 };
        st.effortTransitions = [{ fromTier: 'STANDARD', toTier: 'HIGH' }, { fromTier: 'HIGH', toTier: 'STANDARD' }];
        st.quota.cache = {
          ...st.quota.cache,
          cacheReadTokens: 0,
          hitRatePct: 0,
          isCacheCold: false,
          prefixBustDetected: true,
          ttlRemainingSec: 275,
          nextTurnLikelyWarm: true,
          prefixBustCause: { cause: 'model_switch', from: 'Claude Opus 5.5 (Medium)', to: 'Gemini 4 Argon (High)' },
          prefixRetention: { unmeasuredReason: null }
        };
        win.renderState(st);
        assert.equal(txt('tsCacheMeta'), '0% hit · Rebuilding (04:35)');
        assert.equal(txt('tsModelVerdict'), 'STAY');
        assert.match(txt('tsModelLast'), /Claude Opus 5\.5 → Gemini 4 Argon \(cache miss · cross-family\)/);
        assert.equal(txt('tsEffortVerdict'), 'OK');
        assert.equal(txt('tsEffortHist'), '2 effort switches this chat');
      }

      // 9. High-Effort Sludge Tax (9a) & Context Truncation Crisis (9b)
      {
        const sludgeSteps = [
          makeStep(0, { inputTokens: 16000, content: 'rules/' }),
          makeStep(1, {
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            outputTokens: 2000,
            content: '<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Claude Opus 5.5 (Medium) to Claude Opus 5.5 (High).</USER_SETTINGS_CHANGE>\nAudit large files'
          }),
          makeStep(2, { outputTokens: 14000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
          makeStep(3, { outputTokens: 14000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
          makeStep(4, { outputTokens: 14000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
          makeStep(5, { outputTokens: 14000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
          makeStep(6, { outputTokens: 46000, content: 'Deep analysis output' })
        ];
        const st9a = makeColdCache(classifyHorizon(sludgeSteps, { sessionId: 's9a-sludge', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        st9a.model = { ...st9a.model, id: 'claude-opus-5.5', displayName: 'Claude Opus 5.5', rawLabel: 'Claude Opus 5.5 (High)' };
        win.renderState(st9a);
        assert.match(txt('tsDoText'), /Run \/compact to clear 42\.0k clutter — High effort re-processes stale noise every turn/);
        assert.equal(d.getElementById('tsDoRow').dataset.tone, 'avoid');

        const crisisSteps = [
          ...sludgeSteps,
          makeStep(7, { outputTokens: 600000, content: 'Massive context fill past 700k safe horizon' })
        ];
        const st9b = makeColdCache(classifyHorizon(crisisSteps, { sessionId: 's9b-crisis', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        st9b.model = { ...st9b.model, id: 'claude-opus-5.5', displayName: 'Claude Opus 5.5', rawLabel: 'Claude Opus 5.5 (High)' };
        st9b.coachState = {
          detectors: {
            tripped: { detectorId: 'DET-30', severity: 'CRITICAL', reason: 'Thinking drift loop in crisis window' }
          }
        };
        win.renderState(st9b);
        assert.equal(txt('tsStatusLabel'), 'Memory Pruning Active');
        assert.equal(txt('tsAnchorHealth'), 'Oldest rules at risk');
        assert.equal(txt('tsModelVerdict'), 'LOCK');
        assert.equal(txt('tsEffortVerdict'), 'LOWER');
        assert.equal(d.getElementById('tsBtnCleanPrimary').dataset.ctaState, 'crisis');
        assert.equal(txt('taDetBadge'), 'DET-30 tripped');
      }

      // 10a. Shadowed File Bloat, Orphan PIDs, Stranded Trough Specs & Subagent Offload
      {
        const steps = [
          makeStep(0, { inputTokens: 12000, content: 'rules/' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 1000, content: 'Monitor host and subagents' }),
          makeStep(2, { outputTokens: 6000, content: 'Checked shadow bloat and subagents' })
        ];
        const st = makeColdCache(classifyHorizon(steps, { sessionId: 's10-reset', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        st.coachState = {
          det17ShadowBloat: { triggered: true, shadowedFileCount: 3, totalShadowWastedTokens: 16400 }
        };
        st.attentionHeatmap = { ...(st.attentionHeatmap || {}), strandedSignalCount: 2 };
        st.hostHealth = { rssGb: 3.8, orphanCount: 2 };
        st.savings = {
          session: { totalPhysicalTokens: 42000, bySource: { subagentIsolated: 42000 } },
          workspace30d: { totalPhysicalTokens: 42000 }
        };
        win.renderState(st);
        assert.match(txt('tsLedgerList'), /subagent[\s\S]*\+42\.0k/i);
        assert.equal(txt('taHostRam'), '3.8GB');
        assert.equal(txt('taUTrough'), '62% (2 specs)');
        assert.equal(txt('taSrcSub'), '+42.0k');
        const qTxt = txt('taActionQueue');
        assert.match(qTxt, /2 orphan language_server PIDs/);
        assert.match(qTxt, /2 stranded mid-trough specs/);
        assert.match(qTxt, /3 shadowed file\(s\).*16\.4k/);
      }

      // 10b. Post-/compact Reset + Workspace Change Re-Render Protection
      {
        const postSteps = [
          makeStep(0, { type: 'CHECKPOINT', source: 'SYSTEM', inputTokens: 6200, outputTokens: 6200, content: '<CONTEXT_SUMMARY>Compacted</CONTEXT_SUMMARY>' }),
          makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Continue post-compact' }),
          makeStep(2, { outputTokens: 1500, content: 'Ready to proceed cleanly' })
        ];
        const stReset = makeColdCache(classifyHorizon(postSteps, { sessionId: 's10-reset', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
        stReset.pinnedConversationId = 's10-reset';
        stReset.hostHealth = { rssGb: 0.4, orphanCount: 0 };
        win.renderState(stReset);
        const wsCb = getWsCallback();
        assert.equal(typeof wsCb, 'function');
        wsCb(['file:///c%3A/Projects/demo-workspace']);
        assert.equal(txt('tsUsedLabel'), '8.2k');
        assert.equal(txt('tsValClutter'), '0.0k');
        assert.equal(d.getElementById('tsWhyClears').hidden, true);
        assert.equal(d.getElementById('tsWhyClears').open, false);
        assert.equal(txt('tsStatusLabel'), 'Nominal Memory');
        assert.equal(txt('taDetBadge'), '32/32 guards armed');
        assert.match(txt('taActionQueue'), /Nominal queue · 0 orphan PIDs, 0 idle eager MCPs, 0 trough specs/);
      }

      // Simple <-> Advanced tab switcher check
      d.getElementById('tabAdvanced').click();
      assert.equal(d.body.dataset.viewMode, 'advanced');
      d.getElementById('tabSimple').click();
      assert.equal(d.body.dataset.viewMode, 'simple');

      assert.deepEqual(jsdomErrors, [], `Expected 0 JSDOM errors, got: ${jsdomErrors.join('; ')}`);
    } finally {
      win.close();
      dom.window.close();
    }
  });

  it('supports [data-theme="light"] contrast tokens and 360px narrow header truncation', async () => {
    const rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(rawHtml, /\.tufte-top-host-badge[\s\S]*?min-width:\s*0;[\s\S]*?flex:\s*0 1 auto;[\s\S]*?text-overflow:\s*ellipsis;/);
    assert.match(rawHtml, /\.header-controls \.header-right[\s\S]*?flex-wrap:\s*nowrap !important;/);
    assert.match(rawHtml, /\.header-controls \.shadcn-tabs-list[\s\S]*?flex:\s*0 0 auto !important;/);
    assert.match(rawHtml, /\.ts-cta-btn[\s\S]*?white-space:\s*normal;/);
    assert.match(rawHtml, /@media\s*\(max-width:\s*400px\)[\s\S]*?\.ts-switch-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
    assert.match(rawHtml, /\.ts-cta-btn[\s\S]*?color:\s*var\(--hz-bg\);/);
    assert.match(rawHtml, /\.ta-cell\[aria-selected="true"\][\s\S]*?outline:\s*1\.5px solid var\(--hz-fg\);/);

    const { dom, win, d, jsdomErrors } = await mountPanelDom();
    try {
      d.documentElement.setAttribute('data-theme', 'light');
      d.body.setAttribute('data-theme', 'light');
      const ws = 'c:/Projects/demo-workspace';
      const st = makeColdCache(classifyHorizon([
        makeStep(0, { inputTokens: 12000, content: 'rules/' }),
        makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 1000, content: 'Light check' }),
        makeStep(2, { outputTokens: 20000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
        makeStep(3, { outputTokens: 20000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] })
      ], { sessionId: 'light-360', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
      win.renderState(st);

      const rootCs = win.getComputedStyle(d.documentElement);
      assert.equal(rootCs.getPropertyValue('--ts-sig').trim(), '#A78BFA');
      assert.equal(rootCs.getPropertyValue('--ts-clu').trim(), '#FB923C');
      assert.equal(rootCs.getPropertyValue('--hz-bg').trim(), '#f6f8fa');
      assert.equal(rootCs.getPropertyValue('--hz-useful').trim(), '#116329');
      assert.equal(rootCs.getPropertyValue('--hz-clutter').trim(), '#7d4e00');

      const badgeCs = win.getComputedStyle(d.getElementById('tufteTopHostBadge'));
      assert.equal(badgeCs.textOverflow, 'ellipsis');
      assert.equal(badgeCs.overflow, 'hidden');

      d.getElementById('tabAdvanced').click();
      assert.equal(d.body.dataset.viewMode, 'advanced');
      assert.deepEqual(jsdomErrors, [], `Expected 0 JSDOM errors in light theme, got: ${jsdomErrors.join('; ')}`);
    } finally {
      win.close();
      dom.window.close();
    }
  });

  it('keeps Claude Code static HUD and CLI status line in parity across Top 10 scenarios', () => {
    const ws = 'c:/Projects/demo-workspace';

    // S1: Repeated source file re-reads -> no .claudeignore badge on source files
    const st1 = makeColdCache(classifyHorizon([
      makeStep(0, { inputTokens: 12000, content: 'rules/' }),
      makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 1000, content: 'Inspect files' }),
      makeStep(2, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
      makeStep(3, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
      makeStep(4, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
      makeStep(5, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
      makeStep(6, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/webview/horizon_panel.html` } }] }),
      makeStep(7, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] }),
      makeStep(8, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] }),
      makeStep(9, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] }),
      makeStep(10, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/sidecars/horizon-daemon/server.mjs` } }] })
    ], { sessionId: 'hud-s1', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
    const hud1 = renderClassifierHudHtml(st1, { viewMode: 'simple', includeDiskLedger: false });
    assert.equal(hud1.grid.tokens.D, 53000);
    assert.match(hud1.html, /horizon_panel\.html/);
    assert.equal(hud1.html.includes('.claudeignore'), false);
    const cli1Wide = formatCliStatusLine(st1, { columns: 120 });
    assert.match(cli1Wide, /81k \/ 1000k/);
    assert.match(cli1Wide, /Waste:\x1b\[0m 53k tok/);
    assert.ok(visibleWidth(formatCliStatusLine(st1, { columns: 80 })) <= 80);

    // S2: Warm cache + old chat history -> Hold / compact-cache-gated
    const s2Steps = [makeStep(0, { inputTokens: 10000, content: 'rules/' })];
    for (let i = 1; i <= 10; i++) s2Steps.push(makeStep(i, { outputTokens: 4000, content: `Legacy a_${i}` }));
    for (let i = 11; i <= 34; i++) s2Steps.push(makeStep(i, { outputTokens: 1000, content: `Work b_${i}` }));
    s2Steps.push(makeStep(35, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 1000, content: 'Continue' }));
    const st2 = classifyHorizon(s2Steps, { sessionId: 'hud-s2', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws });
    st2.quota.cache = { ...st2.quota.cache, cacheReadTokens: 60000, hitRatePct: 88, isCacheCold: false, prefixBustDetected: false, ttlRemainingSec: 210 };
    const hud2 = renderClassifierHudHtml(st2, { viewMode: 'simple', includeDiskLedger: false });
    assert.equal(hud2.metrics.cacheWarm, true);
    assert.equal(hud2.metrics.cacheHitPct, 88);
    assert.equal(hud2.priorityAction.id, 'compact-cache-gated');
    assert.match(hud2.html, /Compact After Cache Window/);
    assert.match(formatCliStatusLine(st2, { columns: 120 }), /Warm\(210s\)/);

    // S3: Stuck error loop -> Critical ERR-LOOP verdict
    const st3 = makeColdCache(classifyHorizon([
      makeStep(0, { inputTokens: 8000, content: 'rules/' }),
      makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Test' }),
      makeStep(2, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Err 1', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
      makeStep(3, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Err 2', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
      makeStep(4, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Err 3', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
      makeStep(5, { status: 'ERROR', exitCode: 1, outputTokens: 6000, content: 'Err 4', toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] })
    ], { sessionId: 'hud-s3', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
    const hud3 = renderClassifierHudHtml(st3, { viewMode: 'simple', includeDiskLedger: false });
    assert.equal(hud3.verdict.severity, 'critical');
    assert.match(hud3.verdict.headline, /ERR-LOOP Active/);

    // S5: Lockfile & log get .claudeignore; classifier.mjs does NOT
    const st5 = makeColdCache(classifyHorizon([
      makeStep(0, { inputTokens: 6000, content: 'rules/' }),
      makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Check' }),
      makeStep(2, { outputTokens: 10000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
      makeStep(3, { outputTokens: 10000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
      makeStep(4, { outputTokens: 10000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/package-lock.json` } }] }),
      makeStep(5, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/build.log` } }] }),
      makeStep(6, { outputTokens: 8000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/build.log` } }] }),
      makeStep(7, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
      makeStep(8, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] }),
      makeStep(9, { outputTokens: 7000, toolCalls: [{ name: 'read_file', args: { Path: `${ws}/src/core/classifier.mjs` } }] })
    ], { sessionId: 'hud-s5', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
    const hud5 = renderClassifierHudHtml(st5, { viewMode: 'simple', includeDiskLedger: false });
    const hogRows = hud5.html.match(/<div class="ah-hog-row">[\s\S]*?<\/div>/g) || [];
    const lockRow = hogRows.find((r) => r.includes('package-lock.json'));
    const logRow = hogRows.find((r) => r.includes('build.log'));
    const srcRow = hogRows.find((r) => r.includes('classifier.mjs'));
    assert.ok(lockRow && lockRow.includes('.claudeignore'), 'package-lock.json row must show .claudeignore');
    assert.ok(logRow && logRow.includes('.claudeignore'), 'build.log row must show .claudeignore');
    assert.ok(srcRow && !srcRow.includes('.claudeignore'), 'classifier.mjs source file must never show .claudeignore');

    // S6: Foreign memory bleed surfaces in distractor bucket & offenders
    const st6 = makeColdCache(classifyHorizon([
      makeStep(0, { inputTokens: 8000, content: 'rules/' }),
      makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Bleed' }),
      makeStep(2, { outputTokens: 19000, content: 'Loaded knowledge://legacy-billing-service guide' })
    ], {
      sessionId: 'hud-s6',
      modelId: 'claude-opus-5.5',
      useNativeCeiling: true,
      canonicalWorkspace: ws,
      kiBleedMap: new Map([['legacy-billing-service', { isBleed: true }]])
    }));
    const hud6 = renderClassifierHudHtml(st6, { viewMode: 'simple', includeDiskLedger: false });
    assert.equal(hud6.grid.tokens.D, 19000);
    assert.match(hud6.html, /Cross-project memory bleed \(foreign KIs\)/);

    // S9b + S10a + S10b: Crisis DET-30, Savings, and Post-/compact reset
    const st9b = makeColdCache(classifyHorizon([
      makeStep(0, { inputTokens: 16000, content: 'rules/' }),
      makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 2000, content: 'Audit' }),
      makeStep(2, { outputTokens: 720000, content: 'Crisis fill past 700k safe horizon' })
    ], { sessionId: 'hud-s9', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
    st9b.coachState = { detectors: { tripped: { detectorId: 'DET-30', severity: 'CRITICAL', reason: 'Drift loop' } } };
    assert.equal(st9b.amputation.amputationCrisis, true);
    const hud9b = renderClassifierHudHtml(st9b, { viewMode: 'simple', includeDiskLedger: false });
    assert.equal(hud9b.verdict.severity, 'critical');
    assert.match(hud9b.verdict.headline, /DET-30 Active/);
    assert.match(hud9b.html, /Memory: anchors at risk/);
    const cli9Narrow = formatCliStatusLine(st9b, { columns: 80 });
    assert.ok(visibleWidth(cli9Narrow) <= 80);
    assert.match(cli9Narrow, /🚨/);

    st1.savings = { session: { totalPhysicalTokens: 42000 }, workspace30d: { totalPhysicalTokens: 42000 } };
    const hud10a = renderClassifierHudHtml(st1, { viewMode: 'simple' });
    assert.equal(hud10a.metrics.sessionSavedTokens, 42000);
    assert.match(hud10a.html, /\+42k\b/);

    const st10b = makeColdCache(classifyHorizon([
      makeStep(0, { type: 'CHECKPOINT', source: 'SYSTEM', inputTokens: 6200, outputTokens: 6200, content: '<CONTEXT_SUMMARY>Done</CONTEXT_SUMMARY>' }),
      makeStep(1, { type: 'USER_INPUT', source: 'USER_EXPLICIT', outputTokens: 500, content: 'Next' }),
      makeStep(2, { outputTokens: 1500, content: 'Ready' })
    ], { sessionId: 'hud-s10b', modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: ws }));
    const hud10b = renderClassifierHudHtml(st10b, { viewMode: 'simple', includeDiskLedger: false });
    assert.equal(hud10b.grid.tokens.D, 0);
    assert.equal(hud10b.priorityAction.id, 'keep-coding');
    assert.equal(hud10b.html.includes('id="simpleTopOffender"'), false);
    assert.match(hud10b.html, /Memory: anchors pinned/);
    assert.match(formatCliStatusLine(st10b, { columns: 120 }), /\b8k \/ 1000k.*Ready/);
  });
});
