import { describe, expect, it, vi } from 'vitest';
import {
  applyAutoRoutingStrategyOverride,
  matchAutoRoutingRules,
  resolveAutoRoutingBatch,
  resolveAutoRoutingRuntime,
  selectStrategyDefaultCandidate,
} from '../core/workflow/auto-routing/resolver.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';

function createAutoRoutingConfig(overrides: Record<string, unknown> = {}) {
  return {
    strategy: 'balanced',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'reasoning',
        description: 'Architecture and complex reasoning',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        costTier: 'high',
        providerOptions: {
          claude: { effort: 'high' },
        },
      },
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        costTier: 'medium',
        providerOptions: {
          codex: { reasoningEffort: 'high' },
        },
      },
      {
        name: 'lightweight',
        description: 'Formatting and small edits',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        costTier: 'low',
      },
    ],
    rules: {
      tags: {
        implementation: 'coding',
        review: 'reasoning',
        format: 'lightweight',
      },
      steps: {
        implement: 'reasoning',
      },
      personas: {
        coder: 'lightweight',
      },
    },
    ...overrides,
  };
}

function createStepMetadata(overrides: Record<string, unknown> = {}) {
  return {
    name: 'implement',
    tags: ['implementation'],
    personaKey: 'coder',
    instruction: 'Implement the requested change',
    ...overrides,
  };
}

describe('matchAutoRoutingRules', () => {
  it('Given matching tags, step, and persona rules, When matching auto routing rules, Then tag rules win before steps and personas', () => {
    const result = matchAutoRoutingRules(
      createAutoRoutingConfig(),
      createStepMetadata(),
    );

    expect(result).toMatchObject({
      name: 'coding',
      provider: 'codex',
      model: 'gpt-5',
      costTier: 'medium',
    });
  });

  it('Given multiple matching tags, When matching auto routing rules, Then the later tag in the step wins', () => {
    const result = matchAutoRoutingRules(
      createAutoRoutingConfig(),
      createStepMetadata({ tags: ['implementation', 'format'] }),
    );

    expect(result).toMatchObject({
      name: 'lightweight',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      costTier: 'low',
    });
  });

  it('Given no tag rule matches, When step and persona both match, Then the step rule wins', () => {
    const result = matchAutoRoutingRules(
      createAutoRoutingConfig(),
      createStepMetadata({ tags: ['unknown'] }),
    );

    expect(result).toMatchObject({
      name: 'reasoning',
      provider: 'claude-sdk',
      model: 'claude-opus-4-20250514',
      costTier: 'high',
    });
  });
});

describe('selectStrategyDefaultCandidate', () => {
  it.each([
    ['cost', 'lightweight'],
    ['balanced', 'coding'],
    ['performance', 'reasoning'],
  ] as const)(
    'Given strategy %s, When selecting the default candidate, Then the first candidate in the required tier is selected',
    (strategy, expectedName) => {
      const result = selectStrategyDefaultCandidate(
        createAutoRoutingConfig({ strategy }),
      );

      expect(result.name).toBe(expectedName);
    },
  );

  it('Given the configured strategy has no candidate in its required tier, When selecting default candidate, Then it fails fast', () => {
    expect(() =>
      selectStrategyDefaultCandidate(createAutoRoutingConfig({
        strategy: 'performance',
        candidates: [
          {
            name: 'coding',
            description: 'Implementation and tests',
            provider: 'codex',
            model: 'gpt-5',
            costTier: 'medium',
          },
        ],
      })),
    ).toThrow(/high|performance|candidate/i);
  });
});

describe('applyAutoRoutingStrategyOverride', () => {
  it('Given an override requires a missing fallback tier, When applying it, Then validation fails before runtime fallback', () => {
    expect(() =>
      applyAutoRoutingStrategyOverride(createAutoRoutingConfig({
        candidates: [
          {
            name: 'coding',
            description: 'Implementation and tests',
            provider: 'codex',
            model: 'gpt-5',
            costTier: 'medium',
          },
        ],
      }), 'performance'),
    ).toThrow(/performance|high|candidate/i);
  });
});

describe('resolveAutoRoutingRuntime', () => {
  it('Given auto routing is configured, When a workflow rule matches, Then the rule candidate is authoritative', async () => {
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: { provider: 'claude-sdk', model: 'router-model' },
      candidates: [
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'workflow-candidate-model',
          costTier: 'medium',
        },
      ],
      rules: { tags: { implementation: 'coding' } },
    };

    const result = await resolveAutoRoutingRuntime({
      autoRouting,
      step: createStepMetadata(),
      currentProviderInfo: { provider: undefined, model: undefined },
      routeWithAi: vi.fn(),
    });

    expect(result?.providerInfo).toMatchObject({
      provider: 'codex',
      model: 'workflow-candidate-model',
      providerSource: 'auto.rules',
      autoRoutingDecision: { candidateName: 'coding' },
    });
  });

  it('Given provider is already resolved by a higher-priority layer, When resolving auto routing, Then it does not override providerInfo', async () => {
    const routeWithAi = vi.fn();
    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: createStepMetadata(),
      currentProviderInfo: {
        provider: 'claude-sdk',
        model: 'claude-sonnet-4-20250514',
        providerSource: 'step',
        modelSource: 'step',
      },
      routeWithAi,
    });

    expect(result).toBeUndefined();
    expect(routeWithAi).not.toHaveBeenCalled();
  });

  it('Given a rule matches an unresolved provider, When resolving auto routing, Then providerInfo includes the candidate provider, model, options, and auto source', async () => {
    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: createStepMetadata(),
      currentProviderInfo: {
        provider: undefined,
        model: undefined,
      },
      routeWithAi: vi.fn(),
    });

    expect(result).toEqual({
      providerInfo: {
        provider: 'codex',
        model: 'gpt-5',
        providerSource: 'auto.rules',
        modelSource: 'auto.rules',
        providerOptions: {
          codex: { reasoningEffort: 'high' },
        },
        providerOptionsSources: {
          'codex.reasoningEffort': 'auto.rules',
        },
        autoRoutingDecision: {
          candidateName: 'coding',
          costTier: 'medium',
          strategy: 'balanced',
          candidateCount: 3,
        },
      },
    });
  });

  it('Given auto routing selects a provider incompatible with a higher-priority model, When resolving runtime, Then validation fails fast', async () => {
    await expect(resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: createStepMetadata(),
      currentProviderInfo: {
        provider: undefined,
        model: 'sonnet',
        modelSource: 'step',
      },
      routeWithAi: vi.fn(),
    })).rejects.toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
  });

  it('Given only the model is already resolved by a higher-priority layer, When resolving auto routing, Then the candidate provider does not override that model', async () => {
    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: createStepMetadata(),
      currentProviderInfo: {
        provider: undefined,
        model: 'gpt-5-step-override',
        modelSource: 'step',
      },
      routeWithAi: vi.fn(),
    });

    expect(result?.providerInfo).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-step-override',
      providerSource: 'auto.rules',
      modelSource: 'step',
      autoRoutingDecision: {
        candidateName: 'coding',
        costTier: 'medium',
        strategy: 'balanced',
        candidateCount: 3,
      },
    });
  });

  it('Given AI routing fails and no rule matches, When resolving auto routing, Then it warns and uses the strategy default candidate', async () => {
    const warn = vi.fn();
    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: ['unknown'], personaKey: 'unknown' }),
      currentProviderInfo: {
        provider: undefined,
        model: undefined,
      },
      routeWithAi: vi.fn().mockRejectedValue(new Error('router timeout')),
      logger: { warn },
    });

    expect(result).toMatchObject({
      providerInfo: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        providerSource: 'auto.default',
        modelSource: 'auto.default',
      },
    });
    expect(warn).toHaveBeenCalledWith('Auto routing AI router failed; falling back to strategy default');
  });

  it('Given AI routing returns undefined and no rule matches, When resolving auto routing, Then it warns before strategy default fallback', async () => {
    const warn = vi.fn();
    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: ['unknown'], personaKey: 'unknown' }),
      currentProviderInfo: {
        provider: undefined,
        model: undefined,
      },
      routeWithAi: vi.fn().mockResolvedValue(undefined),
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith('Auto routing AI router failed; falling back to strategy default');
    expect(result).toMatchObject({
      providerInfo: {
        provider: 'claude-sdk',
        providerSource: 'auto.default',
        autoRoutingDecision: {
          candidateName: 'lightweight',
          costTier: 'low',
        },
      },
    });
  });

  it('Given no rule matches and AI routing selects a candidate, When resolving auto routing, Then the AI candidate is used', async () => {
    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: ['unknown'], personaKey: 'unknown' }),
      currentProviderInfo: {
        provider: undefined,
        model: undefined,
      },
      routeWithAi: vi.fn().mockResolvedValue(createAutoRoutingConfig().candidates[1]),
    });

    expect(result?.providerInfo).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.ai',
      modelSource: 'auto.ai',
      autoRoutingDecision: {
        candidateName: 'coding',
        costTier: 'medium',
      },
    });
  });

  it('Given no rule matches and AI routing selects an incompatible provider for an existing model, When resolving runtime, Then validation fails fast', async () => {
    await expect(resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: ['unknown'], personaKey: 'unknown' }),
      currentProviderInfo: {
        provider: undefined,
        model: 'sonnet',
        modelSource: 'step',
      },
      routeWithAi: vi.fn().mockResolvedValue(createAutoRoutingConfig().candidates[1]),
    })).rejects.toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
  });

  it('Given single AI routing is cancelled, When the router rejects, Then cancellation bypasses warning and default fallback', async () => {
    const abortController = new AbortController();
    const reason = new Error('single routing cancelled');
    const warn = vi.fn();
    const routeWithAi = vi.fn(async () => {
      abortController.abort(reason);
      throw reason;
    });

    await expect(resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: ['unknown'], personaKey: 'unknown' }),
      currentProviderInfo: { provider: undefined, model: undefined },
      routeWithAi,
      logger: { warn },
      abortSignal: abortController.signal,
    })).rejects.toBe(reason);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('resolveAutoRoutingBatch', () => {
  it('Given mixed resolved and unresolved items, When resolving a batch, Then only unresolved auto items are routed', async () => {
    const routeWithAi = vi.fn();
    const result = await resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig(),
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['implementation'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
        {
          id: 'part-2',
          step: createStepMetadata({ name: 'part-2', tags: ['implementation'] }),
          currentProviderInfo: {
            provider: 'claude-sdk',
            model: 'claude-sonnet-4-20250514',
            providerSource: 'step',
            modelSource: 'step',
          },
        },
      ],
      routeWithAi,
    });

    expect(result).toEqual(new Map([
      ['part-1', {
        provider: 'codex',
        model: 'gpt-5',
        providerSource: 'auto.rules',
        modelSource: 'auto.rules',
        providerOptions: {
          codex: { reasoningEffort: 'high' },
        },
        providerOptionsSources: {
          'codex.reasoningEffort': 'auto.rules',
        },
        autoRoutingDecision: {
          candidateName: 'coding',
          costTier: 'medium',
          strategy: 'balanced',
          candidateCount: 3,
        },
      }],
    ]));
    expect(routeWithAi).not.toHaveBeenCalled();
  });

  it('Given a batch item has a model resolved by provider_routing, When resolving auto routing, Then the candidate provider keeps the provider_routing model', async () => {
    const result = await resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig(),
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['implementation'] }),
          currentProviderInfo: {
            provider: undefined,
            model: 'gpt-5-provider-routing',
            modelSource: 'provider_routing.tags',
          },
        },
      ],
      routeWithAi: vi.fn(),
    });

    expect(result.get('part-1')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-provider-routing',
      providerSource: 'auto.rules',
      modelSource: 'provider_routing.tags',
      autoRoutingDecision: {
        candidateName: 'coding',
        costTier: 'medium',
        strategy: 'balanced',
        candidateCount: 3,
      },
    });
  });

  it('Given batch auto routing selects a provider incompatible with a higher-priority part model, When resolving batch, Then validation fails fast', async () => {
    await expect(resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig(),
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['implementation'] }),
          currentProviderInfo: {
            provider: undefined,
            model: 'sonnet',
            modelSource: 'provider_routing.tags',
          },
        },
      ],
      routeWithAi: vi.fn(),
    })).rejects.toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
  });

  it('Given multiple unresolved items without rule matches, When resolving a batch with AI routing, Then one batch router call resolves all items', async () => {
    const autoRouting = createAutoRoutingConfig({ rules: {} });
    const routeBatchWithAi = vi.fn().mockResolvedValue(new Map([
      ['part-1', autoRouting.candidates[1]],
      ['part-2', autoRouting.candidates[2]],
    ]));

    const result = await resolveAutoRoutingBatch({
      autoRouting,
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
        {
          id: 'part-2',
          step: createStepMetadata({ name: 'part-2', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
      ],
      routeBatchWithAi,
    });

    expect(routeBatchWithAi).toHaveBeenCalledTimes(1);
    expect(routeBatchWithAi.mock.calls[0]?.[1]).toHaveLength(2);
    expect(result.get('part-1')).toMatchObject({
      provider: 'codex',
      providerSource: 'auto.ai',
    });
    expect(result.get('part-2')).toMatchObject({
      provider: 'claude-sdk',
      providerSource: 'auto.ai',
    });
  });

  it('Given batch AI routing selects an incompatible provider for an existing model, When resolving a batch, Then validation fails fast', async () => {
    const autoRouting = createAutoRoutingConfig({ strategy: 'cost', rules: {} });
    const routeBatchWithAi = vi.fn().mockResolvedValue(new Map([
      ['part-1', autoRouting.candidates[1]],
    ]));

    await expect(resolveAutoRoutingBatch({
      autoRouting,
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: {
            provider: undefined,
            model: 'sonnet',
            modelSource: 'provider_routing.tags',
          },
        },
      ],
      routeBatchWithAi,
    })).rejects.toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
  });

  it('Given per-item AI routing is used for a batch, When resolving unresolved items, Then all AI routes start before the first result is awaited', async () => {
    const autoRouting = createAutoRoutingConfig({ rules: {} });
    const startedSteps: string[] = [];
    const resolvers: Array<() => void> = [];
    const routeWithAi = vi.fn((_autoRouting, step) => new Promise<typeof autoRouting.candidates[number]>((resolve) => {
      startedSteps.push(step.name);
      resolvers.push(() => resolve(autoRouting.candidates[1]!));
    }));

    const resultPromise = resolveAutoRoutingBatch({
      autoRouting,
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
        {
          id: 'part-2',
          step: createStepMetadata({ name: 'part-2', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
      ],
      routeWithAi,
    });

    await Promise.resolve();
    expect(startedSteps).toEqual(['part-1', 'part-2']);

    for (const resolve of resolvers) {
      resolve();
    }
    const result = await resultPromise;

    expect(routeWithAi).toHaveBeenCalledTimes(2);
    expect(result.get('part-1')?.providerSource).toBe('auto.ai');
    expect(result.get('part-2')?.providerSource).toBe('auto.ai');
  });

  it('Given batch AI routing rejects, When resolving a batch, Then all unresolved items warn and use the strategy default', async () => {
    const warn = vi.fn();
    const routeBatchWithAi = vi.fn().mockRejectedValue(new Error('batch router timeout'));

    const result = await resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
        {
          id: 'part-2',
          step: createStepMetadata({ name: 'part-2', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
      ],
      routeBatchWithAi,
      logger: { warn },
    });

    expect(routeBatchWithAi).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Auto routing AI router failed; falling back to strategy default');
    expect(result.get('part-1')).toMatchObject({
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      providerSource: 'auto.default',
      modelSource: 'auto.default',
      autoRoutingDecision: {
        candidateName: 'lightweight',
        costTier: 'low',
      },
    });
    expect(result.get('part-2')).toMatchObject({
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      providerSource: 'auto.default',
      modelSource: 'auto.default',
      autoRoutingDecision: {
        candidateName: 'lightweight',
        costTier: 'low',
      },
    });
  });

  it('Given batch AI routing is cancelled, When the router rejects, Then cancellation bypasses warning and all defaults', async () => {
    const abortController = new AbortController();
    const reason = new Error('batch routing cancelled');
    const warn = vi.fn();
    const routeBatchWithAi = vi.fn(async () => {
      abortController.abort(reason);
      throw reason;
    });

    await expect(resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
        {
          id: 'part-2',
          step: createStepMetadata({ name: 'part-2', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
      ],
      routeBatchWithAi,
      logger: { warn },
      abortSignal: abortController.signal,
    })).rejects.toBe(reason);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Given batch AI routing omits an item, When resolving a batch, Then the router failure is warned before strategy default fallback', async () => {
    const autoRouting = createAutoRoutingConfig({ strategy: 'cost', rules: {} });
    const routeBatchWithAi = vi.fn().mockResolvedValue(new Map([
      ['part-1', autoRouting.candidates[1]],
    ]));
    const warn = vi.fn();

    const result = await resolveAutoRoutingBatch({
      autoRouting,
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
        {
          id: 'part-2',
          step: createStepMetadata({ name: 'part-2', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
      ],
      routeBatchWithAi,
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith('Auto routing AI router failed; falling back to strategy default');
    expect(result.get('part-1')).toMatchObject({
      provider: 'claude-sdk',
      providerSource: 'auto.default',
      autoRoutingDecision: {
        candidateName: 'lightweight',
        costTier: 'low',
      },
    });
    expect(result.get('part-2')).toMatchObject({
      provider: 'claude-sdk',
      providerSource: 'auto.default',
      autoRoutingDecision: {
        candidateName: 'lightweight',
        costTier: 'low',
      },
    });
  });

  it('Given batch AI routing returns undefined selection, When resolving a batch, Then the router failure is warned before strategy default fallback', async () => {
    const autoRouting = createAutoRoutingConfig({ strategy: 'cost', rules: {} });
    const routeBatchWithAi = vi.fn().mockResolvedValue(new Map([
      ['part-1', undefined],
    ]));
    const warn = vi.fn();

    const result = await resolveAutoRoutingBatch({
      autoRouting,
      items: [
        {
          id: 'part-1',
          step: createStepMetadata({ name: 'part-1', tags: ['unknown'] }),
          currentProviderInfo: { provider: undefined, model: undefined },
        },
      ],
      routeBatchWithAi,
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith('Auto routing AI router failed; falling back to strategy default');
    expect(result.get('part-1')).toMatchObject({
      provider: 'claude-sdk',
      providerSource: 'auto.default',
      autoRoutingDecision: {
        candidateName: 'lightweight',
        costTier: 'low',
      },
    });
  });

  it('Given AI routing throws a raw secret-like error, When resolving runtime, Then warning uses a fixed message before default fallback', async () => {
    const rawMessage = 'Authorization: Bearer sk-test';
    const warn = vi.fn();

    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ strategy: 'cost', rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: ['unknown'], personaKey: 'unknown' }),
      currentProviderInfo: { provider: undefined, model: undefined },
      routeWithAi: vi.fn().mockRejectedValue(new Error(rawMessage)),
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith('Auto routing AI router failed; falling back to strategy default');
    expect(warn.mock.calls.flat().join('\n')).not.toContain(rawMessage);
    expect(result?.providerInfo.providerSource).toBe('auto.default');
  });
});
