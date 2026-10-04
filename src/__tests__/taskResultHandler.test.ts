import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import chalk from 'chalk';
import {
  buildTaskResult,
  persistExceededTaskResult,
  persistPrFailedTaskResult,
  persistTaskError,
  persistTaskResult,
} from '../features/tasks/execute/taskResultHandler.js';
import { TaskRunner } from '../infra/task/runner.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';

const taskNames = [
  { name: 'alpha', displayName: 'alpha' },
  { name: '\x1b[2Jalpha\r\nforged\x07\x9b0m', displayName: 'alpha\\r\\nforged\\x07\\x9b0m' },
];

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

describe('persistExceededTaskResult', () => {
  let testDir: string;
  let runner: TaskRunner;

  function claimSavedTask(name: string) {
    runner.ensureDirs();
    writeFileSync(runner.getTasksFilePath(), stringifyYaml({ tasks: [{
      name, content: 'saved task', status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z', started_at: null, completed_at: null,
    }] }));
    return runner.claimNextTasks(1)[0]!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = join(tmpdir(), `takt-result-handler-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    runner = new TaskRunner(testDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (existsSync(testDir)) {
      // Let worker IPC responses run between synchronous persistence tests.
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should record exceeded metadata and log the current step with canonical wording', () => {
    runner.addTask('Implement feature');
    const [task] = runner.claimNextTasks(1);
    if (!task) {
      throw new Error('expected claimed task');
    }

    persistExceededTaskResult(runner, task, {
      currentStep: 'reviewers',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const { tasks } = loadTasksFile(testDir);
    const row = tasks[0]!;
    expect(row.status).toBe('exceeded');
    expect(row.start_step).toBe('reviewers');
    expect(row.exceeded_max_steps).toBe(60);
    expect(row.exceeded_current_iteration).toBe(30);
    expect(console.log).toHaveBeenCalledWith(
      chalk.blue(`[INFO] Task "${task.name}" exceeded iteration limit at step "reviewers"`),
    );
  });

  it.each(taskNames.flatMap((task) => (['completed', 'failed', 'pr_failed', 'exceeded'] as const)
    .flatMap((status) => [true, false].map((emitStatusLog) => ({ ...task, status, emitStatusLog }))))) (
    '$status のログを安全に表示し、保存名とログ抑止を維持する: $displayName / emit=$emitStatusLog',
    ({ name, displayName, status, emitStatusLog }) => {
      const task = claimSavedTask(name);
      const result = buildTaskResult({
        task,
        runResult: { success: status !== 'failed', reason: status === 'failed' ? 'retryable failure' : undefined },
        startedAt: task.createdAt,
        completedAt: '2026-01-01T00:00:01.000Z',
      });
      const options = { emitStatusLog };
      let expectedLog: string;
      switch (status) {
        case 'completed':
          persistTaskResult(runner, result, options);
          expectedLog = chalk.green(`Task "${displayName}" completed`);
          break;
        case 'failed':
          persistTaskResult(runner, result, options);
          expectedLog = chalk.red(`[ERROR] Task "${displayName}" failed`);
          break;
        case 'pr_failed':
          persistPrFailedTaskResult(runner, result, 'PR failed', options);
          expectedLog = chalk.blue(`[INFO] Task "${displayName}" completed (PR creation failed)`);
          break;
        case 'exceeded':
          persistExceededTaskResult(runner, task, {
            currentStep: 'implement', newMaxSteps: 60, currentIteration: 30,
          }, undefined, options);
          expectedLog = chalk.blue(`[INFO] Task "${displayName}" exceeded iteration limit at step "implement"`);
          break;
      }
      const row = loadTasksFile(testDir).tasks[0]!;
      expect(row).toMatchObject({ name, status });
      if (status === 'failed') expect(row.failure).toMatchObject({ error: 'retryable failure' });
      if (status === 'pr_failed') expect(row.failure).toMatchObject({ error: 'PR creation failed: PR failed' });
      if (status === 'exceeded') expect(row).toMatchObject({ start_step: 'implement', exceeded_max_steps: 60, exceeded_current_iteration: 30 });
      expect(result.task.name).toBe(name);
      if (emitStatusLog) expect(console.log).toHaveBeenCalledExactlyOnceWith(expectedLog);
      else expect(console.log).not.toHaveBeenCalled();
    },
  );

  it.each(taskNames.flatMap((task) => [true, false].map((emitStatusLog) => ({ ...task, emitStatusLog }))))(
    '名前入り例外の表示だけを変換し、保存responseを保持する: $displayName / emit=$emitStatusLog',
    async ({ name, displayName, emitStatusLog }) => {
      const task = claimSavedTask(name);
      const failure = await resolveTaskExecution(task, testDir).then(() => {
        throw new Error('expected workflow validation failure');
      }, (err: unknown) => err);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(name);

      persistTaskError(runner, task, task.createdAt, '2026-01-01T00:00:01.000Z', failure, {
        emitStatusLog, responsePrefix: 'Execution failed: ',
      });

      expect(loadTasksFile(testDir).tasks[0]).toMatchObject({
        name, status: 'failed', failure: { error: `Execution failed: ${message}` },
      });
      if (emitStatusLog) {
        const renderedMessage = message.replace(name, displayName);
        expect(console.log).toHaveBeenCalledExactlyOnceWith(chalk.red(`[ERROR] Task "${displayName}" error: ${renderedMessage}`));
      } else {
        expect(console.log).not.toHaveBeenCalled();
      }
    },
  );

  it('silent の実行例外は原名・例外を保存し、端末ログを抑止する', async () => {
    const task = claimSavedTask(taskNames[1]!.name);
    const executor = vi.fn();

    const result = await executeTaskAndCompleteWithDetails(task, runner, testDir, executor, undefined, { outputMode: 'silent' });

    expect(result.success).toBe(false);
    expect(executor).not.toHaveBeenCalled();
    expect(loadTasksFile(testDir).tasks[0]).toMatchObject({
      name: task.name, status: 'failed', failure: { error: result.failureReason },
    });
    expect(result.failureReason).toContain(task.name);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('should persist sanitized workflow failure details in the task record', () => {
    runner.addTask('Review findings');
    const [task] = runner.claimNextTasks(1);
    if (!task) {
      throw new Error('expected claimed task');
    }
    const taskResult = buildTaskResult({
      task,
      runResult: {
        success: false,
        reason: 'REVIEW_FAILED: report validation failed',
        lastStep: 'reviewers',
        lastMessage: 'Provider failed with api_key=task-result-secret',
      },
      startedAt: '2026-08-02T15:26:00.000Z',
      completedAt: '2026-08-02T15:26:51.000Z',
    });

    persistTaskResult(runner, taskResult);

    const { tasks } = loadTasksFile(testDir);
    expect(tasks[0]).toMatchObject({
      status: 'failed',
      failure: {
        step: 'reviewers',
        error: 'REVIEW_FAILED: report validation failed',
        last_message: 'Provider failed with api_key=[REDACTED]',
      },
    });
    expect(readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8')).not.toContain(
      'task-result-secret',
    );
  });

  it('Issue #562: persists worktree_path on first exceed when context provides worktreePath (requeue reuse)', () => {
    runner.addTask('Implement feature');
    const [task] = runner.claimNextTasks(1);
    if (!task) {
      throw new Error('expected claimed task');
    }

    persistExceededTaskResult(
      runner,
      task,
      {
        currentStep: 'implement',
        newMaxSteps: 60,
        currentIteration: 30,
      },
      { worktreePath: '/clone/path', branch: 'takt/feature' },
    );

    const { tasks } = loadTasksFile(testDir);
    const row = tasks[0]!;
    expect(row.worktree_path).toBe('/clone/path');
    expect(row.branch).toBe('takt/feature');
  });

  it('should forward only worktreePath when branch is omitted from context', () => {
    runner.addTask('Implement feature');
    const [task] = runner.claimNextTasks(1);
    if (!task) {
      throw new Error('expected claimed task');
    }

    persistExceededTaskResult(
      runner,
      task,
      {
        currentStep: 'plan',
        newMaxSteps: 40,
        currentIteration: 5,
      },
      { worktreePath: '/wt-only' },
    );

    const { tasks } = loadTasksFile(testDir);
    const row = tasks[0]!;
    expect(row.worktree_path).toBe('/wt-only');
    expect(row.branch).toBeUndefined();
  });

  it('should forward only branch when worktreePath is omitted from context', () => {
    runner.addTask('Implement feature');
    const [task] = runner.claimNextTasks(1);
    if (!task) {
      throw new Error('expected claimed task');
    }

    persistExceededTaskResult(
      runner,
      task,
      {
        currentStep: 'fix',
        newMaxSteps: 50,
        currentIteration: 12,
      },
      { branch: 'takt/branch-only' },
    );

    const { tasks } = loadTasksFile(testDir);
    const row = tasks[0]!;
    expect(row.branch).toBe('takt/branch-only');
    expect(row.worktree_path).toBeUndefined();
  });
});
