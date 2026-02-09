/**
 * Tests for reset categories command behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/config/global/pieceCategories.js', () => ({
  resetPieceCategories: vi.fn(),
  getPieceCategoriesPath: vi.fn(() => '/tmp/user-piece-categories.yaml'),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

import { resetPieceCategories } from '../infra/config/global/pieceCategories.js';
import { header, success, info } from '../shared/ui/index.js';
import { resetCategoriesToDefault } from '../features/config/resetCategories.js';

const mockResetPieceCategories = vi.mocked(resetPieceCategories);
const mockHeader = vi.mocked(header);
const mockSuccess = vi.mocked(success);
const mockInfo = vi.mocked(info);

describe('resetCategoriesToDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reset user category overlay and show updated message', async () => {
    // Given

    // When
    await resetCategoriesToDefault();

    // Then
    expect(mockHeader).toHaveBeenCalledWith('Reset Categories');
    expect(mockResetPieceCategories).toHaveBeenCalledTimes(1);
    expect(mockSuccess).toHaveBeenCalledWith('User category overlay reset.');
    expect(mockInfo).toHaveBeenCalledWith('  /tmp/user-piece-categories.yaml');
  });
});
