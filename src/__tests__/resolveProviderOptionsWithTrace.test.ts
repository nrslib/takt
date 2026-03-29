import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testId = randomUUID();
const testDir = join(tmpdir(), `takt-provider-trace-${testId}`);
const globalTaktDir = join(testDir, 'global-takt');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

const {
  resolveProviderOptionsWithTrace,
  invalidateAllResolvedConfigCache,
} = await import('../infra/config/resolveConfigValue.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');

describe('resolveProviderOptionsWithTrace', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(testDir, `project-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
  });

  it('project provider_options の env override を source=env として返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    network_access: false'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value).toEqual({ codex: { networkAccess: true } });
    expect(result.originResolver('codex.networkAccess')).toBe('env');
    expect(result.originResolver('claude.allowedTools')).toBe('local');
  });

  it('global provider_options の file origin を global として返す', () => {
    writeFileSync(
      globalConfigPath,
      ['language: en', 'provider_options:', '  claude:', '    allowed_tools:', '      - Read'].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('global');
    expect(result.value).toEqual({ claude: { allowedTools: ['Read'] } });
    expect(result.originResolver('claude.allowedTools')).toBe('global');
  });

  it('project と global の provider_options を統合し key ごとの origin を返す', () => {
    writeFileSync(
      globalConfigPath,
      ['language: en', 'provider_options:', '  claude:', '    allowed_tools:', '      - Read'].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    network_access: false'].join('\n'),
      'utf-8',
    );

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('project');
    expect(result.value).toEqual({
      claude: { allowedTools: ['Read'] },
      codex: { networkAccess: false },
    });
    expect(result.originResolver('claude.allowedTools')).toBe('global');
    expect(result.originResolver('codex.networkAccess')).toBe('local');
  });
});
