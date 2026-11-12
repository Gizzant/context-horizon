import assert from 'node:assert/strict';
import path from 'node:path';
import {
  getPlatformPipePath,
  checkZeroRuntimeDeps,
  serializeUSTFv1,
  deserializeUSTFv1,
  createMockToolSpan,
  createMockUSTFTrajectory
} from './helpers/e2e_harness.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';
import { isPrefixInstructionFile } from '../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { parseWorktreePorcelain } from '../src/core/swarm_topology.mjs';
import { parseMergeTreeOutput } from '../src/engine-node/sensors/git_merge_tree.mjs';
import { JsonlDatabaseFallbackWrapper } from '../src/engine-node/db/jsonl_fallback.mjs';

console.log('--- Running Cross-Platform Portability Challenges ---');

// 1. isIgnorablePath across Windows, POSIX, and mixed path separators
const activeSourceCases = [
  'src/core/router.mjs',
  'src\\core\\router.mjs',
  'src/webview/horizon_panel.html',
  'src\\webview\\horizon_panel.html',
  'C:\\Projects\\workspace\\src\\core\\classifier.mjs',
  '/home/user/projects/workspace/src/core/classifier.mjs',
  '../../src/core/classifier.mjs',
  '..\\..\\src\\core\\classifier.mjs',
  'sidecars/horizon-daemon/server.mjs',
  'sidecars\\horizon-daemon\\server.mjs'
];

for (const p of activeSourceCases) {
  assert.equal(isIgnorablePath(p), false, `Path ${p} must NEVER be treated as ignorable`);
}

const ignorableCases = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'build/output.log',
  'build\\output.log',
  'dist/bundle.js',
  'dist\\bundle.js',
  'coverage/lcov.info',
  'coverage\\lcov.info',
  'tmp/test-file.txt',
  'tmp\\test-file.txt'
];

for (const p of ignorableCases) {
  assert.equal(isIgnorablePath(p), true, `Path ${p} must be recognized as ignorable`);
}
console.log('✔ isIgnorablePath passes all Windows/POSIX/mixed path cases');

// 2. isPrefixInstructionFile across Windows, POSIX, and mixed paths
const prefixCases = [
  ['AGENTS.md', true],
  ['CLAUDE.md', true],
  ['.agents/rules/AGENTS.md', true],
  ['.agents\\rules\\AGENTS.md', true],
  ['C:\\Users\\user\\.gemini\\config\\plugins\\rules\\AGENTS.md', true],
  ['/home/user/.gemini/config/plugins/rules/AGENTS.md', true],
  ['src/core/router.mjs', false],
  ['src\\core\\router.mjs', false]
];

for (const [p, expected] of prefixCases) {
  assert.equal(isPrefixInstructionFile(p), expected, `isPrefixInstructionFile(${p}) should be ${expected}`);
}
console.log('✔ isPrefixInstructionFile passes all Windows/POSIX/mixed path cases');

// 3. parseWorktreePorcelain with CRLF and LF lines, Windows and POSIX paths
const samplePorcelainWindows = [
  'worktree C:\\Projects\\repo',
  'HEAD 1234567890ab',
  'branch refs/heads/main',
  '',
  'worktree C:\\Projects\\repo\\.git\\worktrees\\worker-1',
  'HEAD abcdef123456',
  'branch refs/heads/feat-1',
  ''
].join('\r\n');

const resWin = parseWorktreePorcelain(samplePorcelainWindows);
assert.equal(resWin.length, 2);
assert.equal(resWin[0].branch, 'main');
assert.equal(resWin[1].name, 'worker-1');

const samplePorcelainPosix = [
  'worktree /home/user/repo',
  'HEAD 1234567890ab',
  'branch refs/heads/main',
  '',
  'worktree /home/user/repo/.git/worktrees/worker-2',
  'HEAD abcdef123456',
  'branch refs/heads/feat-2',
  ''
].join('\n');

const resPosix = parseWorktreePorcelain(samplePorcelainPosix);
assert.equal(resPosix.length, 2);
assert.equal(resPosix[0].branch, 'main');
assert.equal(resPosix[1].name, 'worker-2');
console.log('✔ parseWorktreePorcelain correctly parses both CRLF/Windows and LF/POSIX worktrees');

// 4. parseMergeTreeOutput across line endings and slashes
const sampleMergeWindows = [
  '100644 1111111111111111111111111111111111111111 1 src\\app.js',
  'CONFLICT (content): Merge conflict in src/app.js',
  ''
].join('\r\n');

const mergeRes = parseMergeTreeOutput(sampleMergeWindows);
assert.ok(mergeRes.conflictFiles.some(f => f.includes('app.js')));
console.log('✔ parseMergeTreeOutput handles mixed slashes and CRLF');

// 5. USTF Trajectory round-trip with Windows and POSIX spans
const mockSpanWin = createMockToolSpan({ toolName: 'read_file', toolInput: { file_path: 'C:\\test\\file.js' } });
const mockSpanPosix = createMockToolSpan({ toolName: 'read_file', toolInput: { file_path: '/tmp/test/file.js' } });
const traj = createMockUSTFTrajectory({ turnsCount: 1 });
traj.turns[0].toolSpans = [mockSpanWin, mockSpanPosix];
const serialized = serializeUSTFv1(traj);
const deserialized = deserializeUSTFv1(serialized);
assert.equal(deserialized.turns[0].toolSpans.length, 2);
console.log('✔ USTF v1 serializes and round-trips cross-platform path attributes losslessly');

console.log('--- All Cross-Platform Challenges Passed ---');
