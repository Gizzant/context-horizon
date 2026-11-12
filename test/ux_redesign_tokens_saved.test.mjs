import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  SavedQuotaReceiptLedger,
  computeUnifiedSavings,
  SAVINGS_EVENT_TYPES
} from '../src/core/coach/saved_quota_ledger.mjs';
import { compressCliOutputFts5 } from '../src/core/fts5_output_compressor.mjs';
import { PrefixCacheShield } from '../src/core/prefix_cache_shield.mjs';
import { inspectSubagentTree } from '../src/core/subagents.mjs';
import { evaluateCompositeSessionRisk, classifyHorizon } from '../src/core/classifier.mjs';
import { analyzePromptSprawl } from '../src/core/coach/prompt_decomposer_coach.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

function createPanelDom() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  return new JSDOM(html, {
    url: 'http://127.0.0.1:62935/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.EventSource = class { close() {} };
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
    }
  });
}

describe('UX Redesign & Verified Tokens Saved Pipeline', () => {
  it('computes uninflated physical session & 30d workspace savings and wires FTS5 + PrefixCacheShield writers', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-ux-savings-'));
    try {
      const dbPath = path.join(tmpDir, 'tool_logs_fts5.db');
      const ledgerPath = path.join(tmpDir, 'saved_quota_ledger.sqlite');
      const queuePath = path.join(tmpDir, 'pending_rule_deltas.json');

      // 1. FTS5 CLI compressor automatically logs CLI_DUMP_COMPRESSED into sibling ledger
      const verboseOutput = Array.from({ length: 120 }, (_, i) =>
        i === 10 ? 'FAIL test/sample.test.js:42:9 AssertionError: expected 1 to equal 2' : `log line ${i} padding output text`
      ).join('\n');
      const compRes = await compressCliOutputFts5({
        sessionId: 'sess-alpha',
        turnId: 'turn-3',
        command: 'node --test test/sample.test.js',
        exitCode: 1,
        rawOutput: verboseOutput,
        dbPath
      });
      assert.equal(compRes.compressed, true);
      assert.ok(compRes.tokensSaved > 0, 'FTS5 compression must save physical tokens');

      // 2. PrefixCacheShield automatically logs COLD_PREFILL_AVOIDED when fencing warm cache
      const shield = new PrefixCacheShield({ queuePath });
      const shieldRes = shield.stageOrApplyDelta(
        {
          targetPath: path.join(tmpDir, 'AGENTS.md'),
          newContent: '# Rule delta\n'
        },
        {
          sessionId: 'sess-alpha',
          cacheWarm: true,
          cachedTokens: 84000,
          cacheTtlSeconds: 240
        }
      );
      assert.equal(shieldRes.staged, true);

      // 3. Record a second session in workspace 30d ledger
      const ledger = new SavedQuotaReceiptLedger({ dbPath: ledgerPath });
      ledger.recordSaving({
        sessionId: 'sess-prior',
        eventType: SAVINGS_EVENT_TYPES.LOOP_TURN_PREVENTED,
        tokensSaved: 32000,
        detail: 'DET-06 duplicate read blocked'
      });

      const unified = computeUnifiedSavings(
        {
          sessionId: 'sess-alpha',
          subagents: { tokensSaved: 45000 },
          quota: { cache: { cacheReadTokens: 100000 } },
          coachState: { fts5Compressor: { savedTokens: compRes.tokensSaved } }
        },
        { ledger, sessionId: 'sess-alpha' }
      );

      assert.equal(unified.session.bySource.subagentIsolation, 45000);
      assert.ok(unified.session.bySource.cachePreservation >= 95000 + Math.round(84000 * 0.95));
      assert.equal(unified.session.bySource.cliCompression, compRes.tokensSaved);
      assert.ok(unified.workspace30d.totalPhysicalTokens >= unified.session.totalPhysicalTokens + 32000);

      const plainReceipt = ledger.copyPlainSavingsReceipt('sess-alpha');
      assert.ok(!/argon-equiv/i.test(plainReceipt), 'Plain receipt must contain zero Argon-equiv jargon');
      assert.ok(!/argon-equiv/i.test(ledger.getSummary('sess-alpha').displayFooterText));
      // Legacy backward compatibility preserved on getSummary()
      assert.ok(typeof ledger.getSummary('sess-alpha').totalArgonEquivTokensSaved === 'number');
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        void cleanupErr;
      }
    }
  });

  it('deduplicates parallel invoke_subagent calls so two distinct child UUIDs never alias to the first match', () => {
    const uuidA = '11111111-2222-3333-4444-555555555555';
    const uuidB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const steps = [
      {
        type: 'PLANNER_RESPONSE',
        toolCalls: [
          { name: 'invoke_subagent', args: { Role: 'Scout A', TypeName: 'research' } },
          { name: 'invoke_subagent', args: { Role: 'Scout B', TypeName: 'research' } }
        ]
      },
      {
        type: 'TOOL_RESPONSE',
        content: `Launched subagent conversationId="${uuidA}" and subagent conversationId="${uuidB}"`,
        outputTokens: 420
      }
    ];
    const tree = inspectSubagentTree(steps, { homeDir: os.tmpdir() });
    assert.equal(tree.invocations.length, 2);
    assert.notEqual(tree.invocations[0].conversationId, tree.invocations[1].conversationId);
    assert.deepEqual(
      tree.invocations.map(i => i.conversationId),
      [uuidA, uuidB]
    );
  });

  it('fixes 1M-ceiling safeHorizon false RED, Turn-1 oldHistory false count, and DET-26 read-only audit negation', () => {
    // 1. 1M ceiling at 220k (< 603k High safeLimit) stays GREEN when cache is warm
    const risk = evaluateCompositeSessionRisk({
      totalActiveTokens: 220000,
      safeHorizonTokens: 603000,
      cacheTtlRemainingSec: 240,
      cacheReadTokens: 180000,
      cacheHitRatePct: 82,
      taskMdTurnsBehind: 0,
      taskMdExists: true,
      hasPendingTaskItems: false,
      weekly7dUsedPct: 20,
      weekly7dSource: 'live'
    });
    assert.equal(risk.band, 'GREEN', '220k on 1M ceiling (< 603k safeLimit) must stay GREEN');

    // 2. Single USER_INPUT with >=30 tool steps must report 0 older user turns
    const turn1Steps = [
      { type: 'USER_INPUT', content: 'Audit the repository', inputTokens: 1200 },
      ...Array.from({ length: 32 }, (_, idx) => ({
        type: 'PLANNER_RESPONSE',
        content: `Inspecting module ${idx}`,
        inputTokens: 1200 + (idx + 1) * 800,
        outputTokens: 300
      }))
    ];
    const horizon = classifyHorizon(turn1Steps, { maxTokens: 256000, safeLimit: 179000 });
    assert.equal(horizon.brainSignals.oldHistory.turnCount, 0, 'Turn-1 tool calls must not count as >25 old user turns');

    // 3. DET-26 ignores explicit read-only audit prompts while still catching mutating mega-prompts
    const auditPrompt = [
      'Read-only evaluation. Do NOT edit source, tests, hooks, mirrors, or SQLite databases.',
      '- Review README.md, package.json, AGENTS.md, src/core/classifier.mjs, and src/webview/horizon_panel.html.',
      '- Redesign Simple View blueprint and architecture report without modifying files.',
      '- Create ui_usability_redesign.md report only.'
    ].join('\n');
    const auditRes = analyzePromptSprawl(auditPrompt);
    assert.equal(auditRes.isMegaPrompt, false, 'Read-only audit prompt must not trigger DET-26');
  });

  it('enforces Simple View 4-Rank invariants: zero duplicate action IDs, crisis override on warm cache, synced #statusDot, and zero Argon-equiv UI text', () => {
    const dom = createPanelDom();
    const w = dom.window;
    const d = w.document;

    // State A: Healthy / Nominal on Turn 1 cold cache with verified savings
    w.renderState({
      schemaVersion: '1.1.0',
      sessionId: 'ux-state-a',
      sessionTitle: '[App] [163.6k] Attention Horizon UI Usability Redesign',
      contextWindow: 1048576,
      model: { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', nativeCeilingTokens: 1048576 },
      window: {
        maxTokens: 1048576,
        totalActiveTokens: 71000,
        usedPercentage: 7,
        turnCount: 1,
        safeLimit: 603000
      },
      quota: {
        sprint5h: { usedPct: 12, remainingPct: 88, modelPoolName: 'Gemini 4 Carbon' },
        weekly7d: { usedPct: 18, remainingPct: 82 },
        cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true, cacheReadTokens: 0 }
      },
      savings: {
        session: {
          totalPhysicalTokens: 142300,
          estimatedInputValueUsd: 0.28,
          bySource: {
            subagentIsolation: 62000,
            cachePreservation: 58000,
            cliCompression: 14300,
            avoidedBloat: 8000
          }
        },
        workspace30d: {
          totalPhysicalTokens: 1840000,
          estimatedInputValueUsd: 3.68
        }
      },
      baseline: {
        totalEst: 5700,
        duplicateOverheadTokens: 1900,
        buckets: {
          rules: { label: 'Rules & AGENTS', tokens: 2400, budgetTokens: 20000, usedPct: 12 },
          skills: { label: 'Skills', tokens: 1100, budgetTokens: 20000, usedPct: 6 },
          mcp: { label: 'MCP Schemas', tokens: 1200, budgetTokens: 20000, usedPct: 6 },
          agents: { label: 'Subagents', tokens: 600, budgetTokens: 20000, usedPct: 3 },
          hooks: { label: 'Hooks', tokens: 400, budgetTokens: 20000, usedPct: 2 }
        },
        rows: [{ kind: 'rule', source: 'AGENTS.md', tokens: 2400 }]
      },
      coachState: {
        savedQuotaLedger: {
          statusBarText: '$(shield) +450.0k Argon-equiv tokens saved',
          footerText: 'Saved Quota: +450.0k Argon-equiv tokens saved'
        }
      }
    });

    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'NOMINAL');
    assert.equal(d.getElementById('statusDot').dataset.riskBand, 'GREEN', '#statusDot must match NOMINAL verdict on Turn 1');
    assert.equal(d.getElementById('simpleNominalConfirm').hidden, false);
    assert.equal(d.getElementById('simpleActionableBox').hidden, true);
    assert.equal(d.getElementById('tufteSavedTokensLabel').textContent, '+142.3k');
    assert.equal(d.getElementById('tufteWorkspaceSavedLabel').textContent, '+1.8M');
    assert.equal(d.getElementById('tufteModelBurnPill').textContent.includes('Gemini 4 Carbon'), true);
    assert.equal(d.getElementById('sessionTopCard'), null, 'Legacy top session switcher card must be removed');
    assert.equal(d.getElementById('activeConversationTitle').textContent, 'Attention Horizon UI Usability Redesign');
    assert.equal(d.getElementById('btnFollowActiveSession').hidden, true);
    assert.equal(d.getElementById('storageCard').contains(d.getElementById('sessionModelPill')), true);
    assert.equal(d.getElementById('storageCard').contains(d.getElementById('tufteModelBurnPill')), true);
    assert.equal(d.getElementById('advAccRouter').contains(d.getElementById('sessionSelect')), true);
    assert.equal(d.getElementById('advAccRouter').contains(d.getElementById('btnOpenChat')), true);
    assert.equal(d.getElementById('bucketBars').children.length, 5);
    assert.equal(d.getElementById('duplicatePluginNotice').hidden, false);
    assert.ok(!/argon-equiv/i.test(d.body.textContent), 'Visible DOM must contain zero Argon-equiv jargon');

    // Toggle [Why] drawer
    const whyBtn = d.getElementById('btnToggleSavingsWhy');
    const whyDrawer = d.getElementById('simpleSavingsWhyDrawer');
    assert.equal(whyDrawer.hidden, true);
    whyBtn.click();
    assert.equal(whyDrawer.hidden, false);
    assert.equal(d.getElementById('savSubagentVal').textContent, '+62.0k');

    // State B: Multi-action state — verify single primary visible action + zero duplicate data-action-id across DOM
    w.renderState({
      schemaVersion: '1.1.0',
      sessionId: 'ux-state-b',
      window: { maxTokens: 256000, totalActiveTokens: 190000, usedPercentage: 74, turnCount: 14, safeLimit: 179000 },
      quota: { cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true } },
      brainSignals: {
        oldHistory: { turnCount: 10, reclaimableTokens: 48000 },
        duplicateReads: { files: [], totalWastedTokens: 0 },
        deadErrors: { errorCount: 0, totalTokens: 0 }
      },
      coachState: {
        compactionCoach: { recommendBatonPass: true, batonPassReason: 'Milestone complete', recommendTailTrim: true },
        rsiEngine: { clusters: [{ domain: 'testing', count: 5 }] },
        uShapedAttention: { healthScore: 80, middleTroughRiskCount: 2, strandedRules: ['Rule A'] }
      }
    });

    const allActionEls = Array.from(d.querySelectorAll('[data-action-id]'));
    const actionIds = allActionEls.map(el => el.dataset.actionId);
    assert.equal(new Set(actionIds).size, actionIds.length, 'Every data-action-id in the DOM must be rendered once (zero duplicates)');
    assert.equal(d.getElementById('coachingActionList').children.length, 0);
    assert.equal(d.getElementById('rsiActionList').children.length, 0);
    const topLevelActions = Array.from(d.getElementById('simpleActionList').children)
      .filter(el => el.matches('details.m3-action-collapsible, div.m3-action-row'));
    assert.equal(topLevelActions.length, 1, 'Simple View Rank 3 must show only 1 primary action card outside #simpleMoreActionsDrawer');
    assert.ok(d.getElementById('simpleMoreActionsDrawer'), 'Overflow actions must collapse into #simpleMoreActionsDrawer');

    // State C: Immediate amputationCrisis overrides warm-cache hold so /compact is NOT hidden
    w.renderState({
      schemaVersion: '1.1.0',
      sessionId: 'ux-state-c-crisis',
      window: { maxTokens: 256000, totalActiveTokens: 248000, usedPercentage: 97, turnCount: 28, safeLimit: 179000 },
      amputation: { amputationCrisis: true, droppedTokens: 14000 },
      quota: {
        cache: { hitRatePct: 92, ttlRemainingSec: 210, isCacheCold: false, cacheReadTokens: 200000 }
      },
      brainSignals: {
        oldHistory: { turnCount: 18, reclaimableTokens: 82000 },
        duplicateReads: { files: [], totalWastedTokens: 0 },
        deadErrors: { errorCount: 0, totalTokens: 0 }
      },
      coachState: {
        detectors: { totalCount: 30, tripped: null }
      }
    });

    assert.equal(d.getElementById('unifiedVerdictBar').dataset.verdictState, 'CRITICAL_STOP');
    assert.equal(d.getElementById('statusDot').dataset.riskBand, 'RED');
    assert.equal(d.getElementById('cacheGatedHoldBanner').style.display, 'none', 'amputationCrisis must override warm-cache hold');
    assert.ok(
      d.getElementById('simpleActionList').querySelector('[data-action-id="compact-context"]'),
      '/compact action must be immediately visible during amputationCrisis even if cache is warm'
    );
    assert.equal(d.getElementById('tufteBaselineStrip').dataset.muted, 'true');
  });
});
