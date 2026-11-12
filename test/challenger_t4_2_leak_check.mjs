import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

console.log('--- Checking for Leaks in Tier 3 Pairwise Test Execution ---');

// 1. Snapshot tmpdir entries before test
const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));

// 2. Snapshot node/git processes before test
function getRunningProcesses() {
  if (process.platform === 'win32') {
    try {
      const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
      const pids = [];
      for (const line of out.split(/\r?\n/)) {
        const parts = line.split('","');
        if (parts.length >= 2) {
          const name = parts[0].replace(/^"/, '').toLowerCase();
          const pid = parseInt(parts[1], 10);
          if (name === 'node.exe' || name === 'git.exe') {
            pids.push({ name, pid });
          }
        }
      }
      return pids;
    } catch {
      return [];
    }
  }
  return [];
}

const procsBefore = getRunningProcesses();
const pidsBefore = new Set(procsBefore.map(p => p.pid));

// 3. Snapshot git status in workspace before test
const gitStatusBefore = execSync('git status --porcelain', { encoding: 'utf8' });

// 4. Run test/e2e_tier3_pairwise.test.mjs
console.log('Running test/e2e_tier3_pairwise.test.mjs...');
const start = performance.now();
const testResult = spawnSync(process.execPath, ['--test', 'test/e2e_tier3_pairwise.test.mjs'], {
  stdio: 'inherit',
  encoding: 'utf8'
});
const duration = ((performance.now() - start) / 1000).toFixed(2);
console.log(`Test exited with code ${testResult.status} in ${duration}s`);

// 5. Check tmpdir leaks
const tmpAfter = fs.readdirSync(os.tmpdir());
const leakedTmp = tmpAfter.filter(f => !tmpBefore.has(f));
console.log('Leaked tmpdir items count:', leakedTmp.length);
if (leakedTmp.length > 0) {
  console.log('Leaked tmp items:', leakedTmp);
}

// 6. Check process leaks
const procsAfter = getRunningProcesses();
const leakedProcs = procsAfter.filter(p => !pidsBefore.has(p.pid) && p.pid !== process.pid);
console.log('Leaked background node/git processes count:', leakedProcs.length);
if (leakedProcs.length > 0) {
  console.log('Leaked processes:', leakedProcs);
}

// 7. Check workspace git mutations
const gitStatusAfter = execSync('git status --porcelain', { encoding: 'utf8' });
const linesBefore = new Set(gitStatusBefore.split(/\r?\n/).filter(Boolean));
const newUntrackedOrModified = gitStatusAfter.split(/\r?\n/).filter(line => line && !linesBefore.has(line));
console.log('New workspace modifications count:', newUntrackedOrModified.length);
if (newUntrackedOrModified.length > 0) {
  console.log('New modifications:', newUntrackedOrModified);
}

// Summary
const passedCleanly = testResult.status === 0 && leakedTmp.length === 0 && leakedProcs.length === 0 && newUntrackedOrModified.length === 0;
console.log('--- Leak Check Summary ---');
console.log('Exit Code:', testResult.status);
console.log('Leaked Tmp Files:', leakedTmp.length);
console.log('Leaked Processes:', leakedProcs.length);
console.log('Workspace File Leaks:', newUntrackedOrModified.length);
console.log('Overall Leak Check:', passedCleanly ? 'CLEAN' : 'HAS_LEAKS');

process.exit(passedCleanly ? 0 : 1);
