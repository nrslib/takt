import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

import { info } from '../shared/ui/index.js';
import {
  buildTaskResult,
  persistExceededTaskResult,
  persistTaskResult,
} from '../features/tasks/execute/taskResultHandler.js';
import { TaskRunner } from '../infra/task/runner.js';

const mockInfo = vi.mocked(info);

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

describe('persistExceededTaskResult', () => {
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = join(tmpdir(), `takt-result-handler-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
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
    expect(mockInfo).toHaveBeenCalledWith(
      `Task "${task.name}" exceeded iteration limit at step "reviewers"`,
    );
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
