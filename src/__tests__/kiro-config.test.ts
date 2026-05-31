import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/index.js';
import {
  ProviderBlockSchema,
  ProviderPermissionProfilesSchema,
  ProviderReferenceSchema,
  ProviderTypeSchema,
} from '../core/models/schema-base.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import {
  providerSupportsAllowedTools,
  providerSupportsMaxTurns,
  providerSupportsMcpServers,
  providerSupportsStructuredOutput,
} from '../infra/providers/provider-capabilities.js';

const testId = randomUUID();
const testDir = join(tmpdir(), `takt-kiro-config-test-${testId}`);
const taktDir = join(testDir, '.takt');
const configPath = join(taktDir, 'config.yaml');

function createExecutableFile(filename: string): string {
  const filePath = join(testDir, filename);
  writeFileSync(filePath, '#!/bin/sh\necho kiro\n', 'utf-8');
  chmodSync(filePath, 0o755);
  return filePath;
}

const {
  loadGlobalConfig,
  saveGlobalConfig,
  resolveKiroApiKey,
  resolveKiroCliPath,
  invalidateGlobalConfigCache,
} = await import('../infra/config/global/globalConfig.js');

describe('Kiro provider schema', () => {
  it('Given provider type kiro, When parsed, Then it is accepted everywhere provider references are accepted', () => {
    expect(ProviderTypeSchema.parse('kiro')).toBe('kiro');
    expect(ProviderReferenceSchema.parse('kiro')).toBe('kiro');
    expect(ProviderBlockSchema.parse({ type: 'kiro' })).toEqual({ type: 'kiro' });
    expect(GlobalConfigSchema.parse({ provider: 'kiro' }).provider).toBe('kiro');
  });

  it('Given Kiro provider block with unsupported options, When parsed, Then it fails fast', () => {
    expect(() =>
      ProviderBlockSchema.parse({
        type: 'kiro',
        network_access: true,
      }),
    ).toThrow(/provider-specific options|network_access/i);

    expect(() =>
      ProviderBlockSchema.parse({
        type: 'kiro',
        sandbox: { allow_unsandboxed_commands: true },
      }),
    ).toThrow(/provider-specific options|sandbox/i);
  });

  it('Given provider_profiles.kiro permission profile, When parsed, Then Kiro key is accepted', () => {
    const parsed = ProviderPermissionProfilesSchema.parse({
      kiro: {
        default_permission_mode: 'edit',
        step_permission_overrides: {
          inspect: 'readonly',
        },
      },
    });

    expect(parsed?.kiro?.default_permission_mode).toBe('edit');
    expect(parsed?.kiro?.step_permission_overrides?.inspect).toBe('readonly');
  });

  it('Given provider_profiles.kiro type field, When parsed, Then it fails fast as an unsupported contract', () => {
    expect(() =>
      ProviderPermissionProfilesSchema.parse({
        kiro: {
          type: 'kiro',
        },
      }),
    ).toThrow(/type/i);
  });

  it('Given unknown provider profile key, When parsed, Then it fails fast', () => {
    expect(() =>
      ProviderPermissionProfilesSchema.parse({
        unknown_provider: {
          default_permission_mode: 'edit',
        },
      }),
    ).toThrow(/unknown_provider|unrecognized/i);
  });

  it('Given empty provider profile, When parsed, Then it fails fast instead of defaulting permissions', () => {
    expect(() =>
      ProviderPermissionProfilesSchema.parse({
          kiro: {},
        }),
    ).toThrow(/default_permission_mode/i);
  });

  it('Given workflow and step provider kiro, When normalized, Then Kiro provider is preserved', () => {
    const config = normalizeWorkflowConfig({
      name: 'kiro-workflow',
      workflow_config: {
        provider: 'kiro',
      },
      steps: [
        {
          name: 'implement',
          provider: 'kiro',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    }, process.cwd());

    expect(config.provider).toBe('kiro');
    expect(config.steps[0]?.provider).toBe('kiro');
  });

  it('Given project config contains Kiro global-only fields, When parsed, Then it fails fast', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        provider: 'kiro',
        kiro_cli_path: '/usr/local/bin/kiro-cli',
      }),
    ).toThrow(/kiro_cli_path/i);

    expect(() =>
      ProjectConfigSchema.parse({
        provider: 'kiro',
        kiro_api_key: 'kiro-secret',
      }),
    ).toThrow(/kiro_api_key/i);
  });
});

describe('Kiro global config', () => {
  const originalApiKey = process.env.TAKT_KIRO_API_KEY;
  const originalOfficialApiKey = process.env.KIRO_API_KEY;
  const originalCliPath = process.env.TAKT_KIRO_CLI_PATH;
  const originalConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    mkdirSync(taktDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = taktDir;
    delete process.env.TAKT_KIRO_API_KEY;
    delete process.env.KIRO_API_KEY;
    delete process.env.TAKT_KIRO_CLI_PATH;
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.TAKT_KIRO_API_KEY = originalApiKey;
    } else {
      delete process.env.TAKT_KIRO_API_KEY;
    }
    if (originalOfficialApiKey !== undefined) {
      process.env.KIRO_API_KEY = originalOfficialApiKey;
    } else {
      delete process.env.KIRO_API_KEY;
    }
    if (originalCliPath !== undefined) {
      process.env.TAKT_KIRO_CLI_PATH = originalCliPath;
    } else {
      delete process.env.TAKT_KIRO_CLI_PATH;
    }
    if (originalConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    invalidateGlobalConfigCache();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('Given kiro config fields in YAML, When loaded, Then camelCase config fields are populated', () => {
    const kiroPath = createExecutableFile('config-kiro-cli');
    writeFileSync(
      configPath,
      [
        'language: en',
        'provider: kiro',
        `kiro_cli_path: ${kiroPath}`,
        'kiro_api_key: kiro-from-yaml',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.provider).toBe('kiro');
    expect(config.kiroCliPath).toBe(kiroPath);
    expect(config.kiroApiKey).toBe('kiro-from-yaml');
  });

  it('Given Kiro fields in config object, When saved and reloaded, Then YAML round-trips canonical snake_case keys', () => {
    writeFileSync(configPath, 'language: en\nprovider: kiro\n', 'utf-8');

    const config = loadGlobalConfig();
    config.kiroCliPath = createExecutableFile('saved-kiro-cli');
    config.kiroApiKey = 'kiro-saved';
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('kiro_cli_path:');
    expect(raw).toContain('kiro_api_key: kiro-saved');

    const reloaded = loadGlobalConfig();
    expect(reloaded.kiroCliPath).toBe(config.kiroCliPath);
    expect(reloaded.kiroApiKey).toBe('kiro-saved');
  });

  it('Given TAKT_KIRO_API_KEY, When resolver runs, Then env wins over YAML', () => {
    process.env.TAKT_KIRO_API_KEY = 'kiro-from-env';
    process.env.KIRO_API_KEY = 'kiro-from-official-env';
    writeFileSync(
      configPath,
      [
        'language: en',
        'provider: kiro',
        'kiro_api_key: kiro-from-yaml',
      ].join('\n'),
      'utf-8',
    );

    expect(resolveKiroApiKey()).toBe('kiro-from-env');
  });

  it('Given no TAKT_KIRO_API_KEY, When resolver runs, Then YAML Kiro API key wins over official KIRO_API_KEY', () => {
    process.env.KIRO_API_KEY = 'kiro-from-official-env';
    writeFileSync(
      configPath,
      [
        'language: en',
        'provider: kiro',
        'kiro_api_key: kiro-from-yaml',
      ].join('\n'),
      'utf-8',
    );

    expect(resolveKiroApiKey()).toBe('kiro-from-yaml');
  });

  it('Given only official KIRO_API_KEY, When resolver runs, Then official Kiro key is used', () => {
    process.env.KIRO_API_KEY = 'kiro-from-official-env';
    writeFileSync(
      configPath,
      [
        'language: en',
        'provider: kiro',
      ].join('\n'),
      'utf-8',
    );

    expect(resolveKiroApiKey()).toBe('kiro-from-official-env');
  });

  it('Given TAKT_KIRO_CLI_PATH, When resolver runs, Then env executable path wins over YAML', () => {
    const envPath = createExecutableFile('env-kiro-cli');
    const yamlPath = createExecutableFile('yaml-kiro-cli');
    process.env.TAKT_KIRO_CLI_PATH = envPath;
    writeFileSync(
      configPath,
      [
        'language: en',
        'provider: kiro',
        `kiro_cli_path: ${yamlPath}`,
      ].join('\n'),
      'utf-8',
    );

    expect(resolveKiroCliPath()).toBe(envPath);
  });

  it('Given invalid TAKT_KIRO_CLI_PATH, When resolver runs, Then it throws the CLI path validation error', () => {
    process.env.TAKT_KIRO_CLI_PATH = join(testDir, 'missing-kiro-cli');

    expect(() => resolveKiroCliPath()).toThrow(/does not exist/i);
  });
});

describe('Kiro provider capabilities', () => {
  it('Given Kiro provider, When capability predicates run, Then unsupported cross-provider options are disabled', () => {
    expect(providerSupportsStructuredOutput('kiro')).toBe(false);
    expect(providerSupportsAllowedTools('kiro')).toBe(false);
    expect(providerSupportsMcpServers('kiro')).toBe(false);
    expect(providerSupportsMaxTurns('kiro')).toBe(false);
  });
});
