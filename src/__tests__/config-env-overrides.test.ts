import { afterEach, describe, expect, it, vi } from 'vitest';
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
    process.env.TAKT_PROVIDER = 'codex';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS = 'true';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.provider).toBe('codex');
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
    process.env.TAKT_MODEL = 'gpt-5';
    process.env.TAKT_CONCURRENCY = '3';
    process.env.TAKT_ANALYTICS_EVENTS_PATH = '/tmp/project-analytics';

    const raw: Record<string, unknown> = {};
    applyProjectConfigEnvOverrides(raw);

    expect(raw.model).toBe('gpt-5');
    expect(raw.concurrency).toBe(3);
    expect(raw.analytics).toEqual({
      events_path: '/tmp/project-analytics',
    });
  });

  it('should apply TAKT_PIECE_RUNTIME_PREPARE JSON override for global config', () => {
    process.env.TAKT_PIECE_RUNTIME_PREPARE = '{"custom_scripts":true}';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.piece_runtime_prepare).toEqual({
      custom_scripts: true,
    });
  });

  it('should apply TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS override for global config', () => {
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'false';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.piece_runtime_prepare).toEqual({
      custom_scripts: false,
    });
  });

  it('should apply TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS override for project config', () => {
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';

    const raw: Record<string, unknown> = {};
    applyProjectConfigEnvOverrides(raw);

    expect(raw.piece_runtime_prepare).toEqual({
      custom_scripts: true,
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

  it('should apply logging env overrides for global config', () => {
    process.env.TAKT_LOGGING_LEVEL = 'debug';
    process.env.TAKT_LOGGING_TRACE = 'true';
    process.env.TAKT_LOGGING_DEBUG = 'true';
    process.env.TAKT_LOGGING_PROVIDER_EVENTS = 'true';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.logging).toEqual({
      level: 'debug',
      trace: true,
      debug: true,
      provider_events: true,
    });
  });

  it('should let logging leaf env vars override TAKT_LOGGING JSON', () => {
    process.env.TAKT_LOGGING = '{"level":"info","trace":true,"debug":false}';
    process.env.TAKT_LOGGING_LEVEL = 'warn';
    process.env.TAKT_LOGGING_DEBUG = 'true';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.logging).toEqual({
      level: 'warn',
      trace: true,
      debug: true,
    });
  });

  it('should map TAKT_LOGGING_LEVEL as global logging.level override', () => {
    process.env.TAKT_LOGGING_LEVEL = 'warn';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.logging).toEqual({
      level: 'warn',
    });
  });

  it('should apply logging JSON override for global config', () => {
    process.env.TAKT_LOGGING = '{"level":"warn","debug":true}';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.logging).toEqual({
      level: 'warn',
      debug: true,
    });
  });

  it('should map TAKT_LOG_LEVEL to logging.level with deprecation warning', () => {
    process.env.TAKT_LOG_LEVEL = 'warn';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw: Record<string, unknown> = {};
      applyGlobalConfigEnvOverrides(raw);

      expect(raw.logging).toEqual({
        level: 'warn',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('TAKT_LOG_LEVEL'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('should map TAKT_OBSERVABILITY_PROVIDER_EVENTS to logging.provider_events with deprecation warning', () => {
    process.env.TAKT_OBSERVABILITY_PROVIDER_EVENTS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw: Record<string, unknown> = {};
      applyGlobalConfigEnvOverrides(raw);

      expect(raw.logging).toEqual({
        provider_events: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('TAKT_OBSERVABILITY_PROVIDER_EVENTS'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('should prefer TAKT_LOGGING_* over legacy logging env vars', () => {
    process.env.TAKT_LOGGING_LEVEL = 'info';
    process.env.TAKT_LOG_LEVEL = 'debug';
    process.env.TAKT_LOGGING_PROVIDER_EVENTS = 'false';
    process.env.TAKT_OBSERVABILITY_PROVIDER_EVENTS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw: Record<string, unknown> = {};
      applyGlobalConfigEnvOverrides(raw);

      expect(raw.logging).toEqual({
        level: 'info',
        provider_events: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('should prefer TAKT_LOGGING JSON over legacy logging env vars', () => {
    process.env.TAKT_LOGGING = '{"level":"error","provider_events":false}';
    process.env.TAKT_LOG_LEVEL = 'debug';
    process.env.TAKT_OBSERVABILITY_PROVIDER_EVENTS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw: Record<string, unknown> = {};
      applyGlobalConfigEnvOverrides(raw);

      expect(raw.logging).toEqual({
        level: 'error',
        provider_events: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('should apply cursor API key override for global config', () => {
    process.env.TAKT_CURSOR_API_KEY = 'cursor-key-from-env';
    process.env.TAKT_GEMINI_API_KEY = 'gemini-key-from-env';
    process.env.TAKT_GOOGLE_API_KEY = 'google-key-from-env';
    process.env.TAKT_GROQ_API_KEY = 'groq-key-from-env';
    process.env.TAKT_OPENROUTER_API_KEY = 'openrouter-key-from-env';

    const raw: Record<string, unknown> = {};
    applyGlobalConfigEnvOverrides(raw);

    expect(raw.cursor_api_key).toBe('cursor-key-from-env');
    expect(raw.gemini_api_key).toBe('gemini-key-from-env');
    expect(raw.google_api_key).toBe('google-key-from-env');
    expect(raw.groq_api_key).toBe('groq-key-from-env');
    expect(raw.openrouter_api_key).toBe('openrouter-key-from-env');
  });
});
