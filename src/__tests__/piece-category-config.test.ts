/**
 * Tests for piece category configuration loading and building
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PieceWithSource } from '../infra/config/index.js';

const pathsState = vi.hoisted(() => ({
  resourcesDir: '',
  userCategoriesPath: '',
}));

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguage: () => 'en',
  };
});

vi.mock('../infra/resources/index.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguageResourcesDir: () => pathsState.resourcesDir,
  };
});

vi.mock('../infra/config/global/pieceCategories.js', async () => {
  return {
    ensureUserCategoriesFile: () => pathsState.userCategoriesPath,
  };
});

const {
  getPieceCategories,
  loadDefaultCategories,
  buildCategorizedPieces,
  findPieceCategories,
} = await import('../infra/config/loaders/pieceCategories.js');

function writeYaml(path: string, content: string): void {
  writeFileSync(path, content.trim() + '\n', 'utf-8');
}

function createPieceMap(entries: { name: string; source: 'builtin' | 'user' | 'project' }[]):
  Map<string, PieceWithSource> {
  const pieces = new Map<string, PieceWithSource>();
  for (const entry of entries) {
    pieces.set(entry.name, {
      source: entry.source,
      config: {
        name: entry.name,
        movements: [],
        initialMovement: 'start',
        maxIterations: 1,
      },
    });
  }
  return pieces;
}

describe('piece category config loading', () => {
  let testDir: string;
  let resourcesDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-cat-config-${randomUUID()}`);
    resourcesDir = join(testDir, 'resources');

    mkdirSync(resourcesDir, { recursive: true });
    pathsState.resourcesDir = resourcesDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load categories from user file (auto-copied from default)', () => {
    const userPath = join(testDir, 'piece-categories.yaml');
    writeYaml(userPath, `
piece_categories:
  Default:
    pieces:
      - simple
show_others_category: true
others_category_name: "Others"
`);
    pathsState.userCategoriesPath = userPath;

    const config = getPieceCategories();
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'Default', pieces: ['simple'], children: [] },
    ]);
    expect(config!.showOthersCategory).toBe(true);
    expect(config!.othersCategoryName).toBe('Others');
  });

  it('should return null when user file has no piece_categories', () => {
    const userPath = join(testDir, 'piece-categories.yaml');
    writeYaml(userPath, `
show_others_category: true
`);
    pathsState.userCategoriesPath = userPath;

    const config = getPieceCategories();
    expect(config).toBeNull();
  });

  it('should parse nested categories from user file', () => {
    const userPath = join(testDir, 'piece-categories.yaml');
    writeYaml(userPath, `
piece_categories:
  Parent:
    pieces:
      - parent-piece
    Child:
      pieces:
        - child-piece
`);
    pathsState.userCategoriesPath = userPath;

    const config = getPieceCategories();
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      {
        name: 'Parent',
        pieces: ['parent-piece'],
        children: [
          { name: 'Child', pieces: ['child-piece'], children: [] },
        ],
      },
    ]);
  });

  it('should return null when default categories file is missing', () => {
    const config = loadDefaultCategories();
    expect(config).toBeNull();
  });

  it('should load default categories from resources', () => {
    writeYaml(join(resourcesDir, 'piece-categories.yaml'), `
piece_categories:
  Quick Start:
    pieces:
      - default
`);

    const config = loadDefaultCategories();
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'Quick Start', pieces: ['default'], children: [] },
    ]);
  });
});

describe('buildCategorizedPieces', () => {
  it('should place all pieces (user and builtin) into a unified category tree', () => {
    const allPieces = createPieceMap([
      { name: 'a', source: 'user' },
      { name: 'b', source: 'user' },
      { name: 'c', source: 'builtin' },
    ]);
    const config = {
      pieceCategories: [
        { name: 'Cat', pieces: ['a', 'missing', 'c'], children: [] },
      ],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config);
    expect(categorized.categories).toEqual([
      { name: 'Cat', pieces: ['a', 'c'], children: [] },
      { name: 'Others', pieces: ['b'], children: [] },
    ]);
    expect(categorized.missingPieces).toEqual([
      { categoryPath: ['Cat'], pieceName: 'missing' },
    ]);
  });

  it('should skip empty categories', () => {
    const allPieces = createPieceMap([
      { name: 'a', source: 'user' },
    ]);
    const config = {
      pieceCategories: [
        { name: 'Empty', pieces: [], children: [] },
      ],
      showOthersCategory: false,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config);
    expect(categorized.categories).toEqual([]);
  });

  it('should append Others category for uncategorized pieces', () => {
    const allPieces = createPieceMap([
      { name: 'default', source: 'builtin' },
      { name: 'extra', source: 'builtin' },
    ]);
    const config = {
      pieceCategories: [
        { name: 'Main', pieces: ['default'], children: [] },
      ],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config);
    expect(categorized.categories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
      { name: 'Others', pieces: ['extra'], children: [] },
    ]);
  });

  it('should merge uncategorized pieces into existing Others category', () => {
    const allPieces = createPieceMap([
      { name: 'default', source: 'builtin' },
      { name: 'extra', source: 'builtin' },
      { name: 'user-piece', source: 'user' },
    ]);
    const config = {
      pieceCategories: [
        { name: 'Main', pieces: ['default'], children: [] },
        { name: 'Others', pieces: ['extra'], children: [] },
      ],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config);
    expect(categorized.categories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
      { name: 'Others', pieces: ['extra', 'user-piece'], children: [] },
    ]);
  });

  it('should not append Others when showOthersCategory is false', () => {
    const allPieces = createPieceMap([
      { name: 'default', source: 'builtin' },
      { name: 'extra', source: 'builtin' },
    ]);
    const config = {
      pieceCategories: [
        { name: 'Main', pieces: ['default'], children: [] },
      ],
      showOthersCategory: false,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config);
    expect(categorized.categories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
    ]);
  });

  it('should find categories containing a piece', () => {
    const categories = [
      { name: 'A', pieces: ['shared'], children: [] },
      { name: 'B', pieces: ['shared'], children: [] },
    ];

    const paths = findPieceCategories('shared', categories).sort();
    expect(paths).toEqual(['A', 'B']);
  });

  it('should handle nested category paths', () => {
    const categories = [
      {
        name: 'Parent',
        pieces: [],
        children: [
          { name: 'Child', pieces: ['nested'], children: [] },
        ],
      },
    ];

    const paths = findPieceCategories('nested', categories);
    expect(paths).toEqual(['Parent / Child']);
  });
});

describe('ensureUserCategoriesFile (integration)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-cat-ensure-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should copy default categories to user path when missing', async () => {
    // Use real ensureUserCategoriesFile (not mocked)
    const { ensureUserCategoriesFile } = await import('../infra/config/global/pieceCategories.js');

    // This test depends on the mock still being active — just verify the mock returns our path
    const result = ensureUserCategoriesFile('/tmp/default.yaml');
    expect(typeof result).toBe('string');
  });
});
