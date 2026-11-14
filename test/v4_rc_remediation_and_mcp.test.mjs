import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { readSidecarSync } from '../src/core/sidecar_store.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';
import { PRO_PRICING_TIERS, PLG_TIER_MATRIX } from '../src/core/pro_license.mjs';
import { buildHooksConfig, ULTRA_LEAN_PRE_TOOL_HOOK_MATCHER } from '../src/cli/init.mjs';
import {
  evaluateGlobalPromotionEligibility,
  ReflectorQueue
} from '../src/core/coach/reflector_queue.mjs';
import { handleMcpJsonRpcRequest, MCP_TOOLS } from '../packages/mcp/src/server.mjs';
import { generateCorporateExpenseReceipt } from '../src/core-isomorphic/ui/pdfReceiptGenerator.mjs';
import { executeInitSubcommand } from '../bin/ctxtop.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('v4.0 RC Remediation & @ctxtop/mcp Regression Suite', () => {
  it('Component 1: Antigravity handlePreToolUse records savings in sidecar without leaking .claude/cache', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-agy-iso-'));
    const origCwd = process.cwd();
    try {
      const targetFile = path.join(tmpDir, 'worker.mjs');
      const filler = Array.from({ length: 65 }, (_, i) => `  const line${i} = ${i};`).join('\n');
      fs.writeFileSync(
        targetFile,
        `export function runWorkerTask(input) {\n${filler}\n  return input;\n}\n`,
        'utf8'
      );

      const convId = `remediation-agy-iso-${Date.now()}`;
      const res3 = await handlePreToolUse({
        conversationId: convId,
        workspacePath: tmpDir,
        toolName: 'read_file',
        toolInput: { Path: targetFile },
        priorUnclippedReads: 2
      });

      assert.equal(res3.decision, 'allow');
      assert.ok(res3.savedTokens > 0, '3rd unclipped read_file must save tokens via AST stub');
      assert.equal(fs.existsSync(path.join(tmpDir, '.claude')), false, 'Must never create .claude directory inside Antigravity workspace');

      const sidecar = readSidecarSync(convId);
      assert.ok(Number(sidecar?.telemetry?.savedTokens || 0) >= res3.savedTokens, 'Sidecar telemetry must record savedTokens');
      assert.equal(sidecar?.telemetry?.boundedReadInterventions >= 1, true);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Component 2: .gitattributes pins LF and syncAndVerifyMirrors passes CRLF-resilient SHA-256 parity', () => {
    const gitattrsPath = path.join(ROOT, '.gitattributes');
    assert.equal(fs.existsSync(gitattrsPath), true, '.gitattributes must exist at repo root');
    const gitattrs = fs.readFileSync(gitattrsPath, 'utf8');
    assert.match(gitattrs, /\*\s+text=auto\s+eol=lf/);
    assert.match(gitattrs, /\*\.mjs\s+text\s+eol=lf/);

    const parity = syncAndVerifyMirrors({ verifyOnly: true });
    assert.equal(parity.parityOk, true);
    assert.equal(parity.targets, 8);
    assert.equal(parity.verifiedFilePairs, 729);
  });

  it('Component 3: package.json URLs point to Gizzant/context-horizon, pricing tiers match, and signing docs exist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.repository.url, 'git+https://github.com/Gizzant/context-horizon.git');
    assert.equal(pkg.homepage, 'https://gizzant.github.io/context-horizon/');
    assert.equal(pkg.bugs.url, 'https://github.com/Gizzant/context-horizon/issues');
    assert.equal(pkg.license, 'MIT');
    assert.ok(Array.isArray(pkg.workspaces) && pkg.workspaces.includes('packages/mcp'));

    assert.equal(PRO_PRICING_TIERS.pro_monthly.priceUSD, PLG_TIER_MATRIX.pro.priceMonthlyUSD);
    assert.equal(PRO_PRICING_TIERS.pro_monthly.priceUSD, 15);
    assert.equal(PRO_PRICING_TIERS.team.seatMonthlyUSD, PLG_TIER_MATRIX.team.pricePerSeatMonthlyUSD);

    const signingDoc = fs.readFileSync(path.join(ROOT, 'packages', 'pro', 'README-SIGNING.md'), 'utf8');
    assert.match(signingDoc, /CTXTOP_ED25519_PUBLIC_KEY_PEM/);
    assert.match(signingDoc, /CTXTOP_ED25519_PRIVATE_KEY_PEM/);
  });

  it('Component 4: Antigravity --lean-hooks omits read_file/view_file, Drawer 1 labels polished, and single-repo userConfirmed graduation works', () => {
    const leanCfg = buildHooksConfig('.', { leanHooks: true });
    const leanPreMatcher = leanCfg.hooks.PreToolUse[0].matcher;
    assert.equal(leanPreMatcher, ULTRA_LEAN_PRE_TOOL_HOOK_MATCHER);
    assert.equal(/\b(read_file|view_file)\b/.test(leanPreMatcher), false);

    const panelHtml = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
    assert.ok(
      panelHtml.includes('id="tufteScaleTickTrough" style="left:36%;transform:translateX(-50%);">Mid-Window (Lowest Recall)</span>'),
      'Drawer 1 must replace internal "trough" text with user-facing Mid-Window label'
    );
    assert.ok(
      panelHtml.includes('id="playbookSub">Context Consumers</span>'),
      'Drawer 1 must replace "Transcript Forensics" initial pill with Context Consumers'
    );

    const singleRepoRows = [
      { id: 'inst-1', domain: 'testing', directive_action: 'Run verify after mirror edits', confidence: 0.9, project_hash: 'repoA' }
    ];
    assert.equal(evaluateGlobalPromotionEligibility(singleRepoRows).length, 0);
    const confirmed = evaluateGlobalPromotionEligibility(singleRepoRows, { userConfirmed: true });
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].promotedViaUserConfirmation, true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-reflector-optin-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.attention-horizon.json'), JSON.stringify({ minReposForGlobalPromotion: 1 }), 'utf8');
      const q = new ReflectorQueue({ workspaceDir: tmpDir });
      q.enqueue({ domain: 'testing', directive_action: 'Always check CHECKSUMS.sha256', confidence: 0.92 });
      const candidates = q.getGlobalPromotionCandidates();
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].distinctRepoCount, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Component 5: @ctxtop/mcp JSON-RPC server lists and executes all 4 local zero-network tools', async () => {
    const initRes = await handleMcpJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' }
    });
    assert.equal(initRes.result.serverInfo.name, '@ctxtop/mcp');

    const listRes = await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listRes.result.tools.length, MCP_TOOLS.length);
    assert.deepEqual(
      listRes.result.tools.map((t) => t.name),
      ['horizon_status', 'cache_gravity_check', 'scope_lock_claim', 'export_receipt_pdf']
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-mcp-test-'));
    try {
      const statusRes = await handleMcpJsonRpcRequest(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'horizon_status', arguments: { cwd: tmpDir, sessionId: 'mcp-sess-1' } }
        },
        { cwd: tmpDir, homeDir: tmpDir }
      );
      assert.equal(statusRes.result.isError, false);
      assert.equal(statusRes.result.structuredContent.ok, true);

      const gravRes = await handleMcpJsonRpcRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'cache_gravity_check',
          arguments: {
            currentModel: 'claude-opus-5-5',
            targetModel: 'claude-sonnet-5-5',
            cachedTokens: 120000,
            ttlRemainingSeconds: 240,
            remainingExpectedTurns: 4
          }
        }
      });
      assert.equal(gravRes.result.isError, false);
      assert.equal(typeof gravRes.result.structuredContent.shouldHoldWarmCache, 'boolean');

      const lockRes = await handleMcpJsonRpcRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'scope_lock_claim',
          arguments: {
            workspaceDir: tmpDir,
            sessionId: 'cursor-agent-1',
            agentId: 'cursor',
            paths: ['packages/mcp/src/server.mjs']
          }
        }
      });
      assert.equal(lockRes.result.isError, false);
      assert.equal(lockRes.result.structuredContent.ok, true);

      const pdfOut = path.join(tmpDir, 'receipt.pdf');
      const receiptRes = await handleMcpJsonRpcRequest(
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'export_receipt_pdf',
            arguments: { cwd: tmpDir, outPath: pdfOut, allowPreview: true }
          }
        },
        { cwd: tmpDir, homeDir: tmpDir }
      );
      assert.equal(receiptRes.result.isError, false);
      assert.ok(receiptRes.result.structuredContent.pdfByteLength > 500);
      assert.equal(fs.existsSync(pdfOut), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Follow-up #1 & #2: pdfReceiptGenerator defaults to $15.00/mo, root bin exposes ah-mcp/ctxtop-mcp, and init --mcp merges .cursor/mcp.json', () => {
    const rcpt = generateCorporateExpenseReceipt({
      workspace30dSavedUSD: 45,
      sessionSavedUSD: 15
    });
    assert.equal(rcpt.netRoiMultiplier, 3);
    assert.match(rcpt.markdown, /Highbeam Pro \(\$15\.00\/mo\)/);
    assert.match(rcpt.markdown, /\$15\.00 USD/);
    assert.doesNotMatch(rcpt.markdown, /\$9\.00/);
    assert.doesNotMatch(rcpt.html, /\$9\.00/);
    const pdfText = Buffer.from(rcpt.pdfBytes).toString('utf8');
    assert.ok(pdfText.includes('$15.00/mo License'));
    assert.equal(pdfText.includes('$9.00'), false);

    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(rootPkg.bin['ah-mcp'], 'packages/mcp/src/server.mjs');
    assert.equal(rootPkg.bin['ctxtop-mcp'], 'packages/mcp/src/server.mjs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-init-mcp-'));
    try {
      const mcpJsonPath = path.join(tmpDir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
      fs.writeFileSync(
        mcpJsonPath,
        JSON.stringify({ mcpServers: { 'other-tool': { command: 'npx', args: ['-y', 'other'] } } }, null, 2),
        'utf8'
      );

      const res = executeInitSubcommand(['--mcp'], { cwd: tmpDir });
      assert.equal(res.exitCode, 0);
      assert.equal(res.data.mcp?.ok, true);
      assert.equal(res.data.claude, null);
      assert.equal(res.data.antigravity, null);

      const written = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      assert.deepEqual(written.mcpServers['other-tool'], { command: 'npx', args: ['-y', 'other'] });
      assert.equal(written.mcpServers['attention-horizon'].command, 'node');
      assert.match(written.mcpServers['attention-horizon'].args[0], /packages\/mcp\/src\/server\.mjs$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Follow-up #3: circuitBreakers.mjs modular split into 4 <1,250L guard modules preserves 100% export parity and Mod Law 4', async () => {
    const guardsDir = path.join(ROOT, 'src', 'core-isomorphic', 'guards');
    const files = [
      'det01_03_shell_secret.mjs',
      'det04_12_thrash_rot.mjs',
      'det13_20_mcp_scope.mjs',
      'circuitBreakers.mjs'
    ];
    for (const file of files) {
      const fullPath = path.join(guardsDir, file);
      assert.equal(fs.existsSync(fullPath), true, `${file} must exist`);
      const content = fs.readFileSync(fullPath, 'utf8');
      const lineCount = content.split('\n').length;
      assert.ok(lineCount < 1250, `${file} must be < 1,250 lines (got ${lineCount})`);
      assert.equal(/['"]node:[^'"]+['"]/.test(content), false, `${file} must contain zero node:* imports`);
    }

    const cbMod = await import('../src/core-isomorphic/guards/circuitBreakers.mjs');
    const namedExports = Object.keys(cbMod).filter((k) => k !== 'default');
    assert.equal(namedExports.length, 29, 'circuitBreakers.mjs must preserve all 29 named exports');
    for (const key of namedExports) {
      assert.equal(typeof cbMod[key], 'function', `Named export ${key} must be a function/class`);
    }
    const defaultKeys = Object.keys(cbMod.default || {});
    assert.equal(defaultKeys.length, 27, 'circuitBreakers.mjs default export must preserve all 27 keys');
    for (const key of defaultKeys) {
      assert.equal(typeof cbMod.default[key], 'function', `Default export ${key} must be a function/class`);
    }
  });
});
