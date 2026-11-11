import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { classifyHorizon } from '../src/core/classifier.mjs';
import { detectShadowedFileBloat } from '../src/core/telemetry/shadow_file_detector.mjs';
import { CircuitBreakers } from '../src/core/coach/circuit_breakers.mjs';
import { selectHighestPriorityTier2Card } from '../src/ui/horizon_panel.js';
import { PrefixCacheShield } from '../src/core/prefix_cache_shield.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';

test('Audit Remediation 1: classifyHorizon pairs PLANNER_RESPONSE -> GENERIC tool outputs', () => {
  const steps = [
    {
      stepIndex: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: '<USER_REQUEST>Refactor user authentication and test suite</USER_REQUEST>'
    },
    {
      stepIndex: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      content: 'I will read the test file.',
      toolCalls: [
        {
          name: 'read_file',
          args: { Path: 'test/auth.test.mjs' }
        }
      ]
    },
    {
      stepIndex: 2,
      type: 'GENERIC',
      source: 'MODEL',
      // Content containing 'Traceback (most recent call last)' inside a test or source code file
      content: '// Example test checking error handling:\n// Traceback (most recent call last):\n// AssertionError: failed'
    },
    {
      stepIndex: 3,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: 'Now run unit tests'
    }
  ];

  const payload = classifyHorizon(steps, {
    sessionId: 'test-session-pairing',
    modelId: 'gemini-3.8-flash'
  });

  assert.equal(payload.lastUserPrompt, 'Now run unit tests');
  assert.ok(Array.isArray(payload.steps));
  assert.equal(payload.steps.length, 4);

  // Step 2 is a paired read_file result: must NOT be falsely classified as DEAD_ERROR
  const step2Classified = payload.steps[2];
  assert.notEqual(step2Classified.category, 'DEAD_ERROR', 'Paired read_file step must not be classified as DEAD_ERROR');
});

test('Audit Remediation 2: detectShadowedFileBloat (DET-17) attributes tokens from paired GENERIC step', () => {
  const steps = [
    {
      stepIndex: 0,
      type: 'PLANNER_RESPONSE',
      toolCalls: [{ name: 'read_file', args: { Path: 'src/config.mjs' } }]
    },
    {
      stepIndex: 1,
      type: 'GENERIC',
      tokens: 4500,
      content: 'x'.repeat(18000)
    },
    {
      stepIndex: 2,
      type: 'PLANNER_RESPONSE',
      toolCalls: [{ name: 'edit_file', args: { Path: 'src/config.mjs' } }]
    },
    {
      stepIndex: 3,
      type: 'PLANNER_RESPONSE',
      toolCalls: [{ name: 'read_file', args: { Path: 'src/config.mjs' } }]
    },
    {
      stepIndex: 4,
      type: 'GENERIC',
      tokens: 4500,
      content: 'x'.repeat(18000)
    }
  ];

  const bloatResult = detectShadowedFileBloat(steps);
  assert.equal(bloatResult.detectorId, 'DET-17');
  assert.equal(bloatResult.triggered, true);
  assert.ok(bloatResult.totalRedundantTokens >= 4500, `Expected >= 4500 redundant tokens, got ${bloatResult.totalRedundantTokens}`);
});

test('Audit Remediation 3: CircuitBreakers reports DET-03 for test assertion weakening', () => {
  const breakers = new CircuitBreakers();
  const sampleDiff = [
    '--- a/test/auth.test.mjs',
    '+++ b/test/auth.test.mjs',
    '@@ -10,3 +10,1 @@',
    '-  assert.equal(user.role, "admin");',
    '-  expect(user.active).toBe(true);',
    '+  // bypassed'
  ].join('\n');

  const check = breakers.recordTurn({
    turnIndex: 5,
    filePath: 'test/auth.test.mjs',
    gitDiff: sampleDiff
  });

  assert.equal(check.hasTripped, true);
  const det03 = check.triggered.find(a => a.detectorId === 'DET-03');
  assert.ok(det03, 'CircuitBreakers must trip with detectorId DET-03');
  assert.equal(det03.netDeletedCount, 2);

  const card = selectHighestPriorityTier2Card({
    circuitBreakerAlerts: check.triggered
  });
  assert.equal(card.cardType, 'DET-03_ASSERT_REVERT');
});

test('Audit Remediation 4: PrefixCacheShield detects warm locked cache', () => {
  const shield = new PrefixCacheShield();
  const warmSession = {
    cachedTokens: 60000,
    cacheTtlSeconds: 240,
    turnCount: 5
  };
  const status = shield.getStatus(warmSession);
  assert.equal(status.locked, true);

  const coldSession = {
    cachedTokens: 60000,
    cacheTtlSeconds: 0,
    turnCount: 5
  };
  assert.equal(shield.getStatus(coldSession).locked, false);
});

test('Audit Remediation 5: hooks.json lifecycle hooks run cleanly on Windows/POSIX without ~ path crashes', () => {
  const hooksFile = path.resolve('hooks.json');
  assert.ok(fs.existsSync(hooksFile));
  const raw = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const config = raw['horizon-flightcheck-lifecycle'];
  assert.ok(config && config.enabled);

  for (const eventName of ['SessionStart', 'PreInvocation', 'PostInvocation']) {
    const handler = config[eventName]?.[0];
    assert.ok(handler, `Missing handler for ${eventName}`);
    assert.ok(!handler.command.includes('~'), `Handler for ${eventName} must not use unexpanded ~`);

    // Execute the hook with {} stdin to confirm 0 exit code
    const res = spawnSync(handler.command, {
      shell: true,
      input: '{}',
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(res.status, 0, `Hook for ${eventName} failed: ${res.stderr || res.stdout}`);
  }
});

test('Audit Remediation 6: UI Invariants - Plain-text /compact and active source file protection', () => {
  const html = fs.readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8');

  // Invariant 1: No clickable copy button for /compact
  assert.ok(!html.includes('id="btnCompactPrimary"'));
  assert.ok(!html.includes('copyCompactWithGuidance'));
  assert.ok(html.includes('Type /compact in the chat box and press Enter'));

  // Invariant 2: Active source file protection
  assert.equal(isIgnorablePath('src/webview/horizon_panel.html'), false);
  assert.equal(isIgnorablePath('src/core/classifier.mjs'), false);
  assert.equal(isIgnorablePath('package-lock.json'), true);
  assert.equal(isIgnorablePath('.tmp_sim/test.log'), true);
});

test('Stage 7 (Tasks 7.1–7.5): Multi-harness Claude Code + Cursor + Antigravity auto-discovery, Node >=22.5 check, and daemon.port lockfile', async () => {
  const os = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const {
    isSupportedNodeVersion,
    formatNodeUpgradeHint,
    getDaemonPortFile,
    readDaemonPort
  } = await import('../src/core/paths.mjs');
  const {
    findSessionDirectory,
    parseTranscriptIncremental,
    reconcileWorkspaceAndKIs
  } = await import('../src/core/parser.mjs');
  const { runLiveOrDemoCli } = await import('../src/cli/init.mjs');

  // Task 7.3: Node >= 22.5.0 version guard & friendly upgrade hint
  assert.equal(isSupportedNodeVersion('v20.11.0'), false);
  assert.equal(isSupportedNodeVersion('v22.4.9'), false);
  assert.equal(isSupportedNodeVersion('v22.5.0'), true);
  assert.equal(isSupportedNodeVersion('v25.6.0'), true);
  const hint = formatNodeUpgradeHint('v20.11.0');
  assert.ok(hint.includes('Node.js >= 22.5.0'), 'Upgrade hint must state Node.js >= 22.5.0 requirement');
  assert.ok(hint.includes('nvm install 22'), 'Upgrade hint must include actionable upgrade command');

  // Task 7.4: sidecar.json and daemon.port lockfile unification on 62935
  const sidecarJson = JSON.parse(fs.readFileSync(path.resolve('sidecars/horizon-daemon/sidecar.json'), 'utf8'));
  assert.equal(sidecarJson.port, 62935);
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-stage7-'));
  try {
    assert.equal(readDaemonPort(tmpHome, 62935), 62935);
    const portFile = getDaemonPortFile(tmpHome);
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, '62937', 'utf8');
    assert.equal(readDaemonPort(tmpHome, 62935), 62937);

    // Task 7.1 & 7.5 (A): Claude Code ~/.claude/projects/<slug>/<sid>.jsonl discovery & DAG + cache telemetry parsing
    const claudeProjDir = path.join(tmpHome, '.claude', 'projects', 'c--Projects-my-app');
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const claudeSessionFile = path.join(claudeProjDir, 'claude-sess-001.jsonl');
    const nowIso = new Date().toISOString();
    const claudeLines = [
      JSON.stringify({
        uuid: 'u-1',
        parentUuid: null,
        type: 'user',
        cwd: 'c:/Projects/my-app',
        timestamp: nowIso,
        message: { role: 'user', content: 'Audit authentication flow and fix duplicate reads' }
      }),
      JSON.stringify({
        uuid: 'u-2',
        parentUuid: 'u-1',
        type: 'assistant',
        cwd: 'c:/Projects/my-app',
        timestamp: nowIso,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [
            { type: 'thinking', thinking: 'Checking auth module first.' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } }
          ],
          usage: {
            input_tokens: 4200,
            output_tokens: 900,
            cache_creation_input_tokens: 14000,
            cache_read_input_tokens: 58000
          }
        }
      }),
      // Abandoned /rewind branch off u-1
      JSON.stringify({
        uuid: 'u-rewind-branch',
        parentUuid: 'u-1',
        type: 'assistant',
        timestamp: nowIso,
        message: { role: 'assistant', content: 'Abandoned branch step', usage: { output_tokens: 500 } }
      }),
      // Active continuation off u-2 with duplicate Read of src/auth.ts
      JSON.stringify({
        uuid: 'u-3',
        parentUuid: 'u-2',
        leafUuid: 'u-3',
        type: 'assistant',
        cwd: 'c:/Projects/my-app',
        timestamp: nowIso,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } },
            { type: 'text', text: 'Re-read src/auth.ts and verified tokens.' }
          ],
          usage: {
            input_tokens: 3800,
            output_tokens: 1200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 64000
          }
        }
      })
    ];
    fs.writeFileSync(claudeSessionFile, claudeLines.join('\n') + '\n', 'utf8');

    assert.equal(findSessionDirectory(null, tmpHome), null, 'Default Antigravity discovery must ignore cross-host ~/.claude/projects unless --harness=claude is specified');
    const discoveredClaude = findSessionDirectory(null, tmpHome, { harness: 'claude' });
    assert.ok(discoveredClaude, 'findSessionDirectory must discover Claude Code session when harness=claude is passed');
    assert.equal(discoveredClaude.storeName, 'claude-code');
    assert.equal(discoveredClaude.surfaceTag, '[Claude]');
    assert.equal(discoveredClaude.sessionId, 'claude-sess-001');

    const parsedClaude = parseTranscriptIncremental(discoveredClaude.sessionDir, path.join(tmpHome, 'cache'));
    assert.equal(parsedClaude.steps.length, 3, 'Active DAG branch must have 3 steps (excluding rewound branch)');
    assert.equal(parsedClaude.rewindDetected, true, 'Must detect /rewind branch');
    assert.ok(parsedClaude.genMetadata, 'Must extract genMetadata from Claude Code usage');
    assert.equal(parsedClaude.genMetadata.cacheReadTokens, 64000);

    const claudeState = classifyHorizon(parsedClaude.steps, {
      sessionId: discoveredClaude.sessionId,
      storeSource: discoveredClaude.storeName,
      logFilePath: parsedClaude.filePath,
      genMetadata: parsedClaude.genMetadata,
      modelId: parsedClaude.genMetadata.model
    });
    assert.equal(claudeState.surfaceTag, '[Claude]');
    assert.ok(claudeState.quota.cache.hitRatePct >= 75, `Expected high cache hit rate, got ${claudeState.quota.cache.hitRatePct}%`);
    assert.equal(claudeState.sessionRisk.isCacheTrulyWarm, true);

    // Task 7.1 & 7.5 (B): Cursor workspaceStorage/<hash>/state.vscdb discovery & read-only SQLite parsing
    const cursorWsDir = path.join(tmpHome, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage', 'ws-hash-99');
    fs.mkdirSync(cursorWsDir, { recursive: true });
    fs.writeFileSync(path.join(cursorWsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///c:/Projects/cursor-app' }), 'utf8');
    const vscdbPath = path.join(cursorWsDir, 'state.vscdb');
    const db = new DatabaseSync(vscdbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
    const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    ins.run('composerData:comp-777', JSON.stringify({ name: 'Cursor Payment Refactor', model: 'claude-sonnet-4-5' }));
    ins.run('bubbleId:comp-777:b1', JSON.stringify({
      type: 1,
      text: 'Inspect payment handler and optimize retries',
      createdAt: nowIso
    }));
    ins.run('bubbleId:comp-777:b2', JSON.stringify({
      type: 2,
      text: 'Reading payment handler now.',
      toolFormerData: [{ name: 'read_file', params: { target_file: 'src/payment.ts' } }],
      inputTokens: 9500,
      outputTokens: 1100,
      cacheReadTokens: 56000,
      createdAt: nowIso
    }));
    db.close();

    // Bump mtime on state.vscdb so Cursor is newest when testing auto-discovery
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(vscdbPath, futureTime, futureTime);

    assert.equal(findSessionDirectory(null, tmpHome), null, 'Default Antigravity discovery must ignore cross-host Cursor state.vscdb unless --harness=cursor is specified');
    const discoveredCursor = findSessionDirectory(null, tmpHome, { harness: 'cursor' });
    assert.ok(discoveredCursor, 'findSessionDirectory must discover newest Cursor state.vscdb session when harness=cursor is passed');
    assert.equal(discoveredCursor.storeName, 'cursor');
    assert.equal(discoveredCursor.surfaceTag, '[Cursor]');
    assert.equal(discoveredCursor.sessionId, 'comp-777');

    const parsedCursor = parseTranscriptIncremental(discoveredCursor.sessionDir, path.join(tmpHome, 'cache'));
    assert.equal(parsedCursor.steps.length, 2);
    assert.equal(parsedCursor.sessionTitle, 'Cursor Payment Refactor');
    assert.equal(parsedCursor.genMetadata.cacheReadTokens, 56000);

    const cursorState = classifyHorizon(parsedCursor.steps, {
      sessionId: discoveredCursor.sessionId,
      storeSource: discoveredCursor.storeName,
      logFilePath: parsedCursor.filePath,
      genMetadata: parsedCursor.genMetadata,
      modelId: parsedCursor.genMetadata.model
    });
    assert.equal(cursorState.surfaceTag, '[Cursor]');

    // Verify reconcileWorkspaceAndKIs lists both [Claude] and [Cursor] sessions when includeCrossHost is explicitly opted in
    const recon = await reconcileWorkspaceAndKIs('comp-777', tmpHome, { includeCrossHost: true });
    assert.equal(recon.sessionSurfaceTag, '[Cursor]');
    assert.ok(recon.recentSessions.some(s => s.surfaceTag === '[Claude]'), 'recentSessions must include [Claude] session when opted in');
    assert.ok(recon.recentSessions.some(s => s.surfaceTag === '[Cursor]'), 'recentSessions must include [Cursor] session when opted in');

    // Verify runLiveOrDemoCli picks up the live cross-host session when --harness=cursor is opted in
    const liveCliRes = await runLiveOrDemoCli({ homeDir: tmpHome, harness: 'cursor' });
    assert.equal(liveCliRes.mode, 'live');
    assert.equal(liveCliRes.state.surfaceTag, '[Cursor]');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Audit Remediation 10: server.mjs state injection is immune to dollar-backtick ($`) HTML duplication and scale ticks have non-overlapping default CSS offsets', () => {
  const htmlPath = path.resolve('src/webview/horizon_panel.html');
  const serverPath = path.resolve('sidecars/horizon-daemon/server.mjs');
  const rawHtml = fs.readFileSync(htmlPath, 'utf8');
  const serverSrc = fs.readFileSync(serverPath, 'utf8');

  // 1. Verify server.mjs uses a functional replacement () => ... when injecting stateScript
  assert.ok(
    serverSrc.includes("() => `${mtimeScript}\\n${stateScript}\\n<script id=\"precomputedCatalogScript\">`"),
    'server.mjs must use a functional replacer () => ... to prevent $` and $\' regex replacement injection'
  );

  // 2. Simulate the exact payload from MASTER_BUILD_PROMPT_V2.md containing `$` `, `$'`, `$&`, `$$`, and `</script>`
  const adversarialState = {
    uiMtimeMs: 1794319763939,
    lastUserPrompt: "ONLY to helper functions declared at the top level of `hooks/register.js` itself (never pass `$` to functions imported from other module files, except `$.state` read/update callbacks). Also test $' and $& and $$ and </script>.",
    total: 0
  };
  const mtimeScript = `<script id="liveInitialMtime">window.__INITIAL_UI_MTIME__ = 1794319763939;</script>`;
  const safeJson = JSON.stringify(adversarialState)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const stateScript = `<script id="liveInitialState">window.__LIVE_INITIAL_STATE__ = ${safeJson};</script>`;
  const injectedHtml = rawHtml.replace(
    '<script id="precomputedCatalogScript">',
    () => `${mtimeScript}\n${stateScript}\n<script id="precomputedCatalogScript">`
  );

  // Must have exactly 1 instance of id="tufteBaselineStrip" and id="footerMeta" (never duplicated by $`)
  const baselineMatches = injectedHtml.match(/id="tufteBaselineStrip"/g) || [];
  const footerMatches = injectedHtml.match(/id="footerMeta"/g) || [];
  assert.equal(baselineMatches.length, 1, 'tufteBaselineStrip must appear exactly once in injected HTML');
  assert.equal(footerMatches.length, 1, 'footerMeta must appear exactly once in injected HTML');

  // Verify the injected JSON parses back cleanly
  const scriptMatch = injectedHtml.match(/<script id="liveInitialState">window\.__LIVE_INITIAL_STATE__ = ([\s\S]*?);<\/script>/);
  assert.ok(scriptMatch, 'liveInitialState script tag must remain intact');
  const parsedBack = JSON.parse(scriptMatch[1]);
  assert.equal(parsedBack.lastUserPrompt, adversarialState.lastUserPrompt);

  // 3. Verify all 5 .tufte-scale-tick elements have explicit non-overlapping initial style offsets
  assert.match(rawHtml, /id="tufteScaleTick0"\s+style="left:0%;"/);
  assert.match(rawHtml, /id="tufteScaleTick50"\s+style="left:19\.5%;transform:translateX\(-50%\);"/);
  assert.match(rawHtml, /id="tufteScaleTickTrough"\s+style="left:36%;transform:translateX\(-50%\);"/);
  assert.match(rawHtml, /id="tufteScaleLimitLabel"\s+style="left:57\.4%;transform:translateX\(-50%\);"/);
  assert.match(rawHtml, /id="tufteScaleMaxLabel"\s+style="right:0%;"/);
});
