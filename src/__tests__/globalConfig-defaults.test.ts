/**
 * Tests for loadGlobalConfig default values when config.yaml is missing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';

// Mock the home directory to use a temp directory
const testHomeDir = join(tmpdir(), `takt-gc-test-${Date.now()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

// Import after mocks are set up
const {
  loadGlobalConfig,
  saveGlobalConfig,
  invalidateGlobalConfigCache,
  loadGlobalMigratedProjectLocalFallback,
} = await import('../infra/config/global/globalConfig.js');
const { getGlobalConfigPath } = await import('../infra/config/paths.js');

describe('loadGlobalConfig', () => {
  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(testHomeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true });
    }
  });

  it('should return default values when config.yaml does not exist', () => {
    const config = loadGlobalConfig();

    expect(config.language).toBe('en');
    expect(config.provider).toBe('claude');
    expect(config.model).toBeUndefined();
  });

  it('should not expose migrated project-local fields from global config', () => {
    const config = loadGlobalConfig() as Record<string, unknown>;

    expect(config).not.toHaveProperty('logLevel');
    expect(config).not.toHaveProperty('pipeline');
    expect(config).not.toHaveProperty('personaProviders');
    expect(config).not.toHaveProperty('branchNameStrategy');
    expect(config).not.toHaveProperty('minimalOutput');
    expect(config).not.toHaveProperty('concurrency');
    expect(config).not.toHaveProperty('taskPollIntervalMs');
    expect(config).not.toHaveProperty('interactivePreviewMovements');
    expect(config).not.toHaveProperty('verbose');
  });

  it('should accept migrated project-local keys in global config.yaml for resolver fallback', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'log_level: debug',
        'pipeline:',
        '  default_branch_prefix: "global/"',
        'persona_providers:',
        '  coder:',
        '    provider: codex',
        'branch_name_strategy: ai',
        'minimal_output: true',
        'concurrency: 3',
        'task_poll_interval_ms: 1000',
        'interactive_preview_movements: 2',
        'verbose: true',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).not.toThrow();
    const config = loadGlobalConfig() as Record<string, unknown>;
    expect(config).not.toHaveProperty('logLevel');
    expect(config).not.toHaveProperty('pipeline');
    expect(config).not.toHaveProperty('personaProviders');
    expect(config).not.toHaveProperty('branchNameStrategy');
    expect(config).not.toHaveProperty('minimalOutput');
    expect(config).not.toHaveProperty('concurrency');
    expect(config).not.toHaveProperty('taskPollIntervalMs');
    expect(config).not.toHaveProperty('interactivePreviewMovements');
    expect(config).not.toHaveProperty('verbose');
  });

  it('should not persist migrated project-local keys when saving global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig() as Record<string, unknown>;
    config.logLevel = 'debug';
    config.pipeline = { defaultBranchPrefix: 'global/' };
    config.personaProviders = { coder: { provider: 'codex' } };
    config.branchNameStrategy = 'ai';
    config.minimalOutput = true;
    config.concurrency = 4;
    config.taskPollIntervalMs = 1200;
    config.interactivePreviewMovements = 1;
    config.verbose = true;
    saveGlobalConfig(config as Parameters<typeof saveGlobalConfig>[0]);

    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).not.toContain('log_level:');
    expect(raw).not.toContain('pipeline:');
    expect(raw).not.toContain('persona_providers:');
    expect(raw).not.toContain('branch_name_strategy:');
    expect(raw).not.toContain('minimal_output:');
    expect(raw).not.toContain('concurrency:');
    expect(raw).not.toContain('task_poll_interval_ms:');
    expect(raw).not.toContain('interactive_preview_movements:');
    expect(raw).not.toContain('verbose:');
  });

  it('should return the same cached object on subsequent calls', () => {
    const config1 = loadGlobalConfig();
    const config2 = loadGlobalConfig();

    expect(config1).toBe(config2);
  });

  it('should return a fresh object after cache invalidation', () => {
    const config1 = loadGlobalConfig();
    invalidateGlobalConfigCache();
    const config2 = loadGlobalConfig();

    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });

  it('should load from config.yaml when it exists', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: ja\nprovider: codex\n',
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.language).toBe('ja');
    expect(config.provider).toBe('codex');
    expect((config as Record<string, unknown>).logLevel).toBeUndefined();
  });

  it('should load provider block from config.yaml and normalize model/providerOptions', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'provider:',
        '  type: codex',
        '  model: gpt-5.3',
        '  network_access: true',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.provider).toBe('codex');
    expect(config.model).toBe('gpt-5.3');
    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('should preserve provider_options when saveGlobalConfig is called with loaded config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider: claude',
        'provider_options:',
        '  codex:',
        '    network_access: true',
        '  opencode:',
        '    network_access: false',
        '  claude:',
        '    sandbox:',
        '      allow_unsandboxed_commands: true',
        '      excluded_commands:',
        '        - git push',
      ].join('\n'),
      'utf-8',
    );

    const loaded = loadGlobalConfig();
    saveGlobalConfig(loaded);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['git push'],
        },
      },
    });
    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('provider_options:');
  });

  it('should round-trip copilot global fields', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'copilot_cli_path: /tmp/copilot',
        'copilot_github_token: ghp_test_token',
      ].join('\n'),
      'utf-8',
    );

    const loaded = loadGlobalConfig();
    expect(loaded.copilotCliPath).toBe('/tmp/copilot');
    expect(loaded.copilotGithubToken).toBe('ghp_test_token');

    saveGlobalConfig(loaded);
    invalidateGlobalConfigCache();
    const reloaded = loadGlobalConfig();
    expect(reloaded.copilotCliPath).toBe('/tmp/copilot');
    expect(reloaded.copilotGithubToken).toBe('ghp_test_token');
  });

  it('should apply env override for nested provider_options key', () => {
    const original = process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS;
    try {
      process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS = 'true';
      invalidateGlobalConfigCache();

      const config = loadGlobalConfig();
      expect(config.providerOptions?.claude?.sandbox?.allowUnsandboxedCommands).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS;
      } else {
        process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS = original;
      }
    }
  });

  it('should accept pipeline in global config for migrated fallback', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'pipeline:',
        '  default_branch_prefix: "feat/"',
        '  commit_message_template: "fix: {title} (#{issue})"',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).not.toThrow();
    const config = loadGlobalConfig() as Record<string, unknown>;
    expect(config).not.toHaveProperty('pipeline');
  });

  it('should save and reload pipeline config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    // Create minimal config first
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    (config as Record<string, unknown>).pipeline = {
      defaultBranchPrefix: 'takt/',
      commitMessageTemplate: 'feat: {title} (#{issue})',
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect((reloaded as Record<string, unknown>).pipeline).toBeUndefined();
  });

  it('should load auto_pr config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nauto_pr: true\n',
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.autoPr).toBe(true);
  });

  it('should save and reload auto_pr config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    // Create minimal config first
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.autoPr = true;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.autoPr).toBe(true);
  });

  it('should save auto_pr: false when explicitly set', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.autoPr = false;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.autoPr).toBe(false);
  });

  it('should read from cache without hitting disk on second call', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: ja\nprovider: codex\n',
      'utf-8',
    );

    const config1 = loadGlobalConfig();
    expect(config1.language).toBe('ja');

    // Overwrite file on disk - cached result should still be returned
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nprovider: claude\n',
      'utf-8',
    );

    const config2 = loadGlobalConfig();
    expect(config2.language).toBe('ja');
    expect(config2).toBe(config1);

    // After invalidation, the new file content is read
    invalidateGlobalConfigCache();
    const config3 = loadGlobalConfig();
    expect(config3.language).toBe('en');
    expect(config3).not.toBe(config1);
  });

  it('should load prevent_sleep config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nprevent_sleep: true\n',
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.preventSleep).toBe(true);
  });

  it('should save and reload prevent_sleep config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.preventSleep = true;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.preventSleep).toBe(true);
  });

  it('should save prevent_sleep: false when explicitly set', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.preventSleep = false;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.preventSleep).toBe(false);
  });

  it('should have undefined preventSleep by default', () => {
    const config = loadGlobalConfig();
    expect(config.preventSleep).toBeUndefined();
  });

  it('should load notification_sound config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nnotification_sound: false\n',
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.notificationSound).toBe(false);
  });

  it('should save and reload notification_sound config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.notificationSound = true;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.notificationSound).toBe(true);
  });

  it('should save notification_sound: false when explicitly set', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.notificationSound = false;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.notificationSound).toBe(false);
  });

  it('should have undefined notificationSound by default', () => {
    const config = loadGlobalConfig();
    expect(config.notificationSound).toBeUndefined();
  });

  it('should load notification_sound_events config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'notification_sound_events:',
        '  iteration_limit: false',
        '  piece_complete: true',
        '  piece_abort: true',
        '  run_complete: true',
        '  run_abort: false',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.notificationSoundEvents).toEqual({
      iterationLimit: false,
      pieceComplete: true,
      pieceAbort: true,
      runComplete: true,
      runAbort: false,
    });
  });

  it('should load logging config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'logging:',
        '  provider_events: false',
        '  usage_events: true',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.logging).toEqual({
      providerEvents: false,
      usageEvents: true,
    });
  });

  it('should load full logging config with all fields', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'logging:',
        '  level: debug',
        '  trace: true',
        '  debug: true',
        '  provider_events: true',
        '  usage_events: false',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.logging).toEqual({
      level: 'debug',
      trace: true,
      debug: true,
      providerEvents: true,
      usageEvents: false,
    });
  });

  it('should save and reload logging config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.logging = {
      level: 'warn',
      trace: false,
      debug: true,
      providerEvents: false,
      usageEvents: true,
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.logging).toEqual({
      level: 'warn',
      trace: false,
      debug: true,
      providerEvents: false,
      usageEvents: true,
    });
  });

  it('should save partial logging config (only provider_events)', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.logging = {
      providerEvents: true,
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.logging).toEqual({
      providerEvents: true,
    });
  });

  it('should save partial logging config (only usage_events)', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.logging = {
      usageEvents: true,
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.logging).toEqual({
      usageEvents: true,
    });
  });


  it('should save and reload notification_sound_events config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.notificationSoundEvents = {
      iterationLimit: false,
      pieceComplete: true,
      pieceAbort: false,
      runComplete: true,
      runAbort: true,
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.notificationSoundEvents).toEqual({
      iterationLimit: false,
      pieceComplete: true,
      pieceAbort: false,
      runComplete: true,
      runAbort: true,
    });
  });

  it('should accept interactive_preview_movements in global config for migrated fallback', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\ninteractive_preview_movements: 5\n',
      'utf-8',
    );

    expect(() => loadGlobalConfig()).not.toThrow();
    const config = loadGlobalConfig() as Record<string, unknown>;
    expect(config).not.toHaveProperty('interactivePreviewMovements');
  });

  it('should save and reload interactive_preview_movements config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    (config as Record<string, unknown>).interactivePreviewMovements = 7;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect((reloaded as Record<string, unknown>).interactivePreviewMovements).toBeUndefined();
  });

  it('should default interactive_preview_movements to 3', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    expect((config as Record<string, unknown>).interactivePreviewMovements).toBeUndefined();
  });

  it('should accept interactive_preview_movements=0 in global config for migrated fallback', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\ninteractive_preview_movements: 0\n',
      'utf-8',
    );

    expect(() => loadGlobalConfig()).not.toThrow();
    const config = loadGlobalConfig() as Record<string, unknown>;
    expect(config).not.toHaveProperty('interactivePreviewMovements');
  });

  describe('persona_providers', () => {
    it('should fail fast when persona_providers provider/model alias combination is invalid', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'language: en\npersona_providers:\n  coder:\n    provider: codex\n    model: opus\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow();
    });

    it('should fail fast when persona provider block includes provider options', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'language: en',
          'persona_providers:',
          '  coder:',
          '    type: codex',
          '    network_access: true',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow();
    });
  });

  describe('runtime', () => {
    it('should load runtime.prepare from config.yaml', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'language: en',
          'runtime:',
          '  prepare:',
          '    - gradle',
          '    - node',
        ].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig();
      expect(config.runtime).toEqual({ prepare: ['gradle', 'node'] });
    });

    it('should save and reload runtime.prepare', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

      const config = loadGlobalConfig();
      config.runtime = { prepare: ['gradle', 'node'] };
      saveGlobalConfig(config);
      invalidateGlobalConfigCache();

      const reloaded = loadGlobalConfig();
      expect(reloaded.runtime).toEqual({ prepare: ['gradle', 'node'] });
    });
  });

  describe('provider/model compatibility validation', () => {
    it('should throw when provider block uses claude with network_access', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'provider:',
          '  type: claude',
          '  network_access: true',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/network_access/);
    });

    it('should throw when provider block uses codex with sandbox', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'provider:',
          '  type: codex',
          '  sandbox:',
          '    allow_unsandboxed_commands: true',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/sandbox/);
    });

    it('should throw when provider is codex but model is a Claude alias (opus)', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: opus\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'opus' is a Claude model alias but provider is 'codex'/);
    });

    it('should throw when provider is codex but model is sonnet', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: sonnet\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'sonnet' is a Claude model alias but provider is 'codex'/);
    });

    it('should throw when provider is codex but model is haiku', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: haiku\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'haiku' is a Claude model alias but provider is 'codex'/);
    });

    it('should not throw when provider is codex with a compatible model', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: gpt-4o\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });

    it('should not throw when provider is claude with Claude models', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: claude\nmodel: opus\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });

    it('should not throw when provider is codex without a model', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });

    it('should throw when provider is opencode but model is a Claude alias (opus)', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: opencode\nmodel: opus\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'opus' is a Claude model alias but provider is 'opencode'/);
    });

    it('should throw when provider is opencode but model is sonnet', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: opencode\nmodel: sonnet\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'sonnet' is a Claude model alias but provider is 'opencode'/);
    });

    it('should throw when provider is opencode but model is haiku', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: opencode\nmodel: haiku\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'haiku' is a Claude model alias but provider is 'opencode'/);
    });

    it('should not throw when provider is opencode with a compatible model', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: opencode\nmodel: opencode/big-pickle\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });

    it('should throw when provider is opencode without a model', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: opencode\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/provider 'opencode' requires model in 'provider\/model' format/i);
    });

    it('should throw when provider is opencode and model is not provider/model format', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: opencode\nmodel: big-pickle\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/must be in 'provider\/model' format/i);
    });
  });
});
