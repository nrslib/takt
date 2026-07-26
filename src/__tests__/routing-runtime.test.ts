import { describe, expect, it, vi } from 'vitest';
import { RoutingRuntime } from '../core/workflow/auto-routing/runtime.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';

function createAutoRoutingConfig(overrides: Partial<AutoRoutingConfig> = {}): AutoRoutingConfig {
  const config: AutoRoutingConfig = {
    strategy: 'cost',
    router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
    candidates: [
      { name: 'terra', description: 'Focused changes', provider: 'codex', model: 'gpt-5', routingTier: 'medium' },
      { name: 'sol', description: 'Complex work', provider: 'claude-sdk', model: 'claude-opus-4-20250514', routingTier: 'high' },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: { candidates: ['terra', 'sol'], fallback: 'sol' },
    },
  };
  return { ...config, ...overrides };
}

function createSnapshot(description: string) {
  return {
    goal: 'Complete the workflow task',
    step: {
      name: 'implement',
      tags: ['implementation'],
      stepType: 'normal' as const,
      edit: true,
    },
    remainingWork: [{ source: 'task' as const, description }],
    progress: {
      previousAttemptFailed: false,
      noProgress: false,
      retryingSameWork: false,
    },
  };
}

describe('RoutingRuntime', () => {
  it('Given the same work fingerprint was previously routed high, When a retry estimates medium, Then the previous required tier remains the floor', async () => {
    const estimator = {
      estimate: vi.fn()
        .mockResolvedValueOnce({ requiredTier: 'high', reasonCodes: ['initial-complexity'] })
        .mockResolvedValueOnce({ requiredTier: 'medium', reasonCodes: ['local-change'] }),
    };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });
    const snapshot = createSnapshot('Resolve the same unresolved finding');

    await runtime.resolve({ scope: 'implement', snapshot });
    const retry = await runtime.resolve({ scope: 'implement', snapshot });

    expect(retry.requiredTier).toBe('high');
    expect(retry.candidate.name).toBe('sol');
    expect(retry.fingerprintChanged).toBe(false);
  });

  it('Given the same work failed without progress, When it is routed again, Then the required tier is promoted by one level', async () => {
    const estimator = {
      estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }),
    };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });
    const snapshot = createSnapshot('Resolve the same unresolved finding');

    await runtime.resolve({ scope: 'implement', snapshot });
    runtime.recordExecutionResult({ scope: 'implement', status: 'failed', madeProgress: false });
    const retry = await runtime.resolve({ scope: 'implement', snapshot });

    expect(retry.requiredTier).toBe('high');
    expect(retry.escalationReason).toBe('failed-without-progress');
  });

  it('Given the same work completed without progress, When it is routed again, Then the required tier is promoted with a no-progress reason', async () => {
    const estimator = {
      estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }),
    };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });
    const snapshot = createSnapshot('Resolve the same unresolved finding');

    await runtime.resolve({ scope: 'implement', snapshot });
    runtime.recordExecutionResult({ scope: 'implement', status: 'done', madeProgress: false });
    const retry = await runtime.resolve({ scope: 'implement', snapshot });

    expect(retry.requiredTier).toBe('high');
    expect(retry.escalationReason).toBe('no-progress');
  });

  it('Given a resolved finding changes the work fingerprint, When the new work estimates medium, Then the old high-tier floor is not retained', async () => {
    const estimator = {
      estimate: vi.fn()
        .mockResolvedValueOnce({ requiredTier: 'high', reasonCodes: ['critical-finding'] })
        .mockResolvedValueOnce({ requiredTier: 'medium', reasonCodes: ['focused-change'] }),
    };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });

    await runtime.resolve({ scope: 'implement', snapshot: createSnapshot('Resolve a critical finding') });
    const nextWork = await runtime.resolve({
      scope: 'implement',
      snapshot: createSnapshot('Apply a focused follow-up change'),
    });

    expect(nextWork.requiredTier).toBe('medium');
    expect(nextWork.candidate.name).toBe('terra');
    expect(nextWork.fingerprintChanged).toBe(true);
  });

  it('Given a fallback selected high for unchanged work, When a later estimate is medium, Then the fallback tier remains the retry floor', async () => {
    const estimator = {
      estimate: vi.fn()
        .mockRejectedValueOnce(new Error('router unavailable'))
        .mockResolvedValueOnce({ requiredTier: 'medium', reasonCodes: ['focused-change'] }),
    };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });
    const snapshot = createSnapshot('Resolve the same unresolved finding');

    const fallback = await runtime.resolve({ scope: 'implement', snapshot });
    const retry = await runtime.resolve({ scope: 'implement', snapshot });

    expect(fallback.requiredTier).toBe('high');
    expect(retry.requiredTier).toBe('high');
    expect(retry.candidate.name).toBe('sol');
  });

  it('Given a fallback candidate below the unchanged-work floor, When estimation fails, Then routing fails closed', async () => {
    const autoRouting = createAutoRoutingConfig({
      candidatePools: {
        general: { candidates: ['terra', 'sol'], fallback: 'terra' },
      },
    });
    const estimator = {
      estimate: vi.fn()
        .mockResolvedValueOnce({ requiredTier: 'high', reasonCodes: ['critical-finding'] })
        .mockRejectedValueOnce('router unavailable'),
    };
    const runtime = new RoutingRuntime({ autoRouting, estimator });
    const snapshot = createSnapshot('Resolve the same unresolved finding');

    await runtime.resolve({ scope: 'implement', snapshot });
    await expect(runtime.resolve({ scope: 'implement', snapshot }))
      .rejects.toThrow('does not meet required high routing tier');
  });

  it('Given a cached estimate, When callers modify reason codes from cache misses and hits, Then later resolutions retain the cached reason codes', async () => {
    const estimator = {
      estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }),
    };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });
    const snapshot = createSnapshot('Apply a focused change');

    const cacheMiss = await runtime.resolve({ scope: 'first', snapshot });
    cacheMiss.reasonCodes?.push('local-change');
    const cacheHit = await runtime.resolve({ scope: 'second', snapshot });
    cacheHit.reasonCodes?.push('local-change');
    const laterCacheHit = await runtime.resolve({ scope: 'third', snapshot });

    expect(laterCacheHit.reasonCodes).toEqual(['focused-change']);
    expect(estimator.estimate).toHaveBeenCalledTimes(1);
  });
});
