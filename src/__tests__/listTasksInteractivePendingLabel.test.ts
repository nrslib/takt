import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockHeader,
  mockInfo,
  mockBlankLine,
  mockListAllTaskItems,
  mockDeletePendingTask,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockBlankLine: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockDeletePendingTask: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    listAllTaskItems() {
      return mockListAllTaskItems();
    }
  },
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
}));

vi.mock('../shared/ui/index.js', () => ({
  info: mockInfo,
  header: mockHeader,
  blankLine: mockBlankLine,
}));

vi.mock('../features/tasks/list/taskActions.js', () => ({
  showFullDiff: vi.fn(),
  showDiffAndPromptActionForTask: vi.fn(),
  tryMergeBranch: vi.fn(),
  mergeBranch: vi.fn(),
  deleteBranch: vi.fn(),
  instructBranch: vi.fn(),
}));

vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({
  deletePendingTask: mockDeletePendingTask,
  deleteFailedTask: vi.fn(),
  deleteCompletedTask: vi.fn(),
}));

vi.mock('../features/tasks/list/taskRetryActions.js', () => ({
  retryFailedTask: vi.fn(),
}));

import { listTasks } from '../features/tasks/list/index.js';

describe('listTasks interactive pending label regression', () => {
  const pendingTask: TaskListItem = {
    kind: 'pending',
    name: 'my-task',
    createdAt: '2026-02-09T00:00:00',
    filePath: '/tmp/my-task.md',
    content: 'Fix running status label',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllTaskItems.mockReturnValue([pendingTask]);
  });

  it('should show [pending] in interactive menu for pending tasks', async () => {
    mockSelectOption.mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockSelectOption).toHaveBeenCalledTimes(1);
    const menuOptions = mockSelectOption.mock.calls[0]![1] as Array<{ label: string; value: string }>;
    expect(menuOptions).toContainEqual(expect.objectContaining({ label: '[pending] my-task', value: 'pending:0' }));
    expect(menuOptions.some((opt) => opt.label.includes('[running]'))).toBe(false);
    expect(menuOptions.some((opt) => opt.label.includes('[pendig]'))).toBe(false);
  });

  it('should show [pending] header when pending task is selected', async () => {
    mockSelectOption
      .mockResolvedValueOnce('pending:0')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockHeader).toHaveBeenCalledWith('[pending] my-task');
    const headerTexts = mockHeader.mock.calls.map(([text]) => String(text));
    expect(headerTexts.some((text) => text.includes('[running]'))).toBe(false);
    expect(headerTexts.some((text) => text.includes('[pendig]'))).toBe(false);
  });
});
