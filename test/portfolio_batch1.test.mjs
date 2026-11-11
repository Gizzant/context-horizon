import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fnv1a64Hex,
  validateStrictAntigravityPluginManifest,
  validateStrictAntigravityHooksJson,
  validateSafePreInvocationOutput,
  validateSafePreToolUseOutput
} from '../src/core/shared/index.mjs';
import {
  runStrictPreInvocation,
  runStrictPreToolUse,
  runStrictPostToolUse,
  auditTrajectoryPortfolioFallback
} from '../src/hooks/portfolio_runtime.mjs';
import { readSidecarSync } from '../src/core/sidecar_store.mjs';
import { SavedQuotaReceiptLedger } from '../src/core/coach/saved_quota_ledger.mjs';

function makeTempWorkspace(prefix = 'ah-b1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Foundation 0 — Strict Antigravity Manifest, Hooks Law & Zero-Seeded Ledger', () => {
  it('validates .antigravity-plugin/plugin.json and hooks.json against strict Antigravity schema laws', () => {
    const manifestPath = path.resolve('.antigravity-plugin/plugin.json');
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mRes = validateStrictAntigravityPluginManifest(manifest);
    assert.equal(mRes.valid, true, `Manifest errors: ${mRes.errors.join('; ')}`);

    const hooksDoc = JSON.parse(fs.readFileSync(path.resolve('hooks.json'), 'utf8'));
    const hRes = validateStrictAntigravityHooksJson(hooksDoc);
    assert.equal(hRes.valid, true, `Hooks errors: ${hRes.errors.join('; ')}`);

    // Negative test: matcher inside PreInvocation/PostInvocation/Stop MUST be rejected
    const badHooks = {
      hooks: {
        PreInvocation: [{ matcher: '.*', type: 'command', command: 'node ./hooks/pre_invocation.mjs', timeout: 5 }]
      }
    };
    assert.equal(validateStrictAntigravityHooksJson(badHooks).valid, false);
  });

  it('initializes SavedQuotaReceiptLedger strictly at $0.00 and 0 tokens with zero mock constants', () => {
    const tmp = makeTempWorkspace('ah-ledger0-');
    try {
      const ledger = new SavedQuotaReceiptLedger({ dbPath: path.join(tmp, 'ledger.sqlite') });
      const summary = ledger.getSummary('fresh-session');
      assert.equal(summary.totalTokensSaved, 0);
      assert.equal(summary.totalArgonEquivTokensSaved, 0);
      assert.equal(summary.totalDollarsSaved, 0);
      assert.equal(summary.formattedDollarsSaved, '$0.00');
      assert.equal(summary.formattedSavedK, '0.0k');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Batch 1 — Rank 1 (DET-05): Pre-Write Destructive Code-Strip, Test-Assertion & 6-Turn FNV-1a Flip-Flop Guard', () => {
  it('blocks >50% shrinkage (files >=40 lines), lazy elision, stripped try/catch, and deleted test assertions in AUTO_PILOT; warns with 3-Stage DbC in COACH', async () => {
    const ws = makeTempWorkspace('ah-det05-');
    const sid = `det05-${Date.now()}`;
    try {
      const srcFile = path.join(ws, 'src', 'service.mjs');
      fs.mkdirSync(path.dirname(srcFile), { recursive: true });
      const fortyFiveLines = Array.from({ length: 42 }, (_, i) => `export const line_${i} = ${i};`).concat([
        'export function safeRun(fn) {',
        '  try { return fn(); } catch (err) { return null; }',
        '}'
      ]).join('\n');
      fs.writeFileSync(srcFile, fortyFiveLines, 'utf8');

      // 1. > 50% shrinkage in AUTO_PILOT -> deny
      const shrinkRes = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        userPrompt: 'Update line_1 in service.mjs',
        tool_name: 'write_to_file',
        tool_input: { TargetFile: srcFile, CodeContent: 'export const line_1 = 99;\n' }
      });
      assert.equal(shrinkRes.decision, 'deny');
      assert.match(shrinkRes.reason, /\[DET-05\].*SHRINKAGE/);
      assert.equal(validateSafePreToolUseOutput(shrinkRes).valid, true);

      // 2. Cleanup-intent exemption ("remove" / "prune" / "delete" / "deprecate" / "drop") -> allow!
      const exemptRes = await runStrictPreToolUse({
        conversationId: `${sid}-exempt`,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        userPrompt: 'Please prune and remove unused constants from service.mjs',
        tool_name: 'write_to_file',
        tool_input: { TargetFile: srcFile, CodeContent: 'export const line_1 = 99;\n' }
      });
      assert.equal(exemptRes.decision, 'allow');

      // 3. Lazy elision placeholder via replace_file_content -> COACH allows but records 3-Stage DbC HUD alert; AUTO_PILOT denies
      const coachElision = await runStrictPreToolUse({
        conversationId: `${sid}-coach`,
        cwd: ws,
        flightMode: 'COACH',
        userPrompt: 'Refactor safeRun',
        tool_name: 'replace_file_content',
        tool_input: {
          TargetFile: srcFile,
          TargetContent: '  try { return fn(); } catch (err) { return null; }',
          ReplacementContent: '  // ... rest of code'
        }
      });
      assert.equal(coachElision.decision, 'allow');
      const coachSidecar = readSidecarSync(`${sid}-coach`);
      assert.ok(coachSidecar.portfolio.hudAlerts.some((a) => a.detectorId === 'DET-05' && /3-Stage Design-by-Contract/.test(a.message)));

      // 4. Stripped try/catch without replacement (partial edit, no >50% file shrinkage!) -> deny in AUTO_PILOT
      const tryStrip = await runStrictPreToolUse({
        conversationId: `${sid}-try`,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        userPrompt: 'Adjust safeRun',
        tool_name: 'replace_file_content',
        tool_input: {
          TargetFile: srcFile,
          TargetContent: '  try { return fn(); } catch (err) { return null; }',
          ReplacementContent: '  return fn();'
        }
      });
      assert.equal(tryStrip.decision, 'deny');
      assert.match(tryStrip.reason, /STRIPPED_TRY_CATCH/);

      // 5. Deleted test assertions inside test/*.test.mjs -> deny in AUTO_PILOT
      const testFile = path.join(ws, 'test', 'service.test.mjs');
      fs.mkdirSync(path.dirname(testFile), { recursive: true });
      fs.writeFileSync(
        testFile,
        'import assert from "node:assert";\nassert.equal(1, 1);\nexpect(true).toBe(true);\n',
        'utf8'
      );
      const assertStrip = await runStrictPreToolUse({
        conversationId: `${sid}-assert`,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        userPrompt: 'Fix failing test',
        tool_name: 'write_to_file',
        tool_input: {
          TargetFile: testFile,
          CodeContent: 'import assert from "node:assert";\nassert.equal(1, 1);\n'
        }
      });
      assert.equal(assertStrip.decision, 'deny');
      assert.match(assertStrip.reason, /DELETED_TEST_ASSERTIONS/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('detects 64-bit FNV-1a State A -> State B -> State A flip-flops across 6-turn ring buffer and trajectory fallback', async () => {
    const ws = makeTempWorkspace('ah-fnv-');
    const sid = `fnv-${Date.now()}`;
    try {
      const f = path.join(ws, 'src', 'calc.mjs');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const stateA = 'export const add = (a, b) => a + b;\n';
      const stateB = 'export const add = (a, b) => Number(a) + Number(b);\n';
      assert.notEqual(fnv1a64Hex(stateA), fnv1a64Hex(stateB));

      fs.writeFileSync(f, stateA, 'utf8');
      // Turn 1: A -> B (clean)
      const r1 = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 1,
        flightMode: 'AUTO_PILOT',
        tool_name: 'write_to_file',
        tool_input: { TargetFile: f, CodeContent: stateB }
      });
      assert.equal(r1.decision, 'allow');
      fs.writeFileSync(f, stateB, 'utf8');

      // Turn 2: B -> A (flip-flop back to Turn 0/1 State A!) -> deny!
      const r2 = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 2,
        flightMode: 'AUTO_PILOT',
        tool_name: 'write_to_file',
        tool_input: { TargetFile: f, CodeContent: stateA }
      });
      assert.equal(r2.decision, 'deny');
      assert.match(r2.reason, /EDIT_FLIP_FLOP_FNV1A64/);

      // GUI Trajectory fallback check
      const fallback = auditTrajectoryPortfolioFallback([
        { previousContent: stateA, toolCalls: [{ name: 'write_to_file', args: { TargetFile: 'calc.mjs', CodeContent: stateB } }] },
        { previousContent: stateB, toolCalls: [{ name: 'write_to_file', args: { TargetFile: 'calc.mjs', CodeContent: stateA } }] }
      ], { flightMode: 'AUTO_PILOT' });
      assert.equal(fallback.alerts.length, 1);
      assert.equal(fallback.alerts[0].detectorId, 'DET-05');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Batch 1 — Rank 2 (DET-06): Unmodified Re-Read & GitClear Blind-Edit Guard', () => {
  it('blocks duplicate unmodified view_file reads while allowing disjoint line ranges and post-edit re-reads', async () => {
    const ws = makeTempWorkspace('ah-det06-');
    const sid = `det06-${Date.now()}`;
    try {
      const f = path.join(ws, 'src', 'alpha.mjs');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Array.from({ length: 120 }, (_, i) => `const x${i} = ${i};`).join('\n'), 'utf8');

      // Read [1..50] on Turn 2 -> allow
      const read1 = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 2,
        flightMode: 'AUTO_PILOT',
        tool_name: 'view_file',
        tool_input: { Path: f, StartLine: 1, EndLine: 50 }
      });
      assert.equal(read1.decision, 'allow');

      // Disjoint range [51..100] on Turn 3 -> allow (negative false-alarm check!)
      const readDisjoint = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 3,
        flightMode: 'AUTO_PILOT',
        tool_name: 'view_file',
        tool_input: { Path: f, StartLine: 51, EndLine: 100 }
      });
      assert.equal(readDisjoint.decision, 'allow');

      // Repeat unmodified [1..50] on Turn 4 -> deny with exact Turn 2 citation!
      const readDup = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 4,
        flightMode: 'AUTO_PILOT',
        tool_name: 'view_file',
        tool_input: { Path: f, StartLine: 1, EndLine: 50 }
      });
      assert.equal(readDup.decision, 'deny');
      assert.equal(readDup.reason, '[DET-06] Unmodified since Turn 2; reuse in-context buffer');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('ask-gates blind new source module creation without prior search while exempting tests, docs, migrations, and greenfield dirs', async () => {
    const ws = makeTempWorkspace('ah-blind-');
    const sid = `blind-${Date.now()}`;
    try {
      const srcDir = path.join(ws, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      // Seed 3 existing source files so src/ is non-greenfield
      for (const n of ['a.mjs', 'b.mjs', 'c.mjs']) {
        fs.writeFileSync(path.join(srcDir, n), 'export default 1;\n', 'utf8');
      }

      // 1. Exemptions: *.test.mjs, docs/*.md, greenfield (<3 files) -> allow!
      for (const exemptRel of ['src/foo.test.mjs', 'docs/guide.md', 'migrations/001.js', 'greenfield/new.mjs']) {
        const res = await runStrictPreToolUse({
          conversationId: sid,
          cwd: ws,
          flightMode: 'AUTO_PILOT',
          userPrompt: 'Add helpers',
          tool_name: 'write_to_file',
          tool_input: { TargetFile: path.join(ws, exemptRel), Overwrite: false, CodeContent: 'export const x = 1;\n' }
        });
        assert.equal(res.decision, 'allow', `Expected ${exemptRel} to be exempt`);
      }

      // 2. Blind new module in populated src/ with 0 discovery calls -> ask!
      const blindAsk = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        userPrompt: 'Implement string formatting utility',
        tool_name: 'write_to_file',
        tool_input: { TargetFile: path.join(srcDir, 'string_utils.mjs'), Overwrite: false, CodeContent: 'export const fmt = (s) => s;\n' }
      });
      assert.equal(blindAsk.decision, 'ask');
      assert.match(blindAsk.reason, /\[DET-06\]/);

      // 3. After grep_search runs -> allow!
      await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        tool_name: 'grep_search',
        tool_input: { Query: 'fmt' }
      });
      const afterSearch = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        userPrompt: 'Implement string formatting utility',
        tool_name: 'write_to_file',
        tool_input: { TargetFile: path.join(srcDir, 'string_utils.mjs'), Overwrite: false, CodeContent: 'export const fmt = (s) => s;\n' }
      });
      assert.equal(afterSearch.decision, 'allow');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Batch 1 — Rank 5 (DET-04): 3-Strike Consecutive Tool Failure Breaker', () => {
  it('blocks the 4th consecutive failure in AUTO_PILOT, obeys 3-turn cooldown in COACH, and resets on exit 0', async () => {
    const ws = makeTempWorkspace('ah-det04-');
    const sid = `det04-${Date.now()}`;
    try {
      for (let i = 1; i <= 3; i++) {
        const pre = await runStrictPreToolUse({
          conversationId: sid,
          cwd: ws,
          turn: i,
          flightMode: 'AUTO_PILOT',
          tool_name: 'run_command',
          tool_input: { CommandLine: 'npm run build' }
        });
        assert.equal(pre.decision, 'allow', `Attempt ${i} should be allowed`);
        await runStrictPostToolUse({
          conversationId: sid,
          tool_name: 'run_command',
          tool_input: { CommandLine: 'npm run build' },
          exitCode: 1
        });
      }

      // 4th attempt -> denied in AUTO_PILOT!
      const fourthAuto = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 4,
        flightMode: 'AUTO_PILOT',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm run build' }
      });
      assert.equal(fourthAuto.decision, 'deny');
      assert.match(fourthAuto.reason, /\[DET-04\] 3 consecutive failures/);

      // COACH mode obeys 3-turn cooldown (alerts on Turn 5, suppressed on Turn 6, alerts again on Turn 8)
      await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 5,
        flightMode: 'COACH',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm run build' }
      });
      const countAt5 = readSidecarSync(sid).portfolio.hudAlerts.filter((a) => a.detectorId === 'DET-04').length;
      await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 6,
        flightMode: 'COACH',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm run build' }
      });
      const countAt6 = readSidecarSync(sid).portfolio.hudAlerts.filter((a) => a.detectorId === 'DET-04').length;
      assert.equal(countAt6, countAt5, 'Turn 6 must respect 3-turn cooldown without nagging');

      // Exit code 0 resets streak!
      await runStrictPostToolUse({
        conversationId: sid,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm run build' },
        exitCode: 0
      });
      const afterReset = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        turn: 9,
        flightMode: 'AUTO_PILOT',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'npm run build' }
      });
      assert.equal(afterReset.decision, 'allow');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
