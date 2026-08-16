import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withAttachmentCleanup } from './testUtils/attachmentTestHelpers.js';

const {
  mockExistsSync,
  mockReadFileSync,
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
  mockFindPreviousOrderContent,
  mockWarn,
  mockIsWorkflowPath,
  mockLoadWorkflowByIdentifier,
  mockLoadAllStandaloneWorkflowsWithSources,
  mockPrepareTaskSpecDirectory,
  mockCleanupPreparedTaskSpec,
  mockResolveBaseBranch,
  mockGetCurrentBranch,
  mockLocalBranchExists,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockReadFileSync: vi.fn(),
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
  mockFindPreviousOrderContent: vi.fn(() => null),
  mockWarn: vi.fn(),
  mockIsWorkflowPath: vi.fn(() => false),
  mockLoadWorkflowByIdentifier: vi.fn(() => ({ name: 'path-workflow' })),
  mockLoadAllStandaloneWorkflowsWithSources: vi.fn(() => new Map<string, unknown>([
    ['default', {}],
    ['selected-workflow', {}],
  ])),
  mockPrepareTaskSpecDirectory: vi.fn(),
  mockCleanupPreparedTaskSpec: vi.fn(),
  mockResolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
  mockGetCurrentBranch: vi.fn(() => 'takt/826/pr-context'),
  mockLocalBranchExists: vi.fn(() => true),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
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
  findPreviousOrderContent: (...args: unknown[]) => mockFindPreviousOrderContent(...args),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../features/tasks/attachments.js', () => ({
  prepareTaskSpecDirectory: (...args: unknown[]) => mockPrepareTaskSpecDirectory(...args),
  cleanupPreparedTaskSpec: (...args: unknown[]) => mockCleanupPreparedTaskSpec(...args),
}));

vi.mock('../features/tasks/taskSpecFile.js', () => ({
  readTaskSpecFile: (sourceOrderPath: string) => mockReadFileSync(sourceOrderPath, 'utf-8'),
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
const testAttachment = {
  placeholder: '[Image #1]',
  tempPath: '/tmp/takt/session-1/attachments/image-1.png',
  fileName: 'image-1.png',
};

describe('instructBranch direct execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('readFileSync should not be called by default');
    });

    mockSelectWorkflow.mockResolvedValue('default');
    mockRunInstructMode.mockResolvedValue({ action: 'execute', task: '追加指示A' });
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
    mockFindPreviousOrderContent.mockReturnValue(null);
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
    mockPrepareTaskSpecDirectory.mockReturnValue({
      taskDir: '/project/.takt/tasks/done-task',
      taskDirRelative: '.takt/tasks/done-task',
    });
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
      'instruct',
      {
        startStep: undefined,
        retryNote: '既存ノート\n\n追加指示A',
        resumePoint: undefined,
        workflow: undefined,
        taskDir: undefined,
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
      ['completed', 'failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: '追加指示A',
        resumePoint: undefined,
        workflow: undefined,
        taskDir: undefined,
        sourceRunSlug: '20260717-source-run',
        restartPoint: undefined,
      },
    );
  });

  it('should promote image attachments for instructed direct execution', async () => {
    const cleanupAttachments = vi.fn();
    mockRunInstructMode.mockResolvedValue(withAttachmentCleanup({
      action: 'execute',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
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

    expect(mockPrepareTaskSpecDirectory).toHaveBeenCalledWith(
      '/project',
      ['done', '', '## 追加指示', '', 'Use [Image #1].'].join('\n'),
      [testAttachment],
    );
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: 'Use [Image #1].',
        resumePoint: undefined,
        workflow: undefined,
        taskDir: '.takt/tasks/done-task',
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

  it('should promote image attachments for instructed save_task requeue', async () => {
    mockRunInstructMode.mockResolvedValue({
      action: 'save_task',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
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
      ['completed', 'failed'],
      {
        startStep: undefined,
        retryNote: 'Use [Image #1].',
        resumePoint: undefined,
        workflow: 'default',
        taskDir: '.takt/tasks/done-task',
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(mockPrepareTaskSpecDirectory).toHaveBeenCalledWith(
      '/project',
      ['done', '', '## 追加指示', '', 'Use [Image #1].'].join('\n'),
      [testAttachment],
    );
  });

  it('should preserve task_dir order content when instructed task has image attachments', async () => {
    mockReadFileSync.mockReturnValue(['Full order', 'Second line'].join('\n'));
    mockRunInstructMode.mockResolvedValue({
      action: 'save_task',
      task: 'Use [Image #1].',
      attachments: [testAttachment],
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

    expect(mockReadFileSync).toHaveBeenCalledWith('/project/.takt/tasks/done-task/order.md', 'utf-8');
    expect(mockPrepareTaskSpecDirectory).toHaveBeenCalledWith(
      '/project',
      ['Full order', 'Second line', '', '## 追加指示', '', 'Use [Image #1].'].join('\n'),
      [testAttachment],
      { sourceTaskDir: '/project/.takt/tasks/done-task' },
    );
  });

  it('should renumber instructed attachments when task_dir order already references images', async () => {
    mockReadFileSync.mockReturnValue([
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
      ['completed', 'failed'],
      {
        startStep: undefined,
        retryNote: 'Use [Image #2].',
        resumePoint: undefined,
        workflow: 'default',
        taskDir: '.takt/tasks/done-task',
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
    expect(mockPrepareTaskSpecDirectory).toHaveBeenCalledWith(
      '/project',
      [
        'Full order with [Image #1].',
        '',
        '## 添付画像',
        '',
        '- [Image #1]: `attachments/image-1.png`',
        '',
        '## 追加指示',
        '',
        'Use [Image #2].',
      ].join('\n'),
      [{
        ...testAttachment,
        placeholder: '[Image #2]',
        fileName: 'image-2.png',
      }],
      { sourceTaskDir: '/project/.takt/tasks/done-task' },
    );
  });

  it('should pass renumbered instruction note when executing instructed attachments directly', async () => {
    mockReadFileSync.mockReturnValue([
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
      ['completed', 'failed'],
      'instruct',
      {
        startStep: undefined,
        retryNote: 'Use [Image #2].',
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
    expect(mockGetLabel).toHaveBeenCalledWith('retry.usePreviousWorkflowConfirm', 'en', { workflow: 'default' });
    const reuseConfirmCall = mockConfirm.mock.calls.find(([message]) => message === 'retry.usePreviousWorkflowConfirm');
    expect(reuseConfirmCall?.[1] ?? true).toBe(true);
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
        branchContext: [
          '## 現在の変更内容（mainからの差分）',
          '```',
          'src/index.ts | 2 +-\n 1 file changed',
          '```',
          '',
          '## コミット履歴',
          '```',
          'abc123 fix issue',
          '```',
          '',
          '',
        ].join('\n'),
        branchName: 'takt/done-task',
        taskName: 'done-task',
        taskContent: 'done',
        retryNote: '',
        previousOrderContent: null,
      }),
    );
  });

  it('should use the saved PR base for Instruct diff context', async () => {
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
        branchContext: expect.stringContaining('## 現在の変更内容（release/2026.07からの差分）'),
        branchName: 'takt/826/pr-context',
        taskName: 'pr-task',
        taskContent: 'review PR',
        retryNote: '',
        previousOrderContent: null,
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
      'instruct',
      {
        startStep: undefined,
        retryNote: '追加指示A',
        resumePoint: undefined,
        workflow: undefined,
        taskDir: undefined,
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
        previousOrderContent: null,
      }),
    );
  });

  it('should start failed instruct from the saved run in the same worktree', async () => {
    const runSessionContext = {
      task: 'failed task\n追加条件を確認する',
      workflow: 'default',
      status: 'failed',
      stepLogs: [],
      reports: [{
        filename: 'review-resolution.md',
        content: [
          '## Requirement Decision Grounds',
          '| Subject | Status | Grounds |',
          '|---|---|---|',
          '| failed instruct | Fulfilled | review: APPROVE |',
          '## Finding Dispositions',
          '| Finding ID / Source | Disposition | Basis |',
          '|---|---|---|',
          '## Re-evaluation of Prior Findings',
          '- review: APPROVE',
          '## Reason the Decision Cannot Be Made (when BLOCKED)',
          '- npm run test:e2e:mock',
        ].join('\n'),
      }],
    };
    mockLoadRunSessionContext.mockReturnValue(runSessionContext);
    mockFindRunForTask.mockReturnValue('different-run');
    mockExecFileSync.mockImplementation((_command, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'status') {
        return 'A  src/staged-marker.ts\n M src/unstaged-marker.ts\n?? untracked-marker.md\n';
      }
      if (gitArgs[0] === 'diff' && gitArgs.includes('main...takt/failed-task')) {
        return ' src/committed-marker.ts | 1 +\n';
      }
      if (gitArgs[0] === 'diff' && gitArgs.includes('--cached')) {
        return ' src/staged-marker.ts | 1 +\n';
      }
      if (gitArgs[0] === 'diff') {
        return ' src/unstaged-marker.ts | 1 +\n';
      }
      if (gitArgs[0] === 'log') {
        return 'abc123 failed run\n';
      }
      return '';
    });

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

    const result = await instructBranch('/project', failedTask);

    expect(result).toBe(true);
    expect(mockFindRunForTask).not.toHaveBeenCalled();
    expect(mockLoadRunSessionContext).toHaveBeenCalledWith(
      '/project/.takt/worktrees/failed-task',
      'failed-run',
    );
    expect(mockRunInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/project/.takt/worktrees/failed-task',
      branchName: 'takt/failed-task',
      runSessionContext,
      failedContext: expect.objectContaining({
        reportSummary: expect.stringContaining('failed instruct'),
        worktreeSummary: expect.any(String),
      }),
    }));
    const failedContext = mockRunInstructMode.mock.calls[0]?.[0]?.failedContext as {
      reportSummary: string;
      worktreeSummary: string;
    };
    expect(failedContext.reportSummary).toContain('未解決 finding: 0件');
    expect(failedContext.reportSummary).toContain('npm run test:e2e:mock');
    expect(failedContext.worktreeSummary).toContain('## ステージ済み変更');
    expect(failedContext.worktreeSummary).toContain('src/staged-marker.ts');
    expect(failedContext.worktreeSummary).toContain('## 未ステージ変更');
    expect(failedContext.worktreeSummary).toContain('src/unstaged-marker.ts');
    expect(failedContext.worktreeSummary).toContain('## 作業ツリーの状態');
    expect(failedContext.worktreeSummary).toContain('untracked-marker.md');
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'failed-task',
      ['completed', 'failed'],
      'instruct',
      expect.objectContaining({
        sourceRunSlug: 'failed-run',
      }),
    );
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should resolve a missing failed run slug from the task in the same worktree', async () => {
    const fullTask = 'failed task\n追加条件を確認する';
    const runSessionContext = {
      task: fullTask,
      workflow: 'default',
      status: 'failed',
      stepLogs: [],
      reports: [],
    };
    mockFindRunForTask.mockReturnValue('discovered-failed-run');
    mockLoadRunSessionContext.mockReturnValue(runSessionContext);

    await instructBranch('/project', {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2026-08-15T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'failed task',
      branch: 'takt/failed-task',
      worktreePath: '/project/.takt/worktrees/failed-task',
      data: { task: fullTask },
    });

    expect(mockFindRunForTask).toHaveBeenCalledWith(
      '/project/.takt/worktrees/failed-task',
      fullTask,
    );
    expect(mockLoadRunSessionContext).toHaveBeenCalledWith(
      '/project/.takt/worktrees/failed-task',
      'discovered-failed-run',
    );
    expect(mockFindPreviousOrderContent).toHaveBeenCalledWith(
      '/project/.takt/worktrees/failed-task',
      'discovered-failed-run',
    );
    expect(mockRunInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/project/.takt/worktrees/failed-task',
      runSessionContext,
      previousOrderContent: null,
    }));
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'failed-task',
      ['completed', 'failed'],
      'instruct',
      expect.objectContaining({ sourceRunSlug: 'discovered-failed-run' }),
    );
  });

  it('should not select a run when only the displayed task prefix matches', async () => {
    const fullTask = 'x'.repeat(81);
    mockFindRunForTask.mockReturnValue(null);
    mockFindPreviousOrderContent.mockReturnValue('unrelated latest order');

    await instructBranch('/project', {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2026-08-15T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'x'.repeat(80),
      branch: 'takt/failed-task',
      worktreePath: '/project/.takt/worktrees/failed-task',
      data: { task: fullTask },
    });

    expect(mockFindRunForTask).toHaveBeenCalledWith(
      '/project/.takt/worktrees/failed-task',
      fullTask,
    );
    expect(mockLoadRunSessionContext).not.toHaveBeenCalled();
    expect(mockFindPreviousOrderContent).not.toHaveBeenCalled();
    expect(mockRunInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      runSessionContext: undefined,
      previousOrderContent: null,
      failedContext: expect.objectContaining({ reportSummary: '' }),
    }));
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'failed-task',
      ['completed', 'failed'],
      'instruct',
      expect.objectContaining({ sourceRunSlug: undefined }),
    );
  });

  it('should not read an unrelated order when a failed run cannot be resolved', async () => {
    mockFindRunForTask.mockReturnValue(null);
    mockFindPreviousOrderContent.mockReturnValue('unrelated latest order');

    await instructBranch('/project', {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2026-08-15T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'failed task',
      branch: 'takt/failed-task',
      worktreePath: '/project/.takt/worktrees/failed-task',
      data: { task: 'failed task' },
    });

    expect(mockFindPreviousOrderContent).not.toHaveBeenCalled();
    expect(mockRunInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      previousOrderContent: null,
    }));
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'failed-task',
      ['completed', 'failed'],
      'instruct',
      expect.objectContaining({ sourceRunSlug: undefined }),
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
      expect.objectContaining({
        cwd: '/project/.takt/worktrees/done-task',
        branchContext: expect.any(String),
        branchName: 'takt/done-task',
        taskName: 'done-task',
        taskContent: 'done',
        retryNote: '',
        runSessionContext: runContext,
        previousOrderContent: null,
      }),
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
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      {
        startStep: undefined,
        retryNote: '追加指示A',
        resumePoint: undefined,
        workflow: 'default',
        taskDir: undefined,
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
      ['completed', 'failed'],
      {
        startStep: undefined,
        retryNote: '追加指示A',
        resumePoint: undefined,
        workflow: 'selected-workflow',
        taskDir: undefined,
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
      ['completed', 'failed'],
      {
        startStep: undefined,
        retryNote: '追加指示A',
        resumePoint: undefined,
        workflow: undefined,
        taskDir: undefined,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
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
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      {
        startStep: undefined,
        retryNote: '既存ノート\n\n追加指示A',
        resumePoint: undefined,
        workflow: 'default',
        taskDir: undefined,
        sourceRunSlug: undefined,
        restartPoint: undefined,
      },
    );
  });
});
