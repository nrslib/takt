import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDeleteCompletedTask,
  mockListAllTaskItems,
  mockMergeBranch,
  mockDeleteBranch,
  mockInfo,
} = vi.hoisted(() => ({
  mockDeleteCompletedTask: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockMergeBranch: vi.fn(),
  mockDeleteBranch: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  TaskRunner: class {
    listAllTaskItems() {
      return mockListAllTaskItems();
    }
    deleteCompletedTask(name: string) {
      mockDeleteCompletedTask(name);
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
    expect(mockDeleteCompletedTask).toHaveBeenCalledWith('completed-task');
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
    expect(mockDeleteCompletedTask).toHaveBeenCalledWith('completed-task');
  });
});
