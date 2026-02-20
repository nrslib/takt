/**
 * Tests for global piece category path resolution.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolvedState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/tmp/.takt',
}));

vi.mock('../infra/config/resolvePieceConfigValue.js', () => ({
  resolvePieceConfigValue: (_projectDir: string, key: string) => {
    return resolvedState.value[key];
  },
  resolvePieceConfigValues: (_projectDir: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = resolvedState.value[key];
    }
    return result;
  },
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
    resolvedState.value = {};
  });

  it('should return configured path when pieceCategoriesFile is set', () => {
    // Given
    resolvedState.value = { pieceCategoriesFile: '/custom/piece-categories.yaml' };

    // When
    const path = getPieceCategoriesPath(process.cwd());

    // Then
    expect(path).toBe('/custom/piece-categories.yaml');
  });

  it('should return default path when pieceCategoriesFile is not set', () => {
    // Given
    resolvedState.value = {};

    // When
    const path = getPieceCategoriesPath(process.cwd());

    // Then
    expect(path).toBe('/tmp/.takt/preferences/piece-categories.yaml');
  });

  it('should rethrow when global config loading fails', () => {
    // Given
    resolvedState.value = new Proxy({}, {
      get() {
        throw new Error('invalid global config');
      },
    }) as Record<string, unknown>;

    // When / Then
    expect(() => getPieceCategoriesPath(process.cwd())).toThrow('invalid global config');
  });
});

describe('resetPieceCategories', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    resolvedState.value = {};
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
    resolvedState.value = { pieceCategoriesFile: categoriesPath };

    // When
    resetPieceCategories(process.cwd());

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
    resolvedState.value = { pieceCategoriesFile: categoriesPath };
    mkdirSync(categoriesDir, { recursive: true });
    writeFileSync(categoriesPath, 'piece_categories:\n  old:\n    - stale-piece\n', 'utf-8');

    // When
    resetPieceCategories(process.cwd());

    // Then
    expect(readFileSync(categoriesPath, 'utf-8')).toBe('piece_categories: {}\n');
  });
});
