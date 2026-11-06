import assert from 'node:assert/strict';
import {
  classifyHorizonWindow,
  CATEGORIES
} from '../src/core/horizon_classifier.mjs';

console.log('--- Verifying Phase 2: 4-Tier Log Resolver & 40-Cell Classifier ---');

const workspacePath = 'c:/projects/my-app';
const config = {
  amputation_token_threshold: 140000,
  deprecated_paths: ['**/legacy/**', '**/deprecated/**'],
  model_pricing_per_1m_input: {
    'gemini-3.8-flash': 0.15,
    'gemini-3.1-pro': 1.25
  }
};

// 1. Duplicate view_file reads move older read to STALE_DUP
const dupSteps = [
  {
    stepIndex: 1,
    role: 'tool',
    toolName: 'view_file',
    targetPath: 'c:/projects/my-app/src/index.js',
    exitCode: 0,
    tokenEstimate: 2000
  },
  {
    stepIndex: 2,
    role: 'model',
    type: 'PLANNER_RESPONSE',
    tokenEstimate: 500
  },
  {
    stepIndex: 3,
    role: 'tool',
    toolName: 'view_file',
    targetPath: 'c:/projects/my-app/src/index.js',
    exitCode: 0,
    tokenEstimate: 2000
  }
];

const res1 = classifyHorizonWindow(dupSteps, { total_input_tokens: 4500 }, workspacePath, [], config);
console.log(`Stale duplicate paths:`, res1.fileState.staleDupPaths);
console.log(`Active set paths:`, res1.fileState.activeSetPaths);
assert.ok(res1.fileState.staleDupPaths.includes('c:/projects/my-app/src/index.js'), 'Older read must be in staleDupPaths');
assert.ok(res1.fileState.activeSetPaths.includes('c:/projects/my-app/src/index.js'), 'Latest read must be in activeSetPaths');
assert.ok(res1.tokenBreakdown[CATEGORIES.STALE_DUP] >= 2000, 'Stale tokens counted');
console.log('✓ Check 1: Duplicate view_file read moved to STALE_DUP.');

// 2. Failed run_command followed by passing run_command transitions to DEAD_ERROR
const errorSteps = [
  {
    stepIndex: 1,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 3000
  },
  {
    stepIndex: 2,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 0,
    tokenEstimate: 1000
  }
];

const res2 = classifyHorizonWindow(errorSteps, { total_input_tokens: 4000 }, workspacePath, [], config);
console.log(`Dead error tokens:`, res2.tokenBreakdown[CATEGORIES.DEAD_ERROR]);
assert.ok(res2.tokenBreakdown[CATEGORIES.DEAD_ERROR] >= 3000, 'Failed command followed by pass must be DEAD_ERROR');
console.log('✓ Check 2: Resolved failed command classified as DEAD_ERROR.');

// 3. Foreign KI paths trigger MEMORY_BLEED
const foreignKIs = [
  {
    id: 'ki-foreign-1',
    projectPath: 'd:/other-workspace/repo-x',
    tokenCount: 4000
  },
  {
    id: 'ki-valid-1',
    projectPath: 'c:/projects/my-app/docs',
    tokenCount: 1500
  }
];

const res3 = classifyHorizonWindow([], { total_input_tokens: 5500 }, workspacePath, foreignKIs, config);
console.log(`Foreign bleed KI IDs:`, res3.fileState.foreignBleedKiIds);
assert.ok(res3.fileState.foreignBleedKiIds.includes('ki-foreign-1'), 'Foreign KI must be flagged in foreignBleedKiIds');
assert.equal(res3.flags.hasForeignBleed, true, 'hasForeignBleed flag must be true');
assert.ok(res3.tokenBreakdown[CATEGORIES.MEMORY_BLEED] >= 4000, 'Memory bleed tokens counted');
assert.ok(res3.tokenBreakdown[CATEGORIES.MEMORY_KI] >= 1500, 'Valid memory tokens counted');
console.log('✓ Check 3: Foreign KI triggered MEMORY_BLEED and foreignBleedKiIds populated.');

// 4. Latency test: 200-step event list in under 10ms
const largeStepList = [];
for (let i = 0; i < 200; i++) {
  largeStepList.push({
    stepIndex: i,
    role: i % 2 === 0 ? 'user' : 'model',
    type: i % 4 === 0 ? 'TOOL_RESULT' : 'PLANNER_RESPONSE',
    toolName: i % 4 === 0 ? 'view_file' : null,
    targetPath: i % 4 === 0 ? `c:/projects/my-app/file_${i % 10}.js` : null,
    exitCode: i % 10 === 0 ? 1 : 0,
    tokenEstimate: 500
  });
}

const t0 = process.hrtime.bigint();
const res4 = classifyHorizonWindow(largeStepList, { total_input_tokens: 100000 }, workspacePath, foreignKIs, config);
const t1 = process.hrtime.bigint();
const durationMs = Number(t1 - t0) / 1_000_000;

console.log(`✓ 200-step event list classified in ${durationMs.toFixed(3)}ms (Threshold: < 10.0ms)`);
console.log(`  Total Cells: ${res4.cells.length}`);
console.log(`  Signal Purity: ${res4.metrics.signalPurityPct}%`);
console.log(`  Sludge Tax: $${res4.metrics.sludgeTaxUsdPerTurn}/turn`);
assert.ok(durationMs < 10.0, `Classification took ${durationMs}ms which exceeds 10ms threshold`);
assert.equal(res4.cells.length, 40, 'Must produce 40 cells');

console.log('✓ Phase 2 verification PASSED with 0 errors.');
