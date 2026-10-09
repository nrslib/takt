import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { SystemStepExecutor } from '../core/workflow/engine/SystemStepExecutor.js';
import type { SystemStepInputResolutionContext } from '../core/workflow/system/system-step-services.js';
import { makeRule, makeStep } from './test-helpers.js';
import { PrStatusTimeoutError } from '../core/workflow/system/pr-execution-context.js';

function createState(iteration = 1): WorkflowState {
  return {
    workflowName: 'wait-test', currentStep: 'wait_external', iteration,
    stepOutputs: new Map(), structuredOutputs: new Map(), systemContexts: new Map(),
    effectResults: new Map(), userInputs: [], personaSessions: new Map(),
    stepIterations: new Map(), status: 'running',
    restoredStepIterationNames: new Set(), dynamicParallelSelections: new Map(), dynamicFacetSelections: new Map(),
  };
}

function createHarness() {
  let ready = false;
  const resolveSystemInput = vi.fn((_input: unknown, _state: unknown, _step: unknown, context: SystemStepInputResolutionContext) => {
    if (!context.cache.has('external')) context.cache.set('external', { ready });
    return context.cache.get('external');
  });
  const executeEffect = vi.fn().mockResolvedValue({ success: true, failed: false });
  const executor = new SystemStepExecutor({
    task: 'Wait for an external resource', projectCwd: '/project', getCwd: () => '/clone',
    getRuleContext: () => ({ interactive: false }),
    getStatusJudgmentContext: () => { throw new Error('Machine rules must not invoke an agent'); },
    systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
  });
  const step = Object.assign(makeStep({
    name: 'wait_external', kind: 'system',
    systemInputs: [{ type: 'task_context', source: 'current_task', as: 'resource' }],
    effects: [{ type: 'comment_pr', pr: 123, body: 'Ready: {context:wait_external.resource.ready}' }],
    rules: [makeRule('when(context.wait_external.resource.ready == true)', 'COMPLETE'), makeRule('when(true)', 'ABORT')],
  }), {
    wait: { until: 'when(context.wait_external.resource.ready == true)', intervalMs: 100, maxRetries: 2, onTimeout: 'ABORT' },
  });
  return { executor, step, resolveSystemInput, executeEffect, setReady: () => { ready = true; } };
}

describe('System step polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('同じ実行で外部状態を再取得し、保持済みcontextとeffectの入力を更新する', async () => {
    const harness = createHarness();
    const state = createState();
    const running = harness.executor.run(harness.step, state);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.systemContexts.get('wait_external')).toEqual({ resource: { ready: false } });
    expect(harness.executeEffect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(1);
    harness.setReady();
    await vi.advanceTimersByTimeAsync(1);
    const response = await running;
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(2);
    expect(state.systemContexts.get('wait_external')).toEqual({ resource: { ready: true } });
    expect(response.matchedRuleIndex).toBe(0);
    expect(harness.executeEffect).toHaveBeenCalledOnce();
    expect(harness.executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 123, body: 'Ready: true' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(2);
  });

  it('初回取得で条件を満たす場合は待機せずeffectを一度だけ実行する', async () => {
    const harness = createHarness();
    harness.setReady();
    const running = harness.executor.run(harness.step, createState());
    await vi.advanceTimersByTimeAsync(0);
    expect((await running).matchedRuleIndex).toBe(0);
    expect(harness.resolveSystemInput).toHaveBeenCalledOnce();
    expect(harness.executeEffect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 25])('他stepが消費したiteration=%sに関係なくstep自身の上限まで再取得する', async (iteration) => {
    const harness = createHarness();
    const running = harness.executor.run(harness.step, createState(iteration));
    await vi.advanceTimersByTimeAsync(200);
    await running;
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(harness.executeEffect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('上限の最後の再取得で条件が成立すればeffectを実行する', async () => {
    const harness = createHarness();
    const running = harness.executor.run(harness.step, createState());
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(2);
    harness.setReady();
    await vi.advanceTimersByTimeAsync(100);
    expect((await running).matchedRuleIndex).toBe(0);
    expect(harness.executeEffect).toHaveBeenCalledOnce();
  });

  it('再取得失敗を成功に変換せずeffectを実行しない', async () => {
    const harness = createHarness();
    harness.resolveSystemInput.mockImplementationOnce(() => ({ ready: false }))
      .mockImplementationOnce(() => { throw new Error('external lookup failed'); });
    const running = harness.executor.run(harness.step, createState()).then(
      (response) => ({ response }), (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ error: expect.objectContaining({ message: 'external lookup failed' }) });
    expect(harness.resolveSystemInput).toHaveBeenCalledTimes(2);
    expect(harness.executeEffect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waitがないsystem stepは一回取得して通常rulesを評価する', async () => {
    const harness = createHarness();
    const step = makeStep({ name: 'once', kind: 'system',
      systemInputs: [{ type: 'task_context', source: 'current_task', as: 'resource' }],
      rules: [makeRule('when(context.once.resource.ready == false)', 'COMPLETE')],
    });
    const running = harness.executor.run(step, createState());
    await vi.advanceTimersByTimeAsync(0);
    expect((await running).matchedRuleIndex).toBe(0);
    expect(harness.resolveSystemInput).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('取得期限切れ後は前回の成立contextを評価せず上限へ進む', async () => {
    const h = createHarness();
    const state = createState();
    state.systemContexts.set(h.step.name, { resource: { ready: true } });
    h.resolveSystemInput.mockImplementation(() => Promise.reject(new PrStatusTimeoutError()));
    const running = h.executor.run(h.step, state);
    await vi.advanceTimersByTimeAsync(200);
    expect(await running).toMatchObject({ systemWaitTimeout: true });
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(h.executeEffect).not.toHaveBeenCalled();
  });

  function delayedLookup(durationMs: number, context: SystemStepInputResolutionContext): Promise<{ ready: boolean }> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearTimeout(completion);
        reject(new PrStatusTimeoutError());
      }, context.prStatusFetchOptions!.timeoutMs);
      const completion = setTimeout(() => {
        clearTimeout(deadline);
        resolve({ ready: true });
      }, durationMs);
    });
  }

  it.each([200, 15_001])('間隔1msの初回取得を独立した期限で判定する（取得%s ms）', async (durationMs) => {
    const h = createHarness();
    h.step.wait.intervalMs = 1;
    h.step.wait.maxRetries = 0;
    h.resolveSystemInput.mockImplementation((_input, _state, _step, context) => delayedLookup(durationMs, context));
    const running = h.executor.run(h.step, createState());
    await vi.advanceTimersByTimeAsync(Math.min(durationMs, 15_000) - 1);
    expect(h.executeEffect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const response = await running;
    expect(h.resolveSystemInput).toHaveBeenCalledOnce();
    expect(response.systemWaitTimeout === true).toBe(durationMs > 15_000);
    expect(h.executeEffect).toHaveBeenCalledTimes(durationMs > 15_000 ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 15_001])('100ms待機後の再取得を独立した期限で判定する（取得%s ms）', async (durationMs) => {
    const h = createHarness();
    const state = createState();
    h.resolveSystemInput.mockImplementationOnce(() => ({ ready: false }))
      .mockImplementation((_input, _state, _step, context) => delayedLookup(durationMs, context));
    const running = h.executor.run(h.step, state);
    await vi.advanceTimersByTimeAsync(99);
    expect(h.resolveSystemInput).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(Math.min(durationMs, 15_000) - 1);
    expect(h.executeEffect).not.toHaveBeenCalled();
    expect(state.systemContexts.get(h.step.name)).toEqual({ resource: { ready: false } });
    await vi.advanceTimersByTimeAsync(1);
    if (durationMs > 15_000) {
      await vi.advanceTimersByTimeAsync(99);
      expect(h.resolveSystemInput).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1 + 15_000);
    }
    const response = await running;
    expect(response.systemWaitTimeout === true).toBe(durationMs > 15_000);
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(durationMs > 15_000 ? 3 : 2);
    expect(h.executeEffect).toHaveBeenCalledTimes(durationMs > 15_000 ? 0 : 1);
    expect(state.systemContexts.get(h.step.name)).toEqual({ resource: { ready: durationMs <= 15_000 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('最後の取得だけ期限切れでも途中のbindingをcontextへ公開しない', async () => {
    const h = createHarness();
    const step = makeStep({ name: 'once', kind: 'system', systemInputs: [
      { type: 'task_context', source: 'current_task', as: 'first' },
      { type: 'task_context', source: 'current_task', as: 'second' },
    ], rules: [makeRule('when(true)', 'COMPLETE')] });
    const state = createState();
    state.systemContexts.set('once', { first: 'old', second: 'old' });
    h.resolveSystemInput.mockImplementationOnce(() => Promise.resolve('new'))
      .mockImplementationOnce(() => Promise.reject(new PrStatusTimeoutError()));
    await expect(h.executor.run(step, state)).rejects.toBeInstanceOf(PrStatusTimeoutError);
    expect(state.systemContexts.get('once')).toEqual({ first: 'old', second: 'old' });
    expect(h.executeEffect).not.toHaveBeenCalled();
  });

  it('最後の再取得が期限切れならeffectを実行しない', async () => {
    const h = createHarness();
    h.resolveSystemInput.mockImplementationOnce(() => ({ ready: false }))
      .mockImplementationOnce(() => ({ ready: false }))
      .mockImplementationOnce(() => Promise.reject(new PrStatusTimeoutError()));
    const running = h.executor.run(h.step, createState());
    await vi.advanceTimersByTimeAsync(200);
    expect(await running).toMatchObject({ systemWaitTimeout: true });
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(h.executeEffect).not.toHaveBeenCalled();
  });
});
