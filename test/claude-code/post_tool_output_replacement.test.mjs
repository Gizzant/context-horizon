/**
 * @file test/claude-code/post_tool_output_replacement.test.mjs
 * PostToolUse output replacement for built-in tools (launch blocker 2):
 *   - `updatedToolOutput` is emitted in the same shape as the host's `tool_response`
 *   - the model's copy shrinks, so savings are recorded only when output was really replaced
 *   - unknown shapes fall back to `additionalContext` and record no savings
 *   - `HIGHBEAM_POST_OUTPUT_MODE=context` restores the legacy add-only behaviour
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../src/utils/nodeIo.mjs'; // registers the Node I/O adapter (artifact offload needs disk writes)

import {
  runPostToolUseHook,
  buildReplacementToolOutput,
  isHostTruncatedShellOutput
} from '../../hooks/handlers/post-tool-use-core.mjs';

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-post-replace-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function bigLog() {
  return 'ok test passes line\n'.repeat(1200) +
    'FAIL src/a.test.js\nError: expected 1 to be 2\n at foo (a.js:1:1)\n';
}

function readLedger(dir) {
  const file = path.join(dir, '.claude', 'cache', 'horizon_ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('buildReplacementToolOutput keeps the host shape and blanks the other text fields', () => {
  const r = buildReplacementToolOutput(
    { tool_response: { stdout: 'a', stderr: 'b', interrupted: false, isImage: false } },
    'SHORT'
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { stdout: 'SHORT', stderr: '', interrupted: false, isImage: false });

  const s = buildReplacementToolOutput({ tool_response: 'raw' }, 'SHORT');
  assert.deepEqual(s, { ok: true, value: 'SHORT' });
});

test('buildReplacementToolOutput refuses shapes it cannot rebuild', () => {
  assert.equal(buildReplacementToolOutput({ tool_response: [{ type: 'text', text: 'x' }] }, 'S').ok, false);
  assert.equal(buildReplacementToolOutput({ tool_response: { exit_code: 0 } }, 'S').ok, false);
  assert.equal(buildReplacementToolOutput({}, 'S').ok, false);
});

test('Bash log: emits updatedToolOutput in stdout shape, original never appended, savings recorded', () => {
  const ws = makeWorkspace();
  try {
    const log = bigLog();
    const res = runPostToolUseHook(
      {
        session_id: 'repl-1',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: log, stderr: '', exit_code: 1 }
      },
      { cwd: ws.dir }
    );
    assert.equal(res.exitCode, 0);
    const hso = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal('additionalContext' in hso, false);
    assert.equal('updatedMCPToolOutput' in hso, false);
    assert.equal(typeof hso.updatedToolOutput, 'object');
    assert.equal(hso.updatedToolOutput.exit_code, 1);
    assert.equal(hso.updatedToolOutput.stderr, '');
    assert.ok(hso.updatedToolOutput.stdout.length < log.length / 20, 'replacement must be far shorter');
    assert.match(hso.updatedToolOutput.stdout, /FAIL src\/a\.test\.js/);
    assert.match(hso.updatedToolOutput.stdout, /Error: expected 1 to be 2/);
    const ledger = readLedger(ws.dir);
    assert.ok(ledger.length >= 1);
    assert.ok(ledger.every((e) => e.savedTokens > 0));
  } finally {
    ws.cleanup();
  }
});

test('unknown response shape falls back to additionalContext and records no savings', () => {
  const ws = makeWorkspace();
  try {
    const res = runPostToolUseHook(
      {
        session_id: 'repl-2',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: [{ type: 'text', text: bigLog() }]
      },
      { cwd: ws.dir }
    );
    const out = res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : {};
    assert.equal('updatedToolOutput' in out, false);
    assert.equal(readLedger(ws.dir).length, 0);
  } finally {
    ws.cleanup();
  }
});

test('HIGHBEAM_POST_OUTPUT_MODE=context restores add-only output and records no savings', () => {
  const ws = makeWorkspace();
  const prev = process.env.HIGHBEAM_POST_OUTPUT_MODE;
  process.env.HIGHBEAM_POST_OUTPUT_MODE = 'context';
  try {
    const res = runPostToolUseHook(
      {
        session_id: 'repl-3',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: bigLog(), stderr: '', exit_code: 1 }
      },
      { cwd: ws.dir }
    );
    const hso = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal('updatedToolOutput' in hso, false);
    assert.equal(typeof hso.additionalContext, 'string');
    assert.equal(readLedger(ws.dir).length, 0);
  } finally {
    if (prev === undefined) delete process.env.HIGHBEAM_POST_OUTPUT_MODE;
    else process.env.HIGHBEAM_POST_OUTPUT_MODE = prev;
    ws.cleanup();
  }
});

test('small clean output passes through untouched', () => {
  const ws = makeWorkspace();
  try {
    const res = runPostToolUseHook(
      {
        session_id: 'repl-4',
        cwd: ws.dir,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'a.txt\nb.txt\n', stderr: '', exit_code: 0 }
      },
      { cwd: ws.dir }
    );
    assert.equal(res.stdout, '');
    assert.equal(readLedger(ws.dir).length, 0);
  } finally {
    ws.cleanup();
  }
});

test('shell output at Claude Code\'s 30,000-char cap is left alone and records no savings', () => {
  const ws = makeWorkspace();
  const prev = process.env.BASH_MAX_OUTPUT_LENGTH;
  delete process.env.BASH_MAX_OUTPUT_LENGTH;
  try {
    // Claude Code hands PostToolUse only the first 30,000 chars, cut mid-line, and has
    // already saved the full output and shown the model a short preview.
    const capped = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} the quick brown fox jumps over the lazy dog`)
      .join('\n').slice(0, 30000);
    assert.equal(isHostTruncatedShellOutput('PowerShell', capped), true);
    const res = runPostToolUseHook(
      {
        session_id: 'cap-1',
        cwd: ws.dir,
        tool_name: 'PowerShell',
        tool_input: { command: '1..3000' },
        tool_response: { stdout: capped, stderr: '', interrupted: false, isImage: false }
      },
      { cwd: ws.dir }
    );
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, '', 'no replacement emitted');
    assert.equal(res.hostTruncated, true);
    assert.equal(fs.existsSync(path.join(ws.dir, '.claude', 'cache', 'artifacts')), false, 'no partial artifact');
    assert.equal(readLedger(ws.dir).length, 0, 'no savings claimed');

    assert.equal(isHostTruncatedShellOutput('PowerShell', capped.slice(0, 24000)), false);
    assert.equal(isHostTruncatedShellOutput('WebFetch', capped), false);
    process.env.BASH_MAX_OUTPUT_LENGTH = '80000';
    assert.equal(isHostTruncatedShellOutput('Bash', capped), false, 'raised cap is honoured');
  } finally {
    if (prev === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH;
    else process.env.BASH_MAX_OUTPUT_LENGTH = prev;
    ws.cleanup();
  }
});

test('buildReplacementToolOutput refuses empty or non-string array shapes', () => {
  assert.equal(buildReplacementToolOutput({ tool_response: { filenames: [] } }, 'S').ok, false);
  assert.equal(buildReplacementToolOutput({ tool_response: { filenames: [123] } }, 'S').ok, false);
});

test('Grep files_with_matches array shape: replaces filenames, updates numFiles, and records savings', () => {
  const ws = makeWorkspace();
  try {
    const filenames = Array.from({ length: 30 }, (_, i) =>
      i < 22 ? `src/core/module_${String(i).padStart(2, '0')}.mjs` : `archive/legacy_${i}.mjs`
    );
    const res = runPostToolUseHook(
      {
        session_id: 'grep-arr-1',
        cwd: ws.dir,
        tool_name: 'Grep',
        tool_input: { pattern: 'handleToken', output_mode: 'files_with_matches' },
        tool_response: { mode: 'files_with_matches', filenames, numFiles: 30, totalFiles: 30 }
      },
      { cwd: ws.dir }
    );
    assert.equal(res.exitCode, 0);
    const hso = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal('additionalContext' in hso, false);
    assert.ok(Array.isArray(hso.updatedToolOutput.filenames));
    assert.ok(hso.updatedToolOutput.filenames.every((x) => typeof x === 'string'));
    assert.ok(hso.updatedToolOutput.filenames.length < filenames.length);
    assert.ok(hso.updatedToolOutput.numFiles <= 8 && hso.updatedToolOutput.numFiles > 0);
    const ledger = readLedger(ws.dir);
    assert.ok(ledger.length >= 1 && ledger.some((e) => e.savedTokens > 0));
  } finally {
    ws.cleanup();
  }
});

test('Glob array shape: replaces filenames, sets truncated=true, updates numFiles, and records savings', () => {
  const ws = makeWorkspace();
  try {
    const filenames = Array.from({ length: 30 }, (_, i) => `src/components/feature_${String(i).padStart(2, '0')}.mjs`);
    const res = runPostToolUseHook(
      {
        session_id: 'glob-arr-1',
        cwd: ws.dir,
        tool_name: 'Glob',
        tool_input: { pattern: 'src/**/*.mjs' },
        tool_response: {
          filenames,
          durationMs: 42,
          numFiles: 30,
          truncated: false,
          totalMatches: 30,
          countIsComplete: true
        }
      },
      { cwd: ws.dir }
    );
    assert.equal(res.exitCode, 0);
    const hso = JSON.parse(res.stdout).hookSpecificOutput;
    assert.ok(Array.isArray(hso.updatedToolOutput.filenames));
    assert.ok(hso.updatedToolOutput.filenames.length < filenames.length);
    assert.equal(hso.updatedToolOutput.truncated, true);
    assert.equal(hso.updatedToolOutput.countIsComplete, true);
    assert.ok(hso.updatedToolOutput.numFiles <= 8 && hso.updatedToolOutput.numFiles > 0);
    const ledger = readLedger(ws.dir);
    assert.ok(ledger.length >= 1 && ledger.some((e) => e.savedTokens > 0));
  } finally {
    ws.cleanup();
  }
});

test('Grep content shape: replaces content string and updates numLines', () => {
  const ws = makeWorkspace();
  try {
    const contentLines = [];
    for (let f = 0; f < 25; f += 1) {
      for (let ln = 1; ln <= 12; ln += 1) {
        contentLines.push(`src/mod_${String(f).padStart(2, '0')}.mjs:${ln}:export const matchToken_${f}_${ln} = true;`);
      }
    }
    const contentStr = contentLines.join('\n');
    const res = runPostToolUseHook(
      {
        session_id: 'grep-content-1',
        cwd: ws.dir,
        tool_name: 'Grep',
        tool_input: { pattern: 'matchToken', output_mode: 'content' },
        tool_response: { mode: 'content', content: contentStr, filenames: [], numLines: 300, totalLines: 300 }
      },
      { cwd: ws.dir }
    );
    assert.equal(res.exitCode, 0);
    const hso = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal(typeof hso.updatedToolOutput.content, 'string');
    assert.ok(hso.updatedToolOutput.content.length < contentStr.length);
    assert.ok(hso.updatedToolOutput.numLines > 0 && hso.updatedToolOutput.numLines < 300);
    const ledger = readLedger(ws.dir);
    assert.ok(ledger.length >= 1 && ledger.some((e) => e.savedTokens > 0));
  } finally {
    ws.cleanup();
  }
});

test('PostToolUse matchers across CLI installer, Shield sync, and A/B harness include Grep|Glob and exclude Read', async () => {
  const ws = makeWorkspace();
  try {
    const { LEAN_POST_TOOL_USE_MATCHER, POST_TOOL_USE_MATCHER } = await import('../../bin/ctxtop.mjs');
    const { syncClaudeShieldHooks } = await import('../../src/core/shield_manager.mjs');
    const { buildSettingsPayload } = await import('../../experiments/model-switch-benchmark/cost_per_task/run_highbeam_ab.mjs');

    const shieldRes = syncClaudeShieldHooks({ mode: 'enable', cwd: ws.dir });
    const shieldMatcher = shieldRes.document.hooks.PostToolUse[0].matcher;
    const abSettings = buildSettingsPayload('HIGHBEAM', ws.dir);
    const abMatcher = abSettings.hooks.PostToolUse[0].matcher;

    for (const [label, matcher] of [
      ['LEAN_POST_TOOL_USE_MATCHER', LEAN_POST_TOOL_USE_MATCHER],
      ['POST_TOOL_USE_MATCHER', POST_TOOL_USE_MATCHER],
      ['syncClaudeShieldHooks', shieldMatcher],
      ['buildSettingsPayload', abMatcher]
    ]) {
      const rx = new RegExp(`^(?:${matcher})$`);
      assert.equal(rx.test('Grep'), true, `${label} must match Grep`);
      assert.equal(rx.test('Glob'), true, `${label} must match Glob`);
      assert.equal(rx.test('Bash'), true, `${label} must match Bash`);
      assert.equal(rx.test('Read'), false, `${label} must never match Read`);
    }
  } finally {
    ws.cleanup();
  }
});
