/**
 * Tests for global piece category path resolution.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/tmp/.takt',
}));

vi.mock('../infra/config/loadConfig.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../infra/config/resolvePieceConfigValue.js', () => ({
  resolvePieceConfigValue: (_projectDir: string, key: string) => {
    const loaded = loadConfigMock() as Record<string, Record<string, unknown>>;
    const global = loaded?.global ?? {};
    const project = loaded?.project ?? {};
    const merged: Record<string, unknown> = { ...global, ...project };
    return merged[key];
  },
  resolvePieceConfigValues: (_projectDir: string, keys: readonly string[]) => {
    const loaded = loadConfigMock() as Record<string, Record<string, unknown>>;
    const global = loaded?.global ?? {};
    const project = loaded?.project ?? {};
    const merged: Record<string, unknown> = { ...global, ...project };
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = merged[key];
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
    loadConfigMock.mockReset();
  });

  it('should return configured path when pieceCategoriesFile is set', () => {
    // Given
    loadConfigMock.mockReturnValue({
      global: { pieceCategoriesFile: '/custom/piece-categories.yaml' },
      project: {},
    });

    // When
    const path = getPieceCategoriesPath(process.cwd());

    // Then
    expect(path).toBe('/custom/piece-categories.yaml');
  });

  it('should return default path when pieceCategoriesFile is not set', () => {
    // Given
    loadConfigMock.mockReturnValue({ global: {}, project: {} });

    // When
    const path = getPieceCategoriesPath(process.cwd());

    // Then
    expect(path).toBe('/tmp/.takt/preferences/piece-categories.yaml');
  });

  it('should rethrow when global config loading fails', () => {
    // Given
    loadConfigMock.mockImplementation(() => {
      throw new Error('invalid global config');
    });

    // When / Then
    expect(() => getPieceCategoriesPath(process.cwd())).toThrow('invalid global config');
  });
});

describe('resetPieceCategories', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    loadConfigMock.mockReset();
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
    loadConfigMock.mockReturnValue({
      global: { pieceCategoriesFile: categoriesPath },
      project: {},
    });

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
    loadConfigMock.mockReturnValue({
      global: { pieceCategoriesFile: categoriesPath },
      project: {},
    });
    mkdirSync(categoriesDir, { recursive: true });
    writeFileSync(categoriesPath, 'piece_categories:\n  old:\n    - stale-piece\n', 'utf-8');

    // When
    resetPieceCategories(process.cwd());

    // Then
    expect(readFileSync(categoriesPath, 'utf-8')).toBe('piece_categories: {}\n');
  });
});
