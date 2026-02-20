/**
 * Tests for skipTaskList option in selectAndExecuteTask
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAddTask,
  mockCompleteTask,
  mockFailTask,
  mockExecuteTask,
  mockResolvePieceConfigValue,
} = vi.hoisted(() => ({
  mockAddTask: vi.fn(() => ({
    name: 'test-task',
    content: 'test task',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'pending',
    data: { task: 'test task' },
  })),
  mockCompleteTask: vi.fn(),
  mockFailTask: vi.fn(),
  mockExecuteTask: vi.fn(),
  mockResolvePieceConfigValue: vi.fn((_: string, key: string) => (key === 'autoPr' ? undefined : 'default')),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolvePieceConfigValue: (...args: unknown[]) => mockResolvePieceConfigValue(...args),
  listPieces: vi.fn(() => ['default']),
  listPieceEntries: vi.fn(() => []),
  isPiecePath: vi.fn(() => false),
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
  TaskRunner: vi.fn(() => ({
    addTask: (...args: unknown[]) => mockAddTask(...args),
    completeTask: (...args: unknown[]) => mockCompleteTask(...args),
    failTask: (...args: unknown[]) => mockFailTask(...args),
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
  createPullRequest: vi.fn(),
  buildPrBody: vi.fn(),
  pushBranch: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  warnMissingPieces: vi.fn(),
  selectPieceFromCategorizedPieces: vi.fn(),
  selectPieceFromEntries: vi.fn(),
  selectPiece: vi.fn(),
}));

import { confirm } from '../shared/prompt/index.js';
import { createSharedClone, autoCommitAndPush, summarizeTaskName } from '../infra/task/index.js';
import { selectPiece } from '../features/pieceSelection/index.js';
import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';

const mockConfirm = vi.mocked(confirm);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockAutoCommitAndPush = vi.mocked(autoCommitAndPush);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockSelectPiece = vi.mocked(selectPiece);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue(true);
});

describe('skipTaskList option in selectAndExecuteTask', () => {
  it('should NOT add task to tasks.yaml when skipTaskList is true', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'no changes',
    });

    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      skipTaskList: true,
    });

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockFailTask).not.toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('should add task to tasks.yaml when skipTaskList is false or undefined', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'no changes',
    });

    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      skipTaskList: false,
    });

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockCompleteTask).toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('should add task to tasks.yaml by default when skipTaskList is not provided', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'no changes',
    });

    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
    });

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockCompleteTask).toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('should NOT persist task error when skipTaskList is true', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        piece: 'default',
        skipTaskList: true,
      }),
    ).rejects.toThrow('Task execution failed');

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  it('should persist task error when skipTaskList is false', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        piece: 'default',
        skipTaskList: false,
      }),
    ).rejects.toThrow('Task execution failed');

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockFailTask).toHaveBeenCalled();
  });
});
