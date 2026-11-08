import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createDefaultSidecar,
  readSidecarSync,
  writeSidecarAtomicSync,
  mergeSidecarSectionSync
} from '../src/core/sidecar_store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Sidecar Concurrency & Race Condition Defense', () => {
  test('mergeSidecarSectionSync preserves disjoint section updates under concurrent mutations', async () => {
    const tmpDir = path.join(os.tmpdir(), `fc_concurrency_${Date.now()}`);
    const conversationId = `concurrent_sess_${Date.now()}`;
    const initial = createDefaultSidecar(conversationId);
    writeSidecarAtomicSync(conversationId, initial, tmpDir);

    // Simulate 4 concurrent writers updating sessionMeta and 4 concurrent writers updating sensors
    const iterations = 25;
    const workerPromises = [];

    // Worker 1: repeatedly updates sessionMeta.effortLocked and turnCount
    workerPromises.push(new Promise((resolve) => {
      for (let i = 0; i < iterations; i++) {
        mergeSidecarSectionSync(conversationId, 'sessionMeta', {
          effortLocked: true,
          turnCount: i + 1
        }, tmpDir);
      }
      resolve();
    }));

    // Worker 2: repeatedly updates sensors.dirtyGitFileCount
    workerPromises.push(new Promise((resolve) => {
      for (let i = 0; i < iterations; i++) {
        mergeSidecarSectionSync(conversationId, 'sensors', {
          dirtyGitFileCount: i + 2,
          schemaTaxPct: 5.5
        }, tmpDir);
      }
      resolve();
    }));

    // Worker 3: repeatedly updates fileState.activeSetPaths
    workerPromises.push(new Promise((resolve) => {
      for (let i = 0; i < iterations; i++) {
        mergeSidecarSectionSync(conversationId, 'fileState', {
          activeSetPaths: [`file_${i}.js`]
        }, tmpDir);
      }
      resolve();
    }));

    await Promise.all(workerPromises);

    const finalState = readSidecarSync(conversationId, tmpDir);
    assert.equal(finalState.conversationId, conversationId);
    assert.equal(finalState.sessionMeta.effortLocked, true);
    assert.equal(finalState.sessionMeta.turnCount, iterations);
    assert.equal(finalState.sensors.dirtyGitFileCount, iterations + 1);
    assert.equal(finalState.sensors.schemaTaxPct, 5.5);
    assert.equal(finalState.fileState.activeSetPaths[0], `file_${iterations - 1}.js`);
  });
});
