/**
 * Tests for piece category configuration loading and building
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PieceWithSource } from '../infra/config/index.js';

const languageState = vi.hoisted(() => ({
  value: 'en' as 'en' | 'ja',
}));

const pathsState = vi.hoisted(() => ({
  resourcesRoot: '',
  userCategoriesPath: '',
}));

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    loadGlobalConfig: () => ({}),
  };
});

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinPieces') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  },
  resolveConfigValues: (_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinPieces') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  },
}));

vi.mock('../infra/resources/index.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguageResourcesDir: (lang: string) => join(pathsState.resourcesRoot, lang),
  };
});

vi.mock('../infra/config/global/pieceCategories.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getPieceCategoriesPath: () => pathsState.userCategoriesPath,
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
        maxMovements: 1,
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
    resourcesDir = join(testDir, 'resources', 'en');

    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(join(testDir, 'resources', 'ja'), { recursive: true });
    pathsState.resourcesRoot = join(testDir, 'resources');
    languageState.value = 'en';
    pathsState.userCategoriesPath = join(testDir, 'user-piece-categories.yaml');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null when builtin categories file is missing', () => {
    const config = getPieceCategories(testDir);
    expect(config).toBeNull();
  });

  it('should load default categories from resources', () => {
    writeYaml(join(resourcesDir, 'piece-categories.yaml'), `
piece_categories:
  Quick Start:
    pieces:
      - default
`);

    const config = loadDefaultCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'Quick Start', pieces: ['default'], children: [] },
    ]);
    expect(config!.builtinPieceCategories).toEqual([
      { name: 'Quick Start', pieces: ['default'], children: [] },
    ]);
    expect(config!.userPieceCategories).toEqual([]);
  });

  it('should use builtin categories when user overlay file is missing', () => {
    writeYaml(join(resourcesDir, 'piece-categories.yaml'), `
piece_categories:
  Main:
    pieces:
      - default
show_others_category: true
others_category_name: Others
`);

    const config = getPieceCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
    ]);
    expect(config!.userPieceCategories).toEqual([]);
    expect(config!.showOthersCategory).toBe(true);
    expect(config!.othersCategoryName).toBe('Others');
  });

  it('should merge user overlay categories with builtin categories', () => {
    writeYaml(join(resourcesDir, 'piece-categories.yaml'), `
piece_categories:
  Main:
    pieces:
      - default
      - coding
    Child:
      pieces:
        - nested
  Review:
    pieces:
      - review-only
      - e2e-test
show_others_category: true
others_category_name: Others
`);

    writeYaml(pathsState.userCategoriesPath, `
piece_categories:
  Main:
    pieces:
      - custom
  My Team:
    pieces:
      - team-flow
show_others_category: false
others_category_name: Unclassified
`);

    const config = getPieceCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      {
        name: 'Main',
        pieces: ['custom'],
        children: [
          { name: 'Child', pieces: ['nested'], children: [] },
        ],
      },
      { name: 'Review', pieces: ['review-only', 'e2e-test'], children: [] },
      { name: 'My Team', pieces: ['team-flow'], children: [] },
    ]);
    expect(config!.builtinPieceCategories).toEqual([
      {
        name: 'Main',
        pieces: ['default', 'coding'],
        children: [
          { name: 'Child', pieces: ['nested'], children: [] },
        ],
      },
      { name: 'Review', pieces: ['review-only', 'e2e-test'], children: [] },
    ]);
    expect(config!.userPieceCategories).toEqual([
      { name: 'Main', pieces: ['custom'], children: [] },
      { name: 'My Team', pieces: ['team-flow'], children: [] },
    ]);
    expect(config!.showOthersCategory).toBe(false);
    expect(config!.othersCategoryName).toBe('Unclassified');
  });

  it('should load ja builtin categories and include e2e-test under レビュー', () => {
    languageState.value = 'ja';

    writeYaml(join(testDir, 'resources', 'ja', 'piece-categories.yaml'), `
piece_categories:
  レビュー:
    pieces:
      - review-only
      - e2e-test
`);

    const config = getPieceCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'レビュー', pieces: ['review-only', 'e2e-test'], children: [] },
    ]);
  });

  it('should override others settings without replacing categories when user overlay has no piece_categories', () => {
    writeYaml(join(resourcesDir, 'piece-categories.yaml'), `
piece_categories:
  Main:
    pieces:
      - default
  Review:
    pieces:
      - review-only
show_others_category: true
others_category_name: Others
`);

    writeYaml(pathsState.userCategoriesPath, `
show_others_category: false
others_category_name: Unclassified
`);

    const config = getPieceCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
      { name: 'Review', pieces: ['review-only'], children: [] },
    ]);
    expect(config!.builtinPieceCategories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
      { name: 'Review', pieces: ['review-only'], children: [] },
    ]);
    expect(config!.userPieceCategories).toEqual([]);
    expect(config!.showOthersCategory).toBe(false);
    expect(config!.othersCategoryName).toBe('Unclassified');
  });
});

describe('buildCategorizedPieces', () => {
  it('should collect missing pieces with source information', () => {
    const allPieces = createPieceMap([
      { name: 'custom', source: 'user' },
      { name: 'nested', source: 'builtin' },
      { name: 'team-flow', source: 'user' },
    ]);
    const config = {
      pieceCategories: [
        {
          name: 'Main',
          pieces: ['custom'],
          children: [{ name: 'Child', pieces: ['nested'], children: [] }],
        },
        { name: 'My Team', pieces: ['team-flow'], children: [] },
      ],
      builtinPieceCategories: [
        {
          name: 'Main',
          pieces: ['default'],
          children: [{ name: 'Child', pieces: ['nested'], children: [] }],
        },
      ],
      userPieceCategories: [
        { name: 'My Team', pieces: ['missing-user-piece'], children: [] },
      ],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config, process.cwd());
    expect(categorized.categories).toEqual([
      {
        name: 'Main',
        pieces: ['custom'],
        children: [{ name: 'Child', pieces: ['nested'], children: [] }],
      },
      { name: 'My Team', pieces: ['team-flow'], children: [] },
    ]);
    expect(categorized.missingPieces).toEqual([
      { categoryPath: ['Main'], pieceName: 'default', source: 'builtin' },
      { categoryPath: ['My Team'], pieceName: 'missing-user-piece', source: 'user' },
    ]);
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
      builtinPieceCategories: [
        { name: 'Main', pieces: ['default'], children: [] },
      ],
      userPieceCategories: [],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config, process.cwd());
    expect(categorized.categories).toEqual([
      { name: 'Main', pieces: ['default'], children: [] },
      { name: 'Others', pieces: ['extra'], children: [] },
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
      builtinPieceCategories: [
        { name: 'Main', pieces: ['default'], children: [] },
      ],
      userPieceCategories: [],
      showOthersCategory: false,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedPieces(allPieces, config, process.cwd());
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
