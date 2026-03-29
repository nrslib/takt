import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envVarNameFromPath } from '../infra/config/env/config-env-overrides.js';

const testRoot = join(tmpdir(), `takt-config-env-${randomUUID()}`);
const globalTaktDir = join(testRoot, 'global');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

const { loadGlobalConfig, invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { loadProjectConfig } = await import('../infra/config/project/projectConfig.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TAKT_')) {
      delete process.env[key];
    }
  }
}

afterEach(() => {
  resetEnv();
  invalidateGlobalConfigCache();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('config traced env overrides', () => {
  it('dotted path から traced-config 用の env 名を生成する', () => {
    expect(envVarNameFromPath('provider_options.claude.sandbox.allow_unsandboxed_commands'))
      .toBe('TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS');
  });

  it('global config はホワイトリストされた env のみを反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\nprovider: claude\n', 'utf-8');
    process.env.TAKT_PROVIDER = 'codex';
    process.env.TAKT_VCS_PROVIDER = 'gitlab';

    const config = loadGlobalConfig();

    expect(config.provider).toBe('codex');
    expect(config.vcsProvider).toBeUndefined();
  });

  it('project config は provider_options の leaf env override を反映する', () => {
    const projectDir = join(testRoot, 'project');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    network_access: false'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('legacy env は警告付きで global logging に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_LOG_LEVEL = 'warn';
    process.env.TAKT_OBSERVABILITY_PROVIDER_EVENTS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.logging).toEqual({
        level: 'warn',
        providerEvents: true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('新しい logging env があると legacy env は無視する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_LOG_LEVEL = 'debug';
    process.env.TAKT_LOGGING_LEVEL = 'error';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.logging).toEqual({
        level: 'error',
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
