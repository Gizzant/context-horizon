import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { isCliMain } from '../src/cli/init.mjs';
import {
  isHudMain,
  formatDemoScenarioAnsi,
  runCLI,
  stripAnsi,
  visibleWidth,
  clampAnsiLine
} from '../src/cli/horizon_hud.mjs';
import { isPostmortemMain } from '../src/cli/postmortem.mjs';
import { isDoctorMain } from '../src/cli/doctor.mjs';
import { BUILTIN_PANELS } from '../src/webview/registry.mjs';
import { selectHighestPriorityTier2Card } from '../src/ui/horizon_panel.js';
import { buildGitCommitTokenLedger } from '../src/core/git_ledger.mjs';
import { upsertFencedCoachBlock } from '../src/core/coach/turn_zero_gate.mjs';
import { applyRuleDeltaToContent, PrefixCacheShield } from '../src/core/prefix_cache_shield.mjs';
import { serializeScriptJson, buildDemoPage } from '../scripts/build_demo_page.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';
import {
  FULL_TOOL_HOOK_MATCHER,
  LEAN_PRE_TOOL_HOOK_MATCHER,
  LEAN_POST_TOOL_HOOK_MATCHER
} from '../src/core/layer5_hygiene.mjs';
import { JSDOM } from 'jsdom';

const INTERNAL_REPO_RE = new RegExp('ga-visualizer' + '-v2', 'i');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'evaluation_bundles') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function hexToRelativeLuminance(hex) {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function contrastRatio(hexA, hexB) {
  const l1 = hexToRelativeLuminance(hexA);
  const l2 = hexToRelativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Batch 4 Remediation — ISS-013: Symlink-Safe realpathSync isCliMain & Removal of context-horizon Bin Collision', () => {
  it('removes "context-horizon" from package.json bin while retaining primary branded CLIs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.bin['context-horizon'], undefined, 'Grafana-colliding context-horizon bin must be removed');
    assert.equal(pkg.bin['attention-horizon-antigravity'], './src/cli/init.mjs');
    assert.equal(pkg.bin['ah-antigravity'], './src/cli/init.mjs');
    assert.ok(pkg.bin['ctxtop'] === './bin/ctxtop.mjs' || pkg.bin['ctxtop'] === './src/cli/init.mjs');
  });

  it('resolves symlinked CLI invocations via fs.realpathSync across init, hud, postmortem, and doctor', () => {
    const initPath = path.join(ROOT, 'src', 'cli', 'init.mjs');
    const hudPath = path.join(ROOT, 'src', 'cli', 'horizon_hud.mjs');
    const postPath = path.join(ROOT, 'src', 'cli', 'postmortem.mjs');
    const docPath = path.join(ROOT, 'src', 'cli', 'doctor.mjs');

    assert.equal(isCliMain(initPath), true);
    assert.equal(isHudMain(hudPath), true);
    assert.equal(isPostmortemMain(postPath), true);
    assert.equal(isDoctorMain(docPath), true);
    assert.equal(isCliMain(''), false);

    const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bin-symlink-'));
    try {
      const symlinkA = path.join(tmpBinDir, 'attention-horizon-antigravity');
      const symlinkB = path.join(tmpBinDir, 'ah-antigravity');
      let symlinkCreated = false;
      try {
        fs.symlinkSync(initPath, symlinkA);
        fs.symlinkSync(initPath, symlinkB);
        symlinkCreated = true;
      } catch (err) {
        // Windows without Developer Mode symlink privilege may reject file symlinks
        if (err && !['EPERM', 'EINVAL', 'ENOSYS'].includes(err.code)) throw err;
      }
      if (symlinkCreated) {
        assert.equal(isCliMain(symlinkA), true, 'Symlink attention-horizon-antigravity must resolve isCliMain === true');
        assert.equal(isCliMain(symlinkB), true, 'Symlink ah-antigravity must resolve isCliMain === true');
        const helpOut = execFileSync(process.execPath, [symlinkA, '--help'], { encoding: 'utf8' });
        assert.match(helpOut, /Highbeam/i);
      }
    } finally {
      fs.rmSync(tmpBinDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 4 Remediation — ISS-015 & ISS-016: Unified "Highbeam" Branding & sidecar://agy-horizon-flightcheck Deep-Link', () => {
  it('updates skills/horizon/SKILL.md deep-link and eliminates hidden Context Memory span in WebView HTML', () => {
    const skillMd = fs.readFileSync(path.join(ROOT, 'skills', 'horizon', 'SKILL.md'), 'utf8');
    assert.match(skillMd, /^# Highbeam \(`\/horizon`\)/m);
    assert.ok(skillMd.includes('[Open Highbeam](sidecar://agy-horizon-flightcheck/horizon-daemon/)'));
    assert.ok(!skillMd.includes('sidecar://agy-horizon/'));

    const sidecarJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'sidecars', 'horizon-daemon', 'sidecar.json'), 'utf8'));
    assert.equal(sidecarJson.display_name, 'Highbeam');
    assert.equal(sidecarJson.ui_config.views[0].title, 'Highbeam');

    assert.equal(BUILTIN_PANELS[0].title, '40-Cell Chronological Attention Horizon');
    const batonCard = selectHighestPriorityTier2Card({ turnCount: 46 });
    assert.match(batonCard.subtitle, /^Highbeam approaching high-turn degradation/);

    const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
    assert.ok(html.includes('<h1>Highbeam</h1>'));
    assert.ok(!html.includes('<span style="display:none"> Context Memory</span>'));

    const docsHtml = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
    assert.ok(docsHtml.includes('<h1>Highbeam</h1>'));
    assert.ok(!docsHtml.includes('<span style="display:none"> Context Memory</span>'));
  });

  it('unifies Highbeam across CLI banners, git_ledger, rules, issue templates, SVGs, and PowerShell bundle script', () => {
    const ledger = buildGitCommitTokenLedger('', [], {
      headLogContent: '0000 1111 Dev <d@e.com> 1762630000 +0000\tcommit: test\n'
    });
    assert.ok(ledger.prMarkdownSummary.includes('### ⚡ Highbeam PR Token Ledger'));

    const checkFiles = [
      'src/cli/init.mjs',
      'src/cli/horizon_hud.mjs',
      'src/cli/postmortem.mjs',
      'src/core/git_ledger.mjs',
      'rules/AGENTS.md',
      'AGENTS.md',
      '.agents/skills/hn-ui-audit/SKILL.md',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      'scripts/generate_hero_svg.mjs',
      'assets/hero-demo.svg',
      'assets/social-preview.svg'
    ];
    for (const rel of checkFiles) {
      const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/Context Horizon/i.test(txt), `${rel} must not contain "Context Horizon"`);
      assert.ok(!/npx\s+context-horizon/i.test(txt), `${rel} must not contain "npx context-horizon"`);
    }

    const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'build-ui-audit-bundle.ps1'), 'utf8');
    assert.ok(ps1.includes('Join-Path $PSScriptRoot ".."'), 'build-ui-audit-bundle.ps1 must derive $ProjectRoot from $PSScriptRoot');
    assert.ok(!INTERNAL_REPO_RE.test(ps1), 'build-ui-audit-bundle.ps1 must not hardcode internal repo folder name');
  });
});

describe('Batch 4 Remediation — ISS-017: Public Documentation Cleanliness & Removal of Leaked Authoring Prompts', () => {
  it('removes leaked authoring prompts, archive reports, and root task.md and eliminates local file:/// links in docs', () => {
    const deletedPaths = [
      'task.md',
      'docs/argon_antigravity_coach_implementation_prompt.md',
      'docs/specs/stage_0_architecture_implementation_plan_prompt.md',
      'docs/specs/stage_1_schemas_config_shared_ipc_spine_prompt.md',
      'docs/specs/stage_6_deterministic_tdd_suite_benchmarks_packaging_prompt.md',
      'docs/archive'
    ];
    for (const rel of deletedPaths) {
      assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} must be removed from repository`);
    }

    const docFiles = [
      path.join(ROOT, 'README.md'),
      path.join(ROOT, 'CHANGELOG.md'),
      path.join(ROOT, 'CONTRIBUTING.md'),
      ...walkFiles(path.join(ROOT, 'design-system')).filter(f => f.endsWith('.md')),
      ...walkFiles(path.join(ROOT, 'docs')).filter(f => f.endsWith('.md'))
    ];
    assert.ok(docFiles.length >= 10, 'Expected public markdown documentation files');
    for (const f of docFiles) {
      const txt = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      assert.ok(!/Context Horizon/i.test(txt), `${rel} must not contain legacy "Context Horizon"`);
      assert.ok(!/context-horizon/i.test(txt), `${rel} must not contain legacy "context-horizon"`);
      assert.ok(!INTERNAL_REPO_RE.test(txt), `${rel} must not leak internal repo folder name`);
      assert.ok(!/file:\/\/\/[cC]:\/Projects/i.test(txt), `${rel} must not contain machine-local file:///C:/Projects links`);
    }
  });
});

describe('Batch 4 Remediation — ISS-046: $-Safe Function Replacements & </script>-Safe JSON.stringify', () => {
  it('preserves literal $&, $\', $`, $1, and $$ in TurnZeroGate and PrefixCacheShield replacements', () => {
    const dollarPayload = 'Enforce cost cap $1.50, awk $1, PowerShell $_ / $& / $\' / $` and literal $$ tokens';
    const initialDoc = [
      '# Workspace Rules',
      '',
      '<!-- HORIZON:HYGIENE:START -->',
      'Old rule text',
      '<!-- HORIZON:HYGIENE:END -->',
      ''
    ].join('\n');

    const updated = upsertFencedCoachBlock(initialDoc, {
      blockType: 'HYGIENE',
      bodyText: dollarPayload
    });
    assert.ok(
      updated.updatedContent.includes(dollarPayload),
      `TurnZeroGate corrupted $-metacharacters: ${updated.updatedContent}`
    );

    const existingRuleFile = 'Rule A: Placeholder rule\nRule B: Keep intact\n';
    const modifiedA = applyRuleDeltaToContent(existingRuleFile, {
      operation: 'MODIFY',
      targetText: 'Rule A: Placeholder rule',
      replacementText: `Rule A: ${dollarPayload}`
    });
    assert.ok(modifiedA.includes(`Rule A: ${dollarPayload}`), 'PrefixCacheShield targetText MODIFY must preserve $ metacharacters');

    const modifiedB = applyRuleDeltaToContent(existingRuleFile, {
      operation: 'MODIFY',
      target: 'Rule A: Placeholder rule',
      content: `Rule A: ${dollarPayload}`
    });
    assert.ok(modifiedB.includes(`Rule A: ${dollarPayload}`), 'PrefixCacheShield delta.target MODIFY must preserve $ metacharacters');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-shield-dollar-'));
    try {
      const targetMd = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(targetMd, existingRuleFile, 'utf8');
      const shield = new PrefixCacheShield({ queuePath: path.join(tmpDir, 'shield.json') });
      shield.stageOrApplyDelta(
        { targetPath: targetMd, operation: 'MODIFY', target: 'Rule A: Placeholder rule', content: `Rule A: ${dollarPayload}` },
        { cacheTtlSeconds: 0, cachedTokens: 0 }
      );
      const onDisk = fs.readFileSync(targetMd, 'utf8');
      assert.ok(onDisk.includes(`Rule A: ${dollarPayload}`));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('escapes </script> and <!-- via \\u003c in serializeScriptJson and buildDemoPage', () => {
    const hostile = { payload: '</script><script>alert(1)</script><!-- comment -->' };
    const serialized = serializeScriptJson(hostile);
    assert.ok(!serialized.includes('</script>'), 'Must never emit raw </script>');
    assert.ok(!serialized.includes('<!--'), 'Must never emit raw <!--');
    assert.ok(serialized.includes('\\u003c/script>'));
    assert.deepEqual(JSON.parse(serialized), hostile);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-demo-escape-'));
    try {
      const outPath = path.join(tmpDir, 'index.html');
      const res = buildDemoPage({
        outPath,
        silent: true,
        demoScenarios: [{ id: 5, title: 'XSS </script> Test', complaint: '<!-- leak -->' }],
        precomputedStates: { 5: { sessionId: 's5', malicious: '</script><script>evil()</script>' } }
      });
      assert.ok(res.html.includes('\\u003c/script>'));
      assert.ok(!res.html.includes('<script>evil()</script>'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 4 Remediation — ISS-048 & ISS-049: Simple View 5-Box Visibility, Watchdog Alerts, Dynamic Ticks, Contrast & 80-Col HUD', () => {
  it('meets WCAG AA (>= 4.5:1) contrast for --hz-text-dim in both dark and light themes', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
    assert.match(html, /--hz-text-dim:\s*#828a9a/i);
    assert.match(html, /\[data-theme="light"\][\s\S]*?--hz-text-dim:\s*#57606a/i);

    const darkOnPanel = contrastRatio('#828a9a', '#0d0f13');
    const darkOnRoot = contrastRatio('#828a9a', '#090d16');
    const lightOnBg = contrastRatio('#57606a', '#f6f8fa');
    assert.ok(darkOnPanel >= 4.5, `Dark --hz-text-dim on #0d0f13 must be >= 4.5:1 (got ${darkOnPanel.toFixed(2)})`);
    assert.ok(darkOnRoot >= 4.5, `Dark --hz-text-dim on #090d16 must be >= 4.5:1 (got ${darkOnRoot.toFixed(2)})`);
    assert.ok(lightOnBg >= 4.5, `Light --hz-text-dim on #f6f8fa must be >= 4.5:1 (got ${lightOnBg.toFixed(2)})`);
  });

  it('isolates #coachingBox and #rsiBox to Advanced View while keeping #quotaStrip and critical #hostWatchdogBar in Simple View and enforces >=28px dynamic tick spacing', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const w = dom.window;
    const d = w.document;

    assert.equal(d.body.getAttribute('data-view-mode'), 'simple');

    // 1. Render 1M ceiling + critical RAM/zombie alert in Simple View
    w.renderState({
      schemaVersion: '1.1.0',
      sessionId: 'batch4-1m-alert',
      contextWindow: 1048576,
      model: { id: 'gemini-4-argon', nativeCeilingTokens: 1048576 },
      window: {
        maxTokens: 1048576,
        cellSizeTokens: 26214,
        totalCells: 40,
        totalActiveTokens: 320000,
        usedPercentage: 31,
        turnCount: 18,
        safeLimit: 734000
      },
      quota: {
        sprint5h: { usedPct: 22, remainingPct: 78 },
        weekly7d: { usedPct: 14, remainingPct: 86 },
        cache: { hitRatePct: 88, ttlRemainingSec: 220, isCacheCold: false, cacheReadTokens: 250000 }
      },
      rsiState: {
        primacyPct: 92,
        troughRiskCount: 1,
        candidates: [{ id: 'r1', ruleText: 'Always pass StartLine/EndLine', confidence: 0.91 }]
      },
      hostHealth: {
        rssGb: 2.35,
        status: 'ZOMBIE_LEAK',
        orphanCount: 2,
        orphanRamMb: 610,
        orphans: [{ pid: 9999, name: 'language_server', rssMb: 610 }]
      }
    });

    const coachingBox = d.getElementById('coachingBox');
    const rsiBox = d.getElementById('rsiBox');
    const quotaStrip = d.getElementById('quotaStrip');
    const hostBar = d.getElementById('hostWatchdogBar');

    assert.equal(w.getComputedStyle(coachingBox).display, 'none', '#coachingBox is demoted to Advanced View (hidden in simple mode)');
    assert.equal(w.getComputedStyle(rsiBox).display, 'none', '#rsiBox is demoted to Advanced View (hidden in simple mode)');
    assert.notEqual(w.getComputedStyle(quotaStrip).display, 'none', '#quotaStrip must be visible in simple mode');

    assert.equal(hostBar.hidden, false);
    assert.equal(hostBar.dataset.severity, 'critical');
    assert.notEqual(w.getComputedStyle(hostBar).display, 'none', 'Critical #hostWatchdogBar must be visible in simple mode');

    // Switching to Advanced View exposes the 5 accordions + #coachingBox / #rsiBox
    d.querySelector('[data-view-tab="advanced"]').click();
    assert.notEqual(w.getComputedStyle(coachingBox).display, 'none', '#coachingBox must be accessible in advanced mode');
    assert.notEqual(w.getComputedStyle(rsiBox).display, 'none', '#rsiBox must be accessible in advanced mode');
    d.querySelector('[data-view-tab="simple"]').click();

    // Verify 1M dynamic ticks
    assert.equal(d.getElementById('usedMaxTok').textContent, '1M');
    assert.equal(d.getElementById('tufteScaleMaxLabel').textContent, '1M');
    assert.equal(d.getElementById('tufteScaleTick50').textContent, '256k');
    assert.equal(d.getElementById('tufteScaleTickTrough').textContent, '512k');
    assert.equal(d.getElementById('tufteScaleTick0').style.transform, 'none');
    assert.equal(d.getElementById('tufteScaleMaxLabel').style.transform, 'none');

    // 2. Render nominal hostHealth + colliding safeLimit (56k on 256k -> 57px vs 51px < 28px)
    w.renderState({
      schemaVersion: '1.1.0',
      sessionId: 'batch4-256k-collision',
      window: {
        maxTokens: 256000,
        cellSizeTokens: 6400,
        totalCells: 40,
        totalActiveTokens: 40000,
        usedPercentage: 16,
        turnCount: 6,
        safeLimit: 56000
      },
      hostHealth: { rssGb: 0.7, status: 'HEALTHY', orphanCount: 0, orphans: [] }
    });

    assert.equal(hostBar.hidden, true, 'Nominal #hostWatchdogBar must hide again');
    assert.equal(hostBar.hasAttribute('data-severity'), false);
    assert.equal(d.getElementById('tufteScaleMaxLabel').textContent, '256k');

    const visibleTicks = Array.from(d.querySelectorAll('#tufteHorizonScale .tufte-scale-tick'))
      .filter(el => el.style.display !== 'none');
    const sortedPx = visibleTicks.map(el => Number(el.dataset.px)).sort((a, b) => a - b);
    assert.ok(visibleTicks.length >= 3, 'Endpoints + limit tick must remain visible');
    for (let i = 1; i < sortedPx.length; i++) {
      assert.ok(
        sortedPx[i] - sortedPx[i - 1] >= 28,
        `Adjacent visible scale ticks must be >= 28px apart (got ${sortedPx[i - 1]}px and ${sortedPx[i]}px)`
      );
    }
  });

  it('clamps every CLI HUD line to <= 80 visible columns when columns <= 80 while preserving ANSI reset', async () => {
    for (let id = 1; id <= 8; id++) {
      const { text } = formatDemoScenarioAnsi(id, { columns: 80 });
      for (const line of text.split('\n')) {
        const w = visibleWidth(line);
        assert.ok(w <= 80, `Scenario ${id} line exceeded 80 visible cols (${w}): ${stripAnsi(line)}`);
      }
    }
    const cliDemo = await runCLI({ demoScenario: 5, columns: 80, silent: true });
    for (const line of cliDemo.output.split('\n')) {
      assert.ok(visibleWidth(line) <= 80, `runCLI demo line exceeded 80 cols: ${stripAnsi(line)}`);
    }

    const longColored = `\x1b[38;5;196m${'X'.repeat(120)}\x1b[0m`;
    const clamped = clampAnsiLine(longColored, 80);
    assert.equal(visibleWidth(clamped), 80);
    assert.ok(clamped.endsWith('\x1b[0m'), 'Clamped ANSI line must end with ANSI reset');
  });
});

describe('Batch 4 Remediation — ISS-056 & ISS-057: Mirror Sync Parity, 6 Hooks, Clean Packaging & Zero Artifact Leaks', () => {
  it('syncs src/adapters, src/webview, src/demo, config, preserves 6 hooks, and detects SHA-256 tampering', () => {
    const liveRes = syncAndVerifyMirrors({ verifyOnly: true });
    assert.equal(liveRes.parityOk, true);

    assert.equal(
      fs.existsSync(path.join(ROOT, 'evaluation_bundles', 'tier_1_essential', 'docs', 'HANDOFF.md')),
      false,
      'Orphan tier_1_essential/docs/HANDOFF.md must not exist'
    );
    assert.equal(
      fs.existsSync(path.join(ROOT, 'evaluation_bundles', 'tier_2_full', 'docs', 'HANDOFF.md')),
      false,
      'Orphan tier_2_full/docs/HANDOFF.md must not exist'
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mirror-sandbox-'));
    try {
      const mockFlightcheck = path.join(tmpRoot, 'agy-horizon-flightcheck');
      const mockLegacy = path.join(tmpRoot, 'agy-horizon');
      fs.mkdirSync(mockFlightcheck, { recursive: true });
      fs.mkdirSync(mockLegacy, { recursive: true });

      // Pre-seed legacy 3-hook hooks.json with enabled: false to prove enabled preservation + 6-hook upgrade
      fs.writeFileSync(
        path.join(mockFlightcheck, 'hooks.json'),
        JSON.stringify({
          'horizon-flightcheck-lifecycle': {
            enabled: false,
            SessionStart: [{ type: 'command', command: 'node ./src/hooks/session_start.mjs', timeout: 5 }]
          }
        }),
        'utf8'
      );

      const syncRes = syncAndVerifyMirrors({ verifyOnly: false, pluginRoots: [mockLegacy, mockFlightcheck] });
      assert.equal(syncRes.parityOk, true);

      assert.equal(fs.existsSync(path.join(mockFlightcheck, 'src', 'adapters', 'antigravity', 'index.mjs')), true);
      assert.equal(fs.existsSync(path.join(mockFlightcheck, 'src', 'adapters', 'claude-code', 'index.mjs')), true);
      assert.equal(fs.existsSync(path.join(mockFlightcheck, 'src', 'webview', 'registry.mjs')), true);
      assert.equal(fs.existsSync(path.join(mockFlightcheck, 'src', 'demo', 'synthetic_states.mjs')), true);
      assert.equal(fs.existsSync(path.join(mockFlightcheck, 'config', 'default_flightcheck.json')), true);

      const fcHooks = JSON.parse(fs.readFileSync(path.join(mockFlightcheck, 'hooks.json'), 'utf8'));
      const lc = fcHooks['horizon-flightcheck-lifecycle'];
      assert.equal(lc.enabled, false, 'Must preserve user enabled state');
      for (const ev of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop', 'PreToolUse', 'PostToolUse']) {
        assert.ok(Array.isArray(lc[ev]) && lc[ev].length > 0, `Missing hook event ${ev}`);
      }
      assert.equal(lc.PreToolUse[0].matcher, LEAN_PRE_TOOL_HOOK_MATCHER);
      assert.equal(lc.PostToolUse[0].matcher, LEAN_POST_TOOL_HOOK_MATCHER);

      const legManifest = JSON.parse(fs.readFileSync(path.join(mockLegacy, 'plugin.json'), 'utf8'));
      assert.equal(legManifest.displayName, 'Highbeam');

      // Simulate 1-byte tamper in synced .mjs module -> verifyOnly must throw
      fs.appendFileSync(path.join(mockFlightcheck, 'src', 'webview', 'registry.mjs'), '\n// tamper\n', 'utf8');
      assert.throws(
        () => syncAndVerifyMirrors({ verifyOnly: true, pluginRoots: [mockLegacy, mockFlightcheck] }),
        /Mirror SHA-256 Parity FAILED/
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('ships clean npm pack tarball (config/ + src/demo/, zero tests/), SHA-pinned CI, and clean .agents/cache & dist', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'demo', 'synthetic_states.mjs')), true);
    assert.equal(fs.existsSync(path.join(ROOT, '.npmignore')), true);
    assert.equal(fs.existsSync(path.join(ROOT, '.vscodeignore')), true);

    // Zero runtime/script files may import from tests/
    for (const dir of ['src', 'sidecars', 'scripts']) {
      for (const f of walkFiles(path.join(ROOT, dir))) {
        if (!/\.(mjs|js)$/.test(f)) continue;
        const txt = fs.readFileSync(f, 'utf8');
        assert.ok(
          !/from\s+['"][^'"]*tests\/fixtures/i.test(txt),
          `${path.relative(ROOT, f)} must not import from tests/fixtures`
        );
      }
    }

    // CI workflow permissions & SHA pins
    const ciYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ciYml, /^permissions:\s*\r?\n\s+contents:\s*read/m);
    assert.ok(ciYml.includes('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'));
    assert.ok(ciYml.includes('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'));

    // npm pack --dry-run --json verification
    const rawPack = execSync('npm pack --dry-run --json', {
      cwd: ROOT,
      encoding: 'utf8'
    });
    const packJson = JSON.parse(rawPack);
    const packedPaths = packJson[0].files.map(f => f.path.replace(/\\/g, '/'));

    assert.ok(packedPaths.includes('config/default_flightcheck.json'), 'Tarball must include config/default_flightcheck.json');
    assert.ok(packedPaths.includes('src/demo/synthetic_states.mjs'), 'Tarball must include src/demo/synthetic_states.mjs');
    assert.ok(!packedPaths.some(p => p.startsWith('test/') || p.startsWith('tests/')), 'Tarball must exclude test/ and tests/');
    assert.ok(!packedPaths.some(p => p.startsWith('docs/') || p.startsWith('scripts/')), 'Tarball must exclude docs/ and scripts/');
    assert.ok(!packedPaths.includes('EXHAUSTIVE_ISSUE_LEDGER.md'), 'Tarball must exclude EXHAUSTIVE_ISSUE_LEDGER.md');

    assert.equal(fs.existsSync(path.join(ROOT, '.agents', 'cache')), false, '.agents/cache must not exist');
    assert.equal(fs.existsSync(path.join(ROOT, 'dist')), false, 'dist/ must not exist');
  });
});
