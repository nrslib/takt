import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OPTION_PATHS,
  resolveProviderOptionSource,
  resolveProviderOptionsSources,
} from '../infra/config/providerOptions.js';
import type { StepProviderOptions } from '../core/models/workflow-provider-options.js';

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

  it('Given kiro agent on step, When resolve, Then source is step', () => {
    const source = resolveProviderOptionSource(
      'kiro.agent',
      { kiro: { agent: 'step-agent' } },
      [],
      { kiro: { agent: 'config-agent' } },
      undefined,
      'project',
    );

    expect(source).toBe('step');
  });

  it('Given kiro agent has env origin, When resolve, Then source is env', () => {
    const source = resolveProviderOptionSource(
      'kiro.agent',
      { kiro: { agent: 'step-agent' } },
      [],
      { kiro: { agent: 'env-agent' } },
      (path) => (path === 'kiro.agent' ? 'env' : 'local'),
      'project',
    );

    expect(source).toBe('env');
  });

  it('Given opencode variant has env origin, When resolve, Then source is env', () => {
    const source = resolveProviderOptionSource(
      'opencode.variant',
      { opencode: { variant: 'step-low' } },
      [],
      { opencode: { variant: 'env-high' } },
      (path) => (path === 'opencode.variant' ? 'env' : 'local'),
      'project',
    );

    expect(source).toBe('env');
  });

  it('Given opencode allowedTools has env origin, When resolve, Then source is env', () => {
    const stepOptions: StepProviderOptions = { opencode: { allowedTools: ['read', 'edit'] } };
    const configOptions: StepProviderOptions = { opencode: { allowedTools: ['read', 'grep'] } };

    const source = resolveProviderOptionSource(
      'opencode.allowedTools',
      stepOptions,
      [],
      configOptions,
      (path) => (path === 'opencode.allowedTools' ? 'env' : 'local'),
      'project',
    );

    expect(source).toBe('env');
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

  it('exposes the full list of tracked paths', () => {
    expect(PROVIDER_OPTION_PATHS).toContain('claude.effort');
    expect(PROVIDER_OPTION_PATHS).toContain('codex.reasoningEffort');
    expect(PROVIDER_OPTION_PATHS).toContain('opencode.variant');
    expect(PROVIDER_OPTION_PATHS).toContain('opencode.allowedTools');
    expect(PROVIDER_OPTION_PATHS).toContain('copilot.effort');
    expect(PROVIDER_OPTION_PATHS).toContain('kiro.agent');
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
});
