import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../src/utils/nodeIo.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use-core.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use-core.mjs';
import { classifyShellPostToolPolicy } from '../src/core/fts5_output_compressor.mjs';
import {
  configureShield,
  evaluateShieldReadGuard,
  isHighbeamCacheArtifactPath,
  evaluateClampExpectedValue,
  buildCompactClampLandmarks
} from '../src/core/shield_manager.mjs';
import { readLedgerEntries } from '../src/core-isomorphic/coach/savedQuotaLedger.mjs';

function makeTempWs(prefix = 'hb-idea13-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.git'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Idea 1 (PostToolUse): leaves cat/grep|head/tailed/heredoc/node-e commands untouched and unoffloaded', () => {
  const ws = makeTempWs('hb-post-gate-');
  try {
    const bigCodeDump = Array.from({ length: 320 }, (_, i) =>
      `export function helperFn_${i}(x) { return Number(x || 0) + ${i}; } // ${'p'.repeat(40)}`
    ).join('\n');
    assert.ok(bigCodeDump.length > 20_000, 'Fixture must exceed 4k-token threshold');

    const protectedCmds = [
      'cat src/a.mjs src/b.mjs',
      'grep -v "^Spec paragraph" docs/SPEC.md | head -60',
      'python3 - <<\'EOF\'\nprint("hello")\nEOF',
      'node -e "console.log(123)"'
    ];
    for (let i = 0; i < protectedCmds.length; i += 1) {
      const cmd = protectedCmds[i];
      const policy = classifyShellPostToolPolicy(cmd);
      assert.equal(policy.allowFts5, false, `Expected allowFts5=false for: ${cmd}`);
      assert.equal(policy.allowOffload, false, `Expected allowOffload=false for: ${cmd}`);

      const res = runPostToolUseHook(
        {
          session_id: `sess-prot-${i}`,
          tool_use_id: `tu-prot-${i}`,
          cwd: ws.dir,
          tool_name: 'Bash',
          tool_input: { command: cmd },
          tool_response: { stdout: bigCodeDump, stderr: '', exit_code: 0 }
        },
        { cwd: ws.dir }
      );
      assert.equal(res.stdout, '', `Command must pass untouched: ${cmd}`);
    }

    // Bounded compound tail command (~2.5 KB, 55 lines) must pass untouched
    const smallTailedOut = Array.from({ length: 55 }, (_, i) => `ok line ${i}: ${'d'.repeat(28)}`).join('\n');
    const tailedRes = runPostToolUseHook(
      {
        session_id: 'sess-tail-1',
        tool_use_id: 'tu-tail-1',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test 2>&1 | tail -30; echo ---; node scripts/diag_check.mjs 2>&1 | tail -30' },
        tool_response: { stdout: smallTailedOut, stderr: '', exit_code: 0 }
      },
      { cwd: ws.dir }
    );
    assert.equal(tailedRes.stdout, '', 'Bounded compound tail command must pass untouched');
    assert.equal(fs.existsSync(path.join(ws.dir, '.claude', 'cache', 'artifacts')), false);
    assert.equal(readLedgerEntries({ cwd: ws.dir }).length, 0);
  } finally {
    ws.cleanup();
  }
});

test('Idea 1 (PostToolUse): unbounded passing npm test preserves tally summary; diag_check preserves WARN line', () => {
  const ws = makeTempWs('hb-post-pass-');
  try {
    const passingTestLines = Array.from({ length: 90 }, (_, i) => `ok ${i + 1} - ledger test case ${i + 1} ${'k'.repeat(40)}`);
    passingTestLines.push('ℹ tests 10', 'ℹ suites 2', 'ℹ pass 10', 'ℹ fail 0');
    const rawNpmTest = passingTestLines.join('\n');
    assert.ok(Buffer.byteLength(rawNpmTest, 'utf8') >= 4096);

    const testRes = runPostToolUseHook(
      {
        session_id: 'sess-pass-summary',
        tool_use_id: 'tu-npm-pass',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: rawNpmTest, stderr: '', exit_code: 0 }
      },
      { cwd: ws.dir }
    );
    const outTest = JSON.parse(testRes.stdout).hookSpecificOutput.updatedToolOutput.stdout;
    assert.ok(outTest.includes('Result: PASS (0 failing tests)'));
    assert.ok(outTest.includes('ℹ tests 10'));
    assert.ok(outTest.includes('ℹ pass 10'));
    assert.ok(outTest.includes('ℹ fail 0'));

    const diagLines = Array.from({ length: 60 }, (_, i) => {
      const tag = i + 1 === 14 ? 'WARN: tier rounding edge at band boundary' : 'OK';
      return `check[${String(i + 1).padStart(2, '0')}] module=ledger invariant=band_${i + 1} detail=${'d'.repeat(60)} status=${tag}`;
    });
    const diagRes = runPostToolUseHook(
      {
        session_id: 'sess-diag-warn',
        tool_use_id: 'tu-diag-60',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'node scripts/diag_check.mjs' },
        tool_response: { stdout: diagLines.join('\n'), stderr: '', exit_code: 0 }
      },
      { cwd: ws.dir }
    );
    const outDiag = JSON.parse(diagRes.stdout).hookSpecificOutput.updatedToolOutput.stdout;
    assert.ok(outDiag.includes('WARN: tier rounding edge at band boundary'));
  } finally {
    ws.cleanup();
  }
});

test('Idea 1 (PreToolUse Shield): artifact self-clamp exemption, EV gate, structural landmarks, and clean notices', () => {
  const ws = makeTempWs('hb-shield-ev-');
  try {
    configureShield({ action: 'enable', platform: 'all', cwd: ws.dir });

    // 1. Highbeam artifact/index cache paths are never clamped
    assert.equal(isHighbeamCacheArtifactPath('.claude/cache/artifacts/ah_deadbeef.txt'), true);
    assert.equal(isHighbeamCacheArtifactPath('.agents/cache/foo.txt'), true);
    const claudeArt = path.join(ws.dir, '.claude', 'cache', 'artifacts', 'ah_deadbeef.txt');
    const agentsCache = path.join(ws.dir, '.agents', 'cache', 'foo.txt');
    fs.mkdirSync(path.dirname(claudeArt), { recursive: true });
    fs.mkdirSync(path.dirname(agentsCache), { recursive: true });
    const artBody = Array.from({ length: 300 }, (_, i) => `artifact line ${i}: ${'x'.repeat(70)}`).join('\n');
    fs.writeFileSync(claudeArt, artBody, 'utf8');
    fs.writeFileSync(agentsCache, artBody, 'utf8');
    assert.equal(evaluateShieldReadGuard({ platform: 'claude', cwd: ws.dir, filePath: claudeArt, recordLedger: false }).action, 'allow');
    assert.equal(evaluateShieldReadGuard({ platform: 'claude', cwd: ws.dir, filePath: agentsCache, recordLedger: false }).action, 'allow');

    // 2. Mutable ~250-line / ~20 KB source file is bypassed by EV gate (allow, never deny)
    const srcDir = path.join(ws.dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const smallCodePath = path.join(srcDir, 'creditPool.mjs');
    const smallCode = Array.from({ length: 250 }, (_, i) =>
      i % 50 === 0 ? `export function poolFn_${i}(x) { return x + ${i}; }` : `  const v_${i} = ${i}; // ${'p'.repeat(55)}`
    ).join('\n');
    fs.writeFileSync(smallCodePath, smallCode, 'utf8');
    const smallEv = evaluateShieldReadGuard({
      platform: 'claude',
      cwd: ws.dir,
      filePath: smallCodePath,
      hasSliceBounds: false,
      modelId: 'claude-sonnet-5-5',
      recordLedger: false
    });
    assert.equal(smallEv.action, 'allow');
    assert.equal(smallEv.evBypassed, true);

    // 3. Large > 40 KB source file still clears EV bar and clamps
    const megaCodePath = path.join(srcDir, 'megaModule.mjs');
    const megaCode = Array.from({ length: 420 }, (_, i) =>
      i % 80 === 0 ? `export function megaFn_${i}(x) { return x + ${i}; }` : `  const mega_${i} = ${i}; // ${'m'.repeat(75)}`
    ).join('\n');
    fs.writeFileSync(megaCodePath, megaCode, 'utf8');
    const megaRes = evaluateShieldReadGuard({
      platform: 'claude',
      cwd: ws.dir,
      filePath: megaCodePath,
      hasSliceBounds: false,
      modelId: 'claude-sonnet-5-5',
      recordLedger: false
    });
    assert.equal(megaRes.action, 'clamp');
    assert.equal(megaRes.ev?.netPositive, true);

    // 4. Repetitive 180-line ~38 KB docs/SPEC.md exposes unread range, sections, and unique line landmark without tok saved
    const docsDir = path.join(ws.dir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    const specLines = [];
    for (let i = 0; i < 180; i += 1) {
      if (i % 30 === 0) {
        specLines.push(`## Section ${i / 30 + 1}: Policy (${i + 1})`);
      } else if (i === 125) {
        specLines.push('REQUIRED_BAND_RULE: Use half-away-from-zero Math.round(bandUnits * unitRateCents) across tiers.');
      } else {
        specLines.push(`Spec paragraph ${i + 1}: Deterministic multi-tenant ledger rounding invariant payload padding ${'x'.repeat(110)}`);
      }
    }
    const specPath = path.join(docsDir, 'SPEC.md');
    fs.writeFileSync(specPath, specLines.join('\n') + '\n', 'utf8');
    const specClamp = evaluateShieldReadGuard({
      platform: 'claude',
      cwd: ws.dir,
      filePath: specPath,
      hasSliceBounds: false,
      modelId: 'claude-sonnet-5-5',
      recordLedger: false
    });
    assert.equal(specClamp.action, 'clamp');
    assert.match(specClamp.reason, /of 18[01] lines/);
    assert.ok(specClamp.reason.includes('unread: L'));
    assert.ok(specClamp.reason.includes('## Section'));
    assert.ok(specClamp.reason.includes('L126:'));
    assert.ok(!/tok saved|0 extra turn/i.test(specClamp.reason));

    const testLandmarks = buildCompactClampLandmarks(specLines, 1, 28, '');
    assert.ok(testLandmarks.includes('L126: REQUIRED_BAND_RULE'));
    assert.equal(evaluateClampExpectedValue({ clampSavedTokens: 1500, filePath: smallCodePath, rates: {} }).netPositive, false);

    // 5. Near pricing cliff (92k on Haiku 5.5) still clamps 8 KB files
    const cliffMd = path.join(docsDir, 'cliff.md');
    fs.writeFileSync(cliffMd, Array.from({ length: 80 }, (_, i) => `Line ${i}: ${'c'.repeat(105)}`).join('\n'), 'utf8');
    const cliffRes = evaluateShieldReadGuard({
      platform: 'claude',
      cwd: ws.dir,
      filePath: cliffMd,
      hasSliceBounds: false,
      currentPromptTokens: 92_000,
      modelId: 'claude-haiku-5-5',
      recordLedger: false
    });
    assert.equal(cliffRes.action, 'clamp');
    assert.equal(cliffRes.detectorId, 'DET-12');

    // 6. Clean GUARD-4 Verify Fold & Read-Interval notices omit tok saved / tokens saved
    const foldPath = path.join(srcDir, 'foldService.mjs');
    const v1 = Array.from({ length: 240 }, (_, i) => `export function step_${i + 1}(x) { return x + ${i + 1}; }`).join('\n') + '\n';
    fs.writeFileSync(foldPath, v1, 'utf8');
    runPreToolUseHook(
      { session_id: 'sess-clean-msg', cwd: ws.dir, tool_name: 'Read', tool_input: { file_path: foldPath } },
      { cwd: ws.dir }
    );
    const v2 = v1.replace('return x + 120;', 'return x + 999;');
    fs.writeFileSync(foldPath, v2, 'utf8');
    runPreToolUseHook(
      {
        session_id: 'sess-clean-msg',
        cwd: ws.dir,
        tool_name: 'Edit',
        tool_input: { file_path: foldPath, old_string: 'return x + 120;', new_string: 'return x + 999;' }
      },
      { cwd: ws.dir }
    );
    const verifyRes = runPreToolUseHook(
      { session_id: 'sess-clean-msg', cwd: ws.dir, tool_name: 'Read', tool_input: { file_path: foldPath } },
      { cwd: ws.dir }
    );
    assert.equal(verifyRes.verdict.subType, 'POST_EDIT_VERIFY_FOLD');
    assert.ok(!/tok saved|tokens saved/i.test(verifyRes.verdict.reason));

    const intPath = path.join(srcDir, 'intervalClean.mjs');
    fs.writeFileSync(intPath, Array.from({ length: 260 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join('\n'), 'utf8');
    runPreToolUseHook(
      { session_id: 'sess-int-msg', cwd: ws.dir, tool_name: 'Read', tool_input: { file_path: intPath, offset: 1, limit: 100 } },
      { cwd: ws.dir }
    );
    const trimRes = runPreToolUseHook(
      { session_id: 'sess-int-msg', cwd: ws.dir, tool_name: 'Read', tool_input: { file_path: intPath, offset: 40, limit: 100 } },
      { cwd: ws.dir }
    );
    assert.equal(trimRes.verdict.subType, 'READ_INTERVAL_TRIM');
    assert.ok(!/tok saved|tokens saved/i.test(trimRes.verdict.reason));

    const cacheRes = runPreToolUseHook(
      { session_id: 'sess-int-msg', cwd: ws.dir, tool_name: 'Read', tool_input: { file_path: intPath, offset: 10, limit: 50 } },
      { cwd: ws.dir }
    );
    assert.equal(cacheRes.verdict.subType, 'READ_INTERVAL_ANCHOR');
    assert.ok(!/tok saved|tokens saved/i.test(cacheRes.verdict.reason));
  } finally {
    ws.cleanup();
  }
});
