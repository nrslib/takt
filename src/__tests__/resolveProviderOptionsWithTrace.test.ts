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
const defaultClaudeSkills = { enabled: false } as const;

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

  it('未指定の Codex と Claude Skill 設定を false として解決する', () => {
    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: { skills: defaultClaudeSkills },
    });
    expect(result.source).toBe('default');
    expect(result.originResolver('codex.skills.repo')).toBe('default');
    expect(result.originResolver('codex.skills.user')).toBe('default');
    expect(result.originResolver('claude.skills.enabled')).toBe('default');
  });

  it('非 workflow の global 設定で未知の DeepSeek option を拒否する', () => {
    writeFileSync(
      globalConfigPath,
      [
        'language: en',
        'provider_options:',
        '  deepseek_harness:',
        '    unsupported: true',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    expect(() => resolveNonWorkflowProviderOptions(projectDir))
      .toThrow(/unsupported/iu);
  });

  it('Codex profile env は非 Codex の選択時に Codex permission control を要求しない', () => {
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE = 'review';

    const options = resolveNonWorkflowProviderOptions(projectDir, undefined, undefined, 'opencode');

    expect(options?.codex?.configProfile).toBe('review');
    expect(() => resolveNonWorkflowProviderOptions(projectDir, undefined, undefined, 'codex'))
      .toThrow(/config_profile requires permission_control: codex/);
  });

  it('既定の Skill 設定を解決結果ごとに分離する', () => {
    const first = resolveProviderOptionsWithTrace(projectDir);
    const firstCodexSkills = first.value?.codex?.skills;
    const firstClaudeSkills = first.value?.claude?.skills;
    expect(firstCodexSkills).toBeDefined();
    expect(firstClaudeSkills).toBeDefined();
    firstCodexSkills!.repo = true;
    firstClaudeSkills!.enabled = true;

    invalidateAllResolvedConfigCache();

    const second = resolveProviderOptionsWithTrace(projectDir);

    expect(second.value?.codex?.skills).toEqual(defaultCodexSkills);
    expect(second.value?.claude?.skills).toEqual(defaultClaudeSkills);
  });

  it('呼び出し固有の default を明示設定より低い優先度で解決する', () => {
    const execDefaults = { repo: true, user: true };
    expect(resolveNonWorkflowProviderOptions(projectDir, undefined, execDefaults)).toEqual({
      codex: { skills: execDefaults },
      claude: { skills: defaultClaudeSkills },
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
      claude: { skills: defaultClaudeSkills },
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
      claude: { skills: defaultClaudeSkills },
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
      claude: { allowedTools: ['Read'], skills: defaultClaudeSkills },
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
      claude: { allowedTools: ['Read'], skills: defaultClaudeSkills },
      codex: { networkAccess: false, skills: defaultCodexSkills },
    });
    expect(result.originResolver('claude.allowedTools')).toBe('global');
    expect(result.originResolver('codex.networkAccess')).toBe('local');
  });

  it('Codex config profile を global/project/env の優先順位と trace 付きで解決する', () => {
    writeFileSync(
      globalConfigPath,
      [
        'language: en',
        'provider_options:',
        '  codex:',
        '    config_profile: global-review',
        '    permission_control: codex',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    config_profile: project-review'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE = 'env-review';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value?.codex).toMatchObject({ configProfile: 'env-review' });
    expect(result.originResolver('codex.configProfile')).toBe('env');
    expect(result.source).toBe('env');
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
      claude: { effort: 'high', skills: defaultClaudeSkills },
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
      claude: { effort: 'max', skills: defaultClaudeSkills },
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
      claude: { skills: defaultClaudeSkills },
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
      claude: { skills: defaultClaudeSkills },
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
      claude: { effort: 'max', skills: defaultClaudeSkills },
    });
    expect(result.originResolver('claude.effort')).toBe('env');
  });

  it('deepseekHarness.reasoningEffort の env override を traced-config 実経路で返す', () => {
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: deepseek-harness\n', 'utf-8');
    process.env.TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_REASONING_EFFORT = 'max';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.source).toBe('env');
    expect(result.value?.deepseekHarness).toEqual({ reasoningEffort: 'max' });
    expect(result.originResolver('deepseekHarness.reasoningEffort')).toBe('env');
  });

  it.each([undefined, 'max'])('rejects root JSON DeepSeek effort with dedicated override %s', (leafEffort) => {
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({
      deepseek_harness: { reasoning_effort: 'high' },
    });
    if (leafEffort !== undefined) {
      process.env.TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_REASONING_EFFORT = leafEffort;
    }

    expect(() => resolveProviderOptionsWithTrace(projectDir)).toThrow(/reasoning_effort.*runtime profile/iu);
  });

  it('keeps dedicated DeepSeek env provenance alongside unrelated root JSON options', () => {
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({ codex: { reasoning_effort: 'low' } });
    process.env.TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_REASONING_EFFORT = 'max';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value).toMatchObject({
      codex: { reasoningEffort: 'low' }, deepseekHarness: { reasoningEffort: 'max' },
    });
    expect(result.originResolver('deepseekHarness.reasoningEffort')).toBe('env');
  });

  it('rejects an unsupported DeepSeek reasoning effort from the env override', () => {
    process.env.TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_REASONING_EFFORT = 'medium';

    expect(() => resolveProviderOptionsWithTrace(projectDir)).toThrow(/reasoning_effort|medium/iu);
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
      claude: { allowedTools: ['Bash'], skills: defaultClaudeSkills },
    });
    expect(result.originResolver('claude.allowedTools')).toBe('env');
    expect(result.originResolver('codex.networkAccess')).toBe('env');
  });

  it.each([true, false])('global の Codex permission control と project の network_access=%s を trace 付きで解決する', (networkAccess) => {
    writeFileSync(
      globalConfigPath,
      [
        'language: en',
        'provider_options:',
        '  codex:',
        '    permission_control: codex',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();

    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', `    network_access: ${networkAccess}`].join('\n'),
      'utf-8',
    );

    const result = resolveProviderOptionsWithTrace(projectDir);
    if (result.value === undefined) {
      throw new Error('Expected provider options to resolve');
    }

    expect(result.value.codex).toMatchObject({
      permissionControl: 'codex',
      networkAccess,
    });
    expect(result.originResolver('codex.permissionControl')).toBe('global');
    expect(result.originResolver('codex.networkAccess')).toBe('local');
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
        '  deepseek_harness:',
        '    base_url: http://global.example.test/deepseek',
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
    process.env.TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL = 'http://env.example.test/deepseek';

    const result = resolveProviderOptionsWithTrace(projectDir);

    expect(result.value).toEqual({
      codex: {
        baseUrl: 'http://global.example.test/v1',
        networkAccess: false,
        skills: defaultCodexSkills,
      },
      claude: { baseUrl: 'http://global.example.test', skills: defaultClaudeSkills },
      deepseekHarness: {
        baseUrl: 'http://global.example.test/deepseek',
      },
    });
    expect(result.originResolver('codex.baseUrl')).toBe('global');
    expect(result.originResolver('claude.baseUrl')).toBe('global');
    expect(result.originResolver('deepseekHarness.baseUrl')).toBe('global');
    expect(result.originResolver('codex.networkAccess')).toBe('local');
  });
});
