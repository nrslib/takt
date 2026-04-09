import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';
import { isStaleRunningTask } from '../infra/task/index.js';

const {
  mockConfirm,
  mockSuccess,
  mockLogError,
  mockForceFailRunningTask,
  mockRunnerProjectDir,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSuccess: vi.fn(),
  mockLogError: vi.fn(),
  mockForceFailRunningTask: vi.fn(),
  mockRunnerProjectDir: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../shared/ui/index.js', () => ({
  success: mockSuccess,
  error: mockLogError,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    constructor(projectDir: string) {
      mockRunnerProjectDir(projectDir);
    }

    forceFailRunningTask(...args: unknown[]) {
      return mockForceFailRunningTask(...args);
    }
  },
  isStaleRunningTask: vi.fn(() => true),
}));

import { forceFailRunningTask } from '../features/tasks/list/taskForceFailActions.js';

function createRunningTask(projectDir: string, overrides?: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'running',
    name: 'running-task',
    createdAt: '2026-04-09T00:00:00.000Z',
    filePath: path.join(projectDir, '.takt', 'tasks.yaml'),
    content: 'Force fail me',
    taskDir: '.takt/tasks/20260409-run-a',
    runSlug: '20260409-run-a',
    ownerPid: 4242,
    data: {
      task: 'Force fail me\nwith full prompt',
    },
    ...overrides,
  };
}

function writeMeta(runRoot: string, slug: string, meta: Record<string, unknown>): void {
  const metaPath = path.join(runRoot, '.takt', 'runs', slug, 'meta.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

describe('forceFailRunningTask', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isStaleRunningTask).mockReturnValue(true);
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-force-fail-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('should return false when confirmation is cancelled', async () => {
    mockConfirm.mockResolvedValue(false);

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(false);
    expect(mockConfirm).toHaveBeenCalledWith('Mark running task "running-task" as failed?', false);
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should mark running task as failed using currentStep from project meta.json', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
      currentStep: 'implement',
      currentIteration: 2,
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalledWith('Mark running task "running-task" as failed?', false);
    expect(mockRunnerProjectDir).toHaveBeenCalledWith(projectDir);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockSuccess).toHaveBeenCalled();
  });

  it('should show a live-process warning before force-failing non-stale running task', async () => {
    vi.mocked(isStaleRunningTask).mockReturnValue(false);
    mockConfirm.mockResolvedValue(false);

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(false);
    expect(mockConfirm).toHaveBeenCalledWith(
      'Process 4242 may still be running. Mark "running-task" as failed anyway?',
      false,
    );
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
  });

  it('should fall back to worktree meta.json when project run metadata has no currentStep', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
      currentIteration: 4,
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
  });

  it('should prefer worktree meta.json when both project and worktree runs match', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
      currentIteration: 2,
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
      currentIteration: 4,
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
  });

  it('should ignore unrelated project runs and prefer matching worktree run metadata', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-z', {
      task: 'Other task prompt',
      status: 'running',
      currentStep: 'wrong-step',
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
  });

  it('should skip an unreadable newest meta.json and use an older matching run', async () => {
    mockConfirm.mockResolvedValue(true);
    fs.mkdirSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json'), '{ broken json', 'utf-8');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should report failure when matching meta.json is unreadable', async () => {
    mockConfirm.mockResolvedValue(true);
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '{ broken json', 'utf-8');

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should skip an unreadable newest worktree meta.json and use an older matching run', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    fs.mkdirSync(path.join(worktreePath, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, '.takt', 'runs', '20260409-run-z', 'meta.json'),
      '{ broken json',
      'utf-8',
    );
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should ignore corrupt worktree meta.json when matching project run exists', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    fs.mkdirSync(path.join(worktreePath, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, '.takt', 'runs', '20260409-run-z', 'meta.json'),
      '{ broken json',
      'utf-8',
    );
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should use task run slug to ignore a newer project run from another task', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-z', {
      task: 'Force fail me\nwith full prompt',
      status: 'running',
      currentStep: 'wrong-step',
    });
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
  });

  it('should use matching worktree run when unrelated project meta.json is corrupt', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    fs.mkdirSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json'), '{ broken json', 'utf-8');
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should allow force-fail with undefined movement when only unrelated corrupt meta.json exists', async () => {
    mockConfirm.mockResolvedValue(true);
    fs.mkdirSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json'), '{ broken json', 'utf-8');

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should allow force-fail with undefined movement when run slug is missing', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { runSlug: undefined, taskDir: undefined }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
  });

  it('should allow force-fail when task prompt is missing but run slug is available', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { data: undefined }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should ignore invalid worktree paths and continue with project run metadata', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { worktreePath: '/tmp/outside-project-worktree' }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
  });

  it('should ignore invalid run slug values and continue with undefined movement', async () => {
    mockConfirm.mockResolvedValue(true);

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { runSlug: '../escape-run' }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
  });

  it('should return false and log an error when runner force-fail throws', async () => {
    mockConfirm.mockResolvedValue(true);
    mockForceFailRunningTask.mockImplementation(() => {
      throw new Error('runner exploded');
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to mark running task "running-task" as failed: runner exploded',
    );
    expect(mockSuccess).not.toHaveBeenCalled();
  });

});
