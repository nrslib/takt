/**
 * Tests for switchPiece behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../infra/config/index.js', () => ({
  listPieceEntries: vi.fn(() => []),
  loadAllPiecesWithSources: vi.fn(() => new Map()),
  getPieceCategories: vi.fn(() => null),
  buildCategorizedPieces: vi.fn(),
  loadPiece: vi.fn(() => null),
  getCurrentPiece: vi.fn(() => 'default'),
  setCurrentPiece: vi.fn(),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  warnMissingPieces: vi.fn(),
  selectPieceFromCategorizedPieces: vi.fn(),
  selectPieceFromEntries: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

import {
  loadAllPiecesWithSources,
  getPieceCategories,
  buildCategorizedPieces,
} from '../infra/config/index.js';
import {
  warnMissingPieces,
  selectPieceFromCategorizedPieces,
} from '../features/pieceSelection/index.js';
import { switchPiece } from '../features/config/switchPiece.js';

const mockLoadAllPiecesWithSources = vi.mocked(loadAllPiecesWithSources);
const mockGetPieceCategories = vi.mocked(getPieceCategories);
const mockBuildCategorizedPieces = vi.mocked(buildCategorizedPieces);
const mockWarnMissingPieces = vi.mocked(warnMissingPieces);
const mockSelectPieceFromCategorizedPieces = vi.mocked(selectPieceFromCategorizedPieces);

describe('switchPiece', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should warn only user-origin missing pieces during interactive switch', async () => {
    // Given
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
    mockSelectPieceFromCategorizedPieces.mockResolvedValue(null);

    // When
    const switched = await switchPiece('/project');

    // Then
    expect(switched).toBe(false);
    expect(mockWarnMissingPieces).toHaveBeenCalledWith([
      { categoryPath: ['Custom'], pieceName: 'my-missing', source: 'user' },
    ]);
  });
});
