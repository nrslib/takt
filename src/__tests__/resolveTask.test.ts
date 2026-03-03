import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskInfo } from '../infra/task/index.js';
import * as infraTask from '../infra/task/index.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProjectDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-resolve-task-test-'));
  tempRoots.add(root);
  return root;
}

function createTask(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    filePath: '/tasks/task.yaml',
    name: 'task-name',
    content: 'Run task',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    data: { task: 'Run task' },
    ...overrides,
  };
}

describe('resolveTaskExecution', () => {
  it('should return defaults when task data is null', async () => {
    const root = createTempProjectDir();
    const task = createTask({ data: null });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(result).toEqual({
      execCwd: root,
      execPiece: 'default',
      isWorktree: false,
      autoPr: false,
      draftPr: false,
    });
  });

  it('should generate report context and copy issue-bearing task spec', async () => {
    const root = createTempProjectDir();
    const taskDir = '.takt/tasks/issue-task-123';
    const sourceTaskDir = path.join(root, taskDir);
    const sourceOrderPath = path.join(sourceTaskDir, 'order.md');
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(sourceOrderPath, '# task instruction');

    const task = createTask({
      taskDir,
      data: {
        task: 'Run issue task',
        issue: 12345,
        auto_pr: true,
      },
    });

    const result = await resolveTaskExecution(task, root, 'default');
    const expectedReportOrderPath = path.join(root, '.takt', 'runs', 'issue-task-123', 'context', 'task', 'order.md');

    expect(result).toMatchObject({
      execCwd: root,
      execPiece: 'default',
      isWorktree: false,
      autoPr: true,
      draftPr: false,
      reportDirName: 'issue-task-123',
      issueNumber: 12345,
      taskPrompt: expect.stringContaining('Primary spec: `.takt/runs/issue-task-123/context/task/order.md`'),
    });
    expect(fs.existsSync(expectedReportOrderPath)).toBe(true);
    expect(fs.readFileSync(expectedReportOrderPath, 'utf-8')).toBe('# task instruction');
  });

  it('should pass base_branch to shared clone options when worktree task has base_branch', async () => {
    const root = createTempProjectDir();
    const taskData = {
      task: 'Run task with base branch',
      worktree: true,
      branch: 'feature/base-branch',
      base_branch: 'release/main',
    };
    const task = createTask({
      data: ({
        ...taskData,
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: '/tmp/shared-clone',
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, 'release/main');
    expect(mockCreateSharedClone).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        worktree: true,
        branch: 'feature/base-branch',
        baseBranch: 'release/main',
      }),
    );
    expect(result.baseBranch).toBe('release/main');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should prefer base_branch over legacy baseBranch when both are present', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      slug: 'prefer-base-branch',
      data: ({
        task: 'Run task with both base branch fields',
        worktree: true,
        branch: 'feature/base-branch',
        base_branch: 'release/main',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: '/tmp/shared-clone',
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecution(task, root, 'default');
    const cloneOptions = mockCreateSharedClone.mock.calls[0]?.[1] as Record<string, unknown> | undefined;

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, 'release/main');
    expect(cloneOptions).toBeDefined();
    expect(cloneOptions).toMatchObject({
      worktree: true,
      branch: 'feature/base-branch',
      taskSlug: 'prefer-base-branch',
      baseBranch: 'release/main',
    });
    expect(cloneOptions).not.toMatchObject({ baseBranch: 'legacy/main' });
    expect(result.baseBranch).toBe('release/main');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should ignore legacy baseBranch field when base_branch is not set', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      slug: 'legacy-base-branch',
      data: ({
        task: 'Run task with legacy baseBranch',
        worktree: true,
        branch: 'feature/base-branch',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'develop',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: '/tmp/shared-clone',
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecution(task, root, 'default');
    const cloneOptions = mockCreateSharedClone.mock.calls[0]?.[1] as Record<string, unknown> | undefined;

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, undefined);
    expect(cloneOptions).toBeDefined();
    expect(cloneOptions).toMatchObject({
      worktree: true,
      branch: 'feature/base-branch',
      taskSlug: 'legacy-base-branch',
    });
    expect(cloneOptions).not.toHaveProperty('baseBranch');
    expect(result.baseBranch).toBe('develop');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should preserve base_branch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, 'existing-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with base branch',
        worktree: true,
        branch: 'feature/base-branch',
        base_branch: 'release/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: worktreePath,
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('release/main');
    expect(mockCreateSharedClone).not.toHaveBeenCalled();

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should prefer base_branch over legacy baseBranch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, 'existing-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with both base branch fields',
        worktree: true,
        branch: 'feature/base-branch',
        base_branch: 'release/main',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: worktreePath,
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, 'release/main');
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('release/main');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should ignore legacy baseBranch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, 'existing-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with legacy base branch',
        worktree: true,
        branch: 'feature/base-branch',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'develop',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: worktreePath,
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, undefined);
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('develop');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('draft_pr: true が draftPr: true として解決される', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run draft task',
        auto_pr: true,
        draft_pr: true,
      },
    });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(result.draftPr).toBe(true);
    expect(result.autoPr).toBe(true);
  });
});
