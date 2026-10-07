/**
 * Worker pool の結果集計・再キュー・停止境界を検証する。
 * タスク名の端末表示と、識別用の原値の保持も検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import type { AutoRequeueResult, TaskInfo } from '../infra/task/index.js';
import type { executeRunTaskAndComplete as ExecuteRunTask } from '../features/tasks/execute/runTaskExecution.js';

const { executeRunTaskAndComplete } = vi.hoisted(() => ({
  executeRunTaskAndComplete: vi.fn(),
}));

vi.mock('../shared/exitCodes.js', () => ({ EXIT_SIGINT: 130 }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: vi.fn((key: string) => key) }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ trace: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete,
}));
vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: vi.fn(),
}));
vi.mock('../features/tasks/execute/inputWait.js', () => ({ isInputWaiting: vi.fn(() => false) }));

import { attemptAutoRequeueTask, requeueExistingFailedTasks, runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { isInputWaiting } from '../features/tasks/execute/inputWait.js';

const taskNames = [
  { name: 'alpha', displayName: 'alpha' },
  { name: '\x1b[2Jalpha\r\nforged\x07\x9b0m', displayName: 'alpha\\r\\nforged\\x07\\x9b0m' },
];

function createTask(name: string, issue?: number): TaskInfo {
  return {
    name,
    content: name,
    filePath: `/tasks/${name}.yaml`,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    data: {
      task: name,
      workflow: 'default',
      ...(issue === undefined ? {} : { issue }),
    },
  };
}

function createRunner(taskBatches: TaskInfo[][] = []) {
  let batchIndex = 0;
  return {
    claimNextTasks: vi.fn(() => taskBatches[batchIndex++] ?? []),
    completeTask: vi.fn(),
    listTaskStateItems: vi.fn(() => []),
    failTask: vi.fn(),
    listFailedTasks: vi.fn(() => [] as TaskInfo[]),
    autoRequeueFailedTask: vi.fn((): AutoRequeueResult => ({
      requeued: false,
      attempt: 1,
      maxAttempts: 1,
      reason: 'max_attempts_reached' as const,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isInputWaiting).mockReturnValue(false);
  executeRunTaskAndComplete.mockResolvedValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runWithWorkerPool', () => {
  it.each((['run', 'watch'] as const).flatMap((mode) =>
    [false, true].flatMap((externalSignals) =>
      ([true, false, 'reject'] as const).map((remainingResult) => ({ mode, externalSignals, remainingResult }))),
  ))('$mode 外部信号=$externalSignals 残存結果=$remainingResult でも全件終了後に元の claim 例外を返す', async ({ mode, externalSignals, remainingResult }) => {
    vi.useFakeTimers();
    const controls = Array.from({ length: 3 }, () => {
      let resolve!: (value: boolean) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    });
    let index = 0;
    executeRunTaskAndComplete.mockImplementation(() => controls[index++]!.promise);
    const tasks = [createTask('first'), createTask('remaining'), createTask('last')];
    const runner = createRunner([tasks]);
    const originalError = new Error('claim failed');
    const scheduling = new AbortController();
    const taskAbort = new AbortController();
    const listeners = process.rawListeners('SIGINT');
    const pool = runWithWorkerPool(runner as never, mode === 'run' ? tasks : [], 3, '/cwd', undefined, undefined, 500, mode,
      externalSignals ? { schedulingSignal: scheduling.signal, taskAbortSignal: taskAbort.signal } : undefined);
    let settled = false;
    const outcome = pool.then(() => { settled = true; return undefined; }, (error: unknown) => {
      settled = true;
      return error;
    });
    runner.claimNextTasks.mockImplementation(() => { throw originalError; });
    try {
      controls[0]!.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.claimNextTasks.mock.results.at(-1)?.type).toBe('throw');
      const claimCount = runner.claimNextTasks.mock.calls.length;
      expect(settled).toBe(false);
      if (mode === 'watch') {
        if (externalSignals) scheduling.abort();
        else process.rawListeners('SIGINT').find((listener) => !listeners.includes(listener))!.call(process, 'SIGINT');
        const parallel = executeRunTaskAndComplete.mock.calls[1]?.[4] as Parameters<typeof ExecuteRunTask>[4];
        expect(parallel?.abortSignal?.aborted).toBe(false);
      }
      if (remainingResult === 'reject') controls[1]!.reject(new Error('remaining task failed'));
      else controls[1]!.resolve(remainingResult);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(process.rawListeners('SIGINT').length).toBe(listeners.length + (externalSignals ? 0 : 1));
      controls[2]!.resolve(true);
      expect(await outcome).toBe(originalError);
      expect(runner.claimNextTasks).toHaveBeenCalledTimes(claimCount);
      expect(runner.autoRequeueFailedTask).not.toHaveBeenCalled();
      expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(3);
      expect(process.rawListeners('SIGINT')).toEqual(listeners);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (const control of controls) control.resolve(true);
      await outcome;
    }
  });

  it('入口の停止信号を使い、SIGINT ハンドラを重複登録しない', async () => {
    const scheduling = new AbortController();
    const taskAbort = new AbortController();
    const listeners = process.rawListeners('SIGINT');
    const runner = createRunner();
    executeRunTaskAndComplete.mockImplementationOnce((...args: Parameters<typeof ExecuteRunTask>) => {
      expect(process.rawListeners('SIGINT')).toEqual(listeners);
      expect(args[4]?.abortSignal).toBe(taskAbort.signal);
      scheduling.abort();
      return Promise.resolve(true);
    });
    await expect(runWithWorkerPool(runner as never, [createTask('first'), createTask('second')], 1,
      '/cwd', undefined, undefined, 10, 'run',
      { schedulingSignal: scheduling.signal, taskAbortSignal: taskAbort.signal }))
      .resolves.toEqual({ success: 1, fail: 0, executedTaskNames: ['first'] });
    expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(1);
    expect(runner.claimNextTasks).not.toHaveBeenCalled();
    expect(process.rawListeners('SIGINT')).toEqual(listeners);
  });
  it.each(taskNames.flatMap((task) => [1, 3].map((concurrency) => ({ ...task, concurrency }))))(
    'concurrency=$concurrency の見出しを安全に表示し、実行・集計には原名を使う: $displayName',
    async ({ name, displayName, concurrency }) => {
      const task = createTask(name);
      const result = await runWithWorkerPool(createRunner() as never, [task], concurrency, '/cwd', undefined, undefined, 10);

      expect(executeRunTaskAndComplete.mock.calls[0]?.[0]).toEqual(task);
      expect(result.executedTaskNames).toEqual([name]);
      if (concurrency === 1) {
        expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] === Task: ${displayName} ===`));
      } else {
        expect(process.stdout.write).toHaveBeenCalledWith(`\x1b[36m[alph]\x1b[0m === Task: ${displayName} ===\n`);
        expect(executeRunTaskAndComplete.mock.calls[0]?.[4]).toMatchObject({ taskPrefix: name });
      }
    },
  );

  it('watch は SIGINT 後もタスクを中断せず、自然な完了を待って停止する', async () => {
    vi.useFakeTimers();
    let finish!: (success: boolean) => void;
    const execution = new Promise<boolean>((resolve) => { finish = resolve; });
    executeRunTaskAndComplete.mockImplementationOnce((...args: Parameters<typeof ExecuteRunTask>) => {
      args[4]?.abortSignal?.addEventListener('abort', () => finish(false), { once: true });
      return execution;
    });
    const runner = createRunner([[createTask('running')], [createTask('should-not-start')]]);
    const listenersBefore = process.rawListeners('SIGINT');
    const pool = runWithWorkerPool(runner as never, [], 1, '/cwd', undefined, undefined, 500, 'watch');
    const handler = process.rawListeners('SIGINT').find((listener) => !listenersBefore.includes(listener));
    let settled = false;
    let interrupted = false;
    void pool.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const args = executeRunTaskAndComplete.mock.calls[0] as Parameters<typeof ExecuteRunTask>;
      const signal = args[4]?.abortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      const claimCount = runner.claimNextTasks.mock.calls.length;
      handler!.call(process, 'SIGINT');
      interrupted = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(signal?.aborted).toBe(false);
      expect(settled).toBe(false);
      expect(runner.claimNextTasks).toHaveBeenCalledTimes(claimCount);
      expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(1);
      finish(true);
      await expect(pool).resolves.toEqual({ success: 0, fail: 0, executedTaskNames: [] });
      expect(signal?.aborted).toBe(false);
      expect(settled).toBe(true);
    } finally {
      if (!interrupted) handler!.call(process, 'SIGINT');
      finish(true);
      await pool;
    }
    expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('同じ watch pool が入力待ち解除後の到着を実行し、履歴を蓄積せず停止する', async () => {
    vi.useFakeTimers();
    vi.mocked(isInputWaiting).mockReturnValue(true);
    const runner = createRunner([[createTask('arrival')], []]);
    const pool = runWithWorkerPool(runner as never, [], 1, '/cwd', undefined, undefined, 500, 'watch');
    let settled = false;
    void pool.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(runner.claimNextTasks).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      vi.mocked(isInputWaiting).mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      process.emit('SIGINT');
      await pool;
    }
    await expect(pool).resolves.toEqual({ success: 0, fail: 0, executedTaskNames: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('成功・失敗を集計し、実行済みタスク名を返す', async () => {
    const runner = createRunner();
    executeRunTaskAndComplete
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await runWithWorkerPool(
      runner as never,
      [createTask('passed'), createTask('failed')],
      2,
      '/cwd',
      undefined,
      undefined,
      10,
    );

    expect(result).toEqual({
      success: 1,
      fail: 1,
      executedTaskNames: ['passed', 'failed'],
    });
  });

  it('空の入力では実行せずゼロ件を返す', async () => {
    const runner = createRunner();

    await expect(runWithWorkerPool(
      runner as never,
      [],
      2,
      '/cwd',
      undefined,
      undefined,
      10,
    )).resolves.toEqual({ success: 0, fail: 0, executedTaskNames: [] });
    expect(executeRunTaskAndComplete).not.toHaveBeenCalled();
  });

  it('空いたスロットをポーリングで追加タスクに割り当てる', async () => {
    const runner = createRunner([[createTask('later')], []]);

    const result = await runWithWorkerPool(
      runner as never,
      [createTask('first')],
      2,
      '/cwd',
      undefined,
      undefined,
      10,
    );

    expect(result.success).toBe(2);
    expect(result.fail).toBe(0);
    expect(result.executedTaskNames).toEqual(expect.arrayContaining(['first', 'later']));
    expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(2);
    expect(runner.claimNextTasks).toHaveBeenCalled();
  });

  it('並列数を超えて同時実行しない', async () => {
    let active = 0;
    let maxActive = 0;
    executeRunTaskAndComplete.mockImplementation(() => new Promise<boolean>((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        resolve(true);
      }, 5);
    }));

    const result = await runWithWorkerPool(
      createRunner() as never,
      Array.from({ length: 4 }, (_, index) => createTask(`task-${index}`)),
      2,
      '/cwd',
      undefined,
      undefined,
      10,
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(result.success).toBe(4);
    expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(4);
  });

  it.each(taskNames)('失敗後の再投入は安全に表示し、再試行を失敗数に二重計上しない: $displayName', async ({ name, displayName }) => {
    const retry = createTask(name);
    const runner = createRunner([[retry], []]);
    runner.autoRequeueFailedTask.mockReturnValue({
      requeued: true,
      attempt: 1,
      maxAttempts: 2,
      reason: 'requeued',
    });
    executeRunTaskAndComplete
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await runWithWorkerPool(
      runner as never,
      [createTask(name)],
      1,
      '/cwd',
      undefined,
      { autoRequeueMaxAttempts: 2 },
      10,
    );

    expect(runner.autoRequeueFailedTask).toHaveBeenCalledWith(name, { maxAttempts: 2 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/2)`));
    expect(result).toMatchObject({ success: 1, fail: 0 });
    expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(2);
  });

  it('タスク実行の reject を失敗として集計する', async () => {
    executeRunTaskAndComplete.mockRejectedValue(new Error('execution failed'));

    const result = await runWithWorkerPool(
      createRunner() as never,
      [createTask('throws')],
      1,
      '/cwd',
      undefined,
      undefined,
      10,
    );

    expect(result).toEqual({ success: 0, fail: 1, executedTaskNames: ['throws'] });
  });

  it('SIGINT 後は新規タスクを開始せず、実行中タスクの完了を待つ', async () => {
    let receivedSignal: AbortSignal | undefined;
    executeRunTaskAndComplete.mockImplementationOnce((_task, _runner, _cwd, _options, parallel) => {
      receivedSignal = parallel?.abortSignal;
      return new Promise<boolean>((resolve) => {
        receivedSignal?.addEventListener('abort', () => resolve(false), { once: true });
        setImmediate(() => process.emit('SIGINT'));
      });
    });

    const runner = createRunner([[createTask('should-not-start')]]);
    const result = await runWithWorkerPool(
      runner as never,
      [createTask('running')],
      1,
      '/cwd',
      undefined,
      undefined,
      10,
    );

    expect(receivedSignal?.aborted).toBe(true);
    expect(executeRunTaskAndComplete).toHaveBeenCalledTimes(1);
    expect(runner.claimNextTasks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: 0, fail: 1 });
  });
});

describe('requeueExistingFailedTasks', () => {
  it.each([undefined, 0])('上限=%s では failed を取得しない', (maxAttempts) => {
    const runner = createRunner();
    expect(requeueExistingFailedTasks(runner as never, maxAttempts)).toBe(0);
    expect(runner.listFailedTasks).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('適格な failed だけ再投入し、成功件数を返す', () => {
    const runner = createRunner();
    runner.listFailedTasks.mockReturnValue([createTask('eligible'), createTask('ineligible')]);
    runner.autoRequeueFailedTask.mockReturnValueOnce({
      requeued: true, attempt: 1, maxAttempts: 1, reason: 'requeued',
    });
    expect(requeueExistingFailedTasks(runner as never, 1)).toBe(1);
    expect(runner.autoRequeueFailedTask.mock.calls).toEqual([
      ['eligible', { maxAttempts: 1 }], ['ineligible', { maxAttempts: 1 }],
    ]);
  });

  it('停止済みなら failed を取得・再投入しない', () => {
    const runner = createRunner();
    const controller = new AbortController();
    controller.abort();
    expect(requeueExistingFailedTasks(runner as never, 1, controller.signal)).toBe(0);
    expect(runner.listFailedTasks).not.toHaveBeenCalled();
    expect(runner.autoRequeueFailedTask).not.toHaveBeenCalled();
  });
});

describe('attemptAutoRequeueTask の端末表示', () => {
  it.each(taskNames)('再投入成功ログだけ変換し、識別には原名を使う: $displayName', ({ name, displayName }) => {
    const runner = createRunner();
    runner.autoRequeueFailedTask.mockReturnValue({ requeued: true, attempt: 1, maxAttempts: 1, reason: 'requeued' });

    expect(attemptAutoRequeueTask(runner as never, name, 1)).toBe(true);
    expect(runner.autoRequeueFailedTask).toHaveBeenCalledWith(name, { maxAttempts: 1 });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
  });

  it.each([
    ['task_not_failed', 'task is not failed'],
    ['max_attempts_reached', 'max attempts reached'],
    ['failure_not_retryable', 'failure is not retryable'],
    ['missing_failed_step', 'failed step is missing'],
    ['missing_failure_detail', 'failure detail is missing'],
  ] as const)('スキップ理由 %s でも名前を安全に表示する', (reason, description) => {
    const { name, displayName } = taskNames[1]!;
    const runner = createRunner();
    runner.autoRequeueFailedTask.mockReturnValue({ requeued: false, attempt: 0, maxAttempts: 1, reason });

    expect(attemptAutoRequeueTask(runner as never, name, 1)).toBe(false);
    expect(runner.autoRequeueFailedTask).toHaveBeenCalledWith(name, { maxAttempts: 1 });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(chalk.blue(`[INFO] Task "${displayName}" was not auto-requeued: ${description} (0/1)`));
  });

  it('上限0では再投入とログ出力を行わない', () => {
    const runner = createRunner();
    expect(attemptAutoRequeueTask(runner as never, taskNames[1]!.name, 0)).toBe(false);
    expect(runner.autoRequeueFailedTask).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });
});
