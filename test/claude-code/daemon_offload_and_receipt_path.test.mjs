/**
 * @file test/claude-code/daemon_offload_and_receipt_path.test.mjs
 * Regressions from the Windows real-session run (fix list #3/#4/#15):
 *   1. PostToolUse routed through the warm daemon (Antigravity's horizon-daemon) must still
 *      write the artifact and ledger line. The daemon never imported a Tier-2 entrypoint,
 *      so the Node I/O adapter was missing and every disk write returned false.
 *   2. `ctxtop receipt` run from a project must read <project>/.claude/cache/horizon_ledger.jsonl,
 *      which is where the hooks write it.
 *
 * Deliberately does NOT import src/utils/nodeIo.mjs: the bridge must register it itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-daemon-offload-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('daemon bridge: hook.claude.postToolUse offloads and records savings without the CLI entrypoint', async () => {
  const { registerDaemonHookRpcMethods } = await import('../../src/hooks/daemon_hook_bridge.mjs');
  const methods = new Map();
  registerDaemonHookRpcMethods({ registerMethod: (name, fn) => methods.set(name, fn) });
  const post = methods.get('hook.claude.postToolUse');
  assert.equal(typeof post, 'function');

  const ws = makeWorkspace();
  try {
    const stdout = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
    const res = await post({
      event: {
        session_id: 'daemon-offload-1',
        cwd: ws.dir,
        tool_name: 'PowerShell',
        tool_input: { command: '1..3000 | % { "line $_" }' },
        tool_response: { stdout, stderr: '', interrupted: false, isImage: false }
      }
    });
    assert.equal(res.exitCode, 0);
    const hso = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal(typeof hso.updatedToolOutput, 'object');
    assert.ok(hso.updatedToolOutput.stdout.length < stdout.length / 10, 'output must be replaced, not echoed');

    const artifacts = path.join(ws.dir, '.claude', 'cache', 'artifacts');
    assert.ok(fs.existsSync(artifacts), 'artifact dir written');
    assert.ok(fs.readdirSync(artifacts).some((f) => /^ah_[0-9a-f]+\.txt$/.test(f)), 'artifact file written');

    const ledger = path.join(ws.dir, '.claude', 'cache', 'horizon_ledger.jsonl');
    assert.ok(fs.existsSync(ledger), 'ledger written');
    const entries = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(entries.length >= 1 && entries.every((e) => e.savedTokens > 0));
  } finally {
    ws.cleanup();
  }
});

test('ctxtop receipt from a project reads the project ledger', async () => {
  const { runCli } = await import('../../bin/ctxtop.mjs');
  const ws = makeWorkspace();
  const prevCwd = process.cwd();
  try {
    const cache = path.join(ws.dir, '.claude', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(
      path.join(cache, 'horizon_ledger.jsonl'),
      [
        { timestamp: ts, sessionId: 's1', savedTokens: 7337, savedUSD: 0.014674, category: 'ARTIFACT_OFFLOAD_4K' },
        { timestamp: ts, sessionId: 's1', savedTokens: 5885, savedUSD: 0.01177, category: 'ARTIFACT_OFFLOAD_4K' }
      ].map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
    process.chdir(ws.dir);
    const res = await runCli(['receipt', '--json']);
    assert.equal(res.exitCode, 0);
    const text = res.output;
    assert.doesNotMatch(text, /"entryCount":\s*0\b/);
    assert.match(text, /13,?222|13222/, 'total of both ledger entries appears in the receipt');
  } finally {
    process.chdir(prevCwd);
    ws.cleanup();
  }
});
