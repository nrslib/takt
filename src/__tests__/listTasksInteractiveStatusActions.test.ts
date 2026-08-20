import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockHeader,
  mockInfo,
  mockBlankLine,
  mockListAllTaskItems,
  mockDeleteTask,
  mockShowDiffAndPromptActionForTask,
  mockMergeBranch,
  mockDeleteCompletedTask,
  mockRequeueExceededTask,
  mockForceFailRunningTask,
  mockRetryFailedTask,
  mockRequeueFailedTask,
  mockInstructBranch,
  mockCreatePullRequestForTask,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockBlankLine: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockDeleteTask: vi.fn(),
  mockShowDiffAndPromptActionForTask: vi.fn(),
  mockMergeBranch: vi.fn(),
  mockDeleteCompletedTask: vi.fn(),
  mockRequeueExceededTask: vi.fn(),
  mockForceFailRunningTask: vi.fn(),
  mockRetryFailedTask: vi.fn(),
  mockRequeueFailedTask: vi.fn(),
  mockInstructBranch: vi.fn(),
  mockCreatePullRequestForTask: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    listAllTaskItems() {
      return mockListAllTaskItems();
    }
    deleteTask(name: string, kind: string) {
      mockDeleteTask(name, kind);
    }
    requeueExceededTask(name: string) {
      mockRequeueExceededTask(name);
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
  instructBranch: mockInstructBranch,
  createPullRequestForTask: mockCreatePullRequestForTask,
}));

vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({
  deleteTaskByKind: mockDeleteCompletedTask,
  deleteAllTasks: vi.fn(),
}));

vi.mock('../features/tasks/list/taskRetryActions.js', () => ({
  retryFailedTask: mockRetryFailedTask,
  requeueFailedTask: mockRequeueFailedTask,
}));

vi.mock('../features/tasks/list/taskForceFailActions.js', () => ({
  forceFailRunningTask: mockForceFailRunningTask,
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

const exceededTask: TaskListItem = {
  kind: 'exceeded',
  name: 'exceeded-task',
  createdAt: '2026-02-14T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'iteration limit reached',
  exceededMaxSteps: 60,
  exceededCurrentIteration: 30,
};

const failedTask: TaskListItem = {
  kind: 'failed',
  name: 'failed-task',
  createdAt: '2026-02-14T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'failed content',
  branch: 'takt/failed-task',
  worktreePath: '/project/.takt/worktrees/failed-task',
  data: { task: 'failed content', workflow: 'default' },
  failure: { step: 'review', error: 'Boom' },
};

const failedTaskWithoutBranch: TaskListItem = {
  ...failedTask,
  name: 'failed-without-branch',
  branch: undefined,
};

describe('listTasks interactive status actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('running タスクで mark as failed 選択時は forceFailRunningTask を呼ぶ', async () => {
    mockListAllTaskItems.mockReturnValue([runningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockHeader).toHaveBeenCalledWith('[running] running-task');
    expect(mockSelectOption.mock.calls[1]?.[1]).toEqual([
      {
        label: 'Mark as failed',
        value: 'force_fail',
        description: 'Mark stuck running task as failed',
      },
    ]);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith(runningTask, '/project');
  });

  it('running タスクでキャンセル時は forceFailRunningTask を呼ばない', async () => {
    mockListAllTaskItems.mockReturnValue([runningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockSelectOption.mock.calls[1]?.[1]).toEqual([
      {
        label: 'Mark as failed',
        value: 'force_fail',
        description: 'Mark stuck running task as failed',
      },
    ]);
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
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
    expect(mockDeleteTask).toHaveBeenCalledWith('completed-task', 'completed');
  });

  it('completed delete 選択時は deleteCompletedTask を呼ぶ', async () => {
    mockListAllTaskItems.mockReturnValue([completedTaskWithBranch]);
    mockShowDiffAndPromptActionForTask.mockResolvedValueOnce('delete');
    mockSelectOption
      .mockResolvedValueOnce('completed:0')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockDeleteCompletedTask).toHaveBeenCalledWith(completedTaskWithBranch);
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  describe('exceeded status action handling', () => {
    it('exceeded requeue 選択時は requeueExceededTask を呼ぶ', async () => {
      mockListAllTaskItems.mockReturnValue([exceededTask]);
      mockSelectOption
        .mockResolvedValueOnce('exceeded:0')
        .mockResolvedValueOnce('requeue')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockRequeueExceededTask).toHaveBeenCalledWith('exceeded-task');
      expect(mockDeleteCompletedTask).not.toHaveBeenCalled();
    });

    it('exceeded delete 選択時は deleteTaskByKind を呼ぶ', async () => {
      mockListAllTaskItems.mockReturnValue([exceededTask]);
      mockSelectOption
        .mockResolvedValueOnce('exceeded:0')
        .mockResolvedValueOnce('delete')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockDeleteCompletedTask).toHaveBeenCalledWith(exceededTask);
      expect(mockRequeueExceededTask).not.toHaveBeenCalled();
    });

    it('exceeded でキャンセル選択時は何も呼ばれない', async () => {
      mockListAllTaskItems.mockReturnValue([exceededTask]);
      mockSelectOption
        .mockResolvedValueOnce('exceeded:0')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockRequeueExceededTask).not.toHaveBeenCalled();
      expect(mockDeleteCompletedTask).not.toHaveBeenCalled();
    });
  });

  describe('failed status action handling', () => {
    it('failed タスクのアクションに Instruct を表示しない', async () => {
      mockListAllTaskItems.mockReturnValue([failedTask]);
      mockSelectOption
        .mockResolvedValueOnce('failed:0')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockSelectOption.mock.calls[1]?.[1]).toEqual([
        expect.objectContaining({
          label: 'Requeue',
          value: 'requeue',
          description: expect.stringContaining('without conversation'),
        }),
        expect.objectContaining({
          label: 'Retry',
          value: 'retry',
          description: expect.stringContaining('conversation'),
        }),
        expect.objectContaining({
          label: 'Create PR',
          value: 'create_pr',
        }),
        expect.objectContaining({
          label: 'Delete',
          value: 'delete',
          description: 'Remove this task permanently',
        }),
      ]);
    });

    it('failed requeue 選択時は requeueFailedTask を呼ぶ', async () => {
      mockListAllTaskItems.mockReturnValue([failedTask]);
      mockSelectOption
        .mockResolvedValueOnce('failed:0')
        .mockResolvedValueOnce('requeue')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockRequeueFailedTask).toHaveBeenCalledWith(failedTask, '/project');
      expect(mockRetryFailedTask).not.toHaveBeenCalled();
      expect(mockDeleteCompletedTask).not.toHaveBeenCalled();
    });

    it('failed retry 選択時は retryFailedTask を呼ぶ', async () => {
      mockListAllTaskItems.mockReturnValue([failedTask]);
      mockSelectOption
        .mockResolvedValueOnce('failed:0')
        .mockResolvedValueOnce('retry')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockRetryFailedTask).toHaveBeenCalledWith(failedTask, '/project', undefined);
      expect(mockRequeueFailedTask).not.toHaveBeenCalled();
    });

    it('failed action に Instruct が返っても instructBranch を呼ばない', async () => {
      mockListAllTaskItems.mockReturnValue([failedTask]);
      mockSelectOption
        .mockResolvedValueOnce('failed:0')
        .mockResolvedValueOnce('instruct')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockInstructBranch).not.toHaveBeenCalled();
      expect(mockCreatePullRequestForTask).not.toHaveBeenCalled();
    });

    it('failed action に Instruct が返っても branch 検証をしない', async () => {
      mockListAllTaskItems.mockReturnValue([failedTaskWithoutBranch]);
      mockSelectOption
        .mockResolvedValueOnce('failed:0')
        .mockResolvedValueOnce('instruct')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockInstructBranch).not.toHaveBeenCalled();
      expect(mockCreatePullRequestForTask).not.toHaveBeenCalled();
    });

    it('failed PR 作成選択時は新しい PR action を呼ぶ', async () => {
      mockListAllTaskItems.mockReturnValue([failedTask]);
      mockSelectOption
        .mockResolvedValueOnce('failed:0')
        .mockResolvedValueOnce('create_pr')
        .mockResolvedValueOnce(null);

      await listTasks('/project');

      expect(mockCreatePullRequestForTask).toHaveBeenCalledWith('/project', failedTask);
      expect(mockInstructBranch).not.toHaveBeenCalled();
    });
  });

  it('completed PR 作成選択時も同じ PR action を呼ぶ', async () => {
    mockListAllTaskItems.mockReturnValue([completedTaskWithBranch]);
    mockShowDiffAndPromptActionForTask.mockResolvedValueOnce('create_pr');
    mockSelectOption
      .mockResolvedValueOnce('completed:0')
      .mockResolvedValueOnce(null);

    await listTasks('/project');

    expect(mockCreatePullRequestForTask).toHaveBeenCalledWith('/project', completedTaskWithBranch);
  });
});
