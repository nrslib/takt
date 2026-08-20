import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedTaskOrderRevision } from '../features/tasks/orderRevision.js';
import { withAttachmentCleanup } from './testUtils/attachmentTestHelpers.js';
import {
  createPersistedTaskOrderRevisionMock,
  MOCK_CREATED_TASK_DIR,
} from './testUtils/orderRevisionTestHelpers.js';

const {
  mockStartReExecution,
  mockRequeueTask,
  mockExecuteAndCompleteTask,
  mockRunInstructMode,
  mockDispatchConversationAction,
  mockExecFileSync,
  mockSelectWorkflow,
  mockConfirm,
  mockGetLabel,
  mockGetWorkflowDescription,
  mockResolveLanguage,
  mockListRecentRuns,
  mockSelectRun,
  mockLoadRunSessionContext,
  mockFindRunForTask,
  mockWarn,
  mockIsWorkflowPath,
  mockLoadWorkflowByIdentifier,
  mockLoadAllStandaloneWorkflowsWithSources,
  mockResolveTaskOrderContent,
  mockPersistTaskOrderRevision,
  mockCleanupPersistedTaskOrderRevision,
  mockAssertReusableWorktreePath,
  mockResolveBaseBranch,
  mockGetCurrentBranch,
  mockLocalBranchExists,
} = vi.hoisted(() => ({
  mockStartReExecution: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockRunInstructMode: vi.fn(),
  mockDispatchConversationAction: vi.fn(),
  mockExecFileSync: vi.fn(() => ''),
  mockSelectWorkflow: vi.fn(),
  mockConfirm: vi.fn(),
  mockGetLabel: vi.fn(),
  mockGetWorkflowDescription: vi.fn(() => ({
    name: 'default',
    description: 'desc',
    workflowStructure: [],
    stepPreviews: [],
  })),
  mockResolveLanguage: vi.fn(() => 'en'),
  mockListRecentRuns: vi.fn(() => []),
  mockSelectRun: vi.fn(() => null),
  mockLoadRunSessionContext: vi.fn(),
  mockFindRunForTask: vi.fn(() => null),
  mockWarn: vi.fn(),
  mockIsWorkflowPath: vi.fn(() => false),
  mockLoadWorkflowByIdentifier: vi.fn(() => ({ name: 'path-workflow' })),
  mockLoadAllStandaloneWorkflowsWithSources: vi.fn(() => new Map<string, unknown>([
    ['default', {}],
    ['selected-workflow', {}],
  ])),
  mockResolveTaskOrderContent: vi.fn(() => 'done'),
  mockPersistTaskOrderRevision: vi.fn((projectDir: string, taskDir?: string): PersistedTaskOrderRevision =>
    createPersistedTaskOrderRevisionMock(projectDir, taskDir)),
  mockCleanupPersistedTaskOrderRevision: vi.fn(),
  mockAssertReusableWorktreePath: vi.fn(),
  mockResolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
  mockGetCurrentBranch: vi.fn(() => 'takt/826/pr-context'),
  mockLocalBranchExists: vi.fn(() => true),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  localBranchExists: (...args: unknown[]) => mockLocalBranchExists(...args),
  materializePullRequestBase: vi.fn((_projectCwd, _targetCwd, baseBranch: string) =>
    `refs/takt/pr-base/${baseBranch}`),
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
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  isWorkflowPath: (...args: unknown[]) => mockIsWorkflowPath(...args),
  loadWorkflowByIdentifier: (...args: unknown[]) => mockLoadWorkflowByIdentifier(...args),
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
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../features/tasks/orderRevision.js', () => ({
  resolveTaskOrderContent: (...args: unknown[]) => mockResolveTaskOrderContent(...args),
  persistTaskOrderRevision: (...args: unknown[]) => mockPersistTaskOrderRevision(...args),
  cleanupPersistedTaskOrderRevision: (...args: unknown[]) => mockCleanupPersistedTaskOrderRevision(...args),
}));

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: (...args: unknown[]) => mockAssertReusableWorktreePath(...args),
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
const testAttachment = {
  placeholder: '[Image #1]',
  tempPath: '/tmp/takt/session-1/attachments/image-1.png',
  fileName: 'image-1.png',
};

describe('instructBranch direct execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTaskOrderContent.mockImplementation(() => 'done');
    mockAssertReusableWorktreePath.mockImplementation(() => undefined);
    mockSelectWorkflow.mockResolvedValue('default');
    mockRunInstructMode.mockResolvedValue({ action: 'execute', task: '追加指示A', source: 'go' });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.execute({ task: '追加指示A' }));
    mockExecFileSync.mockReturnValue('');
    mockConfirm.mockResolvedValue(true);
    mockGetWorkflowDescription.mockReturnValue({
      name: 'default',
      description: 'desc',
      workflowStructure: [],
      stepPreviews: [],
    });
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
    mockIsWorkflowPath.mockImplementation((workflow: string) => workflow.startsWith('/') || workflow.startsWith('~') || workflow.startsWith('./') || workflow.startsWith('../') || workflow.endsWith('.yaml') || workflow.endsWith('.yml'));
    mockLoadWorkflowByIdentifier.mockReturnValue({ name: 'path-workflow' });
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
      ['completed', 'pr_failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: undefined,
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should pass the discovered source run to instructed direct execution', async () => {
    mockFindRunForTask.mockReturnValue('20260717-source-run');

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
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: undefined,
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: '20260717-source-run',
        restartPoint: undefined,
      },
    );
  });

  it('should replay the existing task_dir without revising order', async () => {
    mockRunInstructMode.mockResolvedValue({
      action: 'execute',
      task: '# Canonical order',
      source: 'replay',
    });
    const taskDir = '.takt/tasks/done-task';
    mockResolveTaskOrderContent.mockReturnValue('# Canonical order');

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'legacy task text',
      taskDir,
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'legacy task text' },
    });

    expect(mockPersistTaskOrderRevision).not.toHaveBeenCalled();
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      'instruct',
      expect.objectContaining({ taskDir, retryNote: undefined }),
    );
  });

  it('should promote image attachments for instructed direct execution', async () => {
    const cleanupAttachments = vi.fn();
    mockRunInstructMode.mockResolvedValue(withAttachmentCleanup({
      action: 'execute',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
      source: 'go',
    }, cleanupAttachments));
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.execute({ task: 'Use [Image #1].' }));

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

    expect(mockPersistTaskOrderRevision).toHaveBeenCalledWith(
      '/project',
      undefined,
      'Use [Image #1].',
      'en',
      [testAttachment],
    );
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: undefined,
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('should cleanup instructed attachments when action dispatch throws', async () => {
    const cleanupAttachments = vi.fn();
    mockRunInstructMode.mockResolvedValue(withAttachmentCleanup({
      action: 'execute',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
    }, cleanupAttachments));
    mockDispatchConversationAction.mockRejectedValueOnce(new Error('dispatch failed'));

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    })).rejects.toThrow('dispatch failed');

    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('should cleanup a created order revision when instructed execution setup fails', async () => {
    mockStartReExecution.mockImplementationOnce(() => {
      throw new Error('start failed');
    });

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    })).rejects.toThrow('start failed');

    expect(mockCleanupPersistedTaskOrderRevision).toHaveBeenCalledWith(expect.objectContaining({
      created: true,
      taskDirRelative: MOCK_CREATED_TASK_DIR,
      taskDir: `/project/${MOCK_CREATED_TASK_DIR}`,
    }));
  });

  it('should rollback the revision when the worktree disappears before instruct state mutation', async () => {
    mockAssertReusableWorktreePath.mockImplementation((_projectDir: string, candidatePath: string) => {
      if (mockPersistTaskOrderRevision.mock.calls.length > 0) {
        throw new Error(`Worktree was replaced before instruct state mutation: ${candidatePath}`);
      }
    });

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    })).rejects.toThrow('Worktree was replaced before instruct state mutation');

    expect(mockCleanupPersistedTaskOrderRevision).toHaveBeenCalledWith(expect.objectContaining({
      created: true,
      taskDirRelative: MOCK_CREATED_TASK_DIR,
      taskDir: `/project/${MOCK_CREATED_TASK_DIR}`,
    }));
    expect(mockStartReExecution).not.toHaveBeenCalled();
    expect(mockRequeueTask).not.toHaveBeenCalled();
  });

  it('should promote image attachments for instructed save_task requeue', async () => {
    mockRunInstructMode.mockResolvedValue({
      action: 'save_task',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
      source: 'go',
    });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.save_task({ task: 'Use [Image #1].' }));

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

    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: 'default',
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(mockPersistTaskOrderRevision).toHaveBeenCalledWith(
      '/project',
      undefined,
      'Use [Image #1].',
      'en',
      [testAttachment],
    );
  });

  it('should preserve task_dir order content when instructed task has image attachments', async () => {
    mockResolveTaskOrderContent.mockReturnValue(['Full order', 'Second line'].join('\n'));
    mockRunInstructMode.mockResolvedValue({
      action: 'save_task',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
      source: 'go',
    });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.save_task({ task: 'Use [Image #1].' }));

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'Implement using only the files in `.takt/tasks/done-task`.',
      taskDir: '.takt/tasks/done-task',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'Implement using only the files in `.takt/tasks/done-task`.' },
    });

    expect(mockResolveTaskOrderContent).toHaveBeenCalledWith(
      '/project',
      '.takt/tasks/done-task',
      'Implement using only the files in `.takt/tasks/done-task`.',
    );
    expect(mockPersistTaskOrderRevision).toHaveBeenCalledWith(
      '/project',
      '.takt/tasks/done-task',
      'Use [Image #1].',
      'en',
      [testAttachment],
    );
  });

  it('should renumber instructed attachments when task_dir order already references images', async () => {
    mockResolveTaskOrderContent.mockReturnValue([
      'Full order with [Image #1].',
      '',
      '## 添付画像',
      '',
      '- [Image #1]: `attachments/image-1.png`',
    ].join('\n'));
    mockRunInstructMode.mockResolvedValue({
      action: 'save_task',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
      source: 'go',
    });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.save_task({ task: 'Use [Image #1].' }));

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'Implement using only the files in `.takt/tasks/done-task`.',
      taskDir: '.takt/tasks/done-task',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'Implement using only the files in `.takt/tasks/done-task`.' },
    });

    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: 'default',
        taskDir: '.takt/tasks/done-task',
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(mockPersistTaskOrderRevision).toHaveBeenCalledWith(
      '/project',
      '.takt/tasks/done-task',
      'Use [Image #1].',
      'en',
      [testAttachment],
    );
  });

  it('should pass renumbered instruction note when executing instructed attachments directly', async () => {
    mockResolveTaskOrderContent.mockReturnValue([
      'Full order with [Image #1].',
      '',
      '## 添付画像',
      '',
      '- [Image #1]: `attachments/image-1.png`',
    ].join('\n'));
    mockRunInstructMode.mockResolvedValue({
      action: 'execute',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
      source: 'go',
    });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.execute({ task: 'Use [Image #1].' }));

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'Implement using only the files in `.takt/tasks/done-task`.',
      taskDir: '.takt/tasks/done-task',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'Implement using only the files in `.takt/tasks/done-task`.' },
    });

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: undefined,
        taskDir: '.takt/tasks/done-task',
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
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
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('should resolve reused workflow path descriptions from the worktree lookup root', async () => {
    const workflowPath = './.takt/workflows/custom.yaml';

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', workflow: workflowPath },
    });

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
      workflowPath,
      '/project',
      { lookupCwd: '/project/.takt/worktrees/done-task' },
    );
    expect(mockGetWorkflowDescription).toHaveBeenCalledWith(
      workflowPath,
      '/project',
      3,
      '/project/.takt/worktrees/done-task',
      undefined,
    );
    expect(mockSelectWorkflow).not.toHaveBeenCalled();
  });

  it('should pass the same selector override to instruct preview and execution', async () => {
    const overrides = { provider: 'mock' as const, model: 'mock-selector' };

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', workflow: 'default' },
    }, overrides);

    expect(mockGetWorkflowDescription).toHaveBeenCalledWith(
      'default',
      '/project',
      3,
      '/project/.takt/worktrees/done-task',
      overrides,
    );
    expect(mockExecuteAndCompleteTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '/project',
      overrides,
    );
  });

  it('should build branch context from diff and commit sections without dropping either section', async () => {
    mockExecFileSync
      .mockReturnValueOnce(' src/index.ts | 2 +-\n 1 file changed')
      .mockReturnValueOnce('abc123 fix issue');

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
      expect.objectContaining({
        cwd: '/project/.takt/worktrees/done-task',
        branchContext: expect.any(String),
        branchName: 'takt/done-task',
        taskName: 'done-task',
        taskContent: 'done',
        retryNote: '',
        previousOrderContent: 'done',
      }),
    );
    const branchContext = mockRunInstructMode.mock.calls[0]?.[0]?.branchContext as string;
    expect(branchContext).toContain('src/index.ts');
    expect(branchContext).toContain('abc123 fix issue');
  });

  it('should use the saved PR base for Instruct diff context', async () => {
    mockResolveTaskOrderContent.mockReturnValue('review PR');
    mockExecFileSync
      .mockReturnValueOnce(' src/index.ts | 2 +-\n 1 file changed')
      .mockReturnValueOnce('abc123 fix issue');

    await instructBranch('/project', {
      kind: 'completed',
      name: 'pr-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'review PR',
      branch: 'takt/826/pr-context',
      worktreePath: '/project/.takt/worktrees/pr-task',
      data: {
        task: 'review PR',
        source: 'pr_review',
        pr_number: 826,
        base_branch: 'release/2026.07',
        branch: 'takt/826/pr-context',
      },
    });

    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['diff', '--stat', 'refs/takt/pr-base/release/2026.07...refs/heads/takt/826/pr-context'],
      expect.objectContaining({ cwd: '/project/.takt/worktrees/pr-task' }),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['log', '--oneline', 'refs/takt/pr-base/release/2026.07..refs/heads/takt/826/pr-context'],
      expect.objectContaining({ cwd: '/project/.takt/worktrees/pr-task' }),
    );
    expect(mockRunInstructMode).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/project/.takt/worktrees/pr-task',
        branchContext: expect.stringContaining('release/2026.07'),
        branchName: 'takt/826/pr-context',
        taskName: 'pr-task',
        taskContent: 'review PR',
        retryNote: '',
        previousOrderContent: 'review PR',
        prContext: {
          source: 'pr_review',
          prNumber: 826,
          baseBranch: 'release/2026.07',
          headBranch: 'takt/826/pr-context',
          baseBranchSource: 'pull_request',
          baseDiffRef: 'refs/takt/pr-base/release/2026.07',
          headDiffRef: 'refs/heads/takt/826/pr-context',
        },
      }),
    );
  });

  it('should resolve a missing saved PR base through the project base resolver', async () => {
    await instructBranch('/project', {
      kind: 'completed',
      name: 'pr-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'review PR',
      branch: 'takt/826/pr-context',
      worktreePath: '/project/.takt/worktrees/pr-task',
      data: {
        task: 'review PR',
        source: 'pr_review',
        pr_number: 826,
        branch: 'takt/826/pr-context',
      },
    });

    expect(mockResolveBaseBranch).toHaveBeenCalledWith('/project');
    expect(mockRunInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      prContext: expect.objectContaining({
        baseBranch: 'main',
        baseBranchSource: 'default_branch_fallback',
      }),
    }));
  });

  it('should reject PR instruct context when the worktree head ref is missing', async () => {
    mockLocalBranchExists.mockReturnValueOnce(false);

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'pr-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'review PR',
      branch: 'takt/826/pr-context',
      worktreePath: '/project/.takt/worktrees/pr-task',
      data: {
        task: 'review PR',
        source: 'pr_review',
        pr_number: 826,
        base_branch: 'release/2026.07',
        branch: 'takt/826/pr-context',
      },
    })).rejects.toThrow(
      'PR review task "pr-task" worktree is missing head ref refs/heads/takt/826/pr-context.',
    );
    expect(mockRunInstructMode).not.toHaveBeenCalled();
  });

  it('should reject PR instruct context when the worktree is on another branch', async () => {
    mockGetCurrentBranch.mockReturnValueOnce('main');

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'pr-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'review PR',
      branch: 'takt/826/pr-context',
      worktreePath: '/project/.takt/worktrees/pr-task',
      data: {
        task: 'review PR',
        source: 'pr_review',
        pr_number: 826,
        base_branch: 'release/2026.07',
        branch: 'takt/826/pr-context',
      },
    })).rejects.toThrow(
      'PR review task "pr-task" worktree is checked out on "main", expected "takt/826/pr-context".',
    );
    expect(mockLocalBranchExists).not.toHaveBeenCalled();
    expect(mockRunInstructMode).not.toHaveBeenCalled();
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

  it('should not store a generated instruction as retry note', async () => {
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
      ['completed', 'pr_failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: undefined,
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
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
      expect.objectContaining({
        cwd: '/project/.takt/worktrees/done-task',
        branchContext: expect.any(String),
        branchName: 'takt/done-task',
        taskName: 'done-task',
        taskContent: 'done',
        retryNote: '',
        previousOrderContent: 'done',
      }),
    );
  });

  it('should reject failed tasks before starting instruct mode', async () => {
    const failedTask = {
      kind: 'failed' as const,
      name: 'failed-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'failed task',
      branch: 'takt/failed-task',
      worktreePath: '/project/.takt/worktrees/failed-task',
      runSlug: 'failed-run',
      data: { task: 'failed task\n追加条件を確認する' },
    };

    await expect(instructBranch('/project', failedTask)).rejects.toThrow(
      'Failed tasks do not support Instruct; use Retry instead.',
    );
    expect(mockRunInstructMode).not.toHaveBeenCalled();
    expect(mockFindRunForTask).not.toHaveBeenCalled();
    expect(mockResolveTaskOrderContent).not.toHaveBeenCalled();
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

    expect(mockConfirm).toHaveBeenCalledWith(expect.any(String), false);
    // selectRunSessionContext uses worktreePath for run data
    expect(mockListRecentRuns).toHaveBeenCalledWith('/project/.takt/worktrees/done-task');
    expect(mockSelectRun).toHaveBeenCalledWith('/project/.takt/worktrees/done-task', 'en');
    expect(mockLoadRunSessionContext).toHaveBeenCalledWith('/project/.takt/worktrees/done-task', 'run-1');
    expect(mockRunInstructMode).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/project/.takt/worktrees/done-task',
        branchContext: expect.any(String),
        branchName: 'takt/done-task',
        taskName: 'done-task',
        taskContent: 'done',
        retryNote: '',
        runSessionContext: runContext,
        previousOrderContent: 'done',
      }),
    );
  });

  it('should not warn when canonical order uses provider block fields', async () => {
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
    mockResolveTaskOrderContent.mockReturnValue([
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
    mockResolveTaskOrderContent.mockReturnValue([
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

  it('should not warn when canonical order uses provider block format', async () => {
    mockResolveTaskOrderContent.mockReturnValue([
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

  it('should fail fast when worktree does not exist', async () => {
    mockAssertReusableWorktreePath.mockImplementationOnce((_projectDir: string, candidatePath: string) => {
      throw new Error(`Worktree directory does not exist: ${candidatePath}`);
    });

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    })).rejects.toThrow('Worktree directory does not exist');
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
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: 'default',
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(mockStartReExecution).not.toHaveBeenCalled();
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('should pass selected workflow when save_task uses a different workflow', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSelectWorkflow.mockResolvedValue('selected-workflow');
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.save_task({ task: '追加指示A' }));

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

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: 'selected-workflow',
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
  });

  it('should pass undefined workflow override when save_task keeps the same workflow', async () => {
    mockConfirm.mockResolvedValue(true);
    mockSelectWorkflow.mockResolvedValue('default');
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) =>
      handlers.save_task({ task: '追加指示A' }));

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

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: undefined,
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
  });

  it('should clear an existing retry note when revised order is requeued', async () => {
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
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'pr_failed'],
      {
        startStep: undefined,
        retryNote: undefined,
        resumePoint: undefined,
        workflow: 'default',
        taskDir: MOCK_CREATED_TASK_DIR,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
  });
});
