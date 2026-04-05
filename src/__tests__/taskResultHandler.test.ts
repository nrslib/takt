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
import { persistExceededTaskResult } from '../features/tasks/execute/taskResultHandler.js';
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
      currentMovement: 'reviewers',
      newMaxMovements: 60,
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
        currentMovement: 'implement',
        newMaxMovements: 60,
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
        currentMovement: 'plan',
        newMaxMovements: 40,
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
        currentMovement: 'fix',
        newMaxMovements: 50,
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
