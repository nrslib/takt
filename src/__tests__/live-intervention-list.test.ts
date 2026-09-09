import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockListAllTaskItems,
  mockForceFailRunningTask,
  mockRunLiveInterventionMode,
  mockListTasksNonInteractive,
  mockInfo,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockForceFailRunningTask: vi.fn(),
  mockRunLiveInterventionMode: vi.fn(),
  mockListTasksNonInteractive: vi.fn(),
  mockInfo: vi.fn(),
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
}));

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

  it('shows the running task actions and returns to the list on cancellation', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption.mockResolvedValueOnce('running:0');

    await listTasks('/project');

    expect(mockSelectOption.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ label: 'Mark as failed', value: 'force_fail' }),
      expect.objectContaining({ label: 'Interactive', value: 'interactive' }),
    ]);
    expect(mockSelectOption.mock.calls[2]?.[0]).toBe('List Tasks');
    expect(mockRunLiveInterventionMode).not.toHaveBeenCalled();
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
  });

  it('opens live intervention only after Interactive is selected and returns to the list', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('interactive');

    await listTasks('/project');

    expect(mockRunLiveInterventionMode).toHaveBeenCalledTimes(1);
    expect(mockRunLiveInterventionMode.mock.calls[0]?.slice(0, 2)).toEqual([
      '/project',
      eligibleRunningTask,
    ]);
    expect(mockSelectOption.mock.calls[2]?.[0]).toBe('List Tasks');
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
  });

  it.each([
    runningTask,
    { ...runningTask, runSlug: eligibleRunningTask.runSlug },
    { ...runningTask, worktreePath: eligibleRunningTask.worktreePath },
  ])('keeps only force-fail when live-run metadata is incomplete: %j', async (task) => {
    mockListAllTaskItems.mockReturnValue([task]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockSelectOption.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ value: 'force_fail' }),
    ]);
    expect(mockRunLiveInterventionMode).not.toHaveBeenCalled();
    expect(mockForceFailRunningTask).toHaveBeenCalledWith(task, '/project');
  });

  it('keeps force-fail available without opening an eligible live run', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockForceFailRunningTask).toHaveBeenCalledWith(eligibleRunningTask, '/project');
    expect(mockRunLiveInterventionMode).not.toHaveBeenCalled();
  });

  it('reports an unavailable live run and preserves recovery actions', async () => {
    const message = 'Run is no longer running';
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockRunLiveInterventionMode.mockRejectedValueOnce(new Error(message));
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('interactive')
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockInfo).toHaveBeenCalledWith(message);
    expect(mockRunLiveInterventionMode).toHaveBeenCalledTimes(1);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith(eligibleRunningTask, '/project');
    expect(mockSelectOption.mock.calls[2]?.[0]).toBe('List Tasks');
  });

  it('refreshes the list when the selected live run disappears before it can be opened', async () => {
    mockListAllTaskItems.mockReturnValueOnce([eligibleRunningTask]).mockReturnValue([]);
    mockRunLiveInterventionMode.mockRejectedValueOnce(new Error('Run no longer exists'));
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('interactive');

    await listTasks('/project');

    expect(mockRunLiveInterventionMode).toHaveBeenCalledTimes(1);
    expect(mockListAllTaskItems).toHaveBeenCalledTimes(2);
    expect(mockSelectOption).toHaveBeenCalledTimes(2);
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
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
