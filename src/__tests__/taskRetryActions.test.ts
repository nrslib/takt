import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachWorkflowSourcePath, attachWorkflowTrustInfo } from '../infra/config/loaders/workflowSourceMetadata.js';

const {
  mockExistsSync,
  mockSelectWorkflow,
  mockSelectOptionWithDefault,
  mockConfirm,
  mockResolveWorkflowConfigValue,
  mockLoadWorkflowByIdentifier,
  mockGetWorkflowDescription,
  mockRunRetryMode,
  mockFindRunForTask,
  mockFindPreviousOrderContent,
  mockLoadRunSessionContext,
  mockFormatRunSessionForPrompt,
  mockReadRunMetaBySlug,
  mockStartReExecution,
  mockRequeueTask,
  mockExecuteAndCompleteTask,
  mockWarn,
  mockInfo,
  mockHeader,
  mockStatus,
  mockIsWorkflowPath,
  mockLoadAllWorkflowsWithSources,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockSelectWorkflow: vi.fn(),
  mockSelectOptionWithDefault: vi.fn(),
  mockConfirm: vi.fn(),
  mockResolveWorkflowConfigValue: vi.fn(),
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockGetWorkflowDescription: vi.fn(() => ({
    name: 'default',
    description: 'desc',
    workflowStructure: '',
    stepPreviews: [],
  })),
  mockRunRetryMode: vi.fn(),
  mockFindRunForTask: vi.fn(() => null),
  mockFindPreviousOrderContent: vi.fn(() => null),
  mockLoadRunSessionContext: vi.fn(),
  mockFormatRunSessionForPrompt: vi.fn((sessionContext?: { workflow?: string }) => ({
    runTask: '',
    runWorkflow: sessionContext?.workflow ?? '',
    runStatus: '',
    runStepLogs: '',
    runReports: '',
  })),
  mockReadRunMetaBySlug: vi.fn(() => null),
  mockStartReExecution: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockHeader: vi.fn(),
  mockStatus: vi.fn(),
  mockIsWorkflowPath: vi.fn(() => false),
  mockLoadAllWorkflowsWithSources: vi.fn(() => new Map<string, unknown>([['default', {}]])),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: (...args: unknown[]) => mockSelectWorkflow(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: (...args: unknown[]) => mockSelectOptionWithDefault(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  header: (...args: unknown[]) => mockHeader(...args),
  blankLine: vi.fn(),
  status: (...args: unknown[]) => mockStatus(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValue: (...args: unknown[]) => mockResolveWorkflowConfigValue(...args),
  loadWorkflowByIdentifier: (...args: unknown[]) => mockLoadWorkflowByIdentifier(...args),
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  isWorkflowPath: (...args: unknown[]) => mockIsWorkflowPath(...args),
  loadAllWorkflowsWithSources: (...args: unknown[]) => mockLoadAllWorkflowsWithSources(...args),
}));

vi.mock('../features/interactive/index.js', () => ({
  findRunForTask: (...args: unknown[]) => mockFindRunForTask(...args),
  loadRunSessionContext: (...args: unknown[]) => mockLoadRunSessionContext(...args),
  getRunPaths: vi.fn(() => ({ logsDir: '/tmp/logs', reportsDir: '/tmp/reports' })),
  formatRunSessionForPrompt: (...args: unknown[]) => mockFormatRunSessionForPrompt(...args),
  runRetryMode: (...args: unknown[]) => mockRunRetryMode(...args),
  findPreviousOrderContent: (...args: unknown[]) => mockFindPreviousOrderContent(...args),
}));

vi.mock('../core/workflow/run/run-meta.js', () => ({
  readRunMetaBySlug: (...args: unknown[]) => mockReadRunMetaBySlug(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    startReExecution(...args: unknown[]) {
      return mockStartReExecution(...args);
    }
    requeueTask(...args: unknown[]) {
      return mockRequeueTask(...args);
    }
  },
  resolveTaskWorkflowValue: vi.fn((data?: Record<string, unknown>) => {
    if (!data) {
      return undefined;
    }
    return typeof data.workflow === 'string' ? data.workflow : undefined;
  }),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string, _lang?: string, vars?: Record<string, string>) => {
    if (vars?.workflow) {
      return `Use previous workflow "${vars.workflow}"?`;
    }
    return key;
  }),
}));

import { retryFailedTask } from '../features/tasks/list/taskRetryActions.js';
import type { TaskListItem } from '../infra/task/types.js';
import type { WorkflowConfig } from '../core/models/index.js';

const defaultWorkflowConfig: WorkflowConfig = {
  name: 'default',
  description: 'Default workflow',
  initialStep: 'plan',
  maxSteps: 30,
  steps: [
    { name: 'plan', persona: 'planner', instruction: '' },
    { name: 'implement', persona: 'coder', instruction: '' },
    { name: 'review', persona: 'reviewer', instruction: '' },
  ],
};

function makeFailedTask(overrides?: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'failed',
    name: 'my-task',
    createdAt: '2025-01-15T12:02:00.000Z',
    filePath: '/project/.takt/tasks.yaml',
    content: 'Do something',
    branch: 'takt/my-task',
    worktreePath: '/project/.takt/worktrees/my-task',
    data: { task: 'Do something', workflow: 'default' },
    failure: { step: 'review', error: 'Boom' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);

  mockConfirm.mockResolvedValue(true);
  mockSelectWorkflow.mockResolvedValue('default');
  mockResolveWorkflowConfigValue.mockReturnValue(3);
  mockLoadWorkflowByIdentifier.mockReturnValue(defaultWorkflowConfig);
  mockIsWorkflowPath.mockImplementation((workflow: string) => workflow.startsWith('/') || workflow.startsWith('~') || workflow.startsWith('./') || workflow.startsWith('../') || workflow.endsWith('.yaml') || workflow.endsWith('.yml'));
  mockLoadAllWorkflowsWithSources.mockReturnValue(new Map<string, unknown>([['default', {}], ['selected-workflow', {}]]));
  mockSelectOptionWithDefault.mockResolvedValue('plan');
  mockRunRetryMode.mockResolvedValue({ action: 'execute', task: '追加指示A' });
  mockFindPreviousOrderContent.mockReturnValue(null);
  mockLoadRunSessionContext.mockReturnValue({
    task: 'Do something',
    workflow: 'default',
    status: 'failed',
    stepLogs: [],
    reports: [],
  });
  mockReadRunMetaBySlug.mockReturnValue(null);
  mockStartReExecution.mockReturnValue({
    name: 'my-task',
    content: 'Do something',
    data: { task: 'Do something', workflow: 'default' },
  });
  mockExecuteAndCompleteTask.mockResolvedValue(true);
});

describe('retryFailedTask', () => {
  it('should run retry mode in existing worktree and execute directly', async () => {
    const task = makeFailedTask();
    mockConfirm.mockResolvedValue(true);

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(true);
    expect(mockSelectWorkflow).not.toHaveBeenCalled();
    expect(mockRunRetryMode).toHaveBeenCalledWith(
      '/project/.takt/worktrees/my-task',
      expect.objectContaining({
        failure: expect.objectContaining({ taskName: 'my-task', taskContent: 'Do something' }),
      }),
      null,
    );
    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A');
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should execute with selected workflow without mutating taskInfo', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSelectWorkflow.mockResolvedValue('selected-workflow');
    const originalTaskInfo = {
      name: 'my-task',
      content: 'Do something',
      data: { task: 'Do something', workflow: 'original-workflow' },
    };
    mockStartReExecution.mockReturnValue(originalTaskInfo);
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    const executeArg = mockExecuteAndCompleteTask.mock.calls[0]?.[0];
    expect(executeArg).not.toBe(originalTaskInfo);
    expect(executeArg.data).not.toBe(originalTaskInfo.data);
    expect(executeArg.data.workflow).toBe('selected-workflow');
    expect(originalTaskInfo.data.workflow).toBe('original-workflow');
  });

  it('should pass failed step as default to selectOptionWithDefault', async () => {
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      'Start from step:',
      expect.arrayContaining([
        expect.objectContaining({ value: 'plan', description: 'Initial step' }),
        expect.objectContaining({ value: 'implement' }),
        expect.objectContaining({ value: 'review' }),
      ]),
      'review',
    );
  });

  it('should prefer run meta resume_point root step as retry default', async () => {
    mockFindRunForTask.mockReturnValue('run-1');
    mockLoadWorkflowByIdentifier.mockReturnValue({
      ...defaultWorkflowConfig,
      initialStep: 'delegate',
      steps: [
        { name: 'delegate', kind: 'workflow_call', instruction: '', call: 'takt/coding', personaDisplayName: 'delegate', passPreviousResponse: true },
        { name: 'final_review', persona: 'supervisor', instruction: '', personaDisplayName: 'supervisor', passPreviousResponse: true },
      ],
    });
    mockReadRunMetaBySlug.mockReturnValue({
      task: 'Do something',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'failed',
      startTime: '2026-04-13T00:00:00.000Z',
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    });
    const task = makeFailedTask({
      failure: { step: 'review', error: 'Boom' },
    });

    await retryFailedTask(task, '/project');

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      'Start from step:',
      expect.any(Array),
      'delegate',
    );
    expect(mockReadRunMetaBySlug).toHaveBeenCalledWith(
      '/project/.takt/worktrees/my-task',
      'run-1',
      expect.any(Function),
    );
  });

  it('should keep root workflow_call step as retry default when child step was renamed', async () => {
    mockFindRunForTask.mockReturnValue('run-1');
    mockLoadWorkflowByIdentifier.mockReturnValue({
      ...defaultWorkflowConfig,
      initialStep: 'delegate',
      steps: [
        { name: 'delegate', kind: 'workflow_call', instruction: '', call: 'takt/coding', personaDisplayName: 'delegate', passPreviousResponse: true },
        { name: 'final_review', persona: 'supervisor', instruction: '', personaDisplayName: 'supervisor', passPreviousResponse: true },
      ],
    });
    mockReadRunMetaBySlug.mockReturnValue({
      task: 'Do something',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'failed',
      startTime: '2026-04-13T00:00:00.000Z',
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    });

    await retryFailedTask(makeFailedTask(), '/project');

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      'Start from step:',
      expect.any(Array),
      'delegate',
    );
  });

  it('should keep root workflow_call step as retry default when child workflow is gone', async () => {
    mockFindRunForTask.mockReturnValue('run-1');
    mockLoadWorkflowByIdentifier.mockReturnValue({
      ...defaultWorkflowConfig,
      initialStep: 'delegate',
      steps: [
        { name: 'delegate', kind: 'workflow_call', instruction: '', call: 'takt/coding', personaDisplayName: 'delegate', passPreviousResponse: true },
        { name: 'final_review', persona: 'supervisor', instruction: '', personaDisplayName: 'supervisor', passPreviousResponse: true },
      ],
    });
    mockReadRunMetaBySlug.mockReturnValue({
      task: 'Do something',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'failed',
      startTime: '2026-04-13T00:00:00.000Z',
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    });

    await retryFailedTask(makeFailedTask(), '/project');

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      'Start from step:',
      expect.any(Array),
      'delegate',
    );
  });

  it('should pass non-initial step as startStep', async () => {
    const task = makeFailedTask();
    mockSelectOptionWithDefault.mockResolvedValue('implement');

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], 'implement', '追加指示A');
  });

  it('should pass run meta resume_point when selected step matches root workflow_call step', async () => {
    mockFindRunForTask.mockReturnValue('run-1');
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'implement', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    mockReadRunMetaBySlug.mockReturnValue({
      task: 'Do something',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'failed',
      startTime: '2026-04-13T00:00:00.000Z',
      resumePoint,
    });
    mockSelectOptionWithDefault.mockResolvedValue('implement');
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], 'implement', '追加指示A', resumePoint);
  });

  it('should drop run meta resume_point when user selects a different parent step', async () => {
    mockFindRunForTask.mockReturnValue('run-1');
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'implement', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    mockReadRunMetaBySlug.mockReturnValue({
      task: 'Do something',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'failed',
      startTime: '2026-04-13T00:00:00.000Z',
      resumePoint,
    });
    mockSelectOptionWithDefault.mockResolvedValue('review');
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], 'review', '追加指示A');
  });

  it('should not pass startStep when initial step is selected', async () => {
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A');
  });

  it('should append instruction to existing retry note', async () => {
    const task = makeFailedTask({ data: { task: 'Do something', workflow: 'default', retry_note: '既存ノート' } });

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'my-task', ['failed'], undefined, '既存ノート\n\n追加指示A',
    );
  });

  it('should search runs in worktree, not projectDir', async () => {
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockFindRunForTask).toHaveBeenCalledWith('/project/.takt/worktrees/my-task', 'Do something');
  });

  it('should load retry workflow metadata from the existing worktree lookup root', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSelectWorkflow.mockResolvedValue('selected-workflow');

    await retryFailedTask(makeFailedTask(), '/project');

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
      'selected-workflow',
      '/project',
      { lookupCwd: '/project/.takt/worktrees/my-task' },
    );
    expect(mockGetWorkflowDescription).toHaveBeenCalledWith(
      'selected-workflow',
      '/project',
      3,
      '/project/.takt/worktrees/my-task',
    );
  });

  it('should load retry workflow paths relative to the existing worktree lookup root', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSelectWorkflow.mockResolvedValue('./.takt/workflows/selected-workflow.yaml');

    await retryFailedTask(makeFailedTask(), '/project');

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
      './.takt/workflows/selected-workflow.yaml',
      '/project',
      { lookupCwd: '/project/.takt/worktrees/my-task' },
    );
    expect(mockGetWorkflowDescription).toHaveBeenCalledWith(
      './.takt/workflows/selected-workflow.yaml',
      '/project',
      3,
      '/project/.takt/worktrees/my-task',
    );
  });

  it('should reject privileged worktree workflows during retry before selecting a step', async () => {
    const workflow = attachWorkflowTrustInfo(attachWorkflowSourcePath({
      ...defaultWorkflowConfig,
      name: 'selected-workflow',
      runtime: {
        prepare: ['node'],
      },
    }, '/project/.takt/worktrees/my-task/.takt/workflows/selected-workflow.yaml'), {
      source: 'worktree',
      sourcePath: '/project/.takt/worktrees/my-task/.takt/workflows/selected-workflow.yaml',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
    mockConfirm.mockResolvedValue(false);
    mockSelectWorkflow.mockResolvedValue('./.takt/workflows/selected-workflow.yaml');
    mockLoadWorkflowByIdentifier.mockReturnValue(workflow);

    await expect(retryFailedTask(makeFailedTask(), '/project')).rejects.toThrow(
      'cannot use workflow-level runtime.prepare outside the project workflows root',
    );
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
  });

  it('should show deprecated config warning when selected run order uses legacy provider fields', async () => {
    const task = makeFailedTask();
    mockFindPreviousOrderContent.mockReturnValue([
      'steps:',
      '  - name: review',
      '    provider: codex',
      '    model: gpt-5.3',
      '    provider_options:',
      '      codex:',
      '        network_access: true',
    ].join('\n'));

    await retryFailedTask(task, '/project');

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('should warn when run meta parsing fails during retry resume resolution', async () => {
    const task = makeFailedTask();
    mockFindRunForTask.mockReturnValue('run-1');
    mockReadRunMetaBySlug.mockImplementation((_cwd: string, _slug: string, onWarning?: (warning: string) => void) => {
      onWarning?.('Failed to parse run metadata at /tmp/meta.json: broken json');
      return null;
    });

    await retryFailedTask(task, '/project');

    expect(mockWarn).toHaveBeenCalledWith(
      'Failed to parse run metadata at /tmp/meta.json: broken json',
    );
  });

  it('should sanitize failure details before printing to terminal', async () => {
    const task = makeFailedTask({
      name: 'bad\x1b[31m-task\n',
      failure: {
        step: 'review\x1b[2J',
        error: 'Boom\r',
        last_message: 'last\tmessage',
      },
    });

    await retryFailedTask(task, '/project');

    expect(mockHeader).toHaveBeenCalledWith('Failed Task: bad-task\\n');
    expect(mockStatus).toHaveBeenCalledWith('Failed at', 'review', 'red');
    expect(mockStatus).toHaveBeenCalledWith('Error', 'Boom\\r', 'red');
    expect(mockStatus).toHaveBeenCalledWith('Last message', 'last\\tmessage');
  });

  it('should not warn when selected run order uses provider block format', async () => {
    const task = makeFailedTask();
    mockFindPreviousOrderContent.mockReturnValue([
      'steps:',
      '  - name: review',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: true',
    ].join('\n'));

    await retryFailedTask(task, '/project');

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should throw when worktree path is not set', async () => {
    const task = makeFailedTask({ worktreePath: undefined });

    await expect(retryFailedTask(task, '/project')).rejects.toThrow('Worktree path is not set');
  });

  it('should throw when worktree directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const task = makeFailedTask();

    await expect(retryFailedTask(task, '/project')).rejects.toThrow('Worktree directory does not exist');
  });

  it('should return false when workflow selection is cancelled', async () => {
    const task = makeFailedTask();
    mockConfirm.mockResolvedValue(false);
    mockSelectWorkflow.mockResolvedValue(null);

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(false);
    expect(mockLoadWorkflowByIdentifier).not.toHaveBeenCalled();
  });

  it('should return false when retry mode is cancelled', async () => {
    const task = makeFailedTask();
    mockRunRetryMode.mockResolvedValue({ action: 'cancel', task: '' });

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(false);
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should requeue task via requeueTask when save_task action', async () => {
    const task = makeFailedTask();
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A');
    expect(mockStartReExecution).not.toHaveBeenCalled();
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('should requeue task with task.data.resume_point when save_task keeps the root workflow_call step', async () => {
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    mockLoadWorkflowByIdentifier.mockReturnValue({
      ...defaultWorkflowConfig,
      initialStep: 'delegate',
      steps: [
        { name: 'delegate', kind: 'workflow_call', instruction: '', call: 'takt/coding', personaDisplayName: 'delegate', passPreviousResponse: true },
        { name: 'final_review', persona: 'supervisor', instruction: '', personaDisplayName: 'supervisor', passPreviousResponse: true },
      ],
    });
    mockSelectOptionWithDefault.mockResolvedValue('delegate');
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    const task = makeFailedTask({
      data: {
        task: 'Do something',
        workflow: 'default',
        resume_point: resumePoint,
      },
      failure: { step: 'review', error: 'Boom' },
    });

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A', resumePoint);
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should sanitize task name in requeue confirmation', async () => {
    const task = makeFailedTask({ name: 'bad\x1b[31m-task\n' });
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    await retryFailedTask(task, '/project');

    expect(mockInfo).toHaveBeenCalledWith('Task "bad-task\\n" has been requeued.');
  });

  it('should requeue task with existing retry note appended when save_task', async () => {
    const task = makeFailedTask({ data: { task: 'Do something', workflow: 'default', retry_note: '既存ノート' } });
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    await retryFailedTask(task, '/project');

    expect(mockRequeueTask).toHaveBeenCalledWith('my-task', ['failed'], undefined, '既存ノート\n\n追加指示A');
  });

  describe('when previous workflow exists in task data', () => {
    it('should ask whether to reuse previous workflow with default yes', async () => {
      const task = makeFailedTask();

      await retryFailedTask(task, '/project');

      expect(vi.mocked(await import('../shared/i18n/index.js')).getLabel).toHaveBeenCalledWith(
        'retry.usePreviousWorkflowConfirm',
        undefined,
        { workflow: 'default' },
      );
      const reuseConfirmCall = mockConfirm.mock.calls.find(([message]) => message === 'retry.usePreviousWorkflowConfirm');
      expect(reuseConfirmCall?.[1] ?? true).toBe(true);
    });

    it('should use previous workflow when reuse is confirmed', async () => {
      const task = makeFailedTask();
      mockConfirm.mockResolvedValue(true);

      await retryFailedTask(task, '/project');

      expect(mockSelectWorkflow).not.toHaveBeenCalled();
      expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
        'default',
        '/project',
        { lookupCwd: '/project/.takt/worktrees/my-task' },
      );
    });

    it('should reuse previous workflow when only workflow alias is stored', async () => {
      const task = makeFailedTask({ data: { task: 'Do something', workflow: 'default' } });
      mockConfirm.mockResolvedValue(true);

      await retryFailedTask(task, '/project');

      expect(vi.mocked(await import('../shared/i18n/index.js')).getLabel).toHaveBeenCalledWith(
        'retry.usePreviousWorkflowConfirm',
        undefined,
        { workflow: 'default' },
      );
      expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
        'default',
        '/project',
        { lookupCwd: '/project/.takt/worktrees/my-task' },
      );
    });

    it('should call selectWorkflow when reuse is declined', async () => {
      const task = makeFailedTask();
      mockConfirm.mockResolvedValue(false);

      await retryFailedTask(task, '/project');

      expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
    });

    it('should return false when selecting replacement workflow is cancelled after declining reuse', async () => {
      const task = makeFailedTask();
      mockConfirm.mockResolvedValue(false);
      mockSelectWorkflow.mockResolvedValue(null);

      const result = await retryFailedTask(task, '/project');

      expect(result).toBe(false);
      expect(mockLoadWorkflowByIdentifier).not.toHaveBeenCalled();
    });

    it('should skip reuse prompt when task data has no workflow', async () => {
      const task = makeFailedTask({ data: { task: 'Do something' } });

      await retryFailedTask(task, '/project');

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
    });
  });
});
