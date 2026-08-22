/**
 * Worker pool の結果集計・再キュー・停止境界を検証する。
 * 端末表示のラベルやレイアウトはここでは固定しない。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const { executeRunTaskAndComplete } = vi.hoisted(() => ({
  executeRunTaskAndComplete: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
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

import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';

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
    failTask: vi.fn(),
    autoRequeueFailedTask: vi.fn(() => ({
      requeued: false,
      attempt: 1,
      maxAttempts: 1,
      reason: 'max_attempts_reached' as const,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeRunTaskAndComplete.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runWithWorkerPool', () => {
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

  it('失敗タスクを再キューした場合は再試行を失敗数に二重計上しない', async () => {
    const retry = createTask('retry');
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
      [createTask('retry')],
      1,
      '/cwd',
      undefined,
      { autoRequeueMaxAttempts: 2 },
      10,
    );

    expect(runner.autoRequeueFailedTask).toHaveBeenCalledWith('retry', { maxAttempts: 2 });
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
