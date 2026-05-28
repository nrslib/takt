import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      undefined,
      '既存ノート\n\n追加指示A',
      undefined,
      undefined,
      undefined,
    );
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should promote image attachments for instructed direct execution', async () => {
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
      undefined,
      'Use [Image #1].',
      undefined,
      undefined,
      '.takt/tasks/done-task',
    );
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
      undefined,
      'Use [Image #1].',
      undefined,
      undefined,
      '.takt/tasks/done-task',
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
    );
    expect(mockSelectWorkflow).not.toHaveBeenCalled();
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
      '/project/.takt/worktrees/done-task',
      [
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
      'takt/done-task',
      'done-task',
      'done',
      '',
      expect.anything(),
      undefined,
      null,
    );
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
      undefined,
      undefined,
      undefined,
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
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      undefined,
      '追加指示A',
      undefined,
      undefined,
      undefined,
    );
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
    expect(mockRequeueTask).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      undefined,
      '既存ノート\n\n追加指示A',
      undefined,
      undefined,
      undefined,
    );
  });
});
