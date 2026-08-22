import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface IsolatedEnv {
  taktDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

type E2EConfig = Record<string, unknown>;
type NotificationSoundEvents = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const E2E_CONFIG_FIXTURE_PATH = resolve(__dirname, '../fixtures/config.e2e.yaml');

function removeClaudeSkillsEnabledFromProviderOptions(
  providerOptions: string | undefined,
): string | undefined {
  if (!providerOptions) {
    return providerOptions;
  }

  try {
    const parsed: unknown = JSON.parse(providerOptions);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return providerOptions;
    }
    const options = parsed as Record<string, unknown>;
    const claude = options.claude;
    if (!claude || typeof claude !== 'object' || Array.isArray(claude)) {
      return providerOptions;
    }
    const skills = (claude as Record<string, unknown>).skills;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)
      || !Object.hasOwn(skills, 'enabled')) {
      return providerOptions;
    }
    const enabled = (skills as Record<string, unknown>).enabled;
    if (typeof enabled !== 'boolean') {
      return providerOptions;
    }

    const { enabled: _enabled, ...remainingSkills } = skills as Record<string, unknown>;
    const { skills: _skills, ...remainingClaude } = claude as Record<string, unknown>;
    const nextOptions = { ...options };
    if (Object.keys(remainingSkills).length > 0) {
      nextOptions.claude = { ...remainingClaude, skills: remainingSkills };
    } else if (Object.keys(remainingClaude).length > 0) {
      nextOptions.claude = remainingClaude;
    } else {
      delete nextOptions.claude;
    }
    return Object.keys(nextOptions).length > 0 ? JSON.stringify(nextOptions) : undefined;
  } catch {
    // Keep malformed input so the normal configuration boundary reports it unchanged.
    return providerOptions;
  }
}

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
  const baseDir = mkdtempSync(join(tmpdir(), 'te-'));
  const {
    TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED: _claudeSkillsEnabled,
    TAKT_PROVIDER_OPTIONS: providerOptions,
    ...parentEnv
  } = process.env;

  const taktDir = join(baseDir, '.takt');
  const gitConfigPath = join(baseDir, '.gitconfig');
  const worktreeDir = join(baseDir, 'worktrees');

  // Create TAKT config directory and config.yaml
  mkdirSync(taktDir, { recursive: true });
  const baseConfig = readE2EFixtureConfig();
  const provider = process.env.TAKT_E2E_PROVIDER;
  const model = process.env.TAKT_E2E_MODEL;
  if (provider === 'opencode' && !model) {
    throw new Error('TAKT_E2E_PROVIDER=opencode requires TAKT_E2E_MODEL (e.g. opencode/big-pickle)');
  }
  const config = provider
    ? {
      ...baseConfig,
      worktree_dir: worktreeDir,
      provider,
      ...(model ? { model } : {}),
    }
    : {
      ...baseConfig,
      worktree_dir: worktreeDir,
    };
  writeConfigFile(taktDir, config);

  // Create isolated Git config file — inherit GitHub credential helper
  // from the real global config so provider tests can push.
  let credentialLines = '';
  if (provider !== 'mock') {
    try {
      const helpers = execFileSync('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      if (helpers) {
        credentialLines = helpers.split('\n')
          .map(h => `  helper = ${h}`)
          .join('\n');
        credentialLines = `\n[credential "https://github.com"]\n${credentialLines}`;
      }
    } catch {
      // no credential helper configured — skip
    }
  }
  writeFileSync(
    gitConfigPath,
    `[user]\n  name = TAKT E2E Test\n  email = e2e@example.com${credentialLines}`,
  );

  // ...process.env inherits all env vars including TAKT_OPENAI_API_KEY (for Codex)
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    TAKT_PROVIDER_OPTIONS: removeClaudeSkillsEnabledFromProviderOptions(providerOptions),
    TAKT_CONFIG_DIR: taktDir,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    ...(provider === 'mock' ? { GIT_TERMINAL_PROMPT: '0' } : {}),
    TAKT_NO_TTY: '1',
    TAKT_NOTIFY_WEBHOOK: undefined,
    CLAUDECODE: undefined,
  };

  return {
    taktDir,
    env,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
