/**
 * @file test/engine_node_db_probe.test.mjs
 * Verification of dynamic node:sqlite probing & warning suppression (Feature 8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suppressSqliteWarning,
  probeSqliteBuiltin,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  resetProbeCacheForTesting
} from '../src/engine-node/db/probe.mjs';

test('engine-node probe: isNodeSqliteAvailable returns boolean without throwing', () => {
  const available = isNodeSqliteAvailable();
  assert.strictEqual(typeof available, 'boolean');
});

test('engine-node probe: getDatabaseSyncClass returns constructor or null', () => {
  const ctor = getDatabaseSyncClass();
  if (isNodeSqliteAvailable()) {
    assert.strictEqual(typeof ctor, 'function');
    assert.strictEqual(ctor.name, 'DatabaseSync');
  } else {
    assert.strictEqual(ctor, null);
  }
});

test('engine-node probe: suppressSqliteWarning prevents ExperimentalWarning stderr output', () => {
  let downstreamCalled = false;
  const mockOrigEmit = function(warning, ...args) {
    downstreamCalled = true;
  };
  const prevEmit = process.emitWarning;
  try {
    process.emitWarning = mockOrigEmit;
    suppressSqliteWarning({ force: true });
    process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
    assert.strictEqual(downstreamCalled, false, 'SQLite experimental warning should be suppressed');
    process.emitWarning('Other warning', 'CustomWarning');
    assert.strictEqual(downstreamCalled, true, 'Non-SQLite warnings should pass through');
  } finally {
    process.emitWarning = prevEmit;
  }
});

test('engine-node probe: Node 20 LTS simulation returns null cleanly', () => {
  const mockNode20Probe = probeSqliteBuiltin({
    getBuiltinModuleOverride: (id) => undefined
  });
  assert.strictEqual(mockNode20Probe, null);

  const mockAvailable = isNodeSqliteAvailable({
    getBuiltinModuleOverride: (id) => undefined
  });
  assert.strictEqual(mockAvailable, false);

  const mockCtor = getDatabaseSyncClass({
    getBuiltinModuleOverride: (id) => undefined
  });
  assert.strictEqual(mockCtor, null);
});

test('engine-node probe: forceFallback returns null cleanly', () => {
  const result = probeSqliteBuiltin({ forceFallback: true });
  assert.strictEqual(result, null);
});

test('engine-node probe: resetProbeCacheForTesting resets cached state', () => {
  probeSqliteBuiltin();
  resetProbeCacheForTesting();
  const ctor = getDatabaseSyncClass();
  if (isNodeSqliteAvailable()) {
    assert.strictEqual(typeof ctor, 'function');
  }
});
