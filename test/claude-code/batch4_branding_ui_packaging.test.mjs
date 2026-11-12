/**
 * @file test/batch4_branding_ui_packaging.test.mjs
 * Comprehensive Regression & Verification Suite for Batch 4 (`cc-attention-horizon`):
 *   - ISS-014: Symlink-safe `isCliMain` across `bin/*`, clean `"bin"` keys & zero `ga-visualizer-v2` / `cc-attention-horizon` leaks
 *   - ISS-047: Strictly scoped `Pane` (`id: 'attention-horizon'`) chaining, `AbovePrompt` `downstream.line` preservation & `'DET-01 ACTIVE'`
 *   - ISS-050: 80-column `AbovePrompt` & `Pane` fit, ANSI-preserving `truncateAnsiVisible`, Tufte scale ticks & `NO_COLOR`
 *   - ISS-058: Clean release packaging (no `docs/`), `.gitignore`/`.npmignore`/`.vscodeignore`, 40-char SHA CI pins & zero leaked cache/dist artifacts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isCliMain as isCliMainCli } from '../../bin/cli.mjs';
import { isCliMain as isCliMainStatusline } from '../../bin/ah-statusline.mjs';
import register from '../../hooks/register.js';
import {
  computeHorizonGrid,
  isNoColorEnabled
} from '../../src/core-isomorphic/ui/horizonGrid.mjs';
import {
  stripAnsi,
  truncateAnsiVisible,
  buildScaleTickRuler,
  renderAbovePromptBand,
  renderSimpleViewPane,
  renderStatusLine
} from '../../src/core-isomorphic/ui/modViews.mjs';
import { createInitialTelemetryState } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function collectTextFiles(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  const out = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    out.push(...collectTextFiles(path.join(targetPath, entry.name)));
  }
  return out;
}

// ============================================================================
// 1. ISS-014: Symlink-Safe `isCliMain`, Clean `"bin"` & Zero Repo Name Leaks
// ============================================================================

test('ISS-014a: bin/cli.mjs and bin/ah-statusline.mjs resolve symlinks via realpathSync (with real symlink spawn or Windows EPERM fallback)', () => {
  const realCliPath = path.join(PROJECT_ROOT, 'bin', 'cli.mjs');
  const realStatuslinePath = path.join(PROJECT_ROOT, 'bin', 'ah-statusline.mjs');
  const realCliUrl = pathToFileURL(realCliPath).href;
  const realStatuslineUrl = pathToFileURL(realStatuslinePath).href;

  // Unit proof of symlink resolution via fsImpl.realpathSync across POSIX-style .bin symlinks
  const fakeSymlinkCli = path.join(os.tmpdir(), 'node_modules', '.bin', 'ah-claude');
  const fakeSymlinkBrand = path.join(os.tmpdir(), 'node_modules', '.bin', 'attention-horizon-claude');
  const fakeSymlinkStatus = path.join(os.tmpdir(), 'node_modules', '.bin', 'ah-statusline');

  const mockSymlinkFs = {
    realpathSync(p) {
      const s = String(p);
      if (s === fakeSymlinkCli || s === fakeSymlinkBrand || path.resolve(s) === path.resolve(realCliPath)) {
        return realCliPath;
      }
      if (s === fakeSymlinkStatus || path.resolve(s) === path.resolve(realStatuslinePath)) {
        return realStatuslinePath;
      }
      throw new Error(`ENOENT: ${s}`);
    }
  };

  assert.equal(isCliMainCli(fakeSymlinkCli, realCliUrl, mockSymlinkFs), true);
  assert.equal(isCliMainCli(fakeSymlinkBrand, realCliUrl, mockSymlinkFs), true);
  assert.equal(isCliMainCli(fakeSymlinkStatus, realCliUrl, mockSymlinkFs), false);
  assert.equal(isCliMainStatusline(fakeSymlinkStatus, realStatuslineUrl, mockSymlinkFs), true);
  assert.equal(isCliMainStatusline(fakeSymlinkCli, realStatuslineUrl, mockSymlinkFs), false);

  // Fallback proof when realpathSync throws (e.g., virtual VFS)
  const throwingFs = {
    realpathSync() {
      throw new Error('EPERM');
    }
  };
  assert.equal(isCliMainCli(realCliPath, realCliUrl, throwingFs), true);
  assert.equal(isCliMainStatusline(realStatuslinePath, realStatuslineUrl, throwingFs), true);

  // Real OS symlink execution test when OS privileges allow fs.symlinkSync
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-iss014-symlink-'));
  try {
    const symCli = path.join(tmpDir, 'ah-claude');
    const symStatus = path.join(tmpDir, 'ah-statusline');
    let symlinksCreated = false;
    try {
      fs.symlinkSync(realCliPath, symCli, 'file');
      fs.symlinkSync(realStatuslinePath, symStatus, 'file');
      symlinksCreated = true;
    } catch (err) {
      // Unprivileged Windows without Developer Mode raises EPERM on file symlinks
      assert.match(String(err?.code || ''), /^(EPERM|ENOSYS|EINVAL)$/);
    }

    if (symlinksCreated) {
      assert.equal(isCliMainCli(symCli, realCliUrl), true);
      assert.equal(isCliMainStatusline(symStatus, realStatuslineUrl), true);

      const cliRun = spawnSync(process.execPath, [symCli, 'doctor'], {
        cwd: tmpDir,
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(cliRun.status, 0);
      assert.match(cliRun.stdout, /\[Attention Horizon Doctor\] Status: HEALTHY/);

      const statusRun = spawnSync(process.execPath, [symStatus, '--demo'], {
        cwd: tmpDir,
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(statusRun.status, 0);
      assert.match(stripAnsi(statusRun.stdout), /^AH \[/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ISS-014b: package.json omits "cc-attention-horizon" bin and zero ga-visualizer-v2 / cc-attention-horizon strings exist in src/, bin/, hooks/, README.md, or docs/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  for (const requiredBin of ['ah-claude', 'ah-statusline', 'attention-horizon-claude']) {
    assert.equal(requiredBin in pkg.bin, true, `Missing bin ${requiredBin}`);
  }
  assert.equal('cc-attention-horizon' in pkg.bin, false);

  const scanTargets = [
    path.join(PROJECT_ROOT, 'src'),
    path.join(PROJECT_ROOT, 'bin'),
    path.join(PROJECT_ROOT, 'hooks'),
    path.join(PROJECT_ROOT, 'README.md'),
    path.join(PROJECT_ROOT, 'docs')
  ];

  const scannedFiles = scanTargets.flatMap((t) => collectTextFiles(t));
  assert.ok(scannedFiles.length >= 20, `Expected >= 20 scanned files, got ${scannedFiles.length}`);

  for (const filePath of scannedFiles) {
    const rel = path.relative(PROJECT_ROOT, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      content,
      /ga-visualizer-v2|cc-attention-horizon/,
      `Leaked internal repo identifier in ${rel}`
    );
  }
});

// ============================================================================
// 2. ISS-047: Scoped `Pane` Chaining, `AbovePrompt` Line Preservation & Breaker ID
// ============================================================================

test('ISS-047: ui.render delegates unscoped/foreign Pane events, concatenates AbovePrompt downstream.line, and renders DET-01 ACTIVE (never undefined ACTIVE)', async () => {
  const handlers = {};
  register((eventName, fn) => {
    handlers[eventName] = fn;
  });

  const nowMs = 1_760_000_000_000;
  const telemetry = createInitialTelemetryState('sess-iss047', 'claude-sonnet-5-5');
  telemetry.contextWindow.totalInputTokens = 50_000;
  telemetry.contextWindow.cachedTokens = 45_000;
  telemetry.promptCache.warm = true;
  telemetry.promptCache.expiresAt = nowMs + 240_000;

  const store = new Map([
    ['ah_session_telemetry', telemetry],
    ['ah_flight_mode', 'COACH'],
    ['ah_last_breaker_verdict', { triggered: true, detectorId: 'DET-01' }]
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

  // 1. Unscoped `{ component: 'Pane' }` (no id) delegates cleanly to next(event)
  let unscopedNextCalled = 0;
  const unscopedOut = await handlers['ui.render'](
    { component: 'Pane' },
    ctx,
    async (evt) => {
      unscopedNextCalled += 1;
      return { paneId: 'default-host-pane', echoedComponent: evt.component };
    }
  );
  assert.equal(unscopedNextCalled, 1);
  assert.deepEqual(unscopedOut, { paneId: 'default-host-pane', echoedComponent: 'Pane' });

  // Unscoped Pane without `next` returns undefined cleanly
  const unscopedNoNext = await handlers['ui.render']({ component: 'Pane' }, ctx);
  assert.equal(unscopedNoNext, undefined);

  // 2. Co-installed Mod `{ component: 'Pane', id: 'other-mod' }` delegates cleanly to next(event)
  let otherModNextCalled = 0;
  const otherModOut = await handlers['ui.render'](
    { component: 'Pane', id: 'other-mod' },
    ctx,
    async (evt) => {
      otherModNextCalled += 1;
      return { paneId: evt.id, content: 'Other Mod Custom Pane' };
    }
  );
  assert.equal(otherModNextCalled, 1);
  assert.deepEqual(otherModOut, { paneId: 'other-mod', content: 'Other Mod Custom Pane' });

  // 3. `{ component: 'Pane', id: 'attention-horizon' }` renders Simple View Pane with 'DET-01 ACTIVE'
  const ahPane = await handlers['ui.render'](
    { component: 'Pane', id: 'attention-horizon', nowMs },
    ctx,
    async () => ({ paneId: 'unused' })
  );
  assert.equal(ahPane.paneId, 'attention-horizon');
  assert.equal(ahPane.viewMode, 'SIMPLE_5_BOX');
  assert.equal(ahPane.boxes.length, 5);
  assert.match(ahPane.content, /DET-01 ACTIVE/);
  assert.doesNotMatch(ahPane.content, /undefined/i);

  // 4. `AbovePrompt` preserves non-empty `downstream.line` object property via newline concatenation
  const aboveWithObjLine = await handlers['ui.render'](
    { component: 'AbovePrompt', nowMs },
    ctx,
    async () => ({ line: '[CoMod] Ready', extraFlag: 'preserved' })
  );
  assert.equal(aboveWithObjLine.extraFlag, 'preserved');
  const aboveLines = aboveWithObjLine.line.split('\n');
  assert.equal(aboveLines.length, 2);
  assert.match(aboveLines[0], /DET-01 ACTIVE/);
  assert.doesNotMatch(aboveLines[0], /undefined/i);
  assert.equal(aboveLines[1], '[CoMod] Ready');

  // Direct renderer check for `breakerVerdict: { triggered: true, detectorId: 'DET-01' }`
  const directBand = renderAbovePromptBand(telemetry, {
    nowMs,
    includeDiskLedger: false,
    breakerVerdict: { triggered: true, detectorId: 'DET-01' }
  });
  assert.match(directBand.plainLine, /DET-01 ACTIVE/);
  assert.doesNotMatch(directBand.plainLine, /undefined ACTIVE/);

  const directPane = renderSimpleViewPane(telemetry, {
    nowMs,
    includeDiskLedger: false,
    breakerVerdict: { triggered: true, detectorId: 'DET-01' }
  });
  assert.match(directPane.text, /DET-01 ACTIVE/);
  assert.doesNotMatch(directPane.text, /undefined/);
});

// ============================================================================
// 3. ISS-050: 80-Col Fit, ANSI-Preserving Truncation, Scale Ticks & `NO_COLOR`
// ============================================================================

test('ISS-050a: Every line of renderAbovePromptBand and renderSimpleViewPane fits <= 80 visible columns at maxCols: 80 and includes scale ticks', () => {
  const nowMs = 1_760_000_000_000;
  const heavyState = createInitialTelemetryState('sess-iss050', 'claude-opus-5-5');
  heavyState.modelLabel = 'Claude Opus 5.5';
  heavyState.contextWindow.totalInputTokens = 145_000;
  heavyState.contextWindow.cachedTokens = 110_000;
  heavyState.contextWindow.cacheReadTokens = 110_000;
  heavyState.contextWindow.systemAndMcpTokens = 15_000;
  heavyState.contextWindow.distractorTokens = 12_500;
  heavyState.contextWindow.lastWriteTokens = 7_500;
  heavyState.promptCache.warm = true;
  heavyState.promptCache.expiresAt = nowMs + 38 * 1000; // triggers amberAlert (<= 45s)

  const band80 = renderAbovePromptBand(heavyState, {
    nowMs,
    maxCols: 80,
    ansi: true,
    forceColor: true,
    flightMode: 'AUTO_PILOT',
    includeDiskLedger: false,
    breakerVerdict: {
      triggered: true,
      detectorId: 'DET-01',
      reason: 'Blocked destructive git commit --no-verify bypass in repository'
    }
  });
  for (const line of band80.plainLine.split('\n')) {
    assert.ok(
      line.length <= 80,
      `AbovePrompt plain line (${line.length}) exceeded 80 cols: "${line}"`
    );
  }
  for (const line of band80.line.split('\n')) {
    const vis = stripAnsi(line).length;
    assert.ok(vis <= 80, `AbovePrompt ANSI visible width (${vis}) exceeded 80 cols`);
  }

  const pane80 = renderSimpleViewPane(heavyState, {
    nowMs,
    maxCols: 80,
    flightMode: 'AUTO_PILOT',
    includeDiskLedger: false,
    savedUSD: 14.92,
    savedTokens: 482_500,
    breakerVerdict: {
      triggered: true,
      detectorId: 'DET-01',
      reason: 'Blocked destructive git commit --no-verify bypass in repository'
    },
    offenders: [
      {
        name: 'packages/core/src/very/deeply/nested/enterprise/telemetry_snapshot_hydrator_service.mjs',
        tokens: 48_500,
        category: '[D]'
      },
      {
        name: 'System Prompt & 18 Connected MCP Server Schemas',
        tokens: 15_000,
        category: '[S]'
      }
    ]
  });

  // Verify 5-Box hierarchy preserved
  assert.equal(pane80.boxes.length, 5);
  assert.deepEqual(
    pane80.boxes.map((b) => b.boxNumber),
    [1, 2, 3, 4, 5]
  );

  // Verify scale ticks in Box 1 (200k standard tier -> 0k ... 100k ... 200k)
  assert.match(pane80.boxes[0].text, /Scale:\s+0k\s+·+\s+100k\s+·+\s+200k/);

  // Verify 100k Haiku and 1M Extended scale ticks
  const paneHaiku = renderSimpleViewPane(
    { modelId: 'claude-haiku-5-5', contextWindow: { totalInputTokens: 60_000 } },
    { maxCols: 80, includeDiskLedger: false }
  );
  assert.match(paneHaiku.boxes[0].text, /Scale:\s+0k\s+·+\s+50k\s+·+\s+100k/);

  const pane1M = renderSimpleViewPane(
    { modelId: 'claude-opus-5-5', contextWindow: { totalInputTokens: 250_000 } },
    { maxCols: 80, includeDiskLedger: false }
  );
  assert.match(pane1M.boxes[0].text, /Scale:\s+0k\s+·+\s+500k\s+·+\s+1M/);

  assert.match(buildScaleTickRuler(400_000, 42), /^0k\s+·+\s+200k\s+·+\s+400k$/);

  // Verify EVERY SINGLE LINE of renderSimpleViewPane fits <= 80 visible columns
  for (const rawLine of pane80.text.split('\n')) {
    const vis = stripAnsi(rawLine).length;
    assert.ok(
      vis <= 80,
      `Pane line (${vis} cols) exceeded maxCols=80: "${stripAnsi(rawLine)}"`
    );
  }
});

test('ISS-050b: renderStatusLine & truncateAnsiVisible preserve ANSI colors at 80 and narrow columns, while NO_COLOR suppresses 100% of ANSI escapes', () => {
  const savedNoColorExists = 'NO_COLOR' in process.env;
  const savedNoColorVal = process.env.NO_COLOR;

  try {
    delete process.env.NO_COLOR;
    assert.equal(isNoColorEnabled({}), false);

    const state = {
      modelId: 'claude-opus-5-5',
      flightMode: 'AUTO_PILOT',
      contextWindow: {
        totalInputTokens: 115_000,
        cachedTokens: 90_000,
        cacheReadTokens: 90_000,
        systemAndMcpTokens: 10_000,
        distractorTokens: 10_000,
        lastWriteTokens: 5_000
      },
      promptCache: { warm: true, ttlSeconds: 245 }
    };

    // 1. At 80 columns with NO_COLOR unset, ANSI escape codes MUST be preserved
    const status80 = renderStatusLine(state, {
      columns: 80,
      ansi: true,
      includeDiskLedger: false,
      savedUSD: 3.42
    });
    assert.ok(status80.visibleLength <= 80);
    assert.match(status80.line, /\x1b\[38;2;/, 'Expected RGB ANSI cell colors at 80 columns');

    // 2. Even when forced to truncate at ultra-narrow 44 columns, ANSI colors are preserved & reset!
    const status44 = renderStatusLine(state, {
      columns: 44,
      ansi: true,
      includeDiskLedger: false,
      savedUSD: 3.42
    });
    assert.ok(status44.visibleLength <= 44);
    assert.match(status44.line, /\x1b\[38;2;/, 'ANSI truncation must never strip cell colors');

    // Direct unit check on truncateAnsiVisible stepping over SGR codes and appending \x1b[0m
    const coloredSample = 'AH [\x1b[38;2;26;115;232mSSSS\x1b[0m] 100k';
    const truncated6 = truncateAnsiVisible(coloredSample, 6);
    assert.equal(stripAnsi(truncated6), 'AH [SS');
    assert.equal(truncated6, 'AH [\x1b[38;2;26;115;232mSS\x1b[0m');

    // 3. Setting NO_COLOR=1 suppresses 100% of \x1b[ across horizonGrid and modViews
    process.env.NO_COLOR = '1';
    assert.equal(isNoColorEnabled({}), true);

    const gridNoColor = computeHorizonGrid(state);
    assert.equal(gridNoColor.ansiBar.includes('\x1b['), false);
    assert.equal(gridNoColor.ansiCodeBar.includes('\x1b['), false);

    const bandNoColor = renderAbovePromptBand(state, {
      ansi: true,
      includeDiskLedger: false
    });
    assert.equal(bandNoColor.line.includes('\x1b['), false);

    const statusNoColor = renderStatusLine(state, {
      columns: 80,
      ansi: true,
      includeDiskLedger: false
    });
    assert.equal(statusNoColor.line.includes('\x1b['), false);

    const paneNoColor = renderSimpleViewPane(state, {
      ansi: true,
      includeDiskLedger: false
    });
    assert.equal(paneNoColor.text.includes('\x1b['), false);

    // 4. forceColor: true explicitly overrides NO_COLOR when requested
    const gridForceColor = computeHorizonGrid(state, { forceColor: true });
    assert.equal(gridForceColor.ansiCodeBar.includes('\x1b['), true);
  } finally {
    if (savedNoColorExists) {
      process.env.NO_COLOR = savedNoColorVal;
    } else {
      delete process.env.NO_COLOR;
    }
  }
});

// ============================================================================
// 4. ISS-058: Clean Release Packaging, Ignore Files, CI SHA Pins & Zero Leaks
// ============================================================================

test('ISS-058: package.json & build_release_bundle omit docs/, ignore files & SHA-pinned CI exist, and .claude/cache & dist/ are clean', () => {
  // 1. package.json "files" and scripts/build_release_bundle.mjs omit "docs/"
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('docs/'), false);
  assert.equal(pkg.files.includes('docs'), false);

  const releaseScript = fs.readFileSync(
    path.join(PROJECT_ROOT, 'scripts', 'build_release_bundle.mjs'),
    'utf8'
  );
  assert.doesNotMatch(releaseScript, /['"]docs\/?['"]/);

  // 2. .gitignore contains required entries
  const gitignore = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  for (const entry of [
    '.claude/settings.local.json',
    '.claude/horizon-state/',
    '*.tmp',
    'docs/HANDOFF_*.md'
  ]) {
    assert.ok(gitignore.includes(entry), `Missing "${entry}" in .gitignore`);
  }

  // 3. .npmignore and .vscodeignore exist and exclude required non-runtime paths
  for (const ignoreFile of ['.npmignore', '.vscodeignore']) {
    const fullPath = path.join(PROJECT_ROOT, ignoreFile);
    assert.equal(fs.existsSync(fullPath), true, `Expected ${ignoreFile} to exist`);
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const pattern of [
      'test/',
      'tests/',
      'docs/',
      'scripts/',
      'dist/',
      '.github/',
      '.claude/',
      '*.tmp',
      '*.tgz',
      '*.zip'
    ]) {
      assert.ok(text.includes(pattern), `Missing "${pattern}" in ${ignoreFile}`);
    }
  }

  // 4. .github/workflows/ci.yml has permissions: contents: read & 40-char SHA pins
  const ciYml = fs.readFileSync(
    path.join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(ciYml, /permissions:\s*\r?\n\s*contents:\s*read/);
  assert.match(
    ciYml,
    /uses:\s*actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\b/
  );
  assert.match(
    ciYml,
    /uses:\s*actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\b/
  );
  assert.doesNotMatch(ciYml, /uses:\s*actions\/[a-z-]+@v\d+/);

  // 5. Zero leaked files in .claude/cache/ or dist/
  const cacheDir = path.join(PROJECT_ROOT, '.claude', 'cache');
  const distDir = path.join(PROJECT_ROOT, 'dist');
  const leakedCacheFiles = collectTextFiles(cacheDir);
  const leakedDistFiles = collectTextFiles(distDir);
  assert.deepEqual(leakedCacheFiles, [], `Expected zero files in .claude/cache, found: ${leakedCacheFiles}`);
  assert.deepEqual(leakedDistFiles, [], `Expected zero files in dist/, found: ${leakedDistFiles}`);
});
