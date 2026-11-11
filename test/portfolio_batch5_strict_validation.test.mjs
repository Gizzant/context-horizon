import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  validateStrictAntigravityPluginManifest as validateStrictPluginManifest,
  validateStrictAntigravityHooksJson as validateStrictHooksJson,
  validateSafePreInvocationOutput as validatePreInvocationOutput,
  validateSafePreToolUseOutput as validatePreToolUseOutput
} from '../src/core/shared/plugin_validator.mjs';
import { SavedQuotaReceiptLedger } from '../src/core/coach/saved_quota_ledger.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function walkSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'webview') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(mjs|js)$/.test(ent.name)) out.push(full);
  }
  return out;
}

describe('Batch 5 — Strict Antigravity Plugin Manifest, Hooks Schema, Zero-I/O Shared Spine & Mirror Parity Gates', () => {
  it('validates .antigravity-plugin/plugin.json, root plugin.json, and strict hooks.json structure laws', () => {
    const agyPluginPath = path.join(REPO_ROOT, '.antigravity-plugin', 'plugin.json');
    const rootPluginPath = path.join(REPO_ROOT, 'plugin.json');
    assert.equal(fs.existsSync(agyPluginPath), true);
    assert.equal(fs.existsSync(rootPluginPath), true);

    const agyManifest = JSON.parse(fs.readFileSync(agyPluginPath, 'utf8'));
    const rootManifest = JSON.parse(fs.readFileSync(rootPluginPath, 'utf8'));
    assert.equal(agyManifest.name, 'attention-horizon-antigravity');
    assert.equal(agyManifest.displayName, 'Attention Horizon');
    assert.equal(validateStrictPluginManifest(agyManifest).valid, true);
    assert.deepEqual(validateStrictPluginManifest(agyManifest).errors, []);
    assert.equal(validateStrictPluginManifest(rootManifest).valid, true);
    assert.deepEqual(validateStrictPluginManifest(rootManifest).errors, []);

    // Negative validator checks: reject "Antigravity ..." or "... Plugin" suffixes
    assert.equal(
      validateStrictPluginManifest({ name: 'attention-horizon-antigravity', displayName: 'Antigravity Horizon' }).valid,
      false
    );
    assert.equal(
      validateStrictPluginManifest({ name: 'attention-horizon-antigravity', displayName: 'Attention Horizon Plugin' }).valid,
      false
    );

    const hooksObj = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks.json'), 'utf8'));
    const hooksCheck = validateStrictHooksJson(hooksObj);
    assert.equal(hooksCheck.valid, true, `Strict hooks.json errors: ${hooksCheck.errors.join('; ')}`);

    // Verify all relative ./hooks/*.mjs entrypoints exist on disk
    for (const hookFile of [
      'session_start.mjs',
      'pre_invocation.mjs',
      'pre_tool_use.mjs',
      'post_tool_use.mjs',
      'post_invocation.mjs',
      'stop.mjs'
    ]) {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, 'hooks', hookFile)), true, `Missing hooks/${hookFile}`);
    }

    // Safe hook output validator checks (reject injectSteps, systemMessage.metadata, ask_question)
    assert.equal(validatePreInvocationOutput({}).valid, true);
    assert.equal(validatePreInvocationOutput({ ephemeralMessage: 'Advisory' }).valid, true);
    assert.equal(
      validatePreInvocationOutput({ terminationBehavior: 'terminate', errorMessage: { userMessage: 'Stop' } }).valid,
      true
    );
    assert.equal(validatePreInvocationOutput({ injectSteps: ['bad'] }).valid, false);
    assert.equal(validatePreToolUseOutput({ decision: 'deny', reason: 'Blocked' }).valid, true);
    assert.equal(validatePreToolUseOutput({ ask_question: 'bad' }).valid, false);
  });

  it('enforces pure zero-I/O isolation inside src/core/shared/, zero mock ledger constants, and zero outbound network sockets in core/hooks', () => {
    const sharedDir = path.join(REPO_ROOT, 'src', 'core', 'shared');
    const sharedFiles = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.mjs'));
    assert.ok(sharedFiles.length >= 6);

    for (const f of sharedFiles) {
      const src = fs.readFileSync(path.join(sharedDir, f), 'utf8');
      assert.ok(
        !/node:(fs|child_process|sqlite|http|https|net|tls|dgram)/.test(src),
        `src/core/shared/${f} must remain 100% pure zero-I/O`
      );
    }

    // Verify zero-seeded SavedQuotaReceiptLedger ($0.00 and 0 tokens)
    const ledger = new SavedQuotaReceiptLedger({ dbPath: '' });
    const summary = ledger.getSummary();
    assert.equal(summary.totalDollarsSaved, 0);
    assert.equal(summary.totalArgonEquivTokensSaved, 0);
    assert.equal(summary.formattedDollarsSaved, '$0.00');

    // Verify zero outbound network imports across src/core, src/hooks, src/shims, and hooks/
    for (const sub of [path.join(REPO_ROOT, 'src', 'core'), path.join(REPO_ROOT, 'src', 'hooks'), path.join(REPO_ROOT, 'src', 'shims'), path.join(REPO_ROOT, 'hooks')]) {
      for (const file of walkSourceFiles(sub)) {
        const content = fs.readFileSync(file, 'utf8');
        assert.ok(
          !/from\s+['"]node:(http|https|net|tls)['"]/.test(content) && !/\bnew\s+WebSocket\s*\(/.test(content),
          `${path.relative(REPO_ROOT, file)} must not open outbound network sockets`
        );
      }
    }
  });

  it('verifies 3-way SHA-256 mirror parity and skill/agent frontmatter schemas', () => {
    const skillsRoot = path.join(REPO_ROOT, 'skills');
    for (const dirEnt of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dirEnt.isDirectory()) continue;
      const mdPath = path.join(skillsRoot, dirEnt.name, 'SKILL.md');
      assert.equal(fs.existsSync(mdPath), true, `Missing SKILL.md in skills/${dirEnt.name}`);
      const md = fs.readFileSync(mdPath, 'utf8');
      assert.match(md, new RegExp(`^---\\r?\\nname:\\s*${dirEnt.name}\\r?\\n`), `Skill name must match folder ${dirEnt.name}`);
    }

    const parity = syncAndVerifyMirrors({ verifyOnly: true });
    assert.equal(parity.parityOk, true);
  });
});
