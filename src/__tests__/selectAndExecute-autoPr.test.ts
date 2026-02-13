/**
 * Tests for resolveAutoPr default behavior in selectAndExecuteTask
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  getCurrentPiece: vi.fn(),
  listPieces: vi.fn(() => ['default']),
  listPieceEntries: vi.fn(() => []),
  isPiecePath: vi.fn(() => false),
  loadGlobalConfig: vi.fn(() => ({})),
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
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
  executeTask: vi.fn(),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  warnMissingPieces: vi.fn(),
  selectPieceFromCategorizedPieces: vi.fn(),
  selectPieceFromEntries: vi.fn(),
  selectPiece: vi.fn(),
}));

import { confirm } from '../shared/prompt/index.js';
import {
  getCurrentPiece,
  listPieces,
} from '../infra/config/index.js';
import { createSharedClone, autoCommitAndPush, summarizeTaskName } from '../infra/task/index.js';
import { selectPiece } from '../features/pieceSelection/index.js';
import { selectAndExecuteTask, determinePiece } from '../features/tasks/execute/selectAndExecute.js';

const mockConfirm = vi.mocked(confirm);
const mockGetCurrentPiece = vi.mocked(getCurrentPiece);
const mockListPieces = vi.mocked(listPieces);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockAutoCommitAndPush = vi.mocked(autoCommitAndPush);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockSelectPiece = vi.mocked(selectPiece);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAutoPr default in selectAndExecuteTask', () => {
  it('should call auto-PR confirm with default true when no CLI option or config', async () => {
    // Given: worktree is enabled via override, no autoPr option, no global config autoPr
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../clone',
      branch: 'takt/test-task',
    });

    const { executeTask } = await import(
      '../features/tasks/execute/taskExecution.js'
    );
    vi.mocked(executeTask).mockResolvedValue(true);
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'no changes',
    });

    // When
    await selectAndExecuteTask('/project', 'test task', {
      piece: 'default',
      createWorktree: true,
    });

    // Then: the 'Create pull request?' confirm is called with default true
    const autoPrCall = mockConfirm.mock.calls.find(
      (call) => call[0] === 'Create pull request?',
    );
    expect(autoPrCall).toBeDefined();
    expect(autoPrCall![1]).toBe(true);
  });

  it('should call selectPiece when no override is provided', async () => {
    mockSelectPiece.mockResolvedValue('selected-piece');

    const selected = await determinePiece('/project');

    expect(selected).toBe('selected-piece');
    expect(mockSelectPiece).toHaveBeenCalledWith('/project');
  });
});
