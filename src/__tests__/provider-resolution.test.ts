import { describe, expect, it } from 'vitest';
import {
  resolveAgentProviderModel,
  resolveStepProviderModel,
  resolveWorkflowCallProviderModel,
} from '../core/workflow/provider-resolution.js';
import { resolveLoopMonitorJudgeProviderModel } from '../core/workflow/provider-resolution.js';
import {
  resolveModelFromCandidates,
  resolveProviderModelCandidates,
} from '../core/provider-resolution.js';
import {
  resolveAssistantProviderModelFromConfig,
  resolveAssistantScopedProviderModelFromConfig,
  resolveNonWorkflowProviderModelFromConfig,
} from '../core/config/provider-resolution.js';
import { buildFindingManagerStep } from '../core/workflow/findings/manager-step.js';
import type { ProjectConfig } from '../core/models/config-types.js';

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

describe('resolveStepProviderModel', () => {
  it.each([
    {
      label: 'provider only',
      providerSource: 'env' as const,
      modelSource: 'project' as const,
      expected: {
        provider: 'mock',
        providerSource: 'env',
        model: 'step-model',
        modelSource: 'step',
      },
    },
    {
      label: 'model only',
      providerSource: 'project' as const,
      modelSource: 'env' as const,
      expected: {
        provider: 'codex',
        providerSource: 'step',
        model: 'env-model',
        modelSource: 'env',
      },
    },
    {
      label: 'provider and model',
      providerSource: 'env' as const,
      modelSource: 'env' as const,
      expected: {
        provider: 'mock',
        providerSource: 'env',
        model: 'env-model',
        modelSource: 'env',
      },
    },
  ])('should keep environment $label above step, routing, persona, and auto routing', ({
    providerSource,
    modelSource,
    expected,
  }) => {
    const result = resolveStepProviderModel({
      step: {
        name: 'implement',
        provider: 'codex',
        model: 'step-model',
        personaDisplayName: 'coder',
        tags: ['coding'],
      },
      provider: 'mock',
      providerSource,
      model: 'env-model',
      modelSource,
      providerRouting: {
        steps: { implement: { provider: 'claude', model: 'routing-model' } },
      },
      personaProviders: {
        coder: { provider: 'opencode', model: 'persona-model' },
      },
      autoRouting: {
        strategy: 'cost',
        router: { provider: 'mock', model: 'router-model' },
        candidates: [],
      },
    });

    expect(result).toEqual(expected);
  });

  it.each([
    { layer: 'CLI', source: 'env', provider: 'mock' },
    { layer: 'step', source: 'step', provider: 'codex' },
    { layer: 'workflow_call', source: 'workflow_call', provider: 'claude' },
    { layer: 'provider routing', source: 'provider_routing.steps', provider: 'opencode' },
    { layer: 'persona', source: 'persona_providers', provider: 'cursor' },
  ] as const)('should preserve the project model for a provider-only $layer override with auto routing', ({
    layer,
    source,
    provider,
  }) => {
    const result = resolveStepProviderModel({
      step: {
        name: 'implement',
        provider: layer === 'step' ? provider : undefined,
        model: undefined,
        personaDisplayName: 'coder',
      },
      provider: layer === 'CLI' || layer === 'workflow_call' ? provider : 'claude',
      providerSource: layer === 'CLI' ? 'env' : layer === 'workflow_call' ? 'workflow_call' : 'project',
      model: 'project-model',
      modelSource: 'project',
      providerRouting: layer === 'provider routing'
        ? { steps: { implement: { provider } } }
        : undefined,
      personaProviders: layer === 'persona' ? { coder: { provider } } : undefined,
      autoRouting: {
        strategy: 'cost',
        router: { provider: 'mock', model: 'router-model' },
        candidates: [],
      },
    });

    expect(result).toEqual({
      provider,
      providerSource: source,
      model: 'project-model',
      modelSource: 'project',
    });
  });

  it.each([
    { layer: 'CLI', source: 'env', model: 'cli-model' },
    { layer: 'step', source: 'step', model: 'step-model' },
    { layer: 'workflow_call', source: 'workflow_call', model: 'call-model' },
    { layer: 'provider routing', source: 'provider_routing.steps', model: 'routing-model' },
    { layer: 'persona', source: 'persona_providers', model: 'persona-model' },
  ] as const)('should preserve a model-only $layer override for the auto-selected provider', ({
    layer,
    source,
    model,
  }) => {
    const result = resolveStepProviderModel({
      step: {
        name: 'implement',
        provider: undefined,
        model: layer === 'step' ? model : undefined,
        personaDisplayName: 'coder',
      },
      provider: 'claude',
      providerSource: 'project',
      model: layer === 'CLI' || layer === 'workflow_call' ? model : 'project-model',
      modelSource: layer === 'CLI' ? 'env' : layer === 'workflow_call' ? 'workflow_call' : 'project',
      providerRouting: layer === 'provider routing'
        ? { steps: { implement: { model } } }
        : undefined,
      personaProviders: layer === 'persona' ? { coder: { model } } : undefined,
      autoRouting: {
        strategy: 'cost',
        router: { provider: 'mock', model: 'router-model' },
        candidates: [],
      },
    });

    expect(result).toEqual({
      provider: undefined,
      providerSource: undefined,
      model,
      modelSource: source,
    });
  });

  it('should not inherit a persona model when the finding manager provider is direct', () => {
    const step = buildFindingManagerStep({
      contract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
          provider: 'codex',
        },
      },
    });

    const result = resolveStepProviderModel({
      step,
      personaProviders: {
        'findings-manager': {
          provider: 'opencode',
          model: 'opencode/persona-model',
        },
      },
    });

    expect(result).toMatchObject({
      provider: 'codex',
      model: undefined,
    });
  });

  it('should prefer step.provider over personaProviders.provider when both are defined', () => {
    const result = resolveStepProviderModel({
      step: { provider: 'codex', model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { provider: 'opencode' } },
    });

    expect(result.provider).toBe('codex');
  });

  it('should use personaProviders.provider when step.provider is undefined', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'reviewer' },
      provider: 'claude',
      personaProviders: { reviewer: { provider: 'opencode' } },
    });

    expect(result.provider).toBe('opencode');
  });

  it('should fallback to input.provider when persona mapping is missing', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'unknown' },
      provider: 'mock',
      personaProviders: { reviewer: { provider: 'codex' } },
    });

    expect(result.provider).toBe('mock');
  });

  it('should return undefined provider when all provider candidates are missing', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'none' },
      provider: undefined,
      personaProviders: undefined,
    });

    expect(result.provider).toBeUndefined();
  });

  it('should prefer step.model over personaProviders.model and input.model', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: 'step-model', personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    expect(result.model).toBe('step-model');
  });

  it('should use personaProviders.model when step.model is undefined', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    expect(result.model).toBe('persona-model');
  });

  it('should fallback to input.model when step.model and personaProviders.model are undefined', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex' } },
    });

    expect(result.model).toBe('input-model');
  });

  it('should return undefined model when all model candidates are missing', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: undefined,
      personaProviders: { coder: { provider: 'codex' } },
    });

    expect(result.model).toBeUndefined();
  });

  it('should resolve provider from personaProviders entry with only model specified', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { model: 'o3-mini' } },
    });

    expect(result.provider).toBe('claude');
    expect(result.model).toBe('o3-mini');
  });

  it('should resolve cursor provider from personaProviders', () => {
    const result = resolveStepProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { provider: 'cursor' } },
    });

    expect(result.provider).toBe('cursor');
  });

  it('should prefer workflow fallback over resolved project input', () => {
    const result = resolveStepProviderModel({
      step: {
        provider: 'codex',
        providerSpecified: false,
        model: 'workflow-model',
        modelSpecified: false,
        personaDisplayName: 'coder',
      },
      provider: 'mock',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
    });

    expect(result).toEqual({
      provider: 'codex',
      providerSource: 'workflow',
      model: 'workflow-model',
      modelSource: 'workflow',
    });
  });

});

describe('resolveWorkflowCallProviderModel', () => {
  it('should prefer workflow fallback over resolved project input', () => {
    const result = resolveWorkflowCallProviderModel({
      workflow: { provider: 'codex', model: 'workflow-model' },
      provider: 'mock',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
    });

    expect(result).toEqual({
      provider: 'codex',
      providerSource: 'workflow',
      model: 'workflow-model',
      modelSource: 'workflow',
    });
  });

  it.each([
    {
      label: 'provider only',
      providerSource: 'env' as const,
      modelSource: 'project' as const,
      expected: {
        provider: 'mock',
        providerSource: 'env',
        model: 'child-model',
        modelSource: 'workflow',
      },
    },
    {
      label: 'model only',
      providerSource: 'project' as const,
      modelSource: 'env' as const,
      expected: {
        provider: 'codex',
        providerSource: 'workflow',
        model: 'env-model',
        modelSource: 'env',
      },
    },
    {
      label: 'provider and model',
      providerSource: 'env' as const,
      modelSource: 'env' as const,
      expected: {
        provider: 'mock',
        providerSource: 'env',
        model: 'env-model',
        modelSource: 'env',
      },
    },
  ])('should keep environment $label above child workflow values', ({
    providerSource,
    modelSource,
    expected,
  }) => {
    const result = resolveWorkflowCallProviderModel({
      workflow: { provider: 'codex', model: 'child-model' },
      provider: 'mock',
      providerSource,
      model: 'env-model',
      modelSource,
    });

    expect(result).toEqual(expected);
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

describe('resolveLoopMonitorJudgeProviderModel', () => {
  it('should inherit the resolved triggering provider and override only the judge model', () => {
    const result = resolveLoopMonitorJudgeProviderModel({
      judge: { provider: undefined, model: 'opencode/model-b' },
      triggeringProviderInfo: {
        provider: 'opencode',
        providerSource: 'persona_providers',
        model: 'opencode/model-a',
        modelSource: 'persona_providers',
      },
    });

    expect(result).toEqual({
      provider: 'opencode',
      providerSource: 'persona_providers',
      model: 'opencode/model-b',
      modelSource: 'step',
    });
  });

  it('should inherit fallback-resolved triggering provider info without re-resolving the triggering step', () => {
    const result = resolveLoopMonitorJudgeProviderModel({
      judge: { provider: undefined, model: undefined },
      triggeringProviderInfo: {
        provider: 'codex',
        providerSource: 'step',
        model: 'gpt-5',
        modelSource: 'step',
      },
    });

    expect(result).toEqual({
      provider: 'codex',
      providerSource: 'step',
      model: 'gpt-5',
      modelSource: 'step',
    });
  });

  it('should clear inherited model when judge overrides only the provider', () => {
    const result = resolveLoopMonitorJudgeProviderModel({
      judge: { provider: 'codex', model: undefined },
      triggeringProviderInfo: {
        provider: 'opencode',
        providerSource: 'step',
        model: 'opencode/model-a',
        modelSource: 'step',
      },
    });

    expect(result).toEqual({
      provider: 'codex',
      providerSource: 'step',
      model: undefined,
      modelSource: 'step',
    });
  });

  it('should not inherit the triggering model when judge model is explicitly omitted', () => {
    const result = resolveLoopMonitorJudgeProviderModel({
      judge: { provider: undefined, model: undefined, modelSpecified: true },
      triggeringProviderInfo: {
        provider: 'cursor',
        providerSource: 'step',
        model: 'configured-model',
        modelSource: 'step',
      },
    });

    expect(result).toEqual({
      provider: 'cursor',
      providerSource: 'step',
      model: undefined,
      modelSource: 'step',
    });
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

describe('resolveAssistantScopedProviderModelFromConfig', () => {
  it('should prefer local assistant over global assistant', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
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

  it('should inherit global assistant when local assistant is absent', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
      local: {
        provider: 'opencode',
        model: 'local-top-level-model',
      },
      global: {
        provider: 'claude',
        model: 'global-top-level-model',
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

  it('should not fallback to top-level provider or model when assistant is missing', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
      local: {
        provider: 'opencode',
        model: 'local-top-level-model',
      },
      global: {
        provider: 'claude',
        model: 'global-top-level-model',
      },
    });

    expect(result).toEqual({
      provider: undefined,
      model: undefined,
    });
  });

  it('should return the local assistant provider with no model when only provider is configured locally', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
      local: {
        taktProviders: {
          assistant: {
            provider: 'codex',
          },
        },
      },
      global: {
        taktProviders: {
          assistant: {
            provider: 'claude',
            model: 'global-assistant-model',
          },
        },
      },
    });

    expect(result).toEqual({
      provider: 'codex',
      model: undefined,
    });
  });

  it('should keep the local assistant model unresolved when only assistant models are configured', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
      local: {
        taktProviders: {
          assistant: {
            model: 'local-assistant-model',
          },
        },
      },
      global: {
        taktProviders: {
          assistant: {
            model: 'global-assistant-model',
          },
        },
      },
    });

    expect(result).toEqual({
      provider: undefined,
      model: 'local-assistant-model',
    });
  });

  it('should inherit global assistant provider with no model when only provider is configured globally', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
      local: {},
      global: {
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

  it('should not inherit a global assistant model when the local assistant provider wins', () => {
    const result = resolveAssistantScopedProviderModelFromConfig({
      local: {
        taktProviders: {
          assistant: {
            provider: 'codex',
          },
        },
      },
      global: {
        taktProviders: {
          assistant: {
            provider: 'claude',
            model: 'global-assistant-model',
          },
        },
      },
    });

    expect(result).toEqual({
      provider: 'codex',
      model: undefined,
    });
  });
});

describe('resolveNonWorkflowProviderModelFromConfig', () => {
  it('should preserve the effective concrete top-level provider and model', () => {
    const project = {
      provider: 'codex',
      model: 'project-model',
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'claude', model: 'unused-router-model' },
        candidates: [],
      },
    } satisfies ProjectConfig;
    const result = resolveNonWorkflowProviderModelFromConfig({
      project,
      global: {
        provider: 'mock',
        model: 'global-model',
      },
    });

    expect(result).toEqual({ provider: 'codex', model: 'project-model' });
  });

  it('should not combine a project provider with a global model for another provider', () => {
    const result = resolveNonWorkflowProviderModelFromConfig({
      project: {
        provider: 'codex',
      },
      global: {
        provider: 'claude',
        model: 'global-claude-model',
      },
    });

    expect(result).toEqual({ provider: 'codex', model: undefined });
  });

  it('should use the project concrete provider and model instead of auto-routing router or candidates', () => {
    const project = {
      provider: 'codex',
      model: 'project-model',
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'claude', model: 'router-model' },
        candidates: [{
          name: 'coding',
          description: 'Implementation',
          provider: 'mock',
          model: 'candidate-model',
          costTier: 'medium',
        }],
      },
    } satisfies ProjectConfig;
    const result = resolveNonWorkflowProviderModelFromConfig({
      project,
      global: {
        provider: 'mock',
        model: 'global-model',
      },
    });

    expect(result).toEqual({ provider: 'codex', model: 'project-model' });
  });

  it('should use the global concrete pair when project provider is absent even if auto_routing exists', () => {
    const project = {
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'codex', model: 'project-router-model' },
        candidates: [],
      },
    } satisfies ProjectConfig;
    const result = resolveNonWorkflowProviderModelFromConfig({
      project,
      global: {
        provider: 'mock',
        model: 'global-model',
      },
    });

    expect(result).toEqual({ provider: 'mock', model: 'global-model' });
  });

  it('should not use router or candidate as a non-workflow fallback when top-level provider is absent', () => {
    const project = {
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'codex', model: 'router-model' },
        candidates: [
          {
            name: 'coding',
            description: 'Implementation',
            provider: 'codex',
            model: 'candidate-model',
            costTier: 'medium',
          },
        ],
      },
    } satisfies ProjectConfig;
    const result = resolveNonWorkflowProviderModelFromConfig({
      project,
      global: {},
    });

    expect(result).toEqual({ provider: undefined, model: undefined });
  });
});
