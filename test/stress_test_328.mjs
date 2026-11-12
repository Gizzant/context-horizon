import { execFileSync } from 'node:child_process';

console.log('Starting 15 rapid repeated cycles of Test 3.28...');

let passed = 0;
let failed = 0;
const durations = [];

for (let i = 1; i <= 15; i++) {
  const start = performance.now();
  try {
    const stdout = execFileSync('node', ['--test', '--test-name-pattern=3.28', 'test/e2e_tier3_pairwise.test.mjs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const dur = performance.now() - start;
    durations.push(dur);
    passed++;
    console.log(`[Cycle ${i}/15] PASS (${dur.toFixed(1)}ms)`);
  } catch (err) {
    const dur = performance.now() - start;
    failed++;
    console.error(`[Cycle ${i}/15] FAIL (${dur.toFixed(1)}ms):`, err.message);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
  }
}

const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
console.log(`\nResults: ${passed}/15 passed, ${failed}/15 failed.`);
console.log(`Average duration: ${avg.toFixed(1)}ms (Min: ${Math.min(...durations).toFixed(1)}ms, Max: ${Math.max(...durations).toFixed(1)}ms)`);

if (failed > 0) {
  process.exit(1);
}
