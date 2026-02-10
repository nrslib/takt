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
  loadAllPiecesWithSources: vi.fn(() => new Map()),
  getPieceCategories: vi.fn(() => null),
  buildCategorizedPieces: vi.fn(),
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
}));

import { confirm } from '../shared/prompt/index.js';
import {
  getCurrentPiece,
  loadAllPiecesWithSources,
  getPieceCategories,
  buildCategorizedPieces,
} from '../infra/config/index.js';
import { createSharedClone, autoCommitAndPush, summarizeTaskName } from '../infra/task/index.js';
import { warnMissingPieces, selectPieceFromCategorizedPieces } from '../features/pieceSelection/index.js';
import { selectAndExecuteTask, determinePiece } from '../features/tasks/execute/selectAndExecute.js';

const mockConfirm = vi.mocked(confirm);
const mockGetCurrentPiece = vi.mocked(getCurrentPiece);
const mockLoadAllPiecesWithSources = vi.mocked(loadAllPiecesWithSources);
const mockGetPieceCategories = vi.mocked(getPieceCategories);
const mockBuildCategorizedPieces = vi.mocked(buildCategorizedPieces);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockAutoCommitAndPush = vi.mocked(autoCommitAndPush);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockWarnMissingPieces = vi.mocked(warnMissingPieces);
const mockSelectPieceFromCategorizedPieces = vi.mocked(selectPieceFromCategorizedPieces);

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

  it('should warn only user-origin missing pieces during interactive selection', async () => {
    // Given: category selection is enabled and both builtin/user missing pieces exist
    mockGetCurrentPiece.mockReturnValue('default');
    mockLoadAllPiecesWithSources.mockReturnValue(new Map([
      ['default', {
        source: 'builtin',
        config: {
          name: 'default',
          movements: [],
          initialMovement: 'start',
          maxMovements: 1,
        },
      }],
    ]));
    mockGetPieceCategories.mockReturnValue({
      pieceCategories: [],
      builtinPieceCategories: [],
      userPieceCategories: [],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    });
    mockBuildCategorizedPieces.mockReturnValue({
      categories: [],
      allPieces: new Map(),
      missingPieces: [
        { categoryPath: ['Quick Start'], pieceName: 'default', source: 'builtin' },
        { categoryPath: ['Custom'], pieceName: 'my-missing', source: 'user' },
      ],
    });
    mockSelectPieceFromCategorizedPieces.mockResolvedValue('default');

    // When
    const selected = await determinePiece('/project');

    // Then
    expect(selected).toBe('default');
    expect(mockWarnMissingPieces).toHaveBeenCalledWith([
      { categoryPath: ['Custom'], pieceName: 'my-missing', source: 'user' },
    ]);
  });
});
