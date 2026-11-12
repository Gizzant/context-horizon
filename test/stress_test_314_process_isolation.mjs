import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

console.log('Testing Test 3.14 for lingering git.exe processes tied to temp workspaces...');

function getGitProcesses() {
  try {
    const raw = execSync('powershell -Command "Get-CimInstance Win32_Process -Filter \\"name = \'git.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"', { encoding: 'utf8' }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

for (let i = 1; i <= 10; i++) {
  const start = performance.now();
  
  // Run Test 3.14
  execFileSync('node', ['--test', '--test-name-pattern=3.14', 'test/e2e_tier3_pairwise.test.mjs'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  // Wait 100ms for OS process table settle
  const waitStart = Date.now();
  while (Date.now() - waitStart < 100) {}

  const gitProcs = getGitProcesses();
  const worktreeProcs = gitProcs.filter(p => p.CommandLine && p.CommandLine.includes('ctxtop-swarm-wt-p14'));
  const tempFolders = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('ctxtop-swarm-wt-p14-'));
  
  console.log(`[Cycle ${i}/10] Finished in ${(performance.now() - start).toFixed(1)}ms | Worktree Git Procs: ${worktreeProcs.length} | Temp Folders: ${tempFolders.length}`);
  
  assert.equal(worktreeProcs.length, 0, `Found lingering git.exe for test workspace in cycle ${i}: ${JSON.stringify(worktreeProcs)}`);
  assert.equal(tempFolders.length, 0, `Found orphaned temp folders in cycle ${i}: ${JSON.stringify(tempFolders)}`);
}

console.log('\n[PASS] All 10 cycles had 0 lingering git.exe processes tied to test worktrees and 0 orphaned temp folders!');
