import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockDeleteTask,
  mockListAllTaskItems,
  mockMergeBranch,
  mockDeleteBranch,
  mockSyncBranchWithRoot,
  mockInfo,
  mockDeleteTaskResources,
  mockDiff,
  mockTry,
} = vi.hoisted(() => ({
  mockDeleteTask: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockMergeBranch: vi.fn(),
  mockDeleteBranch: vi.fn(),
  mockSyncBranchWithRoot: vi.fn(),
  mockInfo: vi.fn(),
  mockDeleteTaskResources: vi.fn(),
  mockDiff: vi.fn(),
  mockTry: vi.fn(),
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
  success: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockInfo(...args),
}));

vi.mock('../features/tasks/list/taskActions.js', () => ({
  tryMergeBranch: mockTry,
  mergeBranch: (...args: unknown[]) => mockMergeBranch(...args),
  deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
  showDiffStatForTask: mockDiff,
  syncBranchWithRoot: (...args: unknown[]) => mockSyncBranchWithRoot(...args),
}));

vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({
  deleteTaskResources: mockDeleteTaskResources,
}));

import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';

describe('listTasksNonInteractive completed actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDeleteTaskResources.mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
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
  afterEach(() => vi.restoreAllMocks());

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

  it('should delete completed resources through the shared deletion function', async () => {
    await listTasksNonInteractive('/project', {
      enabled: true,
      action: 'delete',
      branch: 'takt/completed-task',
      yes: true,
    });

    expect(mockDeleteTaskResources).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'completed-task', filePath: '/project/.takt/tasks.yaml' }),
      { quiet: true },
    );
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('uses the shared selection result as the input to shared execution', async () => {
    const selection = await import('../features/tasks/list/taskDeleteSelection.js');
    const execution = await import('../features/tasks/list/taskDeleteExecution.js');
    const select = vi.spyOn(selection, 'selectTasksForDeletion');
    const execute = vi.spyOn(execution, 'executeTaskDeletion');

    await listTasksNonInteractive('/project', {
      enabled: true, action: 'delete', branch: 'takt/completed-task', yes: true,
    });

    expect(select).toHaveBeenCalledExactlyOnceWith(mockListAllTaskItems.mock.results[0]?.value,
      expect.objectContaining({ branch: 'takt/completed-task' }));
    expect(execute).toHaveBeenCalledExactlyOnceWith(select.mock.results[0]?.value);
  });

  it('previews a branch deletion with name, state, branch, and goal without deleting', async () => {
    mockListAllTaskItems.mockReturnValue([{
      kind: 'completed', name: 'preview-task', content: 'done', createdAt: '2026-02-14T00:00:00Z',
      filePath: '/project/.takt/tasks.yaml', branch: 'feature/preview', goalId: '550e8400-e29b-41d4-a716-446655440000',
    }]);

    await expect(listTasksNonInteractive('/project', {
      enabled: true, action: 'delete', branch: 'feature/preview',
    })).resolves.toBeUndefined();

    const output = mockInfo.mock.calls.map(([message]) => String(message)).join('\n');
    for (const value of ['preview-task', 'completed', 'feature/preview', '550e8400-e29b-41d4-a716-446655440000']) {
      expect(output).toContain(value);
    }
    expect(process.exit).not.toHaveBeenCalled();
    expect(mockDeleteTaskResources).not.toHaveBeenCalled();
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it.each([
    { empty: true, yes: true }, { empty: true, yes: false },
    { empty: false, yes: true }, { empty: false, yes: false },
  ])('rejects unfiltered deletion with empty=$empty and yes=$yes', async ({ empty, yes }) => {
    if (empty) mockListAllTaskItems.mockReturnValue([]);

    await expect(listTasksNonInteractive('/project', { enabled: true, action: 'delete', yes }))
      .rejects.toThrow('exit');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockDeleteTaskResources).not.toHaveBeenCalled();
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('deletes only matching stopped tasks using multiple statuses and a goal', async () => {
    const goal = '550e8400-e29b-41d4-a716-446655440000';
    const tasks = ['pending', 'completed', 'failed', 'exceeded', 'pr_failed', 'running'].map((kind) => ({
      kind, name: `${kind}-task`, createdAt: '2026-02-14T00:00:00Z', filePath: '/owner/.takt/tasks.yaml',
      content: kind, goalId: goal,
    }));
    mockListAllTaskItems.mockReturnValue([...tasks,
      { ...tasks[0], name: 'other-goal', goalId: '550e8400-e29b-41d4-a716-446655440001' },
      { ...tasks[0], name: 'no-goal', goalId: undefined }]);

    await listTasksNonInteractive('/project', {
      enabled: true, action: 'delete', yes: true,
      status: ['pending', 'failed', 'exceeded', 'pr_failed'], goal,
    });

    expect(mockDeleteTaskResources.mock.calls.map(([target]) => (target as TaskListItem).name))
      .toEqual(['pending-task', 'failed-task', 'exceeded-task', 'pr_failed-task']);
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('exits non-zero on deletion failure and still processes the remaining targets', async () => {
    mockListAllTaskItems.mockReturnValue(['first', 'second', 'third'].map((name) => ({
      kind: 'completed', name, content: name, createdAt: '2026-02-14T00:00:00Z',
      filePath: '/project/.takt/tasks.yaml', branch: 'feature/shared',
    })));
    mockDeleteTaskResources.mockReturnValueOnce(false)
      .mockImplementationOnce(() => { throw new Error('cleanup failed'); });

    await expect(listTasksNonInteractive('/project', {
      enabled: true, action: 'delete', branch: 'feature/shared', yes: true,
    })).rejects.toThrow('exit');

    expect(mockDeleteTaskResources.mock.calls.map(([target]) => (target as TaskListItem).name))
      .toEqual(['first', 'second', 'third']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it.each(['diff', 'sync', 'try', 'merge'])('keeps --branch mandatory for %s', async (action) => {
    await expect(listTasksNonInteractive('/project', { enabled: true, action })).rejects.toThrow('exit');
    expect(process.exit).toHaveBeenCalledWith(1);
    for (const operation of [mockDiff, mockSyncBranchWithRoot, mockTry, mockMergeBranch]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it.each(['diff', 'try'])('keeps the completed branch target for %s', async (action) => {
    await listTasksNonInteractive('/project', { enabled: true, action, branch: 'takt/completed-task' });
    expect(action === 'diff' ? mockDiff : mockTry).toHaveBeenCalledExactlyOnceWith(
      '/project', expect.objectContaining({ name: 'completed-task', kind: 'completed' }),
    );
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it.each(['diff', 'sync', 'try', 'merge'])('keeps failed tasks outside the %s branch lookup', async (action) => {
    mockListAllTaskItems.mockReturnValue([{
      kind: 'failed', name: 'failed-task', branch: 'feature/failed', content: 'failed',
      filePath: '/project/.takt/tasks.yaml', createdAt: '2026-02-14T00:00:00Z',
    }]);
    await expect(listTasksNonInteractive('/project', {
      enabled: true, action, branch: 'feature/failed', status: ['failed'],
    })).rejects.toThrow('exit');
    for (const operation of [mockDiff, mockSyncBranchWithRoot, mockTry, mockMergeBranch]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('keeps the completed record when merge fails', async () => {
    mockMergeBranch.mockReturnValue(false);
    await listTasksNonInteractive('/project', { enabled: true, action: 'merge', branch: 'takt/completed-task' });
    expect(mockMergeBranch).toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();
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

    try {
      await expect(listTasksNonInteractive('/project', {
        enabled: true,
        action: 'sync',
        branch: 'takt/completed-task',
      })).rejects.toThrow('exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockDeleteTask).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should reject an unknown action listing the allowed set', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await expect(listTasksNonInteractive('/project', {
        enabled: true,
        action: 'rebase',
        branch: 'takt/completed-task',
      })).rejects.toThrow('exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
