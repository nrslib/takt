import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { WorkflowResumePointEntry } from '../core/models/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { buildWorkflowCallInvocationFixture } from './helpers/workflow-resume-fixture.js';

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

function writeRunningRestartRecord(testDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  const record = {
    name: 'restart-task',
    status: 'running',
    content: 'Do restarted work',
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: '2026-02-09T00:01:00.000Z',
    completed_at: null,
    owner_pid: 12345,
    workflow: 'default',
    restart_point: {
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
      ],
    },
    ...overrides,
  };
  writeFileSync(
    join(testDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

function makeWorkflowCallResumeStack(): WorkflowResumePointEntry[] {
  return [
    {
      workflow: 'default',
      workflow_ref: 'default',
      step: 'delegate',
      kind: 'workflow_call' as const,
      occurrence: 1,
      call_instance: 1,
    },
    {
      workflow: 'coding',
      workflow_ref: 'coding',
      step: 'fix',
      kind: 'agent' as const,
      occurrence: 1,
    },
  ];
}

describe('TaskRunner - exceedTask', () => {
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-exceed-test-'));
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
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

  it('should preserve dynamic selection snapshots through exceed, requeue, and claim', () => {
    const identity = '{"workflow":"default","step":"reviewers","calls":[]}' as const;
    const resumePoint = {
      version: 2 as const,
      stack: [{
        workflow: 'default',
        workflow_ref: 'default',
        step: 'reviewers',
        kind: 'parallel' as const,
        occurrence: 1,
      }],
      iteration: 30,
      elapsed_ms: 183245,
      dynamic_parallel_selections: {
        [identity]: {
          identity,
          step_name: 'reviewers',
          round: 2,
          selected_pool_ids: ['frontend'],
          effective_selection_ids: ['architecture', 'frontend'],
        },
      },
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    runner.addTask('Task A');
    const running = runner.claimNextTasks(1)[0]!;

    runner.exceedTask(running.name, {
      currentStep: 'reviewers',
      newMaxSteps: 60,
      currentIteration: 30,
      resumePoint,
    });
    runner.requeueExceededTask(running.name);
    const reclaimed = runner.claimNextTasks(1)[0]!;

    expect(reclaimed.data?.resume_point).toEqual(resumePoint);
  });

  it('should record the current step as start_movement', () => {
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
    expect(exceededTask.start_movement).toBe('reviewers');
    expect(exceededTask.start_step).toBeUndefined();
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

  it('should record resume_point for workflow_call continuation', () => {
    runner.addTask('Task A');
    runner.claimNextTasks(1);
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;
    const resumePoint = {
      version: 2,
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
          call_instance: 1,
        },
        {
          workflow: 'takt/coding',
          workflow_ref: 'takt/coding',
          step: 'review',
          kind: 'agent',
          occurrence: 1,
        },
      ],
      iteration: 30,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    runner.exceedTask(taskName, {
      currentStep: 'delegate',
      newMaxSteps: 60,
      currentIteration: 30,
      resumePoint,
    });

    const afterFile = loadTasksFile(testDir);
    const exceededTask = afterFile.tasks[0]!;
    expect(exceededTask.resume_point).toEqual(resumePoint);
  });

  it('should replace a consumed restart point when the task exceeds again', () => {
    writeRunningRestartRecord(testDir, {
      worktree_path: '/tmp/restart-worktree',
      branch: 'takt/restart-task',
    });
    const stack = makeWorkflowCallResumeStack();
    const resumePoint = {
      version: 2 as const,
      stack,
      iteration: 37,
      elapsed_ms: 240_000,
      workflow_call_invocations: buildWorkflowCallInvocationFixture(stack),
      workflow_step_participations: {},
    };

    runner.exceedTask('restart-task', {
      currentStep: 'delegate',
      newMaxSteps: 80,
      currentIteration: 37,
      resumePoint,
    });

    const exceededTask = loadTasksFile(testDir).tasks[0]!;
    expect(exceededTask).toEqual(expect.objectContaining({
      status: 'exceeded',
      start_movement: 'delegate',
      exceeded_max_steps: 80,
      exceeded_current_iteration: 37,
      resume_point: resumePoint,
      owner_pid: null,
      worktree_path: '/tmp/restart-worktree',
      branch: 'takt/restart-task',
    }));
    expect(exceededTask.restart_point).toBeUndefined();
    expect(exceededTask.failure).toBeUndefined();
  });

  it('should remove a consumed restart point when no current resume point exists', () => {
    writeRunningRestartRecord(testDir);

    runner.exceedTask('restart-task', {
      currentStep: 'delegate',
      newMaxSteps: 1,
      currentIteration: 0,
    });

    const exceededTask = loadTasksFile(testDir).tasks[0]!;
    expect(exceededTask.status).toBe('exceeded');
    expect(exceededTask.restart_point).toBeUndefined();
    expect(exceededTask.resume_point).toBeUndefined();
    expect(exceededTask.exceeded_current_iteration).toBe(0);
    expect(exceededTask.exceeded_max_steps).toBe(1);
  });

  it('should preserve the current exceeded checkpoint when the task is requeued and claimed', () => {
    writeRunningRestartRecord(testDir);
    const stack = makeWorkflowCallResumeStack();
    const resumePoint = {
      version: 2 as const,
      stack,
      iteration: 12,
      elapsed_ms: 90_000,
      workflow_call_invocations: buildWorkflowCallInvocationFixture(stack),
      workflow_step_participations: {},
    };
    runner.exceedTask('restart-task', {
      currentStep: 'delegate',
      newMaxSteps: 40,
      currentIteration: 12,
      resumePoint,
    });

    runner.requeueExceededTask('restart-task');
    const claimed = runner.claimNextTasks(1)[0]!;

    expect(claimed.data?.resume_point).toEqual(resumePoint);
    expect(claimed.data?.start_step).toBe('delegate');
    expect(claimed.data?.exceeded_current_iteration).toBe(12);
    expect(claimed.data?.exceeded_max_steps).toBe(40);
    expect(claimed.data?.restart_point).toBeUndefined();
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
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-requeue-exceeded-test-'));
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
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

  it('should preserve start_movement for re-entry point', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      start_step: 'reviewers',
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.start_movement).toBe('reviewers');
    expect(file.tasks[0]?.start_step).toBeUndefined();
  });

  it('should preserve resume_point through requeue for workflow_call retry', () => {
    const resumePoint = {
      version: 2,
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
          call_instance: 1,
        },
        {
          workflow: 'takt/coding',
          workflow_ref: 'takt/coding',
          step: 'review',
          kind: 'agent',
          occurrence: 1,
        },
      ],
      iteration: 30,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    writeExceededRecord(testDir, {
      name: 'task-a',
      resume_point: resumePoint,
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.resume_point).toEqual(resumePoint);
  });

  it('should preserve the source run provenance when requeueing an exceeded task', () => {
    writeExceededRecord(testDir, {
      name: 'task-a',
      run_slug: '20260717-source-run',
    });

    runner.requeueExceededTask('task-a');

    const file = loadTasksFile(testDir);
    expect(file.tasks[0]?.source_run_slug).toBe('20260717-source-run');
    expect(file.tasks[0]?.resume_mode).toBe('requeue');
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
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-delete-exceeded-test-'));
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
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
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-list-exceeded-test-'));
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
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
