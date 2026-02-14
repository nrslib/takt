import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
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

import { confirm } from '../shared/prompt/index.js';
import { success, error as logError } from '../shared/ui/index.js';
import { deletePendingTask, deleteFailedTask, deleteCompletedTask } from '../features/tasks/list/taskDeleteActions.js';
import type { TaskListItem } from '../infra/task/types.js';

const mockConfirm = vi.mocked(confirm);
const mockSuccess = vi.mocked(success);
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
    ],
  }), 'utf-8');
  return tasksFile;
}

beforeEach(() => {
  vi.clearAllMocks();
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

    const result = await deletePendingTask(task);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('pending-task');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted pending task: pending-task');
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

    const result = await deleteFailedTask(task);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('failed-task');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted failed task: failed-task');
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

    const result = await deleteFailedTask(task);

    expect(result).toBe(true);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('failed-task');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted failed task: failed-task');
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

    const result = await deleteFailedTask(task);

    expect(result).toBe(false);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).toContain('failed-task');
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

    const result = await deleteFailedTask(task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
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

    const result = await deleteCompletedTask(task);

    expect(result).toBe(true);
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, task);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('completed-task');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted completed task: completed-task');
  });
});
