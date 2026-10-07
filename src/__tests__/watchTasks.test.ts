import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { runWithWorkerPool as RunWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';

const mocks = vi.hoisted(() => ({
  failInterruptedRunningTasks: vi.fn(),
  getTasksFilePath: vi.fn(() => '/project/.takt/tasks.yaml'),
  claimNextTasks: vi.fn(() => []),
  runWithWorkerPool: vi.fn<typeof RunWithWorkerPool>(),
  resolveWorkflowConfigValues: vi.fn(),
  header: vi.fn(),
  status: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  sendSlackNotification: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn().mockImplementation(() => ({
    failInterruptedRunningTasks: mocks.failInterruptedRunningTasks,
    getTasksFilePath: mocks.getTasksFilePath,
    claimNextTasks: mocks.claimNextTasks,
  })),
}));

vi.mock('../features/tasks/execute/parallelExecution.js', () => ({
  runWithWorkerPool: mocks.runWithWorkerPool,
}));
vi.mock('../features/tasks/execute/forceShutdown.js', () => ({
  forceExitAfterOpenCodeCleanup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../infra/task/manager-run-state.js', () => ({ readManagerRunState: () => ({ requested: false }), withProjectRunCoordination: (_cwd: string, action: () => unknown) => action() }));
vi.mock('../infra/task/project-execution-lock.js', () => ({
  acquireProjectExecutionLock: vi.fn(() => ({
    owner: { ownerId: 'watch-test-owner', pid: process.pid, kind: 'watch', state: 'starting',
      processIdentity: { startTime: 'test-process-start' } },
    updateState: vi.fn(), release: vi.fn(),
  })),
}));
vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValues: mocks.resolveWorkflowConfigValues,
}));
vi.mock('../shared/ui/index.js', () => ({
  header: mocks.header, status: mocks.status,
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), blankLine: vi.fn(),
}));
vi.mock('../shared/utils/index.js', () => ({
  notifySuccess: mocks.notifySuccess,
  notifyError: mocks.notifyError,
  sendSlackNotification: mocks.sendSlackNotification,
}));

import { watchTasks } from '../features/tasks/watch/index.js';

describe('watchTasks', () => {
  async function finishWatch(taskSuccess: boolean): Promise<void> {
    mocks.runWithWorkerPool.mockResolvedValue({
      success: taskSuccess ? 1 : 0, fail: taskSuccess ? 0 : 1, executedTaskNames: ['task-1'],
    });
    await watchTasks('/project');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failInterruptedRunningTasks.mockReturnValue(0);
    mocks.runWithWorkerPool.mockResolvedValue({ success: 1, fail: 0, executedTaskNames: ['task-1'] });
    mocks.resolveWorkflowConfigValues.mockReset().mockReturnValue({
      concurrency: 3, taskPollIntervalMs: 900, autoRequeueMaxAttempts: 2, ignoreExceed: false,
    });
  });

  it('空の初期キューでも解決済みの設定を run と共有する worker pool へ渡す', async () => {
    await watchTasks('/project');

    expect(mocks.runWithWorkerPool).toHaveBeenCalledTimes(1);
    const args = mocks.runWithWorkerPool.mock.calls[0]!;
    expect(args[0]).toEqual(expect.objectContaining({ claimNextTasks: mocks.claimNextTasks }));
    expect(args[1]).toEqual([]);
    expect(args[2]).toBe(3);
    expect(args[3]).toBe('/project');
    expect(args[5]).toEqual(expect.objectContaining({ autoRequeueMaxAttempts: 2 }));
    expect(args[6]).toBe(900);
    expect(args[7]).toBe('watch');
  });

  it('watch開始時に中断されたrunningタスクをfailedへ倒してから pool を開始する', async () => {
    mocks.failInterruptedRunningTasks.mockReturnValue(1);

    await watchTasks('/project');

    expect(mocks.failInterruptedRunningTasks).toHaveBeenCalledTimes(1);
    expect(mocks.runWithWorkerPool).toHaveBeenCalledTimes(1);
    expect(mocks.failInterruptedRunningTasks.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runWithWorkerPool.mock.invocationCallOrder[0]!);
  });

  it('config 解決が失敗した場合は task 状態変更と pool 開始を行わない', async () => {
    const configError = new Error('Invalid config');
    mocks.resolveWorkflowConfigValues.mockImplementation(() => { throw configError; });

    await expect(watchTasks('/project')).rejects.toBe(configError);

    expect(mocks.failInterruptedRunningTasks).not.toHaveBeenCalled();
    expect(mocks.claimNextTasks).not.toHaveBeenCalled();
    expect(mocks.runWithWorkerPool).not.toHaveBeenCalled();
  });

  it.each([
    { configIgnoreExceed: true, cliIgnoreExceed: undefined, expected: true },
    { configIgnoreExceed: false, cliIgnoreExceed: true, expected: true },
    { configIgnoreExceed: false, cliIgnoreExceed: undefined, expected: undefined },
  ])('config=$configIgnoreExceed CLI=$cliIgnoreExceed の ignoreExceed を pool の実行設定へ変換する', async ({ configIgnoreExceed, cliIgnoreExceed, expected }) => {
    mocks.resolveWorkflowConfigValues.mockReturnValue({
      concurrency: 1, taskPollIntervalMs: 500, autoRequeueMaxAttempts: 0, ignoreExceed: configIgnoreExceed,
    });

    await watchTasks('/project', cliIgnoreExceed === undefined ? undefined : { ignoreExceed: cliIgnoreExceed });

    expect(mocks.runWithWorkerPool).toHaveBeenCalledTimes(1);
    expect(mocks.runWithWorkerPool.mock.calls[0]![5]?.ignoreIterationLimit).toBe(expected);
  });

  it('provider・model・source・autoStrategy を共有 pool へ渡す', async () => {
    const overrides = {
      provider: 'codex', providerSource: 'cli', model: 'gpt-5', modelSource: 'cli', autoStrategy: 'balanced',
    } as const;

    await watchTasks('/project', { ...overrides, ignoreExceed: true });

    expect(mocks.runWithWorkerPool).toHaveBeenCalledTimes(1);
    expect(mocks.runWithWorkerPool.mock.calls[0]![4]).toEqual(overrides);
  });

  it.each([true, false])('実行結果 success=%s でも watch 終了時に集計を出さない', async (taskSuccess) => {
    await finishWatch(taskSuccess);

    expect(mocks.status).not.toHaveBeenCalled();
    const summaryHeaders = mocks.header.mock.calls.map(([value]) => String(value))
      .filter((value) => /summary/i.test(value));
    expect(summaryHeaders).toEqual([]);
  });

  it.each([true, false])('実行結果 success=%s でも watch 終了時に run 通知音を呼ばない', async (taskSuccess) => {
    await finishWatch(taskSuccess);

    expect(mocks.notifySuccess).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  it.each([true, false])('実行結果 success=%s でも watch 終了時に Slack run サマリーを送信しない', async (taskSuccess) => {
    await finishWatch(taskSuccess);

    expect(mocks.sendSlackNotification).not.toHaveBeenCalled();
  });
});
