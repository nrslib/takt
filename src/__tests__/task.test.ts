import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskRecordSchema } from '../infra/task/schema.js';

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function writeTasksFile(testDir: string, tasks: Array<Record<string, unknown>>): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  writeFileSync(join(testDir, '.takt', 'tasks.yaml'), stringifyYaml({ tasks }), 'utf-8');
}

function createPendingRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return TaskRecordSchema.parse({
    name: 'task-a',
    status: 'pending',
    content: 'Do work',
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    owner_pid: null,
    ...overrides,
  }) as unknown as Record<string, unknown>;
}

describe('TaskRunner (tasks.yaml)', () => {
  const testDir = `/tmp/takt-task-test-${Date.now()}`;
  let runner: TaskRunner;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should add tasks to .takt/tasks.yaml', () => {
    const task = runner.addTask('Fix login flow', { piece: 'default' });
    expect(task.name).toContain('fix-login-flow');
    expect(existsSync(join(testDir, '.takt', 'tasks.yaml'))).toBe(true);
  });

  it('should list only pending tasks', () => {
    runner.addTask('Task A');
    runner.addTask('Task B');

    const tasks = runner.listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.status === 'pending')).toBe(true);
  });

  it('should claim tasks and mark them running', () => {
    runner.addTask('Task A');
    runner.addTask('Task B');

    const claimed = runner.claimNextTasks(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('running');

    const file = loadTasksFile(testDir);
    expect(file.tasks.some((task) => task.status === 'running')).toBe(true);
  });

  it('should recover interrupted running tasks to pending', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const current = loadTasksFile(testDir);
    const running = current.tasks[0] as Record<string, unknown>;
    running.owner_pid = 999999999;
    writeFileSync(join(testDir, '.takt', 'tasks.yaml'), stringifyYaml(current), 'utf-8');

    const recovered = runner.recoverInterruptedRunningTasks();
    expect(recovered).toBe(1);

    const tasks = runner.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('pending');
  });

  it('should keep running tasks owned by a live process', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);

    const recovered = runner.recoverInterruptedRunningTasks();
    expect(recovered).toBe(0);
  });

  it('should take over stale lock file with invalid pid', () => {
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'tasks.yaml.lock'), 'invalid-pid', 'utf-8');

    const task = runner.addTask('Task with stale lock');

    expect(task.name).toContain('task-with-stale-lock');
    expect(existsSync(join(testDir, '.takt', 'tasks.yaml.lock'))).toBe(false);
  });

  it('should timeout when lock file is held by a live process', () => {
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'tasks.yaml.lock'), String(process.pid), 'utf-8');

    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValueOnce(0);
    dateNowSpy.mockReturnValue(5_000);

    try {
      expect(() => runner.listTasks()).toThrow('Failed to acquire tasks lock within 5000ms');
    } finally {
      dateNowSpy.mockRestore();
      rmSync(join(testDir, '.takt', 'tasks.yaml.lock'), { force: true });
    }
  });

  it('should recover from corrupted tasks.yaml and allow adding tasks again', () => {
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'tasks.yaml'), 'tasks:\n  - name: [broken', 'utf-8');

    expect(() => runner.listTasks()).not.toThrow();
    expect(runner.listTasks()).toEqual([]);
    expect(existsSync(join(testDir, '.takt', 'tasks.yaml'))).toBe(false);

    const task = runner.addTask('Task after recovery');
    expect(task.name).toContain('task-after-recovery');
    expect(existsSync(join(testDir, '.takt', 'tasks.yaml'))).toBe(true);
    expect(runner.listTasks()).toHaveLength(1);
  });

  it('should load pending content from relative content_file', () => {
    mkdirSync(join(testDir, 'fixtures'), { recursive: true });
    writeFileSync(join(testDir, 'fixtures', 'task.txt'), 'Task from file\nsecond line', 'utf-8');
    writeTasksFile(testDir, [createPendingRecord({
      content: undefined,
      content_file: 'fixtures/task.txt',
    })]);

    const tasks = runner.listTasks();
    const pendingItems = runner.listPendingTaskItems();

    expect(tasks[0]?.content).toBe('Task from file\nsecond line');
    expect(pendingItems[0]?.content).toBe('Task from file');
  });

  it('should load pending content from absolute content_file', () => {
    const contentPath = join(testDir, 'absolute-task.txt');
    writeFileSync(contentPath, 'Absolute task content', 'utf-8');
    writeTasksFile(testDir, [createPendingRecord({
      content: undefined,
      content_file: contentPath,
    })]);

    const tasks = runner.listTasks();
    expect(tasks[0]?.content).toBe('Absolute task content');
  });

  it('should build task instruction from task_dir and expose taskDir on TaskInfo', () => {
    mkdirSync(join(testDir, '.takt', 'tasks', '20260201-000000-demo'), { recursive: true });
    writeFileSync(
      join(testDir, '.takt', 'tasks', '20260201-000000-demo', 'order.md'),
      'Detailed long spec',
      'utf-8',
    );
    writeTasksFile(testDir, [createPendingRecord({
      content: undefined,
      task_dir: '.takt/tasks/20260201-000000-demo',
    })]);

    const tasks = runner.listTasks();
    expect(tasks[0]?.taskDir).toBe('.takt/tasks/20260201-000000-demo');
    expect(tasks[0]?.content).toContain('Implement using only the files');
    expect(tasks[0]?.content).toContain('.takt/tasks/20260201-000000-demo');
    expect(tasks[0]?.content).toContain('.takt/tasks/20260201-000000-demo/order.md');
  });

  it('should throw when task_dir order.md is missing', () => {
    mkdirSync(join(testDir, '.takt', 'tasks', '20260201-000000-missing'), { recursive: true });
    writeTasksFile(testDir, [createPendingRecord({
      content: undefined,
      task_dir: '.takt/tasks/20260201-000000-missing',
    })]);

    expect(() => runner.listTasks()).toThrow(/Task spec file is missing/i);
  });

  it('should reset tasks file when both content and content_file are set', () => {
    writeTasksFile(testDir, [{
      name: 'task-a',
      status: 'pending',
      content: 'Inline content',
      content_file: 'missing-content-file.txt',
      created_at: '2026-02-09T00:00:00.000Z',
      started_at: null,
      completed_at: null,
      owner_pid: null,
    }]);

    expect(runner.listTasks()).toEqual([]);
    expect(existsSync(join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should throw when content_file target is missing', () => {
    writeTasksFile(testDir, [createPendingRecord({
      content: undefined,
      content_file: 'missing-content-file.txt',
    })]);

    expect(() => runner.listTasks()).toThrow(/ENOENT|no such file/i);
  });

  it('should remove completed task record from tasks.yaml', () => {
    runner.addTask('Task A');
    const task = runner.claimNextTasks(1)[0]!;

    runner.completeTask({
      task,
      success: true,
      response: 'Done',
      executionLog: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const file = loadTasksFile(testDir);
    expect(file.tasks).toHaveLength(0);
  });

  it('should remove only the completed task when multiple tasks exist', () => {
    runner.addTask('Task A');
    runner.addTask('Task B');
    const task = runner.claimNextTasks(1)[0]!;

    runner.completeTask({
      task,
      success: true,
      response: 'Done',
      executionLog: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const file = loadTasksFile(testDir);
    expect(file.tasks).toHaveLength(1);
    expect(file.tasks[0]?.name).toContain('task-b');
    expect(file.tasks[0]?.status).toBe('pending');
  });

  it('should mark claimed task as failed with failure detail', () => {
    runner.addTask('Task A');
    const task = runner.claimNextTasks(1)[0]!;

    runner.failTask({
      task,
      success: false,
      response: 'Boom',
      executionLog: ['last message'],
      failureMovement: 'review',
      failureLastMessage: 'last message',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const failed = runner.listFailedTasks();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failure?.error).toBe('Boom');
    expect(failed[0]?.failure?.movement).toBe('review');
    expect(failed[0]?.failure?.last_message).toBe('last message');
  });

  it('should requeue failed task to pending with retry metadata', () => {
    runner.addTask('Task A');
    const task = runner.claimNextTasks(1)[0]!;
    runner.failTask({
      task,
      success: false,
      response: 'Boom',
      executionLog: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    runner.requeueFailedTask(task.name, 'implement', 'retry note');

    const pending = runner.listTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.data?.start_movement).toBe('implement');
    expect(pending[0]?.data?.retry_note).toBe('retry note');
  });

  it('should delete pending and failed tasks', () => {
    const pending = runner.addTask('Task A');
    runner.deletePendingTask(pending.name);
    expect(runner.listTasks()).toHaveLength(0);

    const failed = runner.addTask('Task B');
    const running = runner.claimNextTasks(1)[0]!;
    runner.failTask({
      task: running,
      success: false,
      response: 'Boom',
      executionLog: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    runner.deleteFailedTask(failed.name);
    expect(runner.listFailedTasks()).toHaveLength(0);
  });
});

describe('TaskRecordSchema', () => {
  it('should reject failed record without failure details', () => {
    expect(() => TaskRecordSchema.parse({
      name: 'task-a',
      status: 'failed',
      content: 'Do work',
      created_at: '2026-02-09T00:00:00.000Z',
      started_at: '2026-02-09T00:01:00.000Z',
      completed_at: '2026-02-09T00:02:00.000Z',
    })).toThrow();
  });

  it('should reject completed record with failure details', () => {
    expect(() => TaskRecordSchema.parse({
      name: 'task-a',
      status: 'completed',
      content: 'Do work',
      created_at: '2026-02-09T00:00:00.000Z',
      started_at: '2026-02-09T00:01:00.000Z',
      completed_at: '2026-02-09T00:02:00.000Z',
      failure: {
        error: 'unexpected',
      },
    })).toThrow();
  });
});
