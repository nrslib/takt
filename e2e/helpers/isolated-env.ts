import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface IsolatedEnv {
  runId: string;
  taktDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

type E2EConfig = Record<string, unknown>;
type NotificationSoundEvents = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const E2E_CONFIG_FIXTURE_PATH = resolve(__dirname, '../fixtures/config.e2e.yaml');

function readE2EFixtureConfig(): E2EConfig {
  const raw = readFileSync(E2E_CONFIG_FIXTURE_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid E2E config fixture: ${E2E_CONFIG_FIXTURE_PATH}`);
  }
  return parsed as E2EConfig;
}

function writeConfigFile(taktDir: string, config: E2EConfig): void {
  writeFileSync(join(taktDir, 'config.yaml'), `${stringifyYaml(config)}`);
}

function parseNotificationSoundEvents(
  source: E2EConfig,
  sourceName: string,
): NotificationSoundEvents | undefined {
  const value = source.notification_sound_events;
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Invalid notification_sound_events in ${sourceName}: expected object`,
    );
  }
  return value as NotificationSoundEvents;
}

function mergeIsolatedConfig(
  fixture: E2EConfig,
  current: E2EConfig,
  patch: E2EConfig,
): E2EConfig {
  const merged: E2EConfig = { ...fixture, ...current, ...patch };
  const fixtureEvents = parseNotificationSoundEvents(fixture, 'fixture');
  const currentEvents = parseNotificationSoundEvents(current, 'current config');
  const patchEvents = parseNotificationSoundEvents(patch, 'patch');
  if (!fixtureEvents && !currentEvents && !patchEvents) {
    return merged;
  }
  merged.notification_sound_events = {
    ...(fixtureEvents ?? {}),
    ...(currentEvents ?? {}),
    ...(patchEvents ?? {}),
  };
  return merged;
}

export function updateIsolatedConfig(taktDir: string, patch: E2EConfig): void {
  const current = readE2EFixtureConfig();
  const configPath = join(taktDir, 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid isolated config: ${configPath}`);
  }
  writeConfigFile(taktDir, mergeIsolatedConfig(current, parsed as E2EConfig, patch));
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
  const baseConfig = readE2EFixtureConfig();
  const config = process.env.TAKT_E2E_PROVIDER
    ? { ...baseConfig, provider: process.env.TAKT_E2E_PROVIDER }
    : baseConfig;
  writeConfigFile(taktDir, config);

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
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
