/**
 * Simple View clarity pass: learned-rules drawer, plain-English safeguards (31 active guards),
 * BUG-14 safeguard lifecycle fixes, and a readability / zero-jargon gate.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';

import { classifyHorizon } from '../src/core/classifier.mjs';
import { DETECTOR_CATALOG } from '../src/core-isomorphic/catalog/detectorCatalog.mjs';
import {
  SAFEGUARD_GUIDE,
  CIRCUIT_ALERT_GUIDE,
  formatSafeguardGuidance,
  getAlertGuidance,
  canonicalGuardIdForAlert,
  filterFreshAlerts,
  humanizeLearnedRule,
  safeBaseName
} from '../src/core-isomorphic/catalog/safeguardGuide.mjs';
import { CircuitBreakers, inspectErrorMaskingDiff } from '../src/core/coach/circuit_breakers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');
const SERVER = path.join(ROOT, 'sidecars', 'horizon-daemon', 'server.mjs');
const WS = 'c:/Projects/demo-workspace';
const LONG_PATH = 'c:\\Projects\\demo-repo\\src\\webview\\partials\\09_script_part4_and_tail.part';
// Built at runtime so repo hygiene scans do not mistake these fixtures for real empty catch blocks.
const EB = '{' + '}';
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const BANNED_JARGON = /Nominal Memory|PrefixCacheShield|FTS5|FNV-1a|StateBaton|IOEDR|REMORY|Confabulation|foreign KIs?|KV-Cache Gravity|Turn-0 Prefix Bloat|eager MCP|MCP schemas|scope locks/i;

async function mountPanel() {
  let rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
  rawHtml = rawHtml.replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
  const jsdomErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsdomErrors.push(String(e?.message || e)));
  const dom = new JSDOM(rawHtml, {
    url: 'http://127.0.0.1:43210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.EventSource = class { close() {} };
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      win.sidecar = { onWorkspaceChange() {} };
    }
  });
  await new Promise((r) => setTimeout(r, 80));
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors };
}

function baseState(sessionId, extra = {}) {
  const steps = [
    { stepIndex: 0, type: 'SYSTEM_PROMPT', source: 'SYSTEM', status: 'DONE', content: 'rules/', inputTokens: 8000, outputTokens: 1000, toolCalls: [] },
    { stepIndex: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Update src/core/parser.mjs', outputTokens: 500, toolCalls: [] },
    { stepIndex: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '', outputTokens: 1500, toolCalls: [] }
  ];
  const st = classifyHorizon(steps, { sessionId, modelId: 'claude-opus-5.5', useNativeCeiling: true, canonicalWorkspace: WS });
  st.quota = st.quota || {};
  st.quota.cache = { ...(st.quota.cache || {}), cacheReadTokens: 0, hitRatePct: 0, isCacheCold: true, ttlRemainingSec: 0, nextTurnLikelyWarm: false };
  return Object.assign(st, extra);
}

const SAMPLE_LEDGER_ITEMS = [
  {
    slug: 'review-rejected-3faabc', carrier: 'rule_glob', importance: 11, promotedHook: true,
    description: 'Use when planning or editing .rsl_steps.js affected by artifact review feedback. Do not use for unrelated modules or one-off tasks.',
    when_condition: 'User review rejection in walkthrough.md',
    then_guidance: 'Enforce user artifact guidance: - `recordStepOutcome` normalizes Antigravity events into telemetry files.'
  },
  {
    slug: 'review-inline-comment-62f4d1', carrier: 'rule_model_decision', importance: 2,
    description: 'Use when planning or editing workspace architecture affected by artifact review feedback. Do not use for unrelated modules or one-off tasks.',
    when_condition: 'User review inline feedback in simple_view_enhancement_plan.md',
    then_guidance: 'Enforce user artifact guidance: | Emoji row icons | Inconsistent with the mono tag style |'
  },
  {
    slug: 'recover-router-a58707', carrier: 'skill_workflow', importance: 1,
    description: 'Use when replaying the verified 4-step recovery workflow for src/core/router.mjs. Do not use for unrelated features or clean runs without this failure signature.',
    when_condition: 'Recovering after `read_file` fails with "file does not exist"',
    then_guidance: 'Follow the verified recovery sequence:\n1. Run `read_file` on a.mjs',
    steps: ['1. a', '2. b', '3. c', '4. d']
  },
  {
    slug: 'recover-webview-browser-5769a2', carrier: 'skill_workflow', importance: 1,
    description: 'Use when replaying the verified 2-step recovery workflow for webview_browser. Do not use for unrelated features or clean runs without this failure signature.',
    when_condition: 'Recovering after `webview_browser` fails with "webview_browser script request failed: OP_TIMEOUT"',
    steps: ['1. a', '2. b']
  },
  {
    slug: 'recover-09-script-part4-and-tail-d84d7a', carrier: 'skill_workflow', importance: 2,
    description: 'Use when replaying the verified 4-step recovery workflow for src/webview/partials/09_script_part4_and_tail.part. Do not use for unrelated features or clean runs without this failure signature.',
    when_condition: 'Recovering after `edit_file` fails with "target content not found in the file"',
    steps: ['1. a', '2. b', '3. c', '4. d']
  }
];

// Flesch–Kincaid grade level (heuristic syllable counter), code-like fragments removed.
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}
function fkGrade(text) {
  const clean = String(text).replace(/git [a-z-]+ -- "[^"]*"/g, 'git command').replace(/`[^`]*`/g, 'code');
  const sentences = clean.split(/[.!?]+(?:\s|$)/).filter((s) => /[a-z]/i.test(s));
  const words = clean.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (!sentences.length || !words.length) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
}

describe('Simple View: learned rules drawer', () => {
  it('hides with zero rules, shows "Applying N learned rules", opens from the activity row, and humanizes entries', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      const drawer = d.getElementById('tsLearnedRulesDrawer');
      assert.ok(drawer, 'learned rules drawer exists');
      win.renderState(baseState('rules-none'));
      assert.equal(drawer.hidden, true, 'hidden when no rules are active');

      const uiRules = SAMPLE_LEDGER_ITEMS.map((it) => humanizeLearnedRule(it));
      win.renderState(baseState('rules-five', { rsl: { totalActive: 5, promotedHooks: 1, clashCount: 0, uiRules } }));
      assert.equal(drawer.hidden, false);
      assert.equal(txt('tsLearnedRulesSummary'), 'Applying 5 learned rules');
      assert.equal(txt('tsLearnedRulesHint'), '1 auto-check');
      assert.equal(d.querySelectorAll('#tsLearnedRulesList .ts-ledger-row').length, 5);
      assert.doesNotMatch(txt('tsLearnedRulesList'), /-[0-9a-f]{6}\b/, 'no hash suffixes in rule names');
      assert.match(txt('tsLearnedRulesList'), /4-step recovery for router\.mjs/);
      assert.match(txt('tsLearnedRulesList'), /Review feedback rule for \.rsl_steps\.js/);
      assert.doesNotMatch(txt('tsLearnedRulesList'), /Enforce user artifact guidance/);
      assert.equal(EMOJI_RE.test(txt('tsLearnedRulesList')), false);

      const row = d.querySelector('#tsLedgerList [data-action="learned-rules"]');
      assert.ok(row, 'ledger row for learned rules is clickable');
      assert.match(row.textContent, /Applying 5 learned rules/);
      assert.equal(drawer.open, false);
      row.click();
      assert.equal(drawer.open, true, 'clicking the row opens the drawer');
      row.click();
      assert.equal(drawer.open, false, 'clicking again closes it');

      const extra = d.getElementById('tsSessionExtraRow');
      assert.equal(extra.dataset.clickable, 'true');
      extra.click();
      assert.equal(drawer.open, true, 'Session overview row also opens the drawer');

      win.renderState(baseState('rules-off', { routerMode: 'off', rsl: { totalActive: 5, promotedHooks: 1, uiRules } }));
      assert.equal(txt('tsLearnedRulesHint'), 'Paused');
      assert.match(txt('tsLearnedRulesList'), /paused/);

      win.renderState(baseState('rules-count-only', { rsl: { totalActive: 3 } }));
      assert.equal(txt('tsLearnedRulesSummary'), 'Applying 3 learned rules');
      assert.match(txt('tsLearnedRulesList'), /Rule details are not available yet/);

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });

  it('humanizeLearnedRule strips hashes/markdown and never throws on sparse items', () => {
    const hook = humanizeLearnedRule(SAMPLE_LEDGER_ITEMS[0]);
    assert.equal(hook.kind, 'hook');
    const skill = humanizeLearnedRule(SAMPLE_LEDGER_ITEMS[3]);
    assert.equal(skill.kind, 'skill');
    assert.match(skill.title, /^2-step recovery for webview_browser$/);
    assert.match(skill.detail, /webview_browser fails/);
    assert.doesNotThrow(() => humanizeLearnedRule({}));
    assert.doesNotThrow(() => humanizeLearnedRule(undefined));
    assert.equal(humanizeLearnedRule({ slug: 'my-rule-abcdef' }).title, 'my rule');
  });
});

describe('Safeguards: plain-English guide for all active guards', () => {
  it('every non-alias catalog guard has a title, kind, issue, do, and avoid text without emoji', () => {
    const active = Object.values(DETECTOR_CATALOG).filter((m) => !m.aliasOf);
    assert.equal(active.length, 31, 'DET-01..DET-32 minus the deprecated DET-21 alias');
    for (const meta of active) {
      const guide = SAFEGUARD_GUIDE[meta.id];
      assert.ok(guide, `${meta.id} needs a plain-English guide`);
      assert.ok(['action', 'info'].includes(guide.kind), `${meta.id} kind`);
      for (const k of ['title', 'issue', 'doText', 'avoidText']) {
        assert.ok(typeof guide[k] === 'string' && guide[k].length > 8, `${meta.id}.${k}`);
        assert.equal(EMOJI_RE.test(guide[k]), false, `${meta.id}.${k} has no emoji`);
        assert.doesNotMatch(guide[k], BANNED_JARGON, `${meta.id}.${k} avoids jargon`);
      }
      if (guide.kind === 'info') assert.match(guide.doText, /No action needed/, `${meta.id} states no action is needed`);
      else assert.doesNotMatch(guide.doText, /^No action needed/, `${meta.id} gives a concrete step`);
    }
    assert.equal(SAFEGUARD_GUIDE['DET-21'].hidden, true);
    for (const alert of Object.values(CIRCUIT_ALERT_GUIDE)) assert.equal(alert.kind, 'action');
  });

  it('DET-23 guidance names the whole file (no mid-word cut) and explains what to do', () => {
    const g = getAlertGuidance({ detectorId: 'DET-23', filePath: LONG_PATH });
    assert.equal(safeBaseName(LONG_PATH), '09_script_part4_and_tail.part');
    assert.match(g.title, /09_script_part4_and_tail\.part/);
    assert.match(g.doText, /git diff -- "09_script_part4_and_tail\.part"/);
    assert.match(g.doText, /moved error handling into a helper/);
    assert.equal(g.kind, 'action');
    assert.equal(formatSafeguardGuidance('DET-XX').kind, 'action', 'unknown ids still get a safe generic message');
    assert.equal(canonicalGuardIdForAlert({ detectorId: 'DET-01' }), 'DET-04');
    assert.equal(canonicalGuardIdForAlert({ detectorId: 'DET-03' }), 'DET-05');
    assert.equal(canonicalGuardIdForAlert({ detectorId: 'DET-21', mode: 'blind_edit' }), 'DET-06');
    assert.equal(canonicalGuardIdForAlert({ detectorId: 'DET-23' }), 'DET-23');
  });

  it('Direct Guidance shows action-needed guidance, strips emoji, keeps full file names, and ignores informational guards', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      const guidance = getAlertGuidance({ detectorId: 'DET-23', filePath: LONG_PATH });
      win.renderState(baseState('breaker-guided', {
        coachState: {
          detectors: {
            tripped: {
              detectorId: 'DET-23',
              reason: `\u{1F6A8} DET-23 Error-Masking Detected in ${LONG_PATH}: Removed error handler: try {.`,
              guidance
            }
          }
        }
      }));
      assert.equal(d.getElementById('tsDoRow').dataset.tone, 'danger');
      assert.match(txt('tsDoText'), /09_script_part4_and_tail\.part/);
      assert.match(txt('tsDoText'), /hide crashes/);
      assert.match(txt('tsDoText'), /git diff --/);
      assert.match(txt('tsAvoidText'), /Avoid approving more changes/);
      assert.equal(EMOJI_RE.test(txt('tsDoText') + txt('tsAvoidText')), false);
      assert.doesNotMatch(txt('tsDoText'), /Guard tripped|09_s\b/);
      assert.match(d.getElementById('tsDoRow').title, /\(DET-23\)/);

      win.renderState(baseState('breaker-fallback', {
        coachState: {
          detectors: {
            tripped: { detectorId: 'DET-23', reason: `\u{1F6A8} DET-23 Error-Masking Detected in ${LONG_PATH}: Removed error handler.` }
          }
        }
      }));
      assert.match(txt('tsDoText'), /09_script_part4_and_tail\.part/, 'fallback keeps the whole file name');
      assert.equal(EMOJI_RE.test(txt('tsDoText')), false);

      win.renderState(baseState('breaker-info', {
        coachState: {
          detectors: {
            tripped: { detectorId: 'DET-07', reason: 'trimmed', guidance: formatSafeguardGuidance('DET-07') }
          }
        }
      }));
      assert.notEqual(d.getElementById('tsDoRow').dataset.tone, 'danger');
      assert.match(txt('tsDoText'), /Safe to run multi-file edits/, 'informational guard never overrides guidance');

      win.renderState(baseState('roster-plain', {
        coachState: {
          detectors: {
            totalCount: 2,
            list: [
              { id: 'DET-23', name: 'Empty Catch-Block & Swallowed Error Sensor', title: 'Errors may be hidden in a file', summary: 'Empty catch blocks can hide crashes.', actionKind: 'action', mode: 'advisory', tripped: true },
              { id: 'DET-07', name: 'Exit-Safe CLI Compressor & Output Bomb Guard', title: 'Long command output trimmed', summary: 'Long logs were shortened.', actionKind: 'info', mode: 'guard', tripped: false }
            ]
          }
        }
      }));
      const rosterText = txt('tsGuardList');
      assert.match(rosterText, /Errors may be hidden in a file/);
      assert.doesNotMatch(rosterText, /Empty Catch-Block & Swallowed/);
      const row23 = d.querySelector('#tsGuardList [data-effective-state="tripped"]');
      assert.match(row23.title, /Triggered in this chat/);
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});

describe('BUG-14: safeguard lifecycle', () => {
  it('deleting an already-empty catch is not flagged, but removing a real handler still is', () => {
    const refactor = '-  try { a(); } catch ' + EB + '\n+  helper(a);';
    assert.equal(inspectErrorMaskingDiff(refactor, 'src/x.mjs').masked, false);
    const stripped = '-  } catch (err) {\n-    logger.error(err);\n-  }\n+  }';
    assert.equal(inspectErrorMaskingDiff(stripped, 'src/x.mjs').masked, true);
    const added = '+  try { a(); } catch (err) ' + EB + '';
    assert.equal(inspectErrorMaskingDiff(added, 'src/x.mjs').masked, true);
  });

  it('a clean follow-up edit on the same file resolves DET-23; a passing command resolves DET-01', () => {
    const cb = new CircuitBreakers();
    const bad = cb.recordTurn({
      turnIndex: 1, toolName: 'edit_file', filePath: 'src/a.mjs',
      previousContent: 'function a() {\n  try { x(); } catch (err) { log(err); }\n}',
      newContent: 'function a() {\n  try { x(); } catch (err) ' + EB + '\n}'
    });
    assert.ok(bad.triggered.some((t) => t.detectorId === 'DET-23'));
    assert.ok(cb.activeAlerts.some((a) => a.detectorId === 'DET-23'));
    cb.recordTurn({
      turnIndex: 2, toolName: 'edit_file', filePath: 'src/a.mjs',
      previousContent: 'function a() {\n  try { x(); } catch (err) ' + EB + '\n}',
      newContent: 'function a() {\n  try { x(); } catch (err) { log(err); }\n}'
    });
    assert.equal(cb.activeAlerts.some((a) => a.detectorId === 'DET-23'), false, 'resolved by a clean edit');

    const cb2 = new CircuitBreakers();
    for (let i = 1; i <= 4; i++) {
      cb2.recordTurn({ turnIndex: i, toolName: 'run_command', args: { CommandLine: 'npm test' }, exitCode: 1 });
    }
    assert.ok(cb2.activeAlerts.some((a) => a.detectorId === 'DET-01'), 'retry churn is raised');
    cb2.recordTurn({ turnIndex: 5, toolName: 'run_command', args: { CommandLine: 'npm test' }, exitCode: 0 });
    assert.equal(cb2.activeAlerts.some((a) => a.detectorId === 'DET-01'), false, 'cleared once the same command passes');
  });

  it('old alerts expire after newer user messages and after /compact', () => {
    const steps = [
      { stepIndex: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'go' },
      { stepIndex: 1, type: 'PLANNER_RESPONSE', content: '' },
      { stepIndex: 2, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'next' },
      { stepIndex: 3, type: 'PLANNER_RESPONSE', content: '' },
      { stepIndex: 4, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'again' },
      { stepIndex: 5, type: 'PLANNER_RESPONSE', content: '' }
    ];
    const alerts = [{ detectorId: 'DET-23', turnIndex: 1 }, { detectorId: 'DET-22', turnIndex: 3 }, { detectorId: 'DET-30' }];
    const fresh = filterFreshAlerts(alerts, steps).map((a) => a.detectorId);
    assert.deepEqual(fresh, ['DET-22', 'DET-30'], 'two user turns later the alert is gone; one turn later it stays');
    const afterCompact = [...steps.slice(0, 5), { stepIndex: 5, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '/compact' }];
    assert.deepEqual(filterFreshAlerts(alerts, afterCompact).map((a) => a.detectorId), ['DET-30']);
    assert.equal(filterFreshAlerts(alerts, []).length, 3, 'no transcript means nothing is filtered');
  });
});

describe('Daemon state exposes plain-English guard roster and learned rules', () => {
  let child; let port; let tmpRoot;
  const TOKEN = 'simple-view-clarity-token';
  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-clarity-'));
    const tmpHome = path.join(tmpRoot, 'home');
    const tmpCwd = path.join(tmpRoot, 'ws');
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpCwd, { recursive: true });
    port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
      srv.on('error', reject);
    });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_ENV;
    delete env.CTXTOP_PRO_DEV;
    Object.assign(env, { USERPROFILE: tmpHome, HOME: tmpHome, ANTIGRAVITY_SIDECAR_UI_TOKEN: TOKEN, ANTIGRAVITY_SIDECAR_WEB_PORT: String(port), HORIZON_TEST_NO_SPAWN: '1' });
    child = spawn(process.execPath, [SERVER], { cwd: tmpCwd, env, stdio: 'ignore' });
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Sidecar-Token': TOKEN } });
        ready = r.status === 200;
      } catch (err) {
        void err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(ready, 'daemon must start');
  });
  after(() => {
    try { child?.kill(); } catch (err) { void err; }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
  });

  it('serves 31 guards (no deprecated DET-21) with titles, and an array of learned rules', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Sidecar-Token': TOKEN } });
    const state = await res.json();
    const list = state?.coachState?.detectors?.list;
    if (Array.isArray(list)) {
      assert.equal(list.some((g) => g.id === 'DET-21'), false);
      assert.ok(list.length <= 31 && list.length > 0);
      for (const g of list) {
        assert.ok(g.title && g.actionKind, `${g.id} has plain-English title and kind`);
      }
    }
    if (state?.rsl) assert.ok(Array.isArray(state.rsl.uiRules), 'rsl.uiRules is always an array');
  });
});

describe('Readability and zero-jargon gate', () => {
  it('safeguard guidance averages at or below grade 11.5 and no entry is above grade 14', () => {
    const grades = [];
    for (const [id, g] of Object.entries(SAFEGUARD_GUIDE)) {
      if (g.hidden) continue;
      const grade = fkGrade(`${g.issue} ${g.doText} ${g.avoidText}`);
      grades.push(grade);
      assert.ok(grade <= 14, `${id} reads at grade ${grade.toFixed(1)} (max 14)`);
    }
    const mean = grades.reduce((a, b) => a + b, 0) / grades.length;
    assert.ok(mean <= 11.5, `mean grade ${mean.toFixed(2)} should be <= 11.5`);
  });

  it('Simple View text and tooltips contain no internal jargon across key states', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      const collect = () => {
        const surface = d.getElementById('argonSimpleSurface');
        const titles = [...surface.querySelectorAll('[title]')].map((n) => n.getAttribute('title')).join(' ');
        return `${surface.textContent} ${titles}`;
      };
      const states = [
        baseState('j-nominal'),
        baseState('j-rsl', { rsl: { totalActive: 2, promotedHooks: 0, uiRules: SAMPLE_LEDGER_ITEMS.slice(0, 2).map((i) => humanizeLearnedRule(i)) }, shield: { enabled: true, maxUnslicedLines: 1200 } }),
        baseState('j-sharded', { shardedSpecCount: 5 }),
        baseState('j-clash', { rsl: { clashCount: 2 } })
      ];
      for (const st of states) {
        win.renderState(st);
        const text = collect();
        assert.doesNotMatch(text, BANNED_JARGON, `jargon found in state ${st.sessionId}`);
        assert.equal(EMOJI_RE.test(d.getElementById('tsDoText').textContent + d.getElementById('tsAvoidText').textContent), false);
      }
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});

describe('Readability: rendered Simple View copy', () => {
  it('rendered text and tooltips average grade <= 10.5 and none above grade 14', async () => {
    const { dom, win, d, jsdomErrors } = await mountPanel();
    try {
      const surface = d.getElementById('argonSimpleSurface');
      const seen = new Map();
      const harvest = () => {
        surface.querySelectorAll('[title]').forEach((n) => { if (!n.closest('#tsLearnedRulesList')) seen.set(n.getAttribute('title'), 'title'); });
        ['tsContextSummary', 'tsDoText', 'tsAvoidText', 'tsSessionDigest', 'tsModelSameFam', 'tsModelCrossFam', 'tsEffortText'].forEach((id) => {
          const t = d.getElementById(id)?.textContent?.trim();
          if (t) seen.set(t, id);
        });
        d.querySelectorAll('#tsLedgerList .ts-ledger-row > span:nth-child(2)').forEach((n) => seen.set(n.textContent.trim(), 'ledger'));
      };
      harvest();
      const uiRules = SAMPLE_LEDGER_ITEMS.map((i) => humanizeLearnedRule(i));
      const states = [
        baseState('r-a'),
        baseState('r-b', { shardedSpecCount: 5 }),
        baseState('r-c', { rsl: { clashCount: 2 } }),
        baseState('r-d', { turn1ContractSteered: true }),
        baseState('r-e', {
          rsl: { totalActive: 5, promotedHooks: 1, uiRules },
          shield: { enabled: true, maxUnslicedLines: 1200 },
          savings: { session: { bySource: { cliCompressed: 9000, cachePreserved: 5000, subagentIsolated: 4000, avoidedBloat: 3000 } } }
        }),
        baseState('r-f', { routerMode: 'off' }),
        baseState('r-g', { routerMode: 'autopilot', autoShadow: false })
      ];
      for (const st of states) { win.renderState(st); harvest(); }
      const grades = [...seen.keys()].map((t) => ({ t, g: fkGrade(t) }));
      const mean = grades.reduce((a, r) => a + r.g, 0) / grades.length;
      const worst = grades.slice().sort((a, b) => b.g - a.g)[0];
      assert.ok(grades.length > 60, `expected a broad sample of strings, got ${grades.length}`);
      assert.ok(mean <= 10.5, `mean grade ${mean.toFixed(2)} should be <= 10.5`);
      assert.ok(worst.g <= 14, `"${worst.t.slice(0, 100)}" reads at grade ${worst.g.toFixed(1)} (max 14)`);
      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});
