/** #37: uninstall must report what it leaves behind, including ~/.ctxtop/app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listUninstallLeftovers, uninstallAttentionHorizon, installAttentionHorizon } from '../../bin/ctxtop.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hb-uninst-'));
}

test('listUninstallLeftovers reports runtime copy, backups and artifact cache; empty when nothing exists', () => {
  const home = tmp();
  const cwd = tmp();
  try {
    assert.deepEqual(listUninstallLeftovers({ homeDir: home, cwd }), []);

    fs.mkdirSync(path.join(home, '.ctxtop', 'app'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.claude', 'cache', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json.ah-backup.123'), '{}');

    const paths = listUninstallLeftovers({ homeDir: home, cwd }).map((x) => x.path);
    assert.ok(paths.some((p) => p.endsWith('/.ctxtop/app')), 'must list ~/.ctxtop/app');
    assert.ok(paths.some((p) => p.endsWith('/.ctxtop')), 'must list ~/.ctxtop');
    assert.ok(paths.some((p) => p.endsWith('.claude/cache/artifacts')));
    assert.ok(paths.some((p) => p.endsWith('settings.json.ah-backup.123')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall result carries the leftovers list and does not delete them', () => {
  const home = tmp();
  const cwd = tmp();
  try {
    fs.mkdirSync(path.join(home, '.ctxtop', 'app'), { recursive: true });
    installAttentionHorizon({ homeDir: home, cwd, global: false });
    const res = uninstallAttentionHorizon({ homeDir: home, cwd, global: false });
    assert.ok(Array.isArray(res.leftovers));
    assert.ok(fs.existsSync(path.join(home, '.ctxtop', 'app')), 'runtime copy must stay');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
