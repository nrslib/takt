import { describe, expect, it } from 'vitest';
import {
  mergeProviderOptions,
  normalizeProviderOptions,
  PROVIDER_OPTION_PATHS,
  resolveEffectiveProviderOptions,
  resolveEffectiveTeamLeaderPartProviderOptions,
  resolveProviderOptionOrigin,
  resolveProviderOptionSource,
  resolveProviderOptionsSources,
} from '../infra/config/providerOptions.js';
import * as providerOptionsModule from '../infra/config/providerOptions.js';
import {
  buildRawTaktProvidersOrThrow,
  denormalizeProviderOptions,
} from '../infra/config/configNormalizers.js';
import {
  PROVIDER_OPTIONS_ENV_SPECS,
  PROVIDER_OPTIONS_FILE_PREFERRED_ENV_PATHS,
  PROVIDER_OPTIONS_TRACE_PATHS,
  PROVIDER_OPTIONS_TRACKED_KEYS,
  getPresentProviderOptionPaths,
  toProviderOptionsTracePath,
} from '../infra/config/providerOptionsContract.js';
import type { StepProviderOptions } from '../core/models/workflow-provider-options.js';

function asProviderOptions(value: unknown): StepProviderOptions {
  return value as StepProviderOptions;
}

describe('resolveEffectiveProviderOptions', () => {
  it('Skill leaves do not inherit a sibling provider origin', () => {
    const resolver = (path: string) => (
      path === 'codex' || path === 'claude' ? 'env' : 'default'
    );

    expect(resolveProviderOptionOrigin(resolver, 'codex.skills.repo', 'project')).toBe('default');
    expect(resolveProviderOptionOrigin(resolver, 'codex.skills.user', 'project')).toBe('default');
    expect(resolveProviderOptionOrigin(resolver, 'claude.skills.enabled', 'project')).toBe('default');
  });

  it('env origin keeps config value only for overridden leaf', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'codex.networkAccess' ? 'env' : 'local'),
      {
        codex: { networkAccess: true },
        claude: { allowedTools: ['Read', 'Glob'] },
      },
      {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read', 'Edit'] },
      },
    );

    expect(result).toEqual({
      codex: { networkAccess: true },
      claude: { allowedTools: ['Read', 'Edit'] },
    });
  });

  it('Codex Skill inheritance is resolved independently per scope', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'codex.skills.repo' ? 'env' : 'local'),
      {
        codex: { skills: { repo: false, user: false } },
      },
      {
        codex: { skills: { repo: true } },
      },
      {
        codex: { skills: { user: true } },
      },
    );

    expect(result).toEqual({
      codex: { skills: { repo: false, user: true } },
    });
  });

  it('Claude Skill enabled resolves false from config even when other Claude leaves come from the step', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'claude.skills.enabled' ? 'env' : 'local'),
      {
        claude: { skills: { enabled: false }, effort: 'medium' },
      } as StepProviderOptions,
      {
        claude: { skills: { enabled: true }, effort: 'high' },
      } as StepProviderOptions,
    );

    expect(result).toEqual({
      claude: { skills: { enabled: false }, effort: 'high' },
    });
  });

  it('falls back to step precedence for local/global sources', () => {
    const result = resolveEffectiveProviderOptions(
      'global',
      undefined,
      { claude: { sandbox: { allowUnsandboxedCommands: true } } },
      { claude: { sandbox: { excludedCommands: ['./gradlew'] } } },
    );

    expect(result).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('env origin は codex.reasoningEffort と claude.effort にも適用される', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => {
        if (path === 'codex.reasoningEffort' || path === 'claude.effort') {
          return 'env';
        }
        return 'local';
      },
      {
        codex: { reasoningEffort: 'high' },
        claude: { effort: 'medium' },
      },
      {
        codex: { reasoningEffort: 'low' },
        claude: { effort: 'low' },
      },
    );

    expect(result).toEqual({
      codex: { reasoningEffort: 'high' },
      claude: { effort: 'medium' },
    });
  });

  it('baseUrl は step > persona > config の優先で解決される', () => {
    const configOptions = {
      codex: { baseUrl: 'http://config.example.test/v1' },
      claude: { baseUrl: 'http://config.example.test' },
    } as unknown as StepProviderOptions;
    const personaOptions = {
      codex: { baseUrl: 'http://persona.example.test/v1' },
      claude: { baseUrl: 'http://persona.example.test' },
    } as unknown as StepProviderOptions;
    const stepOptions = {
      codex: { baseUrl: 'http://step.example.test/v1' },
      claude: { baseUrl: 'http://step.example.test' },
    } as unknown as StepProviderOptions;

    const result = resolveEffectiveProviderOptions(
      'project',
      undefined,
      configOptions,
      stepOptions,
      personaOptions,
    );

    expect(result).toEqual({
      codex: { baseUrl: 'http://step.example.test/v1' },
      claude: { baseUrl: 'http://step.example.test' },
    });
  });

  it('baseUrl は env origin の config より step を優先する', () => {
    const configOptions = {
      codex: { baseUrl: 'http://env.example.test/v1' },
      claude: { baseUrl: 'http://env.example.test' },
    } as unknown as StepProviderOptions;
    const stepOptions = {
      codex: { baseUrl: 'http://step.example.test/v1' },
      claude: { baseUrl: 'http://step.example.test' },
    } as unknown as StepProviderOptions;

    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (
        path === 'codex.baseUrl' || path === 'claude.baseUrl' ? 'env' : 'local'
      ),
      configOptions,
      stepOptions,
    );

    expect(result).toEqual({
      codex: { baseUrl: 'http://step.example.test/v1' },
      claude: { baseUrl: 'http://step.example.test' },
    });

    // Given baseUrl has env origin and step value, When resolve, Then source is step
    expect(resolveProviderOptionSource(
      'codex.baseUrl',
      stepOptions,
      [],
      configOptions,
      (path) => (path === 'codex.baseUrl' ? 'env' : 'local'),
      'project',
    )).toBe('step');
  });

  it('env origin は opencode.variant の leaf にも適用される', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'opencode.variant' ? 'env' : 'local'),
      {
        opencode: {
          networkAccess: true,
          variant: 'env-high',
        },
      },
      {
        opencode: {
          networkAccess: false,
          variant: 'step-low',
        },
      },
    );

    expect(result).toEqual({
      opencode: {
        networkAccess: false,
        variant: 'env-high',
      },
    });

    // Given opencode variant has env origin, When resolve, Then source is env
    expect(resolveProviderOptionSource(
      'opencode.variant',
      { opencode: { variant: 'step-low' } },
      [],
      { opencode: { variant: 'env-high' } },
      (path) => (path === 'opencode.variant' ? 'env' : 'local'),
      'project',
    )).toBe('env');
  });

  it('env origin は opencode.allowedTools の leaf にも適用される', () => {
    const configOptions: StepProviderOptions = {
      opencode: {
        allowedTools: ['read', 'grep'],
        variant: 'env-high',
      },
    };
    const stepOptions: StepProviderOptions = {
      opencode: {
        allowedTools: ['read', 'edit'],
        variant: 'step-low',
      },
    };

    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'opencode.allowedTools' ? 'env' : 'local'),
      configOptions,
      stepOptions,
    );

    expect(result).toEqual({
      opencode: {
        allowedTools: ['read', 'grep'],
        variant: 'step-low',
      },
    });

    // Given opencode allowedTools has env origin, When resolve, Then source is env
    expect(resolveProviderOptionSource(
      'opencode.allowedTools',
      stepOptions,
      [],
      configOptions,
      (path) => (path === 'opencode.allowedTools' ? 'env' : 'local'),
      'project',
    )).toBe('env');
  });

  it('kiro.agent は step > persona > config の優先で解決される', () => {
    expect(resolveEffectiveProviderOptions(
      'project',
      undefined,
      { kiro: { agent: 'config-agent' } },
      { kiro: { agent: 'step-agent' } },
      { kiro: { agent: 'persona-agent' } },
    )).toEqual({
      kiro: { agent: 'step-agent' },
    });

    expect(resolveEffectiveProviderOptions(
      'project',
      undefined,
      { kiro: { agent: 'config-agent' } },
      undefined,
      { kiro: { agent: 'persona-agent' } },
    )).toEqual({
      kiro: { agent: 'persona-agent' },
    });

    expect(resolveEffectiveProviderOptions(
      'project',
      undefined,
      { kiro: { agent: 'config-agent' } },
      undefined,
      undefined,
    )).toEqual({
      kiro: { agent: 'config-agent' },
    });

    // Given kiro agent on step, When resolve, Then source is step
    expect(resolveProviderOptionSource(
      'kiro.agent',
      { kiro: { agent: 'step-agent' } },
      [],
      { kiro: { agent: 'config-agent' } },
      undefined,
      'project',
    )).toBe('step');
  });

  it('kiro.agent のみ指定でも結果は undefined にならない', () => {
    const result = resolveEffectiveProviderOptions(
      'global',
      undefined,
      { kiro: { agent: 'global-agent' } },
      { kiro: { agent: 'step-agent' } },
    );

    expect(result).toBeDefined();
    expect(result?.kiro).toEqual({ agent: 'step-agent' });
  });

  it('env origin は kiro.agent の leaf にも適用される', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'kiro.agent' ? 'env' : 'local'),
      { kiro: { agent: 'env-agent' } },
      { kiro: { agent: 'step-agent' } },
    );

    expect(result).toEqual({
      kiro: { agent: 'env-agent' },
    });

    // Given kiro agent has env origin, When resolve, Then source is env
    expect(resolveProviderOptionSource(
      'kiro.agent',
      { kiro: { agent: 'step-agent' } },
      [],
      { kiro: { agent: 'env-agent' } },
      (path) => (path === 'kiro.agent' ? 'env' : 'local'),
      'project',
    )).toBe('env');
  });

  it('空 sandbox object は step の leaf を潰さない', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'claude.sandbox' ? 'env' : 'local'),
      {
        claude: { sandbox: {} },
      },
      {
        claude: { sandbox: { excludedCommands: ['./gradlew'] } },
      },
    );

    expect(result).toEqual({
      claude: {
        sandbox: {
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });
});

describe('resolveEffectiveTeamLeaderPartProviderOptions', () => {
  it('part helper を module export に公開しない', () => {
    expect(providerOptionsModule).not.toHaveProperty('stripClaudeAllowedTools');
  });

  it('non-Claude part では claude.allowedTools を除去しつつ他の providerOptions は維持する', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      {
        opencode: { networkAccess: true },
        claude: {
          allowedTools: ['Read', 'Glob'],
          skills: { enabled: false },
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
      {
        opencode: { networkAccess: false },
        claude: {
          allowedTools: ['Read', 'Edit'],
          sandbox: { excludedCommands: ['./gradlew'] },
        },
      },
      'opencode',
      undefined,
    );

    expect(result).toEqual({
      opencode: { networkAccess: false },
      claude: {
        skills: { enabled: false },
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('Claude part で part_allowed_tools 未指定なら merged claude.allowedTools を維持する', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      {
        claude: {
          allowedTools: ['Read', 'Glob'],
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
      {
        claude: {
          allowedTools: ['Read', 'Edit'],
        },
      },
      'claude',
      undefined,
    );

    expect(result).toEqual({
      claude: {
        allowedTools: ['Read', 'Edit'],
        sandbox: { allowUnsandboxedCommands: true },
      },
    });
  });

  it('claude.allowedTools 除去経路でも kiro.agent は維持される', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      { kiro: { agent: 'config-agent' } },
      {
        kiro: { agent: 'step-agent' },
        claude: {
          allowedTools: ['Read', 'Edit'],
          skills: { enabled: false },
        },
      },
      'kiro',
      ['Read', 'Edit', 'Write'],
    );

    expect(result).toEqual({
      kiro: { agent: 'step-agent' },
      claude: { skills: { enabled: false } },
    });
  });

  it('part_allowed_tools を runtime で渡す場合は Claude part でも claude.allowedTools を除去する', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      {
        claude: {
          allowedTools: ['Read', 'Glob'],
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
      {
        claude: {
          allowedTools: ['Read', 'Edit'],
          skills: { enabled: false },
          sandbox: { excludedCommands: ['./gradlew'] },
        },
      },
      'claude',
      ['Read', 'Edit', 'Write'],
    );

    expect(result).toEqual({
      claude: {
        skills: { enabled: false },
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });
});

describe('resolveProviderOptionSource', () => {
  it('Given step has value, When resolve, Then source is step', () => {
    const source = resolveProviderOptionSource(
      'claude.effort',
      { claude: { effort: 'xhigh' } },
      [],
      undefined,
      undefined,
      undefined,
    );
    expect(source).toBe('step');
  });

  it('Given persona has value and step absent, When resolve, Then source is persona_providers', () => {
    const source = resolveProviderOptionSource(
      'claude.effort',
      undefined,
      [{ source: 'persona_providers', options: { claude: { effort: 'high' } } }],
      undefined,
      undefined,
      undefined,
    );
    expect(source).toBe('persona_providers');
  });

  it('Given only config has value (no resolver), When resolve, Then source derives from configSource', () => {
    expect(
      resolveProviderOptionSource(
        'claude.effort',
        undefined,
        [],
        { claude: { effort: 'medium' } },
        undefined,
        'project',
      ),
    ).toBe('project');
    expect(
      resolveProviderOptionSource(
        'claude.effort',
        undefined,
        [],
        { claude: { effort: 'medium' } },
        undefined,
        'global',
      ),
    ).toBe('global');
    expect(
      resolveProviderOptionSource(
        'claude.effort',
        undefined,
        [],
        { claude: { effort: 'medium' } },
        undefined,
        'default',
      ),
    ).toBe('default');
  });

  it('Given env/cli origin with config value, Then config wins over step/layers (mirrors selectProviderValue)', () => {
    const source = resolveProviderOptionSource(
      'claude.effort',
      { claude: { effort: 'xhigh' } },
      [{ source: 'persona_providers', options: { claude: { effort: 'high' } } }],
      { claude: { effort: 'low' } },
      () => 'cli',
      'project',
    );
    expect(source).toBe('cli');
  });

  it('Given nothing set, When resolve, Then undefined', () => {
    expect(
      resolveProviderOptionSource(
        'claude.effort',
        undefined,
        [],
        undefined,
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('Given resolver returns local for a path, When resolve, Then source maps to project', () => {
    const source = resolveProviderOptionSource(
      'codex.reasoningEffort',
      undefined,
      [],
      { codex: { reasoningEffort: 'high' } },
      (path) => (path === 'codex.reasoningEffort' ? 'local' : 'default'),
      undefined,
    );
    expect(source).toBe('project');
  });
});

describe('resolveProviderOptionsSources (all paths)', () => {
  it('returns only paths with a defined source', () => {
    const result = resolveProviderOptionsSources(
      { claude: { effort: 'xhigh' } },
      [{ source: 'persona_providers', options: { codex: { reasoningEffort: 'high' } } }],
      { copilot: { effort: 'medium' } },
      undefined,
      'global',
    );
    expect(result).toEqual({
      'claude.effort': 'step',
      'codex.reasoningEffort': 'persona_providers',
      'copilot.effort': 'global',
    });
  });

  it('returns workflow and provider_routing layer sources using merge precedence', () => {
    const result = resolveProviderOptionsSources(
      { kiro: { agent: 'step-agent' } },
      [
        {
          source: 'workflow',
          options: {
            claude: { sandbox: { excludedCommands: ['rm'] } },
            codex: { reasoningEffort: 'medium' },
          },
        },
        {
          source: 'persona_providers',
          options: { codex: { networkAccess: false } },
        },
        {
          source: 'provider_routing.personas',
          options: { codex: { reasoningEffort: 'high' } },
        },
        {
          source: 'provider_routing.tags',
          options: {
            claude: { allowedTools: ['Read'] },
            opencode: { networkAccess: false },
          },
        },
        {
          source: 'provider_routing.tags',
          options: {
            claude: { allowedTools: ['Read', 'Edit'] },
            opencode: { networkAccess: true },
          },
        },
        {
          source: 'provider_routing.steps',
          options: { opencode: { variant: 'route-step' } },
        },
      ],
      { copilot: { effort: 'medium' } },
      undefined,
      'project',
    );

    expect(result).toEqual({
      'claude.allowedTools': 'provider_routing.tags',
      'claude.sandbox.excludedCommands': 'workflow',
      'codex.networkAccess': 'persona_providers',
      'codex.reasoningEffort': 'provider_routing.personas',
      'opencode.networkAccess': 'provider_routing.tags',
      'opencode.variant': 'provider_routing.steps',
      'copilot.effort': 'project',
      'kiro.agent': 'step',
    });
  });

  it('includes Codex Skill scope sources independently', () => {
    const result = resolveProviderOptionsSources(
      { codex: { skills: { user: true } } },
      [],
      { codex: { skills: { repo: true, user: false } } },
      (path) => (path === 'codex.skills.repo' ? 'env' : 'default'),
      'env',
    );

    expect(result).toEqual({
      'codex.skills.repo': 'env',
      'codex.skills.user': 'step',
    });
  });

  it('includes kiro.agent in resolved sources when set', () => {
    const result = resolveProviderOptionsSources(
      { kiro: { agent: 'step-agent' } },
      [],
      undefined,
      undefined,
      undefined,
    );

    expect(result).toEqual({
      'kiro.agent': 'step',
    });
  });

  it('includes pi SDK options in resolved sources when set', () => {
    const result = resolveProviderOptionsSources(
      {
        pi: {
          extensions: ['npm:example-extension'],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      },
      [],
      undefined,
      undefined,
      undefined,
    );

    expect(result).toEqual({
      'pi.extensions': 'step',
      'pi.noExtensions': 'step',
      'pi.noSkills': 'step',
      'pi.noPromptTemplates': 'step',
      'pi.noThemes': 'step',
      'pi.noContextFiles': 'step',
    });
  });
});

describe('providerOptionsContract', () => {
  it('provider_options contract paths stay aligned across env and trace definitions', () => {
    const envPaths = new Set(PROVIDER_OPTIONS_ENV_SPECS.map((spec) => spec.path));

    expect(envPaths).toEqual(new Set([
      'provider_options',
      'provider_options.codex.base_url',
      'provider_options.codex.network_access',
      'provider_options.codex.reasoning_effort',
      'provider_options.codex.guards.call_timeout_ms',
      'provider_options.codex.skills.repo',
      'provider_options.codex.skills.user',
      'provider_options.opencode.network_access',
      'provider_options.opencode.variant',
      'provider_options.opencode.allowed_tools',
      'provider_options.opencode.guards.profile',
      'provider_options.opencode.guards.model_profiles',
      'provider_options.opencode.guards.call_timeout_ms',
      'provider_options.opencode.guards.event_limit',
      'provider_options.opencode.guards.text_byte_limit',
      'provider_options.opencode.guards.reasoning_byte_limit',
      'provider_options.claude.base_url',
      'provider_options.claude.effort',
      'provider_options.claude.guards.call_timeout_ms',
      'provider_options.claude.skills.enabled',
      'provider_options.claude.sandbox.allow_unsandboxed_commands',
      'provider_options.claude.sandbox.excluded_commands',
      'provider_options.claude_terminal.backend',
      'provider_options.claude_terminal.guards.call_timeout_ms',
      'provider_options.claude_terminal.timeout_ms',
      'provider_options.claude_terminal.keep_session',
      'provider_options.claude_terminal.transcript_poll_interval_ms',
      'provider_options.copilot.effort',
      'provider_options.copilot.guards.call_timeout_ms',
      'provider_options.kiro.agent',
      'provider_options.kiro.guards.call_timeout_ms',
      'provider_options.cursor.guards.call_timeout_ms',
      'provider_options.pi.extensions',
      'provider_options.pi.guards.call_timeout_ms',
      'provider_options.pi.no_extensions',
      'provider_options.pi.no_skills',
      'provider_options.pi.no_prompt_templates',
      'provider_options.pi.no_themes',
      'provider_options.pi.no_context_files',
    ]));
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.base_url');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.base_url');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.allowed_tools');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.skills.enabled');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.reasoning_effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.guards.call_timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.skills.repo');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.skills.user');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.variant');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.allowed_tools');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.guards');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.guards.model_profiles');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.guards.event_limit');
    expect(PROVIDER_OPTIONS_TRACKED_KEYS).toContain('provider_options.opencode.guards.event_limit');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.copilot.effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.copilot.guards.call_timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude_terminal.timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude_terminal.guards.call_timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.kiro');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.kiro.agent');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.kiro.guards.call_timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.cursor.guards.call_timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.guards.call_timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.extensions');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.no_extensions');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.no_skills');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.no_prompt_templates');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.no_themes');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.pi.no_context_files');
    expect(PROVIDER_OPTIONS_FILE_PREFERRED_ENV_PATHS).toEqual([
      'provider_options.codex.base_url',
      'provider_options.claude.base_url',
    ]);
  });

  it('tracked keys do not contain duplicate paths', () => {
    expect(PROVIDER_OPTIONS_TRACKED_KEYS).toHaveLength(new Set(PROVIDER_OPTIONS_TRACKED_KEYS).size);
  });

  it('maps internal provider option paths to traced-config paths', () => {
    expect(toProviderOptionsTracePath('codex.baseUrl'))
      .toBe('provider_options.codex.base_url');
    expect(toProviderOptionsTracePath('claude.baseUrl'))
      .toBe('provider_options.claude.base_url');
    expect(toProviderOptionsTracePath('claude.sandbox.allowUnsandboxedCommands'))
      .toBe('provider_options.claude.sandbox.allow_unsandboxed_commands');
    expect(toProviderOptionsTracePath('claude.allowedTools'))
      .toBe('provider_options.claude.allowed_tools');
    expect(toProviderOptionsTracePath('claude.skills.enabled'))
      .toBe('provider_options.claude.skills.enabled');
    expect(toProviderOptionsTracePath('codex.reasoningEffort'))
      .toBe('provider_options.codex.reasoning_effort');
    expect(toProviderOptionsTracePath('codex.guards.callTimeoutMs'))
      .toBe('provider_options.codex.guards.call_timeout_ms');
    expect(toProviderOptionsTracePath('codex.skills.repo'))
      .toBe('provider_options.codex.skills.repo');
    expect(toProviderOptionsTracePath('codex.skills.user'))
      .toBe('provider_options.codex.skills.user');
    expect(toProviderOptionsTracePath('opencode.variant'))
      .toBe('provider_options.opencode.variant');
    expect(toProviderOptionsTracePath('opencode.allowedTools'))
      .toBe('provider_options.opencode.allowed_tools');
    expect(toProviderOptionsTracePath('opencode.guards.modelProfiles'))
      .toBe('provider_options.opencode.guards.model_profiles');
    expect(toProviderOptionsTracePath('opencode.guards.eventLimit'))
      .toBe('provider_options.opencode.guards.event_limit');
    expect(toProviderOptionsTracePath('claudeTerminal.transcriptPollIntervalMs'))
      .toBe('provider_options.claude_terminal.transcript_poll_interval_ms');
    expect(toProviderOptionsTracePath('kiro.agent'))
      .toBe('provider_options.kiro.agent');
    expect(toProviderOptionsTracePath('pi.extensions'))
      .toBe('provider_options.pi.extensions');
    expect(toProviderOptionsTracePath('pi.noExtensions'))
      .toBe('provider_options.pi.no_extensions');
    expect(toProviderOptionsTracePath('pi.noSkills'))
      .toBe('provider_options.pi.no_skills');
    expect(toProviderOptionsTracePath('pi.noPromptTemplates'))
      .toBe('provider_options.pi.no_prompt_templates');
    expect(toProviderOptionsTracePath('pi.noThemes'))
      .toBe('provider_options.pi.no_themes');
    expect(toProviderOptionsTracePath('pi.noContextFiles'))
      .toBe('provider_options.pi.no_context_files');
  });

  it('enumerates only present provider option leaves', () => {
    expect(getPresentProviderOptionPaths({
      codex: {
        baseUrl: 'http://127.0.0.1:8787/v1',
        networkAccess: true,
        reasoningEffort: 'high',
        guards: { callTimeoutMs: 120_000 },
        skills: { repo: false, user: true },
      },
      opencode: {
        variant: 'high',
        allowedTools: ['read', 'grep'],
        guards: { eventLimit: 100_000 },
      },
      claude: {
        baseUrl: 'http://127.0.0.1:8787',
        effort: 'medium',
        guards: { callTimeoutMs: 180_000 },
        sandbox: { excludedCommands: ['rm -rf'] },
        skills: { enabled: false },
      },
      claudeTerminal: { backend: 'tmux', guards: { callTimeoutMs: 240_000 }, keepSession: false },
      copilot: { effort: 'high', guards: { callTimeoutMs: 300_000 } },
      cursor: { guards: { callTimeoutMs: 360_000 } },
    } as Parameters<typeof getPresentProviderOptionPaths>[0])).toEqual([
      'codex.baseUrl',
      'codex.networkAccess',
      'codex.reasoningEffort',
      'codex.guards.callTimeoutMs',
      'codex.skills.repo',
      'codex.skills.user',
      'opencode.variant',
      'opencode.allowedTools',
      'opencode.guards.eventLimit',
      'claude.baseUrl',
      'claude.effort',
      'claude.guards.callTimeoutMs',
      'claude.sandbox.excludedCommands',
      'claude.skills.enabled',
      'claudeTerminal.backend',
      'claudeTerminal.guards.callTimeoutMs',
      'claudeTerminal.keepSession',
      'copilot.effort',
      'copilot.guards.callTimeoutMs',
      'cursor.guards.callTimeoutMs',
    ]);
  });

  it('enumerates kiro.agent when present', () => {
    expect(getPresentProviderOptionPaths({
      kiro: { agent: 'planner-agent' },
    })).toEqual(['kiro.agent']);
  });

  it('does not enumerate kiro.agent for an empty kiro entry', () => {
    expect(getPresentProviderOptionPaths({
      kiro: {},
    })).toEqual([]);
  });

  it('enumerates pi SDK options when present', () => {
    expect(getPresentProviderOptionPaths({
      pi: {
        guards: { callTimeoutMs: 420_000 },
        extensions: ['npm:example-extension'],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    })).toEqual([
      'pi.extensions',
      'pi.guards.callTimeoutMs',
      'pi.noExtensions',
      'pi.noSkills',
      'pi.noPromptTemplates',
      'pi.noThemes',
      'pi.noContextFiles',
    ]);
  });

  it('does not enumerate Pi SDK options for an empty pi entry', () => {
    expect(getPresentProviderOptionPaths({
      pi: {},
    })).toEqual([]);
  });
});

describe('claude_terminal provider_options normalization', () => {
  it('Given snake_case claude_terminal options, When normalizeProviderOptions, Then camelCase options are returned', () => {
    const normalized = normalizeProviderOptions({
      claude_terminal: {
        backend: 'tmux',
        timeout_ms: 900000,
        keep_session: false,
        transcript_poll_interval_ms: 500,
      },
    });

    expect(normalized).toEqual({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    });
  });

  it('Given camelCase claudeTerminal options, When denormalizeProviderOptions, Then snake_case options are persisted', () => {
    const denormalized = denormalizeProviderOptions(asProviderOptions({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    }));

    expect(denormalized).toEqual({
      claude_terminal: {
        backend: 'tmux',
        timeout_ms: 900000,
        keep_session: false,
        transcript_poll_interval_ms: 500,
      },
    });
  });

  it('Given claudeTerminal options in multiple layers, When mergeProviderOptions, Then later sources override only specified fields', () => {
    const merged = mergeProviderOptions(
      asProviderOptions({
        claudeTerminal: {
          backend: 'tmux',
          timeoutMs: 900000,
          keepSession: true,
          transcriptPollIntervalMs: 1000,
        },
      }),
      asProviderOptions({
        claudeTerminal: {
          timeoutMs: 300000,
          keepSession: false,
        },
      }),
    );

    expect(merged).toEqual({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 300000,
        keepSession: false,
        transcriptPollIntervalMs: 1000,
      },
    });
  });

  it('OpenCode guards は leaf 単位でマージし modelProfiles は map ごと置換する', () => {
    const merged = mergeProviderOptions(
      {
        opencode: {
          guards: {
            profile: 'standard',
            modelProfiles: { 'global/*': 'minimal', 'shared/*': 'standard' },
            callTimeoutMs: 120_000,
            eventLimit: 2048,
            textByteLimit: 1024,
          },
        },
      },
      {
        opencode: {
          guards: {
            modelProfiles: { 'step/*': 'minimal' },
            eventLimit: 8192,
            reasoningByteLimit: 4096,
          },
        },
      },
    );

    expect(merged?.opencode?.guards).toEqual({
      profile: 'standard',
      modelProfiles: { 'step/*': 'minimal' },
      callTimeoutMs: 120_000,
      eventLimit: 8192,
      textByteLimit: 1024,
      reasoningByteLimit: 4096,
    });
  });

  it('Given config, persona, and step claudeTerminal options, When resolving effective options, Then source precedence is preserved', () => {
    const resolved = resolveEffectiveProviderOptions(
      'project',
      undefined,
      asProviderOptions({
        claudeTerminal: {
          backend: 'tmux',
          timeoutMs: 900000,
          keepSession: true,
        },
      }),
      asProviderOptions({
        claudeTerminal: {
          keepSession: false,
        },
      }),
      asProviderOptions({
        claudeTerminal: {
          transcriptPollIntervalMs: 500,
        },
      }),
    );

    expect(resolved).toEqual({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    });
  });

  it('Given provider option trace paths, When listing paths, Then claudeTerminal leaves are included', () => {
    expect(PROVIDER_OPTION_PATHS).toEqual(expect.arrayContaining([
      'claudeTerminal.backend',
      'claudeTerminal.guards.callTimeoutMs',
      'claudeTerminal.timeoutMs',
      'claudeTerminal.keepSession',
      'claudeTerminal.transcriptPollIntervalMs',
      'opencode.guards.eventLimit',
      'claude.guards.callTimeoutMs',
      'codex.guards.callTimeoutMs',
      'copilot.guards.callTimeoutMs',
      'kiro.guards.callTimeoutMs',
      'cursor.guards.callTimeoutMs',
      'pi.guards.callTimeoutMs',
    ]));
  });

  it('Given takt_providers assistant uses claude-terminal, When raw config is built, Then provider id is preserved', () => {
    const raw = buildRawTaktProvidersOrThrow({
      assistant: {
        provider: 'claude-terminal',
        model: 'opus',
      },
    });

    expect(raw).toEqual({
      assistant: {
        provider: 'claude-terminal',
        model: 'opus',
      },
    });
  });
});
