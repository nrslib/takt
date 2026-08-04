import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDeleteTask,
  mockListAllTaskItems,
  mockMergeBranch,
  mockDeleteBranch,
  mockSyncBranchWithRoot,
  mockInfo,
} = vi.hoisted(() => ({
  mockDeleteTask: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockMergeBranch: vi.fn(),
  mockDeleteBranch: vi.fn(),
  mockSyncBranchWithRoot: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  TaskRunner: class {
    listAllTaskItems() {
      return mockListAllTaskItems();
    }
    deleteTask(name: string, kind: string) {
      mockDeleteTask(name, kind);
    }
  },
}));

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
}));

vi.mock('../features/tasks/list/taskActions.js', () => ({
  tryMergeBranch: vi.fn(),
  mergeBranch: (...args: unknown[]) => mockMergeBranch(...args),
  deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
  showDiffStatForTask: vi.fn(),
  syncBranchWithRoot: (...args: unknown[]) => mockSyncBranchWithRoot(...args),
}));

import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';

describe('listTasksNonInteractive completed actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllTaskItems.mockReturnValue([
      {
        kind: 'completed',
        name: 'completed-task',
        createdAt: '2026-02-14T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'done',
        branch: 'takt/completed-task',
      },
    ]);
  });

  it('should delete completed record after merge action', async () => {
    mockMergeBranch.mockReturnValue(true);

    await listTasksNonInteractive('/project', {
      enabled: true,
      action: 'merge',
      branch: 'takt/completed-task',
      yes: true,
    });

    expect(mockMergeBranch).toHaveBeenCalled();
    expect(mockDeleteTask).toHaveBeenCalledWith('completed-task', 'completed');
  });

  it('should delete completed record after delete action', async () => {
    mockDeleteBranch.mockReturnValue(true);

    await listTasksNonInteractive('/project', {
      enabled: true,
      action: 'delete',
      branch: 'takt/completed-task',
      yes: true,
    });

    expect(mockDeleteBranch).toHaveBeenCalled();
    expect(mockDeleteTask).toHaveBeenCalledWith('completed-task', 'completed');
  });

  it('should run sync action through syncBranchWithRoot', async () => {
    mockSyncBranchWithRoot.mockResolvedValue(true);

    await listTasksNonInteractive('/project', {
      enabled: true,
      action: 'sync',
      branch: 'takt/completed-task',
    });

    expect(mockSyncBranchWithRoot).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ branch: 'takt/completed-task' }),
    );
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('should exit non-zero when sync reports failure, keeping the task record', async () => {
    mockSyncBranchWithRoot.mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(listTasksNonInteractive('/project', {
      enabled: true,
      action: 'sync',
      branch: 'takt/completed-task',
    })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDeleteTask).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('should reject an unknown action listing the allowed set', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(listTasksNonInteractive('/project', {
      enabled: true,
      action: 'rebase',
      branch: 'takt/completed-task',
    })).rejects.toThrow('exit');

    expect(mockInfo).toHaveBeenCalledWith('Invalid --action. Use one of: diff, sync, try, merge, delete.');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
