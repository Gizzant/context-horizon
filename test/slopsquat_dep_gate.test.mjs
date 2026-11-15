/**
 * @file test/slopsquat_dep_gate.test.mjs
 * Bucket B Sub-Wave B-Alpha — Guardrail #6 (`SLOPSQUAT_DEP_GATE`) Simulation & SLA Suite.
 *
 * Corpus (60 commands):
 * - 20 real slopsquats, LLM conflations, affix hallucinations, & Phase 2 404/low-reputation packages
 * - 15 private `@corp/*` / `@acme/*` `.npmrc` scopes & custom `--registry` / `--index-url` installs
 * - 10 `workspace:*` / `file:` / lockfile-sync (`npm ci`, `pip install -r requirements.txt`) installs
 * - 15 offline / `1.5s`-timeout registry metadata fault cases (`0%` false-deny invariant)
 *
 * Promotion SLA:
 * - `0%` false-deny (`falseDenies === 0`) on offline, private-scope, or workspace deps
 * - `FPR === 0` (`0%` false triggers on benign private/workspace/offline commands)
 * - Phase 1 `p99 < 5ms`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSlopsquatCommand } from '../src/core-isomorphic/guards/bucketBHeuristics.mjs';
import { loadWorkspacePackageAllowlist } from '../src/core/bucket_b_runtime.mjs';
import { runBucketBExperiment } from './helpers/bucket_b_harness.mjs';
import { cleanupTempWorkspace } from './helpers/e2e_harness.mjs';

function buildSlopsquatDataset() {
  const commonAllow = {
    manifestDeps: ['internal-logger-pkg', 'custom-corp-helper'],
    workspacePackages: ['@ctxtop/core', '@ctxtop/engine-node', '@ctxtop/claude-code'],
    privateScopes: ['@corp', '@acme', '@internal']
  };

  const adversarial = [
    // Known LLM conflations
    { cmd: 'npm install react-codeshift', desc: 'conflation jscodeshift + react-codemod' },
    { cmd: 'pnpm add -D unused-imports', desc: 'conflation eslint-plugin-unused-imports' },
    { cmd: 'npm i nextjs-auth', desc: 'conflation next-auth' },
    { cmd: 'yarn add tailwind-merge-classes', desc: 'conflation tailwind-merge + clsx' },
    { cmd: 'bun add prisma-orm', desc: 'conflation prisma' },
    { cmd: 'pip install huggingface-cli', desc: 'PyPI slopsquat for huggingface-hub' },
    { cmd: 'uv add fastapi-cors', desc: 'hallucinated fastapi-cors' },
    { cmd: 'poetry add urllib4', desc: 'hallucinated urllib4' },
    // Damerau-Levenshtein distance-1 typosquats
    { cmd: 'npm install lodahs', desc: 'transposition typo of lodash' },
    { cmd: 'npm i expres', desc: 'deletion typo of express' },
    { cmd: 'pnpm add axois', desc: 'transposition typo of axios' },
    { cmd: 'yarn add playwrigth', desc: 'transposition typo of playwright' },
    { cmd: 'pip install reqeusts', desc: 'transposition typo of requests' },
    { cmd: 'pip3 install fastpai', desc: 'transposition typo of fastapi' },
    { cmd: 'uv pip install pydantci', desc: 'transposition typo of pydantic' },
    { cmd: 'cargo add sered', desc: 'transposition typo of serde' },
    // Affix hallucinations
    { cmd: 'npm install axios-official', desc: 'affix hallucination around axios' },
    { cmd: 'pip install python-requests', desc: 'affix hallucination around requests' },
    // Phase 2 mocked 404 & ultra-low-reputation new package
    {
      cmd: 'npm install quantum-flux-serializer',
      desc: 'Phase 2 404 unpublished package',
      registryMetadata: { 'quantum-flux-serializer': { exists: false } }
    },
    {
      cmd: 'pip install shadow-agent-helper',
      desc: 'Phase 2 2-day-old 5-download package',
      registryMetadata: { 'shadow-agent-helper': { exists: true, ageDays: 2, weeklyDownloads: 5 } }
    }
  ].map((entry, idx) => ({
    id: `slop-adv-${idx + 1}`,
    category: 'slopsquat_adversarial',
    expectedTrigger: true,
    forbidDeny: true, // Even flagged packages must return `ask`, never hard `deny`
    payload: {
      command: entry.cmd,
      ...commonAllow,
      registryMetadata: entry.registryMetadata || null
    }
  }));

  // 15 private `.npmrc` scopes & custom `--registry` / `--index-url` commands
  const privateScopeCmds = [
    'npm install @corp/auth-sdk',
    'npm i -D @corp/eslint-config@2.1.0',
    'pnpm add @acme/design-tokens',
    'yarn add @acme/telemetry-client@^1.4.0',
    'bun add @internal/rpc-bridge',
    'npm install @corp/feature-flags @corp/metrics',
    'pnpm add --filter web @corp/ui-kit',
    'npm install obscure-private-pkg --registry=https://npm.corp.example.com',
    'npm i enterprise-bus --registry https://artifactory.internal/npm',
    'pnpm add internal-proto --registry=https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
    'pip install corp-ml-core --index-url https://pypi.corp.example.com/simple',
    'pip3 install --extra-index-url https://pypi.internal/simple internal-feature-store',
    'uv pip install -i https://nexus.corp.local/repository/pypi/simple corp-auth-py',
    'npm install internal-logger-pkg',
    'npm i custom-corp-helper@^3.0.0'
  ].map((cmd, idx) => ({
    id: `slop-private-${idx + 1}`,
    category: 'private_scope_or_manifest',
    expectedTrigger: false,
    forbidDeny: true,
    payload: { command: cmd, ...commonAllow }
  }));

  // 10 workspace:* / file: / bare lockfile sync commands
  const workspaceCmds = [
    'pnpm add @ctxtop/core@workspace:*',
    'npm install @ctxtop/engine-node',
    'yarn add @ctxtop/claude-code@workspace:^',
    'npm install file:../shared-pkg',
    'pnpm add link:./tools/local-cli',
    'npm ci',
    'npm install',
    'yarn',
    'pip install -r requirements.txt',
    'pip install -e .'
  ].map((cmd, idx) => ({
    id: `slop-workspace-${idx + 1}`,
    category: 'workspace_or_lockfile_sync',
    expectedTrigger: false,
    forbidDeny: true,
    payload: { command: cmd, ...commonAllow }
  }));

  // 15 offline / 1.5s-timeout / canonical installs
  const offlineFaultCmds = [
    { cmd: 'npm install react react-dom next', meta: {} },
    { cmd: 'pnpm add zod typescript vitest', meta: {} },
    { cmd: 'pip install fastapi uvicorn pydantic', meta: {} },
    { cmd: 'cargo add serde tokio clap', meta: {} },
    { cmd: 'npm install niche-oss-lib-alpha', meta: { 'niche-oss-lib-alpha': { offline: true } } },
    { cmd: 'npm i niche-oss-lib-beta', meta: { 'niche-oss-lib-beta': { timedOut: true } } },
    { cmd: 'pnpm add niche-oss-lib-gamma', meta: { 'niche-oss-lib-gamma': { error: 'ECONNREFUSED' } } },
    { cmd: 'yarn add niche-oss-lib-delta', meta: { 'niche-oss-lib-delta': { timedOut: true } } },
    { cmd: 'pip install obscure-science-kit', meta: { 'obscure-science-kit': { offline: true } } },
    { cmd: 'uv add obscure-data-loader', meta: { 'obscure-data-loader': { timedOut: true } } },
    { cmd: 'cargo add niche_embedded_hal', meta: { niche_embedded_hal: { offline: true } } },
    { cmd: 'npm install established-pkg', meta: { 'established-pkg': { exists: true, ageDays: 420, weeklyDownloads: 18000 } } },
    { cmd: 'pip install mature-py-lib', meta: { 'mature-py-lib': { exists: true, ageDays: 900, weeklyDownloads: 4200 } } },
    { cmd: 'git status && node --test test/all.test.mjs', meta: {} },
    { cmd: 'npx ctxtop doctor', meta: {} }
  ].map((entry, idx) => ({
    id: `slop-offline-${idx + 1}`,
    category: 'offline_timeout_or_canonical',
    expectedTrigger: false,
    forbidDeny: true,
    payload: {
      command: entry.cmd,
      ...commonAllow,
      registryMetadata: entry.meta
    }
  }));

  return [...adversarial, ...privateScopeCmds, ...workspaceCmds, ...offlineFaultCmds];
}

export async function runSlopsquatDepGateBenchmark() {
  const dataset = buildSlopsquatDataset();
  return runBucketBExperiment({
    id: '#6',
    code: 'SLOPSQUAT_DEP_GATE',
    subWave: 'B-Alpha',
    dataset,
    evaluateFn: (item) => evaluateSlopsquatCommand(item.payload),
    sla: {
      zeroFalseDeny: true,
      maxFpr: 0,
      minRecall: 0.95,
      minPrecision: 1.0,
      maxP99Ms: 5
    }
  });
}

if (!process.env.CTXTOP_BENCH_IMPORT_ONLY) {
  test('Bucket B #6 SLOPSQUAT_DEP_GATE meets 0% false-deny, 0% FPR, and Phase 1 p99 < 5ms', async () => {
    const report = await runSlopsquatDepGateBenchmark();
    assert.equal(report.status, 'PROMOTE_READY', `Failed SLA checks: ${report.failedChecks.join(', ')}`);
    assert.equal(report.falseDenies, 0);
    assert.equal(report.falsePositiveRate, 0);
    assert.equal(report.recall, 1);
    assert.ok(report.latencyMs.p99 < 5, `Expected Phase 1 p99 < 5ms, got ${report.latencyMs.p99}ms`);

    // Verify `loadWorkspacePackageAllowlist` parses `.npmrc` private scopes & skips forbidden SKU
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-slop-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          name: '@corp/monorepo-root',
          dependencies: { 'my-internal-dep': '^1.0.0' },
          workspaces: ['packages/app', 'packages/airlock']
        }),
        'utf8'
      );
      fs.mkdirSync(path.join(tmpDir, 'packages', 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'packages', 'app', 'package.json'),
        JSON.stringify({ name: '@corp/web-app' }),
        'utf8'
      );
      fs.mkdirSync(path.join(tmpDir, 'packages', 'airlock'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'packages', 'airlock', 'package.json'),
        JSON.stringify({ name: '@airlock/secret-sku' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, '.npmrc'),
        '@enterprise:registry=https://npm.enterprise.internal/\n',
        'utf8'
      );

      const allowlist = loadWorkspacePackageAllowlist(tmpDir);
      assert.ok(allowlist.manifestDeps.has('my-internal-dep'));
      assert.ok(allowlist.workspacePackages.has('@corp/web-app'));
      assert.ok(!allowlist.workspacePackages.has('@airlock/secret-sku'), 'Must skip forbidden SKU');
      assert.ok(allowlist.privateScopes.has('@enterprise'));
    } finally {
      cleanupTempWorkspace(tmpDir);
    }
  });
}
