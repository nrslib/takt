/**
 * Unit tests for task exceed/requeue operations
 *
 * Covers:
 * - exceedTask: transitions running task to exceeded status with metadata
 * - requeueExceededTask: transitions exceeded task back to pending, preserving metadata
 * - deleteExceededTask: removes exceeded task from the store
 * - listExceededTasks: returns exceeded tasks as TaskListItem list
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskRunner } from '../infra/task/runner.js';

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function writeExceededRecord(testDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  const record = {
    name: 'task-a',
    status: 'exceeded',
    content: 'Do work',
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: '2026-02-09T00:01:00.000Z',
    completed_at: '2026-02-09T00:05:00.000Z',
    owner_pid: null,
    start_movement: 'implement',
    exceeded_max_movements: 60,
    exceeded_current_iteration: 30,
    ...overrides,
  };
  writeFileSync(
    join(testDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

describe('TaskRunner - exceedTask', () => {
  const testDir = `/tmp/takt-exceed-test-${Date.now()}`;
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

  it('should transition a running task to exceeded status', () => {
    // Given: a running task
    runner.addTask('Task A');
    runner.claimNextTasks(1);

    const beforeFile = loadTasksFile(testDir);
    const runningTask = beforeFile.tasks[0]!;
    const taskName = runningTask.name as string;

    // When: exceedTask is called
    runner.exceedTask(taskName, {
      currentMovement: 'implement',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: task is now exceeded
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.status).toBe('exceeded');
  });

  it('should preserve started_at from the running state', () => {
    // Given: a running task
    runner.addTask('Task A');
    runner.claimNextTasks(1);

    const beforeFile = loadTasksFile(testDir);
    const runningTask = beforeFile.tasks[0]!;
    const taskName = runningTask.name as string;
    const originalStartedAt = runningTask.started_at as string;

    // When: exceedTask is called
    runner.exceedTask(taskName, {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: started_at is preserved from running state
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.started_at).toBe(originalStartedAt);
  });

  it('should set completed_at to a non-null timestamp', () => {
    // Given: a running task
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: exceedTask is called
    runner.exceedTask(taskName, {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: completed_at is set
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.completed_at).toBeTruthy();
    expect(typeof exceededTask.completed_at).toBe('string');
  });

  it('should clear owner_pid', () => {
    // Given: a running task (has owner_pid)
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: exceedTask is called
    runner.exceedTask(taskName, {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: owner_pid is null
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.owner_pid).toBeNull();
  });

  it('should record the current movement as start_movement', () => {
    // Given: a running task
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: exceedTask is called with currentMovement = 'reviewers'
    runner.exceedTask(taskName, {
      currentMovement: 'reviewers',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: start_movement is set to 'reviewers'
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.start_movement).toBe('reviewers');
  });

  it('should record exceeded_max_movements', () => {
    // Given: a running task
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: exceedTask is called with newMaxMovements = 60
    runner.exceedTask(taskName, {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: exceeded_max_movements is 60
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.exceeded_max_movements).toBe(60);
  });

  it('should record exceeded_current_iteration', () => {
    // Given: a running task
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: exceedTask is called with currentIteration = 30
    runner.exceedTask(taskName, {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    // Then: exceeded_current_iteration is 30
    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.exceeded_current_iteration).toBe(30);
  });

  it('should throw when task is not found', () => {
    // Given: no task exists
    // When/Then: exceedTask throws
    expect(() => runner.exceedTask('nonexistent-task', {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 30,
    })).toThrow(/not found/i);
  });

  it('should throw when task is pending (not running)', () => {
    // Given: a pending task (not yet claimed)
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When/Then: exceedTask throws for pending task
    expect(() => runner.exceedTask(taskName, {
      currentMovement: 'plan',
      newMaxMovements: 60,
      currentIteration: 0,
    })).toThrow(/not found/i);
  });
});

describe('TaskRunner - requeueExceededTask', () => {
  const testDir = `/tmp/takt-requeue-exceeded-test-${Date.now()}`;
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

  it('should transition exceeded task to pending', () => {
    // Given: an exceeded task in the store
    writeExceededRecord(testDir, { name: 'task-a' });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: task is now pending
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.status).toBe('pending');
  });

  it('should clear started_at after requeue', () => {
    // Given: an exceeded task (has started_at from execution)
    writeExceededRecord(testDir, { name: 'task-a' });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: started_at is null
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.started_at).toBeNull();
  });

  it('should clear completed_at after requeue', () => {
    // Given: an exceeded task (has completed_at from exceed time)
    writeExceededRecord(testDir, { name: 'task-a' });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: completed_at is null
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.completed_at).toBeNull();
  });

  it('should clear owner_pid after requeue', () => {
    // Given: an exceeded task
    writeExceededRecord(testDir, { name: 'task-a' });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: owner_pid is null
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.owner_pid).toBeNull();
  });

  it('should preserve exceeded_max_movements for continuation', () => {
    // Given: an exceeded task with exceeded_max_movements = 60
    writeExceededRecord(testDir, {
      name: 'task-a',
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
    });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: exceeded_max_movements is preserved (used by resolveTaskExecution)
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.exceeded_max_movements).toBe(60);
  });

  it('should preserve exceeded_current_iteration for continuation', () => {
    // Given: an exceeded task with exceeded_current_iteration = 30
    writeExceededRecord(testDir, {
      name: 'task-a',
      exceeded_current_iteration: 30,
    });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: exceeded_current_iteration is preserved
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.exceeded_current_iteration).toBe(30);
  });

  it('should preserve start_movement for re-entry point', () => {
    // Given: an exceeded task with start_movement = 'reviewers'
    writeExceededRecord(testDir, {
      name: 'task-a',
      start_movement: 'reviewers',
    });

    // When: requeueExceededTask is called
    runner.requeueExceededTask('task-a');

    // Then: start_movement is preserved
    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.start_movement).toBe('reviewers');
  });

  it('should throw when task is not in exceeded status', () => {
    // Given: a pending task (not exceeded)
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When/Then: requeueExceededTask throws
    expect(() => runner.requeueExceededTask(taskName)).toThrow(/not found/i);
  });

  it('should throw when task does not exist', () => {
    // Given: no task exists
    // When/Then: requeueExceededTask throws
    expect(() => runner.requeueExceededTask('nonexistent-task')).toThrow(/not found/i);
  });

  it('should not affect other tasks in the store', () => {
    // Given: one exceeded and one pending task
    // writeExceededRecord must come first because it overwrites tasks.yaml;
    // addTask then reads and appends to the file.
    writeExceededRecord(testDir, { name: 'task-a' });
    runner.addTask('Task B');

    const initialFile = loadTasksFile(testDir);
    const pendingTask = initialFile.tasks.find((t) => t.status === 'pending');
    expect(pendingTask).toBeDefined();

    // When: requeueExceededTask is called for task-a
    runner.requeueExceededTask('task-a');

    // Then: the other task is unaffected
    const afterFile = loadTasksFile(testDir);
    const stillPending = afterFile.tasks.find((t) => (t.name as string).includes('task-b'));
    expect(stillPending?.status).toBe('pending');
  });
});

describe('TaskRunner - deleteExceededTask', () => {
  const testDir = `/tmp/takt-delete-exceeded-test-${Date.now()}`;
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

  it('should delete an exceeded task', () => {
    // Given: an exceeded task
    writeExceededRecord(testDir, { name: 'task-a' });

    // When: deleteExceededTask is called
    runner.deleteExceededTask('task-a');

    // Then: task is removed
    const file = loadTasksFile(testDir);
    expect(file.tasks).toHaveLength(0);
  });

  it('should throw when task is not in exceeded status', () => {
    // Given: a pending task
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When/Then: deleteExceededTask throws
    expect(() => runner.deleteExceededTask(taskName)).toThrow(/not found/i);
  });

  it('should throw when task does not exist', () => {
    // Given: no task exists
    // When/Then: deleteExceededTask throws
    expect(() => runner.deleteExceededTask('nonexistent-task')).toThrow(/not found/i);
  });
});

describe('TaskRunner - listExceededTasks', () => {
  const testDir = `/tmp/takt-list-exceeded-test-${Date.now()}`;
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

  it('should return exceeded tasks as TaskListItems with exceeded kind', () => {
    // Given: an exceeded task
    writeExceededRecord(testDir, { name: 'task-a' });

    // When: listExceededTasks is called
    const exceeded = runner.listExceededTasks();

    // Then: one item with kind 'exceeded'
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.kind).toBe('exceeded');
    expect(exceeded[0]?.name).toBe('task-a');
  });

  it('should return empty array when no exceeded tasks exist', () => {
    // Given: only pending tasks
    runner.addTask('Task A');

    // When: listExceededTasks is called
    const exceeded = runner.listExceededTasks();

    // Then: empty array
    expect(exceeded).toHaveLength(0);
  });

  it('should not include non-exceeded tasks', () => {
    // Given: one exceeded and one pending task
    // writeExceededRecord must come first because it overwrites tasks.yaml;
    // addTask then reads and appends to the file.
    writeExceededRecord(testDir, { name: 'task-a' });
    runner.addTask('Task B');

    // When: listExceededTasks is called
    const exceeded = runner.listExceededTasks();

    // Then: only the exceeded task
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.name).toBe('task-a');
  });

  it('should expose exceeded metadata in data field', () => {
    // Given: an exceeded task with metadata
    writeExceededRecord(testDir, {
      name: 'task-a',
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
    });

    // When: listExceededTasks is called
    const exceeded = runner.listExceededTasks();

    // Then: metadata is accessible via data
    const task = exceeded[0]!;
    expect(task.data?.exceeded_max_movements).toBe(60);
    expect(task.data?.exceeded_current_iteration).toBe(30);
  });
});
