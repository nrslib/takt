import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testId = randomUUID();
const testDir = join(tmpdir(), `takt-assistant-config-test-${testId}`);
const globalTaktDir = join(testDir, 'global-takt');
const globalConfigPath = join(globalTaktDir, 'config.yaml');
const { mockConfirm, mockResolveTtyPolicy } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockResolveTtyPolicy: vi.fn(),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

vi.mock('../shared/prompt/confirm.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/prompt/tty.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTtyPolicy: () => mockResolveTtyPolicy(),
}));

const { resolveAssistantConfigLayers } = await import('../features/interactive/assistantConfig.js');
const taskInstructionFormat = await import('../features/interactive/taskInstructionFormat.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { invalidateAllResolvedConfigCache } = await import('../infra/config/resolveConfigValue.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');

type FormalSpecResolverModule = {
  resolveFormalSpecConfiguration(projectDir: string): Promise<{ mode: boolean; comments: boolean }>;
  resolveFormalSpecConfigurationWithoutPrompt(projectDir: string): { mode: boolean; comments: boolean };
  resolveFormalSpecMode(projectDir: string): Promise<boolean>;
  resolveFormalSpecModeWithoutPrompt(projectDir: string): boolean;
};

const {
  resolveFormalSpecConfiguration,
  resolveFormalSpecConfigurationWithoutPrompt,
  resolveFormalSpecMode,
  resolveFormalSpecModeWithoutPrompt,
} = taskInstructionFormat as unknown as FormalSpecResolverModule;

describe('assistantConfig', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(testDir, `project-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalTaktDir, { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockConfirm.mockReset();
    mockResolveTtyPolicy.mockReturnValue({ useTty: false, forceTouchTty: false });
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

  it.each([
    ['global false', false, undefined, false],
    ['global true', true, undefined, true],
    ['project false override', true, false, false],
    ['project true override', false, true, true],
  ] as const)(
    'should resolve boolean formal specification mode from %s without asking',
    async (_label, globalFormalSpec, projectFormalSpec, expected) => {
      if (globalFormalSpec !== undefined) {
        writeFileSync(
          globalConfigPath,
          ['language: en', 'assistant:', `  formal_spec: ${globalFormalSpec}`].join('\n'),
          'utf-8',
        );
      }

      if (projectFormalSpec !== undefined) {
        const configDir = getProjectConfigDir(projectDir);
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, 'config.yaml'),
          ['assistant:', `  formal_spec: ${projectFormalSpec}`].join('\n'),
          'utf-8',
        );
      }

      await expect(resolveFormalSpecMode(projectDir)).resolves.toBe(expected);
      expect(mockConfirm).not.toHaveBeenCalled();
    },
  );

  it('should resolve structured formal_spec mode and comments independently across project and global layers', () => {
    writeFileSync(
      globalConfigPath,
      ['language: en', 'assistant:', '  formal_spec:', '    mode: true'].join('\n'),
      'utf-8',
    );
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['assistant:', '  formal_spec:', '    comments: false'].join('\n'),
      'utf-8',
    );

    expect(resolveFormalSpecConfigurationWithoutPrompt(projectDir)).toEqual({
      mode: true,
      comments: false,
    });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should treat a scalar formal_spec as mode-only and inherit structured comments from the global layer', () => {
    writeFileSync(
      globalConfigPath,
      ['language: en', 'assistant:', '  formal_spec:', '    comments: false'].join('\n'),
      'utf-8',
    );
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['assistant:', "  formal_spec: 'Y/n'"].join('\n'),
      'utf-8',
    );

    expect(resolveFormalSpecConfigurationWithoutPrompt(projectDir)).toEqual({
      mode: true,
      comments: false,
    });
  });

  it('should keep comments enabled by default when no layer specifies comments', async () => {
    mockResolveTtyPolicy.mockReturnValue({ useTty: false, forceTouchTty: false });

    await expect(resolveFormalSpecConfiguration(projectDir)).resolves.toEqual({
      mode: false,
      comments: true,
    });
  });

  it.each([
    ['Y/n', 'y/N', false],
    ['y/N', 'Y/n', true],
  ] as const)(
    'should let project formal_spec override global formal_spec=%s with %s',
    async (globalFormalSpec, projectFormalSpec, expected) => {
      writeFileSync(
        globalConfigPath,
        ['language: en', 'assistant:', `  formal_spec: '${globalFormalSpec}'`].join('\n'),
        'utf-8',
      );
      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.yaml'),
        ['assistant:', `  formal_spec: '${projectFormalSpec}'`].join('\n'),
        'utf-8',
      );

      await expect(resolveFormalSpecMode(projectDir)).resolves.toBe(expected);
      expect(mockConfirm).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Y/n', true],
    ['y/N', false],
    [undefined, false],
  ] as const)(
    'should ask once on a TTY for formal_spec=%s with default=%s',
    async (formalSpec, defaultYes) => {
      mockResolveTtyPolicy.mockReturnValue({ useTty: true, forceTouchTty: false });
      mockConfirm.mockResolvedValue(!defaultYes);
      if (formalSpec !== undefined) {
        const configDir = getProjectConfigDir(projectDir);
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, 'config.yaml'),
          ['assistant:', `  formal_spec: '${formalSpec}'`].join('\n'),
          'utf-8',
        );
      }

      await expect(resolveFormalSpecMode(projectDir)).resolves.toBe(!defaultYes);
      expect(mockConfirm).toHaveBeenCalledOnce();
      expect(mockConfirm).toHaveBeenCalledWith(expect.stringMatching(/Alloy.*Quint|Quint.*Alloy/i), defaultYes);
      expect(String(mockConfirm.mock.calls[0]?.[0])).toContain('assistant.formal_spec');
    },
  );

  it.each([
    ['en', /formal specification mode/i],
    ['ja', /形式仕様モード/],
  ] as const)('should localize the formal specification question for language=%s', async (language, messagePattern) => {
    writeFileSync(globalConfigPath, `language: ${language}\n`, 'utf-8');
    mockResolveTtyPolicy.mockReturnValue({ useTty: true, forceTouchTty: false });
    mockConfirm.mockResolvedValue(false);

    await resolveFormalSpecMode(projectDir);

    expect(mockConfirm).toHaveBeenCalledWith(expect.stringMatching(messagePattern), false);
    expect(String(mockConfirm.mock.calls[0]?.[0])).toMatch(/Alloy.*Quint|Quint.*Alloy/i);
    expect(String(mockConfirm.mock.calls[0]?.[0])).toContain('assistant.formal_spec');
  });

  it.each([
    ['Y/n', true],
    ['y/N', false],
    [undefined, false],
  ] as const)(
    'should use the configured default without asking when formal_spec=%s is resolved outside a TTY',
    async (formalSpec, expected) => {
      if (formalSpec !== undefined) {
        const configDir = getProjectConfigDir(projectDir);
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, 'config.yaml'),
          ['assistant:', `  formal_spec: '${formalSpec}'`].join('\n'),
          'utf-8',
        );
      }

      await expect(resolveFormalSpecMode(projectDir)).resolves.toBe(expected);
      expect(mockConfirm).not.toHaveBeenCalled();
    },
  );

  it('should keep answers session-local and resolve again for a new session', async () => {
    mockResolveTtyPolicy.mockReturnValue({ useTty: true, forceTouchTty: false });
    const configDir = getProjectConfigDir(projectDir);
    const configPath = join(configDir, 'config.yaml');
    const original = ['assistant:', "  formal_spec: 'y/N'"].join('\n');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, original, 'utf-8');
    mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(resolveFormalSpecMode(projectDir)).resolves.toBe(true);
    await expect(resolveFormalSpecMode(projectDir)).resolves.toBe(false);

    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it.each([
    ['Y/n', true],
    ['y/N', false],
    [undefined, false],
  ] as const)(
    'should resolve ACP formal_spec=%s synchronously without prompting',
    (formalSpec, expected) => {
      if (formalSpec !== undefined) {
        const configDir = getProjectConfigDir(projectDir);
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, 'config.yaml'),
          ['assistant:', `  formal_spec: '${formalSpec}'`].join('\n'),
          'utf-8',
        );
      }

      expect(resolveFormalSpecModeWithoutPrompt(projectDir)).toBe(expected);
      expect(mockConfirm).not.toHaveBeenCalled();
    },
  );

  it('should keep assistant-only resolver out of infra config public exports', async () => {
    const infraConfig = await import('../infra/config/index.js');

    expect('resolveAssistantConfigLayers' in infraConfig).toBe(false);
  });
});
