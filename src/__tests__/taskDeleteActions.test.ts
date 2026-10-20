import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLstatFailure = vi.hoisted(() => ({ path: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (target: Parameters<typeof actual.lstatSync>[0]) => {
      if (target === mockLstatFailure.path) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return actual.lstatSync(target);
    },
  };
});

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
  selectMultipleOptions: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockDeleteBranch = vi.fn();
vi.mock('../features/tasks/list/taskActions.js', () => ({
  deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
}));

import { confirm, selectMultipleOptions } from '../shared/prompt/index.js';
import { error as logError, success } from '../shared/ui/index.js';
import { deleteTaskByKind, deleteAllTasks, deleteSelectedTasks } from '../features/tasks/list/taskDeleteActions.js';
import { deleteBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';
import { TaskRunner } from '../infra/task/runner.js';
import { encodeWorktreePath } from '../infra/config/project/sessionStore.js';
import type { TaskListItem } from '../infra/task/types.js';

const mockConfirm = vi.mocked(confirm);
const mockLogError = vi.mocked(logError);

let tmpDir: string;

function setupTasksFile(projectDir: string): string {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name: 'pending-task',
        status: 'pending',
        content: 'pending',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
      {
        name: 'failed-task',
        status: 'failed',
        content: 'failed',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: '2025-01-15T00:01:00.000Z',
        completed_at: '2025-01-15T00:02:00.000Z',
        failure: { error: 'boom' },
      },
      {
        name: 'completed-task',
        status: 'completed',
        content: 'completed',
        branch: 'takt/completed-task',
        worktree_path: '/tmp/takt/completed-task',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: '2025-01-15T00:01:00.000Z',
        completed_at: '2025-01-15T00:02:00.000Z',
      },
      {
        name: 'exceeded-task',
        status: 'exceeded',
        content: 'exceeded',
        exceeded_max_steps: 60,
        exceeded_current_iteration: 30,
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: '2025-01-15T00:01:00.000Z',
        completed_at: '2025-01-15T00:02:00.000Z',
      },
    ],
  }), 'utf-8');
  return tasksFile;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLstatFailure.path = '';
  mockDeleteBranch.mockReturnValue(true);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-delete-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('taskDeleteActions', () => {
  it('should delete pending task when confirmed', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'pending',
      name: 'pending-task',
      createdAt: '2025-01-15',
      filePath: tasksFile,
      content: 'pending',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('pending-task');
  });

  it('should delete failed task when confirmed', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: 'failed',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('failed-task');
  });

  it('should cleanup branch before deleting failed task when branch exists', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: 'failed',
      branch: 'takt/failed-task',
      worktreePath: '/tmp/takt/failed-task',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(true);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('failed-task');
  });

  it('merge taskのheadがmainでもroot branchを削除せずcloneだけを片付ける', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const clonePath = path.join(tmpDir, '.takt', 'worktrees', 'merge-pr-123');
    fs.mkdirSync(clonePath, { recursive: true });
    fs.writeFileSync(path.join(clonePath, 'note.txt'), 'temporary clone\n');
    const task: TaskListItem = {
      kind: 'failed', name: 'failed-task', createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile, content: 'merge PR', branch: 'main', worktreePath: clonePath,
      data: { task: 'merge PR', workflow: 'merge-review-fix-simple',
        source: 'pr_review', pr_number: 123, branch: 'main', merge_task: true },
    };
    mockConfirm.mockResolvedValue(true);

    expect(await deleteTaskByKind(task)).toBe(true);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(fs.existsSync(clonePath)).toBe(false);
    expect(fs.readFileSync(tasksFile, 'utf8')).not.toContain('failed-task');
  });

  it('merge cloneが存在しない場合はroot branchに触れずtaskを削除する', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed', name: 'failed-task', createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile, content: 'merge PR', branch: 'main',
      worktreePath: path.join(tmpDir, '.takt', 'worktrees', 'missing'),
      data: { task: 'merge PR', workflow: 'merge-review-fix-simple', merge_task: true },
    };
    mockConfirm.mockResolvedValue(true);

    expect(await deleteTaskByKind(task)).toBe(true);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(fs.readFileSync(tasksFile, 'utf8')).not.toContain('failed-task');
  });

  it('merge cloneへの壊れたsymlinkを欠落扱いせずtaskを残す', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const clonePath = path.join(tmpDir, '.takt', 'worktrees', 'merge-pr-123');
    fs.mkdirSync(path.dirname(clonePath), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, 'missing-target'), clonePath);
    const task: TaskListItem = {
      kind: 'failed', name: 'failed-task', createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile, content: 'merge PR', branch: 'main', worktreePath: clonePath,
      data: { task: 'merge PR', workflow: 'merge-review-fix-simple', merge_task: true },
    };
    mockConfirm.mockResolvedValue(true);

    expect(await deleteTaskByKind(task)).toBe(false);
    expect(fs.lstatSync(clonePath).isSymbolicLink()).toBe(true);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(fs.readFileSync(tasksFile, 'utf8')).toContain('failed-task');
  });

  it('merge cloneの検査が失敗した場合はroot branchにもtask recordにも触れない', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const clonePath = path.join(tmpDir, '.takt', 'worktrees', 'merge-pr-123');
    const task: TaskListItem = {
      kind: 'failed', name: 'failed-task', createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile, content: 'merge PR', branch: 'main', worktreePath: clonePath,
      data: { task: 'merge PR', workflow: 'merge-review-fix-simple', merge_task: true },
    };
    mockConfirm.mockResolvedValue(true);
    mockLstatFailure.path = clonePath;
    expect(await deleteTaskByKind(task)).toBe(false);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(fs.readFileSync(tasksFile, 'utf8')).toContain('failed-task');
  });

  it('should keep failed task record when branch cleanup fails', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: 'failed',
      branch: 'takt/failed-task',
      worktreePath: '/tmp/takt/failed-task',
    };
    mockConfirm.mockResolvedValue(true);
    mockDeleteBranch.mockReturnValue(false);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(false);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).toContain('failed-task');
  });

  it('does not clean a single task claimed while waiting for confirmation', async () => {
    const runner = new TaskRunner(tmpDir);
    const target = runner.addTask('single', { branch: 'takt/single' });
    const task = runner.listAllTaskItems()[0]!;
    mockConfirm.mockImplementationOnce(async () => {
      expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([target.name]);
      return true;
    });

    expect(await deleteTaskByKind(task)).toBe(false);

    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(runner.listAllTaskItems()).toMatchObject([{ name: target.name, kind: 'running' }]);
  });

  it('does not start cleanup when single-task confirmation is declined', async () => {
    setupTasksFile(tmpDir);
    const runner = new TaskRunner(tmpDir);
    const task = runner.listAllTaskItems().find(({ kind }) => kind === 'completed')!;
    const before = fs.readFileSync(runner.getTasksFilePath(), 'utf8');
    mockConfirm.mockResolvedValueOnce(false);

    expect(await deleteTaskByKind(task)).toBe(false);

    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(fs.readFileSync(runner.getTasksFilePath(), 'utf8')).toBe(before);
  });

  it('should return false when target task is missing', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed',
      name: 'not-found',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: '',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('should confirm with message containing "exceeded" and delete exceeded task when confirmed', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'exceeded',
      name: 'exceeded-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: 'exceeded',
      branch: 'takt/exceeded-task',
      worktreePath: '/tmp/takt/exceeded-task',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(true);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('exceeded-task');
  });

  it('should delete completed task and cleanup worktree when confirmed', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'completed',
      name: 'completed-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: 'completed',
      branch: 'takt/completed-task',
      worktreePath: '/tmp/takt/completed-task',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteTaskByKind(task);

    expect(result).toBe(true);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('completed-task');
  });
});

describe('deleteAllTasks', () => {
  it('should confirm once and delete all non-running tasks', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const tasks: TaskListItem[] = [
      { kind: 'pending', name: 'pending-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'pending' },
      { kind: 'failed', name: 'failed-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'failed' },
      { kind: 'completed', name: 'completed-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'completed', branch: 'takt/completed-task', worktreePath: '/tmp/takt/completed-task' },
    ];
    mockConfirm.mockResolvedValue(true);

    const result = await deleteAllTasks(tasks);

    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('pending-task');
    expect(raw).not.toContain('failed-task');
    expect(raw).not.toContain('completed-task');
  });

  it('should skip running tasks', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const tasks: TaskListItem[] = [
      { kind: 'pending', name: 'pending-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'pending' },
      { kind: 'running', name: 'running-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'running' },
    ];
    mockConfirm.mockResolvedValue(true);

    const result = await deleteAllTasks(tasks);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('pending-task');
  });

  it('should return false when user cancels', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const tasks: TaskListItem[] = [
      { kind: 'pending', name: 'pending-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'pending' },
    ];
    mockConfirm.mockResolvedValue(false);

    const result = await deleteAllTasks(tasks);

    expect(result).toBe(false);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).toContain('pending-task');
  });

  it('should return false when no deletable tasks (only running)', async () => {
    const tasks: TaskListItem[] = [
      { kind: 'running', name: 'running-task', createdAt: '2025-01-15', filePath: '/tmp/fake', content: 'running' },
    ];

    const result = await deleteAllTasks(tasks);

    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should return false when no tasks', async () => {
    const result = await deleteAllTasks([]);

    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should skip task when branch cleanup fails but continue with others', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const tasks: TaskListItem[] = [
      { kind: 'pending', name: 'pending-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'pending' },
      { kind: 'completed', name: 'completed-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'completed', branch: 'takt/completed-task', worktreePath: '/tmp/takt/completed-task' },
    ];
    mockConfirm.mockResolvedValue(true);
    mockDeleteBranch.mockReturnValue(false);

    const result = await deleteAllTasks(tasks);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('pending-task');
    expect(raw).toContain('completed-task');
  });

  it('should return false when all tasks fail branch cleanup', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const tasks: TaskListItem[] = [
      { kind: 'completed', name: 'completed-task', createdAt: '2025-01-15', filePath: tasksFile, content: 'completed', branch: 'takt/completed-task', worktreePath: '/tmp/takt/completed-task' },
    ];
    mockConfirm.mockResolvedValue(true);
    mockDeleteBranch.mockReturnValue(false);

    const result = await deleteAllTasks(tasks);

    expect(result).toBe(false);
  });

  it('should include exceeded task in deleteAllTasks (not filtered like running)', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'exceeded',
      name: 'exceeded-task',
      createdAt: '2025-01-15',
      filePath: tasksFile,
      content: 'exceeded',
      branch: 'takt/exceeded-task',
      worktreePath: '/tmp/takt/exceeded-task',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteAllTasks([task]);

    expect(result).toBe(true);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('exceeded-task');
  });

  it('should cleanup branches for completed and failed tasks', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const completedTask: TaskListItem = {
      kind: 'completed',
      name: 'completed-task',
      createdAt: '2025-01-15',
      filePath: tasksFile,
      content: 'completed',
      branch: 'takt/completed-task',
      worktreePath: '/tmp/takt/completed-task',
    };
    const tasks: TaskListItem[] = [completedTask];
    mockConfirm.mockResolvedValue(true);

    await deleteAllTasks(tasks);

    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, completedTask);
  });
});

describe('deletion while a task is claimed', () => {
  it.each([false, true])('preserves a worktree claimed during selection: %s', async (claim) => {
    const runner = new TaskRunner(tmpDir);
    const worktreePath = path.join(tmpDir, '.takt', 'worktrees', 'first');
    fs.mkdirSync(worktreePath, { recursive: true });
    const marker = path.join(worktreePath, 'work.txt');
    fs.writeFileSync(marker, 'keep work');
    const sessionFile = path.join(tmpDir, '.takt', 'worktree-sessions', `${encodeWorktreePath(worktreePath)}.json`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '{}');
    fs.writeFileSync(runner.getTasksFilePath(), stringifyYaml({ tasks: [
      { name: 'first', status: 'pending', content: 'first', branch: 'takt/first', worktree_path: worktreePath,
        created_at: '2026-10-20T00:00:00.000Z', started_at: null, completed_at: null },
      { name: 'second', status: 'completed', content: 'second', created_at: '2026-10-20T00:00:00.000Z',
        started_at: '2026-10-20T00:00:00.000Z', completed_at: '2026-10-20T00:00:00.000Z' },
    ] }));
    const tasks = runner.listAllTaskItems();
    let select!: (values: string[]) => void;
    vi.mocked(selectMultipleOptions).mockReturnValueOnce(new Promise<string[]>((resolve) => { select = resolve; }));
    mockConfirm.mockResolvedValue(true);
    mockDeleteBranch.mockImplementation(deleteBranch);

    const operation = deleteSelectedTasks(tasks);
    try {
      expect(selectMultipleOptions).toHaveBeenCalledTimes(1);
      expect(mockDeleteBranch).not.toHaveBeenCalled();
      if (claim) expect(runner.claimNextTasks(1).map((task) => task.name)).toEqual(['first']);
    } finally {
      select(['0', '1']);
    }
    expect(await operation).toBe(true);

    expect(fs.existsSync(marker)).toBe(claim);
    expect(fs.existsSync(sessionFile)).toBe(claim);
    expect(runner.listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual(
      claim ? [{ name: 'first', kind: 'running' }] : [],
    );
    expect(mockDeleteBranch).toHaveBeenCalledTimes(claim ? 0 : 1);
    expect(success).toHaveBeenCalledWith(`Deleted ${claim ? 1 : 2} of 2 tasks.`);
    expect(mockLogError).toHaveBeenCalledTimes(claim ? 1 : 0);
  });

  it.each([false, true])('preserves a merge clone requeued and claimed during confirmation: %s', async (claim) => {
    const runner = new TaskRunner(tmpDir);
    const worktreePath = path.join(tmpDir, '.takt', 'worktrees', 'merge-pr-123');
    fs.mkdirSync(worktreePath, { recursive: true });
    const marker = path.join(worktreePath, 'work.txt');
    fs.writeFileSync(marker, 'keep clone');
    const merge = runner.startPrMergeTask({
      prNumber: 123, headBranch: 'main', baseBranch: 'release', headSha: 'a'.repeat(40),
      headRepositoryUrl: 'https://github.com/example/repo.git',
      headRepositoryPushUrls: ['https://github.com/example/repo.git'],
      workflow: 'merge-review-fix-simple', method: 'merge', worktreePath, threatCheckMaxDiffBytes: 1000,
    });
    runner.forceFailRunningTask(merge.name, { error: 'retry' });
    const tasks = runner.listAllTaskItems();
    let approve!: (approved: boolean) => void;
    vi.mocked(selectMultipleOptions).mockResolvedValueOnce(['0']);
    mockConfirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { approve = resolve; }));

    const operation = deleteSelectedTasks(tasks);
    try {
      await vi.waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(fs.existsSync(marker)).toBe(true);
      if (claim) {
        runner.requeueFailedTask('merge-pr-123');
        expect(runner.claimNextTasks(1)).toMatchObject([{ name: 'merge-pr-123', worktreePath }]);
      }
    } finally {
      approve(true);
    }
    expect(await operation).toBe(!claim);

    expect(fs.existsSync(marker)).toBe(claim);
    expect(runner.listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual(
      claim ? [{ name: 'merge-pr-123', kind: 'running' }] : [],
    );
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(`Deleted ${claim ? 0 : 1} of 1 tasks.`);
    expect(mockLogError).toHaveBeenCalledTimes(claim ? 1 : 0);
  });
});
