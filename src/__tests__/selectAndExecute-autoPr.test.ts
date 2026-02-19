/**
 * Tests for resolveAutoPr default behavior in selectAndExecuteTask
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
import { selectAndExecuteTask, determinePiece } from '../features/tasks/execute/selectAndExecute.js';

const mockConfirm = vi.mocked(confirm);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockAutoCommitAndPush = vi.mocked(autoCommitAndPush);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockSelectPiece = vi.mocked(selectPiece);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue(true);
});

describe('resolveAutoPr default in selectAndExecuteTask', () => {
  it('should call auto-PR confirm with default true when no CLI option or config', async () => {
    // Given: worktree is enabled via override, no autoPr option, no config autoPr
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });

    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'no changes',
    });

    // When
    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      createWorktree: true,
    });

    const autoPrCall = mockConfirm.mock.calls.find((call) => call[0] === 'Create pull request?');
    expect(autoPrCall).toBeDefined();
    expect(autoPrCall![1]).toBe(true);
  });

  it('shouldCreatePr=true の場合、"Create as draft?" プロンプトが表示される', async () => {
    // confirm はすべての呼び出しに対して true を返す（autoPr=true → draftPr prompt）
    mockConfirm.mockResolvedValue(true);
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
      createWorktree: true,
    });

    const draftPrCall = mockConfirm.mock.calls.find((call) => call[0] === 'Create as draft?');
    expect(draftPrCall).toBeDefined();
    expect(draftPrCall![1]).toBe(true);
  });

  it('shouldCreatePr=false の場合、"Create as draft?" プロンプトは表示されない', async () => {
    mockConfirm.mockResolvedValue(false); // autoPr=false → draft prompt skipped
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
      createWorktree: true,
    });

    const draftPrCall = mockConfirm.mock.calls.find((call) => call[0] === 'Create as draft?');
    expect(draftPrCall).toBeUndefined();
  });

  it('should call selectPiece when no override is provided', async () => {
    mockSelectPiece.mockResolvedValue('selected-piece');

    const selected = await determinePiece('/project');

    expect(selected).toBe('selected-piece');
    expect(mockSelectPiece).toHaveBeenCalledWith('/project');
  });

  it('should fail task record when executeTask throws', async () => {
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockExecuteTask.mockRejectedValue(new Error('boom'));

    await expect(selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      createWorktree: true,
    })).rejects.toThrow('boom');

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  it('should record task and complete when executeTask returns true', async () => {
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockExecuteTask.mockResolvedValue(true);

    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      createWorktree: true,
    });

    expect(mockAddTask).toHaveBeenCalledWith('test task', expect.objectContaining({
      piece: 'default',
      worktree: true,
      branch: 'takt/test-task',
      worktree_path: '/project/../clone',
      auto_pr: true,
      draft_pr: true,
    }));
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  it('should record task and fail when executeTask returns false', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });
    mockExecuteTask.mockResolvedValue(false);

    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      createWorktree: true,
    })).rejects.toThrow('process exit');

    expect(mockAddTask).toHaveBeenCalledWith('test task', expect.objectContaining({
      piece: 'default',
      worktree: true,
      branch: 'takt/test-task',
      worktree_path: '/project/../clone',
      auto_pr: false,
    }));
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
    processExitSpy.mockRestore();
  });
});
