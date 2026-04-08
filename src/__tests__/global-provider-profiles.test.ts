import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';

const testHomeDir = join(tmpdir(), `takt-gpp-test-${Date.now()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

const { loadGlobalConfig, saveGlobalConfig, invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getGlobalConfigPath } = await import('../infra/config/paths.js');

describe('global provider_profiles', () => {
  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(testHomeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true });
    }
  });

  it('loads provider_profiles from yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    step_permission_overrides:',
        '      ai_fix: edit',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.providerProfiles?.codex?.defaultPermissionMode).toBe('full');
    expect(config.providerProfiles?.codex?.stepPermissionOverrides?.ai_fix).toBe('edit');
  });

  it('loads step_permission_overrides from yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    step_permission_overrides:',
        '      ai_fix: edit',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.providerProfiles?.codex?.stepPermissionOverrides?.ai_fix).toBe('edit');
  });

  it('rejects the removed provider profile override key', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    movement_permission_overrides:',
        '      ai_fix: edit',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(/movement_permission_overrides/i);
  });

  it('rejects duplicate step_permission_overrides keys at YAML parse time', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    step_permission_overrides:',
        '      ai_fix: edit',
        '    step_permission_overrides:',
        '      supervise: full',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(/Map keys must be unique/i);
  });

  it('rejects duplicate step_permission_overrides keys before custom validation', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: full',
        '    step_permission_overrides:',
        '      ai_fix: edit',
        '    step_permission_overrides:',
        '      ai_fix: full',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadGlobalConfig()).toThrow(/Map keys must be unique/i);
  });

  it('saves provider_profiles to yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.providerProfiles = {
      codex: {
        defaultPermissionMode: 'full',
        stepPermissionOverrides: {
          supervise: 'full',
        },
      },
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.providerProfiles?.codex?.defaultPermissionMode).toBe('full');
    expect(reloaded.providerProfiles?.codex?.stepPermissionOverrides?.supervise).toBe('full');
  });

  it('saves provider_profiles with canonical step_permission_overrides key', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.providerProfiles = {
      codex: {
        defaultPermissionMode: 'full',
        stepPermissionOverrides: {
          supervise: 'full',
        },
      },
    };
    saveGlobalConfig(config);

    const raw = readFileSync(getGlobalConfigPath(), 'utf-8');
    expect(raw).toContain('step_permission_overrides:');
    expect(raw).not.toContain('movement_permission_overrides:');
  });
});
