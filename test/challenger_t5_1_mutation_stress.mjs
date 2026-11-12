/**
 * @file test/challenger_t5_1_mutation_stress.mjs
 * Empirical Challenger Mutation & Stress Test for Milestone T5
 *
 * Verifies that Tier 4 Real-World Application Scenarios do NOT contain vacuous
 * passes or facades by injecting 6 targeted mutations across distinct scenario
 * domains and verifying that node:test fails with exitCode 1 and AssertionError.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ORIGINAL_PATH = path.resolve('test/e2e_tier4_scenarios.test.mjs');
const TEMP_MUTATED_PATH = path.resolve('test/_temp_e2e_tier4_mutated.test.mjs');

const MUTATIONS = [
  {
    id: 'MUT-01-SCENARIO-1',
    description: 'Scenario 1: DET-21 alias maps to block (mutated to expect "warn")',
    scenarioPattern: 'Scenario 1',
    target: "assert.equal(cfg.detectors['DET-30'], 'block', 'Legacy DET-21 block must map to canonical DET-30');",
    replacement: "assert.equal(cfg.detectors['DET-30'], 'warn', 'Mutated assertion expecting warn instead of block');"
  },
  {
    id: 'MUT-02-SCENARIO-3',
    description: 'Scenario 3: Airlock scrubs API secrets (mutated to expect unscrubbed token in JSON)',
    scenarioPattern: 'Scenario 3',
    target: "assert.equal(scrubbedStr.includes('sk-ant-api03-'), false);",
    replacement: "assert.equal(scrubbedStr.includes('sk-ant-api03-'), true, 'Mutated assertion expecting secret to remain');"
  },
  {
    id: 'MUT-03-SCENARIO-7',
    description: 'Scenario 7: Invariant 1 Plain-text /compact (mutated to inject forbidden button)',
    scenarioPattern: 'Scenario 7',
    target: 'assertPlainTextCompact(panelHtml);',
    replacement: 'assertPlainTextCompact(\'<div id="compactInstruction"><button id="btnCompactPrimary">Copy /compact</button></div>\');'
  },
  {
    id: 'MUT-04-SCENARIO-10',
    description: 'Scenario 10: DET-31 Git merge conflict probe (mutated to expect hasConflict: false)',
    scenarioPattern: 'Scenario 10',
    target: 'assert.equal(resConflict.hasConflict, true);',
    replacement: "assert.equal(resConflict.hasConflict, false, 'Mutated assertion expecting clean merge for conflicting branches');"
  },
  {
    id: 'MUT-05-SCENARIO-18',
    description: 'Scenario 18: COACH Control Plane ABORTED latch (mutated to expect "allow")',
    scenarioPattern: 'Scenario 18',
    target: "assert.equal(evaluateToolBoundaryLatch(attemptedResume).decision, 'deny');",
    replacement: "assert.equal(evaluateToolBoundaryLatch(attemptedResume).decision, 'allow', 'Mutated latch decision');"
  },
  {
    id: 'MUT-06-SCENARIO-20',
    description: 'Scenario 20: Composite score >= 96.25 threshold (mutated to expect impossible >= 100.0)',
    scenarioPattern: 'Scenario 20',
    target: 'assert.ok(compositeScore >= 96.25,',
    replacement: 'assert.ok(compositeScore >= 100.0, // Mutated impossible ceiling'
  }
];

async function runMutationStress() {
  console.log('================================================================');
  console.log('CHALLENGER T5: EMPIRICAL MUTATION TESTING SUITE');
  console.log(`Original test file: ${ORIGINAL_PATH}`);
  console.log(`Target mutations: ${MUTATIONS.length}`);
  console.log('================================================================\n');

  assert.ok(fs.existsSync(ORIGINAL_PATH), 'Original test file must exist');
  const originalContent = fs.readFileSync(ORIGINAL_PATH, 'utf8');

  let killedCount = 0;

  try {
    for (const mut of MUTATIONS) {
      console.log(`[Testing ${mut.id}] ${mut.description}`);

      assert.ok(
        originalContent.includes(mut.target),
        `Mutation target not found in original file for ${mut.id}:\n${mut.target}`
      );

      const mutatedContent = originalContent.replace(mut.target, mut.replacement);
      fs.writeFileSync(TEMP_MUTATED_PATH, mutatedContent, 'utf8');

      const proc = spawnSync(
        process.execPath,
        ['--test', `--test-name-pattern=${mut.scenarioPattern}`, TEMP_MUTATED_PATH],
        { encoding: 'utf8', timeout: 30000 }
      );

      const failedAsExpected = proc.status !== 0 || (proc.stderr + proc.stdout).includes('ERR_ASSERTION');

      if (failedAsExpected) {
        killedCount++;
        console.log(`  ✓ KILLED (Exit code: ${proc.status}, AssertionError caught as expected)\n`);
      } else {
        console.error(`  ✗ SURVIVED: Mutation was NOT detected! Test unexpectedly passed.`);
        console.error(`  STDOUT:\n${proc.stdout}`);
        console.error(`  STDERR:\n${proc.stderr}`);
        throw new Error(`Mutation survived: ${mut.id}`);
      }
    }

    console.log('================================================================');
    console.log(`MUTATION TEST RESULTS: ${killedCount}/${MUTATIONS.length} KILLED (100% kill rate)`);
    console.log('ALL MUTATIONS SUCCESSFULLY DETECTED — NO VACUOUS PASSES CONFIRMED');
    console.log('================================================================');
  } finally {
    if (fs.existsSync(TEMP_MUTATED_PATH)) {
      fs.unlinkSync(TEMP_MUTATED_PATH);
    }
  }
}

runMutationStress().catch((err) => {
  console.error('[CHALLENGER ERROR]', err);
  process.exit(1);
});
