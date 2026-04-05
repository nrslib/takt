import { describe, expect, it } from 'vitest';
import {
  resolveAgentProviderModel,
  resolveMovementProviderModel,
} from '../core/piece/provider-resolution.js';
import {
  resolveModelFromCandidates,
  resolveProviderModelCandidates,
} from '../core/provider-resolution.js';
import { resolveAssistantProviderModelFromConfig } from '../core/config/provider-resolution.js';

describe('resolveProviderModelCandidates', () => {
  it('should resolve first defined provider and model independently', () => {
    const result = resolveProviderModelCandidates([
      { provider: undefined, model: 'model-1' },
      { provider: 'codex', model: undefined },
      { provider: 'claude', model: 'model-2' },
    ]);

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('model-1');
  });

  it('should return undefined fields when all candidates are undefined', () => {
    const result = resolveProviderModelCandidates([
      {},
      { provider: undefined, model: undefined },
    ]);

    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });
});

describe('resolveMovementProviderModel', () => {
  it('should prefer personaProviders.provider over step.provider when both are defined', () => {
    const result = resolveMovementProviderModel({
      step: { provider: 'codex', model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { provider: 'opencode' } },
    });

    expect(result.provider).toBe('opencode');
  });

  it('should use personaProviders.provider when step.provider is undefined', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'reviewer' },
      provider: 'claude',
      personaProviders: { reviewer: { provider: 'opencode' } },
    });

    expect(result.provider).toBe('opencode');
  });

  it('should fallback to input.provider when persona mapping is missing', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'unknown' },
      provider: 'mock',
      personaProviders: { reviewer: { provider: 'codex' } },
    });

    expect(result.provider).toBe('mock');
  });

  it('should return undefined provider when all provider candidates are missing', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'none' },
      provider: undefined,
      personaProviders: undefined,
    });

    expect(result.provider).toBeUndefined();
  });

  it('should prefer personaProviders.model over step.model and input.model', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: 'step-model', personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    expect(result.model).toBe('persona-model');
  });

  it('should use personaProviders.model when step.model is undefined', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    expect(result.model).toBe('persona-model');
  });

  it('should fallback to input.model when step.model and personaProviders.model are undefined', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex' } },
    });

    expect(result.model).toBe('input-model');
  });

  it('should return undefined model when all model candidates are missing', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: undefined,
      personaProviders: { coder: { provider: 'codex' } },
    });

    expect(result.model).toBeUndefined();
  });

  it('should resolve provider from personaProviders entry with only model specified', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { model: 'o3-mini' } },
    });

    expect(result.provider).toBe('claude');
    expect(result.model).toBe('o3-mini');
  });

  it('should resolve cursor provider from personaProviders', () => {
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { provider: 'cursor' } },
    });

    expect(result.provider).toBe('cursor');
  });
});

describe('resolveAgentProviderModel', () => {
  it.each([
    {
      name: 'CLI overrides every other layer and also overrides model',
      input: {
        cliProvider: 'codex' as const,
        cliModel: 'cli-model',
        personaProviders: {
          coder: { provider: 'mock' as const, model: 'persona-model' },
        },
        personaDisplayName: 'coder',
        localProvider: 'opencode' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'codex' as const, model: 'cli-model' },
    },
    {
      name: 'Persona provider wins when CLI is absent',
      input: {
        personaProviders: {
          coder: { provider: 'mock' as const, model: 'persona-model' },
        },
        personaDisplayName: 'coder',
        localProvider: 'opencode' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'mock' as const, model: 'persona-model' },
    },
    {
      name: 'Persona model wins while provider comes from local config',
      input: {
        personaProviders: {
          coder: { model: 'persona-only-model' },
        },
        personaDisplayName: 'coder',
        localProvider: 'claude' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'claude' as const, model: 'persona-only-model' },
    },
    {
      name: 'Local provider is used when no higher-priority provider exists',
      input: {
        localProvider: 'opencode' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'opencode' as const, model: 'local-model' },
    },
    {
      name: 'Global is used when local provider is absent',
      input: {
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'mock' as const, model: 'global-model' },
    },
    {
      name: 'CLI model is used even when provider comes from local and no CLI provider',
      input: {
        cliModel: 'cli-model',
        localProvider: 'mock' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'mock' as const, model: 'cli-model' },
    },
    {
      name: 'Local model is ignored when it does not match resolved provider',
      input: {
        cliProvider: 'opencode' as const,
        localProvider: 'codex' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'opencode' as const, model: undefined },
    },
    {
      name: 'Global model is used when it matches resolved provider',
      input: {
        cliProvider: 'claude' as const,
        localProvider: 'opencode' as const,
        localModel: 'local-model',
        globalProvider: 'claude' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'claude' as const, model: 'global-model' },
    },
    {
      name: 'Local model is preferred when both local and global providers match',
      input: {
        localProvider: 'mock' as const,
        localModel: 'local-model',
        globalProvider: 'mock' as const,
        globalModel: 'global-model',
      },
      expected: { provider: 'mock' as const, model: 'local-model' },
    },
    {
      name: 'Unknown persona name falls back to normal chain without persona model/provider',
      input: {
        personaProviders: {
          reviewer: { provider: 'mock' as const, model: 'persona-model' },
        },
        personaDisplayName: 'coder',
        localProvider: 'mock' as const,
        localModel: 'local-model',
      },
      expected: { provider: 'mock' as const, model: 'local-model' },
    },
    {
      name: 'No providers defined and no models defined -> all undefined',
      input: {},
      expected: { provider: undefined, model: undefined },
    },
    {
      name: 'Only CLI model with persona-only model and no provider leaves provider unresolved',
      input: {
        cliModel: 'cli-model',
        personaProviders: {
          coder: { model: 'persona-model' },
        },
        personaDisplayName: 'coder',
      },
      expected: { provider: undefined, model: 'cli-model' },
    },
  ])('should resolve %s', ({ input, expected }) => {
    const result = resolveAgentProviderModel(input);
    expect(result).toEqual(expected);
  });

  it('should resolve provider in order: CLI > persona > local > global', () => {
    const result = resolveAgentProviderModel({
      cliProvider: 'opencode',
      localProvider: 'codex',
      globalProvider: 'claude',
      personaProviders: { coder: { provider: 'mock' } },
      personaDisplayName: 'coder',
    });

    expect(result.provider).toBe('opencode');
  });

  it('should use persona override when no CLI provider is set', () => {
    const result = resolveAgentProviderModel({
      localProvider: 'codex',
      globalProvider: 'claude',
      personaProviders: { coder: { provider: 'opencode', model: 'persona-model' } },
      personaDisplayName: 'coder',
    });

    expect(result.provider).toBe('opencode');
    expect(result.model).toBe('persona-model');
  });

  it('should fall back to local provider when persona override is not configured', () => {
    const result = resolveAgentProviderModel({
      localProvider: 'codex',
      globalProvider: 'claude',
      personaProviders: { reviewer: { provider: 'mock', model: 'o3-mini' } },
      personaDisplayName: 'coder',
    });

    expect(result.provider).toBe('codex');
  });

  it('should prefer local config provider/model over global config for same provider', () => {
    const result = resolveAgentProviderModel({
      localProvider: 'codex',
      localModel: 'local-model',
      globalProvider: 'codex',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('local-model');
  });

  it('should prefer global config when local config is not set', () => {
    const result = resolveAgentProviderModel({
      localProvider: undefined,
      globalProvider: 'claude',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('claude');
    expect(result.model).toBe('global-model');
  });

  it('should resolve model order: CLI > persona > config candidate matching provider', () => {
    const result = resolveAgentProviderModel({
      cliModel: 'cli-model',
      localProvider: 'claude',
      localModel: 'local-model',
      globalProvider: 'codex',
      globalModel: 'global-model',
      cliProvider: 'codex',
      personaProviders: { coder: { model: 'persona-model' } },
      personaDisplayName: 'coder',
    });

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('cli-model');
  });

  it('should use local model when persona model is absent and provider matches local', () => {
    const result = resolveAgentProviderModel({
      localProvider: 'opencode',
      localModel: 'local-model',
      globalProvider: 'codex',
      globalModel: 'global-model',
      personaProviders: { coder: { provider: 'opencode' } },
      personaDisplayName: 'coder',
    });

    expect(result.provider).toBe('opencode');
    expect(result.model).toBe('local-model');
  });

  it('should apply local/ global model only when provider matches resolved provider', () => {
    const result = resolveAgentProviderModel({
      cliProvider: 'codex',
      localProvider: 'claude',
      localModel: 'local-model',
      globalProvider: 'codex',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('global-model');
  });

  it('should ignore local and global model when provider does not match', () => {
    const result = resolveAgentProviderModel({
      cliProvider: 'opencode',
      localProvider: 'codex',
      localModel: 'local-model',
      globalProvider: 'claude',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('opencode');
    expect(result.model).toBeUndefined();
  });

  it('should apply full priority chain when all layers are present', () => {
    const result = resolveAgentProviderModel({
      cliProvider: 'codex',
      cliModel: 'cli-model',
      personaProviders: {
        reviewer: {
          provider: 'mock',
          model: 'persona-model',
        },
      },
      personaDisplayName: 'reviewer',
      localProvider: 'opencode',
      localModel: 'local-model',
      globalProvider: 'claude',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('cli-model');
  });

  it('should apply full priority chain without cli overrides', () => {
    const result = resolveAgentProviderModel({
      personaProviders: {
        reviewer: {
          provider: 'mock',
          model: 'persona-model',
        },
      },
      personaDisplayName: 'reviewer',
      localProvider: 'opencode',
      localModel: 'local-model',
      globalProvider: 'claude',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('mock');
    expect(result.model).toBe('persona-model');
  });

  it('should keep model and provider priorities consistent for fallback path', () => {
    const result = resolveAgentProviderModel({
      localProvider: 'codex',
      localModel: 'local-model',
      globalProvider: 'claude',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('local-model');
  });

  it('should keep model fallback after persona-only model when provider comes from local', () => {
    const result = resolveAgentProviderModel({
      personaProviders: {
        reviewer: {
          model: 'persona-model',
        },
      },
      personaDisplayName: 'reviewer',
      localProvider: 'codex',
      localModel: 'local-model',
      globalProvider: 'codex',
      globalModel: 'global-model',
    });

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('persona-model');
  });
});

describe('resolveModelFromCandidates', () => {
  it('should ignore model candidates whose provider does not match the resolved provider', () => {
    const result = resolveModelFromCandidates([
      { model: 'cli-model' },
      { model: 'local-model', provider: 'codex' },
      { model: 'global-model', provider: 'claude' },
    ], 'claude');

    expect(result).toBe('cli-model');
  });

  it('should pick the first provider-matching config model when unscoped candidates are absent', () => {
    const result = resolveModelFromCandidates([
      { model: 'local-model', provider: 'codex' },
      { model: 'global-model', provider: 'claude' },
    ], 'claude');

    expect(result).toBe('global-model');
  });
});

describe('resolveAssistantProviderModelFromConfig', () => {
  it('should prioritize CLI over local/global assistant and top-level provider/model', () => {
    const result = resolveAssistantProviderModelFromConfig(
      {
        local: {
          provider: 'opencode',
          model: 'local-model',
          taktProviders: {
            assistant: {
              provider: 'claude',
              model: 'local-assistant-model',
            },
          },
        },
        global: {
          provider: 'mock',
          model: 'global-model',
          taktProviders: {
            assistant: {
              provider: 'codex',
              model: 'global-assistant-model',
            },
          },
        },
      },
      {
        provider: 'cursor',
        model: 'cli-model',
      },
    );

    expect(result).toEqual({
      provider: 'cursor',
      model: 'cli-model',
    });
  });

  it('should prefer local assistant over global assistant when CLI is missing', () => {
    const result = resolveAssistantProviderModelFromConfig({
      local: {
        provider: 'opencode',
        model: 'local-model',
        taktProviders: {
          assistant: {
            provider: 'claude',
            model: 'local-assistant-model',
          },
        },
      },
      global: {
        provider: 'mock',
        model: 'global-model',
        taktProviders: {
          assistant: {
            provider: 'codex',
            model: 'global-assistant-model',
          },
        },
      },
    });

    expect(result).toEqual({
      provider: 'claude',
      model: 'local-assistant-model',
    });
  });

  it('should prioritize CLI model even when provider is resolved from assistant config', () => {
    const result = resolveAssistantProviderModelFromConfig(
      {
        local: {
          provider: 'opencode',
          model: 'local-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'claude',
              model: 'local-assistant-model',
            },
          },
        },
        global: {
          provider: 'mock',
          model: 'global-top-level-model',
        },
      },
      {
        model: 'cli-model',
      },
    );

    expect(result).toEqual({
      provider: 'claude',
      model: 'cli-model',
    });
  });

  it('should prefer global assistant over top-level config when local assistant is missing', () => {
    const result = resolveAssistantProviderModelFromConfig({
      local: {
        provider: 'opencode',
        model: 'local-model',
      },
      global: {
        provider: 'mock',
        model: 'global-model',
        taktProviders: {
          assistant: {
            provider: 'codex',
            model: 'global-assistant-model',
          },
        },
      },
    });

    expect(result).toEqual({
      provider: 'codex',
      model: 'global-assistant-model',
    });
  });

  it('should ignore assistant and top-level models that do not match CLI provider when only CLI provider is set', () => {
    const result = resolveAssistantProviderModelFromConfig(
      {
        local: {
          provider: 'claude',
          model: 'local-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'claude',
              model: 'local-assistant-model',
            },
          },
        },
        global: {
          provider: 'opencode',
          model: 'global-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'codex',
              model: 'global-assistant-model',
            },
          },
        },
      },
      {
        provider: 'cursor',
      },
    );

    expect(result).toEqual({
      provider: 'cursor',
      model: undefined,
    });
  });

  it('should ignore top-level models when their provider does not match the resolved provider', () => {
    const result = resolveAssistantProviderModelFromConfig({
      local: {
        provider: 'opencode',
        model: 'local-top-level-model',
      },
      global: {
        provider: 'mock',
        model: 'global-top-level-model',
        taktProviders: {
          assistant: {
            provider: 'claude',
          },
        },
      },
    });

    expect(result).toEqual({
      provider: 'claude',
      model: undefined,
    });
  });

  it('should fallback from local top-level to global top-level when assistant entries are absent', () => {
    const result = resolveAssistantProviderModelFromConfig({
      local: {},
      global: {
        provider: 'mock',
        model: 'global-model',
      },
    });

    expect(result).toEqual({
      provider: 'mock',
      model: 'global-model',
    });
  });
});
