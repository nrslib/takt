import { describe, expect, it, vi } from 'vitest';
import {
  applyAutoRoutingStrategyOverride,
  matchAutoRoutingRules,
  resolveAutoRoutingBatch,
  resolveAutoRoutingRuntime,
  resolveDeterministicAutoRoutingProviderInfo,
} from '../core/workflow/auto-routing/resolver.js';
import type { RoutingWorkSnapshot, WorkRequirementEstimator } from '../core/workflow/auto-routing/contracts.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import { RoutingRuntime } from '../core/workflow/auto-routing/runtime.js';
import { resolveExecutableRoutingCandidates } from '../core/workflow/auto-routing/selector.js';

function createAutoRoutingConfig(overrides: Partial<AutoRoutingConfig> = {}): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
    candidates: [
      { name: 'reasoning', description: 'Architecture and complex reasoning', provider: 'claude-sdk', model: 'claude-opus-4-20250514', routingTier: 'high' },
      { name: 'coding', description: 'Implementation and tests', provider: 'codex', model: 'gpt-5', routingTier: 'medium', providerOptions: { codex: { reasoningEffort: 'high' } } },
      { name: 'lightweight', description: 'Formatting and small edits', provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001', routingTier: 'low' },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: { candidates: ['lightweight', 'coding', 'reasoning'], fallback: 'reasoning' },
      implementation: { candidates: ['coding', 'reasoning'], fallback: 'reasoning' },
    },
    poolRules: { tags: { implementation: 'implementation' } },
    rules: { tags: { review: 'reasoning', format: 'lightweight' }, steps: { plan: 'reasoning' }, personas: { architect: 'reasoning' } },
    ...overrides,
  };
}

function createStepMetadata(overrides: Record<string, unknown> = {}) {
  return {
    name: 'implement', tags: ['implementation'], personaKey: 'coder', instruction: 'Implement the requested change', ...overrides,
  };
}

function createSnapshot(overrides: Partial<RoutingWorkSnapshot> = {}): RoutingWorkSnapshot {
  return {
    goal: 'Implement the requested change',
    step: { name: 'implement', tags: ['implementation'], stepType: 'normal', edit: true },
    remainingWork: [{ source: 'task', description: 'Implement the requested change' }],
    progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    ...overrides,
  };
}

describe('matchAutoRoutingRules', () => {
  it('Given matching tags, step, and persona rules, When matching auto routing rules, Then tag rules win before steps and personas', () => {
    const result = matchAutoRoutingRules(createAutoRoutingConfig({
      rules: { tags: { implementation: 'coding' }, steps: { implement: 'reasoning' }, personas: { coder: 'lightweight' } },
    }), createStepMetadata());

    expect(result).toMatchObject({ name: 'coding', routingTier: 'medium' });
  });

  it('Given multiple matching tags, When matching auto routing rules, Then the later tag in the step wins', () => {
    const result = matchAutoRoutingRules(createAutoRoutingConfig(), createStepMetadata({ tags: ['review', 'format'] }));

    expect(result).toMatchObject({ name: 'lightweight', routingTier: 'low' });
  });

  it('Given own tag, step, and persona rules, When matching auto routing rules, Then each rule remains eligible', () => {
    const autoRouting = createAutoRoutingConfig({
      rules: {
        tags: { ownTag: 'coding' },
        steps: { ownStep: 'lightweight' },
        personas: { ownPersona: 'reasoning' },
      },
    });

    expect(matchAutoRoutingRules(autoRouting, createStepMetadata({ name: 'other', tags: ['ownTag'], personaKey: 'other' }))).toMatchObject({ name: 'coding' });
    expect(matchAutoRoutingRules(autoRouting, createStepMetadata({ name: 'ownStep', tags: [], personaKey: 'other' }))).toMatchObject({ name: 'lightweight' });
    expect(matchAutoRoutingRules(autoRouting, createStepMetadata({ name: 'other', tags: [], personaKey: 'ownPersona' }))).toMatchObject({ name: 'reasoning' });
  });

  it('Given inherited tag, step, and persona rules, When matching auto routing rules, Then none are eligible', () => {
    const autoRouting = createAutoRoutingConfig({
      rules: {
        tags: Object.create({ inheritedTag: 'coding' }) as Record<string, string>,
        steps: Object.create({ inheritedStep: 'lightweight' }) as Record<string, string>,
        personas: Object.create({ inheritedPersona: 'reasoning' }) as Record<string, string>,
      },
    });

    expect(matchAutoRoutingRules(autoRouting, createStepMetadata({ name: 'other', tags: ['inheritedTag'], personaKey: 'other' }))).toBeUndefined();
    expect(matchAutoRoutingRules(autoRouting, createStepMetadata({ name: 'inheritedStep', tags: [], personaKey: 'other' }))).toBeUndefined();
    expect(matchAutoRoutingRules(autoRouting, createStepMetadata({ name: 'other', tags: [], personaKey: 'inheritedPersona' }))).toBeUndefined();
  });
});

describe('applyAutoRoutingStrategyOverride', () => {
  it('Given an explicit strategy override, When applying it, Then it only changes the deterministic selection strategy', () => {
    const result = applyAutoRoutingStrategyOverride(createAutoRoutingConfig(), 'performance');

    expect(result).toMatchObject({ strategy: 'performance', defaultPool: 'general' });
  });
});

describe('resolveDeterministicAutoRoutingProviderInfo', () => {
  it('Given a matching rule, When resolving without an estimator, Then the hard-rule candidate is selected', () => {
    const result = resolveDeterministicAutoRoutingProviderInfo({
      autoRouting: createAutoRoutingConfig({ rules: { tags: { implementation: 'coding' } } }),
      step: createStepMetadata(),
      currentProviderInfo: { provider: undefined, model: undefined },
    });

    expect(result).toMatchObject({ provider: 'codex', providerSource: 'auto.rules', autoRoutingDecision: { candidateName: 'coding', routingTier: 'medium' } });
  });

  it('Given no hard rule and no estimator, When resolving deterministically, Then the configured pool fallback is selected', () => {
    const result = resolveDeterministicAutoRoutingProviderInfo({
      autoRouting: createAutoRoutingConfig({ rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: [] }),
      currentProviderInfo: { provider: undefined, model: undefined },
    });

    expect(result).toMatchObject({ provider: 'claude-sdk', providerSource: 'auto.fallback', autoRoutingDecision: { candidateName: 'reasoning', routingTier: 'high', fallbackReason: 'estimator-failure' } });
  });
});

describe('runtime auto-routing pool selection', () => {
  it('uses the pool explicitly assigned to a target without requiring an implicit default pool', () => {
    const autoRouting = {
      ...createAutoRoutingConfig(),
      defaultPool: undefined,
      workflowName: 'e2e-mock-single',
      rules: {},
      poolRules: { steps: { 'e2e-mock-single/execute': 'implementation' } },
    } as AutoRoutingConfig;

    const resolved = resolveExecutableRoutingCandidates(autoRouting, {
      name: 'execute',
      tags: [],
      personaKey: 'coder',
    });

    expect(resolved.resolutionSource).toBe('auto.dynamic');
    expect(resolved.poolName).toBe('implementation');
    expect(resolved.selectionCandidates.map((candidate) => candidate.name))
      .toEqual(['coding', 'reasoning']);
  });
});

describe('resolveAutoRoutingRuntime', () => {
  it('Given a hard rule, When resolving auto routing, Then the estimator is not called', async () => {
    const estimator: WorkRequirementEstimator = { estimate: vi.fn() };

    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ rules: { tags: { implementation: 'coding' } } }),
      step: createStepMetadata(), snapshot: createSnapshot(), estimator,
      currentProviderInfo: { provider: undefined, model: undefined },
    });

    expect(result?.providerInfo).toMatchObject({ provider: 'codex', providerSource: 'auto.rules' });
    expect(estimator.estimate).not.toHaveBeenCalled();
  });

  it('Given a high work estimate, When resolving auto routing, Then the selector chooses an eligible high-tier candidate', async () => {
    const estimator: WorkRequirementEstimator = {
      estimate: vi.fn().mockResolvedValue({ requiredTier: 'high', reasonCodes: ['complex-work'] }),
    };

    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: [] }), snapshot: createSnapshot(), estimator,
      currentProviderInfo: { provider: undefined, model: undefined },
    });

    expect(result?.providerInfo).toMatchObject({
      provider: 'claude-sdk', providerSource: 'auto.dynamic',
      autoRoutingDecision: { candidateName: 'reasoning', routingTier: 'high', requiredTier: 'high', reasonCodes: ['complex-work'] },
    });
  });

  it('Given an estimator failure, When resolving auto routing, Then it warns and uses the configured pool fallback', async () => {
    const warn = vi.fn();
    const estimator: WorkRequirementEstimator = { estimate: vi.fn().mockRejectedValue(new Error('router timeout')) };

    const result = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: [] }), snapshot: createSnapshot(), estimator,
      currentProviderInfo: { provider: undefined, model: undefined }, logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith('Auto routing estimator failed; using configured pool fallback');
    expect(result?.providerInfo).toMatchObject({ providerSource: 'auto.fallback', autoRoutingDecision: { candidateName: 'reasoning', fallbackReason: 'estimator-failure' } });
  });

  it('Given a run-scoped routing runtime, When estimation fails, Then it preserves the fallback warning', async () => {
    const warn = vi.fn();
    const autoRouting = createAutoRoutingConfig({ rules: {} });
    const estimator: WorkRequirementEstimator = {
      estimate: vi.fn().mockRejectedValue(new Error('router timeout')),
    };

    const result = await resolveAutoRoutingRuntime({
      autoRouting,
      step: createStepMetadata({ name: 'unknown', tags: [] }),
      snapshot: createSnapshot(),
      estimator,
      runtime: new RoutingRuntime({ autoRouting, estimator }),
      currentProviderInfo: { provider: undefined, model: undefined },
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith('Auto routing estimator failed; using configured pool fallback');
    expect(result?.providerInfo).toMatchObject({
      providerSource: 'auto.fallback',
      autoRoutingDecision: { candidateName: 'reasoning', fallbackReason: 'estimator-failure' },
    });
  });

  it('Given cancellation during estimation, When the estimator rejects, Then cancellation bypasses fallback', async () => {
    const abortController = new AbortController();
    const reason = new Error('routing cancelled');
    const estimator: WorkRequirementEstimator = {
      estimate: vi.fn(async () => {
        abortController.abort(reason);
        throw reason;
      }),
    };

    await expect(resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ rules: {} }),
      step: createStepMetadata({ name: 'unknown', tags: [] }), snapshot: createSnapshot(), estimator,
      currentProviderInfo: { provider: undefined, model: undefined }, abortSignal: abortController.signal,
    })).rejects.toBe(reason);
  });
});

describe('resolveAutoRoutingBatch', () => {
  it('Given multiple unresolved items, When resolving a batch, Then each item is estimated and selected through the shared routing contract', async () => {
    const estimator: WorkRequirementEstimator = {
      estimate: vi.fn()
        .mockResolvedValueOnce({ requiredTier: 'medium', reasonCodes: ['focused-change'] })
        .mockResolvedValueOnce({ requiredTier: 'high', reasonCodes: ['complex-work'] }),
    };

    const result = await resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig({ rules: {} }), estimator,
      items: [
        { id: 'part-1', step: createStepMetadata({ name: 'part-1', tags: [] }), snapshot: createSnapshot(), currentProviderInfo: { provider: undefined, model: undefined } },
        { id: 'part-2', step: createStepMetadata({ name: 'part-2', tags: [] }), snapshot: createSnapshot(), currentProviderInfo: { provider: undefined, model: undefined } },
      ],
    });

    expect(result.get('part-1')).toMatchObject({ autoRoutingDecision: { candidateName: 'coding', requiredTier: 'medium' } });
    expect(result.get('part-2')).toMatchObject({ autoRoutingDecision: { candidateName: 'reasoning', requiredTier: 'high' } });
    expect(estimator.estimate).toHaveBeenCalledTimes(2);
  });

  it('Given more items than the routing concurrency, When resolving a batch, Then estimator calls stay within the limit', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const estimator: WorkRequirementEstimator = {
      estimate: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { requiredTier: 'medium', reasonCodes: ['focused-change'] };
      }),
    };
    const resolving = resolveAutoRoutingBatch({
      autoRouting: createAutoRoutingConfig({ rules: {} }),
      estimator,
      concurrency: 2,
      items: ['part-1', 'part-2', 'part-3'].map((id) => ({
        id,
        step: createStepMetadata({ name: id, tags: [] }),
        snapshot: createSnapshot(),
        currentProviderInfo: { provider: undefined, model: undefined },
      })),
    });

    await vi.waitFor(() => expect(estimator.estimate).toHaveBeenCalledTimes(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(estimator.estimate).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    await resolving;

    expect(maxActive).toBe(2);
  });
});
