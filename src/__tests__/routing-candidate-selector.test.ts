import { describe, expect, it } from 'vitest';
import { resolveExecutableRoutingCandidates, selectRoutingCandidate } from '../core/workflow/auto-routing/selector.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';

function createAutoRoutingConfig(strategy: AutoRoutingConfig['strategy'] = 'cost'): AutoRoutingConfig {
  return {
    strategy,
    router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
    candidates: [
      { name: 'terra', description: 'Focused changes', provider: 'codex', model: 'gpt-5', routingTier: 'medium' },
      { name: 'sol', description: 'Complex work', provider: 'claude-sdk', model: 'claude-opus-4-20250514', routingTier: 'high' },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: { candidates: ['terra', 'sol'], fallback: 'sol' },
      implementation: { candidates: ['terra', 'sol'], fallback: 'sol' },
    },
    poolRules: { tags: { implementation: 'implementation' } },
    rules: { steps: { emergency: 'sol' } },
  };
}

describe('selectRoutingCandidate', () => {
  it('Given a pool rule, When resolving executable candidates, Then only candidates from the selected pool are returned', () => {
    const autoRouting: AutoRoutingConfig = {
      ...createAutoRoutingConfig(),
      candidatePools: {
        general: { candidates: ['terra', 'sol'], fallback: 'sol' },
        implementation: { candidates: ['terra'], fallback: 'terra' },
      },
    };

    const candidates = resolveExecutableRoutingCandidates(autoRouting, {
      name: 'implement',
      tags: ['implementation'],
    });

    expect(candidates).toMatchObject({
      candidates: [{ name: 'terra' }],
      poolName: 'implementation',
      resolutionSource: 'auto.dynamic',
    });
  });

  it('Given an implementation pool and a medium work requirement, When selecting with cost strategy, Then the lowest eligible candidate is selected', () => {
    const decision = selectRoutingCandidate({
      autoRouting: createAutoRoutingConfig('cost'),
      step: { name: 'implement', tags: ['implementation'] },
      estimate: { requiredTier: 'medium', reasonCodes: ['focused-change'] },
    });

    expect(decision).toMatchObject({
      candidate: { name: 'terra', routingTier: 'medium' },
      poolName: 'implementation',
      resolutionSource: 'auto.dynamic',
    });
  });

  it('Given the same medium requirement, When selecting with performance strategy, Then the highest-tier candidate is selected', () => {
    const decision = selectRoutingCandidate({
      autoRouting: createAutoRoutingConfig('performance'),
      step: { name: 'implement', tags: ['implementation'] },
      estimate: { requiredTier: 'medium', reasonCodes: ['focused-change'] },
    });

    expect(decision).toMatchObject({
      candidate: { name: 'sol', routingTier: 'high' },
      poolName: 'implementation',
      resolutionSource: 'auto.dynamic',
    });
  });

  it('Given a hard rule and a high dynamic estimate, When selecting a candidate, Then the hard rule wins without applying the dynamic pool', () => {
    const decision = selectRoutingCandidate({
      autoRouting: createAutoRoutingConfig(),
      step: { name: 'emergency', tags: ['implementation'] },
      estimate: { requiredTier: 'medium', reasonCodes: ['focused-change'] },
    });

    expect(decision).toMatchObject({
      candidate: { name: 'sol' },
      resolutionSource: 'auto.rules',
    });
  });

  it('Given no candidate meets the required tier, When selecting a candidate, Then selection fails instead of choosing a lower-tier candidate', () => {
    const autoRouting: AutoRoutingConfig = {
      ...createAutoRoutingConfig(),
      candidates: [{
        name: 'terra',
        description: 'Focused changes',
        provider: 'codex',
        model: 'gpt-5',
        routingTier: 'medium',
      }],
      candidatePools: {
        general: { candidates: ['terra'], fallback: 'terra' },
        implementation: { candidates: ['terra'], fallback: 'terra' },
      },
    };

    expect(() => selectRoutingCandidate({
      autoRouting,
      step: { name: 'implement', tags: ['implementation'] },
      estimate: { requiredTier: 'high', reasonCodes: ['complex-work'] },
    })).toThrow('No eligible candidate meets required high routing tier');
  });

  it('Given an estimator failure, When resolving a pool, Then the configured pool fallback is selected directly', () => {
    const decision = selectRoutingCandidate({
      autoRouting: createAutoRoutingConfig(),
      step: { name: 'implement', tags: ['implementation'] },
      estimatorFailure: new Error('router timeout'),
    });

    expect(decision).toMatchObject({
      candidate: { name: 'sol' },
      resolutionSource: 'auto.fallback',
      fallbackReason: 'estimator-failure',
    });
  });
});
