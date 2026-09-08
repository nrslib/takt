import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockListAllTaskItems,
  mockForceFailRunningTask,
  mockRunLiveInterventionMode,
  mockListTasksNonInteractive,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockForceFailRunningTask: vi.fn(),
  mockRunLiveInterventionMode: vi.fn(),
  mockListTasksNonInteractive: vi.fn(),
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
  info: vi.fn(),
  header: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../features/tasks/list/taskActions.js', () => ({
  showFullDiff: vi.fn(),
  showDiffAndPromptActionForTask: vi.fn(),
  tryMergeBranch: vi.fn(),
  mergeBranch: vi.fn(),
  deleteBranch: vi.fn(),
  instructBranch: vi.fn(),
  createPullRequestForTask: vi.fn(),
}));

vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({
  deleteTaskByKind: vi.fn(),
  deleteAllTasks: vi.fn(),
}));

vi.mock('../features/tasks/list/taskRetryActions.js', () => ({
  retryFailedTask: vi.fn(),
  requeueFailedTask: vi.fn(),
}));

vi.mock('../features/tasks/list/taskForceFailActions.js', () => ({
  forceFailRunningTask: mockForceFailRunningTask,
}));

vi.mock('../features/tasks/list/listNonInteractive.js', () => ({
  listTasksNonInteractive: mockListTasksNonInteractive,
}));

vi.mock('../features/tasks/list/liveInterventionMode.js', () => ({
  runLiveInterventionMode: mockRunLiveInterventionMode,
}), { virtual: true });

import { listTasks } from '../features/tasks/list/index.js';

const runningTask: TaskListItem = {
  kind: 'running',
  name: 'running-task',
  createdAt: '2026-09-03T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'in progress',
};

const eligibleRunningTask: TaskListItem = {
  ...runningTask,
  runSlug: 'live-run',
  worktreePath: '/project/.takt/worktrees/running-task',
};

describe('live intervention task-list entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectOption.mockResolvedValue(null);
    mockRunLiveInterventionMode.mockResolvedValue(undefined);
    mockListTasksNonInteractive.mockResolvedValue(undefined);
  });

  it('opens live intervention for a running task with run identity and worktree', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption.mockResolvedValueOnce('running:0');

    await listTasks('/project');

    expect(mockRunLiveInterventionMode).toHaveBeenCalledTimes(1);
    expect(mockRunLiveInterventionMode.mock.calls[0]?.slice(0, 2)).toEqual([
      '/project',
      eligibleRunningTask,
    ]);
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
  });

  it('keeps force-fail for a running task without live-run identity', async () => {
    mockListAllTaskItems.mockReturnValue([runningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockRunLiveInterventionMode).not.toHaveBeenCalled();
    expect(mockForceFailRunningTask).toHaveBeenCalledWith(runningTask, '/project');
  });

  it('keeps the non-interactive list path out of live intervention', async () => {
    await listTasks('/project', undefined, { enabled: true, format: 'json' });

    expect(mockListTasksNonInteractive).toHaveBeenCalledWith('/project', {
      enabled: true,
      format: 'json',
    });
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockRunLiveInterventionMode).not.toHaveBeenCalled();
  });
});
