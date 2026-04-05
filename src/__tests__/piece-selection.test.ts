/**
 * Tests for piece selection helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PieceDirEntry } from '../infra/config/loaders/pieceLoader.js';
import type { CategorizedPieces } from '../infra/config/loaders/pieceCategories.js';
import type { PieceWithSource } from '../infra/config/loaders/pieceResolver.js';

const selectOptionMock = vi.fn();
const bookmarkState = vi.hoisted(() => ({
  bookmarks: [] as string[],
}));
const uiMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: selectOptionMock,
}));

vi.mock('../shared/ui/index.js', () => uiMock);

vi.mock('../infra/config/global/index.js', () => ({
  getBookmarkedPieces: () => bookmarkState.bookmarks,
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(),
  toggleBookmark: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return actual;
});

const configMock = vi.hoisted(() => ({
  loadAllPiecesWithSources: vi.fn(),
  listPieceEntries: vi.fn(),
  getPieceCategories: vi.fn(),
  buildCategorizedPieces: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => configMock);

const { selectPieceFromEntries, selectPieceFromCategorizedPieces, selectPiece } = await import('../features/pieceSelection/index.js');

describe('selectPieceFromEntries', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
    bookmarkState.bookmarks = [];
  });

  it('should select from custom pieces when source is chosen', async () => {
    const entries: PieceDirEntry[] = [
      { name: 'custom-flow', path: '/tmp/custom.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin.yaml', source: 'builtin' },
    ];

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    const selected = await selectPieceFromEntries(entries);
    expect(selected).toBe('custom-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(2);
  });

  it('should skip source selection when only builtin pieces exist', async () => {
    const entries: PieceDirEntry[] = [
      { name: 'builtin-flow', path: '/tmp/builtin.yaml', source: 'builtin' },
    ];

    selectOptionMock.mockResolvedValueOnce('builtin-flow');

    const selected = await selectPieceFromEntries(entries);
    expect(selected).toBe('builtin-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(1);
  });
});

function createPieceMap(entries: { name: string; source: 'user' | 'builtin' }[]): Map<string, PieceWithSource> {
  const map = new Map<string, PieceWithSource>();
  for (const e of entries) {
    map.set(e.name, {
      source: e.source,
      config: {
        name: e.name,
        movements: [],
        initialMovement: 'start',
        maxMovements: 1,
      },
    });
  }
  return map;
}

describe('selectPieceFromCategorizedPieces', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
    bookmarkState.bookmarks = [];
  });

  it('should show categories at top level', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        { name: 'My Pieces', pieces: ['my-piece'], children: [] },
        { name: 'Quick Start', pieces: ['default'], children: [] },
      ],
      allPieces: createPieceMap([
        { name: 'my-piece', source: 'user' },
        { name: 'default', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:My Pieces')
      .mockResolvedValueOnce('my-piece');

    await selectPieceFromCategorizedPieces(categorized);

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    const labels = firstCallOptions.map((o) => o.label);
    const values = firstCallOptions.map((o) => o.value);

    expect(labels.some((l) => l.includes('My Pieces'))).toBe(true);
    expect(labels.some((l) => l.includes('My Pieces'))).toBe(true);
    expect(labels.some((l) => l.includes('Quick Start'))).toBe(true);
    expect(labels.some((l) => l.includes('(current)'))).toBe(false);
    expect(values).not.toContain('__current__');
  });

  it('should show bookmarked pieces', async () => {
    bookmarkState.bookmarks = ['research'];

    const categorized: CategorizedPieces = {
      categories: [
        { name: 'Quick Start', pieces: ['default'], children: [] },
      ],
      allPieces: createPieceMap([
        { name: 'default', source: 'builtin' },
        { name: 'research', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    selectOptionMock.mockResolvedValueOnce('research');

    const selected = await selectPieceFromCategorizedPieces(categorized);
    expect(selected).toBe('research');

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    const labels = firstCallOptions.map((o) => o.label);

    expect(labels.some((l) => l.includes('research [*]'))).toBe(true);
  });

  it('should navigate into a category and select a piece', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        { name: 'Dev', pieces: ['my-piece'], children: [] },
      ],
      allPieces: createPieceMap([
        { name: 'my-piece', source: 'user' },
      ]),
      missingPieces: [],
    };

    // Select category, then select piece inside it
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('my-piece');

    const selected = await selectPieceFromCategorizedPieces(categorized);
    expect(selected).toBe('my-piece');
  });

  it('should navigate into subcategories recursively', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        {
          name: 'Hybrid',
          pieces: [],
          children: [
            { name: 'Quick Start', pieces: ['hybrid-default'], children: [] },
            { name: 'Full Stack', pieces: ['hybrid-expert'], children: [] },
          ],
        },
      ],
      allPieces: createPieceMap([
        { name: 'hybrid-default', source: 'builtin' },
        { name: 'hybrid-expert', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    // Select Hybrid category → Quick Start subcategory → piece
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Hybrid')
      .mockResolvedValueOnce('__category__:Quick Start')
      .mockResolvedValueOnce('hybrid-default');

    const selected = await selectPieceFromCategorizedPieces(categorized);
    expect(selected).toBe('hybrid-default');
    expect(selectOptionMock).toHaveBeenCalledTimes(3);
  });

  it('should show subcategories and pieces at the same level within a category', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        {
          name: 'Dev',
          pieces: ['base-piece'],
          children: [
            { name: 'Advanced', pieces: ['adv-piece'], children: [] },
          ],
        },
      ],
      allPieces: createPieceMap([
        { name: 'base-piece', source: 'user' },
        { name: 'adv-piece', source: 'user' },
      ]),
      missingPieces: [],
    };

    // Select Dev category, then directly select the root-level piece
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('base-piece');

    const selected = await selectPieceFromCategorizedPieces(categorized);
    expect(selected).toBe('base-piece');

    // Second call should show Advanced subcategory AND base-piece at same level
    const secondCallOptions = selectOptionMock.mock.calls[1]![1] as { label: string; value: string }[];
    const labels = secondCallOptions.map((o) => o.label);

    // Should contain the subcategory folder
    expect(labels.some((l) => l.includes('Advanced'))).toBe(true);
    // Should contain the piece
    expect(labels.some((l) => l.includes('base-piece'))).toBe(true);
    // Should NOT contain the parent category again
    expect(labels.some((l) => l.includes('Dev'))).toBe(false);
  });

  it('should navigate into builtin wrapper category and select a piece', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        { name: 'My Team', pieces: ['custom'], children: [] },
        {
          name: 'builtin',
          pieces: [],
          children: [
            { name: 'Quick Start', pieces: ['default'], children: [] },
          ],
        },
      ],
      allPieces: createPieceMap([
        { name: 'custom', source: 'user' },
        { name: 'default', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    // Select builtin category → Quick Start subcategory → piece
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:builtin')
      .mockResolvedValueOnce('__category__:Quick Start')
      .mockResolvedValueOnce('default');

    const selected = await selectPieceFromCategorizedPieces(categorized);
    expect(selected).toBe('default');
    expect(selectOptionMock).toHaveBeenCalledTimes(3);
  });

  it('should show builtin wrapper as a folder in top-level options', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        { name: 'My Team', pieces: ['custom'], children: [] },
        {
          name: 'builtin',
          pieces: [],
          children: [
            { name: 'Quick Start', pieces: ['default'], children: [] },
          ],
        },
      ],
      allPieces: createPieceMap([
        { name: 'custom', source: 'user' },
        { name: 'default', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    selectOptionMock.mockResolvedValueOnce(null);

    await selectPieceFromCategorizedPieces(categorized);

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    const labels = firstCallOptions.map((o) => o.label);
    expect(labels.some((l) => l.includes('My Team'))).toBe(true);
    expect(labels.some((l) => l.includes('builtin'))).toBe(true);
  });

  it('should sanitize category labels and bookmarked piece labels in categorized selection', async () => {
    bookmarkState.bookmarks = ['bookmarked\npiece'];

    const categorized: CategorizedPieces = {
      categories: [
        { name: 'Unsafe\nCategory', pieces: [], children: [] },
      ],
      allPieces: createPieceMap([
        { name: 'bookmarked\npiece', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    selectOptionMock.mockResolvedValueOnce(null);

    await selectPieceFromCategorizedPieces(categorized);

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    expect(firstCallOptions).toEqual(
      expect.arrayContaining([
        { label: '🎼 bookmarked\\npiece [*]', value: 'bookmarked\npiece' },
        { label: '📁 Unsafe\\nCategory/', value: '__custom_category__:Unsafe\nCategory' },
      ]),
    );
  });

  it('should sanitize category prompt labels when navigating nested categories', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        {
          name: 'Root',
          pieces: [],
          children: [
            {
              name: 'Unsafe\nInner',
              pieces: [],
              children: [
                { name: 'Final\tCategory', pieces: ['safe-piece'], children: [] },
              ],
            },
          ],
        },
      ],
      allPieces: createPieceMap([
        { name: 'safe-piece', source: 'builtin' },
      ]),
      missingPieces: [],
    };

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Root')
      .mockResolvedValueOnce('__category__:Unsafe\nInner')
      .mockResolvedValueOnce('__category__:Final\tCategory')
      .mockResolvedValueOnce('safe-piece');

    const selected = await selectPieceFromCategorizedPieces(categorized);

    expect(selected).toBe('safe-piece');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      3,
      'Select workflow in Unsafe\\nInner:',
      expect.any(Array),
      expect.any(Object),
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      4,
      'Select workflow in Unsafe\\nInner / Final\\tCategory:',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('should show workflow category empty-state message when selected category has no workflows', async () => {
    const categorized: CategorizedPieces = {
      categories: [
        { name: 'Empty', pieces: [], children: [] },
      ],
      allPieces: createPieceMap([]),
      missingPieces: [],
    };

    selectOptionMock.mockResolvedValueOnce('__custom_category__:Empty');

    const result = await selectPieceFromCategorizedPieces(categorized);

    expect(result).toBeNull();
    expect(uiMock.info).toHaveBeenCalledWith('No workflows available for configured categories.');
  });
});

describe('selectPiece', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
    bookmarkState.bookmarks = [];
    configMock.loadAllPiecesWithSources.mockReset();
    configMock.listPieceEntries.mockReset();
    configMock.getPieceCategories.mockReset();
    configMock.buildCategorizedPieces.mockReset();
    uiMock.info.mockReset();
    uiMock.warn.mockReset();
  });

  it('should return default piece when no pieces found and fallbackToDefault is true', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([]);

    const result = await selectPiece('/cwd');

    expect(result).toBe('default');
  });

  it('should return null when no pieces found and fallbackToDefault is false', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([]);

    const result = await selectPiece('/cwd', { fallbackToDefault: false });

    expect(result).toBeNull();
  });

  it('should prompt selection even when only one piece exists', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([
      { name: 'only-piece', path: '/tmp/only-piece.yaml', source: 'user' },
    ]);
    selectOptionMock.mockResolvedValueOnce('only-piece');

    const result = await selectPiece('/cwd');

    expect(result).toBe('only-piece');
    expect(selectOptionMock).toHaveBeenCalled();
  });

  it('should use category-based selection when category config exists', async () => {
    const pieceMap = createPieceMap([{ name: 'my-piece', source: 'user' }]);
    const categorized: CategorizedPieces = {
      categories: [{ name: 'Dev', pieces: ['my-piece'], children: [] }],
      allPieces: pieceMap,
      missingPieces: [],
    };

    configMock.getPieceCategories.mockReturnValue({ categories: ['Dev'] });
    configMock.loadAllPiecesWithSources.mockReturnValue(pieceMap);
    configMock.buildCategorizedPieces.mockReturnValue(categorized);

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('my-piece');

    const result = await selectPiece('/cwd');

    expect(result).toBe('my-piece');
    expect(configMock.buildCategorizedPieces).toHaveBeenCalled();
    expect(configMock.loadAllPiecesWithSources).toHaveBeenCalledWith('/cwd', {
      onWarning: uiMock.warn,
    });
  });

  it('should forward invalid piece warnings to UI in category-based selection path', async () => {
    const pieceMap = createPieceMap([{ name: 'my-piece', source: 'user' }]);
    const categorized: CategorizedPieces = {
      categories: [{ name: 'Dev', pieces: ['my-piece'], children: [] }],
      allPieces: pieceMap,
      missingPieces: [],
    };

    configMock.getPieceCategories.mockReturnValue({ categories: ['Dev'] });
    configMock.loadAllPiecesWithSources.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "broken" failed to load: movements.0.allowed_tools: Invalid input');
        return pieceMap;
      },
    );
    configMock.buildCategorizedPieces.mockReturnValue(categorized);

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('my-piece');

    const result = await selectPiece('/cwd');

    expect(result).toBe('my-piece');
    expect(uiMock.warn).toHaveBeenCalledWith(
      'Workflow "broken" failed to load: movements.0.allowed_tools: Invalid input',
    );
  });

  it('should use directory-based selection when no category config', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
    ]);

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    const result = await selectPiece('/cwd');

    expect(result).toBe('custom-flow');
    expect(configMock.listPieceEntries).toHaveBeenCalledWith('/cwd', {
      onWarning: uiMock.warn,
    });
  });

  it('should exclude invalid pieces from normal selection path and forward warnings to UI', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "broken" failed to load: movements.0: Invalid input');
        return [
          { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
          { name: 'valid-flow', path: '/tmp/valid-flow.yaml', source: 'user' },
        ];
      },
    );

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('valid-flow');

    const result = await selectPiece('/cwd');

    expect(result).toBe('valid-flow');
    expect(uiMock.warn).toHaveBeenCalledWith('Workflow "broken" failed to load: movements.0: Invalid input');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow:',
      [{ label: '🎼 valid-flow', value: 'valid-flow' }],
      expect.any(Object),
    );
  });

  it('should use workflow terminology in directory-based selection prompts', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
    ]);

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    await selectPiece('/cwd');

    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow source:',
      expect.any(Array),
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow:',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('should label workflow sources and categories with workflow terminology', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
    ]);

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    await selectPiece('/cwd');

    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow source:',
      [
        { label: 'Custom workflows (1)', value: 'custom' },
        { label: 'Builtin workflows (1)', value: 'builtin' },
      ],
    );
  });

  it('should preserve repertoire package-qualified names in normal selection path', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([
      { name: '@owner/repo-a/build', path: '/tmp/repo-a.yaml', source: 'repertoire' },
      { name: '@owner/repo-b/build', path: '/tmp/repo-b.yaml', source: 'repertoire' },
    ]);
    selectOptionMock.mockResolvedValueOnce('@owner/repo-a/build');

    const result = await selectPiece('/cwd');

    expect(result).toBe('@owner/repo-a/build');
    expect(selectOptionMock).toHaveBeenCalledWith(
      'Select workflow:',
      [
        { label: '🎼 @owner/repo-a/build', value: '@owner/repo-a/build' },
        { label: '🎼 @owner/repo-b/build', value: '@owner/repo-b/build' },
      ],
      expect.any(Object),
    );
  });

  it('should sanitize terminal control characters in normal selection labels and warnings', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "bad\\nname" failed to load: invalid\\tfield');
        return [
          { name: 'safe\npiece', path: '/tmp/safe-piece.yaml', source: 'user' },
        ];
      },
    );
    selectOptionMock.mockResolvedValueOnce('safe\npiece');

    const result = await selectPiece('/cwd');

    expect(result).toBe('safe\npiece');
    expect(uiMock.warn).toHaveBeenCalledWith('Workflow "bad\\nname" failed to load: invalid\\tfield');
    expect(selectOptionMock).toHaveBeenCalledWith(
      'Select workflow:',
      [{ label: '🎼 safe\\npiece', value: 'safe\npiece' }],
      expect.any(Object),
    );
  });

  it('should show workflow empty-state messages when no workflows are available', async () => {
    configMock.getPieceCategories.mockReturnValue(null);
    configMock.listPieceEntries.mockReturnValue([]);

    const result = await selectPiece('/cwd', { fallbackToDefault: false });

    expect(result).toBeNull();
    expect(uiMock.info).toHaveBeenCalledWith('No workflows found.');
  });

  it('should sanitize missing piece warnings in category-based selection path', async () => {
    const pieceMap = createPieceMap([{ name: 'safe-piece', source: 'user' }]);
    const categorized: CategorizedPieces = {
      categories: [{ name: 'Dev', pieces: ['safe-piece'], children: [] }],
      allPieces: pieceMap,
      missingPieces: [
        {
          categoryPath: ['Unsafe\nCategory', 'Inner\tLevel'],
          pieceName: 'missing\rpiece',
          source: 'user',
        },
      ],
    };

    configMock.getPieceCategories.mockReturnValue({ categories: ['Dev'] });
    configMock.loadAllPiecesWithSources.mockReturnValue(pieceMap);
    configMock.buildCategorizedPieces.mockReturnValue(categorized);
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('safe-piece');

    const result = await selectPiece('/cwd');

    expect(result).toBe('safe-piece');
    expect(uiMock.warn).toHaveBeenCalledWith(
      'Workflow "missing\\rpiece" in category "Unsafe\\nCategory / Inner\\tLevel" not found',
    );
  });
});
