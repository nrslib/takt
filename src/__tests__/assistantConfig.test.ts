import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testId = randomUUID();
const testDir = join(tmpdir(), `takt-assistant-config-test-${testId}`);
const globalTaktDir = join(testDir, 'global-takt');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

const { resolveAssistantConfigLayers } = await import('../features/interactive/assistantConfig.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { invalidateAllResolvedConfigCache } = await import('../infra/config/resolveConfigValue.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');

describe('assistantConfig', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(testDir, `project-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalTaktDir, { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should resolve assistant config layers separately for local and global config', () => {
    writeFileSync(
      globalConfigPath,
      [
        'language: en',
        'provider: claude',
        'model: global-model',
        'takt_providers:',
        '  assistant:',
        '    provider: codex',
        '    model: global-assistant-model',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider: opencode',
        'model: local-model',
        'takt_providers:',
        '  assistant:',
        '    provider: mock',
        '    model: local-assistant-model',
      ].join('\n'),
      'utf-8',
    );

    expect(resolveAssistantConfigLayers(projectDir)).toEqual({
      local: {
        provider: 'opencode',
        model: 'local-model',
        taktProviders: {
          assistant: {
            provider: 'mock',
            model: 'local-assistant-model',
          },
        },
      },
      global: {
        provider: 'claude',
        model: 'global-model',
        taktProviders: {
          assistant: {
            provider: 'codex',
            model: 'global-assistant-model',
          },
        },
      },
    });
  });

  it('should keep assistant-only resolver out of infra config public exports', async () => {
    const infraConfig = await import('../infra/config/index.js');

    expect('resolveAssistantConfigLayers' in infraConfig).toBe(false);
  });
});
