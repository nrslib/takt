import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const shouldForceNoTty = process.env.TAKT_TEST_FLG_TOUCH_TTY !== '1';
const TEST_TMPDIR = realpathSync(tmpdir());

process.env.TMPDIR = TEST_TMPDIR;

if (shouldForceNoTty) {
  process.env.TAKT_NO_TTY = '1';
}

let isolatedRootDir: string | undefined;
let taktEnvSnapshot: TaktEnvSnapshot;
const gitEnvKeys = [
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
] as const;
let gitEnvSnapshot: Map<string, string | undefined>;
beforeEach(() => {
  taktEnvSnapshot = clearTaktEnv();
  process.env.TMPDIR = TEST_TMPDIR;
  isolatedRootDir = mkdtempSync(join(tmpdir(), 'takt-test-global-'));
  gitEnvSnapshot = new Map(gitEnvKeys.map((key) => [key, process.env[key]]));
  process.env.TAKT_CONFIG_DIR = join(isolatedRootDir, '.takt');
  const emptyGitConfig = join(isolatedRootDir, 'gitconfig');
  const emptyGitTemplate = join(isolatedRootDir, 'git-template');
  const emptyGitHooks = join(isolatedRootDir, 'git-hooks');
  writeFileSync(emptyGitConfig, '');
  mkdirSync(emptyGitTemplate, { recursive: true });
  mkdirSync(emptyGitHooks, { recursive: true });
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  process.env.GIT_TEMPLATE_DIR = emptyGitTemplate;
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgSign';
  process.env.GIT_CONFIG_VALUE_0 = 'false';
  process.env.GIT_CONFIG_KEY_1 = 'core.hooksPath';
  process.env.GIT_CONFIG_VALUE_1 = emptyGitHooks;
  if (shouldForceNoTty) {
    process.env.TAKT_NO_TTY = '1';
  }
  mkdirSync(process.env.TAKT_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  restoreTaktEnv(taktEnvSnapshot);
  for (const [key, value] of gitEnvSnapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (isolatedRootDir) {
    rmSync(isolatedRootDir, { recursive: true, force: true });
  }
});
