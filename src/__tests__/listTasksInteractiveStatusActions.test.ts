import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockHeader,
  mockInfo,
  mockBlankLine,
  mockListAllTaskItems,
  mockDeleteCompletedRecord,
  mockShowDiffAndPromptActionForTask,
  mockMergeBranch,
  mockDeleteCompletedTask,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockBlankLine: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockDeleteCompletedRecord: vi.fn(),
  mockShowDiffAndPromptActionForTask: vi.fn(),
  mockMergeBranch: vi.fn(),
  mockDeleteCompletedTask: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    listAllTaskItems() {
      return mockListAllTaskItems();
    }
    deleteCompletedTask(name: string) {
      mockDeleteCompletedRecord(name);
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
  showDiffAndPromptActionForTask: mockShowDiffAndPromptActionForTask,
  tryMergeBranch: vi.fn(),
  mergeBranch: mockMergeBranch,
  deleteBranch: vi.fn(),
  instructBranch: vi.fn(),
}));

vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({
  deletePendingTask: vi.fn(),
  deleteFailedTask: vi.fn(),
  deleteCompletedTask: mockDeleteCompletedTask,
}));

vi.mock('../features/tasks/list/taskRetryActions.js', () => ({
  retryFailedTask: vi.fn(),
}));

import { listTasks } from '../features/tasks/list/index.js';

const runningTask: TaskListItem = {
  kind: 'running',
  name: 'running-task',
  createdAt: '2026-02-14T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'in progress',
};

const completedTaskWithBranch: TaskListItem = {
  kind: 'completed',
  name: 'completed-task',
  createdAt: '2026-02-14T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'done',
  branch: 'takt/completed-task',
};

const completedTaskWithoutBranch: TaskListItem = {
  ...completedTaskWithBranch,
  branch: undefined,
  name: 'completed-without-branch',
};

describe('listTasks interactive status actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('running タスク選択時は read-only メッセージを表示する', async () => {
    mockListAllTaskItems.mockReturnValue([runningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockHeader).toHaveBeenCalledWith('[running] running-task');
    expect(mockInfo).toHaveBeenCalledWith('Running task is read-only.');
    expect(mockShowDiffAndPromptActionForTask).not.toHaveBeenCalled();
  });

  it('completed タスクで branch が無い場合はアクションに進まない', async () => {
    mockListAllTaskItems.mockReturnValue([completedTaskWithoutBranch]);
    mockSelectOption
      .mockResolvedValueOnce('completed:0')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockInfo).toHaveBeenCalledWith('Branch is missing for completed task: completed-without-branch');
    expect(mockShowDiffAndPromptActionForTask).not.toHaveBeenCalled();
  });

  it('completed merge 成功時は tasks.yaml から completed レコードを削除する', async () => {
    mockListAllTaskItems.mockReturnValue([completedTaskWithBranch]);
    mockShowDiffAndPromptActionForTask.mockResolvedValueOnce('merge');
    mockMergeBranch.mockReturnValue(true);
    mockSelectOption
      .mockResolvedValueOnce('completed:0')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockMergeBranch).toHaveBeenCalledWith('/project', completedTaskWithBranch);
    expect(mockDeleteCompletedRecord).toHaveBeenCalledWith('completed-task');
  });

  it('completed delete 選択時は deleteCompletedTask を呼ぶ', async () => {
    mockListAllTaskItems.mockReturnValue([completedTaskWithBranch]);
    mockShowDiffAndPromptActionForTask.mockResolvedValueOnce('delete');
    mockSelectOption
      .mockResolvedValueOnce('completed:0')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockDeleteCompletedTask).toHaveBeenCalledWith(completedTaskWithBranch);
    expect(mockDeleteCompletedRecord).not.toHaveBeenCalled();
  });
});
