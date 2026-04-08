/**
 * Tests for skipTaskList option in selectAndExecuteTask
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  TaskRunner: vi.fn(() => ({
    addTask: (...args: unknown[]) => mockAddTask(...args),
  })),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
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

describe('skipTaskList option in selectAndExecuteTask', () => {
  it('skipTaskList: true の場合はタスクリストに追加しない', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
      skipTaskList: true,
    });

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('skipTaskList: false の場合はタスクリストに追加する', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
      skipTaskList: false,
    });

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockBuildBooleanTaskResult).toHaveBeenCalled();
    expect(mockPersistTaskResult).toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('skipTaskList 未指定の場合はタスクリストに追加する', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    });

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockPersistTaskResult).toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('skipTaskList: true でエラー時は persistTaskError を呼ばない', async () => {
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        skipTaskList: true,
      }),
    ).rejects.toThrow('Task execution failed');

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockPersistTaskError).not.toHaveBeenCalled();
  });

  it('skipTaskList: false でエラー時は persistTaskError を呼ぶ', async () => {
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        skipTaskList: false,
      }),
    ).rejects.toThrow('Task execution failed');

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockPersistTaskError).toHaveBeenCalled();
  });
});
