import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '../infra/task/types.js';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  updateState: vi.fn(),
  release: vi.fn(),
  failInterrupted: vi.fn(),
  claim: vi.fn(),
  requeue: vi.fn(),
  pool: vi.fn(),
  config: vi.fn(),
}));

vi.mock('../infra/task/project-execution-lock.js', () => ({
  acquireProjectExecutionLock: mocks.acquire,
}));
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    failInterruptedRunningTasks = mocks.failInterrupted;
    claimNextTasks = mocks.claim;
    getTasksFilePath(): string { return '/project/.takt/tasks.yaml'; }
    listAllTaskItems(): never[] { return []; }
  },
}));
vi.mock('../features/tasks/execute/parallelExecution.js', () => ({
  runWithWorkerPool: mocks.pool,
  requeueExistingFailedTasks: mocks.requeue,
}));
vi.mock('../infra/config/index.js', () => ({ resolveWorkflowConfigValues: mocks.config }));
vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  success: vi.fn(), status: vi.fn(), blankLine: vi.fn(),
}));
vi.mock('../shared/ui/StatusLine.js', () => ({ statusLine: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../shared/utils/index.js', () => ({
  getErrorMessage: (error: Error) => error.message,
  getSlackWebhookUrl: () => undefined,
  notifyError: vi.fn(), notifySuccess: vi.fn(), sendSlackNotification: vi.fn(),
  buildSlackRunSummary: vi.fn(), generateRunId: () => 'test-run',
}));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string) => key }));

import { runAllTasks } from '../features/tasks/execute/runAllTasks.js';
import { watchTasks } from '../features/tasks/watch/index.js';

const task: TaskInfo = {
  name: 'first', content: 'first', filePath: '/project/.takt/tasks/first.yaml',
  createdAt: '2026-01-01T00:00:00.000Z', status: 'running',
  data: { task: 'first', workflow: 'default' },
};
const entrypoints = [
  { kind: 'run', execute: runAllTasks },
  { kind: 'watch', execute: watchTasks },
] as const;

describe('プロジェクト実行ロックの入口', () => {
  let listeners: ReturnType<typeof process.rawListeners>;
  let exitListeners: ReturnType<typeof process.rawListeners>;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks)) mock.mockReset();
    listeners = process.rawListeners('SIGINT');
    exitListeners = process.rawListeners('exit');
    mocks.acquire.mockImplementation((_cwd: string, kind: 'run' | 'watch') => ({
      owner: { ownerId: 'test-owner', pid: process.pid, kind, state: 'starting',
        processIdentity: { startTime: 'process-start' } },
      updateState: mocks.updateState, release: mocks.release,
    }));
    mocks.config.mockReturnValue({ concurrency: 2, taskPollIntervalMs: 500,
      autoRequeueMaxAttempts: 1, notificationSound: false });
    mocks.failInterrupted.mockReturnValue(0);
    mocks.requeue.mockReturnValue(0);
    mocks.claim.mockReturnValue([task]);
    mocks.pool.mockResolvedValue({ success: 1, fail: 0, executedTaskNames: ['first'] });
  });

  afterEach(() => {
    for (const listener of process.rawListeners('SIGINT')) {
      if (!listeners.includes(listener)) process.removeListener('SIGINT', listener as () => void);
    }
    for (const listener of process.rawListeners('exit')) {
      if (!exitListeners.includes(listener)) process.removeListener('exit', listener as (code: number) => void);
    }
    vi.restoreAllMocks();
  });

  it.each(entrypoints)('$kind は中断処理・再投入・最初の取得より前にロックを取得する', async ({ kind, execute }) => {
    await execute('/project');

    expect(mocks.acquire).toHaveBeenCalledWith('/project', kind);
    const acquired = mocks.acquire.mock.invocationCallOrder[0]!;
    expect(acquired).toBeLessThan(mocks.failInterrupted.mock.invocationCallOrder[0]!);
    for (const call of [...mocks.claim.mock.invocationCallOrder, ...mocks.requeue.mock.invocationCallOrder]) {
      expect(acquired).toBeLessThan(call);
    }
    expect(acquired).toBeLessThan(mocks.pool.mock.invocationCallOrder[0]!);
  });

  it.each(entrypoints)('$kind は取得拒否時にキューを変更せず実行を開始しない', async ({ execute }) => {
    const conflict = new Error('watch PID 4101');
    mocks.acquire.mockImplementation(() => { throw conflict; });

    await expect(execute('/project')).rejects.toBe(conflict);

    expect(mocks.failInterrupted).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.requeue).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('run は空キューの早期終了でもロックを解放する', async () => {
    mocks.claim.mockReturnValue([]);
    await runAllTasks('/project');
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });

  it('run の初期処理中の SIGINT は再投入へ停止信号を渡し、最初の取得を止める', async () => {
    mocks.failInterrupted.mockImplementation(() => {
      const handler = process.rawListeners('SIGINT').find((listener) => !listeners.includes(listener));
      handler!.call(process, 'SIGINT');
      return 0;
    });
    await runAllTasks('/project');
    expect(mocks.requeue.mock.calls[0]?.[2]).toMatchObject({ aborted: true });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });

  it.each(entrypoints)('$kind は実行中に保持し、成功終了後に解放する', async ({ execute }) => {
    let finish!: (result: { success: number; fail: number; executedTaskNames: string[] }) => void;
    mocks.pool.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const execution = execute('/project');
    void execution.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(mocks.pool).toHaveBeenCalled());
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.updateState).toHaveBeenCalledWith('running');
    } finally {
      finish({ success: 1, fail: 0, executedTaskNames: ['first'] });
      await execution;
    }
    expect(mocks.updateState).toHaveBeenCalledWith('stopping');
    expect(mocks.release).toHaveBeenCalled();
    expect(process.rawListeners('SIGINT')).toEqual(listeners);
    expect(process.rawListeners('exit')).toEqual(exitListeners);
  });

  it('run はタスク失敗の return でも解放する', async () => {
    mocks.pool.mockResolvedValue({ success: 0, fail: 1, executedTaskNames: ['first'] });
    await runAllTasks('/project');
    expect(mocks.release).toHaveBeenCalled();
  });

  it.each(entrypoints)('$kind は初期キュー処理の例外でも解放する', async ({ execute }) => {
    const failure = new Error('initial processing failed');
    mocks.failInterrupted.mockImplementation(() => { throw failure; });
    await expect(execute('/project')).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
  });

  it.each(entrypoints)('$kind はプール例外でも解放する', async ({ execute }) => {
    const failure = new Error('pool failed');
    mocks.pool.mockRejectedValue(failure);
    await expect(execute('/project')).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalled();
  });

  it.each(entrypoints)('$kind は設定エラー時にキュー変更もロック取得も行わない', async ({ execute }) => {
    const failure = new Error('invalid config');
    mocks.config.mockImplementation(() => { throw failure; });
    await expect(execute('/project')).rejects.toBe(failure);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.failInterrupted).not.toHaveBeenCalled();
  });
});
