import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OPTION_PATHS,
  resolveProviderOptionSource,
  resolveProviderOptionsSources,
} from '../infra/config/providerOptions.js';

describe('resolveProviderOptionSource', () => {
  it('Given step has value, When resolve, Then source is step', () => {
    const source = resolveProviderOptionSource(
      'claude.effort',
      { claude: { effort: 'xhigh' } },
      undefined,
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
      { claude: { effort: 'high' } },
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
        undefined,
        { claude: { effort: 'medium' } },
        undefined,
        'project',
      ),
    ).toBe('project');
    expect(
      resolveProviderOptionSource(
        'claude.effort',
        undefined,
        undefined,
        { claude: { effort: 'medium' } },
        undefined,
        'global',
      ),
    ).toBe('global');
    expect(
      resolveProviderOptionSource(
        'claude.effort',
        undefined,
        undefined,
        { claude: { effort: 'medium' } },
        undefined,
        'default',
      ),
    ).toBe('default');
  });

  it('Given env/cli origin with config value, Then config wins over step/persona (mirrors selectProviderValue)', () => {
    const source = resolveProviderOptionSource(
      'claude.effort',
      { claude: { effort: 'xhigh' } },
      undefined,
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
        undefined,
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
      undefined,
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
      { codex: { reasoningEffort: 'high' } },
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

  it('exposes the full list of tracked paths', () => {
    expect(PROVIDER_OPTION_PATHS).toContain('claude.effort');
    expect(PROVIDER_OPTION_PATHS).toContain('codex.reasoningEffort');
    expect(PROVIDER_OPTION_PATHS).toContain('copilot.effort');
  });
});
