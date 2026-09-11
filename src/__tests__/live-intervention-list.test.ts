import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockListAllTaskItems,
  mockForceFailRunningTask,
  mockRunTui,
  mockListTasksNonInteractive,
  mockResolveConfigValues,
  mockSelectAndExecuteTask,
  mockCreateIssueAndSaveTask,
  mockPromptLabelSelection,
  mockSaveTaskFromInteractive,
  mockInfo,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockListAllTaskItems: vi.fn(),
  mockForceFailRunningTask: vi.fn(),
  mockRunTui: vi.fn(),
  mockListTasksNonInteractive: vi.fn(),
  mockResolveConfigValues: vi.fn(),
  mockSelectAndExecuteTask: vi.fn(),
  mockCreateIssueAndSaveTask: vi.fn(),
  mockPromptLabelSelection: vi.fn(),
  mockSaveTaskFromInteractive: vi.fn(),
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

vi.mock('../features/tui/runTui.js', () => ({
  runTui: mockRunTui,
}));

vi.mock('../features/tui/index.js', () => ({
  runTui: mockRunTui,
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  createIssueAndSaveTask: (...args: unknown[]) => mockCreateIssueAndSaveTask(...args),
  promptLabelSelection: (...args: unknown[]) => mockPromptLabelSelection(...args),
  saveTaskFromInteractive: (...args: unknown[]) => mockSaveTaskFromInteractive(...args),
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

describe('running task-list conversation entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectOption.mockResolvedValue(null);
  mockRunTui.mockResolvedValue({ kind: 'cancelled' });
  mockListTasksNonInteractive.mockResolvedValue(undefined);
  mockResolveConfigValues.mockReturnValue({ language: 'ja', interactivePreviewSteps: 3 });
  mockSelectAndExecuteTask.mockResolvedValue(undefined);
  mockCreateIssueAndSaveTask.mockResolvedValue(undefined);
  mockPromptLabelSelection.mockResolvedValue(['enhancement']);
  mockSaveTaskFromInteractive.mockResolvedValue(undefined);
  });

  it('opens the normal TUI with the selected running task as initial context', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption.mockResolvedValueOnce('running:0').mockResolvedValueOnce('interactive');

    await listTasks('/project');

    expect(mockRunTui).toHaveBeenCalledTimes(1);
    expect(mockRunTui).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/project',
      lang: 'ja',
      previewCount: 3,
      userMessage: eligibleRunningTask.content,
      initialTellRunSlug: eligibleRunningTask.runSlug,
      initialTaskContext: {
        name: eligibleRunningTask.name,
        summary: eligibleRunningTask.content,
        runSlug: eligibleRunningTask.runSlug,
      },
    }));
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
  });

  it.each(['execute', 'save_task', 'create_issue', 'cancel'] as const)(
    'dispatches the TUI %s result to the matching list operation',
    async (action) => {
    const result = {
      action,
      task: 'confirmed task',
      ...(action === 'execute' ? { interactiveMetadata: { confirmed: true, task: 'confirmed task' } } : {}),
      ...(action === 'execute' ? { attachments: [{ placeholder: '{{image:1}}', path: '/tmp/image.png' }] } : {}),
    } as never;
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('interactive')
      .mockResolvedValueOnce(null);
    mockRunTui.mockImplementationOnce(async (input: { dispatch?: (workflow: string, value: typeof result) => Promise<void> }) => {
      await input.dispatch?.('selected-workflow', result);
      return { kind: 'selected' };
    });

    await listTasks('/project');

    if (action === 'execute') {
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith('/project', 'confirmed task', expect.objectContaining({
        workflow: 'selected-workflow',
        interactiveUserInput: true,
        interactiveMetadata: { confirmed: true, task: 'confirmed task' },
        skipTaskList: true,
        failureMode: 'return',
        attachments: [{ placeholder: '{{image:1}}', path: '/tmp/image.png' }],
      }), undefined);
    } else if (action === 'save_task') {
      expect(mockSaveTaskFromInteractive).toHaveBeenCalledWith('/project', 'confirmed task', 'selected-workflow', {});
    } else if (action === 'create_issue') {
      expect(mockPromptLabelSelection).toHaveBeenCalledWith('ja');
      expect(mockCreateIssueAndSaveTask).toHaveBeenCalledWith('/project', 'confirmed task', 'selected-workflow', {
        labels: ['enhancement'],
      });
    } else {
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
      expect(mockSaveTaskFromInteractive).not.toHaveBeenCalled();
      expect(mockCreateIssueAndSaveTask).not.toHaveBeenCalled();
    }
    },
  );

  it('keeps force-fail for a running task without clone identity', async () => {
    mockListAllTaskItems.mockReturnValue([runningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockRunTui).not.toHaveBeenCalled();
    expect(mockForceFailRunningTask).toHaveBeenCalledWith(runningTask, '/project');
  });

  it('offers force-fail when the normal TUI cannot be opened', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockRunTui.mockRejectedValueOnce(new Error('Run is no longer running'));
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('interactive')
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockForceFailRunningTask).toHaveBeenCalledWith(eligibleRunningTask, '/project');
    expect(mockInfo).toHaveBeenCalledWith('Run is no longer running');
    expect(mockSelectOption).toHaveBeenCalledTimes(5);
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
    expect(mockRunTui).not.toHaveBeenCalled();
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
    expect(mockRunTui).not.toHaveBeenCalled();
    expect(mockForceFailRunningTask).toHaveBeenCalledWith(task, '/project');
  });

  it('keeps force-fail available without opening an eligible live run', async () => {
    mockListAllTaskItems.mockReturnValue([eligibleRunningTask]);
    mockSelectOption
      .mockResolvedValueOnce('running:0')
      .mockResolvedValueOnce('force_fail');

    await listTasks('/project');

    expect(mockForceFailRunningTask).toHaveBeenCalledWith(eligibleRunningTask, '/project');
    expect(mockRunTui).not.toHaveBeenCalled();
  });

  it('keeps the non-interactive list path out of live intervention', async () => {
    await listTasks('/project', undefined, { enabled: true, format: 'json' });

    expect(mockListTasksNonInteractive).toHaveBeenCalledWith('/project', {
      enabled: true,
      format: 'json',
    });
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockRunTui).not.toHaveBeenCalled();
  });
});
