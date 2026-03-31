/**
 * Tests for execute task option propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const { mockResolveTaskExecution, mockExecutePiece, mockLoadPieceByIdentifier, mockIsPiecePath, mockResolvePieceConfigValues, mockResolveProviderOptionsWithTrace, mockBuildBooleanTaskResult, mockBuildTaskResult, mockPersistTaskResult, mockPersistPrFailedTaskResult, mockPersistTaskError, mockPostExecutionFlow } =
  vi.hoisted(() => ({
    mockResolveTaskExecution: vi.fn(),
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
  }));

vi.mock('../features/tasks/execute/resolveTask.js', () => ({
  resolveTaskExecution: (...args: unknown[]) => mockResolveTaskExecution(...args),
  resolveTaskIssue: vi.fn(),
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
      taskPrompt: undefined,
      reportDirName: undefined,
      branch: undefined,
      worktreePath: undefined,
      baseBranch: undefined,
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
  });

  it('should pass taskDisplayLabel from parallel options into executePiece', async () => {
    // Given: Parallel execution passes an issue-style taskDisplayLabel.
    const task = createTask('task-with-issue');
    const taskDisplayLabel = '#12345';
    const abortController = new AbortController();

    // When
    await executeAndCompleteTaskWithoutPiece(
      task,
      {} as never,
      '/project',
      undefined,
      {
        abortSignal: abortController.signal,
        taskPrefix: taskDisplayLabel,
        taskColorIndex: 0,
        taskDisplayLabel,
      },
    );

    // Then: executePiece receives the propagated display label.
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
  });

  it('should not pass config provider/model to executePiece when agent overrides are absent', async () => {
    // Given: project config contains provider/model, but overrides are omitted.
    const task = createTask('task-with-defaults');

    // When
    await executeTask({
      task: task.content,
      cwd: '/project',
      projectCwd: '/project',
      pieceIdentifier: 'default',
    });

    // Then: piece options should not force provider/model from taskExecution layer
    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      provider?: string;
      model?: string;
    };
    expect(pieceExecutionOptions?.provider).toBeUndefined();
    expect(pieceExecutionOptions?.model).toBeUndefined();
  });

  it('should pass agent overrides to executePiece when provided', async () => {
    // Given: overrides explicitly specified by caller.
    const task = createTask('task-with-overrides');

    // When
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

    // Then
    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      provider?: string;
      model?: string;
    };
    expect(pieceExecutionOptions?.provider).toBe('codex');
    expect(pieceExecutionOptions?.model).toBe('gpt-5.3-codex');
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
    // Given: worktree mode with autoPr enabled, PR creation fails
    const task = createTask('task-with-pr-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      execPiece: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      taskPrompt: undefined,
      reportDirName: undefined,
      branch: 'takt/task-with-pr-failure',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({ prFailed: true, prError: 'Base ref must be a branch' });

    // When
    const result = await executeAndCompleteTaskWithoutPiece(task, {} as never, '/project');

    // Then: code succeeded, task is marked as pr_failed (not failed)
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

  it('should mark task as completed when PR creation succeeds', async () => {
    // Given: worktree mode with autoPr enabled, PR creation succeeds
    const task = createTask('task-with-pr-success');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      execPiece: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      taskPrompt: undefined,
      reportDirName: undefined,
      branch: 'takt/task-with-pr-success',
      worktreePath: '/worktree/clone',
      baseBranch: 'main',
      startMovement: undefined,
      retryNote: undefined,
      issueNumber: undefined,
    });
    mockExecutePiece.mockResolvedValue({ success: true });
    mockPostExecutionFlow.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' });

    // When
    const result = await executeAndCompleteTaskWithoutPiece(task, {} as never, '/project');

    // Then: task should be marked as completed
    expect(result).toBe(true);
    expect(mockBuildTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runResult: expect.objectContaining({ success: true }),
        prUrl: 'https://github.com/org/repo/pull/1',
      }),
    );
  });

  it('should mark task as failed when postExecution returns a non-PR failure', async () => {
    const task = createTask('task-with-autocommit-failure');
    mockResolveTaskExecution.mockResolvedValue({
      execCwd: '/worktree/clone',
      execPiece: 'default',
      isWorktree: true,
      autoPr: false,
      draftPr: false,
      taskPrompt: undefined,
      reportDirName: undefined,
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

    const result = await executeAndCompleteTaskWithoutPiece(task, {} as never, '/project');

    expect(result).toBe(false);
    expect(mockBuildBooleanTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        task,
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
      taskPrompt: undefined,
      reportDirName: undefined,
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

    const result = await executeAndCompleteTaskWithoutPiece(task, {} as never, '/project');

    expect(result).toBe(false);
    expect(mockBuildBooleanTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        task,
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
