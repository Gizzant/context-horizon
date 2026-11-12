import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

console.log('=== EMPIRICAL CHALLENGE REPRODUCIBILITY MATRIX ===');

function runOnce(label) {
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
  const res = spawnSync(process.execPath, ['--test', 'test/e2e_tier3_pairwise.test.mjs'], {
    encoding: 'utf8'
  });
  const tmpAfter = fs.readdirSync(os.tmpdir());
  const leaked = tmpAfter.filter(f => !tmpBefore.has(f) && (f.startsWith('ctxtop-') || f.startsWith('pw-')));
  
  // Extract failing test names
  const failures = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.includes('✖ 3.')) {
      failures.push(line.trim());
    }
  }

  return {
    label,
    exitCode: res.status,
    failures,
    leakedTmp: leaked
  };
}

const runs = [];
for (let i = 1; i <= 5; i++) {
  const result = runOnce(`Sequential Run ${i}`);
  runs.push(result);
  console.log(`${result.label}: ExitCode ${result.exitCode}, Failures: [${result.failures.join('; ')}], LeakedTmp: ${result.leakedTmp.length}`);
}

console.log('\n=== REPRODUCIBILITY SUMMARY ===');
for (const r of runs) {
  console.log(`- ${r.label}: ${r.exitCode === 0 ? 'PASS' : 'FAIL'} | Failures: ${r.failures.length > 0 ? r.failures.join(', ') : 'none'} | Leaks: ${r.leakedTmp.length}`);
}
