/**
 * Test preload: give every test run its own throwaway home folder.
 *
 * Loaded with `node --import ./test/setup/isolate-home.mjs ...` from the npm test scripts so that
 * tests (and the child processes they spawn, which inherit the environment) never write into the
 * real ~/.gemini, ~/.claude, ~/.ctxtop or ~/.attention-horizon of whoever runs them.
 *
 * Opt out (e.g. to smoke-test your own installed plugin): HIGHBEAM_TEST_REAL_HOME=1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.HIGHBEAM_TEST_REAL_HOME !== '1' && !process.env.HIGHBEAM_TEST_HOME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-test-home-'));
  process.env.HIGHBEAM_TEST_HOME = dir; // children see this and reuse the same home
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ATTENTION_HORIZON_HOME_DIR = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; it lives in the OS temp folder
    }
  });
}
