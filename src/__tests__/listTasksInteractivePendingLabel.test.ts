import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockHeader,
  mockInfo,
  mockBlankLine,
  mockConfirm,
  mockListPendingTaskItems,
  mockListFailedTasks,
  mockDeletePendingTask,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockBlankLine: vi.fn(),
  mockConfirm: vi.fn(),
  mockListPendingTaskItems: vi.fn(),
  mockListFailedTasks: vi.fn(),
  mockDeletePendingTask: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  listTaktBranches: vi.fn(() => []),
  buildListItems: vi.fn(() => []),
  detectDefaultBranch: vi.fn(() => 'main'),
  TaskRunner: class {
    listPendingTaskItems() {
      return mockListPendingTaskItems();
    }
    listFailedTasks() {
      return mockListFailedTasks();
    }
  },
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
  confirm: mockConfirm,
}));

vi.mock('../shared/ui/index.js', () => ({
  info: mockInfo,
  header: mockHeader,
  blankLine: mockBlankLine,
}));

vi.mock('../features/tasks/list/taskActions.js', () => ({
  showFullDiff: vi.fn(),
  showDiffAndPromptAction: vi.fn(),
  tryMergeBranch: vi.fn(),
  mergeBranch: vi.fn(),
  deleteBranch: vi.fn(),
  instructBranch: vi.fn(),
}));

vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({
  deletePendingTask: mockDeletePendingTask,
  deleteFailedTask: vi.fn(),
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
    mockListPendingTaskItems.mockReturnValue([pendingTask]);
    mockListFailedTasks.mockReturnValue([]);
  });

  it('should show [running] in interactive menu for pending tasks', async () => {
    mockSelectOption.mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockSelectOption).toHaveBeenCalledTimes(1);
    const menuOptions = mockSelectOption.mock.calls[0]![1] as Array<{ label: string; value: string }>;
    expect(menuOptions).toContainEqual(expect.objectContaining({ label: '[running] my-task', value: 'pending:0' }));
    expect(menuOptions.some((opt) => opt.label.includes('[pending]'))).toBe(false);
    expect(menuOptions.some((opt) => opt.label.includes('[pendig]'))).toBe(false);
  });

  it('should show [running] header when pending task is selected', async () => {
    mockSelectOption
      .mockResolvedValueOnce('pending:0')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockHeader).toHaveBeenCalledWith('[running] my-task');
    const headerTexts = mockHeader.mock.calls.map(([text]) => String(text));
    expect(headerTexts.some((text) => text.includes('[pending]'))).toBe(false);
    expect(headerTexts.some((text) => text.includes('[pendig]'))).toBe(false);
  });
});
