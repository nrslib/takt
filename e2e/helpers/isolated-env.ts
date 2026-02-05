import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface IsolatedEnv {
  runId: string;
  taktDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Create an isolated environment for E2E testing.
 *
 * - Sets TAKT_CONFIG_DIR to a temporary directory
 * - Sets GIT_CONFIG_GLOBAL to an isolated .gitconfig file
 * - Uses the real ~/.claude/ for Claude authentication
 */
export function createIsolatedEnv(): IsolatedEnv {
  const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const baseDir = mkdtempSync(join(tmpdir(), `takt-e2e-${runId}-`));

  const taktDir = join(baseDir, '.takt');
  const gitConfigPath = join(baseDir, '.gitconfig');

  // Create TAKT config directory and config.yaml
  mkdirSync(taktDir, { recursive: true });
  writeFileSync(
    join(taktDir, 'config.yaml'),
    [
      'provider: claude',
      'language: en',
      'log_level: info',
      'default_piece: default',
    ].join('\n'),
  );

  // Create isolated Git config file
  writeFileSync(
    gitConfigPath,
    ['[user]', '  name = TAKT E2E Test', '  email = e2e@example.com'].join(
      '\n',
    ),
  );

  // ...process.env inherits all env vars including TAKT_OPENAI_API_KEY (for Codex)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TAKT_CONFIG_DIR: taktDir,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    TAKT_NO_TTY: '1',
  };

  return {
    runId,
    taktDir,
    env,
    cleanup: () => {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore errors (e.g., already deleted)
      }
    },
  };
}
