import { describe, expect, it, vi } from 'vitest';
import { WorkflowStepBudget } from '../core/workflow/workflow-step-budget.js';

function scope(step: string) {
  return {
    kind: 'workflow_execution_scope' as const,
    stack: [{ workflow: 'parent', step, kind: 'agent' as const }],
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('WorkflowStepBudget', () => {
  it('should serialize concurrent extensions and recheck the latest shared limit', async () => {
    const budget = new WorkflowStepBudget(2);
    const extensionStarted = deferred();
    const releaseExtension = deferred();
    const requestExtension = vi.fn(async () => {
      extensionStarted.resolve();
      await releaseExtension.promise;
      return 2;
    });
    const onLimitReached = vi.fn();
    const onMaxStepsExtended = vi.fn();
    const firstCheck = budget.check({
      request: { currentIteration: 2, currentStep: 'slow-child', scope: scope('slow-child') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended,
      requestExtension,
    });
    await extensionStarted.promise;
    const secondCheck = budget.check({
      request: { currentIteration: 2, currentStep: 'fast-child', scope: scope('fast-child') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended,
      requestExtension,
    });

    releaseExtension.resolve();
    const results = await Promise.all([firstCheck, secondCheck]);

    expect(results).toEqual([
      { allowed: true, maxSteps: 4 },
      { allowed: true, maxSteps: 4 },
    ]);
    expect(budget.currentMaxSteps()).toBe(4);
    expect(requestExtension).toHaveBeenCalledOnce();
    expect(onLimitReached).toHaveBeenCalledOnce();
    expect(onMaxStepsExtended).toHaveBeenCalledOnce();
    expect(onMaxStepsExtended).toHaveBeenCalledWith(4);
  });

  it('should reject a non-positive extension without changing the shared limit', async () => {
    const budget = new WorkflowStepBudget(1);

    const result = await budget.check({
      request: { currentIteration: 1, currentStep: 'next-step', scope: scope('next-step') },
      ignoreLimit: false,
      onLimitReached: vi.fn(),
      onMaxStepsExtended: vi.fn(),
      requestExtension: vi.fn().mockResolvedValue(0),
    });

    expect(result).toEqual({ allowed: false, maxSteps: 1 });
    expect(budget.currentMaxSteps()).toBe(1);
  });

  it('should share one rejected decision with concurrent checks in the same generation', async () => {
    const budget = new WorkflowStepBudget(1);
    const decisionStarted = deferred();
    const releaseDecision = deferred();
    const requestExtension = vi.fn(async () => {
      decisionStarted.resolve();
      await releaseDecision.promise;
      return null;
    });
    const onLimitReached = vi.fn();
    const first = budget.check({
      request: { currentIteration: 1, currentStep: 'first', scope: scope('first') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended: vi.fn(),
      requestExtension,
    });
    await decisionStarted.promise;
    const second = budget.check({
      request: { currentIteration: 1, currentStep: 'second', scope: scope('second') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended: vi.fn(),
      requestExtension,
    });

    releaseDecision.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { allowed: false, maxSteps: 1 },
      { allowed: false, maxSteps: 1 },
    ]);
    expect(requestExtension).toHaveBeenCalledOnce();
    expect(onLimitReached).toHaveBeenCalledOnce();
    expect(requestExtension.mock.calls[0]?.[0].scope.stack.at(-1)?.step).toBe('first');
  });

  it('publishes the generation decision before emitting the limit notification', async () => {
    const budget = new WorkflowStepBudget(1);
    const requestExtension = vi.fn().mockResolvedValue(null);
    let reentrantCheck: Promise<{ allowed: boolean; maxSteps: number | 'infinite' }> | undefined;
    const onLimitReached = vi.fn(() => {
      reentrantCheck = budget.check({
        request: { currentIteration: 1, currentStep: 'reentrant', scope: scope('reentrant') },
        ignoreLimit: false,
        onLimitReached,
        onMaxStepsExtended: vi.fn(),
        requestExtension,
      });
    });

    const first = budget.check({
      request: { currentIteration: 1, currentStep: 'first', scope: scope('first') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended: vi.fn(),
      requestExtension,
    });

    await expect(first).resolves.toEqual({ allowed: false, maxSteps: 1 });
    await expect(reentrantCheck).resolves.toEqual({ allowed: false, maxSteps: 1 });
    expect(onLimitReached).toHaveBeenCalledOnce();
    expect(requestExtension).toHaveBeenCalledOnce();
  });

  it('rechecks each waiter against the extended generation limit', async () => {
    const budget = new WorkflowStepBudget(2);
    const extensionStarted = deferred();
    const releaseExtension = deferred();
    const requestExtension = vi.fn()
      .mockImplementationOnce(async () => {
        extensionStarted.resolve();
        await releaseExtension.promise;
        return 2;
      })
      .mockResolvedValueOnce(null);
    const onLimitReached = vi.fn();
    const first = budget.check({
      request: { currentIteration: 2, currentStep: 'first', scope: scope('first') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended: vi.fn(),
      requestExtension,
    });
    await extensionStarted.promise;
    const laterWaiter = budget.check({
      request: { currentIteration: 4, currentStep: 'later', scope: scope('later') },
      ignoreLimit: false,
      onLimitReached,
      onMaxStepsExtended: vi.fn(),
      requestExtension,
    });

    releaseExtension.resolve();

    await expect(first).resolves.toEqual({ allowed: true, maxSteps: 4 });
    await expect(laterWaiter).resolves.toEqual({ allowed: false, maxSteps: 4 });
    expect(requestExtension).toHaveBeenCalledTimes(2);
    expect(onLimitReached).toHaveBeenCalledTimes(2);
    expect(requestExtension.mock.calls[1]?.[0].scope.stack.at(-1)?.step).toBe('later');
  });
});
