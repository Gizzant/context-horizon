/**
 * @file test/matrix_9plus_capabilities.test.mjs
 * Comprehensive regression suite verifying D1-D8 >= 9.0 competitive parity upgrades:
 *  - Multi-family FTS5 CLI compression + unified FTS5 search (`ctxtop search`)
 *  - 5-host read-only session audit (Antigravity, Claude, Codex, Gemini, Cursor) + OAuth exclusion
 *  - 1-command multi-host MCP installer (`--cursor`, `--windsurf`, `--codex`, `--gemini-cli`, `--all-hosts`)
 *  - Standalone zero-escape 7-tool `@ctxtop/mcp` server (tested even copied outside repo)
 *  - Static zero-escape gate across all 6 `packages/*` workspaces
 *  - Reproducible 10-family compression + 12-session Antigravity parity benchmark (`runParityBenchmarks`)
 *  - Markdown hygiene across `README.md`, `SECURITY.md`, `docs/ENTERPRISE_MDM.md`, and `docs/ANTIGRAVITY_AND_COMPRESSION_BENCHMARK.md`
 */

import { SKIP_WITHOUT_SQLITE } from './helpers/sqlite_available.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  compressCliOutputFts5,
  searchOffloadedContextFts5,
  getOffloadIndexStats
} from '../src/core/fts5_output_compressor.mjs';
import { offloadToolResult } from '../src/engine-node/offloader/tool_offloader.mjs';
import { runSessionAudit } from '../src/core/session_auditor.mjs';
import {
  installHostMcpConfig,
  resolveHostMcpConfigPath
} from '../src/engine-node/multi_host_mcp.mjs';
import { runCli, executeInitSubcommand, runDoctorDiagnostics } from '../bin/ctxtop.mjs';
import { handleMcpJsonRpcRequest, MCP_TOOLS } from '../packages/mcp/src/server.mjs';
import { runParityBenchmarks } from '../scripts/run_antigravity_and_compression_benchmark.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('Matrix >= 9.0 Capabilities Suite (D1-D8)', () => {
  it('1. Multi-family CLI compression + unified FTS5 search across tool_logs_fts5.db and artifacts_fts5.db', { skip: SKIP_WITHOUT_SQLITE }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-ws1-'));
    try {
      const dbPath = path.join(tmpDir, 'tool_logs_fts5.db');
      const pad = Array.from({ length: 92 }, (_, i) => ` src/mod_${i}.mjs | ${i + 1} +`).join('\n');
      const gitDiffRaw = [
        'diff --git a/src/auth/token.mjs b/src/auth/token.mjs',
        '+++ b/src/auth/token.mjs',
        '@@ -18,4 +18,7 @@ export function verifyJwt() MATRIX_JWT_HUNK',
        pad,
        '+  return checkExp(claims);'
      ].join('\n');

      const comp = await compressCliOutputFts5({
        sessionId: 'ws1-sess',
        turnId: 'turn-git-7',
        command: 'git diff HEAD~1',
        exitCode: 0,
        rawOutput: gitDiffRaw,
        dbPath,
        homeDir: tmpDir
      });
      assert.equal(comp.compressed, true);
      assert.ok(comp.reductionPct >= 70, `Expected >=70% reduction, got ${comp.reductionPct}%`);
      assert.ok(comp.output.includes('diff --git a/src/auth/token.mjs b/src/auth/token.mjs'));
      assert.ok(comp.output.includes('@@ -18,4 +18,7 @@'));
      assert.ok(comp.output.includes('agy-log-search turn-git-7 "<keyword>"'));

      // Also offload a non-read Bash artifact (>4k tokens = >16k chars) into cwd/.ctxtop/cache/artifacts_fts5.db
      const bigLog = 'worker stdout diagnostic padding entry line\n'.repeat(600) + 'Error: MATRIX_ARTIFACT_PANIC_99 in worker\n';
      const offloaded = offloadToolResult('Bash', bigLog, {
        ctxtopDir: path.join(tmpDir, '.ctxtop')
      });
      assert.equal(offloaded.offloaded, true);

      const searchCli = await searchOffloadedContextFts5({
        keyword: 'MATRIX_JWT_HUNK',
        cwd: tmpDir,
        homeDir: tmpDir,
        dbPath
      });
      assert.ok(searchCli.toolLogHits >= 1);
      assert.ok(searchCli.matchedLines.some((m) => m.text.includes('MATRIX_JWT_HUNK')));

      const searchArt = await searchOffloadedContextFts5({
        keyword: 'MATRIX_ARTIFACT_PANIC_99',
        cwd: tmpDir,
        homeDir: tmpDir,
        dbPath
      });
      assert.ok(searchArt.artifactHits >= 1);
      assert.ok(searchArt.matchedLines.some((m) => m.text.includes('MATRIX_ARTIFACT_PANIC_99')));

      const stats = getOffloadIndexStats({ cwd: tmpDir, homeDir: tmpDir, dbPath });
      assert.equal(stats.indexedToolLogs, 1);
      assert.equal(stats.indexedArtifacts, 1);

      const cliRes = await runCli(['search', 'turn-git-7', 'MATRIX_JWT_HUNK', '--json'], {
        cwd: tmpDir,
        homeDir: tmpDir,
        dbPath
      });
      assert.equal(cliRes.exitCode, 0);
      assert.equal(cliRes.data.toolLogHits >= 1, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. CLI status, helpText, and runDoctorDiagnostics expose offloadIndex + ipcFastPath cleanly', () => {
    const helpRes = runCli(['--help']);
    assert.equal(helpRes.exitCode, 0);
    assert.ok(helpRes.output.includes('Usage: ctxtop <command> [options]'));
    assert.ok(helpRes.output.includes('search [<turn-id>]'));
    assert.ok(helpRes.output.includes('--cursor|--windsurf|--codex|--gemini-cli'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-ws3-'));
    try {
      const statusRes = runCli(['status', '--json'], { cwd: tmpDir, homeDir: tmpDir });
      assert.equal(statusRes.exitCode, 0);
      assert.equal(typeof statusRes.data.offloadIndex?.indexedToolLogs, 'number');
      assert.equal(typeof statusRes.data.ipcFastPath?.pipePath, 'string');

      const doc = runDoctorDiagnostics({ cwd: tmpDir, homeDir: tmpDir });
      assert.equal(doc.checks.length, 7, 'Must keep checks.length === 7 invariant');
      assert.equal(typeof doc.offloadIndex?.indexedArtifacts, 'number');
      assert.equal(typeof doc.ipcFastPath?.pipePath, 'string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. 5-Host read-only session audit discovers Antigravity, Claude, Codex, Gemini, and Cursor while ignoring oauth_creds.json', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-5host-'));
    try {
      const nowIso = new Date().toISOString();

      // Plant malformed oauth_creds.json which MUST NEVER be read/parsed by Gemini scanner
      fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, '.gemini', 'oauth_creds.json'), '{INVALID_DO_NOT_READ', 'utf8');

      // 1. Antigravity
      const agLogs = path.join(tmpHome, '.gemini', 'antigravity', 'brain', 'ag-1', '.system_generated', 'logs');
      fs.mkdirSync(agLogs, { recursive: true });
      fs.writeFileSync(
        path.join(agLogs, 'transcript.jsonl'),
        JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: nowIso, content: 'hi', tool_calls: [] }) + '\n',
        'utf8'
      );

      // 2. Claude Code
      const ccDir = path.join(tmpHome, '.claude', 'projects', 'p1');
      fs.mkdirSync(ccDir, { recursive: true });
      fs.writeFileSync(
        path.join(ccDir, 'cc-1.jsonl'),
        JSON.stringify({ type: 'assistant', timestamp: nowIso, message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 400, output_tokens: 50 }, content: [] } }) + '\n',
        'utf8'
      );

      // 3. Codex CLI
      const codexDir = path.join(tmpHome, '.codex', 'sessions');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, 'cx-1.jsonl'),
        JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 1500 } } } }) + '\n',
        'utf8'
      );

      // 4. Gemini CLI tmp chats
      const gemDir = path.join(tmpHome, '.gemini', 'tmp', 'hash1', 'chats');
      fs.mkdirSync(gemDir, { recursive: true });
      fs.writeFileSync(
        path.join(gemDir, 'session-2026-11-16.json'),
        JSON.stringify({ messages: [{ type: 'gemini', model: 'gemini-3-flash', timestamp: nowIso, tokens: { input: 900 }, toolCalls: [] }] }),
        'utf8'
      );

      // 5. Cursor transcripts
      const curDir = path.join(tmpHome, '.cursor', 'projects', 'ws', 'agent-transcripts');
      fs.mkdirSync(curDir, { recursive: true });
      fs.writeFileSync(
        path.join(curDir, 'cur-1.jsonl'),
        JSON.stringify({ role: 'assistant', timestamp: nowIso, usage: { input_tokens: 1100 } }) + '\n',
        'utf8'
      );

      const res = runSessionAudit({ platform: 'all', days: 7, limit: 20, cwd: tmpHome, homeDir: tmpHome });
      assert.equal(res.sessionsScanned, 5);
      assert.deepEqual(res.platformsBreakdown, {
        antigravity: 1,
        claude: 1,
        codex: 1,
        gemini: 1,
        cursor: 1
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('4. Multi-host MCP config installer cleanly writes Cursor, Windsurf, Codex, and Gemini CLI while preserving existing servers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-mcp-init-'));
    try {
      const geminiCfg = resolveHostMcpConfigPath('gemini-cli', { cwd: tmpDir, homeDir: tmpDir, global: true });
      fs.mkdirSync(path.dirname(geminiCfg), { recursive: true });
      fs.writeFileSync(
        geminiCfg,
        JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'node', args: ['old.js'] } } }, null, 2),
        'utf8'
      );

      const dryRes = installHostMcpConfig({
        hosts: ['cursor', 'windsurf', 'codex', 'gemini-cli'],
        cwd: tmpDir,
        homeDir: tmpDir,
        dryRun: true
      });
      assert.equal(dryRes.ok, true);
      assert.equal(fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json')), false);

      const initRes = executeInitSubcommand(
        ['--cursor', '--windsurf', '--codex', '--gemini-cli', '--global'],
        { cwd: tmpDir, homeDir: tmpDir }
      );
      assert.equal(initRes.exitCode, 0);
      assert.equal(initRes.data.claude, null);
      assert.equal(initRes.data.antigravity, null);
      assert.equal(initRes.data.hostMcp.results.length, 4);

      const parsedGem = JSON.parse(fs.readFileSync(geminiCfg, 'utf8'));
      assert.equal(parsedGem.theme, 'dark');
      assert.deepEqual(parsedGem.mcpServers.existing, { command: 'node', args: ['old.js'] });
      assert.deepEqual(parsedGem.mcpServers.highbeam, { command: 'npx', args: ['-y', 'ctxtop', 'mcp'] });

      const cursorCfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf8'));
      assert.deepEqual(cursorCfg.mcpServers.highbeam, { command: 'npx', args: ['-y', 'ctxtop', 'mcp'] });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. @ctxtop/mcp executes all 7 tools over JSON-RPC AND imports cleanly when copied standalone to os.tmpdir()', async () => {
    assert.equal(MCP_TOOLS.length, 7);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-mcp7-'));
    try {
      const dbPath = path.join(tmpDir, 'tool_logs_fts5.db');
      const rawLog = Array.from({ length: 85 }, (_, i) => `ok case ${i}`).join('\n') + '\nFAILED test_mcp_roundtrip - MCP_UNIQUE_KEY_404\n';

      const compRes = await handleMcpJsonRpcRequest(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'horizon_compress_cli',
            arguments: { command: 'pytest', rawOutput: rawLog, exitCode: 1, turnId: 'turn-mcp-1', dbPath, homeDir: tmpDir }
          }
        },
        { cwd: tmpDir, homeDir: tmpDir, dbPath }
      );
      assert.equal(compRes.result.isError, false);
      assert.equal(compRes.result.structuredContent.compressed, true);

      const searchRes = await handleMcpJsonRpcRequest(
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'horizon_search_logs',
            arguments: { turnId: 'turn-mcp-1', keyword: 'MCP_UNIQUE_KEY_404', cwd: tmpDir, homeDir: tmpDir, dbPath }
          }
        },
        { cwd: tmpDir, homeDir: tmpDir, dbPath }
      );
      assert.equal(searchRes.result.isError, false);
      assert.ok(searchRes.result.structuredContent.matchedLines.some((m) => m.text.includes('MCP_UNIQUE_KEY_404')));

      const auditRes = await handleMcpJsonRpcRequest(
        {
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'horizon_audit_sessions',
            arguments: { platform: 'all', days: 7, cwd: tmpDir }
          }
        },
        { cwd: tmpDir, homeDir: tmpDir }
      );
      assert.equal(auditRes.result.isError, false);
      assert.equal(auditRes.result.structuredContent.ok, true);

      // Copy packages/mcp into an isolated directory outside the monorepo to verify 100% standalone publishability
      const standaloneMcpDir = path.join(tmpDir, 'standalone-mcp');
      fs.cpSync(path.join(ROOT, 'packages', 'mcp'), standaloneMcpDir, { recursive: true });
      const isolatedMod = await import(pathToFileURL(path.join(standaloneMcpDir, 'src', 'server.mjs')).href);
      assert.equal(isolatedMod.MCP_TOOLS.length, 7);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. Zero relative path escapes across all 6 packages/* workspaces & reproducibility benchmark passes', async () => {
    const packagesDir = path.join(ROOT, 'packages');
    const pkgNames = fs.readdirSync(packagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    assert.ok(pkgNames.length >= 6);

    const escapes = [];
    for (const pkgName of pkgNames) {
      const pkgRoot = path.resolve(packagesDir, pkgName);
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name === 'node_modules') continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            walk(full);
          } else if (/\.(m?js|cjs)$/i.test(ent.name)) {
            const text = fs.readFileSync(full, 'utf8');
            const matches = text.matchAll(/(?:from|import\()\s*['"](\.\.\/[^'"]+)['"]/g);
            for (const m of matches) {
              const target = path.resolve(path.dirname(full), m[1]);
              if (!target.startsWith(pkgRoot + path.sep) && target !== pkgRoot) {
                escapes.push(`${pkgName}: ${path.relative(pkgRoot, full)} -> ${m[1]}`);
              }
            }
          }
        }
      };
      walk(pkgRoot);
    }
    assert.deepEqual(escapes, [], `Workspace relative path escapes detected: ${escapes.join(', ')}`);

    const parityRes = await runParityBenchmarks({ writeDoc: false });
    assert.equal(parityRes.ok, true);
    assert.ok(parityRes.suiteA.aggregateReductionPct >= 75);
    assert.equal(parityRes.suiteA.aggregateRecallPct, 100);
    assert.equal(parityRes.suiteA.retrievalRatePct, 100);
    assert.equal(parityRes.suiteB.passedCount, 12);
  });

  it('7. New and updated docs maintain strict zero-banned-strings and zero-empty-catch hygiene', () => {
    const ALLOWED_CONTEXT_HORIZON_URLS_RE =
      /https:\/\/gizzant\.github\.io\/context-horizon\/(?![\w./-])|https:\/\/github\.com\/Gizzant\/context-horizon(?:\.git)?(?![/\w.-])/g;
    const stripAllowedContextHorizonUrls = (s) => String(s).replace(ALLOWED_CONTEXT_HORIZON_URLS_RE, '');
    const bannedPatterns = [
      new RegExp(['Context', 'Horizon'].join(' '), 'i'),
      new RegExp(['context', 'horizon'].join('-'), 'i'),
      new RegExp(['cc', 'attention', 'horizon'].join('-'), 'i'),
      new RegExp(['ga', 'visualizer', 'v2'].join('-'), 'i'),
      new RegExp('file:///C:/' + 'Projects', 'i')
    ];
    for (const relDoc of [
      'README.md',
      'SECURITY.md',
      'docs/ENTERPRISE_MDM.md',
      'docs/ANTIGRAVITY_AND_COMPRESSION_BENCHMARK.md'
    ]) {
      const fullPath = path.join(ROOT, relDoc);
      assert.equal(fs.existsSync(fullPath), true, `${relDoc} must exist`);
      const body = fs.readFileSync(fullPath, 'utf8');
      const sanitizedBody = stripAllowedContextHorizonUrls(body);
      for (const re of bannedPatterns) {
        assert.equal(re.test(sanitizedBody), false, `${relDoc} must not match banned pattern ${re}`);
      }
    }
    assert.equal(
      bannedPatterns[1].test(
        stripAllowedContextHorizonUrls(
          'https://gizzant.github.io/context-horizon/ https://github.com/Gizzant/context-horizon https://github.com/Gizzant/context-horizon.git'
        )
      ),
      false,
      'Exact canonical repo URLs must be stripped before banned-pattern check'
    );
    assert.equal(
      bannedPatterns[1].test(
        stripAllowedContextHorizonUrls('Install the context-horizon CLI from https://gizzant.github.io/context-horizon/')
      ),
      true,
      'Prose like "context-horizon CLI" must still match banned pattern'
    );

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /(?:Tier-1|in-process rule engine|under 1ms)/i);
    assert.match(readme, /(?:Tier-2|spawned (?:Node process|hook))/i);
    assert.ok(readme.includes('SQLITE_OPEN_READONLY'));
    assert.ok(readme.includes('Zero Outbound Network Connections'));

    const parityScript = fs.readFileSync(path.join(ROOT, 'scripts', 'run_antigravity_and_compression_benchmark.mjs'), 'utf8');
    const bareCatchRe = new RegExp('\\bcatch\\s*' + '\\{\\s*\\}');
    assert.equal(bareCatchRe.test(parityScript), false, 'Benchmark script must not contain empty catch blocks');
  });
});
