import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGlobalConfigEnvOverrides,
  applyProjectConfigEnvOverrides,
  envVarNameFromPath,
} from '../infra/config/env/config-env-overrides.js';

describe('config env overrides', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(envBackup)) {
      process.env[key] = value;
    }
  });

  it('should convert dotted and camelCase paths to TAKT env variable names', () => {
    expect(envVarNameFromPath('verbose')).toBe('TAKT_VERBOSE');
    expect(envVarNameFromPath('provider_options.claude.sandbox.allow_unsandboxed_commands'))
      .toBe('TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS');
  });

  it('should apply global env overrides from generated env names', () => {
    process.env.TAKT_LOG_LEVEL = 'debug';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS = 'true';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.log_level).toBe('debug');
    expect(raw.provider_options).toEqual({
      claude: {
        sandbox: {
          allow_unsandboxed_commands: true,
        },
      },
    });
  });

  it('TAKT_DRAFT_PR が draft_pr に反映される', () => {
    process.env.TAKT_DRAFT_PR = 'true';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.draft_pr).toBe(true);
  });

  it('should apply project env overrides from generated env names', () => {
    process.env.TAKT_VERBOSE = 'true';
    process.env.TAKT_ANALYTICS_EVENTS_PATH = '/tmp/project-analytics';

    const raw: Record<string, unknown> = {};
    applyProjectConfigEnvOverrides(raw);

    expect(raw.verbose).toBe(true);
    expect(raw.analytics).toEqual({
      events_path: '/tmp/project-analytics',
    });
  });

  it('should apply analytics env overrides for global config', () => {
    process.env.TAKT_ANALYTICS_ENABLED = 'true';
    process.env.TAKT_ANALYTICS_EVENTS_PATH = '/tmp/global-analytics';
    process.env.TAKT_ANALYTICS_RETENTION_DAYS = '14';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.analytics).toEqual({
      enabled: true,
      events_path: '/tmp/global-analytics',
      retention_days: 14,
    });
  });
});
