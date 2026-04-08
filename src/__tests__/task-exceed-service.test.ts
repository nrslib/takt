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
    start_step: 'implement',
    exceeded_max_steps: 60,
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
    runner.addTask('Task A');
    runner.claimNextTasks(1);

    const beforeFile = loadTasksFile(testDir);
    const runningTask = beforeFile.tasks[0]!;
    const taskName = runningTask.name as string;

    runner.exceedTask(taskName, {
      currentStep: 'implement',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.status).toBe('exceeded');
  });

  it('should preserve started_at from the running state', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);

    const beforeFile = loadTasksFile(testDir);
    const runningTask = beforeFile.tasks[0]!;
    const taskName = runningTask.name as string;
    const originalStartedAt = runningTask.started_at as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.started_at).toBe(originalStartedAt);
  });

  it('should set completed_at to a non-null timestamp', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.completed_at).toBeTruthy();
    expect(typeof exceededTask.completed_at).toBe('string');
  });

  it('should clear owner_pid', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.owner_pid).toBeNull();
  });

  it('should record the current step as start_step', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'reviewers',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.start_step).toBe('reviewers');
  });

  it('should record exceeded_max_steps in tasks.yaml', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.exceeded_max_steps).toBe(60);
  });

  it('should record exceeded_current_iteration', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.exceeded_current_iteration).toBe(30);
  });

  it('should throw when task is not found', () => {
    expect(() => runner.exceedTask('nonexistent-task', {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    })).toThrow(/not found/i);
  });

  it('should throw when task is pending (not running)', () => {
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    expect(() => runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 0,
    })).toThrow(/not found/i);
  });

  it('should persist worktree_path when exceed options include worktreePath', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;
    const wt = '/tmp/takt-wt-persist-test';

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
      worktreePath: wt,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.worktree_path).toBe(wt);
  });

  it('should persist branch when exceed options include branch', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
      branch: 'takt/issue-562',
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.branch).toBe('takt/issue-562');
  });

  it('Issue #562: persists worktree_path and branch when exceed options include both (typed literals)', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;
    const wt = '/tmp/takt-wt-both';

    runner.exceedTask(taskName, {
      currentStep: 'implement',
      newMaxSteps: 55,
      currentIteration: 20,
      worktreePath: wt,
      branch: 'takt/both',
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.worktree_path).toBe(wt);
    expect(exceededTask.branch).toBe('takt/both');
  });

  it('should not add worktree_path or branch when options omit them', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    runner.exceedTask(taskName, {
      currentStep: 'plan',
      newMaxSteps: 60,
      currentIteration: 30,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.worktree_path).toBeUndefined();
    expect(exceededTask.branch).toBeUndefined();
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
    writeExceededRecord(testDir, { name: 'task-a' });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.status).toBe('pending');
  });

  it('should clear started_at after requeue', () => {
    writeExceededRecord(testDir, { name: 'task-a' });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.started_at).toBeNull();
  });

  it('should clear completed_at after requeue', () => {
    writeExceededRecord(testDir, { name: 'task-a' });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.completed_at).toBeNull();
  });

  it('should clear owner_pid after requeue', () => {
    writeExceededRecord(testDir, { name: 'task-a' });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.owner_pid).toBeNull();
  });

  it('should preserve exceeded_max_steps for continuation after requeue', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      exceeded_max_steps: 60,
      exceeded_current_iteration: 30,
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.exceeded_max_steps).toBe(60);
  });

  it('should preserve exceeded_current_iteration for continuation', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      exceeded_current_iteration: 30,
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.exceeded_current_iteration).toBe(30);
  });

  it('should preserve start_step for re-entry point', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      start_step: 'reviewers',
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.start_step).toBe('reviewers');
  });

  it('should preserve worktree_path and branch through requeue when present on exceeded record', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      worktree_path: '/tmp/preserved-wt',
      branch: 'takt/preserved-branch',
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.status).toBe('pending');
    expect(file.tasks[0]?.worktree_path).toBe('/tmp/preserved-wt');
    expect(file.tasks[0]?.branch).toBe('takt/preserved-branch');
  });

  it('should throw when task is not in exceeded status', () => {
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    expect(() => runner.requeueExceededTask(taskName)).toThrow(/not found/i);
  });

  it('should throw when task does not exist', () => {
    expect(() => runner.requeueExceededTask('nonexistent-task')).toThrow(/not found/i);
  });

  it('should not affect other tasks in the store', () => {
    writeExceededRecord(testDir, { name: 'task-a' });
    runner.addTask('Task B');

    const initialFile = loadTasksFile(testDir);
    const pendingTask = initialFile.tasks.find((t) => t.status === 'pending');
    expect(pendingTask).toBeDefined();

    runner.requeueExceededTask('task-a');

    const afterFile = loadTasksFile(testDir);
    const stillPending = afterFile.tasks.find((t) => (t.name as string).includes('task-b'));
    expect(stillPending?.status).toBe('pending');
  });
});

describe('TaskRunner - deleteTask (exceeded)', () => {
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
    writeExceededRecord(testDir, { name: 'task-a' });

    runner.deleteTask('task-a', 'exceeded');

    const file = loadTasksFile(testDir);
    expect(file.tasks).toHaveLength(0);
  });

  it('should throw when task is not in exceeded status', () => {
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    expect(() => runner.deleteTask(taskName, 'exceeded')).toThrow(/not found/i);
  });

  it('should throw when task does not exist', () => {
    expect(() => runner.deleteTask('nonexistent-task', 'exceeded')).toThrow(/not found/i);
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
    writeExceededRecord(testDir, { name: 'task-a' });

    const exceeded = runner.listExceededTasks();

    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.kind).toBe('exceeded');
    expect(exceeded[0]?.name).toBe('task-a');
  });

  it('should return empty array when no exceeded tasks exist', () => {
    runner.addTask('Task A');

    const exceeded = runner.listExceededTasks();

    expect(exceeded).toHaveLength(0);
  });

  it('should not include non-exceeded tasks', () => {
    writeExceededRecord(testDir, { name: 'task-a' });
    runner.addTask('Task B');

    const exceeded = runner.listExceededTasks();

    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.name).toBe('task-a');
  });

  it('should expose exceeded metadata in data field', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      exceeded_max_steps: 60,
      exceeded_current_iteration: 30,
    });

    const exceeded = runner.listExceededTasks();

    const task = exceeded[0]!;
    expect(task.data?.exceeded_max_steps).toBe(60);
    expect(task.data?.exceeded_current_iteration).toBe(30);
  });
});
