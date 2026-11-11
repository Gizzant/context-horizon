import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  UShapedAttentionOptimizer,
  analyzeRuleFileAttention,
  auditRuleFileHygiene
} from '../src/core/u_shaped_optimizer.mjs';

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gate4-'));
  const homeDir = path.join(root, 'home');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { root, homeDir, workspaceDir };
}

function cleanupTempEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (err) {
    if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
  }
}

/**
 * Generates a deterministic 280-line synthetic GEMINI.md with:
 *  - Foundational architecture headers in lines 1..40
 *  - Reference/filler lines across lines 41..109
 *  - 6 critical NEVER / MUST / NON-NEGOTIABLE directives buried in the 30-70% Middle Trough (lines 110..160)
 *  - Stale rules (>180 days old, e.g. last_verified: 2025-01-10) and duplicate directives in lines 161..280
 */
function buildSynthetic280LineGeminiMd() {
  const lines = [];
  lines.push('# Workspace Architecture & Core Identity');
  lines.push('- Project uses pure Node.js ES Modules (.mjs) with zero runtime npm dependencies.');
  for (let i = 3; i <= 109; i++) {
    lines.push(`- Reference note item ${i}: directory mapping and module conventions for subsystem ${i}.`);
  }

  // Lines 110..160 (inside the 30%..70% Middle Attention Trough of a 280-line file: 84..196)
  const buriedInvariants = [
    '- **NEVER** mutate GEMINI.md, AGENTS.md, or SKILL.md on disk while Cached History >= 50,000 and Cache TTL > 0s.',
    '- **NON-NEGOTIABLE**: NEVER open host Antigravity SQLite session databases in write mode; strictly use SQLITE_OPEN_READONLY.',
    '- **NEVER** delete, weaken, or skip existing assert or expect statements in any test file (DET-03).',
    '- **MUST** route all persistent rule and skill writes through PrefixCacheShield.',
    '- **NEVER** switch the main conversation model family mid-session when Cached History >= 60,000 and TTL > 0s.',
    '- **ALWAYS** keep 3-Way WebView Mirror files byte-for-byte identical via SHA-256 verification.'
  ];

  for (let i = 110; i <= 160; i++) {
    const idx = i - 110;
    if (idx < buriedInvariants.length) {
      lines.push(buriedInvariants[idx]);
    } else {
      lines.push(`- Middle trough filler note ${i}: general background context for component ${i}.`);
    }
  }

  // Lines 161..280: include >180-day stale entries and duplicates
  lines.push('- Legacy webpack 4 loader workaround [last_verified: 2025-01-10]');
  lines.push('- Deprecated enzyme shallow renderer rule (updated: 2024-11-05)');
  lines.push('- Legacy grunt build pipeline note [verified: 2025-02-01]');
  // Duplicate of line 2
  lines.push('- Project uses pure Node.js ES Modules (.mjs) with zero runtime npm dependencies.');

  while (lines.length < 280) {
    lines.push(`- Tail reference lookup entry ${lines.length + 1}: supplementary table row.`);
  }

  assert.equal(lines.length, 280, 'Synthetic GEMINI.md must be exactly 280 lines');
  return lines.join('\n');
}

test('[GATE-4.1] Analyzes 280-line GEMINI.md with NEVER rules buried at lines 110-160, reorders into Primacy/Recency bands, archives >180-day stale lines, and mirrors top 5 invariants to task.md', () => {
  const { root, homeDir, workspaceDir } = makeTempEnv();
  try {
    const geminiPath = path.join(workspaceDir, 'GEMINI.md');
    const taskMdPath = path.join(homeDir, '.gemini', 'antigravity', 'brain', 'guid-gate4', 'task.md');
    fs.mkdirSync(path.dirname(taskMdPath), { recursive: true });
    fs.writeFileSync(taskMdPath, '# Task Checklist\n- [/] Execute Phase 4 verification\n', 'utf8');

    const synthetic280 = buildSynthetic280LineGeminiMd();
    fs.writeFileSync(geminiPath, synthetic280, 'utf8');

    const fakeNowMs = Date.parse('2026-11-09T01:15:00Z');
    const optimizer = new UShapedAttentionOptimizer({
      homeDir,
      workspaceDir,
      nowFn: () => fakeNowMs
    });

    // 1. Verify initial vulnerability analysis on the 280-line file
    const before = analyzeRuleFileAttention(geminiPath);
    assert.equal(before.totalLines, 280);
    assert.equal(before.middleTroughRiskCount, 6, 'All 6 critical directives at lines 110-115 must be flagged in the 30-70% Middle Trough');
    for (const vuln of before.middleTroughVulnerabilities) {
      assert.ok(vuln.lineNumber >= 110 && vuln.lineNumber <= 160);
      assert.equal(vuln.band, 'MIDDLE_TROUGH');
      assert.ok(vuln.recallWeight >= 0.55 && vuln.recallWeight <= 0.70);
    }

    // 2. Verify PrefixCacheShield protection when session cache is warm
    const warmSession = { cachedTokens: 80500, cacheTtlSeconds: 240 };
    const stagedRun = optimizer.optimizeRuleFile(geminiPath, {
      session: warmSession,
      taskMdPath
    });
    assert.equal(stagedRun.shieldResult.staged, true, 'Must stage U-curve reorder in PrefixCacheShield when prefix cache is warm');
    assert.equal(fs.readFileSync(geminiPath, 'utf8'), synthetic280, 'GEMINI.md on disk must not be mutated while prefix cache is warm');

    // 3. Flush when cache is cold (TTL === 0) and verify reordered GEMINI.md
    optimizer.prefixShield.flushIfEligible({ cachedTokens: 80500, cacheTtlSeconds: 0 });
    const reorderedDiskContent = fs.readFileSync(geminiPath, 'utf8');
    const after = analyzeRuleFileAttention(reorderedDiskContent, { isRawText: true });

    assert.equal(after.middleTroughRiskCount, 0, 'After U-Curve reorder, 0 critical directives should remain in the Middle Trough');
    assert.equal(after.recencyDirectives.length, 6, 'All 6 critical NEVER/MUST/ALWAYS directives must sit in the bottom 30% Recency Band');
    assert.ok(after.totalLines <= 150, `Reordered GEMINI.md (${after.totalLines} lines) must respect the 150-line budget`);
    assert.ok(after.attentionHealthScore > before.attentionHealthScore, 'Attention health score must improve after U-curve optimization');

    // 4. Verify >180-day stale rules were archived to ~/.gemini/antigravity/agy-horizon/archived_rules.md
    assert.ok(fs.existsSync(stagedRun.archivedRulesPath), 'archived_rules.md must be created');
    const archivedText = fs.readFileSync(stagedRun.archivedRulesPath, 'utf8');
    assert.match(archivedText, /STALE_OVER_180_DAYS.*Legacy webpack 4 loader workaround/);
    assert.match(archivedText, /STALE_OVER_180_DAYS.*Deprecated enzyme shallow renderer rule/);
    assert.match(archivedText, /DUPLICATE_DIRECTIVE/);

    // 5. Verify top 5 NEVER/MUST invariants were mirrored to ## Active Guardrail Pin at the bottom of task.md
    assert.equal(stagedRun.recencyMirrorResult.mirroredCount, 5);
    const updatedTaskMd = fs.readFileSync(taskMdPath, 'utf8');
    assert.match(updatedTaskMd, /## Active Guardrail Pin/);
    assert.match(updatedTaskMd, /NEVER\*\* mutate GEMINI\.md/);
    assert.match(updatedTaskMd, /SQLITE_OPEN_READONLY/);
    assert.match(updatedTaskMd, /DET-03/);
  } finally {
    cleanupTempEnv(root);
  }
});

test('[GATE-4.2] Rule & Memory Hygiene Auditor detects contradictions, duplicates, and 200-line / 25 KB MEMORY.md cap violations', () => {
  const sampleMemoryMd = [
    '# Cross-IDE Memory Index',
    '- ALWAYS use vitest for unit testing.',
    '- NEVER use vitest for unit testing.',
    '- ALWAYS use vitest for unit testing.',
    ...Array.from({ length: 205 }, (_, idx) => `- Memory entry line ${idx + 1}: context pointer.`)
  ].join('\n');

  const audit = auditRuleFileHygiene(sampleMemoryMd, {
    isRawText: true,
    isMemoryMd: true,
    nowFn: () => Date.parse('2026-11-09T01:15:00Z')
  });

  assert.equal(audit.isMemoryMd, true);
  assert.equal(audit.maxLines, 200);
  assert.equal(audit.overLineBudget, true);
  assert.ok(audit.duplicateLines.length >= 1, 'Should detect duplicate directive');
  assert.ok(audit.contradictions.length >= 1, 'Should detect ALWAYS vs NEVER contradiction on vitest');
});
