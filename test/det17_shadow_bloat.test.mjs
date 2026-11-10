import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShadowedFileBloat } from '../src/core/telemetry/shadow_file_detector.mjs';
import { CacheTtlWatchdog } from '../src/core/telemetry/cache_ttl_watchdog.mjs';

test('DET-17 Shadowed File Bloat Detector computes staleSnapshotCount, redundantTokens, and Flamegraph callout', () => {
  const steps = [
    {
      stepIndex: 0,
      toolCalls: [
        { name: 'view_file', args: { AbsolutePath: 'C:\\Projects\\app\\src\\router.mjs' }, tokens: 14000 }
      ]
    },
    {
      stepIndex: 1,
      toolCalls: [
        { name: 'replace_file_content', args: { TargetFile: 'c:/projects/app/src/router.mjs' } }
      ]
    },
    {
      stepIndex: 2,
      toolCalls: [
        { name: 'view_file', args: { AbsolutePath: 'C:/Projects/app/src/router.mjs' }, tokens: 14000 }
      ]
    },
    {
      stepIndex: 3,
      toolCalls: [
        { name: 'multi_replace_file_content', args: { TargetFile: 'C:\\Projects\\app\\src\\router.mjs' } }
      ]
    },
    {
      stepIndex: 4,
      toolCalls: [
        { name: 'view_file', args: { AbsolutePath: 'C:\\Projects\\app\\src\\router.mjs' }, tokens: 14100 }
      ]
    },
    {
      stepIndex: 5,
      toolCalls: [
        { name: 'write_to_file', args: { TargetFile: 'C:\\Projects\\app\\src\\router.mjs' } }
      ]
    },
    {
      stepIndex: 6,
      toolCalls: [
        { name: 'view_file', args: { AbsolutePath: 'C:\\Projects\\app\\src\\router.mjs' }, tokens: 14200 }
      ]
    }
  ];

  const report = detectShadowedFileBloat(steps);
  assert.equal(report.detectorId, 'DET-17');
  assert.equal(report.triggered, true);
  assert.ok(report.elapsedMs < 2.0, `Expected <2ms execution, got ${report.elapsedMs}ms`);
  assert.equal(report.offenders.length, 1);

  const top = report.offenders[0];
  assert.equal(top.baseName, 'router.mjs');
  assert.equal(top.totalSnapshotCount, 4);
  assert.equal(top.staleSnapshotCount, 3);
  assert.equal(top.redundantTokens, 42100);
  assert.equal(top.callout, 'router.mjs (3x snapshots • 42.1k stale tokens)');
  assert.deepEqual(report.flamegraphBadges, ['router.mjs (3x snapshots • 42.1k stale tokens)']);
});

test('DET-17 ignores ranged reads (StartLine/EndLine) and files without intermediate edits', () => {
  const steps = [
    {
      stepIndex: 0,
      toolCalls: [
        { name: 'view_file', args: { Path: 'src/clean.mjs', StartLine: 1, EndLine: 50 }, tokens: 800 }
      ]
    },
    {
      stepIndex: 1,
      toolCalls: [
        { name: 'replace_file_content', args: { Path: 'src/clean.mjs' } }
      ]
    },
    {
      stepIndex: 2,
      toolCalls: [
        { name: 'view_file', args: { Path: 'src/clean.mjs', StartLine: 40, EndLine: 90 }, tokens: 800 }
      ]
    },
    {
      stepIndex: 3,
      toolCalls: [
        { name: 'view_file', args: { Path: 'src/read_only.mjs' }, tokens: 5000 },
        { name: 'view_file', args: { Path: 'src/read_only.mjs' }, tokens: 5000 }
      ]
    }
  ];

  const report = detectShadowedFileBloat(steps);
  assert.equal(report.triggered, false);
  assert.equal(report.totalStaleSnapshots, 0);
  assert.equal(report.totalRedundantTokens, 0);
});

test('300s Implicit Cache TTL Watchdog emits TTL_WARNING_PULSE (T-45s), TTL_PRE_SNAPSHOT (T-10s), and TTL_EXPIRED_COLD_RISK (T-0s)', () => {
  const events = [];
  const watchdog = new CacheTtlWatchdog({
    sessionId: 'sess-ttl',
    cachedTokens: 68400
  });

  watchdog.on('TTL_WARNING_PULSE', (p) => events.push(p));
  watchdog.on('TTL_PRE_SNAPSHOT', (p) => events.push(p));
  watchdog.on('TTL_EXPIRED_COLD_RISK', (p) => events.push(p));

  const s120 = watchdog.evaluateElapsed(120);
  assert.equal(s120.state, 'WARM_ACTIVE');
  assert.equal(events.length, 0);

  // T-45s (255s elapsed)
  const s255 = watchdog.evaluateElapsed(255);
  assert.equal(s255.state, 'TTL_WARNING_PULSE');
  assert.equal(s255.ttlRemainingSeconds, 45);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'TTL_WARNING_PULSE');

  // T-10s (290s elapsed) -> pre-stage handoff snapshot
  const s290 = watchdog.evaluateElapsed(290);
  assert.equal(s290.state, 'TTL_PRE_SNAPSHOT');
  assert.equal(s290.ttlRemainingSeconds, 10);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, 'TTL_PRE_SNAPSHOT');

  // T-0s (300s elapsed) -> expired cold risk
  const s300 = watchdog.evaluateElapsed(300);
  assert.equal(s300.state, 'TTL_EXPIRED_COLD_RISK');
  assert.equal(s300.ttlRemainingSeconds, 0);
  assert.equal(events.length, 3);
  assert.equal(events[2].event, 'TTL_EXPIRED_COLD_RISK');
});
