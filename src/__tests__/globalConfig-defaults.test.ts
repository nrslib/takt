/**
 * Tests for loadGlobalConfig default values when config.yaml is missing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import {
  unexpectedInteractivePreviewConfigKey,
  unexpectedInteractivePreviewEnvVar,
} from '../../test/helpers/unknown-contract-test-keys.js';

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
    delete process.env.TAKT_INTERACTIVE_PREVIEW_STEPS;
    delete process.env[unexpectedInteractivePreviewEnvVar];
  });

  it('should return default values when config.yaml does not exist', () => {
    const config = loadGlobalConfig();

    expect(config.language).toBe('en');
    expect(config.provider).toBe('claude');
    expect(config.model).toBeUndefined();
  });

  it('should not have project-local fields set by default', () => {
    const config = loadGlobalConfig();

    expect(config.pipeline).toBeUndefined();
    expect(config.personaProviders).toBeUndefined();
    expect(config.branchNameStrategy).toBeUndefined();
    expect(config.minimalOutput).toBeUndefined();
    expect(config.concurrency).toBeUndefined();
    expect(config.taskPollIntervalMs).toBeUndefined();
    expect(config.interactivePreviewSteps).toBeUndefined();
  });

  it('should accept project-local keys in global config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'pipeline:',
        '  default_branch_prefix: "global/"',
        'persona_providers:',
        '  coder:',
        '    provider: codex',
        'branch_name_strategy: ai',
        'minimal_output: true',
        'concurrency: 3',
        'task_poll_interval_ms: 1000',
        'interactive_preview_steps: 2',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).not.toThrow();
    const config = loadGlobalConfig();
    expect(config.pipeline).toEqual({ defaultBranchPrefix: 'global/' });
    expect(config.personaProviders).toEqual({ coder: { provider: 'codex' } });
    expect(config.branchNameStrategy).toBe('ai');
    expect(config.minimalOutput).toBe(true);
    expect(config.concurrency).toBe(3);
    expect(config.taskPollIntervalMs).toBe(1000);
    expect(config.interactivePreviewSteps).toBe(2);
  });

  it('should load takt_providers.assistant from global config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider: codex',
        'model: gpt-5.4',
        'takt_providers:',
        '  assistant:',
        '    provider: claude',
        '    model: haiku',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.taktProviders).toEqual({
      assistant: { provider: 'claude', model: 'haiku' },
    });
  });

  it('should persist project-local keys when saving global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.pipeline = { defaultBranchPrefix: 'global/' };
    config.personaProviders = { coder: { provider: 'codex' } };
    config.branchNameStrategy = 'ai';
    config.minimalOutput = true;
    config.concurrency = 4;
    config.taskPollIntervalMs = 1200;
    config.interactivePreviewSteps = 1;
    config.allowGitHooks = true;
    config.allowGitFilters = true;
    saveGlobalConfig(config);

    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('pipeline:');
    expect(raw).toContain('persona_providers:');
    expect(raw).toContain('branch_name_strategy:');
    expect(raw).toContain('minimal_output:');
    expect(raw).toContain('concurrency:');
    expect(raw).toContain('task_poll_interval_ms:');
    expect(raw).toContain('interactive_preview_steps:');
    expect(raw).toContain('allow_git_hooks: true');
    expect(raw).toContain('allow_git_filters: true');
  });

  it('should load persona_providers provider_options from global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'persona_providers:',
        '  reviewer:',
        '    provider_options:',
        '      claude:',
        '        allowed_tools:',
        '          - Read',
        '          - Edit',
        '      codex:',
        '        reasoning_effort: high',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.personaProviders).toEqual({
      reviewer: {
        providerOptions: {
          claude: { allowedTools: ['Read', 'Edit'] },
          codex: { reasoningEffort: 'high' },
        },
      },
    });
  });

  it('should save personaProviders providerOptions as snake_case keys in global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.personaProviders = {
      reviewer: {
        providerOptions: {
          claude: {
            allowedTools: ['Read', 'Edit'],
            sandbox: {
              allowUnsandboxedCommands: true,
              excludedCommands: ['./gradlew'],
            },
          },
          codex: { reasoningEffort: 'high' },
          copilot: { effort: 'high' },
        },
      },
    };
    saveGlobalConfig(config);

    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('persona_providers:');
    expect(raw).toContain('provider_options:');
    expect(raw).toContain('allowed_tools:');
    expect(raw).toContain('allow_unsandboxed_commands: true');
    expect(raw).toContain('excluded_commands:');
    expect(raw).toContain('reasoning_effort: high');
    expect(raw).toContain('copilot:');
    expect(raw).toContain('effort: high');
    expect(raw).not.toContain('providerOptions:');
    expect(raw).not.toContain('allowedTools:');
  });

  it('should reject empty nested persona_providers provider_options during load', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'persona_providers:',
        '  reviewer:',
        '    provider_options:',
        '      claude: {}',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(/provider_options.*at least one provider-specific option/i);
  });

  it('should fail fast when saving empty personaProviders providerOptions in global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.personaProviders = {
      reviewer: {
        providerOptions: {},
      },
    };

    expect(() => saveGlobalConfig(config)).toThrow(
      /persona_providers\.reviewer\.provider_options must include at least one provider-specific option/i,
    );
  });

  it('should persist takt_providers.assistant when saving global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.provider = 'codex';
    config.model = 'gpt-5.4';
    config.taktProviders = {
      assistant: { provider: 'claude', model: 'haiku' },
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.taktProviders).toEqual({
      assistant: { provider: 'claude', model: 'haiku' },
    });

    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('takt_providers:');
    expect(raw).toContain('assistant:');
    expect(raw).toContain('provider: claude');
    expect(raw).toContain('model: haiku');
  });

  it('should fail fast on load when takt_providers.assistant has incompatible provider/model', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'takt_providers:',
        '  assistant:',
        '    provider: codex',
        '    model: opus',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(/Claude model alias/);
  });

  it('should fail fast on save when taktProviders is set without assistant', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.taktProviders = {} as unknown as NonNullable<typeof config.taktProviders>;

    expect(() => saveGlobalConfig(config)).toThrow(/taktProviders\.assistant/);
  });

  it('should fail fast on save when taktProviders.assistant has incompatible provider/model', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.taktProviders = {
      assistant: {
        provider: 'codex',
        model: 'opus',
      },
    };

    expect(() => saveGlobalConfig(config)).toThrow(/Claude model alias/);
  });

  it('should fail fast on save when taktProviders.assistant is empty object', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.taktProviders = {
      assistant: {} as NonNullable<typeof config.taktProviders>['assistant'],
    };

    expect(() => saveGlobalConfig(config)).toThrow(/takt_providers\.assistant/);
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
        '  copilot:',
        '    effort: high',
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
      copilot: { effort: 'high' },
    });
    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('provider_options:');
    expect(raw).toContain('copilot:');
    expect(raw).toContain('effort: high');
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

  it('should accept pipeline in global config', () => {
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
    const config = loadGlobalConfig();
    expect(config.pipeline).toEqual({
      defaultBranchPrefix: 'feat/',
      commitMessageTemplate: 'fix: {title} (#{issue})',
    });
  });

  it('should save and reload pipeline config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.pipeline = {
      defaultBranchPrefix: 'takt/',
      commitMessageTemplate: 'feat: {title} (#{issue})',
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.pipeline).toEqual({
      defaultBranchPrefix: 'takt/',
      commitMessageTemplate: 'feat: {title} (#{issue})',
    });
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
        '  workflow_complete: true',
        '  workflow_abort: true',
        '  run_complete: true',
        '  run_abort: false',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.notificationSoundEvents).toEqual({
      iterationLimit: false,
      workflowComplete: true,
      workflowAbort: true,
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
      workflowComplete: true,
      workflowAbort: false,
      runComplete: true,
      runAbort: true,
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.notificationSoundEvents).toEqual({
      iterationLimit: false,
      workflowComplete: true,
      workflowAbort: false,
      runComplete: true,
      runAbort: true,
    });
  });

  it('should accept interactive_preview_steps in global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\ninteractive_preview_steps: 6\n',
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.interactivePreviewSteps).toBe(6);
  });

  it('should reject unknown interactive preview key in global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      `language: en\n${unexpectedInteractivePreviewConfigKey}: 6\n`,
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(new RegExp(`${unexpectedInteractivePreviewConfigKey}|unrecognized`, 'i'));
  });

  it('should save and reload interactive_preview_steps config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.interactivePreviewSteps = 7;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.interactivePreviewSteps).toBe(7);
  });

  it('should save interactive preview count with canonical step key', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.interactivePreviewSteps = 8;
    saveGlobalConfig(config);

    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('interactive_preview_steps: 8');
  });

  it('should default interactive_preview_steps to undefined', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    expect(config.interactivePreviewSteps).toBeUndefined();
  });

  it('should accept interactive_preview_steps=0 in global config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\ninteractive_preview_steps: 0\n',
      'utf-8',
    );

    expect(() => loadGlobalConfig()).not.toThrow();
    const config = loadGlobalConfig();
    expect(config.interactivePreviewSteps).toBe(0);
  });

  it('should accept TAKT_INTERACTIVE_PREVIEW_STEPS for global config env override', () => {
    process.env.TAKT_INTERACTIVE_PREVIEW_STEPS = '9';

    const config = loadGlobalConfig();

    expect(config.interactivePreviewSteps).toBe(9);
  });

  it('should ignore unknown interactive preview env override for global config', () => {
    process.env[unexpectedInteractivePreviewEnvVar] = '4';

    const config = loadGlobalConfig();

    expect(config.interactivePreviewSteps).toBeUndefined();
  });

  it('should prefer canonical interactive preview env override over unknown env for global config', () => {
    process.env[unexpectedInteractivePreviewEnvVar] = '4';
    process.env.TAKT_INTERACTIVE_PREVIEW_STEPS = '9';

    const config = loadGlobalConfig();

    expect(config.interactivePreviewSteps).toBe(9);
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

  it('should throw when global config contains unknown top-level field that is not tracked', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'unknown_top_level: true',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(/unrecognized/i);
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

    it('should load workflow_runtime_prepare from config.yaml', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'language: en',
          'workflow_runtime_prepare:',
          '  custom_scripts: true',
        ].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig();
      expect(config.workflowRuntimePrepare).toEqual({ customScripts: true });
    });

    it('should save and reload workflow_runtime_prepare', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

      const config = loadGlobalConfig();
      config.workflowRuntimePrepare = { customScripts: true };
      saveGlobalConfig(config);
      invalidateGlobalConfigCache();

      const reloaded = loadGlobalConfig();
      expect(reloaded.workflowRuntimePrepare).toEqual({ customScripts: true });
    });
  });

  describe('workflow_arpeggio global config', () => {
    it('should load workflow_arpeggio from config.yaml', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'language: en',
          'workflow_arpeggio:',
          '  custom_data_source_modules: true',
          '  custom_merge_inline_js: false',
          '  custom_merge_files: true',
        ].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig();
      expect(config.workflowArpeggio).toEqual({
        customDataSourceModules: true,
        customMergeInlineJs: false,
        customMergeFiles: true,
      });
    });

    it('should save and reload workflow_arpeggio', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

      const config = loadGlobalConfig();
      config.workflowArpeggio = { customDataSourceModules: true, customMergeInlineJs: true, customMergeFiles: false };
      saveGlobalConfig(config);
      invalidateGlobalConfigCache();

      const reloaded = loadGlobalConfig();
      expect(reloaded.workflowArpeggio).toEqual({ customDataSourceModules: true, customMergeInlineJs: true, customMergeFiles: false });
    });
  });

  describe('sync_conflict_resolver global config', () => {
    it('should load sync_conflict_resolver from config.yaml', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'language: en',
          'sync_conflict_resolver:',
          '  auto_approve_tools: true',
        ].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig();
      expect(config.syncConflictResolver).toEqual({ autoApproveTools: true });
    });

    it('should save and reload sync_conflict_resolver', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

      const config = loadGlobalConfig();
      config.syncConflictResolver = { autoApproveTools: true };
      saveGlobalConfig(config);
      invalidateGlobalConfigCache();

      const reloaded = loadGlobalConfig();
      expect(reloaded.syncConflictResolver).toEqual({ autoApproveTools: true });
    });
  });

  describe('sync_project_local_takt_on_retry global config', () => {
    it('should load sync_project_local_takt_on_retry from config.yaml', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        ['language: en', 'sync_project_local_takt_on_retry: false'].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig() as Record<string, unknown>;
      expect(config.syncProjectLocalTaktOnRetry).toBe(false);
    });

    it('should save and reload sync_project_local_takt_on_retry', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

      const config = loadGlobalConfig() as Record<string, unknown>;
      config.syncProjectLocalTaktOnRetry = false;
      saveGlobalConfig(config);
      invalidateGlobalConfigCache();

      const reloaded = loadGlobalConfig() as Record<string, unknown>;
      expect(reloaded.syncProjectLocalTaktOnRetry).toBe(false);
    });
  });

  describe('workflow_mcp_servers global config', () => {
    it('should load workflow_mcp_servers from config.yaml', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        ['language: en', 'workflow_mcp_servers:', '  stdio: true', '  sse: false', '  http: true'].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig();
      expect(config.workflowMcpServers).toEqual({ stdio: true, sse: false, http: true });
    });

    it('should save and reload workflow_mcp_servers', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

      const config = loadGlobalConfig();
      config.workflowMcpServers = { stdio: true, sse: true };
      saveGlobalConfig(config);
      invalidateGlobalConfigCache();

      const reloaded = loadGlobalConfig();
      expect(reloaded.workflowMcpServers).toEqual({ stdio: true, sse: true });
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

    it('should allow claude sandbox in provider block and normalize providerOptions', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        [
          'provider:',
          '  type: claude',
          '  model: sonnet',
          '  sandbox:',
          '    allow_unsandboxed_commands: true',
          '    excluded_commands:',
          '      - ./gradlew',
        ].join('\n'),
        'utf-8',
      );

      const config = loadGlobalConfig();

      expect(config.provider).toBe('claude');
      expect(config.model).toBe('sonnet');
      expect(config.providerOptions).toEqual({
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
            excludedCommands: ['./gradlew'],
          },
        },
      });
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
