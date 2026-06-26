/**
 * Tests for exitOnFailure option in selectAndExecuteTask.
 *
 * Covers:
 * - exitOnFailure: false throws Error instead of calling process.exit(1)
 * - exitOnFailure: undefined (default) calls process.exit(1)
 * - exitOnFailure: true calls process.exit(1)
 * - exitOnFailure: false with successful task completes normally
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockAddTask,
  mockExecuteTask,
  mockPersistTaskResult,
  mockPersistTaskError,
  mockBuildBooleanTaskResult,
} = vi.hoisted(() => ({
  mockAddTask: vi.fn(() => ({
    name: 'test-task',
    content: 'test task',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'pending',
    data: { task: 'test task' },
  })),
  mockExecuteTask: vi.fn(),
  mockPersistTaskResult: vi.fn(),
  mockPersistTaskError: vi.fn(),
  mockBuildBooleanTaskResult: vi.fn(() => ({ task: 'mock-result' })),
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
    addTask: (...args: unknown[]) => mockAddTask(...args),
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
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
}));

vi.mock('../features/tasks/execute/taskResultHandler.js', () => ({
  buildBooleanTaskResult: (...args: unknown[]) => mockBuildBooleanTaskResult(...args),
  persistTaskResult: (...args: unknown[]) => mockPersistTaskResult(...args),
  persistTaskError: (...args: unknown[]) => mockPersistTaskError(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: vi.fn(),
}));

import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exitOnFailure option in selectAndExecuteTask', () => {
  it('should throw Error instead of calling process.exit(1) when exitOnFailure is false and task fails', async () => {
    mockExecuteTask.mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask('/project', 'test task', {
          workflow: 'default',
          exitOnFailure: false,
        }),
      ).rejects.toThrow('Task failed');

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should call process.exit(1) when exitOnFailure is not set (default) and task fails', async () => {
    mockExecuteTask.mockResolvedValue(false);
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

  it('should call process.exit(1) when exitOnFailure is true and task fails', async () => {
    mockExecuteTask.mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask('/project', 'test task', {
          workflow: 'default',
          exitOnFailure: true,
        }),
      ).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('should complete normally when exitOnFailure is false and task succeeds', async () => {
    mockExecuteTask.mockResolvedValue(true);

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        exitOnFailure: false,
      }),
    ).resolves.toBeUndefined();
  });
});
