import { describe, expect, it, vi } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import { RoutingRuntime } from '../core/workflow/auto-routing/runtime.js';
import { createRoutingScope } from '../core/workflow/auto-routing/resolver.js';
import { buildRoutingWorkSnapshot } from '../core/workflow/auto-routing/snapshot.js';

function createAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'cost',
    router: { provider: 'mock', model: 'router-model' },
    candidates: [
      { name: 'medium', description: 'Focused work', provider: 'mock', model: 'medium-model', routingTier: 'medium' },
      { name: 'high', description: 'Complex work', provider: 'mock', model: 'high-model', routingTier: 'high' },
    ],
    defaultPool: 'general',
    candidatePools: { general: { candidates: ['medium', 'high'], fallback: 'high' } },
  };
}

function createSnapshot(retryNote?: string) {
  return buildRoutingWorkSnapshot({
    goal: 'Complete the workflow task',
    userInputs: [],
    retryNote,
    step: {
      name: 'review',
      tags: [],
      stepType: 'parallel',
      passPreviousResponse: false,
    },
  });
}

describe('routing runtime retry contract', () => {
  it('Given a done response with unchanged work, When routing the next attempt, Then it promotes the required tier', async () => {
    const runtime = new RoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      estimator: { estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }) },
    });
    const scope = createRoutingScope({ workflow: 'workflow', parentStep: 'reviewers', workItem: 'review' });
    const snapshot = createSnapshot();

    await runtime.resolve({ scope, snapshot });
    runtime.recordExecutionResult({ scope, status: 'done' });
    const retry = await runtime.resolve({ scope, snapshot });

    expect(retry.requiredTier).toBe('high');
    expect(retry.escalationReason).toBe('no-progress');
  });

  it('Given matching sub-step names under different parents, When one parent has no progress, Then the other parent remains independent', async () => {
    const runtime = new RoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      estimator: { estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }) },
    });
    const snapshot = createSnapshot();
    const firstScope = createRoutingScope({ workflow: 'workflow', parentStep: 'first-reviewers', workItem: 'review' });
    const secondScope = createRoutingScope({ workflow: 'workflow', parentStep: 'second-reviewers', workItem: 'review' });

    await runtime.resolve({ scope: firstScope, snapshot });
    runtime.recordExecutionResult({ scope: firstScope, status: 'done' });
    const independent = await runtime.resolve({ scope: secondScope, snapshot });

    expect(independent.requiredTier).toBe('medium');
    expect(independent.escalationReason).toBeUndefined();
  });

  it('Given a retry note changes, When building the next snapshot, Then the runtime evaluates it as new remaining work', async () => {
    const estimate = vi.fn()
      .mockResolvedValueOnce({ requiredTier: 'high', reasonCodes: ['complex-work'] })
      .mockResolvedValueOnce({ requiredTier: 'medium', reasonCodes: ['focused-change'] });
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator: { estimate } });
    const scope = createRoutingScope({ workflow: 'workflow', parentStep: 'fix', workItem: 'fix' });

    await runtime.resolve({ scope, snapshot: createSnapshot('Resolve the architecture issue') });
    const next = await runtime.resolve({ scope, snapshot: createSnapshot('Update the focused regression test') });

    expect(next.fingerprintChanged).toBe(true);
    expect(next.requiredTier).toBe('medium');
  });

  it('Given the same work receives updated text, When retrying, Then the changed fingerprint avoids the no-progress tier floor', async () => {
    const estimate = vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] });
    const runtime = new RoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      estimator: { estimate },
    });
    const scope = createRoutingScope({ workflow: 'workflow', parentStep: 'fix', workItem: 'fix' });
    const createWorkSnapshot = (description: string) => buildRoutingWorkSnapshot({
      goal: 'Resolve the open issue',
      userInputs: [description],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
    });

    await runtime.resolve({ scope, snapshot: createWorkSnapshot('Initial wording.') });
    runtime.recordExecutionResult({ scope, status: 'done' });
    const retry = await runtime.resolve({
      scope,
      snapshot: createWorkSnapshot('Updated evidence for the same issue.'),
    });

    expect(retry.fingerprintChanged).toBe(true);
    expect(retry.requiredTier).toBe('medium');
    expect(retry.escalationReason).toBeUndefined();
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it('Given an estimator aborts, When resolving a route, Then it rethrows the abort instead of selecting a fallback', async () => {
    const abortController = new AbortController();
    const abortError = new Error('cancelled');
    abortError.name = 'AbortError';
    const estimate = vi.fn(async (_input, options) => {
      expect(options?.abortSignal).toBe(abortController.signal);
      throw abortError;
    });
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator: { estimate } });

    await expect(runtime.resolve({
      scope: createRoutingScope({ workflow: 'workflow', parentStep: 'fix', workItem: 'fix' }),
      snapshot: createSnapshot(),
      abortSignal: abortController.signal,
    })).rejects.toBe(abortError);
  });
});
