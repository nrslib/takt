import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

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
  resolveNonWorkflowProviderOptions,
  invalidateAllResolvedConfigCache,
} = await import('../infra/config/resolveConfigValue.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');
const { resolveEffectiveProviderOptions } = await import('../infra/config/providerOptions.js');

let taktEnvSnapshot: TaktEnvSnapshot;
const defaultCodexSkills = { repo: false, user: false } as const;

describe('resolveProviderOptionsWithTrace', () => {
  let projectDir: string;

  beforeEach(() => {
    taktEnvSnapshot = clearTaktEnv();
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
    restoreTaktEnv(taktEnvSnapshot);
  });

  it('未指定の Codex Skill 継承を scope ごとに false として解決する', () => {
    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value).toEqual({ codex: { skills: defaultCodexSkills } });
    expect(result.source).toBe('default');
    expect(result.originResolver('codex.skills.repo')).toBe('default');
    expect(result.originResolver('codex.skills.user')).toBe('default');
  });

  it('呼び出し固有の default を明示設定より低い優先度で解決する', () => {
    const execDefaults = { repo: true, user: true };
    expect(resolveNonWorkflowProviderOptions(projectDir, undefined, execDefaults)).toEqual({
      codex: { skills: execDefaults },
    });

    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    skills:', '      repo: false'].join('\n'),
      'utf-8',
    );
    invalidateAllResolvedConfigCache();

    expect(resolveNonWorkflowProviderOptions(projectDir, undefined, execDefaults)).toEqual({
      codex: { skills: { repo: false, user: true } },
    });
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
    expect(result.value).toEqual({
      codex: { networkAccess: true, skills: defaultCodexSkills },
    });
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
    expect(result.value).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: { allowedTools: ['Read'] },
    });
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
      codex: { networkAccess: false, skills: defaultCodexSkills },
    });
    expect(result.originResolver('claude.allowedTools')).toBe('global');
    expect(result.originResolver('codex.networkAccess')).toBe('local');
  });

  it('provider_options の effort 系キーも trace 付きで解決する', () => {
    writeFileSync(
      globalConfigPath,
      [
        'language: en',
        'provider_options:',
        '  codex:',
        '    reasoning_effort: medium',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  claude:',
        '    effort: high',
      ].join('\n'),
      'utf-8',
    );

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value).toEqual({
      codex: { reasoningEffort: 'medium', skills: defaultCodexSkills },
      claude: { effort: 'high' },
    });
    expect(result.originResolver('codex.reasoningEffort')).toBe('global');
    expect(result.originResolver('claude.effort')).toBe('local');
  });

  it('provider_options の effort 系 env override を source=env として返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  codex:',
        '    reasoning_effort: low',
        '  claude:',
        '    effort: low',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_REASONING_EFFORT = 'high';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_EFFORT = 'max';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value).toEqual({
      codex: { reasoningEffort: 'high', skills: defaultCodexSkills },
      claude: { effort: 'max' },
    });
    expect(result.originResolver('codex.reasoningEffort')).toBe('env');
    expect(result.originResolver('claude.effort')).toBe('env');
  });

  it('opencode.variant の env override を source=env として返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  opencode:',
        '    network_access: true',
        '    variant: low',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT = 'high';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value).toEqual({
      codex: { skills: defaultCodexSkills },
      opencode: {
        networkAccess: true,
        variant: 'high',
      },
    });
    expect(result.originResolver('opencode.networkAccess')).toBe('local');
    expect(result.originResolver('opencode.variant')).toBe('env');
  });

  it('codex.reasoning_effort の env override を traced-config 実経路で返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    reasoning_effort: low'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_REASONING_EFFORT = 'high';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value).toEqual({
      codex: { reasoningEffort: 'high', skills: defaultCodexSkills },
    });
    expect(result.originResolver('codex.reasoningEffort')).toBe('env');
  });

  it('claude.effort の env override を traced-config 実経路で返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  claude:', '    effort: low'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_EFFORT = 'max';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: { effort: 'max' },
    });
    expect(result.originResolver('claude.effort')).toBe('env');
  });

  it('provider_options の root JSON env override 配下も leaf origin を env として返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  codex:',
        '    network_access: false',
        '  claude:',
        '    allowed_tools:',
        '      - Read',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({
      claude: {
        allowed_tools: ['Bash'],
      },
    });

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: { allowedTools: ['Bash'] },
    });
    expect(result.originResolver('claude.allowedTools')).toBe('env');
    expect(result.originResolver('codex.networkAccess')).toBe('env');
  });

  it('片方だけ指定した Codex Skill scope の未指定値を default のまま保つ', () => {
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({
      codex: { skills: { repo: true } },
    });

    const resolved = resolveProviderOptionsWithTrace(projectDir);
    const effective = resolveEffectiveProviderOptions(
      resolved.source,
      resolved.originResolver,
      resolved.value,
      { codex: { skills: { user: true } } },
    );

    expect(resolved.originResolver('codex.skills.repo')).toBe('env');
    expect(resolved.originResolver('codex.skills.user')).toBe('default');
    expect(effective?.codex?.skills).toEqual({ repo: true, user: true });
  });

  it('global config の base_url 明示値を project env fallback より優先する', () => {
    writeFileSync(
      globalConfigPath,
      [
        'language: en',
        'provider_options:',
        '  codex:',
        '    base_url: http://global.example.test/v1',
        '  claude:',
        '    base_url: http://global.example.test',
      ].join('\n'),
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
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL = 'http://env.example.test/v1';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL = 'http://env.example.test';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value).toEqual({
      codex: {
        baseUrl: 'http://global.example.test/v1',
        networkAccess: false,
        skills: defaultCodexSkills,
      },
      claude: { baseUrl: 'http://global.example.test' },
    });
    expect(result.originResolver('codex.baseUrl')).toBe('global');
    expect(result.originResolver('claude.baseUrl')).toBe('global');
    expect(result.originResolver('codex.networkAccess')).toBe('local');
  });
});
