/**
 * Tests for selectAndExecuteTask behavior in execute path
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

vi.mock('../infra/config/index.js', () => ({
  resolvePieceConfigValue: (...args: unknown[]) => mockResolvePieceConfigValue(...args),
  listPieces: vi.fn(() => ['default']),
  listPieceEntries: vi.fn(() => []),
  loadPieceByIdentifier: vi.fn((identifier: string) => (identifier === 'default' ? { name: 'default' } : null)),
  isPiecePath: vi.fn(() => false),
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
  detectDefaultBranch: vi.fn(() => 'main'),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
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
  buildPrBody: vi.fn(),
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

import { loadPieceByIdentifier } from '../infra/config/index.js';
import { autoCommitAndPush } from '../infra/task/index.js';
import { selectPiece } from '../features/pieceSelection/index.js';
import { selectAndExecuteTask, determinePiece } from '../features/tasks/execute/selectAndExecute.js';

const mockLoadPieceByIdentifier = vi.mocked(loadPieceByIdentifier);
const mockAutoCommitAndPush = vi.mocked(autoCommitAndPush);
const mockSelectPiece = vi.mocked(selectPiece);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue(true);
});

describe('selectAndExecuteTask (execute path)', () => {
  it('should execute in-place without worktree setup or PR prompts', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
    });

    expect(mockAutoCommitAndPush).not.toHaveBeenCalled();
    expect(mockAddTask).toHaveBeenCalledWith('test task', { piece: 'default' });
  });

  it('should call selectPiece when no override is provided', async () => {
    mockSelectPiece.mockResolvedValue('selected-piece');

    const selected = await determinePiece('/project');

    expect(selected).toBe('selected-piece');
    expect(mockSelectPiece).toHaveBeenCalledWith('/project');
  });

  it('should accept repertoire scoped piece override when it exists', async () => {
    mockLoadPieceByIdentifier.mockReturnValueOnce({ name: '@nrslib/takt-ensembles/critical-thinking' } as never);

    const selected = await determinePiece('/project', '@nrslib/takt-ensembles/critical-thinking');

    expect(selected).toBe('@nrslib/takt-ensembles/critical-thinking');
  });

  it('should fail task record when executeTask throws', async () => {
    mockExecuteTask.mockRejectedValue(new Error('boom'));

    await expect(selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
    })).rejects.toThrow('boom');

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  it('should record task and complete when executeTask returns true', async () => {
    mockExecuteTask.mockResolvedValue(true);

    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
    });

    expect(mockAddTask).toHaveBeenCalledWith('test task', { piece: 'default' });
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  it('should record task and fail when executeTask returns false', async () => {
    mockExecuteTask.mockResolvedValue(false);

    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
    })).rejects.toThrow('process exit');

    expect(mockAddTask).toHaveBeenCalledWith('test task', { piece: 'default' });
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
    processExitSpy.mockRestore();
  });
});
