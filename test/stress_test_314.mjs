import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

console.log('Starting 10 repeated stress cycles of Test 3.14 (Swarm Worktree DET-31 Probe & Cleanup)...');

let passed = 0;
let failed = 0;
const durations = [];

for (let i = 1; i <= 10; i++) {
  const start = performance.now();
  try {
    // Run Test 3.14
    execFileSync('node', ['--test', '--test-name-pattern=3.14', 'test/e2e_tier3_pairwise.test.mjs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const dur = performance.now() - start;
    durations.push(dur);

    // Verify 0 lingering git.exe processes
    let gitTasks = '';
    try {
      gitTasks = execSync('tasklist /FI "IMAGENAME eq git.exe"', { encoding: 'utf8' });
    } catch (_e) { void _e; }
    const hasGit = gitTasks.includes('git.exe');
    if (hasGit) {
      throw new Error(`Lingering git.exe process detected after cycle ${i}! Output: ${gitTasks}`);
    }

    // Verify 0 residual ctxtop-swarm-wt-p14- folders in %TEMP%
    const tmpDirs = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('ctxtop-swarm-wt-p14-'));
    if (tmpDirs.length > 0) {
      throw new Error(`Orphaned %TEMP% worktree folder detected after cycle ${i}: ${tmpDirs.join(', ')}`);
    }

    passed++;
    console.log(`[Cycle ${i}/10] PASS (${dur.toFixed(1)}ms) - 0 git.exe, 0 orphaned temp folders`);
  } catch (err) {
    const dur = performance.now() - start;
    failed++;
    console.error(`[Cycle ${i}/10] FAIL (${dur.toFixed(1)}ms):`, err.message);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
  }
}

const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
console.log(`\nResults: ${passed}/10 passed, ${failed}/10 failed.`);
console.log(`Average duration: ${avg.toFixed(1)}ms (Min: ${Math.min(...durations).toFixed(1)}ms, Max: ${Math.max(...durations).toFixed(1)}ms)`);

if (failed > 0) {
  process.exit(1);
}
