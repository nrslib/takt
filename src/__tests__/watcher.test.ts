import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import chalk from 'chalk';
import type { TaskInfo } from '../infra/task/types.js';
import type { TaskExecutionParallelOptions } from '../features/tasks/execute/types.js';
import type { RunAllTasksOptions } from '../features/tasks/execute/types.js';
import type { executeRunTaskAndComplete as ExecuteRunTask } from '../features/tasks/execute/runTaskExecution.js';

const { executeRunTaskAndComplete } = vi.hoisted(() => ({
  executeRunTaskAndComplete: vi.fn<typeof ExecuteRunTask>(),
}));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({ executeRunTaskAndComplete }));
import { TaskRunner } from '../infra/task/runner.js';
import { watchTasks } from '../features/tasks/watch/index.js';
import { runAllTasks } from '../features/tasks/execute/runAllTasks.js';
import { attemptAutoRequeueTask, requeueExistingFailedTasks } from '../features/tasks/execute/parallelExecution.js';
import { enterInputWait, leaveInputWait } from '../features/tasks/execute/inputWait.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';

const taskNames = [
  { name: 'alpha', displayName: 'alpha' },
  { name: '\x1b[2Jalpha\r\nforged\x07\x9b0m', displayName: 'alpha\\r\\nforged\\x07\\x9b0m' },
];

interface Execution {
  task: TaskInfo;
  parallel: TaskExecutionParallelOptions | undefined;
  options: Parameters<typeof ExecuteRunTask>[3];
  runContext: Parameters<typeof ExecuteRunTask>[5];
  finish: (success: boolean) => void;
  settled: boolean;
}

describe('watch の共有 worker pool と tasks.yaml', () => {
  let projectDir: string;
  let runner: TaskRunner;
  let executions: Execution[];
  let watchPromise: Promise<void> | undefined;
  let watchSettled: boolean;
  let savedListeners: ReturnType<typeof process.rawListeners>;
  let inputWaitCount: number;
  let interrupted: boolean;
  let completionOrder: string[];

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), stringifyYaml(config));
  }

  function records() {
    return (parseYaml(readFileSync(runner.getTasksFilePath(), 'utf-8')) as {
      tasks: Array<{ name: string; status: string; auto_requeue_count?: number }>;
    }).tasks;
  }

  function state(name: string) {
    return records().find((task) => task.name === name);
  }

  function writeSavedTask(name: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(runner.getTasksFilePath(), stringifyYaml({ tasks: [{
      name, content: 'saved task', workflow: 'default', status: 'failed',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      auto_requeue_count: 0,
      failure: { step: 'implement', error: 'retryable failure', retryable: true },
      ...overrides,
    }] }));
  }

  function interrupt(): void {
    if (interrupted) return;
    interrupted = true;
    for (const listener of process.rawListeners('SIGINT')) {
      if (!savedListeners.includes(listener)) listener.call(process, 'SIGINT');
    }
  }

  function startWatch(options?: RunAllTasksOptions): void {
    watchPromise = watchTasks(projectDir, options);
    void watchPromise.then(() => {
      watchSettled = true;
      completionOrder.push('watch stopped');
    }, () => { watchSettled = true; });
  }

  function waitForInput(): void {
    enterInputWait();
    inputWaitCount++;
  }

  function resumeInput(): void {
    leaveInputWait();
    inputWaitCount--;
  }

  function addFailedTask(content: string): TaskInfo {
    const added = runner.addTask(content);
    const task = runner.claimNextTasks(1)[0]!;
    runner.failTask({
      task, success: false, response: 'retryable failure', failureStep: 'implement',
      executionLog: [], startedAt: task.createdAt, completedAt: task.createdAt,
    });
    return added;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mkdirSync(join(process.cwd(), '.takt'), { recursive: true });
    projectDir = mkdtempSync(join(process.cwd(), '.takt', 'watch-test-'));
    mkdirSync(join(projectDir, '.takt'));
    writeConfig({ concurrency: 1, task_poll_interval_ms: 500, auto_requeue_max_attempts: 0 });
    invalidateGlobalConfigCache();
    runner = new TaskRunner(projectDir);
    runner.ensureDirs();
    executions = [];
    watchPromise = undefined;
    watchSettled = false;
    inputWaitCount = 0;
    interrupted = false;
    completionOrder = [];
    savedListeners = process.rawListeners('SIGINT');
    executeRunTaskAndComplete.mockReset().mockImplementation((task, taskRunner, _cwd, options, parallel, runContext) => {
      return new Promise<boolean>((resolve) => {
        const signal = parallel?.abortSignal;
        const onAbort = () => execution.finish(false);
        const execution: Execution = {
          task, parallel, options, runContext, settled: false,
          finish: (success) => {
            if (execution.settled) return;
            execution.settled = true;
            signal?.removeEventListener('abort', onAbort);
            const result = {
              task, success, response: success ? 'done' : 'retryable failure', failureStep: 'implement',
              executionLog: [], startedAt: task.createdAt, completedAt: task.createdAt,
            };
            if (success) taskRunner.completeTask(result);
            else taskRunner.failTask(result);
            completionOrder.push(task.name);
            resolve(success);
          },
        };
        executions.push(execution);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it.each(taskNames)('watch 起動時に保存名 $displayName を安全に表示し、原名で再投入・完了する', async ({ name, displayName }) => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeSavedTask(name);

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual([name]);
    expect(state(name)).toMatchObject({ name, status: 'running', auto_requeue_count: 1 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(name)).toMatchObject({ name, status: 'completed', auto_requeue_count: 1 });
  });

  it.each(taskNames)('run 起動時も保存名 $displayName を原値で再投入し、安全に表示する', async ({ name, displayName }) => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), stringifyYaml({ notification_sound: false }));
    writeSavedTask(name);
    const run = runAllTasks(projectDir);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(executions.map(({ task }) => task.name)).toEqual([name]);
      expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
    } finally {
      for (const execution of executions) execution.finish(true);
      await run;
    }
    expect(state(name)).toMatchObject({ name, status: 'completed', auto_requeue_count: 1 });
  });

  it.each(taskNames)('watch の実行失敗後も保存名 $displayName を原値で再投入し、安全に表示する', async ({ name, displayName }) => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    writeSavedTask(name, { status: 'pending', started_at: null, completed_at: null, failure: undefined });
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    executions[0]!.finish(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual([name, name]);
    expect(state(name)).toMatchObject({ name, status: 'running', auto_requeue_count: 1 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" auto-requeued (1/1)`));
    executions[1]!.finish(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(name)).toMatchObject({ name, status: 'failed', auto_requeue_count: 1 });
    expect(console.log).toHaveBeenCalledWith(chalk.blue(`[INFO] Task "${displayName}" was not auto-requeued: max attempts reached (1/1)`));
  });

  it.each([
    { reason: 'task_not_failed', status: 'pending', overrides: { status: 'pending', started_at: null, completed_at: null, failure: undefined } },
    { reason: 'max_attempts_reached', status: 'failed', overrides: { auto_requeue_count: 1 } },
    { reason: 'failure_not_retryable', status: 'failed', overrides: { failure: { step: 'implement', error: 'retryable failure', retryable: false } } },
    { reason: 'missing_failed_step', status: 'failed', overrides: { failure: { step: ' ', error: 'retryable failure', retryable: true } } },
    { reason: 'missing_failure_detail', status: 'failed', overrides: { failure: { step: 'implement', error: ' ', retryable: true } } },
  ])('保存YAMLの $reason 判定・状態・回数を維持し、安全なスキップログを出す', ({ reason, status, overrides }) => {
    const { name, displayName } = taskNames[1]!;
    writeSavedTask(name, overrides);
    const before = records();
    const requeue = vi.spyOn(runner, 'autoRequeueFailedTask');

    expect(attemptAutoRequeueTask(runner, name, 1)).toBe(false);

    expect(requeue.mock.results[0]?.value).toMatchObject({ requeued: false, reason });
    expect(records()).toEqual(before);
    expect(state(name)?.status).toBe(status);
    const line = vi.mocked(console.log).mock.calls[0]?.[0] as string;
    expect(line).toContain(displayName);
    expect(line).not.toContain('\x1b[2J');
    for (const control of ['\r', '\n', '\x07', '\x9b']) expect(line).not.toContain(control);
  });

  it.each([undefined, 0])('再投入上限=%s では保存状態を変えずログを出さない', (maxAttempts) => {
    writeSavedTask(taskNames[1]!.name);
    const before = records();
    expect(requeueExistingFailedTasks(runner, maxAttempts)).toBe(0);
    expect(records()).toEqual(before);
    expect(console.log).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    interrupt();
    for (const execution of executions) execution.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;
    while (inputWaitCount > 0) resumeInput();
    vi.restoreAllMocks();
    vi.useRealTimers();
    invalidateGlobalConfigCache();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([1, 3])('concurrency=%s に達して実行し、空きができるまで上限を超えない', async (concurrency) => {
    writeConfig({ concurrency, task_poll_interval_ms: 500 });
    const tasks = Array.from({ length: 4 }, (_, index) => runner.addTask(`task ${index}`));

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(executions.map(({ task }) => task.name)).toEqual(tasks.slice(0, concurrency).map(({ name }) => name));
    expect(records().filter(({ status }) => status === 'running')).toHaveLength(concurrency);
    await vi.advanceTimersByTimeAsync(500);
    expect(executions).toHaveLength(concurrency);
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(concurrency + 1);
    expect(executions.filter(({ settled }) => !settled)).toHaveLength(concurrency);
    expect(state(tasks[0]!.name)?.status).toBe('completed');
  });

  it.each([
    { configuredInterval: undefined, interval: 500 },
    { configuredInterval: 900, interval: 900 },
  ])('同じ watch が空→追加→消化→再追加を poll=$interval ms で処理する', async ({ configuredInterval, interval }) => {
    writeConfig(configuredInterval === undefined ? {} : { task_poll_interval_ms: configuredInterval });
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSettled).toBe(false);
    const initialClaims = claim.mock.calls.length;
    const first = runner.addTask('first arrival');

    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(claim).toHaveBeenCalledTimes(initialClaims);
    expect(state(first.name)?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(executions.map(({ task }) => task.name)).toEqual([first.name]);
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(first.name)?.status).toBe('completed');
    expect(watchSettled).toBe(false);

    const second = runner.addTask('second arrival');
    await vi.advanceTimersByTimeAsync(interval);
    expect(executions.map(({ task }) => task.name)).toEqual([first.name, second.name]);
    executions[1]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(second.name)?.status).toBe('completed');
    expect(watchSettled).toBe(false);
  });

  it('長時間タスクが実行中でも後着タスクを空きスロットへ割り当てる', async () => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500 });
    const first = runner.addTask('long task');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    const later = runner.addTask('later task');

    await vi.advanceTimersByTimeAsync(500);

    expect(executions.map(({ task }) => task.name)).toEqual([first.name, later.name]);
    expect(executions[0]!.settled).toBe(false);
    expect(state(first.name)?.status).toBe('running');
    expect(state(later.name)?.status).toBe('running');
  });

  it.each([
    { firstSuccess: true, firstStatus: 'completed' },
    { firstSuccess: false, firstStatus: 'failed' },
  ])('SIGINT 後は2件を中断せず、自然な結果 $firstStatus の保存後も残りの完了を待つ', async ({ firstSuccess, firstStatus }) => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500, auto_requeue_max_attempts: 1 });
    const tasks = Array.from({ length: 3 }, (_, index) => runner.addTask(`interrupt ${index}`));
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');
    const listenersBefore = process.rawListeners('SIGINT');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(2);
    expect(tasks.slice(0, 2).map(({ name }) => state(name)?.status)).toEqual(['running', 'running']);
    const signals = executions.map(({ parallel }) => parallel?.abortSignal);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    interrupt();
    const claimCount = claim.mock.calls.length;

    await vi.advanceTimersByTimeAsync(500);
    expect(watchSettled).toBe(false);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(executions.every(({ settled }) => !settled)).toBe(true);
    expect(tasks.slice(0, 2).map(({ name }) => state(name)?.status)).toEqual(['running', 'running']);
    executions[0]!.finish(firstSuccess);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSettled).toBe(false);
    expect(state(tasks[0]!.name)?.status).toBe(firstStatus);
    expect(state(tasks[1]!.name)?.status).toBe('running');
    expect(completionOrder).toEqual([tasks[0]!.name]);
    executions[1]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;

    expect(watchSettled).toBe(true);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(tasks.slice(0, 2).map(({ name }) => state(name)?.status)).toEqual([firstStatus, 'completed']);
    expect(completionOrder).toEqual([tasks[0]!.name, tasks[1]!.name, 'watch stopped']);
    expect(executions).toHaveLength(2);
    expect(claim).toHaveBeenCalledTimes(claimCount);
    expect(requeue).not.toHaveBeenCalled();
    expect(state(tasks[2]!.name)?.status).toBe('pending');
    expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('アイドル中の SIGINT は次の poll を待たずに watch を終了する', async () => {
    writeConfig({ task_poll_interval_ms: 5000 });
    const listenersBefore = process.rawListeners('SIGINT');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSettled).toBe(false);

    interrupt();
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;

    expect(watchSettled).toBe(true);
    expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('起動時 failed を一度だけ再投入し、常駐中に現れた failed は再投入しない', async () => {
    writeConfig({ auto_requeue_max_attempts: 1, task_poll_interval_ms: 500 });
    const failed = addFailedTask('failed before startup');
    const listFailed = vi.spyOn(TaskRunner.prototype, 'listFailedTasks');
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions.map(({ task }) => task.name)).toEqual([failed.name]);
    executions[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(failed.name)).toMatchObject({ status: 'completed', auto_requeue_count: 1 });
    const laterFailed = addFailedTask('failed after startup');

    await vi.advanceTimersByTimeAsync(1500);

    expect(listFailed).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(state(laterFailed.name)?.status).toBe('failed');
    expect(executions).toHaveLength(1);
    expect(watchSettled).toBe(false);
  });

  it('failed 一覧の取得中に SIGINT を受けた場合は起動時再投入しない', async () => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    const failed = addFailedTask('interrupt before requeue');
    const listFailed = TaskRunner.prototype.listFailedTasks;
    const listing = vi.spyOn(TaskRunner.prototype, 'listFailedTasks').mockImplementation(function (this: TaskRunner) {
      const tasks = listFailed.call(this);
      interrupt();
      return tasks;
    });
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask');

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(listing).toHaveBeenCalledTimes(1);
    expect(requeue).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
    expect(state(failed.name)?.status).toBe('failed');
    expect(watchSettled).toBe(true);
  });

  it('起動時再投入の途中で SIGINT を受けた場合は残りを再投入しない', async () => {
    writeConfig({ auto_requeue_max_attempts: 1 });
    const first = addFailedTask('first startup failure');
    const second = addFailedTask('second startup failure');
    const autoRequeue = TaskRunner.prototype.autoRequeueFailedTask;
    const requeue = vi.spyOn(TaskRunner.prototype, 'autoRequeueFailedTask').mockImplementation(function (this: TaskRunner, name, options) {
      const result = autoRequeue.call(this, name, options);
      interrupt();
      return result;
    });

    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(requeue).toHaveBeenCalledTimes(1);
    expect(state(first.name)).toMatchObject({ status: 'pending', auto_requeue_count: 1 });
    expect(state(second.name)?.status).toBe('failed');
    expect(executions).toEqual([]);
    expect(watchSettled).toBe(true);
  });

  it.each([0, 1])('実行中失敗は再投入上限=%s を保存し、上限到達後も常駐する', async (maxAttempts) => {
    writeConfig({ auto_requeue_max_attempts: maxAttempts, task_poll_interval_ms: 500 });
    const task = runner.addTask('runtime failure');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(1);
    executions[0]!.finish(false);
    await vi.advanceTimersByTimeAsync(0);
    if (maxAttempts > 0) {
      expect(executions).toHaveLength(2);
      expect(state(task.name)).toMatchObject({ status: 'running', auto_requeue_count: 1 });
      executions[1]!.finish(false);
      await vi.advanceTimersByTimeAsync(0);
    }

    await vi.advanceTimersByTimeAsync(1500);

    expect(executions).toHaveLength(maxAttempts + 1);
    expect(state(task.name)?.status).toBe('failed');
    expect(state(task.name)?.auto_requeue_count ?? 0).toBe(maxAttempts);
    expect(watchSettled).toBe(false);
  });

  it('初回の入力待ち中は claim せず、同じ watch で解除後に実行する', async () => {
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    waitForInput();
    const task = runner.addTask('initial input wait');
    startWatch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).not.toHaveBeenCalled();
    expect(state(task.name)?.status).toBe('pending');
    expect(executions).toEqual([]);

    resumeInput();
    await vi.advanceTimersByTimeAsync(500);

    expect(executions.map(({ task }) => task.name)).toEqual([task.name]);
    expect(state(task.name)?.status).toBe('running');
  });

  it('入力待ち開始→pending 追加→解除を同じ watch で観測し、claim を再開する', async () => {
    writeConfig({ concurrency: 2, task_poll_interval_ms: 500 });
    runner.addTask('active input wait');
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(executions).toHaveLength(1);
    waitForInput();
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    const later = runner.addTask('queued during input wait');

    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).not.toHaveBeenCalled();
    expect(state(later.name)?.status).toBe('pending');
    expect(executions).toHaveLength(1);
    resumeInput();
    await vi.advanceTimersByTimeAsync(500);

    expect(executions).toHaveLength(2);
    expect(executions[1]!.task.name).toBe(later.name);
    expect(executions[0]!.settled).toBe(false);
  });

  it.each([1, 3])('concurrency=%s で開始表示と下流の prefix・color 引数を run と揃える', async (concurrency) => {
    writeConfig({ concurrency });
    const task = runner.addTask('prefixed task', { issue: 42 });
    const write = vi.mocked(process.stdout.write);
    startWatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(executions).toHaveLength(1);
    const parallel = executions[0]!.parallel;
    if (concurrency > 1) {
      expect(parallel).toMatchObject({ taskPrefix: '#42', taskDisplayLabel: '#42', taskColorIndex: expect.any(Number) });
      const startLines = write.mock.calls.map(([chunk]) => String(chunk))
        .filter((line) => line.includes(task.name));
      expect(startLines).toHaveLength(1);
      expect(startLines[0]).toContain('[#42]');
    } else {
      expect(parallel?.taskPrefix).toBeUndefined();
      expect(parallel?.taskColorIndex).toBeUndefined();
      expect(parallel?.taskDisplayLabel).toBeUndefined();
    }
  });

  it.each([
    { configIgnoreExceed: true, cliIgnoreExceed: undefined, expected: true },
    { configIgnoreExceed: false, cliIgnoreExceed: true, expected: true },
    { configIgnoreExceed: false, cliIgnoreExceed: undefined, expected: undefined },
  ])('config=$configIgnoreExceed CLI=$cliIgnoreExceed の実行設定と agentOverrides がタスク実行まで届く', async ({ configIgnoreExceed, cliIgnoreExceed, expected }) => {
    writeConfig({ ignore_exceed: configIgnoreExceed });
    const overrides = {
      provider: 'codex', providerSource: 'cli', model: 'gpt-5', modelSource: 'cli', autoStrategy: 'balanced',
    } as const;
    runner.addTask('execution options');

    startWatch({ ...overrides, ...(cliIgnoreExceed === undefined ? {} : { ignoreExceed: cliIgnoreExceed }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(executions).toHaveLength(1);
    expect(executions[0]!.options).toEqual(overrides);
    expect(executions[0]!.runContext?.ignoreIterationLimit).toBe(expected);
  });
});
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed' })),
}));
