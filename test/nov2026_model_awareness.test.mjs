/**
 * November 2026 Model Awareness Audit & Verification Suite
 * Covers all 22 live Antigravity host model IDs & display names, plus November 2026
 * Google (Gemini 4 Hydrogen + xhigh effort, Orchestrator Carbon/Argon) &
 * Anthropic (Claude Fable 5.2, Claude Mythos 5.2/5.1, Haiku/Sonnet/Opus 5.5, Opus 4.7/4.8) releases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import {
  MODEL_REGISTRY,
  SHARED_1M_CONTEXT_POOL_TOKENS,
  normalizeModelId,
  resolveModelDescriptor,
  validateModelDescriptor,
  resolveModelCeiling,
  resolveModelRates,
  resolveEffortProfile,
  loadModelCatalog
} from '../src/core/constants.mjs';
import { classifyHorizon } from '../src/core/classifier.mjs';
import {
  resolveModelPoolDisplayName,
  resolveModelShortName,
  humanizeModelLabel,
  hasExplicitPrefixMutation,
  detectModelSwitchCause
} from '../src/core/quota.mjs';
import { resolveSessionModel } from '../src/core/parser.mjs';
import {
  normalizeModelId as normalizeRouterModelId,
  normalizeEffortTier,
  getQuotaMultiplier
} from '../src/core/task_quota_router.mjs';
import {
  getCostMultiplier,
  formatShortFamilyLabel
} from '../src/core/coach/task_quota_router.mjs';
import { isFrontierSwarmModel } from '../src/core/subagents.mjs';
import {
  BUILTIN_CATALOG,
  isKnownCatalogModel,
  normalizeModelId as normalizeClaudeCatalogModelId
} from '../src/core-isomorphic/config/catalogLoader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

const LIVE_ANTIGRAVITY_MODELS = [
  { id: 'claude-opus-5-5-low', display: 'Claude Opus 5.5 (Low)', canonical: 'claude-opus-5-5', family: 'opus', ceiling: 1000000, effort: 'FAST', short: 'Opus 5.5', pool: 'Claude Opus 5.5' },
  { id: 'claude-opus-5-5-medium', display: 'Claude Opus 5.5 (Medium)', canonical: 'claude-opus-5-5', family: 'opus', ceiling: 1000000, effort: 'STANDARD', short: 'Opus 5.5', pool: 'Claude Opus 5.5' },
  { id: 'claude-opus-5-5-high', display: 'Claude Opus 5.5 (High)', canonical: 'claude-opus-5-5', family: 'opus', ceiling: 1000000, effort: 'HIGH', short: 'Opus 5.5', pool: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5-low', display: 'Claude Sonnet 5.5 (Low)', canonical: 'claude-sonnet-5-5', family: 'sonnet', ceiling: 1000000, effort: 'FAST', short: 'Sonnet 5.5', pool: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-5-5-medium', display: 'Claude Sonnet 5.5 (Medium)', canonical: 'claude-sonnet-5-5', family: 'sonnet', ceiling: 1000000, effort: 'STANDARD', short: 'Sonnet 5.5', pool: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-5-5-high', display: 'Claude Sonnet 5.5 (High)', canonical: 'claude-sonnet-5-5', family: 'sonnet', ceiling: 1000000, effort: 'HIGH', short: 'Sonnet 5.5', pool: 'Claude Sonnet 5.5' },
  { id: 'gemini-3.8-flash-low', display: 'Gemini 3.8 Flash (Low)', canonical: 'gemini-3.8-flash', family: 'flash', ceiling: 256000, effort: 'FAST', short: 'Flash', pool: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.8-flash-medium', display: 'Gemini 3.8 Flash (Medium)', canonical: 'gemini-3.8-flash', family: 'flash', ceiling: 256000, effort: 'STANDARD', short: 'Flash', pool: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.8-flash-high', display: 'Gemini 3.8 Flash (High)', canonical: 'gemini-3.8-flash', family: 'flash', ceiling: 256000, effort: 'HIGH', short: 'Flash', pool: 'Gemini 3.8 Flash' },
  { id: 'gemini-4-argon-low', display: 'Gemini 4 Argon (Low)', canonical: 'gemini-4-argon', family: 'argon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'FAST', short: 'Argon', pool: 'Gemini 4 Argon' },
  { id: 'gemini-4-argon-medium', display: 'Gemini 4 Argon (Medium)', canonical: 'gemini-4-argon', family: 'argon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Argon', pool: 'Gemini 4 Argon' },
  { id: 'gemini-4-argon-high', display: 'Gemini 4 Argon (High)', canonical: 'gemini-4-argon', family: 'argon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'HIGH', short: 'Argon', pool: 'Gemini 4 Argon' },
  { id: 'gemini-4-carbon-low', display: 'Gemini 4 Carbon (Low)', canonical: 'gemini-4-carbon', family: 'carbon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'FAST', short: 'Carbon', pool: 'Gemini 4 Carbon' },
  { id: 'gemini-4-carbon-medium', display: 'Gemini 4 Carbon (Medium)', canonical: 'gemini-4-carbon', family: 'carbon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Carbon', pool: 'Gemini 4 Carbon' },
  { id: 'gemini-4-carbon-high', display: 'Gemini 4 Carbon (High)', canonical: 'gemini-4-carbon', family: 'carbon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'HIGH', short: 'Carbon', pool: 'Gemini 4 Carbon' },
  { id: 'gemini-4-hydrogen-low', display: 'Gemini 4 Hydrogen (Low)', canonical: 'gemini-4-hydrogen', family: 'hydrogen', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'FAST', short: 'Hydrogen', pool: 'Gemini 4 Hydrogen' },
  { id: 'gemini-4-hydrogen-medium', display: 'Gemini 4 Hydrogen (Medium)', canonical: 'gemini-4-hydrogen', family: 'hydrogen', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Hydrogen', pool: 'Gemini 4 Hydrogen' },
  { id: 'gemini-4-hydrogen-high', display: 'Gemini 4 Hydrogen (High)', canonical: 'gemini-4-hydrogen', family: 'hydrogen', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'HIGH', short: 'Hydrogen', pool: 'Gemini 4 Hydrogen' },
  { id: 'gemini-4-hydrogen-xhigh', display: 'Gemini 4 Hydrogen (XHigh)', canonical: 'gemini-4-hydrogen', family: 'hydrogen', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'HIGH', short: 'Hydrogen', pool: 'Gemini 4 Hydrogen' },
  { id: 'gemini-4-neon-low', display: 'Gemini 4 Neon (Low)', canonical: 'gemini-4-neon', family: 'neon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'FAST', short: 'Neon', pool: 'Gemini 4 Neon' },
  { id: 'gemini-4-neon-medium', display: 'Gemini 4 Neon (Medium)', canonical: 'gemini-4-neon', family: 'neon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Neon', pool: 'Gemini 4 Neon' },
  { id: 'gemini-4-neon-high', display: 'Gemini 4 Neon (High)', canonical: 'gemini-4-neon', family: 'neon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'HIGH', short: 'Neon', pool: 'Gemini 4 Neon' },
  { id: 'gemini-4-neon-xhigh', display: 'Gemini 4 Neon (XHigh)', canonical: 'gemini-4-neon', family: 'neon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'HIGH', short: 'Neon', pool: 'Gemini 4 Neon' },
  { id: 'gemini-pro-orchestrator', display: 'Orchestrator (Carbon)', canonical: 'gemini-4-carbon', family: 'carbon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Carbon', pool: 'Gemini 4 Carbon' },
  { id: 'gemini-pro-orchestrator-argon', display: 'Orchestrator (Argon)', canonical: 'gemini-4-argon', family: 'argon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Argon', pool: 'Gemini 4 Argon' },
  { id: 'gemini-pro-orchestrator-neon', display: 'Orchestrator (Neon)', canonical: 'gemini-4-neon', family: 'neon', ceiling: SHARED_1M_CONTEXT_POOL_TOKENS, effort: 'STANDARD', short: 'Neon', pool: 'Gemini 4 Neon' },
  { id: 'gpt-oss-120b-medium', display: 'GPT-OSS 120B (Medium)', canonical: 'gpt-oss-120b', family: 'gpt-oss', ceiling: 128000, effort: 'STANDARD', short: 'GPT-OSS', pool: 'GPT-OSS 120B' }
];

const EXTRA_CURRENT_MODELS = [
  { id: 'claude-fable-5-2', display: 'Claude Fable 5.2 (High)', canonical: 'claude-fable-5-2', family: 'fable', ceiling: 1000000, short: 'Fable 5.2', pool: 'Claude Fable 5.2', inputRate: 8.0, outputRate: 40.0, readRate: 0.2 },
  { id: 'claude-mythos-5-2', display: 'Claude Mythos 5.2 (High)', canonical: 'claude-mythos-5-2', family: 'mythos', ceiling: 1000000, short: 'Mythos 5.2', pool: 'Claude Mythos 5.2', inputRate: 8.0, outputRate: 40.0, readRate: 0.2 },
  { id: 'claude-mythos-5-1', display: 'Claude Mythos 5.1 (Medium)', canonical: 'claude-mythos-5-1', family: 'mythos', ceiling: 1000000, short: 'Mythos 5.1', pool: 'Claude Mythos 5.1', inputRate: 10.0, outputRate: 50.0, readRate: 0.25 },
  { id: 'claude-haiku-5-5', display: 'Claude Haiku 5.5', canonical: 'claude-haiku-5-5', family: 'haiku', ceiling: 1000000, short: 'Haiku 5.5', pool: 'Claude Haiku 5.5', inputRate: 0.1, outputRate: 0.5, readRate: 0.01 },
  { id: 'claude-opus-4-8', display: 'Claude Opus 4.8', canonical: 'claude-opus-4-8', family: 'opus', ceiling: 1000000, short: 'Opus 4.8', pool: 'Claude Opus 4.8', inputRate: 5.0, outputRate: 25.0, readRate: 0.5 },
  { id: 'claude-opus-4-7', display: 'Claude Opus 4.7', canonical: 'claude-opus-4-7', family: 'opus', ceiling: 1000000, short: 'Opus 4.7', pool: 'Claude Opus 4.7', inputRate: 5.0, outputRate: 25.0, readRate: 0.5 }
];

async function mountPanel() {
  const rawHtml = fs.readFileSync(HTML_PATH, 'utf8')
    .replace(/window\.__LIVE_INITIAL_STATE__\s*=/, 'window.__LIVE_INITIAL_STATE_DISABLED__ =');
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
  await new Promise((r) => setTimeout(r, 70));
  return { dom, win: dom.window, d: dom.window.document, jsdomErrors };
}

describe('November 2026 Google & Anthropic Model Awareness', () => {
  it('resolves all 22 live Antigravity host model IDs and display names accurately', () => {
    for (const m of LIVE_ANTIGRAVITY_MODELS) {
      for (const input of [m.id, m.display]) {
        const desc = resolveModelDescriptor(input);
        assert.ok(desc, `Missing descriptor for ${input}`);
        assert.equal(validateModelDescriptor(desc).valid, true, `Invalid descriptor for ${input}`);
        assert.equal(desc.id, m.canonical, `${input} -> canonical id`);
        assert.equal(desc.family, m.family, `${input} -> family`);
        assert.equal(resolveModelCeiling(input), m.ceiling, `${input} -> ceiling`);
        assert.equal(resolveModelShortName(input), m.short, `${input} -> short name`);
        assert.equal(resolveModelPoolDisplayName(input), m.pool, `${input} -> pool display name`);
        assert.equal(normalizeRouterModelId(input), m.canonical, `${input} -> task_quota_router normalizeModelId`);
      }

      assert.equal(resolveEffortProfile(m.id).tier, m.effort, `${m.id} -> effort profile`);
      assert.equal(resolveEffortProfile(m.display).tier, m.effort, `${m.display} -> effort profile`);
      assert.equal(normalizeModelId(m.display).length > 0, true);
    }
  });

  it('supports Gemini 4 Hydrogen & Gemini 4 Neon pricing, 1M pool, max_output_tokens, and xhigh effort tier', () => {
    const stdRates = resolveModelRates('gemini-4-hydrogen', '2026-11-16T12:00:00Z', 'standard');
    assert.equal(stdRates.input_per_1m, 1.5);
    assert.equal(stdRates.output_per_1m, 7.5);
    assert.equal(stdRates.cached_read_per_1m, 0.075);

    const prioRates = resolveModelRates('gemini-4-hydrogen-xhigh', '2026-11-16T12:00:00Z', 'priority');
    assert.equal(prioRates.input_per_1m, 2.7);
    assert.equal(prioRates.output_per_1m, 13.5);
    assert.equal(prioRates.cached_read_per_1m, 0.075);

    assert.equal(MODEL_REGISTRY['gemini-4-hydrogen'].max_output_tokens, 65536);
    assert.deepEqual(MODEL_REGISTRY['gemini-4-hydrogen'].supported_efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(normalizeEffortTier('xhigh'), 'xhigh');
    assert.equal(normalizeEffortTier('Extra High'), 'xhigh');
    assert.equal(getQuotaMultiplier('gemini-4-hydrogen', 'xhigh'), 6.0);
    assert.equal(getCostMultiplier('gemini-4-hydrogen', 'xhigh'), 6.0);
    assert.equal(formatShortFamilyLabel('gemini-4-hydrogen'), 'Hydrogen');

    const neonStd = resolveModelRates('gemini-4-neon', '2026-11-18T12:00:00Z', 'standard');
    assert.equal(neonStd.input_per_1m, 3.0);
    assert.equal(neonStd.output_per_1m, 15.0);
    assert.equal(neonStd.cached_read_per_1m, 0.15);

    const neonPrio = resolveModelRates('gemini-4-neon-xhigh', '2026-11-18T12:00:00Z', 'priority');
    assert.equal(neonPrio.input_per_1m, 5.4);
    assert.equal(neonPrio.output_per_1m, 27.0);
    assert.equal(neonPrio.cached_read_per_1m, 0.15);

    assert.equal(MODEL_REGISTRY['gemini-4-neon'].max_output_tokens, 65536);
    assert.deepEqual(MODEL_REGISTRY['gemini-4-neon'].supported_efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(getQuotaMultiplier('gemini-4-neon', 'low'), 2.4);
    assert.equal(getQuotaMultiplier('gemini-4-neon', 'medium'), 4.5);
    assert.equal(getQuotaMultiplier('gemini-4-neon', 'high'), 7.5);
    assert.equal(getQuotaMultiplier('gemini-4-neon', 'xhigh'), 11.0);
    assert.equal(getCostMultiplier('gemini-4-neon', 'xhigh'), 11.0);
    assert.equal(formatShortFamilyLabel('gemini-4-neon'), 'Neon');
    assert.equal(isFrontierSwarmModel('gemini-4-neon-high'), true);
    assert.equal(isFrontierSwarmModel('Orchestrator (Neon)'), true);

    // Internal Orchestrator/subagent Flash worker slug
    const workerDesc = resolveModelDescriptor('gemini-flash-worker-agy');
    assert.ok(workerDesc);
    assert.equal(workerDesc.id, 'gemini-3.8-flash');
    assert.equal(resolveModelCeiling('gemini-flash-worker-agy'), 256000);
    assert.equal(resolveModelPoolDisplayName('gemini-flash-worker-agy'), 'Gemini 3.8 Flash');
    assert.equal(resolveModelShortName('gemini-flash-worker-agy'), 'Flash');

    // Label humanization & JSONL transcript resolution without <USER_SETTINGS_CHANGE>
    assert.equal(humanizeModelLabel('claude-sonnet-5-5-medium'), 'Claude Sonnet 5.5');
    assert.equal(humanizeModelLabel('gpt-oss-120b-medium'), 'GPT-OSS 120B');
    assert.equal(humanizeModelLabel('gemini-pro-orchestrator-neon'), 'Orchestrator (Neon)');
    assert.equal(humanizeModelLabel('gemini-4-neon-xhigh'), 'Gemini 4 Neon');

    const orchSteps = [
      { type: 'USER_INPUT', content: 'Plan feature' },
      { type: 'PLANNER_RESPONSE', turnMetadata: { model: 'gemini-pro-orchestrator-neon' } },
      { type: 'PLANNER_RESPONSE', turnMetadata: { model: 'gemini-flash-worker-agy' } }
    ];
    const resolvedOrch = resolveSessionModel({ steps: orchSteps });
    assert.equal(resolvedOrch.id, 'gemini-4-neon');
    assert.equal(resolvedOrch.raw, 'Orchestrator (Neon)');
    assert.equal(resolvedOrch.source, 'transcript');

    // Internal Orchestrator planner <-> worker handoff must not trigger false user model_switch busts
    assert.equal(
      hasExplicitPrefixMutation(
        { type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy' },
        { type: 'PLANNER_RESPONSE', model: 'gemini-pro-orchestrator-neon' }
      ),
      false
    );
    assert.equal(
      detectModelSwitchCause(
        { type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy' },
        { type: 'PLANNER_RESPONSE', model: 'gemini-pro-orchestrator-neon' }
      ),
      null
    );
  });

  it('supports Anthropic Fable 5.2, Mythos 5.2/5.1, Haiku/Sonnet/Opus 5.5, and Opus 4.7/4.8 across all resolvers', () => {
    for (const m of EXTRA_CURRENT_MODELS) {
      for (const input of [m.id, m.display]) {
        const desc = resolveModelDescriptor(input);
        assert.ok(desc, `Missing descriptor for ${input}`);
        assert.equal(validateModelDescriptor(desc).valid, true);
        assert.equal(desc.id, m.canonical);
        assert.equal(desc.family, m.family);
        assert.equal(resolveModelCeiling(input), m.ceiling);
        assert.equal(resolveModelShortName(input), m.short);
        assert.equal(resolveModelPoolDisplayName(input), m.pool);
      }
      const rates = resolveModelRates(m.id);
      assert.equal(rates.input_per_1m, m.inputRate);
      assert.equal(rates.output_per_1m, m.outputRate);
      assert.equal(rates.cached_read_per_1m, m.readRate);
    }

    assert.equal(normalizeRouterModelId('claude-mythos-5-2'), 'claude-mythos-5-2');
    assert.equal(normalizeRouterModelId('Claude Mythos 5.2 (High)'), 'claude-mythos-5-2');
    assert.equal(formatShortFamilyLabel('claude-mythos-5-2'), 'Mythos');
    assert.equal(isFrontierSwarmModel('claude-fable-5-2'), true);
    assert.equal(isFrontierSwarmModel('claude-mythos-5-2'), true);
    assert.equal(isFrontierSwarmModel('Orchestrator (Carbon)'), true);

    assert.equal(isKnownCatalogModel('claude-opus-5-5-high'), true);
    assert.equal(normalizeClaudeCatalogModelId('claude-opus-5-5-high'), 'claude-opus-5-5');
    assert.equal(isKnownCatalogModel('Claude Opus 5.5 (High)'), true);
    assert.equal(normalizeClaudeCatalogModelId('Claude Opus 5.5 (High)'), 'claude-opus-5-5');
    assert.equal(isKnownCatalogModel('claude-fable-5-2'), true);
    assert.equal(isKnownCatalogModel('claude-mythos-5-2'), true);
    assert.equal(normalizeClaudeCatalogModelId('mythos-5-2'), 'claude-mythos-5-2');
  });

  it('keeps modelCatalog.json files byte-identical and anthropicModelCatalog deep-equal to BUILTIN_CATALOG', () => {
    const srcRaw = fs.readFileSync(path.join(ROOT, 'src', 'config', 'modelCatalog.json'), 'utf8');
    const rootRaw = fs.readFileSync(path.join(ROOT, 'config', 'modelCatalog.json'), 'utf8');
    assert.equal(srcRaw, rootRaw, 'src/config/modelCatalog.json and config/modelCatalog.json must be byte-identical');

    const catalog = loadModelCatalog(undefined, { forceReload: true });
    assert.ok(catalog?.models?.['gemini-4-neon']);
    assert.ok(catalog?.models?.['gemini-4-hydrogen']);
    assert.ok(catalog?.models?.['claude-fable-5-2']);
    assert.ok(catalog?.models?.['claude-mythos-5-2']);

    const anthropicDisk = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'core-isomorphic', 'config', 'anthropicModelCatalog.json'), 'utf8')
    );
    assert.deepEqual(BUILTIN_CATALOG, anthropicDisk);
    assert.equal(anthropicDisk.effortExpectedOutputTokens.xhigh, 5000);
  });

  it('classifies and renders Gemini 4 Neon (XHigh), Orchestrator (Neon), Gemini 4 Hydrogen (XHigh), Orchestrator (Argon), Fable 5.2, and Mythos 5.2 in Simple View JSDOM', async () => {
    const steps = [
      { type: 'USER_INPUT', createdAt: '2026-11-16T12:00:00Z', content: 'Review architecture and fix bugs' },
      { type: 'PLANNER_RESPONSE', createdAt: '2026-11-16T12:00:05Z', content: 'Reviewed modules and applied patch.' }
    ];

    const nState = classifyHorizon(steps, {
      modelId: 'gemini-4-neon-xhigh',
      modelLabel: 'Gemini 4 Neon (XHigh)',
      useNativeCeiling: true
    });
    assert.equal(nState.model.canonicalId, 'gemini-4-neon');
    assert.equal(nState.model.family, 'neon');
    assert.equal(nState.model.displayName, 'Gemini 4 Neon');
    assert.equal(nState.model.rawLabel, 'Gemini 4 Neon (XHigh)');
    assert.equal(nState.model.nativeCeilingTokens, SHARED_1M_CONTEXT_POOL_TOKENS);

    const orchNeonState = classifyHorizon(steps, {
      modelId: 'gemini-pro-orchestrator-neon',
      useNativeCeiling: true
    });
    assert.equal(orchNeonState.model.canonicalId, 'gemini-4-neon');
    assert.equal(orchNeonState.model.family, 'neon');
    assert.equal(orchNeonState.model.displayName, 'Orchestrator (Neon)');

    const hState = classifyHorizon(steps, {
      modelId: 'gemini-4-hydrogen-xhigh',
      modelLabel: 'Gemini 4 Hydrogen (XHigh)',
      useNativeCeiling: true
    });
    assert.equal(hState.model.canonicalId, 'gemini-4-hydrogen');
    assert.equal(hState.model.family, 'hydrogen');
    assert.equal(hState.model.displayName, 'Gemini 4 Hydrogen');
    assert.equal(hState.model.rawLabel, 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(hState.model.nativeCeilingTokens, SHARED_1M_CONTEXT_POOL_TOKENS);

    const { dom, win, d, jsdomErrors } = await mountPanel();
    const txt = (id) => d.getElementById(id)?.textContent?.trim() || '';
    try {
      win.renderState({
        sessionId: 'nov2026-neon',
        storeSource: 'antigravity',
        model: nState.model,
        activeEffortProfile: { tier: 'HIGH', shortLabel: 'XHigh', label: 'XHigh' },
        window: { totalActiveTokens: 48000, safeLimit: 720000, maxTokens: SHARED_1M_CONTEXT_POOL_TOKENS },
        breakdown: { ANCHOR: 10000, MEMORY_KI: 0, STALE_DUPLICATE: 0, ACTIVE_WORKING_SET: 38000 }
      });
      assert.equal(txt('tufteTopHostBadge'), 'Antigravity · Gemini 4 Neon (XHigh)');
      assert.match(txt('tsModelSameFam'), /Gemini.*Neon\/Carbon\/Argon\/Hydrogen\/Flash/);
      assert.match(txt('tsModelCrossFam'), /To Claude:/);
      assert.equal(txt('usedMaxTok'), '1M');

      win.renderState({
        sessionId: 'nov2026-hydrogen',
        storeSource: 'antigravity',
        model: hState.model,
        activeEffortProfile: { tier: 'HIGH', shortLabel: 'XHigh', label: 'XHigh' },
        window: { totalActiveTokens: 48000, safeLimit: 720000, maxTokens: SHARED_1M_CONTEXT_POOL_TOKENS },
        breakdown: { ANCHOR: 10000, MEMORY_KI: 0, STALE_DUPLICATE: 0, ACTIVE_WORKING_SET: 38000 }
      });
      assert.equal(txt('tufteTopHostBadge'), 'Antigravity · Gemini 4 Hydrogen (XHigh)');
      assert.match(txt('tsModelSameFam'), /Gemini.*Neon\/Carbon\/Argon\/Hydrogen\/Flash/);
      assert.match(txt('tsModelCrossFam'), /To Claude:/);
      assert.equal(txt('usedMaxTok'), '1M');

      win.renderState({
        sessionId: 'nov2026-orchestrator-argon',
        storeSource: 'antigravity',
        model: {
          id: 'gemini-pro-orchestrator-argon',
          canonicalId: 'gemini-4-argon',
          family: 'argon',
          displayName: 'Orchestrator (Argon)',
          rawLabel: 'Orchestrator (Argon)',
          nativeCeilingTokens: SHARED_1M_CONTEXT_POOL_TOKENS
        },
        activeEffortProfile: { tier: 'STANDARD', shortLabel: 'Auto', label: 'Auto' },
        window: { totalActiveTokens: 32000, safeLimit: 720000, maxTokens: SHARED_1M_CONTEXT_POOL_TOKENS },
        breakdown: { ANCHOR: 8000, MEMORY_KI: 0, STALE_DUPLICATE: 0, ACTIVE_WORKING_SET: 24000 }
      });
      assert.equal(txt('tufteTopHostBadge'), 'Antigravity · Orchestrator (Argon) (Auto)');
      assert.match(txt('tsModelCrossFam'), /To Claude:/);

      win.renderState({
        sessionId: 'nov2026-mythos',
        storeSource: 'claude-code',
        model: {
          id: 'claude-mythos-5-2',
          canonicalId: 'claude-mythos-5-2',
          family: 'mythos',
          displayName: 'Claude Mythos 5.2',
          rawLabel: 'Claude Mythos 5.2 (High)',
          nativeCeilingTokens: 1000000
        },
        activeEffortProfile: { tier: 'HIGH', shortLabel: 'High', label: 'High' },
        window: { totalActiveTokens: 52000, safeLimit: 700000, maxTokens: 1000000 },
        breakdown: { ANCHOR: 12000, MEMORY_KI: 0, STALE_DUPLICATE: 0, ACTIVE_WORKING_SET: 40000 }
      });
      assert.equal(txt('tufteTopHostBadge'), 'Claude Code · Claude Mythos 5.2 (High)');
      assert.match(txt('tsModelSameFam'), /Claude.*Fable\/Opus\/Sonnet\/Haiku/);
      assert.match(txt('tsModelCrossFam'), /To Gemini:/);

      win.renderState({
        sessionId: 'nov2026-fable',
        storeSource: 'claude-code',
        model: {
          id: 'claude-fable-5-2',
          canonicalId: 'claude-fable-5-2',
          family: 'fable',
          displayName: 'Claude Fable 5.2',
          rawLabel: 'Claude Fable 5.2 (High)',
          nativeCeilingTokens: 1000000
        },
        activeEffortProfile: { tier: 'HIGH', shortLabel: 'High', label: 'High' },
        window: { totalActiveTokens: 52000, safeLimit: 700000, maxTokens: 1000000 },
        breakdown: { ANCHOR: 12000, MEMORY_KI: 0, STALE_DUPLICATE: 0, ACTIVE_WORKING_SET: 40000 }
      });
      assert.equal(txt('tufteTopHostBadge'), 'Claude Code · Claude Fable 5.2 (High)');
      assert.match(txt('tsModelSameFam'), /Claude.*Fable\/Opus\/Sonnet\/Haiku/);

      assert.deepEqual(jsdomErrors, []);
    } finally {
      dom.window.close();
    }
  });
});
