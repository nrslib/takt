/**
 * Tests for execute task option propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const { mockResolveTaskExecution, mockResolveTaskIssue, mockExecutePiece, mockLoadPieceByIdentifier, mockIsPiecePath, mockResolvePieceConfigValues, mockResolveProviderOptionsWithTrace, mockBuildBooleanTaskResult, mockBuildTaskResult, mockPersistTaskResult, mockPersistPrFailedTaskResult, mockPersistTaskError, mockPostExecutionFlow, mockUpdateRunningTaskExecution } =
  vi.hoisted(() => ({
    mockResolveTaskExecution: vi.fn(),
    mockResolveTaskIssue: vi.fn(),
    mockExecutePiece: vi.fn(),
    mockLoadPieceByIdentifier: vi.fn(),
    mockIsPiecePath: vi.fn(() => false),
    mockResolvePieceConfigValues: vi.fn(),
    mockResolveProviderOptionsWithTrace: vi.fn(),
    mockBuildBooleanTaskResult: vi.fn(),
    mockBuildTaskResult: vi.fn(),
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

vi.mock('../features/tasks/execute/pieceExecution.js', () => ({
  executePiece: (...args: unknown[]) => mockExecutePiece(...args),
}));

vi.mock('../features/tasks/execute/taskResultHandler.js', () => ({
  buildBooleanTaskResult: (...args: unknown[]) => mockBuildBooleanTaskResult(...args),
  buildTaskResult: (...args: unknown[]) => mockBuildTaskResult(...args),
  persistTaskResult: (...args: unknown[]) => mockPersistTaskResult(...args),
  persistPrFailedTaskResult: (...args: unknown[]) => mockPersistPrFailedTaskResult(...args),
  persistTaskError: (...args: unknown[]) => mockPersistTaskError(...args),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: (...args: unknown[]) => mockPostExecutionFlow(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPieceByIdentifier: (...args: unknown[]) => mockLoadPieceByIdentifier(...args),
  isPiecePath: (...args: unknown[]) => mockIsPiecePath(...args),
  resolvePieceConfigValues: (...args: unknown[]) => mockResolvePieceConfigValues(...args),
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
import { error, info } from '../shared/ui/index.js';

const createTask = (name: string): TaskInfo => ({
  name,
  content: `Task: ${name}`,
  filePath: `/tasks/${name}.yaml`,
  createdAt: '2026-02-16T00:00:00.000Z',
  status: 'pending',
  data: { task: `Task: ${name}`, piece: 'default' },
});

function createTaskRunnerMock() {
  return {
    updateRunningTaskExecution: mockUpdateRunningTaskExecution,
  };
}

const executeAndCompleteTaskWithoutPiece = executeAndCompleteTask as (
  task: TaskInfo,
  taskRunner: unknown,
  projectCwd: string,
  executeOptions?: unknown,
  parallelOptions?: unknown,
) => Promise<boolean>;
const mockError = vi.mocked(error);
const mockInfo = vi.mocked(info);

describe('executeAndCompleteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadPieceByIdentifier.mockReturnValue({
      name: 'default',
      movements: [],
    });
    mockIsPiecePath.mockReturnValue(false);
    mockResolvePieceConfigValues.mockReturnValue({
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
      execPiece: 'default',
      isWorktree: false,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task',
      branch: undefined,
      worktreePath: undefined,
      baseBranch: undefined,
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockResolveTaskIssue.mockReturnValue(undefined);
    mockUpdateRunningTaskExecution.mockImplementation((taskName: string, execution: { runSlug: string; worktreePath?: string; branch?: string }) => ({
      ...createTask(taskName),
      status: 'running',
      runSlug: execution.runSlug,
      worktreePath: execution.worktreePath,
      data: {
        task: `Task: ${taskName}`,
        piece: 'default',
        ...(execution.branch ? { branch: execution.branch } : {}),
      },
    }));
  });

  it('should pass taskDisplayLabel from parallel options into executePiece', async () => {
    const task = createTask('task-with-issue');
    const taskDisplayLabel = '#12345';
    const abortController = new AbortController();

    await executeAndCompleteTaskWithoutPiece(
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

    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      taskDisplayLabel?: string;
      taskPrefix?: string;
      providerOptions?: unknown;
      providerOptionsSource?: string;
      providerOptionsOriginResolver?: (path: string) => string;
    };
    expect(pieceExecutionOptions?.taskDisplayLabel).toBe(taskDisplayLabel);
    expect(pieceExecutionOptions?.taskPrefix).toBe(taskDisplayLabel);
    expect(pieceExecutionOptions?.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(pieceExecutionOptions?.providerOptionsSource).toBe('project');
    expect(pieceExecutionOptions?.providerOptionsOriginResolver?.('claude.sandbox.allowUnsandboxedCommands'))
      .toBe('local');
    expect(mockUpdateRunningTaskExecution).toHaveBeenCalledWith('task-with-issue', {
      runSlug: '20260216-task',
    });
  });

  it('should not pass config provider/model to executePiece when agent overrides are absent', async () => {
    const task = createTask('task-with-defaults');

    await executeTask({
      task: task.content,
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: 'default',
    });

    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      provider?: string;
      model?: string;
    };
    expect(pieceExecutionOptions?.provider).toBeUndefined();
    expect(pieceExecutionOptions?.model).toBeUndefined();
  });

  it('should pass agent overrides to executePiece when provided', async () => {
    const task = createTask('task-with-overrides');

    await executeTask({
      task: task.content,
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: 'default',
      agentOverrides: {
        provider: 'codex',
        model: 'gpt-5.3-codex',
      },
    });

    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      provider?: string;
      model?: string;
    };
    expect(pieceExecutionOptions?.provider).toBe('codex');
    expect(pieceExecutionOptions?.model).toBe('gpt-5.3-codex');
  });

  it('should pass pieceUserInputHandler and interactiveUserInput to executeTask → executePiece', async () => {
    const task = createTask('task-piece-user-input');

    await executeTask({
      task: task.content,
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: 'default',
      interactiveUserInput: false,
      pieceUserInputHandler: true,
    });

    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      interactiveUserInput?: boolean;
      pieceUserInputHandler?: boolean;
    };
    expect(pieceExecutionOptions?.interactiveUserInput).toBe(false);
    expect(pieceExecutionOptions?.pieceUserInputHandler).toBe(true);
  });

  it('should use workflow terminology when named workflow is missing', async () => {
    mockLoadPieceByIdentifier.mockReturnValueOnce(undefined);

    const result = await executeTask({
      task: 'Task: missing workflow',
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: 'missing-workflow',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith('Workflow "missing-workflow" not found.');
    expect(mockInfo).toHaveBeenCalledWith('Available workflows are searched in .takt/workflows/, .takt/pieces/, ~/.takt/workflows/, then ~/.takt/pieces/.');
    expect(mockInfo).toHaveBeenCalledWith('If the same workflow name exists in multiple locations, project workflows/ take priority over project pieces/, then user workflows/, then user pieces/.');
    expect(mockInfo).toHaveBeenCalledWith('Specify a valid workflow when creating tasks (e.g., via "takt add").');
  });

  it('should use workflow file terminology when workflow path is missing', async () => {
    mockLoadPieceByIdentifier.mockReturnValueOnce(undefined);
    mockIsPiecePath.mockReturnValueOnce(true);

    const result = await executeTask({
      task: 'Task: missing workflow file',
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: './custom-workflow.yaml',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith('Workflow file not found: ./custom-workflow.yaml');
    expect(mockInfo).not.toHaveBeenCalledWith('Available workflows are searched in .takt/workflows/, .takt/pieces/, ~/.takt/workflows/, then ~/.takt/pieces/.');
  });

  it('should sanitize workflow identifiers in terminal errors', async () => {
    mockLoadPieceByIdentifier.mockReturnValueOnce(undefined);

    const result = await executeTask({
      task: 'Task: missing workflow',
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: 'bad\x1b[31m-name\n',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith('Workflow "bad-name\\n" not found.');
  });

  it('should mark task as pr_failed when PR creation fails', async () => {
    const task = createTask('task-with-pr-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      execPiece: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-pr-failure',
      branch: 'takt/task-with-pr-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({ prFailed: true, prError: 'Base ref must be a branch' });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task-projectdir-nff',
      branch: 'takt/task-projectdir-nff',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    const prError =
      'Failed to push branch to origin. Command failed: git push\n' +
      '! [rejected] (non-fast-forward)\n' +
      'Push rejected (non-fast-forward): remote is ahead; resync or recreate worktree; stale local branch may apply.';
    mockPostExecutionFlow.mockResolvedValue({ prFailed: true, prError });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-pr-success',
      branch: 'takt/task-with-pr-success',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-issue-pr',
      branch: 'takt/18/task-with-issue-pr',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: 18,
    });
    mockResolveTaskIssue.mockReturnValue([issue]);
    mockPostExecutionFlow.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/18' });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-publish-origin',
      branch: 'takt/task-publish-origin',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({});

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      taskPrompt: undefined,
      reportDirName: '20260216-task-pr-style-push-failure',
      branch: 'takt/task-pr-style-push-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({
      prFailed: true,
      prError: 'Failed to push branch to origin. non-fast-forward',
    });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-autocommit-failure',
      branch: 'takt/task-with-autocommit-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({
      taskFailed: true,
      taskError: 'Auto-commit failed before PR creation.',
    });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
      execPiece: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
      taskPrompt: undefined,
      reportDirName: '20260216-task-with-local-push-failure',
      branch: 'takt/task-with-local-push-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({
      taskFailed: true,
      taskError: 'Push to main repo failed after commit creation.',
    });

    const result = await executeAndCompleteTaskWithoutPiece(task, createTaskRunnerMock() as never, '/project');

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
