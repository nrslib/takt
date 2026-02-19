/**
 * Tests for switchPiece behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../infra/config/index.js', () => ({
  loadPiece: vi.fn(() => null),
  resolveConfigValue: vi.fn(() => 'default'),
  setCurrentPiece: vi.fn(),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  selectPiece: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

import { resolveConfigValue, loadPiece, setCurrentPiece } from '../infra/config/index.js';
import { selectPiece } from '../features/pieceSelection/index.js';
import { switchPiece } from '../features/config/switchPiece.js';

const mockResolveConfigValue = vi.mocked(resolveConfigValue);
const mockLoadPiece = vi.mocked(loadPiece);
const mockSetCurrentPiece = vi.mocked(setCurrentPiece);
const mockSelectPiece = vi.mocked(selectPiece);

describe('switchPiece', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfigValue.mockReturnValue('default');
  });

  it('should call selectPiece with fallbackToDefault: false', async () => {
    mockSelectPiece.mockResolvedValue(null);

    const switched = await switchPiece('/project');

    expect(switched).toBe(false);
    expect(mockSelectPiece).toHaveBeenCalledWith('/project', { fallbackToDefault: false });
  });

  it('should switch to selected piece', async () => {
    mockSelectPiece.mockResolvedValue('new-piece');
    mockLoadPiece.mockReturnValue({
      name: 'new-piece',
      movements: [],
      initialMovement: 'start',
      maxMovements: 1,
    });

    const switched = await switchPiece('/project');

    expect(switched).toBe(true);
    expect(mockSetCurrentPiece).toHaveBeenCalledWith('/project', 'new-piece');
  });
});
