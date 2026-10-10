import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskInfo, TaskResult, TaskRunner } from '../infra/task/index.js';
import type { buildBooleanTaskResult } from '../features/tasks/execute/taskResultHandler.js';
import type { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';

type AddTaskArgs = Parameters<TaskRunner['addTask']>;
type BuildBooleanTaskResultArgs = Parameters<typeof buildBooleanTaskResult>;

const {
  mockAddTask,
  mockExecuteTask,
  mockPersistTaskResult,
  mockPersistTaskError,
  mockBuildBooleanTaskResult,
} = vi.hoisted(() => ({
  mockAddTask: vi.fn((
    _content: AddTaskArgs[0],
    _options?: AddTaskArgs[1],
  ): TaskInfo => ({
    name: 'test-task',
    content: 'test task',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'pending',
    data: { task: 'test task' },
  })),
  mockExecuteTask: vi.fn<typeof executeTaskWithResult>(),
  mockPersistTaskResult: vi.fn(),
  mockPersistTaskError: vi.fn(),
  mockBuildBooleanTaskResult: vi.fn((
    params: BuildBooleanTaskResultArgs[0],
  ): TaskResult => ({
    task: params.task,
    success: params.taskSuccess,
    response: params.taskSuccess ? params.successResponse : params.failureResponse,
    executionLog: [],
    startedAt: params.startedAt,
    completedAt: params.completedAt,
  })),
}));

vi.mock('../shared/prompt/index.js', () => ({
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValue: vi.fn(),
  loadWorkflowByIdentifier: vi.fn(() => ({ name: 'default' })),
  listWorkflows: vi.fn(() => ['default']),
  listWorkflowEntries: vi.fn(() => []),
  isWorkflowPath: vi.fn(() => false),
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
  buildTaskInstruction: vi.fn((_taskDir: string, orderFile: string) => `Primary spec: \`${orderFile}\`.`),
  TaskRunner: vi.fn(() => ({
    addTask: (...args: AddTaskArgs) => mockAddTask(...args),
  })),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  withProgress: async <T>(
    _startMessage: string,
    _completionMessage: string | ((result: T) => string),
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/github/index.js', () => ({
  buildPrBody: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTaskWithResult: mockExecuteTask,
}));

vi.mock('../features/tasks/execute/taskResultHandler.js', () => ({
  buildBooleanTaskResult: (...args: BuildBooleanTaskResultArgs) => mockBuildBooleanTaskResult(...args),
  persistTaskResult: (...args: unknown[]) => mockPersistTaskResult(...args),
  persistTaskError: (...args: unknown[]) => mockPersistTaskError(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: vi.fn(),
}));

import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';
import { selectWorkflow } from '../features/workflowSelection/index.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('failureMode option in selectAndExecuteTask', () => {
  it('should return a workflow resolution failure before adding or executing a task', async () => {
    vi.mocked(loadWorkflowByIdentifier).mockReturnValueOnce(null);

    const result = await selectAndExecuteTask('/project', 'test task', {
      workflow: 'missing-workflow', failureMode: 'return',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/missing/image.png', fileName: 'image.png' }],
    });

    expect(result).toMatchObject({ success: false, reason: expect.stringContaining('missing-workflow') });
    expect(result).not.toHaveProperty('kind');
    expect(vi.mocked(loadWorkflowByIdentifier)).toHaveBeenCalledExactlyOnceWith('missing-workflow', '/project');
    expect(selectWorkflow).not.toHaveBeenCalled();
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
  });

  it('should execute once when the same explicit workflow resolves', async () => {
    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'missing-workflow', failureMode: 'return',
    })).resolves.toEqual({ success: true });
    expect(loadWorkflowByIdentifier).toHaveBeenCalledExactlyOnceWith('missing-workflow', '/project');
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
  });

  it('should preserve the explicit workflow identifier for task recording and execution in return mode', async () => {
    vi.mocked(loadWorkflowByIdentifier).mockReturnValueOnce({
      name: 'test-workflow',
      steps: [{ name: 'step1', personaDisplayName: 'coder', instruction: '{task}' }],
      initialStep: 'step1',
      maxSteps: 1,
    });

    const result = await selectAndExecuteTask('/project', 'test task', {
      workflow: 'project-custom', failureMode: 'return',
    });

    expect(loadWorkflowByIdentifier).toHaveBeenCalledExactlyOnceWith('project-custom', '/project');
    expect(mockAddTask).toHaveBeenCalledExactlyOnceWith('test task', { workflow: 'project-custom' });
    expect(mockExecuteTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workflowIdentifier: 'project-custom',
    }));
    expect(result).toEqual({ success: true });
  });

  it('should execute the workflow selected by the user in return mode', async () => {
    vi.mocked(selectWorkflow).mockResolvedValueOnce('default');
    await expect(selectAndExecuteTask('/project', 'test task', { failureMode: 'return' }))
      .resolves.toEqual({ success: true });
    expect(mockExecuteTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workflowIdentifier: 'default' }));
  });

  it('should return cancellation before starting execution when workflow selection is cancelled', async () => {
    vi.mocked(selectWorkflow).mockResolvedValueOnce(null);

    await expect(selectAndExecuteTask('/project', 'test task', { failureMode: 'return' }))
      .resolves.toMatchObject({ kind: 'cancelled' });

    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
  });

  it('should return without calling process.exit(1) when failureMode is return and task fails', async () => {
    mockExecuteTask.mockResolvedValue({ success: false });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask('/project', 'test task', {
          workflow: 'default',
          failureMode: 'return',
        }),
      ).resolves.toMatchObject({ success: false });

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should throw without calling process.exit(1) when failureMode is throw and task fails', async () => {
    mockExecuteTask.mockResolvedValue({ success: false });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask('/project', 'test task', {
          workflow: 'default',
          failureMode: 'throw',
        }),
      ).rejects.toThrow('Task failed');

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should call process.exit(1) when failureMode is exit and task fails', async () => {
    mockExecuteTask.mockResolvedValue({ success: false });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask('/project', 'test task', {
          workflow: 'default',
          failureMode: 'exit',
        }),
      ).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should call process.exit(1) when failureMode is not set and task fails', async () => {
    mockExecuteTask.mockResolvedValue({ success: false });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask('/project', 'test task', {
          workflow: 'default',
        }),
      ).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should complete normally when the task succeeds', async () => {
    mockExecuteTask.mockResolvedValue({ success: true });

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        failureMode: 'return',
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it('should propagate unexpected execution errors in return mode', async () => {
    mockExecuteTask.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        failureMode: 'return',
      }),
    ).rejects.toThrow('provider unavailable');
    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
    expect(mockPersistTaskError).toHaveBeenCalledTimes(1);
  });

  it.each(['workflow aborted', 'workflow not found', undefined])('should preserve the actual failure reason %s in return mode', async (reason) => {
    const actual = { success: false, ...(reason === undefined ? {} : { reason }) };
    mockExecuteTask.mockResolvedValue(actual);

    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'default', failureMode: 'return',
    })).resolves.toEqual(actual);

    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
    expect(mockBuildBooleanTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskSuccess: false, failureResponse: 'Task failed',
    }));
    expect(mockPersistTaskResult).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'exit', undefined] as const)('should complete normally in failure mode %s when execution succeeds', async (failureMode) => {
    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'default', ...(failureMode === undefined ? {} : { failureMode }),
    })).resolves.toBeUndefined();
    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
    expect(mockBuildBooleanTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskSuccess: true, successResponse: 'Task completed successfully',
    }));
  });
});
