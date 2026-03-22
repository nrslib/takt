/**
 * Tests for isPiecePath and loadPieceByIdentifier
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isPiecePath,
  loadPieceByIdentifier,
  listPieces,
  listPieceEntries,
  loadAllPieces,
  loadAllPiecesWithSources,
} from '../infra/config/loaders/pieceLoader.js';

const SAMPLE_PIECE = `name: test-piece
description: Test piece
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

const INVALID_ALLOWED_TOOLS_PIECE = `name: broken-piece
description: Broken piece
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    allowed_tools: [Read]
    instruction: "{task}"
`;

describe('isPiecePath', () => {
  it('should return true for absolute paths', () => {
    expect(isPiecePath('/path/to/piece.yaml')).toBe(true);
    expect(isPiecePath('/piece')).toBe(true);
  });

  it('should return true for home directory paths', () => {
    expect(isPiecePath('~/piece.yaml')).toBe(true);
    expect(isPiecePath('~/.takt/pieces/custom.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ./', () => {
    expect(isPiecePath('./piece.yaml')).toBe(true);
    expect(isPiecePath('./subdir/piece.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ../', () => {
    expect(isPiecePath('../piece.yaml')).toBe(true);
    expect(isPiecePath('../subdir/piece.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yaml', () => {
    expect(isPiecePath('custom.yaml')).toBe(true);
    expect(isPiecePath('my-piece.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yml', () => {
    expect(isPiecePath('custom.yml')).toBe(true);
    expect(isPiecePath('my-piece.yml')).toBe(true);
  });

  it('should return false for plain piece names', () => {
    expect(isPiecePath('default')).toBe(false);
    expect(isPiecePath('simple')).toBe(false);
    expect(isPiecePath('magi')).toBe(false);
    expect(isPiecePath('my-custom-piece')).toBe(false);
  });
});

describe('loadPieceByIdentifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load piece by name (builtin)', () => {
    const piece = loadPieceByIdentifier('default', process.cwd());
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('default');
  });

  it('should load piece by absolute path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_PIECE);

    const piece = loadPieceByIdentifier(filePath, tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should load piece by relative path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_PIECE);

    const piece = loadPieceByIdentifier('./test.yaml', tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should load piece by filename with .yaml extension', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_PIECE);

    const piece = loadPieceByIdentifier('test.yaml', tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should return null for non-existent name', () => {
    const piece = loadPieceByIdentifier('non-existent-piece-xyz', process.cwd());
    expect(piece).toBeNull();
  });

  it('should return null for non-existent path', () => {
    const piece = loadPieceByIdentifier('./non-existent.yaml', tempDir);
    expect(piece).toBeNull();
  });
});

describe('listPieces with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local pieces when cwd is provided', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'project-custom.yaml'), SAMPLE_PIECE);

    const pieces = listPieces(tempDir);
    expect(pieces).toContain('project-custom');
  });

  it('should include builtin pieces regardless of cwd', () => {
    const pieces = listPieces(tempDir);
    expect(pieces).toContain('default');
  });

  it('should warn and skip invalid project-local pieces', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_PIECE);
    const onWarning = vi.fn();

    const pieces = listPieces(tempDir, { onWarning });

    expect(pieces).not.toContain('broken');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Piece "broken" failed to load'));
  });

});

describe('loadAllPieces with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local pieces when cwd is provided', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'project-custom.yaml'), SAMPLE_PIECE);

    const pieces = loadAllPieces(tempDir);
    expect(pieces.has('project-custom')).toBe(true);
    expect(pieces.get('project-custom')!.name).toBe('test-piece');
  });

  it('should have project-local override builtin when same name', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });

    const overridePiece = `name: project-override
description: Project override
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;
    writeFileSync(join(projectPiecesDir, 'default.yaml'), overridePiece);

    const pieces = loadAllPieces(tempDir);
    expect(pieces.get('default')!.name).toBe('project-override');
  });

});

describe('loadPieceByIdentifier with @scope ref (repertoire)', () => {
  let tempDir: string;
  let configDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('should load piece by @scope ref (repertoire)', () => {
    const piecesDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    writeFileSync(join(piecesDir, 'expert.yaml'), SAMPLE_PIECE);

    const piece = loadPieceByIdentifier('@nrslib/takt-ensemble/expert', tempDir);

    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should return null for non-existent @scope piece', () => {
    const piecesDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    const piece = loadPieceByIdentifier('@nrslib/takt-ensemble/no-such-piece', tempDir);

    expect(piece).toBeNull();
  });
});

describe('loadAllPiecesWithSources with repertoire pieces', () => {
  let tempDir: string;
  let configDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('should include repertoire pieces with @scope qualified names', () => {
    const piecesDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    writeFileSync(join(piecesDir, 'expert.yaml'), SAMPLE_PIECE);

    const pieces = loadAllPiecesWithSources(tempDir);

    expect(pieces.has('@nrslib/takt-ensemble/expert')).toBe(true);
    expect(pieces.get('@nrslib/takt-ensemble/expert')!.source).toBe('repertoire');
  });

  it('should not throw when repertoire dir does not exist', () => {
    const pieces = loadAllPiecesWithSources(tempDir);

    const repertoirePieces = Array.from(pieces.keys()).filter((k) => k.startsWith('@'));
    expect(repertoirePieces).toHaveLength(0);
  });

  it('should warn and skip invalid project-local pieces', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_PIECE);
    const onWarning = vi.fn();

    const pieces = loadAllPiecesWithSources(tempDir, { onWarning });

    expect(pieces.has('broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Piece "broken" failed to load'));
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should warn and skip invalid repertoire pieces', () => {
    const piecesDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    writeFileSync(join(piecesDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_PIECE);
    const onWarning = vi.fn();

    const pieces = loadAllPiecesWithSources(tempDir, { onWarning });

    expect(pieces.has('@nrslib/takt-ensemble/broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Piece "@nrslib/takt-ensemble/broken" failed to load'),
    );
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should forward warnings through loadAllPieces callback', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_PIECE);
    const onWarning = vi.fn();

    const pieces = loadAllPieces(tempDir, { onWarning });

    expect(pieces.has('broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should return validated selection entries for repertoire pieces without collapsing repo names', () => {
    const piecesDirA = join(configDir, 'repertoire', '@nrslib', 'repo-a', 'pieces');
    const piecesDirB = join(configDir, 'repertoire', '@nrslib', 'repo-b', 'pieces');
    mkdirSync(piecesDirA, { recursive: true });
    mkdirSync(piecesDirB, { recursive: true });
    writeFileSync(join(piecesDirA, 'expert.yaml'), SAMPLE_PIECE);
    writeFileSync(join(piecesDirB, 'expert.yaml'), SAMPLE_PIECE);

    const entries = listPieceEntries(tempDir);

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          name: '@nrslib/repo-a/expert',
          path: join(piecesDirA, 'expert.yaml'),
          source: 'repertoire',
        },
        {
          name: '@nrslib/repo-b/expert',
          path: join(piecesDirB, 'expert.yaml'),
          source: 'repertoire',
        },
      ]),
    );
  });

  it('should warn and skip invalid entries from listPieceEntries', () => {
    const piecesDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    writeFileSync(join(piecesDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_PIECE);
    const onWarning = vi.fn();

    const entries = listPieceEntries(tempDir, { onWarning });

    expect(entries.find((entry) => entry.name === '@nrslib/takt-ensemble/broken')).toBeUndefined();
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Piece "@nrslib/takt-ensemble/broken" failed to load'),
    );
  });
});

describe('normalizeArpeggio: strategy coercion via loadPieceByIdentifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-arpeggio-coerce-'));
    mkdirSync(join(tempDir, '.takt'), { recursive: true });
    // Dummy files required by normalizeArpeggio (resolved relative to piece dir)
    writeFileSync(join(tempDir, 'template.md'), '{line:1}');
    writeFileSync(join(tempDir, 'data.csv'), 'col\nval');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should preserve strategy:"custom" when loading arpeggio piece YAML', () => {
    writeFileSync(
      join(tempDir, '.takt', 'config.yaml'),
      ['piece_arpeggio:', '  custom_merge_inline_js: true'].join('\n'),
      'utf-8',
    );

    const pieceYaml = `name: arpeggio-coerce-test
initial_movement: process
max_movements: 5
movements:
  - name: process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data.csv
      template: ./template.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(", ");'
    rules:
      - condition: All processed
        next: COMPLETE
`;
    const piecePath = join(tempDir, 'piece.yaml');
    writeFileSync(piecePath, pieceYaml);

    const config = loadPieceByIdentifier(piecePath, tempDir);

    expect(config).not.toBeNull();
    const movement = config!.movements[0]!;
    expect(movement.arpeggio).toBeDefined();
    expect(movement.arpeggio!.merge.strategy).toBe('custom');
    expect(movement.arpeggio!.merge.inlineJs).toContain('map');
  });

  it('should preserve concat strategy and separator when loading arpeggio piece YAML', () => {
    const pieceYaml = `name: arpeggio-concat-test
initial_movement: process
max_movements: 5
movements:
  - name: process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data.csv
      template: ./template.md
      merge:
        strategy: concat
        separator: "\\n---\\n"
    rules:
      - condition: All processed
        next: COMPLETE
`;
    const piecePath = join(tempDir, 'piece.yaml');
    writeFileSync(piecePath, pieceYaml);

    const config = loadPieceByIdentifier(piecePath, tempDir);

    expect(config).not.toBeNull();
    const movement = config!.movements[0]!;
    expect(movement.arpeggio!.merge.strategy).toBe('concat');
    expect(movement.arpeggio!.merge.separator).toBe('\n---\n');
  });
});
