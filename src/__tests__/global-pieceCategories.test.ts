/**
 * Tests for global piece category path resolution.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadGlobalConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/tmp/.takt',
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: loadGlobalConfigMock,
}));

const { getPieceCategoriesPath, resetPieceCategories } = await import(
  '../infra/config/global/pieceCategories.js'
);

function createTempCategoriesPath(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'takt-piece-categories-'));
  return join(tempRoot, 'preferences', 'piece-categories.yaml');
}

describe('getPieceCategoriesPath', () => {
  beforeEach(() => {
    loadGlobalConfigMock.mockReset();
  });

  it('should return configured path when pieceCategoriesFile is set', () => {
    // Given
    loadGlobalConfigMock.mockReturnValue({
      pieceCategoriesFile: '/custom/piece-categories.yaml',
    });

    // When
    const path = getPieceCategoriesPath();

    // Then
    expect(path).toBe('/custom/piece-categories.yaml');
  });

  it('should return default path when pieceCategoriesFile is not set', () => {
    // Given
    loadGlobalConfigMock.mockReturnValue({});

    // When
    const path = getPieceCategoriesPath();

    // Then
    expect(path).toBe('/tmp/.takt/preferences/piece-categories.yaml');
  });

  it('should rethrow when global config loading fails', () => {
    // Given
    loadGlobalConfigMock.mockImplementation(() => {
      throw new Error('invalid global config');
    });

    // When / Then
    expect(() => getPieceCategoriesPath()).toThrow('invalid global config');
  });
});

describe('resetPieceCategories', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    loadGlobalConfigMock.mockReset();
  });

  afterEach(() => {
    for (const tempRoot of tempRoots) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it('should create parent directory and initialize with empty user categories', () => {
    // Given
    const categoriesPath = createTempCategoriesPath();
    tempRoots.push(dirname(dirname(categoriesPath)));
    loadGlobalConfigMock.mockReturnValue({
      pieceCategoriesFile: categoriesPath,
    });

    // When
    resetPieceCategories();

    // Then
    expect(existsSync(dirname(categoriesPath))).toBe(true);
    expect(readFileSync(categoriesPath, 'utf-8')).toBe('piece_categories: {}\n');
  });

  it('should overwrite existing file with empty user categories', () => {
    // Given
    const categoriesPath = createTempCategoriesPath();
    const categoriesDir = dirname(categoriesPath);
    const tempRoot = dirname(categoriesDir);
    tempRoots.push(tempRoot);
    loadGlobalConfigMock.mockReturnValue({
      pieceCategoriesFile: categoriesPath,
    });
    mkdirSync(categoriesDir, { recursive: true });
    writeFileSync(categoriesPath, 'piece_categories:\n  old:\n    - stale-piece\n', 'utf-8');

    // When
    resetPieceCategories();

    // Then
    expect(readFileSync(categoriesPath, 'utf-8')).toBe('piece_categories: {}\n');
  });
});
