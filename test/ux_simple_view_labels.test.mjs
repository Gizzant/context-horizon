import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');

describe('Simple View labels and section blurbs (Antigravity HUD)', () => {
  const doc = new JSDOM(HTML).window.document;

  it('labels the cache ring with a visible PROMPT CACHE caption and tooltip', () => {
    const cap = doc.getElementById('simpleCacheRingCap');
    assert.ok(cap, '#simpleCacheRingCap exists');
    assert.equal(cap.textContent.trim().toLowerCase(), 'prompt cache');
    const wrap = doc.getElementById('simpleCacheRingWrap');
    assert.equal(wrap.getAttribute('role'), 'img');
    assert.ok(wrap.getAttribute('aria-label'));
    assert.match(wrap.getAttribute('title'), /'hit'.*'warm'/s);
  });

  it('labels the model chip and amnesia pill with tooltips', () => {
    assert.match(doc.getElementById('simpleModelChip').getAttribute('title'), /model and reasoning effort/i);
    const pill = doc.getElementById('simpleAmnesiaPill');
    assert.match(pill.textContent, /^Memory:/);
    assert.ok(pill.getAttribute('title'));
  });

  it('adds a short plain-English blurb to each Simple View section', () => {
    for (const id of ['storageCard', 'quotaStrip', 'actionCard', 'simpleFlightRecorder']) {
      const blurb = doc.getElementById(id).querySelector('.simple-sec-blurb');
      assert.ok(blurb, `${id} has a blurb`);
      const len = blurb.textContent.trim().length;
      assert.ok(len > 20 && len <= 160, `${id} blurb is one or two short sentences (${len} chars)`);
    }
    assert.ok(doc.querySelector('#timelineZone .simple-sec-blurb'), 'Practice Pulse blurb');
    assert.ok(doc.querySelector('#autoFixZone .simple-sec-blurb'), 'Auto-Guard blurb');
  });

  it('hides blurbs on short viewports to protect the Action Slot', () => {
    assert.match(HTML, /@media \(max-height: 580px\)\s*\{\s*body\[data-view-mode="simple"\] \.simple-sec-intro \.simple-sec-blurb \{ display: none; \}/);
  });
});

describe('Simple View labels and section blurbs (Claude Code static HUD)', () => {
  it('renders the ring caption, tooltip and section blurbs', () => {
    const { html } = renderHorizonPanelHtml({}, {});
    const doc = new JSDOM(html).window.document;
    const cap = doc.querySelector('.ah-ring-cap');
    assert.ok(cap, 'ring caption exists');
    assert.equal(cap.textContent.trim().toLowerCase(), 'prompt cache');
    assert.match(doc.getElementById('simpleCacheRingWrap').getAttribute('title'), /'hit'.*'warm'/s);
    assert.ok(doc.querySelectorAll('.ah-sec-blurb').length >= 5, 'at least 5 section blurbs');
  });
});

describe('Brand header: title left, logo right', () => {
  it('Antigravity HUD: header has Highbeam wordmark + h1 on the left and embedded logo on the right; tabs live in the controls row', () => {
    const doc = new JSDOM(HTML).window.document;
    const header = doc.querySelector('.wrap > header');
    assert.equal(header.querySelector('h1').textContent.trim(), 'Highbeam');
    const wordmark = header.querySelector('img.brand-wordmark');
    assert.ok(wordmark, 'wordmark exists');
    assert.match(wordmark.getAttribute('src'), /^data:image\/png;base64,/);
    const logo = header.querySelector('img.brand-logo');
    assert.ok(logo, 'logo exists');
    assert.match(logo.getAttribute('src'), /^data:image\/png;base64,/);
    assert.ok(wordmark.compareDocumentPosition(logo) & 4, 'logo follows the wordmark');
    assert.equal(header.querySelector('#tabSimple'), null);
    assert.ok(doc.querySelector('.header-controls #tabSimple'));
    assert.ok(doc.querySelector('.header-controls #tabAdvanced'));
  });

  it('Claude HUD: topbar has the Highbeam wordmark on the left and the embedded logo on the right', () => {
    const { html } = renderHorizonPanelHtml({}, {});
    const doc = new JSDOM(html).window.document;
    const top = doc.querySelector('header.ah-topbar');
    assert.match(top.querySelector('.ah-brand').textContent, /Highbeam/);
    assert.match(top.querySelector('img.ah-wordmark').getAttribute('src'), /^data:image\/png;base64,/);
    assert.match(top.querySelector('img.ah-logo').getAttribute('src'), /^data:image\/png;base64,/);
    assert.ok(doc.querySelector('#tabSimple') && doc.querySelector('#tabAdvanced'));
  });
});

describe('Active chat strip', () => {
  it('labels the conversation title and keeps pills in one aligned row', () => {
    const doc = new JSDOM(HTML).window.document;
    assert.equal(doc.querySelector('#activeConversationStrip .active-session-label').textContent.trim(), 'Active chat');
    assert.ok(doc.querySelector('#activeConversationStrip .active-session-chips #simpleAmnesiaPill'));
    assert.ok(doc.querySelector('#activeConversationStrip .active-session-chips #simpleModelChip'));
    assert.match(HTML, /simple-model-chip \{[^}]*margin-left: auto/);
  });
});

describe('Claude Code HUD parity with Antigravity Simple View', () => {
  const offenders = [{ name: 'src/server.mjs', occurrences: 5, tokens: 38400, pct: 40, ignorable: false }];
  const state = { sessionId: 'claude-parity', model: 'claude-sonnet-4-6', totalInputTokens: 96000, systemTokens: 6400, cachedTokens: 26600, distractorTokens: 63000 };

  it('puts Memory, mode and Model pills in one aligned row with the Model pill last (right-aligned)', () => {
    const doc = new JSDOM(renderHorizonPanelHtml(state, { offenders }).html).window.document;
    const row = doc.getElementById('activeChatPills');
    assert.ok(row, 'pills row exists');
    assert.ok(!doc.querySelector('.ah-verdict-row #simpleAmnesiaPill'), 'pills left the verdict row');
    const ids = [...row.children].map((el) => el.id);
    assert.deepEqual(ids, ['simpleAmnesiaPill', 'flightModeBadge', 'modelBadge']);
    assert.match(row.querySelector('#simpleAmnesiaPill').textContent, /^Memory:/);
    assert.match(row.querySelector('#modelBadge').textContent, /^Model:/);
  });

  it('labels the waste/hogs section and gives 30d a tooltip', () => {
    const doc = new JSDOM(renderHorizonPanelHtml(state, { offenders }).html).window.document;
    assert.match(doc.querySelector('#capacityAndCacheCard .ah-sec-gap').textContent, /Waste & prompt cache/);
    assert.ok(doc.getElementById('simpleTopHogsDrawer'));
    assert.ok(doc.getElementById('savedWorkspace30d').getAttribute('title'));
    assert.match(doc.querySelector('.ah-brand').textContent, /^Highbeam/);
  });
});
