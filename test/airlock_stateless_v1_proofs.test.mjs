/**
 * Highbeam Airlock (ctxtop Pro Stateless v1) Comprehensive Proof Suites (Suites 1-5, Gates G1-G6).
 * Covers pure-JS detector precision, write-only HMAC twins (FM-1 + 2-strike cap),
 * Claude Code PreToolUse/PostToolUse/UserPromptSubmit/SessionStart (FM-8 watchdog, FM-11 shaper),
 * SQLite + JSONL zero-plaintext chained ledger, signed policy verification, Track B Antigravity,
 * Pro licensing gate, CLI subcommands, UI Zone A/D parity, and benchmark gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deriveWriteOnlyPlaceholder,
  verifyPlaceholderCrc8,
  findWriteOnlyPlaceholders,
  containsWriteOnlyPlaceholder,
  scanTextWithAirlock,
  scrubTextWithAirlock,
  isTestedClaudeCodeVersion,
  cloneAndScrubToolResponse,
  isClassASecretPath,
  isSensitiveBinaryReadPath,
  isAirlockSelfTamperTarget,
  isObfuscatedSecretShellCommand,
  evaluateAirlockPreToolGuard
} from '../src/core-isomorphic/airlock/index.mjs';
import {
  signAirlockPolicy,
  verifyAirlockPolicySignature,
  loadAirlockPolicy,
  getOrCreateSessionHmacKey,
  getOrCreateOrgSalts,
  readStrikeState
} from '../src/core/airlock/policyLoader.mjs';
import {
  AirlockAuditLedger,
  assertZeroPlaintextRecord
} from '../src/core/airlock/auditLedger.mjs';
import { generateAirlockEnforcementReceipt } from '../src/core/airlock/enforcementReceipt.mjs';
import { runPreToolUseHook, executePreToolUseCli } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { runUserPromptSubmitHook, executeUserPromptSubmitCli } from '../hooks/handlers/user-prompt-submit.mjs';
import { runCompactLifecycleHook } from '../hooks/handlers/compact-lifecycle.mjs';
import { runStrictPreInvocation, runStrictPreToolUse } from '../src/hooks/portfolio_runtime.mjs';
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import { requireProFeature, getProEntitlementStatus } from '../src/core/pro_license.mjs';
import { renderHorizonPanelHtml } from '../src/core-isomorphic/ui/horizonPanelHtml.mjs';
import { runCli } from '../bin/ctxtop.mjs';
import { runAirlockBenchmark } from '../scripts/benchmark_airlock.mjs';

function makeTempDir(prefix = 'ah-airlock-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDirSafe(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  } catch (err) {
    void err;
  }
}

function buildJwt(payloadObj) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${h}.${p}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;
}

const FAKE_AWS = ['AKIA', '89ABCDEF01234567'].join('');
const FAKE_STRIPE = (suffix = '51AbCdEfGhIjKlMnOpQrStUvWx') => ['sk', 'live', suffix].join('_');
const FAKE_GHP = ['ghp', '0123456789abcdef0123456789abcdef0123'].join('_');
const FAKE_SLACK = ['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnop'].join('-');

// ===========================================================================
// Suite 1: Pure-JS Detector Precision, Entropy Audit-Only & Salted Allowlist
// ===========================================================================
test('Suite 1.1: Stage 1 & 2 detect credentials/PII accurately while ignoring safe digests & example domains', () => {
  const jwt = buildJwt({ sub: '123456', role: 'admin' });
  const text = [
    `aws=${FAKE_AWS}`,
    'awsDocExample=AKIAIOSFODNN7EXAMPLE',
    `stripe=${FAKE_STRIPE()}`,
    `gh=${FAKE_GHP}`,
    `slack=${FAKE_SLACK}`,
    'db=postgres://svc_user:P4ssw0rdStrong@db.internal.acme:5432/prod',
    `jwt=${jwt}`,
    'Safe docs: https://alice@example.com/path',
    'Safe sha256 hex: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Safe integrity: sha512-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
  ].join('\n');

  const scan = scanTextWithAirlock(text, {
    policy: {
      internalDomains: ['internal.acme'],
      terms: ['PROJECT_FALCON_SECRET_NAME']
    },
    orgAuditSalt: 'audit-salt-01'
  });

  const cats = new Set(scan.matches.map((m) => m.category));
  assert.ok(cats.has('AWS_KEY'));
  assert.ok(cats.has('STRIPE_KEY'));
  assert.ok(cats.has('GITHUB_TOKEN'));
  assert.ok(cats.has('SLACK_TOKEN'));
  assert.ok(cats.has('DB_URI'));
  assert.ok(cats.has('JWT'));
  assert.equal(scan.matches.some((m) => m.value.includes('AKIAIOSFODNN7EXAMPLE')), false);
  assert.equal(scan.matches.some((m) => m.value.includes('example.com')), false);
  assert.equal(scan.matches.some((m) => m.value.includes('e3b0c44298fc')), false);
});

test('Suite 1.2: Stage 3 high-entropy is AUDIT_ONLY by default & salted org allowlist is path-scoped', () => {
  const tmpState = makeTempDir('ah-s12-');
  try {
    const salts = getOrCreateOrgSalts({ stateDir: tmpState });
    const fakeKey = FAKE_AWS;
    // Compute HMAC for AWS_KEY under orgAllowlistSalt
    const probeScan = scanTextWithAirlock(fakeKey, { orgAuditSalt: salts.orgAllowlistSalt });
    assert.equal(probeScan.matches.length, 1);

    const highEntropySample = 'api_key = "Zx9Kp2Qm7Lv4Wt8Nb3Yc6Df1Rj5Hv8Gz4MxQw2P"';
    const stage3Default = scrubTextWithAirlock(highEntropySample, { sessionKey: 'k1', orgAuditSalt: salts.orgAuditSalt });
    assert.equal(stage3Default.modified, false);
    assert.ok(stage3Default.auditOnlyMatches.length >= 1);

    const stage3Unlocked = scrubTextWithAirlock(highEntropySample, {
      sessionKey: 'k1',
      enableStage3Redaction: true,
      orgAuditSalt: salts.orgAuditSalt
    });
    assert.equal(stage3Unlocked.modified, true);
    assert.ok(containsWriteOnlyPlaceholder(stage3Unlocked.scrubbedText));
  } finally {
    rmDirSafe(tmpState);
  }
});

test('Suite 1.3: Salted HMAC allowlist permits matching test fixture globs while blocking same secret in src/', async () => {
  const { hmacSha256HexPure } = await import('../src/core-isomorphic/airlock/index.mjs');
  const allowSalt = 'org-allow-salt-xyz';
  const testSecret = FAKE_STRIPE('51TestOnlyFixtureKey12345678');
  const allowHmac = hmacSha256HexPure(allowSalt, `STAGE1_STRIPE_KEY:${testSecret}`);

  const policy = {
    allowlistHmacs: [allowHmac],
    allowlistGlobs: ['test/**']
  };

  const inTest = scrubTextWithAirlock(`const k = "${testSecret}";`, {
    policy,
    filePath: 'test/fixtures/stripe.test.mjs',
    orgAllowlistSalt: allowSalt,
    sessionKey: 'sess-1'
  });
  assert.equal(inTest.modified, false);

  const inSrc = scrubTextWithAirlock(`const k = "${testSecret}";`, {
    policy,
    filePath: 'src/payments/client.mjs',
    orgAllowlistSalt: allowSalt,
    sessionKey: 'sess-1'
  });
  assert.equal(inSrc.modified, true);
  assert.ok(containsWriteOnlyPlaceholder(inSrc.scrubbedText));
});

// ===========================================================================
// Suite 2: Write-Only Placeholders, FM-1 2-Strike Cap & PreTool Guards
// ===========================================================================
test('Suite 2.1: Write-only HMAC twin is deterministic within session, CRC8 valid & randomized across sessions', () => {
  const s1a = deriveWriteOnlyPlaceholder('AWS_KEY', 'AKIAIOSFODNN7EXAMPLE', 'session-key-A');
  const s1b = deriveWriteOnlyPlaceholder('AWS_KEY', 'AKIAIOSFODNN7EXAMPLE', 'session-key-A');
  const s2 = deriveWriteOnlyPlaceholder('AWS_KEY', 'AKIAIOSFODNN7EXAMPLE', 'session-key-B');

  assert.equal(s1a, s1b);
  assert.notEqual(s1a, s2);
  assert.equal(verifyPlaceholderCrc8(s1a), true);
  assert.equal(verifyPlaceholderCrc8(s1a.slice(0, -2) + (s1a.endsWith('ff') ? '00' : 'ff')), false);
  assert.equal(containsWriteOnlyPlaceholder(`export KEY=${s1a}`), true);
});

test('Suite 2.2: PreToolUse enforces FM-1 2-strike cap, Class-A path blocks, self-tamper & remediation Edit escape hatch', () => {
  const ph = deriveWriteOnlyPlaceholder('AWS_KEY', 'AKIAIOSFODNN7EXAMPLE', 'sess-fm1');

  const strike1 = evaluateAirlockPreToolGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'src/app.mjs', old_string: 'x', new_string: `const k = "${ph}";` } },
    { policy: { enabled: true, mode: 'enforce' }, strikeCount: 0 }
  );
  assert.equal(strike1.blocked, true);
  assert.equal(strike1.fmCode, 'FM-1');
  assert.equal(strike1.strikeCount, 1);
  assert.equal(strike1.strikeCapReached, false);

  const strike2 = evaluateAirlockPreToolGuard(
    { tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: ${ph}" https://api.example.com` } },
    { policy: { enabled: true, mode: 'enforce' }, strikeCount: 1 }
  );
  assert.equal(strike2.blocked, true);
  assert.equal(strike2.fmCode, 'FM-1');
  assert.equal(strike2.strikeCount, 2);
  assert.equal(strike2.strikeCapReached, true);

  // Class A block vs .env.example allow
  assert.equal(isClassASecretPath('/repo/.env.production'), true);
  assert.equal(isClassASecretPath('/repo/.env.example'), false);
  assert.equal(isSensitiveBinaryReadPath('/repo/certs/prod.p12'), true);
  assert.equal(isAirlockSelfTamperTarget('Write', { file_path: '/repo/.airlock/policy.json' }), true);
  assert.equal(isObfuscatedSecretShellCommand('cat .env.production'), true);
  assert.equal(isObfuscatedSecretShellCommand('npm test'), false);

  const envRead = evaluateAirlockPreToolGuard(
    { tool_name: 'Read', tool_input: { file_path: '/repo/.env.production' } },
    { policy: { enabled: true, mode: 'enforce' } }
  );
  assert.equal(envRead.blocked, true);
  assert.equal(envRead.fmCode, 'FM-CLASS-A-PATH');

  // Remediation Edit: removing leaked secret in old_string -> clean env lookup in new_string MUST succeed
  const remediationEdit = evaluateAirlockPreToolGuard(
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/config.mjs',
        old_string: `const key = "${FAKE_STRIPE('51OldLeakedSecret123456')}";`,
        new_string: 'const key = process.env.STRIPE_KEY;'
      }
    },
    { policy: { enabled: true, mode: 'enforce' } }
  );
  assert.equal(remediationEdit.blocked, false);
});

// ===========================================================================
// Suite 3: Claude Code CLI Hooks, FM-11 Output Shaper, Drift & FM-8 Watchdog
// ===========================================================================
test('Suite 3.1: FM-11 cloneAndScrubToolResponse scrubs valid shapes cleanly & flags unknown host schema drift', () => {
  assert.equal(isTestedClaudeCodeVersion('2.1.121').tested, true);
  assert.equal(isTestedClaudeCodeVersion('2.1.325').tested, true);
  assert.equal(isTestedClaudeCodeVersion('2.2.0').tested, false);

  const validRead = {
    tool_name: 'Read',
    tool_response: {
      type: 'text',
      file: { filePath: 'src/db.mjs', content: 'const url = "postgres://u:pass123@db.acme:5432/prod";' },
      unexpectedFutureField: 'present'
    }
  };
  const shaped = cloneAndScrubToolResponse(validRead, {
    sessionKey: 'sess-shaper',
    hostVersion: '2.1.325'
  });

  assert.equal(shaped.modified, true);
  assert.equal(shaped.schemaDriftDetected, false);
  assert.equal(containsWriteOnlyPlaceholder(shaped.updatedToolOutput.file.content), true);
  // Original input must remain completely unmutated and unknown keys preserved
  assert.ok(validRead.tool_response.file.content.includes('pass123'));
  assert.equal(shaped.updatedToolOutput.unexpectedFutureField, 'present');

  const driftedRead = {
    tool_name: 'Read',
    tool_response: {
      type: 'v3_future_read',
      payload: 'postgres://u:pass123@db.acme:5432/prod'
    }
  };
  const drifted = cloneAndScrubToolResponse(driftedRead, {
    sessionKey: 'sess-shaper',
    hostVersion: '2.2.0'
  });
  assert.equal(drifted.modified, true);
  assert.equal(drifted.schemaDriftDetected, true);
  assert.equal(containsWriteOnlyPlaceholder(drifted.updatedToolOutput.payload), true);
});

test('Suite 3.2: PreToolUse, PostToolUse, UserPromptSubmit & SessionStart hooks enforce end-to-end with zero plaintext leakage', () => {
  const tmpWs = makeTempDir('ah-ws-s3-');
  const tmpState = makeTempDir('ah-st-s3-');
  try {
    fs.mkdirSync(path.join(tmpWs, '.airlock'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWs, '.airlock', 'policy.json'),
      JSON.stringify({ v: 1, enabled: true, mode: 'enforce', internalDomains: ['corp.internal'] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'CLAUDE.md'),
      `# Workspace Rules\nNEVER use test key ${FAKE_GHP} here.\n`,
      'utf8'
    );

    const commonOpts = { cwd: tmpWs, airlockStateDir: tmpState };

    // 1. SessionStart static instruction scan (warns without leaking secret)
    const startRes = runCompactLifecycleHook(
      { hook_event_name: 'SessionStart', session_id: 's3-cli', cwd: tmpWs, claude_code_version: '2.2.0' },
      commonOpts
    );
    assert.equal(startRes.exitCode, 0);
    assert.ok(startRes.stdout.includes('CLAUDE.md:2'));
    assert.ok(startRes.stdout.includes('VERSION WARNING'));
    assert.equal(startRes.stdout.includes(FAKE_GHP.slice(0, 20)), false);

    // 2. UserPromptSubmit blocks secret in prompt with exitCode 2
    const promptSecret = FAKE_STRIPE('51SecretPromptKey999999');
    const promptRes = runUserPromptSubmitHook(
      { session_id: 's3-cli', cwd: tmpWs, prompt: `Use token ${promptSecret} please` },
      commonOpts
    );
    assert.equal(promptRes.exitCode, 2);
    assert.equal(promptRes.verdict.decision, 'block');
    assert.equal(promptRes.stderr.includes(promptSecret), false);

    // 3. PreToolUse tracks in-flight and PostToolUse scrubs Read output via updatedToolOutput
    const preAllow = runPreToolUseHook(
      { session_id: 's3-cli', cwd: tmpWs, tool_use_id: 'tu-1', tool_name: 'Read', tool_input: { file_path: 'src/index.mjs' } },
      commonOpts
    );
    assert.equal(preAllow.exitCode, 0);

    const postRes = runPostToolUseHook(
      {
        session_id: 's3-cli',
        cwd: tmpWs,
        tool_use_id: 'tu-1',
        tool_name: 'Read',
        tool_response: { type: 'text', file: { filePath: 'src/index.mjs', content: `export const AWS = "${FAKE_AWS}";` } }
      },
      commonOpts
    );
    assert.equal(postRes.exitCode, 0);
    const outPayload = JSON.parse(postRes.stdout);
    assert.equal(containsWriteOnlyPlaceholder(outPayload.updatedToolOutput.file.content), true);
    assert.equal(outPayload.updatedToolOutput.file.content.includes(FAKE_AWS), false);

    // 4. Verify strike state persistence across PreToolUse FM-1 calls
    const placeholder = findWriteOnlyPlaceholders(outPayload.updatedToolOutput.file.content)[0];
    assert.ok(placeholder);
    const fm1 = runPreToolUseHook(
      { session_id: 's3-cli', cwd: tmpWs, tool_name: 'Write', tool_input: { file_path: 'src/out.mjs', content: placeholder } },
      commonOpts
    );
    assert.equal(fm1.exitCode, 2);
    assert.equal(readStrikeState('s3-cli', { stateDir: tmpState }).strikeCount, 1);
  } finally {
    rmDirSafe(tmpWs);
    rmDirSafe(tmpState);
  }
});

test('Suite 3.3: FM-8 self-timeout watchdog fails closed (exit 2) before host kill on hung hook', async () => {
  const tmpState = makeTempDir('ah-wd-s3-');
  const tmpWs = makeTempDir('ah-wdws-s3-');
  try {
    fs.mkdirSync(path.join(tmpWs, '.airlock'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, '.airlock', 'policy.json'), JSON.stringify({ enabled: true, mode: 'enforce' }));

    let exitCode = null;
    let stderrBuf = '';
    const waitPre = executePreToolUseCli({
      watchdogTimeoutMs: 50,
      hookOptions: { cwd: tmpWs, airlockStateDir: tmpState, airlock: { enabled: true, mode: 'enforce' } },
      readPayload: () => new Promise((resolve) => setTimeout(() => resolve({ cwd: tmpWs, tool_name: 'Bash', tool_input: { command: 'echo ok' } }), 350)),
      ioOverride: {
        stderrWrite: (s) => { stderrBuf += s; },
        exitFn: (code) => { if (exitCode === null) exitCode = code; }
      }
    });
    await waitPre;
    assert.equal(exitCode, 2);
    assert.ok(stderrBuf.includes('Watchdog'));

    let pExit = null;
    let pErr = '';
    const waitPrompt = executeUserPromptSubmitCli({
      watchdogTimeoutMs: 50,
      hookOptions: { cwd: tmpWs, airlockStateDir: tmpState, airlock: { enabled: true, mode: 'enforce' } },
      readPayload: () => new Promise((resolve) => setTimeout(() => resolve({ cwd: tmpWs, prompt: 'hello' }), 350)),
      ioOverride: {
        stderrWrite: (s) => { pErr += s; },
        exitFn: (code) => { if (pExit === null) pExit = code; }
      }
    });
    await waitPrompt;
    assert.equal(pExit, 2);
    assert.ok(pErr.includes('Watchdog'));
  } finally {
    rmDirSafe(tmpState);
    rmDirSafe(tmpWs);
  }
});

// ===========================================================================
// Suite 4: Zero-Plaintext Ledger, Crash Lapses, Signed Policy & Receipts
// ===========================================================================
test('Suite 4.1: SQLite + JSONL hash-chained ledger detects tampering & forbids plaintext', () => {
  for (const forceFallback of [false, true]) {
    const tmpState = makeTempDir(`ah-led-${forceFallback ? 'jsonl' : 'sql'}-`);
    try {
      const ledger = new AirlockAuditLedger({ stateDir: tmpState, forceFallback });
      assert.throws(() => assertZeroPlaintextRecord({ rawValue: 'secret' }), /AIRLOCK_LEDGER_PLAINTEXT_VIOLATION/);
      assert.throws(
        () => ledger.recordEvent({ toolName: 'Bash', categories: [FAKE_AWS] }),
        /AIRLOCK_LEDGER_PLAINTEXT_VIOLATION/
      );

      ledger.recordEvent({ sessionId: 's4', hookPhase: 'PreToolUse', toolName: 'Read', decision: 'deny', fmCode: 'FM-CLASS-A-PATH' });
      ledger.recordPreToolInFlight({ sessionId: 's4', toolUseId: 'crash-tu-99', toolName: 'Bash', startedAtMs: Date.now() - 60000 });
      const lapses = ledger.sweepExpiredInFlight(10000);
      assert.equal(lapses.length, 1);
      assert.equal(lapses[0].coverageLapse, true);

      const summary = ledger.getAirlockSummary({ sessionId: 's4' });
      assert.equal(summary.chainValid, true);
      assert.equal(summary.coverageLapses, 1);

      const rcpt = generateAirlockEnforcementReceipt(summary, { workspaceName: 'acme-api' });
      assert.ok(Buffer.from(rcpt.pdfBytes).toString('latin1').startsWith('%PDF-1.4'));
      assert.ok(rcpt.markdown.includes('Coverage Lapses (must be 0)'));
      assert.equal(rcpt.json.metrics.coverageLapses, 1);
      ledger.close();

      if (forceFallback) {
        // Corrupt line 1 hash chain in JSONL and confirm tamper detection
        const lines = fs.readFileSync(path.join(tmpState, 'airlock_ledger.jsonl'), 'utf8').trim().split('\n');
        const first = JSON.parse(lines[0]);
        first.toolName = 'TamperedTool';
        lines[0] = JSON.stringify(first);
        fs.writeFileSync(path.join(tmpState, 'airlock_ledger.jsonl'), lines.join('\n') + '\n');
        const verifyLedger = new AirlockAuditLedger({ stateDir: tmpState, forceFallback: true });
        const verifyRes = verifyLedger.verifyLedgerChain();
        verifyLedger.close();
        assert.equal(verifyRes.valid, false);
        assert.equal(verifyRes.brokenAtSeq, 1);
      }
    } finally {
      rmDirSafe(tmpState);
    }
  }
});

test('Suite 4.2: Signed Ed25519 & HMAC policy verification detects tampering and fails closed', () => {
  const tmpWs = makeTempDir('ah-pol-');
  try {
    fs.mkdirSync(path.join(tmpWs, '.airlock'), { recursive: true });
    const policy = { v: 1, enabled: true, mode: 'audit', internalDomains: ['secret.corp'] };
    const signed = signAirlockPolicy(policy);
    const sigCheck = verifyAirlockPolicySignature(policy, signed.signatureEnvelope, { publicKeyPem: signed.publicKeyPem });
    assert.equal(sigCheck.valid, true);

    fs.writeFileSync(path.join(tmpWs, '.airlock', 'policy.json'), JSON.stringify({ ...policy, mode: 'off', enabled: false }));
    fs.writeFileSync(path.join(tmpWs, '.airlock', 'policy.sig'), JSON.stringify(signed.signatureEnvelope));
    fs.writeFileSync(path.join(tmpWs, '.airlock', 'policy.pub'), signed.publicKeyPem);

    const loaded = loadAirlockPolicy({ cwd: tmpWs });
    assert.equal(loaded.signed, true);
    assert.equal(loaded.signatureValid, false);
    assert.equal(loaded.tampered, true);
    // Tampered policy cannot downgrade to 'off'; forces enforce fail-closed
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.config.mode, 'enforce');
  } finally {
    rmDirSafe(tmpWs);
  }
});

// ===========================================================================
// Suite 5: Antigravity Track B, Pro License, CLI, UI Parity & Benchmark Gate
// ===========================================================================
test('Suite 5.1: Track B Antigravity handlers handle lastUserInput, toolCall shape & SessionStart injectSteps', async () => {
  const tmpWs = makeTempDir('ah-agy-');
  const tmpState = makeTempDir('ah-agy-st-');
  try {
    fs.mkdirSync(path.join(tmpWs, '.airlock'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, '.airlock', 'policy.json'), JSON.stringify({ enabled: true, mode: 'enforce' }));
    fs.writeFileSync(path.join(tmpWs, 'AGENTS.md'), `Secret in AGENTS.md: ${FAKE_STRIPE('51AgentRuleLeakedSecret99')}\n`);

    const sessRes = await handleSessionStart({
      conversationId: 'agy-1',
      workspacePath: tmpWs,
      airlockStateDir: tmpState
    });
    assert.ok(Array.isArray(sessRes.injectSteps) && sessRes.injectSteps.length >= 1);
    assert.ok(sessRes.systemMessage.includes('AGENTS.md:1'));

    const invRes = await runStrictPreInvocation({
      conversationId: 'agy-1',
      workspacePath: tmpWs,
      airlockStateDir: tmpState,
      lastUserInput: `Deploy with key ${FAKE_GHP}`
    });
    assert.equal(invRes.decision, 'deny');
    assert.equal(invRes.terminationBehavior, 'terminate');

    const toolRes = await runStrictPreToolUse({
      conversationId: 'agy-1',
      workspacePath: tmpWs,
      airlockStateDir: tmpState,
      toolCall: { name: 'Write', args: { file_path: 'src/key.mjs', content: `export const K = "${FAKE_AWS}";` } }
    });
    assert.equal(toolRes.decision, 'deny');
    assert.equal(toolRes.overwrite, false);
  } finally {
    rmDirSafe(tmpWs);
    rmDirSafe(tmpState);
  }
});

test('Suite 5.2: Pro licensing gate, CLI subcommands, UI Zone A badge & hooks/hooks.json non-mutation', () => {
  const tmpWs = makeTempDir('ah-cli-');
  const tmpState = makeTempDir('ah-clists-');
  try {
    // Missing license under strict Pro check denies Airlock feature cleanly
    const strictGate = requireProFeature('airlock_context_module', {
      strict: true,
      licensePath: path.join(tmpWs, 'nonexistent-license.json')
    });
    assert.equal(strictGate.allowed, false);

    // Non-strict dev/test allows Airlock and keeps pricing intact
    assert.equal(getProEntitlementStatus().entitled, true);
    assert.equal(requireProFeature('airlock_context_module').allowed, true);

    // CLI init writes opt-in settings.local.json + signed policy without touching repo hooks/hooks.json
    const initRes = runCli(['airlock', 'init', '--cwd', tmpWs, '--mode', 'enforce', '--sign', '--json']);
    assert.equal(initRes.exitCode, 0);
    assert.equal(initRes.data.signed, true);
    assert.ok(fs.existsSync(path.join(tmpWs, '.airlock', 'policy.sig')));
    assert.ok(fs.existsSync(path.join(tmpWs, '.claude', 'settings.local.json')));

    // Confirm repo hooks/hooks.json stayed untouched (no Grep|Glob added to default matcher)
    const hooksJson = JSON.parse(fs.readFileSync(path.resolve('hooks/hooks.json'), 'utf8'));
    const preMatcher = hooksJson.hooks?.PreToolUse?.[0]?.matcher || '';
    assert.equal(/\bGrep\b|\bGlob\b/.test(preMatcher), false);

    const statusRes = runCli(['airlock', 'status', '--cwd', tmpWs, '--state-dir', tmpState, '--json']);
    assert.equal(statusRes.exitCode, 0);
    assert.equal(statusRes.data.summary.chainValid, true);

    const verifyRes = runCli(['airlock', 'verify-ledger', '--state-dir', tmpState, '--json']);
    assert.equal(verifyRes.exitCode, 0);
    assert.equal(verifyRes.data.valid, true);

    const rcptRes = runCli(['airlock', 'receipt', '--cwd', tmpWs, '--state-dir', tmpState, '--format', 'md']);
    assert.equal(rcptRes.exitCode, 0);
    assert.ok(rcptRes.output.includes('Airlock Enforcement Receipt'));

    // UI Pure-JS render includes Airlock status badge when airlock state present
    const { html } = renderHorizonPanelHtml({
      sessionId: 'ui-airlock',
      modelLabel: 'Claude Opus',
      airlock: {
        enabled: true,
        mode: 'enforce',
        lastHeartbeatAt: new Date().toISOString(),
        totalEvents: 5,
        schemaTested: false,
        coverageLapses: 0,
        blockedCount: 2,
        scrubbedCount: 3
      }
    });
    assert.ok(html.includes('id="airlockStatusBadge"'));
    assert.ok(html.includes('Airlock: untested host'));

    const { html: inactiveHtml } = renderHorizonPanelHtml({
      sessionId: 'ui-airlock-inactive',
      modelLabel: 'Claude Opus',
      airlock: { enabled: true, mode: 'enforce', lastHeartbeatAt: null, totalEvents: 0 }
    });
    assert.ok(inactiveHtml.includes('Airlock: INACTIVE · hooks did not fire'));

    // Benchmark harness gate smoke test (< 0.1% FP)
    const bench = runAirlockBenchmark({ corpusLines: 10000, matrixRuns: 5, sizesKb: [10], termCounts: [100] });
    assert.equal(bench.ok, true);
    assert.ok(bench.corpus.falsePositiveRatePct < 0.1);
  } finally {
    rmDirSafe(tmpWs);
    rmDirSafe(tmpState);
  }
});

test('Suite 5.3: 30 multi-turn SCRUB_ALL_TEXT_READS + FM-1 2-strike recovery maintains <5% stall rate and <=2 loop cap', () => {
  const tmpWs = makeTempDir('ah-m30-');
  const tmpState = makeTempDir('ah-m30st-');
  try {
    fs.mkdirSync(path.join(tmpWs, '.airlock'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, '.airlock', 'policy.json'), JSON.stringify({ enabled: true, mode: 'enforce' }));

    let stalledSessions = 0;
    let maxBlockLoopCount = 0;

    for (let s = 0; s < 30; s++) {
      const sid = `m30-sess-${s}`;
      const commonOpts = { cwd: tmpWs, airlockStateDir: tmpState };

      // Turn 1: Read file containing both a secret API key line and a clean config line (`pool: 5`)
      const postRead = runPostToolUseHook(
        {
          session_id: sid,
          cwd: tmpWs,
          tool_use_id: `tu-${s}-1`,
          tool_name: 'Read',
          tool_response: {
            type: 'text',
            file: {
              filePath: 'config/app.json',
              content: `{"apiKey":"${FAKE_STRIPE('51MultiTurnTestKey123456')}","pool":5}`
            }
          }
        },
        commonOpts
      );
      assert.equal(postRead.exitCode, 0);
      const scrubbed = JSON.parse(postRead.stdout).updatedToolOutput.file.content;
      const ph = findWriteOnlyPlaceholders(scrubbed)[0];
      assert.ok(ph);

      // Every 3rd session attempts to echo the placeholder back in Edit.new_string -> blocked by FM-1,
      // hits 2-strike retry cap at strike 2, then recovers via clean anchor Edit on `"pool": 5` -> `"pool": 20`.
      let loopBlocks = 0;
      if (s % 3 === 0) {
        const b1 = runPreToolUseHook(
          { session_id: sid, cwd: tmpWs, tool_name: 'Edit', tool_input: { file_path: 'config/app.json', old_string: '"pool":5', new_string: `"apiKey":"${ph}"` } },
          commonOpts
        );
        assert.equal(b1.exitCode, 2);
        assert.equal(b1.airlock.fmCode, 'FM-1');
        loopBlocks++;

        const b2 = runPreToolUseHook(
          { session_id: sid, cwd: tmpWs, tool_name: 'Edit', tool_input: { file_path: 'config/app.json', old_string: '"pool":5', new_string: `"apiKey":"${ph}"` } },
          commonOpts
        );
        assert.equal(b2.exitCode, 2);
        assert.equal(b2.airlock.strikeCapReached, true);
        loopBlocks++;
      }
      if (loopBlocks > maxBlockLoopCount) maxBlockLoopCount = loopBlocks;

      // Clean-anchor Edit on non-secret lines succeeds in all 30 sessions
      const cleanEdit = runPreToolUseHook(
        { session_id: sid, cwd: tmpWs, tool_name: 'Edit', tool_input: { file_path: 'config/app.json', old_string: '"pool":5', new_string: '"pool":20' } },
        commonOpts
      );
      if (cleanEdit.exitCode !== 0) {
        stalledSessions++;
      }
    }

    const stallRatePct = (stalledSessions / 30) * 100;
    assert.ok(stallRatePct < 5, `Expected stall rate < 5%, got ${stallRatePct}%`);
    assert.ok(maxBlockLoopCount <= 2, `Expected max block loops <= 2, got ${maxBlockLoopCount}`);
  } finally {
    rmDirSafe(tmpWs);
    rmDirSafe(tmpState);
  }
});
