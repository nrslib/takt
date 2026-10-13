import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from '../core/workflow/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

describe('Workflow engine external-state waiting', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-wait-engine-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function harness(wait: Record<string, unknown> = { interval_ms: 100, max_retries: 2 }, directMaxRetries?: number) {
    let finished = false;
    let passed = false;
    const resolveSystemInput = vi.fn(() => ({ finished, passed }));
    const executeEffect = vi.fn().mockResolvedValue({ success: true, failed: false });
    const config = normalizeWorkflowConfig({
      name: 'wait-engine', initial_step: 'prepare', max_steps: 3,
      steps: [
        { name: 'prepare', mode: 'system', rules: [{ condition: 'when(true)', next: 'wait_ci' }] },
        { name: 'wait_ci', mode: 'system',
          system_inputs: [{ type: 'task_context', source: 'current_task', as: 'status' }],
          wait: { until: 'when(context.wait_ci.status.finished == true)', on_timeout: 'timeout', ...wait },
          effects: [{ type: 'comment_pr', pr: 123, body: 'CI finished: {context:wait_ci.status.passed}' }],
          rules: [
            { condition: 'when(context.wait_ci.status.passed == true)', next: 'COMPLETE' },
            { condition: 'when(true)', next: 'ABORT' },
          ],
        },
        { name: 'timeout', mode: 'system',
          effects: [{ type: 'comment_pr', pr: 123, body: 'CI timed out' }],
          rules: [{ condition: 'when(true)', next: 'ABORT' }],
        },
      ],
    }, projectDir);
    if (directMaxRetries !== undefined) {
      const step = config.steps[1]!;
      if (step.kind !== 'system' || !step.wait) throw new Error('Expected waiting system step');
      step.wait.maxRetries = directMaxRetries;
    }
    const engine = new WorkflowEngine(config, projectDir, 'Wait on PR 123', {
      provider: 'mock', projectCwd: projectDir, reportDirName: 'wait-engine-report',
      structuredCaller: { judgeStatus: vi.fn(), evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn() },
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    });
    return { engine, resolveSystemInput, executeEffect, finish: (success: boolean) => { finished = true; passed = success; } };
  }

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('公開engine入口で不正な再試行上限%sを実行前に拒否する', (maxRetries) => {
    expect(() => harness(undefined, maxRetries)).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 2, Number.MAX_SAFE_INTEGER])('直接設定の有効な再試行上限%sをengineが受理する', (maxRetries) => {
    const h = harness(undefined, maxRetries);
    h.engine.abort();
  });

  it.each([2, 1.5])('子workflowの再試行上限%sにも共有validatorを適用する', async (maxRetries) => {
    const child = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'wait_ci', max_steps: 2,
      steps: [
        { name: 'wait_ci', mode: 'system',
          system_inputs: [{ type: 'task_context', source: 'current_task', as: 'status' }],
          wait: { until: 'when(context.wait_ci.status.finished == true)', max_retries: 2, on_timeout: 'timeout' },
          effects: [{ type: 'comment_pr', pr: 123, body: 'Child CI finished' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
        { name: 'timeout', mode: 'system', rules: [{ condition: 'when(true)', next: 'ABORT' }] },
      ],
    }, projectDir);
    const step = child.steps[0]!;
    if (step.kind !== 'system' || !step.wait) throw new Error('Expected waiting system step');
    step.wait.maxRetries = maxRetries;
    const parent = normalizeWorkflowConfig({
      name: 'parent', initial_step: 'delegate', max_steps: 4,
      steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }, projectDir);
    const resolveSystemInput = vi.fn(() => ({ finished: true }));
    const executeEffect = vi.fn().mockResolvedValue({ success: true, failed: false });
    const engine = new WorkflowEngine(parent, projectDir, 'Wait in child', {
      provider: 'mock', projectCwd: projectDir, workflowCallResolver: () => child,
      structuredCaller: { judgeStatus: vi.fn(), evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn() },
      systemStepServicesFactory: () => ({ resolveSystemInput, executeEffect }),
    });
    const aborted = vi.fn();
    engine.on('workflow:abort', aborted);
    const state = await engine.run();
    expect(state.status).toBe(maxRetries === 2 ? 'completed' : 'aborted');
    expect(resolveSystemInput).toHaveBeenCalledTimes(maxRetries === 2 ? 1 : 0);
    expect(executeEffect).toHaveBeenCalledTimes(maxRetries === 2 ? 1 : 0);
    if (maxRetries !== 2) {
      expect(aborted.mock.calls[0]?.[1]).toContain('wait.max_retries must be a nonnegative safe integer');
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 2])('上限%sで理由を対象PRへ一度だけコメントしmergeを行わない', async (max_retries) => {
    const h = harness({ interval_ms: 100, max_retries });
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(100 * max_retries);
    expect((await running).status).toBe('aborted');
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(max_retries + 1);
    expect(h.executeEffect).toHaveBeenCalledOnce();
    expect(h.executeEffect.mock.calls[0]?.[0]).toMatchObject({ type: 'comment_pr' });
    expect(h.executeEffect.mock.calls[0]?.[1]).toMatchObject({ pr: 123, body: 'CI timed out' });
  });

  it('最後の再取得の成立でtimeoutへ遷移せず通常経路へ進む', async () => {
    const h = harness();
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(100);
    h.finish(true);
    await vi.advanceTimersByTimeAsync(100);
    expect((await running).status).toBe('completed');
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(h.executeEffect).toHaveBeenCalledOnce();
    expect(h.executeEffect.mock.calls[0]?.[1]).toMatchObject({ body: 'CI finished: true' });
  });

  it.each([true, false])('同一engineの保持contextをCI実行中から決着へ更新する（成功=%s）', async (passed) => {
    const h = harness();
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(0);
    const before = h.engine.getState().systemContexts.get('wait_ci');
    const effectsBefore = h.executeEffect.mock.calls.length;
    h.finish(passed);
    await vi.advanceTimersByTimeAsync(100);
    const state = await running;
    expect(before).toEqual({ status: { finished: false, passed: false } });
    expect(effectsBefore).toBe(0);
    expect(state.systemContexts.get('wait_ci')).toEqual({ status: { finished: true, passed } });
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(2);
    expect(h.executeEffect).toHaveBeenCalledOnce();
    expect(h.executeEffect.mock.calls[0]?.[1]).toMatchObject({ body: `CI finished: ${passed}` });
    expect(state.status).toBe(passed ? 'completed' : 'aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('通常stepの予算を消費した後も指定回数待機しタイムアウト専用stepへ遷移する', async () => {
    const h = harness();
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(200);
    const state = await running;
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(3);
    expect(state.status).toBe('aborted');
    expect(h.executeEffect).toHaveBeenCalledOnce();
    expect(h.executeEffect.mock.calls[0]?.[1]).toMatchObject({ body: 'CI timed out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('既定値は即時取得と15秒ごとの120回再取得で30分まで待つ', async () => {
    const h = harness({});
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(1_799_999);
    const countBeforeTimeout = h.resolveSystemInput.mock.calls.length;
    const effectsBeforeTimeout = h.executeEffect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(countBeforeTimeout).toBe(120);
    expect(effectsBeforeTimeout).toBe(0);
    expect(h.resolveSystemInput).toHaveBeenCalledTimes(121);
    expect(h.executeEffect.mock.calls[0]?.[1]).toMatchObject({ body: 'CI timed out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('engineの中断で待機timerを解除し再取得や終端effectを行わない', async () => {
    const h = harness();
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(0);
    h.engine.abort();
    await vi.advanceTimersByTimeAsync(0);
    const state = await running;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.status).toBe('aborted');
    expect(h.resolveSystemInput).toHaveBeenCalledOnce();
    expect(h.executeEffect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
