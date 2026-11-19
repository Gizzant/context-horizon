/**
 * @file test/pro_team_anchors.test.mjs
 * Item 4: Defensible Paid Tier Anchor Features
 *  - Pro Anchor #1: Cross-Machine Encrypted Memory & Ledger Sync (`encrypted_sync.mjs`)
 *  - Pro Anchor #2: Git Branch & PR Cost Attribution (`pr_cost_attribution.mjs`)
 *  - Team Anchor #1: Zero-Knowledge Org FinOps Rollup (`team_finops_rollup.mjs`)
 *  - Team Anchor #2: CI / PR Token-Budget Gate (`ci_budget_gate.mjs`) + `team_finops_pack.mjs`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateProKeyPair,
  signProLicensePayload,
  activateProLicense,
  activateLocalTrial,
  requireProFeature
} from '../src/core/pro_license.mjs';
import {
  SYNC_VAULT_FORMAT,
  scrubSyncSecrets,
  encryptSyncPayload,
  decryptSyncPayload,
  inspectSyncVault,
  mergeSyncBundles,
  readLocalSyncStores
} from '../packages/pro/src/encrypted_sync.mjs';
import {
  PR_ATTRIBUTION_FORMAT,
  buildPrCostAttribution,
  formatPrAttributionMarkdown
} from '../packages/pro/src/pr_cost_attribution.mjs';
import {
  ZK_SNAPSHOT_FORMAT,
  ORG_ROLLUP_FORMAT,
  pseudonymizeDeveloperId,
  verifyZeroKnowledgeSnapshot,
  buildRedactedDeveloperSnapshot,
  aggregateOrgFinopsRollup,
  formatOrgRollupMarkdown,
  formatOrgRollupCsv
} from '../packages/pro/src/team_finops_rollup.mjs';
import {
  evaluateCiBudgetGate,
  formatCiGateMarkdown
} from '../packages/pro/src/ci_budget_gate.mjs';
import { buildTeamFinopsArtifacts } from '../packages/pro/src/team_finops_pack.mjs';
import { runCli } from '../bin/ctxtop.mjs';

function makeSignedHome(rootDir, label, tier, seats = 1) {
  const { publicKeyPem, privateKeyPem } = generateProKeyPair();
  const homeDir = path.join(rootDir, `home-${label}`);
  fs.mkdirSync(homeDir, { recursive: true });
  const key = signProLicensePayload(
    {
      email: `${label}@acme.dev`,
      tier,
      seats,
      issuedAt: new Date().toISOString(),
      expiresAt: tier === 'ltd' ? null : new Date(Date.now() + 90 * 86400_000).toISOString()
    },
    privateKeyPem
  );
  activateProLicense(key, { homeDir, publicKeyPem });
  return { homeDir, publicKeyPem };
}

describe('Item 4: Defensible Pro & Team Tier Anchor Features', () => {
  it('Pro Anchor #1: Encrypted Memory & Ledger Sync enforces Pro+ gates, scrubs secrets, detects tampering, and merges idempotently', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sync-'));
    try {
      const freeHome = path.join(tmpRoot, 'home-free');
      fs.mkdirSync(freeHome, { recursive: true });

      // Free tier strictly blocked
      const blocked = runCli(
        ['sync', 'export', '--out', path.join(tmpRoot, 'blocked.vault.json'), '--passphrase', 'correct-horse-99'],
        { cwd: tmpRoot, homeDir: freeHome, strict: true }
      );
      assert.equal(blocked.exitCode, 2);

      // Solo Pro allowed; verify secret scrubbing & AES-256-GCM envelope integrity
      const { homeDir: proHome, publicKeyPem } = makeSignedHome(tmpRoot, 'pro-sync', 'pro');
      const fakeOpenAiKey = ['sk', 'projABCDEFGHIJKLMNOPQRSTUV'].join('-');
      const fakeGhPat = ['ghp', '1234567890abcdefghijklmnopqr'].join('_');
      const bundleA = {
        ledgerEntries: [
          {
            id: 'led-1',
            timestamp: 1700000001000,
            sessionId: 'sess-1',
            category: 'AST_FOLD',
            savedTokens: 2400,
            savedUSD: 0.0072,
            note: `Token leak test ${fakeOpenAiKey}`
          }
        ],
        episodicRecords: [
          {
            id: 'ep-1',
            sessionId: 'sess-1',
            title: 'Auth bugfix',
            summary: `Avoid key ${fakeGhPat}`,
            updatedAt: '2026-11-18T10:00:00Z'
          }
        ],
        instincts: [
          {
            id: 'inst-1',
            directive_action: 'Run verify after mirror edits',
            updatedAt: '2026-11-18T10:00:00Z'
          }
        ]
      };

      const scrubbed = scrubSyncSecrets(bundleA);
      assert.equal(scrubbed.redactedCount, 2);
      assert.equal(scrubbed.data.ledgerEntries[0].note.includes('[REDACTED_SECRET]'), true);

      const envelope = encryptSyncPayload(bundleA, 'vault-passphrase-123', {
        machineFingerprint: 'devbox-alpha1',
        createdAt: '2026-11-18T12:00:00Z'
      });
      assert.equal(envelope.format, SYNC_VAULT_FORMAT);
      assert.equal(envelope.redactedSecretsCount, 2);
      assert.equal(envelope.ciphertextB64.includes(fakeOpenAiKey), false);

      // Wrong passphrase fails closed
      const wrongPass = decryptSyncPayload(envelope, 'wrong-passphrase');
      assert.equal(wrongPass.ok, false);

      // Tampered ciphertext fails GCM auth tag check
      const tamperedCipher = {
        ...envelope,
        ciphertextB64: 'A' + envelope.ciphertextB64.slice(1)
      };
      assert.equal(decryptSyncPayload(tamperedCipher, 'vault-passphrase-123').ok, false);

      // Tampered AAD fails header validation
      assert.equal(
        decryptSyncPayload({ ...envelope, aad: 'tampered:v1' }, 'vault-passphrase-123').ok,
        false
      );

      // Successful decrypt recovers clean scrubbed records
      const okDec = decryptSyncPayload(envelope, 'vault-passphrase-123');
      assert.equal(okDec.ok, true);
      assert.equal(okDec.bundle.ledgerEntries[0].note.includes(fakeOpenAiKey), false);
      assert.equal(okDec.bundle.ledgerEntries[0].note.includes('[REDACTED_SECRET]'), true);

      // Seed local stores on Machine A and export via CLI
      fs.mkdirSync(path.join(proHome, '.ctxtop', 'sync-store'), { recursive: true });
      fs.writeFileSync(
        path.join(proHome, '.ctxtop', 'saved_quota_ledger.jsonl'),
        bundleA.ledgerEntries.map((x) => JSON.stringify(x)).join('\n') + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(proHome, '.ctxtop', 'sync-store', 'episodic_memory.jsonl'),
        bundleA.episodicRecords.map((x) => JSON.stringify(x)).join('\n') + '\n',
        'utf8'
      );

      const vaultFile = path.join(tmpRoot, 'portable.vault.json');
      const expRes = runCli(
        ['sync', 'export', '--out', vaultFile, '--passphrase', 'vault-passphrase-123', '--json'],
        { cwd: tmpRoot, homeDir: proHome, publicKeyPem }
      );
      assert.equal(expRes.exitCode, 0);
      assert.equal(expRes.data.ok, true);
      assert.equal(expRes.data.counts.ledgerEntries, 1);

      const inspMeta = inspectSyncVault(vaultFile);
      assert.equal(inspMeta.ok, true);
      assert.equal(inspMeta.counts.ledgerEntries, 1);
      assert.equal(inspMeta.counts.episodicRecords, 1);

      const cliInsp = runCli(['sync', 'inspect', '--in', vaultFile, '--json'], {
        cwd: tmpRoot,
        homeDir: proHome,
        publicKeyPem
      });
      assert.equal(cliInsp.exitCode, 0);
      assert.equal(cliInsp.data.payloadSha256, expRes.data.payloadSha256);

      // Machine B has newer ep-1 summary and different led-2 entry; import from Machine A merges cleanly
      const { homeDir: ltdHome, publicKeyPem: pubB } = makeSignedHome(tmpRoot, 'ltd-b', 'ltd');
      fs.mkdirSync(path.join(ltdHome, '.ctxtop', 'sync-store'), { recursive: true });
      fs.writeFileSync(
        path.join(ltdHome, '.ctxtop', 'saved_quota_ledger.jsonl'),
        JSON.stringify({ id: 'led-2', timestamp: 1700000002000, sessionId: 'sess-2', category: 'FTS5', savedTokens: 5000 }) + '\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(ltdHome, '.ctxtop', 'sync-store', 'episodic_memory.jsonl'),
        JSON.stringify({
          id: 'ep-1',
          sessionId: 'sess-1',
          title: 'Auth bugfix',
          summary: 'Newer local summary wins via LWW',
          updatedAt: '2026-11-18T11:30:00Z'
        }) + '\n',
        'utf8'
      );

      const dryRes = runCli(
        ['sync', 'import', '--in', vaultFile, '--passphrase', 'vault-passphrase-123', '--dry-run', '--json'],
        { cwd: tmpRoot, homeDir: ltdHome, publicKeyPem: pubB }
      );
      assert.equal(dryRes.exitCode, 0);
      assert.equal(dryRes.data.dryRun, true);
      assert.equal(dryRes.data.totals.ledgerEntries, 2);
      assert.equal(readLocalSyncStores({ homeDir: ltdHome }).bundle.ledgerEntries.length, 1);

      const impRes = runCli(
        ['sync', 'import', '--in', vaultFile, '--passphrase', 'vault-passphrase-123', '--json'],
        { cwd: tmpRoot, homeDir: ltdHome, publicKeyPem: pubB }
      );
      assert.equal(impRes.exitCode, 0);
      assert.equal(impRes.data.added.ledgerEntries, 1);
      assert.equal(impRes.data.totals.ledgerEntries, 2);

      // Re-importing same vault is 100% idempotent (+0 added) and preserves newer LWW summary
      const reImp = runCli(
        ['sync', 'import', '--in', vaultFile, '--passphrase', 'vault-passphrase-123', '--json'],
        { cwd: tmpRoot, homeDir: ltdHome, publicKeyPem: pubB }
      );
      assert.equal(reImp.exitCode, 0);
      assert.equal(reImp.data.added.ledgerEntries, 0);
      const storedB = readLocalSyncStores({ homeDir: ltdHome }).bundle;
      assert.equal(storedB.episodicRecords[0].summary, 'Newer local summary wins via LWW');
      const manualMerge = mergeSyncBundles(storedB, storedB);
      assert.equal(manualMerge.added.ledgerEntries, 0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Pro Anchor #2: Git Branch & PR Cost Attribution correlates commits + numstat + tokens without path leakage', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pr-cost-'));
    try {
      const repoDir = path.join(tmpRoot, 'repo');
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

      const git = (args, extraEnv = {}) =>
        execFileSync('git', args, {
          cwd: repoDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Dev User',
            GIT_AUTHOR_EMAIL: 'dev@acme.dev',
            GIT_COMMITTER_NAME: 'Dev User',
            GIT_COMMITTER_EMAIL: 'dev@acme.dev',
            ...extraEnv
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });

      git(['init', '-b', 'main']);
      fs.writeFileSync(path.join(repoDir, 'src', 'app.js'), 'export const v = 1;\n', 'utf8');
      git(['add', '.']);
      git(['commit', '-m', 'chore: initial base'], {
        GIT_AUTHOR_DATE: '2026-11-18T10:00:00Z',
        GIT_COMMITTER_DATE: '2026-11-18T10:00:00Z'
      });

      git(['checkout', '-b', 'feat/billing']);
      fs.writeFileSync(
        path.join(repoDir, 'src', 'billing.js'),
        'export function charge(cents) {\n  return cents > 0 ? cents : 0;\n}\n',
        'utf8'
      );
      git(['add', '.']);
      git(['commit', '-m', 'feat: add billing helper'], {
        GIT_AUTHOR_DATE: '2026-11-18T10:15:00Z',
        GIT_COMMITTER_DATE: '2026-11-18T10:15:00Z'
      });

      fs.writeFileSync(
        path.join(repoDir, 'src', 'tax.js'),
        'export const rate = 0.08;\nexport function tax(n) { return n * rate; }\n',
        'utf8'
      );
      git(['add', '.']);
      git(['commit', '-m', 'feat: add tax calculation'], {
        GIT_AUTHOR_DATE: '2026-11-18T10:30:00Z',
        GIT_COMMITTER_DATE: '2026-11-18T10:30:00Z'
      });

      const freeHome = path.join(tmpRoot, 'home-free');
      fs.mkdirSync(freeHome, { recursive: true });
      const blocked = runCli(['pr-cost', '--base', 'main', '--head', 'HEAD', '--json'], {
        cwd: repoDir,
        homeDir: freeHome,
        strict: true
      });
      assert.equal(blocked.exitCode, 2);

      const trialHome = path.join(tmpRoot, 'home-trial');
      fs.mkdirSync(trialHome, { recursive: true });
      activateLocalTrial({ homeDir: trialHome });

      const steps = [
        {
          createdAt: '2026-11-18T10:10:00Z',
          inputTokens: 10000,
          cacheReadTokens: 80000,
          outputTokens: 1500,
          wasteTokens: 2000,
          filePath: path.join(repoDir, 'src', 'billing.js')
        },
        {
          createdAt: '2026-11-18T10:25:00Z',
          inputTokens: 5000,
          cacheReadTokens: 95000,
          outputTokens: 1000,
          wasteTokens: 1000,
          filePath: path.join(repoDir, 'src', 'tax.js')
        }
      ];

      const res = runCli(['pr-cost', '--base', 'main', '--head', 'HEAD', '--markdown'], {
        cwd: repoDir,
        homeDir: trialHome,
        steps,
        ledgerEntries: [
          { timestamp: '2026-11-18T10:20:00Z', savedTokens: 12000, savedUSD: 0.42 }
        ]
      });
      assert.equal(res.exitCode, 0);
      assert.equal(res.data.format, PR_ATTRIBUTION_FORMAT);
      assert.equal(res.data.summary.totalCommits, 2);
      assert.equal(res.data.summary.totalFilesChanged, 2);
      assert.equal(res.data.summary.totalTokens, 10000 + 80000 + 1500 + 5000 + 95000 + 1000);
      assert.equal(res.data.summary.estimatedSavedUsd, 0.42);
      assert.ok(res.data.summary.usdPer100Loc > 0);
      assert.equal(res.data.topCostFiles.every((f) => !path.isAbsolute(f.filePath)), true);

      const md = formatPrAttributionMarkdown(res.data);
      assert.match(md, /Highbeam PR Token & Cost Attribution/);
      assert.ok(!md.includes(os.homedir()), 'PR Markdown must never leak OS home directory');

      const direct = buildPrCostAttribution({
        cwd: repoDir,
        homeDir: trialHome,
        base: 'main',
        head: 'HEAD',
        steps
      });
      assert.equal(direct.ok, true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Team Anchor #1: Zero-Knowledge Org FinOps Rollup blocks Free & Solo Pro/LTD, enforces PII firewall, and rolls up CSV/MD/JSON', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-zk-rollup-'));
    try {
      const freeHome = path.join(tmpRoot, 'home-free');
      fs.mkdirSync(freeHome, { recursive: true });
      const { homeDir: soloProHome, publicKeyPem: pubPro } = makeSignedHome(tmpRoot, 'solo-pro', 'pro');
      const { homeDir: soloLtdHome, publicKeyPem: pubLtd } = makeSignedHome(tmpRoot, 'solo-ltd', 'ltd');
      const { homeDir: teamHome, publicKeyPem: pubTeam } = makeSignedHome(tmpRoot, 'team-lead', 'team', 5);

      // Free, Solo Pro, and Solo LTD must ALL be blocked from team_org_rollup
      for (const cfg of [
        { homeDir: freeHome, strict: true },
        { homeDir: soloProHome, publicKeyPem: pubPro },
        { homeDir: soloLtdHome, publicKeyPem: pubLtd }
      ]) {
        assert.equal(requireProFeature('team_org_rollup', cfg).allowed, false);
        assert.equal(runCli(['team-rollup', '--export-snapshot', '--json'], { cwd: tmpRoot, ...cfg }).exitCode, 2);
        assert.equal(runCli(['team-rollup', '--in', tmpRoot, '--json'], { cwd: tmpRoot, ...cfg }).exitCode, 2);
      }

      // Salted pseudonymization & Zero-Knowledge PII firewall checks
      const pseudo1 = pseudonymizeDeveloperId('alice@acme.dev', 'org-salt-2026');
      assert.match(pseudo1, /^dev_[a-f0-9]{12}$/);
      assert.notEqual(pseudo1, pseudonymizeDeveloperId('alice@acme.dev', 'other-salt'));

      const snapA = buildRedactedDeveloperSnapshot({
        homeDir: teamHome,
        publicKeyPem: pubTeam,
        orgSalt: 'org-salt-2026',
        developerId: 'alice@acme.dev',
        ledgerSummary: { workspace30dSavedUSD: 48.5 },
        auditReport: {
          sessionsScanned: 14,
          inputTokens: 100000,
          cacheReadTokens: 900000,
          outputTokens: 50000,
          estimatedSpendUsd: 22.0,
          preventableWasteTokens: 18000,
          preventableWasteUsd: 1.4,
          ring0Violations: 0
        },
        detectorCounts: { 'DET-04': 3, 'DET-08': 5 },
        modelBreakdown: { 'claude-sonnet-5-5': { tokens: 1050000, spendUsd: 22.0, savedUsd: 48.5 } }
      });
      assert.equal(snapA.ok, true);
      assert.equal(snapA.snapshot.format, ZK_SNAPSHOT_FORMAT);
      assert.equal(snapA.verification.valid, true);

      // Verify firewall rejects email, OS paths, secret keys, and forbidden keys
      const poisonedEmail = { ...snapA.snapshot, note: 'alice@acme.dev' };
      const poisonedPath = { ...snapA.snapshot, nested: { ref: '/Users/alice/repo/secret.ts' } };
      const poisonedSecret = { ...snapA.snapshot, meta: 'sk-proj1234567890abcdef' };
      const poisonedKey = { ...snapA.snapshot, prompt: 'hello world' };

      assert.equal(verifyZeroKnowledgeSnapshot(poisonedEmail).valid, false);
      assert.equal(verifyZeroKnowledgeSnapshot(poisonedPath).valid, false);
      assert.equal(verifyZeroKnowledgeSnapshot(poisonedSecret).valid, false);
      assert.equal(verifyZeroKnowledgeSnapshot(poisonedKey).valid, false);

      // Export snapshots to folder (plus duplicate & poisoned file) and aggregate via CLI
      const snapDir = path.join(tmpRoot, 'snapshots');
      fs.mkdirSync(snapDir, { recursive: true });
      const snapBPath = path.join(snapDir, 'dev_b.json');
      const expCli = runCli(['team-rollup', '--export-snapshot', '--out', snapBPath, '--salt', 'org-salt-2026'], {
        cwd: tmpRoot,
        homeDir: teamHome,
        publicKeyPem: pubTeam,
        developerId: 'bob@acme.dev',
        ledgerSummary: { workspace30dSavedUSD: 62.0 },
        auditReport: {
          sessionsScanned: 10,
          inputTokens: 50000,
          cacheReadTokens: 450000,
          outputTokens: 25000,
          estimatedSpendUsd: 11.0,
          preventableWasteTokens: 9000,
          preventableWasteUsd: 0.7
        },
        detectorCounts: { 'DET-08': 2 }
      });
      assert.equal(expCli.exitCode, 0);

      fs.writeFileSync(path.join(snapDir, 'dev_a.json'), JSON.stringify(snapA.snapshot), 'utf8');
      fs.writeFileSync(path.join(snapDir, 'dev_a_dup.json'), JSON.stringify(snapA.snapshot), 'utf8');
      fs.writeFileSync(path.join(snapDir, 'poisoned.json'), JSON.stringify(poisonedPath), 'utf8');

      const rollupRes = runCli(
        ['team-rollup', '--in', snapDir, '--org', 'Acme Eng', '--seats', '5', '--json'],
        { cwd: tmpRoot, homeDir: teamHome, publicKeyPem: pubTeam }
      );
      assert.equal(rollupRes.exitCode, 0);
      assert.equal(rollupRes.data.format, ORG_ROLLUP_FORMAT);
      assert.equal(rollupRes.data.activeDevelopers, 2);
      assert.equal(rollupRes.data.acceptedCount, 2);
      assert.equal(rollupRes.data.rejectedCount, 1);
      assert.equal(rollupRes.data.summary.totalEstimatedSavedUsd, 110.5);
      assert.equal(rollupRes.data.summary.totalEstimatedSpendUsd, 33);
      assert.equal(rollupRes.data.summary.monthlySeatCostUsd, 24.92);
      assert.equal(rollupRes.data.topDetectors[0].detectorId, 'DET-08');
      assert.equal(rollupRes.data.topDetectors[0].count, 7);

      const mdOut = formatOrgRollupMarkdown(rollupRes.data);
      assert.match(mdOut, /Acme Eng/);
      const csvCli = runCli(
        ['team-rollup', '--in', snapDir, '--org', 'Acme Eng', '--seats', '5', '--format', 'csv'],
        { cwd: tmpRoot, homeDir: teamHome, publicKeyPem: pubTeam }
      );
      assert.equal(csvCli.exitCode, 0);
      assert.equal(csvCli.output, formatOrgRollupCsv(rollupRes.data));
      assert.match(csvCli.output, /^rowType,orgName,/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Team Anchor #2: CI / PR Token-Budget Gate blocks Free & Solo Pro/LTD, enforces policy in enforce/advisory modes, and upgrades team-pack', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ci-gate-'));
    try {
      const freeHome = path.join(tmpRoot, 'home-free');
      fs.mkdirSync(freeHome, { recursive: true });
      const { homeDir: soloProHome, publicKeyPem: pubPro } = makeSignedHome(tmpRoot, 'solo-pro', 'pro');
      const { homeDir: soloLtdHome, publicKeyPem: pubLtd } = makeSignedHome(tmpRoot, 'solo-ltd', 'ltd');
      const { homeDir: teamHome, publicKeyPem: pubTeam } = makeSignedHome(tmpRoot, 'team', 'team', 5);

      for (const cfg of [
        { homeDir: freeHome, strict: true },
        { homeDir: soloProHome, publicKeyPem: pubPro },
        { homeDir: soloLtdHome, publicKeyPem: pubLtd }
      ]) {
        assert.equal(requireProFeature('team_ci_budget_gate', cfg).allowed, false);
        assert.equal(runCli(['ci-gate', '--json'], { cwd: tmpRoot, ...cfg }).exitCode, 2);
      }

      // Write workspace `.attention-horizon.json` with ciBudgetGate policy
      const wsDir = path.join(tmpRoot, 'ws');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, '.attention-horizon.json'),
        JSON.stringify({
          ciBudgetGate: {
            maxPrCostUsd: 10.0,
            maxPrTokens: 1000000,
            minCacheHitPct: 60,
            maxWasteRatioPct: 25,
            maxRing0Violations: 0,
            mode: 'enforce'
          }
        }),
        'utf8'
      );

      const passingAttrPath = path.join(tmpRoot, 'pr-pass.json');
      fs.writeFileSync(
        passingAttrPath,
        JSON.stringify({
          summary: {
            estimatedCostUsd: 4.5,
            totalTokens: 500000,
            totalInputTokens: 50000,
            totalCacheReadTokens: 425000,
            cacheHitPct: 89,
            wasteRatioPct: 10,
            ring0Violations: 0
          }
        }),
        'utf8'
      );

      const passRes = runCli(['ci-gate', '--input', passingAttrPath, '--json'], {
        cwd: wsDir,
        homeDir: teamHome,
        publicKeyPem: pubTeam
      });
      assert.equal(passRes.exitCode, 0);
      assert.equal(passRes.data.verdict, 'PASS');
      assert.equal(passRes.data.violations.length, 0);

      const failingAttrPath = path.join(tmpRoot, 'pr-fail.json');
      fs.writeFileSync(
        failingAttrPath,
        JSON.stringify({
          summary: {
            estimatedCostUsd: 18.2,
            totalTokens: 2100000,
            totalInputTokens: 300000,
            totalCacheReadTokens: 200000,
            cacheHitPct: 40,
            wasteRatioPct: 42,
            ring0Violations: 2
          }
        }),
        'utf8'
      );

      const failRes = runCli(
        ['ci-gate', '--input', failingAttrPath, '--github-annotations'],
        { cwd: wsDir, homeDir: teamHome, publicKeyPem: pubTeam }
      );
      assert.equal(failRes.exitCode, 1);
      assert.equal(failRes.data.verdict, 'FAIL');
      assert.equal(failRes.data.violations.length, 5);
      assert.match(failRes.output, /^::error title=Highbeam CI Budget Gate \(MAX_PR_COST_USD\)::/m);

      // Advisory mode returns exitCode 0 with ::warning annotation
      const advRes = runCli(
        ['ci-gate', '--input', failingAttrPath, '--mode', 'advisory', '--github-annotations'],
        { cwd: wsDir, homeDir: teamHome, publicKeyPem: pubTeam }
      );
      assert.equal(advRes.exitCode, 0);
      assert.equal(advRes.data.verdict, 'WARN');
      assert.match(advRes.output, /^::warning title=Highbeam CI Budget Gate \(MAX_PR_COST_USD\)::/m);

      // Programmatic check + Markdown formatter + team-pack 6-file artifact upgrade
      const gateMd = formatCiGateMarkdown(failRes.data);
      assert.match(gateMd, /MAX_PR_COST_USD/);
      assert.match(gateMd, /\*\*FAIL\*\*/);

      const directGate = evaluateCiBudgetGate({
        cwd: wsDir,
        homeDir: teamHome,
        publicKeyPem: pubTeam,
        inputPath: passingAttrPath
      });
      assert.equal(directGate.verdict, 'PASS');

      const packArtifacts = buildTeamFinopsArtifacts({ orgName: 'Acme Corp', seats: 5 });
      assert.equal(JSON.parse(packArtifacts.files['grafana-dashboard.json']).panels.length, 4);
      assert.ok(packArtifacts.files['highbeam-ci-budget-gate.yml']);
      assert.match(packArtifacts.files['highbeam-ci-budget-gate.yml'], /highbeam-cli ci-gate/);
      const policyFile = JSON.parse(packArtifacts.files['.attention-horizon.json']);
      assert.equal(policyFile.ciBudgetGate.maxPrCostUsd, 15);
      assert.equal(policyFile.ciBudgetGate.minCacheHitPct, 50);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
