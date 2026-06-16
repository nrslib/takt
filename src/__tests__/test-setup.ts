import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const shouldForceNoTty = process.env.TAKT_TEST_FLG_TOUCH_TTY !== '1';

if (shouldForceNoTty) {
  process.env.TAKT_NO_TTY = '1';
}

let isolatedRootDir: string | undefined;
let taktEnvSnapshot: TaktEnvSnapshot;
beforeEach(() => {
  taktEnvSnapshot = clearTaktEnv();
  isolatedRootDir = mkdtempSync(join(tmpdir(), 'takt-test-global-'));
  process.env.TAKT_CONFIG_DIR = join(isolatedRootDir, '.takt');
  if (shouldForceNoTty) {
    process.env.TAKT_NO_TTY = '1';
  }
  mkdirSync(process.env.TAKT_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  restoreTaktEnv(taktEnvSnapshot);
  if (isolatedRootDir) {
    rmSync(isolatedRootDir, { recursive: true, force: true });
  }
});
