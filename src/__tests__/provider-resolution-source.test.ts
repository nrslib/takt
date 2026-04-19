import { describe, expect, it } from 'vitest';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';

describe('resolveStepProviderModel — source attribution (#370)', () => {
  it('Given persona override, When resolve, Then source is persona_providers', () => {
    const result = resolveStepProviderModel({
      step: { provider: 'codex', model: 'step-model', personaDisplayName: 'coder' },
      provider: 'claude',
      providerSource: 'global',
      model: 'engine-model',
      modelSource: 'global',
      personaProviders: { coder: { provider: 'opencode', model: 'persona-model' } },
    });

    expect(result.provider).toBe('opencode');
    expect(result.providerSource).toBe('persona_providers');
    expect(result.model).toBe('persona-model');
    expect(result.modelSource).toBe('persona_providers');
  });

  it('Given step override (no persona), When resolve, Then source is step', () => {
    const result = resolveStepProviderModel({
      step: { provider: 'codex', model: 'step-model', personaDisplayName: 'coder' },
      provider: 'claude',
      providerSource: 'global',
      model: 'engine-model',
      modelSource: 'global',
    });

    expect(result.providerSource).toBe('step');
    expect(result.modelSource).toBe('step');
  });

  it('Given no step/persona override, When resolve, Then source is inherited from engine', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      providerSource: 'cli',
      model: 'sonnet',
      modelSource: 'project',
    });

    expect(result.providerSource).toBe('cli');
    expect(result.modelSource).toBe('project');
  });

  it('Given nothing resolves, When resolve, Then sources are undefined', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
    });

    expect(result.provider).toBeUndefined();
    expect(result.providerSource).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.modelSource).toBeUndefined();
  });

  it('Given persona with only provider, When resolve, Then model source falls back to engine', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      providerSource: 'global',
      model: 'sonnet',
      modelSource: 'global',
      personaProviders: { coder: { provider: 'codex' } },
    });

    expect(result.providerSource).toBe('persona_providers');
    expect(result.modelSource).toBe('global');
  });

  it('Given engine source is undefined but value is set, When resolve, Then source is undefined (caller must set)', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      model: 'sonnet',
    });

    expect(result.provider).toBe('claude');
    expect(result.providerSource).toBeUndefined();
    expect(result.modelSource).toBeUndefined();
  });
});
