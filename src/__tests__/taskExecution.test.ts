/**
 * Tests for execute task option propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const { mockResolveTaskExecution, mockExecutePiece, mockLoadPieceByIdentifier, mockResolvePieceConfigValues, mockResolveConfigValueWithSource, mockBuildTaskResult, mockPersistTaskResult, mockPersistTaskError, mockPostExecutionFlow } =
  vi.hoisted(() => ({
    mockResolveTaskExecution: vi.fn(),
    mockExecutePiece: vi.fn(),
    mockLoadPieceByIdentifier: vi.fn(),
    mockResolvePieceConfigValues: vi.fn(),
    mockResolveConfigValueWithSource: vi.fn(),
    mockBuildTaskResult: vi.fn(),
    mockPersistTaskResult: vi.fn(),
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
  buildTaskResult: (...args: unknown[]) => mockBuildTaskResult(...args),
  persistTaskResult: (...args: unknown[]) => mockPersistTaskResult(...args),
  persistTaskError: (...args: unknown[]) => mockPersistTaskError(...args),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: (...args: unknown[]) => mockPostExecutionFlow(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPieceByIdentifier: (...args: unknown[]) => mockLoadPieceByIdentifier(...args),
  isPiecePath: () => false,
  resolvePieceConfigValues: (...args: unknown[]) => mockResolvePieceConfigValues(...args),
  resolveConfigValueWithSource: (...args: unknown[]) => mockResolveConfigValueWithSource(...args),
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

import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';

const createTask = (name: string): TaskInfo => ({
  name,
  content: `Task: ${name}`,
  filePath: `/tasks/${name}.yaml`,
  createdAt: '2026-02-16T00:00:00.000Z',
  status: 'pending',
  data: { task: `Task: ${name}` },
});

describe('executeAndCompleteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadPieceByIdentifier.mockReturnValue({
      name: 'default',
      movements: [],
    });
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
    mockResolveConfigValueWithSource.mockReturnValue({
      value: {
        claude: { sandbox: { allowUnsandboxedCommands: true } },
      },
      source: 'project',
    });
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
    await executeAndCompleteTask(task, {} as never, '/project', 'default', undefined, {
      abortSignal: abortController.signal,
      taskPrefix: taskDisplayLabel,
      taskColorIndex: 0,
      taskDisplayLabel,
    });

    // Then: executePiece receives the propagated display label.
    expect(mockExecutePiece).toHaveBeenCalledTimes(1);
    const pieceExecutionOptions = mockExecutePiece.mock.calls[0]?.[3] as {
      taskDisplayLabel?: string;
      taskPrefix?: string;
      providerOptions?: unknown;
      providerOptionsSource?: string;
    };
    expect(pieceExecutionOptions?.taskDisplayLabel).toBe(taskDisplayLabel);
    expect(pieceExecutionOptions?.taskPrefix).toBe(taskDisplayLabel);
    expect(pieceExecutionOptions?.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(pieceExecutionOptions?.providerOptionsSource).toBe('project');
  });
});
