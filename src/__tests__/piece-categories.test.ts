/**
 * Tests for piece category (subdirectory) support — Issue #85
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listPieces,
  listPieceEntries,
  loadAllPieces,
  loadPiece,
} from '../infra/config/loaders/pieceLoader.js';
import type { PieceDirEntry } from '../infra/config/loaders/pieceLoader.js';
import {
  buildPieceSelectionItems,
  buildTopLevelSelectOptions,
  parseCategorySelection,
  buildCategoryPieceOptions,
  type PieceSelectionItem,
} from '../features/pieceSelection/index.js';

const SAMPLE_PIECE = `name: test-piece
description: Test piece
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

function createPiece(dir: string, name: string, content?: string): void {
  writeFileSync(join(dir, `${name}.yaml`), content ?? SAMPLE_PIECE);
}

describe('piece categories - directory scanning', () => {
  let tempDir: string;
  let piecesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    piecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should discover root-level pieces', () => {
    createPiece(piecesDir, 'simple');
    createPiece(piecesDir, 'advanced');

    const pieces = listPieces(tempDir);
    expect(pieces).toContain('simple');
    expect(pieces).toContain('advanced');
  });

  it('should discover pieces in subdirectories with category prefix', () => {
    const frontendDir = join(piecesDir, 'frontend');
    mkdirSync(frontendDir);
    createPiece(frontendDir, 'react');
    createPiece(frontendDir, 'vue');

    const pieces = listPieces(tempDir);
    expect(pieces).toContain('frontend/react');
    expect(pieces).toContain('frontend/vue');
  });

  it('should discover both root-level and categorized pieces', () => {
    createPiece(piecesDir, 'simple');

    const frontendDir = join(piecesDir, 'frontend');
    mkdirSync(frontendDir);
    createPiece(frontendDir, 'react');

    const backendDir = join(piecesDir, 'backend');
    mkdirSync(backendDir);
    createPiece(backendDir, 'api');

    const pieces = listPieces(tempDir);
    expect(pieces).toContain('simple');
    expect(pieces).toContain('frontend/react');
    expect(pieces).toContain('backend/api');
  });

  it('should not scan deeper than 1 level', () => {
    const deepDir = join(piecesDir, 'category', 'subcategory');
    mkdirSync(deepDir, { recursive: true });
    createPiece(deepDir, 'deep');

    const pieces = listPieces(tempDir);
    // category/subcategory should be treated as a directory entry, not scanned further
    expect(pieces).not.toContain('category/subcategory/deep');
    // Only 1-level: category/deep would not exist since deep.yaml is in subcategory
    expect(pieces).not.toContain('deep');
  });
});

describe('piece categories - listPieceEntries', () => {
  let tempDir: string;
  let piecesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    piecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return entries with category information', () => {
    createPiece(piecesDir, 'simple');

    const frontendDir = join(piecesDir, 'frontend');
    mkdirSync(frontendDir);
    createPiece(frontendDir, 'react');

    const entries = listPieceEntries(tempDir);
    const simpleEntry = entries.find((e) => e.name === 'simple');
    const reactEntry = entries.find((e) => e.name === 'frontend/react');

    expect(simpleEntry).toBeDefined();
    expect(simpleEntry!.category).toBeUndefined();
    expect(simpleEntry!.source).toBe('project');

    expect(reactEntry).toBeDefined();
    expect(reactEntry!.category).toBe('frontend');
    expect(reactEntry!.source).toBe('project');
  });
});

describe('piece categories - loadAllPieces', () => {
  let tempDir: string;
  let piecesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    piecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load categorized pieces with qualified names as keys', () => {
    const frontendDir = join(piecesDir, 'frontend');
    mkdirSync(frontendDir);
    createPiece(frontendDir, 'react');

    const pieces = loadAllPieces(tempDir);
    expect(pieces.has('frontend/react')).toBe(true);
  });
});

describe('piece categories - loadPiece', () => {
  let tempDir: string;
  let piecesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    piecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load piece by category/name identifier', () => {
    const frontendDir = join(piecesDir, 'frontend');
    mkdirSync(frontendDir);
    createPiece(frontendDir, 'react');

    const piece = loadPiece('frontend/react', tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should return null for non-existent category/name', () => {
    const piece = loadPiece('nonexistent/piece', tempDir);
    expect(piece).toBeNull();
  });

  it('should support .yml extension in subdirectories', () => {
    const backendDir = join(piecesDir, 'backend');
    mkdirSync(backendDir);
    writeFileSync(join(backendDir, 'api.yml'), SAMPLE_PIECE);

    const piece = loadPiece('backend/api', tempDir);
    expect(piece).not.toBeNull();
  });
});

describe('buildPieceSelectionItems', () => {
  it('should separate root pieces and categories', () => {
    const entries: PieceDirEntry[] = [
      { name: 'simple', path: '/tmp/simple.yaml', source: 'project' },
      { name: 'frontend/react', path: '/tmp/frontend/react.yaml', category: 'frontend', source: 'project' },
      { name: 'frontend/vue', path: '/tmp/frontend/vue.yaml', category: 'frontend', source: 'project' },
      { name: 'backend/api', path: '/tmp/backend/api.yaml', category: 'backend', source: 'project' },
    ];

    const items = buildPieceSelectionItems(entries);

    const pieces = items.filter((i) => i.type === 'piece');
    const categories = items.filter((i) => i.type === 'category');

    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.name).toBe('simple');

    expect(categories).toHaveLength(2);
    const frontend = categories.find((c) => c.name === 'frontend');
    expect(frontend).toBeDefined();
    expect(frontend!.type === 'category' && frontend!.pieces).toEqual(['frontend/react', 'frontend/vue']);

    const backend = categories.find((c) => c.name === 'backend');
    expect(backend).toBeDefined();
    expect(backend!.type === 'category' && backend!.pieces).toEqual(['backend/api']);
  });

  it('should sort items alphabetically', () => {
    const entries: PieceDirEntry[] = [
      { name: 'zebra', path: '/tmp/zebra.yaml', source: 'project' },
      { name: 'alpha', path: '/tmp/alpha.yaml', source: 'project' },
      { name: 'misc/playground', path: '/tmp/misc/playground.yaml', category: 'misc', source: 'project' },
    ];

    const items = buildPieceSelectionItems(entries);
    const names = items.map((i) => i.name);
    expect(names).toEqual(['alpha', 'misc', 'zebra']);
  });

  it('should return empty array for empty input', () => {
    const items = buildPieceSelectionItems([]);
    expect(items).toEqual([]);
  });
});

describe('2-stage category selection helpers', () => {
  const items: PieceSelectionItem[] = [
    { type: 'piece', name: 'simple' },
    { type: 'category', name: 'frontend', pieces: ['frontend/react', 'frontend/vue'] },
    { type: 'category', name: 'backend', pieces: ['backend/api'] },
  ];

  describe('buildTopLevelSelectOptions', () => {
    it('should encode categories with prefix in value', () => {
      const options = buildTopLevelSelectOptions(items, '');
      const categoryOption = options.find((o) => o.label.includes('frontend'));
      expect(categoryOption).toBeDefined();
      expect(categoryOption!.value).toBe('__category__:frontend');
    });

    it('should mark current piece', () => {
      const options = buildTopLevelSelectOptions(items, 'simple');
      const simpleOption = options.find((o) => o.value === 'simple');
      expect(simpleOption!.label).toContain('(current)');
    });

    it('should mark category containing current piece', () => {
      const options = buildTopLevelSelectOptions(items, 'frontend/react');
      const frontendOption = options.find((o) => o.value === '__category__:frontend');
      expect(frontendOption!.label).toContain('(current)');
    });
  });

  describe('parseCategorySelection', () => {
    it('should return category name for category selection', () => {
      expect(parseCategorySelection('__category__:frontend')).toBe('frontend');
    });

    it('should return null for direct piece selection', () => {
      expect(parseCategorySelection('simple')).toBeNull();
    });
  });

  describe('buildCategoryPieceOptions', () => {
    it('should return options for pieces in a category', () => {
      const options = buildCategoryPieceOptions(items, 'frontend', '');
      expect(options).not.toBeNull();
      expect(options).toHaveLength(2);
      expect(options![0]!.value).toBe('frontend/react');
      expect(options![0]!.label).toBe('react');
    });

    it('should mark current piece in category', () => {
      const options = buildCategoryPieceOptions(items, 'frontend', 'frontend/vue');
      const vueOption = options!.find((o) => o.value === 'frontend/vue');
      expect(vueOption!.label).toContain('(current)');
    });

    it('should return null for non-existent category', () => {
      expect(buildCategoryPieceOptions(items, 'nonexistent', '')).toBeNull();
    });
  });
});
