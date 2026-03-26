import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskInfo } from '../infra/task/index.js';
import * as infraTask from '../infra/task/index.js';

const mockGetGitProvider = vi.hoisted(() => vi.fn());

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: mockGetGitProvider,
}));

import { resolveTaskExecution, resolveTaskIssue } from '../features/tasks/execute/resolveTask.js';

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

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  const baseData = { task: 'Run task', piece: 'default' } as NonNullable<TaskInfo['data']>;
  const data = overrides.data === undefined
    ? baseData
    : overrides.data === null
      ? null
      : ({
          ...baseData,
          ...(overrides.data as Record<string, unknown>),
        } as NonNullable<TaskInfo['data']>);

  return {
    filePath: '/tasks/task.yaml',
    name: 'task-name',
    content: 'Run task',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    ...overrides,
    data,
  };
}

const resolveTaskExecutionWithPiece = resolveTaskExecution as (task: TaskInfo, projectCwd: string) => ReturnType<typeof resolveTaskExecution>;

describe('resolveTaskExecution', () => {
  it('should throw when task data is null', async () => {
    const root = createTempProjectDir();
    const task = createTask({ data: null });

    await expect(resolveTaskExecutionWithPiece(task, root)).rejects.toThrow();
  });

  it('should throw when task data does not include piece', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: ({
        task: 'Run task without piece',
        piece: undefined,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    await expect(resolveTaskExecutionWithPiece(task, root)).rejects.toThrow();
  });

  it('should return defaults for valid task data', async () => {
    const root = createTempProjectDir();
    const task = createTask();

    const result = await resolveTaskExecutionWithPiece(task, root);

    expect(result).toMatchObject({
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

    const result = await resolveTaskExecutionWithPiece(task, root);
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

    const result = await resolveTaskExecutionWithPiece(task, root);

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

    const result = await resolveTaskExecutionWithPiece(task, root);
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

    const result = await resolveTaskExecutionWithPiece(task, root);
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
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-worktree');
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

    const result = await resolveTaskExecutionWithPiece(task, root);

    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('release/main');
    expect(mockCreateSharedClone).not.toHaveBeenCalled();

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should prefer base_branch over legacy baseBranch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-worktree');
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

    const result = await resolveTaskExecutionWithPiece(task, root);

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
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-worktree');
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

    const result = await resolveTaskExecutionWithPiece(task, root);

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, undefined);
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('develop');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should not reuse existing worktree path outside clone base directory', async () => {
    const root = createTempProjectDir();
    const outsidePath = path.join(os.tmpdir(), `takt-outside-${Date.now()}`);
    fs.mkdirSync(outsidePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with untrusted worktree path',
        worktree: true,
        branch: 'feature/outside-worktree',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: outsidePath,
      status: 'pending',
    });

    const safeClonePath = path.join(root, '.takt', 'worktrees', 'safe-clone');
    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: safeClonePath,
      branch: 'feature/outside-worktree',
    });

    const result = await resolveTaskExecutionWithPiece(task, root);

    expect(mockCreateSharedClone).toHaveBeenCalled();
    expect(result.execCwd).toBe(safeClonePath);
    expect(result.worktreePath).toBe(safeClonePath);
    expect(result.isWorktree).toBe(true);

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
    fs.rmSync(outsidePath, { recursive: true, force: true });
  });

  it('should reuse existing worktree path within clone base directory', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with safe worktree path',
        worktree: true,
        branch: 'feature/safe-worktree',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedClone').mockReturnValue({
      path: worktreePath,
      branch: 'feature/safe-worktree',
    });

    const result = await resolveTaskExecutionWithPiece(task, root);

    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.worktreePath).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);

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

    const result = await resolveTaskExecutionWithPiece(task, root);

    expect(result.draftPr).toBe(true);
    expect(result.autoPr).toBe(true);
  });
});

describe('resolveTaskIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issueNumber が undefined の場合は undefined を返す', () => {
    // When
    const result = resolveTaskIssue(undefined, '/tmp/test');

    // Then
    expect(result).toBeUndefined();
  });

  it('CLI が利用不可の場合は undefined を返し、cwd を checkCliStatus に渡す', () => {
    // Given
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: false, error: 'not installed' }),
      fetchIssue: vi.fn(),
    };
    mockGetGitProvider.mockReturnValue(mockProvider);

    // When
    const result = resolveTaskIssue(42, '/my/project');

    // Then
    expect(result).toBeUndefined();
    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/my/project');
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it('fetchIssue が成功した場合は issue 配列を返す', () => {
    // Given
    const issue = { number: 42, title: 'Test', body: 'Body', labels: [], comments: [] };
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: true }),
      fetchIssue: vi.fn().mockReturnValue(issue),
    };
    mockGetGitProvider.mockReturnValue(mockProvider);

    // When
    const result = resolveTaskIssue(42, '/my/project');

    // Then
    expect(result).toEqual([issue]);
    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/my/project');
    expect(mockProvider.fetchIssue).toHaveBeenCalledWith(42, '/my/project');
  });

  it('fetchIssue が例外を投げた場合は undefined を返す', () => {
    // Given
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: true }),
      fetchIssue: vi.fn().mockImplementation(() => { throw new Error('API error'); }),
    };
    mockGetGitProvider.mockReturnValue(mockProvider);

    // When
    const result = resolveTaskIssue(42, '/my/project');

    // Then
    expect(result).toBeUndefined();
    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/my/project');
    expect(mockProvider.fetchIssue).toHaveBeenCalledWith(42, '/my/project');
  });
});
