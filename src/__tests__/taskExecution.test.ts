/**
 * Tests for execute task option propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';
import { attachWorkflowSourcePath, attachWorkflowTrustInfo } from '../infra/config/loaders/workflowSourceMetadata.js';

const { mockResolveTaskExecution, mockResolveTaskIssue, mockExecuteWorkflow, mockExecuteWorkflowForRun, mockLoadWorkflowByIdentifier, mockIsWorkflowPath, mockResolveWorkflowConfigValues, mockResolveProviderOptionsWithTrace, mockBuildBooleanTaskResult, mockBuildTaskResult, mockPersistExceededTaskResult, mockPersistTaskResult, mockPersistPrFailedTaskResult, mockPersistTaskError, mockPostExecutionFlow, mockUpdateRunningTaskExecution } =
  vi.hoisted(() => ({
    mockResolveTaskExecution: vi.fn(),
    mockResolveTaskIssue: vi.fn(),
    mockExecuteWorkflow: vi.fn(),
    mockExecuteWorkflowForRun: vi.fn(),
    mockLoadWorkflowByIdentifier: vi.fn(),
    mockIsWorkflowPath: vi.fn(() => false),
    mockResolveWorkflowConfigValues: vi.fn(),
    mockResolveProviderOptionsWithTrace: vi.fn(),
    mockBuildBooleanTaskResult: vi.fn(),
    mockBuildTaskResult: vi.fn(),
    mockPersistExceededTaskResult: vi.fn(),
    mockPersistTaskResult: vi.fn(),
    mockPersistPrFailedTaskResult: vi.fn(),
    mockPersistTaskError: vi.fn(),
    mockPostExecutionFlow: vi.fn(),
    mockUpdateRunningTaskExecution: vi.fn(),
  }));

vi.mock('../features/tasks/execute/resolveTask.js', () => ({
  resolveTaskExecution: (...args: unknown[]) => mockResolveTaskExecution(...args),
  resolveTaskIssue: (...args: unknown[]) => mockResolveTaskIssue(...args),
}));

vi.mock('../features/tasks/execute/workflowExecution.js', () => ({
  executeWorkflow: (...args: unknown[]) => mockExecuteWorkflow(...args),
  executeWorkflowForRun: (...args: unknown[]) => mockExecuteWorkflowForRun(...args),
}));

vi.mock('../features/tasks/execute/taskResultHandler.js', () => ({
  buildBooleanTaskResult: (...args: unknown[]) => mockBuildBooleanTaskResult(...args),
  buildTaskResult: (...args: unknown[]) => mockBuildTaskResult(...args),
  persistExceededTaskResult: (...args: unknown[]) => mockPersistExceededTaskResult(...args),
  persistTaskResult: (...args: unknown[]) => mockPersistTaskResult(...args),
  persistPrFailedTaskResult: (...args: unknown[]) => mockPersistPrFailedTaskResult(...args),
  persistTaskError: (...args: unknown[]) => mockPersistTaskError(...args),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: (...args: unknown[]) => mockPostExecutionFlow(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: (...args: unknown[]) => mockLoadWorkflowByIdentifier(...args),
  isWorkflowPath: (...args: unknown[]) => mockIsWorkflowPath(...args),
  resolveWorkflowConfigValues: (...args: unknown[]) => mockResolveWorkflowConfigValues(...args),
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProviderOptionsWithTrace: (...args: unknown[]) => mockResolveProviderOptionsWithTrace(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  status: vi.fn(),
  success: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: vi.fn((error: unknown) => String(error)),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string) => key),
}));

import { executeAndCompleteTask, executeTask } from '../features/tasks/execute/taskExecution.js';
import { executeRunTaskAndComplete } from '../features/tasks/execute/runTaskExecution.js';
import { error, info } from '../shared/ui/index.js';

const createTask = (name: string): TaskInfo => ({
  name,
  content: `Task: ${name}`,
  filePath: `/tasks/${name}.yaml`,
  createdAt: '2026-02-16T00:00:00.000Z',
  status: 'pending',
  data: { task: `Task: ${name}`, workflow: 'default' },
});

function createTaskRunnerMock() {
  return {
    updateRunningTaskExecution: mockUpdateRunningTaskExecution,
  };
}

const executeAndCompleteTaskWithoutWorkflow = executeAndCompleteTask as (
  task: TaskInfo,
  taskRunner: unknown,
  projectCwd: string,
  executeOptions?: unknown,
  parallelOptions?: unknown,
) => Promise<boolean>;
const executeRunTaskAndCompleteWithRunOptions = executeRunTaskAndComplete as unknown as (
  task: TaskInfo,
  taskRunner: unknown,
  projectCwd: string,
  executeOptions?: unknown,
  parallelOptions?: unknown,
  runOptions?: unknown,
) => Promise<boolean>;
const mockError = vi.mocked(error);
const mockInfo = vi.mocked(info);

describe('executeAndCompleteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadWorkflowByIdentifier.mockReturnValue({
      name: 'default',
      steps: [],
    });
    mockIsWorkflowPath.mockReturnValue(false);
    mockResolveWorkflowConfigValues.mockReturnValue({
      language: 'en',
      provider: 'claude',
      model: undefined,
      personaProviders: {},
      providerProfiles: {},
      notificationSound: true,
      notificationSoundEvents: {},
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    mockResolveProviderOptionsWithTrace.mockReturnValue({
      value: {
        claude: { sandbox: { allowUnsandboxedCommands: true } },
      },
      source: 'project',
      originResolver: () => 'local',
    });
    mockBuildBooleanTaskResult.mockReturnValue({ success: false });
    mockBuildTaskResult.mockReturnValue({ success: true });
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/project',
      workflowIdentifier: 'default',
      isWorktree: false,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task',
      branch: undefined,
      worktreePath: undefined,
      baseBranch: undefined,
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockExecuteWorkflowForRun.mockResolvedValue({ success: true });
    mockResolveTaskIssue.mockReturnValue(undefined);
    mockUpdateRunningTaskExecution.mockImplementation((taskName: string, execution: { runSlug: string; worktreePath?: string; branch?: string }) => ({
      ...createTask(taskName),
      status: 'running',
      runSlug: execution.runSlug,
      worktreePath: execution.worktreePath,
      data: {
        task: `Task: ${taskName}`,
        workflow: 'default',
        ...(execution.branch ? { branch: execution.branch } : {}),
      },
    }));
  });

  it('should pass taskDisplayLabel from parallel options into executeWorkflow', async () => {
    const task = createTask('task-with-issue');
    const taskDisplayLabel = '#12345';
    const abortController = new AbortController();

    await executeAndCompleteTaskWithoutWorkflow(
      task,
      createTaskRunnerMock() as never,
      '/project',
      undefined,
      {
        abortSignal: abortController.signal,
        taskPrefix: taskDisplayLabel,
        taskColorIndex: 0,
        taskDisplayLabel,
      },
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const workflowExecutionOptions = mockExecuteWorkflow.mock.calls[0]?.[3] as {
      taskDisplayLabel?: string;
      taskPrefix?: string;
      providerOptions?: unknown;
      providerOptionsSource?: string;
      providerOptionsOriginResolver?: (path: string) => string;
    };
    expect(workflowExecutionOptions?.taskDisplayLabel).toBe(taskDisplayLabel);
    expect(workflowExecutionOptions?.taskPrefix).toBe(taskDisplayLabel);
    expect(workflowExecutionOptions?.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(workflowExecutionOptions?.providerOptionsSource).toBe('project');
    expect(workflowExecutionOptions?.providerOptionsOriginResolver?.('claude.sandbox.allowUnsandboxedCommands'))
      .toBe('local');
    expect(mockUpdateRunningTaskExecution).toHaveBeenCalledWith('task-with-issue', {
      runSlug: '20260216-task',
    });
  });

  it('should pass ignoreIterationLimit from run execution context into executeWorkflow', async () => {
    const task = createTask('task-ignore-exceed');

    await executeRunTaskAndCompleteWithRunOptions(
      task,
      createTaskRunnerMock() as never,
      '/project',
      undefined,
      undefined,
      { ignoreIterationLimit: true },
    );

    expect(mockExecuteWorkflowForRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    const workflowExecutionOptions = mockExecuteWorkflowForRun.mock.calls[0]?.[3] as {
      projectCwd?: string;
    };
    const runContext = mockExecuteWorkflowForRun.mock.calls[0]?.[4] as {
      ignoreIterationLimit?: boolean;
    };
    expect(workflowExecutionOptions?.projectCwd).toBe('/project');
    expect(runContext?.ignoreIterationLimit).toBe(true);
  });

  it('should not pass config provider/model to executeWorkflow when agent overrides are absent', async () => {
    const task = createTask('task-with-defaults');

    await executeTask({
      task: task.content,
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: 'default',
    });

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const workflowExecutionOptions = mockExecuteWorkflow.mock.calls[0]?.[3] as {
      provider?: string;
      model?: string;
    };
    expect(workflowExecutionOptions?.provider).toBeUndefined();
    expect(workflowExecutionOptions?.model).toBeUndefined();
  });

  it('should pass agent overrides to executeWorkflow when provided', async () => {
    const task = createTask('task-with-overrides');

    await executeTask({
      task: task.content,
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: 'default',
      agentOverrides: {
        provider: 'codex',
        model: 'gpt-5.3-codex',
      },
    });

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const workflowExecutionOptions = mockExecuteWorkflow.mock.calls[0]?.[3] as {
      provider?: string;
      model?: string;
    };
    expect(workflowExecutionOptions?.provider).toBe('codex');
    expect(workflowExecutionOptions?.model).toBe('gpt-5.3-codex');
  });

  it('should pass only currentTaskIssueNumber to executeWorkflow for system-step context', async () => {
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/project',
      workflowIdentifier: 'default',
      isWorktree: false,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task',
      branch: undefined,
      worktreePath: undefined,
      baseBranch: undefined,
      startStep: undefined,
      retryNote: undefined,
      issueNumber: 586,
    });

    await executeAndCompleteTaskWithoutWorkflow(
      createTask('task-with-issue-context'),
      createTaskRunnerMock() as never,
      '/project',
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const workflowExecutionOptions = mockExecuteWorkflow.mock.calls[0]?.[3] as {
      currentTaskIssueNumber?: number;
      currentTaskName?: string;
    };
    expect(workflowExecutionOptions?.currentTaskIssueNumber).toBe(586);
    expect('currentTaskName' in (workflowExecutionOptions ?? {})).toBe(false);
  });

  it('should resolve workflow paths relative to execCwd when running inside a worktree', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValue({
      name: 'worktree-default',
      steps: [],
    });
    mockIsWorkflowPath.mockReturnValue(true);

    await executeTask({
      task: 'Task: worktree lookup',
      cwd: '/project/.takt/worktrees/task-a',
      projectCwd: '/project',
      workflowIdentifier: './.takt/workflows/default.yaml',
    });

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
      './.takt/workflows/default.yaml',
      '/project',
      { lookupCwd: '/project/.takt/worktrees/task-a' },
    );
    expect(mockExecuteWorkflow.mock.calls[0]?.[0]).toMatchObject({
      name: 'worktree-default',
    });
  });

  it('should reject privileged worktree workflows before execution', async () => {
    const workflow = attachWorkflowTrustInfo(attachWorkflowSourcePath({
      name: 'worktree-privileged',
      runtime: {
        prepare: ['node'],
      },
      steps: [
        {
          name: 'review',
          kind: 'agent',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'Review',
          passPreviousResponse: true,
        },
      ],
      initialStep: 'review',
      maxSteps: 3,
    }, '/project/.takt/worktrees/task-a/.takt/workflows/worktree-privileged.yaml'), {
      source: 'worktree',
      sourcePath: '/project/.takt/worktrees/task-a/.takt/workflows/worktree-privileged.yaml',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
    mockLoadWorkflowByIdentifier.mockReturnValue(workflow);

    await expect(executeTask({
      task: 'Task: worktree trust boundary',
      cwd: '/project/.takt/worktrees/task-a',
      projectCwd: '/project',
      workflowIdentifier: './.takt/workflows/worktree-privileged.yaml',
    })).rejects.toThrow('cannot use workflow-level runtime.prepare outside the project workflows root');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('should use workflow terminology when named workflow is missing', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);

    const result = await executeTask({
      task: 'Task: missing workflow',
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: 'missing-workflow',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith('Workflow "missing-workflow" not found.');
    expect(mockInfo).toHaveBeenCalledWith('Available workflows are searched in .takt/workflows/ and ~/.takt/workflows/.');
    expect(mockInfo).toHaveBeenCalledWith('If the same workflow name exists in multiple locations, project workflows/ take priority over user workflows/.');
    expect(mockInfo).toHaveBeenCalledWith('Specify a valid workflow when creating tasks (e.g., via "takt add").');
  });

  it('should use workflow file terminology when workflow path is missing', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);
    mockIsWorkflowPath.mockReturnValueOnce(true);

    const result = await executeTask({
      task: 'Task: missing workflow file',
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: './custom-workflow.yaml',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith('Workflow file not found: ./custom-workflow.yaml');
    expect(mockInfo).not.toHaveBeenCalledWith('Available workflows are searched in .takt/workflows/ and ~/.takt/workflows/.');
  });

  it('should sanitize workflow identifiers in terminal errors', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);

    const result = await executeTask({
      task: 'Task: missing workflow',
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: 'bad\x1b[31m-name\n',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith('Workflow "bad-name\\n" not found.');
  });

  it('should mark task as pr_failed when PR creation fails', async () => {
    const task = createTask('task-with-pr-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-pr-failure',
      branch: 'takt/task-with-pr-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({ prFailed: true, prError: 'Base ref must be a branch' });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(true);
    expect(mockBuildTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runResult: expect.objectContaining({ success: true }),
      }),
    );
    expect(mockPersistPrFailedTaskResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Base ref must be a branch',
    );
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
  });

  it('should persist full projectDir pushBranch non-fast-forward diagnostics in pr_failed', async () => {
    const task = createTask('task-projectdir-nff');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task-projectdir-nff',
      branch: 'takt/task-projectdir-nff',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    const prError =
      'Failed to push branch to origin. Command failed: git push\n' +
      '! [rejected] (non-fast-forward)\n' +
      'Push rejected (non-fast-forward): remote is ahead; resync or recreate worktree; stale local branch may apply.';
    mockPostExecutionFlow.mockResolvedValue({ prFailed: true, prError });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(true);
    expect(mockPersistPrFailedTaskResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      prError,
    );
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
  });

  it('should mark task as completed when PR creation succeeds', async () => {
    const task = createTask('task-with-pr-success');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-pr-success',
      branch: 'takt/task-with-pr-success',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(true);
    expect(mockBuildTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runResult: expect.objectContaining({ success: true }),
        prUrl: 'https://github.com/org/repo/pull/1',
      }),
    );
  });

  it('should resolve PR issue metadata using project cwd in worktree mode', async () => {
    const task = createTask('task-with-issue-pr');
    const issue = { number: 18, title: 'Issue', body: 'Body', labels: [], comments: [] };

    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-issue-pr',
      branch: 'takt/18/task-with-issue-pr',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: 18,
    });
    mockResolveTaskIssue.mockReturnValue([issue]);
    mockPostExecutionFlow.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/18' });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(true);
    expect(mockResolveTaskIssue).toHaveBeenCalledWith(18, '/project');
    expect(mockPostExecutionFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        execCwd: '/worktree/clone',
        projectCwd: '/project',
        issues: [issue],
      }),
    );
  });

  it('should pass shouldPublishBranchToOrigin from resolveTaskExecution into postExecutionFlow', async () => {
    const task = createTask('task-publish-origin');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-publish-origin',
      branch: 'takt/task-publish-origin',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({});

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(true);
    expect(mockPostExecutionFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldCreatePr: false,
        shouldPublishBranchToOrigin: true,
        branch: 'takt/task-publish-origin',
        execCwd: '/worktree/clone',
      }),
    );
  });

  it('should mark task as pr_failed when origin push fails for shouldPublishBranchToOrigin without auto_pr', async () => {
    const task = createTask('task-pr-style-push-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-pr-style-push-failure',
      branch: 'takt/task-pr-style-push-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({
      prFailed: true,
      prError: 'Failed to push branch to origin. non-fast-forward',
    });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(true);
    expect(mockPersistPrFailedTaskResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Failed to push branch to origin. non-fast-forward',
    );
    expect(mockBuildBooleanTaskResult).not.toHaveBeenCalled();
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
  });

  it('should mark task as failed when postExecution returns a non-PR failure', async () => {
    const task = createTask('task-with-autocommit-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-autocommit-failure',
      branch: 'takt/task-with-autocommit-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({
      taskFailed: true,
      taskError: 'Auto-commit failed before PR creation.',
    });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(false);
    expect(mockBuildBooleanTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          name: task.name,
          runSlug: '20260216-task-with-autocommit-failure',
          worktreePath: '/worktree/clone',
          status: 'running',
        }),
        taskSuccess: false,
        failureResponse: 'Auto-commit failed before PR creation.',
        branch: 'takt/task-with-autocommit-failure',
        worktreePath: '/worktree/clone',
      }),
    );
    expect(mockPersistTaskResult).toHaveBeenCalledTimes(1);
    expect(mockPersistPrFailedTaskResult).not.toHaveBeenCalled();
    expect(mockBuildTaskResult).not.toHaveBeenCalled();
  });

  it('should mark task as failed when local push fails for a worktree task without PR creation', async () => {
    const task = createTask('task-with-local-push-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-local-push-failure',
      branch: 'takt/task-with-local-push-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startStep: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecuteWorkflow.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({
      taskFailed: true,
      taskError: 'Push to main repo failed after commit creation.',
    });

    const result = await executeAndCompleteTaskWithoutWorkflow(task, createTaskRunnerMock() as never, '/project');

    expect(result).toBe(false);
    expect(mockBuildBooleanTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          name: task.name,
          runSlug: '20260216-task-with-local-push-failure',
          worktreePath: '/worktree/clone',
          status: 'running',
        }),
        taskSuccess: false,
        failureResponse: 'Push to main repo failed after commit creation.',
        branch: 'takt/task-with-local-push-failure',
        worktreePath: '/worktree/clone',
      }),
    );
    expect(mockPersistTaskResult).toHaveBeenCalledTimes(1);
    expect(mockPersistPrFailedTaskResult).not.toHaveBeenCalled();
    expect(mockBuildTaskResult).not.toHaveBeenCalled();
  });
});
