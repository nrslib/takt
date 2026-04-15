import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExistsSync,
  mockStartReExecution,
  mockRequeueTask,
  mockExecuteAndCompleteTask,
  mockRunInstructMode,
  mockDispatchConversationAction,
  mockSelectWorkflow,
  mockConfirm,
  mockGetLabel,
  mockResolveLanguage,
  mockListRecentRuns,
  mockSelectRun,
  mockLoadRunSessionContext,
  mockFindRunForTask,
  mockFindPreviousOrderContent,
  mockWarn,
  mockIsWorkflowPath,
  mockLoadAllStandaloneWorkflowsWithSources,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockStartReExecution: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockRunInstructMode: vi.fn(),
  mockDispatchConversationAction: vi.fn(),
  mockSelectWorkflow: vi.fn(),
  mockConfirm: vi.fn(),
  mockGetLabel: vi.fn(),
  mockResolveLanguage: vi.fn(() => 'en'),
  mockListRecentRuns: vi.fn(() => []),
  mockSelectRun: vi.fn(() => null),
  mockLoadRunSessionContext: vi.fn(),
  mockFindRunForTask: vi.fn(() => null),
  mockFindPreviousOrderContent: vi.fn(() => null),
  mockWarn: vi.fn(),
  mockIsWorkflowPath: vi.fn(() => false),
  mockLoadAllStandaloneWorkflowsWithSources: vi.fn(() => new Map<string, unknown>([
    ['default', {}],
    ['selected-workflow', {}],
  ])),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  TaskRunner: class {
    startReExecution(...args: unknown[]) {
      return mockStartReExecution(...args);
    }
    requeueTask(...args: unknown[]) {
      return mockRequeueTask(...args);
    }
  },
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValues: vi.fn(() => ({ interactivePreviewSteps: 3, language: 'en' })),
  getWorkflowDescription: vi.fn(() => ({
    name: 'default',
    description: 'desc',
    workflowStructure: [],
    stepPreviews: [],
  })),
  isWorkflowPath: (...args: unknown[]) => mockIsWorkflowPath(...args),
  loadAllStandaloneWorkflowsWithSources: (...args: unknown[]) => mockLoadAllStandaloneWorkflowsWithSources(...args),
}));

vi.mock('../features/tasks/list/instructMode.js', () => ({
  runInstructMode: (...args: unknown[]) => mockRunInstructMode(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: (...args: unknown[]) => mockSelectWorkflow(...args),
}));

vi.mock('../features/interactive/actionDispatcher.js', () => ({
  dispatchConversationAction: (...args: unknown[]) => mockDispatchConversationAction(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (...args: unknown[]) => mockGetLabel(...args),
}));

vi.mock('../features/interactive/index.js', () => ({
  resolveLanguage: (...args: unknown[]) => mockResolveLanguage(...args),
  listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
  selectRun: (...args: unknown[]) => mockSelectRun(...args),
  loadRunSessionContext: (...args: unknown[]) => mockLoadRunSessionContext(...args),
  findRunForTask: (...args: unknown[]) => mockFindRunForTask(...args),
  findPreviousOrderContent: (...args: unknown[]) => mockFindPreviousOrderContent(...args),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: mockWarn,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { instructBranch } from '../features/tasks/list/taskActions.js';
import { error as logError } from '../shared/ui/index.js';

const mockLogError = vi.mocked(logError);

describe('instructBranch direct execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);

    mockSelectWorkflow.mockResolvedValue('default');
    mockRunInstructMode.mockResolvedValue({ action: 'execute', task: '追加指示A' });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.execute({ task: '追加指示A' }));
    mockConfirm.mockResolvedValue(true);
    mockGetLabel.mockImplementation((key: string, _lang?: string, vars?: Record<string, string>) => {
      if (key === 'interactive.runSelector.confirm') {
        return "Reference a previous run's results?";
      }
      if (vars?.workflow) {
        return `Use previous workflow "${vars.workflow}"?`;
      }
      return key;
    });
    mockResolveLanguage.mockReturnValue('en');
    mockListRecentRuns.mockReturnValue([]);
    mockSelectRun.mockResolvedValue(null);
    mockFindRunForTask.mockReturnValue(null);
    mockFindPreviousOrderContent.mockReturnValue(null);
    mockIsWorkflowPath.mockImplementation((workflow: string) => workflow.startsWith('/') || workflow.startsWith('~') || workflow.startsWith('./') || workflow.startsWith('../') || workflow.endsWith('.yaml') || workflow.endsWith('.yml'));
    mockLoadAllStandaloneWorkflowsWithSources.mockReturnValue(new Map<string, unknown>([
      ['default', {}],
      ['selected-workflow', {}],
    ]));
    mockStartReExecution.mockReturnValue({
      name: 'done-task',
      content: 'done',
      data: { task: 'done' },
    });
    mockExecuteAndCompleteTask.mockResolvedValue(true);
  });

  it('should execute directly via startReExecution instead of requeuing', async () => {
    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', retry_note: '既存ノート' },
    });

    expect(result).toBe(true);
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      undefined,
      '既存ノート\n\n追加指示A',
    );
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should execute with selected workflow without mutating taskInfo', async () => {
    mockSelectWorkflow.mockResolvedValue('selected-workflow');
    const originalTaskInfo = {
      name: 'done-task',
      content: 'done',
      data: { task: 'done', workflow: 'original-workflow' },
    };
    mockStartReExecution.mockReturnValue(originalTaskInfo);

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    const executeArg = mockExecuteAndCompleteTask.mock.calls[0]?.[0];
    expect(executeArg).not.toBe(originalTaskInfo);
    expect(executeArg.data).not.toBe(originalTaskInfo.data);
    expect(executeArg.data.workflow).toBe('selected-workflow');
    expect(originalTaskInfo.data.workflow).toBe('original-workflow');
  });

  it('should reuse previous workflow from task data when confirmed', async () => {
    mockConfirm
      .mockResolvedValueOnce(true);

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', workflow: 'default' },
    });

    expect(mockSelectWorkflow).not.toHaveBeenCalled();
    expect(mockGetLabel).toHaveBeenCalledWith('retry.usePreviousWorkflowConfirm', 'en', { workflow: 'default' });
    const reuseConfirmCall = mockConfirm.mock.calls.find(([message]) => message === 'retry.usePreviousWorkflowConfirm');
    expect(reuseConfirmCall?.[1] ?? true).toBe(true);
  });

  it('should call selectWorkflow when previous workflow reuse is declined', async () => {
    mockConfirm
      .mockResolvedValueOnce(false);
    mockSelectWorkflow.mockResolvedValue('selected-workflow');

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', workflow: 'default' },
    });

    expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
    expect(mockStartReExecution).toHaveBeenCalled();
  });

  it('should skip reuse prompt when task data has no workflow', async () => {
    mockSelectWorkflow.mockResolvedValue('selected-workflow');

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
  });

  it('should return false when replacement workflow selection is cancelled after declining reuse', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    mockSelectWorkflow.mockResolvedValue(null);

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', workflow: 'default' },
    });

    expect(result).toBe(false);
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should set generated instruction as retry note when no existing note', async () => {
    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      undefined,
      '追加指示A',
    );
  });

  it('should run instruct mode in existing worktree', async () => {
    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockRunInstructMode).toHaveBeenCalledWith(
      '/project/.takt/worktrees/done-task',
      expect.any(String),
      'takt/done-task',
      'done-task',
      'done',
      '',
      expect.anything(),
      undefined,
      null,
    );
  });

  it('should search runs in worktree for run session context', async () => {
    mockListRecentRuns.mockReturnValue([
      { slug: 'run-1', task: 'fix', workflow: 'default', status: 'completed', startTime: '2026-02-18T00:00:00Z' },
    ]);
    mockSelectRun.mockResolvedValue('run-1');
    const runContext = { task: 'fix', workflow: 'default', status: 'completed', stepLogs: [], reports: [] };
    mockLoadRunSessionContext.mockReturnValue(runContext);

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockConfirm).toHaveBeenCalledWith("Reference a previous run's results?", false);
    // selectRunSessionContext uses worktreePath for run data
    expect(mockListRecentRuns).toHaveBeenCalledWith('/project/.takt/worktrees/done-task');
    expect(mockSelectRun).toHaveBeenCalledWith('/project/.takt/worktrees/done-task', 'en');
    expect(mockLoadRunSessionContext).toHaveBeenCalledWith('/project/.takt/worktrees/done-task', 'run-1');
    expect(mockRunInstructMode).toHaveBeenCalledWith(
      '/project/.takt/worktrees/done-task',
      expect.any(String),
      'takt/done-task',
      'done-task',
      'done',
      '',
      expect.anything(),
      runContext,
      null,
    );
  });

  it('should not warn when selected run order uses canonical provider block fields', async () => {
    mockListRecentRuns.mockReturnValue([
      { slug: 'run-1', task: 'fix', workflow: 'default', status: 'completed', startTime: '2026-02-18T00:00:00Z' },
    ]);
    mockSelectRun.mockResolvedValue('run-1');
    mockLoadRunSessionContext.mockReturnValue({
      task: 'fix',
      workflow: 'default',
      status: 'completed',
      stepLogs: [],
      reports: [],
    });
    mockFindPreviousOrderContent.mockReturnValue([
      'steps:',
      '  - name: review',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: true',
    ].join('\n'));

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should not warn for markdown explanatory snippets without workflow config body', async () => {
    mockFindPreviousOrderContent.mockReturnValue([
      '# Deprecated examples',
      '',
      '```yaml',
      'provider: codex',
      'model: gpt-5.3',
      'provider_options:',
      '  codex:',
      '    network_access: true',
      '```',
    ].join('\n'));

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should not warn when selected run order uses provider block format', async () => {
    mockFindPreviousOrderContent.mockReturnValue([
      'steps:',
      '  - name: review',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: true',
    ].join('\n'));

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should return false when worktree does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith('Worktree directory does not exist for task: done-task');
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should requeue task via requeueTask when save_task action', async () => {
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.save_task({ task: '追加指示A' }));

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('done-task', ['completed', 'failed'], undefined, '追加指示A');
    expect(mockStartReExecution).not.toHaveBeenCalled();
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('should requeue task with existing retry note appended when save_task', async () => {
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.save_task({ task: '追加指示A' }));

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', retry_note: '既存ノート' },
    });

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('done-task', ['completed', 'failed'], undefined, '既存ノート\n\n追加指示A');
  });
});
