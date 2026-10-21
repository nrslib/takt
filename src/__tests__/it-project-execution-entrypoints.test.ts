import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { TaskInfo } from '../infra/task/types.js';
import { GoalStore } from '../infra/goals/store.js';
import { PrivateFileLockAcquisitionError } from '../shared/utils/private-file-lock.js';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  updateState: vi.fn(),
  release: vi.fn(),
  failInterrupted: vi.fn(),
  claim: vi.fn(),
  states: vi.fn(),
  requeue: vi.fn(),
  pool: vi.fn(),
  executeTask: vi.fn(),
  config: vi.fn(),
  runner: vi.fn(),

  ensure: vi.fn(),
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: mocks.ensure }));
vi.mock('../infra/task/project-execution-lock.js', async (original) => ({
  ...await original<typeof import('../infra/task/project-execution-lock.js')>(),
  acquireProjectExecutionLock: mocks.acquire,
}));
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    constructor(cwd: string, options?: unknown) { mocks.runner(cwd, options); }
    failInterruptedRunningTasks = mocks.failInterrupted;
    claimNextTasks = mocks.claim;
    getTasksFilePath(): string { return '/project/.takt/tasks.yaml'; }
    listTasksForProviderPreflight(): never[] { return []; }
    listFailedTasks(): never[] { return []; }
    listAllTaskItems(): never[] { return []; }
    listTaskStateItems = mocks.states;
  },
}));
vi.mock('../features/tasks/execute/parallelExecution.js', () => ({
  runWithWorkerPool: mocks.pool,
  requeueExistingFailedTasks: mocks.requeue,
}));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete: mocks.executeTask,
  executeRunTaskAndCompleteWithDetails: vi.fn(),
}));
vi.mock('../features/tasks/execute/forceShutdown.js', () => ({
  forceExitAfterOpenCodeCleanup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../infra/config/index.js', () => ({ resolveWorkflowConfigValues: mocks.config }));
vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  success: vi.fn(), status: vi.fn(), blankLine: vi.fn(),
}));
vi.mock('../shared/ui/StatusLine.js', () => ({ statusLine: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/utils/index.js')>(),
  getErrorMessage: (error: Error) => error.message,
  getSlackWebhookUrl: () => undefined,
  notifyError: vi.fn(), notifySuccess: vi.fn(), sendSlackNotification: vi.fn(),
  buildSlackRunSummary: vi.fn(), generateRunId: () => 'test-run',
}));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string) => key }));

import { runAllTasks } from '../features/tasks/execute/runAllTasks.js';
import { watchTasks } from '../features/tasks/watch/index.js';
import { ProjectExecutionAlreadyRunningError } from '../infra/task/project-execution-lock.js';
import { header, info } from '../shared/ui/index.js';
import { statusLine } from '../shared/ui/StatusLine.js';

const task: TaskInfo = {
  name: 'first', content: 'first', filePath: '/project/.takt/tasks/first.yaml',
  createdAt: '2026-01-01T00:00:00.000Z', status: 'running',
  data: { task: 'first', workflow: 'default' },
};
const entrypoints = [
  { kind: 'run', execute: runAllTasks },
  { kind: 'watch', execute: watchTasks },
] as const;

async function useActualWorkerPool(): Promise<void> {
  const actual = await vi.importActual<typeof import('../features/tasks/execute/parallelExecution.js')>(
    '../features/tasks/execute/parallelExecution.js',
  );
  mocks.pool.mockImplementation(actual.runWithWorkerPool);
}

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
    mocks.states.mockReturnValue([]);
    mocks.pool.mockResolvedValue({ success: 1, fail: 0, executedTaskNames: ['first'] });
    mocks.executeTask.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('run は空キューの pool が完了した後にロックを解放する', async () => {
    mocks.claim.mockReturnValue([]);
    mocks.pool.mockResolvedValue({ success: 0, fail: 0, executedTaskNames: [] });
    await runAllTasks('/project');
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(mocks.pool.mock.calls[0]![1]).toEqual([]);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(header).not.toHaveBeenCalled();
    expect(statusLine.start).not.toHaveBeenCalled();
  });

  it.each(entrypoints)('$kind は pool の完了までプロジェクトの所有権を保持する', async ({ execute }) => {
    let finish!: (result: { success: number; fail: number; executedTaskNames: string[] }) => void;
    mocks.claim.mockReturnValue([]);
    mocks.pool.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const execution = execute('/project');
    try {
      await vi.waitFor(() => expect(mocks.pool).toHaveBeenCalledOnce());
      expect(mocks.release).not.toHaveBeenCalled();
    } finally { finish({ success: 0, fail: 0, executedTaskNames: [] }); await execution; }
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(entrypoints)('$kind はmanagerのゴール一覧を回収せず通常タスクの実行へ進む', async ({ execute }) => {
    const failure = new Error('invalid goal directory');
    const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(failure);
    if (execute === runAllTasks) {
      await useActualWorkerPool();
      mocks.claim.mockReturnValueOnce([task]).mockReturnValue([]);
    }

    await expect(execute('/project')).resolves.toBeUndefined();

    expect(list).not.toHaveBeenCalled();
    expect(mocks.pool).toHaveBeenCalledOnce();
    const [runner, initialTasks] = mocks.pool.mock.calls[0]!;
    expect(runner).toBeInstanceOf((await import('../infra/task/index.js')).TaskRunner);
    expect(initialTasks).toEqual([]);
    if (execute === runAllTasks) {
      expect(mocks.claim).toHaveBeenCalled();
      expect(mocks.executeTask).toHaveBeenCalledExactlyOnceWith(task, runner, '/project', undefined,
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }), undefined);
    }
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('自動 run は空キューで正常終了しても再起動しない', async () => {
    mocks.claim.mockReturnValue([]);
    mocks.pool.mockResolvedValue({ success: 0, fail: 0, executedTaskNames: [] });
    mocks.ensure.mockImplementation(async () => expect(mocks.release).toHaveBeenCalledOnce());
    await expect(runAllTasks('/project', { goalTasksOnly: true })).resolves.toBeUndefined();
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(mocks.pool.mock.calls[0]![1]).toEqual([]);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it.each(['initial processing', 'claim'] as const)('自動 run は取得前の $0 の失敗では再起動を判定しない', async (boundary) => {
    const failure = new Error('before claim');
    if (boundary === 'initial processing') mocks.failInterrupted.mockImplementation(() => { throw failure; });
    else {
      await useActualWorkerPool();
      mocks.claim.mockImplementation(() => { throw failure; });
    }
    const run = runAllTasks('/project', { goalTasksOnly: true });
    await expect(run).rejects.toBe(failure);
    if (boundary === 'claim') {
      expect(mocks.pool).toHaveBeenCalledOnce();
      expect(mocks.claim).toHaveBeenCalledOnce();
    } else expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it('an automatic run scopes the shared runner to goals and skips ordinary task retries', async () => {
    await runAllTasks('/project', { goalTasksOnly: true });
    expect(mocks.runner).toHaveBeenCalledWith('/project', expect.objectContaining({ goalTasksOnly: true }));
    expect(mocks.requeue).not.toHaveBeenCalled();
    expect(mocks.pool.mock.calls[0]![0]).toBeInstanceOf((await import('../infra/task/index.js')).TaskRunner);
    expect(mocks.pool.mock.calls[0]![9]).toBe(true);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it('run はpoolの取得通知後に一度だけ表示を開始する', async () => {
    mocks.pool.mockImplementationOnce(async (...args: Parameters<typeof import('../features/tasks/execute/parallelExecution.js').runWithWorkerPool>) => {
      expect(args[1]).toEqual([]);
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(header).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalledWith('Concurrency: 2');
      expect(statusLine.start).not.toHaveBeenCalled();
      args[8]!.onTasksClaimed!();
      args[8]!.onTasksClaimed!();
      expect(vi.mocked(header).mock.calls.filter(([value]) => value === 'Running tasks')).toHaveLength(1);
      expect(vi.mocked(info).mock.calls.filter(([value]) => value === 'Concurrency: 2')).toHaveLength(1);
      expect(statusLine.start).toHaveBeenCalledExactlyOnceWith('Running tasks...');
      return { success: 1, fail: 0, executedTaskNames: ['first'] };
    });

    await runAllTasks('/project');

    expect(info).not.toHaveBeenCalledWith('No pending tasks in .takt/tasks.yaml');
    expect(statusLine.stop).toHaveBeenCalledOnce();
  });

  it('run はENOSPCの回復待ちから実行完了まで同じ所有権を保ち取得後に表示する', async () => {
    vi.useFakeTimers();
    await useActualWorkerPool();
    mocks.states.mockReturnValue([{ name: task.name, status: 'pending' }]);
    mocks.claim.mockImplementationOnce(() => {
      throw new PrivateFileLockAcquisitionError('disk full', 'ENOSPC', undefined, {});
    }).mockReturnValueOnce([task]).mockReturnValue([]);
    let finish!: (success: boolean) => void;
    mocks.executeTask.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const running = runAllTasks('/project');

    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(header).not.toHaveBeenCalled();
    expect(statusLine.start).not.toHaveBeenCalled();
    expect(mocks.executeTask).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.executeTask).toHaveBeenCalledOnce();
    expect(header).toHaveBeenCalledWith('Running tasks');
    expect(statusLine.start).toHaveBeenCalledExactlyOnceWith('Running tasks...');
    expect(mocks.release).not.toHaveBeenCalled();
    finish(true);
    await running;
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('run は取得通知があっても最終件数がゼロなら空キューを案内する', async () => {
    mocks.pool.mockImplementationOnce(async (...args: Parameters<typeof import('../features/tasks/execute/parallelExecution.js').runWithWorkerPool>) => {
      args[8]!.onTasksClaimed!();
      return { success: 0, fail: 0, executedTaskNames: [] };
    });

    await runAllTasks('/project');

    expect(info).toHaveBeenCalledWith('No pending tasks in .takt/tasks.yaml');
    expect(info).toHaveBeenCalledWith('Use takt add to append tasks.');
  });

  it('自動起動した run は生きている所有者がいれば設定もキューも読み込まずに終了する', async () => {
    mocks.acquire.mockImplementation(() => {
      throw new ProjectExecutionAlreadyRunningError({
        ownerId: 'existing-owner', pid: 4101, processIdentity: { startTime: 'process-start' },
        kind: 'run', state: 'running',
      });
    });
    await expect(runAllTasks('/project', { goalTasksOnly: true })).resolves.toBeUndefined();
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.failInterrupted).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each(entrypoints)('手動の $kind は競合エラーを実行元へ返す', async ({ execute }) => {
    const conflict = new ProjectExecutionAlreadyRunningError({
      ownerId: 'existing-owner', pid: 4101, processIdentity: { startTime: 'process-start' },
      kind: 'watch', state: 'running',
    });
    mocks.acquire.mockImplementation(() => { throw conflict; });
    await expect(execute('/project')).rejects.toBe(conflict);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('run は通常タスクの読み取りエラーを実行元へ返す', async () => {
    const failure = new Error('unreadable ordinary task');
    await useActualWorkerPool();
    mocks.claim.mockImplementation(() => { throw failure; });
    await expect(runAllTasks('/project')).rejects.toBe(failure);
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('run の初期処理中の SIGINT は再投入へ停止信号を渡し、最初の取得を止める', async () => {
    mocks.pool.mockResolvedValue({ success: 0, fail: 0, executedTaskNames: [] });
    mocks.failInterrupted.mockImplementation(() => {
      const handler = process.rawListeners('SIGINT').find((listener) => !listeners.includes(listener));
      handler!.call(process, 'SIGINT');
      return 0;
    });
    await runAllTasks('/project');
    expect(mocks.requeue.mock.calls[0]?.[2]).toMatchObject({ aborted: true });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(mocks.pool.mock.calls[0]![1]).toEqual([]);
    expect(mocks.pool.mock.calls[0]![8]).toMatchObject({
      schedulingSignal: { aborted: true }, taskAbortSignal: { aborted: true },
    });
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

  it.each(entrypoints)('$kind は設定エラー時にキューを変更せず取得済みロックを残さない', async ({ kind, execute }) => {
    const failure = new Error('invalid config');
    mocks.config.mockImplementation(() => { throw failure; });
    await expect(execute('/project')).rejects.toBe(failure);
    if (kind === 'run') {
      expect(mocks.acquire).toHaveBeenCalledWith('/project', 'run');
      expect(mocks.release).toHaveBeenCalled();
    } else {
      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
    }
    expect(mocks.failInterrupted).not.toHaveBeenCalled();
  });
});
